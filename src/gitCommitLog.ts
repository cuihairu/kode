/**
 * IDE-GIT-004:查询单文件的分页提交记录。
 * 用户约束(2026-10-29):默认开启、按需查询——本查询只在用户打开历史面板时
 * 发起(调用面门控),绝不预取/轮询。语义:
 * - 分页:`--skip=page*pageSize --max-count=pageSize+1`,多取 1 条探测 hasMore,
 *   不多跑一趟;每次调用都有界,绝不无界加载全部日志;页序锚定在查询时刻的
 *   HEAD(此后新增提交会使翻页位移,如实说明,不假装全局一致)。
 * - 稳定顺序:默认 reverse-chronological(新→旧),跨页合并不重复不漏项。
 * - 输出:提交标识 %H、作者身份 %an/%ae、作者时间 %aI、提交时间 %cI、主题 %s
 *   与正文 %b,以字段分隔 %x1f / 记录分隔 %x1e 组装(正文可含换行/中文,
 *   逐字往返);首屏只取元数据,不预读任何 diff/文件内容。
 * - 状态:首页空时区分「未跟踪」(ls-files 亦空)与「已跟踪但无提交历史」;
 *   空仓库(尚无任何提交)报 no-commits;其它 git 失败原样透传给调用面映射。
 * 纯函数(执行器经 deps.runGit 注入,默认实现走 IDE-GIT-003 的只读执行器)。
 */

import * as path from 'path';
import { runGitReadOnly, type GitRunOutcome } from './gitRunner';

/** 默认每页条数(验收:默认 50)。 */
export const DEFAULT_GIT_LOG_PAGE_SIZE = 50;

/** 每页硬上限(验收:可设硬上限;超过一律钳到 500)。 */
export const MAX_GIT_LOG_PAGE_SIZE = 500;

export interface GitCommitEntry {
  /** 完整提交标识(commit hash)。 */
  hash: string;
  authorName: string;
  authorEmail: string;
  /** 作者时间(ISO 8601,含时区;%aI)。 */
  authorDate: string;
  /** 提交时间(ISO 8601,含时区;%cI)。 */
  commitDate: string;
  /** 提交说明主题(首行)。 */
  subject: string;
  /** 提交说明正文(不含主题;可多行/中文)。 */
  body: string;
}

/** 查询依赖注入面(默认实现经 IDE-GIT-003 只读执行器运行)。 */
export interface GitCommitLogDeps {
  runGit(args: readonly string[], cwd: string): Promise<GitRunOutcome>;
}

export function defaultGitCommitLogDeps(): GitCommitLogDeps {
  return {
    runGit: (args, cwd) =>
      runGitReadOnly(args, { cwd, timeoutMs: 10_000, maxOutputBytes: 2_097_152 }),
  };
}

/** 钳制每页条数:非正/非数回默认 50,超过 500 回 500。 */
export function clampGitLogPageSize(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested) || requested < 1) {
    return DEFAULT_GIT_LOG_PAGE_SIZE;
  }
  return Math.min(Math.floor(requested), MAX_GIT_LOG_PAGE_SIZE);
}

// 字段以 %x1f、记录以 %x1e 分隔(正文可含换行,故不用行分隔)。
const FIELD_SEP = '\u001f';
const RECORD_SEP = '\u001e';
const LOG_FORMAT = ['%H', '%an', '%ae', '%aI', '%cI', '%s', '%b'].join('%x1f') + '%x1e';

/** 解析 `git log --format` 输出为提交记录(记录间 git 追加的换行剥除)。 */
export function parseCommitRecords(stdout: string): GitCommitEntry[] {
  return stdout
    .split(RECORD_SEP)
    .filter((record) => record.trim() !== '')
    .map((record) => {
      const fields = record.replace(/^\n/, '').split(FIELD_SEP);
      return {
        hash: fields[0] ?? '',
        authorName: fields[1] ?? '',
        authorEmail: fields[2] ?? '',
        authorDate: fields[3] ?? '',
        commitDate: fields[4] ?? '',
        subject: fields[5] ?? '',
        body: (fields[6] ?? '').replace(/\n$/, ''),
      };
    });
}

export type GitCommitLogResult =
  | { kind: 'page'; status: 'ok'; entries: GitCommitEntry[]; hasMore: boolean; page: number; pageSize: number }
  | { kind: 'no-commits' }
  | { kind: 'no-history' }
  | { kind: 'untracked' }
  | { kind: 'git-error'; outcome: GitRunOutcome };

export interface GitCommitLogQueryOptions {
  /** 仓库根(cwd 基准;来自 IDE-GIT-002 定位)。 */
  repoRoot: string;
  /** 目标文件:绝对(须在 repoRoot 内)或仓库相对路径;一律换算为相对再传 `--`。 */
  filePath: string;
  /** 页号(0 基;缺省 0)。 */
  page?: number;
  /** 每页条数(缺省 50;钳到 [1,500])。 */
  pageSize?: number;
}

/**
 * 查询单文件的提交记录分页。
 * 首页空时做一次 ls-files 探测以区分未跟踪/已跟踪无历史;非首页空直接返回
 * 空页(翻页到尽头,不再探测)。
 */
export async function queryGitCommitLog(
  options: GitCommitLogQueryOptions,
  deps: GitCommitLogDeps = defaultGitCommitLogDeps()
): Promise<GitCommitLogResult> {
  const page = Math.max(0, Math.floor(options.page ?? 0));
  const pageSize = clampGitLogPageSize(options.pageSize);
  // 绝对路径换算为仓库相对路径;越界 `..` 由 IDE-GIT-003 的路径边界校验拒绝。
  const fileArg = path.relative(options.repoRoot, path.resolve(options.repoRoot, options.filePath));
  const args = [
    'log',
    `--skip=${page * pageSize}`,
    `--max-count=${pageSize + 1}`,
    `--format=${LOG_FORMAT}`,
    '--',
    fileArg,
  ];
  const outcome = await deps.runGit(args, options.repoRoot);
  if (outcome.kind !== 'ok') {
    if (outcome.kind === 'exit' && outcome.exitCode === 128 && outcome.stderr.includes('does not have any commits')) {
      return { kind: 'no-commits' };
    }
    return { kind: 'git-error', outcome };
  }

  const entries = parseCommitRecords(outcome.stdout);
  const hasMore = entries.length > pageSize;
  if (page === 0 && entries.length === 0) {
    // 首页空:区分「未跟踪」(index/HEAD 都没有)与「已跟踪但尚无提交历史」
    const probe = await deps.runGit(['ls-files', '--', fileArg], options.repoRoot);
    const tracked = probe.kind === 'ok' && probe.stdout.trim() !== '';
    return tracked ? { kind: 'no-history' } : { kind: 'untracked' };
  }

  return { kind: 'page', status: 'ok', entries: entries.slice(0, pageSize), hasMore, page, pageSize };
}
