/**
 * KSEM-SER-07:isSameType 契约边界面(签名/调用绑定 + 兼容性证明状态)。
 *
 * 引擎真源(datatype.cpp,树实测):
 *  - 调用绑定 = 单位置实参:impl 判定经 PyObject_CallFunction(pyIsSameType,
 *    "(O)", obj)(:2450-2452)——self 之外恰好一个形参;形参缺/多(无默认)
 *    → 每次判定 TypeError,SCRIPT_ERROR_CHECK 记脚本错误并按 false 回落
 *    内建校验(错误刷屏);
 *  - 判真 = 指针恒等:Py_True == pyRet(:2458)——只有字面 True 短路判真;
 *    返回 1/其他 truthy 对象一律按 false 处理;
 *  - 短路语义(FixedDictType::isSameType :2497-2512):impl 返回 True →
 *    立即 return true,内建校验(FixedDict 实例/字典尺寸/逐键类型)全部
 *    跳过;impl 返回 false 时引擎忽略该判定继续内建校验(:2506)——返回
 *    False 不拒绝对象;
 *  - impl_createObjFromDict 后置校验(:2421):转换结果必须过 isSameType,
 *    失败记脚本错误——isSameType 是转换链的兼容性闸门。
 *
 * 静态可判定域(验收「校验可确定签名和调用绑定;动态返回不能冒称已证明
 * 对象兼容,给出待运行验证状态」):
 *  - arity 面(Warning):def 签名对引擎单位置实参绑定静态裁定——self/cls
 *    之外恰好一个无默认位置形参(或带名 *args 承接)合法;零位置承接/
 *    多余无默认位置形参/仅关键字必需形参(**kwargs 不承接位置实参)→
 *    每次调用 TypeError,锚 def 行方法名;签名不可解析(收括号未闭)→
 *    该方法零产出不猜;
 *  - 兼容性证明状态(每方法至多一条,优先级聚合 acceptAll > pending >
 *    fallback,Information):
 *     - acceptAll:存在 return True 位——impl 可短路引擎免检;
 *     - pending:存在静态不可证明返回位(调用/表达式/裸名/未解析类名
 *       isinstance)——兼容性未证明,待运行验证,不冒称已证明也不冒称
 *       不兼容(验收核心句);
 *     - fallback:全部返回位皆非 True 常量(False/None/数值/字符串)——
 *       引擎按指针恒等只认 True,恒被无视、内建校验兜底。
 *    isinstance(obj, X):X 全部可解析(内建类型名或本文件类名)→ 该位
 *    已证明,零产出;任一元素不可解析 → pending 锚该元素。
 *  - 嵌套 def 域跳过(域诚实);注释/字符串位不判(掩码核验)。
 *
 * raw/masked 双行口径:True/False/isinstance/类名是代码,掩码行保留;
 * 字符串常量内容掩码抹空(return "" 掩码后仍按带引号常量裁)。锚列取
 * 原文行(掩码等长,两侧行列一致,SER-04/05/06 同构坑)。
 *
 * 纯逻辑层,不 import vscode。
 */

import { l10nText } from '../nlsRuntime';
import {
  containerSource,
  type FixedDictConstructDiagnosticItem
} from './fixedDictConstructCheck';
import {
  defSignatureParams,
  paramNameOf,
  type ImplMethodInputBinding
} from './createObjFromDictInput';
import { pythonCodeLines } from './pythonParser';

export const SAME_TYPE_CONTRACT_CODE = 'kbengine.isSameTypeBinding';

/** 一个 isSameType 契约边界发现(face 即证明状态)。 */
export interface SameTypeFinding {
  line: number;
  /** 0 基字符列。 */
  character: number;
  length: number;
  /** FD 容器类型名。 */
  container: string;
  /** impl 符号名。 */
  symbol: string;
  /** arity=签名不符(Warning);acceptAll=恒 True 免检;fallback=非 True
   *  常量恒被无视回落内建;pending=动态返回待运行验证。 */
  face: 'arity' | 'acceptAll' | 'fallback' | 'pending';
  message: string;
}

/** arity 面(签名对引擎单位置实参绑定静态裁定为不符)。 */
export function renderArityMsg(symbol: string): string {
  return l10nText('{symbol}.isSameType signature does not match the engine call binding — the engine passes exactly one positional argument (datatype.cpp impl_isSameType), so every check raises TypeError and script errors replace validation', { symbol });
}

/** acceptAll 面(恒 True 短路免检)。 */
export function renderAcceptAllMsg(
  container: string,
  symbol: string,
  source: string
): string {
  return l10nText('{symbol}.isSameType returns True unconditionally (declared in {source}) — the engine short-circuits on True and skips built-in validation entirely, so every object is accepted as {container} without per-key checks', { container, symbol, source });
}

