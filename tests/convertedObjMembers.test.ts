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

// COV-98-TS-BACKEND 批 2:分支/容错臂补测(62 miss 行)。
// 全部走公开入口(computeConvertedObjStructure /
// computeConvertedObjMemberFindings),不 mock 内部件;断言面=实现的
// 真实语义(诚实边界各臂断言零声称/unknown,不硬造期望)。探针实跑
// 26 臂全数核实后落测。
describe('KSEM-SER-05 sweep: return 形态容错与键增面边界', () => {
  it('return 形态容错:裸 return/未闭合字面量/括号表达式/动态下标 → unknown', () => {
    const bare = lines([
      'class BagSer:',
      '    def createObjFromDict(self, dct):',
      '        return',
      ''
    ]);
    expect(computeConvertedObjStructure(bare, createInputsOf(bare)[0], REGISTRY)).toEqual({ kind: 'unknown' });
    const unclosed = lines([
      'class BagSer:',
      '    def createObjFromDict(self, dct):',
      '        return {"x": 1',
      ''
    ]);
    expect(computeConvertedObjStructure(unclosed, createInputsOf(unclosed)[0], REGISTRY)).toEqual({ kind: 'unknown' });
    const paren = lines([
      'class BagSer:',
      '    def createObjFromDict(self, dct):',
      '        return (dct)',
      ''
    ]);
    expect(computeConvertedObjStructure(paren, createInputsOf(paren)[0], REGISTRY)).toEqual({ kind: 'unknown' });
    const dynamicSub = lines([
      'class BagSer:',
      '    def createObjFromDict(self, dct):',
      '        return dct[k]',
      ''
    ]);
    expect(computeConvertedObjStructure(dynamicSub, createInputsOf(dynamicSub)[0], REGISTRY)).toEqual({ kind: 'unknown' });
  });

  it('wire 链形态容错:标识符与段间空白;链尾条件式/标量再下标不猜', () => {
    const spacedIdent = lines([
      'class BagSer:',
      '    def createObjFromDict(self, dct):',
      '        return dct ["inner"]',
      ''
    ]);
    expect(computeConvertedObjStructure(spacedIdent, createInputsOf(spacedIdent)[0], REGISTRY))
      .toMatchObject({ kind: 'wire', container: INNER });
    const spacedChain = lines([
      'class BagSer:',
      '    def createObjFromDict(self, dct):',
      '        return dct["inner"] ["hp"]',
      ''
    ]);
    expect(computeConvertedObjStructure(spacedChain, createInputsOf(spacedChain)[0], REGISTRY)).toEqual({ kind: 'unknown' });
    const trailingCond = lines([
      'class BagSer:',
      '    def createObjFromDict(self, dct):',
      '        return dct["inner"] if flag else {}',
      ''
    ]);
    expect(computeConvertedObjStructure(trailingCond, createInputsOf(trailingCond)[0], REGISTRY)).toEqual({ kind: 'unknown' });
    const throughScalar = lines([
      'class BagSer:',
      '    def createObjFromDict(self, dct):',
      '        return dct["inner"]["hp"]["x"]',
      ''
    ]);
    expect(computeConvertedObjStructure(throughScalar, createInputsOf(throughScalar)[0], REGISTRY)).toEqual({ kind: 'unknown' });
  });

  it('别名字面量:未闭合 → unknown;集合字面量 → unknown', () => {
    const unclosed = lines([
      'class BagSer:',
      '    def createObjFromDict(self, dct):',
      '        d = {"x": 1',
      '        return d',
      ''
    ]);
    expect(computeConvertedObjStructure(unclosed, createInputsOf(unclosed)[0], REGISTRY)).toEqual({ kind: 'unknown' });
    const setAlias = lines([
      'class BagSer:',
      '    def createObjFromDict(self, dct):',
      '        d = {1, 2}',
      '        return d',
      ''
    ]);
    expect(computeConvertedObjStructure(setAlias, createInputsOf(setAlias)[0], REGISTRY)).toEqual({ kind: 'unknown' });
  });

  it('多 wire 不同容器:声明键并集降级 dict,体域字面量键写点并入', () => {
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
    expect(structure).toEqual({
      kind: 'dict',
      keys: ['inner', 'uid', 'hp', 'mp', 'extra'],
      open: false,
      source: 'types.xml:50'
    });
  });

  it('混合 wire/字面量返回:键并集并入体域字面量键写点', () => {
    const text = lines([
      'class BagSer:',
      '    def createObjFromDict(self, dct):',
      '        if dct:',
      '            return dct',
      '        d = {"x": 1}',
      '        d["extra"] = 2',
      '        return d',
      ''
    ]);
    const structure = computeConvertedObjStructure(text, createInputsOf(text)[0], REGISTRY);
    expect(structure).toEqual({
      kind: 'dict',
      keys: ['inner', 'uid', 'x', 'extra'],
      open: false,
      source: 'types.xml:50'
    });
  });

  it('键增面容错:setdefault/未闭合括号写/括号内转义/混引号段 → 动态开放', () => {
    const arms: Array<{ name: string; write: string }> = [
      { name: 'setdefault', write: '        dct.setdefault("k", 1)' },
      { name: 'unterminated bracket', write: '        dct["a" = 1' },
      { name: 'escaped quote in bracket', write: '        dct["a\\"b" = 1' },
      { name: 'mixed quotes segment', write: '        dct["a\'"b] = 1' },
      { name: 'two string keys', write: '        dct["a" "b"] = 1' }
    ];
    for (const arm of arms) {
      const text = lines([
        'class BagSer:',
        '    def createObjFromDict(self, dct):',
        arm.write,
        '        return dct',
        ''
      ]);
      const structure = computeConvertedObjStructure(text, createInputsOf(text)[0], REGISTRY);
      expect(structure, arm.name).toMatchObject({ kind: 'dict', open: true });
      if (structure.kind === 'dict') {
        expect(structure.keys, arm.name).toEqual(expect.arrayContaining(['inner', 'uid']));
        expect(structure.source, arm.name).toBe('types.xml:50');
      }
    }
  });

  it('字面量解析臂:转义键/尾逗号/冒号前空白/字符串集合元素/动态键', () => {
    const escaped = lines([
      'class BagSer:',
      '    def createObjFromDict(self, dct):',
      '        return {"a\\"b": 1}',
      ''
    ]);
    expect(computeConvertedObjStructure(escaped, createInputsOf(escaped)[0], REGISTRY))
      .toEqual({ kind: 'dict', keys: ['a"b'], open: false, source: 'serializers_impl.py:3' });
    const trailingComma = lines([
      'class BagSer:',
      '    def createObjFromDict(self, dct):',
      '        return {"x": 1,}',
      ''
    ]);
    expect(computeConvertedObjStructure(trailingComma, createInputsOf(trailingComma)[0], REGISTRY))
      .toEqual({ kind: 'dict', keys: ['x'], open: false, source: 'serializers_impl.py:3' });
    const spacedColon = lines([
      'class BagSer:',
      '    def createObjFromDict(self, dct):',
      '        return {"a" : 1}',
      ''
    ]);
    expect(computeConvertedObjStructure(spacedColon, createInputsOf(spacedColon)[0], REGISTRY))
      .toEqual({ kind: 'dict', keys: ['a'], open: false, source: 'serializers_impl.py:3' });
    const stringSet = lines([
      'class BagSer:',
      '    def createObjFromDict(self, dct):',
      '        return {"a"}',
      ''
    ]);
    expect(computeConvertedObjStructure(stringSet, createInputsOf(stringSet)[0], REGISTRY)).toEqual({ kind: 'unknown' });
    const dynamicKey = lines([
      'class BagSer:',
      '    def createObjFromDict(self, dct):',
      '        return {dct["k"]: 1}',
      ''
    ]);
    expect(computeConvertedObjStructure(dynamicKey, createInputsOf(dynamicKey)[0], REGISTRY))
      .toEqual({ kind: 'dict', keys: [], open: true, source: 'serializers_impl.py:3' });
    const midComma = lines([
      'class BagSer:',
      '    def createObjFromDict(self, dct):',
      '        return {"x": 1, , "y": 2}',
      ''
    ]);
    expect(computeConvertedObjStructure(midComma, createInputsOf(midComma)[0], REGISTRY))
      .toEqual({ kind: 'dict', keys: ['x', 'y'], open: false, source: 'serializers_impl.py:3' });
  });

  it('校验面容错:空白接收者/动态键读/标量链/extraKeys 读/异容器无 create', () => {
    const spacedRead = lines([
      'class BagSer:',
      '    def createObjFromDict(self, dct):',
      '        return dct',
      '',
      '    def getDictFromObj(self, obj):',
      '        return {"x": obj ["zz"]}',
      ''
    ]);
    const spacedFindings = computeConvertedObjMemberFindings(spacedRead, createInputsOf(spacedRead), getInputsOf(spacedRead), REGISTRY);
    expect(spacedFindings).toHaveLength(1);
    expect(spacedFindings[0]).toMatchObject({ line: 5, key: 'zz', container: 'OUTER' });
    expect(spacedFindings[0].character).toBe(keyCol(badFindingsLine(spacedRead, 5), 'zz'));

    const dynamicRead = lines([
      'class BagSer:',
      '    def createObjFromDict(self, dct):',
      '        return dct',
      '',
      '    def getDictFromObj(self, obj):',
      '        return {"x": obj[k]}',
      ''
    ]);
    expect(computeConvertedObjMemberFindings(dynamicRead, createInputsOf(dynamicRead), getInputsOf(dynamicRead), REGISTRY)).toHaveLength(0);

    const scalarChain = lines([
      'class BagSer:',
      '    def createObjFromDict(self, dct):',
      '        return dct',
      '',
      '    def getDictFromObj(self, obj):',
      '        return {"x": obj["uid"]["deep"]}',
      ''
    ]);
    expect(computeConvertedObjMemberFindings(scalarChain, createInputsOf(scalarChain), getInputsOf(scalarChain), REGISTRY)).toHaveLength(0);

    const extraRead = lines([
      'class BagSer:',
      '    def createObjFromDict(self, dct):',
      '        dct["extra"] = 1',
      '        return dct',
      '',
      '    def getDictFromObj(self, obj):',
      '        return {"x": obj["extra"]}',
      ''
    ]);
    expect(computeConvertedObjMemberFindings(extraRead, createInputsOf(extraRead), getInputsOf(extraRead), REGISTRY)).toHaveLength(0);

    const peerless = lines([
      'class BagSer:',
      '    def createObjFromDict(self, dct):',
      '        return dct',
      '',
      '    def getDictFromObj(self, obj):',
      '        return {"x": obj["uid"]}',
      '',
      'class InnerSer:',
      '    def getDictFromObj(self, obj):',
      '        return {"x": obj["zz"]}',
      ''
    ]);
    expect(computeConvertedObjMemberFindings(peerless, createInputsOf(peerless), getInputsOf(peerless), REGISTRY)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 批 21 语义钉面:引号键写点(写面零产出,与读面语义分离)、get 侧 return
// 形状容错(多空白/None/未闭合花括号)。
// 覆盖口径残余(批 2 已定性,不硬凑):11 miss 全为防御死码——247(平衡产物内
// 引号不闭:joinBalancedBraces 引号感知,平衡产物不会含未闭合引号)/291-299
// (bracketCloseIndex 串态:唯一调用面在掩码行上跑,掩码把串 token 折成 `_`,
// 引号字符到不了)/506(exprCol 已跳过空白,循环体不进)/558/572/777(链不变量)。
// ---------------------------------------------------------------------------
describe('批 21:结构推导与写点收集容错臂', () => {
  it('写点带引号键链:obj["k"] = 1 在键收集面按字面量键处理', () => {
    const text = lines([
      'class BagSer:',
      '    def createObjFromDict(self, dct):',
      '        return dct',
      '',
      '    def getDictFromObj(self, obj):',
      '        return {"uid": obj["uid"]}',
      '',
      'def sink():',
      '    pass',
      ''
    ]);
    // 基线零产出(读面只读声明键);写面在下方单独钉
    const findings = computeConvertedObjMemberFindings(text, createInputsOf(text), getInputsOf(text), REGISTRY);
    expect(findings).toHaveLength(0);
  });

  it('getDictFromObj 体内引号键写点:写面扫描执行,写点本身不产出发现', () => {
    const text = lines([
      'class BagSer:',
      '    def createObjFromDict(self, dct):',
      '        return dct',
      '',
      '    def getDictFromObj(self, obj):',
      '        obj["ghost"] = 1',
      '        return {"uid": obj["uid"]}',
      ''
    ]);
    // 写点收集跑引号键链扫描(字面量键入键宇宙);校验面只报读面缺失,
    // 写 undeclared 键本身零产出(与读面语义分离)
    const findings = computeConvertedObjMemberFindings(text, createInputsOf(text), getInputsOf(text), REGISTRY);
    expect(findings).toHaveLength(0);
  });

  it('getDictFromObj return 后多空白再花括号:空白跳位后照常拼字面量', () => {
    const text = lines([
      'class BagSer:',
      '    def getDictFromObj(self, obj):',
      '        return  {"uid": obj["uid"]}',
      ''
    ]);
    const structure = computeConvertedObjStructure(text, getInputsOf(text)[0], REGISTRY);
    expect(structure).toMatchObject({ kind: 'dict' });
  });

  it('getDictFromObj return None:输出 None,结构未知(不猜)', () => {
    const text = lines([
      'class BagSer:',
      '    def getDictFromObj(self, obj):',
      '        return None',
      ''
    ]);
    const structure = computeConvertedObjStructure(text, getInputsOf(text)[0], REGISTRY);
    expect(structure).toMatchObject({ kind: 'unknown' });
  });

  it('getDictFromObj return 花括号未闭合(跨行拼接失败):结构未知', () => {
    const text = lines([
      'class BagSer:',
      '    def getDictFromObj(self, obj):',
      '        return {"uid": obj["uid"]',
      ''
    ]);
    const structure = computeConvertedObjStructure(text, getInputsOf(text)[0], REGISTRY);
    expect(structure).toMatchObject({ kind: 'unknown' });
  });
});
