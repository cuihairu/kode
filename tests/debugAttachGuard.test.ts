import { describe, expect, it } from 'vitest';
import {
  DEBUG_ATTACH_TIMEOUT_DEFAULT_MS,
  attachWithDeadline,
  type AttachGuardTimers
} from '../src/debugAttachGuard';

// IDE-DBG-007 调试连接的截止与取消:attach 到无人监听的端口时
// vscode.debug.startDebugging 可能长时间不落定(挂起到 OS 级 TCP 超时),
// 调试入口就此永久等待。attachWithDeadline 用注入的计时器精确回放三条
// 终止路径——按期完成/超时停止/用户取消——并锁死「晚到的 start 结果一律
// 吞掉、绝不重试」的语义。

interface FakeTimer {
  handler: () => void;
  ms: number;
  cleared: boolean;
  fired: boolean;
}

const makeTimers = () => {
  const timers: FakeTimer[] = [];
  const api: AttachGuardTimers = {
    set: (handler, ms) => {
      const timer: FakeTimer = { handler, ms, cleared: false, fired: false };
      timers.push(timer);
      return timer;
    },
    clear: handle => {
      (handle as FakeTimer).cleared = true;
    }
  };
  return {
    timers: api,
    all: timers,
    fire: (index = 0) => {
      const timer = timers[index];
      if (timer && !timer.cleared && !timer.fired) {
        timer.fired = true;
        timer.handler();
      }
    }
  };
};

interface Harness {
  resolveStart: (value: boolean) => void;
  rejectStart: (error: Error) => void;
  stopped: number;
  notifications: string[];
  cancelListeners: Array<() => void>;
  cancelDisposals: number;
}

const makeHarness = (): Harness => {
  const harness: Harness = {
    resolveStart: () => undefined,
    rejectStart: () => undefined,
    stopped: 0,
    notifications: [],
    cancelListeners: [],
    cancelDisposals: 0
  };
  return harness;
};

const startNever = (): Promise<boolean> =>
  new Promise<boolean>(() => undefined);

const runGuard = (
  harness: Harness,
  options: {
    start: () => Promise<boolean>;
    timeoutMs: number;
    withCancel?: boolean;
    onStartSettled?: (late: boolean, success: boolean) => void;
  },
  timers: AttachGuardTimers
) =>
  attachWithDeadline(
    {
      label: 'cellapp (debugpy 5679)',
      timeoutMs: options.timeoutMs,
      start: options.start,
      stop: () => {
        harness.stopped += 1;
      },
      notify: message => {
        harness.notifications.push(message);
      },
      ...(options.onStartSettled === undefined
        ? {}
        : { onStartSettled: options.onStartSettled }),
      ...(options.withCancel === false
        ? {}
        : {
            onCancel: (listener: () => void) => {
              harness.cancelListeners.push(listener);
              return {
                dispose: () => {
                  harness.cancelDisposals += 1;
                }
              };
            }
          })
    },
    timers
  );

describe('attachWithDeadline(截止与取消,DBG-007)', () => {
  it('默认截止 15 秒(设置面缺省值同源)', () => {
    expect(DEBUG_ATTACH_TIMEOUT_DEFAULT_MS).toBe(15_000);
  });

  it('按期完成:返回成功,清计时器,释放取消订阅,零停止零提示', async () => {
    const clock = makeTimers();
    const harness = makeHarness();
    let resolveStart: (value: boolean) => void = () => undefined;
    const promise = runGuard(
      harness,
      {
        timeoutMs: 15_000,
        start: () => new Promise<boolean>(resolve => (resolveStart = resolve))
      },
      clock.timers
    );
    resolveStart(true);
    await expect(promise).resolves.toEqual({ status: 'completed', success: true });

    expect(clock.all).toHaveLength(1);
    expect(clock.all[0].cleared).toBe(true);
    expect(harness.cancelDisposals).toBe(1);
    expect(harness.stopped).toBe(0);
    expect(harness.notifications).toEqual([]);
  });

  it('无人监听的端口:超时即停卡住的会话并如实提示,不再等待', async () => {
    const clock = makeTimers();
    const harness = makeHarness();
    const promise = runGuard(
      harness,
      { timeoutMs: 15_000, start: startNever },
      clock.timers
    );
    clock.fire();
    await expect(promise).resolves.toEqual({ status: 'timeout' });

    expect(harness.stopped).toBe(1);
    expect(harness.notifications).toHaveLength(1);
    expect(harness.notifications[0]).toContain('cellapp (debugpy 5679)');
    expect(harness.notifications[0]).toContain('超时');
    expect(harness.notifications[0]).toContain('不再重试');
    // 取消订阅已释放:此后再取消不得二次停止
    harness.cancelListeners.forEach(listener => listener());
    expect(harness.stopped).toBe(1);
    expect(harness.notifications).toHaveLength(1);
  });

  it('超时返回后晚到的成功被吞:无二次通知,结果即 timeout', async () => {
    const clock = makeTimers();
    const harness = makeHarness();
    let resolveStart: (value: boolean) => void = () => undefined;
    const promise = runGuard(
      harness,
      {
        timeoutMs: 15_000,
        start: () => new Promise<boolean>(resolve => (resolveStart = resolve))
      },
      clock.timers
    );
    clock.fire();
    await expect(promise).resolves.toEqual({ status: 'timeout' });
    resolveStart(true);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(harness.notifications).toHaveLength(1);
    expect(harness.stopped).toBe(1);
  });

  it('超时返回后晚到的异常同样被吞:无 unhandled rejection', async () => {
    const clock = makeTimers();
    const harness = makeHarness();
    let rejectStart: (error: Error) => void = () => undefined;
    const promise = runGuard(
      harness,
      {
        timeoutMs: 15_000,
        start: () =>
          new Promise<boolean>((_resolve, reject) => (rejectStart = reject))
      },
      clock.timers
    );
    clock.fire();
    await expect(promise).resolves.toEqual({ status: 'timeout' });
    rejectStart(new Error('端口连上了但适配器炸了'));
    // 一个宏任务节拍内没有 unhandled rejection 抛出即算通过
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(harness.notifications).toHaveLength(1);
  });

  it('用户取消:停止会话+提示,清计时器;此后计时器到点不再触发', async () => {
    const clock = makeTimers();
    const harness = makeHarness();
    const promise = runGuard(
      harness,
      { timeoutMs: 15_000, start: startNever },
      clock.timers
    );
    harness.cancelListeners[0]();
    await expect(promise).resolves.toEqual({ status: 'cancelled' });

    expect(harness.stopped).toBe(1);
    expect(harness.notifications).toHaveLength(1);
    expect(harness.notifications[0]).toContain('已取消');
    expect(clock.all[0].cleared).toBe(true);
    clock.fire();
    expect(harness.stopped).toBe(1);
    expect(harness.notifications).toHaveLength(1);
  });

  it('start 在期限内抛错:原样透传给调用方,零停止零提示', async () => {
    const clock = makeTimers();
    const harness = makeHarness();
    const promise = runGuard(
      harness,
      {
        timeoutMs: 15_000,
        start: () => Promise.reject(new Error('适配器启动失败'))
      },
      clock.timers
    );
    await expect(promise).rejects.toThrow('适配器启动失败');
    expect(clock.all[0].cleared).toBe(true);
    expect(harness.cancelDisposals).toBe(1);
    expect(harness.stopped).toBe(0);
    expect(harness.notifications).toEqual([]);
  });

  it('attachTimeoutMs<=0 不限时:不装计时器,等待到底;取消面仍可用', async () => {
    const clock = makeTimers();
    const harness = makeHarness();
    let resolveStart: (value: boolean) => void = () => undefined;
    const waiting = runGuard(
      harness,
      {
        timeoutMs: 0,
        start: () => new Promise<boolean>(resolve => (resolveStart = resolve))
      },
      clock.timers
    );
    expect(clock.all).toHaveLength(0);
    resolveStart(false);
    await expect(waiting).resolves.toEqual({ status: 'completed', success: false });

    const hung = runGuard(
      harness,
      { timeoutMs: -1, start: startNever },
      clock.timers
    );
    expect(clock.all).toHaveLength(0);
    harness.cancelListeners.at(-1)?.();
    await expect(hung).resolves.toEqual({ status: 'cancelled' });
    expect(harness.stopped).toBe(1);
  });
});

