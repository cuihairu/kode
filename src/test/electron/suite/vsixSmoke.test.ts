import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

// IDE-REL-006 安装后单次烟测:runTest.ts --vsix 先 vsce 真打包,解包成
// 安装布局(extension/ = 扩展根)再以它作为扩展加载。本套对「包内文件」发
// 真实请求并断言命中,而不是结构对账:
// ① 身份:激活扩展的 extensionPath == 解包产物目录(不是仓库树),且安装
//   布局齐全(out/extension.js / out/pythonParserWorker.js /
//   out/buildCommit.json——REL-003/REL-004 的包面在此刻用真宿主核验);
// ② hover:.def 标签词 executeHoverProvider 命中标签文档;
// ③ 跳转源定位:.def 方法名 executeDefinitionProvider 精确落到实体脚本
//   def 行(file:line 与 navigation-cases.json 同源,零宽过滤同 demo 真机套);
// ④ worker 路径:>256 KiB 的 Python 文件在扩展宿主内必然派发 worker 线程
//   解析(pythonParserWorkerHost 以 __dirname 定位 worker 文件,即包内
//   out/pythonParserWorker.js),其上 self 方法跳转命中 = 打包 worker 真
//   解析过这条请求的可观察证据(注入坏 worker 的 KODE_VSIX_PATH 对照
//   下本例先红,其余例保持绿,见 prove-red 记录)。

const WORKSPACE = process.env.KODE_VSIX_WORKSPACE;
const EXT_DIR = process.env.KODE_VSIX_EXT_DIR;
assert.ok(WORKSPACE && EXT_DIR, 'runTest.js --vsix must set KODE_VSIX_WORKSPACE and KODE_VSIX_EXT_DIR');

/** 宿主侧 worker 派发阈值(PYTHON_WORKER_PARSE_THRESHOLD,256 KiB):烟测
 * 大文件按此下限生成(runTest 侧再加余量到 300 KiB),运行时再核一次,
 * 防生成逻辑被改小后用例悄悄退化成内联解析。 */
const WORKER_PARSE_THRESHOLD_BYTES = 256 * 1024;

interface NavigationCase {
  source: { file: string; needle: string; symbol: string };
  targets: Array<{ file: string; needle: string }>;
}

function loadCase(id: string): NavigationCase {
  const manifest = JSON.parse(fs.readFileSync(path.join(WORKSPACE!, 'navigation-cases.json'), 'utf8')) as {
    cases: Array<NavigationCase & { id: string }>;
  };
  const found = manifest.cases.find(item => item.id === id);
  assert.ok(found, `navigation-cases.json must keep the ${id} case`);
  return found;
}

// kode 的定义落点全部是零宽 Range(Location(uri, Position) 构造);按零宽
// 过滤只保留本扩展的结果(与 demo 真机套同构:多一个/少一个落点都会红)。
function kodeLocations(raw: unknown): vscode.Location[] {
  const locations = Array.isArray(raw) ? raw as vscode.Location[] : raw ? [raw as vscode.Location] : [];
  return locations.filter(location =>
    location.range.start.line === location.range.end.line &&
    location.range.start.character === location.range.end.character);
}

function expectedLocations(testCase: NavigationCase): string[] {
  return testCase.targets.map(target => {
    const filePath = path.join(WORKSPACE!, target.file);
    const line = fs.readFileSync(filePath, 'utf8').split(/\r?\n/)
      .findIndex(text => text.includes(target.needle));
    assert.ok(line >= 0, `missing target ${target.file}:${target.needle}`);
    return `${filePath}:${line}`;
  }).sort();
}

async function definitionHits(testCase: NavigationCase): Promise<string[]> {
  const filePath = path.join(WORKSPACE!, testCase.source.file);
  const uri = vscode.Uri.file(filePath);
  const document = await vscode.workspace.openTextDocument(uri);
  const lines = document.getText().split(/\r?\n/);
  const line = lines.findIndex(text => text.includes(testCase.source.needle));
  assert.ok(line >= 0, `missing source marker ${testCase.source.needle}`);
  const character = lines[line].indexOf(testCase.source.symbol);
  assert.ok(character >= 0, `missing symbol ${testCase.source.symbol}`);
  const raw = await vscode.commands.executeCommand(
    'vscode.executeDefinitionProvider', uri,
    new vscode.Position(line, character + Math.floor(testCase.source.symbol.length / 2))
  );
  return kodeLocations(raw).map(location => `${location.uri.fsPath}:${location.range.start.line}`).sort();
}

