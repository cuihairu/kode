import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  KBENGINE_DATABASE_SIMULATION_SCHEME,
  SIMULATION_DIFFERENCES,
  applyRowOperation,
  buildDatabaseSimulationText,
  buildPropertyDatabaseStorageHover,
  createDatabaseSimulationUri,
  defaultRowValue,
  describeColumnValueConstraint,
  getSimulationEntityName,
  isDatabaseSimulationDocument,
  renderColumnDdlBody,
  renderInsertStatements,
  renderMysqlDdl,
  renderRowsJson,
  renderSimulationDocument,
  resolveColumnValueType,
  simulateInitialRows,
  validateRowValue,
  KBEngineDatabaseSimulationProvider
} from '../src/databaseSimulator';
import type { SimulatedRowStore } from '../src/databaseSimulator';
import { getDatabaseSchemaSnapshot as snapshotOf } from '../src/databaseSchema';
import type {
  DatabaseSchemaSnapshot,
  DefSourceRef,
  TableFieldDescriptor,
  TableSchemaDescriptor
} from '../src/databaseSchema';
import { Uri, workspace as stubWorkspace } from './helpers/vscodeStub';

// 数据库行模拟(批122)的纯逻辑段:列型别推断/默认值/行值校验、
// 初始行模拟、增改删预览与七类约束提示、DDL/JSON/INSERT 三种渲染、
// 虚拟文档 Uri 往返、临时真实 def 树上的端到端,以及 provider 的
// 工作区解析与空态。严格引擎语义:任一 issue 即语句被拒,store
// 保持操作前状态(见 applyRowOperation 注)。

const source = (over: Partial<DefSourceRef> = {}): DefSourceRef => ({
  filePath: '/proj/Hero.def',
  line: 3,
  path: 'hp',
  category: 'entity',
  ...over
});

function field(name: string, overrides: Partial<TableFieldDescriptor> = {}): TableFieldDescriptor {
  return {
    name,
    typeLabel: 'int unsigned',
    sourcePath: 'scripts/Hero.def',
    source: source(),
    identifier: false,
    ...overrides
  };
}

function makeTable(table: Partial<TableSchemaDescriptor> & { name: string; fields: TableFieldDescriptor[] }): TableSchemaDescriptor {
  return {
    kind: 'entity',
    title: table.name,
    source: source({ path: '' }),
    ...table
  };
}

function makeSnapshot(tables: TableSchemaDescriptor[]): DatabaseSchemaSnapshot {
  return {
    backend: 'mysql',
    entityName: 'Hero',
    tables,
    tableIndex: new Map(tables.map(table => [table.name, table]))
  };
}

/** 根表 + ARRAY 子表 + 组件子表 + 嵌套 ARRAY 的最小快照,覆盖各渲染/校验面 */
function heroSnapshot(): DatabaseSchemaSnapshot {
  const root = makeTable({
    name: 'tbl_Hero',
    kind: 'entity',
    title: 'Hero',
    fields: [
      field('id', { typeLabel: 'bigint unsigned', indexType: 'PRIMARY' }),
      field('sm_autoLoad', { typeLabel: 'tinyint', indexType: 'INDEX' }),
      field('sm_hp', { typeLabel: 'int unsigned', defaultValue: '10' }),
      field('sm_coins', { typeLabel: 'bigint unsigned', databaseLength: 32 }),
      field('sm_name', { typeLabel: 'varchar', databaseLength: 64, defaultValue: "ab'", indexType: 'UNIQUE' }),
      field('sm_title', { typeLabel: 'varchar' }),
      field('sm_target', { typeLabel: 'blob' }),
      field('sm_speed', { typeLabel: 'float', defaultValue: '1.5' }),
      field('sm_vec_x', { typeLabel: 'vector3' }),
      field('sm_tag', { typeLabel: 'int', indexType: 'INDEX', databaseLength: 5 })
    ]
  });

  const bag = makeTable({
    name: 'tbl_Hero_bag',
    kind: 'array',
    title: 'bag',
    parentTableName: 'tbl_Hero',
    fields: [
      field('id', { typeLabel: 'bigint unsigned', indexType: 'PRIMARY' }),
      field('parentID', { typeLabel: 'bigint unsigned', indexType: 'INDEX' }),
      field('sm_autoLoad', { typeLabel: 'tinyint', indexType: 'INDEX' }),
      field('sm_value', { typeLabel: 'int unsigned' })
    ]
  });

  const stats = makeTable({
    name: 'tbl_Hero_stats',
    kind: 'component',
    title: 'stats',
    parentTableName: 'tbl_Hero',
    fields: [
      field('id', { typeLabel: 'bigint unsigned', indexType: 'PRIMARY' }),
      field('parentID', { typeLabel: 'bigint unsigned', indexType: 'INDEX' }),
      field('sm_autoLoad', { typeLabel: 'tinyint', indexType: 'INDEX' }),
      field('sm_power', { typeLabel: 'int unsigned' })
    ]
  });

  const deep = makeTable({
    name: 'tbl_Hero_bag_2',
    kind: 'array',
    title: 'bag_2',
    parentTableName: 'tbl_Hero_bag',
    fields: [
      field('id', { typeLabel: 'bigint unsigned', indexType: 'PRIMARY' }),
      field('parentID', { typeLabel: 'bigint unsigned', indexType: 'INDEX' }),
      field('sm_autoLoad', { typeLabel: 'tinyint', indexType: 'INDEX' }),
      field('sm_value', { typeLabel: 'int unsigned' })
    ]
  });

  return makeSnapshot([root, bag, stats, deep]);
}

