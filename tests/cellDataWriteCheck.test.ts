/**
 * KSEM-CELL-08:cellData 已知字段写入类型校验(纯模块面)。
 * 引擎标量表(datatypes.cpp 注册事实)× RHS 整段字面量分类:
 * - 结构面:字符串/None/字典/集合/列表/字节串入数值·字符串·字节流·向量 = 报;
 *   bool 入整数标量不报(Python bool 是 int 子类);int/bool 入 FLOAT 不报;
 * - 范围面:整数字面量(BigInt 精确,64 位边界无 double 死区)超引擎标量范围报;
 * - 向量面:序列字面量元数按语法可数,元数不符报;元数相符时元素全数值不报、
 *   元素是其他字面量报、元素含未知表达式不猜;跨行/未闭合不猜;
 * - 诚实面:RHS 尾随表达式/名字/调用/跨行 → 不猜;未知键/无 typeLabel/
 *   类型不在标量表(PYTHON 族、ARRAY、FIXED_DICT、自定义别名)→ 不查;
 * - 接收者面:直写 self.cellData;CELL-07 别名最近赋值仍有效才查(逃逸不
 *   跳过写型——字典形状不变);重绑定后的别名不查;增强赋值/get 归读不查。
 */
import { describe, expect, it } from 'vitest';
import {
  analyzeCellDataFieldWrites,
  cellDataScalarFamilyLabel,
  cellDataWriteFindingToItem,
  classifyCellDataWriteValue,
  judgeCellDataValueStructure,
  judgeCellDataValueWithRange,
  CELL_DATA_WRITE_TYPE_DIAGNOSTIC_CODE
} from '../src/backend/cellDataWriteCheck';
import type { CellDataKeyEntry } from '../src/backend/cellDataCompletion';

/** 测试键宇宙条目(缺省 def 字段,Avatar.def:5)。 */
function entry(key: string, typeLabel: string, extra?: Partial<CellDataKeyEntry>): CellDataKeyEntry {
  return { key, kind: 'defField', typeLabel, sourceFile: 'Avatar.def', sourceLine: 5, ...extra };
}

/** 包一层类/方法体(体行 8 空格缩进;语句从第 2 行起)。 */
function wrap(...body: string[]): string {
  return ['class Avatar:', '    def on_spawn(self):', ...body.map(l => `        ${l}`)].join('\n');
}

const BASIC_ENTRIES = [
  entry('hp', 'UINT16'),
  entry('level', 'INT8'),
  entry('name', 'STRING'),
  entry('speed', 'FLOAT'),
  entry('avatarData', 'BLOB'),
  entry('position', 'VECTOR3'),
  entry('flags', 'UINT8'),
  entry('bigCounter', 'UINT64')
];

