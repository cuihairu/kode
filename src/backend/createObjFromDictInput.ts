/**
 * KSEM-SER-04:createObjFromDict 输入字典绑定 FIXED_DICT schema。
 *
 * 引擎真源(entitydef/datatype.cpp:2673 FixedDictType::createFromStreamEx,
 * 树 3082ab5 实测):hasImpl() 时先按 keyTypes_ 声明序从流建好 wire
 * FixedDict(嵌套 FD 字段递归同建),再 `impl_createObjFromDict(pydict)`
 * 把**这个传输字典**交给用户实现——所以 createObjFromDict 方法体内,
 * 入参名收到的正是带 types.xml 声明键位的 wire 形态 FD。此面与
 * STRUCT-07「内存形态键位不接管」口径互补:那里是属性读点(内存形式=
 * 实现类结构),这里是转换边界上的传输形式本身。
 *
 * 三面(验收原句「内部 key 补全/跳转/读取类型可用;错误 key 有可靠上下文
 * 时诊断」):
 * - 补全/跳转/悬停:接收者=入参名且未重绑 → 键位=声明字段
 *   (resolveWireDictSubscriptKeyFromContainer,补全面给全字段);
 * - 诊断:入参名上的字符串键读取(`d["k"]`/`d.get("k")`,含嵌套链)对
 *   声明集校验,未声明键报 Warning——引擎侧 FixedDict 下标抛 KeyError、
 *   .get 静默返默认,静态面是唯一提前可见处;首段未声明即报并止链
 *   (后段键基于错误前缀,不可靠不猜);
 * - 可靠上下文门:绑定唯一(同名多类歧义不猜)、方法缺失零产出、
 *   入参重绑定(=/for/with-as)后读取不判、嵌套 def 域跳过、
 *   注释/字符串位不判(掩码核验)、赋值目标键不判(只判读取)。
 *
 * SER-05 复用(convertedObjMembers.ts,getDictFromObj obj 入参面):
 * resolveImplMethodInputs(方法名参数化)与 isParamReboundAt / keyAccessAt /
 * KeyAccessMatch / wireFdOfAnnotation / splitTopLevelParams 同口径消费。
 *
 * 纯逻辑层,不 import vscode。
 */

import { l10nText } from '../nlsRuntime';
import type { CustomTypeInfo } from '../definitionWorkspace';
import { containerSource, type FixedDictConstructDiagnosticItem } from './fixedDictConstructCheck';
import { FIXED_DICT_TYPE_NAME } from './kbengineMetadata';
import { resolveWireDictSubscriptKeyFromContainer } from './fixedDictSubscript';
import { type FixedDictImplBinding } from './getDictFromObjReturnCheck';
import { parsePythonFile, pythonCodeLines } from './pythonParser';

export const FIXED_DICT_INPUT_KEY_SCHEMA_DIAGNOSTIC_CODE = 'kbengine.fixedDictInputKeySchema';

/** 一条契约方法入参绑定面(SER-03 绑定面 + 入参名与方法体域;SER-04
 *  createObjFromDict 与 SER-05 getDictFromObj 两面共用同一形状)。 */
export interface ImplMethodInputBinding {
  container: CustomTypeInfo;
  symbol: string;
  /** 方法入参名(self/cls 之外的首个形参)。 */
  paramName: string;
  /** def 行(0 基;签名/arity 面锚定用)。 */
  defLine: number;
  /** 方法体域(0 基行,含端点;签名收括号行+1 到体末非空行)。 */
  bodyStartLine: number;
  bodyEndLine: number;
}

/** 一处输入键读取错配(未声明键)。 */
export interface CreateObjFromDictInputKeyFinding {
  line: number;
  /** 0 基字符列。 */
  character: number;
  length: number;
  /** FD 容器类型名(键解析落位的容器)。 */
  container: string;
  /** 涉事键。 */
  key: string;
  /** types.xml 声明位置(file:line)。 */
  source: string;
  message: string;
}

/** 消息模板单一来源(未声明键面)。 */
export function renderFixedDictInputKeyMessage(
  container: string,
  key: string,
  source: string
): string {
  return l10nText(
    '"{key}" is not a field of {container} (declared in {source}); the createObjFromDict input dict only carries declared keys, so this subscript raises KeyError at runtime (.get silently returns the default)',
    { container, key, source }
  );
}

/**
 * 从注册表推导本文档的绑定面(implementedBy 指向本文档 + 符号末段)——
 * diagnostics.ts 与三面 provider 同一推导口径。
 */
