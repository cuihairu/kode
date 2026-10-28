import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  getAllOperationSummaries,
  getLanguageServiceSummaryReport,
  getOperationSummary,
  getRecentDetailedSamples,
  isDetailedRecordingEnabled,
  nextRequestId,
  recordLanguageServiceOperation,
  resetLanguageServiceMetrics,
  setDetailedRecordingEnabled,
  startLanguageServiceOperation
} from '../src/languageServiceMetrics';

afterEach(() => {
  resetLanguageServiceMetrics();
});

afterAll(() => {
  setDetailedRecordingEnabled(false);
});

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

describe('languageServiceMetrics 请求ID', () => {
  it('单调自增且不为零', () => {
    const first = nextRequestId();
    const second = nextRequestId();
    expect(first).toBeGreaterThan(0);
    expect(second).toBe(first + 1);
  });
});

describe('languageServiceOperation 聚合', () => {
  it('end 落样本:P50/P95/P99/最大值/命中率/状态计数', async () => {
    const op = startLanguageServiceOperation('hover', { fileKind: 'python', documentVersion: 3 });
    op.countCacheHit();
    op.countCacheMiss();
    op.countCacheMiss();
    const stop = op.startSubPhase('semantic');
    await sleep(12);
    stop();
    op.end('ok');

    const summary = getOperationSummary('hover');
    expect(summary).not.toBeNull();
    expect(summary?.count).toBe(1);
    expect(summary?.p50Ms).toBeGreaterThanOrEqual(10);
    expect(summary?.maxMs).toBeGreaterThanOrEqual(summary?.p50Ms ?? 0);
    expect(summary?.cacheHitRate).toBeCloseTo(33.3, 0);
    expect(summary?.statusCounts.ok).toBe(1);
    expect(summary?.fileParseCount).toBe(0);
  });

  it('多次样本分位数按最近秩计算且不越界', () => {
    for (let elapsed = 1; elapsed <= 100; elapsed += 1) {
      recordLanguageServiceOperation('definition', elapsed);
    }
    const summary = getOperationSummary('definition');
    expect(summary?.count).toBe(100);
    expect(summary?.p50Ms).toBeGreaterThanOrEqual(50);
    expect(summary?.p95Ms).toBeGreaterThanOrEqual(95);
    expect(summary?.p99Ms).toBeGreaterThanOrEqual(99);
    expect(summary?.p99Ms).toBeLessThanOrEqual(100);
    expect(summary?.maxMs).toBe(100);
    expect(summary?.avgMs).toBeCloseTo(50.5, 0);
  });

  it('miss/cancelled/error 状态分别计数,waitInit 单独统计', () => {
    startLanguageServiceOperation('python-index-scan', { waitedForInit: true }).end('ok');
    startLanguageServiceOperation('python-index-scan').end('miss');
    startLanguageServiceOperation('python-index-scan').end('error');

    const summary = getOperationSummary('python-index-scan');
    expect(summary?.statusCounts).toEqual({ ok: 1, miss: 1, cancelled: 0, error: 1 });
    expect(summary?.waitedForInitCount).toBe(1);
  });

  it('文件发现/读取/解析计数累加进聚合', () => {
    const op = startLanguageServiceOperation('file-discovery');
    op.countFileDiscovery(120);
    op.countFileRead(118);
    op.countFileParse(118);
    op.end('ok');

    const summary = getOperationSummary('file-discovery');
    expect(summary?.fileDiscoveryCount).toBe(120);
    expect(summary?.fileReadCount).toBe(118);
    expect(summary?.fileParseCount).toBe(118);
  });

  it('end 后重复 end 不重复落样本', () => {
    const op = startLanguageServiceOperation('completion');
    op.end('ok');
    op.end('ok');
    expect(getOperationSummary('completion')?.count).toBe(1);
  });

  it('document-parse 便捷打点带文件类型与耗时', () => {
    recordLanguageServiceOperation('document-parse', 4.2, { fileKind: 'def', fileParseCount: 1 });
    const summary = getOperationSummary('document-parse');
    expect(summary?.count).toBe(1);
    expect(summary?.totalMs).toBe(4.2);
  });
});

describe('languageServiceMetrics 汇总报告', () => {
  it('报告含事件名与分位数行;空记录时给出空态', () => {
    expect(getLanguageServiceSummaryReport()).toContain('No language service metrics recorded yet');
    recordLanguageServiceOperation('semantic-query', 3.5);
    const report = getLanguageServiceSummaryReport();
    expect(report).toContain('semantic-query');
    expect(report).toContain('p50=      3.5ms');
    expect(getAllOperationSummaries()).toHaveLength(1);
  });

  it('聚合样本有容量上限:大量操作后 elapsed 不无限增长,分位数来自最近窗口(IDE-RES-004)', () => {
    for (let elapsed = 1; elapsed <= 5000; elapsed += 1) {
      recordLanguageServiceOperation('hover', elapsed);
    }
    const summary = getOperationSummary('hover');
    // 窗口截断生效:count 不再等于 5000,分块窗口落在 [上限, 2×上限) 内
    expect(summary?.count).toBeLessThan(5000);
    expect(summary?.count).toBeGreaterThanOrEqual(2000);
    expect(summary?.count).toBeLessThanOrEqual(4000);
    // 计数字段仍全程累计(与 elapsed 窗口口径分离):5000 条 ok 不截断
    expect(summary?.statusCounts.ok).toBe(5000);
    // 窗口可对账:全程观测 = 窗口内 + 被丢弃
    expect((summary?.count ?? 0) + (summary?.elapsedDropped ?? 0)).toBe(5000);
    // 分位数/max 基于最近窗口(丢掉的是最旧 2000 条,窗口覆盖 2001..5000)
    expect(summary?.p50Ms).toBeGreaterThan(2000);
    expect(summary?.maxMs).toBe(5000);
  });

  it('摘要标明采样窗口:有丢弃时 count 行内明示丢弃量,读者不把窗口分位数当全程分布', () => {
    for (let elapsed = 1; elapsed <= 4500; elapsed += 1) {
      recordLanguageServiceOperation('document-parse', elapsed);
    }
    const report = getLanguageServiceSummaryReport();
    expect(report).toMatch(/count=\s*\d+\(\+\d+ dropped\)/);
    // 窗口头注:报告明说 elapsed 分位数是最近窗口口径
    expect(report).toContain('recent window');
  });
});

describe('languageServiceMetrics 详细记录默认关闭', () => {
  it('默认关闭;打开后留最近样本,环形上限不无界增长', () => {
    expect(isDetailedRecordingEnabled()).toBe(false);
    recordLanguageServiceOperation('type-registry-query', 1);
    expect(getRecentDetailedSamples()).toHaveLength(0);

    setDetailedRecordingEnabled(true);
    for (let round = 0; round < 510; round += 1) {
      recordLanguageServiceOperation('type-registry-query', 1);
    }
    expect(getRecentDetailedSamples().length).toBe(500);
    expect(getRecentDetailedSamples()[499]?.name).toBe('type-registry-query');
  });
});
