// servingBounds 纯函数钉(主 unit 门;bench 文件不进门禁,界限解析进——
// 与 gateBounds.test.ts 同款隔离纪律:纯 resolver 钉在 unit,重测量面只
// 在 bench 车道)。
import { describe, expect, it } from 'vitest';

import { resolveServingBounds, servingGateViolations } from './servingBounds';

describe('servingBounds resolver(Rust 服务态门禁界)', () => {
  it('缺省=宽松上界表,基线 serving-state-run.txt 推导', () => {
    const bounds = resolveServingBounds({});
    expect(bounds.spawnStartP99Ms).toBe(5000);
    expect(bounds.mirrorTotalMs).toBe(10000);
    expect(bounds.steadyCompletionP99Ms).toBe(15);
    expect(bounds.steadyDefinitionP99Ms).toBe(30);
    expect(bounds.steadyDiagnosticP99Ms).toBe(40);
    expect(bounds.editRoundTripDiagnosticP99Ms).toBe(60);
    expect(bounds.mirrorRssDeltaMb).toBe(300);
    expect(bounds.steadyRssMb).toBe(400);
  });

  it('env 覆盖生效且不影响缺省表(每次解析独立)', () => {
    const bounds = resolveServingBounds({
      KODE_SERVING_BOUND_STEADY_COMPLETION_P99_MS: '25',
      KODE_SERVING_BOUND_MIRROR_RSS_DELTA_MB: '500'
    });
    expect(bounds.steadyCompletionP99Ms).toBe(25);
    expect(bounds.mirrorRssDeltaMb).toBe(500);
    expect(bounds.steadyDiagnosticP99Ms).toBe(40);
    expect(resolveServingBounds({}).steadyCompletionP99Ms).toBe(15);
  });

  it('非法/负/空值诚实回退缺省,不抛不猜', () => {
    const bounds = resolveServingBounds({
      KODE_SERVING_BOUND_SPAWN_START_P99_MS: 'not-a-number',
      KODE_SERVING_BOUND_MIRROR_TOTAL_MS: '-1',
      KODE_SERVING_BOUND_STEADY_RSS_MB: ''
    });
    expect(bounds.spawnStartP99Ms).toBe(5000);
    expect(bounds.mirrorTotalMs).toBe(10000);
    expect(bounds.steadyRssMb).toBe(400);
  });

  it('violation 比对:超界逐面报告,界内空清单,未观测面跳过', () => {
    const bounds = resolveServingBounds({});
    expect(
      servingGateViolations(bounds, {
        steadyCompletionP99Ms: 15,
        steadyDiagnosticP99Ms: 40.01,
        mirrorRssDeltaMb: 300.5
      })
    ).toEqual([
      'steadyDiagnosticP99Ms observed=40.01 > bound=40 (env KODE_SERVING_BOUND_STEADY_DIAGNOSTIC_P99_MS)',
      'mirrorRssDeltaMb observed=300.5 > bound=300 (env KODE_SERVING_BOUND_MIRROR_RSS_DELTA_MB)'
    ]);
    expect(servingGateViolations(bounds, {})).toEqual([]);
    // 边界=等值不过界(宽松上界语义:恰在界上不算回退)
    expect(servingGateViolations(bounds, { steadyDefinitionP99Ms: 30 })).toEqual([]);
  });
});
