/**
 * Rust bridging face for Player Data Clone (CLONE-P5 / PDC-0502..0505): calls
 * `$/kode/dbClone/*` through the kode-core gate (the five handlers in
 * kode-server db_clone.rs: inspectArchive/planExport/export/planImport/readArchiveRows).
 *
 * Difference from databaseSchemaRust: cloning has no TS fallback implementation (the
 * archive format/planner pure logic all lives in the Rust crate), so when the gate is absent
 * it does not return null pretending something was computed -- it returns
 * `{ status: 'no-gate' }` and the command layer honestly says "the Rust backend is required";
 * a handler failure returns `{ status: 'error' }` carrying the reason. A non-conforming shape
 * is treated as an error (no guessing fields).
 */

import { getKodeCoreShadowGate } from './kodeCoreShadowFaces';
import {
  isArchiveMeta,
  isImportPlan,
  isQueryPlan,
  type ArchiveMetaWire,
  type ImportPlanWire,
  type PhysicalTableWire,
  type QueryPlanWire,
  type TargetProfileWire,
  type TargetSnapshotWire,
  type TypedRowWire
} from './playerDataCloneWire';

export type RustCall<T> =
  | { status: 'ok'; result: T }
  | { status: 'no-gate' }
  | { status: 'error'; reason: string };

const DEFAULT_TIMEOUT_MS = 120_000;

function toCall<T>(
  response: { ok: true; result: unknown } | { ok: false; reason: string },
  guard: (value: unknown) => value is T,
  what: string
): RustCall<T> {
  if (!response.ok) {
    return { status: 'error', reason: response.reason };
  }
  if (!guard(response.result)) {
    return { status: 'error', reason: `${what}: unexpected result shape from rust backend` };
  }
  return { status: 'ok', result: response.result };
}

/** inspectArchive: archive path -> manifest (row values are not returned). keyRoot = the secret storage root (fetching the key for encrypted archives). */
export async function inspectCloneArchive(
  path: string,
  keyRoot?: string
): Promise<RustCall<ArchiveMetaWire>> {
  const gate = getKodeCoreShadowGate();
  if (!gate) {
    return { status: 'no-gate' };
  }
  const response = await gate.runInRust('$/kode/dbClone/inspectArchive', { path, keyRoot });
  return toCall(response, isArchiveMeta, 'inspectArchive');
}

/** readArchiveRows: archive rows (typed; the unique-value probing and the Apply binding-value face for the import rehearsal). */
export async function readCloneArchiveRows(
  path: string,
  keyRoot?: string
): Promise<RustCall<{ tables: Array<{ name: string; rows: TypedRowWire[] }> }>> {
  const gate = getKodeCoreShadowGate();
  if (!gate) {
    return { status: 'no-gate' };
  }
  const response = await gate.runInRust(
    '$/kode/dbClone/readArchiveRows',
    { path, keyRoot },
    { timeoutMs: DEFAULT_TIMEOUT_MS }
  );
  if (!response.ok) {
    return { status: 'error', reason: response.reason };
  }
  const record = response.result as { tables?: unknown };
  if (typeof record !== 'object' || record === null || !Array.isArray(record.tables)) {
    return { status: 'error', reason: 'readArchiveRows: unexpected result shape from rust backend' };
  }
  return {
    status: 'ok',
    result: record as { tables: Array<{ name: string; rows: TypedRowWire[] }> }
  };
}

/** planExport: derive output + source physical tables -> a read-only SELECT plan. */
export async function planCloneExport(
  derivation: unknown,
  physicalTables: PhysicalTableWire[]
): Promise<RustCall<QueryPlanWire>> {
  const gate = getKodeCoreShadowGate();
  if (!gate) {
    return { status: 'no-gate' };
  }
  const response = await gate.runInRust(
    '$/kode/dbClone/planExport',
    { derivation, physicalTables },
    { timeoutMs: DEFAULT_TIMEOUT_MS }
  );
  return toCall(response, isQueryPlan, 'planExport');
}

/** export: typed rows + the plan's column order -> writes .kdpclone (redaction on by
 * default; passing keyRoot writes it encrypted to disk -- the key is stored separately by the
 * Rust-side FileKeyStore at 0600, and the key material never crosses into TS). */
export async function writeCloneArchive(
  path: string,
  entity: string,
  rows: TypedRowWire[],
  plan: QueryPlanWire,
  keyRoot?: string
): Promise<RustCall<{ entity: string; total_rows: number; tables: unknown[] }>> {
  const gate = getKodeCoreShadowGate();
  if (!gate) {
    return { status: 'no-gate' };
  }
  const response = await gate.runInRust(
    '$/kode/dbClone/export',
    { path, entity, rows, plan, redactSensitive: true, keyRoot },
    { timeoutMs: DEFAULT_TIMEOUT_MS }
  );
  if (!response.ok) {
    return { status: 'error', reason: response.reason };
  }
  const record = response.result as Record<string, unknown>;
  if (
    typeof record !== 'object' ||
    record === null ||
    typeof record.entity !== 'string' ||
    typeof record.total_rows !== 'number'
  ) {
    return { status: 'error', reason: 'export: unexpected result shape from rust backend' };
  }
  return { status: 'ok', result: record as unknown as { entity: string; total_rows: number; tables: unknown[] } };
}

/** planImport: archive + target profile + physical tables + snapshot -> the import plan (the Dry Run face). */
export async function planCloneImport(
  path: string,
  target: TargetProfileWire,
  derivation: unknown,
  physicalTables: PhysicalTableWire[],
  snapshot: TargetSnapshotWire,
  keyRoot?: string
): Promise<RustCall<ImportPlanWire>> {
  const gate = getKodeCoreShadowGate();
  if (!gate) {
    return { status: 'no-gate' };
  }
  const response = await gate.runInRust(
    '$/kode/dbClone/planImport',
    { path, target, derivation, physicalTables, snapshot, keyRoot },
    { timeoutMs: DEFAULT_TIMEOUT_MS }
  );
  return toCall(response, isImportPlan, 'planImport');
}
