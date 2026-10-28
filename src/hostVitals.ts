// IDE-MET-005:扩展宿主事件循环延迟采集,统一为毫秒。验收口径:输出写明
// 原始单位与采样窗口——perf_hooks.monitorEventLoopDelay 的直方图原生单位
// 是纳秒,任何报告面都必须显式声明「raw unit: nanoseconds」并把 ms 值按
// 1e6 换算后另行列出,纳秒数字绝不直接贴上 ms 标签。渲染是纯函数
// (renderEventLoopDelayReport),真实监视器只负责启停与窗口记账。

import { monitorEventLoopDelay, performance } from 'perf_hooks';

type EventLoopDelayMonitor = ReturnType<typeof monitorEventLoopDelay>;

/** 测试灌注面:perf_hooks 直方图的形状子集 */
export interface EventLoopDelayHistogramLike {
  mean: number;
  min: number;
  max: number;
  /** 部分 @types/node 的 IntervalHistogram 未声明 stdDev;运行时恒在 */
  stdDev?: number;
  count: number;
  percentile(percentile: number): number;
}

/** 直方图原生单位是纳秒;换算到毫秒只做一次除法,不叠加任何魔法数 */
const NS_PER_MS = 1e6;

const round1 = (value: number): number => Math.round(value * 10) / 10;

/** 渲染延迟报告:窗口/分辨率/样本数在前,ms 换算值与原始纳秒值并列可对账 */
export function renderEventLoopDelayReport(
  histogram: EventLoopDelayHistogramLike | null,
  windowMs: number,
  resolutionMs: number
): string {
  if (!histogram) {
    return 'event loop delay: not started\n';
  }
  const toMs = (nanoseconds: number): number => round1(nanoseconds / NS_PER_MS);
  return [
    `event loop delay (perf_hooks.monitorEventLoopDelay; raw unit: nanoseconds → values below in ms)`,
    `  window: ${(windowMs / 1000).toFixed(1)}s (resolution ${resolutionMs}ms, samples ${histogram.count})`,
    `  ms: mean=${toMs(histogram.mean)} min=${toMs(histogram.min)} ` +
      `p50=${toMs(histogram.percentile(50))} p99=${toMs(histogram.percentile(99))} ` +
      `max=${toMs(histogram.max)} stdDev=${toMs(histogram.stdDev ?? 0)}`,
    `  raw nanoseconds: mean=${histogram.mean} max=${histogram.max}`
  ].join('\n') + '\n';
}

const RESOLUTION_MS = 10;

let monitor: EventLoopDelayMonitor | null = null;
let windowStartPerfMs = 0;

/** 幂等启动:已在采样时重复调用不重置窗口(窗口长度即报告对账基线) */
export function startEventLoopDelayMonitor(): void {
  if (monitor) {
    return;
  }
  monitor = monitorEventLoopDelay({ resolution: RESOLUTION_MS });
  monitor.enable();
  windowStartPerfMs = performance.now();
}

export function stopEventLoopDelayMonitor(): void {
  monitor?.disable();
  monitor = null;
}

/** 当前窗口报告;未启动如实输出 not started */
export function getEventLoopDelayReport(): string {
  if (!monitor) {
    return renderEventLoopDelayReport(null, 0, RESOLUTION_MS);
  }
  return renderEventLoopDelayReport(monitor, performance.now() - windowStartPerfMs, RESOLUTION_MS);
}
