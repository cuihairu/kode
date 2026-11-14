/**
 * RUST-028 基线快照面:把 bench 内存里的 recordedMetrics 序列化成机器可读
 * 基线文件(schema kode-perf-baseline/1),nightly 每跑必产并上传产物(90 天)。
 * 原始记录仍是 docs/perf/v02-baseline-run.txt(提交在库,追加制);快照是
 * 同一次运行的结构化投影,供趋势提取与机器对比,不另设第二份手写真相。
 *
 * 独立纯函数模块——bench(v02Baseline.bench.ts)与单测(perfBaseline.test.ts)
 * 各自 import;绝不 import bench 文件本身(那会把整个基线 suite 注册进主
 * unit 门,30k 资产生成+全场景在单测里跑,灾难)。
 */

export interface PerfMetricSample {
  values: number[];
  unit: string;
}

/** bench recordedMetrics 的形状:场景 → 指标名 → 样本(Map 保插入序) */
export type RecordedMetrics = Map<string, Map<string, PerfMetricSample>>;

export interface PerfSnapshotMeta {
  createdAt: string;
  node: string;
  platform: string;
  cpus: number;
  largeFiles: number;
}

export interface PerfBaselineSnapshot extends PerfSnapshotMeta {
  schema: 'kode-perf-baseline/1';
  scenarios: Record<string, Record<string, PerfMetricSample>>;
}

/** 快照构建纯函数:Map 保序转普通对象,键序=插入序(JSON 文本稳定可 diff) */
export function buildBaselineSnapshot(
  recorded: RecordedMetrics,
  meta: PerfSnapshotMeta
): PerfBaselineSnapshot {
  const scenarios: Record<string, Record<string, PerfMetricSample>> = {};
  for (const [scenario, metrics] of recorded) {
    const bucket: Record<string, PerfMetricSample> = {};
    for (const [name, sample] of metrics) {
      bucket[name] = { values: sample.values, unit: sample.unit };
    }
    scenarios[scenario] = bucket;
  }
  return { schema: 'kode-perf-baseline/1', ...meta, scenarios };
}

/** 序列化纯函数:缩进 2 + 尾换行,人可 diff、机器可 parse */
export function serializeBaselineSnapshot(snapshot: PerfBaselineSnapshot): string {
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}
