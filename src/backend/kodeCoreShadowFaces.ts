import type { KodeCoreGate } from './kodeCoreGate';

// kode2 Phase2 first slice: dual-track shadow cross-check wiring for the
// definition + diagnostics faces (book section 17 PH7-02 /
// docs/kode2/phase2-slice-a.md). Responsibility boundary:
//   1. Hold the KodeCoreGate reference (injected during setupKodeCoreGate
//      wiring; default null = every entry is a zero-overhead pass-through,
//      the same shape as the PR-012 default-ts zero visible change);
//   2. Adapt the TS faces (vscode.Location / vscode.Diagnostic[]) into LSP
//      faces with the same shape as the kode-server response, and run a
//      shadow cross-check through gate.compare() -- always return / never
//      affect the TS result; Rust results only go to the diff log (the iron
//      rule against switching the live stream holds, same as PR-012);
//   3. Inside a shadow session, mirror the open/change of corpus documents
//      (.def + types/entities/alias.xml) to Rust, and retract the mirror on
//      close (the corpus sync leg; failures are silent and the verdict
//      policy belongs to compare's own failure classification).
// All structural adaptation goes through shape types and does not import
// vscode (unit tests use a same-shaped fake-vscode).

let shadowGate: KodeCoreGate | null = null;

/** Wiring-layer injection (passing null tears it down; called when the extension is deactivated) */
export function setKodeCoreShadowGate(gate: KodeCoreGate | null): void {
  if (shadowGate !== gate) {
    // Replacing the gate (wiring / restart / swapping the test stub) means a new transport instance: reset the circuit so the new gate gets a clean window.
    resetInteractiveCircuit(Date.now());
  }
  shadowGate = gate;
}

/** Read the current gate for tests/diagnostics (does not spawn a process) */
export function getKodeCoreShadowGate(): KodeCoreGate | null {
  return shadowGate;
}

// ---- Shape types (structural subsets of vscode.Location / vscode.Diagnostic) ------------

interface PositionLike {
  line: number;
  character: number;
}

interface RangeLike {
  start: PositionLike;
  end: PositionLike;
}

interface LocationLike {
  uri: { fsPath: string };
  range: RangeLike;
}

interface DiagnosticLike {
  range: RangeLike;
  /** vscode.DiagnosticSeverity:Error=0/Warning=1/Information=2/Hint=3 */
  severity: number;
  message: string;
}

interface DocumentLike {
  uri: { fsPath: string };
  languageId: string;
  version: number;
  getText(): string;
}

// ---- LSP faces (same shape as the kode-server response; cross-check faces in phase2-slice-a.md) --------

export interface LspLocationFace {
  uri: string;
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
}

export interface LspDiagnosticReportFace {
  kind: 'full';
  items: { range: RangeLike; severity: number; message: string }[];
}

/** LSP position face (same shape as kode-server LspPosition; line 0-based, column in UTF-16 code units) */
export interface LspPositionFace {
  line: number;
  character: number;
}

/** LSP range face (same shape as kode-server LspRange) */
export interface LspRangeFace {
  start: LspPositionFace;
  end: LspPositionFace;
}

/**
 * Document symbol face (same shape as kode-server
 * document_symbols::DocumentSymbolFace). kind is the symbol-kind string
 * face (same shape as the TS vscode.SymbolKind enum names; the numeric
 * protocol mapping is a provider projection detail).
 */
export interface LspDocumentSymbolFace {
  name: string;
  detail: string;
  kind: 'Struct' | 'Class' | 'Field' | 'Method';
  range: LspRangeFace;
  selectionRange: LspRangeFace;
  children: LspDocumentSymbolFace[];
}

/** kode-server textDocument/completion response face (to_lsp_items projection) */
export interface LspCompletionReportFace {
  isIncomplete: boolean;
  items: {
    label: string;
    /** LSP CompletionItemKind numeric value (method=2/type/entity/alias=7/property=10) */
    kind: number;
    detail?: string;
    /** RUST-135: entry order lock (response order = declaration order/chain order, zero-padded sequence) */
    sortText?: string;
    /** RUST-135: typed filter face (= label) */
    filterText?: string;
    /** RUST-135: snippet insert text (py method/function face `name($0)`) */
    insertText?: string;
    /** RUST-135: insert format (2 = snippet) */
    insertTextFormat?: number;
    /** RUST-135: completionItem/resolve round-trip payload (source face discriminator) */
    data?: Record<string, unknown>;
  }[];
}

/** completionItem/resolve response face: documentation face (markdown) plus an optional detail update */
export interface LspCompletionResolveFace {
  documentation?: { kind: string; value: string };
  detail?: string;
}

/**
 * resolve lazy detail-completion rust service (RUST-135): under the serve
 * track, request kode-server completionItem/resolve (params = the
 * {label,detail,data} subset of the completion output entry). Rust
 * recomputes and returns the documentation face; an undecidable payload / a
 * missing corpus / any failure returns null -- the caller keeps the entry's
 * existing face (an empty document is not installed). Zero mirroring
 * (resolve has no document context; the corpus already entered through the
 * mirror leg at completion time).
 */
export async function serveCompletionResolveFromRust(
  item: { label: string; detail?: string; data?: Record<string, unknown> }
): Promise<LspCompletionResolveFace | null> {
  const gate = shadowGate;
  if (!gate || !gate.serveFromRust() || !item.data) {
    return null;
  }
  const result = await awaitWithInteractiveBudget(
    async opts =>
      gate.serveInRust<unknown>('completionItem/resolve', item, null, opts),
    INTERACTIVE_SERVE_BUDGET_MS
  );
  if (!result || typeof result !== 'object') {
    return null;
  }
  const face = result as { documentation?: { kind?: unknown; value?: unknown } };
  if (
    face.documentation &&
    typeof face.documentation === 'object' &&
    typeof face.documentation.value === 'string'
  ) {
    return face as LspCompletionResolveFace;
  }
  return null;
}

/** vscode.Location (single/array) -> LSP Location face; null / a miss -> null */
export function locationToLspFace(location: unknown): LspLocationFace | null {
  const first = Array.isArray(location) ? location[0] : location;
  if (!first || typeof first !== 'object') {
    return null;
  }
  const candidate = first as Partial<LocationLike>;
  if (!candidate.uri || typeof candidate.uri.fsPath !== 'string' || !candidate.range) {
    return null;
  }
  const { start, end } = candidate.range;
  if (
    typeof start?.line !== 'number' ||
    typeof start?.character !== 'number' ||
    typeof end?.line !== 'number' ||
    typeof end?.character !== 'number'
  ) {
    return null;
  }
  return {
    uri: candidate.uri.fsPath,
    range: {
      start: { line: start.line, character: start.character },
      end: { line: end.line, character: end.character },
    },
  };
}

