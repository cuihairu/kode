import { parsePythonFile, type ParsedPythonFile } from './pythonParser';

/**
 * LANG-NAR-1 semantic engine flow-sensitive narrowing (user order 2026-11-02):
 * flow-sensitive type inference for `self.<attr>` user-managed attributes (not
 * .def-declared, not a builtin receiver).
 *
 * Background: GEN-DEF-1a/1b already fixed .def-declared attributes' annotations
 * to non-Optional (FixedArray[T]/FixedDict/builtin direct mapping), but
 * attributes the user manages in __init__ (e.g. self.TalentTree first `= None`
 * then `= [...]`) are entirely invisible to the semantic engine — hover/inlay
 * all land on null (propertyCodeLens/typeInlayHints's
 * resolvePropertyDefinitionInfo only walks .def). This module fills the gap: for
 * self-managed attributes it does (a) type convergence (__init__ assignments ∪
 * class-level declarations), (b) flow-sensitive narrowing (after
 * `if self.X is None: self.X = expr` narrow to expr's type; inside an
 * `if self.X is not None:` block drop None; after an early exit
 * `if self.X is None: return` drop None). Pure function face (text + optional
 * callbacks), zero vscode dependencies, consumed by diagnostics/hover.
 *
 * Convergence contract: the baseline = the __init__ body's flow-scan end state
 * (a trailing assignment overrides; after `= None` overwritten by `= []` it
 * converges to list, so "no warning after __init__ initialization" holds) ∪
 * class-level declarations; without __init__ = the class-level declarations
 * (including `X = None` → None). The flow scan starts from the baseline inside
 * the querying method, advancing point by point through assignments/guards, and
 * returns the narrowed type at the query position.
 *
 * Honest boundaries: a type is represented as a set of atomic annotation strings
 * (e.g. 'None' / 'list' / 'list[int]' / 'TalentNode'); an expression whose type
 * cannot be inferred yields the empty set (never fabricating Any) — the empty
 * set is equivalent to "unknown, add no None" in narrowed unions, and the
 * diagnostic side uses the conservative gate of "report only with None
 * evidence", so no false positives.
 */

/**
 * KODE-PERF-001: a parse cache keyed by document version (bounded LRU).
 * Multiple flow queries of the same document version (key =
 * `${uri}|${version}`) — diagnostics/inlay sharing the same version — parse the
 * AST once; a version bump or a different document naturally changes the key,
 * and old keys are reclaimed by bounded eviction; a keyless call (pure
 * function/test) neither reads nor writes the cache, behaving byte-for-byte
 * like the existing pure function.
 */
const PARSE_CACHE_MAX_ENTRIES = 8;
const flowParseCache = new Map<string, ParsedPythonFile>();
let flowParseCountForTests = 0;

/** Clear the cache and zero the parse counter (test injection point; not used in production) */
export function resetSelfAttributeFlowParseCacheForTests(): void {
  flowParseCache.clear();
  flowParseCountForTests = 0;
}

/** Actual parse count (cache hits not counted; used by tests asserting "more access points do not re-parse") */
export function selfAttributeFlowParseCountForTests(): number {
  return flowParseCountForTests;
}

/** Get/build the parse result by version key; keyless = parse fresh each time (pure-function fallback) */
function parseWithVersionCache(
  lines: readonly string[],
  versionKey: string | undefined
): ParsedPythonFile {
  if (versionKey !== undefined) {
    const cached = flowParseCache.get(versionKey);
    if (cached) {
      // LRU touch: move to the tail (most recently used)
      flowParseCache.delete(versionKey);
      flowParseCache.set(versionKey, cached);
      return cached;
    }
  }
  flowParseCountForTests += 1;
  const parsed = parsePythonFile(lines.join('\n'), '<flow>');
  if (versionKey !== undefined) {
    flowParseCache.set(versionKey, parsed);
    if (flowParseCache.size > PARSE_CACHE_MAX_ENTRIES) {
      const oldest = flowParseCache.keys().next().value;
      if (oldest !== undefined) {
        flowParseCache.delete(oldest);
      }
    }
  }
  return parsed;
}

