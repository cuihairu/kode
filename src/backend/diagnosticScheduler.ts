// Diagnostic task versioning and layered scheduling (PR6 A6-1/A6-2/A6-4):
//
// 1. Versioning: every diagnostic task carries a document version token. For
//    queued tasks with the same URI under continuous editing, "latest version
//    wins" — when a stale-version task is dequeued it is counted as
//    coalescedStale and never executes; if the document has advanced by the
//    time the task runs (stale), the result is discarded and not published
//    (staleDropped). No path can publish diagnostics that do not match the
//    current version.
// 2. Layering: local layer = local validation over plain text/AST
//    (scalar/structure/manifest), recomputed only on edits to this document;
//    semantic layer = validation that depends on the semantic index,
//    recomputed when the index is invalidated. Changes to unrelated files
//    produce no diagnostic tasks for open documents (per-URI keying, natural
//    isolation), and the metrics are assertable.
// 3. Same-version skip: if the same document at the same version with the same
//    diagnostic input generation (generation, incremented when external inputs
//    such as config changes) has already been published, repeated requests are
//    skipped outright (skippedCurrentVersion).
// 4. Config switches: toggling diagnostics off clears the collection and
//    remembers disabled (nothing computed until re-enabled); sub-switch or
//    structure-switch changes trigger invalidateAll, forcing published
//    documents to recompute. Switch detection is decided precisely by
//    isDiagnosticsConfigSection, so unrelated kbengine.* config changes no
//    longer trigger a full rescan (the old behavior recomputed everything on
//    any kbengine.* change).
//
// Telemetry: every actual computation records a diagnostics event via the PR1
// instrumentation (with layer/fileKind/version), merged under the same name as
// the existing startLanguageServiceOperation('diagnostics') in extension.ts.

import { recordLanguageServiceOperation } from '../languageServiceMetrics';

/** Diagnostic layer: local = plain text/AST local validation; semantic = validation depending on the semantic index */
export type DiagnosticLayer = 'local' | 'semantic';

/** Scheduling input document surface: the common subset of vscode.TextDocument and the test stub */
export interface DiagnosticTaskDocument {
  uri: { toString(): string };
  /** Edit ordinal; a stub may lack it, hence undefined (treated as "may change every time") */
  version?: number;
}

export interface DiagnosticTaskOptions<T> {
  layer: DiagnosticLayer;
  /** Produces diagnostic items (synchronous; the compute surface of validateDocument/validateEntitiesXmlDocument) */
  compute?: () => readonly T[];
  /** IDE-DIA-005 async slicing surface: moves large-file computation out of the
   *  synchronous entry point; when provided it takes priority over compute.
   *  Returning null means abort (version already advanced, etc.), counted as
   *  stale and not published; publishing after completion also re-checks the
   *  version. */
  computeAsync?: () => Promise<readonly T[] | null>;
  /** Publish surface: diagnostics.set(uri, items) or a test collector */
  publish: (items: readonly T[]) => void;
}

export interface DiagnosticSchedulerStats {
  /** Total accepted requests (request + requestQueued) */
  requested: number;
  /** Number of computations actually executed */
  computed: number;
  /** Number of successful publishes */
  published: number;
  /** Continuous-edit coalescing: queued tasks displaced by a newer version and never executed */
  coalescedStale: number;
  /** Tasks that expired after starting: computation finished but the version had advanced, result discarded and not published */
  staleDropped: number;
  /** IDE-DIA-008: worker results arriving late after document close (or close-then-reopen), discarded */
  releasedDropped: number;
  /** Already published at the same version + same diagnostic input generation; repeated requests skip recompute */
  skippedCurrentVersion: number;
  /** Requests accepted while the switch was off (bookkeeping only, nothing computed) */
  disabledSkipped: number;
  /** Switch turned off while computing (AUD-026): old async result discarded, not written back to the collection */
  disabledAsyncDropped: number;
  /** Diagnostic input generation switched while computing (AUD-026): old config result
   *  discarded, neither published nor marking the new generation as published */
  staleGenerationDropped: number;
  /** KR-AUD-04 (DIA-1): count of async computation failures (worker crash/parse exception etc.).
   *  Failures are not rethrown (computeAndPublish returns void, callers have no catch surface);
   *  recorded here for diagnostic health observability */
  errored: number;
  /** Number of clear actions (switch-off clear / document close release) */
  cleared: number;
}

