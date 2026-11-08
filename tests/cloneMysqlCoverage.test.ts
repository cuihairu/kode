// Player Data Clone mysql 会话面覆盖(测试新文件,不动既有用例):
// - openCloneSession 的只读置位/底层 raw 流接线/readonly:false 开写;
// - testCloneConnection 三态(版本/unknown/异常);
// - probePhysicalTables 边界(空清单/缺表行/列与索引非数组/复合唯一键);
// - uniqueValuesFromRows(null 跳过/去重)、probeExistingValues(分组探测/命中回填);
// - executeExportPlan 预算与超时(行预算非法/墙钟越限/行中取消/父子表取消);
// - applyImportPlan 语义面(行缺失/列宽不齐/引用乱序/insertId 0/提交后核对)。

import { describe, expect, it, vi } from 'vitest';
import { Readable } from 'stream';
import {
  CloneApplyCancelledError,
  CloneCancelledError,
  CloneCommitUnknownError,
  ClonePostCommitError,
  CloneRollbackUnknownError,
  applyImportPlan,
  columnOrderFromPlan,
  executeExportPlan,
  loadMysqlModule,
  openCloneSession,
  probeExistingValues,
  probePhysicalTables,
  testCloneConnection,
  uniqueValuesFromRows,
  type CloneMysqlConnection,
  type CloneMysqlModule
} from '../src/playerDataCloneMysql';
import {
  tvBigUInt,
  tvNull,
  tvText,
  tvUInt,
  type ImportPlanWire,
  type QueryPlanWire,
  type TypedRowWire
} from '../src/playerDataCloneWire';

/** 记录型假连接:预置语句结果(needle → rows/Error),记录全部执行。 */
class FakeMysqlConnection implements CloneMysqlConnection {
  readonly log: Array<{ sql: string; values?: unknown[] }> = [];
  private readonly results = new Map<string, unknown>();
  private autoId = 1000;
  ended = 0;
  aborted = 0;
  destroyed = 0;

  reply(sqlNeedle: string, rows: unknown): void {
    this.results.set(sqlNeedle, rows);
  }

  failOn(sqlNeedle: string): void {
    this.results.set(sqlNeedle, new Error(`boom: ${sqlNeedle}`));
  }

  async query(sql: string, values?: unknown[]): Promise<[unknown, unknown]> {
    this.log.push({ sql, values });
    for (const [needle, rows] of this.results) {
      if (sql.includes(needle)) {
        if (rows instanceof Error) {
          throw rows;
        }
        return [rows, []];
      }
    }
    if (/^INSERT INTO/.test(sql)) {
      const insertId = this.autoId;
      this.autoId += 1;
      return [{ insertId, affectedRows: 1 }, undefined];
    }
    return [[], []];
  }

  async end(): Promise<void> {
    this.ended += 1;
  }
}

const sqlLog = (connection: FakeMysqlConnection): string[] => connection.log.map(entry => entry.sql);

// ---------------------------------------------------------------------------
// loadMysqlModule / openCloneSession
// ---------------------------------------------------------------------------

describe('loadMysqlModule(生产动态载入)', () => {
  it('载入真实 mysql2/promise(暴露 createConnection 面)', async () => {
    const mod = await loadMysqlModule();
    expect(typeof mod.createConnection).toBe('function');
  });
});

describe('openCloneSession(只读置位与底层流接线)', () => {
  const config = { host: '127.0.0.1', port: 3306, user: 'kbe', password: 'pw', database: 'kbe' };

  it('默认置只读会话(SET SESSION TRANSACTION READ ONLY);无 raw 不装流', async () => {
    const connection = new FakeMysqlConnection();
    const module: CloneMysqlModule = { createConnection: async () => connection };
    const opened = await openCloneSession(config, {}, async () => module);
    expect(opened).toBe(connection);
    expect(sqlLog(connection)).toEqual(['SET SESSION TRANSACTION READ ONLY']);
    expect(opened.streamRows).toBeUndefined();
    expect(opened.abort).toBeUndefined();
    await opened.end();
  });

  it('readonly:false 不发只读置位(Apply 写事务面)', async () => {
    const connection = new FakeMysqlConnection();
    const module: CloneMysqlModule = { createConnection: async () => connection };
    const opened = await openCloneSession(config, { readonly: false }, async () => module);
    expect(sqlLog(connection)).toEqual([]);
    await opened.end();
  });

  it('有 raw 底层连接:接线 streamRows(背压流)与 abort(destroy)', async () => {
    const connection = new FakeMysqlConnection() as FakeMysqlConnection & {
      connection?: unknown;
    };
    let destroyed = 0;
    const streamed: Array<{ sql: string; values: unknown[] }> = [];
    connection.connection = {
      query: (sql: string, values: unknown[]) => ({
        stream: () => {
          streamed.push({ sql, values });
          return Readable.from([{ id: 1 }]);
        }
      }),
      destroy: () => {
        destroyed += 1;
      }
    };
    const module: CloneMysqlModule = { createConnection: async () => connection as unknown as CloneMysqlConnection };
    const opened = await openCloneSession(config, {}, async () => module);
    expect(sqlLog(connection)).toEqual(['SET SESSION TRANSACTION READ ONLY']);
    expect(typeof opened.streamRows).toBe('function');
    expect(typeof opened.abort).toBe('function');
    const rows = opened.streamRows!('SELECT 1', [7]);
    const collected: unknown[] = [];
    for await (const row of rows) {
      collected.push(row);
    }
    expect(collected).toEqual([{ id: 1 }]);
    expect(streamed).toEqual([{ sql: 'SELECT 1', values: [7] }]);
    opened.abort!();
    expect(destroyed).toBe(1);
    await opened.end();
  });
});

