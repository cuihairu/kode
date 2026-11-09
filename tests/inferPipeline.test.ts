import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import * as vscode from 'vscode';
import {
  applyManagedDirExclusions,
  createCopySyncScheduler,
  fileSystemInferDeps,
  runInfer,
  syncInferredCopy,
  activateInferPipeline,
  type InferPipelineDeps
} from '../src/inferPipeline';
import {
  commandRegistry,
  commands,
  configurationOverrides,
  lastFileSystemWatcher,
  messages,
  Uri,
  workspace as stubWorkspace,
  workspaceState
} from './helpers/vscodeStub';
import type { InferredDirEntry } from '../src/backend/inferredCopy';

// KODE-CFG-017 装配层执行器测试:三个执行器(隔离面/副本/推断)在假 vscode
// 注入 deps 下走全链。scripts 根发现用真 fs(临时工作区),读/写/列举/探测
// 全注入内存 map,不碰用户真码。
// 纪律:测试只经工作区根下 .kbengine 写,任何写用户源的路径必须被写闸挡下。

const memento = new Map<string, unknown>();

const makeContext = (): vscode.ExtensionContext =>
  ({
    subscriptions: [],
    workspaceState: {
      get: <T>(key: string): T | undefined => memento.get(key) as T | undefined,
      update: async (key: string, value: unknown): Promise<void> => {
        memento.set(key, value);
      }
    }
  }) as unknown as vscode.ExtensionContext;

/** 内存文件系统:listDir 从文件键推导目录形态(与 listSourceFiles 同构)。
 * WIN-3:键由平台 path.join 生成(win32 为 \),src 的 walk 用 `/` 拼子路径
 * ——两侧统一归一为 / 再比,否则 win32 下前缀永失配、枚举恒空、镜像零写。 */
function makeMemoryFs(files: Map<string, string>) {
  const norm = (p: string): string => p.replace(/\\/g, '/');
  const listDir = (absDir: string): readonly InferredDirEntry[] => {
    const base = norm(absDir);
    const prefix = base.endsWith('/') ? base : `${base}/`;
    const seen = new Map<string, boolean>();
    for (const key of files.keys()) {
      const nk = norm(key);
      if (!nk.startsWith(prefix)) {
        continue;
      }
      const rest = nk.slice(prefix.length);
      const slash = rest.indexOf('/');
      const name = slash === -1 ? rest : rest.slice(0, slash);
      seen.set(name, slash !== -1);
    }
    return [...seen].map(([name, isDir]) => ({ name, isDir }));
  };
  return {
    listDir,
    readText: (p: string): string | null => files.get(p) ?? null,
    writeText: (p: string, content: string): void => {
      files.set(p, content);
    },
    deleteFile: (p: string): void => {
      files.delete(p);
    }
  };
}

interface MakeDepsInput {
  files: Map<string, string>;
  findGitRoot?: (startDir: string) => string | null;
  findSvnRoot?: (startDir: string) => string | null;
  spawn?: InferPipelineDeps['spawn'];
  /** 覆盖存在性判定(仅 discoverPyrefly 用到;scripts 根发现走真 fs) */
  exists?: (p: string) => boolean;
  /** 覆盖目录列举(默认从 files 推导;注入抛错可测「读失败≠空目录」) */
  listDir?: (absDir: string) => readonly InferredDirEntry[];
}

function makeDeps(input: MakeDepsInput): InferPipelineDeps {
  const mem = makeMemoryFs(input.files);
  const baseExists = (p: string): boolean =>
    p === '/opt/pyrefly' || input.files.has(p) || fs.existsSync(p);
  return {
    exists: input.exists ?? baseExists,
    ...mem,
    listDir: input.listDir ?? mem.listDir,
    mkdir: (): void => undefined,
    findGitRoot: input.findGitRoot ?? ((): string | null => null),
    findSvnRoot: input.findSvnRoot ?? ((): string | null => null),
    spawn:
      input.spawn ??
      (async () => ({ code: 0, stdout: '', stderr: '' }))
  };
}

// ---- 临时工作区:真 scripts 根供 candidates 发现,内容走内存 ----

let tmpRoots: string[] = [];

