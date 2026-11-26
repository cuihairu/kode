import * as fs from 'fs';
import * as path from 'path';
import { performance } from 'perf_hooks';
import * as vscode from 'vscode';
import { deriveCompositionRoots, type CompositionRootMap } from '../compositionRoots';
import {
  ensureAnchorScanRoot,
  findFilesAcrossRoots,
  getIndexScanRoots,
  resolveEngineSubtreeExclusions
} from '../scanRoots';
import { PY_SCAN_EXCLUDE, PY_SCAN_EXCLUDED_DIRS, isEnginePythonLibPath } from './pythonScanRules';
import { parsePythonFile } from './pythonParser';
import type { PythonClassDef, ParsedPythonFile } from './pythonParser';
import { parsePythonFileResponsive } from './pythonParserWorkerHost';
import { checkSyntaxGate } from './syntaxGate';
import { IndexScheduler, IndexTaskPriority, interactiveActivityBeacon } from './indexScheduler';
import { SemanticDependencyGraph } from './dependencyGraph';
import {
  restoreSerializedParsedPythonFile,
  ScanProgressController,
  type ScanChunkCommit
} from './scanProgress';
import { INTERACTIVE_INDEX_WAIT_MS, raceWithBudget } from '../hoverBudget';
import { jumpLog, jumpTimeStart } from '../navigationLog';
import { getSharedFileTextCache } from './sharedFileTextCache';
import { indexLog } from './indexLog';
import { createScanStageProgressReporter } from './scanStageProgress';
import {
  recordLanguageServiceOperation,
  startLanguageServiceOperation
} from '../languageServiceMetrics';

/**
 * Python class hierarchy index (root-cause fix for mixin / cross-class jumps).
 *
 * The existing jump logic handed method ownership to the `.def` derived index
 * (entityMapping.ts:573 returns null outright for a non-`.def` mapped file, and
 * when a `.def` exists it only looks up the declaration by treating the file's
 * basename as the owner), so that "methods provided by a base class / mixin and
 * present in no .def" cannot be resolved at all. This module adds the layer
 * that is genuinely missing: **read the Python class definitions and their
 * bases, and resolve the real implementation site of `self.<method>` by the C3
 * MRO**. Jumping and CodeLens share this index.
 */

/**
 * Scan exclusion face: beyond the official three-piece set, also exclude the
 * engine's build / dependency / temporary trees.
 * Basis (measured on this machine on 2026-10-16, D:\workspaces\kbengine):
 * excluding only node_modules/ third_party/ and .git still hits 14,245 .py
 * files (vcpkg 10,108 + build 3,614 + ...), and sequential reading at an
 * average of 10.13ms per file comes out to ~144 seconds -- which is the
 * "loads for a long time before a jump" the user actually observed; after
 * narrowing, the same repo's 117 files take ~1.2 seconds. Business scripts
 * (scripts/tools etc.) are unaffected.
 */
export { PY_SCAN_EXCLUDE } from './pythonScanRules';

export { parsePythonFile, isPythonCodePosition, getPythonBaseExpressionAtPosition } from './pythonParser';
export type { PythonClassDef, ParsedPythonFile } from './pythonParser';

/** C3 linearization (the real Python3 MRO): l(X) = X + merge(l(B1), l(B2), …, [B1,B2,…]) */
/**
 * Import module name -> candidate file paths (single source of truth; was a
 * private class method, lifted out on 2026-11-24 for pythonBaseChain to reuse on
 * the same criterion -- parent-class chain resolution and the index staging
 * must not drift apart).
 * Relative imports resolve from the file's directory; absolute imports try in
 * order: the file's directory -> the scripts directory of the same role ->
 * scripts/common -> scripts/user_type -> scripts -> each ancestor directory in
 * turn. Every root yields the two candidates `<module>.py` and
 * `<module>/__init__.py`, order preserved.
 */
export function pythonImportModuleCandidates(filePath: string, rawModuleName: string): string[] {
  let moduleName = rawModuleName;
  const roots: string[] = [];
  const relative = /^\.+/.exec(moduleName)?.[0].length ?? 0;
  if (relative) {
    let root = path.dirname(filePath);
    for (let i = 1; i < relative; i += 1) { root = path.dirname(root); }
    roots.push(root);
    moduleName = moduleName.slice(relative);
  } else {
    roots.push(path.dirname(filePath));
    const scripts = filePath.replace(/\\/g, '/').match(/^(.*\/scripts)(?:\/|$)/)?.[1];
    if (scripts) {
      const role = filePath.slice(scripts.length).split(/[\\/]/)[1];
      roots.push(path.join(scripts, role), path.join(scripts, 'common'), path.join(scripts, 'user_type'), scripts);
    }
    for (let root = path.dirname(filePath); ; root = path.dirname(root)) {
      roots.push(root);
      if (root === path.dirname(root)) { break; }
    }
  }
  const targets: string[] = [];
  for (const root of [...new Set(roots)]) {
    const modulePath = path.join(root, ...moduleName.split('.').filter(Boolean));
    targets.push(modulePath + '.py', path.join(modulePath, '__init__.py'));
  }
  return targets;
}

export function linearizeC3(name: string, resolve: (base: string) => PythonClassDef[]): string[] {
  const c3merge = (lists: string[][]): string[] => {
    const out: string[] = [];
    const work = lists.filter(list => list.length > 0).map(list => list.slice());
    let guard = 0;
    while (work.some(list => list.length > 0) && guard < 5000) {
      guard += 1;
      let chosen = '';
      let found = false;
      for (const list of work) {
        if (list.length === 0) {
          continue; // a list emptied out by splice must be skipped: list[0] is undefined
        }
        const candidate = list[0];
        // a candidate must not appear in the tail of any list (apart from the first position)
        const inTail = work.some(other => other.length > 0 && other.indexOf(candidate) > 0);
        if (!inTail) {
          chosen = candidate;
          found = true;
          break;
        }
      }
      if (!found) {
        // Not linearizable (an illegal inheritance graph): flatten the remainder with de-duplication, losing no class
        for (const list of work) {
          for (const n of list) {
            if (!out.includes(n)) {
              out.push(n);
            }
          }
        }
        return out;
      }
      out.push(chosen);
      for (let i = 0; i < work.length; i += 1) {
        const idx = work[i].indexOf(chosen);
        if (idx >= 0) {
          work[i].splice(idx, 1);
        }
      }
    }
    return out;
  };

  const memo = new Map<string, string[]>();
  const inProgress = new Set<string>();
  const lin = (n: string): string[] => {
    const cached = memo.get(n);
    if (cached) {
      return cached;
    }
    if (inProgress.has(n)) {
      return [n]; // circular-inheritance guardrail: degrade to self only, no infinite recursion
    }
    inProgress.add(n);
    const defs = resolve(n);
    const bases = defs.length > 0 ? defs[0].bases : [];
    const seqs = bases.map(b => lin(b));
    if (bases.length > 0) {
      seqs.push(bases.slice());
    }
    const result = [n, ...c3merge(seqs)];
    inProgress.delete(n);
    memo.set(n, result);
    return result;
  };

  return lin(name);
}

export interface PythonMethodLocation {
  filePath: string;
  line: number;
  character: number;
  /** Name of the class providing this method (the first hit in the MRO) */
  className: string;
  /** The MRO order (for CodeLens / multiple-implementation presentation) */
  mro: string[];
  /** The class the resolution anchored on: resolved to an ancestor = the static class itself; resolved in reverse = a class inheriting the static class (the primary form) */
  anchorClass?: string;
  /** The composition root hit (entities.xml × .def × Python inheritance cross-derived; ① direct ancestor resolution may omit it) */
  compositionRoot?: string;
}

/**
 * IDE-IDX-018: the result of resolving a self method. partial=true means the
 * budget expired or the work was cancelled, so the enumeration is incomplete
 * (only ① the static MRO targets or an empty set, with ② the composition roots
 * and ③ the reverse descendants not fully searched) -- the consumer must not
 * publish an authoritative negative verdict of "a complete enumeration found
 * nothing" on that basis; only partial=false is the fully-searched criterion.
 */
export interface SelfMethodResolution {
  readonly candidates: PythonMethodLocation[];
  readonly partial: boolean;
}

/** One defining class on the MRO-CHAIN chain (class + the method definition's landing point) */
export interface MroChainEntry {
  readonly className: string;
  readonly filePath: string;
  readonly line: number;
  readonly character: number;
}

/**
 * MRO-CHAIN (user order 2026-11-18, "deriving the execution order of mixin
 * traversal calls"): one chain = the complete set of defining classes for
 * methodName along the MRO order, from one root class's viewpoint. The
 * execution order of both `for cls in __mro__` traversal dispatch and super()
 * relay equals "the MRO order filtered down to the classes that define that
 * method" -- statically derivable (C3 is determined by the base declaration
 * order); the chain order is the execution order, and the first entry is the
 * most-derived definer.
 */
export interface MroMethodChain {
  /** The viewpoint root class (the composition root itself / its descendants, or the static class itself) */
  readonly rootClassName: string;
  readonly entries: ReadonlyArray<MroChainEntry>;
}

/**
 * Workspace Python class index: scans *.py on demand to build
 * className -> definition lists, invalidating per file on change. Every query
 * goes through the cache, with no repeated parsing on hot paths.
 *
 * PR5 (removing the whole-repo block):
 * - file discovery / parsing moved into the IndexScheduler: the first scan is
 *   a background full task (a keyed discovery task + chunked full-reindex
 *   tasks), subject to interactive throttling, so the first request no longer
 *   waits for the full scan to complete;
 * - Definition first consults the snapshot + the built index, and the files a
 *   request needs (the query file / the same directory / import candidates /
 *   same-named class files) are parsed on demand as RequestLocal single-file
 *   tasks, with the background filling in the full scan;
 * - composition root derivation carries an mtime content cache (re-deriving
 *   unchanged XML/def does not re-read them) and records the source files in
 *   the SemanticDependencyGraph (PR4), so invalidation is cut off per graph
 *   and never triggers a whole-repo rebuild;
 * - explicit version numbers: the five axes
 *   classes/bases/methods/mro/compositionRoots increment independently, so
 *   tests and callers can assert "which kind of change moved which derivation
 *   layer".
 */
export type PythonIndexVersionKey =
  | 'classes'
  | 'bases'
  | 'methods'
  | 'mro'
  | 'compositionRoots';

export type PythonIndexVersions = Record<PythonIndexVersionKey, number>;

/** Node key of the composition-root derived product in the dependency graph (PR4 SemanticDependencyGraph) */
export const COMPOSITION_ROOTS_NODE = 'python:composition-roots';

/**
 * Full-scan chunk size (ENGINE-LIB-SCAN-005 blade 4: 16 -> 4). One chunk = N
 * files of contiguous main-thread occupation (files under 256KB all go through
 * parsePythonFile, purely synchronous); the larger the chunk, the longer each
 * occupation -- lib-scale files inflated the 16-file chunk into periodic
 * foreground jank. A 4-file chunk plus yielding to an interactive cooldown
 * before each chunk compresses the background occupation's granularity to
 * something interactive work can preempt. The benefit of concurrent reads at
 * this chunk shape is compensated by pipelining between chunks (the chunk
 * itself runs as a scheduler background task).
 */
export const SCAN_CHUNK_SIZE = 4;
/**
 * Interactive cooldown window before a chunk (ENGINE-LIB-SCAN-005 blade 4; the
 * same value as indexScheduler's DEFAULT_INTERACTIVE_COOLDOWN_MS, one single
 * criterion -- the same decision shape as kodeCoreCorpusMirror's
 * defaultMirrorYield).
 */
export const SCAN_INTERACTIVE_COOLDOWN_MS = 50;
/**
 * Yielding wait duration before a chunk (a pure function; the clock read sits on
 * the caller): when the interactive beacon was just refreshed (inside the
 * cooldown window) wait until it leaves the window before parsing this chunk;
 * a stale beacon or a clock anomaly (negative difference) both return 0,
 * yielding nothing.
 */
export function scanChunkYieldDelayMs(now: number, beaconAt: number): number {
  const since = now - beaconAt;
  return since >= 0 && since < SCAN_INTERACTIVE_COOLDOWN_MS
    ? SCAN_INTERACTIVE_COOLDOWN_MS - since
    : 0;
}
/** Retry cap for the deferred parsing of files left behind by a failed chunk (a permanently unreadable file is not retried forever) */
const MAX_SCAN_RETRY_ATTEMPTS = 3;

/**
 * RUST-031: the explicit-degradation face for oversized files / a backlog over
 * budget. A parse-backlog byte budget (IDE-RES-002, 8MiB on the host side)
 * rejection is a capability limit rather than a fault -- the file does not
 * enter the index this round, hover / definition / completion may be missing or
 * stale, and the user must be able to see that; it must not land only in a log
 * that is off by default. Only one warning per file within a session (bounded
 * at 50, evicting the oldest beyond that); non-capability-limit errors such as
 * worker shutdown (a full rejection while disposing in the window-closing
 * phase) raise no warning, zero noise.
 */
