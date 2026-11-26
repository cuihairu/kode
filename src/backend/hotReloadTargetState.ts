/**
 * Hot reload state isolated by rootId and targetId (IDE-HOT-001): the hot
 * reload delivery result ledger is isolated on two dimensions — "the scanning
 * root rootId the file belongs to × the service instance targetId" — so the same
 * file sent to different instances each lands its own record, and the later
 * target's failure/success neither overrides nor reuses the earlier target's
 * green state; querying a different target never reaches a neighbour's record.
 * The later receipt face (sent_unverified/accepted/applied, HOT-002..004) all
 * tighten on this same key rather than standing up a second target identity.
 */

/** Delivery target = rootId (the scanning root the file belongs to) + targetId (the service instance) */
export interface HotReloadTargetKey {
  rootId: string;
  targetId: string;
}

export const HOT_RELOAD_TARGET_KEY_SEPARATOR = '::';

/** Stable string form of the target key (for logs/display; splitting it back is the caller's job, on ::) */
export function buildHotReloadTargetKeyId(key: HotReloadTargetKey): string {
  return `${key.rootId}${HOT_RELOAD_TARGET_KEY_SEPARATOR}${key.targetId}`;
}

/** Four states: sent unverified (green but unconfirmed) / receipt accepted (HOT-003) / applied verified (HOT-004) / failed */
export type HotReloadDeliveryOutcome = 'sent-unverified' | 'accepted' | 'applied' | 'failed';

export interface HotReloadDeliveryRecord {
  rootId: string;
  targetId: string;
  /** Absolute path */
  file: string;
  outcome: HotReloadDeliveryOutcome;
  /** Failure reason / supplementary note */
  detail?: string;
  /** Record moment (injected clock, ms) */
  recordedAt: number;
  /**
   * Send generation (IDE-AUD-005): increments on each new send for the same
   * (rootId,targetId,file). Receipts/annotations/verification settlements are
   * written back bound to their generation — a stale generation's async receipt
   * never mutates a newer generation's record (otherwise a late first-round
   * verification would flip the second round's failure into applied).
   */
  attempt: number;
  /**
   * Content sha256 frozen at send time (IDE-AUD-006): the verification baseline
   * computed by reading the sent content once before sending. Post-response
   * verification uses it and never re-reads the file's current content to
   * impersonate the sent version (nor is the decision affected if the file has
   * changed since). A failed read = no baseline (honestly undefined; the
   * verification face blocks the annotation).
   */
  sentDigest?: string;
  /**
   * Trigger source (the "who" of the IDE-HOT-102 audit five elements):
   * watcher-auto (automatic watching) / command (manual) / retry / temp-edit
   * (temporary edit); not provided = source unrecorded.
   */
  source?: string;
  /**
   * Send duration (the "duration" of the HR-STATE-007 searchable-history nine
   * elements): the milliseconds from the send-initiation anchor to the moment
   * this row lands in the ledger (receipt/failure paths); the pre-send baseline
   * freeze path has no duration (honestly undefined, never impersonating 0).
   */
  durationMs?: number;
  /**
   * Channel (the "channel" of the IDE-HOT-102 audit five elements):
   * kbengine-official/http (the deployment channel) or actionName:<name> (the
   * quick action fallback channel); not provided = channel unrecorded.
   */
  channel?: string;
  /**
   * Full module name (HR-MOD-014 dual names coexist: the name the user sees =
   * entities.fight.FightAI); paired with requestModule — absent = this record
   * has no module name (honestly not given, never guessed from the package
   * structure).
   */
  fullModule?: string;
  /**
   * Request module name (HR-MOD-014 dual names coexist: the name actually sent =
   * fight.FightAI). The dual names coexisting is the only on-site evidence for
   * tracing "the name the user sees != the name the request carries".
   */
  requestModule?: string;
}

/**
 * File version event (the HOT-VER status bar version number): the version
 * history of one file, appended in the order it happened. It only describes
 * "how many times the on-disk content changed / where the baseline is" and never
 * claims it took effect — whether it took effect is still decided by the
 * delivery receipt face (the applied dual-evidence verification), and the version
 * number is orthogonal to the five states.
 */
export type HotReloadFileVersionEventKind = 'tracked' | 'bump' | 'delivery' | 'baseline';

