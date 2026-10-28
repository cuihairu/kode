import { describe, expect, it } from 'vitest';
import {
  getEventLoopDelayReport,
  renderEventLoopDelayReport,
  startEventLoopDelayMonitor,
  stopEventLoopDelayMonitor,
  type EventLoopDelayHistogramLike
} from '../src/hostVitals';

// IDE-MET-005:事件循环延迟采集并统一为毫秒。验收口径:输出写明原始单位
// (monitorEventLoopDelay 直方图原生纳秒)与采样窗口,纳秒绝不直接冒充毫秒。
// 确定性面:renderEventLoopDelayReport 纯函数灌注纳秒直方图断言换算;真实
// 监视器只做冒烟(窗口/分辨率/上限断言,不锁绝对延迟值,避免负载抖动)。

const fakeHistogram = (values: {
  meanNs: number;
  minNs: number;
  maxNs: number;
  stdDevNs: number;
  count: number;
  p50Ns?: number;
  p99Ns?: number;
}): EventLoopDelayHistogramLike => ({
  mean: values.meanNs,
  min: values.minNs,
  max: values.maxNs,
  stdDev: values.stdDevNs,
  count: values.count,
  percentile: (percentile: number) => {
    if (percentile <= 50) { return values.p50Ns ?? values.meanNs; }
    return values.p99Ns ?? values.maxNs;
  }
});

describe('事件循环延迟采集(IDE-MET-005)', () => {
  it('纳秒直方图灌注:输出显式注明原始单位 nanoseconds,ms 值按 1e6 换算', () => {
    const report = renderEventLoopDelayReport(
      fakeHistogram({
        meanNs: 2.5e6,
        minNs: 1e6,
        maxNs: 8e6,
        stdDevNs: 0.5e6,
        count: 1234,
        p50Ns: 2e6,
        p99Ns: 6e6
      }),
      12_345,
      10
    );
    expect(report).toContain('nanoseconds');
    expect(report).toContain('window: 12.3s');
    expect(report).toContain('samples 1234');
    // ms 行:2.5e6ns → 2.5ms(不是 2500000——纳秒冒充毫秒的失败形态)
    expect(report).toMatch(/mean=2\.5\b/);
    expect(report).toMatch(/p99=6\b/);
    expect(report).toMatch(/max=8\b/);
    // 原始纳秒值原样并列,读者可对账换算
    expect(report).toContain('2500000');
  });

  it('未启动报告如实说明:没有监视器就没有窗口数据', () => {
    const report = renderEventLoopDelayReport(null, 0, 10);
    expect(report).toContain('not started');
  });

  it('真实监视器冒烟:窗口与分辨率在账,max 上限拦截纳秒泄漏(冒充 ms 必超界)', async () => {
    stopEventLoopDelayMonitor();
    startEventLoopDelayMonitor();
    // 制造一点事件循环压力再读报告(只断窗口结构,不断绝对值)
    const until = Date.now() + 120;
    while (Date.now() < until) {
      Math.sqrt(Date.now());
    }
    await new Promise(resolve => setTimeout(resolve, 30));
    const report = getEventLoopDelayReport();
    expect(report).toContain('event loop delay');
    expect(report).toContain('nanoseconds');
    expect(report).toContain('window:');
    expect(report).toContain('resolution 10ms');
    const maxLine = report.match(/max=(\d+(\.\d+)?)\b/);
    expect(maxLine, 'max 值缺失').not.toBeNull();
    // 真实扩展宿主 1s 级窗口 max 延迟远低于 60s;若纳秒被当毫秒打印必超界
    expect(Number(maxLine![1]), `max=${maxLine![1]}ms 超界,疑似纳秒冒充`).toBeLessThan(60_000);
    stopEventLoopDelayMonitor();
  });
});
