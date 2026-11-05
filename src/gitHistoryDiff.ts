/**
 * IDE-GIT-006:打开历史版本并比较对应修改。
 * 点击侧边栏提交记录在主编辑区打开该版本与父版本的只读 diff,并提供只读
 * 打开该版本内容的操作。核心约束(验收):
 * - **不覆盖工作区文件**:diff 两侧与内容打开一律走虚拟文档(kode-git-version
 *   scheme 的 TextDocumentContentProvider),绝不写盘、绝不以真实文件 URI 打开。
 * - **虚拟文档按仓库/提交/路径隔离**:URI 同时编码 repoRoot + commit + filePath,
 *   提供者按单个 URI 解码后独立取内容,不同仓库/提交/路径互不串味。
 * - **根提交/删除文件/无内容版本明确处理**:父提交缺失(根提交或首提交)左
 *   侧为空;路径在该提交不存在(删除/未创建)右侧为空;两者皆空=无内容版本。
 *
 * 查询面统一走 IDE-GIT-003 有界只读执行器(`git show <commit>:<path>` 取
 * 内容、`git rev-list --parents -n1 <commit>` 判根提交),绝不无界读、绝不
 * 打开真实工作区文件。
 */

import * as path from 'path';
import * as vscode from 'vscode';
import {
  type GitRunOptions,
  type GitRunOutcome,
} from './gitRunner';
import { sharedGitQueryGate, type GitQueryRequest } from './gitQueryGate';

/** 虚拟文档 scheme:内容一律只读(仅提供者,无编辑能力)。 */
export const GIT_HISTORY_VERSION_SCHEME = 'kode-git-version';

/** 内容查询依赖注入面(纯函数可测;默认经 IDE-GIT-011 协调门再落执行器)。 */
export interface VersionQueryDeps {
  /** 跑一条只读 Git(默认经 IDE-GIT-011 协调门 → IDE-GIT-003 runGitReadOnly)。 */
  runGit(args: readonly string[], options: GitRunOptions, request?: GitQueryRequest): Promise<GitRunOutcome>;
  /** 超时(默认 10s;内容有界)。 */
  timeoutMs: number;
  /** 单流输出上限(默认 2MiB;内容有界)。 */
  maxOutputBytes: number;
}

export function defaultVersionQueryDeps(deps?: Partial<VersionQueryDeps>): VersionQueryDeps {
  return {
    // 提交内容(git show)经协调门缓存:同 (repo,commit,path) 复用,条目/字节有界。
    runGit: (args, options, request) =>
      sharedGitQueryGate.run(
        args,
        { ...options, token: request?.token },
        { bypassCache: request?.bypassCache }
      ),
    timeoutMs: 10_000,
    maxOutputBytes: 2 * 1024 * 1024,
    ...deps,
  };
}

/**
 * 把文件绝对路径换算为仓库相对路径(内容查询用 `<commit>:<relPath>`)。
 * 路径必须在 repoRoot 内(防御:逃逸即拒绝),以 `/` 分隔供 git 使用。
 */
export function relativeVersionPath(repoRoot: string, filePath: string): string | null {
  const abs = path.resolve(filePath);
  const root = path.resolve(repoRoot);
  if (abs === root) return '';
  if (!abs.startsWith(root + path.sep)) return null;
  const rel = path.relative(root, abs);
  // 反斜杠/父段(逃逸)拒绝;git 用 `/` 分隔
  if (rel.includes('..') || rel.includes('\\')) return null;
  return rel.split(path.sep).join('/');
}

/** 构造虚拟文档 URI(编码 repoRoot + commit + filePath,三键隔离)。 */
export function makeVersionUri(repoRoot: string, commit: string, filePath: string): vscode.Uri {
  return vscode.Uri.from({
    scheme: GIT_HISTORY_VERSION_SCHEME,
    path: path.resolve(filePath),
    query: `repo=${encodeURIComponent(repoRoot)}&commit=${encodeURIComponent(commit)}`,
  });
}

/** 解码虚拟文档 URI 的三键(仓库/提交/路径)。 */
export function decodeVersionUri(uri: vscode.Uri): { repoRoot: string; commit: string; filePath: string } {
  const query = new URLSearchParams(uri.query);
  const repoRoot = query.get('repo') ?? '';
  const commit = query.get('commit') ?? '';
  const filePath = uri.path;
  return { repoRoot, commit, filePath };
}

/** 内容查询结果:内容 / 该提交无此路径(删除或未创建,右侧空) / 失败。 */
export type VersionContentResult =
  | { kind: 'content'; content: string }
  | { kind: 'missing' }
  | { kind: 'error'; message: string };

