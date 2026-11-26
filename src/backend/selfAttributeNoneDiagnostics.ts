import { maskPythonNonCode } from './pythonLexicalMask';
import { l10nText } from '../nlsRuntime';
import { inferSelfAttributeFlow, type SelfAttributeFlowOptions } from './selfAttributeFlowTypes';

/**
 * LANG-NAR-1 semantic engine flow-sensitive narrowing (user order 2026-11-02) —
 * the diagnostic face: member accesses/method calls on user-managed attributes
 * self.<attr> (not .def-declared, not a builtin receiver) report a Warning when
 * the attribute's flow-sensitive type includes None and there is no null guard
 * (mirrors receiverNone's decision semantics: report only with None evidence,
 * and once narrowing takes effect, do not report).
 *
 * Boundary vs receiverNone: receiverNone only checks self.cell/base/client
 * (engine getters can be None); this diagnostic checks any self-managed
 * attribute — any flow type containing None (e.g. `= None` in __init__ not
 * overwritten by a later assignment, or class-level `X = None`) whose query
 * position is not narrowed reports. def-declared attributes are always
 * non-Optional under the GEN-DEF-1a/1b contract, so the flow engine has no None
 * evidence and naturally does not report (no special-casing needed).
 *
 * Pure function face (text + optional callback), zero vscode dependencies,
 * consumed by the diagnostics dispatcher both synchronously and asynchronously.
 */

export const ATTRIBUTE_NONE_DIAGNOSTICS_ENABLED_DEFAULT = true;
export const ATTRIBUTE_NONE_DIAGNOSTIC_CODE = 'kbengine.attributeNone';

/** Builtin receiver properties (receiverNone's responsibility; skipped here to avoid duplicates/contract forks) */
const BUILTIN_RECEIVERS = new Set(['cell', 'base', 'client']);

export interface SelfAttributeNoneFinding {
  /** Line (0-based, the line of the member access) */
  line: number;
  /** Column (0-based, at the member token) */
  character: number;
  attr: string;
  member: string;
  message: string;
}

/** `self.<attr>.<member>` (member access / method call; attr is not a builtin receiver) */
const SELF_MEMBER_ACCESS = /\bself\.([A-Za-z_]\w*)\.([A-Za-z_]\w*)/g;

function buildMessage(attr: string, member: string): string {
  return l10nText(
    'self.{attr} may be None: check for None before accessing/calling {member} (self-managed property, __init__/class-level declaration includes None and the current position is not narrowed)',
    { attr, member }
  );
}

/** Single-source export of the message template (shared by the Rust face rendering and the parity tests; Rust returns only the structural face) */
export const renderAttributeNoneMessage = buildMessage;

/**
 * KODE-PERF-002: a one-pass line-start offset table (one position after each
 * '\n'; line 0 starts at 0).
 * Equivalent to the old contract `slice(0, index).split('\n').length - 1` — the
 * line number = the '\n' count ('\r' stays at the line end and does not affect
 * the count; CRLF/LF give the same value); the g-regex match indexes increase
 * monotonically, so paired with a two-pointer sweep the whole thing is O(n),
 * replacing the quadratic per-match O(index) slice-split.
 */
function buildLineStarts(source: string): number[] {
  const starts: number[] = [0];
  for (let offset = 0; offset < source.length; offset += 1) {
    if (source.charCodeAt(offset) === 10) {
      starts.push(offset + 1);
    }
  }
  return starts;
}

/**
 * Full computation: self-managed-attribute member accesses without a null-guard
 * narrowing (Warning). Pure function (text + callback).
 * Flow types memoized per access by (line, attribute) — the same attribute on
 * the same access line is pushed only once.
 */
export function computeSelfAttributeNoneFindings(
  source: string,
  options?: SelfAttributeFlowOptions,
  versionKey?: string
): SelfAttributeNoneFinding[] {
  // KR-AUD-58: matching runs over the lexically masked text (comments/string
  // literals replaced by same-length whitespace, line/column offsets unchanged) —
  // matching over raw lines would misreport self.x.y mentions inside strings/
  // comments as real accesses.
  const masked = maskPythonNonCode(source);
  const lines = masked.split(/\r?\n/);
  const findings: SelfAttributeNoneFinding[] = [];
  const memo = new Map<string, boolean>();
  // KODE-PERF-002: the line-start offset table is built once; match indexes
  // increase monotonically → two-pointer advance
  const lineStarts = buildLineStarts(masked);
  let lineStartIdx = 0;
  SELF_MEMBER_ACCESS.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SELF_MEMBER_ACCESS.exec(masked)) !== null) {
    const attr = match[1];
    if (BUILTIN_RECEIVERS.has(attr)) {
      continue;
    }
    // Compute the match's 0-based line and the member column in-place
    while (lineStartIdx + 1 < lineStarts.length && lineStarts[lineStartIdx + 1] <= match.index) {
      lineStartIdx += 1;
    }
    const line = lineStartIdx;
    const member = match[2];
    // Member column = match start + the length of `self.<attr>.`
    const memberCharacter = match.index + match[0].indexOf(member);
    const key = `${line}\u0000${attr}`;
    if (!memo.has(key)) {
      // KODE-PERF-001: a version key is passed → multiple flow queries of the
      // same version share one parse.
      const flow = inferSelfAttributeFlow(lines, line, attr, options, versionKey);
      memo.set(key, flow !== null && flow.hasNone);
    }
    if (memo.get(key)) {
      findings.push({
        line,
        character: memberCharacter,
        attr,
        member,
        message: buildMessage(attr, member)
      });
    }
  }
  return findings;
}