const DEGRADED_NOTICE_LIMIT = 50;
const degradedNoticed = new Set<string>();
const DEGRADED_BUDGET_PREFIX = 'Python parse backlog byte budget exceeded';

/** For tests: clear the degradation-warning de-duplication table (does not touch the index instance itself) */
export function resetDegradedParseNoticeForTests(): void {
  degradedNoticed.clear();
}

function noteDegradedParse(filePath: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  if (!message.startsWith(DEGRADED_BUDGET_PREFIX)) { return; }
  if (degradedNoticed.has(filePath)) { return; }
  degradedNoticed.add(filePath);
  if (degradedNoticed.size > DEGRADED_NOTICE_LIMIT) {
    const oldest = degradedNoticed.values().next().value;
    if (oldest !== undefined) { degradedNoticed.delete(oldest); }
  }
  void vscode.window.showWarningMessage(
    `KBEngine: ${path.basename(filePath)} 超出解析积压预算,该文件的索引解析已降级`
    + '(悬停/定义/补全可能缺失或不更新);后续编辑会自动重试。'
  );
}

export class PythonClassIndex {
  private fileCache = new Map<string, { version: number; parsed: ParsedPythonFile }>();
  private byName = new Map<string, PythonClassDef[]>();
  /** Coordinating promise for the background full scan (discovery + chunked parsing; a failure clears it to allow a retry, never caching an illusion) */
  private scanPromise: Promise<void> | null = null;
  /** PR3/PR5: injected scheduler (an extension-shared instance; builds its own when constructed standalone) */
  private readonly scheduler: IndexScheduler;
  /** PR4: the Python-side dependency graph (composition-root derived products -> xml / def / py sources carrying instance assignment) */
  private readonly dependencyGraph = new SemanticDependencyGraph();
  /** Composition root derivation results (lazily built; cleared and re-derived when entity registration / types / entity definitions change) */
  private rootsMap: CompositionRootMap | null = null;
  private rootsByScope = new Map<string, CompositionRootMap>();
  private rootsPromise: Promise<void> | null = null;
  private revisions = new Map<string, number>();
  private generation = 0;
  private scanGeneration = 0;
  private documents = new Map<string, Pick<vscode.TextDocument, 'fileName' | 'version' | 'getText'>>();
  private mroCache = new Map<string, PythonClassDef[]>();
  /** De-duplication of in-progress on-demand single-file parses (RequestLocal): concurrent requests for the same file merge into one queue entry */
  private stagedRequests = new Map<string, Promise<void>>();
  /** Composition root derivation epoch: increments on each resetRoots (used to judge stability under concurrent derivation) */
  private rootsEpoch = 0;
  /** The whole-repo .py list from the most recent discovery task (in discovery order; shared by staging sorting and the scan) */
  private discoveredFiles: vscode.Uri[] | null = null;
  /** The scan generation discoveredFiles belongs to (a new generation forces re-discovery) */
  private discoveredGeneration = -1;
  /**
   * RESP-002: single-flight discovery (keyed by generation). Waiting on
   * discovery does not occupy a scheduler execution slot -- if the scheduler's
   * single concurrency slot were held by the await of a repo-wide findFiles, a
   * RequestLocal known-path fill-up could only queue up too (it yields the event
   * loop asynchronously, but not the execution slot). A generation guard keeps
   * a late result out of the cache; a failure is not cached (the next call
   * re-discovers).
   */
  private discoveredInFlight: { generation: number; promise: Promise<void> } | null = null;
  /**
   * File discovery order (a synchronous mark taken at the load entry point):
   * used for cross-file ordering of ③'s reverse candidates. Chunked loading is
   * Promise.all concurrency (:837), so completion order flips with IO timing --
   * without the mark the candidate order is indeterminate (the CI 40470720225
   * red case: the same two candidates differed only in order). The discovery
   * order settles it.
   */
  private readonly fileOrder = new Map<string, number>();
  private nextFileOrder = 0;
  /**
   * Files left behind by chunks cancelled / failed during a full scan ->
   * attempts so far. A chunk failure is no longer swallowed silently while the
   * scan generation is still marked complete (that would leave this batch
   * permanently absent without ever being parsed and with no later retry);
   * later queries use this table for a targeted fill-up parse, re-running only
   * these few files instead of rescanning the whole repo.
   */
  private pendingScanRetries = new Map<string, number>();
  /** Whether a chunk for the pending retry is already queued (prevents re-queueing on every query) */
  private scanRetryInFlight = false;
  /** In-flight promise for the reload from disk after a document closes (one per file; queries must wait for it to settle) */
  private closeReloads = new Map<string, Promise<void>>();
  /**
   * SCAN-RESUME-001: full-scan checkpoint controller (optional; the wiring
   * layer injects the index-cache directory). A checkpoint is written when a
   * chunk completes, so after an interruption files whose fingerprints match are
   * adopted straight away (the direct-take path) and only the rest is scanned.
   */
  private readonly scanProgress?: ScanProgressController;
  /** SCAN-RESUME-001 test face: resume statistics from the last full scan (adopted / actually scanned counts) */
  private lastScanResumeStats: { adopted: number; scanned: number } | null = null;
  /** Content cache of composition root sources (mtime+size fingerprint; re-deriving an unchanged file does not re-read it) */
  private rootsContentCache = new Map<string, { mtimeMs: number; size: number; content: string }>();
  /** INDEX-DISCIPLINE-001 ③: syntax gate switch (injected at the wiring point; on by default) */
  private syntaxGateEnabled: () => boolean;
  /** INDEX-DISCIPLINE-001 ③: running total of syntax-gate interceptions (how often a broken file was kept out of the index) */
  private syntaxGateSkipped = 0;
  /** Explicit derivation version axes (④): to assert "which kind of change moved which layer" */
  private indexVersions: PythonIndexVersions = {
    classes: 0, bases: 0, methods: 0, mro: 0, compositionRoots: 0
  };

  constructor(scheduler?: IndexScheduler, scanProgress?: ScanProgressController,
    /** INDEX-DISCIPLINE-001 ③: reading the syntax gate switch (on by default; the wiring point injects the real configuration). */
    syntaxGateEnabled?: () => boolean
  ) {
    this.scheduler = scheduler ?? new IndexScheduler();
    this.scanProgress = scanProgress;
    this.syntaxGateEnabled = syntaxGateEnabled ?? (() => true);
  }

  /** INDEX-DISCIPLINE-001 ③: running total of syntax-gate interceptions (a status-bar tooltip observation face). */
  getSyntaxGateSkippedCount(): number {
    return this.syntaxGateSkipped;
  }

  /** SCAN-RESUME-001: checkpoint-resume statistics from the last full scan (adopted / actually scanned; a test assertion face) */
  getScanResumeStatsForTests(): { adopted: number; scanned: number } | null {
    return this.lastScanResumeStats;
  }

  /** Explicit version query (tests / telemetry): asserting that a change touched only the affected derivation layer */
  getIndexVersion(key: PythonIndexVersionKey): number {
    return this.indexVersions[key];
  }

  getIndexVersions(): PythonIndexVersions {
    return { ...this.indexVersions };
  }

  /** PR4 dependency graph access face (invalidation-plan forensics / tests) */
  getDependencyGraph(): SemanticDependencyGraph {
    return this.dependencyGraph;
  }

  /** Entry point for backgrounding the first scan: the scheduler takes over discovery + chunked parsing, returning immediately without waiting for completion */
  scheduleBackgroundScan(): void {
    void this.ensureScanned();
  }

  /** Full-scan progress detail sink (the same shape as WARM-VISIBILITY-004):
   * injected by waitForInitialScan(onProgress) and read live when pyProgress is
   * emitted; null = no waiter, zero overhead. Cleared when attached emission
   * reaches a terminal state (an identity comparison prevents wiping out a new
   * waiter's injection by mistake). */
  private scanDetailSink: ((detail: string) => void) | null = null;

  /**
   * Wait for the full scan to finish (the acceptance checklist / test face;
   * aligned with EntityMappingManager.waitForInitialScan semantics). The
   * production request path does not call it -- a Definition's first query does
   * not wait for the full scan; only callers needing whole-repo-criterion
   * results (acceptance assertions / class-name enumeration / the background
   * warm-up phase) wait. onProgress passes through a per-file throttled
   * "python class index N/M" progress (user order 2026-11-23: the class index
   * enters the status bar).
   */
  waitForInitialScan(onProgress?: (detail: string) => void): Promise<void> {
    if (onProgress) {
      this.scanDetailSink = onProgress;
    }
    return this.ensureScanned().finally(() => {
      if (this.scanDetailSink === onProgress) {
        this.scanDetailSink = null;
      }
    });
  }

  private classKey(cls: PythonClassDef): string {
    return `${cls.filePath}::${cls.qualifiedName ?? cls.name}::${cls.startLine}`;
  }

