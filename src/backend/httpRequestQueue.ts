/**
 * HR-HTTP-007 (RUST-349) per-target bounded concurrency queue:
 * - Same target (enqueued with the same targetKey) defaults to serial — FIFO;
 *   the next task starts only after the previous one settles (hot reload
 *   requests to the same endpoint never reorder among themselves, and an
 *   older revision finalized later never reaches the engine first);
 * - Different targets run concurrently and independently of one another, never
 *   queueing behind each other;
 * - A global in-flight cap (globalConcurrency) backstops the whole layer's
 *   concurrency, preventing many targets together from crushing the host.
 * Pure logic, decoupled from the transport face: a task is any closure
 * returning a Promise, and the queue only does ordering and rate limiting.
 * Task results / rejections are passed through honestly to the caller
 * (rejections are neither swallowed nor allowed to stall the queue; the queue
 * keeps advancing the remaining tasks).
 * The target count is usually tiny (single endpoint / single channel), so
 * dequeue is a plain sequential scan — no heap / complex scheduler is
 * introduced (consistent with HR-HTTP-001's single execution path
 * convention; no parallel abstraction is invented here).
 */

export interface HttpTargetQueueOptions {
  /** Per-target concurrency cap; defaults to 1 (serial) */
  readonly perTargetConcurrency?: number;
  /** Global in-flight cap; defaults to 4 */
  readonly globalConcurrency?: number;
}

export interface HttpTargetQueue {
  /**
   * Enqueue and run: keeps FIFO per targetKey and returns that task's result
   * (rejections are passed through honestly to the caller). Awaiting on the
   * caller's side yields exactly the same settlement semantics as the task's
   * own execution; only the moment of launch was queued.
   */
  run<T>(targetKey: string, task: () => Promise<T>): Promise<T>;
  /**
   * HR-QA-016 soak introspection: the current internal state (target key
   * count / global in-flight / pending count). After every task settles all
   * three should be zero — a target state deletes itself when idle
   * (perTarget.delete), and failing to settle is a connection leak (soak
   * treats this as its invariant).
   */
  stats(): HttpTargetQueueStats;
}

/** HR-QA-016 soak introspection shape: all zero after settling = no residue (no connection leak) */
export interface HttpTargetQueueStats {
  /** The number of target keys still holding state (=0 once settled) */
  readonly targets: number;
  /** The number of globally in-flight (unsettled) tasks */
  readonly inFlight: number;
  /** The number of queued (enqueued, not yet started) tasks */
  readonly pending: number;
}

interface TargetState {
  active: number;
  pending: Array<() => void>;
}

const clampPositive = (value: number | undefined, fallback: number): number =>
  value === undefined || !Number.isInteger(value) || value < 1 ? fallback : value;

export function createHttpTargetQueue(options: HttpTargetQueueOptions = {}): HttpTargetQueue {
  const perTargetConcurrency = clampPositive(options.perTargetConcurrency, 1);
  const globalConcurrency = clampPositive(options.globalConcurrency, 4);
  const perTarget = new Map<string, TargetState>();
  let globalActive = 0;

  const pump = (): void => {
    // There is a global slot, some target has a waiters queue, and that target
    // is under its concurrency cap -> dequeue one and launch it.
    // The target set is tiny, so a sequential scan suffices; stop as soon as a
    // full scan round launches nothing (wait for settlements to pump again).
    for (const state of perTarget.values()) {
      if (globalActive >= globalConcurrency) {
        return;
      }
      if (state.active >= perTargetConcurrency || state.pending.length === 0) {
        continue;
      }
      const next = state.pending.shift()!;
      state.active += 1;
      globalActive += 1;
      next();
    }
  };

  const run = <T>(targetKey: string, task: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const start = (): void => {
        // The task starts across a microtask boundary: start is only ever
        // invoked synchronously inside pump, and the microtask hop means a
        // throwing task lands in the rejection branch rather than bare-throwing
        // inside the queue.
        void Promise.resolve()
          .then(task)
          .then(
            value => {
              settle();
              resolve(value);
            },
            error => {
              settle();
              reject(error);
            }
          );
      };
      const settle = (): void => {
        const state = perTarget.get(targetKey);
        if (state) {
          state.active = Math.max(0, state.active - 1);
          if (state.active === 0 && state.pending.length === 0) {
            perTarget.delete(targetKey);
          }
        }
        globalActive = Math.max(0, globalActive - 1);
        pump();
      };
      let state = perTarget.get(targetKey);
      if (!state) {
        state = { active: 0, pending: [] };
        perTarget.set(targetKey, state);
      }
      state.pending.push(start);
      pump();
    });

  const stats = (): HttpTargetQueueStats => {
    let pending = 0;
    for (const state of perTarget.values()) {
      pending += state.pending.length;
    }
    return { targets: perTarget.size, inFlight: globalActive, pending };
  };

  return { run, stats };
}
