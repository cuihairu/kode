/**
 * KSEM-SER-05:转换输出对象成员关联与校验。
 *
 * 引擎真源(entitydef/datatype.cpp,树 3082ab5 实测):createFromStreamEx
 * 把 impl_createObjFromDict 的产物存为属性内存形态;序列化时 addToStreamEx
 * 调 impl_getDictFromObj → PyObject_CallFunction(pygetDictFromObj_, obj)
 * ——getDictFromObj 体内对转换产物读**不存在的成员**,调用抛 KeyError →
 * 返回 NULL → SCRIPT_ERROR_CHECK 记脚本错误并 parseDefaultStr("") 整体
 * 顶替(datatype.cpp:2440-2444),整张字典按默认值序列化;.get 则静默
 * 返回 None。
 *
 * 结构推导(验收「将可解析构造/赋值与输出对象成员关联」)——createObjFromDict
 * 体内 return 形态:
 *  - return {字面量} / 别名赋字面量后 return 别名 → dict 形态(键=字面量键,
 *    多行字面量整体拼接;**展开/推导式/动态键 → 开放键集;`{1,2}` 集合字面量
 *    不是 dict → 未知);
 *  - return 入参(未重绑)→ wire 形态(getDictFromObj 收到的正是当初传入的
 *    传输字典,键=types.xml 声明);return 入参["纯字符串键链"] → 链解析
 *    落位的嵌套 wire 容器;
 *  - 构造调用/方法调用/属性访问/return None/无 return/混合未知 → unknown
 *    ——「无法静态执行的自定义转换不凭函数名推定结构」:callee 名字一律
 *    不作结构依据。
 * 校验面(验收「检查转换后的对象成员」):同容器 getDictFromObj 体内 obj
 * 入参的字符串键读取(`obj["k"]`/`obj.get("k")`)对推导键集校验——dict 形态
 * 判首段(嵌套字面量形状属 getDictFromObjReturnCheck 车道,不重复判),wire
 * 形态全链走容器。开放宇宙门(cellData 错键同口径):本文档 obj 接收者出现
 * 动态键写/非字面量下标写/嵌套写/setdefault/update → 键宇宙开放,缺失不报;
 * 字面量键写点并入键集。诚实边界:重绑后读取不判、嵌套 def 域跳过、
 * 注释/字符串位(掩码核验)不判、赋值目标键不判而 +=/== 照判(先读)、
 * 跨文件变异不追(文档级口径)。原文/掩码双行口径:表达式文本/字面量/
 * 链键取原文行(掩码把字符串内容抹成 `_`,键位读不出),注释/def/重绑/
 * 代码位判定取掩码行——掩码等长替换,两侧行列一致(SER-04 raw/masked
 * 同构)。
 *
 * 纯逻辑层,不 import vscode。
 */

import { l10nText } from '../nlsRuntime';
import type { CustomTypeInfo } from '../definitionWorkspace';
import { containerSource, type FixedDictConstructDiagnosticItem } from './fixedDictConstructCheck';
import { resolveWireDictSubscriptKeyFromContainer } from './fixedDictSubscript';
import {
  type ImplMethodInputBinding,
  isParamReboundAt,
  keyAccessAt,
  splitTopLevelParams,
  wireFdOfAnnotation,
  type KeyAccessMatch
} from './createObjFromDictInput';
import { pythonCodeLines } from './pythonParser';

export const FIXED_DICT_OUTPUT_MEMBER_SCHEMA_DIAGNOSTIC_CODE = 'kbengine.fixedDictOutputMemberSchema';

/** 转换输出对象的结构推导产物。 */
export type ConvertedObjStructure =
  | {
      /** wire 形态:return 透传入参(或纯字符串键链落位),getDictFromObj
       *  收到的就是传输字典,链可走容器;extraKeys=体内字面量键写点。 */
      kind: 'wire';
      container: CustomTypeInfo;
      extraKeys: string[];
    }
  | {
      /** dict 形态:字面量(直接/别名)键集;open=展开/推导式/动态键/动态写,
       *  开放键集不判缺失;source=推导出处(file:line)。 */
      kind: 'dict';
      keys: string[];
      open: boolean;
      source: string;
    }
  | {
      /** 未知:自定义转换/重绑/混合返回/无返回——不凭函数名推定结构。 */
      kind: 'unknown';
    };

