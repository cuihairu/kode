/**
 * RUST-027 可配置回归阈值:门禁界的缺省表 + 环境变量覆盖解析。
 * 独立纯函数模块——bench(v02Baseline.bench.ts)与单测(gateBounds.test.ts)
 * 各自 import;绝不从 bench 文件 re-import(那会把整个基线 suite 注册进
 * 主 unit 门,30k 资产生成+全场景在单测里跑,灾难)。
 *
 * 缺省=宽松上界纪律(只捕数量级回退),基线 docs/perf/2026-11-04-v02-baseline.md:
 * 交互热态最坏 p99 14.5ms / max 26.7ms(墙钟界 ~7x/11x 余量,吸收共享 runner 抖动);
 * 全量 .py 扫描 10.4s(11.5x);扫描期 RSS 峰值 251-287MB、增量 +127.9MB(内存几乎
 * 无抖动,界收最紧 2.4~3.1x);激活期增量基线 0MB(有留存即异常)。
 */

export interface PerfGateBounds {
  warmP99Ms: number;
  warmMaxMs: number;
  activationWallMs: number;
  fullPyScanWallMs: number;
  scanPeakRssMb: number;
  scanPeakRssDeltaMb: number;
  activationPeakRssDeltaMb: number;
}

const BOUND_DEFAULTS: PerfGateBounds = {
  warmP99Ms: 100,
  // 2026-11-15 上调 300→1000:CI 共享 runner 上 100 样本的 max 单样本尾刺
  // 实测 406/541ms(p99 未违),max 作硬闸在慢 runner 上假阳;p99 闸(100ms)
  // 仍是数量级回退的主捕面,max 只留 ≥1s 的灾难级单点守卫。
  warmMaxMs: 1000,
  activationWallMs: 15000,
  fullPyScanWallMs: 120000,
  scanPeakRssMb: 700,
  scanPeakRssDeltaMb: 400,
  activationPeakRssDeltaMb: 200
};

const boundEnvName = (key: string): string =>
  `KODE_PERF_BOUND_${key.replace(/([A-Z])/g, '_$1').toUpperCase()}`;

/** 阈值解析纯函数(env 可注入,单测钉);非法值诚实回退缺省,不抛不猜 */
export function resolveGateBounds(
  env: Record<string, string | undefined> = process.env
): PerfGateBounds {
  const bounds = { ...BOUND_DEFAULTS };
  for (const key of Object.keys(BOUND_DEFAULTS) as Array<keyof PerfGateBounds>) {
    const raw = env[boundEnvName(key)];
    if (raw === undefined || raw === '') {
      continue;
    }
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) {
      bounds[key] = parsed;
    }
  }
  return bounds;
}
