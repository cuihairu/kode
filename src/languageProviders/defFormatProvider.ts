/**
 * .def 原生格式化 provider(KODE-SYN-006):整文档 + 选区两面,格式核在
 * Rust(`$/kode/def/format`,核见 crates/kode-parser/src/def_format.rs)。
 *
 * 薄适配:document/range 两 provider 共用一条路径——取文档文本 → 选区换算成
 * 字节区间 → 桥取行级编辑集 → 每条编辑换算成 TextEdit。
 *
 * 诚实边界:
 * - Rust 不可用/应答畸形/请求失败 → 返回 `undefined`(不产编辑),绝不部分
 *   应用,也绝不抛进编辑器;
 * - 零编辑(已格式化 或 残缺 XML 安全退回)→ 同样 `undefined`:残缺档靠
 *   解析诊断面已亮问题,这里不再猜格式。
 */

import * as vscode from 'vscode';

import {
  defFormatEditsToTextEdits,
  runDefFormat,
  utf16OffsetToByteOffset
} from '../backend/defFormat';

export class KBEngineDefFormatProvider
  implements vscode.DocumentFormattingEditProvider, vscode.DocumentRangeFormattingEditProvider {
  async provideDocumentFormattingEdits(
    document: vscode.TextDocument
  ): Promise<vscode.TextEdit[] | undefined> {
    return this.format(document, null);
  }

  async provideDocumentRangeFormattingEdits(
    document: vscode.TextDocument,
    range: vscode.Range
  ): Promise<vscode.TextEdit[] | undefined> {
    const text = document.getText();
    return this.format(document, {
      start: utf16OffsetToByteOffset(text, document.offsetAt(range.start)),
      end: utf16OffsetToByteOffset(text, document.offsetAt(range.end))
    });
  }

  private async format(
    document: vscode.TextDocument,
    byteRange: { start: number; end: number } | null
  ): Promise<vscode.TextEdit[] | undefined> {
    const text = document.getText();
    const call = await runDefFormat(text, byteRange ? { byteRange } : undefined);
    if (call.status !== 'ok') {
      return undefined;
    }
    if (call.result.edits.length === 0) {
      return undefined;
    }
    const edits = defFormatEditsToTextEdits(
      text,
      call.result.edits,
      (startUtf16, endUtf16) =>
        new vscode.Range(document.positionAt(startUtf16), document.positionAt(endUtf16))
    );
    return edits.map(item => ({ range: item.range as vscode.Range, newText: item.newText }));
  }
}
