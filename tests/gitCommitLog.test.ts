import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  DEFAULT_GIT_LOG_PAGE_SIZE,
  MAX_GIT_LOG_PAGE_SIZE,
  clampGitLogPageSize,
  queryGitCommitLog,
  unquoteGitPath,
  type GitCommitLogDeps,
} from '../src/gitCommitLog';
import { runGitReadOnly, type GitRunOutcome } from '../src/gitRunner';

const realDeps: GitCommitLogDeps = {
  runGit: (args, cwd) => runGitReadOnly(args, { cwd, timeoutMs: 10000, maxOutputBytes: 2097152 }),
};

/**
 * IDE-GIT-004:查询单文件的分页提交记录。
 * 验收:输出提交标识、作者身份、作者时间、提交时间及说明;按稳定顺序分页
 * 不重复不漏项;默认每页 50 条且可设硬上限;首屏不预读全部 diff/文件内容;
 * 未跟踪文件与空历史明确呈现;初次查询不无界加载全部日志。
 *
 * 双面测试:注入假 runGit 的纯逻辑面(分页参数/解析/状态判别/无 diff 预读)+
 * 真实临时仓库面(中文作者与说明、作者/提交时间区分、跨页不重不漏、未跟踪)。
 */

const RS = '\u001e'; // 记录分隔(git format 的 %x1e)
const FS = '\u001f'; // 字段分隔(git format 的 %x1f)

function okOutcome(records: string): GitRunOutcome {
  return { kind: 'ok', stdout: records, stderr: '' };
}

function entry(
  hash: string,
  authorName: string,
  authorEmail: string,
  authorDate: string,
  commitDate: string,
  subject: string,
  body: string
): string {
  // 第 2 字段=首父提交 %P(本批解析用;测试注入固定父,断言父链可独立覆盖)
  return [hash, 'p1', authorName, authorEmail, authorDate, commitDate, subject, body].join(FS) + RS;
}

function makeDeps(outcome: GitRunOutcome, probeOutcome: GitRunOutcome = okOutcome('')) {
  const runGit = vi.fn(
    (args: readonly string[], _cwd: string) => Promise.resolve(args[0] === 'ls-files' ? probeOutcome : outcome)
  );
  const deps: GitCommitLogDeps = { runGit };
  return { deps, runGit };
}

describe('IDE-GIT-004 页大小钳制', () => {
  it('缺省/非法回默认 50,硬上限 500', () => {
    expect(DEFAULT_GIT_LOG_PAGE_SIZE).toBe(50);
    expect(MAX_GIT_LOG_PAGE_SIZE).toBe(500);
    expect(clampGitLogPageSize(undefined)).toBe(50);
    expect(clampGitLogPageSize(0)).toBe(50);
    expect(clampGitLogPageSize(-3)).toBe(50);
    expect(clampGitLogPageSize(1)).toBe(1);
    expect(clampGitLogPageSize(50)).toBe(50);
    expect(clampGitLogPageSize(500)).toBe(500);
    expect(clampGitLogPageSize(501)).toBe(500);
    expect(clampGitLogPageSize(10000)).toBe(500);
  });
});

