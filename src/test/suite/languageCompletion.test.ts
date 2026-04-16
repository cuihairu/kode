import * as assert from 'assert';
import * as path from 'path';
import {
  FakeCompletionItem,
  FakePosition,
  FakeTextDocument,
  createVscodeStub,
  loadModuleWithMocks
} from './testUtils';

type LanguageProvidersModule = typeof import('../../languageProviders');
type DefinitionWorkspaceModule = typeof import('../../definitionWorkspace');

describe('KBEngineCompletionProvider', () => {
  let restoreModuleMocks: (() => void) | undefined;
  let KBEngineCompletionProvider: LanguageProvidersModule['KBEngineCompletionProvider'];

  before(() => {
    const typesXmlPath = path.join('/workspace', 'scripts', 'entity_defs', 'types.xml');
    const entitiesXmlPath = path.join('/workspace', 'scripts', 'entities.xml');
    const avatarDefPath = path.join('/workspace', 'scripts', 'entity_defs', 'Avatar.def');
    const fsStub = {
      existsSync(candidatePath: string): boolean {
        return [
          typesXmlPath,
          entitiesXmlPath,
          avatarDefPath
        ].includes(candidatePath);
      },
      readFileSync(candidatePath: string): string {
        if (candidatePath === typesXmlPath) {
          return '<root><RegisteredType/></root>';
        }

        if (candidatePath === entitiesXmlPath) {
          return '<root><Avatar hasBase="true"/></root>';
        }

        throw new Error(`Unexpected readFileSync path: ${candidatePath}`);
      }
    };

    const vscodeStub = createVscodeStub();
    const { loadedModule: definitionWorkspaceModule, restore: restoreDefinitionWorkspace } =
      loadModuleWithMocks<DefinitionWorkspaceModule>(
        __filename,
        '../../definitionWorkspace',
        { vscode: vscodeStub, fs: fsStub },
        true
      );

    const { loadedModule, restore } = loadModuleWithMocks<LanguageProvidersModule>(
      __filename,
      '../../languageProviders',
      {
        vscode: vscodeStub,
        fs: fsStub,
        './definitionWorkspace': definitionWorkspaceModule
      },
      true
    );
    restoreModuleMocks = () => {
      restore();
      restoreDefinitionWorkspace();
    };
    KBEngineCompletionProvider = loadedModule.KBEngineCompletionProvider;
  });

  after(() => {
    restoreModuleMocks?.();
  });

  function labels(items: FakeCompletionItem[]): string[] {
    return items.map(item => item.label);
  }

  it('suggests KBEngine types inside Type tags', () => {
    const provider = new KBEngineCompletionProvider();
    const document = new FakeTextDocument(
      '/workspace/scripts/entity_defs/Hero.def',
      'kbengine-def',
      '      <Type>UI'
    );

    const items = provider.provideCompletionItems(
      document as never,
      new FakePosition(0, '      <Type>UI'.length) as never
    ) as FakeCompletionItem[];

    const itemLabels = labels(items);
    assert.ok(itemLabels.includes('UINT32'));
    assert.ok(itemLabels.includes('VECTOR3'));
    assert.ok(itemLabels.includes('FIXED_DICT'));
    assert.ok(itemLabels.includes('RegisteredType'));
    assert.ok(itemLabels.includes('Avatar'));
  });

  it('suggests top-level def tags after an opening angle bracket', () => {
    const provider = new KBEngineCompletionProvider();
    const document = new FakeTextDocument(
      '/workspace/scripts/entity_defs/Hero.def',
      'kbengine-def',
      '    <'
    );

    const items = provider.provideCompletionItems(
      document as never,
      new FakePosition(0, '    <'.length) as never
    ) as FakeCompletionItem[];

    const itemLabels = labels(items);
    assert.ok(itemLabels.includes('Properties'));
    assert.ok(itemLabels.includes('Parent'));
    assert.ok(itemLabels.includes('Interfaces'));
    assert.ok(itemLabels.includes('Components'));
    assert.ok(itemLabels.includes('BaseMethods'));
    assert.ok(itemLabels.includes('CellMethods'));
    assert.ok(itemLabels.includes('ClientMethods'));
    assert.ok(itemLabels.includes('DetailLevels'));
    assert.ok(!itemLabels.includes('Flags'));
    assert.ok(!itemLabels.includes('Arg'));
  });

  it('suggests property child tags only inside property definitions', () => {
    const provider = new KBEngineCompletionProvider();
    const source = [
      '<root>',
      '  <Properties>',
      '    <health>',
      '      <',
      '    </health>',
      '  </Properties>',
      '</root>'
    ].join('\n');
    const document = new FakeTextDocument(
      '/workspace/scripts/entity_defs/Hero.def',
      'kbengine-def',
      source
    );

    const items = provider.provideCompletionItems(
      document as never,
      new FakePosition(3, '      <'.length) as never
    ) as FakeCompletionItem[];

    const itemLabels = labels(items);
    assert.ok(itemLabels.includes('Type'));
    assert.ok(itemLabels.includes('Flags'));
    assert.ok(itemLabels.includes('Persistent'));
    assert.ok(itemLabels.includes('DatabaseLength'));
    assert.ok(itemLabels.includes('Utype'));
    assert.ok(!itemLabels.includes('Arg'));
    assert.ok(!itemLabels.includes('Properties'));
  });

  it('suggests method child tags according to method section', () => {
    const provider = new KBEngineCompletionProvider();
    const source = [
      '<root>',
      '  <ClientMethods>',
      '    <Notify>',
      '      <',
      '    </Notify>',
      '  </ClientMethods>',
      '</root>'
    ].join('\n');
    const document = new FakeTextDocument(
      '/workspace/scripts/entity_defs/Hero.def',
      'kbengine-def',
      source
    );

    const items = provider.provideCompletionItems(
      document as never,
      new FakePosition(3, '      <'.length) as never
    ) as FakeCompletionItem[];

    const itemLabels = labels(items);
    assert.ok(itemLabels.includes('Arg'));
    assert.ok(itemLabels.includes('Utype'));
    assert.ok(!itemLabels.includes('Exposed'));
    assert.ok(!itemLabels.includes('Flags'));
  });

  it('suggests KBEngine types inside Arg tags', () => {
    const provider = new KBEngineCompletionProvider();
    const document = new FakeTextDocument(
      '/workspace/scripts/entity_defs/Hero.def',
      'kbengine-def',
      '      <Arg>UI'
    );

    const items = provider.provideCompletionItems(
      document as never,
      new FakePosition(0, '      <Arg>UI'.length) as never
    ) as FakeCompletionItem[];

    const itemLabels = labels(items);
    assert.ok(itemLabels.includes('UINT32'));
    assert.ok(itemLabels.includes('VECTOR3'));
    assert.ok(itemLabels.includes('FIXED_DICT'));
  });

  it('suggests container child tags inside ARRAY and FIXED_DICT types', () => {
    const provider = new KBEngineCompletionProvider();
    const arrayDocument = new FakeTextDocument(
      '/workspace/scripts/entity_defs/Hero.def',
      'kbengine-def',
      '      <Type>ARRAY<'
    );
    const dictDocument = new FakeTextDocument(
      '/workspace/scripts/entity_defs/Hero.def',
      'kbengine-def',
      '      <Type>FIXED_DICT<'
    );

    const arrayItems = provider.provideCompletionItems(
      arrayDocument as never,
      new FakePosition(0, '      <Type>ARRAY<'.length) as never
    ) as FakeCompletionItem[];
    const dictItems = provider.provideCompletionItems(
      dictDocument as never,
      new FakePosition(0, '      <Type>FIXED_DICT<'.length) as never
    ) as FakeCompletionItem[];

    assert.deepStrictEqual(labels(arrayItems), ['of']);
    assert.ok(labels(dictItems).includes('Properties'));
    assert.ok(labels(dictItems).includes('implementedBy'));
    assert.ok(!labels(dictItems).includes('of'));
  });

  it('suggests source-backed KBEngine reload helpers in python files', () => {
    const provider = new KBEngineCompletionProvider();
    const document = new FakeTextDocument(
      '/workspace/scripts/Hero.py',
      'python',
      'KBEngine.re'
    );

    const items = provider.provideCompletionItems(
      document as never,
      new FakePosition(0, 'KBEngine.re'.length) as never
    ) as FakeCompletionItem[];

    const itemLabels = labels(items);
    assert.ok(itemLabels.includes('reloadScript'));
    assert.ok(!itemLabels.includes('reloadEntityDef'));
    assert.ok(!itemLabels.includes('isReload'));
  });

  it('suggests importlib.reload for python hot-reload flows', () => {
    const provider = new KBEngineCompletionProvider();
    const document = new FakeTextDocument(
      '/workspace/scripts/Hero.py',
      'python',
      'importlib.re'
    );

    const items = provider.provideCompletionItems(
      document as never,
      new FakePosition(0, 'importlib.re'.length) as never
    ) as FakeCompletionItem[];

    assert.deepStrictEqual(labels(items), ['reload']);
  });
});
