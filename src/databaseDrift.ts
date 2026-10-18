/**
 * 数据库漂移校验(批C,设计 2.2「真实表结构反向校验虚拟表结构」)
 *
 * 校验闭环:def 属性 ──推导──► 虚拟表结构(databaseSchema 快照) ──对比──►
 * 真实表结构(MySQL)。属性→字段映射算错(哪些属性进表、类型映射、容器拆
 * 子表、列名转换)时,只有拿真实表结构对一遍才会暴露。
 *
 * 安全边界(用户 2026-10-15 追加硬约束,「只提供查询命令,其他的命令太危险」):
 * - 语句白名单:只放行 SELECT / SHOW / DESCRIBE(DESC) / EXPLAIN;
 *   INSERT/UPDATE/DELETE/DDL/GRANT/TRUNCATE/多语句一律拒绝并说明原因;
 * - 连接以只读方式打开(建连即 SET SESSION TRANSACTION READ ONLY),
 *   与字符串判断双保险——即便将来模板生成出别的东西,写也写不进去;
 * - 连接信息继续读 KBEngine 引擎配置(serverConfigMerge),不新增配置项;
 *   密码只在引擎配置明文存放(<encrypt>false</encrypt>)时读取,密文不解读;
 * - 连不上(引擎没起/密码是密文/账号无 SELECT 权/网络不通)一律降级为
 *   「未校验」而不是报错:校验是增强功能,不该把命令整挂。
 */

import type { DatabaseSchemaSnapshot, TableFieldDescriptor, TableSchemaDescriptor } from './databaseSchema';
import type { DatabaseInterfaceConfig } from './serverConfigMerge';

/** OUTPUT 通道名(报告整段可复制回传) */
export const DATABASE_DRIFT_CHANNEL_NAME = 'KBEngine 数据库漂移';

/** 引擎 MySQL 默认端口(dbmgr 端口 0 时 serverConfigMerge 已落 3306) */
export const MYSQL_DEFAULT_PORT = 3306;

export interface QueryColumnInfo {
  name: string;
  /** MySQL 回报的列型(如 int unsigned / varchar(64) / bigint(20)) */
  type: string;
  nullable?: boolean;
  defaultValue?: unknown;
  key?: string;
}

export interface QueryResult {
  columns: QueryColumnInfo[];
  rows: Array<Record<string, unknown>>;
}

/** 只读查询执行器:实现方必须自己再兜一层只读,本层只做语句白名单 */
export interface DriftQueryExecutor {
  runQuery(sql: string): Promise<QueryResult>;
  close(): Promise<void>;
}

export type DriftConnectionFactory = (
  database: DatabaseInterfaceConfig
) => Promise<DriftQueryExecutor>;

/** 白名单首关键字(大小写不敏感,允许前置括号/空白) */
const READ_ONLY_LEADING_KEYWORDS = ['SELECT', 'SHOW', 'DESCRIBE', 'EXPLAIN'];

/** 明确危险的写语句关键字——命中即拒绝,即便它藏在查询的修饰位里 */
const FORBIDDEN_KEYWORDS = [
  'INSERT',
  'UPDATE',
  'DELETE',
  'REPLACE',
  'CREATE',
  'DROP',
  'ALTER',
  'TRUNCATE',
  'RENAME',
  'GRANT',
  'REVOKE',
  'CALL',
  'LOAD',
  'INTO',
  'SET',
  'LOCK',
  'UNLOCK',
  'HANDLER',
  'PREPARE',
  'EXECUTE'
];

export class ReadOnlyViolationError extends Error {}

