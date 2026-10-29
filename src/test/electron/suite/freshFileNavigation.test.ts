import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { performance } from 'perf_hooks';
import * as vscode from 'vscode';

// IDE-ACC-005:新增文件后的首次导航验收(真实编辑器,不重载窗口)。
// 会话启动时 FreshEntity 的实现文件刻意缺席(cell/ 目录空):套件中途用
// fs 现场创建 scripts/cell/FreshEntity.py——python watcher 的 onDidCreate
// 必须把它带入索引,def→python 首次 F12 命中新文件;全程不执行任何窗口
// 重载/重开命令(命中只能来自 watcher 路径)。证据行 KEY=VALUE 落
// KODE_ACC5_OUT(缺省 docs/perf/2026-10-29-acc005-fresh-file-nav-run.txt)。

const ROOT = process.env.KODE_FRESH_ROOT;
assert.ok(ROOT, 'runTest.js --freshfile must set KODE_FRESH_ROOT');
const OUT_FILE = process.env.KODE_ACC5_OUT
  ?? path.resolve(__dirname, '../../../../docs/perf/2026-10-29-acc005-fresh-file-nav-run.txt');

const DEF_PATH = path.join(ROOT!, 'scripts', 'entity_defs', 'FreshEntity.def');
const IMPL_PATH = path.join(ROOT!, 'scripts', 'cell', 'FreshEntity.py');
/** FreshEntity.py 的 `def onFresh(` 行号(0 起,夹具形态固定) */
const IMPL_DEF_LINE = 2;
/** FreshEntity.def 的 <onFresh> 行号(0 起) */
const DEF_METHOD_LINE = 2;

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

async function defPositionAt(): Promise<{ uri: vscode.Uri; position: vscode.Position }> {
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(DEF_PATH));
  const lines = document.getText().split('\n');
  const line = lines.findIndex(text => text.includes('<onFresh>'));
  assert.ok(line >= 0, 'def 夹具缺 <onFresh>');
  return {
    uri: document.uri,
    position: new vscode.Position(line, lines[line].indexOf('onFresh'))
  };
}

async function defToPythonLocations(): Promise<vscode.Location[]> {
  const { uri, position } = await defPositionAt();
  const raw = await vscode.commands.executeCommand(
    'vscode.executeDefinitionProvider', uri, position
  );
  return (Array.isArray(raw) ? raw : []) as vscode.Location[];
}

describe('IDE-ACC-005:新增实现文件后的首次导航(真实编辑器)', () => {
  before(async () => {
    const extension = vscode.extensions.getExtension('cuihairu.kode-kbengine');
    assert.ok(extension, 'Kode extension is unavailable in the extension host');
    await extension.activate();
    // 夹具不变量:def 在档、实现缺席(创建动作由用例本体完成)
    assert.ok(fs.existsSync(DEF_PATH), 'def 夹具缺失');
    assert.ok(!fs.existsSync(IMPL_PATH), '实现文件应缺席(夹具被污染)');
  });

  it('现场创建实现文件后,def→python 首次 F12 命中新文件(零窗口重载)', async function () {
    this.timeout(120_000);
    // ①基线:实现缺席时 F12 不得返回指向 FreshEntity.py 的落点
    const baseline = await defToPythonLocations();
    const baselineHits = baseline.filter(loc => loc.uri.fsPath === IMPL_PATH);
    assert.strictEqual(
      baselineHits.length, 0,
      `实现缺席时 F12 不应已命中: ${baseline.map(l => l.uri.fsPath).join(', ')}`
    );

    // ②现场创建实现文件(真实 fs 创建事件,非编辑器 API 旁路)
    const createdAt = performance.now();
    fs.writeFileSync(IMPL_PATH, [
      'class FreshEntity:',
      '',
      '    def onFresh(self, level):',
      '        return None'
    ].join('\n'));

    // ③轮询首次命中:每次尝试都是真 F12(无重载命令);命中即停
    let hit: vscode.Location | null = null;
    let attempts = 0;
    let firstHitMs = 0;
    for (let round = 0; round < 24 && !hit; round++) {
      attempts += 1;
      const locations = await defToPythonLocations();
      const found = locations.find(loc => loc.uri.fsPath === IMPL_PATH);
      if (found) {
        hit = found;
        firstHitMs = performance.now() - createdAt;
      } else {
        await sleep(500);
      }
    }
    assert.ok(hit, `新建实现文件后 ${attempts} 次 F12 均未命中(watcher 未带入索引)`);
    assert.ok(fs.existsSync(IMPL_PATH), '新实现文件磁盘不存在');
    assert.strictEqual(
      hit.range.start.line, IMPL_DEF_LINE,
      `落点行应是新文件的 def onFresh 行,实落 :${hit.range.start.line}`
    );

    const lines = [
      `acc005.baseline.locations=${baseline.length}`,
      `acc005.baseline.implHits=0`,
      `acc005.fresh.attempts=${attempts}`,
      `acc005.fresh.firstHitMs=${firstHitMs.toFixed(1)}`,
      `acc005.fresh.target=${path.relative(ROOT!, IMPL_PATH)}:${hit.range.start.line}`,
      `acc005.fresh.windowReloads=0`
    ];
    fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
    fs.writeFileSync(OUT_FILE, lines.join('\n') + '\n', 'utf8');
    console.log('[acc005 fresh] evidence:\n' + lines.join('\n'));
  });

  it('新文件反向:python→def F12 落 FreshEntity.def 的 <onFresh>', async function () {
    this.timeout(60_000);
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(IMPL_PATH));
    const lines = document.getText().split('\n');
    const line = lines.findIndex(text => text.includes('def onFresh'));
    assert.ok(line >= 0, '新实现文件缺 def onFresh');
    const raw = await vscode.commands.executeCommand(
      'vscode.executeDefinitionProvider',
      document.uri,
      new vscode.Position(line, lines[line].indexOf('onFresh'))
    );
    const locations = (Array.isArray(raw) ? raw : []) as vscode.Location[];
    assert.ok(locations.length > 0, 'python→def F12 无落点');
    assert.strictEqual(locations[0].uri.fsPath, DEF_PATH, 'python→def 落点文件不符');
    assert.strictEqual(
      locations[0].range.start.line, DEF_METHOD_LINE,
      `def 落点行应含 <onFresh>,实落 :${locations[0].range.start.line}`
    );
    fs.appendFileSync(OUT_FILE,
      `acc005.reverse.pythonToDef=scripts/entity_defs/FreshEntity.def:${locations[0].range.start.line}\n`,
      'utf8');
  });
});
