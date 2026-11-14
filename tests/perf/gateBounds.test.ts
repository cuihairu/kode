import { describe, expect, it } from 'vitest';

// 只 import 纯函数模块,绝不 import v02Baseline.bench(会把整个基线 suite
// 注册进主 unit 门,30k 资产生成+全场景在单测里跑)
import { resolveGateBounds } from './gateBounds';

// RUST-027 可配置回归阈值:KODE_PERF_BOUND_* 环境变量覆盖门禁界;
// 非法/空值诚实回退缺省(不抛不猜),缺省=宽松上界表(hardware 基线 7-11x 余量)。

describe('perf 门禁阈值解析(RUST-027)', () => {
  it('无环境变量=全缺省宽松上界', () => {
    const bounds = resolveGateBounds({});
    expect(bounds).toEqual({
      warmP99Ms: 100,
      warmMaxMs: 300,
      activationWallMs: 15000,
      fullPyScanWallMs: 120000,
      scanPeakRssMb: 700,
      scanPeakRssDeltaMb: 400,
      activationPeakRssDeltaMb: 200
    });
  });

  it('KODE_PERF_BOUND_* 合法值逐项覆盖', () => {
    const bounds = resolveGateBounds({
      KODE_PERF_BOUND_WARM_P99_MS: '250',
      KODE_PERF_BOUND_WARM_MAX_MS: '600',
      KODE_PERF_BOUND_ACTIVATION_WALL_MS: '30000',
      KODE_PERF_BOUND_FULL_PY_SCAN_WALL_MS: '240000',
      KODE_PERF_BOUND_SCAN_PEAK_RSS_MB: '900',
      KODE_PERF_BOUND_SCAN_PEAK_RSS_DELTA_MB: '500',
      KODE_PERF_BOUND_ACTIVATION_PEAK_RSS_DELTA_MB: '300'
    });
    expect(bounds.warmP99Ms).toBe(250);
    expect(bounds.warmMaxMs).toBe(600);
    expect(bounds.activationWallMs).toBe(30000);
    expect(bounds.fullPyScanWallMs).toBe(240000);
    expect(bounds.scanPeakRssMb).toBe(900);
    expect(bounds.scanPeakRssDeltaMb).toBe(500);
    expect(bounds.activationPeakRssDeltaMb).toBe(300);
  });

  it('非法值(非数/负数/零/空串)诚实回退缺省,不抛不猜', () => {
    const bounds = resolveGateBounds({
      KODE_PERF_BOUND_WARM_P99_MS: 'not-a-number',
      KODE_PERF_BOUND_WARM_MAX_MS: '-5',
      KODE_PERF_BOUND_ACTIVATION_WALL_MS: '0',
      KODE_PERF_BOUND_FULL_PY_SCAN_WALL_MS: ''
    });
    expect(bounds.warmP99Ms).toBe(100);
    expect(bounds.warmMaxMs).toBe(300);
    expect(bounds.activationWallMs).toBe(15000);
    expect(bounds.fullPyScanWallMs).toBe(120000);
    // 其余未提及的键照常缺省
    expect(bounds.scanPeakRssMb).toBe(700);
  });
});
