import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KBEngineDefinitionProvider } from '../src/languageProviders';
import { messages } from './fake-vscode/windowState';
import { Position, Uri, makeTextDocument, workspace as stubWorkspace } from './helpers/vscodeStub';

// 真实复现:拿 kbengine 官方 SDK 模板当被测工程(只读复制到临时目录),
// 不用测试自造的 fixture —— 用户实测「CellMethods 函数字段无法导航」。
const KBE_TEMPLATES = path.join(
  os.homedir(),
  'workspaces/kbengine/kbe/res/sdk_templates/server/python_assets/scripts'
);

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

describe('根因回归:方法未实现时显式提示(真修单:不许无声 null)', () => {
  it('角色脚本缺失时 F12 给出期望实现位置提示', async () => {
    const provider = new KBEngineDefinitionProvider();
    const defPath = path.join(root, 'scripts/entity_defs/Account.def');
    const def = fs.readFileSync(defPath, 'utf8');
    const patched = def.replace(/<CellMethods>/, '<CellMethods>\n\t\t<onGhost>\n\t\t</onGhost>');
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
