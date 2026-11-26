// IDE-LINT-009: lint for misuse of engine builtin properties with a known role
// (KBE-PY-008 diagnostic face) — in an entity script, a `self.<builtin property>`
// access reports a Warning when the current role face does not register that
// property (it is registered on other faces); unknown roles and plain Python
// classes are never guessed.
//
// Pure logic layer, no vscode import. Role resolution shares the same base and
// the same ruling as the builtin-property hover/inlay
// (resolveEntityComponentFaceFromPath directory domain +
// getEntityComponentFacesForPythonFile def attribution, see
// entityBuiltinProperties §4-3); the data source reuses the same engine property
// table (getEntityBuiltinPropertiesForFace) — hover metadata and the lint share
// one source.
//
// Ruling:
//   - non-entity script (pathFace null and defFaces null) → not taken over (plain
//     Python classes are never guessed);
//   - unknown role (pathFace null and defFaces empty/multi-face ambiguous) → not
//     guessed (multi-face ambiguity only yields the macro-common 3, and those 3
//     items are registered on every face, so misuse is impossible → zero output);
//   - the current face registers the property → normal access, no report;
//   - the property is not on the current face but is registered on other faces →
//     role misuse, report a Warning (citing the registering faces as evidence);
//   - the property is registered on no face (not builtin) → falls back to
//     def/ordinary symbols, no report.
//
// Known boundaries (consistent with the sibling self-attribute lint): a same-named
// self.<p> inside a nested non-entity class is not singled out (file-level entity
// identity ruling); the role-face table for engine entity APIs (methods such as
// teleport/addTimer) is not yet built — this lint only reports misuse with
// documented evidence in the property face table; API misuse stays hint-only
// (hover/completion metadata) and does not pose as implemented; `self.<prop>` is
// single-segment only (multi-segment accesses such as self.cell.X do not
// participate — that is the EntityCall member face, owned by receiver/segment
// mismatch).

import { maskPythonNonCode } from './pythonLexicalMask';
import { l10nText } from '../nlsRuntime';
import { getKodeCoreShadowGate } from './kodeCoreShadowFaces';
import {
  getEntityBuiltinPropertiesForFace,
  resolveEntityComponentFaceFromPath,
  type EntityComponentFace
} from './entityBuiltinProperties';

export const ROLE_MISUSE_DIAGNOSTIC_CODE = 'kbengine.roleMisuse';
export const ROLE_MISUSE_DIAGNOSTICS_ENABLED_DEFAULT = true;

/** Per-face property name tables (same data source as the hover property table; when
 * face=null the macro-common 3 are registered on every face) */
export interface RoleMisuseTables {
  baseapp: readonly string[];
  cellapp: readonly string[];
  client: readonly string[];
}

/** Production face tables (TS bridges these to Rust; same single source as FACE_PROPERTY_NAMES) */
export const ROLE_MISUSE_TABLES: RoleMisuseTables = {
  baseapp: getEntityBuiltinPropertiesForFace('baseapp').map(p => p.name),
  cellapp: getEntityBuiltinPropertiesForFace('cellapp').map(p => p.name),
  client: getEntityBuiltinPropertiesForFace('client').map(p => p.name)
};

/** Face tables → per-face property sets (for the ruling; rebuilt per call, the
 * tables are small enough to ignore) */
function faceSetsOf(
  tables: RoleMisuseTables
): Record<EntityComponentFace, Set<string>> {
  return {
    baseapp: new Set(tables.baseapp),
    cellapp: new Set(tables.cellapp),
    client: new Set(tables.client)
  };
}

/** The faces registering a property (fixed order baseapp → cellapp → client) */
function facesRegistering(
  faceSets: Record<EntityComponentFace, Set<string>>,
  propertyName: string
): EntityComponentFace[] {
  return (['baseapp', 'cellapp', 'client'] as const).filter(face =>
    faceSets[face].has(propertyName)
  );
}

/**
 * Message rendering (single-source template; shared by the Rust structural face
 * and the TS fallback, zero template drift).
 * source = engine registration evidence (the source of any registering face;
 * empty = the table lacks a source).
 */
