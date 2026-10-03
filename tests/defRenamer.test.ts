import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEF_IDENTIFIER_PATTERN,
  DefRenameFileEdits,
  DefRenameSymbol,
  collectRenameEditsInText,
  computeDefRenameEdits,
  findEntityDefsRootFromFile,
  getLineCharacterAtOffset,
  resolveRenameSymbolAtOffset
} from '../src/defRenamer';
import { KBEngineRenameProvider } from '../src/languageProviders';
import {
  Position,
  TextEdit,
  WorkspaceEdit,
  makeTextDocument
} from './helpers/vscodeStub';
import type { MinimalTextDocument } from './helpers/vscodeStub';

// defRenamer 的纯逻辑与 KBEngineRenameProvider 装配:.def 属性/方法重命名的
// 符号解析(光标须落在符号名上)、引用编辑计算(同文件 + 后代 def 复述)与
// 边界(方法段命名空间、无实体根退化、非法新名拒绝)。传播边对齐引擎装载
// 语义(批96 核对):Parent 取文本或首子元素名、按 owner 类别路径精确解析,
// Interfaces 只认 wrapper 四拼写、直取形态不跟随,接口文件不读 Parent。
// 真实临时文件树。

const HERO_DEF = [
  '<root>',
  '  <Properties>',
  '    <hp> <Type> UINT32 </Type> <Flags> ALL_CLIENTS </Flags> </hp>',
  '    <hp> <Type> UINT8 </Type> </hp>',
  '    <mp> <Type> UINT32 </Type> </mp>',
  '  </Properties>',
  '  <BaseMethods>',
  '    <move> <Arg> UINT8 </Arg> </move>',
  '  </BaseMethods>',
  '  <CellMethods>',
  '    <move/>',
  '  </CellMethods>',
  '</root>',
  ''
].join('\n');

const MONSTER_DEF = [
  '<root>',
  '  <Parent> Hero </Parent>',
  '  <Properties>',
  '    <hp> <Type> UINT16 </Type> </hp>',
  '  </Properties>',
  '  <BaseMethods>',
  '    <move/>',
  '  </BaseMethods>',
  '  <CellMethods>',
  '    <move/>',
  '  </CellMethods>',
  '</root>',
  ''
].join('\n');

const BOSS_DEF = [
  '<root>',
  '  <Parent> Monster </Parent>',
  '  <Properties>',
  '    <hp> <Type> UINT32 </Type> </hp>',
  '  </Properties>',
  '</root>',
  ''
].join('\n');

const BEAST_DEF = [
  '<root>',
  '  <Interfaces>',
  '    <Ghost/>',
  '  </Interfaces>',
  '  <Properties>',
  '    <hp> <Type> FLOAT </Type> </hp>',
  '  </Properties>',
  '</root>',
  ''
].join('\n');

// Parent Hero 但不复述 hp:后代里"无该符号"的分支
const HEIR_DEF = [
  '<root>',
  '  <Parent> Hero </Parent>',
  '  <Properties>',
  '    <gold> <Type> UINT32 </Type> </gold>',
  '  </Properties>',
  '</root>',
  ''
].join('\n');

// 悬空 Parent/Interfaces 引用:闭包跟随时目标不存在
const DANGLING_DEF = [
  '<root>',
  '  <Parent> Nobody </Parent>',
  '  <Interfaces>',
  '    <Ghost/>',
  '  </Interfaces>',
  '</root>',
  ''
].join('\n');

// 坏 XML 的后代:语义面为空,整体跳过
const BROKEN_DEF = [
  '<root>',
  '  <Parent> Monster </Parent>',
  '  <Properties>',
  '    <hp> <Type> UINT32 </Type>',
  ''
].join('\n');

const COMPONENT_DEF = [
  '<root>',
  '  <Properties>',
  '    <hp> <Type> UINT32 </Type> </hp>',
  '  </Properties>',
  '</root>',
  ''
].join('\n');

const IBASE_DEF = [
  '<root>',
  '  <Properties>',
  '    <drift> <Type> FLOAT </Type> </drift>',
  '  </Properties>',
  '</root>',
  ''
].join('\n');

const MOVE_IFACE_DEF = [
  '<root>',
  '  <Interfaces>',
  '    <Interface><IBase/></Interface>',
  '  </Interfaces>',
  '  <Properties>',
  '    <drift> <Type> FLOAT </Type> </drift>',
  '  </Properties>',
  '</root>',
  ''
].join('\n');

// Avatar 用 wrapper 文本形态(<Interface>MoveIface</Interface>)——引擎 getKey
// 对 wrapper 取"文本优先,空则首子元素名"(xml.cpp),两种写法都装载
const AVATAR_DEF = [
  '<root>',
  '  <Interfaces>',
  '    <Interface>MoveIface</Interface>',
  '  </Interfaces>',
  '  <Properties>',
  '    <drift> <Type> FLOAT </Type> </drift>',
  '    <own> <Type> UINT8 </Type> </own>',
  '  </Properties>',
  '</root>',
  ''
].join('\n');

