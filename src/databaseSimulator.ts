/**
 * 数据库行模拟(批122)
 * 在 databaseSchema 快照(建表语义已对齐引擎,见审计块19)之上模拟行数据
 * 与增改删预览。写库规格来源 = 引擎 MySQL 后端(kbe/src/lib/db_mysql):
 * - INSERT/UPDATE 判定:EntityTableMysql::writeTable(entity_table_mysql.cpp:778-818,
 *   dbid>0 → UPDATE where id=dbid,否则 INSERT 后取 LAST_INSERT_ID;
 *   sqlstatement.h:69-122/:128-145/:164-192)
 * - 子表行:INSERT 每元素一行 parentID=父 id(write_entity_helper.h:75-89);
 *   行序=子表 id 升序,UPDATE 按升序逐位覆盖、多余行删除(:92-230);
 *   删除递归清子表(remove_entity_helper.h:38-46)
 * - sm_autoLoad 首写 0,已有实体 -1 不改写(entity_table_mysql.cpp:766-775、
 *   baseapp/entity.cpp:1144-1151)
 * - UNIQUE 冲突仅由 MySQL 索引判定,引擎无写前校验(dbmgr.cpp:1044-1066,
 *   1062 分支已注释 kbe_table_mysql.cpp:187/:352,失败仅令 writeTable 返回 0)
 * 与真实引擎的差异清单见 SIMULATION_DIFFERENCES(导出文档尾部同步展示)。
 */

import * as vscode from 'vscode';
import {
  getDatabaseSchemaSnapshot,
  renderChildTableJoinSelectFor,
  type DatabaseSchemaSnapshot,
  type PropertyDatabaseStorageInfo,
  type TableFieldDescriptor
} from './databaseSchema';

export interface SimulatedRow {
  id: number;
  /** parentID/sm_autoLoad/持久属性列的当前值;id 单独存放(自增主键) */
  values: Record<string, string | number>;
}

export type SimulatedRowStore = Map<string, SimulatedRow[]>;

export interface RowIssue {
  kind: 'unknown-table' | 'unknown-row' | 'missing-column' | 'duplicate-id' | 'unique' | 'type' | 'orphan-parent';
  table: string;
  column?: string;
  row?: number;
  message: string;
}

export type RowOperation =
  | { kind: 'insert'; table: string; values?: Record<string, string | number>; id?: number }
  | { kind: 'update'; table: string; id: number; values: Record<string, string | number> }
  | { kind: 'delete'; table: string; id: number };

export interface RowOperationResult {
  ok: boolean;
  issues: RowIssue[];
  /** 操作后的行状态(入参 store 不改写,供变化预览对照) */
  store: SimulatedRowStore;
}

export interface RowSimulationOptions {
  /** 引擎 AUTO_INCREMENT 起点(默认 1;真实读 dbInterface autoIncrementInit) */
  startId?: number;
  /** ARRAY 子表模拟元素数(默认 2) */
  rowsPerChildTable?: number;
  /** sm_autoLoad 初值(引擎首写恒 0) */
  autoLoad?: number;
}

export type ColumnValueKind = 'integer' | 'unsigned' | 'float' | 'string' | 'blob';

export interface ColumnValueType {
  kind: ColumnValueKind;
  length?: number;
}

// 目标 ES2019 无 BigInt 字面量与全局声明(lib 门控);运行时 Node ≥10.4 原生
// 支持,只补类型声明,数值语义不变。64 位边界必须传字符串:超出 2^53 的
// number 字面量会先被舍入再转 BigInt。
declare function BigInt(value: string | number): bigint;

// 有符号整型的 mysql 区间(按 typeLabel 基名;bigint 用 BigInt 精确比较)
const SIGNED_RANGES: Record<string, [bigint, bigint]> = {
  tinyint: [BigInt(-128), BigInt(127)],
  smallint: [BigInt(-32768), BigInt(32767)],
  int: [BigInt(-2147483648), BigInt(2147483647)],
  bigint: [BigInt('-9223372036854775808'), BigInt('9223372036854775807')]
};

