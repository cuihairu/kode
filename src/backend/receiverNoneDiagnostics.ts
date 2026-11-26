import type { EntityMapping } from '../entityMapping';
import { pythonScriptDomain } from '../entityMapping';
import { l10nText } from '../nlsRuntime';
import {
  PYTHON_RECEIVER_SECTIONS,
  findPythonReceiverCalls,
  pythonReceiverSectionFor,
  type PythonCallerFace,
  type PythonReceiverCall
} from './pythonLanguageUtils';
import { parsePythonFile } from './pythonParser';
import { parsePythonFileResponsive } from './pythonParserWorkerHost';
import { maskPythonNonCode } from './pythonLexicalMask';

/**
 * Diagnostics for a receiver that may be None (user order 2026-10-27, task 1):
 * self.client/self.cell/self.base are engine EntityCall getters, and they
 * return None directly once the reference is empty
 * (server/baseapp/entity.cpp:800 pyGetClientEntityCall, :750
 * pyGetCellEntityCall, cellapp/entity.cpp:74); after the player goes
 * offline/disconnects (onClientDeath, onLoseCell -> S_RELEASE) they are None.
 * kode already models Union[EntityCall, None]
 * (entityBuiltinProperties.ts), and hover / argument inlay both exist; this
 * adds the diagnostic surface: a member call / attribute access without a
 * None-check guard reports a Warning, and the same-root .def section mismatch
 * can also report (calling a method declared in ClientMethods through
 * self.cell). Guard analysis uses the in-tree pythonParser to fix method
 * bounds, with line text for the shape verdict (the same conventions as the
 * CodeLens mirror chain).
 */

export const RECEIVER_NONE_DIAGNOSTICS_ENABLED_DEFAULT = true;

/**
 * Stable diagnostic code (B-7, 2026-10-29): quick fixes and diagnostics are
 * reconciled by code (the same discipline as kbengine.unknownType) -- the
 * guard QuickFix only accepts the receiver-none code; a section mismatch is a
 * routing problem, not a None-check problem, so it produces no guard action.
 */
export const RECEIVER_NONE_DIAGNOSTIC_CODE = 'kbengine.receiverNone';
export const RECEIVER_SECTION_MISMATCH_DIAGNOSTIC_CODE = 'kbengine.sectionMismatch';

/** Engine source citations (carried with the diagnostic message, as direct evidence for "why it may be None") */
export const RECEIVER_NONE_SOURCES: Record<PythonReceiverCall['receiver'], string> = {
  client: 'server/baseapp/entity.cpp:800 pyGetClientEntityCall',
  cell: 'server/baseapp/entity.cpp:750 pyGetCellEntityCall',
  base: 'server/cellapp/entity.cpp:74 pyGetBaseEntityCall'
};

/** receiver-none message (single source: shared by the TS sync/async surfaces and the Rust structure-surface rendering) */
export function renderReceiverNoneMessage(receiver: PythonReceiverCall['receiver']): string {
  return l10nText(
    'self.{receiver} may be None (the engine returns None directly once the player goes offline/disconnects, onClientDeath/onLoseCell → S_RELEASE); check for None before use; engine source: {source}',
    { receiver, source: RECEIVER_NONE_SOURCES[receiver] }
  );
}

export interface ReceiverNoneFinding {
  /** Line, 0-based (the line of the method-name token) */
  line: number;
  /** Column, 0-based (from the method-name token) */
  character: number;
  receiver: PythonReceiverCall['receiver'];
  methodName: string;
  kind: 'receiver-none' | 'section-mismatch';
  message: string;
}

const COMMENT_ONLY = /^\s*(#.*)?$/;

const escapeSubject = (subject: string): string => subject.replace(/\./g, '\\.');
const unescapeSubject = (subject: string): string => subject.replace(/\\\./g, '.');

/**
 * IDE-LINT-002: if-header condition extraction (masked line: strings/comments
 * already blanked). Scans from after `if` to the first `:` at bracket depth
 * 0 -- colons inside code such as subscript slicing do not truncate the
 * condition.
 */
function extractIfHeader(line: string): { condition: string; bodyStart: number } | null {
  const match = /^\s*if\s+/.exec(line);
  if (!match) { return null; }
  let depth = 0;
  for (let i = match[0].length; i < line.length; i += 1) {
    const char = line[i];
    if (char === '(' || char === '[' || char === '{') { depth += 1; continue; }
    if (char === ')' || char === ']' || char === '}') { depth = Math.max(0, depth - 1); continue; }
    if (char === ':' && depth === 0) {
      return { condition: line.slice(match[0].length, i).trim(), bodyStart: i + 1 };
    }
  }
  return null;
}

/** Strip the outermost paired parentheses (for `(a) and (b)` the outer parentheses do not wrap the whole expression, so return it unchanged) */
function stripOuterParens(expr: string): string {
  let current = expr.trim();
  while (current.startsWith('(') && current.endsWith(')')) {
    let depth = 0;
    let wraps = true;
    for (let i = 0; i < current.length; i += 1) {
      if (current[i] === '(') { depth += 1; } else if (current[i] === ')') {
        depth -= 1;
        if (depth === 0 && i < current.length - 1) { wraps = false; break; }
      }
    }
    if (!wraps || depth !== 0) { break; }
    current = current.slice(1, -1).trim();
  }
  return current;
}

/**
 * USER-LINT-01 (user report 2026-11-04): the engine validator name list. The
 * KBEngine global API `kbe.isValid(entityRef)` -- a valid (non-destroyed)
 * entity reference returns True, `isValid(None)` / an invalid reference
 * returns False, so the truth of `kbe.isValid(X)` implies X can be safely
 * dereferenced; it is the engine's customary positive None-check guard. The
 * list is consolidated into this single constant table: when the engine adds
 * validators later (such as kbe.hasClient), append the qualified name here,
 * instead of scattering hardcoded names into the shape verdicts.
 */
const ENGINE_VALIDATOR_NAMES: readonly string[] = ['kbe.isValid'];

/** Escape regex literals (the subject contains the dots of `self.client`) */
const escapeRegexLiteral = (text: string): string =>
  text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Name-list validator call shape: the atom is exactly
 * `<validator>(subject)` (whitespace inside the argument is tolerated; extra
 * arguments or prefixes/suffixes do not match -- `kbe.isValid(other)` does
 * not constitute a guard for the subject).
 */
const isEngineValidatorCall = (atom: string, subject: string): boolean => {
  const pattern = new RegExp(
    `^(?:${ENGINE_VALIDATOR_NAMES.map(escapeRegexLiteral).join('|')})\\(\\s*${escapeRegexLiteral(subject)}\\s*\\)$`
  );
  return pattern.test(atom);
};

const TOP_LEVEL_AND = /^(\s+)(and)(\s|$)/;
const TOP_LEVEL_OR = /^(\s+)(or)(\s|$)/;

/** Split on and/or at the top level (bracket depth 0) -- replacing the old
 * naive string split, which was no longer mis-split by string content or
 * parentheses (strings inside a masked line are already blank; this is a
 * structural split) */
function splitTopLevel(expr: string, op: 'and' | 'or'): string[] {
  const pattern = op === 'and' ? TOP_LEVEL_AND : TOP_LEVEL_OR;
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < expr.length; i += 1) {
    const char = expr[i];
    if (char === '(' || char === '[' || char === '{') { depth += 1; continue; }
    if (char === ')' || char === ']' || char === '}') { depth = Math.max(0, depth - 1); continue; }
    if (depth === 0) {
      const rest = pattern.exec(expr.slice(i));
      if (rest) {
        parts.push(expr.slice(start, i));
        i += rest[0].length - 1;
        start = i + 1;
      }
    }
  }
  parts.push(expr.slice(start));
  return parts;
}

