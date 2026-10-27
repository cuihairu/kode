// PR5 去全仓阻塞专项:
// ③ 组合根构建缓存(mtime 内容缓存,同批 XML/def 只读一次,指标断言);
// ④ 显式版本轴 + PR4 依赖图裁断失效(类/基类/方法/MRO/组合根);
// ⑤ 删除/重命名/基类变更后旧索引项移除(跳转不到已不存在位置);
// ① 首扫接管面:发现任务经 IndexScheduler keyed 单例,分块后台解析。
// ② Definition 首查不阻塞全仓:命中走快照+按需单文件解析,后台补全量可观测。
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { Uri } from './fake-vscode/core';
import { workspace as stubWorkspace } from './fake-vscode/workspaceState';
import {
  COMPOSITION_ROOTS_NODE,
  PythonClassIndex
} from '../src/pythonClassIndex';
import {
  IndexScheduler,
  IndexTaskHandle,
  IndexTaskKind,
  IndexTaskSpec,
  IndexTaskState
} from '../src/indexScheduler';
import {
  getOperationSummary,
  resetLanguageServiceMetrics
} from '../src/languageServiceMetrics';
import { makeTextDocument } from './helpers/vscodeStub';

const makeRoot = (files: Record<string, string>): { dir: string; paths: Record<string, string>; cleanup: () => void } => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-pr5-'));
  const paths: Record<string, string> = {};
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(dir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
    paths[name] = full;
  }
  return { dir, paths, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
};

const pointWorkspaceAt = (dir: string): void => {
  stubWorkspace.workspaceFolders = [{ uri: Uri.file(dir), name: 'ws', index: 0 }];
};

const stubFindFiles = (routing: (pattern: string) => string[]): void => {
  stubWorkspace.findFiles = (async (pattern?: string) =>
    routing(String(pattern ?? '')).map(file => Uri.file(file))) as typeof stubWorkspace.findFiles;
};

const ASSET_FILES = {
  'entities.xml': '<?xml version="1.0"?><entities><Avatar/></entities>',
  'types.xml': '<types><VECTOR3>FLOAT32</VECTOR3></types>',
  'Avatar.def': '<root><Properties><name><Type>VECTOR3</Type></name></Properties></root>',
  'Avatar.py': 'class Avatar:\n\tdef onTimer(self):\n\t\treturn 0\n',
  'bridge.py': 'avatar_instance = Avatar()\n'
};

const MIXIN_FILES = {
  'a.py': 'class Alpha:\n\tdef meth(self):\n\t\tpass\n',
  'b.py': 'class Beta(Alpha):\n\tdef run(self):\n\t\tself.meth()\n'
};

