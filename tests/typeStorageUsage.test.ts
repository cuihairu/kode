import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  findTypeStorageUsages,
  getDatabaseSchemaSnapshot,
  getTypeStorageShape,
  invalidateTypeStorageUsageIndex
} from '../src/databaseSchema';
import type { TableFieldDescriptor, TypeStorageShape } from '../src/databaseSchema';
import { TypesXmlCodeLensProvider, buildTypesXmlStorageLensSpecs } from '../src/languageProviders';
import { Uri, configurationOverrides, makeTextDocument, workspace as stubWorkspace } from './helpers/vscodeStub';
import type { MinimalTextDocument } from './helpers/vscodeStub';

// 批134:types.xml 类型的落库形态与真实使用处反扫。别名解析与列展开全部
// 走数据库 schema 构建器(单一实现),这里只断言导出面的契约:
// - declaredType 把属性声明的原始 <Type> 文本带到列上(别名未解析形态),
//   反扫按它命中使用处,落点表/列直接取快照(不另造一套落库规则);
// - getTypeStorageShape 给 types.xml 悬停用的形态数据(FIXED_DICT 顶层键 /
//   ARRAY 元素递归一层)。

let root = '';

const write = (relative: string, lines: string[]): void => {
  const target = path.join(root, ...relative.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, lines.join('\n'), 'utf8');
};

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-type-usage-'));

  write('scripts/entities.xml', [
    '<root>',
    '  <Hero hasBase="true"/>',
    // Ghost 只登记没有 def(索引构建的 exists 早退);Broken 的 def 是
    // 非法 XML(索引构建的快照空早退)
    '  <Ghost hasBase="true"/>',
    '  <Broken hasBase="true"/>',
    '</root>'
  ]);

  write('scripts/entity_defs/Broken.def', [
    'not xml at all'
  ]);

  write('scripts/entity_defs/types.xml', [
    '<root>',
    '  <ITEM_ID> UINT16 </ITEM_ID>',
    '  <ITEM_DESC> STRING </ITEM_DESC>',
    // 数组别名条目:指引是文本节点,<of> 与文本同级(of 的文本才是元素类型)
    '  <ITEM_IDS>',
    '    ARRAY',
    '    <of> ITEM_ID </of>',
    '  </ITEM_IDS>',
    // FIXED_DICT 键内数组:<of> 挂在 <Type> 元素内(引擎从 Type 节点找 of)
    '  <SKILL_SLOT>',
    '    FIXED_DICT',
    '    <Properties>',
    '      <slot_list>',
    '        <Type>',
    '          ARRAY',
    '          <of> UINT32 </of>',
    '        </Type>',
    '      </slot_list>',
    '      <count>',
    '        <Type> UINT32 </Type>',
    '      </count>',
    '    </Properties>',
    '  </SKILL_SLOT>',
    '  <BROKEN> NO_SUCH_TYPE </BROKEN>',
    // 反扫空命中场景:没有任何实体属性引用它
    '  <UNUSED> UINT8 </UNUSED>',
    // 别名环:元素类型指回自己,形态展开按 seen 短路
    '  <SELF_LOOP>',
    '    ARRAY',
    '    <of> SELF_LOOP </of>',
    '  </SELF_LOOP>',
    '</root>'
  ]);

  write('scripts/entity_defs/Hero.def', [
    '<root>',
    '  <Properties>',
    '    <hp>',
    '      <Type> UINT32 </Type>',
    '      <Flags> BASE </Flags>',
    '      <Persistent> true </Persistent>',
    '    </hp>',
    '    <itemId>',
    '      <Type> ITEM_ID </Type>',
    '      <Flags> BASE </Flags>',
    '      <Persistent> true </Persistent>',
    '    </itemId>',
    '    <desc>',
    '      <Type> ITEM_DESC </Type>',
    '      <Flags> BASE </Flags>',
    '      <Persistent> true </Persistent>',
    '      <DatabaseLength> 32 </DatabaseLength>',
    '    </desc>',
    '    <items>',
    '      <Type>',
    '        ARRAY',
    '        <of> ITEM_ID </of>',
    '      </Type>',
    '      <Flags> BASE </Flags>',
    '      <Persistent> true </Persistent>',
    '    </items>',
    '    <skills>',
    '      <Type>',
    '        ARRAY',
    '        <of> SKILL_SLOT </of>',
    '      </Type>',
    '      <Flags> BASE </Flags>',
    '      <Persistent> true </Persistent>',
    '    </skills>',
    '  </Properties>',
    '</root>'
  ]);
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const fieldOf = (table: string, field: string): TableFieldDescriptor => {
  const snapshot = getDatabaseSchemaSnapshot('Hero', root)!;
  return snapshot.tableIndex.get(table)!.fields.find(f => f.name === field)!;
};

