import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import type { EntityMappingManager } from '../src/entityMapping';
import { CallChainController } from '../src/defCallChainProvider';
import { DefParamInlayHintsProvider } from '../src/defParamInlayHints';
import { DefPropsInlayHintsProvider } from '../src/defPropsInlayHints';
import { GeneratedSourceCodeLensProvider } from '../src/generatedSourceLenses';
import {
  clearDatabaseSchemaCacheForTests,
  flushTypeStorageUsageColdBuildForTests,
  invalidateTypeStorageUsageIndex
} from '../src/databaseSchema';
import { TypesXmlCodeLensProvider } from '../src/languageProviders';
import {
  InferredMirrorTypeInlayHintsProvider,
  KBEngineBuiltinTypeInlayHintsProvider,
  KBEnginePropertyShadowInlayHintsProvider,
  KBEngineProxyInternalAttrHintsProvider
} from '../src/languageProviders/inlay';
import type { PythonTypeStubEntry } from '../src/pythonTypeStubs';
import { buildPythonTypeStubContent, buildPythonTypeStubLineMap } from '../src/pythonTypeStubs';
import {
  configurationOverrides,
  makeTextDocument,
  Position,
  Range,
  Uri,
  workspace
} from './helpers/vscodeStub';

// RUST-149 批 3:取消令牌贯穿 TS 接线面(CodeLens / inlay 家族)。
// 判例(批 1/批 2 同源):真异步面每个 await 放行点复查令牌,取消后不再发起
// 后续解析(resolve 调用次数冻结 + 返回空);同步 provider 只有入口闸
// (用「同文档活令牌出内容 vs 已取消令牌返空」两臂对照钉住)。

const WHOLE = () => new Range(new Position(0, 0), new Position(64, 0));
const cancelledToken = (): { isCancellationRequested: boolean } => ({ isCancellationRequested: false });

const originalFolders = workspace.workspaceFolders;
const originalGetWorkspaceFolder = (workspace as { getWorkspaceFolder?: unknown }).getWorkspaceFolder;
const temporaryDirectories: string[] = [];

beforeEach(() => {
  configurationOverrides.clear();
});

afterEach(async () => {
  workspace.workspaceFolders = originalFolders;
  (workspace as { getWorkspaceFolder?: unknown }).getWorkspaceFolder = originalGetWorkspaceFolder;
  configurationOverrides.delete('kbengine');
  await flushTypeStorageUsageColdBuildForTests();
  invalidateTypeStorageUsageIndex();
  clearDatabaseSchemaCacheForTests();
  for (const dir of temporaryDirectories.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const makeRoot = (label: string): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `kode-cancel-b3-${label}-`));
  temporaryDirectories.push(root);
  return root;
};

describe('CallChainCodeLens 取消面', () => {
  it('取消后不再解析后续方法(resolve 次数冻结)', async () => {
    let release!: (value: null) => void;
    const pendingLookup = new Promise<null>(resolve => { release = resolve; });
    const lookup = vi.fn(() => pendingLookup);
    const provider = new CallChainController(
      { resolveMethodDefinition: lookup } as unknown as EntityMappingManager
    );
    const doc = makeTextDocument(
      'def first(self):\n    pass\ndef second(self):\n    pass\n',
      { fileName: '/ws/scripts/base/Avatar.py', languageId: 'python' }
    );
    const token = cancelledToken();
    const pending = provider.provideCodeLenses(doc as never, token as vscode.CancellationToken);
    expect(lookup).toHaveBeenCalledTimes(1);
    token.isCancellationRequested = true;
    release(null);
    expect(await pending).toEqual([]);
    // 放行后令牌已置位 → 第二个方法不再发起反查
    expect(lookup).toHaveBeenCalledTimes(1);
  });
});

