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
 *
 * CFG-02:生成的条目一律 `${workspaceFolder}/...` 变量形态(换机器/换盘符
 * 不失效),存量绝对路径带工作区前缀的在下次同步时自动迁移,不可迁移的
 * 绝对路径由配置契约诊断 extraPathsAbsolute 报;CFG-03:同一次同步显式写
 * `python.analysis.stubPath`(Pylance 三级优先级:同名 .pyi → stubPath →
 * extraPaths),用户已自设的 stubPath 永不覆盖;CFG-04:同一次同步键级合并
 * `python.analysis.diagnosticSeverityOverrides` 加 reportMissingModuleSource
 * =none——KBEngine 是 C++ 内嵌注册模块(PyImport_AddModule),磁盘上永远没有
 * 对应 .py 源,.pyi 落地后 Pylance 的「已找到类型声明、无法从源码解析」是
 * 嵌入模块常态噪声;用户已设的 override 永不覆盖,其他键原样保留。
 */

import * as fs from 'fs';
import * as vscode from 'vscode';
import {
  PYTHON_STUB_EXPORT_ENABLED_DEFAULT,
  kbeStubFilePath,
  kbeStubPackageInitPath,
  readManagedDirSetting,
  resolveManagedDirName,
  readStubDirSetting,
  resolveStubDir
} from './pythonStubExport';
import { processStubRoot } from './backend/pythonProcess';
import { syncProcessPythonConfiguration, processConfigFs, type ProcessConfigDeps } from './pythonProcessConfig';
import { typeStubArtifactExists } from './pythonTypeStubs';
import {
  enforceRoleIsolation,
  findCrossRoleModuleCollisions,
  resolveRoleAnalysisRoots
} from './backend/pythonRoleRoots';

export const PYTHON_EXTRA_PATHS_SETTING = 'python.analysis.extraPaths';
export const PYTHON_EXTRA_PATHS_MANAGED_KEY = 'kbengine.python.extraPaths.managed';
/** 同步开关(kbengine.python.extraPathsSync,默认开) */
export const PYTHON_EXTRA_PATHS_SYNC_ENABLED_DEFAULT = true;
/** CFG-03:显式 stubPath 键与「本扩展写过」的记忆键(用户自设值永不覆盖) */
export const PYTHON_STUB_PATH_SETTING = 'python.analysis.stubPath';
export const PYTHON_STUB_PATH_MANAGED_KEY = 'kbengine.python.stubPath.managed';
/** CFG-04:嵌入模块常态噪声(reportMissingModuleSource)所在的合并键 */
export const PYTHON_DIAG_SEVERITY_OVERRIDES_SETTING =
  'python.analysis.diagnosticSeverityOverrides';
/** VS Code 工作区变量前缀(CFG-02:生成面一律变量形态,工作区可移植) */
export const WORKSPACE_FOLDER_VAR = '${workspaceFolder}';

/**
 * 存量绝对路径 → `${workspaceFolder}` 变量形态(CFG-02)。只有前缀=工作区根
 * 才可替换(Windows 盘符根大小写不敏感、`\` 与 `/` 分隔符等价),否则原样
 * 透传——不可迁移的绝对路径留给配置契约诊断 extraPathsAbsolute 报。
 */
export function toWorkspaceFolderVar(candidate: string, workspaceRoot: string): string {
  if (candidate === '' || workspaceRoot === '') {
    return candidate;
  }
  const normalized = candidate.replace(/\\/g, '/');
  const root = workspaceRoot.replace(/\\/g, '/').replace(/\/+$/, '');
  if (root === '') {
    return candidate;
  }
  const caseInsensitive = /^[A-Za-z]:/.test(root);
  const left = caseInsensitive ? normalized.toLowerCase() : normalized;
  const right = caseInsensitive ? root.toLowerCase() : root;
  if (left === right) {
    return WORKSPACE_FOLDER_VAR;
  }
  if (left.startsWith(`${right}/`)) {
    return `${WORKSPACE_FOLDER_VAR}/${normalized.slice(root.length + 1)}`;
  }
  return candidate;
}

