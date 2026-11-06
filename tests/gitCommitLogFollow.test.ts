import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  parseFollowCommitRecords,
  queryGitCommitLog,
  type GitCommitLogDeps,
} from '../src/gitCommitLog';
import { runGitReadOnly, type GitRunOutcome } from '../src/gitRunner';
// WIN-3:真实临时仓库逐个 spawn git,win32(杀软/路径解析)显著慢于 Linux,
// 并行套件下 5s 默认会超时;仅放宽本文件真实仓库面的单测时限
vi.setConfig({ testTimeout: 30000 });


const realDeps: GitCommitLogDeps = {
  runGit: (args, cwd) => runGitReadOnly(args, { cwd, timeoutMs: 10000, maxOutputBytes: 2097152 }),
};

/**
 * IDE-GIT-007:沿文件重命名追踪历史路径。
 * 验收:重命名前后的提交均可查看且打开对应旧路径内容(--follow 入列重命名前
 * 提交且每条带 pathAtCommit,打开版本用该提交时的路径);多仓库同名文件不串
 * 历史(repoRoot cwd 作用域);无法确定的复制/移动明确提示边界(最老提交以
 * D/C 收尾时如实标注 copy-or-move,绝不假装继续)。
 *
 * 双面:纯解析面(注入假 runGit 的 --follow --name-status 交错输出)+真实临时
 * 仓库面(git mv 重命名链验证 pathAtCommit 与跨重命名打开)。
 */

const RS = '\u001e';
const FS = '\u001f';

/** 拼一条 `--follow --name-status` 记录:格式记录 + \x1e + \n + 状态行 + \n */
function record(rec: string, status: string): string {
  return `${rec}${RS}\n${status}\n`;
}

function rec(hash: string, subject: string, parent = ''): string {
  return [hash, parent, '作者', 'a@example.com', '2026-11-01T10:00:00+08:00', '2026-11-01T10:00:00+08:00', subject, ''].join(
    FS
  );
}

function makeDeps(outcome: GitRunOutcome, probeOutcome: GitRunOutcome = { kind: 'ok', stdout: '', stderr: '' }) {
  const runGit = vi.fn((args: readonly string[], _cwd: string) =>
    Promise.resolve(args[0] === 'ls-files' ? probeOutcome : outcome)
  );
  const deps: GitCommitLogDeps = { runGit };
  return { deps, runGit };
}

describe('IDE-GIT-007 纯解析:pathAtCommit 沿重命名链', () => {
  it('中间重命名:新路径提交用新路径,老路径提交用老路径', () => {
    // 新→旧:c3(M src/current.txt) c2(R src/old.txt src/current.txt) c1(M src/old.txt)
    const stdout =
      record(rec('c3', '修改当前'), 'M\tsrc/current.txt') +
      record(rec('c2', '重命名'), 'R100\tsrc/old.txt\tsrc/current.txt') +
      record(rec('c1', '修改老'), 'M\tsrc/old.txt');
    const { entries: traced, boundary } = parseFollowCommitRecords('src/current.txt', stdout);
    expect(traced.map((e) => e.pathAtCommit)).toEqual(['src/current.txt', 'src/current.txt', 'src/old.txt']);
    expect(boundary).toBeNull();
  });

  it('多条重命名链:逐段切换追踪路径', () => {
    // c4(M b.txt) c3(R a.txt b.txt) c2(M a.txt) c1(R base.txt a.txt) c0(M base.txt)
    const stdout =
      record(rec('c4', '改 b'), 'M\tb.txt') +
      record(rec('c3', '改名 b'), 'R100\ta.txt\tb.txt') +
      record(rec('c2', '改 a'), 'M\ta.txt') +
      record(rec('c1', '改名 a'), 'R100\tbase.txt\ta.txt') +
      record(rec('c0', '改 base'), 'M\tbase.txt');
    const { entries: traced, boundary } = parseFollowCommitRecords('b.txt', stdout);
    expect(traced.map((e) => e.pathAtCommit)).toEqual(['b.txt', 'b.txt', 'a.txt', 'a.txt', 'base.txt']);
    expect(boundary).toBeNull();
  });
});