describe('DefParamInlayHints 取消面', () => {
  it('取消后不再反查后续方法(resolve 次数冻结)', async () => {
    let release!: (value: null) => void;
    const pendingLookup = new Promise<null>(resolve => { release = resolve; });
    const lookup = vi.fn(() => pendingLookup);
    const provider = new DefParamInlayHintsProvider(
      { resolveMethodDefinition: lookup } as unknown as EntityMappingManager
    );
    const doc = makeTextDocument(
      'class Avatar:\n    def first(self, a):\n        pass\n    def second(self, b):\n        pass\n',
      { fileName: '/proj/scripts/base/Avatar.py', languageId: 'python' }
    );
    const token = cancelledToken();
    const pending = provider.provideInlayHints(doc as never, WHOLE(), token as vscode.CancellationToken);
    expect(lookup).toHaveBeenCalledTimes(1);
    token.isCancellationRequested = true;
    release(null);
    expect(await pending).toEqual([]);
    expect(lookup).toHaveBeenCalledTimes(1);
  });
});

describe('DefPropsInlayHints 取消面', () => {
  const propertyList = () => [{
    identity: { propertyPath: 'hp', symbolName: 'hp' },
    typeName: 'UINT16',
    defFile: '/proj/scripts/entity_defs/Avatar.def',
    line: 3,
    domains: []
  }];
  const text = 'class Avatar:\n    # kode:props-from-def\n';
  const docOf = () => makeTextDocument(text, {
    fileName: '/proj/scripts/base/Avatar.py',
    languageId: 'python'
  });

  it('放行前复查令牌:取消返空,同文档活令牌照常出提示', async () => {
    const live = new DefPropsInlayHintsProvider(
      { listPropertyDefinitionsForFile: () => Promise.resolve(propertyList()) } as unknown as EntityMappingManager
    );
    expect(await live.provideInlayHints(docOf() as never, WHOLE())).not.toEqual([]);

    let release!: (value: unknown) => void;
    const pendingList = new Promise<unknown>(resolve => { release = resolve; });
    const manager = { listPropertyDefinitionsForFile: vi.fn(() => pendingList) } as unknown as EntityMappingManager;
    const provider = new DefPropsInlayHintsProvider(manager);
    const token = cancelledToken();
    const pending = provider.provideInlayHints(docOf() as never, WHOLE(), token as vscode.CancellationToken);
    token.isCancellationRequested = true;
    release(propertyList());
    expect(await pending).toEqual([]);
  });
});

describe('BuiltinTypeInlayHints 取消面', () => {
  const text = 'class Avatar:\n    def tick(self):\n        self.databaseID = 1\n';
  const fileName = '/proj/scripts/flat/Avatar.py';

  it('放行前复查令牌:取消返空,同文档活令牌照常出提示', async () => {
    const live = new KBEngineBuiltinTypeInlayHintsProvider(
      { getEntityComponentFacesForPythonFile: () => Promise.resolve(['baseapp']) } as unknown as EntityMappingManager
    );
    expect(
      await live.provideInlayHints(
        makeTextDocument(text, { fileName, languageId: 'python' }) as never,
        WHOLE()
      )
    ).toHaveLength(1);

    let release!: (value: readonly string[]) => void;
    const pendingFaces = new Promise<readonly string[]>(resolve => { release = resolve; });
    const provider = new KBEngineBuiltinTypeInlayHintsProvider(
      { getEntityComponentFacesForPythonFile: () => pendingFaces } as unknown as EntityMappingManager
    );
    const token = cancelledToken();
    const pending = provider.provideInlayHints(
      makeTextDocument(text, { fileName, languageId: 'python' }) as never,
      WHOLE(),
      token as vscode.CancellationToken
    );
    token.isCancellationRequested = true;
    release(['baseapp']);
    expect(await pending).toEqual([]);
  });
});