/**
 * IDE-LINT-002: condition boolean-semantics triage, from the subject's point
 * of view (subject is the raw, unescaped text):
 * - positive: no `or` at the top level (precedence binds `and` tighter than
 *   `or`, so a top-level `or` is uncertain); each top-level `and` clause
 *   (outer parentheses stripped) is exactly `subject` / `subject is not None`
 *   / `not (subject is None)` / the truth of an engine validator
 *   `kbe.isValid(subject)` (USER-LINT-01: truth implies the subject can be
 *   safely dereferenced);
 * - early-exit: a single atom is exactly `not subject` / `subject is None` /
 *   `not kbe.isValid(subject)` (a false validator implies the subject is
 *   invalid, and vice versa);
 * - null: an uncertain shape (keep the warning).
 */
type ConditionVerdict = 'positive' | 'early-exit' | null;

function conditionVerdict(condition: string, subject: string): ConditionVerdict {
  const expr = stripOuterParens(condition);
  if (splitTopLevel(expr, 'or').length > 1) { return null; }
  const conjuncts = splitTopLevel(expr, 'and');
  const positiveAtom = (atomRaw: string): boolean => {
    const atom = stripOuterParens(atomRaw);
    if (atom === subject || atom === `${subject} is not None`) { return true; }
    if (isEngineValidatorCall(atom, subject)) { return true; }
    // `not kbe.isValid(subject)` is the reverse direction (the block body only
    // runs when the validator is false) -> early-exit, not positive; here we
    // only accept `not (subject is None)`
    if (/^not\b/.test(atom)) { return stripOuterParens(atom.slice(3)) === `${subject} is None`; }
    return false;
  };
  if (conjuncts.length > 1) {
    return conjuncts.some(positiveAtom) ? 'positive' : null;
  }
  const atom = stripOuterParens(conjuncts[0]);
  if (positiveAtom(atom)) { return 'positive'; }
  if (/^not\b/.test(atom)) {
    const inner = stripOuterParens(atom.slice(3));
    if (inner === subject) { return 'early-exit'; }
    if (isEngineValidatorCall(inner, subject)) { return 'early-exit'; }
  }
  if (atom === `${subject} is None`) { return 'early-exit'; }
  return null;
}

/** Local receiver alias assignment: `x = self.<role>` (group 4 must be pure whitespace / an already-masked comment for the assignment to count as complete) */
const RECEIVER_ALIAS_ASSIGN =
  /^([ \t]*)([A-Za-z_]\w*)\s*=\s*self\.(cell|base|client)(.*)$/;

/** Method/class scope header (masked line; the method's own def line is excluded by the caller) */
const NESTED_SCOPE_HEADER = /^\s*(?:async\s+)?def\s|^\s*class\s/;

/** Rebinding of the target (alias name or self.<role>): plain/augmented assignment, walrus; comparisons such as `==` `<=` do not count */
const rebindPattern = (target: string): RegExp =>
  new RegExp(`\\b${target}\\s*(?:(?:\\*\\*|//|>>|<<|[-+*/%&|^])?=(?!=)|:=)`);

/** Rebinding of a name by for/del/as */
const nameRebindExtras = (name: string): RegExp =>
  new RegExp(`\\b(?:for|del|as)\\s+${name}\\b`);

interface MethodSpan {
  startLine: number;
  endLine: number;
}

interface ClassMethodSpans {
  startLine: number;
  endLine: number;
  methods: MethodSpan[];
}

function buildMethodSpans(parsed: ReturnType<typeof parsePythonFile>): ClassMethodSpans[] {
  return parsed.classes.map(cls => {
    const starts = [...cls.methods.values()].map(loc => loc.line).sort((left, right) => left - right);
    return {
      startLine: cls.startLine,
      endLine: cls.endLine,
      methods: starts.map((startLine, i) => ({
        startLine,
        endLine: i + 1 < starts.length ? starts[i + 1] - 1 : cls.endLine - 1
      }))
    };
  });
}

/** Method-body bounds (0-based lines, inclusive of the tail): keeps the original class order and reuses the pre-sorted method spans. */
function enclosingMethodSpan(classes: readonly ClassMethodSpans[], line: number): MethodSpan | undefined {
  for (const cls of classes) {
    if (line < cls.startLine || line >= cls.endLine) { continue; }
    for (let i = cls.methods.length - 1; i >= 0; i -= 1) {
      if (cls.methods[i].startLine <= line) return cls.methods[i];
    }
    return undefined;
  }
  return undefined;
}

/**
 * Whether a receiver None-check guard exists before the use line:
 * a) a positive if (`if self.cell:` / `if self.cell is not None:` / the same
 *    shape via an alias) with the use line inside its block body (deeper
 *    indentation, and no same-level dedent in between);
 * b) an early-exit if (`if not self.cell:` / `if self.cell is None:`) whose
 *    block body contains a return/raise;
 * c) a one-line if guard on the use line itself (`if self.cell:
 *    self.cell.x()`) or a ternary pre-check.
 *
 * IDE-DIA-004: the guard prefix scan is completed once per (method, receiver)
 * (scanGuardCandidates collects candidate lines + aliases in a single pass),
 * so multiple calls in the same method for the same receiver share one set of
 * candidates; each call only evaluates the positional gates, instead of
 * re-walking the method body from scratch at every call site.
 */
