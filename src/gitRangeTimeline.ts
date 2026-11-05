/**
 * IDE-GIT-009:查询选区对应历史行段的逐提交修改时间线。
 * 用户约束(2026-10-29):默认开启、按需查询——本模块只在用户显式发起查询时
 * 运行(调用面门控),绝不预取/轮询。语义:
 * - 经一次 `git log -L <start>,<end>:<rel>`(有界只读执行器)追踪该 HEAD 行段的
 *   逐提交修改:插到行段之前的行不会遮蔽先前修改(-L 随行段移动自动补偿偏移,
 *   故「前置插行后仍能找到之前修改」天然成立);列出每次修改的作者与时间。
 * - 边界如实标注:`-L` 沿重命名追踪(重命名前的提交路径按老路径记入 entry.path),
 *   末段 diff 只含新增(行段引入点,文件创建或行新增)→ origin;否则(合并解析/
 *   复制/无法继续)→ stopped,并给出止点提交与路径,绝不以当前 blame 结果冒充
 *   完整历史。
 * - 输入的 startLine/endLine 是 HEAD 行号(IDE-GIT-008 映射结果),非工作区行号。
 * 纯函数(执行器经 deps.runGit 注入,默认实现走 IDE-GIT-003 的只读执行器)。
 */

import { type GitRunOutcome } from './gitRunner';
import { summarizeGitError } from './gitHistoryTree';
import { relativeVersionPath } from './gitHistoryDiff';
import { sharedGitQueryGate, type GitQueryRequest } from './gitQueryGate';

/** 一次修改记录(-L 追踪到的、改动过该行段的提交)。 */
export interface RangeChangeEntry {
  hash: string;
  authorName: string;
  authorEmail: string;
  authorDate: string;
  commitDate: string;
  subject: string;
  /** 该提交中文件路径(-L 沿重命名追踪;重命名前为老路径)。 */
  path: string;
  /** 该行段在该提交版本中的位置(1 基、含端点;由 `-L` diff 的 hunk 新侧推得,供 IDE-GIT-010 定位)。 */
  rangeStart: number;
  rangeEnd: number;
}

/** 追踪边界:origin=追溯到行段引入;stopped=合并/复制/无法继续,不代表完整历史。 */
export type RangeTimelineBoundary =
  | { kind: 'origin'; atCommit: string; atPath: string }
  | { kind: 'stopped'; atCommit: string; atPath: string };

export type RangeTimelineResult =
  | { kind: 'timeline'; status: 'ok'; entries: RangeChangeEntry[]; boundary: RangeTimelineBoundary }
  | { kind: 'invalid-range'; reason: string }
  | { kind: 'untracked' }
  | { kind: 'no-commits' }
  | { kind: 'git-error'; outcome: GitRunOutcome };

/** 查询依赖注入面(默认实现经 IDE-GIT-011 协调门,再落 IDE-GIT-003 只读执行器)。 */
export interface GitRangeTimelineDeps {
  runGit(args: readonly string[], cwd: string, request?: GitQueryRequest): Promise<GitRunOutcome>;
}

export function defaultGitRangeTimelineDeps(): GitRangeTimelineDeps {
  return {
    // -L 输出含每提交的行段 diff(有界到行段,仍留 8MiB 余量);协调门把
    // `-L` 判为高成本范围追踪(并发上限 1),token/刷新随 request 传播。
    runGit: (args, cwd, request) =>
      sharedGitQueryGate.run(
        args,
        { cwd, timeoutMs: 10_000, maxOutputBytes: 8_388_608, token: request?.token },
        { bypassCache: request?.bypassCache }
      ),
  };
}

