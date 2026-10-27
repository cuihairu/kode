import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KBEngineHoverProvider } from '../src/languageProviders';
import { EntityMappingManager } from '../src/entityMapping';
import { resetScanRootCache } from '../src/scanRoots';
import {
  clearRecentHoverTimeouts,
  createLinkedCancellationToken,
  getRecentHoverTimeouts,
  raceWithBudget,
  setHoverBudgetLogHub,
  withInitialScanTimeout
} from '../src/hoverBudget';
import {
  configurationOverrides,
  makeTextDocument,
  Position,
  Uri,
  workspace as stubWorkspace
} from './helpers/vscodeStub';

// 悬停永转 loading 双轨修(2026-10-22 用户令):
// ①异步链总预算闸(raceWithBudget/withInitialScanTimeout):慢层超预算截断、
//   快路径原样、预算 ≤0 关闸;
// ②根因(entityMapping):定向首解析 + mtime 解析缓存,悬停不再阻塞等全量
//   首扫,验收口径 = 同一悬停路径缓存命中 <300ms(断言用宽松上限防 CI 抖动,
//   实测数字打日志)。

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => {
    resolve = res;
  });
  return { promise, resolve };
};

const tick = (ms: number) => new Promise<void>(res => setTimeout(res, ms));

const PY_TEXT = 'class Hero:\n    def onTimer(self):\n        pass\n';

const hoverDocument = (fileName: string) =>
  makeTextDocument(PY_TEXT, { fileName, languageId: 'python' });

// `    def onTimer(self):` 方法名区间 [8,15]
const NAME_POSITION = new Position(1, 10);

const makeManager = (
  resolveMethodDefinition: (...args: unknown[]) => Promise<unknown>
): EntityMappingManager =>
  ({ resolveMethodDefinition }) as unknown as EntityMappingManager;

const HOVER_LOCATION = {
  defFile: '/tmp/project/scripts/entity_defs/Hero.def',
  line: 2,
  section: 'BaseMethods',
  declaredArgs: [] as string[],
  exposed: false
};

beforeEach(() => {
  clearRecentHoverTimeouts();
  setHoverBudgetLogHub(null);
});

afterEach(() => {
  configurationOverrides.delete('kbengine');
});

describe('raceWithBudget', () => {
  it('truncates a slow layer at the budget and records layer + elapsed', async () => {
    const slow = deferred<string>();
    const startedAt = Date.now();

    const result = await raceWithBudget('hover:test', slow.promise, 25);

    expect(result).toBeNull();
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(20);
    const records = getRecentHoverTimeouts();
    expect(records.length).toBe(1);
    expect(records[0].layer).toBe('hover:test');
    expect(records[0].budgetMs).toBe(25);
    expect(records[0].elapsedMs).toBeGreaterThanOrEqual(20);
    slow.resolve('late');
  });

  it('passes fast work through untouched without recording a timeout', async () => {
    const result = await raceWithBudget('hover:test', Promise.resolve('fast'), 1000);
    expect(result).toBe('fast');
    expect(getRecentHoverTimeouts()).toEqual([]);
  });

  it('budget <= 0 disables the gate entirely', async () => {
    const slow = deferred<string>();
    const raced = raceWithBudget('hover:test', slow.promise, 0);
    let settled = false;
    void raced.then(() => {
      settled = true;
    });
    await tick(30);
    expect(settled).toBe(false);
    slow.resolve('late-value');
    expect(await raced).toBe('late-value');
    expect(getRecentHoverTimeouts()).toEqual([]);
  });

  it('cancels one waiter promptly without cancelling shared work', async () => {
    const shared = deferred<string>();
    let cancel!: () => void;
    let listener: (() => void) | undefined;
    const token = {
      isCancellationRequested: false,
      onCancellationRequested(callback: () => void) {
        listener = callback;
        return { dispose: () => { listener = undefined; } };
      }
    };
    cancel = () => { token.isCancellationRequested = true; listener?.(); };
    const first = raceWithBudget('hover:cancel', shared.promise, 0, token as never);
    const second = raceWithBudget('hover:shared', shared.promise, 0);
    cancel();
    expect(await first).toBeNull();
    shared.resolve('ready');
    expect(await second).toBe('ready');
    expect(listener).toBeUndefined();
    expect(getRecentHoverTimeouts()).toEqual([]);
  });

  it('a request budget cancels request-owned follow-up work while a shared scan continues', async () => {
    const shared = deferred<void>();
    const parent = {
      isCancellationRequested: false,
      onCancellationRequested: () => ({ dispose: () => undefined })
    } as never;
    const linked = createLinkedCancellationToken(parent);
    let stopped = false;
    linked.token.onCancellationRequested(() => { stopped = true; });
    const result = await raceWithBudget('definition:test', shared.promise.then(() => 'ready'),
      20, parent, linked.cancel);
    expect(result).toBeNull();
    expect(linked.token.isCancellationRequested).toBe(true);
    expect(stopped).toBe(true);
    shared.resolve();
    linked.dispose();
  });
});

