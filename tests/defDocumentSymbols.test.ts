import { describe, expect, it } from 'vitest';
import type * as vscode from 'vscode';
import { KBEngineDocumentSymbolProvider } from '../src/languageProviders';
import { makeTextDocument, SymbolKind } from './helpers/vscodeStub';

// IDE-NAV-005:def 文档符号(Outline)。验收口径:按 Properties/三方法段
// 展示声明与精确范围——段作容器(Properties=Struct,方法段=Class),段内
// 声明作子符号(属性=Field,方法=Method);range=元素全跨度(开标签到闭
// 标签,selfClosing 到开标签尾),selectionRange=名字所在开标签跨度,且
// selectionRange ⊆ range;非 def 文档 null。
// PROC-BREADCRUMB-001(2026-11-18):方法段在场时头部插合成根节点
// 「实体名 · 进程段全列」(Namespace,锚定段=文档序首段带▸排首位),
// 原段容器收编为其 children 尾部;children 前缀=非锚定进程段(Event,
// 锚点=本文件对应 def 区块,detail 携对端 py 路径提示)。Outline 与
// 面包屑同源此 provider(钉子4:两处一致出现)。

const DEF_TEXT = [
  '<root>',
  '  <Properties>',
  '    <hp>',
  '      <Type>UINT32</Type>',
  '    </hp>',
  '    <mana/>',
  '  </Properties>',
  '  <BaseMethods>',
  '    <reqPos>',
  '      <Arg>TIMESTAMP</Arg>',
  '    </reqPos>',
  '  </BaseMethods>',
  '  <CellMethods>',
  '    <reqPos>',
  '      <Arg>INT32</Arg>',
  '    </reqPos>',
  '  </CellMethods>',
  '</root>'
].join('\n');

const defDoc = (): vscode.TextDocument =>
  makeTextDocument(DEF_TEXT, { fileName: '/tmp/ws/scripts/entity_defs/Avatar.def' }) as never;

/** 测试侧独立换算:offset → 位置(不经被测 document.positionAt) */
const pos = (offset: number): { line: number; character: number } => {
  const before = DEF_TEXT.slice(0, offset);
  const line = before.split('\n').length - 1;
  const character = offset - (before.lastIndexOf('\n') + 1);
  return { line, character };
};

/** 段容器视图:合成根在场时(PROC-BREADCRUMB-001)取根 children 里的
 * 段容器(滤掉进程段 Event 子节点),否则原样——容器面断言对两种形态同口径 */
const sectionSymbols = (
  symbols: vscode.DocumentSymbol[]
): vscode.DocumentSymbol[] => {
  const [head] = symbols;
  return head !== undefined && head.kind === SymbolKind.Namespace
    ? head.children.filter(child => child.kind !== SymbolKind.Event)
    : symbols;
};

