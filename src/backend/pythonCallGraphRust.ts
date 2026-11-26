// C-20: wiring surface for the authoritative Rust implementation of the Python
// call graph / symbol table -- `$/kode/python/callgraph` and
// `$/kode/python/symbols`.
//
// Boundary (mirrors processTopologyRust / databaseSchemaRust's "input
// collection stays in TS, analysis belongs to Rust"): the file set's raw text
// (path + text) is passed straight over RPC; Rust parses the AST, extracts call
// edges / symbol tables / dataflow and returns them. When Rust is unavailable
// (no gate / serverPath not configured / call failure / shape mismatch) this
// returns null and the caller falls back to the self-built TS face (the C-19
// backstop) or to zero output (the panel stays silent). There is no TS mirror
// -- Rust is the single implementation.
//
// Line-number criterion: Rust's 0-based values are passed through as-is; the
// conversion to 1-based happens at the consumption point (C-19 entityMapping /
// the panel) and has nothing to do with this file.

import { getKodeCoreShadowGate } from './kodeCoreShadowFaces';

/** Input parameters for Rust's `$/kode/python/callgraph` (mirrors CallgraphParams) */
export interface PythonCallGraphRustParams {
  /** File set to analyze (path + raw text; may be empty) */
  files: Array<{ path: string; text: string }>;
  /** Raw text of `<root>/process_topology.xml` (optional; used for process role classification) */
  manifestXmlText?: string;
}

/** Call graph node (method / function / module pseudo-node) */
export interface PythonCallGraphNode {
  /** Method `Class.method` / function `<stem>::func` / module `<stem>` */
  id: string;
  /** "method" | "function" | "module" */
  kind: string;
  className?: string;
  name: string;
  filePath: string;
  /** 0-based */
  line: number;
  isAsync: boolean;
  params: string[];
}

/** A single call edge */
export interface PythonCallGraphEdge {
  callerId?: string;
  calleeId?: string;
  caller: string;
  callerClass?: string;
  /** 0-based */
  callerLine: number;
  callee: string;
  receiver?: string;
  /** EdgeKind literal (local/method/self-method/kbe-xxx/unknown) */
  kind: string;
  filePath: string;
}

/** In-procedure def-use chain (MVP) */
export interface PythonDefUseChain {
  var: string;
  defLine?: number;
  useLines: number[];
  isParam: boolean;
}

/** def-use result for a single method */
export interface PythonMethodDataflow {
  filePath: string;
  class?: string;
  method: string;
  chains: PythonDefUseChain[];
}

/** Rust output: the call graph + statistics */
export interface PythonCallGraphRustResult {
  nodes: PythonCallGraphNode[];
  edges: PythonCallGraphEdge[];
  /** Callee file path -> set of caller file paths */
  reverseIndex: Record<string, string[]>;
  dataflow: PythonMethodDataflow[];
  processRoles: string[];
  stats: {
    fileCount: number;
    nodeCount: number;
    edgeCount: number;
    dataflowCount: number;
    errorCount: number;
    byKind: Record<string, number>;
  };
  /** RUST-077-W: paging metadata (carried only by dimensions that were sliced; absent for small full results) */
  edgePage?: PythonCallGraphPageMeta;
  nodePage?: PythonCallGraphPageMeta;
  dataflowPage?: PythonCallGraphPageMeta;
  reversePage?: PythonCallGraphPageMeta;
}

/** RUST-077-W: metadata for one page (CORE-012; a missing nextOffset means the end) */
export interface PythonCallGraphPageMeta {
  offset: number;
  nextOffset?: number | null;
  oversizedAt?: number | null;
  cancelled?: boolean;
  bytesEstimate?: number;
  total?: number;
}

/**
 * RUST-077-W: cap on pagination continuation requests (defensive; the normal
 * page count = total / page size, far below this).
 */
const MAX_CALLGRAPH_PAGE_REQUESTS = 10_000;

/** Continuation state for one dimension: an open dimension carries a nextOffset cursor, a terminal dimension carries total (empty tail page). */
interface CallGraphDimState<T> {
  acc: T[];
  /** Cursor carried by the next request: open state = nextOffset; terminal = total. */
  cursor: number;
  done: boolean;
  /** Total entry count (the server's `*Page.total`; counted from absorbed entries when absent). */
  total: number;
}