const UNSIGNED_MAX: Record<string, bigint> = {
  tinyint: BigInt(255),
  smallint: BigInt(65535),
  int: BigInt(4294967295),
  bigint: BigInt('18446744073709551615')
};

// 列值型别从快照 typeLabel 推:引擎 VECTOR2/3/4 列落 float not null DEFAULT 0
// (entity_table_mysql.cpp:741-749),varchar 长度缺省 255(:1829-1833),
// blob 无 NOT NULL/DEFAULT(:699-715)。
export function resolveColumnValueType(field: TableFieldDescriptor): ColumnValueType {
  const label = field.typeLabel.toLowerCase();
  if (label.startsWith('vector')) {
    return { kind: 'float' };
  }
  if (label === 'varchar' || label === 'char') {
    return { kind: 'string', length: field.databaseLength && field.databaseLength > 0 ? field.databaseLength : 255 };
  }
  if (label.includes('blob')) {
    return { kind: 'blob' };
  }
  if (label === 'float' || label === 'double') {
    return { kind: 'float' };
  }
  if (label.includes('unsigned')) {
    return { kind: 'unsigned' };
  }
  return { kind: 'integer' };
}

/** 列默认值:取 def <Default> 文本按型别解析,解析不动落 0/空串(引擎 DEFAULT 子句同源) */
export function defaultRowValue(field: TableFieldDescriptor): string | number {
  const kind = resolveColumnValueType(field).kind;
  const text = field.defaultValue?.trim();
  if (kind === 'string' || kind === 'blob') {
    return field.defaultValue ?? '';
  }
  if (text !== undefined && text !== '') {
    const parsed = Number(text);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return 0;
}

/**
 * 行值对列的型别校验,返回错误文案或 null。
 * 覆盖:非数值/越界(整数按 mysql 区间,BigInt 精确比较)、浮点非有限、
 * 字符串超长(varchar(N))、blob 仅收字符串。
 */
export function validateRowValue(field: TableFieldDescriptor, value: string | number): string | null {
  const columnType = resolveColumnValueType(field);
  const base = field.typeLabel.toLowerCase().replace(' unsigned', '');
  if (columnType.kind === 'integer' || columnType.kind === 'unsigned') {
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      return `列 ${field.name} 需整数(${field.typeLabel}),收到 ${describeValue(value)}`;
    }
    const normalized = BigInt(value);
    if (columnType.kind === 'unsigned') {
      if (normalized < BigInt(0) || normalized > (UNSIGNED_MAX[base] ?? UNSIGNED_MAX.bigint)) {
        return `列 ${field.name} 超出 ${field.typeLabel} 区间 0..${UNSIGNED_MAX[base] ?? UNSIGNED_MAX.bigint}`;
      }
      return null;
    }
    const range = SIGNED_RANGES[base] ?? SIGNED_RANGES.bigint;
    if (normalized < range[0] || normalized > range[1]) {
      return `列 ${field.name} 超出 ${field.typeLabel} 区间 ${range[0]}..${range[1]}`;
    }
    return null;
  }
  if (columnType.kind === 'float') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return `列 ${field.name} 需有限数值(${field.typeLabel}),收到 ${describeValue(value)}`;
    }
    return null;
  }
  if (typeof value !== 'string') {
    return `列 ${field.name} 需字符串(${field.typeLabel}),收到 ${describeValue(value)}`;
  }
  if (columnType.kind === 'string' && columnType.length !== undefined && value.length > columnType.length) {
    return `列 ${field.name} 超长(varchar(${columnType.length}) 收到 ${value.length} 字符)`;
  }
  return null;
}

function describeValue(value: string | number): string {
  return typeof value === 'string' ? `'${value}'` : String(value);
}

/**
 * 列取值约束文案(批131 悬停用):整数按 mysql 区间(BigInt 精确)、
 * varchar 按解析后长度;float/blob 无区间返回 null。
 */
