/**
 * Hot reload save event pipeline pure core (HR-PR-04, book §19.4):
 * - Zero IO, zero vscode imports: the clock/timers/snapshot reads/syntax
 *   checks are all injected; the wiring layer decides the real
 *   implementations (same boundary as kode-vfs VFS-001 and
 *   hotReloadModuleIdentity);
 * - HR-WATCH-006 per-file debounce (trailing window) + a global max-delay
 *   cap: consecutive events on the same file merge and reschedule the
 *   window, the window is bounded by max-delay (a save storm is delayed at
 *   most until max-delay; capping is honestly recorded as a
 *   max-delay-capped reason);
 * - HR-WATCH-003/009 event source markers (save/disk-change) coalescing:
 *   when one disk write triggers both a save event and a disk event, they
 *   are merged per same-file same-pending (deduplicated, never sent twice),
 *   merged into FileChanged{uri,revision,diskHash,source,time} with the
 *   merge reason recorded;
 * - HR-WATCH-007 write stability: only emit once consecutive snapshots in a
 *   short window agree; past the probe cap, emit honestly anyway (the
 *   unstable reason is recorded); unreadable (deleted) is honestly dropped;
 * - HR-WATCH-010 canonical URI + targetId + content hash deduplication: the
 *   same content for the same target is not sent twice (HR-PR-02
 *   canonicalizeScriptFilePath reused);
 * - HR-WATCH-008 separating the dispatch fingerprint from the dedup
 *   fingerprint: the fingerprint is recorded at the moment a batch is
 *   handed to the send face (this core does not know whether delivery
 *   succeeds); a failed delivery is withdrawn by the wiring layer calling
 *   forgetSent, and the same content change is still sent -- not recorded
 *   at finalization, otherwise one failure would skip the same content
 *   forever;
 * - HR-WATCH-011 revision guard: when a response arrives and its sent
 *   revision lags the current revision, it is stale and must not be
 *   written down as a success for a newer revision (isStaleResponse is a
 *   pure check).
 *   The revision only increments with "actually sent new content" --
 *   dedup/syntax interception does not consume a number, otherwise an
 *   in-flight response for the same content would be misjudged as stale;
 * - Wave gathering: files finalized inside the same debounce window are
 *   bundled into one emit (the wave flush outlet batchFlushMs expires and
 *   gathers them), the batch outlet checks the batch preview threshold,
 *   and multiple files in the same window naturally form a batch;
 * - HR-WATCH-012 syntax gate: the injected checker failing -> blocked, never
 *   sending a half-finished product by default;
 * - HR-WATCH-014 dispose clears the queue awaiting commit (pending/wave/
 *   preview stagnation);
 * - HR-WATCH-016 batch preview: batches above the threshold only produce a
 *   preview, nothing is auto-sent, an explicit release sends them, and new
 *   batches during the stagnation merge into the same stagnant batch;
 * - HR-WATCH-017 diagnostic events: trigger/filtered/debounced/deduped/
 *   blocked/scheduled/preview/flushed are all observable via injection.
 *
 * The wiring (vscode event binding, config face, default switches) is not in
 * this core; HR-WATCH-001 "default off" conflicts with the user order of
 * 2026-11-06 (zero-config default on, auto-send on save); the user holds
 * the right to resolve the conflict, and the wiring batch decides together
 * with the config face.
 */

import { canonicalizeScriptFilePath } from './hotReloadModuleIdentity';

/** Timer injection face: this core owns the types itself, never importing src/hotReload (that would drag vscode into the test graph) */
export interface SavePipelineTimerDeps {
  readonly set: (callback: () => void, delayMs: number) => unknown;
  readonly clear: (handle: unknown) => void;
}

/** Event source: editor save / disk change (HR-WATCH-003 dedups the overlap between the native watcher and save) */
export type HotReloadEventSource = 'save' | 'disk-change';

/** HR-WATCH-009 coalesced file change record: the single shape consumed by diagnostics and sending */
export interface FileChanged {
  /** Canonicalized path (the canonicalizeScriptFilePath product; strips the file:// scheme, etc.) */
  readonly uri: string;
  /** Per-file monotonically increasing version: only the actually sent new
   *  content version increments it (dedup/syntax interception do not increment
   *  it, otherwise a deduped offer would waste a version number and an
   *  in-flight response for the same content would be misjudged as stale) */
  readonly revision: number;
  /** Content hash at send time; empty string when unreadable (honest, no guessing) */
  readonly diskHash: string;
  /** Representative event source after coalescing (the most recent one) */
  readonly source: HotReloadEventSource;
  /** Clock milliseconds */
  readonly time: number;
  /** Number of raw events coalesced into this record (>= 1) */
  readonly coalesced: number;
  /** Merge reason (diagnostic convention: debounced/disk-save-overlap/unstable and the like, one per item, joined with semicolons) */
  readonly coalesceReason: string;
}

