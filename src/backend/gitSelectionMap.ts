/**
 * IDE-GIT-008:把编辑器选区映射到已提交(HEAD)行范围。
 * 用户约束(2026-10-29):默认开启、按需查询——本模块只在用户显式发起映射时
 * 运行(调用面门控),绝不预取/轮询。语义:
 * - 参考系是 HEAD:一次 `git diff HEAD --unified=0 -- <rel>` 的 hunk 算术把
 *   当前工作区行号换算为 HEAD 行号,覆盖插入/删除/修改导致的偏移。
 * - 绝不把当前行号直接当 HEAD 行号:工作区行若落在变更区内(新增/修改),
 *   没有准确的 HEAD 对应行,如实计入 unmapped,由调用面明确提示「未提交/
 *   未保存,无法准确映射,请保存后重试或选择已提交版本」。
 * - 未保存的编辑器内容不在本模块内(读取的是磁盘工作区);dirty 检查与
 *   交互提示属命令层(IDE-GIT-010),本模块经 describeSelectionMap 给出
 *   与验收一致的提示文案。
 * - 单行选区 = startLine == endLine;多行选区支持;跨多个变更区产生多段。
 * 纯函数(执行器经 deps.runGit 注入,默认实现走 IDE-GIT-003 的只读执行器)。
 */

import { type GitRunOutcome } from './gitRunner';
import { summarizeGitError } from '../gitHistoryTree';
import { relativeVersionPath } from '../gitHistoryDiff';
import { sharedGitQueryGate, type GitQueryRequest } from './gitQueryGate';
import { l10nText } from '../nlsRuntime';

/** 选区(1 基、含端点;编辑器 0 基位置由调用面换算)。 */
export interface SelectionRange {
  startLine: number;
  endLine: number;
}

/** `git diff --unified=0` 的一个 hunk(计数缺省视为 1)。 */
export interface DiffHunk {
  /** 旧侧起始行(1 基;新增文件为 0)。 */
  oldStart: number;
  /** 旧侧行数(可 0=纯新增)。 */
  oldCount: number;
  /** 新侧起始行(1 基;纯删除为 0 语义的插入点)。 */
  newStart: number;
  /** 新侧行数(可 0=纯删除)。 */
  newCount: number;
}

/**
 * 已提交(HEAD)映射段:一段连续且逐行对应的工作区行 ↔ HEAD 行。
 * 段与段之间隔着无法映射的变更区,故 HEAD 行可能不连续(如实分段)。
 */
export interface CommittedRangeSegment {
  /** 工作区起始行(1 基,含)。 */
  firstLine: number;
  /** 工作区结束行(1 基,含)。 */
  lastLine: number;
  /** HEAD 起始行(1 基,含;与工作区行逐行对应)。 */
  headFirstLine: number;
  /** HEAD 结束行(1 基,含)。 */
  headLastLine: number;
}

export type SelectionMapResult =
  | { kind: 'mapped'; segments: CommittedRangeSegment[]; selectionLineCount: number }
  | {
      kind: 'has-uncommitted';
      segments: CommittedRangeSegment[];
      /** 选区中无法准确映射到 HEAD 的行数(新增/修改,含未保存结构差异)。 */
      unmappedLines: number;
      selectionLineCount: number;
    }
  | { kind: 'untracked' }
  | { kind: 'no-commits' }
  | { kind: 'binary' }
  | { kind: 'invalid-selection'; reason: string }
  | { kind: 'git-error'; outcome: GitRunOutcome };

/** 查询依赖注入面(默认实现经 IDE-GIT-011 协调门,再落 IDE-GIT-003 只读执行器)。 */
export interface GitSelectionMapDeps {
  runGit(args: readonly string[], cwd: string, request?: GitQueryRequest): Promise<GitRunOutcome>;
}

export function defaultGitSelectionMapDeps(): GitSelectionMapDeps {
  return {
    // -U0 差分含整行内容,大文件大改动输出大;8MiB 留余量,仍有界;token/刷新随 request。
    runGit: (args, cwd, request) =>
      sharedGitQueryGate.run(
        args,
        { cwd, timeoutMs: 10_000, maxOutputBytes: 8_388_608, token: request?.token },
        { bypassCache: request?.bypassCache }
      ),
  };
}

