import { createServer } from 'http';
import type { AddressInfo } from 'net';
import { describe, expect, it } from 'vitest';
import {
  assertReadOnlyStatement,
  buildMysqlConnectionOptions,
  buildDriftReport,
  buildDriftReportForSnapshots,
  checkDatabaseDrift,
  compareTableColumns,
  createMysqlDriftExecutor,
  createMysqlDriftExecutorWith,
  describeDriftSummary,
  isColumnTypeCompatible,
  MYSQL_DEFAULT_PORT,
  publishDriftReport,
  ReadOnlyViolationError,
  renderDriftReport
} from '../src/databaseDrift';
import type {
  DriftChannelLike,
  DriftQueryExecutor,
  MysqlModuleLike,
  QueryResult
} from '../src/databaseDrift';
import type { DatabaseSchemaSnapshot, TableFieldDescriptor } from '../src/databaseSchema';
import type { DatabaseInterfaceConfig } from '../src/serverConfigMerge';

// 漂移校验的纯逻辑层:语句白名单(只读红线)、列型相容判定、虚拟表↔真实表
// 对比与报告渲染。真连接(mysql2)不进用例——注入替身即可覆盖判读口径;
// 只读红线本身由白名单单测锁死(拒写、拒多语句、拒注释伪装)。

const database: DatabaseInterfaceConfig = {
  host: '127.0.0.1',
  port: 13306,
  username: 'game',
  databaseName: 'game_db',
  encrypt: false,
  characterSet: 'utf8mb4',
  plainPassword: 'kbe'
};

const field = (name: string, typeLabel: string): TableFieldDescriptor => ({
  name,
  typeLabel,
  sourcePath: name,
  source: { filePath: '/proj/Hero.def', line: 1, path: name, category: 'entity' },
  identifier: false
});

const snapshot: DatabaseSchemaSnapshot = {
  backend: 'mysql',
  entityName: 'Hero',
  database,
  tables: [
    {
      name: 'tbl_Hero',
      kind: 'entity',
      title: 'Hero',
      source: { filePath: '/proj/Hero.def', line: 1, path: 'Hero', category: 'entity' },
      fields: [field('id', 'bigint unsigned'), field('sm_autoLoad', 'tinyint'), field('sm_hp', 'int unsigned')]
    },
    {
      name: 'tbl_Hero_bag',
      kind: 'array',
      title: 'bag',
      parentTableName: 'tbl_Hero',
      source: { filePath: '/proj/Hero.def', line: 9, path: 'bag', category: 'entity' },
      fields: [field('id', 'bigint unsigned'), field('parentID', 'bigint unsigned'), field('sm_value', 'int unsigned')]
    }
  ],
  tableIndex: new Map()
};

/** 替身执行器:按 SQL 形态返回表清单/列清单,并记录收到的语句 */
interface FakeExecutor extends DriftQueryExecutor {
  sqls: string[];
  closed: boolean;
}

const makeExecutor = (
  tables: Array<{ name: string; columns: Array<{ name: string; type: string }> }>
): FakeExecutor => {
  const sqls: string[] = [];
  const executor: FakeExecutor = {
    sqls,
    closed: false,
    runQuery: async (sql: string): Promise<QueryResult> => {
      sqls.push(sql);
      if (/^SHOW TABLES/i.test(sql)) {
        return {
          columns: [{ name: 'Tables_in_game_db', type: '' }],
          rows: tables.map(table => ({ Tables_in_game_db: table.name }))
        };
      }
      const match = /^SHOW FULL COLUMNS FROM `(.+)`$/i.exec(sql);
      const table = match ? tables.find(item => item.name === match[1]) : undefined;
      return {
        columns: [
          { name: 'Field', type: '' },
          { name: 'Type', type: '' }
        ],
        rows: (table?.columns ?? []).map(column => ({ Field: column.name, Type: column.type }))
      };
    },
    close: async (): Promise<void> => {
      executor.closed = true;
    }
  };
  return executor;
};

