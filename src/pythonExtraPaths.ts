/**
 * Python 生态 extraPaths 接线(功能差距盘点 G1,docs/reference-feature-gap.md,
 * 参照 KBEngine Nex X 的做法但实现自研):
 * VS Code 的 Python 扩展(Pylance)靠 `python.analysis.extraPaths` 解析
 * `import KBEngine` / `import common.*`,本仓已能按同口径发现 scripts 根
 * (与 entityMapping.getPythonScriptRoots 的三条前缀一致,外加批129 约定的
 * 一级 `*_assets` 目录),只差把存在的根写进工作区配置。
 * 盘点 G2 的存根目录(`.kbengine/stubs`,pythonStubExport 导出)也在管理段:
 * 设置开且 KBEngine.pyi 在盘才并入,排序在发现根之后。
 *
 * 写入走带资源域的 `getConfiguration('python', folder).update(...)`(本仓
 * @types/vscode 尚无 updateWorkspaceConfiguration);只管理自己那一段——
 * 上次写入的集合记在 workspaceState,再同步先剔除它,用户手填的路径永不被动。
 */

import * as fs from 'fs';
import * as vscode from 'vscode';
import {
  PYTHON_STUB_EXPORT_ENABLED_DEFAULT,
  kbeStubDir,
  kbeStubFilePath,
  readManagedDirSetting,
  resolveManagedDirName
} from './pythonStubExport';
import { typeStubArtifactExists } from './pythonTypeStubs';

export const PYTHON_EXTRA_PATHS_SETTING = 'python.analysis.extraPaths';
export const PYTHON_EXTRA_PATHS_MANAGED_KEY = 'kbengine.python.extraPaths.managed';
/** 同步开关(kbengine.python.extraPathsSync,默认开) */
export const PYTHON_EXTRA_PATHS_SYNC_ENABLED_DEFAULT = true;

export interface PythonScriptRootDeps {
  /** 路径存在性判定(测试注入,装配层为 fs.existsSync) */
  exists: (path: string) => boolean;
  /** 列目录一级子目录名(测试注入,装配层为 fs.readdirSync 包装) */
  listSubdirs: (dir: string) => string[];
}

export interface PythonExtraPathsPlanInput {
  workspaceRoot: string;
  currentPaths: readonly string[];
  previouslyManaged: readonly string[];
  deps: PythonScriptRootDeps;
  /** 磁盘存在性由调用方先判定的额外管理段(G2 存根目录),排在发现根之后 */
  extraManaged?: readonly string[];
}

export interface PythonExtraPathsPlan {
  /** 该写回的完整数组(用户段在前) */
  nextPaths: string[];
  /** 本次由本扩展管理的段(供下次差量) */
  managedPaths: string[];
  /** 与现值(规范化口径)不同才需要写 */
  changed: boolean;
}

/** extraPaths 条目规范化:空串丢弃标记;只剥尾部分隔符,盘符根剥到 `C:` */
export function normalizeExtraPath(value: string): string {
  if (value === '') {
    return '';
  }
  // 连续尾分隔符一次剥净;`C:\` 剥成 `C:`(Pylance 两种写法等价)
  return value.replace(/[\\/]+$/, '');
}

function joinPath(...segments: string[]): string {
  return segments.join('/').replace(/\\/g, '/');
}

function uniquePaths(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const candidate of paths) {
    if (candidate === '' || seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    unique.push(candidate);
  }
  return unique;
}

/**
 * 该工作区的 scripts 根候选:三条工作区前缀(与 entityMapping.
 * getPythonScriptRoots 同口径)+ 一级 `*_assets` 目录(批129 资产根约定,
 * `<repo>/<xxx>_assets/scripts` 布局)。只收磁盘上真实存在的,写不存在的
 * 路径只会让 Pylance 报「目录不存在」。
 */
export function pythonScriptRootCandidates(
  workspaceRoot: string,
  deps: PythonScriptRootDeps
): string[] {
  const prefixes = [
    joinPath(workspaceRoot, 'scripts'),
    joinPath(workspaceRoot, 'assets', 'scripts'),
    joinPath(workspaceRoot, 'server_assets', 'scripts')
  ];
  const assetsRoots = deps
    .listSubdirs(workspaceRoot)
    .filter(name => name.endsWith('_assets'))
    .map(name => joinPath(workspaceRoot, name, 'scripts'));
  return uniquePaths([...prefixes, ...assetsRoots]).filter(root => deps.exists(root));
}

