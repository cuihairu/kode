import { describe, expect, it } from 'vitest';
import {
  KBEngineReceiverNoneGuardCodeActionProvider,
  RECEIVER_NONE_DIAGNOSTIC_CODE
} from '../src/languageProviders';
import {
  RECEIVER_NONE_DIAGNOSTIC_CODE as RECEIVER_NONE_CODE,
  RECEIVER_SECTION_MISMATCH_DIAGNOSTIC_CODE,
  buildReceiverNoneGuardEdit,
  receiverNoneDiagnosticItems
} from '../src/receiverNoneDiagnostics';
import {
  CodeActionKind,
  Diagnostic,
  DiagnosticSeverity,
  Position,
  Range,
  makeTextDocument
} from './helpers/vscodeStub';
import type { MinimalTextDocument } from './helpers/vscodeStub';

// B-7(2026-10-29 用户令点火):receiver-none 诊断的快速修复——在无判空
// guard 的接收者使用行之前插入早退守卫 `if not self.<receiver>:\n return`。
// 守卫形态与诊断面自认(sameLineIf 之外 early-exit guard 一族)一致,插入后
// 重算诊断该位不再报。纯函数面(buildReceiverNoneGuardEdit)+ provider 面
// (code 对账 kbengine.receiverNone,只插本文档,非本码诊断/取消位不出)。

const PY_TEXT = [
  'class Avatar(kbe.KBEntity):',
  '    def onTimer(self):',
  '        self.client.onGmRes(-1)',
  ''
].join('\n');

const pyDocument = (): MinimalTextDocument =>
  makeTextDocument(PY_TEXT, { fileName: '/tmp/ws/scripts/base/Avatar.py', languageId: 'python' });

/** receiver-none 诊断替身:锚在 onGmRes 方法名 token(0 基行 2,列 18..25) */
const receiverNoneDiagnostic = (code: string | number | undefined = RECEIVER_NONE_CODE): Diagnostic => {
  const diagnostic = new Diagnostic(
    new Range(new Position(2, 18), new Position(2, 25)),
    'self.client 可能为 None(玩家离线/掉线后引擎直接返回 None…)',
    DiagnosticSeverity.Warning
  );
  if (code !== undefined) {
    diagnostic.code = code;
  }
  return diagnostic;
};

describe('buildReceiverNoneGuardEdit(纯函数)', () => {
  it('使用行之前插入早退守卫,缩进随使用行(空格文件)', () => {
    const edit = buildReceiverNoneGuardEdit(PY_TEXT, 2, 'client');
    expect(edit).toEqual({
      line: 2,
      text: '        if not self.client:\n            return\n'
    });
  });

  it('tab 缩进文件:守卫用 tab,内层再进一级(不混制表符)', () => {
    const tabText = 'class Avatar(kbe.KBEntity):\n\tdef onTimer(self):\n\t\tself.cell.tick()\n';
    const edit = buildReceiverNoneGuardEdit(tabText, 2, 'cell');
    expect(edit).toEqual({
      line: 2,
      text: '\t\tif not self.cell:\n\t\t\treturn\n'
    });
  });

  it('行号越界/空文本 → null(不猜)', () => {
    expect(buildReceiverNoneGuardEdit(PY_TEXT, 99, 'client')).toBeNull();
    expect(buildReceiverNoneGuardEdit('', 0, 'client')).toBeNull();
  });
});

describe('KBEngineReceiverNoneGuardCodeActionProvider(B-7)', () => {
  const provider = new KBEngineReceiverNoneGuardCodeActionProvider();

  it('receiver-none 诊断 → 单条 QuickFix:使用行前插入守卫,不碰其他文件', () => {
    const document = pyDocument();
    const diagnostic = receiverNoneDiagnostic();
    const actions = provider.provideCodeActions(
      document,
      diagnostic.range,
      { diagnostics: [diagnostic] },
      undefined
    )!;

    expect(actions).toHaveLength(1);
    const action = actions[0];
    expect(action.kind).toBe(CodeActionKind.QuickFix);
    expect(action.title).toContain('self.client');
    expect(action.title).toContain('None');
    expect(action.diagnostics).toEqual([diagnostic]);
    expect(action.command).toBeUndefined();

    const entries = action.edit!.entries();
    expect(entries).toHaveLength(1);
    const [uri, edits] = entries[0];
    expect(uri.toString()).toBe(document.uri.toString());
    expect(edits).toHaveLength(1);
    // 插入点=使用行行首(0 基行 2 列 0),插入文本含早退守卫两行
    expect(edits[0].range.start).toEqual(new Position(2, 0));
    expect(edits[0].range.end).toEqual(new Position(2, 0));
    expect(edits[0].newText).toBe('        if not self.client:\n            return\n');
  });

  it('同码双诊断(同行两处调用)去重只出一条;段错配码/无码诊断不出', () => {
    const document = pyDocument();
    const first = receiverNoneDiagnostic();
    const second = receiverNoneDiagnostic();
    expect(provider.provideCodeActions(
      document, first.range, { diagnostics: [first, second] }, undefined
    )).toHaveLength(1);

    // 段错配是路由问题不是判空问题:不出守卫动作
    const mismatch = receiverNoneDiagnostic(RECEIVER_SECTION_MISMATCH_DIAGNOSTIC_CODE);
    expect(provider.provideCodeActions(
      document, mismatch.range, { diagnostics: [mismatch] }, undefined
    )).toEqual([]);

    // 无 code 的普通 Warning:不对账
    const plain = new Diagnostic(
      new Range(new Position(2, 18), new Position(2, 25)),
      '别的 Warning',
      DiagnosticSeverity.Warning
    );
    expect(provider.provideCodeActions(
      document, plain.range, { diagnostics: [plain] }, undefined
    )).toEqual([]);
  });

  it('诊断区间与请求区间不相交 → 不出;取消位 → 空', () => {
    const document = pyDocument();
    const diagnostic = receiverNoneDiagnostic();
    expect(provider.provideCodeActions(
      document, new Range(new Position(0, 0), new Position(0, 5)),
      { diagnostics: [diagnostic] }, undefined
    )).toEqual([]);
    expect(provider.provideCodeActions(
      document, diagnostic.range, { diagnostics: [diagnostic] },
      { isCancellationRequested: true } as never
    )).toEqual([]);
  });

  it('诊断行提取不出接收者(诊断与文本错位)→ 不出,不猜', () => {
    const document = pyDocument();
    const elsewhere = new Diagnostic(
      new Range(new Position(0, 0), new Position(0, 5)),
      'self.client 可能为 None…',
      DiagnosticSeverity.Warning
    );
    elsewhere.code = RECEIVER_NONE_DIAGNOSTIC_CODE;
    // 行 0 是 class 头,无 self.<receiver>. 调用 → 不出
    expect(provider.provideCodeActions(
      document, elsewhere.range, { diagnostics: [elsewhere] }, undefined
    )).toEqual([]);
  });
});

describe('诊断项 code 对账面(B-7)', () => {
  it('receiver-none/段错配各自携带稳定 code,provider 与诊断同链', () => {
    const items = receiverNoneDiagnosticItems(PY_TEXT, '/avatar.py', undefined, true);
    expect(items).toHaveLength(1);
    expect(items[0].code).toBe(RECEIVER_NONE_DIAGNOSTIC_CODE);
    expect(RECEIVER_NONE_DIAGNOSTIC_CODE).toBe(RECEIVER_NONE_CODE);
  });
});