/** vscode.DiagnosticSeverity -> LSP severity (+1; Error 0->1 ...) */
const toLspSeverity = (severity: number): number => {
  if (typeof severity !== 'number' || severity < 0 || severity > 3) {
    return 1;
  }
  return severity + 1;
};

/** vscode.Diagnostic[] -> LSP pull report face (same shape as kode-server {kind, items}) */
export function diagnosticsToLspFace(diagnostics: readonly DiagnosticLike[]): LspDiagnosticReportFace {
  return {
    kind: 'full',
    items: (diagnostics ?? []).map(diagnostic => ({
      range: diagnostic.range,
      severity: toLspSeverity(diagnostic.severity),
      message: diagnostic.message
    }))
  };
}

// ---- Entries (called by the provider/validate faces; zero overhead when not shadowing or unwired) ----------

/**
 * End-to-end budget for the interactive serving faces (KBUG-TIME-02): the
 * total elapsed time for the four corpus faces (definition/completion/
 * hover/diagnostic), from dispatch (including the mirror's client.start/
 * queuing/response) to fallback. Background command faces do not go through
 * this budget. The transport-layer hard timeout (+2000ms) is explicitly
 * counted outside the budget as a cleanup window, and pending items/timers
 * are reclaimed as usual (KBUG-TIME-05).
 */
export const INTERACTIVE_SERVE_BUDGET_MS = 2000;

/** Cancellation probe period (ms) */
const CANCEL_POLL_MS = 50;

/**
 * Interactive wait shell: budget timer + cancellation probe; whichever
 * arrives first abandons the Rust wait (returns null, and the caller takes
 * the TS fallback). The losing promise gets a catch that swallows late
 * settlements -- no unhandled rejection is produced, and a late response
 * cannot change an already-decided result (KBUG-TIME-03/04). work receives
 * a timeoutMs equal to the budget; the transport layer concurrently sends
 * $/cancelRequest + hard-timeout cleanup.
 */
/**
 * Rust interactive-leg circuit breaker (user report 2026-11-23, "def hover
 * always 2s loading"): when kode-server will not come up (missing binary /
 * architecture mismatch / handshake stuck), rustPromise stays pending and
 * every request burns the full budget before falling back to TS -- showing
 * up as a fixed 2s loading on each hover that never self-heals. Circuit rules:
 * a transport-level hard failure (spawn failure / process exit / handshake
 * timeout) trips immediately; accumulating INTERACTIVE_TRIP_THRESHOLD budget
 * timeouts in a row (with no success at all) also trips it. The trip only
 * affects the current extension host session; a new restart window
 * (restartGeneration change) resets it automatically.
 */
const INTERACTIVE_TRIP_THRESHOLD = 3;

let interactiveCircuitOpen = false;
let interactiveTimeoutStreak = 0;
let interactiveCircuitGeneration = -1;

/** Circuit state query (used by tests and the status-bar diagnostics face). */
export function interactiveCircuitState(): {
  open: boolean;
  timeoutStreak: number;
} {
  return { open: interactiveCircuitOpen, timeoutStreak: interactiveTimeoutStreak };
}

/** Restart window / explicit reset (called in sync by the gate when restartGeneration changes). */
export function resetInteractiveCircuit(generation: number): void {
  if (interactiveCircuitGeneration !== generation) {
    interactiveCircuitGeneration = generation;
    interactiveCircuitOpen = false;
    interactiveTimeoutStreak = 0;
  }
}

/**
 * P1-4: a user-initiated Core restart = an unconditional reset window. The
 * automatic restart path relies on a "generation change" to trigger
 * resetInteractiveCircuit, but if the new process fails to start after a
 * manual restart, the handshake reconciliation (syncRestartGeneration) never
 * runs and the generation never changes -> the circuit never resets. The
 * manual reset skips the generation comparison and directly zeroes the circuit
 * and the timeout streak.
 */
export function resetInteractiveCircuitForManualRestart(): void {
  interactiveCircuitOpen = false;
  interactiveTimeoutStreak = 0;
}

/**
 * P1-4: Rust serve-track startup failure (spawn / handshake rejection) is
 * recorded faithfully into the circuit. Previously serveInRust converted a
 * startup exception into a normal fallback, and this face counted that
 * attempt as a success under the budget wrapper -- repeated startup failures
 * never tripped the circuit and the interactive leg wasted the full budget on
 * every request.
 */
export function noteInteractiveStartupFailure(): void {
  recordInteractiveFailure('hard');
}

function recordInteractiveFailure(kind: 'hard' | 'timeout'): void {
  if (kind === 'hard') {
    // A transport-level hard failure trips the circuit this very time: spawn errors / process exit do not improve with retries.
    interactiveCircuitOpen = true;
  } else {
    interactiveTimeoutStreak += 1;
    if (interactiveTimeoutStreak >= INTERACTIVE_TRIP_THRESHOLD) {
      interactiveCircuitOpen = true;
    }
  }
}

function recordInteractiveSuccess(): void {
  interactiveTimeoutStreak = 0;
}

export async function awaitWithInteractiveBudget<T>(
  work: (opts: { timeoutMs: number }) => Promise<T>,
  budgetMs: number,
  isCancelled?: () => boolean
): Promise<T | null> {
  if (isCancelled?.()) {
    return null;
  }
  if (interactiveCircuitOpen) {
    // Circuit open: pass straight through null (the caller falls back to the TS chain) instead of wasting the budget again.
    return null;
  }
  let budgetTimer: NodeJS.Timeout | undefined;
  let pollTimer: NodeJS.Timeout | undefined;
  let settled = false;
  const rustPromise = work({ timeoutMs: budgetMs });
  rustPromise.then(
    () => {
      if (!settled) recordInteractiveSuccess();
    },
    err => {
      // A hard failure (spawn/transport/handshake) trips the circuit this very time; budget timeouts are counted in the budget branch.
      if (!settled) recordInteractiveFailure('hard');
      if (err instanceof Error) {
        err.message = `[kode-server interactive leg hard-failed, circuit opened] ${err.message}`;
      }
    }
  );
  const budget = new Promise<null>(resolve => {
    budgetTimer = setTimeout(() => {
      if (!settled) recordInteractiveFailure('timeout');
      resolve(null);
    }, budgetMs);
  });
  const cancelled = new Promise<null>(resolve => {
    pollTimer = setInterval(() => {
      if (isCancelled?.()) {
        resolve(null);
      }
    }, CANCEL_POLL_MS);
  });
  try {
    const winner = await Promise.race([rustPromise, budget, cancelled]);
    settled = true;
    return winner;
  } catch {
    settled = true;
    return null;
  } finally {
    clearTimeout(budgetTimer);
    clearInterval(pollTimer);
  }
}