export function renderRoleMisuseMessage(
  propertyName: string,
  face: EntityComponentFace,
  registeredFaces: readonly EntityComponentFace[],
  source: string
): string {
  return l10nText(
    'self.{property} role misuse: current {face} entity has no {property} property (registered on {faces}; engine registration: {source}); {face}-side access will not hit that engine property',
    {
      property: propertyName,
      face,
      faces: registeredFaces.join('/'),
      source
    }
  );
}

/** Engine evidence for the property on any registering face (cites the registering
 * face's source; the first face suffices) */
function sourceFor(propertyName: string, faces: readonly EntityComponentFace[]): string {
  for (const face of faces) {
    const property = getEntityBuiltinPropertiesForFace(face)
      .find(item => item.name === propertyName);
    if (property) {
      return property.source;
    }
  }
  return '';
}

/** One role-misuse access (the minimum info the diagnostic face needs) */
export interface RoleMisuseFinding {
  /** Line (0-based) */
  line: number;
  /** Start column of `self` (0-based; highlights the whole `self.<name>`) */
  character: number;
  /** Highlight length (full length of `self.<name>`) */
  length: number;
  propertyName: string;
  /** The current file's role face (directory domain first; a unique def-attributed face) */
  currentFace: EntityComponentFace;
  /** The faces the property is actually registered on (the current face is not among them) */
  registeredFaces: EntityComponentFace[];
  source: string;
  message: string;
}

/**
 * The current file's role face (directory domain first; without a directory
 * domain a unique def-attributed face applies, multi-face ambiguity and
 * non-entity scripts → null, zero output). Same face ruling as the builtin
 * property hover.
 */
export function resolveRoleMisuseFace(
  pathFace: EntityComponentFace | null,
  defFaces: readonly EntityComponentFace[] | null
): EntityComponentFace | null {
  // Non-entity script: no face in the directory domain and no def attribution →
  // not taken over (plain Python classes are never guessed)
  const isEntityScript = pathFace !== null || (defFaces !== null && defFaces.length > 0);
  if (!isEntityScript) {
    return null;
  }
  return pathFace ?? (defFaces !== null && defFaces.length === 1 ? defFaces[0] : null);
}

/**
 * Role misuse ruling (pure function): scans single-segment `self.<property>` on
 * the masked text; a property registered on other faces but not on the current
 * face → Warning; non-entity scripts / unknown roles / non-builtin properties
 * are skipped.
 * pathFace and defFaces come from the caller (same face ruling as the builtin
 * property hover).
 * tables is the per-face property name table (defaults to the production tables;
 * tests may inject synthetic tables, the same source as the Rust parity checks).
 */
export function findRoleMisuseFindings(
  text: string,
  pathFace: EntityComponentFace | null,
  defFaces: readonly EntityComponentFace[] | null,
  tables: RoleMisuseTables = ROLE_MISUSE_TABLES
): RoleMisuseFinding[] {
  const face = resolveRoleMisuseFace(pathFace, defFaces);
  if (face === null) {
    return [];
  }

  const masked = maskPythonNonCode(text);
  const lines = masked.split(/\r?\n/);
  const faceSets = faceSetsOf(tables);
  const allBuiltin = new Set<string>([
    ...tables.baseapp,
    ...tables.cellapp,
    ...tables.client
  ]);
  const findings: RoleMisuseFinding[] = [];
  const pattern = /\bself\.(\w+)(?![\w.])/g;

  for (let line = 0; line < lines.length; line += 1) {
    const lineText = lines[line];
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(lineText)) !== null) {
      const propertyName = match[1];
      // Registered on the current face → normal access, no report
      if (faceSets[face].has(propertyName)) {
        continue;
      }
      // Registered on no face (non-builtin) → falls back to def/ordinary symbols, no report
      if (!allBuiltin.has(propertyName)) {
        continue;
      }
      // Builtin but absent from the current face → role misuse
      const registeredFaces = facesRegistering(faceSets, propertyName);
      const source = sourceFor(propertyName, registeredFaces);
      findings.push({
        line,
        character: match.index,
        length: match[0].length,
        propertyName,
        currentFace: face,
        registeredFaces,
        source,
        message: renderRoleMisuseMessage(propertyName, face, registeredFaces, source)
      });
    }
  }
  return findings;
}

