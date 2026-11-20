/**
 * KSEM-SER-03:getDictFromObj 输出绑定 FIXED_DICT schema(纯核心)。
 *
 * 引擎真源(datatype.cpp FixedDictType::addToStreamEx):序列化出口缺键/错型
 * → 引擎静默写默认值,静态面提前抓出。夹具镜像 STRUCT-04 同构(builder 复用
 * 形状,值独立)。
 */

import { describe, expect, it } from 'vitest';
import {
  computeGetDictFromObjReturnFindings,
  fixedDictReturnFindingToItem,
  FIXED_DICT_RETURN_SCHEMA_DIAGNOSTIC_CODE,
  type FixedDictImplBinding
} from '../src/backend/getDictFromObjReturnCheck';
import type {
  CustomTypeInfo,
  CustomTypePropertyInfo,
  CustomTypeStructureChild,
  CustomTypeStructureNode
} from '../src/definitionWorkspace';

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
  implementedBy?: string,
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
    implementedBy,
    properties
  };
}

const POSITION = customType('POSITION', 'FIXED_DICT', [
  scalarField('x', 'FLOAT', 12),
  scalarField('y', 'FLOAT', 14),
  scalarField('z', 'FLOAT', 16)
], 10, 'serializers.PositionSer');

const BOUNDS = customType('BOUNDS', 'FIXED_DICT', [
  scalarField('uid', 'UINT8', 44),
  scalarField('count', 'UINT32', 45)
], 42, 'serializers.BoundsSer');

/** 绑定面:symbol = implementedBy 末段(生产装配 diagnostics.ts 同口径)。 */
const bind = (container: CustomTypeInfo): FixedDictImplBinding => ({
  container,
  symbol: (container.implementedBy ?? '').split('.').pop() ?? ''
});

