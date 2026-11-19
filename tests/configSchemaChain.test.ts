// CFG-HOVER-FIX-002 配置数据成员链类型直读(纯核契约):
//   - 形状解析:方括号泛型形态(inferLiteralType 同源 typeText)
//   - 链提取:attr 前缀/dict 字符串键前缀;非链/数字打头中段拒绝
//   - 走链:binding 下标/属性风格、模块根(Config.MOBILES 形态)、
//     class 字段(含类字段→类条目二跳)、dict 键悬停
//   - 零产出面:容器方法名、未知 class 字段、class 下标
// 类型期望全部来自 collectConfigSchema 真实输出(直读非手抄)。
import { describe, expect, it } from 'vitest';
import { collectConfigSchema, CONFIG_DATA_SETTINGS_DEFAULT, type ConfigSourceInput } from '../src/configDataMutation';
import {
  extractMemberChainQuery,
  parseClassFieldTypes,
  parseTypeShape,
  resolveConfigMemberChain,
  type MemberChainQuery
} from '../src/configSchemaChain';

const CFG_PY = `MOBILES = [{'id': 1, 'hp': 100, 'bag': {'gold': 5}}]

TABLE = {'warrior': {'hp': 100}, 'mage': {'hp': 80}}
`;
const ITEMS_PY = `class MobConfig:
    name: str = 'x'
    hp: int = 1

class ItemsConfig:
    maxHp: int = 100
    mob: MobConfig
`;

const schema = collectConfigSchema([
  { file: 'scripts/config/Config.py', text: CFG_PY },
  { file: 'scripts/config/items.py', text: ITEMS_PY }
] as ConfigSourceInput[], CONFIG_DATA_SETTINGS_DEFAULT);

const resolve = (root: string, steps: MemberChainQuery['steps'], target: MemberChainQuery['target']) =>
  resolveConfigMemberChain({ root, steps, target }, schema);

describe('parseTypeShape(方括号泛型形态,与 inferLiteralType typeText 同源)', () => {
  it('dict/list 嵌套保形;裸标识符=类名候选;非类型文本=scalar', () => {
    expect(parseTypeShape('dict[str, dict[str, int]]')).toEqual({ shape: 'dict', key: 'str', value: 'dict[str, int]' });
    expect(parseTypeShape('list[dict[str, int | dict[str, int]]]')).toEqual({ shape: 'list', elem: 'dict[str, int | dict[str, int]]' });
    expect(parseTypeShape('set[int]')).toEqual({ shape: 'set', elem: 'int' });
    expect(parseTypeShape('MobConfig')).toEqual({ shape: 'name', name: 'MobConfig' });
    expect(parseTypeShape('int | dict[str, int]')).toEqual({ shape: 'scalar' });
  });

  it('parseClassFieldTypes:class 条目 typeText → 字段表;垃圾段跳过不抛', () => {
    expect([...parseClassFieldTypes('maxHp: int, mob: MobConfig')]).toEqual([
      ['maxHp', 'int'],
      ['mob', 'MobConfig']
    ]);
    expect(parseClassFieldTypes('').size).toBe(0);
  });
});

describe('extractMemberChainQuery(链提取)', () => {
  it('attr 前缀:root+steps+目标 attr;dict 字符串键前缀:目标=dict-key', () => {
    const at = (line: string, word: string): number => line.indexOf(word);
    const l1 = '    v = Config.MOBILES[0].hp';
    expect(extractMemberChainQuery(l1, at(l1, 'hp'), 'hp')).toEqual({
      root: 'Config',
      steps: [{ kind: 'attr', name: 'MOBILES' }, { kind: 'subscript' }],
      target: { kind: 'attr', name: 'hp' }
    });
    const l2 = "    v = TABLE['warrior']['hp']";
    expect(extractMemberChainQuery(l2, at(l2, 'hp'), 'hp')).toEqual({
      root: 'TABLE',
      steps: [{ kind: 'subscript', key: 'warrior' }],
      target: { kind: 'dict-key', key: 'hp' }
    });
  });

  it('非链前缀/数字打头中段 → null(悬停处无成员链不抢位)', () => {
    const at = (line: string, word: string): number => line.indexOf(word);
    expect(extractMemberChainQuery('    log(hp)', at('    log(hp)', 'hp'), 'hp')).toBeNull();
    expect(extractMemberChainQuery('    v = 2x.foo', at('    v = 2x.foo', 'foo'), 'foo')).toBeNull();
  });
});

describe('resolveConfigMemberChain(走链直读)', () => {
  it('binding 下标+属性风格:MOBILES[0].hp → 元素 dict 值类型直读(键集合不在 schema,类型直读如实)', () => {
    const hit = resolve('MOBILES', [{ kind: 'subscript' }], { kind: 'attr', name: 'hp' });
    expect(hit?.typeText).toBe('int | dict[str, int]');
    expect(hit?.rootFile).toBe('scripts/config/Config.py');
  });

  it('模块根:Config.MOBILES[0].hp → 模块内同名条目起始走链', () => {
    const hit = resolve('Config', [{ kind: 'attr', name: 'MOBILES' }, { kind: 'subscript' }], { kind: 'attr', name: 'hp' });
    expect(hit?.typeText).toBe('int | dict[str, int]');
    expect(hit?.rootName).toBe('MOBILES');
  });

  it('dict 键悬停:TABLE["warrior"] 后悬停 hp 键 → 值类型', () => {
    const hit = resolve('TABLE', [{ kind: 'subscript', key: 'warrior' }], { kind: 'dict-key', key: 'hp' });
    expect(hit?.typeText).toBe('int');
    expect(hit?.rootLine).toBe(2);
  });

  it('class 字段链:ItemsConfig.mob → 类条目展开;再下钻 .hp → int', () => {
    expect(resolve('ItemsConfig', [], { kind: 'attr', name: 'mob' })?.typeText)
      .toBe('MobConfig(name: str, hp: int)');
    expect(resolve('ItemsConfig', [{ kind: 'attr', name: 'mob' }], { kind: 'attr', name: 'hp' })?.typeText)
      .toBe('int');
  });

  it('零产出面:容器方法名不假命中;未知 class 字段;class 上下标', () => {
    expect(resolve('MOBILES', [{ kind: 'subscript' }], { kind: 'attr', name: 'get' })).toBeNull();
    expect(resolve('MobConfig', [], { kind: 'attr', name: 'nope' })).toBeNull();
    expect(resolve('MobConfig', [{ kind: 'subscript' }], { kind: 'attr', name: 'hp' })).toBeNull();
  });
});
