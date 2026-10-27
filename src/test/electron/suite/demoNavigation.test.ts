import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { clearRecentJumpLogs, getRecentJumpLogs } from '../../../navigationLog';

interface NavigationCase {
  id: string;
  source: { file: string; needle: string; symbol: string };
  targets: Array<{ file: string; needle: string }>;
}

const DEMO_ROOT = process.env.KODE_DEMO_WORKSPACE;
assert.ok(DEMO_ROOT, 'runTest.js --demo must set KODE_DEMO_WORKSPACE');
const manifest = JSON.parse(fs.readFileSync(path.join(DEMO_ROOT!, 'navigation-cases.json'), 'utf8')) as {
  cases: NavigationCase[];
};

function expectedLocations(testCase: NavigationCase): string[] {
  return testCase.targets.map(target => {
    const filePath = path.join(DEMO_ROOT!, target.file);
    const line = fs.readFileSync(filePath, 'utf8').split(/\r?\n/)
      .findIndex(text => text.includes(target.needle));
    assert.ok(line >= 0, `${testCase.id}: missing target ${target.file}:${target.needle}`);
    return `${filePath}:${line}`;
  }).sort();
}

// kode 的定义落点全部是零宽 Range(Location(uri, Position) 构造);VS Code 内建
// 词基定义回退会追加「词宽」同文件落点(异步词表,时有时无),按零宽过滤只保留
// 本扩展的结果——断言仍然严格:多一个文件行、少一个文件行都会红。
function kodeLocations(raw: unknown): vscode.Location[] {
  const locations = Array.isArray(raw) ? raw as vscode.Location[] : raw ? [raw as vscode.Location] : [];
  return locations.filter(location =>
    location.range.start.line === location.range.end.line &&
    location.range.start.character === location.range.end.character);
}

async function actualLocations(testCase: NavigationCase): Promise<string[]> {
  const filePath = path.join(DEMO_ROOT!, testCase.source.file);
  const uri = vscode.Uri.file(filePath);
  const document = await vscode.workspace.openTextDocument(uri);
  const lines = document.getText().split(/\r?\n/);
  const line = lines.findIndex(text => text.includes(testCase.source.needle));
  assert.ok(line >= 0, `${testCase.id}: missing source marker ${testCase.source.needle}`);
  const character = lines[line].indexOf(testCase.source.symbol);
  assert.ok(character >= 0, `${testCase.id}: missing symbol ${testCase.source.symbol}`);
  const raw = await vscode.commands.executeCommand(
    'vscode.executeDefinitionProvider', uri,
    new vscode.Position(line, character + Math.floor(testCase.source.symbol.length / 2))
  );
  return kodeLocations(raw).map(location => `${location.uri.fsPath}:${location.range.start.line}`).sort();
}

describe('KBEngine demo navigation through VS Code F12 provider', () => {
  before(async () => {
    const extension = vscode.extensions.getExtension('cuihairu.kode-kbengine');
    assert.ok(extension, 'Kode extension is unavailable in the extension host');
    await extension.activate();
    assert.strictEqual(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath, DEMO_ROOT);
    // 冷启动预热(真机层时序):首查不等全量扫描(PR5 语义),冷态下组合根
    // 派生/全仓扫描可能超出请求预算(2500ms)→ 首例空结果,属设计内收敛行为。
    // 本套断言的是稳态精确目标集,故先轮询「多根最难例」到非空再开测(有界)。
    const probe = manifest.cases.find(item => item.targets.length >= 3) ?? manifest.cases[0];
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      clearRecentJumpLogs();
      if ((await actualLocations(probe)).length > 0) { return; }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    for (const line of getRecentJumpLogs()) { console.log(`[jumpline] ${line}`); }
    assert.fail(`warmup timed out: probe case "${probe.id}" never returned a definition`);
  });

  for (const testCase of manifest.cases) {
    it(`${testCase.id} returns its exact target set`, async () => {
      clearRecentJumpLogs();
      try {
        assert.deepStrictEqual(await actualLocations(testCase), expectedLocations(testCase));
      } catch (error) {
        for (const line of getRecentJumpLogs()) { console.log(`[jumpline] ${line}`); }
        throw error;
      }
    });
  }
});
