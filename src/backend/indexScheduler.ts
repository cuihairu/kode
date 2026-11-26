// Unified index scheduler (PR3, review docs/review/2026-10-22 §3.3): the
// single entry point for index task lifecycle and priority. Task kinds cover
// initial scan/single-file incremental/affected dependency updates/delete
// cleanup/non-interactive whole-project analysis; same-file same-version
// tasks merge, stale-version tasks are cancelled and dropped; failed tasks
// do not cache an "already scanned" illusion, later requests can re-enqueue
// and recover (never permanently pending).
// Background tasks (full/non-interactive) are throttled by interaction:
// within the cooldown window after an interactive task enqueues or just
// finishes they stay off the main thread, so a full index never steals input
// responsiveness during editing bursts.
// Instrumentation: every task execution records duration and terminal state
// through languageServiceMetrics('index-scheduler'); the throttle-yield/
// merge/drop counters are carried by getStatus().metrics (evidence for
// tests and reports).

import { performance } from 'perf_hooks';
import { startLanguageServiceOperation } from '../languageServiceMetrics';

/** Task kind = lifecycle stage (the §3.3 minimum support list) */
export type IndexTaskKind =
  | 'initial-scan'
  | 'single-file-update'
  | 'dependency-update'
  | 'delete-cleanup'
  | 'full-reindex'
  | 'non-interactive';

/**
 * Priorities (review-recommended order, a smaller number runs first):
 * current-file light > request-local > dependency update > background full
 * > non-interactive.
 */
export const IndexTaskPriority = {
  /** Light parse of the currently open file */
  CurrentFileLight: 0,
  /** Local index the current request needs but that does not exist yet */
  RequestLocal: 1,
  /** Affected dependency updates caused by the current file's modification */
  DependencyUpdate: 2,
  /** Background full index */
  BackgroundFull: 3,
  /** Non-interactive whole-project analysis */
  NonInteractive: 4
} as const;

export type IndexTaskPriorityValue = (typeof IndexTaskPriority)[keyof typeof IndexTaskPriority];

/** Interactive tasks = the kinds the user is waiting on within the session (higher priority than background full) */
export function isInteractivePriority(priority: number): boolean {
  return priority < IndexTaskPriority.BackgroundFull;
}

export interface IndexTaskSpec {
  kind: IndexTaskKind;
  priority: IndexTaskPriorityValue;
  /** Task body; rejection = this attempt failed (recoverable, not a permanent state) */
  run: () => Promise<void>;
  /** Target file of a single-file incremental task (part of the merge/staleness key) */
  filePath?: string;
  /** File version (document version/mtime generation); same-file cross-version staleness is judged by it */
  version?: number;
  /** Invalidated target on file delete/asset root removal (display only, for status queries) */
  targetPath?: string;
}

export type IndexTaskState = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface IndexTaskHandle {
  id: number;
  /** Terminal-state Promise (cancel = rejects; failure = rejects; callers may catch and ignore) */
  wait: Promise<void>;
  cancel(reason?: string): void;
  /** Current state snapshot (queued/running/completed/failed/cancelled) */
  state(): IndexTaskState;
}

interface ScheduledTask {
  id: number;
  seq: number;
  kind: IndexTaskKind;
  priority: number;
  filePath?: string;
  version?: number;
  targetPath?: string;
  run: () => Promise<void>;
  state: IndexTaskState;
  cancelReason?: string;
  /** The raw error thrown by the task body (passed through verbatim when handle.wait rejects) */
  error?: unknown;
  /** Terminal-state hooks (there can be several handles: merge reuse/ensureTask each attach one) */
  settleListeners: Array<() => void>;
}

export interface SchedulerMetrics {
  /** Duplicate tasks merged away for the same file and version */
  mergedTasks: number;
  /** Stale-version tasks cancelled and dropped */
  staleDropped: number;
  /** Times a background task's start was postponed under interactive pressure */
  postponedBackground: number;
  /** Cumulative wait time yielded by background tasks under interactive throttling (ms) */
  backgroundDelayMs: number;
  /** Times a failed task re-enqueued and recovered */
  recoveries: number;
}

