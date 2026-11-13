/**
 * KSEM-SER-06:转换往返字段对应(纯核心)。
 *
 * 引擎真源(SER-02 模型 §2,树 3082ab5 实测):序列化侧 addToStreamEx
 * hasImpl 先 impl_getDictFromObj(datatype.cpp:2595),缺声明键静默
 * parseDefaultStr 整体顶替(:2627/:2642);反序列化侧 createFromStreamEx
 * 按声明序重建 wire FixedDict 后交 impl_createObjFromDict(:2673)。
 * 往返链 = obj → getDictFromObj → wire → createObjFromDict → 新 obj:
 * encode 产出键集(getDictFromObj 体)与 decode 读取键集
 * (createObjFromDict 体)的差集 = 往返字段错配(单向缺失)。
 * 诚实边界:值往返/语义等价不静态断言(运行时样本属 SER-14);透传/
 * 未知 return/开放键宇宙整容器跳过;不凭函数名推定。夹具镜像 SER-05
 * 同构(implBindingsForDocument + resolveImplMethodInputs 双面绑定)。
 *
 * 锚列口径(共享助手族既约,测试按侧断言):encode 字面量键锚在
 * 键串引号列(parseDictPairs keyStart,与 SER-03 同族);decode 读取锚在
 * 键内容列(keyAccessAt keyCharacter=i+1,与 SER-04 同族);encode 写点
 * 锚在键内容列。
 */

import { describe, it, expect } from 'vitest';
import {
  computeRoundTripFieldFindings,
  roundTripFieldFindingToItem,
  renderRoundTripEncodeOnlyMessage,
  renderRoundTripDecodeOnlyMessage,
  FIXED_DICT_ROUND_TRIP_SCHEMA_DIAGNOSTIC_CODE
} from '../src/backend/roundTripFields';
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

/** 往返面配对容器:声明 x/y 两键。 */
const PAIR = customType('PAIR', 'FIXED_DICT', [
  scalarField('x', 'UINT8', 32),
  scalarField('y', 'UINT8', 34)
], 30, 'serializers_impl.PairSer', IMPL_FILE);

/** 三键容器:decodeOnly/开放面用第三键 z(未在 encode 产出)。 */
const TRIO = customType('TRIO', 'FIXED_DICT', [
  scalarField('x', 'UINT8', 52),
  scalarField('y', 'UINT8', 53),
  scalarField('z', 'UINT8', 54)
], 50, 'serializers_impl.TrioSer', IMPL_FILE);

/** 单键容器:重绑面用(只声明 y,encode 产出未声明 x 不进对拍)。 */
const SINGLE = customType('SINGLE', 'FIXED_DICT', [
  scalarField('y', 'UINT8', 92)
], 90, 'serializers_impl.SingleSer', IMPL_FILE);

/** 过滤/配对面:不同 impl 文件。 */
const REMOTE = customType('REMOTE', 'FIXED_DICT', [scalarField('k', 'STRING', 72)], 70, 'remote.RemoteSer', '/other.py');

const REGISTRY: CustomTypeInfo[] = [PAIR, TRIO, SINGLE, REMOTE];

const bindingsFor = (): ReturnType<typeof implBindingsForDocument> =>
  implBindingsForDocument(REGISTRY, IMPL_FILE);

const findingsOf = (text: string) =>
  computeRoundTripFieldFindings(
    text,
    resolveCreateObjFromDictInputBindings(text, bindingsFor()),
    resolveImplMethodInputs(text, bindingsFor(), 'getDictFromObj')
  );

/** 方法体缩进(8 空格)。 */
const BODY_INDENT = 8;

/** encode 字面量键锚列(引号列,绝对)。 */
const encKeyCol = (row: string, key: string): number =>
  BODY_INDENT + row.indexOf(`"${key}"`);

/** decode 读取锚列(键内容列,绝对)。 */
const decKeyCol = (row: string, key: string): number =>
  BODY_INDENT + row.indexOf(`"${key}"`) + 1;

/** decode `.get("k")` 实参锚列(键内容列,绝对)。 */
const decGetCol = (row: string, key: string): number =>
  BODY_INDENT + row.indexOf(`dct.get("${key}")`) + 'dct.get("'.length;

const lines = (rows: string[]): string => rows.join('\n');

/**
 * 双方法同文骨架(往返面配对前提):encodeBody = getDictFromObj 产出体,
 * decodeBody = createObjFromDict 读取体。布局与键行号:类 0 / encode 定义
 * 1 / encodeBody 自 2 / 空行 / decode 定义 / decodeBody 随后。
 */
