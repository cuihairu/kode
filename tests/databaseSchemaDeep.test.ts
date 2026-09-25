import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type * as vscode from 'vscode';
import {
  KBEngineDatabaseSchemaProvider,
  findDatabaseSchemaFieldAtPosition,
  findDatabaseSchemaSourceLocation,
  findDatabaseSchemaTargetsForSource,
  getDatabaseSchemaSnapshot,
  renderDatabaseSchema
} from '../src/databaseSchema';
import type { DatabaseSchemaSnapshot, DefSourceRef, TableSchemaDescriptor } from '../src/databaseSchema';
import { Position, makeTextDocument } from './helpers/vscodeStub';

// databaseSchema 的深层分支:Provider 生命周期、渲染文本上的字段定位、
// source 定位与反查、dedupe,以及临时真实 def 树上的继承/接口/组件/
// 嵌套容器解析(parsePropertyNode/parseFixedDictChildren/
// parseArrayElementDescriptor/mergeProperties/重连缓存)。

// ---- 临时真实 def 树 ----
let workspaceRoot = '';

const writeDef = (relative: string, lines: string[]): void => {
  const target = path.join(workspaceRoot, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, lines.join('\n'), 'utf8');
};

beforeAll(() => {
  workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-schema-deep-'));

  writeDef('scripts/entities.xml', [
    '<root>',
    '  <Hero hasBase="true" hasCell="true"/>',
    '  <Hero2 hasBase="true"/>',
    '  <ParentEntity hasBase="true" hasCell="true"/>',
    '  <Empty hasBase="true"/>',
    '</root>'
  ]);

  writeDef('scripts/entity_defs/Hero.def', [
    '<root>',
    '  <Parent>',
    '    <ParentEntity/>',
    '  </Parent>',
    '  <Interfaces>',
    '    <Interface>',
    '      <InterfaceA/>',
    '      <InterfaceB/>',
    '    </Interface>',
    '  </Interfaces>',
    '  <Properties>',
    '    <hp>',
    '      <Type>UINT32</Type>',
    '      <Flags>BASE</Flags>',
    '      <Persistent>true</Persistent>',
    '      <Identifier>true</Identifier>',
    '    </hp>',
    '    <tmp>',
    '      <Type>UINT32</Type>',
    '      <Flags>BASE</Flags>',
    '      <Persistent>false</Persistent>',
    '    </tmp>',
    '    <bag>',
    '      <Type>',
    '        ARRAY',
    '        <of>UINT32</of>',
    '      </Type>',
    '      <Flags>CELL_PUBLIC</Flags>',
    '      <Persistent>true</Persistent>',
    '    </bag>',
    '    <meta>',
    '      <Type>',
    '        FIXED_DICT',
    '      </Type>',
    '      <Flags>BASE</Flags>',
    '      <Persistent>true</Persistent>',
    '    </meta>',
    '    <broken>',
    '      <Type>',
    '        ARRAY',
    '      </Type>',
    '      <Flags>BASE</Flags>',
    '      <Persistent>true</Persistent>',
    '    </broken>',
    '    <vec>',
    '      <Type>VECTOR3</Type>',
    '      <Flags>BASE</Flags>',
    '      <Persistent>true</Persistent>',
    '    </vec>',
    '    <mixflag>',
    '      <Type>UINT8</Type>',
    '      <Flags>CELL_AND_CLIENT</Flags>',
    '      <Persistent>true</Persistent>',
    '    </mixflag>',
    '    <noflags>',
    '      <Type>UINT32</Type>',
    '      <Persistent>true</Persistent>',
    '    </noflags>',
    '  </Properties>',
    '  <Components>',
    '    <comp1>',
    '      <Type>ComponentA</Type>',
    '    </comp1>',
    '    <comp1b>',
    '      <Type>ComponentA</Type>',
    '    </comp1b>',
    '    <comp2>',
    '      <Type>MissingComp</Type>',
    '    </comp2>',
    '    <compNoType>',
    '      <Persistent>true</Persistent>',
    '    </compNoType>',
    '  </Components>',
    '</root>'
  ]);

  writeDef('scripts/entity_defs/interfaces/InterfaceA.def', [
    '<root>',
    '  <Properties>',
    '    <hp>',
    '      <Type>UINT32</Type>',
    '      <Flags>BASE</Flags>',
    '      <Persistent>true</Persistent>',
    '      <DatabaseLength>64</DatabaseLength>',
    '      <Index>UNIQUE</Index>',
    '    </hp>',
    '  </Properties>',
    '</root>'
  ]);

  writeDef('scripts/entity_defs/components/ComponentA.def', [
    '<root>',
    '  <Properties>',
    '    <c_x>',
    '      <Type>UINT32</Type>',
    '      <Flags>BASE</Flags>',
    '      <Persistent>true</Persistent>',
    '    </c_x>',
    '  </Properties>',
    '  <BaseMethods>',
    '    <onComponentBase/>',
    '  </BaseMethods>',
    '  <CellMethods>',
    '    <onComponentCell/>',
    '  </CellMethods>',
    '  <ClientMethods>',
    '  </ClientMethods>',
    '</root>'
  ]);

  writeDef('scripts/entity_defs/ParentEntity.def', [
    '<root>',
    '  <Properties>',
    '    <pp>',
    '      <Type>UINT32</Type>',
    '      <Flags>CELL_PUBLIC</Flags>',
    '      <Persistent>true</Persistent>',
    '    </pp>',
    '    <nested>',
    '      <Type>FIXED_DICT</Type>',
    '      <Properties>',
    '        <inner>',
    '          <Type>FIXED_DICT</Type>',
    '          <Properties>',
    '            <leaf>',
    '              <Type>UINT8</Type>',
    '            </leaf>',
    '          </Properties>',
    '        </inner>',
    '        <items>',
    '          <Type>',
    '            ARRAY',
    '            <of>FIXED_DICT</of>',
    '            <Properties>',
    '              <part>',
    '                <Type>UINT16</Type>',
    '              </part>',
    '            </Properties>',
    '          </Type>',
    '        </items>',
    '      </Properties>',
    '      <Flags>BASE</Flags>',
    '      <Persistent>true</Persistent>',
    '    </nested>',
    '  </Properties>',
    '  <Components>',
    '    <pcomp>',
    '      <Type>ComponentA</Type>',
    '    </pcomp>',
    '  </Components>',
    '</root>'
  ]);

  // Parent 自引用:visited 短路,不无限递归
  writeDef('scripts/entity_defs/Hero2.def', [
    '<root>',
    '  <Parent>',
    '    <Hero2/>',
    '  </Parent>',
    '  <Properties>',
    '    <solo>',
    '      <Type>UINT32</Type>',
    '      <Flags>BASE</Flags>',
    '      <Persistent>true</Persistent>',
    '    </solo>',
    '  </Properties>',
    '</root>'
  ]);

  // 无元素节点:parseDefDocument root 为 null
  writeDef('scripts/entity_defs/BadDef.def', ['plain text, no xml elements']);

  // 空根元素:Properties 整段缺席
  writeDef('scripts/entity_defs/Empty.def', ['<root>', '</root>']);
});

