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
  cellDataWriteFindingToItem,
  classifyCellDataWriteValue,
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
