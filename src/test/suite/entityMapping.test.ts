import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  FakePosition,
  FakeRange,
  FakeUri,
  loadModuleWithMocks
} from './testUtils';
import type { EntityMappingManager } from '../../entityMapping';

type DefinitionSemanticsModule = typeof import('../../definitionSemantics');

interface OpenedLocation {
  path: string;
  line: number;
  character: number;
}

interface ManagerBundle {
  manager: EntityMappingManager;
  parseHero: () => Promise<void>;
  getOpened: () => OpenedLocation | undefined;
  restore: () => void;
}

const HERO_DEF_RELATIVE = 'scripts/entity_defs/Hero.def';
const IFACE_DEF_RELATIVE = 'scripts/entity_defs/interfaces/MoveIface.def';
const HERO_PY_RELATIVE = 'scripts/base/Hero.py';
const IFACE_PY_RELATIVE = 'scripts/interfaces/MoveIface.py';

// 行号与 KBEngine def 结构一致,断言全部基于这些行号:
// health=8, inventory=11, weapon=14, damage=17, attack=26, notify=32
const HERO_DEF_TEXT = [
  '<root>',                                                    // 1
  '  <Interfaces>',                                            // 2
  '    <Interface>',                                           // 3
  '      <MoveIface/>',                                        // 4
  '    </Interface>',                                          // 5
  '  </Interfaces>',                                           // 6
  '  <Properties>',                                            // 7
  '    <health>',                                              // 8
  '      <Type>UINT32</Type>',                                 // 9
  '    </health>',                                             // 10
  '    <inventory>',                                           // 11
  '      <Type>FIXED_DICT</Type>',                             // 12
  '      <Properties>',                                        // 13
  '        <weapon>',                                          // 14
  '          <Type>FIXED_DICT</Type>',                         // 15
  '          <Properties>',                                    // 16
  '            <damage>',                                      // 17
  '              <Type>UINT32</Type>',                         // 18
  '            </damage>',                                     // 19
  '          </Properties>',                                   // 20
  '        </weapon>',                                         // 21
  '      </Properties>',                                       // 22
  '    </inventory>',                                          // 23
  '  </Properties>',                                           // 24
  '  <BaseMethods>',                                           // 25
  '    <attack>',                                              // 26
  '      <Arg>UINT32</Arg>',                                   // 27
  '      <Exposed/>',                                          // 28
  '    </attack>',                                             // 29
  '  </BaseMethods>',                                          // 30
  '  <ClientMethods>',                                         // 31
  '    <notify>',                                              // 32
  '    </notify>',                                             // 33
  '  </ClientMethods>',                                        // 34
  '</root>'                                                    // 35
].join('\n');

// ifaceSpeed=3, dash=8, syncMove=13, notifyIface=17
const IFACE_DEF_TEXT = [
  '<root>',                                                    // 1
  '  <Properties>',                                            // 2
  '    <ifaceSpeed>',                                          // 3
  '      <Type>UINT32</Type>',                                 // 4
  '    </ifaceSpeed>',                                         // 5
  '  </Properties>',                                           // 6
  '  <BaseMethods>',                                           // 7
  '    <dash>',                                                // 8
  '      <Exposed/>',                                          // 9
  '    </dash>',                                               // 10
  '  </BaseMethods>',                                          // 11
  '  <CellMethods>',                                           // 12
  '    <syncMove>',                                            // 13
  '    </syncMove>',                                           // 14
  '  </CellMethods>',                                          // 15
  '  <ClientMethods>',                                         // 16
  '    <notifyIface>',                                         // 17
  '    </notifyIface>',                                        // 18
  '  </ClientMethods>',                                        // 19
  '</root>'                                                    // 20
].join('\n');

// attack 位于第 2 行、方法名在第 9 列(0 基)
const HERO_PY_TEXT = [
  'class Hero:',
  '    def attack(self, target):',
  '        return target',
  '',
  '    def notify(self):',
  '        return None'
].join('\n');

const IFACE_PY_TEXT = [
  'class MoveIface:',
  '    def dash(self):',
  '        return None'
].join('\n');

interface FixturePaths {
  root: string;
  heroDef: string;
  ifaceDef: string;
  heroPy: string;
  ifacePy: string;
}