describe('resolveColumnValueType and defaultRowValue', () => {
  it('maps engine column labels to the simulation value kinds', () => {
    expect(resolveColumnValueType(field('a', { typeLabel: 'tinyint' }))).toEqual({ kind: 'integer' });
    expect(resolveColumnValueType(field('a', { typeLabel: 'int unsigned' }))).toEqual({ kind: 'unsigned' });
    expect(resolveColumnValueType(field('a', { typeLabel: 'bigint' }))).toEqual({ kind: 'integer' });
    expect(resolveColumnValueType(field('a', { typeLabel: 'float' }))).toEqual({ kind: 'float' });
    expect(resolveColumnValueType(field('a', { typeLabel: 'double' }))).toEqual({ kind: 'float' });
    expect(resolveColumnValueType(field('a', { typeLabel: 'vector3' }))).toEqual({ kind: 'float' });
    expect(resolveColumnValueType(field('a', { typeLabel: 'varchar', databaseLength: 64 }))).toEqual({
      kind: 'string',
      length: 64
    });
    // 未声明 DatabaseLength 的 varchar 按引擎缺省 255
    expect(resolveColumnValueType(field('a', { typeLabel: 'varchar' }))).toEqual({ kind: 'string', length: 255 });
    expect(resolveColumnValueType(field('a', { typeLabel: 'blob' }))).toEqual({ kind: 'blob' });
  });

  it('reads column defaults from the def Default node per kind', () => {
    expect(defaultRowValue(field('hp', { typeLabel: 'int unsigned', defaultValue: '10' }))).toBe(10);
    expect(defaultRowValue(field('hp', { typeLabel: 'int unsigned' }))).toBe(0);
    expect(defaultRowValue(field('hp', { typeLabel: 'float', defaultValue: '1.5' }))).toBe(1.5);
    expect(defaultRowValue(field('hp', { typeLabel: 'float' }))).toBe(0);
    // 数字列默认值解析不动时落 0(引擎会让 MySQL 建列报错,模拟不编造)
    expect(defaultRowValue(field('hp', { typeLabel: 'int', defaultValue: 'nope' }))).toBe(0);
    expect(defaultRowValue(field('n', { typeLabel: 'varchar', defaultValue: "ab'" }))).toBe("ab'");
    expect(defaultRowValue(field('n', { typeLabel: 'varchar' }))).toBe('');
    expect(defaultRowValue(field('b', { typeLabel: 'blob', defaultValue: 'raw' }))).toBe('raw');
  });
});

describe('validateRowValue', () => {
  it('accepts in-range integers by mysql type width', () => {
    expect(validateRowValue(field('a', { typeLabel: 'tinyint' }), 127)).toBeNull();
    expect(validateRowValue(field('a', { typeLabel: 'tinyint' }), -128)).toBeNull();
    expect(validateRowValue(field('a', { typeLabel: 'int' }), 2147483647)).toBeNull();
    expect(validateRowValue(field('a', { typeLabel: 'bigint' }), -9223372036854775808)).toBeNull();
    expect(validateRowValue(field('a', { typeLabel: 'int unsigned' }), 0)).toBeNull();
    expect(validateRowValue(field('a', { typeLabel: 'tinyint unsigned' }), 255)).toBeNull();
    expect(validateRowValue(field('a', { typeLabel: 'smallint unsigned' }), 65535)).toBeNull();
    expect(validateRowValue(field('a', { typeLabel: 'int unsigned' }), 4294967295)).toBeNull();
    // 2^64 以下最大可精确表示的 double(bigint unsigned 上限 2^64-1 不可精确
    // 表示,BigInt 比较仍按 double 真值判定)
    expect(validateRowValue(field('a', { typeLabel: 'bigint unsigned' }), 18446744073709549568)).toBeNull();
    expect(validateRowValue(field('a', { typeLabel: 'double' }), 1.5)).toBeNull();
    expect(validateRowValue(field('a', { typeLabel: 'vector3' }), 0)).toBeNull();
    expect(validateRowValue(field('a', { typeLabel: 'varchar', databaseLength: 3 }), 'abc')).toBeNull();
    expect(validateRowValue(field('a', { typeLabel: 'blob' }), 'any bytes')).toBeNull();
  });

  it('rejects wrong kinds with the column type in the message', () => {
    expect(validateRowValue(field('a', { typeLabel: 'int unsigned' }), 'x')).toContain('列 a 需整数(int unsigned)');
    expect(validateRowValue(field('a', { typeLabel: 'int unsigned' }), 1.5)).toContain('列 a 需整数(int unsigned)');
    expect(validateRowValue(field('a', { typeLabel: 'float' }), 'x')).toContain('列 a 需有限数值(float)');
    expect(validateRowValue(field('a', { typeLabel: 'float' }), Number.NaN)).toContain('列 a 需有限数值(float)');
    expect(validateRowValue(field('a', { typeLabel: 'varchar' }), 3)).toContain('列 a 需字符串(varchar)');
    expect(validateRowValue(field('a', { typeLabel: 'blob' }), 3)).toContain('列 a 需字符串(blob)');
  });

  it('rejects out-of-range values with the type interval', () => {
    expect(validateRowValue(field('a', { typeLabel: 'tinyint' }), 128)).toContain('超出 tinyint 区间 -128..127');
    expect(validateRowValue(field('a', { typeLabel: 'tinyint' }), -129)).toContain('超出 tinyint 区间 -128..127');
    expect(validateRowValue(field('a', { typeLabel: 'int' }), 2147483648)).toContain('超出 int 区间');
    expect(validateRowValue(field('a', { typeLabel: 'bigint' }), 9223372036854775808)).toContain('超出 bigint 区间');
    expect(validateRowValue(field('a', { typeLabel: 'int unsigned' }), -1)).toContain('超出 int unsigned 区间 0..4294967295');
    expect(validateRowValue(field('a', { typeLabel: 'tinyint unsigned' }), 256)).toContain('超出 tinyint unsigned 区间 0..255');
    expect(validateRowValue(field('a', { typeLabel: 'bigint unsigned' }), 18446744073709551616)).toContain(
      '超出 bigint unsigned 区间 0..18446744073709551615'
    );
  });

  it('rejects strings longer than the varchar width', () => {
    expect(validateRowValue(field('a', { typeLabel: 'varchar', databaseLength: 2 }), 'abc')).toContain(
      '列 a 超长(varchar(2) 收到 3 字符)'
    );
    expect(validateRowValue(field('a', { typeLabel: 'varchar' }), 'x'.repeat(256))).toContain('超长(varchar(255)');
  });
});

