import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTextDocument, Position, Uri, workspace as stubWorkspace } from './helpers/vscodeStub';
import {
  provideDefSymbolReferences,
  resolveDefSymbolReferenceTarget
} from '../src/defSymbolReferences';
import { KBEngineReferencesProvider } from '../src/languageProviders';

// IDE-NAV-018:def 内类型名/实体名/接口名引用查询(Shift+F12)。范围/验收:
// <Type>/<Arg>/<of> 值(自定义类型→types.xml 使用处+声明;实体类型→
// <Parent>/<Type> 使用处+实体 def)、<Parent> 值(实体引用+实体 def)、
// <Interface> 值(接口引用+接口 def);内建类型与容器字面无引用面(如实 null);
// includeDeclaration 语义与 def 面一致;空结果如实 null。
// prove-red:旧码 findDefSymbolInfo 对类型名/实体名/接口名返回 null(符号节
// 点名 !== word),Shift+F12 无引用;本模块接入后出引用位。

const HERO_DEF = [
  '<root>',
  '  <Parent>Monster</Parent>',
  '  <Interfaces>',
  '    <Interface>IMove</Interface>',
  '  </Interfaces>',
  '  <Components>',
  '    <weapon>',
  '      <Type>CWeapon</Type>',
  '    </weapon>',
  '  </Components>',
  '  <Properties>',
  '    <pos>',
  '      <Type>Vec3</Type>',
  '    </pos>',
  '    <loot>',
  '      <Type><of>Gold</of></Type>',
  '    </loot>',
  '    <arr>',
  '      <Type>ARRAY of Hero</Type>',
  '    </arr>',
  '    <hp>',
  '      <Type>UINT32</Type>',
  '    </hp>',
  '    <mystery>',
  '      <Type>NoSuch</Type>',
  '    </mystery>',
  '  </Properties>',
  '  <BaseMethods>',
  '    <attack>',
  '      <Arg>Monster</Arg>',
  '    </attack>',
  '  </BaseMethods>',
  '</root>'
].join('\n');

const MONSTER_DEF = [
  '<root>',
  '  <Properties>',
  '    <hp>',
  '      <Type>UINT32</Type>',
  '    </hp>',
  '  </Properties>',
  '</root>'
].join('\n');

const IMOVE_DEF = [
  '<root>',
  '  <Properties/>',
  '</root>'
].join('\n');

const CWEAPON_DEF = [
  '<root>',
  '  <Properties>',
  '    <dmg>',
  '      <Type>UINT32</Type>',
  '    </dmg>',
  '  </Properties>',
  '</root>'
].join('\n');

const TYPES_XML = [
  '<root>',
  '  <Vec3>',
  '    <Properties>',
  '      <x>',
  '        <Type>FLOAT</Type>',
  '      </x>',
  '    </Properties>',
  '  </Vec3>',
  '  <Gold>',
  '    <Properties>',
  '      <amount>',
  '        <Type>UINT32</Type>',
  '      </amount>',
  '    </Properties>',
  '  </Gold>',
  '</root>'
].join('\n');

const tmpRoots: string[] = [];
const makeTmpDir = (label: string): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `kode-defsymrefs-${label}-`));
  tmpRoots.push(dir);
  return dir;
};

describe('resolveDefSymbolReferenceTarget(符号识别)', () => {
  it('<Type> 值内类型名 → kind:type', () => {
    const offset = HERO_DEF.indexOf('<Type>Vec3</Type>') + '<Type>'.length;
    expect(resolveDefSymbolReferenceTarget(HERO_DEF, offset)).toEqual({
      kind: 'type',
      name: 'Vec3'
    });
  });

  it('<of> 值内类型名 → kind:type', () => {
    const offset = HERO_DEF.indexOf('<of>Gold</of>') + '<of>'.length;
    expect(resolveDefSymbolReferenceTarget(HERO_DEF, offset)).toEqual({
      kind: 'type',
      name: 'Gold'
    });
  });

  it('<Arg> 值内类型名 → kind:type', () => {
    const offset = HERO_DEF.indexOf('<Arg>Monster</Arg>') + '<Arg>'.length;
    expect(resolveDefSymbolReferenceTarget(HERO_DEF, offset)).toEqual({
      kind: 'type',
      name: 'Monster'
    });
  });

  it('<Parent> 值内实体名 → kind:parent', () => {
    const offset = HERO_DEF.indexOf('<Parent>Monster</Parent>') + '<Parent>'.length;
    expect(resolveDefSymbolReferenceTarget(HERO_DEF, offset)).toEqual({
      kind: 'parent',
      name: 'Monster'
    });
  });

  it('<Interface> 值内接口名 → kind:interface', () => {
    const offset = HERO_DEF.indexOf('<Interface>IMove</Interface>') + '<Interface>'.length;
    expect(resolveDefSymbolReferenceTarget(HERO_DEF, offset)).toEqual({
      kind: 'interface',
      name: 'IMove'
    });
  });

  it('容器字面 ARRAY 不是类型符号 → null', () => {
    const offset = HERO_DEF.indexOf('<Type>ARRAY of Hero</Type>') + '<Type>'.length;
    expect(resolveDefSymbolReferenceTarget(HERO_DEF, offset)).toBeNull();
  });

  it('元素名位(如 <pos> 名)不是引用符号 → null', () => {
    const offset = HERO_DEF.indexOf('    <pos>') + '    <pos>'.indexOf('pos') + 1;
    expect(resolveDefSymbolReferenceTarget(HERO_DEF, offset)).toBeNull();
  });

  it('非 XML 内容 → null 不抛', () => {
    expect(resolveDefSymbolReferenceTarget('not a def at all', 5)).toBeNull();
  });
});