/** fallback 面(非 True 常量恒被无视,引擎回落内建校验)。 */
export function renderFallbackMsg(
  container: string,
  symbol: string,
  source: string
): string {
  return l10nText('{symbol}.isSameType only returns constants other than True (declared in {source}) — the engine compares the return by pointer identity with True, so these returns never count and built-in validation decides instead; returning False does not reject {container} objects', { container, symbol, source });
}

/** pending 面(动态返回待运行验证,不冒称已证明兼容)。 */
export function renderPendingMsg(
  container: string,
  symbol: string,
  source: string
): string {
  return l10nText('{symbol}.isSameType returns a value whose compatibility cannot be proven statically (declared in {source}); object compatibility for {container} is unverified — runtime samples are required before treating this converter as verified', { container, symbol, source });
}

/** Python 内建类型名(isinstance 元素可解析域)。 */
const BUILTIN_TYPES: ReadonlySet<string> = new Set([
  'int', 'str', 'float', 'bool', 'bytes', 'bytearray', 'list', 'tuple',
  'dict', 'set', 'frozenset', 'object', 'complex', 'type', 'range',
  'memoryview'
]);

/** 一个返回位分类。 */
interface RetSite {
  face: 'acceptAll' | 'fallback' | 'pending';
  line: number;
  character: number;
  length: number;
}

/** 聚合优先级:恒 True 免检 > 待运行验证 > 恒被无视。 */
const FACE_RANK: Record<RetSite['face'], number> = {
  acceptAll: 3,
  pending: 2,
  fallback: 1
};

/** 常量 token:False/None/数值/带引号字面量(掩码行内容为占位)。 */
function isConstToken(token: string): boolean {
  if (token === 'False' || token === 'None') {
    return true;
  }
  if (/^-?\d[\d_]*(\.\d+)?$/.test(token)) {
    return true;
  }
  return /^(["']).*\1$/.test(token);
}

/** 裸标识符。 */
function isBareName(token: string): boolean {
  return /^[A-Za-z_]\w*$/.test(token);
}

/** 跳过嵌套 def 块,返回跳出后应处理的行号。 */
function skipNested(
  masked: readonly string[],
  at: number,
  end: number
): number {
  const head = masked[at] ?? '';
  const base = head.length - head.trimStart().length;
  let line = at + 1;
  while (line <= end && line < masked.length) {
    const inner = masked[line] ?? '';
    if (
      inner.trim().length > 0 &&
      inner.length - inner.trimStart().length <= base
    ) {
      break;
    }
    line += 1;
  }
  return line;
}

/** 掩码行收集本文件类名(isinstance 元素可解析域)。 */
function fileClassNames(masked: readonly string[]): Set<string> {
  const names = new Set<string>();
  const pattern = /^\s*class\s+([A-Za-z_]\w*)/;
  for (const line of masked) {
    const hit = pattern.exec(line);
    if (hit) {
      names.add(hit[1]);
    }
  }
  return names;
}

/** 原文行 start 处取平衡括号段(内容 + 闭括号列;不闭 → null)。 */
function parenSpan(
  raw: string,
  start: number
): { content: string; end: number } | null {
  if (raw[start] !== '(') {
    return null;
  }
  let depth = 0;
  let quote: string | null = null;
  for (let i = start; i < raw.length; i += 1) {
    const ch = raw[i];
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
        return { content: raw.slice(start + 1, i), end: i };
      }
    }
  }
  return null;
}

/**
 * isinstance 第二实参元素集(裸名/元组裸名,元组形态递归展开为叶子),
 * 元素带原行列;形态不符 → null(归 pending,不猜)。
 * content = isinstance 平衡段内文本,base = 其在原行的起始列。
 */
function typeTestArgs(
  content: string,
  base: number
): Array<{ name: string; start: number }> | null {
  let text = content;
  let origin = base;
  if (content.trimStart().startsWith('(')) {
    const at = content.indexOf('(');
    const inner = parenSpan(content, at);
    if (!inner) {
      return null;
    }
    text = inner.content;
    origin = base + at + 1;
  }
  const pieces = splitTypeArgs(text, origin);
  if (pieces === null) {
    return null;
  }
  const leaves: Array<{ name: string; start: number }> = [];
  for (const piece of pieces) {
    if (piece.name.trimStart().startsWith('(')) {
      const at = piece.name.indexOf('(');
      const inner = parenSpan(piece.name, at);
      if (!inner) {
        return null;
      }
      const nested = splitTypeArgs(inner.content, piece.start + at + 1);
      if (nested === null) {
        return null;
      }
      leaves.push(...nested);
    } else {
      leaves.push(piece);
    }
  }
  return leaves;
}

/**
 * 顶层逗号拆分(引号/括号深度感知),元素带原行列(列 = 元素首非空白
 * 字符)。未闭引号段仍按已收元素返回(调用侧元素形态校验兜底)。
 */
