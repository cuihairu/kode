// 诊断任务版本化与分层调度(PR6 A6-1/A6-2/A6-4):
//
// ① 版本化:每个诊断任务携带文档版本令牌。连续编辑时同 URI 的排队任务
//    「最新版本胜出」——旧版本任务出队时记 coalescedStale,永不执行;
//    执行后若文档已前进(stale),结果丢弃不发布(staleDropped)。任何路径
//    都不可能发布与当前版本不匹配的诊断。
// ② 分层:local 层 = 纯文本/AST 的本地校验(标量/结构/清单),只随本文档
//    编辑重算;semantic 层 = 依赖语义索引的校验,随索引失效重算。无关文件
//    变更不产生任何打开文档的诊断任务(per-URI 键控,天然隔离),指标可断言。
// ③ 同版本免重算:同文档同版本 + 同诊断输入代(generation,配置切换等外部
//    输入变更时自增)已发布过的,重复请求直接跳过(skippedCurrentVersion)。
// ④ 配置切换:诊断开关关闭 → 清空 collection 并记住 disabled(重开前不计算);
//    子开关/结构开关变更 → invalidateAll 迫使已发布文档重算。开关判定用
//    isDiagnosticsConfigSection 精确裁断,无关 kbengine.* 配置变更不再触发
//    全文档重扫(旧行为是任意 kbengine.* 变更都全量重算)。
//
// 打点:每次实际计算经 PR1 埋点记 diagnostics 事件(带 layer/fileKind/版本),
// 与 extension.ts 既有 startLanguageServiceOperation('diagnostics') 同名合并。

import { recordLanguageServiceOperation } from './languageServiceMetrics';

/** 诊断分层:local=纯文本/AST 本地校验;semantic=依赖语义索引的校验 */
export type DiagnosticLayer = 'local' | 'semantic';

/** 调度输入文档面:vscode.TextDocument 与测试替身的公共子集 */
export interface DiagnosticTaskDocument {
  uri: { toString(): string };
  /** 编辑序号;替身可能没有 → undefined(按「每次都可能变」处理) */
  version?: number;
}

export interface DiagnosticTaskOptions<T> {
  layer: DiagnosticLayer;
  /** 产出诊断项(同步;validateDocument/validateEntitiesXmlDocument 的计算面) */
  compute?: () => readonly T[];
  /** IDE-DIA-005 异步分片面:大文件计算移出同步入口;给了优先于 compute。
   *  返回 null = 中止(版本已前进等),记过期不发布;完成后的发布同样复核版本。 */
  computeAsync?: () => Promise<readonly T[] | null>;
  /** 发布面:diagnostics.set(uri, items) 或测试收集器 */
  publish: (items: readonly T[]) => void;
}

export interface DiagnosticSchedulerStats {
  /** 受理的请求总数(request + requestQueued) */
  requested: number;
  /** 实际执行计算次数 */
  computed: number;
  /** 成功发布次数 */
  published: number;
  /** 连续编辑合并:被更新版本顶掉、从未执行的排队任务数 */
  coalescedStale: number;
  /** 执行后才过期的任务:计算完成但版本已前进,结果丢弃不发布 */
  staleDropped: number;
  /** IDE-DIA-008:文档关闭(或关闭后重开)后晚到的 worker 结果丢弃数 */
  releasedDropped: number;
  /** 同版本 + 同诊断输入代已发布,重复请求跳过重算 */
  skippedCurrentVersion: number;
  /** 开关关闭期间受理的请求(只记账,不计算) */
  disabledSkipped: number;
  /** 计算在途时开关关闭(AUD-026):旧异步结果丢弃,不写回 collection */
  disabledAsyncDropped: number;
  /** 计算在途时诊断输入代已切换(AUD-026):旧配置结果丢弃,
   *  不发布也不把新代标成已发布 */
  staleGenerationDropped: number;
  /** 清理动作次数(开关关闭清空/文档关闭释放) */
  cleared: number;
}

interface UriState {
  /** 最近一次发布对应的文档版本(undefined=未发布过/替身无版本) */
  publishedVersion: number | undefined;
  /** 最近一次发布对应的诊断输入代 */
  publishedGeneration: number;
  /** 排队中的任务(同 URI 至多一个:新版本请求顶掉旧版本) */
  queued: QueuedTask | null;
}

