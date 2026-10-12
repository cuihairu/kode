import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KBEngineDefinitionProvider } from '../src/languageProviders';
import { parseDefFileSemantics } from '../src/defRenamer';
import {
  findComponentScriptFile,
  findEntityScriptFile,
  findInterfaceScriptFile
} from '../src/definitionWorkspace';
import { EntityMappingManager } from '../src/entityMapping';
import { messages } from './fake-vscode/windowState';
import {
  Position,
  Uri,
  makeTextDocument,
  workspace as stubWorkspace
} from './helpers/vscodeStub';
import type { MinimalTextDocument } from './helpers/vscodeStub';

// F12 回归(用户令 2026-10-12):官方 newassets(server_assets/scripts)风格上
// Properties / BaseMethods / CellMethods 三条跳转必须真实落到 scripts/<域>/
// <实体>.py 的 class/def 行;脚本不在文档所属根时跨工作区根自动寻找;Parent
// 链按 def 相对 defs 目录上溯;约定链全空时弹「期望位置」提示并落注册声明,
// 管理器路径每一臂留导航日志。跨提交行为矩阵(8707b35/3b45b67/c1d8ba4)已证
// 单风格布局无回归,本文件锁定的是上述缺口形态。尾部另锁角色目录下嵌套的
// scripts/<角色>/interfaces/ 与 scripts/<角色>/components/(含 Interface_<名>.py
// 命名变体)及段角色配对:BaseApp 的 def 跳 base、CellApp 跳 cell。

interface LocationLike {
  uri: { fsPath: string };
  range: { start: { line: number } };
}

let wsRoot = '';
let wsRootB = '';
const p = (root: string, ...segments: string[]) => path.join(root, ...segments);

// 官方模板口径:TAB 缩进、Proxy 基类、def 行带 docstring
const ACCOUNT_DEF = [
  '<root>',
  '\t<Parent>Mob</Parent>',
  '\t<Properties>',
  '\t\t<hp>',
  '\t\t\t<Type>UINT32</Type>',
  '\t\t\t<Flags>ALL_CLIENTS</Flags>',
  '\t\t</hp>',
  '\t</Properties>',
  '\t<BaseMethods>',
  '\t\t<onKill>',
  '\t\t\t<Arg>ENTITY_ID</Arg>',
  '\t\t\t<Exposed>true</Exposed>',
  '\t\t</onKill>',
  '\t</BaseMethods>',
  '\t<CellMethods>',
  '\t\t<onTick>',
  '\t\t</onTick>',
  '\t</CellMethods>',
  '</root>'
].join('\n');

const MOB_DEF = '<root>\n\t<Properties>\n\t</Properties>\n</root>\n';
// 官方 base/Account.py 形态:class 带 Proxy 基类 + TAB 缩进方法
const BASE_PY = [
  '# -*- coding: utf-8 -*-',
  'import KBEngine',
  'from KBEDebug import *',
  '',
  'class Account(KBEngine.Proxy):',
  '\tdef __init__(self):',
  '\t\tKBEngine.Proxy.__init__(self)',
  '',
  '\tdef onKill(self, entityId):',
  '\t\tDEBUG_MSG(entityId)',
  ''
].join('\n');
const CELL_PY = ['class Account:', '\tdef onTick(self):', '\t\tpass', ''].join('\n');
const MOB_PY = ['class Mob:', '\tpass', ''].join('\n');
const ENTITIES_XML = [
  '<root>',
  '\t<Account hasBase="true" hasCell="true"/>',
  '\t<Mob hasBase="true"/>',
  '</root>',
  ''
].join('\n');

