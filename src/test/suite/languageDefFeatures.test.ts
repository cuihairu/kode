import * as assert from 'assert';
import {
  FakeHover,
  FakeLocation,
  FakePosition,
  FakeTextDocument,
  FakeUri,
  createVscodeStub,
  loadModuleWithMocks
} from './testUtils';

type LanguageProvidersModule = typeof import('../../languageProviders');
type DefinitionWorkspaceModule = typeof import('../../definitionWorkspace');
type DatabaseSchemaModule = typeof import('../../databaseSchema');

describe('KBEngine .def language features', () => {
  let restoreModuleMocks: (() => void) | undefined;
  let KBEngineDefinitionProvider: LanguageProvidersModule['KBEngineDefinitionProvider'];
  let KBEngineHoverProvider: LanguageProvidersModule['KBEngineHoverProvider'];
  let mappingManagerStub: {
    resolveMethodImplementation: (entityName: string, methodName: string, section: string) => Promise<{ filePath: string; line: number } | null>;
  };

  before(() => {
    const fakeFs = {
      existsSync(candidatePath: string) {
        return [
          '/workspace/scripts/entity_defs/types.xml',
          '/workspace/scripts/entities.xml',
          '/workspace/scripts/user_type/RegisteredType.py',
          '/workspace/scripts/entity_defs/Avatar.def',
          '/workspace/scripts/entity_defs/Hero.def',
          '/workspace/scripts/entity_defs/interfaces/MoveIface.def',
          '/workspace/scripts/entity_defs/components/Inventory.def'
        ].includes(candidatePath);
      },
      readFileSync(candidatePath: string) {
        if (candidatePath === '/workspace/scripts/entity_defs/types.xml') {
          return [
            '<root>',
            '  <RegisteredType>',
            '    FIXED_DICT',
            '    <implementedBy>RegisteredType</implementedBy>',
            '    <Properties>',
            '      <score>',
            '        <Type>UINT32</Type>',
            '      </score>',
            '    </Properties>',
            '  </RegisteredType>',
            '  <OtherCustomType>UINT16</OtherCustomType>',
            '</root>'
          ].join('\n');
        }

        if (candidatePath === '/workspace/scripts/entities.xml') {
          return [
            '<root>',
            '  <Avatar hasBase="true" hasCell="false" hasClient="true"/>',
            '  <Hero hasBase="true" hasCell="true" hasClient="false"/>',
            '</root>'
          ].join('\n');
        }

        if (candidatePath === '/workspace/scripts/entity_defs/Hero.def') {
          return [
            '<root>',
            '  <Components>',
            '    <inventory>',
            '      <Type>Inventory</Type>',
            '      <Persistent>true</Persistent>',
            '    </inventory>',
            '  </Components>',
            '  <Properties>',
            '    <health>',
            '      <Type>UINT32</Type>',
            '      <Flags>BASE</Flags>',
            '      <Persistent>true</Persistent>',
            '    </health>',
            '    <positionMarker>',
            '      <Type>VECTOR3</Type>',
            '      <Flags>CELL_PUBLIC</Flags>',
            '      <Persistent>true</Persistent>',
            '    </positionMarker>',
            '  </Properties>',
            '</root>'
          ].join('\n');
        }

        throw new Error(`Unexpected readFileSync path: ${candidatePath}`);
      }
    };

    const vscodeStub = createVscodeStub();

    const { loadedModule: definitionWorkspaceModule, restore: restoreDefinitionWorkspace } =
      loadModuleWithMocks<DefinitionWorkspaceModule>(
        __filename,
        '../../definitionWorkspace',
        {
          vscode: vscodeStub,
          fs: fakeFs
        },
        true
      );

    const { loadedModule: databaseSchemaModule, restore: restoreDatabaseSchema } =
      loadModuleWithMocks<DatabaseSchemaModule>(
        __filename,
        '../../databaseSchema',
        {
          vscode: vscodeStub,
          fs: fakeFs,
          './definitionWorkspace': definitionWorkspaceModule
        },
        true
      );

    const { loadedModule, restore } = loadModuleWithMocks<LanguageProvidersModule>(
      __filename,
      '../../languageProviders',
      {
        vscode: vscodeStub,
        fs: fakeFs,
        './definitionWorkspace': definitionWorkspaceModule,
        './databaseSchema': databaseSchemaModule
      },
      true
    );
    restoreModuleMocks = () => {
      restore();
      restoreDatabaseSchema();
      restoreDefinitionWorkspace();
    };
    KBEngineDefinitionProvider = loadedModule.KBEngineDefinitionProvider;
    KBEngineHoverProvider = loadedModule.KBEngineHoverProvider;
    mappingManagerStub = {
      async resolveMethodImplementation(entityName: string, methodName: string, section: string) {
        if (entityName === 'Hero' && methodName === 'attack' && section === 'BaseMethods') {
          return {
            filePath: '/workspace/scripts/base/Hero.py',
            line: 12
          };
        }

        return null;
      }
    };
  });

  after(() => {
    restoreModuleMocks?.();
  });

  it('resolves entity names from entities.xml to def files', () => {
    const provider = new KBEngineDefinitionProvider();
    const document = new FakeTextDocument(
      '/workspace/entities.xml',
      'xml',
      '<root><Avatar>Avatar</Avatar></root>'
    );

    const location = provider.provideDefinition(
      document as never,
      new FakePosition(0, document.getText().indexOf('Avatar') + 1) as never
    ) as unknown as FakeLocation;

    assert.ok(location);
    assert.strictEqual(location.uri.fsPath, '/workspace/scripts/entity_defs/Avatar.def');
    assert.strictEqual(location.position.line, 0);
  });

  it('resolves entity type references inside def files', () => {
    const provider = new KBEngineDefinitionProvider();
    const text = [
      '<root>',
      '  <Properties>',
      '    <target>',
      '      <Type>Avatar</Type>',
      '      <Flags>BASE</Flags>',
      '    </target>',
      '  </Properties>',
      '</root>'
    ].join('\n');
    const document = new FakeTextDocument(
      '/workspace/scripts/entity_defs/Hero.def',
      'kbengine-def',
      text
    );

    const location = provider.provideDefinition(
      document as never,
      document.positionAt(text.indexOf('Avatar')) as never
    ) as unknown as FakeLocation;

    assert.ok(location);
    assert.strictEqual(location.uri.fsPath, '/workspace/scripts/entity_defs/Avatar.def');
  });

  it('resolves parent class references inside def files', () => {
    const provider = new KBEngineDefinitionProvider();
    const text = [
      '<root>',
      '  <Parent>',
      '    <Avatar/>',
      '  </Parent>',
      '</root>'
    ].join('\n');
    const document = new FakeTextDocument(
      '/workspace/scripts/entity_defs/Hero.def',
      'kbengine-def',
      text
    );

    const location = provider.provideDefinition(
      document as never,
      document.positionAt(text.indexOf('Avatar') + 1) as never
    ) as unknown as FakeLocation;

    assert.ok(location);
    assert.strictEqual(location.uri.fsPath, '/workspace/scripts/entity_defs/Avatar.def');
  });

  it('shows custom property details in symbol hover', () => {
    const provider = new KBEngineHoverProvider();
    const text = [
      '<root>',
      '  <Properties>',
      '    <health>',
      '      <Type>UINT32</Type>',
      '      <Flags>BASE</Flags>',
      '      <Default>100</Default>',
      '    </health>',
      '  </Properties>',
      '</root>'
    ].join('\n');
    const document = new FakeTextDocument(
      '/workspace/scripts/entity_defs/Hero.def',
      'kbengine-def',
      text
    );

    const hover = provider.provideHover(
      document as never,
      document.positionAt(text.indexOf('health')) as never
    ) as unknown as FakeHover;

    assert.ok(hover);
    assert.ok(hover.contents.value.includes('**health**'));
    assert.ok(hover.contents.value.includes('**Type**: `UINT32`'));
    assert.ok(hover.contents.value.includes('**Flags**: `BASE`'));
    assert.ok(hover.contents.value.includes('**Default**: `100`'));
  });

  it('shows exposed metadata in method hover', () => {
    const provider = new KBEngineHoverProvider();
    const text = [
      '<root>',
      '  <BaseMethods>',
      '    <attack>',
      '      <Arg>UINT32</Arg>',
      '      <Exposed/>',
      '    </attack>',
      '  </BaseMethods>',
      '</root>'
    ].join('\n');
    const document = new FakeTextDocument(
      '/workspace/scripts/entity_defs/Hero.def',
      'kbengine-def',
      text
    );

    const hover = provider.provideHover(
      document as never,
      document.positionAt(text.indexOf('attack')) as never
    ) as unknown as FakeHover;

    assert.ok(hover);
    assert.ok(hover.contents.value.includes('**attack**'));
    assert.ok(hover.contents.value.includes('**Exposed**: `true`'));
  });

  it('resolves persistent def properties to database schema fields', () => {
    const provider = new KBEngineDefinitionProvider();
    const text = [
      '<root>',
      '  <Properties>',
      '    <health>',
      '      <Type>UINT32</Type>',
      '      <Flags>BASE</Flags>',
      '      <Persistent>true</Persistent>',
      '    </health>',
      '  </Properties>',
      '</root>'
    ].join('\n');
    const document = new FakeTextDocument(
      '/workspace/scripts/entity_defs/Hero.def',
      'kbengine-def',
      text
    );

    const location = provider.provideDefinition(
      document as never,
      document.positionAt(text.indexOf('health') + 1) as never
    ) as unknown as FakeLocation;

    assert.ok(location);
    assert.strictEqual(location.uri.fsPath, 'kbengine-db-schema:/Hero.schema');
  });

  it('resolves database schema fields back to def property definitions', () => {
    const provider = new KBEngineDefinitionProvider();
    const text = [
      '# KBEngine Database Schema: Hero',
      '',
      'Backend: MYSQL',
      'Source: /workspace/scripts/entity_defs/Hero.def',
      '',
      'TABLE tbl_Hero',
      'kind: entity',
      'source: Hero.def:1 (Hero)',
      '',
      'sm_health  int unsigned  flags=BASE',
      '  source: Hero.def:10 (health)',
      ''
    ].join('\n');
    const document = new FakeTextDocument(
      'kbengine-db-schema:/Hero.schema',
      'plaintext',
      text
    ) as FakeTextDocument & { uri: FakeUri };
    (document as any).uri = new FakeUri('kbengine-db-schema:/Hero.schema');
    (document as any).uri.scheme = 'kbengine-db-schema';
    (document as any).uri.path = '/Hero.schema';

    const location = provider.provideDefinition(
      document as never,
      document.positionAt(text.indexOf('sm_health') + 1) as never
    ) as unknown as FakeLocation;

    assert.ok(location);
    assert.strictEqual(location.uri.fsPath, '/workspace/scripts/entity_defs/Hero.def');
  });

  it('shows source-backed tag hover for DetailLevels', () => {
    const provider = new KBEngineHoverProvider();
    const text = [
      '<root>',
      '  <DetailLevels>',
      '    <NEAR>',
      '      <radius>10</radius>',
      '      <hyst>2</hyst>',
      '    </NEAR>',
      '  </DetailLevels>',
      '</root>'
    ].join('\n');
    const document = new FakeTextDocument(
      '/workspace/scripts/entity_defs/Hero.def',
      'kbengine-def',
      text
    );

    const hover = provider.provideHover(
      document as never,
      document.positionAt(text.indexOf('DetailLevels')) as never
    ) as unknown as FakeHover;

    assert.ok(hover);
    assert.ok(hover.contents.value.includes('**DetailLevels**'));
    assert.ok(hover.contents.value.includes('NEAR'));
    assert.ok(hover.contents.value.includes('radius'));
    assert.ok(hover.contents.value.includes('hyst'));
  });

  it('shows tag hover for FIXED_DICT helper tags', () => {
    const provider = new KBEngineHoverProvider();
    const text = '<root><Type>FIXED_DICT<implementedBy>Demo.Type</implementedBy></Type></root>';
    const document = new FakeTextDocument(
      '/workspace/scripts/entity_defs/Hero.def',
      'kbengine-def',
      text
    );

    const hover = provider.provideHover(
      document as never,
      document.positionAt(text.indexOf('implementedBy')) as never
    ) as unknown as FakeHover;

    assert.ok(hover);
    assert.ok(hover.contents.value.includes('**implementedBy**'));
    assert.ok(hover.contents.value.includes('FIXED_DICT'));
  });

  it('resolves interface references inside def files', () => {
    const provider = new KBEngineDefinitionProvider();
    const text = [
      '<root>',
      '  <Interfaces>',
      '    <Interface>',
      '      <MoveIface/>',
      '    </Interface>',
      '  </Interfaces>',
      '</root>'
    ].join('\n');
    const document = new FakeTextDocument(
      '/workspace/scripts/entity_defs/Hero.def',
      'kbengine-def',
      text
    );

    const location = provider.provideDefinition(
      document as never,
      document.positionAt(text.indexOf('MoveIface') + 1) as never
    ) as unknown as FakeLocation;

    assert.ok(location);
    assert.strictEqual(location.uri.fsPath, '/workspace/scripts/entity_defs/interfaces/MoveIface.def');
  });

  it('resolves component type references inside def files', () => {
    const provider = new KBEngineDefinitionProvider();
    const text = [
      '<root>',
      '  <Components>',
      '    <inventory>',
      '      <Type>Inventory</Type>',
      '    </inventory>',
      '  </Components>',
      '</root>'
    ].join('\n');
    const document = new FakeTextDocument(
      '/workspace/scripts/entity_defs/Hero.def',
      'kbengine-def',
      text
    );

    const location = provider.provideDefinition(
      document as never,
      document.positionAt(text.indexOf('Inventory') + 1) as never
    ) as unknown as FakeLocation;

    assert.ok(location);
    assert.strictEqual(location.uri.fsPath, '/workspace/scripts/entity_defs/components/Inventory.def');
  });

  it('resolves custom type references inside def files to types.xml', () => {
    const provider = new KBEngineDefinitionProvider();
    const text = [
      '<root>',
      '  <Properties>',
      '    <profile>',
      '      <Type>RegisteredType</Type>',
      '      <Flags>BASE</Flags>',
      '    </profile>',
      '  </Properties>',
      '</root>'
    ].join('\n');
    const document = new FakeTextDocument(
      '/workspace/scripts/entity_defs/Hero.def',
      'kbengine-def',
      text
    );

    const location = provider.provideDefinition(
      document as never,
      document.positionAt(text.indexOf('RegisteredType') + 1) as never
    ) as unknown as FakeLocation;

    assert.ok(location);
    assert.strictEqual(location.uri.fsPath, '/workspace/scripts/entity_defs/types.xml');
    assert.strictEqual(location.position.line, 1);
  });

  it('resolves def method symbols to python implementations', async () => {
    const provider = new KBEngineDefinitionProvider(mappingManagerStub as never);
    const text = [
      '<root>',
      '  <BaseMethods>',
      '    <attack>',
      '      <Arg>UINT32</Arg>',
      '      <Exposed/>',
      '    </attack>',
      '  </BaseMethods>',
      '</root>'
    ].join('\n');
    const document = new FakeTextDocument(
      '/workspace/scripts/entity_defs/Hero.def',
      'kbengine-def',
      text
    );

    const location = await provider.provideDefinition(
      document as never,
      document.positionAt(text.indexOf('attack') + 1) as never
    ) as unknown as FakeLocation;

    assert.ok(location);
    assert.strictEqual(location.uri.fsPath, '/workspace/scripts/base/Hero.py');
    assert.strictEqual(location.position.line, 11);
  });

  it('shows custom type hover from types.xml metadata', () => {
    const provider = new KBEngineHoverProvider();
    const text = [
      '<root>',
      '  <RegisteredType>',
      '    FIXED_DICT',
      '    <implementedBy>RegisteredType</implementedBy>',
      '    <Properties>',
      '      <score>',
      '        <Type>UINT32</Type>',
      '      </score>',
      '    </Properties>',
      '  </RegisteredType>',
      '</root>'
    ].join('\n');
    const document = new FakeTextDocument(
      '/workspace/scripts/entity_defs/types.xml',
      'xml',
      text
    );

    const hover = provider.provideHover(
      document as never,
      document.positionAt(text.indexOf('RegisteredType') + 1) as never
    ) as unknown as FakeHover;

    assert.ok(hover);
    assert.ok(hover.contents.value.includes('**RegisteredType**'));
    assert.ok(hover.contents.value.includes('**AliasType**: `FIXED_DICT`'));
    assert.ok(hover.contents.value.includes('**implementedBy**: `RegisteredType`'));
    assert.ok(hover.contents.value.includes('`score`: `UINT32`'));
  });

  it('shows referenced custom type hover inside types.xml properties', () => {
    const provider = new KBEngineHoverProvider();
    const text = [
      '<root>',
      '  <RegisteredType>',
      '    FIXED_DICT',
      '    <Properties>',
      '      <child>',
      '        <Type>OtherCustomType</Type>',
      '      </child>',
      '    </Properties>',
      '  </RegisteredType>',
      '  <OtherCustomType>UINT16</OtherCustomType>',
      '</root>'
    ].join('\n');
    const document = new FakeTextDocument(
      '/workspace/scripts/entity_defs/types.xml',
      'xml',
      text
    );

    const hover = provider.provideHover(
      document as never,
      document.positionAt(text.indexOf('OtherCustomType') + 1) as never
    ) as unknown as FakeHover;

    assert.ok(hover);
    assert.ok(hover.contents.value.includes('**OtherCustomType**'));
    assert.ok(hover.contents.value.includes('Referenced custom type from `types.xml`'));
    assert.ok(hover.contents.value.includes('**AliasType**: `UINT16`'));
  });

  it('shows entity type hover inside types.xml properties', () => {
    const provider = new KBEngineHoverProvider();
    const text = [
      '<root>',
      '  <RegisteredType>',
      '    FIXED_DICT',
      '    <Properties>',
      '      <target>',
      '        <Type>Avatar</Type>',
      '      </target>',
      '    </Properties>',
      '  </RegisteredType>',
      '</root>'
    ].join('\n');
    const document = new FakeTextDocument(
      '/workspace/scripts/entity_defs/types.xml',
      'xml',
      text
    );

    const hover = provider.provideHover(
      document as never,
      document.positionAt(text.indexOf('Avatar') + 1) as never
    ) as unknown as FakeHover;

    assert.ok(hover);
    assert.ok(hover.contents.value.includes('**Avatar**'));
    assert.ok(hover.contents.value.includes('Entity type'));
    assert.ok(hover.contents.value.includes('**Definition**: `Avatar.def`'));
    assert.ok(hover.contents.value.includes('**Base**: `true` (declared, enabled)'));
    assert.ok(hover.contents.value.includes('**Cell**: `false` (declared, disabled)'));
    assert.ok(hover.contents.value.includes('**Client**: `true` (declared, enabled)'));
    assert.ok(hover.contents.value.includes('**Runtime**: `BaseApp / Client`'));
    assert.ok(hover.contents.value.includes('**Visibility**: Has client entity definition'));
    assert.ok(hover.contents.value.includes('**Registration**: Registered on BaseApp / Client'));
  });

  it('shows entity registration hover inside entities.xml', () => {
    const provider = new KBEngineHoverProvider();
    const text = [
      '<root>',
      '  <Avatar hasBase="true" hasCell="false" hasClient="true"/>',
      '</root>'
    ].join('\n');
    const document = new FakeTextDocument(
      '/workspace/scripts/entities.xml',
      'xml',
      text
    );

    const hover = provider.provideHover(
      document as never,
      document.positionAt(text.indexOf('Avatar') + 1) as never
    ) as unknown as FakeHover;

    assert.ok(hover);
    assert.ok(hover.contents.value.includes('Entity registration from `entities.xml`'));
    assert.ok(hover.contents.value.includes('**Runtime**: `BaseApp / Client`'));
    assert.ok(hover.contents.value.includes('**Meaning**: client SDK may generate and instantiate this entity type on the client side.'));
  });

  it('shows component type hover inside types.xml properties', () => {
    const provider = new KBEngineHoverProvider();
    const text = [
      '<root>',
      '  <RegisteredType>',
      '    FIXED_DICT',
      '    <Properties>',
      '      <inventory>',
      '        <Type>Inventory</Type>',
      '      </inventory>',
      '    </Properties>',
      '  </RegisteredType>',
      '</root>'
    ].join('\n');
    const document = new FakeTextDocument(
      '/workspace/scripts/entity_defs/types.xml',
      'xml',
      text
    );

    const hover = provider.provideHover(
      document as never,
      document.positionAt(text.indexOf('Inventory') + 1) as never
    ) as unknown as FakeHover;

    assert.ok(hover);
    assert.ok(hover.contents.value.includes('**Inventory**'));
    assert.ok(hover.contents.value.includes('Component type'));
    assert.ok(hover.contents.value.includes('**Definition**: `Inventory.def`'));
  });

  it('resolves implementedBy values in types.xml to user_type python files', () => {
    const provider = new KBEngineDefinitionProvider();
    const text = [
      '<root>',
      '  <RegisteredType>',
      '    FIXED_DICT',
      '    <implementedBy>RegisteredType</implementedBy>',
      '  </RegisteredType>',
      '</root>'
    ].join('\n');
    const document = new FakeTextDocument(
      '/workspace/scripts/entity_defs/types.xml',
      'xml',
      text
    );

    const location = provider.provideDefinition(
      document as never,
      document.positionAt(text.indexOf('RegisteredType</implementedBy>') + 1) as never
    ) as unknown as FakeLocation;

    assert.ok(location);
    assert.strictEqual(location.uri.fsPath, '/workspace/scripts/user_type/RegisteredType.py');
    assert.strictEqual(location.position.line, 0);
  });

  it('resolves entity type references inside types.xml properties', () => {
    const provider = new KBEngineDefinitionProvider();
    const text = [
      '<root>',
      '  <RegisteredType>',
      '    FIXED_DICT',
      '    <Properties>',
      '      <target>',
      '        <Type>Avatar</Type>',
      '      </target>',
      '    </Properties>',
      '  </RegisteredType>',
      '</root>'
    ].join('\n');
    const document = new FakeTextDocument(
      '/workspace/scripts/entity_defs/types.xml',
      'xml',
      text
    );

    const location = provider.provideDefinition(
      document as never,
      document.positionAt(text.indexOf('Avatar') + 1) as never
    ) as unknown as FakeLocation;

    assert.ok(location);
    assert.strictEqual(location.uri.fsPath, '/workspace/scripts/entity_defs/Avatar.def');
    assert.strictEqual(location.position.line, 0);
  });

  it('resolves component type references inside types.xml properties', () => {
    const provider = new KBEngineDefinitionProvider();
    const text = [
      '<root>',
      '  <RegisteredType>',
      '    FIXED_DICT',
      '    <Properties>',
      '      <inventory>',
      '        <Type>Inventory</Type>',
      '      </inventory>',
      '    </Properties>',
      '  </RegisteredType>',
      '</root>'
    ].join('\n');
    const document = new FakeTextDocument(
      '/workspace/scripts/entity_defs/types.xml',
      'xml',
      text
    );

    const location = provider.provideDefinition(
      document as never,
      document.positionAt(text.indexOf('Inventory') + 1) as never
    ) as unknown as FakeLocation;

    assert.ok(location);
    assert.strictEqual(location.uri.fsPath, '/workspace/scripts/entity_defs/components/Inventory.def');
    assert.strictEqual(location.position.line, 0);
  });

  it('resolves custom type references inside types.xml properties', () => {
    const provider = new KBEngineDefinitionProvider();
    const text = [
      '<root>',
      '  <RegisteredType>',
      '    FIXED_DICT',
      '    <Properties>',
      '      <child>',
      '        <Type>OtherCustomType</Type>',
      '      </child>',
      '    </Properties>',
      '  </RegisteredType>',
      '  <OtherCustomType>UINT16</OtherCustomType>',
      '</root>'
    ].join('\n');
    const document = new FakeTextDocument(
      '/workspace/scripts/entity_defs/types.xml',
      'xml',
      text
    );

    const location = provider.provideDefinition(
      document as never,
      document.positionAt(text.indexOf('OtherCustomType') + 1) as never
    ) as unknown as FakeLocation;

    assert.ok(location);
    assert.strictEqual(location.uri.fsPath, '/workspace/scripts/entity_defs/types.xml');
    assert.strictEqual(location.position.line, 10);
  });
});