export interface HotReloadFileVersionEvent {
  /** Event moment (injected clock, ms) */
  at: number;
  kind: HotReloadFileVersionEventKind;
  /** The file's version after this event lands in the ledger (a monotonic integer) */
  version: number;
  /** delivery only: send = a new send, receipt = a receipt/annotation write-back */
  stage?: 'send' | 'receipt';
  outcome?: HotReloadDeliveryOutcome;
  attempt?: number;
  /** First 8 chars of the content sha256 frozen at send time (for report display; the full baseline still lives in the record's sentDigest) */
  digest8?: string;
  rootId?: string;
  targetId?: string;
  /** delivery only: full module name (HR-MOD-014 dual names coexist, sourced from the send record) */
  fullModule?: string;
  /** delivery only: request module name (HR-MOD-014 dual names coexist, sourced from the send record) */
  requestModule?: string;
}

export interface HotReloadFileVersionState {
  readonly file: string;
  /** Current on-disk version (first tracking = 1, +1 when the token changes, never rewinds) */
  version: number;
  /** Baseline version (caught up at the most recent applied whose digest matches the disk; <= version, forward only) */
  baseline: number;
  /** Last sampled on-disk version token (mtimeMs:size); undefined = not yet sampled */
  token?: string;
  /** Change sequence (tracked/bump each +1): the stable sort for "recently changed files", relying on no clock */
  seq: number;
  readonly events: HotReloadFileVersionEvent[];
}

/** The result of noteFileVersion: created / number skipped / token adopted / unchanged */
export type HotReloadFileVersionChange = 'tracked' | 'bump' | 'adopted' | 'unchanged';

/** Cap on version-history events per file (guards against unbounded growth within a session; overflow drops the oldest, the version number itself is never lost) */
export const HOT_RELOAD_VERSION_EVENT_CAP = 200;

export interface HotReloadTargetStateDeps {
  now(): number;
  /**
   * Callback after a ledger write (the IDE-HOT-100 presentation face): fired
   * once whenever any record lands in / is upgraded by the ledger (a new send,
   * a receipt upgrade, an annotation write-back); a refused stale-generation
   * write-back (record returning undefined, the record left as it was) does not
   * fire it. The wiring side uses it to refresh file tree badges / CodeLens
   * status dots so the presentation face tracks the ledger's facts (a landed
   * receipt is reflected immediately, not waiting for the next save).
   */
  onRecorded?: () => void;
  /**
   * Per-record ledger write callback (the HR-PR-06 wiring batch): fired at the
   * same point as onRecorded but carrying the final record (one per new send /
   * receipt upgrade / annotation write-back); a refused stale-generation write-
   * back does not fire it. The wiring side projects the ledger's facts into the
   * history panel from this instead of polling.
   */
  onRecord?: (record: HotReloadDeliveryRecord) => void;
  /**
   * Module dual-name resolution hook (HR-MOD-014): given a file, resolves "the
   * full name the user sees / the name actually requested" and lands it in the
   * delivery record and the version event log (to trace "the displayed name !=
   * the request name"). Returning undefined = the dual names are unresolvable
   * (honestly written as absent, never falling back to a stem to impersonate);
   * no hook provided = no dual names landed. Zero IO, pure string resolution;
   * injected by the wiring side, this face never reads configuration.
   */
  resolveModuleNames?(file: string): { fullModule: string; requestModule: string } | undefined;
}

/**
 * Two-dimensionally isolated ledger: inner rootId → targetId → file → the
 * latest record. Resending the same file for the same target = overwrite with
 * the newest one (retry semantics); zero cross-target entanglement.
 */
export class HotReloadTargetStateStore {
  private readonly now: () => number;
  private readonly onRecorded?: () => void;
  private readonly onRecord?: (record: HotReloadDeliveryRecord) => void;
  private readonly resolveModuleNames?: (file: string) => { fullModule: string; requestModule: string } | undefined;
  private readonly targets = new Map<string, Map<string, Map<string, HotReloadDeliveryRecord>>>();
  /** IDE-AUD-005: send generation counter — (rootId::targetId::file) → the number of sends that have happened */
  private readonly attempts = new Map<string, number>();
  /**
   * The HOT-VER file version book: file → version state. It shares the same
   * object and lifecycle as the delivery ledger (no separate storage): the
   * baseline lives and dies with the ledger, and the watcher event stream and
   * manual trigger paths write the same counters.
   */
  private readonly versionStates = new Map<string, HotReloadFileVersionState>();
  /** Version change sequence (tracked/bump each +1): the stable sort for "recently changed files" */
  private versionSeq = 0;