const isDefDocument = (document: DocumentLike): boolean =>
  document.languageId === 'kbengine-def' ||
  document.uri.fsPath.toLowerCase().endsWith('.def');

/** Corpus XML suffixes (same policy as kode-server file_kind_of_uri; decides the Rust parse view) */
const CORPUS_XML_SUFFIXES = ['entities.xml', 'types.xml', 'alias.xml'];

/**
 * Corpus documents (.def + the three XML kinds): the Rust-side type
 * environment (custom types / registered entries) is only populated by these
 * documents' didOpen/didChange; missing any one of them produces the bogus
 * "registered yet reported unregistered" diagnostics.
 */
const isCorpusDocument = (document: DocumentLike): boolean =>
  isDefDocument(document) ||
  CORPUS_XML_SUFFIXES.some(suffix => document.uri.fsPath.endsWith(suffix));

/**
 * Completion-face Rust document gate (RUST-134): besides the corpus
 * documents, .py files are also completion candidates (the self. entity-member
 * face + the KBEngine./kbe. module-alias face are both taken over by the
 * Rust shared queries). Used only by the completion serve path; the other
 * faces such as definition/hover keep the isCorpusDocument policy (Python
 * hover/definition landing points are not in the Rust face).
 */
const isCompletionRustDocument = (document: DocumentLike): boolean =>
  isCorpusDocument(document) || document.uri.fsPath.toLowerCase().endsWith('.py');

/** Whether a ProviderResult is thenable (the mapping-manager method jump path that returns a Promise) */
function isThenable(value: unknown): value is PromiseLike<unknown> {
  return value !== null && typeof value === 'object' && typeof (value as { then?: unknown }).then === 'function';
}

/**
 * Settling a ProviderResult (E-3): a synchronous Location/Location[] is
 * returned as-is; the cross-check face is only produced once the thenable has
 * resolved (adapting it while unresolved would yield null and wrongly record
 * an async landing point as a disagreement). The rejection path returns
 * unsettled -- there is no TS ground truth to cross-check against, so no
 * cross-check is produced and no unhandled rejection is raised (the provider's
 * return semantics are passed through verbatim by the caller; this only reads,
 * it does not take over).
 */
export async function settleProviderResult(
  result: unknown
): Promise<{ settled: true; value: unknown } | { settled: false }> {
  if (!isThenable(result)) {
    return { settled: true, value: result };
  }
  try {
    return { settled: true, value: await result };
  } catch {
    return { settled: false };
  }
}

/**
 * Definition-face rust service (user order 2026-11-08, "switch directly to
 * rust"): under the serve track, first mirror the corpus document (the Rust
 * side needs a buffer for this file to be able to answer), then request
 * kode-server textDocument/definition. If Rust has a landing point, return the
 * LSP face (uri is the canonical path, same shape as shadow
 * locationToLspFace); with no landing point (unknown word / missing corpus
 * environment / Python or schema, which are not in this face = Rust is always
 * null) or on any failure, return null -- the caller falls back to TS. A
 * non-serve track or an unwired gate returns null at zero overhead. The Rust
 * landing point takes precedence over the TS one (switch-directly semantics).
 */
export async function serveDefinitionFromRust(
  document: DocumentLike,
  position: PositionLike
): Promise<LspLocationFace | null> {
  const gate = shadowGate;
  if (!gate || !gate.serveFromRust()) {
    return null;
  }
  // Rust face = corpus declaration landing points (definition.rs:113
  // file_kind_of_uri Other -> None); schema/python are not in this face, so it
  // passes straight through to TS with no request.
  if (!isCorpusDocument(document)) {
    return null;
  }
  const uri = document.uri.fsPath;
  const params = {
    textDocument: { uri },
    position: { line: position.line, character: position.character }
  };
  const result = await awaitWithInteractiveBudget(
    async opts => {
      await gate
        .mirrorDocument(uri, document.languageId, document.version, document.getText())
        .catch(() => undefined);
      return gate.serveInRust<unknown>('textDocument/definition', params, null, opts);
    },
    INTERACTIVE_SERVE_BUDGET_MS
  );
  if (!result || typeof result !== 'object') {
    return null;
  }
  const face = result as Partial<LspLocationFace>;
  if (typeof face.uri !== 'string' || !face.range) {
    return null;
  }
  return face as LspLocationFace;
}

/**
 * Completion-face rust service (user order 2026-11-08, "switch directly to
 * rust"): under the serve track, first mirror the document (the Rust side
 * needs a buffer for this file to be able to answer), then request
 * kode-server textDocument/completion. If Rust decides a context and the item
 * set is non-empty, return the item set; if the context is undecided
 * (interface section / property sub-tag / def top level / unowned py), on any
 * failure, or in the case of "empty item set + isIncomplete:false" (a missing
 * corpus and a genuine absence of candidates cannot be distinguished,
 * per the RUST-021 closure-face revision), return null -- the caller falls
 * back to TS. The Rust item set takes precedence over TS (switch-directly
 * semantics), but an empty set is not installed as an authoritative result.
 */