interface GuardCandidate {
  line: number;
  indent: number;
  kind: 'positive' | 'early-exit';
  /** The matched clause subject (escaped form): the gate checks for rebinding between (guard line, use line) */
  subject: string;
  /** Positive guard: the closing line of the if block (the first non-empty line
   * with indentation <= ifIndent; otherwise method-body bound + 1).
   * use line < blockEnd means it is still inside the block body (2026-10-28
   * audit remediation: precomputed once, so each call needs no re-scan) */
  blockEnd?: number;
  /** Early-exit guard: the first unconditional return/raise line inside the block body (0-based line; undefined if none) */
  exitLine?: number;
}

interface MethodGuardScan {
  receiver: PythonReceiverCall['receiver'];
  candidates: GuardCandidate[];
  /** Alias assignment lines and names (`x = self.<role>`); the same-line gate filters by those before the use */
  aliases: Array<{ line: number; name: string }>;
  /** Escaped subject -> table of rebinding lines (alias reassignment / for / del,
   * self.<role> attribute reassignment): a rebind between the guard and the use
   * invalidates the earlier proof (IDE-LINT-004) */
  rebinds: Map<string, number[]>;
  /** Nested def/class header lines inside the method body: a guard proof does not
   * cross a scope boundary (IDE-LINT-004) */
  nestedHeaders: number[];
}

let guardPrefixScanCount = 0;

/** Test surface: guard prefix scan count (booked per method x receiver) */
export function getGuardPrefixScanCountForTests(): number {
  return guardPrefixScanCount;
}

export function resetGuardPrefixScanCountForTests(): void {
  guardPrefixScanCount = 0;
}

/** Test surface: block probe count (number of blockContains/blockExits triggers) */
let guardBlockProbeCount = 0;

export function getGuardBlockProbeCountForTests(): number {
  return guardBlockProbeCount;
}

export function resetGuardBlockProbeCountForTests(): void {
  guardBlockProbeCount = 0;
}

/** Single-pass scan of the method body (masked lines): maintains the live
 * subject set (starting from self.<role>, appending on alias assignment),
 * records rebinding lines and nested def/class headers, and triages the
 * guard shapes by condition boolean semantics */
function scanGuardCandidates(
  lines: readonly string[],
  span: MethodSpan,
  receiver: PythonReceiverCall['receiver']
): MethodGuardScan {
  guardPrefixScanCount += 1;
  const candidates: GuardCandidate[] = [];
  const aliases: Array<{ line: number; name: string }> = [];
  const rebinds = new Map<string, number[]>();
  const nestedHeaders: number[] = [];
  const subjects: Array<{ escaped: string; plain: string }> = [
    { escaped: escapeSubject(`self.${receiver}`), plain: `self.${receiver}` }
  ];
  const aliasNames = new Set<string>();
  const nestedIndents: number[] = [];
  const recordRebind = (escaped: string, line: number): void => {
    const list = rebinds.get(escaped);
    if (list) { list.push(line); } else { rebinds.set(escaped, [line]); }
  };
  for (let j = span.startLine; j <= span.endLine; j += 1) {
    const text = lines[j];
    if (COMMENT_ONLY.test(text)) { continue; }
    const indent = indentOf(text);
    while (nestedIndents.length > 0 && indent <= nestedIndents[nestedIndents.length - 1]) {
      nestedIndents.pop();
    }
    if (j > span.startLine && NESTED_SCOPE_HEADER.test(text)) {
      nestedIndents.push(indent);
      nestedHeaders.push(j);
      continue; // a nested scope header line is itself neither a guard nor an alias line
    }
    const nested = nestedIndents.length > 0;
    if (!nested) {
      const assigned = RECEIVER_ALIAS_ASSIGN.exec(text);
      if (assigned && assigned[3] === receiver && /^\s*$/.test(assigned[4] ?? '')) {
        const name = assigned[2];
        aliases.push({ line: j, name });
        if (!aliasNames.has(name)) {
          aliasNames.add(name);
          subjects.push({ escaped: escapeSubject(name), plain: name });
        }
        continue; // an alias assignment line is itself not a guard line
      }
    }
    // Rebinding accounting (IDE-LINT-004): reassignment / for / del / as of the alias name and of the self.<role> attribute
    for (const subject of subjects) {
      const hit = rebindPattern(subject.plain).test(text)
        || (!subject.plain.startsWith('self.') && nameRebindExtras(subject.plain).test(text));
      if (hit) { recordRebind(subject.escaped, j); }
    }
    // Guard shape verdict: triage the if-header condition by boolean semantics
    // (IDE-LINT-002; an inline one-line body does not count as a block guard, a
    // positive single-line body goes through the same-line gate of
    // hasReceiverGuardFromScan)
    const header = extractIfHeader(text);
    if (!header) { continue; }
    const inlineBody = /\S/.test(text.slice(header.bodyStart));
    let positive: string | null = null;
    let early: string | null = null;
    for (const subject of subjects) {
      const verdict = conditionVerdict(header.condition, subject.plain);
      if (verdict === 'positive' && positive === null) { positive = subject.escaped; }
      if (verdict === 'early-exit' && early === null) { early = subject.escaped; }
    }
    if (inlineBody) { continue; }
    if (positive !== null) {
      candidates.push({ line: j, indent, kind: 'positive', subject: positive });
    } else if (early !== null) {
      candidates.push({ line: j, indent, kind: 'early-exit', subject: early });
    }
  }
  // 2026-10-28 audit remediation: block bounds / early-exit positions are
  // precomputed once per candidate (during the scan, counted as probes), and
  // each call only evaluates the positional gates, no longer re-scanning text
  // from the guard line (quadratic -> near linear)
  for (const candidate of candidates) {
    if (candidate.kind === 'positive') {
      candidate.blockEnd = firstDedentAfter(lines, span, candidate);
    } else {
      candidate.exitLine = firstExitAfter(lines, span, candidate);
    }
  }
  return { receiver, candidates, aliases, rebinds, nestedHeaders };
}

/** Closing line of an if block: the first non-empty line after the candidate line whose indentation is <= ifIndent; if the block runs on to the method-body bound, that bound + 1 */
function firstDedentAfter(
  lines: readonly string[],
  span: MethodSpan,
  candidate: GuardCandidate
): number {
  guardBlockProbeCount += 1;
  for (let j = candidate.line + 1; j <= span.endLine; j += 1) {
    const text = lines[j];
    if (COMMENT_ONLY.test(text)) { continue; }
    if (indentOf(text) <= candidate.indent) { return j; }
  }
  return span.endLine + 1;
}

