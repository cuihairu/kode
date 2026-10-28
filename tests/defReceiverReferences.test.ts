import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { EntityMappingManager } from '../src/entityMapping';
import { KBEngineReferencesProvider } from '../src/languageProviders';
import { makeTextDocument, Position, Uri, workspace as stubWorkspace } from './helpers/vscodeStub';

// IDE-NAV-003:方法引用收录 receiver RPC 调用(self.cell.X( / self.base.X( /
// self.client.X()。验收口径:Base/Cell/Client 同名方法按 receiver 段分开统计,
// 各段只收本段 receiver 的调用,互不串账;归属与 NAV-002 同面(owner 注册面),
// 无关实体同名调用不进;非调用形态(self.cell.X 不带括号)不收。真
// EntityMappingManager+真临时工作区,与 defPropertyReferences 同款装配。

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
  '  <ClientMethods>',
  '    <reqPos>',
  '      <Arg> INT32 </Arg>',
  '    </reqPos>',
  '  </ClientMethods>',
  '</root>'
].join('\n');

const AVATAR_PY = [
  'class Avatar(kbe.KBEntity):',
  '    def tick(self):',
  '        self.base.reqPos(2)',
  '        self.cell.reqPos(1)',
  '        self.client.reqPos(3)',
  '        handler = self.cell.reqPos',
  ''
].join('\n');

const MONSTER_DEF = [
  '<root>',
  '  <CellMethods>',
  '    <reqPos>',
  '      <Arg> INT32 </Arg>',
  '    </reqPos>',
  '  </CellMethods>',
  '</root>'
].join('\n');

const MONSTER_PY = [
  'class Monster(kbe.KBEntity):',
  '    def tick(self):',
  '        self.cell.reqPos(9)',
  ''
].join('\n');

interface WorkspacePaths {
  root: string;
  avatarDef: string;
  avatarPy: string;
  monsterPy: string;
}

const buildWorkspace = (): WorkspacePaths => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-nav003-'));
  const put = (relative: string, content: string): string => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, 'utf8');
    return file;
  };
  const avatarDef = put('scripts/entity_defs/Avatar.def', AVATAR_DEF);
  put('scripts/entity_defs/Monster.def', MONSTER_DEF);
  const avatarPy = put('scripts/base/Avatar.py', AVATAR_PY);
  const monsterPy = put('scripts/base/Monster.py', MONSTER_PY);
  stubWorkspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
  return { root, avatarDef, avatarPy, monsterPy };
};

const makeManager = async (): Promise<EntityMappingManager> => {
  const manager = new EntityMappingManager({ subscriptions: [] } as never);
  await (manager as unknown as { waitForInitialScan(): Promise<void> }).waitForInitialScan();
  return manager;
};

const withStubbedDefs = async <T>(avatarDef: string, monsterDef: boolean, run: () => Promise<T>): Promise<T> => {
  const originalFindFiles = stubWorkspace.findFiles;
  stubWorkspace.findFiles = (async (glob?: string) =>
    glob === '**/*.def'
      ? monsterDef
        ? [Uri.file(avatarDef), Uri.file(avatarDef.replace('Avatar.def', 'Monster.def'))]
        : [Uri.file(avatarDef)]
      : []) as typeof stubWorkspace.findFiles;
  try {
    return await run();
  } finally {
    stubWorkspace.findFiles = originalFindFiles;
    stubWorkspace.workspaceFolders = [];
  }
};