const writeTree = (root: string, scriptsBase: string): void => {
  const write = (relative: string, content: string): void => {
    const target = p(root, ...relative.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf8');
  };
  write(`${scriptsBase}/entity_defs/Account.def`, ACCOUNT_DEF);
  write(`${scriptsBase}/entity_defs/Mob.def`, MOB_DEF);
  write(`${scriptsBase}/entities.xml`, ENTITIES_XML);
  write(`${scriptsBase}/base/Account.py`, BASE_PY);
  write(`${scriptsBase}/cell/Account.py`, CELL_PY);
  write(`${scriptsBase}/base/Mob.py`, MOB_PY);
};

const defAt = (absolute: string, marker: string): {
  document: MinimalTextDocument;
  position: Position;
} => {
  const text = fs.readFileSync(absolute, 'utf8');
  const idx = text.indexOf(marker);
  expect(idx, `marker ${marker} in ${absolute}`).toBeGreaterThanOrEqual(0);
  const before = text.slice(0, idx + 1);
  const line = before.split('\n').length - 1;
  const character = before.length - (before.lastIndexOf('\n') + 1);
  return {
    document: makeTextDocument(text, { fileName: absolute, languageId: 'kbengine-def' }),
    position: new Position(line, character)
  };
};

const probe = async (
  absolute: string,
  marker: string,
  provider: KBEngineDefinitionProvider
): Promise<LocationLike | null> => {
  const { document, position } = defAt(absolute, marker);
  const result = await provider.provideDefinition(document, position) as unknown as
    | LocationLike
    | LocationLike[]
    | null
    | undefined;
  return (Array.isArray(result) ? result[0] : result) ?? null;
};

beforeAll(() => {
  wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-nav-reg-'));
  // 根 B:多根工程形态,def 与脚本分属两个工作区根
  wsRootB = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-nav-reg-b-'));
  writeTree(wsRoot, 'server_assets/scripts');
  // 根 B 只放脚本,不放 def(自动寻找的目标侧)
  const b = (relative: string, content: string): void => {
    const target = p(wsRootB, ...relative.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf8');
  };
  b('scripts/base/Solo.py', 'class Solo:\n    pass\n');
  b('scripts/interfaces/SoloIface.py', 'class SoloIface:\n    pass\n');
  stubWorkspace.workspaceFolders = [
    { uri: Uri.file(wsRoot), name: 'a', index: 0 },
    { uri: Uri.file(wsRootB), name: 'b', index: 1 }
  ];
});

afterAll(() => {
  fs.rmSync(wsRoot, { recursive: true, force: true });
  fs.rmSync(wsRootB, { recursive: true, force: true });
  stubWorkspace.workspaceFolders = [];
});

describe('F12 三链回归:官方 newassets 风格(server_assets/scripts)', () => {
  const provider = new KBEngineDefinitionProvider();
  const accountDef = () => p(wsRoot, 'server_assets', 'scripts', 'entity_defs', 'Account.def');

  it('Properties 跳转落到 base/Account.py 的 class 行', async () => {
    const location = await probe(accountDef(), '<hp>', provider);
    expect(location?.uri.fsPath).toBe(p(wsRoot, 'server_assets', 'scripts', 'base', 'Account.py'));
    expect(location?.range.start.line).toBe(4);
  });

  it('BaseMethods 跳转落到 base/Account.py 的 def onKill 行', async () => {
    const location = await probe(accountDef(), '<onKill>', provider);
    expect(location?.uri.fsPath).toBe(p(wsRoot, 'server_assets', 'scripts', 'base', 'Account.py'));
    expect(location?.range.start.line).toBe(8);
  });

  it('CellMethods 跳转落到 cell/Account.py 的 def onTick 行', async () => {
    const location = await probe(accountDef(), '<onTick>', provider);
    expect(location?.uri.fsPath).toBe(p(wsRoot, 'server_assets', 'scripts', 'cell', 'Account.py'));
    expect(location?.range.start.line).toBe(1);
  });

  it('Parent 链按 def 相对 defs 目录上溯(自有脚本缺失时落父类行)', async () => {
    // 自有 base/cell 脚本全撤走 → 候选闭包沿 Parent 上溯到 Mob.py
    const basePy = p(wsRoot, 'server_assets', 'scripts', 'base', 'Account.py');
    const cellPy = p(wsRoot, 'server_assets', 'scripts', 'cell', 'Account.py');
    const baseStash = fs.readFileSync(basePy, 'utf8');
    const cellStash = fs.readFileSync(cellPy, 'utf8');
    fs.rmSync(basePy);
    fs.rmSync(cellPy);
    try {
      const location = await probe(accountDef(), '<hp>', provider);
      expect(location?.uri.fsPath).toBe(p(wsRoot, 'server_assets', 'scripts', 'base', 'Mob.py'));
      expect(location?.range.start.line).toBe(0);
    } finally {
      fs.writeFileSync(basePy, baseStash, 'utf8');
      fs.writeFileSync(cellPy, cellStash, 'utf8');
    }
  });

  it('server_assets 官方风格进入工作区布局候选(entities.xml 可发现)', async () => {
    const { getDefinitionWorkspaceLayout } = await import('../src/definitionWorkspace');
    const layout = getDefinitionWorkspaceLayout(wsRoot);
    expect(layout.entityDefsRoot).toBe(p(wsRoot, 'server_assets', 'scripts', 'entity_defs'));
    expect(layout.entityScriptsRoot).toBe(p(wsRoot, 'server_assets', 'scripts'));
    expect(layout.entitiesXmlPath).toBe(p(wsRoot, 'server_assets', 'scripts', 'entities.xml'));
  });
});

describe('多根工程自动寻找(def 与脚本分属两个工作区根)', () => {
  const provider = new KBEngineDefinitionProvider();
  const soloDefPath = () => p(wsRoot, 'server_assets', 'scripts', 'entity_defs', 'Solo.def');
  const soloDef = '<root>\n\t<Properties>\n\t\t<gold>\n\t\t</gold>\n\t</Properties>\n\t<BaseMethods>\n\t\t<onPay>\n\t\t</onPay>\n\t</BaseMethods>\n</root>\n';

  it('文档所属根无脚本 → 跨根找到 scripts/base/Solo.py', async () => {
    fs.writeFileSync(soloDefPath(), soloDef, 'utf8');
    try {
      const location = await probe(soloDefPath(), '<gold>', provider);
      expect(location?.uri.fsPath).toBe(p(wsRootB, 'scripts', 'base', 'Solo.py'));
      expect(location?.range.start.line).toBe(0);
    } finally {
      fs.rmSync(soloDefPath());
    }
  });

  it('findEntityScriptFile 直接调用:无任何根命中时如实 null', async () => {
    expect(findEntityScriptFile('Nobody', 'base', soloDefPath())).toBeNull();
  });

  it('string 形态 target 语义是显式单一根,不跨根扩散', () => {
    expect(findEntityScriptFile('Solo', 'base', wsRoot)).toBeNull();
    expect(findEntityScriptFile('Solo', 'base', wsRootB)).toBe(p(wsRootB, 'scripts', 'base', 'Solo.py'));
    expect(findInterfaceScriptFile('SoloIface', wsRootB)).toBe(
      p(wsRootB, 'scripts', 'interfaces', 'SoloIface.py')
    );
  });

  it('无工作区根(空列表)→ null,不抛', () => {
    const folders = stubWorkspace.workspaceFolders;
    stubWorkspace.workspaceFolders = [];
    try {
      expect(findEntityScriptFile('Solo', 'base', p(wsRoot, 'x.def'))).toBeNull();
    } finally {
      stubWorkspace.workspaceFolders = folders;
    }
  });
});

describe('注册表回落:defs 目录内的 entities.xml(夹具/部分工程形态)', () => {
  const provider = new KBEngineDefinitionProvider();

  it('约定链全空 → 落 entity_defs/entities.xml 的声明行并弹提示', async () => {
    const legacyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-nav-reg-legacy-'));
    const defsDir = p(legacyRoot, 'entity_defs');
    fs.mkdirSync(defsDir, { recursive: true });
    fs.writeFileSync(p(defsDir, 'Ghost.def'), '<root>\n\t<Properties>\n\t\t<wisp>\n\t\t</wisp>\n\t</Properties>\n</root>\n', 'utf8');
    // 清单放在 defs 目录内(scriptsRoot 下没有 entities.xml)
    fs.writeFileSync(p(defsDir, 'entities.xml'), '<root>\n\t<Ghost hasBase="true"/>\n</root>\n', 'utf8');
    const folders = stubWorkspace.workspaceFolders;
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(legacyRoot), name: 'legacy', index: 0 }];
    try {
      messages.info.length = 0;
      const location = await probe(p(defsDir, 'Ghost.def'), '<wisp>', provider);
      expect(location?.uri.fsPath).toBe(p(defsDir, 'entities.xml'));
      expect(location?.range.start.line).toBe(1);
      expect(messages.info.some(entry => entry.includes('wisp') && entry.includes('Ghost.py'))).toBe(true);
    } finally {
      stubWorkspace.workspaceFolders = folders;
      fs.rmSync(legacyRoot, { recursive: true, force: true });
    }
  });
});