export async function serveCompletionFromRust(
  document: DocumentLike,
  position: PositionLike
): Promise<LspCompletionReportFace | null> {
  const gate = shadowGate;
  if (!gate || !gate.serveFromRust()) {
    return null;
  }
  // Rust face = corpus documents + py (the completion-dedicated gate: RUST-134
  // self./module-alias face; other documents pass straight through to TS with
  // no request).
  if (!isCompletionRustDocument(document)) {
    return null;
  }
  const uri = document.uri.fsPath;
  const params = {
    textDocument: { uri },
    position: { line: position.line, character: position.character }
  };
  const result = await awaitWithInteractiveBudget(
    async opts => {
      await gate
        .mirrorDocument(uri, document.languageId, document.version, document.getText())
        .catch(() => undefined);
      return gate.serveInRust<unknown>('textDocument/completion', params, null, opts);
    },
    INTERACTIVE_SERVE_BUDGET_MS
  );
  if (!result || typeof result !== 'object') {
    return null;
  }
  const face = result as Partial<LspCompletionReportFace>;
  if (typeof face.isIncomplete !== 'boolean' || !Array.isArray(face.items)) {
    return null;
  }
  // An empty item set is not authoritative (RUST-021 closure-face revision):
  // a missing corpus also produces "context decided + zero items", which is
  // indistinguishable from "genuinely no candidates" -- an empty set inside a
  // non-empty response shell always falls back to TS, so "corpus missing" is
  // not installed as "no candidates".
  if (face.items.length === 0 && face.isIncomplete === false) {
    return null;
  }
  return face as LspCompletionReportFace;
}

/**
 * Hover-face rust service (user order 2026-11-08, "switch directly to rust"):
 * under the serve track, first mirror the corpus document (unsaved revisions
 * use the editor content as authoritative), then request kode-server
 * textDocument/hover. A Rust hit returns markdown text; a miss (unknown word /
 * document not in the corpus face = Python/schema, always null) or any
 * failure returns null -- the caller takes its existing TS chain. A non-serve
 * track or an unwired gate is zero overhead. Rust content takes precedence
 * over TS (switch-directly semantics).
 */
export async function serveHoverFromRust(
  document: DocumentLike,
  position: PositionLike
): Promise<string | null> {
  const gate = shadowGate;
  if (!gate || !gate.serveFromRust()) {
    return null;
  }
  // Rust face = corpus documents (def + the three XML kinds); non-corpus
  // documents pass straight through to TS with no request.
  if (!isCorpusDocument(document)) {
    return null;
  }
  const uri = document.uri.fsPath;
  const params = {
    textDocument: { uri },
    position: { line: position.line, character: position.character }
  };
  const result = await awaitWithInteractiveBudget(
    async opts => {
      await gate
        .mirrorDocument(uri, document.languageId, document.version, document.getText())
        .catch(() => undefined);
      return gate.serveInRust<unknown>('textDocument/hover', params, null, opts);
    },
    INTERACTIVE_SERVE_BUDGET_MS
  );
  if (!result || typeof result !== 'object') {
    return null;
  }
  const contents = (result as { contents?: { value?: unknown } }).contents;
  if (!contents || typeof contents.value !== 'string') {
    return null;
  }
  return contents.value;
}

/**
 * Diagnostics-face rust service (user order 2026-11-08, "switch directly to
 * rust"; the last slice for the diagnostics face): under the serve track,
 * first mirror the .def document (unsaved revisions use the editor content as
 * authoritative), then request kode-server textDocument/diagnostic (the LSP
 * pull full face {kind:'full',items}). The Rust face only covers the
 * validateDocument subset reproducible from the corpus (the three scalar codes
 * + structural duplicate/missing field; the missingPythonFile on-disk probe
 * branch is not in the face); the entities/types/alias dedicated diagnostics
 * are also not in this slice -- non-.def passes straight through to null and
 * the TS-produced face is retained. A malformed response invalidates the whole
 * face (any item missing a range/severity/message) and returns null, with no
 * partial adoption -- the caller keeps its TS set. A non-serve track or an
 * unwired gate is zero overhead.
 */
export async function serveDiagnosticsFromRust(
  document: DocumentLike
): Promise<LspDiagnosticReportFace | null> {
  const gate = shadowGate;
  if (!gate || !gate.serveFromRust()) {
    return null;
  }
  if (!isDefDocument(document)) {
    return null;
  }
  const uri = document.uri.fsPath;
  const result = await awaitWithInteractiveBudget(
    async opts => {
      await gate
        .mirrorDocument(uri, document.languageId, document.version, document.getText())
        .catch(() => undefined);
      return gate.serveInRust<unknown>('textDocument/diagnostic', { textDocument: { uri } }, null, opts);
    },
    INTERACTIVE_SERVE_BUDGET_MS
  );
  if (!result || typeof result !== 'object') {
    return null;
  }
  const face = result as Partial<LspDiagnosticReportFace>;
  if (face.kind !== 'full' || !Array.isArray(face.items)) {
    return null;
  }
  for (const item of face.items) {
    if (
      !item ||
      typeof item.message !== 'string' ||
      typeof item.severity !== 'number' ||
      !item.range ||
      typeof item.range.start?.line !== 'number' ||
      typeof item.range.start?.character !== 'number' ||
      typeof item.range.end?.line !== 'number' ||
      typeof item.range.end?.character !== 'number'
    ) {
      return null;
    }
  }
  return face as LspDiagnosticReportFace;
}

const isLspPositionFace = (value: unknown): value is LspPositionFace => {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const face = value as Record<string, unknown>;
  return typeof face.line === 'number' && typeof face.character === 'number';
};

const isLspRangeFace = (value: unknown): value is LspRangeFace =>
  !!value &&
  typeof value === 'object' &&
  isLspPositionFace((value as Record<string, unknown>).start) &&
  isLspPositionFace((value as Record<string, unknown>).end);

/** Recursively validate the symbol face: any malformed level -> the whole face is invalidated (no partial adoption) */
const isLspDocumentSymbolFace = (value: unknown): value is LspDocumentSymbolFace => {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const face = value as Record<string, unknown>;
  if (typeof face.name !== 'string' || typeof face.detail !== 'string') {
    return false;
  }
  if (
    face.kind !== 'Struct' &&
    face.kind !== 'Class' &&
    face.kind !== 'Field' &&
    face.kind !== 'Method'
  ) {
    return false;
  }
  if (!isLspRangeFace(face.range) || !isLspRangeFace(face.selectionRange)) {
    return false;
  }
  return Array.isArray(face.children) && face.children.every(isLspDocumentSymbolFace);
};

/**
 * Document symbol face rust service (RUST-139 batch 3 wiring; user order
 * 2026-11-08, "switch directly to rust"): under the serve track, first mirror
 * the .def document (unsaved revisions use the editor content as authoritative),
 * then request kode-server textDocument/documentSymbol. The Rust section
 * symbol face = container symbols + direct member symbols for the
 * Properties/three method sections (core document_symbols.rs, point-for-point
 * isomorphic with the TS IDE-NAV-005); no parse root / document not open / any
 * failure / malformed response -> null, and the caller takes its existing TS
 * implementation (no partial adoption).
 * Honest boundary: the Rust face does not include the process-section
 * breadcrumb synthetic root (jumping to a cross-file counterparty is a TS
 * projection-layer job); the provider side keeps the breadcrumb assembly.
 */