function splitTypeArgs(
  text: string,
  origin: number
): Array<{ name: string; start: number }> {
  const elements: Array<{ name: string; start: number }> = [];
  let depth = 0;
  let quote: string | null = null;
  let current = '';
  let mark = origin;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote !== null) {
      if (ch === '\\') {
        i += 1;
        current += ch;
      } else if (ch === quote) {
        quote = null;
        current += ch;
      } else {
        current += ch;
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
      const piece = current.trim();
      if (piece.length > 0) {
        elements.push({ name: piece, start: mark });
      }
      current = '';
      mark = origin + i + 1;
      continue;
    }
    if (current.trim().length === 0 && /\s/.test(ch)) {
      mark = origin + i + 1;
      continue;
    }
    current += ch;
  }
  const piece = current.trim();
  if (piece.length > 0) {
    elements.push({ name: piece, start: mark });
  }
  return elements;
}

/**
 * isSameType 契约边界入口。inputs = resolveImplMethodInputs(
 * text, bindings, 'isSameType')(SER-04/05/06 同构机)。
 */
export function computeSameTypeFindings(
  text: string,
  inputs: readonly ImplMethodInputBinding[]
): SameTypeFinding[] {
  const findings: SameTypeFinding[] = [];
  if (inputs.length === 0) {
    return findings;
  }
  const masked = pythonCodeLines(text);
  const realLines = text.split(/\r?\n/);
  const docClasses = fileClassNames(masked);

  for (const input of inputs) {
    const symbol = input.symbol;
    const container = input.container;
    const source = containerSource(container);
    const short = symbol.includes('.')
      ? symbol.slice(symbol.lastIndexOf('.') + 1)
      : symbol;

    // ── arity 面:签名对引擎单位置实参绑定静态裁定 ──
    const signature = defSignatureParams(realLines, input.defLine);
    if (signature === null) {
      continue; // 签名不可解析(收括号未闭):不猜
    }
    // 形参逐位裁定(原文判,不依赖剥名行为):'/' 为 positional-only 标记;
    // '*' 开头 = 仅关键字域(带名单星 *args 才承接引擎位置实参,'**' 只收
    // 关键字);有默认 = 形参含 '='(纯注解形参无 '=';'==' 只可能出现在
    // 默认表达式内,仍属有默认)。self/cls 之外引擎恰好传一个位置实参:
    // 无位置承接 / 多余无默认位置形参 / 仅关键字必需形参 → 恒 TypeError。
    let objSeen = false;
    let varArgsSeen = false;
    let starForm = false;
    let badArity = false;
    for (const rawParam of signature.params) {
      const trimmed = rawParam.trim();
      if (trimmed === '/') {
        continue;
      }
      if (trimmed.startsWith('*')) {
        starForm = true;
        varArgsSeen = trimmed.length > 1 && !trimmed.startsWith('**');
        continue;
      }
      const name = paramNameOf(trimmed);
      if (!objSeen && (name === 'self' || name === 'cls')) {
        continue;
      }
      const hasDefault = trimmed.includes('=');
      if (starForm) {
        if (!hasDefault) {
          badArity = true; // 仅关键字必需形参,引擎不传
        }
        continue;
      }
      if (!objSeen) {
        objSeen = true; // obj 形参(引擎位置实参承接位)
        continue;
      }
      if (!hasDefault) {
        badArity = true; // 多余必需位置形参
      }
    }
    if (!objSeen && !varArgsSeen) {
      badArity = true; // 引擎的单位置实参无处承接
    }
    if (badArity) {
      const defText = realLines[input.defLine] ?? '';
      // 锚 def 行方法名:symbol 是容器限定类名(不含方法名),
      // indexOf(short) 在 def 行落空 → 错锚 0;从 def 行取真名)
      const nameMatch = /^\s*def\s+([A-Za-z_]\w*)/.exec(defText);
      const at = nameMatch
        ? nameMatch.index + nameMatch[0].indexOf(nameMatch[1])
        : defText.indexOf(short);
      const anchored = nameMatch ? nameMatch[1] : short;
      findings.push({
        line: input.defLine,
        character: at >= 0 ? at : 0,
        length: Math.max(1, anchored.length),
        container: container.name,
        symbol,
        face: 'arity',
        message: renderArityMsg(symbol)
      });
      continue; // 签名不符:调用恒 TypeError,体面无意义
    }

    // ── 兼容性证明状态:返回位分类(优先级聚合) ──
    let best: RetSite | null = null;
    let line = input.bodyStartLine;
    while (line <= input.bodyEndLine && line < masked.length) {
      const m = masked[line] ?? '';
      if (m.trim().length === 0) {
        line += 1;
        continue;
      }
      if (/^\s*def\s/.test(m)) {
        line = skipNested(masked, line, input.bodyEndLine);
        continue;
      }
      if (!/^\s*return\s+\S/.test(m)) {
        line += 1;
        continue;
      }
      const raw = realLines[line] ?? '';
      const returnAt = m.indexOf('return');
      // ── isinstance(...):全元素可解析 → 已证明零产出;否则 pending ──
      if (/^\s*return\s+isinstance\s*\(/.test(m)) {
        const openAt = raw.indexOf('(', returnAt + 6);
        const span = openAt >= 0 ? parenSpan(raw, openAt) : null;
        const elements = span ? typeTestArgs(span.content, openAt + 1) : null;
        const resolvable =
          elements !== null &&
          elements.length >= 2 &&
          elements
            .slice(1)
            .every(
              element =>
                isBareName(element.name) &&
                (BUILTIN_TYPES.has(element.name) || docClasses.has(element.name))
            );
        if (!resolvable) {
          const unresolved =
            elements !== null && elements.length >= 2
              ? elements
                  .slice(1)
                  .find(
                    element =>
                      !isBareName(element.name) ||
                      (!BUILTIN_TYPES.has(element.name) &&
                        !docClasses.has(element.name))
                  )
              : undefined;
          const anchor =
            unresolved !== undefined
              ? unresolved.start
              : raw.indexOf('isinstance', returnAt);
          if (best === null || FACE_RANK.pending > FACE_RANK[best.face]) {
            best = {
              face: 'pending',
              line,
              character: anchor,
              length: Math.max(
                1,
                unresolved !== undefined
                  ? unresolved.name.length
                  : 'isinstance'.length
              )
            };
          }
        }
        line += 1;
        continue;
      }
      // ── 单 token:return True / 非 True 常量 / 裸名 ──
      const constMatch = /^\s*return\s+(\S+)\s*$/.exec(m);
      if (constMatch) {
        const tokenMasked = constMatch[1];
        const rawHit = /^\s*(\S+)/.exec(raw.slice(returnAt + 6));
        const tokenRaw = rawHit ? rawHit[1] : tokenMasked;
        const tokenAt = raw.indexOf(tokenRaw, returnAt + 6);
        const anchor = tokenAt >= 0 ? tokenAt : returnAt + 7;
        if (tokenRaw === 'True') {
          if (best === null || FACE_RANK.acceptAll > FACE_RANK[best.face]) {
            best = {
              face: 'acceptAll',
              line,
              character: anchor,
              length: Math.max(1, tokenRaw.length)
            };
          }
        } else if (isConstToken(tokenRaw)) {
          if (best === null || FACE_RANK.fallback > FACE_RANK[best.face]) {
            best = {
              face: 'fallback',
              line,
              character: anchor,
              length: Math.max(1, tokenRaw.length)
            };
          }
        } else {
          if (best === null || FACE_RANK.pending > FACE_RANK[best.face]) {
            best = {
              face: 'pending',
              line,
              character: anchor,
              length: Math.max(1, tokenRaw.length)
            };
          }
        }
        line += 1;
        continue;
      }
      // ── 其余多 token return(调用/表达式/括号常量)→ pending ──
      const rawHit = /(\S+)/.exec(raw.slice(returnAt + 6));
      const tokenRaw = rawHit ? rawHit[1] : '';
      const tokenAt = tokenRaw ? raw.indexOf(tokenRaw, returnAt + 6) : returnAt;
      if (best === null || FACE_RANK.pending > FACE_RANK[best.face]) {
        best = {
          face: 'pending',
          line,
          character: tokenAt >= 0 ? tokenAt : returnAt,
          length: Math.max(1, tokenRaw.length || 1)
        };
      }
      line += 1;
    }

    if (best === null) {
      continue; // 全部返回位已证明(可解析 isinstance)或无 return:零产出
    }
    const message =
      best.face === 'acceptAll'
        ? renderAcceptAllMsg(container.name, symbol, source)
        : best.face === 'fallback'
          ? renderFallbackMsg(container.name, symbol, source)
          : renderPendingMsg(container.name, symbol, source);
    findings.push({
      line: best.line,
      character: best.character,
      length: best.length,
      container: container.name,
      symbol,
      face: best.face,
      message
    });
  }
  return findings;
}

/** finding → 诊断项(arity Warning;证明状态面 Information;同族形状)。 */
export function sameTypeFindingToItem(
  finding: SameTypeFinding
): FixedDictConstructDiagnosticItem {
  return {
    range: {
      start: { line: finding.line, character: finding.character },
      end: { line: finding.line, character: finding.character + finding.length }
    },
    message: finding.message,
    severity: finding.face === 'arity' ? 'Warning' : 'Information',
    source: 'kbengine',
    code: SAME_TYPE_CONTRACT_CODE
  };
}
