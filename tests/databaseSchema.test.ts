import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  KBENGINE_DATABASE_SCHEMA_SCHEME,
  buildMysqlTableSchemas,
  createDatabaseSchemaUri,
  expandColumnNames,
  getDatabaseSchemaSnapshot,
  isDatabaseSchemaDocument,
  locateDatabaseSchemaLine,
  renderDatabaseSchema
} from '../src/databaseSchema';
import type {
  DatabaseSchemaSnapshot,
  DefSourceRef,
  PersistentPropertyDescriptor
} from '../src/databaseSchema';

// databaseSchema 的导出函数段:Uri/文档识别、schema 文本渲染、行定位、
// mysql 表生成与列展开,均不触 vscode 运行时(vscodeStub 兜住 Uri)。
// KBEngineDatabaseSchemaProvider(EventEmitter 生命周期)由 mocha 层覆盖。

const source = (over: Partial<DefSourceRef> = {}): DefSourceRef => ({
  filePath: '/proj/Hero.def',
  line: 3,
  path: 'hp',
  category: 'entity',
  ...over
});

const property = (overrides: Partial<PersistentPropertyDescriptor> = {}): PersistentPropertyDescriptor => ({
  name: 'hp',
  typeName: 'UINT32',
  persistent: true,
  identifier: false,
  scopes: ['base'],
  source: source(),
  ...overrides
});

const emptySnapshot: DatabaseSchemaSnapshot = {
  backend: 'mysql',
  entityName: 'Hero',
  tables: [],
  tableIndex: new Map()
};

describe('createDatabaseSchemaUri and isDatabaseSchemaDocument', () => {
  it('builds the virtual document uri and round-trips the scheme check', () => {
    const uri = createDatabaseSchemaUri('Hero');

    // vscodeStub 的 Uri 只带 fsPath(= parse 输入),scheme 由 toString 前缀验证
    expect(uri.toString()).toBe('kbengine-db-schema:/Hero.schema');
    expect(isDatabaseSchemaDocument({ uri: { scheme: KBENGINE_DATABASE_SCHEMA_SCHEME } })).toBe(true);
    expect(isDatabaseSchemaDocument({ uri: { scheme: 'file' } })).toBe(false);
  });

  it('percent-encodes entity names', () => {
    const uri = createDatabaseSchemaUri('怪 物');

    expect(uri.toString()).toContain(`${encodeURIComponent('怪 物')}.schema`);
  });
});

describe('locateDatabaseSchemaLine', () => {
  // 行号公式:标题 1 行 + 4 行头 + 1 空行 = 首表表名行 6;
  // 每字段 2 行;表尾空行 1 行。
  const snapshot: DatabaseSchemaSnapshot = {
    ...emptySnapshot,
    tables: [
      {
        name: 'tbl_Hero',
        kind: 'entity',
        title: 'Hero',
        source: source({ path: '' }),
        fields: [
          field('sm_hp'),
          field('sm_speed')
        ]
      },
      {
        name: 'tbl_Hero_bag',
        kind: 'array',
        title: 'bag',
        source: source({ path: 'bag[]' }),
        parentTableName: 'tbl_Hero',
        fields: [field('sm_value')]
      }
    ] as DatabaseSchemaSnapshot['tables'],
    tableIndex: new Map()
  };

  function field(name: string): DatabaseSchemaSnapshot['tables'][number]['fields'][number] {
    return {
      name,
      typeLabel: 'UINT32',
      sourcePath: 'scripts/Hero.def',
      source: source(),
      identifier: false
    };
  }

  it('locates table header and field lines by the fixed layout', () => {
    expect(locateDatabaseSchemaLine(snapshot, 'tbl_Hero')).toBe(6);
    expect(locateDatabaseSchemaLine(snapshot, 'tbl_Hero', 'sm_hp')).toBe(10);
    expect(locateDatabaseSchemaLine(snapshot, 'tbl_Hero', 'sm_speed')).toBe(12);
    expect(locateDatabaseSchemaLine(snapshot, 'tbl_Hero_bag')).toBe(15);
    expect(locateDatabaseSchemaLine(snapshot, 'tbl_Hero_bag', 'sm_value')).toBe(19);
  });

  it('falls back to line 1 for unknown tables or fields', () => {
    expect(locateDatabaseSchemaLine(snapshot, 'tbl_Missing')).toBe(1);
    expect(locateDatabaseSchemaLine(snapshot, 'tbl_Hero', 'sm_missing')).toBe(1);
  });
});

