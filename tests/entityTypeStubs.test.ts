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
    expect(plan.content).toContain('class Avatar:');
    expect(plan.content).toContain('# source: .def:24 -> types.xml:8');
    expect(plan.content).toContain('    profile: ITEM_INFO');
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
    expect(plan.content).toContain('class Guard:');
    expect(plan.content).toContain('# source: .def:17 (CellMethods)');
    expect(plan.content).toContain('def respawn(arg1: int) -> None: ...');
  });

  it('returns no content when neither properties nor methods are declared', () => {
    expect(buildEntityTypeStubPlan([], [customType]).content).toBeNull();
  });

  it('folds ARRAY element sub-paths into one legal attribute line', () => {
    // 用户报 bug:ARRAY of 的嵌套子属性经 `${fullPath}[]` 进 properties 表,
    // 存根原样吐出 foo 与 foo[] 各一行且 foo[] 非法标识符。折叠后只留 foo,
    // 元素类型经同链解析 → List[FooItem];嵌套 foo[].x 也不得落行。
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
      annotation: 'List[ITEM_INFO]',
      customTypeLine: 8,
      sourceLine: 30
    }]);
    expect(plan.content).toContain('    foo: List[ITEM_INFO]');
    expect(plan.content).not.toContain('[]');
  });

  it('keeps List[Any] for bare ARRAY and List[int] for builtin elements', () => {
    // 裸 ARRAY(def 直接写 ARRAY 无元素声明):无 `x[]` 条目可借力,诚实 Any;
    // 元素为内建类型时走同一解析链 → List[int]。
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
    expect(plan.entries[0].properties[0].annotation).toBe('List[int]');
    expect(plan.entries[1].properties[0].annotation).toBe('List[Any]');
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
    expect(plan.content).toContain('    pos: Tuple[float, float, float]');
    expect(plan.content).toContain('    bag: Dict[Any, Any]');
    expect(plan.content).toContain('    history: List[Any]');
    expect(plan.content).not.toMatch(/\blist\[/);
  });
});
