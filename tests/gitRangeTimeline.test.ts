import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  describeRangeTimeline,
  parseRangeTimelineOutput,
  queryRangeTimeline,
  type GitRangeTimelineDeps,
} from '../src/gitRangeTimeline';
import { runGitReadOnly, type GitRunOutcome } from '../src/gitRunner';
// WIN-3:真实临时仓库逐个 spawn git,win32(杀软/路径解析)显著慢于 Linux,
// 并行套件下 5s 默认会超时;仅放宽本文件真实仓库面的单测时限
vi.setConfig({ testTimeout: 30000 });


/**
 * IDE-GIT-009:查询选区对应历史行段的逐提交修改时间线。
 * 验收:跟随选区对应历史行段的变更,前置插行后仍能找到之前修改;列出多次修改
 * 的作者与时间;合并/重命名/无法追踪的边界如实标注,不以当前 blame 结果冒充
 * 完整历史。
 *
 * 纯解析 + 依赖注入流程(mock)+ 真实临时仓库(-L 实际追踪:插行偏移补偿、
 * 重命名跨路径、行新增引入点、越界/未跟踪/无提交终态)。
 */

const realDeps: GitRangeTimelineDeps = {
  // WIN-3:win32 git.exe 冷启动慢(全量并发下可超 10s/次),平台化放宽单次超时
  runGit: (args, cwd) => runGitReadOnly(args, { cwd, timeoutMs: 60000, maxOutputBytes: 2097152 }),
};

const ok = (stdout: string): GitRunOutcome => ({ kind: 'ok', stdout, stderr: '' });

function makeDeps(handler?: (args: readonly string[]) => Promise<GitRunOutcome> | GitRunOutcome): {
  deps: GitRangeTimelineDeps;
  runGit: ReturnType<typeof vi.fn>;
} {
  const runGit = vi.fn(async (args: readonly string[]) => {
    if (handler) return handler(args);
    throw new Error(`unexpected git call: ${args.join(' ')}`);
  });
  return { deps: { runGit }, runGit };
}

/** 生成一份真实布局的 -L 输出(实测:`rec\x1e\n\ndiff\nrec\x1e\n\ndiff\n...`)。 */
const FS = '\u001f';

/** 把短标签扩成 40 位 hex 哈希(与真实 git SHA-1 同形)。 */
function H(label: string): string {
  return '0'.repeat(40 - label.length) + label.replace(/[^0-9a-f]/g, '0');
}

function record(hash: string, subject: string, author: string, date: string): string {
  return [hash, author, 'a@example.com', date, date, subject].join(FS);
}

/** 逐提交构建:`rec\x1e\n\ndiff\n` 拼接(diff 与下一条记录间无分隔,实测布局)。 */
function buildTimeline(items: Array<{ hash: string; subject: string; author: string; date: string; diff: string }>): string {
  return items
    .map((i) => `${record(i.hash, i.subject, i.author, i.date)}\u001e\n\n${i.diff}\n`)
    .join('');
}

