import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  KBEngineCallHierarchyProvider,
  KBEngineCompletionProvider,
  PythonCompletionProvider,
  PythonDefinitionProvider
} from '../src/languageProviders';
import { EntityMappingManager } from '../src/entityMapping';
import {
  Position,
  Range,
  SymbolKind,
  CallHierarchyItem,
  Uri,
  makeTextDocument,
  workspace as stubWorkspace
} from './helpers/vscodeStub';
import type { MinimalTextDocument } from './helpers/vscodeStub';

// python 侧 provider 内部链路:PythonDefinitionProvider 的 self 属性/
// 方法定义跳转与 def 方法声明跳转、KBEngineCallHierarchyProvider 的
// python/def 双入口 prepare 与 incoming/outgoing 调用、
// PythonCompletionProvider 的 self 顶级与嵌套属性补全(partial 过滤、
// 去重、空段跳过、exposed 标记)。EntityMappingManager 全部以假例
// 对象注入,不读真实文件。

interface LocationLike {
  uri: { fsPath: string };
  range: { start: { line: number; character: number } };
}

// def 补全的已知类型建议需要 workspace 现场(types.xml + entities.xml)。
let root = '';
beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-py-prov-'));
  const write = (relative: string, content: string) => {
    const target = path.join(root, ...relative.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf8');
  };

  write('scripts/entity_defs/types.xml', [
    '<root>',
    '  <DOLL>',
    '    <Type>FIXED_DICT</Type>',
    '  </DOLL>',
    '</root>'
  ].join('\n'));
  write('scripts/entities.xml', [
    '<root>',
    '  <Hero hasBase="true" hasCell="true" hasClient="true"/>',
    '</root>'
  ].join('\n'));

  stubWorkspace.workspaceFolders = [
    { uri: Uri.file(root), name: 'ws', index: 0 }
  ];
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
  stubWorkspace.workspaceFolders = [];
});

// `|` 标记光标位置。
const cursorOf = (template: string): { text: string; position: Position } => {
  const idx = template.indexOf('|');
  expect(idx).toBeGreaterThanOrEqual(0);
  const text = template.replace('|', '');
  const before = text.slice(0, idx);
  const line = before.split('\n').length - 1;
  const lastNewline = before.lastIndexOf('\n');
  const character = line === 0 ? idx : idx - (lastNewline + 1);
  return { text, position: new Position(line, character) };
};

const pyDoc = (
  template: string,
  fileName = '/tmp/ws/scripts/base/Hero.py'
): { document: MinimalTextDocument; position: Position } => {
  const { text, position } = cursorOf(template);
  return {
    document: makeTextDocument(text, { fileName, languageId: 'python' }),
    position
  };
};

const defDoc = (
  template: string,
  fileName = '/tmp/ws/scripts/entity_defs/Hero.def'
): { document: MinimalTextDocument; position: Position } => {
  const { text, position } = cursorOf(template);
  return {
    document: makeTextDocument(text, { fileName, languageId: 'kbengine-def' }),
    position
  };
};

