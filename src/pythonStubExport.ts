/**
 * KBEngine Python 桩包导出(批 ③,用户令 2026-11-11 静态模板定案):
 * 插件内置静态模板(顶层 typings/,派生自 cuihairu/kbengine fork 的 typings,
 * 钉点 commit 见 typings/README.md),激活期复制到 `<工作区>/.kbengine/stubs/`
 * 供 Python 扩展解析 `import KBEngine`。
 *
 * 铁律 copy-if-absent 零覆盖:目标文件已存在就一个字节不动——用户魔改的
 * 项目副本永久保留;覆盖只走显式重置命令(kbengine.python.resetStubs)且
 * 要用户确认。旧动态生成链(引擎 checkout 拼接 / 精选目录回退 / 托管目录
 * 内容比对重写)整体退役——重写正是会吃掉用户魔改的形态;托管目录里
 * kode 生成的旧单文件 KBEngine.pyi 按 kode 生成标记识别后移除(一次性迁移,
 * KBEngine/ 桩包取代它)。
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  MANAGED_DIR_DEFAULT,
  MANAGED_DIR_SETTING_KEY,
  resolveManagedDirName
} from './backend/managedDir';
import { substituteVariables, type VariableFolderRef } from './backend/variableSubstitution';

// 托管目录解析面一并从这里出(单一进口处,调用方不必再引 managedDir)
export { MANAGED_DIR_DEFAULT, resolveManagedDirName } from './backend/managedDir';

export const PYTHON_STUB_EXPORT_SETTING = 'python.stubExport';
/** 导出开关(kbengine.python.stubExport,默认开) */
export const PYTHON_STUB_EXPORT_ENABLED_DEFAULT = true;
/**
 * 旧单文件产物名(迁移面):托管目录里带 kode 生成标记的 KBEngine.pyi 会被
 * 一次性移除,由 KBEngine/ 桩包取代;用户目录里同名文件一律不碰。
 */
export const KBE_STUB_FILE_NAME = 'KBEngine.pyi';
/** 旧动态链产物头标记(迁移判定面:命中才算 kode 生成物) */
export const KBE_STUB_GENERATED_MARKER = '# KBEngine.pyi — kode generated';
/** 内置模板根(扩展安装目录相对路径;与 fork typings 同形) */
export const KBENGINE_STUB_TEMPLATE_RELATIVE_ROOT = 'typings';

/** 模板根解析:扩展安装目录 + 相对根(装配层接线用);无 extensionPath 的
 * 极简宿主(嵌入/烟测替身)落空串,模板收集按缺失处理,激活链不炸 */
export function resolveKbengineStubTemplateRoot(extensionPath: string): string {
  return extensionPath ? path.join(extensionPath, KBENGINE_STUB_TEMPLATE_RELATIVE_ROOT) : '';
}

export interface KbengineStubTemplateFile {
  /** 模板根相对路径(正斜杠,如 `KBEngine/Entity.pyi`) */
  relativePath: string;
  content: string;
}

/**
 * 收集内置模板文件清单(只收 .pyi;README.md 是作者期元数据,不进项目)。
 * 按 relativePath 排序,复制顺序确定。模板根缺失/不可读返回 null——调用方
 * 如实告警,不静默装作无事。
 */