describe('assertReadOnlyStatement(只读红线)', () => {
  it('accepts the four read-only query forms', () => {
    expect(assertReadOnlyStatement('SELECT * FROM `tbl_Hero`')).toBe('SELECT * FROM `tbl_Hero`');
    expect(assertReadOnlyStatement('show tables')).toBe('show tables');
    expect(assertReadOnlyStatement('DESCRIBE tbl_Hero')).toBe('DESCRIBE tbl_Hero');
    expect(assertReadOnlyStatement('  EXPLAIN SELECT 1;  ')).toBe('EXPLAIN SELECT 1;');
  });

  it('rejects write statements by name', () => {
    expect(() => assertReadOnlyStatement('INSERT INTO tbl_Hero VALUES (1)')).toThrow(
      ReadOnlyViolationError
    );
    expect(() => assertReadOnlyStatement('UPDATE tbl_Hero SET sm_hp = 0')).toThrow(/UPDATE/);
    expect(() => assertReadOnlyStatement('DELETE FROM tbl_Hero')).toThrow(/DELETE/);
    expect(() => assertReadOnlyStatement('DROP TABLE tbl_Hero')).toThrow(/DROP/);
    expect(() => assertReadOnlyStatement('TRUNCATE TABLE tbl_Hero')).toThrow(/TRUNCATE/);
    expect(() => assertReadOnlyStatement('GRANT ALL ON game_db.* TO kbe')).toThrow(/GRANT/);
  });

  it('rejects write keywords hidden inside a query', () => {
    expect(() => assertReadOnlyStatement('SELECT * FROM tbl_Hero FOR UPDATE')).toThrow(/UPDATE/);
    expect(() => assertReadOnlyStatement("SELECT * FROM tbl_Hero INTO OUTFILE '/tmp/x'")).toThrow(
      /INTO/
    );
    expect(() => assertReadOnlyStatement('SHOW CREATE TABLE tbl_Hero')).toThrow(/CREATE/);
  });

  it('rejects multiple statements and blank input', () => {
    expect(() => assertReadOnlyStatement('SELECT 1; DROP TABLE tbl_Hero')).toThrow(/多语句/);
    expect(() => assertReadOnlyStatement('   ')).toThrow(/空语句/);
    expect(() => assertReadOnlyStatement('CALL some_proc()')).toThrow(/CALL/);
  });

  it('does not mistake comments or string literals for write keywords', () => {
    // 关键字判定只看剥掉注释与字面量后的裸语句
    expect(
      assertReadOnlyStatement("SELECT * FROM tbl_Hero WHERE sm_name = 'drop table me'")
    ).toContain('drop table me');
    expect(assertReadOnlyStatement('SELECT /* UPDATE */ 1')).toBe('SELECT /* UPDATE */ 1');
    expect(() => assertReadOnlyStatement('SELECT 1 -- UPDATE')).not.toThrow();
  });

  it('rejects an unrecognized leading keyword with a plain reason', () => {
    expect(() => assertReadOnlyStatement('VACUUM tbl_Hero')).toThrow(/无法识别的语句/);
    // 首字符不是关键字字母时同样按「无法识别」处理,不做空串替换放行
    expect(() => assertReadOnlyStatement('123')).toThrow(/无法识别的语句/);
  });
});

describe('buildMysqlConnectionOptions', () => {
  it('maps the engine config to connection options with its plaintext password', () => {
    expect(buildMysqlConnectionOptions(database)).toEqual({
      host: '127.0.0.1',
      port: 13306,
      user: 'game',
      password: 'kbe',
      database: 'game_db',
      charset: 'utf8mb4'
    });
  });

  it('falls back to the mysql default port and utf8mb4', () => {
    expect(buildMysqlConnectionOptions({ ...database, port: 0, characterSet: '' })).toMatchObject({
      port: MYSQL_DEFAULT_PORT,
      charset: 'utf8mb4'
    });
  });

  it('leaves the password empty when the engine config only holds ciphertext', () => {
    expect(
      buildMysqlConnectionOptions({ ...database, encrypt: true, plainPassword: undefined }).password
    ).toBe('');
  });
});

