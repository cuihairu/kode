/**
 * KSEM-SER-05:转换输出对象成员关联与校验(纯核心)。
 *
 * 引擎真源(entitydef/datatype.cpp:2435-2447 impl_getDictFromObj,树
 * 3082ab5 实测):getDictFromObj 体内对转换产物读不存在的成员 →
 * PyObject_CallFunction 返回 NULL → SCRIPT_ERROR_CHECK 记脚本错误并
 * parseDefaultStr("") 整体顶替(整张字典按默认值序列化);.get 静默返
 * None。结构推导(createObjFromDict 可解析 return:dict 字面量/别名/wire
 * 透传链)与校验面(getDictFromObj obj 入参字符串键读取对推导键集)分述;
 * 自定义转换不凭函数名推定结构(验收否定面)。夹具镜像 SER-04 同构。
 */

import { describe, it, expect } from 'vitest';
import {
  computeConvertedObjMemberFindings,
  computeConvertedObjStructure,
  convertedObjMemberFindingToItem,
  renderFixedDictOutputMemberMessage,
  FIXED_DICT_OUTPUT_MEMBER_SCHEMA_DIAGNOSTIC_CODE
} from '../src/backend/convertedObjMembers';
import {
  implBindingsForDocument,
  resolveCreateObjFromDictInputBindings,
  resolveImplMethodInputs
} from '../src/backend/createObjFromDictInput';
import type {
  CustomTypeInfo,
  CustomTypePropertyInfo,
  CustomTypeStructureChild,
  CustomTypeStructureNode
} from '../src/definitionWorkspace';

const TYPES_FILE = '/entity_defs/types.xml';
const IMPL_FILE = '/serializers_impl.py';

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
  pythonFilePath?: string
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
    structure: node(aliasType, line),
    implementedBy,
    pythonFilePath,
    properties
  };
}

const INNER = customType('INNER', 'FIXED_DICT', [
  scalarField('hp', 'UINT8', 32),
  scalarField('mp', 'UINT8', 34)
], 30, 'serializers_impl.InnerSer', IMPL_FILE);

const OUTER = customType('OUTER', 'FIXED_DICT', [
  scalarField('inner', 'INNER', 52),
  scalarField('uid', 'UINT32', 53)
], 50, 'serializers_impl.BagSer', IMPL_FILE);

/** 过滤/配对面:不同 impl 文件。 */
const REMOTE = customType('REMOTE', 'FIXED_DICT', [scalarField('k', 'STRING', 72)], 70, 'remote.RemoteSer', '/other.py');

const REGISTRY: CustomTypeInfo[] = [INNER, OUTER, REMOTE];

const bindingsFor = (): ReturnType<typeof implBindingsForDocument> =>
  implBindingsForDocument(REGISTRY, IMPL_FILE);

const createInputsOf = (text: string) => resolveCreateObjFromDictInputBindings(text, bindingsFor());
const getInputsOf = (text: string) => resolveImplMethodInputs(text, bindingsFor(), 'getDictFromObj');

/** 键串内容首列(引号内首字符),支持同名多次取第 occurrence 处。 */
const keyCol = (line: string, key: string, occurrence = 0): number => {
  let from = 0;
  for (let i = 0; i <= occurrence; i += 1) {
    const found = line.indexOf(`"${key}"`, from);
    if (i === occurrence) {
      return found + 1;
    }
    from = found + 1;
  }
  return -1;
};

const lines = (rows: string[]): string => rows.join('\n');

// ---------------------------------------------------------------------------
// computeConvertedObjStructure(return 结构推导)
// ---------------------------------------------------------------------------

