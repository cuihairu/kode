import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EntityMappingManager } from '../src/entityMapping';
import {
  Position,
  Range,
  Uri,
  lastFileSystemWatcher,
  workspace as stubWorkspace,
  window as stubWindow
} from './helpers/vscodeStub';

// EntityMappingManager 类本体:构造即扫描 scripts/entity_defs 并挂 python
// watcher。测试用真实临时文件树 + stub findFiles 枚举,走 buildIndex →
// storeIndex → 查询/解析/调用图/打开目标的完整链路。真实 watcher 与编辑器
// 行为由 mocha 层覆盖。

const p = (root: string, ...segments: string[]) => path.join(root, ...segments);

const write = (root: string, relative: string, content: string) => {
  const target = p(root, ...relative.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
};

const until = async (condition: () => boolean, what: string): Promise<void> => {
  for (let i = 0; i < 500; i += 1) {
    if (condition()) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`timeout waiting for ${what}`);
};

const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 15));

const originalFindFiles = stubWorkspace.findFiles;
const originalOpenTextDocument = stubWorkspace.openTextDocument;
const originalShowTextDocument = stubWindow.showTextDocument;

beforeAll(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-mapping-'));
  (globalThis as { __mappingRoot?: string }).__mappingRoot = root;

  write(root, 'scripts/entities.xml', [
    '<root>',
    '  <Hero hasBase="true" hasCell="true" hasClient="true"/>',
    '  <Monster hasBase="true"/>',
    '  <Ghost hasBase="true"/>',
    '</root>'
  ].join('\n'));

  write(root, 'scripts/entity_defs/Hero.def', [
    '<root>',
    '  <Properties>',
    '    <hp>',
    '      <Type>UINT32</Type>',
    '      <Flags>BASE</Flags>',
    '      <Persistent>true</Persistent>',
    '    </hp>',
    '  </Properties>',
    '  <Interfaces>',
    '    <MoveIface/>',
    '  </Interfaces>',
    '  <Components>',
    '    <healthPack>',
    '      <Type>HealthComp</Type>',
    '    </healthPack>',
    '  </Components>',
    '  <BaseMethods>',
    '    <onSave>',
    '      <Arg>UINT32</Arg>',
    '      <Exposed/>',
    '    </onSave>',
    '  </BaseMethods>',
    '  <CellMethods>',
    '    <move/>',
    '  </CellMethods>',
    '  <ClientMethods>',
    '    <onSave/>',
    '    <show/>',
    '  </ClientMethods>',
    '</root>'
  ].join('\n'));

  write(root, 'scripts/entity_defs/Monster.def', [
    '<root>',
    '  <Properties>',
    '    <ferocity>',
    '      <Type>UINT32</Type>',
    '      <Flags>BASE</Flags>',
    '    </ferocity>',
    '  </Properties>',
    '  <BaseMethods>',
    '    <roar/>',
    '  </BaseMethods>',
    '</root>'
  ].join('\n'));

  write(root, 'scripts/entity_defs/Ghost.def', [
    '<root>',
    '  <BaseMethods>',
    '    <roar/>',
    '  </BaseMethods>',
    '</root>'
  ].join('\n'));

  write(root, 'scripts/entity_defs/interfaces/MoveIface.def', [
    '<root>',
    '  <Properties>',
    '    <stride>',
    '      <Type>UINT8</Type>',
    '      <Flags>ALL_CLIENTS</Flags>',
    '    </stride>',
    '  </Properties>',
    '  <BaseMethods>',
    '    <onMove/>',
    '  </BaseMethods>',
    '</root>'
  ].join('\n'));

  write(root, 'scripts/entity_defs/components/HealthComp.def', [
    '<root>',
    '  <Properties>',
    '    <regen>',
    '      <Type>UINT32</Type>',
    '      <Flags>CELL_PRIVATE</Flags>',
    '    </regen>',
    '  </Properties>',
    '  <BaseMethods>',
    '    <apply/>',
    '  </BaseMethods>',
    '</root>'
  ].join('\n'));

  write(root, 'scripts/entity_defs/types.xml', [
    '<root>',
    '  <ITEM_ID>UINT16</ITEM_ID>',
    '</root>'
  ].join('\n'));

  write(root, 'scripts/base/Hero.py', [
    'class Hero(object):',
    '    def onSave(self, baseId, arg):',
    '        self._pack(1)',
    '        self._pack(2)',
    '        self.missingCall()',
    '',
    '    def _pack(self, arg):',
    '        pass',
    ''
  ].join('\n'));
  write(root, 'scripts/cell/Hero.py', 'class Hero(object):\n    def move(self):\n        pass\n');
  write(root, 'scripts/client/Hero.py', 'class Hero(object):\n    def onSave(self):\n        pass\n\n    def show(self):\n        pass\n');
  write(root, 'scripts/base/Monster.py', 'class Monster(object):\n    def roar(self):\n        pass\n');
  write(root, 'scripts/interfaces/MoveIface.py', 'class MoveIface(object):\n    def onMove(self):\n        pass\n');
  write(root, 'scripts/base/components/HealthComp.py', 'class HealthComp(object):\n    def apply(self):\n        pass\n');

  stubWorkspace.workspaceFolders = [
    { uri: Uri.file(root), name: 'ws', index: 0 }
  ];
  stubWorkspace.findFiles = async () => {
    const results: Uri[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = p(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.name.endsWith('.def')) {
          results.push(Uri.file(full));
        }
      }
    };
    walk(root);
    return results;
  };

  (globalThis as { __mappingManager?: EntityMappingManager }).__mappingManager =
    new EntityMappingManager({ subscriptions: [] });
  const manager = managerRef();

  await until(() => manager.getAllMappings().length >= 3, 'initial scan');
});

