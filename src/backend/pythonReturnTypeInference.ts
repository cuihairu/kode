import * as fs from 'fs';
import { readFileUtf8Recorded } from './fileReadMetrics';
import * as path from 'path';

import { recordLanguageServiceOperation } from '../languageServiceMetrics';
import { annotationSourceLog } from './annotationSourceLog';
import { maskPythonNonCode } from './pythonLexicalMask';
import { extractFileReturnAnnotationFactsFromRust } from './pythonReturnAnnotationsRust';

/**
 * Local variable return type inference (user order 2026-10-21: "data = activity_data.get_data()
 * -> data: JSONDATA"): the hover face of `<name> = <rhs>` infers the variable's type from the
 * return annotation of the function called on the rhs. Directory discovery and source reads are
 * async; this module does not import vscode.
 *
 * Batch 3 (RUST-MIGRATION-AUDIT-006 B1 lane): the per-file extraction core
 * (maskCodeLine/collectFileAnnotationFacts/extractFileImports/parseLocalAssignmentCall) has been
 * folded into Rust (`$/kode/python/returnAnnotations`, ported verbatim); the async bucket build
 * face (extractFileReturnAnnotationsAsync, cold build per file) is Rust-first with cooperative
 * TS extraction as the fallback; the synchronous paths (save swaps bucket / document version
 * buckets / replay) and the query cascade (matchingAssignments/extractFileImports/three-level
 * cascade) stay in TS -- a synchronous boundary cannot await an RPC, so the host machinery is
 * untouched.
 *
 * Resolution priority (the user's own words): the python-implemented `def get_data(...) -> X:`
 * return annotation (locate the definition by method name across the project's python files; a
 * single call level plus one attribute call a.b() suffices, no chasing cross-variable
 * propagation) -> a .def method return declaration if present -> unknown means display nothing.
 * The KBEngine .def method format only has <Arg> parameter declarations and no return
 * declaration syntax, so the second level structurally does not exist under the current def
 * format; not solved, not invented. Only a resolved result is shown ("display only what can be
 * inferred"): a missing annotation or a broken resolution chain always returns null and the
 * caller shows no type at all (no Any, no empty type).
 *
 * The index is cached per workspace with a 3-second TTL for self-healing (new files/edits become
 * visible within 3 seconds, no watcher dependency); tests call resetPythonReturnAnnotationCache()
 * to clear immediately.
 */

/** Scan exclusion face: the directory name list sharing the same convention as pythonClassIndex.PY_SCAN_EXCLUDE */
const SCAN_EXCLUDED_DIRS = new Set([
  'node_modules', 'third_party', '.git', 'vcpkg', 'build', 'dist', 'out',
  '.tmp', 'perf', '.venv', 'venv', 'site-packages', '__pycache__', 'coverage'
]);

const INDEX_TTL_MS = 3000;
const ANNOTATION_READ_CONCURRENCY = 8;

/** The single-level call in one `name = rhs` assignment (a simple call f() or an attribute call a.b()) */
export interface LocalAssignmentCall {
  /** The assigned variable name (a simple identifier, no dots) */
  target: string;
  /** The receiver of an attribute call (the a of a.b()); null for a simple call f() */
  receiver: string | null;
  /** The called function/method name */
  methodName: string;
}

const ASSIGNMENT_PATTERN = /^(\s*)([A-Za-z_]\w*)\s*=\s*(?!=)(.+)$/;
const SIMPLE_CALL_PATTERN = /^([A-Za-z_]\w*)\s*\(/;
const ATTRIBUTE_CALL_PATTERN = /^([A-Za-z_]\w*)\s*\.\s*([A-Za-z_]\w*)\s*\(/;

/** Strip comments and strings without shifting positions (a condensed version of pythonClassIndex.pythonCodeLines) */
function maskCodeLine(raw: string): string {
  let quote = '';
  let triple = false;
  let masked = '';
  for (let col = 0; col < raw.length; col += 1) {
    const ch = raw[col];
    if (quote) {
      if (ch === '\\') { masked += '  '; col += 1; continue; }
      if (triple && raw.slice(col, col + 3) === quote.repeat(3)) {
        quote = ''; triple = false; masked += '   '; col += 2;
      } else if (!triple && ch === quote) { quote = ''; masked += ' '; }
      else { masked += ' '; }
      continue;
    }
    if (ch === '#') { masked += ' '.repeat(raw.length - col); break; }
    if (ch === "'" || ch === '"') {
      quote = ch;
      triple = raw.slice(col, col + 3) === ch.repeat(3);
      masked += triple ? '___' : '_';
      if (triple) { col += 2; }
      continue;
    }
    masked += ch;
  }
  return masked;
}

/**
 * Single-line assignment parsing: `data = activity_data.get_data()` -> hit; when the rhs is not
 * a "single-level call as a whole" (chained f().g(), binary expressions, literals, etc.) -> null
 * (one level is enough, no chasing).
 */
export function parseLocalAssignmentCall(lineText: string): LocalAssignmentCall | null {
  const match = ASSIGNMENT_PATTERN.exec(lineText);
  if (!match) {
    return null;
  }
  const rhs = maskCodeLine(match[3]).trim();
  const attribute = ATTRIBUTE_CALL_PATTERN.exec(rhs);
  if (attribute && rhs.endsWith(')')) {
    return { target: match[2], receiver: attribute[1], methodName: attribute[2] };
  }
  const simple = SIMPLE_CALL_PATTERN.exec(rhs);
  if (simple && rhs.endsWith(')') && !rhs.includes('.')) {
    return { target: match[2], receiver: null, methodName: simple[1] };
  }
  return null;
}

/**
 * Read the return annotation text of `def <methodName>(...) -> X:` from python source.
 * Signatures may span lines (the signature closes at the colon once paren depth returns to
 * zero); def present but `->` missing -> null (no annotation, nothing displayed); def absent
 * -> null. The returned annotation string is already whitespace-trimmed.
 */
export function extractDefReturnAnnotation(source: string, methodName: string): string | null {
  const lines = source.split(/\r?\n/);
  const defHead = new RegExp(`^\\s*def\\s+${methodName}\\s*\\(`);
  for (let start = 0; start < lines.length; start += 1) {
    if (!defHead.test(maskCodeLine(lines[start]))) {
      continue;
    }
    // Closing: the signature ends at the first colon once paren depth returns to zero after the
    // parameter parens opened (colons inside parameter annotations sit inside parens and do not
    // close); accepted on the def line or on later lines alike.
    let depth = 0;
    let sawParens = false;
    let signature = '';
    for (let line = start; line < Math.min(lines.length, start + 64); line += 1) {
      const masked = maskCodeLine(lines[line]);
      for (const ch of masked) {
        if (ch === '(') { depth += 1; sawParens = true; }
        else if (ch === ')') { depth = Math.max(0, depth - 1); }
        else if (ch === ':' && sawParens && depth === 0) {
          const arrow = signature.indexOf('->');
          if (arrow < 0) {
            return null;
          }
          const annotation = signature.slice(arrow + 2).trim();
          return annotation.length > 0 ? annotation : null;
        }
        signature += ch;
      }
    }
    return null;
  }
  return null;
}

/** Project python file list (async walk of the root tree; after cancellation no further
 *  directories are visited), sorted to stay deterministic.
 *  RUST-001: the original synchronous whole-repo readdirSync version had no production caller
 *  and was deleted -- dormant violation faces are not kept; all callers go through this function. */
export async function collectProjectPythonFilesAsync(
  workspaceRoot: string,
  limit = 20000,
  token?: { readonly isCancellationRequested: boolean }
): Promise<string[]> {
  const files: string[] = [];
  const visit = async (dir: string): Promise<void> => {
    if (token?.isCancellationRequested || files.length >= limit) return;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (token?.isCancellationRequested || files.length >= limit) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SCAN_EXCLUDED_DIRS.has(entry.name)) await visit(full);
      } else if (entry.isFile() && entry.name.endsWith('.py')) {
        files.push(full);
      }
    }
  };
  await visit(workspaceRoot);
  return files.sort();
}

