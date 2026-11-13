/**
 * KSEM-SER-06:转换往返字段对应面(encode/decode 静态对拍)。
 *
 * 引擎真源(SER-02 模型 §2,树 3082ab5 实测):序列化侧 addToStreamEx
 * hasImpl 先 impl_getDictFromObj(datatype.cpp:2595),缺声明键静默
 * parseDefaultStr 整体顶替(:2627/:2642);反序列化侧 createFromStreamEx
 * 按声明序重建 wire FixedDict 后交 impl_createObjFromDict(:2673)。
 * 往返链 = obj → getDictFromObj → wire(按声明序拉键)→ createObjFromDict
 * → 新 obj——encode 产出键集与 decode 读取键集的差集就是往返字段错配:
 *  - encode 产出 k 而 decode 不读:值经 wire 往返,解码对象却收不到
 *    (还原/迁移后该字段状态静默丢失);
 *  - decode 读取 k 而 encode 不产出:运行时经由整包默认值顶替,该读取
 *    每次拿到的都是默认值。
 *
 * 静态可比较域(验收「静态比较可确定的 encode/decode 字段对应」):
 *  - encode 键集 = getDictFromObj 全部 return 位可解析闭合字面量的并集
 *    (直接 `return {…}` / 别名赋字面量后 return 别名;字面量后单段
 *    字面量键写点并入键集);`**` 展开/动态键写/setdefault/update/
 *    非 return 形态(构造调用/self/None/属性/无 return)→ 未知,整容器
 *    跳过——「无法静态执行的自定义转换不凭函数名推定结构」(SER-05
 *    同口径);
 *  - decode 键集 = createObjFromDict 体内入参(含直接别名)字符串键读取
 *    的首段键集;`return 入参` 透传或 `{**入参}` 展开 → 对象对应无意义,
 *    整容器跳过;入参动态键写/非字面量下标写 → 读取域开放,encodeOnly
 *    方向不报(decodeOnly 不受影响——读到的键是正向证据)。
 *
 * 不重复面:E−声明 = SER-03 多键车道;声明−E = SER-03 缺键车道;
 * D−声明 = SER-04 车道——往返面对拍只在 声明∩ 键集内裁差。
 * 诚实边界:值往返/语义等价/数值精度**不静态断言**(验收明文「语义等价
 * 和数值往返需真实样本验证」,属 SER-14 运行时样本车道);首段键只判
 * (嵌套 FD 往返不追);重绑后不判;嵌套 def 域跳过;注释/字符串位
 * (掩码核验)不判。
 *
 * 原文/掩码双行口径:键串/字面量内容取原文行(pythonCodeLines 掩码把
 * 字符串内容抹空键位读不出),def 跳过/重绑/代码位判定取掩码行——掩码
 * 等长替换,两侧行列一致(SER-04/05 同构坑)。
 *
 * 纯逻辑层,不 import vscode。
 */

import { l10nText } from '../nlsRuntime';
import {
  containerSource,
  matchDictBraces,
  parseDictPairs,
  type FixedDictConstructDiagnosticItem,
  type MatchedBraces
} from './fixedDictConstructCheck';
import {
  type ImplMethodInputBinding,
  isParamReboundAt,
  keyAccessAt
} from './createObjFromDictInput';
import { pythonCodeLines } from './pythonParser';

export const FIXED_DICT_ROUND_TRIP_SCHEMA_DIAGNOSTIC_CODE =
  'kbengine.fixedDictRoundTripSchema';

/** 一处往返字段错配(encodeOnly = 编码产出解码不读;decodeOnly = 反之)。 */
export interface RoundTripFieldFinding {
  line: number;
  /** 0 基字符列。 */
  character: number;
  length: number;
  /** FD 容器类型名。 */
  container: string;
  /** 涉事键。 */
  key: string;
  direction: 'encodeOnly' | 'decodeOnly';
  /** types.xml 声明位置(file:line)。 */
  source: string;
  message: string;
}

