/**
 * 单实体结构影响预览命令(IDE-REV-019):真实库结构(SHOW FULL COLUMNS,
 * 只读)对照 def 推导虚拟 schema,把 databaseSchemaImpact 的 diff 落成只读
 * 报告——按当前 def 同步库会发生的新增/移除/类型变化清单。全程无 DDL/
 * 写库通路:查询过白名单执行器,输出只是清单;实体选择 = 命令参数 / 活
 * 动 .def / 注册实体选择器;建连与查询过 IDE-REV-017 守卫,超时/取消按
 * 原因返回;表还不在库里时如实说明「整表将新建」,不虚构对照。
 * IDE-AUD-012:遍历同实体快照全部表(根表 + ARRAY/组件子表)逐表只读对
 * 照——子表变更进报告,根表无变化不掩盖子表变化。
 */

import {
  normalizeColumnType,
  readTableColumns,
  type QueryColumnInfo,
  type QueryResult
} from './backend/databaseDrift';
import { previewEntitySchemaImpact, type EntitySchemaImpact } from './backend/databaseSchemaImpact';
import type { TableSchemaDescriptor } from './backend/databaseSchemaCore';
import type { DatabaseInterfaceConfig } from './serverConfigMerge';

/**
 * 真实库列 → 对比用描述符:型别归一(整数显示宽度不算差异,与漂移校验
 * 同口径);引擎结构列按 def 侧 synthetic 名单标同口径剔除(def 变更不
 * 影响引擎结构列,反向对照也不该把 id/sm_autoLoad 报成「移除」)。
 */
export function buildDatabaseTableDescriptor(
  table: string,
  columns: readonly QueryColumnInfo[],
  engineStructuralNames: ReadonlySet<string>
): TableSchemaDescriptor {
  return {
    name: table,
    kind: 'entity',
    title: table,
    source: { filePath: `mysql:${table}`, line: 0, path: table, category: 'entity' },
    fields: columns.map(column => ({
      name: column.name,
      typeLabel: normalizeColumnType(column.type),
      sourcePath: `${table}.${column.name}`,
      source: { filePath: `mysql:${table}`, line: 0, path: column.name, category: 'entity' },
      identifier: false,
      ...(engineStructuralNames.has(column.name) ? { synthetic: true } : {})
    }))
  };
}

/** def 侧 synthetic 字段名 → 引擎结构列名单(库侧同口径剔除用) */
export function engineStructuralNamesOf(table: TableSchemaDescriptor): Set<string> {
  return new Set(table.fields.filter(field => field.synthetic).map(field => field.name));
}

/** 单表对照结果:diff 或 整表将新建(表不在库里,如实不虚构对照) */
export type SchemaTableImpactOutcome =
  | { kind: 'diff'; impact: EntitySchemaImpact }
  | { kind: 'whole-create' };

export interface SchemaImpactTableResult {
  table: TableSchemaDescriptor;
  outcome: SchemaTableImpactOutcome;
}

const tableSectionLabel = (table: TableSchemaDescriptor): string => {
  if (table.kind === 'entity') {
    return `根表 ${table.name}`;
  }
  if (table.kind === 'array') {
    return `子表 ${table.name}(ARRAY)`;
  }
  return `子表 ${table.name}(组件)`;
};

const renderDiffEntries = (impact: EntitySchemaImpact): string[] => {
  if (impact.entries.length === 0) {
    return ['  (无结构差异——def 推导列与真实库列一致)'];
  }
  const lines = impact.entries.map(entry => {
    if (entry.change === 'added') {
      return `  + ${entry.field} ${entry.after ?? ''}(新增:def 有,库无)`;
    }
    if (entry.change === 'removed') {
      return `  - ${entry.field} ${entry.before ?? ''}(移除:库有,def 无)`;
    }
    return `  ~ ${entry.field} ${entry.before ?? ''} → ${entry.after ?? ''}(类型变化)`;
  });
  lines.push(`  (共 ${impact.entries.length} 项)`);
  return lines;
};

const renderWholeCreateBlock = (table: TableSchemaDescriptor): string[] => [
  `表 ${table.name} 还不在库里——按当前 def 同步将整表新建`,
  `(只读预览,不执行任何 DDL/写库;def 推导列 ${table.fields.filter(field => !field.synthetic).length} 项)`
];

/**
 * 报告渲染(IDE-AUD-012):逐表结果(根表 + ARRAY/组件子表)全部进报告;
 * 单表沿用旧格式(标题带表名),多表按表分区(根表无变化不掩盖子表变化);
 * 全程只读声明。
 */
