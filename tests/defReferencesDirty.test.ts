import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { EntityMappingManager } from '../src/entityMapping';
import { KBEngineReferencesProvider } from '../src/languageProviders';
import { makeTextDocument, Position, Uri, workspace as stubWorkspace } from './helpers/vscodeStub';

// IDE-NAV-004:引用结果使用未保存文档。验收口径:新增或删除未保存调用点后,
// 引用列表跟随当前版本(缓冲区),不是磁盘旧版。三条引用面同测:receiver RPC
// (self.cell.X()、属性 self 访问(NAV-002)、方法实现链(NAV-001)——打开文档
// 在位时以缓冲区内容为准,关闭/未打开回落磁盘版(与 SNP-001 快照同一契约)。

const AVATAR_DEF = [
  '<root>',
  '  <Properties>',
  '    <hp>',
  '      <Type>UINT32</Type>',
  '    </hp>',
  '  </Properties>',
  '  <BaseMethods>',
  '    <reqPos>',
  '      <Arg>TIMESTAMP</Arg>',
  '    </reqPos>',
  '  </BaseMethods>',
  '  <CellMethods>',
  '    <reqPos>',
  '      <Arg>TIMESTAMP</Arg>',
  '    </reqPos>',
  '  </CellMethods>',
  '</root>'
].join('\n');

/** 磁盘版调用点:reqPos(0) 行5 / self.hp 行6 / self.cell.reqPos(1) 行7 */
const AVATAR_PY_ON_DISK = [
  'class Avatar(kbe.KBEntity):',
  '    def reqPos(self, stamp):',
  '        pass',
  '    def tick(self):',
  '        self.reqPos(0)',
  '        self.hp = self.hp - 1',
  '        self.cell.reqPos(1)',
  ''
].join('\n');

/** 未保存版:删了三处旧调用点,换到新行位(行5/6/7)且内容不同 */
const AVATAR_PY_DIRTY = [
  'class Avatar(kbe.KBEntity):',
  '    def reqPos(self, stamp):',
  '        pass',
  '    def tick(self):',
  '        self.cell.reqPos(2)',
  '        self.reqPos(9)',
  '        self.hp = 7',
  ''
].join('\n');

const buildWorkspace = (): { root: string; avatarDef: string; avatarPy: string } => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-nav004-'));
  const put = (relative: string, content: string): string => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, 'utf8');
    return file;
  };
  const avatarDef = put('scripts/entity_defs/Avatar.def', AVATAR_DEF);
  const avatarPy = put('scripts/base/Avatar.py', AVATAR_PY_ON_DISK);
  stubWorkspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
  return { root, avatarDef, avatarPy };
};

const withStubbedDefs = async <T>(avatarDef: string, run: () => Promise<T>): Promise<T> => {
  const originalFindFiles = stubWorkspace.findFiles;
  stubWorkspace.findFiles = (async (glob?: string) =>
    glob === '**/*.def' ? [Uri.file(avatarDef)] : []) as typeof stubWorkspace.findFiles;
  try {
    return await run();
  } finally {
    stubWorkspace.findFiles = originalFindFiles;
    stubWorkspace.workspaceFolders = [];
    stubWorkspace.textDocuments = [];
  }
};

/** 打开(未保存)文档替身:缓冲区=AVATAR_PY_DIRTY,同 SNP-001 替身形状 */
const openDirtyDocument = (fsPath: string): void => {
  stubWorkspace.textDocuments = [
    {
      uri: { toString: () => `file://${fsPath}`, fsPath },
      version: 3,
      getText: () => AVATAR_PY_DIRTY
    }
  ];
};

const makeManager = async (): Promise<EntityMappingManager> => {
  const manager = new EntityMappingManager({ subscriptions: [] } as never);
  await (manager as unknown as { waitForInitialScan(): Promise<void> }).waitForInitialScan();
  return manager;
};

afterEach(() => {
  stubWorkspace.textDocuments = [];
});

describe('引用结果使用未保存文档(IDE-NAV-004)', () => {
  it('receiver RPC 引用跟随缓冲区:新位点在(行5),删掉的旧位点不在(行7)', async () => {
    const ws = buildWorkspace();
    await withStubbedDefs(ws.avatarDef, async () => {
      const manager = await makeManager();
      openDirtyDocument(ws.avatarPy);
      const calls = await manager.getIncomingPythonReceiverCalls(ws.avatarDef, 'reqPos', 'cell');
      expect(calls, '只收未保存版那一处 self.cell.reqPos(2)').toHaveLength(1);
      expect(calls[0].line).toBe(5);
      expect(calls[0].character).toBe(18);
      expect(calls.some(call => call.line === 7), '磁盘旧位点 self.cell.reqPos(1) 已删,不得残留').toBe(false);
    });
  });

  it('属性引用跟随缓冲区:self.hp 新位点在(行7),删掉的旧位点不在(行6)', async () => {
    const ws = buildWorkspace();
    await withStubbedDefs(ws.avatarDef, async () => {
      const manager = await makeManager();
      openDirtyDocument(ws.avatarPy);
      const accesses = await manager.getIncomingPythonPropertyAccesses(ws.avatarDef, 'hp');
      expect(accesses, '未保存版只有一处 self.hp = 7').toHaveLength(1);
      expect(accesses[0].line).toBe(7);
      expect(accesses[0].character).toBe(13);
    });
  });

  it('方法引用(实现链)跟随缓冲区:新调用位(行6)在,删掉的旧调用位(行5)不在', async () => {
    const ws = buildWorkspace();
    await withStubbedDefs(ws.avatarDef, async () => {
      const manager = await makeManager();
      openDirtyDocument(ws.avatarPy);
      const provider = new KBEngineReferencesProvider(manager);
      const defDoc = makeTextDocument(AVATAR_DEF, { fileName: ws.avatarDef }) as never;
      const result = await provider.provideReferences(
        defDoc, new Position(7, 6), { includeDeclaration: false }, undefined);
      // BaseMethods.reqPos:实现链一条(未保存版 self.reqPos(9) 行6 列13);
      // self.cell.reqPos(2) 属 CellMethods 段,不串进 BaseMethods(NAV-003 段闸)
      expect(result).not.toBeNull();
      expect(result!).toHaveLength(1);
      expect(result![0].range.start.line).toBe(5);
      expect(result![0].range.start.character).toBe(13);
    });
  });

  it('未打开文档回落磁盘版:三面都出磁盘位点;provider 面同样', async () => {
    const ws = buildWorkspace();
    await withStubbedDefs(ws.avatarDef, async () => {
      const manager = await makeManager();
      const receiver = await manager.getIncomingPythonReceiverCalls(ws.avatarDef, 'reqPos', 'cell');
      expect(receiver).toHaveLength(1);
      expect(receiver[0].line).toBe(7);

      const property = await manager.getIncomingPythonPropertyAccesses(ws.avatarDef, 'hp');
      expect(property).toHaveLength(2);
      expect(property.map(access => access.line).sort()).toEqual([6, 6]);

      const provider = new KBEngineReferencesProvider(manager);
      const defDoc = makeTextDocument(AVATAR_DEF, { fileName: ws.avatarDef }) as never;
      const result = await provider.provideReferences(
        defDoc, new Position(7, 6), { includeDeclaration: false }, undefined);
      expect(result).not.toBeNull();
      expect(result!).toHaveLength(1);
      expect(result![0].range.start.line).toBe(4);
    });
  });
});
