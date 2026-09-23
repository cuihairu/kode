import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createDefinitionSemanticsLoader,
  normalizeLookupPath,
  parseLocalDefinition
} from '../src/definitionSemantics';

// 行号与 def 内容一一对应,断言全部基于这些行号(1 基)
const HERO_DEF = [
  '<root>',                                     // 1
  '  <Interfaces>',                             // 2
  '    <MoveIface/>',                           // 3
  '  </Interfaces>',                            // 4
  '  <Components>',                             // 5
  '    <healthPack>',                           // 6
  '      <Type>HealthComp</Type>',              // 7
  '    </healthPack>',                          // 8
  '  </Components>',                            // 9
  '  <Properties>',                             // 10
  '    <hp>',                                   // 11
  '      <Type>UINT32</Type>',                  // 12
  '      <Flags>BASE_AND_CLIENT</Flags>',       // 13
  '      <Persistent>false</Persistent>',       // 14
  '      <Identifier/>',                        // 15
  '      <Default>100</Default>',               // 16
  '    </hp>',                                  // 17
  '    <bag>',                                  // 18
  '      <Type>',                               // 19
  '        ARRAY',                              // 20
  '        <of>UINT32</of>',                    // 21
  '      </Type>',                              // 22
  '      <Flags>CELL_PUBLIC</Flags>',           // 23
  '    </bag>',                                 // 24
  '    <speed>',                                // 25
  '      <Type>UINT32</Type>',                  // 26
  '      <Flags>CELL_PUBLIC</Flags>',           // 27
  '    </speed>',                               // 28
  '  </Properties>',                            // 29
  '  <BaseMethods>',                            // 30
  '    <attack>',                               // 31
  '      <Arg>UINT32</Arg>',                    // 32
  '      <Exposed/>',                           // 33
  '    </attack>',                              // 34
  '  </BaseMethods>',                           // 35
  '</root>'                                     // 36
].join('\n');

const MOVE_IFACE_DEF = [
  '<root>',                                     // 1
  '  <Properties>',                             // 2
  '    <speed>',                                // 3
  '      <Type>UINT32</Type>',                  // 4
  '      <Flags>CELL_PUBLIC</Flags>',           // 5
  '    </speed>',                               // 6
  '  </Properties>',                            // 7
  '  <CellMethods>',                            // 8
  '    <dash>',                                 // 9
  '      <Exposed/>',                           // 10
  '    </dash>',                                // 11
  '  </CellMethods>',                           // 12
  '</root>'                                     // 13
].join('\n');

const MONSTER_DEF = [
  '<root>',                                     // 1
  '  <Parent>Hero</Parent>',                    // 2
  '  <Properties>',                             // 3
  '    <ferocity>',                             // 4
  '      <Type>UINT32</Type>',                  // 5
  '    </ferocity>',                            // 6
  '  </Properties>',                            // 7
  '</root>'                                     // 8
].join('\n');

const HEALTH_COMP_DEF = [
  '<root>',                                     // 1
  '  <Properties>',                             // 2
  '    <regen>',                                // 3
  '      <Type>UINT32</Type>',                  // 4
  '    </regen>',                               // 5
  '  </Properties>',                            // 6
  '</root>'                                     // 7
].join('\n');

const FILES: Array<[string, string]> = [
  ['scripts/entity_defs/Hero.def', HERO_DEF],
  ['scripts/entity_defs/Monster.def', MONSTER_DEF],
  ['scripts/entity_defs/interfaces/MoveIface.def', MOVE_IFACE_DEF],
  ['scripts/entity_defs/components/HealthComp.def', HEALTH_COMP_DEF]
];

let root = '';

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-semantics-'));
  for (const [relative, content] of FILES) {
    const absolute = path.join(root, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content, 'utf8');
  }
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('normalizeLookupPath', () => {
  it('normalizes separators and case for cache keys', () => {
    expect(normalizeLookupPath('C:\\Work\\Hero.Def')).toBe('c:/work/hero.def');
    expect(normalizeLookupPath('/tmp/X.def')).toBe('/tmp/x.def');
  });
});

