import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import type * as vscode from 'vscode';
import { EntityMappingManager } from '../src/entityMapping';
import { KBEngineImplementationProvider } from '../src/languageProviders';
import { makeTextDocument, Position, Uri, workspace as stubWorkspace } from './helpers/vscodeStub';

// IDE-NAV-007:def 方法到 Python 的实现查询(Go to Implementations)。验收
// 口径:按精确声明身份(名字+段)返回实现列表——绑定命中与段属主脚本同名
// 定义(owner 注册面);不含全项目唯一名回退(那是 F12 按名字猜的兜底,
// 不是实现);属性段/非 def 文档/取消位 null;跨段不串(Base 实现不进
// Cell 身份的列表)。

const AVATAR_DEF = [
  '<root>',
  '  <BaseMethods>',
  '    <reqPos>',
  '      <Arg>TIMESTAMP</Arg>',
  '    </reqPos>',
  '    <fooUnique/>',
  '  </BaseMethods>',
  '  <CellMethods>',
  '    <onTeleport/>',
  '  </CellMethods>',
  '  <Properties>',
  '    <hp>',
  '      <Type>UINT32</Type>',
  '    </hp>',
  '  </Properties>',
  '</root>'
].join('\n');

const BASE_PY = [
  'class Avatar(kbe.KBEntity):',
  '    def reqPos(self, stamp):',
  '        pass',
  ''
].join('\n');

const CELL_PY = [
  'class Avatar(kbe.KBEntity):',
  '    def onTeleport(self):',
  '        pass',
  ''
].join('\n');

const HELPER_PY = [
  'class Helper:',
  '    def fooUnique(self):',
  '        pass',
  ''
].join('\n');

const buildWorkspace = (): { root: string; avatarDef: string; basePy: string; cellPy: string } => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-nav007-'));
  const put = (relative: string, content: string): string => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, 'utf-8');
    return file;
  };
  const avatarDef = put('a/scripts/entity_defs/Avatar.def', AVATAR_DEF);
  const basePy = put('a/scripts/base/Avatar.py', BASE_PY);
  const cellPy = put('a/scripts/cell/Avatar.py', CELL_PY);
  put('a/scripts/base/helper.py', HELPER_PY);
  stubWorkspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
  return { root, avatarDef, basePy, cellPy };
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
  }
};

const makeManager = async (): Promise<EntityMappingManager> => {
  const manager = new EntityMappingManager({ subscriptions: [] } as never);
  await (manager as unknown as { waitForInitialScan(): Promise<void> }).waitForInitialScan();
  return manager;
};

describe('def 方法实现查询(IDE-NAV-007)', () => {
  it('精确身份出实现列表:BaseMethods reqPos → base 实现行,Cell 实现不串入', async () => {
    const ws = buildWorkspace();
    await withStubbedDefs(ws.avatarDef, async () => {
      const manager = await makeManager();
      const baseIdentity = {
        ownerKind: 'entity', ownerName: 'Avatar', sourceKind: 'declaration',
        sourceChain: [], section: 'BaseMethods' as const, symbolName: 'reqPos'
      };
      const list = await manager.listMethodImplementationsByIdentity(baseIdentity);
      expect(list).toHaveLength(1);
      expect(list[0].filePath).toBe(ws.basePy);
      expect(list[0].line).toBe(2);
      expect(list[0].character).toBe(8);

      const cellIdentity = { ...baseIdentity, section: 'CellMethods' as const, symbolName: 'onTeleport' };
      const cellList = await manager.listMethodImplementationsByIdentity(cellIdentity);
      expect(cellList).toHaveLength(1);
      expect(cellList[0].filePath).toBe(ws.cellPy);
      // 跨段隔离:Base 身份列表不含 cell 文件,反之亦然
      expect(list.some(item => item.filePath === ws.cellPy)).toBe(false);
      expect(cellList.some(item => item.filePath === ws.basePy)).toBe(false);
    });
  });

  it('无属主实现不猜:fooUnique 全项目唯一名也不进列表(与 F12 全局回退区分)', async () => {
    const ws = buildWorkspace();
    await withStubbedDefs(ws.avatarDef, async () => {
      const manager = await makeManager();
      const identity = {
        ownerKind: 'entity', ownerName: 'Avatar', sourceKind: 'declaration',
        sourceChain: [], section: 'BaseMethods' as const, symbolName: 'fooUnique'
      };
      expect(await manager.listMethodImplementationsByIdentity(identity)).toEqual([]);
    });
  });

  it('provider 面:身份链带名字+段,多实现出多 Location;属性段/非 def/取消位 null', async () => {
    const identityArgs: unknown[][] = [];
    const listArgs: unknown[][] = [];
    const manager = {
      resolveDefinitionSymbolAtPosition: (...args: unknown[]) => {
        identityArgs.push(args);
        return Promise.resolve({ symbolName: args[2], section: args[3] });
      },
      listMethodImplementationsByIdentity: (...args: unknown[]) => {
        listArgs.push(args);
        return Promise.resolve([
          { filePath: '/tmp/ws/scripts/base/Avatar.py', line: 2, character: 8 },
          { filePath: '/tmp/ws/interfaces/base/Avatar.py', line: 9, character: 8 }
        ]);
      }
    };
    const provider = new KBEngineImplementationProvider(manager as unknown as EntityMappingManager);
    const defDoc = makeTextDocument(AVATAR_DEF, { fileName: '/tmp/ws/scripts/entity_defs/Avatar.def' }) as never;
    const result = await provider.provideImplementation(defDoc, new Position(2, 6), undefined);
    expect(result).not.toBeNull();
    expect(result!).toHaveLength(2);
    expect(result![0].uri.fsPath).toBe('/tmp/ws/scripts/base/Avatar.py');
    expect(result![0].range.start.line).toBe(1);
    expect(result![0].range.start.character).toBe(8);
    expect(result![1].range.start.line).toBe(8);
    expect(identityArgs[0][2]).toBe('reqPos');
    expect(identityArgs[0][3]).toBe('BaseMethods');

    // 属性段(0 基 10 行 hp)→ null,不发身份解析
    const before = identityArgs.length;
    expect(await provider.provideImplementation(defDoc, new Position(11, 6), undefined)).toBeNull();
    expect(identityArgs.length).toBe(before);

    const pyDoc = makeTextDocument('class Avatar:\n    pass\n', {
      fileName: '/tmp/ws/scripts/base/Avatar.py', languageId: 'python'
    });
    expect(await provider.provideImplementation(pyDoc as never, new Position(2, 6), undefined)).toBeNull();

    const cancelled = { isCancellationRequested: true } as never;
    expect(await provider.provideImplementation(defDoc, new Position(2, 6), cancelled)).toBeNull();
    expect(listArgs).toHaveLength(1);
  });
});

// 类型面:vscode.ImplementationProvider 形状由注册锁(extension.test.ts
// implementationRegistrations)与上面 provider 调用共同覆盖
void (null as unknown as vscode.ImplementationProvider);