describe('simulateInitialRows', () => {
  it('builds one root row plus per-child-table rows with parentID from the parent first row', () => {
    const snapshot = heroSnapshot();
    const store = simulateInitialRows(snapshot);

    const root = store.get('tbl_Hero');
    expect(root).toHaveLength(1);
    expect(root![0]).toEqual({
      id: 1,
      values: {
        sm_autoLoad: 0,
        sm_hp: 10,
        sm_coins: 0,
        sm_name: "ab'",
        sm_title: '',
        sm_target: '',
        sm_speed: 1.5,
        sm_vec_x: 0,
        sm_tag: 0
      }
    });

    const bag = store.get('tbl_Hero_bag');
    expect(bag).toHaveLength(2);
    expect(bag!.map(row => row.id)).toEqual([2, 3]);
    expect(bag!.every(row => row.values.parentID === 1)).toBe(true);

    expect(store.get('tbl_Hero_stats')![0].id).toBe(4);
    // 嵌套 ARRAY 的父行取父表首行,行 id 仍全局递增
    expect(store.get('tbl_Hero_bag_2')!.map(row => row.id)).toEqual([5, 6]);
    expect(store.get('tbl_Hero_bag_2')!.every(row => row.values.parentID === 2)).toBe(true);
  });

  it('honors startId / rowsPerChildTable / autoLoad options', () => {
    const snapshot = heroSnapshot();
    const store = simulateInitialRows(snapshot, { startId: 10, rowsPerChildTable: 0, autoLoad: 1 });

    expect(store.get('tbl_Hero')![0]).toMatchObject({ id: 10, values: { sm_autoLoad: 1 } });
    expect(store.get('tbl_Hero_bag')).toHaveLength(0);
    expect(store.get('tbl_Hero_bag_2')).toHaveLength(0);
    // ARRAY 0 行时组件子表仍产 1 行(组件实体创建即建表)
    expect(store.get('tbl_Hero_stats')).toHaveLength(1);
  });
});

describe('applyRowOperation insert', () => {
  const snapshot = heroSnapshot();

  it('appends a defaults row with the next auto id and keeps the input store intact', () => {
    const store = simulateInitialRows(snapshot);
    // 干净默认插入选无 UNIQUE 列的组件子表(根表 UNIQUE 列默认值同值必然冲突)
    const result = applyRowOperation(snapshot, store, { kind: 'insert', table: 'tbl_Hero_stats' });

    expect(result.ok).toBe(true);
    expect(result.issues).toHaveLength(0);
    expect(result.store.get('tbl_Hero_stats')).toHaveLength(2);
    expect(result.store.get('tbl_Hero_stats')![1].id).toBe(5);
    expect(store.get('tbl_Hero_stats')).toHaveLength(1);
  });

  it('rejects unknown columns without applying any override (strict engine semantics)', () => {
    const store = simulateInitialRows(snapshot);
    const result = applyRowOperation(snapshot, store, {
      kind: 'insert',
      table: 'tbl_Hero',
      values: { sm_hp: 7, missing: 1 }
    });

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([
      { kind: 'missing-column', table: 'tbl_Hero', column: 'missing', message: '列 missing 不在表 tbl_Hero 中(缺列)' }
    ]);
    expect(result.store.get('tbl_Hero')).toHaveLength(1);
  });

  it('flags duplicate primary keys and does not append that row', () => {
    const store = simulateInitialRows(snapshot);
    const result = applyRowOperation(snapshot, store, { kind: 'insert', table: 'tbl_Hero', id: 1 });

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([
      { kind: 'duplicate-id', table: 'tbl_Hero', row: 1, message: 'id=1 已存在(主键重复,引擎由 PRIMARY KEY 拒绝)' }
    ]);
    expect(result.store.get('tbl_Hero')).toHaveLength(1);
  });

  it('flags id in the values map because the engine INSERT omits the auto id column', () => {
    const store = simulateInitialRows(snapshot);
    const result = applyRowOperation(snapshot, store, { kind: 'insert', table: 'tbl_Hero', values: { id: 1 } });

    expect(result.ok).toBe(false);
    expect(result.issues[0]).toMatchObject({ kind: 'missing-column', column: 'id' });
    expect(result.issues[0].message).toContain('自增分配');
  });

  it('flags type mismatches and direct parentID writes', () => {
    const store = simulateInitialRows(snapshot);
    const result = applyRowOperation(snapshot, store, {
      kind: 'insert',
      table: 'tbl_Hero_bag',
      values: { sm_value: 'x', parentID: 9 }
    });

    expect(result.ok).toBe(false);
    expect(result.issues.map(issue => issue.kind)).toEqual(['type', 'orphan-parent']);
    expect(result.issues[0].message).toContain('列 sm_value 需整数(int unsigned)');
    expect(result.issues[1].message).toContain('parentID 由模拟分配');
    expect(result.store.get('tbl_Hero_bag')).toHaveLength(2);
  });

  it('flags UNIQUE index conflicts without appending the row', () => {
    const store = simulateInitialRows(snapshot);
    const result = applyRowOperation(snapshot, store, { kind: 'insert', table: 'tbl_Hero', values: { sm_name: "ab'" } });

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([
      {
        kind: 'unique',
        table: 'tbl_Hero',
        column: 'sm_name',
        row: 2,
        message: "UNIQUE 索引 sm_name 值 'ab'' 与已有行冲突"
      }
    ]);
    expect(result.store.get('tbl_Hero')).toHaveLength(1);
  });

  it('defaults parentID to 0 only when the parent table has no simulated row', () => {
    const store = simulateInitialRows(snapshot, { rowsPerChildTable: 0 });
    const result = applyRowOperation(snapshot, store, { kind: 'insert', table: 'tbl_Hero_bag_2' });

    expect(result.ok).toBe(true);
    expect(result.store.get('tbl_Hero_bag_2')![0].values.parentID).toBe(0);
  });
});