/** 去掉注释与字符串/标识符字面量后的裸语句(关键字判定只看这段) */
function stripLiterals(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/#[^\n]*/g, ' ')
    .replace(/'(?:[^'\\]|\\.|'')*'/g, "''")
    .replace(/"(?:[^"\\]|\\.|"")*"/g, '""')
    .replace(/`(?:[^`\\]|``)*`/g, '``');
}

/**
 * 语句白名单校验(第一道保险):非查询语句直接拒绝并指名原因。
 * 多语句(含未加引号的分号分隔)同样拒绝——拼错一次就可能变成批量写。
 */
export function assertReadOnlyStatement(sql: string): string {
  const statement = sql.trim();
  const bare = stripLiterals(statement);
  if (bare.length === 0) {
    throw new ReadOnlyViolationError('空语句不是查询');
  }

  // 多语句:去掉结尾分号后仍含分号即判定为批量执行
  const withoutTrailingSemicolon = bare.replace(/;\s*$/, '');
  if (withoutTrailingSemicolon.includes(';')) {
    throw new ReadOnlyViolationError(`只允许单条查询,拒绝多语句: ${statement}`);
  }

  const leading = /^[\s(]*([A-Za-z_]+)/.exec(bare);
  const keyword = (leading?.[1] ?? '').toUpperCase();
  if (!READ_ONLY_LEADING_KEYWORDS.includes(keyword)) {
    const known = FORBIDDEN_KEYWORDS.includes(keyword);
    throw new ReadOnlyViolationError(
      known
        ? `只允许只读查询(SELECT/SHOW/DESCRIBE/EXPLAIN),拒绝 ${keyword}: ${statement}`
        : `无法识别的语句,只允许只读查询(SELECT/SHOW/DESCRIBE/EXPLAIN): ${statement}`
    );
  }

  const offending = FORBIDDEN_KEYWORDS.find(word => new RegExp(`\\b${word}\\b`).test(bare));
  if (offending) {
    throw new ReadOnlyViolationError(
      `只读查询中出现写操作关键字 ${offending},已拒绝: ${statement}`
    );
  }

  return statement;
}

/** 连接要素 → mysql2 建连参数 */
export interface MysqlConnectionOptions {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  charset: string;
}

export function buildMysqlConnectionOptions(database: DatabaseInterfaceConfig): MysqlConnectionOptions {
  return {
    host: database.host,
    port: database.port > 0 ? database.port : MYSQL_DEFAULT_PORT,
    user: database.username,
    // 引擎配置密码是 RSA 密文时(encrypt=true)读不出明文,留空即可:
    // 连不上会走「未校验」降级,绝不猜密码、也不让用户手填新配置项
    password: database.plainPassword ?? '',
    database: database.databaseName,
    charset: database.characterSet || 'utf8mb4'
  };
}

/** mysql2 promise 子集(动态注入:测真连接装配不必真连) */
export interface MysqlModuleLike {
  createConnection(options: MysqlConnectionOptions): Promise<MysqlConnectionLike>;
}

export interface MysqlConnectionLike {
  query(sql: string): Promise<[unknown, unknown]>;
  end(): Promise<void>;
}

/** 结果集字段 → 列信息(字段表缺失时退化为空列集) */
function toColumns(fields: unknown): QueryColumnInfo[] {
  if (!Array.isArray(fields)) {
    return [];
  }
  return fields.map(field => {
    const record = field as { name?: unknown; type?: unknown };
    const name = typeof record.name === 'string' ? record.name : '';
    const type = typeof record.type === 'string' ? record.type : '';
    return { name, type };
  });
}

/** 行数组 → 对象数组(结果集非数组时给空表) */
function toRows(rows: unknown): Array<Record<string, unknown>> {
  return Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : [];
}

/**
 * mysql2 连接工厂:建连即置只读会话,每条查询再过一遍语句白名单。
 * mysql 模块由入参注入(生产走动态 import)——漂移校验是按需触发的增强
 * 功能,不该拖慢扩展激活,也不该在没装 MySQL 的机器上让扩展起不来。
 */
export function createMysqlDriftExecutorWith(
  loadMysql: () => Promise<MysqlModuleLike>
): DriftConnectionFactory {
  return async database => {
    const mysql = await loadMysql();
    const connection = await mysql.createConnection(buildMysqlConnectionOptions(database));
    // 第二道保险:连接即置只读事务默认值(即便语句白名单被绕过也写不进去)
    await connection.query('SET SESSION TRANSACTION READ ONLY');

    return {
      runQuery: async (sql: string): Promise<QueryResult> => {
        const statement = assertReadOnlyStatement(sql);
        const [rows, fields] = await connection.query(statement);
        return { columns: toColumns(fields), rows: toRows(rows) };
      },
      close: async (): Promise<void> => {
        await connection.end();
      }
    };
  };
}

/** 生产默认:mysql2 动态载入 */
export const createMysqlDriftExecutor: DriftConnectionFactory = createMysqlDriftExecutorWith(
  () => import('mysql2/promise')
);

/** 列型归一:整数显示宽度不影响存储;varchar/decimal 等参数属于真实结构 */
function normalizeColumnType(type: string): string {
  const lowered = type.toLowerCase().trim();
  const match = /^([a-z]+)(\([^)]*\))?(?:\s+(unsigned))?/.exec(lowered);
  if (!match) return lowered.replace(/\s+/g, ' ');
  const [, base, parameters = '', unsigned] = match;
  const integerTypes = new Set(['tinyint', 'smallint', 'mediumint', 'int', 'integer', 'bigint']);
  return `${base}${integerTypes.has(base) ? '' : parameters}${unsigned ? ' unsigned' : ''}`;
}

/** 期望型(def 推导的 typeLabel)与真实型是否相容(仅忽略整数显示宽度差异) */
export function isColumnTypeCompatible(expectedTypeLabel: string, actualType: string): boolean {
  return normalizeColumnType(expectedTypeLabel) === normalizeColumnType(actualType);
}

export type DriftFindingKind =
  | 'missing-table'
  | 'missing-column'
  | 'extra-column'
  | 'type-mismatch'
  | 'residual-table'
  | 'nullability-mismatch'
  | 'default-mismatch'
  | 'index-mismatch';

export interface DriftFinding {
  kind: DriftFindingKind;
  tableName: string;
  columnName?: string;
  message: string;
}

export interface DriftReport {
  entityName: string;
  databaseName: string;
  /** 连不上时只给降级说明,findings 为空 */
  checked: boolean;
  findings: DriftFinding[];
  /** 未校验原因(checked=false 时非空) */
  reason?: string;
}

/** 取库里的表清单(SHOW TABLES,只读白名单内) */
async function readTableNames(executor: DriftQueryExecutor): Promise<string[]> {
  const result = await executor.runQuery('SHOW TABLES');
  const firstColumn = result.columns[0]?.name ?? 'Tables_in_db';
  const names: string[] = [];
  for (const row of result.rows) {
    const value = row[firstColumn];
    if (typeof value === 'string') {
      names.push(value);
    }
  }
  return names;
}

/** 取单表列清单(SHOW FULL COLUMNS,带真实型别) */
async function readTableColumns(
  executor: DriftQueryExecutor,
  tableName: string
): Promise<QueryColumnInfo[]> {
  const result = await executor.runQuery(`SHOW FULL COLUMNS FROM \`${tableName}\``);
  const names = result.columns.map(column => column.name);
  const nameKey = names.find(name => name.toLowerCase() === 'field');
  const typeKey = names.find(name => name.toLowerCase() === 'type');
  if (!nameKey || !typeKey) {
    return result.columns;
  }

  const columns: QueryColumnInfo[] = [];
  for (const row of result.rows) {
    const name = row[nameKey];
    if (typeof name !== 'string') {
      continue;
    }
    const type = row[typeKey];
    const get = (key: string): unknown => {
      const actualKey = names.find(candidate => candidate.toLowerCase() === key.toLowerCase());
      return actualKey ? row[actualKey] : undefined;
    };
    const nullValue = get('Null');
    const keyValue = get('Key');
    columns.push({
      name,
      type: typeof type === 'string' ? type : '',
      nullable: typeof nullValue === 'string' ? nullValue.toUpperCase() === 'YES' : undefined,
      defaultValue: get('Default'),
      key: typeof keyValue === 'string' ? keyValue.toUpperCase() : undefined
    });
  }
  return columns;
}

