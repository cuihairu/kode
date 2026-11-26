/**
 * Player Data Clone wire shapes (CLONE-P5 / the plan doc §7/§8): the pure data shapes for
 * TS <-> Rust (`$/kode/dbClone/*`) and TS <-> mysql2 on both sides. No vscode dependencies
 * (unit tests drive it directly).
 *
 * TypedValue's archived wire uses the adjacent tag `{"t":"big-u-int","v":7}` (the kode-db-clone
 * value.rs serde shape, kebab-case variant names); this module provides constructors/parsers
 * so nobody hand-assembles that shape elsewhere.
 */

/** Typed value wire (the Rust TypedValue adjacent-tag shape). */
export interface TypedValueWire {
  t: string;
  v?: unknown;
}

export const tvNull = (): TypedValueWire => ({ t: 'null' });
function integerWire(v: number | bigint | string, unsigned: boolean): number | string {
  if (typeof v === 'number' && !Number.isSafeInteger(v)) {
    throw new Error(`clone: integer ${String(v)} cannot be represented without loss`);
  }
  if (!/^-?\d+$/.test(String(v))) {
    throw new Error(`clone: invalid integer ${String(v)}`);
  }
  const n = BigInt(v);
  if (n < BigInt(unsigned ? '0' : '-9223372036854775808') ||
      n > BigInt(unsigned ? '18446744073709551615' : '9223372036854775807')) {
    throw new Error(`clone: integer ${String(v)} outside 64-bit range`);
  }
  return n >= BigInt(Number.MIN_SAFE_INTEGER) && n <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(n) : n.toString();
}
export const tvInt = (v: number | bigint | string): TypedValueWire => ({ t: 'int', v: integerWire(v, false) });
export const tvUInt = (v: number | bigint | string): TypedValueWire => ({ t: 'u-int', v: integerWire(v, true) });
export const tvBigUInt = (v: number | bigint | string): TypedValueWire => ({
  t: 'big-u-int',
  v: integerWire(v, true)
});
export const tvDouble = (v: number): TypedValueWire => ({ t: 'double', v });
export const tvText = (v: string): TypedValueWire => ({ t: 'text', v });
export const tvBytesHex = (hex: string): TypedValueWire => ({ t: 'bytes', v: hex });
export const tvDecimal = (v: string): TypedValueWire => ({ t: 'decimal', v });

/** Typed row wire (a table + a value sequence aligned with the column order). */
export interface TypedRowWire {
  table: string;
  values: TypedValueWire[];
}

/** Physical table wire (camelCase; information_schema probing -> Rust planExport/planImport). */
export interface PhysicalTableWire {
  name: string;
  engine: string;
  columns: Record<string, string>;
  primaryKey: string[];
  indexes: string[][];
}

/** Target profile wire (§6.1: environment is local/test only, fail-closed re-checked on the Rust side). */
export interface TargetProfileWire {
  environment: 'local' | 'test';
  dbInterface: 'mysql';
  writable: boolean;
  host: string;
  port: number;
  database: string;
  engineVersion?: string;
}

/** Target snapshot wire (unique-key list + existing values; collected by read-only TS probing). */
export interface TargetSnapshotWire {
  uniqueKeys: Array<{ table: string; column: string }>;
  existingValues: Array<{ table: string; column: string; value: TypedValueWire }>;
}

/** Archive manifest (Rust Archive::inspect output; no row values). */
export interface ArchiveMetaWire {
  format: string;
  version: number;
  entity: string;
  created_at_unix: number;
  encrypted: boolean;
  total_rows: number;
  total_bytes: number;
  tables: Array<{ name: string; rows: number; bytes?: number }>;
  files: string[];
}

/** Plan cell (aligned with the Rust PlannedCell serde kebab-case shape). */
export type PlannedCellWire =
  | { kind: 'literal' }
  | { kind: 'new-key'; placeholder: number }
  | { kind: 'key-reference'; placeholder: number }
  | { kind: 'policy-override' }
  | { kind: 'remapped' };

/** Planned INSERT statement (fully `?`-parameterized, no embedded values). */
export interface PlannedInsertWire {
  sequence: number;
  table: string;
  row_index: number;
  columns: string[];
  cells: PlannedCellWire[];
  insert_sql: string;
}

/** Import plan (the TS consumption face of the Rust ImportPlan Serialize output). */
export interface ImportPlanWire {
  entity_name: string;
  mode: string;
  autoload_policy: string;
  order: string[];
  statements: PlannedInsertWire[];
  /** ID mapping ledger (in key-order array order; used during apply for Remapped to fetch the rebuilt value). */
  idmap: Array<{
    key: { table: string; column: string; old: TypedValueWire };
    mapped: { kind: string; placeholder?: number; value?: TypedValueWire };
    category: string;
  }>;
  conflicts: Array<{ table: string; column: string; rebuilt: TypedValueWire }>;
  account_binding: { declaration: string | null; login_ready: boolean; note: string };
  schema_notes: string[];
  warnings: string[];
  summary: {
    entity_name: string;
    mode: string;
    autoload_policy: string;
    statements_per_table: Record<string, number>;
    id_categories: Record<string, number>;
    unique_conflicts: number;
    login_ready: boolean;
    unresolved_reference_risks: number;
  };
}

