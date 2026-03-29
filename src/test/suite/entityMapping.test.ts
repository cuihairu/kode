import * as assert from 'assert';
import Module = require('module');

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
  const moduleLoader = Module as unknown as {
    _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
    createRequire(filename: string): NodeRequire;
  };

  const defPath = '/workspace/entity_defs/Hero.def';
  const pythonPath = '/workspace/assets/scripts/entity_defs/Hero.py';
  const defText = [
    '<root>',
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
    '    </attack>',
    '  </BaseMethods>',
    '  <ClientMethods>',
    '    <notify>',
    '    </notify>',
    '  </ClientMethods>',
    '</root>'
  ].join('\n');

  let originalLoad: typeof moduleLoader._load;
  let EntityMappingManager: EntityMappingModule['EntityMappingManager'];
  let openedSelection: FakeRange | undefined;
  let openDocumentPath: string | undefined;

  before(() => {
    const fakeVscode = {
      workspace: {
        workspaceFolders: [{ uri: new FakeUri('/workspace') }],
        findFiles: async () => [],
        fs: {
          readFile: async (uri: FakeUri) => {
            assert.strictEqual(uri.fsPath, defPath);
            return Buffer.from(defText, 'utf8');
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
        return candidatePath === pythonPath;
      }
    };

    originalLoad = moduleLoader._load;
    moduleLoader._load = function patchedLoad(request: string, parent: NodeModule | null, isMain: boolean) {
      if (request === 'vscode') {
        return fakeVscode;
      }

      if (request === 'fs') {
        return fakeFs;
      }

      return originalLoad(request, parent, isMain);
    };

    const runtimeRequire = moduleLoader.createRequire(__filename);
    const entityMappingModule = runtimeRequire('../../entityMapping') as EntityMappingModule;
    EntityMappingManager = entityMappingModule.EntityMappingManager;
  });

  after(() => {
    moduleLoader._load = originalLoad;
  });

  beforeEach(() => {
    openedSelection = undefined;
    openDocumentPath = undefined;
  });

  it('parses nested properties and method mappings from def files', async () => {
    const manager = new EntityMappingManager({ subscriptions: [] } as never);

    await (manager as unknown as {
      parseDefFile(entityName: string, defPath: string): Promise<void>;
    }).parseDefFile('Hero', defPath);

    const mapping = manager.getMapping('Hero');
    assert.ok(mapping);
    assert.strictEqual(mapping?.pythonFile, pythonPath);
    assert.deepStrictEqual(mapping?.properties, {
      health: { defFile: defPath, line: 3 },
      inventory: { defFile: defPath, line: 6 },
      'inventory.weapon': { defFile: defPath, line: 9 },
      'inventory.weapon.damage': { defFile: defPath, line: 12 }
    });
    assert.deepStrictEqual(mapping?.methods, {
      attack: { defFile: defPath, line: 21 },
      notify: { defFile: defPath, line: 26 }
    });
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
    assert.strictEqual(openedSelection?.start.line, 11);
    assert.strictEqual(openedSelection?.start.character, 0);
    assert.strictEqual(openedSelection?.end.line, 11);
    assert.strictEqual(openedSelection?.end.character, 0);
  });
});