describe('computeGetDictFromObjReturnFindings 缺键/多键/类型面', () => {
  it('直接 return 字面量缺键:锚 return,声明序字段名列出', () => {
    const text = [
      'class PositionSer:',
      '    def getDictFromObj(self, obj):',
      '        return {"x": 1.0, "y": 2.0}',
      ''
    ].join('\n');
    const findings = computeGetDictFromObjReturnFindings(text, [bind(POSITION)]);
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe('missing');
    expect(findings[0].anchor).toBe('return');
    expect(findings[0].key).toBe('z');
    expect(findings[0].container).toBe('POSITION');
    expect(findings[0].line).toBe(2);
  });

  it('多键:字面量键不在声明集,锚在键位', () => {
    const text = [
      'class PositionSer:',
      '    def getDictFromObj(self, obj):',
      '        return {"x": 1.0, "y": 2.0, "z": 3.0, "w": 4.0}',
      ''
    ].join('\n');
    const findings = computeGetDictFromObjReturnFindings(text, [bind(POSITION)]);
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe('extra');
    expect(findings[0].key).toBe('w');
    expect(findings[0].character).toBe(text.split('\n')[2].indexOf('"w"'));
  });

  it('字段值结构错配:标量字段值类不符,expected/actual 记账', () => {
    const text = [
      'class BoundsSer:',
      '    def getDictFromObj(self, obj):',
      '        return {"uid": "oops", "count": 1}',
      ''
    ].join('\n');
    const findings = computeGetDictFromObjReturnFindings(text, [bind(BOUNDS)]);
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe('type');
    expect(findings[0].key).toBe('uid');
    expect(findings[0].expected.length).toBeGreaterThan(0);
    expect(findings[0].actual.length).toBeGreaterThan(0);
    expect(findings[0].line).toBe(2);
  });

  it('裸名返回:锚构造写点(非 return 行)', () => {
    const text = [
      'class PositionSer:',
      '    def getDictFromObj(self, obj):',
      '        d = {"x": 1.0, "y": 2.0}',
      '        return d',
      ''
    ].join('\n');
    const findings = computeGetDictFromObjReturnFindings(text, [bind(POSITION)]);
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe('missing');
    expect(findings[0].anchor).toBe('construct');
    expect(findings[0].line).toBe(2); // 构造写点行
  });

  it('重绑定非字面量作废:不猜', () => {
    const text = [
      'class PositionSer:',
      '    def getDictFromObj(self, obj):',
      '        d = {"x": 1.0}',
      '        d = self.buildDict()',
      '        return d',
      ''
    ].join('\n');
    expect(computeGetDictFromObjReturnFindings(text, [bind(POSITION)])).toHaveLength(0);
  });

  it('未知 return 形态(调用/链):零产出', () => {
    const text = [
      'class PositionSer:',
      '    def getDictFromObj(self, obj):',
      '        return self.buildDict()',
      '',
      '    def buildDict(self):',
      '        return {}',
      ''
    ].join('\n');
    expect(computeGetDictFromObjReturnFindings(text, [bind(POSITION)])).toHaveLength(0);
  });

  it('键宇宙开放:** 展开缺键不报、字面量多键照报', () => {
    const text = [
      'class PositionSer:',
      '    def getDictFromObj(self, obj):',
      '        return {**base, "w": 1}',
      ''
    ].join('\n');
    const findings = computeGetDictFromObjReturnFindings(text, [bind(POSITION)]);
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe('extra');
    expect(findings[0].key).toBe('w');
  });

  it('早退多 return:各自字面量各判各', () => {
    const text = [
      'class PositionSer:',
      '    def getDictFromObj(self, obj):',
      '        if not obj:',
      '            return {"x": 1.0}',
      '        return {"x": 1.0, "y": 2.0}',
      ''
    ].join('\n');
    const findings = computeGetDictFromObjReturnFindings(text, [bind(POSITION)]);
    expect(findings).toHaveLength(2);
    // 缺字段面一次列全(声明序逗号串,与构造点同口径)
    expect(findings.map(f => f.key)).toEqual(['y, z', 'z']);
    expect(findings.every(f => f.anchor === 'return')).toBe(true);
  });

  it('docstring/注释掩码:假形态零产出', () => {
    const text = [
      'class PositionSer:',
      '    def getDictFromObj(self, obj):',
      '        """return {"oops": 1}"""',
      '        # return {"oops": 1}',
      '        return {"x": 1.0, "y": 2.0, "z": 3.0}',
      ''
    ].join('\n');
    expect(computeGetDictFromObjReturnFindings(text, [bind(POSITION)])).toHaveLength(0);
  });

  it('方法体收尾:def 缩进为界,后续方法不串域', () => {
    const text = [
      'class PositionSer:',
      '    def getDictFromObj(self, obj):',
      '        return {"x": 1.0, "y": 2.0, "z": 3.0}',
      '',
      '    def getDictFromObjShadow(self, obj):',
      '        return {"w": 1}',
      ''
    ].join('\n');
    expect(computeGetDictFromObjReturnFindings(text, [bind(POSITION)])).toHaveLength(0);
  });

  it('类不可解析/方法缺失:零产出(userTypeContract lane 兜底)', () => {
    const noClass = [
      'def getDictFromObj(obj):',
      '    return {}',
      ''
    ].join('\n');
    expect(computeGetDictFromObjReturnFindings(noClass, [bind(POSITION)])).toHaveLength(0);
    const noMethod = [
      'class PositionSer:',
      '    def other(self):',
      '        return {}',
      ''
    ].join('\n');
    expect(computeGetDictFromObjReturnFindings(noMethod, [bind(POSITION)])).toHaveLength(0);
  });

  it('同名多类歧义:零产出不猜', () => {
    const text = [
      'class PositionSer:',
      '    def getDictFromObj(self, obj):',
      '        return {}',
      '',
      'class PositionSer:',
      '    def getDictFromObj(self, obj):',
      '        return {"x": 1.0}',
      ''
    ].join('\n');
    expect(computeGetDictFromObjReturnFindings(text, [bind(POSITION)])).toHaveLength(0);
  });

  it('多绑定同文件:各自类各自容器互不串', () => {
    const text = [
      'class PositionSer:',
      '    def getDictFromObj(self, obj):',
      '        return {"x": 1.0, "y": 2.0}',
      '',
      'class BoundsSer:',
      '    def getDictFromObj(self, obj):',
      '        return {"uid": 1, "count": 2}',
      ''
    ].join('\n');
    const findings = computeGetDictFromObjReturnFindings(text, [bind(POSITION), bind(BOUNDS)]);
    expect(findings).toHaveLength(1);
    expect(findings[0].container).toBe('POSITION');
    expect(findings[0].key).toBe('z');
  });

  it('无绑定:零产出', () => {
    expect(computeGetDictFromObjReturnFindings('class A:\n    pass\n', [])).toHaveLength(0);
  });
});

