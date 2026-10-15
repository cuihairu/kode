import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';
import {
  DefDocument,
  DefElementNode,
  getDirectChildElement,
  getDirectChildElements,
  getElementText,
  getLineNumberAt,
  getScalarChildValue,
  parseDefDocument
} from './defParser';
import {
  DefinitionCategory,
  findDefinitionFileByCategory,
  findEntityDefinitionFile,
  getDefinitionEntries,
  getDefinitionWorkspaceLayout,
  getRegisteredEntities,
  getWorkspaceRootForDocument
} from './definitionWorkspace';
import { resolveDatabaseInterfaceConfig, type DatabaseInterfaceConfig } from './serverConfigMerge';

export const KBENGINE_DATABASE_SCHEMA_SCHEME = 'kbengine-db-schema';
const DB_TABLE_PREFIX = 'tbl_';
const DB_COLUMN_PREFIX = 'sm_';

export type RuntimeScope = 'base' | 'cell' | 'client';
export type DatabaseBackend = 'mysql' | 'redis';

export interface DefSourceRef {
  filePath: string;
  line: number;
  path: string;
  category: DefinitionCategory;
}

export interface PersistentPropertyDescriptor {
  name: string;
  typeName: string;
  /** 属性声明处的原始 <Type> 文本(别名不解析):types.xml 反扫按它命中使用处 */
  declaredType?: string;
  persistent: boolean;
  databaseLength?: number;
  defaultValue?: string;
  identifier: boolean;
  indexType?: string;
  flags?: string;
  scopes: RuntimeScope[];
  source: DefSourceRef;
  children?: PersistentPropertyDescriptor[];
  arrayElement?: PersistentPropertyDescriptor;
  componentTypeName?: string;
}

export interface TableFieldDescriptor {
  name: string;
  typeLabel: string;
  /** 落列属性的原始 <Type> 文本(别名不解析);合成引擎列没有声明处 */
  declaredType?: string;
  sourcePath: string;
  source: DefSourceRef;
  databaseLength?: number;
  defaultValue?: string;
  indexType?: string;
  identifier: boolean;
  flags?: string;
  /** 引擎结构列(id/sm_autoLoad/parentID/位置朝向六列):不由 def 属性推导,
   *  「属性列集」SQL 模板据此把它们剔掉 */
  synthetic?: boolean;
}

export interface TableSchemaDescriptor {
  name: string;
  kind: 'entity' | 'array' | 'component';
  title: string;
  source: DefSourceRef;
  parentTableName?: string;
  propertyPath?: string;
  fields: TableFieldDescriptor[];
}

export interface DatabaseSchemaSnapshot {
  backend: DatabaseBackend;
  entityName: string;
  entitySource?: DefSourceRef;
  defFilePath?: string;
  tables: TableSchemaDescriptor[];
  tableIndex: Map<string, TableSchemaDescriptor>;
  /** 引擎配置 <dbmgr><databaseInterfaces><default> 读得的连接要素(未读得为 undefined) */
  database?: DatabaseInterfaceConfig;
}

// types.xml 别名条目(批98 对齐 DataTypes::loadTypes):根节点直接子元素的标签名
// 即别名,首个文本子节点为类型指引——"FIXED_DICT"/"ARRAY" 为结构别名(结构体
// 就地声明在同一元素下),其余文本按内置类型或别名链解析。
type TypeAliasEntry =
  | { kind: 'builtin'; target: string }
  | { kind: 'fixedDict'; node: DefElementNode; document: DefDocument; filePath: string }
  | { kind: 'array'; node: DefElementNode; document: DefDocument; filePath: string }
  | { kind: 'unresolved' };

type ResolvedAliasType =
  | { kind: 'builtin'; typeName: string }
  | { kind: 'fixedDict'; node: DefElementNode; document: DefDocument; filePath: string }
  | { kind: 'array'; node: DefElementNode; document: DefDocument; filePath: string }
  | { kind: 'unresolved' };

interface BuildContext {
  workspaceRoot: string;
  entityDefsRoot: string;
  entityScriptsRoot: string | null;
  visitedDefinitions: Set<string>;
  componentCache: Map<string, PersistentPropertyDescriptor[]>;
  componentScopesCache: Map<string, RuntimeScope[]>;
  typeAliases: Map<string, TypeAliasEntry>;
  entityHasCell: boolean;
}

// 旗标 → 运行域成员映射,成员集对齐引擎 common.h 的三个域掩码
// (ENTITY_BASE/CELL/CLIENT_DATA_FLAGS)与 entitydef.cpp g_entityFlagMapping 的
// 12 个旗标名(CELL 别名落到 CELL_PUBLIC 位,域成员不变)。
const FLAG_SCOPE_MAP: Record<string, RuntimeScope[]> = {
  BASE: ['base'],
  BASE_AND_CLIENT: ['base', 'client'],
  CELL: ['cell'],
  CELL_PUBLIC: ['cell'],
  CELL_PRIVATE: ['cell'],
  ALL_CLIENTS: ['cell', 'client'],
  CELL_PUBLIC_AND_OWN: ['cell', 'client'],
  OWN_CLIENT: ['cell', 'client'],
  OTHER_CLIENTS: ['cell', 'client'],
  CELL_AND_CLIENT: ['cell', 'client'],
  CELL_AND_CLIENTS: ['cell', 'client'],
  CELL_AND_OTHER_CLIENTS: ['cell', 'client']
};

const SIMPLE_DB_TYPE_LABELS: Record<string, string> = {
  INT8: 'tinyint',
  INT16: 'smallint',
  INT32: 'int',
  INT64: 'bigint',
  UINT8: 'tinyint unsigned',
  UINT16: 'smallint unsigned',
  UINT32: 'int unsigned',
  UINT64: 'bigint unsigned',
  FLOAT: 'float',
  DOUBLE: 'double',
  STRING: 'varchar',
  UNICODE: 'varchar',
  PYTHON: 'blob',
  PY_DICT: 'blob',
  PY_TUPLE: 'blob',
  PY_LIST: 'blob',
  BLOB: 'blob',
  ENTITYCALL: 'blob'
};

// 引擎 EntityDef::loadInterfaces 只接受这四种拼写的包装层与内层元素,
// 内层元素的标签名即接口名(getKey),不接受其它拼写、不跟随 Parent。
const INTERFACE_SPELLINGS = new Set(['Interface', 'interface', 'Type', 'type']);

// 引擎内建类型(DataTypes::getDataType 注册名):标量/字符/blob 集与向量集。
// 别名链指向它们时复用同一内建实例(addDataType 只改 aliasName,getName()
// 保持内建名),DB 层 createItem 按该实例分派 mysql 列型。
const BUILTIN_DB_TYPE_NAMES = new Set([
  ...Object.keys(SIMPLE_DB_TYPE_LABELS),
  'VECTOR2', 'VECTOR3', 'VECTOR4'
]);

export class KBEngineDatabaseSchemaProvider implements vscode.TextDocumentContentProvider {
  private readonly onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.onDidChangeEmitter.event;

  provideTextDocumentContent(uri: vscode.Uri): string {
    const entityName = decodeURIComponent(uri.path.replace(/^\/+/, '').replace(/\.schema$/, ''));
    const snapshot = getDatabaseSchemaSnapshot(entityName);
    return renderDatabaseSchema(snapshot);
  }

  refresh(entityName?: string): void {
    if (!entityName) {
      return;
    }

    this.onDidChangeEmitter.fire(createDatabaseSchemaUri(entityName));
  }

  dispose(): void {
    this.onDidChangeEmitter.dispose();
  }
}

export function createDatabaseSchemaUri(entityName: string): vscode.Uri {
  return vscode.Uri.parse(`${KBENGINE_DATABASE_SCHEMA_SCHEME}:/${encodeURIComponent(entityName)}.schema`);
}

export function isDatabaseSchemaDocument(document: Pick<vscode.TextDocument, 'uri'>): boolean {
  return document.uri.scheme === KBENGINE_DATABASE_SCHEMA_SCHEME;
}

