import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

// KSEM-CELL-15:未保存 def 编辑的 cellData 全链验收(真实编辑器+真实 Rust 门)。
// 根 A ChainEntity 经 Parent(ChainBase)/接口(ROLE)/组件槽(BagBox)三边供给键
// 宇宙;根 B 同名实体只带 alien 键(跨根负例)。夹具按角色分工:base 侧只读
// (无动态键写入 → 世界封闭,未声明键的错键「确认」诊断才成立——开放世界
// 语义下缺失不可证),cell 侧承载 self.cellData["bonus"]="x" 动态写入(写入
// 类型面的靶点,该面不受世界开闭影响)。套件本体:
// ①基线:五面按磁盘 def 口径工作(补全三边键齐/跨根隔离/inlay 键型/F12 内建
//   面;错键诊断点名 bonus+ghost,根 B 点名 gold;写入面无 bonus);
// ②真实编辑手势:打开根 A 实体 def,在 Properties 内插入 bonus 属性,不保存;
// ③五面联动:补全/F12(落脏缓冲行)/inlay(含别名面)/hover/错键+写入类型
//   诊断一起反映未保存内容——诊断输入代失效后同版本 python 文档强制重算。
// 证据行落 KODE_CELLDATA_OUT(缺省 docs/perf/2026-11-12-cell15-fullchain-run.txt)。

const ROOT = process.env.KODE_CELLDATA_ROOT;
const ROOT_A = process.env.KODE_CELLDATA_ROOT_A;
const ROOT_B = process.env.KODE_CELLDATA_ROOT_B;
assert.ok(ROOT && ROOT_A && ROOT_B, 'runTest.js --celldata must stage KODE_CELLDATA_ROOT*');
const OUT_FILE = process.env.KODE_CELLDATA_OUT
  ?? path.resolve(__dirname, '../../../../docs/perf/2026-11-12-cell15-fullchain-run.txt');

const DEF_PATH = path.join(ROOT_A!, 'scripts', 'entity_defs', 'ChainEntity.def');
const BASE_PATH = path.join(ROOT_A!, 'scripts', 'base', 'ChainEntity.py');
const CELL_PATH = path.join(ROOT_A!, 'scripts', 'cell', 'ChainEntity.py');
const BASE_B_PATH = path.join(ROOT_B!, 'scripts', 'base', 'ChainEntity.py');

const WRONG_KEY_CODE = 'kbengine.cellDataWrongKey';
const WRITE_TYPE_CODE = 'kbengine.cellDataWriteType';

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** 脏缓冲/磁盘同一份逐行夹具;symbolPosition 双定位(与 field 系列同口径)。 */
function symbolPosition(lines: string[], needle: string, symbol: string): vscode.Position {
  const line = lines.findIndex(text => text.includes(needle));
  assert.ok(line >= 0, `夹具缺行: ${needle}`);
  return new vscode.Position(line, lines[line].indexOf(symbol) + Math.floor(symbol.length / 2));
}

async function completionsAt(uri: vscode.Uri, position: vscode.Position): Promise<string[]> {
  const raw = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', uri, position);
  const items = (Array.isArray(raw) ? raw : (raw as { items?: unknown[] })?.items ?? []) as Array<{ label: unknown }>;
  return items.map(item => typeof item.label === 'string' ? item.label : (item.label as { label?: string })?.label ?? '');
}

async function inlayLabelsAt(uri: vscode.Uri, range: vscode.Range): Promise<string[]> {
  const raw = await vscode.commands.executeCommand('vscode.executeInlayHintProvider', uri, range);
  return ((Array.isArray(raw) ? raw : []) as Array<{ label: unknown }>)
    .map(hint => typeof hint.label === 'string' ? hint.label : (hint.label as Array<{ value?: string }>).map(part => part.value ?? '').join(''));
}

async function definitionsAt(uri: vscode.Uri, position: vscode.Position): Promise<vscode.Location[]> {
  const raw = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', uri, position);
  return (Array.isArray(raw) ? raw : []) as vscode.Location[];
}