afterAll(() => {
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
});

describe('deep snapshot over the real def tree', () => {
  it('merges inherited, interface and component properties for Hero', () => {
    const snapshot = getDatabaseSchemaSnapshot('Hero', workspaceRoot);

    expect(snapshot).not.toBeNull();
    const tables = snapshot!.tables;
    // 根表 + bag/broken/items 数组子表 + comp1/comp1b/comp2/pcomp 组件子表
    // (ARRAY 无 of 也建空子表;组件 def 缺失也建空组件表)
    expect(tables.map(t => t.name)).toEqual([
      'tbl_Hero', 'tbl_Hero_bag', 'tbl_Hero_broken',
      'tbl_Hero_comp1', 'tbl_Hero_comp1b', 'tbl_Hero_comp2',
      'tbl_Hero_items', 'tbl_Hero_pcomp'
    ]);

    const rootFields = tables[0].fields.map(f => f.name);
    // 合成列:Hero hasCell 且 comp1 scope 含 cell
    expect(rootFields.slice(0, 6)).toEqual([
      'sm_position_0', 'sm_position_1', 'sm_position_2',
      'sm_direction_0', 'sm_direction_1', 'sm_direction_2'
    ]);
    // hp:实体声明 Identifier,接口同名属性补 Index/DatabaseLength(merge 补齐)
    const hp = tables[0].fields.find(f => f.name === 'sm_hp')!;
    expect(hp.identifier).toBe(true);
    expect(hp.indexType).toBe('UNIQUE');
    expect(hp.databaseLength).toBe(64);
    // 非持久属性、无 Flags 属性、无子结构的 FIXED_DICT 都不产生列
    expect(rootFields).not.toContain('sm_tmp');
    expect(rootFields).not.toContain('sm_meta');
    expect(rootFields).not.toContain('sm_noflags');
    expect(rootFields).toContain('sm_vec_0');
    // CELL_AND_CLIENT 归一为 CELL_PUBLIC_AND_OWN,hasClient=false 后仅剩 cell
    expect(rootFields).toContain('sm_mixflag');
    // 父实体继承:直接属性与双层 FIXED_DICT 平铺前缀列
    expect(rootFields).toContain('sm_pp');
    expect(rootFields).toContain('sm_nested_inner_leaf');
    // UINT8 → tinyint unsigned(mysql 列型映射)
    expect(tables[0].fields.find(f => f.name === 'sm_nested_inner_leaf')!.typeLabel).toBe('tinyint unsigned');
  });

  it('routes the nested array-of-fixed-dict into a child table named by the array property', () => {
    const snapshot = getDatabaseSchemaSnapshot('Hero', workspaceRoot)!;
    const itemsTable = snapshot.tables.find(t => t.name === 'tbl_Hero_items');

    expect(itemsTable).toBeDefined();
    expect(itemsTable!.kind).toBe('array');
    expect(itemsTable!.parentTableName).toBe('tbl_Hero');
    // 子表名取数组属性名(items,非完整路径);元素 FIXED_DICT 的子属性带 value_ 前缀
    expect(itemsTable!.fields.map(f => f.name)).toEqual(['sm_value_part']);
  });

  it('short-circuits a self referencing parent chain', () => {
    const snapshot = getDatabaseSchemaSnapshot('Hero2', workspaceRoot);

    expect(snapshot).not.toBeNull();
    expect(snapshot!.tables).toHaveLength(1);
    expect(snapshot!.tables[0].fields.map(f => f.name)).toEqual(['sm_solo']);
  });

  it('returns an empty root table for a def without properties', () => {
    const snapshot = getDatabaseSchemaSnapshot('Empty', workspaceRoot);

    expect(snapshot).not.toBeNull();
    expect(snapshot!.tables).toHaveLength(1);
    expect(snapshot!.tables[0].fields).toEqual([]);
  });

  it('returns null when the def has no element root', () => {
    expect(getDatabaseSchemaSnapshot('BadDef', workspaceRoot)).toBeNull();
  });
});