interface QueuedTask {
  /** URI 键(IDE-DIA-006:出队后处理仍需回查 state,随任务携带) */
  key: string;
  document: DiagnosticTaskDocument;
  options: DiagnosticTaskOptions<unknown>;
  /** 入队时版本令牌 */
  version: number | undefined;
  /** 入队时关闭代(IDE-DIA-008:处理前失配=文档已关闭,零计算丢弃) */
  releaseEpoch: number;
}

function versionOf(document: DiagnosticTaskDocument): number | undefined {
  return typeof document.version === 'number' && Number.isFinite(document.version)
    ? document.version
    : undefined;
}

/** IDE-DIA-006 单轮时间片:一轮 flush 连续同步处理文档的时长上界。超出且
 *  还有待处理条目时让出宿主(宏任务边界)再继续——多个文档待诊断时,一轮
 *  flush 不连续占满宿主处理全部文档。与 workspaceIndex 的 YIELD_SLICE_MS
 *  同族口径(25ms),单次宿主连续同步段上界=切片+单个文档计算。 */
const FLUSH_SLICE_MS = 25;

/** 默认让出面:setImmediate 宏任务边界(定时器/IO/其它宏任务可插进) */
const yieldToHostDefault = (): Promise<void> =>
  new Promise(resolve => { setImmediate(resolve); });

export interface DiagnosticSchedulerOptions {
  /** 单轮时间片毫秒(测试注入;默认 FLUSH_SLICE_MS) */
  sliceMs?: number;
  /** 让出面(测试注入;默认 setImmediate 宏任务边界) */
  yieldToHost?: () => Promise<void>;
}

export class DiagnosticScheduler {
  /** 诊断输入代:配置切换(invalidateAll)自增,迫使已发布文档重算 */
  private generation = 0;
  private enabled = true;
  private readonly states = new Map<string, UriState>();
  /** IDE-DIA-005:在途异步计算(完成/失败均自摘) */
  private readonly pending = new Set<Promise<unknown>>();
  /** IDE-DIA-006:已出队、尚未处理完的条目数(pendingWorkload 诚实面:
   *  让出窗口内 map 面已空,残留量规仍要数上在途批的未处理条目) */
  private drainingCount = 0;
  /** IDE-DIA-008 每 URI 关闭代:releaseDocument 自增;stateFor 新建状态
   *  (重开/再请求)也自增——上一代的在途计算与出队条目全部失配作废,
   *  晚到的 worker 结果不可能写入 DiagnosticCollection。 */
  private readonly epochs = new Map<string, number>();
  private readonly sliceMs: number;
  private readonly yieldFn: () => Promise<void>;
  private readonly stats: DiagnosticSchedulerStats = {
    requested: 0,
    computed: 0,
    published: 0,
    coalescedStale: 0,
    staleDropped: 0,
    releasedDropped: 0,
    skippedCurrentVersion: 0,
    disabledSkipped: 0,
    disabledAsyncDropped: 0,
    staleGenerationDropped: 0,
    cleared: 0
  };