/** 一处转换输出成员读取错配(推导键集缺失)。 */
export interface ConvertedObjMemberFinding {
  line: number;
  /** 0 基字符列。 */
  character: number;
  length: number;
  /** FD 容器类型名(绑定容器)。 */
  container: string;
  /** 涉事键。 */
  key: string;
  /** 结构推导出处(file:line)。 */
  source: string;
  message: string;
}

/** 消息模板单一来源(转换输出成员面)。 */
export function renderFixedDictOutputMemberMessage(
  container: string,
  key: string,
  source: string
): string {
  return l10nText(
    '"{key}" is not a member of the {container} object built by createObjFromDict (structure derived from {source}); this read inside getDictFromObj fails at serialization time — the engine logs a script error and serializes defaults for the whole dict (.get silently returns None instead)',
    { container, key, source }
  );
}

// ── 字面量/链解析基元 ────────────────────────────────────────────────

/** 从 openLine:openCol(须为 `{`)起拼接平衡花括号段(原文行——掩码行会把
 *  字符串内容抹成 `_`,键位读不出来;引号/括号感知;文件末仍未闭合 → null
 *  不猜)。 */
function joinBalancedBraces(
  realLines: readonly string[],
  openLine: number,
  openCol: number
): string | null {
  let text = '';
  let depth = 0;
  let quote: string | null = null;
  for (let line = openLine; line < realLines.length; line += 1) {
    const segment = line === openLine ? realLines[openLine].slice(openCol) : realLines[line] ?? '';
    for (let i = 0; i < segment.length; i += 1) {
      const ch = segment[i];
      text += ch;
      if (quote !== null) {
        if (ch === '\\') {
          i += 1;
          text += segment[i] ?? '';
        } else if (ch === quote) {
          quote = null;
        }
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === '(' || ch === '[' || ch === '{') {
        depth += 1;
      } else if (ch === ')' || ch === ']' || ch === '}') {
        depth -= 1;
        if (depth === 0) {
          return text;
        }
      }
    }
  }
  return null;
}

/** 顶层首个指定字符列(引号/括号感知;无 → -1)。 */
function topLevelIndexOf(text: string, target: string): number {
  let depth = 0;
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
    } else if (ch === '(' || ch === '[' || ch === '{') {
      depth += 1;
    } else if (ch === ')' || ch === ']' || ch === '}') {
      depth -= 1;
    } else if (depth === 0 && ch === target) {
      return i;
    }
  }
  return -1;
}

/** 顶层 ` for ` 词位(引号/括号感知;无 → -1)。 */
function topLevelForIndex(text: string): number {
  let depth = 0;
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
    } else if (ch === '(' || ch === '[' || ch === '{') {
      depth += 1;
    } else if (ch === ')' || ch === ']' || ch === '}') {
      depth -= 1;
    } else if (depth === 0 && /^for(?![\w])/.test(text.slice(i)) && (i === 0 || !/[\w]/.test(text[i - 1]))) {
      return i;
    }
  }
  return -1;
}

/**
 * dict 字面量键集解析(字面量为 joinBalancedBraces 平衡产物):顶层逗号
 * 切分后逐条目——字符串字面量键记名;**展开/dict 推导式/动态键 → 开放;
 * 集合字面量/集合推导式(条目无冒号)→ null 不是 dict。
 */
function dictLiteralKeysOf(literal: string): { keys: string[]; open: boolean } | null {
  const content = literal.slice(1, -1);
  const entries = splitTopLevelParams(content);
  const keys: string[] = [];
  let open = false;
  for (const entryRaw of entries) {
    const entry = entryRaw.trim();
    if (entry === '') {
      continue;
    }
    const colonIdx = topLevelIndexOf(entry, ':');
    const forIdx = topLevelForIndex(entry);
    if (forIdx >= 0 && (colonIdx < 0 || colonIdx > forIdx)) {
      return null; // 集合推导式 `{x for ...}`:不是 dict
    }
    if (forIdx >= 0) {
      open = true; // dict 推导式:键集开放
      continue;
    }
    if (entry.startsWith('**')) {
      open = true; // **展开:键集开放
      continue;
    }
    const quote = entry[0];
    if (quote === '"' || quote === "'") {
      let j = 1;
      let key = '';
      let closed = false;
      while (j < entry.length) {
        const c = entry[j];
        if (c === '\\') {
          key += entry[j + 1] ?? '';
          j += 2;
          continue;
        }
        if (c === quote) {
          closed = true;
          break;
        }
        key += c;
        j += 1;
      }
      if (!closed) {
        return null; // 引号未闭合(平衡产物不该发生):诚实未知
      }
      let k = j + 1;
      while (k < entry.length && /\s/.test(entry[k])) {
        k += 1;
      }
      if (entry[k] !== ':') {
        return null; // 无冒号 → 集合元素,不是 dict
      }
      keys.push(key);
      continue;
    }
    if (colonIdx < 0) {
      return null; // 集合字面量 `{1,2}`:不是 dict
    }
    open = true; // 动态键(数字/标识符/表达式)
  }
  return { keys, open };
}

