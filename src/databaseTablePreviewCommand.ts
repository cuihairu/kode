/**
 * 单表只读预览命令编排(IDE-REV-016):经 IDE-REV-015 的 profile 连接台账
 * 取真实连接 → SHOW TABLES 列表选表(列表拿不到退手输,标识符同口径)→
 * databaseTablePreview 白名单语句执行限量预览 → 输出通道渲染。取消选表
 * 不发预览查询;连不上/查询失败如实报错,不假造结果。
 *
 * IDE-REV-017:查询/建连的超时与取消是命令级终态(连接已在释放),按
 * 原因如实报错返回,不退手输面。
 */

import type { QueryResult } from './databaseDrift';
import { previewTableData, type TablePreviewResult } from './databaseTablePreview';
import type { DatabaseInterfaceConfig } from './serverConfigMerge';
import {
  renderColumnSourceSection,
  type ColumnSourceTableResolver
} from './databasePreviewColumnSource';

export interface TablePreviewConnection {
  runQuery(sql: string): Promise<QueryResult>;
  close(): Promise<void>;
}

/** UI/连接注入面(vscode 窗口面返回 Thenable,统一 unknown 收) */
export interface TablePreviewCommandDeps {
  resolveConnection(): { profileId: string; config: DatabaseInterfaceConfig } | null;
  createConnection(profileId: string, config: DatabaseInterfaceConfig): Promise<TablePreviewConnection>;
  showQuickPick(items: string[], options: { placeHolder: string }): unknown;
  showInputBox(options: {
    prompt: string;
    validateInput?(value: string): string | null;
  }): unknown;
  showInformationMessage(message: string): unknown;
  showErrorMessage(message: string): unknown;
  channel: { appendLine(line: string): void; show(preserveFocus?: boolean): void };
  /** IDE-REV-018:预览表名 → 虚拟 schema 描述符(列来源反查面) */
  resolveColumnSourceTable: ColumnSourceTableResolver;
}

/** 表清单:SHOW TABLES(白名单允许的只读语句),首列即表名 */
export async function listPreviewTables(
  runQuery: (sql: string) => Promise<QueryResult>
): Promise<{ ok: true; tables: string[] } | { ok: false; reason: string }> {
  try {
    const result = await runQuery('SHOW TABLES');
    const key = result.columns[0]?.name;
    const tables = key
      ? result.rows.map(row => String(row[key] ?? '')).filter(name => name.length > 0)
      : [];
    return { ok: true, tables };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

const CELL_WIDTH_CAP = 24;

const renderCell = (value: unknown): string => {
  if (value === null) {
    return 'NULL';
  }
  if (value === undefined) {
    return '';
  }
  const text =
    value instanceof Date
      ? value.toISOString()
      : typeof value === 'object'
        ? JSON.stringify(value)
        : String(value);
  return text.length > CELL_WIDTH_CAP ? `${text.slice(0, CELL_WIDTH_CAP - 1)}…` : text;
};

/** 预览渲染:表头对齐 + 行数据 + 尾注(行数/上限/是否截断/实际执行语句) */
export function formatTablePreview(preview: Extract<TablePreviewResult, { kind: 'preview' }>, table: string): string {
  const widths = preview.columns.map(column =>
    Math.min(
      CELL_WIDTH_CAP,
      Math.max(column.name.length, ...preview.rows.map(row => renderCell(row[column.name]).length), 1)
    )
  );
  const renderLine = (cells: string[]): string =>
    cells.map((cell, index) => cell.padEnd(widths[index])).join(' | ');
  const lines = [
    `===== 表预览 ${table}(${preview.limit} 行上限) =====`,
    `SQL: SELECT * FROM \`${table}\` LIMIT ${preview.limit}`,
    renderLine(preview.columns.map(column => column.name)),
    widths.map(width => '-'.repeat(width)).join('-+-'),
    ...preview.rows.map(row => renderLine(preview.columns.map(column => renderCell(row[column.name])))),
    `(${preview.returnedRows} 行${preview.truncated ? `,已截断(实际返回超上限)` : ''};只读预览,修改请走运维通道)`
  ];
  return lines.join('\n');
}

export async function runTablePreviewCommand(deps: TablePreviewCommandDeps): Promise<void> {
  const resolved = deps.resolveConnection();
  if (!resolved) {
    deps.showInformationMessage(
      '数据库预览未执行:读不到引擎数据库配置(检查活动 profile 的引擎根/资产根,或 kbengine.binPath / assetsRoot 设置)'
    );
    return;
  }
  let connection: TablePreviewConnection;
  try {
    connection = await deps.createConnection(resolved.profileId, resolved.config);
  } catch (error) {
    deps.showErrorMessage(`数据库预览失败:连不上数据库(${error instanceof Error ? error.message : String(error)})`);
    return;
  }
  try {
    // IDE-REV-017:超时/取消是命令级终态(连接已在释放),不走「清单拿不
    // 到退手输」——手输也无法在一条释放中的连接上重试;结构面识别,不引
    // 具体错误类
    let lifecycleTerminal: string | undefined;
    const listing = await listPreviewTables(async sql => {
      try {
        return await connection.runQuery(sql);
      } catch (error) {
        const record =
          typeof error === 'object' && error !== null
            ? (error as { lifecycleTerminal?: unknown; message?: unknown })
            : undefined;
        if (record?.lifecycleTerminal === true && typeof record.message === 'string') {
          lifecycleTerminal = record.message;
        }
        throw error;
      }
    });
    if (lifecycleTerminal !== undefined) {
      deps.showErrorMessage(`数据库预览失败:${lifecycleTerminal}`);
      return;
    }
    let table: string | undefined;
    if (listing.ok && listing.tables.length > 0) {
      // 有表清单:选择器(取消=undefined,不发预览查询)
      const picked = (await deps.showQuickPick(listing.tables, {
        placeHolder: '选择要预览的表(只读 SELECT *,限量 100 行)'
      })) as string | undefined;
      table = typeof picked === 'string' && picked.length > 0 ? picked : undefined;
    } else {
      // 清单拿不到(权限/协议/空库):手输表名,标识符与预览语句同口径校验
      const typed = (await deps.showInputBox({
        prompt: listing.ok
          ? '数据库里没有表,输入要预览的表名(只读 SELECT *,限量 100 行)'
          : `表清单拿不到(${listing.reason}),输入要预览的表名(只读 SELECT *,限量 100 行)`,
        validateInput: value =>
          /^[A-Za-z0-9_$]+$/.test(value.trim()) ? null : '表名只允许字母/数字/下划线/美元符'
      })) as string | undefined;
      table = typeof typed === 'string' && typed.trim().length > 0 ? typed.trim() : undefined;
    }
    if (table === undefined) {
      return; // 取消选择:不发预览查询
    }
    const preview = await previewTableData(table, { runQuery: connection.runQuery });
    if (preview.kind === 'error') {
      deps.showErrorMessage(`数据库预览失败:${preview.message}`);
      return;
    }
    deps.channel.appendLine(formatTablePreview(preview, table));
    // IDE-REV-018:表尾追加列来源段——derived 行带声明处 filePath:line
    // (输出面板点击定位),合成/未知列如实说明不带跳转面
    for (const line of renderColumnSourceSection(
      preview.columns,
      table,
      deps.resolveColumnSourceTable(table)
    )) {
      deps.channel.appendLine(line);
    }
    // IDE-REV-018:表尾追加列来源段——derived 行带声明处 filePath:line
    // (输出面板点击定位),合成/未知列如实说明不带跳转面
    deps.channel.show(true);
  } finally {
    await connection.close();
  }
}