describe('withInitialScanTimeout', () => {
  it('cuts a hanging initial scan and records the initial-scan layer', async () => {
    const scan = deferred<void>();
    const startedAt = Date.now();
    await withInitialScanTimeout(scan.promise, 20);
    expect(Date.now() - startedAt).toBeLessThan(2000);
    expect(getRecentHoverTimeouts().map(record => record.layer)).toEqual(['initial-scan']);
    scan.resolve();
  });

  it('lets a settled scan through', async () => {
    await withInitialScanTimeout(Promise.resolve(), 1000);
    expect(getRecentHoverTimeouts()).toEqual([]);
  });
});

describe('KBEngineHoverProvider async budget', () => {
  it('returns null instead of spinning forever when the def-method layer exceeds the budget', async () => {
    configurationOverrides.set('kbengine', { 'hover.asyncBudgetMs': 20 });
    const slow = deferred<never>();
    const provider = new KBEngineHoverProvider(
      makeManager(() => slow.promise)
    );
    const startedAt = Date.now();
    const result = await provider.provideHover(
      hoverDocument('/tmp/project/scripts/base/Hero.py'),
      NAME_POSITION
    );
    expect(Date.now() - startedAt).toBeLessThan(2000);
    expect(result).toBeNull();
    expect(getRecentHoverTimeouts().map(record => record.layer)).toEqual(['hover:def-method']);
    slow.resolve(null as never);
  });

  it('keeps the fast path intact: resolved annotation still reaches the hover', async () => {
    configurationOverrides.set('kbengine', { 'hover.asyncBudgetMs': 1000 });
    const provider = new KBEngineHoverProvider(
      makeManager(() => Promise.resolve(HOVER_LOCATION))
    );
    const result = await provider.provideHover(
      hoverDocument('/tmp/project/scripts/base/Hero.py'),
      NAME_POSITION
    );
    expect(result).not.toBeNull();
    expect(JSON.stringify(result)).toContain('BaseMethods');
    expect(JSON.stringify(result)).toContain('onTimer');
    expect(getRecentHoverTimeouts()).toEqual([]);
  });

  it('budget 0 restores the legacy unbounded wait (switch off)', async () => {
    configurationOverrides.set('kbengine', { 'hover.asyncBudgetMs': 0 });
    const slow = deferred<unknown>();
    const provider = new KBEngineHoverProvider(makeManager(() => slow.promise));
    const pending = provider.provideHover(
      hoverDocument('/tmp/project/scripts/base/Hero.py'),
      NAME_POSITION
    );
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await tick(30);
    expect(settled).toBe(false);
    slow.resolve(HOVER_LOCATION);
    expect(await pending).not.toBeNull();
    expect(getRecentHoverTimeouts()).toEqual([]);
  });
});

