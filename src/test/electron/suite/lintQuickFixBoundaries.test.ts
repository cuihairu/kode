import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

// IDE-LINT-012:receiver-none 快速修复的语法/语义边界在真实 VS Code 应用验收。
// 单元面(tests/receiverNoneGuardQuickFix.test.ts)用替身;本套件在真编辑器里
// 走 publishDiagnostics → executeCodeActionProvider → applyEdit 全链,验收
// 验收原文的五条边界:
//   ① 多行调用(括号未闭合续行)整体纳入包裹,续行不重缩进错乱;
//   ② 同一行两个不同 receiver——每个诊断各得各的守卫,不把第一个 receiver
//      的修复套给第二个(区间归属提取);
//   ③ EOF(末行使用,无尾换行)应用不报错,守卫/包裹文本正确落位;
//   ④ 同级后续语句与缩进:包裹把同级+更深行整体进一级,首个不引用本
//      receiver 的同级语句即截断;
//   ⑤ 不无提示改动无关后续逻辑:无关行逐字节不变。
// 证据行落 KODE_LINTFIX_OUT(缺省 docs/perf/2026-11-06-lint-quickfix-boundaries-run.txt)。

const WORKSPACE = process.env.KODE_FIELD_WORKSPACE;
assert.ok(WORKSPACE, 'runTest.js --lintfix must set KODE_FIELD_WORKSPACE');
const WS: string = WORKSPACE;
const OUT_FILE = process.env.KODE_LINTFIX_OUT
  ?? path.resolve(__dirname, '../../../../docs/perf/2026-11-06-lint-quickfix-boundaries-run.txt');

const RECEIVER_NONE_CODE = 'kbengine.receiverNone';
const waitMs = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

const logLine = (line: string): void => {
  fs.appendFileSync(OUT_FILE, `${line}\n`);
};

/** 写夹具文件到工作区并打开,轮询等 receiver-none 诊断发布(超时抛错) */
async function openWithDiagnostics(
  rel: string,
  content: string
): Promise<{ doc: vscode.TextDocument; diags: vscode.Diagnostic[] }> {
  const filePath = path.join(WS, rel);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  const doc = await vscode.workspace.openTextDocument(filePath);
  await vscode.window.showTextDocument(doc);
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const diags = vscode.languages.getDiagnostics(doc.uri)
      .filter(d => d.code === RECEIVER_NONE_CODE);
    if (diags.length > 0) {
      return { doc, diags };
    }
    await waitMs(200);
  }
  throw new Error(`receiver-none 诊断未发布: ${rel}`);
}

/** 取某诊断区间处可用的守卫动作(按标题关键词过滤,只认本 provider 产物) */
async function guardActions(
  doc: vscode.TextDocument,
  range: vscode.Range,
  keyword: 'Wrap' | 'Insert'
): Promise<vscode.CodeAction[]> {
  const all = await vscode.commands.executeCommand<Array<vscode.CodeAction | vscode.Command>>(
    'vscode.executeCodeActionProvider', doc.uri, range, 'quickfix'
  );
  const actions = all.filter((a): a is vscode.CodeAction =>
    'title' in a && a.title.includes(keyword));
  return actions;
}

/** 应用某动作的编辑并返回结果文本 */
async function applyAndRead(
  doc: vscode.TextDocument,
  action: vscode.CodeAction
): Promise<{ applied: boolean; text: string }> {
  const edit = action.edit;
  assert.ok(edit, '动作必须带 WorkspaceEdit');
  const applied = await vscode.workspace.applyEdit(edit);
  const text = doc.getText();
  return { applied, text };
}