describe('applyRowOperation update', () => {
  const snapshot = heroSnapshot();

  it('merges values into the target row and reports unknown rows', () => {
    const store = simulateInitialRows(snapshot);
    const result = applyRowOperation(snapshot, store, {
      kind: 'update',
      table: 'tbl_Hero',
      id: 1,
      values: { sm_hp: 7 }
    });

    expect(result.ok).toBe(true);
    expect(result.store.get('tbl_Hero')![0].values.sm_hp).toBe(7);
    expect(store.get('tbl_Hero')![0].values.sm_hp).toBe(10);

    const missing = applyRowOperation(snapshot, store, {
      kind: 'update',
      table: 'tbl_Hero',
      id: 99,
      values: { sm_hp: 1 }
    });
    expect(missing.ok).toBe(false);
    expect(missing.issues[0]).toMatchObject({ kind: 'unknown-row', row: 99 });
    expect(missing.issues[0].message).toContain('无 id=99 的行');
  });

  it('skips the row itself when checking UNIQUE conflicts', () => {
    const store = simulateInitialRows(snapshot);
    const result = applyRowOperation(snapshot, store, {
      kind: 'update',
      table: 'tbl_Hero',
      id: 1,
      values: { sm_name: "ab'" }
    });

    expect(result.ok).toBe(true);
    expect(result.store.get('tbl_Hero')![0].values.sm_name).toBe("ab'");
  });

  it('flags UNIQUE conflicts against other rows and keeps the row unchanged', () => {
    const store = simulateInitialRows(snapshot);
    const inserted = applyRowOperation(snapshot, store, { kind: 'insert', table: 'tbl_Hero', values: { sm_name: 'other' } });
    const current = applyRowOperation(snapshot, inserted.store, {
      kind: 'update',
      table: 'tbl_Hero',
      id: 1,
      values: { sm_name: 'other' }
    });

    expect(current.ok).toBe(false);
    expect(current.issues[0].kind).toBe('unique');
    expect(current.store.get('tbl_Hero')![0].values.sm_name).toBe("ab'");
  });

  it('rejects id overrides via the shared id-column guard', () => {
    const store = simulateInitialRows(snapshot);
    const result = applyRowOperation(snapshot, store, { kind: 'update', table: 'tbl_Hero', id: 1, values: { id: 5 } });

    expect(result.ok).toBe(false);
    expect(result.issues[0]).toMatchObject({ kind: 'missing-column', column: 'id' });
  });
});

describe('applyRowOperation delete', () => {
  const snapshot = heroSnapshot();

  it('removes the row and cascades to every child row keyed by parentID', () => {
    const store = simulateInitialRows(snapshot);
    const result = applyRowOperation(snapshot, store, { kind: 'delete', table: 'tbl_Hero', id: 1 });

    expect(result.ok).toBe(true);
    expect(result.store.get('tbl_Hero')).toHaveLength(0);
    // 组件子表与 ARRAY 子表都被清,嵌套子表按二级 parentID 清
    expect(result.store.get('tbl_Hero_bag')).toHaveLength(0);
    expect(result.store.get('tbl_Hero_stats')).toHaveLength(0);
    expect(result.store.get('tbl_Hero_bag_2')).toHaveLength(0);
  });

  it('removes only the subtree when deleting a child row', () => {
    const store = simulateInitialRows(snapshot);
    const result = applyRowOperation(snapshot, store, { kind: 'delete', table: 'tbl_Hero_bag', id: 2 });

    expect(result.store.get('tbl_Hero')).toHaveLength(1);
    expect(result.store.get('tbl_Hero_bag')!.map(row => row.id)).toEqual([3]);
    expect(result.store.get('tbl_Hero_bag_2')).toHaveLength(0);
    expect(result.store.get('tbl_Hero_stats')).toHaveLength(1);
  });

  it('reports unknown rows without mutating the store', () => {
    const store = simulateInitialRows(snapshot);
    const result = applyRowOperation(snapshot, store, { kind: 'delete', table: 'tbl_Hero', id: 42 });

    expect(result.ok).toBe(false);
    expect(result.issues[0]).toMatchObject({ kind: 'unknown-row', row: 42 });
    expect(result.store.get('tbl_Hero')).toHaveLength(1);
  });
});

describe('applyRowOperation unknown table', () => {
  it('reports unknown-table for ids outside the entity build structure', () => {
    const snapshot = heroSnapshot();
    const result = applyRowOperation(snapshot, simulateInitialRows(snapshot), { kind: 'insert', table: 'tbl_Unknown' });

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([
      { kind: 'unknown-table', table: 'tbl_Unknown', message: '表 tbl_Unknown 不在实体 Hero 的建表结构中' }
    ]);
  });
});

describe('renderMysqlDdl', () => {
  it('renders each table with the engine CREATE shape and column/index fragments', () => {
    const ddl = renderMysqlDdl(heroSnapshot());

    expect(ddl).toContain('CREATE TABLE IF NOT EXISTS tbl_Hero (');
    expect(ddl).toContain('id bigint(20) unsigned AUTO_INCREMENT');
    expect(ddl).toContain('PRIMARY KEY idKey (id)');
    expect(ddl).toContain(') ENGINE=InnoDB;');
    expect(ddl).toContain('sm_autoLoad tinyint not null DEFAULT 0');
    expect(ddl).toContain(', INDEX (sm_autoLoad)');
    // 数字列:unsigned 排在宽度后(引擎模板),有 DatabaseLength 才带宽度
    expect(ddl).toContain('sm_hp int unsigned not null DEFAULT 10');
    expect(ddl).toContain('sm_coins bigint(32) unsigned not null DEFAULT 0');
    expect(ddl).toContain('sm_speed float not null DEFAULT 1.5');
    expect(ddl).toContain('sm_vec_x float not null DEFAULT 0');
    // varchar 缺省 255,默认值按 mysql 文本转义
    expect(ddl).toContain("sm_name varchar(64) not null DEFAULT 'ab\\''");
    expect(ddl).toContain("sm_title varchar(255) not null DEFAULT ''");
    expect(ddl).toContain('sm_target blob');
    expect(ddl).toContain(', UNIQUE (sm_name(64))');
    expect(ddl).toContain(', INDEX (sm_tag)');
  });

  it('renders child tables with the engine parentID shape and index', () => {
    const ddl = renderMysqlDdl(heroSnapshot());

    expect(ddl).toContain('-- tbl_Hero_bag (array)');
    expect(ddl).toContain('parentID bigint(20) unsigned NOT NULL');
    expect(ddl).toContain(', INDEX (parentID)');
    expect(ddl).toContain('-- tbl_Hero_stats (component)');
    expect(ddl).toContain('-- tbl_Hero_bag_2 (array)');
    expect(ddl).not.toContain('FOREIGN KEY');
    expect(ddl).not.toContain('REFERENCES');
  });
});