async function hoverAt(uri: vscode.Uri, position: vscode.Position): Promise<string> {
  const raw = await vscode.commands.executeCommand('vscode.executeHoverProvider', uri, position);
  const hovers = (Array.isArray(raw) ? raw : []) as Array<{ contents: unknown }>;
  const parts: string[] = [];
  for (const hover of hovers) {
    const contents = Array.isArray(hover.contents) ? hover.contents : [hover.contents];
    for (const content of contents) {
      if (content && typeof content === 'object' && 'value' in content) {
        parts.push((content as { value: string }).value);
      } else if (typeof content === 'string') {
        parts.push(content);
      }
    }
  }
  return parts.join('\n');
}

function cellDataDiagnostics(uri: vscode.Uri): vscode.Diagnostic[] {
  return vscode.languages.getDiagnostics(uri).filter(
    diagnostic => diagnostic.code === WRONG_KEY_CODE || diagnostic.code === WRITE_TYPE_CODE
  );
}

/** 轮询直至谓词成立(cellData 诊断经 queued 调度+Rust RPC,非同步发布)。 */
async function waitForDiagnostics(
  uri: vscode.Uri,
  predicate: (items: vscode.Diagnostic[]) => boolean,
  label: string
): Promise<vscode.Diagnostic[]> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const items = cellDataDiagnostics(uri);
    if (predicate(items)) {
      return items;
    }
    await sleep(200);
  }
  const dump = cellDataDiagnostics(uri)
    .map(item => `${item.code}:${item.range.start.line}:${item.message}`)
    .join(' | ');
  assert.fail(`诊断未在预算内达成(${label});现况: ${dump || '(空)'}`);
}

const codesAt = (items: vscode.Diagnostic[]): string[] => items.map(item => String(item.code));