describe('IDE-GIT-009 parseRangeTimelineOutput', () => {
  it('多提交:entries 按新→旧,末段纯新增 → origin;每条按自身 diff 记路径', () => {
    const stdout = buildTimeline([
      {
        hash: H('h3'),
        subject: '改三',
        author: '乙',
        date: '2026-11-03T10:00:00+08:00',
        diff: 'diff --git a/f.py b/f.py\n--- a/f.py\n+++ b/f.py\n@@ -3,1 +3,1 @@\n-C\n+C2\n',
      },
      {
        hash: H('h1'),
        subject: '创建',
        author: '甲',
        date: '2026-11-01T10:00:00+08:00',
        diff: 'diff --git a/f.py b/f.py\n--- /dev/null\n+++ b/f.py\n@@ -0,0 +1,3 @@\n+A\n+B\n+C\n',
      },
    ]);
    const { entries, boundary } = parseRangeTimelineOutput(stdout);
    expect(entries.map((e) => e.subject)).toEqual(['改三', '创建']);
    expect(entries[0].authorName).toBe('乙');
    expect(entries[0].authorDate).toBe('2026-11-03T10:00:00+08:00');
    expect(entries.map((e) => e.path)).toEqual(['f.py', 'f.py']);
    // 每条记录该版本中的行段范围(由 -L diff hunk 新侧推得):改三=3,1→3;创建=1,3→1-3。
    expect(entries.map((e) => [e.rangeStart, e.rangeEnd])).toEqual([
      [3, 3],
      [1, 3],
    ]);
    expect(boundary).toEqual({ kind: 'origin', atCommit: H('h1'), atPath: 'f.py' });
  });

  it('末段含删除内容行 → stopped(合并/复制/无法继续,不冒充完整历史)', () => {
    const stdout = buildTimeline([
      {
        hash: H('h2'),
        subject: '合并解析',
        author: '乙',
        date: '2026-11-02T10:00:00+08:00',
        diff: 'diff --git a/f.py b/f.py\n--- a/f.py\n+++ b/f.py\n@@ -3,1 +3,1 @@\n-C-old\n+C\n',
      },
    ]);
    const { boundary } = parseRangeTimelineOutput(stdout);
    expect(boundary).toEqual({ kind: 'stopped', atCommit: H('h2'), atPath: 'f.py' });
  });

  it('重命名跨路径:引入提交记老路径,后续提交记新路径', () => {
    const stdout = buildTimeline([
      {
        hash: H('h2'),
        subject: '改新',
        author: '乙',
        date: '2026-11-02T10:00:00+08:00',
        diff: 'diff --git a/new.py b/new.py\n--- a/new.py\n+++ b/new.py\n@@ -2,1 +2,1 @@\n-x\n+y\n',
      },
      {
        hash: H('h1'),
        subject: '创建老',
        author: '甲',
        date: '2026-11-01T10:00:00+08:00',
        diff: 'diff --git a/old.py b/old.py\n--- /dev/null\n+++ b/old.py\n@@ -0,0 +1,2 @@\n+A\n+B\n',
      },
    ]);
    const { entries, boundary } = parseRangeTimelineOutput(stdout);
    expect(entries.map((e) => e.path)).toEqual(['new.py', 'old.py']);
    expect(boundary).toEqual({ kind: 'origin', atCommit: H('h1'), atPath: 'old.py' });
  });

  it('空输出:零条目,边界 stopped 空止点', () => {
    const { entries, boundary } = parseRangeTimelineOutput('');
    expect(entries).toEqual([]);
    expect(boundary).toEqual({ kind: 'stopped', atCommit: '', atPath: '' });
  });

  it('中文提交主题逐字往返(记录单行,正文不并入格式)', () => {
    const stdout = buildTimeline([
      {
        hash: H('h9'),
        subject: '主题:属性「arena」初始化',
        author: '甲',
        date: '2026-11-01T10:00:00+08:00',
        diff: 'diff --git a/f.py b/f.py\n--- /dev/null\n+++ b/f.py\n@@ -0,0 +1,1 @@\n+A\n',
      },
    ]);
    const { entries, boundary } = parseRangeTimelineOutput(stdout);
    expect(entries[0].subject).toBe('主题:属性「arena」初始化');
    expect(boundary).toEqual({ kind: 'origin', atCommit: H('h9'), atPath: 'f.py' });
  });
});