  constructor(deps: HotReloadTargetStateDeps) {
    this.now = deps.now;
    this.onRecorded = deps.onRecorded;
    this.onRecord = deps.onRecord;
    this.resolveModuleNames = deps.resolveModuleNames;
  }

  /**
   * Land one record. Two ways to write:
   * - without options.attempt = a new send (a resend = a new delivery): the
   *   generation advances and the record is overwritten with the newest one;
   * - with options.attempt = a write-back bound to its send generation
   *   (receipt/annotation/verification settlement): if the current record has
   *   already moved to a later generation (a newer send is in flight) it is
   *   refused — returns undefined and the record stays as it was, so a stale
   *   generation's async result never mutates a newer generation's record
   *   (IDE-AUD-005).
   */
  record(
    key: HotReloadTargetKey,
    file: string,
    outcome: HotReloadDeliveryOutcome,
    options: { detail?: string; now?: number; attempt?: number; sentDigest?: string; source?: string; channel?: string; fullModule?: string; requestModule?: string; durationMs?: number } = {}
  ): HotReloadDeliveryRecord | undefined {
    const attemptKey = `${buildHotReloadTargetKeyId(key)}${HOT_RELOAD_TARGET_KEY_SEPARATOR}${file}`;
    const current = this.get(key, file);
    if (options.attempt !== undefined) {
      if (!current || current.attempt !== options.attempt) {
        return undefined;
      }
      const updated: HotReloadDeliveryRecord = {
        ...current,
        outcome,
        recordedAt: options.now ?? current.recordedAt
      };
      if (options.detail !== undefined) {
        updated.detail = options.detail;
      }
      // KODE-AUD-003: the receipt path was missing options.sentDigest — both
      // hotReload.ts:377 and hotReloadRetryCommand.ts:138 carry the send-time
      // frozen content sha256 baseline into the ledger via the attempt-bound
      // write-back (the IDE-AUD-006 "auditable" requirement). This branch used
      // to fill only detail, silently dropping sentDigest, so records never had
      // a baseline and hotReloadFileState's applied baseline fell back to a
      // recomputation. Same pattern as detail: an override only when provided;
      // otherwise the old value is kept.
      if (options.sentDigest !== undefined) {
        updated.sentDigest = options.sentDigest;
      }
      // IDE-HOT-102: source/channel follow the same pattern as detail/sentDigest —
      // an override only when provided, otherwise the old value is kept (a
      // receipt write-back never touches the first send's source/channel).
      if (options.source !== undefined) {
        updated.source = options.source;
      }
      if (options.channel !== undefined) {
        updated.channel = options.channel;
      }
      // HR-MOD-014 dual names: the same pattern as source/channel, an override only when provided, otherwise the old value is kept.
      if (options.fullModule !== undefined) {
        updated.fullModule = options.fullModule;
      }
      if (options.requestModule !== undefined) {
        updated.requestModule = options.requestModule;
      }
      // HR-STATE-007 send duration: the receipt write-back is the real duration source for that send, overriding only when provided
      // in the same pattern (not provided = the pre-send baseline freeze path has no duration, never impersonating 0).
      if (options.durationMs !== undefined) {
        updated.durationMs = options.durationMs;
      }
      this.noteDeliveryEvent(file, current, updated, 'receipt');
      this.put(key, file, updated);
      this.onRecorded?.();
      this.onRecord?.(updated);
      return updated;
    }
    const attempt = (this.attempts.get(attemptKey) ?? 0) + 1;
    this.attempts.set(attemptKey, attempt);
    const record: HotReloadDeliveryRecord = {
      rootId: key.rootId,
      targetId: key.targetId,
      file,
      outcome,
      attempt,
      recordedAt: options.now ?? this.now()
    };
    if (options.detail !== undefined) {
      record.detail = options.detail;
    }
    if (options.sentDigest !== undefined) {
      record.sentDigest = options.sentDigest;
    }
    // IDE-HOT-102: the first send record carries the trigger source/channel (the audit five elements);
    // not provided = this record has no source/channel fields (the old caller faces honestly lack them; nothing is fabricated).
    if (options.source !== undefined) {
      record.source = options.source;
    }
    if (options.channel !== undefined) {
      record.channel = options.channel;
    }
    // HR-MOD-014 dual names coexist: an explicit pair takes priority, otherwise the injected resolution hook (file → dual names) is used;
    // when neither is available = this record has no dual-name fields (honestly not given; never falling back to a stem to impersonate the package structure).
    if (options.fullModule !== undefined && options.requestModule !== undefined) {
      record.fullModule = options.fullModule;
      record.requestModule = options.requestModule;
    } else {
      const names = this.resolveModuleNames?.(file);
      if (names) {
        record.fullModule = names.fullModule;
        record.requestModule = names.requestModule;
      }
    }
    if (options.durationMs !== undefined) {
      record.durationMs = options.durationMs;
    }
    this.noteDeliveryEvent(file, undefined, record, 'send');
    this.put(key, file, record);
    this.onRecorded?.();
    this.onRecord?.(record);
    return record;
  }

