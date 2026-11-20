/**
 * .def 原生格式化桥(KODE-SYN-006,评估结论见
 * docs/design/def-formatter-evaluation.md 方案 B):格式化核收敛在 Rust
 * (kode-parser def_format.rs 精确 span 面),本文件只做薄适配:
 * - `runDefFormat`:`$/kode/def/format` 桥(载荷 content/indentSize/start+end);
 * - 偏移坐标换算:Rust span 是**原文本 UTF-8 字节**位,vscode Position 是
 *   UTF-16 code unit——两侧换算 helper 是 provider 与真实编辑器之间的唯一
 *   转换面(中文/非 BMP 文本下字节位≠UTF-16 位,不可混用);
 * - `defFormatEditsToTextEdits`:行级编辑集 → TextEdit 面(range 由注入的
 *   工厂构造,本核零 vscode)。
 *
 * 诚实边界:Rust 不可用/应答畸形 → 无编辑(不猜不半改);残缺 XML 由 Rust 侧
 * 安全退回(零编辑 + `diagnostics` 条数回带,调用方据此区分「已格式化」与
 * 「解析不通」,零编辑不静默)。
 *
 * 无 vscode import:UI/编辑器面全经注入(单测可纯驱动)。
 */

import { getKodeCoreShadowGate } from './kodeCoreShadowFaces';
import type { RustCall } from './ruffLint';

/** 一条行级编辑:`[start, end)` 是**原文本 UTF-8 字节**区间(纯插入时相等)。 */
export interface DefFormatEditFace {
  start: number;
  end: number;
  text: string;
}

export interface DefFormatResult {
  edits: DefFormatEditFace[];
  /** 解析诊断条数:零编辑 + 非零诊断 = 解析不通的安全退回,不是「已格式化」。 */
  diagnostics: number;
}

export type DefFormatCall = RustCall<DefFormatResult>;

/** 选区(字节坐标,缺省=整文档)。 */
export interface DefFormatRange {
  start: number;
  end: number;
}

export interface DefFormatOptions {
  /** 选区(缺省整文档);`start`/`end` 缺一半由 Rust 侧按错参拒。 */
  byteRange?: DefFormatRange;
  /** 每层缩进空格数(缺省 4;Rust 侧上限 64,越界如实报错)。 */
  indentSize?: number;
}

/** `$/kode/def/format` 桥:content 直传(纯计算面,无 IO、无文件路径)。 */
export async function runDefFormat(
  content: string,
  options: DefFormatOptions = {}
): Promise<DefFormatCall> {
  const gate = getKodeCoreShadowGate();
  if (!gate) {
    return { status: 'no-gate' };
  }
  const params: Record<string, unknown> = { content };
  if (options.indentSize !== undefined) {
    params.indentSize = options.indentSize;
  }
  if (options.byteRange) {
    params.start = options.byteRange.start;
    params.end = options.byteRange.end;
  }
  const response = await gate.runInRust('$/kode/def/format', params);
  if (!response.ok) {
    return { status: 'error', reason: response.reason };
  }
  try {
    return { status: 'ok', result: readResult(response.result) };
  } catch (error) {
    // 应答畸形 = 形状漂移:如实降级,不部分采用也不抛给编辑器
    return {
      status: 'error',
      reason: `defFormat: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

/** 应答形状校验:任一条目缺区间/文本或区间反向 → 整面作废(不部分采用)。 */
function readResult(value: unknown): DefFormatResult {
  const record = value as Record<string, unknown> | null;
  if (typeof record !== 'object' || record === null) {
    throw new Error('defFormat: unexpected result shape from rust backend');
  }
  if (typeof record.diagnostics !== 'number') {
    throw new Error('defFormat: diagnostics face must be a number');
  }
  const rawEdits = record.edits;
  if (!Array.isArray(rawEdits)) {
    throw new Error('defFormat: edits face must be an array');
  }
  const edits: DefFormatEditFace[] = [];
  for (const raw of rawEdits) {
    const edit = raw as Record<string, unknown> | null;
    if (
      typeof edit !== 'object' ||
      edit === null ||
      typeof edit.start !== 'number' ||
      typeof edit.end !== 'number' ||
      typeof edit.text !== 'string' ||
      edit.start < 0 ||
      edit.end < edit.start
    ) {
      throw new Error('defFormat: malformed edit entry from rust backend');
    }
    edits.push({ start: edit.start, end: edit.end, text: edit.text });
  }
  return { edits, diagnostics: record.diagnostics };
}

// ---- 偏移坐标换算(UTF-8 字节 ↔ UTF-16 code unit) -------------------------

function codePointBytes(codePoint: number): number {
  if (codePoint < 0x80) {
    return 1;
  }
  if (codePoint < 0x800) {
    return 2;
  }
  if (codePoint < 0x10000) {
    return 3;
  }
  return 4;
}

/** 高位代理 + 紧邻低位代理 → 码点;否则 null(孤立代理按单单元计)。 */
function pairCodePoint(content: string, index: number): number | null {
  const high = content.charCodeAt(index);
  if (high < 0xd800 || high > 0xdbff || index + 1 >= content.length) {
    return null;
  }
  const low = content.charCodeAt(index + 1);
  if (low < 0xdc00 || low > 0xdfff) {
    return null;
  }
  return ((high - 0xd800) << 10) + (low - 0xdc00) + 0x10000;
}

/** UTF-16 code unit 位 → 原文本 UTF-8 字节位(vscode.offsetAt 的对偶)。 */
export function utf16OffsetToByteOffset(content: string, utf16Offset: number): number {
  const target = Math.max(0, Math.min(Math.floor(utf16Offset), content.length));
  let bytes = 0;
  let index = 0;
  while (index < target) {
    const pair = pairCodePoint(content, index);
    if (pair !== null) {
      bytes += codePointBytes(pair);
      index += 2;
      continue;
    }
    bytes += codePointBytes(content.charCodeAt(index));
    index += 1;
  }
  return bytes;
}

/** 原文本 UTF-8 字节位 → UTF-16 code unit 位(document.positionAt 的入参)。 */
export function byteOffsetToUtf16Offset(content: string, byteOffset: number): number {
  const total = utf16OffsetToByteOffset(content, content.length);
  const target = Math.max(0, Math.min(Math.floor(byteOffset), total));
  let index = 0;
  let bytes = 0;
  while (index < content.length) {
    const pair = pairCodePoint(content, index);
    const size = pair === null ? codePointBytes(content.charCodeAt(index)) : codePointBytes(pair);
    if (bytes + size > target) {
      return index;
    }
    bytes += size;
    index += pair === null ? 1 : 2;
  }
  return index;
}

// ---- 编辑集 → TextEdit 面 ------------------------------------------------

export interface DefFormatTextEdit {
  range: unknown;
  newText: string;
}

/**
 * 行级编辑集 → TextEdit 面:每条编辑的字节区间换算成 UTF-16 位后由
 * `toRange` 构造真实 range(生产注入 vscode.Range 工厂,单测注入记录器)。
 * 区间互不重叠(Rust 侧单测已钉),故按序构造即可。
 */
export function defFormatEditsToTextEdits(
  content: string,
  edits: readonly DefFormatEditFace[],
  toRange: (startUtf16: number, endUtf16: number) => unknown
): DefFormatTextEdit[] {
  return edits.map(edit => ({
    range: toRange(
      byteOffsetToUtf16Offset(content, edit.start),
      byteOffsetToUtf16Offset(content, edit.end)
    ),
    newText: edit.text
  }));
}