// Interfaces 的 <Interface><X/></Interface> 包裹形态(元素名取法)
const GOLEM_DEF = [
  '<root>',
  '  <Interfaces>',
  '    <Interface><IBase/></Interface>',
  '  </Interfaces>',
  '  <Properties>',
  '    <drift> <Type> FLOAT </Type> </drift>',
  '  </Properties>',
  '</root>',
  ''
].join('\n');

// 引擎在 <Interfaces> 下还认 interface/type/Type 三种 wrapper 拼写
// (entitydef.cpp:563-566,大小写敏感);各配一个实体锁定
const LOWER_IFACE_DEF = [
  '<root>',
  '  <Interfaces>',
  '    <interface><IBase/></interface>',
  '  </Interfaces>',
  '  <Properties>',
  '    <drift> <Type> FLOAT </Type> </drift>',
  '  </Properties>',
  '</root>',
  ''
].join('\n');

const TYPE_WRAPPER_DEF = [
  '<root>',
  '  <Interfaces>',
  '    <Type>IBase</Type>',
  '  </Interfaces>',
  '  <Properties>',
  '    <drift> <Type> FLOAT </Type> </drift>',
  '  </Properties>',
  '</root>',
  ''
].join('\n');

const LOWER_TYPE_DEF = [
  '<root>',
  '  <Interfaces>',
  '    <type>IBase</type>',
  '  </Interfaces>',
  '  <Properties>',
  '    <drift> <Type> FLOAT </Type> </drift>',
  '  </Properties>',
  '</root>',
  ''
].join('\n');

// 以接口名直接命名的 <Interfaces> 子元素:引擎装载时跳过(entitydef.cpp
// 对非 wrapper 子元素 continue),不产生传播边——负向锁
const DIRECT_IFACE_DEF = [
  '<root>',
  '  <Interfaces>',
  '    <IBase/>',
  '  </Interfaces>',
  '  <Properties>',
  '    <drift> <Type> FLOAT </Type> </drift>',
  '  </Properties>',
  '</root>',
  ''
].join('\n');

// Parent 的元素形态 <Parent><Hero/></Parent>:引擎 loadParentClass 对
// `<Parent>` 的**首个子节点**做 getKey(文本取文本、元素取标签名)——正锁
const PARENT_ELEMENT_DEF = [
  '<root>',
  '  <Parent><Hero/></Parent>',
  '  <Properties>',
  '    <hp> <Type> UINT16 </Type> </hp>',
  '  </Properties>',
  '</root>',
  ''
].join('\n');

// 混合内容:<Parent> 与 <Hero/> 之间换行缩进 → 首子节点是空白文本,引擎
// getKey 得空名、拼不出父类文件(装载失败),不产生边——负向锁
const MIXED_PARENT_DEF = [
  '<root>',
  '  <Parent>',
  '    <Hero/>',
  '  </Parent>',
  '  <Properties>',
  '    <hp> <Type> UINT16 </Type> </hp>',
  '  </Properties>',
  '</root>',
  ''
].join('\n');

// 接口文件里的 <Parent>:引擎 loadInterfaces 不走 loadParentClass
// (entitydef.cpp L551-640 只递归描述/DetailLevel/接口),声明不可见——负向锁
const IFACE_PARENTED_DEF = [
  '<root>',
  '  <Parent> Hero </Parent>',
  '  <Properties>',
  '    <hp> <Type> UINT16 </Type> </hp>',
  '  </Properties>',
  '</root>',
  ''
].join('\n');

// 组件 def 的 Parent 在 components/ 内解析(entitydef.cpp loadComponents
// L774:loadParentClass(defFilePath + "components/", ...))
const BASE_GUN_DEF = [
  '<root>',
  '  <Properties>',
  '    <power> <Type> UINT32 </Type> </power>',
  '  </Properties>',
  '</root>',
  ''
].join('\n');

const CHILD_GUN_DEF = [
  '<root>',
  '  <Parent> BaseGun </Parent>',
  '  <Properties>',
  '    <power> <Type> UINT32 </Type> </power>',
  '  </Properties>',
  '</root>',
  ''
].join('\n');

// 组件 Parent 只在 components/ 找:components/Hero.def 不存在时,即使定义根
// 有同名实体 Hero.def 也不产生边(引擎同样装载不到父类)——负向锁
const WAND_DEF = [
  '<root>',
  '  <Parent> Hero </Parent>',
  '  <Properties>',
  '    <hp> <Type> UINT16 </Type> </hp>',
  '  </Properties>',
  '</root>',
  ''
].join('\n');

const occurrences = (text: string, needle: string): number[] => {
  const found: number[] = [];
  let index = text.indexOf(needle);
  while (index !== -1) {
    found.push(index);
    index = text.indexOf(needle, index + 1);
  }
  return found;
};

