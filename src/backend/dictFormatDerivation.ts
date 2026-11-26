/**
 * KSEM-SER-09: project static dict format derivation (pure core, zero vscode
 * dependencies).
 *
 * Acceptance contract (todo.md KSEM-SER-09): extract required, optional and
 * value types from definite dict constructions/write sites; branch confluence,
 * multiple writers and dynamic update widen the result to an open structure.
 *
 * Derivation model (module scope v1):
 *  - Write-site collection = module scope (lines not falling inside any
 *    def/class body; if/elif/else/for/while/try/except/with bodies are still
 *    module scope — Python semantics); a function-local variable of the same
 *    name is a different scope and is never merged (conflating same names
 *    across scopes would be a false report; honest boundary);
 *  - Three tiers of execution guarantee: always (unconditional write site at
 *    module top level) > complete (an if/elif/else group with an else in which
 *    the key has a write site in every arm of that group — exactly one arm
 *    executes, so the key must be present) > maybe (an if arm without an else,
 *    or a for/while/try/except/with body — may not execute);
 *  - Ordering semantics: an unconditional literal write site is a rebind
 *    (later reads see the new shape and earlier conditional write sites are
 *    void — evidence for the old binding does not survive a rebind); dynamic
 *    write sites after it (subscript write / update / setdefault / |= / del)
 *    merge in and set the structure open;
 *  - An unconditional non-literal RHS (constructor call / bare name) is a
 *    terminal unknown (subsequent dynamic write sites turn into
 *    open+observed);
 *  - Required = a key written by an always write site, or written in every arm
 *    of a complete group; optional = the remaining keys with evidence; a value
 *    type disagreeing across multiple write sites of the same key becomes
 *    unknown (no guessing);
 *  - Open structure = any dynamic write site / spread / comprehension / dynamic
 *    key, giving kind 'open'; observed retains the already-observed key surface
 *    (the universe is open, but the observed evidence is still true);
 *  - Value type surface = literal classification: quoted string / int / float /
 *    True / False / None / list (element type taken from the first element,
 *    mixed/empty becomes unknown) / tuple (serialization-direction evidence for
 *    the SER-10 JSON conversion surface; after dumps a tuple becomes a list,
 *    see jsonChainPropagation; (1,) and (1, 2) are tuples, (1) is a parenthesized
 *    scalar, and a `(... for …)` generator expression is not a tuple, hence
 *    unknown) / nested dict (recursive parseDictPairs, all keys required at a
 *    single write site; ** spread / comprehension make the nesting open) /
 *    everything else (names / calls / f-strings) becomes unknown.
 *
 * Raw/masked dual-line contract: structure decisions (def/class/branch lines /
 * write-site shapes) use masked lines, while key strings and value literal
 * contents use raw lines (the pythonCodeLines mask turns quotes into '_', so
 * string values are only visible in the raw text; matchDictBraces already
 * strips comments). Same family of traps as SER-04/05/06.
 *
 * Consumption contract: KSEM-SER-10 (JSON dumps/loads chain propagation,
 * jsonChainPropagation) decides structure from this module's output; variables
 * with no write sites do not enter the map (a missing key on the caller side
 * is unknown); when schema binding (KSEM-SER-08 design) matches, the schema
 * wins — this derivation is only an evidence source for the code-fact side.
 */

import { pythonCodeLines } from './pythonParser';
import {
  matchDictBraces,
  parseDictPairs,
  type MatchedBraces
} from './fixedDictConstructCheck';

/** Value type surface of a key (literal facts; undecidable = unknown, no guessing). */
export type DictValueKind =
  | { kind: 'scalar'; scalar: 'str' | 'int' | 'float' | 'bool' | 'none' }
  | { kind: 'list'; element: DictValueKind | null }
  | { kind: 'tuple'; element: DictValueKind | null }
  | { kind: 'dict'; dict: DictFormat }
  | { kind: 'unknown' };

