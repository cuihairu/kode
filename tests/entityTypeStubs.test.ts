import { describe, expect, it } from 'vitest';
import { buildEntityTypeStubPlan } from '../src/entityTypeStubs';
import type { CustomTypeInfo } from '../src/definitionWorkspace';
import type { EntityMapping } from '../src/entityMapping';

const customType: CustomTypeInfo = {
  name: 'ITEM_INFO',
  filePath: '/ws/scripts/entity_defs/types.xml',
  line: 8,
  implementedByLine: 8,
  startOffset: 0,
  endOffset: 1,
  aliasType: 'FIXED_DICT',
  rawValue: 'FIXED_DICT',
  structure: { name: 'FIXED_DICT', rawValue: 'FIXED_DICT', children: [], line: 8 },
  properties: [{ name: 'ownerId', typeName: 'PLAYER_ID', line: 9, typeLine: 10 }]
};

const avatarMapping = {
  name: 'Avatar',
  defFile: '/ws/scripts/entity_defs/Avatar.def',
  pythonFile: '/ws/scripts/entity/Avatar.py',
  pythonFiles: ['/ws/scripts/entity/Avatar.py'],
  properties: {
    profile: { defFile: '/ws/scripts/entity_defs/Avatar.def', line: 24 }
  },
  methods: {},
  propertyDefinitions: [{
    defFile: '/ws/scripts/entity_defs/Avatar.def',
    line: 24,
    identity: { symbolName: 'profile' },
    domains: [],
    persistent: false,
    typeName: 'ITEM_INFO'
  }]
} as unknown as EntityMapping;

const guardMapping = {
  name: 'Guard',
  defFile: '/ws/scripts/entity_defs/Guard.def',
  pythonFile: '/ws/scripts/cell/Guard.py',
  pythonFiles: ['/ws/scripts/cell/Guard.py'],
  properties: {},
  methods: {
    respawn: [{
      defFile: '/ws/scripts/entity_defs/Guard.def',
      line: 17,
      section: 'CellMethods',
      exposed: true,
      declaredArgs: ['UINT32']
    }]
  }
} as unknown as EntityMapping;