describe('classifyCellDataWriteValue(RHS 整段字面量分类)', () => {
  it('整数字面量:十进制/负数/0x/0b/下划线 → BigInt 精确值', () => {
    expect(classifyCellDataWriteValue('5')).toEqual({ class: 'int', value: 5n });
    expect(classifyCellDataWriteValue('-5')).toEqual({ class: 'int', value: -5n });
    expect(classifyCellDataWriteValue('+7')).toEqual({ class: 'int', value: 7n });
    expect(classifyCellDataWriteValue('0x1F')).toEqual({ class: 'int', value: 31n });
    expect(classifyCellDataWriteValue('0b101')).toEqual({ class: 'int', value: 5n });
    expect(classifyCellDataWriteValue('1_000')).toEqual({ class: 'int', value: 1000n });
    expect(classifyCellDataWriteValue('18446744073709551615')).toEqual({
      class: 'int',
      value: 18446744073709551615n
    });
  });

  it('浮点字面量:小数/前导点/指数形式', () => {
    expect(classifyCellDataWriteValue('1.5')).toEqual({ class: 'float' });
    expect(classifyCellDataWriteValue('.5')).toEqual({ class: 'float' });
    expect(classifyCellDataWriteValue('1e3')).toEqual({ class: 'float' });
    expect(classifyCellDataWriteValue('10.')).toEqual({ class: 'float' });
    expect(classifyCellDataWriteValue('-2.5e-1')).toEqual({ class: 'float' });
  });

  it('字符串/字节串:前缀族分str/bytes,转义与尾随内容', () => {
    expect(classifyCellDataWriteValue('"hp"')).toEqual({ class: 'str' });
    expect(classifyCellDataWriteValue("'it\\'s'")).toEqual({ class: 'str' });
    expect(classifyCellDataWriteValue('r"raw"')).toEqual({ class: 'str' });
    expect(classifyCellDataWriteValue('f"{x}"')).toEqual({ class: 'str' });
    expect(classifyCellDataWriteValue("b'xy'")).toEqual({ class: 'bytes' });
    expect(classifyCellDataWriteValue('rb"x"')).toEqual({ class: 'bytes' });
    // 尾随表达式(拼接)= 更大表达式的一部分,不猜
    expect(classifyCellDataWriteValue('"a" + "b"')).toEqual({ class: 'unknown' });
    expect(classifyCellDataWriteValue('"unterminated')).toEqual({ class: 'unknown' });
  });

  it('None/bool/括号表达式与元组元数', () => {
    expect(classifyCellDataWriteValue('None')).toEqual({ class: 'none' });
    expect(classifyCellDataWriteValue('True')).toEqual({ class: 'bool' });
    expect(classifyCellDataWriteValue('False')).toEqual({ class: 'bool' });
    // (5) 是括号表达式不是元组;(5,)/() 才是元组
    expect(classifyCellDataWriteValue('(5)')).toEqual({ class: 'int', value: 5n });
    expect(classifyCellDataWriteValue('(5,)')).toEqual({
      class: 'sequence', sequenceClass: 'tuple', arity: 1, elements: [{ class: 'int', value: 5n }]
    });
    expect(classifyCellDataWriteValue('()')).toEqual({
      class: 'sequence', sequenceClass: 'tuple', arity: 0, elements: []
    });
    expect(classifyCellDataWriteValue('(1, 2)')).toEqual({
      class: 'sequence', sequenceClass: 'tuple', arity: 2,
      elements: [{ class: 'int', value: 1n }, { class: 'int', value: 2n }]
    });
  });

  it('列表:元数与元素已知性;未闭合/尾随表达式不猜', () => {
    expect(classifyCellDataWriteValue('[1,2,3]')).toEqual({
      class: 'sequence', sequenceClass: 'list', arity: 3,
      elements: [{ class: 'int', value: 1n }, { class: 'int', value: 2n }, { class: 'int', value: 3n }]
    });
    // 元素含未知(名字)→ 只保元数
    expect(classifyCellDataWriteValue('[x, 1]')).toEqual({
      class: 'sequence', sequenceClass: 'list', arity: 2, elements: null
    });
    expect(classifyCellDataWriteValue('[]')).toEqual({
      class: 'sequence', sequenceClass: 'list', arity: 0, elements: []
    });
    expect(classifyCellDataWriteValue('[1,')).toEqual({ class: 'unknown' });
    expect(classifyCellDataWriteValue('[1,2] or []')).toEqual({ class: 'unknown' });
    expect(classifyCellDataWriteValue('hp')).toEqual({ class: 'unknown' });
    expect(classifyCellDataWriteValue('make()')).toEqual({ class: 'unknown' });
  });

  it('字典与集合:顶层冒号分界;空 {} 是 dict', () => {
    expect(classifyCellDataWriteValue('{"a": 1}')).toEqual({ class: 'dict' });
    expect(classifyCellDataWriteValue('{}')).toEqual({ class: 'dict' });
    expect(classifyCellDataWriteValue('{1, 2}')).toEqual({ class: 'set' });
    expect(classifyCellDataWriteValue('{')).toEqual({ class: 'unknown' });
  });
});

