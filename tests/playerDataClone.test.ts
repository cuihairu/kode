import { describe, expect, it } from 'vitest';
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
  probePhysicalTables,
  uniqueValuesFromRows,
  type CloneMysqlConnection
} from '../src/playerDataCloneMysql';
import {
  CloneProfileStore,
  type CloneProfileDeps
} from '../src/playerDataCloneProfiles';
import {
  cellToTypedValue,
  isArchiveMeta,
  isImportPlan,
  typedValueToBind,
  tvBigUInt,
  tvInt,
  tvText,
  tvUInt,
  type ImportPlanWire,
  type TypedRowWire
} from '../src/playerDataCloneWire';

// CLONE-P5:Player Data Clone 的 TS 面(计划书 §6.2/§6.4/§7)。三块:
// 1) wire 归型/形状闸;2) Profile 台账(密码只进 secrets,不进配置);
// 3) mysql 会话面——Apply 执行器与 crate apply.rs 同语义(单事务/占位回填/
//    失败取消回滚/提交后核对/逆拓扑清理只生成),导出计划执行(根 DBID +
//    parentID 逐父行)。

// ---------------------------------------------------------------------------
// wire
// ---------------------------------------------------------------------------

describe('playerDataCloneWire(归型与形状闸)', () => {
  it('mysql2 单元格按物理列型归型(整数精确/decimal 文本/未知退文本)', () => {
    expect(cellToTypedValue(7, 'bigint(20) unsigned')).toEqual(tvBigUInt(7));
    expect(cellToTypedValue(1, 'tinyint')).toEqual(tvInt(1));
    expect(cellToTypedValue(1, 'tinyint unsigned')).toEqual(tvUInt(1));
    expect(cellToTypedValue(-3, 'int')).toEqual({ t: 'int', v: -3 });
    expect(cellToTypedValue('12.30', 'decimal(10,2)')).toEqual({ t: 'decimal', v: '12.30' });
    expect(cellToTypedValue(null, 'varchar(255)')).toEqual({ t: 'null' });
    expect(cellToTypedValue('weird', 'enum(a,b)')).toEqual(tvText('weird'));
  });

  it('typedValueToBind 还原为 mysql2 绑定值', () => {
    expect(typedValueToBind(tvBigUInt(7))).toBe(7);
    expect(typedValueToBind(tvText('hero'))).toBe('hero');
    expect(typedValueToBind({ t: 'null' })).toBeNull();
  });

  it('形状闸:清单/计划合规放行,缺字段拒绝', () => {
    expect(isArchiveMeta({ entity: 'Avatar', total_rows: 2, tables: [] })).toBe(true);
    expect(isArchiveMeta({ entity: 'Avatar' })).toBe(false);
    expect(isImportPlan({
      entity_name: 'Avatar',
      order: ['tbl_Avatar'],
      statements: [{ table: 'tbl_Avatar', columns: ['id'], cells: [], insert_sql: 'INSERT' }],
      summary: {}
    })).toBe(true);
    expect(isImportPlan({ entity_name: 'Avatar', order: [], statements: 'x' })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Profile 台账
// ---------------------------------------------------------------------------

const makeProfileDeps = () => {
  const stored = new Map<string, unknown>();
  const secrets = new Map<string, string>();
  const deps: CloneProfileDeps = {
    load: () => stored.get('payload'),
    save: data => {
      stored.set('payload', data);
    },
    secrets: {
      get: async key => secrets.get(key),
      store: async (key, value) => {
        secrets.set(key, value);
      },
      delete: async key => {
        secrets.delete(key);
      }
    }
  };
  return { deps, stored, secrets };
};

describe('CloneProfileStore(密码只进 secrets 面)', () => {
  it('保存/读回:配置入持久层,密码只入 secrets', async () => {
    const { deps, stored, secrets } = makeProfileDeps();
    const store = new CloneProfileStore(deps);
    await store.save(
      'target',
      { host: '127.0.0.1', port: 3306, user: 'kbe', database: 'kbe_local', environment: 'local' },
      'pw'
    );
    const persisted = JSON.stringify(stored.get('payload'));
    expect(persisted).toContain('kbe_local');
    expect(persisted).not.toContain('pw');
    expect(secrets.get('kode.playerClone.target.password')).toBe('pw');
    const resolved = await store.resolveConnection('target');
    expect(resolved?.password).toBe('pw');
    expect(resolved?.environment).toBe('local');
  });

  it('source 无环境字段;target 的 prod/staging 在配置闸即拒绝', async () => {
    const { deps } = makeProfileDeps();
    const store = new CloneProfileStore(deps);
    await store.save('source', { host: 'h', port: 3306, user: 'u', database: 'd' }, null);
    expect(store.get('source')?.environment).toBeUndefined();

    // 直接持久化一个 environment=prod 的 payload → 构造闸拒绝,不回显
    const bad = makeProfileDeps();
    bad.stored.set('payload', {
      profiles: {
        target: { host: 'h', port: 1, user: 'u', database: 'd', environment: 'prod', hasStoredSecret: false }
      }
    });
    const reloaded = new CloneProfileStore(bad.deps);
    expect(reloaded.get('target')).toBeNull();
  });

  it('清除配置同时清密钥;保存 undefined 密码保留既有密钥', async () => {
    const { deps } = makeProfileDeps();
    const store = new CloneProfileStore(deps);
    await store.save('source', { host: 'h', port: 1, user: 'u', database: 'd' }, 'pw1');
    await store.save('source', { host: 'h2', port: 2, user: 'u', database: 'd' }, undefined);
    expect((await store.resolveConnection('source'))?.password).toBe('pw1');
    expect((await store.resolveConnection('source'))?.host).toBe('h2');
    await store.clear('source');
    expect(store.get('source')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// mysql 会话面:探测 / 导出执行 / Apply 执行器
// ---------------------------------------------------------------------------

/** 记录型假连接:预置语句结果,记录全部执行(含参数)。 */
class FakeMysqlConnection implements CloneMysqlConnection {
  readonly log: Array<{ sql: string; values?: unknown[] }> = [];
  private readonly results = new Map<string, unknown>();
  private autoId = 1000;
  committed: Array<Record<string, unknown[]>> = [];

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

  async end(): Promise<void> {}
}

describe('probePhysicalTables(information_schema 探测)', () => {
  it('组表:引擎/列型/主键/单列唯一索引', async () => {
    const connection = new FakeMysqlConnection();
    connection.reply('FROM information_schema.TABLES', [{ ENGINE: 'InnoDB' }]);
    connection.reply('FROM information_schema.COLUMNS', [
      { COLUMN_NAME: 'id', COLUMN_TYPE: 'bigint(20) unsigned' },
      { COLUMN_NAME: 'sm_name', COLUMN_TYPE: 'varchar(255)' }
    ]);
    connection.reply('FROM information_schema.STATISTICS', [
      { INDEX_NAME: 'PRIMARY', NON_UNIQUE: 0, SEQ_IN_INDEX: 1, COLUMN_NAME: 'id' },
      { INDEX_NAME: 'uk_name', NON_UNIQUE: 0, SEQ_IN_INDEX: 1, COLUMN_NAME: 'sm_name' }
    ]);
    const tables = await probePhysicalTables(connection, ['tbl_Avatar']);
    expect(tables).toHaveLength(1);
    expect(tables[0].engine).toBe('InnoDB');
    expect(tables[0].columns.sm_name).toBe('varchar(255)');
    expect(tables[0].primaryKey).toEqual(['id']);
    expect(tables[0].indexes).toEqual([['sm_name']]);
  });

  it('表名只认安全标识符(防注入面)', async () => {
    const connection = new FakeMysqlConnection();
    await expect(probePhysicalTables(connection, ['tbl; DROP'])).rejects.toThrow(/unsafe/);
  });
});

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
    [
      'tbl_Avatar',
      [{ table: 'tbl_Avatar', values: [tvBigUInt(7), tvUInt(1), tvText('hero')] }]
    ],
    [
      'tbl_Avatar_items',
      [{ table: 'tbl_Avatar_items', values: [tvBigUInt(100), tvBigUInt(7), tvText('sword')] }]
    ]
  ]);

const miniColumnOrder = (): Map<string, string[]> =>
  new Map([
    ['tbl_Avatar', ['id', 'sm_autoLoad', 'sm_name']],
    ['tbl_Avatar_items', ['id', 'parentID', 'sm_value']]
  ]);

describe('applyImportPlan(单事务执行器,语义对齐 crate apply.rs)', () => {
  it('begin→逐句→commit;占位回填;策略覆写/重建值/引用绑定', async () => {
    const connection = new FakeMysqlConnection();
    connection.reply('SELECT COUNT(*)', [{ c: 1 }]);
    const result = await applyImportPlan(
      connection,
      miniPlan(),
      miniRows(),
      miniColumnOrder()
    );

    const sqlLog = connection.log.map(entry => entry.sql);
    expect(sqlLog[0]).toBe('START TRANSACTION');
    expect(sqlLog[1]).toContain('INSERT INTO tbl_Avatar');
    expect(sqlLog[2]).toContain('INSERT INTO tbl_Avatar_items');
    expect(sqlLog[3]).toBe('COMMIT');
    expect(sqlLog).not.toContain('ROLLBACK');

    // 根行绑定:NULL(自增)+ 0(autoLoad 禁用)+ hero_imported1(重建)。
    expect(connection.log[1].values).toEqual([null, 0, 'hero_imported1']);
    // 子行 parentID 绑定根行回填的真实新主键(1000)。
    expect(connection.log[2].values).toEqual([null, 1000, 'sword']);

    expect(result.insertedPerTable).toEqual({ tbl_Avatar: 1, tbl_Avatar_items: 1 });
    expect(result.resolvedIds).toEqual({ 1: 1000, 2: 1001 });
    expect(result.newRootId).toBe(1000);
    expect(result.verify.every(check => check.ok)).toBe(true);
    // 清理:逆拓扑(子先父后),只生成不执行。
    expect(result.cleanup.map(step => step.sql)).toEqual([
      'DELETE FROM tbl_Avatar_items WHERE id IN (?)',
      'DELETE FROM tbl_Avatar WHERE id IN (?)'
    ]);
    expect(sqlLog.some(sql => sql.includes('DELETE'))).toBe(false);
  });

  it('语句失败 → ROLLBACK 后抛出,无半套数据', async () => {
    const connection = new FakeMysqlConnection();
    connection.failOn('INSERT INTO tbl_Avatar_items');
    await expect(
      applyImportPlan(connection, miniPlan(), miniRows(), miniColumnOrder())
    ).rejects.toThrow(/boom/);
    const sqlLog = connection.log.map(entry => entry.sql);
    expect(sqlLog).toContain('ROLLBACK');
    expect(sqlLog).not.toContain('COMMIT');
  });

  it('取消(§6.4 Apply 期取消 = 回滚)', async () => {
    const connection = new FakeMysqlConnection();
    let calls = 0;
    const result = applyImportPlan(connection, miniPlan(), miniRows(), miniColumnOrder(), {
      shouldCancel: () => {
        calls += 1;
        return calls > 1;
      }
    });
    await expect(result).rejects.toBeInstanceOf(CloneApplyCancelledError);
    const sqlLog = connection.log.map(entry => entry.sql);
    expect(sqlLog).toContain('ROLLBACK');
    expect(sqlLog).not.toContain('COMMIT');
  });

  it('区分提交结果不确定、提交后复核失败与回滚失败', async () => {
    const commit = new FakeMysqlConnection();
    commit.failOn('COMMIT');
    await expect(applyImportPlan(commit, miniPlan(), miniRows(), miniColumnOrder())).rejects.toBeInstanceOf(CloneCommitUnknownError);
    expect(commit.log.some(entry => entry.sql === 'ROLLBACK')).toBe(false);

    const verify = new FakeMysqlConnection();
    verify.failOn('SELECT COUNT(*)');
    await expect(applyImportPlan(verify, miniPlan(), miniRows(), miniColumnOrder())).rejects.toBeInstanceOf(ClonePostCommitError);

    const rollback = new FakeMysqlConnection();
    rollback.failOn('INSERT INTO tbl_Avatar_items');
    rollback.failOn('ROLLBACK');
    await expect(applyImportPlan(rollback, miniPlan(), miniRows(), miniColumnOrder())).rejects.toBeInstanceOf(CloneRollbackUnknownError);
  });

  it('自增 ID 超过 JS 安全整数时以字符串传给子表', async () => {
    const connection = new FakeMysqlConnection();
    connection.reply('INSERT INTO tbl_Avatar (', { insertId: '9007199254740993' });
    connection.reply('INSERT INTO tbl_Avatar_items', { insertId: '9007199254740994' });
    connection.reply('SELECT COUNT(*)', [{ c: 1 }]);
    const result = await applyImportPlan(connection, miniPlan(), miniRows(), miniColumnOrder());
    expect(connection.log.find(entry => entry.sql.includes('INSERT INTO tbl_Avatar_items'))?.values?.[1]).toBe('9007199254740993');
    expect(result.newRootId).toBe('9007199254740993');
  });
});

describe('columnOrderFromPlan / uniqueValuesFromRows(两遍计划的探测面)', () => {
  it('列序取计划首语句;唯一值按列序提取(有界)', () => {
    const plan = miniPlan();
    const order = columnOrderFromPlan(plan);
    expect(order.get('tbl_Avatar')).toEqual(['id', 'sm_autoLoad', 'sm_name']);
    const candidates = uniqueValuesFromRows(miniRows(), order, [
      { table: 'tbl_Avatar', column: 'sm_name' }
    ]);
    expect(candidates).toEqual([{ table: 'tbl_Avatar', column: 'sm_name', value: tvText('hero') }]);
    // 列不在计划列序 → 无候选(不猜列位)。
    expect(
      uniqueValuesFromRows(miniRows(), order, [{ table: 'tbl_Avatar', column: 'sm_ghost' }])
    ).toEqual([]);
  });
});

describe('executeExportPlan(只读计划执行)', () => {
  const budgetPlan = {
    entity_name: 'Avatar', row_budget: 10, denied: [], missing: [],
    queries: [{ sequence: 0, table: 'tbl_Avatar', columns: ['id', 'value'], column_types: ['bigint unsigned', 'varchar'], select_sql: 'SELECT id, value FROM tbl_Avatar WHERE id = ?', filter: { kind: 'root-id' } }]
  };

  it('streaming export enforces row and byte budgets and aborts the active connection', async () => {
    for (const options of [{ maxBytes: 10 }, { maxBytes: 10000 }]) {
      const connection = new FakeMysqlConnection() as FakeMysqlConnection & CloneMysqlConnection;
      let aborted = false;
      connection.streamRows = () => Readable.from([{ id: 1, value: 'content' }, { id: 2, value: 'more' }]);
      connection.abort = () => { aborted = true; };
      const plan = { ...budgetPlan, row_budget: options.maxBytes === 10 ? 10 : 1 };
      await expect(executeExportPlan(connection, plan, 1, options)).rejects.toThrow(/budget/);
      expect(aborted).toBe(true);
      expect(connection.log.map(entry => entry.sql)).not.toContain('COMMIT');
    }
  });

  it('aborts a stalled stream at the wall-clock deadline', async () => {
    const connection = new FakeMysqlConnection() as FakeMysqlConnection & CloneMysqlConnection;
    let aborted = false;
    connection.streamRows = () => new Readable({ objectMode: true, read() {} });
    connection.abort = () => { aborted = true; };
    await expect(executeExportPlan(connection, budgetPlan, 1, { timeoutMs: 20 })).rejects.toThrow(/timed out/);
    expect(aborted).toBe(true);
  });

  it('aborts a stalled snapshot setup at the same deadline', async () => {
    const connection = new FakeMysqlConnection() as FakeMysqlConnection & CloneMysqlConnection;
    let aborted = false;
    connection.abort = () => { aborted = true; };
    connection.query = async sql => sql.startsWith('START TRANSACTION')
      ? new Promise<[unknown, unknown]>(() => undefined) : [[], []];
    await expect(executeExportPlan(connection, budgetPlan, 1, { timeoutMs: 20 })).rejects.toThrow(/timed out/);
    expect(aborted).toBe(true);
  });

  it('cancels a stalled query without waiting for another row', async () => {
    const connection = new FakeMysqlConnection() as FakeMysqlConnection & CloneMysqlConnection;
    let aborted = false;
    let cancelled = false;
    connection.streamRows = () => new Readable({ objectMode: true, read() {} });
    connection.abort = () => { aborted = true; };
    const request = executeExportPlan(connection, budgetPlan, 1, { timeoutMs: 5000, shouldCancel: () => cancelled });
    setTimeout(() => { cancelled = true; }, 10);
    await expect(request).rejects.toBeInstanceOf(CloneCancelledError);
    expect(aborted).toBe(true);
  });
  it('根表按 DBID;子表按父行 id 逐次;行值按列型归型', async () => {
    const connection = new FakeMysqlConnection();
    connection.reply('FROM tbl_Avatar WHERE', [{ id: 7, sm_autoLoad: 1, sm_name: 'hero' }]);
    connection.reply('FROM tbl_Avatar_items WHERE', [
      { id: 100, parentID: 7, sm_value: 'sword' }
    ]);
    const rows = await executeExportPlan(
      connection,
      {
        entity_name: 'Avatar',
        row_budget: 100,
        queries: [
          {
            sequence: 0,
            table: 'tbl_Avatar',
            columns: ['id', 'sm_autoLoad', 'sm_name'],
            column_types: ['bigint unsigned', 'tinyint', 'varchar'],
            select_sql: 'SELECT id, sm_autoLoad, sm_name FROM tbl_Avatar WHERE id = ?',
            filter: { kind: 'root-id' }
          },
          {
            sequence: 1,
            table: 'tbl_Avatar_items',
            parent_table: 'tbl_Avatar',
            columns: ['id', 'parentID', 'sm_value'],
            column_types: ['bigint unsigned', 'bigint unsigned', 'varchar'],
            select_sql:
              'SELECT id, parentID, sm_value FROM tbl_Avatar_items WHERE parentID = ?',
            filter: { kind: 'parent-id' }
          }
        ],
        denied: [],
        missing: []
      },
      7n
    );
    expect(rows).toEqual([
      { table: 'tbl_Avatar', values: [tvBigUInt(7), tvInt(1), tvText('hero')] },
      { table: 'tbl_Avatar_items', values: [tvBigUInt(100), tvBigUInt(7), tvText('sword')] }
    ]);
    // 子查询绑定的是根行 id(7)。
    expect(connection.log.find(entry => entry.sql.includes('FROM tbl_Avatar_items WHERE'))?.values).toEqual([7]);
    expect(connection.log[0].sql).toBe('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    expect(connection.log[1].sql).toBe('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
    expect(connection.log.at(-1)?.sql).toBe('COMMIT');
  });

  it('取消中断只读执行', async () => {
    const connection = new FakeMysqlConnection();
    connection.reply('FROM tbl_Avatar WHERE', [{ id: 7, sm_autoLoad: 1, sm_name: 'hero' }]);
    await expect(
      executeExportPlan(
        connection,
        {
          entity_name: 'Avatar',
          row_budget: 100,
          queries: [
            {
              sequence: 0,
              table: 'tbl_Avatar',
              columns: ['id'],
              column_types: ['bigint unsigned'],
              select_sql: 'SELECT id FROM tbl_Avatar WHERE id = ?',
              filter: { kind: 'root-id' }
            }
          ],
          denied: [],
          missing: []
        },
        7n,
        { shouldCancel: () => true }
      )
    ).rejects.toBeInstanceOf(CloneCancelledError);
  });
});
