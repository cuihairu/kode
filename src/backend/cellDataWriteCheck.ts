/**
 * KSEM-CELL-08: write-type validation diagnostics for known cellData fields.
 * Data source = the CELL-04 key universe (fetchCellDataKeys: kind/typeLabel/
 * sourceFile/sourceLine); write sites / aliases / constant keys reuse
 * CELL-06/07 (scanCellDataKeyOperations + cellDataAliasState /
 * resolveCellDataConstantKey). Engine facts (the datatypes.cpp
 * `DataTypes::initialize` registry, same source as kbengineMetadata): integer
 * scalar bit width and sign fix the range; FLOAT/DOUBLE numeric;
 * STRING/UNICODE string; BLOB byte stream; VECTOR2/3/4 fixed-length numeric
 * vector; PYTHON and PY_DICT/PY_TUPLE/PY_LIST/ENTITYCALL take the Python
 * object surface and are not checked; ARRAY/FIXED_DICT/types.xml custom alias
 * structures are unknown -> not checked (honest boundary).
 *
 * Pure logic layer, does not import vscode. Judgement (conservative surface,
 * false positive = 0 first):
 * - only `write` is checked (index `= ` direct assignment; augmented
 *   assignment / `.get` count as reads and do not participate);
 * - the receiver must be valid: a direct write to self.cellData, or the most
 *   recent assignment of a CELL-07 alias is still `= self.cellData` (after a
 *   rebinding, the write targets a different dict, so no check); alias escape
 *   does not affect the write type (escaping only lowers read-site
 *   existence, the dict shape stays the same);
 * - the key is in the universe and has a typeLabel; unknown key / no type /
 *   type not in the scalar table -> no check (unknown keys belong to
 *   CELL-09/10);
 * - the RHS must be a **whole single-line literal** (trailing content /
 *   broken multi-line / name / call -> no guessing);
 * - structure surface: string -> numeric/vector, None/dict/set ->
 *   numeric/string/byte stream/vector, list -> numeric/string scalar,
 *   bytes -> string/numeric = mismatch; bool is an int subclass, not
 *   reported; float literal -> integer scalar is reported (does not match
 *   the declared structure);
 * - range surface: an integer literal outside the engine scalar range
 *   (negative into unsigned / out of bounds) is reported;
 * - VECTOR2/3/4: the arity of a sequence literal is countable from syntax --
 *   an arity mismatch is reported; when the arity matches, all-numeric
 *   literal elements are not reported, other literals (string/None/dict) are
 *   reported, and elements containing an unknown expression are not guessed.
 */

import { l10nText } from '../nlsRuntime';
import {
  cellDataAliasNames,
  cellDataAliasState,
  scanCellDataKeyOperations,
  type CellDataKeyOperation
} from './cellDataReadType';
import type { CellDataKeyEntry, CellDataRelatedLocation } from './cellDataCompletion';
import { findLineCommentIndex } from './globalDataIndexCore';
// 引擎标量族真源(2026-11-14 SER-10 抽出 src/backend/scalarFamilies.ts 供
// 序列化 schema 车道共表零 vscode 依赖;CELL-08 行为零变化)
import { SCALAR_FAMILIES, type ScalarFamily } from './scalarFamilies';

export const CELL_DATA_WRITE_TYPE_DIAGNOSTIC_CODE = 'kbengine.cellDataWriteType';
export const CELL_DATA_WRITE_DIAGNOSTICS_ENABLED_DEFAULT = true;

/** 消息模板单一来源(结构面)。 */
export function renderCellDataWriteStructureMessage(
  key: string,
  expected: string,
  source: string,
  actual: string
): string {
  return l10nText(
    'cellData["{key}"] expects {expected} as declared in {source}; got {actual}',
    { key, expected, source, actual }
  );
}

/** 消息模板单一来源(范围面)。 */
export function renderCellDataWriteRangeMessage(
  key: string,
  value: string,
  expected: string,
  source: string
): string {
  return l10nText(
    'cellData["{key}"] value {value} is out of range for {expected} as declared in {source}',
    { key, value, expected, source }
  );
}