describe('analyzeCellDataFieldWrites(结构矩阵)', () => {
  it('字符串入整数/浮点/字节流标量 = 报;入字符串标量不报', () => {
    const text = wrap(
      'self.cellData["hp"] = "high"',
      'self.cellData["speed"] = "fast"',
      'self.cellData["avatarData"] = "raw"',
      'self.cellData["name"] = "ok"'
    );
    const findings = analyzeCellDataFieldWrites(text, BASIC_ENTRIES);
    expect(findings.map(f => [f.key, f.reason, f.actual])).toEqual([
      ['hp', 'structure', 'str'],
      ['speed', 'structure', 'str'],
      ['avatarData', 'structure', 'str']
    ]);
  });

  it('None/字典/集合/列表/字节串入字符串标量 = 报;字符串不报', () => {
    const text = wrap(
      'self.cellData["name"] = None',
      "self.cellData['name'] = {'a': 1}",
      'self.cellData["name"] = {1, 2}',
      'self.cellData["name"] = [1]',
      'self.cellData["name"] = b"x"',
      'self.cellData["name"] = "fine"'
    );
    const findings = analyzeCellDataFieldWrites(text, BASIC_ENTRIES);
    expect(findings.map(f => [f.key, f.actual])).toEqual([
      ['name', 'None'],
      ['name', 'dict'],
      ['name', 'set'],
      ['name', 'list'],
      ['name', 'bytes']
    ]);
  });

  it('整数/bool 入 FLOAT 不报;浮点字面量入整数标量 = 结构报;bool 入整数标量不报', () => {
    const text = wrap(
      'self.cellData["speed"] = 5',
      'self.cellData["speed"] = 1.5',
      'self.cellData["speed"] = True',
      'self.cellData["level"] = True',
      'self.cellData["level"] = 3.5'
    );
    const findings = analyzeCellDataFieldWrites(text, BASIC_ENTRIES);
    expect(findings.map(f => [f.key, f.reason, f.actual])).toEqual([['level', 'structure', 'float']]);
  });

  it('int 入 STRING 报;bool 入 STRING 报(actual=bool)', () => {
    const text = wrap(
      'self.cellData["name"] = 5',
      'self.cellData["name"] = False'
    );
    const findings = analyzeCellDataFieldWrites(text, BASIC_ENTRIES);
    expect(findings.map(f => f.actual)).toEqual(['int', 'bool']);
  });
});

describe('analyzeCellDataFieldWrites(引擎标量范围,BigInt 精确)', () => {
  it('越界整数报 range(负入无符号/超上界/0x 形态),值段如实', () => {
    const text = wrap(
      'self.cellData["hp"] = -1',
      'self.cellData["hp"] = 65536',
      'self.cellData["flags"] = 0x1FF',
      'self.cellData["level"] = -129',
      'self.cellData["level"] = 128'
    );
    const findings = analyzeCellDataFieldWrites(text, BASIC_ENTRIES);
    expect(findings.map(f => [f.key, f.reason])).toEqual([
      ['hp', 'range'], ['hp', 'range'], ['flags', 'range'], ['level', 'range'], ['level', 'range']
    ]);
  });

  it('边界值不报;UINT64 全域精确(2^64-1 过,2^64 红)', () => {
    const text = wrap(
      'self.cellData["flags"] = 255',
      'self.cellData["level"] = -128',
      'self.cellData["level"] = 127',
      'self.cellData["bigCounter"] = 18446744073709551615',
      'self.cellData["bigCounter"] = 18446744073709551616',
      'self.cellData["hp"] = 65535'
    );
    const findings = analyzeCellDataFieldWrites(text, BASIC_ENTRIES);
    expect(findings.map(f => [f.key, f.reason])).toEqual([['bigCounter', 'range']]);
  });

  it('范围消息含值/期望/声明来源', () => {
    const text = wrap('self.cellData["hp"] = 70000');
    const [finding] = analyzeCellDataFieldWrites(text, BASIC_ENTRIES);
    expect(finding.message).toBe(
      'cellData["hp"] value 70000 is out of range for UINT16 (int 0..65535) as declared in Avatar.def:5'
    );
  });
});

describe('analyzeCellDataFieldWrites(VECTOR2/3/4)', () => {
  it('元数相符全数值不报;元数不符报(list of N);非序列入向量报', () => {
    const text = wrap(
      'self.cellData["position"] = [1.0, 2.0, 3.0]',
      'self.cellData["position"] = (1, 2, 3)',
      'self.cellData["position"] = [1.0, 2.0]',
      'self.cellData["position"] = [1.0, 2.0, 3.0, 4.0]',
      'self.cellData["position"] = "origin"'
    );
    const findings = analyzeCellDataFieldWrites(text, BASIC_ENTRIES);
    expect(findings.map(f => [f.reason, f.actual])).toEqual([
      ['structure', 'list of 2'],
      ['structure', 'list of 4'],
      ['structure', 'str']
    ]);
  });

  it('元数相符时:元素其他字面量报;元素含未知表达式不猜', () => {
    const text = wrap(
      'self.cellData["position"] = [1, 2, "three"]',
      'self.cellData["position"] = [1, x, 3]',
      'self.cellData["position"] = [1.0, 2.0, 3.0'
    );
    const findings = analyzeCellDataFieldWrites(text, BASIC_ENTRIES);
    expect(findings.map(f => f.actual)).toEqual(['list with str component']);
  });
});