describe('def 文档符号 Outline(IDE-NAV-005)', () => {
  it('按 Properties/三方法段出容器符号,段序=文档序,只出在场段', async () => {
    const provider = new KBEngineDocumentSymbolProvider();
    const symbols = await provider.provideDocumentSymbols(defDoc(), undefined);
    expect(symbols).not.toBeNull();
    const sections = sectionSymbols(symbols!);
    expect(sections.map(symbol => symbol.name)).toEqual(['Properties', 'BaseMethods', 'CellMethods']);
    // ClientMethods 未声明不出(Volatile/Parent 等非符号段同理不进 Outline)
    expect(sections.some(symbol => symbol.name === 'ClientMethods')).toBe(false);
    expect(sections.map(symbol => symbol.kind)).toEqual([SymbolKind.Struct, SymbolKind.Class, SymbolKind.Class]);
  });

  it('段容器范围=元素全跨度,子声明=属性 Field/方法 Method 且 selectionRange ⊆ range', async () => {
    const provider = new KBEngineDocumentSymbolProvider();
    const symbols = await provider.provideDocumentSymbols(defDoc(), undefined);

    const [properties, baseMethods, cellMethods] = sectionSymbols(symbols!);
    const propertiesOpen = DEF_TEXT.indexOf('<Properties>');
    const propertiesClose = DEF_TEXT.indexOf('</Properties>') + '</Properties>'.length;
    expect(properties.range.start).toEqual(pos(propertiesOpen));
    expect(properties.range.end).toEqual(pos(propertiesClose));
    expect(properties.selectionRange.start).toEqual(pos(propertiesOpen));

    // 属性子符号:hp(带闭标签,range 到 </hp> 尾)+mana(selfClosing,range==开标签跨度)
    expect(properties.children.map(child => child.name)).toEqual(['hp', 'mana']);
    expect(properties.children.map(child => child.kind)).toEqual([SymbolKind.Field, SymbolKind.Field]);
    const hpOpen = DEF_TEXT.indexOf('<hp>');
    const hpClose = DEF_TEXT.indexOf('</hp>') + '</hp>'.length;
    expect(properties.children[0].range.start).toEqual(pos(hpOpen));
    expect(properties.children[0].range.end).toEqual(pos(hpClose));
    expect(properties.children[0].selectionRange.end).toEqual(pos(hpOpen + '<hp>'.length));
    const manaOpen = DEF_TEXT.indexOf('<mana/>');
    expect(properties.children[1].range.start).toEqual(pos(manaOpen));
    expect(properties.children[1].range.end).toEqual(pos(manaOpen + '<mana/>'.length));

    // 方法子符号:两段同名 reqPos 各归本段容器,range 覆盖含 Arg 的全跨度
    expect(baseMethods.children.map(child => child.name)).toEqual(['reqPos']);
    expect(baseMethods.children[0].kind).toBe(SymbolKind.Method);
    expect(cellMethods.children.map(child => child.name)).toEqual(['reqPos']);
    const baseReqOpen = DEF_TEXT.indexOf('<reqPos>');
    const baseReqClose = DEF_TEXT.indexOf('</reqPos>') + '</reqPos>'.length;
    expect(baseMethods.children[0].range.start).toEqual(pos(baseReqOpen));
    expect(baseMethods.children[0].range.end).toEqual(pos(baseReqClose));
    expect(baseMethods.children[0].selectionRange.start).toEqual(pos(baseReqOpen));
    expect(baseMethods.children[0].selectionRange.end).toEqual(pos(baseReqOpen + '<reqPos>'.length));

    for (const symbol of [...symbols!, ...symbols!.flatMap(parent => parent.children)]) {
      const range = symbol.range;
      const selection = symbol.selectionRange;
      const startsAfter = selection.start.line > range.start.line
        || (selection.start.line === range.start.line && selection.start.character >= range.start.character);
      const endsBefore = selection.end.line < range.end.line
        || (selection.end.line === range.end.line && selection.end.character <= range.end.character);
      expect(`${symbol.name} selectionRange ⊆ range`).toEqual(
        `${symbol.name} selectionRange ⊆ range${startsAfter && endsBefore ? '' : '(violation)'}`);
    }
  });

  it('空段照出(声明在位即有容器,子为零);非 def 文档 null', async () => {
    const provider = new KBEngineDocumentSymbolProvider();
    const emptySections = makeTextDocument(
      '<root>\n  <ClientMethods>\n  </ClientMethods>\n</root>\n',
      { fileName: '/tmp/ws/scripts/entity_defs/Ghost.def' }
    ) as never;
    const symbols = await provider.provideDocumentSymbols(emptySections, undefined);
    expect(symbols).toHaveLength(1);
    // 单方法段:合成根 Solo 口径(Ghost · client),段容器=根 children 里唯一段
    expect(symbols![0].name).toBe('Ghost · client');
    const sections = sectionSymbols(symbols!);
    expect(sections).toHaveLength(1);
    expect(sections[0].name).toBe('ClientMethods');
    expect(sections[0].children).toEqual([]);

    const pyDoc = makeTextDocument('class Avatar:\n    pass\n', {
      fileName: '/tmp/ws/scripts/base/Avatar.py', languageId: 'python'
    });
    expect(await provider.provideDocumentSymbols(pyDoc as never, undefined)).toBeNull();
  });
});