  private compatibleContext(candidate: PythonClassDef, context: PythonClassDef): boolean {
    const parts = (file: string) => file.replace(/\\/g, '/').match(/^(.*\/scripts)\/([^/]+)\//);
    const left = parts(candidate.filePath), right = parts(context.filePath);
    if (left && right) {
      if (left[1] !== right[1]) { return false; }
      const roles = new Set(['base', 'cell', 'client', 'bots']);
      if (roles.has(left[2]) && roles.has(right[2])) { return left[2] === right[2]; }
    }
    return true;
  }

  /** Resolve an import against module paths, never against unrelated class names. */
  private resolveSymbol(filePath: string, expression: string, seen = new Set<string>(), owner?: PythonClassDef): PythonClassDef | null {
    const key = `${filePath}::${expression}`;
    if (seen.has(key)) { return null; }
    seen.add(key);
    const importedLookup = seen.size > 1;
    const parsed = this.fileCache.get(filePath)?.parsed;
    if (!parsed) { return null; }
    const scope = owner?.qualifiedName?.split('.').slice(0, -1).join('.');
    const localNames = scope ? [`${scope}.${expression}`, expression] : [expression];
    for (const localName of localNames) {
      const local = parsed.classes.filter(cls => cls !== owner &&
        (!owner || cls.startLine < owner.startLine) && (cls.qualifiedName ?? cls.name) === localName).pop();
      if (local) { return local; }
    }
    const [head, ...tail] = expression.split('.');
    const binding = parsed.imports?.get(head);
    if (binding) {
      const symbol = [binding.symbol, ...tail].filter(Boolean).join('.');
      // Python imports the first matching module; an absent symbol must not
      // fall through to another role's module with the same basename.
      for (const target of this.importModuleCandidates(filePath, binding.module)) {
        if (!this.fileCache.has(target)) { continue; }
        const resolved = this.resolveSymbol(target, symbol, seen);
        return resolved ?? null;
      }
      return null;
    }
    // A package may expose a child module without re-exporting its classes:
    // `import pkg.mix` and `from pkg import mix` both bind a module receiver.
    if (path.basename(filePath) === '__init__.py' && tail.length) {
      const child = path.join(path.dirname(filePath), head);
      for (const target of [child + '.py', path.join(child, '__init__.py')]) {
        if (this.fileCache.has(target)) { return this.resolveSymbol(target, tail.join('.'), seen); }
      }
    }
    // Compatibility for implicit KBEngine script bindings: only an unambiguous
    // definition in this runtime context is eligible.
    if (importedLookup) { return null; }
    const context = parsed.classes[0];
    const candidates = (this.byName.get(expression) ?? []).filter(cls => cls !== owner &&
      (!context || this.compatibleContext(cls, context)));
    const nearby = candidates.filter(cls => path.dirname(cls.filePath) === path.dirname(filePath));
    return nearby.length === 1 ? nearby[0] : candidates.length === 1 ? candidates[0] : null;
  }

  /** Import module name -> candidate file paths (resolution and on-demand staging share one criterion, order preserved) */
  private importModuleCandidates(filePath: string, rawModuleName: string): string[] {
    return pythonImportModuleCandidates(filePath, rawModuleName);
  }

  private mroClasses(cls: PythonClassDef): PythonClassDef[] {
    // IDE-RST-009: MRO-segment timing (python-mro-resolve) -- both the
    // cache-hit arm and the C3-linearization arm are counted, with no bypass of
    // the real query criterion
    const mroStartedAt = performance.now();
    const finish = (result: PythonClassDef[]): PythonClassDef[] => {
      recordLanguageServiceOperation('python-mro-resolve', performance.now() - mroStartedAt, {
        fileKind: 'python'
      });
      return result;
    };
    const cached = this.mroCache.get(this.classKey(cls));
    if (cached) { return finish(cached); }
    const graph = new Map<string, PythonClassDef>();
    const visit = (current: PythonClassDef): void => {
      const key = this.classKey(current);
      if (graph.has(key)) { return; }
      const bases = current.bases.map(base => this.resolveSymbol(current.filePath, base, new Set(), current)).filter((base): base is PythonClassDef => !!base);
      graph.set(key, { ...current, bases: bases.map(base => this.classKey(base)) });
      bases.forEach(visit);
    };
    visit(cls);
    const result = linearizeC3(this.classKey(cls), key => graph.has(key) ? [graph.get(key)!] : [])
      .map(key => graph.get(key)!).filter(Boolean);
    this.mroCache.set(this.classKey(cls), result);
    return finish(result);
  }

  private lookupClass(cls: PythonClassDef, methodName: string): PythonMethodLocation | null {
    const mro = this.mroClasses(cls);
    for (const provider of mro) {
      const loc = provider.methods.get(methodName);
      if (loc) { return { ...loc, filePath: provider.filePath, className: provider.name,
        mro: mro.map(item => item.name), anchorClass: cls.name }; }
    }
    return null;
  }

  /** Filesystem/configuration events invalidate the scan; open buffers survive. */
  invalidate(filePath?: string, changeKind: 'change' | 'create' | 'delete' = 'change'): void {
    // An unindexed Python file has no class/MRO entry to remove. In particular,
    // create/change notifications during discovery must not restart the scan.
    if (filePath?.toLowerCase().endsWith('.py') && !this.fileCache.has(filePath)) { return; }
    this.generation += 1;
    if (!filePath) {
      // Full invalidation (workspace root switch / shutdown face): all five axes increment
      for (const key of Object.keys(this.indexVersions) as PythonIndexVersionKey[]) {
        this.indexVersions[key] += 1;
      }
      this.resetRoots();
      this.rootsContentCache.clear();
    }
    if (filePath && !filePath.toLowerCase().endsWith('.py')) {
      // ④ Explicit invalidation condition: only sources recorded in the
      // dependency graph (entities.xml / .def / types.xml / py files carrying
      // instance assignments) invalidate the composition roots; changes to
      // unrelated files no longer ripple into the derived results.
      const plan = this.dependencyGraph.planInvalidation(filePath, changeKind);
      if (plan.invalidateFiles.includes(COMPOSITION_ROOTS_NODE)) {
        this.indexVersions.compositionRoots += 1;
        this.resetRoots();
      }
      return;
    }
    this.scanGeneration += 1;
    this.mroCache.clear();
    this.stagedRequests.clear();
    this.indexVersions.mro += 1;
    if (filePath) {
      this.revisions.set(filePath, (this.revisions.get(filePath) ?? 0) + 1);
      this.unindexFile(filePath);
      this.fileCache.delete(filePath);
      this.fileOrder.delete(filePath);
      this.indexVersions.classes += 1;
    } else {
      for (const file of this.revisions.keys()) {
        this.revisions.set(file, (this.revisions.get(file) ?? 0) + 1);
      }
      this.fileCache.clear(); this.byName.clear(); this.fileOrder.clear(); this.nextFileOrder = 0;
    }
    this.scanPromise = null;
    this.resetRoots();
  }

  /**
   * IDE-SNP-009: the consumer face of the unified root-removal notice --
   * surgically strips every record under that root while all other roots are
   * kept as they are (distinct from a whole-store invalidate + rescan
   * self-heal). Returns the number of py files stripped; an unknown root is a
   * no-op that advances no version.
   */
  removeRoot(rootPath: string): number {
    if (!rootPath) { return 0; }
    // Prefix comparison carries the separator: /ws does not accidentally match /wsX; both separators are recognized (keys may be spelled either way)
    const underRoot = (filePath: string): boolean =>
      filePath === rootPath ||
      filePath.startsWith(rootPath + '/') ||
      filePath.startsWith(rootPath + '\\');
    const removedFiles: string[] = [];
    for (const filePath of this.fileCache.keys()) {
      if (underRoot(filePath)) { removedFiles.push(filePath); }
    }
    let removedContentKeys = 0;
    for (const key of this.rootsContentCache.keys()) {
      if (underRoot(key)) { removedContentKeys += 1; }
    }
    if (removedFiles.length === 0 && removedContentKeys === 0) {
      return 0;
    }
    for (const filePath of removedFiles) {
      this.unindexFile(filePath);
      this.fileCache.delete(filePath);
      this.fileOrder.delete(filePath);
      this.revisions.delete(filePath);
      this.documents.delete(filePath);
      this.dependencyGraph.removeFile(filePath);
    }
    for (const key of [...this.rootsContentCache.keys()]) {
      if (underRoot(key)) { this.rootsContentCache.delete(key); }
    }
    for (const key of [...this.stagedRequests.keys()]) {
      if (underRoot(key)) { this.stagedRequests.delete(key); }
    }
    for (const key of [...this.pendingScanRetries.keys()]) {
      if (underRoot(key)) { this.pendingScanRetries.delete(key); }
    }
    // The removal is an explicit version event (consumers can decide it is
    // stale), not a silent TTL expiry; the scan generation bump naturally
    // invalidates in-flight scan / discovery caches (the discoveredGeneration
    // criterion)
    this.generation += 1;
    this.scanGeneration += 1;
    this.mroCache.clear();
    this.indexVersions.classes += 1;
    this.indexVersions.bases += 1;
    this.indexVersions.methods += 1;
    this.indexVersions.mro += 1;
    this.scanPromise = null;
    this.resetRoots();
    return removedFiles.length;
  }

  /** Reset the composition-root derivation state + explicit version increment (every reset path funnels through here, for easy assertion) */
  private resetRoots(): void {
    this.rootsEpoch += 1;
    if (this.rootsMap || this.rootsByScope.size > 0 || this.rootsPromise) {
      this.indexVersions.compositionRoots += 1;
    }
    this.rootsMap = null;
    this.rootsByScope.clear();
    this.rootsPromise = null;
  }

  async onFileChanged(filePath: string): Promise<void> {
    if (!filePath.toLowerCase().endsWith('.py')) {
      this.invalidate(filePath);
      return;
    }
    if (!this.fileCache.has(filePath) &&
        (filePath.split(/[\\/]/).some(part => PY_SCAN_EXCLUDED_DIRS.has(part)) ||
          isEnginePythonLibPath(filePath))) { return; }
    // INDEX-DISCIPLINE-001 ③: syntax gate -- the sole reindex entry point
    // (saves / external disk writes funnel into this face through the merger)
    // passes through the gate uniformly. A broken file does not enter the index
    // and is not bound (the index keeps the symbols of the last healthy version,
    // so navigation stays alive while editing); it only counts + logs, and the
    // diagnostics face keeps reporting the syntax error through the existing
    // diagnostics chain. The gated text and loadFile share one source (the open
    // document buffer first, disk as fallback) -- what is intercepted is exactly
    // the content about to enter the index.
    if (this.syntaxGateEnabled()) {
      // The gated text and loadFile share one source and one order (workspace
      // open document first, internal registry as fallback) -- what is
      // intercepted is exactly the content about to enter the index; a different
      // fetch order in the two places = the gate intercepting the wrong text.
      const open = vscode.workspace.textDocuments?.find(doc => doc.fileName === filePath) ?? this.documents.get(filePath);
      let text: string;
      try {
        // 2026-11-24: the disk leg goes through the shared raw-text cache (read
        // once, fanned out many times); a failure is thrown as-is and folded by
        // the existing catch below into empty text (the missing-file criterion
        // is unchanged).
        text = open
          ? open.getText()
          : (await getSharedFileTextCache().readThroughAsync(filePath, p => fs.promises.readFile(p, 'utf8'))).text;
      } catch {
        // Unreadable (an external file-delete race etc.): left to loadFile's
        // existing missing-file criterion, not intercepted here
        text = '';
      }
      if (text !== '') {
        const verdict = await checkSyntaxGate(text);
        if (!verdict.ok) {
          this.syntaxGateSkipped += 1;
          jumpLog('info', () =>
            `py 语法门拦下(保留上次健康索引): ${filePath} — ${verdict.reasons.slice(0, 2).join('; ')}`);
          return;
        }
      }
    }
    this.revisions.set(filePath, (this.revisions.get(filePath) ?? 0) + 1);
    await this.loadFile(filePath, -1);
  }

  onDocumentClosed(document: vscode.TextDocument): void {
    this.documents.delete(document.fileName);
    // KR-AUD-28: what closed is the editor document while the file is still on
    // disk -- reload only that file from disk and do not advance the scan
    // generation (the old invalidate implementation invalidated the entire scan
    // generation, so the next query triggered repo-wide re-discovery + re-parse).
    // The disk is the source of truth: first synchronously strip the buffered
    // version (otherwise instant queries still see the in-memory buffer), then
    // asynchronously reload from disk; when loadFile cannot find a document it
    // falls back to a disk read. The reload promise is booked so later queries
    // (ensureScanned) wait for it to settle first, keeping instant queries from
    // seeing an empty window or a stale buffer.
    if (this.fileCache.has(document.fileName)) {
      this.unindexFile(document.fileName);
      this.fileCache.delete(document.fileName);
      this.fileOrder.delete(document.fileName);
      this.mroCache.clear();
      this.indexVersions.classes += 1;
    }
    const pending = (this.closeReloads.get(document.fileName) ?? Promise.resolve())
      .then(() => this.loadFile(document.fileName, -1))
      .then(() => { this.closeReloads.delete(document.fileName); });
    this.closeReloads.set(document.fileName, pending);
  }

  private updateFile(filePath: string, content: string, version: number): void {
    const parseStartedAt = performance.now();
    const parsed = parsePythonFile(content, filePath);
    this.commitParsedFile(filePath, parsed, version, performance.now() - parseStartedAt);
  }

  private async updateFileResponsive(filePath: string, content: string, version: number,
    revision: number): Promise<void> {
    const parseStartedAt = performance.now();
    const result = await parsePythonFileResponsive(content, filePath, revision);
    if (result.revision !== (this.revisions.get(filePath) ?? 0)) { return; }
    this.commitParsedFile(filePath, result.parsed, version, performance.now() - parseStartedAt);
  }

  private commitParsedFile(filePath: string, parsed: ParsedPythonFile, version: number,
    parseMs: number): void {
    // IDE-RST-009: commit-segment timing (document-commit) -- cache booking /
    // class indexing / three-layer signature reconciliation / composition-root
    // bridge dependency registration, listed separately from the parse segment
    // (document-parse) to compose the full edit face
    const commitStartedAt = performance.now();
    const previous = this.fileCache.get(filePath)?.parsed;
    this.generation += 1;
    this.mroCache.clear();
    this.unindexFile(filePath);
    // PR1 instrumentation: per-file parse timing (document-parse), with the
    // document version recorded alongside each sample; parse results and order
    // stay untouched (observation only, no behavior change).
    recordLanguageServiceOperation('document-parse', parseMs, {
      fileKind: 'python',
      documentVersion: version,
      fileParseCount: 1
    });
    this.fileCache.set(filePath, { version, parsed });
    for (const cls of parsed.classes) { this.indexClass(cls); }
    // ④ Explicit version axes: a single traversal builds the class / bases /
    // methods three-layer signatures (on the 30k-file scan path JSON
    // serialization is an observable cost, so they are fused into one loop),
    // and whichever layer changed bumps its axis.
    let classesChanged = false;
    let basesChanged = false;
    let methodsChanged = false;
    if (previous) {
      const byKey = new Map(previous.classes.map(cls => [this.classKey(cls), cls]));
      if (byKey.size !== parsed.classes.length) {
        classesChanged = true;
      }
      for (const cls of parsed.classes) {
        const before = byKey.get(this.classKey(cls));
        if (!before) {
          classesChanged = true;
        }
        if (!before || before.bases.join('\u0000') !== cls.bases.join('\u0000')) {
          basesChanged = true;
        }
        if (!before || before.methods.size !== cls.methods.size ||
            [...cls.methods.entries()].some(([name, loc]) => {
              const prev = before.methods.get(name);
              return !prev || prev.line !== loc.line || prev.character !== loc.character;
            })) {
          methodsChanged = true;
        }
      }
      if (classesChanged) {
        this.indexVersions.classes += 1;
      }
      if (basesChanged) {
        this.indexVersions.bases += 1;
      }
      if (methodsChanged) {
        this.indexVersions.methods += 1;
      }
      this.indexVersions.mro += 1;
    } else {
      this.indexVersions.classes += 1;
      this.indexVersions.bases += 1;
      this.indexVersions.methods += 1;
    }
    // ④ The composition root's "implementation object -> class" bridging source
    // is recorded in the dependency graph: only py files carrying module-level
    // instance assignments are composition-root derivation sources, so other py
    // changes never trigger a composition-root rebuild (precise invalidation).
    if (parsed.instanceAssignments.length > 0) {
      this.dependencyGraph.recordDependencies(COMPOSITION_ROOTS_NODE, [filePath]);
    }
    // Composition roots depend on entities.xml/.def/types.xml and the relatively
    // rare module-level `instance = Class()` bridge. Ordinary method/class edits
    // change MRO lookup data but do not require another three workspace-wide
    // metadata scans. Rebuild roots only when that bridge changes.
    // PR5: after the first scan is backgrounded, composition-root derivation and
    // chunked parsing run concurrently -- a first parse (previous is null)
    // invalidates the derived results only when it really brings instance
    // assignments, otherwise a background-scanned file would wash away a freshly
    // built composition root.
    const assignmentSignature = (items: ParsedPythonFile['instanceAssignments']): string =>
      JSON.stringify(items.map(item => [item.variable, item.className]));
    const assignmentsChanged = !previous
      ? parsed.instanceAssignments.length > 0
      : assignmentSignature(previous.instanceAssignments) !== assignmentSignature(parsed.instanceAssignments);
    if (assignmentsChanged) {
      // Only a real change to the "implementation object -> class" bridge invalidates the composition roots (a first parse with no assignment leaves the derivation untouched)
      this.resetRoots();
    }
    recordLanguageServiceOperation('document-commit', performance.now() - commitStartedAt, {
      fileKind: 'python',
      documentVersion: version
    });
  }

  private indexClass(cls: PythonClassDef): void {
    const list = this.byName.get(cls.name) ?? [];
    list.push(cls);
    this.byName.set(cls.name, list);
  }

  private unindexFile(filePath: string): void {
    const previous = this.fileCache.get(filePath)?.parsed;
    if (!previous) { return; }
    for (const name of new Set(previous.classes.map(cls => cls.name))) {
      const list = this.byName.get(name);
      if (!list) { continue; }
      const filtered = list.filter(item => item.filePath !== filePath);
      if (filtered.length === 0) {
        this.byName.delete(name);
      } else {
        this.byName.set(name, filtered);
      }
    }
  }

  /** Full scan on the first query (idempotent; a failure does not throw) */
  /**
   * Input fingerprint for composition root derivation: all module-level
   * instance assignments in the fileCache (the implementation object -> class
   * bridge). The fingerprint changing during derivation = the inputs changed,
   * which triggers a re-derivation (the concurrency face of ④'s explicit
   * invalidation condition).
   */
  private assignmentsToken(): string {
    const items: string[] = [];
    for (const [file, { parsed }] of this.fileCache) {
      for (const item of parsed.instanceAssignments) {
        items.push(`${file}#${item.variable}=${item.className}`);
      }
    }
    return items.sort().join('|');
  }

  /**
   * Composition root derivation (lazy): every entity in entities.xml + each
   * entity's .def (parent / interfaces / components / field types) + types.xml
   * (the implementedBy field object classes). A failure clears the cache so it
   * can be retried (the same criterion as the scan).
   */
  private async ensureCompositionRoots(): Promise<void> {
    if (this.rootsMap) {
      return;
    }
    if (this.rootsPromise) {
      // PR1 instrumentation: joining an in-progress composition root derivation = this request is waiting on index initialization
      const joinWait = startLanguageServiceOperation('python-composition-roots', {
        waitedForInit: true,
        indexGeneration: this.generation
      });
      try {
        await this.rootsPromise;
        joinWait.end('ok');
      } catch {
        // The join arm's rejection branch has no triggering input -- the
        // rootsPromise's building IIFE carries its own full catch (a derivation
        // failure only clears the cache and does not throw): the IIFE always
        // resolves, so the await never reaches the rejection branch.
        /* istanbul ignore start */
        joinWait.end('error');
        /* istanbul ignore stop */
      }
      return this.rootsPromise;
    }
    this.rootsPromise = (async () => {
      const rootsTimer = jumpTimeStart();
      const compositionMetrics = startLanguageServiceOperation('python-composition-roots', {
        indexGeneration: this.generation
      });
      // PR5: no longer waits for the full .py scan -- the "implementation
      // object -> class" bridge uses the instance-assignment table of the index
      // built so far (a partial derivation until the scan completes, and once an
      // assigning file enters the index the assignment-signature comparison in
      // updateFile re-derives automatically); the first scan itself is already
      // backgrounded, so this only needs to make sure it is progressing.
      void this.ensureScanned();
      const readText = async (uri: vscode.Uri): Promise<string> => {
        const document = vscode.workspace.textDocuments?.find(doc => doc.fileName === uri.fsPath) ?? this.documents.get(uri.fsPath);
        if (document) {
          this.rootsContentCache.set(uri.fsPath, {
            mtimeMs: 0, size: document.getText().length, content: document.getText()
          });
          return document.getText();
        }
        // ③ Composition root build cache: the same batch of XML/def files is
        // really re-read only when mtime/size changes, so a re-derivation (the
        // common path after a partial invalidation of entities.xml/.def) hits
        // the cache and produces no IO.
        try {
          const stat = await fs.promises.stat(uri.fsPath);
          const cached = this.rootsContentCache.get(uri.fsPath);
          if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
            compositionMetrics.countCacheHit(1);
            return cached.content;
          }
          const content = await fs.promises.readFile(uri.fsPath, 'utf8');
          this.rootsContentCache.set(uri.fsPath, { mtimeMs: stat.mtimeMs, size: stat.size, content });
          return content;
        } catch (error) {
          this.rootsContentCache.delete(uri.fsPath);
          throw error;
        }
      };
      let epochBefore = this.rootsEpoch;
      try {
          let scoped = new Map<string, CompositionRootMap>();
          let resolvedRoots: string[] = [];
          let combinedMixins = new Map<string, string[]>();
        // PR5 concurrency guardrail: once the first scan is backgrounded, chunked
        // parsing and derivation advance concurrently. Derivation inputs =
        // metadata file contents + a fileCache instance-assignment snapshot. Note
        // this.generation must not be used to judge stability -- every single-file
        // parse increments it, which would cause a pointless re-derivation storm
        // during a background scan; here stability is judged by the dual condition
        // "composition root epoch (resetRoots) + assignment bridge fingerprint",
        // and only a changed input re-derives through the content cache (zero
        // re-reads), never dropped silently.
        for (let attempt = 0; attempt < 8; attempt += 1) {
        epochBefore = this.rootsEpoch;
        const assignmentsBefore = this.assignmentsToken();
        const [entityXmlFiles, defFiles, typeXmlFiles] = await Promise.all([
          findFilesAcrossRoots('**/entities.xml', PY_SCAN_EXCLUDE),
          findFilesAcrossRoots('**/*.def', PY_SCAN_EXCLUDE),
          findFilesAcrossRoots('**/types.xml', PY_SCAN_EXCLUDE)
        ]);
        compositionMetrics.countFileDiscovery(entityXmlFiles.length + defFiles.length + typeXmlFiles.length);
        // ④ The composition root's derivation sources are recorded in the PR4
        // dependency graph: entities.xml/types.xml in full and .def in full
        // (parent chains / interfaces / components are read across files, so
        // per-file dependency edges are not worth it); invalidation is cut off
        // per graph.
        this.dependencyGraph.recordDependencies(COMPOSITION_ROOTS_NODE, [
          ...entityXmlFiles.map(uri => uri.fsPath),
          ...defFiles.map(uri => uri.fsPath),
          ...typeXmlFiles.map(uri => uri.fsPath)
        ]);
        const scopes = [...new Set(entityXmlFiles.map(uri => path.dirname(uri.fsPath)))];
        const scopeFor = (file: string): string => scopes
          .filter(scope => file.startsWith(scope + path.sep))
          .sort((left, right) => right.length - left.length)[0]
          ?? file.replace(/\\/g, '/').match(/^(.*?)\/(?:scripts|entity_defs)(?:\/|$)/)?.[1]
          ?? path.dirname(file);
        const groups = new Map<string, {
          entitiesXmlContents: string[]; typesXmlContents: string[];
          entityDefs: Array<{ entity: string; content: string }>;
        }>();
        const readGroup = async (uri: vscode.Uri, kind: 'entities' | 'types' | 'def'): Promise<void> => {
          try {
            const scope = scopeFor(uri.fsPath);
            const group = groups.get(scope) ?? { entitiesXmlContents: [], typesXmlContents: [], entityDefs: [] };
            groups.set(scope, group);
            const content = await readText(uri);
            compositionMetrics.countFileRead(1);
            compositionMetrics.countFileParse(1);
            if (kind === 'entities') { group.entitiesXmlContents.push(content); }
            else if (kind === 'types') { group.typesXmlContents.push(content); }
            else if (!/[\\/](components|interfaces)[\\/]/i.test(uri.fsPath)) {
              group.entityDefs.push({ entity: path.basename(uri.fsPath, '.def'), content });
            }
          } catch {
            // A missing file cannot prevent other asset projects from resolving.
          }
        };
        // Preserve discovery order; derived root order is also candidate order.
        for (const uri of entityXmlFiles) { await readGroup(uri, 'entities'); }
        for (const uri of typeXmlFiles) { await readGroup(uri, 'types'); }
        for (const uri of defFiles) { await readGroup(uri, 'def'); }
        scoped = new Map<string, CompositionRootMap>();
        resolvedRoots = [];
        combinedMixins = new Map<string, string[]>();
        for (const [scope, group] of groups) {
          const derived = deriveCompositionRoots(group);
          const assignments = new Map<string, string>();
          for (const [file, { parsed }] of this.fileCache) {
            if (scopeFor(file) !== scope) { continue; }
            for (const item of parsed.instanceAssignments) { assignments.set(item.variable, item.className); }
          }
          const roots = [...new Set(derived.roots.map(root => assignments.get(root) ?? root))];
          scoped.set(scope, { roots, defMixins: derived.defMixins });
          for (const root of roots) { if (!resolvedRoots.includes(root)) { resolvedRoots.push(root); } }
          for (const [root, mixins] of derived.defMixins) {
            combinedMixins.set(root, [...new Set([...(combinedMixins.get(root) ?? []), ...mixins])]);
          }
        }
        if (this.rootsEpoch !== epochBefore || this.assignmentsToken() !== assignmentsBefore) {
          continue; // the inputs changed during derivation (or the derived result was invalidated): re-derive (metadata goes through the content cache, zero IO)
        }
        this.rootsByScope = scoped;
        this.rootsMap = { roots: resolvedRoots, defMixins: combinedMixins };
        compositionMetrics.end('ok');
        jumpLog('info', () =>
          `组合根派生 ${resolvedRoots.length} 根: [${resolvedRoots.join(', ')}] ${rootsTimer()}ms(第 ${attempt + 1} 次尝试落地)`
        );
        return;
        }
        // The inputs are still changing after several yields (an edit storm):
        // wrap up correctly on the last snapshot -- land rootsMap, end the
        // metrics, and clear rootsPromise (KR-AUD-26: the old implementation
        // only logged, and the join arm spun waiting on a long-resolved stale
        // promise, leaving composition root queries permanently empty; once
        // landed, a real invalidation is still corrected normally through
        // resetRoots / the updateFile assignment-signature comparison).
        this.rootsByScope = scoped;
        this.rootsMap = { roots: resolvedRoots, defMixins: combinedMixins };
        compositionMetrics.end('ok');
        this.rootsPromise = null;
        jumpLog('info', () => `组合根派生连续让位 8 次,按最后一次输入落地 ${rootsTimer()}ms`);
      } catch {
        compositionMetrics.end('error');
        // Derivation failure: not cached as a success, retried on the next jump; the already built index is unaffected
        if (epochBefore === this.rootsEpoch) {
          this.rootsMap = null;
          this.rootsByScope.clear();
          this.rootsPromise = null;
        }
      }
    })();
    return this.rootsPromise;
  }