describe('PythonDefinitionProvider', () => {
  it('jumps from a self property access to its def definition', async () => {
    const calls: Array<{ file: string; fullPath: string; root: string }> = [];
    const manager = {
      resolvePropertyDefinition: (
        file: string,
        fullPath: string,
        root: string
      ) => {
        calls.push({ file, fullPath, root });
        return Promise.resolve({ defFile: '/tmp/ws/Hero.def', line: 4, identity: {} });
      },
      resolveMethodDefinition: () => Promise.resolve(null)
    } as unknown as EntityMappingManager;
    const provider = new PythonDefinitionProvider(manager);
    const { document, position } = pyDoc('        print(self.h|p)\n');

    const location = await provider.provideDefinition(document, position) as unknown as LocationLike;
    expect(location).toBeTruthy();
    expect(location.uri.fsPath).toBe('/tmp/ws/Hero.def');
    expect(location.range.start.line).toBe(3);
    expect(calls).toEqual([
      { file: '/tmp/ws/scripts/base/Hero.py', fullPath: 'hp', root: 'hp' }
    ]);
  });

  it('resolves a nested self access by its full path', async () => {
    const calls: Array<{ fullPath: string; root: string }> = [];
    const manager = {
      resolvePropertyDefinition: (file: string, fullPath: string, root: string) => {
        calls.push({ fullPath, root });
        return Promise.resolve({ defFile: '/tmp/ws/Hero.def', line: 9, identity: {} });
      },
      resolveMethodDefinition: () => Promise.resolve(null)
    } as unknown as EntityMappingManager;
    const provider = new PythonDefinitionProvider(manager);
    const { document, position } = pyDoc('x = self.bag.coi|ns + 1\n');

    const location = await provider.provideDefinition(document, position) as unknown as LocationLike;
    expect(location).toBeTruthy();
    expect(location.uri.fsPath).toBe('/tmp/ws/Hero.def');
    expect(location.range.start.line).toBe(8);
    expect(calls).toEqual([{ fullPath: 'bag.coins', root: 'bag' }]);
  });

  it('falls back to the method definition when the property is unknown', async () => {
    const manager = {
      resolvePropertyDefinition: () => Promise.resolve(null),
      resolveMethodDefinition: (file: string, methodName: string) =>
        Promise.resolve(methodName === 'bag'
          ? { defFile: '/tmp/ws/Hero.def', line: 6, section: 'Properties', exposed: false, identity: {} }
          : null)
    } as unknown as EntityMappingManager;
    const provider = new PythonDefinitionProvider(manager);
    const { document, position } = pyDoc('x = self.b|ag.items\n');

    const location = await provider.provideDefinition(document, position) as unknown as LocationLike;
    expect(location).toBeTruthy();
    expect(location.uri.fsPath).toBe('/tmp/ws/Hero.def');
    expect(location.range.start.line).toBe(5);
  });

  it('jumps from a def method declaration line', async () => {
    const manager = {
      resolvePropertyDefinition: () => Promise.resolve(null),
      resolveMethodDefinition: (file: string, methodName: string) =>
        Promise.resolve(methodName === 'onKill'
          ? { defFile: '/tmp/ws/Hero.def', line: 12, section: 'BaseMethods', exposed: true, identity: {} }
          : null)
    } as unknown as EntityMappingManager;
    const provider = new PythonDefinitionProvider(manager);
    const { document, position } = pyDoc('    def onK|ill(self):\n        pass\n');

    const location = await provider.provideDefinition(document, position) as unknown as LocationLike;
    expect(location).toBeTruthy();
    expect(location.uri.fsPath).toBe('/tmp/ws/Hero.def');
    expect(location.range.start.line).toBe(11);
  });

  it('returns null when neither access nor declaration resolves', async () => {
    const manager = {
      resolvePropertyDefinition: () => Promise.resolve(null),
      resolveMethodDefinition: () => Promise.resolve(null)
    } as unknown as EntityMappingManager;
    const provider = new PythonDefinitionProvider(manager);
    const { document, position } = pyDoc('    def onK|ill(self):\n        pass\n');

    expect(await provider.provideDefinition(document, position)).toBeNull();
  });

  it('returns null when the cursor is on the def keyword itself', async () => {
    // 光标在方法名之外(def 关键字上):声明提取直接 null
    const manager = {
      resolvePropertyDefinition: () => Promise.resolve(null),
      resolveMethodDefinition: () => Promise.resolve(null)
    } as unknown as EntityMappingManager;
    const provider = new PythonDefinitionProvider(manager);
    const { document, position } = pyDoc('    de|f onKill(self):\n        pass\n');

    expect(await provider.provideDefinition(document, position)).toBeNull();
  });

  it('returns null for an unrelated line', async () => {
    const manager = {
      resolvePropertyDefinition: () => Promise.resolve(null),
      resolveMethodDefinition: () => Promise.resolve(null)
    } as unknown as EntityMappingManager;
    const provider = new PythonDefinitionProvider(manager);
    const { document, position } = pyDoc('# just a comm|ent\n');

    expect(await provider.provideDefinition(document, position)).toBeNull();
  });
});