/** Diagnostic item (pure data; the extension side converts to vscode.Diagnostic, tests avoid the vscode dependency) */
export interface RoleMisuseDiagnosticItem {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  message: string;
  severity: 'Warning';
  source: 'kbengine';
  code: string;
}

/** findings → diagnostic items (pure data; tests avoid vscode; shared by the Rust face and the TS fallback) */
export function roleMisuseFindingsToItems(
  findings: readonly RoleMisuseFinding[]
): RoleMisuseDiagnosticItem[] {
  return findings.map(finding => ({
    range: {
      start: { line: finding.line, character: finding.character },
      end: { line: finding.line, character: finding.character + finding.length }
    },
    message: finding.message,
    severity: 'Warning' as const,
    source: 'kbengine' as const,
    code: ROLE_MISUSE_DIAGNOSTIC_CODE
  }));
}

// ---- Rust face (AUDIT-005 B2 lane batch 2: roleMisuse adoption) ---------------
// `$/kode/lint/analyzeRoleMisuse` goes through gate.runInRust (the command face,
// the same ruling as analyzeTraps): Rust returns only the structural face
// (code/line/character/length + propertyName/registeredFaces); message rendering
// and engine evidence stay in TS (single template source =
// renderRoleMisuseMessage, evidence = sourceFor). When Rust is unavailable (no
// gate / serverPath not configured / call failure) or the response is malformed
// (any item missing a structural field / an l10n parameter / semantically
// contradictory), the whole face is voided and falls back to the TS sync path —
// partial adoption is forbidden (it would silently drop capability).

/** One structural-face item from Rust (the `$/kode/lint/analyzeRoleMisuse` response) */
export interface RustRoleMisuseItem {
  code: string;
  line: number;
  character: number;
  length: number;
  propertyName: string;
  registeredFaces: string[];
}

const ROLE_MISUSE_RUST_METHOD = '$/kode/lint/analyzeRoleMisuse';

const VALID_FACES = new Set<EntityComponentFace>(['baseapp', 'cellapp', 'client']);

/**
 * Structural-face array → diagnostic face (message rendering + engine evidence);
 * any malformed/semantically-contradictory item returns null (the whole face is
 * voided, the caller falls back to TS — partial adoption is forbidden). Shared by
 * the parity tests.
 * face = the current face (for the message and the contradiction checks);
 * tables = the face tables (for the non-builtin check).
 */
export function renderRustRoleMisuseItems(
  items: unknown,
  face: EntityComponentFace,
  tables: RoleMisuseTables
): RoleMisuseDiagnosticItem[] | null {
  if (!Array.isArray(items)) {
    return null;
  }
  const allBuiltin = new Set<string>([
    ...tables.baseapp,
    ...tables.cellapp,
    ...tables.client
  ]);
  const rendered: RoleMisuseDiagnosticItem[] = [];
  for (const raw of items) {
    if (typeof raw !== 'object' || raw === null) {
      return null;
    }
    const item = raw as RustRoleMisuseItem;
    if (item.code !== ROLE_MISUSE_DIAGNOSTIC_CODE) {
      return null;
    }
    if (!Number.isInteger(item.line) || item.line < 0) {
      return null;
    }
    if (!Number.isInteger(item.character) || item.character < 0) {
      return null;
    }
    if (!Number.isInteger(item.length) || item.length < 0) {
      return null;
    }
    if (typeof item.propertyName !== 'string' || item.propertyName.length === 0) {
      return null;
    }
    if (!Array.isArray(item.registeredFaces)) {
      return null;
    }
    const registeredFaces: EntityComponentFace[] = [];
    for (const rf of item.registeredFaces) {
      if (typeof rf !== 'string' || !VALID_FACES.has(rf as EntityComponentFace)) {
        return null;
      }
      registeredFaces.push(rf as EntityComponentFace);
    }
    if (registeredFaces.length === 0) {
      return null; // non-builtin (TS does not produce it), semantic contradiction → voided
    }
    if (registeredFaces.includes(face)) {
      return null; // the current face is among the registering faces (TS does not produce it), semantic contradiction → voided
    }
    if (!allBuiltin.has(item.propertyName)) {
      return null; // non-builtin (TS does not produce it), semantic contradiction → voided
    }
    const source = sourceFor(item.propertyName, registeredFaces);
    rendered.push({
      range: {
        start: { line: item.line, character: item.character },
        end: { line: item.line, character: item.character + item.length }
      },
      message: renderRoleMisuseMessage(item.propertyName, face, registeredFaces, source),
      severity: 'Warning' as const,
      source: 'kbengine' as const,
      code: ROLE_MISUSE_DIAGNOSTIC_CODE
    });
  }
  return rendered;
}