export function getDatabaseSchemaSnapshot(
  entityName: string,
  target?: string | Pick<vscode.TextDocument, 'fileName'>
): DatabaseSchemaSnapshot | null {
  const workspaceRoot = typeof target === 'string'
    ? target
    : getWorkspaceRootForDocument(target);

  if (!workspaceRoot) {
    return null;
  }

  const layout = getDefinitionWorkspaceLayout(workspaceRoot);
  // 不可达(批62 定性):getDefinitionWorkspaceLayout 的 entityDefsRoot =
  // 已存在候选 || 候选[0],候选列表恒含非空相对路径,该值只能是字符串。
  /* istanbul ignore start */
  if (!layout.entityDefsRoot) {
    return null;
  }
  /* istanbul ignore stop */

  const defFilePath = findEntityDefinitionFile(entityName, target);
  if (!defFilePath) {
    return null;
  }

  const entityContent = readTextDocument(defFilePath);
  if (!entityContent) {
    return null;
  }

  const entityDocument = parseDefDocument(entityContent);
  if (!entityDocument.root) {
    return null;
  }

  const buildContext: BuildContext = {
    workspaceRoot,
    entityDefsRoot: layout.entityDefsRoot,
    entityScriptsRoot: layout.entityScriptsRoot,
    visitedDefinitions: new Set<string>(),
    componentCache: new Map<string, PersistentPropertyDescriptor[]>(),
    componentScopesCache: new Map<string, RuntimeScope[]>(),
    typeAliases: parseTypeAliases(layout.typesXmlPath),
    entityHasCell: resolveEntityHasCell(entityName, workspaceRoot, layout)
  };
  const entitySource: DefSourceRef = {
    filePath: defFilePath,
    line: 1,
    path: entityName,
    category: 'entity'
  };
  const properties = collectPersistentPropertiesForDefinition(
    entityName,
    defFilePath,
    'entity',
    buildContext
  );
  const tables = buildMysqlTableSchemas(
    entityName,
    entitySource,
    properties,
    buildContext.entityHasCell,
    resolveSchemaTablePrefix()
  );
  const tableIndex = new Map<string, TableSchemaDescriptor>(tables.map(table => [table.name, table]));
  // 批131 用户令:连接信息直接读 KBEngine 自身配置,SQL 与悬停带真实库表名
  const database = resolveDatabaseInterfaceConfig() ?? undefined;

  return {
    backend: 'mysql',
    entityName,
    entitySource,
    defFilePath,
    tables,
    tableIndex,
    database
  };
}

// 渲染版式锚点(TABLE 行 / 字段行)与 renderDatabaseSchema 同源:定位跳转与
// 悬停都从这里取,不再各处手写镜像行数(批133 用户令:版式改版式,定位
// 就跟着失效)。字段行允许前导空白(友好版式里列行缩进),但首 token 后必须
// 是空白——SQL 行的 `SQL:` 冒号与中文分组标题都不会误命中。
const DATABASE_SCHEMA_TABLE_ANCHOR = /^\s*TABLE\s+([A-Za-z0-9_]+)/;
const DATABASE_SCHEMA_FIELD_LINE = /^\s*([A-Za-z0-9_]+)\s+/;

export function databaseSchemaFieldLineName(lineText: string): string | null {
  if (DATABASE_SCHEMA_TABLE_ANCHOR.test(lineText)) {
    return null;
  }
  const match = DATABASE_SCHEMA_FIELD_LINE.exec(lineText);
  return match ? match[1] : null;
}

export function findDatabaseSchemaFieldAtPosition(
  document: vscode.TextDocument,
  position: vscode.Position
): { table: string; field?: string } | null {
  const lineText = document.lineAt(position.line).text;
  const tableMatch = DATABASE_SCHEMA_TABLE_ANCHOR.exec(lineText);
  if (tableMatch) {
    return { table: tableMatch[1] };
  }

  const field = databaseSchemaFieldLineName(lineText);
  if (!field) {
    return null;
  }

  for (let currentLine = position.line - 1; currentLine >= 0; currentLine -= 1) {
    const currentTableMatch = DATABASE_SCHEMA_TABLE_ANCHOR.exec(document.lineAt(currentLine).text);
    if (currentTableMatch) {
      return {
        table: currentTableMatch[1],
        field
      };
    }
  }

  return null;
}

export function findDatabaseSchemaSourceLocation(
  snapshot: DatabaseSchemaSnapshot,
  tableName: string,
  fieldName?: string
): DefSourceRef | null {
  const table = snapshot.tableIndex.get(tableName);
  if (!table) {
    return null;
  }

  if (!fieldName) {
    return table.source;
  }

  return table.fields.find(field => field.name === fieldName)?.source || null;
}

export function findDatabaseSchemaTargetsForSource(
  snapshot: DatabaseSchemaSnapshot,
  filePath: string,
  sourcePath: string
): Array<{ tableName: string; fieldName?: string }> {
  const targets: Array<{ tableName: string; fieldName?: string }> = [];
  const normalizedFilePath = normalizePath(filePath);

  for (const table of snapshot.tables) {
    if (
      normalizePath(table.source.filePath) === normalizedFilePath
      && (
        table.source.path === sourcePath
        || table.source.path.startsWith(`${sourcePath}.`)
      )
    ) {
      targets.push({ tableName: table.name });
    }

    for (const field of table.fields) {
      if (
        normalizePath(field.source.filePath) === normalizedFilePath
        && (
          field.sourcePath === sourcePath
          || field.sourcePath.startsWith(`${sourcePath}.`)
        )
      ) {
        targets.push({ tableName: table.name, fieldName: field.name });
      }
    }
  }

  return dedupeSchemaTargets(targets);
}

export interface PropertyDatabaseStorageTarget {
  tableName: string;
  fieldName?: string;
  /** 命中列的全量描述(类型/长度/默认值),悬停拼 DDL 摘要用 */
  field?: TableFieldDescriptor;
  /** 命中子表的全量描述(ARRAY/组件槽),悬停说明去向与 parentID 关联用 */
  table?: TableSchemaDescriptor;
}

export interface PropertyDatabaseStorageInfo {
  entityName: string;
  /** 引擎配置读得的连接要素;未读得为 undefined,悬停只给表级全名 */
  database?: DatabaseInterfaceConfig;
  targets: PropertyDatabaseStorageTarget[];
}

/**
 * def 属性的数据库存储落点(2026-10-13 用户令:Persistent 字段悬停展示在
 * 数据库中的名字)。按属性路径查快照目标:标量/向量/FIXED_DICT 键链出
 * 列名(sm_ 前缀),ARRAY/组件槽出子表;types.xml 别名在快照构建时已沿
 * 别名链展开。聚合只按属性路径、不按来源文件过滤——别名/组件结构的
 * 子列 source.filePath 是 types.xml/组件 def(结构定义文件),schema 反向
 * 跳转才需要严格文件口径。非持久属性不建表无目标,返回 null。
 * 批131:目标带全量列/表描述与连接要素,悬停拼 db.table.column 全名。
 */
export function describePropertyDatabaseStorage(
  entityName: string,
  propertyName: string,
  target?: string | Pick<vscode.TextDocument, 'fileName'>
): PropertyDatabaseStorageInfo | null {
  const snapshot = getDatabaseSchemaSnapshot(entityName, target);
  if (!snapshot) {
    return null;
  }

  const targets: PropertyDatabaseStorageTarget[] = [];
  for (const table of snapshot.tables) {
    if (
      table.source.path === propertyName
      || table.source.path.startsWith(`${propertyName}.`)
    ) {
      targets.push({ tableName: table.name, table });
    }

    for (const field of table.fields) {
      if (
        field.sourcePath === propertyName
        || field.sourcePath.startsWith(`${propertyName}.`)
      ) {
        targets.push({ tableName: table.name, fieldName: field.name, field });
      }
    }
  }

  if (targets.length === 0) {
    return null;
  }

  return {
    entityName: snapshot.entityName,
    database: snapshot.database,
    targets: dedupeSchemaTargets(targets)
  };
}

// 表名反引号引用(粘贴进外部 MySQL 客户端不撞保留字);库名读得时带库前缀
export function quoteSchemaTableName(snapshot: DatabaseSchemaSnapshot, tableName: string): string {
  return quoteTableName(snapshot.database, tableName);
}

function quoteTableName(database: DatabaseInterfaceConfig | undefined, tableName: string): string {
  return database ? `\`${database.databaseName}\`.\`${tableName}\`` : `\`${tableName}\``;
}

/** 引擎结构列(id/sm_autoLoad/parentID/位置朝向)之外的属性列 */
function propertyColumnsOf(table: TableSchemaDescriptor): TableFieldDescriptor[] {
  return table.fields.filter(field => !field.synthetic);
}

/**
 * 属性列集 SELECT(批B):只列 def 属性落成的列,剔掉引擎结构列——
 * 「我自己定义了哪些字段」直接可查,不必在 `SELECT *` 里肉眼挑。
 */
export function renderPropertyColumnSelect(
  snapshot: DatabaseSchemaSnapshot,
  table: TableSchemaDescriptor
): string | null {
  return renderPropertyColumnSelectFor(snapshot.database, table);
}

/** 同 renderPropertyColumnSelect,只吃连接要素(悬停侧手上没有快照时用) */
export function renderPropertyColumnSelectFor(
  database: DatabaseInterfaceConfig | undefined,
  table: TableSchemaDescriptor
): string | null {
  const columns = propertyColumnsOf(table);
  if (columns.length === 0) {
    return null;
  }

  const names = columns.map(field => `\`${field.name}\``).join(', ');
  return `SELECT ${names} FROM ${quoteTableName(database, table.name)} LIMIT 100;`;
}

/**
 * 子表 JOIN(批B):元素行经 `parentID` 关联父表(引擎 EntityTableItemMysql
 * 给每张子表固定 parentID 列),LEFT JOIN 保住无元素的属性行。
 */
