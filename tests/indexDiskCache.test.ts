// BG-WARM 索引磁盘缓存契约(2026-11-18 用户令,巡检单 kode-index-disk-cache.md):
// discovery(def 解析缓存)与 eventIndex(.py 事件索引)落 globalStorage 磁盘,
// 二次启动哈希校验秒级恢复,变更文件增量重建。
// 五钉子:
// ①冷扫→写盘→读回与缓存载荷逐字节等价(语义不变铁律:缓存只挪时机)
// ②二次启动命中→零文件重读(readFile 零调用)且恢复后索引与现算等价
// ③单 .py 变更→增量重建只触该文件(其余条目逐字节不动);消失文件条目丢弃
// ④schema/kode 版本不符→旧缓存整体弃用
// ⑤写盘失败静默降级(不 throw,返回 false)
// 附:python owner 漂移→对应 def 条目拒绝恢复(半边快照失效)。
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resetScanRootCache } from '../src/scanRoots';
import { workspace as stubWorkspace } from './helpers/vscodeStub';

// 受测模块(契约先写:模块尚不存在,先以接口面导入——实现落地前本文件红)
import {
  INDEX_CACHE_SCHEMA_VERSION,
  readIndexCache,
  writeIndexCache,
  serializeDefCacheEntries,
  sha256Of,
  type DefCacheDiskEntry,
  type EventIndexDiskEntry,
  type IndexCacheIo
} from '../src/backend/indexDiskCache';

const PY_A = 'import KBEngine\nclass Avatar(KBEngine.Entity):\n    def on_ev(self):\n        pass\n';
const PY_B = 'import KBEngine\nclass Monster(KBEngine.Entity):\n    def on_ev(self):\n        pass\n';