function createWorkspaceFixture(withPythonFiles: boolean): FixturePaths {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-entity-mapping-'));
  for (const relative of [HERO_DEF_RELATIVE, IFACE_DEF_RELATIVE]) {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.writeFileSync(path.join(root, relative), relative === HERO_DEF_RELATIVE ? HERO_DEF_TEXT : IFACE_DEF_TEXT, 'utf8');
  }

  if (withPythonFiles) {
    for (const [relative, content] of [
      [HERO_PY_RELATIVE, HERO_PY_TEXT],
      [IFACE_PY_RELATIVE, IFACE_PY_TEXT]
    ] as const) {
      fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
      fs.writeFileSync(path.join(root, relative), content, 'utf8');
    }
  }

  return {
    root,
    heroDef: path.join(root, HERO_DEF_RELATIVE),
    ifaceDef: path.join(root, IFACE_DEF_RELATIVE),
    heroPy: path.join(root, HERO_PY_RELATIVE),
    ifacePy: path.join(root, IFACE_PY_RELATIVE)
  };
}

function destroyWorkspaceFixture(fixture: FixturePaths): void {
  fs.rmSync(fixture.root, { recursive: true, force: true });
}

function loadManagerBundle(fixture: FixturePaths): ManagerBundle {
  const opened: { value?: OpenedLocation } = {};

  class FakeWatcher {
    onDidChange(): { dispose(): void } {
      return { dispose: () => undefined };
    }

    onDidCreate(): { dispose(): void } {
      return { dispose: () => undefined };
    }

    onDidDelete(): { dispose(): void } {
      return { dispose: () => undefined };
    }
  }

  const fakeVscode = {
    workspace: {
      workspaceFolders: [{ uri: new FakeUri(fixture.root), name: 'fixture', index: 0 }],
      findFiles: async () => [],
      getConfiguration: (_section: string) => ({
        get: <T>(_key: string, defaultValue: T): T => defaultValue
      }),
      createFileSystemWatcher: () => new FakeWatcher(),
      openTextDocument: async (uri: FakeUri) => ({ uri })
    },
    window: {
      showTextDocument: async (document: { uri: FakeUri }, options: { selection: FakeRange }) => {
        opened.value = {
          path: document.uri.fsPath,
          line: options.selection.start.line,
          character: options.selection.start.character
        };
        return {};
      }
    },
    Uri: FakeUri,
    Position: FakePosition,
    Range: FakeRange
  };

  // 先加载 definitionSemantics(绑定本套件的 vscode stub),再加载 entityMapping,
  // 使 parseDefFile 内部 createDefinitionSemanticsLoader 拿到同一个 stub 世界。
  // 链上全部模块都强制重载:先前套件的全局 Module._load mock 曾让 definitionWorkspace
  // 绑定了白名单 fake fs,不重载就会继承污染,existsSync 对 tmp fixture 恒为 false。
  const parser = loadModuleWithMocks<typeof import('../../defParser')>(
    __filename,
    '../../defParser',
    { vscode: fakeVscode },
    true
  );
  const workspace = loadModuleWithMocks<typeof import('../../definitionWorkspace')>(
    __filename,
    '../../definitionWorkspace',
    { vscode: fakeVscode },
    true
  );
  const semantics = loadModuleWithMocks<DefinitionSemanticsModule>(
    __filename,
    '../../definitionSemantics',
    { vscode: fakeVscode },
    true
  );
  const mapping = loadModuleWithMocks<{
    EntityMappingManager: new (context: never) => EntityMappingManager;
  }>(
    __filename,
    '../../entityMapping',
    { vscode: fakeVscode },
    true
  );

  const manager = new mapping.loadedModule.EntityMappingManager({ subscriptions: [] } as never);
  const loader = semantics.loadedModule.createDefinitionSemanticsLoader(fixture.root);
  assert.ok(loader, 'definition semantics loader should resolve from the fixture workspace root');

  const restore = () => {
    mapping.restore();
    semantics.restore();
    workspace.restore();
    parser.restore();
  };

  return {
    manager,
    parseHero: async () => {
      // parseDefFile 是 private,但集成测试必须走真实解析链(def 解析 → 接口归并 → python 绑定)
      await (manager as unknown as {
        parseDefFile(entityName: string, defPath: string, loader?: unknown): Promise<void>;
      }).parseDefFile('Hero', fixture.heroDef, loader);
    },
    getOpened: () => opened.value,
    restore
  };
}