describe('receiver RPC 调用收录(IDE-NAV-003)', () => {
  it('同名方法按 receiver 段分开统计:cell/base/client 各只收本段调用位', async () => {
    const ws = buildWorkspace();
    await withStubbedDefs(ws.avatarDef, false, async () => {
      const manager = await makeManager();
      const cellCalls = await manager.getIncomingPythonReceiverCalls(ws.avatarDef, 'reqPos', 'cell');
      expect(cellCalls, '只收 self.cell.reqPos( 一处').toHaveLength(1);
      expect(cellCalls[0].filePath).toBe(ws.avatarPy);
      // python 第 4 行(1 基),方法名列=8 空格 + 'self.cell.' = 18
      expect(cellCalls[0].line).toBe(4);
      expect(cellCalls[0].character).toBe(18);

      const baseCalls = await manager.getIncomingPythonReceiverCalls(ws.avatarDef, 'reqPos', 'base');
      expect(baseCalls, 'base 段只收 self.base.reqPos(,不串 cell/client').toHaveLength(1);
      expect(baseCalls[0].line).toBe(3);
      expect(baseCalls[0].character).toBe(18);

      const clientCalls = await manager.getIncomingPythonReceiverCalls(ws.avatarDef, 'reqPos', 'client');
      expect(clientCalls, 'client 段只收 self.client.reqPos(').toHaveLength(1);
      expect(clientCalls[0].line).toBe(5);
      expect(clientCalls[0].character).toBe(20);

      // 非调用形态:'handler = self.cell.reqPos'(无括号)不进任何段
      const all = [...cellCalls, ...baseCalls, ...clientCalls];
      expect(all.every(call => call.line !== 6)).toBe(true);
    });
  });

  it('归属由 owner 注册面决定:Monster.py 的 self.cell.reqPos( 不进 Avatar 引用', async () => {
    const ws = buildWorkspace();
    await withStubbedDefs(ws.avatarDef, true, async () => {
      const manager = await makeManager();
      const cellCalls = await manager.getIncomingPythonReceiverCalls(ws.avatarDef, 'reqPos', 'cell');
      expect(cellCalls).toHaveLength(1);
      expect(cellCalls.some(call => call.filePath === ws.monsterPy)).toBe(false);
    });
  });

  it('provider 面:Shift+F12 在 CellMethods/BaseMethods 位各出本段 receiver 引用位', async () => {
    const ws = buildWorkspace();
    await withStubbedDefs(ws.avatarDef, false, async () => {
      const manager = await makeManager();
      const provider = new KBEngineReferencesProvider(manager);
      const defDoc = makeTextDocument(AVATAR_DEF, { fileName: ws.avatarDef }) as never;

      // CellMethods <reqPos>(0 基第 7 行)→ self.cell.reqPos( 位
      const cellResult = await provider.provideReferences(
        defDoc, new Position(7, 6), { includeDeclaration: false }, undefined);
      expect(cellResult).not.toBeNull();
      expect(cellResult!).toHaveLength(1);
      expect(cellResult![0].uri.fsPath).toBe(ws.avatarPy);
      expect(cellResult![0].range.start.line).toBe(3);
      expect(cellResult![0].range.start.character).toBe(18);

      // BaseMethods <reqPos>(0 基第 2 行)→ self.base.reqPos( 位,不出 cell 位
      const baseResult = await provider.provideReferences(
        defDoc, new Position(2, 6), { includeDeclaration: false }, undefined);
      expect(baseResult).not.toBeNull();
      expect(baseResult!).toHaveLength(1);
      expect(baseResult![0].range.start.line).toBe(2);
      expect(baseResult![0].range.start.character).toBe(18);
    });
  });

  it('未索引 def → 空结果,不猜归属;取消位同理空', async () => {
    const ws = buildWorkspace();
    await withStubbedDefs(ws.avatarDef, false, async () => {
      const manager = await makeManager();
      const ghost = path.join(ws.root, 'scripts/entity_defs/Ghost.def');
      expect(await manager.getIncomingPythonReceiverCalls(ghost, 'reqPos', 'cell')).toEqual([]);
      const cancelled = { isCancellationRequested: true } as never;
      expect(await manager.getIncomingPythonReceiverCalls(
        ws.avatarDef, 'reqPos', 'cell', cancelled)).toEqual([]);
    });
  });
});