describe('renderDatabaseSchema', () => {
  it('renders the empty placeholder without a snapshot', () => {
    expect(renderDatabaseSchema(null)).toBe('# KBEngine Database Schema\n\nNo schema available.\n');
  });

  it('renders tables with annotations and source lines', () => {
    const snapshot: DatabaseSchemaSnapshot = {
      backend: 'mysql',
      entityName: 'Hero',
      defFilePath: '/proj/Hero.def',
      tables: [
        {
          name: 'tbl_Hero',
          kind: 'entity',
          title: 'Hero',
          source: source({ path: 'entity' }),
          fields: [
            {
              name: 'sm_hp',
              typeLabel: 'UINT32',
              sourcePath: 'scripts/Hero.def',
              source: source(),
              databaseLength: 32,
              indexType: 'UNIQUE',
              identifier: true,
              flags: 'BASE'
            }
          ]
        }
      ],
      tableIndex: new Map()
    };

    expect(renderDatabaseSchema(snapshot)).toBe(
      [
        '# KBEngine Database Schema: Hero',
        '',
        'Backend: MYSQL',
        'Source: /proj/Hero.def',
        '',
        'TABLE tbl_Hero',
        'kind: entity',
        'source: Hero.def:3 (entity)',
        '',
        'sm_hp  UINT32  len=32  index=UNIQUE  identifier=true  flags=BASE',
        '  source: Hero.def:3 (scripts/Hero.def)',
        ''
      ].join('\n').trimEnd() + '\n'
    );
  });
});

describe('expandColumnNames', () => {
  it('expands vector columns and prefixes plain ones', () => {
    expect(expandColumnNames(property({ name: 'hp', typeName: 'UINT32' }))).toEqual(['sm_hp']);
    expect(expandColumnNames(property({ name: 'v', typeName: 'VECTOR2' }))).toEqual([
      'sm_v_0', 'sm_v_1'
    ]);
    expect(expandColumnNames(property({ name: 'v', typeName: 'VECTOR3' }))).toEqual([
      'sm_v_0', 'sm_v_1', 'sm_v_2'
    ]);
    expect(expandColumnNames(property({ name: 'v', typeName: 'VECTOR4' }))).toEqual([
      'sm_v_0', 'sm_v_1', 'sm_v_2', 'sm_v_3'
    ]);
  });

  it('joins the fixed-dict prefix in front of the column name', () => {
    expect(expandColumnNames(property({ name: 'weight', typeName: 'UINT8' }), 'meta_'))
      .toEqual(['sm_meta_weight']);
  });
});

