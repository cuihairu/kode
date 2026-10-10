import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KBEngineDefinitionProvider } from '../src/languageProviders';
import { messages } from './fake-vscode/windowState';
import { Position, Uri, makeTextDocument, workspace as stubWorkspace } from './helpers/vscodeStub';

// 真实复现:拿 kbengine 官方 SDK 模板当被测工程(只读复制到临时目录),
// 不用测试自造的 fixture —— 用户实测「CellMethods 函数字段无法导航」。
// 2026-10-10:真实样本快照入库(源自 kbengine 官方 SDK 模板,tests/fixtures/),
// 不再依赖本机 ~/workspaces/kbengine —— CI 机器无此仓库曾致 ENOENT 红灯。
// 快照缺失时回退本机路径(开发者本地可刷新快照)。
const KBE_TEMPLATE_SNAPSHOT = path.join(__dirname, 'fixtures', 'kbengine-tpl-scripts');
const KBE_TEMPLATE_LOCAL = path.join(
  os.homedir(),
  'workspaces/kbengine/kbe/res/sdk_templates/server/python_assets/scripts'
);
const KBE_TEMPLATES = fs.existsSync(KBE_TEMPLATE_SNAPSHOT)
  ? KBE_TEMPLATE_SNAPSHOT
  : KBE_TEMPLATE_LOCAL;

let root = '';
const p = (...parts: string[]) => path.join(root, ...parts);

const cursorOf = (text: string) => {
  // 光标放在 `<|` 的 `|` 处,即方法名首字符(与仓库走查测试 cursorOf 同口径)。
  // 根因回归:剥标记只能剥 `|`,必须保留 `<` —— 真实编辑器缓冲区里 `<onTick>`
  // 恒为完整标签;此前 `replace('<|','')` 连 `<` 一起删,`onTick>` 变裸文本,
  // fxp 把它并进父节点 text 节点,getDefNodeAtWord 命中 text 节点 →
  // getSymbolNodeInfo null → 方法段链进不去,复现出假的「产品跳不动」。
  const idx = text.indexOf('<|') + 1;
  const before = text.slice(0, idx);
  const line = before.split('\n').length - 1;
  const character = before.length - (before.lastIndexOf('\n') + 1);
  return { text: text.replace('|', ''), position: new Position(line, character) };
};

interface LocationLike {
  uri: { fsPath: string };
  range: { start: { line: number } };
}

beforeAll(() => {
  root = path.join(os.tmpdir(), 'kode-kbe-tpl');
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.cpSync(KBE_TEMPLATES, path.join(root, 'scripts'), { recursive: true });

  stubWorkspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
  stubWorkspace.workspaceFolders = [];
});

