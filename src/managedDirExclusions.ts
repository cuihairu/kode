/**
 * KODE-CFG-017 隔离面：让 `.kbengine` 自管目录不污染用户搜索 / 资源管理器 /
 * git。纯逻辑层，不 import vscode；装配层在 extension.ts。
 *
 * 三条纪律（与 pythonExtraPaths / jsoncAssociation 同款）：
 * - 「只管理自己那一段」：search.exclude / files.watcherExclude 只增删 kode
 *   上次写入的段（记 workspaceState），用户手填条目永不被动；
 * - .gitignore 只在「git 仓 + 文件已存在」时幂等追加，**绝不创建**（SVN /
 *   无 VCS 场景不写任何 git 专属物）；
 * - 全部 additive / idempotent / 可回退，按 `managedDir` 设置值而非硬编码。
 */

export interface ManagedDirExclusionsDeps {
  /** 读文本文件；不存在返回 null（.gitignore 探测） */
  readText?: (path: string) => string | null;
  /** 写文本文件（仅 git 仓 + .gitignore 已存在时调用） */
  writeText?: (path: string, content: string) => void;
  /** 向上找 `.git` 目录，命中返回仓根，否则 null */
  findGitRoot?: (startDir: string) => string | null;
  /** 向上找 `.svn` 目录，命中返回仓根，否则 null */
  findSvnRoot?: (startDir: string) => string | null;
  /** git 仓根的 .gitignore 绝对路径（默认 <root>/.gitignore） */
  gitignorePath?: (gitRoot: string) => string;
}

/** 排除键形态：`<managedDir>/**`（工作区根相对 glob，VS Code 语义） */
export function exclusionKeyFor(managedDir: string): string {
  const dir = managedDir.replace(/^\/+|\/+$/g, '');
  return `${dir}/**`;
}

/** gitignore 追加行：`<managedDir>/`（带尾斜杠 = 只忽略目录形态） */
export function gitignoreLineFor(managedDir: string): string {
  const dir = managedDir.replace(/^\/+|\/+$/g, '');
  return `${dir}/`;
}

/** kode 管理段的标记注释（ASCII 稳定，便于日后精确移除自己段） */
export const GITIGNORE_MARKER = '# kode managed dir (auto-generated)';

/**
 * 判定 gitignore 内容是否已忽略该目录。
 * 命中条件：某行（去空白）等于 `dir` / `dir/` / `/dir` / `/dir/`，或以
 * `dir/` 开头。只认目录形态，不把用户手写的通配 glob（如任意层级的目录
 * 匹配）当命中——保守：宁可重复追加一条 kode 段，也不误判用户已有规则
 * 为「已忽略」（重复追加由内容比对去重兜底，不炸）。用户手写条目永不被删。
 */
export function gitignoreIgnores(content: string, managedDir: string): boolean {
  const dir = managedDir.replace(/^\/+|\/+$/g, '');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '') {
      continue;
    }
    if (line === dir || line === `${dir}/` || line === `/${dir}` || line === `/${dir}/`) {
      return true;
    }
    if (line.startsWith(`${dir}/`)) {
      return true;
    }
  }
  return false;
}

export type GitignorePlan =
  | { action: 'none'; line: string }
  | { action: 'append'; line: string; marker: string; nextContent: string };

/**
 * gitignore 增补计划（纯函数）：只决定「内容该怎么变」，是否写盘由调用方
 * 依「git 仓 + .gitignore 存在」决定——本函数绝不创建文件。
 * 幂等：已忽略则 none；已含 kode 段（marker + 本目录行）也 none。
 */
export function planGitignoreAdd(content: string, managedDir: string): GitignorePlan {
  const line = gitignoreLineFor(managedDir);
  if (gitignoreIgnores(content, managedDir)) {
    return { action: 'none', line };
  }
  // 已含 kode 段（marker + 该目录行相邻）→ 不动（防重复段）
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim() === GITIGNORE_MARKER && i + 1 < lines.length && lines[i + 1].trim() === line) {
      return { action: 'none', line };
    }
  }
  const trimmed = content.replace(/\s+$/, '');
  const nextContent = trimmed === '' ? `${GITIGNORE_MARKER}\n${line}\n` : `${trimmed}\n${GITIGNORE_MARKER}\n${line}\n`;
  return { action: 'append', line, marker: GITIGNORE_MARKER, nextContent };
}

export type VcsKind = 'git' | 'svn' | 'none';

/** VCS 探测（纯函数化判定入口）：git 优先，其次 svn，都不在返回 none */
export function detectVcs(deps: ManagedDirExclusionsDeps, startDir: string): { kind: VcsKind; root: string | null } {
  const gitRoot = deps.findGitRoot?.(startDir) ?? null;
  if (gitRoot) {
    return { kind: 'git', root: gitRoot };
  }
  const svnRoot = deps.findSvnRoot?.(startDir) ?? null;
  if (svnRoot) {
    return { kind: 'svn', root: svnRoot };
  }
  return { kind: 'none', root: null };
}

export interface ExclusionPlan {
  /** 该写回的值（用户段在前 + kode 当前段） */
  next: Record<string, unknown>;
  /** 与现值不同才需要写 */
  changed: boolean;
  /** 本次 kode 管理的键（供 workspaceState 下次差量） */
  managedKeys: string[];
}

/**
 * search.exclude / files.watcherExclude 的计划（「只管理自己那一段」）：
 * 先把上次 kode 写的键全部剔掉（用户手填永不动），再加当前 enabled 的键。
 * current 值形态不由本扩展控制：非对象按空处理，不炸。
 */
export function planExclusion(
  current: unknown,
  managedDir: string,
  previouslyManaged: readonly string[],
  enabled: boolean
): ExclusionPlan {
  const currentMap = current != null && typeof current === 'object' && !Array.isArray(current)
    ? (current as Record<string, unknown>)
    : {};
  const userEntries: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(currentMap)) {
    if (!previouslyManaged.includes(key)) {
      userEntries[key] = value;
    }
  }
  const managedKeys = enabled ? [exclusionKeyFor(managedDir)] : [];
  const next: Record<string, unknown> = { ...userEntries };
  for (const key of managedKeys) {
    next[key] = true;
  }
  const changed =
    Object.keys(next).length !== Object.keys(currentMap).length ||
    Object.keys(next).some((key) => next[key] !== currentMap[key]);
  return { next, changed, managedKeys };
}
