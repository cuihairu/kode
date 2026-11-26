/**
 * Absorbing postDestroy diagnostics into Rust (AUDIT-005 B2 lane batch 4): the TS
 * wiring face for `$/kode/lint/analyzePostDestroy`. Block/destroy/early-return/access-point
 * analysis lives in Rust (post_destroy.rs; the Rust side masks the line text itself, staying
 * consistent with the TS pythonCodeLines parity), and this module only does: gate
 * availability -> the dynamic-dispatch/entity-face short circuit with the same semantics as
 * the TS fallback (declared -> [] / face indeterminate -> []) -> supplying the statement face
 * (pythonStatements is the shared upstream, and parsePythonFile is built on it too, so the
 * mask-joined text is passed straight through) -> gate.runInRust -> the structural face
 * rendered via renderRustPostDestroyItems. Unavailable/failure/malformed returns null and
 * the caller (the diagnostics.ts postDestroy arm) falls back to TS -- partial adoption is
 * forbidden (silently dropping capability).
 */
import type { EntityComponentFace } from './entityBuiltinProperties';
import { resolveEntityComponentFaceFromPath } from './entityBuiltinProperties';
import { getKodeCoreShadowGate } from './kodeCoreShadowFaces';
import { pythonStatements } from './pythonParser';
import {
  renderRustPostDestroyItems,
  type PostDestroyDiagnosticItem
} from './postDestroyDiagnostics';

const POST_DESTROY_RUST_METHOD = '$/kode/lint/analyzePostDestroy';

/**
 * Rust-first postDestroy output: gate.runInRust runs `$/kode/lint/analyzePostDestroy`,
 * and the structural face is rendered via renderRustPostDestroyItems; no gate /
 * dynamic dispatch (destroy declared in the def) / a non-entity script (the path face has no
 * def ownership) / failure / malformed shape return null by semantics, or the legal empty face
 * [] ([] produces the same output as the TS fallback and sends no RPC).
 */
export async function buildPostDestroyItemsWithRust(
  text: string,
  filePath: string,
  fetchDefFaces: () => Promise<readonly EntityComponentFace[] | null>,
  isDestroyDeclared: () => boolean
): Promise<PostDestroyDiagnosticItem[] | null> {
  const gate = getKodeCoreShadowGate();
  if (!gate) {
    return null;
  }
  // Dynamic-dispatch boundary: destroy declared in the def -> do not impersonate an engine destroy (identical to the TS fallback [], no RPC sent)
  const destroyDeclared = isDestroyDeclared();
  if (destroyDeclared) {
    return [];
  }
  // A non-entity script is not taken over (an ordinary Python class is not guessed at); an unknown role is not guessed either (identical to the TS fallback [])
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
  if (face === null) {
    return [];
  }
  // The statement face (mask-joined text) is supplied by TS; Rust only does the text analysis
  const statements = pythonStatements(text);
  const response = await gate.runInRust<unknown>(POST_DESTROY_RUST_METHOD, {
    text,
    destroyDeclared,
    statements
  });
  if (!response.ok) {
    return null;
  }
  const items = (response.result as { items?: unknown }).items;
  if (!Array.isArray(items)) {
    return null;
  }
  return renderRustPostDestroyItems(items);
}
