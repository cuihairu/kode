import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

// IDE-ACC-013:未保存编辑与放弃编辑的导航验收(真实编辑器,真实编辑手势)。
// DirtyEntity 单段:BaseMethods <onSpin>,实现在 scripts/base/DirtyEntity.py,
// 磁盘形位 def onSpin 固定 0 基第 3 行。会话启动即入索引(基线先证命中),
// 套件本体依次:
// ①开实现文档编辑器+顶部插 5 行(不保存=脏缓冲,方法挪到第 8 行);
// ②def→python F12 于 <onSpin> 必须落缓冲新行(编辑时跳到脏缓冲区位置),
//   同时反向 python→def F12 从脏缓冲实现仍命中 def(脏缓冲不断双向链);
// ③宿主 revert+关闭(放弃修改并关闭,真实手势)后,def→python F12
//   恢复磁盘行。
// 证据行落 KODE_ACC13_OUT(缺省 docs/perf/2026-10-29-acc013-dirty-nav-run.txt)。

const ROOT = process.env.KODE_DIRTY_ROOT;
assert.ok(ROOT, 'runTest.js --dirty must set KODE_DIRTY_ROOT');
const OUT_FILE = process.env.KODE_ACC13_OUT
  ?? path.resolve(__dirname, '../../../../docs/perf/2026-10-29-acc013-dirty-nav-run.txt');

const DEF_PATH = path.join(ROOT!, 'scripts', 'entity_defs', 'DirtyEntity.def');
const SCRIPT_PATH = path.join(ROOT!, 'scripts', 'base', 'DirtyEntity.py');
const ON_SPIN_DISK_LINE = 3;
const INSERTED_LINES = 5;
const ON_SPIN_DIRTY_LINE = ON_SPIN_DISK_LINE + INSERTED_LINES;

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** 行锚+符号双定位(与 field 系列同口径) */
function symbolPosition(lines: string[], needle: string, symbol: string): vscode.Position {
  const line = lines.findIndex(text => text.includes(needle));
  assert.ok(line >= 0, `夹具缺行: ${needle}`);
  return new vscode.Position(line, lines[line].indexOf(symbol) + Math.floor(symbol.length / 2));
}

async function definitionsAt(
  uri: vscode.Uri, position: vscode.Position
): Promise<vscode.Location[]> {
  const raw = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', uri, position);
  return (Array.isArray(raw) ? raw : []) as vscode.Location[];
}

