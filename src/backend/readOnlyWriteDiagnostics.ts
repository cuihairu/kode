// IDE-LINT-007: read-only write lint based on the engine property table
// (EntityBuiltinProperty) -- in entity scripts, plain assignment /
// augmented assignment / annotated assignment / del on engine built-in
// read-only properties (self.id / self.isDestroyed / self.className /
// per-face read-only items) reports a Warning; legitimately writable
// properties (self.position / self.shouldAutoBackup etc.) and same-named
// fields in plain Python (non-entity scripts) do not report.
//
// Pure logic layer, no vscode import. Entity identity and role resolution
// directly reuse the face resolution of entityBuiltinProperties
// (resolveEntityComponentFaceFromPath / resolveEntityBuiltinPropertyHit):
// the same base and the same conventions as built-in property hover / inlay,
// no invented parallel mechanism.
//
// Write-shape detection runs on the pythonLexicalMask masked text (string /
// comment content is never misread) and only accepts a standalone
// `self.<property>` as the whole write target:
//   - plain assignment      self.<property> = <value>
//   - augmented assignment  self.<property> <augop>= <value>
//   - annotated assignment  self.<property>: <type> = <value>
//   - deletion              del self.<property>
// Explicitly excluded: comparisons (==/!=/<=/>=), the walrus operator (:=,
// invalid property target), attribute continuation (self.<p>.x, not a
// rebind), subscript writes (self.<p>[i]=x, not a rebind) and arithmetic
// (self.<p> + x).
// Known boundaries (consistent with the sibling self-property lints): a
// same-named self.<p> inside a nested non-entity class is not treated
// separately (file-level entity identity resolution); the second item of
// `del (self.<p>)` / `del self.<p>, x` does not report (parenthesized /
// comma-prefixed shapes, rare).

import { maskPythonNonCode } from './pythonLexicalMask';
import { l10nText } from '../nlsRuntime';
import {
  resolveEntityBuiltinPropertyHit,
  resolveEntityComponentFaceFromPath,
  formatEntityBuiltinPropertyDetail,
  type EntityBuiltinPropertyHit,
  type EntityComponentFace
} from './entityBuiltinProperties';

export const READONLY_WRITE_DIAGNOSTIC_CODE = 'kbengine.readOnlyWrite';
export const READONLY_WRITE_DIAGNOSTICS_ENABLED_DEFAULT = true;

/** Write shape (shared by diagnostic copy and test assertions) */
export type ReadOnlyWriteKind = 'assign' | 'augmented' | 'annotated' | 'del';

const KIND_VERB: Record<ReadOnlyWriteKind, string> = {
  assign: 'plain assignment',
  augmented: 'augmented assignment',
  annotated: 'annotated assignment',
  del: 'deletion'
};

const AUGMENTED_OPS = new Set([
  '+=', '-=', '*=', '/=', '//=', '%=', '**=', '&=', '|=', '^=', '<<=', '>>=', '@='
]);

/** Single source for the message template (TS renders it; Rust only returns the structure surface) */
export function renderReadOnlyWriteMessage(propertyName: string, hit: EntityBuiltinPropertyHit, kind: ReadOnlyWriteKind): string {
  return l10nText(
    'self.{property} read-only write: {property} is an engine built-in read-only property ({detail}; {source}); {verb} would be rejected by the engine',
    {
      property: propertyName,
      detail: formatEntityBuiltinPropertyDetail(hit.face, hit.property),
      source: hit.property.source,
      verb: l10nText(KIND_VERB[kind])
    }
  );
}

/** Statement-header keywords that introduce a compound suite (one-line-body `:`) */
const COMPOUND_KEYWORDS = new Set([
  'if', 'elif', 'else', 'for', 'while', 'with', 'try', 'except', 'finally', 'def', 'class', 'match', 'case'
]);

