// KODE-SYN-006:`.def` 原生格式化 TS 面(桥 + 偏移换算 + provider 两面降级)。
// 四组:
// ①桥载荷契约:`$/kode/def/format` 只带 content/indentSize/start+end,ok/no-gate/
//   error 三态 + 应答畸形整面作废 + `diagnostics` 条数透传(残缺档安全退回口径)。
// ②偏移换算:Rust span 是 UTF-8 字节位、vscode 是 UTF-16 code unit——ASCII/中文/
//   非 BMP(emoji)/孤立代理 的往返与越界 clamp。
// ③编辑集适配:行级字节区间 → UTF-16 位 → 注入的 range 工厂(本核零 vscode)。
// ④provider 两面:整文档/选区同链;无 gate、桥 error、零编辑 → undefined(不抛
//   不半改),选区把 UTF-16 区间换算成字节区间进载荷。
import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import {
  byteOffsetToUtf16Offset,
  defFormatEditsToTextEdits,
  runDefFormat,
  utf16OffsetToByteOffset
} from '../src/backend/defFormat';
import { KBEngineDefFormatProvider } from '../src/languageProviders/defFormatProvider';
import { setKodeCoreShadowGate } from '../src/backend/kodeCoreShadowFaces';
import type { KodeCoreGate } from '../src/backend/kodeCoreGate';

/** 最小 gate 桩:记录 method/params,按 scripted 回包。 */
const makeGate = (
  scripted: Record<string, unknown>
): { gate: KodeCoreGate; calls: Array<{ method: string; params: unknown }> } => {
  const calls: Array<{ method: string; params: unknown }> = [];
  const gate = {
    serveFromRust: () => true,
    runInRust: async (method: string, params: unknown) => {
      calls.push({ method, params });
      const result = scripted[method];
      if (result === undefined) {
        return { ok: false as const, reason: 'unscripted' } as const;
      }
      return { ok: true as const, result } as const;
    }
  } as unknown as KodeCoreGate;
  return { gate, calls };
};

describe('defFormat 桥契约(①载荷与回包)', () => {
  it('ok:载荷只带 content/indentSize/start+end,应答整面透传', async () => {
    const { gate, calls } = makeGate({
      '$/kode/def/format': { edits: [{ start: 4, end: 9, text: '    <Root>' }], diagnostics: 0 }
    });
    setKodeCoreShadowGate(gate);
    const result = await runDefFormat('<Root>1</Root>', { indentSize: 4, byteRange: { start: 4, end: 9 } });
    expect(result).toEqual({
      status: 'ok',
      result: { edits: [{ start: 4, end: 9, text: '    <Root>' }], diagnostics: 0 }
    });
    expect(calls).toEqual([
      { method: '$/kode/def/format', params: { content: '<Root>1</Root>', indentSize: 4, start: 4, end: 9 } }
    ]);
    setKodeCoreShadowGate(null);
  });

  it('无选区无缩进 → 载荷只有 content(不多发缺省键)', async () => {
    const { gate, calls } = makeGate({ '$/kode/def/format': { edits: [], diagnostics: 0 } });
    setKodeCoreShadowGate(gate);
    await runDefFormat('<Root/>');
    expect(calls[0].params).toEqual({ content: '<Root/>' });
    setKodeCoreShadowGate(null);
  });

  it('无 gate → no-gate(调用方按不可用处理)', async () => {
    setKodeCoreShadowGate(null);
    expect(await runDefFormat('<Root/>')).toEqual({ status: 'no-gate' });
  });

  it('桥 error 原样带回 reason', async () => {
    const { gate } = makeGate({});
    setKodeCoreShadowGate(gate);
    expect(await runDefFormat('<Root/>')).toEqual({ status: 'error', reason: 'unscripted' });
    setKodeCoreShadowGate(null);
  });

  it('diagnostics 条数透传:零编辑 + 非零诊断 = 残缺档安全退回,不是「已格式化」', async () => {
    const { gate } = makeGate({ '$/kode/def/format': { edits: [], diagnostics: 3 } });
    setKodeCoreShadowGate(gate);
    expect(await runDefFormat('<Root><Broken>')).toEqual({
      status: 'ok',
      result: { edits: [], diagnostics: 3 }
    });
    setKodeCoreShadowGate(null);
  });

  it('应答非对象 → error:unexpected result shape', async () => {
    const { gate } = makeGate({ '$/kode/def/format': null });
    setKodeCoreShadowGate(gate);
    // readResult 自带 defFormat: 前缀,外层再补一层(双层前缀是既有口径)。
    expect((await runDefFormat('<Root/>')).reason).toBe(
      'defFormat: defFormat: unexpected result shape from rust backend'
    );
    setKodeCoreShadowGate(null);
  });

  it('edits 非数组 / 条目畸形(缺 text、区间反向)→ 整面作废不部分采用', async () => {
    const badArray = makeGate({ '$/kode/def/format': { edits: 'nope', diagnostics: 0 } });
    setKodeCoreShadowGate(badArray.gate);
    expect((await runDefFormat('<Root/>')).reason).toBe('defFormat: defFormat: edits face must be an array');
    setKodeCoreShadowGate(null);
    const badEntry = makeGate({
      '$/kode/def/format': { edits: [{ start: 9, end: 4, text: 'x' }], diagnostics: 0 }
    });
    setKodeCoreShadowGate(badEntry.gate);
    expect((await runDefFormat('<Root/>')).reason).toBe(
      'defFormat: defFormat: malformed edit entry from rust backend'
    );
    setKodeCoreShadowGate(null);
    const missingText = makeGate({ '$/kode/def/format': { edits: [{ start: 1, end: 2 }], diagnostics: 0 } });
    setKodeCoreShadowGate(missingText.gate);
    expect((await runDefFormat('<Root/>')).status).toBe('error');
    setKodeCoreShadowGate(null);
  });
});

