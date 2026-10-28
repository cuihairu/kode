/**
 * 只读查询的取消与超时(IDE-DB-003):慢查询到点立即返回 timeout/
 * cancelled 态(不干等),但连接释放等底层结算后 close 恰一次——慢查
 * 询结束等待并释放连接;轮询循环在结算/取消/超时任一成立即退,不滞
 * 留后台轮询;底层失败如实 failed 态带原错误,释放路径不跳过;close
 * 失败经 released 暴露,不影响已定终态。时钟/打盹/取消探针全部注入,
 * 快查询在宏任务边界内结算则零打盹。
 */

export type ReadOnlyQueryLifecycleOutcome<T> =
  | { kind: 'completed'; result: T; elapsedMs: number; released: Promise<void> }
  | { kind: 'failed'; error: unknown; elapsedMs: number; released: Promise<void> }
  | { kind: 'timeout'; elapsedMs: number; released: Promise<void> }
  | { kind: 'cancelled'; elapsedMs: number; released: Promise<void> };

export interface QueryLifecycleOptions {
  timeoutMs: number;
  isCancelled(): boolean;
  now(): number;
  sleep(ms: number): Promise<void>;
  /** 轮询步长(默认 25ms);快查询零打盹 */
  pollMs?: number;
}

interface RunHolder<T> {
  state: 'pending' | 'fulfilled' | 'rejected';
  value?: T;
  error?: unknown;
}

/**
 * 生命周期包装:轮询探针(取消/超时)与底层执行并行;任一终态返回,
 * released 统一等底层结算 → close 恰一次。
 */
export async function runReadOnlyQueryLifecycle<T>(
  run: () => Promise<T>,
  close: () => Promise<void> | void,
  options: QueryLifecycleOptions
): Promise<ReadOnlyQueryLifecycleOutcome<T>> {
  const pollMs = options.pollMs ?? 25;
  const startedAt = options.now();
  const deadline = startedAt + options.timeoutMs;
  const runState: RunHolder<T> = { state: 'pending' };
  const running = run().then(
    value => {
      runState.state = 'fulfilled';
      runState.value = value;
    },
    error => {
      runState.state = 'rejected';
      runState.error = error;
    }
  );
  // 宏任务边界:同步/近同步完成的查询在此落标,零打盹
  await new Promise<void>(resolve => setImmediate(resolve));
  for (;;) {
    if (runState.state === 'fulfilled') {
      return { kind: 'completed', result: runState.value as T, elapsedMs: options.now() - startedAt, released: releaseAfter(running, close) };
    }
    if (runState.state === 'rejected') {
      return { kind: 'failed', error: runState.error, elapsedMs: options.now() - startedAt, released: releaseAfter(running, close) };
    }
    if (options.isCancelled()) {
      return { kind: 'cancelled', elapsedMs: options.now() - startedAt, released: releaseAfter(running, close) };
    }
    if (options.now() > deadline) {
      return { kind: 'timeout', elapsedMs: options.now() - startedAt, released: releaseAfter(running, close) };
    }
    await options.sleep(pollMs);
  }
}

/** released 面:等底层结算(失败已在状态面呈现,此处吞掉)→ close 恰一次 */
function releaseAfter(running: Promise<void>, close: () => Promise<void> | void): Promise<void> {
  return (async () => {
    await running;
    await close();
  })();
}