// ---------------------------------------------------------------------------
// testCloneConnection
// ---------------------------------------------------------------------------

describe('testCloneConnection(连通性 + 版本)', () => {
  it('SELECT VERSION() 成功回版本', async () => {
    const connection = new FakeMysqlConnection();
    connection.reply('SELECT VERSION()', [{ v: '8.0.30' }]);
    const result = await testCloneConnection(connection);
    expect(result).toEqual({ ok: true, version: '8.0.30' });
    expect(sqlLog(connection)[0]).toBe('SELECT VERSION() AS v');
  });

  it('行集不是数组 → 版本 unknown(不猜)', async () => {
    const connection = new FakeMysqlConnection();
    connection.reply('SELECT VERSION()', 'not-an-array');
    const result = await testCloneConnection(connection);
    expect(result).toEqual({ ok: true, version: 'unknown' });
  });

  it('查询异常 → ok:false 携原因', async () => {
    const connection = new FakeMysqlConnection();
    connection.failOn('SELECT VERSION()');
    const result = await testCloneConnection(connection);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('boom');
    }
  });
});

// ---------------------------------------------------------------------------
// probePhysicalTables 边界
// ---------------------------------------------------------------------------

describe('probePhysicalTables(边界面)', () => {
  it('空清单直接返回空数组(不发查询)', async () => {
    const connection = new FakeMysqlConnection();
    const tables = await probePhysicalTables(connection, []);
    expect(tables).toEqual([]);
    expect(connection.log).toHaveLength(0);
  });

  it('不安全表名拒绝(防注入面)', async () => {
    const connection = new FakeMysqlConnection();
    await expect(probePhysicalTables(connection, ['tbl; DROP'])).rejects.toThrow(/unsafe table name/);
  });

  it('PRIMARY 索引聚合为主键清单', async () => {
    const connection = new FakeMysqlConnection();
    connection.reply('FROM information_schema.TABLES', [{ ENGINE: 'InnoDB' }]);
    connection.reply('FROM information_schema.COLUMNS', [
      { COLUMN_NAME: 'id', COLUMN_TYPE: 'int' }
    ]);
    connection.reply('FROM information_schema.STATISTICS', [
      { INDEX_NAME: 'PRIMARY', NON_UNIQUE: 0, SEQ_IN_INDEX: 1, COLUMN_NAME: 'id' }
    ]);
    const tables = await probePhysicalTables(connection, ['tbl_Primary']);
    expect(tables[0].primaryKey).toEqual(['id']);
    expect(tables[0].indexes).toEqual([]);
  });

  it('表在 information_schema 缺失(TABLES 空行)→ 跳过该表', async () => {
    const connection = new FakeMysqlConnection();
    connection.reply('FROM information_schema.TABLES', []);
    const tables = await probePhysicalTables(connection, ['tbl_Ghost']);
    expect(tables).toEqual([]);
    // 只发了 TABLES 探测,没继续列/索引
    expect(sqlLog(connection)).toHaveLength(1);
  });

  it('列/索引行集非数组 → 如实空列空键(engineRow.ENGINE 缺失 → unknown)', async () => {
    const connection = new FakeMysqlConnection();
    connection.reply('FROM information_schema.TABLES', [{}]);
    connection.reply('FROM information_schema.COLUMNS', 'not-array');
    connection.reply('FROM information_schema.STATISTICS', 'not-array');
    const tables = await probePhysicalTables(connection, ['tbl_Weird']);
    expect(tables).toHaveLength(1);
    expect(tables[0].engine).toBe('unknown');
    expect(tables[0].columns).toEqual({});
    expect(tables[0].primaryKey).toEqual([]);
    expect(tables[0].indexes).toEqual([]);
  });

  it('复合唯一键按 INDEX_NAME 聚合;NON_UNIQUE 以字符串 0 亦认唯一', async () => {
    const connection = new FakeMysqlConnection();
    connection.reply('FROM information_schema.TABLES', [{ ENGINE: 'MyISAM' }]);
    connection.reply('FROM information_schema.COLUMNS', [
      { COLUMN_NAME: 'id', COLUMN_TYPE: 'int' },
      { COLUMN_NAME: 'a', COLUMN_TYPE: 'varchar(8)' },
      { COLUMN_NAME: 'b', COLUMN_TYPE: 'varchar(8)' }
    ]);
    connection.reply('FROM information_schema.STATISTICS', [
      { INDEX_NAME: 'uk_ab', NON_UNIQUE: '0', SEQ_IN_INDEX: 1, COLUMN_NAME: 'a' },
      { INDEX_NAME: 'uk_ab', NON_UNIQUE: 0, SEQ_IN_INDEX: 2, COLUMN_NAME: 'b' },
      { INDEX_NAME: 'uk_a', NON_UNIQUE: 0, SEQ_IN_INDEX: 1, COLUMN_NAME: 'a' },
      { INDEX_NAME: 'idx_plain', NON_UNIQUE: 1, SEQ_IN_INDEX: 1, COLUMN_NAME: 'b' }
    ]);
    const tables = await probePhysicalTables(connection, ['tbl_Compound']);
    expect(tables[0].primaryKey).toEqual([]);
    expect(tables[0].indexes).toEqual([['a', 'b'], ['a']]);
  });
});