/** 单表对比:缺列 / 多列 / 型别不符 */
export function compareTableColumns(
  table: TableSchemaDescriptor,
  actualColumns: readonly QueryColumnInfo[]
): DriftFinding[] {
  const findings: DriftFinding[] = [];
  const actualByName = new Map(actualColumns.map(column => [column.name, column]));

  for (const field of table.fields) {
    const actual = actualByName.get(field.name);
    if (!actual) {
      findings.push({
        kind: 'missing-column',
        tableName: table.name,
        columnName: field.name,
        message: `缺列 ${field.name}(def 推导 ${field.typeLabel})`
      });
      continue;
    }
    if (!isColumnTypeCompatible(field.typeLabel, actual.type)) {
      findings.push({
        kind: 'type-mismatch',
        tableName: table.name,
        columnName: field.name,
        message: `型别不符 ${field.name}:def 推导 ${field.typeLabel},真实 ${actual.type}`
      });
    }
    const expected = expectedColumnMetadata(field);
    if (actual.nullable !== undefined && actual.nullable !== expected.nullable) {
      findings.push({
        kind: 'nullability-mismatch', tableName: table.name, columnName: field.name,
        message: `可空性不符 ${field.name}:def 推导 ${expected.nullable ? 'NULL' : 'NOT NULL'},真实 ${actual.nullable ? 'NULL' : 'NOT NULL'}`
      });
    }
    if (actual.defaultValue !== undefined && !sameDefault(actual.defaultValue, expected.defaultValue)) {
      findings.push({
        kind: 'default-mismatch', tableName: table.name, columnName: field.name,
        message: `默认值不符 ${field.name}:def 推导 ${formatDefault(expected.defaultValue)},真实 ${formatDefault(actual.defaultValue)}`
      });
    }
    const expectedKey = expectedColumnKey(field);
    if (actual.key !== undefined && actual.key !== expectedKey) {
      findings.push({
        kind: 'index-mismatch', tableName: table.name, columnName: field.name,
        message: `索引不符 ${field.name}:def 推导 ${expectedKey || '无索引'},真实 ${actual.key || '无索引'}`
      });
    }
  }

  const expectedNames = new Set(table.fields.map((field: TableFieldDescriptor) => field.name));
  for (const column of actualColumns) {
    if (!expectedNames.has(column.name)) {
      findings.push({
        kind: 'extra-column',
        tableName: table.name,
        columnName: column.name,
        message: `多余列 ${column.name}(真实 ${column.type},def 无此属性)`
      });
    }
  }

  return findings;
}