/** The flow-sensitive type facts of the self-managed attribute at the query position */
export interface SelfAttributeFlow {
  /** Deduplicated, sorted atomic type names (e.g. ['None','list']); empty = undeterminable */
  types: string[];
  /** The formatted annotation string ('list | None'/'None'/'list') or null (types empty) */
  annotation: string | null;
  /** The flow type contains None */
  hasNone: boolean;
  /** Narrowing took effect: the converged baseline contains None but the query-position flow type does not (a guard/assignment already dropped None) */
  narrowed: boolean;
}

/** Expression-type resolution callbacks (injected by the caller, e.g. pythonReturnTypeInference's index) */
export interface SelfAttributeFlowOptions {
  /** Function-call return annotation: `make_tree()` → 'list' etc.; not injected / unresolved → null */
  resolveCallAnnotation?: (callee: string) => string | null;
  /** Bare-name / attribute-final-segment annotation (non-call shape): `TalentNode` → 'TalentNode' etc. */
  resolveNameAnnotation?: (name: string) => string | null;
  /**
   * Subscript-read annotation: `self.cellData['spaceUType']` → 'str'.
   * target = the subscripted receiver's property name ('cellData'), key = the
   * string-literal key. User-reported 2026-11-23: in the base process, write
   * points like `self.spaceUType = self.cellData['spaceUType']` produced no
   * type — typeOfExpr previously had no subscript branch, the RHS could not be
   * inferred → the write point's inlay was empty. Not injected / unresolved by
   * the injector (the def key-type face) → null.
   */
  resolveSubscriptType?: (target: string, key: string) => string | null;
}

interface ClassSpan {
  name: string;
  startLine: number;
  endLine: number;
  /** Method name → start line (0-based) */
  methods: Map<string, { line: number; character: number }>;
}

interface MethodSpan {
  startLine: number;
  endLine: number;
  /** The method body's base indent (the first non-blank body line's indent; with no body line, the method line's indent + 1) */
  baseIndent: number;
}

/** Type-set operation: union (atomic dedup) */
function unionTypes(...sets: ReadonlyArray<ReadonlySet<string>>): Set<string> {
  const out = new Set<string>();
  for (const set of sets) {
    for (const item of set) {
      out.add(item);
    }
  }
  return out;
}

/** Drop None */
function withoutNone(types: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  for (const item of types) {
    if (item !== 'None') {
      out.add(item);
    }
  }
  return out;
}

/** Sort + join with ` | ` (deterministic for tests; 'None' sorts first lexicographically) */
function formatTypes(types: ReadonlySet<string>): string | null {
  if (types.size === 0) {
    return null;
  }
  return [...types].sort().join(' | ');
}

const indentOf = (line: string): number => {
  const match = /^[ \t]*/.exec(line);
  return match ? match[0].replace(/\t/g, '    ').length : 0;
};