/** HR-WATCH-017 diagnostic event type */
export type SavePipelineDiagnosticType =
  | 'trigger'
  | 'filtered'
  | 'debounced'
  | 'deduped'
  | 'blocked'
  | 'scheduled'
  | 'preview'
  | 'flushed';

export interface SavePipelineDiagnostic {
  readonly type: SavePipelineDiagnosticType;
  readonly uri?: string;
  readonly detail?: string;
  readonly time: number;
}

/** Snapshot read (injected): null=unreadable (deleted/unreadable), empty hash string=readable but unhashable */
export interface FileSnapshot {
  readonly hash: string;
  readonly content: string;
}

/** Syntax gate verdict shape (HR-WATCH-012): ok=false blocks, errors go into diagnostics one by one */
export type SyntaxVerdict = { readonly ok: boolean; readonly errors?: readonly string[] };

/** Lightweight syntax-check injection face (HR-WATCH-012): the wiring layer
 *  decides the checker itself; failing it blocks; either a synchronous verdict
 *  or a Promise verdict works (a real interpreter compile is an async face). */
export type SyntaxCheck = (content: string) => SyntaxVerdict | Promise<SyntaxVerdict>;

/** Emit mode: auto=send directly; preview-release=preview release (HR-WATCH-016) */
export type SavePipelineEmitMode = 'auto' | 'preview-release';

export interface HotReloadSavePipelineOptions {
  /** Per-file debounce window (defaults to 500ms, same value as HOT_RELOAD_DEFAULT_DEBOUNCE_MS) */
  readonly debounceMs?: number;
  /** Global maximum delay cap (defaults to 5000ms): forced flush once a pending entry exceeds it from its first event (HR-WATCH-006) */
  readonly maxDelayMs?: number;
  /** Stability window (defaults to 200ms): the write is stable only when two snapshots agree; 0=no stability waiting */
  readonly stabilityWindowMs?: number;
  /** Stability probe cap (defaults to 3): past the cap, emit honestly and record an unstable reason (HR-WATCH-007) */
  readonly maxStabilityProbes?: number;
  /** Batch preview threshold (defaults to 50): a batch that reaches more than this only previews, never releases (HR-WATCH-016) */
  readonly batchPreviewThreshold?: number;
  /**
   * Wave flush outlet (defaults to debounceMs): after the last finalization of
   * this wave, gather after the delay; multiple files in the same window form
   * one batch. 0=emit immediately on finalization (no gathering window; the
   * wiring default, matching the existing global debounce timing feel)
   */
  readonly batchFlushMs?: number;
  /** Timer injection (defaults to the real setTimeout; tests use an in-memory clock) */
  readonly timers?: SavePipelineTimerDeps;
  /** Clock injection (defaults to Date.now) */
  readonly now?: () => number;
  /** Snapshot read (injecting it enables the content face of stability waiting and the syntax gate; omitted=no stability waiting) */
  readonly readSnapshot?: (file: string) => Promise<FileSnapshot | null>;
  /** Syntax gate (injecting it enables it; omitted=no check, honestly not blocking) */
  readonly checkSyntax?: SyntaxCheck;
  /** Target ownership (part of the dedup key; defaults to empty string=no target dimension) */
  readonly targetOf?: (file: string) => string;
  /** HR-WATCH-017 diagnostic event outlet */
  readonly onDiagnostic?: (diagnostic: SavePipelineDiagnostic) => void;
  /** Emit outlet (the face consumed by sending) */
  readonly onEmit: (events: readonly FileChanged[], mode: SavePipelineEmitMode) => void;
}

/** Finalizing state: first offer time / latest event source / coalesce count / accumulated reasons / debounce timer */
interface PendingEntry {
  firstOfferAt: number;
  lastSource: HotReloadEventSource;
  coalesced: number;
  reasons: string[];
  timer: unknown;
}