describe('管理器路径:约定链落空弹提示、约定链命中真落点', () => {
  const makeManager = (
    identity: unknown,
    reference: unknown
  ): EntityMappingManager =>
    ({
      resolveDefinitionSymbolAtPosition: () => Promise.resolve(identity),
      resolveMethodImplementationByIdentity: () => Promise.resolve(reference)
    }) as unknown as EntityMappingManager;

  const onTickDef = () => p(wsRoot, 'server_assets', 'scripts', 'entity_defs', 'Tick.def');
  const onTickText = '<root>\n\t<CellMethods>\n\t\t<onBeat>\n\t\t</onBeat>\n\t</CellMethods>\n</root>\n';
  const accountDefPath = () => p(wsRoot, 'server_assets', 'scripts', 'entity_defs', 'Account.def');

  beforeAll(() => {
    // Tick 注册进注册表,注册声明回落才有实体行可落
    const entitiesXml = p(wsRoot, 'server_assets', 'scripts', 'entities.xml');
    fs.writeFileSync(
      entitiesXml,
      fs.readFileSync(entitiesXml, 'utf8').replace('</root>', '\t<Tick hasCell="true"/>\n</root>'),
      'utf8'
    );
  });

  afterAll(() => {
    fs.rmSync(onTickDef(), { force: true });
    const entitiesXml = p(wsRoot, 'server_assets', 'scripts', 'entities.xml');
    fs.writeFileSync(
      entitiesXml,
      fs.readFileSync(entitiesXml, 'utf8').replace('\t<Tick hasCell="true"/>\n', ''),
      'utf8'
    );
  });

  it('索引双 miss + cell 脚本不存在 → 提示 + 注册声明行(不再静默落 def 行)', async () => {
    fs.writeFileSync(onTickDef(), onTickText, 'utf8');
    messages.info.length = 0;
    const provider = new KBEngineDefinitionProvider(makeManager(null, null));
    const location = await probe(onTickDef(), '<onBeat>', provider);

    expect(location?.uri.fsPath).toBe(p(wsRoot, 'server_assets', 'scripts', 'entities.xml'));
    const tickLine = fs
      .readFileSync(p(wsRoot, 'server_assets', 'scripts', 'entities.xml'), 'utf8')
      .split('\n')
      .findIndex(line => line.includes('<Tick'));
    expect(location?.range.start.line).toBe(tickLine);
    expect(
      messages.info.some(entry => entry.includes('onBeat') && entry.includes('cell/Tick.py'))
    ).toBe(true);
  });

  it('索引未绑定实现但约定链命中 → 落 cell/Account.py 的 def 行', async () => {
    // 约定链只认 def 自身(+Parent/接口)的脚本,Tick.def 无 cell/Tick.py 不可能
    // 命中 Account;约定命中臂改用 Account.def(cell/Account.py 有 def onTick)。
    messages.info.length = 0;
    const provider = new KBEngineDefinitionProvider(
      makeManager({ ownerName: 'Account', symbolName: 'onTick' }, null)
    );
    const location = await probe(accountDefPath(), '<onTick>', provider);

    expect(location?.uri.fsPath).toBe(p(wsRoot, 'server_assets', 'scripts', 'cell', 'Account.py'));
    expect(location?.range.start.line).toBe(1);
    expect(messages.info).toHaveLength(0);
  });
});

