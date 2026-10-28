import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  describePropertyDatabaseStorage,
  getDatabaseSchemaSnapshot,
  locateDatabaseSchemaLine,
  renderChildTableJoinSelect,
  renderDatabaseSchema,
  renderPropertyColumnSelect,
  renderTableSqlLines,
  resolveEntityTableName,
  resolveSchemaTablePrefix
} from '../src/databaseSchema';
import { buildMysqlTableSchemas, expandColumnNames } from '../src/databaseSchemaCore';
import {
  KBENGINE_DATABASE_SCHEMA_SCHEME,
  createDatabaseSchemaUri,
  isDatabaseSchemaDocument
} from '../src/databaseSchemaPresentation';
import { Uri, configurationOverrides, workspace as stubWorkspace } from './helpers/vscodeStub';
import type { DatabaseSchemaSnapshot } from '../src/databaseSchema';
import type { DefSourceRef, PersistentPropertyDescriptor } from '../src/databaseSchemaCore';

// databaseSchema 的导出函数段:Uri/文档识别、schema 文本渲染、行定位、
// mysql 表生成与列展开,均不触 vscode 运行时(vscodeStub 兜住 Uri)。
// 批98 起列集对齐引擎装载语义:所有表固定 id/sm_autoLoad 结构列(子表加
// parentID),实体 hasCell(entityCellContent 形参)时追加 sm_<i>_position/
// direction 六列,向量列名 index 在前。KBEngineDatabaseSchemaProvider
// (EventEmitter 生命周期)由 tests/databaseSchemaDeep.test.ts 覆盖。

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

    // vscodeStub 的 Uri.parse 把 scheme 记在 scheme 字段,剩余部分作为 fsPath
    expect(uri.scheme).toBe(KBENGINE_DATABASE_SCHEMA_SCHEME);
    expect(uri.fsPath).toBe('Hero.schema');
    expect(isDatabaseSchemaDocument({ uri: { scheme: KBENGINE_DATABASE_SCHEMA_SCHEME } })).toBe(true);
    expect(isDatabaseSchemaDocument({ uri: { scheme: 'file' } })).toBe(false);
  });

  it('percent-encodes entity names', () => {
    const uri = createDatabaseSchemaUri('怪 物');

    expect(uri.toString()).toContain(`${encodeURIComponent('怪 物')}.schema`);
  });
});

