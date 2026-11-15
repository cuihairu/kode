/**
 * Rust 服务态门禁界(2026-11-15 用户审计 P1-3:「性能不过不得合并」未装配
 * Rust gate;perf-gate 只跑 TS bench,soak 只测 TS 侧)。独立纯函数模块——
 * gate bench(servingGate.bench.ts)与单测(servingBounds.test.ts)各自
 * import;绝不从 bench 文件 re-import(那会把真实二进制 serving suite 注册
 * 进主 unit 门,spawn+3000 文件镜像在单测里跑,灾难,与 gateBounds.ts 同款
 * 隔离纪律)。
 *
 * 缺省=宽松上界纪律(只捕数量级回退,不跨机器绝对值比较,PERF-015 同款);
 * 基线 docs/perf/serving-state-run.txt(本机 3000 def 档):
 *   spawn.start p99 13.8ms / mirror3000.total 64ms / steady 三面 p99
 *   1.07-4.48ms / editRoundTrip.diagnostic p99 6.84ms / rss.mirrorDeltaMb
 *   110 / rss.afterSteady 116MB。墙钟界取 ~10x 以上余量吸收共享 runner
 *   抖动;RSS 是最紧的界(memory 不像墙钟抖动,gateBounds 同口径 ~3x)。
 * 环境变量覆盖:KODE_SERVING_BOUND_*(SNAKE 大写),非法值诚实回退缺省,
 * 不抛不猜(与 resolveGateBounds 同语义)。
 */

export interface ServingGateBounds {
  spawnStartP99Ms: number;
  mirrorTotalMs: number;
  steadyCompletionP99Ms: number;
  steadyDefinitionP99Ms: number;
  steadyDiagnosticP99Ms: number;
  editRoundTripDiagnosticP99Ms: number;
  mirrorRssDeltaMb: number;
  steadyRssMb: number;
}

const BOUND_DEFAULTS: ServingGateBounds = {
  spawnStartP99Ms: 5000,
  mirrorTotalMs: 10000,
  steadyCompletionP99Ms: 15,
  steadyDefinitionP99Ms: 30,
  steadyDiagnosticP99Ms: 40,
  editRoundTripDiagnosticP99Ms: 60,
  mirrorRssDeltaMb: 300,
  steadyRssMb: 400
};

const boundEnvName = (key: string): string =>
  `KODE_SERVING_BOUND_${key.replace(/([A-Z])/g, '_$1').toUpperCase()}`;

/** 阈值解析纯函数(env 可注入,单测钉);非法值诚实回退缺省,不抛不猜 */
export function resolveServingBounds(
  env: Record<string, string | undefined> = process.env
): ServingGateBounds {
  const resolved = { ...BOUND_DEFAULTS };
  for (const key of Object.keys(BOUND_DEFAULTS) as (keyof ServingGateBounds)[]) {
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
export function servingGateViolations(
  bounds: ServingGateBounds,
  observed: Partial<Record<keyof ServingGateBounds, number>>
): string[] {
  const violations: string[] = [];
  for (const key of Object.keys(bounds) as (keyof ServingGateBounds)[]) {
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
