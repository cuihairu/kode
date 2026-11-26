/**
 * KSEM-STRUCT-05: def property scalar-assignment range/structure validation.
 *
 * Engine true source (same as STRUCT-04, zero new tables): the datatypes.cpp
 * `DataTypes::initialize` registry is reused via CELL-08's SCALAR_FAMILIES
 * (judgeCellDataValueWithRange — the range face is exempted in the STRUCT-04
 * construction face; this face rules in full); the property's engine type is
 * taken from the def <Type> direct text / CustomTypePropertyInfo.typeName
 * verbatim — never judged from Python type names (acceptance wording).
 *
 * Definite consumption points (the assignment target resolves to an engine
 * scalar):
 * - (1) `self.<prop> = <whole-line literal>` (the def property's <Type> is an
 *   engine scalar);
 * - (2) `self.<prop>["<key>"]... = <whole-line literal>` (the key chain reuses
 *   STRUCT-02's resolveFixedDictSubscriptKey; the last key's field typeName
 *   enters the scalar table);
 * - (3) `self.<prop>[<int>] = <whole-line literal>` (array root, the element
 *   type taken from the registry's inline `of` node text).
 *
 * Pure logic layer, no vscode import. Decisions (conservative face, false
 * positives = 0 first):
 * - the RHS must be a whole single-line literal and not `{...}` (dict literals
 *   belong to the STRUCT-04 construction face; the two faces are naturally
 *   mutually exclusive by RHS shape, no duplication); names/calls/broken
 *   cross-line → unknown, no guessing;
 * - bool is an int subclass and entering int/float does not report (CELL-08
 *   same truth value); a float literal entering the int family = structure
 *   mismatch; an integer literal out of the width bounds (negative into
 *   unsigned / out of range) = range mismatch;
 * - None into an engine scalar = structure mismatch (isSameType false); None
 *   into the PYTHON family is not checked (outside the scalar table, the type
 *   cannot be inferred = honest);
 * - a scalar literal assigned to an FD-typed target (FD container / array FD
 *   element) is not guessed — container-face mismatches belong to the
 *   STRUCT-04 family boundary, this face does not overstep;
 * - mixed chains (an array element then taking a key: `self.bag[0]["x"] = ...`)
 *   are not followed — the chain state machine does not yet advance across the
 *   array segment, honestly broken (see the documentary-bounds section).
 */

import { l10nText } from '../nlsRuntime';
import type { CustomTypeInfo } from '../definitionWorkspace';
import { classifyCellDataWriteValue, judgeCellDataValueWithRange, type CellDataValueLiteral, type CellDataValueVerdict, cellDataScalarFamilyLabel } from './cellDataWriteCheck';
import { resolveFixedDictSubscriptKey, type FixedDictChainSegment } from './fixedDictSubscript';
import { findLineCommentIndex } from './globalDataIndexCore';

export const SCALAR_ASSIGN_DIAGNOSTIC_CODE = 'kbengine.scalarAssign';
export const SCALAR_ASSIGN_DIAGNOSTICS_ENABLED_DEFAULT = true;

/** One scalar-assignment mismatch. */
export interface ScalarAssignFinding {
  line: number;
  /** The RHS literal's start (0-based character column). */
  character: number;
  length: number;
  /** Mismatch face: structure = structure mismatch (None included); range = integer out of the engine scalar's bounds. */
  kind: 'structure' | 'range';
  /** The target expression (`self.health` / `self.info["uid"]` / `self.bag[0]`). */
  target: string;
  /** The expected engine scalar text (`UINT8 (int 0..255)`). */
  expected: string;
  /** The actual value-kind text (str/int/None/...). */
  actual: string;
  /** The range face: the offending integer literal text. */
  valueText: string;
  /** The declaration source segment (`Avatar.def:5` / `types.xml:10`). */
  source: string;
  message: string;
}

/** Diagnostic item (pure data; the extension side converts to vscode.Diagnostic, tests avoid the vscode dependency). */
export interface ScalarAssignDiagnosticItem {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  message: string;
  severity: 'Warning';
  source: 'kbengine';
  code: string;
}

/** def property → <Type> direct text + declaration source segment (the locator's same contract; null when unresolvable). */
export type ScalarAssignResolve = (propertyName: string) => Promise<{ typeName: string; source: string } | null>;

/** Single source of the message template (structure face). */
export function renderScalarAssignStructureMessage(
  target: string,
  expected: string,
  source: string,
  actual: string
): string {
  return l10nText(
    '{target} expects {expected} as declared in {source}; got {actual}',
    { target, expected, source, actual }
  );
}

/** Single source of the message template (range face). */
export function renderScalarAssignRangeMessage(
  target: string,
  value: string,
  expected: string,
  source: string
): string {
  return l10nText(
    '{target} value {value} is out of range for {expected} as declared in {source}',
    { target, value, expected, source }
  );
}

