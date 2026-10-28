// IDE-MET-005:扩展宿主事件循环延迟采集,统一为毫秒。验收口径:输出写明
// 原始单位与采样窗口——perf_hooks.monitorEventLoopDelay 的直方图原生单位
// 是纳秒,任何报告面都必须显式声明「raw unit: nanoseconds」并把 ms 值按
// 1e6 换算后另行列出,纳秒数字绝不直接贴上 ms 标签。渲染是纯函数
// (renderEventLoopDelayReport),真实监视器只负责启停与窗口记账。
//
// IDE-MET-006:同一进程窗口内 CPU 与 RSS。process.cpuUsage 原生单位就是
// 微秒——增量直接是微秒差,不再乘任何换算系数;RSS 分「窗口采样峰值」与
// 「监视期高水位」两列(高水位跨报告窗口保留,峰值随窗口重置)。

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

/** 一窗宿主资源快照:CPU 增量(微秒)与 RSS 三列(当前/窗口峰值/高水位) */
export interface HostVitalsWindow {
  windowMs: number;
  samples: number;
  cpuUserUs: number;
  cpuSystemUs: number;
  rssCurrentBytes: number;
  rssWindowPeakBytes: number;
  rssHighWaterBytes: number;
}

const BYTES_PER_MB = 1024 * 1024;

const mb = (bytes: number): string => (bytes / BYTES_PER_MB).toFixed(1);

/** 渲染宿主资源报告:微秒原值在账,ms/单核占比为派生行,峰值与高水位分列 */
export function renderHostVitalsReport(window: HostVitalsWindow): string {
  const cpuTotalMs = (window.cpuUserUs + window.cpuSystemUs) / 1000;
  const corePercent = window.windowMs > 0 ? (cpuTotalMs / window.windowMs) * 100 : 0;
  return [
    `host vitals (process.cpuUsage raw unit: microseconds; rss bytes)`,
    `  window: ${(window.windowMs / 1000).toFixed(1)}s (samples ${window.samples})`,
    `  cpu: user=${window.cpuUserUs}us system=${window.cpuSystemUs}us ` +
      `→ ${cpuTotalMs.toFixed(1)}ms (${corePercent.toFixed(1)}% of window on one core)`,
    `  rss: current=${mb(window.rssCurrentBytes)}MB peak=${mb(window.rssWindowPeakBytes)}MB ` +
      `(window) high-water=${mb(window.rssHighWaterBytes)}MB (since monitor start)`
  ].join('\n') + '\n';
}

let vitalsActive = false;
let lastCpu: NodeJS.CpuUsage | null = null;
let vitalsWindowStart = 0;
let vitalsSamples = 0;
let vitalsUserUs = 0;
let vitalsSystemUs = 0;
let vitalsCurrentBytes = 0;
let vitalsWindowPeakBytes = 0;
let vitalsHighWaterBytes = 0;
let vitalsInterval: ReturnType<typeof setInterval> | null = null;

/** 幂等启动:基线 cpuUsage 立即落账,1s 周期采样(unref,不钉死进程生命周期) */
export function startHostVitalsMonitor(): void {
  if (vitalsActive) {
    return;
  }
  vitalsActive = true;
  lastCpu = process.cpuUsage();
  vitalsWindowStart = performance.now();
  const rss = process.memoryUsage().rss;
  vitalsCurrentBytes = rss;
  vitalsWindowPeakBytes = rss;
  vitalsHighWaterBytes = rss;
  vitalsInterval = setInterval(() => sampleHostVitals(), 1000);
  vitalsInterval.unref?.();
}

export function stopHostVitalsMonitor(): void {
  if (vitalsInterval) {
    clearInterval(vitalsInterval);
    vitalsInterval = null;
  }
  vitalsActive = false;
}

/** 测试面:清全部窗口与高水位状态 */
export function resetHostVitalsMonitor(): void {
  vitalsSamples = 0;
  vitalsUserUs = 0;
  vitalsSystemUs = 0;
  vitalsWindowPeakBytes = 0;
  vitalsHighWaterBytes = 0;
  lastCpu = null;
}

/** 采一次:CPU 增量自上次采样累加,RSS 更新当前/峰值/高水位 */
export function sampleHostVitals(): void {
  if (!vitalsActive || !lastCpu) {
    return;
  }
  const delta = process.cpuUsage(lastCpu);
  lastCpu = process.cpuUsage();
  vitalsUserUs += delta.user;
  vitalsSystemUs += delta.system;
  const rss = process.memoryUsage().rss;
  vitalsCurrentBytes = rss;
  vitalsWindowPeakBytes = Math.max(vitalsWindowPeakBytes, rss);
  vitalsHighWaterBytes = Math.max(vitalsHighWaterBytes, rss);
  vitalsSamples += 1;
}

/** 报告即消费:窗口(峰值/增量/样本数)随报告重置,高水位跨窗口保留 */
export function getHostVitalsReport(): string {
  if (!vitalsActive) {
    return 'host vitals: not started\n';
  }
  const window: HostVitalsWindow = {
    windowMs: performance.now() - vitalsWindowStart,
    samples: vitalsSamples,
    cpuUserUs: vitalsUserUs,
    cpuSystemUs: vitalsSystemUs,
    rssCurrentBytes: vitalsCurrentBytes,
    rssWindowPeakBytes: vitalsWindowPeakBytes,
    rssHighWaterBytes: vitalsHighWaterBytes
  };
  vitalsWindowStart = performance.now();
  vitalsSamples = 0;
  vitalsUserUs = 0;
  vitalsSystemUs = 0;
  vitalsWindowPeakBytes = vitalsCurrentBytes;
  return renderHostVitalsReport(window);
}
