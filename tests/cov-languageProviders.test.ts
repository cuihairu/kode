import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
  KBEngineCompletionProvider,
  KBEngineDocumentSymbolProvider,
  KBEngineHoverProvider,
  KBEngineImplementationProvider,
  KBEngineMethodImplementationCodeActionProvider,
  KBEngineReferencesProvider,
  KBEngineTypeCodeActionProvider,
  KBEngineBuiltinTypeInlayHintsProvider,
  PythonDefinitionProvider,
  prewarmKbengineIndex,
  setPythonMroJumpEnabled,
  UNKNOWN_TYPE_DIAGNOSTIC_CODE
} from '../src/languageProviders';
import { findKbeDataDictAccesses } from '../src/globalDataIndex';
import { setJumpLogEnabled } from '../src/navigationLog';
import type { EntityMappingManager } from '../src/entityMapping';
import { Diagnostic, Position, Range, makeTextDocument, workspace as stubWorkspace } from './helpers/vscodeStub';
import type { MinimalTextDocument } from './helpers/vscodeStub';

// 覆盖率补齐:languageProviders 内建属性补全面(用户令 2026-10-21 内建属性
// 单 ③)的 manager 分支——def 归属面判定 getEntityComponentFacesForPythonFile
// 的 null(非实体→不接管)/单面/多面(只给宏公共 3)/reject(落空回 []) 四路。
// 既有用例(补全/悬停/定义面)已覆盖主链,此处专攻 provideBuiltinProperty
// Completions 的 then/catch 收尾。

const pyDocument = (text: string, fileName = 'scripts/Hero.py'): MinimalTextDocument =>
  makeTextDocument(text, { fileName: `/tmp/ws/${fileName}`, languageId: 'python' });

const manager = (faces: (readonly string[] | null) | 'reject'): EntityMappingManager =>
  ({
    getEntityComponentFacesForPythonFile: (): Promise<readonly string[] | null> =>
      faces === 'reject'
        ? Promise.reject(new Error('boom'))
        : Promise.resolve(faces as readonly string[] | null)
  } as unknown as EntityMappingManager);

describe('KBEngineCompletionProvider 内建属性补全 manager 分支(覆盖率)', () => {
  const complete = async (
    faces: readonly string[] | null | 'reject',
    lineText: string
  ): Promise<unknown> => {
    const provider = new KBEngineCompletionProvider(manager(faces));
    const document = pyDocument(lineText);
    const position = new Position(0, lineText.length);
    return provider.provideCompletionItems(document, position);
  };

  it('faces=null(非实体无 def 归属)→ 空表不接管', async () => {
    expect(await complete(null, 'self.')).toEqual([]);
  });

  it('faces=单面 → 给该面全量内建属性项(非空)', async () => {
    const items = (await complete(['client'], 'self.')) as { label: unknown }[];
    expect(items.length).toBeGreaterThan(0);
    expect(items[0].label).toBeTruthy();
  });

  it('faces=多面歧义 → 只给宏公共 3(非空但少于单面全量)', async () => {
    const multi = (await complete(['client', 'cell'], 'self.')) as unknown[];
    const single = (await complete(['client'], 'self.')) as unknown[];
    expect(multi.length).toBeGreaterThan(0);
    expect(multi.length).toBeLessThan(single.length);
  });

  it('faces=reject → 落空回 []', async () => {
    expect(await complete('reject', 'self.')).toEqual([]);
  });
});

describe('KBEngineHoverProvider 内建属性悬停 def 归属 catch(覆盖率)', () => {
  it('无目录域路径 + manager 面判定 reject → 落空不炸(1114-1117)', async () => {
    const provider = new KBEngineHoverProvider(manager('reject'));
    // 路径无 base/cell/client 段 → pathFace=null → 走 try/catch;
    // manager.getEntityComponentFacesForPythonFile reject → catch 置 defFaces=null。
    // self.client 单段访问,光标在 client 名上(char 21)。
    const document = pyDocument(
      'class Hero:\n    def onTimer(self):\n        print(self.client)\n',
      'scripts/Hero.py'
    );
    const result = await provider.provideHover(document, new Position(2, 21));
    // 非实体脚本(pathFace+defFaces 双空)→ resolveEntityBuiltinPropertyHit=null
    // → 落回普通 hover 链;不外抛即覆盖 try/catch,值 null 或普通链产物均算通过。
    expect(result === null || result === undefined).toBe(true);
  });
});

// IDE-NAV-001 引用查询入口的守卫分支补面(覆盖率):def 原生引用查询在
// 各早退闸(非 def 文档/无词/词非符号/属性取消/身份未解析)上的行为——
// 每条 it 锁一个真实守卫,不做「调 getter 刷行数」的空转。
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

const defDocument = (): MinimalTextDocument =>
  makeTextDocument(DEF_TEXT, { fileName: '/tmp/ws/scripts/entity_defs/Avatar.def' });

const provideRefs = (
  provider: KBEngineReferencesProvider,
  document: MinimalTextDocument,
  position: Position,
  token?: unknown
): Promise<unknown> =>
  provider.provideReferences(document, position, { includeDeclaration: false }, token as never);

const provideCodeActions = (
  provider: KBEngineMethodImplementationCodeActionProvider,
  document: MinimalTextDocument,
  position: Position,
  token?: unknown
): Promise<unknown> =>
  provider.provideCodeActions(document, new Range(position, position), {}, token as never);

const codeManagerFor = (overrides: {
  ownerFiles?: unknown[];
  impl?: Promise<unknown[]>;
}): EntityMappingManager =>
  ({
    resolveDefinitionSymbolAtPosition: () =>
      Promise.resolve({ symbolName: 'reqPos', section: 'BaseMethods', ownerName: 'Avatar' }),
    listMethodImplementationsByIdentity: () => overrides.impl ?? Promise.resolve([]),
    listOwnerScriptFilesForIdentity: () => Promise.resolve(overrides.ownerFiles ?? [])
  } as unknown as EntityMappingManager);

