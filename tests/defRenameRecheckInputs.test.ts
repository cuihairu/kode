import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EntityMappingManager } from '../src/entityMapping';
import { KBEngineRenameProvider } from '../src/languageProviders';
import { makeTextDocument, Position, Uri, workspace as stubWorkspace } from './helpers/vscodeStub';

// IDE-AUD-027(R2-F04):F2 版本检查早于异步 Python 引用查找——等待中目标
// v1→v2、插入一行仍返回旧第 2 行编辑范围。验收:目标/依赖 def/Python 在途
// 版本变化时重算或拒绝;不返回旧区间,不只对比上一次手势;关闭/取消同样
// 不发布晚到编辑。核心:异步查找结束后复核全部输入(不只靠 NAV-010 的上
// 一手势对比),输入在等待期间漂移即拒绝,不发布旧区间。

// —— 工作区 A:Hero/Monster(跨文件 def 编辑面,复用 defRenameVersion 结构)
const HERO_DEF = [
  '<root>',
  '  <Properties>',
  '    <hp> <Type> UINT32 </Type> </hp>',
  '  </Properties>',
  '</root>',
  ''
].join('\n');

const MONSTER_DEF_V2 = [
  '<root>',
  '  <Parent> Hero </Parent>',
  '  <Properties>',
  '    <hp> <Type> UINT16 </Type> </hp>',
  '  </Properties>',
  '</root>',
  ''
].join('\n');

const MONSTER_DEF_V3 = [
  '<root>',
  '  <Parent> Hero </Parent>',
  '  <!-- line added during rename -->',
  '  <Properties>',
  '    <hp> <Type> UINT16 </Type> </hp>',
  '  </Properties>',
  '</root>',
  ''
].join('\n');

// —— 工作区 B:Avatar(def)+ Avatar.py(属性 self.hp 访问,复用 NAV-011 结构)
const AVATAR_DEF = [
  '<root>',
  '  <Properties>',
  '    <hp>',
  '      <Type>UINT32</Type>',
  '    </hp>',
  '  </Properties>',
  '</root>',
  ''
].join('\n');

const AVATAR_PY = [
  'class Avatar(kbe.KBEntity):',
  '    def tick(self):',
  '        self.hp = self.hp - 1',
  ''
].join('\n');

const AVATAR_PY_DRIFTED = [
  'class Avatar(kbe.KBEntity):',
  '    # line inserted during rename',
  '    def tick(self):',
  '        self.hp = self.hp - 1',
  ''
].join('\n');

let root: string;
let heroDef: string;
let monsterDef: string;
let avatarDef: string;
let avatarPy: string;

const write = (relative: string, content: string): string => {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
  return file;
};

/** 打开(未保存)文档缓冲区替身 */
const openBuffer = (filePath: string, version: number, content: string): void => {
  stubWorkspace.textDocuments = [
    {
      uri: { toString: () => `file://${filePath}`, fsPath: filePath },
      version,
      getText: () => content
    }
  ];
};

const cursorAtWord = (text: string, word: string): Position => {
  const offset = text.indexOf(word) + 1;
  const before = text.slice(0, offset);
  return new Position(before.split('\n').length - 1, offset - (before.lastIndexOf('\n') + 1));
};

const makeManager = async (defFiles: string[]): Promise<EntityMappingManager> => {
  const manager = new EntityMappingManager({ subscriptions: [] } as never);
  stubWorkspace.findFiles = (async (glob?: string) =>
    glob === '**/*.def' ? defFiles.map(file => Uri.file(file)) : []) as typeof stubWorkspace.findFiles;
  await (manager as unknown as { waitForInitialScan(): Promise<void> }).waitForInitialScan();
  return manager;
};

const makeToken = (): { isCancellationRequested: boolean } => ({ isCancellationRequested: false });

interface RenameTextEdit {
  range: { start: Position; end: Position };
}
const editsForFile = (
  workspaceEdit: { entries(): Array<[{ fsPath: string }, RenameTextEdit[]]> },
  filePath: string
): RenameTextEdit[] => {
  const byPath = new Map(
    workspaceEdit.entries().map(([uri, edits]) => [uri.fsPath, edits] as const)
  );
  return byPath.get(filePath) ?? [];
};

afterEach(() => {
  vi.restoreAllMocks();
  stubWorkspace.workspaceFolders = [];
  stubWorkspace.textDocuments = [];
  if (root) { fs.rmSync(root, { recursive: true, force: true }); }
});

