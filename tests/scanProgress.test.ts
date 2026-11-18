// SCAN-RESUME-001 扫描断点续扫(2026-11-18 用户令「扫描一半可以关闭
// 重新打开可以继续扫描」):
// 纯核面:序列化投影往返(Map 重建)/版本门/损坏弃用/恢复计划指纹匹配/
// 清场/写失败静默。
// 索引面七钉子:①中途断(第二块失败)重开→第一块 16 文件直取采纳(计数断言)
// ②漂移文件不采纳照扫 ③全量零失败→断点清场 ④kode 版本门作废
// ⑤采纳只发生在扫描内部(查询面 loading/partial 口径不动,不提前开放)
// ⑥progress.json 损坏→等同无断点全扫不 crash ⑦无控制器兼容(正常路径不受断点逻辑影响)。
//
// 夹具口径:20 个 py 文件(块大小 16 → 块0=16 文件,块1=4 文件);
// 第 N 块失败调度器模拟「扫描一半中断」;断点目录 = mkdtemp 真盘(指纹要真 stat)。

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PythonClassIndex } from '../src/backend/pythonClassIndex';
import { IndexScheduler, type IndexTaskHandle, type IndexTaskSpec } from '../src/backend/indexScheduler';
import { parsePythonFile } from '../src/backend/pythonParser';
import {
  clearScanProgressDir,
  defaultScanProgressIo,
  parsedPythonFileEqualsRoundtrip,
  planResume,
  readScanProgress,
  restoreSerializedParsedPythonFile,
  SCAN_PROGRESS_DIR_NAME,
  SCAN_PROGRESS_SCHEMA_VERSION,
  ScanProgressController,
  serializeParsedPythonFile,
  type ScanProgressEntry,
  type ScanProgressIo,
  type ScanProgressMetaFile
} from '../src/backend/scanProgress';
import { Uri, workspace as stubWorkspace } from './helpers/vscodeStub';

const p = (root: string, ...segments: string[]) => path.join(root, ...segments);

const makeProgressDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'kode-scan-progress-'));

const PY_FILE_COUNT = 20;
const pyFilePath = (root: string, n: number): string => p(root, 'scripts', `mod${String(n).padStart(2, '0')}.py`);
const pyFileContent = (n: number): string =>
  `import KBEngine\n\n\nclass Mod${String(n).padStart(2, '0')}(object):\n    def onTick${n}(self):\n        return ${n}\n`;

interface Fixture {
  root: string;
  files: string[];
  cleanup(): void;
}

const makeFixture = (): Fixture => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-scan-resume-'));
  const files: string[] = [];
  for (let n = 0; n < PY_FILE_COUNT; n += 1) {
    fs.mkdirSync(path.dirname(pyFilePath(root, n)), { recursive: true });
    fs.writeFileSync(pyFilePath(root, n), pyFileContent(n), 'utf8');
    files.push(pyFilePath(root, n));
  }
  return {
    root,
    files,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true })
  };
};

const pointWorkspaceAt = (root: string, files: string[]): void => {
  stubWorkspace.workspaceFolders = [{ uri: Uri.file(root), name: 'resume', index: 0 }];
  const original = stubWorkspace.findFiles;
  stubWorkspace.findFiles = (async (pattern?: unknown) =>
    String(pattern ?? '').includes('*.py') ? files.map(file => Uri.file(file)) : []) as typeof stubWorkspace.findFiles;
  void original;
};

/** 第 N 个 full-reindex 任务注入失败:模拟「扫描一半中断」(其余块照常完成) */
class FailNthChunkScheduler extends IndexScheduler {
  private fullReindexCount = 0;

  constructor(private readonly failAt: number) {
    super();
  }

  override enqueue(spec: IndexTaskSpec): IndexTaskHandle {
    if (spec.kind !== 'full-reindex') { return super.enqueue(spec); }
    this.fullReindexCount += 1;
    if (this.fullReindexCount === this.failAt) {
      return super.enqueue({ ...spec, run: async () => { throw new Error('chunk cancelled'); } });
    }
    return super.enqueue(spec);
  }
}