describe('偏移换算(②UTF-8 字节 ↔ UTF-16 code unit)', () => {
  const text = '中文 def 🚀<Root>x</Root>';

  it('ASCII 恒等:字节位 = UTF-16 位', () => {
    expect(utf16OffsetToByteOffset('abcdef', 3)).toBe(3);
    expect(byteOffsetToUtf16Offset('abcdef', 4)).toBe(4);
  });

  it('中文/emoji 的往返:字节位≠UTF-16 位,但两端对偶', () => {
    const mid = utf16OffsetToByteOffset(text, 4);
    expect(mid).toBeGreaterThan(4);
    expect(byteOffsetToUtf16Offset(text, mid)).toBe(4);
    const emoji = utf16OffsetToByteOffset(text, 9); // 🚀 前(代理对 2 单元 / 4 字节)
    expect(emoji).toBe(15);
    expect(byteOffsetToUtf16Offset(text, emoji)).toBe(9);
    const tail = utf16OffsetToByteOffset(text, text.length);
    expect(tail).toBe(29);
    expect(byteOffsetToUtf16Offset(text, tail)).toBe(text.length);
  });

  it('边界:越界 clamp 到 [0, 全文],负值不产生负偏移', () => {
    expect(utf16OffsetToByteOffset(text, -5)).toBe(0);
    expect(utf16OffsetToByteOffset(text, 10_000)).toBe(29);
    expect(byteOffsetToUtf16Offset(text, -1)).toBe(0);
    expect(byteOffsetToUtf16Offset(text, 10_000)).toBe(text.length);
    expect(byteOffsetToUtf16Offset('', 3)).toBe(0);
  });

  it('孤立代理按单单元计(不越界,往返仍成立)', () => {
    const lone = 'ab\uD83D';
    const mid = utf16OffsetToByteOffset(lone, 3);
    expect(mid).toBe(5);
    expect(byteOffsetToUtf16Offset(lone, mid)).toBe(3);
  });
});

