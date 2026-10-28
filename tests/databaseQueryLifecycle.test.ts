import { describe, expect, it, vi } from 'vitest';
import { runReadOnlyQueryLifecycle } from '../src/databaseQueryLifecycle';

// IDE-DB-003 为只读查询增加取消与超时:慢查询到点立即返回 timeout/
// cancelled 态(不干等),但连接释放等底层结算后 close 恰一次——慢查
// 询结束等待并释放连接;轮询循环在超时/取消/结算任一成立即停,不滞
// 留后台轮询;底层 reject 也不跳过释放;close 失败如实经 released 可
// 见,不影响已定的终态。

const QUERY_RESULT = { columns: [{ name: 'id', type: 'int' }], rows: [{ id: 1 }] };

interface Harness {
  resolveRun: (value: typeof QUERY_RESULT) => void;
  rejectRun: (error: Error) => void;
  close: ReturnType<typeof vi.fn>;
  now: ReturnType<typeof vi.fn> & { advance(ms: number): void };
  sleep: ReturnType<typeof vi.fn>;
  isCancelled: ReturnType<typeof vi.fn>;
}

const createHarness = (overrides: Partial<Pick<Harness, 'isCancelled'>> = {}): Harness => {
  const harness = {} as Harness;
  harness.now = Object.assign(vi.fn(() => 0), { advance: () => undefined });
  let current = 0;
  harness.now.mockImplementation(() => current);
  harness.now.advance = (ms: number) => { current += ms; };
  harness.sleep = vi.fn(async () => { harness.now.advance(1); });
  harness.isCancelled = overrides.isCancelled ?? vi.fn(() => false);
  harness.close = vi.fn(async () => undefined);
  return harness;
};

const deferredRun = () => {
  let resolveRun!: (value: typeof QUERY_RESULT) => void;
  let rejectRun!: (error: Error) => void;
  const promise = new Promise<typeof QUERY_RESULT>((resolve, reject) => {
    resolveRun = resolve;
    rejectRun = reject;
  });
  return { promise, resolveRun, rejectRun };
};

describe('runReadOnlyQueryLifecycle(取消与超时)', () => {
  it('快查询完成:completed+结果,close 恰一次,零打盹', async () => {
    const h = createHarness();
    const outcome = await runReadOnlyQueryLifecycle(async () => QUERY_RESULT, h.close, {
      timeoutMs: 5000, isCancelled: h.isCancelled, now: h.now, sleep: h.sleep, pollMs: 25
    });

    expect(outcome.kind).toBe('completed');
    if (outcome.kind === 'completed') {
      expect(outcome.result).toEqual(QUERY_RESULT);
    }
    await outcome.released;
    expect(h.close).toHaveBeenCalledTimes(1);
    expect(h.sleep).not.toHaveBeenCalled();
  });

  it('慢查询超时:立即返回 timeout,底层结算后 close 恰一次', async () => {
    const h = createHarness();
    const run = deferredRun();
    const pending = runReadOnlyQueryLifecycle(() => run.promise, h.close, {
      timeoutMs: 100, isCancelled: h.isCancelled, now: h.now, sleep: h.sleep, pollMs: 25
    });
    const racer = pending.then(outcome => ({ outcome }));

    h.now.advance(101); // 越过截止
    const { outcome } = await racer;

    expect(outcome.kind).toBe('timeout');
    expect(h.close).not.toHaveBeenCalled(); // 未结算不释放
    run.resolveRun(QUERY_RESULT);
    await outcome.released;
    expect(h.close).toHaveBeenCalledTimes(1);
  });

  it('取消:cancelled 态,等结算释放,close 仍恰一次', async () => {
    const h = createHarness({ isCancelled: vi.fn(() => true) });
    const run = deferredRun();
    const outcome = await runReadOnlyQueryLifecycle(() => run.promise, h.close, {
      timeoutMs: 60_000, isCancelled: h.isCancelled, now: h.now, sleep: h.sleep, pollMs: 25
    });

    expect(outcome.kind).toBe('cancelled');
    expect(h.close).not.toHaveBeenCalled();
    run.resolveRun(QUERY_RESULT);
    await outcome.released;
    expect(h.close).toHaveBeenCalledTimes(1);
  });

  it('慢于起步但先于超时完成 → completed', async () => {
    const h = createHarness();
    const run = deferredRun();
    const pending = runReadOnlyQueryLifecycle(() => run.promise, h.close, {
      timeoutMs: 5000, isCancelled: h.isCancelled, now: h.now, sleep: h.sleep, pollMs: 25
    });
    const racer = pending.then(outcome => ({ outcome }));

    h.now.advance(100);
    await h.sleep.mock.results[0]?.value;
    run.resolveRun(QUERY_RESULT);
    const { outcome } = await racer;

    expect(outcome.kind).toBe('completed');
    await outcome.released;
    expect(h.close).toHaveBeenCalledTimes(1);
  });

  it('底层 reject 也不跳过释放:等结算后 close 恰一次', async () => {
    const h = createHarness();
    const run = deferredRun();
    const outcome = await runReadOnlyQueryLifecycle(() => run.promise, h.close, {
      timeoutMs: 10, isCancelled: h.isCancelled, now: h.now, sleep: h.sleep, pollMs: 5
    });

    expect(outcome.kind).toBe('timeout');
    run.rejectRun(new Error('mysql gone away'));
    await outcome.released;
    expect(h.close).toHaveBeenCalledTimes(1);
  });

  it('轮询不滞留:超时定局后不再打盹(sleep 次数有界)', async () => {
    const h = createHarness();
    const run = deferredRun();
    const outcome = await runReadOnlyQueryLifecycle(() => run.promise, h.close, {
      timeoutMs: 10, isCancelled: h.isCancelled, now: h.now, sleep: h.sleep, pollMs: 5
    });
    const sleepCallsAtSettle = h.sleep.mock.calls.length;

    await new Promise(resolve => setImmediate(resolve));
    expect(h.sleep.mock.calls.length).toBe(sleepCallsAtSettle);

    run.resolveRun(QUERY_RESULT);
    await outcome.released;
    expect(h.sleep.mock.calls.length).toBe(sleepCallsAtSettle);
  });

  it('底层失败:failed 态带原错误,释放照常恰一次', async () => {
    const h = createHarness();
    const outcome = await runReadOnlyQueryLifecycle(
      async () => { throw new Error('bad sql'); },
      h.close,
      { timeoutMs: 1000, isCancelled: h.isCancelled, now: h.now, sleep: h.sleep }
    );

    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') {
      expect((outcome.error as Error).message).toBe('bad sql');
    }
    await outcome.released;
    expect(h.close).toHaveBeenCalledTimes(1);
  });

  it('close 失败如实经 released 可见,终态不变', async () => {
    const h = createHarness();
    h.close.mockRejectedValue(new Error('close refused'));
    const outcome = await runReadOnlyQueryLifecycle(async () => QUERY_RESULT, h.close, {
      timeoutMs: 1000, isCancelled: h.isCancelled, now: h.now, sleep: h.sleep
    });

    expect(outcome.kind).toBe('completed');
    await expect(outcome.released).rejects.toThrow('close refused');
  });
});