export interface SchedulerStatus {
  queued: number;
  queuedByPriority: Record<number, number>;
  running: { id: number; kind: IndexTaskKind; priority: number; filePath?: string } | null;
  completed: number;
  failed: number;
  cancelled: number;
  /** Current state of a keyed task (e.g. initial scan); the last terminal state when no task is active */
  keyedTasks: Record<string, IndexTaskState>;
  metrics: SchedulerMetrics;
  /** When the last round turned "busy" (epoch ms); null if no task ever ran (the status bar hides the build line) */
  lastBuildStartedAt: number | null;
  /** When the last round "drained" (epoch ms; queue empty + no running task after a settle); null if it never finished */
  lastBuildCompletedAt: number | null;
}

interface KeyedEntry {
  state: IndexTaskState;
  promise: Promise<void> | null;
  id: number | null;
}

export interface IndexSchedulerOptions {
  /**
   * Interactive cooldown window (ms): within this span after the last
   * interactive task enqueued/finished, background tasks do not start.
   * Defaults to 50ms — during editing bursts (continuous typing) every
   * keystroke refreshes the window so the full index keeps yielding; after
   * idleness background progress resumes within one window.
   */
  interactiveCooldownMs?: number;
}

const DEFAULT_INTERACTIVE_COOLDOWN_MS = 50;

/**
 * Interactive activity beacon (RUST-TRACK-FREEZE-007 cut 1): the moment the
 * last interactive task enqueued/finished (performance.now convention, the
 * same clock as the scheduler's cooldown window). Background floods outside
 * the scheduler (e.g. corpus mirroring chunking) yield based on it — inside
 * the cooldown window = the user is interacting, background yields an extra
 * beat, reusing this module's interactiveCooldownMs as the single
 * convention instead of building another clock. Shared at module level:
 * the scheduler instance is assembled in languageServices and the mirroring
 * entry sits in gate wiring; only a module-level beacon lets both sides read
 * the same value.
 */
export const interactiveActivityBeacon = { lastAt: -Number.MAX_VALUE };

export class IndexScheduler {
  private readonly tasks = new Map<number, ScheduledTask>();
  private queueOrder: number[] = [];
  private runningId: number | null = null;
  private nextId = 1;
  private nextSeq = 1;
  private completed = 0;
  private failed = 0;
  private cancelled = 0;
  private readonly keyed = new Map<string, KeyedEntry>();
  private readonly metrics: SchedulerMetrics = {
    mergedTasks: 0,
    staleDropped: 0,
    postponedBackground: 0,
    backgroundDelayMs: 0,
    recoveries: 0
  };
  private lastInteractiveEnqueueAt = -Number.MAX_VALUE;
  private lastInteractiveEndAt = -Number.MAX_VALUE;
  // Round lifecycle timestamps (batch B index build timing face): busy-start
  // = the first task starts running after idle, drained = the queue is empty
  // and no task is running after any terminal state. Cancel-and-clear
  // (dispose/reset) does not count as finished — there is no "build
  // complete" fact, so completedAt is not updated.
  private buildActive = false;
  private buildStartedAt: number | null = null;
  private buildCompletedAt: number | null = null;
  private readonly interactiveCooldownMs: number;
  private throttleTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(options: IndexSchedulerOptions = {}) {
    this.interactiveCooldownMs = options.interactiveCooldownMs ?? DEFAULT_INTERACTIVE_COOLDOWN_MS;
  }

