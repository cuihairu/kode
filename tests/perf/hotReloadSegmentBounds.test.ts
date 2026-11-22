// hotReloadSegmentBounds 纯函数钉(主 unit 门;bench 文件不进门禁,界限解析进
// ——与 rebuildTailBounds.test.ts 同款隔离纪律:纯 resolver 钉在 unit,重测量
// 面(真资产 200 文件档)只在 bench 车道跑)。
import { describe, expect, it } from 'vitest';

import { resolveSegmentBounds, segmentViolations } from './hotReloadSegmentBounds';

describe('hotReloadSegmentBounds resolver(RUST-414 各段耗时界)', () => {
  it('缺省=宽松上界表,首测 docs/perf/hot-reload-segment-run.txt 两轮推导', () => {
    const bounds = resolveSegmentBounds({});
    expect(bounds.s1FilterP99Ms).toBe(20);
    expect(bounds.s2HashP99Ms).toBe(1500);
    expect(bounds.s3SyntaxP99Ms).toBe(50);
    expect(bounds.s4QueueP99Ms).toBe(400);
    expect(bounds.s4TotalCpuP99Ms).toBe(2000);
    expect(bounds.s6HashP99Ms).toBe(250);
    expect(bounds.s6SyntaxP99Ms).toBe(50);
    expect(bounds.s6QueueP99Ms).toBe(100);
    expect(bounds.s6TotalCpuP99Ms).toBe(250);
    expect(bounds.s7BurstFilterP99Ms).toBe(10);
    expect(bounds.s7BurstFilterWallMs).toBe(300);
    expect(bounds.s7BurstOfferWallMs).toBe(300);
    expect(bounds.s8LedgerP99Ms).toBe(100);
    expect(bounds.s8RenderP99Ms).toBe(1000);
  });

  it('env 覆盖生效且不影响缺省表(每次解析独立)', () => {
    const bounds = resolveSegmentBounds({
      KODE_SEG_BOUND_S2_HASH_P99_MS: '2500',
      KODE_SEG_BOUND_S7_BURST_FILTER_WALL_MS: '600'
    });
    expect(bounds.s2HashP99Ms).toBe(2500);
    expect(bounds.s7BurstFilterWallMs).toBe(600);
    expect(bounds.s1FilterP99Ms).toBe(20);
    expect(resolveSegmentBounds({}).s2HashP99Ms).toBe(1500);
  });

  it('非法/负/空值诚实回退缺省,不抛不猜', () => {
    const bounds = resolveSegmentBounds({
      KODE_SEG_BOUND_S1_FILTER_P99_MS: 'not-a-number',
      KODE_SEG_BOUND_S4_QUEUE_P99_MS: '-1',
      KODE_SEG_BOUND_S6_TOTAL_CPU_P99_MS: ''
    });
    expect(bounds.s1FilterP99Ms).toBe(20);
    expect(bounds.s4QueueP99Ms).toBe(400);
    expect(bounds.s6TotalCpuP99Ms).toBe(250);
  });

  it('violation 比对:超界逐面报告,界内空清单,未观测面跳过', () => {
    const bounds = resolveSegmentBounds({});
    expect(
      segmentViolations(bounds, {
        s2HashP99Ms: 1500,
        s4QueueP99Ms: 400.01,
        s6TotalCpuP99Ms: 251
      })
    ).toEqual([
      's4QueueP99Ms observed=400.01 > bound=400 (env KODE_SEG_BOUND_S4_QUEUE_P99_MS)',
      's6TotalCpuP99Ms observed=251 > bound=250 (env KODE_SEG_BOUND_S6_TOTAL_CPU_P99_MS)'
    ]);
    expect(segmentViolations(bounds, {})).toEqual([]);
    // 边界=等值不过界(宽松上界语义:恰在界上不算回退)
    expect(segmentViolations(bounds, { s1FilterP99Ms: 20 })).toEqual([]);
  });
});
