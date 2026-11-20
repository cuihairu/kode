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

// ---------------------------------------------------------------------------
// 字面量/链解析基元边界(SER-05 推导基元的分支面)
// ---------------------------------------------------------------------------

describe('字面量与链解析基元边界', () => {
  it('转义引号键:键内容保留反斜杠,推导不误判', () => {
    const text = lines([
      'class BagSer:',
      '    def createObjFromDict(self, dct):',
      '        return {"a\\\\": 1}',
      ''
    ]);
    const structure = computeConvertedObjStructure(text, createInputsOf(text)[0], REGISTRY);
    expect(structure).toEqual({ kind: 'dict', keys: ['a\\'], open: false, source: 'serializers_impl.py:3' });
  });

  it('键后空白再冒号:键照收;尾逗号空条目跳过', () => {
    const text = lines([
      'class BagSer:',
      '    def createObjFromDict(self, dct):',
      '        return {"x" : 1,}',
      ''
    ]);
    const structure = computeConvertedObjStructure(text, createInputsOf(text)[0], REGISTRY);
    expect(structure).toEqual({ kind: 'dict', keys: ['x'], open: false, source: 'serializers_impl.py:3' });
  });

  it('字符串条目无冒号(集合元素)/数字动态键/调用动态键:非 dict 或开放', () => {
    const setElement = lines([
      'class BagSer:',
      '    def createObjFromDict(self, dct):',
      '        return {"x" "y"}',
      ''
    ]);
    expect(computeConvertedObjStructure(setElement, createInputsOf(setElement)[0], REGISTRY))
      .toEqual({ kind: 'unknown' });
    const numberKey = lines([
      'class BagSer:',
      '    def createObjFromDict(self, dct):',
      '        return {1: 2}',
      ''
    ]);
    expect(computeConvertedObjStructure(numberKey, createInputsOf(numberKey)[0], REGISTRY))
      .toEqual({ kind: 'dict', keys: [], open: true, source: 'serializers_impl.py:3' });
    const callKey = lines([
      'class BagSer:',
      '    def createObjFromDict(self, dct):',
      '        return {f(1): 2}',
      ''
    ]);
    expect(computeConvertedObjStructure(callKey, createInputsOf(callKey)[0], REGISTRY))
      .toEqual({ kind: 'dict', keys: [], open: true, source: 'serializers_impl.py:3' });
  });

  it('return 与 { 之间空白/字面量未闭合:照常定位或诚实未知', () => {
    const spaced = lines([
      'class BagSer:',
      '    def createObjFromDict(self, dct):',
      '        return  {"a": 1}',
      ''
    ]);
    expect(computeConvertedObjStructure(spaced, createInputsOf(spaced)[0], REGISTRY))
      .toEqual({ kind: 'dict', keys: ['a'], open: false, source: 'serializers_impl.py:3' });
    const unclosed = lines([
      'class BagSer:',
      '    def createObjFromDict(self, dct):',
      '        return {',
      ''
    ]);
    expect(computeConvertedObjStructure(unclosed, createInputsOf(unclosed)[0], REGISTRY))
      .toEqual({ kind: 'unknown' });
  });

  it('裸 return / 元组 return:未知', () => {
    const bare = lines([
      'class BagSer:',
      '    def createObjFromDict(self, dct):',
      '        return',
      ''
    ]);
    expect(computeConvertedObjStructure(bare, createInputsOf(bare)[0], REGISTRY)).toEqual({ kind: 'unknown' });
    const tuple = lines([
      'class BagSer:',
      '    def createObjFromDict(self, dct):',
      '        return (1, 2)',
      ''
    ]);
    expect(computeConvertedObjStructure(tuple, createInputsOf(tuple)[0], REGISTRY)).toEqual({ kind: 'unknown' });
  });

  it('链形态边界:接收者空白/动态键下标/链间空白/链后尾缀', () => {
    const spaced = lines([
      'class BagSer:',
      '    def createObjFromDict(self, dct):',
      '        return dct ["inner"]',
      ''
    ]);
    expect(computeConvertedObjStructure(spaced, createInputsOf(spaced)[0], REGISTRY))
      .toMatchObject({ kind: 'wire', container: INNER });
    const dynamicKey = lines([
      'class BagSer:',
      '    def createObjFromDict(self, dct):',
      '        return dct[k]',
      ''
    ]);
    expect(computeConvertedObjStructure(dynamicKey, createInputsOf(dynamicKey)[0], REGISTRY))
      .toEqual({ kind: 'unknown' });
    const spacedChain = lines([
      'class BagSer:',
      '    def createObjFromDict(self, dct):',
      '        return dct["inner"] ["hp"]',
      ''
    ]);
    expect(computeConvertedObjStructure(spacedChain, createInputsOf(spacedChain)[0], REGISTRY))
      .toEqual({ kind: 'unknown' }); // hp 标量:链终点非 FD
    const trailing = lines([
      'class BagSer:',
      '    def createObjFromDict(self, dct):',
      '        return dct["inner"] + 1',
      ''
    ]);
    expect(computeConvertedObjStructure(trailing, createInputsOf(trailing)[0], REGISTRY))
      .toEqual({ kind: 'unknown' });
  });

  it('别名边界:字面量未闭合/集合字面量别名 → 未知', () => {
    const unclosed = lines([
      'class BagSer:',
      '    def createObjFromDict(self, dct):',
      '        d = {',
      '        return d',
      ''
    ]);
    expect(computeConvertedObjStructure(unclosed, createInputsOf(unclosed)[0], REGISTRY))
      .toEqual({ kind: 'unknown' });
    const setAlias = lines([
      'class BagSer:',
      '    def createObjFromDict(self, dct):',
      '        d = {1, 2}',
      '        return d',
      ''
    ]);
    expect(computeConvertedObjStructure(setAlias, createInputsOf(setAlias)[0], REGISTRY))
      .toEqual({ kind: 'unknown' });
  });

  it('体域键增面:表达式段/混合引号段/跨行下标写/setdefault → 键宇宙开放', () => {
    const exprSegment = lines([
      'class BagSer:',
      '    def createObjFromDict(self, dct):',
      '        dct["a" + k] = 1',
      '        return dct',
      ''
    ]);
    const exprStructure = computeConvertedObjStructure(exprSegment, createInputsOf(exprSegment)[0], REGISTRY);
    expect(exprStructure).toMatchObject({ kind: 'dict', open: true });

    const mixedQuote = lines([
      'class BagSer:',
      '    def createObjFromDict(self, dct):',
      "        dct[\"a'b\"] = 1",
      '        return dct',
      ''
    ]);
    expect(computeConvertedObjStructure(mixedQuote, createInputsOf(mixedQuote)[0], REGISTRY))
      .toMatchObject({ kind: 'dict', open: true });

    const multilineWrite = lines([
      'class BagSer:',
      '    def createObjFromDict(self, dct):',
      '        dct[',
      '            "extra"',
      '        ] = 1',
      '        return dct',
      ''
    ]);
    expect(computeConvertedObjStructure(multilineWrite, createInputsOf(multilineWrite)[0], REGISTRY))
      .toMatchObject({ kind: 'dict', open: true });

    const setdefault = lines([
      'class BagSer:',
      '    def createObjFromDict(self, dct):',
      '        dct.setdefault("k", 1)',
      '        return dct',
      ''
    ]);
    expect(computeConvertedObjStructure(setdefault, createInputsOf(setdefault)[0], REGISTRY))
      .toMatchObject({ kind: 'dict', open: true });
  });
});