describe('IDE-GIT-007 纯解析:复制/移动边界如实标注', () => {
  it('最老提交以复制(C)收尾:copy-or-move 边界', () => {
    // c2(M new.txt) c1(C old.txt new.txt):--follow 无法沿复制链回溯
    const stdout = record(rec('c2', '改 new'), 'M\tnew.txt') + record(rec('c1', '复制自 old'), 'C75\told.txt\tnew.txt');
    const { entries: traced, boundary } = parseFollowCommitRecords('new.txt', stdout);
    expect(traced.map((e) => e.pathAtCommit)).toEqual(['new.txt', 'new.txt']);
    expect(boundary).toMatchObject({ kind: 'copy-or-move', atCommit: 'c1', atPath: 'old.txt' });
  });

  it('最老提交以删除(D)收尾:copy-or-move 边界(重命名未被识别为改名)', () => {
    const stdout = record(rec('c1', '删除'), 'D\tsrc/current.txt');
    const { entries: traced, boundary } = parseFollowCommitRecords('src/current.txt', stdout);
    expect(traced[0].pathAtCommit).toBe('src/current.txt');
    expect(boundary).toMatchObject({ kind: 'copy-or-move', atCommit: 'c1', atPath: 'src/current.txt' });
  });

  it('干净起点(A)不是边界', () => {
    const stdout = record(rec('c1', '新增'), 'A\tsrc/current.txt');
    const { boundary } = parseFollowCommitRecords('src/current.txt', stdout);
    expect(boundary).toBeNull();
  });
});

describe('IDE-GIT-007 查询面:follow 参数与边界门控', () => {
  it('follow=true 注入 --follow --name-status,结果带 pathAtCommit', async () => {
    const stdout =
      record(rec('c3', '改'), 'M\tsrc/current.txt') +
      record(rec('c2', '改名'), 'R100\tsrc/old.txt\tsrc/current.txt') +
      record(rec('c1', '改老'), 'M\tsrc/old.txt');
    const { deps, runGit } = makeDeps({ kind: 'ok', stdout, stderr: '' });
    const result = await queryGitCommitLog(
      { repoRoot: '/repo', filePath: '/repo/src/current.txt', follow: true },
      deps
    );
    expect(result.kind).toBe('page');
    if (result.kind === 'page') {
      expect(result.entries.map((e) => e.pathAtCommit)).toEqual([
        'src/current.txt',
        'src/current.txt',
        'src/old.txt',
      ]);
      expect(result.boundary).toBeNull();
    }
    const logArgs = runGit.mock.calls[0][0];
    expect(logArgs).toContain('--follow');
    expect(logArgs).toContain('--name-status');
  });

  it('follow=false(缺省)不注入 --follow,无 pathAtCommit', async () => {
    const stdout = record(rec('c1', '改'), 'M\tsrc/current.txt');
    const { deps, runGit } = makeDeps({ kind: 'ok', stdout, stderr: '' });
    const result = await queryGitCommitLog({ repoRoot: '/repo', filePath: '/repo/src/current.txt' }, deps);
    const logArgs = runGit.mock.calls[0][0];
    expect(logArgs).not.toContain('--follow');
    if (result.kind === 'page') {
      expect(result.entries[0].pathAtCommit).toBeUndefined();
      expect(result.boundary).toBeNull();
    }
  });

  it('还有下一页时边界不提前断言(最老记录是探测位)', async () => {
    // pageSize=2 请求,返回 3 条(2+1 探测),最后一条以 D 收尾但 hasMore=true
    const stdout =
      record(rec('c3', '最新'), 'M\tcurrent.txt') +
      record(rec('c2', '次新'), 'M\tcurrent.txt') +
      record(rec('c1', '老'), 'D\tcurrent.txt');
    const { deps } = makeDeps({ kind: 'ok', stdout, stderr: '' });
    const result = await queryGitCommitLog(
      { repoRoot: '/repo', filePath: '/repo/current.txt', follow: true, pageSize: 2 },
      deps
    );
    expect(result.kind).toBe('page');
    if (result.kind === 'page') {
      expect(result.hasMore).toBe(true);
      expect(result.boundary).toBeNull();
      expect(result.entries).toHaveLength(2);
    }
  });
});