export function renderChildTableJoinSelect(
  snapshot: DatabaseSchemaSnapshot,
  table: TableSchemaDescriptor
): string | null {
  return renderChildTableJoinSelectFor(snapshot.database, table);
}

/** 同 renderChildTableJoinSelect,只吃连接要素(悬停侧手上没有快照时用) */
export function renderChildTableJoinSelectFor(
  database: DatabaseInterfaceConfig | undefined,
  table: TableSchemaDescriptor
): string | null {
  if (!table.parentTableName) {
    return null;
  }

  const columns = table.fields.map(field => `c.\`${field.name}\``);
  if (columns.length === 0) {
    return null;
  }

  return [
    `SELECT p.\`id\` AS parentID, ${columns.join(', ')}`,
    `FROM ${quoteTableName(database, table.parentTableName)} AS p`,
    `LEFT JOIN ${quoteTableName(database, table.name)} AS c ON c.\`parentID\` = p.\`id\``,
    'LIMIT 100;'
  ].join(' ');
}

/**
 * 每表尾部 SQL 行:最小 SELECT(全列)+ 属性列集 + 子表 JOIN(仅子表)。
 * 渲染与行号定位共用这一产出,两处不会各自漂移。
 */
export function renderTableSqlLines(
  snapshot: DatabaseSchemaSnapshot,
  table: TableSchemaDescriptor
): string[] {
  const result: string[] = [`SQL: SELECT * FROM ${quoteSchemaTableName(snapshot, table.name)} LIMIT 100;`];
  const propertySelect = renderPropertyColumnSelect(snapshot, table);
  if (propertySelect) {
    result.push(`SQL(属性列): ${propertySelect}`);
  }
  const joinSelect = renderChildTableJoinSelect(snapshot, table);
  if (joinSelect) {
    result.push(`SQL(子表 JOIN): ${joinSelect}`);
  }
  return result;
}

/** 根表(实体表)名:优先取快照里的实体表;快照未建表时按配置前缀回落 */
export function resolveEntityTableName(
  entityName: string,
  snapshot: DatabaseSchemaSnapshot | null
): string {
  const rootTable = snapshot?.tables.find(table => table.kind === 'entity');
  return rootTable?.name ?? `${resolveSchemaTablePrefix()}${entityName}`;
}

export function locateDatabaseSchemaLine(
  snapshot: DatabaseSchemaSnapshot,
  tableName: string,
  fieldName?: string
): number {
  // 定位从渲染文本里找锚点,不再手写镜像版式行数(批133 用户令:友好版式改版后
  // 原 `line = 6` / `+= 5` / `+= 2` 的镜像计数全部失效)
  const lines = renderDatabaseSchema(snapshot).split('\n');
  const tableStart = lines.findIndex(line => {
    const match = DATABASE_SCHEMA_TABLE_ANCHOR.exec(line);
    return match !== null && match[1] === tableName;
  });
  if (tableStart === -1) {
    return 1;
  }
  if (!fieldName) {
    return tableStart + 1;
  }

  let blockEnd = lines.length;
  for (let index = tableStart + 1; index < lines.length; index += 1) {
    if (DATABASE_SCHEMA_TABLE_ANCHOR.test(lines[index])) {
      blockEnd = index;
      break;
    }
  }
  for (let index = tableStart + 1; index < blockEnd; index += 1) {
    if (databaseSchemaFieldLineName(lines[index]) === fieldName) {
      return index + 1;
    }
  }
  // 表在、字段不在(改名或未落列):与旧实现同口径退首行,不高亮错行
  return 1;
}

// 引擎自动建的固定几列,语义固定(建表与 EntityTableItemMysql 的实现都是写死
// 的),直接给注解;其余引擎列只报索引与来源键
const SYNTHETIC_COLUMN_NOTES: Record<string, string> = {
  id: '主键（自增）',
  autoLoad: '带索引；标记是否已读入内存',
  parentID: '带索引；指回父表主键',
  'position.x': '位置 x（引擎为 hasCell 实体预留 6 列）',
  'position.y': '位置 y',
  'position.z': '位置 z',
  'direction.roll': '方向 roll',
  'direction.pitch': '方向 pitch',
  'direction.yaw': '方向 yaw'
};

const TABLE_KIND_LABELS: Record<TableSchemaDescriptor['kind'], string> = {
  entity: '实体表',
  component: '组件表',
  array: '数组子表'
};

// 工作区内给相对路径,工作区外照给绝对路径(不虚构相对关系);undefined 的
// defFilePath 在调用侧(622)已先行折算,这里只收字符串
function displaySourcePath(filePath: string): string {
  for (const folder of vscode.workspace.workspaceFolders || []) {
    const relative = path.relative(folder.uri.fsPath, filePath);
    if (relative && !relative.startsWith('..')) {
      return relative;
    }
  }
  return filePath;
}