describe('def 面包屑合成根(PROC-BREADCRUMB-001,钉子1/2/3/4)', () => {
  it('钉子2:双进程 def → 根=实体·全列(锚定段▸排首位),段容器收编 children 尾部', async () => {
    const provider = new KBEngineDocumentSymbolProvider();
    const symbols = await provider.provideDocumentSymbols(defDoc(), undefined);
    expect(symbols).toHaveLength(1);
    const [root] = symbols!;
    // Avatar.def 声明 Base+Cell:全列=baseapp▸·cellapp(文档序首段锚定)
    expect(root.name).toBe('Avatar · baseapp▸·cellapp');
    expect(root.kind).toBe(SymbolKind.Namespace);
    // 根 range=全文档,selectionRange=文件头
    expect(root.range.start).toEqual({ line: 0, character: 0 });
    expect(root.selectionRange.start).toEqual({ line: 0, character: 0 });
    // children 前缀=非锚定进程段(Event,锚点=本文件 CellMethods 区块),
    // 尾部=原段容器(Outline/面包屑同源一致出现=钉子4)
    expect(root.children.map(child => child.name)).toEqual([
      'cellapp', 'Properties', 'BaseMethods', 'CellMethods'
    ]);
    expect(root.children[0].kind).toBe(SymbolKind.Event);
    const cellChild = root.children[0];
    const cellOpen = DEF_TEXT.indexOf('<CellMethods>');
    const cellClose = DEF_TEXT.indexOf('</CellMethods>') + '</CellMethods>'.length;
    expect(cellChild.range.start.line).toBe(pos(cellOpen).line);
    expect(cellChild.range.end.line).toBe(pos(cellClose).line);
    // 对端 py 不存在(tests 环境 /tmp 无该文件):detail 如实「未找到」
    expect(cellChild.detail).toContain('CellMethods');
    expect(cellChild.detail).toContain('未找到同名 py 文件');
    expect(cellChild.detail).toContain('ctrl+alt+shift');
    // 段容器仍是原符号(Struct/Class/子声明面不变)
    expect(root.children[1].name).toBe('Properties');
    expect(root.children[2].children.map(child => child.name)).toEqual(['reqPos']);
  });

  it('钉子1:单进程 def → 根=实体·单段(无▸),无进程 children;原段容器照出', async () => {
    const provider = new KBEngineDocumentSymbolProvider();
    const symbols = await provider.provideDocumentSymbols(
      makeTextDocument(
        '<root>\n  <Properties/>\n  <CellMethods>\n    <tick/>\n  </CellMethods>\n</root>\n',
        { fileName: '/tmp/ws/scripts/entity_defs/Solo.def' }
      ) as never,
      undefined
    );
    expect(symbols).toHaveLength(1);
    const [root] = symbols!;
    expect(root.name).toBe('Solo · cellapp');
    expect(root.kind).toBe(SymbolKind.Namespace);
    expect(root.children.map(child => child.name)).toEqual(['Properties', 'CellMethods']);
    expect(root.children.some(child => child.kind === SymbolKind.Event)).toBe(false);
  });

  it('钉子3:无方法段(仅 Properties) → 不插根,面包屑/Outline 照旧', async () => {
    const provider = new KBEngineDocumentSymbolProvider();
    const symbols = await provider.provideDocumentSymbols(
      makeTextDocument('<root>\n  <Properties/>\n</root>\n', {
        fileName: '/tmp/ws/scripts/entity_defs/Props.def'
      }) as never,
      undefined
    );
    expect(symbols!.map(symbol => symbol.name)).toEqual(['Properties']);
    expect(symbols![0].kind).toBe(SymbolKind.Struct);
  });
});