describe('declaredType plumbing', () => {
  it('carries the raw Type text of properties, keys and array elements', () => {
    expect(fieldOf('tbl_Hero', 'sm_hp').declaredType).toBe('UINT32');
    expect(fieldOf('tbl_Hero', 'sm_itemId').declaredType).toBe('ITEM_ID');
    expect(fieldOf('tbl_Hero', 'sm_desc').declaredType).toBe('ITEM_DESC');
    // 数组元素列:原始元素类型文本(别名不解析)
    expect(fieldOf('tbl_Hero_items', 'sm_value').declaredType).toBe('ITEM_ID');
    // FD 元素键列与键内数组元素列:declaredType 取各自 <Type> 文本
    expect(fieldOf('tbl_Hero_skills', 'sm_count').declaredType).toBe('UINT32');
    expect(fieldOf('tbl_Hero_skills_slot_list', 'sm_value').declaredType).toBe('UINT32');
  });

  it('leaves synthetic engine columns without a declaredType', () => {
    const id = fieldOf('tbl_Hero', 'id');
    expect(id.synthetic).toBe(true);
    expect(id.declaredType).toBeUndefined();
  });
});

describe('findTypeStorageUsages', () => {
  it('maps an alias to every column its declarations land in', () => {
    invalidateTypeStorageUsageIndex();
    const usages = findTypeStorageUsages(root, 'ITEM_ID');

    expect(usages.map(u => `${u.entity}.${u.property} → ${u.table}.${u.column}`).sort()).toEqual([
      'Hero.itemId → tbl_Hero.sm_itemId',
      'Hero.items[] → tbl_Hero_items.sm_value'
    ].sort());
    for (const usage of usages) {
      expect(usage.defFile.endsWith('Hero.def')).toBe(true);
      expect(usage.line).toBeGreaterThan(0);
    }
  });

  it('indexes builtin usages including types.xml declared FD keys', () => {
    invalidateTypeStorageUsageIndex();
    const usages = findTypeStorageUsages(root, 'UINT32');

    expect(usages.map(u => `${u.entity}.${u.property} → ${u.table}.${u.column}`).sort()).toEqual([
      'Hero.hp → tbl_Hero.sm_hp',
      // SKILL_SLOT.count 键声明在 types.xml,落点列随实体属性 skills 落子表
      'Hero.skills[].count → tbl_Hero_skills.sm_count',
      'Hero.skills[].slot_list[] → tbl_Hero_skills_slot_list.sm_value'
    ].sort());
    // 键声明处 defFile 指回 types.xml
    const keyUsage = usages.find(u => u.column === 'sm_count')!;
    expect(keyUsage.defFile.endsWith('types.xml')).toBe(true);
  });

  it('maps a string alias to the column it lands in', () => {
    invalidateTypeStorageUsageIndex();
    expect(findTypeStorageUsages(root, 'ITEM_DESC').map(u => `${u.entity}.${u.property} → ${u.table}.${u.column}`))
      .toEqual(['Hero.desc → tbl_Hero.sm_desc']);
  });

  it('returns an empty list for types nothing uses', () => {
    invalidateTypeStorageUsageIndex();
    expect(findTypeStorageUsages(root, 'UNUSED')).toEqual([]);
  });
});