export async function serveDocumentSymbolsFromRust(
  document: DocumentLike,
  isCancelled?: () => boolean
): Promise<LspDocumentSymbolFace[] | null> {
  const gate = shadowGate;
  if (!gate || !gate.serveFromRust() || !isDefDocument(document)) {
    return null;
  }
  const uri = document.uri.fsPath;
  const result = await awaitWithInteractiveBudget(
    async opts => {
      await gate
        .mirrorDocument(uri, document.languageId, document.version, document.getText())
        .catch(() => undefined);
      return gate.serveInRust<unknown>(
        'textDocument/documentSymbol',
        { textDocument: { uri } },
        null,
        opts
      );
    },
    INTERACTIVE_SERVE_BUDGET_MS,
    isCancelled
  );
  if (!Array.isArray(result) || !result.every(isLspDocumentSymbolFace)) {
    return null;
  }
  return result;
}

const isLspLocationFace = (value: unknown): value is LspLocationFace => {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const face = value as Record<string, unknown>;
  return typeof face.uri === 'string' && isLspRangeFace(face.range);
};

/**
 * Three-valued references-face rust service response (RUST-138 batch 4
 * switching to the semantics-filtered face): the failure face and the Rust
 * authoritative empty set must be kept apart, otherwise "authoritative empty"
 * would be mistaken for "unavailable" and TS would be called back on to supply
 * same-name syntax sites.
 * unavailable = non-serve track / non-corpus document / budget timeout /
 *   cancellation / request failure / malformed response -> the caller takes
 *   its existing TS implementation (availability first);
 * locations   = Rust authoritative hit (Rust has mirrored the corpus and
 *   produced reference sites; an empty set is a legal response);
 * none        = Rust authoritative null (symbol unresolvable / all sites
 *   semantics-filtered) -> honestly empty, and **no longer** falls back to TS
 *   to supply same-name syntax sites (user ruling 2026-11-21: Shadow/Dangling
 *   do not fall back to TS).
 */
export type ReferencesServeFace =
  | { kind: 'unavailable' }
  | { kind: 'locations'; locations: LspLocationFace[] }
  | { kind: 'none' };

/** Failure-fallback sentinel for serveInRust: distinguishes it from a Rust authoritative null (iron rule: a failure must not be misapplied). */
const REFERENCES_SERVE_FAILED = {};

/** Internal three states of the serve shell: { raw } = Rust answered (value may be null), { failed } = the request did not get an answer */
type ReferencesServed = { state: 'raw'; value: unknown } | { state: 'failed' };

/**
 * References-face rust service (RUST-138 batch 3 wiring, batch 4 switching to
 * the semantics-filtered face): under the serve track, first mirror the corpus
 * document, then request kode-server textDocument/references. Rust face =
 * corpus-face references: def documents yield declaration sites for the three
 * target kinds (self-defined types / entity Parent / interface names, placed
 * first when includeDeclaration holds) + corpus-wide semantic reference
 * sites; a types.xml document yields corpus-wide reference sites for that type
 * name (no declaration sites). The site face goes through
 * semantic_reference_locations: same-name-but-different-declaration across
 * roots (Shadow) and sites whose domain cannot be resolved (Dangling) are not
 * listed. Python documents (property self access / call-site face belong to
 * the entityMapping runtime), entities/alias, unknown symbols -> the semantic
 * face returns null honestly (kind=none); any failure / timeout /
 * cancellation / malformed response (any item missing a uri/range) ->
 * unavailable, and the caller takes its existing TS implementation (no
 * partial adoption). A non-serve track or an unwired gate is zero overhead.
 */
export async function serveReferencesFromRust(
  document: DocumentLike,
  position: PositionLike,
  includeDeclaration: boolean,
  isCancelled?: () => boolean
): Promise<ReferencesServeFace> {
  const gate = shadowGate;
  if (!gate || !gate.serveFromRust() || !isCorpusDocument(document)) {
    return { kind: 'unavailable' };
  }
  const uri = document.uri.fsPath;
  const params = {
    textDocument: { uri },
    position: { line: position.line, character: position.character },
    context: { includeDeclaration }
  };
  const result = await awaitWithInteractiveBudget<ReferencesServed>(
    async opts => {
      await gate
        .mirrorDocument(uri, document.languageId, document.version, document.getText())
        .catch(() => undefined);
      const value = await gate.serveInRust<unknown>(
        'textDocument/references',
        params,
        REFERENCES_SERVE_FAILED,
        opts
      );
      return value === REFERENCES_SERVE_FAILED
        ? { state: 'failed' as const }
        : { state: 'raw' as const, value };
    },
    INTERACTIVE_SERVE_BUDGET_MS,
    isCancelled
  );
  // A null from the budget shell = timeout / cancellation / throw -> the failure face, falling back to TS (availability first, without misapplying the served result).
  if (result === null || result.state === 'failed') {
    return { kind: 'unavailable' };
  }
  if (result.value === null) {
    return { kind: 'none' };
  }
  if (!Array.isArray(result.value) || !result.value.every(isLspLocationFace)) {
    return { kind: 'unavailable' };
  }
  return { kind: 'locations', locations: result.value };
}

export interface LspPrepareRenameFace {
  range: LspRangeFace;
  placeholder: string;
}

export interface DefRenameConflictFace {
  surface: string;
  name: string;
  line: number;
  filePath: string | null;
}

export interface DefRenameFileEditsFace {
  filePath: string;
  edits: LspRangeFace[];
}

export interface DefRenameEditsFace {
  conflict: DefRenameConflictFace | null;
  closureConflict: DefRenameConflictFace | null;
  fileEdits: DefRenameFileEditsFace[];
}

const isLspPrepareRenameFace = (value: unknown): value is LspPrepareRenameFace => {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const face = value as Record<string, unknown>;
  return isLspRangeFace(face.range) && typeof face.placeholder === 'string';
};

const isDefRenameConflictFace = (value: unknown): value is DefRenameConflictFace => {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const face = value as Record<string, unknown>;
  return (
    typeof face.surface === 'string' &&
    typeof face.name === 'string' &&
    typeof face.line === 'number' &&
    (face.filePath === null || typeof face.filePath === 'string')
  );
};

