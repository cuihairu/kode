/**
 * propertyDirection diagnostics absorbed into Rust (AUDIT-005 B2 lane batch 7):
 * the TS wiring face of `$/kode/lint/analyzePropertyDirection`. The three
 * lexical scans (self.<path> accesses / def __init__ assignments + cellData
 * copy keys / cellData key accesses, all on the verbatim text) live in Rust;
 * **both the shadow and cellData streams are fully preserved** — the ruling
 * core (direction classification / shadow suppression / two-stream
 * dispatch) plus def resolution and message rendering all stay in TS as the
 * single source, while Rust only supplies the scan bundle (same shape as the
 * local scanBundleOf), zero divergence in the ruling core. Zero `self.`
 * clues return a legitimate empty bundle without issuing an RPC;
 * failure/malformed shapes return null (the caller falls back to the local
 * scan bundle) — partial adoption is forbidden (it silently drops
 * capability).
 */
import { getKodeCoreShadowGate } from './kodeCoreShadowFaces';
import {
  scanBundleOf,
  type InitAssignedSelfProperties,
  type InitAssignmentSite,
  type PropertyDirectionScanBundle
} from './propertyDirectionDiagnostics';
import type { CellDataKeyAccess } from './propertyDirectionDiagnostics';
import type { PythonSelfPropertyAccess } from './propertyCodeLens';

const PROPERTY_DIRECTION_RUST_METHOD = '$/kode/lint/analyzePropertyDirection';

const PATH_PATTERN = /^\w+(?:\.\w+)*$/;
const NAME_PATTERN = /^\w+$/;
const KEY_PATTERN = /^[^"'\])]+$/;

const emptyBundle = (): PropertyDirectionScanBundle => ({
  accesses: [],
  initAssigned: { names: new Set(), sites: new Map(), cellDataCopyKeys: new Map() },
  cellDataAccesses: []
});

/** Non-negative integer check; true means malformed */
const badInt = (value: unknown): boolean =>
  typeof value !== 'number' || !Number.isInteger(value) || value < 0;

/** Rust scan bundle → local same-shape bundle; any malformed face returns null (the whole face is void, never partially adopted) */
function convertScanBundle(raw: unknown): PropertyDirectionScanBundle | null {
  if (raw === null || typeof raw !== 'object') {
    return null;
  }
  const scan = raw as Record<string, unknown>;
  const accesses: PythonSelfPropertyAccess[] = [];
  const rawAccesses = scan.accesses;
  if (!Array.isArray(rawAccesses)) {
    return null;
  }
  for (const item of rawAccesses) {
    if (item === null || typeof item !== 'object') {
      return null;
    }
    const record = item as Record<string, unknown>;
    const fullPath = record.fullPath;
    if (typeof fullPath !== 'string' || !PATH_PATTERN.test(fullPath)) {
      return null;
    }
    if (badInt(record.line) || badInt(record.character)) {
      return null;
    }
    accesses.push({
      line: record.line as number,
      character: record.character as number,
      rootSymbol: fullPath.split('.')[0],
      fullPath
    });
  }
  const rawNames = scan.initNames;
  if (!Array.isArray(rawNames)) {
    return null;
  }
  const names = new Set<string>();
  for (const name of rawNames) {
    if (typeof name !== 'string' || !NAME_PATTERN.test(name)) {
      return null;
    }
    names.add(name);
  }
  const sites = new Map<string, InitAssignmentSite>();
  const rawSites = scan.initSites;
  if (!Array.isArray(rawSites)) {
    return null;
  }
  for (const item of rawSites) {
    if (item === null || typeof item !== 'object') {
      return null;
    }
    const record = item as Record<string, unknown>;
    const name = record.name;
    if (typeof name !== 'string' || !NAME_PATTERN.test(name)) {
      return null;
    }
    if (badInt(record.line) || badInt(record.character)) {
      return null;
    }
    sites.set(name, { line: record.line as number, character: record.character as number });
  }
  const cellDataCopyKeys = new Map<string, string>();
  const rawKeys = scan.initCellDataKeys;
  if (!Array.isArray(rawKeys)) {
    return null;
  }
  for (const item of rawKeys) {
    if (item === null || typeof item !== 'object') {
      return null;
    }
    const record = item as Record<string, unknown>;
    const name = record.name;
    const key = record.key;
    if (typeof name !== 'string' || !NAME_PATTERN.test(name)) {
      return null;
    }
    if (typeof key !== 'string' || key === '' || !KEY_PATTERN.test(key)) {
      return null;
    }
    cellDataCopyKeys.set(name, key);
  }
  const cellDataAccesses: CellDataKeyAccess[] = [];
  const rawCellData = scan.cellDataAccesses;
  if (!Array.isArray(rawCellData)) {
    return null;
  }
  for (const item of rawCellData) {
    if (item === null || typeof item !== 'object') {
      return null;
    }
    const record = item as Record<string, unknown>;
    const key = record.key;
    if (typeof key !== 'string' || key === '' || !KEY_PATTERN.test(key)) {
      return null;
    }
    if (badInt(record.line) || badInt(record.character) || badInt(record.length) || badInt(record.accessEnd)) {
      return null;
    }
    cellDataAccesses.push({
      line: record.line as number,
      character: record.character as number,
      length: record.length as number,
      accessEnd: record.accessEnd as number,
      key
    });
  }
  const initAssigned: InitAssignedSelfProperties = { names, sites, cellDataCopyKeys };
  return { accesses, initAssigned, cellDataAccesses };
}

/**
 * Rust-first scan bundle: gate.runInRust runs
 * `$/kode/lint/analyzePropertyDirection`, and the structured bundle goes
 * through convertScanBundle into the local same shape (the bundle argument of
 * the callers propertyDirectionDiagnosticItemsAsync /
 * propertyDirectionShadowHintItemsAsync, so the ruling core and the fallback
 * share exactly one copy); no gate / zero clues / failure / malformed shape
 * returns null (zero clues is a legitimate empty bundle, no RPC fired
 * blindly).
 */
export async function buildPropertyDirectionScanBundleWithRust(
  text: string
): Promise<PropertyDirectionScanBundle | null> {
  const gate = getKodeCoreShadowGate();
  if (!gate) {
    return null;
  }
  if (!text.includes('self.')) {
    return emptyBundle();
  }
  // Older packaged cores drop initializer assignments with a trailing CR.
  // Normalizing CRLF preserves all line and in-line UTF-16 coordinates.
  const response = await gate.runInRust<unknown>(PROPERTY_DIRECTION_RUST_METHOD, {
    text: text.includes('\r\n') ? text.replace(/\r\n/g, '\n') : text
  });
  if (!response.ok) {
    return null;
  }
  const scan = (response.result as { scan?: unknown } | undefined)?.scan;
  if (scan === undefined) {
    return null;
  }
  return convertScanBundle(scan);
}

/** Test face: the empty bundle (zero-clue semantics, same output as scanBundleOf('')) */
export const emptyPropertyDirectionScanBundleForTest = emptyBundle;

/** Test face: direct lookup of the local scan bundle (shared with the fallback side for parity checks) */
export const localScanBundleForTest = scanBundleOf;
