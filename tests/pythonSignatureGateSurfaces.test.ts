import { describe, expect, it } from 'vitest';
import { EntityMappingManager } from '../src/entityMapping';
import { createDefinitionSelection, KBEngineHoverProvider, RpcCodeLensProvider } from '../src/languageProviders';
import { makeTextDocument } from './helpers/vscodeStub';
import type { MinimalTextDocument, Position } from './helpers/vscodeStub';

// 形参闸门推广(用户令:只凭名字就标 RPC/标 KBEngine 函数不严谨):
// 扫描闸门提炼为 EntityMappingManager.pythonSignatureMatchesDeclaredArgs 后,
// RPC CodeLens 面与 Hover 面命中后同过一把闸门——def 声明了 <Arg> 时,被标
// 的 python def 行形参个数必须相等、有注解的按内建映射对上类型;不符则不出
// lens/不给「实体 def 声明」标注;未声明 <Arg> 维持旧行为。三个面各补正反用例,
// manager 以假例注入,不读真实文件。

interface CodeLensLike {
  range: { start: { line: number; character: number } };
}

const pyDoc = (text: string, fileName = '/tmp/ws/scripts/base/Avatar.py'): MinimalTextDocument =>
  makeTextDocument(text, { fileName, languageId: 'python' });

const locationOf = (
  methodName: string,
  declaredArgs?: string[]
): {
  defFile: string;
  line: number;
  section: string;
  exposed: boolean;
  identity: { symbolName: string };
  declaredArgs?: string[];
} => ({
  defFile: '/tmp/ws/scripts/entity_defs/Avatar.def',
  line: 4,
  section: 'BaseMethods',
  exposed: false,
  identity: { symbolName: methodName },
  ...(declaredArgs ? { declaredArgs } : {})
});

const managerOf = (
  locations: Record<string, ReturnType<typeof locationOf>>
): EntityMappingManager =>
  ({
    resolveMethodDefinition: (_file: string, method: string) =>
      Promise.resolve(locations[method] ?? null)
  }) as unknown as EntityMappingManager;

describe('pythonSignatureMatchesDeclaredArgs(公开闸门口)', () => {
  const linesOf = (text: string): string[] => text.split(/\r?\n/);

  it('个数相等且注解按内建映射对上(UINT8→int/STRING→str)→ true', () => {
    expect(
      EntityMappingManager.pythonSignatureMatchesDeclaredArgs(
        ['UINT8', 'STRING'],
        linesOf('def login(self, hp: int, name: str):'),
        0
      )
    ).toBe(true);
  });

  it('形参个数不符 → false', () => {
    expect(
      EntityMappingManager.pythonSignatureMatchesDeclaredArgs(
        ['UINT8'],
        linesOf('def login(self, a, b):'),
        0
      )
    ).toBe(false);
  });

  it('注解类型不符(hp: str vs UINT8)→ false', () => {
    expect(
      EntityMappingManager.pythonSignatureMatchesDeclaredArgs(
        ['UINT8'],
        linesOf('def login(self, hp: str):'),
        0
      )
    ).toBe(false);
  });

  it('个数相等但未注明解 → 只作个数校验,true', () => {
    expect(
      EntityMappingManager.pythonSignatureMatchesDeclaredArgs(
        ['UINT8', 'STRING'],
        linesOf('def login(self, hp, name):'),
        0
      )
    ).toBe(true);
  });

  it('空序列(未声明 <Arg>)恒 true;读不出签名(无括号配平)false', () => {
    expect(EntityMappingManager.pythonSignatureMatchesDeclaredArgs([], linesOf('def x(self):'), 0)).toBe(true);
    expect(
      EntityMappingManager.pythonSignatureMatchesDeclaredArgs(['UINT8'], linesOf('def x(self'), 0)
    ).toBe(false);
  });

  it('多行 def 签名也能对账', () => {
    expect(
      EntityMappingManager.pythonSignatureMatchesDeclaredArgs(
        ['UINT8', 'UINT8'],
        linesOf('def multi(self,\n              a,\n              b):'),
        0
      )
    ).toBe(true);
  });
});