describe('attachWithDeadline onStartSettled(start 落定回调,REV-003)', () => {
  it('按期完成:返回路径同步回调一次 late=false,success 如实', async () => {
    const clock = makeTimers();
    const harness = makeHarness();
    const settled: Array<{ late: boolean; success: boolean }> = [];
    let resolveStart: (value: boolean) => void = () => undefined;
    const promise = runGuard(
      harness,
      {
        timeoutMs: 15_000,
        start: () => new Promise<boolean>(resolve => (resolveStart = resolve)),
        onStartSettled: (late, success) => settled.push({ late, success })
      },
      clock.timers
    );
    resolveStart(true);
    await expect(promise).resolves.toEqual({ status: 'completed', success: true });
    expect(settled).toEqual([{ late: false, success: true }]);
  });

  it('超时后迟到成功:回调 late=true 恰一次,结果仍 timeout,无二次通知', async () => {
    const clock = makeTimers();
    const harness = makeHarness();
    const settled: Array<{ late: boolean; success: boolean }> = [];
    let resolveStart: (value: boolean) => void = () => undefined;
    const promise = runGuard(
      harness,
      {
        timeoutMs: 15_000,
        start: () => new Promise<boolean>(resolve => (resolveStart = resolve)),
        onStartSettled: (late, success) => settled.push({ late, success })
      },
      clock.timers
    );
    clock.fire();
    await expect(promise).resolves.toEqual({ status: 'timeout' });
    resolveStart(true);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(settled).toEqual([{ late: true, success: true }]);
    expect(harness.notifications).toHaveLength(1);
  });

  it('超时后迟到异常:回调 late=true/success=false,无 unhandled rejection', async () => {
    const clock = makeTimers();
    const harness = makeHarness();
    const settled: Array<{ late: boolean; success: boolean }> = [];
    let rejectStart: (error: Error) => void = () => undefined;
    const promise = runGuard(
      harness,
      {
        timeoutMs: 15_000,
        start: () => new Promise<boolean>((_resolve, reject) => (rejectStart = reject)),
        onStartSettled: (late, success) => settled.push({ late, success })
      },
      clock.timers
    );
    clock.fire();
    await expect(promise).resolves.toEqual({ status: 'timeout' });
    rejectStart(new Error('迟到失败'));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(settled).toEqual([{ late: true, success: false }]);
    expect(harness.notifications).toHaveLength(1);
  });

  it('start 期限内抛错:回调 late=false/success=false 一次,rejection 照旧透传', async () => {
    const clock = makeTimers();
    const harness = makeHarness();
    const settled: Array<{ late: boolean; success: boolean }> = [];
    const promise = runGuard(
      harness,
      {
        timeoutMs: 15_000,
        start: () => Promise.reject(new Error('适配器启动失败')),
        onStartSettled: (late, success) => settled.push({ late, success })
      },
      clock.timers
    );
    await expect(promise).rejects.toThrow('适配器启动失败');
    expect(settled).toEqual([{ late: false, success: false }]);
  });
});