  /**
   * Sample the file's on-disk version (the HOT-VER status bar version number):
   * a token identical to the last one = no change; different = +1 (rolling back
   * to old content also counts as a new change — the version only moves forward
   * and never rewinds); no record and no obtainable token = no file created
   * (untracked, honestly absent). The first creation records v1 with the
   * baseline also 1. The watcher event stream and the manual trigger paths
   * share this method — the same file with the same token only +1s once, and
   * the two paths never produce two separate counters.
   */
  noteFileVersion(
    file: string,
    token: string | undefined,
    at?: number
  ): { state: HotReloadFileVersionState; change: HotReloadFileVersionChange } | undefined {
    const when = at ?? this.now();
    const existing = this.versionStates.get(file);
    if (!existing) {
      if (token === undefined) {
        return undefined;
      }
      const state: HotReloadFileVersionState = {
        file,
        version: 1,
        baseline: 1,
        token,
        seq: ++this.versionSeq,
        events: []
      };
      this.pushVersionEvent(state, { at: when, kind: 'tracked', version: 1 });
      this.versionStates.set(file, state);
      return { state, change: 'tracked' };
    }
    if (token === undefined) {
      // The on-disk version is unobtainable (stat failed): no guessing, no skipped number — return as is
      return { state: existing, change: 'unchanged' };
    }
    if (existing.token === undefined) {
      // The record came first (a manual send created the file before the token was known): the first sampling only fills in the token, without skipping a number
      existing.token = token;
      return { state: existing, change: 'adopted' };
    }
    if (existing.token === token) {
      return { state: existing, change: 'unchanged' };
    }
    existing.token = token;
    existing.version += 1;
    existing.seq = ++this.versionSeq;
    this.pushVersionEvent(existing, { at: when, kind: 'bump', version: existing.version });
    return { state: existing, change: 'bump' };
  }

  /** Version state of a tracked file (untracked = undefined; no fabricated version number) */
  fileVersion(file: string): HotReloadFileVersionState | undefined {
    return this.versionStates.get(file);
  }

  /** All tracked files (in creation order) */
  fileVersions(): HotReloadFileVersionState[] {
    return [...this.versionStates.values()];
  }

  /**
   * Catch the baseline up to the current version (HOT-VER: called when an
   * applied receipt lands and the digest matches the current disk): forward
   * only, never backward; an already-caught-up call returns false
   * (idempotent); the baseline is always <= the current version.
   */
  advanceFileVersionBaseline(file: string, at?: number): boolean {
    const state = this.versionStates.get(file);
    if (!state || state.baseline >= state.version) {
      return false;
    }
    state.baseline = state.version;
    this.pushVersionEvent(state, { at: at ?? this.now(), kind: 'baseline', version: state.version });
    return true;
  }

  /** The send-time frozen digests of every applied record for this file (across targets; none = []) */
  appliedSentDigestsForFile(file: string): string[] {
    const digests: string[] = [];
    for (const byTarget of this.targets.values()) {
      for (const byFile of byTarget.values()) {
        const record = byFile.get(file);
        if (record?.outcome === 'applied' && record.sentDigest !== undefined) {
          digests.push(record.sentDigest);
        }
      }
    }
    return digests;
  }

