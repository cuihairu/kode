import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

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
  const locations = Array.isArray(raw) ? raw as vscode.Location[] : raw ? [raw as vscode.Location] : [];
  return locations.map(location => `${location.uri.fsPath}:${location.range.start.line}`).sort();
}

describe('KBEngine demo navigation through VS Code F12 provider', () => {
  before(async () => {
    const extension = vscode.extensions.getExtension('hairucui.kode');
    assert.ok(extension, 'Kode extension is unavailable in the extension host');
    await extension.activate();
    assert.strictEqual(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath, DEMO_ROOT);
  });

  for (const testCase of manifest.cases) {
    it(`${testCase.id} returns its exact target set`, async () => {
      assert.deepStrictEqual(await actualLocations(testCase), expectedLocations(testCase));
    });
  }
});