describe('无工作区根(未打开任何文件夹)的孤立 def', () => {
  const provider = new KBEngineDefinitionProvider();
  const orphanRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-nav-reg-orphan-'));
  const orphanDef = () => p(orphanRoot, 'Orphan.def');
  // Parent 指向不存在的实体:Parent 链在 defs 目录/工作区两级都找不到候选
  const orphanText = [
    '<root>',
    '\t<Parent>Ghost</Parent>',
    '\t<Properties>',
    '\t\t<wisp>',
    '\t\t\t<Type>UINT32</Type>',
    '\t\t</wisp>',
    '\t</Properties>',
    '</root>'
  ].join('\n');

  beforeAll(() => {
    fs.writeFileSync(orphanDef(), orphanText, 'utf8');
  });

  afterAll(() => {
    fs.rmSync(orphanRoot, { recursive: true, force: true });
  });

  it('属性链全空 → 提示 + def 首行落点,不抛(vscode 无打开文件夹形态)', async () => {
    const folders = stubWorkspace.workspaceFolders;
    stubWorkspace.workspaceFolders = undefined as unknown as typeof folders;
    try {
      messages.info.length = 0;
      const location = await probe(orphanDef(), '<wisp>', provider);
      expect(location?.uri.fsPath).toBe(orphanDef());
      expect(location?.range.start.line).toBe(0);
      expect(messages.info.some(entry => entry.includes('wisp'))).toBe(true);
    } finally {
      stubWorkspace.workspaceFolders = folders;
    }
  });

  it('空字符串根 target → null', () => {
    expect(findEntityScriptFile('Solo', 'base', '')).toBeNull();
  });
});

