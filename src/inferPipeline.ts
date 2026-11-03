/**
 * KODE-CFG-017 装配层：pyrefly 推断管道的 vscode 接线。
 * 组合四个纯模块 + vscode 配置/工作区状态：
 * - 隔离面（managedDirExclusions）：search.exclude / files.watcherExclude /
 *   gitignore，VCS 感知、只管理自己那一段、.gitignore 绝不创建；
 * - 副本层（inferredCopy）：.kbengine/inferred/ 镜像 scripts 树，内容比对零写；
 * - 推断层（pyreflyInfer）：二进制发现 + 参数构造 + 写权限闸；
 * 消费面（kode 原生 provider 读副本富化）在后续批次接入。
 *
 * 写权限闸铁律：本模块全部落盘路径先过 assertWritable——默认 Managed 域
 * （.kbengine/**）才可写；用户 scripts/** 须显式开启 kbengine.infer.sourceWrite=user。
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { InferredDirEntry, listSourceFiles, mirrorPrefixFor, planInferredMirror } from './inferredCopy';
import { detectVcs, planExclusion, planGitignoreAdd } from './managedDirExclusions';
import { fileSystemScriptRootDeps, pythonScriptRootCandidates } from './pythonExtraPaths';
import {
  SOURCE_WRITE_SCOPE_MANAGED,
  SOURCE_WRITE_SCOPE_USER,
  SourceWriteScope,
  SpawnFn,
  assertWritable,
  buildInferArgs,
  discoverPyrefly
} from './pyreflyInfer';
import { kbeStubDir, readManagedDirSetting, resolveManagedDirName } from './pythonStubExport';

// ---------------------------------------------------------------------------
// 设置键（package.json contributes.configuration 同步）
// ---------------------------------------------------------------------------

export const INFER_ENABLED_KEY = 'infer.enabled';
export const INFER_ENABLED_DEFAULT = true;
export const INFER_PYREFLY_PATH_KEY = 'infer.pyreflyPath';
export const INFER_PYTHON_VERSION_KEY = 'infer.pythonVersion';
export const INFER_PYTHON_VERSION_DEFAULT = '3.7';
export const INFER_SOURCE_WRITE_KEY = 'infer.sourceWrite';
export const INFER_EXCLUSIONS_SYNC_KEY = 'infer.exclusionsSync';
export const INFER_EXCLUSIONS_SYNC_DEFAULT = true;

/** workspaceState 键：上次写入的 search.exclude 管理段（每工作区一键） */
function searchExcludeManagedKey(workspaceRoot: string): string {
  return `infer.searchExclude.managed:${workspaceRoot}`;
}

/** workspaceState 键：上次写入的 files.watcherExclude 管理段（每工作区一键） */
function watcherExcludeManagedKey(workspaceRoot: string): string {
  return `infer.watcherExclude.managed:${workspaceRoot}`;
}

export interface InferPipelineDeps {
  exists: (absPath: string) => boolean;
  readText: (absPath: string) => string | null;
  writeText: (absPath: string, content: string) => void;
  mkdir: (absPath: string) => void;
  deleteFile: (absPath: string) => void;
  listDir: (absPath: string) => readonly InferredDirEntry[];
  findGitRoot: (startDir: string) => string | null;
  findSvnRoot: (startDir: string) => string | null;
  spawn: SpawnFn;
}

