import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PythonClassIndex, parsePythonFile } from '../src/backend/pythonClassIndex';
import { IndexScheduler, IndexTaskPriority } from '../src/indexScheduler';
import { clearRecentJumpLogs, getRecentJumpLogs, setJumpLogEnabled } from '../src/navigationLog';
import { makeTextDocument, Uri, workspace as stubWorkspace } from './helpers/vscodeStub';

// pythonClassIndex.ts 缺口臂(2026-11-09 覆盖率扫尾,对齐 baseline 25 行):
//   resolveSymbol 的 import 循环护栏/导入链落空臂、相对导入 (`..x`) 路径上卷、
//   removeRoot 空路径、unindexFile 同名类已摘除防御臂、组合根派生的「打开缓冲
//   内容」面与 8 次让位落地、loadFileOnDemand 已缓存/在途取消臂、stageRequestFiles
//   与 stageClassNameFiles 的取消位、onDocumentChanged/asyncDocumentParse 解析
//   失败臂、resolveClassBase 类名补载取消、resolveSelfMethodResolution 的
//   stageRequestFiles 取消 / 组合根超时无静态目标 / 全量扫描超时三面。
//
// 记录的死臂(不以真实 fs/公共 API 强测,附证据):
//   * line 900 col 30(schedulePendingScanRetry `if (files.length === 0) return` 的
//     空文件 return):不可达。line 898 已 `if (this.scanRetryInFlight ||
//     this.pendingScanRetries.size === 0) return`;files 是紧接其后由同一 Map
//     同步 `[...keys()]` 派生的数组,两行之间无任何 await/外部写入口,
//     size===0 ⟺ files.length===0,第二个守卫恒为假。守卫求值(col 4)本身可达,
//     由「完成代触发待补重试调度」用例覆盖。
//   * line 1422 col 44(resolveSelfMethodResolution 组合根循环取消 return `{
//     candidates: [], partial: true }`):仅取消臂不可达。能走到 line 1422 必先经
//     line 1401 `await raceWithBudget(...)` 得非空 rootsReady;raceWithBudget
//     (hoverBudget.ts) 在 token 预取消(入口 `if (token?.isCancellationRequested)
//     return null`)或取消于等待期间(`stopped` 监听 resolve null)都返回 null →
//     line 1403 `!rootsReady` 早退。非空返回后到 line 1422 全同步(line 1417-1421),
//     无 await/无事件循环让位,标志位不可能翻转。守卫求值(col 6)本身可达,由
//     「组合根与反向后代均落空」用例覆盖。
//   * line 1460 col 44(反向后代扫描取消 return):仅取消臂不可达。同理:到达
//     line 1460 必先经 line 1449/1450 `await raceWithBudget('definition:python-index',
//     ...)` 返回非空 scanReady(line 1452 `!scanReady` 早退)与 pass 0/1 的
//     line 1401 rootsReady 非空;token 预取消或等待期取消都被这两个 raceWithBudget
//     吸收为 null 并早退,非空返回后到 line 1460 全同步,标志位无法翻转。守卫
//     求值(col 6)本身可达,由同一用例覆盖。

const parseState = vi.hoisted(() => ({
  impl: undefined as
    | undefined
    | ((content: string, filePath: string, revision: number) => Promise<unknown>)
}));

vi.mock('../src/backend/pythonParserWorkerHost', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/backend/pythonParserWorkerHost')>();
  return {
    ...actual,
    parsePythonFileResponsive: (...args: unknown[]) =>
      parseState.impl
        ? (parseState.impl as (...a: unknown[]) => Promise<unknown>)(...args as [string, string, number])
        : (actual.parsePythonFileResponsive as (...a: unknown[]) => Promise<unknown>)(...args)
  };
});

/** 确定性解析替身:同步 parsePythonFile 包成 worker 应答形态(不开真 worker) */
const deterministicParse = (content: string, filePath: string, revision: number): Promise<unknown> =>
  Promise.resolve({ revision, parsed: parsePythonFile(content, filePath) });

