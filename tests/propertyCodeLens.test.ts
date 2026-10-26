import { describe, expect, it } from 'vitest';
import {
  buildPropertyCodeLenses,
  describePropertyCodeLensTitle,
  findPythonSelfPropertyAccesses,
  propertyAccessKey,
  type PropertyCodeLensHit
} from '../src/propertyCodeLens';
import { PropertyCodeLensProvider } from '../src/languageProviders';
import { EntityMappingManager } from '../src/entityMapping';
import { configurationOverrides, makeTextDocument, Uri } from './helpers/vscodeStub';
import type { MinimalTextDocument } from './helpers/vscodeStub';

// 属性访问标记(批135 用户令:「从 types.xml 可以跳转到具体的代码,但从代码上
// 没有类似的 type 的标记反向跳转」)。Python 脚本里没有类型名可写,可行等价是
// self.<属性> 访问处出一行 CodeLens,标题标 def 声明的类型与可见域,点击回
// def 声明行。EntityMappingManager 以假例注入,不读真实文件。

interface CodeLensLike {
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  command: { title: string; command: string; arguments: Array<unknown> };
}

const doc = (text: string, fileName = '/tmp/ws/scripts/base/Avatar.py'): MinimalTextDocument =>
  makeTextDocument(text, { fileName, languageId: 'python' });

const hit = (overrides: Partial<PropertyCodeLensHit> = {}): PropertyCodeLensHit => ({
  propertyName: 'hp',
  typeName: 'UINT32',
  domains: ['base'],
  persistent: false,
  defFile: '/tmp/ws/scripts/entity_defs/Avatar.def',
  defLine: 12,
  ...overrides
});

describe('findPythonSelfPropertyAccesses(self.<属性> 访问收集)', () => {
  it('collects the root symbol column and the full path', () => {
    const accesses = findPythonSelfPropertyAccesses(
      'class Avatar(kbe.KBEntity):\n' +
        '    def __init__(self):\n' +
        '        self.hp = 100\n' +
        '        self.gold = self.hp + 1\n' +
        '        inv = self.inventory.items[0]\n'
    );

    expect(accesses).toEqual([
      { line: 2, character: 13, rootSymbol: 'hp', fullPath: 'hp' },
      { line: 3, character: 13, rootSymbol: 'gold', fullPath: 'gold' },
      { line: 3, character: 25, rootSymbol: 'hp', fullPath: 'hp' },
      { line: 4, character: 19, rootSymbol: 'inventory', fullPath: 'inventory.items' }
    ]);
  });

  it('ignores bare self and non-self receivers', () => {
    const accesses = findPythonSelfPropertyAccesses(
      'class Avatar:\n' +
        '    def tick(self):\n' +
        '        self = other\n' +
        '        other.hp = 1\n' +
        '        selfx.hp = 2\n'
    );

    expect(accesses).toEqual([]);
  });

  it('returns an empty list for an empty document and honours CRLF lines', () => {
    expect(findPythonSelfPropertyAccesses('')).toEqual([]);
    expect(findPythonSelfPropertyAccesses('class X:\r\n    self.hp = 1\r\n')).toEqual([
      { line: 1, character: 9, rootSymbol: 'hp', fullPath: 'hp' }
    ]);
  });
});

describe('describePropertyCodeLensTitle(lens 标题)', () => {
  it('shows the property, type and domains', () => {
    expect(describePropertyCodeLensTitle(hit())).toBe('属性 · hp · UINT32 · base');
  });

  it('prefixes the component slot name and marks persistence', () => {
    expect(
      describePropertyCodeLensTitle(
        hit({ propertyName: 'items', componentSlotName: 'Inventory', domains: ['cell', 'client'], persistent: true })
      )
    ).toBe('属性 · Inventory.items · UINT32 · cell|client · Persistent');
  });

  it('falls back to a placeholder for undeclared type and unconfigured flags', () => {
    expect(describePropertyCodeLensTitle(hit({ typeName: null, domains: [] }))).toBe(
      '属性 · hp · Type 未声明 · Flags 未配置'
    );
  });
});