/** 一处已知字段写入型错配。 */
export interface CellDataWriteFinding {
  line: number;
  /** RHS 字面量起点(0 基字符列)。 */
  character: number;
  length: number;
  key: string;
  typeLabel: string;
  /** 实际值类(str/int/None/…)。 */
  actual: string;
  /** 错配面:structure=结构不符;range=整数值越引擎标量范围。 */
  reason: 'structure' | 'range';
  /** 键声明文件名(`{from}.def` / 内建证据路径;KSEM-CELL-14 关联跳转用)。 */
  declaredFile: string | null;
  /** 键声明行(Rust sourceLine,1 基人读行号;内建/缺 → null)。 */
  declaredLine: number | null;
  message: string;
}

/** 诊断项(纯数据;extension 侧转 vscode.Diagnostic,测试免 vscode 依赖)。
 * related=声明锚点(KSEM-CELL-14 关联跳转;装配面经 resolveCellDataDeclAnchor
 * 解析后传入)。 */
export interface CellDataWriteDiagnosticItem {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  message: string;
  severity: 'Warning';
  source: 'kbengine';
  code: string;
  related?: CellDataRelatedLocation;
}

/** 字面量值类(RHS 整段恰为一个字面量时才有类;否则 unknown 不猜)。 */
type ValueLiteral =
  | { class: 'none' }
  | { class: 'bool' }
  | { class: 'int'; value: bigint }
  | { class: 'float' }
  | { class: 'str' }
  | { class: 'bytes' }
  | { class: 'sequence'; sequenceClass: 'list' | 'tuple'; arity: number; elements: ValueLiteral[] | null }
  | { class: 'dict' }
  | { class: 'set' }
  | { class: 'unknown' };

const DEC_INT = /^[-+]?\d[\d_]*$/;
const RADIX_INT = /^[-+]?(?:0[xX][0-9a-fA-F_]+|0[oO][0-7_]+|0[bB][01_]+)$/;
const FLOAT_LITERAL =
  /^[-+]?(?:\d[\d_]*\.(?:\d[\d_]*)?(?:[eE][-+]?\d+)?|\.\d[\d_]*(?:[eE][-+]?\d+)?|\d[\d_]*[eE][-+]?\d+)$/;