describe('引擎官方模板形态(base/cell/bots + interface 单数)与生成器平铺形态', () => {
  // 用户 2026-10-12 实测核定:kbe/res/sdk_templates/server/python_assets/scripts/
  // 下只有 base/bots/cell/interface 等目录,没有 client/,接口脚本在单数
  // interface/;本扩展代码生成器(pythonOutputPath='scripts')把实体脚本平铺
  // 在 scripts/<实体>.py。三者此前都没有被候选链承认。
  const provider = new KBEngineDefinitionProvider();
  const tmplRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-nav-reg-tmpl-'));
  const flatRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-nav-reg-flat-'));
  const w = (root: string, relative: string, content: string): void => {
    const target = p(root, ...relative.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf8');
  };

  const heroDef = () => p(tmplRoot, 'scripts', 'entity_defs', 'Hero.def');
  const mageDef = () => p(flatRoot, 'scripts', 'entity_defs', 'Mage.def');
  const magePy = () => p(flatRoot, 'scripts', 'Mage.py');

  const HERO_DEF = [
    '<root>',
    '\t<Properties>',
    '\t\t<hp>',
    '\t\t\t<Type>UINT32</Type>',
    '\t\t</hp>',
    '\t</Properties>',
    '\t<Interfaces>',
    '\t\t<interface>Combat</interface>',
    '\t</Interfaces>',
    '\t<BaseMethods>',
    '\t\t<onCreate>',
    '\t\t</onCreate>',
    '\t\t<onSlash>',
    '\t\t</onSlash>',
    '\t</BaseMethods>',
    '\t<CellMethods>',
    '\t\t<onTick>',
    '\t\t</onTick>',
    '\t</CellMethods>',
    '\t<ClientMethods>',
    '\t\t<onSpawn>',
    '\t\t</onSpawn>',
    '\t\t<onGone>',
    '\t\t</onGone>',
    '\t</ClientMethods>',
    '</root>'
  ].join('\n');
  const BASE_HERO_PY = [
    'class Hero(KBEngine.Proxy):',
    '\tdef onCreate(self):',
    '\t\tpass',
    ''
  ].join('\n');
  const CELL_HERO_PY = ['class Hero:', '\tdef onTick(self):', '\t\tpass', ''].join('\n');
  const BOTS_HERO_PY = ['class Hero:', '\tdef onSpawn(self):', '\t\tpass', ''].join('\n');
  const INTERFACE_COMBAT_PY = ['class Combat:', '\tdef onSlash(self):', '\t\tpass', ''].join('\n');
  // 生成器形态:实体脚本平铺在 scripts 根,类名为 <实体>Base
  const MAGE_DEF = [
    '<root>',
    '\t<Properties>',
    '\t\t<mp>',
    '\t\t\t<Type>UINT32</Type>',
    '\t\t</mp>',
    '\t</Properties>',
    '\t<BaseMethods>',
    '\t\t<onCast>',
    '\t\t</onCast>',
    '\t</BaseMethods>',
    '</root>'
  ].join('\n');
  const MAGE_PY = [
    'class MageBase():',
    '\tdef __init__(self):',
    '\t\tpass',
    '\tdef onCast(self):',
    '\t\tpass',
    ''
  ].join('\n');
  const ENTITIES_XML_TMPL = [
    '<root>',
    '\t<Hero hasBase="true" hasCell="true" hasClient="true"/>',
    '</root>',
    ''
  ].join('\n');

  beforeAll(() => {
    w(tmplRoot, 'scripts/entities.xml', ENTITIES_XML_TMPL);
    w(tmplRoot, 'scripts/entity_defs/Hero.def', HERO_DEF);
    w(tmplRoot, 'scripts/base/Hero.py', BASE_HERO_PY);
    w(tmplRoot, 'scripts/cell/Hero.py', CELL_HERO_PY);
    w(tmplRoot, 'scripts/bots/Hero.py', BOTS_HERO_PY);
    w(tmplRoot, 'scripts/interface/Combat.py', INTERFACE_COMBAT_PY);
    w(flatRoot, 'scripts/entity_defs/Mage.def', MAGE_DEF);
    w(flatRoot, 'scripts/Mage.py', MAGE_PY);
  });

  afterAll(() => {
    fs.rmSync(tmplRoot, { recursive: true, force: true });
    fs.rmSync(flatRoot, { recursive: true, force: true });
  });

  const withFolders = async (run: () => Promise<void>): Promise<void> => {
    const folders = stubWorkspace.workspaceFolders;
    stubWorkspace.workspaceFolders = [
      ...folders,
      { uri: Uri.file(tmplRoot), name: 'tmpl', index: folders.length },
      { uri: Uri.file(flatRoot), name: 'flat', index: folders.length + 1 }
    ];
    try {
      await run();
    } finally {
      stubWorkspace.workspaceFolders = folders;
    }
  };

  it('ClientMethods 落到官方模板 bots/ 目录的 def 行', async () => {
    await withFolders(async () => {
      const location = await probe(heroDef(), '<onSpawn>', provider);
      expect(location?.uri.fsPath).toBe(p(tmplRoot, 'scripts', 'bots', 'Hero.py'));
      expect(location?.range.start.line).toBe(1);
    });
  });

  it('BaseMethods 落到 base/ 的 def 行', async () => {
    await withFolders(async () => {
      const location = await probe(heroDef(), '<onCreate>', provider);
      expect(location?.uri.fsPath).toBe(p(tmplRoot, 'scripts', 'base', 'Hero.py'));
      expect(location?.range.start.line).toBe(1);
    });
  });

  it('CellMethods 落到 cell/ 的 def 行', async () => {
    await withFolders(async () => {
      const location = await probe(heroDef(), '<onTick>', provider);
      expect(location?.uri.fsPath).toBe(p(tmplRoot, 'scripts', 'cell', 'Hero.py'));
      expect(location?.range.start.line).toBe(1);
    });
  });

  it('Properties 落到 base/ 实体类行', async () => {
    await withFolders(async () => {
      const location = await probe(heroDef(), '<hp>', provider);
      expect(location?.uri.fsPath).toBe(p(tmplRoot, 'scripts', 'base', 'Hero.py'));
      expect(location?.range.start.line).toBe(0);
    });
  });

  it('接口实现落到单数 interface/ 目录(引擎官方模板目录名)', async () => {
    await withFolders(async () => {
      const location = await probe(heroDef(), '<onSlash>', provider);
      expect(location?.uri.fsPath).toBe(p(tmplRoot, 'scripts', 'interface', 'Combat.py'));
      expect(location?.range.start.line).toBe(1);
    });
  });

  it('生成器平铺形态:Properties 落到 scripts/<实体>.py 的 __init__ 行', async () => {
    await withFolders(async () => {
      const location = await probe(mageDef(), '<mp>', provider);
      expect(location?.uri.fsPath).toBe(magePy());
      // 类名 <实体>Base ≠ 实体名时,落点按 __init__ 行优先(先于首个类行)
      expect(location?.range.start.line).toBe(1);
    });
  });

  it('生成器平铺形态:BaseMethods 落到 scripts/<实体>.py 的 def 行', async () => {
    await withFolders(async () => {
      const location = await probe(mageDef(), '<onCast>', provider);
      expect(location?.uri.fsPath).toBe(magePy());
      expect(location?.range.start.line).toBe(3);
    });
  });

  it('跨根:def 侧 scripts 根无平铺脚本 → 找到其他根的平铺脚本', async () => {
    await withFolders(async () => {
      // def 放在 flatRoot 根级 entity_defs(其 scripts 根=flatRoot,无平铺脚本);
      // 平铺脚本放 tmplRoot/scripts/(另一工作区根的布局 scripts 根)
      w(flatRoot, 'entity_defs/Mage2.def', '<root>\n\t<BaseMethods>\n\t\t<onBlast>\n\t\t</onBlast>\n\t</BaseMethods>\n</root>\n');
      w(tmplRoot, 'scripts/Mage2.py', 'class Mage2Base():\n\tdef onBlast(self):\n\t\tpass\n');
      try {
        const location = await probe(p(flatRoot, 'entity_defs', 'Mage2.def'), '<onBlast>', provider);
        expect(location?.uri.fsPath).toBe(p(tmplRoot, 'scripts', 'Mage2.py'));
        expect(location?.range.start.line).toBe(1);
      } finally {
        fs.rmSync(p(flatRoot, 'entity_defs'), { recursive: true, force: true });
        fs.rmSync(p(tmplRoot, 'scripts', 'Mage2.py'), { force: true });
      }
    });
  });

  it('ClientMethods 全空 → 提示列出 bots 目录与平铺路径', async () => {
    await withFolders(async () => {
      messages.info.length = 0;
      const location = await probe(heroDef(), '<onGone>', provider);
      expect(location?.uri.fsPath).toBe(p(tmplRoot, 'scripts', 'entities.xml'));
      expect(messages.info.some(entry => entry.includes('onGone') && entry.includes('bots/Hero.py'))).toBe(true);
      expect(messages.info.some(entry => entry.includes('scripts/Hero.py'))).toBe(true);
    });
  });
});

describe('角色目录下嵌套的 interfaces/ 与 components/(用户实测布局)', () => {
  // 用户 2026-10-12 实测:server_assets/scripts/ 下接口脚本嵌在角色目录里
  // (base/interfaces/Interface_Activity.py),组件脚本在角色目录下 components/;
  // 且要求角色配对——BaseApp 的 def 跳 base、CellApp 的 def 跳 cell。此前
  // findInterfaceScriptFile 只查 scripts 根级 interfaces/、interface/,约定
  // 链也不查组件脚本,这两种形态都找不到。
  const provider = new KBEngineDefinitionProvider();
  const ifaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-nav-reg-iface-'));
  // 根 B:def 在自有 scripts 根下,组件脚本在另一工作区根(覆盖工作区布局臂)
  const ifaceRootB = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-nav-reg-iface-b-'));
  const scripts = (relative: string) => p(ifaceRoot, 'server_assets', 'scripts', ...relative.split('/'));
  const w = (relative: string, content: string): void => {
    fs.mkdirSync(path.dirname(scripts(relative)), { recursive: true });
    fs.writeFileSync(scripts(relative), content, 'utf8');
  };

  const gameDef = () => scripts('entity_defs/Game.def');
  // 直接调用口径:文档对象 target(字符串 target 的语义是工作区根,不是 def 路径)
  const gameDoc = () =>
    makeTextDocument(fs.readFileSync(gameDef(), 'utf8'), {
      fileName: gameDef(),
      languageId: 'kbengine-def'
    });
  const GAME_DEF = [
    '<root>',
    '\t<Properties>',
    '\t\t<gold>',
    '\t\t\t<Type>UINT32</Type>',
    '\t\t</gold>',
    '\t</Properties>',
    '\t<Components>',
    '\t\t<HP>',
    '\t\t\t<Type>HealthComp</Type>',
    '\t\t</HP>',
    '\t\t<Move>',
    '\t\t\t<Type>Motion</Type>',
    '\t\t</Move>',
    '\t</Components>',
    '\t<Interfaces>',
    '\t\t<interface>Activity</interface>',
    '\t\t<interface>Health</interface>',
    '\t\t<interface>Quest</interface>',
    '\t</Interfaces>',
    '\t<BaseMethods>',
    '\t\t<onCreate>',
    '\t\t</onCreate>',
    '\t\t<startActivity>',
    '\t\t</startActivity>',
    '\t\t<apply>',
    '\t\t</apply>',
    '\t\t<quest>',
    '\t\t</quest>',
    '\t</BaseMethods>',
    '\t<CellMethods>',
    '\t\t<onStep>',
    '\t\t</onStep>',
    '\t\t<heal>',
    '\t\t</heal>',
    '\t\t<move>',
    '\t\t</move>',
    '\t</CellMethods>',
    '</root>'
  ].join('\n');
  const BASE_GAME_PY = ['class Game:', '\tdef onCreate(self):', '\t\tpass', ''].join('\n');
  const CELL_GAME_PY = ['class Game:', '\tdef onStep(self):', '\t\tpass', ''].join('\n');
  const IFACE_ACTIVITY_PY = ['class Activity:', '\tdef startActivity(self):', '\t\tpass', ''].join('\n');
  const IFACE_HEALTH_PY = ['class Health:', '\tdef heal(self):', '\t\tpass', ''].join('\n');
  const COMP_HEALTH_PY = ['class HealthComp:', '\tdef apply(self):', '\t\tpass', ''].join('\n');
  const COMP_MOTION_PY = ['class Motion:', '\tdef move(self):', '\t\tpass', ''].join('\n');
  // 根级同名接口脚本:同带 def startActivity,用于证明角色嵌套目录优先于
  // scripts 根级(命中若落到这里说明优先级反了)
  const ROOT_IFACE_ACTIVITY_PY = ['class Activity:', '\tdef startActivity(self):', '\t\tpass', ''].join('\n');
  // 无角色嵌套副本的接口:只能落 scripts 根级
  const ROOT_IFACE_QUEST_PY = ['class Quest:', '\tdef quest(self):', '\t\tpass', ''].join('\n');
  const ENTITIES_XML_IFACE = [
    '<root>',
    '\t<Game hasBase="true" hasCell="true"/>',
    '</root>',
    ''
  ].join('\n');
  // 根 B 的 def:组件脚本在另一工作区根,验证工作区布局臂
  const SPLITTER_DEF = [
    '<root>',
    '\t<Components>',
    '\t\t<HP>',
    '\t\t\t<Type>HealthComp</Type>',
    '\t\t</HP>',
    '\t</Components>',
    '\t<BaseMethods>',
    '\t\t<apply>',
    '\t\t</apply>',
    '\t</BaseMethods>',
    '</root>'
  ].join('\n');

  beforeAll(() => {
    w('entities.xml', ENTITIES_XML_IFACE);
    w('entity_defs/Game.def', GAME_DEF);
    w('base/Game.py', BASE_GAME_PY);
    w('cell/Game.py', CELL_GAME_PY);
    w('base/interfaces/Interface_Activity.py', IFACE_ACTIVITY_PY);
    w('cell/interfaces/Interface_Health.py', IFACE_HEALTH_PY);
    w('base/components/HealthComp.py', COMP_HEALTH_PY);
    w('cell/components/Motion.py', COMP_MOTION_PY);
    w('interfaces/Activity.py', ROOT_IFACE_ACTIVITY_PY);
    w('interfaces/Quest.py', ROOT_IFACE_QUEST_PY);
    // 根 B 只有 def,没有脚本(def 相对臂不命中)
    fs.mkdirSync(p(ifaceRootB, 'entity_defs'), { recursive: true });
    fs.writeFileSync(
      p(ifaceRootB, 'entity_defs', 'Splitter.def'),
      SPLITTER_DEF,
      'utf8'
    );
    // 根 B 的散落 def(不在 entity_defs 下):def 相对臂整体跳过,
    // 由工作区布局臂命中另一根的组件脚本
    fs.mkdirSync(p(ifaceRootB, 'loose'), { recursive: true });
    fs.writeFileSync(p(ifaceRootB, 'loose', 'SoloComp.def'), SPLITTER_DEF, 'utf8');
  });

  afterAll(() => {
    fs.rmSync(ifaceRoot, { recursive: true, force: true });
    fs.rmSync(ifaceRootB, { recursive: true, force: true });
  });

  const withFolders = async (run: () => Promise<void>): Promise<void> => {
    const folders = stubWorkspace.workspaceFolders;
    stubWorkspace.workspaceFolders = [
      ...folders,
      { uri: Uri.file(ifaceRoot), name: 'iface', index: folders.length },
      { uri: Uri.file(ifaceRootB), name: 'iface-b', index: folders.length + 1 }
    ];
    try {
      await run();
    } finally {
      stubWorkspace.workspaceFolders = folders;
    }
  };

  it('BaseMethods 接口方法落到 base/interfaces/Interface_Activity.py 的 def 行', async () => {
    await withFolders(async () => {
      const location = await probe(gameDef(), '<startActivity>', provider);
      expect(location?.uri.fsPath).toBe(
        p(ifaceRoot, 'server_assets', 'scripts', 'base', 'interfaces', 'Interface_Activity.py')
      );
      expect(location?.range.start.line).toBe(1);
    });
  });

  it('CellMethods 接口方法落到 cell/interfaces/(角色配对:CellApp 跳 cell)', async () => {
    await withFolders(async () => {
      const location = await probe(gameDef(), '<heal>', provider);
      expect(location?.uri.fsPath).toBe(
        p(ifaceRoot, 'server_assets', 'scripts', 'cell', 'interfaces', 'Interface_Health.py')
      );
      expect(location?.range.start.line).toBe(1);
    });
  });

  it('角色嵌套目录优先于 scripts 根级同名接口脚本', async () => {
    await withFolders(async () => {
      const location = await probe(gameDef(), '<startActivity>', provider);
      expect(location?.uri.fsPath).not.toBe(
        p(ifaceRoot, 'server_assets', 'scripts', 'interfaces', 'Activity.py')
      );
    });
  });

  it('角色嵌套整体缺失 → 回落 scripts 根级接口脚本', async () => {
    await withFolders(async () => {
      const location = await probe(gameDef(), '<quest>', provider);
      expect(location?.uri.fsPath).toBe(
        p(ifaceRoot, 'server_assets', 'scripts', 'interfaces', 'Quest.py')
      );
      expect(location?.range.start.line).toBe(1);
    });
  });

  it('BaseMethods 组件方法落到 base/components/ 的 def 行', async () => {
    await withFolders(async () => {
      const location = await probe(gameDef(), '<apply>', provider);
      expect(location?.uri.fsPath).toBe(
        p(ifaceRoot, 'server_assets', 'scripts', 'base', 'components', 'HealthComp.py')
      );
      expect(location?.range.start.line).toBe(1);
    });
  });

  it('CellMethods 组件方法落到 cell/components/(角色配对)', async () => {
    await withFolders(async () => {
      const location = await probe(gameDef(), '<move>', provider);
      expect(location?.uri.fsPath).toBe(
        p(ifaceRoot, 'server_assets', 'scripts', 'cell', 'components', 'Motion.py')
      );
      expect(location?.range.start.line).toBe(1);
    });
  });

  it('跨根:组件脚本在另一工作区根时走工作区布局臂命中', async () => {
    await withFolders(async () => {
      const location = await probe(p(ifaceRootB, 'entity_defs', 'Splitter.def'), '<apply>', provider);
      expect(location?.uri.fsPath).toBe(
        p(ifaceRoot, 'server_assets', 'scripts', 'base', 'components', 'HealthComp.py')
      );
      expect(location?.range.start.line).toBe(1);
    });
  });

  it('def 不在 defs 目录时跳过 def 相对臂,由工作区布局臂命中', async () => {
    await withFolders(async () => {
      const location = await probe(p(ifaceRootB, 'loose', 'SoloComp.def'), '<apply>', provider);
      expect(location?.uri.fsPath).toBe(
        p(ifaceRoot, 'server_assets', 'scripts', 'base', 'components', 'HealthComp.py')
      );
      expect(location?.range.start.line).toBe(1);
    });
  });

  it('属性链不区分角色:实体脚本优先,接口脚本按无角色口径解析', async () => {
    await withFolders(async () => {
      const location = await probe(gameDef(), '<gold>', provider);
      expect(location?.uri.fsPath).toBe(p(ifaceRoot, 'server_assets', 'scripts', 'base', 'Game.py'));
      expect(location?.range.start.line).toBe(0);
    });
  });

  it('findInterfaceScriptFile 按段角色解析嵌套目录与 Interface_ 前缀变体', () => {
    expect(findInterfaceScriptFile('Activity', gameDoc(), 'base')).toBe(
      p(ifaceRoot, 'server_assets', 'scripts', 'base', 'interfaces', 'Interface_Activity.py')
    );
    expect(findInterfaceScriptFile('Health', gameDoc(), 'cell')).toBe(
      p(ifaceRoot, 'server_assets', 'scripts', 'cell', 'interfaces', 'Interface_Health.py')
    );
    expect(findInterfaceScriptFile('Nobody', gameDoc(), 'base')).toBeNull();
  });

  it('findComponentScriptFile 按角色解析组件脚本,缺失如实 null', () => {
    expect(findComponentScriptFile('HealthComp', 'base', gameDoc())).toBe(
      p(ifaceRoot, 'server_assets', 'scripts', 'base', 'components', 'HealthComp.py')
    );
    expect(findComponentScriptFile('Motion', 'cell', gameDoc())).toBe(
      p(ifaceRoot, 'server_assets', 'scripts', 'cell', 'components', 'Motion.py')
    );
    expect(findComponentScriptFile('Missing', 'base', gameDoc())).toBeNull();
  });

  it('findComponentScriptFile 字符串 target 语义是工作区根,缺 target 走全部根', () => {
    expect(findComponentScriptFile('Motion', 'cell', ifaceRoot)).toBe(
      p(ifaceRoot, 'server_assets', 'scripts', 'cell', 'components', 'Motion.py')
    );
    expect(findComponentScriptFile('Missing', 'base')).toBeNull();
  });

  it('组件槽取 <Type> 值作脚本候选名;无 <Type> 或空 <Type> 的槽不产生候选', () => {
    const semantics = parseDefFileSemantics([
      '<root>',
      '\t<Components>',
      '\t\t<HP>',
      '\t\t\t<Type>HealthComp</Type>',
      '\t\t</HP>',
      '\t\t<Broken>',
      '\t\t</Broken>',
      '\t\t<Empty>',
      '\t\t\t<Type></Type>',
      '\t\t</Empty>',
      '\t</Components>',
      '</root>'
    ].join('\n'));
    expect(semantics?.componentTypeNames).toEqual(['HealthComp']);
    expect(semantics?.interfaceNames).toEqual([]);
  });
});