describe('buildPropertyCodeLenses(只给命中属性出行)', () => {
  it('emits one spec per resolved access, in document order', () => {
    const accesses = findPythonSelfPropertyAccesses(
      'class Hero(kbe.KBEntity):\n' +
        '    def setHP(self, hp):\n' +
        '        self.hp = hp\n' +
        '        self.gold = 0\n'
    );

    const specs = buildPropertyCodeLenses(accesses, access =>
      access.fullPath === 'hp'
        ? hit({ propertyName: 'hp', defLine: 3 })
        : access.fullPath === 'gold'
          ? hit({ propertyName: 'gold', typeName: 'UINT64', domains: ['base', 'client'], defLine: 4 })
          : null
    );

    expect(specs.map(spec => [spec.access.fullPath, spec.title])).toEqual([
      ['hp', '属性 · hp · UINT32 · base'],
      ['gold', '属性 · gold · UINT64 · base|client']
    ]);
    expect(specs[0].hit.defLine).toBe(3);
  });

  it('emits a lens at every access site, not just the first', () => {
    // 读者停在任意一行都能看到标记,所以不按属性去重;解析复用由 provider 缓存
    const accesses = findPythonSelfPropertyAccesses(
      'class Hero:\n' +
        '    def a(self):\n' +
        '        self.hp = 1\n' +
        '    def b(self):\n' +
        '        return self.hp\n'
    );

    const specs = buildPropertyCodeLenses(accesses, () => hit());

    expect(specs.map(spec => spec.access.line)).toEqual([2, 4]);
  });

  it('skips accesses the resolver rejects', () => {
    const accesses = findPythonSelfPropertyAccesses('class Hero:\n    def a(self):\n        self.hp = 1\n');

    expect(buildPropertyCodeLenses(accesses, () => null)).toEqual([]);
  });

  it('reports unresolved and resolved paths through one resolver', () => {
    const asked: string[] = [];
    const accesses = findPythonSelfPropertyAccesses(
      'class Hero:\n    def a(self):\n        self.hp = 1\n        self.gold = 2\n'
    );

    buildPropertyCodeLenses(accesses, access => {
      asked.push(access.fullPath);
      return access.fullPath === 'gold' ? hit({ propertyName: 'gold' }) : null;
    });

    expect(asked).toEqual(['hp', 'gold']);
  });
});

describe('propertyAccessKey(解析/去重键)', () => {
  it('combines the root symbol and the full path', () => {
    expect(propertyAccessKey({ line: 0, character: 1, rootSymbol: 'inventory', fullPath: 'inventory.items' })).toBe(
      'inventory\u0000inventory.items'
    );
  });
});