function arrayDim<T>(): CallGraphDimState<T> {
  return { acc: [], cursor: 0, done: false, total: 0 };
}

function pageNext(meta: PythonCallGraphPageMeta | undefined): number | null {
  const raw = meta?.nextOffset;
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
}

/**
 * Step an array dimension. Open dimension: append the slice and advance the
 * cursor; no `*Page` metadata = a full dimension, absorbed in one segment and
 * terminal immediately. Terminal dimension: only an idempotence check (empty
 * tail page), never double-booked. Returning false = collaborative cancellation
 * of a half page / the cursor not advancing (stuck on an oversized entry) / a
 * terminal dimension revived by the server -- the outer layer gives up and
 * returns null (C-19 degrades to the TS backstop), never passing off a half
 * page as the full result.
 */
function stepArrayDim<T>(
  dim: CallGraphDimState<T>,
  pageValue: T[] | undefined,
  meta: PythonCallGraphPageMeta | undefined,
  sent: number
): boolean {
  if (dim.done) {
    if (meta && (meta.cancelled === true || pageNext(meta) !== null)) {
      return false;
    }
    return true;
  }
  if (!meta) {
    dim.acc.length = 0;
    if (pageValue) {
      dim.acc.push(...pageValue);
    }
    dim.total = dim.acc.length;
    dim.cursor = dim.total;
    dim.done = true;
    return true;
  }
  if (pageValue) {
    dim.acc.push(...pageValue);
  }
  if (meta.cancelled === true) {
    return false;
  }
  const next = pageNext(meta);
  if (next === null) {
    dim.total = typeof meta.total === 'number' ? meta.total : dim.acc.length;
    dim.cursor = dim.total;
    dim.done = true;
    return true;
  }
  if (next <= sent) {
    return false;
  }
  dim.total = typeof meta.total === 'number' ? meta.total : dim.acc.length;
  dim.cursor = next;
  return true;
}

/** Reverse-index dimension state (object dimension; entry = {callee: callers}, key order fixed by the server's BTreeMap). */
interface CallGraphReverseState {
  index: Record<string, string[]>;
  cursor: number;
  done: boolean;
  total: number;
}

/**
 * Step the reverse-index dimension: same semantics as stepArrayDim, with the
 * slice merged by key (caller de-duplication across pages).
 */
function stepReverseDim(
  dim: CallGraphReverseState,
  pageValue: Record<string, string[]>,
  meta: PythonCallGraphPageMeta | undefined,
  sent: number
): boolean {
  if (dim.done) {
    if (meta && (meta.cancelled === true || pageNext(meta) !== null)) {
      return false;
    }
    return true;
  }
  if (!meta) {
    dim.index = pageValue;
    dim.total = Object.keys(pageValue).length;
    dim.cursor = dim.total;
    dim.done = true;
    return true;
  }
  for (const [callee, callers] of Object.entries(pageValue)) {
    const seen = dim.index[callee];
    if (seen) {
      for (const caller of callers) {
        if (!seen.includes(caller)) {
          seen.push(caller);
        }
      }
    } else {
      dim.index[callee] = [...callers];
    }
  }
  if (meta.cancelled === true) {
    return false;
  }
  const next = pageNext(meta);
  if (next === null) {
    dim.total = typeof meta.total === 'number' ? meta.total : Object.keys(dim.index).length;
    dim.cursor = dim.total;
    dim.done = true;
    return true;
  }
  if (next <= sent) {
    return false;
  }
  dim.total = typeof meta.total === 'number' ? meta.total : Object.keys(dim.index).length;
  dim.cursor = next;
  return true;
}

/** A method's own call reference */
export interface PythonSymbolCall {
  methodName: string;
  line: number;
  character: number;
}

/** Class method symbol */
export interface PythonSymbolMethod {
  name: string;
  line: number;
  character: number;
  isAsync: boolean;
  decorators: string[];
  params: string[];
  endLine: number;
  calls: PythonSymbolCall[];
}

/** Class symbol */
export interface PythonSymbolClass {
  name: string;
  qualifiedName: string;
  bases: string[];
  startLine: number;
  endLine: number;
  decorators: string[];
  methods: PythonSymbolMethod[];
  attributes: Array<{ name: string; line: number; character: number }>;
}

