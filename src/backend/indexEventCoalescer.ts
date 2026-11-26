/**
 * INDEX-DISCIPLINE-001 ①: index rescan event coalescer — thin TS shell
 * (Rust main path + TS fallback, pattern after the ruffLint precedent).
 *
 * User order (2026-11-18): "frequently modified files must be merged in the
 * queue, the most recently modified ones merged at the tail, repeatedly
 * reindexing the same file is wrong" + "a file may only enter the queue after
 * it has actually been saved to disk".
 *
 * Architecture split (user order: the coalescer's core logic lands in Rust,
 * TS is only a thin shell wiring vscode events):
 * - **Decision core in Rust** `$/kode/events/coalesce` (kode-server
 *   event_coalesce.rs, pure function): window-expiry judgment / dirty tail
 *   deferral / flush sorted by "most recently modified goes last";
 * - **State + timer in this TS shell** (vscode event layer properties):
 *   pending Map (latest-wins, same file merged into one) + 300ms polling
 *   clock + isDirty sampling + rescan enqueue;
 * - **TS fallback**: when the Rust gate is absent or fails, use the mirrored
 *   decision core `decideCoalesceFlush` (semantics isomorphic to Rust,
 *   vitest contract cases lock both faces to the same behavior).
 *
 * Consumer-face discipline: only "already saved to disk" change signals may
 * be pushed (onDidSave / external watcher writes); edit events (didChange)
 * are never pushed (② only recognizes disk saves — that is the dirty-marking
 * registration path of pythonClassIndex.onDocumentChanged, unrelated to this
 * shell).
 *
 * Zero vscode imports (timer / dirty sampling / enqueue are all injected;
 * unit tests drive it with a fake clock + fake callbacks).
 */

import { getKodeCoreShadowGate } from './kodeCoreShadowFaces';

/** Coalesce window (ms); same value as Rust DEFAULT_COALESCE_WINDOW_MS. */
export const INDEX_COALESCE_WINDOW_MS = 300;

/** Overall cap on dirty deferral (ms); same value as Rust DEFAULT_COALESCE_MAX_DEFER_MS. */
export const INDEX_COALESCE_MAX_DEFER_MS = 5000;

/** pending entry (the shape fed to the decision core; `first/lastPushedAtMs` are monotonic clocks). */
export interface CoalescePendingEntry {
  file: string;
  firstPushedAtMs: number;
  lastPushedAtMs: number;
}

/** Decision result: `flush` ascending by last push time (most recently modified lands at the tail). */
export interface CoalesceDecision {
  flush: string[];
  defer: string[];
  hold: number;
}

/**
 * TS mirrored decision core: isomorphic to Rust `decide_coalesce` (window
 * hold -> dirty deferral -> flush ascending by last). Fallback when Rust is
 * unavailable; the test face locks both faces to the same semantics.
 */
export function decideCoalesceFlush(
  pending: readonly CoalescePendingEntry[],
  dirtyFiles: readonly string[],
  nowMs: number,
  windowMs: number = INDEX_COALESCE_WINDOW_MS,
  maxDeferMs: number = INDEX_COALESCE_MAX_DEFER_MS
): CoalesceDecision {
  const dirty = new Set(dirtyFiles);
  const flushWithTime: Array<{ at: number; file: string }> = [];
  const defer: string[] = [];
  let hold = 0;
  for (const entry of pending) {
    const age = Math.max(0, nowMs - entry.lastPushedAtMs);
    if (age < windowMs) {
      hold += 1;
    } else if (dirty.has(entry.file) && Math.max(0, nowMs - entry.firstPushedAtMs) < maxDeferMs) {
      defer.push(entry.file);
    } else {
      flushWithTime.push({ at: entry.lastPushedAtMs, file: entry.file });
    }
  }
  flushWithTime.sort((a, b) => a.at - b.at);
  return { flush: flushWithTime.map(item => item.file), defer, hold };
}

/** Rust decision core call: no gate / failure / malformed response -> null (the caller takes the TS fallback). */
async function decideViaRust(
  pending: readonly CoalescePendingEntry[],
  dirtyFiles: readonly string[],
  nowMs: number,
  windowMs: number,
  maxDeferMs: number
): Promise<CoalesceDecision | null> {
  const gate = getKodeCoreShadowGate();
  if (!gate) { return null; }
  try {
    const response = await gate.runInRust('$/kode/events/coalesce', {
      nowMs,
      windowMs,
      maxDeferMs,
      pending: pending.map(entry => ({
        file: entry.file,
        firstPushedAtMs: entry.firstPushedAtMs,
        lastPushedAtMs: entry.lastPushedAtMs
      })),
      dirtyFiles: [...dirtyFiles]
    });
    if (!response.ok) { return null; }
    const record = response.result as Partial<CoalesceDecision> | null;
    if (!record || typeof record !== 'object' ||
        !Array.isArray(record.flush) || !Array.isArray(record.defer) ||
        typeof record.hold !== 'number') {
      return null;
    }
    return { flush: record.flush as string[], defer: record.defer as string[], hold: record.hold };
  } catch {
    return null;
  }
}

