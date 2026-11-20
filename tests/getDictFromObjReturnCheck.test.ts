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

describe('computeGetDictFromObjReturnFindings 体域/宇宙/绑定边界臂', () => {
  it('动态键(无字面量键)项不进字面量键集:缺键照报、字面量键零误报', () => {
    // parseDictPairs 对非字符串字面量键给 key=null(展开/动态键不进键集);
    // `**x` 裸展开在无冒号段即置 openUniverse(不入 pairs)。
    const text = [
      'class PositionSer:',
      '    def getDictFromObj(self, obj):',
      '        return {"x": 1.0, "y": 2.0, n: 3}',
      ''
    ].join('\n');
    const findings = computeGetDictFromObjReturnFindings(text, [bind(POSITION)]);
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe('missing');
    expect(findings[0].key).toBe('z');
  });

  it('非标量字段(ARRAY/自定义别名)值结构不裁定:非整数字面值零产出', () => {
    const BAG = customType('BAG', 'FIXED_DICT', [
      scalarField('slot_list', 'ARRAY', 22),
      scalarField('uid', 'UINT32', 24)
    ], 20, 'serializers.BagSer');
    const text = [
      'class BagSer:',
      '    def getDictFromObj(self, obj):',
      '        return {"slot_list": 1, "uid": 2}',
      ''
    ].join('\n');
    expect(computeGetDictFromObjReturnFindings(text, [bind(BAG)])).toHaveLength(0);
  });

  it('空绑定符号:该绑定跳过,其余绑定照常判', () => {
    const text = [
      'class PositionSer:',
      '    def getDictFromObj(self, obj):',
      '        return {"x": 1.0}',
      ''
    ].join('\n');
    const findings = computeGetDictFromObjReturnFindings(text, [
      { container: BOUNDS, symbol: '' },
      bind(POSITION)
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0].container).toBe('POSITION');
  });

  it('嵌套 def 域跳过:内层 return 字面量不判本方法,本方法 return 照判', () => {
    // 若不剥内层域,内层 `return {"w": 1}` 会被判成多键(第 2 条);实跑只有本
    // 方法 return 的缺键一条,即证明内层域被整块跳过。
    const text = [
      'class PositionSer:',
      '    def getDictFromObj(self, obj):',
      '        def nested():',
      '            return {"w": 1}',
      '        return {"x": 1.0, "y": 2.0}',
      ''
    ].join('\n');
    const findings = computeGetDictFromObjReturnFindings(text, [bind(POSITION)]);
    expect(findings).toHaveLength(1);
    expect(findings[0].anchor).toBe('return');
    expect(findings[0].kind).toBe('missing');
    expect(findings[0].key).toBe('z');
    expect(findings[0].line).toBe(4);
  });

  it('return 字面量超配对窗口:该 return 零产出不猜', () => {
    // matchDictBraces 的配对窗口上限 FIXED_DICT_CONSTRUCT_MAX_SPAN_LINES=100 行
    // (与构造点面同口径);字面量跨窗未闭合 → 整点不猜。语料是合法 Python:
    // 120 个字面量键的超大多字典面(键全在声明集外,若窗口够宽本该全报多键)。
    const N = 120;
    const entries = Array.from({ length: N }, (_, i) => `        "k${i}": 1,`);
    const text = [
      'class PositionSer:',
      '    def getDictFromObj(self, obj):',
      '        return {',
      ...entries,
      '        }',
      ''
    ].join('\n');
    expect(computeGetDictFromObjReturnFindings(text, [bind(POSITION)])).toHaveLength(0);
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