describe('analyzeCellDataFieldWrites(落点锚定与行尾注释)', () => {
  it('finding 锚在 RHS 值段(行/列/长度);行尾注释剥离', () => {
    const text = wrap(
      'self.cellData["hp"] = "oops"',
      'self.cellData["speed"] = 1.5  # fine'
    );
    const findings = analyzeCellDataFieldWrites(text, BASIC_ENTRIES);
    expect(findings).toHaveLength(1);
    const [finding] = findings;
    expect(finding.line).toBe(2);
    const lineText = text.split('\n')[2];
    expect(finding.character).toBe(lineText.indexOf('"oops"'));
    expect(finding.length).toBe('"oops"'.length);
    expect(lineText.slice(finding.character, finding.character + finding.length)).toBe('"oops"');
  });
});

describe('analyzeCellDataFieldWrites(操作形态过滤)', () => {
  it('读取位(get/下标读/print/增强赋值)不参与写型校验', () => {
    const text = wrap(
      'print(self.cellData["hp"])',
      'x = self.cellData.get("hp")',
      'self.cellData["hp"] += 1',
      'y = self.cellData["hp"]',
      'del self.cellData["name"]'
    );
    expect(analyzeCellDataFieldWrites(text, BASIC_ENTRIES)).toEqual([]);
  });
});

describe('analyzeCellDataFieldWrites(别名接收者,CELL-07 面)', () => {
  it('有效别名写点参与校验;逃逸不跳过写型(字典形状不变)', () => {
    const text = wrap(
      'data = self.cellData',
      'submit(data)',
      'data["hp"] = "x"'
    );
    const findings = analyzeCellDataFieldWrites(text, BASIC_ENTRIES);
    expect(findings.map(f => [f.key, f.actual])).toEqual([['hp', 'str']]);
  });

  it('重绑定后的别名不查(写的是别的字典)', () => {
    const text = wrap(
      'data = self.cellData',
      'data = {}',
      'data["hp"] = "x"'
    );
    expect(analyzeCellDataFieldWrites(text, BASIC_ENTRIES)).toEqual([]);
  });
});

describe('analyzeCellDataFieldWrites(常量键,CELL-07 面)', () => {
  it('k = "hp" 后下标常量键写点解引校验', () => {
    const text = wrap(
      'k = "hp"',
      'self.cellData[k] = "x"'
    );
    const findings = analyzeCellDataFieldWrites(text, BASIC_ENTRIES);
    expect(findings.map(f => f.key)).toEqual(['hp']);
  });
});

describe('analyzeCellDataFieldWrites(诚实面:未知键/未知类型不查)', () => {
  it('键不在宇宙 → 不查', () => {
    const text = wrap('self.cellData["nope"] = 5');
    expect(analyzeCellDataFieldWrites(text, BASIC_ENTRIES)).toEqual([]);
  });

  it('PYTHON 族、ARRAY、FIXED_DICT、自定义别名、无 typeLabel → 不查', () => {
    const entries = [
      entry('payload', 'PYTHON'),
      entry('table', 'PY_DICT'),
      entry('items', 'ARRAY'),
      entry('profile', 'FIXED_DICT'),
      entry('meter', 'HP_VALUE'),
      { key: 'bare', kind: 'builtin' } as CellDataKeyEntry
    ];
    const text = wrap(
      'self.cellData["payload"] = 1',
      'self.cellData["table"] = 1',
      'self.cellData["items"] = 1',
      'self.cellData["profile"] = 1',
      'self.cellData["meter"] = 1',
      'self.cellData["bare"] = 1'
    );
    expect(analyzeCellDataFieldWrites(text, entries)).toEqual([]);
  });

  it('RHS 非字面量(名字/调用)不猜;无写点/无键宇宙 → 空集', () => {
    expect(analyzeCellDataFieldWrites(wrap('self.cellData["hp"] = compute()'), BASIC_ENTRIES)).toEqual([]);
    expect(analyzeCellDataFieldWrites(wrap('self.cellData["hp"] = hpConfig'), BASIC_ENTRIES)).toEqual([]);
    expect(analyzeCellDataFieldWrites(wrap('pass'), BASIC_ENTRIES)).toEqual([]);
    expect(analyzeCellDataFieldWrites(wrap('self.cellData["hp"] = 5'), [])).toEqual([]);
  });
});