function walkUpFor(startDir: string, name: string): string | null {
  let dir = path.resolve(startDir);
  for (;;) {
    if (fs.existsSync(path.join(dir, name))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

/** 装配层默认注入：真 fs + 真 spawn */
export const fileSystemInferDeps: InferPipelineDeps = {
  exists: (p) => fs.existsSync(p),
  readText: (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : null),
  writeText: (p, content) => {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, 'utf-8');
  },
  mkdir: (p) => fs.mkdirSync(p, { recursive: true }),
  deleteFile: (p) => {
    if (fs.existsSync(p)) {
      fs.unlinkSync(p);
    }
  },
  listDir: (p) => {
    try {
      return fs
        .readdirSync(p, { withFileTypes: true })
        .map((entry) => ({ name: entry.name, isDir: entry.isDirectory() }));
    } catch {
      return [];
    }
  },
  findGitRoot: (startDir) => walkUpFor(startDir, '.git'),
  findSvnRoot: (startDir) => walkUpFor(startDir, '.svn'),
  spawn: async (command, args, options) => {
    const { spawn } = await import('child_process');
    return await new Promise((resolve) => {
      const child = spawn(command, [...args], { cwd: options.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
      child.on('error', (err) => resolve({ code: -1, stdout, stderr: String(err) }));
    });
  }
};

function managedDirName(): string {
  return resolveManagedDirName(readManagedDirSetting()).name;
}

function sourceWriteScope(): SourceWriteScope {
  const value = vscode.workspace
    .getConfiguration('kbengine')
    .get<string>(INFER_SOURCE_WRITE_KEY, SOURCE_WRITE_SCOPE_MANAGED);
  return value === SOURCE_WRITE_SCOPE_USER ? SOURCE_WRITE_SCOPE_USER : SOURCE_WRITE_SCOPE_MANAGED;
}

function exclusionsSyncEnabled(): boolean {
  return vscode.workspace
    .getConfiguration('kbengine')
    .get<boolean>(INFER_EXCLUSIONS_SYNC_KEY, INFER_EXCLUSIONS_SYNC_DEFAULT);
}

// ---------------------------------------------------------------------------
// 隔离面执行器
// ---------------------------------------------------------------------------

export interface ExclusionsApplyResult {
  /** 已写 search.exclude 的工作区名 */
  searchWritten: string[];
  /** 已写 files.watcherExclude 的工作区名 */
  watcherWritten: string[];
  /** gitignore 追加过的仓根（相对或绝对） */
  gitignoreWritten: string[];
  /** gitignore 因文件不存在而跳过（绝不创建） */
  gitignoreSkippedMissing: string[];
}

/**
 * 同步 `.kbengine` 隔离：search.exclude + files.watcherExclude（只管理自己
 * 那一段）+ gitignore（git 仓 + 已存在才幂等追加，绝不创建）。激活期静默，
 * 命令面板手动跑保持播报。
 */
export async function applyManagedDirExclusions(
  context: vscode.ExtensionContext,
  deps: InferPipelineDeps = fileSystemInferDeps,
  options: { silent?: boolean } = {}
): Promise<ExclusionsApplyResult> {
  const result: ExclusionsApplyResult = {
    searchWritten: [],
    watcherWritten: [],
    gitignoreWritten: [],
    gitignoreSkippedMissing: []
  };
  if (!exclusionsSyncEnabled()) {
    return result;
  }
  const managedDir = managedDirName();
  const folders = vscode.workspace.workspaceFolders ?? [];
  for (const folder of folders) {
    const workspaceRoot = folder.uri.fsPath;
    const searchScoped = vscode.workspace.getConfiguration('search', folder);
    const searchManagedKey = searchExcludeManagedKey(workspaceRoot);
    const searchPrev = context.workspaceState?.get<string[]>(searchManagedKey) ?? [];
    const searchPlan = planExclusion(searchScoped.get<unknown>('exclude', {}), managedDir, searchPrev, true);
    if (searchPlan.changed) {
      await searchScoped.update('exclude', searchPlan.next, vscode.ConfigurationTarget.WorkspaceFolder);
      await context.workspaceState?.update(searchManagedKey, searchPlan.managedKeys);
      result.searchWritten.push(folder.name);
    }
    const watcherScoped = vscode.workspace.getConfiguration('files', folder);
    const watcherManagedKey = watcherExcludeManagedKey(workspaceRoot);
    const watcherPrev = context.workspaceState?.get<string[]>(watcherManagedKey) ?? [];
    const watcherPlan = planExclusion(watcherScoped.get<unknown>('watcherExclude', {}), managedDir, watcherPrev, true);
    if (watcherPlan.changed) {
      await watcherScoped.update('watcherExclude', watcherPlan.next, vscode.ConfigurationTarget.WorkspaceFolder);
      await context.workspaceState?.update(watcherManagedKey, watcherPlan.managedKeys);
      result.watcherWritten.push(folder.name);
    }
    const { kind, root } = detectVcs(deps, workspaceRoot);
    if (kind !== 'git' || !root) {
      // SVN / 无 VCS：不写任何 git 专属物（用户令：SVN 场景行为很不好）
      continue;
    }
    const gitignorePath = path.join(root, '.gitignore');
    const gitignoreContent = deps.readText(gitignorePath);
    if (gitignoreContent === null) {
      result.gitignoreSkippedMissing.push(root);
      continue;
    }
    const plan = planGitignoreAdd(gitignoreContent, managedDir);
    if (plan.action === 'append') {
      deps.writeText(gitignorePath, plan.nextContent);
      result.gitignoreWritten.push(root);
    }
  }
  if (!options.silent) {
    const parts: string[] = [];
    if (result.searchWritten.length > 0) {
      parts.push(`search.exclude: ${result.searchWritten.join('、')}`);
    }
    if (result.watcherWritten.length > 0) {
      parts.push(`watcherExclude: ${result.watcherWritten.join('、')}`);
    }
    if (result.gitignoreWritten.length > 0) {
      parts.push(`.gitignore 追加 ${managedDir}/: ${result.gitignoreWritten.join('、')}`);
    }
    if (parts.length > 0) {
      await vscode.window.showInformationMessage(`.kbengine 隔离已接线：${parts.join('；')}`);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// 副本层执行器
// ---------------------------------------------------------------------------

export interface CopySyncResult {
  copied: number;
  overwritten: number;
  deleted: number;
  unchanged: number;
  /** 被写权限闸拒绝的目标（scope 外）——不静默，如实播报 */
  denied: string[];
}

/** 镜像单个 scripts 根（写路径全部过写权限闸） */
function mirrorOneRoot(
  deps: InferPipelineDeps,
  workspaceRoot: string,
  managedDir: string,
  scriptsRoot: string,
  scope: SourceWriteScope
): CopySyncResult {
  const managedDirPosix = managedDir.replace(/^\/+|\/+$/g, '');
  const inferredRoot = path.join(
    workspaceRoot,
    managedDirPosix,
    'inferred',
    mirrorPrefixFor(workspaceRoot, scriptsRoot)
  );
  const sourceFiles = listSourceFiles(scriptsRoot, deps);
  const existingInferred = listSourceFiles(inferredRoot, deps);
  const plan = planInferredMirror(scriptsRoot, inferredRoot, sourceFiles, existingInferred, deps);
  const denied: string[] = [];
  const write = (rel: string): boolean => {
    const target = path.join(inferredRoot, rel);
    const decision = assertWritable(target, scope, workspaceRoot, managedDir, scriptsRoot);
    if (!decision.allowed) {
      denied.push(target);
      return false;
    }
    const source = path.join(scriptsRoot, rel);
    const content = deps.readText(source);
    if (content === null) {
      return false;
    }
    deps.writeText(target, content);
    return true;
  };
  let copied = 0;
  let overwritten = 0;
  for (const rel of plan.copy) {
    if (write(rel)) {
      copied += 1;
    }
  }
  for (const rel of plan.overwrite) {
    if (write(rel)) {
      overwritten += 1;
    }
  }
  let deleted = 0;
  for (const rel of plan.deleteStale) {
    const target = path.join(inferredRoot, rel);
    const decision = assertWritable(target, scope, workspaceRoot, managedDir, scriptsRoot);
    if (!decision.allowed) {
      denied.push(target);
      continue;
    }
    deps.deleteFile(target);
    deleted += 1;
  }
  return { copied, overwritten, deleted, unchanged: plan.unchanged.length, denied };
}

/** 同步全部 scripts 根镜像到 .kbengine/inferred/（内容比对零写） */
export async function syncInferredCopy(
  context: vscode.ExtensionContext,
  deps: InferPipelineDeps = fileSystemInferDeps,
  options: { silent?: boolean } = {}
): Promise<CopySyncResult> {
  const managedDir = managedDirName();
  const scope = sourceWriteScope();
  const folders = vscode.workspace.workspaceFolders ?? [];
  const aggregate: CopySyncResult = { copied: 0, overwritten: 0, deleted: 0, unchanged: 0, denied: [] };
  for (const folder of folders) {
    const workspaceRoot = folder.uri.fsPath;
    for (const scriptsRoot of pythonScriptRootCandidates(workspaceRoot, fileSystemScriptRootDeps)) {
      const partial = mirrorOneRoot(deps, workspaceRoot, managedDir, scriptsRoot, scope);
      aggregate.copied += partial.copied;
      aggregate.overwritten += partial.overwritten;
      aggregate.deleted += partial.deleted;
      aggregate.unchanged += partial.unchanged;
      aggregate.denied.push(...partial.denied);
    }
  }
  if (!options.silent) {
    const parts: string[] = [];
    if (aggregate.copied > 0 || aggregate.overwritten > 0) {
      parts.push(`副本同步 ${aggregate.copied + aggregate.overwritten} 文件（复制 ${aggregate.copied}、覆盖 ${aggregate.overwritten}）`);
    }
    if (aggregate.deleted > 0) {
      parts.push(`清除 ${aggregate.deleted} 残留`);
    }
    if (parts.length > 0) {
      await vscode.window.showInformationMessage(`.kbengine/inferred 副本已同步：${parts.join('；')}`);
    }
  }
  void context;
  return aggregate;
}

// ---------------------------------------------------------------------------
// 推断执行器
// ---------------------------------------------------------------------------

export interface InferRunResult {
  status: 'ran' | 'not-found' | 'disabled';
  /** 每个 scripts 根的退出码（status=ran） */
  exitCodes: number[];
  /** 二进制绝对路径（status=ran） */
  pyreflyPath?: string;
  /** not-found 时的提示 */
  message?: string;
}

/** 生成管道：镜像同步 → pyrefly infer（每个 scripts 根一趟，喂 def 真值 search-path） */
export async function runInfer(
  context: vscode.ExtensionContext,
  deps: InferPipelineDeps = fileSystemInferDeps,
  options: { silent?: boolean } = {}
): Promise<InferRunResult> {
  const enabled = vscode.workspace
    .getConfiguration('kbengine')
    .get<boolean>(INFER_ENABLED_KEY, INFER_ENABLED_DEFAULT);
  if (!enabled) {
    if (!options.silent) {
      await vscode.window.showInformationMessage('pyrefly 推断已关闭（kbengine.infer.enabled）');
    }
    return { status: 'disabled', exitCodes: [] };
  }
  await syncInferredCopy(context, deps, { silent: true });
  const pyreflyPath = discoverPyrefly(
    vscode.workspace.getConfiguration('kbengine').get<string>(INFER_PYREFLY_PATH_KEY),
    { exists: deps.exists, envPath: process.env.PATH, homeDir: process.env.HOME }
  );
  if (pyreflyPath === null) {
    if (!options.silent) {
      await vscode.window.showInformationMessage(
        '未找到 pyrefly 二进制：请 pipx install pyrefly 或设置 kbengine.infer.pyreflyPath'
      );
    }
    return { status: 'not-found', exitCodes: [], message: 'pyrefly binary not found' };
  }
  const managedDir = managedDirName();
  const pythonVersion = vscode.workspace
    .getConfiguration('kbengine')
    .get<string>(INFER_PYTHON_VERSION_KEY, INFER_PYTHON_VERSION_DEFAULT);
  const exitCodes: number[] = [];
  const folders = vscode.workspace.workspaceFolders ?? [];
  for (const folder of folders) {
    const workspaceRoot = folder.uri.fsPath;
    for (const scriptsRoot of pythonScriptRootCandidates(workspaceRoot, fileSystemScriptRootDeps)) {
      const mirrorRoot = path.join(workspaceRoot, managedDir, 'inferred', mirrorPrefixFor(workspaceRoot, scriptsRoot));
      const args = buildInferArgs(pythonVersion, [kbeStubDir(workspaceRoot, managedDir)], mirrorRoot);
      const outcome = await deps.spawn(pyreflyPath, args, { cwd: workspaceRoot });
      exitCodes.push(outcome.code);
    }
  }
  if (!options.silent) {
    const ok = exitCodes.every((code) => code === 0);
    await vscode.window.showInformationMessage(
      ok
        ? `pyrefly infer 完成（${exitCodes.length} 个脚本根）`
        : `pyrefly infer 有退出码非 0：${exitCodes.join('、')}（详见 OUTPUT 通道）`
    );
  }
  return { status: 'ran', exitCodes, pyreflyPath };
}

// ---------------------------------------------------------------------------
// 激活入口
// ---------------------------------------------------------------------------

/**
 * 激活接线：注册 `kbengine.infer.run` 命令 + 激活期静默同步（隔离面 + 副本）
 * + 脚本变更 watcher（用户源码改后同步覆盖副本；排除 managedDir 防自环）。
 */
export function activateInferPipeline(context: vscode.ExtensionContext): void {
  const runCommand = vscode.commands.registerCommand('kbengine.infer.run', async () => {
    const result = await runInfer(context);
    if (result.status === 'ran') {
      await syncInferredCopy(context, fileSystemInferDeps, { silent: true });
    }
  });
  context.subscriptions.push(runCommand);
  const syncExclusionsCommand = vscode.commands.registerCommand('kbengine.managedDir.syncExclusions', () =>
    applyManagedDirExclusions(context)
  );
  context.subscriptions.push(syncExclusionsCommand);
  const managedDir = managedDirName();
  const watcher = vscode.workspace.createFileSystemWatcher('**/*.py');
  const onChange = (uri: vscode.Uri): void => {
    const fsPath = uri.fsPath.replace(/\\/g, '/');
    if (fsPath.includes(`/${managedDir}/`)) {
      return;
    }
    void syncInferredCopy(context, fileSystemInferDeps, { silent: true });
  };
  watcher.onDidChange(onChange);
  watcher.onDidCreate(onChange);
  watcher.onDidDelete(onChange);
  context.subscriptions.push(watcher);
  void (async () => {
    await applyManagedDirExclusions(context, fileSystemInferDeps, { silent: true });
    await syncInferredCopy(context, fileSystemInferDeps, { silent: true });
  })();
}
