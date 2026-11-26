import type { EntityMapping } from '../entityMapping';
import { l10nText } from '../nlsRuntime';
import {
  findPythonReceiverCalls,
  type PythonCallerFace,
  type PythonReceiverCall
} from './pythonLanguageUtils';
import { maskPythonNonCode } from './pythonLexicalMask';
import { buildRpcArgCountsFromRust } from './rpcArgCountRust';

/**
 * RPC argument-count lint (IDE-LINT-008, user order 2026-11-06; KBE-PY-009
 * diagnostic face): self.base/cell/client.<method>(...) calls are reconciled
 * by their top-level actual argument count against the .def method declaration's
 * <Arg> count; only a clear mismatch reports a Warning.
 *
 * Key contracts (consistent with the acceptance wording "star args / dynamic
 * receivers and declarations-not-ready keep unknown"):
 * - declaration not ready: the method declaration cannot be found in this
 *   entity/root mapping, or its Arg count is inconsistent across sources
 *   (same name across multiple entities/components) → unknown, not reported.
 * - section mismatch: the method is declared in another section (a call through
 *   the current receiver side cannot route to it) → reported separately by
 *   sectionMismatch, not duplicated here; only same-section declarations are
 *   reconciled by Arg count.
 * - star args: any top-level actual argument segment starting with `*`
 *   (unpacking/collecting), or a declared Arg's raw text starting with `*` →
 *   the count cannot be decided, unknown, not reported. (A top-level `a * b`
 *   binary multiplication star does not trigger — only an argument-segment's
 *   leading star counts; a star inside nested parens does not affect the outer
 *   count.)
 * - cross-line calls can be counted (bracket depth scanned across lines to the
 *   matching `)`); parens unclosed to end of file → unknown, not reported.
 *   Dynamic receivers (not self.<role>.<name> shape) are outside the discovery
 *   face anyway, naturally unknown. Inlay hints do not replace diagnostics:
 *   this face independently produces diagnostics, same data source as the inlay
 *   but a different face.
 */

/** Stable diagnostic code (B-7 discipline: quick fixes/tests reconcile by code) */
export const RPC_ARG_COUNT_DIAGNOSTIC_CODE = 'kbengine.rpcArgCount';

/** Switch default (user order: on by default, consistent with the sibling diagnostics) */
export const RPC_ARG_COUNT_DIAGNOSTICS_ENABLED_DEFAULT = true;

export interface RpcArgCountFinding {
  /** Line (0-based, the line of the method-name token) */
  line: number;
  /** Column (0-based, at the method-name token) */
  character: number;
  methodName: string;
  receiver: PythonReceiverCall['receiver'];
  /** The .def declaration's Arg count (the reconciliation baseline against the call site's actual arguments) */
  declaredCount: number;
  /** The call site's top-level actual arguments */
  actualCount: number;
  message: string;
}

const CALL_OPENER_CLOSER: Record<string, string> = { '(': ')', '[': ']', '{': '}' };

/**
 * Count the call site's top-level actual arguments; returns null when the
 * count cannot be decided (star argument / unclosed parens / other tokens
 * between the method name and '('). The input is **raw Python text** (not
 * masked) — this scan carries its own string/comment lexical state: commas,
 * parens and stars inside strings do not count, comments (# to line end) do
 * not count, a top-level comma is an argument separator; empty parens count 0;
 * a trailing comma does not over-count; scanning crosses lines from the line of
 * '(' to the matching ')' or end of file (unclosed → null). Division of labor
 * with the call-site discovery face (findPythonReceiverCalls runs on masked
 * text): the discovery face masks out fake calls, the counting face works on
 * raw text to mask out fake separators.
 */