/**
 * First unconditional return/raise line inside an if block body
 * (IDE-LINT-003): the first line of the body fixes the block indentation, and
 * the scan follows block-level statement order -- the first block-level
 * return/raise is the exit; the first block-level compound statement (a nested
 * if/for/..., whose return may not run) is uncertain; deeper indentation is a
 * continuation line / nested block and is skipped.
 * Masked lines guarantee that a return/raise inside a string or comment is
 * never misjudged.
 */
function firstExitAfter(
  lines: readonly string[],
  span: MethodSpan,
  candidate: GuardCandidate
): number | undefined {
  guardBlockProbeCount += 1;
  let bodyIndent = -1;
  for (let j = candidate.line + 1; j <= span.endLine; j += 1) {
    const text = lines[j];
    if (COMMENT_ONLY.test(text)) { continue; }
    const indent = indentOf(text);
    if (indent <= candidate.indent) { return undefined; } // the block has closed
    if (bodyIndent === -1) { bodyIndent = indent; }
    if (indent === bodyIndent) {
      if (/^\s*(?:return|raise)\b/.test(text)) { return j; }
      // A block-level compound statement (nested if/for/...): the returns after it do not guarantee that every path exits;
      // a block-level ordinary statement: executed unconditionally, keep looking further
      if (/^\s*(?:if|elif|else|for|while|try|except|finally|with|def|class|match|case)\b/.test(text)) {
        return undefined;
      }
    }
  }
  return undefined;
}

/** No subject rebinding between the guard and the use (IDE-LINT-004: reassignment invalidates the earlier proof) */
function bindingStableBetween(
  scan: MethodGuardScan,
  escapedSubject: string,
  fromLine: number,
  toLine: number
): boolean {
  const list = scan.rebinds.get(escapedSubject);
  if (!list) { return true; }
  return !list.some(line => line > fromLine && line < toLine);
}

/**
 * IDE-LINT-004: the proof window of an alias guard does not start at the
 * guard line but at the most recent receiver assignment of that name before
 * the guard -- a reassignment between the assignment and the guard means the
 * guard is no longer testing the receiver value. For self.<role> itself the
 * window is just the guard line.
 */
function proofWindowStart(scan: MethodGuardScan, candidate: GuardCandidate): number {
  const selfSubject = escapeSubject(`self.${scan.receiver}`);
  if (candidate.subject === selfSubject) { return candidate.line; }
  const name = unescapeSubject(candidate.subject);
  let start = -1;
  for (const alias of scan.aliases) {
    if (alias.name === name && alias.line < candidate.line) { start = alias.line; }
  }
  return start;
}

/** No crossing of a nested def/class boundary between the guard and the use (IDE-LINT-004) */
function crossesNestedScope(scan: MethodGuardScan, fromLine: number, toLine: number): boolean {
  return scan.nestedHeaders.some(header => header > fromLine && header < toLine);
}

/** Whether a candidate passes the gates: positional gates (block bounds / early exit already precomputed) + rebinding / cross-scope invalidation gates, with zero text re-scanning */
function hasReceiverGuardFromScan(
  lines: readonly string[],
  scan: MethodGuardScan,
  useLine: number
): boolean {
  const useIndent = indentOf(lines[useLine]);
  for (const candidate of scan.candidates) {
    if (candidate.line >= useLine) { continue; }
    if (crossesNestedScope(scan, candidate.line, useLine)) { continue; }
    const proofStart = proofWindowStart(scan, candidate);
    if (proofStart === -1
      || !bindingStableBetween(scan, candidate.subject, proofStart, useLine)
      // The alias value and the receiver attribute share a source: if self.<role> is reassigned in the meantime, the earlier proof fails too
      || !bindingStableBetween(scan, escapeSubject(`self.${scan.receiver}`), proofStart, useLine)) {
      continue;
    }
    if (candidate.kind === 'positive') {
      if (candidate.indent < useIndent && (candidate.blockEnd ?? 0) > useLine) {
        return true;
      }
    } else if (candidate.indent <= useIndent && candidate.exitLine !== undefined && candidate.exitLine < useLine) {
      return true;
    }
  }
  // Same-line guard: a one-line if (the condition judged by boolean semantics) / a ternary pre-check
  const useText = lines[useLine];
  for (const subject of scanSubjectsUpTo(scan, useLine)) {
    const header = extractIfHeader(useText);
    if (header
      && /\S/.test(useText.slice(header.bodyStart))
      && conditionVerdict(header.condition, unescapeSubject(subject)) === 'positive') {
      return true;
    }
    const sameLineTernary = new RegExp(`\\bif\\s+${subject}\\s*(is\\s+not\\s+None)?\\s+else\\b`);
    if (sameLineTernary.test(useText)) {
      return true;
    }
  }
  return false;
}

/** The subject set for the same-line gate: the receiver itself + aliases assigned before the use and not rebound */
function scanSubjectsUpTo(scan: MethodGuardScan, useLine: number): string[] {
  const subjects = [escapeSubject(`self.${scan.receiver}`)];
  for (const alias of scan.aliases) {
    if (alias.line < useLine
      && bindingStableBetween(scan, escapeSubject(alias.name), alias.line, useLine)) {
      subjects.push(escapeSubject(alias.name));
    }
  }
  return subjects;
}

/** Alias attribute use points inside the method body: `name.attr` (only counts while name is still bound to the receiver) */
const ALIAS_ATTR_USE = /\b([A-Za-z_]\w*)\.([A-Za-z_]\w*)/g;

interface AliasScope {
  indent: number;
  /** name -> receiver binding (line number); null = already rebound to another value */
  bindings: Map<string, { receiver: PythonReceiverCall['receiver']; line: number } | null>;
}

/**
 * IDE-LINT-006: collect the use points of local aliases inside the method
 * body (a single pass, masked lines, once per method span).
 * Scope-chain resolution: a nested def/class keeps its own binding table; a
 * use walks outward from the innermost scope to the first scope that binds the
 * name -- if the inner scope has an assignment (shadowing), the outer receiver
 * proof is not carried over; when the outer binding is visible through a
 * closure, report according to the outer binding. Produces call points in the
 * same shape as self.<role>.<name> (column = the attribute-name token), and
 * shares the same guard gate and section-mismatch check as direct calls.
 */
