/**
 * Player Data Clone 的 mysql 会话面(CLONE-P5 / PDC-0501..0506):
 * - 建连/测试连接(0501):mysql2 动态注入(生产 import('mysql2/promise'),
 *   测试替身注入),连接即 SET 只读会话(源/探测面);目标 Apply 面同一条
 *   连接上显式 START TRANSACTION 写入。
 * - information_schema 探测:物理表(列型/引擎/主键/唯一索引)→ Rust
 *   planExport/planImport 的 physicalTables;唯一键清单 → 目标快照。
 * - 目标快照探测:按归档内实际出现的唯一键值做 WHERE IN 有界探测(不整列扫)。
 * - Apply 执行器(0505/0506):TS 侧驱动 mysql2 单事务,语义对齐 crate
 *   apply.rs —— begin → 按计划父先子后逐句(NewKey 绑 NULL 交 AUTO_INCREMENT,
 *   insertId 回填占位,KeyReference 绑回填值)→ 任何失败/取消 ROLLBACK →
 *   全成才 COMMIT → 逐表 COUNT 核对 → 逆拓扑清理计划(只生成不执行)。
 *   这是 §6.2「单事务」在无 Rust MySQL 客户端前提下的显式取舍(PDC-0506),
 *   语义由 tests/playerDataCloneApply.test.ts 与 Rust golden_apply 双面锁定。
 *
 * 无 vscode 依赖(命令层注入 UI 面)。
 */

import { assertReadOnlyStatement } from './databaseDrift';
import {
  cellToTypedValue,
  typedValueToBind,
  tvBigUInt,
  type ImportPlanWire,
  type PhysicalTableWire,
  type QueryPlanWire,
  type TypedRowWire,
  type TypedValueWire
} from './playerDataCloneWire';

/** mysql2/promise 连接子集(query 支持参数;end 释放)。 */
export interface CloneMysqlConnection {
  query(sql: string, values?: unknown[]): Promise<[unknown, unknown]>;
  end(): Promise<void>;
}

export interface CloneMysqlModule {
  createConnection(options: {
    host: string;
    port: number;
    user: string;
    password?: string;
    database: string;
    supportBigNumbers?: boolean;
    bigNumberStrings?: boolean;
  }): Promise<CloneMysqlConnection>;
}

/** 生产默认:mysql2 动态载入(与 databaseDrift 同款,失败如实抛)。 */
export const loadMysqlModule = async (): Promise<CloneMysqlModule> =>
  (await import('mysql2/promise')) as unknown as CloneMysqlModule;

export interface CloneConnectionConfig {
  host: string;
  port: number;
  user: string;
  password?: string;
  database: string;
}

/** 建连;探测/导出面默认置只读会话,Apply 面显式 readonly:false 开写事务。 */
export async function openCloneSession(
  config: CloneConnectionConfig,
  options: { readonly?: boolean } = {},
  loadModule: () => Promise<CloneMysqlModule> = loadMysqlModule
): Promise<CloneMysqlConnection> {
  const mysql = await loadModule();
  const connection = await mysql.createConnection({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    supportBigNumbers: true,
    bigNumberStrings: true
  });
  if (options.readonly !== false) {
    await connection.query('SET SESSION TRANSACTION READ ONLY');
  }
  return connection;
}

