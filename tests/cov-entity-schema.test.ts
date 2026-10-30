import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EntityMappingManager, type EntityMapping } from '../src/entityMapping';
import { DiagnosticScheduler } from '../src/diagnosticScheduler';
import { resetLanguageServiceMetrics } from '../src/languageServiceMetrics';
import { clearRecentJumpLogs, getRecentJumpLogs, setJumpLogEnabled } from '../src/navigationLog';
import {
  buildEntityTypeStubContent,
  buildEntityTypeStubPlan,
  exportEntityTypeStubs
} from '../src/entityTypeStubs';
import {
  buildDatabaseSchemaSnapshotAsync,
  buildTypeStorageUsageIndexPhased,
  cancelDatabaseSchemaSnapshotBuild,
  cancelTypeStorageUsageColdBuild,
  clearDatabaseSchemaCacheForTests,
  findTypeStorageUsages,
  findTypeStorageUsagesReadOnly,
  flushTypeStorageUsageColdBuildForTests,
  getPendingTypeStorageColdBuildCount,
  indexTypeStorageUsagesBySourceLine,
  invalidateTypeStorageUsageIndex,
  isDatabaseSchemaSnapshotInputStale,
  peekPublishedDatabaseSchemaSnapshot,
  replaceTypeStorageUsageForEntity,
  scheduleDatabaseSchemaSnapshotBuild,
  setTypeStorageUsageBackgroundDispatcher,
  type DatabaseSchemaSnapshot
} from '../src/databaseSchema';
import { aliasDigestInMap, parseTypeAliasesFromContent } from '../src/databaseSchemaCore';
import {
  getWorkspaceIndexYieldCountForTests,
  resetWorkspaceIndexYieldClockForTests,
  setWorkspaceIndexYieldSliceMsForTests,
  WorkspaceIndex
} from '../src/workspaceIndex';
import {
  allFileSystemWatchers,
  configurationOverrides,
  makeTextDocument,
  memoryFileSystem,
  messages,
  Uri,
  workspace as stubWorkspace,
  workspaceEvents,
  workspaceState,
  type StubFileSystemWatcher
} from './helpers/vscodeStub';

// 补覆盖(对账 coverage/lcov.info DA:0 散点):entityMapping / databaseSchema /
// diagnosticScheduler / workspaceIndex / entityTypeStubs 的守卫与早落分支。
// 每条用例都锚真实行为;确证不可达的分支在文件尾备注,不硬凑。