/** Module-level function symbol */
export interface PythonSymbolFunction {
  name: string;
  line: number;
  character: number;
  isAsync: boolean;
  decorators: string[];
  params: string[];
  endLine: number;
}

/** Symbol table for a single file (an output element of Rust's `$/kode/python/symbols`) */
export interface PythonSymbolsFile {
  filePath: string;
  lineCount: number;
  classes: PythonSymbolClass[];
  functions: PythonSymbolFunction[];
  imports: Array<{
    binding: string;
    module: string;
    symbol?: string;
    line: number;
    isFrom: boolean;
  }>;
  errors: string[];
}

export type PythonSymbolsRustResult = PythonSymbolsFile[];

/**
 * Call graph (via Rust): file set -> nodes / edges / reverse index / dataflow;
 * returns null when Rust is unavailable / fails / the shape does not match
 * (the panel degrades: an unavailable badge, no thrown error).
 */
/**
 * KR-AUD-89: Rust's `file_stem` splits only on `/` (python_callgraph.rs:161) --
 * the Windows face's `uri.fsPath` is backslash-delimited, so paths are
 * normalized uniformly at the RPC boundary before sending; Rust's analyze()
 * has a debug_assert locking that contract down (upstream normalization, not
 * Rust-side tolerance).
 */
export function normalizeCallGraphPath(path: string): string {
  return path.replace(/\\/g, '/');
}

export async function buildPythonCallGraphInRust(
  params: PythonCallGraphRustParams
): Promise<PythonCallGraphRustResult | null> {
  const gate = getKodeCoreShadowGate();
  if (!gate) {
    return null;
  }
  const files = params.files.map(file => ({ ...file, path: normalizeCallGraphPath(file.path) }));
  const manifestXmlText = params.manifestXmlText ?? '';
  // RUST-077-W: four-dimension paging continuation. The server is stateless, so
  // every response is a paged view of the full analysis -- the first page
  // carries no cursor; continuation requests always carry all four cursors: an
  // open dimension carries `*Page.nextOffset`, a terminal dimension carries
  // total (an empty tail page keeps it terminal, so the server does not reopen
  // an already-collected dimension as a fresh page). Pure-function
  // determinism: the same inputs and cursors always yield the same page, and
  // continuations reassemble exactly the full result.
  // processRoles/stats correspond one-to-one with the inputs, so they are taken
  // verbatim from the first page. A cancelled half page / a cursor that does not
  // advance (stuck on an oversized entry) in any dimension / a terminal
  // dimension revived / the request-count cap exceeded -> null (C-19 degrades
  // to the TS backstop), never passing off a half page as the full result.
  const nodes = arrayDim<PythonCallGraphNode>();
  const edges = arrayDim<PythonCallGraphEdge>();
  const dataflow = arrayDim<PythonMethodDataflow>();
  const reverse: CallGraphReverseState = { index: {}, cursor: 0, done: false, total: 0 };
  let base: PythonCallGraphRustResult | null = null;
  for (let request = 0; request < MAX_CALLGRAPH_PAGE_REQUESTS; request++) {
    const cursors: Record<string, number> | undefined =
      request === 0
        ? undefined
        : {
            edgeOffset: edges.cursor,
            nodeOffset: nodes.cursor,
            dataflowOffset: dataflow.cursor,
            reverseOffset: reverse.cursor
          };
    const response = await gate.runInRust<PythonCallGraphRustResult>(
      '$/kode/python/callgraph',
      {
        files,
        manifestXmlText,
        ...cursors
      }
    );
    if (!response.ok) {
      return null;
    }
    if (!shapeCheckPythonCallGraphResult(response.result)) {
      return null;
    }
    const page = response.result;
    if (!base) {
      base = page;
    }
    const stepsOk = [
      stepArrayDim(edges, page.edges, page.edgePage, cursors?.edgeOffset ?? 0),
      stepArrayDim(nodes, page.nodes, page.nodePage, cursors?.nodeOffset ?? 0),
      stepArrayDim(dataflow, page.dataflow, page.dataflowPage, cursors?.dataflowOffset ?? 0),
      stepReverseDim(reverse, page.reverseIndex, page.reversePage, cursors?.reverseOffset ?? 0)
    ];
    if (stepsOk.some(step => !step)) {
      return null;
    }
    if (edges.done && nodes.done && dataflow.done && reverse.done) {
      return {
        nodes: nodes.acc,
        edges: edges.acc,
        reverseIndex: reverse.index,
        dataflow: dataflow.acc,
        processRoles: base.processRoles,
        stats: base.stats
      };
    }
  }
  return null;
}