/** 光标放在第 n 个 needle 的名字内(needle 形如 '<hp>'/'</hp>',名字起点按标签形态偏移) */
const cursorAt = (text: string, needle: string, occurrence = 0): number => {
  const offsets = occurrences(text, needle);
  expect(offsets.length).toBeGreaterThan(occurrence);
  return offsets[occurrence] + (needle.startsWith('</') ? 2 : 1) + 1;
};

const applyEdits = (text: string, edits: Array<{ start: number; end: number }>, newName: string): string => {
  let result = text;
  let delta = 0;
  for (const edit of [...edits].sort((left, right) => left.start - right.start)) {
    result = result.slice(0, edit.start + delta) + newName + result.slice(edit.end + delta);
    delta += newName.length - (edit.end - edit.start);
  }
  return result;
};

const editsByFile = (results: DefRenameFileEdits[]): Record<string, number> =>
  Object.fromEntries(results.map(entry => [path.basename(entry.filePath), entry.edits.length]));

let root: string;
let noRootDir: string;
let innerXmlDir: string;
let heroPath: string;
let monsterPath: string;
let bossPath: string;
let beastPath: string;
let ibasePath: string;
let moveIfacePath: string;
let avatarPath: string;
let golemPath: string;
let lowerIfacePath: string;
let typeWrapperPath: string;
let lowerTypePath: string;
let directIfacePath: string;
let parentElementPath: string;
let mixedParentPath: string;
let ifaceParentedPath: string;
let baseGunPath: string;
let childGunPath: string;
let wandPath: string;
let heirPath: string;
let danglingPath: string;
let brokenPath: string;
let componentPath: string;
let lockedDir: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-renamer-'));
  const write = (relative: string, content: string): string => {
    const target = path.join(root, ...relative.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf8');
    return target;
  };

  write('scripts/entities.xml', [
    '<root>',
    '  <Avatar> <hasClient/> </Avatar>',
    '</root>',
    ''
  ].join('\n'));
  heroPath = write('scripts/entity_defs/Hero.def', HERO_DEF);
  monsterPath = write('scripts/entity_defs/Monster.def', MONSTER_DEF);
  bossPath = write('scripts/entity_defs/Boss.def', BOSS_DEF);
  beastPath = write('scripts/entity_defs/Beast.def', BEAST_DEF);
  ibasePath = write('scripts/entity_defs/interfaces/IBase.def', IBASE_DEF);
  moveIfacePath = write('scripts/entity_defs/interfaces/MoveIface.def', MOVE_IFACE_DEF);
  avatarPath = write('scripts/entity_defs/Avatar.def', AVATAR_DEF);
  golemPath = write('scripts/entity_defs/Golem.def', GOLEM_DEF);
  lowerIfacePath = write('scripts/entity_defs/LowerIface.def', LOWER_IFACE_DEF);
  typeWrapperPath = write('scripts/entity_defs/TypeWrap.def', TYPE_WRAPPER_DEF);
  lowerTypePath = write('scripts/entity_defs/LowerType.def', LOWER_TYPE_DEF);
  directIfacePath = write('scripts/entity_defs/DirectIface.def', DIRECT_IFACE_DEF);
  parentElementPath = write('scripts/entity_defs/ParentElem.def', PARENT_ELEMENT_DEF);
  mixedParentPath = write('scripts/entity_defs/MixedParent.def', MIXED_PARENT_DEF);
  ifaceParentedPath = write('scripts/entity_defs/interfaces/Parented.def', IFACE_PARENTED_DEF);
  baseGunPath = write('scripts/entity_defs/components/BaseGun.def', BASE_GUN_DEF);
  childGunPath = write('scripts/entity_defs/components/ChildGun.def', CHILD_GUN_DEF);
  wandPath = write('scripts/entity_defs/components/Wand.def', WAND_DEF);
  heirPath = write('scripts/entity_defs/Heir.def', HEIR_DEF);
  danglingPath = write('scripts/entity_defs/Dangling.def', DANGLING_DEF);
  brokenPath = write('scripts/entity_defs/Broken.def', BROKEN_DEF);
  componentPath = write('scripts/entity_defs/components/HealthComp.def', COMPONENT_DEF);
  lockedDir = path.join(root, 'scripts', 'entity_defs', 'locked');
  fs.mkdirSync(lockedDir, { recursive: true });
  fs.writeFileSync(path.join(lockedDir, 'Locked.def'), HEIR_DEF, 'utf8');

  // 无 entities.xml 的孤树:向上找不到定义根,退化为仅同文件
  noRootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-renamer-noroot-'));
  fs.writeFileSync(path.join(noRootDir, 'Lone.def'), HERO_DEF, 'utf8');

  // entities.xml 直接位于 entity_defs 内的非常规布局
  innerXmlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-renamer-innerxml-'));
  fs.mkdirSync(path.join(innerXmlDir, 'entity_defs'), { recursive: true });
  fs.writeFileSync(path.join(innerXmlDir, 'entity_defs', 'entities.xml'), '<root/>\n', 'utf8');
  fs.writeFileSync(path.join(innerXmlDir, 'entity_defs', 'Inner.def'), HERO_DEF, 'utf8');
});