describe('computeConvertedObjStructure return 结构推导', () => {
  it('wire 透传:return 入参(未重绑) → wire 容器', () => {
    const text = lines([
      'class BagSer:',
      '    def createObjFromDict(self, dct):',
      '        return dct',
      ''
    ]);
    const structure = computeConvertedObjStructure(text, createInputsOf(text)[0], REGISTRY);
    expect(structure).toMatchObject({ kind: 'wire', container: OUTER });
  });

  it('wire 纯字符串键链:return dct["inner"] → 嵌套 wire 容器', () => {
    const text = lines([
      'class BagSer:',
      '    def createObjFromDict(self, dct):',
      '        return dct["inner"]',
      ''
    ]);
    const structure = computeConvertedObjStructure(text, createInputsOf(text)[0], REGISTRY);
    expect(structure).toMatchObject({ kind: 'wire', container: INNER });
  });

  it('链落位标量字段/未声明键:unknown 不猜', () => {
    const scalar = lines([
      'class BagSer:',
      '    def createObjFromDict(self, dct):',
      '        return dct["uid"]',
      ''
    ]);
    expect(computeConvertedObjStructure(scalar, createInputsOf(scalar)[0], REGISTRY)).toEqual({ kind: 'unknown' });
    const undeclared = lines([
      'class BagSer:',
      '    def createObjFromDict(self, dct):',
      '        return dct["zz"]',
      ''
    ]);
    expect(computeConvertedObjStructure(undeclared, createInputsOf(undeclared)[0], REGISTRY)).toEqual({ kind: 'unknown' });
  });

  it('dict 字面量(直接):键集封闭,source=impl 文件:行', () => {
    const text = lines([
      'class BagSer:',
      '    def createObjFromDict(self, dct):',
      '        return {"x": 1, "y": dct["uid"]}',
      ''
    ]);
    const structure = computeConvertedObjStructure(text, createInputsOf(text)[0], REGISTRY);
    expect(structure).toEqual({ kind: 'dict', keys: ['x', 'y'], open: false, source: 'serializers_impl.py:3' });
  });

  it('多行字面量整体拼接收键', () => {
    const text = lines([
      'class BagSer:',
      '    def createObjFromDict(self, dct):',
      '        return {',
      '            "inner": None,',
      '            "uid": 1',
      '        }',
      ''
    ]);
    const structure = computeConvertedObjStructure(text, createInputsOf(text)[0], REGISTRY);
    expect(structure).toEqual({ kind: 'dict', keys: ['inner', 'uid'], open: false, source: 'serializers_impl.py:3' });
  });

  it('别名字面量:return 前最后一次字面量赋值', () => {
    const text = lines([
      'class BagSer:',
      '    def createObjFromDict(self, dct):',
      '        d = {"x": 1}',
      '        return d',
      ''
    ]);
    const structure = computeConvertedObjStructure(text, createInputsOf(text)[0], REGISTRY);
    expect(structure).toEqual({ kind: 'dict', keys: ['x'], open: false, source: 'serializers_impl.py:3' });
  });

  it('别名重绑后 return:unknown', () => {
    const rebound = lines([
      'class BagSer:',
      '    def createObjFromDict(self, dct):',
      '        d = {"x": 1}',
      '        d = other_source()',
      '        return d',
      ''
    ]);
    expect(computeConvertedObjStructure(rebound, createInputsOf(rebound)[0], REGISTRY)).toEqual({ kind: 'unknown' });
  });

  it('入参重绑后透传 return:unknown', () => {
    const text = lines([
      'class BagSer:',
      '    def createObjFromDict(self, dct):',
      '        dct = {"x": 1}',
      '        return dct',
      ''
    ]);
    expect(computeConvertedObjStructure(text, createInputsOf(text)[0], REGISTRY)).toEqual({ kind: 'unknown' });
  });

  it('{**展开} 与 dict 推导式:open 键集', () => {
    const spread = lines([
      'class BagSer:',
      '    def createObjFromDict(self, dct):',
      '        return {**dct, "uid": 1}',
      ''
    ]);
    expect(computeConvertedObjStructure(spread, createInputsOf(spread)[0], REGISTRY))
      .toEqual({ kind: 'dict', keys: ['uid'], open: true, source: 'serializers_impl.py:3' });
    const comprehension = lines([
      'class BagSer:',
      '    def createObjFromDict(self, dct):',
      '        return {k: 1 for k in dct}',
      ''
    ]);
    expect(computeConvertedObjStructure(comprehension, createInputsOf(comprehension)[0], REGISTRY))
      .toEqual({ kind: 'dict', keys: [], open: true, source: 'serializers_impl.py:3' });
  });

  it('集合字面量/集合推导式:不是 dict → unknown', () => {
    const setLiteral = lines([
      'class BagSer:',
      '    def createObjFromDict(self, dct):',
      '        return {1, 2}',
      ''
    ]);
    expect(computeConvertedObjStructure(setLiteral, createInputsOf(setLiteral)[0], REGISTRY)).toEqual({ kind: 'unknown' });
    const setComp = lines([
      'class BagSer:',
      '    def createObjFromDict(self, dct):',
      '        return {x for x in dct}',
      ''
    ]);
    expect(computeConvertedObjStructure(setComp, createInputsOf(setComp)[0], REGISTRY)).toEqual({ kind: 'unknown' });
  });

  it('自定义转换不凭函数名推定结构(验收否定面)', () => {
    const suggestive = lines([
      'class BagSer:',
      '    def createObjFromDict(self, dct):',
      '        return build_wire_dict(dct)',
      ''
    ]);
    expect(computeConvertedObjStructure(suggestive, createInputsOf(suggestive)[0], REGISTRY)).toEqual({ kind: 'unknown' });
  });

  it('return self/None/属性访问与无 return:unknown', () => {
    const variants = [
      ['class BagSer:', '    def createObjFromDict(self, dct):', '        return self', ''],
      ['class BagSer:', '    def createObjFromDict(self, dct):', '        return None', ''],
      ['class BagSer:', '    def createObjFromDict(self, dct):', '        return dct.uid', ''],
      ['class BagSer:', '    def createObjFromDict(self, dct):', '        pass', '']
    ];
    for (const rows of variants) {
      const text = lines(rows);
      expect(computeConvertedObjStructure(text, createInputsOf(text)[0], REGISTRY)).toEqual({ kind: 'unknown' });
    }
  });

  it('混合返回(字面量+自定义调用):任一未知 → 全体 unknown', () => {
    const text = lines([
      'class BagSer:',
      '    def createObjFromDict(self, dct):',
      '        if dct:',
      '            return {"x": 1}',
      '        return build_fallback(dct)',
      ''
    ]);
    expect(computeConvertedObjStructure(text, createInputsOf(text)[0], REGISTRY)).toEqual({ kind: 'unknown' });
  });

  it('多 return 全 dict:键并集', () => {
    const text = lines([
      'class BagSer:',
      '    def createObjFromDict(self, dct):',
      '        if dct:',
      '            return {"x": 1}',
      '        d = {"uid": 2}',
      '        return d',
      ''
    ]);
    const structure = computeConvertedObjStructure(text, createInputsOf(text)[0], REGISTRY);
    expect(structure).toMatchObject({ kind: 'dict', keys: ['x', 'uid'], open: false });
  });

  it('嵌套 def 内 return 不归方法面', () => {
    const text = lines([
      'class BagSer:',
      '    def createObjFromDict(self, dct):',
      '        def helper(sub):',
      '            return {"x": 1}',
      '        return helper(dct)',
      ''
    ]);
    // helper(dct) 是自定义调用 → unknown;嵌套 def 的 return 不参与推导
    expect(computeConvertedObjStructure(text, createInputsOf(text)[0], REGISTRY)).toEqual({ kind: 'unknown' });
  });

  it('体域字面量键写点并入 wire extraKeys;动态键写降级 open', () => {
    const literalWrite = lines([
      'class BagSer:',
      '    def createObjFromDict(self, dct):',
      '        dct["extra"] = 1',
      '        return dct',
      ''
    ]);
    expect(computeConvertedObjStructure(literalWrite, createInputsOf(literalWrite)[0], REGISTRY))
      .toEqual({ kind: 'wire', container: OUTER, extraKeys: ['extra'] });
    const dynamicWrite = lines([
      'class BagSer:',
      '    def createObjFromDict(self, dct):',
      '        dct[k] = 1',
      '        return dct',
      ''
    ]);
    const dynamic = computeConvertedObjStructure(dynamicWrite, createInputsOf(dynamicWrite)[0], REGISTRY);
    expect(dynamic).toMatchObject({ kind: 'dict', open: true });
    if (dynamic.kind === 'dict') {
      expect(dynamic.keys).toEqual(expect.arrayContaining(['inner', 'uid']));
      expect(dynamic.source).toBe('types.xml:50');
    }
  });

  it('无绑定面:unknown(防御)', () => {
    expect(computeConvertedObjStructure('x = 1', undefined, REGISTRY)).toEqual({ kind: 'unknown' });
  });
});

