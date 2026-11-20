// 阶段内细粒度扫描进度(WARM-VISIBILITY-004 刀 A,2026-11-20):
// 首扫阶段(entityMapping def 解析 / WorkspaceIndex 事件索引)在阶段内部
// 长时间无产出,状态栏「1/5 实体发现链」分钟级不动,用户无从区分工作中
// 与卡死。本模块 = 两个首扫环共用的节流上报器:
//   - 计数闸:距上次上报至少 SCAN_STAGE_PROGRESS_REPORT_EVERY 个文件才允许再报;
//   - 时间闸:距上次上报至少 SCAN_STAGE_PROGRESS_MIN_INTERVAL_MS 才允许再报
//     (首报例外:初始时间戳取 0,首个计数边界立即报出,起扫一秒内可见动静);
//   - 终报:finish() 恒发一条收尾(N/N),不受双闸约束。
// 常量与行为入契约测试(tests/scanStageProgress.test.ts):大仓不刷屏(上报
// 频率上限),进度条消息只增不减。上报面零字符串拼接开销:未过闸的 step
// 只做整数比较。
// (命名注:repo 已有 scanProgress.ts = SCAN-RESUME-001 扫描断点模块,本模块
// 与它无涉——那是「断在哪续扫」,这是「扫到哪给人看」。)

/** 计数闸:距上次上报至少多少个文件 */
export const SCAN_STAGE_PROGRESS_REPORT_EVERY = 10;

/** 时间闸:距上次上报至少多少毫秒 */
export const SCAN_STAGE_PROGRESS_MIN_INTERVAL_MS = 500;

/** 测试时钟注入(确定性断言:固定时钟下时间闸恒拦/恒放由测试自选) */
let testClock: (() => number) | null = null;

export function setScanStageProgressClockForTests(clock: (() => number) | null): void {
  testClock = clock;
}

const nowMs = (): number => (testClock ? testClock() : Date.now());

export interface ScanStageProgressReporter {
  /** 计数推进(count 个文件已处理);过双闸才真正上报 */
  step(count?: number): void;
  /** 收尾:恒上报一条最终进度(N/N),不受双闸约束 */
  finish(): void;
}

/**
 * label 例:「实体发现链 def」「事件/方法索引」→ 上报消息 `${label} ${done}/${total}`。
 * report 回调由调用方决定去向(warmup 在跑 = 状态栏 message;否则 no-op)。
 */
export function createScanStageProgressReporter(options: {
  label: string;
  total: number;
  report: (detail: string) => void;
}): ScanStageProgressReporter {
  let done = 0;
  let lastReportedAt = 0; // 初始 0:首个计数边界(第 EVERY 个文件)才首报
  let lastTime = 0; // 首报不受时间闸拦(起扫一秒内可见动静)
  const emit = (): void => {
    lastReportedAt = done;
    lastTime = nowMs();
    options.report(`${options.label} ${done}/${options.total}`);
  };
  return {
    step: (count = 1): void => {
      done += count;
      if (done - lastReportedAt >= SCAN_STAGE_PROGRESS_REPORT_EVERY && nowMs() - lastTime >= SCAN_STAGE_PROGRESS_MIN_INTERVAL_MS) {
        emit();
      }
    },
    finish: (): void => {
      // 终报恒发:进度条以 100% 收口,不因双闸拦在半程
      lastReportedAt = done;
      lastTime = nowMs();
      options.report(`${options.label} ${done}/${options.total}`);
    }
  };
}
