/**
 * KSEM-CELL-08:cellData 已知字段写入类型校验诊断。
 * 数据源 = CELL-04 键宇宙(fetchCellDataKeys:kind/typeLabel/sourceFile/
 * sourceLine);写点/别名/常量键复用 CELL-06/07(scanCellDataKeyOperations +
 * cellDataAliasState/resolveCellDataConstantKey)。引擎事实(datatypes.cpp
 * `DataTypes::initialize` 注册表,与 kbengineMetadata 同源):整数标量带宽与
 * 符号定范围;FLOAT/DOUBLE 数值;STRING/UNICODE 字符串;BLOB 字节流;
 * VECTOR2/3/4 定长数值向量;PYTHON 与 PY_DICT/PY_TUPLE/PY_LIST/ENTITYCALL
 * 收 Python 对象面不查;ARRAY/FIXED_DICT/types.xml 自定义别名结构未知 →
 * 不查(诚实)。
 *
 * 纯逻辑层,不 import vscode。判定(保守面,误报=0 优先):
 * - 只查 `write`(下标 `= ` 直赋;增强赋值/`.get` 归读不参与);
 * - 接收者须有效:self.cellData 直写,或 CELL-07 别名最近赋值仍是
 *   `= self.cellData`(重绑定后写的是别的字典,不查);别名逃逸不影响写型
 *   (逃逸只降读点存在性,字典形状不变);
 * - 键在宇宙且有 typeLabel;未知键/无类型/类型不在标量表 → 不查(未知键归
 *   CELL-09/10);
 * - RHS 须**整段单行字面量**(尾随内容/跨行残缺/名字/调用 → 不猜);
 * - 结构面:字符串→数值/向量、None/字典/集合→数值/字符串/字节流/向量、
 *   列表→数值/字符串标量、字节串→字符串/数值 = 错配;bool 是 int 子类不报;
 *   浮点字面量→整数标量报(与声明结构不符);
 * - 范围面:整数字面量超引擎标量范围(负入无符号/越界)报;
 * - VECTOR2/3/4:序列字面量元数按语法可数——元数不符报;元数相符时元素全
 *   数值字面量不报、元素是其他字面量(字符串/None/字典)报、元素含未知表
 *   达式不猜。
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

export const CELL_DATA_WRITE_TYPE_DIAGNOSTIC_CODE = 'kbengine.cellDataWriteType';
export const CELL_DATA_WRITE_DIAGNOSTICS_ENABLED_DEFAULT = true;

/** 引擎标量族(datatypes.cpp 注册表;范围=带宽与符号的封闭区间)。 */
interface ScalarFamily {
  /** 值类:integer 标量(int/bool 可入)/float 标量/字符串/字节流/定长向量。 */
  kind: 'integer' | 'float' | 'str' | 'bytes' | 'vector';
  /** integer 族范围(BigInt 精确边界;缺省=不设界)。 */
  min?: bigint;
  max?: bigint;
  /** vector 族元数。 */
  arity?: number;
  /** 提示文案里的期望段(`UINT16 (int 0..65535)`)。 */
  label: string;
}

