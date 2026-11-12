/**
 * KSEM-STRUCT-04:FIXED_DICT 构造点诊断(纯模块面)。
 * 确定结构消费点 = `self.<FD 属性>[键…] = {…}`:
 * - 缺键:键全字面量且无 `** 展开`/动态键才可判(宇宙封闭);
 * - 多键:字面量键不在声明集(宇宙开放也照报——展开带不回一个字面量多键);
 * - 字段值结构:内置标量字段 × 字面量值类(复用 CELL-08 同一引擎标量
 *   真源;范围面归 STRUCT-05 不在此重复);
 * - 普通 dict 不套封闭约束:裸名目标/属性不可解析/标量或数组目标/增强
 *   赋值/`==`/非字面量 RHS/未闭合 → 空集。
 */
import { describe, expect, it } from 'vitest';
import {
  analyzeFixedDictConstructWrites,
  fixedDictConstructFindingToItem,
  FIXED_DICT_CONSTRUCT_DIAGNOSTIC_CODE,
  type FixedDictConstructResolve
} from '../src/backend/fixedDictConstructCheck';
import type {
  CustomTypeInfo,
  CustomTypePropertyInfo,
  CustomTypeStructureChild,
  CustomTypeStructureNode
} from '../src/definitionWorkspace';

// ---------------------------------------------------------------------------
// 内联注册表夹具(镜像 types.xml 高保真形状;与 STRUCT-02 测试同构)
// ---------------------------------------------------------------------------

const TYPES_FILE = '/entity_defs/types.xml';

function node(name: string, line: number, children: CustomTypeStructureChild[] = []): CustomTypeStructureNode {
  return { name, rawValue: name, children, line };
}

function scalarField(name: string, typeName: string, line: number): CustomTypePropertyInfo {
  return { name, typeName, line };
}

function customType(
  name: string,
  aliasType: string,
  properties: CustomTypePropertyInfo[],
  line: number,
  structure?: CustomTypeStructureNode
): CustomTypeInfo {
  return {
    name,
    filePath: TYPES_FILE,
    line,
    implementedByLine: line,
    startOffset: 0,
    endOffset: 0,
    aliasType,
    rawValue: '',
    structure: structure ?? node(aliasType, line),
    properties
  };
}

const POSITION = customType('POSITION', 'FIXED_DICT', [
  scalarField('x', 'FLOAT', 12),
  scalarField('y', 'FLOAT', 14),
  scalarField('z', 'FLOAT', 16)
], 10);

const AVATAR_INFO = customType('AVATAR_INFO', 'FIXED_DICT', [
  scalarField('pos', 'POSITION', 31),
  scalarField('label', 'STRING', 33),
  scalarField('moveVec', 'VECTOR3', 34)
], 30);

const BOUNDS = customType('BOUNDS', 'FIXED_DICT', [
  scalarField('uid', 'UINT8', 44),
  scalarField('count', 'UINT32', 45)
], 42);

const POS_BAG = customType('POS_BAG', 'ARRAY', [], 40, node('ARRAY', 40, [{ tag: 'of', value: node('POSITION', 41) }]));

const REGISTRY: CustomTypeInfo[] = [POSITION, AVATAR_INFO, BOUNDS, POS_BAG];

/** 属性名 → def <Type> 文本(缺省表)。 */
const makeResolver = (table: Record<string, string | null>): FixedDictConstructResolve =>
  async prop => table[prop] ?? null;

const analyze = (
  text: string,
  table: Record<string, string | null> = { pos: 'POSITION', info: 'AVATAR_INFO', bound: 'BOUNDS', bag: 'POS_BAG' }
) => analyzeFixedDictConstructWrites(text, makeResolver(table), REGISTRY);

/** 包一层类/方法体(体行 8 空格缩进;语句从第 2 行起)。 */
function wrap(...body: string[]): string {
  return ['class Avatar:', '    def on_spawn(self):', ...body.map(l => `        ${l}`)].join('\n');
}