/** 测试连接(0501):连通性 + 引擎/服务器版本信息。 */
export async function testCloneConnection(
  connection: CloneMysqlConnection
): Promise<{ ok: true; version: string } | { ok: false; reason: string }> {
  try {
    const [rows] = await connection.query('SELECT VERSION() AS v');
    const first = Array.isArray(rows) ? (rows[0] as Record<string, unknown> | undefined) : undefined;
    return { ok: true, version: String(first?.v ?? 'unknown') };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

const IDENT = /^[A-Za-z0-9_]+$/;

/** information_schema 探测:表引擎/列型/主键/唯一索引 → PhysicalTableWire[]。 */
export async function probePhysicalTables(
  connection: CloneMysqlConnection,
  tableNames: string[]
): Promise<PhysicalTableWire[]> {
  if (tableNames.length === 0) {
    return [];
  }
  for (const name of tableNames) {
    if (!IDENT.test(name)) {
      throw new Error(`probePhysicalTables: unsafe table name \`${name}\``);
    }
  }
  const tables: PhysicalTableWire[] = [];
  for (const name of tableNames) {
    const [tableRows] = await connection.query(
      'SELECT ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
      [name]
    );
    const engineRow = Array.isArray(tableRows)
      ? (tableRows[0] as Record<string, unknown> | undefined)
      : undefined;
    if (!engineRow) {
      continue;
    }
    const [columnRows] = await connection.query(
      'SELECT COLUMN_NAME, COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION',
      [name]
    );
    const columns: Record<string, string> = {};
    for (const row of Array.isArray(columnRows) ? (columnRows as Array<Record<string, unknown>>) : []) {
      columns[String(row.COLUMN_NAME)] = String(row.COLUMN_TYPE);
    }
    const [indexRows] = await connection.query(
      'SELECT INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY INDEX_NAME, SEQ_IN_INDEX',
      [name]
    );
    const primaryKey: string[] = [];
    const uniqueByKey = new Map<string, string[]>();
    for (const raw of Array.isArray(indexRows) ? (indexRows as Array<Record<string, unknown>>) : []) {
      const row = raw as {
        INDEX_NAME: string;
        NON_UNIQUE: number | string;
        COLUMN_NAME: string;
      };
      if (row.INDEX_NAME === 'PRIMARY') {
        primaryKey.push(row.COLUMN_NAME);
      } else if (String(row.NON_UNIQUE) === '0') {
        uniqueByKey.set(row.INDEX_NAME, [...(uniqueByKey.get(row.INDEX_NAME) ?? []), row.COLUMN_NAME]);
      }
    }
    tables.push({
      name,
      engine: String(engineRow.ENGINE ?? 'unknown'),
      columns,
      primaryKey,
      indexes: [...uniqueByKey.values()]
    });
  }
  return tables;
}

/** 计划语句 → 每表列序(归档行值序与之一一对应;apply/探测共用)。 */
export function columnOrderFromPlan(plan: ImportPlanWire): Map<string, string[]> {
  const order = new Map<string, string[]>();
  for (const statement of plan.statements) {
    if (!order.has(statement.table)) {
      order.set(statement.table, [...statement.columns]);
    }
  }
  return order;
}

/**
 * 归档行 → 目标快照候选:声明唯一列在归档内出现的值(有界,不整列扫)。
 * 列位取自 pass-1 计划的列序(归档行不带列名,值序=导出列序)。
 */
export function uniqueValuesFromRows(
  rowsByTable: Map<string, TypedRowWire[]>,
  columnOrderByTable: Map<string, string[]>,
  uniqueKeys: Array<{ table: string; column: string }>
): Array<{ table: string; column: string; value: TypedValueWire }> {
  const out: Array<{ table: string; column: string; value: TypedValueWire }> = [];
  for (const { table, column } of uniqueKeys) {
    const columnIndex = columnOrderByTable.get(table)?.indexOf(column) ?? -1;
    if (columnIndex < 0) {
      continue;
    }
    for (const row of rowsByTable.get(table) ?? []) {
      const value = row.values[columnIndex];
      if (!value || value.t === 'null') {
        continue;
      }
      const key = `${table}|${column}|${typedValueKeyOf(value)}`;
      if (!out.some(e => `${e.table}|${e.column}|${typedValueKeyOf(e.value)}` === key)) {
        out.push({ table, column, value });
      }
    }
  }
  return out;
}

/**
 * 目标既有值探测:对快照候选值逐列 WHERE IN(只读会话),命中即回填
 * existingValues(Rust 冲突预演的输入)。
 */
export async function probeExistingValues(
  connection: CloneMysqlConnection,
  candidates: Array<{ table: string; column: string; value: TypedValueWire }>
): Promise<Array<{ table: string; column: string; value: TypedValueWire }>> {
  const byColumn = new Map<string, { table: string; column: string; values: TypedValueWire[] }>();
  for (const candidate of candidates) {
    const key = `${candidate.table}.${candidate.column}`;
    const entry = byColumn.get(key) ?? {
      table: candidate.table,
      column: candidate.column,
      values: []
    };
    entry.values.push(candidate.value);
    byColumn.set(key, entry);
  }
  const existing: Array<{ table: string; column: string; value: TypedValueWire }> = [];
  for (const { table, column, values } of byColumn.values()) {
    if (!IDENT.test(table) || !IDENT.test(column)) {
      throw new Error(`probeExistingValues: unsafe identifier \`${table}.${column}\``);
    }
    const binds = values.map(typedValueToBind);
    const placeholders = values.map(() => '?').join(', ');
    const [rows] = await connection.query(
      `SELECT ${column} AS v FROM ${table} WHERE ${column} IN (${placeholders})`,
      binds
    );
    const present = new Set(
      (Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : []).map(r =>
        typedValueKeyOf(cellToTypedValue(r.v, 'varchar'))
      )
    );
    for (const value of values) {
      if (present.has(typedValueKeyOf(value))) {
        existing.push({ table, column, value });
      }
    }
  }
  return existing;
}

function typedValueKeyOf(value: TypedValueWire): string {
  return `${value.t}:${String(value.v ?? '')}`;
}

/** Apply 取消(§6.4:Apply 期取消 → 回滚)。 */
export class CloneApplyCancelledError extends Error {
  constructor() {
    super('clone import cancelled before commit; transaction rolled back');
  }
}

/** 导出/通用取消(只读面无事务,中断即停)。 */
export class CloneCancelledError extends Error {
  constructor() {
    super('clone operation cancelled before completion');
  }
}

/** The database may have committed even if the COMMIT response was lost. */
export class CloneCommitUnknownError extends Error {}
/** The transaction committed, but a later verification failed. */
export class ClonePostCommitError extends Error {}
/** Rollback itself failed, so the outcome cannot be asserted. */
export class CloneRollbackUnknownError extends Error {}

/**
 * 执行导出计划(只读会话):根表按 DBID 一次,子表按父行 id 逐次
 * (引擎 parentID 关系);行值按 column_types 归型为有类型 wire。
 * 语句先过只读白名单断言(计划来自 Rust,仍不豁免)。
 */
export async function executeExportPlan(
  connection: CloneMysqlConnection,
  plan: QueryPlanWire,
  rootDbid: number | bigint,
  options: { shouldCancel?(): boolean } = {}
): Promise<TypedRowWire[]> {
  const allRows: TypedRowWire[] = [];
  const idsByTable = new Map<string, TypedValueWire[]>();
  await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
  await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
  try {
  for (const query of plan.queries) {
    if (options.shouldCancel?.()) {
      throw new CloneCancelledError();
    }
    assertReadOnlyStatement(query.select_sql);
    const runQuery = async (binds: unknown[]): Promise<void> => {
      const remaining = plan.row_budget - allRows.length;
      if (!Number.isSafeInteger(remaining) || remaining < 0) {
        throw new Error('clone: invalid or exceeded export row budget');
      }
      const [rows] = await connection.query(`${query.select_sql} LIMIT ${remaining + 1}`, binds);
      if (Array.isArray(rows) && rows.length > remaining) {
        throw new Error(`clone: export exceeds row budget ${plan.row_budget}`);
      }
      const idIndex = query.columns.indexOf('id');
      const collected: TypedValueWire[] = [];
      for (const raw of Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : []) {
        const values = query.columns.map((column, index) =>
          cellToTypedValue(raw[column], query.column_types[index] ?? '')
        );
        allRows.push({ table: query.table, values });
        if (idIndex >= 0 && values[idIndex]) {
          collected.push(values[idIndex]);
        }
      }
      idsByTable.set(query.table, [...(idsByTable.get(query.table) ?? []), ...collected]);
    };
    if (query.filter === 'root-id') {
      await runQuery([rootDbid]);
    } else {
      // parent-id:对该表逻辑父(引擎 parentID)的每个已收集行 id 各跑一次。
      const parentIdList = idsByTable.get(query.parent_table ?? '') ?? [];
      for (const parentId of parentIdList) {
        if (options.shouldCancel?.()) {
          throw new CloneCancelledError();
        }
        await runQuery([typedValueToBind(parentId)]);
      }
    }
  }
  await connection.query('COMMIT');
  return allRows;
  } catch (error) {
    await connection.query('ROLLBACK');
    throw error;
  }
}

export interface CloneApplyProgress {
  (done: number, total: number): void;
}

export interface CloneApplyResult {
  insertedPerTable: Record<string, number>;
  /** 占位 → 数据库真实新主键(PDC-0402 回填)。 */
  resolvedIds: Record<number, number>;
  newRootId: number | null;
  verify: Array<{ table: string; expected: number; found: number; ok: boolean }>;
  /** 逆拓扑清理计划(只生成不执行,PDC-0408)。 */
  cleanup: Array<{ sql: string; params: unknown[] }>;
}

interface ResultSetHeaderLike {
  insertId?: number;
  affectedRows?: number;
}

/**
 * 单事务执行导入计划(语义对齐 crate apply.rs;语句值面由 rowsByTable 给)。
 * 失败/取消 → ROLLBACK 后抛出,绝不留半个角色。
 */
export async function applyImportPlan(
  connection: CloneMysqlConnection,
  plan: ImportPlanWire,
  rowsByTable: Map<string, TypedRowWire[]>,
  columnOrderByTable: Map<string, string[]>,
  options: { onProgress?: CloneApplyProgress; shouldCancel?(): boolean } = {}
): Promise<CloneApplyResult> {
  const idmapRebuilt = new Map<string, TypedValueWire>();
  for (const entry of plan.idmap ?? []) {
    if (entry.mapped.kind === 'rebuilt' && entry.mapped.value) {
      idmapRebuilt.set(
        `${entry.key.table}|${entry.key.column}|${typedValueKeyOf(entry.key.old)}`,
        entry.mapped.value
      );
    }
  }

  const resolvedIds = new Map<number, number>();
  const insertedPerTable: Record<string, number> = {};

  await connection.query('START TRANSACTION');
  try {
    for (let index = 0; index < plan.statements.length; index += 1) {
      if (options.shouldCancel?.()) {
        throw new CloneApplyCancelledError();
      }
      const statement = plan.statements[index];
      const rows = rowsByTable.get(statement.table) ?? [];
      const row = rows[statement.row_index];
      if (!row) {
        throw new Error(
          `apply: statement ${statement.sequence} references row ${statement.row_index} of ${statement.table} absent from the archive`
        );
      }
      const columnOrder = columnOrderByTable.get(statement.table);
      if (!columnOrder || columnOrder.length !== row.values.length) {
        throw new Error(
          `apply: column order for ${statement.table} does not match the archive row width`
        );
      }
      const params = statement.cells.map((cell, cellIndex) =>
        resolveCellBind(
          cell,
          row.values[cellIndex],
          statement.table,
          columnOrder[cellIndex],
          plan,
          idmapRebuilt,
          resolvedIds
        )
      );
      const [result] = await connection.query(statement.insert_sql, params);
      const header = Array.isArray(result) ? undefined : (result as ResultSetHeaderLike);
      const newId = header?.insertId ?? 0;
      if (!Number.isSafeInteger(newId)) {
        throw new Error('clone: generated id cannot be represented without loss');
      }
      for (const cell of statement.cells) {
        if (cell.kind === 'new-key' && newId > 0) {
          resolvedIds.set(cell.placeholder, newId);
        }
      }
      insertedPerTable[statement.table] = (insertedPerTable[statement.table] ?? 0) + 1;
      options.onProgress?.(index + 1, plan.statements.length);
    }
    if (options.shouldCancel?.()) {
      throw new CloneApplyCancelledError();
    }
  } catch (error) {
    try {
      await connection.query('ROLLBACK');
    } catch (rollbackError) {
      throw new CloneRollbackUnknownError(`rollback failed: ${String(rollbackError)}; original error: ${String(error)}`);
    }
    throw error;
  }
  try {
    await connection.query('COMMIT');
  } catch (error) {
    throw new CloneCommitUnknownError(`COMMIT outcome unknown: ${String(error)}`);
  }

  // ---- 提交后逐表核对(PDC-0406;失败如实报,不回滚已提交事务) ----
  const verify: CloneApplyResult['verify'] = [];
  try {
  for (const table of plan.order) {
    const ids = newIdsForTable(plan, resolvedIds, table);
    const expected = insertedPerTable[table] ?? 0;
    if (expected === 0 || ids.length === 0) {
      continue;
    }
    const placeholders = ids.map(() => '?').join(', ');
    const [rows] = await connection.query(
      `SELECT COUNT(*) AS c FROM ${table} WHERE id IN (${placeholders})`,
      ids.map(typedValueToBind)
    );
    const first = Array.isArray(rows)
      ? (rows[0] as Record<string, unknown> | undefined)
      : undefined;
    const found = Number(first?.c ?? 0);
    verify.push({ table, expected, found, ok: found === expected });
  }
  } catch (error) {
    throw new ClonePostCommitError(`committed; verification failed: ${String(error)}`);
  }

  // ---- 清理计划:逆拓扑序,只生成(PDC-0408) ----
  const cleanup: CloneApplyResult['cleanup'] = [];
  for (const table of [...plan.order].reverse()) {
    const ids = newIdsForTable(plan, resolvedIds, table);
    if (ids.length === 0) {
      continue;
    }
    const placeholders = ids.map(() => '?').join(', ');
    cleanup.push({
      sql: `DELETE FROM ${table} WHERE id IN (${placeholders})`,
      params: ids.map(typedValueToBind)
    });
  }

  const rootTable = plan.order[0];
  const rootStatement = rootTable
    ? plan.statements.find(s => s.table === rootTable && s.cells.some(c => c.kind === 'new-key'))
    : undefined;
  const rootPlaceholder = rootStatement?.cells.find(c => c.kind === 'new-key');
  const newRootId =
    rootPlaceholder && rootPlaceholder.kind === 'new-key'
      ? (resolvedIds.get(rootPlaceholder.placeholder) ?? null)
      : null;

  return { insertedPerTable, resolvedIds: Object.fromEntries(resolvedIds), newRootId, verify, cleanup };
}

function resolveCellBind(
  cell: ImportPlanWire['statements'][number]['cells'][number],
  value: TypedValueWire,
  table: string,
  column: string,
  plan: ImportPlanWire,
  idmapRebuilt: Map<string, TypedValueWire>,
  resolvedIds: Map<number, number>
): unknown {
  switch (cell.kind) {
    case 'new-key':
      return null;
    case 'key-reference': {
      const id = resolvedIds.get(cell.placeholder);
      if (id === undefined) {
        throw new Error(
          `apply: key reference placeholder ${cell.placeholder} resolved before its row was inserted (order violation)`
        );
      }
      return id;
    }
    case 'policy-override':
      return plan.autoload_policy === 'preserve-archive' ? typedValueToBind(value) : 0;
    case 'remapped': {
      const rebuilt = idmapRebuilt.get(`${table}|${column}|${typedValueKeyOf(value)}`);
      return typedValueToBind(rebuilt ?? value);
    }
    default:
      return typedValueToBind(value);
  }
}

function newIdsForTable(
  plan: ImportPlanWire,
  resolvedIds: Map<number, number>,
  table: string
): TypedValueWire[] {
  const ids: TypedValueWire[] = [];
  for (const statement of plan.statements) {
    if (statement.table !== table) {
      continue;
    }
    for (const cell of statement.cells) {
      if (cell.kind === 'new-key') {
        const id = resolvedIds.get(cell.placeholder);
        if (id !== undefined) {
          ids.push(tvBigUInt(id));
        }
      }
    }
  }
  return ids;
}