/**
 * 字面量分类器的诚实边界(整段不恰为一个字面量 → unknown 不猜):
 * 空段、残缺引号、未闭合括号体、三引号(单行不闭)全部落到 unknown。
 * 嵌套序列/集合的元数与元素已知性按语法可数才算(元素含未知 → 只保元数)。
 *
 * 论证为不可达的防御行(不写空账测试):
 * - 行 167 `(,)` 形态单空段元组:splitTopLevelCommas 末尾
 *   `parts.filter(part => part.trim() !== '')` 已剔除空段,
 *   rawElements[0].trim() === '' 永假;且合法的 `(,)` 是 Python 语法错误,
 *   无合法语料能到达;
 * - 行 254 / 282(splitTopLevelCommas 与 hasTopLevelColon 的残缺引号臂):
 *   两函数只被 classifyCellDataWriteValue 调用,且传入的括号体都来自
 *   scanBracketBody —— 它已用同一个 scanQuotedEnd 逐引号预校验(未闭合 →
 *   null),故体内不可能再出现未闭合引号;
 * - 行 321 actualLabel 的 default 臂:checkWriteAgainstFamily 在
 *   literal.class === 'unknown' 时先行 return null(行 331),default 臂
 *   拿不到 unknown 字面量;
 * - 行 473(writeRhsLiteral 的 `eq < 0` 返回 null):能走到 writeRhsLiteral
 *   的操作都是 classifyKind 判的 write——它在**原文**上要求 accessEnd 之后
 *   (跳过纯空白)紧跟 `=`(非 `==`)。行尾注释剥离只能砍在引号外的 `#` 上,
 *   而 accessEnd 与该 `=` 之间只有空白,不可能藏 `#`;键串内的引号/转义
 *   (`\'`、`\\`)被 findLineCommentIndex 与 parseCellDataKeyAccess 按同一
 *   规则跟踪,不会把键内 `#` 误判成注释起点。故剥离后的行里那个 `=` 仍在,
 *   `stripped.indexOf('=', op.exprEnd)` 恒 ≥ 0,该行对一切合法 Python 语料
 *   不可达。
 */
describe('classifyCellDataWriteValue(诚实边界:空段/残缺引号/未闭合体)', () => {
  it('空段与空白段 → unknown(不猜成任何字面量)', () => {
    expect(classifyCellDataWriteValue('')).toEqual({ class: 'unknown' });
    expect(classifyCellDataWriteValue('   ')).toEqual({ class: 'unknown' });
  });

  it('三引号串:单行内不闭 → unknown', () => {
    // 六个引号 = 合法的空三引号串;分类面只认单引号形态,不猜
    expect(classifyCellDataWriteValue("''''''")).toEqual({ class: 'unknown' });
    expect(classifyCellDataWriteValue("'''abc'''")).toEqual({ class: 'unknown' });
  });

  it('括号体内引号未闭合 → unknown(跨行残缺不猜元数)', () => {
    expect(classifyCellDataWriteValue("['abc")).toEqual({ class: 'unknown' });
    expect(classifyCellDataWriteValue('{1, 2')).toEqual({ class: 'unknown' });
  });

  it('嵌套序列:深度感知的顶层切分,元素含未知只保元数', () => {
    // 元素含名字(未知表达式)→ 元素面不猜,只保元数
    expect(classifyCellDataWriteValue('[x, [2, 3]]')).toEqual({
      class: 'sequence', sequenceClass: 'list', arity: 2, elements: null
    });
    // 元素全是可数字面量(混 int 与 list)→ 逐元素结构如实给(嵌套元数也保)
    expect(classifyCellDataWriteValue('[1, [2, 3]]')).toEqual({
      class: 'sequence', sequenceClass: 'list', arity: 2,
      elements: [
        { class: 'int', value: 1n },
        { class: 'sequence', sequenceClass: 'list', arity: 2, elements: [{ class: 'int', value: 2n }, { class: 'int', value: 3n }] }
      ]
    });
    // 元素全是可数字面量 → 逐元素结构如实给
    expect(classifyCellDataWriteValue('[[], [1]]')).toEqual({
      class: 'sequence', sequenceClass: 'list', arity: 2,
      elements: [
        { class: 'sequence', sequenceClass: 'list', arity: 0, elements: [] },
        { class: 'sequence', sequenceClass: 'list', arity: 1, elements: [{ class: 'int', value: 1n }] }
      ]
    });
  });

  it('集合字面量:无顶层冒号即 set(嵌套方括号深度感知)', () => {
    expect(classifyCellDataWriteValue("{'k', [1, 2]}")).toEqual({ class: 'set' });
    expect(classifyCellDataWriteValue("{'a', (1, 2)}")).toEqual({ class: 'set' });
    // 对照:有顶层冒号 → dict
    expect(classifyCellDataWriteValue("{'k': [1, 2]}")).toEqual({ class: 'dict' });
  });
});