describe('IDE-GIT-004 分页与解析(注入面)', () => {
  it('首页参数:skip=0,max-count=pageSize+1(探测 hasMore 不多跑一趟)', async () => {
    const { deps, runGit } = makeDeps(okOutcome(entry('h1', 'n', 'e@x', '2026-11-01T10:00:00+08:00', '2026-11-01T10:00:00+08:00', 's', 'b')));
    const r = await queryGitCommitLog({ repoRoot: '/repo', filePath: 'src/a.py' }, deps);
    expect(r.kind).toBe('page');
    const logArgs = runGit.mock.calls.find((c) => c[0][0] === 'log')![0];
    expect(logArgs).toContain('--skip=0');
    expect(logArgs).toContain('--max-count=51'); // 50+1
    expect(logArgs[logArgs.length - 1]).toBe('src/a.py');
    expect(logArgs[logArgs.length - 2]).toBe('--');
  });

  it('第 3 页(0 基)参数:skip=3*pageSize', async () => {
    const { deps, runGit } = makeDeps(okOutcome(''));
    await queryGitCommitLog({ repoRoot: '/repo', filePath: 'src/a.py', page: 3 }, deps);
    const logArgs = runGit.mock.calls.find((c) => c[0][0] === 'log')![0];
    expect(logArgs).toContain('--skip=150');
    expect(logArgs).toContain('--max-count=51');
  });

  it('解析:提交标识/作者身份/作者时间/提交时间/说明(含中文与多行正文)', async () => {
    const two = entry('h9', '作者甲', 'jia@example.com', '2026-11-01T10:00:00+08:00', '2026-11-02T09:30:00+08:00', '中文主题', '正文第一行\n正文第二行') +
      entry('h8', 'Author B', 'b@example.com', '2026-10-30T08:00:00+08:00', '2026-10-30T08:00:00+08:00', 'subject', '');
    const { deps } = makeDeps(okOutcome(two));
    const r = await queryGitCommitLog({ repoRoot: '/repo', filePath: 'src/a.py' }, deps);
    expect(r.kind).toBe('page');
    if (r.kind !== 'page') return;
    expect(r.entries).toHaveLength(2);
    expect(r.entries[0]).toEqual({
      hash: 'h9',
      parentHash: 'p1',
      authorName: '作者甲',
      authorEmail: 'jia@example.com',
      authorDate: '2026-11-01T10:00:00+08:00',
      commitDate: '2026-11-02T09:30:00+08:00',
      subject: '中文主题',
      body: '正文第一行\n正文第二行',
    });
    expect(r.entries[1].body).toBe('');
    expect(r.status).toBe('ok');
    expect(r.hasMore).toBe(false);
  });

  it('多取 1 条判定 hasMore,返回仍截回 pageSize(不重复不漏项)', async () => {
    const many = Array.from({ length: 51 }, (_, i) => entry(`h${i}`, 'n', 'e', 'd', 'd', `s${i}`, '')).join('');
    const { deps } = makeDeps(okOutcome(many));
    const r = await queryGitCommitLog({ repoRoot: '/repo', filePath: 'src/a.py' }, deps);
    expect(r.kind).toBe('page');
    if (r.kind !== 'page') return;
    expect(r.entries).toHaveLength(50);
    expect(r.hasMore).toBe(true);
    expect(r.entries[49].hash).toBe('h49');
  });

  it('绝对路径换算为仓库相对路径再传 `--`(不把绝对路径漏给 git)', async () => {
    const { deps, runGit } = makeDeps(okOutcome(entry('h1', 'n', 'e', 'd', 'd', 's', '')));
    await queryGitCommitLog({ repoRoot: '/repo', filePath: join('/repo', 'src', 'a.py') }, deps);
    const logArgs = runGit.mock.calls.find((c) => c[0][0] === 'log')![0];
    expect(logArgs[logArgs.length - 1]).toBe(join('src', 'a.py'));
    expect(logArgs[logArgs.length - 1]).not.toMatch(/^\//);
  });

  it('首屏不预读 diff/文件内容:只发起 log(与未跟踪探测 ls-files),无 show/cat-file/diff', async () => {
    const { deps, runGit } = makeDeps(okOutcome(''));
    await queryGitCommitLog({ repoRoot: '/repo', filePath: 'src/a.py' }, deps);
    const subs = runGit.mock.calls.map((c) => c[0][0]);
    for (const s of subs) expect(['log', 'ls-files']).toContain(s);
  });

  it('每次 log 调用都有界:max-count ≤ 501(初次查询不无界加载)', async () => {
    const { deps, runGit } = makeDeps(okOutcome(''));
    await queryGitCommitLog({ repoRoot: '/repo', filePath: 'src/a.py', pageSize: 10000 }, deps);
    const logArgs = runGit.mock.calls.find((c) => c[0][0] === 'log')![0];
    const maxCount = Number(logArgs.find((a: string) => a.startsWith('--max-count='))!.slice('--max-count='.length));
    expect(maxCount).toBeLessThanOrEqual(501);
  });
});

describe('IDE-GIT-004 状态判别(注入面)', () => {
  it('首页空 + ls-files 空 → 未跟踪(明确呈现)', async () => {
    const { deps } = makeDeps(okOutcome(''), okOutcome(''));
    const r = await queryGitCommitLog({ repoRoot: '/repo', filePath: 'src/new.py' }, deps);
    expect(r).toEqual({ kind: 'untracked' });
  });

  it('首页空 + ls-files 命中 → 已跟踪但尚无提交历史(暂存未提交)', async () => {
    const { deps } = makeDeps(okOutcome(''), okOutcome('src/staged.py\n'));
    const r = await queryGitCommitLog({ repoRoot: '/repo', filePath: 'src/staged.py' }, deps);
    expect(r).toEqual({ kind: 'no-history' });
  });

  it('空仓库(尚无任何提交)→ no-commits', async () => {
    const { deps } = makeDeps({ kind: 'exit', exitCode: 128, stderr: "fatal: your current branch 'main' does not have any commits yet\n" });
    const r = await queryGitCommitLog({ repoRoot: '/repo', filePath: 'src/a.py' }, deps);
    expect(r).toEqual({ kind: 'no-commits' });
  });

  it('其它失败原样透传(git-error,调用面映射文案)', async () => {
    const fatal: GitRunOutcome = { kind: 'exit', exitCode: 128, stderr: 'fatal: bad object\n' };
    const { deps } = makeDeps(fatal);
    const r = await queryGitCommitLog({ repoRoot: '/repo', filePath: 'src/a.py' }, deps);
    expect(r).toEqual({ kind: 'git-error', outcome: fatal });
  });

  it('非首页为空:返回空页,不做未跟踪探测(翻页到尽头)', async () => {
    const { deps, runGit } = makeDeps(okOutcome(''));
    const r = await queryGitCommitLog({ repoRoot: '/repo', filePath: 'src/a.py', page: 5 }, deps);
    expect(r.kind).toBe('page');
    if (r.kind !== 'page') return;
    expect(r.entries).toEqual([]);
    expect(r.hasMore).toBe(false);
    expect(runGit.mock.calls.some((c) => c[0][0] === 'ls-files')).toBe(false);
  });
});

// ---------- 真实临时仓库 ----------

function makeRealRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'kode-gitlog-'));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  mkdirSync(join(repo, 'src'), { recursive: true });
  return repo;
}