interface UriState {
  /** Document version matching the most recent publish (undefined = never published / stub without a version) */
  publishedVersion: number | undefined;
  /** Diagnostic input generation matching the most recent publish */
  publishedGeneration: number;
  /** Queued task (at most one per URI: a newer-version request displaces the older one) */
  queued: QueuedTask | null;
}

interface QueuedTask {
  /** URI key (IDE-DIA-006: post-dequeue handling still needs to look up state, so it travels with the task) */
  key: string;
  document: DiagnosticTaskDocument;
  options: DiagnosticTaskOptions<unknown>;
  /** Version token at enqueue time */
  version: number | undefined;
  /** Release epoch at enqueue time (IDE-DIA-008: mismatch before processing = document closed, discard with zero computation) */
  releaseEpoch: number;
}

/** AUD-052: round elapsed time to 0.1ms (same contract as the metrics aggregation round1, display layer only) */
function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function versionOf(document: DiagnosticTaskDocument): number | undefined {
  return typeof document.version === 'number' && Number.isFinite(document.version)
    ? document.version
    : undefined;
}

/** IDE-DIA-006 per-round time slice: upper bound on how long one flush keeps
 *  handling documents synchronously in a row. When exceeded while entries
 *  remain, yield to the host (macro-task boundary) and continue — with several
 *  documents awaiting diagnostics, one flush does not monopolize the host for
 *  all of them. Same-family contract as workspaceIndex's YIELD_SLICE_MS
 *  (25ms); the upper bound of a single continuous synchronous host segment is
 *  slice + one document computation. */
const FLUSH_SLICE_MS = 25;

/** Default yield surface: the setImmediate macro-task boundary (timers/IO/other macro tasks can interleave) */
const yieldToHostDefault = (): Promise<void> =>
  new Promise(resolve => { setImmediate(resolve); });

export interface DiagnosticSchedulerOptions {
  /** Per-round time slice in milliseconds (test injection; defaults to FLUSH_SLICE_MS) */
  sliceMs?: number;
  /** Yield surface (test injection; defaults to the setImmediate macro-task boundary) */
  yieldToHost?: () => Promise<void>;
}

export class DiagnosticScheduler {
  /** Diagnostic input generation: incremented on config switches (invalidateAll), forcing published documents to recompute */
  private generation = 0;
  private enabled = true;
  private readonly states = new Map<string, UriState>();
  /** IDE-DIA-005: in-flight async computations (removed on completion or failure alike) */
  private readonly pending = new Set<Promise<unknown>>();
  /** IDE-DIA-006: number of dequeued entries not yet processed (the honest
   *  pendingWorkload surface: inside the yield window the map side is empty,
   *  yet the residual gauge must still count unprocessed entries of the
   *  in-flight batch) */
  private drainingCount = 0;
  /** IDE-DIA-008 per-URI release epoch: incremented by releaseDocument; also
   *  incremented when stateFor creates fresh state (reopen/re-request) — all
   *  in-flight computations and dequeued entries of the previous epoch are
   *  invalidated by mismatch, so late worker results can never land in the
   *  DiagnosticCollection. */
  private readonly epochs = new Map<string, number>();
  private readonly sliceMs: number;
  private readonly yieldFn: () => Promise<void>;
  private readonly stats: DiagnosticSchedulerStats = {
    requested: 0,
    computed: 0,
    published: 0,
    coalescedStale: 0,
    staleDropped: 0,
    releasedDropped: 0,
    skippedCurrentVersion: 0,
    disabledSkipped: 0,
    disabledAsyncDropped: 0,
    staleGenerationDropped: 0,
    errored: 0,
    cleared: 0
  };