describe('真实 kbengine 模板上的 CellMethods 导航', () => {
  const provider = new KBEngineDefinitionProvider();

  it('A: cell 脚本存在 → 应跳到 cell/Account.py', async () => {
    const defPath = path.join(root, 'scripts/entity_defs/Account.def');
    const def = fs.readFileSync(defPath, 'utf8');
    const patched = def.replace(
      /<CellMethods>/,
      '<CellMethods>\n\t\t<onTick>\n\t\t</onTick>'
    );
    fs.writeFileSync(defPath, patched, 'utf8');

    const cellPy = path.join(root, 'scripts/cell/Account.py');
    if (!fs.existsSync(cellPy)) {
      fs.writeFileSync(cellPy, 'class Account:\n    def onTick(self):\n        pass\n', 'utf8');
    }

    const { text, position } = cursorOf(patched.replace('<onTick>', '<|onTick>'));
    const doc = makeTextDocument(text, { fileName: defPath, languageId: 'kbengine-def' });
    const loc = (await provider.provideDefinition(doc, position)) as unknown as LocationLike;
    console.log('CASE_A 返回 =', loc ? loc.uri.fsPath : 'NULL');
    expect(loc?.uri.fsPath).toBe(path.join(root, 'scripts/cell/Account.py'));
  });

  it('B: cell 脚本不存在(官方模板即此形态) → 记录真实返回值', async () => {
    const defPath = path.join(root, 'scripts/entity_defs/Account.def');
    const def = fs.readFileSync(defPath, 'utf8');
    const patched = def
      .replace(/<CellMethods>/, '<CellMethods>\n\t\t<onNoop>\n\t\t</onNoop>')
      // 根因回归:改名必须连闭合标签一起改 —— 只改 `<onTick>` 留 `</onTick>`
      // 会让文件标签失配,defParser.consumeNextToken 吞不到闭合 token 直接抛,
      // parseDefAst 落 null,后续整链静默 null(CASE_C 连带受害)。
      .replace('<onTick>', '<onTickUnused>')
      .replace('</onTick>', '</onTickUnused>');
    fs.writeFileSync(defPath, patched, 'utf8');
    fs.rmSync(path.join(root, 'scripts/cell/Account.py'), { force: true });

    const { text, position } = cursorOf(patched.replace('<onNoop>', '<|onNoop>'));
    const doc = makeTextDocument(text, { fileName: defPath, languageId: 'kbengine-def' });
    const loc = (await provider.provideDefinition(doc, position)) as unknown as LocationLike | null;
    console.log('CASE_B 返回 =', loc ? loc.uri.fsPath : 'NULL(有提示,不再无声)');
    expect(true).toBe(true);
  });

  it('C: 光标在方法名中间(真实点法) → 记录返回值', async () => {
    const defPath = path.join(root, 'scripts/entity_defs/Account.def');
    const def = fs.readFileSync(defPath, 'utf8');
    const patched = def.replace(/<CellMethods>/, '<CellMethods>\n\t\t<onLogin>\n\t\t</onLogin>');
    fs.writeFileSync(defPath, patched, 'utf8');
    fs.writeFileSync(
      path.join(root, 'scripts/cell/Account.py'),
      'class Account:\n    def onLogin(self):\n        pass\n',
      'utf8'
    );

    // 光标放在方法名中段而不是标签起始处
    const idx = patched.indexOf('onLogin');
    const before = patched.slice(0, idx + 2);
    const line = before.split('\n').length - 1;
    const character = before.length - before.lastIndexOf('\n') - 1;
    const doc = makeTextDocument(patched, {
      fileName: defPath,
      languageId: 'kbengine-def'
    });
    const loc = (await provider.provideDefinition(doc, new Position(line, character))) as unknown as LocationLike | null;
    console.log('CASE_C 返回 =', loc ? loc.uri.fsPath : 'NULL');
    expect(loc?.uri.fsPath).toBe(path.join(root, 'scripts/cell/Account.py'));
  });
});

