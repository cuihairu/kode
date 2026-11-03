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

// NAV-REF-PROP:2026-10-30 用户反馈补充——def 定义 equip_track_list(类型
// EQUIP_TRACK_LIST),Shift+F12 应能找到 py 中 self.equip_track_list 使用处。
// 核对结论:属性引用链按属性名匹配(findOwnerSelfPropertyAccesses 正则
// `\bself\.<prop>\b(?!\s*\()`),类型(EQUIP_TRACK_LIST)无关——此块原样复刻用户
// 场景锁同链生效。用户实测为空的位因由末例演示:光标须落在属性名行
// (<equip_track_list>)才走属性引用面;落在 <Type> 值行(EQUIP_TRACK_LIST)则
// findDefSymbolInfo 因符号节点名(Type)!==word 返回 null,回落 defSymbolReferences
// 类型引用面(IDE-NAV-018,只找类型名使用处、不找 self 属性访问)或 null,
// 故看不到 py 的 self 访问。构建版本/索引冷属用户侧,本块验证码路径。

const HERO_DEF = [
  '<root>',
  '  <Properties>',
  '    <equip_track_list>',
  '      <Type> EQUIP_TRACK_LIST </Type>',
  '    </equip_track_list>',
  '  </Properties>',
  '</root>'
].join('\n');

const HERO_PY = [
  'class Hero(kbe.KBEntity):',
  '    def add_equip(self, item):',
  '        self.equip_track_list.append(item)',
  '        count = len(self.equip_track_list)',
  '        return count',
  ''
].join('\n');

const buildHeroWorkspace = (): { root: string; heroDef: string; heroPy: string } => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-navprop-'));
  const put = (relative: string, content: string): string => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, 'utf8');
    return file;
  };
  const heroDef = put('scripts/entity_defs/Hero.def', HERO_DEF);
  const heroPy = put('scripts/base/Hero.py', HERO_PY);
  stubWorkspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
  return { root, heroDef, heroPy };
};

describe('NAV-REF-PROP: def 属性 Shift+F12 场景核对(equip_track_list)', () => {
  it('属性名位 Shift+F12 → owner Hero.py self.equip_track_list 使用处', async () => {
    const ws = buildHeroWorkspace();
    const originalFindFiles = stubWorkspace.findFiles;
    stubWorkspace.findFiles = (async (glob?: string) =>
      glob === '**/*.def'
        ? [Uri.file(ws.heroDef)]
        : []) as typeof stubWorkspace.findFiles;
    try {
      const manager = await makeManager();
      // 直接链:别名 list 型属性同样按名收录(类型无关)
      const accesses = await manager.getIncomingPythonPropertyAccesses(ws.heroDef, 'equip_track_list');
      expect(accesses.length, 'Hero.py 两处 self.equip_track_list(append+len)都收').toBe(2);
      for (const access of accesses) {
        expect(access.filePath).toBe(ws.heroPy);
      }
      expect(accesses.map(access => access.character).sort((a, b) => a - b)).toEqual([13, 25]);

      // provider 面:Shift+F12 在 def 属性名行(equip_track_list)→ 同归属使用处
      const provider = new KBEngineReferencesProvider(manager);
      const defDoc = makeTextDocument(HERO_DEF, { fileName: ws.heroDef }) as never;
      const result = await provider.provideReferences(
        defDoc,
        new Position(2, 6),
        { includeDeclaration: false },
        undefined
      );
      expect(result).not.toBeNull();
      expect(result!.length).toBe(2);
      for (const location of result!) {
        expect(location.uri.fsPath).toBe(ws.heroPy);
      }
      expect(result!.map(location => location.range.start.line).sort()).toEqual([2, 3]);
    } finally {
      stubWorkspace.findFiles = originalFindFiles;
      stubWorkspace.workspaceFolders = [];
    }
  });

  it('光标在 <Type> 值行(EQUIP_TRACK_LIST)→ 回落类型引用面,不出 self 访问(位因)', async () => {
    const ws = buildHeroWorkspace();
    const originalFindFiles = stubWorkspace.findFiles;
    stubWorkspace.findFiles = (async (glob?: string) =>
      glob === '**/*.def'
        ? [Uri.file(ws.heroDef)]
        : []) as typeof stubWorkspace.findFiles;
    try {
      const manager = await makeManager();
      const provider = new KBEngineReferencesProvider(manager);
      const defDoc = makeTextDocument(HERO_DEF, { fileName: ws.heroDef }) as never;
      // Position(3,15) 落在 `<Type> EQUIP_TRACK_LIST </Type>` 的值 EQUIP_TRACK_LIST 上
      const result = await provider.provideReferences(
        defDoc,
        new Position(3, 15),
        { includeDeclaration: false },
        undefined
      );
      // 类型引用面只找类型名使用处(本工作区无 types.xml 声明 EQUIP_TRACK_LIST
      // → 无引用面,如实 null),无论如何不得混入 Hero.py 的 self 属性访问——
      // 这正是「光标在 Type 值行看不到 self 访问」的位因核对。
      if (result) {
        for (const location of result) {
          expect(location.uri.fsPath, '类型引用面不得出 py self 访问').not.toBe(ws.heroPy);
        }
      }
    } finally {
      stubWorkspace.findFiles = originalFindFiles;
      stubWorkspace.workspaceFolders = [];
    }
  });
});