/** 解析 `git diff --unified=0` 输出的 hunk 头(忽略非 hunk 行)。 */
export function parseDiffHunks(stdout: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  const re = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
  for (const line of stdout.split('\n')) {
    const m = re.exec(line);
    if (!m) continue;
    hunks.push({
      oldStart: Number(m[1]),
      oldCount: m[2] === undefined ? 1 : Number(m[2]),
      newStart: Number(m[3]),
      newCount: m[4] === undefined ? 1 : Number(m[4]),
    });
  }
  return hunks;
}

/**
 * 纯映射:把选区行经 hunk 算术换算为 HEAD 行段。
 * 清洁区(hunk 之外)逐行 1:1 对应 HEAD;变更区的新侧行没有准确 HEAD 对应行,
 * 计入 unmappedLines。hunk 按变更点升序处理(git 保证有序不重叠,仍防御排序)。
 *
 * 关键约定(实测验证,`--unified=0`):hunk 的变更点位置以「该侧行之前有多少行」
 * 计,而非直接以计数>0 的首行计——`@@ -a,b +c,0 @@`(纯删除)的 c 是变更点之前的
 * 新侧行数(删除位于新侧行 c 与 c+1 之间),`@@ -a,0 +c,d @@`(纯插入)的 a 是变更
 * 点之前的旧侧行数。故用 oldBefore/newBefore(变更点之前行数)统一驱动,而不用
 * newStart 直推。
 */
export function mapRangeViaHunks(
  hunks: readonly DiffHunk[],
  range: SelectionRange
): { segments: CommittedRangeSegment[]; unmappedLines: number } {
  // 归一化:变更点之前的行数(count>0 时首行前一格,count=0 时即行数)。
  const normalized = hunks.map((h) => ({
    oldBefore: h.oldCount > 0 ? h.oldStart - 1 : h.oldStart,
    oldCount: h.oldCount,
    newBefore: h.newCount > 0 ? h.newStart - 1 : h.newStart,
    newCount: h.newCount,
  }));
  const sorted = [...normalized].sort((a, b) => a.newBefore - b.newBefore);
  const segments: CommittedRangeSegment[] = [];
  let unmappedLines = 0;
  // cur = 下一个待分配的工作区行;head = cur 在清洁区对应的 HEAD 行。
  let cur = 1;
  let head = 1;
  for (const h of sorted) {
    // 清洁区:[cur, h.newBefore](工作区行与 HEAD 行 1:1)
    if (h.newBefore >= cur) {
      const cleanLen = h.newBefore - cur + 1;
      const s = Math.max(cur, range.startLine);
      const e = Math.min(h.newBefore, range.endLine);
      if (s <= e) {
        segments.push({
          firstLine: s,
          lastLine: e,
          headFirstLine: head + (s - cur),
          headLastLine: head + (e - cur),
        });
      }
      head += cleanLen;
      cur = h.newBefore + 1;
    }
    // 变更区:新侧行 [newBefore+1, newBefore+newCount] 无 HEAD 对应(新增/修改)
    if (h.newCount > 0) {
      const s = Math.max(h.newBefore + 1, range.startLine);
      const e = Math.min(h.newBefore + h.newCount, range.endLine);
      if (s <= e) unmappedLines += e - s + 1;
    }
    // 变更区旧侧行数在 HEAD 侧被消耗(工作区侧不存在)
    cur = h.newBefore + h.newCount + 1;
    head += h.oldCount;
  }
  // 尾清洁区:[cur, ∞)
  const s = Math.max(cur, range.startLine);
  if (s <= range.endLine) {
    segments.push({
      firstLine: s,
      lastLine: range.endLine,
      headFirstLine: head + (s - cur),
      headLastLine: head + (range.endLine - cur),
    });
  }
  return { segments, unmappedLines };
}

/** 校验选区:1 基、整数、起点≤终点。 */
function validateSelection(range: SelectionRange): string | null {
  const { startLine, endLine } = range;
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine)) {
    return '选区行号必须为整数';
  }
  if (startLine < 1) return '选区起始行必须 ≥ 1(调用面需把 0 基编辑器位置 +1)';
  if (endLine < startLine) return '选区结束行不能小于起始行';
  return null;
}

/**
 * 把选区映射到已提交(HEAD)行范围。
 * 顺序:ls-files 探测未跟踪(未跟踪没有已提交版本)→ diff HEAD -U0 → hunk
 * 算术。错误路径(无提交)经一次 rev-parse 探测区分 no-commits 与 git-error。
 */
