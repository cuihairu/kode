/**
 * Player Data Clone 的 Rust 桥接面(CLONE-P5 / PDC-0502..0505):经
 * kode-core gate 调 `$/kode/dbClone/*`(kode-server db_clone.rs 的五个
 * handler:inspectArchive/planExport/export/planImport/readArchiveRows)。
 *
 * 与 databaseSchemaRust 的差异:克隆没有 TS 兜底实现(归档格式/计划器纯逻辑
 * 都在 Rust crate),gate 缺席时不返回 null 假装算了——返回
 * `{ status: 'no-gate' }`,命令层如实告知「需要 Rust 后端」;handler 出错
 * 返回 `{ status: 'error' }` 携原因。形状不合规按 error 处理(不猜字段)。
 */

import { getKodeCoreShadowGate } from '../kodeCoreShadowFaces';
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
} from '../playerDataCloneWire';

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

/** inspectArchive:归档路径 → 清单(不回行值)。keyRoot=密钥存储根(加密档取钥)。 */
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

/** readArchiveRows:归档行(有类型;导入预演唯一值探测与 Apply 绑定值面)。 */
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

/** planExport:推导输出 + 源库物理表 → 只读 SELECT 计划。 */
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

/** export:有类型行 + 计划列序 → 写 .kdpclone(脱敏默认开;传 keyRoot 即
 * 加密落盘——钥在 Rust 侧 FileKeyStore 0600 独立存,密钥材料不过 TS)。 */
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

/** planImport:归档 + 目标 Profile + 物理表 + 快照 → 导入计划(Dry Run 面)。 */
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