describe('renderRowsJson and renderInsertStatements', () => {
  it('renders rows keyed by table name with the id first', () => {
    const snapshot = heroSnapshot();
    const store = simulateInitialRows(snapshot);

    const parsed = JSON.parse(renderRowsJson(snapshot, store));
    expect(Object.keys(parsed)).toEqual(['tbl_Hero', 'tbl_Hero_bag', 'tbl_Hero_stats', 'tbl_Hero_bag_2']);
    expect(parsed.tbl_Hero[0]).toEqual({
      id: 1,
      sm_autoLoad: 0,
      sm_hp: 10,
      sm_coins: 0,
      sm_name: "ab'",
      sm_title: '',
      sm_target: '',
      sm_speed: 1.5,
      sm_vec_x: 0,
      sm_tag: 0
    });
    expect(parsed.tbl_Hero_bag[0]).toEqual({ id: 2, parentID: 1, sm_autoLoad: 0, sm_value: 0 });
    expect(renderRowsJson(snapshot, store).endsWith('\n')).toBe(true);
  });

  it('renders engine-shaped INSERTs that omit the id column', () => {
    const snapshot = heroSnapshot();
    const store = simulateInitialRows(snapshot);

    const text = renderInsertStatements(snapshot, store);
    expect(text).toContain(
      "insert into tbl_Hero (sm_autoLoad, sm_hp, sm_coins, sm_name, sm_title, sm_target, sm_speed, sm_vec_x, sm_tag) values(0, 10, 0, 'ab\\'', '', '', 1.5, 0, 0);"
    );
    expect(text).toContain('insert into tbl_Hero_bag (parentID, sm_autoLoad, sm_value) values(1, 0, 0);');
    expect(text).toContain('insert into tbl_Hero_stats (parentID, sm_autoLoad, sm_power) values(1, 0, 0);');
  });
});

describe('renderSimulationDocument and SIMULATION_DIFFERENCES', () => {
  it('renders the report sections and ends with the honest difference list', () => {
    const snapshot = heroSnapshot();
    const document = renderSimulationDocument(snapshot, simulateInitialRows(snapshot));

    expect(document.startsWith('# KBEngine Database Simulation: Hero\n')).toBe(true);
    expect(document).toContain('Backend: MYSQL (simulated, engine InnoDB)');
    expect(document).toContain('## DDL');
    expect(document).toContain('## 行数据 (JSON)');
    expect(document).toContain('## INSERT 语句');
    expect(document).toContain('## 与真实引擎的差异');
    expect(document).toContain('- redis 后端不模拟');
    expect(document.endsWith('\n')).toBe(true);
  });

  it('falls back to an empty report when no snapshot is available', () => {
    expect(renderSimulationDocument(null, null)).toBe('# KBEngine Database Simulation\n\nNo schema available.\n');
    expect(renderSimulationDocument(heroSnapshot(), null)).toContain('No schema available.');
  });

  it('lists the known differences verbatim for the docs mirror', () => {
    expect(SIMULATION_DIFFERENCES.length).toBeGreaterThanOrEqual(9);
    expect(SIMULATION_DIFFERENCES.some(entry => entry.includes('外键'))).toBe(true);
    expect(SIMULATION_DIFFERENCES.some(entry => entry.includes('autoIncrementInit'))).toBe(true);
    expect(SIMULATION_DIFFERENCES.some(entry => entry.includes('write_entity_helper.h'))).toBe(true);
  });
});

describe('simulation uri helpers', () => {
  it('builds the virtual document uri and round-trips the entity name', () => {
    const uri = createDatabaseSimulationUri('Hero');

    expect(uri.scheme).toBe(KBENGINE_DATABASE_SIMULATION_SCHEME);
    expect(uri.fsPath).toBe('Hero.dbsim');
    expect(getSimulationEntityName(uri)).toBe('Hero');
    expect(isDatabaseSimulationDocument({ uri: { scheme: KBENGINE_DATABASE_SIMULATION_SCHEME } })).toBe(true);
    expect(isDatabaseSimulationDocument({ uri: { scheme: 'file' } })).toBe(false);
  });

  it('percent-encodes non-ascii entity names', () => {
    const uri = createDatabaseSimulationUri('怪 物');

    expect(uri.toString()).toContain(`${encodeURIComponent('怪 物')}.dbsim`);
    expect(getSimulationEntityName(uri)).toBe('怪 物');
  });
});

// ---- 真实 def 树上的端到端:快照 → 模拟 → 三种渲染 ----
let workspaceRoot = '';

const writeDef = (relative: string, lines: string[]): void => {
  const target = path.join(workspaceRoot, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, lines.join('\n'), 'utf8');
};

beforeAll(() => {
  workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-db-sim-'));
  writeDef('scripts/entities.xml', [
    '<root>',
    '  <Ship hasBase="true" hasCell="true"/>',
    '</root>'
  ]);
  writeDef('scripts/entity_defs/Ship.def', [
    '<root>',
    '  <Properties>',
    '    <hp>',
    '      <Type>UINT32</Type>',
    '      <Flags>BASE</Flags>',
    '      <Persistent>true</Persistent>',
    '    </hp>',
    '    <name>',
    '      <Type>UNICODE</Type>',
    '      <Flags>BASE_AND_CLIENT</Flags>',
    '      <Persistent>true</Persistent>',
    '      <DatabaseLength>32</DatabaseLength>',
    '      <Default>ship</Default>',
    '    </name>',
    '    <cargo>',
    '      <Type>',
    '        ARRAY',
    '        <of>UINT16</of>',
    '      </Type>',
    '      <Persistent>true</Persistent>',
    '      <Flags>CELL_PUBLIC</Flags>',
    '    </cargo>',
    '  </Properties>',
    '</root>'
  ]);
});

