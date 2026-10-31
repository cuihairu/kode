import * as vscode from 'vscode';
import { findEventCalls } from './eventApi';
import type { EventCall, EventCallIndex, IndexedEventCall } from './eventIndexTypes';
import { findFilesAcrossRoots, getExternalScanRoots } from './scanRoots';
import { PY_SCAN_EXCLUDE } from './pythonScanRules';

// 本地索引缓存（用户令 2026-10-20：跳转/CodeLens 不得每次全仓重扫）。
// 一次性建索引 + watcher 增量失效；实例由 provider 持有（测试各自全新实例，互不污染）。
// 范围（第一片）：.py 的 def/class/事件调用；后续片再并入 .def 常量与类型面。
// IDE-ARC-002:事件消费面只以小接口 EventCallIndex 暴露(类型住 eventIndexTypes)。

interface IndexedFile {
  version: number;
  methods: Array<{ name: string; line: number }>;
  eventCalls: EventCall[];
  eventLines: number[];
}

const INITIAL_SCAN_CONCURRENCY = 8;

/** EVT-012 冷路径(2026-10-28 审核整改):首扫逐文件解析按趟让出宿主,
 * 冷扫不再以整批同步块占住交互线程(setImmediate 宏任务边界)。 */
// 让出节拍观测(测试面):实际让出宿主的次数;prove-red 用——时间片让出
// (EVT-012 修订)下小批文件让出应是个位数,逐文件让出的旧码是 2×文件数。
let yieldToHostCount = 0;
export function getWorkspaceIndexYieldCountForTests(): number {
  return yieldToHostCount;
}
export function resetWorkspaceIndexYieldClockForTests(): void {
  yieldToHostCount = 0;
}

const yieldToHost = (): Promise<void> => {
  yieldToHostCount += 1;
  return new Promise(resolve => { setImmediate(resolve); });
};

// EVT-012 修订(2026-10-28 现场联合重验):逐文件双让出在 5000 文件冷扫中
// 产生上万次宏任务跳转,把共享事件循环上的 python 首扫/文件发现拖长一个
// 数量级(冷首查 1189ms→2526ms 且预算内 0 目标)。改为按耗时切片:距上次
// 让出不足 YIELD_SLICE_MS 不让;让出后照旧重验 disposed/revision。宿主单次
// 连续同步段上界=切片+单文件解析,仍受 timerDelay 契约约束,不再逐文件付费。
const YIELD_SLICE_MS = 25;
// 测试面切片注入口(2026-10-28 CI 现场修复):心跳断言依赖「扫描必超一片」,
// 快速 runner 上整趟不足 25ms 即零让出,断言成机器相对 flake;置 0 使每次
// 批边界必让出,让出→定时器心跳的机制验证变为确定性(生产口径不变)。
let yieldSliceMsOverride: number | null = null;
export function setWorkspaceIndexYieldSliceMsForTests(ms: number | null): void {
  yieldSliceMsOverride = ms;
}
let lastYieldAt = 0;
const yieldToHostIfDue = async (): Promise<void> => {
  if (Date.now() - lastYieldAt < (yieldSliceMsOverride ?? YIELD_SLICE_MS)) { return; }
  // 同步先落时间戳再挂起:并发 worker 在首个 setImmediate 解析前都会过
  // 切片检查,迟落会把整批 worker 同时放进让出(实测 8 并发=8 连让)。
  lastYieldAt = Date.now();
  await yieldToHost();
};

export class WorkspaceIndex implements EventCallIndex {
  private readonly cache = new Map<string, IndexedFile>();
  private readonly building = new Map<string, Promise<IndexedFile | null>>();
  private watchers: vscode.Disposable[] = [];
  private externalWatchers: vscode.Disposable[] = [];
  private started = false;
  private starting?: Promise<void>;
  private disposed = false;
  private documentListener?: vscode.Disposable;
  private closeListener?: vscode.Disposable;
  private renameListener?: vscode.Disposable;
  private readonly revisions = new Map<string, number>();

