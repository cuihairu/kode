/**
 * 最终验收延迟判定(IDE-AUD-020):hoverPass 与 definitionPass 各自独立
 * 判定,预登记采样口径——2026-10-30 深审 F17 反例:旧套件把算出的 pass
 * 只写日志,末尾只断言命中次数,延迟越界不会导致失败;「三轮最优 P95」
 * 事后择优冒充总体 P95。
 *
 * 预登记口径(不是事后可调旋钮):
 * 1. 争用闸:每个突发在开始时采样宿主 1 分钟负载(startLoad1),超过
 *    loadLimit(预登记,按宿主核数定)的突发不入池化——排除必须留痕
 *    (excluded 数组),不是静默丢弃;
 * 2. P95=纳入突发的样本池化分位(总体口径),不是每轮最优;
 * 3. 判定:命中必须全满,池化 P95 ≤ 门槛;无可用突发(全被闸排除)=
 *    not-assessed(未测),失败/未测保留开放,不冒充通过;
 * 4. hover 与 definition 两指标完全独立,任一失败即整体失败,不互相兜底。
 *
 * 纯函数零依赖,单测可注入任意延迟序列证明独立失败(真机套件喂真实采样)。
 */

export interface BurstRun {
  /** 本突发原始延迟样本(ms,池化用) */
  samples: number[];
  /** 本突发 P95(=samples 的 95 分位,证据行直接引用) */
  p95Ms: number;
  /** 本突发 P50(证据行用,判定不读它) */
  p50Ms?: number;
  /** 本突发最大延迟(证据行用,判定不读它) */
  maxMs?: number;
  /** 命中次数 */
  hits: number;
  /** 突发请求数 */
  reps: number;
  /** 突发开始时宿主 1 分钟负载(争用闸采样点) */
  startLoad1: number;
}

export interface FinalMarksPolicy {
  hoverBoundMs: number;
  definitionBoundMs: number;
  /** 争用闸:突发开始 1 分钟负载超过它则该突发不入池化(预登记) */
  loadLimit: number;
}

export interface MetricVerdict {
  verdict: 'assessed' | 'not-assessed';
  pass: boolean;
  /** 失败原因(pass=true 时空串) */
  reason: string;
  /** 纳入池化的 P95(总体口径;not-assessed 时 null) */
  pooledP95Ms: number | null;
  /** 被争用闸排除的突发(留痕,不静默丢) */
  excluded: BurstRun[];
  hitsOk: boolean;
}

export function pooledP95(samples: number[]): number {
  if (samples.length === 0) {
    return NaN;
  }
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(0.95 * sorted.length))];
}

function evaluateMetric(
  bursts: BurstRun[],
  boundMs: number,
  label: string,
  policy: FinalMarksPolicy
): MetricVerdict {
  const included = bursts.filter(burst => burst.startLoad1 <= policy.loadLimit);
  const excluded = bursts.filter(burst => burst.startLoad1 > policy.loadLimit);
  const hitsOk = included.length > 0 && included.every(burst => burst.hits === burst.reps);
  if (included.length === 0) {
    return {
      verdict: 'not-assessed',
      pass: false,
      reason: `${label}:全部突发被争用闸排除(startLoad1>${policy.loadLimit}),未测保留开放`,
      pooledP95Ms: null,
      excluded,
      hitsOk
    };
  }
  const pooled = pooledP95(included.flatMap(burst => burst.samples));
  if (!hitsOk) {
    const miss = included.find(burst => burst.hits !== burst.reps)!;
    return {
      verdict: 'assessed',
      pass: false,
      reason: `${label}:命中 ${miss.hits}/${miss.reps}(非全命中)`,
      pooledP95Ms: pooled,
      excluded,
      hitsOk
    };
  }
  if (pooled > boundMs) {
    return {
      verdict: 'assessed',
      pass: false,
      reason: `${label}:池化 P95 ${pooled.toFixed(3)}ms 超门槛 ${boundMs}ms`,
      pooledP95Ms: pooled,
      excluded,
      hitsOk
    };
  }
  return {
    verdict: 'assessed',
    pass: true,
    reason: '',
    pooledP95Ms: pooled,
    excluded,
    hitsOk
  };
}

export function evaluateFinalMarks(
  hoverBursts: BurstRun[],
  definitionBursts: BurstRun[],
  policy: FinalMarksPolicy
): { hover: MetricVerdict; definition: MetricVerdict } {
  return {
    hover: evaluateMetric(hoverBursts, policy.hoverBoundMs, 'hover', policy),
    definition: evaluateMetric(definitionBursts, policy.definitionBoundMs, 'definition', policy)
  };
}