afterAll(() => {
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
});

describe('simulation against a real def tree', () => {
  it('produces the root plus array child tables and renders all three artifacts', () => {
    const snapshot = snapshotOf('Ship', workspaceRoot);

    expect(snapshot).not.toBeNull();
    const store = simulateInitialRows(snapshot!);
    expect(store.get('tbl_Ship')).toHaveLength(1);
    expect(store.get('tbl_Ship_cargo')!.map(row => row.values.parentID)).toEqual([1, 1]);

    const ddl = renderMysqlDdl(snapshot!);
    expect(ddl).toContain('CREATE TABLE IF NOT EXISTS tbl_Ship (');
    expect(ddl).toContain("sm_name varchar(32) not null DEFAULT 'ship'");
    expect(ddl).toContain('sm_0_position float not null DEFAULT 0');

    const json = JSON.parse(renderRowsJson(snapshot!, store));
    expect(json.tbl_Ship[0].sm_name).toBe('ship');
    expect(renderInsertStatements(snapshot!, store)).toContain(
      'insert into tbl_Ship_cargo (parentID, sm_autoLoad, sm_value) values(1, 0, 0);'
    );

    // 行级模拟跟随真实快照的类型宽度:UINT16 子表值越界即报 type
    const result = applyRowOperation(snapshot!, store, { kind: 'insert', table: 'tbl_Ship_cargo', values: { sm_value: 70000 } });
    expect(result.ok).toBe(false);
    expect(result.issues[0].message).toContain('超出 smallint unsigned 区间 0..65535');
  });
});

// ---- provider 段:工作区解析与空态 ----
describe('KBEngineDatabaseSimulationProvider and buildDatabaseSimulationText', () => {
  afterAll(() => {
    stubWorkspace.workspaceFolders = [];
  });

  it('returns the empty report for unknown entities', () => {
    expect(buildDatabaseSimulationText('Missing')).toContain('No schema available.');
  });

  it('resolves the workspace from vscode.workspaceFolders and exposes the provider content', () => {
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(workspaceRoot), name: 'ws', index: 0 }];

    expect(buildDatabaseSimulationText('Ship')).toContain('# KBEngine Database Simulation: Ship');

    const provider = new KBEngineDatabaseSimulationProvider();
    expect(provider.provideTextDocumentContent(createDatabaseSimulationUri('Ship'))).toContain('tbl_Ship');
    expect(provider.provideTextDocumentContent(createDatabaseSimulationUri('Missing'))).toContain('No schema available.');
    provider.dispose();
  });
});

