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
});