describe('PropertyShadowInlayHints 取消面', () => {
  const COPY_TEXT = [
    'class Hero:',
    '    def __init__(self):',
    '        self.hp = self.cellData["hp"]',
    '        self.level = self.cellData["level"]',
    ''
  ].join('\n');
  const infoFor = (name: string) => ({
    identity: { symbolName: name },
    domains: ['cell'],
    defFile: '/ws/scripts/entity_defs/Hero.def',
    line: 3,
    typeName: 'UINT8'
  });

  it('取消后不再反查后续候选,已取消令牌入口即返空', async () => {
    const live = new KBEnginePropertyShadowInlayHintsProvider(
      {
        resolvePropertyDefinitionInfo: (_file: string, key: string) => Promise.resolve(infoFor(key))
      } as unknown as EntityMappingManager
    );
    expect(
      await live.provideInlayHints(
        makeTextDocument(COPY_TEXT, { fileName: '/ws/scripts/base/Hero.py', languageId: 'python' }) as never,
        WHOLE()
      )
    ).not.toEqual([]);

    const token = cancelledToken();
    let release!: (value: unknown) => void;
    const pendingInfo = new Promise<unknown>(resolve => { release = resolve; });
    const lookup = vi.fn(() => {
      token.isCancellationRequested = true; // 首个候选放行前取消
      return pendingInfo;
    });
    const provider = new KBEnginePropertyShadowInlayHintsProvider(
      { resolvePropertyDefinitionInfo: lookup } as unknown as EntityMappingManager
    );
    const pending = provider.provideInlayHints(
      makeTextDocument(COPY_TEXT, { fileName: '/ws/scripts/base/Hero.py', languageId: 'python' }) as never,
      WHOLE(),
      token as vscode.CancellationToken
    );
    // 首个候选的反查可能落在后续微任务上(Rust 扫描束 await 之后):等它发起
    for (let tick = 0; tick < 50 && lookup.mock.calls.length === 0; tick += 1) {
      await Promise.resolve();
    }
    expect(lookup).toHaveBeenCalledTimes(1);
    release(infoFor('hp'));
    expect(await pending).toEqual([]);
    // 首个候选放行即取消 → 后续候选不再发起反查(次数冻结在 1)
    expect(lookup).toHaveBeenCalledTimes(1);

    // 入口闸:已取消令牌不发起任何反查
    const frozen = vi.fn(() => Promise.resolve(null));
    const entryProvider = new KBEnginePropertyShadowInlayHintsProvider(
      { resolvePropertyDefinitionInfo: frozen } as unknown as EntityMappingManager
    );
    expect(
      await entryProvider.provideInlayHints(
        makeTextDocument(COPY_TEXT, { fileName: '/ws/scripts/base/Hero.py', languageId: 'python' }) as never,
        WHOLE(),
        { isCancellationRequested: true } as vscode.CancellationToken
      )
    ).toEqual([]);
    expect(frozen).toHaveBeenCalledTimes(0);
  });
});

