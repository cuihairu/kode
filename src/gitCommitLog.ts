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
import { type GitRunOutcome } from './gitRunner';
import { sharedGitQueryGate, type GitQueryRequest } from './gitQueryGate';

/** 默认每页条数(验收:默认 50)。 */
export const DEFAULT_GIT_LOG_PAGE_SIZE = 50;

/** 每页硬上限(验收:可设硬上限;超过一律钳到 500)。 */
export const MAX_GIT_LOG_PAGE_SIZE = 500;

export interface GitCommitEntry {
  /** 完整提交标识(commit hash)。 */
  hash: string;
  /** 首父提交 hash(%P 首个);根提交为空串。供翻页沿边界续查。 */
  parentHash: string;
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
  /**
   * 该提交时文件所在的仓库相对路径(IDE-GIT-007 沿重命名追踪)。
   * 仅在 follow 查询时给出:重命名前的老路径提交用老路径,重命名后用新路径,
   * 故「打开对应版本内容」须按此路径而非当前路径取 `git show <commit>:<path>`。
   */
  pathAtCommit?: string;
  /**
   * 该提交之后的追踪路径(翻页续查起点):沿重命名链继续的路径。
   * 重命名提交=旧路径(更老提交所在),其余=pathAtCommit(链不变)。
   * 供 `git log --follow <parent> -- <continuationPath>` 续查下一页。
   */
  continuationPath?: string;
}

/** 查询依赖注入面(默认实现经 IDE-GIT-011 协调门,再落 IDE-GIT-003 只读执行器)。 */
export interface GitCommitLogDeps {
  runGit(args: readonly string[], cwd: string, request?: GitQueryRequest): Promise<GitRunOutcome>;
}