describe('编辑集适配(③行级字节区间 → TextEdit 面)', () => {
  it('字节区间换算成 UTF-16 位后进注入的 range 工厂,文本原样带回', () => {
    const content = '中文 def 🚀<Root>x</Root>';
    const ranges: Array<[number, number]> = [];
    const edits = defFormatEditsToTextEdits(content, [{ start: 24, end: 30, text: '    <Root>' }], (a, b) => {
      ranges.push([a, b]);
      return { a, b };
    });
    // 字节 24..30 = 前缀 15 字节 + '<Root>x' 的尾部(x 及其后)= UTF-16 位 18..23。
    expect(ranges).toEqual([[18, 23]]);
    expect(edits).toEqual([{ range: { a: 18, b: 23 }, newText: '    <Root>' }]);
  });
});

describe('provider 两面(④整文档/选区 + 降级)', () => {
  // 假的文档坐标面按换行切分(offsetAt/positionAt 是 position↔UTF-16 位的真对偶)。
  const makeDoc = (text: string) => ({
    getText: () => text,
    offsetAt: (position: vscode.Position) =>
      text.split('\n').slice(0, position.line).join('\n').length + position.line + position.character,
    positionAt: (offset: number) => {
      const head = text.slice(0, offset);
      const lines = head.split('\n');
      return { line: lines.length - 1, character: lines[lines.length - 1].length };
    }
  });

  it('ok + 编辑集 → 两条 TextEdit(range 来自文档坐标)', async () => {
    const { gate } = makeGate({
      '$/kode/def/format': {
        edits: [
          { start: 0, end: 6, text: '<Root>' },
          { start: 8, end: 15, text: '</Root>' }
        ],
        diagnostics: 0
      }
    });
    setKodeCoreShadowGate(gate);
    const doc = makeDoc('<Root>\nx</Root>\n');
    const edits = await new KBEngineDefFormatProvider().provideDocumentFormattingEdits(
      doc as unknown as vscode.TextDocument
    );
    expect(edits).toEqual([
      { range: new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 6)), newText: '<Root>' },
      // 第 2 行是 'x</Root>'(8 字符):字节 8..15 → (1,1)..(1,8)。
      { range: new vscode.Range(new vscode.Position(1, 1), new vscode.Position(1, 8)), newText: '</Root>' }
    ]);
    setKodeCoreShadowGate(null);
  });

  it('选区:UTF-16 区间换算成字节区间进载荷,文档面零 start/end', async () => {
    const { gate, calls } = makeGate({ '$/kode/def/format': { edits: [], diagnostics: 0 } });
    setKodeCoreShadowGate(gate);
    const provider = new KBEngineDefFormatProvider();
    const doc = makeDoc('中文 def 🚀<Root>x</Root>');
    await provider.provideDocumentFormattingEdits(doc as unknown as vscode.TextDocument);
    expect(calls[0].params).toEqual({ content: '中文 def 🚀<Root>x</Root>' });
    await provider.provideDocumentRangeFormattingEdits(
      doc as unknown as vscode.TextDocument,
      new vscode.Range(new vscode.Position(0, 3), new vscode.Position(0, 16))
    );
    // UTF-16 3 = 中文 6 字节 + 空格;16 = 前 15 字节 + 🚀 4 字节 = 22 的起点。
    expect(calls[1].params).toEqual({ content: '中文 def 🚀<Root>x</Root>', start: 7, end: 22 });
    setKodeCoreShadowGate(null);
  });

  it('零编辑 / 无 gate / 桥 error → undefined(不抛不半改)', async () => {
    const provider = new KBEngineDefFormatProvider();
    const doc = makeDoc('<Root/>');
    const zero = makeGate({ '$/kode/def/format': { edits: [], diagnostics: 2 } });
    setKodeCoreShadowGate(zero.gate);
    expect(await provider.provideDocumentFormattingEdits(doc as unknown as vscode.TextDocument)).toBeUndefined();
    setKodeCoreShadowGate(null);
    expect(await provider.provideDocumentFormattingEdits(doc as unknown as vscode.TextDocument)).toBeUndefined();
    const broken = makeGate({});
    setKodeCoreShadowGate(broken.gate);
    expect(await provider.provideDocumentRangeFormattingEdits(doc as unknown as vscode.TextDocument, new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 6)))).toBeUndefined();
    setKodeCoreShadowGate(null);
  });
});