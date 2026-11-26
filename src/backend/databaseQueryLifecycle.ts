/**
 * Cancellation and timeout for read-only queries (IDE-DB-003): a slow query
 * returns timeout/cancelled state immediately when the deadline hits (no busy
 * waiting), but the connection release waits for the underlying settlement and
 * closes exactly once -- the slow query finishes waiting and releases the
 * connection; the polling loop exits as soon as settlement/cancel/timeout
 * holds, never lingering as a background poller; an underlying failure is
 * reported honestly as failed state with the original error, and the release
 * path is never skipped; a close failure is exposed via released without
 * affecting the already-settled final state. Clock/sleep/cancel probes are all
 * injected; a fast query settling within a macrotask boundary sleeps zero
 * times.
 *
 * IDE-REV-014: the release wait is bounded (releaseDeadlineMs, default
 * 5000ms) -- when the underlying query never settles, released no longer
 * hangs forever: at the deadline an injected destroy forces the connection to
 * be destroyed (falls back to close when not injected); release or destroy
 * happens exactly once in total, and a late success/failure does not trigger
 * a second release.
 *
 * IDE-AUD-009: a pre-cancel never issues the query (run is called zero
 * times); in the polling order cancel/timeout are evaluated before
 * settlement -- a cancel/timeout arriving in the same tick as the query is
 * not masked into completed by a late success.
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
  /** Polling step (default 25ms); fast queries sleep zero times */
  pollMs?: number;
  /** IDE-REV-014: release-wait upper bound (default 5000ms) -- if the underlying query is still unsettled at the deadline, force-destroy kicks in */
  releaseDeadlineMs?: number;
  /** IDE-REV-014: force-destroy surface (for connections stuck on a never-settling query); falls back to close when not injected */
  destroy?: () => Promise<void> | void;
}

interface RunHolder<T> {
  state: 'pending' | 'fulfilled' | 'rejected';
  value?: T;
  error?: unknown;
}

const DEFAULT_RELEASE_DEADLINE_MS = 5000;

/**
 * Lifecycle wrapper: polling probes (cancel/timeout) run in parallel with the
 * underlying execution; any final state returns, and released uniformly awaits
 * the underlying settlement (bounded) -> close/destroy exactly once.
 */
export async function runReadOnlyQueryLifecycle<T>(
  run: () => Promise<T>,
  close: () => Promise<void> | void,
  options: QueryLifecycleOptions
): Promise<ReadOnlyQueryLifecycleOutcome<T>> {
  const pollMs = options.pollMs ?? 25;
  const startedAt = options.now();
  const deadline = startedAt + options.timeoutMs;

  // IDE-AUD-009: pre-cancel -- the query is never issued at all (run called zero times); release is close exactly once
  if (options.isCancelled()) {
    return {
      kind: 'cancelled',
      elapsedMs: options.now() - startedAt,
      released: (async () => {
        await close();
      })()
    };
  }

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
  // Macrotask boundary: queries that complete synchronously/near-synchronously are marked here, zero sleeps
  await new Promise<void>(resolve => setImmediate(resolve));
  for (;;) {
    // IDE-AUD-009: the final-state reason wins -- a same-tick completion is not passed off as completed
    if (options.isCancelled()) {
      return { kind: 'cancelled', elapsedMs: options.now() - startedAt, released: releaseAfter(running, close, options, () => runState.state !== 'pending') };
    }
    if (options.now() > deadline) {
      return { kind: 'timeout', elapsedMs: options.now() - startedAt, released: releaseAfter(running, close, options, () => runState.state !== 'pending') };
    }
    if (runState.state === 'fulfilled') {
      return { kind: 'completed', result: runState.value as T, elapsedMs: options.now() - startedAt, released: releaseAfter(running, close, options, () => runState.state !== 'pending') };
    }
    if (runState.state === 'rejected') {
      return { kind: 'failed', error: runState.error, elapsedMs: options.now() - startedAt, released: releaseAfter(running, close, options, () => runState.state !== 'pending') };
    }
    await options.sleep(pollMs);
  }
}

/**
 * released surface: await the underlying settlement (failures are already
 * surfaced in the state, swallowed here) -> close exactly once;
 * IDE-REV-014: the wait is bounded -- if it is still unsettled at the deadline,
 * destroy force-destroys it (falls back to close when not injected); release
 * or destroy happens exactly once in total, and a late settlement does not
 * release again. An already-settled fast query does not queue a deadline wait
 * or sleep (the zero-sleep contract is preserved).
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