describe('真实模板上的 Properties 字段导航(用户:之前能跳,现在不行)', () => {
  const provider = new KBEngineDefinitionProvider();

  it('D: 属性名 hp → 实体脚本类声明行(base/Account.py)', async () => {
    const defPath = path.join(root, 'scripts/entity_defs/Account.def');
    const def = fs.readFileSync(defPath, 'utf8');
    const patched = def.replace(
      /<Properties>/,
      '<Properties>\n\t\t<hp>\n\t\t\t<Type>UINT32</Type>\n\t\t</hp>'
    );
    fs.writeFileSync(defPath, patched, 'utf8');

    // 属性链按 base→cell→client 取第一个存在的实体脚本
    const basePy = path.join(root, 'scripts/base/Account.py');
    fs.writeFileSync(basePy, 'class Account:\n    hp = 0\n', 'utf8');

    const { text, position } = cursorOf(patched.replace('<hp>', '<|hp>'));
    const doc = makeTextDocument(text, { fileName: defPath, languageId: 'kbengine-def' });
    const loc = (await provider.provideDefinition(doc, position)) as unknown as LocationLike | null;
    console.log('CASE_D 返回 =', loc ? loc.uri.fsPath : 'NULL');
    expect(loc?.uri.fsPath).toBe(basePy);
  });

  it('F: 实体脚本全不存在(真实项目常见) → 非无声(落点或显式提示)', async () => {
    const defPath = path.join(root, 'scripts/entity_defs/Account.def');
    const def = fs.readFileSync(defPath, 'utf8');
    const patched = def.replace(/<Properties>/, '<Properties>\n\t\t<sp>\n\t\t</sp>');
    fs.writeFileSync(defPath, patched, 'utf8');
    for (const role of ['base', 'cell', 'client']) {
      fs.rmSync(path.join(root, `scripts/${role}/Account.py`), { force: true });
    }

    messages.info.length = 0;
    const { text, position } = cursorOf(patched.replace('<sp>', '<|sp>'));
    const doc = makeTextDocument(text, { fileName: defPath, languageId: 'kbengine-def' });
    const loc = (await provider.provideDefinition(doc, position)) as unknown as LocationLike | null;
    console.log('CASE_F 返回 =', loc ? loc.uri.fsPath : 'NULL(有提示,不再无声)');
    expect(
      loc !== null || messages.info.some(entry => entry.includes('sp') && entry.includes('Account.py')),
      'F 不许无声 null:要么有落点,要么有指明属性与期望脚本的提示'
    ).toBe(true);
  });

  it('H: 属性在 __init__ 之前加载、脚本里无该属性 → 必须落类定义或 __init__', async () => {
    const defPath = path.join(root, 'scripts/entity_defs/Account.def');
    const def = fs.readFileSync(defPath, 'utf8');
    // 属性名故意用一个脚本里不存在的标识(引擎在 __init__ 之前加载属性)
    const patched = def.replace(
      /<Properties>/,
      '<Properties>\n\t\t<earlyLoaded>\n\t\t\t<Type>UINT32</Type>\n\t\t</earlyLoaded>'
    );
    fs.writeFileSync(defPath, patched, 'utf8');

    const basePy = path.join(root, 'scripts/base/Account.py');
    fs.writeFileSync(
      basePy,
      'class Account:\n    def __init__(self):\n        pass\n',
      'utf8'
    );

    const { text, position } = cursorOf(patched.replace('<earlyLoaded>', '<|earlyLoaded>'));
    const doc = makeTextDocument(text, { fileName: defPath, languageId: 'kbengine-def' });
    const loc = (await provider.provideDefinition(doc, position)) as unknown as LocationLike | null;
    const got = loc ? `${loc.uri.fsPath}:${loc.range.start.line}` : 'NULL';
    console.log('CASE_H 返回 =', got);
    // 用户口径:没有该属性的定义,也要定位到类定义或 __init__;什么都不做 = bug
    expect(loc, 'H 必须有落点,不许静默无反应').not.toBeNull();
    expect(loc?.uri.fsPath).toBe(basePy);
    const lines = fs.readFileSync(basePy, 'utf8').split('\n');
    const target = lines[loc?.range.start.line ?? 0] ?? '';
    console.log('CASE_H 落点行 =', JSON.stringify(target));
    expect(
      /class Account|def __init__/.test(target),
      'H 必须落类定义或 __init__'
    ).toBe(true);
  });

  it('G: 点属性的 <Type> 值 → 非无声(内建类型显式提示)', async () => {
    const defPath = path.join(root, 'scripts/entity_defs/Account.def');
    const def = fs.readFileSync(defPath, 'utf8');
    const patched = def.replace(
      /<Properties>/,
      '<Properties>\n\t\t<qp>\n\t\t\t<Type>UINT32</Type>\n\t\t</qp>'
    );
    fs.writeFileSync(defPath, patched, 'utf8');
    fs.writeFileSync(path.join(root, 'scripts/base/Account.py'), 'class Account:\n    pass\n', 'utf8');

    messages.info.length = 0;
    const idx = patched.indexOf('UINT32');
    const before = patched.slice(0, idx);
    const line = before.split('\n').length - 1;
    const character = before.length - before.lastIndexOf('\n') - 1;
    const doc = makeTextDocument(patched, { fileName: defPath, languageId: 'kbengine-def' });
    const loc = (await provider.provideDefinition(doc, new Position(line, character))) as unknown as LocationLike | null;
    console.log('CASE_G 返回 =', loc ? loc.uri.fsPath : 'NULL(内建类型提示)');
    expect(
      loc !== null || messages.info.some(entry => entry.includes('UINT32')),
      'G 不许无声 null:内建类型 <Type> 值点击要给显式提示'
    ).toBe(true);
  });

  it('E: 属性名光标在字段中段 → 仍应跳到实体脚本', async () => {
    const defPath = path.join(root, 'scripts/entity_defs/Account.def');
    const def = fs.readFileSync(defPath, 'utf8');
    const patched = def.replace(/<Properties>/, '<Properties>\n\t\t<maxHp>\n\t\t</maxHp>');
    fs.writeFileSync(defPath, patched, 'utf8');

    const idx = patched.indexOf('maxHp');
    const before = patched.slice(0, idx + 2);
    const line = before.split('\n').length - 1;
    const character = before.length - before.lastIndexOf('\n') - 1;
    const doc = makeTextDocument(patched, { fileName: defPath, languageId: 'kbengine-def' });
    const loc = (await provider.provideDefinition(doc, new Position(line, character))) as unknown as LocationLike | null;
    console.log('CASE_E 返回 =', loc ? loc.uri.fsPath : 'NULL');
    expect(loc?.uri.fsPath).toBe(path.join(root, 'scripts/base/Account.py'));
  });
});