  /**
   * "Which composition roots include class X" -- a cross of the three inputs:
   * the root's own Python MRO (including same-named classes in several files),
   * or the mixin (Parent / interfaces / components) roster declared by the
   * root's .def, hits X.
   * Returned in composition root derivation order (the entities.xml entity
   * order comes first).
   */
  async rootsContaining(className: string): Promise<string[]> {
    await this.ensureCompositionRoots();
    const map = this.rootsMap;
    if (!map) {
      return [];
    }
    const hits: string[] = [];
    for (const root of map.roots) {
      if (root === className) {
        hits.push(root);
        continue;
      }
      if (this.byName.has(root)) {
        const contains = (this.byName.get(root) ?? []).some(cls =>
          this.mroClasses(cls).some(base => base.name === className));
        if (contains) {
          hits.push(root);
          continue;
        }
      }
      if ((map.defMixins.get(root) ?? []).includes(className)) {
        hits.push(root);
      }
    }
    return hits;
  }

  /**
   * The whole-store knowledge entry point (APIs that must use a whole-repo
   * criterion -- class-name enumeration / MRO / descendants -- wait here).
   * Since PR5 the scan body advances in the scheduler's background: discovery =
   * a keyed initial-scan task, parsing = chunked full-reindex background tasks
   * (subject to interactive throttling); a failure does not cache a "scanned"
   * illusion -- once scanPromise is cleared, the next call re-coordinates (the
   * same semantics as before the fix).
   * Single-flight guard: only one runScheduledScan instance is allowed per
   * generation -- concurrent calls share the same scanPromise, and the
   * terminal state (success records the completed generation / failure clears
   * it) is written back by that single instance, never overwriting each other.
   */
  private scanCompletedGeneration = -1;

