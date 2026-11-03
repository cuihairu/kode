import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import * as vscode from 'vscode';
import {
  applyManagedDirExclusions,
  runInfer,
  syncInferredCopy,
  activateInferPipeline,
  type InferPipelineDeps
} from '../src/inferPipeline';
import {
  commandRegistry,
  configurationOverrides,
  lastFileSystemWatcher,
  messages,
  Uri,
  workspace as stubWorkspace,
  workspaceState
} from './helpers/vscodeStub';
import type { InferredDirEntry } from '../src/inferredCopy';

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

/** 内存文件系统:listDir 从文件键推导目录形态(与 listSourceFiles 同构) */
function makeMemoryFs(files: Map<string, string>) {
  const listDir = (absDir: string): readonly InferredDirEntry[] => {
    const prefix = absDir.endsWith('/') ? absDir : `${absDir}/`;
    const seen = new Map<string, boolean>();
    for (const key of files.keys()) {
      if (!key.startsWith(prefix)) {
        continue;
      }
      const rest = key.slice(prefix.length);
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
}

function makeDeps(input: MakeDepsInput): InferPipelineDeps {
  const mem = makeMemoryFs(input.files);
  const baseExists = (p: string): boolean =>
    p === '/opt/pyrefly' || input.files.has(p) || fs.existsSync(p);
  return {
    exists: input.exists ?? baseExists,
    ...mem,
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
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fs.readFileSync(path.join(root, '.kbengine', 'inferred', 'scripts', 'main.py'), 'utf-8')).toContain('import KBEngine');
    expect(messages.info).toHaveLength(0);
  });
});