describe('buildMysqlTableSchemas', () => {
  const entitySource = source({ line: 1, path: 'Hero' });
  const availability = { hasBase: true, hasCell: false, hasClient: false };

  it('creates the root table and skips non-persistent properties', () => {
    const tables = buildMysqlTableSchemas('Hero', entitySource, [
      property(),
      property({ name: 'tmp', persistent: false })
    ], availability);

    expect(tables).toHaveLength(1);
    expect(tables[0]).toMatchObject({
      name: 'tbl_Hero',
      kind: 'entity',
      title: 'Hero'
    });
    expect(tables[0].fields.map(f => f.name)).toEqual(['sm_hp']);
    expect(tables[0].fields[0]).toMatchObject({
      // mysql 列型映射:UINT32 → int unsigned
      typeLabel: 'int unsigned',
      identifier: false
    });
  });

  it('prepends synthetic position/direction columns for cell entities', () => {
    const tables = buildMysqlTableSchemas('Hero', entitySource, [property()], {
      hasBase: true, hasCell: true, hasClient: false
    });

    expect(tables[0].fields.map(f => f.name)).toEqual([
      'sm_position_0', 'sm_position_1', 'sm_position_2',
      'sm_direction_0', 'sm_direction_1', 'sm_direction_2',
      'sm_hp'
    ]);
    expect(tables[0].fields[0].typeLabel).toBe('float');
  });

  it('routes ARRAY properties into child tables and recurses the element', () => {
    const tables = buildMysqlTableSchemas('Hero', entitySource, [
      property({
        name: 'bag',
        typeName: 'ARRAY',
        arrayElement: property({ name: 'value', typeName: 'UINT32' })
      })
    ], availability);

    expect(tables.map(t => t.name)).toEqual(['tbl_Hero', 'tbl_Hero_bag']);
    expect(tables[1]).toMatchObject({
      kind: 'array',
      parentTableName: 'tbl_Hero'
    });
    expect(tables[1].fields.map(f => f.name)).toEqual(['sm_value']);
  });

  it('flattens FIXED_DICT children with the path prefix and no extra table', () => {
    const tables = buildMysqlTableSchemas('Hero', entitySource, [
      property({
        name: 'meta',
        typeName: 'FIXED_DICT',
        children: [property({ name: 'weight', typeName: 'UINT8' })]
      })
    ], availability);

    expect(tables).toHaveLength(1);
    expect(tables[0].fields.map(f => f.name)).toEqual(['sm_meta_weight']);
  });

  it('expands VECTOR3 into three columns and dedupes repeated names', () => {
    const tables = buildMysqlTableSchemas('Hero', entitySource, [
      property({ name: 'v', typeName: 'VECTOR3' }),
      property()
    ], availability);

    expect(tables[0].fields.map(f => f.name)).toEqual([
      'sm_v_0', 'sm_v_1', 'sm_v_2', 'sm_hp'
    ]);
  });
});

describe('getDatabaseSchemaSnapshot against a temp workspace', () => {
  let workspaceRoot = '';

  beforeAll(() => {
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-schema-'));
    const defFile = path.join(workspaceRoot, 'scripts', 'entity_defs', 'Hero.def');
    fs.mkdirSync(path.dirname(defFile), { recursive: true });
    fs.writeFileSync(defFile, [
      '<root>',
      '  <Properties>',
      '    <hp>',
      '      <Type>UINT32</Type>',
      '      <Flags>BASE</Flags>',
      '      <Persistent>true</Persistent>',
      '      <DatabaseLength>32</DatabaseLength>',
      '      <Identifier>true</Identifier>',
      '    </hp>',
      '    <bag>',
      '      <Type>',
      '        ARRAY',
      '        <of>UINT32</of>',
      '      </Type>',
      '      <Persistent>true</Persistent>',
      '      <Flags>CELL_PUBLIC</Flags>',
      '    </bag>',
      '  </Properties>',
      '</root>'
    ].join('\n'), 'utf8');
  });

  afterAll(() => {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it('builds the snapshot from real def files under scripts/entity_defs', () => {
    const snapshot = getDatabaseSchemaSnapshot('Hero', workspaceRoot);

    expect(snapshot).not.toBeNull();
    expect(snapshot!.backend).toBe('mysql');
    expect(snapshot!.entityName).toBe('Hero');
    expect(snapshot!.tables[0].name).toBe('tbl_Hero');

    const fieldNames = snapshot!.tables[0].fields.map(f => f.name);
    expect(fieldNames).toContain('sm_hp');
    expect(fieldNames).toContain('sm_position_0'); // bag 带 CELL_PUBLIC → cell 实体合成列
    expect(snapshot!.tableIndex.get('tbl_Hero_bag')).toBeDefined();
  });

  it('returns null outside a recognizable workspace', () => {
    expect(getDatabaseSchemaSnapshot('Hero', '/nonexistent-root')).toBeNull();
  });
});