describe('IDE-GIT-007 真实临时仓库:重命名链与跨仓库隔离', () => {
  function makeRepo(): string {
    const root = mkdtempSync(join(tmpdir(), 'kode-follow-'));
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'T'], { cwd: root });
    return root;
  }

  function commitAll(root: string, message: string): void {
    execFileSync('git', ['add', '-A'], { cwd: root });
    execFileSync('git', ['commit', '-q', '-m', message], { cwd: root });
  }

  it('git mv 重命名:重命名前后提交均入列,老路径提交 pathAtCommit=老路径', async () => {
    const root = makeRepo();
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'old.py'), 'x = 1\n');
    commitAll(root, 'create old');
    // 老路径改一次
    writeFileSync(join(root, 'src', 'old.py'), 'x = 2\n');
    commitAll(root, 'edit old');
    // 干净重命名 old→new
    execFileSync('git', ['mv', 'src/old.py', 'src/new.py'], { cwd: root });
    commitAll(root, 'rename old to new');
    // 新路径改一次
    writeFileSync(join(root, 'src', 'new.py'), 'x = 3\n');
    commitAll(root, 'edit new');

    const result = await queryGitCommitLog(
      { repoRoot: root, filePath: join(root, 'src', 'new.py'), follow: true },
      realDeps
    );
    expect(result.kind).toBe('page');
    if (result.kind === 'page') {
      const subjects = result.entries.map((e) => e.subject);
      // 重命名前后提交都在(4 条:create old/edit old/rename/edit new)
      expect(subjects).toEqual(['edit new', 'rename old to new', 'edit old', 'create old']);
      expect(result.entries.map((e) => e.pathAtCommit)).toEqual([
        'src/new.py',
        'src/new.py', // 重命名提交:该提交树上已是 new
        'src/old.py',
        'src/old.py',
      ]);
      expect(result.boundary).toBeNull();
      // 老路径提交的版本内容可经 git show <commit>:<老路径> 取到(跨重命名打开)
      const oldEdit = result.entries[2];
      const content = execFileSync('git', ['show', `${oldEdit.hash}:src/old.py`], { cwd: root })
        .toString()
        .trim();
      expect(content).toBe('x = 2');
    }
  });

  it('重命名边界翻页:不按当前路径重跑 skip,沿父提交+老路径续查', async () => {
    const root = makeRepo();
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'old.py'), 'x = 1\n');
    commitAll(root, 'create old');
    writeFileSync(join(root, 'src', 'old.py'), 'x = 2\n');
    commitAll(root, 'edit old');
    execFileSync('git', ['mv', 'src/old.py', 'src/new.py'], { cwd: root });
    commitAll(root, 'rename old to new');
    writeFileSync(join(root, 'src', 'new.py'), 'x = 3\n');
    commitAll(root, 'edit new');

    // pageSize=2:第一页=edit new + rename;下一页应=create/edit old,
    // 不能因 `git log --follow --skip=2 -- new.py` 在重命名边界断裂而漏掉老历史。
    const page1 = await queryGitCommitLog(
      { repoRoot: root, filePath: join(root, 'src', 'new.py'), follow: true, pageSize: 2 },
      realDeps
    );
    expect(page1.kind).toBe('page');
    if (page1.kind !== 'page') return;
    expect(page1.entries.map(e => e.subject)).toEqual(['edit new', 'rename old to new']);
    const renameCommit = page1.entries[1];
    expect(renameCommit.parentHash).toMatch(/^[0-9a-f]{40}$/);
    expect(renameCommit.pathAtCommit).toBe('src/new.py');
    expect(renameCommit.continuationPath).toBe('src/old.py');

    const page2 = await queryGitCommitLog(
      {
        repoRoot: root,
        filePath: join(root, 'src', 'new.py'),
        follow: true,
        page: 1,
        pageSize: 2,
        continuation: {
          parentCommit: renameCommit.parentHash,
          path: renameCommit.continuationPath,
        },
      },
      realDeps
    );
    expect(page2.kind).toBe('page');
    if (page2.kind !== 'page') return;
    expect(page2.entries.map(e => e.subject)).toEqual(['edit old', 'create old']);
    expect(page2.entries.map(e => e.pathAtCommit)).toEqual(['src/old.py', 'src/old.py']);
  });

  it('中文/需引号文件名:默认 quotepath 转义会被关掉,pathAtCommit 原样可开', async () => {
    const root = makeRepo();
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'old.py'), 'x = 1\n');
    commitAll(root, 'create old');
    execFileSync('git', ['mv', 'src/old.py', 'src/中文 文件.py'], { cwd: root });
    commitAll(root, 'rename to chinese');

    const result = await queryGitCommitLog(
      { repoRoot: root, filePath: join(root, 'src', '中文 文件.py'), follow: true },
      realDeps
    );
    expect(result.kind).toBe('page');
    if (result.kind !== 'page') return;
    expect(result.entries[0].pathAtCommit).toBe('src/中文 文件.py');
    expect(result.entries[1].pathAtCommit).toBe('src/old.py');
    // 老路径版本可经 git show <commit>:<old> 打开(路径非转义串)
    const oldEdit = result.entries[1];
    const content = execFileSync('git', ['show', `${oldEdit.hash}:src/old.py`], { cwd: root })
      .toString()
      .trim();
    expect(content).toBe('x = 1');
  });

  it('多仓库同名文件不串历史(repoRoot cwd 作用域)', async () => {
    const a = makeRepo();
    const b = makeRepo();
    writeFileSync(join(a, 'same.py'), 'a1\n');
    commitAll(a, 'a first');
    writeFileSync(join(b, 'same.py'), 'b1\n');
    commitAll(b, 'b first');

    const ra = await queryGitCommitLog({ repoRoot: a, filePath: join(a, 'same.py'), follow: true }, realDeps);
    const rb = await queryGitCommitLog({ repoRoot: b, filePath: join(b, 'same.py'), follow: true }, realDeps);
    expect(ra.kind).toBe('page');
    expect(rb.kind).toBe('page');
    if (ra.kind === 'page' && rb.kind === 'page') {
      expect(ra.entries.map((e) => e.subject)).toEqual(['a first']);
      expect(rb.entries.map((e) => e.subject)).toEqual(['b first']);
    }
  });
});
