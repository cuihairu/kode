/**
 * Player Data Clone's mysql session face (CLONE-P5 / PDC-0501..0506):
 * - Connect / test connection (0501): mysql2 is injected dynamically (production uses
 *   import('mysql2/promise'), tests inject a stand-in), and the connection sets a read-only
 *   session as soon as it opens (the source/probe face); the target Apply face writes by
 *   issuing an explicit START TRANSACTION on that same connection.
 * - information_schema probing: the physical tables (column types/engine/primary key/unique
 *   indexes) feed Rust planExport/planImport's physicalTables; the unique-key list feeds the
 *   target snapshot.
 * - Target snapshot probing: a bounded WHERE IN probe driven by the unique-key values that
 *   actually appear inside the archive (no full-column scan).
 * - The Apply executor (0505/0506): the TS side drives a single mysql2 transaction, its
 *   semantics aligned with crate apply.rs -- begin -> statement by statement in plan order,
 *   parents before children (a NewKey binds NULL to AUTO_INCREMENT, the insertId backfills the
 *   placeholder, a KeyReference binds the backfilled value) -> any failure/cancellation is a
 *   ROLLBACK -> only when everything succeeded a COMMIT -> a per-table COUNT reconciliation ->
 *   an inverse-topological cleanup plan (generated only, never executed).
 *   This is the explicit trade-off for section 6.2's "single transaction" given that there is no
 *   Rust MySQL client available (PDC-0506), and the semantics are pinned on both faces by
 *   tests/playerDataCloneApply.test.ts and the Rust golden_apply.
 *
 * No vscode dependency (the command layer injects the UI face).
 */

import { assertReadOnlyStatement } from './databaseDrift';
import type { Readable } from 'stream';
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

/** The mysql2/promise connection subset (query supports parameters; end releases it). */
export interface CloneMysqlConnection {
  query(sql: string, values?: unknown[]): Promise<[unknown, unknown]>;
  streamRows?(sql: string, values: unknown[]): Readable;
  abort?(): void;
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

/** Production default: mysql2 loaded dynamically (the same pattern as databaseDrift; a failure is thrown as is). */
export const loadMysqlModule = async (): Promise<CloneMysqlModule> =>
  (await import('mysql2/promise')) as unknown as CloneMysqlModule;

export interface CloneConnectionConfig {
  host: string;
  port: number;
  user: string;
  password?: string;
  database: string;
}

/** Open the connection; the probe/export faces set a read-only session by default, the Apply face passes readonly:false explicitly to open a write transaction. */
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
  // mysql2's promise wrapper does not expose query streams directly; its
  // underlying connection shares the same transaction and supports backpressure.
  const raw = (connection as CloneMysqlConnection & {
    connection?: { query(sql: string, values: unknown[]): { stream(options: { highWaterMark: number }): Readable }; destroy(): void };
  }).connection;
  if (raw) {
    connection.streamRows = (sql, values) => raw.query(sql, values).stream({ highWaterMark: 1 });
    connection.abort = () => raw.destroy();
  }
  if (options.readonly !== false) {
    await connection.query('SET SESSION TRANSACTION READ ONLY');
  }
  return connection;
}

/** Test the connection (0501): connectivity + engine/server version info. */
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

/** information_schema probing: table engine/column types/primary key/unique indexes -> PhysicalTableWire[]. */
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