async function pollUntilNonEmpty(testCase: NavigationCase, deadlineMs: number): Promise<string[]> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const hits = await definitionHits(testCase);
    if (hits.length > 0 || Date.now() > deadline) { return hits; }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}

const defToCell = loadCase('def-to-cell');
// 跨文件刻意形态:调用在小文件、实现在大文件(≥256 KiB)。同文件时层3
// file-scope 会用当前文档内联解析兜底命中,worker 面被绕开;跨文件后唯一
// 命中路径是层2 索引,而大文件入索引的解析通道在宿主侧必然是 worker 线程。
const smokeWorkerCase: NavigationCase = {
  source: {
    file: 'scripts/common/training/smoke_worker_caller.py',
    needle: '# nav: vsix-smoke-worker',
    symbol: 'smoke_worker_method'
  },
  targets: [
    { file: 'scripts/common/training/smoke_worker_large.py', needle: 'def smoke_worker_method' }
  ]
};

describe('vsix packaged-artifact smoke (IDE-REL-006)', () => {
  before(async () => {
    const extension = vscode.extensions.getExtension('cuihairu.kode-kbengine');
    assert.ok(extension, 'packaged extension is unavailable in the extension host');
    await extension.activate();
    assert.strictEqual(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath, WORKSPACE);
    // 冷启动预热(同 demo 真机套语义):组合根派生/扫描可能超出首查预算,
    // 有界轮询 def→py 例到非空再开测。
    const warm = await pollUntilNonEmpty(defToCell, 20000);
    assert.ok(warm.length > 0, 'warmup timed out: def-to-cell never returned a definition');
  });

  it('activates from the unpacked vsix in install layout', () => {
    const extension = vscode.extensions.getExtension('cuihairu.kode-kbengine');
    assert.ok(extension);
    assert.strictEqual(extension!.extensionPath, EXT_DIR, 'must load the unpacked artifact, not the repo tree');
    for (const relative of ['out/extension.js', 'out/pythonParserWorker.js', 'out/buildCommit.json']) {
      assert.ok(
        fs.existsSync(path.join(extension!.extensionPath, relative)),
        `packaged file missing: ${relative}`
      );
    }
    const identity = JSON.parse(
      fs.readFileSync(path.join(extension!.extensionPath, 'out/buildCommit.json'), 'utf8')
    ) as { commit: unknown };
    assert.match(String(identity.commit), /^[0-9a-f]{40}$/, 'buildCommit.json must carry the packaging commit');
  });

  it('hovers def tag documentation from the packaged provider', async () => {
    const uri = vscode.Uri.file(path.join(WORKSPACE!, 'scripts/entity_defs/TrainingAvatar.def'));
    const document = await vscode.workspace.openTextDocument(uri);
    const lines = document.getText().split(/\r?\n/);
    const line = lines.findIndex(text => text.includes('<CellMethods>'));
    assert.ok(line >= 0, 'missing <CellMethods> in TrainingAvatar.def');
    const character = lines[line].indexOf('CellMethods') + 4;
    const hovers = await vscode.commands.executeCommand(
      'vscode.executeHoverProvider', uri, new vscode.Position(line, character)
    ) as vscode.Hover[];
    const text = (hovers ?? []).map(hover =>
      hover.contents.map(part => (part as { value?: string }).value ?? String(part)).join('')
    ).join('');
    assert.ok(
      text.includes('CellApp'),
      `hover expected to carry the CellMethods tag doc, got: ${text.slice(0, 120)}`
    );
  });

  it('jumps from a def method to the entity script source line', async () => {
    assert.deepStrictEqual(await definitionHits(defToCell), expectedLocations(defToCell));
  });

  it('hits a self-method jump on an oversized file parsed by the packaged worker', async () => {
    // 实现文件大于宿主派发阈值(256 KiB),入索引的解析通道必然是 worker
    // 线程(全量扫描/按需加载都走 loadFile→updateFileResponsive→
    // parsePythonFileResponsive;worker 文件=包内 out/pythonParserWorker.js);
    // 调用方小文件的层3 file-scope 只解析它自己,给不出跨文件落点。本例
    // 命中 ⇒ 打包 worker 真解析过这条请求所需的实现文件。
    const oversized = path.join(WORKSPACE!, smokeWorkerCase.targets[0].file);
    assert.ok(
      fs.statSync(oversized).size >= WORKER_PARSE_THRESHOLD_BYTES,
      'smoke fixture must stay over the worker dispatch threshold'
    );
    const hits = await pollUntilNonEmpty(smokeWorkerCase, 15000);
    assert.deepStrictEqual(hits, expectedLocations(smokeWorkerCase));
  });
});