export function countCallArguments(
  lines: readonly string[],
  call: PythonReceiverCall
): number | null {
  const nameEnd = call.character + call.methodName.length;
  const firstLine = lines[call.line] ?? '';

  // Look for '(' on the same line after the method name; another non-whitespace
  // token first → shape unclear, unknown
  let openParen = -1;
  for (let i = nameEnd; i < firstLine.length; i += 1) {
    const ch = firstLine[i];
    if (ch === '(') { openParen = i; break; }
    if (!/\s/.test(ch)) { return null; }
  }
  if (openParen === -1) { return null; }

  let count = 0;
  // bracket-closer stack: the call's own '(' is the root (not pushed); nested
  // ( [ { inside it are pushed; a ')' seen while the stack is empty is the
  // call's closing, a comma seen while the stack is empty is a top-level
  // argument separator.
  const closerStack: string[] = [];
  let atSegmentStart = true; // segment start (after a paren or comma)
  let segmentHasStar = false; // '*' at segment start → unpacking/collecting, count undecidable
  let segmentHasCode = false; // argument content seen inside the segment (before a comma)
  let inString: string | null = null; // the string's delimiter quote; null = not inside a string
  let tripleString = false;

  for (let line = call.line; line < lines.length; line += 1) {
    const text = lines[line];
    const startCol = line === call.line ? openParen + 1 : 0;
    for (let col = startCol; col < text.length; col += 1) {
      const ch = text[col];
      // string state: every character inside the quotes does not count (including
      // commas/parens/stars/comment characters)
      if (inString) {
        if (ch === '\\') { col += 1; continue; }
        if (tripleString) {
          if (text.startsWith(inString.repeat(3), col)) {
            inString = null;
            tripleString = false;
            col += 2;
          }
        } else if (ch === inString) {
          inString = null;
        }
        continue;
      }
      // a quote enters string state (the whole string is one argument's content;
      // inner commas are not expanded)
      if (ch === '"' || ch === '\'') {
        inString = ch;
        tripleString = text.startsWith(ch.repeat(3), col);
        if (closerStack.length === 0) {
          segmentHasCode = true;
          atSegmentStart = false;
        }
        if (tripleString) { col += 2; }
        continue;
      }
      // comment: to the line end (jump out of the inner loop, resume at the
      // next line)
      if (ch === '#') { break; }
      if (closerStack.length === 0) {
        if (ch === ')') {
          if (segmentHasStar) { return null; }
          if (segmentHasCode) { count += 1; }
          return count;
        }
        if (ch === ',') {
          if (segmentHasStar) { return null; }
          if (segmentHasCode) { count += 1; }
          atSegmentStart = true;
          segmentHasStar = false;
          segmentHasCode = false;
          continue;
        }
        if (ch in CALL_OPENER_CLOSER) {
          closerStack.push(CALL_OPENER_CLOSER[ch]);
          // a nested structure counts in full as one argument's content; a star
          // inside the segment does not affect the outer count
          segmentHasCode = true;
          atSegmentStart = false;
          continue;
        }
        if (ch === '*' && atSegmentStart) {
          segmentHasStar = true;
          continue;
        }
        if (!/\s/.test(ch)) {
          segmentHasCode = true;
          atSegmentStart = false;
        }
        continue;
      }
      // nesting depth >0: only tracking bracket pairing, not participating in the
      // top-level argument count
      const top = closerStack[closerStack.length - 1];
      if (ch === top) {
        closerStack.pop();
      } else if (ch in CALL_OPENER_CLOSER) {
        closerStack.push(CALL_OPENER_CLOSER[ch]);
      }
    }
  }
  return null; // '(' unclosed to end of file: shape unclear, unknown
}

/** Declaration side: in the declarations for the section of the call, whether the Arg count is uniquely determinable */
function resolveDeclaredArgCount(
  declarations: readonly { section: string; declaredArgs?: string[] }[],
  expectedSection: string
): { declaredCount: number; hasStarArg: boolean } | null {
  const matching = declarations.filter(d => d.section === expectedSection);
  if (matching.length === 0) {
    return null; // no declaration in this section: the section-mismatch face handles it, unknown here
  }
  let declaredCount: number | null = null;
  let hasStarArg = false;
  for (const declaration of matching) {
    if (declaration.declaredArgs === undefined) {
      return null; // declaration not ready (no Arg info): unknown
    }
    const argCount = declaration.declaredArgs.length;
    if (declaration.declaredArgs.some(arg => arg.trim().startsWith('*'))) {
      hasStarArg = true; // the declaration has a star parameter: variable count, unknown
    }
    if (declaredCount === null) {
      declaredCount = argCount;
    } else if (declaredCount !== argCount) {
      return null; // multiple sources in the same section disagree on Arg count: ambiguous, unknown
    }
  }
  if (declaredCount === null) {
    return null;
  }
  return { declaredCount, hasStarArg };
}

/**
 * Decision core (extracted for sharing in batch 8): the discovery face's call
 * sites + actual-argument slots (calls-order aligned, null = unknown) → the
 * semantic gate and message rendering. The sync face feeds local counts, the
 * Rust-first async face feeds Rust slots; both paths decide with zero
 * divergence.
 */