/**
 * Whether `:` is a compound-suite colon (the body-separating colon of a
 * one-line if/for/while body). Criteria: the colon is the **first**
 * bracket-depth-0 colon within its simple statement, and that simple
 * statement starts with a compound-suite header keyword.
 * - `if self.isDestroyed: self.counter = 0` -> the colon is the first depth-0
 *   colon and the statement starts with `if` -> suite colon (the `=` in the
 *   body belongs to another statement, not an annotated assignment).
 * - `def m(self): self.x: int = 0` -> a depth-0 colon already precedes the
 *   colon of self.x (def's suite colon) -> not a suite colon but an
 *   annotation colon (correctly let through).
 * - `self.x: int = 0` -> the statement starts with `self`, not a compound
 *   keyword -> not a suite colon.
 */
function isSuiteColon(line: string, colonIndex: number): boolean {
  let depth = 0;
  let i = colonIndex - 1;
  // Scan left to the simple-statement boundary (line start or a bracket
  // depth-0 `;`); hitting a depth-0 colon along the way means our colon is
  // not the first depth-0 colon within the statement -> not a suite colon.
  while (i >= 0) {
    const ch = line[i];
    if (ch === ')' || ch === ']' || ch === '}') { depth += 1; }
    else if (ch === '(' || ch === '[' || ch === '{') { depth -= 1; }
    else if (ch === ';' && depth === 0) { break; }
    else if (ch === ':' && depth === 0) { return false; }
    i -= 1;
  }
  // Whether the first word at the statement start (line start or after `;`) is a compound keyword.
  let j = i + 1;
  while (j < line.length && (line[j] === ' ' || line[j] === '\t')) { j += 1; }
  const start = j;
  while (j < line.length && /[A-Za-z_]/.test(line[j])) { j += 1; }
  return COMPOUND_KEYWORDS.has(line.slice(start, j));
}

/** Classification of the operator following a matched `self.<name>` on the same line; null = not a write target */
function classifyWriteKindAfter(line: string, afterIndex: number): ReadOnlyWriteKind | null {
  let i = afterIndex;
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) { i += 1; }
  if (i >= line.length) { return null; }
  const c = line[i];
  if (c === '.') { return null; } // self.<p>.x: attribute continuation, not a rebind
  if (c === '[') { return null; } // self.<p>[i]=x: subscript write, not a rebind
  if (c === '=') {
    if (line[i + 1] === '=') { return null; } // comparison ==
    return 'assign'; // plain assignment =
  }
  if (c === ':') {
    if (line[i + 1] === '=') { return null; } // walrus := (invalid property target, not a write)
    // Compound-suite colon (one-line if/for/while body): a top-level `=` in
    // the body belongs to the body statement, not an annotated assignment on
    // `self.<p>` (e.g. `if self.isDestroyed: self.counter = 0`).
    if (isSuiteColon(line, i)) { return null; }
    // Annotated assignment `: <type> =`: an `=` at the same depth (bracket
    // depth 0) within the same statement (before a `;`) counts as a write
    // target; `if self.<p>:` (end of line) / slicing `d[self.<p>:2]` / dict
    // `{self.<p>: x}` all fail to find a top-level `=` -> not a write.
    let depth = 0;
    for (let j = i; j < line.length; j += 1) {
      const ch = line[j];
      if (ch === '(' || ch === '[' || ch === '{') { depth += 1; }
      else if (ch === ')' || ch === ']' || ch === '}') { depth -= 1; }
      else if (ch === ';' && depth === 0) { return null; } // statement boundary: the annotation's `=` cannot follow it
      else if (ch === '=' && depth === 0 && line[j - 1] !== '=' && line[j + 1] !== '=' && line[j + 1] !== '>') {
        return 'annotated';
      }
    }
    return null;
  }
  const two = c + (line[i + 1] ?? '');
  if (AUGMENTED_OPS.has(two)) { return 'augmented'; }
  // Three-character augmented assignment (**= //= <<= >>=): the two-character
  // prefix is not in the set, so append one more character and decide; the
  // old implementation only ever built two characters and never matched,
  // missing `self.id **= 1` and the like (found in an audit, fixed).
  if (AUGMENTED_OPS.has(two + (line[i + 2] ?? ''))) { return 'augmented'; }
  if (c === '<' || c === '>' || c === '!') { return null; } // <= >= !=
  return null; // unary/arithmetic + - * / % & | ^ @ << >> etc.: value context, not a write target
}

