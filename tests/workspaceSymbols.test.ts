import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { EntityMappingManager } from '../src/entityMapping';
import { KBEngineWorkspaceSymbolProvider } from '../src/languageProviders';
import { makeTextDocument, Position, Uri, workspace as stubWorkspace } from './helpers/vscodeStub';

// IDE-NAV-006:根范围工作区符号查询(Ctrl+T)。验收口径:按名称前缀查询
// 已索引符号,返回 root/文件信息,不触发全仓扫描——查询面只读内存索引
// (mappingIndexesByRoot),零 findFiles/零首扫;前缀大小写不敏感;属性=
// Field,方法=Method,containerName 带 rootName/段信息;取消位空。

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
  '</root>'
].join('\n');

const MONSTER_DEF = [
  '<root>',
  '  <CellMethods>',
  '    <reqMove>',
  '      <Arg>INT32</Arg>',
  '    </reqMove>',
  '  </CellMethods>',
  '</root>'
].join('\n');

const buildWorkspace = (): { root: string; avatarDef: string; monsterDef: string } => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-nav006-'));
  const put = (relative: string, content: string): string => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, 'utf-8');
    return file;
  };
  const avatarDef = put('a/scripts/entity_defs/Avatar.def', AVATAR_DEF);
  const monsterDef = put('b/scripts/entity_defs/Monster.def', MONSTER_DEF);
  stubWorkspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
  return { root, avatarDef, monsterDef };
};

const withStubbedDefs = async <T>(avatarDef: string, monsterDef: string, run: () => Promise<T>): Promise<T> => {
  const originalFindFiles = stubWorkspace.findFiles;
  let findFilesCalls = 0;
  stubWorkspace.findFiles = (async (glob?: string) => {
    findFilesCalls += 1;
    return glob === '**/*.def' ? [Uri.file(avatarDef), Uri.file(monsterDef)] : [];
  }) as typeof stubWorkspace.findFiles;
  try {
    return await run(findFilesCallCounter => {
      void findFilesCallCounter;
    }, { getCalls: () => findFilesCalls });
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

describe('工作区符号前缀查询(IDE-NAV-006)', () => {
  it('前缀查询跨 root 命中:req → Avatar.reqPos(BaseMethods)+Monster.reqMove(CellMethods),hp 不串入', async () => {
    const ws = buildWorkspace();
    await withStubbedDefs(ws.avatarDef, ws.monsterDef, async () => {
      const manager = await makeManager();
      const hits = manager.searchDefSymbolsByPrefix('req');
      expect(hits.map(hit => `${hit.rootName}.${hit.symbolName}`)).toEqual([
        'Avatar.reqPos', 'Monster.reqMove'
      ]);
      expect(hits[0].kind).toBe('method');
      expect(hits[0].section).toBe('BaseMethods');
      expect(hits[0].defFile).toBe(ws.avatarDef);
      expect(hits[0].rootName).toBe('Avatar');
      expect(hits[1].section).toBe('CellMethods');
      expect(hits[1].defFile).toBe(ws.monsterDef);

      // 属性面前缀:h → hp(Field);大小写不敏感:REQ 同样命中
      const propertyHits = manager.searchDefSymbolsByPrefix('h');
      expect(propertyHits).toHaveLength(1);
      expect(propertyHits[0].symbolName).toBe('hp');
      expect(propertyHits[0].kind).toBe('property');
      expect(manager.searchDefSymbolsByPrefix('REQ')).toHaveLength(2);
      expect(manager.searchDefSymbolsByPrefix('zzz')).toEqual([]);
    });
  });

  it('查询不触发全仓扫描:findFiles 调用数在首扫后不增长', async () => {
    const ws = buildWorkspace();
    await withStubbedDefs(ws.avatarDef, ws.monsterDef, async (_, counters) => {
      const manager = await makeManager();
      const before = counters.getCalls();
      manager.searchDefSymbolsByPrefix('req');
      manager.searchDefSymbolsByPrefix('hp');
      manager.searchDefSymbolsByPrefix('');
      expect(counters.getCalls(), '查询面零 findFiles(只读内存索引)').toBe(before);
    });
  });

  it('provider 面:SymbolInformation 带 root/段 containerName 与 def 文件位;取消位 null', async () => {
    const ws = buildWorkspace();
    await withStubbedDefs(ws.avatarDef, ws.monsterDef, async () => {
      const manager = await makeManager();
      const provider = new KBEngineWorkspaceSymbolProvider(manager);
      const symbols = await provider.provideWorkspaceSymbols('req', undefined);
      expect(symbols).not.toBeNull();
      expect(symbols!).toHaveLength(2);
      const [avatarReq, monsterReq] = symbols!;
      expect(avatarReq.name).toBe('reqPos');
      expect(avatarReq.containerName).toBe('Avatar · BaseMethods');
      expect(avatarReq.location.uri.fsPath).toBe(ws.avatarDef);
      expect(avatarReq.location.range.start.line).toBeGreaterThanOrEqual(0);

      const cancelled = { isCancellationRequested: true } as never;
      expect(await provider.provideWorkspaceSymbols('req', cancelled)).toBeNull();
    });
  });

  it('空前缀=全量在册符号(不猜不扫),hp/reqPos/reqMove 三条', async () => {
    const ws = buildWorkspace();
    await withStubbedDefs(ws.avatarDef, ws.monsterDef, async () => {
      const manager = await makeManager();
      const hits = manager.searchDefSymbolsByPrefix('');
      expect(hits.map(hit => hit.symbolName).sort()).toEqual(['hp', 'reqMove', 'reqPos']);
    });
  });
});

// Position 引用占位(makeTextDocument/Position 由 stub 提供,保持导入面一致)
void Position; void makeTextDocument;