  constructor(options: DiagnosticSchedulerOptions = {}) {
    this.sliceMs = options.sliceMs ?? FLUSH_SLICE_MS;
    this.yieldFn = options.yieldToHost ?? yieldToHostDefault;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** Residual task gauge (P0-4b audit reopened 2026-10-28): queued URI count
   *  and in-flight async computation count — field acceptance observes this
   *  surface after cancel/save storms to verify no leaked residuals remain
   *  inside the host. */
  pendingWorkload(): { queued: number; inFlight: number } {
    // IDE-DIA-006: inside the yield window the map side is already empty,
    // yet dequeued-but-unprocessed entries also count
    let queued = this.drainingCount;
    for (const state of this.states.values()) {
      if (state.queued) { queued += 1; }
    }
    return { queued, inFlight: this.pending.size };
  }

  /**
   * Diagnostic switch toggle (A6-4): when off, clearAll clears the collection
   * and subsequent requests only record bookkeeping; when re-enabled, force
   * every published document to recompute. Returns whether the switch changed.
   */
  setEnabled(enabled: boolean, clearAll: () => void): boolean {
    if (this.enabled === enabled) {
      return false;
    }
    this.enabled = enabled;
    if (!enabled) {
      clearAll();
      this.stats.cleared += 1;
      // All version marks published during the off period are voided: after
      // re-enabling, even the same version must recompute once
      for (const state of this.states.values()) {
        state.publishedVersion = undefined;
      }
    } else {
      this.invalidateAll();
    }
    return true;
  }

  /** Diagnostic input change (sub-switch/structure-switch/semantic index invalidation): force published documents to recompute */
  invalidateAll(): void {
    this.generation += 1;
    for (const state of this.states.values()) {
      state.publishedVersion = undefined;
    }
  }

  /**
   * Immediate channel: synchronous compute + version guard (capture the
   * version token, re-check after computing before publishing). Already
   * published at the same version + same generation is skipped outright
   * (zero recompute for unrelated repeated requests).
   */
  request<T>(document: DiagnosticTaskDocument, options: DiagnosticTaskOptions<T>): void {
    this.stats.requested += 1;
    if (!this.enabled) {
      this.stats.disabledSkipped += 1;
      return;
    }
    const key = document.uri.toString();
    const state = this.stateFor(key);
    const version = versionOf(document);
    if (version !== undefined
      && state.publishedVersion === version
      && state.publishedGeneration === this.generation) {
      this.stats.skippedCurrentVersion += 1;
      return;
    }
    this.computeAndPublish(document, key, version, options as DiagnosticTaskOptions<unknown>);
  }

  /**
   * Queued channel (A6-1 continuous-edit coalescing): per URI only the latest
   * version task is kept; when an older version is dequeued it is counted as
   * coalescedStale and never executes. Paired with flushQueued() which
   * publishes at macro-task boundaries.
   */
  requestQueued<T>(document: DiagnosticTaskDocument, options: DiagnosticTaskOptions<T>): void {
    this.stats.requested += 1;
    if (!this.enabled) {
      this.stats.disabledSkipped += 1;
      return;
    }
    const key = document.uri.toString();
    const state = this.stateFor(key);
    const version = versionOf(document);
    if (state.queued) {
      // Displace the queued task: differing versions mean "continuous-edit
      // coalescing of a stale task"; same-version replacement does not count
      // as coalescing
      if (state.queued.version !== undefined && version !== undefined
        && state.queued.version !== version) {
        this.stats.coalescedStale += 1;
      }
    }
    state.queued = {
      key,
      document,
      options: options as DiagnosticTaskOptions<unknown>,
      version,
      releaseEpoch: this.epochs.get(key) ?? 0
    };
  }

  /** Flush queued tasks: at most one per URI (latest version), re-check the
   *  version token before publishing.
   *  IDE-DIA-006 per-round time slice: when continuous synchronous processing
   *  exceeds sliceMs while entries remain, yield to the host (macro-task
   *  boundary) and continue; tasks newly enqueued inside the yield window are
   *  incorporated by later rounds, and entries whose document advanced inside
   *  the yield window are dropped by the at-processing-time guard. The no-yield
   *  path (small batches) is tick-for-tick equivalent to the old synchronous
   *  contract — with zero yields the whole round completes atomically and the
   *  old contract is unchanged. */
  async flushQueued(): Promise<void> {
    if (!this.enabled) {
      return;
    }
    for (;;) {
      const batch = this.collectQueued();
      if (batch.length === 0) {
        return;
      }
      this.drainingCount = batch.length;
      let sliced = false;
      let roundStart = performance.now();
      for (let index = 0; index < batch.length; index += 1) {
        try {
          this.processQueuedEntry(batch[index]);
        } catch {
          // Sync compute throwing on the queued surface: the caller
          // (extension.ts `void flushQueued()`) has no catch surface —
          // rethrowing would surface as UnhandledPromiseRejection, drop every
          // remaining batch task, and wedge drainingCount; same contract as the
          // KR-AUD-04 async surface: record errored, swallow without
          // rethrowing, and entries after this one are still processed (no
          // collective punishment).
          // (The existing propagation semantics of the request() direct sync
          // path are unaffected; that entry point keeps its own behavior)
          this.stats.errored += 1;
        }
        this.drainingCount -= 1;
        if (index === batch.length - 1) {
          break;
        }
        if (performance.now() - roundStart >= this.sliceMs) {
          await this.yieldFn();
          // Switch turned off inside the yield window: remaining entries are
          // not computed (re-enable triggers invalidateAll as the recompute
          // backstop)
          if (!this.enabled) {
            this.drainingCount = 0;
            return;
          }
          sliced = true;
          roundStart = performance.now();
        }
      }
      this.drainingCount = 0;
      // Zero yields this round = synchronous atomic completion, no task could
      // have been enqueued inside the window, done;
      // yielded = collect another round, incorporating edit-enqueued tasks
      // from the yield window
      if (!sliced) {
        return;
      }
    }
  }

  /** Dequeue: take all queued map-side tasks at once (ownership transfer, concurrent flushes never double-count) */
  private collectQueued(): QueuedTask[] {
    const batch: QueuedTask[] = [];
    for (const state of this.states.values()) {
      const queued = state.queued;
      if (!queued) {
        continue;
      }
      state.queued = null;
      batch.push(queued);
    }
    return batch;
  }

  /** Process a single dequeued entry: at-processing-time guard (fresher than
   *  enqueue time) before computing and publishing */
  private processQueuedEntry(queued: QueuedTask): void {
    // IDE-DIA-008: document closed after enqueue (including closes inside the
    // yield window) → discard outright with zero computation
    if ((this.epochs.get(queued.key) ?? 0) !== queued.releaseEpoch) {
      this.stats.releasedDropped += 1;
      return;
    }
    const currentVersion = versionOf(queued.document);
    // Document advanced past the enqueued version by processing time
    // (including advances inside the yield window): stale, discard
    if (queued.version !== undefined && currentVersion !== queued.version) {
      this.stats.staleDropped += 1;
      return;
    }
    const versionState = this.states.get(queued.key);
    if (queued.version !== undefined
      && versionState
      && versionState.publishedVersion === queued.version
      && versionState.publishedGeneration === this.generation) {
      this.stats.skippedCurrentVersion += 1;
      return;
    }
    this.computeAndPublish(queued.document, queued.key, queued.version, queued.options);
  }

  hasQueuedTasks(): boolean {
    for (const state of this.states.values()) {
      if (state.queued) {
        return true;
      }
    }
    return false;
  }

  /** IDE-DIA-005: whether any async computation is in flight */
  hasPendingComputations(): boolean {
    return this.pending.size > 0;
  }

  /** IDE-DIA-005: wait until every in-flight async computation settles (test and shutdown surfaces) */
  async pendingComputations(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.all([...this.pending]);
    }
  }