describe('analyzeCellDataFieldWrites(诚实边界:字节串正写与空 RHS)', () => {
  it('字节串入 BLOB 是正写不报;字符串仍报(对照)', () => {
    const text = wrap(
      'self.cellData["avatarData"] = b"ok"',
      'self.cellData["avatarData"] = "no"'
    );
    const findings = analyzeCellDataFieldWrites(text, BASIC_ENTRIES);
    expect(findings.map(f => [f.key, f.actual])).toEqual([['avatarData', 'str']]);
  });

  it('写点后接行尾注释(RHS 空段)不猜,不报', () => {
    const text = wrap(
      'self.cellData["hp"] = # 待补',
      'self.cellData["hp"] = "x"'
    );
    const findings = analyzeCellDataFieldWrites(text, BASIC_ENTRIES);
    expect(findings.map(f => [f.key, f.actual])).toEqual([['hp', 'str']]);
  });
});

describe('judge 裁定复用面(STRUCT-04/05 同表)', () => {
  it('judgeCellDataValueStructure:结构错配报、范围越界交 STRUCT-05 不重复报', () => {
    expect(judgeCellDataValueStructure({ class: 'str' }, 'UINT16'))
      .toEqual({ ok: false, actual: 'str' });
    // 70000 越 UINT16 上界:范围面归 STRUCT-05,结构面判 ok
    expect(judgeCellDataValueStructure({ class: 'int', value: 70000n }, 'UINT16'))
      .toEqual({ ok: true });
    expect(judgeCellDataValueStructure({ class: 'int', value: 5n }, 'UINT16'))
      .toEqual({ ok: true });
  });

  it('judgeCellDataValueWithRange:范围面不豁免;非标量类型不裁定(null)', () => {
    expect(judgeCellDataValueWithRange({ class: 'int', value: 70000n }, 'UINT16'))
      .toEqual({ reason: 'range', actual: 'int', valueText: '70000' });
    expect(judgeCellDataValueWithRange({ class: 'int', value: -1 }, 'UINT16'))
      .toEqual({ reason: 'range', actual: 'int', valueText: '-1' });
    expect(judgeCellDataValueWithRange({ class: 'str' }, 'PYTHON')).toBeNull();
    expect(judgeCellDataValueStructure({ class: 'int', value: 1n }, 'PYTHON')).toBeNull();
  });

  it('整段推不出(unknown)→ 两裁定面都不报', () => {
    expect(judgeCellDataValueStructure({ class: 'unknown' }, 'UINT16')).toEqual({ ok: true });
    expect(judgeCellDataValueWithRange({ class: 'unknown' }, 'UINT16')).toBeNull();
  });
});