describe('getTypeStorageShape', () => {
  // 路径必须在用例内取:describe 体在收集期执行,那时 root 还是空串
  const typesXmlPath = (): string => path.join(root, 'scripts/entity_defs/types.xml');

  it('describes builtin aliases with their effective column type', () => {
    expect(getTypeStorageShape(typesXmlPath(), 'ITEM_ID')).toEqual({
      kind: 'builtin',
      rawType: 'ITEM_ID',
      typeName: 'UINT16',
      columnType: 'smallint unsigned'
    });
  });

  it('describes fixed dict aliases with their top level keys', () => {
    const shape = getTypeStorageShape(typesXmlPath(), 'SKILL_SLOT') as Extract<TypeStorageShape, { kind: 'fixedDict' }>;

    expect(shape.kind).toBe('fixedDict');
    expect(shape.topLevelKeys).toEqual(['slot_list', 'count']);
  });

  it('describes array aliases with the element shape one level deep', () => {
    const shape = getTypeStorageShape(typesXmlPath(), 'ITEM_IDS') as Extract<TypeStorageShape, { kind: 'array' }>;

    expect(shape.kind).toBe('array');
    expect(shape.element!.kind).toBe('builtin');
    expect(shape.element!.rawType).toBe('ITEM_ID');
  });

  it('marks unresolved aliases and unknown names', () => {
    expect(getTypeStorageShape(typesXmlPath(), 'BROKEN').kind).toBe('unresolved');
    expect(getTypeStorageShape(typesXmlPath(), 'TOTALLY_UNKNOWN').kind).toBe('unresolved');
    // 无 types.xml 时一切类型都无从谈起
    expect(getTypeStorageShape(null, 'ITEM_ID').kind).toBe('unresolved');
  });

  it('cuts alias cycles in array elements back to unresolved', () => {
    const shape = getTypeStorageShape(typesXmlPath(), 'SELF_LOOP') as Extract<TypeStorageShape, { kind: 'array' }>;

    expect(shape.kind).toBe('array');
    expect(shape.element!.kind).toBe('unresolved');
  });
});

const typesXmlContent = (): string =>
  fs.readFileSync(path.join(root, 'scripts/entity_defs/types.xml'), 'utf8');

