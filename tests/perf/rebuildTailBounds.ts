/**
 * RUST-425 重建期 tail latency 界(HR-QA-013):「Rust Core 正在重建索引时
 * 热更新可继续工作，CPU/线程池/锁不可导致语言服务 tail latency 大幅恶化」。
 * 独立纯函数模块——hotReloadRebuildTail.bench.ts(真二进制车道)与单测
 * (rebuildTailBounds.test.ts)各自 import;绝不从 bench 文件 re-import
 * (那会把真二进制 rebuild suite 注册进主 unit 门,spawn+8500 文件镜像
 * 在单测里跑,灾难,与 servingBounds.ts 同款隔离纪律)。
 *
 * 缺省=宽松上界纪律(只捕数量级回退,不跨机器绝对值比较,PERF-015 同款);
 * 基线 docs/perf/hot-reload-rebuild-tail-run.txt(本机 500+8000 def 档):
 *   steady 三面 p99 / rebuild 三面 p99 / hotReloadFresh p99 /
 *   rebuildDrainTotal。墙钟界取 ~10x 以上余量吸收共享
 *   runner 抖动;语义命中面(内容新鲜度/零诊断/正例诊断)在 bench 硬断言,
 *   不在此界表。
 * 环境变量覆盖:KODE_REBUILD_BOUND_*(SNAKE 大写),非法值诚实回退缺省,
 * 不抛不猜(与 resolveServingBounds 同语义)。
 */

export interface RebuildTailBounds {
  /** 稳态(重建前)三面 serving p99:满语料热态,基线 p99 1-4.5ms */
  steadyCompletionP99Ms: number;
  steadyDefinitionP99Ms: number;
  steadyDiagnosticP99Ms: number;
  /** 重建期(索引队列深水)三面 serving p99:基线 p99 实测记录,取 ~10x 余量 */
  rebuildCompletionP99Ms: number;
  rebuildDefinitionP99Ms: number;
  rebuildDiagnosticP99Ms: number;
  /** 重建期 hot reload(didChange 新属性)后补全面反映新内容的 p99 */
  hotReloadFreshCompletionP99Ms: number;
  /** 重建全量排空墙钟(洪泛起点 → ingest.queued 归零)。观测面:bench 只
   *  once 记录不喂 violations——排空速率被 scheduler pick_next 全队列重排
   *  O(q log q) 拖成 O(n²)(8000 档 15s 不排空),属排空吞吐非 RUST-425
   *  判定面;界值留作 O(n²) 修复后的回补门。 */
  rebuildDrainTotalMs: number;
}

const BOUND_DEFAULTS: RebuildTailBounds = {
  steadyCompletionP99Ms: 30,
  steadyDefinitionP99Ms: 40,
  steadyDiagnosticP99Ms: 50,
  rebuildCompletionP99Ms: 120,
  rebuildDefinitionP99Ms: 120,
  rebuildDiagnosticP99Ms: 150,
  hotReloadFreshCompletionP99Ms: 120,
  rebuildDrainTotalMs: 30000,
};

const boundEnvName = (key: string): string =>
  `KODE_REBUILD_BOUND_${key.replace(/([A-Z])/g, '_$1').toUpperCase()}`;

/** 阈值解析纯函数(env 可注入,单测钉);非法值诚实回退缺省,不抛不猜 */
export function resolveRebuildTailBounds(
  env: Record<string, string | undefined> = process.env
): RebuildTailBounds {
  const resolved = { ...BOUND_DEFAULTS };
  for (const key of Object.keys(BOUND_DEFAULTS) as (keyof RebuildTailBounds)[]) {
    const raw = env[boundEnvName(key)];
    if (raw === undefined || raw === '') {
      continue;
    }
    const value = Number(raw);
    if (Number.isFinite(value) && value > 0) {
      resolved[key] = value;
    }
  }
  return resolved;
}

/** 逐面比对,返回违规清单(空=过门);bench 侧 expect(violations).toEqual([]) */
export function rebuildTailViolations(
  bounds: RebuildTailBounds,
  observed: Partial<Record<keyof RebuildTailBounds, number>>
): string[] {
  const violations: string[] = [];
  for (const key of Object.keys(bounds) as (keyof RebuildTailBounds)[]) {
    const value = observed[key];
    if (value === undefined) {
      continue;
    }
    if (value > bounds[key]) {
      violations.push(
        `${key} observed=${value} > bound=${bounds[key]} (env ${boundEnvName(key)})`
      );
    }
  }
  return violations;
}