  /** Enqueues a task; returns a handle (wait rejects on cancel/failure, callers catch it themselves) */
  enqueue(spec: IndexTaskSpec): IndexTaskHandle {
    if (this.disposed) {
      const wait = Promise.reject(new Error('index scheduler disposed'));
      // Guard against unhandled rejection noise: the process survives even if the caller never catches
      wait.catch(() => undefined);
      return { id: -1, wait, cancel: () => undefined, state: () => 'cancelled' as IndexTaskState };
    }

    if (isInteractivePriority(spec.priority)) {
      this.lastInteractiveEnqueueAt = performance.now();
      interactiveActivityBeacon.lastAt = this.lastInteractiveEnqueueAt;
    }

    // Same-file merge/staleness adjudication: only applies to tasks carrying
    // filePath (file-less tasks like the initial scan never merge)
    if (spec.filePath !== undefined) {
      const sameFile = this.queueOrder
        .map(id => this.tasks.get(id))
        .filter((task): task is ScheduledTask => task !== undefined && task.filePath === spec.filePath);
      const sameVersion = sameFile.find(task => task.version === spec.version);
      if (sameVersion) {
        // ② same file and version: merge into one, take the higher priority (smaller number)
        this.metrics.mergedTasks += 1;
        if (spec.priority < sameVersion.priority) {
          sameVersion.priority = spec.priority;
          sameVersion.kind = spec.kind;
        }
        return this.handleOf(sameVersion);
      }
      const newer = sameFile.find(
        task => task.version !== undefined && spec.version !== undefined && task.version > spec.version
      );
      if (newer) {
        // ② the new task is older than an existing same-file queued task: drop the new task (stale)
        this.metrics.staleDropped += 1;
        const wait = Promise.reject(new Error(`stale task dropped for ${spec.filePath}`));
        wait.catch(() => undefined);
        return { id: -1, wait, cancel: () => undefined, state: () => 'cancelled' as IndexTaskState };
      }
      // Older-version tasks for the same file exist in the queue: cancel and
      // drop them, yielding to the new version
      for (const task of sameFile) {
        if (task.version !== undefined && spec.version !== undefined && task.version < spec.version) {
          this.cancelQueued(task, 'stale-version');
        }
      }
    }

    const task: ScheduledTask = {
      id: this.nextId++,
      seq: this.nextSeq++,
      kind: spec.kind,
      priority: spec.priority,
      filePath: spec.filePath,
      version: spec.version,
      targetPath: spec.targetPath,
      run: spec.run,
      state: 'queued',
      settleListeners: []
    };
    this.tasks.set(task.id, task);
    this.queueOrder.push(task.id);
    this.schedulePump();
    return this.handleOf(task);
  }

  /**
   * Keyed singleton tasks (initial scan etc.): an in-progress same key is
   * reused directly; after the last attempt failed/was cancelled, calling
   * again re-enqueues — failure is never cached as permanent pending, later
   * requests can recover (④).
   */
  ensureTask(key: string, factory: () => IndexTaskSpec): Promise<void> {
    const entry = this.keyed.get(key);
    if (entry && entry.promise && (entry.state === 'queued' || entry.state === 'running')) {
      return entry.promise;
    }
    if (entry && (entry.state === 'failed' || entry.state === 'cancelled')) {
      this.metrics.recoveries += 1;
    }
    const spec = factory();
    const handle = this.enqueue(spec);
    const record: KeyedEntry = { state: handle.state(), promise: handle.wait, id: handle.id };
    this.keyed.set(key, record);
    void handle.wait.then(
      () => {
        if (this.keyed.get(key) === record) { record.state = 'completed'; }
      },
      () => {
        if (this.keyed.get(key) === record) {
          record.state = handle.state() === 'cancelled' ? 'cancelled' : 'failed';
        }
      }
    );
    return handle.wait;
  }

  /** Whether a keyed task completed (convenience face for status queries) */
  isKeyedComplete(key: string): boolean {
    return this.keyed.get(key)?.state === 'completed';
  }