describe('isColumnTypeCompatible', () => {
  it('ignores integer display width differences but preserves meaningful type parameters', () => {
    expect(isColumnTypeCompatible('int unsigned', 'int unsigned')).toBe(true);
    expect(isColumnTypeCompatible('bigint unsigned', 'bigint(20) unsigned')).toBe(true);
    expect(isColumnTypeCompatible('varchar(64)', 'varchar(64)')).toBe(true);
    expect(isColumnTypeCompatible('VARCHAR(64)', 'varchar(64)')).toBe(true);
    expect(isColumnTypeCompatible('VARCHAR(64)', 'varchar(128)')).toBe(false);
    expect(isColumnTypeCompatible('decimal(10,2)', 'decimal(12,2)')).toBe(false);
  });

  it('catches real type and signedness differences', () => {
    expect(isColumnTypeCompatible('int unsigned', 'int')).toBe(false);
    expect(isColumnTypeCompatible('bigint unsigned', 'bigint')).toBe(false);
    expect(isColumnTypeCompatible('int unsigned', 'varchar(64)')).toBe(false);
  });
});

describe('compareTableColumns', () => {
  it('reports nothing when the real table matches the derived one', () => {
    expect(
      compareTableColumns(snapshot.tables[0], [
        { name: 'id', type: 'bigint(20) unsigned' },
        { name: 'sm_autoLoad', type: 'tinyint' },
        { name: 'sm_hp', type: 'int unsigned' }
      ])
    ).toEqual([]);
  });

  it('reports missing columns, extra columns and type mismatches', () => {
    expect(
      compareTableColumns(snapshot.tables[0], [
        { name: 'id', type: 'bigint unsigned' },
        { name: 'sm_autoLoad', type: 'tinyint' },
        { name: 'sm_hp', type: 'int' },
        { name: 'sm_gone', type: 'varchar(32)' }
      ])
    ).toEqual([
      {
        kind: 'type-mismatch',
        tableName: 'tbl_Hero',
        columnName: 'sm_hp',
        message: '型别不符 sm_hp:def 推导 int unsigned,真实 int'
      },
      {
        kind: 'extra-column',
        tableName: 'tbl_Hero',
        columnName: 'sm_gone',
        message: '多余列 sm_gone(真实 varchar(32),def 无此属性)'
      }
    ]);
  });

  it('reports a column the real table dropped', () => {
    expect(
      compareTableColumns(snapshot.tables[0], [
        { name: 'id', type: 'bigint unsigned' },
        { name: 'sm_autoLoad', type: 'tinyint' }
      ])
    ).toEqual([
      {
        kind: 'missing-column',
        tableName: 'tbl_Hero',
        columnName: 'sm_hp',
        message: '缺列 sm_hp(def 推导 int unsigned)'
      }
    ]);
  });

  it('detects nullable, default and index differences from full MySQL metadata', () => {
    const findings = compareTableColumns(snapshot.tables[0], [
      { name: 'id', type: 'bigint unsigned', nullable: false, defaultValue: null, key: 'PRI' },
      { name: 'sm_autoLoad', type: 'tinyint', nullable: false, defaultValue: '0', key: 'MUL' },
      { name: 'sm_hp', type: 'int unsigned', nullable: true, defaultValue: '9', key: 'UNI' }
    ]);
    expect(findings.map(finding => finding.kind)).toEqual([
      'nullability-mismatch', 'default-mismatch', 'index-mismatch'
    ]);
    expect(findings.map(finding => finding.columnName)).toEqual(['sm_hp', 'sm_hp', 'sm_hp']);
  });

  it('skips rows whose field name or type is not text', async () => {
    const executor = makeExecutor([
      {
        name: 'tbl_Hero',
        columns: [
          { name: 'id', type: 'bigint unsigned' },
          { name: 'sm_autoLoad', type: 'tinyint' },
          { name: 'sm_hp', type: 'int unsigned' }
        ]
      }
    ]);
    // SHOW FULL COLUMNS 的行里混入非文本项:Field 非文本的行不当列跳过;
    // Type 非文本的行保留列名,型别留空(比对时如实判为不符)
    const wrapped: DriftQueryExecutor = {
      runQuery: async (sql: string): Promise<QueryResult> => {
        const base = await executor.runQuery(sql);
        if (/^SHOW FULL COLUMNS/i.test(sql)) {
          return {
            columns: base.columns,
            rows: [...base.rows, { Field: 9, Type: 253 }, { Field: 'sm_hp', Type: 253 }]
          };
        }
        return base;
      },
      close: executor.close
    };

    expect(await buildDriftReport(snapshot, wrapped, 'tbl_')).toEqual([
      {
        kind: 'type-mismatch',
        tableName: 'tbl_Hero',
        columnName: 'sm_hp',
        message: '型别不符 sm_hp:def 推导 int unsigned,真实 '
      },
      {
        kind: 'missing-table',
        tableName: 'tbl_Hero_bag',
        message: '表中不存在 tbl_Hero_bag(该实体或属性尚未建表)'
      }
    ]);
  });

  it('falls back to the raw column list when the field/type keys are absent', async () => {
    const executor: DriftQueryExecutor = {
      runQuery: async (sql: string): Promise<QueryResult> => {
        if (/^SHOW TABLES/i.test(sql)) {
          return {
            columns: [{ name: 'Tables_in_game_db', type: '' }],
            rows: [{ Tables_in_game_db: 'tbl_Hero' }]
          };
        }
        // 没有 Field/Type 列名(如只回了 information_schema 精简视图):
        // 直接拿列元数据当列清单,判读继续走同一条对比口径
        return { columns: [{ name: 'sm_hp', type: 'int' }], rows: [] };
      },
      close: async (): Promise<void> => undefined
    };

    expect(await buildDriftReport(snapshot, executor, 'tbl_')).toEqual([
      {
        kind: 'missing-column',
        tableName: 'tbl_Hero',
        columnName: 'id',
        message: '缺列 id(def 推导 bigint unsigned)'
      },
      {
        kind: 'missing-column',
        tableName: 'tbl_Hero',
        columnName: 'sm_autoLoad',
        message: '缺列 sm_autoLoad(def 推导 tinyint)'
      },
      {
        kind: 'type-mismatch',
        tableName: 'tbl_Hero',
        columnName: 'sm_hp',
        message: '型别不符 sm_hp:def 推导 int unsigned,真实 int'
      },
      {
        kind: 'missing-table',
        tableName: 'tbl_Hero_bag',
        message: '表中不存在 tbl_Hero_bag(该实体或属性尚未建表)'
      }
    ]);
  });
});