describe('IDE-LINT-012 receiver-none 快速修复边界(真实 VS Code)', () => {
  before(() => {
    fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
    fs.appendFileSync(OUT_FILE, `\n=== IDE-LINT-012 quick-fix boundaries ${new Date().toISOString()} ===\n`);
  });

  it('① 多行调用(括号未闭合续行)整体纳入包裹,续行不重缩进错乱;⑤ 无关行逐字节不变', async () => {
    const rel = 'scripts/common/training/lintfix_case_multiline.py';
    const content = [
      'class A:',
      '    def f(self):',
      '        self.client.send(',
      '            "hello",',
      '            1,',
      '        )',
      '        self.base.notify()',
      ''
    ].join('\n');
    const { doc, diags } = await openWithDiagnostics(rel, content);
    const sendDiag = diags.find(d => d.range.start.line === 2);
    assert.ok(sendDiag, 'self.client.send 应有诊断');
    const wraps = await guardActions(doc, sendDiag.range, 'Wrap');
    assert.strictEqual(wraps.length, 1, '应恰有一条包裹动作');
    assert.ok(wraps[0].title.includes('if self.client:'), `动作应守卫 client: ${wraps[0].title}`);
    const { applied, text } = await applyAndRead(doc, wraps[0]);
    assert.ok(applied, '多行包裹 applyEdit 必须成功');
    const expected = [
      'class A:',
      '    def f(self):',
      '        if self.client:',
      '            self.client.send(',
      '                "hello",',
      '                1,',
      '            )',
      '        self.base.notify()',
      ''
    ].join('\n');
    assert.strictEqual(text, expected, '多行调用包裹后文本必须精确等于期望');
    logLine(`lintfix.multiline=applied ok; unrelated-line "${'        self.base.notify()'}" unchanged`);
  });

  it('② 同一行两个不同 receiver:每个诊断各得各的守卫,不把第一个套给第二个', async () => {
    const rel = 'scripts/common/training/lintfix_case_sameline.py';
    const content = [
      'class A:',
      '    def f(self):',
      '        self.cell.a(); self.client.b()',
      ''
    ].join('\n');
    const { doc, diags } = await openWithDiagnostics(rel, content);
    const aDiag = diags.find(d => d.range.start.character === 18);
    const bDiag = diags.find(d => d.range.start.character === 35);
    assert.ok(aDiag && bDiag, `应有两处诊断(anchor 18/35),实得 ${diags.map(d => d.range.start.character)}`);

    // a 的诊断(cell 调用)区间 → 只有 cell 守卫,不含 client
    const aWraps = await guardActions(doc, aDiag.range, 'Wrap');
    assert.strictEqual(aWraps.length, 1);
    assert.ok(aWraps[0].title.includes('if self.cell:'), `a 应守卫 cell: ${aWraps[0].title}`);
    assert.ok(!aWraps[0].title.includes('client'), 'a 的动作不得引用 client');

    // b 的诊断(client 调用)区间 → 只有 client 守卫,不含 cell
    const bWraps = await guardActions(doc, bDiag.range, 'Wrap');
    assert.strictEqual(bWraps.length, 1);
    assert.ok(bWraps[0].title.includes('if self.client:'), `b 应守卫 client: ${bWraps[0].title}`);
    assert.ok(!bWraps[0].title.includes('cell'), 'b 的动作不得引用 cell');

    // 整行上下文 → 两个 receiver 各两条(包裹+早退),共 4 条,各带各的守卫
    const wholeLine = doc.lineAt(2).range;
    const all = await vscode.commands.executeCommand<Array<vscode.CodeAction | vscode.Command>>(
      'vscode.executeCodeActionProvider', doc.uri, wholeLine, 'quickfix'
    );
    const cellActions = all.filter((a): a is vscode.CodeAction =>
      'title' in a && a.title.includes('self.cell'));
    const clientActions = all.filter((a): a is vscode.CodeAction =>
      'title' in a && a.title.includes('self.client'));
    assert.strictEqual(cellActions.length, 2, 'cell 应有两动作(包裹+早退)');
    assert.strictEqual(clientActions.length, 2, 'client 应有两动作(包裹+早退)');
    logLine(`lintfix.sameline=cell actions ${cellActions.length}, client actions ${clientActions.length}, no cross-attribution`);
  });

  it('③ EOF(末行使用,无尾换行):包裹应用不报错,文本正确落位', async () => {
    const rel = 'scripts/common/training/lintfix_case_eof.py';
    const content = [
      'class A:',
      '    def f(self):',
      '        self.client.last()'
    ].join('\n');
    const { doc, diags } = await openWithDiagnostics(rel, content);
    const diag = diags.find(d => d.range.start.line === 2);
    assert.ok(diag, 'EOF 行应有诊断');
    const wraps = await guardActions(doc, diag.range, 'Wrap');
    assert.strictEqual(wraps.length, 1);
    const { applied, text } = await applyAndRead(doc, wraps[0]);
    assert.ok(applied, 'EOF 包裹 applyEdit 必须成功(位置不得越界)');
    const expected = [
      'class A:',
      '    def f(self):',
      '        if self.client:',
      '            self.client.last()'
    ].join('\n');
    assert.strictEqual(text, expected, 'EOF 包裹后文本必须精确等于期望(无尾换行)');
    logLine('lintfix.eof=wrap applied ok, no trailing newline, position in-bounds');
  });

  it('③b EOF 早退守卫:插入落位,尾换行保持无', async () => {
    const rel = 'scripts/common/training/lintfix_case_eof_guard.py';
    const content = [
      'class A:',
      '    def f(self):',
      '        self.client.last()'
    ].join('\n');
    const { doc, diags } = await openWithDiagnostics(rel, content);
    const diag = diags.find(d => d.range.start.line === 2);
    assert.ok(diag);
    const guards = await guardActions(doc, diag.range, 'Insert');
    assert.strictEqual(guards.length, 1);
    const { applied, text } = await applyAndRead(doc, guards[0]);
    assert.ok(applied, 'EOF 早退插入 applyEdit 必须成功');
    const expected = [
      'class A:',
      '    def f(self):',
      '        if not self.client:',
      '            return',
      '        self.client.last()'
    ].join('\n');
    assert.strictEqual(text, expected, 'EOF 早退守卫插入文本必须精确等于期望');
    logLine('lintfix.eof.guard=insert applied ok');
  });

  it('④ 同级后续语句与缩进:包裹同级+更深行整体进一级,首个不引用本 receiver 的同级语句即截断;⑤ 无关行不变', async () => {
    const rel = 'scripts/common/training/lintfix_case_siblings.py';
    const content = [
      'class A:',
      '    def f(self):',
      '        self.client.a()',
      '        self.client.b()',
      '        if self.client:',
      '            self.client.c()',
      '        self.base.other()',
      ''
    ].join('\n');
    const { doc, diags } = await openWithDiagnostics(rel, content);
    const aDiag = diags.find(d => d.range.start.line === 2);
    assert.ok(aDiag, 'self.client.a 应有诊断');
    const wraps = await guardActions(doc, aDiag.range, 'Wrap');
    assert.strictEqual(wraps.length, 1);
    const { applied, text } = await applyAndRead(doc, wraps[0]);
    assert.ok(applied, '同级块包裹 applyEdit 必须成功');
    // 块=self.client.a/b + 同级 if self.client: 及其更深 body(全部引用 client);
    // self.base.other() 是首个不引用 client 的同级语句 → 截断,不卷进去
    const expected = [
      'class A:',
      '    def f(self):',
      '        if self.client:',
      '            self.client.a()',
      '            self.client.b()',
      '            if self.client:',
      '                self.client.c()',
      '        self.base.other()',
      ''
    ].join('\n');
    assert.strictEqual(text, expected, '同级块包裹必须精确截断于无关语句前');
    logLine('lintfix.siblings=wrap truncated before self.base.other(); unrelated line unchanged');
  });
});