// ---------------------------------------------------------------------------
// 多 return 并集与校验面边界
// ---------------------------------------------------------------------------

describe('多 return 并集与校验面边界', () => {
  it('多 wire 不同容器:键并集(含体域字面量键写点)', () => {
    const text = lines([
      'class BagSer:',
      '    def createObjFromDict(self, dct):',
      '        dct["extra"] = 1',
      '        if dct:',
      '            return dct',
      '        return dct["inner"]',
      ''
    ]);
    const structure = computeConvertedObjStructure(text, createInputsOf(text)[0], REGISTRY);
    expect(structure).toMatchObject({
      kind: 'dict',
      open: false,
      source: 'types.xml:50'
    });
    if (structure.kind === 'dict') {
      expect(structure.keys).toEqual(['inner', 'uid', 'hp', 'mp', 'extra']);
    }
  });

  it('混合 wire/dict 字面量:键并集,extraKeys 并入', () => {
    const text = lines([
      'class BagSer:',
      '    def createObjFromDict(self, dct):',
      '        dct["extra"] = 1',
      '        if dct:',
      '            return dct',
      '        return {"a": 1}',
      ''
    ]);
    const structure = computeConvertedObjStructure(text, createInputsOf(text)[0], REGISTRY);
    expect(structure).toMatchObject({ kind: 'dict', open: false, source: 'types.xml:50' });
    if (structure.kind === 'dict') {
      expect(structure.keys).toEqual(['inner', 'uid', 'a', 'extra']);
    }
  });

  it('接收者与 [ 之间空白:读取照判(声明键零产出)', () => {
    const text = lines([
      'class BagSer:',
      '    def createObjFromDict(self, dct):',
      '        return dct',
      '',
      '    def getDictFromObj(self, obj):',
      '        return {"x": obj ["uid"]}',
      ''
    ]);
    expect(computeConvertedObjMemberFindings(text, createInputsOf(text), getInputsOf(text), REGISTRY))
      .toHaveLength(0);
  });

  it('属性访问断链(accesses 空)不判', () => {
    const text = lines([
      'class BagSer:',
      '    def createObjFromDict(self, dct):',
      '        return dct',
      '',
      '    def getDictFromObj(self, obj):',
      '        return {"x": obj.attr}',
      ''
    ]);
    expect(computeConvertedObjMemberFindings(text, createInputsOf(text), getInputsOf(text), REGISTRY))
      .toHaveLength(0);
  });

  it('wire 链中段字段非 FD:嵌套键不猜容器,零产出', () => {
    const text = lines([
      'class BagSer:',
      '    def createObjFromDict(self, dct):',
      '        return dct',
      '',
      '    def getDictFromObj(self, obj):',
      '        return {"x": obj["inner"]["hp"]["x"]}',
      ''
    ]);
    expect(computeConvertedObjMemberFindings(text, createInputsOf(text), getInputsOf(text), REGISTRY))
      .toHaveLength(0);
  });

  it('getDictFromObj 有绑定而 createObjFromDict 只在别的容器:零产出', () => {
    const text = lines([
      'class InnerSer:',
      '    def createObjFromDict(self, dct):',
      '        return dct',
      '',
      'class BagSer:',
      '    def getDictFromObj(self, obj):',
      '        return {"x": obj["zz"]}',
      ''
    ]);
    expect(computeConvertedObjMemberFindings(text, createInputsOf(text), getInputsOf(text), REGISTRY))
      .toHaveLength(0);
  });

  it('wire extraKeys 键写后读取:并入键集零产出', () => {
    const text = lines([
      'class BagSer:',
      '    def createObjFromDict(self, dct):',
      '        dct["extra"] = 1',
      '        return dct',
      '',
      '    def getDictFromObj(self, obj):',
      '        return {"x": obj["extra"], "y": obj["uid"]}',
      ''
    ]);
    expect(computeConvertedObjMemberFindings(text, createInputsOf(text), getInputsOf(text), REGISTRY))
      .toHaveLength(0);
  });
});

