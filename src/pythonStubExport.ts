/**
 * KBEngine Python API 存根导出(功能差距盘点 G2,docs/reference-feature-gap.md):
 * kbeModuleIndex 的符号索引只服务 kode 自己的补全/悬停/跳转(虚拟桩文档
 * Pylance 看不见),Python 扩展只认 extraPaths 里的真实文件。把同一份索引
 * 导出成 `<工作区>/.kbengine/stubs/KBEngine.pyi`,配合 G1 的 extraPaths
 * 接线,`import KBEngine` 才能解析。内容与虚拟桩文档同源发射,不抄
 * KBEngine Nex X 的文件;内容与磁盘一致时零写,不打扰。
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { buildKbeStubExportContent } from './kbeModuleIndex';
import {
  MANAGED_DIR_DEFAULT,
  MANAGED_DIR_SETTING_KEY,
  resolveManagedDirName
} from './managedDir';
import { substituteVariables, type VariableFolderRef } from './variableSubstitution';

// 托管目录解析面一并从这里出(单一进口处,调用方不必再引 managedDir)
export { MANAGED_DIR_DEFAULT, resolveManagedDirName } from './managedDir';

// Python 生态面的内容入口一并从这里出(单一进口处,调用方不必再引 kbeModuleIndex)
export { buildKbeStubExportContent } from './kbeModuleIndex';

export const PYTHON_STUB_EXPORT_SETTING = 'kbengine.python.stubExport';
/** 导出开关(kbengine.python.stubExport,默认开) */
export const PYTHON_STUB_EXPORT_ENABLED_DEFAULT = true;
export const KBE_STUB_FILE_NAME = 'KBEngine.pyi';

/** 引擎 typings 全量面开关默认值(kbengine.python.stubEngineTypings,默认开) */
export const PYTHON_STUB_ENGINE_TYPINGS_ENABLED_DEFAULT = true;

const ENGINE_TYPINGS_MARKER = 'typings/_KBEngine_common.pyi';
const ENGINE_TYPINGS_MODULE_ORDER = [
  '_KBEngine_common',
  '_KBEngine_baseapp',
  '_KBEngine_bots',
  '_KBEngine_cellapp',
  '_KBEngine_dbmgr',
  '_KBEngine_hooks',
  '_KBEngine_interfaces',
  '_KBEngine_logger',
  '_KBEngine_loginapp',
  '_KBEngine_pythonapp',
  '_KBEngine_server_errors'
] as const;