// ---------------------------------------------------------------------------
// computeConvertedObjMemberFindings(校验面)
// ---------------------------------------------------------------------------

describe('computeConvertedObjMemberFindings 校验面', () => {
  it('wire 透传:声明键零产出,缺失键报缺', () => {
    const text = lines([
      'class BagSer:',
      '    def createObjFromDict(self, dct):',
      '        return dct',
      '',
      '    def getDictFromObj(self, obj):',
      '        return {"x": obj["uid"]}',
      ''
    ]);
    const findings = computeConvertedObjMemberFindings(text, createInputsOf(text), getInputsOf(text), REGISTRY);
    expect(findings).toHaveLength(0);
    const bad = lines([
      'class BagSer:',
      '    def createObjFromDict(self, dct):',
      '        return dct',
      '',
      '    def getDictFromObj(self, obj):',
      '        return {"x": obj["w"]}',
      ''
    ]);
    const badFindings = computeConvertedObjMemberFindings(bad, createInputsOf(bad), getInputsOf(bad), REGISTRY);
    expect(badFindings).toHaveLength(1);
    expect(badFindings[0]).toMatchObject({
      line: 5, container: 'OUTER', key: 'w', source: 'types.xml:50'
    });
    expect(badFindings[0].character).toBe(keyCol(badFindingsLine(bad, 5), 'w'));
  });

  it('wire 链走嵌套容器:声明键零产出,缺失报嵌套容器', () => {
    const good = lines([
      'class BagSer:',
      '    def createObjFromDict(self, dct):',
      '        return dct',
      '',
      '    def getDictFromObj(self, obj):',
      '        return {"x": obj["inner"]["hp"]}',
      ''
    ]);
    expect(computeConvertedObjMemberFindings(good, createInputsOf(good), getInputsOf(good), REGISTRY)).toHaveLength(0);
    const bad = lines([
      'class BagSer:',
      '    def createObjFromDict(self, dct):',
      '        return dct',
      '',
      '    def getDictFromObj(self, obj):',
      '        return {"x": obj["inner"]["zz"]}',
      ''
    ]);
    const findings = computeConvertedObjMemberFindings(bad, createInputsOf(bad), getInputsOf(bad), REGISTRY);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ line: 5, container: 'INNER', key: 'zz', source: 'types.xml:30' });
  });

  it('dict 字面量结构:推导键零产出,缺失报字面量出处', () => {
    const text = lines([
      'class BagSer:',
      '    def createObjFromDict(self, dct):',
      '        return {"x": 1, "y": 2}',
      '',
      '    def getDictFromObj(self, obj):',
      '        return {"x": obj["y"], "z": obj["zz"]}',
      ''
    ]);
    const findings = computeConvertedObjMemberFindings(text, createInputsOf(text), getInputsOf(text), REGISTRY);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ line: 5, key: 'zz', source: 'serializers_impl.py:3' });
  });

  it('dict 形态只判首段(嵌套字面量形状不追)', () => {
    const text = lines([
      'class BagSer:',
      '    def createObjFromDict(self, dct):',
      '        return {"inner": {}}',
      '',
      '    def getDictFromObj(self, obj):',
      '        return {"x": obj["inner"]["deep"]}',
      ''
    ]);
    expect(computeConvertedObjMemberFindings(text, createInputsOf(text), getInputsOf(text), REGISTRY)).toHaveLength(0);
  });

  it('open 字面量({**展开}):缺失不报', () => {
    const text = lines([
      'class BagSer:',
      '    def createObjFromDict(self, dct):',
      '        return {**dct, "uid": 1}',
      '',
      '    def getDictFromObj(self, obj):',
      '        return {"x": obj["zz"]}',
      ''
    ]);
    expect(computeConvertedObjMemberFindings(text, createInputsOf(text), getInputsOf(text), REGISTRY)).toHaveLength(0);
  });

  it('文档级动态键写开放键宇宙:缺失不报', () => {
    const text = lines([
      'class BagSer:',
      '    def createObjFromDict(self, dct):',
      '        return dct',
      '',
      '    def getDictFromObj(self, obj):',
      '        return {"x": obj["zz"]}',
      '',
      '    def helper(self):',
      '        obj[k] = 1',
      ''
    ]);
    expect(computeConvertedObjMemberFindings(text, createInputsOf(text), getInputsOf(text), REGISTRY)).toHaveLength(0);
  });

  it('文档级字面量键写点并入键集:写后读零产出', () => {
    const text = lines([
      'class BagSer:',
      '    def createObjFromDict(self, dct):',
      '        return dct',
      '',
      '    def getDictFromObj(self, obj):',
      '        obj["w"] = 1',
      '        return {"x": obj["w"]}',
      ''
    ]);
    expect(computeConvertedObjMemberFindings(text, createInputsOf(text), getInputsOf(text), REGISTRY)).toHaveLength(0);
  });

  it('obj 重绑后读取不判', () => {
    const text = lines([
      'class BagSer:',
      '    def createObjFromDict(self, dct):',
      '        return dct',
      '',
      '    def getDictFromObj(self, obj):',
      '        obj = {"w": 1}',
      '        return {"x": obj["zz"]}',
      ''
    ]);
    expect(computeConvertedObjMemberFindings(text, createInputsOf(text), getInputsOf(text), REGISTRY)).toHaveLength(0);
  });

  it('嵌套 def 域跳过', () => {
    const text = lines([
      'class BagSer:',
      '    def createObjFromDict(self, dct):',
      '        return dct',
      '',
      '    def getDictFromObj(self, obj):',
      '        def walk(sub):',
      '            return {"x": sub["zz"]}',
      '        return {"x": obj["uid"]}',
      ''
    ]);
    expect(computeConvertedObjMemberFindings(text, createInputsOf(text), getInputsOf(text), REGISTRY)).toHaveLength(0);
  });

  it('注释/字符串位不判(掩码核验)', () => {
    const text = lines([
      'class BagSer:',
      '    def createObjFromDict(self, dct):',
      '        return dct',
      '',
      '    def getDictFromObj(self, obj):',
      '        # obj["zz"] 注释形态',
      '        note = "obj[\\"zz\\"] 字符串形态"',
      '        return {"x": obj["uid"]}',
      ''
    ]);
    expect(computeConvertedObjMemberFindings(text, createInputsOf(text), getInputsOf(text), REGISTRY)).toHaveLength(0);
  });

  it('写目标不判而 +=/== 照判;读取的 .get 形态照判', () => {
    const writeOnly = lines([
      'class BagSer:',
      '    def createObjFromDict(self, dct):',
      '        return dct',
      '',
      '    def getDictFromObj(self, obj):',
      '        obj["zz"] = 1',
      '        return {"x": obj["uid"]}',
      ''
    ]);
    expect(computeConvertedObjMemberFindings(writeOnly, createInputsOf(writeOnly), getInputsOf(writeOnly), REGISTRY)).toHaveLength(0);
    const augmented = lines([
      'class BagSer:',
      '    def createObjFromDict(self, dct):',
      '        return dct',
      '',
      '    def getDictFromObj(self, obj):',
      '        obj["zz"] += 1',
      '        return {"x": obj["uid"]}',
      ''
    ]);
    expect(computeConvertedObjMemberFindings(augmented, createInputsOf(augmented), getInputsOf(augmented), REGISTRY)).toHaveLength(1);
    const getForm = lines([
      'class BagSer:',
      '    def createObjFromDict(self, dct):',
      '        return dct',
      '',
      '    def getDictFromObj(self, obj):',
      '        return {"x": obj.get("zz")}',
      ''
    ]);
    expect(computeConvertedObjMemberFindings(getForm, createInputsOf(getForm), getInputsOf(getForm), REGISTRY)).toHaveLength(1);
  });

  it('自定义转换(暗示性函数名)零产出——不凭函数名推定(校验面否定面)', () => {
    const text = lines([
      'class BagSer:',
      '    def createObjFromDict(self, dct):',
      '        return build_wire_dict(dct)',
      '',
      '    def getDictFromObj(self, obj):',
      '        return {"x": obj["zz"]}',
      ''
    ]);
    expect(computeConvertedObjMemberFindings(text, createInputsOf(text), getInputsOf(text), REGISTRY)).toHaveLength(0);
  });

  it('无同容器 createObjFromDict 绑定:零产出', () => {
    const text = lines([
      'class BagSer:',
      '    def getDictFromObj(self, obj):',
      '        return {"x": obj["zz"]}',
      ''
    ]);
    expect(computeConvertedObjMemberFindings(text, createInputsOf(text), getInputsOf(text), REGISTRY)).toHaveLength(0);
  });

  it('限定/混排接收者形态不判(self.obj / 前缀名)', () => {
    const text = lines([
      'class BagSer:',
      '    def createObjFromDict(self, dct):',
      '        return dct',
      '',
      '    def getDictFromObj(self, obj):',
      '        return {"x": self.obj["zz"], "y": myobj["zz"]}',
      ''
    ]);
    expect(computeConvertedObjMemberFindings(text, createInputsOf(text), getInputsOf(text), REGISTRY)).toHaveLength(0);
  });

  it('多行体域:体末行外的读取不判', () => {
    const text = lines([
      'class BagSer:',
      '    def createObjFromDict(self, dct):',
      '        return dct',
      '',
      '    def getDictFromObj(self, obj):',
      '        return {"x": obj["uid"]}',
      '',
      '    def otherMethod(self):',
      '        return {"x": obj["zz"]}',
      ''
    ]);
    expect(computeConvertedObjMemberFindings(text, createInputsOf(text), getInputsOf(text), REGISTRY)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 消息/诊断项
// ---------------------------------------------------------------------------

describe('消息模板与 finding→item', () => {
  it('renderFixedDictOutputMemberMessage 含 key/container/source', () => {
    const message = renderFixedDictOutputMemberMessage('OUTER', 'w', 'types.xml:50');
    expect(message).toContain('"w"');
    expect(message).toContain('OUTER');
    expect(message).toContain('types.xml:50');
    expect(message).toContain('createObjFromDict');
    expect(message).toContain('getDictFromObj');
  });

  it('convertedObjMemberFindingToItem 范围/严重度/code', () => {
    const item = convertedObjMemberFindingToItem({
      line: 5,
      character: 27,
      length: 1,
      container: 'OUTER',
      key: 'w',
      source: 'types.xml:50',
      message: renderFixedDictOutputMemberMessage('OUTER', 'w', 'types.xml:50')
    });
    expect(item.range).toEqual({
      start: { line: 5, character: 27 },
      end: { line: 5, character: 28 }
    });
    expect(item.severity).toBe('Warning');
    expect(item.source).toBe('kbengine');
    expect(item.code).toBe(FIXED_DICT_OUTPUT_MEMBER_SCHEMA_DIAGNOSTIC_CODE);
    expect(FIXED_DICT_OUTPUT_MEMBER_SCHEMA_DIAGNOSTIC_CODE).toBe('kbengine.fixedDictOutputMemberSchema');
    // 同族形状:FixedDictConstructDiagnosticItem 合同(发布面同 collection)
    expect(Object.keys(item).sort()).toEqual(['code', 'message', 'range', 'severity', 'source']);
  });
});

/** 取指定行原文(keyCol 锚点断言用)。 */
function badFindingsLine(text: string, line: number): string {
  return text.split(/\r?\n/)[line] ?? '';
}
