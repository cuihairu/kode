import type { EntityMapping } from '../entityMapping';
import { l10nText } from '../nlsRuntime';
import {
  findPythonReceiverCalls,
  parseSingleLineCallArguments,
  type PythonCallerFace,
  type PythonReceiverCall,
  type PythonReceiverSection
} from './pythonLanguageUtils';
import { maskPythonNonCode } from './pythonLexicalMask';

/**
 * RPC 参数序列化类型兼容 lint(RUST-176/KBE-PY-009b 诊断面,纯核零 vscode):
 * `self.base/cell/client.<method>(...)` 调用点实参为**字面量形态可判定**时,
 * 与调用所属 section 声明的 <Arg> 序列化类型族对账,明确不兼容才报 Warning。
 *
 * 引擎真源锚(kbengine kbe/src 本地树逐条取证):
 * - 声明读型路径:Arg 的第一个子节点必须是直文本(`<Arg> STRING </Arg>`);
 *   getValStr 只认文本节点(xml.cpp:121-127,元素 ToText()=NULL → 空串),
 *   元素形态 `<Arg><Type>STRING</Type></Arg>` 首子节点是元素 → dataType[]
 *   not found → 引擎启动中止(entitydef.cpp:1629-1643,client loader,base/
 *   cell 同构)。解析器(parseMethods)同口径只认直文本,空文本=未声明。
 * - 装载面只查类型注册存在性,未知类型启动中止(entitydef.cpp:1639-1643)
 *   ——该面由 unknown-type lint(KBE-DEF-001,
 *   lint/rules.rs UnknownTypeReferenceRule walk_all 全文档 <Type>)覆盖,本核
 *   不重复。
 * - 打包面(datatype addToStream,参数真正上流的路径)按类型族:
 *   · 整数族 INT8/16/32/64、UINT8/16/32/64(IntType<T> datatype.h:875-898;
 *     UInt64Type datatype.cpp:199-225、UInt32Type:324-341、Int64Type:440-468
 *     同构):PyLong_AsLong→AsUnsignedLong 逐级回退,全失败 → TypeError 打印
 *     + **v=0 写流继续**——不中止,静默打 0;bool 是 PyLong 子类合法。
 *   · FLOAT/DOUBLE(FloatType datatype.cpp:540-549、DoubleType:630-641):
 *     PyFloat_Check 闸门失败 → TypeError 打印 + **return 不写流**——字段缺
 *     席,远端按定宽读错位;int 不被 PyFloat_Check 接受。
 *   · STRING/UNICODE(StringType datatype.cpp:1050-1062、UnicodeType:
 *     1129-1141):PyUnicode_AsUTF8AndSize;bytes 同样失败(OUT_TYPE_ERROR +
 *     return 不写流)。
 *   · BLOB(BlobType datatype.cpp:1448-1468):PyBytes_Check 之外的对象被
 *     无检强转 PyMemoryStream(未定义字节)——只有 bytes 是受支持形态。
 *   · VECTOR2/3/4(Vector3Type datatype.cpp:841-856,2/4 同构):逐分量
 *     PySequence_GetItem + PyFloat_AsDouble——list/tuple 结构上可行(分量
 *     可浮点转换即可),str 逐分量转换产生垃圾值,非序列直接失败。
 *   · PYTHON(datatype.cpp:1225-1230)与 PY_DICT/PY_TUPLE/PY_LIST(继承
 *     PythonType pickle):pickle 全收,永不声称。
 * - 分面:接收者段(self.client/base/cell)决定 def 区块,声明按调用所属
 *   section 过滤,口径与 rpcArgCount 同一(多来源不一致 → 未知不报)。
 *
 * 诚实边界:非字面量形态(名字/表达式/f-string 外的调用)推不出 → 不报;
 * 非内建类型(types.xml 别名/ARRAY/FIXED_DICT/ENTITYCALL)不声称;跨行调用
 * 槽位文本未知 → 不报;数量不符由 rpcArgCount(KBE-PY-009)负责,不重复。
 */

/** 诊断稳定 code(B-7 纪律) */
export const RPC_ARG_TYPE_DIAGNOSTIC_CODE = 'kbengine.rpcArgType';

/** 开关默认值(与 rpcArgCount 同族:默认开启) */
export const RPC_ARG_TYPE_DIAGNOSTICS_ENABLED_DEFAULT = true;

export type RpcArgLiteralKind =
  | 'int' | 'float' | 'str' | 'bytes' | 'bool' | 'none'
  | 'list' | 'dict' | 'set' | 'tuple'
  | 'vector2' | 'vector3' | 'vector4';

