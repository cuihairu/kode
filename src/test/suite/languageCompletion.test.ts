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

  it('suggests of as the only ARRAY child tag and none for FIXED_DICT', () => {
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

    // ARRAY:引擎 FixedArrayType::initialize 强制 <of> 子节点,补全只给 of。
    assert.deepStrictEqual(labels(arrayItems), ['of']);
    // FIXED_DICT:只能经 types.xml 别名声明,def 属性内联结构引擎不加载
    // (FixedDictType 无 DataTypes::initialize 注册),不提供子标签补全。
    assert.deepStrictEqual(labels(dictItems), []);
  });

  it('suggests hooks while typing a method name on a later line of a Methods section', () => {
    const provider = new KBEngineCompletionProvider();
    const source = [
      '<root>',
      '  <CellMethods>',
      '    <onTele'
    ].join('\n');
    const document = new FakeTextDocument(
      '/workspace/scripts/entity_defs/Hero.def',
      'kbengine-def',
      source
    );

    const items = provider.provideCompletionItems(
      document as never,
      new FakePosition(2, '    <onTele'.length) as never
    ) as FakeCompletionItem[];

    const itemLabels = labels(items);
    assert.ok(itemLabels.includes('onTeleport'), `got: ${itemLabels.join(', ')}`);
    assert.ok(itemLabels.includes('onTeleportSuccess'));
    assert.ok(itemLabels.includes('onTeleportFailure'));
    assert.ok(!itemLabels.includes('onTimer'));
  });

  it('suggests hooks inside multi-line BaseMethods without a same-line section tag', () => {
    const provider = new KBEngineCompletionProvider();
    const source = [
      '<root>',
      '  <BaseMethods>',
      '    <on'
    ].join('\n');
    const document = new FakeTextDocument(
      '/workspace/scripts/entity_defs/Hero.def',
      'kbengine-def',
      source
    );

    const items = provider.provideCompletionItems(
      document as never,
      new FakePosition(2, '    <on'.length) as never
    ) as FakeCompletionItem[];

    const itemLabels = labels(items);
    assert.ok(itemLabels.length >= 30, `expected hook list, got ${itemLabels.length}`);
    assert.ok(itemLabels.every(label => label.startsWith('on')));
    assert.ok(itemLabels.includes('onTimer'));
    assert.ok(itemLabels.includes('onDestroy'));
  });

  it('does not suggest hooks outside Methods sections', () => {
    const provider = new KBEngineCompletionProvider();
    const source = [
      '<root>',
      '  <Properties>',
      '    <hp'
    ].join('\n');
    const document = new FakeTextDocument(
      '/workspace/scripts/entity_defs/Hero.def',
      'kbengine-def',
      source
    );

    const items = provider.provideCompletionItems(
      document as never,
      new FakePosition(2, '    <hp'.length) as never
    ) as FakeCompletionItem[];

    const itemLabels = labels(items);
    assert.ok(!itemLabels.some(label => label.startsWith('on')), `got: ${itemLabels.join(', ')}`);
  });

  it('does not suggest hooks when the method prefix is outside any Methods section', () => {
    const provider = new KBEngineCompletionProvider();
    const source = [
      '<root>',
      '  <Properties>',
      '    <onTele'
    ].join('\n');
    const document = new FakeTextDocument(
      '/workspace/scripts/entity_defs/Hero.def',
      'kbengine-def',
      source
    );

    const items = provider.provideCompletionItems(
      document as never,
      new FakePosition(2, '    <onTele'.length) as never
    ) as FakeCompletionItem[];

    assert.deepStrictEqual(labels(items), []);
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
