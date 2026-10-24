import { KodeCoreClient, KodeCoreTransportError } from './kodeCoreClient';

// kode2 PR-012:双轨切流门(kill-switch / shadow / 差异日志)。
// 书 §16.3/PH7-02 与 docs/kode2/ph0-gate.md 门 3:双轨 parity 与回退措施
// 成熟前不删旧 TS 实现,Rust 结果不得直接服务用户。本模块只做三件事:
//   1. 解析 kbengine.core.backend 开关(ts|rust|shadow,默认 ts;非法值
//      一律回落 ts —— kill-switch 永远收得回来);
//   2. rust 字面量在本 PR 只保留占位:serving 门禁拒绝(切流前置条件未
//      全绿),生效轨道仍是 ts,并留下一次 notice 存照;
//   3. shadow 模式下 compare() 把同参请求镜像给 Rust server 做短超时
//      对比,任何 Rust 侧失败只记差异日志,compare 恒返回 TS 结果
//      原样 —— 用户可见行为与 ts 模式逐字节一致(铁律:不切流)。

export type KodeBackendMode = 'ts' | 'rust' | 'shadow';

/** shadow 对比结论:match/diff 之外的三种失败都归属 rust 侧,不改服务 */
export type ShadowVerdict = 'match' | 'diff' | 'rust-error' | 'rust-timeout' | 'rust-unavailable';

/** 差异日志单条:seq 单调递增,verdict 汇总口径见 ShadowVerdict */
export interface ShadowDiffEntry {
  seq: number;
  timestamp: string;
  method: string;
  uri?: string;
  verdict: ShadowVerdict;
  /** diff 时为首个分歧路径与双方截断值;失败时为错误摘要 */
  detail?: string;
}

export interface KodeCoreGateConfig {
  /** kbengine.core.backend 原始字符串(可能非法) */
  backend: string;
  /** kode-server 二进制路径;空 = rust 不可用 */
  serverPath: string;
  /** shadow 镜像请求超时毫秒(默认 2000) */
  shadowTimeoutMs: number;
}

export const DEFAULT_CORE_GATE_CONFIG: KodeCoreGateConfig = {
  backend: 'ts',
  serverPath: '',
  shadowTimeoutMs: 2000,
};

/** spawn 失败后的重试冷却(毫秒):防 provider 高频查询把失败刷成风暴 */
const SPAWN_COOLDOWN_MS = 30_000;

/**
 * kill-switch 解析:仅 'shadow' 与 'rust' 两个字面量改变模式,其余(含
 * undefined/空串/拼错)一律回落 'ts' —— 开关异常时安全侧是 TS 真相。
 * 'rust' 额外置 rustServingGated=true:切流前置条件未全绿前,serving
 * 门禁拒绝该字面量(ph0-gate 门 3 设计稿键值,生效语义见本文件头注)。
 */
export function resolveBackendMode(rawBackend: string | undefined): {
  mode: KodeBackendMode;
  rustServingGated: boolean;
} {
  if (rawBackend === 'shadow') {
    return { mode: 'shadow', rustServingGated: false };
  }
  if (rawBackend === 'rust') {
    return { mode: 'rust', rustServingGated: true };
  }
  return { mode: 'ts', rustServingGated: false };
}

/** 规范化:对象按键名排序后比较(数组保序),屏蔽序列化键序差异 */
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0
    );
    const out: Record<string, unknown> = {};
    for (const [key, item] of entries) {
      out[key] = canonicalize(item);
    }
    return out;
  }
  return value;
}

function truncate(text: string, max = 80): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function preview(value: unknown): string {
  try {
    return truncate(JSON.stringify(value) ?? String(value));
  } catch {
    return truncate(String(value));
  }
}

/** 首个分歧路径('$' 为根;对象取键,数组取下标);一致返回 null */
export function firstDiffPath(tsValue: unknown, rustValue: unknown, path = '$'): string | null {
  const canonicalTs = canonicalize(tsValue);
  const canonicalRust = canonicalize(rustValue);
  if (canonicalTs === canonicalRust) {
    return null;
  }
  const walk = (a: unknown, b: unknown, p: string): string | null => {
    if (a === b) {
      return null;
    }
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) {
        return `${p}.length(${a.length}≠${b.length})`;
      }
      for (let i = 0; i < a.length; i += 1) {
        const found = walk(a[i], b[i], `${p}[${i}]`);
        if (found) {
          return found;
        }
      }
      return null;
    }
    if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
      const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
      for (const key of keys) {
        const found = walk(
          (a as Record<string, unknown>)[key],
          (b as Record<string, unknown>)[key],
          `${p}.${key}`
        );
        if (found) {
          return found;
        }
      }
      return null;
    }
    return p;
  };
  return walk(canonicalTs, canonicalRust, path);
}