function makeTmpWorkspace(): { root: string; scriptsRoot: string; files: Map<string, string> } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-infer-'));
  tmpRoots.push(root);
  const scriptsRoot = path.join(root, 'scripts');
  fs.mkdirSync(path.join(scriptsRoot, 'base'), { recursive: true });
  // 真盘写一份(watcher 联动测试走 fileSystemInferDeps 真依赖),内存再留一份
  // (注入 deps 的测试以内存 map 为准,不读真盘内容)。
  fs.writeFileSync(path.join(scriptsRoot, 'base', 'Avatar.py'), 'class Avatar:\n    pass\n');
  fs.writeFileSync(path.join(scriptsRoot, 'main.py'), 'import KBEngine\n');
  const files = new Map<string, string>();
  files.set(path.join(scriptsRoot, 'base', 'Avatar.py'), 'class Avatar:\n    pass\n');
  files.set(path.join(scriptsRoot, 'main.py'), 'import KBEngine\n');
  return { root, scriptsRoot, files };
}

afterEach(() => {
  messages.info.length = 0;
  messages.warning.length = 0;
  messages.error.length = 0;
  workspaceState.reset();
  memento.clear();
  stubWorkspace.workspaceFolders = [];
  for (const root of tmpRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  tmpRoots = [];
});

beforeEach(() => {
  stubWorkspace.workspaceFolders = [];
});

describe('applyManagedDirExclusions(隔离面执行器)', () => {
  it('开关关闭时返回空,不写任何配置', async () => {
    configurationOverrides.set('kbengine', { 'infer.exclusionsSync': false });
    const { root } = makeTmpWorkspace();
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
    const deps = makeDeps({ files: new Map(), findGitRoot: () => root });
    const result = await applyManagedDirExclusions(makeContext(), deps, { silent: true });
    expect(result).toEqual({
      searchWritten: [],
      watcherWritten: [],
      gitignoreWritten: [],
      gitignoreSkippedMissing: []
    });
    expect(workspaceState.workspaceConfigurationUpdates).toHaveLength(0);
  });

  it('git 仓且 .gitignore 存在:写 search/watcher + 幂等追加 gitignore', async () => {
    const { root } = makeTmpWorkspace();
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
    const files = new Map<string, string>([[path.join(root, '.gitignore'), 'node_modules/\n']]);
    const deps = makeDeps({ files, findGitRoot: () => root });
    const result = await applyManagedDirExclusions(makeContext(), deps, { silent: true });
    expect(result.searchWritten).toEqual(['ws']);
    expect(result.watcherWritten).toEqual(['ws']);
    expect(result.gitignoreWritten).toEqual([root]);
    expect(result.gitignoreSkippedMissing).toEqual([]);
    const search = workspaceState.workspaceConfigurationUpdates.find((u) => u.key === 'search.exclude');
    expect(search?.value).toEqual({ '.kbengine/**': true });
    const watcher = workspaceState.workspaceConfigurationUpdates.find((u) => u.key === 'files.watcherExclude');
    expect(watcher?.value).toEqual({ '.kbengine/**': true });
    expect(files.get(path.join(root, '.gitignore'))).toContain('# kode managed dir (auto-generated)');
    expect(files.get(path.join(root, '.gitignore'))).toContain('.kbengine/');
  });

  it('git 仓缺 .gitignore:绝不创建,只记为跳过', async () => {
    const { root } = makeTmpWorkspace();
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
    const files = new Map<string, string>();
    const deps = makeDeps({ files, findGitRoot: () => root });
    const result = await applyManagedDirExclusions(makeContext(), deps, { silent: true });
    expect(result.gitignoreWritten).toEqual([]);
    expect(result.gitignoreSkippedMissing).toEqual([root]);
    expect(files.size).toBe(0);
  });

  it('svn 仓:不写任何 git 专属物,但 search/watcher 照常', async () => {
    const { root } = makeTmpWorkspace();
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
    const files = new Map<string, string>([[path.join(root, '.gitignore'), 'node_modules/\n']]);
    const deps = makeDeps({ files, findSvnRoot: () => root });
    const result = await applyManagedDirExclusions(makeContext(), deps, { silent: true });
    expect(result.searchWritten).toEqual(['ws']);
    expect(result.gitignoreWritten).toEqual([]);
    expect(files.get(path.join(root, '.gitignore'))).toBe('node_modules/\n');
  });

  it('用户手填 search.exclude 条目不动,只并 kode 段(只管理自己那一段)', async () => {
    const { root } = makeTmpWorkspace();
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
    configurationOverrides.set('search', { exclude: { '**/dist/**': true } });
    const deps = makeDeps({ files: new Map(), findGitRoot: () => root });
    await applyManagedDirExclusions(makeContext(), deps, { silent: true });
    const search = workspaceState.workspaceConfigurationUpdates.find((u) => u.key === 'search.exclude');
    expect(search?.value).toEqual({ '**/dist/**': true, '.kbengine/**': true });
  });

  it('幂等:二次运行无变化则不写', async () => {
    const { root } = makeTmpWorkspace();
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
    const files = new Map<string, string>([[path.join(root, '.gitignore'), 'node_modules/\n']]);
    const deps = makeDeps({ files, findGitRoot: () => root });
    const context = makeContext();
    await applyManagedDirExclusions(context, deps, { silent: true });
    // 模拟真环境里 update 已生效(fake 的 update 只记账不回落 get),再跑一次
    configurationOverrides.set('search', { exclude: { '.kbengine/**': true } });
    configurationOverrides.set('files', { watcherExclude: { '.kbengine/**': true } });
    workspaceState.workspaceConfigurationUpdates.length = 0;
    await applyManagedDirExclusions(context, deps, { silent: true });
    expect(workspaceState.workspaceConfigurationUpdates).toHaveLength(0);
    expect(files.get(path.join(root, '.gitignore'))).toBe('node_modules/\n# kode managed dir (auto-generated)\n.kbengine/\n');
  });

  it('非静默时播报写成的面', async () => {
    const { root } = makeTmpWorkspace();
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
    const files = new Map<string, string>([[path.join(root, '.gitignore'), 'node_modules/\n']]);
    const deps = makeDeps({ files, findGitRoot: () => root });
    await applyManagedDirExclusions(makeContext(), deps);
    expect(messages.info[0]).toContain('.kbengine 隔离已接线');
    expect(messages.info[0]).toContain('search.exclude');
  });
});

describe('syncInferredCopy(副本层执行器)', () => {
  it('镜像 scripts 树到 .kbengine/inferred/scripts,目录结构保留', async () => {
    const { root, files } = makeTmpWorkspace();
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
    const deps = makeDeps({ files });
    const result = await syncInferredCopy(makeContext(), deps, { silent: true });
    expect(result.copied).toBe(2);
    expect(result.overwritten).toBe(0);
    expect(files.get(path.join(root, '.kbengine', 'inferred', 'scripts', 'base', 'Avatar.py'))).toContain('class Avatar');
    expect(files.get(path.join(root, '.kbengine', 'inferred', 'scripts', 'main.py'))).toContain('import KBEngine');
  });

  it('幂等:内容一致则零写(unchanged=2)', async () => {
    const { root, files } = makeTmpWorkspace();
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
    const deps = makeDeps({ files });
    await syncInferredCopy(makeContext(), deps, { silent: true });
    const result = await syncInferredCopy(makeContext(), deps, { silent: true });
    expect(result.copied).toBe(0);
    expect(result.overwritten).toBe(0);
    expect(result.unchanged).toBe(2);
  });

  it('源改动后覆盖镜像;源删除后清残留', async () => {
    const { root, scriptsRoot, files } = makeTmpWorkspace();
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
    const deps = makeDeps({ files });
    await syncInferredCopy(makeContext(), deps, { silent: true });
    files.set(path.join(scriptsRoot, 'base', 'Avatar.py'), 'class Avatar:\n    def run(self) -> int:\n        return 1\n');
    files.delete(path.join(scriptsRoot, 'main.py'));
    const result = await syncInferredCopy(makeContext(), deps, { silent: true });
    expect(result.overwritten).toBe(1);
    expect(result.deleted).toBe(1);
    expect(files.get(path.join(root, '.kbengine', 'inferred', 'scripts', 'main.py'))).toBeUndefined();
    expect(files.get(path.join(root, '.kbengine', 'inferred', 'scripts', 'base', 'Avatar.py'))).toContain('-> int');
  });

  it('源目录读取失败:不把读失败当空目录,绝不删既有镜像副本', async () => {
    const { root, scriptsRoot, files } = makeTmpWorkspace();
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
    // 首次正常同步:镜像落 main.py + base/Avatar.py
    await syncInferredCopy(makeContext(), makeDeps({ files }), { silent: true });
    const mirrorMain = path.join(root, '.kbengine', 'inferred', 'scripts', 'main.py');
    expect(files.get(mirrorMain)).toBeDefined();
    // 源 main.py 被删(完整列举下本应 stale 清理),但源根列举抛错(读失败)
    files.delete(path.join(scriptsRoot, 'main.py'));
    const mem = makeMemoryFs(files);
    const failing = makeDeps({
      files,
      listDir: (p: string) => {
        // WIN-3:发现层(pythonScriptRootCandidates)按配置口径统一 / 形态,
        // 夹具 scriptsRoot 是平台 path.join——按归一形态比较。
        const norm = (s: string): string => s.replace(/\\/g, '/');
        if (norm(p) === norm(scriptsRoot)) {
          throw new Error('EACCES');
        }
        return mem.listDir(p);
      }
    });
    const result = await syncInferredCopy(makeContext(), failing, { silent: true });
    expect(result.deleted).toBe(0);
    // 镜像残留仍在——「读失败≠空目录」核心断言:未把副本当过期删除
    expect(files.get(mirrorMain)).toBeDefined();
  });

  it('写闸纪律:镜像阶段绝不动用户源码树', async () => {
    const { root, files } = makeTmpWorkspace();
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
    const deps = makeDeps({ files });
    const before = new Map(files);
    await syncInferredCopy(makeContext(), deps, { silent: true });
    for (const [p, content] of files) {
      if (p.includes('/scripts/') && !p.includes('.kbengine')) {
        expect(content).toBe(before.get(p));
      }
    }
  });

  it('非静默时播报副本同步', async () => {
    const { root, files } = makeTmpWorkspace();
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
    const deps = makeDeps({ files });
    await syncInferredCopy(makeContext(), deps);
    expect(messages.info[0]).toContain('.kbengine/inferred 副本已同步');
  });
});

describe('runInfer(推断执行器)', () => {
  it('开关关闭:status=disabled,不 spawn', async () => {
    configurationOverrides.set('kbengine', { 'infer.enabled': false });
    const { root, files } = makeTmpWorkspace();
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
    const spawned: Array<{ cmd: string; args: string[] }> = [];
    const deps = makeDeps({
      files,
      spawn: async (cmd, args) => {
        spawned.push({ cmd, args: [...args] });
        return { code: 0, stdout: '', stderr: '' };
      }
    });
    const result = await runInfer(makeContext(), deps, { silent: true });
    expect(result.status).toBe('disabled');
    expect(spawned).toHaveLength(0);
  });

  it('pyrefly 未找到:status=not-found', async () => {
    const { root, files } = makeTmpWorkspace();
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
    const deps = makeDeps({ files, exists: () => false });
    const result = await runInfer(makeContext(), deps, { silent: true });
    expect(result.status).toBe('not-found');
    expect(result.message).toBeDefined();
  });

  it('运行:先镜像副本再 spawn,喂 def 真值 search-path', async () => {
    const { root, files } = makeTmpWorkspace();
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
    configurationOverrides.set('kbengine', { 'infer.pyreflyPath': '/opt/pyrefly' });
    const spawned: Array<{ cmd: string; args: string[] }> = [];
    const deps = makeDeps({
      files,
      spawn: async (cmd, args) => {
        spawned.push({ cmd, args: [...args] });
        return { code: 0, stdout: '', stderr: '' };
      }
    });
    const result = await runInfer(makeContext(), deps, { silent: true });
    expect(result.status).toBe('ran');
    expect(result.pyreflyPath).toBe('/opt/pyrefly');
    expect(result.exitCodes).toEqual([0]);
    expect(spawned).toHaveLength(1);
    expect(spawned[0].cmd).toBe('/opt/pyrefly');
    expect(spawned[0].args[0]).toBe('infer');
    expect(spawned[0].args).toContain('--python-version');
    expect(spawned[0].args).toContain(path.join(root, '.kbengine', 'stubs'));
    expect(spawned[0].args[spawned[0].args.length - 1]).toBe(path.join(root, '.kbengine', 'inferred', 'scripts'));
    // 镜像副本先于推断产生
    expect(files.get(path.join(root, '.kbengine', 'inferred', 'scripts', 'main.py'))).toContain('import KBEngine');
  });

  it('非零退出码如实入账', async () => {
    const { root, files } = makeTmpWorkspace();
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
    configurationOverrides.set('kbengine', { 'infer.pyreflyPath': '/opt/pyrefly' });
    const deps = makeDeps({
      files,
      spawn: async () => ({ code: 1, stdout: '', stderr: 'boom' })
    });
    const result = await runInfer(makeContext(), deps, { silent: true });
    expect(result.status).toBe('ran');
    expect(result.exitCodes).toEqual([1]);
  });
});

describe('activateInferPipeline(激活接线)', () => {
  it('注册两条命令 + **/*.py watcher(无工作区时初始化为 no-op)', () => {
    stubWorkspace.workspaceFolders = [];
    const context = makeContext();
    activateInferPipeline(context);
    expect(commandRegistry.registeredCommandIds()).toContain('kbengine.infer.run');
    expect(commandRegistry.registeredCommandIds()).toContain('kbengine.managedDir.syncExclusions');
    expect(lastFileSystemWatcher.current?.pattern).toBe('**/*.py');
    expect(context.subscriptions.length).toBeGreaterThanOrEqual(3);
  });

  it('watcher 自环过滤:managedDir 内变更不触发副本同步', async () => {
    // 激活时无工作区,先排空初始化异步(empty folders → no-op,镜像不存在)
    stubWorkspace.workspaceFolders = [];
    const context = makeContext();
    activateInferPipeline(context);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const watcher = lastFileSystemWatcher.current!;
    const { root } = makeTmpWorkspace();
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
    // 仅 fire .kbengine 内变更:若自环未过滤,会触发副本同步并建镜像
    watcher.fireChange(Uri.file(path.join(root, '.kbengine', 'inferred', 'scripts', 'main.py')));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fs.existsSync(path.join(root, '.kbengine', 'inferred', 'scripts', 'main.py'))).toBe(false);
  });

  it('watcher 联动:真脚本根变更触发副本同步(自环外路径)', async () => {
    stubWorkspace.workspaceFolders = [];
    const context = makeContext();
    activateInferPipeline(context);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const watcher = lastFileSystemWatcher.current!;
    const { root } = makeTmpWorkspace();
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
    watcher.fireChange(Uri.file(path.join(root, 'scripts', 'main.py')));
    // KR-AUD-56:watcher 同步走 200ms 防抖,等防抖窗过 + 同步落盘
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(fs.readFileSync(path.join(root, '.kbengine', 'inferred', 'scripts', 'main.py'), 'utf-8')).toContain('import KBEngine');
    expect(messages.info).toHaveLength(0);
  });
});