export function defaultGitCommitLogDeps(): GitCommitLogDeps {
  return {
    // 同查询合并/并发上限/有界队列/隔离缓存全由协调门承担;token 与显式刷新随 request 传播。
    runGit: (args, cwd, request) =>
      sharedGitQueryGate.run(
        args,
        { cwd, timeoutMs: 10_000, maxOutputBytes: 2_097_152, token: request?.token },
        { bypassCache: request?.bypassCache }
      ),
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
const LOG_FORMAT = ['%H', '%P', '%an', '%ae', '%aI', '%cI', '%s', '%b'].join('%x1f') + '%x1e';

/** 解析 `git log --format` 输出为提交记录(记录间 git 追加的换行剥除)。 */
export function parseCommitRecords(stdout: string): GitCommitEntry[] {
  return stdout
    .split(RECORD_SEP)
    .filter((record) => record.trim() !== '')
    .map((record) => {
      return parseFormatFields(record.replace(/^\n/, ''));
    });
}

export type GitCommitLogResult =
  | {
      kind: 'page';
      status: 'ok';
      entries: GitCommitEntry[];
      hasMore: boolean;
      page: number;
      pageSize: number;
      /**
       * 追踪边界(IDE-GIT-007,仅 follow 查询):最老提交以删除/复制收尾时,
       * --follow 无法继续沿重命名链回溯(文件是被复制/移走而非干净重命名),
       * 如实标注;null = 干净起点(A 新增)或到达仓库起点。
       */
      boundary?: { kind: 'copy-or-move'; atCommit: string; atPath: string } | null;
    }
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
  /**
   * 沿重命名追踪(IDE-GIT-007):加 `--follow --name-status`,重命名前后提交
   * 均入列且每条带 pathAtCommit;缺省 false(IDE-GIT-004 语义不变)。
   */
  follow?: boolean;
  /**
   * 翻页续查起点(IDE-GIT-007 修复):后续页沿上一页最老提交的**父提交**
   * 与该提交时路径继续追踪。`git log --follow --skip=N` 在重命名边界处会
   * 中断(skip 超过边界返回空),不能按当前路径重跑 skip。缺省同 filePath
   * (首页/无重命名)。
   */
  continuation?: {
    /** 上一页最老提交的父提交 hash(从该父提交起继续,不重复/不漏)。 */
    parentCommit: string;
    /** 上一页最老提交时的路径(重命名后为老路径)。 */
    path: string;
  };
}

/**
 * 查询单文件的提交记录分页。
 * 首页空时做一次 ls-files 探测以区分未跟踪/已跟踪无历史;非首页空直接返回
 * 空页(翻页到尽头,不再探测)。
 * follow=true(IDE-GIT-007)时加 `--follow --name-status`:重命名前后提交均入列,
 * 每条带 pathAtCommit,并在最老提交以删除/复制收尾时如实标注 copy-or-move 边界。
 */
export async function queryGitCommitLog(
  options: GitCommitLogQueryOptions,
  deps: GitCommitLogDeps = defaultGitCommitLogDeps(),
  request?: GitQueryRequest
): Promise<GitCommitLogResult> {
  const page = Math.max(0, Math.floor(options.page ?? 0));
  const pageSize = clampGitLogPageSize(options.pageSize);
  // 绝对路径换算为仓库相对路径;越界 `..` 由 IDE-GIT-003 的路径边界校验拒绝。
  const fileArg = path.relative(
    options.repoRoot,
    path.resolve(options.repoRoot, options.continuation?.path ?? options.filePath)
  );
  const args = ['log'];
  if (options.follow && options.continuation) {
    // 续查:从上一页最老提交的父提交起,沿该提交时路径继续 `--follow`
    // (git log --follow --skip=N 在重命名边界会中断,不能按当前路径重跑 skip)。
    args.push(options.continuation.parentCommit);
  } else {
    args.push(`--skip=${page * pageSize}`);
  }
  args.push(`--max-count=${pageSize + 1}`, `--format=${LOG_FORMAT}`);
  if (options.follow) {
    args.push('--follow', '--name-status');
  }
  args.push('--', fileArg);
  const outcome = await deps.runGit(args, options.repoRoot, request);
  if (outcome.kind !== 'ok') {
    if (outcome.kind === 'exit' && outcome.exitCode === 128 && outcome.stderr.includes('does not have any commits')) {
      return { kind: 'no-commits' };
    }
    return { kind: 'git-error', outcome };
  }

  let entries: GitCommitEntry[];
  let boundary: { kind: 'copy-or-move'; atCommit: string; atPath: string } | null = null;
  let hasMore: boolean;
  if (options.follow) {
    // --name-status 输出与格式记录交错(`\x1e` 后 git 追加换行再打印状态行),
    // 必须整体一并解析,不能复用 parseCommitRecords(会把状态行误当记录)。
    const traced = parseFollowCommitRecords(
      options.continuation
        ? path.relative(options.repoRoot, path.resolve(options.repoRoot, options.continuation.path))
        : fileArg,
      outcome.stdout
    );
    entries = traced.entries;
    hasMore = entries.length > pageSize;
    // 边界只在本页到头(无下一页)时才如实上报:hasMore 时最老记录是探测位,
    // 真正的边界在更深的页,不提前断言。
    boundary = hasMore ? null : traced.boundary;
  } else {
    entries = parseCommitRecords(outcome.stdout);
    hasMore = entries.length > pageSize;
  }
  if (page === 0 && entries.length === 0) {
    // 首页空:区分「未跟踪」(index/HEAD 都没有)与「已跟踪但尚无提交历史」
    const probe = await deps.runGit(['ls-files', '--', fileArg], options.repoRoot, request);
    const tracked = probe.kind === 'ok' && probe.stdout.trim() !== '';
    return tracked ? { kind: 'no-history' } : { kind: 'untracked' };
  }

  return {
    kind: 'page',
    status: 'ok',
    entries: entries.slice(0, pageSize),
    hasMore,
    page,
    pageSize,
    boundary,
  };
}

/** `--name-status` 状态行(仅 follow 用;`R<score>`/`C<score>` 双路径)。 */

/** `--name-status` 状态行(仅 follow 用;`R<score>`/`C<score>` 双路径)。 */
interface FollowStatus {
  kind: 'M' | 'A' | 'D' | 'R' | 'C';
  oldPath?: string;
  newPath?: string;
}

function parseFollowStatus(line: string): FollowStatus | null {
  const m = /^([MADRC])(\d*)\t(.+)$/.exec(line);
  if (!m) return null;
  const kind = m[1] as FollowStatus['kind'];
  const parts = m[3].split('\t');
  if ((kind === 'R' || kind === 'C') && parts.length >= 2) {
    return { kind, oldPath: parts[0], newPath: parts[1] };
  }
  return { kind, newPath: parts[0] };
}

/** 把一条 `--format` 记录片(FS 分隔)解析为提交记录。 */
function parseFormatFields(fmt: string): GitCommitEntry {
  const fields = fmt.split(FIELD_SEP);
  return {
    hash: fields[0] ?? '',
    parentHash: (fields[1] ?? '').split(' ')[0] ?? '',
    authorName: fields[2] ?? '',
    authorEmail: fields[3] ?? '',
    authorDate: fields[4] ?? '',
    commitDate: fields[5] ?? '',
    subject: fields[6] ?? '',
    body: (fields[7] ?? '').replace(/\n$/, ''),
  };
}

/**
 * 从 `git log --follow --name-status` 输出一并解析记录与状态行,为每条记录
 * 恢复该提交时的文件路径(重命名链:新→旧,遇 R/C 把追踪路径切回 old),并
 * 在最老提交以删除/复制收尾时给出 copy-or-move 边界(--follow 无法沿非重命名
 * 链继续回溯,如实标注,绝不假装继续)。
 *
 * 输出记录与状态行交错:`<format>\x1e\n<状态行>\n<format>\x1e\n...`。按 `\x1e`
 * 分片:片 0 为纯记录,片 i>=1 以空行+状态行开头、随后接下一条记录。不能复用
 * parseCommitRecords(它会把状态行误当记录,产生幽灵条目)。
 */
export function parseFollowCommitRecords(
  initialPath: string,
  stdout: string
): { entries: GitCommitEntry[]; boundary: { kind: 'copy-or-move'; atCommit: string; atPath: string } | null } {
  const parts = stdout.split(RECORD_SEP);
  const records: GitCommitEntry[] = [];
  const statuses: FollowStatus[] = [];
  // 片 0 = 第一条记录(无状态前缀);片 i>=1 = 空行 + 状态行 + "\n" + 下一条记录。
  const firstPart = parts[0] ?? '';
  if (firstPart.trim() !== '') {
    records.push(parseFormatFields(firstPart));
  }
  for (let i = 1; i < parts.length; i += 1) {
    const lines = parts[i].split('\n');
    let idx = 0;
    while (idx < lines.length && lines[idx].trim() === '') idx += 1;
    // 状态行:每条记录恰一条 follow 状态;缺省按无状态处理(防御)。
    const first = parseFollowStatus(lines[idx] ?? '');
    if (first) statuses.push(first);
    // 剩余行(可能含正文换行)拼回格式记录,前导换行剥除。
    const rest = lines.slice(idx + (first ? 1 : 0)).join('\n').replace(/^\n/, '');
    if (rest.trim() !== '') {
      records.push(parseFormatFields(rest));
    }
  }
  // 状态行数应等于记录数;逐条按重命名链换算 pathAtCommit。
  let tracked = initialPath;
  const traced = records.map((entry, index) => {
    const status = statuses[index];
    if (status && (status.kind === 'R' || status.kind === 'C')) {
      // 重命名提交:该提交树上路径 = new;更老提交追踪 old。
      const atCommitPath = status.newPath ?? tracked;
      const nextPath = status.oldPath ?? tracked;
      if (status.oldPath) tracked = status.oldPath;
      return { ...entry, pathAtCommit: atCommitPath, continuationPath: nextPath };
    }
    return { ...entry, pathAtCommit: tracked, continuationPath: tracked };
  });
  const last = statuses[statuses.length - 1];
  const boundary =
    last && (last.kind === 'D' || last.kind === 'C') && traced.length > 0
      ? {
          kind: 'copy-or-move' as const,
          atCommit: traced[traced.length - 1].hash,
          atPath: last.oldPath ?? last.newPath ?? tracked,
        }
      : null;
  return { entries: traced, boundary };
}