  /** First-tracking file creation (without a token): used when a manual send precedes any sampling; later sampling fills in the token without skipping a number */
  private ensureFileVersionState(file: string, at: number): HotReloadFileVersionState {
    const existing = this.versionStates.get(file);
    if (existing) {
      return existing;
    }
    const state: HotReloadFileVersionState = {
      file,
      version: 1,
      baseline: 1,
      seq: ++this.versionSeq,
      events: []
    };
    this.pushVersionEvent(state, { at, kind: 'tracked', version: 1 });
    this.versionStates.set(file, state);
    return state;
  }

  /**
   * Delivery events into the version history (the report face): a new send
   * pushes one event; a receipt rewriting the outcome pushes one; a
   * same-generation same-state write-back (e.g. backfilling sentDigest) merges
   * into the existing event instead of double counting. The event stamps the
   * version known at write-back time — when the on-disk sampling lags one beat,
   * the report reads in time order, while the badge number itself always
   * follows the most recent sampling.
   */
  private noteDeliveryEvent(
    file: string,
    previous: HotReloadDeliveryRecord | undefined,
    next: HotReloadDeliveryRecord,
    stage: 'send' | 'receipt'
  ): void {
    const state = this.ensureFileVersionState(file, next.recordedAt);
    if (stage === 'receipt' && previous && previous.attempt === next.attempt && previous.outcome === next.outcome) {
      const mergeTarget = [...state.events]
        .reverse()
        .find(event => event.kind === 'delivery' && event.attempt === next.attempt);
      if (mergeTarget) {
        if (mergeTarget.digest8 === undefined && next.sentDigest !== undefined) {
          mergeTarget.digest8 = next.sentDigest.slice(0, 8);
        }
        return;
      }
    }
    this.pushVersionEvent(state, {
      at: next.recordedAt,
      kind: 'delivery',
      version: state.version,
      stage,
      outcome: next.outcome,
      attempt: next.attempt,
      ...(next.sentDigest !== undefined ? { digest8: next.sentDigest.slice(0, 8) } : {}),
      rootId: next.rootId,
      targetId: next.targetId,
      // HR-MOD-014 dual names coexist: the version event log is stamped from the same source as the delivery record,
      // the on-site evidence for tracing "the displayed name != the request name" (no dual names = this event honestly has none).
      ...(next.fullModule !== undefined ? { fullModule: next.fullModule } : {}),
      ...(next.requestModule !== undefined ? { requestModule: next.requestModule } : {})
    });
  }

  private pushVersionEvent(state: HotReloadFileVersionState, event: HotReloadFileVersionEvent): void {
    state.events.push(event);
    if (state.events.length > HOT_RELOAD_VERSION_EVENT_CAP) {
      state.events.splice(0, state.events.length - HOT_RELOAD_VERSION_EVENT_CAP);
    }
  }

  private put(key: HotReloadTargetKey, file: string, record: HotReloadDeliveryRecord): void {
    let byTarget = this.targets.get(key.rootId);
    if (!byTarget) {
      byTarget = new Map();
      this.targets.set(key.rootId, byTarget);
    }
    let byFile = byTarget.get(key.targetId);
    if (!byFile) {
      byFile = new Map();
      byTarget.set(key.targetId, byFile);
    }
    byFile.set(file, record);
  }

  get(key: HotReloadTargetKey, file: string): HotReloadDeliveryRecord | undefined {
    return this.targets.get(key.rootId)?.get(key.targetId)?.get(file);
  }

  /** Targets that have records (by rootId, targetId lexicographic order; stable output) */
  targetsWithRecords(): HotReloadTargetKey[] {
    const keys: HotReloadTargetKey[] = [];
    for (const [rootId, byTarget] of [...this.targets.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      for (const targetId of [...byTarget.keys()].sort((a, b) => a.localeCompare(b))) {
        keys.push({ rootId, targetId });
      }
    }
    return keys;
  }

  /** Files with records under a target (in write order) */
  files(key: HotReloadTargetKey): string[] {
    const byFile = this.targets.get(key.rootId)?.get(key.targetId);
    return byFile ? [...byFile.keys()] : [];
  }

  clearTarget(key: HotReloadTargetKey): void {
    this.targets.get(key.rootId)?.delete(key.targetId);
  }
}
