import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { EntityMappingManager } from '../src/entityMapping';
import { KBEngineRenameProvider } from '../src/languageProviders';
import { makeTextDocument, Position, Uri, workspace as stubWorkspace } from './helpers/vscodeStub';

// IDE-NAV-012:方法重命名更新确定的 RPC 引用。验收口径:调用端 receiver
// 段与被重命名声明一致时才改写——BaseMethods 声明改名只改 self.base.X(,
// CellMethods 声明改名只改 self.cell.X(,跨段同名(引擎常态)不串改;
// 归属由 owner 注册面决定(NAV-003 同款),无 receiver 形态(self.X()不收。

const AVATAR_DEF = [
  '<root>',
  '  <BaseMethods>',
  '    <reqPos>',
  '      <Arg> INT32 </Arg>',
  '    </reqPos>',
  '  </BaseMethods>',
  '  <CellMethods>',
  '    <reqPos>',
  '      <Arg> INT32 </Arg>',
  '    </reqPos>',
  '  </CellMethods>',
  '</root>',
  ''
].join('\n');

const AVATAR_PY = [
  'class Avatar(kbe.KBEntity):',
  '    def tick(self):',
  '        self.base.reqPos(1)',
  '        self.cell.reqPos(2)',
  ''
].join('\n');

/** 无关实体:同名 receiver 调用不在 Avatar 的 owner 注册面 → 不得改写 */
const MONSTER_PY = [
  'class Monster(kbe.KBEntity):',
  '    def tick(self):',
  '        self.base.reqPos(3)',
  ''
].join('\n');

let root: string;
let avatarDef: string;
let avatarPy: string;
let monsterPy: string;
let originalFindFiles: typeof stubWorkspace.findFiles | undefined;

const write = (relative: string, content: string): string => {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf-8');
  return file;
};

const buildWorkspace = async (): Promise<void> => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-nav012-'));
  write('scripts/entities.xml', '<root>\n  <Avatar/>\n</root>\n');
  avatarDef = write('scripts/entity_defs/Avatar.def', AVATAR_DEF);
  avatarPy = write('scripts/base/Avatar.py', AVATAR_PY);
  monsterPy = write('scripts/base/Monster.py', MONSTER_PY);
  stubWorkspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
  originalFindFiles = stubWorkspace.findFiles;
  stubWorkspace.findFiles = (async (glob?: string) =>
    glob === '**/*.def' ? [Uri.file(avatarDef)] : []) as typeof stubWorkspace.findFiles;
};

const cleanupWorkspace = (): void => {
  if (originalFindFiles) {
    stubWorkspace.findFiles = originalFindFiles;
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
  newText: string;
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

/** 光标落在指定段内方法名上 */
const cursorAtSectionMethod = (section: 'BaseMethods' | 'CellMethods'): Position => {
  const sectionOffset = AVATAR_DEF.indexOf(`<${section}>`);
  const offset = AVATAR_DEF.indexOf('<reqPos>', sectionOffset) + 1;
  const before = AVATAR_DEF.slice(0, offset);
  return new Position(
    before.split('\n').length - 1,
    offset - (before.lastIndexOf('\n') + 1)
  );
};

describe('方法重命名更新 receiver 段一致的 RPC 引用(IDE-NAV-012)', () => {
  it('BaseMethods.reqPos 改名:只改 self.base.reqPos(,不串改 self.cell 同名', async () => {
    await buildWorkspace();
    try {
      const manager = await makeManager();
      const provider = new KBEngineRenameProvider(manager);
      const defDoc = makeTextDocument(AVATAR_DEF, { fileName: avatarDef }) as never;

      const workspaceEdit = await provider.provideRenameEdits(
        defDoc, cursorAtSectionMethod('BaseMethods'), 'posBase');
      expect(workspaceEdit).not.toBeNull();

      // def 编辑在位(BaseMethods 段的 reqPos,不含 CellMethods)
      const defEdits = editsForFile(workspaceEdit!, path.resolve(avatarDef));
      expect(defEdits.length).toBeGreaterThan(0);

      // Avatar.py:仅 self.base.reqPos( 一处(0 基行 2,列 8+10=18)
      const pyEdits = editsForFile(workspaceEdit!, path.resolve(avatarPy));
      expect(pyEdits).toHaveLength(1);
      expect(pyEdits[0].range.start).toEqual(new Position(2, 18));
      expect(pyEdits[0].newText).toBe('posBase');

      // 无关实体(Monster.py 的 self.base.reqPos(3))不改写——歧义不猜测
      expect(editsForFile(workspaceEdit!, path.resolve(monsterPy))).toEqual([]);
    } finally {
      cleanupWorkspace();
    }
  });

  it('CellMethods.reqPos 改名:只改 self.cell.reqPos(,不串改 self.base 同名', async () => {
    await buildWorkspace();
    try {
      const manager = await makeManager();
      const provider = new KBEngineRenameProvider(manager);
      const defDoc = makeTextDocument(AVATAR_DEF, { fileName: avatarDef }) as never;

      const workspaceEdit = await provider.provideRenameEdits(
        defDoc, cursorAtSectionMethod('CellMethods'), 'posCell');
      expect(workspaceEdit).not.toBeNull();

      const defEdits = editsForFile(workspaceEdit!, path.resolve(avatarDef));
      expect(defEdits.length).toBeGreaterThan(0);

      // Avatar.py:仅 self.cell.reqPos( 一处(0 基行 3)
      const pyEdits = editsForFile(workspaceEdit!, path.resolve(avatarPy));
      expect(pyEdits).toHaveLength(1);
      expect(pyEdits[0].range.start).toEqual(new Position(3, 18));
      expect(pyEdits[0].newText).toBe('posCell');
    } finally {
      cleanupWorkspace();
    }
  });
});