/** HR-WATCH-011 revision guard (pure check): a response whose sent revision lags is stale, never recorded as a success for a newer revision */
export function isStaleResponse(sentRevision: number, currentRevision: number): boolean {
  return sentRevision < currentRevision;
}

/** HR-WATCH-010 dedup key (pure): canonical URI + targetId + content hash; all three equal means a duplicate */
export function isDuplicateUpdate(
  a: { readonly uri: string; readonly targetId: string; readonly hash: string },
  b: { readonly uri: string; readonly targetId: string; readonly hash: string }
): boolean {
  return a.uri === b.uri && a.targetId === b.targetId && a.hash === b.hash;
}

const DEFAULT_EXCLUDED_DIRS: ReadonlySet<string> = new Set([
  '.git',
  '.hg',
  '.svn',
  '.venv',
  'venv',
  'node_modules',
  '__pycache__',
  '.kbengine',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache'
]);

/** Backup/temp file shapes: .swp/.swo/.bak/.tmp/trailing ~ / leading-and-trailing # (editor locks and atomic-write leftovers) */
const isBackupLike = (name: string): boolean =>
  /\.(swp|swo|bak|tmp)$/i.test(name) || name.endsWith('~') || (name.startsWith('#') && name.endsWith('#'));

export interface WatchableFileOptions {
  /** Accepted extensions (lowercase, with the dot); defaults to only .py (the hot reload pipeline's day job is python module reload) */
  readonly extensions?: readonly string[];
  /** Script resource root set: when given, only accept files inside the roots (strict prefix + whole-segment boundary); omitted=no root restriction */
  readonly roots?: readonly string[];
  /** Extra excluded directory segments (union with the default exclusion table); omitted=only the default table */
  readonly excludedDirs?: readonly string[];
  /** RUST-337 path deny list: a hit means not accepted (strict prefix +
   * whole-segment boundary, canonicalized the same way as roots; deny wins
   * over root permission -- a file inside a permitted root but on the deny
   * list=denied); omitted=empty list (behavior unchanged verbatim). */
  readonly denyPaths?: readonly string[];
  /** RUST-337 path allow list: when given, only accept files inside the list
   * (strict prefix + whole-segment boundary, canonicalized the same way as
   * denyPaths/roots; deny wins over allow -- a file on both the deny list
   * and the allow list=denied; an empty list=no restriction, behavior
   * unchanged verbatim); omitted=empty list. */
  readonly allowPaths?: readonly string[];
}

/**
 * HR-WATCH-004 pure filter: only accept script files inside the declared
 * roots, with an accepted extension, whose directory segments are not in the
 * exclusion table, and whose file name is not a backup/temp shape.
 * Pure lexical decision, zero IO.
 */
export function isWatchableScriptFile(fsPath: string, options: WatchableFileOptions = {}): boolean {
  const posix = fsPath.replace(/\\/g, '/');
  if (posix.length === 0) {
    return false;
  }
  const segments = posix.split('/').filter(segment => segment.length > 0);
  if (segments.length === 0) {
    return false;
  }
  const name = segments[segments.length - 1];
  const extensions = options.extensions ?? ['.py'];
  if (!extensions.some(ext => name.toLowerCase().endsWith(ext))) {
    return false;
  }
  if (isBackupLike(name)) {
    return false;
  }
  const excluded = new Set([...DEFAULT_EXCLUDED_DIRS, ...(options.excludedDirs ?? [])]);
  for (const segment of segments.slice(0, -1)) {
    if (excluded.has(segment) || excluded.has(segment.toLowerCase())) {
      return false;
    }
  }
  const roots = (options.roots ?? []).map(root => canonicalizeScriptFilePath(root)).filter(root => root.length > 0);
  // RUST-337 the path deny list/allow list is canonicalized with the same whole-segment boundary as root permission; deny wins.
  const denyPaths = (options.denyPaths ?? []).map(root => canonicalizeScriptFilePath(root)).filter(root => root.length > 0);
  const allowPaths = (options.allowPaths ?? []).map(root => canonicalizeScriptFilePath(root)).filter(root => root.length > 0);
  if (denyPaths.length === 0 && roots.length === 0 && allowPaths.length === 0) {
    return true;
  }
  const canonical = canonicalizeScriptFilePath(posix);
  if (denyPaths.some(deny => canonical === deny || canonical.startsWith(`${deny}/`))) {
    return false;
  }
  if (
    allowPaths.length > 0 &&
    !allowPaths.some(allow => canonical === allow || canonical.startsWith(`${allow}/`))
  ) {
    return false;
  }
  if (roots.length === 0) {
    return true;
  }
  return roots.some(root => canonical === root || canonical.startsWith(`${root}/`));
}

