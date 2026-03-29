import * as assert from 'assert';
import {
  FakeHover,
  FakeLocation,
  FakePosition,
  FakeTextDocument,
  createVscodeStub,
  loadModuleWithMocks
} from './testUtils';

type LanguageProvidersModule = typeof import('../../languageProviders');

describe('KBEngine .def language features', () => {
  let restoreModuleMocks: (() => void) | undefined;
  let KBEngineDefinitionProvider: LanguageProvidersModule['KBEngineDefinitionProvider'];
  let KBEngineHoverProvider: LanguageProvidersModule['KBEngineHoverProvider'];

  before(() => {
    const fakeFs = {
      existsSync(candidatePath: string) {
        return candidatePath === '/workspace/scripts/entity_defs/Avatar.def';
      }
    };

    const { loadedModule, restore } = loadModuleWithMocks<LanguageProvidersModule>(
      __filename,
      '../../languageProviders',
      {
        vscode: createVscodeStub(),
        fs: fakeFs
      },
      true
    );
    restoreModuleMocks = restore;
    KBEngineDefinitionProvider = loadedModule.KBEngineDefinitionProvider;
    KBEngineHoverProvider = loadedModule.KBEngineHoverProvider;
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
});