export interface RpcArgTypeFinding {
  /** 0 起行(方法名 token 所在行) */
  line: number;
  /** 0 起列(实参段首) */
  character: number;
  /** 实参段长(原文字节,与 character 同一原文坐标系) */
  length: number;
  methodName: string;
  receiver: PythonReceiverCall['receiver'];
  /** 调用所属 def 区块(client/base/cell 分面呈现) */
  section: PythonReceiverSection;
  /** 实参槽位(1 起) */
  argIndex: number;
  /** def <Arg> 直文本(原样,未展开别名) */
  declaredType: string;
  /** 调用点实参字面量判定 */
  inferredKind: RpcArgLiteralKind;
  message: string;
}

type RpcArgFamily = 'int' | 'float' | 'str' | 'bytes' | 'vector'
  | 'any' | 'pickle' | 'entitycall';

/** 内建类型族注册表(datatypes.cpp:56-72 注册表同源;锚=addToStream 实现位) */
const BUILTIN_ARG_TYPES: ReadonlyMap<string, { family: RpcArgFamily; anchor: string }> = new Map([
  ['INT8', { family: 'int', anchor: 'datatype.h:875-898' }],
  ['INT16', { family: 'int', anchor: 'datatype.h:875-898' }],
  ['INT32', { family: 'int', anchor: 'datatype.h:875-898' }],
  ['INT64', { family: 'int', anchor: 'datatype.cpp:440-468' }],
  ['UINT8', { family: 'int', anchor: 'datatype.h:875-898' }],
  ['UINT16', { family: 'int', anchor: 'datatype.h:875-898' }],
  ['UINT32', { family: 'int', anchor: 'datatype.cpp:324-341' }],
  ['UINT64', { family: 'int', anchor: 'datatype.cpp:199-225' }],
  ['FLOAT', { family: 'float', anchor: 'datatype.cpp:540-549' }],
  ['DOUBLE', { family: 'float', anchor: 'datatype.cpp:630-641' }],
  ['STRING', { family: 'str', anchor: 'datatype.cpp:1050-1062' }],
  ['UNICODE', { family: 'str', anchor: 'datatype.cpp:1129-1141' }],
  ['BLOB', { family: 'bytes', anchor: 'datatype.cpp:1448-1468' }],
  ['VECTOR2', { family: 'vector', anchor: 'datatype.cpp:737-745' }],
  ['VECTOR3', { family: 'vector', anchor: 'datatype.cpp:841-856' }],
  ['VECTOR4', { family: 'vector', anchor: 'datatype.cpp:946-961' }],
  ['PYTHON', { family: 'any', anchor: 'datatype.cpp:1225-1230' }],
  ['PY_DICT', { family: 'pickle', anchor: 'datatype.cpp:1248' }],
  ['PY_TUPLE', { family: 'pickle', anchor: 'datatype.cpp:1248' }],
  ['PY_LIST', { family: 'pickle', anchor: 'datatype.cpp:1248' }],
  ['ENTITYCALL', { family: 'entitycall', anchor: 'datatype.cpp:1512' }]
]);

/** 各族「明确兼容」字面量判定集(family → 判定集;kind 不在两集合内=未知不声称) */
const FAMILY_OK: Record<RpcArgFamily, ReadonlySet<RpcArgLiteralKind> | null> = {
  int: new Set<RpcArgLiteralKind>(['int', 'bool']),
  float: new Set<RpcArgLiteralKind>(['float']),
  str: new Set<RpcArgLiteralKind>(['str']),
  bytes: new Set<RpcArgLiteralKind>(['bytes']),
  vector: new Set<RpcArgLiteralKind>(['vector2', 'vector3', 'vector4']),
  // pickle 全收(PYTHON/PY_DICT/PY_TUPLE/PY_LIST):永不声称
  any: null,
  pickle: null,
  entitycall: null
};

/** 各族「明确不兼容」字面量判定集;VECTOR 的 list/tuple 结构上可行 → 留未知 */
const FAMILY_MISMATCH: Record<string, ReadonlySet<RpcArgLiteralKind>> = {
  int: new Set<RpcArgLiteralKind>(['float', 'str', 'bytes', 'none', 'list', 'dict', 'set', 'tuple', 'vector2', 'vector3', 'vector4']),
  float: new Set<RpcArgLiteralKind>(['int', 'bool', 'str', 'bytes', 'none', 'list', 'dict', 'set', 'tuple', 'vector2', 'vector3', 'vector4']),
  str: new Set<RpcArgLiteralKind>(['bytes', 'int', 'bool', 'float', 'none', 'list', 'dict', 'set', 'tuple', 'vector2', 'vector3', 'vector4']),
  bytes: new Set<RpcArgLiteralKind>(['str', 'int', 'bool', 'float', 'none', 'list', 'dict', 'set', 'tuple', 'vector2', 'vector3', 'vector4']),
  vector: new Set<RpcArgLiteralKind>(['str', 'int', 'bool', 'float', 'bytes', 'none', 'dict', 'set'])
};