export function planPythonExtraPaths(input: PythonExtraPathsPlanInput): PythonExtraPathsPlan {
  const current = uniquePaths(input.currentPaths.map(normalizeExtraPath));
  const managedBefore = uniquePaths((input.previouslyManaged ?? []).map(normalizeExtraPath));
  const userPaths = current.filter(candidate => !managedBefore.includes(candidate));
  const managedPaths = uniquePaths([
    ...pythonScriptRootCandidates(input.workspaceRoot, input.deps),
    ...(input.extraManaged ?? [])
  ]);
  const nextPaths = uniquePaths([...userPaths, ...managedPaths]);
  const sameLength = nextPaths.length === current.length;
  const changed = !sameLength || nextPaths.some((candidate, index) => candidate !== current[index]);
  return { nextPaths, managedPaths, changed };
}

/** 装配层默认注入:真 fs 存在性判定与一级子目录列举 */
export const fileSystemScriptRootDeps: PythonScriptRootDeps = {
  exists: (candidate: string): boolean => fs.existsSync(candidate),
  listSubdirs: (dir: string): string[] => {
    try {
      return fs
        .readdirSync(dir, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name);
    } catch {
      // 工作区根读不到(权限/虚拟文件系统):当没有嵌套资产根处理
      return [];
    }
  }
};

export interface PythonExtraPathsSyncOptions {
  /** 激活期自动同步传 true:全程零提示,不打扰开窗;命令面板手动重跑
   *  保持默认完整播报。 */
  silent?: boolean;
}

/**
 * 同步入口:逐工作区发现 scripts 根并写 python.analysis.extraPaths。
 * 设置 `kbengine.python.extraPathsSync` 关闭时只说明不动手;无可发现根时
 * 静默跳过(不打扰);只在值有变化时写。
 */
export async function syncPythonExtraPaths(
  context: vscode.ExtensionContext,
  deps: PythonScriptRootDeps = fileSystemScriptRootDeps,
  options: PythonExtraPathsSyncOptions = {}
): Promise<void> {
  const enabled = vscode.workspace
    .getConfiguration('kbengine')
    .get<boolean>('python.extraPathsSync', PYTHON_EXTRA_PATHS_SYNC_ENABLED_DEFAULT);
  if (!enabled) {
    if (!options.silent) {
      await vscode.window.showInformationMessage(
        'Python extraPaths 接线已关闭(kbengine.python.extraPathsSync)'
      );
    }
    return;
  }
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    if (!options.silent) {
      await vscode.window.showInformationMessage('未打开工作区,跳过 Python extraPaths 接线');
    }
    return;
  }
  const written: string[] = [];
  // G2 存根目录只在「导出开 + KBEngine.pyi 真的在盘上」时并入管理段
  // (由激活期先导出再同步的顺序保证手动同步也能拾取已有存根);
  // def-pyi-stubs §6 的 kbe_types.pyi 分件镜像(含旧版单文件 kbe_types.py
  // 残留,迁移期不断线)同盘也并同一个目录,目录去重交给 plan
  const stubExportEnabled = vscode.workspace
    .getConfiguration('kbengine')
    .get<boolean>('python.stubExport', PYTHON_STUB_EXPORT_ENABLED_DEFAULT);
  // 托管目录名(任务 B):管理段目录随 kbengine.managedDir 解析,与导出链同源
  const managedDirName = resolveManagedDirName(readManagedDirSetting()).name;
  for (const folder of folders) {
    const workspaceRoot = folder.uri.fsPath;
    const managedKey = `${PYTHON_EXTRA_PATHS_MANAGED_KEY}:${workspaceRoot}`;
    const scoped = vscode.workspace.getConfiguration('python', folder);
    // 配置值形态不由本扩展控制:不是数组按没有现值处理,不炸
    const raw = scoped.get<unknown>('analysis.extraPaths', []);
    const currentPaths = Array.isArray(raw) ? raw : [];
    const extraManaged =
      stubExportEnabled &&
      (deps.exists(kbeStubFilePath(workspaceRoot)) ||
        typeStubArtifactExists(deps, workspaceRoot, managedDirName))
        ? [kbeStubDir(workspaceRoot, managedDirName)]
        : [];
    const plan = planPythonExtraPaths({
      workspaceRoot,
      currentPaths: currentPaths.map(String),
      previouslyManaged: context.workspaceState?.get<string[]>(managedKey) ?? [],
      deps,
      extraManaged
    });
    if (plan.managedPaths.length === 0) {
      continue;
    }
    if (!plan.changed) {
      continue;
    }
    // 经带资源域的 update 写该文件夹自己的 .vscode/settings.json(JSONC 注释宿主保全)
    await scoped.update(
      'analysis.extraPaths',
      plan.nextPaths,
      vscode.ConfigurationTarget.WorkspaceFolder
    );
    // 极简装配上下文没有 workspaceState:写入照做,只是不记忆(下次按首次处理)
    await context.workspaceState?.update(managedKey, plan.managedPaths);
    written.push(folder.name);
  }
  if (written.length > 0 && !options.silent) {
    await vscode.window.showInformationMessage(
      `已为 ${written.join('、')} 写入 python.analysis.extraPaths(scripts 根接线,Python 扩展可解析 import KBEngine)`
    );
  }
}
