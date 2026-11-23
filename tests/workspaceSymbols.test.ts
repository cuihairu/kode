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

// RUST-139 收口(嵌套属性符号面):属性级 <Properties> 子项 + ARRAY <Type><of>
// 合成元素。行号:bagData=3,itemId=6,slots=11。
const NESTED_AVATAR_DEF = [
  '<root>',
  '  <Properties>',
  '    <bagData>',
  '      <Type>FIXED_DICT</Type>',
  '      <Properties>',
  '        <itemId>',
  '          <Type>UINT32</Type>',
  '        </itemId>',
  '      </Properties>',
  '    </bagData>',
  '    <slots>',
  '      <Type>',
  '        ARRAY',
  '        <of>UINT8</of>',
  '      </Type>',
  '    </slots>',
  '  </Properties>',
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
    return glob.endsWith('.def') ? [Uri.file(avatarDef), Uri.file(monsterDef)] : [];
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

  it('嵌套属性符号面(RUST-139 收口):<Properties> 子项与 ARRAY <of> 元素各自独立符号,provider 面照出', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-nav006-nested-'));
    const defPath = path.join(root, 'scripts', 'entity_defs', 'Avatar.def');
    fs.mkdirSync(path.dirname(defPath), { recursive: true });
    fs.writeFileSync(defPath, NESTED_AVATAR_DEF, 'utf-8');
    const originalFindFiles = stubWorkspace.findFiles;
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
    stubWorkspace.findFiles = (async (glob?: string) =>
      glob.endsWith('.def') ? [Uri.file(defPath)] : []) as typeof stubWorkspace.findFiles;
    try {
      const manager = await makeManager();
      // 嵌套 FIXED_DICT 子项独立符号(行=自身声明行)
      const nested = manager.searchDefSymbolsByPrefix('itemid');
      expect(nested).toHaveLength(1);
      expect(nested[0].symbolName).toBe('itemId');
      expect(nested[0].kind).toBe('property');
      expect(nested[0].rootName).toBe('Avatar');
      expect(nested[0].line).toBe(6);
      // ARRAY <of> 合成元素:名恒 value、行=父属性行
      const elem = manager.searchDefSymbolsByPrefix('value');
      expect(elem).toHaveLength(1);
      expect(elem[0].symbolName).toBe('value');
      expect(elem[0].line).toBe(11);
      // provider 面照出(SymbolInformation 名/容器/落点;无门回 TS 链)
      const provider = new KBEngineWorkspaceSymbolProvider(manager);
      const symbols = await provider.provideWorkspaceSymbols('value', undefined);
      expect(symbols).not.toBeNull();
      expect(symbols!).toHaveLength(1);
      expect(symbols![0].name).toBe('value');
      expect(symbols![0].containerName).toBe('Avatar');
      expect(symbols![0].location.uri.fsPath).toBe(defPath);
    } finally {
      stubWorkspace.findFiles = originalFindFiles;
      stubWorkspace.workspaceFolders = [];
    }
  });
});

// Position 引用占位(makeTextDocument/Position 由 stub 提供,保持导入面一致)
void Position; void makeTextDocument;