// ---- Provider ----

describe('KBEngineDatabaseSchemaProvider', () => {
  it('renders the placeholder when no workspace resolves the entity', () => {
    const provider = new KBEngineDatabaseSchemaProvider();
    // 百分号编码实体名经 decodeURIComponent 还原;无 workspace → 快照 null
    const content = provider.provideTextDocumentContent({
      path: `/${encodeURIComponent('怪 物')}.schema`
    } as vscode.Uri);

    expect(content).toBe('# KBEngine Database Schema\n\nNo schema available.\n');
    provider.dispose();
  });

  it('fires change events for a named entity and ignores empty names', () => {
    const provider = new KBEngineDatabaseSchemaProvider();
    const fired: string[] = [];
    // vscodeStub 的 uri.scheme 单独记账:拼 scheme+fsPath 验证虚拟 URI 形态
    provider.onDidChange(uri => fired.push(`${uri.scheme}:${uri.fsPath}`));

    provider.refresh(undefined);
    expect(fired).toEqual([]);

    provider.refresh('Hero');
    expect(fired).toEqual(['kbengine-db-schema:Hero.schema']);

    provider.dispose();
  });
});

// ---- 渲染文本上的字段定位 ----

describe('findDatabaseSchemaFieldAtPosition', () => {
  const rendered = [
    '# KBEngine Database Schema: Hero',
    '',
    'Backend: MYSQL',
    'Source: /proj/Hero.def',
    '',
    'TABLE tbl_Hero',
    'kind: entity',
    'source: Hero.def:1 (Hero)',
    '',
    'sm_hp  int unsigned',
    '  source: Hero.def:3 (hp)'
  ].join('\n');

  it('identifies a table header line', () => {
    const document = makeTextDocument(rendered, { fileName: '/x/Hero.schema' });
    expect(findDatabaseSchemaFieldAtPosition(document as unknown as vscode.TextDocument, new Position(5, 0)))
      .toEqual({ table: 'tbl_Hero' });
  });

  it('walks upwards from a field line to its table', () => {
    const document = makeTextDocument(rendered, { fileName: '/x/Hero.schema' });
    expect(findDatabaseSchemaFieldAtPosition(document as unknown as vscode.TextDocument, new Position(9, 0)))
      .toEqual({ table: 'tbl_Hero', field: 'sm_hp' });
  });

  it('returns null for lines without a leading identifier', () => {
    const document = makeTextDocument(rendered, { fileName: '/x/Hero.schema' });
    // 空行与 "  source:" 缩进行都不以字段名开头
    expect(findDatabaseSchemaFieldAtPosition(document as unknown as vscode.TextDocument, new Position(1, 0))).toBeNull();
    expect(findDatabaseSchemaFieldAtPosition(document as unknown as vscode.TextDocument, new Position(10, 0))).toBeNull();
  });

  it('returns null when no table header sits above the field line', () => {
    const document = makeTextDocument('lonely_field INT\n', { fileName: '/x/Hero.schema' });
    expect(findDatabaseSchemaFieldAtPosition(document as unknown as vscode.TextDocument, new Position(0, 0))).toBeNull();
  });
});