export interface PythonScriptRootDeps {
  /** 路径存在性判定(测试注入,装配层为 fs.existsSync) */
  exists: (path: string) => boolean;
  /** 列目录一级子目录名(测试注入,装配层为 fs.readdirSync 包装) */
  listSubdirs: (dir: string) => string[];
  /** 列目录下 .py 文件名(IDE-PRJ-006 跨角色同名播报用;缺省不播报) */
  listPyFiles?: (dir: string) => string[];
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
  /** 管理段被角色隔离闸剥掉的条目(IDE-PRJ-006;常规为空,守未来段扩员) */
  isolatedRoleRoots: string[];
  /** KR-AUD-37②:判定为用户段的现值条目(诊断/测试取证差量判定面) */
  userPaths: string[];
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
  const toVar = (candidate: string): string => toWorkspaceFolderVar(candidate, input.workspaceRoot);
  // 现值原形态留作 changed 基准:存量绝对路径→变量形态的迁移本身就算变化
  const rawCurrent = uniquePaths(input.currentPaths.map(normalizeExtraPath));
  const current = uniquePaths(rawCurrent.map(toVar));
  const managedBefore = uniquePaths((input.previouslyManaged ?? []).map(candidate => toVar(normalizeExtraPath(candidate))));
  // KR-AUD-37②(审核轮 P2 收口):大小写等价按「路径形态逐对」判定,不做
  // 全局语境开关——盘符字面路径对盘符字面路径大小写不敏感(Windows 同盘同
  // 目录);var 形态对 var 形态仅当工作区根为盘符路径(Windows 工作区,var
  // 展开为盘符路径)才不敏感;其余组合(含 POSIX 绝对路径、盘符×POSIX 混合)
  // 一律大小写敏感,防把 POSIX 的 `Scripts`/`scripts` 两个真不同目录误吞。
  const workspaceIsDrive = /^[a-z]:/i.test(input.workspaceRoot.replace(/\\/g, '/'));
  const isDriveLiteral = (p: string): boolean => /^[a-z]:\//i.test(p);
  const isVarForm = (p: string): boolean => p.startsWith(WORKSPACE_FOLDER_VAR);
  const sameCandidate = (left: string, right: string): boolean => {
    if (left === right) {
      return true;
    }
    const caseInsensitive =
      (isDriveLiteral(left) && isDriveLiteral(right)) ||
      (isVarForm(left) && isVarForm(right) && workspaceIsDrive);
    return caseInsensitive ? left.toLowerCase() === right.toLowerCase() : false;
  };
  const userPaths = current.filter(candidate => !managedBefore.some(managed => sameCandidate(candidate, managed)));
  // IDE-PRJ-006 角色隔离闸:管理段经每个发现的 scripts 根逐个过闸,角色
  // 目录(base/cell)剥出合并列表——scripts/base 与 scripts/cell 的同名模块
  // 不会因 extraPaths 顺序跨角色误解析;用户手填段不经闸(只管自己那段)。
  // 隔离闸在绝对路径形态上比对(角色根按磁盘路径解析),写回前统一转变量形态。
  let managedPaths = uniquePaths([
    ...pythonScriptRootCandidates(input.workspaceRoot, input.deps),
    ...(input.extraManaged ?? [])
  ]);
  const isolatedRoleRoots: string[] = [];
  for (const scriptsRoot of pythonScriptRootCandidates(input.workspaceRoot, input.deps)) {
    const { kept, removedRoleRoots } = enforceRoleIsolation(managedPaths, resolveRoleAnalysisRoots(scriptsRoot, input.deps));
    managedPaths = kept;
    isolatedRoleRoots.push(...removedRoleRoots);
  }
  const managedVar = uniquePaths(managedPaths.map(toVar));
  const nextPaths = uniquePaths([...userPaths, ...managedVar]);
  const sameLength = nextPaths.length === rawCurrent.length;
  const changed = !sameLength || nextPaths.some((candidate, index) => candidate !== rawCurrent[index]);
  return { nextPaths, managedPaths: managedVar, changed, isolatedRoleRoots, userPaths };
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
  },
  listPyFiles: (dir: string): string[] => {
    try {
      return fs
        .readdirSync(dir, { withFileTypes: true })
        .filter(entry => entry.isFile() && entry.name.endsWith('.py'))
        .map(entry => entry.name);
    } catch {
      return [];
    }
  }
};