  constructor(options: DiagnosticSchedulerOptions = {}) {
    this.sliceMs = options.sliceMs ?? FLUSH_SLICE_MS;
    this.yieldFn = options.yieldToHost ?? yieldToHostDefault;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** 残留任务量规(P0-4b 审核重开 2026-10-28):排队中 URI 数与在途异步
   * 计算数——现场验收在取消/保存风暴后按此面观测宿主内无未泄残留。 */
  pendingWorkload(): { queued: number; inFlight: number } {
    // IDE-DIA-006:让出窗口内 map 面已空,已出队未处理完的条目也计入
    let queued = this.drainingCount;
    for (const state of this.states.values()) {
      if (state.queued) { queued += 1; }
    }
    return { queued, inFlight: this.pending.size };
  }

  /**
   * 诊断开关切换(A6-4):关闭时经 clearAll 清空 collection,之后请求只记账;
   * 重开时迫使全部已发布文档重算。返回开关是否发生变化。
   */
  setEnabled(enabled: boolean, clearAll: () => void): boolean {
    if (this.enabled === enabled) {
      return false;
    }
    this.enabled = enabled;
    if (!enabled) {
      clearAll();
      this.stats.cleared += 1;
      // 关闭期间发布的版本标记全部作废:重开后同版本也要重算一次
      for (const state of this.states.values()) {
        state.publishedVersion = undefined;
      }
    } else {
      this.invalidateAll();
    }
    return true;
  }

  /** 诊断输入变更(子开关/结构开关/语义索引失效):迫使已发布文档重算 */
  invalidateAll(): void {
    this.generation += 1;
    for (const state of this.states.values()) {
      state.publishedVersion = undefined;
    }
  }

  /**
   * 立即通道:同步计算 + 版本守卫(捕获版本令牌,计算后复核才发布)。
   * 同版本 + 同代已发布的直接跳过(无关重复请求零重算)。
   */
  request<T>(document: DiagnosticTaskDocument, options: DiagnosticTaskOptions<T>): void {
    this.stats.requested += 1;
    if (!this.enabled) {
      this.stats.disabledSkipped += 1;
      return;
    }
    const key = document.uri.toString();
    const state = this.stateFor(key);
    const version = versionOf(document);
    if (version !== undefined
      && state.publishedVersion === version
      && state.publishedGeneration === this.generation) {
      this.stats.skippedCurrentVersion += 1;
      return;
    }
    this.computeAndPublish(document, key, version, options as DiagnosticTaskOptions<unknown>);
  }

  /**
   * 排队通道(A6-1 连续编辑合并):同 URI 只保留最新版本任务,旧版本出队记
   * coalescedStale、永不执行。配合 flushQueued() 在宏任务边界发布。
   */
  requestQueued<T>(document: DiagnosticTaskDocument, options: DiagnosticTaskOptions<T>): void {
    this.stats.requested += 1;
    if (!this.enabled) {
      this.stats.disabledSkipped += 1;
      return;
    }
    const key = document.uri.toString();
    const state = this.stateFor(key);
    const version = versionOf(document);
    if (state.queued) {
      // 顶掉排队任务:版本不同即「连续编辑合并过期任务」;同版本替换不记合并
      if (state.queued.version !== undefined && version !== undefined
        && state.queued.version !== version) {
        this.stats.coalescedStale += 1;
      }
    }
    state.queued = {
      key,
      document,
      options: options as DiagnosticTaskOptions<unknown>,
      version,
      releaseEpoch: this.epochs.get(key) ?? 0
    };
  }

  /** 冲刷排队任务:每 URI 至多一个(最新版本),发布前复核版本令牌。
   *  IDE-DIA-006 单轮时间片:连续同步处理超过 sliceMs 且还有待处理条目时,
   *  让出宿主(宏任务边界)再继续;让出窗口内新入队任务由后续轮次收编,
   *  让出窗口内文档前进的条目按处理时守卫丢弃。无让出路径(小批量)与旧
   *  同步口径逐拍等价——零让出时整轮原子完成,旧契约不变。 */
  async flushQueued(): Promise<void> {
    if (!this.enabled) {
      return;
    }
    for (;;) {
      const batch = this.collectQueued();
      if (batch.length === 0) {
        return;
      }
      this.drainingCount = batch.length;
      let sliced = false;
      let roundStart = performance.now();
      for (let index = 0; index < batch.length; index += 1) {
        this.processQueuedEntry(batch[index]);
        this.drainingCount -= 1;
        if (index === batch.length - 1) {
          break;
        }
        if (performance.now() - roundStart >= this.sliceMs) {
          await this.yieldFn();
          // 让出窗口内开关关闭:剩余条目不再计算(重开 invalidateAll 兜重算)
          if (!this.enabled) {
            this.drainingCount = 0;
            return;
          }
          sliced = true;
          roundStart = performance.now();
        }
      }
      this.drainingCount = 0;
      // 本轮零让出=同步原子完成,窗口内不可能有新任务入队,收工;
      // 让出过=再收一轮,收编让出窗口内的编辑新入队任务
      if (!sliced) {
        return;
      }
    }
  }

  /** 出队:把 map 面排队任务一次性取走(所有权转移,并发 flush 不双算) */
  private collectQueued(): QueuedTask[] {
    const batch: QueuedTask[] = [];
    for (const state of this.states.values()) {
      const queued = state.queued;
      if (!queued) {
        continue;
      }
      state.queued = null;
      batch.push(queued);
    }
    return batch;
  }

  /** 处理单个出队条目:处理时守卫(比入队时更新鲜)后才计算发布 */
  private processQueuedEntry(queued: QueuedTask): void {
    // IDE-DIA-008:入队后文档已关闭(含让出窗口内关闭)→ 零计算直接丢弃
    if ((this.epochs.get(queued.key) ?? 0) !== queued.releaseEpoch) {
      this.stats.releasedDropped += 1;
      return;
    }
    const currentVersion = versionOf(queued.document);
    // 处理时文档已前进到入队之后的新版本(含让出窗口内前进):过期,丢弃
    if (queued.version !== undefined && currentVersion !== queued.version) {
      this.stats.staleDropped += 1;
      return;
    }
    const versionState = this.states.get(queued.key);
    if (queued.version !== undefined
      && versionState
      && versionState.publishedVersion === queued.version
      && versionState.publishedGeneration === this.generation) {
      this.stats.skippedCurrentVersion += 1;
      return;
    }
    this.computeAndPublish(queued.document, queued.key, queued.version, queued.options);
  }

  hasQueuedTasks(): boolean {
    for (const state of this.states.values()) {
      if (state.queued) {
        return true;
      }
    }
    return false;
  }

  /** IDE-DIA-005:是否有异步计算在途 */
  hasPendingComputations(): boolean {
    return this.pending.size > 0;
  }

  /** IDE-DIA-005:等全部在途异步计算落定(测试与停用面) */
  async pendingComputations(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.all([...this.pending]);
    }
  }

