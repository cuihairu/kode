/**
 * 热更保存事件流水线纯核(HR-PR-04,书 §19.4):
 * - 零 IO、零 vscode 导入:时钟/定时器/快照读/语法检查全部注入,装配面
 *   才决定真实现(与 kode-vfs VFS-001、hotReloadModuleIdentity 同边界);
 * - HR-WATCH-006 每文件去抖(尾窗)+ 全局 max-delay 封顶:同一文件连发
 *   事件合并重排窗,排窗以 max-delay 为上限(save storm 至多推迟到
 *   max-delay,封顶截断如实记 max-delay-capped 因);
 * - HR-WATCH-003/009 事件源标记(save/disk-change)归并:同一写盘动作
 *   触发 save 事件与 disk 事件时按同文件同 pending 归并(去重不双发),
 *   归并为 FileChanged{uri,revision,diskHash,source,time} 并记录合并原因;
 * - HR-WATCH-007 写入稳定:短窗连续快照一致才发,超探测上限如实发
 *   (unstable 原因记录),读不到(已删除)如实丢弃;
 * - HR-WATCH-010 canonical URI + targetId + 内容哈希去重:同内容同目标
 *   不重复发(HR-PR-02 canonicalizeScriptFilePath 复用);
 * - HR-WATCH-008 投递指纹与去重指纹分离:指纹在批次交给发送面的那一刻
 *   记(本核不知投递成败),投递失败由装配调 forgetSent 撤回,同内容
 *   变更照发——不在定稿时记,否则一次失败即永久跳过同内容;
 * - HR-WATCH-011 版本守卫:响应到达时 sent revision 落后当前 revision
 *   即 stale,不得把旧响应写成新版本成功(isStaleResponse 纯判)。
 *   revision 只随「实际发出的新内容版本」递增——去重/语法拦截不占号,
 *   否则在途的同内容响应会被误判 stale;
 * - 波次归集:同一去抖窗内定稿的文件合成一批发出(波次冲口 batchFlushMs
 *   到期归集),批次出口判批量预览阈值,同窗多文件天然成批;
 * - HR-WATCH-012 语法闸:注入检查器不通过 → blocked,不默认发送半成品;
 * - HR-WATCH-014 dispose 清空待提交队列(pending/波次/预览滞留);
 * - HR-WATCH-016 批量预览:超阈值批次只出预览,不自动发,显式放行才发,
 *   滞留期间新批次并入同一滞留批次;
 * - HR-WATCH-017 诊断事件:trigger/filtered/debounced/deduped/blocked/
 *   scheduled/preview/flushed 全量可注入观察。
 *
 * 装配接线(vscode 事件绑定、配置面、默认开关)不在本核;HR-WATCH-001
 * 「默认 off」与用户 2026-11-06 令(零配置默认开、保存即自动发)冲突,
 * 冲突解决权在用户,接线批随配置面定夺。
 */

import { canonicalizeScriptFilePath } from './hotReloadModuleIdentity';

/** 定时器注入面:本核自持类型,不 import src/hotReload(那会顺带 vscode 进测试图) */
export interface SavePipelineTimerDeps {
  readonly set: (callback: () => void, delayMs: number) => unknown;
  readonly clear: (handle: unknown) => void;
}

/** 事件源:编辑器保存 / 磁盘变更(HR-WATCH-003 原生 watcher 与 save 重叠去重) */
export type HotReloadEventSource = 'save' | 'disk-change';

/** HR-WATCH-009 归并后的文件变更记录:诊断与发送消费的唯一形状 */
export interface FileChanged {
  /** 规范化路径(canonicalizeScriptFilePath 产物;file:// 剥 scheme 等) */
  readonly uri: string;
  /** 每文件单调递增版本号:仅实际发出的新内容版本才递增(去重/语法拦截不递增,
   *  否则 deduped offer 白占版本号,会把同内容的在途响应误判 stale) */
  readonly revision: number;
  /** 发送时内容哈希;读不到为空串(如实,不猜) */
  readonly diskHash: string;
  /** 归并后代表事件源(最新一次) */
  readonly source: HotReloadEventSource;
  /** 时钟毫秒 */
  readonly time: number;
  /** 归并进本条的原始事件数(≥1) */
  readonly coalesced: number;
  /** 合并原因(诊断口径:debounced/disk-save-overlap/unstable 等逐项加分号) */
  readonly coalesceReason: string;
}