const cancelableToken = () => {
  let listener: (() => void) | undefined;
  const token = {
    isCancellationRequested: false,
    onCancellationRequested(callback: () => void) {
      listener = callback;
      return { dispose: () => { listener = undefined; } };
    }
  };
  return {
    token: token as never,
    cancel: () => { token.isCancellationRequested = true; listener?.(); }
  };
};

type ClassIndexInternals = PythonClassIndex & {
  updateFile(file: string, content: string, version: number): void;
  unindexFile(file: string): void;
  loadFileOnDemand(file: string): Promise<void>;
  stageRequestFiles(file: string, token?: unknown): Promise<void>;
  stageClassNameFiles(names: string[], token?: unknown): Promise<void>;
  documents: Map<string, unknown>;
  fileCache: Map<string, { version: number; parsed: { classes: Array<{ name: string }>; imports?: Map<string, unknown>; instanceAssignments: unknown[] } }>;
  byName: Map<string, Array<{ filePath: string }>>;
  stagedRequests: Map<string, unknown>;
  pendingScanRetries: Map<string, number>;
  rootsMap: { roots: string[]; defMixins: Map<string, string[]> } | null;
  scheduler: IndexScheduler;
  scanGeneration: number;
  scanCompletedGeneration: number;
  scanRetryInFlight: boolean;
  ensureScanned(): Promise<void>;
};

const asInternals = (index: PythonClassIndex): ClassIndexInternals => index as ClassIndexInternals;

const cleanups: Array<() => void> = [];
const makeRoot = (files: Record<string, string>): Record<string, string> => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-pci-gap-'));
  const paths: Record<string, string> = {};
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(dir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
    paths[name] = full;
  }
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return paths;
};

const pointWorkspaceAt = (dir: string): void => {
  stubWorkspace.workspaceFolders = [{ uri: Uri.file(dir), name: 'ws', index: 0 }];
};

const stubFindFiles = (routing: (pattern: string) => string[]): void => {
  stubWorkspace.findFiles = (async (pattern?: unknown) =>
    routing(String(pattern ?? '')).map(file => Uri.file(file))) as typeof stubWorkspace.findFiles;
};

const ASSET_FILES = {
  'entities.xml': '<?xml version="1.0"?><entities><Avatar/></entities>',
  'types.xml': '<types><VECTOR3>FLOAT32</VECTOR3></types>',
  'Avatar.def': '<root><Properties><name><Type>VECTOR3</Type></name></Properties></root>',
  'Avatar.py': 'class Avatar:\n\tdef onTimer(self):\n\t\treturn 0\n',
  'bridge.py': 'avatar_instance = Avatar()\n'
};