/* ---------------- KR-AUD-56: watcher 防抖 + 在途互斥 ---------------- */

describe('KR-AUD-56: 副本同步调度器(防抖 + 在途互斥,dirty 补一轮)', () => {
  it('连发多次 schedule 折叠为一轮(防抖窗内不执行)', async () => {
    const { createCopySyncScheduler } = await import('../src/inferPipeline');
    let runs = 0;
    const scheduler = createCopySyncScheduler(async () => { runs += 1; }, 60);
    try {
      scheduler.schedule();
      scheduler.schedule();
      scheduler.schedule();
      await new Promise(resolve => setTimeout(resolve, 25));
      expect(runs, '防抖窗内不得执行').toBe(0);
      await new Promise(resolve => setTimeout(resolve, 80));
      expect(runs, '防抖窗过后恰好执行一轮').toBe(1);
    } finally {
      scheduler.dispose();
    }
  });

  it('在途时 schedule 不并发:运行结束后 dirty 补恰一轮', async () => {
    const { createCopySyncScheduler } = await import('../src/inferPipeline');
    let runs = 0;
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    const scheduler = createCopySyncScheduler(async () => {
      runs += 1;
      if (runs === 1) {
        await firstGate;
      }
    }, 10);
    try {
      scheduler.schedule();
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(runs).toBe(1);
      // 在途期间连发多次:不并发开第二轮,只置 dirty
      scheduler.schedule();
      scheduler.schedule();
      await new Promise(resolve => setTimeout(resolve, 40));
      expect(runs, '在途期间不得并发第二轮').toBe(1);
      releaseFirst();
      await new Promise(resolve => setTimeout(resolve, 60));
      expect(runs, '结束后 dirty 补恰一轮(多次置位折叠)').toBe(2);
    } finally {
      scheduler.dispose();
    }
  });

  it('run 抛错被吞不产生未处理拒绝;dispose 清挂起防抖不再执行', async () => {
    let runs = 0;
    const boom = createCopySyncScheduler(async () => {
      runs += 1;
      throw new Error('boom');
    }, 20);
    boom.schedule();
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(runs).toBe(1);
    boom.dispose();
    // dispose 清掉 10s 挂起防抖:此后不再执行
    const pending = createCopySyncScheduler(async () => { runs += 10; }, 10_000);
    pending.schedule();
    pending.dispose();
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(runs).toBe(1);
  });
});

