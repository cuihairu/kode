/**
 * KSEM-STRUCT-04:FIXED_DICT 构造点诊断(缺键/多键/字段值结构错配)。
 *
 * 引擎真源(fixeddict.h:pyscript::Map,STRUCT-01/02 盘点锚定):FD 是封闭
 * 字典——字段集在 types.xml <Properties> 声明序封闭,脚本侧以 dict 字面量
 * 构造后赋给 FD 型目标。确定结构消费点 = 赋值目标可解析为 FD 容器:
 * - `self.<属性> = {…}`(def 属性 <Type> 是 FD 别名);
 * - `self.<属性>["<键>"]… = {…}`(链解析落 FD 字段,复用 STRUCT-02 的
 *   resolveFixedDictSubscriptKey 单一解析链)。
 *
 * 纯逻辑层,不 import vscode。判定(保守面,误报=0 优先):
 * - 只收整行 `self.<属性>[键…] = {` 形态;裸名目标/链式 RHS/增强赋值/
 *   `==`/调用目标一律不接管——普通 dict 不套封闭约束(验收原句);
 * - RHS 字面量跨行花括号配对(有界窗口,引号/行注释感知;三引号态跨行
 *   连续);未闭 → 整点不猜;
 * - 键全字面量且无 `** 展开`/动态键 → 缺键可判(声明集 − 字面量键);
 *   有展开或动态键(f 字串/变量/bytes 键)→ 键宇宙开放,缺键不报,多键
 *   照报(展开带不回一个字面量多键);
 * - 字段值结构面复用 CELL-08 同一引擎标量真源(cellDataScalarFamilyLabel
 *   /judgeCellDataValueStructure):仅内置标量字段按字面量值类裁定,范围面
 *   留给 KSEM-STRUCT-05 不在此重复;非标量字段(FD/ARRAY/PYTHON 族/自定义
 *   别名)不裁定;值非整段字面量(名字/调用/残缺)→ unknown 不猜;
 * - 嵌套字面量内的深层字段(值本身又是 dict)本批不下钻——顶层键集与
 *   顶层标量值面先落,深层面属后续批(诚实边界,见纪实 §5)。
 */

import { l10nText } from '../nlsRuntime';
import type { CustomTypeInfo } from '../definitionWorkspace';
import { FIXED_DICT_TYPE_NAME } from './kbengineMetadata';
import { resolveAnnotationTypeWithReason } from '../pythonTypeStubs';
import {
  classifyCellDataWriteValue,
  cellDataScalarFamilyLabel,
  judgeCellDataValueStructure,
  type CellDataValueLiteral
} from './cellDataWriteCheck';
import {
  resolveFixedDictSubscriptKey,
  type FixedDictChainSegment
} from './fixedDictSubscript';
import { findLineCommentIndex } from './globalDataIndexCore';

export const FIXED_DICT_CONSTRUCT_DIAGNOSTIC_CODE = 'kbengine.fixedDictConstruct';
export const FIXED_DICT_CONSTRUCT_DIAGNOSTICS_ENABLED_DEFAULT = true;

/** 跨行字面量的花括号配对窗口上限(行);未闭即整点不猜。 */
const FIXED_DICT_CONSTRUCT_MAX_SPAN_LINES = 100;

/** 一处构造点错配。 */
export interface FixedDictConstructFinding {
  line: number;
  /** 0 基字符列。 */
  character: number;
  length: number;
  /** 错配面:missing=缺声明字段;extra=字面量键不在声明集;type=字段值结构错配。 */
  kind: 'missing' | 'extra' | 'type';
  /** FD 容器类型名(POSITION 等)。 */
  container: string;
  /** missing:缺的字段名(声明序逗号串);extra/type:涉事键。 */
  key: string;
  /** type 面:期望引擎标量文案。 */
  expected: string;
  /** type 面:实际值类文案。 */
  actual: string;
  /** 声明来源段(`types.xml:12`;解析不出只给容器名)。 */
  source: string;
  /** 目标表达式(`self.pos` / `self.info["pos"]`)。 */
  target: string;
  message: string;
}