/** 单引号/双引号纯字符串字面量内容(非字符串形态 → null)。 */
function stringLiteralContent(text: string): string | null {
  const trimmed = text.trim();
  const quote = trimmed[0];
  if (quote !== '"' && quote !== "'") {
    return null;
  }
  if (trimmed.length < 2 || trimmed[trimmed.length - 1] !== quote) {
    return null;
  }
  const inner = trimmed.slice(1, -1);
  if (/["']/.test(inner)) {
    return null; // 混合引号残留:非纯字面量
  }
  return inner;
}

/** pos(`[` 位)起平衡右括号列(引号/括号感知;未闭合 → -1)。 */
function bracketCloseIndex(text: string, pos: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = pos; i < text.length; i += 1) {
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
    } else if (ch === '(' || ch === '[' || ch === '{') {
      depth += 1;
    } else if (ch === ')' || ch === ']' || ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
}

/**
 * 接收者键增面扫描(names 任一名字):下标链写点(`n[...] =`)——全字面量
 * 单段 → extraKeys 记键;非字面量段或嵌套(≥2 段)写 → dynamic(嵌套宇宙
 * 不可追);`.setdefault(`/`.update(` → dynamic。读点/比较不判(读取不证
 * 键存在,不并入键集)。
 */
function scanKeyAdditionSurfaces(
  masked: readonly string[],
  realLines: readonly string[],
  names: readonly string[],
  lineStart: number,
  lineEnd: number
): { extraKeys: Set<string>; dynamic: boolean } {
  const extraKeys = new Set<string>();
  let dynamic = false;
  for (const name of names) {
    const pattern = new RegExp(`(^|[^\\w.])${name}(?![\\w])`, 'g');
    for (let line = Math.max(0, lineStart); line <= Math.min(lineEnd, masked.length - 1); line += 1) {
      const m = masked[line] ?? '';
      const raw = realLines[line] ?? '';
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(m)) !== null) {
        const start = match.index + match[1].length;
        pattern.lastIndex = start + name.length;
        let pos = start + name.length;
        while (pos < m.length && /\s/.test(m[pos])) {
          pos += 1;
        }
        if (m[pos] === '[') {
          const segments: { literal: string | null }[] = [];
          let cursor = pos;
          let chainBroken = false;
          while (cursor < m.length && m[cursor] === '[') {
            const closeIdx = bracketCloseIndex(m, cursor);
            if (closeIdx < 0) {
              chainBroken = true;
              break;
            }
            segments.push({ literal: stringLiteralContent(raw.slice(cursor + 1, closeIdx)) });
            let next = closeIdx + 1;
            while (next < m.length && /\s/.test(m[next])) {
              next += 1;
            }
            cursor = next;
          }
          if (chainBroken) {
            dynamic = true;
            continue;
          }
          // 写点:链后(跳空白)单 `=`(`==`/`!=`/`+=` 等不算)
          if (m[cursor] === '=' && m[cursor + 1] !== '=') {
            if (segments.some(seg => seg.literal === null) || segments.length >= 2) {
              dynamic = true;
            } else if (segments.length === 1) {
              extraKeys.add(segments[0].literal ?? '');
            }
          }
          continue;
        }
        if (/^\.setdefault\s*\(/.test(m.slice(pos)) || /^\.update\s*\(/.test(m.slice(pos))) {
          dynamic = true;
        }
      }
    }
  }
  return { extraKeys, dynamic };
}

// ── 结构推导 ─────────────────────────────────────────────────────────

/** return 语句收集产物(0 基行 + 表达式起始列)。 */
interface ReturnSite {
  line: number;
  exprCol: number;
}

/** 方法体域内 return 语句收集(嵌套 def 域跳过;域诚实同 SER-04 口径)。 */
function collectReturnSites(masked: readonly string[], input: ImplMethodInputBinding): ReturnSite[] {
  const sites: ReturnSite[] = [];
  let line = input.bodyStartLine;
  while (line <= input.bodyEndLine && line < masked.length) {
    const m = masked[line] ?? '';
    if (m.trim().length > 0) {
      if (/^\s*def\s/.test(m)) {
        const nestedIndent = m.length - m.trimStart().length;
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
      const returnMatch = /^\s*return\b/.exec(m);
      if (returnMatch) {
        let col = returnMatch[0].length;
        while (col < m.length && /\s/.test(m[col])) {
          col += 1;
        }
        sites.push({ line, exprCol: col });
      }
    }
    line += 1;
  }
  return sites;
}

/** 别名名集:体域内赋 `{` 字面量的目标名(供键增面扫描;嵌套 def 不剥,
 *  过宽方向保守)。 */
function collectAliasNames(masked: readonly string[], input: ImplMethodInputBinding): string[] {
  const names: string[] = [];
  for (let line = input.bodyStartLine; line <= input.bodyEndLine && line < masked.length; line += 1) {
    const m = masked[line] ?? '';
    const match = /^\s*([A-Za-z_]\w*)\s*=(?!=)\s*\{/.exec(m);
    if (match) {
      names.push(match[1]);
    }
  }
  return names;
}

/** 体域内 return 行前入参重绑(嵌套 def 不剥,过宽方向保守)。 */
function paramReboundBefore(masked: readonly string[], input: ImplMethodInputBinding, beforeLine: number): boolean {
  for (let line = input.bodyStartLine; line < beforeLine && line < masked.length; line += 1) {
    if (isParamReboundAt(masked[line] ?? '', input.paramName)) {
      return true;
    }
  }
  return false;
}

/** 别名最后一次赋值产物(return 行前):字面量段 / 非字面量重绑 / 无。 */
type AliasAssignment =
  | { kind: 'literal'; line: number; literal: string | null }
  | { kind: 'nonliteral' }
  | { kind: 'none' };

function lastAliasAssignment(
  masked: readonly string[],
  realLines: readonly string[],
  input: ImplMethodInputBinding,
  name: string,
  beforeLine: number
): AliasAssignment {
  let result: AliasAssignment = { kind: 'none' };
  let line = input.bodyStartLine;
  while (line < beforeLine && line < masked.length) {
    const m = masked[line] ?? '';
    if (m.trim().length > 0) {
      const literalMatch = new RegExp(`^\\s*${name}\\s*=(?!=)\\s*\\{`).exec(m);
      if (literalMatch) {
        const openCol = m.indexOf('{');
        const literal = joinBalancedBraces(realLines, line, openCol);
        result = { kind: 'literal', line, literal };
        line += 1;
        continue;
      }
      if (new RegExp(`^\\s*${name}\\s*=(?!=)`).test(m) || isParamReboundAt(m, name)) {
        result = { kind: 'nonliteral' };
      }
    }
    line += 1;
  }
  return result;
}

/** return 表达式解析产物。 */
type ReturnResolution =
  | { kind: 'dictLiteral'; keys: string[]; open: boolean; source: string }
  | { kind: 'wire'; container: CustomTypeInfo }
  | { kind: 'unknown' };

/** 单条 return 表达式解析(原文行取表达式/字面量/链键,掩码行只承载
 *  行列定位——掩码等长替换,两侧行列一致;诚实边界见模块头)。 */
function resolveReturnExpr(
  masked: readonly string[],
  realLines: readonly string[],
  site: ReturnSite,
  input: ImplMethodInputBinding,
  customTypes: readonly CustomTypeInfo[],
  fileBase: string
): ReturnResolution {
  const rawText = realLines[site.line] ?? '';
  const trimmed = rawText.slice(site.exprCol).trim();
  if (trimmed === '') {
    return { kind: 'unknown' }; // 裸 return / return None:输出 None,结构未知
  }
  // dict 字面量(直接 return;多行整体拼接)
  if (trimmed[0] === '{') {
    let openCol = site.exprCol;
    while (openCol < rawText.length && /\s/.test(rawText[openCol])) {
      openCol += 1;
    }
    const literal = joinBalancedBraces(realLines, site.line, openCol);
    if (!literal) {
      return { kind: 'unknown' };
    }
    const parsed = dictLiteralKeysOf(literal);
    if (!parsed) {
      return { kind: 'unknown' };
    }
    return {
      kind: 'dictLiteral',
      keys: parsed.keys,
      open: parsed.open,
      source: `${fileBase}:${site.line + 1}`
    };
  }
  // 标识符(+可选纯字符串键下标链)
  const identMatch = /^([A-Za-z_]\w*)/.exec(trimmed);
  if (!identMatch) {
    return { kind: 'unknown' }; // 调用/属性/运算等:不凭函数名推定
  }
  const name = identMatch[1];
  let cursor = identMatch[0].length;
  while (cursor < trimmed.length && /\s/.test(trimmed[cursor])) {
    cursor += 1;
  }
  const chain: string[] = [];
  if (cursor < trimmed.length) {
    if (trimmed[cursor] !== '[') {
      return { kind: 'unknown' }; // 属性/比较/运算尾缀:结构未知
    }
    while (cursor < trimmed.length) {
      const access = keyAccessAt(trimmed, cursor);
      if (!access || access.form !== 'subscript') {
        return { kind: 'unknown' }; // .get/表达式下标:落位不可知
      }
      chain.push(access.key);
      let next = access.end;
      while (next < trimmed.length && /\s/.test(trimmed[next])) {
        next += 1;
      }
      if (next >= trimmed.length) {
        cursor = next;
        break;
      }
      if (trimmed[next] !== '[') {
        return { kind: 'unknown' }; // 链后还有内容(条件表达式等)
      }
      cursor = next;
    }
    if (cursor < trimmed.length) {
      return { kind: 'unknown' };
    }
  }
  if (name === input.paramName) {
    // 入参透传:先查 return 前重绑(重绑后不再是传入的 wire 字典)
    if (paramReboundBefore(masked, input, site.line)) {
      return { kind: 'unknown' };
    }
    if (chain.length === 0) {
      return { kind: 'wire', container: input.container };
    }
    let container: CustomTypeInfo | null = input.container;
    for (const seg of chain) {
      if (!container) {
        return { kind: 'unknown' };
      }
      const resolution = resolveWireDictSubscriptKeyFromContainer(container, [], seg, customTypes);
      if (!resolution?.field) {
        return { kind: 'unknown' }; // 未声明链键:落位不可知
      }
      container = wireFdOfAnnotation(resolution.annotation, customTypes);
      if (!container) {
        return { kind: 'unknown' }; // 非 FD 字段:不是字典
      }
    }
    return { kind: 'wire', container };
  }
  // 别名:return 前最后一次赋值裁定
  const assignment = lastAliasAssignment(masked, realLines, input, name, site.line);
  if (assignment.kind !== 'literal') {
    return { kind: 'unknown' };
  }
  if (!assignment.literal) {
    return { kind: 'unknown' }; // 字面量未闭合
  }
  const parsed = dictLiteralKeysOf(assignment.literal);
  if (!parsed) {
    return { kind: 'unknown' };
  }
  return {
    kind: 'dictLiteral',
    keys: parsed.keys,
    open: parsed.open,
    source: `${fileBase}:${assignment.line + 1}`
  };
}

/**
 * 转换输出结构推导:createObjFromDict 绑定面 → 体内 return 形态裁定。
 * 多 return 全 dict → 键并集(open 取任一);全 wire 同容器 → wire;
 * 混合 wire/dict → dict 并集;任一未知 → unknown(不猜)。
 * 体域键增面(入参/别名的下标写/setdefault/update):字面量键写并入键集,
 * 动态写 → 键集开放(wire 降级 dict-open,缺失不判)。
 */
export function computeConvertedObjStructure(
  text: string,
  input: ImplMethodInputBinding | undefined,
  customTypes: readonly CustomTypeInfo[]
): ConvertedObjStructure {
  if (!input) {
    return { kind: 'unknown' };
  }
  const masked = pythonCodeLines(text);
  const realLines = text.split(/\r?\n/);
  const sites = collectReturnSites(masked, input);
  if (sites.length === 0) {
    return { kind: 'unknown' };
  }
  const fileBase = input.container.pythonFilePath
    ? input.container.pythonFilePath.split(/[\\/]/).pop() ?? 'createObjFromDict'
    : 'createObjFromDict';
  const resolutions = sites.map(site => resolveReturnExpr(masked, realLines, site, input, customTypes, fileBase));
  if (resolutions.some(resolution => resolution.kind === 'unknown')) {
    return { kind: 'unknown' };
  }
  // 体域键增面(入参 + 别名目标)
  const aliasNames = collectAliasNames(masked, input);
  const surfaces = scanKeyAdditionSurfaces(
    masked,
    realLines,
    [input.paramName, ...aliasNames],
    input.bodyStartLine,
    input.bodyEndLine
  );

  const wires = resolutions.filter(r => r.kind === 'wire') as { kind: 'wire'; container: CustomTypeInfo }[];
  if (wires.length === resolutions.length) {
    const first = wires[0].container;
    if (wires.every(wire => wire.container.name === first.name)) {
      if (surfaces.dynamic) {
        // 动态写:wire 键宇宙不再封闭 → 降级 dict-open(缺失不判)
        return {
          kind: 'dict',
          keys: [
            ...first.properties.map(property => property.name),
            ...surfaces.extraKeys
          ],
          open: true,
          source: containerSource(first)
        };
      }
      return { kind: 'wire', container: first, extraKeys: [...surfaces.extraKeys] };
    }
    // 多 wire 不同容器:dict 并集(首段校验,链不追)
    const keys = new Set<string>();
    for (const wire of wires) {
      for (const property of wire.container.properties) {
        keys.add(property.name);
      }
    }
    for (const key of surfaces.extraKeys) {
      keys.add(key);
    }
    return { kind: 'dict', keys: [...keys], open: surfaces.dynamic, source: containerSource(first) };
  }
  // 混合 wire/dictLiteral:dict 并集
  const keys = new Set<string>();
  let open = surfaces.dynamic;
  let source = '';
  for (const resolution of resolutions) {
    if (resolution.kind === 'wire') {
      for (const property of resolution.container.properties) {
        keys.add(property.name);
      }
      if (!source) {
        source = containerSource(resolution.container);
      }
    } else if (resolution.kind === 'dictLiteral') {
      for (const key of resolution.keys) {
        keys.add(key);
      }
      if (resolution.open) {
        open = true;
      }
      if (!source) {
        source = resolution.source;
      }
    }
  }
  for (const key of surfaces.extraKeys) {
    keys.add(key);
  }
  return { kind: 'dict', keys: [...keys], open, source };
}

// ── 校验面 ───────────────────────────────────────────────────────────

/** 单行 obj 入参成员读取扫描(原文行取键,掩码行核验代码位);结构裁定
 *  见模块头。 */
function objMemberReadsOnLine(
  rawLine: string,
  maskedLine: string,
  line: number,
  input: ImplMethodInputBinding,
  structure: ConvertedObjStructure,
  keys: ReadonlySet<string>,
  openUniverse: boolean,
  customTypes: readonly CustomTypeInfo[]
): ConvertedObjMemberFinding[] {
  const findings: ConvertedObjMemberFinding[] = [];
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
    // 赋值目标键(末段后跟 `=` 且非 ==/>=):写入面不判;`+=`/`==`/`!=`
    // 等比较与增强形式照判——运行时同样先读取该键
    if (/^\s*=(?![=>])/.test(rawLine.slice(pos))) {
      continue;
    }
    if (structure.kind === 'dict') {
      // dict 形态:只判首段(嵌套字面量形状属 getDictFromObjReturnCheck 车道);
      // 结构本身开放(展开/推导式/动态键/动态写)→ 缺失不判
      const access = accesses[0];
      if (!openUniverse && !structure.open && !keys.has(access.key)) {
        findings.push({
          line,
          character: access.keyCharacter,
          length: Math.max(1, access.key.length),
          container: input.container.name,
          key: access.key,
          source: structure.source,
          message: renderFixedDictOutputMemberMessage(input.container.name, access.key, structure.source)
        });
      }
      continue;
    }
    if (structure.kind !== 'wire') {
      continue; // unknown 不进本函数(调用面已筛):类型收窄
    }
    // wire 形态:全链走容器(首段对键宇宙——声明集+体字面量键写点)
    let container: CustomTypeInfo | null = structure.container;
    let first = true;
    for (const access of accesses) {
      if (!container) {
        break; // 前段字段非 FD(标量/数组/不可解析):嵌套键不猜容器
      }
      if (first) {
        first = false;
        if (!openUniverse && !keys.has(access.key)) {
          const source = containerSource(container);
          findings.push({
            line,
            character: access.keyCharacter,
            length: Math.max(1, access.key.length),
            container: container.name,
            key: access.key,
            source,
            message: renderFixedDictOutputMemberMessage(container.name, access.key, source)
          });
          break;
        }
        const resolution = resolveWireDictSubscriptKeyFromContainer(container, [], access.key, customTypes);
        container = resolution?.field ? wireFdOfAnnotation(resolution.annotation, customTypes) : null;
        continue;
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
          message: renderFixedDictOutputMemberMessage(container.name, access.key, source)
        });
        break;
      }
      container = wireFdOfAnnotation(resolution.annotation, customTypes);
    }
  }
  return findings;
}