describe('fileSystemInferDeps 真依赖装配层(覆盖补测)', () => {
  it('fs 面:exists/mkdir/deleteFile(缺文件不抛)/listDir(缺目录空表)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-infer-deps-'));
    try {
      const file = path.join(dir, 'a.txt');
      expect(fileSystemInferDeps.exists(file)).toBe(false);
      fileSystemInferDeps.mkdir(path.join(dir, 'nested', 'deep'));
      expect(fs.existsSync(path.join(dir, 'nested', 'deep'))).toBe(true);
      fileSystemInferDeps.writeText(file, 'hello');
      expect(fileSystemInferDeps.exists(file)).toBe(true);
      // 缺文件删除不抛;存在文件删除生效
      fileSystemInferDeps.deleteFile(path.join(dir, 'missing.txt'));
      fileSystemInferDeps.deleteFile(file);
      expect(fs.existsSync(file)).toBe(false);
      fs.writeFileSync(path.join(dir, 'sub.py'), 'x = 1');
      const entries = fileSystemInferDeps.listDir(dir);
      expect(entries.some(entry => entry.name === 'sub.py' && !entry.isDir)).toBe(true);
      expect(fileSystemInferDeps.listDir(path.join(dir, 'no-such'))).toEqual([]);
      // 根上溯:命中与未命中(走到底返回 null)
      fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
      fs.mkdirSync(path.join(dir, 'inner'), { recursive: true });
      expect(fileSystemInferDeps.findGitRoot(path.join(dir, 'inner'))).toBe(dir);
      expect(fileSystemInferDeps.findSvnRoot(dir)).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('spawn 面:真进程 stdout/stderr 收集 + 命令不存在 error 臂', async () => {
    const ok = await fileSystemInferDeps.spawn('echo', ['hi'], { cwd: os.tmpdir() });
    expect(ok.code).toBe(0);
    expect(ok.stdout.trim()).toBe('hi');
    const loud = await fileSystemInferDeps.spawn('sh', ['-c', 'echo err >&2'], { cwd: os.tmpdir() });
    expect(loud.code).toBe(0);
    expect(loud.stderr.trim()).toBe('err');
    const bad = await fileSystemInferDeps.spawn('kode-no-such-binary-xyz', [], { cwd: os.tmpdir() });
    expect(bad.code).toBe(-1);
  });
});