  /** Document close: release the version marks and residual queued tasks
   *  (a full recompute happens on next open).
   *  IDE-DIA-008: the release epoch increments — all in-flight computations of
   *  the previous epoch and every dequeued-but-unprocessed entry mismatch the
   *  at-processing/at-publish guard, so late worker results can never land in
   *  the collection. */
  releaseDocument(document: DiagnosticTaskDocument): void {
    const key = document.uri.toString();
    const state = this.states.get(key);
    if (!state) {
      return;
    }
    if (state.queued) {
      this.stats.coalescedStale += 1;
    }
    this.states.delete(key);
    this.epochs.set(key, (this.epochs.get(key) ?? 0) + 1);
    this.stats.cleared += 1;
  }

  getStats(): DiagnosticSchedulerStats {
    return { ...this.stats };
  }

  resetStats(): void {
    for (const key of Object.keys(this.stats) as Array<keyof DiagnosticSchedulerStats>) {
      this.stats[key] = 0;
    }
  }

  /** Test and shutdown surface: clear all URI state and stats (leaves the switch/generation untouched) */
  resetForTests(): void {
    this.states.clear();
    this.epochs.clear();
    this.drainingCount = 0;
    this.resetStats();
    this.generation = 0;
    this.enabled = true;
  }

  private stateFor(key: string): UriState {
    let state = this.states.get(key);
    if (!state) {
      state = { publishedVersion: undefined, publishedGeneration: -1, queued: null };
      this.states.set(key, state);
      // IDE-DIA-008: fresh state = reopen/re-request; all residual late
      // results from the previous epoch are voided
      this.epochs.set(key, (this.epochs.get(key) ?? 0) + 1);
    }
    return state;
  }

