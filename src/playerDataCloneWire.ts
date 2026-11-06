/**
 * Player Data Clone wire 形态(CLONE-P5 / 计划书 §7/§8):TS ↔ Rust(`$/kode/dbClone/*`)
 * 与 TS ↔ mysql2 两侧的纯数据形态。无 vscode 依赖(单测直接驱动)。
 *
 * TypedValue 的归档 wire 是邻接标签 `{"t":"big-u-int","v":7}`(kode-db-clone
 * value.rs serde 形态,kebab-case 变体名);本模块提供构造器/解析器,别处不
 * 手拼该形状。
 */

/** 有类型值 wire(Rust TypedValue 邻接标签形态)。 */
export interface TypedValueWire {
  t: string;
  v?: unknown;
}

export const tvNull = (): TypedValueWire => ({ t: 'null' });
export const tvInt = (v: number | bigint): TypedValueWire => ({ t: 'int', v: Number(v) });
export const tvUInt = (v: number | bigint): TypedValueWire => ({ t: 'u-int', v: Number(v) });
export const tvBigUInt = (v: number | bigint): TypedValueWire => ({
  t: 'big-u-int',
  v: Number(v)
});
export const tvDouble = (v: number): TypedValueWire => ({ t: 'double', v });
export const tvText = (v: string): TypedValueWire => ({ t: 'text', v });
export const tvBytesHex = (hex: string): TypedValueWire => ({ t: 'bytes', v: hex });
export const tvDecimal = (v: string): TypedValueWire => ({ t: 'decimal', v });

/** 有类型行 wire(表 + 与列序对齐的值序)。 */
export interface TypedRowWire {
  table: string;
  values: TypedValueWire[];
}

/** 物理表 wire(camelCase;information_schema 探测 → Rust planExport/planImport)。 */
export interface PhysicalTableWire {
  name: string;
  engine: string;
  columns: Record<string, string>;
  primaryKey: string[];
  indexes: string[][];
}

/** 目标 Profile wire(§6.1:环境仅 local/test,Rust 侧 fail-closed 复核)。 */
export interface TargetProfileWire {
  environment: 'local' | 'test';
  dbInterface: 'mysql';
  writable: boolean;
  host: string;
  port: number;
  database: string;
  engineVersion?: string;
}

/** 目标快照 wire(唯一键清单 + 既有值;TS 只读探测收集)。 */
export interface TargetSnapshotWire {
  uniqueKeys: Array<{ table: string; column: string }>;
  existingValues: Array<{ table: string; column: string; value: TypedValueWire }>;
}

/** 归档清单(Rust Archive::inspect 输出;无行值)。 */
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

/** 计划单元格(与 Rust PlannedCell serde kebab-case 形态对齐)。 */
export type PlannedCellWire =
  | { kind: 'literal' }
  | { kind: 'new-key'; placeholder: number }
  | { kind: 'key-reference'; placeholder: number }
  | { kind: 'policy-override' }
  | { kind: 'remapped' };

/** 计划 INSERT 语句(全 `?` 参数化,无内嵌值)。 */
export interface PlannedInsertWire {
  sequence: number;
  table: string;
  row_index: number;
  columns: string[];
  cells: PlannedCellWire[];
  insert_sql: string;
}

/** 导入计划(Rust ImportPlan Serialize 输出的 TS 消费面)。 */
export interface ImportPlanWire {
  entity_name: string;
  mode: string;
  autoload_policy: string;
  order: string[];
  statements: PlannedInsertWire[];
  /** ID 映射账本(按键序数组;apply 期 Remapped 取 rebuilt 值用)。 */
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

/** 导出计划(Rust ExportPlanner QueryPlan 输出,snake_case 字段)。 */
export interface QueryPlanWire {
  entity_name: string;
  row_budget: number;
  queries: Array<{
    sequence: number;
    table: string;
    /** 子表指向逻辑父表(引擎 parentID 关系;根表为空)。 */
    parent_table?: string | null;
    columns: string[];
    /** 与列序对齐的派生列型(有类型行编码依据)。 */
    column_types: string[];
    select_sql: string;
    /** 根表按 id/子表按 parentID 的绑定值来源标记。 */
    filter: string;
  }>;
  denied: Array<{ name: string; reason: string }>;
  missing: string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** ArchiveMeta 形状闸(ok=false 一律按不可用处理,不猜字段)。 */
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

/** ImportPlan 形状闸(语句/摘要/绑定缺一即不可用)。 */
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

/** QueryPlan 形状闸。 */
export function isQueryPlan(value: unknown): value is QueryPlanWire {
  if (!isRecord(value)) {
    return false;
  }
  return (
    Array.isArray(value.queries) &&
    value.queries.every(
      q => isRecord(q) && typeof q.table === 'string' && typeof q.select_sql === 'string'
    )
  );
}

/**
 * mysql2 单元格 → TypedValueWire:按物理列型归型(与 Rust TypedValue::parse
 * 同口径:整数族精确、decimal/时间字符串保真、未知列型退文本不造假)。
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
    const num = Number(cell);
    if (Number.isSafeInteger(num)) {
      if (base === 'bigint') {
        return unsigned ? tvBigUInt(num) : tvInt(num);
      }
      return unsigned ? tvUInt(num) : tvInt(num);
    }
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

/** TypedValueWire → mysql2 绑定值(NewKey 的 NULL 由 apply 层给,此处纯转换)。 */
export function typedValueToBind(value: TypedValueWire): unknown {
  switch (value.t) {
    case 'null':
      return null;
    case 'decimal':
    case 'bytes':
    case 'text':
      return String(value.v ?? '');
    case 'date-time':
      return typeof value.v === 'object' && value.v !== null
        ? (value.v as { value?: unknown }).value
        : value.v;
    default:
      return Number(value.v ?? 0);
  }
}
