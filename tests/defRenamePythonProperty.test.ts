import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { EntityMappingManager } from '../src/entityMapping';
import { KBEngineRenameProvider } from '../src/languageProviders';
import { makeTextDocument, Position, Uri, workspace as stubWorkspace } from './helpers/vscodeStub';

// IDE-NAV-011:属性重命名更新确定的 Python self 访问。验收口径:预览列出
// def 编辑 + 已解析的 self.<属性> 访问(owner 注册面决定归属,NAV-002 同款),
// 无关实体同名(歧义)不猜测改写;方法重命名不走此路径(方法→python 是
// NAV-012 面)。真 EntityMappingManager+真临时工作区。

const AVATAR_DEF = [
  '<root>',
  '  <Properties>',
  '    <hp>',
  '      <Type>UINT32</Type>',
  '    </hp>',
  '  </Properties>',
  '  <BaseMethods>',
  '    <reqPos>',
  '      <Arg> INT32 </Arg>',
  '    </reqPos>',
  '  </BaseMethods>',
  '</root>',
  ''
].join('\n');

const AVATAR_PY = [
  'class Avatar(kbe.KBEntity):',
  '    def tick(self):',
  '        self.hp = self.hp - 1',
  '        self.reqPos(0)',
  ''
].join('\n');

/** 无关实体:同名 self.hp,但不在 Avatar 的 owner 注册面 → 不得改写 */
const MONSTER_PY = [
  'class Monster(kbe.KBEntity):',
  '    def tick(self):',
  '        self.hp = 5',
  ''
].join('\n');

const HERO_DEF = AVATAR_DEF; // 目标 def(改 hp → vigor)

let root: string;
let avatarDef: string;
let avatarPy: string;
let monsterPy: string;

const write = (relative: string, content: string): string => {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
  return file;
};

const buildWorkspace = async (): Promise<void> => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-nav011-'));
  write('scripts/entities.xml', '<root>\n  <Avatar/>\n</root>\n');
  avatarDef = write('scripts/entity_defs/Avatar.def', AVATAR_DEF);
  avatarPy = write('scripts/base/Avatar.py', AVATAR_PY);
  monsterPy = write('scripts/base/Monster.py', MONSTER_PY);
  stubWorkspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
  const originalFindFiles = stubWorkspace.findFiles;
  stubWorkspace.findFiles = (async (glob?: string) =>
    glob === '**/*.def' ? [Uri.file(avatarDef)] : []) as typeof stubWorkspace.findFiles;
  (globalThis as { __kodeOriginalFindFiles?: typeof stubWorkspace.findFiles }).__kodeOriginalFindFiles =
    originalFindFiles;
};

const cleanupWorkspace = (): void => {
  const original =
    (globalThis as { __kodeOriginalFindFiles?: typeof stubWorkspace.findFiles }).__kodeOriginalFindFiles;
  if (original) {
    stubWorkspace.findFiles = original;
  }
  stubWorkspace.workspaceFolders = [];
};

const makeManager = async (): Promise<EntityMappingManager> => {
  const manager = new EntityMappingManager({ subscriptions: [] } as never);
  await (manager as unknown as { waitForInitialScan(): Promise<void> }).waitForInitialScan();
  return manager;
};

/** WorkspaceEdit 的 Map 按 Uri 对象身份键——按 fsPath 索引 */
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

describe('属性重命名更新已解析 self 访问(IDE-NAV-011)', () => {
  it('属性 hp 改名:预览含 def 编辑 + Avatar.py self.hp 访问;无关实体(歧义)不改写', async () => {
    await buildWorkspace();
    try {
      const manager = await makeManager();
      const provider = new KBEngineRenameProvider(manager);
      const defDoc = makeTextDocument(HERO_DEF, { fileName: avatarDef }) as never;
      // 光标在 def hp 名上
      const hpOffset = AVATAR_DEF.indexOf('<hp>') + 1;
      const before = AVATAR_DEF.slice(0, hpOffset);
      const cursor = new Position(
        before.split('\n').length - 1,
        hpOffset - (before.lastIndexOf('\n') + 1)
      );

      const workspaceEdit = await provider.provideRenameEdits(defDoc, cursor, 'vigor');
      expect(workspaceEdit).not.toBeNull();

      // def 目标文件编辑在位(既有行为不回归)
      const defEdits = editsForFile(workspaceEdit!, path.resolve(avatarDef));
      expect(defEdits.length).toBeGreaterThan(0);

      // Avatar.py:两处 self.hp(读+写,0 基行 2)被改写为 vigor
      const pyEdits = editsForFile(workspaceEdit!, path.resolve(avatarPy));
      expect(pyEdits, 'owner 文件两处 self.hp 都改写').toHaveLength(2);
      expect(pyEdits[0].range.start).toEqual(new Position(2, 13));
      expect(pyEdits[1].range.start).toEqual(new Position(2, 23));
      for (const edit of pyEdits) {
        expect((edit as unknown as { newText: string }).newText).toBe('vigor');
      }

      // 无关实体(Monster.py 同名 self.hp)不被改写——歧义不猜测
      expect(editsForFile(workspaceEdit!, path.resolve(monsterPy))).toEqual([]);
    } finally {
      cleanupWorkspace();
    }
  });

  it('方法重命名不走属性路径:self.reqPos() 调用不被改写(方法→python 属 NAV-012)', async () => {
    await buildWorkspace();
    try {
      const manager = await makeManager();
      const provider = new KBEngineRenameProvider(manager);
      const defDoc = makeTextDocument(AVATAR_DEF, { fileName: avatarDef }) as never;
      const offset = AVATAR_DEF.indexOf('<reqPos>') + 1;
      const before = AVATAR_DEF.slice(0, offset);
      const cursor = new Position(
        before.split('\n').length - 1,
        offset - (before.lastIndexOf('\n') + 1)
      );

      const workspaceEdit = await provider.provideRenameEdits(defDoc, cursor, 'posReq');
      expect(workspaceEdit).not.toBeNull();
      // def 编辑在位
      expect(editsForFile(workspaceEdit!, path.resolve(avatarDef)).length).toBeGreaterThan(0);
      // python 不被改写:方法调用(self.reqPos())既非属性访问,方法→python 属 NAV-012
      expect(editsForFile(workspaceEdit!, path.resolve(avatarPy))).toEqual([]);
    } finally {
      cleanupWorkspace();
    }
  });
});
