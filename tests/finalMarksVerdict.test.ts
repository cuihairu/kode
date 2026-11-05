import { describe, expect, it } from 'vitest';

import {
  evaluateFinalMarks,
  pooledP95,
  type BurstRun
} from '../src/finalMarksVerdict';

// IDE-AUD-020:让延迟越界真正导致最终验收失败——hoverPass 与 definitionPass
// 分别断言,注入可控延迟证明两者独立失败;采样/宿主争用处理预先规定:
// ①P95=按预登记争用闸(startLoad1 ≤ loadLimit)纳入的突发样本池化计算,
//   不是「三轮最优值」事后择优冒充总体;
// ②被争用闸排除的突发必须留痕(excluded),不是静默丢弃;
// ③全被排除=not-assessed(未测),失败/未测保留开放,不冒充通过。

const burst = (p95Ms: number, startLoad1 = 1): BurstRun => {
  // 30 样本构造:28 个 (p95-1) + 2 个 p95 → 升序 index=floor(0.95*30)=28 恰为 p95
  const samples = [...Array(28).fill(Math.max(0, p95Ms - 1)), p95Ms, p95Ms];
  return { samples, p95Ms, hits: 30, reps: 30, startLoad1 };
};

const POLICY = { hoverBoundMs: 30, definitionBoundMs: 50, loadLimit: 16 };

describe('IDE-AUD-020 延迟门槛独立判定与预登记采样口径', () => {
  it('P95 池化:全样本按序取分位,不是取每轮最优', () => {
    // 两轮 [10..39] 池化 60 样本:index=floor(0.95*60)=57,升序第 57 位=10+28=38
    const samples = [...Array(30).keys()].map(i => 10 + i);
    const pooled = pooledP95([...samples, ...samples]);
    expect(pooled).toBe(38);
    // 与「挑轮取最优」可区分:加入一轮慢样本后,池化结果被整体抬高,
    // 而最优口径仍会拿第一轮的 38
    const asymmetric = pooledP95([...samples, ...samples.map(v => v + 50)]);
    expect(asymmetric).toBeGreaterThan(pooled);
  });

  it('hover 越界而 definition 达标:hover 失败,definition 独立通过(可控延迟注入)', () => {
    const verdict = evaluateFinalMarks(
      [burst(80), burst(80), burst(80)],
      [burst(10), burst(10), burst(10)],
      POLICY
    );
    expect(verdict.hover.pass).toBe(false);
    expect(verdict.hover.reason).toContain('P95');
    expect(verdict.definition.pass).toBe(true);
  });

  it('definition 越界而 hover 达标:definition 失败,hover 独立通过', () => {
    const verdict = evaluateFinalMarks(
      [burst(5), burst(5), burst(5)],
      [burst(120), burst(120), burst(120)],
      POLICY
    );
    expect(verdict.hover.pass).toBe(true);
    expect(verdict.definition.pass).toBe(false);
    expect(verdict.definition.reason).toContain('P95');
  });

  it('两者都越界:两个指标各自失败,不互相兜底', () => {
    const verdict = evaluateFinalMarks(
      [burst(99)],
      [burst(199)],
      POLICY
    );
    expect(verdict.hover.pass).toBe(false);
    expect(verdict.definition.pass).toBe(false);
  });

  it('非全命中:命中缺口直接失败,哪怕 P95 很低', () => {
    const verdict = evaluateFinalMarks(
      [{ samples: [1, 1, 1], p95Ms: 1, hits: 29, reps: 30, startLoad1: 1 }],
      [burst(1)],
      POLICY
    );
    expect(verdict.hover.pass).toBe(false);
    expect(verdict.hover.reason).toContain('命中');
  });

  it('预登记争用闸:超载起点样本不入池化,但必须留痕不静默丢', () => {
    const verdict = evaluateFinalMarks(
      [burst(5, 1), burst(400, 32), burst(6, 2)],
      [burst(8, 1)],
      POLICY
    );
    // 池化只含 startLoad1≤16 的两轮(5、6),400 那轮被闸排除且留痕
    expect(verdict.hover.pooledP95Ms).toBeGreaterThanOrEqual(5);
    expect(verdict.hover.pooledP95Ms).toBeLessThanOrEqual(6);
    expect(verdict.hover.excluded).toHaveLength(1);
    expect(verdict.hover.excluded[0].p95Ms).toBe(400);
    expect(verdict.hover.pass).toBe(true);
  });

  it('全部突发被争用闸排除:not-assessed(未测),不冒充通过', () => {
    const verdict = evaluateFinalMarks(
      [burst(5, 40), burst(5, 48)],
      [burst(8, 1)],
      POLICY
    );
    expect(verdict.hover.verdict).toBe('not-assessed');
    expect(verdict.hover.pass).toBe(false);
    expect(verdict.hover.reason).toContain('争用');
    expect(verdict.definition.verdict).toBe('assessed');
  });

  it('池内 P95 越界即失败:排除争用样本也不能把越界洗成通过', () => {
    const verdict = evaluateFinalMarks(
      [burst(80, 1), burst(400, 32)],
      [burst(8, 1)],
      POLICY
    );
    expect(verdict.hover.verdict).toBe('assessed');
    expect(verdict.hover.pass).toBe(false);
    expect(verdict.hover.excluded).toHaveLength(1);
  });
});
