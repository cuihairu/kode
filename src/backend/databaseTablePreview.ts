/**
 * 单表只读数据预览(IDE-DB-002):只执行白名单允许的查询——生成的语
 * 句固定 `SELECT * FROM \`表\` LIMIT N` 形状,执行前再过 databaseDrift
 * 现有 assertReadOnlyStatement 自证(双保险);默认结果有条数上限(默
 * 认 100,显式上限不许超硬顶 1000),runner 无视 LIMIT 多回行时结果面
 * 再裁一次并标 truncated;表名只收标识符字符(含反引号/空白/分号一
 * 律拒绝,不拼进语句)。实际连接与执行走 databaseDrift/registry 既有
 * 面,本模块只管预览语句形状、上限与结果裁剪。
 */

import { assertReadOnlyStatement, type QueryResult } from './databaseDrift';

export const DEFAULT_PREVIEW_ROW_LIMIT = 100;
export const MAX_PREVIEW_ROW_LIMIT = 1000;

const TABLE_NAME_PATTERN = /^[A-Za-z0-9_$]+$/;

export type TablePreviewStatement = { sql: string } | { error: string };

/** 预览语句:白名单形状+条数上限烧进语句;表名/上限不合法直接拒绝 */
export function buildTablePreviewStatement(table: string, options: { limit?: number } = {}): TablePreviewStatement {
  if (!TABLE_NAME_PATTERN.test(table)) {
    return { error: `表名不合法(只允许字母/数字/下划线/美元符):${JSON.stringify(table)}` };
  }
  const limit = options.limit ?? DEFAULT_PREVIEW_ROW_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PREVIEW_ROW_LIMIT) {
    return { error: `预览条数上限不合法(1..${MAX_PREVIEW_ROW_LIMIT}):${limit}` };
  }
  return { sql: `SELECT * FROM \`${table}\` LIMIT ${limit}` };
}

export interface TablePreviewDeps {
  runQuery(sql: string): Promise<QueryResult>;
}

export type TablePreviewResult =
  | {
      kind: 'preview';
      columns: QueryResult['columns'];
      rows: QueryResult['rows'];
      returnedRows: number;
      limit: number;
      /** runner 回行超上限被裁过 */
      truncated: boolean;
    }
  | { kind: 'error'; message: string };

/** 执行预览:语句自证白名单 → 注入 runner → 结果面裁到上限 */
export async function previewTableData(
  table: string,
  deps: TablePreviewDeps,
  options: { limit?: number } = {}
): Promise<TablePreviewResult> {
  const statement = buildTablePreviewStatement(table, options);
  if ('error' in statement) {
    return { kind: 'error', message: statement.error };
  }
  try {
    assertReadOnlyStatement(statement.sql);
  } catch (error) {
    return { kind: 'error', message: `预览语句未过只读白名单(不应发生):${String(error)}` };
  }
  const limit = options.limit ?? DEFAULT_PREVIEW_ROW_LIMIT;
  let result: QueryResult;
  try {
    result = await deps.runQuery(statement.sql);
  } catch (error) {
    return { kind: 'error', message: error instanceof Error ? error.message : String(error) };
  }
  const truncated = result.rows.length > limit;
  return {
    kind: 'preview',
    columns: result.columns,
    rows: truncated ? result.rows.slice(0, limit) : result.rows,
    returnedRows: Math.min(result.rows.length, limit),
    limit,
    truncated
  };
}