/** 诊断项(纯数据;extension 侧转 vscode.Diagnostic,测试免 vscode 依赖)。 */
export interface FixedDictConstructDiagnosticItem {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  message: string;
  severity: 'Warning';
  source: 'kbengine';
  code: string;
}

/** def 属性 → def <Type> 文本(与 STRUCT-02/03 接收者定型 locator 同契约)。 */
export type FixedDictConstructResolve = (propertyName: string) => Promise<string | null>;

/** 消息模板单一来源(缺键面)。 */
export function renderFixedDictConstructMissingMessage(
  target: string,
  container: string,
  fields: string,
  source: string
): string {
  return l10nText(
    '{target} constructs {container} but is missing field(s) {fields} declared in {source}',
    { target, container, fields, source }
  );
}

/** 消息模板单一来源(多键面)。 */
export function renderFixedDictConstructExtraMessage(
  key: string,
  container: string,
  source: string
): string {
  return l10nText(
    '"{key}" is not a field of {container} (declared in {source}); a FIXED_DICT construction accepts only declared fields',
    { key, container, source }
  );
}

/** 消息模板单一来源(字段值结构面)。 */
export function renderFixedDictConstructTypeMessage(
  target: string,
  key: string,
  expected: string,
  source: string,
  actual: string
): string {
  return l10nText(
    '{target} field "{key}" expects {expected} as declared in {source}; got {actual}',
    { target, key, expected, source, actual }
  );
}

/** 声明来源段(types.xml 基名:行)。 */
function containerSource(container: CustomTypeInfo): string {
  const base = container.filePath.split(/[\\/]/).pop() ?? container.name;
  return container.line > 0 ? `${base}:${container.line}` : base;
}

/** 注解/类型名 → FD 容器(名字直配 aliasType;别名链由上游解析链消化)。 */
function fdContainerOfAnnotation(
  annotation: string | null | undefined,
  customTypes: readonly CustomTypeInfo[]
): CustomTypeInfo | null {
  const trimmed = annotation?.trim();
  if (!trimmed) {
    return null;
  }
  return customTypes.find(
    info => info.name === trimmed && info.aliasType === FIXED_DICT_TYPE_NAME
  ) ?? null;
}

