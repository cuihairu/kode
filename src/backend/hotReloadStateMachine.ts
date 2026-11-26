/**
 * HR-STATE-001 hot reload file state model + transition table (pure core,
 * zero vscode, zero IO):
 * - a 13-state unified model folding the existing four faces' states into a
 *   single per-file state machine of movable states — the delivery ledger's
 *   four states (HotReloadDeliveryOutcome:
 *   sent-unverified/accepted/applied/failed, hotReloadTargetState.ts), the
 *   status bar's seven states (HotReloadStatusKind: watch-off/ready/
 *   ready-with-error/sending/sent-unverified/applied/failed,
 *   hotReloadStatus.ts), the pipeline queue segments
 *   (pending/previewHeld/wave, hotReloadSavePipeline.ts), and the syntax
 *   gate (blocked, HR-WATCH-012) are all projections/stages of this model;
 * - the transition table = HOT_RELOAD_STATE_TRANSITIONS (from → legal to[]),
 *   illegal transitions honestly refused (canTransition false; the state
 *   machine class's set throws). The transition table is the
 *   **definition**, not the sole runtime gate — each of the four faces
 *   keeps its own guards (IDE-AUD-005 generation binding, applied
 *   dual-evidence verification, etc.) untouched; this table only unifies
 *   the convention and never replaces the guards;
 * - state wording/stage semantics are marked per state in the comments,
 *   describing only verified facts; unconfirmed never counts as success
 *   (the same discipline as the status bar face).
 */

/** The 13-state unified model (HR-STATE-001): names match the todo lines verbatim */
export type HotReloadState =
  | 'disabled' // watching off (per target/root): not listening, not sending
  | 'idle' // watching, file stable, nothing pending to send
  | 'dirty' // file changed (save/disk change), inside the debounce window, not yet in the pipeline
  | 'queued' // in the pipeline (pending/preview-held/wave), finalization not started
  | 'checking' // stability window/syntax gate check in progress (HR-WATCH-007/012 window)
  | 'sending' // HTTP request in flight
  | 'sent_unverified' // sent (2xx) with no business receipt: unconfirmed, never called success
  | 'accepted' // server receipt accepted
  | 'applied' // receipt applied + fingerprint verification matched: verified in effect
  | 'failed' // send failed/apply failed
  | 'blocked' // held by the syntax gate/gate, not sent
  | 'restart_required' // structural def change needs an engine restart
  | 'unknown'; // result undecidable (e.g. 2xx but the state is unrecognizable)

/** Chinese labels for the states (used by the status bar/panel display face; states only verified facts) */
export const HOT_RELOAD_STATE_LABELS: Record<HotReloadState, string> = {
  disabled: '关',
  idle: '就绪',
  dirty: '待定稿',
  queued: '已入队',
  checking: '检查中',
  sending: '发送中',
  sent_unverified: '已发送(未确认)',
  accepted: '已接受',
  applied: '已应用',
  failed: '失败',
  blocked: '已拦下',
  restart_required: '需重启',
  unknown: '未知'
};

/**
 * Transition table (the HR-STATE-001 definition): from → legal to[].
 * Design basis = transitions already proven by the four existing faces
 * (receipt upgrade sent-unverified→accepted/applied/failed, re-edit after
 * apply→dirty, gate block→blocked, structural def→restart_required,
 * off/teardown→disabled) folded into one table; each row lists only
 * factually reachable targets, never unreachable/illegal transitions.
 */