describe('BG-WARM 索引磁盘缓存契约(纯核 load/write)', () => {
  let dir = '';
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-idx-cache-io-'));
  });
  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('④ schema 版本升级→旧缓存弃用(null,不部分复活)', () => {
    writeIndexCache(dir, { schemaVersion: 'index-cache/0', kodeVersion: '0.2.0' }, {
      eventIndex: [{ path: '/ws/a.py', mtimeMs: 1, size: 1, indexed: { version: 0, methods: [], eventCalls: [], eventLines: [] } }]
    });
    expect(readIndexCache(dir, { schemaVersion: 'index-cache/1', kodeVersion: '0.2.0' })).toBeNull();
  });

  it('④ 扩展版本号滚动(nightly)→缓存仍命中(版本键分级:它不再是淘汰键)', () => {
    writeIndexCache(dir, { schemaVersion: INDEX_CACHE_SCHEMA_VERSION, kodeVersion: '0.1.0', engineMajor: '2' }, {
      eventIndex: [{ path: '/ws/a.py', mtimeMs: 1, size: 1, indexed: { version: 0, methods: [], eventCalls: [], eventLines: [] } }]
    });
    const loaded = readIndexCache(dir, { schemaVersion: INDEX_CACHE_SCHEMA_VERSION, kodeVersion: '0.2.0', engineMajor: '2' });
    expect(loaded?.payload.eventIndex?.[0]?.path).toBe('/ws/a.py');
  });

  it('④ 引擎 API 主版本变 → 旧缓存弃用(符号确实变了)', () => {
    writeIndexCache(dir, { schemaVersion: INDEX_CACHE_SCHEMA_VERSION, kodeVersion: '0.2.0', engineMajor: '2' }, {
      eventIndex: [{ path: '/ws/a.py', mtimeMs: 1, size: 1, indexed: { version: 0, methods: [], eventCalls: [], eventLines: [] } }]
    });
    expect(readIndexCache(dir, { schemaVersion: INDEX_CACHE_SCHEMA_VERSION, kodeVersion: '0.2.0', engineMajor: '3' })).toBeNull();
  });

  it('④ 旧缓存 meta 无 engineMajor 字段 → 按未知处理,不因此白扫一次', () => {
    // 手搓本改动前形态的 meta(无 engineMajor 键),验读侧不把它当不符
    fs.writeFileSync(
      path.join(dir, 'meta.json'),
      JSON.stringify({
        schemaVersion: INDEX_CACHE_SCHEMA_VERSION,
        kodeVersion: '0.2.0',
        savedAt: 1,
        sha: {},
        discoveryCount: 0,
        eventIndexCount: 0
      }),
      'utf8'
    );
    expect(readIndexCache(dir, { schemaVersion: INDEX_CACHE_SCHEMA_VERSION, kodeVersion: '9.9.9', engineMajor: '3' })).not.toBeNull();
  });

  it('① 写盘→读回载荷逐字节等价(meta 命中时)', () => {
    const entries: EventIndexDiskEntry[] = [
      {
        path: '/ws/a.py', mtimeMs: 111, size: 3,
        indexed: { version: 2, methods: [{ name: 'on_ev', line: 3 }], eventCalls: [{ api: 'addEvent', event: 'EV', eventOffset: 9 }], eventLines: [4] }
      }
    ];
    writeIndexCache(dir, { schemaVersion: INDEX_CACHE_SCHEMA_VERSION, kodeVersion: '0.2.0' }, { eventIndex: entries });
    const loaded = readIndexCache(dir, { schemaVersion: INDEX_CACHE_SCHEMA_VERSION, kodeVersion: '0.2.0' });
    expect(loaded).not.toBeNull();
    expect(JSON.stringify(loaded!.payload.eventIndex)).toBe(JSON.stringify(entries));
  });

  it('④ 产物内容被篡改(sha 不匹配)→该产物弃用', () => {
    writeIndexCache(dir, { schemaVersion: INDEX_CACHE_SCHEMA_VERSION, kodeVersion: '0.2.0' }, {
      eventIndex: [{ path: '/ws/a.py', mtimeMs: 1, size: 1, indexed: { version: 0, methods: [], eventCalls: [], eventLines: [] } }]
    });
    const file = JSON.parse(fs.readFileSync(path.join(dir, 'eventIndex.json'), 'utf8'));
    file[0].indexed.methods.push({ name: 'injected', line: 99 });
    fs.writeFileSync(path.join(dir, 'eventIndex.json'), JSON.stringify(file), 'utf8');
    const loaded = readIndexCache(dir, { schemaVersion: INDEX_CACHE_SCHEMA_VERSION, kodeVersion: '0.2.0' });
    expect(loaded!.payload.eventIndex).toBeUndefined();
  });

  it('⑤ 写盘失败静默降级:不 throw,返回 false', () => {
    const failingIo: IndexCacheIo = {
      readText: () => null,
      ensureDir: () => {},
      writeTextAtomic: () => { throw new Error('EACCES'); }
    };
    expect(() => {
      const ok = writeIndexCache(dir, { schemaVersion: INDEX_CACHE_SCHEMA_VERSION, kodeVersion: '0.2.0' }, { eventIndex: [] }, failingIo);
      expect(ok).toBe(false);
    }).not.toThrow();
  });

  it('sha256Of 稳定且内容敏感', () => {
    expect(sha256Of('abc')).toBe(sha256Of('abc'));
    expect(sha256Of('abc')).not.toBe(sha256Of('abd'));
  });
});

