import { describe, expect, it } from 'vitest';
import {
  buildTypePreviewModel,
  type TypePreviewInput,
  type TypePreviewNode
} from '../src/backend/typePreviewModel';
import type { EntityTypeStubEntry } from '../src/entityTypeStubs';
import type { CustomTypeInfo } from '../src/definitionWorkspace';
import type { PythonTypeStubEntry, PythonTypeStubSkipped } from '../src/pythonTypeStubs';

// RUST-167 类型预览纯核:覆盖计数/缺失映射(Any 判定+跳过表)/族判别跳转
// (customTypeLine→types.xml,否则 .def)/真实路径解析不出如实不跳。

const makeEntity = (overrides: Partial<EntityTypeStubEntry> = {}): EntityTypeStubEntry =>
  ({
    entity: 'Avatar',
    properties: [],
    methods: [],
    ...overrides
  }) as EntityTypeStubEntry;

const makeCustomType = (overrides: Partial<CustomTypeInfo>): CustomTypeInfo =>
  ({
    name: 'X',
    filePath: '/ws/scripts/entity_defs/types.xml',
    line: 1,
    implementedByLine: 1,
    startOffset: 0,
    endOffset: 0,
    aliasType: '',
    rawValue: '',
    structure: { name: '', rawValue: '', children: [], line: null },
    properties: [],
    ...overrides
  }) as unknown as CustomTypeInfo;

const input = (overrides: Partial<TypePreviewInput> = {}): TypePreviewInput => ({
  entities: [],
  entityDefFiles: new Map(),
  customTypes: [],
  typeEntries: [],
  typeSkipped: [],
  ...overrides
});

const findChild = (node: TypePreviewNode, prefix: string): TypePreviewNode | undefined =>
  (node.children ?? []).find(child => child.label.startsWith(prefix));
describe('typePreviewModel 覆盖与缺失映射', () => {
  it('覆盖计数:实体属性+类型字段+别名各占一位,Any 判定词边界', () => {
    const model = buildTypePreviewModel(input({
      entities: [makeEntity({
        entity: 'Avatar',
        properties: [
          { name: 'hp', annotation: 'int', sourceLine: 4 },
          { name: 'bag', annotation: 'FixedArray[Any]', sourceLine: 5 },
          { name: 'title', annotation: 'str', sourceLine: 6 }
        ]
      })],
      typeEntries: [
        { kind: 'class', name: 'ITEM_INFO', properties: [{ name: 'count', annotation: 'Any' }], sourceLine: 12, sourceFile: 'types.xml' },
        { kind: 'alias', name: 'REWARD', annotation: 'UINT32', sourceLine: 3, sourceFile: 'alias.xml' }
      ],
      entityDefFiles: new Map([['Avatar', '/ws/scripts/entity_defs/Avatar.def']]),
      customTypes: [makeCustomType({ name: 'ITEM_INFO', line: 12 })]
    }));
    expect(model.coverage).toEqual({ total: 5, resolved: 3, anyCount: 2 });
    expect(model.root.children?.[0].label).toBe('typing 覆盖: 3/5 已解析');
    expect(model.root.children?.[0].description).toBe('2 处含 Any(未解析)');
  });

  it('Any 词边界:MANY/AnyType 不算 Any,空注解位不计', () => {
    const model = buildTypePreviewModel(input({
      entities: [makeEntity({
        properties: [
          { name: 'a', annotation: 'MANY', sourceLine: 1 },
          { name: 'b', annotation: 'AnyType', sourceLine: 2 },
          { name: 'c', annotation: 'Any', sourceLine: 3 }
        ]
      })]
    }));
    expect(model.coverage).toEqual({ total: 3, resolved: 2, anyCount: 1 });
  });

  it('缺失映射组:Any 位逐条+跳过表(原因写明);零面整组不出', () => {
    const withAny = buildTypePreviewModel(input({
      entities: [makeEntity({
        properties: [{ name: 'bag', annotation: 'FixedArray[Any]', sourceLine: 5 }]
      })],
      entityDefFiles: new Map([['Avatar', '/ws/scripts/entity_defs/Avatar.def']]),
      typeSkipped: [{ name: 'LOOP', reason: '别名成环整链跳过' }],
      customTypes: [makeCustomType({ name: 'LOOP', line: 9, filePath: '/ws/scripts/entity_defs/alias.xml' })]
    }));
    const missing = findChild(withAny.root, '缺失映射');
    const group = missing;    expect(group).toBeDefined();
    expect(group!.children).toHaveLength(2);
    expect(group!.children![0].label).toBe('Avatar.bag: FixedArray[Any]');
    expect(group!.children![0].jump).toEqual({ uri: '/ws/scripts/entity_defs/Avatar.def', line: 5 });
    expect(group!.children![1].label).toBe('LOOP: 别名成环整链跳过');
    expect(group!.children![1].jump).toEqual({ uri: '/ws/scripts/entity_defs/alias.xml', line: 9 });

    const clean = buildTypePreviewModel(input({
      entities: [makeEntity({ properties: [{ name: 'hp', annotation: 'int', sourceLine: 4 }] })]
    }));
    expect(clean.root.children?.some(child => child.label.startsWith('缺失映射'))).toBe(false);
  });

  it('跳过表名字不在注册表:如实不跳', () => {
    const model = buildTypePreviewModel(input({
      typeSkipped: [{ name: 'GHOST', reason: '指引为空' }]
    }));
    const group = model.root.children?.find(child => child.label.startsWith('缺失映射'));
    expect(group!.children![0].jump).toBeUndefined();
  });
});

