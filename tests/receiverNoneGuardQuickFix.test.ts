import { describe, expect, it } from 'vitest';
import {
  KBEngineReceiverNoneGuardCodeActionProvider,
  RECEIVER_NONE_DIAGNOSTIC_CODE
} from '../src/languageProviders';
import {
  RECEIVER_NONE_DIAGNOSTIC_CODE as RECEIVER_NONE_CODE,
  RECEIVER_SECTION_MISMATCH_DIAGNOSTIC_CODE,
  buildReceiverNoneGuardEdit,
  buildReceiverNoneWrapEdit,
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

describe('buildReceiverNoneWrapEdit(2026-10-30 包裹式守卫纯函数)', () => {
  const WRAP_TEXT = [
    'class Avatar(kbe.KBEntity):',
    '    def onTimer(self):',
    '        self.client.onGmRes(-1)',
    '        self.client.onGmRes(-2)',
    ''
  ].join('\n');

  it('if self.client: 包住当前语句与后续同级块并整体缩进一级(空格文件)', () => {
    const edit = buildReceiverNoneWrapEdit(WRAP_TEXT, 2, 'client');
    expect(edit).toEqual({
      startLine: 2,
      endLine: 4,
      text: [
        '        if self.client:',
        '            self.client.onGmRes(-1)',
        '            self.client.onGmRes(-2)'
      ].join('\n')
    });
  });

  it('tab 文件:头行与内层全 tab,相对深度保持(同级+更深都进一级)', () => {
    const tabText = 'class Avatar:\n\tdef onTimer(self):\n\t\tself.cell.tick()\n\t\tif self.cell:\n\t\t\tself.cell.go()\n\t\tself.cell.done()\n';
    // 光标在第 2 行(0 基)= `self.cell.tick()`;块含同级 if 与更深 body,整体 +1 tab
    const edit = buildReceiverNoneWrapEdit(tabText, 2, 'cell');
    expect(edit).toEqual({
      startLine: 2,
      endLine: 6,
      text: [
        '\t\tif self.cell:',
        '\t\t\tself.cell.tick()',
        '\t\t\tif self.cell:',
        '\t\t\t\tself.cell.go()',
        '\t\t\tself.cell.done()'
      ].join('\n')
    });
  });

  it('块界=首个缩进低于使用行的行(同级/更深行都包进;块贯通到文末)', () => {
    // 使用行在 0 基行 2(`\t\t` 缩进),下一行 `\tdef g` 缩进 4 < 8 即 dedent → 块只有自己
    const oneLine = 'class A:\n\tdef f(self):\n\t\tself.client.a()\n\tdef g(self):\n\t\tpass\n';
    const edit = buildReceiverNoneWrapEdit(oneLine, 2, 'client');
    expect(edit).toEqual({
      startLine: 2,
      endLine: 3,
      text: '\t\tif self.client:\n\t\t\tself.client.a()'
    });
  });

  it('行号越界/空文本/使用行为空行 → null(不猜)', () => {
    expect(buildReceiverNoneWrapEdit(WRAP_TEXT, 99, 'client')).toBeNull();
    expect(buildReceiverNoneWrapEdit('', 0, 'client')).toBeNull();
    expect(buildReceiverNoneWrapEdit(WRAP_TEXT, 4, 'client')).toBeNull();
  });

  it('2026-10-30 用户反馈:首个不引用本 receiver 的同级语句即截断,不卷后续块', () => {
    const text = [
      'class Avatar:',
      '    def onTimer(self):',
      '        self.client.onGmRes(-1)',
      '        self.base.notify()',
      '        self.client.onGmRes(-2)',
      ''
    ].join('\n');
    const edit = buildReceiverNoneWrapEdit(text, 2, 'client');
    expect(edit).toEqual({
      startLine: 2,
      endLine: 3,
      text: '        if self.client:\n            self.client.onGmRes(-1)'
    });
  });

  it('多行续行(括号未闭合)即使续行不引用 receiver 也整段纳入', () => {
    const text = [
      'class Avatar:',
      '    def onTimer(self):',
      '        self.client.send(',
      '            "hello",',
      '            1,',
      '        )',
      '        self.base.notify()',
      ''
    ].join('\n');
    const edit = buildReceiverNoneWrapEdit(text, 2, 'client');
    expect(edit).toEqual({
      startLine: 2,
      endLine: 6,
      text: [
        '        if self.client:',
        '            self.client.send(',
        '                "hello",',
        '                1,',
        '            )'
      ].join('\n')
    });
  });

  it('续行内空行/注释不断开(括号未闭合),且照原样保留不重缩进', () => {
    // 空行与注释在 balance>0(括号未闭合)窗口内:语句组继续,body 里该两行
    // 原样返回(不加一级缩进),其余续行仍整体 +1 级。
    const text = [
      'class Avatar:',
      '    def onTimer(self):',
      '        self.client.send(',
      '            "hello",',
      '            # mid comment',
      '',
      '            1,',
      '        )',
      '        self.base.notify()',
      ''
    ].join('\n');
    const edit = buildReceiverNoneWrapEdit(text, 2, 'client');
    expect(edit).toEqual({
      startLine: 2,
      endLine: 8,
      text: [
        '        if self.client:',
        '            self.client.send(',
        '                "hello",',
        '            # mid comment',
        '',
        '                1,',
        '            )'
      ].join('\n')
    });
  });
});

describe('KBEngineReceiverNoneGuardCodeActionProvider(B-7)', () => {
  const provider = new KBEngineReceiverNoneGuardCodeActionProvider();

  it('receiver-none 诊断 → 两条 QuickFix:包裹式(首选靠前)+早退式(次选),不碰其他文件', () => {
    const document = pyDocument();
    const diagnostic = receiverNoneDiagnostic();
    const actions = provider.provideCodeActions(
      document,
      diagnostic.range,
      { diagnostics: [diagnostic] },
      undefined
    )!;

    // 2026-10-30 用户令:包裹式(`if self.client:` 包住后续块继续执行)是常见
    // 操作,排在早退式之前;两条都是 QuickFix,同码同诊断
    expect(actions).toHaveLength(2);
    const wrapAction = actions[0];
    const guardAction = actions[1];
    expect(wrapAction.title).toContain('包裹判空守卫');
    expect(wrapAction.title).toContain('if self.client:');
    expect(guardAction.title).toContain('插入 None 守卫');
    for (const action of [wrapAction, guardAction]) {
      expect(action.kind).toBe(CodeActionKind.QuickFix);
      expect(action.diagnostics).toEqual([diagnostic]);
      expect(action.command).toBeUndefined();
      const entries = action.edit!.entries();
      expect(entries).toHaveLength(1);
      const [uri] = entries[0];
      expect(uri.toString()).toBe(document.uri.toString());
    }

    // 包裹式:替换 [行 2,行 3)(块=唯一使用行),整体 +1 级缩进
    const [wrapUri, wrapEdits] = wrapAction.edit!.entries()[0];
    expect(wrapUri.toString()).toBe(document.uri.toString());
    expect(wrapEdits).toHaveLength(1);
    expect(wrapEdits[0].range.start).toEqual(new Position(2, 0));
    expect(wrapEdits[0].range.end).toEqual(new Position(3, 0));
    expect(wrapEdits[0].newText).toBe(
      '        if self.client:\n            self.client.onGmRes(-1)\n'
    );

    // 早退式:插入点=使用行行首(0 基行 2 列 0),插入文本含早退守卫两行
    const [, guardEdits] = guardAction.edit!.entries()[0];
    expect(guardEdits).toHaveLength(1);
    expect(guardEdits[0].range.start).toEqual(new Position(2, 0));
    expect(guardEdits[0].range.end).toEqual(new Position(2, 0));
    expect(guardEdits[0].newText).toBe('        if not self.client:\n            return\n');
  });

  it('同码双诊断(同行两处调用)去重只出两条(包裹+早退各一);段错配码/无码诊断不出', () => {
    const document = pyDocument();
    const first = receiverNoneDiagnostic();
    const second = receiverNoneDiagnostic();
    // 同行同码去重:包裹+早退各一条,不会 4 条
    const actions = provider.provideCodeActions(
      document, first.range, { diagnostics: [first, second] }, undefined
    );
    expect(actions).toHaveLength(2);
    expect(actions[0].title).toContain('包裹判空守卫');
    expect(actions[1].title).toContain('插入 None 守卫');

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