describe('buildDriftReport', () => {
  it('reads Null, Default, and Key from SHOW FULL COLUMNS rows', async () => {
    const executor: DriftQueryExecutor = {
      runQuery: async (sql: string): Promise<QueryResult> => {
        if (/^SHOW TABLES/i.test(sql)) {
          return { columns: [{ name: 'Tables_in_game_db', type: '' }], rows: [{ Tables_in_game_db: 'tbl_Hero' }] };
        }
        return {
          columns: ['Field', 'Type', 'Null', 'Key', 'Default'].map(name => ({ name, type: '' })),
          rows: [
            { Field: 'id', Type: 'bigint(20) unsigned', Null: 'NO', Key: 'PRI', Default: null },
            { Field: 'sm_autoLoad', Type: 'tinyint', Null: 'NO', Key: 'MUL', Default: '0' },
            { Field: 'sm_hp', Type: 'int unsigned', Null: 'NO', Key: '', Default: '0' }
          ]
        };
      },
      close: async (): Promise<void> => undefined
    };
    expect(await buildDriftReport({ ...snapshot, tables: [snapshot.tables[0]] }, executor, 'tbl_')).toEqual([]);
  });

  it('finds missing tables, residual tables and column drift in one pass', async () => {
    const executor = makeExecutor([
      {
        name: 'tbl_Hero',
        columns: [
          { name: 'id', type: 'bigint unsigned' },
          { name: 'sm_autoLoad', type: 'tinyint' },
          { name: 'sm_hp', type: 'int' }
        ]
      },
      { name: 'tbl_Hero_old', columns: [{ name: 'id', type: 'bigint unsigned' }] },
      { name: 'tbl_NPC', columns: [{ name: 'id', type: 'bigint unsigned' }] },
      { name: 'unrelated_log', columns: [{ name: 'id', type: 'bigint unsigned' }] }
    ]);

    const findings = await buildDriftReport(snapshot, executor, 'tbl_');

    expect(executor.sqls).toEqual([
      'SHOW TABLES',
      'SHOW FULL COLUMNS FROM `tbl_Hero`'
    ]);
    expect(findings).toEqual([
      {
        kind: 'type-mismatch',
        tableName: 'tbl_Hero',
        columnName: 'sm_hp',
        message: '型别不符 sm_hp:def 推导 int unsigned,真实 int'
      },
      {
        kind: 'missing-table',
        tableName: 'tbl_Hero_bag',
        message: '表中不存在 tbl_Hero_bag(该实体或属性尚未建表)'
      },
      {
        kind: 'residual-table',
        tableName: 'tbl_Hero_old',
        message: '残留表 tbl_Hero_old(库里存在,def 已无对应属性)'
      }
    ]);
    // 无前缀的表不是本扩展的判定范围(日志库/系统表),不报残留
    expect(findings.some(finding => finding.tableName === 'unrelated_log')).toBe(false);
  });

  it('reads the table list through the first column name even without field metadata', async () => {
    const executor: DriftQueryExecutor = {
      runQuery: async (sql: string): Promise<QueryResult> => {
        if (/^SHOW FULL COLUMNS/i.test(sql)) {
          return { columns: [], rows: [] };
        }
        // 列元数据缺失时按 MySQL 约定表名兜底;非字符串行不当表名
        return { columns: [], rows: [{ Tables_in_db: 'tbl_Hero' }, { Tables_in_db: 7 }] };
      },
      close: async (): Promise<void> => undefined
    };

    expect(await buildDriftReport(snapshot, executor, 'tbl_')).toEqual([
      {
        kind: 'missing-column',
        tableName: 'tbl_Hero',
        columnName: 'id',
        message: '缺列 id(def 推导 bigint unsigned)'
      },
      {
        kind: 'missing-column',
        tableName: 'tbl_Hero',
        columnName: 'sm_autoLoad',
        message: '缺列 sm_autoLoad(def 推导 tinyint)'
      },
      {
        kind: 'missing-column',
        tableName: 'tbl_Hero',
        columnName: 'sm_hp',
        message: '缺列 sm_hp(def 推导 int unsigned)'
      },
      {
        kind: 'missing-table',
        tableName: 'tbl_Hero_bag',
        message: '表中不存在 tbl_Hero_bag(该实体或属性尚未建表)'
      }
    ]);
  });
});

