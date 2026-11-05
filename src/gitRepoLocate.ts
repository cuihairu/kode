/**
 * IDE-GIT-002:按文件定位所属 Git 仓库。
 * 用户约束(2026-10-29):默认开启、按需查询——定位只发生在启用后的请求中,
 * 绝不在激活/打开文件/光标/选区变化时自动跑。本模块是纯函数(依赖注入),
 * 不接 git 子进程(可执行性探测另由调用面注入)、不接 vscode API,只在被
 * 启用门控的调用面进入(`enabled` 参数关闭即不探测、不读写)。
 *
 * 语义:
 * - 多工作区:取包含该文件的最长根(最长前缀),只在该根内向上找,绝不越过
 *   工作区根(防吃根之外的无关仓库)。
 * - 嵌套仓库:最近命中优先(内层 `.git` 先于外层)。
 * - worktree/子模块:`.git` 是文件(gitdir 指针);gitDir 含 `commondir` 判定
 *   worktree(工作树独立 HEAD),否则为子模块/普通仓库。repoRoot 均为工作树根。
 * - 非 Git 文件/文件在工作区外:返回结构化原因,配 `describeGitRepoLocation`
 *   产出明确反馈。
 */

import * as path from 'path';
import * as fs from 'fs';

/** 定位依赖注入面(纯函数可测,不落 vscode/fs 实面)。 */
export interface GitRepoLocationDeps {
  /** 探测 <dir> 下是否含 `.git` 及形态:目录 | 文件(gitdir 指针) | 无。 */
  probeGitMarker(dir: string): 'dir' | 'file' | null;
  /** 读 `.git` 文件内容(worktree/子模块的 gitdir 指针)。 */
  readGitFile(absPath: string): string | null;
  /** 判定路径是否为目录(用于 gitDir/commondir 存在性)。 */
  isDirectory(absPath: string): boolean;
}

/** 定位结果:命中仓库,或结构化失败原因。 */
export type GitRepoLocation =
  | { kind: 'repo'; repoRoot: string; gitDir: string; isWorktree: boolean }
  | { kind: 'none'; reason: 'disabled' | 'no-workspace' | 'outside-repo' };

/** 解析 `.git` 文件里的 `gitdir: <path>` 指针(相对 .git 文件所在目录解析)。 */
function resolveGitDirFile(gitFilePath: string, deps: GitRepoLocationDeps): string | null {
  const content = deps.readGitFile(gitFilePath);
  if (!content) return null;
  const m = /^gitdir:\s*(.+)$/m.exec(content);
  if (!m) return null;
  return path.resolve(path.dirname(gitFilePath), m[1].trim());
}

/**
 * 按文件定位所属 Git 仓库。
 * @param enabled 功能开关——关闭即返回 disabled 且不探测(只在启用后的请求中定位)。
 * @returns 命中仓库(含 worktree 标记)或结构化失败原因。
 */
export function locateGitRepository(
  filePath: string,
  workspaceRoots: readonly string[],
  enabled: boolean,
  deps: GitRepoLocationDeps
): GitRepoLocation {
  if (!enabled) {
    return { kind: 'none', reason: 'disabled' };
  }

  // 多工作区:取包含该文件的最长根(最长前缀);无 → no-workspace
  const root = workspaceRoots
    .filter((w) => filePath === w || filePath.startsWith(w + path.sep))
    .sort((a, b) => b.length - a.length)[0];
  if (!root) {
    return { kind: 'none', reason: 'no-workspace' };
  }

  // 从文件所在目录向上到工作区根(含),最近命中优先,绝不越过根
  let dir = path.dirname(filePath);
  for (;;) {
    const marker = deps.probeGitMarker(dir);
    if (marker === 'dir') {
      return { kind: 'repo', repoRoot: dir, gitDir: path.join(dir, '.git'), isWorktree: false };
    }
    if (marker === 'file') {
      const gitFile = path.join(dir, '.git');
      const gitDir = resolveGitDirFile(gitFile, deps) ?? gitFile;
      const isWorktree = deps.isDirectory(path.join(gitDir, 'commondir'));
      return { kind: 'repo', repoRoot: dir, gitDir, isWorktree };
    }
    if (dir === root) {
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }

  return { kind: 'none', reason: 'outside-repo' };
}

/** 真实 fs 依赖面(探针/读指针/判目录),供调用面装配定位。 */
export function realGitRepoLocationDeps(): GitRepoLocationDeps {
  return {
    probeGitMarker(dir: string): 'dir' | 'file' | null {
      const marker = path.join(dir, '.git');
      let stat: fs.Stats | undefined;
      try {
        stat = fs.statSync(marker);
      } catch {
        return null;
      }
      if (stat.isDirectory()) return 'dir';
      if (stat.isFile()) return 'file';
      return null;
    },
    readGitFile(absPath: string): string | null {
      try {
        return fs.readFileSync(absPath, 'utf8');
      } catch {
        return null;
      }
    },
    isDirectory(absPath: string): boolean {
      try {
        return fs.statSync(absPath).isDirectory();
      } catch {
        return false;
      }
    },
  };
}

/** 定位失败/命中的明确反馈文案(供命令/视图呈现)。 */
export function describeGitRepoLocation(result: GitRepoLocation): string {
  if (result.kind === 'repo') {
    return `已定位 Git 仓库:${result.repoRoot}${result.isWorktree ? '（worktree）' : ''}`;
  }
  switch (result.reason) {
    case 'outside-repo':
      return '文件不在任何 Git 仓库内（该工作区无 .git 标记）';
    case 'no-workspace':
      return '文件不属于任何已打开的工作区';
    case 'disabled':
      return '文件历史功能已关闭';
  }
}

/** Git 不可用时的可操作提示(引导安装/配置 PATH)。 */
export function describeGitUnavailable(): string {
  return '未检测到 Git 可执行文件（git --version 失败）：请安装 Git，或将其加入 PATH 后重试';
}