/** 引擎标量类型表;不在表内的类型(PYTHON 族、ARRAY、FIXED_DICT、自定义别名)不查。 */
// 范围界一律 BigInt()(tsconfig target < ES2020 禁字面量 0n;64 位界以字符串
// 入参保精度),写入值同以 BigInt 精确解析——边界判定无 double 取整死区。
const SCALAR_FAMILIES: ReadonlyMap<string, ScalarFamily> = new Map([
  ['UINT8', { kind: 'integer', min: BigInt(0), max: BigInt(255), label: 'UINT8 (int 0..255)' }],
  ['UINT16', { kind: 'integer', min: BigInt(0), max: BigInt(65535), label: 'UINT16 (int 0..65535)' }],
  ['UINT32', { kind: 'integer', min: BigInt(0), max: BigInt(4294967295), label: 'UINT32 (int 0..4294967295)' }],
  ['UINT64', { kind: 'integer', min: BigInt(0), max: BigInt('18446744073709551615'), label: 'UINT64 (int 0..2^64-1)' }],
  ['INT8', { kind: 'integer', min: BigInt(-128), max: BigInt(127), label: 'INT8 (int -128..127)' }],
  ['INT16', { kind: 'integer', min: BigInt(-32768), max: BigInt(32767), label: 'INT16 (int -32768..32767)' }],
  ['INT32', { kind: 'integer', min: BigInt(-2147483648), max: BigInt(2147483647), label: 'INT32 (int -2^31..2^31-1)' }],
  ['INT64', { kind: 'integer', min: BigInt('-9223372036854775808'), max: BigInt('9223372036854775807'), label: 'INT64 (int -2^63..2^63-1)' }],
  ['FLOAT', { kind: 'float', label: 'FLOAT (number)' }],
  ['DOUBLE', { kind: 'float', label: 'DOUBLE (number)' }],
  ['STRING', { kind: 'str', label: 'STRING (str)' }],
  ['UNICODE', { kind: 'str', label: 'UNICODE (str)' }],
  ['BLOB', { kind: 'bytes', label: 'BLOB (bytes)' }],
  ['VECTOR2', { kind: 'vector', arity: 2, label: 'VECTOR2 (2-number sequence)' }],
  ['VECTOR3', { kind: 'vector', arity: 3, label: 'VECTOR3 (3-number sequence)' }],
  ['VECTOR4', { kind: 'vector', arity: 4, label: 'VECTOR4 (4-number sequence)' }]
]);

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

/** RHS 整段字面量分类(整段恰为一个字面量才给类;残缺/尾随表达式 → unknown)。 */
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
    // BigInt 精确解析(十进制/0x/0o/0b 同构;64 位边界不落 double 取整)
    return { class: 'int', value: BigInt(s.replace(/_/g, '')) };
  }
  if (FLOAT_LITERAL.test(s)) {
    return { class: 'float' };
  }
  const stringLiteral = /^([rRuUbBfF]{0,2})(['"])/.exec(s);
  if (stringLiteral) {
    // 尾随内容(拼接/属性访问)不猜:引号闭后必须收尾
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
      return { class: 'unknown' }; // 跨行/未闭合:类可判但元数不可数,不猜
    }
    const rawElements = splitTopLevelCommas(inner);
    const isTupleSingleton = sequenceClass === 'tuple' && rawElements.length === 1 && !inner.includes(',');
    if (isTupleSingleton) {
      // `(5)` 是括号表达式不是元组;`, `(尾逗号)才是单元素元组
      const innerLiteral = classifyCellDataWriteValue(rawElements[0]);
      return innerLiteral.class === 'unknown' ? { class: 'unknown' } : innerLiteral;
    }
    if (sequenceClass === 'tuple' && rawElements.length === 1 && rawElements[0].trim() === '') {
      return { class: 'sequence', sequenceClass, arity: 0, elements: [] };
    }
    const elements = rawElements.map(element => classifyCellDataWriteValue(element));
    // 元素含 unknown(名字/调用/残缺)→ 只保元数,元素面不猜
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
      return { class: 'unknown' }; // 跨行/残缺/尾随表达式:不猜
    }
    if (inner.trim() === '') {
      return { class: 'dict' }; // 空 `{}` 是 dict 不是 set
    }
    return hasTopLevelColon(inner) ? { class: 'dict' } : { class: 'set' };
  }
  return { class: 'unknown' };
}

/** 引号体内扫描:返回闭引号后的下标(未闭合 → null)。处理 `\` 转义。 */
function scanQuotedEnd(body: string, quote: string): number | null {
  for (let index = 0; index < body.length; index += 1) {
    if (body[index] === '\\') {
      index += 1;
      continue;
    }
    if (body[index] === quote) {
      // 三引号:同字符连三次才闭
      if (body.slice(index, index + 3) === quote.repeat(3)) {
        return index + 3;
      }
      return index + 1;
    }
  }
  return null;
}

/** 首括号体:返回首括号配对体的内部文本(必须闭合且收尾;否则 null)。 */
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
        // 括号体闭合后必须收尾(尾随表达式=更大表达式的一部分,整段不猜)
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

/** 顶层逗号切分(深度/引号感知;空段剔除)。 */
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

/** 顶层冒号判定(深度/引号感知;dict 字面量与 set 字面量的分界)。 */
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

/** actual 文案。 */
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
