// 语言服务性能记录器(PR1,评审 docs/review/2026-10-22 §2.2):
// 统一口径记录 hover/definition/completion/diagnostics 与索引扫描的耗时、
// 子阶段、文件发现/读取/解析计数、缓存命中与「是否等初始化」。
// 约束:单调时钟(performance.now,不含墙钟回拨);详细样本默认关闭
// (只留聚合分位数);不记录任何用户代码文本,仅记路径类别/计数/耗时。

import { performance } from 'perf_hooks';
import {
  FILE_READ_RING_LIMIT,
  getFileReadTotals,
  getRecentFileReads,
  isFileReadVerbose
} from './fileReadMetrics';

export type LanguageServiceEventName =
  | 'hover'
  | 'definition'
  | 'completion'
  | 'signature-help'
  | 'diagnostics'
  | 'python-index-scan'
  | 'python-composition-roots'
  | 'entity-mapping-scan'
  | 'semantic-query'
  | 'type-registry-query'
  | 'file-discovery'
  | 'document-parse'
  | 'document-commit'
  | 'python-mro-resolve'
  | 'python-annotation-query'
  | 'index-scheduler';

export type OperationStatus = 'ok' | 'miss' | 'cancelled' | 'error';

/** 每条样本的维度字段(全部是数字/枚举,不含用户文本) */
export interface OperationMeta {
  /** 'python' | 'def' | 'xml' | 'entities' | 'types' ... */
  fileKind?: string;
  /** 资产根/工作区根标识(路径,不进详细日志正文以外的导出) */
  assetRoot?: string;
  indexGeneration?: number;
  documentVersion?: number;
  /** 本次请求是否等待了首次扫描/索引初始化 */
  waitedForInit?: boolean;
}

export interface MetricsSample {
  name: LanguageServiceEventName;
  requestId: number;
  /** 单调时钟起点(performance.now 原值,非墙钟) */
  startedAt: number;
  elapsedMs: number;
  status: OperationStatus;
  subPhases: Record<string, number>;
  fileDiscoveryCount: number;
  fileReadCount: number;
  fileParseCount: number;
  cacheHits: number;
  cacheMisses: number;
  waitedForInit: boolean;
  meta: OperationMeta;
}

export interface OperationSummary {
  name: LanguageServiceEventName;
  /** elapsed 分位数采样窗口内的样本数;statusCounts/缓存/文件计数不受窗口影响,仍全程累计 */
  count: number;
  /** 采样窗口外被丢弃的 elapsed 样本数(全程累计);count+elapsedDropped=该事件全程观测数 */
  elapsedDropped: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  avgMs: number;
  totalMs: number;
  cacheHitRate: number;
  /** 原始命中/未命中计数(PR2 起导出,报告直接引用,不再由命中率反推) */
  cacheHits: number;
  cacheMisses: number;
  waitedForInitCount: number;
  fileDiscoveryCount: number;
  fileReadCount: number;
  fileParseCount: number;
  statusCounts: Record<OperationStatus, number>;
}

export interface LanguageServiceOperation extends OperationMeta {
  readonly requestId: number;
  /** 累加计数(文件发现/读取/解析、缓存命中/未命中) */
  countFileDiscovery(count?: number): void;
  countFileRead(count?: number): void;
  countFileParse(count?: number): void;
  countCacheHit(count?: number): void;
  countCacheMiss(count?: number): void;
  /** 子阶段计时:stop() 后把耗时累加进样本 subPhases[label] */
  startSubPhase(label: string): () => void;
  end(status?: OperationStatus): void;
}

const DETAILED_LIMIT = 500;

/** 聚合 elapsed 分位数的采样窗口(IDE-RES-004):每事件名只保留最近样本,
 *  超过 2×上限时一次性丢回上限(分块截断,摊销 O(1),不做逐条 shift);
 *  计数字段(statusCounts/缓存/文件计数)不进窗口,仍全程累计。 */
const ELAPSED_SAMPLE_LIMIT = 2000;

const summaries = new Map<LanguageServiceEventName, {
  elapsed: number[];
  elapsedDropped: number;
  cacheHits: number;
  cacheMisses: number;
  waitedForInitCount: number;
  fileDiscoveryCount: number;
  fileReadCount: number;
  fileParseCount: number;
  statusCounts: Record<OperationStatus, number>;
}>();

