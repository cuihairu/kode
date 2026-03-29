import * as assert from 'assert';
import {
  FakeCompletionItem,
  FakeLocation,
  FakePosition,
  FakeTextDocument,
  createVscodeStub,
  loadModuleWithMocks
} from './testUtils';

type LanguageProvidersModule = typeof import('../../languageProviders');

describe('Python providers', () => {
  let restoreModuleMocks: (() => void) | undefined;
  let PythonDefinitionProvider: LanguageProvidersModule['PythonDefinitionProvider'];
  let PythonCompletionProvider: LanguageProvidersModule['PythonCompletionProvider'];

  before(() => {
    const { loadedModule, restore } = loadModuleWithMocks<LanguageProvidersModule>(
      __filename,
      '../../languageProviders',
      { vscode: createVscodeStub() }
    );
    restoreModuleMocks = restore;
    const providers = loadedModule;
    PythonDefinitionProvider = providers.PythonDefinitionProvider;
    PythonCompletionProvider = providers.PythonCompletionProvider;
  });

  after(() => {
    restoreModuleMocks?.();
  });

  function createMappingManager() {
    return {
      getMapping(entityName: string) {
        if (entityName !== 'Hero') {
          return undefined;
        }

        return {
          name: 'Hero',
          defFile: '/workspace/entity_defs/Hero.def',
          pythonFile: '/workspace/scripts/Hero.py',
          properties: {
            health: { defFile: '/workspace/entity_defs/Hero.def', line: 8 },
            inventory: { defFile: '/workspace/entity_defs/Hero.def', line: 12 },
            'inventory.weapon': { defFile: '/workspace/entity_defs/Hero.def', line: 16 },
            'inventory.weapon.damage': { defFile: '/workspace/entity_defs/Hero.def', line: 20 },
            'inventory.weapon.range': { defFile: '/workspace/entity_defs/Hero.def', line: 24 }
          },
          methods: {
            attack: { defFile: '/workspace/entity_defs/Hero.def', line: 40 }
          }
        };
      }
    };
  }

  it('resolves nested property definitions using the full self access path', () => {
    const provider = new PythonDefinitionProvider(createMappingManager() as never);
    const document = new FakeTextDocument(
      '/workspace/scripts/Hero.py',
      'python',
      'return self.inventory.weapon.damage'
    );

    const location = provider.provideDefinition(
      document as never,
      new FakePosition(0, 'return self.inventory.weapon.damage'.indexOf('damage')) as never
    ) as unknown as FakeLocation;

    assert.ok(location);
    assert.strictEqual(location.uri.fsPath, '/workspace/entity_defs/Hero.def');
    assert.strictEqual(location.position.line, 19);
  });

  it('falls back to the root property or method when a nested path is not mapped', () => {
    const provider = new PythonDefinitionProvider(createMappingManager() as never);
    const propertyDocument = new FakeTextDocument(
      '/workspace/scripts/Hero.py',
      'python',
      'return self.inventory.unknown'
    );
    const methodDocument = new FakeTextDocument('/workspace/scripts/Hero.py', 'python', 'self.attack(target)');

    const propertyLocation = provider.provideDefinition(
      propertyDocument as never,
      new FakePosition(0, 'return self.inventory.unknown'.indexOf('unknown')) as never
    ) as unknown as FakeLocation;
    const methodLocation = provider.provideDefinition(
      methodDocument as never,
      new FakePosition(0, 'self.attack(target)'.indexOf('attack')) as never
    ) as unknown as FakeLocation;

    assert.ok(propertyLocation);
    assert.strictEqual(propertyLocation.position.line, 11);

    assert.ok(methodLocation);
    assert.strictEqual(methodLocation.position.line, 39);
  });

  it('returns top-level property and method completion items for direct self access', () => {
    const provider = new PythonCompletionProvider(createMappingManager() as never);
    const document = new FakeTextDocument('/workspace/scripts/Hero.py', 'python', 'self.');

    const items = provider.provideCompletionItems(
      document as never,
      new FakePosition(0, 'self.'.length) as never
    ) as FakeCompletionItem[];

    const labels = items.map(item => item.label).sort();
    assert.deepStrictEqual(labels, ['attack', 'health', 'inventory']);
  });

  it('returns deduplicated nested property completions for chained self access', () => {
    const provider = new PythonCompletionProvider(createMappingManager() as never);
    const document = new FakeTextDocument('/workspace/scripts/Hero.py', 'python', 'self.inventory.we');

    const items = provider.provideCompletionItems(
      document as never,
      new FakePosition(0, 'self.inventory.we'.length) as never
    ) as FakeCompletionItem[];

    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].label, 'weapon');
    assert.strictEqual(items[0].detail, 'Nested Entity Property');
  });
});