export function renderDatabaseSchema(snapshot: DatabaseSchemaSnapshot | null): string {
  if (!snapshot) {
    return '# KBEngine Database Schema\n\nNo schema available.\n';
  }

  const lines: string[] = [];
  lines.push(`# 数据库表结构: ${snapshot.entityName}`);
  lines.push('');
  if (snapshot.database) {
    lines.push(
      `数据库: ${snapshot.database.databaseName}@${snapshot.database.host}:${snapshot.database.port}`
    );
  }
  lines.push(`存储引擎: MySQL`);
  lines.push(`定义文件: ${snapshot.defFilePath ? displaySourcePath(snapshot.defFilePath) : `${snapshot.entityName}.def`}`);
  const propertyColumns = snapshot.tables.reduce(
    (sum, table) => sum + table.fields.filter(field => !field.synthetic).length,
    0
  );
  const totalColumns = snapshot.tables.reduce((sum, table) => sum + table.fields.length, 0);
  lines.push(`表: ${snapshot.tables.length} 张 · 列: ${totalColumns}（其中 .def 声明 ${propertyColumns}）`);
  lines.push('');
  lines.push('读图方式');
  lines.push('  - tbl_ 表前缀与 sm_ 列前缀由引擎加（表前缀可用 kbengine.db.tablePrefix 改）');
  lines.push('  - 引擎列由引擎自动建（id / autoLoad / parentID / 位置朝向 6 列），.def 里不用声明；属性列才是你在 .def 里写的');
  lines.push('  - 组件表与数组子表用 parentID 指回父表；数组子表一行一个元素');
  lines.push('  - flags= 是 .def 声明的可见域（BASE / CELL / CLIENT 及其组合），BASE_AND_CLIENT 表示 base 脚本与客户端都能读写');
  lines.push('  - 表尾 SQL 可直接粘进 MySQL 客户端（默认查 100 行）');
  lines.push('');

  for (const table of snapshot.tables) {
    // TABLE 锚点行与 SQL 三行保持原样:跳转定位与文档说明按它们解析
    lines.push(`TABLE ${table.name}`);
    lines.push(`表类型: ${TABLE_KIND_LABELS[table.kind]}`);
    if (table.parentTableName) {
      lines.push(`父表: ${table.parentTableName}`);
    }
    lines.push(`定义来源: ${displaySourcePath(table.source.filePath)}:${table.source.line}`);
    lines.push('');

    const syntheticFields = table.fields.filter(field => field.synthetic);
    const propertyFields = table.fields.filter(field => !field.synthetic);
    const columnWidth = Math.max(8, ...table.fields.map(field => field.name.length));

    if (syntheticFields.length > 0) {
      lines.push('引擎列（引擎自动建，.def 无需声明）');
      for (const field of syntheticFields) {
        lines.push(renderFieldLine(field, columnWidth, syntheticColumnNote(field)));
      }
    }

    if (propertyFields.length > 0) {
      lines.push('属性列（.def 里声明的）');
      for (const field of propertyFields) {
        lines.push(renderFieldLine(field, columnWidth, ''));
      }
    } else if (syntheticFields.length > 0) {
      // 空表照实提示,不让读者以为是自己漏看了
      lines.push('属性列: 无（本表只有引擎列，没有 .def 声明的数据列）');
    }

    // 每表三行可粘贴 SQL(带库表前缀与反引号转义,直接进外部客户端)
    for (const sqlLine of renderTableSqlLines(snapshot, table)) {
      lines.push(sqlLine);
    }
    lines.push('');
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

function renderFieldLine(
  field: TableFieldDescriptor,
  columnWidth: number,
  note: string
): string {
  const details: string[] = [field.typeLabel];
  if (field.databaseLength !== undefined) {
    details.push(`长度 ${field.databaseLength}`);
  }
  if (field.indexType) {
    details.push(`索引 ${field.indexType}`);
  }
  if (field.identifier) {
    details.push('唯一标识');
  }
  if (field.flags) {
    details.push(`flags=${field.flags}`);
  }
  if (field.defaultValue !== undefined) {
    details.push(`默认值 ${field.defaultValue}`);
  }
  if (note) {
    details.push(note);
  }
  // 属性列尾部标 def 落点,悬停与跳转按它回 def
  const suffix = field.synthetic || !field.source.path
    ? ''
    : `    ← ${path.basename(field.source.filePath)}:${field.source.line} <${field.source.path}>`;
  return `  ${field.name.padEnd(columnWidth)}  ${details.join('  ')}${suffix}`;
}

function syntheticColumnNote(field: TableFieldDescriptor): string {
  const note = SYNTHETIC_COLUMN_NOTES[field.sourcePath];
  if (note) {
    return note;
  }
  if (field.indexType) {
    return `带 ${field.indexType} 索引`;
  }
  return field.sourcePath ? `引擎列（${field.sourcePath}）` : '引擎列';
}

function parseTypeAliases(typesXmlPath: string | null): Map<string, TypeAliasEntry> {
  const aliases = new Map<string, TypeAliasEntry>();
  if (!typesXmlPath) {
    return aliases;
  }

  const content = readTextDocument(typesXmlPath);
  if (!content) {
    return aliases;
  }

  const document = parseDefDocument(content);
  if (!document.root) {
    return aliases;
  }

  for (const item of getDirectChildElements(document.root)) {
    // 引擎 DataTypes::loadTypes:别名 = 条目标签名,类型指引 = 首个文本子节点
    // (getValStr(FirstChild)),"FIXED_DICT"/"ARRAY" 走结构解析,其余文本按
    // 已注册类型(内置或更早的别名)复用同一实例。
    const directive = getElementText(item).trim();
    if (directive === 'FIXED_DICT') {
      aliases.set(item.name, { kind: 'fixedDict', node: item, document, filePath: typesXmlPath });
    } else if (directive === 'ARRAY') {
      aliases.set(item.name, { kind: 'array', node: item, document, filePath: typesXmlPath });
    } else if (directive) {
      aliases.set(item.name, { kind: 'builtin', target: directive });
    } else {
      aliases.set(item.name, { kind: 'unresolved' });
    }
  }

  return aliases;
}

function resolveAliasType(typeName: string, context: BuildContext, seen = new Set<string>()): ResolvedAliasType {
  if (typeName === 'ARRAY' || typeName === 'FIXED_DICT') {
    return { kind: 'builtin', typeName };
  }

  const entry = context.typeAliases.get(typeName);
  if (!entry || entry.kind === 'unresolved') {
    return { kind: 'unresolved' };
  }

  if (entry.kind === 'fixedDict' || entry.kind === 'array') {
    return entry;
  }

  // 指引直接落内建类型:复用同一内建实例(引擎 getDataType 只认注册名)
  if (BUILTIN_DB_TYPE_NAMES.has(entry.target)) {
    return { kind: 'builtin', typeName: entry.target };
  }

  if (seen.has(entry.target)) {
    return { kind: 'unresolved' };
  }

  seen.add(typeName);
  return resolveAliasType(entry.target, context, seen);
}

// 引擎加载语义下的有效类型名:别名解析到被指向的同一实例(DataTypes::addDataType
// 只改 aliasName,getName() 保持内置名,DB 层 createItem 按 getName() 分派)。
function resolveEffectiveTypeName(typeName: string, context: BuildContext): string {
  const resolved = resolveAliasType(typeName, context);
  if (resolved.kind === 'builtin') {
    return resolved.typeName;
  }
  if (resolved.kind === 'fixedDict') {
    return 'FIXED_DICT';
  }
  if (resolved.kind === 'array') {
    return 'ARRAY';
  }
  return typeName;
}

function collectPersistentPropertiesForDefinition(
  definitionName: string,
  filePath: string,
  category: DefinitionCategory,
  context: BuildContext
): PersistentPropertyDescriptor[] {
  const normalizedPath = normalizePath(filePath);
  if (context.visitedDefinitions.has(normalizedPath)) {
    return [];
  }
  context.visitedDefinitions.add(normalizedPath);

  const content = readTextDocument(filePath);
  if (!content) {
    return [];
  }

  const document = parseDefDocument(content);
  const root = document.root;
  if (!root) {
    return [];
  }

  const properties = new Map<string, PersistentPropertyDescriptor>();

  mergeProperties(properties, parsePropertySection(
    getDirectChildElement(root, 'Properties'),
    document,
    filePath,
    category,
    definitionName,
    context
  ));

  // 接口只装载自身 Properties 与方法段(loadAllDefDescriptions),不跟随
  // 自己的 Interfaces/Components/Parent;其余类目按引擎继续下钻。
  if (category !== 'interface') {
    mergeInterfaces(properties, root, filePath, category, context);

    // 此处类目只可能是 entity/component(接口在上方提前 return),而引擎
    // Components 段对这两类都装载(loadAllDefDescriptions)
    mergeComponents(properties, root, document, filePath, category, context);

    const parentNode = getDirectChildElement(root, 'Parent');
    const parentName = getTypeRefName(parentNode);
    if (parentName) {
      const parentCategory = category === 'component' ? 'component' : 'entity';
      const parentPath = findDefinitionFileByCategory(parentName, parentCategory, context.workspaceRoot)
        || (parentCategory === 'entity' ? findEntityDefinitionFile(parentName, context.workspaceRoot) : null);

      if (parentPath) {
        mergeProperties(
          properties,
          collectPersistentPropertiesForDefinition(parentName, parentPath, parentCategory, context)
        );
      }
    }
  }

  return [...properties.values()];
}

function mergeInterfaces(
  properties: Map<string, PersistentPropertyDescriptor>,
  root: DefElementNode,
  filePath: string,
  category: DefinitionCategory,
  context: BuildContext
): void {
  const interfacesNode = getDirectChildElement(root, 'Interfaces');
  if (!interfacesNode) {
    return;
  }

  for (const interfaceWrapper of getDirectChildElements(interfacesNode)) {
    if (!INTERFACE_SPELLINGS.has(interfaceWrapper.name)) {
      continue;
    }

    // 引擎:enterNode(包装层,"Interface") 命中包装层自身,取其 FirstChild 的
    // getKey——文本优先,否则首个子元素标签名,即接口名。
    const interfaceName = getTypeRefName(interfaceWrapper);
    if (!interfaceName) {
      continue;
    }

    const interfacePath = findDefinitionFileByCategory(interfaceName, 'interface', context.workspaceRoot);
    if (!interfacePath) {
      continue;
    }

    mergeProperties(
      properties,
      collectPersistentPropertiesForDefinition(
        interfaceName,
        interfacePath,
        'interface',
        context
      )
    );
  }
}

function mergeComponents(
  properties: Map<string, PersistentPropertyDescriptor>,
  root: DefElementNode,
  document: ReturnType<typeof parseDefDocument>,
  filePath: string,
  category: DefinitionCategory,
  context: BuildContext
): void {
  const componentsNode = getDirectChildElement(root, 'Components');
  if (!componentsNode) {
    return;
  }

  for (const componentNode of getDirectChildElements(componentsNode)) {
    const componentTypeName = getTypeRefName(getDirectChildElement(componentNode, 'Type'));
    if (!componentTypeName) {
      continue;
    }

    const scopes = getComponentModuleScopes(componentTypeName, context);
    // 组件槽 <Persistent> 与 Properties 段相反:引擎 loadComponents 默认持久,
    // 仅小写 "false" 关闭。
    const isPersistent = !isFalsePersistent(componentNode);
    const componentSource: DefSourceRef = {
      filePath,
      line: getLineNumberAt(document, componentNode.tagStart),
      path: componentNode.name,
      category
    };
    const descriptor: PersistentPropertyDescriptor = {
      name: componentNode.name,
      typeName: 'ENTITY_COMPONENT',
      persistent: isPersistent,
      identifier: false,
      indexType: undefined,
      databaseLength: undefined,
      flags: undefined,
      scopes,
      source: componentSource,
      componentTypeName,
      children: isPersistent
        ? getPersistentComponentProperties(componentTypeName, context)
        : []
    };

    if (descriptor.persistent) {
      mergeProperties(properties, [descriptor]);
    }
  }
}

function parsePropertySection(
  sectionNode: DefElementNode | undefined,
  document: ReturnType<typeof parseDefDocument>,
  filePath: string,
  category: DefinitionCategory,
  definitionName: string,
  context: BuildContext
): PersistentPropertyDescriptor[] {
  if (!sectionNode) {
    return [];
  }

  const properties: PersistentPropertyDescriptor[] = [];
  for (const propertyNode of getDirectChildElements(sectionNode)) {
    const descriptor = parsePropertyNode(
      propertyNode,
      document,
      filePath,
      category,
      definitionName,
      context
    );
    if (descriptor?.persistent) {
      properties.push(descriptor);
    }
  }
  return properties;
}

function parsePropertyNode(
  propertyNode: DefElementNode,
  document: ReturnType<typeof parseDefDocument>,
  filePath: string,
  category: DefinitionCategory,
  definitionName: string,
  context: BuildContext,
  parentPath = ''
): PersistentPropertyDescriptor | null {
  const rawTypeName = getScalarChildValue(propertyNode, 'Type');
  if (!rawTypeName) {
    return null;
  }

  const flags = getScalarChildValue(propertyNode, 'Flags');
  const scopes = getPropertyScopes(flags);

  // 不可达(批69 定性):parsePropertyNode 的唯一调用点是 parsePropertySection
  // (L透传),而 parsePropertySection 的唯一调用点未传 parentPath,落默认实参 ''
  // ⇒ 此处左操作数恒空串,模板串臂无触发路径(嵌套路径由 parseFixedDictChildren
  // 的 childPath 独立构造,不经此三目)。
  /* istanbul ignore start */
  const propertyPath = parentPath ? `${parentPath}.${propertyNode.name}` : propertyNode.name;
  /* istanbul ignore stop */
  const descriptor: PersistentPropertyDescriptor = {
    name: propertyNode.name,
    typeName: rawTypeName,
    declaredType: rawTypeName,
    // Properties 段的引擎装载语义:默认不持久,文本(忽略大小写)恰为 "true"
    // 才持久(loadDefPropertys)。
    persistent: isTruePersistent(propertyNode),
    databaseLength: parseOptionalNumber(getScalarChildValue(propertyNode, 'DatabaseLength')),
    defaultValue: getScalarChildValue(propertyNode, 'Default'),
    // Identifier 严格判定:引擎只认文本 "true"(忽略大小写),自闭合/空/其它
    // 值一律不算。
    identifier: getScalarChildValue(propertyNode, 'Identifier')?.trim().toLowerCase() === 'true',
    indexType: normalizeOptionalString(getScalarChildValue(propertyNode, 'Index'))?.toUpperCase(),
    flags,
    scopes,
    source: {
      filePath,
      line: getLineNumberAt(document, propertyNode.tagStart),
      path: propertyPath,
      category
    }
  };

  if (!descriptor.persistent) {
    return descriptor;
  }

  const resolved = resolveAliasType(rawTypeName, context);
  if (rawTypeName === 'ARRAY' || resolved.kind === 'array') {
    descriptor.typeName = 'ARRAY';
    const containerNode = resolved.kind === 'array' ? resolved.node : getDirectChildElement(propertyNode, 'Type');
    const containerDocument = resolved.kind === 'array' ? resolved.document : document;
    const containerFilePath = resolved.kind === 'array' ? resolved.filePath : filePath;
    descriptor.arrayElement = parseArrayElementDescriptor(
      containerNode,
      containerDocument,
      containerFilePath,
      category,
      definitionName,
      context,
      propertyPath,
      descriptor
    );
  } else if (rawTypeName === 'FIXED_DICT' || resolved.kind === 'fixedDict') {
    descriptor.typeName = 'FIXED_DICT';
    const containerNode = resolved.kind === 'fixedDict' ? resolved.node : propertyNode;
    const containerDocument = resolved.kind === 'fixedDict' ? resolved.document : document;
    const containerFilePath = resolved.kind === 'fixedDict' ? resolved.filePath : filePath;
    descriptor.children = parseFixedDictChildren(
      containerNode,
      containerDocument,
      containerFilePath,
      category,
      definitionName,
      context,
      propertyPath,
      descriptor
    );
  } else if (resolved.kind === 'builtin') {
    descriptor.typeName = resolved.typeName;
  }

  return descriptor;
}

function parseArrayElementDescriptor(
  containerNode: DefElementNode | undefined,
  document: ReturnType<typeof parseDefDocument>,
  filePath: string,
  category: DefinitionCategory,
  definitionName: string,
  context: BuildContext,
  propertyPath: string,
  parentDescriptor: PersistentPropertyDescriptor
): PersistentPropertyDescriptor | undefined {
  const ofNode = getDirectChildElement(containerNode, 'of');
  const rawElementTypeName = getScalarChildValue(containerNode, 'of');
  if (!containerNode || !ofNode || !rawElementTypeName) {
    return undefined;
  }

  const resolved = resolveAliasType(rawElementTypeName, context);
  const elementDescriptor: PersistentPropertyDescriptor = {
    // 引擎:元素项名非 FIXED_DICT 时为 "value",FIXED_DICT 元素项名为空串
    // (空名使列名不带 value_ 前缀,且子表命名链跳过该层)。
    name: resolveEffectiveTypeName(rawElementTypeName, context) === 'FIXED_DICT' ? '' : 'value',
    typeName: rawElementTypeName,
    declaredType: rawElementTypeName,
    persistent: true,
    databaseLength: parentDescriptor.databaseLength,
    identifier: false,
    indexType: undefined,
    flags: parentDescriptor.flags,
    scopes: [...parentDescriptor.scopes],
    source: {
      filePath,
      line: getLineNumberAt(document, containerNode.tagStart),
      path: `${propertyPath}[]`,
      category
    }
  };

  // 元素类型分支按 raw 或解析后种类判定(镜像 parsePropertyNode):别名
  // FIXED_DICT/ARRAY 的结构分支与列层的 typeName 归一必须与顶层属性同规则,
  // 否则别名数组元素不建子表、别名 FD 元素不取 Properties。
  if (rawElementTypeName === 'ARRAY' || resolved.kind === 'array') {
    elementDescriptor.typeName = 'ARRAY';
    // 别名数组的元素类型定义在别名条目下(inline 嵌套数组极少见,保持一层)
    const nestedContainer = resolved.kind === 'array' ? resolved.node : ofNode;
    const nestedDocument = resolved.kind === 'array' ? resolved.document : document;
    const nestedFilePath = resolved.kind === 'array' ? resolved.filePath : filePath;
    elementDescriptor.arrayElement = parseArrayElementDescriptor(
      nestedContainer,
      nestedDocument,
      nestedFilePath,
      category,
      definitionName,
      context,
      `${propertyPath}[]`,
      elementDescriptor
    );
  } else if (rawElementTypeName === 'FIXED_DICT' || resolved.kind === 'fixedDict') {
    elementDescriptor.typeName = 'FIXED_DICT';
    // 元素 FIXED_DICT 是别名时,Properties 挂在 types.xml 条目下(DataTypes::
    // loadTypes 先按条目建出 FixedDictType 实例,数组元素复用同一实例);
    // inline 数组则挂在 <of> 元素下。
    const fdContainer = resolved.kind === 'fixedDict' ? resolved.node : ofNode;
    const fdDocument = resolved.kind === 'fixedDict' ? resolved.document : document;
    const fdFilePath = resolved.kind === 'fixedDict' ? resolved.filePath : filePath;
    elementDescriptor.children = parseFixedDictChildren(
      fdContainer,
      fdDocument,
      fdFilePath,
      category,
      definitionName,
      context,
      `${propertyPath}[]`,
      elementDescriptor
    );
  } else if (resolved.kind === 'builtin') {
    elementDescriptor.typeName = resolved.typeName;
  }

  return elementDescriptor;
}

function parseFixedDictChildren(
  containerNode: DefElementNode,
  document: ReturnType<typeof parseDefDocument>,
  filePath: string,
  category: DefinitionCategory,
  definitionName: string,
  context: BuildContext,
  propertyPath: string,
  parentDescriptor: PersistentPropertyDescriptor
): PersistentPropertyDescriptor[] {
  const propertiesNode = getDirectChildElement(containerNode, 'Properties');
  if (!propertiesNode) {
    return [];
  }

  const children: PersistentPropertyDescriptor[] = [];
  for (const childNode of getDirectChildElements(propertiesNode)) {
    const rawTypeName = getScalarChildValue(childNode, 'Type');
    if (!rawTypeName) {
      continue;
    }

    const effectiveTypeName = resolveEffectiveTypeName(rawTypeName, context);
    // FIXED_DICT 子键默认持久,仅 "false" 关闭(datatype.cpp FixedDictType::
    // initialize);键类型为 ENTITYCALL(含直接元素为 ENTITYCALL 的数组)时引擎
    // 强制持久=false,键项整体不落。
    const isEntityCallKey = effectiveTypeName === 'ENTITYCALL'
      || (
        effectiveTypeName === 'ARRAY'
        && arrayDirectElementTypeName(childNode, rawTypeName, context) === 'ENTITYCALL'
      );
    if (isEntityCallKey || isFalsePersistent(childNode)) {
      continue;
    }

    const childPath = `${propertyPath}.${childNode.name}`;
    const childDescriptor: PersistentPropertyDescriptor = {
      name: childNode.name,
      typeName: rawTypeName,
      declaredType: rawTypeName,
      persistent: true,
      databaseLength: parseOptionalNumber(getScalarChildValue(childNode, 'DatabaseLength')),
      identifier: false,
      indexType: undefined,
      flags: parentDescriptor.flags,
      scopes: [...parentDescriptor.scopes],
      source: {
        filePath,
        line: getLineNumberAt(document, childNode.tagStart),
        path: childPath,
        category
      }
    };

    const resolved = resolveAliasType(rawTypeName, context);
    if (effectiveTypeName === 'ARRAY') {
      childDescriptor.typeName = 'ARRAY';
      // inline 数组的 <of> 挂在 Type 元素下;别名数组则挂在 types.xml 条目下
      const containerNodeOfChild = resolved.kind === 'array'
        ? resolved.node
        : getDirectChildElement(childNode, 'Type');
      const containerDocument = resolved.kind === 'array' ? resolved.document : document;
      const containerFilePath = resolved.kind === 'array' ? resolved.filePath : filePath;
      childDescriptor.arrayElement = parseArrayElementDescriptor(
        containerNodeOfChild,
        containerDocument,
        containerFilePath,
        category,
        definitionName,
        context,
        childPath,
        childDescriptor
      );
    } else if (effectiveTypeName === 'FIXED_DICT') {
      childDescriptor.typeName = 'FIXED_DICT';
      const nestedContainer = resolved.kind === 'fixedDict' ? resolved.node : childNode;
      const nestedDocument = resolved.kind === 'fixedDict' ? resolved.document : document;
      const nestedFilePath = resolved.kind === 'fixedDict' ? resolved.filePath : filePath;
      childDescriptor.children = parseFixedDictChildren(
        nestedContainer,
        nestedDocument,
        nestedFilePath,
        category,
        definitionName,
        context,
        childPath,
        childDescriptor
      );
    } else if (resolved.kind === 'builtin') {
      childDescriptor.typeName = resolved.typeName;
    }

    children.push(childDescriptor);
  }

  return children;
}

// inline/别名 ARRAY 的直接元素有效类型名(FixedDictType 强制规则只看直接元素;
// 数组套数组的元素是数组,不算 ENTITYCALL 键)。
function arrayDirectElementTypeName(
  propertyNode: DefElementNode,
  rawTypeName: string,
  context: BuildContext
): string | null {
  const resolved = resolveAliasType(rawTypeName, context);
  const ofOwner = resolved.kind === 'array' ? resolved.node : getDirectChildElement(propertyNode, 'Type');
  const rawElementTypeName = getScalarChildValue(ofOwner, 'of');
  if (!rawElementTypeName) {
    return null;
  }

  return resolveEffectiveTypeName(rawElementTypeName, context);
}

function getPersistentComponentProperties(
  componentTypeName: string,
  context: BuildContext
): PersistentPropertyDescriptor[] {
  const cached = context.componentCache.get(componentTypeName);
  if (cached) {
    return clonePersistentProperties(cached);
  }

  const componentPath = findDefinitionFileByCategory(componentTypeName, 'component', context.workspaceRoot);
  if (!componentPath) {
    return [];
  }

  const properties = collectPersistentPropertiesForDefinition(
    componentTypeName,
    componentPath,
    'component',
    context
  );
  context.componentCache.set(componentTypeName, clonePersistentProperties(properties));
  return clonePersistentProperties(properties);
}

// 组件模块 has*(loadComponents 计算槽旗标的依据):自身+接口+父类 def 内容
// (属性旗标域 + 非空方法段)∨ 脚本存在性(autoMatchCompOwn 只置真不清零)。
// client 域仅在同时具备 base 或 cell 时才落位(引擎按 hasBase/hasCell 分支拼位)。
function getComponentModuleScopes(componentTypeName: string, context: BuildContext): RuntimeScope[] {
  const cached = context.componentScopesCache.get(componentTypeName);
  if (cached) {
    return [...cached];
  }

  // 预填防环:组件父链互指时按无域处理
  context.componentScopesCache.set(componentTypeName, []);

  const has = { base: false, cell: false, client: false };
  // 独立 visited:has* 扫描先于属性收集执行,不得占用共享的
  // visitedDefinitions(否则同一 def 的属性收集会被短路成空)。
  const visitedScopes = new Set<string>();
  const componentPath = findDefinitionFileByCategory(componentTypeName, 'component', context.workspaceRoot);
  if (componentPath) {
    collectDefinitionHasFlags(componentPath, 'component', context, has, visitedScopes);
  }

  if (componentScriptExists(context, 'base', componentTypeName)) {
    has.base = true;
  }
  if (componentScriptExists(context, 'cell', componentTypeName)) {
    has.cell = true;
  }

  const scopes: RuntimeScope[] = [];
  if (has.base) {
    scopes.push('base');
  }
  if (has.cell) {
    scopes.push('cell');
  }
  if (has.client && (has.base || has.cell)) {
    scopes.push('client');
  }

  context.componentScopesCache.set(componentTypeName, scopes);
  return [...scopes];
}

function collectDefinitionHasFlags(
  filePath: string,
  category: DefinitionCategory,
  context: BuildContext,
  has: { base: boolean; cell: boolean; client: boolean },
  visitedScopes: Set<string>
): void {
  const normalizedPath = normalizePath(filePath);
  if (visitedScopes.has(normalizedPath)) {
    return;
  }
  visitedScopes.add(normalizedPath);

  const content = readTextDocument(filePath);
  if (!content) {
    return;
  }

  const document = parseDefDocument(content);
  const root = document.root;
  if (!root) {
    return;
  }

  const propertiesNode = getDirectChildElement(root, 'Properties');
  for (const propertyNode of getDirectChildElements(propertiesNode)) {
    for (const scope of getPropertyScopes(getScalarChildValue(propertyNode, 'Flags'))) {
      has[scope] = true;
    }
  }

  for (const methodSection of ['BaseMethods', 'CellMethods', 'ClientMethods'] as const) {
    const sectionNode = getDirectChildElement(root, methodSection);
    if (!sectionNode || getDirectChildElements(sectionNode).length === 0) {
      continue;
    }

    if (methodSection === 'BaseMethods') {
      has.base = true;
    } else if (methodSection === 'CellMethods') {
      has.cell = true;
    } else {
      has.client = true;
    }
  }

  if (category === 'interface') {
    return;
  }

  // 接口内容并入模块 has*(loadInterfaces → loadAllDefDescriptions 落同一模块)
  const interfacesNode = getDirectChildElement(root, 'Interfaces');
  if (interfacesNode) {
    for (const interfaceWrapper of getDirectChildElements(interfacesNode)) {
      if (!INTERFACE_SPELLINGS.has(interfaceWrapper.name)) {
        continue;
      }

      const interfaceName = getTypeRefName(interfaceWrapper);
      if (!interfaceName) {
        continue;
      }

      const interfacePath = findDefinitionFileByCategory(interfaceName, 'interface', context.workspaceRoot);
      if (interfacePath) {
        collectDefinitionHasFlags(interfacePath, 'interface', context, has, visitedScopes);
      }
    }
  }

  const parentNode = getDirectChildElement(root, 'Parent');
  const parentName = getTypeRefName(parentNode);
  if (parentName) {
    // 不可达(批98 定性):has* 扫描只由 getComponentModuleScopes 以 'component'
    // 进入、接口类目在上方提前 return ⇒ 父臂类目恒为 'component','entity' 臂
    // 与 findEntityDefinitionFile 兜底(可达孪生在属性收集的父臂)无触发路径。
    /* istanbul ignore start */
    const parentCategory = category === 'component' ? 'component' : 'entity';
    const parentPath = findDefinitionFileByCategory(parentName, parentCategory, context.workspaceRoot)
      || (parentCategory === 'entity' ? findEntityDefinitionFile(parentName, context.workspaceRoot) : null);
    /* istanbul ignore stop */
    if (parentPath) {
      collectDefinitionHasFlags(parentPath, parentCategory, context, has, visitedScopes);
    }
  }
}

// 实体 has*(dbmgr 装载面):entities.xml 属性声明优先(autoMatchCompOwn 的
// assertion),否则 scripts/cell/<Name>.py(.pyc)存在性;def 内容旗标在
// autoMatchCompOwn 处被覆盖,不参与判定。
export function resolveEntityHasCell(
  entityName: string,
  workspaceRoot: string,
  layout: ReturnType<typeof getDefinitionWorkspaceLayout>
): boolean {
  const entityInfo = getRegisteredEntities(workspaceRoot).find(entity => entity.name === entityName);
  if (entityInfo?.hasCellDeclared) {
    return entityInfo.hasCell;
  }

  return scriptExists(layout.entityScriptsRoot, 'cell', entityName);
}

function scriptExists(
  scriptsRoot: string | null,
  app: 'base' | 'cell',
  moduleName: string
): boolean {
  // 不可达(批64 定性):entityScriptsRoot 派生自恒非空的 entityDefsRoot,
  // 快照入口已守卫非空,此 null 臂无触发路径。
  /* istanbul ignore start */
  if (!scriptsRoot) {
    return false;
  }
  /* istanbul ignore stop */

  const appRoot = path.join(scriptsRoot, app);
  return fs.existsSync(path.join(appRoot, `${moduleName}.py`))
    || fs.existsSync(path.join(appRoot, `${moduleName}.pyc`));
}

function componentScriptExists(
  context: BuildContext,
  app: 'base' | 'cell',
  componentTypeName: string
): boolean {
  // autoMatchCompOwn 的组件分支:scripts/{base,cell}/components/<Name>.py
  // (组件模块不做 entities.xml 声明判定)
  return scriptExists(
    context.entityScriptsRoot,
    app,
    path.join('components', componentTypeName)
  );
}

/**
 * 库表前缀(设置 `kbengine.db.tablePrefix`,缺省空 = 引擎默认 `tbl_`,
 * 出处 entity_table_mysql.cpp 的 TABLE_PREFIX)。设值后表名、schema 视图
 * 与 SQL 模板同源替换,指向非默认前缀的工程。
 */
export function resolveSchemaTablePrefix(): string {
  const configured = vscode.workspace.getConfiguration('kbengine').get<string>('db.tablePrefix', '');
  const trimmed = configured.trim();
  return trimmed.length > 0 ? trimmed : DB_TABLE_PREFIX;
}

export function buildMysqlTableSchemas(
  entityName: string,
  entitySource: DefSourceRef,
  properties: PersistentPropertyDescriptor[],
  hasCellContent: boolean,
  tablePrefix: string = DB_TABLE_PREFIX
): TableSchemaDescriptor[] {
  const tables: TableSchemaDescriptor[] = [];
  const rootTableName = `${tablePrefix}${entityName}`;
  const rootTable: TableSchemaDescriptor = {
    name: rootTableName,
    kind: 'entity',
    title: entityName,
    source: entitySource,
    propertyPath: entityName,
    fields: []
  };
  tables.push(rootTable);

  // 引擎建表:所有表固定 id(自增主键)+ sm_autoLoad(带索引),子表再加
  // parentID(带索引);实体 hasCell 时追加 position/direction 六列
  // (EntityTableMysql::initialize/syncToDB)。
  rootTable.fields.push(
    createSyntheticField('id', 'bigint unsigned', 'id', entitySource, 'PRIMARY'),
    createSyntheticField('sm_autoLoad', 'tinyint', 'autoLoad', entitySource, 'INDEX')
  );

  if (hasCellContent) {
    rootTable.fields.push(
      createSyntheticField('sm_0_position', 'float', 'position.x', entitySource),
      createSyntheticField('sm_1_position', 'float', 'position.y', entitySource),
      createSyntheticField('sm_2_position', 'float', 'position.z', entitySource),
      createSyntheticField('sm_0_direction', 'float', 'direction.roll', entitySource),
      createSyntheticField('sm_1_direction', 'float', 'direction.pitch', entitySource),
      createSyntheticField('sm_2_direction', 'float', 'direction.yaw', entitySource)
    );
  }

  for (const property of properties) {
    appendPropertyToTable(rootTable, tables, property, rootTableName, rootTableName, [], hasCellContent, '');
  }

  return tables;
}

function appendPropertyToTable(
  table: TableSchemaDescriptor,
  tables: TableSchemaDescriptor[],
  property: PersistentPropertyDescriptor,
  currentTableName: string,
  parentTableName: string,
  nameChain: string[],
  entityHasCell: boolean,
  fixedDictPrefix = ''
): void {
  if (!property.persistent) {
    return;
  }

  if (property.typeName === 'ARRAY') {
    // 子表名 = 当前表名 + 祖先项名链(非空段)+ 自身名;元素项落在子表顶层,
    // 链与 FD 前缀均重置(EntityTableItemMysql_ARRAY::initialize /
    // init_db_item_name 忽略 exstrFlag)。
    const tableName = buildArrayTableName(currentTableName, nameChain, property.name);
    const childTable = createArrayTable(tableName, currentTableName, property);
    tables.push(childTable);

    if (property.arrayElement) {
      appendPropertyToTable(
        childTable,
        tables,
        property.arrayElement,
        childTable.name,
        childTable.name,
        [],
        entityHasCell
      );
    }
    return;
  }

  if (property.typeName === 'ENTITY_COMPONENT') {
    // 引擎规则(组件表构建循环):实体无 cell 内容且组件槽旗标无 base 域时,
    // 组件连表一起跳过。
    if (!entityHasCell && !property.scopes.includes('base')) {
      return;
    }

    // 组件子表名 = 容器表名 + 组件名(不串 FD 链;FD 内组件项的父表即容器表)
    const childTableName = `${currentTableName}_${property.name}`;
    const childTable = createComponentTable(childTableName, currentTableName, property);
    tables.push(childTable);

    for (const childProperty of property.children || []) {
      appendPropertyToTable(
        childTable,
        tables,
        childProperty,
        childTable.name,
        childTable.name,
        [],
        entityHasCell
      );
    }
    return;
  }

  if (property.typeName === 'ENTITYCALL') {
    // ENTITYCALL 不落列(EntityTableItemMysql_ENTITYCALL 的 syncToDB 为空);
    // 顶层数组的子表照建,但元素列由本分支吞掉。
    return;
  }

  if (property.typeName === 'FIXED_DICT') {
    // FD 键链:只有 FD 键名累积进前缀;FD 作数组元素时项名为空串,前缀不加段
    const nextPrefix = property.name
      ? `${fixedDictPrefix}${property.name}_`
      : fixedDictPrefix;
    // 不可达(批69 定性):FIXED_DICT 描述符的 children 由全部构造点恒赋为数组
    // (至少为 []),clone 路径亦保持数组 ⇒ 兜底右臂无触发路径。
    /* istanbul ignore start */
    for (const childProperty of property.children || []) {
    /* istanbul ignore stop */
      appendPropertyToTable(
        table,
        tables,
        childProperty,
        currentTableName,
        parentTableName,
        [...nameChain, property.name],
        entityHasCell,
        nextPrefix
      );
    }
    return;
  }

  for (const fieldName of expandColumnNames(property, fixedDictPrefix)) {
    if (table.fields.some(field => field.name === fieldName)) {
      continue;
    }

    table.fields.push({
      name: fieldName,
      typeLabel: resolveDbTypeLabel(property.typeName),
      declaredType: property.declaredType,
      sourcePath: property.source.path,
      source: property.source,
      databaseLength: resolveEffectiveDatabaseLength(property),
      defaultValue: property.defaultValue,
      indexType: property.indexType,
      identifier: property.identifier,
      flags: property.flags
    });
  }
}

// 子表命名链:祖先项名的非空段(空段 = FD 作数组元素的那层)逐级拼 '_'
function buildArrayTableName(
  currentTableName: string,
  nameChain: string[],
  arrayName: string
): string {
  let tableName = currentTableName;
  for (const segment of nameChain) {
    if (segment) {
      tableName += `_${segment}`;
    }
  }

  // 不可达(批69 定性):数组自身名出自标签名或 'value',恒非空 ⇒ 右臂无触发路径。
  /* istanbul ignore start */
  return `${tableName}_${arrayName || 'values'}`;
  /* istanbul ignore stop */
}

function createArrayTable(
  tableName: string,
  parentTableName: string,
  property: PersistentPropertyDescriptor
): TableSchemaDescriptor {
  return {
    name: tableName,
    kind: 'array',
    title: property.source.path,
    source: property.source,
    parentTableName,
    propertyPath: property.source.path,
    fields: [
      createSyntheticField('id', 'bigint unsigned', 'id', property.source, 'PRIMARY'),
      createSyntheticField('parentID', 'bigint unsigned', 'parentID', property.source, 'INDEX'),
      createSyntheticField('sm_autoLoad', 'tinyint', 'autoLoad', property.source, 'INDEX')
    ]
  };
}

function createComponentTable(
  tableName: string,
  parentTableName: string,
  property: PersistentPropertyDescriptor
): TableSchemaDescriptor {
  return {
    name: tableName,
    kind: 'component',
    title: property.source.path,
    source: property.source,
    parentTableName,
    propertyPath: property.source.path,
    fields: [
      createSyntheticField('id', 'bigint unsigned', 'id', property.source, 'PRIMARY'),
      createSyntheticField('parentID', 'bigint unsigned', 'parentID', property.source, 'INDEX'),
      createSyntheticField('sm_autoLoad', 'tinyint', 'autoLoad', property.source, 'INDEX')
    ]
  };
}

export function expandColumnNames(property: PersistentPropertyDescriptor, fixedDictPrefix = ''): string[] {
  // 引擎向量命名:index 在前,FD 前缀夹在 index 与项名之间
  // (init_db_item_name: TABLE_ITEM_PERFIX"_%d_%s%s")。
  switch (property.typeName) {
    case 'VECTOR2':
      return [0, 1].map(index => `${DB_COLUMN_PREFIX}${index}_${fixedDictPrefix}${property.name}`);
    case 'VECTOR3':
      return [0, 1, 2].map(index => `${DB_COLUMN_PREFIX}${index}_${fixedDictPrefix}${property.name}`);
    case 'VECTOR4':
      return [0, 1, 2, 3].map(index => `${DB_COLUMN_PREFIX}${index}_${fixedDictPrefix}${property.name}`);
    default:
      return [`${DB_COLUMN_PREFIX}${fixedDictPrefix}${property.name}`];
  }
}

function createSyntheticField(
  name: string,
  typeLabel: string,
  sourcePath: string,
  source: DefSourceRef,
  indexType?: string
): TableFieldDescriptor {
  return {
    name,
    typeLabel,
    sourcePath,
    source,
    indexType,
    identifier: false,
    synthetic: true
  };
}

function resolveDbTypeLabel(typeName: string): string {
  return SIMPLE_DB_TYPE_LABELS[typeName] || typeName.toLowerCase();
}

// STRING/UNICODE 未声明 DatabaseLength(或声明 ≤0)时按引擎默认 255 落列
function resolveEffectiveDatabaseLength(property: PersistentPropertyDescriptor): number | undefined {
  if (property.typeName === 'STRING' || property.typeName === 'UNICODE') {
    return property.databaseLength && property.databaseLength > 0 ? property.databaseLength : 255;
  }
  return property.databaseLength;
}

function getPropertyScopes(flags: string | undefined): RuntimeScope[] {
  const normalizedFlag = normalizeFlag(flags);
  if (!normalizedFlag) {
    return [];
  }

  return FLAG_SCOPE_MAP[normalizedFlag] || [];
}

function mergeProperties(
  target: Map<string, PersistentPropertyDescriptor>,
  properties: PersistentPropertyDescriptor[]
): void {
  for (const property of properties) {
    const existing = target.get(property.name);
    if (!existing) {
      target.set(property.name, clonePersistentProperty(property));
      continue;
    }

    if (property.identifier && !existing.identifier) {
      existing.identifier = true;
    }
    if (!existing.indexType && property.indexType) {
      existing.indexType = property.indexType;
    }
    if (existing.databaseLength === undefined && property.databaseLength !== undefined) {
      existing.databaseLength = property.databaseLength;
    }
  }
}

function clonePersistentProperties(properties: PersistentPropertyDescriptor[]): PersistentPropertyDescriptor[] {
  return properties.map(property => clonePersistentProperty(property));
}

function clonePersistentProperty(property: PersistentPropertyDescriptor): PersistentPropertyDescriptor {
  return {
    ...property,
    scopes: [...property.scopes],
    children: property.children ? clonePersistentProperties(property.children) : undefined,
    arrayElement: property.arrayElement ? clonePersistentProperty(property.arrayElement) : undefined
  };
}

function readTextDocument(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

// Properties 段:引擎默认非持久,仅文本(忽略大小写)"true" 持久
function isTruePersistent(node: DefElementNode): boolean {
  return getScalarChildValue(node, 'Persistent')?.trim().toLowerCase() === 'true';
}

// 组件槽与 FIXED_DICT 键:引擎默认持久,仅 "false" 关闭
// (loadComponents 忽略大小写;FixedDictType 精确比对,这里统一取宽松臂)
function isFalsePersistent(node: DefElementNode): boolean {
  return getScalarChildValue(node, 'Persistent')?.trim().toLowerCase() === 'false';
}

// 引擎 getKey(FirstChild) 语义:首个文本子节点内容优先,否则首个子元素标签名
// (组件 <Type> 与 <Parent> 均按此解)。
function getTypeRefName(node: DefElementNode | null | undefined): string | undefined {
  if (!node) {
    return undefined;
  }

  const text = getElementText(node).trim();
  if (text) {
    return text;
  }

  const firstChild = getDirectChildElements(node)[0];
  return firstChild?.name;
}

function parseOptionalNumber(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : undefined;
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function normalizeFlag(flags: string | undefined): string | undefined {
  const normalizedFlag = flags?.trim().toUpperCase();
  if (!normalizedFlag) {
    return undefined;
  }

  switch (normalizedFlag) {
    case 'CELL_AND_CLIENT':
      return 'CELL_PUBLIC_AND_OWN';
    case 'CELL_AND_CLIENTS':
      return 'ALL_CLIENTS';
    case 'CELL_AND_OTHER_CLIENTS':
      return 'OTHER_CLIENTS';
    default:
      return normalizedFlag;
  }
}

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, '/').toLowerCase();
}

function dedupeSchemaTargets<T extends { tableName: string; fieldName?: string }>(
  targets: T[]
): T[] {
  const seen = new Set<string>();
  const deduped: T[] = [];

  for (const target of targets) {
    const key = `${target.tableName}::${target.fieldName || ''}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(target);
  }

  return deduped;
}

// ---- types.xml 类型的落库形态与使用处反扫(批134) ----
//
// 落库规则只有 schema 构建器这一套实现(别名解析/列展开/子表命名都在上面),
// 这里只把它的产出换成两种视图:
// - getTypeStorageShape:给 types.xml 悬停的形态数据(FIXED_DICT 顶层键 /
//   ARRAY 元素递归一层),不重复落库规则;
// - buildTypeStorageUsageIndex / findTypeStorageUsages:遍历实体快照,把每个
//   非合成列按 declaredType(原始 <Type> 文本)归档成「类型 → 真实落点」,
//   落点表/列直接取快照,types.xml 的 CodeLens 与悬停都消费它。

export type TypeStorageShape =
  | { kind: 'builtin'; rawType: string; typeName: string; columnType: string | null }
  | { kind: 'fixedDict'; rawType: string; topLevelKeys: string[] }
  | { kind: 'array'; rawType: string; element: TypeStorageShape | null }
  | { kind: 'unresolved'; rawType: string };

export interface TypeStorageUsage {
  /** 使用处所在实体(数组/FD 键落点跟随实体属性) */
  entity: string;
  /** 声明路径,如 itemId / items[] / skills[].count */
  property: string;
  /** 落点表名(tbl_...) */
  table: string;
  /** 落点列名(sm_...) */
  column: string;
  /** 声明处文件(实体 def 或 types.xml 的 FD 键声明) */
  defFile: string;
  /** 声明处行号(1 起) */
  line: number;
}

export function getTypeStorageShape(typesXmlPath: string | null, typeName: string): TypeStorageShape {
  const context: BuildContext = {
    workspaceRoot: '',
    entityDefsRoot: '',
    entityScriptsRoot: null,
    visitedDefinitions: new Set(),
    componentCache: new Map(),
    componentScopesCache: new Map(),
    typeAliases: parseTypeAliases(typesXmlPath),
    entityHasCell: false
  };
  return typeShapeOf(typeName, context, new Set());
}

function typeShapeOf(typeName: string, context: BuildContext, seen: Set<string>): TypeStorageShape {
  if (seen.has(typeName)) {
    // 别名环:引擎 resolveAlias 同样按 seen 短路,形态层面不再展开
    return { kind: 'unresolved', rawType: typeName };
  }
  seen.add(typeName);

  const resolved = resolveAliasType(typeName, context);
  if (resolved.kind === 'builtin') {
    return {
      kind: 'builtin',
      rawType: typeName,
      typeName: resolved.typeName,
      columnType: resolveDbTypeLabel(resolved.typeName)
    };
  }
  if (resolved.kind === 'fixedDict') {
    const propertiesNode = getDirectChildElement(resolved.node, 'Properties');
    return {
      kind: 'fixedDict',
      rawType: typeName,
      topLevelKeys: getDirectChildElements(propertiesNode).map(node => node.name)
    };
  }
  if (resolved.kind === 'array') {
    // 元素类型 = <of> 的文本(与 parseArrayElementDescriptor 同一读法)
    const rawElementType = getScalarChildValue(resolved.node, 'of');
    return {
      kind: 'array',
      rawType: typeName,
      element: rawElementType ? typeShapeOf(rawElementType, context, seen) : null
    };
  }
  return { kind: 'unresolved', rawType: typeName };
}

let typeStorageUsageIndex: { key: string; index: Map<string, TypeStorageUsage[]> } | null = null;

export function invalidateTypeStorageUsageIndex(): void {
  typeStorageUsageIndex = null;
}

export function buildTypeStorageUsageIndex(workspaceRoot: string): Map<string, TypeStorageUsage[]> {
  if (typeStorageUsageIndex && typeStorageUsageIndex.key === workspaceRoot) {
    return typeStorageUsageIndex.index;
  }

  const index = new Map<string, TypeStorageUsage[]>();
  for (const entry of getDefinitionEntries(workspaceRoot, 'entity')) {
    if (!entry.exists) {
      continue;
    }
    const snapshot = getDatabaseSchemaSnapshot(entry.name, workspaceRoot);
    if (!snapshot) {
      continue;
    }
    for (const table of snapshot.tables) {
      for (const field of table.fields) {
        if (field.synthetic || !field.declaredType) {
          continue;
        }
        const usages = index.get(field.declaredType) || [];
        usages.push({
          entity: snapshot.entityName,
          property: field.sourcePath,
          table: table.name,
          column: field.name,
          defFile: field.source.filePath,
          line: field.source.line
        });
        index.set(field.declaredType, usages);
      }
    }
  }

  typeStorageUsageIndex = { key: workspaceRoot, index };
  return index;
}

export function findTypeStorageUsages(workspaceRoot: string, typeName: string): TypeStorageUsage[] {
  return buildTypeStorageUsageIndex(workspaceRoot).get(typeName) || [];
}