export async function mapSelectionToHeadRange(
  filePath: string,
  repoRoot: string,
  range: SelectionRange,
  deps: GitSelectionMapDeps = defaultGitSelectionMapDeps(),
  request?: GitQueryRequest
): Promise<SelectionMapResult> {
  const rel = relativeVersionPath(repoRoot, filePath);
  if (rel === null) {
    return { kind: 'invalid-selection', reason: '文件不在仓库内,无法映射' };
  }
  const invalid = validateSelection(range);
  if (invalid) return { kind: 'invalid-selection', reason: invalid };

  // 未跟踪:index/HEAD 都没有该文件,无已提交版本可映射。
  // ls-files 自身失败(启动/超时)是 Git 错误,不冒充「未跟踪」。
  const tracked = await deps.runGit(['ls-files', '--', rel], repoRoot, request);
  if (tracked.kind !== 'ok') return { kind: 'git-error', outcome: tracked };
  if (tracked.stdout.trim() === '') return { kind: 'untracked' };

  const diff = await deps.runGit(['diff', 'HEAD', '--unified=0', '--', rel], repoRoot, request);
  if (
    diff.kind === 'exit' &&
    diff.exitCode === 128 &&
    /unknown revision|bad revision|not a valid|does not have any commits/.test(diff.stderr)
  ) {
    // 无提交(HEAD 未生):一次 rev-parse 探测区分 no-commits 与其它 git 错误。
    const head = await deps.runGit(['rev-parse', '--verify', 'HEAD'], repoRoot, request);
    if (head.kind !== 'ok') return { kind: 'no-commits' };
    return { kind: 'git-error', outcome: diff };
  }
  if (diff.kind !== 'ok') return { kind: 'git-error', outcome: diff };

  const hunks = parseDiffHunks(diff.stdout);
  if (hunks.length === 0 && diff.stdout.includes('Binary files')) {
    // 二进制变更无法按行映射(没有 hunk 却报了二进制差异)。
    return { kind: 'binary' };
  }
  const { segments, unmappedLines } = mapRangeViaHunks(hunks, range);
  const selectionLineCount = range.endLine - range.startLine + 1;
  if (unmappedLines > 0) {
    return { kind: 'has-uncommitted', segments, unmappedLines, selectionLineCount };
  }
  return { kind: 'mapped', segments, selectionLineCount };
}

/** 与验收一致的映射结果文案(含「未提交/未保存,不直接当 HEAD 行号」提示)。 */
export function describeSelectionMap(result: SelectionMapResult): string {
  switch (result.kind) {
    case 'mapped': {
      if (result.segments.length === 1) {
        const s = result.segments[0];
        return `已映射到已提交(HEAD)行 ${s.headFirstLine}-${s.headLastLine}(共 ${s.lastLine - s.firstLine + 1} 行)`;
      }
      const parts = result.segments.map((s) => `${s.headFirstLine}-${s.headLastLine}`).join('、');
      return `已映射到已提交(HEAD)行 ${parts}(共 ${result.segments.length} 段)`;
    }
    case 'has-uncommitted': {
      const segText =
        result.segments.length > 0
            ? `;已提交部分映射到 HEAD 行 ${result.segments
                .map((s) => `${s.headFirstLine}-${s.headLastLine}`)
                .join('、')}`
            : '';
      return (
        `选区 ${result.selectionLineCount} 行中 ${result.unmappedLines} 行为未提交/未保存的新增或修改,无法准确映射` +
        `(未提交行不直接当作 HEAD 行号)${segText};请保存后重试或选择已提交版本`
      );
    }
    case 'untracked':
      return '文件未纳入 Git 跟踪,没有已提交版本可映射';
    case 'no-commits':
      return '仓库尚无提交,没有 HEAD 行可映射';
    case 'binary':
      return '二进制文件不支持按行映射到已提交版本';
    case 'invalid-selection':
      return result.reason;
    case 'git-error':
      return l10nText('Git query failed: {reason}', { reason: summarizeGitError(result.outcome) });
  }
}

/** 供调用面换算编辑器 0 基行号 → 1 基选区行。 */
export function editorSelectionToRange(
  startLine: number,
  endLine: number
): SelectionRange {
  return { startLine: startLine + 1, endLine: endLine + 1 };
}
