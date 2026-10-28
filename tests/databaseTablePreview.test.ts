import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_PREVIEW_ROW_LIMIT,
  MAX_PREVIEW_ROW_LIMIT,
  buildTablePreviewStatement,
  previewTableData
} from '../src/databaseTablePreview';
import { assertReadOnlyStatement } from '../src/databaseDrift';

// IDE-DB-002 提供单表只读数据预览:只执行白名单允许的查询(生成语句
// 固定 SELECT…LIMIT 形状,执行前再过 databaseDrift 现有 assertReadOnly-
// Statement 自证);默认结果有条数上限(默认 100,显式上限不许超硬顶
// 1000);runner 无视 LIMIT 多回行时结果面裁到上限并标 truncated(双保
// 险);表名含反引号/非法字符直接拒绝,语句形状不放开。

const TABLE = 'tbl_Account';

const rowsOf = (count: number) =>
  Array.from({ length: count }, (_, i) => ({ id: i }));
const resultOf = (count: number) => ({
  columns: [{ name: 'id', type: 'int' }],
  rows: rowsOf(count)
});

describe('buildTablePreviewStatement(语句形状与上限)', () => {
  it('默认上限 100:SELECT * FROM `表` LIMIT 100', () => {
    expect(buildTablePreviewStatement(TABLE)).toEqual({
      sql: 'SELECT * FROM `tbl_Account` LIMIT 100'
    });
    expect(DEFAULT_PREVIEW_ROW_LIMIT).toBe(100);
  });

  it('显式更小上限生效;超过硬顶拒绝', () => {
    expect(buildTablePreviewStatement(TABLE, { limit: 50 })).toEqual({
      sql: 'SELECT * FROM `tbl_Account` LIMIT 50'
    });
    expect('error' in buildTablePreviewStatement(TABLE, { limit: MAX_PREVIEW_ROW_LIMIT + 1 })).toBe(true);
    expect('error' in buildTablePreviewStatement(TABLE, { limit: 0 })).toBe(true);
    expect('error' in buildTablePreviewStatement(TABLE, { limit: -5 })).toBe(true);
  });

  it('表名含反引号/空白/非标识符字符拒绝(不拼进语句)', () => {
    for (const bad of ['tbl`x', 'tbl x', 'tbl;x', '']) {
      expect('error' in buildTablePreviewStatement(bad)).toBe(true);
    }
  });
});

describe('previewTableData(只执行白名单查询+结果上限)', () => {
  it('生成的语句过现有白名单自证(runner 只收到白名单形状)', async () => {
    const runQuery = vi.fn(async () => resultOf(3));
    const preview = await previewTableData(TABLE, { runQuery });

    expect(preview.kind).toBe('preview');
    const sql = runQuery.mock.calls[0]?.[0] as string;
    expect(() => assertReadOnlyStatement(sql)).not.toThrow();
    expect(sql).toContain('LIMIT');
  });

  it('返回行数恰达上限 → 不标 truncated', async () => {
    const preview = await previewTableData(TABLE, { runQuery: async () => resultOf(DEFAULT_PREVIEW_ROW_LIMIT) });
    expect(preview).toMatchObject({ kind: 'preview', returnedRows: 100, truncated: false });
  });

  it('runner 无视 LIMIT 多回行 → 裁到上限并标 truncated(双保险)', async () => {
    const preview = await previewTableData(TABLE, { runQuery: async () => resultOf(130) });
    expect(preview).toMatchObject({ kind: 'preview', returnedRows: 100, truncated: true });
    if (preview.kind === 'preview') {
      expect(preview.rows).toHaveLength(100);
    }
  });

  it('显式小上限:语句与结果面同限', async () => {
    const runQuery = vi.fn(async () => resultOf(80));
    const preview = await previewTableData(TABLE, { runQuery }, { limit: 50 });

    expect(runQuery.mock.calls[0]?.[0]).toContain('LIMIT 50');
    expect(preview).toMatchObject({ kind: 'preview', returnedRows: 50, truncated: true });
  });

  it('runner 抛错 → 如实 error,不吐部分结果', async () => {
    const preview = await previewTableData(TABLE, {
      runQuery: async () => {
        throw new Error('connect ECONNREFUSED');
      }
    });
    expect(preview.kind).toBe('error');
    if (preview.kind === 'error') {
      expect(preview.message).toContain('ECONNREFUSED');
    }
  });

  it('非法表名零执行(runner 不被调用)', async () => {
    const runQuery = vi.fn(async () => resultOf(1));
    const preview = await previewTableData('tbl;x', { runQuery });
    expect(preview.kind).toBe('error');
    expect(runQuery).not.toHaveBeenCalled();
  });
});