/** 等待扫描收敛(fileCache 计数到位) */
const waitFor = async (predicate: () => boolean, what: string): Promise<void> => {
  for (let i = 0; i < 500; i += 1) {
    if (predicate()) { return; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`timeout waiting: ${what}`);
};

const fileCacheSize = (index: PythonClassIndex): number =>
  (index as unknown as { fileCache: Map<string, unknown> }).fileCache.size;

let fixture: Fixture;
let progressDir: string;
const originalWorkspaceFolders = stubWorkspace.workspaceFolders;

beforeEach(() => {
  fixture = makeFixture();
  progressDir = makeProgressDir();
});

afterEach(() => {
  fixture.cleanup();
  fs.rmSync(progressDir, { recursive: true, force: true });
  stubWorkspace.workspaceFolders = originalWorkspaceFolders;
});

describe('SCAN-RESUME-001 纯核(零 vscode)', () => {
  /** 真盘源文件(recordChunk 指纹自查盘,幽灵路径=无指纹不入断点) */
  const realPy = (): { file: string; parsed: ReturnType<typeof parsePythonFile> } => {
    const file = p(fixture.root, 'plain.py');
    fs.writeFileSync(file, 'class Plain(object):\n    def tick(self):\n        pass\n', 'utf8');
    return { file, parsed: parsePythonFile('class Plain(object):\n    def tick(self):\n        pass\n', file) };
  };

  it('序列化投影往返:methods/imports Map 重建逐字节等价,可选字段保形', () => {
    const content = 'import KBEngine\nfrom x import y\n\n\nclass A(object):\n    def m(self):\n        pass\n';
    const parsed = parsePythonFile(content, '/ws/a.py');
    expect(parsed.classes.length).toBeGreaterThan(0);
    const restored = restoreSerializedParsedPythonFile(serializeParsedPythonFile(parsed));
    expect(restored.classes[0].methods).toBeInstanceOf(Map);
    expect(parsedPythonFileEqualsRoundtrip(parsed, restored)).toBe(true);
    // 无 import 源码:解析面给空 Map,投影保形(空表→空 Map,不臆造 undefined)
    const bare = parsePythonFile('class B:\n    pass\n', '/ws/b.py');
    const bareRestored = restoreSerializedParsedPythonFile(serializeParsedPythonFile(bare));
    expect(bareRestored.imports?.size ?? 0).toBe(0);
    expect(parsedPythonFileEqualsRoundtrip(bare, bareRestored)).toBe(true);
  });

  it('readScanProgress:版本门(schema/kodeVersion/engineMajor)分级不符 → null;meta 损坏 → null;'
    + 'meta 列了但分块文件缺失/损坏 → 整体弃用不部分采纳', () => {
    const io = defaultScanProgressIo;
    const real = realPy();
    const controller = new ScanProgressController(progressDir, 'v1', '2');
    controller.recordChunk(0, [{ path: real.file, version: 1, parsed: real.parsed }]);
    return controller.settle().then(() => {
      const expected = { schemaVersion: SCAN_PROGRESS_SCHEMA_VERSION, kodeVersion: 'v1', engineMajor: '2' };
      expect(readScanProgress(progressDir, expected, io)).not.toBeNull();
      // 扩展版本号滚动 → 断点仍可用(「一直在扫」病根:它曾是淘汰键)
      expect(readScanProgress(progressDir, { ...expected, kodeVersion: 'v2' }, io)).not.toBeNull();
      // 引擎 API 主版本变 → 弃用重扫
      expect(readScanProgress(progressDir, { ...expected, engineMajor: '3' }, io)).toBeNull();
      expect(readScanProgress(progressDir, { ...expected, schemaVersion: 'scan-progress/9' }, io)).toBeNull();
      // meta 损坏
      fs.writeFileSync(p(progressDir, 'progress.json'), '{not json', 'utf8');
      expect(readScanProgress(progressDir, expected, io)).toBeNull();
      // 恢复 meta 但删分块文件(半截)
      const meta: ScanProgressMetaFile = {
        schema: SCAN_PROGRESS_SCHEMA_VERSION, kodeVersion: 'v1', chunks: [0], chunksDone: 1
      };
      fs.writeFileSync(p(progressDir, 'progress.json'), JSON.stringify(meta), 'utf8');
      fs.unlinkSync(p(progressDir, 'chunk-0.json'));
      expect(readScanProgress(progressDir, expected, io)).toBeNull();
    });
  });

  it('planResume:指纹匹配采纳/漂移照扫/新增照扫/已删文件不复用/stat 不可得照扫', () => {
    const entry = (file: string, mtimeMs: number, size: number): ScanProgressEntry => ({
      path: file, mtimeMs, size, version: 1,
      parsed: serializeParsedPythonFile(parsePythonFile('class A:\n    pass\n', file))
    });
    const stats = new Map<string, { mtimeMs: number; size: number } | null>([
      ['/a.py', { mtimeMs: 1, size: 10 }],
      ['/b.py', { mtimeMs: 2, size: 20 }],        // 漂移:指纹是旧值
      // '/c.py' stat 不可得(null)
      ['/d.py', { mtimeMs: 4, size: 40 }]
    ]);
    const plan = planResume(
      [entry('/a.py', 1, 10), entry('/b.py', 99, 20), entry('/ghost.py', 9, 9), entry('/e.py', 5, 50)],
      ['/a.py', '/b.py', '/c.py', '/d.py', '/new.py'],
      file => stats.get(file) ?? null
    );
    expect([...plan.adopt.keys()]).toEqual(['/a.py']);
    expect(plan.scan).toEqual(['/b.py', '/c.py', '/d.py', '/new.py']);
  });

  it('clearScanProgressDir:meta+分块全清;控制器写失败静默不 crash(settle 落定)', async () => {
    const real = realPy();
    const controller = new ScanProgressController(progressDir, 'v1');
    controller.recordChunk(0, [{ path: real.file, version: 1, parsed: real.parsed }]);
    await controller.settle();
    expect(fs.existsSync(p(progressDir, 'progress.json'))).toBe(true);
    expect(fs.existsSync(p(progressDir, 'chunk-0.json'))).toBe(true);
    clearScanProgressDir(progressDir);
    expect(fs.existsSync(p(progressDir, 'progress.json'))).toBe(false);
    expect(fs.existsSync(p(progressDir, 'chunk-0.json'))).toBe(false);

    const throwingIo: ScanProgressIo = {
      ...defaultScanProgressIo,
      writeTextAtomic: () => { throw new Error('disk full'); }
    };
    const failing = new ScanProgressController(progressDir, 'v1', '', throwingIo);
    failing.recordChunk(0, [{ path: real.file, version: 1, parsed: real.parsed }]);
    await failing.settle();
    await failing.complete();
    // 静默:无抛出、无残留 meta(写失败=断点不存在,下次照扫)
    expect(fs.existsSync(p(progressDir, 'progress.json'))).toBe(false);
  });
});

describe('SCAN-RESUME-001 索引面七钉子', () => {
  it('钉子①:扫描一半中断(第二块失败)→ 重开第一块 16 文件直取采纳,只扫剩余 4 个', async () => {
    pointWorkspaceAt(fixture.root, fixture.files);
    // 第一轮:块0(16 文件)完成落断点,块1 失败=「扫描一半关闭」
    const interrupted = new ScanProgressController(progressDir, 'v1');
    const first = new PythonClassIndex(new FailNthChunkScheduler(2), interrupted);
    await first.findClassesByName('Mod00').catch(() => undefined);
    await interrupted.settle();
    expect(fs.existsSync(p(progressDir, 'chunk-0.json'))).toBe(true);

    // 重开:新实例+新控制器(同目录)→ 断点采纳 16、实扫 4
    const resumed = new ScanProgressController(progressDir, 'v1');
    const second = new PythonClassIndex(new IndexScheduler(), resumed);
    expect(fileCacheSize(second)).toBe(0);
    expect(second.getScanResumeStatsForTests()).toBeNull();
    await second.findClassesByName('Mod00');
    await waitFor(() => fileCacheSize(second) === PY_FILE_COUNT, 'resumed scan completes');
    expect(second.getScanResumeStatsForTests()).toEqual({ adopted: 16, scanned: 4 });
    // 直取结果与解析同源:抽查一个采纳文件的类/方法
    const parsed = (second as unknown as {
      fileCache: Map<string, { parsed: { classes: Array<{ name: string; methods: Map<string, unknown> }> } }>;
    }).fileCache.get(pyFilePath(fixture.root, 3))!.parsed;
    expect(parsed.classes[0].name).toBe('Mod03');
    expect(parsed.classes[0].methods.has('onTick3')).toBe(true);
    void first;
  }, 20000);

  it('钉子②:断点指纹漂移的文件(内容已变)不采纳,照扫', async () => {
    pointWorkspaceAt(fixture.root, fixture.files);
    const interrupted = new ScanProgressController(progressDir, 'v1');
    const first = new PythonClassIndex(new FailNthChunkScheduler(2), interrupted);
    await first.findClassesByName('Mod00').catch(() => undefined);
    await interrupted.settle();

    // 块0 内第 5 个文件改内容(size/mtime 漂移)
    const drifted = pyFilePath(fixture.root, 5);
    fs.writeFileSync(drifted, pyFileContent(5) + '\n\nclass Drifted(object):\n    pass\n', 'utf8');

    const resumed = new ScanProgressController(progressDir, 'v1');
    const second = new PythonClassIndex(new IndexScheduler(), resumed);
    await second.findClassesByName('Mod00');
    await waitFor(() => fileCacheSize(second) === PY_FILE_COUNT, 'drift scan completes');
    expect(second.getScanResumeStatsForTests()).toEqual({ adopted: 15, scanned: 5 });
    // 漂移文件重扫拿到新内容(断点旧内容绝不复用)
    const classes = await second.findClassesByName('Drifted');
    expect(classes.map(cls => cls.name)).toContain('Drifted');
  }, 20000);

  it('钉子③:全量零失败完成 → 断点清场(progress.json/chunk 全删)', async () => {
    pointWorkspaceAt(fixture.root, fixture.files);
    const controller = new ScanProgressController(progressDir, 'v1');
    const index = new PythonClassIndex(new IndexScheduler(), controller);
    await index.findClassesByName('Mod00');
    await waitFor(() => fileCacheSize(index) === PY_FILE_COUNT, 'full scan completes');
    await controller.settle();
    await controller.complete();
    expect(fs.existsSync(p(progressDir, 'progress.json'))).toBe(false);
    expect(fs.existsSync(p(progressDir, 'chunk-0.json'))).toBe(false);
    expect(fs.existsSync(p(progressDir, 'chunk-1.json'))).toBe(false);
    expect(index.getScanResumeStatsForTests()).toEqual({ adopted: 0, scanned: PY_FILE_COUNT });
  }, 20000);

  it('钉子④:引擎主版本门——引擎换大版本断点作废全量照扫;扩展版本号滚动不再作废', async () => {
    pointWorkspaceAt(fixture.root, fixture.files);
    const interrupted = new ScanProgressController(progressDir, 'v0.1', '2');
    const first = new PythonClassIndex(new FailNthChunkScheduler(2), interrupted);
    await first.findClassesByName('Mod00').catch(() => undefined);
    await interrupted.settle();
    expect(fs.existsSync(p(progressDir, 'progress.json'))).toBe(true);

    // 扩展版本号滚动(升级重启):断点仍可用,增量续扫——「一直在扫」的病根
    // 就是旧版本键把每次升级都判成断点作废
    const upgraded = new ScanProgressController(progressDir, 'v0.2', '2');
    const second = new PythonClassIndex(new IndexScheduler(), upgraded);
    await second.findClassesByName('Mod00');
    await waitFor(() => fileCacheSize(second) === PY_FILE_COUNT, 'upgraded incremental resume completes');
    // 增量续扫:采纳断点已扫的分块,只扫剩余
    const resumed = second.getScanResumeStatsForTests();
    expect(resumed.adopted).toBeGreaterThan(0);
    expect(resumed.scanned).toBeLessThan(PY_FILE_COUNT);
    expect(resumed.adopted + resumed.scanned).toBe(PY_FILE_COUNT);

    // 清场重来(只验证引擎换大版本的作废面)
    clearScanProgressDir(progressDir);
    const engine2 = new ScanProgressController(progressDir, 'v0.1', '2');
    const third = new PythonClassIndex(new FailNthChunkScheduler(2), engine2);
    await third.findClassesByName('Mod00').catch(() => undefined);
    await engine2.settle();
    const engine3 = new ScanProgressController(progressDir, 'v0.1', '3');
    const fourth = new PythonClassIndex(new IndexScheduler(), engine3);
    await fourth.findClassesByName('Mod00');
    await waitFor(() => fileCacheSize(fourth) === PY_FILE_COUNT, 'engine-major-change full scan completes');
    expect(fourth.getScanResumeStatsForTests()).toEqual({ adopted: 0, scanned: PY_FILE_COUNT });
  }, 20000);

  it('钉子⑤:采纳只发生在扫描内部——载入断点不等于提前开放查询(构造/载入零入索引)', async () => {
    pointWorkspaceAt(fixture.root, fixture.files);
    const interrupted = new ScanProgressController(progressDir, 'v1');
    const first = new PythonClassIndex(new FailNthChunkScheduler(2), interrupted);
    await first.findClassesByName('Mod00').catch(() => undefined);
    await interrupted.settle();

    // 「重开」:新实例构造+断点在手,但扫描未跑——索引必须仍为空(查询面
    // 照旧 loading/partial 口径,断点不提前对外服务)
    const resumed = new ScanProgressController(progressDir, 'v1');
    const plan = resumed.loadResumePlan(fixture.files);
    expect(plan?.adopt.size).toBe(16);
    expect(plan?.scan.length).toBe(4);
    // 清场后目录已空(计划驻内存),盘上无断点可复用
    expect(fs.existsSync(p(progressDir, 'progress.json'))).toBe(false);
    const second = new PythonClassIndex(new IndexScheduler(), resumed);
    expect(fileCacheSize(second)).toBe(0);
    expect(second.getScanResumeStatsForTests()).toBeNull();
  }, 20000);

  it('钉子⑥:progress.json 损坏 → 等同无断点全扫,不 crash', async () => {
    pointWorkspaceAt(fixture.root, fixture.files);
    const interrupted = new ScanProgressController(progressDir, 'v1');
    const first = new PythonClassIndex(new FailNthChunkScheduler(2), interrupted);
    await first.findClassesByName('Mod00').catch(() => undefined);
    await interrupted.settle();
    fs.writeFileSync(p(progressDir, 'progress.json'), '<<<corrupted>>>', 'utf8');

    const recovered = new ScanProgressController(progressDir, 'v1');
    const second = new PythonClassIndex(new IndexScheduler(), recovered);
    await second.findClassesByName('Mod00');
    await waitFor(() => fileCacheSize(second) === PY_FILE_COUNT, 'recovery scan completes');
    expect(second.getScanResumeStatsForTests()).toEqual({ adopted: 0, scanned: PY_FILE_COUNT });
  }, 20000);

  it('钉子⑦:无控制器兼容——正常完成路径不受断点逻辑影响(统计面缺席)', async () => {
    pointWorkspaceAt(fixture.root, fixture.files);
    const index = new PythonClassIndex(new IndexScheduler());
    const classes = await index.findClassesByName('Mod07');
    expect(classes.map(cls => cls.name)).toContain('Mod07');
    await waitFor(() => fileCacheSize(index) === PY_FILE_COUNT, 'plain scan completes');
    expect(index.getScanResumeStatsForTests()).toEqual({ adopted: 0, scanned: PY_FILE_COUNT });
    expect(fs.readdirSync(progressDir)).toEqual([]);
    void SCAN_PROGRESS_DIR_NAME;
  }, 20000);
});