describe('parseLocalDefinition', () => {
  const semantics = parseLocalDefinition(HERO_DEF, 'entity', 'Hero', '/tmp/Hero.def');

  it('parses properties with def metadata and nested structure', () => {
    expect(semantics.properties.map(property => property.name)).toEqual(['hp', 'bag', 'speed']);

    const hp = semantics.properties[0];
    expect(hp.fullPath).toBe('hp');
    expect(hp.line).toBe(11);
    expect(hp.typeName).toBe('UINT32');
    expect(hp.flags).toBe('BASE_AND_CLIENT');
    expect(hp.persistent).toBe(false);
    expect(hp.identifier).toBe(true);
    expect(hp.defaultValue).toBe('100');
    expect(hp.source.kind).toBe('local');

    const bag = semantics.properties[1];
    expect(bag.arrayElement).toBeDefined();
    expect(bag.arrayElement!.typeName).toBe('UINT32');
    expect(bag.arrayElement!.fullPath).toBe('bag[]');
  });

  it('parses interfaces, components, parent and methods with sections', () => {
    expect(semantics.interfaces).toEqual([{ name: 'MoveIface', line: 3 }]);
    expect(semantics.components).toHaveLength(1);
    expect(semantics.components[0]).toMatchObject({
      slotName: 'healthPack',
      typeName: 'HealthComp'
    });
    expect(semantics.components[0].line).toBe(6);

    expect(semantics.parentName).toBeUndefined();
    expect(semantics.methods).toHaveLength(1);
    expect(semantics.methods[0]).toMatchObject({
      name: 'attack',
      section: 'BaseMethods',
      exposed: true,
      args: ['UINT32'],
      line: 31
    });
    expect(semantics.methodsBySection.BaseMethods).toHaveLength(1);
    expect(semantics.methodsBySection.CellMethods).toHaveLength(0);
  });

  it('returns empty records for a def without a root element', () => {
    const empty = parseLocalDefinition('not xml', 'entity', 'Broken', '/tmp/Broken.def');

    expect(empty.owner.name).toBe('Broken');
    expect(empty.properties).toEqual([]);
    expect(empty.methods).toEqual([]);
    expect(empty.interfaces).toEqual([]);
    expect(empty.components).toEqual([]);
  });
});

describe('DefinitionSemanticsLoader local lookup', () => {
  it('finds entity/interface/component defs by category under the workspace root', () => {
    const loader = createDefinitionSemanticsLoader(root)!;

    const hero = loader.loadLocal('Hero', 'entity');
    expect(hero?.owner.filePath).toBe(path.join(root, 'scripts/entity_defs/Hero.def'));
    expect(hero?.interfaces[0].name).toBe('MoveIface');

    expect(loader.loadLocal('MoveIface', 'interface')?.properties[0].name).toBe('speed');
    expect(loader.loadLocal('HealthComp', 'component')?.properties[0].name).toBe('regen');

    expect(loader.loadLocal('Missing', 'entity')).toBeNull();
  });

  it('caches hits and misses by identity', () => {
    const loader = createDefinitionSemanticsLoader(root)!;

    expect(loader.loadLocal('Hero', 'entity')).toBe(loader.loadLocal('Hero', 'entity'));
    expect(loader.loadLocal('Nope', 'entity')).toBeNull();
    expect(loader.loadLocal('Nope', 'entity')).toBeNull();
  });
});