  /** 文档关闭:释放版本标记与残留排队任务(下次打开全量重算)。
   *  IDE-DIA-008:关闭代自增——上一代全部在途计算与已出队未处理条目
   *  的处理/发布前守卫失配,晚到的 worker 结果不可能写入 collection。 */
  releaseDocument(document: DiagnosticTaskDocument): void {
    const key = document.uri.toString();
    const state = this.states.get(key);
    if (!state) {
      return;
    }
    if (state.queued) {
      this.stats.coalescedStale += 1;
    }
    this.states.delete(key);
    this.epochs.set(key, (this.epochs.get(key) ?? 0) + 1);
    this.stats.cleared += 1;
  }

  getStats(): DiagnosticSchedulerStats {
    return { ...this.stats };
  }

  resetStats(): void {
    for (const key of Object.keys(this.stats) as Array<keyof DiagnosticSchedulerStats>) {
      this.stats[key] = 0;
    }
  }

  /** 测试与停用面:清空全部 URI 状态与统计(不改开关/代数) */
  resetForTests(): void {
    this.states.clear();
    this.epochs.clear();
    this.drainingCount = 0;
    this.resetStats();
    this.generation = 0;
    this.enabled = true;
  }

  private stateFor(key: string): UriState {
    let state = this.states.get(key);
    if (!state) {
      state = { publishedVersion: undefined, publishedGeneration: -1, queued: null };
      this.states.set(key, state);
      // IDE-DIA-008:新建状态=重开/再请求,上一代残留的晚到结果全部作废
      this.epochs.set(key, (this.epochs.get(key) ?? 0) + 1);
    }
    return state;
  }

