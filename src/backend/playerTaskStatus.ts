/**
 * Keeping the most recent state of the UX-REVIEW-008a player query/connection check (pure
 * logic, zero vscode):
 * - six-state distinction: not-run / running / empty / success / failed / cancelled;
 * - each task (player query / connection check) keeps its most recent state and result time,
 *   reviewable afterwards;
 * - the result entry = the command id that opens the "Player Data (read-only)" output channel
 *   (the result details land in the channel);
 * - the monotonic attempt counter `attempts` is reserved as the guard basis for 008c (a stale
 *   asynchronous result must not overwrite a newer task).
 * The presentation mapping (tree nodes / wording) lives in the playerDataPanel gluing face;
 * this module only holds state facts.
 */

export type PlayerTaskKind = 'query' | 'connection';

export type PlayerTaskOutcome =
  | 'not-run'
  | 'running'
  | 'empty'
  | 'success'
  | 'failed'
  | 'cancelled';

export interface PlayerTaskStatus {
  readonly task: PlayerTaskKind;
  readonly outcome: PlayerTaskOutcome;
  /** A one-line summary (no passwords or plaintext connection elements; carries the target identity = host:port/db or dbid) */
  readonly summary: string;
  /** Completion moment (epoch ms); absent for not-run/running */
  readonly finishedAt?: number;
  /** Result entry: the command id that opens the result-detail output channel; absent for not-run/running */
  readonly detailCommandId?: string;
  /** Monotonic attempt counter (assigned at begin; the credential for the 008c stale-result guard) */
  readonly attempt: number;
}

/** Result entry command: opens the read-only player-data output channel (the only landing place for result details) */
export const PLAYER_TASK_RESULT_COMMAND = 'kbengine.playerData.showResult';

/**
 * Source strings for the six-state labels (UX-REVIEW-010d): the values = English source
 * strings, and the presentation face fetches wording at call time via l10nText (the zh-cn
 * bundle yields Chinese); the key set maps one-to-one onto the six states, for dynamic-key
 * reconciliation.
 */
export const PLAYER_TASK_OUTCOME_LABELS: Record<PlayerTaskOutcome, string> = {
  'not-run': 'Not run',
  running: 'Running',
  empty: 'Empty result',
  success: 'Success',
  failed: 'Failed',
  cancelled: 'Cancelled'
};

/** Result time display (local time zone YYYY-MM-DD HH:mm:ss; a pure function so the format is easy to pin) */
export function formatPlayerTaskTime(epochMs: number): string {
  const d = new Date(epochMs);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

/**
 * Most-recent-state ledger: one entry per task, begin -> finish overwrites; finish only
 * accepts terminal states (empty/success/failed/cancelled) -- running/not-run are not
 * completed states.
 */
export class PlayerTaskStatusStore {
  private readonly latest = new Map<PlayerTaskKind, PlayerTaskStatus>();
  /** The attempt counter of the most recent begin per task (the stale-finish criterion) */
  private readonly currentAttempt = new Map<PlayerTaskKind, number>();
  private attempts = 0;

  /** Task started (in progress; waiting for input/connecting/executing all count as in progress); returns a status carrying the attempt credential */
  begin(task: PlayerTaskKind, summary: string): PlayerTaskStatus {
    this.attempts += 1;
    const status: PlayerTaskStatus = {
      task,
      outcome: 'running',
      summary,
      attempt: this.attempts
    };
    this.currentAttempt.set(task, this.attempts);
    this.latest.set(task, status);
    return status;
  }

  /**
   * Task completed (a terminal state; records the result time and the result entry).
   * The UX-REVIEW-008c stale asynchronous result guard: when expectedAttempt does not match
   * this task's current attempt counter (a newer begin happened in between) -> refuse the
   * write and return null, so a new task's state is not overwritten by a late result from an
   * old attempt.
   */
  finish(
    task: PlayerTaskKind,
    outcome: Extract<PlayerTaskOutcome, 'empty' | 'success' | 'failed' | 'cancelled'>,
    summary: string,
    finishedAt: number = Date.now(),
    expectedAttempt?: number
  ): PlayerTaskStatus | null {
    if (
      expectedAttempt !== undefined &&
      expectedAttempt !== this.currentAttempt.get(task)
    ) {
      return null;
    }
    const status: PlayerTaskStatus = {
      task,
      outcome,
      summary,
      finishedAt,
      detailCommandId: PLAYER_TASK_RESULT_COMMAND,
      attempt: expectedAttempt ?? this.attempts
    };
    this.latest.set(task, status);
    return status;
  }

  get(task: PlayerTaskKind): PlayerTaskStatus | undefined {
    return this.latest.get(task);
  }

  /** Tasks that already have a record (never-run tasks are not included; the presentation face renders them as not run) */
  recorded(): PlayerTaskKind[] {
    return [...this.latest.keys()];
  }

  /** Reset for tests (session state must not leak across tests) */
  clear(): void {
    this.latest.clear();
    this.currentAttempt.clear();
    this.attempts = 0;
  }

  attemptsForTests(): number {
    return this.attempts;
  }
}