  constructor(private readonly pyGlob = '**/*.py') {}

  /** 首次使用时建全量索引并挂 watcher（幂等）。 */
  async ensureStarted(): Promise<void> {
    if (this.started || this.disposed) return;
    const starting = this.starting ??= this.startIndex();
    try {
      await starting;
    } catch (error) {
      if (this.starting === starting) this.starting = undefined;
      throw error;
    }
  }

  private async startIndex(): Promise<void> {
    this.documentListener ??= vscode.workspace.onDidChangeTextDocument(event => {
      this.noteSaved(event.document);
    });
    // AUD-033(R2-F09):放弃脏文档并关闭后,事件索引自愈回磁盘结果——
    // 版本作废在途旧脏任务(不复活),强制重读盘(不依赖碰巧收到磁盘
    // watcher 才自愈)。@types/vscode 1.82 未声明 onDidRevertTextDocument
    // (1.84+ 运行时才有),故按验收口径只接关闭面。
    this.closeListener ??= vscode.workspace.onDidCloseTextDocument(document => {
      this.noteDocumentAbandoned(document);
    });
    this.renameListener ??= vscode.workspace.onDidRenameFiles(event => {
      for (const { oldUri, newUri } of event.files) {
        const oldPath = oldUri.fsPath;
        const newPath = newUri.fsPath;
        const entry = this.cache.get(oldPath);
        this.revisions.set(oldPath, (this.revisions.get(oldPath) ?? 0) + 1);
        this.revisions.set(newPath, (this.revisions.get(newPath) ?? 0) + 1);
        this.cache.delete(oldPath);
        this.cache.delete(newPath);
        if (newPath.endsWith('.py')) {
          if (entry) this.cache.set(newPath, entry);
          else void this.indexFile(newUri);
        }
      }
    });
    for (const document of vscode.workspace.textDocuments) {
      if (document.isDirty) this.noteSaved(document);
    }
    const initialRevisions = new Map(this.revisions);
    const files = await findFilesAcrossRoots(this.pyGlob, PY_SCAN_EXCLUDE);
    if (this.disposed) return;
    let nextFile = 0;
    const scanWorker = async (): Promise<void> => {
      while (!this.disposed && nextFile < files.length) {
        const uri = files[nextFile++];
        if ((this.revisions.get(uri.fsPath) ?? 0) !== (initialRevisions.get(uri.fsPath) ?? 0)) continue;
        await this.indexFile(uri);
      }
    };
    await Promise.all(Array.from({ length: Math.min(INITIAL_SCAN_CONCURRENCY, files.length) }, scanWorker));
    if (this.disposed) return;
    const watcher = vscode.workspace.createFileSystemWatcher(this.pyGlob);
    watcher.onDidCreate(uri => { void this.indexFile(uri); });
    watcher.onDidChange(uri => { void this.indexFile(uri); });
    watcher.onDidDelete(uri => {
      this.revisions.set(uri.fsPath, (this.revisions.get(uri.fsPath) ?? 0) + 1);
      this.cache.delete(uri.fsPath);
    });
    this.watchers.push(watcher);
    // IDE-AUD-035(R2-F11):事件初扫支持外部根,但 watcher 只挂 workspace 字符串
    // glob——外部 assetsRoot 增删改不触发维护。外部根改挂 RelativePattern 整组
    // (切根可重建),与实体面 refreshExternalRootWatchers 同口径。
    this.refreshExternalWatchers();
    this.started = true;
  }