/** HR-WATCH-017 诊断事件类型 */
export type SavePipelineDiagnosticType =
  | 'trigger'
  | 'filtered'
  | 'debounced'
  | 'deduped'
  | 'blocked'
  | 'scheduled'
  | 'preview'
  | 'flushed';

export interface SavePipelineDiagnostic {
  readonly type: SavePipelineDiagnosticType;
  readonly uri?: string;
  readonly detail?: string;
  readonly time: number;
}

/** 快照读取(注入):null=读不到(已删除/不可读),hash 空串=读得到但哈不出 */
export interface FileSnapshot {
  readonly hash: string;
  readonly content: string;
}

/** 轻量语法检查注入面(HR-WATCH-012):检查器本体由装配决定,不通过即拦 */
export type SyntaxCheck = (content: string) => { readonly ok: boolean; readonly errors?: readonly string[] };

/** 阵列输出模式:auto=直接发;preview-release=预览放行(HR-WATCH-016) */
export type SavePipelineEmitMode = 'auto' | 'preview-release';

export interface HotReloadSavePipelineOptions {
  /** 每文件去抖窗(缺省 500ms,与 HOT_RELOAD_DEFAULT_DEBOUNCE_MS 同值) */
  readonly debounceMs?: number;
  /** 全局最大推迟上限(缺省 5000ms):pending 首事件起超此限强制冲(HR-WATCH-006) */
  readonly maxDelayMs?: number;
  /** 稳定窗(缺省 200ms):两拍快照一致才算写稳;0=不做稳定等待 */
  readonly stabilityWindowMs?: number;
  /** 稳定探测上限(缺省 3):超限如实发并记 unstable 原因(HR-WATCH-007) */
  readonly maxStabilityProbes?: number;
  /** 批量预览阈值(缺省 50):一波触及超过此数的批次只预览不放行(HR-WATCH-016) */
  readonly batchPreviewThreshold?: number;
  /** 波次冲出口(缺省=debounceMs):本波最后一次定稿后延时归集,同窗多文件合成一批 */
  readonly batchFlushMs?: number;
  /** 定时器注入(缺省真 setTimeout;测试用内存时钟) */
  readonly timers?: SavePipelineTimerDeps;
  /** 时钟注入(缺省 Date.now) */
  readonly now?: () => number;
  /** 快照读取(注入即启用稳定等待与语法闸的内容面;缺省=无稳定等待) */
  readonly readSnapshot?: (file: string) => Promise<FileSnapshot | null>;
  /** 语法闸(注入即启用;不注入=无检查,如实不拦) */
  readonly checkSyntax?: SyntaxCheck;
  /** 目标归属(去重键的一部分;缺省空串=无目标维度) */
  readonly targetOf?: (file: string) => string;
  /** HR-WATCH-017 诊断事件出口 */
  readonly onDiagnostic?: (diagnostic: SavePipelineDiagnostic) => void;
  /** 阵列出口(发送消费面) */
  readonly onEmit: (events: readonly FileChanged[], mode: SavePipelineEmitMode) => void;
}

/** 定稿中状态:首拍时刻 / 最新事件源 / 归并计数 / 原因累计 / 去抖 timer */
interface PendingEntry {
  firstOfferAt: number;
  lastSource: HotReloadEventSource;
  coalesced: number;
  reasons: string[];
  timer: unknown;
}

/** HR-WATCH-011 版本守卫(纯判):响应的 sent revision 落后即 stale,不得记新版本成功 */
export function isStaleResponse(sentRevision: number, currentRevision: number): boolean {
  return sentRevision < currentRevision;
}

/** HR-WATCH-010 去重键(纯):canonical URI + targetId + 内容哈希,三同即重复 */
export function isDuplicateUpdate(
  a: { readonly uri: string; readonly targetId: string; readonly hash: string },
  b: { readonly uri: string; readonly targetId: string; readonly hash: string }
): boolean {
  return a.uri === b.uri && a.targetId === b.targetId && a.hash === b.hash;
}

