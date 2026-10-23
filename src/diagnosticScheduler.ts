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
  compute: () => readonly T[];
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
  /** 同版本 + 同诊断输入代已发布,重复请求跳过重算 */
  skippedCurrentVersion: number;
  /** 开关关闭期间受理的请求(只记账,不计算) */
  disabledSkipped: number;
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
  document: DiagnosticTaskDocument;
  options: DiagnosticTaskOptions<unknown>;
  /** 入队时版本令牌 */
  version: number | undefined;
}

function versionOf(document: DiagnosticTaskDocument): number | undefined {
  return typeof document.version === 'number' && Number.isFinite(document.version)
    ? document.version
    : undefined;
}

export class DiagnosticScheduler {
  /** 诊断输入代:配置切换(invalidateAll)自增,迫使已发布文档重算 */
  private generation = 0;
  private enabled = true;
  private readonly states = new Map<string, UriState>();
  private readonly stats: DiagnosticSchedulerStats = {
    requested: 0,
    computed: 0,
    published: 0,
    coalescedStale: 0,
    staleDropped: 0,
    skippedCurrentVersion: 0,
    disabledSkipped: 0,
    cleared: 0
  };

  isEnabled(): boolean {
    return this.enabled;
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
      document,
      options: options as DiagnosticTaskOptions<unknown>,
      version
    };
  }

  /** 冲刷排队任务:每 URI 至多一个(最新版本),发布前复核版本令牌 */
  flushQueued(): void {
    if (!this.enabled) {
      return;
    }
    for (const [key, state] of this.states) {
      const queued = state.queued;
      if (!queued) {
        continue;
      }
      state.queued = null;
      const currentVersion = versionOf(queued.document);
      // 冲刷时文档已前进到入队之后的新版本:该任务过期,丢弃
      if (queued.version !== undefined && currentVersion !== queued.version) {
        this.stats.staleDropped += 1;
        continue;
      }
      const versionState = this.states.get(key);
      if (queued.version !== undefined
        && versionState
        && versionState.publishedVersion === queued.version
        && versionState.publishedGeneration === this.generation) {
        this.stats.skippedCurrentVersion += 1;
        continue;
      }
      this.computeAndPublish(queued.document, key, queued.version, queued.options);
    }
  }

  hasQueuedTasks(): boolean {
    for (const state of this.states.values()) {
      if (state.queued) {
        return true;
      }
    }
    return false;
  }

  /** 文档关闭:释放版本标记与残留排队任务(下次打开全量重算) */
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
    this.resetStats();
    this.generation = 0;
    this.enabled = true;
  }

  private stateFor(key: string): UriState {
    let state = this.states.get(key);
    if (!state) {
      state = { publishedVersion: undefined, publishedGeneration: -1, queued: null };
      this.states.set(key, state);
    }
    return state;
  }

  private computeAndPublish(
    document: DiagnosticTaskDocument,
    key: string,
    version: number | undefined,
    options: DiagnosticTaskOptions<unknown>
  ): void {
    const startedAt = performance.now();
    const items = options.compute();
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