/** Whether the `self` on the same line is immediately preceded (across whitespace) by the whole-word `del` keyword */
function precededByDel(line: string, selfIndex: number): boolean {
  let i = selfIndex - 1;
  while (i >= 0 && (line[i] === ' ' || line[i] === '\t')) { i -= 1; }
  if (i < 0) { return false; }
  const end = i + 1;
  while (i >= 0 && /[A-Za-z_]/.test(line[i])) { i -= 1; }
  return line.slice(i + 1, end) === 'del';
}

/** One read-only write (the minimal information the diagnostic surface needs) */
export interface ReadOnlyWriteFinding {
  /** Line (0-based) */
  line: number;
  /** Start column of `self` (0-based; highlights the whole `self.<name>`) */
  character: number;
  /** Highlight length (the full length of `self.<name>`) */
  length: number;
  propertyName: string;
  kind: ReadOnlyWriteKind;
  /** Effective face (null = the 3 macro-common domains) */
  face: EntityComponentFace | null;
  hit: EntityBuiltinPropertyHit;
  message: string;
  severity: 'Warning';
  code: string;
}

/**
 * Read-only write verdict (pure function): scan the masked text for a
 * standalone `self.<property>`; a write target that hits a read-only entry
 * of the built-in property table -> Warning; writable properties and
 * non-entity scripts (no table hit) are skipped.
 * pathFace and defFaces are supplied by the caller (the same face resolution
 * source as built-in property hover).
 */
export function findReadOnlyWriteFindings(
  text: string,
  pathFace: EntityComponentFace | null,
  defFaces: readonly EntityComponentFace[] | null
): ReadOnlyWriteFinding[] {
  const masked = maskPythonNonCode(text);
  const lines = masked.split(/\r?\n/);
  const findings: ReadOnlyWriteFinding[] = [];
  const pattern = /\bself\.(\w+)\b/g;

  for (let line = 0; line < lines.length; line += 1) {
    const lineText = lines[line];
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(lineText)) !== null) {
      const propertyName = match[1];
      const selfIndex = match.index;
      const afterIndex = selfIndex + match[0].length;
      // Attribute continuation (self.<p>.x) and subscript writes
      // (self.<p>[i]=x) do not rebind `self.<p>` itself; exclude them up
      // front in all cases (the del path does not get through either --
      // del self.<p>.x deletes an attribute of the value).
      let afterFirst = afterIndex;
      while (afterFirst < lineText.length && (lineText[afterFirst] === ' ' || lineText[afterFirst] === '\t')) { afterFirst += 1; }
      if (afterFirst < lineText.length && (lineText[afterFirst] === '.' || lineText[afterFirst] === '[')) { continue; }
      let kind = classifyWriteKindAfter(lineText, afterIndex);
      if (kind === null && precededByDel(lineText, selfIndex)) {
        kind = 'del';
      }
      if (kind === null) { continue; }

      const hit = resolveEntityBuiltinPropertyHit(propertyName, pathFace, defFaces);
      if (!hit || !hit.property.readonly) { continue; }

      findings.push({
        line,
        character: selfIndex,
        length: match[0].length,
        propertyName,
        kind,
        face: hit.face,
        hit,
        severity: 'Warning',
        code: READONLY_WRITE_DIAGNOSTIC_CODE,
        message: renderReadOnlyWriteMessage(propertyName, hit, kind)
      });
    }
  }
  return findings;
}

/** Diagnostic item (pure data; the extension side converts to vscode.Diagnostic, tests stay vscode-free) */
export interface ReadOnlyWriteDiagnosticItem {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  message: string;
  severity: 'Warning';
  source: 'kbengine';
  code: string;
}

/**
 * Async entry: pathFace fixes the face by directory domain; when pathFace
 * cannot resolve it, fetchDefFaces (usually
 * entityMappingManager.getEntityComponentFacesForPythonFile) fetches the def
 * ownership face (the same source as the built-in property inlay provider),
 * falling back to null on failure (non-entity -> zero output).
 * enabled=false yields zero output.
 */