const detailedSamples: MetricsSample[] = [];
let detailedEnabled = false;
let requestCounter = 0;
let logHub: { info(input: { source: string; component: string; text: string }): void } | null = null;

/** 单调时钟:Node16+/浏览器同源 performance.now,毫秒小数 */
function monotonicNow(): number {
  return performance.now();
}

export function nextRequestId(): number {
  requestCounter += 1;
  return requestCounter;
}

/** LogHub 注入点(与 hoverBudget 同款):接线后详细记录可同步进时间线 */
export function setLanguageServiceMetricsLogHub(hub: typeof logHub): void {
  logHub = hub;
}

/** 详细样本开关:默认关闭;命令面板/排障时按需打开 */
export function setDetailedRecordingEnabled(enabled: boolean): void {
  detailedEnabled = enabled;
}

export function isDetailedRecordingEnabled(): boolean {
  return detailedEnabled;
}

/** 最近详细样本(未开启时为空数组;环形缓冲,只留最近 500 条) */
export function getRecentDetailedSamples(): readonly MetricsSample[] {
  return detailedSamples;
}

/** 测试与跨基线对比用:清空全部聚合与详细样本(不影响开关与计数器) */
export function resetLanguageServiceMetrics(): void {
  summaries.clear();
  detailedSamples.length = 0;
  activeByName.clear();
}

function summaryFor(name: LanguageServiceEventName) {
  let entry = summaries.get(name);
  if (!entry) {
    entry = {
      elapsed: [],
      elapsedDropped: 0,
      cacheHits: 0,
      cacheMisses: 0,
      waitedForInitCount: 0,
      fileDiscoveryCount: 0,
      fileReadCount: 0,
      fileParseCount: 0,
      statusCounts: { ok: 0, miss: 0, cancelled: 0, error: 0 }
    };
    summaries.set(name, entry);
  }
  return entry;
}

function nearestRank(sorted: number[], rank: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(rank * sorted.length) - 1));
  return sorted[index];
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function createSummary(name: LanguageServiceEventName, entry: ReturnType<typeof summaryFor>): OperationSummary {
  const sorted = [...entry.elapsed].sort((left, right) => left - right);
  const totalMs = sorted.reduce((sum, value) => sum + value, 0);
  const cacheTotal = entry.cacheHits + entry.cacheMisses;
  const result: OperationSummary = {
    name,
    count: sorted.length,
    elapsedDropped: entry.elapsedDropped,
    p50Ms: round1(nearestRank(sorted, 0.5)),
    p95Ms: round1(nearestRank(sorted, 0.95)),
    p99Ms: round1(nearestRank(sorted, 0.99)),
    maxMs: round1(sorted.length ? sorted[sorted.length - 1] : 0),
    avgMs: sorted.length ? round1(totalMs / sorted.length) : 0,
    totalMs: round1(totalMs),
    cacheHitRate: cacheTotal ? round1((entry.cacheHits / cacheTotal) * 100) : 0,
    cacheHits: entry.cacheHits,
    cacheMisses: entry.cacheMisses,
    waitedForInitCount: entry.waitedForInitCount,
    fileDiscoveryCount: entry.fileDiscoveryCount,
    fileReadCount: entry.fileReadCount,
    fileParseCount: entry.fileParseCount,
    statusCounts: { ...entry.statusCounts }
  };
  return result;
}

export function getOperationSummary(name: LanguageServiceEventName): OperationSummary | null {
  const entry = summaries.get(name);
  return entry ? createSummary(name, entry) : null;
}

export function getAllOperationSummaries(): OperationSummary[] {
  return [...summaries.entries()].map(([name, entry]) => createSummary(name, entry));
}

const NAME_WIDTH = Math.max(...(['hover', 'definition', 'completion', 'diagnostics', 'python-index-scan',
  'python-composition-roots', 'entity-mapping-scan', 'semantic-query', 'type-registry-query',
  'file-discovery', 'document-parse'] as const).map(name => name.length));