function commitFile(repo: string, content: string, subject: string, body: string, iso: string, name: string, email: string): string {
  writeFileSync(join(repo, 'src', 'a.py'), content);
  execFileSync('git', ['add', '--', 'src/a.py'], { cwd: repo });
  execFileSync(
    'git',
    ['commit', '-q', '-m', subject, '-m', body],
    {
      cwd: repo,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: name,
        GIT_AUTHOR_EMAIL: email,
        GIT_AUTHOR_DATE: iso,
        GIT_COMMITTER_NAME: '提交者丙',
        GIT_COMMITTER_EMAIL: 'bing@example.com',
        GIT_COMMITTER_DATE: iso.replace('10:00:00', '12:00:00'), // 提交时间晚于作者时间,两字段可区分
      },
    }
  );
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo }).toString().trim();
}

describe('IDE-GIT-004 真实仓库', () => {
  it('跨页稳定顺序,不重复不漏项;作者/提交时间与中文说明逐字往返', async () => {
    const repo = makeRealRepo();
    const c1 = commitFile(repo, 'x=1\n', '初始版本', '第一次正文\n两行', '2026-11-01T10:00:00+08:00', '作者甲', 'jia@example.com');
    const c2 = commitFile(repo, 'x=2\n', 'update', '', '2026-11-02T10:00:00+08:00', '作者甲', 'jia@example.com');
    const c3 = commitFile(repo, 'x=3\n', '第三批修改', 'fix: 空格 与中文', '2026-11-03T10:00:00+08:00', '作者乙', 'yi@example.com');

    const p0 = await queryGitCommitLog({ repoRoot: repo, filePath: 'src/a.py', pageSize: 2 }, realDeps);
    expect(p0.kind).toBe('page');
    if (p0.kind !== 'page') return;
    expect(p0.entries.map((e) => e.hash)).toEqual([c3, c2]); // 新→旧稳定顺序
    expect(p0.hasMore).toBe(true);
    expect(p0.entries[0].authorName).toBe('作者乙');
    expect(p0.entries[0].authorEmail).toBe('yi@example.com');
    expect(p0.entries[0].authorDate).toBe('2026-11-03T10:00:00+08:00');
    expect(p0.entries[0].commitDate).toBe('2026-11-03T12:00:00+08:00'); // 提交时间 ≠ 作者时间
    expect(p0.entries[0].subject).toBe('第三批修改');
    expect(p0.entries[0].body).toContain('fix: 空格 与中文');

    const p1 = await queryGitCommitLog({ repoRoot: repo, filePath: 'src/a.py', page: 1, pageSize: 2 }, realDeps);
    expect(p1.kind).toBe('page');
    if (p1.kind !== 'page') return;
    expect(p1.entries.map((e) => e.hash)).toEqual([c1]);
    expect(p1.hasMore).toBe(false);
    // 跨页合并 = 全部提交,不重复不漏项
    const all = [...p0.entries.map((e) => e.hash), ...p1.entries.map((e) => e.hash)];
    expect(new Set(all).size).toBe(3);
    expect(all.sort()).toEqual([c1, c2, c3].sort());
  });

  it('未跟踪文件 → untracked(真实)', async () => {
    const repo = makeRealRepo();
    commitFile(repo, 'x=1\n', 'init', '', '2026-11-01T10:00:00+08:00', '作者甲', 'jia@example.com');
    writeFileSync(join(repo, 'src', 'not-tracked.py'), 'y=1\n');
    const r = await queryGitCommitLog({ repoRoot: repo, filePath: 'src/not-tracked.py' }, realDeps);
    expect(r).toEqual({ kind: 'untracked' });
  });

  it('空仓库(无提交)→ no-commits(真实)', async () => {
    const repo = makeRealRepo();
    writeFileSync(join(repo, 'src', 'a.py'), 'x=1\n');
    const r = await queryGitCommitLog({ repoRoot: repo, filePath: 'src/a.py' }, realDeps);
    expect(r).toEqual({ kind: 'no-commits' });
  });

  it('已暂存未提交 → no-history(真实)', async () => {
    const repo = makeRealRepo();
    commitFile(repo, 'x=1\n', 'init', '', '2026-11-01T10:00:00+08:00', '作者甲', 'jia@example.com');
    writeFileSync(join(repo, 'src', 'staged.py'), 'z=1\n');
    execFileSync('git', ['add', '--', 'src/staged.py'], { cwd: repo });
    const r = await queryGitCommitLog({ repoRoot: repo, filePath: 'src/staged.py' }, realDeps);
    expect(r).toEqual({ kind: 'no-history' });
  });

  it('真实仓库探测相对路径换算:绝对入参与相对入参结果一致', async () => {
    const repo = makeRealRepo();
    const h = commitFile(repo, 'x=1\n', 'init', '', '2026-11-01T10:00:00+08:00', '作者甲', 'jia@example.com');
    const byRel = await queryGitCommitLog({ repoRoot: repo, filePath: join('src', 'a.py') }, realDeps);
    const byAbs = await queryGitCommitLog({ repoRoot: repo, filePath: join(repo, 'src', 'a.py') }, realDeps);
    expect(byRel.kind).toBe('page');
    expect(byAbs.kind).toBe('page');
    if (byRel.kind === 'page' && byAbs.kind === 'page') {
      expect(byRel.entries[0]?.hash).toBe(h);
      expect(byAbs.entries[0]?.hash).toBe(h);
    }
  });
});