describe('IDE-ACC-013:未保存编辑与放弃编辑的导航(真实编辑器)', () => {
  before(async () => {
    const extension = vscode.extensions.getExtension('cuihairu.kode-kbengine');
    assert.ok(extension, 'Kode extension is unavailable in the extension host');
    await extension.activate();
    assert.ok(fs.existsSync(DEF_PATH), 'def 夹具缺失');
    assert.ok(fs.existsSync(SCRIPT_PATH), '实现夹具缺失');
  });

  it('脏缓冲期 F12 落缓冲新行,revert 关闭后恢复磁盘行', async function () {
    this.timeout(120_000);
    const defUri = vscode.Uri.file(DEF_PATH);
    const scriptUri = vscode.Uri.file(SCRIPT_PATH);
    const defDocument = await vscode.workspace.openTextDocument(defUri);
    const defLines = defDocument.getText().split('\n');
    const onSpinPosition = symbolPosition(defLines, '<onSpin>', 'onSpin');

    // ①基线:实现文档未打开(导航读取走磁盘直读面),F12 落磁盘行
    const baseline = await definitionsAt(defUri, onSpinPosition);
    assert.ok(
      baseline.some(loc => loc.uri.fsPath === SCRIPT_PATH
        && loc.range.start.line === ON_SPIN_DISK_LINE),
      `基线 F12 未落磁盘行 ${ON_SPIN_DISK_LINE}: ${baseline.map(l => `${l.uri.fsPath}:${l.range.start.line}`).join(',')}`
    );

    // ②开编辑器+顶部插 5 行(不保存):脏缓冲把方法挪到第 8 行
    const pyEditor = await vscode.window.showTextDocument(scriptUri, {
      viewColumn: vscode.ViewColumn.One, preview: false
    });
    const insertEdit = new vscode.WorkspaceEdit();
    insertEdit.insert(scriptUri, new vscode.Position(0, 0), [
      '# dirty buffer: five inserted lines shift the method definition.',
      '# line 2',
      '# line 3',
      '# line 4',
      '# line 5'
    ].join('\n') + '\n');
    const applied = await vscode.workspace.applyEdit(insertEdit);
    assert.ok(applied, '脏缓冲编辑未应用');
    assert.ok(pyEditor.document.isDirty, '编辑后缓冲不是脏态(未保存前提不成立)');
    const bufferLines = pyEditor.document.getText().split('\n');
    const bufferOnSpinLine = bufferLines.findIndex(text => text.includes('def onSpin'));
    assert.strictEqual(
      bufferOnSpinLine, ON_SPIN_DIRTY_LINE,
      `脏缓冲内方法行应为 ${ON_SPIN_DIRTY_LINE},实得 ${bufferOnSpinLine}`
    );

    // ③脏缓冲面:def→python F12 落缓冲新行(编辑时跳到脏缓冲区位置)
    const dirtyDef = await definitionsAt(defUri, onSpinPosition);
    assert.ok(
      dirtyDef.some(loc => loc.uri.fsPath === SCRIPT_PATH
        && loc.range.start.line === ON_SPIN_DIRTY_LINE),
      `脏缓冲期 F12 未落缓冲行 ${ON_SPIN_DIRTY_LINE}: ${dirtyDef.map(l => `${l.uri.fsPath}:${l.range.start.line}`).join(',')}`
    );
    assert.ok(
      !dirtyDef.some(loc => loc.range.start.line === ON_SPIN_DISK_LINE),
      '脏缓冲期 F12 仍落磁盘旧行(落点读取没走缓冲)'
    );
    // 反向不牵连:脏缓冲实现侧 python→def F12 仍命中 def
    const onSpinImplPosition = symbolPosition(bufferLines, 'def onSpin', 'onSpin');
    const dirtyReverse = await definitionsAt(scriptUri, onSpinImplPosition);
    assert.ok(
      dirtyReverse.some(loc => loc.uri.fsPath === DEF_PATH),
      '脏缓冲期 python→def F12 未命中 def(脏缓冲断双向链)'
    );

    // ④放弃修改并关闭(真实宿主手势):revert 活动编辑器 → 关闭
    await vscode.window.showTextDocument(pyEditor.document, {
      viewColumn: vscode.ViewColumn.One, preview: false
    });
    await vscode.commands.executeCommand('workbench.action.files.revert');
    assert.ok(!pyEditor.document.isDirty, 'revert 后缓冲仍是脏态(放弃修改不成立)');
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    await sleep(300);

    // ⑤恢复面:def→python F12 恢复磁盘行
    const afterRevert = await definitionsAt(defUri, onSpinPosition);
    assert.ok(
      afterRevert.some(loc => loc.uri.fsPath === SCRIPT_PATH
        && loc.range.start.line === ON_SPIN_DISK_LINE),
      `revert 关闭后 F12 未恢复磁盘行 ${ON_SPIN_DISK_LINE}: ${afterRevert.map(l => `${l.uri.fsPath}:${l.range.start.line}`).join(',')}`
    );

    const evidence = [
      `acc013.baseline.defLine=${baseline.find(loc => loc.uri.fsPath === SCRIPT_PATH)?.range.start.line}`,
      `acc013.dirty.isDirty=${pyEditor.document.isDirty === false ? 'reverted' : 'still-dirty'}`,
      `acc013.dirty.bufferOnSpinLine=${bufferOnSpinLine}`,
      `acc013.dirty.defLine=${dirtyDef.find(loc => loc.uri.fsPath === SCRIPT_PATH)?.range.start.line}`,
      `acc013.dirty.reverseHitsDef=${dirtyReverse.some(loc => loc.uri.fsPath === DEF_PATH)}`,
      `acc013.afterRevert.defLine=${afterRevert.find(loc => loc.uri.fsPath === SCRIPT_PATH)?.range.start.line}`
    ];
    fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
    fs.writeFileSync(OUT_FILE, evidence.join('\n') + '\n', 'utf8');
    console.log('[acc013] evidence:\n' + evidence.join('\n'));
  });
});