describe('PropertyCodeLensProvider(装配 vscode.CodeLens)', () => {
  const resolveCalls: Array<{ file: string; fullPath: string; rootSymbol: string }> = [];

  const managerOf = (
    locations: Record<string, { defFile: string; line: number; typeName?: string; componentSlotName?: string }>
  ) => {
    resolveCalls.length = 0;
    return {
      resolvePropertyDefinitionInfo: (file: string, fullPath: string, rootSymbol: string) => {
        resolveCalls.push({ file, fullPath, rootSymbol });
        const location = locations[fullPath];
        return Promise.resolve(
          location
            ? {
                ...location,
                identity: {
                  symbolName: fullPath,
                  propertyPath: fullPath,
                  componentSlotName: location.componentSlotName
                },
                typeName: location.typeName,
                domains: ['base'],
                persistent: false
              }
            : null
        );
      }
    } as unknown as EntityMappingManager;
  };

  it('emits a clickable lens over the root symbol pointing at the def declaration', async () => {
    const provider = new PropertyCodeLensProvider(
      managerOf({
        hp: { defFile: '/tmp/ws/Hero.def', line: 3, typeName: 'UINT32' },
        gold: { defFile: '/tmp/ws/Hero.def', line: 4, typeName: 'UINT64' }
      })
    );

    const lenses = (await provider.provideCodeLenses(doc(
      'class Hero(kbe.KBEntity):\n' +
        '    def setHP(self, hp):\n' +
        '        self.hp = hp\n' +
        '        self.gold = 0\n'
    ))) as unknown as CodeLensLike[];

    expect(lenses).toHaveLength(2);
    expect(lenses[0].range.start).toEqual({ line: 2, character: 13 });
    expect(lenses[0].range.end).toEqual({ line: 2, character: 15 });
    expect(lenses[0].command.command).toBe('kbengine.source.reveal');
    expect((lenses[0].command.arguments[0] as { fsPath: string }).fsPath).toBe('/tmp/ws/Hero.def');
    expect(lenses[0].command.arguments[1]).toEqual({
      selection: { start: { line: 2, character: 0 }, end: { line: 2, character: 0 } }
    });
    expect(lenses[1].range.start).toEqual({ line: 3, character: 13 });
  });

  it('resolves against the document file and emits nothing when no property matches', async () => {
    const provider = new PropertyCodeLensProvider(managerOf({}));

    const lenses = (await provider.provideCodeLenses(doc(
      'class Hero(kbe.KBEntity):\n' +
        '    def helper(self):\n' +
        '        self.unknown = 1\n',
      '/tmp/ws/scripts/cell/Hero.py'
    ))) as unknown as CodeLensLike[];

    expect(lenses).toEqual([]);
    expect(resolveCalls.map(call => [call.file, call.fullPath])).toEqual([
      ['/tmp/ws/scripts/cell/Hero.py', 'unknown']
    ]);
  });

  it('asks the resolver once per distinct property path', async () => {
    const provider = new PropertyCodeLensProvider(managerOf({ hp: { defFile: '/tmp/ws/Hero.def', line: 1 } }));

    const lenses = (await provider.provideCodeLenses(doc(
      'class Hero(kbe.KBEntity):\n' +
        '    def a(self):\n' +
        '        self.hp = 1\n' +
        '    def b(self):\n' +
        '        return self.hp\n'
    ))) as unknown as CodeLensLike[];

    expect(resolveCalls.map(call => call.fullPath)).toEqual(['hp']);
    expect(lenses).toHaveLength(2);
    expect(lenses[0].range.start.character).toBe(13);
    // 第二处在 return 行,根段起点随缩进右移
    expect(lenses[1].range.start.character).toBe(20);
  });

  it('treats a missing type as a placeholder and marks the component slot', async () => {
    const provider = new PropertyCodeLensProvider(
      managerOf({
        regen: {
          defFile: '/tmp/ws/HealthComp.def',
          line: 5,
          typeName: undefined,
          componentSlotName: 'healthPack'
        }
      })
    );

    const lenses = (await provider.provideCodeLenses(doc(
      'class Hero(kbe.KBEntity):\n' +
        '    def tick(self):\n' +
        '        self.regen = 2\n'
    ))) as unknown as CodeLensLike[];

    expect(lenses).toHaveLength(1);
    expect(lenses[0].range.start).toEqual({ line: 2, character: 13 });
    expect(lenses[0].range.end).toEqual({ line: 2, character: 18 });
    expect(lenses[0].command.title).toBe('属性 · healthPack.regen · Type 未声明 · base');
    expect((lenses[0].command.arguments[0] as { fsPath: string }).fsPath).toBe('/tmp/ws/HealthComp.def');
    expect(lenses[0].command.arguments[1]).toEqual({
      selection: { start: { line: 4, character: 0 }, end: { line: 4, character: 0 } }
    });
  });
});

describe('PropertyCodeLensProvider 独立开关(批154)', () => {
  it('codeLens.property 关闭时整类不出镜,默认开启不受影响', async () => {
    const document = doc('def tick(self):\n    self.hp = 1\n');
    const provider = new PropertyCodeLensProvider({
      resolvePropertyDefinitionInfo: () =>
        Promise.resolve({
          defFile: '/tmp/ws/Hero.def',
          line: 3,
          identity: { symbolName: 'hp', propertyPath: 'hp' },
          typeName: 'UINT32',
          domains: ['base'],
          persistent: false
        })
    } as unknown as EntityMappingManager);

    // 正对照:默认开启时同一解析命中出镜
    const lenses = (await provider.provideCodeLenses(document)) as unknown as CodeLensLike[];
    expect(lenses).toHaveLength(1);

    configurationOverrides.set('kbengine', { 'codeLens.property': false });
    try {
      expect(await provider.provideCodeLenses(document)).toEqual([]);
    } finally {
      configurationOverrides.delete('kbengine');
    }
  });
});

describe('uri file helper is a real Uri instance for lens commands', () => {
  it('produces the file scheme', () => {
    expect(Uri.file('/tmp/ws/Hero.def').scheme).toBe('file');
  });
});