describe('IDE-AUD-027 异步查找后复核全部输入:在途漂移拒绝,不返回旧区间', () => {
  it('目标文档在异步 python 查找期间前进:拒绝,不套旧范围', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-aud027-target-'));
    write('scripts/entities.xml', '<root>\n  <Hero/>\n  <Monster/>\n</root>\n');
    heroDef = write('scripts/entity_defs/Hero.def', HERO_DEF);
    monsterDef = write('scripts/entity_defs/Monster.def', MONSTER_DEF_V2);
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
    const manager = await makeManager([heroDef, monsterDef]);
    const provider = new KBEngineRenameProvider(manager);
    // 目标 Hero.def 打开为 v1;Monster.def 打开为 v2(跨文件编辑目标)
    const heroDoc = makeTextDocument(HERO_DEF, { fileName: heroDef, version: 1 });
    openBuffer(monsterDef, 2, MONSTER_DEF_V2);
    const cursor = cursorAtWord(HERO_DEF, '<hp>');

    // 首次计算(记录输入)后,新手势起点重置
    provider.prepareRename(heroDoc, cursor);
    const original = manager.getIncomingPythonPropertyAccesses.bind(manager);
    vi.spyOn(manager, 'getIncomingPythonPropertyAccesses').mockImplementation(async (...args) => {
      (heroDoc as { version: number }).version = 2; // 等待中目标 v1→v2
      return original(...(args as Parameters<typeof original>));
    });

    await expect(
      provider.provideRenameEdits(heroDoc, cursor, 'vigor')
    ).rejects.toThrow(/target document|modified|changed/i);
  });

  it('依赖 def(跨文件缓冲区)在异步查找期间变化:拒绝,不套旧行', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-aud027-cross-'));
    write('scripts/entities.xml', '<root>\n  <Hero/>\n  <Monster/>\n</root>\n');
    heroDef = write('scripts/entity_defs/Hero.def', HERO_DEF);
    monsterDef = write('scripts/entity_defs/Monster.def', MONSTER_DEF_V2);
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
    const manager = await makeManager([heroDef, monsterDef]);
    const provider = new KBEngineRenameProvider(manager);
    const heroDoc = makeTextDocument(HERO_DEF, { fileName: heroDef, version: 1 });
    openBuffer(monsterDef, 2, MONSTER_DEF_V2);
    const cursor = cursorAtWord(HERO_DEF, '<hp>');

    provider.prepareRename(heroDoc, cursor);
    const original = manager.getIncomingPythonPropertyAccesses.bind(manager);
    vi.spyOn(manager, 'getIncomingPythonPropertyAccesses').mockImplementation(async (...args) => {
      openBuffer(monsterDef, 3, MONSTER_DEF_V3); // 等待中跨文件缓冲区 v2→v3
      return original(...(args as Parameters<typeof original>));
    });

    await expect(
      provider.provideRenameEdits(heroDoc, cursor, 'vigor')
    ).rejects.toThrow(/referenced|changed|modified/i);
  });

  it('python 源文件在异步查找期间变化:访问位置失效,拒绝', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-aud027-py-'));
    write('scripts/entities.xml', '<root>\n  <Avatar/>\n</root>\n');
    avatarDef = write('scripts/entity_defs/Avatar.def', AVATAR_DEF);
    avatarPy = write('scripts/base/Avatar.py', AVATAR_PY);
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
    const manager = await makeManager([avatarDef]);
    const provider = new KBEngineRenameProvider(manager);
    const defDoc = makeTextDocument(AVATAR_DEF, { fileName: avatarDef, version: 1 });
    const cursor = cursorAtWord(AVATAR_DEF, '<hp>');

    provider.prepareRename(defDoc, cursor);
    const original = manager.getIncomingPythonPropertyAccesses.bind(manager);
    vi.spyOn(manager, 'getIncomingPythonPropertyAccesses').mockImplementation(async (...args) => {
      const result = await original(...(args as Parameters<typeof original>)); // 按旧内容算
      fs.writeFileSync(avatarPy, AVATAR_PY_DRIFTED); // 再漂移文件
      return result;
    });

    await expect(
      provider.provideRenameEdits(defDoc, cursor, 'vigor')
    ).rejects.toThrow(/python|changed|modified/i);
  });

  it('手势取消:不发布晚到编辑,返回 null', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-aud027-cancel-'));
    write('scripts/entities.xml', '<root>\n  <Hero/>\n  <Monster/>\n</root>\n');
    heroDef = write('scripts/entity_defs/Hero.def', HERO_DEF);
    monsterDef = write('scripts/entity_defs/Monster.def', MONSTER_DEF_V2);
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
    const manager = await makeManager([heroDef, monsterDef]);
    const provider = new KBEngineRenameProvider(manager);
    const heroDoc = makeTextDocument(HERO_DEF, { fileName: heroDef, version: 1 });
    openBuffer(monsterDef, 2, MONSTER_DEF_V2);
    const cursor = cursorAtWord(HERO_DEF, '<hp>');
    const token = makeToken();

    provider.prepareRename(heroDoc, cursor);
    const original = manager.getIncomingPythonPropertyAccesses.bind(manager);
    vi.spyOn(manager, 'getIncomingPythonPropertyAccesses').mockImplementation(async (...args) => {
      token.isCancellationRequested = true; // 等待中手势取消
      return original(...(args as Parameters<typeof original>));
    });

    const result = await provider.provideRenameEdits(heroDoc, cursor, 'vigor', token as never);
    expect(result).toBeNull();
  });

  it('无漂移照常返回:异步查找后输入未变,编辑范围按当前文本', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-aud027-clean-'));
    write('scripts/entities.xml', '<root>\n  <Hero/>\n  <Monster/>\n</root>\n');
    heroDef = write('scripts/entity_defs/Hero.def', HERO_DEF);
    monsterDef = write('scripts/entity_defs/Monster.def', MONSTER_DEF_V2);
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
    const manager = await makeManager([heroDef, monsterDef]);
    const provider = new KBEngineRenameProvider(manager);
    const heroDoc = makeTextDocument(HERO_DEF, { fileName: heroDef, version: 1 });
    openBuffer(monsterDef, 2, MONSTER_DEF_V2);
    const cursor = cursorAtWord(HERO_DEF, '<hp>');

    provider.prepareRename(heroDoc, cursor);
    const result = await provider.provideRenameEdits(heroDoc, cursor, 'vigor');
    expect(result).not.toBeNull();
    // def 编辑在位(跨文件 Monster.def 也被改写——既有行为不回归)
    expect(editsForFile(result!, path.resolve(heroDef)).length).toBeGreaterThan(0);
    expect(editsForFile(result!, path.resolve(monsterDef)).length).toBeGreaterThan(0);
  });
});
