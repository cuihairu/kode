/**
 * Single-table read-only data preview (IDE-DB-002): only queries allowed by
 * the whitelist are executed -- the generated statement is fixed to the
 * `SELECT * FROM \`table\` LIMIT N` shape and, right before execution, it is
 * re-proven against the existing assertReadOnlyStatement in databaseDrift
 * (defense in depth); results carry a default row-count cap (default 100, and
 * an explicit cap may not exceed the hard top of 1000). If the runner ignores
 * LIMIT and returns more rows, the result surface trims again and marks the
 * result truncated. Table names accept identifier characters only (backticks /
 * whitespace / semicolons are rejected outright and never spliced into the
 * statement). The actual connection and execution go through the existing
 * databaseDrift/registry surfaces; this module only manages the preview
 * statement shape, the caps, and result trimming.
 */

import { assertReadOnlyStatement, type QueryResult } from './databaseDrift';

export const DEFAULT_PREVIEW_ROW_LIMIT = 100;
export const MAX_PREVIEW_ROW_LIMIT = 1000;

const TABLE_NAME_PATTERN = /^[A-Za-z0-9_$]+$/;

export type TablePreviewStatement = { sql: string } | { error: string };

/** Preview statement: the whitelist shape plus the row-count cap are burned into the statement; an illegal table name or cap is rejected outright */
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
      /** The runner returned more rows than the cap, so they were trimmed */
      truncated: boolean;
    }
  | { kind: 'error'; message: string };

/** Run the preview: self-prove the statement against the whitelist -> injected runner -> trim the result surface to the cap */
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