  private computeAndPublish(
    document: DiagnosticTaskDocument,
    key: string,
    version: number | undefined,
    options: DiagnosticTaskOptions<unknown>
  ): void {
    // IDE-DIA-008: capture the current release epoch — a document close during
    // the computation (or close-then-reopen) mismatches, and the late worker
    // result is dropped before publishing
    const releaseEpoch = this.epochs.get(key) ?? 0;
    // AUD-026: capture the starting generation — if the diagnostic input
    // generation switches while the computation is in flight (config change /
    // invalidateAll), the old-config result must neither publish nor mark the
    // new generation as published
    const startedGeneration = this.generation;
    if (options.computeAsync) {
      // IDE-DIA-005: async slicing surface — large-file computation moves out
      // of the sync entry point and only publishes after re-checking the
      // version on completion; null (abort) / version advance both count as
      // stale and do not publish
      // AUD-052: the timing origin is at dispatch — taking startedAt inside
      // the then after computeAsync resolves would miss the entire compute
      // phase (a 35ms computation recorded as ~0); split: compute = compute
      // phase, publish = publish guards + publish; the sync path uses the same
      // contract
      const startedAt = performance.now();
      const computation = options.computeAsync().then(items => {
        this.pending.delete(computation);
        this.stats.computed += 1;
        const computeEnd = performance.now();
        const record = (
          fields: Omit<Parameters<typeof recordLanguageServiceOperation>[2], 'subPhases'>
        ) => {
          const elapsed = performance.now() - startedAt;
          const compute = round1(computeEnd - startedAt);
          recordLanguageServiceOperation('diagnostics', elapsed, {
            ...fields,
            subPhases: { compute, publish: round1(elapsed - (computeEnd - startedAt)) }
          });
        };
        if (items === null) {
          this.stats.staleDropped += 1;
          return;
        }
        // Publish guard: the document advanced during the computation (reentrancy
        // / orchestration) → the result no longer matches the new version, discard
        if (version !== undefined && versionOf(document) !== version) {
          this.stats.staleDropped += 1;
          record({ status: 'ok', fileKind: 'def', documentVersion: version, cacheMisses: 1 });
          return;
        }
        // Publish guard: the document was closed during the computation (or
        // closed and reopened into a new epoch) → do not write the collection
        if ((this.epochs.get(key) ?? 0) !== releaseEpoch) {
          this.stats.releasedDropped += 1;
          record({ status: 'ok', fileKind: 'def', documentVersion: version, cacheMisses: 1 });
          return;
        }
        // AUD-026 publish guard: the switch turned off while computing → the old
        // async result is not written back to the collection
        if (!this.enabled) {
          this.stats.disabledAsyncDropped += 1;
          record({
            status: 'ok',
            fileKind: options.layer === 'semantic' ? 'semantic' : 'def',
            documentVersion: version,
            cacheMisses: 1
          });
          return;
        }
        // AUD-026 publish guard: the generation switched while computing → the
        // old-config result is discarded (not published, and the new generation
        // is not marked published either, otherwise reopening the same version
        // would be skipped by skippedCurrentVersion)
        if (this.generation !== startedGeneration) {
          this.stats.staleGenerationDropped += 1;
          record({
            status: 'ok',
            fileKind: options.layer === 'semantic' ? 'semantic' : 'def',
            documentVersion: version,
            cacheMisses: 1
          });
          return;
        }
        options.publish(items);
        const state = this.stateFor(key);
        state.publishedVersion = version;
        state.publishedGeneration = this.generation;
        this.stats.published += 1;
        record({
          status: 'ok',
          fileKind: options.layer === 'semantic' ? 'semantic' : 'def',
          documentVersion: version,
          cacheMisses: 1
        });
      }, _error => {
        // KR-AUD-04 (DIA-1): failures are not rethrown — a rethrow leaves
        // computation rejected with no consumer (nothing but the incidental
        // Promise.all inside pendingComputations(); computeAndPublish returns
        // void so callers cannot attach a catch), and the error would only leak
        // out of the extension host as an UnhandledPromiseRejection, losing
        // information. Record the stat (errored) plus an error status point for
        // health observability and swallow it.
        // The existing throw semantics of the sync compute path (called
        // synchronously from :489 onwards) are unaffected.
        this.pending.delete(computation);
        this.stats.errored += 1;
        const elapsed = performance.now() - startedAt;
        recordLanguageServiceOperation('diagnostics', elapsed, {
          status: 'error',
          fileKind: options.layer === 'semantic' ? 'semantic' : 'def',
          documentVersion: version,
          cacheMisses: 1,
          subPhases: { compute: round1(elapsed), publish: 0 }
        });
      });
      this.pending.add(computation);
      return;
    }
    const startedAt = performance.now();
    const items = options.compute!();
    this.stats.computed += 1;
    const computeEnd = performance.now();
    const record = (
      fields: Omit<Parameters<typeof recordLanguageServiceOperation>[2], 'subPhases'>
    ) => {
      const elapsed = performance.now() - startedAt;
      const compute = round1(computeEnd - startedAt);
      recordLanguageServiceOperation('diagnostics', elapsed, {
        ...fields,
        subPhases: { compute, publish: round1(elapsed - (computeEnd - startedAt)) }
      });
    };
    // Publish guard: the document advanced during the computation (reentrancy
    // / orchestration) → the result no longer matches the new version, discard
    if (version !== undefined && versionOf(document) !== version) {
      this.stats.staleDropped += 1;
      record({ status: 'ok', fileKind: 'def', documentVersion: version, cacheMisses: 1 });
      return;
    }
    // Publish guard (IDE-DIA-008): the document was closed during a synchronous
    // compute → do not write the collection
    if ((this.epochs.get(key) ?? 0) !== releaseEpoch) {
      this.stats.releasedDropped += 1;
      record({ status: 'ok', fileKind: 'def', documentVersion: version, cacheMisses: 1 });
      return;
    }
    options.publish(items);
    const state = this.stateFor(key);
    state.publishedVersion = version;
    state.publishedGeneration = this.generation;
    this.stats.published += 1;
    record({
      status: 'ok',
      fileKind: options.layer === 'semantic' ? 'semantic' : 'def',
      documentVersion: version,
      cacheMisses: 1
    });
  }
}