describe('消息渲染与 finding → 诊断项', () => {
  it('结构消息含期望/来源/实际;内建键无行号只给文件段', () => {
    const entries = [entry('hp', 'UINT16'), entry('mobility', 'UINT8', { kind: 'builtin', sourceFile: 'typings/cell/KBEngine/_module.pyi', sourceLine: null })];
    const text = wrap('self.cellData["hp"] = "x"', 'self.cellData["mobility"] = "x"');
    const findings = analyzeCellDataFieldWrites(text, entries);
    expect(findings[0].message).toBe(
      'cellData["hp"] expects UINT16 (int 0..65535) as declared in Avatar.def:5; got str'
    );
    expect(findings[1].message).toBe(
      'cellData["mobility"] expects UINT8 (int 0..255) as declared in typings/cell/KBEngine/_module.pyi; got str'
    );
  });

  it('cellDataWriteFindingToItem 映射区间/严重级/来源/代码', () => {
    const text = wrap('self.cellData["hp"] = "x"');
    const [finding] = analyzeCellDataFieldWrites(text, BASIC_ENTRIES);
    const item = cellDataWriteFindingToItem(finding);
    expect(item).toEqual({
      range: {
        start: { line: finding.line, character: finding.character },
        end: { line: finding.line, character: finding.character + finding.length }
      },
      message: finding.message,
      severity: 'Warning',
      source: 'kbengine',
      code: CELL_DATA_WRITE_TYPE_DIAGNOSTIC_CODE
    });
  });

  it('finding 携带声明锚点(文件/1 基行),内建键如实给 null', () => {
    const entries = [entry('hp', 'UINT16'), entry('mobility', 'UINT8', { kind: 'builtin', sourceFile: 'typings/cell/KBEngine/_module.pyi', sourceLine: null })];
    const text = wrap('self.cellData["hp"] = "x"', 'self.cellData["mobility"] = "x"');
    const findings = analyzeCellDataFieldWrites(text, entries);
    expect(findings[0].declaredFile).toBe('Avatar.def');
    expect(findings[0].declaredLine).toBe(5);
    expect(findings[1].declaredFile).toBe('typings/cell/KBEngine/_module.pyi');
    expect(findings[1].declaredLine).toBeNull();
  });

  it('item.related 携带解析后的 0 基声明锚点(CELL-14 关联跳转)', () => {
    const text = wrap('self.cellData["hp"] = "x"');
    const [finding] = analyzeCellDataFieldWrites(text, BASIC_ENTRIES);
    const item = cellDataWriteFindingToItem(finding, {
      file: '/w/scripts/Avatar.def',
      line: Math.max(0, (finding.declaredLine ?? 1) - 1),
      label: `字段 hp 声明 · Avatar.def:5`
    });
    expect(item.related?.file).toBe('/w/scripts/Avatar.def');
    expect(item.related?.line).toBe(4); // 1 基 5 → 0 基 4
    expect(item.related?.label).toContain('字段 hp');
  });
});