  private ensureScanned(): Promise<void> {
    // KR-AUD-28: the reload-from-disk after a closed document settles first -- a query must not leap past it and see an empty window or a stale buffer.
    if (this.closeReloads.size > 0) {
      const reloads = [...this.closeReloads.values()];
      return Promise.all(reloads).then(() => this.ensureScanned());
    }
    if (this.scanCompletedGeneration === this.scanGeneration) {
      // The scan generation is complete, but files left behind by a failed chunk may still be pending: retry them in a targeted way (no whole-repo rescan)
      this.schedulePendingScanRetry();
      return Promise.resolve();
    }
    if (!this.scanPromise) {
      const generation = this.scanGeneration;
      this.scanPromise = this.runScheduledScan(generation)
        .then(() => {
          if (generation === this.scanGeneration) {
            this.scanCompletedGeneration = generation;
          }
        }, () => undefined)
        .finally(() => {
          if (generation === this.scanGeneration) {
            this.scanPromise = null;
          }
        });
    }
    return this.scanPromise;
  }

  /**
   * Targeted fill-up parse for files left behind by a chunk cancellation /
   * failure and for files whose parse failed (old index kept): one small
   * background chunk that re-runs loadFile per file, advancing a bounded retry
   * (MAX_SCAN_RETRY_ATTEMPTS times) on its real commit result
   * (false = nothing committed this round), so a permanently unreadable file is
   * not retried forever; if the whole chunk is cancelled again the registration
   * is kept and the next query tries again.
   */
  private schedulePendingScanRetry(): void {
    if (this.scanRetryInFlight || this.pendingScanRetries.size === 0) { return; }
    const files = [...this.pendingScanRetries.keys()];
    if (files.length === 0) { return; }
    this.scanRetryInFlight = true;
    // Collect loadFile's commit result per file: the registry holds both
    // chunk-left-behind files that never entered the index and files whose parse
    // failed while the old index survived -- the latter always has a fileCache
    // value, so "present in the table" must not be taken as a success signal;
    // this retry really committing content is what counts.
    const committed = new Map<string, boolean>();
    this.scheduler.enqueue({
      kind: 'full-reindex',
      priority: IndexTaskPriority.BackgroundFull,
      run: async () => {
        for (const file of files) {
          committed.set(file, await this.loadFile(file, -1));
        }
      }
    }).wait.then(
      () => {
        for (const file of files) {
          if (committed.get(file) === true) {
            this.pendingScanRetries.delete(file);
            continue;
          }
          const attempts = (this.pendingScanRetries.get(file) ?? 1) + 1;
          if (attempts >= MAX_SCAN_RETRY_ATTEMPTS) {
            this.pendingScanRetries.delete(file);
            jumpLog('info', () =>
              `py 待补解析重试 ${MAX_SCAN_RETRY_ATTEMPTS} 次仍未成功,放弃: ${file}`);
          } else {
            this.pendingScanRetries.set(file, attempts);
          }
        }
      },
      () => undefined // the whole chunk was cancelled: the files were never parsed, keep the registration and try again on the next query
    ).finally(() => { this.scanRetryInFlight = false; });
  }

  /** First-scan coordination: the scheduler's keyed discovery task -> chunked background parse tasks (interactive tasks may preempt between tasks) */
  private async runScheduledScan(scanGeneration: number): Promise<void> {
    const scanMetrics = startLanguageServiceOperation('python-index-scan', {
      indexGeneration: this.generation
    });
    const scanTimer = jumpTimeStart();
    try {
      const files = await this.ensureDiscovered(scanGeneration);
      // Read / parse counts follow the "number of files attempted to be
      // processed" criterion: loadFile internally reuses an open buffer and
      // falls back on a read failure, and the precise read / parse split is
      // carried separately by the document-parse event.
      scanMetrics.countFileDiscovery(files.length);
      // ③ The cross-file ordering baseline for reverse candidates: the
      // discovery order is marked here (a first sight is not re-sorted). Chunked
      // loading is Promise.all concurrency, so completion order flips with IO
      // timing, and on-demand preloading is readdir order -- only the discovery
      // order is the stable criterion for candidate order (the root cause of the
      // CI 40470720225 red case).
      for (const uri of files) { this.noteFileOrder(uri.fsPath); }
      // SCAN-RESUME-001: checkpoint resume -- read the checkpoint into an
      // adoption plan and clear the field (the plan lives in memory).
      // Files with a matching fingerprint (mtimeMs+size) are adopted directly
      // (the direct-take path, isomorphic with disk-cache restore); drift / new
      // files / a missing checkpoint are scanned as usual. Adoption and actual
      // scanning both go through the same chunk-commit face, and the query face's
      // loading/partial criterion is unchanged (a half-finished index does not
      // serve outside prematurely).
      const filePaths = files.map(uri => uri.fsPath);
      const resume = this.scanProgress ? this.scanProgress.loadResumePlan(filePaths) : null;
      const adoptedEntries = resume ? [...resume.adopt.values()] : [];
      const scanFiles = resume ? resume.scan : filePaths;
      this.lastScanResumeStats = { adopted: adoptedEntries.length, scanned: scanFiles.length };
      scanMetrics.countFileRead(scanFiles.length);
      scanMetrics.countFileParse(scanFiles.length);
      // WARM-VISIBILITY-004 blade B: a python full-scan start line + chunk-level
      // throttled progress, going into the unified "KBEngine Index" channel
      // (always on; progress lines reuse scanStageProgress's dual-gate
      // throttling); ENGINE-LIB-SCAN-005 blade 2: the exclusion face appears in
      // the line (the task brief's "scope changes are auditable")
      const engineExcludedRoots = resolveEngineSubtreeExclusions().length;
      // The scan roots appear in the line (the 2026-11-23 two-stage order,
      // auditable scope): from the roots in the line the user can tell "whether
      // scripts or the whole workspace tree was scanned", instead of
      // back-inferring from symptoms.
      const scanRootsLabel = getIndexScanRoots()
        .map(root => root.replace(/\\/g, '/'))
        .join(', ');
      indexLog('python-index',
        `python 类索引全扫开始:${files.length} 个文件,根=[${scanRootsLabel}](断点采纳 ${adoptedEntries.length}/实扫 ${scanFiles.length}${engineExcludedRoots > 0 ? `/已剔引擎仓子树 ${engineExcludedRoots} 处` : ''})`);
      const pyProgress = createScanStageProgressReporter({
        label: 'python 类索引',
        total: files.length,
        report: detail => {
          indexLog('python-index', detail);
          // A warm-up waiter is attached: mirror the same detail to the status bar message (the class index enters the status bar)
          this.scanDetailSink?.(detail);
        }
      });
      // Chunked enqueue: one background task per chunk, and between chunks the
      // scheduler may preempt with interactive tasks (RequestLocal single-file
      // parses / current-file updates), so the full scan no longer monopolizes
      // the main thread.
      const batches: string[][] = [];
      const handles = [];
      if (adoptedEntries.length > 0) {
        // Adoption pseudo-chunk: checkpoint entries restored to Maps go through
        // commitParsedFile (no re-read, no re-parse).
        // It is also booked as a chunk: if the task is cancelled / fails, this
        // batch of files follows the same failedFiles -> pending-retry criterion.
        const adoptedPaths = adoptedEntries.map(entry => entry.path);
        batches.push(adoptedPaths);
        handles.push(this.scheduler.enqueue({
          kind: 'full-reindex',
          priority: IndexTaskPriority.BackgroundFull,
          run: async () => {
            // Invalidated generation change: a stale chunk is dropped outright (an old generation's results must not overwrite the new generation's state)
            if (scanGeneration !== this.scanGeneration) { return; }
            for (const entry of adoptedEntries) {
              this.commitParsedFile(
                entry.path, restoreSerializedParsedPythonFile(entry.parsed), entry.version, 0);
            }
            pyProgress.step(adoptedEntries.length);
            jumpLog('info', () =>
              `py 全扫断点恢复:采纳 ${adoptedEntries.length} 个文件(直取,不重读不重解析)`);
            indexLog('python-index',
              `py 全扫断点恢复:采纳 ${adoptedEntries.length} 个文件(直取,不重读不重解析)`);
          }
        }));
      }
      for (let offset = 0; offset < scanFiles.length; offset += SCAN_CHUNK_SIZE) {
        const batch = scanFiles.slice(offset, offset + SCAN_CHUNK_SIZE);
        const chunkIndex = batches.length;
        batches.push(batch);
        handles.push(this.scheduler.enqueue({
          kind: 'full-reindex',
          priority: IndexTaskPriority.BackgroundFull,
          run: async () => {
            // Invalidated generation change: a stale chunk is dropped outright (an old generation's results must not overwrite the new generation's state)
            if (scanGeneration !== this.scanGeneration) { return; }
            // ENGINE-LIB-SCAN-005 blade 4: yield to the interactive cooldown
            // window -- when the beacon was just refreshed (an interactive task
            // in flight or just finished), first wait out the window before
            // parsing this chunk (the same beacon source as FREEZE blade 1b, the
            // same decision shape as defaultMirrorYield), so the background
            // occupation yields to interactive work.
            const yieldMs = scanChunkYieldDelayMs(performance.now(), interactiveActivityBeacon.lastAt);
            if (yieldMs > 0) {
              await new Promise<void>(resolve => setTimeout(resolve, yieldMs));
            }
            const results = await Promise.all(batch.map(file =>
              this.loadFile(file, -1).then(committed => (committed ? file : null), () => null)));
            pyProgress.step(results.filter(file => file !== null).length);
            // SCAN-RESUME-001: this chunk's committed files land in the
            // checkpoint (the fingerprint is stat-ed against the disk; a write
            // failure is silent, the checkpoint is only an accelerator); nothing
            // lands after a generation change (old-generation entries must not
            // mix into a new round's checkpoint)
            if (this.scanProgress && scanGeneration === this.scanGeneration) {
              const commits: ScanChunkCommit[] = [];
              for (const file of results) {
                if (file === null) { continue; }
                const cached = this.fileCache.get(file);
                if (cached) {
                  commits.push({ path: file, version: cached.version, parsed: cached.parsed });
                }
              }
              this.scanProgress.recordChunk(chunkIndex, commits);
            }
          }
        }));
      }
      // Collect per-chunk terminal states: a cancelled / failed chunk no longer
      // has its rejection swallowed one by one while the generation is still
      // marked complete -- that would leave this batch of files (at most
      // SCAN_CHUNK_SIZE per chunk) permanently absent without ever being
      // parsed and with no later retry.
      const outcomes = await Promise.all(
        handles.map(handle => handle.wait.then(() => 'completed', () => 'failed' as const))
      );
      if (scanGeneration !== this.scanGeneration) {
        scanMetrics.end('cancelled');
        return;
      }
      const failedFiles = batches.flatMap((batch, index) =>
        outcomes[index] === 'completed' ? [] : batch);
      if (failedFiles.length > 0) {
        for (const file of failedFiles) {
          if (!this.fileCache.has(file)) { this.pendingScanRetries.set(file, 1); }
        }
        jumpLog('info', () =>
          `py 全扫有 ${failedFiles.length} 个文件未随分块解析,已登记待补(后续查询定向重试)`);
        indexLog('python-index',
          `py 全扫有 ${failedFiles.length} 个文件未随分块解析,已登记待补(后续查询定向重试)`);
      } else {
        // No failed chunks this round: clear the table of pending files that
        // this round's full pass covered. With RESP-002, discovery no longer
        // occupies a scheduler execution slot, so on-demand fill-up and the full
        // scan's wrap-up can run concurrently -- entries registered but not in
        // this round's discovery set were registered on demand during the scan
        // and are not covered by this round, so they must not be deleted by
        // mistake.
        const covered = new Set(filePaths);
        for (const file of [...this.pendingScanRetries.keys()]) {
          if (covered.has(file)) { this.pendingScanRetries.delete(file); }
        }
        // SCAN-RESUME-001: a zero-failure full wrap-up -- the checkpoint's
        // mission is done, clear the field (a partial failure / cancellation does
        // not complete: the recorded chunks stay on disk and the next round
        // resumes from the checkpoint)
        this.scanProgress?.complete();
      }
      jumpLog('info', () =>
        `py 全仓索引完成 ${files.length} 个文件(断点采纳 ${adoptedEntries.length}/实扫 ${scanFiles.length})`
        + ` → 类 ${this.byName.size} 个,${scanTimer()}ms(调度器分块后台执行)`);
      pyProgress.finish();
      // WARM-VISIBILITY-004 blade B: the completion line is mirrored into the unified channel (the timing reads the same segment's wall clock)
      indexLog('python-index', () =>
        `py 全仓索引完成 ${files.length} 个文件(断点采纳 ${adoptedEntries.length}/实扫 ${scanFiles.length})`
        + ` → 类 ${this.byName.size} 个`);
      scanMetrics.end('ok');
    } catch (error) {
      scanMetrics.end('error');
      // A scan failure does not block jumping, but ensureScanned's single-flight
      // guard must sense it: after the rethrow the completed generation is not
      // booked and scanPromise is cleared, so the next call re-coordinates (the
      // same pre-fix semantics of "a failure does not cache a scanned
      // illusion").
      if (scanGeneration === this.scanGeneration) { throw error; }
    }
  }