describe('buildDriftReportForSnapshots', () => {
  it('checks all entity tables in one pass and treats their union as expected', async () => {
    const second = { ...snapshot, entityName: 'NPC', tables: [{
      ...snapshot.tables[0], name: 'tbl_NPC', title: 'NPC'
    }] };
    const executor = makeExecutor([
      { name: 'tbl_Hero', columns: [] },
      { name: 'tbl_NPC', columns: [] },
      { name: 'tbl_Old', columns: [] }
    ]);
    const findings = await buildDriftReportForSnapshots([snapshot, second], executor, 'tbl_');
    expect(executor.sqls[0]).toBe('SHOW TABLES');
    expect(findings.some(finding => finding.kind === 'residual-table' && finding.tableName === 'tbl_Old')).toBe(true);
    expect(findings.some(finding => finding.kind === 'residual-table' && finding.tableName === 'tbl_NPC')).toBe(false);
    expect(findings.some(finding => finding.kind === 'missing-table' && finding.tableName === 'tbl_NPC')).toBe(false);
  });
});

describe('renderDriftReport', () => {
  it('lists every finding with its kind and counts them', () => {
    const text = renderDriftReport({
      entityName: 'Hero',
      databaseName: 'game_db',
      checked: true,
      findings: [
        {
          kind: 'missing-table',
          tableName: 'tbl_Hero_bag',
          message: '表中不存在 tbl_Hero_bag(该实体或属性尚未建表)'
        },
        {
          kind: 'residual-table',
          tableName: 'tbl_Hero_old',
          message: '残留表 tbl_Hero_old(库里存在,def 已无对应属性)'
        }
      ]
    });

    expect(text).toBe(
      [
        '# KBEngine 数据库漂移: Hero',
        '',
        'Database: game_db',
        '',
        '[缺表] 表中不存在 tbl_Hero_bag(该实体或属性尚未建表)',
        '[残留表] 残留表 tbl_Hero_old(库里存在,def 已无对应属性)',
        '',
        '问题 2 项',
        ''
      ].join('\n')
    );
  });

  it('reports a clean run', () => {
    const text = renderDriftReport({
      entityName: 'Hero',
      databaseName: 'game_db',
      checked: true,
      findings: []
    });

    expect(text).toContain('问题 0 项:真实表结构与 def 推导的虚拟表结构一致');
  });

  it('says plainly that nothing was verified when degraded', () => {
    const text = renderDriftReport({
      entityName: 'Hero',
      databaseName: 'game_db',
      checked: false,
      findings: [],
      reason: '连不上数据库(ECONNREFUSED)'
    });

    expect(text).toContain('未校验:连不上数据库(ECONNREFUSED)');
    expect(text).not.toContain('问题 0 项');
  });

  it('falls back to a generic reason when the degradation gave none', () => {
    expect(
      renderDriftReport({
        entityName: 'Hero',
        databaseName: 'game_db',
        checked: false,
        findings: []
      })
    ).toContain('未校验:未知原因');
  });
});

