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
