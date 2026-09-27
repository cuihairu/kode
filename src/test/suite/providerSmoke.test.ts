import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type * as vscode from 'vscode';
import {
  loadCompiledVscodeStub,
  loadModuleWithMocks,
  resetCompiledVscodeStub,
  type CompiledVscodeStub
} from './testUtils';

// 编译产物 provider 烟测:out/languageProviders.js 经 module._load 注入
// fake-vscode 编译副本后,补全/悬停在 tsc 产物形态下真实应答。补全的
// 期望标签序列与 vitest 层 tests/languageProviders.test.ts 同源(顶层
// 9 标签),保证两 runner 对同一规格的口径一致。

type LanguageProvidersModule = typeof import('../../languageProviders');

describe('compiled language provider smoke', () => {
  const stub: CompiledVscodeStub = loadCompiledVscodeStub();
  let providers: LanguageProvidersModule;
  let root: string;

  const makeDocument = (text: string): vscode.TextDocument =>
    stub.makeTextDocument(text, {
      fileName: path.join(root, 'ws', 'scripts', 'entity_defs', 'Sample.def')
    }) as unknown as vscode.TextDocument;

  before(() => {
    resetCompiledVscodeStub(stub);
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-provider-smoke-'));
    stub.workspace.workspaceFolders = [
      { uri: stub.Uri.file(path.join(root, 'ws')), name: 'ws', index: 0 }
    ];

    const { loadedModule } = loadModuleWithMocks<LanguageProvidersModule>(
      __filename,
      '../../languageProviders',
      { vscode: stub }
    );
    providers = loadedModule;
  });

  after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('completes the def top-level tags below an open root', () => {
    const provider = new providers.KBEngineCompletionProvider();
    // 行尾 '<' 触发标签补全(vitest 层同规格:<root>\n  <|)
    const position = new stub.Position(1, 3) as unknown as vscode.Position;

    const items = provider.provideCompletionItems(makeDocument('<root>\n  <'), position);

    assert.deepStrictEqual(
      (Array.isArray(items) ? items : []).map(item => item.label),
      [
        'Parent', 'Interfaces', 'Components', 'Properties',
        'BaseMethods', 'CellMethods', 'ClientMethods', 'DetailLevels', 'Volatile'
      ]
    );
  });

  it('hovers tag documentation for a def tag word', () => {
    const provider = new providers.KBEngineHoverProvider();
    const document = makeDocument('<root>\n  <Properties>\n  </Properties>\n</root>');
    const onTag = new stub.Position(1, 5) as unknown as vscode.Position;
    const away = new stub.Position(0, 6) as unknown as vscode.Position;

    const hover = provider.provideHover(document, onTag);

    assert.ok(hover, 'hover for the Properties tag is expected');
    assert.strictEqual(provider.provideHover(document, away), null);
  });

  it('renames a def property across the parent chain (compiled module)', async () => {
    // 真实落盘树:entities.xml 定位定义根,Child.def 经 Parent 复述 hp
    const defsRoot = path.join(root, 'ws', 'scripts', 'entity_defs');
    fs.mkdirSync(defsRoot, { recursive: true });
    fs.writeFileSync(path.join(defsRoot, 'entities.xml'), '<root/>\n', 'utf8');
    const sampleText = [
      '<root>',
      '  <Properties>',
      '    <hp> <Type> UINT32 </Type> </hp>',
      '  </Properties>',
      '</root>',
      ''
    ].join('\n');
    fs.writeFileSync(path.join(defsRoot, 'Sample.def'), sampleText, 'utf8');
    fs.writeFileSync(path.join(defsRoot, 'Child.def'), [
      '<root>',
      '  <Parent> Sample </Parent>',
      '  <Properties>',
      '    <hp> <Type> UINT16 </Type> </hp>',
      '  </Properties>',
      '</root>',
      ''
    ].join('\n'), 'utf8');

    const provider = new providers.KBEngineRenameProvider();
    const document = makeDocument(sampleText);
    const offset = sampleText.indexOf('<hp>') + 1;
    const position = document.positionAt(offset) as unknown as vscode.Position;

    const prepared = provider.prepareRename(document, position);
    assert.ok(prepared, 'prepareRename for the hp property is expected');
    if (!('placeholder' in prepared)) {
      assert.fail('prepareRename expected the placeholder form');
    }
    assert.strictEqual(prepared.placeholder, 'hp');
    assert.strictEqual(document.offsetAt(prepared.range.start), offset);

    const workspaceEdit = await provider.provideRenameEdits(document, position, 'vigor');
    assert.ok(workspaceEdit, 'rename edits are expected');
    assert.strictEqual(workspaceEdit.size, 2);

    const byPath = new Map(workspaceEdit.entries().map(([uri, edits]) => [uri.fsPath, edits]));
    const sampleEdits = byPath.get(path.join(defsRoot, 'Sample.def'));
    const childEdits = byPath.get(path.join(defsRoot, 'Child.def'));
    assert.ok(sampleEdits, 'edits for Sample.def are expected');
    assert.ok(childEdits, 'edits for Child.def are expected');
    assert.strictEqual(sampleEdits.length, 2, 'open + close tag names in Sample.def');
    assert.strictEqual(childEdits.length, 2, 'open + close tag names in Child.def');
    assert.strictEqual(document.offsetAt(sampleEdits[0].range.start), offset);
    for (const edits of [sampleEdits, childEdits]) {
      for (const edit of edits) {
        assert.strictEqual(edit.newText, 'vigor');
      }
    }
  });
});