describe('KBEngineCallHierarchyProvider', () => {
  it('prepares a call hierarchy item from a python method position', async () => {
    const calls: Array<{ file: string; line: number; character: number }> = [];
    const manager = {
      resolvePythonMethodAtPosition: (file: string, line: number, character: number) => {
        calls.push({ file, line, character });
        return Promise.resolve({ filePath: '/tmp/ws/Hero.py', methodName: 'onKill', line: 5, character: 7 });
      }
    } as unknown as EntityMappingManager;
    const provider = new KBEngineCallHierarchyProvider(manager);
    const { document, position } = pyDoc('    def onKill(sel|f):\n        pass\n');

    // position 在第一行 → 传给 manager 的 1-based 行号为 1
    const item = await provider.prepareCallHierarchy(document, position) as CallHierarchyItem;
    expect(item.name).toBe('onKill');
    expect(item.kind).toBe(SymbolKind.Method);
    expect(item.detail).toBe('Hero.py');
    expect(calls).toEqual([
      { file: '/tmp/ws/scripts/base/Hero.py', line: 1, character: position.character }
    ]);
  });

  it('returns null when no python method is at the position', async () => {
    const manager = {
      resolvePythonMethodAtPosition: () => Promise.resolve(null)
    } as unknown as EntityMappingManager;
    const provider = new KBEngineCallHierarchyProvider(manager);
    const { document, position } = pyDoc('x = |1\n');

    expect(await provider.prepareCallHierarchy(document, position)).toBeNull();
  });

  it('bridges a def method into a python call hierarchy item', async () => {
    const identity = { ownerKind: 'entity', ownerName: 'Hero', symbolName: 'onKill' };
    const identities: Array<{ file: string; line: number; symbol: string; section: string }> = [];
    const manager = {
      resolveDefinitionSymbolAtPosition: (file: string, line: number, symbol: string, section: string) => {
        identities.push({ file, line, symbol, section });
        return Promise.resolve(identity);
      },
      resolveMethodImplementationByIdentity: (received: unknown) =>
        Promise.resolve(received === identity
          ? { filePath: '/tmp/ws/Hero.py', methodName: 'onKill', line: 10, character: 4 }
          : null)
    } as unknown as EntityMappingManager;
    const provider = new KBEngineCallHierarchyProvider(manager);
    const { document, position } = defDoc([
      '<root>',
      '  <BaseMethods>',
      '    <onKi|ll>',
      '      <Arg>ENTITY_ID</Arg>',
      '    </onKill>',
      '  </BaseMethods>',
      '</root>'
    ].join('\n'));

    const item = await provider.prepareCallHierarchy(document, position) as CallHierarchyItem;
    expect(item.name).toBe('onKill');
    expect(item.uri.fsPath).toBe('/tmp/ws/Hero.py');
    expect(item.selectionRange.start.line).toBe(9);
    expect(identities).toEqual([
      { file: '/tmp/ws/scripts/entity_defs/Hero.def', line: 3, symbol: 'onKill', section: 'BaseMethods' }
    ]);
  });

  it('returns null for a non-method def symbol', async () => {
    const manager = {} as unknown as EntityMappingManager;
    const provider = new KBEngineCallHierarchyProvider(manager);
    const { document, position } = defDoc([
      '<root>',
      '  <Properties>',
      '    <|hp>',
      '      <Type>UINT32</Type>',
      '    </hp>',
      '  </Properties>',
      '</root>'
    ].join('\n'));

    expect(await provider.prepareCallHierarchy(document, position)).toBeNull();
  });

  it('returns null when the def symbol identity does not resolve', async () => {
    const manager = {
      resolveDefinitionSymbolAtPosition: () => Promise.resolve(null)
    } as unknown as EntityMappingManager;
    const provider = new KBEngineCallHierarchyProvider(manager);
    const { document, position } = defDoc([
      '<root>',
      '  <BaseMethods>',
      '    <onKi|ll>',
      '      <Arg>ENTITY_ID</Arg>',
      '    </onKill>',
      '  </BaseMethods>',
      '</root>'
    ].join('\n'));

    expect(await provider.prepareCallHierarchy(document, position)).toBeNull();
  });

  it('returns null when the implementation is missing', async () => {
    const manager = {
      resolveDefinitionSymbolAtPosition: () =>
        Promise.resolve({ ownerKind: 'entity', ownerName: 'Hero', symbolName: 'onKill' }),
      resolveMethodImplementationByIdentity: () => Promise.resolve(null)
    } as unknown as EntityMappingManager;
    const provider = new KBEngineCallHierarchyProvider(manager);
    const { document, position } = defDoc([
      '<root>',
      '  <BaseMethods>',
      '    <onKi|ll>',
      '      <Arg>ENTITY_ID</Arg>',
      '    </onKill>',
      '  </BaseMethods>',
      '</root>'
    ].join('\n'));

    expect(await provider.prepareCallHierarchy(document, position)).toBeNull();
  });

  it('returns null when the def position has no word', async () => {
    const manager = {} as unknown as EntityMappingManager;
    const provider = new KBEngineCallHierarchyProvider(manager);
    const { document, position } = defDoc('  |\n');

    expect(await provider.prepareCallHierarchy(document, position)).toBeNull();
  });

  it('returns null for documents in other languages', async () => {
    const manager = {} as unknown as EntityMappingManager;
    const provider = new KBEngineCallHierarchyProvider(manager);
    const { document, position } = pyDoc('# not|es\n', '/tmp/ws/notes.md');
    (document as { languageId: string }).languageId = 'markdown';

    expect(await provider.prepareCallHierarchy(document, position)).toBeNull();
  });

  it('lists incoming calls with the caller item and from ranges', async () => {
    const manager = {
      getIncomingPythonMethodCalls: () =>
        Promise.resolve([
          {
            caller: { filePath: '/tmp/ws/Monster.py', methodName: 'onSee', line: 3, character: 6 },
            callLine: 12,
            callCharacter: 8
          }
        ])
    } as unknown as EntityMappingManager;
    const provider = new KBEngineCallHierarchyProvider(manager);
    const item = new CallHierarchyItem(
      SymbolKind.Method,
      'onKill',
      'Hero.py',
      { fsPath: '/tmp/ws/Hero.py' } as never,
      new Range(new Position(4, 0), new Position(4, 6)),
      new Range(new Position(4, 0), new Position(4, 6))
    );

    const calls = await provider.provideCallHierarchyIncomingCalls(item);
    expect(calls).toHaveLength(1);
    expect(calls[0].item.name).toBe('onSee');
    expect(calls[0].item.uri.fsPath).toBe('/tmp/ws/Monster.py');
    expect(calls[0].fromRanges[0].start.line).toBe(11);
    expect(calls[0].fromRanges[0].start.character).toBe(8);
    expect(calls[0].fromRanges[0].end.character).toBe(14);
  });

  it('lists outgoing calls with the callee item and to ranges', async () => {
    const manager = {
      getOutgoingPythonMethodCalls: () =>
        Promise.resolve([
          { filePath: '/tmp/ws/Hero.py', methodName: 'onSee', line: 20, character: 4 }
        ])
    } as unknown as EntityMappingManager;
    const provider = new KBEngineCallHierarchyProvider(manager);
    const item = new CallHierarchyItem(
      SymbolKind.Method,
      'onKill',
      'Hero.py',
      { fsPath: '/tmp/ws/Hero.py' } as never,
      new Range(new Position(4, 0), new Position(4, 6)),
      new Range(new Position(4, 0), new Position(4, 6))
    );

    const calls = await provider.provideCallHierarchyOutgoingCalls(item);
    expect(calls).toHaveLength(1);
    expect(calls[0].item.name).toBe('onSee');
    expect(calls[0].toRanges[0].start.line).toBe(19);
    expect(calls[0].toRanges[0].start.character).toBe(4);
  });
});