describe('buildTypesXmlStorageLensSpecs', () => {
  it('puts one lens per real usage on the declaration name', () => {
    invalidateTypeStorageUsageIndex();
    const specs = buildTypesXmlStorageLensSpecs(typesXmlContent(), root);
    // 原类型引用镜 + FIXED_DICT 键展开列镜;内建类型与无引用类型不出镜。
    expect(specs).toHaveLength(5);
    const itemIdSpec = specs.find(spec => spec.title === 'Hero.itemId → tbl_Hero.sm_itemId')!;
    expect(itemIdSpec.line).toBe(1);
    expect(itemIdSpec.character).toBe(3);
    expect(itemIdSpec.target).toEqual({ entity: 'Hero', table: 'tbl_Hero', column: 'sm_itemId' });
    expect(specs.find(spec => spec.title === 'Hero.items[] → tbl_Hero_items.sm_value')!.line).toBe(1);
    expect(specs).toContainEqual(expect.objectContaining({
      title: '字段 · Hero.skills[].count → tbl_Hero_skills.sm_count',
      target: { entity: 'Hero', table: 'tbl_Hero_skills', column: 'sm_count' }
    }));
    expect(specs).toContainEqual(expect.objectContaining({
      title: '字段 · Hero.skills[].slot_list[] → tbl_Hero_skills_slot_list.sm_value',
      target: { entity: 'Hero', table: 'tbl_Hero_skills_slot_list', column: 'sm_value' }
    }));
  });

  it('returns nothing for content without a root element', () => {
    expect(buildTypesXmlStorageLensSpecs('plain text', root)).toEqual([]);
  });

  it('folds usages beyond the limit into a count lens', () => {
    // 11 个同类型属性把 ITEM_ID 的使用从 2 处抬到 13 处
    const properties: string[] = [];
    for (let index = 0; index < 11; index += 1) {
      properties.push([
        `    <slot${index}>`,
        '      <Type> ITEM_ID </Type>',
        '      <Flags> BASE </Flags>',
        '      <Persistent> true </Persistent>',
        `    </slot${index}>`
      ].join('\n'));
    }
    fs.writeFileSync(path.join(root, 'scripts/entity_defs/Villain.def'), [
      '<root>',
      '  <Properties>',
      ...properties,
      '  </Properties>',
      '</root>'
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(root, 'scripts/entities.xml'), [
      '<root>',
      '  <Hero hasBase="true"/>',
      '  <Villain hasBase="true"/>',
      '</root>'
    ].join('\n'), 'utf8');

    invalidateTypeStorageUsageIndex();
    const specs = buildTypesXmlStorageLensSpecs(typesXmlContent(), root);
    const itemSpecs = specs.filter(spec => spec.target && (spec.title.includes('Hero.itemId')
      || spec.title.includes('Hero.items[]') || spec.title.includes('Villain.slot')));

    expect(itemSpecs).toHaveLength(10);
    const summary = specs.find(spec => spec.target === null)!;
    expect(summary.title).toBe('+3 处落库未列出');
    expect(summary.line).toBe(1);
    expect(summary.character).toBe(3);
  });
});

interface FakeWatcher {
  pattern: string;
  disposeCalls: number;
  onDidChange(listener: () => void): { dispose(): void };
  onDidCreate(listener: () => void): { dispose(): void };
  onDidDelete(listener: () => void): { dispose(): void };
  dispose(): void;
  fireChange(): void;
  fireCreate(): void;
  fireDelete(): void;
}

const makeFakeWatcher = (pattern: string): FakeWatcher => {
  const changeListeners: Array<() => void> = [];
  const createListeners: Array<() => void> = [];
  const deleteListeners: Array<() => void> = [];
  const fire = (listeners: Array<() => void>): void => {
    for (const listener of [...listeners]) {
      listener();
    }
  };
  const watcher: FakeWatcher = {
    pattern,
    disposeCalls: 0,
    onDidChange(listener) {
      changeListeners.push(listener);
      return { dispose: () => void changeListeners.splice(changeListeners.indexOf(listener), 1) };
    },
    onDidCreate(listener) {
      createListeners.push(listener);
      return { dispose: () => void createListeners.splice(createListeners.indexOf(listener), 1) };
    },
    onDidDelete(listener) {
      deleteListeners.push(listener);
      return { dispose: () => void deleteListeners.splice(deleteListeners.indexOf(listener), 1) };
    },
    dispose(): void {
      watcher.disposeCalls += 1;
      changeListeners.length = 0;
      createListeners.length = 0;
      deleteListeners.length = 0;
    },
    fireChange: () => fire(changeListeners),
    fireCreate: () => fire(createListeners),
    fireDelete: () => fire(deleteListeners)
  };
  return watcher;
};

describe('TypesXmlCodeLensProvider', () => {
  const watchers: FakeWatcher[] = [];
  const originalCreate = stubWorkspace.createFileSystemWatcher;

  beforeAll(() => {
    (stubWorkspace as unknown as Record<string, unknown>).createFileSystemWatcher = (pattern: unknown) => {
      const watcher = makeFakeWatcher(String(pattern));
      watchers.push(watcher);
      return watcher;
    };
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
  });

  afterAll(() => {
    (stubWorkspace as unknown as Record<string, unknown>).createFileSystemWatcher = originalCreate;
    stubWorkspace.workspaceFolders = [];
    fs.rmSync(path.join(root, 'scripts/entity_defs/Villain.def'), { force: true });
    fs.writeFileSync(path.join(root, 'scripts/entities.xml'), '<root>\n  <Hero hasBase="true"/>\n</root>\n', 'utf8');
    invalidateTypeStorageUsageIndex();
  });

  const providerDocument = (): MinimalTextDocument => makeTextDocument(typesXmlContent(), {
    fileName: path.join(root, 'scripts/entity_defs/types.xml'),
    languageId: 'xml'
  });

  it('watches def, types.xml and entities.xml patterns', () => {
    watchers.length = 0;
    const provider = new TypesXmlCodeLensProvider();

    expect(watchers.map(watcher => watcher.pattern)).toEqual(['**/*.def', '**/types.xml', '**/entities.xml']);
    provider.dispose();
    expect(watchers.every(watcher => watcher.disposeCalls === 1)).toBe(true);
  });

  it('codeLens.typesXml 关闭时整类不出镜,默认开启不受影响(批154)', () => {
    invalidateTypeStorageUsageIndex();
    const provider = new TypesXmlCodeLensProvider();

    // 正对照:默认开启时声明行出落库镜
    expect(provider.provideCodeLenses(providerDocument()).length).toBeGreaterThan(0);

    configurationOverrides.set('kbengine', { 'codeLens.typesXml': false });
    try {
      expect(provider.provideCodeLenses(providerDocument())).toEqual([]);
    } finally {
      configurationOverrides.delete('kbengine');
      provider.dispose();
    }
  });

  it('attaches a schema open command to every usage lens', () => {
    invalidateTypeStorageUsageIndex();
    const provider = new TypesXmlCodeLensProvider();
    const lenses = provider.provideCodeLenses(providerDocument()) as Array<{
      range: { start: { line: number; character: number } };
      command?: { command: string; arguments: unknown[] };
    }>;

    const itemIdLens = lenses.find(lens => (lens.command?.arguments?.[2]) === 'sm_itemId')!;
    expect(itemIdLens.command!.command).toBe('kbengine.database.open');
    expect(itemIdLens.command!.arguments).toEqual(['Hero', 'tbl_Hero', 'sm_itemId']);
    expect(itemIdLens.range.start).toEqual({ line: 1, character: 3 });
    const expandedFieldLens = lenses.find(lens => lens.command?.title.includes('skills[].count'))!;
    expect(expandedFieldLens.command!.arguments).toEqual(['Hero', 'tbl_Hero_skills', 'sm_count']);
    provider.dispose();
  });

  it('renders the overflow count lens without a command', () => {
    // Villain.def(11 个 ITEM_ID 属性)由 builder 溢出用例写入,这里沿用;
    // 计数镜是无命令的惰性镜,标题断言在 builder 用例里
    invalidateTypeStorageUsageIndex();
    const provider = new TypesXmlCodeLensProvider();
    const lenses = provider.provideCodeLenses(providerDocument()) as Array<{
      command?: { title: string };
    }>;

    expect(lenses.filter(lens => !lens.command)).toHaveLength(1);
    const titles = lenses.map(lens => lens.command?.title);
    expect(titles).toContain('Hero.itemId → tbl_Hero.sm_itemId');
    expect(titles).toContain('Villain.slot0 → tbl_Villain.sm_slot0');
    expect(titles.filter(title => title?.includes('Villain.slot'))).toHaveLength(8);
    provider.dispose();
  });

  it('returns no lenses outside a workspace', () => {
    const folders = stubWorkspace.workspaceFolders;
    (stubWorkspace as unknown as Record<string, unknown>).workspaceFolders = undefined;
    try {
      const provider = new TypesXmlCodeLensProvider();
      expect(provider.provideCodeLenses(providerDocument())).toEqual([]);
      provider.dispose();
    } finally {
      stubWorkspace.workspaceFolders = folders;
    }
  });

  it('invalidates the usage index when watched files change', () => {
    // 先清掉溢出用例的 Villain,再改 Hero.def:watcher 回调失效索引后
    // 重建可见——ITEM_ID 的使用只剩数组元素列
    fs.rmSync(path.join(root, 'scripts/entity_defs/Villain.def'), { force: true });
    fs.writeFileSync(path.join(root, 'scripts/entities.xml'), '<root>\n  <Hero hasBase="true"/>\n</root>\n', 'utf8');
    fs.writeFileSync(path.join(root, 'scripts/entity_defs/Hero.def'), [
      '<root>',
      '  <Properties>',
      '    <items>',
      '      <Type>',
      '        ARRAY',
      '        <of> ITEM_ID </of>',
      '      </Type>',
      '      <Flags> BASE </Flags>',
      '      <Persistent> true </Persistent>',
      '    </items>',
      '  </Properties>',
      '</root>'
    ].join('\n'), 'utf8');

    watchers.length = 0;
    const provider = new TypesXmlCodeLensProvider();
    let fired = 0;
    provider.onDidChangeCodeLenses(() => {
      fired += 1;
    });

    for (const watcher of watchers) {
      watcher.fireChange();
      watcher.fireCreate();
      watcher.fireDelete();
    }
    expect(fired).toBe(9);

    watchers[0].fireChange();
    const usages = findTypeStorageUsages(root, 'ITEM_ID').map(u => `${u.entity}.${u.property}`);
    expect(usages).toEqual(['Hero.items[]']);
    provider.dispose();
  });

  it('stops reacting after dispose', () => {
    watchers.length = 0;
    const provider = new TypesXmlCodeLensProvider();
    provider.dispose();

    expect(() => {
      for (const watcher of watchers) {
        watcher.fireChange();
      }
    }).not.toThrow();
  });
});