function collectAliasUseCalls(
  lines: readonly string[],
  span: MethodSpan,
  callerFace?: PythonCallerFace
): PythonReceiverCall[] {
  const calls: PythonReceiverCall[] = [];
  const scopes: AliasScope[] = [{ indent: -1, bindings: new Map() }];
  for (let j = span.startLine + 1; j <= span.endLine; j += 1) {
    const text = lines[j];
    if (COMMENT_ONLY.test(text)) { continue; }
    const indent = indentOf(text);
    while (scopes.length > 1 && indent <= scopes[scopes.length - 1].indent) {
      scopes.pop();
    }
    if (NESTED_SCOPE_HEADER.test(text)) {
      scopes.push({ indent, bindings: new Map() });
      continue;
    }
    const scope = scopes[scopes.length - 1];
    const assigned = RECEIVER_ALIAS_ASSIGN.exec(text);
    if (assigned && /^\s*$/.test(assigned[4] ?? '')) {
      scope.bindings.set(assigned[2], {
        receiver: assigned[3] as PythonReceiverCall['receiver'],
        line: j
      });
      continue;
    }
    // A rebind within this scope (plain/augmented assignment, for/del/as) invalidates the binding of that name
    for (const [name, binding] of scope.bindings) {
      if (binding === null) { continue; }
      if (rebindPattern(name).test(text) || nameRebindExtras(name).test(text)) {
        scope.bindings.set(name, null);
      }
    }
    let match: RegExpExecArray | null;
    ALIAS_ATTR_USE.lastIndex = 0;
    while ((match = ALIAS_ATTR_USE.exec(text)) !== null) {
      // Resolve outward along the scope chain: the innermost scope holding the binding of that name
      let holder: AliasScope | undefined;
      for (let s = scopes.length - 1; s >= 0; s -= 1) {
        if (scopes[s].bindings.has(match[1])) { holder = scopes[s]; break; }
      }
      const binding = holder?.bindings.get(match[1]);
      if (!binding || binding.line === j) { continue; }
      // Per-surface semantic gate (deep audit 3): when the caller surface has no
      // such role attribute (e.g. a self.cell alias on cellapp), the binding
      // source is already an AttributeError, so the use point stays out of the
      // diagnostic surface.
      const section = pythonReceiverSectionFor(callerFace, binding.receiver);
      if (section === null) { continue; }
      calls.push({
        line: j,
        character: match.index + match[0].length - match[2].length,
        receiver: binding.receiver,
        section,
        methodName: match[2],
        callerFace
      });
    }
  }
  return calls;
}

const indentOf = (line: string): number => {
  const match = /^[ \t]*/.exec(line);
  return match ? match[0].replace(/\t/g, '    ').length : 0;
};

/** .def section mismatch message (only becomes a message when the declarations are non-empty and none of them sits in the section matching the receiver; otherwise undefined) */
function sectionMismatchMessage(
  receiver: PythonReceiverCall['receiver'],
  methodName: string,
  mapping: EntityMapping
): string | undefined {
  const expected = PYTHON_RECEIVER_SECTIONS[receiver];
  const declarations = mapping.methods?.[methodName] ?? [];
  if (declarations.length === 0) { return undefined; }
  if (declarations.some(declaration => declaration.section === expected)) { return undefined; }
  const declared = [...new Set(declarations.map(declaration => declaration.section))].join('/');
  return l10nText(
    'self.{receiver}.{method} section mismatch: {method} is declared in .def {declared}; calling via {receiver} will not route to that method (use the {expected} declaration)',
    { receiver, method: methodName, declared, expected }
  );
}

/** .def section mismatch: the method is declared in the def, but not in any place within the section matching the receiver */
function sectionMismatch(call: PythonReceiverCall, mapping: EntityMapping): string | undefined {
  return sectionMismatchMessage(call.receiver, call.methodName, mapping);
}

/**
 * Full computation: receiver references without a None-check guard (Warning)
 * + .def section mismatches (Warning).
 * A pure function (text + in-memory mapping snapshot), called from the
 * diagnostic scheduler's synchronous compute surface.
 * preparsed (IDE-DIA-003): a shared parse for the same version -- either pass
 * an object directly or pass a lazy provider (invoked only once a receiver use
 * point has really passed the gates, preserving the IDE-DIA-001 semantics of
 * not parsing when there are zero use points); when provided, no side performs
 * its own full parse.
 */
export type PreparsedPythonProvider = ReturnType<typeof parsePythonFile> | (() => ReturnType<typeof parsePythonFile>);

/**
 * IDE-REV-009 async-surface provider: on top of the synchronous shapes it
 * allows fetching the parse asynchronously (such as the worker path of
 * asyncDocumentParse) and null (the shared parse is unavailable this round --
 * worker shut down / backlog cap / the version generation displaced by a
 * concurrent edit): on null the async surface aborts the round and returns
 * null, without falling back to the host's synchronous whole-file parse.
 */
export type AsyncPreparsedPythonProvider =
  | PreparsedPythonProvider
  | (() => ReturnType<typeof parsePythonFile> | null | Promise<ReturnType<typeof parsePythonFile> | null>);

/** Per-call evaluation (shared by the sync/async surfaces): guard gate verdict + section mismatch, results pushed into findings */
function appendCallFindings(
  calls: readonly PythonReceiverCall[],
  lines: readonly string[],
  methodSpans: readonly ClassMethodSpans[],
  scanFor: (span: MethodSpan, receiver: PythonReceiverCall['receiver']) => MethodGuardScan,
  mapping: EntityMapping | undefined,
  findings: ReceiverNoneFinding[]
): void {
  for (const call of calls) {
    const span = enclosingMethodSpan(methodSpans, call.line);
    if (span && !hasReceiverGuardFromScan(lines, scanFor(span, call.receiver), call.line)) {
      findings.push({
        line: call.line,
        character: call.character,
        receiver: call.receiver,
        methodName: call.methodName,
        kind: 'receiver-none',
        message: renderReceiverNoneMessage(call.receiver)
      });
    }
    if (mapping) {
      const mismatch = sectionMismatch(call, mapping);
      if (mismatch) {
        findings.push({
          line: call.line,
          character: call.character,
          receiver: call.receiver,
          methodName: call.methodName,
          kind: 'section-mismatch',
          message: mismatch
        });
      }
    }
  }
}