describe('hover root cause: targeted parse + mtime cache', () => {
  const ORIGINAL_FOLDERS = stubWorkspace.workspaceFolders;
  const ORIGINAL_FIND_FILES = stubWorkspace.findFiles;
  let root = '';
  let defPath = '';
  let pyPath = '';
  let manager: EntityMappingManager | null = null;

  const DEF_XML = [
    '<root>',
    '  <Properties>',
    '  </Properties>',
    '  <BaseMethods>',
    '    <onTimer>',
    '    </onTimer>',
    '  </BaseMethods>',
    '</root>'
  ].join('\n');

  const walkDefs = (dir: string): string[] => {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        out.push(...walkDefs(full));
      } else if (entry.isFile() && entry.name.endsWith('.def')) {
        out.push(full);
      }
    }
    return out;
  };

  const setupWorkspace = (): void => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-hover-budget-'));
    fs.mkdirSync(path.join(root, 'scripts', 'entity_defs'), { recursive: true });
    fs.mkdirSync(path.join(root, 'scripts', 'base'), { recursive: true });
    defPath = path.join(root, 'scripts', 'entity_defs', 'Hero.def');
    fs.writeFileSync(defPath, DEF_XML);
    pyPath = path.join(root, 'scripts', 'base', 'Hero.py');
    fs.writeFileSync(pyPath, PY_TEXT);
    stubWorkspace.workspaceFolders = [
      { uri: Uri.file(root), name: 'ws', index: 0 }
    ];
    stubWorkspace.findFiles = (async () =>
      walkDefs(root).map(file => Uri.file(file))) as typeof stubWorkspace.findFiles;
    resetScanRootCache();
  };

  const invalidateIndexTable = (): void => {
    // 模拟 watcher 整表失效(watchDefFiles 的 invalidate 同款清理,不动解析缓存)
    const internals = manager as unknown as {
      mappingIndexes: Map<string, unknown>;
      mappingIndexesByRoot: Map<string, unknown>;
      missingOwnerPaths: Set<string>;
      missingClassNames: Set<string>;
    };
    internals.mappingIndexes.clear();
    internals.mappingIndexesByRoot.clear();
    internals.missingOwnerPaths.clear();
    internals.missingClassNames.clear();
  };

  afterEach(() => {
    manager?.dispose();
    manager = null;
    fs.rmSync(root, { recursive: true, force: true });
    stubWorkspace.workspaceFolders = ORIGINAL_FOLDERS;
    stubWorkspace.findFiles = ORIGINAL_FIND_FILES;
    resetScanRootCache();
  });

  it('answers a hover-path resolve via targeted single-def parse without waiting for the full scan', async () => {
    setupWorkspace();
    manager = new EntityMappingManager({ subscriptions: [] } as never);
    const provider = new KBEngineHoverProvider(manager);
    const startedAt = Date.now();
    const result = await provider.provideHover(hoverDocument(pyPath), NAME_POSITION);
    const elapsedMs = Date.now() - startedAt;
    // eslint-disable-next-line no-console
    console.log(`[hover-budget] cold targeted hover=${elapsedMs}ms`);
    expect(elapsedMs).toBeLessThan(1000);
    expect(result).not.toBeNull();
    expect(JSON.stringify(result)).toContain('BaseMethods');
    const stats = manager.getDefParseCacheStats();
    expect(stats.misses).toBeGreaterThanOrEqual(1);
    // 定向快路径真命中的铁证(2026-10-22 修正 normalizeLookupPath 小写吞噬
    // 文件名比对后补):只解析了 Hero.def 这一个文件,全量扫(1500 个)没跑。
    // 此前断言 misses>=1 由回退全量扫满足,测不出快路径死代码。
    const internals = manager as unknown as { mappingIndexes: Map<string, unknown> };
    expect(internals.mappingIndexes.size).toBe(1);
    expect(stats.entries).toBe(1);
  });

  it('reuses unchanged .def across rescans and reparses changed ones (mtime key)', async () => {
    setupWorkspace();
    manager = new EntityMappingManager({ subscriptions: [] } as never);
    const provider = new KBEngineHoverProvider(manager);
    await provider.provideHover(hoverDocument(pyPath), NAME_POSITION);

    // 重扫一遍未变更 .def:必须走 mtime 缓存,不重解析
    invalidateIndexTable();
    const before = manager.getDefParseCacheStats();
    const warmStartedAt = Date.now();
    const warm = await provider.provideHover(hoverDocument(pyPath), NAME_POSITION);
    const warmMs = Date.now() - warmStartedAt;
    // eslint-disable-next-line no-console
    console.log(`[hover-budget] warm cache-hit hover=${warmMs}ms`);
    expect(warm).not.toBeNull();
    expect(warmMs).toBeLessThan(300);
    const afterReuse = manager.getDefParseCacheStats();
    expect(afterReuse.hits).toBeGreaterThan(before.hits);
    expect(afterReuse.misses).toBe(before.misses);

    // .def 变更(mtime 变):重解析拿到新方法
    fs.writeFileSync(defPath, DEF_XML.replace('</BaseMethods>', '    <onLater>\n    </onLater>\n  </BaseMethods>'));
    const future = Date.now() + 5000;
    fs.utimesSync(defPath, new Date(future), new Date(future));
    invalidateIndexTable();
    const changed = await manager.resolveMethodDefinition(pyPath, 'onLater');
    expect(changed).not.toBeNull();
    expect(manager.getDefParseCacheStats().misses).toBe(afterReuse.misses + 1);
  });

  it('forces reparse on python file change so method bindings do not go stale', async () => {
    setupWorkspace();
    manager = new EntityMappingManager({ subscriptions: [] } as never);
    const provider = new KBEngineHoverProvider(manager);
    await provider.provideHover(hoverDocument(pyPath), NAME_POSITION);
    const before = manager.getDefParseCacheStats();

    // python watcher fire → handlePythonFileChanged → force 重解析(def 未变)
    const watcher = (manager as unknown as {
      pythonWatcher: { fireChange: (uri: ReturnType<typeof Uri.file>) => void } | null;
    }).pythonWatcher;
    expect(watcher).not.toBeNull();
    watcher!.fireChange(Uri.file(pyPath));
    for (let i = 0; i < 50 && manager.getDefParseCacheStats().misses === before.misses; i += 1) {
      await tick(10);
    }
    const after = manager.getDefParseCacheStats();
    expect(after.misses).toBe(before.misses + 1);
    // 结果仍正确:缓存复用路径下 hover 标注不丢
    const result = await provider.provideHover(hoverDocument(pyPath), NAME_POSITION);
    expect(result).not.toBeNull();
  });
});