describe('row validation and simulation branch edges(补锁,批122 收口)', () => {
  it('rejects unsigned values below zero and above the type max', () => {
    const uint32 = field('sm_u32', { typeLabel: 'int unsigned' });
    const uint8 = field('sm_u8', { typeLabel: 'tinyint unsigned' });

    expect(validateRowValue(uint32, -1)).toContain('区间 0..4294967295');
    expect(validateRowValue(uint8, 256)).toContain('区间 0..255');
  });

  it('rejects signed values below the type min', () => {
    const tiny = field('sm_t', { typeLabel: 'tinyint' });

    expect(validateRowValue(tiny, -129)).toContain('区间 -128..127');
  });

  it('defaults parentID to 0 when the parent table has no simulated row', () => {
    // 组件子表的父表不在 store(父表排在文档序之后)→ parentRowId 缺失
    const child = makeTable({
      name: 'tbl_Hero_comp',
      kind: 'component',
      parentTableName: 'tbl_Hero',
      fields: [
        field('id', { typeLabel: 'bigint unsigned', indexType: 'PRIMARY' }),
        field('parentID', { typeLabel: 'bigint unsigned' }),
        field('sm_hp', { typeLabel: 'int unsigned' })
      ]
    });
    const root = makeTable({
      name: 'tbl_Hero',
      kind: 'entity',
      fields: [field('id', { typeLabel: 'bigint unsigned', indexType: 'PRIMARY' })]
    });
    const snapshot = makeSnapshot([child, root]);
    const store = simulateInitialRows(snapshot, { startId: 5 });
    const childRows = store.get('tbl_Hero_comp') ?? [];

    expect(childRows).toHaveLength(1);
    expect(childRows[0].values.parentID).toBe(0);
  });

  it('delete and insert fall back to an empty row list when the table is missing from the store', () => {
    const root = makeTable({
      name: 'tbl_Hero',
      kind: 'entity',
      fields: [
        field('id', { typeLabel: 'bigint unsigned', indexType: 'PRIMARY' }),
        field('sm_hp', { typeLabel: 'int unsigned' })
      ]
    });
    const snapshot = makeSnapshot([root]);

    const deleted = applyRowOperation(snapshot, new Map(), { kind: 'delete', table: 'tbl_Hero', id: 1 });
    expect(deleted.ok).toBe(false);
    expect(deleted.issues[0].kind).toBe('unknown-row');

    const inserted = applyRowOperation(snapshot, new Map(), {
      kind: 'insert',
      table: 'tbl_Hero',
      values: { sm_hp: 3 }
    });
    expect(inserted.ok).toBe(true);
    expect(inserted.store.get('tbl_Hero')).toHaveLength(1);
  });

  it('inserts parentID as 0 when the parent table has no rows in the store', () => {
    const root = makeTable({
      name: 'tbl_Hero',
      kind: 'entity',
      fields: [field('id', { typeLabel: 'bigint unsigned', indexType: 'PRIMARY' })]
    });
    const child = makeTable({
      name: 'tbl_Hero_bag',
      kind: 'component',
      parentTableName: 'tbl_Hero',
      fields: [
        field('id', { typeLabel: 'bigint unsigned', indexType: 'PRIMARY' }),
        field('parentID', { typeLabel: 'bigint unsigned' }),
        field('sm_count', { typeLabel: 'int unsigned' })
      ]
    });
    const snapshot = makeSnapshot([root, child]);

    const result = applyRowOperation(snapshot, new Map(), {
      kind: 'insert',
      table: 'tbl_Hero_bag',
      values: { sm_count: 7 }
    });

    expect(result.ok).toBe(true);
    expect(result.store.get('tbl_Hero_bag')?.[0].values.parentID).toBe(0);
  });

  it('renders empty arrays for tables missing from the store in JSON and INSERT output', () => {
    const root = makeTable({
      name: 'tbl_Hero',
      kind: 'entity',
      fields: [
        field('id', { typeLabel: 'bigint unsigned', indexType: 'PRIMARY' }),
        field('sm_hp', { typeLabel: 'int unsigned' })
      ]
    });
    const snapshot = makeSnapshot([root]);
    const emptyStore: SimulatedRowStore = new Map();

    expect(renderRowsJson(snapshot, emptyStore)).toContain('"tbl_Hero": []');
    expect(renderInsertStatements(snapshot, emptyStore)).toBe('');
  });

  it('does not re-enqueue an id already pending during cascade delete', () => {
    // 两个不同表各有一行 id=5、parentID=1:同 id 跨表重复时,闭包只入队一次
    const root = makeTable({
      name: 'tbl_Hero',
      kind: 'entity',
      fields: [field('id', { typeLabel: 'bigint unsigned', indexType: 'PRIMARY' })]
    });
    const childA = makeTable({
      name: 'tbl_Hero_a',
      kind: 'component',
      parentTableName: 'tbl_Hero',
      fields: [
        field('id', { typeLabel: 'bigint unsigned', indexType: 'PRIMARY' }),
        field('parentID', { typeLabel: 'bigint unsigned' })
      ]
    });
    const childB = makeTable({
      name: 'tbl_Hero_b',
      kind: 'component',
      parentTableName: 'tbl_Hero',
      fields: [
        field('id', { typeLabel: 'bigint unsigned', indexType: 'PRIMARY' }),
        field('parentID', { typeLabel: 'bigint unsigned' })
      ]
    });
    const snapshot = makeSnapshot([root, childA, childB]);
    const store: SimulatedRowStore = new Map([
      ['tbl_Hero', [{ id: 1, values: {} }]],
      ['tbl_Hero_a', [{ id: 5, values: { parentID: 1 } }]],
      ['tbl_Hero_b', [{ id: 5, values: { parentID: 1 } }]]
    ]);

    const result = applyRowOperation(snapshot, store, { kind: 'delete', table: 'tbl_Hero', id: 1 });

    expect(result.ok).toBe(true);
    expect(result.store.get('tbl_Hero_a')).toHaveLength(0);
    expect(result.store.get('tbl_Hero_b')).toHaveLength(0);
  });

  it('falls back to the bigint range for integer bases outside the range tables', () => {
    // mediumint 不在区间表:区间回落 bigint(引擎未知整型基名不崩溃)
    expect(validateRowValue(field('sm_m', { typeLabel: 'mediumint' }), 5)).toBeNull();
    expect(validateRowValue(field('sm_mu', { typeLabel: 'mediumint unsigned' }), 5)).toBeNull();
    // 越界也走回落上限文案(2^64 恰好是 number 可精确表示的 2 幂)
    expect(validateRowValue(field('sm_mu', { typeLabel: 'mediumint unsigned' }), 2 ** 64))
      .toContain('超出 mediumint unsigned 区间 0..18446744073709551615');
  });

  it('omits the index section when a table has no indexed fields', () => {
    const plain = makeSnapshot([
      makeTable({
        name: 'tbl_Plain',
        kind: 'entity',
        fields: [
          field('id', { typeLabel: 'bigint unsigned', indexType: 'PRIMARY' }),
          field('sm_plain', { typeLabel: 'int' })
        ]
      })
    ]);
    const ddl = renderMysqlDdl(plain);

    expect(ddl).toContain('CREATE TABLE IF NOT EXISTS tbl_Plain (');
    expect(ddl).toContain('PRIMARY KEY idKey (id)');
    expect(ddl).not.toContain(', INDEX (');
    expect(ddl).not.toContain(', UNIQUE (');
  });
});

// 批131(用户令:提示带完整 db.table.column + 源码限制数值):
// renderColumnDdlBody 列类型体、describeColumnValueConstraint 取值约束、
// buildPropertyDatabaseStorageHover 悬停文案(纯函数,不触运行时)。
describe('renderColumnDdlBody(批131 悬停复用的列类型体)', () => {
  it('结构列与向量/字符串/数字/浮点/blob 逐类同引擎 DDL', () => {
    expect(renderColumnDdlBody(field('parentID', { typeLabel: 'bigint unsigned' })))
      .toBe('bigint(20) unsigned NOT NULL');
    expect(renderColumnDdlBody(field('sm_autoLoad', { typeLabel: 'tinyint' })))
      .toBe('tinyint not null DEFAULT 0');
    expect(renderColumnDdlBody(field('sm_target', { typeLabel: 'blob' }))).toBe('blob');
    expect(renderColumnDdlBody(field('sm_vec_x', { typeLabel: 'vector3' })))
      .toBe('float not null DEFAULT 0');
    expect(renderColumnDdlBody(field('sm_speed', { typeLabel: 'float', defaultValue: '1.5' })))
      .toBe('float not null DEFAULT 1.5');
    // DatabaseLength 才落显示宽度;未声明则整段剥掉
    expect(renderColumnDdlBody(field('sm_coins', { typeLabel: 'bigint unsigned', databaseLength: 32 })))
      .toBe('bigint(32) unsigned not null DEFAULT 0');
    expect(renderColumnDdlBody(field('sm_hp', { typeLabel: 'int unsigned', defaultValue: '10' })))
      .toBe('int unsigned not null DEFAULT 10');
    expect(renderColumnDdlBody(field('sm_name', { typeLabel: 'varchar', databaseLength: 64, defaultValue: "ab'" })))
      .toBe("varchar(64) not null DEFAULT 'ab\\''");
  });
});