/** Classify the whole RHS literal (a class is given only when the whole segment is exactly one literal; broken/trailing expression -> unknown). */
export function classifyCellDataWriteValue(text: string): ValueLiteral {
  const s = text.trim();
  if (!s) {
    return { class: 'unknown' };
  }
  if (s === 'None') {
    return { class: 'none' };
  }
  if (s === 'True' || s === 'False') {
    return { class: 'bool' };
  }
  if (DEC_INT.test(s) || RADIX_INT.test(s)) {
    // Parse exactly via BigInt (decimal/0x/0o/0b are isomorphic; 64-bit boundaries do not fall into double rounding)
    return { class: 'int', value: BigInt(s.replace(/_/g, '')) };
  }
  if (FLOAT_LITERAL.test(s)) {
    return { class: 'float' };
  }
  const stringLiteral = /^([rRuUbBfF]{0,2})(['"])/.exec(s);
  if (stringLiteral) {
    // No guessing on trailing content (concatenation/attribute access): the string must end right after the closing quote
    const quote = stringLiteral[2];
    const body = s.slice(stringLiteral[0].length);
    const close = scanQuotedEnd(body, quote);
    if (close === null || body.slice(close).trim() !== '') {
      return { class: 'unknown' };
    }
    return /[bB]/.test(stringLiteral[1]) ? { class: 'bytes' } : { class: 'str' };
  }
  if (s[0] === '[' || s[0] === '(') {
    const sequenceClass = s[0] === '[' ? 'list' : 'tuple';
    const inner = scanBracketBody(s);
    if (inner === null) {
      return { class: 'unknown' }; // multi-line/unclosed: class is decidable but arity is not countable, no guessing
    }
    const rawElements = splitTopLevelCommas(inner);
    const isTupleSingleton = sequenceClass === 'tuple' && rawElements.length === 1 && !inner.includes(',');
    if (isTupleSingleton) {
      // `(5)` is a parenthesized expression, not a tuple; `, ` (trailing comma) is what makes a single-element tuple
      const innerLiteral = classifyCellDataWriteValue(rawElements[0]);
      return innerLiteral.class === 'unknown' ? { class: 'unknown' } : innerLiteral;
    }
    if (sequenceClass === 'tuple' && rawElements.length === 1 && rawElements[0].trim() === '') {
      return { class: 'sequence', sequenceClass, arity: 0, elements: [] };
    }
    const elements = rawElements.map(element => classifyCellDataWriteValue(element));
    // Elements containing unknown (names/calls/broken) -> keep the arity only, do not guess the element surface
    const allKnown = elements.every(element => element.class !== 'unknown');
    return {
      class: 'sequence',
      sequenceClass,
      arity: rawElements.length,
      elements: allKnown ? elements : null
    };
  }
  if (s[0] === '{') {
    const inner = scanBracketBody(s);
    if (inner === null) {
      return { class: 'unknown' }; // multi-line/broken/trailing expression: no guessing
    }
    if (inner.trim() === '') {
      return { class: 'dict' }; // an empty `{}` is a dict, not a set
    }
    return hasTopLevelColon(inner) ? { class: 'dict' } : { class: 'set' };
  }
  return { class: 'unknown' };
}

/** Scan inside a quoted body: return the index right after the closing quote (unclosed -> null). Handles `\` escapes. */
function scanQuotedEnd(body: string, quote: string): number | null {
  for (let index = 0; index < body.length; index += 1) {
    if (body[index] === '\\') {
      index += 1;
      continue;
    }
    if (body[index] === quote) {
      // Triple quote: it only closes when the same character appears three times in a row
      if (body.slice(index, index + 3) === quote.repeat(3)) {
        return index + 3;
      }
      return index + 1;
    }
  }
  return null;
}

/** First bracket body: return the inner text of the first bracket pair (must be closed and terminal; otherwise null). */
function scanBracketBody(s: string): string | null {
  const open = s[0];
  const close = open === '[' ? ']' : open === '(' ? ')' : '}';
  let depth = 0;
  let index = 0;
  while (index < s.length) {
    const ch = s[index];
    if (ch === '\'' || ch === '"') {
      const after = scanQuotedEnd(s.slice(index + 1), ch);
      if (after === null) {
        return null;
      }
      index += 1 + after;
      continue;
    }
    if (ch === open) {
      depth += 1;
    } else if (ch === close) {
      depth -= 1;
      if (depth === 0) {
        // The bracket body must be terminal after closing (a trailing expression means this is part of a larger expression, so do not guess the whole segment)
        if (s.slice(index + 1).trim() !== '') {
          return null;
        }
        return s.slice(1, index);
      }
    }
    index += 1;
  }
  return null;
}

/** Split on top-level commas (depth/quote aware; empty segments dropped). */
function splitTopLevelCommas(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  let index = 0;
  while (index < body.length) {
    const ch = body[index];
    if (ch === '\'' || ch === '"') {
      const after = scanQuotedEnd(body.slice(index + 1), ch);
      if (after === null) {
        return [body];
      }
      index += 1 + after;
      continue;
    }
    if (ch === '[' || ch === '(' || ch === '{') {
      depth += 1;
    } else if (ch === ']' || ch === ')' || ch === '}') {
      depth -= 1;
    } else if (ch === ',' && depth === 0) {
      parts.push(body.slice(start, index));
      start = index + 1;
    }
    index += 1;
  }
  parts.push(body.slice(start));
  return parts.filter(part => part.trim() !== '');
}

/** Top-level colon test (depth/quote aware; the boundary between dict literals and set literals). */
function hasTopLevelColon(body: string): boolean {
  let depth = 0;
  let index = 0;
  while (index < body.length) {
    const ch = body[index];
    if (ch === '\'' || ch === '"') {
      const after = scanQuotedEnd(body.slice(index + 1), ch);
      if (after === null) {
        return false;
      }
      index += 1 + after;
      continue;
    }
    if (ch === '[' || ch === '(' || ch === '{') {
      depth += 1;
    } else if (ch === ']' || ch === ')' || ch === '}') {
      depth -= 1;
    } else if (ch === ':' && depth === 0) {
      return true;
    }
    index += 1;
  }
  return false;
}

/** actual text. */
function actualLabel(literal: ValueLiteral): string {
  switch (literal.class) {
    case 'none':
      return 'None';
    case 'bool':
      return 'bool';
    case 'int':
      return 'int';
    case 'float':
      return 'float';
    case 'str':
      return 'str';
    case 'bytes':
      return 'bytes';
    case 'sequence':
      return literal.sequenceClass;
    case 'dict':
      return 'dict';
    case 'set':
      return 'set';
    default:
      return 'unknown';
  }
}

/** 单条写入的错配裁定(无错配 → null)。 */
function checkWriteAgainstFamily(
  literal: ValueLiteral,
  family: ScalarFamily
): { reason: 'structure' | 'range'; actual: string; valueText?: string } | null {
  // 整段推不出(名字/调用/跨行/尾随表达式)= 未知 = 不猜,绝不据此报错配
  if (literal.class === 'unknown') {
    return null;
  }
  switch (family.kind) {
    case 'integer': {
      if (literal.class === 'int' || literal.class === 'bool') {
        if (literal.class === 'int' &&
          ((family.min !== undefined && literal.value < family.min) ||
            (family.max !== undefined && literal.value > family.max))) {
          return { reason: 'range', actual: 'int', valueText: literal.value.toString() };
        }
        return null;
      }
      return { reason: 'structure', actual: actualLabel(literal) };
    }
    case 'float': {
      if (literal.class === 'int' || literal.class === 'bool' || literal.class === 'float') {
        return null;
      }
      return { reason: 'structure', actual: actualLabel(literal) };
    }
    case 'str': {
      if (literal.class === 'str') {
        return null;
      }
      return { reason: 'structure', actual: actualLabel(literal) };
    }
    case 'bytes': {
      if (literal.class === 'bytes') {
        return null;
      }
      return { reason: 'structure', actual: actualLabel(literal) };
    }
    case 'vector': {
      if (literal.class !== 'sequence') {
        return { reason: 'structure', actual: actualLabel(literal) };
      }
      if (literal.arity !== family.arity) {
        return {
          reason: 'structure',
          actual: `${literal.sequenceClass} of ${literal.arity}`
        };
      }
      // 元数相符:元素全数值字面量不报;元素含其他字面量(字符串/None/字典)
      // 报;元素含未知表达式不猜(elements=null)
      if (literal.elements) {
        const nonNumber = literal.elements.find(
          element => element.class !== 'int' && element.class !== 'bool' && element.class !== 'float'
        );
        if (nonNumber) {
          return { reason: 'structure', actual: `${literal.sequenceClass} with ${actualLabel(nonNumber)} component` };
        }
      }
      return null;
    }
  }
}

/** 声明来源段(def 字段 `Avatar.def:5`;内建/无行号只给文件段)。 */
function sourceSegment(entry: CellDataKeyEntry): string {
  if (entry.sourceLine != null && entry.sourceFile) {
    return `${entry.sourceFile}:${entry.sourceLine}`;
  }
  return entry.sourceFile ?? entry.key;
}

/**
 * 已知字段写入型校验(纯函数)。text 全文;entries 为 CELL-04 键宇宙。
 * 写点扫描/别名核定/常量键全部复用 CELL-06/07 同一面;无有效写点或键全部
 * 未知/类型不在标量表 → 空集。
 */
export function analyzeCellDataFieldWrites(
  text: string,
  entries: readonly CellDataKeyEntry[]
): CellDataWriteFinding[] {
  const receiverNames = ['self.cellData', ...cellDataAliasNames(text)];
  const ops = scanCellDataKeyOperations(text, receiverNames);
  if (ops.length === 0 || entries.length === 0) {
    return [];
  }
  const entryByLiteral = new Map<string, CellDataKeyEntry>();
  for (const entry of entries) {
    entryByLiteral.set(entry.key, entry);
  }
  const lines = text.split(/\r?\n/);
  const findings: CellDataWriteFinding[] = [];
  for (const op of ops) {
    if (op.kind !== 'write') {
      continue;
    }
    if (op.receiver !== 'self.cellData' && !cellDataAliasState(text, op.receiver, op.line).valid) {
      continue; // 重绑定后的别名写的是别的字典,不是 cellData 字段
    }
    const entry = entryByLiteral.get(op.key);
    if (!entry || !entry.typeLabel) {
      continue; // 未知键(CELL-09/10 面)或无类型:不查
    }
    const family = SCALAR_FAMILIES.get(entry.typeLabel);
    if (!family) {
      continue; // PYTHON 族/ARRAY/FIXED_DICT/自定义别名:结构未知,不猜
    }
    const rhs = writeRhsLiteral(lines[op.line] ?? '', op);
    if (!rhs) {
      continue;
    }
    const literal = classifyCellDataWriteValue(rhs.text);
    const verdict = checkWriteAgainstFamily(literal, family);
    if (!verdict) {
      continue;
    }
    const source = sourceSegment(entry);
    const message = verdict.reason === 'range'
      ? renderCellDataWriteRangeMessage(op.key, verdict.valueText ?? '', family.label, source)
      : renderCellDataWriteStructureMessage(op.key, family.label, source, verdict.actual);
    findings.push({
      line: op.line,
      character: rhs.start,
      length: rhs.length,
      key: op.key,
      typeLabel: entry.typeLabel,
      actual: verdict.actual,
      reason: verdict.reason,
      declaredFile: entry.sourceFile ?? null,
      declaredLine: entry.sourceLine ?? null,
      message
    });
  }
  return findings;
}

/**
 * 写点 RHS 字面量段(剥行尾注释后 `=` 之后的首段;`=` 位由 op.exprEnd 锚定,
 * 与 classifyKind 同口径)。无 `=`/空段 → null。
 */
function writeRhsLiteral(
  lineText: string,
  op: CellDataKeyOperation
): { text: string; start: number; length: number } | null {
  const commentAt = findLineCommentIndex(lineText);
  const stripped = commentAt === -1 ? lineText : lineText.slice(0, commentAt);
  const eq = stripped.indexOf('=', op.exprEnd);
  if (eq < 0) {
    return null;
  }
  let start = eq + 1;
  while (start < stripped.length && /\s/.test(stripped[start])) {
    start += 1;
  }
  const text = stripped.slice(start).trim();
  if (!text) {
    return null;
  }
  return { text, start, length: stripped.slice(start).trimEnd().length };
}

/** finding → 诊断项(纯数据;extension 侧转 vscode.Diagnostic)。 */
export function cellDataWriteFindingToItem(
  finding: CellDataWriteFinding,
  related?: CellDataRelatedLocation
): CellDataWriteDiagnosticItem {
  return {
    range: {
      start: { line: finding.line, character: finding.character },
      end: { line: finding.line, character: finding.character + finding.length }
    },
    message: finding.message,
    severity: 'Warning',
    source: 'kbengine',
    code: CELL_DATA_WRITE_TYPE_DIAGNOSTIC_CODE,
    ...(related ? { related } : {})
  };
}

// ---- KSEM-STRUCT-04 复用面(同一引擎标量真源,不复制表) ----

/** 字面量值类(STRUCT-04 FD 构造校验按值段分类复用)。 */
export type CellDataValueLiteral = ValueLiteral;

/** 引擎标量期望文案;非标量类型(PYTHON 族/ARRAY/FIXED_DICT/自定义别名)→ null。 */
export function cellDataScalarFamilyLabel(typeLabel: string): string | null {
  return SCALAR_FAMILIES.get(typeLabel)?.label ?? null;
}

/**
 * 结构面裁定(STRUCT-04 FD 构造字段值复用):非标量类型或整段推不出 →
 * null(不裁定);范围面越界 → ok(STRUCT-05 车道,本面不报);结构错配 →
 * ok:false + actual 文案。
 */
export function judgeCellDataValueStructure(
  literal: CellDataValueLiteral,
  typeLabel: string
): { ok: true } | { ok: false; actual: string } | null {
  const family = SCALAR_FAMILIES.get(typeLabel);
  if (!family) {
    return null;
  }
  const verdict = checkWriteAgainstFamily(literal, family);
  if (!verdict) {
    return { ok: true };
  }
  if (verdict.reason === 'range') {
    return { ok: true }; // 范围面归 STRUCT-05,构造面不重复报
  }
  return { ok: false, actual: verdict.actual };
}

// ---- KSEM-STRUCT-05 复用面(同一引擎标量真源,不复制表) ----

/** STRUCT-05 标量赋值裁定结果:范围面在此不豁免。 */
export interface CellDataValueVerdict {
  reason: 'structure' | 'range';
  /** 实际值类文案。 */
  actual: string;
  /** range 面:涉事整数字面量文本。 */
  valueText?: string;
}

/**
 * 全量裁定(STRUCT-05 def 属性/FD 字段/数组元素标量赋值复用):非标量类型或
 * 整段推不出 → null(不裁定);结构或范围错配 → 错配面。与
 * judgeCellDataValueStructure 同一 SCALAR_FAMILIES,仅范围面不豁免。
 */
export function judgeCellDataValueWithRange(
  literal: CellDataValueLiteral,
  typeLabel: string
): CellDataValueVerdict | null {
  const family = SCALAR_FAMILIES.get(typeLabel);
  if (!family) {
    return null;
  }
  return checkWriteAgainstFamily(literal, family);
}
