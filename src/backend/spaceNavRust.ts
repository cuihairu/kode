/**
 * SP-4 space navigation diagnostics absorbed into Rust (AUDIT-005 B2 lane batch 3):
 * the TS wiring face for `$/kode/lint/analyzeSpaceNav`. Pure analysis lives in
 * spaceNavDiagnostics.ts (message rendering / structural face); this module only
 * does gate.runInRust plus structural face -> diagnostic face (via
 * renderRustSpaceNavItems). Rust unavailable / failure / malformed response
 * returns null and the caller (the space navigation arm in diagnostics.ts) falls
 * back to the synchronous TS path — partial adoption is forbidden (silently
 * dropping capability).
 */
import { getKodeCoreShadowGate } from './kodeCoreShadowFaces';
import {
  renderRustSpaceNavItems,
  type SpaceNavFinding
} from './spaceNavDiagnostics';

const SPACE_NAV_RUST_METHOD = '$/kode/lint/analyzeSpaceNav';

/**
 * Rust-first space navigation findings: gate.runInRust runs
 * `$/kode/lint/analyzeSpaceNav` and the structural face is rendered through
 * renderRustSpaceNavItems; unavailable / failure / malformed returns null
 * (the caller falls back to the TS computeSpaceNavFindings).
 */
export async function buildSpaceNavItemsWithRust(
  text: string
): Promise<SpaceNavFinding[] | null> {
  const gate = getKodeCoreShadowGate();
  if (!gate) {
    return null;
  }
  const response = await gate.runInRust<unknown>(SPACE_NAV_RUST_METHOD, { text });
  if (!response.ok) {
    return null;
  }
  const items = (response.result as { items?: unknown }).items;
  if (!Array.isArray(items)) {
    return null;
  }
  return renderRustSpaceNavItems(items);
}
