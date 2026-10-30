import { describe, expect, it } from 'vitest';
import {
  KBEngineCompletionProvider,
  KBEngineHoverProvider,
  KBEngineImplementationProvider,
  KBEngineMethodImplementationCodeActionProvider,
  KBEngineReferencesProvider,
  KBEngineTypeCodeActionProvider,
  UNKNOWN_TYPE_DIAGNOSTIC_CODE
} from '../src/languageProviders';
import type { EntityMappingManager } from '../src/entityMapping';
import { Diagnostic, Position, Range, makeTextDocument } from './helpers/vscodeStub';
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