describe('buildEntityTypeStubPlan', () => {
  it('creates per-entity declarations for custom .def property types', () => {
    const plan = buildEntityTypeStubPlan([avatarMapping], [customType]);
    expect(plan.entries).toEqual([{
      entity: 'Avatar',
      properties: [{
        name: 'profile',
        annotation: 'ITEM_INFO',
        customTypeLine: 8,
        sourceLine: 24
      }],
      methods: []
    }]);
    expect(plan.content).toContain('class Avatar(Entity):');
    expect(plan.content).toContain('# source: .def:24 -> types.xml:8');
    expect(plan.content).toContain('    profile: ITEM_INFO');
    // 继承面(pyi ④ 任务1):基类来自 KBEngine 存根;纯属性实体不带
    // EntityCall(只导注解面真实引用到的名字)
    expect(plan.content).toContain('from KBEngine import Entity');
    expect(plan.content).not.toContain('EntityCall');
  });

  it('adds per-section methods and built-in argument annotations', () => {
    const plan = buildEntityTypeStubPlan([guardMapping], []);
    expect(plan.entries).toEqual([{
      entity: 'Guard',
      properties: [],
      methods: [{
        name: 'respawn',
        args: ['UINT32'],
        section: 'CellMethods',
        exposed: true,
        sourceLine: 17
      }]
    }]);
    expect(plan.content).toContain('class Guard(Entity):');
    expect(plan.content).toContain('# source: .def:17 (CellMethods)');
    expect(plan.content).toContain('def respawn(arg1: int) -> None: ...');
    // mailbox 面(pyi ④ 任务1):方法面实体配 <Entity>MB(EntityCall) 句柄,
    // 实体类 base/cell/client 按本实体 MB 收窄,KBEngine 导入带 EntityCall
    expect(plan.content).toContain('class GuardMB(EntityCall):');
    expect(plan.content).toContain('    base: Union[GuardMB, None]');
    expect(plan.content).toContain('    cell: Union[GuardMB, None]');
    expect(plan.content).toContain('    client: Union[GuardMB, None]');
    expect(plan.content).toContain('from KBEngine import Entity, EntityCall');
  });

  it('imports referenced custom types from their kbe_types mirror module (pyi ③)', () => {
    // 跨文件可解析验收:profile 注解裸引用 ITEM_INFO,头部必须按分件镜像
    // 模块路径导入(types.xml 在 /ws/scripts/entity_defs → stubs 树镜像
    // scripts/entity_defs → 模块 scripts.entity_defs.kbe_types)。
    const plan = buildEntityTypeStubPlan([avatarMapping], [customType], { workspaceRoot: '/ws' });
    expect(plan.content).toContain('    profile: ITEM_INFO');
    expect(plan.content).toContain('from scripts.entity_defs.kbe_types import ITEM_INFO');
    // 无工作区语境退根级模块名,仍可解析(与 kbe_types 根级单文件落点对齐)
    const rootless = buildEntityTypeStubPlan([avatarMapping], [customType]);
    expect(rootless.content).toContain('from kbe_types import ITEM_INFO');
  });

  it('method argument annotations referencing custom types get imported too (pyi ④)', () => {
    // 方法面形参注解引用自定义类型名(respawn(arg1: ITEM_INFO)):实体
    // 方法面与 mailbox 面共用同一注解链,导入面漏扫方法形参即悬挂裸名。
    const guardArgMapping = {
      ...guardMapping,
      methods: {
        respawn: [{
          defFile: '/ws/scripts/entity_defs/Guard.def',
          line: 17,
          section: 'CellMethods',
          exposed: true,
          declaredArgs: ['ITEM_INFO']
        }]
      }
    } as unknown as EntityMapping;
    const plan = buildEntityTypeStubPlan([guardArgMapping], [customType], { workspaceRoot: '/ws' });
    expect(plan.content).toContain('def respawn(arg1: ITEM_INFO) -> None: ...');
    expect(plan.content).toContain('from scripts.entity_defs.kbe_types import ITEM_INFO');
  });

  it('poisoned custom types fall back to Any and are never imported (pyi ③)', () => {
    // 成环别名(CY_A→CY_B→CY_A)在 kbe_types.pyi 整链不发射:entity_types
    // 不得裸挂该名字,也不得导入——诚实落 Any。
    const cyclicA: CustomTypeInfo = {
      ...customType,
      name: 'CY_A',
      aliasType: 'CY_B',
      rawValue: 'CY_B',
      structure: { name: 'CY_B', rawValue: 'CY_B', children: [], line: 1 },
      properties: []
    };
    const cyclicB: CustomTypeInfo = {
      ...customType,
      name: 'CY_B',
      aliasType: 'CY_A',
      rawValue: 'CY_A',
      structure: { name: 'CY_A', rawValue: 'CY_A', children: [], line: 2 },
      properties: []
    };
    const trapMapping = {
      ...avatarMapping,
      name: 'Trap',
      properties: { profile: avatarMapping.properties.profile },
      propertyDefinitions: [{
        defFile: '/ws/scripts/entity_defs/Avatar.def',
        line: 24,
        identity: { symbolName: 'profile' },
        domains: [],
        persistent: false,
        typeName: 'CY_A'
      }]
    } as unknown as EntityMapping;
    const plan = buildEntityTypeStubPlan([trapMapping], [cyclicA, cyclicB], { workspaceRoot: '/ws' });
    expect(plan.content).toContain('    profile: Any');
    expect(plan.content).not.toContain('CY_A');
    expect(plan.content).not.toContain('import CY');
  });

  it('returns no content when neither properties nor methods are declared', () => {
    expect(buildEntityTypeStubPlan([], [customType]).content).toBeNull();
  });

  it('folds ARRAY element sub-paths into one legal attribute line', () => {
    // 用户报 bug:ARRAY of 的嵌套子属性经 `${fullPath}[]` 进 properties 表,
    // 存根原样吐出 foo 与 foo[] 各一行且 foo[] 非法标识符。折叠后只留 foo,
    // 元素类型经同链解析 → FixedArray[FooItem](引擎容器);嵌套 foo[].x 也不得落行。
    const arrayMapping = {
      name: 'Soldier',
      defFile: '/ws/scripts/entity_defs/Soldier.def',
      pythonFile: '/ws/scripts/entity/Soldier.py',
      pythonFiles: ['/ws/scripts/entity/Soldier.py'],
      properties: {
        foo: { defFile: '/ws/scripts/entity_defs/Soldier.def', line: 30 },
        'foo[]': { defFile: '/ws/scripts/entity_defs/Soldier.def', line: 30 },
        'foo[].item': { defFile: '/ws/scripts/entity_defs/Soldier.def', line: 31 }
      },
      methods: {},
      propertyDefinitions: [
        {
          defFile: '/ws/scripts/entity_defs/Soldier.def', line: 30,
          identity: { symbolName: 'foo' }, domains: [], persistent: false, typeName: 'ARRAY'
        },
        {
          defFile: '/ws/scripts/entity_defs/Soldier.def', line: 30,
          identity: { symbolName: 'foo[]' }, domains: [], persistent: false, typeName: 'ITEM_INFO'
        },
        {
          defFile: '/ws/scripts/entity_defs/Soldier.def', line: 31,
          identity: { symbolName: 'foo[].item' }, domains: [], persistent: false, typeName: 'UINT32'
        }
      ]
    } as unknown as EntityMapping;
    const plan = buildEntityTypeStubPlan([arrayMapping], [customType]);
    expect(plan.entries[0].properties).toEqual([{
      name: 'foo',
      annotation: 'FixedArray[ITEM_INFO]',
      customTypeLine: 8,
      sourceLine: 30
    }]);
    expect(plan.content).toContain('    foo: FixedArray[ITEM_INFO]');
    expect(plan.content).not.toContain('[]');
  });

  it('keeps FixedArray[Any] for bare ARRAY and FixedArray[int] for builtin elements', () => {
    // 裸 ARRAY(def 直接写 ARRAY 无元素声明):无 `x[]` 条目可借力,诚实 Any;
    // 元素为内建类型时走同一解析链 → FixedArray[int]。
    const bare = {
      name: 'Scout',
      defFile: '/ws/scripts/entity_defs/Scout.def',
      pythonFile: '/ws/scripts/entity/Scout.py',
      pythonFiles: ['/ws/scripts/entity/Scout.py'],
      properties: { tags: { defFile: '/ws/scripts/entity_defs/Scout.def', line: 11 } },
      methods: {},
      propertyDefinitions: [{
        defFile: '/ws/scripts/entity_defs/Scout.def', line: 11,
        identity: { symbolName: 'tags' }, domains: [], persistent: false, typeName: 'ARRAY'
      }]
    } as unknown as EntityMapping;
    const builtinElem = {
      name: 'Archer',
      defFile: '/ws/scripts/entity_defs/Archer.def',
      pythonFile: '/ws/scripts/entity/Archer.py',
      pythonFiles: ['/ws/scripts/entity/Archer.py'],
      properties: {
        scores: { defFile: '/ws/scripts/entity_defs/Archer.def', line: 12 },
        'scores[]': { defFile: '/ws/scripts/entity_defs/Archer.def', line: 12 }
      },
      methods: {},
      propertyDefinitions: [
        {
          defFile: '/ws/scripts/entity_defs/Archer.def', line: 12,
          identity: { symbolName: 'scores' }, domains: [], persistent: false, typeName: 'ARRAY'
        },
        {
          defFile: '/ws/scripts/entity_defs/Archer.def', line: 12,
          identity: { symbolName: 'scores[]' }, domains: [], persistent: false, typeName: 'UINT32'
        }
      ]
    } as unknown as EntityMapping;
    const plan = buildEntityTypeStubPlan([bare, builtinElem], []);
    // 条目按实体名排序:Archer(builtin 元素)在前,Scout(裸 ARRAY)在后
    expect(plan.entries[0].properties[0].annotation).toBe('FixedArray[int]');
    expect(plan.entries[1].properties[0].annotation).toBe('FixedArray[Any]');
  });

  it('imports every typing name that annotations can emit', () => {
    // 用户实锤:头部只有 from typing import Any,VECTOR3→Tuple / PY_DICT→Dict /
    // PY_LIST→List 一到就报未定义。头部按 kbe_types.pyi 口径全量固定导入;
    // 断言注解里出现的每个 typing 名都在 import 行。
    const typed = {
      name: 'Mage',
      defFile: '/ws/scripts/entity_defs/Mage.def',
      pythonFile: '/ws/scripts/entity/Mage.py',
      pythonFiles: ['/ws/scripts/entity/Mage.py'],
      properties: {
        pos: { defFile: '/ws/scripts/entity_defs/Mage.def', line: 20 },
        bag: { defFile: '/ws/scripts/entity_defs/Mage.def', line: 21 },
        history: { defFile: '/ws/scripts/entity_defs/Mage.def', line: 22 }
      },
      methods: {},
      propertyDefinitions: [
        {
          defFile: '/ws/scripts/entity_defs/Mage.def', line: 20,
          identity: { symbolName: 'pos' }, domains: [], persistent: false, typeName: 'VECTOR3'
        },
        {
          defFile: '/ws/scripts/entity_defs/Mage.def', line: 21,
          identity: { symbolName: 'bag' }, domains: [], persistent: false, typeName: 'PY_DICT'
        },
        {
          defFile: '/ws/scripts/entity_defs/Mage.def', line: 22,
          identity: { symbolName: 'history' }, domains: [], persistent: false, typeName: 'PY_LIST'
        }
      ]
    } as unknown as EntityMapping;
    const plan = buildEntityTypeStubPlan([typed], []);
    const importLine = plan.content!.split('\n').find(line => line.startsWith('from typing import'))!;
    for (const name of ['Any', 'Dict', 'List', 'Tuple']) {
      expect(importLine).toContain(name);
    }
    // GEN-DEF-1c:VECTOR3→KBEngine.Vector3、PY_DICT→dict、PY_LIST→list。
    expect(plan.content).toContain('    pos: Vector3');
    expect(plan.content).toContain('    bag: dict');
    expect(plan.content).toContain('    history: list');
    expect(plan.content).toContain('from KBEngine import Entity, Vector3');
    expect(plan.content).not.toMatch(/\blist\[/);
  });

  it('ARRAY 属性面从 KBEngine 导入 FixedArray(GEN-DEF-1b 容器接线)', () => {
    const arrayMapping = {
      name: 'Guard',
      defFile: '/ws/scripts/entity_defs/Guard.def',
      pythonFile: '/ws/scripts/entity/Guard.py',
      pythonFiles: ['/ws/scripts/entity/Guard.py'],
      properties: {
        slots: { defFile: '/ws/scripts/entity_defs/Guard.def', line: 10 },
        'slots[]': { defFile: '/ws/scripts/entity_defs/Guard.def', line: 10 }
      },
      methods: {},
      propertyDefinitions: [
        {
          defFile: '/ws/scripts/entity_defs/Guard.def', line: 10,
          identity: { symbolName: 'slots' }, domains: [], persistent: false, typeName: 'ARRAY'
        },
        {
          defFile: '/ws/scripts/entity_defs/Guard.def', line: 10,
          identity: { symbolName: 'slots[]' }, domains: [], persistent: false, typeName: 'UINT32'
        }
      ]
    } as unknown as EntityMapping;
    const plan = buildEntityTypeStubPlan([arrayMapping], []);
    expect(plan.entries[0].properties[0].annotation).toBe('FixedArray[int]');
    // FixedArray 在注解面真实引用 → KBEngine 导入面一并带上
    expect(plan.content).toContain('from KBEngine import Entity, FixedArray');
    expect(plan.content).toContain('    slots: FixedArray[int]');
  });

  it('PYTHON 族属性按 <Default> 字面量精化(GEN-DEF-1c)', () => {
    const pyMapping = {
      name: 'Alchemist',
      defFile: '/ws/scripts/entity_defs/Alchemist.def',
      pythonFile: '/ws/scripts/entity/Alchemist.py',
      pythonFiles: ['/ws/scripts/entity/Alchemist.py'],
      properties: {
        buff: { defFile: '/ws/scripts/entity_defs/Alchemist.def', line: 30 },
        loot: { defFile: '/ws/scripts/entity_defs/Alchemist.def', line: 31 },
        recipe: { defFile: '/ws/scripts/entity_defs/Alchemist.def', line: 32 }
      },
      methods: {},
      propertyDefinitions: [
        {
          defFile: '/ws/scripts/entity_defs/Alchemist.def', line: 30,
          identity: { symbolName: 'buff' }, domains: [], persistent: false,
          typeName: 'PY_DICT', defaultValue: "{'hp': 1, 'mp': 2}"
        },
        {
          defFile: '/ws/scripts/entity_defs/Alchemist.def', line: 31,
          identity: { symbolName: 'loot' }, domains: [], persistent: false,
          typeName: 'PY_LIST', defaultValue: '[1, 2, 3]'
        },
        {
          defFile: '/ws/scripts/entity_defs/Alchemist.def', line: 32,
          identity: { symbolName: 'recipe' }, domains: [], persistent: false,
          typeName: 'PY_TUPLE'
        }
      ]
    } as unknown as EntityMapping;
    const plan = buildEntityTypeStubPlan([pyMapping], []);
    expect(plan.content).toContain('    buff: dict[str, int]');
    expect(plan.content).toContain('    loot: list[int]');
    // 无 Default 回落基类 tuple
    expect(plan.content).toContain('    recipe: tuple');
  });

  it('def 属性注解一律非 Optional(GEN-DEF-1a 回归:创建/装载线恒非 None)', () => {
    // 任意 def 属性(含 ARRAY/FIXED_DICT/邮箱句柄以外的字段)注解不得含
    // `| None`——引擎创建线对所有 def 属性灌 newDefaultVal()(非 None)。
    const plans = [
      buildEntityTypeStubPlan([{
        name: 'Hero',
        defFile: '/ws/scripts/entity_defs/Hero.def',
        pythonFile: '/ws/scripts/entity/Hero.py',
        pythonFiles: ['/ws/scripts/entity/Hero.py'],
        properties: {
          hp: { defFile: '/ws/scripts/entity_defs/Hero.def', line: 5 },
          talent: { defFile: '/ws/scripts/entity_defs/Hero.def', line: 6 },
          'talent[]': { defFile: '/ws/scripts/entity_defs/Hero.def', line: 6 }
        },
        methods: {},
        propertyDefinitions: [
          { defFile: '/ws/scripts/entity_defs/Hero.def', line: 5, identity: { symbolName: 'hp' }, domains: [], persistent: false, typeName: 'UINT32' },
          { defFile: '/ws/scripts/entity_defs/Hero.def', line: 6, identity: { symbolName: 'talent' }, domains: [], persistent: false, typeName: 'ARRAY' },
          { defFile: '/ws/scripts/entity_defs/Hero.def', line: 6, identity: { symbolName: 'talent[]' }, domains: [], persistent: false, typeName: 'TALENT_NODE' }
        ]
      } as unknown as EntityMapping], [])
    ];
    for (const plan of plans) {
      for (const entry of plan.entries) {
        for (const property of entry.properties) {
          expect(
            property.annotation,
            `${entry.entity}.${property.name} 注解应为非 Optional,实得: ${property.annotation}`
          ).not.toMatch(/\|\s*None\b/);
        }
      }
    }
  });
});