// ---------------------------------------------------------------------------
// uniqueValuesFromRows / probeExistingValues
// ---------------------------------------------------------------------------

describe('uniqueValuesFromRows(null 跳过与去重)', () => {
  const order = new Map([['tbl_A', ['id', 'name']]]);

  it('唯一列位上的 null 值不入候选', () => {
    const rows: Map<string, TypedRowWire[]> = new Map([
      ['tbl_A', [{ table: 'tbl_A', values: [tvBigUInt(1), tvNull()] }]]
    ]);
    const candidates = uniqueValuesFromRows(rows, order, [{ table: 'tbl_A', column: 'name' }]);
    expect(candidates).toEqual([]);
  });

  it('同列同值去重(有界探测不重复)', () => {
    const rows: Map<string, TypedRowWire[]> = new Map([
      [
        'tbl_A',
        [
          { table: 'tbl_A', values: [tvBigUInt(1), tvText('hero')] },
          { table: 'tbl_A', values: [tvBigUInt(2), tvText('hero')] },
          { table: 'tbl_A', values: [tvBigUInt(3), tvText('hero2')] }
        ]
      ]
    ]);
    const candidates = uniqueValuesFromRows(rows, order, [{ table: 'tbl_A', column: 'name' }]);
    expect(candidates.map(candidate => candidate.value)).toEqual([tvText('hero'), tvText('hero2')]);
  });

  it('列不在列序 → 无候选(表缺席同理)', () => {
    const rows: Map<string, TypedRowWire[]> = new Map([
      ['tbl_A', [{ table: 'tbl_A', values: [tvBigUInt(1), tvText('hero')] }]]
    ]);
    expect(uniqueValuesFromRows(rows, order, [{ table: 'tbl_A', column: 'ghost' }])).toEqual([]);
    expect(uniqueValuesFromRows(rows, order, [{ table: 'tbl_Other', column: 'name' }])).toEqual([]);
  });

  it('columnOrderFromPlan 取每表首语句列序', () => {
    const plan = miniPlan();
    const order = columnOrderFromPlan(plan);
    expect(order.get('tbl_Avatar')).toEqual(['id', 'sm_autoLoad', 'sm_name']);
    expect(order.get('tbl_Avatar_items')).toEqual(['id', 'parentID', 'sm_value']);
  });
});

describe('probeExistingValues(目标既有值有界探测)', () => {
  it('按列分组 WHERE IN 探测;命中回填,未命中丢弃', async () => {
    const connection = new FakeMysqlConnection();
    connection.reply('FROM tbl_Avatar WHERE', [{ v: 'hero' }]);
    connection.reply('FROM tbl_Account WHERE', 'not-array');
    const existing = await probeExistingValues(connection, [
      { table: 'tbl_Avatar', column: 'sm_name', value: tvText('hero') },
      { table: 'tbl_Avatar', column: 'sm_name', value: tvText('hero2') },
      { table: 'tbl_Account', column: 'email', value: tvText('a@x') }
    ]);
    expect(existing).toEqual([{ table: 'tbl_Avatar', column: 'sm_name', value: tvText('hero') }]);
    const avatar = connection.log.find(entry => entry.sql.includes('FROM tbl_Avatar WHERE'));
    expect(avatar?.sql).toBe('SELECT sm_name AS v FROM tbl_Avatar WHERE sm_name IN (?, ?)');
    expect(avatar?.values).toEqual(['hero', 'hero2']);
    const account = connection.log.find(entry => entry.sql.includes('FROM tbl_Account WHERE'));
    expect(account?.values).toEqual(['a@x']);
  });

  it('不安全标识符拒绝(防注入面)', async () => {
    const connection = new FakeMysqlConnection();
    await expect(
      probeExistingValues(connection, [
        { table: 'tbl; DROP', column: 'name', value: tvText('x') }
      ])
    ).rejects.toThrow(/unsafe identifier/);
    await expect(
      probeExistingValues(connection, [
        { table: 'tbl_Ok', column: 'name; DROP', value: tvText('x') }
      ])
    ).rejects.toThrow(/unsafe identifier/);
  });
});

// ---------------------------------------------------------------------------
// executeExportPlan 预算/超时/取消
// ---------------------------------------------------------------------------

const rootQuery = (overrides: Partial<QueryPlanWire['queries'][number]> = {}) => ({
  sequence: 0,
  table: 'tbl_Avatar',
  columns: ['id', 'sm_name'],
  column_types: ['bigint unsigned', 'varchar'],
  select_sql: 'SELECT id, sm_name FROM tbl_Avatar WHERE id = ?',
  filter: { kind: 'root-id' } as const,
  ...overrides
});

