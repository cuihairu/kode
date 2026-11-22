// hotReloadScaleBounds 纯函数钉(主 unit 门;bench 文件不进门禁,界限解析进
// ——与 rebuildTailBounds.test.ts 同款隔离纪律:纯 resolver 钉在 unit,重测量
// 面(200→50k 文件真资产车道)只在 bench 车道跑)。
import { describe, expect, it } from 'vitest';

import { resolveScaleBounds, scaleViolations } from './hotReloadScaleBounds';

describe('hotReloadScaleBounds resolver(RUST-413 规模基准界)', () => {
  it('缺省=宽松上界表,首测 docs/perf/hot-re-load-scale-run.txt 四档推导', () => {
    const bounds = resolveScaleBounds({});
    expect(bounds.m1FilterPerEventMs).toBe(5);
    expect(bounds.m1AbsorbPerFileMs).toBe(5);
    expect(bounds.m1Absorb50kWallMs).toBe(45000);
    expect(bounds.m1ReadLatency50kP99Ms).toBe(40000);
    expect(bounds.m2SustainedWallMs).toBe(2000);
    expect(bounds.m2SaveToQueueP99Ms).toBe(50);
    expect(bounds.m3PreviewHoldWallMs).toBe(12000);
    expect(bounds.m3ReleasePreviewWallMs).toBe(10);
    expect(bounds.m4StormWallMs).toBe(12000);
    expect(bounds.m5Canonicalize100kMs).toBe(3000);
  });

  it('env 覆盖生效且不影响缺省表(每次解析独立)', () => {
    const bounds = resolveScaleBounds({
      KODE_HRS_BOUND_M1_ABSORB50K_WALL_MS: '60000',
      KODE_HRS_BOUND_M4_STORM_WALL_MS: '20000'
    });
    expect(bounds.m1Absorb50kWallMs).toBe(60000);
    expect(bounds.m4StormWallMs).toBe(20000);
    expect(bounds.m2SustainedWallMs).toBe(2000);
    expect(resolveScaleBounds({}).m1Absorb50kWallMs).toBe(45000);
  });

  it('非法/负/空值诚实回退缺省,不抛不猜', () => {
    const bounds = resolveScaleBounds({
      KODE_HRS_BOUND_M1_FILTER_PER_EVENT_MS: 'not-a-number',
      KODE_HRS_BOUND_M2_SUSTAINED_WALL_MS: '-1',
      KODE_HRS_BOUND_M5_CANONICALIZE100K_MS: ''
    });
    expect(bounds.m1FilterPerEventMs).toBe(5);
    expect(bounds.m2SustainedWallMs).toBe(2000);
    expect(bounds.m5Canonicalize100kMs).toBe(3000);
  });

  it('violation 比对:超界逐面报告,界内空清单,未观测面跳过', () => {
    const bounds = resolveScaleBounds({});
    expect(
      scaleViolations(bounds, {
        m2SustainedWallMs: 2000,
        m3ReleasePreviewWallMs: 10.01,
        m1Absorb50kWallMs: 46000
      })
    ).toEqual([
      'm1Absorb50kWallMs observed=46000 > bound=45000 (env KODE_HRS_BOUND_M1_ABSORB50K_WALL_MS)',
      'm3ReleasePreviewWallMs observed=10.01 > bound=10 (env KODE_HRS_BOUND_M3_RELEASE_PREVIEW_WALL_MS)'
    ]);
    expect(scaleViolations(bounds, {})).toEqual([]);
    // 边界=等值不过界(宽松上界语义:恰在界上不算回退)
    expect(scaleViolations(bounds, { m1FilterPerEventMs: 5 })).toEqual([]);
  });
});