describe('DefinitionSemanticsLoader resolution across inheritance', () => {
  it('merges interface members with source chains and keeps local overrides', () => {
    const loader = createDefinitionSemanticsLoader(root)!;
    const resolved = loader.loadResolved('Hero', 'entity');

    expect(resolved).not.toBeNull();
    expect(resolved!.inheritanceGroups).toHaveLength(1);

    const mixin = resolved!.inheritanceGroups[0];
    expect(mixin.owner.name).toBe('MoveIface');
    expect(mixin.label).toContain('MoveIface');
    expect(mixin.methodsBySection.CellMethods.map(method => method.name)).toEqual(['dash']);

    const effectiveNames = resolved!.effectiveProperties.map(property => property.name);
    expect(effectiveNames).toEqual(['hp', 'bag', 'speed']);

    // 本地 speed 覆盖接口同名属性:来源必须是 local,声明在 Hero.def 第 25 行
    const speed = resolved!.effectiveProperties[2];
    expect(speed.source.kind).toBe('local');
    expect(speed.line).toBe(25);

    // 继承组内的同名属性标注 interface 来源
    const mixinSpeed = mixin.properties[0];
    expect(mixinSpeed.source.kind).toBe('interface');
    expect(mixinSpeed.source.chain).toContain('MoveIface');

    // 有效方法 = 本地 + 接口
    const baseNames = resolved!.effectiveMethodsBySection.BaseMethods.map(m => m.name);
    const cellNames = resolved!.effectiveMethodsBySection.CellMethods.map(m => m.name);
    expect(baseNames).toEqual(['attack']);
    expect(cellNames).toEqual(['dash']);
  });

  it('resolves parent chains and component slots recursively', () => {
    const loader = createDefinitionSemanticsLoader(root)!;
    const monster = loader.loadResolved('Monster', 'entity');

    expect(monster!.parentName).toBe('Hero');
    const parentGroup = monster!.inheritanceGroups.find(group => group.owner.name === 'Hero');
    expect(parentGroup).toBeDefined();
    // 父类组的属性包含 Hero 的接口合并结果
    expect(parentGroup!.properties.map(property => property.name)).toEqual(
      expect.arrayContaining(['hp', 'speed'])
    );

    const hero = loader.loadResolved('Hero', 'entity');
    expect(hero!.components).toHaveLength(1);
    expect(hero!.components[0].slotName).toBe('healthPack');
    expect(hero!.components[0].resolved!.effectiveProperties[0].name).toBe('regen');
  });

  it('supports component-free resolution mode', () => {
    const loader = createDefinitionSemanticsLoader(root)!;
    const hero = loader.loadResolved('Hero', 'entity', false);

    expect(hero!.components).toHaveLength(0);
    expect(hero!.effectiveProperties.map(property => property.name)).toEqual(
      ['hp', 'bag', 'speed']
    );
  });

  it('survives parent inheritance cycles', () => {
    const cycleRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-cycle-'));
    try {
      for (const [name, parent] of [['A', 'B'], ['B', 'A']] as const) {
        const file = path.join(cycleRoot, 'scripts/entity_defs', `${name}.def`);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, `<root><Parent>${parent}</Parent></root>`, 'utf8');
      }

      const loader = createDefinitionSemanticsLoader(cycleRoot)!;
      expect(() => loader.loadResolved('A', 'entity')).not.toThrow();
      expect(loader.loadResolved('A', 'entity')!.owner.name).toBe('A');
    } finally {
      fs.rmSync(cycleRoot, { recursive: true, force: true });
    }
  });

  it('returns null from the factory when no workspace root is available', () => {
    // 无 vscode 工作区上下文且未显式传根时,工厂返回 null
    expect(createDefinitionSemanticsLoader()).toBeNull();
  });
});