describe('describeDriftSummary', () => {
  it('summarizes the three outcomes', () => {
    expect(
      describeDriftSummary({
        entityName: 'Hero',
        databaseName: 'game_db',
        checked: false,
        findings: [],
        reason: '读不到密码'
      })
    ).toBe('数据库漂移未校验:Hero(读不到密码)');
    expect(
      describeDriftSummary({
        entityName: 'Hero',
        databaseName: 'game_db',
        checked: true,
        findings: []
      })
    ).toBe('数据库漂移校验通过:Hero(真实表结构与 def 一致)');
    expect(
      describeDriftSummary({
        entityName: 'Hero',
        databaseName: 'game_db',
        checked: true,
        findings: [{ kind: 'missing-table', tableName: 'tbl_Hero', message: 'x' }]
      })
    ).toBe('数据库漂移发现 1 项:Hero,详见「KBEngine 数据库漂移」输出面板');
  });

  it('falls back to a generic reason when none was given', () => {
    expect(
      describeDriftSummary({
        entityName: 'Hero',
        databaseName: 'game_db',
        checked: false,
        findings: []
      })
    ).toContain('未知原因');
  });
});

describe('checkDatabaseDrift', () => {
  it('closes the connection and returns findings for a reachable database', async () => {
    const executor = makeExecutor([
      {
        name: 'tbl_Hero',
        columns: [
          { name: 'id', type: 'bigint unsigned' },
          { name: 'sm_autoLoad', type: 'tinyint' },
          { name: 'sm_hp', type: 'int unsigned' }
        ]
      },
      {
        name: 'tbl_Hero_bag',
        columns: [
          { name: 'id', type: 'bigint unsigned' },
          { name: 'parentID', type: 'bigint unsigned' },
          { name: 'sm_value', type: 'int unsigned' }
        ]
      }
    ]);

    const report = await checkDatabaseDrift(snapshot, database, 'tbl_', async () => executor);

    expect(report.checked).toBe(true);
    expect(report.findings).toEqual([]);
    expect(report.entityName).toBe('Hero');
    expect(executor.closed).toBe(true);
  });

  it('degrades to not-verified when the connection fails', async () => {
    const report = await checkDatabaseDrift(snapshot, database, 'tbl_', async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:13306');
    });

    expect(report.checked).toBe(false);
    expect(report.findings).toEqual([]);
    expect(report.reason).toBe('连不上数据库(connect ECONNREFUSED 127.0.0.1:13306)');
    expect(describeDriftSummary(report)).toContain('未校验');
  });

  it('degrades to not-verified when reading the table list fails', async () => {
    const executor: DriftQueryExecutor = {
      runQuery: async (): Promise<QueryResult> => {
        throw 'permission denied';
      },
      close: async (): Promise<void> => undefined
    };

    const report = await checkDatabaseDrift(snapshot, database, 'tbl_', async () => executor);

    expect(report.checked).toBe(false);
    expect(report.reason).toBe('读取表结构失败(permission denied)');
  });
});
describe('createMysqlDriftExecutorWith(mysql2 装配)', () => {
  interface FakeConnectionLog {
    options: unknown[];
    sqls: string[];
    ended: boolean;
  }

  const makeMysql = (
    log: FakeConnectionLog,
    reply: (sql: string) => [unknown, unknown] = () => [[], []]
  ): { mysql: MysqlModuleLike } => ({
    mysql: {
      createConnection: async options => {
        log.options.push(options);
        return {
          query: async (sql: string): Promise<[unknown, unknown]> => {
            log.sqls.push(sql);
            return reply(sql);
          },
          end: async (): Promise<void> => {
            log.ended = true;
          }
        };
      }
    }
  });

  it('opens a read-only session before the first query and passes results through', async () => {
    const log: FakeConnectionLog = { options: [], sqls: [], ended: false };
    const { mysql } = makeMysql(
      log,
      sql =>
        sql === 'SHOW TABLES'
          ? [[{ Tables_in_game_db: 'tbl_Hero' }], [{ name: 'Tables_in_game_db', type: 253 }]]
          : [
              [
                { Field: 'id', Type: 'bigint(20) unsigned' },
                { Field: 'sm_autoLoad', Type: 'tinyint' },
                { Field: 'sm_hp', Type: 'int unsigned' }
              ],
              [
                { name: 'Field', type: 253 },
                { name: 'Type', type: 253 }
              ]
            ]
    );
    const factory = createMysqlDriftExecutorWith(async () => mysql);

    const report = await checkDatabaseDrift(snapshot, database, 'tbl_', factory);

    // 只读会话在建连后、任何业务查询之前就发出
    expect(log.sqls[0]).toBe('SET SESSION TRANSACTION READ ONLY');
    expect(log.options[0]).toMatchObject({ host: '127.0.0.1', port: 13306, user: 'game' });
    expect(report.findings).toEqual([
      {
        kind: 'missing-table',
        tableName: 'tbl_Hero_bag',
        message: '表中不存在 tbl_Hero_bag(该实体或属性尚未建表)'
      }
    ]);
    expect(log.ended).toBe(true);
  });

  it('refuses a write statement before it reaches the server', async () => {
    const log: FakeConnectionLog = { options: [], sqls: [], ended: false };
    const { mysql } = makeMysql(log);
    const factory = createMysqlDriftExecutorWith(async () => mysql);
    const executor = await factory(database);

    await expect(executor.runQuery('DELETE FROM tbl_Hero')).rejects.toThrow(ReadOnlyViolationError);
    // 白名单拦在连接之前:除只读会话外没有任何语句发出去
    expect(log.sqls).toEqual(['SET SESSION TRANSACTION READ ONLY']);

    await executor.close();
    expect(log.ended).toBe(true);
  });

  it('treats a non-array result set as an empty table', async () => {
    const log: FakeConnectionLog = { options: [], sqls: [], ended: false };
    const { mysql } = makeMysql(log, () => [{ affectedRows: 0 }, undefined]);
    const factory = createMysqlDriftExecutorWith(async () => mysql);
    const executor = await factory(database);

    expect(await executor.runQuery('SHOW TABLES')).toEqual({ columns: [], rows: [] });

    await executor.close();
  });

  it('keeps string column metadata and drops non-string entries', async () => {
    const log: FakeConnectionLog = { options: [], sqls: [], ended: false };
    const { mysql } = makeMysql(log, () => [
      [{ sm_hp: 1 }],
      [
        { name: 'sm_hp', type: 'int unsigned' },
        { name: 'sm_bad', type: 253 },
        { type: 'int' }
      ]
    ]);
    const factory = createMysqlDriftExecutorWith(async () => mysql);
    const executor = await factory(database);

    expect(await executor.runQuery('SELECT * FROM tbl_Hero')).toEqual({
      columns: [
        { name: 'sm_hp', type: 'int unsigned' },
        { name: 'sm_bad', type: '' },
        { name: '', type: 'int' }
      ],
      rows: [{ sm_hp: 1 }]
    });

    await executor.close();
  });
});