/** Hot reload save event pipeline (pure core; event binding and send consumption are wired by the wiring layer) */
/** Three queues and one snapshot (HR-UI-004 live queue face; the UI consumer takes everything in one call, avoiding three round trips) */
export interface SavePipelineQueueSnapshot {
  /** Coalescing (same-file events merged, not yet finalized) */
  readonly pending: readonly string[];
  /** Preview stagnation (HR-WATCH-016 batch preview not yet released) */
  readonly previewHeld: readonly string[];
  /** Finalized this wave, not yet emitted */
  readonly wave: readonly string[];
}

export class HotReloadSavePipeline {
  private readonly debounceMs: number;
  private readonly maxDelayMs: number;
  private readonly stabilityWindowMs: number;
  private readonly maxStabilityProbes: number;
  private readonly batchPreviewThreshold: number;
  private readonly batchFlushMs: number;
  private readonly timers: SavePipelineTimerDeps;
  private readonly now: () => number;
  private readonly readSnapshot?: (file: string) => Promise<FileSnapshot | null>;
  private readonly checkSyntax?: SyntaxCheck;
  private readonly targetOf: (file: string) => string;
  private readonly onDiagnostic?: (diagnostic: SavePipelineDiagnostic) => void;
  private readonly onEmit: (events: readonly FileChanged[], mode: SavePipelineEmitMode) => void;

  private readonly pending = new Map<string, PendingEntry>();
  /** URIs currently stability-waiting/finalizing: prevents a parallel second finalization of the same file during the async two-snapshot window */
  private readonly settling = new Set<string>();
  private readonly revisionByUri = new Map<string, number>();
  private readonly lastSentByUri = new Map<string, { targetId: string; hash: string; revision: number }>();
  /** Preview-stagnant batch (HR-WATCH-016): holds finalized events, emitted as-is on release */
  private previewEvents: FileChanged[] = [];
  /** Wave buffer: files finalized inside the same debounce window form one batch, gathered when the flush outlet expires */
  private wave: FileChanged[] = [];
  private waveTimer: unknown;
  /** Whether this wave already opened its flush outlet: avoids one outlet per file, so the wave tail is not repeatedly stretched */
  private waveArmed = false;
  /**
   * HR-STATE-011 pause: the inlet keeps accepting (events accumulate inside
   * pending/the wave), the outlet (wave gathering) is held back and released
   * all at once on resume. pause only blocks wave gathering, not an explicit
   * preview release (releasing is the user clicking "send exactly this
   * batch", which does not conflict with "nothing auto-sent for now").
   */
  private paused = false;
  /**
   * HR-STATE-011 cancel: a file whose finalization is in flight (settling)
   * cannot be fully plucked right now, so it is dropped per this set before
   * it lands in the wave; a brand-new pending entry from re-offering the same
   * file is unaffected by the old marker (the marker is consumed when the
   * finalization is dropped; the older finalization lands and consumes first;
   * finalizations of the same uri never run in parallel).
   */
  private readonly cancelled = new Set<string>();
  private disposed = false;