describe('analyzeFixedDictConstructWrites 缺键/多键', () => {
  it('缺声明字段:全字面量键宇宙封闭,missing 落在开括号位', async () => {
    const findings = await analyze(wrap('self.pos = {"x": 1.0, "y": 2.0}'));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: 'missing', container: 'POSITION', key: 'z' });
    expect(findings[0].message).toContain('missing field(s) z');
    expect(findings[0].message).toContain('types.xml:10');
    // 位置:语句行(体第 1 行=全文第 2 行),开括号 `{` 列
    expect(findings[0].line).toBe(2);
    expect(findings[0].character).toBe(8 + 'self.pos = '.length);
  });

  it('空 dict 字面量 = 全字段缺失', async () => {
    const findings = await analyze(wrap('self.pos = {}'));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: 'missing', key: 'x, y, z' });
  });

  it('多键:字面量键不在声明集,落在键字面量段', async () => {
    const stmt = 'self.pos = {"x": 1.0, "y": 2.0, "z": 3.0, "w": 4.0}';
    const findings = await analyze(wrap(stmt));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: 'extra', container: 'POSITION', key: 'w' });
    expect(findings[0].line).toBe(2);
    expect(findings[0].character).toBe(8 + stmt.indexOf('"w"'));
    expect(findings[0].length).toBe('"w"'.length);
  });

  it('缺键+多键并存:两条独立 finding', async () => {
    const findings = await analyze(wrap('self.pos = {"x": 1.0, "w": 2.0}'));
    expect(findings.map(f => f.kind).sort()).toEqual(['extra', 'missing']);
  });

  it('构造齐整:零 finding', async () => {
    const findings = await analyze(wrap('self.pos = {"x": 1.0, "y": 2.0, "z": 3.0}'));
    expect(findings).toHaveLength(0);
  });
});

describe('analyzeFixedDictConstructWrites 键宇宙开放(诚实边界)', () => {
  it('`** 展开`:缺键不报(展开可能携带旧值),多键照报', async () => {
    const findings = await analyze(wrap('self.pos = {**old, "x": 1.0, "w": 2.0}'));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: 'extra', key: 'w' });
  });

  it('动态键(变量):缺键不报,动态键不判多键', async () => {
    const findings = await analyze(wrap('self.pos = {k: 1.0, "y": 2.0, "z": 3.0}'));
    expect(findings).toHaveLength(0);
  });

  it('f 字串键:同动态键处理', async () => {
    const findings = await analyze(wrap('self.pos = {f"{p}x": 1.0, "y": 2.0, "z": 3.0}'));
    expect(findings).toHaveLength(0);
  });

  it('值非整段字面量(名字/调用):不猜,键集面照常', async () => {
    const findings = await analyze(wrap('self.pos = {"x": self.v, "y": 2.0, "z": 3.0}'));
    expect(findings).toHaveLength(0);
  });
});

describe('analyzeFixedDictConstructWrites 字段值结构面', () => {
  it('字符串入 FLOAT 字段:结构错配落在值段', async () => {
    const stmt = 'self.pos = {"x": "1.0", "y": 2.0, "z": 3.0}';
    const findings = await analyze(wrap(stmt));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: 'type', key: 'x', expected: 'FLOAT (number)', actual: 'str' });
    expect(findings[0].line).toBe(2);
    expect(findings[0].character).toBe(8 + stmt.indexOf('"1.0"'));
  });

  it('整数入 FLOAT 不报;bool 入整数不报;int 入 STRING 报', async () => {
    const okFloat = await analyze(wrap('self.pos = {"x": 1, "y": True, "z": 3.0}'));
    expect(okFloat).toHaveLength(0);
    const badStr = await analyze(wrap('self.info = {"pos": None, "label": 5, "moveVec": [1, 2, 3]}'));
    expect(badStr).toHaveLength(1);
    expect(badStr[0]).toMatchObject({ kind: 'type', key: 'label', actual: 'int' });
  });

  it('None 入标量字段:结构错配', async () => {
    const findings = await analyze(wrap('self.pos = {"x": None, "y": 2.0, "z": 3.0}'));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: 'type', key: 'x', actual: 'None' });
  });

  it('dict 入 STRING 字段:结构错配', async () => {
    const findings = await analyze(wrap('self.info = {"pos": None, "label": {}, "moveVec": [1, 2, 3]}'));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: 'type', key: 'label', actual: 'dict' });
  });

  it('向量:元数不符报;元数相符的 list/tuple 不报;元素非数值报', async () => {
    const arity = await analyze(wrap('self.info = {"pos": None, "label": "a", "moveVec": [1, 2]}'));
    expect(arity).toHaveLength(1);
    expect(arity[0]).toMatchObject({ kind: 'type', key: 'moveVec', actual: 'list of 2' });
    const good = await analyze(wrap('self.info = {"pos": None, "label": "a", "moveVec": (1.0, 2.0, 3.0)}'));
    expect(good).toHaveLength(0);
    const badElem = await analyze(wrap('self.info = {"pos": None, "label": "a", "moveVec": [1, "2", 3]}'));
    expect(badElem).toHaveLength(1);
    expect(badElem[0]).toMatchObject({ kind: 'type', key: 'moveVec', actual: 'list with str component' });
  });

  it('范围面不报(归 STRUCT-05):越 UINT8 界的整数只落结构/范围都不动', async () => {
    const findings = await analyze(wrap('self.bound = {"uid": 300, "count": 5}'));
    expect(findings).toHaveLength(0);
  });

  it('非标量字段(FD/ARRAY/无类型)不裁定;嵌套 dict 字面量不下钻', async () => {
    // pos 是 FD 字段(值又是 dict)→ 不下钻也不报;moveVec 标量但本例给对
    const findings = await analyze(wrap(
      'self.info = {"pos": {"x": "bad", "y": 2.0}, "label": "a", "moveVec": [1, 2, 3]}'
    ));
    expect(findings).toHaveLength(0);
  });
});