const DEFAULT_EXCLUDED_DIRS: ReadonlySet<string> = new Set([
  '.git',
  '.hg',
  '.svn',
  '.venv',
  'venv',
  'node_modules',
  '__pycache__',
  '.kbengine',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache'
]);

/** 备份/临时文件形态:.swp/.swo/.bak/.tmp/尾 ~ /首尾 #(编辑器锁与原子写残留) */
const isBackupLike = (name: string): boolean =>
  /\.(swp|swo|bak|tmp)$/i.test(name) || name.endsWith('~') || (name.startsWith('#') && name.endsWith('#'));

export interface WatchableFileOptions {
  /** 收录扩展名(小写含点);缺省只认 .py(热更流水线本职是 python 模块重载) */
  readonly extensions?: readonly string[];
  /** 脚本资源根集合:给出即只收根内文件(严格前缀+整段边界);缺省不限根 */
  readonly roots?: readonly string[];
  /** 额外排除目录段(与默认排除表并集);缺省只用默认表 */
  readonly excludedDirs?: readonly string[];
}

/**
 * HR-WATCH-004 纯过滤:只收已声明根内、扩展名准许、目录段不在排除表、
 * 文件名非备份/临时形态的脚本文件。纯词法判定,零 IO。
 */
export function isWatchableScriptFile(fsPath: string, options: WatchableFileOptions = {}): boolean {
  const posix = fsPath.replace(/\\/g, '/');
  if (posix.length === 0) {
    return false;
  }
  const segments = posix.split('/').filter(segment => segment.length > 0);
  if (segments.length === 0) {
    return false;
  }
  const name = segments[segments.length - 1];
  const extensions = options.extensions ?? ['.py'];
  if (!extensions.some(ext => name.toLowerCase().endsWith(ext))) {
    return false;
  }
  if (isBackupLike(name)) {
    return false;
  }
  const excluded = new Set([...DEFAULT_EXCLUDED_DIRS, ...(options.excludedDirs ?? [])]);
  for (const segment of segments.slice(0, -1)) {
    if (excluded.has(segment) || excluded.has(segment.toLowerCase())) {
      return false;
    }
  }
  const roots = (options.roots ?? []).map(root => canonicalizeScriptFilePath(root)).filter(root => root.length > 0);
  if (roots.length === 0) {
    return true;
  }
  const canonical = canonicalizeScriptFilePath(posix);
  return roots.some(root => canonical === root || canonical.startsWith(`${root}/`));
}

/** 热更保存事件流水线(纯核;事件绑定与发送消费由装配接线) */
export class HotReloadSavePipeline {
  private readonly debounceMs: number;
  private readonly maxDelayMs: number;
  private readonly stabilityWindowMs: number;
  private readonly maxStabilityProbes: number;
  private readonly batchPreviewThreshold: number;
  private readonly batchFlushMs: number;
  private readonly timers: SavePipelineTimerDeps;
  private readonly now: () => number;
  private readonly readSnapshot?: (file: string) => Promise<FileSnapshot | null>;
  private readonly checkSyntax?: SyntaxCheck;
  private readonly targetOf: (file: string) => string;
  private readonly onDiagnostic?: (diagnostic: SavePipelineDiagnostic) => void;
  private readonly onEmit: (events: readonly FileChanged[], mode: SavePipelineEmitMode) => void;

  private readonly pending = new Map<string, PendingEntry>();
  /** 正在稳定等待/定稿中的 uri:防异步两拍快照期内同文件并行起第二个定稿 */
  private readonly settling = new Set<string>();
  private readonly revisionByUri = new Map<string, number>();
  private readonly lastSentByUri = new Map<string, { targetId: string; hash: string }>();
  /** 预览滞留批次(HR-WATCH-016):存定稿事件,放行时原样发出 */
  private previewEvents: FileChanged[] = [];
  /** 波次缓冲:同一 debounce 窗内定稿的文件合成一批,冲口到期归集 */
  private wave: FileChanged[] = [];
  private waveTimer: unknown;
  /** 本波是否已开冲口:避免每文件各起一个冲口,波尾被反复拉长 */
  private waveArmed = false;
  private disposed = false;

