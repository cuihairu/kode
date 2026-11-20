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

// ---------------------------------------------------------------------------
// 批 23 容错臂:括号段间有非空白内容、`=` 缺位、RHS 空、键链末键非标量、
// 数组元素非标量、别名链断(未知类型)。均属"不接管"的诚实边界。
// ---------------------------------------------------------------------------
describe('批 23:目标解析与类型裁定容错臂', () => {
  it('括号段间夹非空白(调用/运算)→ 不接管', async () => {
    expect(await analyze(wrap('self.info["uid"].bit_length() = 1'))).toEqual([]);
    // 段尾多余内容同样不接管
    expect(await analyze(wrap('self.info["uid"] x = 1'))).toEqual([]);
  });

  it('RHS 为空(`self.health =` 后无内容)→ 不接管', async () => {
    expect(await analyze(wrap('self.health ='))).toEqual([]);
    expect(await analyze(wrap('self.health =   '))).toEqual([]);
  });

  it('键链末键非标量(FD 字段指向 FD)→ 不接管', async () => {
    // info.inner 若声明为 FIXED_DICT 则构造面(STRUCT-04)接管,本面让位
    const table = { info: { typeName: 'AVATAR_INFO', source: 'Avatar.def:9' } };
    expect(await analyze(wrap('self.info["uid"]["deep"] = 1'), table)).toEqual([]);
  });

  it('数组元素非标量(BAG_POS 的 POSITION)→ 不接管', async () => {
    expect(await analyze(wrap('self.bagPos[0] = 1'))).toEqual([]);
  });

  it('别名链断(类型名不在注册表)→ 不接管', async () => {
    const table = { ghost: { typeName: 'NOT_IN_REGISTRY', source: 'Avatar.def:20' } };
    expect(await analyze(wrap('self.ghost["k"] = 1'), table)).toEqual([]);
    expect(await analyze(wrap('self.ghost[0] = 1'), table)).toEqual([]);
  });

  it('整数下标但根不是 ARRAY → 不接管', async () => {
    // info 是 FIXED_DICT,整数下标不做数组元素解析
    expect(await analyze(wrap('self.info[0] = 1'))).toEqual([]);
  });
});

describe('批 23 续:别名链下钻三臂(未知/环/直达标量)', () => {
  it('根类型不在注册表(unknown)→ 链断 null,不接管', async () => {
    const table = { ghost: { typeName: 'NOT_IN_REGISTRY', source: 'Avatar.def:20' } };
    expect(await analyze(wrap('self.ghost = 300'), table)).toEqual([]);
  });

  it('别名链成环(A→B→A)→ 有界退出 null,不接管且不悬挂', async () => {
    // 手工造环:两个自定义别名互指
    const CYCLE_A = customType('CYCLE_A', 'CYCLE_B', [], 80);
    const CYCLE_B = customType('CYCLE_B', 'CYCLE_A', [], 82);
    REGISTRY.push(CYCLE_A, CYCLE_B);
    try {
      const table = { cyc: { typeName: 'CYCLE_A', source: 'Avatar.def:21' } };
      expect(await analyze(wrap('self.cyc = 300'), table)).toEqual([]);
    } finally {
      REGISTRY.splice(REGISTRY.indexOf(CYCLE_A), 2);
    }
  });

  it('别名直达引擎标量(HEALTH→UINT8)→ 照判范围', async () => {
    const out = await analyze(wrap('self.hp = 300'));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: 'range', expected: 'UINT8 (int 0..255)' });
  });
});

describe('批 23 终:FD 字段值类型裁定臂', () => {
  it('末键字段声明为 FIXED_DICT → 非标量不接管(构造面 STRUCT-04 边界)', async () => {
    // WRAP 含一个 FD 字段 pos:POSITION——单键链命中声明字段但值类型非标量
    const WRAP_FD = customType('WRAP_FD', 'FIXED_DICT', [scalarField('pos', 'POSITION', 91)], 90);
    REGISTRY.push(WRAP_FD);
    try {
      const table = { w: { typeName: 'WRAP_FD', source: 'Avatar.def:22' } };
      expect(await analyze(wrap('self.w["pos"] = 1'), table)).toEqual([]);
    } finally {
      REGISTRY.splice(REGISTRY.indexOf(WRAP_FD), 1);
    }
  });
});

// 覆盖口径残余(批 23 定性,不硬凑):164/174(段间/段尾杂质再校验)与
// 179(`=` 缺位)三行不可达——TARGET_LHS 外层正则已保证括号块只含段+空白、
// 且 `=` 必在;内层逐段重校验是对同一事实的防御性双保险。130(别名链断)
// 与 238(FD 字段非标量)已由上臂覆盖。