describe('PythonCompletionProvider', () => {
  const makeMapping = (overrides?: {
    properties?: Record<string, { defFile: string; line: number }>;
    methods?: Record<string, Array<{ defFile: string; line: number; section: string; exposed: boolean; identity: object }>>;
  }): Record<string, unknown> => ({
    name: 'Hero',
    defFile: '/tmp/ws/Hero.def',
    pythonFile: '/tmp/ws/Hero.py',
    pythonFiles: ['/tmp/ws/Hero.py'],
    properties: overrides?.properties ?? {
      hp: { defFile: 'Hero.def', line: 4 },
      bag: { defFile: 'Hero.def', line: 7 },
      'bag.coins': { defFile: 'Hero.def', line: 8 }
    },
    methods: overrides?.methods ?? {
      onKill: [{ defFile: 'Hero.def', line: 12, section: 'BaseMethods', exposed: true, identity: {} }],
      onSee: [{ defFile: 'Hero.def', line: 16, section: 'BaseMethods', exposed: false, identity: {} }],
      empty: []
    }
  });

  const completeRaw = (
    manager: EntityMappingManager,
    template: string
  ): unknown => {
    const provider = new PythonCompletionProvider(manager);
    const { document, position } = pyDoc(template);
    return provider.provideCompletionItems(document, position);
  };

  const complete = (
    manager: EntityMappingManager,
    template: string
  ): Array<{ label: string; kind?: number; detail?: string }> => {
    const items = completeRaw(manager, template) as Array<{
      label: string;
      kind?: number;
      detail?: string;
    }>;
    expect(items).toBeTruthy();
    return items.map(item => ({
      label: item.label,
      kind: item.kind,
      detail: item.detail
    }));
  };

  it('returns null for a line without a self access prefix', () => {
    const manager = {
      getMappingForPythonFile: () => makeMapping()
    } as unknown as EntityMappingManager;

    expect(completeRaw(manager, 'x = 1|')).toBeNull();
  });

  it('returns null when the python file has no mapping', () => {
    const manager = {
      getMappingForPythonFile: () => undefined
    } as unknown as EntityMappingManager;

    expect(completeRaw(manager, 'x = self.|')).toBeNull();
  });

  it('completes top-level properties and methods after self.', () => {
    const manager = {
      getMappingForPythonFile: () => makeMapping()
    } as unknown as EntityMappingManager;
    const items = complete(manager, 'x = self.|');

    const labels = items.map(item => item.label).sort();
    // 'bag.coins' 带点路径不出现在顶级;空方法表跳过
    expect(labels).toEqual(['bag', 'hp', 'onKill', 'onSee']);

    const onKill = items.find(item => item.label === 'onKill');
    expect(onKill!.detail).toBe('Entity Method (Exposed)');
    const onSee = items.find(item => item.label === 'onSee');
    expect(onSee!.detail).toBe('Entity Method');
  });

  it('filters top-level items by the typed prefix', () => {
    const manager = {
      getMappingForPythonFile: () => makeMapping()
    } as unknown as EntityMappingManager;
    const items = complete(manager, 'x = self.h|');

    expect(items.map(item => item.label)).toEqual(['hp']);
  });

  it('completes nested property segments after self.bag.', () => {
    const manager = {
      getMappingForPythonFile: () => makeMapping()
    } as unknown as EntityMappingManager;
    const items = complete(manager, 'x = self.bag.|');

    expect(items).toHaveLength(1);
    expect(items[0].label).toBe('coins');
    expect(items[0].detail).toBe('Nested Entity Property');
  });

  it('filters nested segments by the typed prefix', () => {
    const manager = {
      getMappingForPythonFile: () => makeMapping({
        properties: {
          'bag.coins': { defFile: 'Hero.def', line: 8 },
          'bag.cells': { defFile: 'Hero.def', line: 9 }
        },
        methods: {}
      })
    } as unknown as EntityMappingManager;
    const items = complete(manager, 'x = self.bag.co|');

    expect(items.map(item => item.label)).toEqual(['coins']);
  });

  it('skips empty nested segments and deduplicates repeated ones', () => {
    const manager = {
      getMappingForPythonFile: () => makeMapping({
        properties: {
          'bag.': { defFile: 'Hero.def', line: 8 },
          'bag.a.x': { defFile: 'Hero.def', line: 9 },
          'bag.a.y': { defFile: 'Hero.def', line: 10 }
        },
        methods: {}
      })
    } as unknown as EntityMappingManager;
    const items = complete(manager, 'x = self.bag.|');

    // 'bag.' 空段跳过;'bag.a.x' 与 'bag.a.y' 的下一段同为 'a',去重后一次
    expect(items).toHaveLength(1);
    expect(items[0].label).toBe('a');
  });
});

describe('KBEngineCompletionProvider type suggestions', () => {
  it('suggests custom and entity types after a Type tag prefix', () => {
    const provider = new KBEngineCompletionProvider();
    const { document, position } = defDoc('  <Type>D|', '/tmp/ws/scripts/entity_defs/Hero.def');

    const items = provider.provideCompletionItems(document, position) as Array<{ label: string }>;
    const labels = items.map(item => item.label);
    // 已知类型建议 = 内建类型 + types.xml 自定义类型 + entities.xml 实体类型
    expect(labels).toContain('UINT32');
    expect(labels).toContain('DOLL');
    expect(labels).toContain('Hero');
  });
});