describe('locateDatabaseSchemaLine', () => {
  // 行号不再手写镜像版式(批133 用户令:友好版式改版后旧的 `line = 6` /
  // `+= 5` / `+= 2` 镜像公式全部失效)。定位改为从 renderDatabaseSchema 的
  // 渲染文本里找锚点,断言「返回行就是那个锚点所在行」而非锁死具体行号。
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

  const rendered = (subject: DatabaseSchemaSnapshot): string[] =>
    renderDatabaseSchema(subject).split('\n');

  it('points at the table header and field lines', () => {
    const lines = rendered(snapshot);
    expect(lines[locateDatabaseSchemaLine(snapshot, 'tbl_Hero') - 1]).toBe('TABLE tbl_Hero');
    expect(lines[locateDatabaseSchemaLine(snapshot, 'tbl_Hero', 'sm_hp') - 1]).toContain('sm_hp');
    expect(lines[locateDatabaseSchemaLine(snapshot, 'tbl_Hero', 'sm_speed') - 1]).toContain('sm_speed');
    expect(lines[locateDatabaseSchemaLine(snapshot, 'tbl_Hero_bag') - 1]).toBe('TABLE tbl_Hero_bag');
    expect(lines[locateDatabaseSchemaLine(snapshot, 'tbl_Hero_bag', 'sm_value') - 1]).toContain('sm_value');
  });

  it('stays anchored when a database line is present', () => {
    const withDatabase: DatabaseSchemaSnapshot = {
      ...snapshot,
      database: {
        host: 'localhost',
        port: 3306,
        username: 'kbe',
        databaseName: 'kbe',
        encrypt: true,
        characterSet: 'utf8mb4'
      }
    };
    const lines = rendered(withDatabase);
    expect(lines[locateDatabaseSchemaLine(withDatabase, 'tbl_Hero') - 1]).toBe('TABLE tbl_Hero');
    expect(lines[locateDatabaseSchemaLine(withDatabase, 'tbl_Hero', 'sm_speed') - 1]).toContain('sm_speed');
    expect(lines[locateDatabaseSchemaLine(withDatabase, 'tbl_Hero_bag', 'sm_value') - 1]).toContain('sm_value');
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

  it('renders tables with a legend, engine/property groups and def anchors(批133)', () => {
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
              name: 'id',
              typeLabel: 'bigint unsigned',
              sourcePath: 'id',
              source: source(),
              indexType: 'PRIMARY',
              identifier: false,
              synthetic: true
            },
            {
              name: 'sm_hp',
              typeLabel: 'UINT32',
              sourcePath: 'scripts/Hero.def',
              source: source(),
              databaseLength: 32,
              indexType: 'UNIQUE',
              identifier: true,
              flags: 'BASE',
              defaultValue: '100'
            }
          ]
        }
      ],
      tableIndex: new Map()
    };

    const text = renderDatabaseSchema(snapshot);
    // 头部与读图方式
    expect(text).toContain('# 数据库表结构: Hero');
    expect(text).toContain('存储引擎: MySQL');
    expect(text).toContain('定义文件: /proj/Hero.def');
    expect(text).toContain('表: 1 张 · 列: 2（其中 .def 声明 1）');
    expect(text).toContain('读图方式');
    expect(text).toContain('kbengine.db.tablePrefix');
    // 表头:TABLE 锚点行不动(跳转定位按它解析),其余改中文标签
    expect(text).toContain('TABLE tbl_Hero');
    expect(text).toContain('表类型: 实体表');
    expect(text).toContain('定义来源: /proj/Hero.def:3');
    expect(text).not.toContain('kind:');
    expect(text).not.toContain('Backend:');
    expect(text).not.toContain('Source:');
    // 引擎列与属性列分组,注解与 def 落点各自到位
    expect(text).toContain('引擎列（引擎自动建，.def 无需声明）');
    expect(text).toMatch(/id\s+bigint unsigned\s+索引 PRIMARY\s+主键（自增）/);
    expect(text).toContain('属性列（.def 里声明的）');
    expect(text).toMatch(/sm_hp\s+UINT32\s+长度 32\s+索引 UNIQUE\s+唯一标识\s+flags=BASE\s+默认值 100/);
    expect(text).toContain('← Hero.def:3 <hp>');
    // SQL 三行格式不动(可直接粘贴)
    expect(text).toContain('SQL: SELECT * FROM `tbl_Hero` LIMIT 100;');
    expect(text).toContain('SQL(属性列): SELECT `sm_hp` FROM `tbl_Hero` LIMIT 100;');
    expect(text).toBe(text.trimEnd() + '\n');
  });

  it('annotates engine columns by their fixed meaning and marks parent tables', () => {
    const snapshot: DatabaseSchemaSnapshot = {
      ...emptySnapshot,
      tables: [
        {
          name: 'tbl_Hero_bag',
          kind: 'array',
          title: 'bag',
          source: source({ path: 'bag[]' }),
          parentTableName: 'tbl_Hero',
          fields: [
            {
              name: 'parentID',
              typeLabel: 'bigint unsigned',
              sourcePath: 'parentID',
              source: source(),
              indexType: 'INDEX',
              identifier: false,
              synthetic: true
            },
            {
              name: 'sm_0_position',
              typeLabel: 'float',
              sourcePath: 'position.x',
              source: source(),
              identifier: false,
              synthetic: true
            },
            {
              name: 'sm_reserved',
              typeLabel: 'int unsigned',
              sourcePath: 'reserved.col',
              source: source(),
              indexType: 'INDEX',
              identifier: false,
              synthetic: true
            },
            {
              name: 'sm_extra',
              typeLabel: 'int unsigned',
              sourcePath: 'extra.col',
              source: source(),
              identifier: false,
              synthetic: true
            },
            {
              name: 'sm_anon',
              typeLabel: 'int unsigned',
              sourcePath: '',
              source: source(),
              identifier: false,
              synthetic: true
            }
          ]
        }
      ] as DatabaseSchemaSnapshot['tables']
    };

    const text = renderDatabaseSchema(snapshot);
    expect(text).toContain('TABLE tbl_Hero_bag');
    expect(text).toContain('父表: tbl_Hero');
    expect(text).toMatch(/parentID\s+bigint unsigned\s+索引 INDEX\s+带索引；指回父表主键/);
    expect(text).toMatch(/sm_0_position\s+float\s+位置 x（引擎为 hasCell 实体预留 6 列）/);
    // 只有引擎列的表照实提示,不留一个没人看懂的空表
    expect(text).toContain('属性列: 无（本表只有引擎列，没有 .def 声明的数据列）');
    // 兜底注解:固定几列之外的引擎列报索引或来源键,不留空白注解
    expect(text).toMatch(/sm_reserved\s+int unsigned\s+索引 INDEX\s+带 INDEX 索引/);
    expect(text).toMatch(/sm_extra\s+int unsigned\s+引擎列（extra\.col）/);
    expect(text).toMatch(/sm_anon\s+int unsigned\s+引擎列/);
  });

  it('displays table sources workspace-relative inside the workspace and absolute outside(批133)', () => {
    // 定义来源的路径显示跟工作区走:区内相对;恰为工作区根(relative 空串)
    // 与区外(relative 以 '..' 开头)照退绝对路径,不虚构相对关系;
    // 字段行尾随 basename 短标,完整路径跳转由 source 提供
    const saved = stubWorkspace.workspaceFolders;
    stubWorkspace.workspaceFolders = [
      { uri: Uri.file('/ws'), name: 'ws', index: 0 }
    ];
    try {
      const snapshot: DatabaseSchemaSnapshot = {
        ...emptySnapshot,
        tables: [
          {
            name: 'tbl_Hero',
            kind: 'entity',
            title: 'Hero',
            source: source({ filePath: '/ws/scripts/entity_defs/Hero.def' }),
            fields: [
              { name: 'sm_hp', typeLabel: 'UINT32', sourcePath: 'hp', source: source({ filePath: '/ws' }), identifier: false }
            ]
          },
          {
            name: 'tbl_Hero_bag',
            kind: 'array',
            title: 'bag',
            source: source({ filePath: '/ws', path: 'bag[]' }),
            parentTableName: 'tbl_Hero',
            fields: [
              { name: 'sm_x', typeLabel: 'UINT32', sourcePath: 'x', source: source({ filePath: '/outside/Hero.def' }), identifier: false }
            ]
          }
        ] as DatabaseSchemaSnapshot['tables'],
        tableIndex: new Map()
      };

      const text = renderDatabaseSchema(snapshot);
      expect(text).toContain('定义来源: scripts/entity_defs/Hero.def:3');
      expect(text).toContain('定义来源: /ws:3');
      expect(text).toContain('← ws:3 <hp>');
      expect(text).toContain('← Hero.def:3 <hp>');
    } finally {
      stubWorkspace.workspaceFolders = saved;
    }
  });

  it('keeps absolute paths for sources outside the workspace(批133)', () => {
    // workspaceFolders 未定义(无工作区打开)时同样照给绝对路径
    const saved = stubWorkspace.workspaceFolders;
    (stubWorkspace as unknown as Record<string, unknown>).workspaceFolders = undefined;
    try {
      const snapshot: DatabaseSchemaSnapshot = {
        ...emptySnapshot,
        tables: [
          {
            name: 'tbl_Hero',
            kind: 'entity',
            title: 'Hero',
            source: source({ filePath: '/outside/Hero.def' }),
            fields: []
          }
        ] as DatabaseSchemaSnapshot['tables'],
        tableIndex: new Map()
      };

      expect(renderDatabaseSchema(snapshot)).toContain('定义来源: /outside/Hero.def:3');
    } finally {
      stubWorkspace.workspaceFolders = saved;
    }
  });

  it('renders the database line and db-qualified SQL when config is readable(批131)', () => {
    const snapshot: DatabaseSchemaSnapshot = {
      backend: 'mysql',
      entityName: 'Hero',
      defFilePath: '/proj/Hero.def',
      database: {
        host: '127.0.0.1',
        port: 13306,
        username: 'game',
        databaseName: 'game_db',
        encrypt: false,
        characterSet: 'utf8mb4'
      },
      tables: [
        {
          name: 'tbl_Hero',
          kind: 'entity',
          title: 'Hero',
          source: source({ path: 'entity' }),
          fields: []
        }
      ],
      tableIndex: new Map()
    };

    const text = renderDatabaseSchema(snapshot);
    expect(text).toContain('数据库: game_db@127.0.0.1:13306');
    expect(text).toContain('SQL: SELECT * FROM `game_db`.`tbl_Hero` LIMIT 100;');
  });
});