/** Method name -> return annotation (with multiple same-named definitions, the first annotated one in scan order wins; missing annotations do not enter the table) */
export type PythonReturnAnnotationIndex = Map<string, string>;

/**
 * One pass over the lines extracting annotation facts for "each method's first definition"
 * (same convention as IDE-HOV-002/003): record(name, annotation) fires where the signature
 * closes; def present but `->` missing -> annotation=null (document buckets use this to shadow
 * the stale disk annotation of the same name); truncated signatures or ones displaced by a
 * later definition record no fact.
 * Exported for the Rust<->TS parity tests (the single-source face for facts).
 */
export function collectFileAnnotationFacts(
  source: string,
  record: (name: string, annotation: string | null) => void
): void {
  const seen = new Set<string>();
  const defHead = /^\s*def\s+([A-Za-z_]\w*)\s*\(/;
  let current: { name: string; signature: string; depth: number; sawParens: boolean; lines: number } | undefined;

  for (const rawLine of source.split(/\r?\n/)) {
    const masked = maskCodeLine(rawLine);
    const nextDef = defHead.exec(masked)?.[1];
    // An incomplete signature must not swallow later definitions, nor borrow a later definition's colon or annotation.
    if (current && nextDef) { current = undefined; }
    if (!current) {
      const name = nextDef;
      if (!name || seen.has(name)) { continue; }
      seen.add(name);
      current = { name, signature: '', depth: 0, sawParens: false, lines: 0 };
    }
    current.lines += 1;
    for (const ch of masked) {
      if (ch === '(') { current.depth += 1; current.sawParens = true; }
      else if (ch === ')') { current.depth = Math.max(0, current.depth - 1); }
      else if (ch === ':' && current.sawParens && current.depth === 0) {
        const arrow = current.signature.indexOf('->');
        const annotation = arrow < 0 ? '' : current.signature.slice(arrow + 2).trim();
        record(current.name, annotation.length > 0 ? annotation : null);
        current = undefined;
        break;
      }
      current.signature += ch;
    }
    if (current && current.lines >= 64) { current = undefined; }
  }
}

/** One pass over the source lines, extracting each function's first-definition return annotation. */
export function extractFileReturnAnnotations(source: string): PythonReturnAnnotationIndex {
  const result: PythonReturnAnnotationIndex = new Map();
  collectFileAnnotationFacts(source, (name, annotation) => {
    if (annotation !== null) { result.set(name, annotation); }
  });
  return result;
}

const ANNOTATION_YIELD_INTERVAL = 16 * 1024;
type YieldBudget = { remaining: number };

async function maskCodeLineCooperatively(raw: string, budget: YieldBudget): Promise<string> {
  let quote = '';
  let triple = false;
  let masked = '';
  for (let col = 0; col < raw.length; col += 1) {
    if (--budget.remaining <= 0) {
      budget.remaining = ANNOTATION_YIELD_INTERVAL;
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    const ch = raw[col];
    if (quote) {
      if (ch === '\\') { masked += '  '; col += 1; continue; }
      if (triple && raw.slice(col, col + 3) === quote.repeat(3)) {
        quote = ''; triple = false; masked += '   '; col += 2;
      } else if (!triple && ch === quote) { quote = ''; masked += ' '; }
      else { masked += ' '; }
      continue;
    }
    if (ch === '#') { masked += ' '.repeat(raw.length - col); break; }
    if (ch === "'" || ch === '"') {
      quote = ch;
      triple = raw.slice(col, col + 3) === ch.repeat(3);
      masked += triple ? '___' : '_';
      if (triple) col += 2;
      continue;
    }
    masked += ch;
  }
  return masked;
}

/** Cooperative line-by-line collection: same convention as the synchronous collectFileAnnotationFacts
 * (a truncated signature borrows nothing from later definitions; first definition per name),
 * yielding the event loop via setImmediate on a character budget. */
async function collectFileAnnotationFactsAsync(
  source: string,
  record: (name: string, annotation: string | null) => void
): Promise<void> {
  const seen = new Set<string>();
  const defHead = /^\s*def\s+([A-Za-z_]\w*)\s*\(/;
  const budget: YieldBudget = { remaining: ANNOTATION_YIELD_INTERVAL };
  let current: { name: string; signature: string; depth: number; sawParens: boolean; lines: number } | undefined;
  for (const rawLine of source.split(/\r?\n/)) {
    const masked = await maskCodeLineCooperatively(rawLine, budget);
    const nextDef = defHead.exec(masked)?.[1];
    if (current && nextDef) current = undefined;
    if (!current) {
      const name = nextDef;
      if (!name || seen.has(name)) continue;
      seen.add(name);
      current = { name, signature: '', depth: 0, sawParens: false, lines: 0 };
    }
    current.lines += 1;
    for (const ch of masked) {
      if (--budget.remaining <= 0) {
        budget.remaining = ANNOTATION_YIELD_INTERVAL;
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      if (ch === '(') { current.depth += 1; current.sawParens = true; }
      else if (ch === ')') { current.depth = Math.max(0, current.depth - 1); }
      else if (ch === ':' && current.sawParens && current.depth === 0) {
        const arrow = current.signature.indexOf('->');
        const annotation = arrow < 0 ? '' : current.signature.slice(arrow + 2).trim();
        record(current.name, annotation.length > 0 ? annotation : null);
        current = undefined;
        break;
      }
      current.signature += ch;
    }
    if (current && current.lines >= 64) current = undefined;
  }
}

/** Same convention as the synchronous extractor; both large files and single long signatures yield
 * the event loop on a character budget.
 * Batch 3: Rust-first (the `$/kode/python/returnAnnotations` facts face builds the table with the
 * same convention, insertion order = fact order; no gate / failure / malformed null -> cooperative
 * TS extraction as the fallback). */
export async function extractFileReturnAnnotationsAsync(source: string): Promise<PythonReturnAnnotationIndex> {
  const rustFacts = await extractFileReturnAnnotationFactsFromRust(source);
  if (rustFacts !== null) {
    const rustResult: PythonReturnAnnotationIndex = new Map();
    for (const fact of rustFacts) {
      if (fact.annotation !== null) { rustResult.set(fact.name, fact.annotation); }
    }
    return rustResult;
  }
  const result: PythonReturnAnnotationIndex = new Map();
  await collectFileAnnotationFactsAsync(source, (name, annotation) => {
    if (annotation !== null) { result.set(name, annotation); }
  });
  return result;
}

export function buildReturnAnnotationIndex(sources: readonly string[]): PythonReturnAnnotationIndex {
  const index: PythonReturnAnnotationIndex = new Map();
  for (const source of sources) {
    for (const [name, annotation] of extractFileReturnAnnotations(source)) {
      if (!index.has(name)) { index.set(name, annotation); }
    }
  }
  return index;
}

interface ReturnAnnotationCacheEntry {
  builtAtMs: number;
  index: PythonReturnAnnotationIndex;
  /** The disk face as per-file buckets (IDE-HOV-012): a save only replaces that file's bucket, the merged view is recomputed purely in memory, other files are not re-read */
  fileBuckets: Map<string, PythonReturnAnnotationIndex>;
}

/** Merge file buckets in insertion order (first seen wins, matching the full-scan merge semantics; Map.set swaps the bucket but not the position, so order is stable). */
function mergeAnnotationBuckets(
  fileBuckets: Map<string, PythonReturnAnnotationIndex>
): PythonReturnAnnotationIndex {
  const index: PythonReturnAnnotationIndex = new Map();
  for (const bucket of fileBuckets.values()) {
    for (const [name, annotation] of bucket) {
      if (!index.has(name)) { index.set(name, annotation); }
    }
  }
  return index;
}

/**
 * IDE-HOV-012: on save, only that file's annotation bucket is replaced -- extract the saved text
 * (the caller supplies document.getText(), zero file reads) and merge in memory into a new view;
 * other file buckets are untouched and not re-read. Deleted return annotations stop being
 * findable once the bucket is swapped. A cold cache (no full index yet) is a no-op: the next
 * query builds in full from disk truth, never a fake partial index; while the first scan is in
 * flight (2026-10-28 review remediation) the save is recorded as a pending replay event and the
 * bucket is swapped before publishing, so stale reads from the scan period do not swallow the
 * new annotation.
 */
export function applySavedFileAnnotations(
  workspaceRoot: string | null,
  filePath: string,
  source: string
): void {
  if (!workspaceRoot) { return; }
  // IDE-REV-006: any in-flight rebuild (TTL-expired rebuild / first scan) records the save event
  // -- when only the published bucket is modified, the rebuild's stale scan-period read would
  // overwrite this save at publish; once recorded it replays before publish and the new value is not lost
  annotationBuilds.get(workspaceRoot)?.pendingFileEvents.push({ kind: 'save', filePath, source });
  const cached = returnAnnotationCaches.get(workspaceRoot);
  if (!cached) { return; }
  cached.fileBuckets.set(filePath, extractFileReturnAnnotations(source));
  cached.index = mergeAnnotationBuckets(cached.fileBuckets);
}

/**
 * IDE-HOV-014: on file delete, remove that file's annotation bucket -- after dropping the bucket
 * a purely in-memory re-merge makes that source's annotations unfindable, while other files'
 * sources for a same-named method still backstop in the original order. Cold caches and
 * unregistered paths are no-ops: the next query builds in full from disk truth, never a fake
 * partial index; while the first scan is in flight (2026-10-28 review remediation) the delete is
 * recorded as a pending replay event and the bucket is dropped before publishing, so a deleted
 * file's annotations do not linger.
 */
export function removeSavedFileAnnotations(
  workspaceRoot: string | null,
  filePath: string
): void {
  if (!workspaceRoot) { return; }
  // IDE-REV-007: any in-flight rebuild records the delete event -- when only the published bucket
  // is dropped, the rebuild's stale scan-period read would revive the deleted source at publish;
  // once recorded the bucket drop replays before publish and the source does not linger
  annotationBuilds.get(workspaceRoot)?.pendingFileEvents.push({ kind: 'delete', filePath });
  const cached = returnAnnotationCaches.get(workspaceRoot);
  if (!cached) { return; }
  if (!cached.fileBuckets.delete(filePath)) { return; }
  cached.index = mergeAnnotationBuckets(cached.fileBuckets);
}

/**
 * IDE-HOV-015: on file rename, migrate the annotation source -- the old-key bucket is re-keyed
 * in place (insertion order preserved; the first-seen-wins semantics are not reshuffled by the
 * rename), content carried over with nothing lost and no duplicate left behind. Cold caches and
 * unregistered paths are no-ops: the next query builds in full from disk truth; while the first
 * scan is in flight (2026-10-28 review remediation) the rename is recorded as a pending replay
 * event, keys are migrated on the scan-collected buckets at publish, and import bindings hit
 * via the new module.
 */
export function renameSavedFileAnnotations(
  workspaceRoot: string | null,
  oldFilePath: string,
  newFilePath: string
): void {
  if (!workspaceRoot) { return; }
  // IDE-REV-008: any in-flight rebuild records the rename event -- when only the published bucket
  // is migrated, the rebuild's stale scan-period read would bring the old key back at publish;
  // the key migration replays before publish, so the old module stops hitting and the new module is queryable
  annotationBuilds.get(workspaceRoot)?.pendingFileEvents.push({ kind: 'rename', oldFilePath, newFilePath });
  const cached = returnAnnotationCaches.get(workspaceRoot);
  if (!cached) { return; }
  if (!cached.fileBuckets.has(oldFilePath)) { return; }
  const renamed = new Map<string, PythonReturnAnnotationIndex>();
  for (const [key, bucket] of cached.fileBuckets) {
    renamed.set(key === oldFilePath ? newFilePath : key, bucket);
  }
  cached.fileBuckets = renamed;
  cached.index = mergeAnnotationBuckets(renamed);
}

const returnAnnotationCaches = new Map<string, ReturnAnnotationCacheEntry>();
type AnnotationCancellation = { readonly isCancellationRequested: boolean };
/** File events arriving while the first scan is in flight (2026-10-28 review remediation): replayed
 * before publishing, so stale content read during the scan period no longer swallows the saves/
 * deletes/renames that happened inside the window. */
type PendingFileEvent =
  | { kind: 'save'; filePath: string; source: string }
  | { kind: 'delete'; filePath: string }
  | { kind: 'rename'; oldFilePath: string; newFilePath: string };
interface AnnotationBuild {
  waiters: Set<{ token?: AnnotationCancellation }>;
  promise: Promise<PythonReturnAnnotationIndex>;
  pendingFileEvents: PendingFileEvent[];
  /** Shared cancellation token (the cancellation-attribution face of the IDE-REV-029 gauge): cancelled only when every waiter has cancelled */
  sharedToken: AnnotationCancellation;
}
const annotationBuilds = new Map<string, AnnotationBuild>();

/** Leftover-task gauge (P0-4b review reopened 2026-10-28): the number of document annotation
 * updates debounced and in flight on the edit path -- a read-only face for on-site acceptance to
 * observe that no un-leaked residue remains after cancellation/storms.
 * IDE-REV-028 (2026-10-30): the pending count covers both the pending (debounce-queued) and
 * inflight (async extraction executing) faces -- while an extraction is gated it still reports
 * as in flight, no longer only looking at the debounce queue. */
export function getPendingDocumentUpdateCount(): number {
  return pendingDocumentUpdates.size + inflightDocumentUpdates.size;
}

/** The number of document annotation updates currently executing (inflight) (IDE-REV-028): counted
 * per file -- the files whose async extraction is genuinely running, observable separately from the
 * debounce queue face. */
export function getInflightDocumentUpdateCount(): number {
  return inflightDocumentUpdates.size;
}

/**
 * In-flight volume of shared annotation index builds (IDE-REV-029, originally IDE-MET-008): both
 * cold builds and TTL-expired rebuilds go through shared builds (annotationBuilds) -- running =
 * the number of shared builds executing (counted per workspace); waiting = the number of requests
 * hitching a ride on those shared builds (the waiting face); cancelled = the number of shared
 * builds whose every waiter has cancelled and which are winding down (cancellation attribution:
 * a shared build only honours the whole-set cancellation; a single request cancelling does not
 * kill the build). Returns to zero after publish (cache accounting) or cancellation wind-down.
 * Metered separately from REV-028's per-file document updates (request-exclusive tasks); the
 * books are never mixed.
 */
export interface AnnotationBuildWorkload {
  running: number;
  waiting: number;
  cancelled: number;
}
export function getAnnotationBuildWorkload(): AnnotationBuildWorkload {
  let waiting = 0;
  let cancelled = 0;
  for (const build of annotationBuilds.values()) {
    waiting += build.waiters.size;
    if (build.sharedToken.isCancellationRequested) {
      cancelled += 1;
    }
  }
  return { running: annotationBuilds.size, waiting, cancelled };
}

/** IDE-REV-031: the annotation index cache capacity face -- one entry per workspace root, rebuilt
 * on TTL expiry; no entry cap (entry count is bounded by the number of workspace roots) and no
 * byte-usage number available, the convention is stated honestly rather than inventing a byte estimate. */
export function getReturnAnnotationCacheGauge(): { entries: number; ttlMs: number } {
  return { entries: returnAnnotationCaches.size, ttlMs: INDEX_TTL_MS };
}

/** For tests: clear all workspace caches (takes effect immediately after swapping a temp root / editing files) */
export function resetPythonReturnAnnotationCache(): void {
  returnAnnotationCaches.clear();
  annotationBuilds.clear();
  documentAnnotationBuckets.clear();
  for (const pending of pendingDocumentUpdates.values()) {
    clearTimeout(pending.timer);
  }
  pendingDocumentUpdates.clear();
  inflightDocumentUpdates.clear();
  documentBucketGenerations.clear();
}

/**
 * IDE-HOV-011 the current file's annotation bucket updated by document version: unsaved
 * return-annotation changes of an open document take effect per version immediately (the same
 * file wins over the disk index; "def present but annotation missing" shadows the stale
 * same-named disk annotation, no borrowing the old value). The bucket is driven only by the
 * document version: re-extract only when the version advances; an older/same version must not
 * overwrite a newer one; closing the document drops the bucket and returns to the disk
 * convention (unsaved modifications vanish with the close).
 */
export interface DocumentAnnotationBucket {
  version: number;
  annotations: PythonReturnAnnotationIndex;
  /** Method names whose def exists but has no return annotation: shadow the stale same-named annotations in the disk index */
  unannotatedNames: Set<string>;
}

const documentAnnotationBuckets = new Map<string, Map<string, DocumentAnnotationBucket>>();

export interface DocumentAnnotationContext {
  /** Document identity (URI string): hover/save/close events share the same key */
  fileKey: string;
  /** Document version: re-extract only on increase; an older version must not overwrite a newer one */
  version: number;
  /** Lazily fetch the document's full text: called once, only when the version advanced and re-extraction is needed */
  source: () => string;
}

/** Update the file's bucket by document version; the same version is idempotent, an older version never overwrites a newer one. */
export function updateDocumentReturnAnnotations(
  workspaceRoot: string | null,
  context: DocumentAnnotationContext
): void {
  if (!workspaceRoot) { return; }
  let rootBuckets = documentAnnotationBuckets.get(workspaceRoot);
  if (!rootBuckets) {
    rootBuckets = new Map();
    documentAnnotationBuckets.set(workspaceRoot, rootBuckets);
  }
  const existing = rootBuckets.get(context.fileKey);
  if (existing && context.version <= existing.version) { return; }
  const annotations: PythonReturnAnnotationIndex = new Map();
  const unannotatedNames = new Set<string>();
  collectFileAnnotationFacts(context.source(), (name, annotation) => {
    if (annotation === null) { unannotatedNames.add(name); }
    else { annotations.set(name, annotation); }
  });
  rootBuckets.set(context.fileKey, { version: context.version, annotations, unannotatedNames });
}

/**
 * Drop the bucket when a document closes: unsaved modifications no longer shadow the disk
 * convention. 2026-10-28 review remediation: also cancel that file's in-flight/pending-flush
 * annotation updates (otherwise an async extraction landing after the close would revive the
 * dropped bucket).
 */
export function releaseDocumentReturnAnnotations(workspaceRoot: string | null, fileKey: string): void {
  if (!workspaceRoot) { return; }
  documentBucketGenerations.set(fileKey, (documentBucketGenerations.get(fileKey) ?? 0) + 1);
  const pending = pendingDocumentUpdates.get(fileKey);
  if (pending) {
    clearTimeout(pending.timer);
    pendingDocumentUpdates.delete(fileKey);
  }
  documentAnnotationBuckets.get(workspaceRoot)?.delete(fileKey);
}

// ====== 2026-10-28 review remediation (HOV-011): move edit-event annotation extraction off the synchronous path ======
// Each onDidChangeTextDocument event previously extracted the whole file synchronously (889KB
// ~= 120ms blocking the event loop). Now: per-file events merge to the latest version (an
// older-version event being superseded does not extract), a macrotask flush runs the cooperative
// async extraction (collectFileAnnotationFactsAsync, yielding via setImmediate on a character
// budget), and version/close races are contained by the version gate plus the document generation guard.
const pendingDocumentUpdates = new Map<string, {
  workspaceRoot: string;
  version: number;
  source: () => string;
  timer: NodeJS.Timeout;
}>();
const inflightDocumentUpdates = new Map<string, Promise<void>>();
const documentBucketGenerations = new Map<string, number>();

/** Edit face entry: queue (same file merges to the latest version), extract asynchronously after a macrotask, never blocking the edit's synchronous path */
export function queueDocumentReturnAnnotations(
  workspaceRoot: string | null,
  context: DocumentAnnotationContext
): void {
  if (!workspaceRoot) { return; }
  const key = context.fileKey;
  const pending = pendingDocumentUpdates.get(key);
  if (pending) {
    pending.version = context.version;
    pending.source = context.source;
    return; // a timer is already in flight: merge to the latest version, do not re-extract the older version
  }
  const entry = {
    workspaceRoot,
    version: context.version,
    source: context.source,
    timer: undefined as unknown as NodeJS.Timeout
  };
  entry.timer = setTimeout(() => {
    pendingDocumentUpdates.delete(key);
    scheduleInflight(entry.workspaceRoot, key, entry.version, entry.source);
  }, 0);
  pendingDocumentUpdates.set(key, entry);
}

/** Test face (IDE-REV-028): gate the async extraction into a deterministic in-flight window --
 * called once before each extraction starts, and extraction continues only when the returned
 * promise lets it. Always null in production (zero behavior change). */
let documentExtractionGateForTests: (() => Promise<void>) | null = null;
export function setDocumentExtractionGateForTests(gate: (() => Promise<void>) | null): void {
  documentExtractionGateForTests = gate;
}

function scheduleInflight(
  workspaceRoot: string,
  fileKey: string,
  version: number,
  source: () => string
): void {
  const extraction = (async (): Promise<void> => {
    if (documentExtractionGateForTests) {
      await documentExtractionGateForTests();
    }
    await updateDocumentReturnAnnotationsAsync(workspaceRoot, { fileKey, version, source });
  })().catch(() => {});
  inflightDocumentUpdates.set(fileKey, extraction);
  void extraction.finally(() => {
    // IDE-REV-028: an old task's finally must not delete the in-flight record of a newer task on
    // the same file -- overlapping versions of one file each own their record: delete only if the
    // record still belongs to this task; if a newer version has taken over, leave it to that one.
    if (inflightDocumentUpdates.get(fileKey) === extraction) {
      inflightDocumentUpdates.delete(fileKey);
    }
  });
}

/** Cooperative async extraction: yield the event loop on a character budget (large files no longer block the host in one go) */
export async function updateDocumentReturnAnnotationsAsync(
  workspaceRoot: string | null,
  context: DocumentAnnotationContext
): Promise<void> {
  if (!workspaceRoot) { return; }
  const generation = documentBucketGenerations.get(context.fileKey) ?? 0;
  const existing = documentAnnotationBuckets.get(workspaceRoot)?.get(context.fileKey);
  if (existing && context.version <= existing.version) { return; }
  const annotations: PythonReturnAnnotationIndex = new Map();
  const unannotatedNames = new Set<string>();
  await collectFileAnnotationFactsAsync(context.source(), (name, annotation) => {
    if (annotation === null) { unannotatedNames.add(name); }
    else { annotations.set(name, annotation); }
  });
  if ((documentBucketGenerations.get(context.fileKey) ?? 0) !== generation) {
    return; // the document was closed during extraction: the dropped bucket is not revived
  }
  let rootBuckets = documentAnnotationBuckets.get(workspaceRoot);
  if (!rootBuckets) {
    rootBuckets = new Map();
    documentAnnotationBuckets.set(workspaceRoot, rootBuckets);
  }
  const after = rootBuckets.get(context.fileKey);
  if (after && context.version <= after.version) { return; } // an updated version already landed meanwhile
  rootBuckets.set(context.fileKey, { version: context.version, annotations, unannotatedNames });
}

/** Test face: flush all pending updates and wait for the async extractions to finish (the synchronous assertion convention) */
export async function flushPendingDocumentReturnAnnotationsForTests(): Promise<void> {
  for (const [key, entry] of [...pendingDocumentUpdates.entries()]) {
    pendingDocumentUpdates.delete(key);
    clearTimeout(entry.timer);
    scheduleInflight(entry.workspaceRoot, key, entry.version, entry.source);
  }
  await Promise.all([...inflightDocumentUpdates.values()]);
}

/** Test face: read the document annotation bucket directly (after the batch D cascade deletion,
 * queries no longer read buckets; the publishing machinery is still driven by extension.ts
 * document events, and machinery assertions go through this accessor). */
export function getDocumentReturnAnnotationBucketForTests(
  workspaceRoot: string,
  fileKey: string
): DocumentAnnotationBucket | undefined {
  return documentAnnotationBuckets.get(workspaceRoot)?.get(fileKey);
}

async function getReturnAnnotationIndex(workspaceRoot: string, token?: AnnotationCancellation): Promise<PythonReturnAnnotationIndex> {
  const now = Date.now();
  const cached = returnAnnotationCaches.get(workspaceRoot);
  if (cached && now - cached.builtAtMs < INDEX_TTL_MS) {
    return cached.index;
  }
  let build = annotationBuilds.get(workspaceRoot);
  if (!build) {
    const waiters = new Set<{ token?: AnnotationCancellation }>();
    const sharedToken = { get isCancellationRequested() {
      return waiters.size === 0 || [...waiters].every(waiter => waiter.token?.isCancellationRequested === true);
    } };
    const entry: AnnotationBuild = {
      waiters,
      promise: Promise.resolve().then(() => buildReturnAnnotationIndexForRoot(workspaceRoot, sharedToken, entry)),
      pendingFileEvents: [],
      sharedToken
    };
    annotationBuilds.set(workspaceRoot, entry);
    build = entry;
  }
  const waiter = { token };
  build.waiters.add(waiter);
  try {
    return await build.promise;
  } finally {
    build.waiters.delete(waiter);
    if (annotationBuilds.get(workspaceRoot) === build) annotationBuilds.delete(workspaceRoot);
  }
}

async function buildReturnAnnotationIndexForRoot(workspaceRoot: string, token: AnnotationCancellation, build: AnnotationBuild): Promise<PythonReturnAnnotationIndex> {
  const files = await collectProjectPythonFilesAsync(workspaceRoot, 20000, token);
  if (token.isCancellationRequested) return new Map();
  const sources = new Array<string>(files.length).fill('');
  let nextFile = 0;
  const readWorker = async (): Promise<void> => {
    while (!token.isCancellationRequested && nextFile < files.length) {
      const i = nextFile++;
      try {
        // Shared source-text cache accounting entry (2026-11-24 cache consolidation batch): the
        // inference corpus and the definition/reference chains share the cached source text
        sources[i] = await readFileUtf8Recorded(files[i]);
      } catch {
        // A single unreadable file does not affect the other files.
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(ANNOTATION_READ_CONCURRENCY, files.length) }, readWorker));
  if (token.isCancellationRequested) return new Map();
  let fileBuckets = new Map<string, PythonReturnAnnotationIndex>();
  for (let i = 0; i < files.length; i += 1) {
    if (token.isCancellationRequested) return new Map();
    fileBuckets.set(files[i], await extractFileReturnAnnotationsAsync(sources[i]));
  }
  // 2026-10-28 review remediation: file events inside the first-scan in-flight window replay in
  // arrival order before publishing (save swaps bucket / delete drops bucket / rename migrates
  // key), so stale reads from the scan period do not swallow the new state from inside the window.
  for (const event of build.pendingFileEvents) {
    if (event.kind === 'save') {
      fileBuckets.set(event.filePath, extractFileReturnAnnotations(event.source));
    } else if (event.kind === 'delete') {
      fileBuckets.delete(event.filePath);
    } else if (fileBuckets.has(event.oldFilePath)) {
      const renamed = new Map<string, PythonReturnAnnotationIndex>();
      for (const [key, bucket] of fileBuckets) {
        renamed.set(key === event.oldFilePath ? event.newFilePath : key, bucket);
      }
      fileBuckets = renamed;
    }
  }
  const index = mergeAnnotationBuckets(fileBuckets);
  if (annotationBuilds.get(workspaceRoot) === build) {
    returnAnnotationCaches.set(workspaceRoot, { builtAtMs: Date.now(), index, fileBuckets });
  }
  return index;
}

/** Inference result: the annotation string plus the source method name (hover marks it "inferred from get_data()'s return annotation") */
export interface LocalVariableReturnType {
  target: string;
  annotation: string;
  methodName: string;
}

/** IDE-HOV-017: file-level explicit import bindings -- `from X import n [as a]` binds the name
 * n/a to module X; `import X [as Y]` binds the receiver Y/X to module X (for `X.fn()` use).
 * Wildcard `import *` is not an explicit binding and does not participate; a relative import's
 * leading dots are approximated by suffix matching. */
/** The binding of `from mod import original as local`: the imported original symbol name is kept
 * (symbol=original); module bucket lookups use symbol, not the bound name local (R2-F17). */
interface FromImportBinding {
  module: string;
  symbol: string;
}
export interface FileImportBindings {
  names: Map<string, FromImportBinding>;
  receivers: Map<string, string>;
}

const FROM_IMPORT_PATTERN = /^\s*from\s+([.\w]+)\s+import\s+([^#]*?)(?:#.*)?$/;
/** `import X` / `import pkg.good as g`: the module may be dotted (2026-10-28 review remediation;
 * a submodule alias is also a legitimate binding, and missing it would fall back to a global
 * same-named method and yield a wrong annotation). */
const BARE_IMPORT_PATTERN =
  /^\s*import\s+([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)(?:\s+as\s+([A-Za-z_]\w*))?\s*(?:#.*)?$/;
const IMPORT_ALIAS_PATTERN = /^([A-Za-z_]\w*)(?:\s+as\s+([A-Za-z_]\w*))?$/;

/** Exported for the Rust<->TS parity tests (single source for the binding face) */
export function extractFileImports(lines: readonly string[]): FileImportBindings {
  const names = new Map<string, FromImportBinding>();
  const receivers = new Map<string, string>();
  for (const raw of lines) {
    const line = raw ?? '';
    const from = FROM_IMPORT_PATTERN.exec(line);
    if (from) {
      const module = from[1].replace(/^[.]+/, '').replace(/\./g, '/');
      if (!module || from[2].includes('*')) { continue; }
      for (const part of from[2].split(',')) {
        const alias = IMPORT_ALIAS_PATTERN.exec(part.trim());
        if (alias) { names.set(alias[2] ?? alias[1], { module, symbol: alias[1] }); }
      }
      continue;
    }
    const bare = BARE_IMPORT_PATTERN.exec(line);
    if (bare) {
      // The Python bound name = the alias if present, otherwise the first segment; an alias binds
      // to the full submodule path (pkg.good -> pkg/good), while no alias keeps the single-segment
      // `import pkg` semantics.
      const dotted = bare[1];
      const firstSegment = dotted.split('.')[0];
      const boundName = bare[2] ?? firstSegment;
      const module = bare[2] !== undefined ? dotted.replace(/\./g, '/') : firstSegment;
      receivers.set(boundName, module);
    }
  }
  return { names, receivers };
}

/** Module -> the uniquely matching file bucket; not found or multiple same-named modules both give null (undeterminable -> unknown). */
function locateModuleBucket(
  fileBuckets: Map<string, PythonReturnAnnotationIndex>,
  module: string
): PythonReturnAnnotationIndex | null {
  const suffix = `${module}.py`;
  let found: PythonReturnAnnotationIndex | null = null;
  for (const [filePath, bucket] of fileBuckets) {
    const normalized = filePath.replace(/\\/g, '/');
    if (normalized !== suffix && !normalized.endsWith(`/${suffix}`)) { continue; }
    if (found) { return null; }
    found = bucket;
  }
  return found;
}

/**
 * IDE-HOV-016: search upward from the hover line for an assignment, valid only before leaving
 * the scope -- on the way up, once a `def`/`class` header at indent i is crossed, assignments
 * above it with indent >= i+1 belong to another scope (sibling methods / the nested function)
 * and are no longer borrowed; module-level (indent 0) assignments are unrestricted (Python
 * global-read semantics).
 * IDE-AUD-042: respect the last variable write -- searching upward from the hover line, only
 * the most recent assignment to word counts (no longer lending an earlier call answer to an
 * overwritten variable; the R2-F16 counterexample `x=original(); x=0` previously still inferred
 * EXPECTED). Call-shape filtering is not part of this scan (belongs to matchingAssignments);
 * the precheck uses the existence convention (belongs to hasLocalReturnCandidate).
 */
/**
 * The nearest same-named write point of the hovered word (masked text). null = no same-named
 * write point within scope.
 * KBUG-GATE-03: the scope/mask/nearest-write scan is the single implementation shared by the TS
 * chain (matchingAssignments) and the hover precheck (hasLocalReturnCandidate) -- the two sides
 * never drift apart.
 */
function nearestSameNameWrite(lines: readonly string[], hoverLine: number, word: string): { text: string } | null {
  if (!word) {
    return null;
  }
  // KR-AUD-64: mask first -- mask the whole text once (pythonLexicalMask tracks triple-quote
  // state across lines, keeping rows and columns), so `name = call`-shaped lines inside a
  // triple-quoted string body are no longer taken as real assignment candidates.
  // The single-line maskCodeLine only handles quotes on the same line; a cross-line triple-quoted
  // body must be masked as whole text.
  const maskedLines = maskPythonNonCode(lines.join('\n')).split('\n');
  let scopeIndentLimit = Number.POSITIVE_INFINITY;
  for (let line = Math.min(hoverLine, maskedLines.length - 1); line >= 0; line -= 1) {
    const text = maskedLines[line] ?? '';
    const indent = text.length - text.trimStart().length;
    if (indent < scopeIndentLimit) {
      const write = ASSIGNMENT_PATTERN.exec(text);
      if (write && write[2] === word) {
        return { text };
      }
    }
    const scopeHeader = /^\s*(?:async\s+def|def|class)\s/.exec(text);
    if (scopeHeader) {
      scopeIndentLimit = Math.min(scopeIndentLimit, indent + 1);
    }
  }
  return null;
}

/** The hovered word's latest write candidate (call shape). TS chain candidate face: the nearest
 * write point is returned as the sole candidate only when it is a single-level/attribute call,
 * otherwise (constant/alias/unknown expression/local shadowing) an empty list -- IDE-AUD-042
 * never lends an earlier call answer to an overwritten variable; the decidability-of-shape
 * ruling belongs to the Rust face, and this function no longer acts as the hover precheck gate
 * (KBUG-GATE). */
export function matchingAssignments(lines: readonly string[], hoverLine: number, word: string): LocalAssignmentCall[] {
  const write = nearestSameNameWrite(lines, hoverLine, word);
  if (!write) {
    return [];
  }
  const assignment = parseLocalAssignmentCall(write.text);
  return assignment ? [assignment] : [];
}

/**
 * KBUG-GATE-02/03: the hover precheck (existence convention, shape-agnostic) -- a same-named
 * write point within scope lets the Rust localReturnType leg through; decidability and answer
 * honesty are ruled by the Rust engine (shapes like alias chains/chained calls are no longer
 * blocked by the TS-side "single-level call" regex clone gate -- before the fix
 * `x = alias`/`x = build().load()` was swallowed at the production entry and Rust never received
 * the query).
 * Only provably resultless cases are excluded: string/comment pseudo-assignments (masking,
 * KR-AUD-64), empty word / line out of bounds, no same-named write point within scope --
 * pseudo-assignments and illegal queries fast-path with zero RPC; the Rust RHS shape decision is
 * not duplicated in TS (GATE-03); a constant/literal write point is let through and Rust
 * honestly answers null.
 */
export function hasLocalReturnCandidate(lines: readonly string[], hoverLine: number, word: string): boolean {
  return nearestSameNameWrite(lines, hoverLine, word) !== null;
}

function resolveFromAnnotationIndex(candidates: readonly LocalAssignmentCall[], word: string, index: PythonReturnAnnotationIndex): LocalVariableReturnType | null {
  for (const assignment of candidates) {
    const annotation = index.get(assignment.methodName);
    if (annotation && annotation !== 'Any') return { target: word, annotation, methodName: assignment.methodName };
  }
  return null;
}

/** Interactive queries only read the published snapshot; cold queries and expired snapshots
 * trigger a background rebuild. Document buckets (IDE-HOV-011) come before the disk index: the
 * hovered document's own bucket has top priority, other open documents' buckets come next, and
 * names shadowed by "annotation deleted" no longer borrow stale disk values. */
export function resolveLocalVariableReturnTypeFromSnapshot(
  lines: readonly string[],
  hoverLine: number,
  word: string,
  workspaceRoot: string | null,
  documentContext?: DocumentAnnotationContext
): LocalVariableReturnType | null {
  // IDE-RST-009: query-segment duration (python-annotation-query) -- the annotation path of an
  // ordinary variable hover is counted in full (including the no-candidate early exit); the real
  // query convention takes no bypass
  const queryStartedAt = performance.now();
  try {
    return resolveLocalVariableReturnTypeFromSnapshotImpl(lines, hoverLine, word, workspaceRoot, documentContext);
  } finally {
    recordLanguageServiceOperation('python-annotation-query', performance.now() - queryStartedAt, {
      fileKind: 'python'
    });
  }
}

function resolveLocalVariableReturnTypeFromSnapshotImpl(
  lines: readonly string[],
  hoverLine: number,
  word: string,
  workspaceRoot: string | null,
  // Batch D: the query consumer face (document bucket cascade) is deleted; the parameter is kept
  // (the hover wiring and existing caller signatures unchanged) but no longer participates in
  // resolution -- bucket publishing is driven by extension.ts document events
  _documentContext?: DocumentAnnotationContext
): LocalVariableReturnType | null {
  if (!workspaceRoot || !word || /^[A-Z_][A-Z0-9_]*$/.test(word)) return null;
  const candidates = matchingAssignments(lines, hoverLine, word);
  if (candidates.length === 0) return null;
  // Precision main lane, batch D: the cascade backstop (hovered document bucket -> other open
  // document buckets -> the disk index's global method-name guessing with cross-class
  // misbinding) is deleted as a whole chain -- receiver unknowable -> null (honest, nothing
  // displayed); the same-file inferable subset is caught by the Rust localReturnType face (the
  // Rust-first leg in hover.ts), and this chain keeps only the IDE-HOV-017 import binding path
  // (receiver already correct). The query path no longer feeds document buckets (bucket
  // publishing moved to extension.ts document events; the query consumer face was deleted along
  // with the cascade).
  const cached = returnAnnotationCaches.get(workspaceRoot);
  // 2026-10-28 review remediation: the TTL expiry check must come before the hit -- an expired
  // index no longer answers stale disk annotations (the check originally sat after the cascade
  // hit returned, letting an expired stale value hit without end).
  const diskIndexFresh = cached !== undefined && Date.now() - cached.builtAtMs < INDEX_TTL_MS;
  // IDE-HOV-017: candidates with an explicit import binding resolve only into the corresponding
  // module's file bucket; a bound module without the annotation, a missing module file, or
  // multiple same-named modules (undeterminable) never fall back to the global index.
  const bindings = extractFileImports(lines);
  for (const assignment of candidates) {
    const fromBinding = bindings.names.get(assignment.methodName);
    const receiverModule = assignment.receiver
      ? bindings.receivers.get(assignment.receiver)
      : undefined;
    if (fromBinding !== undefined || receiverModule !== undefined) {
      const module = receiverModule ?? fromBinding!.module;
      // The receiver shape (X.fn()) looks the bucket up by the method name fn; the from-import
      // shape looks it up by the imported original symbol name (symbol), not the bound name
      // (R2-F17: the alias `as local` drops the original).
      const symbol = receiverModule !== undefined ? assignment.methodName : fromBinding!.symbol;
      const bucket = diskIndexFresh ? locateModuleBucket(cached!.fileBuckets, module) : null;
      const annotation = bucket?.get(symbol);
      if (annotation && annotation !== 'Any') {
        annotationSourceLog('info', () =>
          `hover-resolve word=${word} method=${symbol} source=disk-snapshot(import) module=${module}`
        );
        return { target: word, annotation, methodName: assignment.methodName };
      }
      continue;
    }
    // Unbound candidates: receiver unknowable -> no guessing (an honest miss; never borrows any same-named annotation)
  }
  if (!cached || Date.now() - cached.builtAtMs >= INDEX_TTL_MS) {
    // IDE-REV-037: an expired/cold-disk miss is spelled out in the log -- no answering with stale
    // values; a controlled rebuild queues asynchronously and hits resume once the new snapshot publishes.
    annotationSourceLog('info', () =>
      `hover-miss word=${word} disk-index=${cached ? 'expired' : 'cold'} rebuild=queued`
    );
    void getReturnAnnotationIndex(workspaceRoot).catch(() => {});
  }
  return null;
}

/**
 * hover evaluation: when the cursor rests on `word`, search [0, hoverLine] for a
 * `word = <single-level call>` assignment, **taking the last parsable one upward from the hover
 * line** (for repeated same-named assignments, the last parsable value); the rhs's called method
 * name resolves only if the project python index has a return annotation for it, otherwise null
 * (nothing displayed).
 */
export function resolveLocalVariableReturnType(
  lines: readonly string[],
  hoverLine: number,
  word: string,
  workspaceRoot: string | null,
  token?: { readonly isCancellationRequested: boolean }
): Promise<LocalVariableReturnType | null> | null {
  if (!workspaceRoot || !word || /^[A-Z_][A-Z0-9_]*$/.test(word)) {
    return null;
  }
  const candidates = matchingAssignments(lines, hoverLine, word);
  if (candidates.length === 0) return null;
  return getReturnAnnotationIndex(workspaceRoot, token).then(index => {
    if (token?.isCancellationRequested) return null;
    return resolveFromAnnotationIndex(candidates, word, index);
  });
}