describe('生产默认连接(mysql2 真模块)', () => {
  it('degrades to not-verified when nothing listens on the port', async () => {
    // 占一个端口再放开:拿到一个确定没人监听的端口,真跑一次 mysql2 装配
    const probe = createServer();
    const freePort = await new Promise<number>(resolve => {
      probe.listen(0, '127.0.0.1', () => {
        const address = probe.address() as AddressInfo;
        probe.close(() => resolve(address.port));
      });
    });

    const report = await checkDatabaseDrift(
      snapshot,
      { ...database, port: freePort },
      'tbl_',
      createMysqlDriftExecutor
    );

    expect(report.checked).toBe(false);
    expect(report.findings).toEqual([]);
    expect(report.reason).toContain('连不上数据库');
  });
});

describe('publishDriftReport', () => {
  const makeChannel = (): { channel: DriftChannelLike; calls: string[] } => {
    const calls: string[] = [];
    return {
      calls,
      channel: {
        clear: (): void => void calls.push('clear'),
        appendLine: (line: string): void => void calls.push(`append:${line.split('\n')[0]}`),
        show: (): void => void calls.push('show')
      }
    };
  };

  it('warns and writes the report when drift is found', () => {
    const { channel, calls } = makeChannel();
    const warnings: string[] = [];
    const infos: string[] = [];

    publishDriftReport(
      channel,
      {
        showInformationMessage: message => infos.push(message),
        showWarningMessage: message => warnings.push(message)
      },
      {
        entityName: 'Hero',
        databaseName: 'game_db',
        checked: true,
        findings: [{ kind: 'missing-table', tableName: 'tbl_Hero', message: '缺表' }]
      }
    );

    expect(calls).toEqual(['clear', 'append:# KBEngine 数据库漂移: Hero', 'show']);
    expect(warnings).toEqual(['数据库漂移发现 1 项:Hero,详见「KBEngine 数据库漂移」输出面板']);
    expect(infos).toEqual([]);
  });

  it('informs when the check is clean or could not run', () => {
    const { channel } = makeChannel();
    const infos: string[] = [];
    const notifier = {
      showInformationMessage: (message: string) => infos.push(message),
      showWarningMessage: (): void => undefined
    };

    publishDriftReport(channel, notifier, {
      entityName: 'Hero',
      databaseName: 'game_db',
      checked: true,
      findings: []
    });
    publishDriftReport(channel, notifier, {
      entityName: 'Hero',
      databaseName: 'game_db',
      checked: false,
      findings: [],
      reason: '连不上数据库'
    });

    expect(infos).toEqual([
      '数据库漂移校验通过:Hero(真实表结构与 def 一致)',
      '数据库漂移未校验:Hero(连不上数据库)'
    ]);
  });
});
