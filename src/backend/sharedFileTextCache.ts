// 读一次、扇出多次:跨索引面共享的文件原文缓存(2026-11-24 用户令「五个读取
// 面为什么不共用一个文件缓存」)。RST 泳道收编前的过渡层:把「stat 校验 + 命中
// 免读 + 单飞去重 + 有界淘汰」收成一个共享层,fileReadMetrics 两个记账入口与
// 直读点(workspaceIndex/pythonClassIndex)统一走此层——同一文件在一个宿主生命
// 周期内只真读一次,五个索引面共享同一份原文。
//
// 正确性语义:
// - 每次读路径先 stat,mtimeMs+size 双键一致才吃缓存(「变了就重读」的用户
//   语义;与各面既有 mtime 缓存同风险等级,size 键挡住同 mtime 改写窗口);
// - **stat 不可得(文件不存在/无权限/虚拟文件系统不支持)→ 纯透传**:不走
//   缓存、不入账、读错误原样抛——与接入前「直接读」行为逐字节同,缓存只在
//   能校验新鲜度的文件上生效(绝不服务无法验证的陈旧文本);
// - 读失败(指纹可得时):清条目并**原样抛出**(不缓存失败——Windows 文件锁
//   抖动不毒化缓存,调用方既有 catch 语义不变);
// - 命中 = 未读盘,不入 fileReadMetrics 审计(审计口径反而更真);
// - 预算:LRU,超预算丢最旧;单条超预算透传不入缓存(永不无界);
// - loader 注入:各面保留自己的读缝(workspaceIndex 走 vscode.workspace.fs,
//   pythonClassIndex/fileReadMetrics 走 node fs)——缓存只共享「存什么」,
//   不收编「怎么读」,既有测试桩缝与远端/虚拟工作区读路径都不被改道;
// - 新鲜度校验(stat)默认走 vscode.workspace.fs.stat:本地与远端/虚拟工作区
//   同一口径,且与桩缝环境同一事件循环尺度(不向纯桩测试注入真盘 I/O 宏任务)。

import * as fs from 'fs';
import { Uri, workspace } from 'vscode';

export interface SharedFileTextEntry {
  readonly text: string;
  readonly mtimeMs: number;
  readonly size: number;
  readonly bytes: number;
}

/** 读透结果:fromCache=true 表示本次调用未产生新盘读(命中/并入在途单飞) */
export interface SharedFileTextRead {
  readonly text: string;
  readonly bytes: number;
  readonly fromCache: boolean;
}

export interface SharedFileTextStats {
  hits: number;
  misses: number;
  failures: number;
  evictions: number;
  entries: number;
  bytes: number;
}

/** 策略常数(无用户配置面——与 kode-server 预算常数同一口径) */
export const SHARED_FILE_TEXT_BUDGET_BYTES = 64 * 1024 * 1024;

export interface SharedFileTextCacheDeps {
  statAsync(path: string): Promise<{ mtimeMs: number; size: number }>;
  readAsync(path: string): Promise<string>;
  statSync(path: string): { mtimeMs: number; size: number };
  readSync(path: string): string;
}

/** 未中缓存时的读缝;各面注入自己的原读函数(桩缝/远端 fs 不被改道)。
 * PromiseLike 收编 vscode.workspace.fs 的 Thenable 返回面。 */
export type SharedFileTextAsyncLoader = (path: string) => PromiseLike<string>;
export type SharedFileTextSyncLoader = (path: string) => string;

export const sharedFileTextCacheDefaultDeps: SharedFileTextCacheDeps = {
  // stat 走 vscode.workspace.fs(本地/远端同口径;失败=透传,见 readInner*)。
  // mtime 为 vscode API 的毫秒时间戳;桩环境无 mtime 时 undefined 键一致可比。
  statAsync: async path => {
    const stat = await workspace.fs.stat(Uri.file(path));
    return { mtimeMs: stat.mtime, size: stat.size };
  },
  readAsync: path => fs.promises.readFile(path, 'utf8'),
  statSync: path => {
    const stat = fs.statSync(path);
    return { mtimeMs: stat.mtimeMs, size: stat.size };
  },
  readSync: path => fs.readFileSync(path, 'utf8')
};

export class SharedFileTextCache {
  private readonly store = new Map<string, SharedFileTextEntry>();
  private readonly inflight = new Map<string, Promise<SharedFileTextRead>>();
  private hits = 0;
  private misses = 0;
  private failures = 0;
  private evictions = 0;

  constructor(
    private readonly budgetBytes: number = SHARED_FILE_TEXT_BUDGET_BYTES,
    private readonly deps: SharedFileTextCacheDeps = sharedFileTextCacheDefaultDeps
  ) {}