const COMMENT_ONLY = /^\s*(#.*)?$/;
const BLANK = /^\s*$/;

/** `self.<attr> = <expr>` (exact attr match; assignment shape, not `==`) */
const selfAssignment = (attr: string): RegExp =>
  new RegExp(`^\\s*self\\.${escapeRegExp(attr)}\\s*=\\s*(?!=)(.+)$`);

/** `if self.<attr> is None:` (a positive None-guard) */
const noneGuard = (attr: string): RegExp =>
  new RegExp(`^\\s*if\\s+self\\.${escapeRegExp(attr)}\\s+is\\s+None\\s*:`);

/** `if self.<attr> is not None:` (a positive non-None guard) */
const notNoneGuard = (attr: string): RegExp =>
  new RegExp(`^\\s*if\\s+self\\.${escapeRegExp(attr)}\\s+is\\s+not\\s+None\\s*:`);

/**
 * Any `if`/`elif`/`else`/`for`/`while`/`try`/`except`/`finally`/`with` block
 * opener (non-comment). KODE-AUD-004: added else/except/finally — these three
 * block bodies were previously not recognized by anyBlockOpen in scanSequence,
 * so body lines with deeper indent were swallowed by the "skip" branch, and
 * `self.<attr> = ...` assignments inside the block contributed no flow type
 * (e.g. `if c: X=None / else: X=[..]` unioned only the then side after the
 * block, missing the else side). else/except/finally share the indent of
 * if/try, so they are folded into the generic block handling, with the
 * post-block union semantics unchanged.
 */
const anyBlockOpen = /^\s*(if|elif|else|for|while|try|except|finally|with)\b/;
const terminalLine = /^\s*(return|raise)\b/;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Extract the assignment's right-hand side (trailing comment stripped) */
function assignmentRhs(text: string, attr: string): string | null {
  const match = selfAssignment(attr).exec(text);
  if (!match) {
    return null;
  }
  return stripTrailingComment(match[1]);
}

function stripTrailingComment(rhs: string): string {
  // Simple shape: a `#` outside a string is treated as a comment cut (sufficient
  // for the literal face)
  let inString: string | null = null;
  for (let i = 0; i < rhs.length; i += 1) {
    const char = rhs[i];
    if (inString !== null) {
      if (char === inString && rhs[i - 1] !== '\\') {
        inString = null;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      inString = char;
      continue;
    }
    if (char === '#') {
      return rhs.slice(0, i).trim();
    }
  }
  return rhs.trim();
}

/**
 * Expression type (atomic set): literals (list/dict/set/tuple/str/int/float/
 * bool/None), call shapes (return annotation via callback), bare names (via
 * callback), `self.Y` (recursing into this engine). Uninferrable → the empty
 * set (no fabrication). Only shallow shape decisions, never parsing arbitrary
 * expressions.
 */
function typeOfExpr(expr: string, options?: SelfAttributeFlowOptions): Set<string> {
  const text = stripTrailingComment(expr);
  if (text.length === 0) {
    return new Set();
  }
  if (text === 'None') {
    return new Set(['None']);
  }
  if (text === 'True' || text === 'False') {
    return new Set(['bool']);
  }
  if (/^[+-]?\d+$/.test(text)) {
    return new Set(['int']);
  }
  if (/^[+-]?\d+\.\d+$/.test(text)) {
    return new Set(['float']);
  }
  // String literal (with optional b/r/f/u prefix): a b/B prefix = bytes
  // (b''/br''/rb''/B''), the rest (r/u/f and no prefix) = str. KODE-AUD-004:
  // previously always judged str, so b'...' was misjudged.
  const strPrefix = /^([bBrRuUfF]{0,2})['"]/.exec(text);
  if (strPrefix && /['"]$/.test(text)) {
    return new Set([/[bB]/.test(strPrefix[1]) ? 'bytes' : 'str']);
  }
  if (text.startsWith('[') && text.endsWith(']')) {
    return new Set(['list']);
  }
  if (text.startsWith('{') && text.endsWith('}')) {
    return new Set(['dict']);
  }
  if (text.startsWith('(') && text.endsWith(')')) {
    return new Set(['tuple']);
  }
  // Subscript read: `self.cellData['spaceUType']` / `cellData["x"]` (alias/bare
  // receivers accepted too) → get the key type via callback. This is exactly the
  // shape the 2026-11-23 user report said could not be inferred.
  const subscript = /^([A-Za-z_]\w*(?:\s*\.\s*[A-Za-z_]\w*)*)\s*\[\s*['"]([^'"]+)['"]\s*\]$/.exec(text);
  if (subscript) {
    const receiver = subscript[1].replace(/\s+/g, '');
    const target = receiver.split('.').pop()!;
    const annotation = options?.resolveSubscriptType?.(target, subscript[2]) ?? null;
    return annotation ? new Set([annotation]) : new Set();
  }
  // call shape: name(...) / a.b.c(...) → the final-segment callee's return annotation
  const callMatch = /^([A-Za-z_]\w*(?:\s*\.\s*[A-Za-z_]\w*)*)\s*\(/.exec(text);
  if (callMatch) {
    const callee = callMatch[1].split('.').pop()!.trim();
    const annotation = options?.resolveCallAnnotation?.(callee) ?? null;
    return annotation ? new Set([annotation]) : new Set();
  }
  // self.Y (recursion into this engine, bounded: no parsing one level deeper into nested self chains)
  const selfChain = /^self\.([A-Za-z_]\w*)$/.exec(text);
  if (selfChain) {
    // recursion is invoked by the caller with a known line context; return empty
    // here to avoid unbounded recursion (the caller handles it)
    return new Set();
  }
  // bare name (constant/variable): via callback
  const nameMatch = /^[A-Za-z_]\w*$/.exec(text);
  if (nameMatch) {
    const annotation = options?.resolveNameAnnotation?.(text) ?? null;
    return annotation ? new Set([annotation]) : new Set();
  }
  return new Set();
}

/** Method body bounds (0-based lines, inclusive end): reuses the class's sorted method intervals */
function enclosingMethod(
  classes: readonly ClassSpan[],
  line: number
): { method: MethodSpan; cls: ClassSpan } | null {
  for (const cls of classes) {
    if (line < cls.startLine || line >= cls.endLine) {
      continue;
    }
    const starts = [...cls.methods.values()].map(loc => loc.line).sort((a, b) => a - b);
    for (let i = starts.length - 1; i >= 0; i -= 1) {
      if (starts[i] <= line) {
        const endLine = i + 1 < starts.length ? starts[i + 1] - 1 : cls.endLine - 1;
        return {
          method: { startLine: starts[i], endLine, baseIndent: 0 },
          cls
        };
      }
    }
    return null;
  }
  return null;
}

/** The method body's base indent: the first non-blank line's indent after the method line; with no body line, the method line's indent + 1 */
function methodBaseIndent(lines: readonly string[], method: MethodSpan): number {
  const methodIndent = indentOf(lines[method.startLine]);
  for (let j = method.startLine + 1; j <= method.endLine; j += 1) {
    const text = lines[j];
    if (BLANK.test(text) || COMMENT_ONLY.test(text)) {
      continue;
    }
    return indentOf(text);
  }
  return methodIndent + 1;
}

interface ScanResult {
  state: Set<string>;
  /** the then branch terminates with return/raise (does not fall through past the block) */
  terminal: boolean;
  /** the scan stopped before stopAtLine (the query position is inside this block; the outer layer must return this state immediately) */
  reachedStop: boolean;
}

/**
 * Sequentially scan a run of statements (from startLine at the same indent
 * level), advancing attr's flow type. With a non-null stopAtLine, stop before
 * reaching that line (returning the state before that line without processing
 * it). Recursively handles if/for/while blocks: post-block state = union(entry
 * state, then state) (else path ∪ then path); on early exit (the block contains
 * a return/raise) the then path does not fall through, so post-block = the entry
 * state.
 */
function scanSequence(
  lines: readonly string[],
  startLine: number,
  endLine: number,
  indent: number,
  attr: string,
  initialState: ReadonlySet<string>,
  options: SelfAttributeFlowOptions | undefined,
  stopAtLine: number | null
): ScanResult {
  let state = new Set(initialState);
  let line = startLine;
  while (line <= endLine) {
    if (stopAtLine !== null && line >= stopAtLine) {
      // Reached the query position: stop inside this block, the outer layer must
      // return immediately (the query position is inside the block).
      // When the query position is exactly an assignment line, apply the
      // assignment semantics before stopping (the write point's inlay shows the
      // RHS type, the same contract as def inlay showing the declared type at
      // the write point, rather than the old None from a guard's true branch)
      const rhsAtStop = assignmentRhs(lines[line] ?? '', attr);
      if (rhsAtStop !== null) {
        return { state: typeOfExpr(rhsAtStop, options), terminal: false, reachedStop: true };
      }
      return { state, terminal: false, reachedStop: true };
    }
    const text = lines[line];
    if (BLANK.test(text) || COMMENT_ONLY.test(text)) {
      line += 1;
      continue;
    }
    const thisIndent = indentOf(text);
    if (thisIndent < indent) {
      // dedent: this sequence ends (the caller closes the block)
      break;
    }
    if (thisIndent > indent) {
      // deeper indent (a block body) does not belong to this level, skip it
      // (handled by block recursion); conservative step
      line += 1;
      continue;
    }
    // assignment: self.<attr> = expr → overwrite the flow type
    const rhs = assignmentRhs(text, attr);
    if (rhs !== null) {
      state = typeOfExpr(rhs, options);
      line += 1;
      continue;
    }
    // guard: if self.<attr> is None:
    if (noneGuard(attr).test(text)) {
      const blockEnd = findBlockEnd(lines, line, endLine, thisIndent);
      const bodyIndent = blockBodyIndent(lines, line, blockEnd);
      const inner = scanSequence(
        lines, line + 1, blockEnd, bodyIndent, attr, new Set(['None']), options, stopAtLine
      );
      if (inner.terminal) {
        // early exit: the then path does not fall through; the else path (X not None) continues → drop None
        state = unionTypes(withoutNone(state));
      } else {
        // the then path falls back after the block: union (else = X not None → dropped None, then = inner.state)
        state = unionTypes(withoutNone(state), inner.state);
      }
      if (inner.reachedStop) {
        return { state: inner.state, terminal: inner.terminal, reachedStop: true };
      }
      line = blockEnd + 1;
      continue;
    }
    // guard: if self.<attr> is not None:
    if (notNoneGuard(attr).test(text)) {
      const blockEnd = findBlockEnd(lines, line, endLine, thisIndent);
      const bodyIndent = blockBodyIndent(lines, line, blockEnd);
      const inner = scanSequence(
        lines, line + 1, blockEnd, bodyIndent, attr, withoutNone(state), options, stopAtLine
      );
      if (inner.terminal) {
        // early-exit non-None block: then exits, else (X may be None) continues → entry state
        state = unionTypes(state);
      } else {
        state = unionTypes(state, inner.state);
      }
      if (inner.reachedStop) {
        return { state: inner.state, terminal: inner.terminal, reachedStop: true };
      }
      line = blockEnd + 1;
      continue;
    }
    // other blocks (if/for/while/try/with): the body may contain assignments, union after the block
    if (anyBlockOpen.test(text)) {
      const blockEnd = findBlockEnd(lines, line, endLine, thisIndent);
      const bodyIndent = blockBodyIndent(lines, line, blockEnd);
      const inner = scanSequence(
        lines, line + 1, blockEnd, bodyIndent, attr, state, options, stopAtLine
      );
      if (inner.terminal) {
        state = unionTypes(state);
      } else {
        state = unionTypes(state, inner.state);
      }
      if (inner.reachedStop) {
        return { state: inner.state, terminal: inner.terminal, reachedStop: true };
      }
      line = blockEnd + 1;
      continue;
    }
    // return/raise: this sequence terminates (the caller marks terminal)
    if (terminalLine.test(text)) {
      return { state, terminal: true, reachedStop: false };
    }
    line += 1;
  }
  return { state, terminal: false, reachedStop: false };
}

/** The if/for/while block's closing line: the first non-blank line with indent <= ifIndent; none → endLine+1 */
function findBlockEnd(
  lines: readonly string[],
  startLine: number,
  endLine: number,
  indent: number
): number {
  for (let j = startLine + 1; j <= endLine; j += 1) {
    const text = lines[j];
    if (BLANK.test(text) || COMMENT_ONLY.test(text)) {
      continue;
    }
    if (indentOf(text) <= indent) {
      return j - 1;
    }
  }
  return endLine;
}

/** The block body's actual indent: the first non-blank line's indent after the block line; with no body line, the block line's indent + 1 */
function blockBodyIndent(
  lines: readonly string[],
  startLine: number,
  endLine: number
): number {
  for (let j = startLine + 1; j <= endLine; j += 1) {
    const text = lines[j];
    if (BLANK.test(text) || COMMENT_ONLY.test(text)) {
      continue;
    }
    return indentOf(text);
  }
  return indentOf(lines[startLine]) + 1;
}

/** Converged baseline: the __init__ body's flow-scan end state ∪ class-level declarations (including `X = None`) */
function convergedBaseline(
  lines: readonly string[],
  cls: ClassSpan,
  attr: string,
  options: SelfAttributeFlowOptions | undefined
): Set<string> {
  let baseline = new Set<string>();
  // class-level declarations: `X = ...` / `X: T = ...` at the class body's top level (the actual body indent)
  const classBodyIndent = blockBodyIndent(lines, cls.startLine, cls.endLine - 1);
  const firstMethodLine = cls.methods.size > 0
    ? Math.min(...[...cls.methods.values()].map(loc => loc.line))
    : cls.endLine - 1;
  const classAssignment = new RegExp(`^\\s*${escapeRegExp(attr)}\\s*=\\s*(?!=)(.+)$`);
  const classAnnotated = new RegExp(`^\\s*${escapeRegExp(attr)}\\s*:\\s*([^=#]+?)\\s*(?:=|$)`);
  for (let j = cls.startLine + 1; j < firstMethodLine && j < cls.endLine; j += 1) {
    const text = lines[j];
    if (BLANK.test(text) || COMMENT_ONLY.test(text)) {
      continue;
    }
    if (indentOf(text) !== classBodyIndent) {
      continue;
    }
    // annotated declaration `X: T = ...` (T takes priority; `X: T` with no initial value also counts)
    const annotated = classAnnotated.exec(text);
    if (annotated) {
      baseline = unionTypes(baseline, new Set([annotated[1].trim()]));
    }
    // assignment declaration `X = ...` (e.g. the class-level default `X = None`)
    const assigned = classAssignment.exec(text);
    if (assigned) {
      baseline = unionTypes(baseline, typeOfExpr(assigned[1], options));
    }
  }
  // the __init__ body's flow-scan end state (a trailing assignment overrides)
  const init = cls.methods.get('__init__');
  if (init) {
    const initMethod: MethodSpan = { startLine: init.line, endLine: cls.endLine - 1, baseIndent: 0 };
    initMethod.baseIndent = methodBaseIndent(lines, initMethod);
    const result = scanSequence(
      lines,
      init.line + 1,
      initMethod.endLine,
      initMethod.baseIndent,
      attr,
      baseline,
      options,
      null
    );
    baseline = result.state;
  }
  // NOTE: 2026-11-23 tried "cross-method write aggregation" (folding other
  // methods' `self.attr =` into the class-level baseline so that write points
  // such as onTeleportSuccess could also look up types). That shape diverged
  // from the Rust parity engine (the Rust side is not isomorphic, parity tests
  // permanently red), overstepped (queries at the class body / empty methods
  // were folded into other methods' types, getting a value where it should be
  // null), and its O(methods x lines) cost slowed ten-thousand-line parsing
  // (>8s budget). A real cross-method write-point index needs the Rust side's
  // isomorphic counterpart first; this face keeps the __init__/class-level
  // baseline unchanged.
  return baseline;
}

/**
 * The flow-sensitive type of the self-managed attribute at the query position
 * (pure function).
 * Returns null when: not inside a class method/class body, attr is empty, or
 * the context cannot be located.
 * The caller must first determine attr (e.g. extracted from an access scan of
 * self.<attr>).
 */
export function inferSelfAttributeFlow(
  lines: readonly string[],
  queryLine: number,
  attr: string,
  options?: SelfAttributeFlowOptions,
  versionKey?: string
): SelfAttributeFlow | null {
  if (!attr || queryLine < 0 || queryLine >= lines.length) {
    return null;
  }
  // KODE-PERF-001: multiple flow queries of the same document version share one
  // parse (key = uri|version); keyless (pure function/test) = parse fresh, same
  // behavior.
  const parsed = parseWithVersionCache(lines, versionKey);
  const classes = (parsed.classes as unknown as ClassSpan[]) ?? [];
  const enclosing = enclosingMethod(classes, queryLine);
  let baseline: Set<string>;
  let flow: Set<string>;
  if (enclosing) {
    baseline = convergedBaseline(lines, enclosing.cls, attr, options);
    const method = enclosing.method;
    method.baseIndent = methodBaseIndent(lines, method);
    const result = scanSequence(
      lines,
      method.startLine + 1,
      method.endLine,
      method.baseIndent,
      attr,
      baseline,
      options,
      queryLine
    );
    flow = result.state;
  } else {
    // class body / module level: no method flow, use the converged baseline directly
    const cls = classes.find(c => queryLine >= c.startLine && queryLine < c.endLine);
    baseline = cls ? convergedBaseline(lines, cls, attr, options) : new Set<string>();
    flow = new Set(baseline);
  }
  const hasNone = flow.has('None');
  const narrowed = baseline.has('None') && !hasNone;
  return {
    types: [...flow].sort(),
    annotation: formatTypes(flow),
    hasNone,
    narrowed
  };
}
