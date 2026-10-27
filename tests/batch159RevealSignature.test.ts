import { beforeEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { getPythonCallAtPosition } from '../src/pythonLanguageUtils';
import {
  KBEngineHoverProvider,
  KBEngineSignatureHelpProvider,
  revealSourceCommand
} from '../src/languageProviders';
import { EntityMappingManager } from '../src/entityMapping';
import { makeTextDocument, Position, Range, windowState } from './helpers/vscodeStub';

// 批159:点击镜链跳 def 后 alt+← 后退再点没反应(vscode.open 跳过 reveal)
// → 自建 kbengine.source.reveal;hover 冷索引每次烧满预算 → 同点位记忆化;
// 新增签名帮助面(括号/逗号触发)。本文件锁住这三个面的行为。

const pyDoc = (text: string, fileName = '/tmp/ws/scripts/cell/Avatar.py') =>
  makeTextDocument(text, { fileName, languageId: 'python' }) as unknown as vscode.TextDocument;

describe('getPythonCallAtPosition(调用点归属)', () => {
  it('attributes self.cell calls with the def section and active argument', () => {
    const line = '        self.cell.setHP(100, 20)';
    // 光标落在第二个实参内(逗号后)
    const call = getPythonCallAtPosition(line, line.indexOf('20'));
    expect(call).not.toBeNull();
    expect(call!.methodName).toBe('setHP');
    expect(call!.section).toBe('CellMethods');
    expect(call!.activeArgument).toBe(1);
  });

  it('attributes plain object calls without a section', () => {
    const line = 'avatar.doSomething(x)';
    const call = getPythonCallAtPosition(line, line.indexOf('x'));
    expect(call).not.toBeNull();
    expect(call!.receiverName).toBe('avatar');
    expect(call!.section).toBeUndefined();
    expect(call!.activeArgument).toBe(0);
  });

  it('accepts unclosed argument lists (typing in progress)', () => {
    const line = 'self.base.teleport(pos, ';
    const call = getPythonCallAtPosition(line, line.length);
    expect(call).not.toBeNull();
    expect(call!.methodName).toBe('teleport');
    expect(call!.section).toBe('BaseMethods');
    expect(call!.activeArgument).toBe(1);
  });

  it('picks the tightest call when calls nest on one line', () => {
    const line = 'a.b(c.d(x))';
    const call = getPythonCallAtPosition(line, line.indexOf('x'));
    expect(call).not.toBeNull();
    expect(call!.methodName).toBe('d');
  });

  it('never attributes a cursor past a closed call on a multi-call line', () => {
    const line = 'a.b(x); c.d(y)';
    const inB = getPythonCallAtPosition(line, line.indexOf('x'));
    expect(inB!.methodName).toBe('b');
    const inD = getPythonCallAtPosition(line, line.indexOf('y'));
    expect(inD!.methodName).toBe('d');
    // 光标越过 c.d 的闭括号:两个调用都不认
    expect(getPythonCallAtPosition(line, line.length)).toBeNull();
  });

  it('ignores property reads without a call paren', () => {
    expect(getPythonCallAtPosition('self.cell.position', 10)).toBeNull();
  });
});

describe('kbengine.source.reveal(镜链强制 reveal)', () => {
  beforeEach(() => {
    windowState.reset();
  });

  it('opens the document and forwards the selection', async () => {
    const selection = new Range(new Position(3, 0), new Position(3, 0));
    await revealSourceCommand(vscode.Uri.file('/tmp/ws/Avatar.def'), { selection });
    expect(windowState.showTextDocumentCalls).toHaveLength(1);
    const call = windowState.showTextDocumentCalls[0] as {
      options?: { selection?: Range };
    };
    expect(call.options?.selection?.start.line).toBe(3);
    expect(call.options?.selection?.start.character).toBe(0);
  });

  it('is a no-op without a uri', async () => {
    await revealSourceCommand(undefined, { selection: new Range(new Position(0, 0), new Position(0, 0)) });
    expect(windowState.showTextDocumentCalls).toHaveLength(0);
  });
});

describe('KBEngineSignatureHelpProvider(def 签名帮助)', () => {
  const managerOf = (
    locations: Record<string, { defFile: string; line: number; section: string; exposed: boolean; declaredArgs?: string[] }>,
    calls: Array<{ file: string; method: string; section?: string }>
  ) =>
    ({
      resolveMethodDefinition: (file: string, method: string, section?: string) => {
        calls.push({ file, method, section });
        const location = locations[method];
        return Promise.resolve(location ? { ...location, identity: { symbolName: method } } : null);
      }
    }) as unknown as EntityMappingManager;

  it('丢弃查询期间文档版本发生变化的签名结果', async () => {
    let release!: (value: unknown) => void;
    const lookup = new Promise(resolve => { release = resolve; });
    const provider = new KBEngineSignatureHelpProvider({
      resolveMethodDefinition: () => lookup
    } as unknown as EntityMappingManager);
    const doc = pyDoc('self.cell.setHP(1)\n');
    let version = 1;
    Object.defineProperty(doc, 'version', { get: () => version });
    const pending = provider.provideSignatureHelp(doc, new Position(0, 16));
    version += 1;
    release({ defFile: '/tmp/ws/Avatar.def', line: 1, section: 'CellMethods', declaredArgs: ['UINT32'] });
    expect(await pending).toBeNull();
  });

  it('shows the def signature with the active argument highlighted', async () => {
    const calls: Array<{ file: string; method: string; section?: string }> = [];
    const provider = new KBEngineSignatureHelpProvider(
      managerOf(
        {
          setHP: {
            defFile: '/tmp/ws/scripts/entity_defs/Avatar.def',
            line: 4,
            section: 'CellMethods',
            exposed: true,
            declaredArgs: ['UINT32', 'UINT32']
          }
        },
        calls
      )
    );
    const line = '        self.cell.setHP(100, 20)';
    const doc = pyDoc(line + '\n');
    const help = await provider.provideSignatureHelp(doc, new Position(0, line.indexOf('20')));
    expect(help).not.toBeNull();
    expect(calls[0].method).toBe('setHP');
    expect(calls[0].section).toBe('CellMethods');
    expect(help!.signatures).toHaveLength(1);
    expect(help!.signatures[0].label).toBe('def setHP(self, arg1: int, arg2: int)');
    expect(help!.activeParameter).toBe(1);
  });

  it('returns null away from any call, without a manager, or on non-python', async () => {
    const calls: Array<{ file: string; method: string; section?: string }> = [];
    const provider = new KBEngineSignatureHelpProvider(managerOf({}, calls));
    expect(await provider.provideSignatureHelp(pyDoc('x = 1\n'), new Position(0, 2))).toBeNull();
    expect(await new KBEngineSignatureHelpProvider().provideSignatureHelp(pyDoc('self.cell.m(1)\n'), new Position(0, 10))).toBeNull();
    const defDoc = makeTextDocument('<root>|</root>', { fileName: '/tmp/A.def' }) as unknown as vscode.TextDocument;
    expect(await provider.provideSignatureHelp(defDoc, new Position(0, 2))).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('returns null when the method resolves nowhere', async () => {
    const calls: Array<{ file: string; method: string; section?: string }> = [];
    const provider = new KBEngineSignatureHelpProvider(managerOf({}, calls));
    const line = 'self.cell.unknown(1)';
    const help = await provider.provideSignatureHelp(pyDoc(line + '\n'), new Position(0, line.indexOf('1')));
    expect(help).toBeNull();
  });
});

describe('hover 记忆化(批159)', () => {
  // 记忆化只做在途去重:并发同点位共享同一 Promise;落定即出册不复用
  // (暖路径由 manager 的 def 解析缓存承担,hoverBudget 契约:重复 hover
  // 仍走缓存且可数命中)。存 provider 实例上,逐用例新建天然隔离。

  it('shares one resolution across concurrent hovers at the same point', async () => {
    const calls: Array<{ file: string; method: string }> = [];
    const manager = {
      resolveMethodDefinition: (file: string, method: string) => {
        calls.push({ file, method });
        return Promise.resolve({
          defFile: '/tmp/ws/scripts/entity_defs/Avatar.def',
          line: 4,
          section: 'BaseMethods',
          exposed: false,
          identity: { symbolName: method },
          declaredArgs: []
        });
      }
    } as unknown as EntityMappingManager;
    const provider = new KBEngineHoverProvider(manager);
    const doc = pyDoc(
      'class Avatar(kbe.KBEntity):\n    def login(self):\n        pass\n',
      '/tmp/ws/scripts/base/Avatar.py'
    );
    const position = new Position(1, 9); // login 方法名上
    // 并发同点位:第二个 hover 不再触发第二次解析
    const [first, second] = await Promise.all([
      provider.provideHover(doc, position),
      provider.provideHover(doc, position)
    ]);
    expect(first).not.toBeNull();
    expect(calls).toHaveLength(1);
    expect((second!.contents as { value: string }).value).toBe(
      (first!.contents as { value: string }).value
    );
  });

  it('re-resolves sequential hovers after the previous one settles (no result cache)', async () => {
    const calls: Array<{ file: string; method: string }> = [];
    const manager = {
      resolveMethodDefinition: (file: string, method: string) => {
        calls.push({ file, method });
        return Promise.resolve({
          defFile: '/tmp/ws/scripts/entity_defs/Avatar.def',
          line: 4,
          section: 'BaseMethods',
          exposed: false,
          identity: { symbolName: method },
          declaredArgs: []
        });
      }
    } as unknown as EntityMappingManager;
    const provider = new KBEngineHoverProvider(manager);
    const doc = pyDoc(
      'class Avatar(kbe.KBEntity):\n    def login(self):\n        pass\n',
      '/tmp/ws/scripts/base/Avatar.py'
    );
    const position = new Position(1, 9);
    await provider.provideHover(doc, position);
    await provider.provideHover(doc, position);
    // 落定后不复用:每次都走 manager(其自身缓存负责暖路径),保证索引
    // 更新后标注不陈旧
    expect(calls).toHaveLength(2);
  });

  // 异步 miss 落回同步链(JSONDATA 局部变量推导)的契约由
  // pythonReturnTypeInference.test.ts 原有用例锁住(其 manager 分支异步落空
  // 后同步链仍给出标注),此处不重复建档。
});
