/**
 * RUST-220(旧 UI-003)性能面板纯核:队列/缓存/索引生成/P95·P99/主要慢请求
 * 及处理建议,单份快照报告文本(命令驱动即时快照,与 showSummary/showActiveTasks
 * 同模式,不做轮询面板)。数据面全部复用既有源:诊断调度器 pendingWorkload
 * (DIA-006)、IndexScheduler.getStatus(RUST-187)、三缓存 gauge、
 * languageServiceMetrics 分位数汇总(P50/P95/P99 逐操作族,PR1)。
 * 诚实边界:无采样窗口样本的操作族不进慢请求榜(count=0 时分位数是空窗口
 * 产物,不冒充);处理建议按阈值映射既有取证入口,不发明新诊断。
 */

export interface PerformanceQueueInputs {
  diagnosticsQueued: number;
  diagnosticsInFlight: number;
  indexQueued: number;
  /** SchedulerStatus.running 是活动任务对象,接线侧归一成布尔 */
  indexRunning: boolean;
  indexFailed: number;
  indexCompleted: number;
  indexCancelled: number;
  indexQueuedByPriority: Record<number, number>;
}

export interface PerformanceIndexMetrics {
  mergedTasks: number;
  staleDropped: number;
  postponedBackground: number;
  backgroundDelayMs: number;
  recoveries: number;
}

export interface PerformanceCacheGauges {
  parsedDocuments: { entries: number; maxEntries: number; bytes: number; maxBytes: number };
  databaseSchemas: { entries: number; capacity: number };
  annotationIndex: { entries: number; ttlMs: number };
}

export interface PerformanceLatencyRow {
  name: string;
  count: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  cacheHitRate: number;
}

export interface PerformancePanelInputs {
  queue: PerformanceQueueInputs;
  index: PerformanceIndexMetrics;
  caches: PerformanceCacheGauges;
  /** 原样传入;纯核内按 p99 降序取「主要慢请求」前 N(count=0 的空窗口行排除) */
  latencies: PerformanceLatencyRow[];
}

/** 慢请求榜容量:只列主要慢请求(全量分位数表由 kbengine.metrics.showSummary 承载) */
const SLOW_REQUEST_LIMIT = 5;

/** 慢请求判定与建议映射(阈值固定,证据→既有取证入口,不发明新诊断) */
export function slowRequestSuggestion(row: PerformanceLatencyRow): string | null {
  if (row.p99Ms > 1000) {
    return '建议卡顿取证 kbengine.metrics.startCpuProfile;日志查看器过滤 [kode-lsm]/[kode-hover] 定位慢层';
  }
  if (row.p99Ms > 200) {
    return '观察下方索引队列与缓存命中率;持续偏高可开启 kbengine.metrics.detailed 逐样本记账';
  }
  return null;
}

function formatPriorityQueue(byPriority: Record<number, number>): string {
  const keys = Object.keys(byPriority).map(Number).sort((a, b) => a - b);
  if (keys.length === 0) {
    return '(空)';
  }
  return keys.map(priority => `p${priority}=${String(byPriority[priority])}`).join(' ');
}

/** 纯核:输入 → 面板报告文本。段落固定:队列→索引生成→缓存→主要慢请求→处理建议。 */
export function renderPerformancePanelReport(inputs: PerformancePanelInputs): string {
  const { queue, index, caches } = inputs;
  const lines: string[] = [
    'Kode 性能面板(即时快照;全量分位数表见 kbengine.metrics.showSummary,活动任务见 kbengine.metrics.showActiveTasks)',
    '',
    '## 队列',
    `诊断调度: 排队 ${String(queue.diagnosticsQueued)} / 在途 ${String(queue.diagnosticsInFlight)}`,
    `索引调度: 排队 ${String(queue.indexQueued)}${queue.indexRunning ? '(运行中)' : ''} / 失败 ${String(queue.indexFailed)} / 完成 ${String(queue.indexCompleted)} / 取消 ${String(queue.indexCancelled)}`,
    `索引排队分布: ${formatPriorityQueue(queue.indexQueuedByPriority)}`,
    ''
  ];

  lines.push('## 索引生成');
  lines.push(
    `合并去重 ${String(index.mergedTasks)} / 过期丢弃 ${String(index.staleDropped)} / 交互推迟 ${String(index.postponedBackground)}(累计让出 ${String(index.backgroundDelayMs)}ms) / 失败恢复 ${String(index.recoveries)}`
  );
  lines.push('');

  lines.push('## 缓存');
  const parsed = caches.parsedDocuments;
  const pct = (used: number, total: number): string =>
    total > 0 ? `(${String(Math.round((used / total) * 100))}% 容量)` : '';
  lines.push(
    `解析文档缓存: ${String(parsed.entries)}/${String(parsed.maxEntries)} 条 ${pct(parsed.entries, parsed.maxEntries)}, ${String(parsed.bytes)}/${String(parsed.maxBytes)} 字节`
  );
  lines.push(
    `数据库 schema 缓存: ${String(caches.databaseSchemas.entries)}/${String(caches.databaseSchemas.capacity)} 条 ${pct(caches.databaseSchemas.entries, caches.databaseSchemas.capacity)}`
  );
  lines.push(
    `返回注解索引: ${String(caches.annotationIndex.entries)} 条 (TTL ${String(caches.annotationIndex.ttlMs)}ms)`
  );
  lines.push('');

  lines.push('## 主要慢请求(按 P99 降序前 5)');
  const sampled = inputs.latencies.filter(row => row.count > 0);
  const slow = [...sampled].sort((a, b) => b.p99Ms - a.p99Ms).slice(0, SLOW_REQUEST_LIMIT);
  if (slow.length === 0) {
    lines.push('(无采样数据;语言服务运转后自然积累)');
  } else {
    for (const row of slow) {
      lines.push(
        `${row.name.padEnd(24)} count=${String(row.count).padStart(6)}  p50=${String(row.p50Ms).padStart(8)}ms  p95=${String(row.p95Ms).padStart(8)}ms  p99=${String(row.p99Ms).padStart(8)}ms  max=${String(row.maxMs).padStart(8)}ms  hit=${String(row.cacheHitRate).padStart(5)}%`
      );
    }
  }
  lines.push('');

  lines.push('## 处理建议');
  const suggestions = slow
    .map(row => {
      const tip = slowRequestSuggestion(row);
      return tip ? `${row.name}: ${tip}` : null;
    })
    .filter((tip): tip is string => tip !== null);
  if (suggestions.length > 0) {
    lines.push(...suggestions);
  } else if (slow.length > 0) {
    lines.push('无异常慢请求(各操作族 P99 均 ≤200ms),零打扰。');
  } else {
    lines.push('尚无采样数据,无建议。');
  }
  return lines.join('\n');
}