describe('IDE-GIT-009 流程(依赖注入)', () => {
  it('参数面:ls-files 探测后 `git log -L start,end:rel --format=…`', async () => {
    const { deps, runGit } = makeDeps((args) => {
      if (args[0] === 'ls-files') return ok('src/a.py\n');
      if (args[0] === 'log') return ok('');
      throw new Error(`unexpected: ${args.join(' ')}`);
    });
    const r = await queryRangeTimeline('/repo/src/a.py', '/repo', { startLine: 3, endLine: 5 }, deps);
    expect(r.kind).toBe('timeline');
    expect(runGit).toHaveBeenNthCalledWith(1, ['ls-files', '--', 'src/a.py'], '/repo', undefined);
    const logArgs = runGit.mock.calls[1][0] as readonly string[];
    expect(logArgs[0]).toBe('log');
    expect(logArgs[1]).toBe('-L');
    expect(logArgs[2]).toBe('3,5:src/a.py');
    expect(logArgs[3]).toMatch(/^--format=%H/);
  });

  it('未跟踪:ls-files 空 → untracked,不再 log', async () => {
    const { deps, runGit } = makeDeps((args) => (args[0] === 'ls-files' ? ok('') : ok('')));
    const r = await queryRangeTimeline('/repo/new.py', '/repo', { startLine: 1, endLine: 1 }, deps);
    expect(r).toEqual({ kind: 'untracked' });
    expect(runGit).toHaveBeenCalledTimes(1);
  });

  it('ls-files 非 ok → git-error,不冒充未跟踪', async () => {
    const { deps } = makeDeps((args) =>
      args[0] === 'ls-files' ? ({ kind: 'spawn', message: 'ENOENT' } as GitRunOutcome) : ok('')
    );
    const r = await queryRangeTimeline('/repo/a.py', '/repo', { startLine: 1, endLine: 1 }, deps);
    expect(r.kind).toBe('git-error');
  });

  it('有界执行超时 → git-error 且不伪完整时间线(无 entries/无 boundary)', async () => {
    // IDE-GIT-012 诚实截断:查询级 timeout 由有界执行器终止,解析只在 ok 进行,
    // 绝不从截断流伪造 boundary/条目——结果须保留 outcome.kind 且无时间线产物。
    const { deps } = makeDeps((args) => {
      if (args[0] === 'ls-files') return ok('a.py\n');
      if (args[0] === 'log') return { kind: 'timeout', timeoutMs: 10000 } as GitRunOutcome;
      throw new Error(`unexpected: ${args.join(' ')}`);
    });
    const r = await queryRangeTimeline('/repo/a.py', '/repo', { startLine: 1, endLine: 300 }, deps);
    expect(r.kind).toBe('git-error');
    if (r.kind === 'git-error') {
      expect(r.outcome.kind).toBe('timeout');
      expect(r.outcome).not.toHaveProperty('entries');
      expect(r.outcome).not.toHaveProperty('boundary');
    }
  });

  it('无提交仓库:unknown revision → rev-parse 探测 → no-commits', async () => {
    const { deps, runGit } = makeDeps((args) => {
      if (args[0] === 'ls-files') return ok('a.py\n');
      if (args[0] === 'log')
        return {
          kind: 'exit',
          exitCode: 128,
          stderr: "fatal: ambiguous argument 'HEAD': unknown revision or path not in the working tree.\n",
        } as GitRunOutcome;
      if (args[0] === 'rev-parse')
        return { kind: 'exit', exitCode: 128, stderr: 'fatal: Needed a single revision\n' } as GitRunOutcome;
      throw new Error(`unexpected: ${args.join(' ')}`);
    });
    const r = await queryRangeTimeline('/repo/a.py', '/repo', { startLine: 1, endLine: 1 }, deps);
    expect(r).toEqual({ kind: 'no-commits' });
    expect(runGit).toHaveBeenLastCalledWith(['rev-parse', '--verify', 'HEAD'], '/repo', undefined);
  });

  it('行号越界:git 报 has only N lines → invalid-range', async () => {
    const { deps } = makeDeps((args) => {
      if (args[0] === 'ls-files') return ok('a.py\n');
      return { kind: 'exit', exitCode: 128, stderr: 'fatal: file a.py has only 4 lines\n' } as GitRunOutcome;
    });
    const r = await queryRangeTimeline('/repo/a.py', '/repo', { startLine: 9, endLine: 10 }, deps);
    expect(r.kind).toBe('invalid-range');
    if (r.kind === 'invalid-range') expect(r.reason).toContain('has only 4 lines');
  });

  it('非法范围(0 行/倒置/非整数/仓库外):invalid-range,零 Git 调用', async () => {
    const { deps, runGit } = makeDeps();
    const a = await queryRangeTimeline('/repo/a.py', '/repo', { startLine: 0, endLine: 2 }, deps);
    const b = await queryRangeTimeline('/repo/a.py', '/repo', { startLine: 5, endLine: 4 }, deps);
    const c = await queryRangeTimeline('/repo/a.py', '/repo', { startLine: 1.5, endLine: 2 }, deps);
    const d = await queryRangeTimeline('/other/a.py', '/repo', { startLine: 1, endLine: 1 }, deps);
    expect(a.kind).toBe('invalid-range');
    expect(b.kind).toBe('invalid-range');
    expect(c.kind).toBe('invalid-range');
    expect(d.kind).toBe('invalid-range');
    expect(runGit).not.toHaveBeenCalled();
  });
});