/** 消息模板单一来源(encodeOnly 面)。 */
export function renderRoundTripEncodeOnlyMessage(
  container: string,
  key: string,
  source: string
): string {
  return l10nText(
    '"{key}" is returned by {container}.getDictFromObj but createObjFromDict never reads it (declared in {source}) — the value travels on the wire and is silently dropped from the decoded object (lost on restore or cell migration)',
    { container, key, source }
  );
}

/** 消息模板单一来源(decodeOnly 面)。 */
export function renderRoundTripDecodeOnlyMessage(
  container: string,
  key: string,
  source: string
): string {
  return l10nText(
    '"{key}" is read by {container}.createObjFromDict but getDictFromObj never produces it (declared in {source}) — when a declared key is missing the engine replaces the whole dict with defaults at serialization, so this read always receives the default value',
    { container, key, source }
  );
}

/** 一个可闭合字面量形态:键 → 键位点;open = 展开/推导式/动态键。 */
interface LiteralShape {
  keys: Map<string, { line: number; character: number }>;
  open: boolean;
}

/** encode 键集推导结果;kind 'unknown' = 有不可解析 return 位或透传对象。 */
type EncodeShape =
  | { kind: 'literal'; keys: Map<string, { line: number; character: number }> }
  | { kind: 'unknown' };

/** decode 键集推导结果;passthrough = return 入参/{**入参}。 */
interface DecodeShape {
  reads: Map<string, { line: number; character: number }>;
  open: boolean;
  passthrough: boolean;
}

/** 字面量 → 键位图(展开/推导式/动态键 → open)。 */
function literalShapeOf(matched: MatchedBraces): LiteralShape {
  const { pairs, openUniverse } = parseDictPairs(matched);
  const keys = new Map<string, { line: number; character: number }>();
  const open = openUniverse;
  for (const pair of pairs) {
    if (pair.spread || pair.key === null) {
      continue; // 宇宙开放项不进键集
    }
    keys.set(pair.key, {
      line: pair.keyStart.line,
      character: pair.keyStart.character
    });
  }
  return { keys, open };
}

/**
 * encode 键集:getDictFromObj 体域内全部 return 位都解析为闭合字面量
 * (直接或别名)才返回 literal;字面量后单段字面量键写点并入键集;任何
 * 未知 return / 开放形态 / 动态键写 / setdefault / update → unknown。
 */