/**
 * Rust-first role-misuse output: gate.runInRust runs
 * `$/kode/lint/analyzeRoleMisuse`, the structural face is rendered by
 * renderRustRoleMisuseItems; unavailable / failure / malformed falls back to the
 * TS findRoleMisuseFindings (existing behavior unchanged).
 */
export async function buildRoleMisuseItemsWithRust(
  text: string,
  pathFace: EntityComponentFace | null,
  defFaces: readonly EntityComponentFace[] | null,
  deps: RoleMisuseComputeDeps
): Promise<RoleMisuseDiagnosticItem[]> {
  if (!deps.enabled) {
    return [];
  }
  const face = resolveRoleMisuseFace(pathFace, defFaces);
  if (face === null) {
    return [];
  }
  const gate = getKodeCoreShadowGate();
  if (gate) {
    const result = await gate.runInRust<{ items?: unknown }>(ROLE_MISUSE_RUST_METHOD, {
      text,
      face,
      facePropertyNames: {
        baseapp: deps.facePropertyNames.baseapp,
        cellapp: deps.facePropertyNames.cellapp,
        client: deps.facePropertyNames.client
      }
    });
    if (result.ok) {
      const items = renderRustRoleMisuseItems(result.result?.items, face, deps.facePropertyNames);
      if (items) {
        return items;
      }
    }
  }
  return roleMisuseFindingsToItems(
    findRoleMisuseFindings(text, pathFace, defFaces, deps.facePropertyNames)
  );
}

/** Build-time dependencies (tests may inject) */
export interface RoleMisuseComputeDeps {
  /** Face property name tables (shared by the Rust input and the TS fallback, same source as the parity checks) */
  facePropertyNames: RoleMisuseTables;
  enabled: boolean;
}

/**
 * Async entry: pathFace is resolved by directory domain; when pathFace cannot
 * decide, fetchDefFaces (usually
 * entityMappingManager.getEntityComponentFacesForPythonFile) fetches the
 * def-attributed face (same source as the builtin-property inlay provider);
 * failure falls back to null (non-entity → zero output).
 * enabled=false yields zero output. Rust-first (via buildRoleMisuseItemsWithRust),
 * TS fallback.
 */
export async function roleMisuseDiagnosticItemsAsync(
  text: string,
  filePath: string,
  fetchDefFaces: () => Promise<readonly EntityComponentFace[] | null>,
  enabled: boolean
): Promise<RoleMisuseDiagnosticItem[]> {
  if (!enabled) {
    return [];
  }
  const pathFace = resolveEntityComponentFaceFromPath(filePath);
  let defFaces: readonly EntityComponentFace[] | null = null;
  if (!pathFace) {
    try {
      defFaces = await fetchDefFaces();
    } catch {
      defFaces = null;
    }
  }
  return buildRoleMisuseItemsWithRust(text, pathFace, defFaces, {
    facePropertyNames: ROLE_MISUSE_TABLES,
    enabled
  });
}
