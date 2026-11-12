/**
 * KSEM-STRUCT-05:def 属性标量赋值范围/结构校验(纯模块面)。
 * 确定消费点 = `self.<属性> = <整行字面量>` / `self.<属性>["<键>"]… = <整行字面量>`
 * / `self.<数组属性>[<整数>] = <整行字面量>`,引擎类型进标量表才判:
 * - 范围:整数字面量越引擎标量封闭区间(负入无符号/越界),BigInt 精确边界;
 * - 结构:字符串/bytes/向量/None 规则(CELL-08 同真源;bool 是 int 子类不报);
 * - 普通/不可判形态一律不接管:名字·调用 RHS、增强赋值、`==`、dict RHS
 *   (归 STRUCT-04 构造面)、FD 目标、未知键、混合链(数组元素再取键)。
 */
import { describe, expect, it } from 'vitest';
import {
  analyzeScalarAssignWrites,
  scalarAssignFindingToItem,
  SCALAR_ASSIGN_DIAGNOSTIC_CODE,
  type ScalarAssignResolve
} from '../src/backend/scalarAssignCheck';
import type {
  CustomTypeInfo,
  CustomTypePropertyInfo,
  CustomTypeStructureChild,
  CustomTypeStructureNode
} from '../src/definitionWorkspace';

// ---------------------------------------------------------------------------
// 内联注册表夹具(镜像 types.xml 高保真形状;与 STRUCT-02/04 测试同构)
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

const AVATAR_INFO = customType('AVATAR_INFO', 'FIXED_DICT', [
  scalarField('uid', 'UINT8', 31),
  scalarField('label', 'STRING', 32)
], 30);

const BAG_U8 = customType('BAG_U8', 'ARRAY', [], 60, node('ARRAY', 60, [{ tag: 'of', value: node('UINT8', 61) }]));
const BAG_POS = customType('BAG_POS', 'ARRAY', [], 70, node('ARRAY', 70, [{ tag: 'of', value: node('POSITION', 71) }]));
const POSITION = customType('POSITION', 'FIXED_DICT', [
  scalarField('x', 'FLOAT', 12)
], 10);
const HEALTH_ALIAS = customType('HEALTH', 'UINT8', [], 50);

const REGISTRY: CustomTypeInfo[] = [AVATAR_INFO, BAG_U8, BAG_POS, POSITION, HEALTH_ALIAS];

/** 属性名 → def <Type> 直文本 + 声明来源段(缺省表)。 */
const makeResolver = (table: Record<string, { typeName: string; source: string } | null>): ScalarAssignResolve =>
  async prop => table[prop] ?? null;

const analyze = (
  text: string,
  table: Record<string, { typeName: string; source: string } | null> = {
    health: { typeName: 'UINT8', source: 'Avatar.def:5' },
    name: { typeName: 'STRING', source: 'Avatar.def:6' },
    pos: { typeName: 'VECTOR3', source: 'Avatar.def:7' },
    num: { typeName: 'INT32', source: 'Avatar.def:8' },
    info: { typeName: 'AVATAR_INFO', source: 'Avatar.def:9' },
    bag: { typeName: 'BAG_U8', source: 'Avatar.def:10' },
    bagPos: { typeName: 'BAG_POS', source: 'Avatar.def:11' },
    hp: { typeName: 'HEALTH', source: 'Avatar.def:12' },
    mystery: null
  }
) => analyzeScalarAssignWrites(text, makeResolver(table), REGISTRY);

/** 包一层类/方法体(体行 8 空格缩进;语句从第 2 行起)。 */
function wrap(...body: string[]): string {
  return ['class Avatar:', '    def on_spawn(self):', ...body.map(l => `        ${l}`)].join('\n');
}

describe('analyzeScalarAssignWrites 根形态:范围面', () => {
  it('UINT8 属性赋 300:越界报范围,落在 RHS 字面量段', async () => {
    const stmt = 'self.health = 300';
    const findings = await analyze(wrap(stmt));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      kind: 'range',
      target: 'self.health',
      expected: 'UINT8 (int 0..255)',
      valueText: '300',
      source: 'Avatar.def:5'
    });
    expect(findings[0].line).toBe(2);
    expect(findings[0].character).toBe(8 + stmt.indexOf('300'));
    expect(findings[0].length).toBe('300'.length);
    expect(findings[0].message).toContain('out of range');
    expect(findings[0].message).toContain('Avatar.def:5');
  });

  it('负数入无符号:范围不符;恰在边界(255)不报', async () => {
    const neg = await analyze(wrap('self.health = -1'));
    expect(neg).toHaveLength(1);
    expect(neg[0]).toMatchObject({ kind: 'range', valueText: '-1' });
    const edge = await analyze(wrap('self.health = 255'));
    expect(edge).toHaveLength(0);
  });

  it('INT64 大数边界:BigInt 精确,2^63 越界 2^63-1 不越', async () => {
    const table = { big: { typeName: 'INT64', source: 'Avatar.def:20' } };
    const over = await analyze(wrap('self.big = 9223372036854775808'), table);
    expect(over).toHaveLength(1);
    const ok = await analyze(wrap('self.big = 9223372036854775807'), table);
    expect(ok).toHaveLength(0);
  });

  it('行尾注释:裁定不受扰,span 不含注释', async () => {
    const stmt = 'self.health = 300  # cap';
    const findings = await analyze(wrap(stmt));
    expect(findings).toHaveLength(1);
    expect(findings[0].character).toBe(8 + stmt.indexOf('300'));
  });
});

