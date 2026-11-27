import { describe, expect, it } from 'vitest';
import {
  collectCreationParamsKeys,
  createNamespaceTimelineMarkdown,
  type TimelineProperty
} from '../src/backend/createNamespaceTimeline';

const hp: TimelineProperty = {
  name: 'hp',
  typeName: 'UINT32',
  defaultValue: '0',
  domains: ['base'],
  defFile: '/x/Avatar.def',
  defLine: 5
};
const speed: TimelineProperty = {
  name: 'speed',
  typeName: 'FLOAT',
  domains: ['cell'],
  defFile: '/x/Avatar.def',
  defLine: 9
};

describe('createNamespaceTimelineMarkdown (CREATE-06)', () => {
  it('renders the three lifecycle steps with engine citations', () => {
    const md = createNamespaceTimelineMarkdown({ entity: 'Avatar', properties: [hp] });
    expect(md).toContain('**Avatar · createNamespace 时序（`__init__` 之前）**');
    expect(md).toContain('① `initProperty` — def 属性逐一设为类型默认值');
    expect(md).toContain('entity_macro.h:1574');
    expect(md).toContain('entity_macro.h:1616');
    expect(md).toContain('② `createNamespace`');
    expect(md).toContain('entity_macro.h:417-431');
    expect(md).toContain('③ `initializeScript` 才调用 `__init__`');
    expect(md).toContain('entity_macro.h:322-325');
    expect(md).toContain('调用序 entity_macro.h:362-365');
  });

  it('states the params hit/absence behavior per property', () => {
    const md = createNamespaceTimelineMarkdown({
      entity: 'Avatar',
      properties: [hp, speed],
      paramsKeys: ['hp']
    });
    expect(md).toContain('`hp` · UINT32 · 域 base · 默认 0 · params 命中→覆盖 · 声明 `Avatar.def:5`');
    expect(md).toContain('`speed` · FLOAT · 域 cell · 默认 — · 缺键→默认值 · 声明 `Avatar.def:9`');
    expect(md).toContain('键在 params 中 = 覆盖默认值；缺键 = 保留①的默认值');
  });

  it('writes params-not-collected honestly instead of guessing', () => {
    const md = createNamespaceTimelineMarkdown({ entity: 'Avatar', properties: [hp] });
    expect(md).toContain('params 未取');
    expect(md).not.toContain('params 命中→覆盖');
    expect(md).not.toContain('缺键→默认值');
  });

  it('stays silent when the catalog is unavailable', () => {
    const md = createNamespaceTimelineMarkdown({ entity: 'Avatar', properties: null });
    expect(md).toContain('属性目录不可用（索引未就绪）');
    expect(md).not.toContain('`hp`');
    expect(md).not.toContain('params 命中→覆盖');
  });

  it('handles entities declaring no properties', () => {
    const md = createNamespaceTimelineMarkdown({ entity: 'Empty', properties: [] });
    expect(md).toContain('实体 def 未声明属性');
    expect(md).toContain('params 键全部走动态 setattr 臂');
  });

  it('caps the property table and reports overflow', () => {
    const many = Array.from({ length: 13 }, (_, i) => ({
      ...hp,
      name: `k${i}`,
      defLine: i + 1
    }));
    const md = createNamespaceTimelineMarkdown({
      entity: 'Avatar',
      properties: many,
      paramsKeys: []
    });
    expect(md).toContain('`k11`');
    expect(md).not.toContain('`k12`');
    expect(md).toContain('其余 1 项省略');
  });
});

describe('collectCreationParamsKeys (CREATE-05 contract mirror)', () => {
  it('collects keys from a baseapp createEntity positional-params call', () => {
    const keys = collectCreationParamsKeys(
      'KBEngine.createEntity("Avatar", {"hp": 1, "speed": []})',
      'Avatar'
    );
    expect(keys).toEqual(['hp', 'speed']);
  });

  it('collects keys from the keyword params argument', () => {
    const keys = collectCreationParamsKeys(
      'KBEngine.createEntity("Avatar", params={"hp": 1})',
      'Avatar'
    );
    expect(keys).toEqual(['hp']);
  });

  it('matches entity type by first positional string literal', () => {
    const keys = collectCreationParamsKeys(
      'KBEngine.createEntity("Monster", {"hp": 1})',
      'Avatar'
    );
    expect(keys).toEqual([]);
  });

  it('honors the cellapp arity (params at slot 4)', () => {
    const keys = collectCreationParamsKeys(
      'KBEngine.createEntity("Avatar", 3, (0, 0, 0), (0, 0, 1), {"cellData": {}})',
      'Avatar'
    );
    expect(keys).toEqual(['cellData']);
  });

  it('collects keys from the remotely slot-2 params argument', () => {
    const keys = collectCreationParamsKeys(
      'KBEngine.createEntityRemotely("Avatar", baseEntityCall, {"hp": 5})',
      'Avatar'
    );
    expect(keys).toEqual(['hp']);
  });

  it('collects keys from createEntityAnywhere', () => {
    const keys = collectCreationParamsKeys(
      'KBEngine.createEntityAnywhere("Avatar", {"hp": 5}, cb)',
      'Avatar'
    );
    expect(keys).toEqual(['hp']);
  });

  it('does not claim keys for non-literal or spread params dicts', () => {
    expect(collectCreationParamsKeys(
      'KBEngine.createEntity("Avatar", some_dict)', 'Avatar'
    )).toEqual([]);
    expect(collectCreationParamsKeys(
      'KBEngine.createEntity("Avatar", {**other, "hp": 1})', 'Avatar'
    )).toEqual([]);
  });

  it('skips foreign receivers and bare calls', () => {
    expect(collectCreationParamsKeys(
      'other.createEntity("Avatar", {"hp": 1})', 'Avatar'
    )).toEqual([]);
  });

  it('ignores nested commas inside tuples and strings', () => {
    const keys = collectCreationParamsKeys(
      'KBEngine.createEntity("Avatar", {"pos": (1, 2), "note": "a, b"})',
      'Avatar'
    );
    expect(keys).toEqual(['note', 'pos']);
  });

  it('merges keys across multiple call sites and dedupes', () => {
    const source = [
      'KBEngine.createEntity("Avatar", {"hp": 1})',
      'KBEngine.createEntity("Avatar", {"speed": 2.0, "hp": 3})'
    ].join('\n');
    expect(collectCreationParamsKeys(source, 'Avatar')).toEqual(['hp', 'speed']);
  });
});