const pair = (encodeBody: string[], decodeBody: string[]): string =>
  lines([
    'class PairSer:',
    '    def getDictFromObj(self, obj):',
    ...encodeBody.map(row => `        ${row}`),
    '',
    '    def createObjFromDict(self, dct):',
    ...decodeBody.map(row => `        ${row}`),
    ''
  ]);

/** 三键容器同构骨架(class TrioSer)。 */
const trio = (encodeBody: string[], decodeBody: string[]): string =>
  lines([
    'class TrioSer:',
    '    def getDictFromObj(self, obj):',
    ...encodeBody.map(row => `        ${row}`),
    '',
    '    def createObjFromDict(self, dct):',
    ...decodeBody.map(row => `        ${row}`),
    ''
  ]);

/** 单键容器同构骨架(class SingleSer)。 */
const single = (encodeBody: string[], decodeBody: string[]): string =>
  lines([
    'class SingleSer:',
    '    def getDictFromObj(self, obj):',
    ...encodeBody.map(row => `        ${row}`),
    '',
    '    def createObjFromDict(self, dct):',
    ...decodeBody.map(row => `        ${row}`),
    ''
  ]);

// ---------------------------------------------------------------------------
// encodeOnly(编码产出而解码不读)
// ---------------------------------------------------------------------------