function collectRpcArgCountFindings(
  calls: readonly PythonReceiverCall[],
  mapping: EntityMapping,
  counts: ReadonlyArray<number | null>
): RpcArgCountFinding[] {
  const findings: RpcArgCountFinding[] = [];
  for (let index = 0; index < calls.length; index += 1) {
    const call = calls[index];
    const declarations = mapping.methods[call.methodName];
    if (!declarations || declarations.length === 0) {
      continue; // declaration not ready: unknown, not reported
    }
    // The target section is carried by the discovery face (a face-aware
    // discovery face has already filtered AttributeError references; with no
    // call face = the old receiver → section contract, same values)
    const expectedSection = call.section;
    const declared = resolveDeclaredArgCount(declarations, expectedSection);
    if (!declared || declared.hasStarArg) {
      continue; // out-of-section declaration / star parameter / ambiguity: unknown, not reported
    }
    // Slot alignment with calls order is guaranteed by both constructors (the
    // Rust face validates the length, the local face maps in the same order);
    // a Rust slot of null is a legal unknown, with no per-slot fallback to local
    // (whole-face discipline, partial adoption forbidden)
    const actualCount = counts[index] ?? null;
    if (actualCount === null || actualCount === declared.declaredCount) {
      continue; // unknown or equal counts: not reported
    }
    const first = declarations.find(d => d.section === expectedSection);
    const where = first ? `(${first.defFile}:${first.line + 1})` : '';
    findings.push({
      line: call.line,
      character: call.character,
      methodName: call.methodName,
      receiver: call.receiver,
      declaredCount: declared.declaredCount,
      actualCount,
      message: l10nText(
        '{receiver}.{method} argument count mismatch: .def {section} declares {declared} Arg(s), call passes {actual}{where}',
        {
          receiver: call.receiver,
          method: call.methodName,
          section: expectedSection,
          declared: declared.declaredCount,
          actual: actualCount,
          where
        }
      )
    });
  }
  return findings;
}

/**
 * Full computation: a Warning for RPC call-site actual arguments clearly
 * mismatching the .def <Arg> count. Pure function (text + in-memory mapping
 * snapshot), sync face; no mapping / no call sites yields the empty set, zero
 * extra parsing. The argument-counting face uses the local countCallArguments.
 */
export function computeRpcArgCountFindings(
  text: string,
  mapping?: EntityMapping,
  callerFace?: PythonCallerFace
): RpcArgCountFinding[] {
  if (!mapping?.methods) { return []; }
  // The same IDE-LINT-005 lexical mask: strings/comments pre-replaced by
  // whitespace, column offsets unchanged. The call-site discovery face runs on
  // the mask (removing fake calls in strings/comments); the argument-counting
  // face runs on raw text (the count carries its own lexical state, commas in
  // strings are not separators — see countCallArguments). A callerFace is given
  // → the discovery face filters AttributeError references by the per-face
  // semantics table (deep review-3).
  const masked = maskPythonNonCode(text);
  const calls = findPythonReceiverCalls(masked, callerFace);
  if (calls.length === 0) { return []; }
  const lines = text.split(/\r?\n/);
  return collectRpcArgCountFindings(
    calls,
    mapping,
    calls.map(call => countCallArguments(lines, call))
  );
}

/**
 * Rust-first async face (AUDIT-005 B2 batch 8): discovery face / semantic gate /
 * messages same as the sync face; the argument-counting face goes through
 * `$/kode/lint/analyzeRpcArgCount` (params.text = raw text — the count carries
 * its own lexical state, the discovery face's mask coordinates line up with the
 * raw text); unavailable / failed / malformed counts fall back to the local
 * count for the whole face, partial adoption forbidden. The params.text = raw
 * text contract, see rpcArgCountRust.
 */
export async function computeRpcArgCountFindingsAsync(
  text: string,
  mapping?: EntityMapping,
  callerFace?: PythonCallerFace
): Promise<RpcArgCountFinding[]> {
  if (!mapping?.methods) { return []; }
  // Discovery-face mask + per-face semantic filter (same contract as the sync
  // face); the argument-counting face's raw-text contract unchanged
  const masked = maskPythonNonCode(text);
  const calls = findPythonReceiverCalls(masked, callerFace);
  if (calls.length === 0) { return []; }
  const lines = text.split(/\r?\n/);
  const rustCounts = await buildRpcArgCountsFromRust(text, calls);
  const counts = rustCounts ?? calls.map(call => countCallArguments(lines, call));
  return collectRpcArgCountFindings(calls, mapping, counts);
}