describe('describeColumnValueConstraint(源码限制数值)', () => {
  it('整型按 mysql 区间、varchar 按解析长度、浮点无约束', () => {
    expect(describeColumnValueConstraint(field('a', { typeLabel: 'int unsigned' })))
      .toBe('0..4294967295');
    expect(describeColumnValueConstraint(field('a', { typeLabel: 'int' })))
      .toBe('-2147483648..2147483647');
    expect(describeColumnValueConstraint(field('a', { typeLabel: 'bigint' })))
      .toBe('-9223372036854775808..9223372036854775807');
    // 未声明 DatabaseLength 的 varchar 按引擎缺省 255(entity_table_mysql.cpp:1829-1833)
    expect(describeColumnValueConstraint(field('a', { typeLabel: 'varchar' })))
      .toBe('≤ 255 字符');
    expect(describeColumnValueConstraint(field('a', { typeLabel: 'float' }))).toBeNull();
    expect(describeColumnValueConstraint(field('a', { typeLabel: 'blob' }))).toBeNull();
  });
});

describe('buildPropertyDatabaseStorageHover(属性悬停存储文案,批131)', () => {
  const databaseConfig = {
    host: '127.0.0.1',
    port: 13306,
    username: 'game',
    databaseName: 'game_db',
    encrypt: false,
    characterSet: 'utf8mb4'
  };

  it('empty or null storage returns null without emitting the line', () => {
    expect(buildPropertyDatabaseStorageHover(null)).toBeNull();
    expect(buildPropertyDatabaseStorageHover({ entityName: 'Hero', targets: [] })).toBeNull();
  });

  it('单标量列:完整 db.table.column + DDL 片段 + 取值区间', () => {
    const hover = buildPropertyDatabaseStorageHover({
      entityName: 'Hero',
      database: databaseConfig,
      targets: [{ tableName: 'tbl_Hero', fieldName: 'sm_hp', field: field('sm_hp', { typeLabel: 'int unsigned', defaultValue: '10' }) }]
    });
    expect(hover).toBe(
      '`game_db`.`tbl_Hero`.`sm_hp` = int unsigned not null DEFAULT 10(取值 0..4294967295)'
    );
  });

  it('无配置时只给表级全名,不虚构库名', () => {
    const hover = buildPropertyDatabaseStorageHover({
      entityName: 'Hero',
      targets: [{ tableName: 'tbl_Hero', fieldName: 'sm_hp', field: field('sm_hp') }]
    });
    expect(hover).toBe('`tbl_Hero`.`sm_hp` = int unsigned not null DEFAULT 0(取值 0..4294967295)');
  });

  it('同 DDL 多列并一条(向量三列),异型列逐条展开', () => {
    const vector = buildPropertyDatabaseStorageHover({
      entityName: 'Hero',
      targets: [
        { tableName: 'tbl_Hero', fieldName: 'sm_0_pos', field: field('sm_0_pos', { typeLabel: 'vector3' }) },
        { tableName: 'tbl_Hero', fieldName: 'sm_1_pos', field: field('sm_1_pos', { typeLabel: 'vector3' }) },
        { tableName: 'tbl_Hero', fieldName: 'sm_2_pos', field: field('sm_2_pos', { typeLabel: 'vector3' }) }
      ]
    });
    expect(vector).toBe(
      '`tbl_Hero`.`sm_0_pos`、`sm_1_pos`、`sm_2_pos` = float not null DEFAULT 0'
    );

    const mixed = buildPropertyDatabaseStorageHover({
      entityName: 'Hero',
      targets: [
        { tableName: 'tbl_Hero', fieldName: 'sm_name', field: field('sm_name', { typeLabel: 'varchar', databaseLength: 64 }) },
        { tableName: 'tbl_Hero', fieldName: 'sm_weight', field: field('sm_weight', { typeLabel: 'int unsigned' }) }
      ]
    });
    expect(mixed).toBe(
      [
        '`tbl_Hero`.`sm_name` = varchar(64) not null DEFAULT \'\'(取值 ≤ 64 字符)',
        '`tbl_Hero`.`sm_weight` = int unsigned not null DEFAULT 0(取值 0..4294967295)'
      ].join('; ')
    );
  });

  it('ARRAY 子表单列一条:说明去向与 parentID 关联', () => {
    const hero = heroSnapshot();
    const bag = hero.tables.find(table => table.name === 'tbl_Hero_bag')!;
    const hover = buildPropertyDatabaseStorageHover({
      entityName: 'Hero',
      database: databaseConfig,
      targets: [{ tableName: 'tbl_Hero_bag', table: bag }]
    });
    expect(hover).toBe(
      '子表 `game_db`.`tbl_Hero_bag`(ARRAY/组件元素逐行一条,元素行经 `parentID` 关联 `tbl_Hero`)'
    );
  });
});

describe('buildPropertyDatabaseStorageHover 防御面(批131)', () => {
  it('目标缺列与表描述时跳过;全部跳空返回 null', () => {
    expect(
      buildPropertyDatabaseStorageHover({
        entityName: 'Hero',
        targets: [{ tableName: 'tbl_Orphan', fieldName: 'sm_x' }]
      })
    ).toBeNull();
  });

  it('子表无 parent 注记时不带关联说明', () => {
    const orphan = makeTable({
      name: 'tbl_Hero_bag',
      kind: 'array',
      title: 'bag',
      fields: []
    });
    expect(
      buildPropertyDatabaseStorageHover({
        entityName: 'Hero',
        targets: [{ tableName: 'tbl_Hero_bag', table: orphan }]
      })
    ).toBe('子表 `tbl_Hero_bag`(ARRAY/组件元素逐行一条)');
  });
});