export function implBindingsForDocument(
  customTypes: readonly CustomTypeInfo[],
  pythonFilePath: string
): FixedDictImplBinding[] {
  return customTypes
    .filter(info => info.implementedBy && info.pythonFilePath === pythonFilePath)
    .map(info => ({ container: info, symbol: info.implementedBy!.split('.').pop() ?? '' }));
}

/** def 签名解析产物:括号内顶层形参 + 收括号所在行(0 基,方法体起点据此定)。 */
export interface DefSignature {
  params: string[];
  closeLine: number;
}

/** def 签名括号内容(def 行起跨行平衡,原文行;收括号未闭 → null 不猜)。 */
export function defSignatureParams(realLines: readonly string[], defLine: number): DefSignature | null {
  let text = '';
  let line = defLine;
  let found = false;
  while (line < realLines.length) {
    const raw = realLines[line] ?? '';
    if (!found) {
      const open = raw.indexOf('(');
      if (open < 0) {
        return null;
      }
      text = raw.slice(open + 1);
      found = true;
    } else {
      text += raw;
    }
    let depth = 1;
    let quote: string | null = null;
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i];
      if (quote !== null) {
        if (ch === '\\') {
          i += 1;
        } else if (ch === quote) {
          quote = null;
        }
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === '(') {
        depth += 1;
      } else if (ch === ')') {
        depth -= 1;
        if (depth === 0) {
          text = text.slice(0, i);
          return { params: splitTopLevelParams(text), closeLine: line };
        }
      }
    }
    line += 1;
  }
  return null;
}

/** 顶层逗号切分(括号/引号感知;SER-05 dict 字面量键条目切分同用)。 */
export function splitTopLevelParams(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote !== null) {
      current += ch;
      if (ch === '\\') {
        current += text[i + 1] ?? '';
        i += 1;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') {
      depth += 1;
    } else if (ch === ')' || ch === ']' || ch === '}') {
      depth -= 1;
    }
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim().length > 0) {
    parts.push(current);
  }
  return parts;
}