/** Evaluation context built from one parse (shared by the sync/async surfaces) */
interface ReceiverEvalContext {
  lines: string[];
  methodSpans: ClassMethodSpans[];
  scanFor: (span: MethodSpan, receiver: PythonReceiverCall['receiver']) => MethodGuardScan;
  /** IDE-LINT-006: local alias use points (collected once per method span over the masked text) */
  aliasUseCalls: PythonReceiverCall[];
}

/** The text appears to contain an alias assignment (a cheap pre-check deciding whether to collect alias use points) */
export const RECEIVER_ALIAS_HINT = /\b[A-Za-z_]\w*\s*=\s*self\.(?:cell|base|client)\b/;

function buildEvalContextFromParsed(
  maskedText: string,
  parsed: ReturnType<typeof parsePythonFile>,
  callerFace?: PythonCallerFace
): ReceiverEvalContext {
  const methodSpans = buildMethodSpans(parsed);
  const lines = maskedText.split(/\r?\n/);
  // IDE-DIA-004: the guard prefix scan runs once per (method span, receiver),
  // so multiple calls in the same method for the same receiver share one set of
  // candidates
  const guardScans = new Map<MethodSpan, Map<PythonReceiverCall['receiver'], MethodGuardScan>>();
  const scanFor = (span: MethodSpan, receiver: PythonReceiverCall['receiver']): MethodGuardScan => {
    let byReceiver = guardScans.get(span);
    if (!byReceiver) {
      byReceiver = new Map();
      guardScans.set(span, byReceiver);
    }
    let scan = byReceiver.get(receiver);
    if (!scan) {
      scan = scanGuardCandidates(lines, span, receiver);
      byReceiver.set(receiver, scan);
    }
    return scan;
  };
  // IDE-LINT-006: the single masked full-text scan (IDE-LINT-005) is reused for
  // call discovery and alias collection, with no per-hit re-scan
  const aliasUseCalls: PythonReceiverCall[] = [];
  if (RECEIVER_ALIAS_HINT.test(maskedText)) {
    for (const cls of methodSpans) {
      for (const span of cls.methods) {
        aliasUseCalls.push(...collectAliasUseCalls(lines, span, callerFace));
      }
    }
  }
  return { lines, methodSpans, scanFor, aliasUseCalls };
}

/** Async-surface parse evaluation (IDE-REV-009): the provider comes first
 * (lazy -- invoked only after the gates pass); without a provider the default
 * self-parse also routes through parsePythonFileResponsive (>=256KiB goes to
 * the worker, and the host never lands on a synchronous whole-file parse; below
 * the threshold the host's synchronous path matches the whole-repo
 * conventions). null = unavailable this round. */
async function resolveParsedAsync(
  text: string,
  filePath: string,
  preparsed: AsyncPreparsedPythonProvider | undefined
): Promise<ReturnType<typeof parsePythonFile> | null> {
  if (typeof preparsed === 'function') {
    return preparsed();
  }
  if (preparsed !== undefined) {
    return preparsed;
  }
  const responsive = await parsePythonFileResponsive(text, filePath, 0);
  return responsive.parsed;
}

export function computeReceiverNoneFindings(
  text: string,
  filePath: string,
  mapping?: EntityMapping,
  preparsed?: PreparsedPythonProvider
): ReceiverNoneFinding[] {
  // IDE-LINT-005: one masked pass over the whole text, shared by call discovery
  // and guard analysis (column offsets unchanged)
  const masked = maskPythonNonCode(text);
  // Per-surface semantic gate (deep audit 3): the caller surface converts from
  // the script directory domain; references lacking this role attribute on the
  // surface (base.base/cell.cell/client.client) are filtered out at the
  // discovery surface -- an AttributeError face, where neither the guard nor the
  // section reconciliation applies, matching the Rust bind_self_role nine-face
  // table
  const callerFace = pythonScriptDomain(filePath) ?? undefined;
  const baseCalls = findPythonReceiverCalls(masked, callerFace);
  if (baseCalls.length === 0 && !RECEIVER_ALIAS_HINT.test(masked)) { return []; }
  const parsed = typeof preparsed === 'function'
    ? preparsed()
    : preparsed ?? parsePythonFile(text, filePath);
  const context = buildEvalContextFromParsed(masked, parsed, callerFace);
  const findings: ReceiverNoneFinding[] = [];
  appendCallFindings(baseCalls.concat(context.aliasUseCalls), context.lines,
    context.methodSpans, context.scanFor, mapping, findings);
  return findings;
}

/** IDE-DIA-005 async chunked surface: large-file computation moves out of the synchronous entry */
export interface ReceiverNoneAsyncDeps {
  /** Number of calls processed per chunk (default 200) */
  chunkSize?: number;
  /** Yield to the host between chunks (default setTimeout 0; tests may replace it) */
  yieldToHost?: () => Promise<void>;
  /** Check between chunks: returning false aborts (the version has advanced, so the stale reply is discarded) -> the whole thing returns null */
  shouldContinue?: () => boolean;
}

const RECEIVER_NONE_CHUNK_SIZE = 200;

const yieldToHostDefault = (): Promise<void> =>
  new Promise(resolve => { setTimeout(resolve, 0); });

/**
 * Chunked async surface of computeReceiverNoneFindings: call points are split
 * into chunks of chunkSize, and the host is yielded to between chunks (the host
 * can still answer timers/requests during the computation); a false
 * shouldContinue (the version has advanced) aborts and returns null -- the
 * caller discards it, and a partial result is never produced and mistaken for
 * the full one.
 * The output matches the synchronous surface item for item (the same parse /
 * the same guard-candidate memoization).
 *
 * IDE-REV-009: parse consumption goes through the async surface
 * (resolveParsedAsync -- the provider may be async / may be null; without a
 * provider the default self-parse also routes through the worker), so the host
 * work before the first yield is only the single linear regex scan of
 * findPythonReceiverCalls (no parsing, no per-line state machine); the
 * synchronous whole-file parse window no longer exists. Once the parse lands,
 * the version is rechecked (if it advanced while waiting, abort).
 */