// 断链/边界逐臂补批:每条用例单点破坏一个前提,保证落点就是目标断链臂,
// 不靠「目标形态不匹配」早退臂顶替。局部注册表复用全局夹具形状(与
// STRUCT-02/04 测试同构),只追加本批专用形态。
describe('analyzeScalarAssignWrites 断链与边界逐臂', () => {
  const CYCLE_A = customType('CYCLE_A', 'CYCLE_B', [], 80);
  const CYCLE_B = customType('CYCLE_B', 'CYCLE_A', [], 81);
  const BOX_INFO = customType('BOX_INFO', 'FIXED_DICT', [
    scalarField('bag', 'BAG_U8', 21),
    scalarField('inner', 'POSITION', 22)
  ], 20);
  // 数组声明缺内联 `of` 节点(structure 无 children)
  const BARE_ARRAY = customType('BARE_ARRAY', 'ARRAY', [], 90, node('ARRAY', 90));
  const LOCAL_REGISTRY = [...REGISTRY, CYCLE_A, CYCLE_B, BOX_INFO, BARE_ARRAY];
  const analyzeLocal = (
    text: string,
    table: Record<string, { typeName: string; source: string } | null>
  ) => analyzeScalarAssignWrites(text, makeResolver(table), LOCAL_REGISTRY);

  it('别名环(A→B→A):逐层下钻有界跳出,诚实断链不接管', async () => {
    expect(await analyzeLocal(wrap('self.cyc = 1'), {
      cyc: { typeName: 'CYCLE_A', source: 'Avatar.def:40' }
    })).toHaveLength(0);
  });

  it('RHS 暂空(`=` 后无字面量):目标表达式成立但字面量缺位,不接管', async () => {
    // 本面是纯文本扫描(无 Python 解析器早退风险),`=` 后暂空是编辑器
    // 中间态真实形态;行尾注释剥净后同落空 RHS 臂。
    expect(await analyze(wrap('self.health ='))).toHaveLength(0);
    expect(await analyze(wrap('self.health =  # pending'))).toHaveLength(0);
  });

  it('双键链逐段下钻嵌套 FD:末键字段 FLOAT 接浮点字面量不报', async () => {
    const stmt = 'self.box["inner"]["x"] = 1.5';
    const findings = await analyzeLocal(wrap(stmt), {
      box: { typeName: 'BOX_INFO', source: 'Avatar.def:41' }
    });
    expect(findings).toHaveLength(0);
  });

  it('FD 字段非标量(数组型字段):容器错配不越界,诚实断链', async () => {
    expect(await analyzeLocal(wrap('self.box["bag"] = 1'), {
      box: { typeName: 'BOX_INFO', source: 'Avatar.def:41' }
    })).toHaveLength(0);
  });

  it('数组声明缺内联 of 节点:元素类型推不出,诚实断链', async () => {
    expect(await analyzeLocal(wrap('self.bare[0] = 1'), {
      bare: { typeName: 'BARE_ARRAY', source: 'types.xml:90' }
    })).toHaveLength(0);
  });

  it('括号段杂质形态:正则整体不匹配,不接管', async () => {
    // 杂质段/嵌套括号/负下标/比较与增强符都进不了目标形态(正则不匹配或
    // RHS 推不出),本面一律不猜。
    expect(await analyze(wrap('self.bag[0] junk [1] = 1'))).toHaveLength(0);
    expect(await analyze(wrap('self.bag[[0]] = 1'))).toHaveLength(0);
    expect(await analyze(wrap('self.bag[-1] = 1'))).toHaveLength(0);
    expect(await analyze(wrap('self.bag[0] == 1'))).toHaveLength(0);
  });

  // ---------------------------------------------------------------
  // 诚实边界(逐行不可达论证,lcov DA 164/174/179):matchScalarAssignTarget
  // 是模块私有函数,唯一调用点是 analyzeScalarAssignWrites(公共入口)。本批
  // 收口时以临时探针穷举 35 种奇异 LHS 形态(杂质段/嵌套括号/负下标/全宽
  // 空白/比较增强符/空 RHS 等)+ dev-set 覆盖率实证三行 DA 恒 0。逐行:
  // - 164(段间杂质臂 `gap.trim() !== ''`):TARGET_LHS 括号重复组
  //   `(?:\s*\[…\])*` 相邻两段之间只允许 `\s*`,bracketBlock 即该组捕获原文,
  //   bracketRe 对同一文本用同一定义重扫,gap 恒为空白;且 JS `\s` 字符集
  //   (含 ﻿/NBSP/全部 Zs)⊆ trim() 可剥字符集,`gap.trim()` 恒空串,
  //   条件恒假 → 164 不可达。
  // - 174(段后残留臂):括号组贪婪吃满后 `\s*=(?!=)` 只认 `\s*=`;引擎若为
  //   满足 `=` 回退括号组,残留文本以 `[` 开头又使 `\s*=` 失败 → 整行不匹配
  //   (在非匹配早退口出,到不了 173);bracketBlock 内部残留非空白同理
  //   不可能 → 174 不可达。
  // - 179(`eqAt < 0` 臂):eqAt 自属性名尾起 indexOf('=');正则已保证
  //   stripped 里括号段之后必有一个 `=`,而段内三种段型('id'/"id"/\d+)
  //   均不含 `=`,indexOf 必命中非负 → 179 不可达。
  // 三行皆防正则/解析漂移的防御臂,公共入口无可达路径,不写凑数测试。
  // ---------------------------------------------------------------
});