describe('BG-WARM eventIndex 落盘等价与增量(WorkspaceIndex 面)', () => {
  let root = '';
  let cacheDir = '';
  const originalFolders = stubWorkspace.workspaceFolders;
  const originalFindFiles = stubWorkspace.findFiles;
  const originalReadFile = (stubWorkspace as { fs?: { readFile?: unknown } }).fs;
  const originalStat = originalReadFile && (stubWorkspace.fs as { stat?: unknown }).stat;
  let readSpy: ReturnType<typeof vi.fn> | null = null;

  const writeFixture = (): void => {
    fs.writeFileSync(path.join(root, 'a.py'), PY_A);
    fs.writeFileSync(path.join(root, 'b.py'), PY_B);
  };

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-idx-ev-'));
    cacheDir = path.join(root, 'cache');
    fs.mkdirSync(cacheDir, { recursive: true });
    writeFixture();
    stubWorkspace.workspaceFolders = [{ uri: { fsPath: root } as never, name: 'ev', index: 0 }];
    resetScanRootCache();
  });
  afterAll(() => {
    stubWorkspace.workspaceFolders = originalFolders;
    stubWorkspace.findFiles = originalFindFiles;
    fs.rmSync(root, { recursive: true, force: true });
    resetScanRootCache();
  });

  const installReadSpy = (impl: (uriLike: { fsPath: string }) => Promise<Buffer>): void => {
    readSpy = vi.fn(impl);
    (stubWorkspace.fs as { readFile: unknown }).readFile = readSpy;
  };
  const restoreReadSpy = (): void => {
    if (originalReadFile) {
      (stubWorkspace.fs as { readFile: unknown }).readFile = (originalReadFile as { readFile: unknown }).readFile;
    }
    if (originalStat) {
      (stubWorkspace.fs as { stat: unknown }).stat = originalStat;
    }
    readSpy = null;
  };

  it(
    '① 冷扫→capture→写盘;② 新实例读回恢复:零文件重读且索引逐字节等价',
    async () => {
      const { WorkspaceIndex } = await import('../src/workspaceIndex');
      // 冷扫(真读盘)
      stubWorkspace.findFiles = (async () => [
        { fsPath: path.join(root, 'a.py') },
        { fsPath: path.join(root, 'b.py') }
      ]) as unknown as typeof stubWorkspace.findFiles;
      installReadSpy(async (uriLike) => fs.promises.readFile(uriLike.fsPath) as Buffer);
      const cold = new WorkspaceIndex();
      await cold.ensureStarted();
      const entries = await cold.captureEventIndexSnapshot();
      cold.dispose();
      expect(entries).toHaveLength(2);
      const okWrite = writeIndexCache(cacheDir, { schemaVersion: INDEX_CACHE_SCHEMA_VERSION, kodeVersion: '0.2.0' }, { eventIndex: entries });
      expect(okWrite).toBe(true);
      restoreReadSpy();

      // 二次启动:命中恢复。任何重读盘都是契约违反(②零文件重读)。
      const boom = vi.fn(async () => { throw new Error('cache hit must not read files'); });
      (stubWorkspace.fs as { readFile: unknown }).readFile = boom;
      const warm = new WorkspaceIndex();
      const restore = await warm.restoreFromCache(entries);
      expect(restore.tookOver).toBe(true);
      expect(restore.restored).toBe(2);
      expect(restore.rebuilt).toBe(0);
      expect(boom).not.toHaveBeenCalled();
      // 索引内容与现算逐字节等价(①铁律):恢复实例快照 === 冷扫快照
      const warmEntries = await warm.captureEventIndexSnapshot();
      expect(JSON.stringify(warmEntries)).toBe(JSON.stringify(entries));
      // started 语义:ensureStarted 幂等秒回,不再全扫
      await warm.ensureStarted();
      expect(boom).not.toHaveBeenCalled();
      warm.dispose();
      restoreReadSpy();
    },
    120_000
  );

  it('③ 单 .py 变更→增量只触该文件;其余条目逐字节不动;消失文件丢弃', async () => {
    const { WorkspaceIndex } = await import('../src/workspaceIndex');
    // 变更 b.py 内容(size 变),删除场景用独立目录模拟:这里先做「漂移重建」臂
    fs.writeFileSync(path.join(root, 'b.py'), `${PY_B}\ndef extra(self):\n    pass\n`);
    stubWorkspace.findFiles = (async () => [
      { fsPath: path.join(root, 'a.py') },
      { fsPath: path.join(root, 'b.py') }
    ]) as unknown as typeof stubWorkspace.findFiles;
    let reads = 0;
    installReadSpy(async (uriLike) => {
      reads += 1;
      return fs.promises.readFile(uriLike.fsPath) as Buffer;
    });
    // 用钉子①写盘时的旧 payload(对应旧 b.py)恢复→只有 b.py 漂移
    const loaded = readIndexCache(cacheDir, { schemaVersion: INDEX_CACHE_SCHEMA_VERSION, kodeVersion: '0.2.0' });
    expect(loaded).not.toBeNull();
    const staleEntries = loaded!.payload.eventIndex!;
    const warm = new WorkspaceIndex();
    const restore = await warm.restoreFromCache(staleEntries);
    expect(restore.tookOver).toBe(true);
    expect(restore.restored).toBe(1);          // a.py 命中
    expect(restore.rebuilt).toBe(1);           // 只有 b.py 重扫
    expect(reads).toBe(1);                     // ③只触该文件(单文件重读恰一次)
    // a.py 条目逐字节不动
    const aEntryOld = staleEntries.find(e => e.path.endsWith('a.py'))!;
    const aEntryNew = (await warm.captureEventIndexSnapshot()).find(e => e.path.endsWith('a.py'))!;
    expect(JSON.stringify(aEntryNew)).toBe(JSON.stringify(aEntryOld));
    warm.dispose();

    // 消失文件:b.py 删除后用旧 payload 恢复→b.py 条目丢弃不复活
    fs.unlinkSync(path.join(root, 'b.py'));
    stubWorkspace.findFiles = (async () => [
      { fsPath: path.join(root, 'a.py') }
    ]) as unknown as typeof stubWorkspace.findFiles;
    const after = new WorkspaceIndex();
    const restore2 = await after.restoreFromCache(staleEntries);
    expect(restore2.restored).toBe(1);
    const afterEntries = await after.captureEventIndexSnapshot();
    expect(afterEntries).toHaveLength(1);
    expect(afterEntries[0].path.endsWith('a.py')).toBe(true);
    after.dispose();
    restoreReadSpy();
    // 还原 fixture 给后续用例
    writeFixture();
  }, 120_000);
});

