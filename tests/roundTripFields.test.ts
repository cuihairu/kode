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

/**
 * 倒序骨架(create 在前):encode 体需要未闭合 `{` 等残缺形态时专用——
 * 残缺字面量会让**其后**的 def 方法域解析落空,create 绑定缺位则入口早退
 * (表面零产出=假绿),故未闭形态必须钉在倒序骨架上。
 */
const pairRev = (encodeBody: string[], decodeBody: string[]): string =>
  lines([
    'class PairSer:',
    '    def createObjFromDict(self, dct):',
    ...decodeBody.map(row => `        ${row}`),
    '',
    '    def getDictFromObj(self, obj):',
    ...encodeBody.map(row => `        ${row}`),
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

// ---------------------------------------------------------------------------
// COV-98-TS-BACKEND 批 10:encode 字面量跟踪面容错臂(嵌套 def 跳块/
// 未闭合字面量/开放形状写点/三引号字符串位伪写点/键前空白动态下标)、
// decode 读面赋值目标跳位与 setdefault 开放面、动态冒号键不进键集、
// 容器配对缺位。
// ---------------------------------------------------------------------------

describe('KSEM-SER-06 sweep: encode 跟踪面容错臂', () => {
  it('嵌套 def 内的 return 字面量不入产出面(域诚实)', () => {
    const text = pair(
      ['def helper():', '    return {"y": obj["y"]}', 'return {"x": obj["x"]}'],
      ['return {"x": dct["x"], "y": dct["y"]}']
    );
    const findings = findingsOf(text);
    expect(findings).toHaveLength(1);
    expect(findings[0].direction).toBe('decodeOnly');
    expect(findings[0].key).toBe('y');
  });

  it('未闭合字面量:别名赋值与 return 两面都不猜', () => {
    expect(findingsOf(pair(
      ['d = {"x": obj["x"]', 'return d'],
      ['return {"x": dct["x"], "y": dct["y"]}']
    ))).toHaveLength(0);
    expect(findingsOf(pair(
      ['return {"x": obj["x"]'],
      ['return {"x": dct["x"]}']
    ))).toHaveLength(0);
  });

  it('动态冒号键不入键集(不猜键名),但不整容器跳过', () => {
    // 实测口径:encode 侧 `k: 1` 非字面量键,只产出 {x}(不猜 k 是啥);
    // 容器**不**因此整跳过——decode 读的 y 与产出 {x} 的差集照报 decodeOnly。
    const text = pair(
      ['return {"x": obj["x"], k: 1}'],
      ['return {"x": dct["x"], "y": dct["y"]}']
    );
    const findings = findingsOf(text);
    expect(findings.map(f => `${f.direction}:${f.key}`)).toEqual(['decodeOnly:y']);
  });

  it('开放形状上的写点行不并入(open 先拦);开放面循环照跳', () => {
    const text = pair(
      ['d = {"x": obj["x"]}', 'd.update(rest)', 'd["y"] = 1', 'return d'],
      ['return {"x": dct["x"], "y": dct["y"]}']
    );
    expect(findingsOf(text)).toHaveLength(0);
  });

  it('三引号字符串内的伪写点/伪动态下标:掩码核验跳过', () => {
    const literal = pair(
      [
        'd = {"x": obj["x"]}',
        'doc = """',
        'd["y"] = 1',
        '"""',
        'return d'
      ],
      ['return {"x": dct["x"]}']
    );
    // 伪写点不并入:y 仍未产出但 decode 也不读 → 零产出
    expect(findingsOf(literal)).toHaveLength(0);

    const dynamic = pair(
      [
        'd = {"x": obj["x"]}',
        'doc = """',
        'd[k] = 1',
        '"""',
        'return d'
      ],
      ['return {"x": dct["x"]}']
    );
    // 伪动态下标不翻开放面:容器仍闭合对拍
    expect(findingsOf(dynamic)).toHaveLength(0);
  });

  it('动态下标键前空白:`d[ t] = 1` 照判开放', () => {
    const text = pair(
      ['d = {"x": obj["x"]}', 'd[ t] = 1', 'return d'],
      ['return {"x": dct["x"]}']
    );
    expect(findingsOf(text)).toHaveLength(0);
  });
});

describe('KSEM-SER-06 sweep: decode 读面与配对容错臂', () => {
  it('入参下标赋值目标不是读取:encodeOnly 照报', () => {
    const text = trio(
      ['return {"x": obj["x"], "y": obj["y"]}'],
      ['dct["y"] = 1', 'return {"x": dct["x"]}']
    );
    const findings = findingsOf(text);
    expect(findings).toHaveLength(1);
    expect(findings[0].direction).toBe('encodeOnly');
    expect(findings[0].key).toBe('y');
  });

  it('decode setdefault/update 开放面:压 encodeOnly,decodeOnly 照报', () => {
    const text = trio(
      ['return {"x": obj["x"], "y": obj["y"]}'],
      ['dct.update(rest)', 'extra = dct.get("z")']
    );
    const findings = findingsOf(text);
    expect(findings).toHaveLength(1);
    expect(findings[0].direction).toBe('decodeOnly');
    expect(findings[0].key).toBe('z');
  });

  it('decode 动态下标键前空白照判开放', () => {
    const text = trio(
      ['return {"x": obj["x"], "y": obj["y"]}'],
      ['probe = dct[ t]', 'extra = dct.get("z")']
    );
    const findings = findingsOf(text);
    expect(findings).toHaveLength(1);
    expect(findings[0].direction).toBe('decodeOnly');
    expect(findings[0].key).toBe('z');
  });

  it('get 侧容器无 create 配对:该容器零产出(其余容器照判)', () => {
    const text = lines([
      'class PairSer:',
      '    def getDictFromObj(self, obj):',
      '        return {"x": obj["x"], "y": obj["y"]}',
      '',
      '    def createObjFromDict(self, dct):',
      '        return {"x": dct["x"], "y": dct["y"]}',
      '',
      'class SingleSer:',
      '    def getDictFromObj(self, obj):',
      '        return {"y": obj["y"]}',
      ''
    ]);
    expect(findingsOf(text)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// COV-98 批5 补扫:encode 残缺字面量未知臂(倒序骨架限定)
// ---------------------------------------------------------------------------

describe('COV-98 批5:encode 未闭合字面量不入册', () => {
  it('别名赋未闭合字面量(d = { 后无收括号)→ 字面量不入册,整容器未知', () => {
    const text = pairRev(
      ['d = {', '"x": obj["x"]', 'return d'],
      ['return {"x": dct["x"]}']
    );
    expect(findingsOf(text)).toHaveLength(0);
  });

  it('return 未闭合字面量 → 该 return 位未知(不凭残缺字面量推定)', () => {
    const text = pairRev(['return {'], ['return {"x": dct["x"]}']);
    expect(findingsOf(text)).toHaveLength(0);
  });
});


// ---------------------------------------------------------------------------
// 覆盖批5:encode 嵌套 def 跳过 / 超窗字面量(配对窗 100 行,超窗
// 不硬猜)/ 展开项键集 / 开放字面量后的写点与体尾跳过 / 掩码位写点
// 与动态下标 / decode 赋值目标不判读取 / decode 开放面(setdefault
// 与空白下标)/ get 侧无配对容器。诚实边界:值往返/语义等价不静态
// 断言(既有口径);真·未闭合字面量不可作语料——残缺括号使实现绑定
// 扫描把下一个 def 吞进上一方法体,绑定缺位即早退,断言空过无覆盖。
// ---------------------------------------------------------------------------

describe('computeRoundTripFieldFindings 覆盖批5边界', () => {
  it('encode 嵌套 def 块整块跳过:内层 return 不并入,外层字面量照常对拍', () => {
    const encodeLine = 'return {"x": obj["x"], "y": obj["y"]}';
    const text = pair(
      ['def inner(o):', '    seen = {"q": o["q"]}', '    return seen', encodeLine],
      ['return {"x": dct["x"]}']
    );
    const findings = findingsOf(text);
    expect(findings).toHaveLength(1);
    expect(findings[0].key).toBe('y');
    expect(findings[0].line).toBe(5);
    expect(findings[0].character).toBe(encKeyCol(encodeLine, 'y'));
  });

  it('字面量超配对窗(100 行不闭):配对 null → unknown 整容器跳过不硬猜', () => {
    // 语料是合法 Python(括号真闭合),只是闭括号落在配对窗(100 行)
    // 之外 → matchDictBraces 窗口超界 null。别名与 return 两臂同构。
    // 形状 unknown:大字面量里的键(含仅 encode 侧的 lost 键)一律不
    // 声称归向,decode 读取也不反向开_scalar。
    const bigDictRows = (n: number): string[] => {
      const rows: string[] = [];
      for (let i = 0; i < n; i += 1) {
        rows.push(`"k${i}": ${i},`);
      }
      return rows;
    };
    const lostKeyOnlyInEncode = '"onlyInEncode"';
    expect(
      findingsOf(pair(
        ['d = {', ...bigDictRows(110), `    ${lostKeyOnlyInEncode}: 1,`, '}', 'return d'],
        ['lost = dct["x"]']
      ))
    ).toHaveLength(0);
    expect(
      findingsOf(pair(
        ['return {', ...bigDictRows(110), `    ${lostKeyOnlyInEncode}: 1,`, '}'],
        ['lost = dct["x"]']
      ))
    ).toHaveLength(0);
  });

  it('展开/动态键项不进键集(开放宇宙):混合字面量整容器 unknown', () => {
    expect(
      findingsOf(pair(['return {"x": obj["x"], **extra}'], ['return {"x": dct["x"]}']))
    ).toHaveLength(0);
    expect(
      findingsOf(pair(['return {"x": obj["x"], k: 1}'], ['return {"x": dct["x"]}']))
    ).toHaveLength(0);
  });

  it('开放字面量后的非 return 行:写点收集与体尾开放面双双跳过', () => {
    expect(
      findingsOf(pair(
        ['d = {"x": obj["x"]}', 'd.setdefault("y", 2)', 'pass', 'return d'],
        ['return {"x": dct["x"]}']
      ))
    ).toHaveLength(0);
  });

  it('文档串里的写点形态:掩码位拒绝,键集不污染', () => {
    expect(
      findingsOf(pair(
        ['d = {"x": obj["x"]}', '"""', 'd["y"] = 1', '"""', 'return d'],
        ['return {"x": dct["x"]}']
      ))
    ).toHaveLength(0);
  });

  it('字符串位的动态下标:体尾扫描掩码核验跳过,形状保持闭合', () => {
    expect(
      findingsOf(pair(
        ['d = {"x": obj["x"]}', 'log("see d[grid]")', 'return d'],
        ['return {"x": dct["x"]}']
      ))
    ).toHaveLength(0);
  });

  it('下标后空白:开放面扫描跳过空白判引号键,不误开', () => {
    expect(
      findingsOf(pair(
        ['d = {"x": obj["x"]}', 'self.hp = d[ "hp" ]', 'return d'],
        ['return {"x": dct["x"]}']
      ))
    ).toHaveLength(0);
  });

  it('decode 赋值目标键不判读取:写 x 不压制 encodeOnly(x/y 齐报)', () => {
    const encodeLine = 'return {"x": obj["x"], "y": obj["y"]}';
    const text = pair([encodeLine], ['dct["x"] = 1']);
    const findings = findingsOf(text);
    expect(findings.map(f => f.key)).toEqual(['x', 'y']);
    expect(findings.every(f => f.direction === 'encodeOnly')).toBe(true);
    expect(findings[0].line).toBe(2);
    expect(findings[0].character).toBe(encKeyCol(encodeLine, 'x'));
    expect(findings[1].character).toBe(encKeyCol(encodeLine, 'y'));
  });

  it('decode setdefault 开放面:压 encodeOnly,decodeOnly 照报', () => {
    // setdefault 令 decode 宇宙开放(压 x/y encodeOnly);decodeOnly
    // 认读取位,setdefault 写位不算读 → decode 体须真读 z。
    const text = trio(
      ['return {"x": obj["x"], "y": obj["y"]}'],
      ['dct.setdefault("z", 1)', 'lost = dct["z"]']
    );
    const findings = findingsOf(text);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ direction: 'decodeOnly', key: 'z' });
  });

  it('decode 动态下标前空白:开放面同扫描(开放只压 encodeOnly)', () => {
    const text = trio(
      ['return {"x": obj["x"], "y": obj["y"]}'],
      ['probe = dct [ t ]', 'extra = dct.get("z")']
    );
    const findings = findingsOf(text);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ direction: 'decodeOnly', key: 'z' });
  });

  it('get 侧无配对容器跳过:混排不串扰', () => {
    const text = lines([
      'class PairSer:',
      '    def getDictFromObj(self, obj):',
      '        return {"x": obj["x"], "y": obj["y"]}',
      '',
      '    def createObjFromDict(self, dct):',
      '        return {"x": dct["x"]}',
      '',
      'class SingleSer:',
      '    def getDictFromObj(self, obj):',
      '        return {"x": obj["x"]}',
      ''
    ]);
    const findings = findingsOf(text);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ container: 'PAIR', key: 'y', direction: 'encodeOnly' });
  });
});