export function collectKbengineStubTemplateFiles(
  templateRoot: string,
  deps: { exists: (path: string) => boolean; listDir: (dir: string) => string[]; readFile: (path: string) => string }
): KbengineStubTemplateFile[] | null {
  if (!deps.exists(templateRoot)) {
    return null;
  }
  const files: KbengineStubTemplateFile[] = [];
  const walk = (dir: string, prefix: string): void => {
    let entries: string[];
    try {
      entries = deps.listDir(dir);
    } catch {
      return;
    }
    for (const name of entries.sort()) {
      const absolute = path.join(dir, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      let statIsDirectory = false;
      try {
        statIsDirectory = fs.statSync(absolute).isDirectory();
      } catch {
        continue;
      }
      if (statIsDirectory) {
        walk(absolute, relative);
        continue;
      }
      if (!name.endsWith('.pyi')) {
        continue;
      }
      files.push({ relativePath: relative, content: deps.readFile(absolute) });
    }
  };
  walk(templateRoot, '');
  return files.length > 0 ? files.sort((a, b) => (a.relativePath < b.relativePath ? -1 : 1)) : null;
}

/** 存根目录设置键(kbengine.python.stubDir,默认空串=走默认约定;旧键不废) */
export const PYTHON_STUB_DIR_SETTING = 'python.stubDir';
/**
 * 存根目录环境变量名(批142,任务单 kode-pyi.md):与本仓既有 `KBENGINE_*`
 * 命名风格一致,给 CI / 容器等不便写 settings.json 的场景一条口子。
 */
export const PYTHON_STUB_DIR_ENV = 'KBENGINE_STUB_DIR';
/** 默认约定的目录名(相对工作区根),来源标注里显示它表示「未配置」 */
export const PYTHON_STUB_DIR_DEFAULT = '.kbengine/stubs';

/** 路径拼接(正斜杠归一),托管目录与存根路径共用 */
function joinPath(...segments: string[]): string {
  return segments.join('/').replace(/\\/g, '/');
}

/**
 * 托管目录设置读取口(装配层):`kbengine.managedDir`,默认 `.kbengine`。
 * 托管目录收拢 debug.json 与 stubs/ 全部分件(任务 B,用户令);旧键
 * kbengine.python.stubDir / KBENGINE_STUB_DIR 语义原样保留且优先。
 */
export function readManagedDirSetting(): unknown {
  return vscode.workspace.getConfiguration('kbengine').get(MANAGED_DIR_SETTING_KEY, MANAGED_DIR_DEFAULT);
}

/** 托管目录绝对路径:`<工作区根>/<managedDir>`(managedDirName 缺省走默认) */
export function managedDirPath(workspaceRoot: string, managedDirName: string = MANAGED_DIR_DEFAULT): string {
  return joinPath(workspaceRoot, resolveManagedDirName(managedDirName).name);
}

/** 存根目录约定:`<managedDir>/stubs`(kode 管理目录,与 debug.json 同居) */
export function kbeStubDir(workspaceRoot: string, managedDirName: string = MANAGED_DIR_DEFAULT): string {
  return joinPath(managedDirPath(workspaceRoot, managedDirName), 'stubs');
}

export function kbeStubFilePath(workspaceRoot: string): string {
  return joinPath(kbeStubDir(workspaceRoot), KBE_STUB_FILE_NAME);
}

/** 桩包入口:`<managedDir>/stubs/KBEngine/__init__.pyi`(extraPaths 探测面) */
export function kbeStubPackageInitPath(workspaceRoot: string, managedDirName: string = MANAGED_DIR_DEFAULT): string {
  return joinPath(kbeStubDir(workspaceRoot, managedDirName), 'KBEngine', '__init__.pyi');
}

export type StubDirSource = 'setting' | 'env' | 'default';

export interface ResolvedStubDir {
  /** 展开 VS Code 变量后的目录(绝对路径) */
  dir: string;
  /** 用户手写的原始值(未展开);默认来源为 null */
  raw: string | null;
  /** 生效来源 */
  source: StubDirSource;
  /** 来源标注:设置键 / 环境变量名 / 默认约定名 */
  origin: string;
  /**
   * 目录归谁所有:false = kode 自管的 .kbengine/stubs(旧产物迁移面);
   * true = 用户指定的目录(已有文件一律不碰,重置也只动模板同名文件)。
   */
  userOwned: boolean;
}

export interface StubDirReading {
  /** kbengine.python.stubDir 的原始设置值 */
  setting?: unknown;
  /** 环境变量表,缺省读 process.env */
  env?: Record<string, string | undefined>;
  /** 变量替换用的工作区根表 */
  folders?: readonly VariableFolderRef[];
  /** 变量替换用的当前文件 */
  filePath?: string;
  /**
   * 托管目录名(任务 B):默认约定目录随 kbengine.managedDir 同迁;设置/环境
   * 变量来源的存根目录(旧键)不受影响。缺省 = 默认 .kbengine。
   */
  managedDir?: string;
}

/** 路径形态判定:盘符绝对 / UNC / posix 绝对一律不与工作区根拼接 */
function looksAbsolute(candidate: string): boolean {
  return candidate.startsWith('/') || /^[A-Za-z]:[\\/]/.test(candidate);
}

function trimTrailingSlash(candidate: string): string {
  return candidate.replace(/\/+$/, '');
}

/** 装配层读设置口(单独导出:测试不必搭一棵假配置树) */
export function readStubDirSetting(): unknown {
  return vscode.workspace.getConfiguration('kbengine').get(PYTHON_STUB_DIR_SETTING, '');
}

/**
 * `.pyi` 目录三级来源解析(批142,用户令:「不配置才默认生成,配置了就扫描」):
 * 设置 > 环境变量 > 默认约定,取到的来源随值一起返回,供「配置来源」视图
 * 展示当前生效值来自哪里(取值即取舍,设置压环境变量,来源字段就是这个
 * 取舍的显式登记)。
 */
export function resolveStubDir(
  workspaceRoot: string,
  reading: StubDirReading = {}
): ResolvedStubDir {
  const settingRaw = typeof reading.setting === 'string' ? reading.setting.trim() : '';
  const envTable = reading.env ?? process.env;
  const envRaw = (envTable[PYTHON_STUB_DIR_ENV] ?? '').trim();

  let raw = '';
  let source: StubDirSource;
  let origin: string;
  if (settingRaw.length > 0) {
    raw = settingRaw;
    source = 'setting';
    origin = `kbengine.${PYTHON_STUB_DIR_SETTING}`;
  } else if (envRaw.length > 0) {
    raw = envRaw;
    source = 'env';
    origin = PYTHON_STUB_DIR_ENV;
  } else {
    // 默认约定:托管目录(stubs)三级收拢(任务 B)——未配置 managedDir 时
    // 即既有 .kbengine/stubs,来源标注不变;配置后随新目录同迁。
    const managed = resolveManagedDirName(reading.managedDir);
    return {
      dir: kbeStubDir(workspaceRoot, managed.name),
      raw: null,
      source: 'default',
      origin: `${managed.name}/stubs`,
      userOwned: false
    };
  }

  // 路径类设置走批141 的官方变量替换(与 debug.json、quick action 同一套机制,
  // 不另造);未解析落空串是既有口径,故替换后为空也不算回落默认目录。
  const expanded = substituteVariables(raw, {
    folders: reading.folders ?? [{ fsPath: workspaceRoot, name: '' }],
    filePath: reading.filePath,
    env: envTable
  }).trim();
  const dir = trimTrailingSlash(
    looksAbsolute(expanded)
      ? expanded
      : joinPath(trimTrailingSlash(workspaceRoot), expanded)
  );

  return { dir, raw, source, origin, userOwned: true };
}

export interface StubExportDeps {
  /** 路径存在性判定(测试注入,装配层为 fs.existsSync) */
  exists: (path: string) => boolean;
  readFile: (path: string) => string;
  writeFile: (path: string, content: string) => void;
  /** 建存根目录(递归) */
  mkdir: (dir: string) => void;
  /** 删除单文件(迁移/重置面;缺省表示本 deps 不支持删除) */
  deleteFile?: (path: string) => void;
  /** 列目录条目名(模板清单收集用) */
  listDir?: (dir: string) => string[];
}

/** 装配层默认注入:真 fs */
export const fileSystemStubExportDeps: StubExportDeps = {
  exists: (candidate: string): boolean => fs.existsSync(candidate),
  readFile: (path: string): string => fs.readFileSync(path, 'utf8'),
  writeFile: (path: string, content: string): void => {
    fs.writeFileSync(path, content, 'utf8');
  },
  mkdir: (dir: string): void => {
    fs.mkdirSync(dir, { recursive: true });
  },
  deleteFile: (path: string): void => {
    fs.rmSync(path, { force: true });
  },
  listDir: (dir: string): string[] => fs.readdirSync(dir)
}

export interface StubExportOptions {
  /** 激活期自动导出传 true:全程零提示;命令面板手动导出保持播报 */
  silent?: boolean;
  /** 内置模板根(装配层传 extensionPath/typings;缺省不复制并如实告警) */
  templateRoot?: string;
}

interface FolderCopyOutcome {
  folder: string;
  copied: number;
  /** 迁移面:移除的旧 kode 生成物(KBEngine.pyi 单文件) */
  migrated: boolean;
  failed: boolean;
}

/**
 * 单工作区 copy-if-absent 复制(铁律:目标已存在零字节动;读不到/写不了
 * 如实记账,不挡其余文件夹)。托管目录额外做旧产物迁移:带 kode 生成标记
 * 的旧单文件 KBEngine.pyi 移除(桩包取代它);用户目录里同名文件绝不碰。
 */
function copyTemplateIntoFolder(
  folderName: string,
  folderRoot: string,
  resolved: ResolvedStubDir,
  templateFiles: KbengineStubTemplateFile[],
  deps: StubExportDeps
): FolderCopyOutcome {
  const outcome: FolderCopyOutcome = { folder: folderName, copied: 0, migrated: false, failed: false };
  let dirReadable = true;
  try {
    deps.exists(resolved.dir);
  } catch {
    dirReadable = false;
  }
  if (!dirReadable) {
    outcome.failed = true;
    return outcome;
  }
  // 迁移面(仅托管目录):旧单文件 KBEngine.pyi 带 kode 生成标记才移除;
  // 无标记 = 用户资产,一字节不动。
  if (!resolved.userOwned) {
    const legacyPath = joinPath(resolved.dir, KBE_STUB_FILE_NAME);
    try {
      if (deps.exists(legacyPath) && deps.readFile(legacyPath).startsWith(KBE_STUB_GENERATED_MARKER)) {
        deps.deleteFile?.(legacyPath);
        outcome.migrated = true;
      }
    } catch {
      // 读不到(权限等):不动,照旧走逐文件复制
    }
  }
  for (const file of templateFiles) {
    const target = joinPath(resolved.dir, file.relativePath);
    try {
      if (deps.exists(target)) {
        continue;
      }
      deps.mkdir(path.dirname(target));
      deps.writeFile(target, file.content);
      outcome.copied += 1;
    } catch {
      outcome.failed = true;
    }
  }
  return outcome;
}

/**
 * 逐工作区把内置 KBEngine 桩包复制到存根目录(copy-if-absent 零覆盖)。
 * 设置 `kbengine.python.stubExport` 关闭时只说明不动手;模板根缺失告警;
 * 目录不可写(只读工作区等)记账并继续其余文件夹。返回实际有复制的文件夹名。
 */
export async function exportKbeStubs(
  deps: StubExportDeps = fileSystemStubExportDeps,
  options: StubExportOptions = {}
): Promise<string[]> {
  const enabled = vscode.workspace
    .getConfiguration('kbengine')
    .get<boolean>(PYTHON_STUB_EXPORT_SETTING, PYTHON_STUB_EXPORT_ENABLED_DEFAULT);
  if (!enabled) {
    if (!options.silent) {
      await vscode.window.showInformationMessage(
        'KBEngine 桩包复制已关闭(kbengine.python.stubExport)'
      );
    }
    return [];
  }
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    if (!options.silent) {
      await vscode.window.showInformationMessage('未打开工作区,跳过 KBEngine 桩包复制');
    }
    return [];
  }
  const templateRoot = options.templateRoot;
  const templateFiles = templateRoot
    ? collectKbengineStubTemplateFiles(templateRoot, {
      exists: deps.exists,
      listDir: dir => {
        if (!deps.listDir) {
          throw new Error('未注入目录枚举能力');
        }
        return deps.listDir(dir);
      },
      readFile: deps.readFile
    })
    : null;
  if (!templateFiles) {
    if (!options.silent) {
      await vscode.window.showWarningMessage(
        `KBEngine 桩包内置模板读不到(${templateRoot ?? '未提供 templateRoot'}),跳过复制`
      );
    }
    return [];
  }
  const outcomes: FolderCopyOutcome[] = [];
  for (const folder of folders) {
    // 批142 用户令:目录以配置为准(设置 > 环境变量 > 默认约定),来源随值
    // 一起带出,供播报与「配置来源」视图说明当前生效值来自哪里
    const resolved = resolveStubDir(folder.uri.fsPath, {
      setting: readStubDirSetting(),
      managedDir: resolveManagedDirName(readManagedDirSetting()).name,
      folders: [{ fsPath: folder.uri.fsPath, name: folder.name }],
      filePath: vscode.window.activeTextEditor?.document.fileName
    });
    outcomes.push(
      copyTemplateIntoFolder(folder.name, folder.uri.fsPath, resolved, templateFiles, deps)
    );
  }
  const copiedFolders = outcomes.filter(outcome => outcome.copied > 0).map(outcome => outcome.folder);
  const failedFolders = outcomes.filter(outcome => outcome.failed).map(outcome => outcome.folder);
  const migratedFolders = outcomes.filter(outcome => outcome.migrated).map(outcome => outcome.folder);
  if (!options.silent) {
    if (copiedFolders.length > 0) {
      await vscode.window.showInformationMessage(
        `已为 ${copiedFolders.join('、')} 复制 KBEngine 桩包(copy-if-absent,已有文件不动;配合 stubPath/extraPaths 供 Python 扩展解析)`
      );
    }
    if (migratedFolders.length > 0) {
      await vscode.window.showInformationMessage(
        `已移除 kode 旧生成物 KBEngine.pyi:${migratedFolders.join('、')}(KBEngine/ 桩包取代;用户目录不受影响)`
      );
    }
    if (failedFolders.length > 0) {
      await vscode.window.showWarningMessage(
        `KBEngine 桩包复制失败(目录不可写?): ${failedFolders.join('、')}`
      );
    }
  }
  return copiedFolders;
}

