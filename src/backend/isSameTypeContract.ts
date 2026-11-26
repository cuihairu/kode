/**
 * KSEM-SER-07: the isSameType contract boundary face (signature/call
 * binding + compatibility proof status).
 *
 * Engine ground truth (datatype.cpp, verified in the tree):
 *  - Call binding = one positional argument: the impl verdict goes through
 *    PyObject_CallFunction(pyIsSameType, "(O)", obj) (:2450-2452) — exactly
 *    one parameter besides self; missing/extra parameters (no default)
 *    → TypeError on every check, SCRIPT_ERROR_CHECK records a script error
 *    and falls back to built-in validation (error spam);
 *  - Truth = pointer identity: Py_True == pyRet (:2458) — only the literal
 *    True short-circuits to a pass; 1/other truthy objects always count as
 *    false;
 *  - Short-circuit semantics (FixedDictType::isSameType :2497-2512): impl
 *    returning True → immediately return true, all built-in validation
 *    (FixedDict instance/dict size/per-key types) skipped; impl returning
 *    false is ignored and built-in validation proceeds (:2506) — returning
 *    False does not reject the object;
 *  - impl_createObjFromDict post-validation (:2421): the conversion result
 *    must pass isSameType, failure records a script error — isSameType is
 *    the compatibility gate of the conversion chain.
 *
 * Statically decidable domain (acceptance: "validation can determine the
 * signature and call binding; dynamic returns must not masquerade as proven
 * object compatibility — report a pending runtime verification status"):
 *  - arity face (Warning): the def signature is statically adjudicated
 *    against the engine's single positional argument binding — exactly one
 *    positional parameter without a default besides self/cls (or a named
 *    *args carrying it) is legal; no positional carrier / extra no-default
 *    positional parameters / required keyword-only parameters (**kwargs does
 *    not carry positional arguments) → TypeError on every call, anchor the
 *    def-line method name; unparseable signature (unclosed parens) → the
 *    method yields zero findings, no guessing;
 *  - compatibility proof status (at most one per method, priority
 *    aggregation acceptAll > pending > fallback, Information):
 *     - acceptAll: a `return True` site exists — the impl can short-circuit
 *       the engine past validation;
 *     - pending: a statically unprovable return site exists (calls/
 *       expressions/bare names/unresolved class names in isinstance) —
 *       compatibility unproven, pending runtime verification, neither
 *       masquerading as proven nor as incompatible (core acceptance
 *       sentence);
 *     - fallback: every return site is a non-True constant (False/None/
 *       numbers/strings) — the engine honors only True by pointer identity,
 *       these are always ignored and built-in validation decides.
 *    isinstance(obj, X): every X resolvable (built-in type name or a class
 *    name in this file) → the site is proven, zero findings; any element
 *    unresolvable → pending anchored at that element.
 *  - nested def blocks are skipped (honest about the domain); comment/
 *    string positions are not judged (mask verification).
 *
 * raw/masked dual-line convention: True/False/isinstance/class names are
 * code and survive on the masked line; string constant contents are wiped
 * by the mask (`return ""` still counts as a quoted constant after masking).
 * Anchor columns come from the raw line (the mask is length-preserving,
 * both sides share lines/columns, same-shaped pitfall as SER-04/05/06).
 *
 * Pure logic layer, does not import vscode.
 */

import { l10nText } from '../nlsRuntime';
import {
  containerSource,
  type FixedDictConstructDiagnosticItem
} from './fixedDictConstructCheck';
import {
  defSignatureParams,
  paramNameOf,
  type ImplMethodInputBinding
} from './createObjFromDictInput';
import { pythonCodeLines } from './pythonParser';

export const SAME_TYPE_CONTRACT_CODE = 'kbengine.isSameTypeBinding';

