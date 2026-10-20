import { describe, expect, it } from 'vitest';
import {
  buildRpcCodeLenses,
  defaultRpcCodeLensTitle,
  findPythonMethodDeclarations,
  RpcMethodHit
} from '../src/rpcCodeLens';
import { createDefinitionSelection, RpcCodeLensProvider } from '../src/languageProviders';
import { EntityMappingManager } from '../src/entityMapping';
import { configurationOverrides } from './helpers/vscodeStub';
import { makeTextDocument, Uri } from './helpers/vscodeStub';
import type { MinimalTextDocument } from './helpers/vscodeStub';

// RPC 方法标记(批126 用户令:Python 实现里看不出哪些函数是 def 声明的 RPC):
// 纯逻辑层找 def 声明行 + 按解析结果出行标题,provider 层把解析回包装配成
// CodeLens(可点跳 def)。EntityMappingManager 以假例注入,不读真实文件。

interface CodeLensLike {
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  command: { command: string; arguments: Array<unknown> };
}

const doc = (text: string, fileName = '/tmp/ws/scripts/base/Avatar.py'): MinimalTextDocument =>
  makeTextDocument(text, { fileName, languageId: 'python' });

describe('findPythonMethodDeclarations(声明行收集)', () => {
  it('collects sync and async declarations with their name column', () => {
    const declarations = findPythonMethodDeclarations(
      'import kbe\n' +
        'class Avatar(kbe.KBEntity):\n' +
        '    def login(self, username):\n' +
        '        pass\n' +
        '    async def tick(self):\n' +
        '        return 1\n'
    );

    expect(declarations).toEqual([
      { line: 2, character: 8, methodName: 'login' },
      { line: 4, character: 14, methodName: 'tick' }
    ]);
  });

  it('ignores lines that are not method declarations', () => {
    const declarations = findPythonMethodDeclarations(
      '# def commented(self): 不出\n' +
        'class Avatar(kbe.KBEntity):\n' +
        '    helper_def(self)  # 无 def 关键字\n' +
        '    login(self)  # 调用不是声明\n' +
        '    else:\n' +
        '    def_x(self):  # def 后无空白,不是声明\n' +
        '    def 登录(self):  # 方法名非标识符\n' +
        '    def (self):  # 缺方法名\n' +
        '    def  1abc(self):  # 数字开头不算标识符\n'
    );

    expect(declarations).toEqual([]);
  });

  it('returns an empty list for an empty document and honours CRLF lines', () => {
    expect(findPythonMethodDeclarations('')).toEqual([]);
    expect(findPythonMethodDeclarations('class X:\r\n    def run(self):\r\n')).toEqual([
      { line: 1, character: 8, methodName: 'run' }
    ]);
  });
});

describe('defaultRpcCodeLensTitle(lens 标题)', () => {
  it('shows the section and the declaring def basename', () => {
    const hit: RpcMethodHit = {
      methodName: 'login',
      section: 'BaseMethods',
      defFile: '/tmp/ws/scripts/entity_defs/Avatar.def',
      defLine: 12,
      exposed: false
    };
    expect(defaultRpcCodeLensTitle(hit)).toBe('RPC · BaseMethods · Avatar.def');
  });

  it('marks exposed declarations and keeps only the basename', () => {
    const hit: RpcMethodHit = {
      methodName: 'setHP',
      section: 'CellMethods',
      defFile: 'D:\\proj\\scripts\\entity_defs\\Monster.def',
      defLine: 30,
      exposed: true
    };
    expect(defaultRpcCodeLensTitle(hit)).toBe('RPC · CellMethods · Exposed · Monster.def');
  });
});

describe('buildRpcCodeLenses(只给命中声明出行)', () => {
  const hit = (methodName: string, section: RpcMethodHit['section']): RpcMethodHit => ({
    methodName,
    section,
    defFile: `/tmp/ws/scripts/entity_defs/${section === 'BaseMethods' ? 'Hero' : 'Monster'}.def`,
    defLine: 7,
    exposed: false
  });

  it('emits one spec per resolved declaration, in document order', () => {
    const declarations = findPythonMethodDeclarations(
      'class Hero(kbe.KBEntity):\n' +
        '    def setHP(self, hp):\n' +
        '        return hp\n' +
        '    def save(self):\n' +
        '        return None\n' +
        '    def login(self, name):\n' +
        '        return name\n'
    );
    const resolve: Record<string, RpcMethodHit> = {
      setHP: hit('setHP', 'CellMethods'),
      login: hit('login', 'BaseMethods')
    };

    const specs = buildRpcCodeLenses(declarations, name => resolve[name]);

    expect(specs.map(spec => [spec.hit.methodName, spec.hit.section])).toEqual([
      ['setHP', 'CellMethods'],
      ['login', 'BaseMethods']
    ]);
    expect(specs[0].declaration.character).toBe(8);
    expect(specs[0].hit.defLine).toBe(7);
  });

  it('skips declarations the resolver rejects', () => {
    const declarations = findPythonMethodDeclarations('class Hero:\n    def save(self):\n');

    expect(buildRpcCodeLenses(declarations, () => null)).toEqual([]);
  });

  it('reports unresolved and resolved names through one resolver', () => {
    const asked: string[] = [];
    const declarations = findPythonMethodDeclarations('class Hero:\n    def a(self):\n    def b(self):\n');

    buildRpcCodeLenses(declarations, name => {
      asked.push(name);
      return name === 'b' ? hit('b', 'ClientMethods') : null;
    });

    expect(asked).toEqual(['a', 'b']);
  });
});