/** 差异日志:有界环形(默认 500 条),可订阅(输出通道消费) */
export class ShadowDiffLog {
  private seq = 0;
  private readonly items: ShadowDiffEntry[] = [];
  private readonly listeners = new Set<(entry: ShadowDiffEntry) => void>();

  constructor(private readonly limit = 500) {}

  record(entry: Omit<ShadowDiffEntry, 'seq' | 'timestamp'>, now = new Date()): ShadowDiffEntry {
    this.seq += 1;
    const full: ShadowDiffEntry = { ...entry, seq: this.seq, timestamp: now.toISOString() };
    this.items.push(full);
    if (this.items.length > this.limit) {
      this.items.splice(0, this.items.length - this.limit);
    }
    for (const listener of this.listeners) {
      listener(full);
    }
    return full;
  }

  entries(): readonly ShadowDiffEntry[] {
    return this.items;
  }

  summary(): { total: number; match: number; diff: number; failure: number } {
    let match = 0;
    let diff = 0;
    let failure = 0;
    for (const item of this.items) {
      if (item.verdict === 'match') {
        match += 1;
      } else if (item.verdict === 'diff') {
        diff += 1;
      } else {
        failure += 1;
      }
    }
    return { total: this.items.length, match, diff, failure };
  }

  clear(): void {
    this.items.length = 0;
  }

  subscribe(listener: (entry: ShadowDiffEntry) => void): { dispose(): void } {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  }
}

/** compare() 所需的 client 面(KodeCoreClient 子集,测试可注入替身) */
export interface ShadowClientLike {
  start(): Promise<unknown>;
  request(
    method: string,
    params?: unknown,
    opts?: { timeoutMs?: number }
  ): Promise<unknown>;
  dispose(): Promise<void>;
  /** 语料镜像腿(Phase2 首片):文档 open/change/close,notify 语义不回包 */
  openDocument?(uri: string, languageId: string, version: number, text: string): void;
  changeDocument?(uri: string, version: number, text: string): void;
  closeDocument?(uri: string): void;
  /** 重启代数读口(E-2;可选):自动重启后 gate 重置镜像账并重放快照 */
  getRestartGeneration?(): number;
}

export interface KodeCoreGateOptions {
  /** 默认 new KodeCoreClient({ binaryPath: serverPath }) */
  clientFactory?: (serverPath: string) => ShadowClientLike;
  diffLog?: ShadowDiffLog;
  now?: () => number;
}

/** 门状态快照(可观测/回退演练判据读取) */
export interface KodeCoreGateState {
  mode: KodeBackendMode;
  /** 生效轨道:rust 被 serving 门禁拒绝时为 'ts' */
  servingMode: 'ts' | 'shadow';
  rustServingGated: boolean;
  serverPath: string;
  clientAlive: boolean;
  notices: readonly string[];
}

export class KodeCoreGate {
  readonly diffLog: ShadowDiffLog;
  private config: KodeCoreGateConfig = { ...DEFAULT_CORE_GATE_CONFIG };
  private client: ShadowClientLike | null = null;
  private clientServerPath = '';
  private nextAttemptAt = 0;
  /** 语料镜像账:uri → 已镜像版本(shadow 会话内;kill-switch 清空) */
  private mirroredVersions = new Map<string, number>();
  /** 语料快照:uri → 最近镜像内容(重启重放依据;关文档即撤,kill-switch 清空) */
  private mirrorSnapshots = new Map<
    string,
    { languageId: string; version: number; text: string }
  >();
  /** 上次见到的重启代数(null = 尚未对账;变化即判定自动重启) */
  private lastRestartGeneration: number | null = null;
  private readonly notices: string[] = [];
  private readonly now: () => number;
  private readonly options: KodeCoreGateOptions;