describe('KBEngineReferencesProvider def 分支守卫(覆盖率)', () => {
  const refsManager = (overrides: {
    identity?: unknown;
    impl?: unknown;
    propertyAccesses?: unknown[];
    receiverCalls?: unknown[];
  } = {}): EntityMappingManager =>
    ({
      resolveDefinitionSymbolAtPosition: () =>
        Promise.resolve(
          'identity' in overrides
            ? overrides.identity
            : { symbolName: 'x', section: 'BaseMethods' }
        ),
      resolveMethodImplementationByIdentity: () => Promise.resolve(overrides.impl ?? null),
      getIncomingPythonMethodCalls: () => Promise.resolve([]),
      getIncomingPythonPropertyAccesses: () => Promise.resolve(overrides.propertyAccesses ?? []),
      getIncomingPythonReceiverCalls: () => Promise.resolve(overrides.receiverCalls ?? [])
    } as unknown as EntityMappingManager);

  const provide = (
    provider: KBEngineReferencesProvider,
    document: MinimalTextDocument,
    position: Position,
    token?: unknown
  ): Promise<unknown> =>
    provider.provideReferences(document, position, { includeDeclaration: false }, token as never);

  it('非 def 且非 py 文档:def 引用闸不接管 → null', async () => {
    const provider = new KBEngineReferencesProvider(refsManager());
    const txt = makeTextDocument('hello\n', {
      fileName: '/tmp/ws/README.txt', languageId: 'plaintext'
    });
    expect(await provide(provider, txt, new Position(0, 1))).toBeNull();
  });

  it('无词位(空白):getWordRangeAtPosition 落空 → null', async () => {
    const provider = new KBEngineReferencesProvider(refsManager());
    expect(await provide(provider, defDocument(), new Position(1, 1))).toBeNull();
  });

  it('词非符号(如 UINT32 值文本):findDefSymbolInfo 落空 → null', async () => {
    const provider = new KBEngineReferencesProvider(refsManager());
    // 行 3 是 `<Type>UINT32</Type>`,词 UINT32 不是符号名(Type)→ 不猜
    expect(await provide(provider, defDocument(), new Position(3, 12))).toBeNull();
  });

  it('属性段 + 中途取消:属性访问回程取消 → null(不落空壳列表)', async () => {
    const provider = new KBEngineReferencesProvider(refsManager());
    const token = { isCancellationRequested: false };
    const pending = provide(provider, defDocument(), new Position(2, 6), token);
    // 同步段已过方法口,置取消 → 属性 await 回程见取消 → 5372 早退
    token.isCancellationRequested = true;
    expect(await pending).toBeNull();
  });

  it('身份未解析(identity=null):早退 → null,不发起实现链查询', async () => {
    const provider = new KBEngineReferencesProvider(refsManager({ identity: null }));
    expect(await provide(provider, defDocument(), new Position(7, 6))).toBeNull();
  });
});

// IDE-NAV-007 实现查询与 IDE-NAV-014 空方法生成的守卫分支(覆盖率):
// 与引用查询同构的早退闸,每条 it 锁一个真实守卫。
describe('KBEngineImplementationProvider 守卫(覆盖率)', () => {
  const implManager = (identity: unknown = { symbolName: 'x', section: 'BaseMethods' }) =>
    ({
      resolveDefinitionSymbolAtPosition: () => Promise.resolve(identity),
      listMethodImplementationsByIdentity: () => Promise.resolve([])
    } as unknown as EntityMappingManager);

  const provideImpl = (
    provider: KBEngineImplementationProvider,
    document: MinimalTextDocument,
    position: Position
  ): Promise<unknown> => provider.provideImplementation(document, position, undefined);

  it('非 def 文档:实现查询不接管 → null', async () => {
    const provider = new KBEngineImplementationProvider(implManager());
    const py = makeTextDocument('class A:\n    pass\n', {
      fileName: '/tmp/ws/scripts/base/A.py', languageId: 'python'
    });
    expect(await provideImpl(provider, py, new Position(1, 6))).toBeNull();
  });

  it('无词位(空白)→ null', async () => {
    const provider = new KBEngineImplementationProvider(implManager());
    expect(await provideImpl(provider, defDocument(), new Position(1, 1))).toBeNull();
  });

  it('属性段/词非符号 → null(不猜实现)', async () => {
    const provider = new KBEngineImplementationProvider(implManager());
    // 属性段 hp:非方法段 → 5581 早退
    expect(await provideImpl(provider, defDocument(), new Position(2, 6))).toBeNull();
    // UINT32 值文本非符号名 → 同样早退
    expect(await provideImpl(provider, defDocument(), new Position(3, 12))).toBeNull();
  });

  it('身份未解析(identity=null)→ null,不发起实现列表查询', async () => {
    const provider = new KBEngineImplementationProvider(implManager(null));
    expect(await provideImpl(provider, defDocument(), new Position(7, 6))).toBeNull();
  });
});

describe('KBEngineMethodImplementationCodeActionProvider 守卫(覆盖率)', () => {
  const codeManager = (identity: unknown = { symbolName: 'x', section: 'BaseMethods' }) =>
    ({
      resolveDefinitionSymbolAtPosition: () => Promise.resolve(identity),
      listMethodImplementationsByIdentity: () => Promise.resolve([]),
      listOwnerScriptFilesForIdentity: () => Promise.resolve([])
    } as unknown as EntityMappingManager);

  const provideCode = (
    provider: KBEngineMethodImplementationCodeActionProvider,
    document: MinimalTextDocument,
    position: Position
  ): Promise<unknown> =>
    provider.provideCodeActions(document, new Range(position, position), {}, undefined);

  it('非 def 文档:空方法生成不接管 → []', async () => {
    const provider = new KBEngineMethodImplementationCodeActionProvider(codeManager());
    const py = makeTextDocument('class A:\n    pass\n', {
      fileName: '/tmp/ws/scripts/base/A.py', languageId: 'python'
    });
    expect(await provideCode(provider, py, new Position(1, 6))).toEqual([]);
  });

  it('无词位(空白)→ []', async () => {
    const provider = new KBEngineMethodImplementationCodeActionProvider(codeManager());
    expect(await provideCode(provider, defDocument(), new Position(1, 1))).toEqual([]);
  });

  it('属性段/词非符号 → []', async () => {
    const provider = new KBEngineMethodImplementationCodeActionProvider(codeManager());
    expect(await provideCode(provider, defDocument(), new Position(2, 6))).toEqual([]);
    expect(await provideCode(provider, defDocument(), new Position(3, 12))).toEqual([]);
  });

  it('身份未解析(identity=null)→ []', async () => {
    const provider = new KBEngineMethodImplementationCodeActionProvider(codeManager(null));
    expect(await provideCode(provider, defDocument(), new Position(7, 6))).toEqual([]);
  });
});

