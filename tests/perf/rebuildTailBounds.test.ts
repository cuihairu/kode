// rebuildTailBounds 纯函数钉(主 unit 门;bench 文件不进门禁,界限解析进——
// 与 servingBounds.test.ts 同款隔离纪律:纯 resolver 钉在 unit,重测量面
// (真二进制 rebuild 车道)只在 bench 车道跑)。
import { describe, expect, it } from 'vitest';

import { rebuildTailViolations, resolveRebuildTailBounds } from './rebuildTailBounds';

describe('rebuildTailBounds resolver(RUST-425 重建期 tail latency 界)', () => {
  it('缺省=宽松上界表,首测 docs/perf/hot-reload-rebuild-tail-run.txt 推导', () => {
    const bounds = resolveRebuildTailBounds({});
    expect(bounds.steadyCompletionP99Ms).toBe(30);
    expect(bounds.steadyDefinitionP99Ms).toBe(40);
    expect(bounds.steadyDiagnosticP99Ms).toBe(50);
    expect(bounds.rebuildCompletionP99Ms).toBe(120);
    expect(bounds.rebuildDefinitionP99Ms).toBe(120);
    expect(bounds.rebuildDiagnosticP99Ms).toBe(150);
    expect(bounds.hotReloadFreshCompletionP99Ms).toBe(120);
    expect(bounds.rebuildDrainTotalMs).toBe(30000);
  });

  it('env 覆盖生效且不影响缺省表(每次解析独立)', () => {
    const bounds = resolveRebuildTailBounds({
      KODE_REBUILD_BOUND_REBUILD_DEFINITION_P99_MS: '250',
      KODE_REBUILD_BOUND_REBUILD_DRAIN_TOTAL_MS: '60000'
    });
    expect(bounds.rebuildDefinitionP99Ms).toBe(250);
    expect(bounds.rebuildDrainTotalMs).toBe(60000);
    expect(bounds.rebuildCompletionP99Ms).toBe(120);
    expect(resolveRebuildTailBounds({}).rebuildDefinitionP99Ms).toBe(120);
  });

  it('非法/负/空值诚实回退缺省,不抛不猜', () => {
    const bounds = resolveRebuildTailBounds({
      KODE_REBUILD_BOUND_STEADY_COMPLETION_P99_MS: 'not-a-number',
      KODE_REBUILD_BOUND_REBUILD_DIAGNOSTIC_P99_MS: '-1',
      KODE_REBUILD_BOUND_HOT_RELOAD_FRESH_COMPLETION_P99_MS: ''
    });
    expect(bounds.steadyCompletionP99Ms).toBe(30);
    expect(bounds.rebuildDiagnosticP99Ms).toBe(150);
    expect(bounds.hotReloadFreshCompletionP99Ms).toBe(120);
  });

  it('violation 比对:超界逐面报告,界内空清单,未观测面跳过', () => {
    const bounds = resolveRebuildTailBounds({});
    expect(
      rebuildTailViolations(bounds, {
        rebuildDefinitionP99Ms: 120,
        rebuildDiagnosticP99Ms: 150.01,
        rebuildDrainTotalMs: 31000
      })
    ).toEqual([
      'rebuildDiagnosticP99Ms observed=150.01 > bound=150 (env KODE_REBUILD_BOUND_REBUILD_DIAGNOSTIC_P99_MS)',
      'rebuildDrainTotalMs observed=31000 > bound=30000 (env KODE_REBUILD_BOUND_REBUILD_DRAIN_TOTAL_MS)'
    ]);
    expect(rebuildTailViolations(bounds, {})).toEqual([]);
    // 边界=等值不过界(宽松上界语义:恰在界上不算回退)
    expect(rebuildTailViolations(bounds, { steadyDefinitionP99Ms: 40 })).toEqual([]);
  });
});