afterAll(() => {
  managerRef().dispose();
  stubWorkspace.findFiles = originalFindFiles;
  stubWorkspace.openTextDocument = originalOpenTextDocument;
  stubWindow.showTextDocument = originalShowTextDocument;
  stubWorkspace.workspaceFolders = [];
  lastFileSystemWatcher.current = null;

  const root = (globalThis as { __mappingRoot?: string }).__mappingRoot;
  if (root) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const managerRef = (): EntityMappingManager =>
  (globalThis as { __mappingManager?: EntityMappingManager }).__mappingManager as EntityMappingManager;

const mappingRoot = (): string =>
  (globalThis as { __mappingRoot?: string }).__mappingRoot as string;

const heroPython = (): string => p(mappingRoot(), 'scripts', 'base', 'Hero.py');
const heroDef = (): string => p(mappingRoot(), 'scripts', 'entity_defs', 'Hero.def');

const withOpenedFiles = async (
  body: (opened: Uri[], shown: Array<{ document: unknown; options: unknown }>) => Promise<void>,
  editor: unknown
): Promise<void> => {
  const opened: Uri[] = [];
  const shown: Array<{ document: unknown; options: unknown }> = [];
  stubWorkspace.openTextDocument = async (uri: Uri) => {
    opened.push(uri);
    return { uri };
  };
  stubWindow.showTextDocument = async (document: unknown, options?: unknown) => {
    shown.push({ document, options });
    return editor;
  };
  try {
    await body(opened, shown);
  } finally {
    stubWorkspace.openTextDocument = originalOpenTextDocument;
    stubWindow.showTextDocument = originalShowTextDocument;
  }
};

describe('EntityMappingManager scan and legacy mappings', () => {
  it('registers the python watcher in context subscriptions on construction', () => {
    expect(lastFileSystemWatcher.current).not.toBeNull();
  });

  it('scans entity defs from the real workspace tree', () => {
    const names = managerRef().getAllMappings().map(mapping => mapping.name).sort();
    expect(names).toEqual(['Ghost', 'Hero', 'Monster']);
  });

  it('exposes the legacy mapping with per-section python files', () => {
    const mapping = managerRef().getMapping('Hero');
    expect(mapping?.name).toBe('Hero');
    expect(mapping?.defFile).toBe(heroDef());
    expect(mapping?.pythonFile).toBe(heroPython());
    // owner 文件含实体段、混入接口与组件实现
    expect(mapping?.pythonFiles.map(file => path.dirname(file).split(path.sep).pop()).sort())
      .toEqual(['base', 'cell', 'client', 'components', 'interfaces']);
  });

  it('falls back to the conventional python path without owner files', () => {
    const mapping = managerRef().getMapping('Ghost');
    const fallback = p(mappingRoot(), 'scripts', 'base', 'Ghost.py');
    expect(mapping?.pythonFile).toBe(fallback);
    expect(mapping?.pythonFiles).toEqual([fallback]);
  });

  it('looks up mappings by entity name and python owner file', () => {
    expect(managerRef().getMapping('Nope')).toBeUndefined();
    expect(managerRef().getMappingForPythonFile(heroPython())?.name).toBe('Hero');
    expect(managerRef().getMappingForPythonFile('/nowhere/Foo.py')).toBeUndefined();
  });
});

describe('resolvePropertyDefinition and resolveMethodDefinition', () => {
  it('resolves a property by its full path', async () => {
    const location = await managerRef().resolvePropertyDefinition(heroPython(), 'hp');
    expect(location?.defFile).toBe(heroDef());
    expect(location?.identity.symbolName).toBe('hp');
    expect(location?.identity.ownerKind).toBe('entity');
  });

  it('falls back to the root symbol when the full path misses', async () => {
    const location = await managerRef().resolvePropertyDefinition(heroPython(), 'hp.extra', 'hp');
    expect(location?.identity.symbolName).toBe('hp');
  });

  it('returns null when nothing matches', async () => {
    expect(await managerRef().resolvePropertyDefinition(heroPython(), 'nope')).toBeNull();
    expect(await managerRef().resolvePropertyDefinition('/nowhere/Foo.py', 'hp')).toBeNull();
  });

  it('resolves a method preferring the inferred section', async () => {
    const location = await managerRef().resolveMethodDefinition(heroPython(), 'onSave');
    expect(location?.section).toBe('BaseMethods');
    expect(location?.exposed).toBe(true);
    expect(location?.identity.ownerName).toBe('Hero');
    expect(location?.defFile).toBe(heroDef());
  });

  it('returns null for unknown methods or unknown owners', async () => {
    expect(await managerRef().resolveMethodDefinition(heroPython(), 'nope')).toBeNull();
    expect(await managerRef().resolveMethodDefinition('/nowhere/Foo.py', 'onSave')).toBeNull();
  });

  it('resolves the definition identity at a property line', async () => {
    const line = managerRef().getMapping('Hero')?.properties.hp.line;
    expect(line).toBeGreaterThan(0);
    const identity = await managerRef().resolveDefinitionSymbolAtPosition(
      heroDef(), line as number, 'hp', undefined, 'hp'
    );
    expect(identity?.propertyPath).toBe('hp');
    expect(identity?.ownerKind).toBe('entity');
  });

  it('resolves the definition identity at a method line', async () => {
    const onSave = managerRef().getMapping('Hero')?.methods.onSave
      ?.find(item => item.section === 'BaseMethods');
    expect(onSave).toBeDefined();
    const identity = await managerRef().resolveDefinitionSymbolAtPosition(
      heroDef(), onSave?.line as number, 'onSave', 'BaseMethods'
    );
    expect(identity?.section).toBe('BaseMethods');
    expect(identity?.symbolName).toBe('onSave');
  });

  it('returns null without a property path or section, or for unknown defs', async () => {
    expect(await managerRef().resolveDefinitionSymbolAtPosition(heroDef(), 1, 'hp'))
      .toBeNull();
    expect(await managerRef().resolveDefinitionSymbolAtPosition('/nowhere/Nope.def', 1, 'x', 'BaseMethods'))
      .toBeNull();
  });
});

describe('python positions and call graph', () => {
  it('resolves the python method enclosing a position', async () => {
    // '    def onSave' 的方法名起始列是 8(4 空格 + 'def ' + 空格)
    const atDefinition = await managerRef().resolvePythonMethodAtPosition(heroPython(), 2, 8);
    expect(atDefinition?.methodName).toBe('onSave');
    expect(atDefinition?.filePath).toBe(heroPython());

    // 首行 character 小于方法名起始列 → 不命中;块内后续行命中
    expect(await managerRef().resolvePythonMethodAtPosition(heroPython(), 2, 0)).toBeNull();
    const insideBody = await managerRef().resolvePythonMethodAtPosition(heroPython(), 3, 0);
    expect(insideBody?.methodName).toBe('onSave');
  });

  it('returns null without an index for the python file', async () => {
    expect(await managerRef().resolvePythonMethodAtPosition('/nowhere/Foo.py', 1, 0)).toBeNull();
  });

  it('lists deduplicated outgoing calls resolved inside the index', async () => {
    const outgoing = await managerRef().getOutgoingPythonMethodCalls(heroPython(), 'onSave');
    // _pack 调用两次去重为一条;missingCall 无解析被跳过
    expect(outgoing).toHaveLength(1);
    expect(outgoing[0].methodName).toBe('_pack');
    expect(outgoing[0].filePath).toBe(heroPython());
    expect(outgoing[0].line).toBe(7);
  });

  it('returns empty outgoing calls for unknown methods or files', async () => {
    expect(await managerRef().getOutgoingPythonMethodCalls(heroPython(), 'nope')).toEqual([]);
    expect(await managerRef().getOutgoingPythonMethodCalls('/nowhere/Foo.py', 'onSave')).toEqual([]);
  });

  it('lists incoming calls with their call site positions', async () => {
    const incoming = await managerRef().getIncomingPythonMethodCalls(heroPython(), '_pack');
    expect(incoming).toHaveLength(2);
    expect(incoming.map(item => item.caller.methodName)).toEqual(['onSave', 'onSave']);
    expect(incoming.map(item => item.callLine)).toEqual([3, 4]);
  });

  it('returns empty incoming calls without an index', async () => {
    expect(await managerRef().getIncomingPythonMethodCalls('/nowhere/Foo.py', 'x')).toEqual([]);
  });
});

describe('method implementation and opening targets', () => {
  it('resolves the implementation through the python binding', async () => {
    const location = await managerRef().resolveMethodDefinition(heroPython(), 'onSave');
    expect(location).not.toBeNull();
    const implementation = await managerRef().resolveMethodImplementationByIdentity(location!.identity);
    expect(implementation?.filePath).toBe(heroPython());
    expect(implementation?.line).toBe(2);
    expect(implementation?.character).toBe(8);
  });

  it('returns null when the owner has no python implementation', async () => {
    expect(await managerRef().resolveMethodImplementation('Ghost', 'roar', 'BaseMethods')).toBeNull();
    expect(await managerRef().resolveMethodImplementation('Nope', 'x', 'BaseMethods')).toBeNull();
  });

  it('resolves a legacy implementation by entity name', async () => {
    const implementation = await managerRef().resolveMethodImplementation('Monster', 'roar', 'BaseMethods');
    expect(implementation?.filePath).toBe(p(mappingRoot(), 'scripts', 'base', 'Monster.py'));
    expect(implementation?.line).toBe(2);
  });

  it('opens the python implementation for an identity', async () => {
    const location = await managerRef().resolveMethodDefinition(heroPython(), 'onSave');
    await withOpenedFiles(async (opened, shown) => {
      const openedEditor = await managerRef().openMethodTarget(location!.identity);
      expect(openedEditor).toBe(true);
      expect(opened[0].fsPath).toBe(heroPython());
      const options = shown[0].options as { selection?: Range };
      expect(options.selection?.start).toEqual(new Position(1, 8));
    }, {});
  });

  it('opens the def file when no implementation exists', async () => {
    await withOpenedFiles(async opened => {
      const openedEditor = await managerRef().openMethodTarget('Ghost', 'roar', 'BaseMethods');
      expect(openedEditor).toBe(true);
      expect(opened[0].fsPath).toBe(p(mappingRoot(), 'scripts', 'entity_defs', 'Ghost.def'));
    }, {});
  });

  it('returns false when the editor refuses to open', async () => {
    const location = await managerRef().resolveMethodDefinition(heroPython(), 'onSave');
    await withOpenedFiles(async (_opened, _shown) => {
      const openedEditor = await managerRef().openMethodTarget(location!.identity);
      expect(openedEditor).toBe(false);
    }, undefined);
  });

  it('returns false for an incomplete legacy identity', async () => {
    expect(await managerRef().openMethodTarget('')).toBe(false);
  });

  it('opens the property definition via jumpToDef', async () => {
    await withOpenedFiles(async opened => {
      expect(await managerRef().jumpToDef(heroPython(), 'hp', 'property')).toBe(true);
      expect(opened[0].fsPath).toBe(heroDef());
    }, {});
  });

  it('returns false from jumpToDef for unknown symbols', async () => {
    expect(await managerRef().jumpToDef(heroPython(), 'nope', 'method')).toBe(false);
    expect(await managerRef().jumpToDef('/nowhere/Foo.py', 'hp', 'property')).toBe(false);
  });
});

describe('watcher and lifecycle', () => {
  it('rescans the owning entity when a python owner file changes', async () => {
    const watcher = lastFileSystemWatcher.current;
    expect(watcher).not.toBeNull();

    watcher!.fireChange(Uri.file(heroPython()));
    await tick();

    const atMethod = await managerRef().resolvePythonMethodAtPosition(heroPython(), 2, 8);
    expect(atMethod?.methodName).toBe('onSave');
  });

  it('ignores changes outside the known owner files', async () => {
    const watcher = lastFileSystemWatcher.current;
    watcher!.fireChange(Uri.file('/nowhere/Foo.py'));
    await tick();
    expect(managerRef().getMapping('Hero')).toBeDefined();
  });

  it('dispose is idempotent and keeps queries working', () => {
    managerRef().dispose();
    managerRef().dispose();
    expect(managerRef().getMapping('Hero')).toBeDefined();
  });

  it('constructs safely without a workspace folder', async () => {
    stubWorkspace.workspaceFolders = [];
    try {
      const orphan = new EntityMappingManager({ subscriptions: [] });
      await tick();
      expect(orphan.getMapping('Hero')).toBeUndefined();
      expect(await orphan.resolveMethodDefinition(heroPython(), 'onSave')).toBeNull();
      orphan.dispose();
    } finally {
      stubWorkspace.workspaceFolders = [
        { uri: Uri.file(mappingRoot()), name: 'ws', index: 0 }
      ];
    }
  });
});