function encodeShapeOf(
  masked: readonly string[],
  realLines: readonly string[],
  input: ImplMethodInputBinding
): EncodeShape {
  /** 局部名 → 字面量形态(重绑非字面量 → 移除)。 */
  const literals = new Map<string, LiteralShape>();
  const returnSites: LiteralShape[] = [];
  let unknownReturn = false;

  let line = input.bodyStartLine;
  while (line <= input.bodyEndLine && line < masked.length) {
    const m = masked[line] ?? '';
    const raw = realLines[line] ?? '';
    if (m.trim().length > 0) {
      if (/^\s*def\s/.test(m)) {
        // 嵌套 def 块:内层 return 不返回本方法,整块跳过(域诚实)
        const nestedIndent = m.length - m.trimStart().length;
        line += 1;
        while (line <= input.bodyEndLine && line < masked.length) {
          const inner = masked[line] ?? '';
          if (
            inner.trim().length > 0 &&
            inner.length - inner.trimStart().length <= nestedIndent
          ) {
            break;
          }
          line += 1;
        }
        continue;
      }
      // 局部名 = 非字面量(作废既有字面量;排除 == 与增强赋值)
      const nonLiteralAssign = m.match(/^\s*([A-Za-z_]\w*)\s*=(?![=])\s*(?!\{)\S/);
      if (nonLiteralAssign) {
        literals.delete(nonLiteralAssign[1]);
        line += 1;
        continue;
      }
      // 局部名 = 字面量(列取掩码行 `{` 位=真实列,配对走原文行)
      const literalAssign = m.match(/^(\s*)([A-Za-z_]\w*)\s*=\s*\{/);
      if (literalAssign) {
        const braceColumn = m.indexOf('{');
        const matched = matchDictBraces(realLines, line, braceColumn);
        if (matched) {
          literals.set(literalAssign[2], literalShapeOf(matched));
          line = matched.endLine + 1;
        } else {
          line += 1;
        }
        continue;
      }
      // return 字面量(配对走原文行)
      if (/^\s*return\s*\{/.test(m)) {
        const braceColumn = m.indexOf('{');
        const matched = matchDictBraces(realLines, line, braceColumn);
        if (matched) {
          returnSites.push(literalShapeOf(matched));
          line = matched.endLine + 1;
        } else {
          unknownReturn = true;
          line += 1;
        }
        continue;
      }
      // 裸名 return
      const returnBare = m.match(/^\s*return\s+([A-Za-z_]\w*)\s*$/);
      if (returnBare) {
        const shape = literals.get(returnBare[1]);
        if (shape) {
          returnSites.push(shape);
        } else {
          // 未跟踪名(obj 入参本身/别名/构造结果):引擎要的是 dict,
          // 返回对象形态不可解析 → 未知,不凭名字推定
          unknownReturn = true;
        }
        line += 1;
        continue;
      }
      // 其余 return 形态(构造调用/属性/None/元组…)→ 未知
      if (/^\s*return\b/.test(m)) {
        unknownReturn = true;
        line += 1;
        continue;
      }
    }

    // 已跟踪字面量的键写点面(单段字面量键并入键集;动态键/setdefault/
    // update 归体尾开放面单独裁)。键串内容掩码抹空,匹配与键内容走原文
    // 行,代码位经掩码行核验;单行至多并一个写点。
    let writeHandled = false;
    for (const [name, shape] of literals) {
      if (shape.open || writeHandled) {
        continue;
      }
      const writePattern = new RegExp(
        `^\\s*${name}\\s*\\[\\s*(["'])((?:\\\\.|(?!\\1).)*)\\1\\s*\\]\\s*=(?![=>])`
      );
      const writeMatch = writePattern.exec(raw);
      if (!writeMatch) {
        continue;
      }
      // 名位锚定:`^\s*` 使 match.index 恒 0,名真位取匹配体内名首
      //(缩进无 \w,首现即名),掩码行核验代码位(注释/字符串位已掩空)
      const nameAt = writeMatch.index + writeMatch[0].indexOf(name);
      if (m.slice(nameAt, nameAt + name.length) !== name) {
        continue; // 注释/字符串位
      }
      // 键内容列:引号首现位 + 1(名/缩进无引号字符,首现即键引号;
      // 名与键内容同名时 indexOf(name) 会撞名位,故以引号锚)
      shape.keys.set(writeMatch[2], {
        line,
        character: writeMatch.index + writeMatch[0].indexOf(writeMatch[1]) + 1
      });
      writeHandled = true;
    }
    // 体尾开放面(开放只作废本容器,保守方向):已跟踪字面量的
    // setdefault/update 调用(方法名是代码,掩码行全行判)+ 首段下标
    // 动态访问(掩码抹空引号,raw 行判定,代码位经掩码行核验)。
    // 行内任意位置,不锚行首。
    for (const [name, shape] of literals) {
      if (shape.open) {
        continue;
      }
      if (
        new RegExp(`[^\\w.]${name}\\s*\\.\\s*(setdefault|update)\\s*\\(`).test(m) ||
        new RegExp(`[^\\w.]${name}\\s*[+|]=`).test(m)
      ) {
        shape.open = true;
        continue;
      }
      const dynamicPattern = new RegExp(`[^\\w.]${name}\\s*\\[`, 'g');
      let dynamicMatch: RegExpExecArray | null;
      while ((dynamicMatch = dynamicPattern.exec(raw)) !== null) {
        const head = dynamicMatch.index + 1;
        if (m.slice(head, head + name.length) !== name) {
          continue; // 注释/字符串位
        }
        let after = dynamicMatch.index + dynamicMatch[0].length;
        while (after < raw.length && /\s/.test(raw[after])) {
          after += 1;
        }
        const nextChar = raw[after] ?? '';
        if (nextChar !== '"' && nextChar !== "'") {
          shape.open = true;
          break;
        }
      }
    }
    line += 1;
  }

  if (unknownReturn || returnSites.length === 0) {
    return { kind: 'unknown' };
  }
  for (const site of returnSites) {
    if (site.open) {
      return { kind: 'unknown' };
    }
  }
  const keys = new Map<string, { line: number; character: number }>();
  for (const site of returnSites) {
    for (const [key, at] of site.keys) {
      keys.set(key, at);
    }
  }
  return { kind: 'literal', keys };
}

/**
 * decode 键集:createObjFromDict 体域内入参(含直接别名)字符串键读取的
 * 首段键集;透传 return / `{**入参}` → passthrough;动态键写/非字面量
 * 下标写/setdefault/update → open。
 */
function decodeShapeOf(
  masked: readonly string[],
  realLines: readonly string[],
  input: ImplMethodInputBinding
): DecodeShape {
  const reads = new Map<string, { line: number; character: number }>();
  let open = false;
  let passthrough = false;
  /** 存活接收者:param + 直接别名(重绑剔除)。 */
  let alive: string[] = [input.paramName];

  let line = input.bodyStartLine;
  while (line <= input.bodyEndLine && line < masked.length) {
    const m = masked[line] ?? '';
    const raw = realLines[line] ?? '';
    if (m.trim().length > 0) {
      if (/^\s*def\s/.test(m)) {
        const nestedIndent = m.length - m.trimStart().length;
        line += 1;
        while (line <= input.bodyEndLine && line < masked.length) {
          const inner = masked[line] ?? '';
          if (
            inner.trim().length > 0 &&
            inner.length - inner.trimStart().length <= nestedIndent
          ) {
            break;
          }
          line += 1;
        }
        continue;
      }
      // 存活名单维护:重绑剔除 / `x = param` 收编直接别名(排除 ==)
      const aliasMatch = m.match(/^\s*([A-Za-z_]\w*)\s*=\s*([A-Za-z_]\w*)\s*$/);
      if (aliasMatch && aliasMatch[2] === input.paramName && alive.includes(input.paramName)) {
        alive.push(aliasMatch[1]);
      } else {
        alive = alive.filter(name => !isParamReboundAt(m, name));
      }
      // 透传:return 入参/别名(对象对应无意义)或 `{**入参}` 展开
      const passMatch = m.match(/^\s*return\s+([A-Za-z_]\w*)\s*$/);
      if (
        (passMatch && alive.includes(passMatch[1])) ||
        /^\s*return\s*\{\s*\*\*\s*[A-Za-z_]\w*/.test(m)
      ) {
        passthrough = true;
      }
    }

    if (!passthrough) {
      // 读取收集:接收者链式键访问首段(键串走原文行,代码位掩码核验)
      for (const receiver of alive) {
        const receiverPattern = new RegExp(`(^|[^\\w.])${receiver}(?![\\w])`, 'g');
        let match: RegExpExecArray | null;
        while ((match = receiverPattern.exec(raw)) !== null) {
          const receiverStart = match.index + match[1].length;
          receiverPattern.lastIndex = receiverStart + receiver.length;
          if (m.slice(receiverStart, receiverStart + receiver.length) !== receiver) {
            continue; // 注释/字符串位
          }
          let pos = receiverStart + receiver.length;
          while (pos < raw.length && /\s/.test(raw[pos])) {
            pos += 1;
          }
          const access = keyAccessAt(raw, pos);
          if (!access) {
            continue;
          }
          // 赋值目标键不判(读取面限定;比较/增强形式照判——运行时先读)
          let chainEnd = access.end;
          while (chainEnd < raw.length && /\s/.test(raw[chainEnd])) {
            chainEnd += 1;
          }
          if (/^\s*=(?![=>])/.test(raw.slice(chainEnd))) {
            continue;
          }
          if (!reads.has(access.key)) {
            reads.set(access.key, {
              line,
              character: access.keyCharacter
            });
          }
        }
      }
      // 写点开放面(开放只压 encodeOnly,保守方向):setdefault/update
      // 调用——方法名是代码,掩码行全行判;首段下标动态访问(读/写同一
      // 形态;掩码把字符串内容抹空引号消失,raw 行判定,代码位经掩码行
      // 核验)。行内任意位置,不锚行首。
      for (const receiver of alive) {
        if (
          new RegExp(`[^\\w.]${receiver}\\s*\\.\\s*(setdefault|update)\\s*\\(`).test(m) ||
          new RegExp(`[^\\w.]${receiver}\\s*[+|]=`).test(m)
        ) {
          open = true;
        }
        const dynamicPattern = new RegExp(`[^\\w.]${receiver}\\s*\\[`, 'g');
        let dynamicMatch: RegExpExecArray | null;
        while ((dynamicMatch = dynamicPattern.exec(raw)) !== null) {
          const head = dynamicMatch.index + 1;
          if (m.slice(head, head + receiver.length) !== receiver) {
            continue; // 注释/字符串位
          }
          let after = dynamicMatch.index + dynamicMatch[0].length;
          while (after < raw.length && /\s/.test(raw[after])) {
            after += 1;
          }
          const nextChar = raw[after] ?? '';
          if (nextChar !== '"' && nextChar !== "'") {
            open = true;
            break;
          }
        }
      }
    }
    line += 1;
  }
  return { reads, open, passthrough };
}

/**
 * 往返字段对拍入口。createInputs/getInputs 同为 ImplMethodInputBinding
 * (SER-04/05 共用形状,按 container.name 配对);无配对/encode 未知或
 * 开放/decode 透传 → 该容器零产出。E−声明与声明−E 分别归 SER-03 车道、
 * D−声明归 SER-04 车道,此处只在 声明∩ 键集内裁差。
 */
export function computeRoundTripFieldFindings(
  text: string,
  createInputs: readonly ImplMethodInputBinding[],
  getInputs: readonly ImplMethodInputBinding[]
): RoundTripFieldFinding[] {
  const findings: RoundTripFieldFinding[] = [];
  if (createInputs.length === 0 || getInputs.length === 0) {
    return findings;
  }
  const masked = pythonCodeLines(text);
  const realLines = text.split(/\r?\n/);

  for (const getInput of getInputs) {
    const createInput = createInputs.find(
      candidate => candidate.container.name === getInput.container.name
    );
    if (!createInput) {
      continue;
    }
    const declared = new Set(getInput.container.properties.map(property => property.name));
    const encode = encodeShapeOf(masked, realLines, getInput);
    if (encode.kind !== 'literal' || encode.keys.size === 0) {
      continue;
    }
    const decode = decodeShapeOf(masked, realLines, createInput);
    if (decode.passthrough) {
      continue;
    }
    const source = containerSource(getInput.container);

    // encodeOnly:encode 产出 k(声明内)而 decode 未读——值往返却在解码
    // 对象中静默丢失。decode 域开放时不判(读取未穷尽,不读不成立)。
    if (!decode.open) {
      for (const [key, at] of encode.keys) {
        if (!declared.has(key) || decode.reads.has(key)) {
          continue;
        }
        findings.push({
          line: at.line,
          character: at.character,
          length: Math.max(1, key.length),
          container: getInput.container.name,
          key,
          direction: 'encodeOnly',
          source,
          message: renderRoundTripEncodeOnlyMessage(getInput.container.name, key, source)
        });
      }
    }
    // decodeOnly:decode 读取 k(声明内)而 encode 不产出——运行时该读取
    // 经整包默认值顶替恒为默认。
    for (const [key, at] of decode.reads) {
      if (!declared.has(key) || encode.keys.has(key)) {
        continue;
      }
      findings.push({
        line: at.line,
        character: at.character,
        length: Math.max(1, key.length),
        container: getInput.container.name,
        key,
        direction: 'decodeOnly',
        source,
        message: renderRoundTripDecodeOnlyMessage(getInput.container.name, key, source)
      });
    }
  }
  return findings;
}

/** finding → 诊断项(纯数据;extension 侧转 vscode.Diagnostic,同族形状)。 */
export function roundTripFieldFindingToItem(
  finding: RoundTripFieldFinding
): FixedDictConstructDiagnosticItem {
  return {
    range: {
      start: { line: finding.line, character: finding.character },
      end: { line: finding.line, character: finding.character + finding.length }
    },
    message: finding.message,
    severity: 'Warning',
    source: 'kbengine',
    code: FIXED_DICT_ROUND_TRIP_SCHEMA_DIAGNOSTIC_CODE
  };
}