// ---------- unquoteGitPath 控制字符命名转义(审核发现修复) ----------

describe('unquoteGitPath 控制字符反解', () => {
  it('C 风格命名转义 \\t \\n \\r \\a \\b \\v \\f 反解为实际控制字符', () => {
    expect(unquoteGitPath('"a\\tb"')).toBe('a\tb');
    expect(unquoteGitPath('"a\\nb"')).toBe('a\nb');
    expect(unquoteGitPath('"a\\rb"')).toBe('a\rb');
    expect(unquoteGitPath('"a\\ab"')).toBe('a\x07b');
    expect(unquoteGitPath('"a\\bb"')).toBe('a\x08b');
    expect(unquoteGitPath('"a\\vb"')).toBe('a\x0bb');
    expect(unquoteGitPath('"a\\fb"')).toBe('a\x0cb');
    expect(unquoteGitPath('"\\t\\n\\r\\a\\b\\v\\f"')).toBe('\t\n\r\x07\x08\x0b\x0c');
  });

  it('与八进制/反斜杠/引号转义混排;未带引号原样;未知转义保留字面', () => {
    // \t 实际制表符 + \344\270\255(中的 UTF-8 八进制) + \\ 与 \" 逐字
    expect(unquoteGitPath('"a\\tb\\344\\270\\255c\\\\d\\"e"')).toBe('a\tb中c\\d"e');
    expect(unquoteGitPath('plain.py')).toBe('plain.py');
    expect(unquoteGitPath('"a\\xb"')).toBe('a\\xb');
  });
});