/** 形参名:剥默认值(顶层 `=`)与注解(顶层 `:`);*args/**kwargs/非标识符 → 空。 */
export function paramNameOf(rawParam: string): string {
  let depth = 0;
  let quote: string | null = null;
  let cut = rawParam.length;
  for (let i = 0; i < rawParam.length; i += 1) {
    const ch = rawParam[i];
    if (quote !== null) {
      if (ch === '\\') {
        i += 1;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') {
      depth += 1;
    } else if (ch === ')' || ch === ']' || ch === '}') {
      depth -= 1;
    } else if (depth === 0 && (ch === '=' || ch === ':')) {
      cut = i;
      break;
    }
  }
  const name = rawParam.slice(0, cut).trim();
  if (!/^[A-Za-z_]\w*$/.test(name)) {
    return '';
  }
  return name;
}

/**
 * 推导本文档全部指定契约方法的入参绑定面(SER-04 createObjFromDict /
 * SER-05 getDictFromObj 共用推导口径):绑定唯一类 → 方法在 → 签名可解析
 * → 入参名(self/cls 之外首个形参;无 → 零产出,静态方法式单参也收)。
 * 同名多类歧义不猜(SER-03 同口径)。
 */
export function resolveImplMethodInputs(
  text: string,
  bindings: readonly FixedDictImplBinding[],
  methodName: string,
  allowMissingObj = false
): ImplMethodInputBinding[] {
  const inputs: ImplMethodInputBinding[] = [];
  if (bindings.length === 0) {
    return inputs;
  }
  const parsed = parsePythonFile(text, 'createObjFromDictInput');
  const masked = pythonCodeLines(text);
  const realLines = text.split(/\r?\n/);

  for (const binding of bindings) {
    if (!binding.symbol) {
      continue;
    }
    const classes = parsed.classes.filter(cls => cls.name === binding.symbol);
    if (classes.length !== 1) {
      continue; // 同名多类:歧义不猜
    }
    const cls = classes[0];
    const def = cls.methods.get(methodName);
    if (!def) {
      continue; // 方法缺失归 userTypeContract lane,此处零产出
    }
    const signature = defSignatureParams(realLines, def.line);
    if (!signature) {
      continue;
    }
    const names = signature.params.map(paramNameOf).filter(name => name !== '' && name !== 'self' && name !== 'cls');
    // SER-07 arity 面例外(allowMissingObj):self/星形参之外无 obj
    // 恰是裁定面本身,保绑(paramName 置空;isSameType 消费面只用
    // defLine/体域,不用 paramName)
    if (names.length === 0 && !allowMissingObj) {
      continue; // 只有 self:转换函数收不到字典,零产出不猜
    }
    // 方法体域:签名收括号行为界,首个缩进 ≤ def 缩进的非空行收尾
    // (跨行签名时体从续行之后起,长签名不会把顶格续行误收成体首行)
    const defLine = realLines[def.line] ?? '';
    const defIndent = defLine.length - defLine.trimStart().length;
    let line = signature.closeLine + 1;
    let bodyEnd = signature.closeLine;
    while (line < masked.length) {
      const m = masked[line] ?? '';
      if (m.trim().length > 0 && (m.length - m.trimStart().length) <= defIndent) {
        break;
      }
      if (m.trim().length > 0) {
        bodyEnd = line; // 尾随空行不延长域(体尾锚最后一条非空行)
      }
      line += 1;
    }
    inputs.push({
      container: binding.container,
      symbol: binding.symbol,
      paramName: names.length > 0 ? names[0] : '',
      defLine: def.line,
      bodyStartLine: signature.closeLine + 1,
      bodyEndLine: bodyEnd
    });
  }
  return inputs;
}

/** SER-04 面:createObjFromDict 输入字典绑定(resolveImplMethodInputs 特化)。 */
export function resolveCreateObjFromDictInputBindings(
  text: string,
  bindings: readonly FixedDictImplBinding[]
): ImplMethodInputBinding[] {
  return resolveImplMethodInputs(text, bindings, 'createObjFromDict');
}

/**
 * 行级重绑判定(掩码行):入参名被赋值/for 迭代目标/with-as 重绑 → 之后的
 * 读取不再是原字典/原对象,不可靠不判(SER-04 入参面/SER-05 obj 面同用)。
 */
export function isParamReboundAt(maskedLine: string, paramName: string): boolean {
  if (new RegExp(`^\\s*${paramName}\\s*=(?![=])`).test(maskedLine)) {
    return true;
  }
  if (new RegExp(`^\\s*for\\s+${paramName}\\s+in\\b`).test(maskedLine)) {
    return true;
  }
  if (new RegExp(`^\\s*with\\b.*\\bas\\s+${paramName}\\s*:`).test(maskedLine)) {
    return true;
  }
  return false;
}

/**
 * 三面接收者解析:光标行在绑定面方法体内、接收者恰为入参名、且行前无重绑
 * → wire 容器(键位=types.xml 声明字段);否则 null(交回既有链)。
 * 嵌套 def 域:行落在内层 def 里 → 内层收到的不是本方法入参,作废不猜。
 */
export function resolveCreateObjFromDictInputReceiver(
  text: string,
  inputs: readonly ImplMethodInputBinding[],
  line: number,
  receiver: string
): CustomTypeInfo | null {
  if (inputs.length === 0) {
    return null;
  }
  const masked = pythonCodeLines(text);
  for (const input of inputs) {
    if (receiver !== input.paramName || line < input.bodyStartLine || line > input.bodyEndLine) {
      continue;
    }
    let cursor = input.bodyStartLine;
    let alive = true;
    while (cursor <= Math.min(line, masked.length - 1)) {
      const m = masked[cursor] ?? '';
      if (m.trim().length > 0) {
        const indent = m.length - m.trimStart().length;
        // 嵌套 def 块:行落在内层域内 → 接收者属内层作用域,不接管
        if (/^\s*def\s/.test(m)) {
          const nestedIndent = indent;
          cursor += 1;
          let nestedEnd = cursor - 1;
          while (cursor < masked.length) {
            const inner = masked[cursor] ?? '';
            if (inner.trim().length > 0 && (inner.length - inner.trimStart().length) <= nestedIndent) {
              break;
            }
            nestedEnd = cursor;
            cursor += 1;
          }
          if (line <= nestedEnd) {
            return null;
          }
          continue;
        }
        if (alive && cursor < line && isParamReboundAt(m, input.paramName)) {
          alive = false;
        }
      }
      cursor += 1;
    }
    if (!alive) {
      return null;
    }
    return input.container;
  }
  return null;
}

/** 键访问形态(`["k"]` 下标 / `.get("k")` 方法)在原文行上的扫描游标
 *  (SER-04 入参面/SER-05 obj 面同用)。 */
export interface KeyAccessMatch {
  /** 0 基列(引号位或 get 名位)。 */
  character: number;
  /** 键串内容(引号内,不含引号)。 */
  key: string;
  /** 键串首字符列(诊断锚位)。 */
  keyCharacter: number;
  /** 访问段后一列。 */
  end: number;
  form: 'subscript' | 'get';
}

/** pos 列起解析一个键访问段;非键访问返回 null(数字/变量/切片断链)。 */
export function keyAccessAt(lineText: string, pos: number): KeyAccessMatch | null {
  if (lineText[pos] === '[') {
    let i = pos + 1;
    while (i < lineText.length && /\s/.test(lineText[i])) {
      i += 1;
    }
    const quote = lineText[i];
    if (quote === '"' || quote === "'") {
      let j = i + 1;
      while (j < lineText.length && lineText[j] !== quote && lineText[j] !== '\\') {
        j += 1;
      }
      if (j < lineText.length && lineText[j] === quote) {
        let k = j + 1;
        while (k < lineText.length && /\s/.test(lineText[k])) {
          k += 1;
        }
        if (k >= lineText.length || lineText[k] === ']' || /\s/.test(lineText[k])) {
          return {
            character: pos,
            key: lineText.slice(i + 1, j),
            keyCharacter: i + 1,
            end: k < lineText.length && lineText[k] === ']' ? k + 1 : lineText.length,
            form: 'subscript'
          };
        }
      }
      return null;
    }
    return null; // 表达式/数字/切片下标:键静态不可知,断链
  }
  const getForm = /^\.get\s*\(/.exec(lineText.slice(pos));
  if (!getForm) {
    return null;
  }
  let i = pos + getForm[0].length;
  while (i < lineText.length && /\s/.test(lineText[i])) {
    i += 1;
  }
  const quote = lineText[i];
  if (quote === '"' || quote === "'") {
    let j = i + 1;
    while (j < lineText.length && lineText[j] !== quote && lineText[j] !== '\\') {
      j += 1;
    }
    if (j < lineText.length && lineText[j] === quote) {
      let k = j + 1;
      while (k < lineText.length && /\s/.test(lineText[k])) {
        k += 1;
      }
      if (k >= lineText.length || lineText[k] === ')' || /\s/.test(lineText[k])) {
        return {
          character: pos,
          key: lineText.slice(i + 1, j),
          keyCharacter: i + 1,
          end: k < lineText.length && lineText[k] === ')' ? k + 1 : lineText.length,
          form: 'get'
        };
      }
    }
  }
  return null; // .get(变量):键静态不可知,断链
}

/**
 * 输入键读取校验:绑定面方法体内入参名上的字符串键读取(subscript/.get,
 * 含嵌套链)对声明集校验,未声明键报 Warning;首段未声明即报并止链。
 * 诚实边界:赋值目标键(`d["k"] = v`)不判、重绑后读取不判、嵌套 def 域
 * 跳过、注释/字符串位(掩码核验)不判、键解析断链(数组/表达式下标)不判。
 */
export function computeCreateObjFromDictInputKeyFindings(
  text: string,
  inputs: readonly ImplMethodInputBinding[],
  customTypes: readonly CustomTypeInfo[]
): CreateObjFromDictInputKeyFinding[] {
  const findings: CreateObjFromDictInputKeyFinding[] = [];
  if (inputs.length === 0) {
    return findings;
  }
  const masked = pythonCodeLines(text);
  const realLines = text.split(/\r?\n/);

  for (const input of inputs) {
    let alive = true;
    let line = input.bodyStartLine;
    while (line <= input.bodyEndLine && line < masked.length) {
      const m = masked[line] ?? '';
      const raw = realLines[line] ?? '';
      if (m.trim().length > 0) {
        const indent = m.length - m.trimStart().length;
        if (/^\s*def\s/.test(m)) {
          // 嵌套 def 块:内层代码不判(域诚实),整块跳过
          const nestedIndent = indent;
          line += 1;
          while (line <= input.bodyEndLine && line < masked.length) {
            const inner = masked[line] ?? '';
            if (inner.trim().length > 0 && (inner.length - inner.trimStart().length) <= nestedIndent) {
              break;
            }
            line += 1;
          }
          continue;
        }
        if (alive && isParamReboundAt(m, input.paramName)) {
          alive = false;
          line += 1;
          continue;
        }
      }
      if (alive) {
        findings.push(...inputKeyReadsOnLine(raw, m, line, input, customTypes));
      }
      line += 1;
    }
  }
  return findings;
}

/** wire 形态字段注解 → 嵌套 FD 容器(implementedBy 容器照收;非 FD → null
 *  止链;SER-04 入参面/SER-05 obj 面同用)。 */
export function wireFdOfAnnotation(
  annotation: string | null,
  customTypes: readonly CustomTypeInfo[]
): CustomTypeInfo | null {
  if (!annotation) {
    return null;
  }
  return customTypes.find(
    info => info.name === annotation && info.aliasType === FIXED_DICT_TYPE_NAME
  ) ?? null;
}

/** 单行入参名键读取扫描(原文行取键,掩码行核验代码位)。 */
function inputKeyReadsOnLine(
  rawLine: string,
  maskedLine: string,
  line: number,
  input: ImplMethodInputBinding,
  customTypes: readonly CustomTypeInfo[]
): CreateObjFromDictInputKeyFinding[] {
  const findings: CreateObjFromDictInputKeyFinding[] = [];
  const param = input.paramName;
  const receiverPattern = new RegExp(`(^|[^\\w.])${param}(?![\\w])`, 'g');
  let match: RegExpExecArray | null;
  while ((match = receiverPattern.exec(rawLine)) !== null) {
    const receiverStart = match.index + match[1].length;
    receiverPattern.lastIndex = receiverStart + param.length;
    // 掩码核验:接收者必须是代码位(注释/字符串里的同名形态不判)
    if (maskedLine.slice(receiverStart, receiverStart + param.length) !== param) {
      continue;
    }
    // 接收者后必须紧跟键访问段(空白后 `[`/`.get(`);其余属性访问断链
    let pos = receiverStart + param.length;
    while (pos < rawLine.length && /\s/.test(rawLine[pos])) {
      pos += 1;
    }
    const accesses: KeyAccessMatch[] = [];
    while (pos < rawLine.length) {
      const access = keyAccessAt(rawLine, pos);
      if (!access) {
        break;
      }
      accesses.push(access);
      // 段后允许继续链(`["k2"]`/`.get("k2")`);其余(方法调用/属性)止链
      let next = access.end;
      while (next < rawLine.length && /\s/.test(rawLine[next])) {
        next += 1;
      }
      if (next < rawLine.length && (rawLine[next] === '[' || /^\.get\s*\(/.test(rawLine.slice(next)))) {
        pos = next;
        continue;
      }
      pos = next;
      break;
    }
    if (accesses.length === 0) {
      continue;
    }
    // 赋值目标键(末段后跟 `=` 且非 ==/>=):写入面不判(读取面限定);
    // `+=`/`==`/`!=` 等比较与增强形式照判——运行时同样先读取该键
    if (/^\s*=(?![=>])/.test(rawLine.slice(pos))) {
      continue;
    }
    // 逐段走链:当前容器上查键;未声明 → 报并止链(后段基于错误前缀,不可靠)
    let container: CustomTypeInfo | null = input.container;
    for (const access of accesses) {
      if (!container) {
        break; // 前段字段非 FD(标量/数组/不可解析):嵌套键不猜容器
      }
      const resolution = resolveWireDictSubscriptKeyFromContainer(container, [], access.key, customTypes);
      if (!resolution?.field) {
        const source = containerSource(container);
        findings.push({
          line,
          character: access.keyCharacter,
          length: Math.max(1, access.key.length),
          container: container.name,
          key: access.key,
          source,
          message: renderFixedDictInputKeyMessage(container.name, access.key, source)
        });
        break;
      }
      // 已声明:下一段容器=字段注解解析的 wire FD(嵌套 implementedBy 照收)
      container = wireFdOfAnnotation(resolution.annotation, customTypes);
    }
  }
  return findings;
}

/** finding → 诊断项(纯数据;extension 侧转 vscode.Diagnostic,与构造点同形状)。 */
export function createObjFromDictInputFindingToItem(
  finding: CreateObjFromDictInputKeyFinding
): FixedDictConstructDiagnosticItem {
  return {
    range: {
      start: { line: finding.line, character: finding.character },
      end: { line: finding.line, character: finding.character + finding.length }
    },
    message: finding.message,
    severity: 'Warning',
    source: 'kbengine',
    code: FIXED_DICT_INPUT_KEY_SCHEMA_DIAGNOSTIC_CODE
  };
}
