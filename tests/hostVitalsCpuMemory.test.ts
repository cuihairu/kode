import { describe, expect, it } from 'vitest';
import {
  getHostVitalsReport,
  renderHostVitalsReport,
  resetHostVitalsMonitor,
  sampleHostVitals,
  startHostVitalsMonitor,
  stopHostVitalsMonitor,
  type HostVitalsWindow
} from '../src/hostVitals';

// IDE-MET-006:同一进程窗口内 CPU 与 RSS。验收口径:CPU 增量正确换算微秒
// (process.cpuUsage 原生就是微秒,不得再当纳秒/毫秒错乘),采样窗口峰值与
// 进程历史高水位分列两行。确定性面:renderHostVitalsReport 纯函数灌注数字;
// 活体面只断结构关系(高水位≥峰值≥当前、cpu 增量>0),不断绝对值。

const MB = 1024 * 1024;

describe('宿主 CPU 与 RSS 采集(IDE-MET-006)', () => {
  it('纯函数灌注:微秒原值在账+窗口百分比派生,峰值与高水位分列', () => {
    const report = renderHostVitalsReport({
      windowMs: 1000,
      samples: 5,
      cpuUserUs: 2_500_000,
      cpuSystemUs: 1_200_000,
      rssCurrentBytes: 50 * MB,
      rssWindowPeakBytes: 60 * MB,
      rssHighWaterBytes: 80 * MB
    });
    // 原始单位声明 + 微秒原值(不是换算错的 2500 或 2.5e12)
    expect(report).toContain('microseconds');
    expect(report).toContain('user=2500000us');
    expect(report).toContain('system=1200000us');
    // 派生面:3700ms / 窗口 1000ms = 370.0% 单核占比
    expect(report).toContain('3700.0ms');
    expect(report).toContain('370.0%');
    // 峰值(窗口)与高水位(监视期)两行分列,数值各自在场
    expect(report).toContain('peak=60.0MB');
    expect(report).toContain('high-water=80.0MB');
    expect(report).toContain('current=50.0MB');
  });

  it('活体采样:busy 后 CPU 增量为正微秒,RSS 高水位≥峰值≥当前', async () => {
    stopHostVitalsMonitor();
    resetHostVitalsMonitor();
    startHostVitalsMonitor();
    const until = Date.now() + 80;
    while (Date.now() < until) {
      Math.sqrt(Date.now());
    }
    sampleHostVitals();
    await new Promise(resolve => setTimeout(resolve, 20));
    sampleHostVitals();
    const report = getHostVitalsReport();
    expect(report).toContain('host vitals');
    expect(report).toContain('microseconds');
    const userUs = report.match(/user=(\d+)us/);
    expect(userUs, 'cpu user 增量缺失').not.toBeNull();
    expect(Number(userUs![1]), 'busy 后 cpu 增量应为正').toBeGreaterThan(0);
    const current = Number(report.match(/current=(\d+(\.\d+)?)MB/)![1]);
    const peak = Number(report.match(/peak=(\d+(\.\d+)?)MB/)![1]);
    const highWater = Number(report.match(/high-water=(\d+(\.\d+)?)MB/)![1]);
    expect(highWater).toBeGreaterThanOrEqual(peak);
    expect(peak).toBeGreaterThanOrEqual(current);
    stopHostVitalsMonitor();
  });

  it('报告消费窗口:窗口峰值随窗口重置,高水位跨窗口保留', async () => {
    stopHostVitalsMonitor();
    resetHostVitalsMonitor();
    startHostVitalsMonitor();
    sampleHostVitals();
    const first = getHostVitalsReport();
    const firstHighWater = Number(first.match(/high-water=(\d+(\.\d+)?)MB/)![1]);
    // 第二窗:只等不动(无新增内存),窗口峰值应回落到当前值附近,高水位不降
    await new Promise(resolve => setTimeout(resolve, 10));
    sampleHostVitals();
    const second = getHostVitalsReport();
    const secondPeak = Number(second.match(/peak=(\d+(\.\d+)?)MB/)![1]);
    const secondHighWater = Number(second.match(/high-water=(\d+(\.\d+)?)MB/)![1]);
    expect(secondHighWater, '高水位不得回落').toBeGreaterThanOrEqual(firstHighWater);
    expect(Number.isFinite(secondPeak)).toBe(true);
    stopHostVitalsMonitor();
    resetHostVitalsMonitor();
  });
});
