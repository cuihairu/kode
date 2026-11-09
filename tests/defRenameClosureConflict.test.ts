import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { KBEngineRenameProvider } from '../src/languageProviders';
import {
  findDefRenameConflictInClosure,
  resolveRenameSymbolAtOffset
} from '../src/backend/defRenamer';
import { makeTextDocument, Position } from './helpers/vscodeStub';

// IDE-AUD-061(R3-F05):改名冲突预检纳入受影响继承闭包——不仅声明文件,
// 祖先/后代同声明面占名也要拒绝并指明冲突文件与行。prove-red:当前实现
// 只查声明文件,后代(Monster 继承 Hero 独有 BaseMethods.vigor)同名时
// 改名照常返回编辑,不抛错。

const HERO_DEF = [
  '<root>',
  '  <BaseMethods>',
  '    <attack> <Arg> UINT8 </Arg> </attack>',
  '  </BaseMethods>',
  '</root>',
  ''
].join('\n');

// 后代:继承 Hero,独有同段方法 vigor(改 Hero.attack→vigor 会撞)
const MONSTER_DEF = [
  '<root>',
  '  <Parent> Hero </Parent>',
  '  <BaseMethods>',
  '    <vigor/>',
  '  </BaseMethods>',
  '</root>',
  ''
].join('\n');

// 祖先:父链占同段方法 vigor(改 Hero.attack→vigor 会撞父链)
const GRAND_DEF = [
  '<root>',
  '  <BaseMethods>',
  '    <vigor/>',
  '  </BaseMethods>',
  '</root>',
  ''
].join('\n');

const HERO_WITH_PARENT_DEF = [
  '<root>',
  '  <Parent> Grand </Parent>',
  '  <BaseMethods>',
  '    <attack> <Arg> UINT8 </Arg> </attack>',
  '  </BaseMethods>',
  '</root>',
  ''
].join('\n');

// 后代但异段同名:改 Hero.attack→vigor 撞 CrossSection 的 ClientMethods.vigor,
// 跨段方法同名是引擎合法形态,不得误拒
const CROSS_SECTION_DEF = [
  '<root>',
  '  <Parent> Hero </Parent>',
  '  <ClientMethods>',
  '    <vigor/>',
  '  </ClientMethods>',
  '</root>',
  ''
].join('\n');

const writeFixtures = (dir: string, files: Record<string, string>): void => {
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(dir, ...relative.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf8');
  }
};

describe('改名冲突预检纳入继承闭包(IDE-AUD-061)', () => {
  it('后代同段方法占名:改 Hero.attack→vigor 拒绝并指明 Monster.vigor 行', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-closure-desc-'));
    writeFixtures(root, {
      'scripts/entities.xml': '<root><Hero/><Monster/></root>\n',
      'scripts/entity_defs/Hero.def': HERO_DEF,
      'scripts/entity_defs/Monster.def': MONSTER_DEF
    });
    const heroPath = path.join(root, 'scripts', 'entity_defs', 'Hero.def');
    const provider = new KBEngineRenameProvider();
    const doc = makeTextDocument(HERO_DEF, { fileName: heroPath }) as never;
    const offset = HERO_DEF.indexOf('<attack>') + 1;
    await expect(
      provider.provideRenameEdits(doc, offsetToPosition(HERO_DEF, offset), 'vigor')
    ).rejects.toThrow(/Monster\.def.*vigor|vigor.*Monster\.def/);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('父链同段方法占名:改 Hero.attack→vigor 也拒绝(不只看后代)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-closure-anc-'));
    writeFixtures(root, {
      'scripts/entities.xml': '<root><Hero/><Grand/></root>\n',
      'scripts/entity_defs/Hero.def': HERO_WITH_PARENT_DEF,
      'scripts/entity_defs/Grand.def': GRAND_DEF
    });
    const heroPath = path.join(root, 'scripts', 'entity_defs', 'Hero.def');
    const provider = new KBEngineRenameProvider();
    const doc = makeTextDocument(HERO_WITH_PARENT_DEF, { fileName: heroPath }) as never;
    const offset = HERO_WITH_PARENT_DEF.indexOf('<attack>') + 1;
    await expect(
      provider.provideRenameEdits(doc, offsetToPosition(HERO_WITH_PARENT_DEF, offset), 'vigor')
    ).rejects.toThrow(/Grand\.def.*vigor|vigor.*Grand\.def/);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('合法跨段同名不误拒:后代 ClientMethods.vigor 不挡 Hero.attack→vigor', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-closure-cross-'));
    writeFixtures(root, {
      'scripts/entities.xml': '<root><Hero/><CrossSection/></root>\n',
      'scripts/entity_defs/Hero.def': HERO_DEF,
      'scripts/entity_defs/CrossSection.def': CROSS_SECTION_DEF
    });
    const heroPath = path.join(root, 'scripts', 'entity_defs', 'Hero.def');
    const provider = new KBEngineRenameProvider();
    const doc = makeTextDocument(HERO_DEF, { fileName: heroPath }) as never;
    const offset = HERO_DEF.indexOf('<attack>') + 1;
    const edits = await provider.provideRenameEdits(doc, offsetToPosition(HERO_DEF, offset), 'vigor');
    expect(edits).not.toBeNull();
    fs.rmSync(root, { recursive: true, force: true });
  });
});