// IDE-NAV-013 未注册类型修正候选的守卫分支(覆盖率):候选只对账同码
// 诊断且区间相交;异码/不相交诊断跳过,不建动作。
describe('KBEngineTypeCodeActionProvider 守卫(覆盖率)', () => {
  it('异码诊断:continue 跳过,不出动作', () => {
    const provider = new KBEngineTypeCodeActionProvider();
    const doc = defDocument();
    const other = new Diagnostic(
      new Range(new Position(0, 0), new Position(0, 5)), 'x', 1
    );
    other.code = 'kbengine.other';
    const actions = provider.provideCodeActions(
      doc, new Range(new Position(0, 0), new Position(0, 5)),
      { diagnostics: [other] }, undefined
    );
    expect(actions).toEqual([]);
  });

  it('同码但区间不相交:continue 跳过,不出动作', () => {
    const provider = new KBEngineTypeCodeActionProvider();
    const doc = defDocument();
    const unknown = new Diagnostic(
      new Range(new Position(0, 0), new Position(0, 5)), 'x', 1
    );
    unknown.code = UNKNOWN_TYPE_DIAGNOSTIC_CODE;
    const actions = provider.provideCodeActions(
      doc, new Range(new Position(5, 0), new Position(5, 5)),
      { diagnostics: [unknown] }, undefined
    );
    expect(actions).toEqual([]);
  });
});

// 分层跳转追踪(用户 2026-10-16)的取消与异常终态(覆盖率):内层取消位
// 返回明确「cancelled」结果,不抛不查;metrics 记 cancelled 而非 error。
describe('PythonDefinitionProvider 取消终态(覆盖率)', () => {
  it('取消位:traced 内层直接返回取消结果,不触 manager', async () => {
    const provider = new PythonDefinitionProvider({} as unknown as EntityMappingManager);
    const doc = pyDocument('x = 1\n', 'scripts/Hero.py');
    const cancelled = { isCancellationRequested: true } as never;
    const traced = await provider.provideDefinitionTraced(doc, new Position(0, 1), cancelled);
    expect(traced.location).toBeNull();
    expect(traced.layers).toContainEqual(
      expect.objectContaining({ layer: 'context', status: 'skip', detail: 'cancelled' })
    );
  });
});

// resolveDataDictSitesAtPosition(3944-3946):索引 ensureStarted 已过、落点
// 键表达式命中,但取消位在 await 回程置位 → 早退 null,不查 query(零工作)。
// 与上一例(impl 口取消)互补:本例同步前缀已深入索引层。
describe('PythonDefinitionProvider 数据字典键取消位(覆盖率)', () => {
  it('ensureStarted 后取消:键早退 null,query 不被调用', async () => {
    const dataDictIndex = {
      ensureStarted: async (): Promise<void> => undefined,
      query: (): never => { throw new Error('query must not run after cancel'); }
    } as never;
    const provider = new PythonDefinitionProvider(
      {} as unknown as EntityMappingManager, undefined, dataDictIndex
    );
    const doc = pyDocument('import KBEngine\nKBEngine.globalData["cfg"] = 1\n');
    const lineText = doc.getText().split('\n')[1];
    const access = findKbeDataDictAccesses(lineText, new Set(['KBEngine']))[0];
    expect(access).toBeDefined();
    const token = { isCancellationRequested: false };
    const pending = provider.provideDefinitionTraced(
      doc, new Position(1, access.keyStart + 1), token as never
    );
    token.isCancellationRequested = true;
    const traced = await pending;
    expect(traced.location).toBeNull();
    expect(traced.layers).toContainEqual(
      expect.objectContaining({ layer: 'context', status: 'skip', detail: 'cancelled' })
    );
  });
});

// 语义查询外层 catch(4075-4078):impl 内任何未捕获异常 → metrics 记 error
// 后原样重抛(不打断调用方错误处理)。经 dataDictIndex.query 抛错直达。
// 类基类回退 catch(4197-4199)+ layerErrorMessage 非 Error 分支(3993):
// resolveClassBase 以非 Error 值(string)拒绝,catch 内 String(error) 记录。
describe('PythonDefinitionProvider 异常终态与基类回退 catch(覆盖率)', () => {
  it('query 抛错:traced 整体 rejects(error 打点后重抛)', async () => {
    const dataDictIndex = {
      ensureStarted: async (): Promise<void> => undefined,
      query: (): never => { throw new Error('query boom'); }
    } as never;
    const provider = new PythonDefinitionProvider(
      {} as unknown as EntityMappingManager, undefined, dataDictIndex
    );
    const doc = pyDocument('import KBEngine\nKBEngine.globalData["cfg"] = 1\n');
    const lineText = doc.getText().split('\n')[1];
    const access = findKbeDataDictAccesses(lineText, new Set(['KBEngine']))[0];
    await expect(
      provider.provideDefinitionTraced(doc, new Position(1, access.keyStart + 1))
    ).rejects.toThrow('query boom');
  });

  it('类基类解析以字符串拒绝:catch 记录后不炸,落回 context miss', async () => {
    const pythonClassIndex = {
      resolveClassBase: (): Promise<never> => Promise.reject('plain string boom')
    } as never;
    const provider = new PythonDefinitionProvider(
      {} as unknown as EntityMappingManager, pythonClassIndex
    );
    // import Base 使显式导入成立;光标落在 class X(Base) 的 Base 上。
    // jumpLog 惰性求值,开启后 catch 内 layerErrorMessage 实求,覆盖 String 分支。
    setJumpLogEnabled(true);
    try {
      const doc = pyDocument('import Base\nclass X(Base):\n    pass\n');
      const traced = await provider.provideDefinitionTraced(doc, new Position(1, 9));
      expect(traced.location).toBeNull();
      expect(traced.layers.at(-1)).toMatchObject({ layer: 'context', status: 'miss' });
    } finally {
      setJumpLogEnabled(false);
    }
  });

  it('未导入基类的 mro 回退 catch:同形非 Error 拒绝 → 不炸落 context miss', async () => {
    const pythonClassIndex = {
      resolveClassBase: (): Promise<never> => Promise.reject('unimported base boom')
    } as never;
    const provider = new PythonDefinitionProvider(
      {} as unknown as EntityMappingManager, pythonClassIndex
    );
    // 无 import Base → explicitlyImportedBase=false → 4224 分支的 catch(4234)
    const doc = pyDocument('class X(Base):\n    pass\n');
    const traced = await provider.provideDefinitionTraced(doc, new Position(0, 9));
    expect(traced.location).toBeNull();
    expect(traced.layers.at(-1)).toMatchObject({ layer: 'context', status: 'miss' });
  });
});