/** 取指定行原文(keyCol 锚点断言用)。 */
function badFindingsLine(text: string, line: number): string {
  return text.split(/\r?\n/)[line] ?? '';
}

// ---------------------------------------------------------------------------
// lcov DA 诚实边界批(批 7C):可达臂 + 逐行不可达论证
// ---------------------------------------------------------------------------

// 逐行不可达论证(公共入口无任何语料可达,不写凑数测试):
// - dictLiteralKeysOf L212(空条目 continue):splitTopLevelParams 逐段 push
//   不滤空,但合法 Python 的 dict 字面量不可能产生空段(`,,` 是语法错误,
//   尾逗号空段由结尾 trim 过滤)——本文件下方「双逗号探针」用蓄意畸形语料
//   实证该防御臂(绑定不受影响,断言键集非空,非空账)。
// - dictLiteralKeysOf L247(条目引号未闭 return null):joinBalancedBraces
//   成功的前提是引号态归零(引号开着时 `}` 不计深度),splitTopLevelParams
//   与其同一套引号/转义状态机——开引号条目必然延伸到闭引号之后才遇顶层
//   逗号,条目内首引号必闭,该臂结构性不可达(防御臂)。
// - resolveReturnExpr L506(return 与 { 间空白推进):collectReturnSites 已在
//   掩码行上把 exprCol 推进到首个非空白列,掩码保长保列,原文行同列必非空白
//   ——该循环体永假(防御臂;既有「return 与 { 之间空白」用例实跑亦未触达)。
// - resolveReturnExpr L558(链循环后 cursor 未走完):链循环三条出口——break
//   时 cursor=next=trimmed.length、`trimmed[next] !== '['` 与 access 非
//   subscript 均提前 return,cursor 只在 < length 时被赋值,循环条件出口时
//   cursor 恒等于 length → L557 恒假(防御臂)。
// - resolveReturnExpr L572(链循环空容器臂):容器只在段尾 L578 被置 null,
//   L579 随即对 null 容器提前 return,循环不会带着 null 容器进入下一段;
//   初值 input.container 类型非空——L571 恒假(防御臂;下方「链中段字段
//   非 FD」用例实跑落位 L579 非 FD 臂,行为钉子保留)。
// - bracketCloseIndex L291-299(引号感知臂):唯一调用点 scanKeyAdditionSurfaces
//   只喂掩码行,而 pythonCodeLines 把引号字符一并掩成 `_`(注释位掩成空白)
//   ——掩码行不含任何引号字符,quote 态永不建立,引号臂全死(防御臂)。
// - objMemberReadsOnLine L777(kind !== 'wire' 收窄 continue):唯一调用点
//   computeConvertedObjMemberFindings 已在 L853 把 unknown 结构 continue 掉,
//   dict 形态在 L759 已 continue——走到 L776 时 kind 恒为 wire(类型收窄断言,
//   运行时不可达)。
describe('lcov DA 诚实边界批(批 7C)', () => {
  it('链中段字段非 FD:第二段落位不可知 → unknown(段尾非 FD 臂)', () => {
    // uid 是标量字段:第一段落位后 wireFdOfAnnotation 得 null,段尾「非 FD
    // 字段」臂即判 unknown(不进下一段)。
    const text = lines([
      'class BagSer:',
      '    def createObjFromDict(self, dct):',
      '        return dct["uid"]["x"]',
      ''
    ]);
    expect(computeConvertedObjStructure(text, createInputsOf(text)[0], REGISTRY))
      .toEqual({ kind: 'unknown' });
  });

  it('dict 字面量空段防御臂:双逗号空段跳过,字面量键照收(蓄意畸形语料探针)', () => {
    // 合法 Python 不可能产生空段(`,,` 语法错误),本条是刻意畸形语料探针:
    // `,,` 只出现在方法体内一行,类/def 绑定不受影响(下方断言键集非空即证
    // 绑定成立),用于实证空段防御臂真实行为。
    const text = lines([
      'class BagSer:',
      '    def createObjFromDict(self, dct):',
      '        return {"x": 1.0, , "y": 2.0}',
      ''
    ]);
    expect(computeConvertedObjStructure(text, createInputsOf(text)[0], REGISTRY))
      .toEqual({ kind: 'dict', keys: ['x', 'y'], open: false, source: 'serializers_impl.py:3' });
  });
});