describe('analyzeFixedDictConstructWrites 普通 dict 不接管', () => {
  it('裸名目标:不接管', async () => {
    const findings = await analyze(wrap('d = {"x": 1.0}'));
    expect(findings).toHaveLength(0);
  });

  it('属性不可解析(def 无此属性):不接管', async () => {
    const findings = await analyze(wrap('self.unknown_prop = {"x": 1.0}'));
    expect(findings).toHaveLength(0);
  });

  it('标量目标(UINT8)/数组目标(POS_BAG):构造面不接管', async () => {
    const scalar = await analyze(wrap('self.bound2 = {"x": 1.0}'), { bound2: 'UINT8' });
    expect(scalar).toHaveLength(0);
    const array = await analyze(wrap('self.bag = [{"x": 1.0}]'));
    expect(array).toHaveLength(0);
  });

  it('增强赋值 / `==` 比较 / 调用 RHS / 非字面量 RHS:不接管', async () => {
    expect(await analyze(wrap('self.pos += {"x": 1.0}'))).toHaveLength(0);
    expect(await analyze(wrap('if self.pos == {"x": 1.0}:'))).toHaveLength(0);
    expect(await analyze(wrap('self.pos = make_pos()'))).toHaveLength(0);
    expect(await analyze(wrap('self.pos = POSITION(x=1)'))).toHaveLength(0);
  });

  it('嵌套目标:键链解到 FD 字段才接管,深层标量/未知键断链', async () => {
    const nested = await analyze(wrap('self.info["pos"] = {"x": 1.0}'));
    expect(nested).toHaveLength(1);
    expect(nested[0]).toMatchObject({ kind: 'missing', container: 'POSITION', key: 'y, z' });
    expect(nested[0].target).toBe('self.info["pos"]');
    // 深层标量目标(dict 打在 STRING 字段上):构造面不接管
    const deepScalar = await analyze(wrap('self.info["label"] = {"x": 1.0}'));
    expect(deepScalar).toHaveLength(0);
    // 链中未知键:诚实断链
    const unknownKey = await analyze(wrap('self.info["bogus"] = {"x": 1.0}'));
    expect(unknownKey).toHaveLength(0);
  });

  it('未闭合字面量:整点不猜', async () => {
    const findings = await analyze(wrap('self.pos = {"x": 1.0,', '    "y": 2.0'));
    expect(findings).toHaveLength(0);
  });
});