describe('runInfer 非静默播报面(覆盖补测)', () => {
  it('开关关闭非静默:提示已关闭即止', async () => {
    configurationOverrides.set('kbengine', { 'infer.enabled': false });
    const { root, files } = makeTmpWorkspace();
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
    const result = await runInfer(makeContext(), makeDeps({ files }));
    expect(result.status).toBe('disabled');
    expect(messages.info.some(text => text.includes('pyrefly 推断已关闭'))).toBe(true);
  });

  it('未找到 pyrefly 非静默:提示安装途径', async () => {
    const { root, files } = makeTmpWorkspace();
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
    const result = await runInfer(makeContext(), makeDeps({ files, exists: () => false }));
    expect(result.status).toBe('not-found');
    expect(messages.info.some(text => text.includes('未找到 pyrefly'))).toBe(true);
  });

  it('ran 非静默:全零退出码报完成;非零报明细', async () => {
    const { root, files } = makeTmpWorkspace();
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
    configurationOverrides.set('kbengine', { 'infer.pyreflyPath': '/opt/pyrefly' });
    await runInfer(makeContext(), makeDeps({ files }));
    expect(messages.info.some(text => text.includes('pyrefly infer 完成'))).toBe(true);
    messages.info.length = 0;
    await runInfer(makeContext(), makeDeps({
      files,
      spawn: async () => ({ code: 2, stdout: '', stderr: '' })
    }));
    expect(messages.info.some(text => text.includes('退出码非 0') && text.includes('2'))).toBe(true);
  });

  it('同步非静默:复制与清除残留如实播报', async () => {
    const { root, files } = makeTmpWorkspace();
    files.set(path.join(root, '.kbengine', 'inferred', 'scripts', 'stale.py'), 'old');
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
    const result = await syncInferredCopy(makeContext(), makeDeps({ files }));
    expect(result.deleted).toBe(1);
    expect(result.copied + result.overwritten).toBe(2);
    const joined = messages.info.join('\n');
    expect(joined).toContain('副本已同步');
    expect(joined).toContain('清除 1 残留');
  });

  it('计划后源消失:该文件不计覆盖不抛(写读 null 如实跳过)', async () => {
    const { root, files } = makeTmpWorkspace();
    // 镜像预置异内容副本 → 计划期读源比对一次(overwrite),写期再读第二次
    // 拿到 null(源在计划后被删)→ 该文件不计覆盖、不抛、其余照常复制
    files.set(path.join(root, '.kbengine', 'inferred', 'scripts', 'main.py'), 'modified');
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
    const deps = makeDeps({ files });
    const reads = new Map<string, number>();
    const inner = deps.readText;
    deps.readText = (p: string): string | null => {
      const count = (reads.get(p) ?? 0) + 1;
      reads.set(p, count);
      return count >= 2 ? null : inner(p);
    };
    const result = await syncInferredCopy(makeContext(), deps, { silent: true });
    expect(result.overwritten).toBe(0);
    expect(result.copied).toBe(1);
    expect(result.denied).toHaveLength(0);
  });
});