const isDefRenameEditsFace = (value: unknown): value is DefRenameEditsFace => {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const face = value as Record<string, unknown>;
  if (
    !(face.conflict === null || isDefRenameConflictFace(face.conflict)) ||
    !(face.closureConflict === null || isDefRenameConflictFace(face.closureConflict)) ||
    !Array.isArray(face.fileEdits)
  ) {
    return false;
  }
  return face.fileEdits.every(entry => {
    if (!entry || typeof entry !== 'object') {
      return false;
    }
    const fileEdits = entry as Record<string, unknown>;
    return (
      typeof fileEdits.filePath === 'string' &&
      Array.isArray(fileEdits.edits) &&
      fileEdits.edits.every(isLspRangeFace)
    );
  });
};

/**
 * prepareRename face rust service (RUST-141 batch 2 wiring): under the serve
 * track, first mirror the .def document, then request kode-server
 * textDocument/prepareRename. Rust face = candidate range + placeholder name
 * for a cursor on a def property/method name (core
 * resolve_rename_symbol_at_offset, isomorphic with the TS defRenamer).
 * Non-.def / document not open / cursor not on a renamable symbol (null) /
 * any failure / malformed response -> null, and the caller takes its existing
 * TS implementation (no partial adoption). A non-serve track or an unwired gate
 * is zero overhead.
 */
export async function servePrepareRenameFromRust(
  document: DocumentLike,
  position: PositionLike,
  isCancelled?: () => boolean
): Promise<LspPrepareRenameFace | null> {
  const gate = shadowGate;
  if (!gate || !gate.serveFromRust() || !isDefDocument(document)) {
    return null;
  }
  const uri = document.uri.fsPath;
  const params = {
    textDocument: { uri },
    position: { line: position.line, character: position.character }
  };
  const result = await awaitWithInteractiveBudget(
    async opts => {
      await gate
        .mirrorDocument(uri, document.languageId, document.version, document.getText())
        .catch(() => undefined);
      return gate.serveInRust<unknown>('textDocument/prepareRename', params, null, opts);
    },
    INTERACTIVE_SERVE_BUDGET_MS,
    isCancelled
  );
  if (result === null) {
    return null;
  }
  if (!isLspPrepareRenameFace(result)) {
    return null;
  }
  return result;
}

/**
 * def rename-edit recomputation face rust service (RUST-141 batch 2 wiring):
 * under the serve track, first mirror the .def document, then request
 * kode-server textDocument/rename. Rust face = same-file conflict precheck
 * (NAV-008) + closure name-claim precheck (AUD-061) + all edits for the target
 * and descendant defs (AUD-046); conflict sites do not block the response --
 * the provider decides the error message (the message strings stay at the TS
 * l10n boundary). python self access / receiver call rewriting and the drift
 * guard belong to the TS entityMapping lane and are not in this face. A
 * malformed response (any key with the wrong shape) -> null, and the caller
 * takes its existing TS implementation (no partial adoption).
 */
export async function serveRenameFromRust(
  document: DocumentLike,
  position: PositionLike,
  newName: string,
  isCancelled?: () => boolean
): Promise<DefRenameEditsFace | null> {
  const gate = shadowGate;
  if (!gate || !gate.serveFromRust() || !isDefDocument(document)) {
    return null;
  }
  const uri = document.uri.fsPath;
  const params = {
    textDocument: { uri },
    position: { line: position.line, character: position.character },
    newName
  };
  const result = await awaitWithInteractiveBudget(
    async opts => {
      await gate
        .mirrorDocument(uri, document.languageId, document.version, document.getText())
        .catch(() => undefined);
      return gate.serveInRust<unknown>('textDocument/rename', params, null, opts);
    },
    INTERACTIVE_SERVE_BUDGET_MS,
    isCancelled
  );
  if (result === null || !isDefRenameEditsFace(result)) {
    return null;
  }
  return result;
}

/** Rust GateRange face (flat 0-based line/column, same shape as code_action_assembly::GateRange) */
export interface CodeActionGateRangeFace {
  startLine: number;
  startChar: number;
  endLine: number;
  endChar: number;
}

/**
 * EditFace tri-state (RUST-143 batch 3): replaceRange = a point replacement;
 * insertLine = inserting a line into a class body/statement (the leading /
 * trailing newline in text is baked in on the Rust side); replaceLines =
 * replacing a whole line range (the newlines are already baked into text).
 */
export type CodeActionEditFace =
  | { type: 'replaceRange'; file: string; range: CodeActionGateRangeFace; newText: string }
  | { type: 'insertLine'; file: string; line: number; text: string }
  | { type: 'replaceLines'; file: string; startLine: number; endLine: number; text: string };

/** ActionFace: the Rust assembly descriptor (vscode object construction and l10n title interpolation belong to the TS thin shell) */
export interface CodeActionFace {
  kind: string;
  title: string;
  edit: CodeActionEditFace;
  diagnosticStartLine: number;
  titleParams: string[];
}

/** Diagnostic input face (projected from vscode.Diagnostic on the TS side; related* lets the parity family locate things) */
export interface CodeActionDiagnosticParam {
  code: string;
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  relatedFile?: string | null;
  relatedMessage?: string | null;
}

const isCodeActionGateRangeFace = (value: unknown): value is CodeActionGateRangeFace => {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const range = value as Record<string, unknown>;
  return (
    typeof range.startLine === 'number' &&
    typeof range.startChar === 'number' &&
    typeof range.endLine === 'number' &&
    typeof range.endChar === 'number'
  );
};

const isCodeActionEditFace = (value: unknown): value is CodeActionEditFace => {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const edit = value as Record<string, unknown>;
  switch (edit.type) {
    case 'replaceRange':
      return (
        typeof edit.file === 'string' &&
        isCodeActionGateRangeFace(edit.range) &&
        typeof edit.newText === 'string'
      );
    case 'insertLine':
      return (
        typeof edit.file === 'string' &&
        typeof edit.line === 'number' &&
        typeof edit.text === 'string'
      );
    case 'replaceLines':
      return (
        typeof edit.file === 'string' &&
        typeof edit.startLine === 'number' &&
        typeof edit.endLine === 'number' &&
        typeof edit.text === 'string'
      );
    default:
      return false;
  }
};

const isCodeActionFace = (value: unknown): value is CodeActionFace => {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const face = value as Record<string, unknown>;
  return (
    typeof face.kind === 'string' &&
    typeof face.title === 'string' &&
    isCodeActionEditFace(face.edit) &&
    typeof face.diagnosticStartLine === 'number' &&
    Array.isArray(face.titleParams) &&
    face.titleParams.every(entry => typeof entry === 'string')
  );
};