afterAll(() => {
  for (const dir of [root, noRootDir, innerXmlDir]) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('resolveRenameSymbolAtOffset 符号解析', () => {
  it('开标签上的属性名解析为 property 符号', () => {
    const offset = cursorAt(HERO_DEF, '<hp>');
    const symbol = resolveRenameSymbolAtOffset(HERO_DEF, offset);
    expect(symbol).toEqual({
      kind: 'property',
      name: 'hp',
      section: null,
      wordStart: offset - 1,
      wordEnd: offset + 1
    });
  });

  it('闭标签上的属性名也可发起重命名,词区间指向闭标签名字', () => {
    const closeOffset = cursorAt(HERO_DEF, '</hp>', 1);
    const symbol = resolveRenameSymbolAtOffset(HERO_DEF, closeOffset);
    expect(symbol?.kind).toBe('property');
    expect(symbol?.name).toBe('hp');
    expect(HERO_DEF.slice(symbol!.wordStart, symbol!.wordEnd)).toBe('hp');
    expect(symbol!.wordStart).toBe(occurrences(HERO_DEF, '</hp>')[1] + 2);
  });

  // 批84 变异抽检收口(M2):标识符字符类必须含下划线。既有 fixture 只有 hp/mp/
  // move 这类无下划线短名,isIdentifierChar 去掉 '_' 后词区间会在下划线处截断成
  // 'hp',与元素名 'max_hp' 不等 → 解析直接返回 null,蛇形符号的重命名功能整体
  // 失效,而定向面/全量/编译/mocha 四层皆不可见。本例把光标放在下划线**之后**,
  // 强制词区间跨越 '_',并锁定整名编辑与词尾退化位。
  it('snake_case 符号名整体成一个词,光标落在下划线之后同样命中', () => {
    const snakeDef = [
      '<root>',
      '  <Properties>',
      '    <max_hp> <Type> UINT32 </Type> </max_hp>',
      '  </Properties>',
      '</root>',
      ''
    ].join('\n');
    const openTag = snakeDef.indexOf('<max_hp>');

    const symbol = resolveRenameSymbolAtOffset(snakeDef, openTag + 1 + 'max_'.length);

    expect(symbol).toEqual({
      kind: 'property',
      name: 'max_hp',
      section: null,
      wordStart: openTag + 1,
      wordEnd: openTag + 1 + 'max_hp'.length
    });
    expect(snakeDef.slice(symbol!.wordStart, symbol!.wordEnd)).toBe('max_hp');

    // 词区间覆盖整名 ⇒ 开/闭两处编辑都按整名切出
    const edits = collectRenameEditsInText(snakeDef, symbol!);
    expect(edits.map(edit => snakeDef.slice(edit.start, edit.end))).toEqual(['max_hp', 'max_hp']);

    // 词尾右侧一格(紧贴 '>')仍算命中该词
    expect(
      resolveRenameSymbolAtOffset(snakeDef, openTag + 1 + 'max_hp'.length)?.name
    ).toBe('max_hp');
  });

  it('方法名解析为 method 符号并携带所属段', () => {
    const symbol = resolveRenameSymbolAtOffset(HERO_DEF, cursorAt(HERO_DEF, '<move>'));
    expect(symbol?.kind).toBe('method');
    expect(symbol?.name).toBe('move');
    expect(symbol?.section).toBe('BaseMethods');
  });

  it('词尾右侧一格仍算命中该词', () => {
    const openStart = occurrences(HERO_DEF, '<mp>')[0] + 1;
    const symbol = resolveRenameSymbolAtOffset(HERO_DEF, openStart + 2);
    expect(symbol?.name).toBe('mp');
  });

  it('类型值、Flags 标签、Parent 值与空白处都不是可重命名符号', () => {
    const typeValue = HERO_DEF.indexOf('UINT32') + 1;
    expect(resolveRenameSymbolAtOffset(HERO_DEF, typeValue)).toBeNull();
    const flagsTag = HERO_DEF.indexOf('<Flags>') + 3;
    expect(resolveRenameSymbolAtOffset(HERO_DEF, flagsTag)).toBeNull();
    const parentValue = MONSTER_DEF.indexOf('Hero') + 1;
    expect(resolveRenameSymbolAtOffset(MONSTER_DEF, parentValue)).toBeNull();
    const blank = HERO_DEF.indexOf('  <Properties>');
    expect(resolveRenameSymbolAtOffset(HERO_DEF, blank)).toBeNull();
  });

  it('坏 XML 文本返回 null', () => {
    expect(resolveRenameSymbolAtOffset('<root><hp>', 10)).toBeNull();
    expect(resolveRenameSymbolAtOffset('', 0)).toBeNull();
  });

  it('越界光标返回 null,自闭合标签名可解析', () => {
    const selfCloseText = '<root><Properties><mp /></Properties></root>';
    expect(resolveRenameSymbolAtOffset(selfCloseText, -1)).toBeNull();
    expect(resolveRenameSymbolAtOffset(selfCloseText, selfCloseText.length)).toBeNull();
    const mpOffset = selfCloseText.indexOf('<mp ');
    expect(resolveRenameSymbolAtOffset(selfCloseText, mpOffset + 2)?.name).toBe('mp');
    const openText = '<root>\n  <Properties>\n    <hp/>\n  </Properties>\n</root>\n';
    expect(resolveRenameSymbolAtOffset(openText, openText.indexOf('hp') + 2)?.name).toBe('hp');
  });

  it('无根元素(非 def 文本)返回 null/空编辑', () => {
    const text = 'just some words here';
    expect(resolveRenameSymbolAtOffset(text, 1)).toBeNull();
    const symbol = { kind: 'property', name: 'hp', section: null } as DefRenameSymbol;
    expect(collectRenameEditsInText(text, symbol)).toHaveLength(0);
  });
});

describe('findEntityDefsRootFromFile 定义根定位', () => {
  it('常规布局:entities.xml 在 entity_defs 父目录', () => {
    const defsRoot = path.join(root, 'scripts', 'entity_defs');
    expect(findEntityDefsRootFromFile(heroPath)).toBe(defsRoot);
    expect(findEntityDefsRootFromFile(moveIfacePath)).toBe(defsRoot);
  });

  it('entities.xml 位于 entity_defs 内的布局取该目录为根', () => {
    expect(findEntityDefsRootFromFile(path.join(innerXmlDir, 'entity_defs', 'Inner.def')))
      .toBe(path.join(innerXmlDir, 'entity_defs'));
  });

  it('找不到 entities.xml 返回 null', () => {
    expect(findEntityDefsRootFromFile(path.join(noRootDir, 'Lone.def'))).toBeNull();
  });
});

describe('computeDefRenameEdits 引用编辑计算', () => {
  const heroHpSymbol = (): DefRenameSymbol => {
    const symbol = resolveRenameSymbolAtOffset(HERO_DEF, cursorAt(HERO_DEF, '<hp>'));
    expect(symbol).not.toBeNull();
    return symbol!;
  };

  it('属性重命名覆盖同文件全部 Flags 变体与后代复述,无关实体不动', () => {
    const results = computeDefRenameEdits({
      targetFilePath: heroPath,
      targetText: HERO_DEF,
      symbol: heroHpSymbol(),
      newName: 'vigor'
    });
    // Hero:两个 hp 变体的开+闭标签 = 4;Monster/Boss/ParentElem 各 1 个复述 = 2
    // (ParentElem 是 <Parent><Hero/></Parent> 元素形态——引擎 getKey 同样取到 Hero)
    expect(editsByFile(results)).toEqual({
      'Hero.def': 4,
      'Monster.def': 2,
      'Boss.def': 2,
      'ParentElem.def': 2
    });

    const heroEntry = results.find(entry => entry.filePath === heroPath)!;
    const renamed = applyEdits(HERO_DEF, heroEntry.edits, 'vigor');
    expect(renamed).not.toContain('<hp>');
    expect(renamed).not.toContain('</hp>');
    expect(occurrences(renamed, '<vigor>')).toHaveLength(2);
    // 无关属性不动
    expect(renamed).toContain('<mp>');
    // 无关实体 Beast 的 hp 不在结果里
    expect(results.find(entry => entry.filePath === beastPath)).toBeUndefined();
  });

  it('方法重命名限同段:同文件跨段与后代其他段的同名方法都不动', () => {
    const symbol = resolveRenameSymbolAtOffset(HERO_DEF, cursorAt(HERO_DEF, '<move>'))!;
    const results = computeDefRenameEdits({
      targetFilePath: heroPath,
      targetText: HERO_DEF,
      symbol,
      newName: 'stepTo'
    });
    // Hero BaseMethods 的 move 带 Arg 子元素:开+闭 = 2;CellMethods 的自闭合 move 不动。
    // Monster(Parent Hero)BaseMethods 的自闭合 move 复述 = 1;其 CellMethods 不动。
    expect(editsByFile(results)).toEqual({ 'Hero.def': 2, 'Monster.def': 1 });

    const heroEntry = results.find(entry => entry.filePath === heroPath)!;
    const renamed = applyEdits(HERO_DEF, heroEntry.edits, 'stepTo');
    expect(renamed).toContain('<stepTo> <Arg> UINT8 </Arg> </stepTo>');
    expect(renamed).toContain('<move/>');

    const monsterEntry = results.find(entry => entry.filePath === monsterPath)!;
    const monsterRenamed = applyEdits(MONSTER_DEF, monsterEntry.edits, 'stepTo');
    expect(monsterRenamed).toContain('<BaseMethods>\n    <stepTo/>');
    expect(monsterRenamed).toContain('<CellMethods>\n    <move/>');
  });

  it('接口属性经 Interfaces 传递闭包更新混入实体(wrapper 四种拼写与文本/元素两种取名)', () => {
    const symbol = resolveRenameSymbolAtOffset(IBASE_DEF, cursorAt(IBASE_DEF, '<drift>'))!;
    const results = computeDefRenameEdits({
      targetFilePath: ibasePath,
      targetText: IBASE_DEF,
      symbol,
      newName: 'driftSpeed'
    });
    // IBase 源头 + MoveIface(Interface 元素形态包裹)+ Avatar(wrapper 文本形态,经
    // MoveIface 传递)+ Golem(Interface 元素形态)+ LowerIface(interface 拼写)+
    // TypeWrap(Type 文本形态)+ LowerType(type 文本形态)
    expect(editsByFile(results)).toEqual({
      'IBase.def': 2,
      'MoveIface.def': 2,
      'Avatar.def': 2,
      'Golem.def': 2,
      'LowerIface.def': 2,
      'TypeWrap.def': 2,
      'LowerType.def': 2
    });

    const avatarEntry = results.find(entry => entry.filePath === avatarPath)!;
    const renamed = applyEdits(AVATAR_DEF, avatarEntry.edits, 'driftSpeed');
    expect(renamed).toContain('<driftSpeed> <Type> FLOAT </Type> </driftSpeed>');
    expect(renamed).toContain('<own> <Type> UINT8 </Type> </own>');
  });

  it('以接口名直接命名的 <Interfaces> 子元素引擎不装载,不产生传播边', () => {
    // entitydef.cpp loadInterfaces 只认 wrapper 拼写的子元素,直取形态被跳过;
    // DirectIface 复述了 drift 但闭包不含 IBase——旧实现对齐 definitionSemantics
    // 三形态时会误跟随,引擎语义下必须缺席(负向锁)
    const symbol = resolveRenameSymbolAtOffset(IBASE_DEF, cursorAt(IBASE_DEF, '<drift>'))!;
    const results = computeDefRenameEdits({
      targetFilePath: ibasePath,
      targetText: IBASE_DEF,
      symbol,
      newName: 'driftSpeed'
    });
    expect(results.find(entry => entry.filePath === directIfacePath)).toBeUndefined();
    // Beast 的 <Ghost/> 同为直取形态,且 Ghost 悬空——双因缺席
    expect(results.find(entry => entry.filePath === beastPath)).toBeUndefined();
  });

  it('接口文件的 <Parent> 不被跟随:引擎 loadInterfaces 不走 loadParentClass', () => {
    // Parented.def 位于 interfaces/,声明 <Parent> Hero 并复述 hp;引擎装载接口
    // 文件时不读 Parent(entitydef.cpp L551-640),该复述对 Hero 的重命名不可见
    const results = computeDefRenameEdits({
      targetFilePath: heroPath,
      targetText: HERO_DEF,
      symbol: heroHpSymbol(),
      newName: 'vigor'
    });
    expect(results.find(entry => entry.filePath === ifaceParentedPath)).toBeUndefined();
  });

  it('混合内容 Parent(标签间换行缩进)首子节点是空白文本,引擎取空名不产生边', () => {
    // 引擎 loadParentClass 对 <Parent> 首个子节点做 getKey:MixedParent 的
    // 首子节点是 "\n    " 文本,trim 后空名 → 拼不出父类文件(装载失败),
    // 该复述对 Hero 的重命名不可见——"文本优先否则首元素"的写法会误跟随
    const results = computeDefRenameEdits({
      targetFilePath: heroPath,
      targetText: HERO_DEF,
      symbol: heroHpSymbol(),
      newName: 'vigor'
    });
    expect(results.find(entry => entry.filePath === mixedParentPath)).toBeUndefined();
  });

  it('组件 def 的 Parent 在 components/ 内解析:命中同目录组件、不误连同名根实体', () => {
    // 正向:BaseGun(组件)的 power 经 ChildGun(Parent BaseGun)复述传播
    const powerSymbol = resolveRenameSymbolAtOffset(BASE_GUN_DEF, cursorAt(BASE_GUN_DEF, '<power>'))!;
    const results = computeDefRenameEdits({
      targetFilePath: baseGunPath,
      targetText: BASE_GUN_DEF,
      symbol: powerSymbol,
      newName: 'attackPower'
    });
    expect(editsByFile(results)).toEqual({ 'BaseGun.def': 2, 'ChildGun.def': 2 });

    // 负向:Wand(组件)的 <Parent> Hero 在 components/ 内不存在(定义根的
    // Hero.def 是实体命名空间),引擎装载不到父类,重命名 Hero 的 hp 不传播
    const heroResults = computeDefRenameEdits({
      targetFilePath: heroPath,
      targetText: HERO_DEF,
      symbol: heroHpSymbol(),
      newName: 'vigor'
    });
    expect(heroResults.find(entry => entry.filePath === wandPath)).toBeUndefined();
  });

  it('在复述处发起只更新该文件与其后代,不复改祖先源头(如实边界)', () => {
    const symbol = resolveRenameSymbolAtOffset(MONSTER_DEF, cursorAt(MONSTER_DEF, '<hp>'))!;
    const results = computeDefRenameEdits({
      targetFilePath: monsterPath,
      targetText: MONSTER_DEF,
      symbol,
      newName: 'eliteHp'
    });
    expect(editsByFile(results)).toEqual({ 'Monster.def': 2, 'Boss.def': 2 });
    expect(results.find(entry => entry.filePath === heroPath)).toBeUndefined();
  });

  it('找不到定义根时退化为仅同文件', () => {
    const symbol = resolveRenameSymbolAtOffset(HERO_DEF, cursorAt(HERO_DEF, '<hp>'))!;
    const results = computeDefRenameEdits({
      targetFilePath: path.join(noRootDir, 'Lone.def'),
      targetText: HERO_DEF,
      symbol,
      newName: 'vigor'
    });
    expect(results).toHaveLength(1);
    expect(results[0].edits).toHaveLength(4);
  });

  it('非法新名与原样新名返回空编辑', () => {
    const symbol = heroHpSymbol();
    for (const newName of ['9bad', 'x-y', '', 'a b', 'hp']) {
      expect(computeDefRenameEdits({
        targetFilePath: heroPath,
        targetText: HERO_DEF,
        symbol,
        newName
      })).toEqual([]);
    }
  });

  it('目标文本不含该符号时返回空编辑,不再扫描引用', () => {
    const results = computeDefRenameEdits({
      targetFilePath: heroPath,
      targetText: '<root>\n</root>\n',
      symbol: heroHpSymbol(),
      newName: 'vigor'
    });
    expect(results).toEqual([]);
  });

  it('无该符号的后代、坏 XML 后代、悬空引用与组件 def 都不产生编辑', () => {
    const results = computeDefRenameEdits({
      targetFilePath: heroPath,
      targetText: HERO_DEF,
      symbol: heroHpSymbol(),
      newName: 'vigor'
    });
    expect(editsByFile(results)).toEqual({
      'Hero.def': 4,
      'Monster.def': 2,
      'Boss.def': 2,
      'ParentElem.def': 2
    });
    // Heir(Parent Hero)不复述 hp;Broken(Parent Monster)坏 XML 语义面为空;
    // Dangling 的 Parent/Interfaces 引用悬空;HealthComp/Wand/BaseGun/ChildGun
    // 是组件命名空间(且 Wand 的 Parent 在 components/ 内悬空)
    expect(results.find(entry => entry.filePath === heirPath)).toBeUndefined();
    expect(results.find(entry => entry.filePath === brokenPath)).toBeUndefined();
    expect(results.find(entry => entry.filePath === danglingPath)).toBeUndefined();
    expect(results.find(entry => entry.filePath === componentPath)).toBeUndefined();
    expect(results.find(entry => entry.filePath === baseGunPath)).toBeUndefined();
    expect(results.find(entry => entry.filePath === childGunPath)).toBeUndefined();
    expect(results.find(entry => entry.filePath === wandPath)).toBeUndefined();
  });

  it('扫描中途不可读的后代文件被跳过', () => {
    // chmod 000 让 readFileSync 抛 EACCES(批24 同款故障注入手法);
    // 内容读盘即失败,闭包与编辑面共用缓存,Boss 整体缺席
    fs.chmodSync(bossPath, 0o000);
    try {
      const results = computeDefRenameEdits({
        targetFilePath: heroPath,
        targetText: HERO_DEF,
        symbol: heroHpSymbol(),
        newName: 'vigor'
      });
      expect(editsByFile(results)).toEqual({ 'Hero.def': 4, 'Monster.def': 2, 'ParentElem.def': 2 });
    } finally {
      fs.chmodSync(bossPath, 0o644);
    }
  });

  it('不可枚举的子目录不影响其余文件的重命名', () => {
    // locked/ 目录 chmod 000 后 readdirSync 抛 EACCES,枚举静默跳过该目录
    fs.chmodSync(lockedDir, 0o000);
    try {
      const results = computeDefRenameEdits({
        targetFilePath: heroPath,
        targetText: HERO_DEF,
        symbol: heroHpSymbol(),
        newName: 'vigor'
      });
      expect(editsByFile(results)).toEqual({
        'Hero.def': 4,
        'Monster.def': 2,
        'Boss.def': 2,
        'ParentElem.def': 2
      });
    } finally {
      fs.chmodSync(lockedDir, 0o755);
    }
  });

  it('编辑区间升序且互不重叠,并携带基准文本', () => {
    const results = computeDefRenameEdits({
      targetFilePath: heroPath,
      targetText: HERO_DEF,
      symbol: heroHpSymbol(),
      newName: 'vigor'
    });
    for (const entry of results) {
      expect(entry.text.length).toBeGreaterThan(0);
      let previousEnd = -1;
      for (const edit of entry.edits) {
        expect(edit.start).toBeGreaterThan(previousEnd);
        expect(entry.text.slice(edit.start, edit.end)).toBe('hp');
        previousEnd = edit.end;
      }
    }
  });
});

describe('collectRenameEditsInText 与偏移换算纯函数', () => {
  it('同文件收集按符号种类与段过滤', () => {
    const property = { kind: 'property', name: 'hp', section: null } as DefRenameSymbol;
    expect(collectRenameEditsInText(HERO_DEF, property)).toHaveLength(4);

    const method = { kind: 'method', name: 'move', section: 'CellMethods' } as DefRenameSymbol;
    const edits = collectRenameEditsInText(HERO_DEF, method);
    expect(edits).toHaveLength(1); // 自闭合只算开标签
    expect(HERO_DEF.slice(edits[0].start, edits[0].end)).toBe('move');

    expect(collectRenameEditsInText('<root>\n</root>\n', property)).toHaveLength(0);
  });

  it('getLineCharacterAtOffset 按 \\n 分行并钳制越界偏移', () => {
    expect(getLineCharacterAtOffset('abc', 0)).toEqual({ line: 0, character: 0 });
    expect(getLineCharacterAtOffset('a\nbc', 2)).toEqual({ line: 1, character: 0 });
    expect(getLineCharacterAtOffset('a\nbc', 4)).toEqual({ line: 1, character: 2 });
    expect(getLineCharacterAtOffset('a\nbc', 99)).toEqual({ line: 1, character: 2 });
    expect(getLineCharacterAtOffset('a\nbc', -3)).toEqual({ line: 0, character: 0 });
  });

  it('DEF_IDENTIFIER_PATTERN 拒绝非 C 风格标识符', () => {
    expect(DEF_IDENTIFIER_PATTERN.test('_hp2')).toBe(true);
    expect(DEF_IDENTIFIER_PATTERN.test('2hp')).toBe(false);
    expect(DEF_IDENTIFIER_PATTERN.test('h-p')).toBe(false);
  });
});

describe('KBEngineRenameProvider 装配', () => {
  const provider = new KBEngineRenameProvider();

  const heroDocument = (): MinimalTextDocument =>
    makeTextDocument(HERO_DEF, { fileName: heroPath });

  it('prepareRename 返回词区间与占位名', () => {
    const document = heroDocument();
    const offset = cursorAt(HERO_DEF, '<hp>');
    const result = provider.prepareRename(document, document.positionAt(offset));

    expect(result).not.toBeNull();
    expect(result!.placeholder).toBe('hp');
    expect(document.offsetAt(result!.range.start)).toBe(offset - 1);
    expect(document.offsetAt(result!.range.end)).toBe(offset + 1);
  });

  it('非符号位置 prepareRename 返回 null', () => {
    const document = heroDocument();
    const typeValue = HERO_DEF.indexOf('UINT32') + 1;
    expect(provider.prepareRename(document, document.positionAt(typeValue))).toBeNull();
  });

  it('provideRenameEdits 产出跨文件 WorkspaceEdit 且区间可经各自行表回原', async () => {
    const document = heroDocument();
    const offset = cursorAt(HERO_DEF, '<hp>');
    const workspaceEdit = await provider.provideRenameEdits(
      document,
      document.positionAt(offset),
      'vigor'
    );

    expect(workspaceEdit).toBeInstanceOf(WorkspaceEdit);
    // Hero/Monster/Boss/ParentElem(Parent 元素形态)
    expect(workspaceEdit!.size).toBe(4);

    // 目标文件复用文档 uri,其余文件走 Uri.file(按 fsPath 索引断言)
    const heroEdits = workspaceEdit!.get(document.uri);
    expect(heroEdits).toHaveLength(4);
    expect(heroEdits[0]).toBeInstanceOf(TextEdit);
    expect(heroEdits.every(edit => edit.newText === 'vigor')).toBe(true);
    expect(document.offsetAt(heroEdits[0].range.start)).toBe(occurrences(HERO_DEF, '<hp>')[0] + 1);

    const byPath = new Map(workspaceEdit!.entries().map(([uri, edits]) => [uri.fsPath, edits] as const));
    const monsterEdits = byPath.get(monsterPath)!;
    expect(monsterEdits).toHaveLength(2);
    // 区间须按 Monster 自己的行表换算:首处 hp 名字在第 3 行(0 基)第 5 列起
    expect(monsterEdits[0].range.start).toEqual(new Position(3, 5));
    expect(monsterEdits[0].range.end).toEqual(new Position(3, 7));
  });

  it('非法新名与非符号位置 provideRenameEdits 返回 null', async () => {
    const document = heroDocument();
    const offset = cursorAt(HERO_DEF, '<hp>');
    expect(await provider.provideRenameEdits(document, document.positionAt(offset), '9bad')).toBeNull();
    expect(await provider.provideRenameEdits(document, document.positionAt(offset), 'hp')).toBeNull();

    const typeValue = HERO_DEF.indexOf('UINT32') + 1;
    expect(await provider.provideRenameEdits(document, document.positionAt(typeValue), 'vigor')).toBeNull();
  });
});