/** Declaration source segment (types.xml basename:line). */
function containerSource(container: CustomTypeInfo): string {
  const base = container.filePath.split(/[\\/]/).pop() ?? container.name;
  return container.line > 0 ? `${base}:${container.line}` : base;
}

/**
 * Registry-level engine scalar name ruling (the alias chain drills down in
 * place level by level, cycles bounded): an engine scalar name directly matches
 * the scalar table; a custom alias walks aliasType until an engine scalar name;
 * landing on FIXED_DICT/ARRAY/unknown/a cycle → null (not taken over). Does not
 * walk the pythonTypeStubs annotation chain — those are Python type names
 * (int/list), not engine scalar names (acceptance: never judge from Python type
 * names).
 */
function resolveEngineScalarTypeName(
  raw: string,
  customTypes: readonly CustomTypeInfo[]
): string | null {
  let current = raw.trim();
  const visited = new Set<string>();
  while (current.length > 0 && !visited.has(current)) {
    visited.add(current);
    if (cellDataScalarFamilyLabel(current)) {
      return current;
    }
    const info = customTypes.find(candidate => candidate.name === current);
    if (!info) {
      return null;
    }
    current = info.aliasType;
  }
  return null;
}

/** Assignment target: `self.<prop>` plus a list of bracket segments (string keys or integer subscripts). */
interface ScalarAssignTarget {
  prop: string;
  /** The segment list: {kind:'key',key} | {kind:'index',text} (in appearance order; text = the subscript text verbatim). */
  segments: Array<{ kind: 'key'; key: string } | { kind: 'index'; text: string }>;
  /** The RHS's first non-whitespace character column. */
  rhsColumn: number;
  rhsText: string;
}

const TARGET_LHS =
  /^(\s*)self\.([A-Za-z_]\w*)((?:\s*\[\s*(?:'([A-Za-z_]\w*)'|"([A-Za-z_]\w*)"|(\d+))\s*\])*)\s*=(?!=)(.*)$/;

/** Matches the target shape after stripping the line's comments; a non-`self.<prop>[...] = <RHS>` shape → null. */
function matchScalarAssignTarget(lineText: string): ScalarAssignTarget | null {
  const commentAt = findLineCommentIndex(lineText);
  const stripped = commentAt === -1 ? lineText : lineText.slice(0, commentAt);
  const match = TARGET_LHS.exec(stripped);
  if (!match) {
    return null;
  }
  // Bracket segments: collected one by one (string keys / integer subscripts);
  // a segment with debris fails the whole match (the regex's *) already
  // guarantees it
  const segments: ScalarAssignTarget['segments'] = [];
  const bracketBlock = match[3];
  const bracketRe = /\[\s*(?:'([A-Za-z_]\w*)'|"([A-Za-z_]\w*)"|(\d+))\s*\]/g;
  let bracketMatch: RegExpExecArray | null;
  let consumed = 0;
  while ((bracketMatch = bracketRe.exec(bracketBlock)) !== null) {
    // Only whitespace is allowed between segments: consumed length + whitespace must exactly reach the next segment
    const gap = bracketBlock.slice(consumed, bracketMatch.index);
    if (gap.trim() !== '') {
      return null;
    }
    consumed = bracketMatch.index + bracketMatch[0].length;
    segments.push(
      bracketMatch[3] !== undefined
        ? { kind: 'index', text: bracketMatch[3] }
        : { kind: 'key', key: bracketMatch[1] ?? bracketMatch[2] }
    );
  }
  if (bracketBlock.slice(consumed).trim() !== '') {
    return null;
  }
  // The `=` column is not taken from the lazy group (it would leak trailing
  // whitespace before `=` outside the group); computed with indexOf arithmetic
  const eqAt = stripped.indexOf('=', match[1].length + 'self.'.length + match[2].length);
  if (eqAt < 0) {
    return null;
  }
  let rhsColumn = eqAt + 1;
  while (rhsColumn < stripped.length && /\s/.test(stripped[rhsColumn])) {
    rhsColumn += 1;
  }
  const rhsText = stripped.slice(rhsColumn).trim();
  if (!rhsText) {
    return null;
  }
  return { prop: match[2], segments, rhsColumn, rhsText };
}

/**
 * Target engine-type ruling. Returns {typeLabel, source} entering the scalar
 * table before judging; null = not taken over (the FD container face / array FD
 * elements / a broken resolution chain / non-scalar).
 */
