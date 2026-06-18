import * as assert from 'assert';
import {
  FakeCallHierarchyIncomingCall,
  FakeCallHierarchyItem,
  FakeCallHierarchyOutgoingCall,
  FakePosition,
  FakeTextDocument,
  createVscodeStub,
  loadModuleWithMocks
} from './testUtils';

type LanguageProvidersModule = typeof import('../../languageProviders');

describe('KBEngineCallHierarchyProvider', () => {
  let restoreModuleMocks: (() => void) | undefined;
  let KBEngineCallHierarchyProvider: LanguageProvidersModule['KBEngineCallHierarchyProvider'];

  before(() => {
    const { loadedModule, restore } = loadModuleWithMocks<LanguageProvidersModule>(
      __filename,
      '../../languageProviders',
      { vscode: createVscodeStub() }
    );
    restoreModuleMocks = restore;
    KBEngineCallHierarchyProvider = loadedModule.KBEngineCallHierarchyProvider;
  });

  after(() => {
    restoreModuleMocks?.();
  });

  function createMappingManager() {
    return {
      async resolvePythonMethodAtPosition(pythonFile: string, line: number, character: number) {
        if (pythonFile === '/workspace/scripts/base/Hero.py' && line === 2 && character >= 8) {
          return {
            filePath: pythonFile,
            methodName: 'attack',
            line: 2,
            character: 8
          };
        }

        return null;
      },
      async resolveMethodImplementation(entityName: string, methodName: string, section: string) {
        if (entityName === 'Hero' && methodName === 'attack' && section === 'BaseMethods') {
          return {
            filePath: '/workspace/scripts/base/Hero.py',
            line: 2,
            character: 8
          };
        }

        return null;
      },
      async getIncomingPythonMethodCalls(pythonFile: string, methodName: string) {
        if (pythonFile === '/workspace/scripts/base/Hero.py' && methodName === 'attack') {
          return [{
            caller: {
              filePath: '/workspace/scripts/base/Hero.py',
              methodName: 'startBattle',
              line: 6,
              character: 8
            },
            callLine: 7,
            callCharacter: 13
          }];
        }

        return [];
      },
      async getOutgoingPythonMethodCalls(pythonFile: string, methodName: string) {
        if (pythonFile === '/workspace/scripts/base/Hero.py' && methodName === 'attack') {
          return [{
            filePath: '/workspace/scripts/base/Hero.py',
            methodName: 'broadcastDamage',
            line: 10,
            character: 8
          }];
        }

        return [];
      }
    };
  }

  it('prepares call hierarchy items for python method declarations', async () => {
    const provider = new KBEngineCallHierarchyProvider(createMappingManager() as never);
    const document = new FakeTextDocument(
      '/workspace/scripts/base/Hero.py',
      'python',
      [
        'class Hero:',
        '    def attack(self):',
        '        return None'
      ].join('\n')
    );

    const item = await provider.prepareCallHierarchy(
      document as never,
      new FakePosition(1, 10) as never
    ) as unknown as FakeCallHierarchyItem;

    assert.ok(item);
    assert.strictEqual(item.name, 'attack');
    assert.strictEqual(item.uri.fsPath, '/workspace/scripts/base/Hero.py');
    assert.strictEqual(item.selectionRange.start.line, 1);
    assert.strictEqual(item.selectionRange.start.character, 8);
  });

  it('bridges def methods into python call hierarchy items', async () => {
    const provider = new KBEngineCallHierarchyProvider(createMappingManager() as never);
    const document = new FakeTextDocument(
      '/workspace/scripts/entity_defs/Hero.def',
      'kbengine-def',
      [
        '<root>',
        '  <BaseMethods>',
        '    <attack>',
        '      <Arg>UINT32</Arg>',
        '    </attack>',
        '  </BaseMethods>',
        '</root>'
      ].join('\n')
    );

    const item = await provider.prepareCallHierarchy(
      document as never,
      new FakePosition(2, 7) as never
    ) as unknown as FakeCallHierarchyItem;

    assert.ok(item);
    assert.strictEqual(item.name, 'attack');
    assert.strictEqual(item.uri.fsPath, '/workspace/scripts/base/Hero.py');
  });

  it('returns incoming and outgoing python method calls', async () => {
    const provider = new KBEngineCallHierarchyProvider(createMappingManager() as never);
    const root = new FakeCallHierarchyItem(
      6,
      'attack',
      'Hero.py',
      { fsPath: '/workspace/scripts/base/Hero.py' } as never,
      { start: new FakePosition(1, 8), end: new FakePosition(1, 14) } as never,
      { start: new FakePosition(1, 8), end: new FakePosition(1, 14) } as never
    );

    const incoming = await provider.provideCallHierarchyIncomingCalls(root as never) as unknown as FakeCallHierarchyIncomingCall[];
    const outgoing = await provider.provideCallHierarchyOutgoingCalls(root as never) as unknown as FakeCallHierarchyOutgoingCall[];

    assert.strictEqual(incoming.length, 1);
    assert.strictEqual(incoming[0].from.name, 'startBattle');
    assert.strictEqual(incoming[0].fromRanges[0].start.line, 6);
    assert.strictEqual(incoming[0].fromRanges[0].start.character, 13);

    assert.strictEqual(outgoing.length, 1);
    assert.strictEqual(outgoing[0].to.name, 'broadcastDamage');
    assert.strictEqual(outgoing[0].fromRanges[0].start.line, 9);
    assert.strictEqual(outgoing[0].fromRanges[0].start.character, 8);
  });
});