describe('infer 激活命令处理器(覆盖补测)', () => {
  it('kbengine.infer.run:关闭时提示即止,零动作', async () => {
    stubWorkspace.workspaceFolders = [];
    const context = makeContext();
    activateInferPipeline(context);
    configurationOverrides.set('kbengine', { 'infer.enabled': false });
    await commands.executeCommand('kbengine.infer.run');
    expect(messages.info.some(text => text.includes('pyrefly 推断已关闭'))).toBe(true);
  });

  it('kbengine.infer.run:ran 后同步副本;真 spawn 对不可执行二进制如实降级', async () => {
    const { root, files } = makeTmpWorkspace();
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
    const bin = path.join(root, 'fake-pyrefly');
    fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n');
    configurationOverrides.set('kbengine', { 'infer.pyreflyPath': bin });
    const context = makeContext();
    activateInferPipeline(context);
    await commands.executeCommand('kbengine.infer.run');
    // 默认 fileSystemInferDeps 真 spawn:普通文件不可执行 → error 臂 code=-1,
    // 退出码明细如实播报;随后 ran 分支补一轮静默副本同步(镜像落真盘)
    expect(messages.info.some(text => text.includes('退出码非 0'))).toBe(true);
    expect(fs.existsSync(path.join(root, '.kbengine', 'inferred', 'scripts', 'main.py'))).toBe(true);
    expect(files.size).toBeGreaterThanOrEqual(0);
  });

  it('kbengine.managedDir.syncExclusions:空工作区空转不抛', async () => {
    stubWorkspace.workspaceFolders = [];
    const context = makeContext();
    activateInferPipeline(context);
    await commands.executeCommand('kbengine.managedDir.syncExclusions');
    expect(messages.error).toHaveLength(0);
  });
});