const offsetToPosition = (text: string, offset: number): Position => {
  const before = text.slice(0, offset);
  const line = before.split('\n').length - 1;
  return new Position(line, offset - (before.lastIndexOf('\n') + 1));
};

// 纯函数面:findDefRenameConflictInClosure 的判重矩阵与边界。
// 引擎全局判重(批116 核对):组件槽无条件、方法同段、方法 vs 属性全局、
// 属性 vs 属性/组件域位相交。与 NAV-008 窄面(仅同段方法/属性·组件)不同。
const propertyDef = (name: string, flags: string, parent?: string): string =>
  `<root>\n${parent ? `  <Parent> ${parent} </Parent>\n` : ''}  <Properties>\n    <${name}> <Type> UINT32 </Type> <Flags> ${flags} </Flags> </${name}>\n  </Properties>\n</root>\n`;

const methodDef = (section: string, name: string, parent?: string): string =>
  `<root>\n${parent ? `  <Parent> ${parent} </Parent>\n` : ''}  <${section}>\n    <${name}/>\n  </${section}>\n</root>\n`;

const componentDef = (slot: string, parent?: string): string =>
  `<root>\n${parent ? `  <Parent> ${parent} </Parent>\n` : ''}  <Components>\n    <${slot}> <Type> SomeComp </Type> </${slot}>\n  </Components>\n</root>\n`;

const symbolAt = (text: string, tag: string): ReturnType<typeof resolveRenameSymbolAtOffset> =>
  resolveRenameSymbolAtOffset(text, text.indexOf(`<${tag}`) + 1);