describe('RpcCodeLensProvider 形参闸门(lens 面)', () => {
  const docText = (defLine: string): string =>
    `class Avatar(kbe.KBEntity):\n    ${defLine}\n        return None\n`;

  const lensesFor = async (
    defLine: string,
    declaredArgs?: string[]
  ): Promise<CodeLensLike[]> => {
    const provider = new RpcCodeLensProvider(
      managerOf({ login: locationOf('login', declaredArgs) })
    );
    return (await provider.provideCodeLenses(pyDoc(docText(defLine)))) as unknown as CodeLensLike[];
  };

  it('声明 UINT8:def(self, hp: int) 注解对上 → 出 lens', async () => {
    const lenses = await lensesFor('def login(self, hp: int):', ['UINT8']);
    expect(lenses).toHaveLength(1);
    expect(lenses[0].range.start).toEqual({ line: 1, character: 8 });
  });

  it('声明 UINT8:def(self, a, b) 个数不符 → 不出 lens', async () => {
    expect(await lensesFor('def login(self, a, b):', ['UINT8'])).toEqual([]);
  });

  it('声明 UINT8:def(self, hp: str) 注解类型不符 → 不出 lens', async () => {
    expect(await lensesFor('def login(self, hp: str):', ['UINT8'])).toEqual([]);
  });

  it('声明 UINT8:def(self, hp) 未注明解且个数相等 → 出 lens', async () => {
    expect(await lensesFor('def login(self, hp):', ['UINT8'])).toHaveLength(1);
  });

  it('未声明 <Arg>(declaredArgs 缺省)维持旧行为:不闸,照常出 lens', async () => {
    expect(await lensesFor('def login(self, a, b, c):')).toHaveLength(1);
  });
});

describe('KBEngineHoverProvider 形参闸门(hover 面)', () => {
  const hoverAt = async (
    defLine: string,
    declaredArgs?: string[],
    resolved = true
  ): Promise<unknown> => {
    const document = pyDoc(
      `class Avatar(kbe.KBEntity):\n    ${defLine}\n        return None\n`
    );
    // 光标落在方法名 login 上(行内列 12:`    def login`.indexOf('login') = 12)
    const position = {
      line: 1,
      character: 12
    } as unknown as Position;
    const locations = resolved ? { login: locationOf('login', declaredArgs) } : {};
    const provider = new KBEngineHoverProvider(managerOf(locations));
    return await Promise.resolve(provider.provideHover(document, position));
  };

  const hoverText = (hover: unknown): string => {
    const raw = (hover as { contents: unknown } | null)?.contents ?? [];
    const contents = Array.isArray(raw) ? raw : [raw];
    return contents.map(part => (part as { value?: string }).value ?? String(part)).join('\n');
  };

  it('命中且注解对上 → 给「实体 def 声明的 BaseMethods 方法」标注', async () => {
    const text = hoverText(await hoverAt('def login(self, hp: int):', ['UINT8']));
    expect(text).toContain('login');
    expect(text).toContain('实体 def 声明的 BaseMethods 方法');
    expect(text).toContain('Avatar.def:4');
  });

  it('命中但个数不符 → 不给标注(落回普通 hover 链,此处为 null)', async () => {
    expect(await hoverAt('def login(self, a, b):', ['UINT8'])).toBeNull();
  });

  it('命中但注解类型不符(hp: str)→ 不给标注', async () => {
    expect(await hoverAt('def login(self, hp: str):', ['UINT8'])).toBeNull();
  });

  it('未声明 <Arg> → 旧行为:命中即标注,不作形参对账', async () => {
    const text = hoverText(await hoverAt('def login(self, a, b):'));
    expect(text).toContain('实体 def 声明的 BaseMethods 方法');
  });

  it('def 索引未命中(非 def 声明的同名函数)→ 不给标注', async () => {
    expect(await hoverAt('def login(self, hp: int):', undefined, false)).toBeNull();
  });

  it('Exposed 声明在标注中带可远程调用说明', async () => {
    const document = pyDoc('class Avatar(kbe.KBEntity):\n    def login(self):\n');
    const provider = new KBEngineHoverProvider(
      managerOf({
        login: { ...locationOf('login'), exposed: true }
      })
    );
    const hover = (await Promise.resolve(provider.provideHover(document, {
      line: 1,
      character: 12
    } as unknown as Position))) as { contents: { value: string } } | null;
    expect(hoverText(hover)).toContain('Exposed');
  });
});

describe('createDefinitionSelection 与既有装配不回归', () => {
  it('闸门不改变声明行选区口径', () => {
    expect(createDefinitionSelection(4).start).toEqual({ line: 3, character: 0 });
  });
});