/**
 * Format of a variable dict:
 *  - literal: closed shape (required = mandatory keys, optional = optional keys);
 *  - open: open structure (observed = already-seen keys, universe open);
 *  - unknown: rebound to a non-literal / undecidable (no key-surface claim).
 */
export type DictFormat =
  | {
      kind: 'literal';
      required: Map<string, DictValueKind>;
      optional: Map<string, DictValueKind>;
    }
  | { kind: 'open'; observed: Map<string, DictValueKind> }
  | { kind: 'unknown' };

/** Key evidence at a write site (key → value type). */
type KeyEvidence = Map<string, DictValueKind>;

/** Execution-guarantee rank of a key. */
type KeyRank = 'always' | 'complete' | 'maybe';

/** One write-site record (the evidence unit for a single assignment/write site of a variable). */
interface WriterRec {
  line: number;
  /** Assignment rebind (= {...}); false = incremental write site (subscript/update/setdefault/|=). */
  rebind: boolean;
  /** always / complete group / maybe (complete is filled in after resolution). */
  rank: KeyRank;
  /** Dynamic write site (open-universe evidence). */
  dynamic: boolean;
  /** Rebind to a non-literal (terminal-unknown evidence). */
  unknownBase: boolean;
  keys: KeyEvidence;
}

/** Branch-group site needed for module-scope decisions (hasElse/arm coverage filled in after parsing). */
interface IfGroup {
  id: number;
  hasElse: boolean;
  armCount: number;
  /** Arm ordinal → the set of keys written in that arm (complete only if every arm carries the key). */
  arms: Map<number, KeyEvidence>;
}

/** Module-scope compound-block site (arm = the current arm ordinal inside this block, incremented by elif/else). */
interface BlockFrame {
  indent: number;
  kind: string;
  group: IfGroup | null;
  arm: number;
}

/**
 * Entry point of dict format derivation: module-scope variables of the whole
 * file → format map (only variables with dict evidence; variables without
 * write sites do not enter the map, so a missing key on the caller side is
 * unknown).
 */
export function deriveDictFormats(text: string): Map<string, DictFormat> {
  const masked = pythonCodeLines(text);
  const realLines = text.split(/\r?\n/);
  const collectors = new Map<
    string,
    { recs: WriterRec[]; groups: Map<number, IfGroup> }
  >();
  const scopeIndents: number[] = [];
  const blockStack: BlockFrame[] = [];
  let ifSeq = 0;
  let line = 0;
  while (line < masked.length) {
    const m = masked[line] ?? '';
    if (m.trim().length === 0) {
      line += 1;
      continue;
    }
    const indent = m.length - m.trimStart().length;
    // Scope/branch stack shrink: dedented lines close deeper def/class and
    // branch blocks
    while (
      scopeIndents.length > 0 &&
      scopeIndents[scopeIndents.length - 1] >= indent
    ) {
      scopeIndents.pop();
    }
    // elif/else continue the if group at the same indent: the topmost group
    // frame is exempt from shrinking (pop-then-find at the same indent would
    // always come up empty, making the branch-confluence surface dead); other
    // lines close blocks normally by dedent
    const continuesGroup = /^(elif|else)\b/.test(m.trim());
    while (blockStack.length > 0) {
      const top = blockStack[blockStack.length - 1];
      if (continuesGroup && top.indent === indent && top.group !== null) {
        break;
      }
      if (top.indent < indent) {
        break;
      }
      blockStack.pop();
    }
    const inFunction = scopeIndents.length > 0;
    const isCompound = /^\s*(async\s+)?(def|class)\s/.test(m) ||
      /^(if|elif|else|for|while|try|except|finally|with)\b/.test(m.trim());
    if (isCompound) {
      const trimmed = m.trim();
      if (/^(async\s+)?(def|class)\s/.test(trimmed)) {
        scopeIndents.push(indent);
        line += 1;
        continue;
      }
      if (!inFunction) {
        if (/^if\b/.test(trimmed)) {
          ifSeq += 1;
          blockStack.push({
            indent,
            kind: 'if',
            arm: 0,
            group: { id: ifSeq, hasElse: false, armCount: 1, arms: new Map() }
          });
        } else if (/^elif\b/.test(trimmed) && blockStack.length > 0) {
          const top = blockStack[blockStack.length - 1];
          if (top.group !== null) {
            top.group.armCount += 1;
            top.arm += 1;
          }
        } else if (/^else\b/.test(trimmed) && blockStack.length > 0) {
          const top = blockStack[blockStack.length - 1];
          if (top.group !== null) {
            top.group.hasElse = true;
            top.group.armCount += 1;
            top.arm += 1;
          }
        } else {
          // Strip trailing colon from the header token: `try:` / `finally:` are
          // single tokens and, colon included, never hit the maybe list
          // (`for i in xs:` naturally strips its trailing part, unaffected)
          blockStack.push({ indent, kind: trimmed.split(/\s/)[0].replace(/:+$/, ''), group: null, arm: 0 });
        }
      }
      line += 1;
      continue;
    }
    if (!inFunction) {
      const next = collectWriter(m, realLines, line, blockStack, collectors);
      if (next > line) {
        line = next; // skip the whole multiline literal write site
        continue;
      }
    }
    line += 1;
  }
  const out = new Map<string, DictFormat>();
  for (const [name, state] of collectors) {
    const shape = resolveShape(state.recs, state.groups);
    if (shape !== null) {
      out.set(name, shape);
    }
  }
  return out;
}