const FIELD_SEP = '\u001f';
const RECORD_SEP = '\u001e';
// 记录行(末行)形如 `<40~64 位 hex>%x1f...`;用构造器避免正则字面量内联控制符(lint)。
const RECORD_LINE_RE = new RegExp(`^[0-9a-f]{40,64}${FIELD_SEP}`);
// 记录以 %x1e 收尾(不设前导分隔),字段单行(不含 %b,正文可多行会破坏「末行=记录」判定);
// git 在每条记录后追加换行再印该提交的行段 diff。布局(实测):
//   `rec0 \x1e \n\n diff0 \n rec1 \x1e \n\n diff1 \n ...`——diff 与下一条记录之间
//   无分隔符,故按 `\x1e` 切分后,片 i>=1 形如 `\n\n diff(i-1) \n rec(i)`,记录在末行。
const RANGE_FORMAT = ['%H', '%an', '%ae', '%aI', '%cI', '%s'].join('%x1f') + '%x1e';

/** 从行段 diff 取新侧路径(`+++ b/<path>`,剥除尾部制表/空格)。 */
function extractNewPath(diff: string): string | null {
  const m = /^\+\+\+ b\/(.+)$/m.exec(diff);
  if (!m) return null;
  return m[1].replace(/[\t ]+$/, '');
}

/** 末段 diff 是否只含新增(无删除内容行):行段引入点。 */
function isPureAddition(diff: string): boolean {
  return !diff.split('\n').some((l) => l.startsWith('-') && !l.startsWith('---'));
}

/** 从行段 diff 的 hunk 头推该行段在该提交版本中的范围(1 基、含端点;hunk 缺省计数 1)。 */
function extractRangeSpan(diff: string): { start: number; end: number } {
  const re = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm;
  let start = Infinity;
  let end = 0;
  for (const m of diff.matchAll(re)) {
    const newStart = Number(m[3]);
    const newCount = m[4] === undefined ? 1 : Number(m[4]);
    start = Math.min(start, newStart);
    end = Math.max(end, newStart + newCount - 1);
  }
  // 无 hunk(异常形态)兜底:1,1,不假装有范围。
  return { start: start === Infinity ? 1 : start, end: end === 0 ? 1 : end };
}

/** 解析单行元数据记录(`%H%x1f%an%x1f%ae%x1f%aI%x1f%cI%x1f%s`)。 */
function parseRecord(meta: string): RangeChangeEntry {
  const fields = meta.split(FIELD_SEP);
  return {
    hash: fields[0] ?? '',
    authorName: fields[1] ?? '',
    authorEmail: fields[2] ?? '',
    authorDate: fields[3] ?? '',
    commitDate: fields[4] ?? '',
    subject: fields[5] ?? '',
    path: '',
    rangeStart: 1,
    rangeEnd: 1,
  };
}

/**
 * 解析 `git log -L ... --format=...` 输出。按 `\x1e` 切分:片 0=记录 0;片 i>=1=
 * `\n\n diff(i-1) \n rec(i)`(末片无 rec)。每片末行若为记录(40hex\x1f 开头)则
 * 与 diff 分离;diff 行恒以 ` ` / `-` / `+` / `@@` / `---` / `+++` 等开头,不会误判。
 * 边界:末段 diff 只含新增 → origin;否则 stopped。
 */
export function parseRangeTimelineOutput(stdout: string): {
  entries: RangeChangeEntry[];
  boundary: RangeTimelineBoundary;
} {
  const pieces = stdout.split(RECORD_SEP);
  const entries: RangeChangeEntry[] = [];
  const diffs: string[] = [];
  const first = (pieces[0] ?? '').replace(/^\n+/, '');
  if (first.trim() !== '') entries.push(parseRecord(first));
  for (let i = 1; i < pieces.length; i += 1) {
    const body = (pieces[i] ?? '').replace(/^\n+/, '');
    const lastNl = body.lastIndexOf('\n');
    const lastLine = lastNl >= 0 ? body.slice(lastNl + 1) : body;
    if (RECORD_LINE_RE.test(lastLine)) {
      entries.push(parseRecord(lastLine));
      diffs.push(body.slice(0, lastNl));
    } else {
      diffs.push(body);
    }
  }
  if (entries.length === 0) {
    return { entries, boundary: { kind: 'stopped', atCommit: '', atPath: '' } };
  }
  // 每条记录按自身 diff 记 path(新侧路径)与该版本中的行段范围(-L 沿重命名:引入提交=老路径)。
  for (let i = 0; i < entries.length; i += 1) {
    const d = diffs[i] ?? '';
    const p = extractNewPath(d);
    if (p) entries[i].path = p;
    const span = extractRangeSpan(d);
    entries[i].rangeStart = span.start;
    entries[i].rangeEnd = span.end;
  }
  const last = entries.length - 1;
  const lastDiff = diffs[last] ?? '';
  const atPath = entries[last].path;
  const boundary: RangeTimelineBoundary = isPureAddition(lastDiff)
    ? { kind: 'origin', atCommit: entries[last].hash, atPath }
    : { kind: 'stopped', atCommit: entries[last].hash, atPath };
  return { entries, boundary };
}