describe('provideDefSymbolReferences(工作区级引用查询)', () => {
  let wsRoot: string;
  let defsDir: string;
  let heroDefPath: string;
  let monsterDefPath: string;
  let imoveDefPath: string;
  let cweaponDefPath: string;
  let typesXmlPath: string;
  const originalFindFiles = stubWorkspace.findFiles;
  const originalFolders = stubWorkspace.workspaceFolders;
  const originalDocuments = stubWorkspace.textDocuments;

  beforeEach(() => {
    wsRoot = makeTmpDir('ws');
    defsDir = path.join(wsRoot, 'scripts', 'entity_defs');
    const interfacesDir = path.join(defsDir, 'interfaces');
    const componentsDir = path.join(defsDir, 'components');
    heroDefPath = path.join(defsDir, 'Hero.def');
    monsterDefPath = path.join(defsDir, 'Monster.def');
    imoveDefPath = path.join(interfacesDir, 'IMove.def');
    cweaponDefPath = path.join(componentsDir, 'CWeapon.def');
    typesXmlPath = path.join(defsDir, 'types.xml');
    fs.mkdirSync(interfacesDir, { recursive: true });
    fs.mkdirSync(componentsDir, { recursive: true });
    fs.writeFileSync(heroDefPath, HERO_DEF);
    fs.writeFileSync(monsterDefPath, MONSTER_DEF);
    fs.writeFileSync(imoveDefPath, IMOVE_DEF);
    fs.writeFileSync(cweaponDefPath, CWEAPON_DEF);
    fs.writeFileSync(typesXmlPath, TYPES_XML);
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(wsRoot), name: 'ws', index: 0 }];
    stubWorkspace.textDocuments = [];
    stubWorkspace.findFiles = (async (glob?: string) => {
      if (typeof glob !== 'string') {
        return [];
      }
      if (glob === '**/*.def') {
        return [Uri.file(heroDefPath), Uri.file(monsterDefPath), Uri.file(imoveDefPath), Uri.file(cweaponDefPath)];
      }
      if (glob === '**/types.xml') {
        return [Uri.file(typesXmlPath)];
      }
      return [];
    }) as typeof stubWorkspace.findFiles;
  });

  afterEach(() => {
    stubWorkspace.findFiles = originalFindFiles;
    stubWorkspace.workspaceFolders = originalFolders;
    stubWorkspace.textDocuments = originalDocuments;
    for (const dir of tmpRoots.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  const heroDoc = () =>
    makeTextDocument(HERO_DEF, { fileName: heroDefPath, languageId: 'kbengine-def' }) as never;
  const positionAt = (content: string, word: string, occurrence = 0): Position => {
    const re = new RegExp(`\\b${word}\\b`, 'g');
    let match: RegExpExecArray | null;
    let count = 0;
    while ((match = re.exec(content)) !== null) {
      if (count === occurrence) {
        const before = content.slice(0, match.index).split('\n');
        return new Position(before.length - 1, before[before.length - 1].length);
      }
      count += 1;
    }
    throw new Error(`word ${word} occurrence ${occurrence} not found`);
  };

  it('自定义类型 Vec3:引用位(def 使用处)+includeDeclaration 声明(types.xml)', async () => {
    const doc = heroDoc();
    const pos = positionAt(HERO_DEF, 'Vec3');
    const withDecl = await provideDefSymbolReferences(doc, pos, true);
    expect(withDecl).not.toBeNull();
    const fsPaths = withDecl!.map(loc => loc.uri.fsPath);
    // def 一处(<Type>Vec3</Type>)+ types.xml 声明一处(<Vec3> 标签)
    expect(fsPaths.filter(p => p === heroDefPath)).toHaveLength(1);
    expect(fsPaths.filter(p => p === typesXmlPath)).toHaveLength(1);
    const withoutDecl = await provideDefSymbolReferences(doc, pos, false);
    expect(withoutDecl).not.toBeNull();
    expect(withoutDecl!.map(loc => loc.uri.fsPath)).toEqual([heroDefPath]);
    // 引用位字符区间覆盖 'Vec3'
    const site = withDecl!.find(loc => loc.uri.fsPath === heroDefPath)!;
    const lineText = HERO_DEF.split('\n')[site.range.start.line];
    expect(lineText.slice(site.range.start.character, site.range.start.character + 4)).toBe('Vec3');
  });

  it('父实体名(<Parent> 值)→ 引用位+实体 def 声明', async () => {
    const doc = heroDoc();
    const pos = positionAt(HERO_DEF, 'Monster', 0); // <Parent>Monster</Parent>
    const result = await provideDefSymbolReferences(doc, pos, true);
    expect(result).not.toBeNull();
    const fsPaths = result!.map(loc => loc.uri.fsPath);
    // <Parent>Monster</Parent> + <Arg>Monster</Arg> 两处引用 + Monster.def 声明
    expect(fsPaths.filter(p => p === heroDefPath)).toHaveLength(2);
    expect(fsPaths.filter(p => p === monsterDefPath)).toHaveLength(1);
  });

  it('实体类型(经 <Arg> 值)Monster → 引用位+实体 def 声明', async () => {
    const doc = heroDoc();
    const pos = positionAt(HERO_DEF, 'Monster', 1); // <Arg>Monster</Arg>
    const result = await provideDefSymbolReferences(doc, pos, true);
    expect(result).not.toBeNull();
    const fsPaths = result!.map(loc => loc.uri.fsPath);
    // 同上:<Parent>Monster</Parent> + <Arg>Monster</Arg> + Monster.def
    expect(fsPaths.filter(p => p === heroDefPath)).toHaveLength(2);
    expect(fsPaths.filter(p => p === monsterDefPath)).toHaveLength(1);
  });

  it('接口 IMove:<Interface> 引用位+接口 def 声明', async () => {
    const doc = heroDoc();
    const pos = positionAt(HERO_DEF, 'IMove');
    const result = await provideDefSymbolReferences(doc, pos, true);
    expect(result).not.toBeNull();
    const fsPaths = result!.map(loc => loc.uri.fsPath);
    expect(fsPaths.filter(p => p === heroDefPath)).toHaveLength(1);
    expect(fsPaths.filter(p => p === imoveDefPath)).toHaveLength(1);
  });

  it('内建类型 UINT32 → null(无引用面)', async () => {
    const doc = heroDoc();
    const pos = positionAt(HERO_DEF, 'UINT32');
    expect(await provideDefSymbolReferences(doc, pos, true)).toBeNull();
  });

  it('容器字面 ARRAY 位 → null', async () => {
    const doc = heroDoc();
    const pos = positionAt(HERO_DEF, 'ARRAY');
    expect(await provideDefSymbolReferences(doc, pos, true)).toBeNull();
  });

  it('未知类型(非内建/非自定义/非实体)→ null 不虚构', async () => {
    const doc = heroDoc();
    const pos = positionAt(HERO_DEF, 'NoSuch');
    expect(await provideDefSymbolReferences(doc, pos, true)).toBeNull();
  });

  it('wiring:findDefSymbolInfo 返回 null 的类型名仍出引用位(NAV-018 装配)', async () => {
    // prove-red:旧码在 findDefSymbolInfo null 时直接 return null;接入
    // provideDefSymbolReferences 后,类型名/实体名/接口名 Shift+F12 出引用。
    const provider = new KBEngineReferencesProvider({} as never);
    const doc = heroDoc();
    const result = await provider.provideReferences(
      doc,
      positionAt(HERO_DEF, 'Vec3'),
      { includeDeclaration: false },
      undefined
    );
    expect(result).not.toBeNull();
    expect(result!.map(loc => loc.uri.fsPath)).toEqual([heroDefPath]);
  });

});
