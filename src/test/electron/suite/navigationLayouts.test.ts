import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

// 根修令⑤(用户令 2026-10-10):四种真实布局的真机 F12 断言——每种都断
// 「有落点」而非「有提示」(提示仅作辅助)。用宿主内真 VS Code 的
// vscode.executeDefinitionProvider 走已注册的 definition provider,不依赖
// 扩展导出面。工作区由 runTest.ts 传入(tests/fixtures/electron-ws)。
// 断言落点文件在磁盘上真实存在,不接受虚拟/占位路径。

const WS_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/electron-ws');

interface LayoutCase {
  layout: string;
  def: string;
  word: string;
  target: string;
  line: number;
}

const CASES: LayoutCase[] = [
  {
    layout: '标准 scripts/entity_defs',
    def: 'scripts/entity_defs/Boxe.def',
    word: 'hp',
    target: 'scripts/base/Boxe.py',
    line: 0
  },
  {
    layout: '非标准 server/scripts/entity_defs',
    def: 'server/scripts/entity_defs/Ship.def',
    word: 'onSail',
    target: 'server/scripts/cell/Ship.py',
    line: 2
  },
  {
    layout: '仅 entity_defs 在根',
    def: 'entity_defs/Account.def',
    word: 'hp',
    target: 'base/Account.py',
    line: 0
  },
  {
    layout: '组件 def',
    def: 'server/scripts/entity_defs/components/Gun.def',
    word: 'onFire',
    target: 'server/scripts/cell/Gun.py',
    line: 2
  }
];

async function positionAtWord(
  defRelative: string,
  word: string
): Promise<{ uri: vscode.Uri; position: vscode.Position }> {
  const uri = vscode.Uri.file(path.join(WS_ROOT, defRelative));
  const document = await vscode.workspace.openTextDocument(uri);
  const lines = document.getText().split('\n');
  const lineIndex = lines.findIndex(line => line.includes(`<${word}>`));
  assert.ok(
    lineIndex >= 0,
    `${defRelative} 中未找到 <${word}>(夹具与用例不一致)`
  );
  const lineText = lines[lineIndex];
  const character = lineText.indexOf(`<${word}`) + 1;
  return { uri, position: new vscode.Position(lineIndex, character) };
}

describe('根修令四布局真机 F12:必有落点', () => {
  before(async () => {
    const extension = vscode.extensions.getExtension('cuihairu.kode');
    assert.ok(extension, '扩展未安装到测试宿主');
    await extension.activate();
    assert.strictEqual(vscode.workspace.workspaceFolders?.length, 1, '工作区未打开');
    assert.ok(
      fs.existsSync(path.join(WS_ROOT, 'entity_defs', 'entities.xml')),
      '夹具根不可达'
    );
  });

  for (const testCase of CASES) {
    it(`${testCase.layout}:F12 落 ${path.join(testCase.target)}:${testCase.line}`, async () => {
      const { uri, position } = await positionAtWord(testCase.def, testCase.word);
      const raw = await vscode.commands.executeCommand(
        'vscode.executeDefinitionProvider',
        uri,
        position
      );
      const locations = Array.isArray(raw) ? (raw as vscode.Location[]) : [];

      assert.ok(
        locations.length > 0,
        `${testCase.layout}:F12 无落点(不许只弹提示)`
      );
      assert.strictEqual(
        locations[0].uri.fsPath,
        path.join(WS_ROOT, testCase.target),
        `${testCase.layout}:落点文件不符`
      );
      assert.strictEqual(
        locations[0].range.start.line,
        testCase.line,
        `${testCase.layout}:落点行不符`
      );
      assert.ok(
        fs.existsSync(locations[0].uri.fsPath),
        `${testCase.layout}:落点文件在磁盘上不存在`
      );
    });
  }
});