describe('PR5 ③ 组合根构建缓存(同批 XML/def 只读一次 + 指标断言)', () => {
  it('重派生命中 mtime 内容缓存,不再重读未变更 XML/def', async () => {
    const { dir, paths, cleanup } = makeRoot(ASSET_FILES);
    pointWorkspaceAt(dir);
    stubFindFiles(pattern => {
      const glob = pattern.replace(/\*\*\//, '');
      if (glob === 'entities.xml') { return [paths['entities.xml']]; }
      if (glob === 'types.xml') { return [paths['types.xml']]; }
      if (glob.endsWith('.def')) { return [paths['Avatar.def']]; }
      if (glob.includes('*.py')) { return [paths['Avatar.py'], paths['bridge.py']]; }
      return [];
    });
    const realRead = fs.promises.readFile.bind(fs.promises);
    const xmlDefReads: string[] = [];
    fs.promises.readFile = (async (file: Parameters<typeof realRead>[0], ...rest: unknown[]) => {
      const target = String(file);
      if (/\.(xml|def)$/.test(target)) {
        xmlDefReads.push(target);
      }
      return (realRead as (f: Parameters<typeof realRead>[0], ...r: unknown[]) => Promise<string>)(file, ...rest);
    }) as typeof fs.promises.readFile;

    try {
      resetLanguageServiceMetrics();
      const index = new PythonClassIndex();
      // 预热全量:后台首扫完成后组合根派生不再被分块解析的赋值签名变化打断
      await index.findClassesByName('Avatar');
      // 首次派生:三个元数据文件各读一次
      expect(await index.rootsContaining('Avatar')).toContain('Avatar');
      const firstBuildReads = xmlDefReads.length;
      expect(firstBuildReads).toBe(3);

      // .def 记录在依赖图 → 定向失效 → 重派生:未变更文件全部走缓存,零重读
      index.invalidate(paths['Avatar.def'], 'change');
      expect(await index.rootsContaining('Avatar')).toContain('Avatar');
      expect(xmlDefReads.length, '重派生不得重读未变更 XML/def').toBe(firstBuildReads);
      const summary = getOperationSummary('python-composition-roots');
      expect(summary, '组合根派生指标已采集').not.toBeNull();
      expect(summary!.cacheHits, '指标断言:缓存命中计数 > 0').toBeGreaterThan(0);
      // 缓存内容正确性:改盘后 mtime 变化,必须真重读
      fs.writeFileSync(paths['entities.xml'], '<?xml version="1.0"?><entities><Avatar/><Monster/></entities>', 'utf8');
      index.invalidate(paths['entities.xml'], 'change');
      expect(await index.rootsContaining('Monster')).toContain('Monster');
      expect(xmlDefReads.length).toBeGreaterThan(firstBuildReads);
    } finally {
      fs.promises.readFile = realRead;
      stubWorkspace.findFiles = undefined as unknown as typeof stubWorkspace.findFiles;
      stubWorkspace.workspaceFolders = [];
      cleanup();
    }
  });
});

describe('PR5 ④ 显式版本轴 + PR4 依赖图裁断失效', () => {
  afterEach(() => {
    stubWorkspace.workspaceFolders = [];
  });

  it('方法/基类/类集变更只递增对应版本轴', async () => {
    const { dir, cleanup } = makeRoot({
      'thing.py': 'class Thing:\n\tdef alpha(self):\n\t\tpass\n'
    });
    pointWorkspaceAt(dir);
    try {
      const index = new PythonClassIndex();
      const doc = (text: string) =>
        makeTextDocument(text, {
          fileName: paths0(dir, 'thing.py'),
          languageId: 'python',
          uri: Uri.file(paths0(dir, 'thing.py'))
        }) as never;
      await index.onDocumentChanged(doc('class Thing:\n\tdef alpha(self):\n\t\tpass\n'));
      const afterCreate = index.getIndexVersions();
      expect(afterCreate.classes).toBeGreaterThan(0);
      expect(afterCreate.bases).toBeGreaterThan(0);
      expect(afterCreate.methods).toBeGreaterThan(0);
      expect(afterCreate.mro).toBe(0); // 首次解析无前版对比,MRO 未动

      // 只加方法:methods/mro 动,classes/bases 不动
      await index.onDocumentChanged(doc('class Thing:\n\tdef alpha(self):\n\t\tpass\n\tdef beta(self):\n\t\tpass\n'));
      const afterMethod = index.getIndexVersions();
      expect(afterMethod.methods).toBe(afterCreate.methods + 1);
      expect(afterMethod.mro).toBe(afterCreate.mro + 1);
      expect(afterMethod.classes).toBe(afterCreate.classes);
      expect(afterMethod.bases).toBe(afterCreate.bases);

      // 改基类(标识符基类;object 被解析器排除不算):bases/mro 动,classes/methods 不动
      await index.onDocumentChanged(doc('class Thing(Base):\n\tdef alpha(self):\n\t\tpass\n\tdef beta(self):\n\t\tpass\n'));
      const afterBase = index.getIndexVersions();
      expect(afterBase.bases).toBe(afterMethod.bases + 1);
      expect(afterBase.mro).toBe(afterMethod.mro + 1);
      expect(afterBase.classes).toBe(afterMethod.classes);
      expect(afterBase.methods).toBe(afterMethod.methods);
    } finally {
      cleanup();
    }
  });

  it('组合根失效按依赖图裁断:记录在案的 .def 才作废,无关文件不波及;fullRebuild 恒 false', async () => {
    const { dir, paths, cleanup } = makeRoot(ASSET_FILES);
    pointWorkspaceAt(dir);
    stubFindFiles(pattern => {
      const glob = pattern.replace(/\*\*\//, '');
      if (glob === 'entities.xml') { return [paths['entities.xml']]; }
      if (glob === 'types.xml') { return [paths['types.xml']]; }
      if (glob.endsWith('.def')) { return [paths['Avatar.def']]; }
      if (glob.includes('*.py')) { return [paths['Avatar.py'], paths['bridge.py']]; }
      return [];
    });
    try {
      const index = new PythonClassIndex();
      // 预热全量,避免后台分块解析与组合根派生竞争(见 ③ 用例注释)
      await index.findClassesByName('Avatar');
      await index.rootsContaining('Avatar'); // 建组合根 + 记录依赖边
      const before = index.getIndexVersions();

      // 依赖图:组合根派生物 dependsOn entities.xml/.def/types.xml(±赋值桥 py)
      const graph = index.getDependencyGraph();
      const plan = graph.planInvalidation(paths['Avatar.def'], 'change');
      expect(plan.invalidateFiles).toContain(COMPOSITION_ROOTS_NODE);
      expect(plan.fullRebuild).toBe(false);

      index.invalidate(paths['Avatar.def'], 'change');
      expect(index.getIndexVersion('compositionRoots')).toBeGreaterThan(before.compositionRoots);

      // 无关文件(未记录依赖):不动组合根,也不动类索引
      const afterDef = index.getIndexVersions();
      index.invalidate(path.join(dir, 'unrelated.xml'), 'change');
      expect(index.getIndexVersion('compositionRoots')).toBe(afterDef.compositionRoots);
      expect(index.getIndexVersion('classes')).toBe(afterDef.classes);

      // 无实例赋值的普通 py 删除:类集变化,但组合根不因它重建(赋值桥未变)
      index.invalidate(paths['Avatar.py'], 'delete');
      expect(index.getIndexVersion('classes')).toBeGreaterThan(afterDef.classes);
    } finally {
      stubWorkspace.findFiles = undefined as unknown as typeof stubWorkspace.findFiles;
      cleanup();
    }
  });
});

const routePy = (paths: string[]) => stubFindFiles(pattern => {
  if (String(pattern).includes('*.py')) { return paths; }
  return [];
});

describe('PR5 ⑤ 删除/重命名/基类变更后旧索引项移除', () => {

  afterEach(() => {
    stubWorkspace.findFiles = undefined as unknown as typeof stubWorkspace.findFiles;
    stubWorkspace.workspaceFolders = [];
  });

  it('重命名文件:旧路径类移除,跳转只落新路径', async () => {
    const { dir, paths, cleanup } = makeRoot(MIXIN_FILES);
    pointWorkspaceAt(dir);
    routePy([paths['a.py'], paths['b.py']]);
    try {
      const index = new PythonClassIndex();
      await index.findClassesByName('Beta'); // 全量扫描后台化后的全量口径入口
      expect((await index.findClassesByName('Alpha')).map(cls => cls.filePath)).toEqual([paths['a.py']]);

      // rename = 旧路径 delete + 新路径入发现面
      fs.renameSync(paths['a.py'], path.join(dir, 'a2.py'));
      routePy([path.join(dir, 'a2.py'), paths['b.py']]);
      index.invalidate(paths['a.py'], 'delete');
      const alpha = await index.findClassesByName('Alpha');
      expect(alpha.map(cls => cls.filePath)).toEqual([path.join(dir, 'a2.py')]);
      // 跳转不得落在已不存在的旧位置
      const loc = await index.resolveSelfMethod(paths['b.py'], 2, 'meth');
      expect(loc, '重命名后仍应解析到 Alpha.meth').not.toBeNull();
      expect(loc!.filePath).toBe(path.join(dir, 'a2.py'));
      expect(loc!.filePath).not.toBe(paths['a.py']);
    } finally {
      cleanup();
    }
  });

  it('删除文件:旧索引项移除,不再命中;基类变更后 MRO 随新基类走', async () => {
    const { dir, paths, cleanup } = makeRoot(MIXIN_FILES);
    pointWorkspaceAt(dir);
    routePy([paths['a.py'], paths['b.py']]);
    try {
      const index = new PythonClassIndex();
      await index.findClassesByName('Beta');
      expect(await index.computeMRO('Beta')).toEqual(['Beta', 'Alpha']);

      // ① 删除 Alpha 定义文件 → 类移除、MRO 收缩、跳转落空
      fs.rmSync(paths['a.py'], { force: true });
      routePy([paths['b.py']]);
      index.invalidate(paths['a.py'], 'delete');
      expect(await index.findClassesByName('Alpha')).toEqual([]);
      expect(await index.computeMRO('Beta')).toEqual(['Beta']);
      expect(await index.resolveSelfMethod(paths['b.py'], 2, 'meth')).toBeNull();

      // ② 基类变更 Beta(Alpha) → Beta(Gamma):新 MRO 生效,跳到新基类实现
      fs.writeFileSync(paths['b.py'], 'class Beta(Gamma):\n\tdef run(self):\n\t\tself.meth()\n', 'utf8');
      fs.writeFileSync(path.join(dir, 'g.py'), 'class Gamma:\n\tdef meth(self):\n\t\treturn 1\n', 'utf8');
      routePy([paths['b.py'], path.join(dir, 'g.py')]);
      // 新文件由 watcher 定点读入，无需使全仓扫描换代。
      await index.onFileChanged(path.join(dir, 'g.py'));
      await index.onFileChanged(paths['b.py']);
      expect((await index.computeMRO('Beta'))).toContain('Gamma');
      expect((await index.computeMRO('Beta'))).not.toContain('Alpha');
      const loc = await index.resolveSelfMethod(paths['b.py'], 2, 'meth');
      expect(loc, '基类变更后应跳到 Gamma.meth').not.toBeNull();
      expect(loc!.filePath).toBe(path.join(dir, 'g.py'));
      expect(loc!.className).toBe('Gamma');
    } finally {
      cleanup();
    }
  });
});

describe('PR5 ① 首扫接管面(调度器 keyed 发现 + 分块后台解析)', () => {
  afterEach(() => {
    stubWorkspace.findFiles = undefined as unknown as typeof stubWorkspace.findFiles;
    stubWorkspace.workspaceFolders = [];
  });

  it('注入共享调度器:发现任务 keyed 完成,分块任务计入 completed', async () => {
    const { dir, paths, cleanup } = makeRoot(MIXIN_FILES);
    pointWorkspaceAt(dir);
    routePy([paths['a.py'], paths['b.py']]);
    try {
      const scheduler = new IndexScheduler();
      const index = new PythonClassIndex(scheduler);
      await index.findClassesByName('Beta'); // 等全量扫描完成(全量口径 API)
      const status = scheduler.getStatus();
      expect(status.keyedTasks['python-file-discovery#0'], '发现任务经调度器 keyed 单例完成')
        .toBe('completed');
      expect(status.completed, '分块解析任务计入调度器完成数').toBeGreaterThan(0);
      expect(status.failed).toBe(0);
    } finally {
      cleanup();
    }
  });

  it('分块失败不被吞掉:失败文件登记待补,后续查询定向重试补齐(不永久缺席)', async () => {
    const { dir, paths, cleanup } = makeRoot(MIXIN_FILES);
    pointWorkspaceAt(dir);
    routePy([paths['a.py'], paths['b.py']]);
    try {
      const scheduler = new FailNextChunkScheduler();
      scheduler.failNextChunk();
      const index = new PythonClassIndex(scheduler);
      await index.waitForInitialScan();
      expect(scheduler.failedChunks, '首个分块按注入失败').toBe(1);
      // 修复前:分块拒绝被逐一吞掉仍标记该代完成,失败文件永久缺席且无重试
      expect(await index.findClassesByName('Beta'), '失败分块的文件此刻尚未入索引')
        .toHaveLength(0);
      // 上一行查询已触发定向补解析;等重试分块真实执行完毕
      await scheduler.waitForIdle();
      expect(await index.findClassesByName('Beta'), '后续查询经待补重试补齐失败分块')
        .toHaveLength(1);
      expect(scheduler.failedChunks, '重试分块不再失败').toBe(1);
    } finally {
      cleanup();
    }
  });
});

describe('PR5 ② Definition 首查不阻塞全仓(快照命中/按需单文件/后台补全量)', () => {
  afterEach(() => {
    stubWorkspace.findFiles = undefined as unknown as typeof stubWorkspace.findFiles;
    stubWorkspace.workspaceFolders = [];
  });

  it('命中走快照+已建索引:全量分块被扣住时首查照常返回,噪声文件零读', async () => {
    const { dir, paths, cleanup } = makeRoot(UNBLOCK_FILES);
    pointWorkspaceAt(dir);
    routeWorkspacePy(Object.values(paths).filter(target => target.endsWith('.py')));
    const noisePaths = Object.keys(paths).filter(name => name.startsWith('noise/')).map(name => paths[name]);
    const realRead = fs.promises.readFile.bind(fs.promises);
    const pyReads: string[] = [];
    fs.promises.readFile = (async (file: Parameters<typeof realRead>[0], ...rest: unknown[]) => {
      const target = String(file);
      if (target.endsWith('.py')) { pyReads.push(target); }
      return (realRead as (f: Parameters<typeof realRead>[0], ...r: unknown[]) => Promise<string>)(file, ...rest);
    }) as typeof fs.promises.readFile;

    const scheduler = new GatedBackgroundScheduler();
    const index = new PythonClassIndex(scheduler);
    try {
      const hits = await index.resolveSelfMethodCandidates(paths['query.py'], 1, 'meth');
      expect(hits, '① 静态类 MRO 命中必须回答').toHaveLength(1);
      expect(hits[0].filePath).toBe(paths['base.py']);
      expect(hits[0].className).toBe('Alpha');
      // 关键断言:全量分块全部被扣住,一个都没有真正执行。
      // 首查返回不表示发现已完成——后台发现异步,分块在发现完成后才入队,
      // 必须锚在真实入队时点再断言 gatedCount(否则抢在发现前,恒为 0)。
      await scheduler.chunksEnqueued;
      expect(scheduler.gatedCount, '全量分块已入队(后台在推进)').toBeGreaterThan(0);
      expect(scheduler.executedFullReindex, '首查不得执行全量分块').toBe(0);
      const noiseReads = pyReads.filter(target => noisePaths.includes(target));
      expect(noiseReads, '全仓噪声文件不得被读取(全仓扫描未跑)').toHaveLength(0);
      expect(scheduler.executedByKind.get('single-file-update'), '按需单文件任务已执行')
        .toBeGreaterThanOrEqual(2);
    } finally {
      scheduler.release();
      await index.waitForInitialScan().catch(() => undefined);
      fs.promises.readFile = realRead;
      cleanup();
    }
  });

  it('未命中:定点 glob 补载请求所需文件,仍不等全仓', async () => {
    const { dir, paths, cleanup } = makeRoot(UNBLOCK_FILES);
    pointWorkspaceAt(dir);
    routeWorkspacePy(Object.values(paths).filter(target => target.endsWith('.py')));
    const noisePaths = Object.keys(paths).filter(name => name.startsWith('noise/')).map(name => paths[name]);
    const realRead = fs.promises.readFile.bind(fs.promises);
    const pyReads: string[] = [];
    fs.promises.readFile = (async (file: Parameters<typeof realRead>[0], ...rest: unknown[]) => {
      const target = String(file);
      if (target.endsWith('.py')) { pyReads.push(target); }
      return (realRead as (f: Parameters<typeof realRead>[0], ...r: unknown[]) => Promise<string>)(file, ...rest);
    }) as typeof fs.promises.readFile;

    const scheduler = new GatedBackgroundScheduler();
    const index = new PythonClassIndex(scheduler);
    try {
      const document = makeTextDocument('x = Beta()\n', {
        fileName: paths['call.py'],
        languageId: 'python'
      }) as unknown as Parameters<PythonClassIndex['resolveClassBase']>[0];
      const resolved = await index.resolveClassBase(document, 'Beta');
      expect(resolved, '落空后经定点补载必须命中').not.toBeNull();
      expect(resolved!.filePath).toBe(paths['pkg/Beta.py']);
      expect(scheduler.executedFullReindex, '定点补载不得升级为全仓扫描').toBe(0);
      expect(pyReads, '被补载的是请求所需的那个文件').toContain(paths['pkg/Beta.py']);
      const noiseReads = pyReads.filter(target => noisePaths.includes(target));
      expect(noiseReads, '未命中的全仓噪声文件不得被读取').toHaveLength(0);
    } finally {
      scheduler.release();
      await index.waitForInitialScan().catch(() => undefined);
      fs.promises.readFile = realRead;
      cleanup();
    }
  });

  it('后台补全量可观测:释放后分块真执行、噪声类可查、按需单文件先于后台全量', async () => {
    const { dir, paths, cleanup } = makeRoot(UNBLOCK_FILES);
    pointWorkspaceAt(dir);
    routeWorkspacePy(Object.values(paths).filter(target => target.endsWith('.py')));

    try {
      const scheduler = new GatedBackgroundScheduler();
      scheduler.release();
      const index = new PythonClassIndex(scheduler);
      const hits = await index.resolveSelfMethodCandidates(paths['query.py'], 1, 'meth');
      expect(hits[0].filePath).toBe(paths['base.py']);
      await index.waitForInitialScan();
      expect(scheduler.executedFullReindex, '后台补全量真实执行').toBeGreaterThan(0);
      expect(scheduler.getStatus().failed, '后台分块无失败').toBe(0);
      expect(await index.findClassesByName('Noise0'), '全量补齐后噪声类可查').toHaveLength(1);
      const firstSingle = scheduler.executionOrder.indexOf('single-file-update');
      const firstFull = scheduler.executionOrder.indexOf('full-reindex');
      expect(firstSingle).toBeGreaterThanOrEqual(0);
      expect(firstFull).toBeGreaterThan(-1);
      expect(firstSingle, '按需单文件必须先于后台全量分块执行').toBeLessThan(firstFull);
    } finally {
      cleanup();
    }
  });
});

/**
 * PR5 ② 观测面:放行/扣住后台全量分块的调度器。发现任务(initial-scan)与按需
 * 单文件任务(single-file-update)原样透传;full-reindex 分块在 release() 之前
 * 只记数不执行——用于断言「首查不依赖全仓扫描」与「后台补全量可观测」。
 */
class GatedBackgroundScheduler extends IndexScheduler {
  /** 各类任务真实执行计数(执行时点,非入队时点) */
  readonly executedByKind = new Map<IndexTaskKind, number>();
  /** 真实执行顺序(断言交互单文件先于后台全量) */
  readonly executionOrder: IndexTaskKind[] = [];
  /** 已扣住尚未执行的 full-reindex 分块数 */
  private gatedQueued = 0;
  private chunksEnqueuedHandle: Promise<void> | null = null;
  private resolveChunksEnqueued: (() => void) | null = null;
  private releaseGate: (() => void) | null = null;

  /**
   * 首个分块入队即 resolve。断言「后台在推进」必须锚在真实入队时点——
   * 首查经 scheduleBackgroundScan 拉起的是后台发现(异步),分块要在发现
   * 完成后才入队;首查返回就断言 gatedCount 会抢到发现前面(0 而非 >0)。
   */
  get chunksEnqueued(): Promise<void> {
    if (!this.chunksEnqueuedHandle) {
      this.chunksEnqueuedHandle = new Promise<void>(resolve => {
        this.resolveChunksEnqueued = resolve;
      });
    }
    return this.chunksEnqueuedHandle;
  }
  private readonly released = new Promise<void>(resolve => {
    this.releaseGate = resolve;
  });

  release(): void {
    this.releaseGate?.();
  }

  override enqueue(spec: IndexTaskSpec): IndexTaskHandle {
    if (spec.kind !== 'full-reindex') {
      return super.enqueue({
        ...spec,
        run: async () => {
          this.record(spec.kind);
          await spec.run();
        }
      });
    }
    this.gatedQueued += 1;
    this.resolveChunksEnqueued?.();
    const wait = this.released
      .then(() => super.enqueue({
        ...spec,
        run: async () => {
          this.record('full-reindex');
          await spec.run();
        }
      }))
      .then(handle => handle.wait);
    wait.catch(() => undefined);
    return { id: -1, wait, cancel: () => undefined, state: () => 'queued' as IndexTaskState };
  }

  get gatedCount(): number {
    return this.gatedQueued;
  }

  get executedFullReindex(): number {
    return this.executedByKind.get('full-reindex') ?? 0;
  }

  private record(kind: IndexTaskKind): void {
    this.executionOrder.push(kind);
    this.executedByKind.set(kind, (this.executedByKind.get(kind) ?? 0) + 1);
  }
}

/**
 * 观测面:让下一个 full-reindex 分块按注入失败(run 抛错),其余任务原样透传。
 * 用于锁定「分块拒绝不再被逐一吞掉后照旧标记扫描代完成」——失败分块的文件
 * 必须由后续查询定向补解析,而不是从未解析就永久缺席。
 */
class FailNextChunkScheduler extends IndexScheduler {
  private failNext = false;
  /** 已按注入失败执行的 full-reindex 分块数 */
  failedChunks = 0;

  failNextChunk(): void {
    this.failNext = true;
  }

  override enqueue(spec: IndexTaskSpec): IndexTaskHandle {
    if (spec.kind !== 'full-reindex' || !this.failNext) {
      return super.enqueue(spec);
    }
    this.failNext = false;
    this.failedChunks += 1;
    return super.enqueue({
      ...spec,
      run: async () => { throw new Error('injected chunk crash'); }
    });
  }

  /** 等队列排空(重试分块真实执行完);不轮询则断言会抢在补解析前面 */
  async waitForIdle(timeoutMs = 2000): Promise<void> {
    const start = Date.now();
    for (;;) {
      const status = this.getStatus();
      if (status.queued === 0 && status.running === null) { return; }
      if (Date.now() - start > timeoutMs) {
        throw new Error('scheduler did not go idle');
      }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
}

/**
 * PR5 ② 资产:query.py 的内联调用经同目录 base.py 的基类回答(命中路径);
 * call.py 的 Beta 定义在子目录 pkg/ 下(未命中路径,靠定点 glob 补载);
 * noise/ 子目录是全仓噪声——不在查询文件同目录,staging 不会读,只有全量
 * 扫描会读,所以它是「全仓扫描是否真跑了」的探针。
 */
const UNBLOCK_FILES: Record<string, string> = {
  'query.py': 'class Avatar(Alpha):\n\tdef tick(self):\n\t\tself.meth()\n',
  'base.py': 'class Alpha:\n\tdef meth(self):\n\t\treturn 1\n',
  'call.py': 'x = Beta()\n',
  'pkg/Beta.py': 'class Beta:\n\tpass\n',
  ...Object.fromEntries(
    Array.from({ length: 6 }, (_, offset) => {
      const label = String(offset).padStart(2, '0');
      return [`noise/n${label}.py`, `class Noise${offset}:\n\tpass\n`];
    })
  )
};

/**
 * workspace 文件发现路由:按 glob 形状区分全量与定点——递归通配全部 py 的
 * glob 返回整批(含噪声子目录);定点 glob(双星加固定类名)只返回同名文件。
 * 定点 glob 若被喂整批,「按需单文件解析」的断言就失去意义。
 */
const routeWorkspacePy = (allPyPaths: string[]): void => {
  stubFindFiles(pattern => {
    const patternText = String(pattern ?? '');
    if (!patternText.endsWith('.py')) {
      return [];
    }
    const baseName = patternText.replace(/\*\*\/(.+)$/, '$1');
    if (baseName === '*.py') {
      return allPyPaths;
    }
    return allPyPaths.filter(target => path.basename(target) === baseName);
  });
};

function paths0(dir: string, name: string): string {
  return path.join(dir, name);
}