  /**
   * File discovery (an in-class, generation-keyed single flight) serves only the
   * background full scan; known files a request needs are filled in on demand,
   * targeted by path. A same-generation cache is reused directly; a generation
   * change or a failure allows re-discovery.
   *
   * RESP-002: discovery does not go through the scheduler -- when the single
   * concurrency execution slot is held by the await of a repo-wide findFiles,
   * RequestLocal known-path fill-ups are also forced to queue (asynchronous
   * disk scanning yields the JS event loop but not the scheduler execution
   * slot; during a slow external directory / unfinished findFiles,
   * high-priority tasks stay queued). Once the discovery wait is separated
   * from interactive execution, chunked parsing still goes through the
   * scheduler and interactive tasks may preempt between chunks.
   */
  private async ensureDiscovered(scanGeneration: number): Promise<vscode.Uri[]> {
    if (this.discoveredFiles && this.discoveredGeneration === scanGeneration) {
      return this.discoveredFiles;
    }
    if (!this.discoveredInFlight || this.discoveredInFlight.generation !== scanGeneration) {
      this.discoveredInFlight = {
        generation: scanGeneration,
        promise: (async () => {
          // ENGINE-LIB-SCAN-005 blade 1: the engine repo's Python standard
          // library mirror (kbe/scripts/common/Lib) is pruned out of business
          // scanning by path shape -- post-filtering the workspace glob results
          // + pruning the external-root traversal.
          // The anchor root goes first (the 2026-11-23 two-stage order): when
          // configuration / derivation / folder top level are all absent, the
          // scripts root is located by the engine's default layout, and the bare
          // workspace glob fallback is no longer triggered.
          await ensureAnchorScanRoot().catch(() => null);
          const files = await findFilesAcrossRoots(
            '**/*.py',
            PY_SCAN_EXCLUDE,
            undefined,
            fsPath => !isEnginePythonLibPath(fsPath)
          );
          // Generation-change guard: a late old-generation discovery does not
          // land in the cache (scanGeneration has advanced; the result is
          // irrelevant; the next call re-discovers per the new generation).
          if (scanGeneration === this.scanGeneration) {
            this.discoveredFiles = files;
            this.discoveredGeneration = scanGeneration;
          }
        })()
      };
    }
    const flight = this.discoveredInFlight;
    try {
      await flight.promise;
    } catch (error) {
      // A failure does not cache a "discovered" illusion (the same criterion as
      // a first-scan failure): a same-generation error is rethrown for the
      // first scan to book; a generation-change error is silent (the result is
      // already irrelevant, the new generation's single flight has taken over).
      if (scanGeneration === this.scanGeneration) { throw error; }
    } finally {
      if (this.discoveredInFlight === flight) { this.discoveredInFlight = null; }
    }
    return this.discoveredFiles ?? [];
  }

  /**
   * On-demand single-file parse of the files a request needs (②): enqueued at
   * RequestLocal priority, ahead of the background full chunks; concurrent
   * requests for the same file merge into one queue entry (the scheduler merges
   * the same version + local de-duplication).
   */
  private loadFileOnDemand(filePath: string): Promise<void> {
    if (this.fileCache.has(filePath)) {
      return Promise.resolve();
    }
    const pending = this.stagedRequests.get(filePath);
    if (pending) {
      return pending;
    }
    const task = this.scheduler.enqueue({
      kind: 'single-file-update',
      priority: IndexTaskPriority.RequestLocal,
      filePath,
      version: this.revisions.get(filePath) ?? 0,
      run: async () => { await this.loadFile(filePath, -1); }
    });
    const done = task.wait
      .catch(() => undefined)
      .then(() => { this.stagedRequests.delete(filePath); });
    this.stagedRequests.set(filePath, done);
    return done;
  }

  /**
   * Definition request pre-staging (②): fill the index with the files this
   * request may need -- ① the query file itself; ② the module candidate paths
   * of its imports (the same criterion as resolveSymbol); ③ same-directory
   * sibling .py files (implicit nearby references; the cap prevents reading a
   * large directory in full).
   * Candidates are filled in import search order, then in same-directory
   * filename order; the whole path only needs known paths.
   * Everything goes through RequestLocal single-file tasks, with no wait for
   * the whole-repo discovery.
   */
  private async stageRequestFiles(filePath: string, token?: vscode.CancellationToken): Promise<void> {
    if (token?.isCancellationRequested) { return; }
    if (!this.fileCache.has(filePath)) {
      await this.loadFileOnDemand(filePath);
    }
    if (token?.isCancellationRequested) { return; }
    const cached = this.fileCache.get(filePath);
    if (!cached) {
      return; // the file is unreadable: later resolution degrades to a miss
    }
    // Audit finding (:183): import-derived candidates are real dependencies and
    // must not be cut at 64 in order -- the cut would silently skip the real
    // dependencies later in a file with many imports, and the first jump query
    // would miss. Import candidates are filled in full; the sibling-directory
    // candidates keep their cap (preventing a full read of a large directory, an
    // explicit criterion rather than a silent dependency drop).
    const importTargets: string[] = [];
    const seenTargets = new Set<string>();
    for (const binding of cached.parsed.imports?.values() ?? []) {
      for (const target of this.importModuleCandidates(filePath, binding.module)) {
        if (seenTargets.has(target)) { continue; }
        seenTargets.add(target);
        importTargets.push(target);
      }
    }
    const missingImports = importTargets.filter(target => !this.fileCache.has(target));
    for (let offset = 0; offset < missingImports.length; offset += 8) {
      if (token?.isCancellationRequested) { return; }
      await Promise.all(missingImports.slice(offset, offset + 8).map(target => this.loadFileOnDemand(target)));
    }
    try {
      const dir = path.dirname(filePath);
      const siblings = (await fs.promises.readdir(dir))
        .filter(name => name.toLowerCase().endsWith('.py')).sort();
      const missingSiblings = siblings.slice(0, 64)
        .map(sibling => path.join(dir, sibling))
        .filter(target => !this.fileCache.has(target) && !seenTargets.has(target));
      for (let offset = 0; offset < missingSiblings.length; offset += 8) {
        if (token?.isCancellationRequested) { return; }
        await Promise.all(missingSiblings.slice(offset, offset + 8).map(target => this.loadFileOnDemand(target)));
      }
    } catch {
      // The directory cannot be listed (deleted / no permission): degrade to a miss
    }
  }

  /**
   * Fill in files by name at a fixed point (②'s backstop): under the
   * conventional one-class-per-file layout, when a resolution misses, a
   * same-name-as-class glob (star star slash &lt;ClassName&gt;.py) fills in the
   * candidate files and retries once -- the cost is one targeted discovery, not
   * a whole-repo scan.
   */
  private async stageClassNameFiles(names: string[], token?: vscode.CancellationToken): Promise<void> {
    if (token?.isCancellationRequested) { return; }
    const unique = [...new Set(names.filter(name => /^[A-Za-z_]\w*$/.test(name)))].slice(0, 8);
    const discovered = await Promise.all(unique.map(async name => {
      try {
        return await findFilesAcrossRoots(
          `**/${name}.py`,
          PY_SCAN_EXCLUDE,
          token,
          fsPath => !isEnginePythonLibPath(fsPath)
        );
      } catch {
        return [];
      }
    }));
    if (token?.isCancellationRequested) { return; }
    const missing = discovered.flat().map(uri => uri.fsPath)
      .filter(target => !this.fileCache.has(target)).slice(0, 16);
    for (let offset = 0; offset < missing.length; offset += 8) {
      if (token?.isCancellationRequested) { return; }
      await Promise.all(missing.slice(offset, offset + 8).map(target => this.loadFileOnDemand(target)));
    }
  }

  /** File discovery order mark: called synchronously only when the full scan's
   * discovery list lands (preserving the first-sight order with no
   * re-sorting) -- the load entry point must not record it: on-demand
   * pre-staging (stageRequestFiles) uses readdir order, which would pollute
   * the discovery order. */
  private noteFileOrder(filePath: string): void {
    if (!this.fileOrder.has(filePath)) {
      this.fileOrder.set(filePath, this.nextFileOrder++);
    }
  }

  private async loadFile(filePath: string, version: number): Promise<boolean> {
    const revision = this.revisions.get(filePath) ?? 0;
    this.revisions.set(filePath, revision);
    // Read failures and parse failures are routed apart (audit finding: the two
    // originally shared one catch, so a parse-thread crash would also delete
    // the old class index of a file that still exists). Read failure = the file
    // was deleted / is unreadable, so withdrawing the index is correct; parse
    // failure = the content was read and the file is still on disk, so the old
    // index must be kept and a pending retry registered.
    // Return value: false = this attempt committed no content (pending retry,
    // bounded); true = committed or a harmless early exit.
    let open: Pick<vscode.TextDocument, 'fileName' | 'version' | 'getText'> | undefined;
    let content: string;
    try {
      open = vscode.workspace.textDocuments?.find(doc => doc.fileName === filePath) ?? this.documents.get(filePath);
      // 2026-11-24: the disk leg goes through the shared raw-text cache; a failure is thrown as-is, and the read-failure / parse-failure split is unchanged.
      content = open
        ? open.getText()
        : (await getSharedFileTextCache().readThroughAsync(filePath, p => fs.promises.readFile(p, 'utf8'))).text;
    } catch {
      // A removed/unreadable file must not leave navigable stale classes.
      // PR5: a file that never entered the index (a staging probe's candidate path
      // does not exist etc.) only records its version and leaves the class set /
      // MRO / composition roots alone -- otherwise the probing read would
      // repeatedly wash away the derived state.
      if ((this.revisions.get(filePath) ?? 0) === revision) {
        const wasIndexed = this.fileCache.has(filePath);
        this.stagedRequests.delete(filePath);
        if (wasIndexed) {
          this.unindexFile(filePath); this.fileCache.delete(filePath);
          this.fileOrder.delete(filePath);
          this.mroCache.clear();
          this.generation += 1;
          this.indexVersions.classes += 1;
          this.indexVersions.mro += 1;
          this.resetRoots();
        }
      }
      return false;
    }
    try {
      if ((this.revisions.get(filePath) ?? 0) !== revision) { return true; }
      await this.updateFileResponsive(filePath, content, open?.version ?? version, revision);
      return true;
    } catch {
      // Parse failure (the parse thread crashed / was disabled / a postMessage
      // exception): the file is still on disk, so the old class index is kept --
      // deleting it would leave hover / jumping blank in whole sections until the
      // worker recovers, and the file would be absent out of thin air until the
      // next successful parse. A pending retry is registered (the same channel as a
      // chunk failure, bounded at MAX_SCAN_RETRY_ATTEMPTS, with an existing
      // count left unreset so repeated crashes cannot bypass the cap), and later
      // queries fill it in through schedulePendingScanRetry.
      this.stagedRequests.delete(filePath);
      if (!this.pendingScanRetries.has(filePath)) {
        this.pendingScanRetries.set(filePath, 1);
      }
      jumpLog('info', () => `py 解析失败(保留旧索引,已登记待补重试): ${filePath}`);
      return false;
    }
  }