// ---- source 定位与反查 ----

const src = (filePath: string, sourcePath: string): DefSourceRef => ({
  filePath,
  line: 3,
  path: sourcePath,
  category: 'entity'
});

const fieldOf = (name: string, sourcePath: string): TableSchemaDescriptor['fields'][number] => ({
  name,
  typeLabel: 'int unsigned',
  sourcePath,
  source: src('/proj/hero.def', sourcePath),
  identifier: false
});

const snapshotWithIndex = (): DatabaseSchemaSnapshot => {
  const heroTable: TableSchemaDescriptor = {
    name: 'tbl_Hero',
    kind: 'entity',
    title: 'Hero',
    source: src('/Proj/Hero.def', 'meta'),
    fields: [fieldOf('sm_weight', 'meta.weight')]
  };
  const bagTable: TableSchemaDescriptor = {
    name: 'tbl_Hero_bag',
    kind: 'array',
    title: 'bag',
    source: src('/proj/hero.def', 'bag'),
    parentTableName: 'tbl_Hero',
    fields: [fieldOf('sm_value', 'bag[]')]
  };
  return {
    backend: 'mysql',
    entityName: 'Hero',
    tables: [heroTable, bagTable],
    tableIndex: new Map([['tbl_Hero', heroTable], ['tbl_Hero_bag', bagTable]])
  };
};

describe('findDatabaseSchemaSourceLocation', () => {
  const snapshot = snapshotWithIndex();

  it('returns null for unknown tables', () => {
    expect(findDatabaseSchemaSourceLocation(snapshot, 'tbl_Missing')).toBeNull();
  });

  it('returns the table source without a field and the field source with one', () => {
    expect(findDatabaseSchemaSourceLocation(snapshot, 'tbl_Hero')!.path).toBe('meta');
    expect(findDatabaseSchemaSourceLocation(snapshot, 'tbl_Hero_bag', 'sm_value')!.path).toBe('bag[]');
  });

  it('returns null for unknown fields', () => {
    expect(findDatabaseSchemaSourceLocation(snapshot, 'tbl_Hero', 'sm_missing')).toBeNull();
  });
});

describe('findDatabaseSchemaTargetsForSource', () => {
  it('matches tables and fields with normalized paths and prefix rules', () => {
    const snapshot = snapshotWithIndex();

    // filePath 大小写混合经 normalizePath 归一;表 path 精确匹配,字段路径前缀匹配
    expect(findDatabaseSchemaTargetsForSource(snapshot, '/proj/HERO.def', 'meta')).toEqual([
      { tableName: 'tbl_Hero' },
      { tableName: 'tbl_Hero', fieldName: 'sm_weight' }
    ]);

    // 'bag[]' 不以 'bag.' 开头也不等于 'bag':仅表命中,字段不反查命中
    expect(findDatabaseSchemaTargetsForSource(snapshot, '/proj/hero.def', 'bag')).toEqual([
      { tableName: 'tbl_Hero_bag' }
    ]);

    expect(findDatabaseSchemaTargetsForSource(snapshot, '/other/file.def', 'meta')).toEqual([]);
  });

  it('dedupes identical table+field targets', () => {
    const snapshot = snapshotWithIndex();
    snapshot.tables[0].fields.push(fieldOf('sm_weight', 'meta.weight'));

    expect(findDatabaseSchemaTargetsForSource(snapshot, '/proj/hero.def', 'meta.weight')).toEqual([
      { tableName: 'tbl_Hero', fieldName: 'sm_weight' }
    ]);
  });
});

describe('renderDatabaseSchema parent line', () => {
  it('renders the parent annotation for child tables', () => {
    const snapshot = snapshotWithIndex();
    const text = renderDatabaseSchema(snapshot);

    expect(text).toContain('TABLE tbl_Hero_bag');
    expect(text).toContain('parent: tbl_Hero');
  });
});