export async function computeReceiverNoneFindingsAsync(
  text: string,
  filePath: string,
  mapping?: EntityMapping,
  preparsed?: AsyncPreparsedPythonProvider,
  deps: ReceiverNoneAsyncDeps = {}
): Promise<ReceiverNoneFinding[] | null> {
  const chunkSize = deps.chunkSize ?? RECEIVER_NONE_CHUNK_SIZE;
  const yieldToHost = deps.yieldToHost ?? yieldToHostDefault;
  // IDE-LINT-005: one masked pass over the whole text, shared by call discovery
  // and guard analysis (column offsets unchanged)
  const masked = maskPythonNonCode(text);
  // Per-surface semantic gate (deep audit 3): the same conventions as the sync
  // surface (see computeReceiverNoneFindings)
  const callerFace = pythonScriptDomain(filePath) ?? undefined;
  const baseCalls = findPythonReceiverCalls(masked, callerFace);
  if (baseCalls.length === 0 && !RECEIVER_ALIAS_HINT.test(masked)) { return []; }
  const parsed = await resolveParsedAsync(text, filePath, preparsed);
  if (!parsed) {
    return null; // the shared parse is unavailable this round: abort, produce nothing, and do not fall back to the host's synchronous parse
  }
  if (deps.shouldContinue && !deps.shouldContinue()) {
    return null; // the version advanced while waiting for the parse: the caller discards the stale reply
  }
  const context = buildEvalContextFromParsed(masked, parsed, callerFace);
  const calls = baseCalls.concat(context.aliasUseCalls);
  const findings: ReceiverNoneFinding[] = [];
  for (let start = 0; start < calls.length; start += chunkSize) {
    if (start > 0) {
      await yieldToHost();
      if (deps.shouldContinue && !deps.shouldContinue()) {
        return null; // the version has advanced: abort; the caller discards the stale reply
      }
    }
    const end = Math.min(start + chunkSize, calls.length);
    appendCallFindings(calls.slice(start, end), context.lines, context.methodSpans,
      context.scanFor, mapping, findings);
  }
  return findings;
}

/** Diagnostic item (pure data; the extension side converts to vscode.Diagnostic, tests stay vscode-free) */
export interface ReceiverDiagnosticItem {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  message: string;
  severity: 'Warning';
  source: 'kbengine';
  /** Stable code (B-7): the QuickFix provider reconciles by this */
  code: string;
}

const findingToDiagnosticItem = (finding: ReceiverNoneFinding): ReceiverDiagnosticItem => ({
  range: {
    start: { line: finding.line, character: finding.character },
    end: { line: finding.line, character: finding.character + finding.methodName.length }
  },
  message: finding.message,
  severity: 'Warning' as const,
  source: 'kbengine' as const,
  code: finding.kind === 'receiver-none'
    ? RECEIVER_NONE_DIAGNOSTIC_CODE
    : RECEIVER_SECTION_MISMATCH_DIAGNOSTIC_CODE
});

/**
 * Early-exit guard insertion edit (B-7 pure function): inserts
 * `<indent>if not self.<receiver>:` + `<indent+1>return` before the use line.
 * The indent reuses the use line's leading whitespace verbatim (no mixing of
 * spaces with tabs); one level in = add 4 spaces for a space file, add 1 tab
 * for a tab file. The guard shape is exactly the early-exit guard family the
 * diagnostic surface recognizes, so recomputing the position after insertion
 * no longer reports. Out-of-range line numbers / empty text return null
 * (never guess).
 */
export interface ReceiverNoneGuardEdit {
  /** Insertion point (0-based line; inserted before the start of that line) */
  line: number;
  /** Inserted text (two lines, with a trailing newline) */
  text: string;
}

export function buildReceiverNoneGuardEdit(
  text: string,
  line: number,
  receiver: PythonReceiverCall['receiver']
): ReceiverNoneGuardEdit | null {
  if (!text || line < 0) {
    return null;
  }
  const lines = text.split(/\r?\n/);
  const useLine = lines[line];
  if (useLine === undefined || !useLine.trim()) {
    return null;
  }
  const leading = /^[ \t]*/.exec(useLine)?.[0] ?? '';
  const inner = leading.includes('\t') ? `${leading}\t` : `${leading}    `;
  return {
    line,
    text: `${leading}if not self.${receiver}:\n${inner}return\n`
  };
}

/**
 * Wrapping guard replacement edit (user order 2026-10-30):
 * `if self.<receiver>:` (truthiness test) wraps the current statement and the
 * following same-level block, indents the whole thing by one level, and
 * continues -- the user's words: the common operation is to continue after
 * checking for non-None, whereas the early-exit `if not x: return` is the
 * uncommon one, so the wrapping form is the preferred one.
 * The edit = a Range replacement of [startLine, endLine): the original
 * `if self.<receiver>:` line + every line inside the block indented one level
 * overall (leading verbatim spaces/tabs not mixed; same-level and deeper lines
 * all go in one level, keeping relative depth). The block bound = the first
 * non-empty, non-comment line whose indentation is lower than the use line's
 * (if the block runs on, the end of the text).
 * Out-of-range line numbers / empty text / the use line being blank return
 * null (never guess).
 */
export interface ReceiverNoneWrapEdit {
  /** Replacement start line (0-based, inclusive) */
  startLine: number;
  /** Replacement end line (0-based, exclusive; the block-closing line / end of text) */
  endLine: number;
  /** Replacement text (lines inside the block already indented one level, with the `if` header line first; no trailing newline at end of text) */
  text: string;
}

export function buildReceiverNoneWrapEdit(
  text: string,
  line: number,
  receiver: PythonReceiverCall['receiver']
): ReceiverNoneWrapEdit | null {
  if (!text || line < 0) {
    return null;
  }
  const lines = text.split(/\r?\n/);
  const useLine = lines[line];
  if (useLine === undefined || !useLine.trim()) {
    return null;
  }
  const leading = /^[ \t]*/.exec(useLine)?.[0] ?? '';
  const inner = leading.includes('\t') ? `${leading}\t` : `${leading}    `;
  const useIndent = indentOf(useLine);
  // 2026-10-30 user feedback: the wrapping form must not roll the entire
  // following same-level block into itself -- wrap only "the consecutive
  // statements that use this receiver" (together with their multi-line
  // continuations), truncating at the first same-level statement that does not
  // reference this receiver, so unrelated statements (such as a later
  // self.base.notify()) are never indented by mistake.
  const receiverPattern = new RegExp(`\\bself\\.${receiver}\\b`);
  let end = line + 1;
  let balance = delimiterDelta(useLine);
  while (end < lines.length) {
    const current = lines[end];
    if (COMMENT_ONLY.test(current) || !current.trim()) {
      // Inside a multi-line statement continuation (unclosed brackets) a blank line / comment does not break it; otherwise the statement group ends
      if (balance > 0) {
        end += 1;
        continue;
      }
      break;
    }
    if (indentOf(current) < useIndent) {
      break;
    }
    // A continuation (balance>0, brackets unclosed) or a reference to this receiver -> include; otherwise the statement group ends
    if (!receiverPattern.test(current) && balance <= 0) {
      break;
    }
    balance += delimiterDelta(current);
    end += 1;
  }
  const body = lines.slice(line, end).map(entry => {
    if (COMMENT_ONLY.test(entry) || !entry.trim()) {
      return entry;
    }
    return `${inner}${entry.slice(leading.length)}`;
  });
  return {
    startLine: line,
    endLine: end,
    text: [`${leading}if self.${receiver}:`, ...body].join('\n')
  };
}

