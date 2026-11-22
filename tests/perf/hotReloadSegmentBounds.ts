/**
 * RUST-414(HR-QA-002)热更各段耗时界:「统计 Watch→过滤→哈希→语法检查→队列→
 * HTTP→回执→UI 各段耗时、P95/P99/max」的阈值化半——hotReloadSegment.bench.ts
 * (bench lane,不入主 unit 门)与单测(hotReloadSegmentBounds.test.ts)各自
 * import;绝不从 bench 文件 re-import(那会把 bench suite 注册进主 unit 门,
 * 与 rebuildTailBounds/servingBounds 同款隔离纪律)。
 *
 * 缺省=宽松上界纪律(只捕数量级回退,不跨机器绝对值比较,PERF-015 同款);
 * 基线 docs/perf/hot-reload-segment-run.txt(200 文件档,load1 16.06 与 58.75
 * 两轮):界值取两轮更差者再留 ~10x 余量吸收共享 runner 抖动与 libuv 读盘排队
 * 方差(同面 p99 在两轮间漂移 4.5x,S2.hash 28.89→129.1ms 即实例)。
 *   诚实边界:HTTP→回执→UI 三段属装配面(接线批 UI 区),本界表不含;网络耗时
 *   须单独统计不混本地性能(§19.10),本表只约束本地各段。
 * 环境变量覆盖:KODE_SEG_BOUND_*(SNAKE 大写),非法值诚实回退缺省,不抛不猜
 * (与 resolveRebuildTailBounds 同语义)。
 */

export interface SegmentBounds {
  /** S1 过滤段(Watch→isWatchableScriptFile 纯词法)p99 */
  s1FilterP99Ms: number;
  /** S2 哈希段(读盘+sha256,libuv 线程池)p99 */
  s2HashP99Ms: number;
  /** S3 语法检查段(透传闸=0ms 级)p99 */
  s3SyntaxP99Ms: number;
  /** S4 队列段(Save→定稿扣掉读盘与语法后的剩余)p99 */
  s4QueueP99Ms: number;
  /** S4 总 CPU(Save→定稿,pipeline 全链路)p99 */
  s4TotalCpuP99Ms: number;
  /** S6 单文件净成本-哈希(无竞争顺序段)p99 */
  s6HashP99Ms: number;
  /** S6 单文件净成本-语法(无竞争顺序段)p99 */
  s6SyntaxP99Ms: number;
  /** S6 单文件净成本-队列(无竞争顺序段)p99 */
  s6QueueP99Ms: number;
  /** S6 单文件净成本-总 CPU(无竞争顺序段)p99 */
  s6TotalCpuP99Ms: number;
  /** S7 500 事件 burst 同步段-逐事件过滤 p99(UI 不冻结纯核面) */
  s7BurstFilterP99Ms: number;
  /** S7 500 事件 burst 同步段-过滤扫描墙钟 */
  s7BurstFilterWallMs: number;
  /** S7 500 事件 burst 同步段-逐事件 offer 墙钟 */
  s7BurstOfferWallMs: number;
}

const BOUND_DEFAULTS: SegmentBounds = {
  s1FilterP99Ms: 20,
  s2HashP99Ms: 1500,
  s3SyntaxP99Ms: 50,
  s4QueueP99Ms: 400,
  s4TotalCpuP99Ms: 2000,
  s6HashP99Ms: 250,
  s6SyntaxP99Ms: 50,
  s6QueueP99Ms: 100,
  s6TotalCpuP99Ms: 250,
  s7BurstFilterP99Ms: 10,
  s7BurstFilterWallMs: 300,
  s7BurstOfferWallMs: 300
};

const boundEnvName = (key: string): string =>
  `KODE_SEG_BOUND_${key.replace(/([A-Z])/g, '_$1').toUpperCase()}`;

/** 阈值解析纯函数(env 可注入,单测钉);非法值诚实回退缺省,不抛不猜 */
export function resolveSegmentBounds(
  env: Record<string, string | undefined> = process.env
): SegmentBounds {
  const resolved = { ...BOUND_DEFAULTS };
  for (const key of Object.keys(BOUND_DEFAULTS) as (keyof SegmentBounds)[]) {
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
export function segmentViolations(
  bounds: SegmentBounds,
  observed: Partial<Record<keyof SegmentBounds, number>>
): string[] {
  const violations: string[] = [];
  for (const key of Object.keys(bounds) as (keyof SegmentBounds)[]) {
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