/** One isSameType contract boundary finding (the face is the proof status). */
export interface SameTypeFinding {
  line: number;
  /** Zero-based character column. */
  character: number;
  length: number;
  /** FD container type name. */
  container: string;
  /** impl symbol name. */
  symbol: string;
  /** arity=signature mismatch (Warning); acceptAll=always True, checks
   *  skipped; fallback=non-True constant, always ignored, built-in decides;
   *  pending=dynamic return, pending runtime verification. */
  face: 'arity' | 'acceptAll' | 'fallback' | 'pending';
  message: string;
}

/** arity face (signature statically adjudicated as mismatching the engine's single positional argument binding). */
export function renderArityMsg(symbol: string): string {
  return l10nText('{symbol}.isSameType signature does not match the engine call binding — the engine passes exactly one positional argument (datatype.cpp impl_isSameType), so every check raises TypeError and script errors replace validation', { symbol });
}

/** acceptAll face (always True, short-circuits past validation). */
export function renderAcceptAllMsg(
  container: string,
  symbol: string,
  source: string
): string {
  return l10nText('{symbol}.isSameType returns True unconditionally (declared in {source}) — the engine short-circuits on True and skips built-in validation entirely, so every object is accepted as {container} without per-key checks', { container, symbol, source });
}

/** fallback face (non-True constants are always ignored; the engine falls back to built-in validation). */
export function renderFallbackMsg(
  container: string,
  symbol: string,
  source: string
): string {
  return l10nText('{symbol}.isSameType only returns constants other than True (declared in {source}) — the engine compares the return by pointer identity with True, so these returns never count and built-in validation decides instead; returning False does not reject {container} objects', { container, symbol, source });
}

/** pending face (dynamic return awaiting runtime verification; never masquerades as proven compatibility). */
export function renderPendingMsg(
  container: string,
  symbol: string,
  source: string
): string {
  return l10nText('{symbol}.isSameType returns a value whose compatibility cannot be proven statically (declared in {source}); object compatibility for {container} is unverified — runtime samples are required before treating this converter as verified', { container, symbol, source });
}

/** Python built-in type names (the resolvable domain for isinstance elements). */
const BUILTIN_TYPES: ReadonlySet<string> = new Set([
  'int', 'str', 'float', 'bool', 'bytes', 'bytearray', 'list', 'tuple',
  'dict', 'set', 'frozenset', 'object', 'complex', 'type', 'range',
  'memoryview'
]);

/** Classification of one return site. */
interface RetSite {
  face: 'acceptAll' | 'fallback' | 'pending';
  line: number;
  character: number;
  length: number;
}

/** Aggregation priority: always-True skips checks > pending runtime verification > always ignored. */
const FACE_RANK: Record<RetSite['face'], number> = {
  acceptAll: 3,
  pending: 2,
  fallback: 1
};

