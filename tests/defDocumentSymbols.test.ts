import { describe, expect, it } from 'vitest';
import type * as vscode from 'vscode';
import { KBEngineDocumentSymbolProvider } from '../src/languageProviders';
import { makeTextDocument, SymbolKind } from './helpers/vscodeStub';

// IDE-NAV-005:def 文档符号(Outline)。验收口径:按 Properties/三方法段
// 展示声明与精确范围——段作容器(Properties=Struct,方法段=Class),段内
// 声明作子符号(属性=Field,方法=Method);range=元素全跨度(开标签到闭
// 标签,selfClosing 到开标签尾),selectionRange=名字所在开标签跨度,且
// selectionRange ⊆ range;非 def 文档 null。

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

describe('def 文档符号 Outline(IDE-NAV-005)', () => {
  it('按 Properties/三方法段出容器符号,段序=文档序,只出在场段', async () => {
    const provider = new KBEngineDocumentSymbolProvider();
    const symbols = await provider.provideDocumentSymbols(defDoc(), undefined);
    expect(symbols).not.toBeNull();
    expect(symbols!.map(symbol => symbol.name)).toEqual(['Properties', 'BaseMethods', 'CellMethods']);
    // ClientMethods 未声明不出(Volatile/Parent 等非符号段同理不进 Outline)
    expect(symbols!.some(symbol => symbol.name === 'ClientMethods')).toBe(false);
    expect(symbols!.map(symbol => symbol.kind)).toEqual([SymbolKind.Struct, SymbolKind.Class, SymbolKind.Class]);
  });

  it('段容器范围=元素全跨度,子声明=属性 Field/方法 Method 且 selectionRange ⊆ range', async () => {
    const provider = new KBEngineDocumentSymbolProvider();
    const symbols = await provider.provideDocumentSymbols(defDoc(), undefined);

    const [properties, baseMethods, cellMethods] = symbols!;
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
    expect(symbols![0].name).toBe('ClientMethods');
    expect(symbols![0].children).toEqual([]);

    const pyDoc = makeTextDocument('class Avatar:\n    pass\n', {
      fileName: '/tmp/ws/scripts/base/Avatar.py', languageId: 'python'
    });
    expect(await provider.provideDocumentSymbols(pyDoc as never, undefined)).toBeNull();
  });
});