  /**
   * IDE-AUD-035:外部资产根 watcher 整组重建——旧根 watcher 全部释放,新根按
   * 当前 getExternalScanRoots() 重挂,新根的增删改重新可触发维护;startIndex
   * 首次接线,assetsRoot 配置切换时由扩展层调。
   */
  refreshExternalWatchers(): void {
    for (const watcher of this.externalWatchers) {
      watcher.dispose();
    }
    this.externalWatchers = [];
    for (const root of getExternalScanRoots()) {
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(root, this.pyGlob)
      );
      watcher.onDidCreate(uri => { void this.indexFile(uri); });
      watcher.onDidChange(uri => { void this.indexFile(uri); });
      watcher.onDidDelete(uri => {
        this.revisions.set(uri.fsPath, (this.revisions.get(uri.fsPath) ?? 0) + 1);
        this.cache.delete(uri.fsPath);
      });
      this.externalWatchers.push(watcher);
    }
  }

  /**
   * AUD-033(R2-F09):放弃脏文档并关闭后的自愈面。版本作废在途旧脏任务
   * (其版本守卫不匹配即弃,不复活为脏结果),随后强制重读盘重建缓存——
   * 不依赖碰巧收到磁盘 watcher 才自愈。关闭后磁盘是真相源,统一按盘重读
   * (干净文档关闭的重读幂等,顺带回收外部磁盘变更漏发)。
   */
  private noteDocumentAbandoned(document: vscode.TextDocument): void {
    if (this.disposed) return;
    const filePath = document.uri.fsPath;
    if (!filePath.endsWith('.py')) return;
    this.revisions.set(filePath, (this.revisions.get(filePath) ?? 0) + 1);
    // 清除在途条目:强制新建一条磁盘读(旧在途任务版本不匹配会自然弃写)
    this.building.delete(filePath);
    void this.indexFile(document.uri, true);
  }

  dispose(): void {
    this.disposed = true;
    this.documentListener?.dispose();
    this.documentListener = undefined;
    this.closeListener?.dispose();
    this.closeListener = undefined;
    this.renameListener?.dispose();
    this.renameListener = undefined;
    for (const w of this.watchers) w.dispose();
    this.watchers = [];
    for (const w of this.externalWatchers) w.dispose();
    this.externalWatchers = [];
    this.cache.clear();
    this.revisions.clear();
  }

  /**
   * IDE-AUD-036(R2-F11):统一根移除通知覆盖共享事件索引——摘除该根全部缓存
   * 条目并让该根在途任务按版本作废(读盘落定后 revision 不匹配即弃,不回写
   * 已删缓存),其他根条目原样保留。移除 B 不清 A,旧 B 回包不再注册。
   */
  removeRoot(rootPath: string): void {
    if (this.disposed || !rootPath) { return; }
    // 前缀判定带分隔符:/ws 不误伤 /wsX;两种分隔符都认(键可能是任意拼写)
    const underRoot = (filePath: string): boolean =>
      filePath === rootPath ||
      filePath.startsWith(rootPath + '/') ||
      filePath.startsWith(rootPath + '\\');
    const affected = new Set<string>();
    for (const key of this.cache.keys()) { if (underRoot(key)) { affected.add(key); } }
    for (const key of this.building.keys()) { if (underRoot(key)) { affected.add(key); } }
    for (const key of affected) {
      this.revisions.set(key, (this.revisions.get(key) ?? 0) + 1);
      this.cache.delete(key);
    }
  }

  /**
   * 单文件建/重建索引；并发去重（同一文件不重复读）。
   * preferDisk(AUD-033):放弃脏文档自愈路径强制读盘——跳过脏文档覆盖,
   * 保证关闭后缓存回到磁盘结果而非仍在途的脏文本。
   */
  private indexFile(uri: vscode.Uri, preferDisk = false): Promise<IndexedFile | null> {
    if (this.disposed) return Promise.resolve(null);
    const inflight = this.building.get(uri.fsPath);
    if (inflight) return inflight;
    const revision = this.revisions.get(uri.fsPath) ?? 0;
    const task = (async () => {
      try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        if (this.disposed) return null;
        if ((this.revisions.get(uri.fsPath) ?? 0) !== revision) return this.cache.get(uri.fsPath) ?? null;
        const dirty = preferDisk
          ? undefined
          : vscode.workspace.textDocuments.find(document => document.uri.fsPath === uri.fsPath && document.isDirty);
        if (dirty) {
          this.noteSaved(dirty);
          return this.cache.get(uri.fsPath) ?? null;
        }
        const text = Buffer.from(bytes).toString('utf8');
        // 让出边界后重验:让出窗口内的保存/销毁按既有口径处置(弃旧解析,
        // 不覆盖新数据),窗口本身不引入行为差。让出按时间切片节流。
        await yieldToHostIfDue();
        if (this.disposed || (this.revisions.get(uri.fsPath) ?? 0) !== revision) {
          return this.cache.get(uri.fsPath) ?? null;
        }
        const lineStarts = [0];
        for (let i = 0; i < text.length; i += 1) {
          if (text[i] === '\n') lineStarts.push(i + 1);
        }
        const lineAt = (offset: number): number => {
          let low = 0;
          let high = lineStarts.length;
          while (low + 1 < high) {
            const mid = Math.floor((low + high) / 2);
            if (lineStarts[mid] <= offset) low = mid;
            else high = mid;
          }
          return low;
        };
        const methods = [...text.matchAll(/^[ \t]*(?:async[ \t]+)?def[ \t]+(\w+)[ \t]*\(/gm)].map(m => ({
          name: m[1],
          line: lineAt(m.index || 0),
        }));
        await yieldToHostIfDue();
        if (this.disposed || (this.revisions.get(uri.fsPath) ?? 0) !== revision) {
          return this.cache.get(uri.fsPath) ?? null;
        }
        const eventCalls = findEventCalls(text);
        // 二次守卫无触发输入——与上一守卫(185)同处一个同步段:两查之间只有
        // 同步的 findEventCalls(纯正则扫描,无让出点),状态不可能在两查之间
        // 变化;上一守卫已放行,此查同样放行。
        if (this.disposed || (this.revisions.get(uri.fsPath) ?? 0) !== revision) {
          /* istanbul ignore start */
          return this.cache.get(uri.fsPath) ?? null;
          /* istanbul ignore stop */
        }
        const indexed: IndexedFile = { version: 0, methods, eventCalls, eventLines: eventCalls.map(c => lineAt(c.eventOffset)) };
        this.cache.set(uri.fsPath, indexed);
        return indexed;
      } catch {
        if ((this.revisions.get(uri.fsPath) ?? 0) === revision) this.cache.delete(uri.fsPath);
        return null;
      } finally {
        this.building.delete(uri.fsPath);
      }
    })();
    this.building.set(uri.fsPath, task);
    return task;
  }

  /** 保存时由编辑器路径直接刷新（免读盘）。 */
  noteSaved(document: vscode.TextDocument): void {
    if (this.disposed) return;
    if (!document.uri.fsPath.endsWith('.py')) return;
    this.revisions.set(document.uri.fsPath, (this.revisions.get(document.uri.fsPath) ?? 0) + 1);
    const text = document.getText();
    const calls = findEventCalls(text);
    this.cache.set(document.uri.fsPath, {
      version: document.version,
      methods: [...text.matchAll(/^[ \t]*(?:async[ \t]+)?def[ \t]+(\w+)[ \t]*\(/gm)].map(m => ({
        name: m[1],
        line: document.positionAt(m.index || 0).line,
      })),
      eventCalls: calls,
      eventLines: calls.map(c => document.positionAt(c.eventOffset).line),
    });
  }

  /** 全仓事件调用（走缓存，不再每次读盘）。 */
  async allEventCalls(): Promise<IndexedEventCall[]> {
    await this.ensureStarted();
    const out: IndexedEventCall[] = [];
    for (const [file, indexed] of this.cache) {
      indexed.eventCalls.forEach((call, i) => out.push({ file, call, line: indexed.eventLines[i] ?? 0 }));
    }
    return out;
  }

  /** 某文件的方法行（当前编辑文件走内存文本，外部文件走缓存）。 */
  async methodsOf(document: vscode.TextDocument): Promise<Array<{ name: string; line: number }>> {
    const text = document.getText();
    return [...text.matchAll(/^[ \t]*(?:async[ \t]+)?def[ \t]+(\w+)[ \t]*\(/gm)].map(m => ({
      name: m[1],
      line: document.positionAt(m.index || 0).line,
    }));
  }
}
