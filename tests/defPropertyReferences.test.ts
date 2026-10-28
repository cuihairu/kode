import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { EntityMappingManager } from '../src/entityMapping';
import { KBEngineReferencesProvider } from '../src/languageProviders';
import { makeTextDocument, Position, Uri, workspace as stubWorkspace } from './helpers/vscodeStub';

// IDE-NAV-002:属性引用收录 Python self 访问。验收口径:已确定实体归属的
// self.hp 纳入 hp 引用(owner 文件面),无关实体同名属性不纳入(Monster.py
// 的 self.hp 不进 Avatar 的 hp);方法调用(self.reqPos() 带)不混进属性
// 引用(NAV-003 另收)。真 EntityMappingManager+真临时工作区(与 receiver
// 装配同款),引用归属由 owner 注册面决定,不做名字 grep。

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
  '</root>'
].join('\n');

const AVATAR_PY = [
  'class Avatar(kbe.KBEntity):',
  '    def tick(self):',
  '        self.hp = self.hp - 1',
  '        self.reqPos(0)',
  ''
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

const MONSTER_PY = [
  'class Monster(kbe.KBEntity):',
  '    def tick(self):',
  '        self.hp = 5',
  ''
].join('\n');

const buildWorkspace = (): { root: string; avatarDef: string; avatarPy: string; monsterPy: string } => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-nav002-'));
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

describe('属性引用收录 python self 访问(IDE-NAV-002)', () => {
  it('owner 文件 self.hp 进引用;无关实体同名不进;方法调用不混入', async () => {
    const ws = buildWorkspace();
    const originalFindFiles = stubWorkspace.findFiles;
    stubWorkspace.findFiles = (async (glob?: string) =>
      glob === '**/*.def'
        ? [Uri.file(ws.avatarDef), Uri.file(path.join(ws.root, 'scripts/entity_defs/Monster.def'))]
        : []) as typeof stubWorkspace.findFiles;
    try {
      const manager = await makeManager();
      const accesses = await manager.getIncomingPythonPropertyAccesses(ws.avatarDef, 'hp');
      expect(accesses.length, 'Avatar.py 两处 self.hp(读+写)都收').toBeGreaterThanOrEqual(2);
      for (const access of accesses) {
        expect(access.filePath).toBe(ws.avatarPy);
      }
      // 同行两处 self.hp:列位=各匹配的 self. 后(13 与 23)
      expect(accesses.map(access => access.character).sort((a, b) => a - b)).toEqual([13, 23]);
      // 无关实体:Monster.py 的 self.hp 不得进 Avatar 的 hp 引用
      expect(accesses.some(access => access.filePath === ws.monsterPy)).toBe(false);

      // provider 面:Shift+F12 在 def hp 位出同样归属的引用
      const provider = new KBEngineReferencesProvider(manager);
      const defDoc = makeTextDocument(AVATAR_DEF, { fileName: ws.avatarDef }) as never;
      const result = await provider.provideReferences(
        defDoc,
        new Position(2, 6),
        { includeDeclaration: false },
        undefined
      );
      expect(result).not.toBeNull();
      expect(result!.length).toBeGreaterThanOrEqual(2);
      for (const location of result!) {
        expect(location.uri.fsPath).toBe(ws.avatarPy);
      }
      // 引用行=python 1 基行号转 0 基
      expect(result!.map(location => location.range.start.line).sort()).toEqual([2, 2]);
    } finally {
      stubWorkspace.findFiles = originalFindFiles;
      stubWorkspace.workspaceFolders = [];
    }
  });

  it('方法调用不冒充属性引用:self.reqPos() 不进 hp 引用,reqPos 方法引用照常走方法链', async () => {
    const ws = buildWorkspace();
    const originalFindFiles = stubWorkspace.findFiles;
    stubWorkspace.findFiles = (async (glob?: string) =>
      glob === '**/*.def' ? [Uri.file(ws.avatarDef)] : []) as typeof stubWorkspace.findFiles;
    try {
      const manager = await makeManager();
      const accesses = await manager.getIncomingPythonPropertyAccesses(ws.avatarDef, 'reqPos');
      expect(accesses, 'self.reqPos( 是方法调用,属性引用面不收').toEqual([]);
    } finally {
      stubWorkspace.findFiles = originalFindFiles;
      stubWorkspace.workspaceFolders = [];
    }
  });

  it('未索引 def(不在册)→ 空结果,不猜归属', async () => {
    const ws = buildWorkspace();
    const originalFindFiles = stubWorkspace.findFiles;
    stubWorkspace.findFiles = (async () => []) as typeof stubWorkspace.findFiles;
    try {
      const manager = await makeManager();
      const accesses = await manager.getIncomingPythonPropertyAccesses(
        path.join(ws.root, 'scripts/entity_defs/Ghost.def'), 'hp');
      expect(accesses).toEqual([]);
    } finally {
      stubWorkspace.findFiles = originalFindFiles;
      stubWorkspace.workspaceFolders = [];
    }
  });
});
