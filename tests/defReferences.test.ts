import { describe, expect, it } from 'vitest';
import type * as vscode from 'vscode';
import type { EntityMappingManager } from '../src/entityMapping';
import {
  KBEngineCallHierarchyProvider,
  KBEngineReferencesProvider
} from '../src/languageProviders';
import { makeTextDocument, Position, Uri } from './helpers/vscodeStub';

// IDE-NAV-001:def 原生引用查询入口(Shift+F12)。验收口径:引用结果复用
// 统一符号身份——与调用层级 prepare 同链(findDefSymbolInfo →
// resolveDefinitionSymbolAtPosition → resolveMethodImplementationByIdentity),
// 再经 getIncomingPythonMethodCalls 出引用位;不另起名字 grep。本批收
// 方法段引用;属性 self 访问(NAV-002)与 receiver RPC(NAV-003)后续批接。

const DEF_TEXT = [
  '<root>',
  '  <Properties>',
  '    <hp>',
  '      <Type>UINT32</Type>',
  '    </hp>',
  '  </Properties>',
  '  <BaseMethods>',
  '    <reqPos>',
  '      <Arg>TIMESTAMP</Arg>',
  '    </reqPos>',
  '  </BaseMethods>',
  '</root>'
].join('\n');

interface StubCalls {
  identityArgs: unknown[][];
  implementationArgs: unknown[];
  incomingArgs: unknown[][];
  receiverArgs: unknown[][];
}

const managerStub = (
  impl: { filePath: string; line: number; character: number } | null,
  receiverSites: Array<{ filePath: string; line: number; character: number }> = []
) => {
  const calls: StubCalls = { identityArgs: [], implementationArgs: [], incomingArgs: [], receiverArgs: [] };
  const manager = {
    resolveDefinitionSymbolAtPosition: (...args: unknown[]) => {
      calls.identityArgs.push(args);
      return Promise.resolve({ symbolName: args[2], section: args[3] });
    },
    resolveMethodImplementationByIdentity: (...args: unknown[]) => {
      calls.implementationArgs.push(args);
      return Promise.resolve(impl);
    },
    getIncomingPythonMethodCalls: (...args: unknown[]) => {
      calls.incomingArgs.push(args);
      return Promise.resolve([
        {
          caller: { filePath: '/tmp/ws/scripts/base/Gate.py', methodName: 'onTeleport', line: 10, character: 8 },
          callLine: 12,
          callCharacter: 4
        }
      ]);
    },
    getIncomingPythonPropertyAccesses: () => Promise.resolve([]),
    // IDE-NAV-003:receiver RPC 桩——记录段参,供"按段分开"断言
    getIncomingPythonReceiverCalls: (...args: unknown[]) => {
      calls.receiverArgs.push(args);
      return Promise.resolve(receiverSites);
    }
  };
  return { manager: manager as unknown as EntityMappingManager, calls };
};

const defDoc = (): vscode.TextDocument =>
  makeTextDocument(DEF_TEXT, { fileName: '/tmp/ws/scripts/entity_defs/Avatar.def' }) as never;

/** <reqPos> 行的方法名位 */
const methodPosition = (): vscode.Position => new Position(7, 6);