  /**
   * 读透(异步):stat 校验 → 命中免读;未命中经 loader 真读入缓存(loader
   * 缺省走 node fs)。stat 不可得 → 纯透传(不缓存不入账)。同路径并发调用
   * 并入在途单飞——并入方 fromCache=true(未产生新盘读,审计面只记真正落盘
   * 的那一次)。opts.fresh=true 不并入也不登记在途单飞:弃置重建等要求「这次
   * 必须真读」的路径用(在途旧读期间盘上内容可能已变,并入会服务旧读结果)。
   */
  async readThroughAsync(
    path: string,
    loader?: SharedFileTextAsyncLoader,
    opts?: { fresh?: boolean }
  ): Promise<SharedFileTextRead> {
    if (!opts?.fresh) {
      const pending = this.inflight.get(path);
      if (pending) {
        const shared = await pending;
        return { ...shared, fromCache: true };
      }
    }
    const task = this.readInnerAsync(path, loader);
    if (!opts?.fresh) {
      this.inflight.set(path, task);
      try {
        return await task;
      } finally {
        this.inflight.delete(path);
      }
    }
    return task;
  }

  private async readInnerAsync(
    path: string,
    loader?: SharedFileTextAsyncLoader
  ): Promise<SharedFileTextRead> {
    let fingerprint: { mtimeMs: number; size: number };
    try {
      fingerprint = await this.deps.statAsync(path);
    } catch {
      // stat 不可得(不存在/锁抖动/虚拟 fs 不支持 stat):纯透传,与接入前
      // 「直接读」同行为;读成功也不入缓存(下次仍无法校验新鲜度)。
      const text = await (loader ?? this.deps.readAsync)(path);
      return { text, bytes: Buffer.byteLength(text, 'utf8'), fromCache: false };
    }
    const cached = this.store.get(path);
    if (cached && cached.mtimeMs === fingerprint.mtimeMs && cached.size === fingerprint.size) {
      // Map 插入序即 LRU 新鲜度:命中重插刷新
      this.store.delete(path);
      this.store.set(path, cached);
      this.hits += 1;
      return { text: cached.text, bytes: cached.bytes, fromCache: true };
    }
    this.misses += 1;
    let text: string;
    try {
      text = await (loader ?? this.deps.readAsync)(path);
    } catch (error) {
      this.store.delete(path);
      this.failures += 1;
      throw error;
    }
    const bytes = Buffer.byteLength(text, 'utf8');
    const entry: SharedFileTextEntry = { text, mtimeMs: fingerprint.mtimeMs, size: fingerprint.size, bytes };
    this.insert(path, entry);
    return { text, bytes, fromCache: false };
  }

  /**
   * 读透(同步):同语义同步版。同步调用天然串行,无单飞面;供 fileReadMetrics
   * 记账入口与同步读链(definitionWorkspace/entityMapping 同步腿)使用。
   */
  readThroughSync(path: string, loader?: SharedFileTextSyncLoader): SharedFileTextRead {
    let fingerprint: { mtimeMs: number; size: number };
    try {
      fingerprint = this.deps.statSync(path);
    } catch {
      // stat 不可得:纯透传(不入缓存),读错误原样抛
      const text = (loader ?? this.deps.readSync)(path);
      return { text, bytes: Buffer.byteLength(text, 'utf8'), fromCache: false };
    }
    const cached = this.store.get(path);
    if (cached && cached.mtimeMs === fingerprint.mtimeMs && cached.size === fingerprint.size) {
      this.store.delete(path);
      this.store.set(path, cached);
      this.hits += 1;
      return { text: cached.text, bytes: cached.bytes, fromCache: true };
    }
    this.misses += 1;
    let text: string;
    try {
      text = (loader ?? this.deps.readSync)(path);
    } catch (error) {
      this.store.delete(path);
      this.failures += 1;
      throw error;
    }
    const bytes = Buffer.byteLength(text, 'utf8');
    const entry: SharedFileTextEntry = { text, mtimeMs: fingerprint.mtimeMs, size: fingerprint.size, bytes };
    this.insert(path, entry);
    return { text, bytes, fromCache: false };
  }

  /** 单文件失效(watcher/删除链显式调用;批 1 各面 stat-on-load 已兜底,预挂接口) */
  invalidate(path: string): void {
    this.store.delete(path);
  }

  clear(): void {
    this.store.clear();
  }

  snapshotStats(): SharedFileTextStats {
    let bytes = 0;
    for (const entry of this.store.values()) {
      bytes += entry.bytes;
    }
    return {
      hits: this.hits,
      misses: this.misses,
      failures: this.failures,
      evictions: this.evictions,
      entries: this.store.size,
      bytes
    };
  }

  private insert(path: string, entry: SharedFileTextEntry): void {
    if (entry.bytes > this.budgetBytes) {
      // 单条超预算:透传服务,不入缓存(缓存永不无界)
      return;
    }
    this.store.delete(path);
    this.store.set(path, entry);
    while (this.totalBytes() > this.budgetBytes) {
      const oldest = this.store.keys().next();
      if (oldest.done) {
        break;
      }
      this.store.delete(oldest.value);
      this.evictions += 1;
    }
  }

  private totalBytes(): number {
    let total = 0;
    for (const entry of this.store.values()) {
      total += entry.bytes;
    }
    return total;
  }
}

let singleton: SharedFileTextCache | null = null;

/** 宿主级单例:五个索引面共享同一份原文缓存 */
export function getSharedFileTextCache(): SharedFileTextCache {
  if (singleton === null) {
    singleton = new SharedFileTextCache();
  }
  return singleton;
}

/** 测试与单次操作审计:换新实例(既有条目/计数全弃) */
export function resetSharedFileTextCacheForTests(): void {
  singleton = new SharedFileTextCache();
}