describe('BG-WARM discovery 落盘恢复(EntityMappingManager 面)', () => {
  let root = '';
  let cacheDir = '';
  const originalFolders = stubWorkspace.workspaceFolders;
  const originalFindFiles = stubWorkspace.findFiles;
  const originalCreateWatcher = stubWorkspace.createFileSystemWatcher;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-idx-def-'));
    cacheDir = path.join(root, 'cache');
    fs.mkdirSync(cacheDir, { recursive: true });
    const defDir = path.join(root, 'scripts', 'entity_defs');
    fs.mkdirSync(defDir, { recursive: true });
    fs.writeFileSync(path.join(defDir, 'Hero.def'), ['<root>', '  <Properties>', '  </Properties>', '</root>'].join('\n'), 'utf8');
    fs.writeFileSync(path.join(defDir, 'Pet.def'), ['<root>', '  <Properties>', '  </Properties>', '</root>'].join('\n'), 'utf8');
    stubWorkspace.workspaceFolders = [{ uri: { fsPath: root } as never, name: 'def', index: 0 }];
    stubWorkspace.findFiles = (async () => [
      { fsPath: path.join(defDir, 'Hero.def') },
      { fsPath: path.join(defDir, 'Pet.def') }
    ]) as unknown as typeof stubWorkspace.findFiles;
    resetScanRootCache();
  });
  afterAll(() => {
    stubWorkspace.workspaceFolders = originalFolders;
    stubWorkspace.findFiles = originalFindFiles;
    stubWorkspace.createFileSystemWatcher = originalCreateWatcher;
    fs.rmSync(root, { recursive: true, force: true });
    resetScanRootCache();
  });

  const makeContext = (): { subscriptions: unknown[] } => ({ subscriptions: [] });

  it(
    '① 真扫→capture→写盘;② 新 manager 注入恢复:零重解析且映射面等价;③ def 漂移→只重建该 def',
    async () => {
      const { EntityMappingManager } = await import('../src/entityMapping');
      const { IndexScheduler } = await import('../src/backend/indexScheduler');

      // 冷扫(manager 真实首扫)
      const scheduler1 = new IndexScheduler();
      const cold = new EntityMappingManager(makeContext() as never, scheduler1);
      await cold.waitForInitialScan();
      expect(cold.isInitialScanComplete()).toBe(true);
      const coldEntries = await cold.captureDefParseCacheSnapshot();
      expect(coldEntries.length).toBe(2);
      const okWrite = writeIndexCache(cacheDir, { schemaVersion: INDEX_CACHE_SCHEMA_VERSION, kodeVersion: '0.2.0' }, { discovery: coldEntries });
      expect(okWrite).toBe(true);
      const coldMappings = JSON.stringify([...cold.getAllMappings()].sort((a, b) => (a.name < b.name ? -1 : 1)));

      // ② 二次启动:从盘读回投影载荷注入 defParseCache → 首扫批次 mtime 全命中零重解析
      const loaded = readIndexCache(cacheDir, { schemaVersion: INDEX_CACHE_SCHEMA_VERSION, kodeVersion: '0.2.0' });
      expect(loaded).not.toBeNull();
      const diskEntries = loaded!.payload.discovery!;
      expect(diskEntries).toHaveLength(2);
      const scheduler2 = new IndexScheduler();
      const warm = new EntityMappingManager(makeContext() as never, scheduler2, { deferStartup: true });
      const restore = await warm.restoreDefParseCacheFromDisk(diskEntries);
      expect(restore.discovered).toBe(2);
      expect(restore.injected).toBe(2);
      expect(restore.rejected).toBe(0);
      await warm.waitForInitialScan();
      expect(warm.isInitialScanComplete()).toBe(true);
      expect(JSON.stringify([...warm.getAllMappings()].sort((a, b) => (a.name < b.name ? -1 : 1)))).toBe(coldMappings); // ①铁律:等价
      // 载荷投影序列化两侧逐字节等价(冷扫快照 vs 盘上读回,同一投影口径)
      expect(serializeDefCacheEntries(await warm.captureDefParseCacheSnapshot())).toBe(serializeDefCacheEntries(diskEntries));
      // 恢复后再 ensureStartup 幂等不重扫
      warm.ensureStartup();

      // ③ def 漂移:Pet.def 变更→只重建 Pet,Hero 命中
      fs.writeFileSync(
        path.join(root, 'scripts', 'entity_defs', 'Pet.def'),
        ['<root>', '  <Properties>', '    <level>', '      <Type> UINT32 </Type>', '    </level>', '  </Properties>', '</root>'].join('\n'),
        'utf8'
      );
      const scheduler3 = new IndexScheduler();
      const warm3 = new EntityMappingManager(makeContext() as never, scheduler3, { deferStartup: true });
      const restore3 = await warm3.restoreDefParseCacheFromDisk(coldEntries);
      expect(restore3.injected).toBe(1);    // Hero 注入
      expect(restore3.rejected).toBe(1);    // Pet 漂移拒收
      await warm3.waitForInitialScan();
      expect(warm3.isInitialScanComplete()).toBe(true);
      // 重建后的 Pet 映射含新属性
      const pet = warm3.getAllMappings().find(m => m.name === 'Pet');
      expect(pet).toBeDefined();
      expect(Object.keys(pet!.properties)).toContain('level');
    },
    180_000
  );

  it('python owner 漂移(半边快照失效)→对应 def 条目拒收注入,全扫真重建', async () => {
    const { EntityMappingManager } = await import('../src/entityMapping');
    const { IndexScheduler } = await import('../src/backend/indexScheduler');
    const heroDef = path.join(root, 'scripts', 'entity_defs', 'Hero.def');
    const stat = fs.statSync(heroDef);
    // 手工构造:Hero 条目带一条漂移的 python owner 快照(mtime 不匹配盘上真 .py)
    const staleOwnerPy = path.join(root, 'scripts', 'Hero.py');
    fs.writeFileSync(staleOwnerPy, 'class Hero:\n    pass\n', 'utf8');
    const entry: DefCacheDiskEntry = {
      defPath: heroDef,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      pythonOwners: [{ path: staleOwnerPy, mtimeMs: stat.mtimeMs - 86_400_000, size: 1 }],
      index: {
        rootName: 'Hero', rootCategory: 'entity', rootDefFile: heroDef,
        semantics: { category: 'entity', owner: { filePath: heroDef } } as never,
        propertyDefinitions: [], methodDefinitions: [], pythonOwnerFiles: [], pythonMethods: []
      }
    };
    const scheduler = new IndexScheduler();
    const manager = new EntityMappingManager(makeContext() as never, scheduler, { deferStartup: true });
    const restore = await manager.restoreDefParseCacheFromDisk([entry]);
    expect(restore.injected).toBe(0);    // 拒收
    expect(restore.rejected).toBe(1);
    await manager.waitForInitialScan();
    expect(manager.isInitialScanComplete()).toBe(true);
  }, 120_000);
});
