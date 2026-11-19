/**
 * venv 自动发现(PY-ENV 二期):扫描工作区(及其子目录,深度封顶)下的
 * 虚拟环境。认环境只认证据——venv 以 pyvenv.cfg 文件为证、conda 环境以
 * conda-meta/ 目录为证,并且解释器二进制(bin/python 或 Windows 的
 * Scripts/python.exe)真实在盘才收录;损坏环境(有标记没二进制/有二进制
 * 没标记)一律不认,绝不伪造。扫描面与 pythonScanRules(Python 源码类索
 * 引)完全解耦:不共享候选清单、不共享剪枝规则、互不 import。全部只做
 * 存在性探测,不执行任何程序。
 *
 * 同步版(scanVenvs)之外另有异步层(scanVenvsAsync + discoverVenvsCached,
 * KODE-RESP-010):目录读走异步 I/O 且目录间让步,宽目录/慢文件系统下事件
 * 循环心跳持续;总目录/时间预算与取消令牌到顶即停;按根及配置代(约定名
 * 清单)缓存,多消费者共享一次在途发现。产品主线程(UI/状态栏/选择器)一律
 * 走异步层,同步版只留给确已离开主线程的调用方。
 */

import * as fs from 'fs';
import * as path from 'path';

/** 扫描深度封顶(0 = 扫描根自身一层) */
export const MAX_VENV_SCAN_DEPTH = 3;

/**
 * 剪枝目录名:依赖树/构建产物/版本控制目录里可能出现环境状目录,但都不
 * 是用户意图里的项目环境,绝不进入(注意 .venv/venv 是合法候选,不在此列)。
 */
export const DEFAULT_PRUNED_DIRECTORY_NAMES: readonly string[] = [
  'node_modules',
  'target',
  '.git',
  '__pycache__',
  'dist',
  'coverage',
  '.cache'
];

/** 单个发现的环境 */
export interface DiscoveredVenv {
  /** 环境目录绝对路径 */
  rootPath: string;
  /** 目录名(basename) */
  name: string;
  /** 已验证的解释器二进制绝对路径 */
  interpreterPath: string;
  /** 证据类型:pyvenv.cfg=venv,conda-meta=conda */
  envKind: 'venv' | 'conda';
  /** 相对扫描根的深度(根直下=0) */
  depth: number;
}

export interface VenvScanOptions {
  /** 深度封顶,默认 MAX_VENV_SCAN_DEPTH */
  maxDepth?: number;
  /** 剪枝目录名清单,默认 DEFAULT_PRUNED_DIRECTORY_NAMES */
  prunedDirectoryNames?: readonly string[];
  /** 平台(测试注入);默认 process.platform */
  platform?: NodeJS.Platform;
  /** 同深度优先的目录名提示(venvDirectories 配置语义延续) */
  preferredNames?: readonly string[];
}

/** 该目录名是否在剪枝清单里(精确匹配;venv 候选名不在清单) */
export function shouldPruneVenvScanDirectory(
  name: string,
  pruned: readonly string[] = DEFAULT_PRUNED_DIRECTORY_NAMES
): boolean {
  return pruned.includes(name);
}

/** 平台对应的解释器二进制候选(bin|Scripts × python|python3[.exe]);conda
 * 环境在 Windows 的解释器常在环境根目录(python.exe),按 envKind 追加 */
export function venvBinaryCandidates(
  dir: string,
  platform: NodeJS.Platform,
  envKind: 'venv' | 'conda' | null = null
): string[] {
  const binDir = path.join(dir, platform === 'win32' ? 'Scripts' : 'bin');
  const layout =
    platform === 'win32'
      ? [path.join(binDir, 'python.exe'), path.join(binDir, 'python3.exe')]
      : [path.join(binDir, 'python'), path.join(binDir, 'python3')];
  if (platform === 'win32' && envKind === 'conda') {
    return [
      path.join(dir, 'python.exe'),
      path.join(dir, 'python3.exe'),
      ...layout
    ];
  }
  return layout;
}