/** Plan statements -> the per-table column order (the archive row value order corresponds to it one to one; shared by apply/probe). */
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
 * Archive rows -> target-snapshot candidates: the values that appear inside the archive for a
 * declared unique column (bounded, no full-column scan). The column positions come from the
 * pass-1 plan's column order (archive rows carry no column names, value order = export column
 * order).
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
 * Probing the target's existing values: a WHERE IN per column over the snapshot candidate values
 * (a read-only session); a hit backfills existingValues (the input to Rust's conflict preview).
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
    // The physical column-type hint is back-derived from the candidate values' own type: a
    // DB-returned value for an integer/binary/timestamp column must be keyed the same way as the
    // candidate for a comparison to hit -- a hard-coded 'varchar' leaves present empty for integer
    // and the like columns (every value misjudged as absent, so a unique-key conflict / duplicate
    // rebuild is missed)
    const hint = columnTypeHintFor(values);
    const present = new Set(
      (Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : []).map(r =>
        typedValueKeyOf(cellToTypedValue(r.v, hint))
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

/** TypedValueWire type tag -> the physical column-type hint (the inverse mapping of cellToTypedValue, keyed with the same type). */
function columnTypeHintFor(values: TypedValueWire[]): string {
  switch (values[0]?.t) {
    case 'int':
      return 'int';
    case 'u-int':
      return 'int unsigned';
    case 'big-u-int':
      return 'bigint unsigned';
    case 'double':
      return 'double';
    case 'decimal':
      return 'decimal';
    case 'bytes':
      return 'blob';
    case 'date-time':
      return 'datetime';
    default:
      return 'varchar'; // text / null
  }
}

/** An Apply cancellation (section 6.4: a cancellation during Apply -> a rollback). */
export class CloneApplyCancelledError extends Error {
  constructor() {
    super('clone import cancelled before commit; transaction rolled back');
  }
}

/** An export/general cancellation (the read-only face holds no transaction, so an interruption just stops). */
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

async function readOnlyControlQuery(
  connection: CloneMysqlConnection,
  sql: string,
  deadline: number,
  shouldCancel?: () => boolean
): Promise<void> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    connection.abort?.();
    throw new Error('clone: export timed out');
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancellationPoll: ReturnType<typeof setInterval> | undefined;
  try {
    await Promise.race([
      connection.query(sql),
      new Promise<never>((_resolve, reject) => {
        if (shouldCancel) {
          cancellationPoll = setInterval(() => {
            if (shouldCancel()) {
              connection.abort?.();
              reject(new CloneCancelledError());
            }
          }, 100);
        }
        timer = setTimeout(() => {
          connection.abort?.();
          reject(new Error('clone: export timed out'));
        }, remaining);
      })
    ]);
  } finally {
    if (timer) { clearTimeout(timer); }
    if (cancellationPoll) { clearInterval(cancellationPoll); }
  }
}

/**
 * Execute the export plan (a read-only session): the root table once by DBID, a child table once
 * per already-collected parent row id (the engine's parentID relation); row values are typed
 * into typed wires according to column_types.
 * Every statement passes the read-only whitelist assertion first (the plan comes from Rust and is
 * still not exempt).
 */
export async function executeExportPlan(
  connection: CloneMysqlConnection,
  plan: QueryPlanWire,
  rootDbid: number | bigint,
  options: { shouldCancel?(): boolean; maxBytes?: number; timeoutMs?: number } = {}
): Promise<TypedRowWire[]> {
  const allRows: TypedRowWire[] = [];
  const idsByTable = new Map<string, TypedValueWire[]>();
  const maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
  const deadline = Date.now() + (options.timeoutMs ?? 120_000);
  let totalBytes = 0;
  await readOnlyControlQuery(connection, 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ', deadline, options.shouldCancel);
  await readOnlyControlQuery(connection, 'START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY', deadline, options.shouldCancel);
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
      const sql = `${query.select_sql} LIMIT ${remaining + 1}`;
      const timeLeft = deadline - Date.now();
      if (timeLeft <= 0) {
        throw new Error('clone: export timed out');
      }
      // Production connections use a backpressured stream; the query fallback
      // supports injected test connections without a mysql2 underlying client.
      const stream = connection.streamRows?.(sql, binds);
      const timer = stream ? setTimeout(() => stream.destroy(new Error('clone: export timed out')), timeLeft) : undefined;
      const cancellationPoll = stream && options.shouldCancel
        ? setInterval(() => {
          if (options.shouldCancel?.()) { stream.destroy(new CloneCancelledError()); }
        }, 100)
        : undefined;
      const rows = stream ?? (await connection.query(sql, binds))[0];
      const idIndex = query.columns.indexOf('id');
      const collected: TypedValueWire[] = [];
      let completed = false;
      try {
      for await (const raw of (Array.isArray(rows) || stream ? rows : []) as AsyncIterable<Record<string, unknown>> | Array<Record<string, unknown>>) {
        if (options.shouldCancel?.()) {
          throw new CloneCancelledError();
        }
        if (Date.now() >= deadline) {
          throw new Error('clone: export timed out');
        }
        if (allRows.length >= plan.row_budget) {
          throw new Error(`clone: export exceeds row budget ${plan.row_budget}`);
        }
        const values = query.columns.map((column, index) =>
          cellToTypedValue(raw[column], query.column_types[index] ?? '')
        );
        totalBytes += Buffer.byteLength(JSON.stringify({ table: query.table, values }), 'utf8');
        if (totalBytes > maxBytes) {
          throw new Error(`clone: export exceeds byte budget ${maxBytes}`);
        }
        allRows.push({ table: query.table, values });
        if (idIndex >= 0 && values[idIndex]) {
          collected.push(values[idIndex]);
        }
      }
      completed = true;
      } finally {
        if (timer) { clearTimeout(timer); }
        if (cancellationPoll) { clearInterval(cancellationPoll); }
        stream?.destroy();
        if (stream && !completed) { connection.abort?.(); }
      }
      idsByTable.set(query.table, [...(idsByTable.get(query.table) ?? []), ...collected]);
    };
    if (query.filter.kind === 'root-id') {
      await runQuery([rootDbid]);
    } else if (query.filter.kind === 'parent-id') {
      // parent-id: run once for each already-collected row id of this table's logical parent (the engine's parentID).
      const parentIdList = idsByTable.get(query.parent_table ?? '') ?? [];
      for (const parentId of parentIdList) {
        if (options.shouldCancel?.()) {
          throw new CloneCancelledError();
        }
        await runQuery([typedValueToBind(parentId)]);
      }
    } else {
      throw new Error('clone: unsupported export filter');
    }
  }
  await readOnlyControlQuery(connection, 'COMMIT', deadline, options.shouldCancel);
  return allRows;
  } catch (error) {
    try { await readOnlyControlQuery(connection, 'ROLLBACK', Math.min(deadline, Date.now() + 1000)); } catch { /* Closing a timed-out read-only session also releases its transaction. */ }
    throw error;
  }
}

