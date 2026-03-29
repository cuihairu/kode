import * as assert from 'assert';
import {
  FakeCompletionItem,
  FakePosition,
  FakeTextDocument,
  createVscodeStub,
  loadModuleWithMocks
} from './testUtils';

type LanguageProvidersModule = typeof import('../../languageProviders');

describe('KBEngineCompletionProvider', () => {
  let restoreModuleMocks: (() => void) | undefined;
  let KBEngineCompletionProvider: LanguageProvidersModule['KBEngineCompletionProvider'];

  before(() => {
    const { loadedModule, restore } = loadModuleWithMocks<LanguageProvidersModule>(
      __filename,
      '../../languageProviders',
      { vscode: createVscodeStub() },
      true
    );
    restoreModuleMocks = restore;
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
  });

  it('suggests def tags after an opening angle bracket', () => {
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
    assert.ok(itemLabels.includes('Type'));
    assert.ok(itemLabels.includes('Flags'));
    assert.ok(itemLabels.includes('Arg'));
  });

  it('suggests KBEngine reload helpers in python files', () => {
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
    assert.ok(itemLabels.includes('reloadEntityDef'));
    assert.ok(itemLabels.includes('isReload'));
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