  private computeAndPublish(
    document: DiagnosticTaskDocument,
    key: string,
    version: number | undefined,
    options: DiagnosticTaskOptions<unknown>
  ): void {
    // IDE-DIA-008:捕获当代关闭代——计算在途期间文档关闭(或关闭后重开)
    // 都会失配,晚到的 worker 结果发布前丢弃
    const releaseEpoch = this.epochs.get(key) ?? 0;
    // AUD-026:捕获发起代——计算在途期间诊断输入代切换(配置变更/invalidateAll),
    // 旧配置结果不得发布,也不得把新代标成已发布
    const startedGeneration = this.generation;
    if (options.computeAsync) {
      // IDE-DIA-005:异步分片面——大文件计算移出同步入口,完成后复核版本
      // 才发布;null(中止)/版本前进均记过期不发布
      const computation = options.computeAsync().then(items => {
        this.pending.delete(computation);
        this.stats.computed += 1;
        const startedAt = performance.now();
        if (items === null) {
          this.stats.staleDropped += 1;
          return;
        }
        // 发布守卫:计算期间文档前进(重入/编排)→ 结果与新版本不匹配,丢弃
        if (version !== undefined && versionOf(document) !== version) {
          this.stats.staleDropped += 1;
          recordLanguageServiceOperation('diagnostics', performance.now() - startedAt, {
            status: 'ok',
            fileKind: 'def',
            documentVersion: version,
            cacheMisses: 1
          });
          return;
        }
        // 发布守卫:计算期间文档已关闭(或关闭后重开到新代)→ 不写 collection
        if ((this.epochs.get(key) ?? 0) !== releaseEpoch) {
          this.stats.releasedDropped += 1;
          recordLanguageServiceOperation('diagnostics', performance.now() - startedAt, {
            status: 'ok',
            fileKind: 'def',
            documentVersion: version,
            cacheMisses: 1
          });
          return;
        }
        // AUD-026 发布守卫:计算在途时开关关闭 → 旧异步结果不写回 collection
        if (!this.enabled) {
          this.stats.disabledAsyncDropped += 1;
          recordLanguageServiceOperation('diagnostics', performance.now() - startedAt, {
            status: 'ok',
            fileKind: options.layer === 'semantic' ? 'semantic' : 'def',
            documentVersion: version,
            cacheMisses: 1
          });
          return;
        }
        // AUD-026 发布守卫:计算在途时代已切换 → 旧配置结果丢弃(不发布,
        // 也不把新代标成已发布,否则重开同版本会被 skippedCurrentVersion 跳过)
        if (this.generation !== startedGeneration) {
          this.stats.staleGenerationDropped += 1;
          recordLanguageServiceOperation('diagnostics', performance.now() - startedAt, {
            status: 'ok',
            fileKind: options.layer === 'semantic' ? 'semantic' : 'def',
            documentVersion: version,
            cacheMisses: 1
          });
          return;
        }
        options.publish(items);
        const state = this.stateFor(key);
        state.publishedVersion = version;
        state.publishedGeneration = this.generation;
        this.stats.published += 1;
        recordLanguageServiceOperation('diagnostics', performance.now() - startedAt, {
          status: 'ok',
          fileKind: options.layer === 'semantic' ? 'semantic' : 'def',
          documentVersion: version,
          cacheMisses: 1
        });
      }, error => {
        this.pending.delete(computation);
        throw error;
      });
      this.pending.add(computation);
      return;
    }
    const startedAt = performance.now();
    const items = options.compute!();
    this.stats.computed += 1;
    // 发布守卫:计算期间文档前进(重入/编排)→ 结果与新版本不匹配,丢弃
    if (version !== undefined && versionOf(document) !== version) {
      this.stats.staleDropped += 1;
      recordLanguageServiceOperation('diagnostics', performance.now() - startedAt, {
        status: 'ok',
        fileKind: 'def',
        documentVersion: version,
        cacheMisses: 1
      });
      return;
    }
    // 发布守卫(IDE-DIA-008):同步计算重入关闭文档 → 不写 collection
    if ((this.epochs.get(key) ?? 0) !== releaseEpoch) {
      this.stats.releasedDropped += 1;
      recordLanguageServiceOperation('diagnostics', performance.now() - startedAt, {
        status: 'ok',
        fileKind: 'def',
        documentVersion: version,
        cacheMisses: 1
      });
      return;
    }
    options.publish(items);
    const state = this.stateFor(key);
    state.publishedVersion = version;
    state.publishedGeneration = this.generation;
    this.stats.published += 1;
    recordLanguageServiceOperation('diagnostics', performance.now() - startedAt, {
      status: 'ok',
      fileKind: options.layer === 'semantic' ? 'semantic' : 'def',
      documentVersion: version,
      cacheMisses: 1
    });
  }
}

/**
 * 诊断相关配置裁断(A6-4):只有这些节变更才允许触发已打开文档重算。
 * 旧行为是任意 kbengine.* 变更(hover/jumpLog/codeLens…)都全量重扫,
 * 无关配置变更重算全部打开文档 —— 由 isDiagnosticsConfigSection 收口。
 */
const DIAGNOSTICS_CONFIG_SECTIONS = [
  'kbengine.enableDiagnostics',
  'kbengine.enableStructureDiagnostics',
  'kbengine.diagnostics'
] as const;

export function isDiagnosticsConfigSection(section: string): boolean {
  return DIAGNOSTICS_CONFIG_SECTIONS.some(prefix =>
    section === prefix || section.startsWith(`${prefix}.`));
}

/** 进程级共享实例:extension.ts 诊断事件面与测试共用同一份统计 */
let sharedScheduler: DiagnosticScheduler | null = null;

export function getDiagnosticScheduler(): DiagnosticScheduler {
  if (!sharedScheduler) {
    sharedScheduler = new DiagnosticScheduler();
  }
  return sharedScheduler;
}

/** 测试面:重置共享调度器(统计/队列/代数/开关全部归零) */
export function resetDiagnosticSchedulerForTests(): void {
  getDiagnosticScheduler().resetForTests();
}