  /**
   * The registration face for edit events (INDEX-DISCIPLINE-001 ② only trusts
   * what landed on disk; the signature is kept for the existing call sites):
   * - .def/.xml: dependency-graph invalidation as before (the def face is not a
   *   python batch index and is outside this discipline face);
   * - .py: **only the document identity is registered; no reindex is triggered** --
   *   reindexing funnels uniformly into onFileChanged (saves / external disk
   *   writes through the merger); buffer freshness for the query face (completion
   *   / hover) is carried by on-demand parsing in syncDocumentParse /
   *   asyncDocumentParse.
   */
  async onDocumentChanged(document: vscode.TextDocument): Promise<void> {
    if (!/\.(py|def|xml)$/i.test(document.fileName)) { return; }
    // IDE-DIA-003: a same version already in the cache is a zero-cost skip
    // (after diagnostics' syncDocumentParse parses into the cache first, this
    // debounced feed hits there, so each side no longer performs a full parse);
    // only the version number counts -- the cached entry is the parse of that
    // version's buffer and has nothing to do with the document object's
    // identity; an unknown version (undefined) is never judged equal (a
    // vacuous hit on an empty cache would swallow the first parse)
    const cachedVersion = this.fileCache.get(document.fileName)?.version;
    if (cachedVersion !== undefined && cachedVersion === document.version) { return; }
    this.documents.set(document.fileName, document);
    if (!document.fileName.toLowerCase().endsWith('.py')) {
      this.generation += 1;
      const plan = this.dependencyGraph.planInvalidation(document.fileName, 'change');
      if (plan.invalidateFiles.includes(COMPOSITION_ROOTS_NODE)) {
        this.resetRoots();
      }
      return;
    }
    // py: only trust what landed on disk -- an edit event triggers zero reindexing (buffer queries go through the on-demand parse face).
  }

  /** Version-keyed read-only face: a parse result is given only on a cache hit
   * with a matching version, otherwise null (an old generation is never used as
   * the current version; an unknown version (undefined) also gets nothing) */
  getParsedForVersion(filePath: string, version: number | undefined): ParsedPythonFile | null {
    if (version === undefined) { return null; }
    const cached = this.fileCache.get(filePath);
    return cached && cached.version === version ? cached.parsed : null;
  }

  /**
   * INDEX-DISCIPLINE-001 ②: on-demand buffer parsing for the path-keyed query
   * face -- edit events no longer feed the index, so when a query entry sees a
   * registered document whose version is out of step with the cache it parses
   * once on demand (a same-version hit parses nothing; unregistered = a pure
   * disk file passes through at zero cost). This is the compensating face that
   * keeps unsaved-buffer navigation from breaking under "only trust what landed
   * on disk": the index body = the truth on disk, and the queried file itself
   * stays fresh on demand.
   */
  private async ensureBufferFresh(filePath: string): Promise<void> {
    const registered = this.documents.get(filePath);
    if (!registered) { return; }
    if (this.getParsedForVersion(filePath, registered.version) !== null) { return; }
    await this.asyncDocumentParse(registered);
  }

  /** IDE-DIA-003 shared parse face: a same-version hit returns the cached object
   * directly (zero parsing); a miss parses synchronously and books it in the
   * cache by version -- receiver diagnostics and the class index consume the same
   * parse, and a later onDocumentChanged deduplicates the same version instead of
   * each performing a full parse */
  syncDocumentParse(document: Pick<vscode.TextDocument, 'fileName' | 'version' | 'getText'>): ParsedPythonFile {
    const hit = this.getParsedForVersion(document.fileName, document.version);
    if (hit) { return hit; }
    // IDE-REV-001: synchronously committing a new version must synchronously
    // advance the version-generation token and the current document identity --
    // otherwise a following same-version edit notification hits the cache and
    // returns early (without incrementing the token), while an in-flight old
    // version's worker revision guard still compares against the old token and
    // its reply overwrites the published new generation back to the old one; an
    // unregistered identity also makes an on-demand load fall back to stale disk
    // content
    this.revisions.set(document.fileName, (this.revisions.get(document.fileName) ?? 0) + 1);
    this.documents.set(document.fileName, document);
    const parsed = parsePythonFile(document.getText(), document.fileName);
    this.commitParsedFile(document.fileName, parsed, document.version ?? -1, 0);
    return parsed;
  }

  /** IDE-REV-009 asynchronous shared parse face: the consumer face of the
   * receiver diagnostics' asynchronous entry -- a same-version hit is taken
   * directly (zero parsing); a miss goes through updateFileResponsive (256KiB
   * and up enters pythonParserWorker, so the host does not fall into a
   * synchronous whole-file parse), and after the version-keyed commit the same
   * parse is read back for the index's same-version de-duplication. A parse
   * failure (worker disabled / rejected at the backlog byte cap) registers a
   * bounded pending retry exactly as loadFile does and returns null -- the
   * caller aborts this round and never falls back to a host-side synchronous
   * whole-file parse. The revision token and document identity advance
   * synchronously before dispatch (the REV-001 discipline): a concurrent edit
   * advances the token, the in-flight reply is dropped by the
   * updateFileResponsive guard, and a null read-back likewise aborts this
   * round. */
  async asyncDocumentParse(
    document: Pick<vscode.TextDocument, 'fileName' | 'version' | 'getText'>
  ): Promise<ParsedPythonFile | null> {
    const hit = this.getParsedForVersion(document.fileName, document.version);
    if (hit) { return hit; }
    this.revisions.set(document.fileName, (this.revisions.get(document.fileName) ?? 0) + 1);
    const revision = this.revisions.get(document.fileName)!;
    this.documents.set(document.fileName, document);
    try {
      await this.updateFileResponsive(
        document.fileName, document.getText(), document.version ?? -1, revision
      );
    } catch (error) {
      this.stagedRequests.delete(document.fileName);
      if (!this.pendingScanRetries.has(document.fileName)) {
        this.pendingScanRetries.set(document.fileName, 1);
      }
      // The same capability limit is made explicit only once (sharing the
      // de-duplication table with onDocumentChanged); an oversized file that is
      // only opened and never edited goes through this face and still becomes
      // visible to the user.
      noteDegradedParse(document.fileName, error);
      jumpLog('info', () => `py 异步共享解析未入索引(保留旧索引,已登记待补重试): ${document.fileName}`);
      return null;
    }
    return this.getParsedForVersion(document.fileName, document.version ?? -1);
  }

  async resolveClassBase(document: vscode.TextDocument, expression: string, line?: number,
    token?: vscode.CancellationToken): Promise<PythonClassDef | null> {
    if (token?.isCancellationRequested) { return null; }
    // INDEX-DISCIPLINE-001 ②: buffer freshness for the query face now goes through the on-demand parse face (edit events no longer feed the index; here a same-version hit parses nothing, and a miss parses + commits by version).
    await this.asyncDocumentParse(document);
    // ② PR5: consult the snapshot + the built index first, and parse the files a
    // request needs as on-demand single files; the full scan fills in in the
    // background, so a base-class jump no longer waits for a 107s-class cold-start
    // scan.
    this.scheduleBackgroundScan();
    const owner = line === undefined ? undefined : await this.findEnclosingClass(document.fileName, line) ?? undefined;
    await this.stageRequestFiles(document.fileName, token);
    if (token?.isCancellationRequested) { return null; }
    const resolved = this.resolveSymbol(document.fileName, expression, new Set(), owner);
    if (resolved) {
      return resolved;
    }
    // Targeted backstop: under a one-class-per-file layout, fill in `**/<Name>.py` by class name and retry once
    await this.stageClassNameFiles([expression.split('.')[0]], token);
    if (token?.isCancellationRequested) { return null; }
    return this.resolveSymbol(document.fileName, expression, new Set(), owner);
  }

  /** Class name -> definition list (several places may share the same name) */
  async findClassesByName(name: string): Promise<PythonClassDef[]> {
    await this.ensureScanned();
    return this.byName.get(name) ?? [];
  }

  /** Find the inner class definition for a file line (used to locate the class a call site sits in) */
  async findEnclosingClass(filePath: string, line: number): Promise<PythonClassDef | null> {
    // ② PR5: a file-local query -- an on-demand single-file parse suffices; it does not wait for the whole-repo scan
    let cached = this.fileCache.get(filePath);
    if (!cached) {
      await this.loadFileOnDemand(filePath);
      cached = this.fileCache.get(filePath);
    }
    if (!cached) {
      return null;
    }
    // The inner one wins (when endLine is equal, take the larger startLine)
    const hits = cached.parsed.classes.filter(cls => line >= cls.startLine && line < cls.endLine);
    if (hits.length === 0) {
      return null;
    }
    return hits.reduce((a, b) => (b.startLine > a.startLine ? b : a));
  }

  /** Compute a class's MRO (including itself), resolving base classes across files */
  async computeMRO(className: string): Promise<string[]> {
    await this.ensureScanned();
    const definitions = this.byName.get(className) ?? [];
    return definitions.length === 1 ? this.mroClasses(definitions[0]).map(cls => cls.name) : [];
  }

  /** All descendants of the class named `name` (the transitive closure of direct subclasses, with a cycle guardrail) */
  async descendantsOf(name: string): Promise<PythonClassDef[]> {
    await this.ensureScanned();
    const seeds = new Set((this.byName.get(name) ?? []).map(cls => this.classKey(cls)));
    const out: PythonClassDef[] = [];
    for (const defs of this.byName.values()) {
      for (const cls of defs) {
        if (!seeds.has(this.classKey(cls)) && this.mroClasses(cls).some(base => seeds.has(this.classKey(base)))) { out.push(cls); }
      }
    }
    return out;
  }