export async function readOnlyWriteDiagnosticItemsAsync(
  text: string,
  filePath: string,
  fetchDefFaces: () => Promise<readonly EntityComponentFace[] | null>,
  enabled: boolean
): Promise<ReadOnlyWriteDiagnosticItem[]> {
  if (!enabled) { return []; }
  const pathFace = resolveEntityComponentFaceFromPath(filePath);
  let defFaces: readonly EntityComponentFace[] | null = null;
  if (!pathFace) {
    try {
      defFaces = await fetchDefFaces();
    } catch {
      defFaces = null;
    }
  }
  return findReadOnlyWriteFindings(text, pathFace, defFaces).map(finding => ({
    range: {
      start: { line: finding.line, character: finding.character },
      end: { line: finding.line, character: finding.character + finding.length }
    },
    message: finding.message,
    severity: 'Warning' as const,
    source: 'kbengine' as const,
    code: finding.code
  }));
}

// ---- Rust surface (AUDIT-005 B2 lane batch 5: readOnlyWrite consolidation) ----
// `$/kode/lint/analyzeReadOnlyWrite` goes through gate.runInRust (the same
// conventions as analyzeReceiverNone / analyzePostDestroy): Rust only returns
// the structure surface (line/character/length/propertyName/kind); the
// read-only property gate is supplied by TS as the readonlyNames set (the
// readonly name set of the face table); message rendering and engine evidence
// stay in this module (l10n single source) -- the TS side re-resolves through
// resolveEntityBuiltinPropertyHit as an integrity check, and no hit / not
// read-only = semantic contradiction voiding the whole face (partial adoption
// is forbidden). Shared by the parity tests.

const KIND_SET = new Set<string>(['assign', 'augmented', 'annotated', 'del']);
const PROPERTY_NAME_PATTERN = /^[A-Za-z_]\w*$/;
const SELF_DOT_LENGTH = 'self.'.length;

/**
 * Structure-surface array -> diagnostic-surface array (property-table
 * re-resolution + message rendering); any malformed entry or property-table
 * re-resolution contradiction (no hit / not read-only) returns null (the whole
 * face is voided and the caller falls back to TS -- partial adoption is
 * forbidden). Shared by the parity tests.
 */
export function renderRustReadOnlyWriteItems(
  items: readonly unknown[],
  pathFace: EntityComponentFace | null,
  defFaces: readonly EntityComponentFace[] | null
): ReadOnlyWriteDiagnosticItem[] | null {
  const rendered: ReadOnlyWriteDiagnosticItem[] = [];
  for (const item of items) {
    if (item === null || typeof item !== 'object') {
      return null;
    }
    const record = item as Record<string, unknown>;
    if (record.code !== READONLY_WRITE_DIAGNOSTIC_CODE) {
      return null;
    }
    const kind = record.kind;
    if (typeof kind !== 'string' || !KIND_SET.has(kind)) {
      return null;
    }
    const propertyName = record.propertyName;
    if (typeof propertyName !== 'string' || !PROPERTY_NAME_PATTERN.test(propertyName)) {
      return null;
    }
    const length = record.length;
    if (typeof length !== 'number' || !Number.isInteger(length) || length !== SELF_DOT_LENGTH + propertyName.length) {
      return null;
    }
    for (const value of [record.line, record.character]) {
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
        return null;
      }
    }
    const hit = resolveEntityBuiltinPropertyHit(propertyName, pathFace, defFaces);
    if (!hit || !hit.property.readonly) {
      return null; // a name passed by the Rust read-only gate that the property table rejects = contract drift, void the whole face
    }
    const line = record.line as number;
    const character = record.character as number;
    rendered.push({
      range: {
        start: { line, character },
        end: { line, character: character + length }
      },
      message: renderReadOnlyWriteMessage(propertyName, hit, kind as ReadOnlyWriteKind),
      severity: 'Warning',
      source: 'kbengine',
      code: READONLY_WRITE_DIAGNOSTIC_CODE
    });
  }
  return rendered;
}