  constructor(options: KodeCoreGateOptions = {}) {
    this.diffLog = options.diffLog ?? new ShadowDiffLog();
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  /** 应用新配置;离开 shadow 或换二进制即停 Rust 进程(kill-switch 生效点) */
  setConfig(config: KodeCoreGateConfig): void {
    const previous = this.config;
    this.config = { ...config };
    const resolved = resolveBackendMode(config.backend);
    if (resolved.mode !== 'shadow' || previous.serverPath !== config.serverPath) {
      this.stopClient();
    }
    if (resolved.mode === 'rust') {
      this.noticeOnce(
        'kbengine.core.backend=rust 被 serving 门禁拒绝:切流前置条件未全绿(docs/kode2/pr-012.md),生效轨道仍为 ts'
      );
    }
  }

  /** 解析后的模式(rust 字面量保留原值供观测) */
  get mode(): KodeBackendMode {
    return resolveBackendMode(this.config.backend).mode;
  }

  /** 生效服务轨道:rust 门禁拒绝后恒 ts;shadow 时 TS 仍为唯一服务方 */
  get servingMode(): 'ts' | 'shadow' {
    return this.mode === 'shadow' ? 'shadow' : 'ts';
  }

  get rustServingGated(): boolean {
    return resolveBackendMode(this.config.backend).rustServingGated;
  }

  get state(): KodeCoreGateState {
    return {
      mode: this.mode,
      servingMode: this.servingMode,
      rustServingGated: this.rustServingGated,
      serverPath: this.config.serverPath,
      clientAlive: this.client !== null,
      notices: [...this.notices],
    };
  }

  /**
   * serving 门禁:Rust 路径在本 PR 一律不服务(切流前置条件未全绿)。
   * 未来切流 PR 的唯一放行点 —— 这里翻 true 之前必须先过 pr-012.md 前置
   * 条件清单并完成回退演练。
   */
  serveFromRust(): boolean {
    return false;
  }

  private noticeOnce(text: string): void {
    if (!this.notices.includes(text)) {
      this.notices.push(text);
      if (this.notices.length > 20) {
        this.notices.shift();
      }
    }
  }

  private ensureClient(): ShadowClientLike | null {
    if (this.client && this.clientServerPath === this.config.serverPath) {
      return this.client;
    }
    this.stopClient();
    try {
      this.client =
        this.options.clientFactory?.(this.config.serverPath) ??
        new KodeCoreClient({ binaryPath: this.config.serverPath });
      this.clientServerPath = this.config.serverPath;
      return this.client;
    } catch (error) {
      this.client = null;
      this.clientServerPath = '';
      this.noticeOnce(`shadow client 创建失败: ${(error as Error).message}`);
      return null;
    }
  }

  /** kill-switch/换二进制:停 Rust 进程并清冷却、镜像账与快照(异步,不阻塞配置路径) */
  private stopClient(): void {
    const client = this.client;
    this.client = null;
    this.clientServerPath = '';
    this.mirroredVersions.clear();
    this.mirrorSnapshots.clear();
    this.lastRestartGeneration = null;
    if (client) {
      void client.dispose().catch(() => undefined);
    }
  }

  /**
   * 重启对账(E-2):client 自动重启后新进程是空库,旧版本账必须失效 ——
   * 版本账清零,快照全量重放为 didOpen(新账随重放重建),否则 didChange 会
   * 因文档未打开被新进程忽略。调用点:每次 start() 握手之后(mirrorDocument
   * 与 compare 同一入口,谁先到谁重放)。
   */
  private syncRestartGeneration(client: ShadowClientLike): void {
    const generation = client.getRestartGeneration?.();
    if (typeof generation !== 'number') {
      return;
    }
    if (this.lastRestartGeneration === null) {
      this.lastRestartGeneration = generation;
      return;
    }
    if (generation === this.lastRestartGeneration) {
      return;
    }
    this.lastRestartGeneration = generation;
    this.mirroredVersions.clear();
    for (const [uri, snapshot] of this.mirrorSnapshots) {
      client.openDocument?.(uri, snapshot.languageId, snapshot.version, snapshot.text);
      this.mirroredVersions.set(uri, snapshot.version);
    }
  }

  /**
   * 语料镜像腿(Phase2 首片):把文档 open/change 同步给 Rust server,
   * definition/diagnostics 影子对拍才有同输入。尽力而为:任何失败静默
   * (verdict 口径归 compare 自己的失败分类,镜像不刷差异日志);非 shadow
   * 或未配 serverPath 零开销直通。版本账在会话内单调:前进走 didChange,
   * 回退(重开)走 close+open,不虚构版本;自动重启后账本重置并重放快照。
   */
  async mirrorDocument(
    uri: string,
    languageId: string,
    version: number,
    text: string
  ): Promise<void> {
    if (this.servingMode !== 'shadow' || !this.config.serverPath) {
      return;
    }
    const client = this.ensureClient();
    if (!client) {
      return;
    }
    await client.start();
    this.syncRestartGeneration(client);
    const mirrored = this.mirroredVersions.get(uri);
    if (mirrored === undefined) {
      client.openDocument?.(uri, languageId, version, text);
    } else if (version > mirrored) {
      client.changeDocument?.(uri, version, text);
    } else if (version < mirrored) {
      client.closeDocument?.(uri);
      client.openDocument?.(uri, languageId, version, text);
    } else {
      // 同版本 = 同内容(VS Code 每次内容变更版本必增):镜像腿重入不重发。
      return;
    }
    this.mirroredVersions.set(uri, version);
    this.mirrorSnapshots.set(uri, { languageId, version, text });
  }

  /**
   * 关文档清理(E-4):撤版本账与快照,并通知 Rust didClose —— 关闭/丢弃未保存
   * 修订后 Rust 侧不再持有旧 overlay(内存不涨),重开低版本文档走 didOpen
   * 正常路径。不反向拉起进程:只处理已存在的 client(非 shadow 或未装配时
   * 仅清账);幂等,重复关闭不再发通知。
   */
  closeMirroredDocument(uri: string): void {
    const hadSnapshot = this.mirrorSnapshots.delete(uri);
    this.mirroredVersions.delete(uri);
    if (!hadSnapshot) {
      return;
    }
    if (this.servingMode !== 'shadow') {
      return;
    }
    this.client?.closeDocument?.(uri);
  }

  /**
   * shadow 镜像对比:恒返回 tsResult 原样,永不抛错。Rust 结果只进差异
   * 日志;任何 Rust 侧失败(start/请求/超时/不可用)只记 verdict 不上浮。
   * 非 shadow 模式零开销直通(不建进程、不记日志)。
   */
  async compare<T>(method: string, params: unknown, tsResult: T, uri?: string): Promise<T> {
    if (this.servingMode !== 'shadow') {
      return tsResult;
    }
    const fail = (verdict: ShadowVerdict, detail?: string): void => {
      this.diffLog.record({ method, uri, verdict, detail });
    };
    if (!this.config.serverPath) {
      fail('rust-unavailable', 'kbengine.core.serverPath 未配置,影子比对不可用');
      return tsResult;
    }
    if (this.now() < this.nextAttemptAt) {
      fail('rust-unavailable', 'spawn 冷却中(上次启动失败 30s 内不重试)');
      return tsResult;
    }
    const client = this.ensureClient();
    if (!client) {
      this.nextAttemptAt = this.now() + SPAWN_COOLDOWN_MS;
      fail('rust-unavailable', 'shadow client 创建失败');
      return tsResult;
    }
    try {
      await client.start();
    } catch (error) {
      this.nextAttemptAt = this.now() + SPAWN_COOLDOWN_MS;
      fail('rust-unavailable', `rust server 启动失败: ${truncate((error as Error).message, 120)}`);
      return tsResult;
    }
    // 自动重启后先重放语料快照,否则本次对拍打在空库上(E-2)
    this.syncRestartGeneration(client);
    try {
      const rustResult = await client.request(method, params, {
        timeoutMs: this.config.shadowTimeoutMs,
      });
      const diffAt = firstDiffPath(tsResult, rustResult);
      if (diffAt === null) {
        this.diffLog.record({ method, uri, verdict: 'match' });
      } else {
        this.diffLog.record({
          method,
          uri,
          verdict: 'diff',
          detail: `${diffAt} ts=${preview(tsResult)} rust=${preview(rustResult)}`,
        });
      }
    } catch (error) {
      if (
        error instanceof KodeCoreTransportError &&
        (error.code === 'TIMEOUT' || error.code === 'REQUEST_CANCELLED')
      ) {
        // TIMEOUT=硬超时兜底;REQUEST_CANCELLED=超时闸先发的 $/cancelRequest
        // 回 -32800 —— 两者都是影子超时,归 rust 侧
        fail('rust-timeout', `${method} 超时(${this.config.shadowTimeoutMs}ms)`);
      } else {
        fail('rust-error', truncate((error as Error).message, 160));
      }
    }
    return tsResult;
  }

  /** 停 Rust 进程;差异日志保留(回退演练要读) */
  async dispose(): Promise<void> {
    this.stopClient();
  }
}