export function describeColumnValueConstraint(field: TableFieldDescriptor): string | null {
  const columnType = resolveColumnValueType(field);
  const base = field.typeLabel.toLowerCase().replace(' unsigned', '');
  if (columnType.kind === 'unsigned') {
    return `0..${UNSIGNED_MAX[base]}`;
  }
  if (columnType.kind === 'integer') {
    const range = SIGNED_RANGES[base];
    return `${range[0]}..${range[1]}`;
  }
  if (columnType.kind === 'string' && columnType.length !== undefined) {
    return `≤ ${columnType.length} 字符`;
  }
  return null;
}

/**
 * 按快照生成每张表的模拟行:根表 1 行(默认值行),ARRAY 子表 rowsPerChildTable
 * 行,组件子表 1 行;parentID 取父表首行 id,行 id 全局递增(引擎 AUTO_INCREMENT
 * 起点,真实读 dbInterface autoIncrementInit,serverconfig.cpp:1043-1045)。
 * 父表无行(嵌套数组外层 0 元素)时子表也不产行——引擎子表行恒有父 id。
 */
export function simulateInitialRows(
  snapshot: DatabaseSchemaSnapshot,
  options: RowSimulationOptions = {}
): SimulatedRowStore {
  const startId = options.startId ?? 1;
  const rowsPerChildTable = options.rowsPerChildTable ?? 2;
  const autoLoad = options.autoLoad ?? 0;

  const store: SimulatedRowStore = new Map();
  let nextId = startId;

  for (const table of snapshot.tables) {
    const parentRows = table.parentTableName ? store.get(table.parentTableName) : undefined;
    const parentRowId = parentRows?.[0]?.id;
    const rowCount = table.kind === 'entity'
      ? 1
      : table.kind === 'component'
        ? 1
        : parentRowId === undefined
          ? 0
          : rowsPerChildTable;

    const rows: SimulatedRow[] = [];
    for (let index = 0; index < rowCount; index += 1) {
      const values: Record<string, string | number> = {};
      for (const field of table.fields) {
        if (field.name === 'id') {
          continue;
        }
        values[field.name] = field.name === 'parentID'
          ? parentRowId ?? 0
          : field.name === 'sm_autoLoad'
            ? autoLoad
            : defaultRowValue(field);
      }
      rows.push({ id: nextId, values });
      nextId += 1;
    }
    store.set(table.name, rows);
  }

  return store;
}

/** 逐字段取 operation.values 覆盖值做型别/列存在性校验,返回 issues */
function validateOverrides(
  table: { name: string; fields: TableFieldDescriptor[] },
  values: Record<string, string | number>,
  issues: RowIssue[]
): Map<string, string | number> {
  const overrides = new Map<string, string | number>();
  for (const [column, value] of Object.entries(values)) {
    const field = table.fields.find(candidate => candidate.name === column);
    if (!field) {
      issues.push({
        kind: 'missing-column',
        table: table.name,
        column,
        message: `列 ${column} 不在表 ${table.name} 中(缺列)`
      });
      continue;
    }
    const typeError = validateRowValue(field, value);
    if (typeError) {
      issues.push({ kind: 'type', table: table.name, column, message: typeError });
      continue;
    }
    if (column === 'parentID') {
      issues.push({
        kind: 'orphan-parent',
        table: table.name,
        column,
        message: `parentID 由模拟分配(父表首行 id),INSERT/UPDATE 不直接写该列`
      });
      continue;
    }
    overrides.set(column, value);
  }
  return overrides;
}

/**
 * UNIQUE 冲突预检(引擎只靠 MySQL 索引失败返回,见文件头注):比对同表其余行
 * 同列值,值按 String 归一比较。excludeId 用于 UPDATE 自身行。
 */