const until = async (probe: () => boolean, what: string, timeoutMs = 8000): Promise<void> => {
  const start = Date.now();
  while (!probe()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timeout waiting for ${what}`);
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};

// ---------------------------------------------------------------------------
// diagnosticScheduler:开关/取消/守卫散点
// ---------------------------------------------------------------------------

describe('diagnosticScheduler 守卫分支', () => {
  beforeEach(() => {
    resetLanguageServiceMetrics();
  });

  afterEach(() => {
    resetLanguageServiceMetrics();
  });

  interface StubDoc {
    uri: { toString(): string };
    version: number;
  }
  const makeDoc = (fileName: string, version: number): StubDoc => ({
    uri: { toString: () => `file:///${fileName}` },
    version
  });

  it('开关关闭期 requestQueued 只记账不排队(disabledSkipped)', () => {
    const scheduler = new DiagnosticScheduler();
    expect(scheduler.setEnabled(false, () => undefined)).toBe(true);
    const compute = vi.fn(() => [1]);
    scheduler.requestQueued(makeDoc('a.def', 1), { layer: 'local', compute, publish: () => undefined });
    expect(compute).not.toHaveBeenCalled();
    expect(scheduler.getStats().disabledSkipped).toBe(1);
    expect(scheduler.hasQueuedTasks()).toBe(false);
  });

  it('开关关闭期 flushQueued 直接返回,不处理任何排队条目', async () => {
    const scheduler = new DiagnosticScheduler();
    scheduler.setEnabled(false, () => undefined);
    const compute = vi.fn(() => [1]);
    scheduler.requestQueued(makeDoc('a.def', 1), { layer: 'local', compute, publish: () => undefined });
    // 关闭期入队被拒,这里补一条先入队再关闭的路径:重开后队列已被清
    await scheduler.flushQueued();
    expect(compute).not.toHaveBeenCalled();
  });

  it('时间片让出窗口内开关关闭:剩余条目不再计算,量规清零', async () => {
    // sliceMs=0 使首个条目后必让出;让出面里关闸 → 263-264 提前收工
    const scheduler: DiagnosticScheduler = new DiagnosticScheduler({
      sliceMs: 0,
      yieldToHost: async () => {
        scheduler.setEnabled(false, () => undefined);
      }
    });
    const published: number[] = [];
    const secondCompute = vi.fn(() => [2]);
    scheduler.requestQueued(makeDoc('one.def', 1), {
      layer: 'local', compute: () => [1], publish: items => published.push(...items)
    });
    scheduler.requestQueued(makeDoc('two.def', 1), {
      layer: 'local', compute: secondCompute, publish: items => published.push(...items)
    });
    await scheduler.flushQueued();
    expect(published).toEqual([1]); // 第一个条目已发布
    expect(secondCompute).not.toHaveBeenCalled(); // 第二个在让出窗口后被丢弃
    expect(scheduler.pendingWorkload()).toEqual({ queued: 0, inFlight: 0 });
    expect(scheduler.getStats().published).toBe(1);
  });

  it('排队条目命中同版本已发布:零重算直接跳过(skippedCurrentVersion)', async () => {
    const scheduler = new DiagnosticScheduler();
    const doc = makeDoc('a.def', 7);
    const published: number[][] = [];
    scheduler.request(doc, { layer: 'local', compute: () => [1], publish: items => published.push([...items]) });
    scheduler.requestQueued(doc, { layer: 'local', compute: () => [1], publish: items => published.push([...items]) });
    await scheduler.flushQueued();
    // request 发布一次;排队条目出队时发现同版本+同代已发布 → 只记跳过
    expect(published).toEqual([[1]]);
    expect(scheduler.getStats().skippedCurrentVersion).toBe(1);
  });

  it('空调度器 hasQueuedTasks 为 false(无排队条目面)', () => {
    expect(new DiagnosticScheduler().hasQueuedTasks()).toBe(false);
  });

  it('文档关闭时释放残留排队任务并记 coalescedStale', () => {
    const scheduler = new DiagnosticScheduler();
    const doc = makeDoc('a.def', 1);
    scheduler.requestQueued(doc, { layer: 'local', compute: () => [1], publish: () => undefined });
    expect(scheduler.hasQueuedTasks()).toBe(true);
    scheduler.releaseDocument(doc);
    expect(scheduler.getStats().coalescedStale).toBe(1);
    expect(scheduler.getStats().cleared).toBe(1);
    expect(scheduler.hasQueuedTasks()).toBe(false);
  });

  it('异步计算失败:错误面自摘在途登记并原样外抛', async () => {
    const scheduler = new DiagnosticScheduler();
    const publish = vi.fn();
    scheduler.request(makeDoc('boom.def', 1), {
      layer: 'semantic',
      computeAsync: () => Promise.reject(new Error('worker boom')),
      publish
    });
    expect(scheduler.hasPendingComputations()).toBe(true);
    await expect(scheduler.pendingComputations()).rejects.toThrow('worker boom');
    expect(scheduler.hasPendingComputations()).toBe(false);
    expect(publish).not.toHaveBeenCalled();
    expect(scheduler.getStats().published).toBe(0);
  });

  it('同步计算期间版本前进:结果丢弃不发布(staleDropped)', () => {
    const scheduler = new DiagnosticScheduler();
    const doc = makeDoc('a.def', 1);
    const publish = vi.fn();
    scheduler.request(doc, {
      layer: 'local',
      // 计算面推进文档版本:发布守卫必须丢弃这批与新版本不匹配的结果
      compute: () => { doc.version = 2; return [1]; },
      publish
    });
    expect(publish).not.toHaveBeenCalled();
    const stats = scheduler.getStats();
    expect(stats.staleDropped).toBe(1);
    expect(stats.published).toBe(0);
  });

  it('同步计算期间文档关闭:结果不写 collection(releasedDropped)', () => {
    const scheduler = new DiagnosticScheduler();
    const doc = makeDoc('a.def', 1);
    const publish = vi.fn();
    scheduler.request(doc, {
      layer: 'local',
      compute: () => { scheduler.releaseDocument(doc); return [1]; },
      publish
    });
    expect(publish).not.toHaveBeenCalled();
    const stats = scheduler.getStats();
    expect(stats.releasedDropped).toBe(1);
    expect(stats.published).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// entityTypeStubs:导出开关/一致性跳过/写失败告警/方法面与内容生成散点
// ---------------------------------------------------------------------------

describe('entityTypeStubs 守卫分支', () => {
  const originalFolders = stubWorkspace.workspaceFolders;

  afterEach(() => {
    configurationOverrides.delete('kbengine');
    stubWorkspace.workspaceFolders = originalFolders;
    messages.warning.length = 0;
  });

  const stubManager = { getAllMappings: () => [] } as unknown as EntityMappingManager;

  const stubMapping = {
    name: 'Guy',
    defFile: '/ws-estub/scripts/entity_defs/Guy.def',
    pythonFile: '/ws-estub/scripts/base/Guy.py',
    pythonFiles: [],
    properties: { hp: { defFile: '/ws-estub/scripts/entity_defs/Guy.def', line: 4 } },
    methods: {}
  } as unknown as EntityMapping;

  const folders = (): void => {
    stubWorkspace.workspaceFolders = [{ uri: Uri.file('/ws-estub'), name: 'estub', index: 0 }];
  };

  it('总闸 python.stubExport=false:导出立即返回空,不触任何 deps', async () => {
    folders();
    configurationOverrides.set('kbengine', { 'python.stubExport': false });
    const deps = {
      exists: () => { throw new Error('must not probe'); },
      readFile: () => { throw new Error('must not read'); },
      writeFile: () => { throw new Error('must not write'); },
      mkdir: () => { throw new Error('must not mkdir'); }
    };
    const written = await exportEntityTypeStubs(stubManager, deps, { listMappings: () => [stubMapping] });
    expect(written).toEqual([]);
  });

  it('读现有存根抛错按陈旧处理:捕获后照常重写', async () => {
    folders();
    const writes = new Map<string, string>();
    const made: string[] = [];
    const written = await exportEntityTypeStubs(stubManager, {
      exists: () => true,
      readFile: () => { throw new Error('EACCES'); },
      writeFile: (file, content) => { writes.set(file, content); },
      mkdir: dir => { made.push(dir); }
    }, { listMappings: () => [stubMapping] });
    expect(written).toEqual(['estub']);
    expect(made).toHaveLength(1);
    expect([...writes.keys()].some(file => file.endsWith('entity_types.pyi'))).toBe(true);
  });

  it('盘上存根与计划一致:unchanged 跳过,不再 mkdir/写盘', async () => {
    folders();
    const writes = new Map<string, string>();
    const first = await exportEntityTypeStubs(stubManager, {
      exists: file => writes.has(file),
      readFile: file => writes.get(file) ?? '',
      writeFile: (file, content) => { writes.set(file, content); },
      mkdir: () => undefined
    }, { listMappings: () => [stubMapping] });
    expect(first).toEqual(['estub']);
    const target = [...writes.keys()].find(file => file.endsWith('entity_types.pyi'))!;
    const made = vi.fn();
    const second = await exportEntityTypeStubs(stubManager, {
      exists: file => file === target,
      readFile: () => writes.get(target)!,
      writeFile: () => { throw new Error('must not rewrite'); },
      mkdir: made
    }, { listMappings: () => [stubMapping] });
    expect(second).toEqual([]); // 内容未变:静默跳过
    expect(made).not.toHaveBeenCalled();
  });

  it('写盘失败且非 silent:弹告警并返回空(不抛出)', async () => {
    folders();
    const written = await exportEntityTypeStubs(stubManager, {
      exists: () => false,
      readFile: () => '',
      writeFile: () => { throw new Error('disk full'); },
      mkdir: () => { throw new Error('no dir'); }
    }, { listMappings: () => [stubMapping] });
    expect(written).toEqual([]);
    expect(messages.warning.some(text => text.includes('实体类型桩导出失败') && text.includes('estub'))).toBe(true);
  });

  it('方法声明不在三段(Base/Cell/Client)内:该方法不进存根面', () => {
    const oddSectionMapping = {
      ...stubMapping,
      properties: {},
      methods: {
        weird: [{ defFile: stubMapping.defFile, line: 9, section: 'Interfaces', exposed: false, declaredArgs: [] }]
      }
    } as unknown as EntityMapping;
    const plan = buildEntityTypeStubPlan([oddSectionMapping], []);
    // 无属性也无合法段方法:该实体整体落出存根
    expect(plan.entries).toEqual([]);
    expect(plan.content).toBeNull();
  });

  it('注解引用跨两个 kbe_types 镜像模块:导入按模块路径排序成组', () => {
    const content = buildEntityTypeStubContent(
      [
        { entity: 'AlphaUser', properties: [{ name: 'pa', annotation: 'ALPHA_T', sourceLine: 3 }], methods: [] },
        { entity: 'BetaUser', properties: [{ name: 'pb', annotation: 'BETA_T', sourceLine: 3 }], methods: [] }
      ],
      [],
      new Map([
        ['ALPHA_T', 'scripts.entity_defs.kbe_types'],
        ['BETA_T', 'kbe_types']
      ])
    );
    const lines = content.split('\n');
    const rootImport = lines.indexOf('from kbe_types import BETA_T');
    const nestedImport = lines.indexOf('from scripts.entity_defs.kbe_types import ALPHA_T');
    expect(rootImport).toBeGreaterThanOrEqual(0);
    expect(nestedImport).toBeGreaterThanOrEqual(0);
    expect(rootImport).toBeLessThan(nestedImport); // 模块路径字典序
    expect(content).toContain('    pa: ALPHA_T');
    expect(content).toContain('    pb: BETA_T');
  });

  it('无属性无方法的实体条目:类体落 pass 占位', () => {
    const content = buildEntityTypeStubContent(
      [{ entity: 'Bare', properties: [], methods: [] }],
      [],
      new Map()
    );
    expect(content).toContain('class Bare(Entity):');
    expect(content).toMatch(/class Bare\(Entity\):\n[ ]{4}pass/);
  });
});

// ---------------------------------------------------------------------------
// workspaceIndex:rename/脏文档/让出窗口守卫/读失败/方法面
// ---------------------------------------------------------------------------

describe('workspaceIndex 守卫分支', () => {
  afterEach(() => {
    workspaceState.reset();
  });

  const startEmpty = async (): Promise<WorkspaceIndex> => {
    const index = new WorkspaceIndex();
    expect(await index.allEventCalls()).toEqual([]);
    return index;
  };

  it('rename 到 .py 且旧路径无缓存:转对新 URI 建索引', async () => {
    const index = await startEmpty();
    try {
      memoryFileSystem.set('/ws/renamed.py', 'self.addEvent(EV_MOVED, self.on_moved)\n');
      workspaceEvents.filesRenamed.fire({
        files: [{ oldUri: Uri.file('/ws/notes.txt'), newUri: Uri.file('/ws/renamed.py') }]
      });
      // indexFile 内有一次时间片让出(宏任务),等两跳再断言
      await new Promise(resolve => setImmediate(() => setImmediate(resolve)));
      const calls = await index.allEventCalls();
      expect(calls).toHaveLength(1);
      expect(calls[0].file).toBe('/ws/renamed.py');
      expect(calls[0].call.event).toBe('EV_MOVED');
    } finally {
      index.dispose();
    }
  });

  it('启动时有脏文档:直接按缓冲区内容建索引(不读盘)', async () => {
    // 带 def 行:noteSaved 的方法正则 map 回调才真正执行(空匹配不会进回调)
    const dirty = makeTextDocument('def on_d(self):\n    self.addEvent(EV_DIRTY, self.on_d)\n', {
      fileName: '/ws/dirty.py',
      languageId: 'python',
      uri: Uri.file('/ws/dirty.py')
    });
    (dirty as { isDirty?: boolean }).isDirty = true;
    stubWorkspace.textDocuments = [dirty];
    const index = new WorkspaceIndex();
    try {
      const calls = await index.allEventCalls();
      expect(calls).toHaveLength(1);
      expect(calls[0].file).toBe('/ws/dirty.py');
    } finally {
      index.dispose();
      stubWorkspace.textDocuments = [];
    }
  });

  it('watcher 建索引时该文件正被脏文档持有:走保存面缓存', async () => {
    const index = await startEmpty();
    const dirty = makeTextDocument('self.addEvent(EV_FRESH, self.on_f)\n', {
      fileName: '/ws/fresh.py',
      languageId: 'python',
      uri: Uri.file('/ws/fresh.py')
    });
    (dirty as { isDirty?: boolean }).isDirty = true;
    stubWorkspace.textDocuments = [dirty];
    try {
      memoryFileSystem.set('/ws/fresh.py', 'self.addEvent(EV_STALE, self.on_s)\n');
      const watcher = allFileSystemWatchers[allFileSystemWatchers.length - 1];
      watcher.fireCreate(Uri.file('/ws/fresh.py'));
      await new Promise(resolve => setImmediate(resolve));
      // 脏文档优先:收录的是缓冲区事件,不是盘上内容
      const calls = await index.allEventCalls();
      expect(calls).toHaveLength(1);
      expect(calls[0].call.event).toBe('EV_FRESH');
    } finally {
      index.dispose();
      stubWorkspace.textDocuments = [];
    }
  });

  it('让出窗口内文件被删除:让出后复核版本失配,弃本次解析', async () => {
    setWorkspaceIndexYieldSliceMsForTests(0); // 每个批边界必让出,时序确定
    const index = await startEmpty();
    const uri = Uri.file('/ws/racy.py');
    memoryFileSystem.set('/ws/racy.py', 'self.addEvent(EV_RACY, self.on_r)\n');
    const originalReadFile = stubWorkspace.fs.readFile;
    // 读盘在宏任务边界落定后再排一个删除事件:它落在首让出(setImmediate)
    // 之前 → 让出回来复核 revision 已前进 → 按缓存口径返回(此处为 null)
    stubWorkspace.fs.readFile = ((target: Uri) =>
      new Promise<Uint8Array>(resolve => {
        setImmediate(() => {
          resolve(Buffer.from('self.addEvent(EV_RACY, self.on_r)\n'));
          setImmediate(() => {
            allFileSystemWatchers[allFileSystemWatchers.length - 1].fireDelete(target);
          });
        });
      })) as typeof stubWorkspace.fs.readFile;
    try {
      const watcher = allFileSystemWatchers[allFileSystemWatchers.length - 1];
      watcher.fireCreate(uri);
      await new Promise(resolve => setImmediate(() => setImmediate(resolve)));
      await new Promise(resolve => setImmediate(resolve));
      expect(await index.allEventCalls()).toEqual([]);
    } finally {
      stubWorkspace.fs.readFile = originalReadFile;
      setWorkspaceIndexYieldSliceMsForTests(null);
      index.dispose();
    }
  });

  it('删除事件落在两次让出之间:第二次复核失配,弃本次解析', async () => {
    setWorkspaceIndexYieldSliceMsForTests(0); // 批边界必让出,setImmediate FIFO 相序确定
    const index = await startEmpty();
    const racy = Uri.file('/ws/racy2.py');
    const trigger = Uri.file('/ws/trigger.py');
    const originalReadFile = stubWorkspace.fs.readFile;
    // racy 读盘先落定(其第一让出随之入队);trigger 读盘落定那一刻再排一个对
    // racy 的删除:FIFO 里它恰插在 racy 两次让出之间 → 第一复核通过、第二复核
    // 失配 → 弃本次解析;trigger 自身不受连坐,照常入账
    stubWorkspace.fs.readFile = ((target: Uri) =>
      new Promise<Uint8Array>(resolve => {
        setImmediate(() => {
          resolve(Buffer.from(target === trigger
            ? 'self.addEvent(EV_TRIGGER, self.on_t)\n'
            : 'self.addEvent(EV_RACY2, self.on_r)\n'));
          if (target === trigger) {
            setImmediate(() => {
              allFileSystemWatchers[allFileSystemWatchers.length - 1].fireDelete(racy);
            });
          }
        });
      })) as typeof stubWorkspace.fs.readFile;
    try {
      const watcher = allFileSystemWatchers[allFileSystemWatchers.length - 1];
      watcher.fireCreate(racy);
      watcher.fireCreate(trigger);
      await new Promise(resolve => setImmediate(() => setImmediate(() => setImmediate(resolve))));
      const calls = await index.allEventCalls();
      expect(calls).toHaveLength(1);
      expect(calls[0].file).toBe('/ws/trigger.py');
    } finally {
      stubWorkspace.fs.readFile = originalReadFile;
      setWorkspaceIndexYieldSliceMsForTests(null);
      index.dispose();
    }
  });

  it('读盘失败(文件不存在):按删除口径清缓存并返回 null', async () => {
    const index = await startEmpty();
    try {
      const watcher = allFileSystemWatchers[allFileSystemWatchers.length - 1];
      watcher.fireCreate(Uri.file('/ws/missing.py')); // 内存 fs 无此文件 → readFile 抛
      await new Promise(resolve => setImmediate(resolve));
      expect(await index.allEventCalls()).toEqual([]);
    } finally {
      index.dispose();
    }
  });

  it('methodsOf 按当前文本给方法行(内存面,不触索引)', async () => {
    const index = new WorkspaceIndex();
    try {
      const document = makeTextDocument('def a():\n    pass\n\nasync def b():\n    pass\n', {
        fileName: '/ws/m.py',
        languageId: 'python',
        uri: Uri.file('/ws/m.py')
      });
      expect(await index.methodsOf(document as never)).toEqual([
        { name: 'a', line: 0 },
        { name: 'b', line: 3 }
      ]);
    } finally {
      index.dispose();
    }
  });

  it('无文件可扫时零让出:量规面不上浮', async () => {
    resetWorkspaceIndexYieldClockForTests();
    const index = await startEmpty();
    index.dispose();
    expect(getWorkspaceIndexYieldCountForTests()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// databaseSchema:快照守卫/输入清单对账/用法索引冷构建与亡灵清理
// ---------------------------------------------------------------------------

describe('databaseSchema 守卫分支', () => {
  const temporaryDirectories: string[] = [];
  const originalFolders = stubWorkspace.workspaceFolders;

  const makeWorkspace = (): string => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-cov-sch-'));
    temporaryDirectories.push(root);
    fs.mkdirSync(path.join(root, 'scripts/entity_defs'), { recursive: true });
    fs.writeFileSync(path.join(root, 'scripts/entities.xml'),
      '<root>\n  <Gold/>\n  <Silver/>\n</root>\n', 'utf8');
    fs.writeFileSync(path.join(root, 'scripts/entity_defs/types.xml'),
      '<root>\n  <ITEM_ID> UINT16 </ITEM_ID>\n  <SILVER_ID> UINT32 </SILVER_ID>\n</root>\n', 'utf8');
    fs.writeFileSync(path.join(root, 'scripts/entity_defs/Gold.def'), [
      '<root>',
      '  <Properties>',
      '    <coin>',
      '      <Type>ITEM_ID</Type>',
      '      <Persistent>true</Persistent>',
      '    </coin>',
      '  </Properties>',
      '</root>'
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(root, 'scripts/entity_defs/Silver.def'), [
      '<root>',
      '  <Properties>',
      '    <bar>',
      '      <Type>SILVER_ID</Type>',
      '      <Persistent>true</Persistent>',
      '    </bar>',
      '  </Properties>',
      '</root>'
    ].join('\n'), 'utf8');
    return root;
  };

  beforeAll(() => {
    stubWorkspace.workspaceFolders = [];
  });

  afterEach(async () => {
    setTypeStorageUsageBackgroundDispatcher(null);
    await flushTypeStorageUsageColdBuildForTests();
    invalidateTypeStorageUsageIndex();
    clearDatabaseSchemaCacheForTests();
    for (const dir of temporaryDirectories.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  afterAll(() => {
    stubWorkspace.workspaceFolders = originalFolders;
  });

  it('无根语境:peek 只读面与异步构建都返回 null(不抛错)', async () => {
    expect(peekPublishedDatabaseSchemaSnapshot('Gold')).toBeNull();
    expect(await buildDatabaseSchemaSnapshotAsync('Gold')).toBeNull();
  });

  it('外闸拒绝:调度构建在首阶段前止步,结果为 null', async () => {
    const root = makeWorkspace();
    expect(await scheduleDatabaseSchemaSnapshotBuild('Gold', root, { gate: async () => false })).toBeNull();
    // 无在飞构建可取消
    expect(cancelDatabaseSchemaSnapshotBuild('Gold', root)).toBe(false);
  });

  it('注册表文件消失且实体只消费未解析别名(u):快照保持新鲜', () => {
    const root = makeWorkspace();
    const typesXml = path.join(root, 'scripts/entity_defs/types.xml');
    fs.rmSync(typesXml);
    const snapshot = {
      inputVersions: { [typesXml]: { source: 'disk', version: 1 } },
      typeRegistryPath: typesXml,
      consumedTypeAliases: { ITEM_ID: 'u', SILVER_ID: 'u' }
    } as DatabaseSchemaSnapshot;
    // 注册表整体没了:没消费过任何已解析别名的实体不受牵连
    expect(isDatabaseSchemaSnapshotInputStale(snapshot)).toBe(false);
  });

  it('注册表文件消失且实体消费过已解析别名:判过期', () => {
    const root = makeWorkspace();
    const typesXml = path.join(root, 'scripts/entity_defs/types.xml');
    fs.rmSync(typesXml);
    const snapshot = {
      inputVersions: { [typesXml]: { source: 'disk', version: 1 } },
      typeRegistryPath: typesXml,
      consumedTypeAliases: { ITEM_ID: 'u', NICK: 'b' }
    } as DatabaseSchemaSnapshot;
    expect(isDatabaseSchemaSnapshotInputStale(snapshot)).toBe(true);
  });

  it('注册表版本漂移但消费别名摘要未变:保持新鲜;摘要变了才过期', () => {
    const root = makeWorkspace();
    const typesXml = path.join(root, 'scripts/entity_defs/types.xml');
    const digest = aliasDigestInMap('ITEM_ID', parseTypeAliasesFromContent(fs.readFileSync(typesXml, 'utf8'), typesXml));
    expect(digest).not.toBe('u'); // 前置:该别名确实可解析
    const base = {
      // 版本记错(模拟漂移)但文件还在、别名原样
      inputVersions: { [typesXml]: { source: 'disk', version: 1 } },
      typeRegistryPath: typesXml
    };
    expect(isDatabaseSchemaSnapshotInputStale({
      ...base, consumedTypeAliases: { ITEM_ID: digest }
    } as DatabaseSchemaSnapshot)).toBe(false);
    expect(isDatabaseSchemaSnapshotInputStale({
      ...base, consumedTypeAliases: { ITEM_ID: 'x' } // 摘要对不上:真漂移
    } as DatabaseSchemaSnapshot)).toBe(true);
  });

  it('别名摘要记录元素属性:属性值变 → 摘要漂移(274 属性面)', () => {
    // 摘要按「元素名+排序属性+子树」计算:别名元素自身带属性时属性进摘要。
    // 两株仅属性值不同 → 摘要不同(注册表失效比对才不会被属性变动漏判)。
    const mk = (note: string): string =>
      '<root>\n' +
      `  <FD note="${note}">\n` +
      '    FIXED_DICT\n' +
      '    <Properties>\n      <f>\n        <Type> UINT8 </Type>\n      </f>\n    </Properties>\n' +
      '    <implementedBy> mod.inst </implementedBy>\n' +
      '  </FD>\n' +
      '</root>\n';
    const a = parseTypeAliasesFromContent(mk('x'), '/ws/scripts/entity_defs/types.xml');
    const b = parseTypeAliasesFromContent(mk('y'), '/ws/scripts/entity_defs/types.xml');
    const digestA = aliasDigestInMap('FD', a);
    expect(digestA).toMatch(/^d:/);
    expect(digestA, '属性应进摘要').toContain('note=x');
    expect(digestA, '属性值变 → 摘要漂移').not.toBe(aliasDigestInMap('FD', b));
  });

  it('无在飞冷构建时取消返回 false', () => {
    expect(cancelTypeStorageUsageColdBuild('/no/such/root')).toBe(false);
  });

  it('分阶段冷构建:让出后再取消即止步,量规如实记 partial', async () => {
    const root = makeWorkspace();
    let gateCalls = 0;
    const outcome = await buildTypeStorageUsageIndexPhased(root, {
      entityBudgetMs: 0, // 首个实体后必让出
      yieldControl: async () => undefined,
      shouldContinue: () => { gateCalls += 1; return gateCalls <= 1; }
    });
    expect(outcome).toMatchObject({ entities: 1, stopped: true, yields: 1 });
    // 止步于 Gold 后:未被处理的 Silver 不出现在任何只读聚合里
    expect(findTypeStorageUsagesReadOnly(root, 'SILVER_ID')).toEqual([]);
  });

  it('分阶段冷构建:实体落出注册清单后亡灵记录被清掉', async () => {
    const root = makeWorkspace();
    const first = await buildTypeStorageUsageIndexPhased(root);
    expect(first.stopped).toBe(false);
    expect(findTypeStorageUsagesReadOnly(root, 'SILVER_ID').length).toBeGreaterThan(0);
    // Silver 落出注册清单且 def 文件删除:再跑一轮,亡灵记录清出、其余保留
    fs.writeFileSync(path.join(root, 'scripts/entities.xml'), '<root>\n  <Gold/>\n</root>\n', 'utf8');
    fs.rmSync(path.join(root, 'scripts/entity_defs/Silver.def'));
    const second = await buildTypeStorageUsageIndexPhased(root);
    expect(second.stopped).toBe(false);
    expect(findTypeStorageUsagesReadOnly(root, 'SILVER_ID')).toEqual([]);
    expect(findTypeStorageUsagesReadOnly(root, 'ITEM_ID').some(usage => usage.entity === 'Gold')).toBe(true);
  });

  it('尚无索引时按实体替换 usage 是 no-op(下一次查询自会全新构建)', () => {
    const root = makeWorkspace();
    invalidateTypeStorageUsageIndex();
    replaceTypeStorageUsageForEntity(root, 'Gold'); // 不抛、不排冷构建
    expect(getPendingTypeStorageColdBuildCount()).toBe(0);
  });

  it('同步构建面:注册清单收缩后亡灵记录清理并重聚', () => {
    const root = makeWorkspace();
    expect(findTypeStorageUsages(root, 'SILVER_ID').some(usage => usage.entity === 'Silver')).toBe(true);
    fs.writeFileSync(path.join(root, 'scripts/entities.xml'), '<root>\n  <Gold/>\n</root>\n', 'utf8');
    fs.rmSync(path.join(root, 'scripts/entity_defs/Silver.def'));
    expect(findTypeStorageUsages(root, 'SILVER_ID')).toEqual([]);
    expect(findTypeStorageUsages(root, 'ITEM_ID').some(usage => usage.entity === 'Gold')).toBe(true);
  });

  it('按源码行编组 usage:Gold.def 的属性行命中该属性记录', () => {
    const root = makeWorkspace();
    const goldDef = path.join(root, 'scripts/entity_defs/Gold.def');
    expect(findTypeStorageUsages(root, 'ITEM_ID').length).toBeGreaterThan(0); // 先建索引
    const byLine = indexTypeStorageUsagesBySourceLine(root, goldDef);
    const entries = [...byLine.values()].flat();
    expect(entries.some(usage => usage.entity === 'Gold' && usage.property === 'coin')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// entityMapping:python 全项目索引/定向解析/取消守卫/事件刷新散点
// ---------------------------------------------------------------------------

describe('entityMapping 散点分支', () => {
  const originalFindFiles = stubWorkspace.findFiles;
  const originalFolders = stubWorkspace.workspaceFolders;

  let root = '';
  let manager: EntityMappingManager | undefined;
  let pyWatcher: StubFileSystemWatcher | undefined;
  let errorSpy: ReturnType<typeof vi.spyOn> | undefined;

  const p = (relative: string): string => path.join(root, ...relative.split('/'));
  const write = (relative: string, content: string): void => {
    fs.mkdirSync(path.dirname(p(relative)), { recursive: true });
    fs.writeFileSync(p(relative), content, 'utf8');
  };

  beforeAll(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    setJumpLogEnabled(true); // 惰性日志面开闸:箭体行(重试/回退/定向)才求值

    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-cov-map-'));
    write('scripts/entities.xml', [
      '<root>',
      '  <Hero hasBase="true"/>',
      '  <Timer hasBase="true"/>',
      '</root>'
    ].join('\n'));
    write('scripts/entity_defs/types.xml', '<root>\n  <ITEM_ID> UINT16 </ITEM_ID>\n</root>\n');
    write('scripts/entity_defs/Hero.def', [
      '<root>',
      '  <Properties>',
      '    <hp>',
      '      <Type>UINT32</Type>',
      '      <Persistent>true</Persistent>',
      '    </hp>',
      '  </Properties>',
      '  <BaseMethods>',
      '    <ping>',
      '      <Arg>UINT8</Arg>',
      '    </ping>',
      '  </BaseMethods>',
      '</root>'
    ].join('\n'));
    write('scripts/entity_defs/Timer.def', [
      '<root>',
      '  <BaseMethods>',
      '    <tick/>',
      '    <trigger/>',
      '  </BaseMethods>',
      '</root>'
    ].join('\n'));
    write('scripts/base/Hero.py', [
      'class Hero(object):',
      '    def ping(self, x):',
      '        self.hp = x',
      ''
    ].join('\n'));
    write('scripts/base/Timer.py', [
      'class Timer(object):',
      '    def tick(self):',
      '        pass',
      '    def tick(self):',
      '        pass',
      '    def trigger(self):',
      '        self.cell.tick()',
      ''
    ].join('\n'));
    write('tools/Hero.py', [
      'class HeroTool(object):',
      '    def toolwork(self):',
      '        pass',
      ''
    ].join('\n'));
    write('scripts/base/Vanish.py', [
      'class Vanish(object):',
      '    def vanish(self):',
      '        pass',
      ''
    ].join('\n'));
    // chmod 000 目录:walk 层 readdir 抛 EACCES → 整目录静默跳过
    write('scripts/noperm/hidden.py', [
      'class Hidden(object):',
      '    def hidden(self):',
      '        pass',
      ''
    ].join('\n'));
    fs.chmodSync(p('scripts/noperm'), 0o000);
    // 断链软链:walk 视其为 .py 文件但读盘 ENOENT → 该文件静默 continue
    fs.symlinkSync('/nonexistent-kode-cov-target', p('scripts/broken.py'));

    stubWorkspace.workspaceFolders = [{ uri: Uri.file(root), name: 'cov', index: 0 }];
    stubWorkspace.findFiles = (async (pattern?: string) => {
      const results: never[] = [];
      const suffix = String(pattern ?? '').endsWith('.def') ? '.def' : '.nomatch';
      const walk = (dir: string): void => {
        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          return; // noperm 目录:与真实 findFiles 的降级口径一致
        }
        for (const entry of entries) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            walk(full);
          } else if (entry.name.endsWith(suffix)) {
            results.push(Uri.file(full) as never);
          }
        }
      };
      walk(root);
      return results;
    }) as typeof stubWorkspace.findFiles;

    manager = new EntityMappingManager({ subscriptions: [] } as never);
    pyWatcher = allFileSystemWatchers[allFileSystemWatchers.length - 1];
  });

  afterAll(() => {
    setJumpLogEnabled(false);
    clearRecentJumpLogs();
    manager?.dispose();
    errorSpy?.mockRestore();
    stubWorkspace.findFiles = originalFindFiles;
    stubWorkspace.workspaceFolders = originalFolders;
    fs.chmodSync(p('scripts/noperm'), 0o755);
    fs.rmSync(root, { recursive: true, force: true });
  });

  const heroIdentity = {
    ownerKind: 'entity' as const,
    ownerName: 'Hero',
    sourceKind: 'local' as const,
    sourceChain: [],
    section: 'BaseMethods' as const,
    symbolName: 'ping'
  };
  const cancelled = { isCancellationRequested: true };

  it('首扫落定:实体映射与 owner 脚本就绪', async () => {
    await manager!.waitForInitialScan();
    expect(manager!.getMapping('Hero')?.defFile).toContain('Hero.def');
    await expect(manager!.listOwnerScriptFilesForIdentity(heroIdentity)).resolves.toContain(p('scripts/base/Hero.py'));
  });

  it('取消令牌下 list 面:身份实现与 owner 脚本查询都空结果早落', async () => {
    await expect(manager!.listMethodImplementationsByIdentity(heroIdentity, cancelled as never)).resolves.toEqual([]);
    await expect(manager!.listOwnerScriptFilesForIdentity(heroIdentity, cancelled as never)).resolves.toEqual([]);
  });

  it('同一 owner 文件里重复 def:实现列表按文件去重只留一条', async () => {
    const implementations = await manager!.listMethodImplementationsByIdentity({
      ...heroIdentity, symbolName: 'tick', ownerName: 'Timer'
    });
    expect(implementations).toHaveLength(1);
    expect(implementations[0].filePath).toBe(p('scripts/base/Timer.py'));
  });

  it('全项目回退:域内唯一命中走 base 目录,域外唯一命中走全项目', async () => {
    clearRecentJumpLogs();
    const domainHit = await manager!.resolveMethodImplementationGlobally('ping', 'BaseMethods');
    expect(domainHit?.filePath).toBe(p('scripts/base/Hero.py'));
    const globalHit = await manager!.resolveMethodImplementationGlobally('toolwork');
    expect(globalHit?.filePath).toBe(p('tools/Hero.py'));
    const logs = getRecentJumpLogs().join('\n');
    expect(logs).toContain('域内目录 base');
    expect(logs).toContain('全项目回退');
  });

  it('不可读目录被静默跳过:其中的方法不参与全局回退', async () => {
    // scripts/noperm chmod 000:walk 层 readdir 失败即跳过该目录
    expect(await manager!.resolveMethodImplementationGlobally('hidden')).toBeNull();
  });

  it('形参闸门下实现文件已删除:该候选静默落空,查询不炸', async () => {
    expect(await manager!.resolveMethodImplementationGlobally('vanish')).not.toBeNull();
    fs.rmSync(p('scripts/base/Vanish.py'));
    // 索引桶里仍有旧命中:闸门重读文件失败 → continue → 零命中
    expect(await manager!.resolveMethodImplementationGlobally('vanish', undefined, ['UINT8'])).toBeNull();
  });

  it('慢解析记账:单文件解析超 200ms 进导航日志', async () => {
    // 首扫后新增的 def:定向解析走真解析(缓存 miss),用 Date.now 替身放大耗时
    write('scripts/entity_defs/Slowpoke.def', [
      '<root>',
      '  <Properties>',
      '    <sp>',
      '      <Type>UINT32</Type>',
      '      <Persistent>true</Persistent>',
      '    </sp>',
      '  </Properties>',
      '</root>'
    ].join('\n'));
    let ticks = 0;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => {
      ticks += 250;
      return ticks;
    });
    try {
      await expect(manager!.getOutgoingPythonMethodCalls(p('scripts/base/Slowpoke.py'), 'any'))
        .resolves.toEqual([]);
    } finally {
      nowSpy.mockRestore();
    }
    expect(manager!.getMapping('Slowpoke')?.defFile).toContain('Slowpoke.def');
    expect(getRecentJumpLogs().some(line => line.includes('def 解析慢文件') && line.includes('Slowpoke.def'))).toBe(true);
    // 二次查询:索引已在 → 定向快路径直接命中(direct 返回)
    await expect(manager!.getOutgoingPythonMethodCalls(p('scripts/base/Slowpoke.py'), 'any'))
      .resolves.toEqual([]);
  });

  it('属性访问与 receiver 调用:owner 文件消失后整体跳过', async () => {
    const heroDef = p('scripts/entity_defs/Hero.def');
    const timerDef = p('scripts/entity_defs/Timer.def');
    // 健在时都能收录(self.hp 访问 / self.cell.tick( 调用)
    expect((await manager!.getIncomingPythonPropertyAccesses(heroDef, 'hp')).length).toBeGreaterThan(0);
    expect((await manager!.getIncomingPythonReceiverCalls(timerDef, 'tick', 'cell')).length).toBeGreaterThan(0);
    fs.rmSync(p('scripts/base/Hero.py'));
    fs.rmSync(p('scripts/base/Timer.py'));
    expect(await manager!.getIncomingPythonPropertyAccesses(heroDef, 'hp')).toEqual([]);
    expect(await manager!.getIncomingPythonReceiverCalls(timerDef, 'tick', 'cell')).toEqual([]);
  });

  it('并发未知 owner 查询:共享同一次在途扫描(去重面)', async () => {
    const identity = { ...heroIdentity, ownerName: 'GhostA' };
    const other = { ...heroIdentity, ownerName: 'GhostB' };
    const [a, b] = await Promise.all([
      manager!.listMethodImplementationsByIdentity(identity),
      manager!.listMethodImplementationsByIdentity(other)
    ]);
    expect(a).toEqual([]);
    expect(b).toEqual([]);
  });

  it('python watcher create/delete 事件:全局方法索引增量刷新', async () => {
    // 先做一次全局查询:python def 倒排索引落定(后续事件按增量链刷新)
    expect(await manager!.resolveMethodImplementationGlobally('latework')).toBeNull();
    write('scripts/base/Late.py', [
      'class Late(object):',
      '    def latework(self):',
      '        pass',
      ''
    ].join('\n'));
    pyWatcher!.fireCreate(Uri.file(p('scripts/base/Late.py')));
    await (manager as unknown as { pythonDefIndexBuild: Promise<unknown> }).pythonDefIndexBuild;
    const hit = await manager!.resolveMethodImplementationGlobally('latework');
    expect(hit?.filePath).toBe(p('scripts/base/Late.py'));
    // 删除事件:旧命中摘除,查询回到 miss
    fs.rmSync(p('scripts/base/Late.py'));
    pyWatcher!.fireDelete(Uri.file(p('scripts/base/Late.py')));
    await (manager as unknown as { pythonDefIndexBuild: Promise<unknown> }).pythonDefIndexBuild;
    expect(await manager!.resolveMethodImplementationGlobally('latework')).toBeNull();
  });

  it('首扫失败后的冷查询重触发:重试日志如实入账', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-cov-retry-'));
    const oldFolders = stubWorkspace.workspaceFolders;
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(dir), name: 'bad', index: 0 }];
    stubWorkspace.findFiles = (async () => {
      throw new Error('fs offline');
    }) as typeof stubWorkspace.findFiles;
    try {
      const failing = new EntityMappingManager({ subscriptions: [] } as never);
      const internals = failing as unknown as {
        initialScanAttempts: number;
        initialScanFailed: boolean;
      };
      await failing.waitForInitialScan();
      await until(() => internals.initialScanFailed, 'failure booked');
      expect(internals.initialScanAttempts).toBe(1);
      clearRecentJumpLogs();
      // 对象级冷查询:入口即有界重触发(第 2 次尝试);查询失败面被吞为 null
      await failing.resolvePropertyDefinitionForClass('Hero', 'hp').catch(() => null);
      expect(internals.initialScanAttempts).toBe(2);
      expect(getRecentJumpLogs().some(line => line.includes('冷查询重触发'))).toBe(true);
      failing.dispose();
    } finally {
      stubWorkspace.findFiles = originalFindFiles;
      stubWorkspace.workspaceFolders = oldFolders;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// entityMapping:声明形参 ↔ Python 签名匹配的纯函数面(公共静态直测)
// ---------------------------------------------------------------------------

describe('entityMapping 签名纯函数面', () => {
  it('def 行不带括号(续行签名):收集面跨行拼齐后照常判定', () => {
    // 首行无 '(' → 收集循环先跳过再并入下一行;形参个数对齐 → 判定通过
    expect(EntityMappingManager.pythonSignatureMatchesDeclaredArgs(
      ['UINT8'],
      ['def go', '(self, x):', '    pass'],
      0
    )).toBe(true);
  });

  it('空形参列表与声明形参个数不符:判定不通过', () => {
    expect(EntityMappingManager.pythonSignatureMatchesDeclaredArgs(
      ['UINT8'],
      ['def go():', '    pass'],
      0
    )).toBe(false);
  });

  it('注解带嵌套泛型:按深度切分不误伤逗号,经 resolveAnnotation 对齐后通过', () => {
    expect(EntityMappingManager.pythonSignatureMatchesDeclaredArgs(
      ['UINT8', 'DICT'],
      ['def go(self, count: UINT8, pairs: Dict[str, int]):', '    pass'],
      0,
      raw => (raw === 'DICT' ? 'Dict[str, int]' : raw)
    )).toBe(true);
  });

  it('parsePythonParams 兜底:无括号/括号不配平都读不出(公共链路恒配平,直测私有契约)', () => {
    const parsePythonParams = (EntityMappingManager as unknown as {
      parsePythonParams(signature: string): Array<{ name: string; annotation: string | null }> | null;
    }).parsePythonParams;
    expect(parsePythonParams('def go x')).toBeNull();
    expect(parsePythonParams('def go(self, x')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 不可达/放弃分支备注(对账 lcov,不硬凑):
// - entityMapping buildIndex 的 `if (!loader) return null`:dirname 兜底恒非空串,
//   loader 恒非 null(防御面)。
// - entityMapping performBuildPythonDefIndex 的 seenPaths 去重 continue:扫描根
//   已按归一键+包含关系去重,同一归一路径不可能被两个根各走一遍。
// - entityMapping buildPythonDefIndex 的整链 catch(索引构建失败恢复):walk 内
//   readdir/readFile 失败均已就地吞掉,链上无剩余拒绝路径。
// - workspaceIndex 让出后第三次复核(事件解析后):与第二次复核之间纯同步相继,
//   无挂起点可插事件;第二次复核已由「删除落在两次让出之间」用例覆盖。
// - entityMapping ensureIndexTargeted 入口的 direct 复查:三个调用方(ensureIndex/
//   ensureIndexForPythonFile/ensureIndexForClass)进入前都在同一同步段查过,且
//   mappingIndexes 与 semanticIndex/mappingIndexesByRoot 在 storeIndex 内同步一致
//   落盘,调用点与复查之间无 await,并发也插不进(防御面)。
// - databaseSchema refreshTypeStorageUsageRecord 的 `if (!state) return false`:
//   全部调用方都在确保 state 存在后才进,公共 API 触不到。
// ---------------------------------------------------------------------------