/** 命令面板汇总文本:每个事件一行,分位数/命中率/计数同口径(无用户文本) */
export function getLanguageServiceSummaryReport(): string {
  const all = getAllOperationSummaries();
  const readTotals = getFileReadTotals();
  const fileReadLine =
    `file reads: ${readTotals.reads} total / ${readTotals.bytes} bytes ` +
    `(detail ring ${getRecentFileReads().length}/${FILE_READ_RING_LIMIT}, ` +
    `verbose ${isFileReadVerbose() ? 'on' : 'off'})`;
  if (all.length === 0) {
    return `No language service metrics recorded yet.\n${fileReadLine}\n`;
  }
  const lines = all.map(summary =>
    `${summary.name.padEnd(NAME_WIDTH)}  count=${String(summary.count).padStart(6)}` +
    (summary.elapsedDropped > 0 ? `(+${summary.elapsedDropped} dropped)` : '') + '  ' +
    `p50=${String(summary.p50Ms).padStart(9)}ms  p95=${String(summary.p95Ms).padStart(9)}ms  ` +
    `p99=${String(summary.p99Ms).padStart(9)}ms  max=${String(summary.maxMs).padStart(9)}ms  ` +
    `hit=${String(summary.cacheHitRate).padStart(5)}%  waitInit=${String(summary.waitedForInitCount).padStart(5)}  ` +
    `discover=${summary.fileDiscoveryCount} read=${summary.fileReadCount} parse=${summary.fileParseCount}  ` +
    `ok=${summary.statusCounts.ok} miss=${summary.statusCounts.miss} ` +
    `cancel=${summary.statusCounts.cancelled} error=${summary.statusCounts.error}`
  );
  return [
    `Kode language service metrics (monotonic clock, elapsed in ms;`,
    `p50/p95/p99/max/avg over recent window when samples were dropped, counts cumulative)`,
    ...lines,
    fileReadLine,
    ''
  ].join('\n');
}

function commitSample(sample: MetricsSample): void {
  const entry = summaryFor(sample.name);
  entry.elapsed.push(sample.elapsedMs);
  // 采样窗口:满 2×上限才一次性丢回上限(分块截断摊销 O(1)),丢弃量累计可对账
  if (entry.elapsed.length >= ELAPSED_SAMPLE_LIMIT * 2) {
    const dropped = entry.elapsed.length - ELAPSED_SAMPLE_LIMIT;
    entry.elapsed.splice(0, dropped);
    entry.elapsedDropped += dropped;
  }
  entry.cacheHits += sample.cacheHits;
  entry.cacheMisses += sample.cacheMisses;
  if (sample.waitedForInit) {
    entry.waitedForInitCount += 1;
  }
  entry.fileDiscoveryCount += sample.fileDiscoveryCount;
  entry.fileReadCount += sample.fileReadCount;
  entry.fileParseCount += sample.fileParseCount;
  entry.statusCounts[sample.status] += 1;
  if (detailedEnabled) {
    detailedSamples.push(sample);
    if (detailedSamples.length > DETAILED_LIMIT) {
      detailedSamples.shift();
    }
    logHub?.info({
      source: 'collector',
      component: 'language-service-metrics',
      text: `[kode-lsm] ${sample.name} id=${sample.requestId} ${round1(sample.elapsedMs)}ms ` +
        `status=${sample.status} waitInit=${sample.waitedForInit} ` +
        `discover=${sample.fileDiscoveryCount} read=${sample.fileReadCount} parse=${sample.fileParseCount}`
    });
  }
}

/** 开始一次操作计时;end() 落样本。忘记 end 的样本不进聚合(避免半程数据污染分位数) */
/**
 * IDE-MET-008:在册活动任务台账——start 入册/end 出册(含 cancelled 终态)。
 * 取消后残留任务从账上读,不从 provider 空返回值推断。
 */
const activeByName = new Map<string, number>();

/** 各操作族当前在册数(拷贝快照;空对象=零在册) */
export function getActiveOperationCounts(): Record<string, number> {
  return Object.fromEntries(activeByName);
}