describe('RpcCodeLensProvider(装配 vscode.CodeLens)', () => {
  const resolveCalls: Array<{ file: string; method: string }> = [];

  const managerOf = (locations: Record<string, { defFile: string; line: number; section: string; exposed: boolean }>) => {
    resolveCalls.length = 0;
    return {
      resolveMethodDefinition: (file: string, method: string) => {
        resolveCalls.push({ file, method });
        const location = locations[method];
        return Promise.resolve(
          location
            ? { ...location, identity: { symbolName: method } }
            : null
        );
      }
    } as unknown as EntityMappingManager;
  };

  it('emits a clickable lens over the method name pointing at the def declaration', async () => {
    const provider = new RpcCodeLensProvider(
      managerOf({
        login: {
          defFile: '/tmp/ws/scripts/entity_defs/Avatar.def',
          line: 4,
          section: 'BaseMethods',
          exposed: false
        }
      })
    );

    const lenses = (await provider.provideCodeLenses(doc(
      'class Avatar(kbe.KBEntity):\n' +
        '    def login(self, username):\n' +
        '        return username\n' +
        '    def _cleanup(self):\n' +
        '        return None\n'
    ))) as unknown as CodeLensLike[];

    expect(lenses).toHaveLength(1);
    expect(lenses[0].range.start).toEqual({ line: 1, character: 8 });
    expect(lenses[0].range.end).toEqual({ line: 1, character: 13 });
    expect(lenses[0].command.command).toBe('vscode.open');
    expect((lenses[0].command.arguments[0] as { fsPath: string }).fsPath).toBe(
      '/tmp/ws/scripts/entity_defs/Avatar.def'
    );
    expect(lenses[0].command.arguments[1]).toEqual({
      selection: { start: { line: 3, character: 0 }, end: { line: 3, character: 0 } }
    });
  });

  it('resolves against the document file and emits nothing when no method is declared', async () => {
    const provider = new RpcCodeLensProvider(managerOf({}));

    const lenses = (await provider.provideCodeLenses(doc(
      'class Avatar(kbe.KBEntity):\n' +
        '    def helper(self):\n' +
        '        return 1\n',
      '/tmp/ws/scripts/cell/Avatar.py'
    ))) as unknown as CodeLensLike[];

    expect(lenses).toEqual([]);
    expect(resolveCalls.map(call => [call.file, call.method])).toEqual([
      ['/tmp/ws/scripts/cell/Avatar.py', 'helper']
    ]);
  });

  it('asks the resolver once per distinct method name', async () => {
    const provider = new RpcCodeLensProvider(
      managerOf({
        tick: { defFile: '/tmp/ws/Hero.def', line: 1, section: 'BaseMethods', exposed: true }
      })
    );

    const lenses = (await provider.provideCodeLenses(doc(
      'class Hero(kbe.KBEntity):\n' +
        '    def tick(self):\n' +
        '        return 1\n' +
        '    def tick(self, delta):\n' +
        '        return delta\n'
    ))) as unknown as CodeLensLike[];

    expect(resolveCalls.map(call => call.method)).toEqual(['tick']);
    expect(lenses).toHaveLength(2);
    expect(lenses[0].range.start.character).toBe(8);
    expect(lenses[1].range.start.character).toBe(8);
  });
});

describe('createDefinitionSelection(声明行选区)', () => {
  it('converts a 1-based def line into a zero-width range', () => {
    expect(createDefinitionSelection(1).start).toEqual({ line: 0, character: 0 });
    expect(createDefinitionSelection(12).end).toEqual({ line: 11, character: 0 });
  });

  it('reuses the same position for start and end', () => {
    const range = createDefinitionSelection(3);
    expect(range.start).toBe(range.end);
  });
});

describe('RpcCodeLensProvider 独立开关(批154)', () => {
  it('codeLens.rpc 关闭时整类不出镜,默认开启不受影响', async () => {
    const document = doc(
      'class Avatar(kbe.KBEntity):\n' +
        '    def login(self, username):\n' +
        '        return username\n'
    );
    const provider = new RpcCodeLensProvider({
      resolveMethodDefinition: () =>
        Promise.resolve({
          defFile: '/tmp/ws/scripts/entity_defs/Avatar.def',
          line: 4,
          section: 'BaseMethods',
          exposed: false,
          identity: { symbolName: 'login' }
        })
    } as unknown as EntityMappingManager);

    // 正对照:默认开启时同一解析命中出镜
    const lenses = (await provider.provideCodeLenses(document)) as unknown as CodeLensLike[];
    expect(lenses).toHaveLength(1);

    configurationOverrides.set('kbengine', { 'codeLens.rpc': false });
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