describe('analyzeFixedDictConstructWrites 多行与位置面', () => {
  it('跨行字面量:finding 行列落在涉事键/值真位', async () => {
    const valueLine = '    "x": "bad",';
    const text = wrap(
      'self.pos = {',
      valueLine,
      '    "y": 2.0,',
      '    "z": 3.0',
      '}'
    );
    const findings = await analyze(text);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: 'type', key: 'x' });
    expect(findings[0].line).toBe(3); // 体第 2 行 = 全文第 3 行
    expect(findings[0].character).toBe(8 + valueLine.indexOf('"bad"'));
  });

  it('字面量内行注释:抹除不误伤,行尾注释不接管闭合后内容', async () => {
    const text = wrap(
      'self.pos = {  # 构造初始位置',
      '    "x": 1.0,  # x 轴',
      '    "y": 2.0,',
      '    "z": 3.0',
      '}  # tail comment'
    );
    const findings = await analyze(text);
    expect(findings).toHaveLength(0);
  });

  it('窗口内多构造点互不串扰;字面量行整体消费不重复扫', async () => {
    const text = wrap(
      'self.pos = {"x": 1.0, "y": 2.0}',
      'self.pos = {"x": 1.0, "y": 2.0, "z": 3.0, "w": 1}'
    );
    const findings = await analyze(text);
    expect(findings).toHaveLength(2);
    expect(findings.map(f => f.kind)).toEqual(['missing', 'extra']);
  });

  it('重复字面量键:Map 去重不误报', async () => {
    const findings = await analyze(wrap('self.pos = {"x": 1.0, "x": 2.0, "y": 1.0, "z": 1.0}'));
    expect(findings).toHaveLength(0);
  });
});

describe('fixedDictConstructFindingToItem', () => {
  it('纯数据项:code/severity/range 三面', async () => {
    const findings = await analyze(wrap('self.pos = {}'));
    const item = fixedDictConstructFindingToItem(findings[0]);
    expect(item).toMatchObject({
      severity: 'Warning',
      source: 'kbengine',
      code: FIXED_DICT_CONSTRUCT_DIAGNOSTIC_CODE
    });
    expect(item.range.start).toEqual({ line: findings[0].line, character: findings[0].character });
    expect(item.range.end).toEqual({
      line: findings[0].line,
      character: findings[0].character + findings[0].length
    });
  });
});

// ---------------------------------------------------------------------------
// KSEM-STRUCT-07:implementedBy 类型豁免构造校验——内存形式由实现类重定义,
// dict 字面量对准的键位是实现类自定义的,不是 FIXED_DICT Properties(那只
// 描述传输/存储形式,引擎经 getDictFromObj 还原后使用);按声明键集校验会
// 把实现对象当 TypedDict。普通 FD 同注册表照常(门只收窄不误伤)。
// ---------------------------------------------------------------------------

describe('KSEM-STRUCT-07 implementedBy 类型不按 FIXED_DICT 键集校验', () => {
  const TALENT_LIST = customType('TALENT_LIST', 'FIXED_DICT', [
    scalarField('values', 'UINT32', 72)
  ], 70);
  TALENT_LIST.implementedBy = 'user_type.TalentPickler.inst';

  const REGISTRY_07: CustomTypeInfo[] = [...REGISTRY, TALENT_LIST];

  const analyze07 = (
    text: string,
    table: Record<string, string | null>
  ) => analyzeFixedDictConstructWrites(text, makeResolver(table), REGISTRY_07);

  it('直接形态:implementedBy 属性上的 dict 字面量零报告(不判缺键/多键)', async () => {
    const findings = await analyze07(wrap('self.talents = {"values": [1]}'), { talents: 'TALENT_LIST' });
    expect(findings).toHaveLength(0);
    // 内存键位是实现类自定义的:不合声明键集的字面量同样不报
    const foreign = await analyze07(wrap('self.talents = {"kbengine": 1}'), { talents: 'TALENT_LIST' });
    expect(foreign).toHaveLength(0);
  });

  it('链形态:implementedBy 字段上的构造点零报告', async () => {
    const findings = await analyze07(wrap('self.profile["talents"] = {}'), {
      profile: 'AVATAR_INFO',
      talents: null
    });
    expect(findings).toHaveLength(0);
  });

  it('普通 FD 同注册表照常(门只收窄不误伤)', async () => {
    const findings = await analyze07(wrap('self.pos = {"x": 1.0}'), { pos: 'POSITION' });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: 'missing', container: 'POSITION' });
  });
});
