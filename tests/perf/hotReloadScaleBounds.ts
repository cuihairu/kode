/**
 * RUST-413(HR-QA-001)热更规模基准界:「基准定义:文件数 200/2k/10k/50k;单文件
 * 持续保存、Git checkout 500 文件、写入风暴、远端 SSH/workspace」的阈值化半
 * ——hotReloadScale.bench.ts(bench lane,不入主 unit 门)与单测
 * (hotReloadScaleBounds.test.ts)各自 import;绝不从 bench 文件 re-import
 * (与 rebuildTailBounds/servingBounds 同款隔离纪律)。
 *
 * 缺省=宽松上界纪律(只捕数量级回退,不跨机器绝对值比较,PERF-015 同款);
 * 基线 docs/perf/hot-reload-scale-run.txt(200/2k/10k/50k 四档):界值取记录
 * 更差者再留 ~10x 余量吸收共享 runner 抖动与 libuv 读盘排队方差(M1.absorb.
 * 50000.readLatency p99 3321.75ms 即 50k 档洪泛读盘排队,非事件循环阻塞)。
 *   诚实边界:远端 SSH/workspace 端到端(纯核无此面)不在本界表;M2.throughput
 *   是速率非成本(值越大越好),violations 只比上界故不纳入;M1 per-scale 动态
 *   键(200/2k/10k 档)以规模收敛面(perEvent/perFile,量级收敛)与最重档
 *   (50k)代表,中间档不重复设界。
 * 环境变量覆盖:KODE_HRS_BOUND_*(SNAKE 大写),非法值诚实回退缺省,不抛不猜。
 */

export interface ScaleBounds {
  /** M1 过滤扫描-逐事件成本(规模收敛面,最重档 0.01ms) */
  m1FilterPerEventMs: number;
  /** M1 流水线吸收-每文件成本(规模收敛面,200 档 0.18ms) */
  m1AbsorbPerFileMs: number;
  /** M1 50k 档吸收墙钟(4313.68ms=libuv 读盘排队,非事件循环阻塞) */
  m1Absorb50kWallMs: number;
  /** M1 50k 档读盘延迟 p99(3321.75ms,洪泛排队) */
  m1ReadLatency50kP99Ms: number;
  /** M2 持续保存 100 次-墙钟(180.56ms) */
  m2SustainedWallMs: number;
  /** M2 持续保存 100 次-Save→队列 p99(2.59ms,候选线 30ms 之下一个量级) */
  m2SaveToQueueP99Ms: number;
  /** M3 checkout 500 爆发-预览滞留墙钟(1038.57ms) */
  m3PreviewHoldWallMs: number;
  /** M3 checkout 500 爆发-放行墙钟(0.66ms) */
  m3ReleasePreviewWallMs: number;
  /** M4 写入风暴 100×(save+disk-change)-归并墙钟(1008.78ms) */
  m4StormWallMs: number;
  /** M5 远端路径规范化-10 万次(283.4ms,四形态键) */
  m5Canonicalize100kMs: number;
}

const BOUND_DEFAULTS: ScaleBounds = {
  m1FilterPerEventMs: 5,
  m1AbsorbPerFileMs: 5,
  m1Absorb50kWallMs: 45000,
  m1ReadLatency50kP99Ms: 40000,
  m2SustainedWallMs: 2000,
  m2SaveToQueueP99Ms: 50,
  m3PreviewHoldWallMs: 12000,
  m3ReleasePreviewWallMs: 10,
  m4StormWallMs: 12000,
  m5Canonicalize100kMs: 3000
};

const boundEnvName = (key: string): string =>
  `KODE_HRS_BOUND_${key.replace(/([A-Z])/g, '_$1').toUpperCase()}`;

/** 阈值解析纯函数(env 可注入,单测钉);非法值诚实回退缺省,不抛不猜 */
export function resolveScaleBounds(
  env: Record<string, string | undefined> = process.env
): ScaleBounds {
  const resolved = { ...BOUND_DEFAULTS };
  for (const key of Object.keys(BOUND_DEFAULTS) as (keyof ScaleBounds)[]) {
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
export function scaleViolations(
  bounds: ScaleBounds,
  observed: Partial<Record<keyof ScaleBounds, number>>
): string[] {
  const violations: string[] = [];
  for (const key of Object.keys(bounds) as (keyof ScaleBounds)[]) {
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