/** 逐族引擎后果语料(l10n 键=en 源串;float 与 str 同为「return 不写流」共键) */
const CONSEQUENCE_KEYS: Record<'int' | 'float' | 'bytes' | 'vector', string> = {
  int: '{receiver}.{method} argument {index} ({literal}) cannot serialize as the declared {type}: the engine logs a TypeError and packs 0 for this argument ({anchor})',
  float: '{receiver}.{method} argument {index} ({literal}) cannot serialize as the declared {type}: the engine logs a TypeError and leaves this argument out of the stream, so the remote side reads misaligned bytes ({anchor})',
  bytes: '{receiver}.{method} argument {index} ({literal}) is not a supported BLOB shape: only bytes is accepted, other objects are cast unchecked and produce undefined bytes ({anchor})',
  vector: '{receiver}.{method} argument {index} ({literal}) cannot be read as the declared {type}: the engine reads components through the sequence protocol and float-converts each; this argument fails the read and garbage goes on the wire ({anchor})'
};

const STRING_CONSEQUENCE_KEY = CONSEQUENCE_KEYS.float; // STRING/UNICODE 与 FLOAT/DOUBLE 同构(return 不写流)

/** 深度 0 且字符串外的冒号/逗号探测(dict/set、tuple/括号表达式区分) */
function hasTopLevelChar(text: string, target: ':' | ','): boolean {
  const depth: string[] = [];
  const closerFor: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
  let inString: string | null = null;
  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index];
    if (inString) {
      if (ch === '\\') { index += 1; continue; }
      if (ch === inString) { inString = null; }
      continue;
    }
    if (ch === '\'' || ch === '"') { inString = ch; continue; }
    if (ch in closerFor) { depth.push(closerFor[ch]); continue; }
    if (depth.length > 0 && ch === depth[depth.length - 1]) { depth.pop(); continue; }
    if (depth.length === 0 && ch === target) { return true; }
  }
  return false;
}

/**
 * 实参字面量形态判定:只对可静态判定的形态下结论;名字/普通调用/星号/推导
 * 形态一律 null(诚实未知,不猜)。
 */