describe('analyzeScalarAssignWrites 根形态:结构面', () => {
  it('整数入 STRING:结构错配', async () => {
    const findings = await analyze(wrap('self.name = 5'));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: 'structure', actual: 'int', expected: 'STRING (str)' });
  });

  it('None 入 VECTOR3:结构错配(isSameType 假)', async () => {
    const findings = await analyze(wrap('self.pos = None'));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: 'structure', actual: 'None' });
  });

  it('bool 入 UINT8 不报(int 子类);浮点字面量入 INT32 报结构', async () => {
    const boolOk = await analyze(wrap('self.health = True'));
    expect(boolOk).toHaveLength(0);
    const floatIntoInt = await analyze(wrap('self.num = 1.5'));
    expect(floatIntoInt).toHaveLength(1);
    expect(floatIntoInt[0]).toMatchObject({ kind: 'structure', actual: 'float' });
  });

  it('向量元数不符报;元数相符的 list/tuple 数值不报', async () => {
    const arity = await analyze(wrap('self.pos = [1.0, 2.0]'));
    expect(arity).toHaveLength(1);
    expect(arity[0]).toMatchObject({ kind: 'structure', actual: 'list of 2' });
    const good = await analyze(wrap('self.pos = (1.0, 2.0, 3.0)'));
    expect(good).toHaveLength(0);
  });

  it('别名链落引擎标量:HEALTH(→UINT8)同面', async () => {
    const findings = await analyze(wrap('self.hp = 300'));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: 'range', expected: 'UINT8 (int 0..255)' });
  });
});

describe('analyzeScalarAssignWrites 普通形态不接管', () => {
  it('名字/调用 RHS、属性不可解析:不接管', async () => {
    expect(await analyze(wrap('self.health = get_health()'))).toHaveLength(0);
    expect(await analyze(wrap('self.health = max_hp'))).toHaveLength(0);
    expect(await analyze(wrap('self.mystery = 300'))).toHaveLength(0);
  });

  it('增强赋值 / `==` 比较:不接管', async () => {
    expect(await analyze(wrap('self.health += 1'))).toHaveLength(0);
    expect(await analyze(wrap('if self.health == 300:'))).toHaveLength(0);
  });

  it('dict RHS 归 STRUCT-04 构造面:本面不重复', async () => {
    expect(await analyze(wrap('self.health = {}'))).toHaveLength(0);
    expect(await analyze(wrap('self.info = {"uid": 300, "label": "a"}'))).toHaveLength(0);
  });

  it('FD 目标接标量字面量:容器面不越界不猜', async () => {
    expect(await analyze(wrap('self.info = 5'))).toHaveLength(0);
  });
});

describe('analyzeScalarAssignWrites FD 字段面(STRUCT-02 键链)', () => {
  it('self.info["uid"] = 300:字段 UINT8 越界,来源 types.xml:30', async () => {
    const stmt = 'self.info["uid"] = 300';
    const findings = await analyze(wrap(stmt));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      kind: 'range',
      target: 'self.info["uid"]',
      expected: 'UINT8 (int 0..255)',
      source: 'types.xml:30'
    });
    expect(findings[0].character).toBe(8 + stmt.indexOf('300'));
  });

  it('self.info["label"] = 5:STRING 字段结构错配;边界 255 不报', async () => {
    const bad = await analyze(wrap('self.info["label"] = 5'));
    expect(bad).toHaveLength(1);
    expect(bad[0]).toMatchObject({ kind: 'structure', actual: 'int' });
    const ok = await analyze(wrap('self.info["uid"] = 255'));
    expect(ok).toHaveLength(0);
  });

  it('未知键/深层 FD 字段/非标量字段:诚实断链', async () => {
    expect(await analyze(wrap('self.info["bogus"] = 5'))).toHaveLength(0);
    expect(await analyze(wrap('self.info["slot"] = 5'))).toHaveLength(0);
  });
});

describe('analyzeScalarAssignWrites 数组元素面', () => {
  it('self.bag[3] = 300:元素 UINT8 越界,target 带原样下标', async () => {
    const stmt = 'self.bag[3] = 300';
    const findings = await analyze(wrap(stmt));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      kind: 'range',
      target: 'self.bag[3]',
      expected: 'UINT8 (int 0..255)',
      source: 'types.xml:60'
    });
  });

  it('元素是 FD(数组元素接标量字面量):不猜;元素标量接 dict 不重复', async () => {
    expect(await analyze(wrap('self.bagPos[0] = 5'))).toHaveLength(0);
    expect(await analyze(wrap('self.bag[0] = {"a": 1}'))).toHaveLength(0);
  });

  it('数组根上的字符串键(引擎数组键是整数):链死不接管', async () => {
    expect(await analyze(wrap('self.bag["x"] = 5'))).toHaveLength(0);
  });

  it('混合链(数组元素再取键):链状态机不跨数组段,诚实断链', async () => {
    expect(await analyze(wrap('self.bagPos[0]["x"] = 1.5'))).toHaveLength(0);
  });
});

describe('scalarAssignFindingToItem', () => {
  it('纯数据项:code/severity/range 三面', async () => {
    const findings = await analyze(wrap('self.health = 300'));
    const item = scalarAssignFindingToItem(findings[0]);
    expect(item).toMatchObject({
      severity: 'Warning',
      source: 'kbengine',
      code: SCALAR_ASSIGN_DIAGNOSTIC_CODE
    });
    expect(item.range.start).toEqual({ line: findings[0].line, character: findings[0].character });
    expect(item.range.end).toEqual({
      line: findings[0].line,
      character: findings[0].character + findings[0].length
    });
  });
});