/**
 * Single-line write-site collection (shape decided from the masked line;
 * literal pairing and key strings use the raw line). Returning a value >
 * line means a multiline literal write site was consumed whole and the
 * caller should jump to the returned line.
 */
function collectWriter(
  m: string,
  realLines: string[],
  line: number,
  blockStack: ReadonlyArray<BlockFrame>,
  collectors: Map<string, { recs: WriterRec[]; groups: Map<number, IfGroup> }>
): number {
  const rankOf = (): KeyRank => {
    for (const block of blockStack) {
      if (block.kind === 'for' || block.kind === 'while' || block.kind === 'try' ||
          block.kind === 'except' || block.kind === 'finally' || block.kind === 'with') {
        return 'maybe';
      }
    }
    for (const block of blockStack) {
      if (block.group !== null) {
        return 'complete'; // placeholder: downgraded to full-arm coverage / hasElse during group resolution
      }
    }
    return 'always';
  };
  const groupId = (): IfGroup | null => {
    for (let i = blockStack.length - 1; i >= 0; i -= 1) {
      if (blockStack[i].group !== null) {
        return blockStack[i].group;
      }
      if (blockStack[i].kind === 'for' || blockStack[i].kind === 'while' ||
          blockStack[i].kind === 'try' || blockStack[i].kind === 'except' ||
          blockStack[i].kind === 'finally' || blockStack[i].kind === 'with') {
        return null;
      }
    }
    return null;
  };
  const group = groupId();
  const baseRank = rankOf();
  const push = (
    name: string,
    rec: Omit<WriterRec, 'line'>
  ): void => {
    let state = collectors.get(name);
    if (!state) {
      state = { recs: [], groups: new Map() };
      collectors.set(name, state);
    }
    state.recs.push({ line, ...rec });
    if (group !== null) {
      let g = state.groups.get(group.id);
      if (!g) {
        g = { id: group.id, hasElse: group.hasElse, armCount: group.armCount, arms: new Map() };
        state.groups.set(g.id, g);
      }
      g.hasElse = group.hasElse;
      g.armCount = group.armCount;
      const arm = armIndex(blockStack);
      const keys = g.arms.get(arm) ?? new Map();
      for (const [k, v] of rec.keys) {
        keys.set(k, v);
      }
      g.arms.set(arm, keys);
    }
  };
  const armIndex = (stack: ReadonlyArray<BlockFrame>): number => {
    for (let i = stack.length - 1; i >= 0; i -= 1) {
      if (stack[i].group !== null) {
        return stack[i].arm;
      }
    }
    return 0;
  };

  // ── NAME = { literal (rebind semantics; annotated targets tolerated) ──
  const literalAssign = /^([A-Za-z_]\w*)\s*(?::[^=]*?)?=\s*\{/.exec(m.trim());
  if (literalAssign) {
    const raw = realLines[line] ?? '';
    const rawTrim = raw.trim();
    const braceOffset = rawTrim.indexOf('{');
    const rawIndent = raw.length - raw.trimStart().length;
    const matched = braceOffset >= 0
      ? matchDictBraces(realLines, line, rawIndent + braceOffset)
      : null;
    if (matched) {
      const keys = literalKeysOf(matched);
      push(literalAssign[1], {
        rebind: true,
        rank: baseRank,
        dynamic: keys.dynamic,
        unknownBase: false,
        keys: keys.map
      });
      return matched.endLine + 1;
    }
    // `{` brace match failed (window exceeded / unclosed): shape is not guessed —
    // non-literal terminal, honest
    push(literalAssign[1], { rebind: true, rank: baseRank, dynamic: false, unknownBase: true, keys: new Map() });
    return line + 1;
  }
  // ── NAME = non-literal RHS (call / bare name / scalar) = terminal-unknown
  // evidence (decided on the masked line: comment/string positions never
  // match) ──
  const plainAssign = /^([A-Za-z_]\w*)\s*(?::[^=]*?)?=(?![=>])\s*\S/.exec(m.trim());
  if (plainAssign) {
    push(plainAssign[1], { rebind: true, rank: baseRank, dynamic: false, unknownBase: true, keys: new Map() });
    return line + 1;
  }
  // ── NAME[key] = RHS (single literal key = observed key; variable key = open) ──
  // The key string's quotes are masked to '_', so shape matching uses the raw
  // line; the name position is verified against the masked line
  // (comment/string positions are not judged — the SER-04/05/06 family of traps)
  const raw = realLines[line] ?? '';
  const rawTrim = raw.trim();
  const subWrite = /^([A-Za-z_]\w*)\s*\[\s*(['"])([\s\S]*?)\2\s*\]\s*=(?![=>])/.exec(rawTrim);
  if (subWrite) {
    const nameAt = subWrite.index + subWrite[0].indexOf(subWrite[1]);
    if (m.trim().slice(nameAt, nameAt + subWrite[1].length) !== subWrite[1]) {
      return line; // comment/string position: the name is not real code
    }
    const quoteAt = rawTrim.indexOf(subWrite[2], subWrite[1].length);
    const keyText = quoteAt >= 0
      ? rawTrim.slice(quoteAt + 1).split(subWrite[2])[0]
      : subWrite[3];
    const rhsAt = rawTrim.indexOf('=', rawTrim.indexOf(']')) + 1;
    const value = classifyValue(rawTrim.slice(rhsAt).trim());
    push(subWrite[1], {
      rebind: false,
      rank: baseRank,
      dynamic: false,
      unknownBase: false,
      keys: new Map([[keyText, value]])
    });
    return line + 1;
  }
  // ── NAME[dynamic key] = … / NAME[slice] = … → open ──
  const dynWrite = /^([A-Za-z_]\w*)\s*\[(?!\s*['"]).+\]\s*=(?![=>])/.exec(m.trim());
  if (dynWrite) {
    push(dynWrite[1], { rebind: false, rank: baseRank, dynamic: true, unknownBase: false, keys: new Map() });
    return line + 1;
  }
  // ── NAME.update(...) / NAME.setdefault(...) / NAME |= RHS ──
  const updateCall = /^([A-Za-z_]\w*)\s*\.\s*(update|setdefault)\s*\((.+)\)\s*$/.exec(m.trim());
  if (updateCall) {
    const rawTrim = raw.trim();
    if (updateCall[2] === 'setdefault') {
      // setdefault semantics: key = first argument, value = second argument
      // (default None) — the dict argument is the inserted value, not a
      // key-surface merge like update
      const argsText = rawTrim.slice(rawTrim.indexOf('(') + 1, rawTrim.lastIndexOf(')')).trim();
      const args = splitTopLevel(argsText);
      const keyTok = args !== null && args.length >= 1 ? args[0].trim() : '';
      const setKey = keyTok.length >= 2 && isQuotedLiteral(keyTok)
        ? keyTok.slice(1, -1)
        : null;
      if (setKey === null) {
        push(updateCall[1], { rebind: false, rank: baseRank, dynamic: true, unknownBase: false, keys: new Map() });
      } else {
        const valueText = args !== null && args.length >= 2 ? args[1].trim() : 'None';
        push(updateCall[1], {
          rebind: false,
          rank: baseRank,
          dynamic: false,
          unknownBase: false,
          keys: new Map([[setKey, classifyValue(valueText)]])
        });
      }
      return line + 1;
    }
    const openAt = rawTrim.indexOf('(');
    const argText = rawTrim.slice(openAt + 1, rawTrim.lastIndexOf(')')).trim();
    const braceAt = argText.indexOf('{');
    const argIndent = rawIndentOf(raw, argText, braceAt);
    const matched = braceAt >= 0 && argIndent >= 0
      ? matchDictBraces(realLines, line, argIndent)
      : null;
    if (matched) {
      const keys = literalKeysOf(matched);
      push(updateCall[1], {
        rebind: false,
        rank: baseRank,
        dynamic: keys.dynamic,
        unknownBase: false,
        keys: keys.map
      });
    } else {
      // Non-literal argument / mixed multiple arguments → open universe
      push(updateCall[1], { rebind: false, rank: baseRank, dynamic: true, unknownBase: false, keys: new Map() });
    }
    return line + 1;
  }
  const ior = /^([A-Za-z_]\w*)\s*\|=\s*(.+)$/.exec(m.trim());
  if (ior) {
    const rawTrim = raw.trim();
    const braceAt = rawTrim.indexOf('{');
    const argIndent = braceAt >= 0 ? rawIndentOf(raw, rawTrim, braceAt) : -1;
    const matched = braceAt >= 0 && argIndent >= 0
      ? matchDictBraces(realLines, line, argIndent)
      : null;
    if (matched) {
      const keys = literalKeysOf(matched);
      push(ior[1], { rebind: false, rank: baseRank, dynamic: keys.dynamic, unknownBase: false, keys: keys.map });
    } else {
      push(ior[1], { rebind: false, rank: baseRank, dynamic: true, unknownBase: false, keys: new Map() });
    }
    return line + 1;
  }
  // ── del NAME[key] → key evidence voided, treated as open ──
  if (/^del\s+[A-Za-z_]\w*\s*\[/.test(m.trim())) {
    const delName = /^del\s+([A-Za-z_]\w*)/.exec(m.trim());
    if (delName) {
      push(delName[1], { rebind: false, rank: baseRank, dynamic: true, unknownBase: false, keys: new Map() });
    }
    return line + 1;
  }
  return line;
}

/** Absolute column of argText's first `{` within the raw line (argText absent / no `{` → -1). */
function rawIndentOf(raw: string, argText: string, braceAt: number): number {
  if (braceAt < 0) {
    return -1;
  }
  const probe = argText.slice(braceAt, braceAt + 1);
  if (probe !== '{') {
    return -1;
  }
  const rawTrim = raw.trim();
  const at = rawTrim.indexOf('{', rawTrim.indexOf(argText.slice(0, 8)));
  if (at < 0) {
    return -1;
  }
  return raw.length - raw.trimStart().length + at;
}

/** Literal → key evidence (all keys required at a single write site; ** spread / comprehension / dynamic key → open). */
function literalKeysOf(matched: MatchedBraces): { map: KeyEvidence; dynamic: boolean } {
  const { pairs, openUniverse } = parseDictPairs(matched);
  const map: KeyEvidence = new Map();
  let dynamic = openUniverse;
  for (const pair of pairs) {
    if (pair.spread || pair.key === null) {
      dynamic = true;
      continue;
    }
    if (isComprehensionValue(pair.valueText)) {
      dynamic = true;
      continue;
    }
    map.set(pair.key, classifyValue(pair.valueText));
  }
  return { map, dynamic };
}

/** Value text containing a top-level for…in (dict/set comprehension) → open structure. */
function isComprehensionValue(valueText: string): boolean {
  let probe = valueText.trim();
  const open = probe[0];
  if (open === '{' || open === '[' || open === '(') {
    // The value carries its own outer brackets: unwrap them to find a depth-0
    // for (the comprehension body); otherwise the for in `{k: 1 for k in xs}`
    // always sits at depth 1 and the comprehension goes undetected
    const inner = unwrapBracket(probe, open, open === '{' ? '}' : open === '[' ? ']' : ')');
    if (inner !== null) {
      probe = inner;
    }
  }
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < probe.length; i += 1) {
    const ch = probe[i];
    if (quote !== null) {
      if (ch === '\\') {
        i += 1;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '\'' || ch === '"') {
      quote = ch;
    } else if (ch === '[' || ch === '(' || ch === '{') {
      depth += 1;
    } else if (ch === ']' || ch === ')' || ch === '}') {
      depth -= 1;
    } else if (depth === 0 && /\bfor\b/.test(probe.slice(i, i + 4))) {
      return true;
    }
  }
  return false;
}

/** Classify a value literal (raw valueText; quotes fully visible; reused by SER-10 inline dict arguments). */
export function classifyValue(valueText: string): DictValueKind {
  const v = valueText.trim();
  if (v.length === 0) {
    return { kind: 'unknown' };
  }
  if (isQuotedLiteral(v)) {
    return { kind: 'scalar', scalar: 'str' };
  }
  if (/^-?\d+$/.test(v)) {
    return { kind: 'scalar', scalar: 'int' };
  }
  if (/^-?\d+\.\d+$/.test(v)) {
    return { kind: 'scalar', scalar: 'float' };
  }
  if (v === 'True' || v === 'False') {
    return { kind: 'scalar', scalar: 'bool' };
  }
  if (v === 'None') {
    return { kind: 'scalar', scalar: 'none' };
  }
  if (v[0] === '[') {
    if (isComprehensionValue(v)) {
      return { kind: 'list', element: null }; // comprehension list: element universe open
    }
    const inner = unwrapBracket(v, '[', ']');
    if (inner === null) {
      return { kind: 'unknown' };
    }
    const items = splitTopLevel(inner);
    if (items === null || items.length === 0) {
      return { kind: 'list', element: null };
    }
    const first = classifyValue(items[0]);
    for (const item of items.slice(1)) {
      if (!sameKind(first, classifyValue(item))) {
        return { kind: 'list', element: null }; // mixed elements → unconverged, do not guess
      }
    }
    return { kind: 'list', element: first };
  }
  if (v[0] === '(') {
    // Tuple vs parenthesized expression: (1,) / (1, 2) are tuples; (1) is
    // only a parenthesized scalar, recurse into the inner classification;
    // Python has no tuple comprehension — `(... for …)` is a generator
    // expression, not a tuple, so unknown is the honest answer (a generator
    // wrapped in a list is equivalent)
    if (isComprehensionValue(v)) {
      return { kind: 'unknown' };
    }
    const inner = unwrapBracket(v, '(', ')');
    if (inner === null) {
      return { kind: 'unknown' };
    }
    const items = splitTopLevel(inner);
    if (items === null) {
      return { kind: 'unknown' };
    }
    if (items.length >= 2) {
      const firstItem = classifyValue(items[0]);
      for (const item of items.slice(1)) {
        if (!sameKind(firstItem, classifyValue(item))) {
          return { kind: 'tuple', element: null }; // mixed elements → unconverged
        }
      }
      return { kind: 'tuple', element: firstItem };
    }
    if (inner.trim().endsWith(',')) {
      return { kind: 'tuple', element: classifyValue(items[0]) }; // trailing comma with a single element
    }
    return classifyValue(inner.trim()); // plain parenthesized expression: not a tuple
  }
  if (v[0] === '{') {
    const inner = unwrapBracket(v, '{', '}');
    if (inner === null || isComprehensionValue(v)) {
      return { kind: 'dict', dict: { kind: 'open', observed: new Map() } };
    }
    const synthesized: MatchedBraces = {
      joined: v,
      lineStarts: lineStartsOf(v),
      startLine: 0,
      startColumn: 0,
      endLine: v.split('\n').length - 1,
      endColumn: v.length
    };
    const { pairs, openUniverse } = parseDictPairs(synthesized);
    const required = new Map<string, DictValueKind>();
    const optional = new Map<string, DictValueKind>();
    let open = openUniverse;
    for (const pair of pairs) {
      if (pair.spread || pair.key === null) {
        open = true;
        continue;
      }
      required.set(pair.key, classifyValue(pair.valueText));
    }
    if (open) {
      const observed = new Map<string, DictValueKind>();
      for (const [k, val] of required) {
        observed.set(k, val);
      }
      return { kind: 'dict', dict: { kind: 'open', observed } };
    }
    return { kind: 'dict', dict: { kind: 'literal', required, optional } };
  }
  return { kind: 'unknown' };
}

/** Quoted literal (matching quotes at both ends; escaped closing quote tolerated). */
export function isQuotedLiteral(v: string): boolean {
  const q = v[0];
  if (q !== '\'' && q !== '"') {
    return false;
  }
  return v.length >= 2 && v[v.length - 1] === q;
}

/** Content inside balanced brackets (matching first/last brackets, quote-aware; unclosed → null). */
function unwrapBracket(v: string, open: string, close: string): string | null {
  if (v[0] !== open) {
    return null;
  }
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < v.length; i += 1) {
    const ch = v[i];
    if (quote !== null) {
      if (ch === '\\') {
        i += 1;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '\'' || ch === '"') {
      quote = ch;
    } else if (ch === open || ch === '{' || ch === '[') {
      depth += 1;
    } else if (ch === close || ch === '}' || ch === ']') {
      depth -= 1;
      if (depth === 0) {
        return v.slice(1, i);
      }
    }
  }
  return null;
}

/** Split on top-level commas (quote/depth-aware; a malformed quote segment is returned as-is). */
function splitTopLevel(text: string): string[] | null {
  const items: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote !== null) {
      if (ch === '\\') {
        current += text.slice(i, i + 2);
        i += 1;
        continue;
      }
      current += ch;
      if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '\'' || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '[' || ch === '(' || ch === '{') {
      depth += 1;
    } else if (ch === ']' || ch === ')' || ch === '}') {
      depth -= 1;
    }
    if (ch === ',' && depth === 0) {
      items.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  const tail = current.trim();
  if (tail.length > 0) {
    items.push(tail);
  }
  return items;
}

/** Same-value-type decision (nested dicts compared by deep equality). */
function sameKind(a: DictValueKind, b: DictValueKind): boolean {
  if (a.kind !== b.kind) {
    return false;
  }
  if (a.kind === 'scalar' && b.kind === 'scalar') {
    return a.scalar === b.scalar;
  }
  if (a.kind === 'list' && b.kind === 'list') {
    if (a.element === null || b.element === null) {
      return a.element === b.element;
    }
    return sameKind(a.element, b.element);
  }
  if (a.kind === 'tuple' && b.kind === 'tuple') {
    if (a.element === null || b.element === null) {
      return a.element === b.element;
    }
    return sameKind(a.element, b.element);
  }
  return true; // dict/unknown: identical kind is treated as consistent shape evidence
}

/** Line-start table used to synthesize MatchedBraces. */
function lineStartsOf(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\n') {
      starts.push(i + 1);
    }
  }
  return starts;
}

/**
 * Write-site sequence → final format:
 *  - An unconditional literal write site is a rebind (clears prior evidence,
 *    including conditional write sites);
 *  - An unconditional non-literal is a terminal unknown (dynamic write sites
 *    after it → open+observed);
 *  - Conditional write sites merge in; an if group with the key in every arm
 *    (group carries an else) promotes that complete key to required;
 *  - Any dynamic evidence → open.
 */
function resolveShape(
  recs: readonly WriterRec[],
  groups: ReadonlyMap<number, IfGroup>
): DictFormat | null {
  if (recs.length === 0) {
    return null;
  }
  // Group resolution: keys with hasElse and present in every arm → complete
  const completeKeys = new Set<string>();
  for (const g of groups.values()) {
    if (!g.hasElse || g.armCount < 2 || g.arms.size < g.armCount) {
      continue;
    }
    const first = g.arms.get(0);
    if (!first) {
      continue;
    }
    for (const key of first.keys()) {
      let all = true;
      for (const armKeys of g.arms.values()) {
        if (!armKeys.has(key)) {
          all = false;
          break;
        }
      }
      if (all) {
        completeKeys.add(key);
      }
    }
  }
  let recs2: WriterRec[] = [];
  let unknownBase = false;
  for (const rec of recs) {
    if (rec.rank === 'always' && !rec.dynamic && rec.unknownBase) {
      unknownBase = true;
      recs2 = [{ ...rec, rank: 'always' }];
      continue;
    }
    if (rec.rank === 'always' && !rec.dynamic && rec.rebind) {
      // Unconditional literal assignment = rebind (later incremental write sites
      // merge in and do not reset)
      unknownBase = false;
      recs2 = [{ ...rec, rank: 'always' }];
      continue;
    }
    if (rec.rank === 'always' && rec.dynamic) {
      recs2.push(rec);
      continue;
    }
    if (unknownBase && rec.rank !== 'always') {
      continue; // Conditional write sites on an unknown base: the open surface
      // already expresses them, so keys are not merged (always write sites are
      // kept: the observed key surface is the evidence carrier of an open
      // structure)
    }
    recs2.push(rec);
  }
  if (recs2.length === 0) {
    return null;
  }
  const open = recs2.some(rec => rec.dynamic) || unknownBase;
  const merged = new Map<string, { value: DictValueKind; rank: KeyRank }>();
  for (const rec of recs2) {
    for (const [key, value] of rec.keys) {
      let rank: KeyRank = rec.rank;
      if (rank === 'complete') {
        rank = completeKeys.has(key) ? 'complete' : 'maybe';
      }
      const prior = merged.get(key);
      if (!prior) {
        merged.set(key, { value, rank });
        continue;
      }
      if (RANK_ORDER[rank] > RANK_ORDER[prior.rank]) {
        merged.set(key, { value, rank });
      } else if (RANK_ORDER[rank] === RANK_ORDER[prior.rank] && !sameKind(prior.value, value)) {
        merged.set(key, { value: { kind: 'unknown' }, rank });
      }
    }
  }
  if (open) {
    const observed = new Map<string, DictValueKind>();
    for (const [key, entry] of merged) {
      observed.set(key, entry.value);
    }
    if (observed.size === 0) {
      return null; // open universe with zero observed evidence: no shape claim (a missing key is unknown)
    }
    return { kind: 'open', observed };
  }
  const required = new Map<string, DictValueKind>();
  const optional = new Map<string, DictValueKind>();
  for (const [key, entry] of merged) {
    if (entry.rank === 'always' || entry.rank === 'complete') {
      required.set(key, entry.value);
    } else {
      optional.set(key, entry.value);
    }
  }
  if (required.size === 0 && optional.size === 0) {
    return null; // only an unknown base with zero key evidence: no shape claim
  }
  return { kind: 'literal', required, optional };
}

const RANK_ORDER: Record<KeyRank, number> = { always: 2, complete: 1, maybe: 0 };