describe('def 引用查询入口(IDE-NAV-001)', () => {
  it('方法段引用:统一符号身份链解析后出引用位,链参带名字与段', async () => {
    const { manager, calls } = managerStub({
      filePath: '/tmp/ws/scripts/base/Avatar.py', line: 2, character: 4
    });
    const provider = new KBEngineReferencesProvider(manager);
    const result = await provider.provideReferences(
      defDoc(),
      methodPosition(),
      { includeDeclaration: false },
      undefined
    );
    expect(result).not.toBeNull();
    expect(result!).toHaveLength(1);
    expect(result![0].uri.fsPath).toBe('/tmp/ws/scripts/base/Gate.py');
    // 引用位=调用点(callLine/callCharacter,1 基转 0 基),长度=方法名
    expect(result![0].range.start.line).toBe(11);
    expect(result![0].range.start.character).toBe(4);
    // 统一符号身份:解析链收到光标词与段,不是裸名字搜索
    expect(calls.identityArgs[0][2]).toBe('reqPos');
    expect(calls.identityArgs[0][3]).toBe('BaseMethods');
    expect(calls.implementationArgs).toHaveLength(1);
    expect(calls.incomingArgs[0][0]).toBe('/tmp/ws/scripts/base/Avatar.py');
    expect(calls.incomingArgs[0][1]).toBe('reqPos');
    // IDE-NAV-003:BaseMethods 段配 receiver 'base'(段→receiver 反查表),不猜段
    expect(calls.receiverArgs[0][0]).toBe('/tmp/ws/scripts/entity_defs/Avatar.def');
    expect(calls.receiverArgs[0][1]).toBe('reqPos');
    expect(calls.receiverArgs[0][2]).toBe('base');
  });

  it('includeDeclaration:true 含精确声明,false 不含,且不重复(引用 API 补项/IDE-AUD-049)', async () => {
    const { manager } = managerStub({ filePath: '/tmp/ws/scripts/base/Avatar.py', line: 2, character: 4 });
    const provider = new KBEngineReferencesProvider(manager);

    // 方法段(RPC):includeDeclaration=true 时声明(def 内 <reqPos>)入列
    const withDecl = await provider.provideReferences(
      defDoc(), methodPosition(), { includeDeclaration: true }, undefined
    );
    expect(withDecl).not.toBeNull();
    const methodDecl = withDecl!.filter(loc => loc.uri.fsPath === '/tmp/ws/scripts/entity_defs/Avatar.def');
    expect(methodDecl).toHaveLength(1);
    expect(methodDecl[0].range.start.line).toBe(7);

    // includeDeclaration=false 时不含 def 声明(实现/python 调用点不是声明)
    const withoutDecl = await provider.provideReferences(
      defDoc(), methodPosition(), { includeDeclaration: false }, undefined
    );
    expect(withoutDecl!.filter(loc => loc.uri.fsPath === '/tmp/ws/scripts/entity_defs/Avatar.def')).toHaveLength(0);

    // 属性段:同样受 includeDeclaration 支配,声明(def 内 <hp>)不重复
    const propWith = await provider.provideReferences(
      defDoc(), new Position(2, 6), { includeDeclaration: true }, undefined
    );
    const propDecl = propWith!.filter(loc => loc.uri.fsPath === '/tmp/ws/scripts/entity_defs/Avatar.def');
    expect(propDecl).toHaveLength(1);
    expect(propDecl[0].range.start.line).toBe(2);
  });

  it('属性段不出方法引用(NAV-002 前如实空),非 def 文档与取消位同理 null', async () => {
    const { manager } = managerStub({ filePath: '/tmp/ws/scripts/base/Avatar.py', line: 2, character: 4 });
    const provider = new KBEngineReferencesProvider(manager);
    // Properties 段 hp 位:属性 self 访问面接管(NAV-002),桩空引用如实空
    const propertyResult = await provider.provideReferences(
      defDoc(),
      new Position(2, 6),
      { includeDeclaration: false },
      undefined
    );
    expect(propertyResult).toEqual([]);

    const pyDoc = makeTextDocument('def reqPos(self):\n    pass\n', {
      fileName: '/tmp/ws/scripts/base/Avatar.py', languageId: 'python'
    });
    expect(await provider.provideReferences(
      pyDoc as never, methodPosition(), { includeDeclaration: false }, undefined
    )).toBeNull();

    const cancelled = { isCancellationRequested: true } as never;
    expect(await provider.provideReferences(
      defDoc(), methodPosition(), { includeDeclaration: false }, cancelled
    )).toBeNull();
  });

  it('实现未解析:无 receiver 调用 → null;有 receiver 调用 → 只出 receiver 位(NAV-003)', async () => {
    const empty = managerStub(null);
    const emptyProvider = new KBEngineReferencesProvider(empty.manager);
    expect(await emptyProvider.provideReferences(
      defDoc(), methodPosition(), { includeDeclaration: false }, undefined
    )).toBeNull();
    expect(empty.calls.incomingArgs, '无实现即无实现链查询,不猜').toHaveLength(0);

    // 纯声明方法(ClientMethods 常态)也有 receiver RPC 引用面
    const { manager, calls } = managerStub(null, [
      { filePath: '/tmp/ws/scripts/base/Gate.py', line: 20, character: 8 }
    ]);
    const provider = new KBEngineReferencesProvider(manager);
    const result = await provider.provideReferences(
      defDoc(), methodPosition(), { includeDeclaration: false }, undefined
    );
    expect(result).not.toBeNull();
    expect(result!).toHaveLength(1);
    expect(result![0].uri.fsPath).toBe('/tmp/ws/scripts/base/Gate.py');
    expect(result![0].range.start.line).toBe(19);
    expect(calls.incomingArgs, 'receiver-only 路径不走实现链').toHaveLength(0);
  });

  it('注册面:def 文档选择器上注册引用提供者(Shift+F12 入口)', async () => {
    // 静态锁:类实现 vscode.ReferenceProvider 形状(注册断言在 extension.test.ts
    // 的 languagesRegistry.referenceRegistrations)
    const { manager } = managerStub({ filePath: '/tmp/x.py', line: 1, character: 0 });
    const provider = new KBEngineReferencesProvider(manager);
    expect(typeof (provider as unknown as { provideReferences: unknown }).provideReferences)
      .toBe('function');
    // 调用层级 prepare 与引用共用同链的旁证:两个类都存在且不抛
    expect(new KBEngineCallHierarchyProvider(manager)).toBeInstanceOf(KBEngineCallHierarchyProvider);
    expect(Uri.file('/tmp/ws/scripts/base/Gate.py').fsPath).toContain('Gate.py');
  });
});