/** 取 `<commit>:<path>` 版本内容(有界执行;路径缺失报 missing)。 */
export async function queryVersionContent(
  repoRoot: string,
  commit: string,
  filePath: string,
  deps: VersionQueryDeps,
  request?: GitQueryRequest
): Promise<VersionContentResult> {
  const rel = relativeVersionPath(repoRoot, filePath);
  if (rel === null) {
    return { kind: 'error', message: '文件不在该仓库内,无法读取版本内容' };
  }
  // 空提交哨兵(根提交的父侧/无父版本):整侧视为空,不查 Git。
  if (commit === 'EMPTY' || commit === '') {
    return { kind: 'missing' };
  }
  const outcome = await deps.runGit(
    ['show', `${commit}:${rel}`],
    { cwd: repoRoot, timeoutMs: deps.timeoutMs, maxOutputBytes: deps.maxOutputBytes },
    request
  );
  if (outcome.kind === 'ok') {
    return { kind: 'content', content: outcome.stdout };
  }
  if (outcome.kind === 'exit' && /does not exist|exists on disk|no such path/i.test(outcome.stderr)) {
    return { kind: 'missing' };
  }
  return { kind: 'error', message: summarizeVersionError(outcome) };
}

/** 判父提交:根提交(无父)返回 null,否则首父哈希。 */
export async function getParentCommit(
  repoRoot: string,
  commit: string,
  deps: VersionQueryDeps,
  request?: GitQueryRequest
): Promise<string | null> {
  const outcome = await deps.runGit(
    ['rev-list', '--parents', '-n1', commit],
    { cwd: repoRoot, timeoutMs: deps.timeoutMs, maxOutputBytes: 4096 },
    request
  );
  if (outcome.kind !== 'ok') return null; // 无法判定按无父处理(左侧空)
  const tokens = outcome.stdout.trim().split(/\s+/);
  if (tokens.length < 2) return null; // 根提交
  return tokens[1] ?? null;
}

/** git 失败摘要(复用 IDE-GIT-005 风格:结构化结果 → 一行文案)。 */
export function summarizeVersionError(outcome: GitRunOutcome): string {
  if (outcome.kind === 'exit' && outcome.stderr) return outcome.stderr.trim().split('\n')[0] || 'git 非零退出';
  if (outcome.kind === 'spawn') return outcome.message ?? 'git 进程启动失败';
  if (outcome.kind === 'timeout') return '读取版本超时(有界执行已终止)';
  if (outcome.kind === 'cancelled') return '读取已取消';
  if (outcome.kind === 'output-limit') return '版本内容超限(有界执行已终止)';
  if (outcome.kind === 'invalid-args') return `参数被拒:${outcome.reason ?? ''}`;
  return '未知错误';
}

/**
 * 虚拟文档内容提供者(kode-git-version):按 URI 三键解码,独立取该版本内容。
 * 缺失路径返回空串(删除侧/根提交父侧),读取失败抛错(用户可见)。
 */
export class GitHistoryVersionContentProvider implements vscode.TextDocumentContentProvider {
  constructor(private readonly deps: VersionQueryDeps) {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const { repoRoot, commit, filePath } = decodeVersionUri(uri);
    const result = await queryVersionContent(repoRoot, commit, filePath, this.deps);
    if (result.kind === 'content') return result.content;
    if (result.kind === 'missing') return '';
    throw new Error(`无法读取 ${commit} 版本:${result.message}`);
  }
}

/**
 * 打开提交版本 vs 父版本的只读 diff(两侧均虚拟文档,绝不覆盖工作区文件)。
 * 根提交父侧为空(整文件呈现为新增);本提交删除文件右列为空。
 * parentFilePath(IDE-GIT-007):父提交时文件所在路径——重命名提交的父侧在
 * 老路径,缺省同 filePath(非重命名提交两侧同路径)。
 */
export async function openVersionDiff(
  filePath: string,
  repoRoot: string,
  commit: string,
  deps: VersionQueryDeps,
  parentFilePath?: string
): Promise<void> {
  const parent = await getParentCommit(repoRoot, commit, deps);
  const left = makeVersionUri(repoRoot, parent ?? 'EMPTY', parentFilePath ?? filePath);
  const right = makeVersionUri(repoRoot, commit, filePath);
  const label = `${path.basename(filePath)} @ ${commit.slice(0, 8)}`;
  await vscode.commands.executeCommand(
    'vscode.diff',
    left,
    right,
    `${label}（本提交 vs 父版本）`
  );
}

/** 只读打开该版本内容(虚拟文档,无编辑能力,不落盘)。 */
export async function openVersionContent(
  filePath: string,
  repoRoot: string,
  commit: string
): Promise<void> {
  const uri = makeVersionUri(repoRoot, commit, filePath);
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc, { preview: false });
}