describe('EntityMappingManager with a real def/python fixture', () => {
  const cacheSnapshot = new Set(Object.keys(require.cache));
  let fixture: FixturePaths;
  let bundle: ManagerBundle | undefined;

  before(() => {
    fixture = createWorkspaceFixture(true);
  });

  after(() => {
    bundle?.restore();
    destroyWorkspaceFixture(fixture);
    // 丢弃绑定本套件 vscode stub 的重载模块,避免污染后续套件的 require 缓存
    for (const key of Object.keys(require.cache)) {
      if (!cacheSnapshot.has(key)) {
        delete require.cache[key];
      }
    }
  });

  function loadManager(): ManagerBundle {
    bundle?.restore();
    bundle = loadManagerBundle(fixture);
    return bundle;
  }

  it('parses nested properties and interface-backed methods from def files', async () => {
    const context = loadManager();
    await context.parseHero();

    const mapping = context.manager.getMapping('Hero');
    assert.ok(mapping);
    assert.strictEqual(mapping.name, 'Hero');
    assert.strictEqual(mapping.defFile, fixture.heroDef);
    assert.strictEqual(mapping.pythonFile, fixture.heroPy);
    assert.deepStrictEqual(
      mapping.pythonFiles.map(item => path.basename(item)),
      ['Hero.py', 'MoveIface.py']
    );

    assert.deepStrictEqual(Object.keys(mapping.properties).sort(), [
      'health',
      'ifaceSpeed',
      'inventory',
      'inventory.weapon',
      'inventory.weapon.damage'
    ]);
    assert.deepStrictEqual(mapping.properties.health, { defFile: fixture.heroDef, line: 8 });
    assert.deepStrictEqual(mapping.properties.inventory, { defFile: fixture.heroDef, line: 11 });
    assert.deepStrictEqual(mapping.properties['inventory.weapon'], { defFile: fixture.heroDef, line: 14 });
    assert.deepStrictEqual(mapping.properties['inventory.weapon.damage'], { defFile: fixture.heroDef, line: 17 });
    // 接口属性应回溯到接口 def 文件
    assert.deepStrictEqual(mapping.properties.ifaceSpeed, { defFile: fixture.ifaceDef, line: 3 });

    assert.deepStrictEqual(Object.keys(mapping.methods).sort(), [
      'attack',
      'dash',
      'notify',
      'notifyIface',
      'syncMove'
    ]);

    const attack = mapping.methods.attack[0];
    assert.ok(attack);
    assert.strictEqual(attack.defFile, fixture.heroDef);
    assert.strictEqual(attack.line, 26);
    assert.strictEqual(attack.section, 'BaseMethods');
    assert.strictEqual(attack.exposed, true);

    const notify = mapping.methods.notify[0];
    assert.ok(notify);
    assert.strictEqual(notify.defFile, fixture.heroDef);
    assert.strictEqual(notify.line, 32);
    assert.strictEqual(notify.section, 'ClientMethods');
    assert.strictEqual(notify.exposed, false);

    // 接口方法应回溯到接口 def 文件并保留接口来源
    const dash = mapping.methods.dash[0];
    assert.ok(dash);
    assert.strictEqual(dash.defFile, fixture.ifaceDef);
    assert.strictEqual(dash.line, 8);
    assert.strictEqual(dash.section, 'BaseMethods');
    assert.strictEqual(dash.exposed, true);
    assert.strictEqual(dash.identity.symbolName, 'dash');
    assert.strictEqual(dash.identity.ownerName, 'MoveIface');
  });

  it('resolves python property accesses to nested def property lines', async () => {
    const context = loadManager();
    await context.parseHero();

    const damage = await context.manager.resolvePropertyDefinition(fixture.heroPy, 'inventory.weapon.damage');
    assert.ok(damage);
    assert.strictEqual(damage.defFile, fixture.heroDef);
    assert.strictEqual(damage.line, 17);
  });

  it('opens the def file at the nested property line when jumping from python', async () => {
    const context = loadManager();
    await context.parseHero();

    const didOpen = await context.manager.jumpToDef(fixture.heroPy, 'inventory.weapon.damage', 'property');

    assert.strictEqual(didOpen, true);
    const opened = context.getOpened();
    assert.ok(opened);
    assert.strictEqual(opened.path, fixture.heroDef);
    assert.strictEqual(opened.line, 16, 'openFileAtLocation converts the 1-based def line to a 0-based cursor');
    assert.strictEqual(opened.character, 0);
  });

  it('opens the python implementation for an entity method requested by name', async () => {
    const context = loadManager();
    await context.parseHero();

    const didOpen = await context.manager.openMethodTarget('Hero', 'attack', 'BaseMethods');

    assert.strictEqual(didOpen, true);
    const opened = context.getOpened();
    assert.ok(opened);
    assert.strictEqual(opened.path, fixture.heroPy);
    assert.strictEqual(opened.line, 1);
    assert.strictEqual(opened.character, 8);
  });

  it('resolves interface methods and opens their interface python implementation', async () => {
    const context = loadManager();
    await context.parseHero();

    const dash = await context.manager.resolveMethodDefinition(fixture.ifacePy, 'dash');
    assert.ok(dash);
    assert.strictEqual(dash.defFile, fixture.ifaceDef);
    assert.strictEqual(dash.line, 8);
    assert.strictEqual(dash.section, 'BaseMethods');
    assert.strictEqual(dash.exposed, true);
    assert.strictEqual(dash.identity.ownerName, 'MoveIface');

    const didOpen = await context.manager.openMethodTarget(dash.identity);

    assert.strictEqual(didOpen, true);
    const opened = context.getOpened();
    assert.ok(opened);
    assert.strictEqual(opened.path, fixture.ifacePy);
    assert.strictEqual(opened.line, 1);
    assert.strictEqual(opened.character, 8);
  });

  it('resolves def symbols at a position into identity objects', async () => {
    const context = loadManager();
    await context.parseHero();

    const identity = await context.manager.resolveDefinitionSymbolAtPosition(
      fixture.heroDef,
      26,
      'attack',
      'BaseMethods'
    );

    assert.ok(identity);
    assert.strictEqual(identity.symbolName, 'attack');
    assert.strictEqual(identity.ownerName, 'Hero');
    assert.strictEqual(identity.ownerKind, 'entity');
    assert.strictEqual(identity.section, 'BaseMethods');
  });

  it('resolves the bound python implementation for entity and interface identities', async () => {
    const context = loadManager();
    await context.parseHero();

    const attackIdentity = await context.manager.resolveDefinitionSymbolAtPosition(
      fixture.heroDef,
      26,
      'attack',
      'BaseMethods'
    );
    assert.ok(attackIdentity);
    const attackImplementation = await context.manager.resolveMethodImplementationByIdentity(attackIdentity);
    assert.ok(attackImplementation);
    assert.strictEqual(attackImplementation.filePath, fixture.heroPy);
    assert.strictEqual(attackImplementation.line, 2);
    assert.strictEqual(attackImplementation.character, 8);

    // 接口符号不建独立索引,必须能回溯到引用它的实体索引;
    // identity 一律取自 resolveMethodDefinition 的真实返回,不手写字段
    const dashDefinition = await context.manager.resolveMethodDefinition(fixture.ifacePy, 'dash');
    assert.ok(dashDefinition);
    const dashImplementation = await context.manager.resolveMethodImplementationByIdentity(dashDefinition.identity);
    assert.ok(dashImplementation);
    assert.strictEqual(dashImplementation.filePath, fixture.ifacePy);
    assert.strictEqual(dashImplementation.line, 2);
    assert.strictEqual(dashImplementation.character, 8);
  });
});

describe('EntityMappingManager without python scripts', () => {
  const cacheSnapshot = new Set(Object.keys(require.cache));
  let fixture: FixturePaths;
  let bundle: ManagerBundle | undefined;

  before(() => {
    fixture = createWorkspaceFixture(false);
  });

  after(() => {
    bundle?.restore();
    destroyWorkspaceFixture(fixture);
    for (const key of Object.keys(require.cache)) {
      if (!cacheSnapshot.has(key)) {
        delete require.cache[key];
      }
    }
  });

  it('keeps def mappings with a fallback python path when scripts do not exist yet', async () => {
    bundle = loadManagerBundle(fixture);
    await bundle.parseHero();

    const mapping = bundle.manager.getMapping('Hero');
    assert.ok(mapping);
    assert.strictEqual(mapping.pythonFile, path.join(fixture.root, 'scripts/base/Hero.py'));
    assert.deepStrictEqual(
      mapping.pythonFiles.map(item => path.basename(item)),
      ['Hero.py']
    );
    assert.ok(mapping.properties.health);
    assert.ok(mapping.methods.attack);
    assert.ok(mapping.methods.dash, 'interface methods stay mapped even without python scripts');
  });
});
