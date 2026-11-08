import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CancellationTokenSource, makeTextDocument, Position, Uri, workspace as stubWorkspace } from './helpers/vscodeStub';
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

// KR-AUD-77:引擎在 <Interfaces> 下认四种 wrapper 拼写(entitydef.cpp:563-566,
// defRenamer.INTERFACE_WRAPPER_NAMES 同源)——引用扫描此前只认 'Interface'
// 一种,小写/Type 形态的接口引用位缺失;<Interfaces> 外的同名 <Type>(属性
// 类型面)不得误计为接口引用。
describe('KR-AUD-77 interface reference sites cover all four wrapper spellings', () => {
  let wsRoot = '';
  let heroPath = '';
  let imovePath = '';
  const originalFindFiles = stubWorkspace.findFiles;
  const originalFolders = stubWorkspace.workspaceFolders;
  const originalDocuments = stubWorkspace.textDocuments;

  beforeEach(() => {
    wsRoot = makeTmpDir('ws-kr77');
    const defsDir = path.join(wsRoot, 'scripts', 'entity_defs');
    const interfacesDir = path.join(defsDir, 'interfaces');
    heroPath = path.join(defsDir, 'Hero2.def');
    imovePath = path.join(interfacesDir, 'IMove.def');
    fs.mkdirSync(interfacesDir, { recursive: true });
    fs.writeFileSync(heroPath, [
      '<root>',
      '  <Interfaces>',
      '    <Type>IMove</Type>',
      '  </Interfaces>',
      '  <Properties>',
      '    <shape> <Type>IMove</Type> </shape>',
      '  </Properties>',
      '</root>'
    ].join('\n'));
    fs.writeFileSync(imovePath, '<root>\n</root>');
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(wsRoot), name: 'ws', index: 0 }];
    stubWorkspace.textDocuments = [];
    stubWorkspace.findFiles = (async (glob?: string) => {
      if (glob === '**/*.def') {
        return [Uri.file(heroPath), Uri.file(imovePath)];
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

  it('<Type> wrapper under <Interfaces> yields the usage site; property <Type> does not', async () => {
    const content = fs.readFileSync(heroPath, 'utf8');
    const doc = makeTextDocument(content, { fileName: heroPath, languageId: 'kbengine-def' }) as never;
    // 光标放 <Interfaces> 包裹内的 IMove(第一处)
    const re = /\bIMove\b/g;
    const match = re.exec(content)!;
    const before = content.slice(0, match.index).split('\n');
    const pos = new Position(before.length - 1, before[before.length - 1].length);

    const refs = await provideDefSymbolReferences(doc, pos, false);
    expect(refs).not.toBeNull();
    const line = content.split('\n')[refs![0].range.start.line];
    // 引用位落在 <Type>IMove</Type>(Interfaces 内)那一行,而非属性 shape 行
    expect(line).toContain('<Type>IMove</Type>');
    expect(line).not.toContain('shape');
  });
});

describe('defSymbolReferences 缺口臂(无元素/接口识别/扫描边界/取消面/无根/去重)', () => {
  let wsRoot: string;
  let childDefPath: string;
  let monsterDefPath: string;
  let ifaceDefPath: string;
  const originalFindFiles = stubWorkspace.findFiles;
  const originalFolders = stubWorkspace.workspaceFolders;
  const originalDocuments = stubWorkspace.textDocuments;

  const CHILD_DEF = [
    '<root>',
    '  <Parent>',
    '',
    '    Monster',
    '  </Parent>',
    '</root>',
    ''
  ].join('\n');
  const IFACE_DEF = [
    '<root>',
    '  <Interfaces>',
    '    IMove',
    '  </Interfaces>',
    '</root>',
    ''
  ].join('\n');

  beforeEach(() => {
    wsRoot = makeTmpDir('ws-gap');
    const defsDir = path.join(wsRoot, 'scripts', 'entity_defs');
    fs.mkdirSync(defsDir, { recursive: true });
    childDefPath = path.join(defsDir, 'Child.def');
    monsterDefPath = path.join(defsDir, 'Monster.def');
    ifaceDefPath = path.join(defsDir, 'IMove.def');
    fs.writeFileSync(childDefPath, CHILD_DEF);
    fs.writeFileSync(monsterDefPath, '<root>\n</root>\n');
    fs.writeFileSync(ifaceDefPath, '<root>\n</root>\n');
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(wsRoot), name: 'ws', index: 0 }];
    stubWorkspace.textDocuments = [];
  });

  afterEach(() => {
    stubWorkspace.findFiles = originalFindFiles;
    stubWorkspace.workspaceFolders = originalFolders;
    stubWorkspace.textDocuments = originalDocuments;
    for (const dir of tmpRoots.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  const openDoc = (content: string) =>
    makeTextDocument(content, { fileName: path.join(wsRoot, 'scripts', 'entity_defs', 'Open.def'), languageId: 'kbengine-def' }) as never;
  const posOf = (content: string, word: string): Position => {
    const re = new RegExp(`\\b${word}\\b`, 'g');
    const match = re.exec(content);
    if (!match) {
      throw new Error(`word ${word} not found`);
    }
    const before = content.slice(0, match.index + 1).split('\n');
    return new Position(before.length - 1, before[before.length - 1].length - 1);
  };
  const stubScan = (defUris: ReturnType<typeof Uri.file>[]) => {
    stubWorkspace.findFiles = (async (glob?: string) => {
      if (glob === '**/*.def') {
        return defUris;
      }
      return [];
    }) as typeof stubWorkspace.findFiles;
  };

  it('resolveDefSymbolReferenceTarget:根外偏移无元素无词 → null', () => {
    const content = '<root>\n  <Parent>Monster</Parent>\n</root>\n';
    expect(resolveDefSymbolReferenceTarget(content, content.length)).toBeNull();
  });

  it('resolveDefSymbolReferenceTarget:Interfaces 直挂文本词识别为 interface', () => {
    const content = IFACE_DEF;
    const offset = content.indexOf('IMove') + 1;
    const target = resolveDefSymbolReferenceTarget(content, offset);
    expect(target).toEqual({ kind: 'interface', name: 'IMove' });
  });

  it('扫描边界:值区起始空行 token 跳过;无根 def 如实空;读不得的文件不拖垮查询', async () => {
    const malformedPath = path.join(wsRoot, 'scripts', 'entity_defs', 'Broken.def');
    fs.writeFileSync(malformedPath, '', 'utf8'); // 空内容:可解析但无根 → 扫描如实空
    const ghostPath = path.join(wsRoot, 'scripts', 'entity_defs', 'Ghost.def'); // 不落盘 → 读取抛错
    stubScan([Uri.file(childDefPath), Uri.file(malformedPath), Uri.file(ghostPath)]);
    const doc = openDoc(CHILD_DEF);
    const locations = await provideDefSymbolReferences(doc, posOf(CHILD_DEF, 'Monster'), true);
    // Monster 声明(Monster.def)+ Child.def 中的 Parent 引用位;坏文件不拖垮查询
    expect(locations).not.toBeNull();
    const files = locations!.map(location => location.uri.fsPath);
    expect(files).toContain(monsterDefPath);
    expect(files).toContain(childDefPath);
  });

  it('重复引用位去重:同文件经 def/types.xml 双 glob 重复进扫描 → 引用位只出一次', async () => {
    // collectCustomTypeSites 把 '**/*.def' 与 '**/types.xml' 两路枚举拼接;
    // 同一文件两路都可得时同位引用会重复入库,最终locations 面必须去重。
    const typesXmlPath = path.join(wsRoot, 'scripts', 'entity_defs', 'types.xml');
    fs.writeFileSync(typesXmlPath, '<root><Vec3><Properties><x><Type>Vec3</Type></x></Properties></Vec3></root>\n');
    stubWorkspace.findFiles = (async (glob?: string) => {
      if (glob === '**/*.def' || glob === '**/types.xml') {
        return [Uri.file(typesXmlPath)];
      }
      return [];
    }) as typeof stubWorkspace.findFiles;
    const typeDocContent = '<root>\n  <Properties>\n    <pos>\n      <Type>Vec3</Type>\n    </pos>\n  </Properties>\n</root>\n';
    const doc = openDoc(typeDocContent);
    const locations = await provideDefSymbolReferences(doc, posOf(typeDocContent, 'Vec3'), true);
    expect(locations).not.toBeNull();
    const siteKeys = locations!.map(location => `${location.uri.fsPath}:${location.range.start.line}:${location.range.start.character}`);
    expect(new Set(siteKeys).size).toBe(siteKeys.length);
  });

  it('取消面:采集循环顶取消 → 如实 null(parent/type/interface 三路)', async () => {
    // type 路前提:Vec3 是 types.xml 自定义类型,否则派发根本进不了 collectCustomTypeSites
    const typesXmlPath = path.join(wsRoot, 'scripts', 'entity_defs', 'types.xml');
    fs.writeFileSync(typesXmlPath, [
      '<root>',
      '  <Vec3>',
      '    <Properties>',
      '      <x>',
      '        <Type>FLOAT</Type>',
      '      </x>',
      '    </Properties>',
      '  </Vec3>',
      '</root>',
      ''
    ].join('\n'));
    const typeDefContent = '<root>\n  <Properties>\n    <pos>\n      <Type>Vec3</Type>\n    </pos>\n  </Properties>\n</root>\n';
    for (const [content, word] of [
      [CHILD_DEF, 'Monster'],
      [typeDefContent, 'Vec3'],
      [IFACE_DEF, 'IMove']
    ] as Array<[string, string]>) {
      const cts = new CancellationTokenSource();
      stubWorkspace.findFiles = (async (glob?: string) => {
        cts.cancel(); // 文件枚举在途即取消 → 循环顶如实返回
        if (glob === '**/*.def') {
          return [Uri.file(childDefPath)];
        }
        if (glob === '**/types.xml') {
          return [Uri.file(typesXmlPath)];
        }
        return [];
      }) as typeof stubWorkspace.findFiles;
      const doc = openDoc(content);
      const result = await provideDefSymbolReferences(doc, posOf(content, word), true, cts.token);
      expect(result).toBeNull();
    }
  });

  it('取消面:进入即已取消 → 如实 null', async () => {
    const cts = new CancellationTokenSource();
    cts.cancel();
    const doc = openDoc(CHILD_DEF);
    const result = await provideDefSymbolReferences(doc, posOf(CHILD_DEF, 'Monster'), true, cts.token);
    expect(result).toBeNull();
  });

  it('无工作区根:如实 null', async () => {
    stubWorkspace.workspaceFolders = [];
    const doc = openDoc(CHILD_DEF);
    const result = await provideDefSymbolReferences(doc, posOf(CHILD_DEF, 'Monster'), true);
    expect(result).toBeNull();
  });

  it('parent 目标但实体 def 缺失:如实 null,不出声明', async () => {
    const ghostChild = [
      '<root>',
      '  <Parent>Ghost</Parent>',
      '</root>',
      ''
    ].join('\n');
    const doc = openDoc(ghostChild);
    const result = await provideDefSymbolReferences(doc, posOf(ghostChild, 'Ghost'), true);
    expect(result).toBeNull();
  });

  it('interface 目标零引用零声明:空结果如实 null', async () => {
    const lonely = [
      '<root>',
      '  <Interfaces>',
      '    INope',
      '  </Interfaces>',
      '</root>',
      ''
    ].join('\n');
    // 扫描列表里混入读不得的文件:单文件读取失败只 continue,不拖垮查询
    const ghostPath = path.join(wsRoot, 'scripts', 'entity_defs', 'Ghost.def');
    stubScan([Uri.file(ghostPath)]);
    const doc = openDoc(lonely);
    const result = await provideDefSymbolReferences(doc, posOf(lonely, 'INope'), true);
    expect(result).toBeNull();
  });
});
