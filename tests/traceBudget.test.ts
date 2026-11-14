import { describe, expect, it } from 'vitest';
import {
  TRACE_CAPTURE_BUDGET,
  describeCaptureBudget,
  resolveCaptureBudgets
} from '../src/backend/traceBudget';
import { buildCollectorArgs } from '../src/backend/traceCaptureRun';

// FLOW-029 预算验收前半:「预登记采集时间/容量/开销预算」——预算唯一出处=
// TRACE_CAPTURE_BUDGET,缺省/硬顶/开销三项齐;缺省走默认、显式受硬顶、
// 非法值拒绝消息与 FLOW-025 红线一致;运行面消费同一登记(buildCollectorArgs
// 缺省参数=预算默认)。数值钉=注册表锁步(改值必须连报告与测试一起改)。

describe('traceBudget: 预登记采集预算(FLOW-029)', () => {
  it('预算注册表三项齐:容量默认/硬顶、时间默认/硬顶、每事件开销', () => {
    expect(TRACE_CAPTURE_BUDGET.defaultMaxEvents).toBeGreaterThan(0);
    expect(TRACE_CAPTURE_BUDGET.hardMaxEventsCap).toBeGreaterThanOrEqual(TRACE_CAPTURE_BUDGET.defaultMaxEvents);
    expect(TRACE_CAPTURE_BUDGET.defaultTimeoutMs).toBeGreaterThan(0);
    expect(TRACE_CAPTURE_BUDGET.hardTimeoutMsCap).toBeGreaterThanOrEqual(TRACE_CAPTURE_BUDGET.defaultTimeoutMs);
    expect(TRACE_CAPTURE_BUDGET.overheadBudgetPerEventMs).toBeGreaterThan(0);
  });

  it('缺省=预登记默认;显式给值(硬顶内)原样生效', () => {
    expect(resolveCaptureBudgets({})).toEqual({
      maxEvents: TRACE_CAPTURE_BUDGET.defaultMaxEvents,
      timeoutMs: TRACE_CAPTURE_BUDGET.defaultTimeoutMs
    });
    expect(resolveCaptureBudgets({ maxEvents: 777, timeoutMs: 4321 })).toEqual({
      maxEvents: 777,
      timeoutMs: 4321
    });
  });

  it('超硬顶即拒:错误消息带预算值可回查', () => {
    expect(() => resolveCaptureBudgets({ maxEvents: TRACE_CAPTURE_BUDGET.hardMaxEventsCap + 1 })).toThrow(
      /容量超预算/
    );
    expect(() => resolveCaptureBudgets({ timeoutMs: TRACE_CAPTURE_BUDGET.hardTimeoutMsCap + 1 })).toThrow(
      /时间超预算/
    );
  });

  it('非法值拒绝消息与 FLOW-025 红线一致(有界/可关闭)', () => {
    expect(() => resolveCaptureBudgets({ maxEvents: 0 })).toThrow(/有界/);
    expect(() => resolveCaptureBudgets({ maxEvents: 1.5 })).toThrow(/有界/);
    expect(() => resolveCaptureBudgets({ timeoutMs: 0 })).toThrow(/可关闭/);
  });

  it('运行面消费同一登记:缺省请求的命令行=预算默认 max-events', () => {
    const args = buildCollectorArgs(
      {
        pythonPath: 'python3',
        collectorScript: 'collector.py',
        targetScript: 'workload.py',
        cwd: '.',
        sessionId: 's'
      },
      '/tmp/out.json'
    );
    expect(args).toContain(`--max-events=${TRACE_CAPTURE_BUDGET.defaultMaxEvents}`);
    expect(() =>
      buildCollectorArgs(
        {
          pythonPath: 'python3',
          collectorScript: 'collector.py',
          targetScript: 'workload.py',
          maxEvents: TRACE_CAPTURE_BUDGET.hardMaxEventsCap + 1,
          cwd: '.',
          sessionId: 's'
        },
        '/tmp/out.json'
      )
    ).toThrow(/容量超预算/);
  });

  it('预算摘要串含全部登记值(UI/报告引用)', () => {
    const summary = describeCaptureBudget();
    expect(summary).toContain(`${TRACE_CAPTURE_BUDGET.defaultMaxEvents}`);
    expect(summary).toContain(`${TRACE_CAPTURE_BUDGET.hardMaxEventsCap}`);
    expect(summary).toContain(`${TRACE_CAPTURE_BUDGET.defaultTimeoutMs}`);
    expect(summary).toContain(`${TRACE_CAPTURE_BUDGET.hardTimeoutMsCap}`);
    expect(summary).toContain(`${TRACE_CAPTURE_BUDGET.overheadBudgetPerEventMs}`);
  });
});