/** Test face: diagnostic data items (no vscode dependency; the enable gate is the caller's responsibility) */
export function attributeNoneDiagnosticItems(
  source: string,
  options?: SelfAttributeFlowOptions,
  versionKey?: string
): SelfAttributeNoneFinding[] {
  return computeSelfAttributeNoneFindings(source, options, versionKey);
}

// ---- Rust lexical face (AUDIT-005 B2 lane batch 6: attributeNone adoption;
// batch 2 inlines flow evidence) ----
// `$/kode/lint/analyzeAttributeNone` goes through gate.runInRust (the same
// contract as receiverNone/postDestroy): the text input is TS-pre-masked text
// (maskPythonNonCode output, comments/strings already replaced by same-length
// whitespace) plus versionKey (passed straight into the KODE-PERF-001
// version-keyed parse cache); Rust returns the lexical structural face
// (line/character/length/attr/member, the member column keeping the
// match[0].indexOf first-occurrence semantics) plus **per-item inline flow
// facts** (flow:{types,annotation,hasNone,narrowed}, the engine
// kode-python::self_flow sharing a source with typeInlayHints, one query per
// (line, attribute)). The render side here steps back into fact validation
// (types a string array / annotation null or string / the two booleans) plus
// voiding the whole face on contradictory flow facts for the same (line,
// attribute) (partial adoption forbidden); the fallback
// computeSelfAttributeNoneFindings still self-computes in the TS engine. Shared
// by the parity tests.

const ATTRIBUTE_NAME_PATTERN = /^[A-Za-z_]\w*$/;

/**
 * Rust lexical structural face + inline flow facts → findings (the hasNone fact
 * is the ruling basis; only then report; narrowing / no-evidence culling is a
 * legal face with no report). Per-item validation: code/attr/member shape /
 * length===member.length / non-negative integers / builtin receiver (Rust
 * failing to skip it = contract drift) / the four flow fields; contradictory
 * flow facts for the same (line, attribute) → the whole face is voided and null
 * returned (the caller falls back to TS; partial adoption forbidden). Shared by
 * the parity tests.
 */
export function renderAttributeNoneRustItems(
  items: readonly unknown[]
): SelfAttributeNoneFinding[] | null {
  const memo = new Map<string, boolean>();
  const findings: SelfAttributeNoneFinding[] = [];
  for (const item of items) {
    if (item === null || typeof item !== 'object') {
      return null;
    }
    const record = item as Record<string, unknown>;
    if (record.code !== ATTRIBUTE_NONE_DIAGNOSTIC_CODE) {
      return null;
    }
    const attr = record.attr;
    if (typeof attr !== 'string' || !ATTRIBUTE_NAME_PATTERN.test(attr)) {
      return null;
    }
    const member = record.member;
    if (typeof member !== 'string' || !ATTRIBUTE_NAME_PATTERN.test(member)) {
      return null;
    }
    if (BUILTIN_RECEIVERS.has(attr)) {
      return null; // Rust failing to skip a builtin receiver = contract drift, the whole face voided
    }
    const length = record.length;
    if (typeof length !== 'number' || !Number.isInteger(length) || length !== member.length) {
      return null;
    }
    for (const value of [record.line, record.character]) {
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
        return null;
      }
    }
    const line = record.line as number;
    // batch 2: flow evidence inlined per item (same source as the Rust engine); null/malformed = contract drift, the whole face voided
    const flow = record.flow;
    if (flow === null || typeof flow !== 'object') {
      return null;
    }
    const face = flow as Record<string, unknown>;
    if (!Array.isArray(face.types) || face.types.some(entry => typeof entry !== 'string')) {
      return null;
    }
    if (face.annotation !== null && typeof face.annotation !== 'string') {
      return null;
    }
    if (typeof face.hasNone !== 'boolean' || typeof face.narrowed !== 'boolean') {
      return null;
    }
    const key = `${line}\u0000${attr}`;
    const reported = face.hasNone as boolean;
    if (memo.has(key)) {
      if (memo.get(key) !== reported) {
        // Contradictory flow facts for the same (line, attribute) = contract
        // drift, the whole face voided
        return null;
      }
    } else {
      memo.set(key, reported);
    }
    if (reported) {
      findings.push({
        line,
        character: record.character as number,
        attr,
        member,
        message: buildMessage(attr, member)
      });
    }
  }
  return findings;
}
