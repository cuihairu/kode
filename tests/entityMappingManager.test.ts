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
// 行为已由本文件用例覆盖(「watcher and lifecycle」fireChange 重扫/no-op/
// dispose 幂等;批75 核对修正,原 mocha 声明系批56 裁剪前的过期表述)。

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
    '    <interface>MoveIface</interface>',
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

describe('resolvePropertyDefinitionInfo(带类型/可见域/持久化,批135)', () => {
  it('resolves the declaration surface of a direct property', async () => {
    const info = await managerRef().resolvePropertyDefinitionInfo(heroPython(), 'hp');

    expect(info?.identity.symbolName).toBe('hp');
    expect(info?.typeName).toBe('UINT32');
    expect(info?.domains).toEqual(['base']);
    expect(info?.persistent).toBe(true);
    expect(info?.defFile).toBe(heroDef());
  });

  it('carries the same resolution as resolvePropertyDefinition', async () => {
    const location = await managerRef().resolvePropertyDefinition(heroPython(), 'hp.extra', 'hp');
    const info = await managerRef().resolvePropertyDefinitionInfo(heroPython(), 'hp.extra', 'hp');

    expect(info?.identity).toEqual(location?.identity);
    expect(info?.typeName).toBe('UINT32');
    expect(info?.persistent).toBe(true);
  });

  it('resolves component properties by their slot path with the slot name', async () => {
    const info = await managerRef().resolvePropertyDefinitionInfo(
      heroPython(), 'healthPack.regen', 'healthPack'
    );

    expect(info?.identity.symbolName).toBe('regen');
    expect(info?.identity.componentSlotName).toBe('healthPack');
    expect(info?.typeName).toBe('UINT32');
    expect(info?.domains).toEqual(['cell']);
    // HealthComp.regen 无 <Persistent> 元素,缺省非持久
    expect(info?.persistent).toBe(false);
    expect(info?.defFile).toBe(
      p(mappingRoot(), 'scripts', 'entity_defs', 'components', 'HealthComp.def')
    );
  });

  it('resolves inherited interface properties with their own domains', async () => {
    const info = await managerRef().resolvePropertyDefinitionInfo(heroPython(), 'stride');

    expect(info?.identity.symbolName).toBe('stride');
    expect(info?.identity.ownerKind).toBe('interface');
    expect(info?.typeName).toBe('UINT8');
    expect(info?.domains).toEqual(['cell', 'client']);
    expect(info?.persistent).toBe(false);
  });

  it('returns null when nothing matches', async () => {
    expect(await managerRef().resolvePropertyDefinitionInfo(heroPython(), 'nope')).toBeNull();
    expect(await managerRef().resolvePropertyDefinitionInfo('/nowhere/Foo.py', 'hp')).toBeNull();
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

// 批132:getPythonScriptRoots 的两条分支直测(经私有方法 cast 调用)。
// 真资产走 getPythonCandidates 全链已在 kbengineDemoAssets 走查里咬合;
// 这里只锁根候选本身:嵌套资产根增补、不可识别 defs 目录回落工作区链。
describe('getPythonScriptRoots', () => {
  const rootsOf = (
    workspaceRoot: string,
    owner: { kind: string; name: string; filePath: string }
  ): string[] => {
    const probe = new EntityMappingManager({ subscriptions: [] });
    try {
      return (probe as unknown as {
        getPythonScriptRoots(root: string, ref: unknown): string[];
      }).getPythonScriptRoots(workspaceRoot, owner as never);
    } finally {
      probe.dispose();
    }
  };

  it('def 在嵌套资产根的 entity_defs 下时,增补该资产 scripts 根', () => {
    const root = mappingRoot();
    const roots = rootsOf(root, {
      kind: 'entity',
      name: 'Hero',
      filePath: p(root, 'kbengine_demo_assets', 'scripts', 'entity_defs', 'Hero.def')
    });
    // 前三位保持工作区相对候选(扁平布局顺序不变),嵌套资产根只增补在末尾
    expect(roots.slice(0, 3)).toEqual([
      p(root, 'scripts'),
      p(root, 'assets', 'scripts'),
      p(root, 'server_assets', 'scripts')
    ]);
    expect(roots[3]).toBe(p(root, 'kbengine_demo_assets', 'scripts'));
  });

  it('def 不在可识别 defs 目录时,只回落三条工作区候选', () => {
    const root = mappingRoot();
    const roots = rootsOf(root, {
      kind: 'entity',
      name: 'Loner',
      filePath: p(root, 'weird', 'defs', 'Loner.def')
    });
    expect(roots).toEqual([
      p(root, 'scripts'),
      p(root, 'assets', 'scripts'),
      p(root, 'server_assets', 'scripts')
    ]);
  });
});

describe('IDE-IDX-003 实体名查询携带调用文档根', () => {
  it('A/B 同名实体由调用文件根决定,不靠最后注册者覆盖', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-mapping-dual-'));
    try {
      for (const [project, marker] of [['a', 'on_a'], ['b', 'on_b']] as Array<[string, string]>) {
        write(root, `${project}/scripts/entities.xml`, '<root>\n  <Hero hasBase="true"/>\n</root>');
        write(root, `${project}/scripts/entity_defs/Hero.def`,
          `<root>\n  <BaseMethods>\n    <${marker}/>\n  </BaseMethods>\n</root>`);
        write(root, `${project}/scripts/base/Hero.py`,
          `class Hero(object):\n    def ${marker}(self):\n        pass\n`);
      }
      const originalFolders = stubWorkspace.workspaceFolders;
      const originalFind = stubWorkspace.findFiles;
      stubWorkspace.workspaceFolders = [{ uri: Uri.file(root), name: 'dual', index: 0 }];
      stubWorkspace.findFiles = async () => {
        const results: Uri[] = [];
        const walk = (dir: string) => {
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = p(dir, entry.name);
            if (entry.isDirectory()) { walk(full); }
            else if (entry.name.endsWith('.def')) { results.push(Uri.file(full)); }
          }
        };
        walk(root);
        return results;
      };
      const manager = new EntityMappingManager({ subscriptions: [] });
      try {
        // 同名实体在名字槽位只占一格,按 def 文件粒度等两份都建好
        const indexCount = (): number =>
          (manager as unknown as { mappingIndexesByRoot: Map<string, unknown> }).mappingIndexesByRoot.size;
        await until(() => indexCount() >= 2, 'dual-root scan');
        // 类查询显式携带调用文件根:A 根调用拿 A 的 def,B 根调用拿 B 的 def
        const fromA = await manager.resolveMethodDefinitionForClass(
          'Hero', 'on_a', undefined, p(root, 'a', 'scripts', 'base', 'Hero.py')
        );
        expect(fromA).toMatchObject({ defFile: p(root, 'a', 'scripts', 'entity_defs', 'Hero.def') });
        const fromB = await manager.resolveMethodDefinitionForClass(
          'Hero', 'on_b', undefined, p(root, 'b', 'scripts', 'base', 'Hero.py')
        );
        expect(fromB).toMatchObject({ defFile: p(root, 'b', 'scripts', 'entity_defs', 'Hero.def') });
        // 反向不串根:A 根查 B 独有方法 → null
        const wrongFromA = await manager.resolveMethodDefinitionForClass(
          'Hero', 'on_b', undefined, p(root, 'a', 'scripts', 'base', 'Hero.py')
        );
        expect(wrongFromA).toBeNull();
      } finally {
        manager.dispose();
        stubWorkspace.workspaceFolders = originalFolders;
        stubWorkspace.findFiles = originalFind;
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('IDE-IDX-005 保存共享脚本刷新全部依赖实体', () => {
  it('Shared.py 变更后 A/B 行号与绑定均更新,未依赖实体 C 不刷新', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-mapping-shared-'));
    try {
      write(root, 'scripts/entities.xml',
        '<root>\n  <A hasBase="true"/>\n  <B hasBase="true"/>\n  <C hasBase="true"/>\n</root>');
      // A/B 同引接口 Shared(共享 owner 脚本);C 不引用
      for (const entity of ['A', 'B']) {
        write(root, `scripts/entity_defs/${entity}.def`, [
          '<root>',
          '  <Interfaces>',
          '    <interface>Shared</interface>',
          '  </Interfaces>',
          '  <BaseMethods>',
          `    <on${entity}/>`,
          '  </BaseMethods>',
          '</root>'
        ].join('\n'));
        write(root, `scripts/base/${entity}.py`,
          `class ${entity}(object):\n    def on${entity}(self):\n        pass\n`);
      }
      write(root, 'scripts/entity_defs/C.def',
        '<root>\n  <BaseMethods>\n    <onC/>\n  </BaseMethods>\n</root>');
      write(root, 'scripts/base/C.py', 'class C(object):\n    def onC(self):\n        pass\n');
      write(root, 'scripts/entity_defs/interfaces/Shared.def',
        '<root>\n  <BaseMethods>\n    <onShared/>\n    <onExtra/>\n  </BaseMethods>\n</root>');
      // base/interfaces 形态:inferMethodSection 推得 BaseMethods,接口绑定键可命中
      const sharedPy = p(root, 'scripts', 'base', 'interfaces', 'Shared.py');
      write(root, 'scripts/base/interfaces/Shared.py',
        'class Shared(object):\n    def onShared(self):\n        pass\n');

      const originalFolders = stubWorkspace.workspaceFolders;
      const originalFind = stubWorkspace.findFiles;
      stubWorkspace.workspaceFolders = [{ uri: Uri.file(root), name: 'shared', index: 0 }];
      stubWorkspace.findFiles = async () => {
        const results: Uri[] = [];
        const walk = (dir: string) => {
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = p(dir, entry.name);
            if (entry.isDirectory()) { walk(full); }
            else if (entry.name.endsWith('.def')) { results.push(Uri.file(full)); }
          }
        };
        walk(root);
        return results;
      };
      const manager = new EntityMappingManager({ subscriptions: [] });
      try {
        interface MethodEntry { methodName: string; filePath: string; line: number; binding?: unknown }
        const indexes = (): Map<string, { pythonMethods: MethodEntry[] }> =>
          (manager as unknown as { mappingIndexes: Map<string, { pythonMethods: MethodEntry[] }> }).mappingIndexes;
        await until(() => indexes().size >= 3, 'shared-fixture scan');
        const sharedMethod = (entity: string, name: string): MethodEntry | undefined =>
          indexes().get(entity)?.pythonMethods.find(method =>
            method.methodName === name && method.filePath === sharedPy);

        // 基线:onShared 行 2 且已绑定;onExtra 尚无实现(v1 无该方法)
        expect(sharedMethod('A', 'onShared')).toMatchObject({ line: 2, binding: expect.anything() });
        expect(sharedMethod('B', 'onShared')).toMatchObject({ line: 2, binding: expect.anything() });
        expect(sharedMethod('A', 'onExtra')).toBeUndefined();
        const cIndexBefore = indexes().get('C');
        const missesBefore = manager.getDefParseCacheStats().misses;

        // 保存 Shared.py:头部垫三行(onShared 2→6)并补 onExtra 实现
        write(root, 'scripts/base/interfaces/Shared.py', [
          '# pad 1',
          '# pad 2',
          '# pad 3',
          '',
          'class Shared(object):',
          '    def onShared(self):',
          '        pass',
          '',
          '    def onExtra(self):',
          '        pass',
          ''
        ].join('\n'));
        (manager as unknown as { handlePythonFileChanged(file: string): void })
          .handlePythonFileChanged(sharedPy);

        // A/B 都要翻新:等最后注册的 B 也拿到新行号
        await until(() => sharedMethod('B', 'onShared')?.line === 6, 'B shared reparse');
        expect(sharedMethod('A', 'onShared')).toMatchObject({ line: 6, binding: expect.anything() });
        expect(sharedMethod('B', 'onShared')).toMatchObject({ line: 6, binding: expect.anything() });
        // 绑定表同步翻新:v2 新增的 onExtra 实现两实体都挂上绑定
        expect(sharedMethod('A', 'onExtra')).toMatchObject({ line: 9, binding: expect.anything() });
        expect(sharedMethod('B', 'onExtra')).toMatchObject({ line: 9, binding: expect.anything() });
        // 未依赖实体不刷新:索引对象原引用保留,且只发生 A/B 两次重解析
        expect(indexes().get('C')).toBe(cIndexBefore);
        expect(manager.getDefParseCacheStats().misses).toBe(missesBefore + 2);
      } finally {
        manager.dispose();
        stubWorkspace.workspaceFolders = originalFolders;
        stubWorkspace.findFiles = originalFind;
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 20000);
});

describe('IDE-IDX-008 删除同名胜者保留其他根实体', () => {
  it('移除 B 的 Hero 后 A 的 Hero 按名字/按 A 根均可查,不被连坐', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-mapping-winner-'));
    try {
      for (const [project, marker] of [['a', 'on_a'], ['b', 'on_b']] as Array<[string, string]>) {
        write(root, `${project}/scripts/entities.xml`, '<root>\n  <Hero hasBase="true"/>\n</root>');
        write(root, `${project}/scripts/entity_defs/Hero.def`,
          `<root>\n  <BaseMethods>\n    <${marker}/>\n  </BaseMethods>\n</root>`);
        write(root, `${project}/scripts/base/Hero.py`,
          `class Hero(object):\n    def ${marker}(self):\n        pass\n`);
      }
      const aDef = p(root, 'a', 'scripts', 'entity_defs', 'Hero.def');
      const bDef = p(root, 'b', 'scripts', 'entity_defs', 'Hero.def');
      const aHeroPy = p(root, 'a', 'scripts', 'base', 'Hero.py');
      const bHeroPy = p(root, 'b', 'scripts', 'base', 'Hero.py');
      const originalFolders = stubWorkspace.workspaceFolders;
      const originalFind = stubWorkspace.findFiles;
      stubWorkspace.workspaceFolders = [{ uri: Uri.file(root), name: 'winner', index: 0 }];
      stubWorkspace.findFiles = async () => {
        const results: Uri[] = [];
        const walk = (dir: string) => {
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = p(dir, entry.name);
            if (entry.isDirectory()) { walk(full); }
            else if (entry.name.endsWith('.def')) { results.push(Uri.file(full)); }
          }
        };
        walk(root);
        return results;
      };
      const manager = new EntityMappingManager({ subscriptions: [] });
      try {
        const rootIndexes = (): Map<string, unknown> =>
          (manager as unknown as { mappingIndexesByRoot: Map<string, unknown> }).mappingIndexesByRoot;
        await until(() => rootIndexes().size >= 2, 'dual-root scan');
        const fromA = await manager.resolveMethodDefinitionForClass('Hero', 'on_a', undefined, aHeroPy);
        expect(fromA).toMatchObject({ defFile: aDef });

        // 删 B 的 Hero.def:磁盘移除 + def watcher delete 事件
        fs.rmSync(bDef);
        (manager as unknown as { defWatcher: { fireDelete: (uri: Uri) => void } })
          .defWatcher.fireDelete(Uri.file(bDef));
        await until(() => rootIndexes().size === 1, 'B def removal');

        // A 根查询不受连坐
        const fromAAfter = await manager.resolveMethodDefinitionForClass('Hero', 'on_a', undefined, aHeroPy);
        expect(fromAAfter).toMatchObject({ defFile: aDef });
        // 名字维度:同名胜者重选到 A,名字槽不空
        expect(manager.getMapping('Hero')).toMatchObject({ defFile: aDef });
        expect(
          (manager as unknown as { semanticIndex: { getEntityDefFile: (name: string) => string | null } })
            .semanticIndex.getEntityDefFile('Hero')
        ).toBe(aDef);
        // B 真删干净:B 根查 B 独有方法 → null
        expect(await manager.resolveMethodDefinitionForClass('Hero', 'on_b', undefined, bHeroPy)).toBeNull();
      } finally {
        manager.dispose();
        stubWorkspace.workspaceFolders = originalFolders;
        stubWorkspace.findFiles = originalFind;
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 20000);
});