// 方法段引用/实现/代码动作的「await 回程取消」守卫(5399/5415/5431/5586/
// 5740):每处置取消位前必须先让前一个 await 落定——用可控门把翻转到精确
// 位置,不靠竞速。5468(工作区符号非段子节点跳过)/5749/5755/5759 同批。
const deferred = <T>(): { promise: Promise<T>; resolve: (value: T) => void } => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
};
const flush = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));
const METHOD_POS = new Position(7, 6); // DEF_TEXT 第 7 行 <reqPos>(BaseMethods)

describe('def 引用回程取消守卫(覆盖率)', () => {
  const gateRefs = (gates: {
    impl?: Promise<unknown>;
    receiverCalls?: Promise<unknown[]>;
    methodCalls?: Promise<unknown[]>;
    implValue?: unknown;
  }): EntityMappingManager =>
    ({
      resolveDefinitionSymbolAtPosition: () =>
        Promise.resolve({ symbolName: 'reqPos', section: 'BaseMethods' }),
      resolveMethodImplementationByIdentity: () => gates.impl ?? Promise.resolve(gates.implValue ?? null),
      getIncomingPythonReceiverCalls: () => gates.receiverCalls ?? Promise.resolve([]),
      getIncomingPythonMethodCalls: () => gates.methodCalls ?? Promise.resolve([]),
      getIncomingPythonPropertyAccesses: () => Promise.resolve([])
    } as unknown as EntityMappingManager);

  it('实现解析回程取消:5399 return null', async () => {
    const implGate = deferred<unknown>();
    const provider = new KBEngineReferencesProvider(gateRefs({ impl: implGate.promise }));
    const token = { isCancellationRequested: false };
    const pending = provideRefs(provider, defDocument(), METHOD_POS, token);
    await flush();
    token.isCancellationRequested = true;
    implGate.resolve(null);
    expect(await pending).toBeNull();
  });

  it('receiver 调用回程取消:5415 return null', async () => {
    const receiverGate = deferred<unknown[]>();
    const provider = new KBEngineReferencesProvider(gateRefs({ receiverCalls: receiverGate.promise }));
    const token = { isCancellationRequested: false };
    const pending = provideRefs(provider, defDocument(), METHOD_POS, token);
    await flush();
    token.isCancellationRequested = true;
    receiverGate.resolve([]);
    expect(await pending).toBeNull();
  });

  it('方法调用回程取消:5431 return null(需实现非空)', async () => {
    const callsGate = deferred<unknown[]>();
    const provider = new KBEngineReferencesProvider(gateRefs({
      methodCalls: callsGate.promise, implValue: { filePath: '/x.py' }
    }));
    const token = { isCancellationRequested: false };
    const pending = provideRefs(provider, defDocument(), METHOD_POS, token);
    await flush();
    token.isCancellationRequested = true;
    callsGate.resolve([]);
    expect(await pending).toBeNull();
  });
});

describe('工作区符号非段子节点跳过(5468)', () => {
  it('<Parent> 等非符号段不进 Outline,段内属性/方法照常', async () => {
    const provider = new KBEngineDocumentSymbolProvider();
    const doc = makeTextDocument([
      '<root>',
      '  <Parent>Monster</Parent>',
      '  <Properties>',
      '    <hp><Type>UINT32</Type></hp>',
      '  </Properties>',
      '</root>'
    ].join('\n'), { fileName: '/tmp/ws/scripts/entity_defs/Avatar.def' });
    const symbols = await provider.provideDocumentSymbols(doc, undefined);
    expect(symbols).not.toBeNull();
    expect(symbols!.map(s => s.name)).toEqual(['Properties']);
    expect(symbols![0].children.map(c => c.name)).toEqual(['hp']);
  });
});

describe('KBEngineImplementationProvider 回程取消(5586)', () => {
  it('实现列表回程取消 → null', async () => {
    const implGate = deferred<unknown[]>();
    const provider = new KBEngineImplementationProvider({
      resolveDefinitionSymbolAtPosition: () =>
        Promise.resolve({ symbolName: 'reqPos', section: 'BaseMethods' }),
      listMethodImplementationsByIdentity: () => implGate.promise
    } as unknown as EntityMappingManager);
    const token = { isCancellationRequested: false };
    const pending = provider.provideImplementation(defDocument(), METHOD_POS, token as never);
    await flush();
    token.isCancellationRequested = true;
    implGate.resolve([]);
    expect(await pending).toBeNull();
  });
});

