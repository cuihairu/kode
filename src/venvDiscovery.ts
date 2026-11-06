/**
 * venv 自动发现(PY-ENV 二期):扫描工作区(及其子目录,深度封顶)下的
 * 虚拟环境。认环境只认证据——venv 以 pyvenv.cfg 文件为证、conda 环境以
 * conda-meta/ 目录为证,并且解释器二进制(bin/python 或 Windows 的
 * Scripts/python.exe)真实在盘才收录;损坏环境(有标记没二进制/有二进制
 * 没标记)一律不认,绝不伪造。扫描面与 pythonScanRules(Python 源码类索
 * 引)完全解耦:不共享候选清单、不共享剪枝规则、互不 import。全部只做
 * 存在性探测,不执行任何程序。
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
          preferred: false
        });
        continue; // 不向环境内部下钻
      }
      if (depth < maxDepth) {
        visit(child, depth + 1);
      }
    }
  };

  visit(root, 0);
  const preferredSet = new Set(options.preferredNames ?? []);
  for (const env of found) {
    env.preferred = preferredSet.has(env.name);
  }
  return found
    .sort(
      (a, b) =>
        a.depth - b.depth ||
        Number(b.preferred) - Number(a.preferred) ||
        a.name.localeCompare(b.name)
    )
    .map(({ preferred: _preferred, ...env }) => env);
}

/**
 * 解析 `python --version` 输出里的版本号:取 "Python x.y.z" 形态,取不到
 * 如实 null(显示面省略版本段,不伪造)。
 */
export function parsePythonVersionOutput(output: string): string | null {
  const match = output.match(/Python\s+(\d+\.\d+\.\d+)/);
  return match ? match[1] : null;
}