/** 存在性探测只认真文件(目录/symlink-to-dir 不算);statSync 跟随 symlink,
 * venv 的 bin/python 是指向系统解释器的 symlink,照样判真 */
const isFileCandidate = (candidate: string): boolean => {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
};

/**
 * 环境证据判定:pyvenv.cfg 文件 → venv;conda-meta 目录 → conda;都无 →
 * null(不是环境,不猜)。venv 证据优先(两者都在盘时按 venv 记)。
 */
export function hasEnvMarker(dir: string): 'venv' | 'conda' | null {
  try {
    if (fs.statSync(path.join(dir, 'pyvenv.cfg')).isFile()) {
      return 'venv';
    }
  } catch {
    // 无 pyvenv.cfg,继续看 conda 证据
  }
  try {
    if (fs.statSync(path.join(dir, 'conda-meta')).isDirectory()) {
      return 'conda';
    }
  } catch {
    // 无 conda-meta
  }
  return null;
}

/**
 * 验证一个目录是否为可用环境:环境证据在 + 解释器二进制在盘。返回解释器
 * 路径;任一证据缺失返回 null(损坏环境不认,不伪造路径)。
 */
export function verifyVenvDirectory(
  dir: string,
  platform: NodeJS.Platform = process.platform
): string | null {
  const kind = hasEnvMarker(dir);
  if (!kind) {
    return null;
  }
  for (const candidate of venvBinaryCandidates(dir, platform, kind)) {
    if (isFileCandidate(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * 深度优先扫描 root 下的环境(深度封顶,剪枝名单绝不进入;发现环境后不
 * 再向其内部下钻——环境里嵌环境不是任何人的意图)。排序:浅者先,同深度
 * 字典序;name 命中 preferredNames 的同深度再前置(解析链用它让目录名清
 * 单配置的语义仍然生效)。
 */
export function scanVenvs(root: string, options: VenvScanOptions = {}): DiscoveredVenv[] {
  const maxDepth = options.maxDepth ?? MAX_VENV_SCAN_DEPTH;
  const pruned = options.prunedDirectoryNames ?? DEFAULT_PRUNED_DIRECTORY_NAMES;
  const platform = options.platform ?? process.platform;
  const found: Array<DiscoveredVenv & { preferred: boolean }> = [];
  const preferredSet = new Set(options.preferredNames ?? []);

  const visit = (dir: string, depth: number): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // 不可读目录如实跳过
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || shouldPruneVenvScanDirectory(entry.name, pruned)) {
        continue;
      }
      const child = path.join(dir, entry.name);
      const interpreterPath = verifyVenvDirectory(child, platform);
      if (interpreterPath) {
        found.push({
          rootPath: child,
          name: entry.name,
          interpreterPath,
          envKind: hasEnvMarker(child) === 'conda' ? 'conda' : 'venv',
          depth,
          preferred: preferredSet.has(entry.name)
        });
        continue; // 不向环境内部下钻
      }
      if (depth < maxDepth) {
        visit(child, depth + 1);
      }
    }
  };

  visit(root, 0);
  return sortDiscoveredVenvs(found);
}

/** 排序(同步/异步两道扫描共用,零漂移):浅者先,同深度约定名命中
 * (preferredNames)先置,再字典序 */
const sortDiscoveredVenvs = (
  found: Array<DiscoveredVenv & { preferred: boolean }>
): DiscoveredVenv[] =>
  found
    .sort(
      (a, b) =>
        a.depth - b.depth ||
        Number(b.preferred) - Number(a.preferred) ||
        a.name.localeCompare(b.name)
    )
    .map(({ preferred: _preferred, ...env }) => env);

// ---- 异步扫描层(KODE-RESP-010):宽目录/慢文件系统不得卡死扩展宿主主线程 ----

/** 异步扫描的总目录访问预算(含扫描根与约定候选探测;大仓库到顶即停) */
export const MAX_VENV_SCAN_DIRECTORIES = 4096;
/** 异步扫描的总时间预算(ms);超时即停,返回已发现部分 */
export const VENV_SCAN_DEADLINE_MS = 5000;

export interface VenvScanAsyncOptions extends VenvScanOptions {
  /** 总目录预算,默认 MAX_VENV_SCAN_DIRECTORIES;到顶停止深扫 */
  maxDirectories?: number;
  /** 时间预算 ms,默认 VENV_SCAN_DEADLINE_MS */
  deadlineMs?: number;
  /** 取消令牌:置 aborted 后不再深扫(在途扫描以已发现部分正常收束) */
  signal?: { aborted: boolean };
  /** 目录读取注入面(测试注入慢文件系统);缺省 fs.promises.readdir */
  readDirectory?: (dir: string) => Promise<fs.Dirent[]>;
  /** 目录间让步(缺省 setImmediate);事件循环心跳由它保证 */
  yieldControl?: () => Promise<void>;
}

const yieldToEventLoop = (): Promise<void> => new Promise<void>(resolve => setImmediate(resolve));

const readDirectoryDefault = (dir: string): Promise<fs.Dirent[]> =>
  fs.promises.readdir(dir, { withFileTypes: true });

/**
 * scanVenvs 的异步版(KODE-RESP-010):目录读走异步 I/O,目录之间让步一次
 * (setImmediate,可注入),事件循环心跳持续运行;总目录/时间预算到顶或取消
 * 令牌置位即停,不再深扫,已发现部分如实返回(不伪造完整)。约定候选
 * (preferredNames)先直接探测——常见 .venv/venv 布局不必等全树走完;走查
 * 与同步版同规则(深度封顶/剪枝名单/环境不下钻),输出排序与同步版一致。
 */
export async function scanVenvsAsync(
  root: string,
  options: VenvScanAsyncOptions = {}
): Promise<DiscoveredVenv[]> {
  const maxDepth = options.maxDepth ?? MAX_VENV_SCAN_DEPTH;
  const pruned = options.prunedDirectoryNames ?? DEFAULT_PRUNED_DIRECTORY_NAMES;
  const platform = options.platform ?? process.platform;
  const maxDirectories = options.maxDirectories ?? MAX_VENV_SCAN_DIRECTORIES;
  const deadline = Date.now() + (options.deadlineMs ?? VENV_SCAN_DEADLINE_MS);
  const readDirectory = options.readDirectory ?? readDirectoryDefault;
  const yieldControl = options.yieldControl ?? yieldToEventLoop;
  const preferredNames = options.preferredNames ?? [];
  const preferredSet = new Set(preferredNames);
  const found: Array<DiscoveredVenv & { preferred: boolean }> = [];
  const claimed = new Set<string>();
  let visited = 0;

  // 预算/取消/时间三重闸:任一触发后不再发生任何后续目录读
  const exhausted = (): boolean =>
    visited >= maxDirectories || options.signal?.aborted === true || Date.now() > deadline;

  const record = (dir: string, name: string, depth: number): void => {
    const interpreterPath = verifyVenvDirectory(dir, platform);
    if (interpreterPath) {
      claimed.add(dir);
      found.push({
        rootPath: dir,
        name,
        interpreterPath,
        envKind: hasEnvMarker(dir) === 'conda' ? 'conda' : 'venv',
        depth,
        preferred: preferredSet.has(name)
      });
    }
  };

  // 优先探测约定候选(单点 stat 验真,不依赖全树走查):.venv/venv 常见布局
  // 在这里直接命中;未命中的名字由后面的走查如实收录。命中即 claimed,走查
  // 不重复验真也不向环境内部下钻(与同步版「环境不下钻」同规则)。
  for (const name of preferredNames) {
    if (exhausted()) {
      break;
    }
    visited += 1;
    await yieldControl();
    const candidate = path.join(root, name);
    if (!claimed.has(candidate)) {
      record(candidate, name, 0);
    }
  }

  const visit = async (dir: string, depth: number): Promise<void> => {
    if (exhausted()) {
      return;
    }
    visited += 1;
    await yieldControl();
    let entries: fs.Dirent[];
    try {
      entries = await readDirectory(dir);
    } catch {
      return; // 不可读目录如实跳过
    }
    for (const entry of entries) {
      if (exhausted()) {
        return;
      }
      if (!entry.isDirectory() || shouldPruneVenvScanDirectory(entry.name, pruned)) {
        continue;
      }
      const child = path.join(dir, entry.name);
      if (!claimed.has(child)) {
        record(child, entry.name, depth);
      }
      if (!claimed.has(child) && depth < maxDepth) {
        await visit(child, depth + 1);
      }
    }
  };

  await visit(root, 0);
  return sortDiscoveredVenvs(found);
}

// ---- 发现缓存层(KODE-RESP-010):按根及配置代缓存 + 在途共享 ----

const VENV_DISCOVERY_CACHE_CAPACITY = 4;
const venvDiscoveryCache = new Map<string, DiscoveredVenv[]>();
const venvDiscoveryInFlight = new Map<string, Promise<DiscoveredVenv[]>>();

/** 缓存键 = 平台 + 根 + 排序后的约定名清单:配置内容进键(按根及配置代
 * 缓存),venvDirectories 改动自然换键重扫;名序不同视为同一配置代 */
export function venvDiscoveryCacheKey(
  root: string,
  preferredNames: readonly string[],
  platform: NodeJS.Platform = process.platform
): string {
  return [platform, root, ...[...preferredNames].sort()].join('|');
}

/** 只读缓存不触发扫描(undefined = 无热值);UI 用它先展示已有候选 */
export function peekVenvDiscoveryCache(
  root: string,
  preferredNames: readonly string[],
  platform: NodeJS.Platform = process.platform
): DiscoveredVenv[] | undefined {
  return venvDiscoveryCache.get(venvDiscoveryCacheKey(root, preferredNames, platform));
}

/** 清空缓存与在途记录(测试隔离用) */
export function clearVenvDiscoveryCache(): void {
  venvDiscoveryCache.clear();
  venvDiscoveryInFlight.clear();
}

/**
 * 带缓存的发现:热值直接返回(UI 先展示已有候选,不再重扫);冷值启动一次
 * 带预算的异步扫描,同键的多个消费者共享同一支在途 Promise(一次在途发现),
 * 收束后写缓存供后续消费。扫描失败不缓存、如实抛出(下次调用可重试)。
 * 首个消费者的 options 负责本次扫描的预算参数;缓存键只认根/约定名/平台。
 */
export function discoverVenvsCached(
  root: string,
  options: VenvScanAsyncOptions = {}
): Promise<DiscoveredVenv[]> {
  const preferredNames = options.preferredNames ?? [];
  const key = venvDiscoveryCacheKey(root, preferredNames, options.platform);
  const cached = venvDiscoveryCache.get(key);
  if (cached) {
    return Promise.resolve(cached);
  }
  const inFlight = venvDiscoveryInFlight.get(key);
  if (inFlight) {
    return inFlight;
  }
  const discovery = scanVenvsAsync(root, options).then(
    envs => {
      venvDiscoveryCache.set(key, envs);
      if (venvDiscoveryCache.size > VENV_DISCOVERY_CACHE_CAPACITY) {
        const oldest = venvDiscoveryCache.keys().next().value;
        if (oldest !== undefined) {
          venvDiscoveryCache.delete(oldest);
        }
      }
      venvDiscoveryInFlight.delete(key);
      return envs;
    },
    error => {
      venvDiscoveryInFlight.delete(key);
      throw error;
    }
  );
  venvDiscoveryInFlight.set(key, discovery);
  return discovery;
}

/**
 * 解析 `python --version` 输出里的版本号:取 "Python x.y.z" 形态,取不到
 * 如实 null(显示面省略版本段,不伪造)。
 */
export function parsePythonVersionOutput(output: string): string | null {
  const match = output.match(/Python\s+(\d+\.\d+\.\d+)/);
  return match ? match[1] : null;
}
