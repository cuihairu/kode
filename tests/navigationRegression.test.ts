import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KBEngineDefinitionProvider } from '../src/languageProviders';
import { findEntityScriptFile, findInterfaceScriptFile } from '../src/definitionWorkspace';
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
// 单风格布局无回归,本文件锁定的是上述缺口形态。

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
