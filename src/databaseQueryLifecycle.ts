/**
 * 只读查询的取消与超时(IDE-DB-003):慢查询到点立即返回 timeout/
 * cancelled 态(不干等),但连接释放等底层结算后 close 恰一次——慢查
 * 询结束等待并释放连接;轮询循环在结算/取消/超时任一成立即退,不滞
 * 留后台轮询;底层失败如实 failed 态带原错误,释放路径不跳过;close
 * 失败经 released 暴露,不影响已定终态。时钟/打盹/取消探针全部注入,
 * 快查询在宏任务边界内结算则零打盹。
 *
 * IDE-REV-014:释放等待有上限(releaseDeadlineMs,默认 5000ms)——底层
 * 查询永不结算时不再无限挂 released:到点注入 destroy 即强制销毁连接
 * (未注入则退回 close);释放或销毁合计恰一次,晚到的成功/失败不触发
 * 第二次释放。
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
  /** IDE-REV-014:释放等待上限(默认 5000ms)——到点底层仍未结算即走强制销毁 */
  releaseDeadlineMs?: number;
  /** IDE-REV-014:强制销毁面(挂在永不结算查询上的连接);未注入退回 close */
  destroy?: () => Promise<void> | void;
}

interface RunHolder<T> {
  state: 'pending' | 'fulfilled' | 'rejected';
  value?: T;
  error?: unknown;
}

const DEFAULT_RELEASE_DEADLINE_MS = 5000;

/**
 * 生命周期包装:轮询探针(取消/超时)与底层执行并行;任一终态返回,
 * released 统一等底层结算(有上限)→ close/destroy 恰一次。
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
      return { kind: 'completed', result: runState.value as T, elapsedMs: options.now() - startedAt, released: releaseAfter(running, close, options, () => runState.state !== 'pending') };
    }
    if (runState.state === 'rejected') {
      return { kind: 'failed', error: runState.error, elapsedMs: options.now() - startedAt, released: releaseAfter(running, close, options, () => runState.state !== 'pending') };
    }
    if (options.isCancelled()) {
      return { kind: 'cancelled', elapsedMs: options.now() - startedAt, released: releaseAfter(running, close, options, () => runState.state !== 'pending') };
    }
    if (options.now() > deadline) {
      return { kind: 'timeout', elapsedMs: options.now() - startedAt, released: releaseAfter(running, close, options, () => runState.state !== 'pending') };
    }
    await options.sleep(pollMs);
  }
}

/**
 * released 面:等底层结算(失败已在状态面呈现,此处吞掉)→ close 恰一次;
 * IDE-REV-014:等待有上限——到点仍未结算即走 destroy 强制销毁(未注入退回
 * close),释放或销毁合计恰一次,晚到结算不重复释放。已结算的快查询不
 * 排限等打盹(零打盹口径保持)。
 */
function releaseAfter(
  running: Promise<void>,
  close: () => Promise<void> | void,
  options: QueryLifecycleOptions,
  isSettled: () => boolean
): Promise<void> {
  const releaseDeadlineMs = options.releaseDeadlineMs ?? DEFAULT_RELEASE_DEADLINE_MS;
  return (async () => {
    if (!isSettled()) {
      const settled = await Promise.race([
        running.then(() => true, () => true),
        options.sleep(releaseDeadlineMs).then(() => false)
      ]);
      if (!settled && options.destroy) {
        await options.destroy();
        return;
      }
    }
    await close();
  })();
}
