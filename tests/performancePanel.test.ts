import { describe, expect, it } from 'vitest';
import {
  renderPerformancePanelReport,
  slowRequestSuggestion,
  type PerformanceLatencyRow,
  type PerformancePanelInputs
} from '../src/backend/performancePanel';

// RUST-220(旧 UI-003)性能面板纯核:五段固定(队列→索引生成→缓存→主要慢请求
// →处理建议),快照式渲染(与 showSummary/showActiveTasks 同模式)。数据面全部
// 复用既有源;诚实边界=count=0 的空窗口行不进慢请求榜(分位数是空窗口产物
// 不冒充);建议=阈值映射既有取证入口(CPU profile/[kode-lsm]/detailed 开关),
// 不发明新诊断。

function row(overrides: Partial<PerformanceLatencyRow>): PerformanceLatencyRow {
  return { name: 'hover', count: 10, p50Ms: 5, p95Ms: 20, p99Ms: 40, maxMs: 60, cacheHitRate: 80, ...overrides };
}

function baseInputs(latencies: PerformanceLatencyRow[]): PerformancePanelInputs {
  return {
    queue: {
      diagnosticsQueued: 2,
      diagnosticsInFlight: 1,
      indexQueued: 3,
      indexRunning: true,
      indexFailed: 1,
      indexCompleted: 40,
      indexCancelled: 2,
      indexQueuedByPriority: { 10: 2, 5: 1 }
    },
    index: {
      mergedTasks: 7,
      staleDropped: 4,
      postponedBackground: 9,
      backgroundDelayMs: 120,
      recoveries: 3
    },
    caches: {
      parsedDocuments: { entries: 64, maxEntries: 256, bytes: 1024, maxBytes: 4096 },
      databaseSchemas: { entries: 8, capacity: 128 },
      annotationIndex: { entries: 12, ttlMs: 300000 }
    },
    latencies
  };
}

describe('renderPerformancePanelReport (RUST-220)', () => {
  it('五段固定齐备,队列段带诊断/索引计数与优先级分布', () => {
    const report = renderPerformancePanelReport(baseInputs([row({})]));
    expect(report).toContain('## 队列');
    expect(report).toContain('## 索引生成');
    expect(report).toContain('## 缓存');
    expect(report).toContain('## 主要慢请求');
    expect(report).toContain('## 处理建议');
    expect(report).toContain('排队 2 / 在途 1');
    expect(report).toContain('排队 3(运行中)');
    expect(report).toContain('p5=1 p10=2');
  });

  it('索引生成段带 metrics 五项,缓存段带三 gauge 与容量占比', () => {
    const report = renderPerformancePanelReport(baseInputs([row({})]));
    expect(report).toContain('合并去重 7 / 过期丢弃 4 / 交互推迟 9(累计让出 120ms) / 失败恢复 3');
    expect(report).toContain('解析文档缓存: 64/256 条 (25% 容量)');
    expect(report).toContain('数据库 schema 缓存: 8/128 条 (6% 容量)');
    expect(report).toContain('返回注解索引: 12 条 (TTL 300000ms)');
  });

  it('主要慢请求按 P99 降序取前 5,空窗口行(count=0)不进榜', () => {
    const report = renderPerformancePanelReport(baseInputs([
      row({ name: 'hover', p99Ms: 40, count: 10 }),
      row({ name: 'definition', p99Ms: 900, count: 3 }),
      row({ name: 'diagnostics', p99Ms: 1500, count: 0 }),
      row({ name: 'completion', p99Ms: 120, count: 7 })
    ]));
    const slowSection = report.split('## 主要慢请求')[1].split('## 处理建议')[0];
    const hoverIdx = slowSection.indexOf('hover');
    const defIdx = slowSection.indexOf('definition');
    const completionIdx = slowSection.indexOf('completion');
    expect(hoverIdx).toBeGreaterThan(-1);
    expect(defIdx).toBeGreaterThan(-1);
    expect(completionIdx).toBeGreaterThan(-1);
    // P99 降序:definition 900 > completion 120 > hover 40
    expect(defIdx).toBeLessThan(completionIdx);
    expect(completionIdx).toBeLessThan(hoverIdx);
    expect(slowSection).not.toContain('diagnostics');
  });

  it('无采样数据如实说明,不编造榜单', () => {
    const report = renderPerformancePanelReport(baseInputs([]));
    expect(report).toContain('(无采样数据;语言服务运转后自然积累)');
    expect(report).toContain('尚无采样数据,无建议。');
  });

  it('建议段:超阈值行映射取证入口,全低速零打扰', () => {
    const hot = renderPerformancePanelReport(baseInputs([row({ name: 'hover', p99Ms: 1200 })]));
    expect(hot).toContain('hover: 建议卡顿取证 kbengine.metrics.startCpuProfile');
    const warm = renderPerformancePanelReport(baseInputs([row({ name: 'completion', p99Ms: 300 })]));
    expect(warm).toContain('completion: 观察下方索引队列与缓存命中率');
    const cool = renderPerformancePanelReport(baseInputs([row({ p99Ms: 90 })]));
    expect(cool).toContain('无异常慢请求(各操作族 P99 均 ≤200ms),零打扰。');
  });
});

describe('slowRequestSuggestion 阈值映射 (RUST-220)', () => {
  it('p99>1000 → 卡顿取证入口;p99>200 → 观察面;其余 null', () => {
    expect(slowRequestSuggestion(row({ p99Ms: 1001 }))).toContain('startCpuProfile');
    expect(slowRequestSuggestion(row({ p99Ms: 201 }))).toContain('metrics.detailed');
    expect(slowRequestSuggestion(row({ p99Ms: 200 }))).toBeNull();
  });
});