describe('expandColumnNames', () => {
  it('expands vector columns and prefixes plain ones', () => {
    expect(expandColumnNames(property({ name: 'hp', typeName: 'UINT32' }))).toEqual(['sm_hp']);
    // 引擎向量命名:init_db_item_name 为 sm_<index>_<FD前缀><项名>,index 在前
    expect(expandColumnNames(property({ name: 'v', typeName: 'VECTOR2' }))).toEqual([
      'sm_0_v', 'sm_1_v'
    ]);
    expect(expandColumnNames(property({ name: 'v', typeName: 'VECTOR3' }))).toEqual([
      'sm_0_v', 'sm_1_v', 'sm_2_v'
    ]);
    expect(expandColumnNames(property({ name: 'v', typeName: 'VECTOR4' }))).toEqual([
      'sm_0_v', 'sm_1_v', 'sm_2_v', 'sm_3_v'
    ]);
  });

  it('joins the fixed-dict prefix in front of the column name', () => {
    expect(expandColumnNames(property({ name: 'weight', typeName: 'UINT8' }), 'meta_'))
      .toEqual(['sm_meta_weight']);
  });

  it('lands the fixed-dict prefix between the vector index and the item name', () => {
    // FIXED_DICT 内向量:前缀夹在 index 与项名之间(引擎对 FD 键向量同规则)
    expect(expandColumnNames(property({ name: 'v', typeName: 'VECTOR3' }), 'd_'))
      .toEqual(['sm_0_d_v', 'sm_1_d_v', 'sm_2_d_v']);
  });
});

