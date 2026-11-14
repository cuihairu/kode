/**
 * RUST-032 统计置信面(KODE_PERF_REPEAT):同一场景重复 R 跑后,把每次跑的
 * 代表值(如热态 p50)收成样本序列,给出中位数与散布区间——固定基准机纪律
 * 下,主报告引用「区间」而不是单跑读数;散布本身只观测,不做门禁硬闸
 * (跨机器绝对比较依旧禁止,PERF-015 口径不变)。
 *
 * 百分位约定与 v02Baseline.bench 的 percentile 同源:nearest-rank
 * (ceil(rank*n)-1),保证两处读数可互相对照。
 */

export interface RepeatStats {
  /** 样本数(=重复次数 R) */
  n: number;
  /** 中位数(nearest-rank p50) */
  median: number;
  /** p05(区间下沿参考) */
  p05: number;
  /** p95(区间上沿参考) */
  p95: number;
  min: number;
  max: number;
  /** 散布率:(max-min)/median×100,%;median 为 0 时恒 0(除零诚实面) */
  spreadPct: number;
}

const round2 = (value: number): number => Math.round(value * 100) / 100;

const percentile = (sorted: number[], rank: number): number => {
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(rank * sorted.length) - 1));
  return sorted[index];
};

export function repeatStats(samples: number[]): RepeatStats {
  if (samples.length === 0) {
    throw new Error('repeatStats: no samples');
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const median = percentile(sorted, 0.5);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  return {
    n: sorted.length,
    median: round2(median),
    p05: round2(percentile(sorted, 0.05)),
    p95: round2(percentile(sorted, 0.95)),
    min: round2(min),
    max: round2(max),
    spreadPct: median === 0 ? 0 : round2(((max - min) / median) * 100)
  };
}