  getStatus(): SchedulerStatus {
    const queuedByPriority: Record<number, number> = {};
    for (const id of this.queueOrder) {
      const task = this.tasks.get(id);
      if (!task) { continue; }
      queuedByPriority[task.priority] = (queuedByPriority[task.priority] ?? 0) + 1;
    }
    const running = this.runningId !== null ? this.tasks.get(this.runningId) : undefined;
    const keyedTasks: Record<string, IndexTaskState> = {};
    for (const [key, entry] of this.keyed) {
      keyedTasks[key] = entry.state;
    }
    return {
      queued: this.queueOrder.length,
      queuedByPriority,
      running: running
        ? { id: running.id, kind: running.kind, priority: running.priority, filePath: running.filePath }
        : null,
      completed: this.completed,
      failed: this.failed,
      cancelled: this.cancelled,
      keyedTasks,
      metrics: { ...this.metrics },
      lastBuildStartedAt: this.buildStartedAt,
      lastBuildCompletedAt: this.buildCompletedAt
    };
  }

  /** Cancels all queued tasks (running ones are not interrupted); used for bulk cleanup before dispose */
  cancelQueuedTasks(reason = 'scheduler-reset'): number {
    const ids = [...this.queueOrder];
    for (const id of ids) {
      const task = this.tasks.get(id);
      if (task) { this.cancelQueued(task, reason); }
    }
    return ids.length;
  }

  dispose(): void {
    this.disposed = true;
    if (this.throttleTimer !== null) {
      clearTimeout(this.throttleTimer);
      this.throttleTimer = null;
    }
    this.cancelQueuedTasks('scheduler-disposed');
  }

  private handleOf(task: ScheduledTask): IndexTaskHandle {
    let settled = false;
    const wait = new Promise<void>((resolve, reject) => {
      const check = (): void => {
        if (settled) { return; }
        if (task.state === 'completed') { settled = true; resolve(); }
        else if (task.state === 'failed' || task.state === 'cancelled') {
          settled = true;
          reject(task.error ?? new Error(
            `task #${task.id} ${task.state}${task.cancelReason ? ` (${task.cancelReason})` : ''}`
          ));
        }
      };
      // The terminal state may arrive before or after handle creation: check
      // once first, then attach the terminal hook
      check();
      if (!settled) {
        task.settleListeners.push(check);
      }
    });
    wait.catch(() => undefined);
    return {
      id: task.id,
      wait,
      cancel: (reason?: string) => {
        if (task.state === 'queued') { this.cancelQueued(task, reason ?? 'cancelled-by-handle'); }
      },
      state: () => task.state
    };
  }

  private cancelQueued(task: ScheduledTask, reason: string): void {
    const index = this.queueOrder.indexOf(task.id);
    if (index < 0 || task.state !== 'queued') { return; }
    this.queueOrder.splice(index, 1);
    task.state = 'cancelled';
    task.cancelReason = reason;
    this.cancelled += 1;
    // Synchronously write back the keyed ledger (KR-AUD-90): the promise
    // rejection callback waits for a microtask; without this write-back a
    // later ensureTask would reuse the dead id as queued (reused instead of
    // recovered).
    for (const entry of this.keyed.values()) {
      if (entry.id === task.id) { entry.state = 'cancelled'; }
    }
    this.metrics.staleDropped += reason === 'stale-version' ? 1 : 0;
    for (const listener of task.settleListeners.splice(0)) { listener(); }
    // Cancel is terminal: leave the map the same way, so stale-version tasks
    // (rapid consecutive saves) do not pile up in the map
    this.tasks.delete(task.id);
  }

  /**
   * pump is deferred to a microtask: enqueues within the same synchronous
   * batch (several index tasks triggered by one request) gather first and
   * are then sorted and started — otherwise an earlier low-priority task
   * jumps the queue synchronously and the priority queue breaks.
   */
  private pumpScheduled = false;

  private schedulePump(): void {
    if (this.pumpScheduled || this.disposed) { return; }
    this.pumpScheduled = true;
    queueMicrotask(() => {
      this.pumpScheduled = false;
      this.pump();
    });
  }