async function resolveTargetEngineType(
  target: ScalarAssignTarget,
  resolveSelfPropertyType: ScalarAssignResolve,
  customTypes: readonly CustomTypeInfo[],
  resolveCache: Map<string, { typeName: string; source: string } | null>
): Promise<{ typeLabel: string; source: string } | null> {
  if (!resolveCache.has(target.prop)) {
    resolveCache.set(target.prop, await resolveSelfPropertyType(target.prop));
  }
  const rootType = resolveCache.get(target.prop) ?? null;
  if (!rootType) {
    return null; // the def property is unresolvable: the target is not typed
  }

  // (1) root shape (an FD container target receiving a dict literal belongs to
  // the STRUCT-04 face; a scalar literal assigned to FD does not overstep —
  // when the alias chain lands on FIXED_DICT/ARRAY, resolveEngineScalarTypeName
  // returns null anyway)
  if (target.segments.length === 0) {
    const engineType = resolveEngineScalarTypeName(rootType.typeName, customTypes);
    if (!engineType) {
      return null;
    }
    return { typeLabel: engineType, source: rootType.source };
  }

  // (2) all-string-key chain: STRUCT-02's single resolution chain, the last key's field typeName
  if (target.segments.every(segment => segment.kind === 'key')) {
    const keys = target.segments.map(segment => (segment as { kind: 'key'; key: string }).key);
    const resolution = resolveFixedDictSubscriptKey(
      rootType.typeName,
      keys.slice(0, -1).map<FixedDictChainSegment>(key => ({
        kind: 'key', key, keyStart: 0, keyEnd: 0, form: 'subscript' as const
      })),
      keys[keys.length - 1],
      customTypes
    );
    const field = resolution?.field;
    if (!field?.typeName) {
      return null;
    }
    const container = resolution!.container;
    const engineType = resolveEngineScalarTypeName(field.typeName, customTypes);
    if (!engineType) {
      return null; // the FD/FD field is not a scalar: the construction face (STRUCT-04) or this face's boundary
    }
    return { typeLabel: engineType, source: containerSource(container) };
  }

  // (3) a single integer subscript + array root: the element type taken from the registry's inline `of` node text
  if (target.segments.length === 1 && target.segments[0].kind === 'index') {
    const arrayType = customTypes.find(
      info => info.name === rootType.typeName && info.aliasType === 'ARRAY'
    );
    const elementNode = arrayType?.structure.children.find(child => child.tag === 'of');
    const elementName = elementNode?.value.name;
    if (!elementName) {
      return null;
    }
    const engineType = resolveEngineScalarTypeName(elementName, customTypes);
    if (!engineType) {
      return null;
    }
    return { typeLabel: engineType, source: containerSource(arrayType!) };
  }

  return null; // mixed chain (an array element then taking a key): the chain state machine does not cross array segments, honestly broken
}

/**
 * Scalar-assignment scan (pure function). resolveSelfPropertyType provides the
 * def property's <Type> direct text and declaration source segment; customTypes
 * is a types.xml registry snapshot. A target that lands nowhere on an engine
 * scalar / an RHS that is not a whole literal → the empty set.
 */
export async function analyzeScalarAssignWrites(
  text: string,
  resolveSelfPropertyType: ScalarAssignResolve,
  customTypes: readonly CustomTypeInfo[]
): Promise<ScalarAssignFinding[]> {
  const lines = text.split(/\r?\n/);
  const findings: ScalarAssignFinding[] = [];
  const resolveCache = new Map<string, { typeName: string; source: string } | null>();
  for (let line = 0; line < lines.length; line += 1) {
    const target = matchScalarAssignTarget(lines[line]);
    if (!target) {
      continue;
    }
    if (target.rhsText.startsWith('{')) {
      continue; // dict literals belong to the STRUCT-04 construction face; mutually exclusive, no duplication
    }
    const resolved = await resolveTargetEngineType(target, resolveSelfPropertyType, customTypes, resolveCache);
    if (!resolved) {
      continue;
    }
    const literal: CellDataValueLiteral = classifyCellDataWriteValue(target.rhsText);
    const verdict: CellDataValueVerdict | null = judgeCellDataValueWithRange(literal, resolved.typeLabel);
    if (!verdict) {
      continue; // unknown / non-scalar: no guessing
    }
    const expected = cellDataScalarFamilyLabel(resolved.typeLabel) ?? resolved.typeLabel;
    const targetLabel = `self.${target.prop}${target.segments
      .map(segment => segment.kind === 'key'
        ? `["${(segment as { key: string }).key}"]`
        : `[${(segment as { text: string }).text}]`)
      .join('')}`;
    const message = verdict.reason === 'range'
      ? renderScalarAssignRangeMessage(targetLabel, verdict.valueText ?? '', expected, resolved.source)
      : renderScalarAssignStructureMessage(targetLabel, expected, resolved.source, verdict.actual);
    findings.push({
      line,
      character: target.rhsColumn,
      length: target.rhsText.length,
      kind: verdict.reason,
      target: targetLabel,
      expected,
      actual: verdict.actual,
      valueText: verdict.valueText ?? '',
      source: resolved.source,
      message
    });
  }
  return findings;
}

/** finding → diagnostic item (pure data; the extension side converts to vscode.Diagnostic). */
export function scalarAssignFindingToItem(finding: ScalarAssignFinding): ScalarAssignDiagnosticItem {
  return {
    range: {
      start: { line: finding.line, character: finding.character },
      end: { line: finding.line, character: finding.character + finding.length }
    },
    message: finding.message,
    severity: 'Warning',
    source: 'kbengine',
    code: SCALAR_ASSIGN_DIAGNOSTIC_CODE
  };
}