describe('真实仓库:含制表符文件名的重命名历史(审核发现修复)', () => {
  it('follow 追踪含 TAB 文件名重命名:pathAtCommit 反解出实际制表符', async () => {
    const repo = makeRealRepo();
    const oldName = 'src/a\tb.py';
    const newName = 'src/c\td.py';
    const gitEnv = (iso: string) => ({
      ...process.env,
      GIT_AUTHOR_NAME: 'a',
      GIT_AUTHOR_EMAIL: 'a@e.c',
      GIT_AUTHOR_DATE: iso,
      GIT_COMMITTER_NAME: 'c',
      GIT_COMMITTER_EMAIL: 'c@e.c',
      GIT_COMMITTER_DATE: iso,
    });
    writeFileSync(join(repo, oldName), 'x=1\n');
    execFileSync('git', ['add', '--', oldName], { cwd: repo });
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo, env: gitEnv('2026-11-01T10:00:00+08:00') });
    execFileSync('git', ['mv', oldName, newName], { cwd: repo });
    execFileSync('git', ['commit', '-q', '-m', 'rename'], { cwd: repo, env: gitEnv('2026-11-02T10:00:00+08:00') });

    const r = await queryGitCommitLog({ repoRoot: repo, filePath: newName, follow: true }, realDeps);
    expect(r.kind).toBe('page');
    if (r.kind !== 'page') return;
    expect(r.entries.length).toBe(2);
    // 重命名提交树上路径=新名,更老提交=旧名;均反解出实际 TAB 而非字面 "\t"
    expect(r.entries[0].pathAtCommit).toBe(newName);
    expect(r.entries[1].pathAtCommit).toBe(oldName);
    expect(r.entries.every((e) => (e.pathAtCommit ?? '').includes('\t'))).toBe(true);
    expect(r.entries.every((e) => !(e.pathAtCommit ?? '').includes('\\t'))).toBe(true);
  });
});