describe('IDE-GIT-009 describeRangeTimeline 文案', () => {
  it('origin/stopped 边界如实标注', () => {
    expect(
      describeRangeTimeline({
        kind: 'timeline',
        status: 'ok',
        entries: [],
        boundary: { kind: 'origin', atCommit: 'abcd1234ef', atPath: 'f.py' },
      })
    ).toContain('已追溯到行段引入处');
    expect(
      describeRangeTimeline({
        kind: 'timeline',
        status: 'ok',
        entries: [],
        boundary: { kind: 'stopped', atCommit: 'abcd1234ef', atPath: 'f.py' },
      })
    ).toContain('不代表完整历史');
  });

  it('终态文案', () => {
    expect(describeRangeTimeline({ kind: 'untracked' })).toContain('未纳入 Git 跟踪');
    expect(describeRangeTimeline({ kind: 'no-commits' })).toContain('尚无提交');
    expect(describeRangeTimeline({ kind: 'invalid-range', reason: '行号必须为整数' })).toContain('整数');
    expect(
      describeRangeTimeline({ kind: 'git-error', outcome: { kind: 'timeout', timeoutMs: 10 } })
    ).toContain('Query timed out');
  });
});

describe('IDE-GIT-009 真实临时仓库:-L 追踪', () => {
  function makeRepo(): string {
    const root = mkdtempSync(join(tmpdir(), 'kode-rangetl-'));
    execFileSync('git', ['init', '-q'], { cwd: root });
    // WIN-3:imac 全局 autocrlf=true 会给 add/commit 注入 CRLF 噪声,仓库级关掉
    execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'T'], { cwd: root });
    return root;
  }

  function commitAs(root: string, message: string, name: string, email: string): void {
    execFileSync('git', ['add', '-A'], { cwd: root });
    execFileSync('git', ['-c', `user.name=${name}`, '-c', `user.email=${email}`, 'commit', '-q', '-m', message], {
      cwd: root,
    });
  }

  it('前置插行后仍能找到之前修改;多次修改的作者与时间逐条列出;追溯到 origin', async () => {
    const root = makeRepo();
    writeFileSync(join(root, 'f.py'), 'A\nB\nC\n');
    commitAs(root, 'v1 create', '甲', 'jia@example.com');
    writeFileSync(join(root, 'f.py'), 'A\nB2\nC\n');
    commitAs(root, 'v2 modify B', '乙', 'yi@example.com');
    // 前置插行:X 插到最前,B2 位移到第 3 行
    writeFileSync(join(root, 'f.py'), 'X\nA\nB2\nC\n');
    commitAs(root, 'v3 insert X top', '丙', 'bing@example.com');
    writeFileSync(join(root, 'f.py'), 'X\nA\nB2\nC2\n');
    commitAs(root, 'v4 modify C', '丁', 'ding@example.com');

    // B2 现位于 HEAD 第 3 行(而非创建时的第 2 行):偏移由 -L 自动补偿
    const r = await queryRangeTimeline(join(root, 'f.py'), root, { startLine: 3, endLine: 3 }, realDeps);
    expect(r.kind).toBe('timeline');
    if (r.kind === 'timeline') {
      const subjects = r.entries.map((e) => e.subject);
      expect(subjects).toEqual(['v2 modify B', 'v1 create']);
      // 前置插行(v3)不遮蔽 v2 修改;v3/v4 不入列(B2 未被它们改动)
      expect(subjects).not.toContain('v3 insert X top');
      // 多次修改的作者与时间逐条列出
      expect(r.entries[0].authorName).toBe('乙');
      expect(r.entries[1].authorName).toBe('甲');
      expect(r.entries[0].authorDate).toMatch(/^2026-/);
      // 追溯到行段引入(origin)
      expect(r.boundary.kind).toBe('origin');
      expect(r.boundary.atCommit).toBe(r.entries[1].hash);
    }
  });

  it('重命名跨路径:-L 沿老路径回溯,引入提交记老路径', async () => {
    const root = makeRepo();
    writeFileSync(join(root, 'old.py'), 'A\nB\n');
    commitAs(root, 'v1 create old', '甲', 'jia@example.com');
    execFileSync('git', ['mv', 'old.py', 'new.py'], { cwd: root });
    commitAs(root, 'v2 rename', '甲', 'jia@example.com');
    writeFileSync(join(root, 'new.py'), 'A\nB2\n');
    commitAs(root, 'v3 modify B in new', '乙', 'yi@example.com');

    const r = await queryRangeTimeline(join(root, 'new.py'), root, { startLine: 2, endLine: 2 }, realDeps);
    expect(r.kind).toBe('timeline');
    if (r.kind === 'timeline') {
      expect(r.entries.map((e) => e.subject)).toEqual(['v3 modify B in new', 'v1 create old']);
      // 引入提交在老路径,后续提交在新路径(重命名如实可见)
      expect(r.entries[0].path).toBe('new.py');
      expect(r.entries[1].path).toBe('old.py');
      expect(r.boundary).toMatchObject({ kind: 'origin', atPath: 'old.py' });
    }
  });

  it('行中段新增(文件先在):引入点=新增提交,仍是 origin', async () => {
    const root = makeRepo();
    writeFileSync(join(root, 'f.py'), 'A\nB\n');
    commitAs(root, 'v1 create A B', '甲', 'jia@example.com');
    writeFileSync(join(root, 'f.py'), 'A\nB\nC\n');
    commitAs(root, 'v2 add C', '乙', 'yi@example.com');
    writeFileSync(join(root, 'f.py'), 'A\nB\nC2\n');
    commitAs(root, 'v3 modify C', '丙', 'bing@example.com');

    const r = await queryRangeTimeline(join(root, 'f.py'), root, { startLine: 3, endLine: 3 }, realDeps);
    expect(r.kind).toBe('timeline');
    if (r.kind === 'timeline') {
      expect(r.entries.map((e) => e.subject)).toEqual(['v3 modify C', 'v2 add C']);
      expect(r.boundary.kind).toBe('origin');
      expect(r.boundary.atCommit).toBe(r.entries[1].hash);
    }
  });

  it('多行范围:跨行的并集修改按时间列出', async () => {
    const root = makeRepo();
    writeFileSync(join(root, 'f.py'), 'A\nB\n');
    commitAs(root, 'v1 create', '甲', 'jia@example.com');
    writeFileSync(join(root, 'f.py'), 'A2\nB\n');
    commitAs(root, 'v2 modify A', '乙', 'yi@example.com');
    writeFileSync(join(root, 'f.py'), 'A2\nB2\n');
    commitAs(root, 'v3 modify B', '丙', 'bing@example.com');

    const r = await queryRangeTimeline(join(root, 'f.py'), root, { startLine: 1, endLine: 2 }, realDeps);
    expect(r.kind).toBe('timeline');
    if (r.kind === 'timeline') {
      expect(r.entries.map((e) => e.subject)).toEqual(['v3 modify B', 'v2 modify A', 'v1 create']);
    }
  // WIN-3:win32 逐次 git.exe spawn 慢(测试体十余次 git 调用),平台化超时
  }, 60000);

  it('越界行号 → invalid-range(git 如实报 has only N lines)', async () => {
    const root = makeRepo();
    writeFileSync(join(root, 'f.py'), 'A\nB\n');
    commitAs(root, 'v1', '甲', 'jia@example.com');
    const r = await queryRangeTimeline(join(root, 'f.py'), root, { startLine: 9, endLine: 10 }, realDeps);
    expect(r.kind).toBe('invalid-range');
  });

  it('未跟踪 → untracked;无提交仓库 → no-commits', async () => {
    const root = makeRepo();
    writeFileSync(join(root, 'base.py'), 'b\n');
    commitAs(root, 'v1', '甲', 'jia@example.com');
    writeFileSync(join(root, 'untracked.py'), 'u\n');
    const r = await queryRangeTimeline(join(root, 'untracked.py'), root, { startLine: 1, endLine: 1 }, realDeps);
    expect(r).toEqual({ kind: 'untracked' });

    const empty = makeRepo();
    writeFileSync(join(empty, 'a.py'), 'a\n');
    execFileSync('git', ['add', 'a.py'], { cwd: empty });
    const r2 = await queryRangeTimeline(join(empty, 'a.py'), empty, { startLine: 1, endLine: 1 }, realDeps);
    expect(r2).toEqual({ kind: 'no-commits' });
  });
});