/**
 * 显式重置(覆盖只走此命令且要用户确认,用户令 2026-11-11):删掉模板集
 * 同名文件后按模板重复制。托管目录额外回收旧 kode 生成物;模板集之外的
 * 未知文件一律不碰。确认弹窗取消=零动作。
 */
export async function resetKbeStubs(
  deps: StubExportDeps = fileSystemStubExportDeps,
  options: StubExportOptions = {}
): Promise<string[]> {
  if (!options.silent) {
    const choice = await vscode.window.showWarningMessage(
      '重置 KBEngine 桩包?将删除存根目录里模板集同名文件(含你的修改)后重新复制,模板集之外的文件不动。',
      { modal: true },
      '重置'
    );
    if (choice !== '重置') {
      return [];
    }
  }
  const folders = vscode.workspace.workspaceFolders ?? [];
  const templateRoot = options.templateRoot;
  const templateFiles = templateRoot
    ? collectKbengineStubTemplateFiles(templateRoot, {
      exists: deps.exists,
      listDir: dir => {
        if (!deps.listDir) {
          throw new Error('未注入目录枚举能力');
        }
        return deps.listDir(dir);
      },
      readFile: deps.readFile
    })
    : null;
  if (!templateFiles) {
    if (!options.silent) {
      await vscode.window.showWarningMessage(
        `KBEngine 桩包内置模板读不到(${templateRoot ?? '未提供 templateRoot'}),跳过重置`
      );
    }
    return [];
  }
  const reset: string[] = [];
  for (const folder of folders) {
    const resolved = resolveStubDir(folder.uri.fsPath, {
      setting: readStubDirSetting(),
      managedDir: resolveManagedDirName(readManagedDirSetting()).name,
      folders: [{ fsPath: folder.uri.fsPath, name: folder.name }],
      filePath: vscode.window.activeTextEditor?.document.fileName
    });
    let touched = false;
    for (const file of templateFiles) {
      const target = joinPath(resolved.dir, file.relativePath);
      try {
        if (deps.exists(target)) {
          deps.deleteFile?.(target);
          touched = true;
        }
      } catch {
        // 删不掉(权限等):照旧尝试覆盖写
      }
    }
    if (!resolved.userOwned) {
      const legacyPath = joinPath(resolved.dir, KBE_STUB_FILE_NAME);
      try {
        if (deps.exists(legacyPath) && deps.readFile(legacyPath).startsWith(KBE_STUB_GENERATED_MARKER)) {
          deps.deleteFile?.(legacyPath);
          touched = true;
        }
      } catch {
        // 读不到:不动
      }
    }
    const outcome = copyTemplateIntoFolder(folder.name, folder.uri.fsPath, resolved, templateFiles, deps);
    if (touched || outcome.copied > 0) {
      reset.push(folder.name);
    }
  }
  if (!options.silent && reset.length > 0) {
    await vscode.window.showInformationMessage(
      `已重置 ${reset.join('、')} 的 KBEngine 桩包(模板集同名文件按模板重建)`
    );
  }
  return reset;
}