describe('typePreviewModel 来源跳转族判别', () => {
  it('def 族:无 customTypeLine 跳实体注册表 defFile;缺映射不跳', () => {
    const model = buildTypePreviewModel(input({
      entities: [
        makeEntity({ entity: 'Avatar', properties: [{ name: 'hp', annotation: 'int', sourceLine: 4 }] }),
        makeEntity({ entity: 'Ghost', properties: [{ name: 'hp', annotation: 'int', sourceLine: 4 }] })
      ],
      entityDefFiles: new Map([['Avatar', '/ws/scripts/entity_defs/Avatar.def']])
    }));
    const group = model.root.children?.find(child => child.label.startsWith('实体'));
    expect(group!.children![0].children![0].jump).toEqual({ uri: '/ws/scripts/entity_defs/Avatar.def', line: 4 });
    expect(group!.children![1].children![0].jump).toBeUndefined();
    expect(group!.children![1].jump).toBeUndefined();
  });

  it('types.xml 族:customTypeLine 在场跳 typesXmlPath;未配路径不跳', () => {
    const props = [{ name: 'inv', annotation: 'ITEM_INFO', sourceLine: 7, customTypeLine: 12 }];
    const withPath = buildTypePreviewModel(input({
      entities: [makeEntity({ properties: props })],
      entityDefFiles: new Map([['Avatar', '/ws/scripts/entity_defs/Avatar.def']]),
      typesXmlPath: '/ws/scripts/entity_defs/types.xml'
    }));
    const group = withPath.root.children?.find(child => child.label.startsWith('实体'));
    expect(group!.children![0].children![0].jump).toEqual({ uri: '/ws/scripts/entity_defs/types.xml', line: 12 });

    const withoutPath = buildTypePreviewModel(input({
      entities: [makeEntity({ properties: props })],
      entityDefFiles: new Map([['Avatar', '/ws/scripts/entity_defs/Avatar.def']])
    }));
    const group2 = withoutPath.root.children?.find(child => child.label.startsWith('实体'));
    expect(group2!.children![0].children![0].jump).toBeUndefined();
  });

  it('类型面:类字段跳 propertySourceLines 回落声明行;别名跳节点行', () => {
    const model = buildTypePreviewModel(input({
      typeEntries: [
        { kind: 'class', name: 'ITEM_INFO', properties: [{ name: 'count', annotation: 'UINT32' }], sourceLine: 12, sourceFile: 'types.xml', propertySourceLines: { count: 14 } },
        { kind: 'alias', name: 'REWARD', annotation: 'UINT32', sourceLine: 3, sourceFile: 'alias.xml' }
      ],
      customTypes: [
        makeCustomType({ name: 'ITEM_INFO', filePath: '/ws/scripts/entity_defs/types.xml', line: 12 }),
        makeCustomType({ name: 'REWARD', filePath: '/ws/scripts/entity_defs/alias.xml', line: 3 })
      ]
    }));
    const group = model.root.children?.find(child => child.label.startsWith('自定义类型'));
    expect(group!.children![0].label).toBe('ITEM_INFO(字段 1)');
    expect(group!.children![0].jump).toEqual({ uri: '/ws/scripts/entity_defs/types.xml', line: 12 });
    expect(group!.children![0].children![0].jump).toEqual({ uri: '/ws/scripts/entity_defs/types.xml', line: 14 });
    expect(group!.children![1].label).toBe('REWARD → UINT32');
    expect(group!.children![1].jump).toEqual({ uri: '/ws/scripts/entity_defs/alias.xml', line: 3 });
  });

  it('类型名不在注册表:类型面如实不跳', () => {
    const model = buildTypePreviewModel(input({
      typeEntries: [{ kind: 'alias', name: 'ORPHAN', annotation: 'UINT8', sourceLine: 3, sourceFile: 'alias.xml' }],
      customTypes: []
    }));
    const group = model.root.children?.find(child => child.label.startsWith('自定义类型'));
    expect(group!.children![0].jump).toBeUndefined();
  });

  it('方法叶子跳 def 方法面行;实体壳跳 defFile 行 1', () => {
    const model = buildTypePreviewModel(input({
      entities: [makeEntity({
        methods: [{ name: 'onKill', args: ['monsterId'], section: 'BaseMethods', exposed: false, sourceLine: 20 }]
      })],
      entityDefFiles: new Map([['Avatar', '/ws/scripts/entity_defs/Avatar.def']])
    }));
    const group = model.root.children?.find(child => child.label.startsWith('实体'));
    expect(group!.children![0].jump).toEqual({ uri: '/ws/scripts/entity_defs/Avatar.def', line: 1 });
    expect(group!.children![0].children![0].label).toBe('BaseMethods.onKill(1 参)');
    expect(group!.children![0].children![0].jump).toEqual({ uri: '/ws/scripts/entity_defs/Avatar.def', line: 20 });
  });
});

describe('typePreviewModel 空态与分组', () => {
  it('全空:兜底叶子如实说明', () => {
    const model = buildTypePreviewModel(input());
    expect(model.coverage).toEqual({ total: 0, resolved: 0, anyCount: 0 });
    expect(model.root.children).toHaveLength(2);
    expect(model.root.children![1].label).toContain('未发现');
  });

  it('分组顺序:覆盖→缺失映射→自定义类型→实体', () => {
    const model = buildTypePreviewModel(input({
      entities: [makeEntity({ properties: [{ name: 'bag', annotation: 'Any', sourceLine: 5 }] })],
      entityDefFiles: new Map([['Avatar', '/ws/scripts/entity_defs/Avatar.def']]),
      typeEntries: [{ kind: 'alias', name: 'REWARD', annotation: 'UINT32', sourceLine: 3, sourceFile: 'alias.xml' }]
    }));
    expect(model.root.children?.map(child => child.label)).toEqual([
      'typing 覆盖: 1/2 已解析',
      '缺失映射(1)',
      '自定义类型(1)',
      '实体(1)'
    ]);
  });
});