/**
 * Diagnostics-relevant config arbitration (A6-4): only changes to these
 * sections are allowed to trigger recomputation of open documents. The old
 * behavior rescanned on any kbengine.* change (hover/jumpLog/codeLens…),
 * recomputing every open document on unrelated config changes —
 * isDiagnosticsConfigSection closes that gap.
 */
const DIAGNOSTICS_CONFIG_SECTIONS = [
  'kbengine.enableDiagnostics',
  'kbengine.enableStructureDiagnostics',
  'kbengine.diagnostics'
] as const;

export function isDiagnosticsConfigSection(section: string): boolean {
  return DIAGNOSTICS_CONFIG_SECTIONS.some(prefix =>
    section === prefix || section.startsWith(`${prefix}.`));
}

/** Process-level shared instance: the diagnostic event surface in extension.ts and tests share the same stats */
let sharedScheduler: DiagnosticScheduler | null = null;

export function getDiagnosticScheduler(): DiagnosticScheduler {
  if (!sharedScheduler) {
    sharedScheduler = new DiagnosticScheduler();
  }
  return sharedScheduler;
}

/** Test surface: reset the shared scheduler (stats/queue/generation/switch all zeroed) */
export function resetDiagnosticSchedulerForTests(): void {
  getDiagnosticScheduler().resetForTests();
}