/**
 * 查询 HEAD 行段 [startLine, endLine] 的逐提交修改时间线。
 * 顺序:路径换算→校验→ls-files 探测未跟踪→`git log -L`;越界行号(git 报
 * "has only N lines")与无提交(unknown revision→rev-parse 探测)各自如实归类。
 */
export async function queryRangeTimeline(
  filePath: string,
  repoRoot: string,
  range: { startLine: number; endLine: number },
  deps: GitRangeTimelineDeps = defaultGitRangeTimelineDeps(),
  request?: GitQueryRequest
): Promise<RangeTimelineResult> {
  const rel = relativeVersionPath(repoRoot, filePath);
  if (rel === null) return { kind: 'invalid-range', reason: '文件不在仓库内,无法查询' };
  const { startLine, endLine } = range;
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine)) {
    return { kind: 'invalid-range', reason: '行号必须为整数' };
  }
  if (startLine < 1) return { kind: 'invalid-range', reason: '起始行必须 ≥ 1(HEAD 行号)' };
  if (endLine < startLine) return { kind: 'invalid-range', reason: '结束行不能小于起始行' };

  const tracked = await deps.runGit(['ls-files', '--', rel], repoRoot, request);
  if (tracked.kind !== 'ok') return { kind: 'git-error', outcome: tracked };
  if (tracked.stdout.trim() === '') return { kind: 'untracked' };

  const args = ['log', '-L', `${startLine},${endLine}:${rel}`, `--format=${RANGE_FORMAT}`];
  const outcome = await deps.runGit(args, repoRoot, request);
  if (
    outcome.kind === 'exit' &&
    outcome.exitCode === 128 &&
    /unknown revision|bad revision|not a valid|does not have any commits/.test(outcome.stderr)
  ) {
    const head = await deps.runGit(['rev-parse', '--verify', 'HEAD'], repoRoot, request);
    if (head.kind !== 'ok') return { kind: 'no-commits' };
    return { kind: 'git-error', outcome };
  }
  if (outcome.kind === 'exit' && outcome.exitCode === 128 && /has only \d+ lines/.test(outcome.stderr)) {
    return { kind: 'invalid-range', reason: outcome.stderr.trim() };
  }
  if (outcome.kind !== 'ok') return { kind: 'git-error', outcome };
  const { entries, boundary } = parseRangeTimelineOutput(outcome.stdout);
  // diff 未给出路径时的兜底:当前相对路径。
  for (const e of entries) if (!e.path) e.path = rel;
  return { kind: 'timeline', status: 'ok', entries, boundary };
}

/** 与验收一致的时间线摘要(含边界如实标注文案)。 */
export function describeRangeTimeline(result: RangeTimelineResult): string {
  switch (result.kind) {
    case 'timeline': {
      const b = result.boundary;
      const bText =
        b.kind === 'origin'
          ? `已追溯到行段引入处(${b.atCommit.slice(0, 8)}@${b.atPath})`
          : `追踪止于 ${b.atCommit.slice(0, 8)}@${b.atPath}(合并/复制/无法继续,不代表完整历史)`;
      return `共 ${result.entries.length} 次修改;${bText}`;
    }
    case 'invalid-range':
      return result.reason;
    case 'untracked':
      return '文件未纳入 Git 跟踪,没有历史可查';
    case 'no-commits':
      return '仓库尚无提交,没有历史可查';
    case 'git-error':
      return `Git 查询失败:${summarizeGitError(result.outcome)}`;
  }
}