export interface IndexEventCoalescerDeps {
  /** Monotonic clock (defaults to Date.now; tests inject a fake clock). */
  now?(): number;
  /** Whether the file is currently being edited (unsaved) — the dirty sampling at flush time. */
  isDirty(file: string): boolean;
  /** Rescan enqueue face (the disk-truth consumer face, i.e. pythonClassIndex.onFileChanged). */
  enqueueReindex(file: string): void;
  /** Decision core injection (default Rust main path + TS fallback; tests can pin the mirror core directly). */
  decide?(pending: readonly CoalescePendingEntry[], dirtyFiles: readonly string[], nowMs: number): Promise<CoalesceDecision | null>;
  windowMs?: number;
  maxDeferMs?: number;
}

export interface IndexEventCoalescer {
  /** Enqueue an already-saved change (N pushes of the same file -> one Map entry, newest wins). */
  push(file: string): void;
  dispose(): void;
  /** Number of entries awaiting coalescing (status-bar tooltip observation face). */
  getPendingCount(): number;
  /** Test observation face: cumulative enqueued / queued / currently deferred counts. */
  getStatsForTests(): { pushed: number; flushed: number; deferred: number };
}

/**
 * Coalescer shell: the polling clock exists only while pending is non-empty
 * (zero timers when idle); polling cadence = window duration. flush enqueues
 * one by one in decision order (most recently modified leaves last = tail);
 * dirty-deferred entries stay in pending awaiting the next window; no
 * reentrancy while an async decision is in flight.
 */
export function createIndexEventCoalescer(deps: IndexEventCoalescerDeps): IndexEventCoalescer {
  const windowMs = deps.windowMs ?? INDEX_COALESCE_WINDOW_MS;
  const maxDeferMs = deps.maxDeferMs ?? INDEX_COALESCE_MAX_DEFER_MS;
  const pendingEntries = new Map<string, CoalescePendingEntry>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let polling = false;
  let pushed = 0;
  let flushed = 0;
  let deferred = 0;

  // Default decision chain: Rust main path, no gate / failure -> the TS mirror
  // core as backstop (the "behavior-unchanged degradation" convention from the
  // ruffLint precedent: the gate always yields an answer, and the shell never
  // jams the queue just because the decision core is absent).
  const decide = deps.decide ??
    (async (entries: readonly CoalescePendingEntry[], dirtyFiles: readonly string[], nowMs: number) =>
      (await decideViaRust(entries, dirtyFiles, nowMs, windowMs, maxDeferMs)) ??
      decideCoalesceFlush(entries, dirtyFiles, nowMs, windowMs, maxDeferMs));

  const stopTimer = (): void => {
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };

  const tick = (): void => {
    if (polling) { return; }
    if (pendingEntries.size === 0) {
      stopTimer();
      return;
    }
    polling = true;
    void (async () => {
      try {
        const now = deps.now?.() ?? Date.now();
        const entries = [...pendingEntries.values()];
        const dirtyFiles = entries.map(entry => entry.file).filter(file => deps.isDirty(file));
        const decision = await decide(entries, dirtyFiles, now);
        deferred = decision ? decision.defer.length : 0;
        for (const file of decision ? decision.flush : []) {
          if (pendingEntries.delete(file)) {
            flushed += 1;
            deps.enqueueReindex(file);
          }
        }
        if (pendingEntries.size === 0) {
          stopTimer();
        }
      } finally {
        polling = false;
      }
    })();
  };

  return {
    push(file: string): void {
      const now = deps.now?.() ?? Date.now();
      const existing = pendingEntries.get(file);
      if (existing) {
        existing.lastPushedAtMs = now;
      } else {
        pendingEntries.set(file, { file, firstPushedAtMs: now, lastPushedAtMs: now });
      }
      pushed += 1;
      if (timer === undefined) {
        timer = setInterval(tick, windowMs);
      }
    },
    dispose(): void {
      stopTimer();
      pendingEntries.clear();
    },
    getPendingCount(): number {
      return pendingEntries.size;
    },
    getStatsForTests(): { pushed: number; flushed: number; deferred: number } {
      return { pushed, flushed, deferred };
    }
  };
}