function checkUniqueConflicts(
  table: { name: string; fields: TableFieldDescriptor[] },
  rows: SimulatedRow[],
  candidate: SimulatedRow,
  issues: RowIssue[],
  excludeId?: number
): void {
  for (const field of table.fields) {
    if (field.indexType !== 'UNIQUE') {
      continue;
    }
    const value = candidate.values[field.name];
    const conflicted = rows.some(row => row.id !== excludeId && String(row.values[field.name]) === String(value));
    if (conflicted) {
      issues.push({
        kind: 'unique',
        table: table.name,
        column: field.name,
        row: candidate.id,
        message: `UNIQUE 索引 ${field.name} 值 ${describeValue(value)} 与已有行冲突`
      });
    }
  }
}

function cloneRowStore(store: SimulatedRowStore): SimulatedRowStore {
  const clone: SimulatedRowStore = new Map();
  for (const [tableName, rows] of store) {
    clone.set(tableName, rows.map(row => ({ id: row.id, values: { ...row.values } })));
  }
  return clone;
}

function nextAutoId(rows: SimulatedRow[]): number {
  return rows.reduce((max, row) => Math.max(max, row.id), 0) + 1;
}

/**
 * 应用一条行操作,产出操作后的状态与约束冲突提示。入参 store 不改写;
 * ok = issues 为空。删除按引擎递归清子表语义级联(remove_entity_helper.h:38-46)。
 */
export function applyRowOperation(
  snapshot: DatabaseSchemaSnapshot,
  store: SimulatedRowStore,
  operation: RowOperation
): RowOperationResult {
  const issues: RowIssue[] = [];
  const next = cloneRowStore(store);
  const table = snapshot.tableIndex.get(operation.table);
  if (!table) {
    issues.push({
      kind: 'unknown-table',
      table: operation.table,
      message: `表 ${operation.table} 不在实体 ${snapshot.entityName} 的建表结构中`
    });
    return { ok: false, issues, store: next };
  }

  if (operation.kind === 'delete') {
    const rows = next.get(table.name) ?? [];
    const index = rows.findIndex(row => row.id === operation.id);
    if (index === -1) {
      issues.push({
        kind: 'unknown-row',
        table: table.name,
        row: operation.id,
        message: `表 ${table.name} 无 id=${operation.id} 的行`
      });
      return { ok: false, issues, store: next };
    }
    rows.splice(index, 1);
    cascadeDeleteChildren(next, operation.id);
    return { ok: true, issues, store: next };
  }

  const rows = next.get(table.name) ?? [];
  next.set(table.name, rows);
  const values = operation.kind === 'insert' ? operation.values ?? {} : operation.values;

  if ('id' in values) {
    issues.push({
      kind: 'missing-column',
      table: table.name,
      column: 'id',
      message: 'id 由自增分配,INSERT/UPDATE 不写该列(引擎 INSERT 不含 id 列)'
    });
  }
  const overrides = validateOverrides(table, values, issues);

  if (operation.kind === 'update') {
    const row = rows.find(candidate => candidate.id === operation.id);
    if (!row) {
      issues.push({
        kind: 'unknown-row',
        table: table.name,
        row: operation.id,
        message: `表 ${table.name} 无 id=${operation.id} 的行`
      });
      return { ok: false, issues, store: next };
    }
    checkUniqueConflicts(
      table,
      rows,
      { id: row.id, values: { ...row.values, ...Object.fromEntries(overrides) } },
      issues,
      row.id
    );
    // 严格引擎语义:任一 issue 即 UPDATE 不会落库,store 保持操作前状态
    if (issues.length === 0) {
      for (const [column, value] of overrides) {
        row.values[column] = value;
      }
    }
    return { ok: issues.length === 0, issues, store: next };
  }

  const explicitId = operation.id;
  if (explicitId !== undefined && rows.some(row => row.id === explicitId)) {
    issues.push({
      kind: 'duplicate-id',
      table: table.name,
      row: explicitId,
      message: `id=${explicitId} 已存在(主键重复,引擎由 PRIMARY KEY 拒绝)`
    });
  }
  // 严格引擎语义:MySQL 拒绝的语句(缺列/型别/直写 parentID/主键重复)在
  // 模拟里同样不落行,store 即操作前状态
  if (issues.length > 0) {
    return { ok: false, issues, store: next };
  }

  const draft: SimulatedRow = { id: explicitId ?? nextAutoId(rows), values: {} };
  const parentRows = table.parentTableName ? next.get(table.parentTableName) : undefined;
  const parentRowId = parentRows?.[0]?.id;
  for (const field of table.fields) {
    if (field.name === 'id') {
      continue;
    }
    draft.values[field.name] = overrides.get(field.name)
      ?? (field.name === 'parentID' ? parentRowId ?? 0 : defaultRowValue(field));
  }
  checkUniqueConflicts(table, rows, draft, issues);

  if (issues.length === 0) {
    rows.push(draft);
  }
  return { ok: issues.length === 0, issues, store: next };
}