describe('KSEM-CELL-15:未保存 def 编辑的 cellData 全链(真实编辑器)', () => {
  before(async () => {
    const extension = vscode.extensions.getExtension('cuihairu.kode-kbengine');
    assert.ok(extension, 'Kode extension is unavailable in the extension host');
    await extension.activate();
    for (const file of [DEF_PATH, BASE_PATH, CELL_PATH, BASE_B_PATH]) {
      assert.ok(fs.existsSync(file), `夹具缺失: ${file}`);
    }
    const folders = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);
    console.log('[cell15] workspaceFolders:', JSON.stringify(folders));
    const gateReport = await vscode.commands.executeCommand('kbengine.core.showShadowDiffLog');
    if (typeof gateReport === 'string') {
      console.log('[cell15] gate:', gateReport);
    }
  });

  it('未保存 def 插入属性后,补全/F12/inlay/hover/诊断一起更新', async function () {
    this.timeout(180_000);
    const defUri = vscode.Uri.file(DEF_PATH);
    const baseUri = vscode.Uri.file(BASE_PATH);
    const cellUri = vscode.Uri.file(CELL_PATH);
    const baseBUri = vscode.Uri.file(BASE_B_PATH);

    const baseDocument = await vscode.workspace.openTextDocument(baseUri);
    const cellDocument = await vscode.workspace.openTextDocument(cellUri);
    const baseBDocument = await vscode.workspace.openTextDocument(baseBUri);
    const baseLines = baseDocument.getText().split('\n');
    // F12 靶点走直读行(CELL-05 跳转面只认 self.cellData 直读,别名行不覆盖)
    const dupRead = symbolPosition(baseLines, 'dup = self.cellData["bonus"]', 'bonus');
    const ghostLine = baseLines.findIndex(text => text.includes('ghost = self.cellData["ghost"]'));
    assert.ok(ghostLine >= 0, '夹具缺 ghost 行');

    // ①基线(磁盘 def):错键诊断点名 bonus(未知)+ ghost;写入类型不点名 bonus
    await waitForDiagnostics(
      baseUri,
      items => {
        const wrong = items.filter(item => item.code === WRONG_KEY_CODE);
        return wrong.some(item => item.message.includes('bonus')) && wrong.some(item => item.message.includes('ghost'));
      },
      '基线错键点名 bonus+ghost'
    );
    assert.ok(
      !cellDataDiagnostics(baseUri).some(item => item.code === WRITE_TYPE_CODE && item.message.includes('bonus')),
      '基线(base 无写入)不应出写入类型诊断'
    );
    assert.ok(
      !cellDataDiagnostics(cellUri).some(item => item.code === WRITE_TYPE_CODE && item.message.includes('bonus')),
      '基线(键宇宙无 bonus)cell 写入不应出写入类型诊断'
    );

    // ①基线:根 B 跨根负例——alien 自洽,gold(根 A 键)在根 B 是错键
    await waitForDiagnostics(
      baseBUri,
      items => items.some(item => item.code === WRONG_KEY_CODE && item.message.includes('gold')),
      '根 B 错键点名 gold'
    );

    // ①基线:inlay 键型按磁盘 def(继承键 mana UINT16),bonus 无提示(能推才显)
    const baseAllRange = new vscode.Range(new vscode.Position(0, 0), new vscode.Position(baseLines.length, 0));
    const baseInlayBaseline = await inlayLabelsAt(baseUri, baseAllRange);
    assert.ok(
      baseInlayBaseline.some(label => label.includes('mana') || label.includes('UINT16')) ||
      baseInlayBaseline.some(label => label.includes('UINT16')),
      `基线 inlay 未含继承键 UINT16 型: ${baseInlayBaseline.join(',')}`
    );

    // ①基线:补全三边键齐(自身 gold/继承 mana/接口 roleRank/组件槽 bag),
    // 不含根 B 的 alien,也不含尚未声明的 bonus
    const keyQuote = baseLines.findIndex(text => text.includes('total = self.cellData["gold"]'));
    assert.ok(keyQuote >= 0, '夹具缺 total 行');
    const keyPosition = new vscode.Position(keyQuote, baseLines[keyQuote].indexOf('"gold"') + 1);
    const baselineKeys = await completionsAt(baseUri, keyPosition);
    for (const expected of ['gold', 'mana', 'roleRank', 'bag']) {
      assert.ok(baselineKeys.includes(expected), `基线补全缺 ${expected}: ${baselineKeys.join(',')}`);
    }
    assert.ok(!baselineKeys.includes('alien'), `跨根负例失败:根 A 补全混入根 B 的 alien: ${baselineKeys.join(',')}`);
    assert.ok(!baselineKeys.includes('bonus'), `基线补全不应含未声明 bonus: ${baselineKeys.join(',')}`);

    // 根 B 补全含 alien、不含根 A 的 gold(反向隔离)
    const linesB = baseBDocument.getText().split('\n');
    const alienQuote = linesB.findIndex(text => text.includes('value = self.cellData["alien"]'));
    const alienPosition = new vscode.Position(alienQuote, linesB[alienQuote].indexOf('"alien"') + 1);
    const keysB = await completionsAt(baseBUri, alienPosition);
    assert.ok(keysB.includes('alien'), `根 B 补全缺 alien: ${keysB.join(',')}`);
    assert.ok(!keysB.includes('gold'), `跨根负例失败:根 B 补全混入根 A 的 gold: ${keysB.join(',')}`);

    // ②真实编辑手势:打开根 A 实体 def,Properties 内插入 bonus,不保存
    const defDocument = await vscode.workspace.openTextDocument(defUri);
    const defEditor = await vscode.window.showTextDocument(defDocument, {
      viewColumn: vscode.ViewColumn.One, preview: false
    });
    const diskLines = defDocument.getText().split('\n');
    const propsClose = diskLines.findIndex(text => text.trim() === '</Properties>');
    assert.ok(propsClose > 0, '夹具缺 </Properties> 行');
    const insertEdit = new vscode.WorkspaceEdit();
    insertEdit.insert(defUri, new vscode.Position(propsClose, 4), [
      '<bonus>',
      '    <Type>UINT8</Type>',
      '    <Flags>CELL_PUBLIC</Flags>',
      '</bonus>',
      ''
    ].join('\n'));
    assert.ok(await vscode.workspace.applyEdit(insertEdit), '未保存 def 编辑未应用');
    assert.ok(defEditor.document.isDirty, '编辑后 def 缓冲不是脏态(未保存前提不成立)');
    const dirtyLines = defEditor.document.getText().split('\n');
    const bonusDefLine = dirtyLines.findIndex(text => text.includes('<bonus>'));
    assert.ok(bonusDefLine > 0, '脏缓冲缺 <bonus> 行');

    // ③补全面:未保存 bonus 进键宇宙,跨根隔离不变
    const dirtyKeys = await completionsAt(baseUri, keyPosition);
    assert.ok(dirtyKeys.includes('bonus'), `未保存编辑后补全缺 bonus: ${dirtyKeys.join(',')}`);
    assert.ok(!dirtyKeys.includes('alien'), `未保存编辑后跨根负例失败: ${dirtyKeys.join(',')}`);

    // ③F12 面:bonus 键跳转落脏缓冲声明行(键宇宙供给文本=脏缓冲)
    const dupKeyPosition = new vscode.Position(dupRead.line, dupRead.character);
    const dirtyDefs = await definitionsAt(baseUri, dupKeyPosition);
    assert.ok(
      dirtyDefs.some(loc => loc.uri.fsPath === DEF_PATH && loc.range.start.line === bonusDefLine),
      `F12 未落脏缓冲 bonus 行 ${bonusDefLine}: ${dirtyDefs.map(l => `${l.uri.fsPath}:${l.range.start.line}`).join(',')}`
    );

    // ③inlay 面:读取型(含别名面)按未保存声明出 UINT8
    const baseInlay = await inlayLabelsAt(baseUri, baseAllRange);
    assert.ok(
      baseInlay.some(label => label.includes('UINT8')),
      `未保存编辑后 inlay 缺 UINT8(bonus 读取型): ${baseInlay.join(',')}`
    );

    // ③hover 面:生命周期注记键集含未保存 bonus
    const cellLines = cellDocument.getText().split('\n');
    const cellDataToken = symbolPosition(cellLines, 'data = self.cellData', 'cellData');
    const hoverText = await hoverAt(cellUri, cellDataToken);
    assert.ok(hoverText.includes('bonus'), `hover 键集未含未保存 bonus: ${hoverText.slice(0, 400)}`);

    // ③诊断面:错键 bonus 消失(键宇宙收编)+ cell 侧写入类型出现(str→UINT8);
    // ghost(始终未知)不消失;python 文档全程未编辑(同版本强制重算)。
    const postWrong = await waitForDiagnostics(
      baseUri,
      items => {
        const wrong = items.filter(item => item.code === WRONG_KEY_CODE);
        return !wrong.some(item => item.message.includes('bonus')) && wrong.some(item => item.message.includes('ghost'));
      },
      '错键 bonus 收编且 ghost 保留'
    );
    assert.ok(
      !postWrong.some(item => item.message.includes('bonus')),
      '错键 bonus 未被收编'
    );
    await waitForDiagnostics(
      cellUri,
      items => items.some(item => item.code === WRITE_TYPE_CODE && item.message.includes('bonus')),
      '写入类型诊断点名 bonus'
    );

    // 证据行(真机全链取证)
    const evidence = [
      `cell15.baseline.wrongKeys=${codesAt(cellDataDiagnostics(baseUri)).filter(code => code === WRONG_KEY_CODE).length}`,
      `cell15.dirty.bonusDefLine=${bonusDefLine}`,
      `cell15.dirty.completionHasBonus=${dirtyKeys.includes('bonus')}`,
      `cell15.dirty.f12Line=${dirtyDefs.find(loc => loc.uri.fsPath === DEF_PATH)?.range.start.line}`,
      `cell15.dirty.inlayHasUINT8=${baseInlay.some(label => label.includes('UINT8'))}`,
      `cell15.dirty.hoverHasBonus=${hoverText.includes('bonus')}`,
      `cell15.dirty.wrongKeyBonusGone=${!cellDataDiagnostics(baseUri).some(item => item.code === WRONG_KEY_CODE && item.message.includes('bonus'))}`,
      `cell15.dirty.writeTypeBonus=${cellDataDiagnostics(cellUri).some(item => item.code === WRITE_TYPE_CODE && item.message.includes('bonus'))}`,
      `cell15.crossRoot.bCompletions=${keysB.filter(key => key === 'alien' || key === 'gold').join(',')}`
    ];
    fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
    fs.writeFileSync(OUT_FILE, evidence.join('\n') + '\n', 'utf8');
    console.log('[cell15] evidence:\n' + evidence.join('\n'));
  });
});