const assetRouting = (paths: Record<string, string>) => (pattern: string): string[] => {
  const glob = pattern.replace(/\*\*\//, '');
  if (glob === 'entities.xml') { return [paths['entities.xml']]; }
  if (glob === 'types.xml') { return [paths['types.xml']]; }
  if (glob.endsWith('.def')) { return [paths['Avatar.def']]; }
  if (glob.includes('*.py')) { return [paths['Avatar.py'], paths['bridge.py']]; }
  return [];
};

beforeEach(() => {
  parseState.impl = deterministicParse;
  stubWorkspace.workspaceFolders = [];
  stubWorkspace.findFiles = async () => [];
  stubWorkspace.textDocuments = [];
});

afterEach(() => {
  parseState.impl = undefined;
  stubWorkspace.workspaceFolders = [];
  stubWorkspace.findFiles = async () => [];
  setJumpLogEnabled(false);
  clearRecentJumpLogs();
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

describe('pythonClassIndex 缺口臂:resolveSymbol 导入环/落空与相对导入上卷', () => {
  it('相互 import 环(循环导入)→ 循环护栏返回 null(268)', async () => {
    const paths = makeRoot({
      'scripts/cell/a.py': 'from b import x\n',
      'scripts/cell/b.py': 'from a import x\n'
    });
    pointWorkspaceAt(path.dirname(paths['scripts/cell/a.py']));
    stubFindFiles(pattern => (pattern.includes('*.py') ? [paths['scripts/cell/a.py'], paths['scripts/cell/b.py']] : []));
    const index = new PythonClassIndex();
    const doc = makeTextDocument('from b import x\n', { fileName: paths['scripts/cell/a.py'], languageId: 'python' });
    expect(await index.resolveClassBase(doc, 'x')).toBeNull();
  });

  it('导入链落空(递归后无可解析绑定)→ importedLookup 面返回 null(303)', async () => {
    const paths = makeRoot({
      'scripts/cell/a.py': 'from b import x\n',
      'scripts/cell/b.py': '# 空模块:无导入、无同名类\n'
    });
    pointWorkspaceAt(path.dirname(paths['scripts/cell/a.py']));
    stubFindFiles(pattern => (pattern.includes('*.py') ? [paths['scripts/cell/a.py'], paths['scripts/cell/b.py']] : []));
    const index = new PythonClassIndex();
    const doc = makeTextDocument('from b import x\n', { fileName: paths['scripts/cell/a.py'], languageId: 'python' });
    expect(await index.resolveClassBase(doc, 'x')).toBeNull();
  });

  it('相对导入 ..base:候选路径逐级上卷后命中兄弟目录文件(318)', async () => {
    const paths = makeRoot({
      'scripts/cell/sub/A.py': 'from ..base import Mixin\nclass A(Mixin):\n\tpass\n',
      'scripts/cell/base.py': 'class Mixin:\n\tpass\n'
    });
    pointWorkspaceAt(path.dirname(paths['scripts/cell/sub/A.py']));
    stubFindFiles(pattern => (pattern.includes('*.py') ? [paths['scripts/cell/sub/A.py'], paths['scripts/cell/base.py']] : []));
    const index = new PythonClassIndex();
    const doc = makeTextDocument('from ..base import Mixin\nclass A(Mixin):\n\tpass\n', {
      fileName: paths['scripts/cell/sub/A.py'],
      languageId: 'python'
    });
    const resolved = await index.resolveClassBase(doc, 'Mixin');
    expect(resolved?.name).toBe('Mixin');
    expect(resolved?.filePath).toBe(paths['scripts/cell/base.py']);
  });
});

describe('pythonClassIndex 缺口臂:removeRoot / unindexFile / loadFileOnDemand', () => {
  it('removeRoot 空路径 → 空操作返回 0(428)', () => {
    const index = new PythonClassIndex();
    expect(index.removeRoot('')).toBe(0);
  });

  it('unindexFile 防御臂:同名类已被摘除后再次摘除不抛(628)', () => {
    const index = new PythonClassIndex();
    const internals = asInternals(index);
    const file = '/ghost/svc.py';
    internals.updateFile(file, 'class Svc:\n\tpass\n', 1);
    expect(internals.byName.get('Svc')?.map(hit => hit.filePath)).toEqual([file]);
    // 第一次摘除:byName 的 Svc 列表清空并删除
    internals.unindexFile(file);
    expect(internals.byName.has('Svc')).toBe(false);
    // 第二次摘除:fileCache 仍有该文件解析,但 byName 已无 Svc → 走防御 continue 臂
    expect(() => internals.unindexFile(file)).not.toThrow();
  });

  it('loadFileOnDemand 已缓存 → 立即 resolve 不新建在途请求(1027)', async () => {
    const index = new PythonClassIndex();
    const internals = asInternals(index);
    const file = '/ghost/cached.py';
    internals.updateFile(file, 'class Cached:\n\tpass\n', 1);
    await internals.loadFileOnDemand(file);
    expect(internals.stagedRequests.has(file)).toBe(false);
  });

  it('ensureScanned 完成代触发待补重试调度 → 900 守卫求值(空文件 return 真分支不可达)', async () => {
    const index = new PythonClassIndex();
    const internals = asInternals(index);
    // 登记一个解析失败遗留的待补文件,并把扫描代设为「已完成」→ ensureScanned
    // 走 schedulePendingScanRetry 分支:files 由同一 Map 同步派生,size>0 ⟹
    // files.length>0,line 900 条件求值为假,继续入队定向补解析任务。
    internals.pendingScanRetries.set('/ghost/retry.py', 1);
    internals.scanGeneration = 0;
    internals.scanCompletedGeneration = 0;
    // ensureScanned 同步走「完成代」分支并调用 schedulePendingScanRetry:898/900
    // 守卫同步求值,901 置 scanRetryInFlight(任务本身异步泵送)
    const ensurePromise = internals.ensureScanned();
    expect(internals.scanRetryInFlight).toBe(true);
    await ensurePromise;
    // 不可读文件本次提交 false → 重试计数仍登记(1 或已推进到 2),未被误删
    expect([1, 2]).toContain(internals.pendingScanRetries.get('/ghost/retry.py'));
  });

  it('loadFileOnDemand 在途任务被同文件新版任务取消 → wait 拒绝被 catch 吞掉(1041)', async () => {
    const paths = makeRoot({ 'x.py': 'class X:\n\tpass\n' });
    const file = paths['x.py'];
    const index = new PythonClassIndex();
    const internals = asInternals(index);
    const pending = internals.loadFileOnDemand(file);
    // 同步再入队同文件更新版任务:调度器把在队的旧版本任务取消(其 wait 拒绝)
    internals.scheduler.enqueue({
      kind: 'single-file-update',
      priority: IndexTaskPriority.RequestLocal,
      filePath: file,
      version: 1,
      run: async () => undefined
    });
    await pending;
    expect(internals.stagedRequests.has(file)).toBe(false);
  });
});

describe('pythonClassIndex 缺口臂:组合根派生缓冲面与让位风暴', () => {
  it('组合根派生读打开缓冲内容(元数据文件在编辑器缓冲)→ 690 面', async () => {
    const paths = makeRoot(ASSET_FILES);
    pointWorkspaceAt(path.dirname(paths['Avatar.py']));
    stubFindFiles(assetRouting(paths));
    const index = new PythonClassIndex();
    const internals = asInternals(index);
    // 把 entities.xml 注册进「打开文档」缓冲(非 py 文档走 documents 面)
    const xmlDoc = makeTextDocument(ASSET_FILES['entities.xml'], {
      fileName: paths['entities.xml'],
      languageId: 'xml'
    });
    await index.onDocumentChanged(xmlDoc);
    expect(internals.documents.has(paths['entities.xml'])).toBe(true);
    // 派生应读到缓冲内容(而非磁盘),且缓存该缓冲内容(mtimeMs=0 口径)
    expect(await index.rootsContaining('Avatar')).toContain('Avatar');
    expect(internals.fileCache.size).toBeGreaterThan(0);
  });

  it('组合根派生连续让位 8 次后按最后一次输入落地(807)', async () => {
    const paths = makeRoot(ASSET_FILES);
    pointWorkspaceAt(path.dirname(paths['Avatar.py']));
    setJumpLogEnabled(true);
    const index = new PythonClassIndex();
    const internals = asInternals(index);
    let mutation = 0;
    stubWorkspace.findFiles = (async (pattern?: unknown) => {
      const glob = String(pattern ?? '');
      if (glob.includes('entities.xml')) {
        // 每次派生尝试的发现阶段都改变赋值桥输入 → 输入指纹变化 → 让位
        mutation += 1;
        internals.updateFile(paths['bridge.py'], `instance = Cls${mutation}()\n`, 100 + mutation);
        return [Uri.file(paths['entities.xml'])];
      }
      if (glob.includes('types.xml')) { return [Uri.file(paths['types.xml'])]; }
      if (glob.includes('.def')) { return [Uri.file(paths['Avatar.def'])]; }
      if (glob.includes('*.py')) { return []; }
      return [];
    }) as typeof stubWorkspace.findFiles;
    await index.rootsContaining('Avatar');
    // 8 次让位日志落地,且派生按最后一次输入正确收尾
    expect(getRecentJumpLogs().some(line => line.includes('连续让位 8 次'))).toBe(true);
    expect(internals.rootsMap?.roots).toContain('Avatar');
    expect(mutation).toBeGreaterThanOrEqual(8);
  });
});

describe('pythonClassIndex 缺口臂:stageRequestFiles / stageClassNameFiles 取消位', () => {
  it('stageRequestFiles:查询文件解析中取消 → 1059 早退,import 候选未补载', async () => {
    const paths = makeRoot({
      'main.py': 'from helper import Thing\n',
      'helper.py': 'class Thing:\n\tpass\n'
    });
    const index = new PythonClassIndex();
    const internals = asInternals(index);
    const clock = cancelableToken();
    parseState.impl = async (content, filePath, revision) => {
      if (filePath === paths['main.py']) {
        clock.cancel();
      }
      return deterministicParse(content, filePath, revision);
    };
    await internals.stageRequestFiles(paths['main.py'], clock.token);
    expect(internals.fileCache.has(paths['helper.py'])).toBe(false);
  });

  it('stageRequestFiles:import 批加载中取消 → 1089 早退,兄弟候选未补载', async () => {
    const paths = makeRoot({
      'main.py': 'from helper import Thing\n',
      'helper.py': 'class Thing:\n\tpass\n',
      'zzz.py': 'class Zzz:\n\tpass\n'
    });
    const index = new PythonClassIndex();
    const internals = asInternals(index);
    const clock = cancelableToken();
    parseState.impl = async (content, filePath, revision) => {
      if (filePath === paths['helper.py']) {
        clock.cancel();
      }
      return deterministicParse(content, filePath, revision);
    };
    await internals.stageRequestFiles(paths['main.py'], clock.token);
    expect(internals.fileCache.has(paths['zzz.py'])).toBe(false);
  });

  it('stageClassNameFiles:预取消 → 1103 空转,不做发现', async () => {
    const index = new PythonClassIndex();
    const internals = asInternals(index);
    const clock = cancelableToken();
    clock.cancel();
    let discoveryCalls = 0;
    stubWorkspace.findFiles = (async () => {
      discoveryCalls += 1;
      return [];
    }) as typeof stubWorkspace.findFiles;
    await internals.stageClassNameFiles(['Hero'], clock.token);
    expect(discoveryCalls).toBe(0);
  });

  it('stageClassNameFiles:发现中取消 → 1112 早退,不补载任何命中', async () => {
    const index = new PythonClassIndex();
    const internals = asInternals(index);
    const clock = cancelableToken();
    let ghostGlobSeen = false;
    stubWorkspace.findFiles = (async (pattern?: unknown) => {
      if (String(pattern ?? '').includes('Hero.py')) {
        ghostGlobSeen = true;
        clock.cancel();
      }
      return [];
    }) as typeof stubWorkspace.findFiles;
    await internals.stageClassNameFiles(['Hero'], clock.token);
    expect(ghostGlobSeen).toBe(true);
    expect(internals.stagedRequests.size).toBe(0);
  });

  it('stageClassNameFiles:首批发读即取消 → 1116 早退,第二批 9 号文件未读', async () => {
    const index = new PythonClassIndex();
    const internals = asInternals(index);
    const clock = cancelableToken();
    const targets = ['H1.py', 'H2.py', 'H3.py', 'V1.py', 'V2.py', 'V3.py', 'E1.py', 'E2.py', 'E3.py']
      .map(name => path.join('/ghost/scan', name));
    stubWorkspace.findFiles = (async (pattern?: unknown) => {
      const glob = String(pattern ?? '');
      if (glob.includes('Hero.py')) { return targets.slice(0, 3).map(file => Uri.file(file)); }
      if (glob.includes('Villain.py')) { return targets.slice(3, 6).map(file => Uri.file(file)); }
      if (glob.includes('Extra.py')) { return targets.slice(6, 9).map(file => Uri.file(file)); }
      return [];
    }) as typeof stubWorkspace.findFiles;
    const originalRead = fs.promises.readFile;
    let readCalls = 0;
    fs.promises.readFile = (async (...args: Parameters<typeof originalRead>) => {
      const file = String(args[0]);
      if (targets.includes(file)) {
        readCalls += 1;
        clock.cancel();
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      }
      return originalRead(...args);
    }) as typeof fs.promises.readFile;
    try {
      await internals.stageClassNameFiles(['Hero', 'Villain', 'Extra'], clock.token);
      expect(readCalls).toBe(8);
    } finally {
      fs.promises.readFile = originalRead;
    }
  });
});

describe('pythonClassIndex 缺口臂:文档变更/异步解析失败与查询取消面', () => {
  it('onDocumentChanged:非 py/def/xml 文件 → 1181 早退,不登记文档', async () => {
    const index = new PythonClassIndex();
    const internals = asInternals(index);
    await index.onDocumentChanged(makeTextDocument('x = 1\n', { fileName: '/tmp/foo.txt', languageId: 'plaintext' }));
    expect(internals.documents.size).toBe(0);
  });

  it('onDocumentChanged:解析失败 → 1204 记日志,文档仍登记待下次重试', async () => {
    const index = new PythonClassIndex();
    const internals = asInternals(index);
    const file = '/ghost/crash.py';
    setJumpLogEnabled(true);
    parseState.impl = async () => { throw new Error('worker crash'); };
    await index.onDocumentChanged(makeTextDocument('class Crash:\n\tpass\n', { fileName: file, languageId: 'python', version: 1 }));
    expect(internals.documents.has(file)).toBe(true);
    expect(internals.fileCache.has(file)).toBe(false);
  });

  it('asyncDocumentParse:解析失败 → 1258 记日志并登记待补,返回 null', async () => {
    const index = new PythonClassIndex();
    const internals = asInternals(index);
    const file = '/ghost/asyncCrash.py';
    setJumpLogEnabled(true);
    parseState.impl = async () => { throw new Error('worker down'); };
    const result = await index.asyncDocumentParse(
      makeTextDocument('class A:\n\tpass\n', { fileName: file, languageId: 'python', version: 1 })
    );
    expect(result).toBeNull();
    expect(internals.pendingScanRetries.get(file)).toBe(1);
  });

  it('resolveClassBase:类名补载发现中取消 → 1280 早退返回 null', async () => {
    const paths = makeRoot({ 'b.py': 'class Hero:\n\tpass\n' });
    const index = new PythonClassIndex();
    const clock = cancelableToken();
    let ghostGlobSeen = false;
    stubWorkspace.findFiles = (async (pattern?: unknown) => {
      if (String(pattern ?? '').includes('Ghost.py')) {
        ghostGlobSeen = true;
        clock.cancel();
      }
      return [];
    }) as typeof stubWorkspace.findFiles;
    const doc = makeTextDocument('class Hero:\n\tpass\n', { fileName: paths['b.py'], languageId: 'python' });
    const resolved = await index.resolveClassBase(doc, 'Ghost', undefined, clock.token);
    expect(resolved).toBeNull();
    expect(ghostGlobSeen).toBe(true);
  });

  it('resolveSelfMethodResolution:import 加载中取消 → 1361 早退,partial=true', async () => {
    const paths = makeRoot({
      'b.py': 'from helper import Thing\nclass Hero:\n\tdef run(self):\n\t\tself.ghost()\n',
      'helper.py': 'class Thing:\n\tpass\n'
    });
    const index = new PythonClassIndex();
    const clock = cancelableToken();
    parseState.impl = async (content, filePath, revision) => {
      if (filePath === paths['helper.py']) {
        clock.cancel();
      }
      return deterministicParse(content, filePath, revision);
    };
    const resolution = await index.resolveSelfMethodResolution(paths['b.py'], 2, 'ghost', undefined, clock.token, 1000);
    expect(resolution.partial).toBe(true);
    expect(resolution.candidates).toEqual([]);
  });

  it('resolveSelfMethodResolution:组合根超时且无静态目标 → 1411 记日志,partial=true', async () => {
    const paths = makeRoot({ 'b.py': 'class Hero:\n\tdef run(self):\n\t\tpass\n' });
    const index = new PythonClassIndex();
    setJumpLogEnabled(true);
    const never = new Promise<never>(() => undefined);
    stubWorkspace.findFiles = (async (pattern?: unknown) => {
      if (String(pattern ?? '').includes('*.py')) {
        return [Uri.file(paths['b.py'])];
      }
      return never;
    }) as typeof stubWorkspace.findFiles;
    const resolution = await index.resolveSelfMethodResolution(paths['b.py'], 1, 'ghost', undefined, undefined, 20);
    expect(resolution.partial).toBe(true);
    expect(resolution.candidates).toEqual([]);
    expect(getRecentJumpLogs().some(line => line.includes('无静态目标'))).toBe(true);
  });

  it('resolveSelfMethodResolution:全量扫描超预算 → 1452 早退,partial=true', async () => {
    const paths = makeRoot({ 'b.py': 'class Hero:\n\tdef run(self):\n\t\tpass\n' });
    const index = new PythonClassIndex();
    // 元数据 glob 空 → 组合根快速落地(空根);.py 发现故意慢 → 全量扫描超预算
    stubWorkspace.findFiles = (async (pattern?: unknown) => {
      if (String(pattern ?? '').includes('*.py')) {
        await new Promise(resolve => setTimeout(resolve, 150));
        return [Uri.file(paths['b.py'])];
      }
      return [];
    }) as typeof stubWorkspace.findFiles;
    const resolution = await index.resolveSelfMethodResolution(paths['b.py'], 1, 'ghost', undefined, undefined, 15);
    expect(resolution.partial).toBe(true);
    expect(resolution.candidates).toEqual([]);
  });

  it('resolveSelfMethodResolution:组合根与反向后代均落空 → 1422 守卫求值 + 1462 跳过不兼容角色同名类', async () => {
    const paths = makeRoot({
      'scripts/cell/entities.xml': '<?xml version="1.0"?><entities><Hero/></entities>',
      'scripts/cell/hero.py': 'class Hero:\n\tdef run(self):\n\t\tself.ghost()\n',
      'scripts/base/hero.py': 'class Hero:\n\tdef run(self):\n\t\tpass\n'
    });
    pointWorkspaceAt(path.dirname(paths['scripts/cell/hero.py']));
    const index = new PythonClassIndex();
    const internals = asInternals(index);
    // 两处同名类入索引:cell 角色(查询宿主,enclosing)与 base 角色(不兼容上下文)
    internals.updateFile(paths['scripts/cell/hero.py'], 'class Hero:\n\tdef run(self):\n\t\tself.ghost()\n', 1);
    internals.updateFile(paths['scripts/base/hero.py'], 'class Hero:\n\tdef run(self):\n\t\tpass\n', 1);
    // 元数据 glob 只出 cell 域的 entities.xml → 组合根 ['Hero'] 让 1422 守卫求值
    stubFindFiles(pattern => (pattern.replace(/\*\*\//, '') === 'entities.xml'
      ? [paths['scripts/cell/entities.xml']]
      : []));
    const resolution = await index.resolveSelfMethodResolution(
      paths['scripts/cell/hero.py'], 2, 'ghost', undefined, undefined, 200);
    // 全路径无取消/无超时 → partial=false;①静态/②组合根/③反向后代均无 ghost → 空集
    expect(resolution.partial).toBe(false);
    expect(resolution.candidates).toEqual([]);
  });
});