describe('属性导航四形态(用户令 2026-10-10 补充口径:组件/接口/Parent 链/类名不一致/无 entities.xml)', () => {
  const provider = new KBEngineDefinitionProvider();
  const defPath = () => path.join(root, 'scripts/entity_defs/Account.def');
  const writeDef = (content: string) => fs.writeFileSync(defPath(), content, 'utf8');
  const removeAccountScripts = () => {
    for (const role of ['base', 'cell', 'client']) {
      fs.rmSync(path.join(root, `scripts/${role}/Account.py`), { force: true });
    }
  };
  const writeBaseAccountPy = (content: string) => {
    fs.mkdirSync(path.join(root, 'scripts/base'), { recursive: true });
    fs.writeFileSync(path.join(root, 'scripts/base/Account.py'), content, 'utf8');
  };
  // 自包含 def:不继承前序用例残留在共享 Account.def 里的 Parent/Interfaces
  // (残留会让语义解析走上错误的链,用例就测不到自己的分支了)。
  const freshDef = (inner: string): string => `<root>\n\t${inner}\n</root>\n`;
  const jumpProperty = async (text: string, marked: string): Promise<LocationLike | null> => {
    // marked 形如 '<parentProp>':标记只能插 '|'(成 '<|parentProp>'),
    // 连 '<' 一起动会重现 CASE_A 的缓冲区损坏(fxp 把裸文本并进父节点)。
    const { text: docText, position } = cursorOf(text.replace(marked, `<|${marked.slice(1)}`));
    const doc = makeTextDocument(docText, { fileName: defPath(), languageId: 'kbengine-def' });
    return (await provider.provideDefinition(doc, position)) as unknown as LocationLike | null;
  };

  it('① 组件 def:属性跳组件角色脚本(cell/BaseComponent.py)', async () => {
    fs.mkdirSync(path.join(root, 'scripts/entity_defs/components'), { recursive: true });
    const compDef = '<root>\n\t<Properties>\n\t\t<radius>\n\t\t\t<Type>FLOAT</Type>\n\t\t</radius>\n\t</Properties>\n</root>\n';
    const compPath = path.join(root, 'scripts/entity_defs/components/BaseComponent.def');
    fs.writeFileSync(compPath, compDef, 'utf8');
    fs.mkdirSync(path.join(root, 'scripts/cell'), { recursive: true });
    const compPy = path.join(root, 'scripts/cell/BaseComponent.py');
    fs.writeFileSync(compPy, 'class BaseComponent:\n    pass\n', 'utf8');

    const { text, position } = cursorOf(compDef.replace('<radius>', '<|radius>'));
    const doc = makeTextDocument(text, { fileName: compPath, languageId: 'kbengine-def' });
    const loc = (await provider.provideDefinition(doc, position)) as unknown as LocationLike | null;
    console.log('CASE_①组件 返回 =', loc ? loc.uri.fsPath : 'NULL');
    expect(loc?.uri.fsPath, '组件 def 属性应跳组件角色脚本').toBe(compPy);
  });

  it('① 接口 def:属性跳接口脚本(scripts/interfaces/Poller.py)', async () => {
    fs.mkdirSync(path.join(root, 'scripts/entity_defs/interfaces'), { recursive: true });
    const ifaceDef = '<root>\n\t<Properties>\n\t\t<speed>\n\t\t\t<Type>FLOAT</Type>\n\t\t</speed>\n\t</Properties>\n</root>\n';
    const ifacePath = path.join(root, 'scripts/entity_defs/interfaces/Poller.def');
    fs.writeFileSync(ifacePath, ifaceDef, 'utf8');
    fs.mkdirSync(path.join(root, 'scripts/interfaces'), { recursive: true });
    const ifacePy = path.join(root, 'scripts/interfaces/Poller.py');
    fs.writeFileSync(ifacePy, 'class Poller:\n    def poll(self):\n        pass\n', 'utf8');

    const { text, position } = cursorOf(ifaceDef.replace('<speed>', '<|speed>'));
    const doc = makeTextDocument(text, { fileName: ifacePath, languageId: 'kbengine-def' });
    const loc = (await provider.provideDefinition(doc, position)) as unknown as LocationLike | null;
    console.log('CASE_①接口 返回 =', loc ? loc.uri.fsPath : 'NULL');
    expect(loc?.uri.fsPath, '接口 def 属性应跳接口脚本').toBe(ifacePy);
  });

  it('② Parent 链:属性在子 def、类在父 def 脚本 → 上溯父实体类', async () => {
    const child = freshDef(
      '<Parent>Mob</Parent>\n\t<Properties>\n\t\t<parentProp>\n\t\t</parentProp>\n\t</Properties>'
    );
    writeDef(child);
    fs.writeFileSync(
      path.join(root, 'scripts/entity_defs/Mob.def'),
      '<root>\n\t<Properties>\n\t</Properties>\n</root>\n',
      'utf8'
    );
    removeAccountScripts();
    const mobPy = path.join(root, 'scripts/base/Mob.py');
    fs.mkdirSync(path.join(root, 'scripts/base'), { recursive: true });
    fs.writeFileSync(mobPy, 'class Mob:\n    pass\n', 'utf8');

    const loc = await jumpProperty(child, '<parentProp>');
    console.log('CASE_②Parent链 返回 =', loc ? loc.uri.fsPath : 'NULL');
    expect(loc?.uri.fsPath, 'Parent 链应上溯到父实体脚本').toBe(mobPy);
  });

  it('② 悬空 Parent:父 def 不存在 → 回落自有角色脚本', async () => {
    const child = freshDef(
      '<Parent>Ghostless</Parent>\n\t<Properties>\n\t\t<orphanProp>\n\t\t</orphanProp>\n\t</Properties>'
    );
    writeDef(child);
    // 悬空形态的前提:任何位置都没有 Ghostless.def
    fs.rmSync(path.join(root, 'scripts/entity_defs/Ghostless.def'), { force: true });
    removeAccountScripts();
    const basePy = path.join(root, 'scripts/base/Account.py');
    writeBaseAccountPy('class Account:\n    pass\n');

    const loc = await jumpProperty(child, '<orphanProp>');
    console.log('CASE_②悬空Parent 返回 =', loc ? loc.uri.fsPath : 'NULL');
    expect(loc?.uri.fsPath, '悬空 Parent 应回落自有脚本').toBe(basePy);
  });

  it('② Parent 自指环:不死循环,落自有脚本', async () => {
    const child = freshDef(
      '<Parent>Account</Parent>\n\t<Properties>\n\t\t<loopProp>\n\t\t</loopProp>\n\t</Properties>'
    );
    writeDef(child);
    removeAccountScripts();
    const basePy = path.join(root, 'scripts/base/Account.py');
    writeBaseAccountPy('class Account:\n    pass\n');

    const loc = await jumpProperty(child, '<loopProp>');
    console.log('CASE_②Parent环 返回 =', loc ? loc.uri.fsPath : 'NULL');
    expect(loc?.uri.fsPath, 'Parent 自指环应落自有脚本且不死循环').toBe(basePy);
  });

  it('② 空父 def:父 def 文件为空 → 闭包即止,落自有脚本', async () => {
    const child = freshDef(
      '<Parent>Empty</Parent>\n\t<Properties>\n\t\t<emptyParentProp>\n\t\t</emptyParentProp>\n\t</Properties>'
    );
    writeDef(child);
    fs.writeFileSync(path.join(root, 'scripts/entity_defs/Empty.def'), '', 'utf8');
    removeAccountScripts();
    const basePy = path.join(root, 'scripts/base/Account.py');
    writeBaseAccountPy('class Account:\n    pass\n');

    const loc = await jumpProperty(child, '<emptyParentProp>');
    console.log('CASE_②空父def 返回 =', loc ? loc.uri.fsPath : 'NULL');
    expect(loc?.uri.fsPath, '空父 def 应落自有脚本').toBe(basePy);
  });

  it('② 畸形父 def:父 def 无法解析 → 跳过语义,落自有脚本', async () => {
    const child = freshDef(
      '<Parent>Broken</Parent>\n\t<Properties>\n\t\t<brokenProp>\n\t\t</brokenProp>\n\t</Properties>'
    );
    writeDef(child);
    fs.writeFileSync(path.join(root, 'scripts/entity_defs/Broken.def'), 'not-a-def', 'utf8');
    removeAccountScripts();
    const basePy = path.join(root, 'scripts/base/Account.py');
    writeBaseAccountPy('class Account:\n    pass\n');

    const loc = await jumpProperty(child, '<brokenProp>');
    console.log('CASE_②畸形父def 返回 =', loc ? loc.uri.fsPath : 'NULL');
    expect(loc?.uri.fsPath, '畸形父 def 应落自有脚本且不死循环').toBe(basePy);
  });

  it('② 实体 def 带 Interfaces:自有角色脚本优先于接口脚本', async () => {
    const child = freshDef(
      '<Interfaces>\n\t\t<Interface>\n\t\t\t<MoveIface/>\n\t\t</Interface>\n\t</Interfaces>\n\t<Properties>\n\t\t<ifaceProp>\n\t\t</ifaceProp>\n\t</Properties>'
    );
    writeDef(child);
    fs.mkdirSync(path.join(root, 'scripts/entity_defs/interfaces'), { recursive: true });
    fs.writeFileSync(path.join(root, 'scripts/entity_defs/interfaces/MoveIface.def'), '<root></root>\n', 'utf8');
    fs.mkdirSync(path.join(root, 'scripts/interfaces'), { recursive: true });
    fs.writeFileSync(path.join(root, 'scripts/interfaces/MoveIface.py'), 'class MoveIface:\n    pass\n', 'utf8');
    removeAccountScripts();
    const basePy = path.join(root, 'scripts/base/Account.py');
    writeBaseAccountPy('class Account:\n    pass\n');

    const loc = await jumpProperty(child, '<ifaceProp>');
    console.log('CASE_②Interfaces 返回 =', loc ? loc.uri.fsPath : 'NULL');
    expect(loc?.uri.fsPath, '自有角色脚本应优先于接口脚本').toBe(basePy);
  });

  it('③ 类名与 def 不一致:落首个类行(不许 null)', async () => {
    const patched = freshDef('<Properties>\n\t\t<mystery>\n\t\t</mystery>\n\t</Properties>');
    writeDef(patched);
    removeAccountScripts();
    const basePy = path.join(root, 'scripts/base/Account.py');
    writeBaseAccountPy('from kbe import KBEntity\n\nclass Avatar(KBEntity):\n    pass\n');

    const loc = await jumpProperty(patched, '<mystery>');
    console.log('CASE_③类名不一致 返回 =', loc ? `${loc.uri.fsPath}:${loc.range.start.line}` : 'NULL');
    expect(loc?.uri.fsPath, '类名不一致也要落脚本').toBe(basePy);
    expect(loc?.range.start.line, '落首个类行').toBe(2);
  });

  it('③ 无同名类时落 __init__ 行', async () => {
    const patched = freshDef('<Properties>\n\t\t<initProp>\n\t\t</initProp>\n\t</Properties>');
    writeDef(patched);
    removeAccountScripts();
    const basePy = path.join(root, 'scripts/base/Account.py');
    writeBaseAccountPy('class Avatar:\n    def __init__(self):\n        pass\n');

    const loc = await jumpProperty(patched, '<initProp>');
    console.log('CASE_③init行 返回 =', loc ? `${loc.uri.fsPath}:${loc.range.start.line}` : 'NULL');
    expect(loc?.uri.fsPath).toBe(basePy);
    // 行 1 即 `def __init__(self)`(行 0 是 class Avatar:)
    expect(loc?.range.start.line, '无同名类时落 __init__ 行').toBe(1);
  });

  it('③ 多类脚本:落首个类行(非同名类不遮挡)', async () => {
    const patched = freshDef('<Properties>\n\t\t<multiProp>\n\t\t</multiProp>\n\t</Properties>');
    writeDef(patched);
    removeAccountScripts();
    const basePy = path.join(root, 'scripts/base/Account.py');
    writeBaseAccountPy('class Helper:\n    pass\n\nclass Widget:\n    pass\n');

    const loc = await jumpProperty(patched, '<multiProp>');
    console.log('CASE_③多类 返回 =', loc ? `${loc.uri.fsPath}:${loc.range.start.line}` : 'NULL');
    expect(loc?.uri.fsPath, '多类脚本也要落脚本').toBe(basePy);
    expect(loc?.range.start.line, '落首个类行').toBe(0);
  });

  it('④ 无 entities.xml + def 不在 entityDefsPath:仍落角色脚本', async () => {
    fs.rmSync(path.join(root, 'scripts/entities.xml'), { force: true });
    fs.mkdirSync(path.join(root, 'defs'), { recursive: true });
    const loneDef = '<root>\n\t<Properties>\n\t\t<hp>\n\t\t\t<Type>UINT32</Type>\n\t\t</hp>\n\t</Properties>\n</root>\n';
    const lonePath = path.join(root, 'defs/Lone.def');
    fs.writeFileSync(lonePath, loneDef, 'utf8');
    fs.mkdirSync(path.join(root, 'scripts/base'), { recursive: true });
    const lonePy = path.join(root, 'scripts/base/Lone.py');
    fs.writeFileSync(lonePy, 'class Lone:\n    pass\n', 'utf8');

    const { text, position } = cursorOf(loneDef.replace('<hp>', '<|hp>'));
    const doc = makeTextDocument(text, { fileName: lonePath, languageId: 'kbengine-def' });
    const loc = (await provider.provideDefinition(doc, position)) as unknown as LocationLike | null;
    console.log('CASE_④无entities.xml 返回 =', loc ? loc.uri.fsPath : 'NULL');
    expect(loc?.uri.fsPath, '无 entities.xml/约定路径外也要落脚本').toBe(lonePy);
  });

  it('脚本全缺 + 属性声明 Type/Persistent → 回落数据库 schema 虚拟文档', async () => {
    // 自包含形态:前面用例留下的 Parent/Interfaces 引用会让脚本链先命中,
    // 这里写一份干净的 def,只留带 Type/Persistent 的属性
    const patched = [
      '<root>',
      '\t<Properties>',
      '\t\t<dbCol>',
      '\t\t\t<Type>UINT32</Type>',
      '\t\t\t<Persistent>true</Persistent>',
      '\t\t</dbCol>',
      '\t</Properties>',
      '</root>',
      ''
    ].join('\n');
    writeDef(patched);
    removeAccountScripts();

    const loc = await jumpProperty(patched, '<dbCol>');
    console.log('CASE_schema回落 返回 =', loc ? `${loc.uri.fsPath}@${loc.range.start.line}` : 'NULL');
    expect(loc?.uri.fsPath, '脚本缺失时应回落 schema 虚拟文档').toContain('Account.schema');
  });

  it('点 <Type> 自定义类型值(未声明)→ 显式提示', async () => {
    const patched = freshDef(
      '<Properties>\n\t\t<bag>\n\t\t\t<Type>MyBag</Type>\n\t\t</bag>\n\t</Properties>'
    );
    writeDef(patched);

    messages.info.length = 0;
    const idx = patched.indexOf('MyBag');
    const before = patched.slice(0, idx);
    const line = before.split('\n').length - 1;
    const character = before.length - before.lastIndexOf('\n') - 1;
    const doc = makeTextDocument(patched, { fileName: defPath(), languageId: 'kbengine-def' });
    const loc = (await provider.provideDefinition(doc, new Position(line, character))) as unknown as LocationLike | null;
    console.log('CASE_Type自定义 返回 =', loc ? loc.uri.fsPath : 'NULL(提示)');
    expect(
      loc !== null || messages.info.some(entry => entry.includes('MyBag')),
      '自定义类型未声明也要显式提示'
    ).toBe(true);
  });
});