/** The def families (typeReplacement/parityMethod) are only requested on .def documents; the py families the other way round */
const CODE_ACTION_DEF_FAMILIES = new Set(['typeReplacement', 'parityMethod']);
const CODE_ACTION_PY_FAMILIES = new Set(['receiverNone', 'fixedDict']);

/**
 * codeAction assembly face rust service (RUST-143 batch 3 wiring): under the
 * serve track, first mirror the document, then request kode-server
 * textDocument/codeAction per family. Rust face = the four families of
 * assembly decisions (fixing the argument type / creating the missing
 * definition / the receiver-none guard's double action / the wholesale FIXED_DICT
 * reassignment), producing an array of ActionFace descriptors. Honest
 * boundary: the registered near-spelling universe (getKnownTypeContext
 * assembly) and the parity target python snapshot (readSharedFileSnapshot,
 * preferring an open buffer) are passed in as arguments by the TS side;
 * vscode.CodeAction/WorkspaceEdit construction and l10n title interpolation
 * belong to the TS thin shell. Family x document-kind mismatch / document not
 * open / any failure / malformed response (any face missing a key) -> null,
 * and the caller takes its existing TS implementation (no partial adoption).
 * A non-serve track or an unwired gate is zero overhead.
 */
export async function serveCodeActionsFromRust(
  document: DocumentLike,
  input: {
    family: string;
    range: { start: PositionLike; end: PositionLike };
    diagnostics: readonly CodeActionDiagnosticParam[];
    registered: string[];
    snapshotText: string | null;
  },
  isCancelled?: () => boolean
): Promise<CodeActionFace[] | null> {
  const gate = shadowGate;
  if (!gate || !gate.serveFromRust()) {
    return null;
  }
  if (CODE_ACTION_DEF_FAMILIES.has(input.family)) {
    if (!isDefDocument(document)) {
      return null;
    }
  } else if (CODE_ACTION_PY_FAMILIES.has(input.family)) {
    if (!document.uri.fsPath.toLowerCase().endsWith('.py')) {
      return null;
    }
  } else {
    return null;
  }
  const uri = document.uri.fsPath;
  const params = {
    textDocument: { uri },
    range: {
      start: { line: input.range.start.line, character: input.range.start.character },
      end: { line: input.range.end.line, character: input.range.end.character }
    },
    family: input.family,
    registered: input.registered,
    snapshotText: input.snapshotText,
    diagnostics: input.diagnostics.map(diagnostic => ({
      code: diagnostic.code,
      range: {
        start: { line: diagnostic.range.start.line, character: diagnostic.range.start.character },
        end: { line: diagnostic.range.end.line, character: diagnostic.range.end.character }
      },
      relatedFile: diagnostic.relatedFile ?? null,
      relatedMessage: diagnostic.relatedMessage ?? null
    }))
  };
  const result = await awaitWithInteractiveBudget(
    async opts => {
      await gate
        .mirrorDocument(uri, document.languageId, document.version, document.getText())
        .catch(() => undefined);
      return gate.serveInRust<unknown>('textDocument/codeAction', params, null, opts);
    },
    INTERACTIVE_SERVE_BUDGET_MS,
    isCancelled
  );
  if (!Array.isArray(result) || !result.every(isCodeActionFace)) {
    return null;
  }
  return result;
}

/** Landing-point face of the selected declaration (same shape as signature_help::SignatureDefinition, line 1-based) */
export interface SignatureHelpDefinitionFace {
  file: string;
  line: number;
  section: string;
  exposed: boolean;
}

/** SignatureHelp face (RUST-140 batch 3): the four position-independent pieces; signature assembly is isomorphic with TS */
export interface SignatureHelpFace {
  label: string;
  parameters: string[];
  documentation: string;
  definition: SignatureHelpDefinitionFace;
}

/** Response double key: face + active-parameter highlight (the clamp arm for zero parameters is given by the Rust decision core) */
export interface SignatureHelpResultFace {
  signature: SignatureHelpFace;
  activeParameter: number;
}

const isSignatureHelpFace = (value: unknown): value is SignatureHelpFace => {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const face = value as Record<string, unknown>;
  const definition = face.definition as Record<string, unknown> | undefined;
  return (
    typeof face.label === 'string' &&
    Array.isArray(face.parameters) &&
    face.parameters.every(parameter => typeof parameter === 'string') &&
    typeof face.documentation === 'string' &&
    !!definition &&
    typeof definition === 'object' &&
    typeof definition.file === 'string' &&
    typeof definition.line === 'number' &&
    typeof definition.section === 'string' &&
    typeof definition.exposed === 'boolean'
  );
};

const isSignatureHelpResultFace = (value: unknown): value is SignatureHelpResultFace => {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const result = value as Record<string, unknown>;
  return (
    isSignatureHelpFace(result.signature) &&
    typeof result.activeParameter === 'number' &&
    Number.isInteger(result.activeParameter) &&
    result.activeParameter >= 0
  );
};

/**
 * SignatureHelp decision face rust service (RUST-140 batch 3 wiring): under
 * the serve track, first mirror the python document, then request kode-server
 * textDocument/signatureHelp. Rust face = call-site attribution
 * (python_call_at) + def declaration resolution (owner chain closure +
 * receiver-section hard gate) + signature assembly, returning the double key
 * {signature, activeParameter}; a null response = no signature at that
 * position. Honest boundary: vscode.SignatureInformation/MarkdownString
 * construction belongs to the TS thin shell; the entityMapping registry
 * runtime chain (resolveMethodDefinition) stays on the TS fallback lane.
 * Non-.py / non-serve track / cancellation / any failure / malformed response
 * -> null, and the caller takes its existing TS implementation (no partial
 * adoption). A non-serve track or an unwired gate is zero overhead.
 */
export async function serveSignatureHelpFromRust(
  document: DocumentLike,
  position: PositionLike,
  isCancelled?: () => boolean
): Promise<SignatureHelpResultFace | null> {
  const gate = shadowGate;
  if (!gate || !gate.serveFromRust() || !document.uri.fsPath.toLowerCase().endsWith('.py')) {
    return null;
  }
  const uri = document.uri.fsPath;
  const params = {
    textDocument: { uri },
    position: { line: position.line, character: position.character }
  };
  const result = await awaitWithInteractiveBudget(
    async opts => {
      await gate
        .mirrorDocument(uri, document.languageId, document.version, document.getText())
        .catch(() => undefined);
      return gate.serveInRust<unknown>('textDocument/signatureHelp', params, null, opts);
    },
    INTERACTIVE_SERVE_BUDGET_MS,
    isCancelled
  );
  if (result === null || !isSignatureHelpResultFace(result)) {
    return null;
  }
  return result;
}