  /** Single-concurrency driver: after each task's terminal state, pick the queue head again */
  private pump(): void {
    if (this.disposed || this.runningId !== null) { return; }
    const next = this.pickNext();
    if (!next) { return; }
    this.queueOrder.splice(this.queueOrder.indexOf(next.id), 1);
    next.state = 'running';
    this.runningId = next.id;
    if (!this.buildActive) {
      this.buildActive = true;
      this.buildStartedAt = Date.now();
    }
    const operation = startLanguageServiceOperation('index-scheduler', {
      indexGeneration: next.priority
    });
    // KODE-RESP-003: run declaring a Promise return does not stop the body
    // from throwing synchronously before returning — on a direct call the
    // synchronous exception escapes before the Promise chain exists,
    // bypassing failure recording/slot clearing, and runningId is never
    // released → later tasks queue forever. Wrapping in Promise.resolve()
    // .then first moves the call into Promise context, turning a synchronous
    // throw into a rejection that flows through the unified failure closeout.
    void Promise.resolve()
      .then(() => next.run())
      .then(() => {
        next.state = 'completed';
        this.completed += 1;
        operation.end('ok');
      })
      .catch((error: unknown) => {
        // Failure never caches the "already scanned" illusion: the keyed
        // entry falls back to failed, later requests rerun (④)
        next.state = 'failed';
        next.error = error;
        this.failed += 1;
        operation.end('error');
      })
      .then(() => {
        if (this.runningId === next.id) { this.runningId = null; }
        if (isInteractivePriority(next.priority)) {
          this.lastInteractiveEndAt = performance.now();
          interactiveActivityBeacon.lastAt = this.lastInteractiveEndAt;
        }
        for (const listener of next.settleListeners.splice(0)) { listener(); }
        // Terminal-state tasks leave the map: the run closure holds the whole
        // batch of file paths and error objects, and long-session saves/scans
        // would grow the tasks Map without bound. Handles keep their state
        // through settleListeners and their own closures, not the Map;
        // queued/running queries also only look at queueOrder and runningId.
        this.tasks.delete(next.id);
        this.pump();
        // Drained settle (batch B): after the recursive pump there is still
        // nothing running/queued = this index round is over, record the
        // completion time. A queue suspended by background throttling
        // (queueOrder non-empty) does not count as drained.
        if (this.buildActive && this.runningId === null && this.queueOrder.length === 0) {
          this.buildActive = false;
          this.buildCompletedAt = Date.now();
        }
      });
  }

  private pickNext(): ScheduledTask | null {
    const candidates = this.queueOrder
      .map(id => this.tasks.get(id))
      .filter((task): task is ScheduledTask => task !== undefined);
    if (candidates.length === 0) { return null; }
    candidates.sort((left, right) => left.priority - right.priority || left.seq - right.seq);
    const head = candidates[0];
    if (isInteractivePriority(head.priority)) {
      // ③ priority order: interactive tasks always go before background tasks
      return head;
    }
    // ⑥ background throttling: within the interactive cooldown window
    // background tasks do not start, so the full index never steals the
    // main thread
    const now = performance.now();
    const sinceLastInteractive = now - Math.max(this.lastInteractiveEnqueueAt, this.lastInteractiveEndAt);
    if (sinceLastInteractive < this.interactiveCooldownMs) {
      this.metrics.postponedBackground += 1;
      this.metrics.backgroundDelayMs = Math.round(
        (this.metrics.backgroundDelayMs + (this.interactiveCooldownMs - sinceLastInteractive)) * 100
      ) / 100;
      this.scheduleThrottledPump(this.interactiveCooldownMs - sinceLastInteractive);
      return null;
    }
    return head;
  }

  private scheduleThrottledPump(delayMs: number): void {
    if (this.throttleTimer !== null || this.disposed) { return; }
    this.throttleTimer = setTimeout(() => {
      this.throttleTimer = null;
      this.pump();
    }, Math.max(1, Math.ceil(delayMs)));
  }
}
