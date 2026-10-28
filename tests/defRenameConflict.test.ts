import { describe, expect, it } from 'vitest';
import type * as vscode from 'vscode';
import {
  findDefRenameConflict,
  resolveRenameSymbolAtOffset
} from '../src/defRenamer';
import { KBEngineRenameProvider } from '../src/languageProviders';
import { makeTextDocument, Position } from './helpers/vscodeStub';

// IDE-NAV-008:重命名前检查目标名冲突。验收口径:同段方法或属性/组件
// 冲突时拒绝编辑并说明冲突位置——方法重名只查本段(跨段同名合法,reqPos
// 三段并存是常态);属性与组件同属实体成员命名面,任一占名即冲突;
// 纯函数 findDefRenameConflict 出冲突面+行号,provider 面抛错说明位置。

const DEF_TEXT = [
  '<root>',
  '  <Properties>',
  '    <hp>',
  '      <Type>UINT32</Type>',
  '    </hp>',
  '    <mp3>',
  '      <Type>UINT32</Type>',
  '    </mp3>',
  '  </Properties>',
  '  <Components>',
  '    <Position>',
  '      <Type>VECTOR3</Type>',
  '    </Position>',
  '  </Components>',
  '  <BaseMethods>',
  '    <reqPos>',
  '      <Arg>TIMESTAMP</Arg>',
  '    </reqPos>',
  '    <onTeleport/>',
  '  </BaseMethods>',
  '  <CellMethods>',
  '    <onTeleport/>',
  '  </CellMethods>',
  '</root>'
].join('\n');

/** 光标落在 <reqPos>(0 基第 16 行)名字上 */
const methodSymbol = (): ReturnType<typeof resolveRenameSymbolAtOffset> => {
  const offset = DEF_TEXT.indexOf('<reqPos>') + 1;
  return resolveRenameSymbolAtOffset(DEF_TEXT, offset);
};

/** 光标落在 <hp>(0 基第 2 行)名字上 */
const propertySymbol = (): ReturnType<typeof resolveRenameSymbolAtOffset> => {
  const offset = DEF_TEXT.indexOf('<hp>') + 1;
  return resolveRenameSymbolAtOffset(DEF_TEXT, offset);
};

describe('重命名目标名冲突检查(IDE-NAV-008)', () => {
  it('同段方法冲突:onTeleport 在 BaseMethods 已声明 → 冲突位=段+行', () => {
    const symbol = methodSymbol();
    expect(symbol).not.toBeNull();
    const conflict = findDefRenameConflict(DEF_TEXT, symbol!, 'onTeleport');
    expect(conflict).not.toBeNull();
    expect(conflict!.surface).toBe('BaseMethods');
    expect(conflict!.name).toBe('onTeleport');
    expect(conflict!.line, '1 基行号:<onTeleport/> 在第 19 行').toBe(19);
  });

  it('跨段同名合法:BaseMethods 方法改名撞 CellMethods 独有名 → 不冲突', () => {
    const symbol = methodSymbol();
    const conflict = findDefRenameConflict(DEF_TEXT, symbol!, 'cellOnlyName');
    expect(conflict).toBeNull();
    // 同段重名(第 20 行 BaseMethods.onTeleport)才是冲突;改名撞自己段内他名才算
    expect(findDefRenameConflict(DEF_TEXT, symbol!, 'reqPos')).toBeNull();
  });

  it('属性冲突双面:Properties 占名(mp3)或 Components 占名(Position)都拒', () => {
    const symbol = propertySymbol();
    const propertyConflict = findDefRenameConflict(DEF_TEXT, symbol!, 'mp3');
    expect(propertyConflict).not.toBeNull();
    expect(propertyConflict!.surface).toBe('Properties');
    expect(propertyConflict!.line).toBe(6);

    const componentConflict = findDefRenameConflict(DEF_TEXT, symbol!, 'Position');
    expect(componentConflict).not.toBeNull();
    expect(componentConflict!.surface).toBe('Components');
    expect(componentConflict!.line).toBe(11);

    expect(findDefRenameConflict(DEF_TEXT, symbol!, 'stamina')).toBeNull();
  });

  it('provider 面冲突抛错说明段+行;无冲突改名照常出编辑', async () => {
    const provider = new KBEngineRenameProvider();
    const doc = makeTextDocument(DEF_TEXT, {
      fileName: '/tmp/ws/scripts/entity_defs/Avatar.def'
    }) as never;

    const reqPosOffset = DEF_TEXT.indexOf('<reqPos>') + 1;
    const reqPosPosition = offsetToPosition(reqPosOffset);
    await expect(
      provider.provideRenameEdits(doc, reqPosPosition, 'onTeleport')
    ).rejects.toThrow(/BaseMethods.*19|19.*BaseMethods/);

    const hpOffset = DEF_TEXT.indexOf('<hp>') + 1;
    await expect(
      provider.provideRenameEdits(doc, offsetToPosition(hpOffset), 'Position')
    ).rejects.toThrow(/Components.*11|11.*Components/);

    // 无冲突:改名照常出编辑(既有行为不回归)
    const cleanEdits = await provider.provideRenameEdits(
      doc, reqPosPosition, 'reqPosV2');
    expect(cleanEdits).not.toBeNull();
  });
});

const offsetToPosition = (offset: number): vscode.Position => {
  const before = DEF_TEXT.slice(0, offset);
  const line = before.split('\n').length - 1;
  return new Position(line, offset - (before.lastIndexOf('\n') + 1));
};