describe('executeExportPlan(预算与墙钟边界)', () => {
  it('行预算非法(非安全整数)→ 拒绝并回滚快照', async () => {
    const connection = new FakeMysqlConnection();
    const plan = {
      entity_name: 'Avatar',
      row_budget: 1.5,
      queries: [rootQuery()],
      denied: [],
      missing: []
    };
    await expect(executeExportPlan(connection, plan, 7n)).rejects.toThrow(/row budget/);
    expect(sqlLog(connection)).not.toContain('COMMIT');
    expect(sqlLog(connection)).toContain('ROLLBACK');
  });

  it('墙钟在数据查询前越限 → 如实超时并 abort(回滚收尾同样越限时吞掉)', async () => {
    const connection = new FakeMysqlConnection();
    connection.streamRows = () => Readable.from([{ id: 1, sm_name: 'hero' }]);
    connection.abort = () => {
      connection.aborted += 1;
    };
    const plan = {
      entity_name: 'Avatar',
      row_budget: 10,
      queries: [rootQuery()],
      denied: [],
      missing: []
    };
    // 前 3 次 Date.now(deadline 计算 + 两次快照控制)用真实墙钟,第 4 次起
    // (runQuery 的 timeLeft)一次性跨过 deadline——确定性触发超时分支。
    const dateSpy = jumpDateNowAfter(3);
    try {
      await expect(executeExportPlan(connection, plan, 7n, { timeoutMs: 10_000 })).rejects.toThrow(/timed out/);
    } finally {
      dateSpy.mockRestore();
    }
    expect(connection.aborted).toBeGreaterThan(0);
    expect(sqlLog(connection)).not.toContain('COMMIT');
  });

  it('快照控制语句挂死 → 墙钟超时 abort(计时器分支)', async () => {
    const connection = new FakeMysqlConnection();
    connection.abort = () => {
      connection.aborted += 1;
    };
    connection.query = async sql =>
      sql.startsWith('SET TRANSACTION') ? new Promise(() => undefined) : [[], []];
    const plan = {
      entity_name: 'Avatar',
      row_budget: 10,
      queries: [rootQuery()],
      denied: [],
      missing: []
    };
    await expect(executeExportPlan(connection, plan, 7n, { timeoutMs: 30 })).rejects.toThrow(/timed out/);
    expect(connection.aborted).toBeGreaterThan(0);
    expect(sqlLog(connection)).not.toContain('COMMIT');
  }, 20000);

  it('快照控制语句挂死 → 取消轮询先于墙钟触发 CloneCancelledError', async () => {
    const connection = new FakeMysqlConnection();
    connection.abort = () => {
      connection.aborted += 1;
    };
    connection.query = async sql =>
      sql.startsWith('SET TRANSACTION') ? new Promise(() => undefined) : [[], []];
    let cancelled = false;
    const plan = {
      entity_name: 'Avatar',
      row_budget: 10,
      queries: [rootQuery()],
      denied: [],
      missing: []
    };
    const request = executeExportPlan(connection, plan, 7n, {
      timeoutMs: 5000,
      shouldCancel: () => cancelled
    });
    setTimeout(() => {
      cancelled = true;
    }, 10);
    await expect(request).rejects.toBeInstanceOf(CloneCancelledError);
    expect(connection.aborted).toBeGreaterThan(0);
  }, 20000);

  it('数据查询前取消(计划循环顶)→ CloneCancelledError 且回滚快照', async () => {
    const connection = new FakeMysqlConnection();
    const plan = {
      entity_name: 'Avatar',
      row_budget: 10,
      queries: [rootQuery()],
      denied: [],
      missing: []
    };
    await expect(
      executeExportPlan(connection, plan, 7n, { shouldCancel: () => true })
    ).rejects.toBeInstanceOf(CloneCancelledError);
    expect(sqlLog(connection)).not.toContain('COMMIT');
    expect(sqlLog(connection)).toContain('ROLLBACK');
  });

  it('流挂死 → 墙钟计时器 destroy 在途流并超时报错', async () => {
    const connection = new FakeMysqlConnection();
    connection.streamRows = () => new Readable({ objectMode: true, read() { /* 永不出行 */ } });
    connection.abort = () => {
      connection.aborted += 1;
    };
    const plan = {
      entity_name: 'Avatar',
      row_budget: 10,
      queries: [rootQuery()],
      denied: [],
      missing: []
    };
    await expect(executeExportPlan(connection, plan, 7n, { timeoutMs: 30 })).rejects.toThrow(/timed out/);
    expect(connection.aborted).toBeGreaterThan(0);
    expect(sqlLog(connection)).not.toContain('COMMIT');
  }, 20000);

  it('流挂死 → 取消轮询 destroy 在途流(不等下一行)', async () => {
    const connection = new FakeMysqlConnection();
    connection.streamRows = () => new Readable({ objectMode: true, read() { /* 永不出行 */ } });
    connection.abort = () => {
      connection.aborted += 1;
    };
    let cancelled = false;
    const plan = {
      entity_name: 'Avatar',
      row_budget: 10,
      queries: [rootQuery()],
      denied: [],
      missing: []
    };
    const request = executeExportPlan(connection, plan, 7n, {
      timeoutMs: 5000,
      shouldCancel: () => cancelled
    });
    setTimeout(() => {
      cancelled = true;
    }, 10);
    await expect(request).rejects.toBeInstanceOf(CloneCancelledError);
    expect(connection.aborted).toBeGreaterThan(0);
  }, 20000);

  it('行数超过 row_budget → 中断并 abort', async () => {
    const connection = new FakeMysqlConnection();
    connection.streamRows = () => Readable.from([{ id: 1, sm_name: 'a' }, { id: 2, sm_name: 'b' }]);
    connection.abort = () => {
      connection.aborted += 1;
    };
    const plan = {
      entity_name: 'Avatar',
      row_budget: 1,
      queries: [rootQuery()],
      denied: [],
      missing: []
    };
    await expect(executeExportPlan(connection, plan, 7n)).rejects.toThrow(/exceeds row budget 1/);
    expect(connection.aborted).toBeGreaterThan(0);
    expect(sqlLog(connection)).not.toContain('COMMIT');
  });

  it('字节预算超限 → 中断并 abort', async () => {
    const connection = new FakeMysqlConnection();
    connection.streamRows = () => Readable.from([{ id: 1, sm_name: 'payload-wider-than-one-byte' }]);
    connection.abort = () => {
      connection.aborted += 1;
    };
    const plan = {
      entity_name: 'Avatar',
      row_budget: 10,
      queries: [rootQuery()],
      denied: [],
      missing: []
    };
    await expect(executeExportPlan(connection, plan, 7n, { maxBytes: 1 })).rejects.toThrow(/byte budget 1/);
    expect(connection.aborted).toBeGreaterThan(0);
    expect(sqlLog(connection)).not.toContain('COMMIT');
  });

  it('行迭代中取消 → CloneCancelledError 且 abort 在途流', async () => {
    const connection = new FakeMysqlConnection();
    connection.streamRows = () => Readable.from([{ id: 1, sm_name: 'hero' }, { id: 2, sm_name: 'hero2' }]);
    connection.abort = () => {
      connection.aborted += 1;
    };
    let seenRows = 0;
    const plan = {
      entity_name: 'Avatar',
      row_budget: 10,
      queries: [rootQuery()],
      denied: [],
      missing: []
    };
    await expect(
      executeExportPlan(connection, plan, 7n, {
        shouldCancel: () => {
          seenRows += 1;
          return seenRows > 1;
        }
      })
    ).rejects.toBeInstanceOf(CloneCancelledError);
    expect(connection.aborted).toBeGreaterThan(0);
    expect(sqlLog(connection)).not.toContain('COMMIT');
  });

  it('行迭代中墙钟越限 → 超时中断', async () => {
    const connection = new FakeMysqlConnection();
    connection.streamRows = () => Readable.from([{ id: 1, sm_name: 'hero' }, { id: 2, sm_name: 'hero2' }]);
    connection.abort = () => {
      connection.aborted += 1;
    };
    const plan = {
      entity_name: 'Avatar',
      row_budget: 10,
      queries: [rootQuery()],
      denied: [],
      missing: []
    };
    const dateSpy = jumpDateNowAfter(5);
    try {
      await expect(executeExportPlan(connection, plan, 7n, { timeoutMs: 10_000 })).rejects.toThrow(/timed out/);
    } finally {
      dateSpy.mockRestore();
    }
    expect(connection.aborted).toBeGreaterThan(0);
  });

  it('未知 filter kind → 拒绝(计划来自 Rust 也不豁免)', async () => {
    const connection = new FakeMysqlConnection();
    const plan = {
      entity_name: 'Avatar',
      row_budget: 10,
      queries: [rootQuery({ filter: { kind: 'wat' } as QueryPlanWire['queries'][number]['filter'] })],
      denied: [],
      missing: []
    };
    await expect(executeExportPlan(connection, plan, 7n)).rejects.toThrow(/unsupported export filter/);
    expect(sqlLog(connection)).toContain('ROLLBACK');
  });

  it('父子表:父行多条时逐父查询;父间取消 → 中断且已跑的父查询可见', async () => {
    const connection = new FakeMysqlConnection();
    connection.reply('FROM tbl_Avatar WHERE', [
      { id: 7, sm_name: 'hero' },
      { id: 8, sm_name: 'hero2' }
    ]);
    // 子表零行:父行间的 L403 取消检查(而非行内 L367)才是目标分支。
    connection.reply('FROM tbl_Avatar_items WHERE', []);
    connection.abort = () => {
      connection.aborted += 1;
    };
    const plan = {
      entity_name: 'Avatar',
      row_budget: 100,
      queries: [
        rootQuery(),
        {
          sequence: 1,
          table: 'tbl_Avatar_items',
          parent_table: 'tbl_Avatar',
          columns: ['id', 'sm_name'],
          column_types: ['bigint unsigned', 'varchar'],
          select_sql: 'SELECT id, sm_name FROM tbl_Avatar_items WHERE parentID = ?',
          filter: { kind: 'parent-id' } as const
        }
      ],
      denied: [],
      missing: []
    };
    await expect(
      executeExportPlan(connection, plan, 7n, {
        // 第一个子查询执行完后,第二个父行查询前取消(以执行日志为准,免计时)。
        shouldCancel: () => connection.log.some(entry => entry.sql.includes('FROM tbl_Avatar_items WHERE'))
      })
    ).rejects.toBeInstanceOf(CloneCancelledError);
    const childRuns = connection.log.filter(entry => entry.sql.includes('FROM tbl_Avatar_items WHERE'));
    expect(childRuns).toHaveLength(1);
    expect(childRuns[0].values).toEqual([7]);
    expect(sqlLog(connection)).not.toContain('COMMIT');
  });

  it('正常流:根查询 + 子查询,控制语句与 COMMIT 顺序在案', async () => {
    const connection = new FakeMysqlConnection();
    connection.reply('FROM tbl_Avatar WHERE', [{ id: 7, sm_name: 'hero' }]);
    connection.reply('FROM tbl_Avatar_items WHERE', [{ id: 100, sm_name: 'sword' }]);
    const plan = {
      entity_name: 'Avatar',
      row_budget: 100,
      queries: [
        rootQuery(),
        {
          sequence: 1,
          table: 'tbl_Avatar_items',
          parent_table: 'tbl_Avatar',
          columns: ['id', 'sm_name'],
          column_types: ['bigint unsigned', 'varchar'],
          select_sql: 'SELECT id, sm_name FROM tbl_Avatar_items WHERE parentID = ?',
          filter: { kind: 'parent-id' } as const
        }
      ],
      denied: [],
      missing: []
    };
    const rows = await executeExportPlan(connection, plan, 7n);
    expect(rows).toEqual([
      { table: 'tbl_Avatar', values: [tvBigUInt(7), tvText('hero')] },
      { table: 'tbl_Avatar_items', values: [tvBigUInt(100), tvText('sword')] }
    ]);
    const log = sqlLog(connection);
    expect(log[0]).toBe('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    expect(log[1]).toBe('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
    expect(log.at(-1)).toBe('COMMIT');
  });
});

/** Date.now 计数桩:前 keepCalls 次返回真实墙钟,之后一律返回 realNow+60s(跨过 deadline)。 */
function jumpDateNowAfter(keepCalls: number) {
  const realNow = Date.now();
  let calls = 0;
  return vi.spyOn(Date, 'now').mockImplementation(() => {
    calls += 1;
    return calls <= keepCalls ? realNow : realNow + 60_000;
  });
}

// ---------------------------------------------------------------------------
// applyImportPlan 语义面
// ---------------------------------------------------------------------------

const miniPlan = (): ImportPlanWire => ({
  entity_name: 'Avatar',
  mode: 'allocate-new-ids',
  autoload_policy: 'force-disabled',
  order: ['tbl_Avatar', 'tbl_Avatar_items'],
  statements: [
    {
      sequence: 0,
      table: 'tbl_Avatar',
      row_index: 0,
      columns: ['id', 'sm_autoLoad', 'sm_name'],
      cells: [
        { kind: 'new-key', placeholder: 1 },
        { kind: 'policy-override' },
        { kind: 'remapped' }
      ],
      insert_sql: 'INSERT INTO tbl_Avatar (id, sm_autoLoad, sm_name) VALUES (?, ?, ?)'
    },
    {
      sequence: 1,
      table: 'tbl_Avatar_items',
      row_index: 0,
      columns: ['id', 'parentID', 'sm_value'],
      cells: [
        { kind: 'new-key', placeholder: 2 },
        { kind: 'key-reference', placeholder: 1 },
        { kind: 'literal' }
      ],
      insert_sql: 'INSERT INTO tbl_Avatar_items (id, parentID, sm_value) VALUES (?, ?, ?)'
    }
  ],
  idmap: [
    {
      key: { table: 'tbl_Avatar', column: 'sm_name', old: tvText('hero') },
      mapped: { kind: 'rebuilt', value: tvText('hero_imported1') },
      category: 'rebuilt-identity'
    }
  ],
  conflicts: [],
  account_binding: { declaration: null, login_ready: false, note: '' },
  schema_notes: [],
  warnings: [],
  summary: {
    entity_name: 'Avatar',
    mode: 'allocate-new-ids',
    autoload_policy: 'force-disabled',
    statements_per_table: { tbl_Avatar: 1, tbl_Avatar_items: 1 },
    id_categories: {},
    unique_conflicts: 0,
    login_ready: false,
    unresolved_reference_risks: 0
  }
});

const miniRows = (): Map<string, TypedRowWire[]> =>
  new Map([
    ['tbl_Avatar', [{ table: 'tbl_Avatar', values: [tvBigUInt(7), tvUInt(1), tvText('hero')] }]],
    ['tbl_Avatar_items', [{ table: 'tbl_Avatar_items', values: [tvBigUInt(100), tvBigUInt(7), tvText('sword')] }]]
  ]);

const miniColumnOrder = (): Map<string, string[]> =>
  new Map([
    ['tbl_Avatar', ['id', 'sm_autoLoad', 'sm_name']],
    ['tbl_Avatar_items', ['id', 'parentID', 'sm_value']]
  ]);

/** 单语句(仅根表 new-key + literal):用于 insertId 0 / header 数组边界。 */
const rootOnlyPlan = (): ImportPlanWire => ({
  entity_name: 'Avatar',
  mode: 'allocate-new-ids',
  autoload_policy: 'force-disabled',
  order: ['tbl_Avatar'],
  statements: [
    {
      sequence: 0,
      table: 'tbl_Avatar',
      row_index: 0,
      columns: ['id', 'sm_autoLoad', 'sm_name'],
      cells: [
        { kind: 'new-key', placeholder: 1 },
        { kind: 'literal' },
        { kind: 'literal' }
      ],
      insert_sql: 'INSERT INTO tbl_Avatar (id, sm_autoLoad, sm_name) VALUES (?, ?, ?)'
    }
  ],
  idmap: [],
  conflicts: [],
  account_binding: { declaration: null, login_ready: false, note: '' },
  schema_notes: [],
  warnings: [],
  summary: {
    entity_name: 'Avatar',
    mode: 'allocate-new-ids',
    autoload_policy: 'force-disabled',
    statements_per_table: { tbl_Avatar: 1 },
    id_categories: {},
    unique_conflicts: 0,
    login_ready: false,
    unresolved_reference_risks: 0
  }
});

describe('applyImportPlan(单事务执行器)', () => {
  it('正常流:占位回填/策略覆写/重建值/引用绑定/逐表核对/逆拓扑清理', async () => {
    const connection = new FakeMysqlConnection();
    connection.reply('SELECT COUNT(*)', [{ c: 1 }]);
    const progress: Array<[number, number]> = [];
    const result = await applyImportPlan(connection, miniPlan(), miniRows(), miniColumnOrder(), {
      onProgress: (done, total) => progress.push([done, total])
    });

    const log = sqlLog(connection);
    expect(log[0]).toBe('START TRANSACTION');
    expect(log[1]).toContain('INSERT INTO tbl_Avatar');
    expect(log[2]).toContain('INSERT INTO tbl_Avatar_items');
    expect(log[3]).toBe('COMMIT');
    expect(log).not.toContain('ROLLBACK');
    expect(log.some(sql => sql.includes('DELETE'))).toBe(false);
    // 根行:NULL(自增) + 0(autoLoad 禁用) + hero_imported1(重建);
    // 子行 parentID 绑根行回填的真实新主键。
    expect(connection.log[1].values).toEqual([null, 0, 'hero_imported1']);
    expect(connection.log[2].values).toEqual([null, 1000, 'sword']);
    expect(progress).toEqual([[1, 2], [2, 2]]);
    expect(result.insertedPerTable).toEqual({ tbl_Avatar: 1, tbl_Avatar_items: 1 });
    expect(result.resolvedIds).toEqual({ 1: 1000, 2: 1001 });
    expect(result.newRootId).toBe(1000);
    expect(result.verify.every(check => check.ok)).toBe(true);
    expect(result.cleanup.map(step => step.sql)).toEqual([
      'DELETE FROM tbl_Avatar_items WHERE id IN (?)',
      'DELETE FROM tbl_Avatar WHERE id IN (?)'
    ]);
  });

  it('超安全整数 insertId 以字符串回填子表引用', async () => {
    const connection = new FakeMysqlConnection();
    connection.reply('INSERT INTO tbl_Avatar (', { insertId: '9007199254740993' });
    connection.reply('INSERT INTO tbl_Avatar_items', { insertId: '9007199254740994' });
    connection.reply('SELECT COUNT(*)', [{ c: 1 }]);
    const result = await applyImportPlan(connection, miniPlan(), miniRows(), miniColumnOrder());
    const childBind = connection.log.find(entry => entry.sql.includes('INSERT INTO tbl_Avatar_items'));
    expect(childBind?.values?.[1]).toBe('9007199254740993');
    expect(result.newRootId).toBe('9007199254740993');
  });

  it('语句引用的归档行不存在 → 报错并回滚', async () => {
    const connection = new FakeMysqlConnection();
    const rows = miniRows();
    rows.set('tbl_Avatar_items', []);
    await expect(applyImportPlan(connection, miniPlan(), rows, miniColumnOrder())).rejects.toThrow(
      /absent from the archive/
    );
    expect(sqlLog(connection)).toContain('ROLLBACK');
    expect(sqlLog(connection)).not.toContain('COMMIT');
  });

  it('列序与归档行宽不齐 → 报错并回滚', async () => {
    const connection = new FakeMysqlConnection();
    const order = new Map([['tbl_Avatar', ['id', 'sm_autoLoad', 'sm_name']], ['tbl_Avatar_items', ['id', 'parentID']]]);
    await expect(applyImportPlan(connection, miniPlan(), miniRows(), order)).rejects.toThrow(
      /does not match the archive row width/
    );
    expect(sqlLog(connection)).toContain('ROLLBACK');
  });

  it('列序缺席(表不在 plan 列序)→ 报错并回滚', async () => {
    const connection = new FakeMysqlConnection();
    const order = new Map([['tbl_Avatar', ['id', 'sm_autoLoad', 'sm_name']]]);
    await expect(applyImportPlan(connection, miniPlan(), miniRows(), order)).rejects.toThrow(
      /does not match the archive row width/
    );
    expect(sqlLog(connection)).toContain('ROLLBACK');
  });

  it('key-reference 在其行插入前被引用(乱序)→ 报错并回滚', async () => {
    const connection = new FakeMysqlConnection();
    const plan = miniPlan();
    plan.statements[0].cells = [
      { kind: 'key-reference', placeholder: 42 },
      { kind: 'policy-override' },
      { kind: 'remapped' }
    ];
    await expect(applyImportPlan(connection, plan, miniRows(), miniColumnOrder())).rejects.toThrow(
      /order violation/
    );
    expect(sqlLog(connection)).toContain('ROLLBACK');
  });

  it('insertId 0(new-key 不回填)→ 无 resolvedIds/核对/清理,newRootId null', async () => {
    const connection = new FakeMysqlConnection();
    connection.reply('INSERT INTO tbl_Avatar (', { insertId: 0 });
    const plan = rootOnlyPlan();
    const rows: Map<string, TypedRowWire[]> = new Map([
      ['tbl_Avatar', [{ table: 'tbl_Avatar', values: [tvBigUInt(7), tvUInt(1), tvText('hero')] }]]
    ]);
    const order = new Map([['tbl_Avatar', ['id', 'sm_autoLoad', 'sm_name']]]);
    const result = await applyImportPlan(connection, plan, rows, order);
    expect(result.resolvedIds).toEqual({});
    expect(result.newRootId).toBeNull();
    expect(result.verify).toEqual([]);
    expect(result.cleanup).toEqual([]);
    expect(sqlLog(connection)).toContain('COMMIT');
  });

  it('语句结果为数组(header 形态)→ 视为无 insertId,不猜', async () => {
    const connection = new FakeMysqlConnection();
    connection.reply('INSERT INTO tbl_Avatar (', [[], []]);
    const plan = rootOnlyPlan();
    const rows: Map<string, TypedRowWire[]> = new Map([
      ['tbl_Avatar', [{ table: 'tbl_Avatar', values: [tvBigUInt(7), tvUInt(1), tvText('hero')] }]]
    ]);
    const order = new Map([['tbl_Avatar', ['id', 'sm_autoLoad', 'sm_name']]]);
    const result = await applyImportPlan(connection, plan, rows, order);
    expect(result.resolvedIds).toEqual({});
    expect(result.newRootId).toBeNull();
    expect(sqlLog(connection)).toContain('COMMIT');
  });

  it('preserve-archive 策略:policy-override 绑归档原值', async () => {
    const connection = new FakeMysqlConnection();
    connection.reply('SELECT COUNT(*)', [{ c: 1 }]);
    const plan = miniPlan();
    plan.autoload_policy = 'preserve-archive';
    await applyImportPlan(connection, plan, miniRows(), miniColumnOrder());
    expect(connection.log[1].values).toEqual([null, 1, 'hero_imported1']);
  });

  it('idmap rebuilt 无值 → remapped 退回归档原值', async () => {
    const connection = new FakeMysqlConnection();
    connection.reply('SELECT COUNT(*)', [{ c: 1 }]);
    const plan = miniPlan();
    plan.idmap = [
      { key: { table: 'tbl_Avatar', column: 'sm_name', old: tvText('hero') }, mapped: { kind: 'rebuilt' }, category: 'rebuilt-identity' }
    ];
    await applyImportPlan(connection, plan, miniRows(), miniColumnOrder());
    expect(connection.log[1].values).toEqual([null, 0, 'hero']);
  });

  it('语句间取消(循环顶)→ CloneApplyCancelledError 且回滚', async () => {
    const connection = new FakeMysqlConnection();
    let calls = 0;
    await expect(
      applyImportPlan(connection, miniPlan(), miniRows(), miniColumnOrder(), {
        shouldCancel: () => {
          calls += 1;
          return calls > 1;
        }
      })
    ).rejects.toBeInstanceOf(CloneApplyCancelledError);
    expect(sqlLog(connection)).toContain('ROLLBACK');
    expect(sqlLog(connection)).not.toContain('COMMIT');
    // 第二条语句没执行(取消在第一条之后)。
    expect(connection.log.filter(entry => entry.sql.startsWith('INSERT INTO'))).toHaveLength(1);
  });

  it('语句全部执行后、COMMIT 前取消 → 回滚', async () => {
    const connection = new FakeMysqlConnection();
    let calls = 0;
    await expect(
      applyImportPlan(connection, miniPlan(), miniRows(), miniColumnOrder(), {
        shouldCancel: () => {
          calls += 1;
          return calls > 2;
        }
      })
    ).rejects.toBeInstanceOf(CloneApplyCancelledError);
    expect(sqlLog(connection)).toContain('ROLLBACK');
    expect(sqlLog(connection)).not.toContain('COMMIT');
  });

  it('提交后 COUNT 复核不足 → verify 如实 ok:false(不回滚已提交事务)', async () => {
    const connection = new FakeMysqlConnection();
    connection.reply('SELECT COUNT(*)', [{ c: 0 }]);
    const result = await applyImportPlan(connection, miniPlan(), miniRows(), miniColumnOrder());
    expect(result.verify).toEqual([
      { table: 'tbl_Avatar', expected: 1, found: 0, ok: false },
      { table: 'tbl_Avatar_items', expected: 1, found: 0, ok: false }
    ]);
    expect(sqlLog(connection)).toContain('COMMIT');
  });

  it('COUNT 复核异常 → ClonePostCommitError(提交已发生)', async () => {
    const connection = new FakeMysqlConnection();
    connection.failOn('SELECT COUNT(*)');
    await expect(applyImportPlan(connection, miniPlan(), miniRows(), miniColumnOrder())).rejects.toBeInstanceOf(
      ClonePostCommitError
    );
  });

  it('语句失败 → ROLLBACK 后抛原始错误', async () => {
    const connection = new FakeMysqlConnection();
    connection.failOn('INSERT INTO tbl_Avatar_items');
    await expect(applyImportPlan(connection, miniPlan(), miniRows(), miniColumnOrder())).rejects.toThrow(/boom/);
    expect(sqlLog(connection)).toContain('ROLLBACK');
    expect(sqlLog(connection)).not.toContain('COMMIT');
  });

  it('ROLLBACK 自身失败 → CloneRollbackUnknownError(结果不可断言)', async () => {
    const connection = new FakeMysqlConnection();
    connection.failOn('INSERT INTO tbl_Avatar_items');
    connection.failOn('ROLLBACK');
    await expect(applyImportPlan(connection, miniPlan(), miniRows(), miniColumnOrder())).rejects.toBeInstanceOf(
      CloneRollbackUnknownError
    );
  });

  it('COMMIT 失败 → CloneCommitUnknownError(可能已提交)', async () => {
    const connection = new FakeMysqlConnection();
    connection.failOn('COMMIT');
    await expect(applyImportPlan(connection, miniPlan(), miniRows(), miniColumnOrder())).rejects.toBeInstanceOf(
      CloneCommitUnknownError
    );
    expect(sqlLog(connection)).not.toContain('ROLLBACK');
  });
});