/** Tally the unclosed-bracket delta on the line (continuation verdict: >0 means the statement continues on the next line) */
function delimiterDelta(line: string): number {
  let delta = 0;
  for (const char of line) {
    if (char === '(' || char === '[' || char === '{') {
      delta += 1;
    } else if (char === ')' || char === ']' || char === '}') {
      delta -= 1;
    }
  }
  return delta;
}

/** Switch gate: enabled=false yields zero output (user order: the config switch defaults to on and can be turned off, severity=Warning) */
export function receiverNoneDiagnosticItems(
  text: string,
  filePath: string,
  mapping: EntityMapping | undefined,
  enabled: boolean,
  preparsed?: PreparsedPythonProvider
): ReceiverDiagnosticItem[] {
  if (!enabled) {
    return [];
  }
  return computeReceiverNoneFindings(text, filePath, mapping, preparsed).map(findingToDiagnosticItem);
}

/** IDE-DIA-005 async surface: chunked computation + abort returns null (a stale-version reply is discarded).
 * IDE-REV-009: preparsed is widened to an async provider (the shared parse goes
 * through asyncDocumentParse's worker path; null = unavailable this round,
 * aborting the whole thing) */
export async function receiverNoneDiagnosticItemsAsync(
  text: string,
  filePath: string,
  mapping: EntityMapping | undefined,
  enabled: boolean,
  preparsed?: AsyncPreparsedPythonProvider,
  deps: ReceiverNoneAsyncDeps = {}
): Promise<ReceiverDiagnosticItem[] | null> {
  if (!enabled) {
    return [];
  }
  const findings = await computeReceiverNoneFindingsAsync(text, filePath, mapping, preparsed, deps);
  return findings === null ? null : findings.map(findingToDiagnosticItem);
}

// ---- Rust surface (AUDIT-005 B2 lane batch 3: receiverNone consolidation) ----
// `$/kode/lint/analyzeReceiverNone` goes through gate.runInRust (the same
// conventions as analyzeSpaceNav / analyzeRoleMisuse): Rust only returns the
// structure surface (code/line/character/length + kind/receiver/methodName),
// message rendering stays in this module (l10n single source); the section
// mismatch's declared list is recomputed on the TS side from the same mapping
// snapshot -- a recomputation that does not constitute a mismatch = semantic
// contradiction, so the whole face is voided and it falls back to TS (partial
// adoption is forbidden).

/** One Rust structure-surface product (a `$/kode/lint/analyzeReceiverNone` reply) */
export interface ReceiverNoneRustItem {
  code: string;
  line: number;
  character: number;
  length: number;
  /** Message discriminator: receiverNone | sectionMismatch */
  kind: string;
  /** client | cell | base (used by both the message and the section mismatch recomputation) */
  receiver: string;
  methodName: string;
}

/** One structure-surface entry -> diagnostic surface (message rendering); missing fields / unknown kind / contract drift = malformed */
function renderRustReceiverNoneItem(
  item: ReceiverNoneRustItem,
  mapping: EntityMapping | undefined
): ReceiverDiagnosticItem | null {
  if (
    !item
    || typeof item.code !== 'string'
    || typeof item.kind !== 'string'
    || typeof item.line !== 'number'
    || typeof item.character !== 'number'
    || typeof item.length !== 'number'
    || typeof item.receiver !== 'string'
    || typeof item.methodName !== 'string'
    || item.methodName.length === 0
  ) {
    return null;
  }
  const receiver = item.receiver as PythonReceiverCall['receiver'];
  if (!(receiver in RECEIVER_NONE_SOURCES)) {
    return null;
  }
  if (
    !Number.isInteger(item.line) || !Number.isInteger(item.character) || !Number.isInteger(item.length)
    || item.line < 0 || item.character < 0 || item.length < 0
    || item.length !== item.methodName.length
  ) {
    return null;
  }
  if (item.kind === 'receiverNone') {
    if (item.code !== RECEIVER_NONE_DIAGNOSTIC_CODE) {
      return null;
    }
    return {
      range: {
        start: { line: item.line, character: item.character },
        end: { line: item.line, character: item.character + item.length }
      },
      message: renderReceiverNoneMessage(receiver),
      severity: 'Warning' as const,
      source: 'kbengine' as const,
      code: RECEIVER_NONE_DIAGNOSTIC_CODE
    };
  }
  if (item.kind === 'sectionMismatch') {
    if (item.code !== RECEIVER_SECTION_MISMATCH_DIAGNOSTIC_CODE) {
      return null;
    }
    if (!mapping) {
      return null; // without a mapping a section mismatch entry is impossible (contract drift)
    }
    const message = sectionMismatchMessage(receiver, item.methodName, mapping);
    if (!message) {
      return null; // it does not constitute a mismatch under the TS mapping = semantic contradiction, void the whole face
    }
    return {
      range: {
        start: { line: item.line, character: item.character },
        end: { line: item.line, character: item.character + item.length }
      },
      message,
      severity: 'Warning' as const,
      source: 'kbengine' as const,
      code: RECEIVER_SECTION_MISMATCH_DIAGNOSTIC_CODE
    };
  }
  return null;
}

/**
 * Structure-surface array -> diagnostic-surface array (message rendering); any
 * malformed entry returns null (the whole face is voided and the caller falls
 * back to TS -- partial adoption is forbidden). Shared by the parity tests.
 */
export function renderRustReceiverNoneItems(
  items: readonly unknown[],
  mapping: EntityMapping | undefined
): ReceiverDiagnosticItem[] | null {
  const rendered: ReceiverDiagnosticItem[] = [];
  for (const item of items) {
    const renderedItem = renderRustReceiverNoneItem(item as ReceiverNoneRustItem, mapping);
    if (!renderedItem) {
      return null;
    }
    rendered.push(renderedItem);
  }
  return rendered;
}
