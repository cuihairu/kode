import * as assert from 'assert';
import { loadModuleWithMocks } from './testUtils';

class FakePosition {
  constructor(public line: number, public character: number) {}
}

class FakeRange {
  constructor(public start: FakePosition, public end: FakePosition) {}
}

class FakeUri {
  constructor(public fsPath: string) {}

  static parse(fsPath: string): FakeUri {
    return new FakeUri(fsPath);
  }

  static file(fsPath: string): FakeUri {
    return new FakeUri(fsPath);
  }

  static joinPath(base: FakeUri, ...paths: string[]): FakeUri {
    return new FakeUri([base.fsPath, ...paths].join('/'));
  }

  toString(): string {
    return this.fsPath;
  }
}

class FakeWatcher {
  private changeHandler?: (uri: FakeUri) => void;

  onDidChange(handler: (uri: FakeUri) => void): void {
    this.changeHandler = handler;
  }

  fire(uri: FakeUri): void {
    this.changeHandler?.(uri);
  }

  dispose(): void {
    return;
  }
}

type EntityMappingModule = typeof import('../../entityMapping');

describe('EntityMappingManager', () => {
  const defPath = '/workspace/entity_defs/Hero.def';
  const pythonPath = '/workspace/scripts/base/Hero.py';
  const interfaceDefPath = '/workspace/entity_defs/interfaces/MoveIface.def';
  const interfacePythonPath = '/workspace/scripts/interfaces/MoveIface.py';
  const defText = [
    '<root>',
    '  <Interfaces>',
    '    <Interface>',
    '      <MoveIface/>',
    '    </Interface>',
    '  </Interfaces>',
    '  <Properties>',
    '    <health>',
    '      <Type>UINT32</Type>',
    '    </health>',
    '    <inventory>',
    '      <Type>FIXED_DICT</Type>',
    '      <Properties>',
    '        <weapon>',
    '          <Type>FIXED_DICT</Type>',
    '          <Properties>',
    '            <damage>',
    '              <Type>UINT32</Type>',
    '            </damage>',
    '          </Properties>',
    '        </weapon>',
    '      </Properties>',
    '    </inventory>',
    '  </Properties>',
    '  <BaseMethods>',
    '    <attack>',
    '      <Arg>UINT32</Arg>',
    '      <Exposed/>',
    '    </attack>',
    '  </BaseMethods>',
    '  <ClientMethods>',
    '    <notify>',
    '    </notify>',
    '  </ClientMethods>',
    '</root>'
  ].join('\n');
  const interfaceDefText = [
    '<root>',
    '  <Properties>',
    '    <ifaceSpeed>',
    '      <Type>UINT32</Type>',
    '    </ifaceSpeed>',
    '  </Properties>',
    '  <BaseMethods>',
    '    <dash>',
    '      <Exposed/>',
    '    </dash>',
    '  </BaseMethods>',
    '  <CellMethods>',
    '    <syncMove>',
    '    </syncMove>',
    '  </CellMethods>',
    '  <ClientMethods>',
    '    <notifyIface>',
    '    </notifyIface>',
    '  </ClientMethods>',
    '</root>'
  ].join('\n');

  let EntityMappingManager: EntityMappingModule['EntityMappingManager'];
  let openedSelection: FakeRange | undefined;
  let openDocumentPath: string | undefined;
  let restoreModuleMocks: (() => void) | undefined;
  let readFilePaths: string[] = [];

  function loadEntityMappingModule(hasPythonFiles = true): void {
    restoreModuleMocks?.();

    const fakeVscode = {
      workspace: {
        workspaceFolders: [{ uri: new FakeUri('/workspace') }],
        findFiles: async () => [],
        fs: {
          readFile: async (uri: FakeUri) => {
            readFilePaths.push(uri.fsPath);
            if (uri.fsPath === defPath) {
              return Buffer.from(defText, 'utf8');
            }

            if (uri.fsPath === interfaceDefPath) {
              return Buffer.from(interfaceDefText, 'utf8');
            }

            throw new Error(`Unexpected readFile path: ${uri.fsPath}`);
          }
        },
        createFileSystemWatcher: () => new FakeWatcher(),
        openTextDocument: async (uri: FakeUri) => {
          openDocumentPath = uri.fsPath;
          return { uri };
        }
      },
      window: {
        showTextDocument: async (_document: unknown, options: { selection: FakeRange }) => {
          openedSelection = options.selection;
          return {};
        }
      },
      Uri: FakeUri,
      Position: FakePosition,
      Range: FakeRange
    };

    const fakeFs = {
      existsSync(candidatePath: string) {
        if (!hasPythonFiles) {
          return false;
        }

        return candidatePath === pythonPath || candidatePath === interfacePythonPath;
      },
      readFileSync(candidatePath: string, encoding: string) {
        assert.strictEqual(encoding, 'utf8');

        if (candidatePath === pythonPath) {
          return [
            'class Hero:',
            '    def attack(self, target):',
            '        return target'
          ].join('\n');
        }

        if (candidatePath === interfacePythonPath) {
          return [
            'class MoveIface:',
            '    def dash(self):',
            '        return None'
          ].join('\n');
        }

        throw new Error(`Unexpected readFileSync path: ${candidatePath}`);
      }
    };

    const { loadedModule, restore } = loadModuleWithMocks<EntityMappingModule>(
      __filename,
      '../../entityMapping',
      {
        vscode: fakeVscode,
        fs: fakeFs,
        './definitionWorkspace': {
          findDefinitionFileByCategory(name: string, category: string) {
            if (name === 'MoveIface' && category === 'interface') {
              return interfaceDefPath;
            }

            return null;
          }
        }
      },
      true
    );
    restoreModuleMocks = restore;
    EntityMappingManager = loadedModule.EntityMappingManager;
  }

  before(() => {
    loadEntityMappingModule();
  });

  after(() => {
    restoreModuleMocks?.();
  });

  beforeEach(() => {
    openedSelection = undefined;
    openDocumentPath = undefined;
    readFilePaths = [];
  });

  it('parses nested properties and interface method mappings from def files', async () => {
    const manager = new EntityMappingManager({ subscriptions: [] } as never);

    await (manager as unknown as {
      parseDefFile(entityName: string, defPath: string): Promise<void>;
    }).parseDefFile('Hero', defPath);

    const mapping = manager.getMapping('Hero');
    assert.ok(mapping);
    assert.strictEqual(mapping?.pythonFile, pythonPath);
    assert.deepStrictEqual(mapping?.pythonFiles, [pythonPath, interfacePythonPath]);
    assert.deepStrictEqual(mapping?.properties, {
      health: { defFile: defPath, line: 8 },
      inventory: { defFile: defPath, line: 11 },
      'inventory.weapon': { defFile: defPath, line: 14 },
      'inventory.weapon.damage': { defFile: defPath, line: 17 },
      ifaceSpeed: { defFile: interfaceDefPath, line: 3 }
    });
    assert.deepStrictEqual(mapping?.methods, {
      attack: [{ defFile: defPath, line: 26, section: 'BaseMethods', exposed: true }],
      notify: [{ defFile: defPath, line: 32, section: 'ClientMethods', exposed: false }],
      dash: [{ defFile: interfaceDefPath, line: 8, section: 'BaseMethods', exposed: true }],
      syncMove: [{ defFile: interfaceDefPath, line: 13, section: 'CellMethods', exposed: false }],
      notifyIface: [{ defFile: interfaceDefPath, line: 17, section: 'ClientMethods', exposed: false }]
    });
    assert.deepStrictEqual(readFilePaths, [defPath, interfaceDefPath]);
  });

  it('opens the def file at the mapped line when jumping to a property', async () => {
    const manager = new EntityMappingManager({ subscriptions: [] } as never);

    await (manager as unknown as {
      parseDefFile(entityName: string, defPath: string): Promise<void>;
    }).parseDefFile('Hero', defPath);

    const didOpen = await manager.jumpToDef(pythonPath, 'inventory.weapon.damage', 'property');

    assert.strictEqual(didOpen, true);
    assert.strictEqual(openDocumentPath, defPath);
    assert.ok(openedSelection);
    assert.strictEqual(openedSelection?.start.line, 16);
    assert.strictEqual(openedSelection?.start.character, 0);
    assert.strictEqual(openedSelection?.end.line, 16);
    assert.strictEqual(openedSelection?.end.character, 0);
  });

  it('opens the python implementation for a mapped entity method before falling back to def', async () => {
    const manager = new EntityMappingManager({ subscriptions: [] } as never);

    await (manager as unknown as {
      parseDefFile(entityName: string, defPath: string): Promise<void>;
    }).parseDefFile('Hero', defPath);

    const didOpen = await manager.openMethodTarget('Hero', 'attack', 'BaseMethods');

    assert.strictEqual(didOpen, true);
    assert.strictEqual(openDocumentPath, pythonPath);
    assert.ok(openedSelection);
    assert.strictEqual(openedSelection?.start.line, 1);
    assert.strictEqual(openedSelection?.start.character, 0);
  });

  it('opens interface python implementations before falling back to interface def', async () => {
    const manager = new EntityMappingManager({ subscriptions: [] } as never);

    await (manager as unknown as {
      parseDefFile(entityName: string, defPath: string): Promise<void>;
    }).parseDefFile('Hero', defPath);

    const didOpen = await manager.openMethodTarget('Hero', 'dash', 'BaseMethods');

    assert.strictEqual(didOpen, true);
    assert.strictEqual(openDocumentPath, interfacePythonPath);
    assert.ok(openedSelection);
    assert.strictEqual(openedSelection?.start.line, 1);
  });

  it('resolves interface python files back to interface-based property and method definitions', async () => {
    const manager = new EntityMappingManager({ subscriptions: [] } as never);

    await (manager as unknown as {
      parseDefFile(entityName: string, defPath: string): Promise<void>;
    }).parseDefFile('Hero', defPath);

    const propertyDefinition = await manager.resolvePropertyDefinition(interfacePythonPath, 'ifaceSpeed', 'ifaceSpeed');
    const methodDefinition = await manager.resolveMethodDefinition(interfacePythonPath, 'dash');

    assert.deepStrictEqual(propertyDefinition, { defFile: interfaceDefPath, line: 3 });
    assert.deepStrictEqual(methodDefinition, {
      defFile: interfaceDefPath,
      line: 8,
      section: 'BaseMethods',
      exposed: true
    });
  });

  it('keeps def mappings even when no python script exists yet', async () => {
    loadEntityMappingModule(false);

    const manager = new EntityMappingManager({ subscriptions: [] } as never);
    await (manager as unknown as {
      parseDefFile(entityName: string, defPath: string): Promise<void>;
    }).parseDefFile('Hero', defPath);

    const mapping = manager.getMapping('Hero');
    assert.ok(mapping);
    assert.strictEqual(mapping?.pythonFile, '/workspace/scripts/base/Hero.py');
    assert.deepStrictEqual(mapping?.pythonFiles, ['/workspace/scripts/base/Hero.py']);
    assert.ok(mapping?.properties.health);
  });
});