describe('KBEngineMethodImplementationCodeActionProvider 分支(覆盖率)', () => {
  const codeGate = (gates: {
    impl?: Promise<unknown[]>;
    ownerFiles?: Promise<unknown[]> | unknown[];
  }): EntityMappingManager =>
    ({
      resolveDefinitionSymbolAtPosition: () =>
        Promise.resolve({ symbolName: 'reqPos', section: 'BaseMethods', ownerName: 'Avatar' }),
      listMethodImplementationsByIdentity: () => gates.impl ?? Promise.resolve([]),
      listOwnerScriptFilesForIdentity: () =>
        gates.ownerFiles ? Promise.resolve(gates.ownerFiles as never) : Promise.resolve([])
    } as unknown as EntityMappingManager);

  it('实现列表回程取消 → []', async () => {
    const implGate = deferred<unknown[]>();
    const provider = new KBEngineMethodImplementationCodeActionProvider(codeGate({ impl: implGate.promise }));
    const token = { isCancellationRequested: false };
    const pending = provideCodeActions(provider, defDocument(), METHOD_POS, token);
    await flush();
    token.isCancellationRequested = true;
    implGate.resolve([]);
    expect(await pending).toEqual([]);
  });

  it('owner 脚本为空 → []', async () => {
    const provider = new KBEngineMethodImplementationCodeActionProvider(codeGate({ ownerFiles: [] }));
    expect(await provideCodeActions(provider, defDocument(), METHOD_POS)).toEqual([]);
  });

  it('owner 脚本快照缺失 → []', async () => {
    const provider = new KBEngineMethodImplementationCodeActionProvider(codeGate({
      ownerFiles: ['/nonexistent-owner/Avatar.py']
    }));
    expect(await provideCodeActions(provider, defDocument(), METHOD_POS)).toEqual([]);
  });

  it('owner 脚本无类块 → []', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-owner-'));
    const owner = path.join(root, 'Avatar.py');
    fs.writeFileSync(owner, 'x = 1\n', 'utf8');
    try {
      const provider = new KBEngineMethodImplementationCodeActionProvider(codeGate({ ownerFiles: [owner] }));
      expect(await provideCodeActions(provider, defDocument(), METHOD_POS)).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// 5622:同码诊断但区间内文本为空(零宽区间)→ continue 跳过不建动作。
// 5677:类体后出现顶格语句(indent<4)→ 类块扫描终止,插入点=类体末。
describe('类型修正候选空名与类块终止(覆盖率)', () => {
  it('零宽区间诊断:text 空 → continue 不出动作', () => {
    const provider = new KBEngineTypeCodeActionProvider();
    const doc = defDocument();
    const zeroWidth = new Diagnostic(new Range(new Position(0, 0), new Position(0, 0)), 'x', 1);
    zeroWidth.code = UNKNOWN_TYPE_DIAGNOSTIC_CODE;
    const actions = provider.provideCodeActions(
      doc, new Range(new Position(0, 0), new Position(0, 5)),
      { diagnostics: [zeroWidth] }, undefined
    );
    expect(actions).toEqual([]);
  });

  it('owner 脚本类体后有顶格语句:插入点取类体末,动作照常生成', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-owner2-'));
    const owner = path.join(root, 'Avatar.py');
    fs.writeFileSync(owner, 'class Avatar:\n    def a(self):\n        pass\nx = 1\n', 'utf8');
    try {
      const provider = new KBEngineMethodImplementationCodeActionProvider(codeManagerFor({ ownerFiles: [owner] }));
      const actions = await provider.provideCodeActions(
        defDocument(), new Range(METHOD_POS, METHOD_POS), {}, undefined
      ) as Array<{ title: string }>;
      expect(actions.length).toBeGreaterThan(0);
      expect(actions[0].title).toContain('reqPos');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// 层2 python-mro(4678-4744)的候选/partial/miss/异常四终态,经声明方法路径
// (declaredMethodName)直达:manager 全 miss 后进入 mro 层,由桩索引返回
// 可控解析结果。同批覆盖 4461(enclosing 排序)。
const missManager = (): EntityMappingManager =>
  ({
    resolveMethodDefinition: () => Promise.resolve(null),
    resolveMethodDefinitionForClass: () => Promise.resolve(null),
    resolvePropertyDefinition: () => Promise.resolve(null),
    resolvePropertyDefinitionForClass: () => Promise.resolve(null),
    resolveMemberAccess: () => Promise.resolve(null)
  } as unknown as EntityMappingManager);

const mroProvider = (resolution: unknown): PythonDefinitionProvider =>
  new PythonDefinitionProvider(
    missManager(),
    { resolveSelfMethodResolution: () => Promise.resolve(resolution) } as never
  );

const methodDoc = (): MinimalTextDocument =>
  pyDocument('class Hero:\n    def onTimer(self):\n        return 0\n', 'scripts/Hero.py');

const METHOD_DECL_POS = new Position(1, 10);

describe('PythonDefinitionProvider mro 层终态(覆盖率)', () => {
  it('单候选:命中返回实现位置,记 python-mro hit', async () => {
    const traced = await mroProvider({
      candidates: [{ filePath: '/tmp/ws/scripts/base/Hero.py', line: 3, character: 4 }],
      partial: false
    }).provideDefinitionTraced(methodDoc(), METHOD_DECL_POS);
    expect(traced.location).not.toBeNull();
    expect(traced.layers).toContainEqual(
      expect.objectContaining({ layer: 'python-mro', status: 'hit' })
    );
  });

  it('多候选:返回全部位置(数组)', async () => {
    const traced = await mroProvider({
      candidates: [
        { filePath: '/a.py', line: 1, character: 0 },
        { filePath: '/b.py', line: 2, character: 0 }
      ],
      partial: false
    }).provideDefinitionTraced(methodDoc(), METHOD_DECL_POS);
    expect(Array.isArray(traced.location)).toBe(true);
    expect((traced.location as unknown[]).length).toBe(2);
  });

  it('零候选 + partial:记 partial,继续后续层兜底', async () => {
    const traced = await mroProvider({
      candidates: [], partial: true
    }).provideDefinitionTraced(methodDoc(), METHOD_DECL_POS);
    expect(traced.layers).toContainEqual(
      expect.objectContaining({ layer: 'python-mro', status: 'partial' })
    );
  });

  it('零候选非 partial:记 miss', async () => {
    const traced = await mroProvider({
      candidates: [], partial: false
    }).provideDefinitionTraced(methodDoc(), METHOD_DECL_POS);
    expect(traced.layers).toContainEqual(
      expect.objectContaining({ layer: 'python-mro', status: 'miss' })
    );
  });

  it('解析拒绝:异常降级为落空,不断链', async () => {
    const provider = new PythonDefinitionProvider(
      missManager(),
      { resolveSelfMethodResolution: (): Promise<never> => Promise.reject(new Error('mro boom')) } as never
    );
    const traced = await provider.provideDefinitionTraced(methodDoc(), METHOD_DECL_POS);
    expect(traced.layers).toContainEqual(
      expect.objectContaining({ layer: 'python-mro', status: 'miss', detail: expect.stringContaining('error') })
    );
  });
});

// 层0 接收者段闸(4481-4533):self.cell.onTimer 的命中/异常/落空三态——
// 命中记 entity-def hit 并返回声明位置;manager 拒绝记 error 降级;全 miss
// 记 miss。jumpLog 开启覆盖惰性日志闭包。
const receiverDoc = (): MinimalTextDocument =>
  pyDocument('class Hero:\n    def f(self):\n        self.cell.onTimer()\n', 'scripts/Hero.py');
const RECEIVER_POS = new Position(2, 19); // onTimer 名上

describe('PythonDefinitionProvider receiver 段闸(覆盖率)', () => {
  const receiverManager = (overrides: {
    classHit?: { defFile: string; line: number } | 'reject';
    fileHit?: { defFile: string; line: number };
  }): EntityMappingManager =>
    ({
      resolveMethodDefinitionForClass: () =>
        overrides.classHit === 'reject'
          ? Promise.reject(new Error('class probe boom'))
          : Promise.resolve(overrides.classHit ?? null),
      resolveMethodDefinition: () => Promise.resolve(overrides.fileHit ?? null)
    } as unknown as EntityMappingManager);

  it('对象级探针命中:返回 def 声明位置,entity-def hit', async () => {
    const traced = await new PythonDefinitionProvider(receiverManager({
      classHit: { defFile: '/tmp/ws/scripts/entity_defs/Hero.def', line: 5 }
    })).provideDefinitionTraced(receiverDoc(), RECEIVER_POS);
    expect(traced.location).not.toBeNull();
    expect(traced.layers).toContainEqual(
      expect.objectContaining({ layer: 'entity-def', status: 'hit' })
    );
  });

  it('对象级探针拒绝:降级记 error 后文件级兜底,不炸', async () => {
    setJumpLogEnabled(true);
    try {
      const traced = await new PythonDefinitionProvider(receiverManager({
        classHit: 'reject'
      })).provideDefinitionTraced(receiverDoc(), RECEIVER_POS);
      expect(traced.location).toBeNull();
      expect(traced.layers[0]).toMatchObject({ layer: 'entity-def', status: 'miss' });
      expect(traced.layers[0].detail).toContain('error');
    } finally {
      setJumpLogEnabled(false);
    }
  });

  it('两级探针全 miss:entity-def miss,detail 记两次 miss', async () => {
    setJumpLogEnabled(true);
    try {
      const traced = await new PythonDefinitionProvider(receiverManager({}))
        .provideDefinitionTraced(receiverDoc(), RECEIVER_POS);
      expect(traced.location).toBeNull();
      expect(traced.layers[0]).toMatchObject({ layer: 'entity-def', status: 'miss' });
      expect(traced.layers[0].detail).toContain('miss');
    } finally {
      setJumpLogEnabled(false);
    }
  });
});

// 惰性日志闭包(jumpLog 开启才求值):mro 命中/多候选/文件作用域命中
// 三条 detail 闭包——开启开关走真求值,覆盖 4703/4716/4761。
describe('PythonDefinitionProvider 跳转日志闭包(覆盖率)', () => {
  const withLog = async (provider: PythonDefinitionProvider): Promise<unknown> => {
    setJumpLogEnabled(true);
    try {
      return await provider.provideDefinitionTraced(methodDoc(), METHOD_DECL_POS);
    } finally {
      setJumpLogEnabled(false);
    }
  };

  it('mro 单候选命中:命中 detail 日志求值', async () => {
    const traced = await withLog(mroProvider({
      candidates: [{ filePath: '/tmp/ws/scripts/base/Hero.py', line: 3, character: 4 }],
      partial: false
    }));
    expect(traced.layers).toContainEqual(expect.objectContaining({ layer: 'python-mro', status: 'hit' }));
  });

  it('mro 多候选:候选列表 detail 日志求值', async () => {
    const traced = await withLog(mroProvider({
      candidates: [
        { filePath: '/a.py', line: 1, character: 0 },
        { filePath: '/b.py', line: 2, character: 0 }
      ],
      partial: false
    }));
    expect(Array.isArray(traced.location)).toBe(true);
  });

  it('文件作用域命中:基类方法兜底命中,命中日志求值', async () => {
    const baseDoc = pyDocument(
      'class Base:\n    def onTimer(self):\n        return 0\n' +
      'class Hero(Base):\n    def onTimer(self):\n        return 0\n',
      'scripts/Hero.py'
    );
    setJumpLogEnabled(true);
    try {
      const traced = await new PythonDefinitionProvider(
        missManager(),
        { resolveSelfMethodResolution: () => Promise.resolve({ candidates: [], partial: false }) } as never
      ).provideDefinitionTraced(baseDoc, new Position(4, 10));
      // Hero.onTimer(第4行)与光标同位置被排除,沿链落到 Base.onTimer(第1行)
      expect(traced.location).not.toBeNull();
      expect(traced.layers).toContainEqual(
        expect.objectContaining({ layer: 'file-scope', status: 'hit' })
      );
    } finally {
      setJumpLogEnabled(false);
    }
  });
});

// 嵌套类/嵌套接收者/方法探针命中回退/开关关闸(覆盖率):
// - 4461/4798:enclosing 与 file-scope 的 sort 比较体只在候选 ≥2 类时执行——
//   嵌套类(class A 含 class B)产生重叠区间,一行同时命中两类;
// - 4465:光标不在任何类体内 → enclosingNote 'no enclosing class';
// - 4615:self.component.hp 多段访问、探针全 miss → 嵌套接收者早退 miss;
// - 4644-4649+4777-4779:方法探针命中 → 记 deferred skip,后续层全落空后
//   回退 .def 声明行(Python implementation unavailable);
// - 4582-4603:属性命中后首扫等待 + 自定义类型声明 → propertyTypeLocation;
// - 4679-4680:enableMroJump 关闭 → 层2 只记 skip;
// - 4518:receiver 命中日志闭包在 jumpLog 开启下真求值。
describe('PythonDefinitionProvider 嵌套类与方法探针回退(覆盖率)', () => {
  it('嵌套类内的多段访问:enclosing 两类参与排序,探针全 miss 早退 nested receiver', async () => {
    const nested = pyDocument(
      'class A:\n    def f(self):\n        return\n    class B:\n        def f(self):\n            self.component.hp = 1\n'
    );
    // 行5 = 12 空格 + self.(5) + component.(10),hp 起于列 27
    const traced = await new PythonDefinitionProvider(missManager())
      .provideDefinitionTraced(nested, new Position(5, 27));
    expect(traced.location).toBeNull();
    expect(traced.layers[0]).toMatchObject({ layer: 'entity-def', status: 'miss' });
    expect(traced.layers[0].detail).toContain('nested receiver type is unknown');
  });

  it('光标不在任何类体内:enclosing 空,记 no enclosing class(4465)', async () => {
    const doc = pyDocument('self.hp = 1\nclass Hero:\n    pass\n');
    const traced = await new PythonDefinitionProvider(missManager())
      .provideDefinitionTraced(doc, new Position(0, 5));
    expect(traced.location).toBeNull();
    // enclosing 空 → file-scope 落空 detail 记 no enclosing class(4465 执行面)
    expect(traced.layers).toContainEqual(expect.objectContaining({
      layer: 'file-scope', detail: expect.stringContaining('no enclosing class')
    }));
  });

  it('嵌套类方法声明:file-scope 两类排序比较体执行(4798)', async () => {
    const doc = pyDocument(
      'class A:\n    def run(self):\n        return\n    class B:\n        def run(self):\n            return\n'
    );
    // 行4 = 8 空格 + def(3) + 空格,run 起于列 12;自身声明行被排除 → miss
    const traced = await new PythonDefinitionProvider(missManager())
      .provideDefinitionTraced(doc, new Position(4, 12));
    expect(traced.location).toBeNull();
    expect(traced.layers).toContainEqual(
      expect.objectContaining({ layer: 'file-scope', status: 'miss' })
    );
  });

  it('方法探针命中:deferred skip 后全层落空,回退 .def 声明行(4777)', async () => {
    const provider = new PythonDefinitionProvider({
      resolvePropertyDefinition: () => Promise.resolve(null),
      resolvePropertyDefinitionForClass: () => Promise.resolve(null),
      resolveMethodDefinition: () => Promise.resolve(null),
      resolveMethodDefinitionForClass: () =>
        Promise.resolve({ defFile: '/tmp/ws/scripts/entity_defs/Hero.def', line: 8 })
    } as unknown as EntityMappingManager);
    const traced = await provider.provideDefinitionTraced(selfAccessDoc(), SELF_HP_POS);
    // 实现优先口径:defLocation 先暂存(entity-def skip),层2/层3 落空后回退声明行
    expect(traced.location).not.toBeNull();
    expect((traced.location as { uri: { fsPath: string } }).uri.fsPath).toContain('Hero.def');
    expect(traced.layers).toContainEqual(expect.objectContaining({
      layer: 'entity-def', status: 'skip', detail: expect.stringContaining('deferred method declaration')
    }));
    expect(traced.layers.at(-1)).toMatchObject({
      layer: 'entity-def', status: 'hit', detail: expect.stringContaining('Python implementation unavailable')
    });
  });

  it('mro 开关关闭:层2 只记 skip 不查索引(4679)', async () => {
    setPythonMroJumpEnabled(false);
    try {
      const traced = await new PythonDefinitionProvider(missManager())
        .provideDefinitionTraced(methodDoc(), METHOD_DECL_POS);
      expect(traced.layers).toContainEqual(expect.objectContaining({
        layer: 'python-mro', status: 'skip', detail: 'disabled by kbengine.python.enableMroJump'
      }));
    } finally {
      setPythonMroJumpEnabled(true);
    }
  });

  it('receiver 段闸命中且 jumpLog 开启:命中日志闭包真求值(4518)', async () => {
    setJumpLogEnabled(true);
    try {
      const provider = new PythonDefinitionProvider({
        resolveMethodDefinitionForClass: () =>
          Promise.resolve({ defFile: '/tmp/ws/scripts/entity_defs/Hero.def', line: 5 }),
        resolveMethodDefinition: () => Promise.resolve(null)
      } as unknown as EntityMappingManager);
      const traced = await provider.provideDefinitionTraced(receiverDoc(), RECEIVER_POS);
      expect(traced.location).not.toBeNull();
      expect(traced.layers[0]).toMatchObject({ layer: 'entity-def', status: 'hit' });
    } finally {
      setJumpLogEnabled(false);
    }
  });

  it('属性命中后首扫等待与自定义类型声明:propertyTypeLocation 指向 types.xml(4582-4603)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-typedeff-'));
    const defsDir = path.join(root, 'scripts', 'entity_defs');
    fs.mkdirSync(defsDir, { recursive: true });
    fs.writeFileSync(path.join(defsDir, 'types.xml'), '<root>\n  <VEC3>UINT16</VEC3>\n</root>\n', 'utf8');
    stubWorkspace.workspaceFolders = [{ uri: { fsPath: root }, name: 'root', index: 0 } as never];
    try {
      const doc = makeTextDocument(
        'class Hero:\n    def f(self):\n        self.hp = 1\n',
        { fileName: path.join(root, 'scripts', 'Hero.py'), languageId: 'python' }
      );
      const provider = new PythonDefinitionProvider({
        resolvePropertyDefinitionForClass: () =>
          Promise.resolve({ defFile: path.join(defsDir, 'Hero.def'), line: 3 }),
        resolvePropertyDefinition: () => Promise.resolve(null),
        waitForInitialScan: () => Promise.resolve(),
        getIndexForPythonFile: () => ({
          propertyDefinitions: { hp: { identity: { symbolName: 'hp' }, typeName: 'VEC3' } }
        })
      } as never);
      const traced = await provider.provideDefinitionTraced(doc, new Position(2, 13));
      // propertyTypeLocation 优先于 defLocation:返回 types.xml 的 VEC3 声明行
      expect(traced.location).not.toBeNull();
      expect((traced.location as { uri: { fsPath: string } }).uri.fsPath).toContain('types.xml');
    } finally {
      stubWorkspace.workspaceFolders = [];
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// access 路径(self.hp 属性)的属性探针链(4546-4665):对象级探针命中 →
// defLocation 置位后越过嵌套接收者早退,返回 entity-def hit;探针拒绝记
// error。receiver 命中日志闭包(4518)在 jumpLog 开启下求值。
const selfAccessDoc = (): MinimalTextDocument =>
  pyDocument('class Hero:\n    def f(self):\n        self.hp = 1\n', 'scripts/Hero.py');
const SELF_HP_POS = new Position(2, 13); // hp 名上

describe('PythonDefinitionProvider 属性探针链(覆盖率)', () => {
  it('对象级属性探针命中:entity-def hit(越过嵌套接收者早退)', async () => {
    setJumpLogEnabled(true);
    try {
      const provider = new PythonDefinitionProvider({
        resolvePropertyDefinitionForClass: () =>
          Promise.resolve({ defFile: '/tmp/ws/scripts/entity_defs/Hero.def', line: 3 }),
        resolvePropertyDefinition: () => Promise.resolve(null)
      } as unknown as EntityMappingManager);
      const traced = await provider.provideDefinitionTraced(selfAccessDoc(), SELF_HP_POS);
      expect(traced.location).not.toBeNull();
      expect(traced.layers).toContainEqual(
        expect.objectContaining({ layer: 'entity-def', status: 'hit' })
      );
    } finally {
      setJumpLogEnabled(false);
    }
  });

  it('对象级属性探针拒绝:记 error 后文件级兜底,落回嵌套接收者 miss', async () => {
    const provider = new PythonDefinitionProvider({
      resolvePropertyDefinitionForClass: () => Promise.reject(new Error('prop boom')),
      resolvePropertyDefinition: () => Promise.resolve(null)
    } as unknown as EntityMappingManager);
    const traced = await provider.provideDefinitionTraced(selfAccessDoc(), SELF_HP_POS);
    expect(traced.location).toBeNull();
    // 属性探针全 miss + 嵌套接收者 → 4614 早退记 miss
    expect(traced.layers[0]).toMatchObject({ layer: 'entity-def', status: 'miss' });
  });
});

// KBEngineHoverProvider 注入面分支(覆盖率):def 方法/接收者调用的映射
// 拒绝与签名闸、declaredArgs 空串「只出名不造型」、数据字典键悬停三态
// (写点推不出/读点无写点/回程取消)、同点位在途 memo 超限驱逐、
// prewarm 预热收尾、builtin inlay 无 manager 早退。
const DICT_WRITE_DOC = (): MinimalTextDocument =>
  pyDocument("import KBEngine\nKBEngine.globalData['cfg'] = makeThing()\n", 'scripts/Hero.py');
const DICT_READ_DOC = (): MinimalTextDocument =>
  pyDocument("import KBEngine\nv = KBEngine.globalData.get('cfg')\n", 'scripts/Hero.py');

const dictIndexStub = (sites: unknown[]): unknown =>
  ({ ensureStarted: () => Promise.resolve(), query: () => sites });

describe('KBEngineHoverProvider 注入面分支(覆盖率)', () => {
  it('def 方法标注:映射拒绝 → catch 落 null 交回普通链(1045)', async () => {
    const provider = new KBEngineHoverProvider({
      resolveMethodDefinition: () => Promise.reject(new Error('map boom'))
    } as unknown as EntityMappingManager);
    const result = await provider.provideHover(methodDoc(), METHOD_DECL_POS);
    // 注解落空交回普通链(引擎生命周期文档),不外抛即覆盖 catch
    expect(result).not.toBeNull();
    expect((result as { contents: unknown }).contents).toBeDefined();
  });

  it('def 方法标注:declaredArgs 空串 → 只出名不造型(363)', async () => {
    const provider = new KBEngineHoverProvider({
      resolveMethodDefinition: () =>
        Promise.resolve({
          defFile: '/tmp/ws/scripts/entity_defs/Hero.def', line: 8,
          section: 'BaseMethods', declaredArgs: ['']
        })
    } as unknown as EntityMappingManager);
    // 形参闸:[''] 对 (self) 长度相等且 self 无注解 → 放行;签名空类型只出名
    const result = await provider.provideHover(methodDoc(), METHOD_DECL_POS);
    expect(result).not.toBeNull();
  });

  it('接收者调用标注:映射拒绝 → catch 落 null(1118)', async () => {
    const provider = new KBEngineHoverProvider({
      resolveMethodDefinition: () => Promise.reject(new Error('map boom'))
    } as unknown as EntityMappingManager);
    const result = await provider.provideHover(receiverDoc(), RECEIVER_POS);
    expect(result).not.toBeNull();
    expect((result as { contents: unknown }).contents).toBeDefined();
  });

  it('接收者调用标注:形参数不符 → 签名闸拒给标注(1142/1151)', async () => {
    const provider = new KBEngineHoverProvider({
      resolveMethodDefinition: () =>
        Promise.resolve({
          defFile: '/tmp/ws/scripts/entity_defs/Hero.def', line: 9,
          section: 'CellMethods', declaredArgs: ['int', 'str']
        })
    } as unknown as EntityMappingManager);
    // def 声明两形参,调用行无参 → 个数对不上 → 不给标注(交回普通链)
    const result = await provider.provideHover(receiverDoc(), RECEIVER_POS);
    expect(result).not.toBeNull();
    expect((result as { contents: unknown }).contents).toBeDefined();
  });

  it('数据字典键悬停:写点 RHS 推不出类型 → null 交回普通链(1007)', async () => {
    const provider = new KBEngineHoverProvider(undefined, dictIndexStub([
      { kind: 'write', valueText: 'makeThing()', file: '/tmp/ws/scripts/a.py', line: 1 }
    ]) as never);
    const result = await provider.provideHover(DICT_WRITE_DOC(), new Position(1, 21));
    expect(result === null || result === undefined).toBe(true);
  });

  it('数据字典键悬停:读点无同键写点 → null(1010)', async () => {
    const provider = new KBEngineHoverProvider(undefined, dictIndexStub([]) as never);
    const result = await provider.provideHover(DICT_READ_DOC(), new Position(1, 30));
    expect(result === null || result === undefined).toBe(true);
  });

  it('数据字典键悬停:ensureStarted 回程取消 → null(965)', async () => {
    const gate = deferred<void>();
    const provider = new KBEngineHoverProvider(undefined, {
      ensureStarted: () => gate.promise, query: () => []
    } as never);
    const token = { isCancellationRequested: false };
    const pending = provider.provideHover(DICT_WRITE_DOC(), new Position(1, 21), token);
    await flush();
    token.isCancellationRequested = true;
    gate.resolve();
    expect(await pending).toBeNull();
  });

  it('memo 超限驱逐:257 个在途 hover 逐条驱逐最旧(755)', async () => {
    const never = deferred<never>();
    const provider = new KBEngineHoverProvider({
      resolveMethodDefinition: () => never.promise
    } as unknown as EntityMappingManager);
    const lines = ['class H:'];
    const positions: Position[] = [];
    for (let i = 0; i < 260; i += 1) {
      lines.push(`    def m${i}(self):`, '        pass');
      positions.push(new Position(1 + i * 2, 8));
    }
    const doc = pyDocument(`${lines.join('\n')}\n`);
    for (const position of positions) {
      void provider.provideHover(doc, position);
    }
    // 全部在途(映射不落定)→ memo 只保留最近 256 条,最早的被驱逐
    const memo = (provider as unknown as { hoverMemo: Map<string, unknown> }).hoverMemo;
    expect(memo.size).toBeLessThanOrEqual(256);
    never.resolve(null as never);
  });

  it('prewarmKbengineIndex:python 文档触发预热收尾,拒绝不外抛(243)', async () => {
    prewarmKbengineIndex(
      { resolveMethodDefinition: () => Promise.reject(new Error('prewarm boom')) } as never,
      methodDoc()
    );
    await flush();
  });

  it('builtin inlay:无 manager 且无目录面 → 空提示不接管(679)', async () => {
    const provider = new KBEngineBuiltinTypeInlayHintsProvider();
    // scripts/Hero.py 无 base/cell/client 目录段 → pathFace=null → 无 manager 早退
    const doc = pyDocument('class Hero:\n    def f(self):\n        self.cellType = 1\n');
    expect(await provider.provideInlayHints(doc, new Range(new Position(0, 0), new Position(2, 30))))
      .toEqual([]);
  });
});