  /**
   * The primary-form resolution: start from `self`'s **static class**, resolve
   * the C3 MRO, and hit mixin definitions across files.
   * ① the static class's own MRO (its ancestors) -- covers "a subclass calls a
   *    base class";
   * ② the static class's MRO comes up empty -> look in reverse for **classes
   *    inheriting the static class** (sibling mixins through a common subclass,
   *    e.g. MixinB.self.x() only lands on MixinA through the MRO of
   *    Avatar = (MixinA, MixinB)).
   * After de-duplication all candidates are returned in the order ancestors
   * first -> descendants in declaration order (for picking from the Location[]
   * list).
   * IDE-IDX-018: the result carries a partial marker -- when the budget expires
   * or is cancelled the enumeration is incomplete, and the consumer must not take
   * an empty set as an authoritative negative verdict of a complete
   * enumeration.
   */
  async resolveSelfMethodResolution(
    filePath: string,
    line: number,
    methodName: string,
    document?: vscode.TextDocument,
    token?: vscode.CancellationToken,
    /** Budget (ms) for composition roots / full readiness; tests inject a small budget to reproduce the timeout path deterministically */
    budgetMs: number = INTERACTIVE_INDEX_WAIT_MS
  ): Promise<SelfMethodResolution> {
    if (token?.isCancellationRequested) { return { candidates: [], partial: true }; }
    const queryTimer = jumpTimeStart();
    jumpLog('info', () => `py 查询 ${path.basename(filePath)}:${line + 1} 方法=${methodName}`);
    // INDEX-DISCIPLINE-001 ②: as with resolveClassBase -- the query face goes through on-demand parsing.
    if (document) { await this.asyncDocumentParse(document); }
    await this.ensureBufferFresh(filePath);
    // ② PR5: a first query no longer blocks on the full scan -- the snapshot /
    // built index answers first, and the files a request needs (the query file /
    // the same directory / import candidates) are parsed on demand as single
    // files, with the full scan filling in the background.
    this.scheduleBackgroundScan();
    const enclosing = await this.findEnclosingClass(filePath, line);
    if (token?.isCancellationRequested) { return { candidates: [], partial: true }; }
    if (!enclosing) {
      jumpLog('info', () => 'py 查询落空: 光标不在任何类内(或文件未入索引)');
      return { candidates: [], partial: false };
    }
    await this.stageRequestFiles(filePath, token);
    if (token?.isCancellationRequested) { return { candidates: [], partial: true }; }
    const seen = new Set<string>();
    const push = (loc: PythonMethodLocation | null, out: PythonMethodLocation[]): void => {
      if (!loc) {
        return;
      }
      const key = `${loc.filePath}::${loc.line}::${loc.character}`;
      if (seen.has(key)) {
        // The same landing point arrives first in an unannotated form (① the
        // static MRO) and later in a composition-root-annotated form (②): when
        // the position is equal the richer annotation wins -- e.g. an entity
        // script class inherits a parent implementation through Python
        // inheritance, so ① hits directly and ② hits the same line via the
        // composition root, and the unannotated version must not swallow the
        // composition-root annotation.
        const idx = out.findIndex(item =>
          `${item.filePath}::${item.line}::${item.character}` === key);
        if (idx >= 0 && !out[idx].compositionRoot && loc.compositionRoot) {
          out[idx] = loc;
        }
        return;
      }
      seen.add(key);
      out.push(loc);
    };

    const out: PythonMethodLocation[] = [];
    // ①② two-pass query: the second pass runs only when the first pass missed
    // and the background scan has not converged -- it first waits for full
    // readiness and then re-queries (③'s reverse-form descendant set cannot be
    // targeted on demand and needs a whole-repo criterion; if ①② hit, the
    // first query does not wait for the full scan -- which is exactly the
    // de-blocking main path of PR5).
    for (let pass = 0; pass < 2; pass += 1) {
    // ① Record the static class's MRO hit first, but do not return early here.
    // The same mixin can be composed by several entities, and those entities'
    // MROs may override the method; for example CombatMixin.self.compute_damage
    // hits CriticalDamageMixin, DamageMixin and EliteDamageMixin on
    // TrainingAvatar, TrainingMonster and EliteMonster respectively. Returning
    // only the static MRO would miss every target valid at runtime.
    push(this.lookupClass(enclosing, methodName), out);
    if (out.length === 0 && pass === 0) { jumpLog('debug', () => `py ①静态类 MRO 未命中(enclosing=${enclosing.name})`); }

    // ② Composition roots (user 2026-10-16: every entity in the entity roster,
    // its field objects, and its components are all composition roots, not just
    // a single entry class): which composition roots include the static class ->
    // search inside every composition root's MRO.
    // Each root first goes through exact Python class identity, then through the
    // current asset project's .declared mixins (Parent -> Interfaces ->
    // Components); every hit across multiple roots / multiple places is kept
    // (the push above de-duplicates), and the provider emits a Location[] list
    // rather than jumping to the first one for the user.
    const rootsReady = await raceWithBudget('definition:composition-roots',
      this.ensureCompositionRoots().then(() => true), budgetMs, token);
    if (!rootsReady) {
      // Composition root derivation over budget: the already hit ① static MRO
      // targets must be returned as usual; a wait timeout must not discard the
      // valid targets along with them (otherwise a self jump misses in its
      // entirety on cold / slow assets).
      // The composition-root side is not filled in this round; by the next query
      // the derivation results are ready / still being waited on and it
      // completes naturally.
      if (out.length > 0) {
        jumpLog('info', () =>
          `py 组合根等待超时(${budgetMs}ms),先返回已命中 ${out.length} 个静态目标 ${queryTimer()}ms`);
      } else {
        jumpLog('info', () => `py 组合根等待超时(${budgetMs}ms),无静态目标,返回空集(partial) ${queryTimer()}ms`);
      }
      // IDE-IDX-018: ②③ were not fully searched, so the result must be marked
      // partial -- the consumer must not publish this empty set / static subset
      // as an authoritative negative verdict of a complete enumeration.
      return { candidates: out, partial: true };
    }
    const scope = [...this.rootsByScope.keys()].filter(root => filePath.startsWith(root + path.sep))
      .sort((left, right) => right.length - left.length)[0];
    const composition = scope ? this.rootsByScope.get(scope) : undefined;
    const rootNames = composition?.roots ?? [];
    for (const root of rootNames) {
      if (token?.isCancellationRequested) { return { candidates: [], partial: true }; }
      const roots = (this.byName.get(root) ?? []).filter(cls => this.compatibleContext(cls, enclosing));
      for (const rootClass of roots) {
        const contains = this.mroClasses(rootClass).some(cls => this.classKey(cls) === this.classKey(enclosing));
        const declared = composition?.defMixins.get(root) ?? [];
        // PR5: compare by the stable classKey rather than an object reference -- staging / background scanning may re-parse the query file, so the old reference and the re-indexed class object are no longer the same instance.
        const declaredEnclosing = declared.some(name => {
          const resolved = this.resolveSymbol(rootClass.filePath, name);
          return !!resolved && this.classKey(resolved) === this.classKey(enclosing);
        });
        if (!contains && !declaredEnclosing) { continue; }
        const implementation = this.lookupClass(rootClass, methodName);
        if (implementation) { push({ ...implementation, compositionRoot: root }, out); }
        else {
          for (const name of declared) {
            const mixin = this.resolveSymbol(rootClass.filePath, name);
            if (mixin) {
              const hit = this.lookupClass(mixin, methodName);
              if (hit) { push({ ...hit, compositionRoot: root }, out); }
            }
          }
        }
      }
    }
    if (out.length > 0 || pass === 1) { break; }
    // Both ①② missed: wait for the background full scan to converge and re-query once (a failed / slow scan is absorbed inside ensureScanned)
    const scanReady = await raceWithBudget('definition:python-index',
      this.ensureScanned().then(() => true), budgetMs, token);
    // The full scan over budget: ①② came back empty on the first query and the second-pass query never ran -- the enumeration is incomplete, so mark partial too.
    if (!scanReady) { return { candidates: [], partial: true }; }
    }
    if (out.length > 0) { return { candidates: out, partial: false }; }

    // Reverse lookup uses exact class identities as well, so unrelated same-name
    // classes in another role/package cannot become sibling mixin providers.
    const descendants: Array<{ order: number; sub: PythonClassDef }> = [];
    for (const defs of this.byName.values()) {
      if (token?.isCancellationRequested) { return { candidates: [], partial: true }; }
      for (const sub of defs) {
        if (!this.compatibleContext(sub, enclosing)) { continue; }
        if (this.mroClasses(sub).some(cls => this.classKey(cls) === this.classKey(enclosing))) {
          descendants.push({ order: this.fileOrder.get(sub.filePath) ?? Number.MAX_SAFE_INTEGER, sub });
        }
      }
    }
    // Candidate order is settled by the file discovery order: the completion
    // order of chunked Promise.all concurrent loading flips with IO timing
    // (concurrent completion order != discovery order), so without sorting the
    // same two candidates differ only in order (the CI 40470720225 red case).
    // Stable sort: several descendants in one file keep their index appearance
    // order; entries with no sequence number go last.
    descendants.sort((left, right) => left.order - right.order);
    for (const { sub } of descendants) {
      push(this.lookupClass(sub, methodName), out);
    }
    if (out.length > 0) {
      jumpLog('info', () =>
        `py 命中(③反向后代) ${out[0].className} → ${path.basename(out[0].filePath)}:${out[0].line + 1} ${queryTimer()}ms`
      );
    } else {
      jumpLog('info', () => `py 落空: 静态类/组合根/反向后代均无 ${methodName}(${queryTimer()}ms)`);
    }
    return { candidates: out, partial: false };
  }

  /** Compatibility entry: the candidate array only (tests / older call faces); use resolveSelfMethodResolution when the partial state is needed */
  async resolveSelfMethodCandidates(
    filePath: string,
    line: number,
    methodName: string,
    document?: vscode.TextDocument,
    token?: vscode.CancellationToken,
    budgetMs: number = INTERACTIVE_INDEX_WAIT_MS
  ): Promise<PythonMethodLocation[]> {
    const { candidates } = await this.resolveSelfMethodResolution(
      filePath, line, methodName, document, token, budgetMs);
    return candidates;
  }

  /** Compatibility entry: the first candidate (in the single-implementation case it is the unique answer) */
  async resolveSelfMethod(
    filePath: string,
    line: number,
    methodName: string
  ): Promise<PythonMethodLocation | null> {
    const candidates = await this.resolveSelfMethodCandidates(filePath, line, methodName);
    return candidates.length > 0 ? candidates[0] : null;
  }

  /** Which base classes / mixins provide to a given class (for CodeLens): the MRO with itself removed */
  async mixinsProvidingTo(className: string): Promise<string[]> {
    const mro = await this.computeMRO(className);
    return mro.filter(name => name !== className);
  }

  /** Which classes in the MRO provide a given method name (for CodeLens / multiple implementations) */
  async providersOfMethod(className: string, methodName: string): Promise<PythonMethodLocation[]> {
    await this.ensureScanned();
    const out: PythonMethodLocation[] = [];
    for (const definition of this.byName.get(className) ?? []) {
      const chain = this.mroClasses(definition);
      for (const cls of chain) {
        const loc = cls.methods.get(methodName);
        if (loc) { out.push({ ...loc, filePath: cls.filePath, className: cls.name, mro: chain.map(item => item.name) }); }
      }
    }
    return out;
  }

  /**
   * MRO-CHAIN: the execution chains of methodName from the viewpoint of the
   * "class the cursor is in" and of every composition root / descendant that
   * includes it. Chain order = the MRO order filtered down to the definers =
   * the real execution order of `for cls in __mro__` traversal / super()
   * relay (matching the runtime C3, pinned by a real python3 run-off in
   * tests/mroChainLens.test.ts). Viewpoint collection shares the same source as
   * resolveSelfMethodResolution ②: a composition root includes the class
   * directly (its Python MRO contains it) or declares it as a mixin in its .def
   * (Parent / Interfaces / Components); when the composition-root wait goes
   * over budget the already collected chains are returned (a chain is a hint
   * face and never an authoritative negative verdict).
   */
  async resolveMroMethodChains(
    filePath: string,
    line: number,
    methodName: string,
    document?: vscode.TextDocument,
    token?: vscode.CancellationToken,
    budgetMs: number = INTERACTIVE_INDEX_WAIT_MS
  ): Promise<MroMethodChain[]> {
    if (token?.isCancellationRequested) { return []; }
    if (document) { await this.asyncDocumentParse(document); }
    await this.ensureBufferFresh(filePath);
    this.scheduleBackgroundScan();
    const enclosing = await this.findEnclosingClass(filePath, line);
    if (token?.isCancellationRequested || !enclosing) { return []; }
    await this.stageRequestFiles(filePath, token);
    if (token?.isCancellationRequested) { return []; }

    const chains: MroMethodChain[] = [];
    const seenRoots = new Set<string>();
    const addRoot = (root: PythonClassDef): void => {
      const key = this.classKey(root);
      if (seenRoots.has(key)) { return; }
      seenRoots.add(key);
      const entries: MroChainEntry[] = [];
      for (const cls of this.mroClasses(root)) {
        const loc = cls.methods.get(methodName);
        if (loc) {
          entries.push({ className: cls.name, filePath: cls.filePath, line: loc.line, character: loc.character });
        }
      }
      if (entries.length > 0) { chains.push({ rootClassName: root.name, entries }); }
    };

    // ② Composition root viewpoint: the same inclusion decision as
    // resolveSelfMethodResolution ②.
    // Both reverse descendants (③) and composition roots need a whole-repo
    // criterion: wait for full convergence within budget, and on a timeout return
    // the chains already collected first
    // (a chain is a hint face, no authoritative negative verdict is published, and
    // the next query fills the rest in naturally). The ① static arm is also
    // computed only after the wait: under a degraded parse state a base class
    // reachable only indirectly (a package __init__ alias re-export and the
    // like) resolves to null and gets dropped, and mroClasses's mroCache does
    // not go stale on a later parse -- the first degraded MRO would be cached
    // for good, so every chain starts from the whole-repo criterion.
    const rootsReady = await raceWithBudget('definition:composition-roots',
      this.ensureCompositionRoots().then(() => true), budgetMs, token);
    const scanReady = await raceWithBudget('definition:python-index',
      this.ensureScanned().then(() => true), budgetMs, token);

    // ① The static class's own viewpoint (small roots not in the entity roster get a chain too)
    addRoot(enclosing);

    if (rootsReady) {
      const scope = [...this.rootsByScope.keys()].filter(root => filePath.startsWith(root + path.sep))
        .sort((left, right) => right.length - left.length)[0];
      const composition = scope ? this.rootsByScope.get(scope) : undefined;
      for (const root of composition?.roots ?? []) {
        if (token?.isCancellationRequested) { break; }
        for (const rootClass of this.byName.get(root) ?? []) {
          if (!this.compatibleContext(rootClass, enclosing)) { continue; }
          const contains = this.mroClasses(rootClass).some(cls => this.classKey(cls) === this.classKey(enclosing));
          const declared = composition?.defMixins.get(root) ?? [];
          const declaredEnclosing = declared.some(name => {
            const resolved = this.resolveSymbol(rootClass.filePath, name);
            return !!resolved && this.classKey(resolved) === this.classKey(enclosing);
          });
          if (contains) { addRoot(rootClass); }
          if (!contains && !declaredEnclosing) { continue; }
          // When a .def-declared mixin (Parent / Interfaces / Components) is not
          // among the Python bases, the mixin's own MRO also gets a chain
          // (root name = that mixin class). The mixin loop sits behind the
          // containment gate: an unrelated roster root must not inject its
          // def-mixin chains into an unrelated class's query (2026-11-26 user
          // report: in a multi-class file every class was tagged with the
          // entity's interface chain). The two preserved faces: the entity's
          // own view (contains) and editing a mixin file (declaredEnclosing).
          for (const name of declared) {
            const mixin = this.resolveSymbol(rootClass.filePath, name);
            if (mixin) { addRoot(mixin); }
          }
        }
      }
      // ③ Reverse descendants: a same-named hook in the mixin file, and each descendant root's (subclass's) own chain (needs the full index)
      if (scanReady) {
        for (const defs of this.byName.values()) {
          if (token?.isCancellationRequested) { break; }
          for (const sub of defs) {
            if (!this.compatibleContext(sub, enclosing)) { continue; }
            if (this.mroClasses(sub).some(cls => this.classKey(cls) === this.classKey(enclosing))) {
              addRoot(sub);
            }
          }
        }
      }
    }
    return chains;
  }
}

/** Display relativized under the workspace root (for tests and logs) */
export function displayPath(filePath: string): string {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (folder && filePath.startsWith(folder)) {
    return path.relative(folder, filePath).replace(/\\/g, '/');
  }
  return filePath;
}
