/**
 * Native .def formatting bridge (KODE-SYN-006; the evaluation verdict is in
 * docs/design/def-formatter-evaluation.md, option B): the formatting core lives
 * in Rust (kode-parser def_format.rs, the precise span surface), and this file
 * is only a thin adapter:
 * - `runDefFormat`: the `$/kode/def/format` bridge (payload
 *   content/indentSize/start+end);
 * - offset coordinate conversion: a Rust span is a position in **raw-text
 *   UTF-8 bytes**, while a vscode Position is a UTF-16 code unit -- the
 *   conversion helpers on both sides are the only translation surface between
 *   the provider and the real editor (for CJK/non-BMP text a byte position
 *   is not a UTF-16 position, and they must not be mixed);
 * - `defFormatEditsToTextEdits`: a line-level edit set -> the TextEdit surface
 *   (ranges are built by an injected factory; this core has zero vscode).
 *
 * Honest boundaries: Rust unavailable / malformed reply -> no edits (no
 * guessing, no half-apply); malformed XML is a safe fallback on the Rust side
 * (zero edits + the `diagnostics` count carried back, so the caller can tell
 * "formatted" apart from "unparsable"; a zero-edit result is never silent).
 *
 * No vscode import: the whole UI/editor surface is injected (unit tests can
 * drive it purely).
 */

import { getKodeCoreShadowGate } from './kodeCoreShadowFaces';
import type { RustCall } from './ruffLint';

/** A single line-level edit: `[start, end)` is a **raw-text UTF-8 byte** interval (equal for a pure insertion). */
export interface DefFormatEditFace {
  start: number;
  end: number;
  text: string;
}

export interface DefFormatResult {
  edits: DefFormatEditFace[];
  /** Parse diagnostic count: zero edits + nonzero diagnostics = a safe fallback for "unparsable", not "formatted". */
  diagnostics: number;
}

export type DefFormatCall = RustCall<DefFormatResult>;

/** Selection (byte coordinates; by default the whole document). */
export interface DefFormatRange {
  start: number;
  end: number;
}

export interface DefFormatOptions {
  /** Selection (whole document by default); if only one of `start`/`end` is given, the Rust side rejects it as a bad argument. */
  byteRange?: DefFormatRange;
  /** Spaces per indentation level (default 4; the Rust side caps at 64 and reports out-of-range values honestly). */
  indentSize?: number;
}

/** The `$/kode/def/format` bridge: content passed straight through (pure computation surface, no IO, no file paths). */
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
    // Malformed reply = shape drift: degrade honestly -- neither partially applied nor thrown at the editor
    return {
      status: 'error',
      reason: `defFormat: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

/** Reply shape validation: if any entry lacks an interval/text or has a reversed interval -> the whole surface is discarded (no partial adoption). */
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

// ---- Offset coordinate conversion (UTF-8 bytes <-> UTF-16 code unit) -------

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

/** High surrogate + adjacent low surrogate -> code point; otherwise null (a lone surrogate counts as a single unit). */
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

/** UTF-16 code unit position -> raw-text UTF-8 byte position (the dual of vscode.offsetAt). */
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

/** Raw-text UTF-8 byte position -> UTF-16 code unit position (the argument of document.positionAt). */
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

// ---- Edit set -> TextEdit surface -----------------------------------------

export interface DefFormatTextEdit {
  range: unknown;
  newText: string;
}

/**
 * Line-level edit set -> TextEdit surface: each edit's byte interval is
 * converted to a UTF-16 position and then handed to `toRange` to build the
 * real range (production injects the vscode.Range factory, unit tests inject a
 * recorder). The intervals do not overlap (pinned by Rust-side unit tests), so
 * building them in order is sufficient.
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