/**
 * Budget for the symbol face (2026-11-24 field failure): the def first scan
 * goes through this face per entity, and passing no timeout earlier meant an
 * unbounded transport-layer wait -- with the server taking ~10s per request, 21
 * entities dragged out to 241s. A healthy server answers in the same millisecond
 * order of magnitude as the Interactive budget; a 2s cap plus a circuit breaker
 * on the command leg (the gate opens after three consecutive timeouts, and later
 * calls pass straight through, falling back to TS) compresses the worst-case
 * index-phase stall to ~6s instead of minutes.
 */
export const PYTHON_SYMBOLS_RUST_TIMEOUT_MS = 2000;

/**
 * Symbol table (via Rust): file set -> a per-file AST symbol table (including
 * each method's own calls); returns null when Rust is unavailable / fails /
 * the shape does not match (C-19 falls back to the self-built TS version).
 */
export async function buildPythonSymbolsInRust(
  files: Array<{ path: string; text: string }>
): Promise<PythonSymbolsRustResult | null> {
  const gate = getKodeCoreShadowGate();
  if (!gate) {
    return null;
  }
  const response = await gate.runInRust<PythonSymbolsRustResult>(
    '$/kode/python/symbols',
    { files },
    { timeoutMs: PYTHON_SYMBOLS_RUST_TIMEOUT_MS }
  );
  if (!response.ok) {
    return null;
  }
  if (!shapeCheckPythonSymbolsResult(response.result)) {
    return null;
  }
  return response.result;
}

function shapeCheckPythonCallGraphResult(value: unknown): value is PythonCallGraphRustResult {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const result = value as Record<string, unknown>;
  if (
    !Array.isArray(result.nodes) ||
    !Array.isArray(result.edges) ||
    typeof result.reverseIndex !== 'object' ||
    result.reverseIndex === null ||
    !Array.isArray(result.dataflow) ||
    !Array.isArray(result.processRoles) ||
    typeof result.stats !== 'object' ||
    result.stats === null
  ) {
    return false;
  }
  const nodesOk = result.nodes.every(node => {
    if (typeof node !== 'object' || node === null) {
      return false;
    }
    const item = node as Record<string, unknown>;
    return (
      typeof item.id === 'string' &&
      typeof item.kind === 'string' &&
      typeof item.name === 'string' &&
      typeof item.filePath === 'string' &&
      typeof item.line === 'number'
    );
  });
  const edgesOk = result.edges.every(edge => {
    if (typeof edge !== 'object' || edge === null) {
      return false;
    }
    const item = edge as Record<string, unknown>;
    return (
      typeof item.caller === 'string' &&
      typeof item.callerLine === 'number' &&
      typeof item.callee === 'string' &&
      typeof item.kind === 'string' &&
      typeof item.filePath === 'string'
    );
  });
  const stats = result.stats as Record<string, unknown>;
  const statsOk =
    typeof stats.fileCount === 'number' &&
    typeof stats.nodeCount === 'number' &&
    typeof stats.edgeCount === 'number' &&
    typeof stats.dataflowCount === 'number' &&
    typeof stats.errorCount === 'number' &&
    typeof stats.byKind === 'object' &&
    stats.byKind !== null;
  return nodesOk && edgesOk && statsOk;
}

function shapeCheckPythonSymbolsResult(value: unknown): value is PythonSymbolsRustResult {
  if (!Array.isArray(value)) {
    return false;
  }
  return value.every(file => {
    if (typeof file !== 'object' || file === null) {
      return false;
    }
    const item = file as Record<string, unknown>;
    return (
      typeof item.filePath === 'string' &&
      typeof item.lineCount === 'number' &&
      Array.isArray(item.classes) &&
      Array.isArray(item.functions) &&
      Array.isArray(item.imports) &&
      Array.isArray(item.errors)
    );
  });
}