export const HOT_RELOAD_STATE_TRANSITIONS: Record<HotReloadState, readonly HotReloadState[]> = {
  disabled: ['idle'], // watching enabled
  idle: ['dirty', 'disabled'], // file changed / off
  dirty: ['queued', 'disabled'], // debounce window elapsed into the pipeline / off
  queued: ['checking', 'disabled'], // finalization starts (stability window/syntax gate) / teardown
  checking: ['sending', 'blocked', 'idle', 'disabled'], // passed checks and sending / gate block / restored with no change / teardown
  sending: ['sent_unverified', 'accepted', 'applied', 'failed', 'unknown', 'disabled'],
  sent_unverified: ['accepted', 'applied', 'failed', 'dirty', 'disabled'], // late receipt / re-edit / off
  accepted: ['applied', 'failed', 'dirty', 'disabled'], // upgraded to applied / demoted to failed / re-edit / off
  applied: ['dirty', 'restart_required', 'disabled'], // re-edit / structural def change / off
  failed: ['dirty', 'restart_required', 'disabled'], // retry/re-edit / structural def change / off
  blocked: ['dirty', 'disabled'], // re-edit re-check / off
  restart_required: ['idle', 'dirty', 'disabled'], // caught up after restart / re-edit after restart / off
  unknown: ['sent_unverified', 'failed', 'dirty', 'disabled'] // decidable / verdict failed / re-edit / off
};

/** Whether a transition is legal (pure table query; illegal = honestly false, no guessing and no replacing the guards) */
export function canHotReloadTransition(from: HotReloadState, to: HotReloadState): boolean {
  return HOT_RELOAD_STATE_TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * Per-key (file/target/root) state machine: starts at unknown, set validates
 * against the transition table and throws on illegal ones
 * (StateMachineTransitionError). This is the **convention face**; the four
 * existing faces' guards stay untouched; the state machine only rejects
 * clearly illegal transitions and never makes decisions in place of the
 * guards.
 */
export class HotReloadStateMachine {
  private readonly states = new Map<string, HotReloadState>();

  get(key: string): HotReloadState {
    return this.states.get(key) ?? 'unknown';
  }

  /** Sets a state; illegal transitions throw. force=true bypasses transition validation (init/reset face). */
  set(key: string, state: HotReloadState, force = false): void {
    const current = this.get(key);
    if (!force && current !== state && !canHotReloadTransition(current, state)) {
      throw new HotReloadStateTransitionError(key, current, state);
    }
    this.states.set(key, state);
  }

  /** Sets the state and returns true if the transition is legal; returns false on illegal ones with the state untouched */
  trySet(key: string, state: HotReloadState): boolean {
    const current = this.get(key);
    if (current !== state && !canHotReloadTransition(current, state)) {
      return false;
    }
    this.states.set(key, state);
    return true;
  }

  keys(): string[] {
    return [...this.states.keys()];
  }

  clear(): void {
    this.states.clear();
  }
}

/** The honest error for an illegal transition (auditable: source key/from/to) */
export class HotReloadStateTransitionError extends Error {
  constructor(
    readonly key: string,
    readonly from: HotReloadState,
    readonly to: HotReloadState
  ) {
    super(`非法热更状态迁移 ${key}: ${from} → ${to}`);
    this.name = 'HotReloadStateTransitionError';
  }
}

/**
 * Delivery ledger four states → 13-state projection (HR-STATE-001 closeout:
 * the ledger outcome is the send-result face, sharing the convention with
 * the lifecycle states but not equivalent to them — the outcome lacks the
 * pre-send stages like dirty/queued/checking, so the projection applies
 * only when the outcome is decidable).
 */
export function projectDeliveryOutcome(
  outcome: 'sent-unverified' | 'accepted' | 'applied' | 'failed'
): HotReloadState {
  switch (outcome) {
    case 'sent-unverified':
      return 'sent_unverified';
    case 'accepted':
      return 'accepted';
    case 'applied':
      return 'applied';
    case 'failed':
      return 'failed';
  }
}

/** Status bar seven states → 13-state projection (whole-project face; the single-file convention only takes representatives: ready-class maps to idle) */
export function projectStatusKind(
  kind: 'watch-off' | 'ready' | 'ready-with-error' | 'sending' | 'sent-unverified' | 'applied' | 'failed'
): HotReloadState {
  switch (kind) {
    case 'watch-off':
      return 'disabled';
    case 'ready':
    case 'ready-with-error':
      return 'idle';
    case 'sending':
      return 'sending';
    case 'sent-unverified':
      return 'sent_unverified';
    case 'applied':
      return 'applied';
    case 'failed':
      return 'failed';
  }
}