interface ExpectedColumnMetadata { nullable: boolean; defaultValue: unknown }
function expectedColumnMetadata(field: TableFieldDescriptor): ExpectedColumnMetadata {
  if (field.name === 'id' || field.name === 'parentID') return { nullable: false, defaultValue: null };
  if (field.name === 'sm_autoLoad') return { nullable: false, defaultValue: '0' };
  const label = field.typeLabel.toLowerCase();
  if (label.includes('blob')) return { nullable: true, defaultValue: null };
  if (label.startsWith('vector')) return { nullable: false, defaultValue: '0' };
  if (label === 'varchar' || label === 'char') return { nullable: false, defaultValue: field.defaultValue ?? '' };
  const raw = field.defaultValue?.trim();
  const parsed = raw === undefined || raw === '' ? 0 : Number(raw);
  return { nullable: false, defaultValue: String(Number.isFinite(parsed) ? parsed : 0) };
}
function expectedColumnKey(field: TableFieldDescriptor): string {
  if (field.name === 'id') return 'PRI';
  if (field.indexType === 'UNIQUE') return 'UNI';
  if (field.indexType === 'INDEX' || field.name === 'sm_autoLoad' || field.name === 'parentID') return 'MUL';
  return '';
}
function formatDefault(value: unknown): string { return value === null ? 'NULL' : String(value); }
function sameDefault(actual: unknown, expected: unknown): boolean {
  if (actual === null || expected === null) return actual === expected;
  return String(actual) === String(expected);
}

/**
 * 全量对比:逐表比对 + 残留表扫描。
 * - 虚拟表在库里没有 = 该实体尚未走过建表流程;
 * - 库里带前缀的表不在虚拟表里 = 删属性后的残留表。
 */
export async function buildDriftReport(
  snapshot: DatabaseSchemaSnapshot,
  executor: DriftQueryExecutor,
  tablePrefix: string
): Promise<DriftFinding[]> {
  return buildDriftReportForSnapshots([snapshot], executor, tablePrefix, `${tablePrefix}${snapshot.entityName}`);
}

/** 单次读取数据库表清单，批量检查多个实体；残留表按所有实体的表并集判断。 */
export async function buildDriftReportForSnapshots(
  snapshots: readonly DatabaseSchemaSnapshot[],
  executor: DriftQueryExecutor,
  tablePrefix: string,
  residualTablePrefix = tablePrefix
): Promise<DriftFinding[]> {
  const findings: DriftFinding[] = [];
  const actualTables = await readTableNames(executor);
  const actualSet = new Set(actualTables);
  const expectedTables = new Map<string, TableSchemaDescriptor>();

  for (const snapshot of snapshots) for (const table of snapshot.tables) {
    expectedTables.set(table.name, table);
  }
  for (const table of expectedTables.values()) {
    if (!actualSet.has(table.name)) {
      findings.push({
        kind: 'missing-table',
        tableName: table.name,
        message: `表中不存在 ${table.name}(该实体或属性尚未建表)`
      });
      continue;
    }
    findings.push(...compareTableColumns(table, await readTableColumns(executor, table.name)));
  }

  for (const tableName of actualTables) {
    if (tableName.startsWith(residualTablePrefix) && !expectedTables.has(tableName)) {
      findings.push({
        kind: 'residual-table',
        tableName,
        message: `残留表 ${tableName}(库里存在,def 已无对应属性)`
      });
    }
  }

  return findings;
}

const FINDING_TITLES: Record<DriftFindingKind, string> = {
  'missing-table': '缺表',
  'missing-column': '缺列',
  'extra-column': '多列',
  'type-mismatch': '型别不符',
  'residual-table': '残留表',
  'nullability-mismatch': '可空性不符',
  'default-mismatch': '默认值不符',
  'index-mismatch': '索引不符'
};