/** Export plan (the Rust ExportPlanner QueryPlan output, snake_case fields). */
export interface QueryPlanWire {
  entity_name: string;
  row_budget: number;
  queries: Array<{
    sequence: number;
    table: string;
    /** A child table points at its logical parent table (the engine parentID relation; empty for a root table). */
    parent_table?: string | null;
    columns: string[];
    /** Derived column types aligned with the column order (the basis for typed-row encoding). */
    column_types: string[];
    select_sql: string;
    /** The binding-value source marker: by id for a root table, by parentID for a child table. */
    filter: { kind: 'root-id' | 'parent-id' };
  }>;
  denied: Array<{ name: string; reason: string }>;
  missing: string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** ArchiveMeta shape gate (ok=false is always treated as unavailable, no guessing fields). */
export function isArchiveMeta(value: unknown): value is ArchiveMetaWire {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.entity === 'string' &&
    typeof value.total_rows === 'number' &&
    Array.isArray(value.tables)
  );
}

/** ImportPlan shape gate (missing statements/summary/binding in any combination means unavailable). */
export function isImportPlan(value: unknown): value is ImportPlanWire {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.entity_name === 'string' &&
    Array.isArray(value.order) &&
    Array.isArray(value.statements) &&
    value.statements.every(
      s =>
        isRecord(s) &&
        typeof s.table === 'string' &&
        Array.isArray(s.columns) &&
        Array.isArray(s.cells) &&
        typeof s.insert_sql === 'string'
    ) &&
    isRecord(value.summary)
  );
}

/** QueryPlan shape gate. */
export function isQueryPlan(value: unknown): value is QueryPlanWire {
  if (!isRecord(value)) {
    return false;
  }
  return (
    Array.isArray(value.queries) &&
    value.queries.every(
      q => isRecord(q) && typeof q.table === 'string' && typeof q.select_sql === 'string' &&
        isRecord(q.filter) && (q.filter.kind === 'root-id' || q.filter.kind === 'parent-id')
    )
  );
}

/**
 * mysql2 cell -> TypedValueWire: type it by the physical column type (the same accounting as
 * Rust TypedValue::parse: the integer family exact, decimal/time strings preserved faithfully,
 * unknown column types degrade to text without fabricating anything).
 */
export function cellToTypedValue(cell: unknown, columnType: string): TypedValueWire {
  if (cell === null || cell === undefined) {
    return tvNull();
  }
  if (cell instanceof Date) {
    return tvText(cell.toISOString());
  }
  const ty = columnType.trim().toLowerCase();
  const unsigned = ty.includes('unsigned');
  const base = ty
    .replace(/unsigned/g, '')
    .split('(')[0]
    .trim();
  if (
    base === 'tinyint' ||
    base === 'smallint' ||
    base === 'mediumint' ||
    base === 'int' ||
    base === 'bigint'
  ) {
    if (typeof cell !== 'number' && typeof cell !== 'string' && typeof cell !== 'bigint') {
      throw new Error(`clone: invalid integer in ${columnType}`);
    }
    if (base === 'bigint') {
      return unsigned ? tvBigUInt(cell) : tvInt(cell);
    }
    return unsigned ? tvUInt(cell) : tvInt(cell);
  }
  if (base === 'float' || base === 'double') {
    return tvDouble(Number(cell));
  }
  if (base === 'decimal' || base === 'numeric') {
    return tvDecimal(String(cell));
  }
  if (
    base === 'blob' ||
    base === 'binary' ||
    base === 'varbinary' ||
    base === 'tinyblob' ||
    base === 'mediumblob' ||
    base === 'longblob'
  ) {
    const buf = cell as Buffer;
    return tvBytesHex(Buffer.isBuffer(buf) ? buf.toString('hex') : String(cell));
  }
  return tvText(String(cell));
}

/** TypedValueWire -> a mysql2 binding value (NewKey's NULL is supplied by the apply layer; this is a pure conversion). */
export function typedValueToBind(value: TypedValueWire): unknown {
  switch (value.t) {
    case 'null':
      return null;
    case 'decimal':
    case 'text':
      return String(value.v ?? '');
    case 'bytes': {
      const hex = String(value.v ?? '');
      if (!/^(?:[0-9a-fA-F]{2})*$/.test(hex)) {
        throw new Error('clone: invalid hexadecimal binary value');
      }
      return Buffer.from(hex, 'hex');
    }
    case 'date-time':
      return typeof value.v === 'object' && value.v !== null
        ? (value.v as { value?: unknown }).value
        : value.v;
    case 'float':
    case 'double':
      return Number(value.v);
    default:
      return integerWire(value.v as number | string, value.t !== 'int');
  }
}