describe('definition semantics corner cases and clone propagation', () => {
  // 第二夹具:覆盖节点值式接口引用、重复/空组件槽、嵌套 Properties、
  // 接口带组件与父接口(嵌套 Mixin)、组件 Parent 链、空文件与同名目录降级。
  const HERO2_DEF = [
    '<root>',                                                        // 1
    '  <Interfaces>',                                                // 2
    '    <Interface>MoveIface2</Interface>',                         // 3
    '    <Interface>GhostIface</Interface>',                         // 4
    '    <Type>MoveIfaceBase</Type>',                                // 5
    '  </Interfaces>',                                               // 6
    '  <Components>',                                                // 6
    '    <healthPack>',                                              // 7
    '      <Type>HealthComp2</Type>',                                // 8
    '    </healthPack>',                                             // 9
    '    <healthPack>',                                              // 10
    '      <Type>HealthComp2</Type>',                                // 11
    '    </healthPack>',                                             // 12
    '    <emptySlot></emptySlot>',                                   // 13
    '  </Components>',                                               // 14
    '  <Properties>',                                                // 15
    '    <hp>',                                                      // 16
    '      <Type>UINT32</Type>',                                     // 17
    '      <Identifier>true</Identifier>',                           // 18
    '    </hp>',                                                     // 19
    '    <meta>',                                                    // 20
    '      <Type>UINT32</Type>',                                     // 21
    '      <Properties>',                                            // 22
    '        <weight>',                                              // 23
    '          <Type>UINT8</Type>',                                  // 24
    '        </weight>',                                             // 25
    '      </Properties>',                                           // 26
    '    </meta>',                                                   // 27
    '  </Properties>',                                               // 28
    '  <BaseMethods>',                                               // 29
    '    <attack><Arg>INT8</Arg></attack>',                          // 30
    '  </BaseMethods>',                                              // 31
    '</root>'                                                        // 32
  ].join('\n');

  const MOVE_IFACE2_DEF = [
    '<root>',
    '  <Parent>MoveIfaceBase</Parent>',
    '  <Properties>',
    '    <bag>',
    '      <Type>',
    '        ARRAY',
    '        <of>UINT32</of>',
    '      </Type>',
    '    </bag>',
    '  </Properties>',
    '  <Components>',
    '    <svc>',
    '      <Type>HealthComp2</Type>',
    '    </svc>',
    '  </Components>',
    '  <CellMethods>',
    '    <dash><Exposed/></dash>',
    '  </CellMethods>',
    '</root>'
  ].join('\n');

  const MOVE_IFACE_BASE_DEF = '<root><Properties><baseProp><Type>UINT8</Type></baseProp></Properties></root>';
  const HEALTH_COMP2_DEF = '<root><Parent>CompBase</Parent><Properties><regen><Type>UINT8</Type></regen></Properties></root>';
  const COMP_BASE_DEF = '<root><Properties><baseCharge><Type>UINT8</Type></baseCharge></Properties></root>';

  const FILES2: Array<[string, string]> = [
    ['scripts/entity_defs/Hero2.def', HERO2_DEF],
    // 接口的 <Parent> 按 entity 类别查找(parentCategory 分支),须落 entity 目录
    ['scripts/entity_defs/MoveIfaceBase.def', MOVE_IFACE_BASE_DEF],
    ['scripts/entity_defs/interfaces/MoveIface2.def', MOVE_IFACE2_DEF],
    ['scripts/entity_defs/components/HealthComp2.def', HEALTH_COMP2_DEF],
    ['scripts/entity_defs/components/CompBase.def', COMP_BASE_DEF],
    ['scripts/entity_defs/Empty.def', '']
  ];

  let root2 = '';

  beforeAll(() => {
    root2 = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-semantics2-'));
    for (const [relative, content] of FILES2) {
      const absolute = path.join(root2, relative);
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, content, 'utf8');
    }
    // 同名目录:fs.readFileSync(EISDIR) 抛出 → 读取降级 catch 分支
    fs.mkdirSync(path.join(root2, 'scripts/entity_defs/NoRead.def'));
  });

  afterAll(() => {
    fs.rmSync(root2, { recursive: true, force: true });
  });

  it('degrades empty files and unreadable paths to cached nulls', () => {
    const loader = createDefinitionSemanticsLoader(root2)!;

    expect(loader.loadLocal('Empty', 'entity')).toBeNull();
    // 空文件内容同样写入负缓存
    expect(loader.loadLocal('Empty', 'entity')).toBeNull();
    // 同名目录触发 EISDIR,读取 catch 分支返回 null
    expect(loader.loadLocal('NoRead', 'entity')).toBeNull();
    // resolved 负缓存同样命中
    expect(loader.loadResolved('Nope2', 'entity')).toBeNull();
    expect(loader.loadResolved('Nope2', 'entity')).toBeNull();
  });

  it('parses node-value interface refs and dedupes component slots', () => {
    const loader = createDefinitionSemanticsLoader(root2)!;
    const hero2 = loader.loadLocal('Hero2', 'entity')!;

    // 节点值形式 <Interface>Name</Interface> 与自闭合 <MoveIface/> 等价,
    // <Type>Name</Type> 同样被接受
    expect(hero2.interfaces.map(ref => ref.name)).toEqual([
      'MoveIface2',
      'GhostIface',
      'MoveIfaceBase'
    ]);
    // 本地解析阶段即丢弃无 Type 的空槽,同名槽保留待 resolved 去重
    expect(hero2.components.map(slot => slot.slotName)).toEqual(['healthPack', 'healthPack']);

    const hp = hero2.properties[0];
    expect(hp.identifier).toBe(true);
    // 嵌套 <Properties> 递归为 children
    expect(hp.name).toBe('hp');
    const meta = hero2.properties[1];
    expect(meta.children.map(child => child.name)).toEqual(['weight']);

    const resolved = loader.loadResolved('Hero2', 'entity')!;
    expect(loader.loadResolved('Hero2', 'entity')).toBe(resolved); // resolved 缓存命中
    // resolved 阶段:同名槽去重 + 空 Type 槽剔除 + 接口引入的 svc 槽
    expect(resolved.components.map(slot => slot.slotName)).toEqual(['healthPack', 'svc']);
    // 未解析的接口(GhostIface 无 def)不产生继承组,父接口产生嵌套组
    expect(resolved.inheritanceGroups.map(group => group.owner.name)).toEqual([
      'MoveIface2',
      'MoveIfaceBase'
    ]);
  });

  it('propagates cloned sources for array elements, methods and nested mixins', () => {
    const loader = createDefinitionSemanticsLoader(root2)!;
    const resolved = loader.loadResolved('Hero2', 'entity')!;

    const mixin = resolved.inheritanceGroups[0];
    // 接口属性 bag(ARRAY)克隆保留 arrayElement
    const bag = mixin.properties.find(property => property.name === 'bag')!;
    expect(bag.arrayElement!.typeName).toBe('UINT32');
    expect(bag.source.kind).toBe('interface');
    expect(bag.source.chain).toContain('MoveIface2');
    // 接口方法段的克隆
    expect(mixin.methodsBySection.CellMethods.map(method => method.name)).toEqual(['dash']);
    // 父接口组(Mixin 链)带 baseProp
    const base = resolved.inheritanceGroups[1];
    expect(base.properties.map(property => property.name)).toEqual(['baseProp']);
    expect(base.label).toContain('MoveIfaceBase');

    // 组件槽递归解析其 Parent 链(HealthComp2 → CompBase)
    const healthPack = resolved.components.find(slot => slot.slotName === 'healthPack')!;
    expect(healthPack.resolved!.parentName).toBe('CompBase');
    const parentGroup = healthPack.resolved!.inheritanceGroups[0];
    expect(parentGroup.owner.name).toBe('CompBase');
    expect(parentGroup.properties[0].name).toBe('baseCharge');
  });

  it('interprets truthy identifier spellings as the engine wire values', () => {
    const spellings: Array<[string, boolean | undefined]> = [
      ['true', true],
      ['1', true],
      ['yes', true],
      ['false', false],
      ['0', false],
      ['no', false],
      // 未知拼写严格回落 false(布尔解析无 undefined 语义)
      ['maybe', false]
    ];

    for (const [word, expected] of spellings) {
      const content = `<root><Properties><p><Type>UINT8</Type><Identifier>${word}</Identifier></p></Properties></root>`;
      const parsed = parseLocalDefinition(content, 'entity', 'P', '/tmp/P.def');
      expect(parsed.properties[0].identifier, `Identifier=${word}`).toBe(expected);
    }

    // Default 是原样字符串,不走数值归一;数值归一只作用于 DatabaseLength
    const withBadDefault = parseLocalDefinition(
      '<root><Properties><p><Type>UINT8</Type><Default>abc</Default><DatabaseLength>notnum</DatabaseLength></p></Properties></root>',
      'entity',
      'P',
      '/tmp/P.def'
    );
    expect(withBadDefault.properties[0].defaultValue).toBe('abc');
    expect(withBadDefault.properties[0].databaseLength).toBeUndefined();

    const withGoodLength = parseLocalDefinition(
      '<root><Properties><p><Type>UINT8</Type><DatabaseLength>128</DatabaseLength></p></Properties></root>',
      'entity',
      'P',
      '/tmp/P.def'
    );
    expect(withGoodLength.properties[0].databaseLength).toBe(128);
  });
});