describe('fixedDictReturnFindingToItem', () => {
  it('形状与构造点同构,code=kbengine.fixedDictReturnSchema', () => {
    const text = [
      'class PositionSer:',
      '    def getDictFromObj(self, obj):',
      '        return {"x": 1.0}',
      ''
    ].join('\n');
    const findings = computeGetDictFromObjReturnFindings(text, [bind(POSITION)]);
    expect(findings).toHaveLength(1);
    const item = fixedDictReturnFindingToItem(findings[0]);
    expect(item.code).toBe(FIXED_DICT_RETURN_SCHEMA_DIAGNOSTIC_CODE);
    expect(item.source).toBe('kbengine');
    expect(item.severity).toBe('Warning');
    expect(item.range.start.line).toBe(2);
    expect(item.range.start.character).toBe(text.split('\n')[2].indexOf('{'));
  });
});

// ---------------------------------------------------------------------------
// 批 14 容错臂:spread 宇宙开放项/动态键不进键集、非标量字段类型不猜结构面、
// 绑定无 symbol 零产出、嵌套 def 块整块跳过(域诚实)、return 花括号未闭合跳过。
// ---------------------------------------------------------------------------
describe('computeGetDictFromObjReturnFindings 容错臂(批 14)', () => {
  const PACK = customType('PACK', 'FIXED_DICT', [
    scalarField('x', 'FLOAT', 22),
    scalarField('y', 'FLOAT', 24)
  ], 20, 'serializers.PackSer');

  it('spread 裸展开段:宇宙开放,缺键不判', () => {
    const spread = [
      'class PackSer:',
      '    def getDictFromObj(self, obj):',
      '        return {"x": 1.0, **rest}',
      ''
    ].join('\n');
    expect(computeGetDictFromObjReturnFindings(spread, [bind(PACK)])).toEqual([]);
  });

  it('动态键(带冒号)不进字面量键集,但宇宙不开放:缺键照判', () => {
    // 语义口径与 dictFormatDerivation 一致:`**r` 裸段才开宇宙;`k: 1.0` 动态键
    // 是"键不可判"不是"宇宙开放"——y 是否被 k 覆盖不可证,但 x/y 声明集里 y
    // 缺席是可判事实,照报 missing(引擎静默默认值面)。
    const dynamic = [
      'class PackSer:',
      '    def getDictFromObj(self, obj):',
      '        return {"x": 1.0, k: 1.0}',
      ''
    ].join('\n');
    const findings = computeGetDictFromObjReturnFindings(dynamic, [bind(PACK)]);
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe('missing');
    expect(findings[0].key).toBe('y');
  });

  it('非标量字段类型(ARRAY)不猜结构面:值再离谱也不报', () => {
    const BAG = customType('BAG', 'FIXED_DICT', [
      scalarField('items', 'ARRAY', 32),
      scalarField('x', 'FLOAT', 34)
    ], 30, 'serializers.BagSer');
    const text = [
      'class BagSer:',
      '    def getDictFromObj(self, obj):',
      '        return {"items": "not a list", "x": 1.0}',
      ''
    ].join('\n');
    expect(computeGetDictFromObjReturnFindings(text, [bind(BAG)])).toEqual([]);
  });

  it('绑定无 symbol → 零产出(不冒称解析到类)', () => {
    const text = [
      'class PackSer:',
      '    def getDictFromObj(self, obj):',
      '        return {"x": 1.0}',
      ''
    ].join('\n');
    expect(computeGetDictFromObjReturnFindings(text, [{ container: PACK, symbol: '' }])).toEqual([]);
  });

  it('嵌套 def 块整块跳过:内层 return 不冒称本方法出口(域诚实)', () => {
    const text = [
      'class PackSer:',
      '    def getDictFromObj(self, obj):',
      '        def inner(other):',
      '            return {"ghost": 1.0}',
      '        return {"x": 1.0, "y": 2.0}',
      ''
    ].join('\n');
    // ghost 是多键(不在 PACK 声明集),若内层 return 被误收必报 extra;跳块 → 零产出
    expect(computeGetDictFromObjReturnFindings(text, [bind(PACK)])).toEqual([]);
  });

  it('return 花括号未闭合:配对失败整行跳过,不猜半截字面量', () => {
    const text = [
      'class PackSer:',
      '    def getDictFromObj(self, obj):',
      '        return {"x": 1.0, "y": 2.0',
      ''
    ].join('\n');
    expect(computeGetDictFromObjReturnFindings(text, [bind(PACK)])).toEqual([]);
  });
});