  constructor(options: HotReloadSavePipelineOptions) {
    this.debounceMs = options.debounceMs ?? 500;
    this.maxDelayMs = options.maxDelayMs ?? 5000;
    this.stabilityWindowMs = options.stabilityWindowMs ?? 200;
    this.maxStabilityProbes = options.maxStabilityProbes ?? 3;
    this.batchPreviewThreshold = options.batchPreviewThreshold ?? 50;
    this.batchFlushMs = options.batchFlushMs ?? options.debounceMs ?? 500;
    this.timers = options.timers ?? {
      set: (callback, delayMs) => setTimeout(callback, delayMs),
      clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>)
    };
    this.now = options.now ?? (() => Date.now());
    this.readSnapshot = options.readSnapshot;
    this.checkSyntax = options.checkSyntax;
    this.targetOf = options.targetOf ?? (() => '');
    this.onDiagnostic = options.onDiagnostic;
    this.onEmit = options.onEmit;
  }

  /** 自省:当前 pending 文件(归并中,未定稿) */
  pendingFiles(): string[] {
    return [...this.pending.keys()];
  }

  /** 自省:预览滞留批次文件(HR-WATCH-016) */
  previewHeldFiles(): string[] {
    return this.previewEvents.map(event => event.uri);
  }

  /** 自省:本波已定稿未发出的文件 */
  waveFiles(): string[] {
    return this.wave.map(event => event.uri);
  }

  /**
   * 登记一次原始事件(save 或 disk-change)。同文件已有 pending → 归并
   * (coalesced+1;save 后紧跟的 disk 事件记 disk-save-overlap 原因,
   * 不双发 HR-WATCH-003 重叠去重);无 pending → 新起去抖窗。
   */
  offer(file: string, source: HotReloadEventSource): void {
    if (this.disposed) {
      return;
    }
    const uri = canonicalizeScriptFilePath(file);
    if (uri.length === 0) {
      this.diagnostic({ type: 'filtered', uri: file, detail: '路径为空,丢弃' });
      return;
    }
    const existing = this.pending.get(uri);
    const time = this.now();
    if (existing) {
      const overlap = existing.lastSource === 'save' && source === 'disk-change';
      existing.lastSource = source;
      existing.coalesced += 1;
      if (overlap) {
        existing.reasons.push('disk-save-overlap');
      }
      // 真去抖=尾窗:再发事件重排去抖窗;窗口预算以 max-delay 为上限,
      // save storm 只能推迟到 max-delay,不会无限推迟(HR-WATCH-006)。
      // 封顶截断如实记因(max-delay-capped),到期面不再补判。
      const elapsed = time - existing.firstOfferAt;
      const remaining = Math.min(this.debounceMs, Math.max(0, this.maxDelayMs - elapsed));
      if (remaining < this.debounceMs && !existing.reasons.includes('max-delay-capped')) {
        existing.reasons.push('max-delay-capped');
      }
      this.schedule(existing, uri, remaining);
      this.diagnostic({
        type: 'debounced',
        uri,
        detail: `归并第 ${existing.coalesced} 次事件(${source}),余窗 ${remaining}ms`
      });
      return;
    }
    // 首窗也受 max-delay 封顶:maxDelay < debounce 时窗即封顶(HR-WATCH-006)
    const firstWindow = Math.min(this.debounceMs, this.maxDelayMs);
    const entry: PendingEntry = {
      firstOfferAt: time,
      lastSource: source,
      coalesced: 1,
      reasons: firstWindow < this.debounceMs ? ['max-delay-capped'] : [],
      timer: undefined
    };
    this.pending.set(uri, entry);
    this.diagnostic({ type: 'trigger', uri, detail: `${source}(第 ${entry.coalesced} 事件)` });
    this.schedule(entry, uri, firstWindow);
  }

  /** 预览放行(HR-WATCH-016):用户显式放行滞留批次;无滞留如实空放 */
  releasePreview(): void {
    if (this.disposed || this.previewEvents.length === 0) {
      return;
    }
    const held = this.previewEvents;
    this.previewEvents = [];
    this.onEmit(held, 'preview-release');
    this.markSent(held);
    this.diagnostic({ type: 'flushed', detail: `预览放行 ${held.length} 文件` });
  }

  /**
   * HR-WATCH-008:投递失败撤回指纹,下次同内容变更照发,不永久跳过。
   * 指纹本身在批次交给发送面的那一刻记(见 emitBatch/releasePreview);
   * 本核不判投递成败,失败由装配按发送结果回调本方法。
   */
  forgetSent(file: string): void {
    this.lastSentByUri.delete(canonicalizeScriptFilePath(file));
  }

  /** 批次已交发送面:此刻记指纹(同内容同目标不再重发) */
  private markSent(events: readonly FileChanged[]): void {
    for (const event of events) {
      if (event.diskHash.length > 0) {
        this.lastSentByUri.set(event.uri, {
          targetId: this.targetOf(event.uri),
          hash: event.diskHash
        });
      }
    }
  }

  /** HR-WATCH-014:停用/销毁清空待提交队列(pending+波次+预览滞留),后续事件不再受理 */
  dispose(): void {
    this.disposed = true;
    for (const entry of this.pending.values()) {
      this.timers.clear(entry.timer);
    }
    this.pending.clear();
    this.settling.clear();
    this.timers.clear(this.waveTimer);
    this.waveTimer = undefined;
    this.wave = [];
    this.previewEvents = [];
  }

  private diagnostic(d: Omit<SavePipelineDiagnostic, 'time'>): void {
    this.onDiagnostic?.({ ...d, time: this.now() });
  }

  private schedule(entry: PendingEntry, uri: string, delayMs: number): void {
    this.timers.clear(entry.timer);
    entry.timer = this.timers.set(() => {
      entry.timer = undefined;
      void this.due(uri);
    }, delayMs);
    this.diagnostic({ type: 'scheduled', uri, detail: `${delayMs}ms` });
  }

  /** 单文件到期:稳定等待 → 入波次缓冲(max-delay 已在排窗面封顶,HR-WATCH-006) */
  private async due(uri: string): Promise<void> {
    const entry = this.pending.get(uri);
    if (!entry || this.disposed || this.settling.has(uri)) {
      return;
    }
    if (this.stabilityWindowMs > 0 && this.readSnapshot) {
      await this.awaitStable(uri, entry, 0);
      return;
    }
    await this.settle(uri, entry);
  }

  /**
   * HR-WATCH-007 写入稳定:两拍快照一致才发;超探测上限如实发并记 unstable。
   * settling 守卫:稳定等待是异步两拍,期间同文件再 offer 只会重排去抖窗
   * (见 offer),不得并行起第二个稳定/定稿流程,否则同 uri 双发。
   */
  private async awaitStable(uri: string, entry: PendingEntry, probe: number): Promise<void> {
    if (!this.pending.has(uri) || this.disposed) {
      return;
    }
    this.settling.add(uri);
    try {
      const first = await this.readSnapshot?.(uri);
      if (!this.pending.has(uri) || this.disposed) {
        return; // 等待期间被 dispose/冲走:如实让位
      }
      if (first === null || first === undefined) {
        this.pending.delete(uri);
        this.diagnostic({ type: 'filtered', uri, detail: '读不到快照(已删除/不可读),丢弃' });
        return;
      }
      await this.sleep(this.stabilityWindowMs);
      if (!this.pending.has(uri) || this.disposed) {
        return;
      }
      const second = await this.readSnapshot?.(uri);
      if (!this.pending.has(uri) || this.disposed) {
        return;
      }
      if (second === null || second === undefined) {
        this.pending.delete(uri);
        this.diagnostic({ type: 'filtered', uri, detail: '稳定窗内快照消失(已删除),丢弃' });
        return;
      }
      if (first.hash === second.hash) {
        await this.settle(uri, entry, second.hash, second.content);
        return;
      }
      if (probe + 1 >= this.maxStabilityProbes) {
        if (!entry.reasons.includes('unstable')) {
          entry.reasons.push(`unstable-after-${probe + 1}-probes`);
        }
        await this.settle(uri, entry, second.hash, second.content);
        return;
      }
      await this.awaitStable(uri, entry, probe + 1);
    } finally {
      this.settling.delete(uri);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise<void>(resolve => {
      const handle = this.timers.set(() => resolve(), ms);
      void handle;
    });
  }

  /** 定稿:语法闸 → 去重 → 入波次缓冲(波尾归集成批) */
  private async settle(uri: string, entry: PendingEntry, hash = '', content = ''): Promise<void> {
    if (!this.pending.has(uri) || this.disposed) {
      return;
    }
    this.pending.delete(uri);
    const targetId = this.targetOf(uri);
    // 语法闸只检一次(HR-WATCH-012):不通过即拦,不默认发送半成品
    if (this.checkSyntax && content.length > 0) {
      const verdict = this.checkSyntax(content);
      if (!verdict.ok) {
        const errors = verdict.errors ?? [];
        this.diagnostic({
          type: 'blocked',
          uri,
          detail: errors.length > 0 ? errors.join('; ') : '语法检查未通过'
        });
        return;
      }
    }
    const lastSent = this.lastSentByUri.get(uri);
    if (
      hash.length > 0 &&
      lastSent &&
      isDuplicateUpdate({ uri, targetId, hash }, { uri, targetId: lastSent.targetId, hash: lastSent.hash })
    ) {
      this.diagnostic({ type: 'deduped', uri, detail: '同内容同目标,不重复发送' });
      return;
    }
    // 去重指纹不在此记录:本核不知投递成败,指纹在批次实际发出时
    // 由 recordSent 记录(否则一次失败就永久跳过同内容,HR-WATCH-008)。
    // 版本号只随「实际发出的新内容版本」递增:去重/拦截不占号,否则在途的
    // 同内容响应会被 isStaleResponse 误判 stale(HR-WATCH-011)。
    const revision = (this.revisionByUri.get(uri) ?? 0) + 1;
    this.revisionByUri.set(uri, revision);
    const event: FileChanged = {
      uri,
      revision,
      diskHash: hash,
      source: entry.lastSource,
      time: this.now(),
      coalesced: entry.coalesced,
      coalesceReason: this.coalesceReasonOf(entry)
    };
    this.wave.push(event);
    if (!this.waveArmed) {
      this.waveArmed = true;
      this.waveTimer = this.timers.set(() => {
        this.waveTimer = undefined;
        this.waveArmed = false;
        this.flushWave();
      }, this.batchFlushMs);
      this.diagnostic({ type: 'scheduled', uri, detail: `波次冲口 ${this.batchFlushMs}ms` });
    }
  }

  private coalesceReasonOf(entry: PendingEntry): string {
    const reasons: string[] = [...entry.reasons];
    if (entry.coalesced > 1) {
      reasons.unshift(`debounced:${entry.coalesced}`);
    }
    return reasons.length > 0 ? reasons.join(';') : 'single';
  }

  /** 波尾归集:同窗定稿文件合成一批发出 */
  private flushWave(): void {
    if (this.disposed || this.wave.length === 0) {
      return;
    }
    const events = this.wave;
    this.wave = [];
    this.emitBatch(events);
  }

  /** 批次出口:超阈值只预览不放行(HR-WATCH-016),否则直接发 */
  private emitBatch(events: readonly FileChanged[]): void {
    if (this.previewEvents.length > 0) {
      // 已有滞留批次:并入滞留队列维持单一批次形态,等显式放行
      this.previewEvents.push(...events);
      this.diagnostic({
        type: 'preview',
        detail: `批次并入预览滞留(共 ${this.previewEvents.length} 文件)`
      });
      return;
    }
    if (events.length > this.batchPreviewThreshold) {
      this.previewEvents = [...events];
      this.diagnostic({
        type: 'preview',
        detail: `批量 ${events.length} 超阈值 ${this.batchPreviewThreshold},只预览不自动发`
      });
      return;
    }
    this.onEmit(events, 'auto');
    this.markSent(events);
    this.diagnostic({ type: 'flushed', detail: `${events.length} 文件` });
  }
}