export function formatSchemaImpactReport(
  entityName: string,
  results: SchemaImpactTableResult[]
): string {
  if (results.length === 1) {
    const { table, outcome } = results[0];
    if (outcome.kind === 'whole-create') {
      return [
        `===== KBEngine 结构影响预览 ${entityName}(${table.name}) =====`,
        ...renderWholeCreateBlock(table)
      ].join('\n');
    }
    return [
      `===== KBEngine 结构影响预览 ${entityName}(${table.name}) =====`,
      '对照:真实库结构(SHOW FULL COLUMNS,只读查询) ↔ def 推导虚拟 schema',
      '以下为按当前 def 同步库会发生的结构变更清单(只读预览,不执行任何 DDL/写库):',
      ...renderDiffEntries(outcome.impact)
    ].join('\n');
  }
  const lines = [
    `===== KBEngine 结构影响预览 ${entityName} =====`,
    `对照:真实库结构(SHOW FULL COLUMNS,只读查询) ↔ def 推导虚拟 schema(根表 + 子表 ${results.length - 1})`,
    '以下为按当前 def 同步库会发生的结构变更清单(只读预览,不执行任何 DDL/写库):'
  ];
  for (const { table, outcome } of results) {
    lines.push(`-- ${tableSectionLabel(table)} --`);
    if (outcome.kind === 'whole-create') {
      lines.push(...renderWholeCreateBlock(table));
    } else {
      lines.push(...renderDiffEntries(outcome.impact));
    }
  }
  return lines.join('\n');
}

export interface SchemaImpactConnection {
  runQuery(sql: string): Promise<QueryResult>;
  close(): Promise<void>;
}

/** UI/连接注入面(vscode 窗口面返回 Thenable,统一 unknown 收) */
export interface SchemaImpactCommandDeps {
  resolveEntityName(): string | undefined;
  /**
   * IDE-AUD-011/012:实体名 → def 推导全部表(根表 + ARRAY/组件子表;读
   * 不到 = null)。反查按当前连接的作用域根(scopeRootPath=资产根)限定,
   * 不跨 workspace 首命中(两项目同名实体只看当前连接项目)。
   */
  resolveEntityTables(
    entityName: string,
    scopeRootPath: string | null
  ): TableSchemaDescriptor[] | null;
  /** 当前连接解析(IDE-AUD-011):assetsRoot=活动 profile 的资产根 */
  resolveConnection(): {
    profileId: string;
    config: DatabaseInterfaceConfig;
    assetsRoot: string | null;
  } | null;
  createConnection(
    profileId: string,
    config: DatabaseInterfaceConfig
  ): Promise<SchemaImpactConnection>;
  listEntityNames(): string[];
  showQuickPick(items: string[], options: { placeHolder: string }): unknown;
  showInformationMessage(message: string): unknown;
  showWarningMessage(message: string): unknown;
  showErrorMessage(message: string): unknown;
  channel: { appendLine(line: string): void; show(preserveFocus?: boolean): void };
}

const UNKNOWN_TABLE_PATTERN = /doesn'?t exist|unknown table/i;

export async function runSchemaImpactCommand(deps: SchemaImpactCommandDeps): Promise<void> {
  let entityName = deps.resolveEntityName();
  if (!entityName) {
    const entities = deps.listEntityNames();
    if (entities.length === 0) {
      deps.showInformationMessage('结构影响预览未执行:工作区没有注册实体(也没有打开的 .def 文件)');
      return;
    }
    const picked = (await deps.showQuickPick(entities, {
      placeHolder: '选择要看结构影响预览的实体(只读对照,不执行任何 DDL)'
    })) as string | undefined;
    if (typeof picked !== 'string' || picked.length === 0) {
      deps.showInformationMessage('结构影响预览未执行:未选择实体');
      return;
    }
    entityName = picked;
  }
  // IDE-AUD-011/012:先取当前连接(拿到资产根作用域),实体全部表反查按
  // 作用域根限定——两项目同名实体只看当前连接项目;连接解析失败先如实降级
  const resolved = deps.resolveConnection();
  if (!resolved) {
    deps.showInformationMessage(
      '结构影响预览未执行:读不到引擎数据库配置(检查活动 profile 的引擎根/资产根,或 kbengine.binPath / assetsRoot 设置)'
    );
    return;
  }
  const entityTables = deps.resolveEntityTables(entityName, resolved.assetsRoot);
  if (!entityTables || entityTables.length === 0) {
    deps.showWarningMessage(`读取实体定义失败: ${entityName}(未找到 .def 文件)`);
    return;
  }
  let connection: SchemaImpactConnection;
  try {
    connection = await deps.createConnection(resolved.profileId, resolved.config);
  } catch (error) {
    deps.showErrorMessage(`结构影响预览失败:连不上数据库(${error instanceof Error ? error.message : String(error)})`);
    return;
  }
  try {
    // IDE-AUD-012:遍历同实体全部表(根表 + ARRAY/组件子表),逐表只读
    // 对照——子表变更进报告,根表无变化不掩盖子表;全程无 DDL/写库通路
    const results: SchemaImpactTableResult[] = [];
    for (const entityTable of entityTables) {
      let columns: QueryColumnInfo[];
      try {
        columns = await readTableColumns(
          { runQuery: sql => connection.runQuery(sql) },
          entityTable.name
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (UNKNOWN_TABLE_PATTERN.test(message)) {
          results.push({ table: entityTable, outcome: { kind: 'whole-create' } });
          continue;
        }
        deps.showErrorMessage(`结构影响预览失败:读取表结构失败(${message})`);
        return;
      }
      const databaseTable = buildDatabaseTableDescriptor(
        entityTable.name,
        columns,
        engineStructuralNamesOf(entityTable)
      );
      const impact = previewEntitySchemaImpact(databaseTable, entityTable);
      results.push({ table: entityTable, outcome: { kind: 'diff', impact } });
    }
    deps.channel.appendLine(formatSchemaImpactReport(entityName, results));
    deps.channel.show(true);
  } finally {
    await connection.close();
  }
}