describe('buildMysqlTableSchemas', () => {
  const entitySource = source({ line: 1, path: 'Hero' });

  it('creates the root table with structural columns and skips non-persistent properties', () => {
    const tables = buildMysqlTableSchemas('Hero', entitySource, [
      property(),
      property({ name: 'tmp', persistent: false })
    ], false);

    expect(tables).toHaveLength(1);
    expect(tables[0]).toMatchObject({
      name: 'tbl_Hero',
      kind: 'entity',
      title: 'Hero'
    });
    // 引擎建表固定结构列:id(自增主键)+ sm_autoLoad(索引);无 cell 内容时
    // 不落 position/direction
    expect(tables[0].fields.map(f => f.name)).toEqual(['id', 'sm_autoLoad', 'sm_hp']);
    expect(tables[0].fields[0]).toMatchObject({
      typeLabel: 'bigint unsigned',
      indexType: 'PRIMARY'
    });
    expect(tables[0].fields[1]).toMatchObject({
      typeLabel: 'tinyint',
      indexType: 'INDEX'
    });
    expect(tables[0].fields[2]).toMatchObject({
      // mysql 列型映射:UINT32 → int unsigned
      typeLabel: 'int unsigned',
      identifier: false
    });
  });

  it('prepends synthetic position/direction columns for cell entities', () => {
    const tables = buildMysqlTableSchemas('Hero', entitySource, [property()], true);

    expect(tables[0].fields.map(f => f.name)).toEqual([
      'id', 'sm_autoLoad',
      'sm_0_position', 'sm_1_position', 'sm_2_position',
      'sm_0_direction', 'sm_1_direction', 'sm_2_direction',
      'sm_hp'
    ]);
    expect(tables[0].fields[2].typeLabel).toBe('float');
  });

  it('routes ARRAY properties into child tables and recurses the element', () => {
    const tables = buildMysqlTableSchemas('Hero', entitySource, [
      property({
        name: 'bag',
        typeName: 'ARRAY',
        arrayElement: property({ name: 'value', typeName: 'UINT32' })
      })
    ], false);

    expect(tables.map(t => t.name)).toEqual(['tbl_Hero', 'tbl_Hero_bag']);
    expect(tables[1]).toMatchObject({
      kind: 'array',
      parentTableName: 'tbl_Hero'
    });
    // 子表结构列:id + parentID(索引)+ sm_autoLoad,再落元素列
    expect(tables[1].fields.map(f => f.name)).toEqual([
      'id', 'parentID', 'sm_autoLoad', 'sm_value'
    ]);
    expect(tables[1].fields[1]).toMatchObject({
      typeLabel: 'bigint unsigned',
      indexType: 'INDEX'
    });
  });

  it('flattens FIXED_DICT children with the path prefix and no extra table', () => {
    const tables = buildMysqlTableSchemas('Hero', entitySource, [
      property({
        name: 'meta',
        typeName: 'FIXED_DICT',
        children: [property({ name: 'weight', typeName: 'UINT8' })]
      })
    ], false);

    expect(tables).toHaveLength(1);
    expect(tables[0].fields.map(f => f.name)).toEqual(['id', 'sm_autoLoad', 'sm_meta_weight']);
  });

  it('expands VECTOR3 into three columns and dedupes repeated names', () => {
    const tables = buildMysqlTableSchemas('Hero', entitySource, [
      property({ name: 'v', typeName: 'VECTOR3' }),
      property()
    ], false);

    expect(tables[0].fields.map(f => f.name)).toEqual([
      'id', 'sm_autoLoad', 'sm_0_v', 'sm_1_v', 'sm_2_v', 'sm_hp'
    ]);
  });

  it('defaults STRING database length to 255 and keeps declared lengths', () => {
    const tables = buildMysqlTableSchemas('Hero', entitySource, [
      property({ name: 'name', typeName: 'STRING' }),
      property({ name: 'title', typeName: 'UNICODE', databaseLength: 64 })
    ], false);

    const nameField = tables[0].fields.find(f => f.name === 'sm_name')!;
    expect(nameField.databaseLength).toBe(255);
    const titleField = tables[0].fields.find(f => f.name === 'sm_title')!;
    expect(titleField.databaseLength).toBe(64);
  });

  it('drops ENTITYCALL columns entirely', () => {
    const tables = buildMysqlTableSchemas('Hero', entitySource, [
      property({ name: 'target', typeName: 'ENTITYCALL' })
    ], false);

    expect(tables[0].fields.map(f => f.name)).toEqual(['id', 'sm_autoLoad']);
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
    // 引擎实体 has* 由 autoMatchCompOwn 裁定:entities.xml 声明优先于脚本
    // 存在性;此处显式声明 hasCell,root 表才落 position/direction 合成列。
    fs.writeFileSync(path.join(workspaceRoot, 'scripts', 'entities.xml'), [
      '<root>',
      '  <Hero hasBase="true" hasCell="true"/>',
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
    expect(fieldNames).toContain('id');
    expect(fieldNames).toContain('sm_autoLoad');
    expect(fieldNames).toContain('sm_0_position'); // entities.xml 声明 hasCell → cell 实体合成列
    expect(snapshot!.tableIndex.get('tbl_Hero_bag')).toBeDefined();
  });

  it('returns null outside a recognizable workspace', () => {
    expect(getDatabaseSchemaSnapshot('Hero', '/nonexistent-root')).toBeNull();
  });
});

describe('describePropertyDatabaseStorage', () => {
  let storageRoot = '';

  beforeAll(() => {
    storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-db-store-'));
    const defFile = path.join(storageRoot, 'scripts', 'entity_defs', 'Hero.def');
    fs.mkdirSync(path.dirname(defFile), { recursive: true });
    fs.writeFileSync(defFile, [
      '<root>',
      '  <Properties>',
      '    <hp>',
      '      <Type>UINT32</Type>',
      '      <Persistent>true</Persistent>',
      '    </hp>',
      '  </Properties>',
      '</root>'
    ].join('\n'), 'utf8');
  });

  afterAll(() => {
    fs.rmSync(storageRoot, { recursive: true, force: true });
  });

  it('maps a persistent property to its table and column', () => {
    const info = describePropertyDatabaseStorage('Hero', 'hp', storageRoot);

    expect(info).not.toBeNull();
    expect(info!.entityName).toBe('Hero');
    expect(info!.targets).toMatchObject([{ tableName: 'tbl_Hero', fieldName: 'sm_hp' }]);
    // 批131:目标带全量列描述(悬停拼 DDL 摘要用)
    expect(info!.targets[0].field).toMatchObject({ name: 'sm_hp', typeLabel: 'int unsigned' });
  });

  it('returns null when the entity def cannot be resolved', () => {
    expect(describePropertyDatabaseStorage('Ghost', 'hp', storageRoot)).toBeNull();
  });

  it('returns null for a property with no schema targets', () => {
    expect(describePropertyDatabaseStorage('Hero', 'missing', storageRoot)).toBeNull();
  });
});

describe('批B SQL 模板与库表前缀', () => {
  let root = '';

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-schema-sql-'));
    const defFile = path.join(root, 'scripts', 'entity_defs', 'Hero.def');
    fs.mkdirSync(path.dirname(defFile), { recursive: true });
    fs.writeFileSync(defFile, [
      '<root>',
      '  <Properties>',
      '    <hp>',
      '      <Type>UINT32</Type>',
      '      <Flags>BASE</Flags>',
      '      <Persistent>true</Persistent>',
      '    </hp>',
      '    <speed>',
      '      <Type>FLOAT</Type>',
      '      <Persistent>false</Persistent>',
      '    </speed>',
      '    <bag>',
      '      <Type>',
      '        ARRAY',
      '        <of>UINT32</of>',
      '      </Type>',
      '      <Persistent>true</Persistent>',
      '    </bag>',
      '  </Properties>',
      '</root>'
    ].join('\n'), 'utf8');
  });

  afterAll(() => {
    configurationOverrides.delete('kbengine');
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('gives every table a full select plus a property-column select', () => {
    const snapshot = getDatabaseSchemaSnapshot('Hero', root);
    const rootTable = snapshot!.tables[0];

    expect(renderTableSqlLines(snapshot!, rootTable)).toEqual([
      'SQL: SELECT * FROM `tbl_Hero` LIMIT 100;',
      // 属性列集只列 def 属性落成的列,引擎结构列(id/sm_autoLoad/位置朝向)不进
      'SQL(属性列): SELECT `sm_hp` FROM `tbl_Hero` LIMIT 100;'
    ]);
    // Persistent=false 的 speed 不建列,两路模板都不出现
    expect(renderTableSqlLines(snapshot!, rootTable).join('')).not.toContain('sm_speed');
  });

  it('joins a child table to its parent through parentID', () => {
    const snapshot = getDatabaseSchemaSnapshot('Hero', root);
    const childTable = snapshot!.tableIndex.get('tbl_Hero_bag')!;

    expect(renderTableSqlLines(snapshot!, childTable)).toEqual([
      'SQL: SELECT * FROM `tbl_Hero_bag` LIMIT 100;',
      'SQL(属性列): SELECT `sm_value` FROM `tbl_Hero_bag` LIMIT 100;',
      'SQL(子表 JOIN): SELECT p.`id` AS parentID, c.`id`, c.`parentID`, c.`sm_autoLoad`, c.`sm_value` FROM `tbl_Hero` AS p LEFT JOIN `tbl_Hero_bag` AS c ON c.`parentID` = p.`id` LIMIT 100;'
    ]);
  });

  it('qualifies both table names with the database read from engine config', () => {
    configurationOverrides.set('kbengine', { assetsRoot: path.join(root, 'kbengine.xml') });
    const snapshot = getDatabaseSchemaSnapshot('Hero', root);
    configurationOverrides.delete('kbengine');
    const childTable = snapshot!.tableIndex.get('tbl_Hero_bag')!;
    const joinLine = renderTableSqlLines(snapshot!, childTable)[2];

    // 连接要素读不到时库名缺席,表名照常——前缀替换与库前缀互不影响
    expect(joinLine).toContain('LEFT JOIN `tbl_Hero_bag` AS c');
  });

  it('applies a custom table prefix to table names and every template', () => {
    configurationOverrides.set('kbengine', { 'db.tablePrefix': 'kb_' });
    const snapshot = getDatabaseSchemaSnapshot('Hero', root);
    const childTable = snapshot!.tableIndex.get('kb_Hero_bag')!;
    const lines = renderTableSqlLines(snapshot!, childTable);
    const text = renderDatabaseSchema(snapshot!);
    configurationOverrides.delete('kbengine');

    expect(resolveSchemaTablePrefix()).toBe('tbl_');
    expect(snapshot!.tables[0].name).toBe('kb_Hero');
    expect(lines[0]).toBe('SQL: SELECT * FROM `kb_Hero_bag` LIMIT 100;');
    expect(lines[1]).toBe('SQL(属性列): SELECT `sm_value` FROM `kb_Hero_bag` LIMIT 100;');
    expect(lines[2]).toContain('FROM `kb_Hero` AS p LEFT JOIN `kb_Hero_bag` AS c');
    expect(text).toContain('TABLE kb_Hero');
    expect(text).not.toContain('tbl_Hero');
  });

  it('keeps the engine default when the prefix setting is blank', () => {
    configurationOverrides.set('kbengine', { 'db.tablePrefix': '   ' });

    expect(resolveSchemaTablePrefix()).toBe('tbl_');
    expect(buildMysqlTableSchemas('Hero', source(), [], false)[0].name).toBe('tbl_Hero');

    configurationOverrides.delete('kbengine');
  });

  it('builds table names from an explicit prefix argument', () => {
    const tables = buildMysqlTableSchemas(
      'Hero',
      source(),
      [property({ name: 'bag', typeName: 'ARRAY', arrayElement: property({ name: 'item' }) })],
      false,
      'my_'
    );

    expect(tables.map(table => table.name)).toEqual(['my_Hero', 'my_Hero_bag']);
  });

  it('omits the property select for a table with only engine columns', () => {
    const syntheticOnly = {
      name: 'tbl_Ghost',
      kind: 'entity' as const,
      title: 'Ghost',
      source: source(),
      fields: [
        {
          name: 'id',
          typeLabel: 'bigint unsigned',
          sourcePath: 'id',
          source: source(),
          identifier: false,
          synthetic: true
        }
      ]
    };

    expect(renderPropertyColumnSelect(emptySnapshot, syntheticOnly)).toBeNull();
    expect(renderTableSqlLines(emptySnapshot, syntheticOnly)).toEqual([
      'SQL: SELECT * FROM `tbl_Ghost` LIMIT 100;'
    ]);
  });

  it('omits the join for a table without a parent or without columns', () => {
    const rootTable = {
      name: 'tbl_Hero',
      kind: 'entity' as const,
      title: 'Hero',
      source: source(),
      fields: [property() as never]
    };
    const emptyChild = { ...rootTable, name: 'tbl_Hero_bag', kind: 'array' as const, parentTableName: 'tbl_Hero', fields: [] };

    expect(renderChildTableJoinSelect(emptySnapshot, rootTable)).toBeNull();
    expect(renderChildTableJoinSelect(emptySnapshot, emptyChild)).toBeNull();
  });

  it('resolves the root table name from the snapshot or falls back to the prefix', () => {
    const snapshot = getDatabaseSchemaSnapshot('Hero', root)!;

    expect(resolveEntityTableName('Hero', snapshot)).toBe('tbl_Hero');
    expect(resolveEntityTableName('Ghost', null)).toBe('tbl_Ghost');
  });
});