/**
 * 转换输出成员校验:同容器 getDictFromObj 体内 obj 入参的字符串键读取对
 * 推导键集校验。文档级开放宇宙门(obj 接收者的动态键写/键增调用 → 全文档
 * 缺失不判;字面量键写点并入键集);体域诚实边界(重绑/嵌套 def/掩码/
 * 写目标)与 SER-04 同口径。
 */
export function computeConvertedObjMemberFindings(
  text: string,
  createInputs: readonly ImplMethodInputBinding[],
  getInputs: readonly ImplMethodInputBinding[],
  customTypes: readonly CustomTypeInfo[]
): ConvertedObjMemberFinding[] {
  const findings: ConvertedObjMemberFinding[] = [];

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
      continue; // 无同容器 createObjFromDict 绑定:结构不可推导
    }
    const structure = computeConvertedObjStructure(text, createInput, customTypes);
    if (structure.kind === 'unknown') {
      continue; // 自定义转换不凭函数名推定结构
    }
    // 文档级开放宇宙门 + 字面量键写点(obj 接收者,全文保守口径)
    const surfaces = scanKeyAdditionSurfaces(masked, realLines, [getInput.paramName], 0, masked.length - 1);
    if (surfaces.dynamic) {
      continue;
    }
    const keys = new Set<string>();
    if (structure.kind === 'wire') {
      for (const property of structure.container.properties) {
        keys.add(property.name);
      }
      for (const key of structure.extraKeys) {
        keys.add(key);
      }
    } else {
      for (const key of structure.keys) {
        keys.add(key);
      }
    }
    for (const key of surfaces.extraKeys) {
      keys.add(key);
    }
    let alive = true;
    let line = getInput.bodyStartLine;
    while (line <= getInput.bodyEndLine && line < masked.length) {
      const m = masked[line] ?? '';
      const raw = realLines[line] ?? '';
      if (m.trim().length > 0) {
        const indent = m.length - m.trimStart().length;
        if (/^\s*def\s/.test(m)) {
          // 嵌套 def 块:内层代码不判(域诚实),整块跳过
          const nestedIndent = indent;
          line += 1;
          while (line <= getInput.bodyEndLine && line < masked.length) {
            const inner = masked[line] ?? '';
            if (inner.trim().length > 0 && (inner.length - inner.trimStart().length) <= nestedIndent) {
              break;
            }
            line += 1;
          }
          continue;
        }
        if (alive && isParamReboundAt(m, getInput.paramName)) {
          alive = false;
          line += 1;
          continue;
        }
      }
      if (alive) {
        findings.push(...objMemberReadsOnLine(
          raw, m, line, getInput, structure, keys, surfaces.dynamic, customTypes
        ));
      }
      line += 1;
    }
  }
  return findings;
}

/** finding → 诊断项(纯数据;extension 侧转 vscode.Diagnostic,同族同形状)。 */
export function convertedObjMemberFindingToItem(
  finding: ConvertedObjMemberFinding
): FixedDictConstructDiagnosticItem {
  return {
    range: {
      start: { line: finding.line, character: finding.character },
      end: { line: finding.line, character: finding.character + finding.length }
    },
    message: finding.message,
    severity: 'Warning',
    source: 'kbengine',
    code: FIXED_DICT_OUTPUT_MEMBER_SCHEMA_DIAGNOSTIC_CODE
  };
}