  constructor(options: HotReloadSavePipelineOptions) {
    this.debounceMs = options.debounceMs ?? 500;
    this.maxDelayMs = options.maxDelayMs ?? 5000;
    this.stabilityWindowMs = options.stabilityWindowMs ?? 200;
    this.maxStabilityProbes = options.maxStabilityProbes ?? 3;
    this.batchPreviewThreshold = options.batchPreviewThreshold ?? 50;
    this.batchFlushMs = options.batchFlushMs ?? options.debounceMs ?? 500;
    this.timers = options.timers ?? {
      set: (callback, delayMs) => setTimeout(callback, delayMs),
      clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>)
    };
    this.now = options.now ?? (() => Date.now());
    this.readSnapshot = options.readSnapshot;
    this.checkSyntax = options.checkSyntax;
    this.targetOf = options.targetOf ?? (() => '');
    this.onDiagnostic = options.onDiagnostic;
    this.onEmit = options.onEmit;
  }

  /** Introspection: the current pending files (coalescing, not finalized) */
  pendingFiles(): string[] {
    return [...this.pending.keys()];
  }

  /** Introspection: the preview-stagnant batch files (HR-WATCH-016) */
  previewHeldFiles(): string[] {
    return this.previewEvents.map(event => event.uri);
  }

  /** Introspection: files finalized this wave but not yet emitted */
  waveFiles(): string[] {
    return this.wave.map(event => event.uri);
  }

  /** Introspection: the three-queue one-shot snapshot (HR-UI-004 live queue face taken in a single call) */
  queueSnapshot(): SavePipelineQueueSnapshot {
    return {
      pending: this.pendingFiles(),
      previewHeld: this.previewHeldFiles(),
      wave: this.waveFiles()
    };
  }

  /** Introspection: the file's current version (for the HR-WATCH-011 response-face snapshot; never finalized=0) */
  revisionOf(file: string): number {
    return this.revisionByUri.get(canonicalizeScriptFilePath(file)) ?? 0;
  }

  /**
   * Register one raw event (save or disk-change). A pending entry for the
   * same file already exists -> coalesce (coalesced+1; a disk event
   * immediately following a save records the disk-save-overlap reason, never
   * sent twice, HR-WATCH-003 overlap dedup); no pending entry -> start a new
   * debounce window.
   */
  offer(file: string, source: HotReloadEventSource): void {
    if (this.disposed) {
      return;
    }
    const uri = canonicalizeScriptFilePath(file);
    if (uri.length === 0) {
      this.diagnostic({ type: 'filtered', uri: file, detail: '路径为空,丢弃' });
      return;
    }
    const existing = this.pending.get(uri);
    const time = this.now();
    if (existing) {
      const overlap = existing.lastSource === 'save' && source === 'disk-change';
      existing.lastSource = source;
      existing.coalesced += 1;
      if (overlap) {
        existing.reasons.push('disk-save-overlap');
      }
      // Real debouncing=trailing window: another event reschedules the debounce
      // window; the window budget is capped at max-delay, so a save storm only
      // delays until max-delay and never indefinitely (HR-WATCH-006).
      // The capping truncation is honestly recorded as a reason
      // (max-delay-capped); the expiry face does not re-decide it.
      const elapsed = time - existing.firstOfferAt;
      const remaining = Math.min(this.debounceMs, Math.max(0, this.maxDelayMs - elapsed));
      if (remaining < this.debounceMs && !existing.reasons.includes('max-delay-capped')) {
        existing.reasons.push('max-delay-capped');
      }
      this.schedule(existing, uri, remaining);
      this.diagnostic({
        type: 'debounced',
        uri,
        detail: `归并第 ${existing.coalesced} 次事件(${source}),余窗 ${remaining}ms`
      });
      return;
    }
    // The first window is also capped by max-delay: when maxDelay < debounce the window is capped outright (HR-WATCH-006)
    const firstWindow = Math.min(this.debounceMs, this.maxDelayMs);
    const entry: PendingEntry = {
      firstOfferAt: time,
      lastSource: source,
      coalesced: 1,
      reasons: firstWindow < this.debounceMs ? ['max-delay-capped'] : [],
      timer: undefined
    };
    this.pending.set(uri, entry);
    this.diagnostic({ type: 'trigger', uri, detail: `${source}(第 ${entry.coalesced} 事件)` });
    this.schedule(entry, uri, firstWindow);
  }

  /** Preview release (HR-WATCH-016): the user explicitly releases the stagnant batch; no stagnation=honest empty release */
  releasePreview(): void {
    if (this.disposed || this.previewEvents.length === 0) {
      return;
    }
    const held = this.previewEvents;
    this.previewEvents = [];
    this.onEmit(held, 'preview-release');
    this.markSent(held);
    this.diagnostic({ type: 'flushed', detail: `预览放行 ${held.length} 文件` });
  }

  /**
   * HR-STATE-011 pause: hold back wave gathering (finalized/in-flight events
   * keep accumulating inside pending/wave/preview stagnation), released all at
   * once by resume on recovery. Repeated pauses are idempotent (a state flag).
   */
  pause(): void {
    this.paused = true;
  }

  /** Whether the paused wave is held back (queue-face introspection, used to present "paused, N files awaiting send") */
  isPaused(): boolean {
    return this.paused;
  }

  /**
   * HR-STATE-011 resume: clear the state flag and flush the wave immediately
   * (the batch gathered during the pause is emitted on the spot, without
   * waiting for the next flush outlet). Repeated resumes are idempotent
   * (an empty wave means no action).
   */
  resume(): void {
    this.paused = false;
    this.flushWave();
  }

  /**
   * HR-STATE-011 cancel: pluck the not-yet-emitted side of a single file and
   * return the queue it was plucked from (the caller face reports honestly
   * "where it was plucked from"; "not found"=honestly none, never a fake
   * cancel). Already-emitted batches are not recalled (the send face already
   * holds them; idempotence relies on the receipt convention, not on this
   * core rolling back).
   */
  cancel(file: string): 'pending' | 'preview-held' | 'wave' | 'in-flight' | 'none' {
    const uri = canonicalizeScriptFilePath(file);
    if (uri.length === 0) {
      return 'none';
    }
    const entry = this.pending.get(uri);
    if (entry !== undefined) {
      if (entry.timer !== undefined) {
        this.timers.clear(entry.timer);
      }
      this.pending.delete(uri);
      this.cancelled.delete(uri);
      this.diagnostic({ type: 'filtered', uri, detail: '已取消,丢弃待发事件' });
      return 'pending';
    }
    const heldBefore = this.previewEvents.length;
    this.previewEvents = this.previewEvents.filter(event => event.uri !== uri);
    if (this.previewEvents.length !== heldBefore) {
      this.diagnostic({ type: 'filtered', uri, detail: '已取消,丢弃预览滞留事件' });
      return 'preview-held';
    }
    const waveBefore = this.wave.length;
    this.wave = this.wave.filter(event => event.uri !== uri);
    if (this.wave.length !== waveBefore) {
      this.diagnostic({ type: 'filtered', uri, detail: '已取消,丢弃波次内事件' });
      return 'wave';
    }
    if (this.settling.has(uri)) {
      // Finalization in flight: cannot be plucked right now; mark it and let settle drop it before it enters the wave
      this.cancelled.add(uri);
      this.diagnostic({ type: 'filtered', uri, detail: '定稿在途,标记取消待入波前丢弃' });
      return 'in-flight';
    }
    return 'none';
  }

  /**
   * HR-WATCH-008: withdraw the fingerprint after a failed delivery so the
   * next change of the same content is still sent, never skipped forever.
   * The fingerprint itself is recorded at the moment the batch is handed to
   * the send face (see emitBatch/releasePreview); this core does not judge
   * delivery success, and on failure the wiring layer calls this method per
   * the send result.
   */
  forgetSent(file: string, revision?: number): void {
    const uri = canonicalizeScriptFilePath(file);
    if (revision === undefined || this.lastSentByUri.get(uri)?.revision === revision) {
      this.lastSentByUri.delete(uri);
    }
  }

  /** The batch has been handed to the send face: record the fingerprint now (same content, same target, never sent again) */
  private markSent(events: readonly FileChanged[]): void {
    for (const event of events) {
      if (event.diskHash.length > 0) {
        this.lastSentByUri.set(event.uri, {
          targetId: this.targetOf(event.uri),
          hash: event.diskHash,
          revision: event.revision
        });
      }
    }
  }

  /** HR-WATCH-014: deactivate/destroy clears the queue awaiting commit (pending + wave + preview stagnation); later events are no longer accepted */
  dispose(): void {
    this.disposed = true;
    for (const entry of this.pending.values()) {
      this.timers.clear(entry.timer);
    }
    this.pending.clear();
    this.settling.clear();
    this.timers.clear(this.waveTimer);
    this.waveTimer = undefined;
    this.wave = [];
    this.previewEvents = [];
  }

  private diagnostic(d: Omit<SavePipelineDiagnostic, 'time'>): void {
    this.onDiagnostic?.({ ...d, time: this.now() });
  }

  private schedule(entry: PendingEntry, uri: string, delayMs: number): void {
    this.timers.clear(entry.timer);
    entry.timer = this.timers.set(() => {
      entry.timer = undefined;
      void this.due(uri);
    }, delayMs);
    this.diagnostic({ type: 'scheduled', uri, detail: `${delayMs}ms` });
  }

  /** Single file due: stability wait -> into the wave buffer (max-delay is already capped at the window-scheduling face, HR-WATCH-006) */
  private async due(uri: string): Promise<void> {
    const entry = this.pending.get(uri);
    if (!entry || this.disposed || this.settling.has(uri)) {
      return;
    }
    // The snapshot-read face serves two things: the two-snapshot comparison of
    // the stability window (window > 0) and the content face of the syntax gate
    // (at window=0 a single snapshot is read directly -- a gate without content
    // is a dead face, so wire it honestly). Neither needed means no read.
    if (this.readSnapshot && (this.stabilityWindowMs > 0 || this.checkSyntax)) {
      await this.awaitStable(uri, entry, 0);
      return;
    }
    await this.settle(uri, entry);
  }

  /**
   * HR-WATCH-007 write stability: emit only once two snapshots agree; past
   * the probe cap, emit honestly anyway and record unstable.
   * settling guard: stability waiting is an async two-snapshot process, during
   * which re-offering the same file merely reschedules the debounce window
   * (see offer) -- never starting a second parallel stability/finalization
   * flow, otherwise the same uri would be sent twice.
   */
  private async awaitStable(uri: string, entry: PendingEntry, probe: number): Promise<void> {
    if (!this.pending.has(uri) || this.disposed) {
      return;
    }
    this.settling.add(uri);
    try {
      const first = await this.readSnapshot?.(uri);
      if (!this.pending.has(uri) || this.disposed) {
        return; // disposed/flushed away during the wait: yield honestly
      }
      if (first === null || first === undefined) {
        this.pending.delete(uri);
        this.diagnostic({ type: 'filtered', uri, detail: '读不到快照(已删除/不可读),丢弃' });
        return;
      }
      if (this.stabilityWindowMs === 0) {
        // Window 0=no stability waiting (a single snapshot is read directly):
        // one read finalizes -- the syntax gate's content face arrives through
        // here (a gate without content is a dead face); the real hash also
        // feeds the dedup fingerprint face
        await this.settle(uri, entry, first.hash, first.content);
        return;
      }
      await this.sleep(this.stabilityWindowMs);
      if (!this.pending.has(uri) || this.disposed) {
        return;
      }
      const second = await this.readSnapshot?.(uri);
      if (!this.pending.has(uri) || this.disposed) {
        return;
      }
      if (second === null || second === undefined) {
        this.pending.delete(uri);
        this.diagnostic({ type: 'filtered', uri, detail: '稳定窗内快照消失(已删除),丢弃' });
        return;
      }
      if (first.hash === second.hash) {
        await this.settle(uri, entry, second.hash, second.content);
        return;
      }
      if (probe + 1 >= this.maxStabilityProbes) {
        if (!entry.reasons.includes('unstable')) {
          entry.reasons.push(`unstable-after-${probe + 1}-probes`);
        }
        await this.settle(uri, entry, second.hash, second.content);
        return;
      }
      await this.awaitStable(uri, entry, probe + 1);
    } finally {
      this.settling.delete(uri);
      // KODE-FULL-014: a save arriving during finalization/stability waiting has
      // its debounce window bounce off the settling guard above, leaving only a
      // pending entry without a timer -- without rescheduling, the newest save
      // would have to wait for a third event to be driven (triggered whenever
      // the check takes longer than the debounce window). Check and
      // reschedule at this collection outlet, recomputing the window under the
      // same max-delay capping rule as offer, so the newest save is always
      // handled.
      const late = this.pending.get(uri);
      if (!this.disposed && late && late.timer === undefined) {
        const elapsed = this.now() - late.firstOfferAt;
        const remaining = Math.min(this.debounceMs, Math.max(0, this.maxDelayMs - elapsed));
        this.schedule(late, uri, remaining);
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise<void>(resolve => {
      const handle = this.timers.set(() => resolve(), ms);
      void handle;
    });
  }

  /** Finalize: syntax gate -> dedup -> into the wave buffer (gathered into a batch at the wave tail) */
  private async settle(uri: string, entry: PendingEntry, hash = '', content = ''): Promise<void> {
    if (!this.pending.has(uri) || this.disposed) {
      return;
    }
    this.pending.delete(uri);
    const targetId = this.targetOf(uri);
    // The syntax gate is checked only once (HR-WATCH-012): failing it blocks,
    // never sending a half-finished product by default.
    // An async checker (a real interpreter compile) waits here; a dispose
    // during that wait is caught by flushWave's disposed guard (no fake emit),
    // and re-offering goes through a brand-new pending entry, not crossing
    // batches
    if (this.checkSyntax && content.length > 0) {
      const verdict = await this.checkSyntax(content);
      if (this.disposed) {
        return;
      }
      if (!verdict.ok) {
        const errors = verdict.errors ?? [];
        this.diagnostic({
          type: 'blocked',
          uri,
          detail: errors.length > 0 ? errors.join('; ') : '语法检查未通过'
        });
        return;
      }
    }
    const lastSent = this.lastSentByUri.get(uri);
    if (
      hash.length > 0 &&
      lastSent &&
      isDuplicateUpdate({ uri, targetId, hash }, { uri, targetId: lastSent.targetId, hash: lastSent.hash })
    ) {
      this.diagnostic({ type: 'deduped', uri, detail: '同内容同目标,不重复发送' });
      return;
    }
    // HR-STATE-011 cancel: a finalization in flight marked by cancel is
    // dropped before entering the wave. The check sits after the syntax gate
    // and dedup -- a user cancel must still be accepted during an async syntax
    // gate wait (a real interpreter compile); the marker is deleted at its
    // consumption point, so a brand-new entry from re-offering the same file
    // is unaffected by the old marker (same-uri finalizations never run in
    // parallel; the older finalization consumes first). It does not consume a
    // version number: content that is never sent does not increment.
    if (this.cancelled.delete(uri)) {
      this.diagnostic({ type: 'filtered', uri, detail: '已取消,定稿不入波次' });
      return;
    }
    // The dedup fingerprint is not recorded here: this core does not know
    // whether delivery succeeds, so the fingerprint is recorded by recordSent
    // when the batch is actually emitted (otherwise one failure would skip the
    // same content forever, HR-WATCH-008).
    // The version number only increments with "actually sent new content":
    // dedup/interception does not consume a number, otherwise an in-flight
    // response for the same content would be misjudged as stale by
    // isStaleResponse (HR-WATCH-011).
    const revision = (this.revisionByUri.get(uri) ?? 0) + 1;
    this.revisionByUri.set(uri, revision);
    const event: FileChanged = {
      uri,
      revision,
      diskHash: hash,
      source: entry.lastSource,
      time: this.now(),
      coalesced: entry.coalesced,
      coalesceReason: this.coalesceReasonOf(entry)
    };
    this.wave.push(event);
    if (this.batchFlushMs === 0) {
      // Flush outlet 0=emit on finalization (the wiring default, matching the
      // existing global debounce timing feel): no gathering window is started
      // and this batch leaves the window immediately; the wave gathering
      // window (> 0) is reserved for config-face sub-batching, the core
      // mechanism is unchanged
      this.flushWave();
      return;
    }
    if (!this.waveArmed) {
      this.waveArmed = true;
      this.waveTimer = this.timers.set(() => {
        this.waveTimer = undefined;
        this.waveArmed = false;
        this.flushWave();
      }, this.batchFlushMs);
      this.diagnostic({ type: 'scheduled', uri, detail: `波次冲口 ${this.batchFlushMs}ms` });
    }
  }

  private coalesceReasonOf(entry: PendingEntry): string {
    const reasons: string[] = [...entry.reasons];
    if (entry.coalesced > 1) {
      reasons.unshift(`debounced:${entry.coalesced}`);
    }
    return reasons.length > 0 ? reasons.join(';') : 'single';
  }

  /** Wave-tail gathering: files finalized in the same window are emitted as one batch; held back while paused under HR-STATE-011 */
  private flushWave(): void {
    if (this.disposed || this.wave.length === 0 || this.paused) {
      return;
    }
    const events = this.wave;
    this.wave = [];
    this.emitBatch(events);
  }

  /** Batch outlet: above the threshold only preview, no release (HR-WATCH-016); otherwise send directly */
  private emitBatch(events: readonly FileChanged[]): void {
    if (this.previewEvents.length > 0) {
      // An stagnant batch already exists: merge into the stagnant queue to keep a single-batch shape, waiting for an explicit release
      this.previewEvents.push(...events);
      this.diagnostic({
        type: 'preview',
        detail: `批次并入预览滞留(共 ${this.previewEvents.length} 文件)`
      });
      return;
    }
    if (events.length > this.batchPreviewThreshold) {
      this.previewEvents = [...events];
      this.diagnostic({
        type: 'preview',
        detail: `批量 ${events.length} 超阈值 ${this.batchPreviewThreshold},只预览不自动发`
      });
      return;
    }
    this.onEmit(events, 'auto');
    this.markSent(events);
    this.diagnostic({ type: 'flushed', detail: `${events.length} 文件` });
  }
}