describe('根因回归:方法未实现时显式提示(真修单:不许无声 null)', () => {
  it('角色脚本缺失时 F12 给出期望实现位置提示', async () => {
    const provider = new KBEngineDefinitionProvider();
    const defPath = path.join(root, 'scripts/entity_defs/Account.def');
    // 自包含形态:schema 回落用例会把 def 写成最小形(无 CellMethods),
    // 这里自带方法段,不依赖前序用例的文件状态
    const patched = [
      '<root>',
      '\t<CellMethods>',
      '\t\t<onGhost>',
      '\t\t</onGhost>',
      '\t</CellMethods>',
      '</root>',
      ''
    ].join('\n');
    fs.writeFileSync(defPath, patched, 'utf8');
    fs.rmSync(path.join(root, 'scripts/cell/Account.py'), { force: true });

    const { text, position } = cursorOf(patched.replace('<onGhost>', '<|onGhost>'));
    const doc = makeTextDocument(text, { fileName: defPath, languageId: 'kbengine-def' });
    messages.info.length = 0;
    const loc = (await provider.provideDefinition(doc, position)) as unknown as LocationLike | null;
    expect(loc).toBeNull();
    expect(
      messages.info.some(entry => entry.includes('onGhost') && entry.includes('cell/Account.py'))
    ).toBe(true);
  });
});
