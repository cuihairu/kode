import { describe, expect, it } from 'vitest';
import { repeatStats } from './repeatStats';

// RUST-032 统计置信面钉:nearest-rank 百分位与 v02Baseline 同源约定,
// 区间/散布率/边界(单样本/空样本/median=0)可预测。

describe('repeatStats(KODE_PERF_REPEAT 置信面)', () => {
  it('奇数样本:median 取正中,p05/p95 按 nearest-rank', () => {
    // sorted: [1,2,3,4,5] p50=idx ceil(2.5)-1=2 →3;p05=ceil(0.25)-1=0 →1;
    // p95=ceil(4.75)-1=4 →5
    const stats = repeatStats([5, 1, 3, 2, 4]);
    expect(stats.n).toBe(5);
    expect(stats.median).toBe(3);
    expect(stats.p05).toBe(1);
    expect(stats.p95).toBe(5);
    expect(stats.min).toBe(1);
    expect(stats.max).toBe(5);
    expect(stats.spreadPct).toBe(round2(((5 - 1) / 3) * 100));
  });

  it('偶数样本:median 取上中位(nearest-rank 口径)', () => {
    // sorted: [10,20,30,40] p50=ceil(2)-1=1 →20
    const stats = repeatStats([40, 10, 30, 20]);
    expect(stats.median).toBe(20);
    // p95=ceil(3.8)-1=3 →40
    expect(stats.p95).toBe(40);
    // p05=ceil(0.2)-1=0 →10
    expect(stats.p05).toBe(10);
  });

  it('单样本:区间塌缩为该值,spreadPct=0', () => {
    const stats = repeatStats([7.5]);
    expect(stats).toEqual({ n: 1, median: 7.5, p05: 7.5, p95: 7.5, min: 7.5, max: 7.5, spreadPct: 0 });
  });

  it('空样本:诚实抛错(调用面不允许无样本汇总)', () => {
    expect(() => repeatStats([])).toThrow('repeatStats: no samples');
  });

  it('median=0:spreadPct 恒 0(除零诚实面,不产 Infinity)', () => {
    const stats = repeatStats([0, 0, 0]);
    expect(stats.median).toBe(0);
    expect(stats.spreadPct).toBe(0);
    expect(stats.max).toBe(0);
  });
});

const round2 = (value: number): number => Math.round(value * 100) / 100;