export interface PythonExtraPathsSyncOptions {
  /** 激活期自动同步传 true:全程零提示,不打扰开窗;命令面板手动重跑
   *  保持默认完整播报。 */
  silent?: boolean;
  processConfigDeps?: ProcessConfigDeps;
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
  // IDE-PRJ-006:跨角色同名模块播报(非静默模式);隔离闸在 plan 内,
  // 这里只负责把「同名集合」如实告诉用户——合并列表不含角色目录,
  // 顺序不会决定 Avatar 解析到 base 还是 cell
  const collisionModules = new Set<string>();
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
    const stubRoot = resolveStubDir(workspaceRoot, {
      setting: readStubDirSetting(), managedDir: managedDirName,
      folders: [{ fsPath: workspaceRoot, name: folder.name }]
    }).dir;
    const configDeps = options.processConfigDeps ?? processConfigFs;
    const processMode = stubExportEnabled && configDeps.exists(
      `${processStubRoot(stubRoot, 'base')}/KBEngine/__init__.pyi`
    );
    const managedKey = `${PYTHON_EXTRA_PATHS_MANAGED_KEY}:${workspaceRoot}`;
    const scoped = vscode.workspace.getConfiguration('python', folder);
    // 配置值形态不由本扩展控制:不是数组按没有现值处理,不炸
    const raw = scoped.get<unknown>('analysis.extraPaths', []);
    const currentPaths = Array.isArray(raw) ? raw : [];
    // 存根在盘判定:批 ③ 起桩面是 KBEngine/ 桩包(copy-if-absent 复制),
    // 旧单文件 KBEngine.pyi 是迁移期残留,两者任一在盘即接线(旧判定只认
    // 单文件,桩包-only 的工作区会被漏接)
    const extraManaged =
      stubExportEnabled &&
      (processMode || deps.exists(kbeStubFilePath(workspaceRoot)) ||
        deps.exists(kbeStubPackageInitPath(workspaceRoot, managedDirName)) ||
        typeStubArtifactExists(deps, workspaceRoot, managedDirName))
        ? [stubRoot]
        : [];
    const plan = planPythonExtraPaths({
      workspaceRoot,
      currentPaths: currentPaths.map(String),
      previouslyManaged: context.workspaceState?.get<string[]>(managedKey) ?? [],
      deps,
      extraManaged
    });
    if (deps.listPyFiles) {
      for (const scriptsRoot of pythonScriptRootCandidates(workspaceRoot, deps)) {
        for (const moduleName of findCrossRoleModuleCollisions(
          resolveRoleAnalysisRoots(scriptsRoot, deps),
          { listPyFiles: deps.listPyFiles }
        )) {
          collisionModules.add(moduleName);
        }
      }
    }
    if (plan.managedPaths.length === 0) {
      continue;
    }
    if (plan.changed) {
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
    // CFG-03:显式写 python.analysis.stubPath(默认约定 ${workspaceFolder}/.kbengine/stubs,
    // 随 kbengine.managedDir 同迁)——Pylance 三级优先级(同名 .pyi → stubPath →
    // extraPaths)由此确定。只管自己那段:用户已自设的值永不覆盖;存根导出关
    // 时 kode 的存根面整个关掉,也不写。与 extraPaths 差量解耦:现值已对齐即零写。
    let userStubPath: string | undefined;
    if (stubExportEnabled) {
      const stubPathValue = toWorkspaceFolderVar(processMode ? `${stubRoot}/_shared` : stubRoot, workspaceRoot);
      const stubPathKey = `${PYTHON_STUB_PATH_MANAGED_KEY}:${workspaceRoot}`;
      const currentStubPath = scoped.get<string>('analysis.stubPath', '') ?? '';
      const storedStubPath = context.workspaceState?.get<string>(stubPathKey) ?? '';
      const owned =
        currentStubPath === '' ||
        currentStubPath === storedStubPath ||
        currentStubPath === stubPathValue;
      if (owned) {
        if (currentStubPath !== stubPathValue) {
          await scoped.update(
            'analysis.stubPath',
            stubPathValue,
            vscode.ConfigurationTarget.WorkspaceFolder
          );
        }
        if (storedStubPath !== stubPathValue) {
          await context.workspaceState?.update(stubPathKey, stubPathValue);
        }
      } else {
        userStubPath = currentStubPath;
      }
      // CFG-04:压 reportMissingModuleSource——KBEngine 是 C++ 内嵌注册模块
      // (py_entitydef.cpp PyImport_AddModule("KBEngine")),磁盘上永远没有对应
      // .py 源;KBEngine.pyi 落进 stubPath 后 Pylance 的「已找到类型声明,无法
      // 从源码解析」是嵌入模块的常态而非故障。键级合并:只加自己这一个键,
      // 用户已有的键(含已设过的 reportMissingModuleSource)一律不动;值恒为
      // 'none',现值已对齐即零写,无需 managed 记忆键。存根导出关时本面一并
      // 关(无 .pyi 即无此噪声,与 CFG-03 同口径)。
      const rawOverrides = scoped.get<unknown>('analysis.diagnosticSeverityOverrides', undefined);
      const overrides =
        rawOverrides !== null && typeof rawOverrides === 'object' && !Array.isArray(rawOverrides)
          ? (rawOverrides as Record<string, unknown>)
          : {};
      if (overrides['reportMissingModuleSource'] === undefined) {
        await scoped.update(
          'analysis.diagnosticSeverityOverrides',
          { ...overrides, reportMissingModuleSource: 'none' },
          vscode.ConfigurationTarget.WorkspaceFolder
        );
      }
    }
    if (processMode) {
      await syncProcessPythonConfiguration(context, workspaceRoot,
        pythonScriptRootCandidates(workspaceRoot, deps), stubRoot, plan.userPaths, configDeps, userStubPath);
    }
  }
  if (written.length > 0 && !options.silent) {
    await vscode.window.showInformationMessage(
      `已为 ${written.join('、')} 写入 python.analysis.extraPaths(scripts 根接线,Python 扩展可解析 import KBEngine)`
    );
  }
  if (collisionModules.size > 0 && !options.silent) {
    const names = [...collisionModules].sort().join('、');
    await vscode.window.showInformationMessage(
      `base/cell 存在同名模块: ${names}——分析根已按角色隔离(extraPaths 不含角色目录,不会因顺序跨角色误解析)`
    );
  }
}
