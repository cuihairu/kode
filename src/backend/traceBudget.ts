/**
 * KFLOW controlled-capture budget registry (FLOW-029): pre-registered capture
 * time/capacity/overhead budgets — the single source for the capture face's
 * defaults and hard caps; the run face (traceCaptureRun) and reports/tests
 * reference the same constants, never a second scattered copy.
 *
 * Acceptance text: "Pre-register capture time/capacity/overhead budgets; test
 * stop/disconnect/engine exit/dropped events/clock skew; report the actual
 * sampling boundary."
 *
 * Numeric basis (2026-11-14 measured on this machine, CPython 3.14.4,
 * scripts/trace/monitoring_capture.py + workload_loop.py, minimum of 3 runs):
 *   - per-event overhead 0.018-0.024ms (4012 events ~96ms / 40012 events ~714ms /
 *     100012 events ~1787ms, linear, no super-linearity);
 *   - see docs/perf/2026-11-14-kflow-029-capture-budget-and-overhead.md.
 * A budget = the measured value registered with headroom; exceeding the budget is
 * a report event, never a silent pass. Pure core with zero vscode dependencies;
 * the budget does not change the FLOW-025 red line (defaults to off / can be
 * turned off / bounded).
 */

export interface TraceCaptureBudget {
  /** Capacity default: the default buffer bound when a controlled capture is not given maxEvents explicitly */
  defaultMaxEvents: number;
  /** Capacity hard cap: even an explicit request must not exceed it (artifact size/overhead ceiling) */
  hardMaxEventsCap: number;
  /** Time default: the default timeout when a controlled capture is not given timeoutMs explicitly (ms) */
  defaultTimeoutMs: number;
  /** Time hard cap: even an explicit request must not exceed it (ms) */
  hardTimeoutMsCap: number;
  /** Overhead budget: the per-event capture overhead cap allowed (ms); measured ~0.02, the budget gives 2.5x headroom */
  overheadBudgetPerEventMs: number;
}

/** Pre-registered budget (single source; changing a value must sync the report docs/perf/kflow-029). */
export const TRACE_CAPTURE_BUDGET: TraceCaptureBudget = {
  defaultMaxEvents: 20000,
  hardMaxEventsCap: 200000,
  defaultTimeoutMs: 15000,
  hardTimeoutMsCap: 120000,
  overheadBudgetPerEventMs: 0.05
};

export interface CaptureBudgetInput {
  /** Explicit capacity request (defaults to default; over the hard cap is rejected) */
  maxEvents?: number;
  /** Explicit timeout request in ms (defaults to default; over the hard cap is rejected) */
  timeoutMs?: number;
}

export interface ResolvedCaptureBudget {
  maxEvents: number;
  timeoutMs: number;
}

/**
 * Resolve the effective budget: missing -> defaults to the default; invalid (not a
 * positive integer / not a positive number) is rejected; over the hard cap is
 * rejected (the error message carries the budget values so reports can trace back).
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

/** Budget summary (referenced directly by UI/reports). */
export function describeCaptureBudget(): string {
  const budget = TRACE_CAPTURE_BUDGET;
  return (
    `max-events 默认 ${budget.defaultMaxEvents}/硬顶 ${budget.hardMaxEventsCap};` +
    `timeout 默认 ${budget.defaultTimeoutMs}ms/硬顶 ${budget.hardTimeoutMsCap}ms;` +
    `每事件开销预算 ${budget.overheadBudgetPerEventMs}ms`
  );
}
