/**
 * readOnlyWrite diagnostics consolidated into Rust (AUDIT-005 B2 lane batch 5):
 * the TS wiring layer for `$/kode/lint/analyzeReadOnlyWrite`. Write-shape
 * classification / masked scanning / the read-only-name membership gate live
 * in Rust (readonly_write.rs, same masking and same semantics as TS); this
 * module only does: cheap pre-check (zero `self.` clues means zero output, no
 * RPC sent) -> face resolution (same source as built-in property hover:
 * directory domain first; when it cannot resolve, fetchDefFaces fetches the
 * def ownership) -> read-only name set supply
 * (getEntityBuiltinPropertiesForFace(face): the table's readonly name set;
 * the engine property table stays in TS as the single source and is not
 * passed to Rust) -> gate.runInRust -> the structure surface rendered through
 * renderRustReadOnlyWriteItems (property-table re-resolution integrity
 * check; a contradiction voids the whole face).
 * Unavailable/failed/malformed returns null and the caller (the readOnlyWrite
 * arm in diagnostics.ts) falls back to TS -- partial adoption is forbidden
 * (silently dropping the capability).
 */
import {
  getEntityBuiltinPropertiesForFace,
  resolveEntityComponentFaceFromPath,
  type EntityComponentFace
} from './entityBuiltinProperties';
import { getKodeCoreShadowGate } from './kodeCoreShadowFaces';
import {
  renderRustReadOnlyWriteItems,
  type ReadOnlyWriteDiagnosticItem
} from './readOnlyWriteDiagnostics';

const READ_ONLY_WRITE_RUST_METHOD = '$/kode/lint/analyzeReadOnlyWrite';

/**
 * Rust-first readOnlyWrite artifact: gate.runInRust runs
 * `$/kode/lint/analyzeReadOnlyWrite` and the structure surface renders
 * through renderRustReadOnlyWriteItems; no gate / non-entity script (path
 * face has no def ownership) / failure / malformed returns null (a non-entity
 * is a legitimate empty face [], the same output as the TS fallback, so no
 * empty RPC is sent).
 */
export async function buildReadOnlyWriteItemsWithRust(
  text: string,
  filePath: string,
  fetchDefFaces: () => Promise<readonly EntityComponentFace[] | null>
): Promise<ReadOnlyWriteDiagnosticItem[] | null> {
  const gate = getKodeCoreShadowGate();
  if (!gate) {
    return null;
  }
  // Face resolution (the same base and the same conventions as built-in property hover/inlay)
  const pathFace = resolveEntityComponentFaceFromPath(filePath);
  let defFaces: readonly EntityComponentFace[] | null = null;
  if (!pathFace) {
    try {
      defFaces = await fetchDefFaces();
    } catch {
      defFaces = null;
    }
  }
  const isEntityScript = pathFace !== null || (defFaces !== null && defFaces.length > 0);
  if (!isEntityScript) {
    return [];
  }
  const face = pathFace ?? (defFaces !== null && defFaces.length === 1 ? defFaces[0] : null);
  // Read-only name set = the face table's readonly set (engine property table single source stays in TS)
  const readonlyNames = getEntityBuiltinPropertiesForFace(face)
    .filter(property => property.readonly)
    .map(property => property.name);
  const response = await gate.runInRust<unknown>(READ_ONLY_WRITE_RUST_METHOD, {
    text,
    readonlyNames
  });
  if (!response.ok) {
    return null;
  }
  const items = (response.result as { items?: unknown }).items;
  if (!Array.isArray(items)) {
    return null;
  }
  return renderRustReadOnlyWriteItems(items, pathFace, defFaces);
}