export interface KbeStubEngineOptions {
  engineRoot?: string | null;
  engineRootEnv?: Record<string, string | undefined>;
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
   * 目录归谁所有:false = kode 自管的 .kbengine/stubs(内容比对刷新);
   * true = 用户指定的目录(已有 .pyi 一律不碰)。
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
 * 展示当前生效值来自哪里(执行单要求「配置来源要可见」「冲突时显示取舍」——
 * 取值即取舍,设置压环境变量,来源字段就是这个取舍的显式登记)。
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

export interface StubDirScan {
  /** 目录下已有的 .pyi 文件名(按读出顺序) */
  pyiFiles: string[];
  /** 目录读不到(不存在/无权限);true 时不可当空目录处理 */
  unreadable: boolean;
  /** 读不到的原因,用于如实回话 */
  unreadableReason?: string;
}

/**
 * 扫一遍目录里的 .pyi(用户令:「配置了就扫描」)。只认小写 .pyi 后缀;
 * 目录不存在与无权限都归 unreadable——分不开也不必分,两种情况都不该盲写。
 */
export function scanStubDir(
  dir: string,
  deps: { listDir: (dir: string) => string[] }
): StubDirScan {
  let entries: string[];
  try {
    entries = deps.listDir(dir);
  } catch (error) {
    return {
      pyiFiles: [],
      unreadable: true,
      unreadableReason: error instanceof Error ? error.message : String(error)
    };
  }
  return {
    pyiFiles: entries.filter(name => name.endsWith('.pyi')),
    unreadable: false
  };
}

export type StubWriteDecision =
  /** 直接生成(用户目录里没有 .pyi) */
  | { write: true; reason: string }
  /** 归 kode 自管目录:交给内容比对刷新(保持 G2 陈旧重写语义) */
  | { write: 'managed'; reason: string }
  /** 不动用户文件,附原因 */
  | { write: false; reason: string };

/**
 * 覆盖判定(用户令:「没有 pyi 文件才生成」)。默认约定目录归 kode 自管,
 * 里面那份 KBEngine.pyi 是 kode 自己的产物,按内容比对刷新(批139 起的 G2
 * 语义);用户指定的目录一律只进不出——已有 .pyi 就当用户资产,读不到也
 * 不盲写。
 */
export function decideStubWrite(
  resolved: ResolvedStubDir,
  scan: StubDirScan
): StubWriteDecision {
  if (!resolved.userOwned) {
    return {
      write: 'managed',
      reason: `${resolved.dir}(默认约定目录,按内容比对刷新)`
    };
  }
  if (scan.unreadable) {
    return {
      write: false,
      reason: `${resolved.dir} 读不到(${scan.unreadableReason ?? '未知原因'}),未动用户文件`
    };
  }
  if (scan.pyiFiles.length > 0) {
    return {
      write: false,
      reason: `${resolved.dir} 已有 .pyi(${scan.pyiFiles.join('、')}),按用户资产不覆盖`
    };
  }
  return {
    write: true,
    reason: `${resolved.dir}(来源:${resolved.origin})无 .pyi,生成`
  };
}

export interface StubExportDeps {
  /** 路径存在性判定(测试注入,装配层为 fs.existsSync) */
  exists: (path: string) => boolean;
  /** 读现有内容做一致性比对;读不到(权限等)按陈旧处理触发重写 */
  readFile: (path: string) => string;
  writeFile: (path: string, content: string) => void;
  /** 建存根目录(递归) */
  mkdir: (dir: string) => void;
  /**
   * 列目录条目名(批142 用户目录扫描用;缺省表示本 deps 不支持扫描,
   * 此时用户目录一律判「读不到」不盲写,默认约定目录不受影响)。
   */
  listDir?: (dir: string) => string[];
}

/** 装配层默认注入:真 fs;readFile 失败回落空串(→ 判陈旧重写) */
export const fileSystemStubExportDeps: StubExportDeps = {
  exists: (candidate: string): boolean => fs.existsSync(candidate),
  readFile: (path: string): string => {
    try {
      return fs.readFileSync(path, 'utf8');
    } catch {
      return '';
    }
  },
  writeFile: (path: string, content: string): void => {
    fs.writeFileSync(path, content, 'utf8');
  },
  mkdir: (dir: string): void => {
    fs.mkdirSync(dir, { recursive: true });
  },
  listDir: (dir: string): string[] => fs.readdirSync(dir)
};

function resolveEngineTypingsRoot(
  workspaceRoot: string,
  options: KbeStubEngineOptions
): string | null {
  if (options.engineRoot === null) {
    return null;
  }
  const env = options.engineRootEnv ?? process.env;
  const candidates = [
    options.engineRoot,
    env.KBENGINE_ROOT,
    path.resolve(workspaceRoot, '..', 'kbengine')
  ];
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(path.join(candidate, ENGINE_TYPINGS_MARKER))) {
      return path.join(candidate, 'typings');
    }
  }
  return null;
}