describe('computeRoundTripFieldFindings encodeOnly', () => {
  it('直接字面量产出 {x,y},decode 只读 x → encodeOnly y(锚编码键位)', () => {
    const encodeLine = 'return {"x": obj["x"], "y": obj["y"]}';
    const text = pair([encodeLine], ['return {"x": dct["x"]}']);
    const findings = findingsOf(text);
    expect(findings).toHaveLength(1);
    const [finding] = findings;
    expect(finding.direction).toBe('encodeOnly');
    expect(finding.container).toBe('PAIR');
    expect(finding.key).toBe('y');
    expect(finding.line).toBe(2);
    expect(finding.character).toBe(encKeyCol(encodeLine, 'y'));
    expect(finding.length).toBe(1);
    expect(finding.source).toBe('types.xml:30');
  });

  it('别名赋字面量后 return 别名 → 同直接字面量', () => {
    const aliasLine = 'd = {"x": obj["x"], "y": obj["y"]}';
    const text = pair([aliasLine, 'return d'], ['return {"x": dct["x"]}']);
    const findings = findingsOf(text);
    expect(findings).toHaveLength(1);
    expect(findings[0].key).toBe('y');
    expect(findings[0].line).toBe(2); // 别名行键位点
    expect(findings[0].character).toBe(encKeyCol(aliasLine, 'y'));
  });

  it('多 return 闭合并集:{x} ∪ {x,y} → encodeOnly y', () => {
    const secondLine = 'return {"x": obj["x"], "y": obj["y"]}';
    const text = pair(
      ['if obj["x"]:', '    return {"x": obj["x"]}', secondLine],
      ['return {"x": dct["x"]}']
    );
    const findings = findingsOf(text);
    expect(findings).toHaveLength(1);
    expect(findings[0].key).toBe('y');
    expect(findings[0].line).toBe(4);
    expect(findings[0].character).toBe(encKeyCol(secondLine, 'y'));
  });

  it('字面量后单段字面量键写点并入键集:{"x"} + d["z"] = … → 不进对拍(写点键未声明,z 归 SER-03)', () => {
    // PAIR 只声明 x/y:写点并入的 z 未声明,不报(多键车道 SER-03);
    // 换声明 z 的容器才见写点键成差
    const writeLine = 'd["z"] = 1';
    const text = pair(
      ['d = {"x": obj["x"]}', writeLine, 'return d'],
      ['return {"x": dct["x"]}']
    );
    expect(findingsOf(text)).toHaveLength(0);
  });

  it('开放面即整容器跳过:展开/动态键写/setdefault/+= 各零产出', () => {
    const variants: string[][] = [
      ['d = {"x": obj["x"]}', 'd.update({"spread": 1})', 'return d'],
      ['return {**obj}'],
      ['d = {"x": obj["x"]}', 'd[t] = 1', 'return d'],
      ['d = {"x": obj["x"]}', 'd.setdefault("y", 2)', 'return d'],
      ['d = {"x": obj["x"]}', 'd += extra', 'return d']
    ];
    for (const encodeBody of variants) {
      expect(findingsOf(pair(encodeBody, ['return {"x": dct["x"]}']))).toHaveLength(0);
    }
  });

  it('未知 return 不推定:构造调用/self/无 return 全零产出', () => {
    const variants: string[][] = [
      ['return make_dict(obj)'],
      ['return self'],
      [],
      ['result = build(obj)', 'return result']
    ];
    for (const encodeBody of variants) {
      expect(findingsOf(pair(encodeBody, ['return {"x": dct["x"]}']))).toHaveLength(0);
    }
  });

  it('多 return 一个未知位 → 整容器零产出(不并未知)', () => {
    const text = pair(
      ['if obj["x"]:', '    return build(obj)', 'return {"x": obj["x"], "y": obj["y"]}'],
      ['return {"x": dct["x"]}']
    );
    expect(findingsOf(text)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// decodeOnly(解码读取而编码不产出)
// ---------------------------------------------------------------------------

describe('computeRoundTripFieldFindings decodeOnly', () => {
  it('encode 产出 {x},decode 读 x/z → decodeOnly z(锚读取位,TRIO 声明 z)', () => {
    const readLine = 'return {"x": dct["x"], "z": dct.get("z")}';
    const text = trio(['return {"x": obj["x"]}'], [readLine]);
    const findings = findingsOf(text);
    expect(findings).toHaveLength(1);
    const [finding] = findings;
    expect(finding.direction).toBe('decodeOnly');
    expect(finding.key).toBe('z');
    expect(finding.line).toBe(5);
    expect(finding.character).toBe(decGetCol(readLine, 'z'));
    expect(finding.container).toBe('TRIO');
  });

  it('decode 直接别名 w = dct 后经 w 读取 → 同入参读取', () => {
    const readLine = 'lost = w["z"]';
    const text = trio(
      ['return {"x": obj["x"]}'],
      ['w = dct', readLine, 'return {"x": w["x"]}']
    );
    const findings = findingsOf(text);
    expect(findings).toHaveLength(1);
    expect(findings[0].key).toBe('z');
    expect(findings[0].direction).toBe('decodeOnly');
    expect(findings[0].line).toBe(6);
    expect(findings[0].character).toBe(decKeyCol(readLine, 'z'));
  });

  it('入参重绑后读取不再收集(重绑前已见读取照报)', () => {
    const beforeLine = 'keep = dct["y"]';
    const text = single(
      ['return {"x": obj["x"]}'],
      [beforeLine, 'dct = {}', 'lost = dct["y"]', 'return {"x": keep}']
    );
    const findings = findingsOf(text);
    expect(findings).toHaveLength(1);
    expect(findings[0].key).toBe('y');
    expect(findings[0].direction).toBe('decodeOnly');
    expect(findings[0].container).toBe('SINGLE');
    expect(findings[0].source).toBe('types.xml:90');
    expect(findings[0].line).toBe(5); // 重绑前的读取位
    expect(findings[0].character).toBe(decKeyCol(beforeLine, 'y'));
  });

  it('透传 return 入参 / {**dct} 展开 → 对应无意义,整容器零产出', () => {
    const passthrough = pair(['return {"x": obj["x"]}'], ['return dct']);
    expect(findingsOf(passthrough)).toHaveLength(0);
    const spread = pair(['return {"x": obj["x"]}'], ['return {**dct}']);
    expect(findingsOf(spread)).toHaveLength(0);
  });

  it('decode 开放面(动态下标读)→ 只压 encodeOnly,decodeOnly 照报', () => {
    // 动态下标读:y 是否被读无法穷尽 → encodeOnly 不判;z 已闭合读取
    const text = trio(
      ['return {"x": obj["x"], "y": obj["y"]}'],
      ['lost = dct["x"]', 'probe = dct[t]', 'extra = dct.get("z")']
    );
    const findings = findingsOf(text);
    expect(findings).toHaveLength(1);
    expect(findings[0].direction).toBe('decodeOnly');
    expect(findings[0].key).toBe('z');
    expect(findings[0].line).toBe(7);
    expect(findings[0].character).toBe(decGetCol('extra = dct.get("z")', 'z'));
  });
});

// ---------------------------------------------------------------------------
// 配对与诚实边界
// ---------------------------------------------------------------------------

describe('computeRoundTripFieldFindings 配对与诚实边界', () => {
  it('完整往返(键集相等)零产出', () => {
    const text = pair(
      ['return {"x": obj["x"], "y": obj["y"]}'],
      ['return {"x": dct["x"], "y": dct.get("y")}']
    );
    expect(findingsOf(text)).toHaveLength(0);
  });

  it('无配对(只 getDictFromObj 无 createObjFromDict)/他文件容器 → 零产出', () => {
    const onlyEncode = lines([
      'class PairSer:',
      '    def getDictFromObj(self, obj):',
      '        return {"x": obj["x"], "y": obj["y"]}',
      ''
    ]);
    expect(findingsOf(onlyEncode)).toHaveLength(0);
  });

  it('未声明键不进往返对拍(缺键/多键归 SER-03,未声明读取归 SER-04)', () => {
    const encodeLine = 'return {"x": obj["x"], "ghost": obj["x"]}';
    const readLine = 'return {"x": dct["x"], "phantom": dct.get("phantom")}';
    const text = pair([encodeLine], [readLine]);
    expect(findingsOf(text)).toHaveLength(0);
  });

  it('嵌套 def 域读取跳过(域诚实):y 只在嵌套域读 → encodeOnly y 照报', () => {
    const encodeLine = 'return {"x": obj["x"], "y": obj["y"]}';
    const text = pair(
      [encodeLine],
      ['def helper(src):', '    lost = dct["y"]', 'return {"x": dct["x"]}']
    );
    const findings = findingsOf(text);
    expect(findings).toHaveLength(1);
    expect(findings[0].key).toBe('y');
    expect(findings[0].direction).toBe('encodeOnly');
    expect(findings[0].line).toBe(2);
  });

  it('注释/字符串位不判:键串只在真代码位收集', () => {
    const commentLine = '# dct["y"]';
    const logLine = 'log("dct.get(\\"y\\")")';
    const encodeLine = 'return {"x": obj["x"], "y": obj["y"]}';
    const text = pair(
      [encodeLine],
      ['return {"x": dct["x"]}', commentLine, logLine]
    );
    const findings = findingsOf(text);
    expect(findings).toHaveLength(1);
    expect(findings[0].direction).toBe('encodeOnly');
    expect(findings[0].key).toBe('y');
  });

  it('嵌套链首段只判:首段计读、次段不入对拍域', () => {
    // dct["x"]["hp"]:首段 x 计入读取(压制 encodeOnly x),次段 hp 不收集
    const readLine = 'return {"x": dct["x"]["hp"]}';
    const text = pair(['return {"x": obj["x"]}'], [readLine]);
    expect(findingsOf(text)).toHaveLength(0);
  });

  it('三键容器 decodeOnly 多键齐报(手排双方法直查)', () => {
    const readLine = 'return {"x": dct["x"], "z": dct["z"]}';
    const text = lines([
      'class TrioSer:',
      '    def createObjFromDict(self, dct):',
      `        ${readLine}`,
      '',
      '    def getDictFromObj(self, obj):',
      '        return {"x": obj["x"]}',
      ''
    ]);
    const findings = findingsOf(text);
    expect(findings.map(finding => finding.key)).toEqual(['z']);
    expect(findings[0].container).toBe('TRIO');
    expect(findings[0].source).toBe('types.xml:50');
    expect(findings[0].line).toBe(2);
    expect(findings[0].character).toBe(BODY_INDENT + readLine.indexOf('dct["z"]') + 5);
  });
});

// ---------------------------------------------------------------------------
// 消息模板与 finding → item
// ---------------------------------------------------------------------------

describe('roundTripFieldFindingToItem', () => {
  it('消息模板单一来源:EN 恒等键 + 占位符渲染', () => {
    const encodeMsg = renderRoundTripEncodeOnlyMessage('PAIR', 'y', 'types.xml:30');
    const decodeMsg = renderRoundTripDecodeOnlyMessage('PAIR', 'z', 'types.xml:30');
    expect(encodeMsg).toContain('"y"');
    expect(encodeMsg).toContain('PAIR.getDictFromObj');
    expect(encodeMsg).toContain('types.xml:30');
    expect(decodeMsg).toContain('"z"');
    expect(decodeMsg).toContain('PAIR.createObjFromDict');
    expect(decodeMsg).toContain('types.xml:30');
  });

  it('finding → item:code/severity/source/range 形状与同族一致', () => {
    const text = pair(['return {"x": obj["x"], "y": obj["y"]}'], ['return {"x": dct["x"]}']);
    const [finding] = findingsOf(text);
    const item = roundTripFieldFindingToItem(finding);
    expect(Object.keys(item).sort()).toEqual(['code', 'message', 'range', 'severity', 'source']);
    expect(item.code).toBe(FIXED_DICT_ROUND_TRIP_SCHEMA_DIAGNOSTIC_CODE);
    expect(FIXED_DICT_ROUND_TRIP_SCHEMA_DIAGNOSTIC_CODE).toBe('kbengine.fixedDictRoundTripSchema');
    expect(item.severity).toBe('Warning');
    expect(item.source).toBe('kbengine');
    expect(item.range.end.character).toBe(item.range.start.character + 1);
  });
});