describe('同步 provider 入口闸(活令牌出内容 vs 已取消返空)', () => {
  it('GeneratedSourceCodeLens:取消返空,活令牌出「原始定义」镜', () => {
    const root = makeRoot('gensource');
    fs.mkdirSync(path.join(root, 'scripts', 'entity_defs'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'scripts', 'entity_defs', 'types.xml'),
      ['<root>', '  <ITEM_ID>UINT16</ITEM_ID>', '</root>'].join('\n'),
      'utf8'
    );
    workspace.workspaceFolders = [{ uri: Uri.file(root), name: 'b3', index: 0 }];
    (workspace as { getWorkspaceFolder?: unknown }).getWorkspaceFolder = (uri: { path?: string }) =>
      String(uri.path ?? '').startsWith(root)
        ? { uri: Uri.file(root), name: 'b3', index: 0 }
        : undefined;
    const entries: PythonTypeStubEntry[] = [{
      kind: 'class',
      name: 'ITEM_ID',
      annotation: 'int',
      sourceLine: 4,
      sourceFile: 'types.xml',
      properties: []
    }];
    const content = buildPythonTypeStubContent(entries)!;
    const lineMap = buildPythonTypeStubLineMap(entries)!;
    const doc = Object.assign(
      makeTextDocument(content, { fileName: path.join(root, 'stub_types.py'), languageId: 'python' }),
      { lineCount: content.split('\n').length }
    );
    const provider = new GeneratedSourceCodeLensProvider('stub_types.py', entries, [], lineMap, null);
    expect(provider.provideCodeLenses(doc)).not.toEqual([]);
    expect(provider.provideCodeLenses(doc, { isCancellationRequested: true } as vscode.CancellationToken)).toEqual([]);
  });

  it('InferredMirrorTypeInlayHints:取消返空,活令牌按生成桩差分出提示', () => {
    // 车道对齐 17570cb5 现行产品真相:pyrefly 只跑 stubgen,注解产物是
    // `<managedDir>/stubs/generated/<相对路径>.pyi`(镜像目录只收普通副本,
    // 无注解);消费面 readGeneratedStub 读 .pyi 车道。
    const root = makeRoot('mirror');
    const srcPath = path.join(root, 'scripts', 'foo.py');
    fs.mkdirSync(path.dirname(srcPath), { recursive: true });
    const sourceText = 'def foo(self):\n    return 1\n\n\ncount = 0\n';
    const stubText = 'def foo(self) -> int:\n    return 1\n\n\ncount: int = 0\n';
    const stubPath = path.join(root, '.kbengine', 'stubs', 'generated', 'scripts', 'foo.pyi');
    fs.mkdirSync(path.dirname(stubPath), { recursive: true });
    fs.writeFileSync(srcPath, sourceText, 'utf8');
    fs.writeFileSync(stubPath, stubText, 'utf8');
    workspace.workspaceFolders = [{ uri: Uri.file(root), name: 'b3', index: 0 }];
    const doc = makeTextDocument(sourceText, { fileName: srcPath, languageId: 'python' });
    const provider = new InferredMirrorTypeInlayHintsProvider();
    expect(provider.provideInlayHints(doc, WHOLE())).not.toEqual([]);
    expect(provider.provideInlayHints(doc, WHOLE(), { isCancellationRequested: true } as vscode.CancellationToken))
      .toEqual([]);
  });

  it('ProxyInternalAttrHints:取消返空,活令牌出「内部属性 · Proxy」提示', async () => {
    const provider = new KBEngineProxyInternalAttrHintsProvider({
      resolveProxyPyiPath: () => null,
      readFile: () => ''
    });
    const doc = makeTextDocument(
      'class Account(Proxy):\n    def onLogin(self):\n        self.__ACCOUNT_NAME__ = ""\n',
      { fileName: '/ws/scripts/base/Account.py', languageId: 'python' }
    );
    expect(await provider.provideInlayHints(doc, WHOLE())).toHaveLength(1);
    expect(
      await provider.provideInlayHints(doc, WHOLE(), { isCancellationRequested: true } as vscode.CancellationToken)
    ).toEqual([]);
  });

  it('TypesXmlCodeLens:取消返空,活令牌按落库镜出「原始定义」镜', async () => {
    const root = makeRoot('typesxml');
    fs.mkdirSync(path.join(root, 'scripts', 'entity_defs'), { recursive: true });
    fs.writeFileSync(path.join(root, 'scripts', 'entities.xml'), '<root>\n  <Gold/>\n</root>\n', 'utf8');
    const typesXml = path.join(root, 'scripts', 'entity_defs', 'types.xml');
    fs.writeFileSync(typesXml, '<root>\n  <ITEM_ID> UINT16 </ITEM_ID>\n</root>\n', 'utf8');
    fs.writeFileSync(path.join(root, 'scripts', 'entity_defs', 'Gold.def'), [
      '<root>',
      '  <Properties>',
      '    <coin>',
      '      <Type>ITEM_ID</Type>',
      '      <Persistent>true</Persistent>',
      '    </coin>',
      '  </Properties>',
      '</root>'
    ].join('\n'), 'utf8');
    workspace.workspaceFolders = [{ uri: Uri.file(root), name: 'b3', index: 0 }];
    invalidateTypeStorageUsageIndex();
    clearDatabaseSchemaCacheForTests();
    await flushTypeStorageUsageColdBuildForTests();

    const provider = new TypesXmlCodeLensProvider();
    const doc = () => makeTextDocument(fs.readFileSync(typesXml, 'utf8'), {
      fileName: typesXml,
      languageId: 'xml'
    });
    // 冷渲染触发后台落库构建,排干后重渲染内容才到位(与 IDE-SCH-009 同序)
    provider.provideCodeLenses(doc());
    await flushTypeStorageUsageColdBuildForTests();
    const titles = () => (provider.provideCodeLenses(doc()) as Array<{ command?: { title?: string } }>)
      .map(lens => lens.command?.title ?? '');
    expect(titles().some(title => title.includes('Gold.coin'))).toBe(true);
    expect(
      provider.provideCodeLenses(doc(), { isCancellationRequested: true } as vscode.CancellationToken)
    ).toEqual([]);
  });
});