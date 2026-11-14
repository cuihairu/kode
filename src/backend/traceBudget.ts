/**
 * KFLOW 受控采集预算登记处(FLOW-029):预登记采集时间/容量/开销预算——
 * 采集面的默认值与硬顶唯一出处,运行面(traceCaptureRun)与报告/测试引用
 * 同一常量,不散落第二处。
 *
 * 验收原文:「预登记采集时间/容量/开销预算,测停止/断连/引擎退出/丢事件/
 * 时钟偏差;报告实际采样边界。」
 *
 * 数值依据(2026-11-14 本机实测,CPython 3.14.4,scripts/trace/
 * monitoring_capture.py + workload_loop.py,3 次取最小):
 *   - 每事件开销 0.018-0.024ms(4012 事件 ~96ms/40012 事件 ~714ms/
 *     100012 事件 ~1787ms,线性无超线性);
 *   - 详见 docs/perf/2026-11-14-kflow-029-capture-budget-and-overhead.md。
 * 预算=实测值加裕量登记,超预算是报告事件不是静默通过。纯核心零 vscode
 * 依赖;预算不改变 FLOW-025 红线(默认关闭/可关闭/有界)。
 */

export interface TraceCaptureBudget {
  /** 容量默认:受控采集未显式给 maxEvents 时的缺省缓冲界 */
  defaultMaxEvents: number;
  /** 容量硬顶:显式请求也不得超过(工件体积/开销天花板) */
  hardMaxEventsCap: number;
  /** 时间默认:受控采集未显式给 timeoutMs 时的缺省超时(ms) */
  defaultTimeoutMs: number;
  /** 时间硬顶:显式请求也不得超过(ms) */
  hardTimeoutMsCap: number;
  /** 开销预算:每事件允许的采集开销上限(ms);实测约 0.02,预算给 2.5 倍裕量 */
  overheadBudgetPerEventMs: number;
}

/** 预登记预算(唯一出处;改值须同步报告 docs/perf/kflow-029)。 */
export const TRACE_CAPTURE_BUDGET: TraceCaptureBudget = {
  defaultMaxEvents: 20000,
  hardMaxEventsCap: 200000,
  defaultTimeoutMs: 15000,
  hardTimeoutMsCap: 120000,
  overheadBudgetPerEventMs: 0.05
};

export interface CaptureBudgetInput {
  /** 显式容量请求(缺省=default;超硬顶即拒) */
  maxEvents?: number;
  /** 显式超时请求 ms(缺省=default;超硬顶即拒) */
  timeoutMs?: number;
}

export interface ResolvedCaptureBudget {
  maxEvents: number;
  timeoutMs: number;
}

/**
 * 解析生效预算:缺省→默认;非法(非正整数/非正数)即拒;超硬顶即拒
 * (错误消息带预算值,报告可回查)。
 */
export function resolveCaptureBudgets(input: CaptureBudgetInput): ResolvedCaptureBudget {
  const maxEvents = input.maxEvents ?? TRACE_CAPTURE_BUDGET.defaultMaxEvents;
  if (!(Number.isInteger(maxEvents) && maxEvents > 0)) {
    throw new Error('受控采集必须有界:maxEvents 必须是正整数');
  }
  if (maxEvents > TRACE_CAPTURE_BUDGET.hardMaxEventsCap) {
    throw new Error(
      `受控采集容量超预算:maxEvents=${maxEvents} 超硬顶 ${TRACE_CAPTURE_BUDGET.hardMaxEventsCap}(预登记预算,详见 docs/perf/kflow-029)`
    );
  }
  const timeoutMs = input.timeoutMs ?? TRACE_CAPTURE_BUDGET.defaultTimeoutMs;
  if (!(timeoutMs > 0)) {
    throw new Error('受控采集必须可关闭:timeoutMs 必须 >0');
  }
  if (timeoutMs > TRACE_CAPTURE_BUDGET.hardTimeoutMsCap) {
    throw new Error(
      `受控采集时间超预算:timeoutMs=${timeoutMs} 超硬顶 ${TRACE_CAPTURE_BUDGET.hardTimeoutMsCap}(预登记预算,详见 docs/perf/kflow-029)`
    );
  }
  return { maxEvents, timeoutMs };
}

/** 预算摘要(UI/报告直接引用)。 */
export function describeCaptureBudget(): string {
  const budget = TRACE_CAPTURE_BUDGET;
  return (
    `max-events 默认 ${budget.defaultMaxEvents}/硬顶 ${budget.hardMaxEventsCap};` +
    `timeout 默认 ${budget.defaultTimeoutMs}ms/硬顶 ${budget.hardTimeoutMsCap}ms;` +
    `每事件开销预算 ${budget.overheadBudgetPerEventMs}ms`
  );
}