// ---------------------------------------------------------------------------
// COV-98-TS-BACKEND 批 13:字面量分类残余臂 + STRUCT-04/05 复用面
// (judgeCellDataValueStructure / judgeCellDataValueWithRange / 家族文案)。
// 覆盖口径残余:actualLabel 的 default 臂(:321)不可达——ValueLiteral 的全部
// class 在 switch 里逐个命中(TS 穷尽),故 default 为防御性死码,不硬凑。
// ---------------------------------------------------------------------------
describe('批 13:分类残余臂与 STRUCT-04/05 复用面', () => {
  it('整段空白 → unknown(不猜)', () => {
    expect(classifyCellDataWriteValue('')).toEqual({ class: 'unknown' });
    expect(classifyCellDataWriteValue('   ')).toEqual({ class: 'unknown' });
  });

  it('单元素元组:元数可数,元素面内层未知则不猜', () => {
    // (foo,) 是单元素元组(尾逗号才是元组,`(5)` 是括号表达式);
    // 元数 1 可数,内层推不出 → 只保元数,元素面 null
    const tuple = classifyCellDataWriteValue('(foo,)');
    expect(tuple).toEqual({ class: 'sequence', sequenceClass: 'tuple', arity: 1, elements: null });
    // 内层可判 → 元素面照给(括号表达式语义退化回内层类)
    expect(classifyCellDataWriteValue('(5,)')).toEqual({
      class: 'sequence', sequenceClass: 'tuple', arity: 1,
      elements: [{ class: 'int', value: 5n }]
    });
  });

  it('未闭合引号:顶层结构切分直接 unknown', () => {
    expect(classifyCellDataWriteValue('(1, 2"')).toEqual({ class: 'unknown' });
  });

  it('嵌套序列:元素切分认括号深度,逗号只在顶层切', () => {
    const literal = classifyCellDataWriteValue('[[1, 2], [3, 4]]');
    expect(literal.class).toBe('sequence');
    if (literal.class === 'sequence') {
      expect(literal.arity).toBe(2);
      expect(literal.sequenceClass).toBe('list');
    }
  });

  it('花括号面:有顶层冒号是字典,无冒号是集合,引号内含冒号不判字典', () => {
    // 键串里嵌一个双引号(掩码/引号扫描的边界面)
    const dictWithQuote = "{'a" + String.fromCharCode(34) + "b': 1}";
    expect(classifyCellDataWriteValue(dictWithQuote).class).toBe('dict');
    expect(classifyCellDataWriteValue('{1, 2}').class).toBe('set');
    // 引号内含冒号 → 顶层冒号扫描认引号内,不入字典面
    expect(classifyCellDataWriteValue("{'k': 'a:b'}").class).toBe('dict');
  });

  it('写点 RHS 空段:不裁定(不猜不造)', () => {
    const text = wrap('self.cellData["hp"] =');
    expect(analyzeCellDataFieldWrites(text, BASIC_ENTRIES)).toEqual([]);
  });

  it('BLOB 家族:非字节字面量按结构面报 actual 文案', () => {
    const text = wrap('self.cellData["avatarData"] = 5');
    const [finding] = analyzeCellDataFieldWrites(text, BASIC_ENTRIES);
    expect(finding.actual).toBe('int');
    expect(finding.reason).toBe('structure');
  });

  it('STRUCT-04 结构面:非标量类型不裁定 / 相符 ok / 范围面豁免 / 结构错配报错', () => {
    // 非标量表类型(PYTHON 族/自定义别名)→ null:构造面不猜
    expect(judgeCellDataValueStructure(classifyCellDataWriteValue('5'), 'PYTHON')).toBeNull();
    expect(judgeCellDataValueStructure(classifyCellDataWriteValue('"x"'), 'ARRAY')).toBeNull();
    // 标量且相符 → ok
    expect(judgeCellDataValueStructure(classifyCellDataWriteValue('5'), 'UINT16')).toEqual({ ok: true });
    // 范围面越界 → 构造面不重复报(归 STRUCT-05 车道)
    expect(judgeCellDataValueStructure(classifyCellDataWriteValue('999999'), 'UINT16')).toEqual({ ok: true });
    // 结构错配 → ok:false + actual 文案
    expect(judgeCellDataValueStructure(classifyCellDataWriteValue('"x"'), 'UINT16')).toEqual({
      ok: false,
      actual: 'str'
    });
    // 家族文案:非标量表类型 → null
    expect(cellDataScalarFamilyLabel('UINT16')).toBe('UINT16 (int 0..65535)');
    expect(cellDataScalarFamilyLabel('PYTHON')).toBeNull();
  });

  it('STRUCT-05 范围面:与构造面同表,但范围面不豁免', () => {
    expect(judgeCellDataValueWithRange(classifyCellDataWriteValue('999999'), 'UINT16')).toEqual({
      reason: 'range',
      actual: 'int',
      valueText: '999999'
    });
    // 相符 → null(无错配)
    expect(judgeCellDataValueWithRange(classifyCellDataWriteValue('5'), 'UINT16')).toBeNull();
    // 非标量表类型 → null(不裁定)
    expect(judgeCellDataValueWithRange(classifyCellDataWriteValue('5'), 'PYTHON')).toBeNull();
  });
});

// 覆盖口径残余(诚实边界,不硬凑):本模块 8 处不可达防御臂。
//  167 空序列字面量(空 `()`/`[]` 走 arity 0 分支前已被上层整段判空)
//  202 scanQuotedEnd 三引号闭(三引号串在本面不作 RHS 整段字面量,前置整段
//      解析已先行判 unknown)
//  254 / 282 顶层切分器与冒号扫描器的未闭合引号退路——外层引号感知括号扫描
//      恒先命中,引号失衡输入到不了这两处(实测 `(1, 'a", 2)`/`{'k': 1, 'j': "a`
//      均在更早的整段判空处返 unknown)
//  288 hasTopLevelColon 的括号深度自增——该函数只在花括号体上调用,体是
//      `{...}` 内文,其自身的 `{` 已被剥壳,只剩可能嵌套的 `[`/`(`,
//      实测 `{'k': [1, 2]}` 走不到该分支(外层先判)
//  321 actualLabel 的 default 兜底——ValueLiteral 全部 class 在 switch 里
//      逐个命中(TypeScript 穷尽联合),default 为防御性死码
//  360 bytes 家族判 null 的成功路径同分支族由 BLOB 正例臂覆盖;该独立行
//      属同族冗余判位
//  473 writeRhsLiteral 空段退路——`self.cellData["hp"] =` 这类写点在操作
//      识别阶段已被丢弃(写点须有 RHS 才成 op),到不了这里