describe('findDefRenameConflictInClosure 判重矩阵与边界', () => {
  it('后代属性同域位同名:改 Hero.hp→vigor 拒绝并指明后代文件+行', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-closure-prop-'));
    writeFixtures(root, {
      'scripts/entities.xml': '<root><Hero/><Monster/></root>\n',
      'scripts/entity_defs/Hero.def': propertyDef('hp', 'ALL_CLIENTS'),
      'scripts/entity_defs/Monster.def': propertyDef('vigor', 'ALL_CLIENTS', 'Hero')
    });
    const heroPath = path.join(root, 'scripts', 'entity_defs', 'Hero.def');
    const heroText = propertyDef('hp', 'ALL_CLIENTS');
    const conflict = findDefRenameConflictInClosure({
      targetFilePath: heroPath,
      targetText: heroText,
      symbol: symbolAt(heroText, 'hp')!,
      newName: 'vigor'
    });
    expect(conflict).not.toBeNull();
    expect(conflict!.filePath).toContain('Monster.def');
    expect(conflict!.surface).toBe('Properties');
    expect(conflict!.line).toBe(4);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('后代属性异域位同名:改 Hero.hp→vigor 撞 BASE 域属性不误拒', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-closure-prop2-'));
    writeFixtures(root, {
      'scripts/entities.xml': '<root><Hero/><Monster/></root>\n',
      'scripts/entity_defs/Hero.def': propertyDef('hp', 'ALL_CLIENTS'),
      'scripts/entity_defs/Monster.def': propertyDef('vigor', 'BASE', 'Hero')
    });
    const heroPath = path.join(root, 'scripts', 'entity_defs', 'Hero.def');
    const heroText = propertyDef('hp', 'ALL_CLIENTS');
    const conflict = findDefRenameConflictInClosure({
      targetFilePath: heroPath,
      targetText: heroText,
      symbol: symbolAt(heroText, 'hp')!,
      newName: 'vigor'
    });
    expect(conflict).toBeNull();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('后代组件槽同名无条件冲突:改 Hero.hp→vigor 撞组件槽也拒', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-closure-comp-'));
    writeFixtures(root, {
      'scripts/entities.xml': '<root><Hero/><Monster/></root>\n',
      'scripts/entity_defs/Hero.def': propertyDef('hp', 'ALL_CLIENTS'),
      'scripts/entity_defs/Monster.def': componentDef('vigor', 'Hero')
    });
    const heroPath = path.join(root, 'scripts', 'entity_defs', 'Hero.def');
    const heroText = propertyDef('hp', 'ALL_CLIENTS');
    const conflict = findDefRenameConflictInClosure({
      targetFilePath: heroPath,
      targetText: heroText,
      symbol: symbolAt(heroText, 'hp')!,
      newName: 'vigor'
    });
    expect(conflict).not.toBeNull();
    expect(conflict!.surface).toBe('Components');
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('方法改名撞后代属性全局拒绝:改 Hero.attack→vigor 撞属性 vigor 也拒', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-closure-mp-'));
    writeFixtures(root, {
      'scripts/entities.xml': '<root><Hero/><Monster/></root>\n',
      'scripts/entity_defs/Hero.def': methodDef('BaseMethods', 'attack'),
      'scripts/entity_defs/Monster.def': propertyDef('vigor', 'ALL_CLIENTS', 'Hero')
    });
    const heroPath = path.join(root, 'scripts', 'entity_defs', 'Hero.def');
    const heroText = methodDef('BaseMethods', 'attack');
    const conflict = findDefRenameConflictInClosure({
      targetFilePath: heroPath,
      targetText: heroText,
      symbol: symbolAt(heroText, 'attack')!,
      newName: 'vigor'
    });
    expect(conflict).not.toBeNull();
    expect(conflict!.surface).toBe('Properties');
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('接口混入闭包:目标实现的接口同名也拒(接口是祖先面)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-closure-iface-'));
    writeFixtures(root, {
      'scripts/entities.xml': '<root><Hero/></root>\n',
      'scripts/entity_defs/Hero.def': `<root>\n  <Interfaces>\n    <Interface>ICombat</Interface>\n  </Interfaces>\n  <BaseMethods>\n    <attack/>\n  </BaseMethods>\n</root>\n`,
      'scripts/entity_defs/interfaces/ICombat.def': methodDef('BaseMethods', 'vigor')
    });
    const heroPath = path.join(root, 'scripts', 'entity_defs', 'Hero.def');
    const heroText = `<root>\n  <Interfaces>\n    <Interface>ICombat</Interface>\n  </Interfaces>\n  <BaseMethods>\n    <attack/>\n  </BaseMethods>\n</root>\n`;
    const conflict = findDefRenameConflictInClosure({
      targetFilePath: heroPath,
      targetText: heroText,
      symbol: symbolAt(heroText, 'attack')!,
      newName: 'vigor'
    });
    expect(conflict).not.toBeNull();
    expect(conflict!.filePath).toContain('ICombat.def');
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('同名非 newName 不误报:后代同名 symbol.name(attack)不挡 attack→vigor', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-closure-same-'));
    writeFixtures(root, {
      'scripts/entities.xml': '<root><Hero/><Monster/></root>\n',
      'scripts/entity_defs/Hero.def': methodDef('BaseMethods', 'attack'),
      'scripts/entity_defs/Monster.def': methodDef('BaseMethods', 'attack', 'Hero')
    });
    const heroPath = path.join(root, 'scripts', 'entity_defs', 'Hero.def');
    const heroText = methodDef('BaseMethods', 'attack');
    const conflict = findDefRenameConflictInClosure({
      targetFilePath: heroPath,
      targetText: heroText,
      symbol: symbolAt(heroText, 'attack')!,
      newName: 'vigor'
    });
    expect(conflict).toBeNull();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('无定义根(无 entities.xml)退化为不报:虚拟路径返回 null', () => {
    const conflict = findDefRenameConflictInClosure({
      targetFilePath: '/tmp/nowhere/scripts/entity_defs/Hero.def',
      targetText: methodDef('BaseMethods', 'attack'),
      symbol: symbolAt(methodDef('BaseMethods', 'attack'), 'attack')!,
      newName: 'vigor'
    });
    expect(conflict).toBeNull();
  });

  it('改名即本名 / 非法名返回 null', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-closure-edge-'));
    writeFixtures(root, {
      'scripts/entities.xml': '<root><Hero/><Monster/></root>\n',
      'scripts/entity_defs/Hero.def': methodDef('BaseMethods', 'attack'),
      'scripts/entity_defs/Monster.def': methodDef('BaseMethods', 'vigor', 'Hero')
    });
    const heroPath = path.join(root, 'scripts', 'entity_defs', 'Hero.def');
    const heroText = methodDef('BaseMethods', 'attack');
    const symbol = symbolAt(heroText, 'attack')!;
    expect(findDefRenameConflictInClosure({
      targetFilePath: heroPath, targetText: heroText, symbol, newName: 'attack'
    })).toBeNull();
    expect(findDefRenameConflictInClosure({
      targetFilePath: heroPath, targetText: heroText, symbol, newName: 'not-valid'
    })).toBeNull();
    fs.rmSync(root, { recursive: true, force: true });
  });
});