function buildEngineKbeStubContent(typingsRoot: string): string | null {
  const modules: Array<{ name: string; lines: string[] }> = [];
  for (const moduleName of ENGINE_TYPINGS_MODULE_ORDER) {
    let content: string;
    try {
      content = fs.readFileSync(path.join(typingsRoot, `${moduleName}.pyi`), 'utf8');
    } catch {
      return null;
    }
    const rewritten = content.replace(/\r\n/g, '\n').replace(/\s+$/, '').replace(
      /^(\s*from\s+)_KBEngine_([^.\s]+)(\s+import\s+)/gm,
      '$1KBEngine$3'
    );
    modules.push({ name: moduleName, lines: rewritten.split('\n') });
  }
  const lines = [
    '# KBEngine.pyi — kode generated from the local KBEngine typings checkout.',
    '# Engine typings are concatenated so Python tools can resolve the full API;',
    '# if no engine checkout is detected, kode falls back to its curated catalog.',
    '# Completion/hover/navigation inside kode still use the curated catalog.'
  ];
  for (const module of modules) {
    lines.push('', `# --- ${module.name}.pyi (${typingsRoot}) ---`, ...module.lines);
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Engine checkouts provide the authoritative full API; concatenate them in a
 * stable order. Workspaces without an engine retain the curated catalog.
 */
export function buildKbeStubExportContentForWorkspace(
  workspaceRoot: string,
  options: KbeStubEngineOptions = {}
): string {
  // 引擎 typings 全量面独立开关(用户令 2026-10-21):总闸 stubExport 旧键
  // 优先管整个导出;此键只管「本地引擎 checkout 拼全量 API」这层增强,
  // =false 时回落 kode 自带精选目录(既有内容,不硬造)。
  const engineTypingsEnabled = vscode.workspace
    .getConfiguration('kbengine')
    .get<boolean>('python.stubEngineTypings', PYTHON_STUB_ENGINE_TYPINGS_ENABLED_DEFAULT);
  const engineTypingsRoot = engineTypingsEnabled
    ? resolveEngineTypingsRoot(workspaceRoot, options)
    : null;
  const engineContent = engineTypingsRoot ? buildEngineKbeStubContent(engineTypingsRoot) : null;
  if (engineContent) {
    return engineContent;
  }
  return buildKbeStubExportContent();
}

export interface StubExportOptions {
  /** 激活期自动导出传 true:全程零提示;命令面板手动导出保持播报 */
  silent?: boolean;
  engineRoot?: string | null;
  engineRootEnv?: Record<string, string | undefined>;
}

/**
 * 逐工作区把符号索引导出为 .kbengine/stubs/KBEngine.pyi。设置
 * `kbengine.python.stubExport` 关闭时只说明不动手;内容一致时零写;
 * 目录不可写(只读工作区等)告警并继续其余文件夹。返回实际写入的
 * 文件夹名列表。
 */
export async function exportKbeStubs(
  deps: StubExportDeps = fileSystemStubExportDeps,
  options: StubExportOptions & KbeStubEngineOptions = {}
): Promise<string[]> {
  const enabled = vscode.workspace
    .getConfiguration('kbengine')
    .get<boolean>('python.stubExport', PYTHON_STUB_EXPORT_ENABLED_DEFAULT);
  if (!enabled) {
    if (!options.silent) {
      await vscode.window.showInformationMessage(
        'KBEngine 存根导出已关闭(kbengine.python.stubExport)'
      );
    }
    return [];
  }
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    if (!options.silent) {
      await vscode.window.showInformationMessage('未打开工作区,跳过 KBEngine 存根导出');
    }
    return [];
  }
  const written: string[] = [];
  const failed: string[] = [];
  const skipped: string[] = [];
  for (const folder of folders) {
    const desired = buildKbeStubExportContentForWorkspace(folder.uri.fsPath, options);
    // 批142 用户令:目录以配置为准(设置 > 环境变量 > 默认约定),来源随值
    // 一起带出,供播报与「配置来源」视图说明当前生效值来自哪里
    const resolved = resolveStubDir(folder.uri.fsPath, {
      setting: readStubDirSetting(),
      managedDir: resolveManagedDirName(readManagedDirSetting()).name,
      folders: [{ fsPath: folder.uri.fsPath, name: folder.name }],
      filePath: vscode.window.activeTextEditor?.document.fileName
    });
    const target = joinPath(resolved.dir, KBE_STUB_FILE_NAME);
    // 用户指定目录先扫一遍:已有 .pyi 就当用户资产,不生成不覆盖;目录读不到
    // 也不盲写(看不见的目录不该被写)。默认约定目录归 kode 自管,跳过扫描,
    // 直接走下面的内容比对刷新(保住 G2 的陈旧重写语义)。
    if (resolved.userOwned) {
      const scan = scanStubDir(resolved.dir, {
        listDir: dir => {
          if (!deps.listDir) {
            throw new Error('未注入目录扫描能力');
          }
          return deps.listDir(dir);
        }
      });
      const decision = decideStubWrite(resolved, scan);
      if (decision.write !== true) {
        skipped.push(`${folder.name}(${decision.reason})`);
        continue;
      }
    }
    // 一致性比对段防御:存在性判定/读取抛错(权限等)按陈旧处理触发重写
    let unchanged = false;
    try {
      unchanged = deps.exists(target) && deps.readFile(target) === desired;
    } catch {
      unchanged = false;
    }
    if (unchanged) {
      continue;
    }
    try {
      deps.mkdir(resolved.dir);
      deps.writeFile(target, desired);
      written.push(folder.name);
    } catch {
      // 目录不可写(只读挂载/权限):如实告警,不挡其余文件夹
      failed.push(folder.name);
    }
  }
  if (skipped.length > 0 && !options.silent) {
    await vscode.window.showInformationMessage(
      `KBEngine 存根导出已跳过:${skipped.join(';')}`
    );
  }
  if (failed.length > 0 && !options.silent) {
    await vscode.window.showWarningMessage(
      `KBEngine 存根导出失败(目录不可写?): ${failed.join('、')}`
    );
  }
  if (written.length > 0 && !options.silent) {
    await vscode.window.showInformationMessage(
      `已为 ${written.join('、')} 导出 KBEngine.pyi 存根(kbengine.python.stubDir 指定目录,配合 extraPaths 接线供 Python 扩展解析)`
    );
  }
  return written;
}