export function inferArgumentLiteralKind(text: string): RpcArgLiteralKind | null {
  const t = text.trim();
  if (!t || t.startsWith('*')) { return null; }
  if (t === 'True' || t === 'False') { return 'bool'; }
  if (t === 'None') { return 'none'; }
  if (/^[+-]?0[xXoObB][0-9a-fA-F_]+$/.test(t)) { return 'int'; }
  if (/^[+-]?\d[\d_]*$/.test(t)) { return 'int'; }
  // float:1.5 / 1. / .5 / 1e3 / 1.5e-3(纯整数已被上一臂收走)
  if (/^[+-]?(?:\d[\d_]*\.\d[\d_]*(?:[eE][+-]?\d+)?|\d[\d_]*[eE][+-]?\d+|\.\d[\d_]*(?:[eE][+-]?\d+)?|\d[\d_]*\.)$/.test(t)) {
    return 'float';
  }
  // 字符串字面量:可选前缀(r/b/u/f 组合,大小写不敏感)+ 首尾同引号
  const stringMatch = /^([rRbBuUfF]{0,2})(['"])([\s\S]*)\2$/.exec(t);
  if (stringMatch) {
    const prefix = stringMatch[1].toLowerCase();
    return prefix.includes('b') && !prefix.includes('f') ? 'bytes' : 'str';
  }
  if (t[0] === '[' && t.endsWith(']')) { return 'list'; }
  if (t[0] === '{' && t.endsWith('}')) {
    // 深度 0 = 容器内层(剔除首尾括号再扫,否则最外层括号把内层深度顶到 1);
    // 空 {} 是空 dict(Python 语义),不是空 set
    if (t === '{}') { return 'dict'; }
    return hasTopLevelChar(t.slice(1, -1), ':') ? 'dict' : 'set';
  }
  if (t[0] === '(' && t.endsWith(')')) {
    return hasTopLevelChar(t.slice(1, -1), ',') ? 'tuple' : null; // 纯括号表达式不猜
  }
  const ctor = /^(?:KBEngine\.)?Vector([234])\([\s\S]*\)$/.exec(t);
  if (ctor) { return ('vector' + ctor[1]) as RpcArgLiteralKind; }
  return null;
}

/** 声明侧:该调用所属 section 的逐槽 <Arg> 类型(多来源不一致 → null) */
export function resolveDeclaredArgTypes(
  declarations: readonly { section: string; declaredArgs?: string[] }[],
  expectedSection: string
): string[] | null {
  const matching = declarations.filter(d => d.section === expectedSection);
  if (matching.length === 0) {
    return null; // 本 section 无声明:段错配面负责,此处未知
  }
  let declared: string[] | null = null;
  for (const declaration of matching) {
    if (declaration.declaredArgs === undefined || declaration.declaredArgs.length === 0) {
      return null; // 声明未就绪(无 Arg 信息):未知
    }
    if (declaration.declaredArgs.some(arg => arg.trim().startsWith('*'))) {
      return null; // 声明带星号形参:类型不可对齐
    }
    if (declared === null) {
      declared = [...declaration.declaredArgs];
    } else if (declared.join('\u0000') !== declaration.declaredArgs.join('\u0000')) {
      return null; // 同 section 多来源类型不一致:歧义,未知
    }
  }
  return declared;
}

/**
 * 全量计算:字面量实参与 .def <Arg> 序列化类型明确不兼容的 Warning。
 * 纯函数(文本 + 内存映射快照);发现面走词法掩码(去字符串/注释伪调用),
 * 槽位文本面走原文(实参字面量判定需要字符串原文,掩码会掏空)——与
 * rpcArgCount 的发现/计数双流分工同款。
 */
export function computeRpcArgTypeCompatFindings(
  text: string,
  mapping?: EntityMapping,
  callerFace?: PythonCallerFace
): RpcArgTypeFinding[] {
  if (!mapping?.methods) { return []; }
  const masked = maskPythonNonCode(text);
  const calls = findPythonReceiverCalls(masked, callerFace);
  if (calls.length === 0) { return []; }
  const rawLines = text.split(/\r?\n/);
  const findings: RpcArgTypeFinding[] = [];
  for (const call of calls) {
    const declarations = mapping.methods[call.methodName];
    if (!declarations || declarations.length === 0) {
      continue; // 声明未就绪:未知,不报
    }
    // 槽位文本面走原文(掩码会掏空字符串实参;跨行/括号不闭合 → null 不声称)
    const spans = parseSingleLineCallArguments(
      rawLines[call.line] ?? '',
      call.character + call.methodName.length
    );
    if (!spans || spans.length === 0) {
      continue; // 跨行/空参:槽位形态未知(数量面另有对账)
    }
    const declared = resolveDeclaredArgTypes(declarations, call.section);
    if (!declared) {
      continue;
    }
    for (let index = 0; index < spans.length; index += 1) {
      if (index >= declared.length) {
        continue; // 超出声明槽位:数量不符归 rpcArgCount,此处不重复
      }
      const builtin = BUILTIN_ARG_TYPES.get(declared[index].trim());
      if (!builtin || FAMILY_OK[builtin.family] === null) {
        continue; // 非内建类型(别名/ARRAY/FIXED_DICT)与不声称族:未知
      }
      const kind = inferArgumentLiteralKind(spans[index].text);
      if (!kind) {
        continue; // 推不出字面量形态:诚实未知
      }
      if (FAMILY_MISMATCH[builtin.family]?.has(kind) !== true) {
        continue; // 兼容或结构上存疑(list/tuple vs VECTOR):不报
      }
      const key = builtin.family === 'str' ? STRING_CONSEQUENCE_KEY : CONSEQUENCE_KEYS[builtin.family as 'int' | 'float' | 'bytes' | 'vector'];
      findings.push({
        line: call.line,
        character: spans[index].start,
        length: spans[index].end - spans[index].start,
        methodName: call.methodName,
        receiver: call.receiver,
        section: call.section,
        argIndex: index + 1,
        declaredType: declared[index].trim(),
        inferredKind: kind,
        message: l10nText(key, {
          receiver: call.receiver,
          method: call.methodName,
          index: String(index + 1),
          literal: spans[index].text,
          type: declared[index].trim(),
          anchor: builtin.anchor
        })
      });
    }
  }
  return findings;
}