/** Constant tokens: False/None/numbers/quoted literals (masked-line contents are placeholders). */
function isConstToken(token: string): boolean {
  if (token === 'False' || token === 'None') {
    return true;
  }
  if (/^-?\d[\d_]*(\.\d+)?$/.test(token)) {
    return true;
  }
  return /^(["']).*\1$/.test(token);
}

/** Bare identifier. */
function isBareName(token: string): boolean {
  return /^[A-Za-z_]\w*$/.test(token);
}

/** Skips a nested def block; returns the line number to resume at. */
function skipNested(
  masked: readonly string[],
  at: number,
  end: number
): number {
  const head = masked[at] ?? '';
  const base = head.length - head.trimStart().length;
  let line = at + 1;
  while (line <= end && line < masked.length) {
    const inner = masked[line] ?? '';
    if (
      inner.trim().length > 0 &&
      inner.length - inner.trimStart().length <= base
    ) {
      break;
    }
    line += 1;
  }
  return line;
}

/** Collects class names in this file from masked lines (resolvable domain for isinstance elements). */
function fileClassNames(masked: readonly string[]): Set<string> {
  const names = new Set<string>();
  const pattern = /^\s*class\s+([A-Za-z_]\w*)/;
  for (const line of masked) {
    const hit = pattern.exec(line);
    if (hit) {
      names.add(hit[1]);
    }
  }
  return names;
}

/** Takes the balanced-paren span starting at `start` of the raw line (content + closing column; unbalanced → null). */
function parenSpan(
  raw: string,
  start: number
): { content: string; end: number } | null {
  if (raw[start] !== '(') {
    return null;
  }
  let depth = 0;
  let quote: string | null = null;
  for (let i = start; i < raw.length; i += 1) {
    const ch = raw[i];
    if (quote !== null) {
      if (ch === '\\') {
        i += 1;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '(') {
      depth += 1;
    } else if (ch === ')') {
      depth -= 1;
      if (depth === 0) {
        return { content: raw.slice(start + 1, i), end: i };
      }
    }
  }
  return null;
}

/**
 * Element set of the second isinstance argument (bare names / tuple bare
 * names, tuple shapes recursively expanded into leaves), elements carry
 * raw line/column; shape mismatch → null (lands in pending, no guessing).
 * content = text inside the isinstance balanced span, base = its start
 * column on the raw line.
 */
function typeTestArgs(
  content: string,
  base: number
): Array<{ name: string; start: number }> | null {
  let text = content;
  let origin = base;
  if (content.trimStart().startsWith('(')) {
    const at = content.indexOf('(');
    const inner = parenSpan(content, at);
    if (!inner) {
      return null;
    }
    text = inner.content;
    origin = base + at + 1;
  }
  const pieces = splitTypeArgs(text, origin);
  if (pieces === null) {
    return null;
  }
  const leaves: Array<{ name: string; start: number }> = [];
  for (const piece of pieces) {
    if (piece.name.trimStart().startsWith('(')) {
      const at = piece.name.indexOf('(');
      const inner = parenSpan(piece.name, at);
      if (!inner) {
        return null;
      }
      const nested = splitTypeArgs(inner.content, piece.start + at + 1);
      if (nested === null) {
        return null;
      }
      leaves.push(...nested);
    } else {
      leaves.push(piece);
    }
  }
  return leaves;
}

/**
 * Top-level comma split (quote/paren-depth aware), elements carry raw
 * line/column (column = the element's first non-whitespace character). An
 * unterminated quote segment still returns with the elements collected so
 * far (the caller's element shape validation backstops it).
 */
function splitTypeArgs(
  text: string,
  origin: number
): Array<{ name: string; start: number }> {
  const elements: Array<{ name: string; start: number }> = [];
  let depth = 0;
  let quote: string | null = null;
  let current = '';
  let mark = origin;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote !== null) {
      if (ch === '\\') {
        i += 1;
        current += ch;
      } else if (ch === quote) {
        quote = null;
        current += ch;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') {
      depth += 1;
    } else if (ch === ')' || ch === ']' || ch === '}') {
      depth -= 1;
    }
    if (ch === ',' && depth === 0) {
      const piece = current.trim();
      if (piece.length > 0) {
        elements.push({ name: piece, start: mark });
      }
      current = '';
      mark = origin + i + 1;
      continue;
    }
    if (current.trim().length === 0 && /\s/.test(ch)) {
      mark = origin + i + 1;
      continue;
    }
    current += ch;
  }
  const piece = current.trim();
  if (piece.length > 0) {
    elements.push({ name: piece, start: mark });
  }
  return elements;
}

/**
 * isSameType contract boundary entry. inputs = resolveImplMethodInputs(
 * text, bindings, 'isSameType') (same-shaped machine as SER-04/05/06).
 */
export function computeSameTypeFindings(
  text: string,
  inputs: readonly ImplMethodInputBinding[]
): SameTypeFinding[] {
  const findings: SameTypeFinding[] = [];
  if (inputs.length === 0) {
    return findings;
  }
  const masked = pythonCodeLines(text);
  const realLines = text.split(/\r?\n/);
  const docClasses = fileClassNames(masked);

  for (const input of inputs) {
    const symbol = input.symbol;
    const container = input.container;
    const source = containerSource(container);
    const short = symbol.includes('.')
      ? symbol.slice(symbol.lastIndexOf('.') + 1)
      : symbol;

    // ── arity face: signature statically adjudicated against the engine's
    // single positional argument binding ──
    const signature = defSignatureParams(realLines, input.defLine);
    if (signature === null) {
      continue; // unparseable signature (unclosed parens): no guessing
    }
    // Parameter-by-parameter adjudication (judged on the raw line, not on a
    // stripped-name line): '/' is the positional-only marker; a leading '*'
    // = keyword-only territory (only a named single-star *args carries the
    // engine's positional argument, '**' only collects keywords); has-default
    // = the parameter contains '=' (a bare-annotation parameter has no '=';
    // '==' can only appear inside a default expression, still has-default).
    // Besides self/cls the engine passes exactly one positional argument:
    // no positional carrier / extra no-default positional parameter /
    // required keyword-only parameter → TypeError every time.
    let objSeen = false;
    let varArgsSeen = false;
    let starForm = false;
    let badArity = false;
    for (const rawParam of signature.params) {
      const trimmed = rawParam.trim();
      if (trimmed === '/') {
        continue;
      }
      if (trimmed.startsWith('*')) {
        starForm = true;
        varArgsSeen = trimmed.length > 1 && !trimmed.startsWith('**');
        continue;
      }
      const name = paramNameOf(trimmed);
      if (!objSeen && (name === 'self' || name === 'cls')) {
        continue;
      }
      const hasDefault = trimmed.includes('=');
      if (starForm) {
        if (!hasDefault) {
          badArity = true; // required keyword-only parameter, the engine passes none
        }
        continue;
      }
      if (!objSeen) {
        objSeen = true; // the obj parameter (where the engine's positional argument lands)
        continue;
      }
      if (!hasDefault) {
        badArity = true; // extra required positional parameter
      }
    }
    if (!objSeen && !varArgsSeen) {
      badArity = true; // the engine's single positional argument has no carrier
    }
    if (badArity) {
      const defText = realLines[input.defLine] ?? '';
      // Anchor the method name on the def line: symbol is the container-
      // qualified class name (no method name), indexOf(short) misses on the
      // def line → wrong anchor at 0; take the real name from the def line)
      const nameMatch = /^\s*def\s+([A-Za-z_]\w*)/.exec(defText);
      const at = nameMatch
        ? nameMatch.index + nameMatch[0].indexOf(nameMatch[1])
        : defText.indexOf(short);
      const anchored = nameMatch ? nameMatch[1] : short;
      findings.push({
        line: input.defLine,
        character: at >= 0 ? at : 0,
        length: Math.max(1, anchored.length),
        container: container.name,
        symbol,
        face: 'arity',
        message: renderArityMsg(symbol)
      });
      continue; // signature mismatch: every call raises TypeError, the body is meaningless
    }

    // ── compatibility proof status: return site classification (priority
    // aggregation) ──
    let best: RetSite | null = null;
    let line = input.bodyStartLine;
    while (line <= input.bodyEndLine && line < masked.length) {
      const m = masked[line] ?? '';
      if (m.trim().length === 0) {
        line += 1;
        continue;
      }
      if (/^\s*def\s/.test(m)) {
        line = skipNested(masked, line, input.bodyEndLine);
        continue;
      }
      if (!/^\s*return\s+\S/.test(m)) {
        line += 1;
        continue;
      }
      const raw = realLines[line] ?? '';
      const returnAt = m.indexOf('return');
      // ── isinstance(...): every element resolvable → proven, zero
      // findings; otherwise pending ──
      if (/^\s*return\s+isinstance\s*\(/.test(m)) {
        const openAt = raw.indexOf('(', returnAt + 6);
        const span = openAt >= 0 ? parenSpan(raw, openAt) : null;
        const elements = span ? typeTestArgs(span.content, openAt + 1) : null;
        const resolvable =
          elements !== null &&
          elements.length >= 2 &&
          elements
            .slice(1)
            .every(
              element =>
                isBareName(element.name) &&
                (BUILTIN_TYPES.has(element.name) || docClasses.has(element.name))
            );
        if (!resolvable) {
          const unresolved =
            elements !== null && elements.length >= 2
              ? elements
                  .slice(1)
                  .find(
                    element =>
                      !isBareName(element.name) ||
                      (!BUILTIN_TYPES.has(element.name) &&
                        !docClasses.has(element.name))
                  )
              : undefined;
          const anchor =
            unresolved !== undefined
              ? unresolved.start
              : raw.indexOf('isinstance', returnAt);
          if (best === null || FACE_RANK.pending > FACE_RANK[best.face]) {
            best = {
              face: 'pending',
              line,
              character: anchor,
              length: Math.max(
                1,
                unresolved !== undefined
                  ? unresolved.name.length
                  : 'isinstance'.length
              )
            };
          }
        }
        line += 1;
        continue;
      }
      // ── single token: return True / non-True constant / bare name ──
      const constMatch = /^\s*return\s+(\S+)\s*$/.exec(m);
      if (constMatch) {
        const tokenMasked = constMatch[1];
        const rawHit = /^\s*(\S+)/.exec(raw.slice(returnAt + 6));
        const tokenRaw = rawHit ? rawHit[1] : tokenMasked;
        const tokenAt = raw.indexOf(tokenRaw, returnAt + 6);
        const anchor = tokenAt >= 0 ? tokenAt : returnAt + 7;
        if (tokenRaw === 'True') {
          if (best === null || FACE_RANK.acceptAll > FACE_RANK[best.face]) {
            best = {
              face: 'acceptAll',
              line,
              character: anchor,
              length: Math.max(1, tokenRaw.length)
            };
          }
        } else if (isConstToken(tokenRaw)) {
          if (best === null || FACE_RANK.fallback > FACE_RANK[best.face]) {
            best = {
              face: 'fallback',
              line,
              character: anchor,
              length: Math.max(1, tokenRaw.length)
            };
          }
        } else {
          if (best === null || FACE_RANK.pending > FACE_RANK[best.face]) {
            best = {
              face: 'pending',
              line,
              character: anchor,
              length: Math.max(1, tokenRaw.length)
            };
          }
        }
        line += 1;
        continue;
      }
      // ── remaining multi-token returns (calls/expressions/parenthesized
      // constants) → pending ──
      const rawHit = /(\S+)/.exec(raw.slice(returnAt + 6));
      const tokenRaw = rawHit ? rawHit[1] : '';
      const tokenAt = tokenRaw ? raw.indexOf(tokenRaw, returnAt + 6) : returnAt;
      if (best === null || FACE_RANK.pending > FACE_RANK[best.face]) {
        best = {
          face: 'pending',
          line,
          character: tokenAt >= 0 ? tokenAt : returnAt,
          length: Math.max(1, tokenRaw.length || 1)
        };
      }
      line += 1;
    }

    if (best === null) {
      continue; // every return site proven (resolvable isinstance) or no return: zero findings
    }
    const message =
      best.face === 'acceptAll'
        ? renderAcceptAllMsg(container.name, symbol, source)
        : best.face === 'fallback'
          ? renderFallbackMsg(container.name, symbol, source)
          : renderPendingMsg(container.name, symbol, source);
    findings.push({
      line: best.line,
      character: best.character,
      length: best.length,
      container: container.name,
      symbol,
      face: best.face,
      message
    });
  }
  return findings;
}

/** finding → diagnostic item (arity Warning; proof-status faces Information; same family shape). */
export function sameTypeFindingToItem(
  finding: SameTypeFinding
): FixedDictConstructDiagnosticItem {
  return {
    range: {
      start: { line: finding.line, character: finding.character },
      end: { line: finding.line, character: finding.character + finding.length }
    },
    message: finding.message,
    severity: finding.face === 'arity' ? 'Warning' : 'Information',
    source: 'kbengine',
    code: SAME_TYPE_CONTRACT_CODE
  };
}