/** 报告文本(整段可复制回传;OUTPUT 通道无着色 API,靠前缀标记) */
export function renderDriftReport(report: DriftReport): string {
  const lines: string[] = [`# KBEngine 数据库漂移: ${report.entityName}`, ''];
  if (!report.checked) {
    lines.push(`未校验:${report.reason ?? '未知原因'}`);
    return `${lines.join('\n')}\n`;
  }

  lines.push(`Database: ${report.databaseName}`, '');
  if (report.findings.length === 0) {
    lines.push('问题 0 项:真实表结构与 def 推导的虚拟表结构一致');
    return `${lines.join('\n')}\n`;
  }

  for (const finding of report.findings) {
    lines.push(`[${FINDING_TITLES[finding.kind]}] ${finding.message}`);
  }
  lines.push('');
  lines.push(`问题 ${report.findings.length} 项`);
  return `${lines.join('\n')}\n`;
}

/** 提示语:未校验 / 无漂移 / 有漂移 */
export function describeDriftSummary(report: DriftReport): string {
  if (!report.checked) {
    return `数据库漂移未校验:${report.entityName}(${report.reason ?? '未知原因'})`;
  }
  if (report.findings.length === 0) {
    return `数据库漂移校验通过:${report.entityName}(真实表结构与 def 一致)`;
  }
  return `数据库漂移发现 ${report.findings.length} 项:${report.entityName},详见「${DATABASE_DRIFT_CHANNEL_NAME}」输出面板`;
}

/** OUTPUT 通道子集(装配层只用到这三个动作) */
export interface DriftChannelLike {
  clear(): void;
  appendLine(line: string): void;
  show(preserveFocus?: boolean): void;
}

/** 提示子集:有漂移走警告,未校验/无漂移走信息(与 vscode.window 同形) */
export interface DriftNotifierLike {
  showInformationMessage(message: string): unknown;
  showWarningMessage(message: string): unknown;
}

/**
 * 报告出口:整段写进 OUTPUT 通道并按结论选提示档位。
 * 抽成纯装配函数——命令层只管取数,「写哪儿/弹什么」的口径一处说了算。
 */
export function publishDriftReport(
  channel: DriftChannelLike,
  notifier: DriftNotifierLike,
  report: DriftReport
): void {
  channel.clear();
  channel.appendLine(renderDriftReport(report));
  channel.show(true);
  if (report.checked && report.findings.length > 0) {
    notifier.showWarningMessage(describeDriftSummary(report));
    return;
  }
  notifier.showInformationMessage(describeDriftSummary(report));
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 校验入口:读库表结构 → 对比。连接失败/读表失败都降级为「未校验」,
 * 不抛给调用方(命令层据此如实提示,而不是红错)。
 */
export async function checkDatabaseDrift(
  snapshot: DatabaseSchemaSnapshot,
  database: DatabaseInterfaceConfig,
  tablePrefix: string,
  createExecutor: DriftConnectionFactory
): Promise<DriftReport> {
  const base: DriftReport = {
    entityName: snapshot.entityName,
    databaseName: database.databaseName,
    checked: true,
    findings: []
  };

  let executor: DriftQueryExecutor;
  try {
    executor = await createExecutor(database);
  } catch (error) {
    return { ...base, checked: false, reason: `连不上数据库(${describeError(error)})` };
  }

  try {
    return { ...base, findings: await buildDriftReport(snapshot, executor, tablePrefix) };
  } catch (error) {
    return { ...base, checked: false, reason: `读取表结构失败(${describeError(error)})` };
  } finally {
    await executor.close();
  }
}

export async function checkDatabaseDriftForSnapshots(
  snapshots: readonly DatabaseSchemaSnapshot[],
  database: DatabaseInterfaceConfig,
  tablePrefix: string,
  createExecutor: DriftConnectionFactory
): Promise<DriftReport> {
  const entities = snapshots.map(snapshot => snapshot.entityName);
  const base: DriftReport = {
    entityName: `全部实体 (${entities.length})`, databaseName: database.databaseName,
    checked: true, findings: []
  };
  if (snapshots.length === 0) {
    return { ...base, checked: false, reason: '工作区没有可检查的实体定义' };
  }
  let executor: DriftQueryExecutor;
  try {
    executor = await createExecutor(database);
  } catch (error) {
    return { ...base, checked: false, reason: `连不上数据库(${describeError(error)})` };
  }
  try {
    return { ...base, findings: await buildDriftReportForSnapshots(snapshots, executor, tablePrefix) };
  } catch (error) {
    return { ...base, checked: false, reason: `读取表结构失败(${describeError(error)})` };
  } finally {
    await executor.close();
  }
}