/** 渲染活动任务报告:操作族在册数 + 诊断调度器排队/在途(DIA-006 诚实面) */
export function renderActiveTasksReport(input: {
  operationCounts: Record<string, number>;
  scheduler: { queued: number; inFlight: number };
}): string {
  const families = Object.keys(input.operationCounts).sort();
  const total = families.reduce((sum, name) => sum + input.operationCounts[name], 0);
  const lines = [
    'active tasks (in-flight operations started..ended; do not infer stopped work from empty return values):',
    ...families.map(name => `  ${name}: ${input.operationCounts[name]}`),
    `  diagnostics scheduler: queued=${input.scheduler.queued} inFlight=${input.scheduler.inFlight}`,
    `  total: ${total}`
  ];
  return `${lines.join('\n')}\n`;
}

export function startLanguageServiceOperation(
  name: LanguageServiceEventName,
  meta: OperationMeta = {}
): LanguageServiceOperation {
  const requestId = nextRequestId();
  const startedAt = monotonicNow();
  const subPhases: Record<string, number> = {};
  let fileDiscoveryCount = 0;
  let fileReadCount = 0;
  let fileParseCount = 0;
  let cacheHits = 0;
  let cacheMisses = 0;
  const pending: OperationMeta = { ...meta };
  let ended = false;
  activeByName.set(name, (activeByName.get(name) ?? 0) + 1);

  const operation = {
    requestId,
    countFileDiscovery(count = 1) { fileDiscoveryCount += count; },
    countFileRead(count = 1) { fileReadCount += count; },
    countFileParse(count = 1) { fileParseCount += count; },
    countCacheHit(count = 1) { cacheHits += count; },
    countCacheMiss(count = 1) { cacheMisses += count; },
    startSubPhase(label: string) {
      const subStart = monotonicNow();
      let stopped = false;
      return () => {
        if (stopped) {
          return;
        }
        stopped = true;
        subPhases[label] = round1((subPhases[label] ?? 0) + (monotonicNow() - subStart));
      };
    },
    end(status: OperationStatus = 'ok') {
      if (ended) {
        return;
      }
      ended = true;
      const remaining = (activeByName.get(name) ?? 1) - 1;
      if (remaining > 0) {
        activeByName.set(name, remaining);
      } else {
        activeByName.delete(name);
      }
      commitSample({
        name,
        requestId,
        startedAt,
        elapsedMs: round1(monotonicNow() - startedAt),
        status,
        subPhases,
        fileDiscoveryCount,
        fileReadCount,
        fileParseCount,
        cacheHits,
        cacheMisses,
        waitedForInit: pending.waitedForInit === true,
        meta: { ...pending }
      });
    }
  };
  for (const key of ['fileKind', 'assetRoot', 'indexGeneration', 'documentVersion', 'waitedForInit'] as const) {
    Object.defineProperty(operation, key, {
      set(value: OperationMeta[typeof key]) {
        if (value !== undefined) {
          (pending as Record<string, unknown>)[key] = value;
        }
      },
      get() {
        return pending[key];
      },
      configurable: true,
      enumerable: true
    });
  }
  return operation;
}

/** 热路径便捷打点(如 document-parse):一条样本直落聚合;subPhases 缺省空(无子阶段) */
export function recordLanguageServiceOperation(
  name: LanguageServiceEventName,
  elapsedMs: number,
  fields: Partial<Pick<MetricsSample, 'status' | 'cacheHits' | 'cacheMisses' | 'fileDiscoveryCount' |
    'fileReadCount' | 'fileParseCount'>> & OperationMeta & { subPhases?: Record<string, number> } = {}
): void {
  commitSample({
    name,
    requestId: nextRequestId(),
    startedAt: monotonicNow() - elapsedMs,
    elapsedMs: round1(elapsedMs),
    status: fields.status ?? 'ok',
    subPhases: fields.subPhases ?? {},
    fileDiscoveryCount: fields.fileDiscoveryCount ?? 0,
    fileReadCount: fields.fileReadCount ?? 0,
    fileParseCount: fields.fileParseCount ?? 0,
    cacheHits: fields.cacheHits ?? 0,
    cacheMisses: fields.cacheMisses ?? 0,
    waitedForInit: fields.waitedForInit === true,
    meta: {
      fileKind: fields.fileKind,
      assetRoot: fields.assetRoot,
      indexGeneration: fields.indexGeneration,
      documentVersion: fields.documentVersion
    }
  });
}