/** 删除行后级联清理所有表中 parentID 指向该行(含被删子行的子行)的行:
 * 引擎递归清子表(remove_entity_helper.h:38-46),模拟用待删 id 闭包等价实现 */
function cascadeDeleteChildren(store: SimulatedRowStore, parentId: number): void {
  const pending = [parentId];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const rows of store.values()) {
      const kept = rows.filter(row => row.values.parentID !== current);
      if (kept.length !== rows.length) {
        for (const removed of rows) {
          if (kept.indexOf(removed) === -1 && pending.indexOf(removed.id) === -1) {
            pending.push(removed.id);
          }
        }
        rows.length = 0;
        rows.push(...kept);
      }
    }
  }
}

/** mysql 文本转义(\ 与 '),与引擎 mysql_real_escape_string 的核心两字符同口径 */
function escapeSqlText(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/**
 * 单列 DDL 类型体(不含列名,批131 悬停复用):形态对齐引擎 CREATE/ALTER
 * 列定义(entity_table_mysql.cpp:379-395、:416-418、§4)。
 */
export function renderColumnDdlBody(field: TableFieldDescriptor): string {
  if (field.name === 'parentID') {
    return 'bigint(20) unsigned NOT NULL';
  }
  if (field.name === 'sm_autoLoad') {
    return 'tinyint not null DEFAULT 0';
  }
  const columnType = resolveColumnValueType(field);
  if (columnType.kind === 'blob') {
    return 'blob';
  }
  if (columnType.kind === 'float') {
    // VECTOR 合成列恒 float not null DEFAULT 0,无显示宽度(:741-749);
    // FLOAT/DOUBLE 属性列同数字列走 @DATALEN+,DEFAULT 取 def 默认值(:666/:684)
    if (field.typeLabel.toLowerCase().startsWith('vector')) {
      return 'float not null DEFAULT 0';
    }
    return digitColumnBody(field);
  }
  if (columnType.kind === 'string') {
    return `varchar(${columnType.length}) not null DEFAULT '${escapeSqlText(field.defaultValue ?? '')}'`;
  }
  return digitColumnBody(field);
}

/** 单列 DDL 片段,形态对齐引擎 CREATE/ALTER 列定义(同上) */
function renderColumnDdl(field: TableFieldDescriptor): string {
  return `${field.name} ${renderColumnDdlBody(field)}`;
}

/**
 * 属性数据库存储悬停文案(批131 用户令:完整 db.table.column + 引擎 DDL
 * 片段 + 具体大小限制,粘贴即用)。纯函数:列目标按表分组、同 DDL 列并作
 * 一条(向量三列);ARRAY/组件槽子表单列一条,说明去向与 parentID 关联。
 */
export function buildPropertyDatabaseStorageHover(
  storage: PropertyDatabaseStorageInfo | null
): string | null {
  if (!storage || storage.targets.length === 0) {
    return null;
  }

  const qualifiedTable = (tableName: string): string =>
    storage.database
      ? `\`${storage.database.databaseName}\`.\`${tableName}\``
      : `\`${tableName}\``;

  const parts: string[] = [];
  const columnsByTable = new Map<string, TableFieldDescriptor[]>();
  const childTables: Array<NonNullable<PropertyDatabaseStorageInfo['targets'][number]['table']>> = [];

  for (const target of storage.targets) {
    if (target.field) {
      const columns = columnsByTable.get(target.tableName) ?? [];
      columns.push(target.field);
      columnsByTable.set(target.tableName, columns);
    } else if (target.table) {
      childTables.push(target.table);
    }
  }

  for (const [tableName, columns] of columnsByTable) {
    // 同 DDL 列并一条(向量三列/同型 FIXED_DICT 键);异型键逐条展开
    const columnsByBody = new Map<string, TableFieldDescriptor[]>();
    for (const column of columns) {
      const body = renderColumnDdlBody(column);
      const group = columnsByBody.get(body) ?? [];
      group.push(column);
      columnsByBody.set(body, group);
    }
    for (const [body, group] of columnsByBody) {
      const names = group.map(column => `\`${column.name}\``).join('、');
      const constraint = describeColumnValueConstraint(group[0]);
      parts.push(
        `${qualifiedTable(tableName)}.${names} = ${body}${constraint ? `(取值 ${constraint})` : ''}`
      );
    }
  }

  for (const table of childTables) {
    const parentNote = table.parentTableName
      ? `,元素行经 \`parentID\` 关联 \`${table.parentTableName}\``
      : '';
    parts.push(`子表 ${qualifiedTable(table.name)}(ARRAY/组件元素逐行一条${parentNote})`);
    // 批B:子表悬停直接给出可粘贴的 JOIN 语句(属性→字段映射最容易错的地方)
    const joinSelect = renderChildTableJoinSelectFor(storage.database, table);
    if (joinSelect) {
      parts.push(`子表 JOIN: ${joinSelect}`);
    }
  }

  return parts.length > 0 ? parts.join('; ') : null;
}

/** 数字/浮点列类型体:显示宽度只在 def 声明 DatabaseLength 时输出
 * (引擎 datalength_==0 时整段剥掉 "(@DATALEN@)",:1643-1659);
 * unsigned 后缀按引擎模板排在宽度之后(int(@DATALEN@) unsigned) */
function digitColumnBody(field: TableFieldDescriptor): string {
  const label = field.typeLabel;
  const unsignedSuffix = label.endsWith(' unsigned') ? ' unsigned' : '';
  const base = unsignedSuffix ? label.slice(0, -unsignedSuffix.length) : label;
  const lengthPart = field.databaseLength && field.databaseLength > 0 ? `(${field.databaseLength})` : '';
  return `${base}${lengthPart}${unsignedSuffix} not null DEFAULT ${defaultRowValue(field)}`;
}

/** 索引片段:UNIQUE/INDEX 属性列(引擎 syncIndexToDB ADD {type} {name}({len}))与结构索引 */
function renderIndexDdl(field: TableFieldDescriptor): string | null {
  if (field.indexType !== 'INDEX' && field.indexType !== 'UNIQUE') {
    return null;
  }
  const columnType = resolveColumnValueType(field);
  const lengthPart = (columnType.kind === 'string' || columnType.kind === 'blob') && field.databaseLength
    ? `(${field.databaseLength})`
    : '';
  return `${field.indexType} (${field.name}${lengthPart})`;
}

/**
 * 每张表的完整 CREATE TABLE:引擎本体是 CREATE(id/parentID)+逐列 ALTER
 * (entity_table_mysql.cpp:390-395、:51-57),此处按快照列序内联为单语句,
 * 列型/默认值/索引与引擎逐项同形;无外键(引擎 DDL 无 FOREIGN KEY)。
 */
export function renderMysqlDdl(snapshot: DatabaseSchemaSnapshot): string {
  const sections: string[] = [];
  for (const table of snapshot.tables) {
    const lines: string[] = [];
    lines.push(`-- ${table.name} (${table.kind})`);
    lines.push(`CREATE TABLE IF NOT EXISTS ${table.name} (`);

    const columnLines: string[] = [];
    const indexLines: string[] = [];
    for (const field of table.fields) {
      if (field.name === 'id') {
        columnLines.push('id bigint(20) unsigned AUTO_INCREMENT');
        continue;
      }
      columnLines.push(renderColumnDdl(field));
      if (field.name === 'sm_autoLoad') {
        indexLines.push('INDEX (sm_autoLoad)');
        continue;
      }
      const indexLine = renderIndexDdl(field);
      if (indexLine) {
        indexLines.push(indexLine);
      }
    }

    lines.push(...columnLines.map(line => `  ${line},`));
    lines.push('  PRIMARY KEY idKey (id)');
    if (indexLines.length > 0) {
      lines.push(...indexLines.map(line => `, ${line}`));
    }
    lines.push(') ENGINE=InnoDB;');
    sections.push(lines.join('\n'));
  }
  return sections.join('\n\n');
}

/** 行数据 JSON:表名 → 行数组(id + 各列值),表序/行序按快照与模拟分配 */
export function renderRowsJson(snapshot: DatabaseSchemaSnapshot, store: SimulatedRowStore): string {
  const document: Record<string, unknown[]> = {};
  for (const table of snapshot.tables) {
    document[table.name] = (store.get(table.name) ?? []).map(row => ({ id: row.id, ...row.values }));
  }
  return `${JSON.stringify(document, null, 2)}\n`;
}

/**
 * INSERT 形态对齐引擎 sqlstatement.h:69-122(insert into tbl_X (cols) values(..);,
 * 引擎不含 id 列,由 AUTO_INCREMENT 分配)。引擎的 sm_autoLoad 由
 * entityShouldAutoLoad 单独 UPDATE(entity_table_mysql.cpp:766-775),导出语句
 * 把它并入 INSERT 以便单语句重建整行——差异已列入 SIMULATION_DIFFERENCES。
 */
export function renderInsertStatements(snapshot: DatabaseSchemaSnapshot, store: SimulatedRowStore): string {
  const lines: string[] = [];
  for (const table of snapshot.tables) {
    for (const row of store.get(table.name) ?? []) {
      const columns: string[] = [];
      const values: string[] = [];
      for (const field of table.fields) {
        if (field.name === 'id') {
          continue;
        }
        columns.push(field.name);
        const value = row.values[field.name];
        values.push(typeof value === 'string' ? `'${escapeSqlText(value)}'` : String(value));
      }
      lines.push(`insert into ${table.name} (${columns.join(', ')}) values(${values.join(', ')});`);
    }
  }
  return lines.join('\n');
}

/**
 * 与真实引擎的已知差异(如实登记,均带引擎出处;模拟功能不覆盖这些面):
 * 逐条说明见 docs/guide/database-simulation.md。
 */
export const SIMULATION_DIFFERENCES: readonly string[] = [
  'redis 后端不模拟:引擎另有 kbe/src/lib/db_redis,快照与模拟按 mysql 单口径(审计块19 遗留①)',
  '列序按快照文档序;引擎 CREATE 只含 id/parentID,其余列经逐列 ALTER 追加,物理列序取决于 ALTER 时序(entity_table_mysql.cpp:390-395、:51-57)',
  '无外键:引擎 DDL 无 FOREIGN KEY/REFERENCES,子表仅靠 parentID 逻辑关联,导出 DDL 同形',
  'UNIQUE 冲突引擎不做写前校验,由 MySQL 索引失败令 writeTable 返回 0(dbmgr.cpp:1044-1066;kbe_table_mysql.cpp:187/:352 的 1062 分支已注释);模拟器改为预检并报 unique',
  'AUTO_INCREMENT 起点模拟取 1;引擎读 dbInterface <autoIncrementInit>(serverconfig.cpp:1043-1045 → db_interface_mysql.cpp:775-787)',
  'ARRAY 子表行序=子表行 id 升序,引擎 UPDATE 按升序逐位覆盖、多余行删除(write_entity_helper.h:92-230);模拟增改删按 id 寻址,不实现按位置覆盖',
  '引擎 INSERT 不含 id(AUTO_INCREMENT)且 sm_autoLoad 由 entityShouldAutoLoad 单独 UPDATE(entity_table_mysql.cpp:766-775);导出 INSERT 并入 sm_autoLoad 以便单语句重建整行',
  'varchar 长度取 DatabaseLength 缺省 255(entity_table_mysql.cpp:1829-1833);引擎在线比对另有 MBMAXLEN(=3) 折算(db_interface_mysql.h:16-18),模拟不折算',
  '数字列 DEFAULT 引擎按 def <Default> 原文插值,非数字默认会让 MySQL 建列报错;模拟按数值解析,解析不动落 0',
  '引擎子表行恒有父 id(parentID NOT NULL);模拟允许 parentID=0 表示无父行,仅出现在父表无模拟行的嵌套场景',
  'bigint 边界值经 JS number 有舍入,|值|>2^53 时型别校验按舍入后的值判定(引擎为 uint64 精确值)'
];

/** 虚拟文档全量文本:DDL + 行 JSON + INSERT + 差异说明 */
export function renderSimulationDocument(
  snapshot: DatabaseSchemaSnapshot | null,
  store: SimulatedRowStore | null
): string {
  if (!snapshot || !store) {
    return '# KBEngine Database Simulation\n\nNo schema available.\n';
  }

  const lines: string[] = [
    `# KBEngine Database Simulation: ${snapshot.entityName}`,
    '',
    'Backend: MYSQL (simulated, engine InnoDB)'
  ];
  if (snapshot.defFilePath) {
    lines.push(`Source: ${snapshot.defFilePath}`);
  }
  lines.push(
    '',
    '## DDL',
    '',
    '```sql',
    renderMysqlDdl(snapshot),
    '```',
    '',
    '## 行数据 (JSON)',
    '',
    '```json',
    renderRowsJson(snapshot, store).trimEnd(),
    '```',
    '',
    '## INSERT 语句',
    '',
    '```sql',
    renderInsertStatements(snapshot, store),
    '```',
    '',
    '## 与真实引擎的差异',
    '',
    ...SIMULATION_DIFFERENCES.map(entry => `- ${entry}`),
    ''
  );
  return lines.join('\n');
}

export const KBENGINE_DATABASE_SIMULATION_SCHEME = 'kbengine-db-simulation';

export function createDatabaseSimulationUri(entityName: string): vscode.Uri {
  return vscode.Uri.parse(
    `${KBENGINE_DATABASE_SIMULATION_SCHEME}://${encodeURIComponent(entityName)}.dbsim`
  );
}

export function isDatabaseSimulationDocument(document: Pick<vscode.TextDocument, 'uri'>): boolean {
  return document.uri.scheme === KBENGINE_DATABASE_SIMULATION_SCHEME;
}

/** 模拟虚拟文档 uri → 实体名(供导出默认文件名等使用) */
export function getSimulationEntityName(uri: vscode.Uri): string {
  return decodeURIComponent(uri.path.replace(/^\/+/, '').replace(/\.dbsim$/, ''));
}

/** 实体名 → 模拟文档全文(快照缺失如实落空态,不虚构表结构) */
export function buildDatabaseSimulationText(entityName: string): string {
  const snapshot = getDatabaseSchemaSnapshot(entityName);
  if (!snapshot) {
    return renderSimulationDocument(null, null);
  }
  return renderSimulationDocument(snapshot, simulateInitialRows(snapshot));
}

export class KBEngineDatabaseSimulationProvider implements vscode.TextDocumentContentProvider {
  private readonly onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.onDidChangeEmitter.event;

  provideTextDocumentContent(uri: vscode.Uri): string {
    return buildDatabaseSimulationText(getSimulationEntityName(uri));
  }

  /** IDE-SCH-005:全部打开中的 .dbsim 文档重取(表前缀切换即刻换新表名) */
  refresh(): void {
    for (const document of vscode.workspace.textDocuments) {
      if (document.uri.scheme === KBENGINE_DATABASE_SIMULATION_SCHEME) {
        this.onDidChangeEmitter.fire(document.uri);
      }
    }
  }

  dispose(): void {
    this.onDidChangeEmitter.dispose();
  }
}