export interface CloneApplyProgress {
  (done: number, total: number): void;
}

export interface CloneApplyResult {
  insertedPerTable: Record<string, number>;
  /** Placeholder -> the real new primary key from the database (the PDC-0402 backfill). */
  resolvedIds: Record<number, number | string>;
  newRootId: number | string | null;
  verify: Array<{ table: string; expected: number; found: number; ok: boolean }>;
  /** The inverse-topological cleanup plan (generated only, never executed, PDC-0408). */
  cleanup: Array<{ sql: string; params: unknown[] }>;
}

interface ResultSetHeaderLike {
  insertId?: number | string;
  affectedRows?: number;
}

/**
 * Execute the import plan in a single transaction (semantics aligned with crate apply.rs; the
 * statement values come from rowsByTable).
 * A failure/cancellation -> ROLLBACK and then a throw, never leaving a half-applied role behind.
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

  const resolvedIds = new Map<number, number | string>();
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
      const safeId = tvBigUInt(newId).v as number | string;
      for (const cell of statement.cells) {
        if (cell.kind === 'new-key' && BigInt(safeId) > BigInt(0)) {
          resolvedIds.set(cell.placeholder, safeId);
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

  // ---- The post-commit per-table reconciliation (PDC-0406; a failure is reported as is, the committed transaction is never rolled back) ----
  const verify: CloneApplyResult['verify'] = [];
  try {
  for (const table of plan.order) {
    const ids = newIdsForTable(plan, resolvedIds, rowsByTable, table);
    const expected = insertedPerTable[table] ?? 0;
    // Same accounting as the Rust apply.rs: only expected===0 is skipped; an empty id set (the plan
    // lacks an id column) is left to make the IN () query error out honestly, with no silent empty
    // reconciliation
    if (expected === 0) {
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

  // ---- The cleanup plan: inverse topological order, generated only (PDC-0408) ----
  const cleanup: CloneApplyResult['cleanup'] = [];
  for (const table of [...plan.order].reverse()) {
    const ids = newIdsForTable(plan, resolvedIds, rowsByTable, table);
    if (ids.length === 0) {
      continue;
    }
    const placeholders = ids.map(() => '?').join(', ');
    cleanup.push({
      sql: `DELETE FROM ${table} WHERE id IN (${placeholders})`,
      params: ids.map(typedValueToBind)
    });
  }

  // The root table's new primary key (the UI handle face): allocate = the database-assigned value,
  // preserve = the archive's original value -- same accounting as the Rust apply.rs: take the
  // first item of the root table's id set and then extract the scalar (typed_id_to_u64); honoring
  // only new-key placeholders would make preserve mode always null
  const rootTable = plan.order[0];
  const rootIds = rootTable ? newIdsForTable(plan, resolvedIds, rowsByTable, rootTable) : [];
  const newRootId = rootIds.length > 0 ? typedIdScalar(rootIds[0]) : null;

  return { insertedPerTable, resolvedIds: Object.fromEntries(resolvedIds), newRootId, verify, cleanup };
}

function resolveCellBind(
  cell: ImportPlanWire['statements'][number]['cells'][number],
  value: TypedValueWire,
  table: string,
  column: string,
  plan: ImportPlanWire,
  idmapRebuilt: Map<string, TypedValueWire>,
  resolvedIds: Map<number, number | string>
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
  resolvedIds: Map<number, number | string>,
  rowsByTable: Map<string, TypedRowWire[]>,
  table: string
): TypedValueWire[] {
  const ids: TypedValueWire[] = [];
  for (const statement of plan.statements) {
    if (statement.table !== table) {
      continue;
    }
    const idColumnIndex = statement.columns.indexOf('id');
    for (const [cellIndex, cell] of statement.cells.entries()) {
      if (cell.kind === 'new-key') {
        const id = resolvedIds.get(cell.placeholder);
        if (id !== undefined) {
          ids.push(tvBigUInt(id));
        }
      } else if (cell.kind === 'literal' && cellIndex === idColumnIndex) {
        // In preserve mode the primary key column is the archive's original value (planning produces no
        // placeholder): honoring only placeholders would leave an empty set -> the reconciliation
        // silently skipped / the cleanup plan missing / the root handle always null (the same
        // accounting as the Rust new_ids_for_table `Literal if id_col == Some(idx)` arm)
        const value = rowsByTable.get(table)?.[statement.row_index]?.values[cellIndex];
        if (value) {
          ids.push(value);
        }
      }
    }
  }
  return ids;
}

/** A primary-key bound value -> scalar (the UI handle; a non-integer family = null, same accounting as the Rust typed_id_to_u64). */
function typedIdScalar(value: TypedValueWire): number | string | null {
  if (value.t === 'big-u-int' || value.t === 'u-int' || value.t === 'int') {
    return typeof value.v === 'number' || typeof value.v === 'string' ? value.v : String(value.v);
  }
  return null;
}