/** 跨行花括号配对结果:内容串 + 每行在内容串中的起始下标(偏移映射用)。 */
interface MatchedBraces {
  joined: string;
  /** 配对窗内第 i 行(绝对行号 startLine+i)在 joined 的起始下标。 */
  lineStarts: number[];
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

/** 三引号态:判定 pos 处是否 3 连同字符引号。 */
function isTripleQuote(text: string, pos: number, quote: string): boolean {
  return text.slice(pos, pos + 3) === quote.repeat(3);
}

/**
 * 自 (startLine, startColumn) 的 `{` 起做跨行花括号配对(引号/转义/行注释
 * 感知;注释以空格原位抹除保偏移映射对齐;三引号态跨行连续)。窗口超界或
 * 未闭合 → null(整点不猜)。
 */
function matchDictBraces(
  lines: readonly string[],
  startLine: number,
  startColumn: number
): MatchedBraces | null {
  const collected: string[] = [];
  const lineStarts: number[] = [];
  let depth = 0;
  let stringQuote: string | null = null;
  let stringTriple = false;
  for (let line = startLine; line < Math.min(lines.length, startLine + FIXED_DICT_CONSTRUCT_MAX_SPAN_LINES); line += 1) {
    lineStarts.push(collected.length);
    const text = lines[line];
    let column = line === startLine ? startColumn : 0;
    while (column < text.length) {
      const ch = text[column];
      if (stringQuote !== null) {
        if (ch === '\\') {
          collected.push(ch);
          if (column + 1 < text.length) {
            collected.push(text[column + 1]);
          }
          column += 2;
          continue;
        }
        collected.push(ch);
        if (stringTriple) {
          if (isTripleQuote(text, column, stringQuote)) {
            collected.push(text[column + 1]);
            collected.push(text[column + 2]);
            column += 3;
            stringQuote = null;
            stringTriple = false;
          } else {
            column += 1;
          }
          continue;
        }
        if (ch === stringQuote) {
          stringQuote = null; // 只有闭引号字符才退出串态(早退会把闭引号误当新串起点)
        }
        column += 1;
        continue;
      }
      if (ch === '#' ) {
        // 行注释:原位抹成空格(偏移映射保持对齐),本行到此为止
        while (column < text.length) {
          collected.push(' ');
          column += 1;
        }
        break;
      }
      if (ch === '\'' || ch === '"') {
        if (isTripleQuote(text, column, ch)) {
          stringQuote = ch;
          stringTriple = true;
          collected.push(text.slice(column, column + 3));
          column += 3;
          continue;
        }
        stringQuote = ch;
        collected.push(ch);
        column += 1;
        continue;
      }
      if (ch === '{') {
        depth += 1;
        collected.push(ch);
        column += 1;
        continue;
      }
      if (ch === '}') {
        depth -= 1;
        collected.push(ch);
        column += 1;
        if (depth === 0) {
          return {
            joined: collected.join(''),
            lineStarts,
            startLine,
            startColumn,
            endLine: line,
            endColumn: column
          };
        }
        continue;
      }
      collected.push(ch);
      column += 1;
    }
  }
  return null; // 窗口内未闭合
}

/** joined 下标 → (行, 列)。matched 首行内容从 `{` 起步,列要加开括号绝对列;
 * 后续行从列 0 起,原样。 */
function indexToPos(matched: MatchedBraces, index: number): { line: number; character: number } {
  let row = 0;
  for (let i = 1; i < matched.lineStarts.length; i += 1) {
    if (matched.lineStarts[i] <= index) {
      row = i;
    } else {
      break;
    }
  }
  const column = index - matched.lineStarts[row];
  return {
    line: matched.startLine + row,
    character: row === 0 ? matched.startColumn + column : column
  };
}

/** 键值对(偏移均已转绝对行列)。 */
interface DictPair {
  /** 键字面量名;动态键(f 字串/变量/bytes/残缺)→ null(宇宙开放)。 */
  key: string | null;
  keyStart: { line: number; character: number };
  keyLength: number;
  /** `** 展开` 标记(宇宙开放)。 */
  spread: boolean;
  valueStart: { line: number; character: number };
  valueText: string;
}

/**
 * 顶层逗号切分对(引号/深度感知;键值以首个顶层冒号分界)。值内嵌套
 * `{…}`/`[…]` 抬深度不误切;lambda 顶层冒号会误分——值分类落 unknown,
 * 诚实退化,不误报。无冒号的裸段(`**展开`/残缺)置 openUniverse——键
 * 宇宙开放,缺键不可判。
 */
function parseDictPairs(matched: MatchedBraces): { pairs: DictPair[]; openUniverse: boolean } {
  const body = matched.joined;
  const openBrace = body.indexOf('{');
  const closeBrace = body.lastIndexOf('}');
  const inner = body.slice(openBrace + 1, closeBrace);
  const innerBase = openBrace + 1;
  const pairs: DictPair[] = [];
  let openUniverse = false;

  // 顶层逗号切分(返回原 inner 下标)
  const commas: number[] = [];
  let depth = 0;
  let quote: string | null = null;
  let triple = false;
  let i = 0;
  while (i < inner.length) {
    const ch = inner[i];
    if (quote !== null) {
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (triple) {
        if (isTripleQuote(inner, i, quote)) {
          i += 3;
          quote = null;
          triple = false;
        } else {
          i += 1;
        }
        continue;
      }
      if (ch === quote) {
        quote = null; // 只有闭引号字符才退出串态
      }
      i += 1;
      continue;
    }
    if (ch === '\'' || ch === '"') {
      if (isTripleQuote(inner, i, ch)) {
        quote = ch;
        triple = true;
        i += 3;
        continue;
      }
      quote = ch;
      i += 1;
      continue;
    }
    if (ch === '[' || ch === '(' || ch === '{') {
      depth += 1;
    } else if (ch === ']' || ch === ')' || ch === '}') {
      depth -= 1;
    } else if (ch === ',' && depth === 0) {
      commas.push(i);
    }
    i += 1;
  }

  const segments: Array<{ start: number; end: number }> = [];
  let segStart = 0;
  for (const at of commas) {
    segments.push({ start: segStart, end: at });
    segStart = at + 1;
  }
  segments.push({ start: segStart, end: inner.length });

  for (const segment of segments) {
    const raw = inner.slice(segment.start, segment.end);
    if (!raw.trim()) {
      continue; // 尾逗号空段
    }
    // 首个顶层冒号(引号/深度感知)
    let colonAt = -1;
    depth = 0;
    quote = null;
    triple = false;
    i = 0;
    while (i < raw.length) {
      const ch = raw[i];
      if (quote !== null) {
        if (ch === '\\') {
          i += 2;
          continue;
        }
        if (triple) {
          if (isTripleQuote(raw, i, quote)) {
            i += 3;
            quote = null;
            triple = false;
          } else {
            i += 1;
          }
          continue;
        }
        if (ch === quote) {
          quote = null; // 只有闭引号字符才退出串态
        }
        i += 1;
        continue;
      }
      if (ch === '\'' || ch === '"') {
        if (isTripleQuote(raw, i, ch)) {
          quote = ch;
          triple = true;
          i += 3;
          continue;
        }
        quote = ch;
        i += 1;
        continue;
      }
      if (ch === '[' || ch === '(' || ch === '{') {
        depth += 1;
      } else if (ch === ']' || ch === ')' || ch === '}') {
        depth -= 1;
      } else if (ch === ':' && depth === 0) {
        colonAt = i;
        break;
      }
      i += 1;
    }
    if (colonAt < 0) {
      // 无键值形态:`**x` 裸展开(或残缺段)——键宇宙开放
      openUniverse = true;
      continue;
    }

    const keyPart = raw.slice(0, colonAt);
    const valuePart = raw.slice(colonAt + 1);
    const keyTrim = keyPart.trim();
    const valueTrim = valuePart.trim();

    // 绝对位置:keyPart/valuePart 在 inner 的绝对下标 → joined 下标(0 基差
    // innerBase);indexOf(keyTrim) 已含键前空白,valueLead 同理各自只算一次
    const keyAbs = indexToPos(matched, innerBase + segment.start + keyPart.indexOf(keyTrim));
    const valueLead = valuePart.length - valuePart.trimStart().length;
    const valueAbs = indexToPos(matched, innerBase + segment.start + colonAt + 1 + valueLead);

    const spread = /^\*\*/.test(keyTrim);
    let key: string | null = null;
    if (!spread) {
      const literal = /^([rRuUbBfF]{0,2})(['"])([\s\S]*)\2$/.exec(keyTrim);
      if (literal) {
        const [, prefix, _quoteCh, content] = literal;
        // 引号闭于段尾(上方正则保证);转义/bytes/f 字串键不作字面量键
        if (!/f/i.test(prefix) && !/b/i.test(prefix) && !content.includes('\\')) {
          key = content;
        }
      }
    }
    pairs.push({
      key,
      keyStart: { line: keyAbs.line, character: keyAbs.character },
      keyLength: keyTrim.length,
      spread,
      valueStart: valueAbs,
      valueText: valueTrim
    });
  }
  return { pairs, openUniverse };
}

/** 行剥注释。 */
function stripLineComment(lineText: string): string {
  const at = findLineCommentIndex(lineText);
  return at === -1 ? lineText : lineText.slice(0, at);
}

/** LHS 目标:`self.<属性>` + 全字符串字面量键括号列。 */
interface ConstructTarget {
  prop: string;
  /** 方括号键(按出现序;全字面量才成立)。 */
  keys: string[];
  /** RHS `{` 的(行, 列)。 */
  braceLine: number;
  braceColumn: number;
}

const TARGET_LHS = /^(\s*)self\.([A-Za-z_]\w*)([^=]*?)\s*=(?!=)(.*)$/;

/** 行扫描目标形态;非 `self.<属性>[键…] = {`(裸名/增强赋值/调用/非字面量键)→ null。 */
function matchConstructTarget(
  lineText: string,
  line: number
): ConstructTarget | null {
  const match = TARGET_LHS.exec(lineText);
  if (!match) {
    return null;
  }
  // 中段必须全为 `["<名>"]` 形括号(零个=根形态);整数/切片/表达式下标
  // 或点链 → 不接管
  const keys: string[] = [];
  let tail = match[3];
  while (tail.length > 0) {
    const bracket = /^\s*\[\s*(?:'([A-Za-z_]\w*)'|"([A-Za-z_]\w*)")\s*\]/.exec(tail);
    if (!bracket) {
      return null;
    }
    keys.push(bracket[1] ?? bracket[2]);
    tail = tail.slice(bracket[0].length);
  }
  const braceOffset = firstBraceOffset(match[4]);
  if (braceOffset < 0) {
    return null;
  }
  // 中段 [^=] 不含 '=',故 prop 之后的第一个 '=' 就是赋值号(列算术不经
  // match[3]——惰性组会把 '=' 前的尾随空白漏出组外)
  const eqAt = lineText.indexOf('=', match[1].length + 'self.'.length + match[2].length);
  if (eqAt < 0) {
    return null;
  }
  return {
    prop: match[2],
    keys,
    braceLine: line,
    braceColumn: eqAt + 1 + braceOffset
  };
}

/** RHS 首个非空白字符为 `{` 时返回其偏移;否则 -1。 */
function firstBraceOffset(rhs: string): number {
  let index = 0;
  while (index < rhs.length && /\s/.test(rhs[index])) {
    index += 1;
  }
  return rhs[index] === '{' ? index : -1;
}

/**
 * 构造点扫描(纯函数)。resolveSelfPropertyType 给 def 属性 <Type> 文本
 * (locator 同契约);customTypes 为 types.xml 注册表快照。目标落不到 FD
 * 容器/键链解不开/字面量残缺 → 空集(普通 dict 不套封闭约束)。
 */
export async function analyzeFixedDictConstructWrites(
  text: string,
  resolveSelfPropertyType: FixedDictConstructResolve,
  customTypes: readonly CustomTypeInfo[]
): Promise<FixedDictConstructFinding[]> {
  const lines = text.split(/\r?\n/);
  const findings: FixedDictConstructFinding[] = [];
  const resolveCache = new Map<string, string | null>();
  let line = 0;
  while (line < lines.length) {
    const stripped = stripLineComment(lines[line]);
    const target = matchConstructTarget(stripped, line);
    if (!target) {
      line += 1;
      continue;
    }
    const matched = matchDictBraces(lines, target.braceLine, target.braceColumn);
    if (!matched) {
      // 未闭合:跳过本行继续扫(后续行可能是别的独立语句)
      line += 1;
      continue;
    }
    line = matched.endLine + 1; // 字面量行整体消费

    // 目标容器解析
    let typeName = resolveCache.get(target.prop) ?? null;
    if (!resolveCache.has(target.prop)) {
      typeName = await resolveSelfPropertyType(target.prop);
      resolveCache.set(target.prop, typeName);
    }
    if (!typeName) {
      continue; // def 属性不可解析:目标不定型,不接管
    }
    let container: CustomTypeInfo | null = null;
    if (target.keys.length === 0) {
      const resolved = resolveAnnotationTypeWithReason(typeName, customTypes);
      container = fdContainerOfAnnotation(resolved.annotation, customTypes) ??
        fdContainerOfAnnotation(typeName, customTypes);
    } else {
      // 前段键走 STRUCT-02 单一解析链,末键落字段 → 字段注解的 FD 容器
      const prefix: FixedDictChainSegment[] = target.keys.slice(0, -1).map(key => ({
        kind: 'key',
        key,
        keyStart: 0,
        keyEnd: 0,
        form: 'subscript' as const
      }));
      const resolution = resolveFixedDictSubscriptKey(typeName, prefix, target.keys[target.keys.length - 1], customTypes);
      if (resolution?.annotation) {
        container = fdContainerOfAnnotation(resolution.annotation, customTypes);
      }
    }
    if (!container) {
      continue; // 标量/数组/PYTHON 族目标:构造面不接管
    }

    const { pairs, openUniverse } = parseDictPairs(matched);
    const literalKeys = new Map<string, DictPair>();
    let universeOpen = openUniverse;
    for (const pair of pairs) {
      if (pair.spread || pair.key === null) {
        universeOpen = true;
        continue;
      }
      literalKeys.set(pair.key, pair);
    }

    const source = containerSource(container);
    const targetLabel = target.keys.length === 0
      ? `self.${target.prop}`
      : `self.${target.prop}${target.keys.map(key => `["${key}"]`).join('')}`;

    // 缺键:键宇宙封闭才可判(声明集 − 字面量键)
    if (!universeOpen) {
      const missing = container.properties.filter(property => !literalKeys.has(property.name));
      if (missing.length > 0) {
        const fields = missing.map(property => property.name).join(', ');
        findings.push({
          line: matched.startLine,
          character: matched.startColumn,
          length: 1,
          kind: 'missing',
          container: container.name,
          key: fields,
          expected: '',
          actual: '',
          source,
          target: targetLabel,
          message: renderFixedDictConstructMissingMessage(targetLabel, container.name, fields, source)
        });
      }
    }

    for (const [key, pair] of literalKeys) {
      const field = container.properties.find(property => property.name === key);
      if (!field) {
        // 多键:宇宙开放也照报(展开带不回一个字面量多键)
        findings.push({
          line: pair.keyStart.line,
          character: pair.keyStart.character,
          length: pair.keyLength,
          kind: 'extra',
          container: container.name,
          key,
          expected: '',
          actual: '',
          source,
          target: targetLabel,
          message: renderFixedDictConstructExtraMessage(key, container.name, source)
        });
        continue;
      }
      // 字段值结构面:内置标量按字面量裁定;其余类型/非字面量值不猜
      const familyLabel = field.typeName ? cellDataScalarFamilyLabel(field.typeName) : null;
      if (!familyLabel) {
        continue;
      }
      const literal: CellDataValueLiteral = classifyCellDataWriteValue(pair.valueText);
      const verdict = judgeCellDataValueStructure(literal, field.typeName ?? '');
      if (verdict && !verdict.ok) {
        findings.push({
          line: pair.valueStart.line,
          character: pair.valueStart.character,
          length: Math.max(1, pair.valueText.length),
          kind: 'type',
          container: container.name,
          key,
          expected: familyLabel,
          actual: verdict.actual,
          source,
          target: targetLabel,
          message: renderFixedDictConstructTypeMessage(
            targetLabel, key, familyLabel, source, verdict.actual
          )
        });
      }
    }
  }
  return findings;
}

/** finding → 诊断项(纯数据;extension 侧转 vscode.Diagnostic)。 */
export function fixedDictConstructFindingToItem(
  finding: FixedDictConstructFinding
): FixedDictConstructDiagnosticItem {
  return {
    range: {
      start: { line: finding.line, character: finding.character },
      end: { line: finding.line, character: finding.character + finding.length }
    },
    message: finding.message,
    severity: 'Warning',
    source: 'kbengine',
    code: FIXED_DICT_CONSTRUCT_DIAGNOSTIC_CODE
  };
}