/** Root-scoped def symbol hit face (same shape as workspace_symbols::WorkspaceSymbolHit, line 1-based) */
export interface WorkspaceSymbolHitFace {
  symbolName: string;
  /** "property" | "method" */
  kind: string;
  /** Present only for method (Rust Option<&str>); properties have no section */
  section: string | null;
  rootName: string;
  rootDefFile: string;
  defFile: string;
  line: number;
}

const isWorkspaceSymbolHitFace = (value: unknown): value is WorkspaceSymbolHitFace => {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const hit = value as Record<string, unknown>;
  return (
    typeof hit.symbolName === 'string' &&
    typeof hit.kind === 'string' &&
    (hit.kind === 'property' || hit.kind === 'method') &&
    (hit.section === null || typeof hit.section === 'string') &&
    typeof hit.rootName === 'string' &&
    typeof hit.rootDefFile === 'string' &&
    typeof hit.defFile === 'string' &&
    typeof hit.line === 'number' &&
    Number.isInteger(hit.line) &&
    hit.line >= 1
  );
};

/**
 * workspace/symbol lookup face rust service (RUST-139 batch 4 wiring): under
 * the serve track, request kode-server workspace/symbol. Rust face = the
 * corpus entity-kind def root set + the effective folding closure
 * (first-wins dedup) + the component-slot standalone face + case-insensitive /
 * trimmed prefix + the three-key sort rootName -> symbolName -> line;
 * returning {symbols:[hit faces]}. The corpus enters through didOpen; the
 * lookup face does not mirror documents (there is no document context).
 * Honest boundary: vscode.SymbolInformation/Location/Position construction
 * belongs to the TS thin shell; truncating the result set (the LSP limit)
 * belongs to the TS request side. A non-serve track / unwired gate /
 * cancellation / any failure / malformed response -> null, and the caller
 * takes its existing TS searchDefSymbolsByPrefix chain (no partial adoption);
 * an empty set {symbols:[]} is a legal response (resolvable but no hits) and
 * is returned as usual.
 */
export async function serveWorkspaceSymbolsFromRust(
  query: string,
  isCancelled?: () => boolean
): Promise<WorkspaceSymbolHitFace[] | null> {
  const gate = shadowGate;
  if (!gate || !gate.serveFromRust()) {
    return null;
  }
  const result = await awaitWithInteractiveBudget(
    opts => gate.serveInRust<unknown>('workspace/symbol', { query }, null, opts),
    INTERACTIVE_SERVE_BUDGET_MS,
    isCancelled
  );
  if (result === null || !result || typeof result !== 'object') {
    return null;
  }
  const symbols = (result as { symbols?: unknown }).symbols;
  if (!Array.isArray(symbols) || !symbols.every(isWorkspaceSymbolHitFace)) {
    return null;
  }
  return symbols;
}

/**
 * .def definition-jump shadow cross-check: after settling the ProviderResult
 * (which may be thenable), adapt it into the TS Location face and mirror it
 * to the gate. Fire-and-forget; it does not change the provider's return value
 * (iron rule: Rust results only go to the diff log).
 */
export function shadowCompareDefinition(
  document: DocumentLike,
  position: PositionLike,
  tsLocation: unknown
): void {
  const gate = shadowGate;
  if (!gate) {
    return;
  }
  const uri = document.uri.fsPath;
  const params = {
    textDocument: { uri },
    position: { line: position.line, character: position.character }
  };
  void settleProviderResult(tsLocation)
    .then(settled => {
      if (!settled.settled) {
        return undefined;
      }
      return gate.compare('textDocument/definition', params, locationToLspFace(settled.value), uri);
    })
    .catch(() => undefined);
}

/**
 * Corpus mirror leg (E-1): sync the open/change of .def/types.xml/entities.xml/
 * alias.xml to the Rust server. Driven by document snapshot updates (mirror on
 * open/change), and does not go through validateDocument -- so corpus syncing
 * is unaffected when diagnostics are switched off, and only then do
 * definition and registered-type diagnostics share the same input.
 * Best-effort: a non-shadow setup or a missing serverPath is zero overhead.
 */
export function shadowMirrorCorpusDocument(document: DocumentLike): void {
  const gate = shadowGate;
  if (!gate || !isCorpusDocument(document)) {
    return;
  }
  const uri = document.uri.fsPath;
  void gate
    .mirrorDocument(uri, document.languageId, document.version, document.getText())
    .catch(() => undefined);
}

/**
 * Document-close cleanup leg (E-4): symmetric with the mirror leg -- after a
 * document is closed or its unsaved revisions discarded, retract the Rust-side
 * overlay and version bookkeeping, so that repeated open/close cycles do not
 * accumulate already-closed documents. A non-shadow setup or an unwired gate is
 * zero overhead.
 */
export function shadowReleaseCorpusDocument(document: DocumentLike): void {
  const gate = shadowGate;
  if (!gate || !isCorpusDocument(document)) {
    return;
  }
  gate.closeMirroredDocument(document.uri.fsPath);
}

/**
 * .def diagnostics shadow cross-check: called after validateDocument has
 * computed the diagnostics. First mirror the document (the diagnostics-face
 * refresh leg, on the same ledger as shadowMirrorCorpusDocument; a re-entry of
 * the same version is not resent), then mirror the TS diagnostics face to
 * gate.compare('textDocument/diagnostic'). Fire-and-forget.
 */
export function shadowObserveDefDocument(
  document: DocumentLike,
  diagnostics: readonly DiagnosticLike[]
): void {
  const gate = shadowGate;
  if (!gate) {
    return;
  }
  if (!isDefDocument(document)) {
    return;
  }
  const uri = document.uri.fsPath;
  void gate
    .mirrorDocument(uri, document.languageId, document.version, document.getText())
    .catch(() => undefined);
  const params = { textDocument: { uri } };
  void gate
    .compare('textDocument/diagnostic', params, diagnosticsToLspFace(diagnostics), uri)
    .catch(() => undefined);
}
