import { describe, expect, it, vi } from 'vitest';
import { join } from 'path';
import {
  describeGitUnavailable,
  describeGitRepoLocation,
  locateGitRepository,
  type GitRepoLocationDeps,
  type GitRepoLocation,
} from '../src/gitRepoLocate';

/**
 * IDE-GIT-002:按文件定位所属 Git 仓库。
 * 验收:多工作区、嵌套仓库与 worktree 各用正确仓库;非 Git 文件给出明确反馈;
 * Git 不可用时有可操作提示;只在启用后的请求中定位。
 *
 * 测试替身:内存文件树,`.git` 条目标 'dir'|'file'|null;gitFiles 存 `.git`
 * 文件内容(gitdir: 指针);gitDirs 存目录集合(判定 commondir 存在)。
 */

interface FakeTree {
  markers: Record<string, 'dir' | 'file' | null>; // 路径(含 .git) -> 类型
  gitFiles: Record<string, string>; // .git 文件内容
  gitDirs: Set<string>; // 目录路径
}

function makeDeps(tree: FakeTree) {
  const deps: GitRepoLocationDeps = {
    probeGitMarker: vi.fn((dir: string) => tree.markers[join(dir, '.git')] ?? null),
    readGitFile: vi.fn((p: string) => tree.gitFiles[p] ?? null),
    isDirectory: vi.fn((p: string) => tree.gitDirs.has(p)),
  };
  return { deps, calls: { probe: deps.probeGitMarker as ReturnType<typeof vi.fn> } };
}

describe('IDE-GIT-002 定位所属 Git 仓库', () => {
  it('基本命中:目录含 .git 目录,repo 即该目录,gitDir=目录/.git,非 worktree', () => {
    const { deps } = makeDeps({
      markers: { [join('/ws/repo', '.git')]: 'dir' },
      gitFiles: {},
      gitDirs: new Set(),
    });
    const r = locateGitRepository('/ws/repo/src/a.py', ['/ws'], true, deps);
    expect(r).toEqual({ kind: 'repo', repoRoot: '/ws/repo', gitDir: '/ws/repo/.git', isWorktree: false });
  });

  it('嵌套仓库:最近命中优先(内层 repo 用内层 .git,不吃外层)', () => {
    const { deps } = makeDeps({
      markers: {
        [join('/ws', '.git')]: 'dir',
        [join('/ws/sub', '.git')]: 'dir',
      },
      gitFiles: {},
      gitDirs: new Set(),
    });
    const r = locateGitRepository('/ws/sub/src/a.py', ['/ws'], true, deps);
    expect(r).toEqual({ kind: 'repo', repoRoot: '/ws/sub', gitDir: '/ws/sub/.git', isWorktree: false });
  });

  it('多工作区:文件属最长前缀根,用该根内的仓库', () => {
    const { deps } = makeDeps({
      markers: { [join('/ws2/p', '.git')]: 'dir' },
      gitFiles: {},
      gitDirs: new Set(),
    });
    const r = locateGitRepository('/ws2/p/x.py', ['/ws1', '/ws2'], true, deps);
    expect(r).toEqual({ kind: 'repo', repoRoot: '/ws2/p', gitDir: '/ws2/p/.git', isWorktree: false });
  });

  it('worktree:.git 是文件(gitdir 指针)且 gitDir 含 commondir → isWorktree true,repoRoot=工作树根', () => {
    const wtGitDir = '/main/.git/worktrees/wt';
    const { deps } = makeDeps({
      markers: { [join('/main/wt', '.git')]: 'file' },
      gitFiles: { [join('/main/wt', '.git')]: `gitdir: ${wtGitDir}` },
      gitDirs: new Set([join(wtGitDir, 'commondir')]),
    });
    const r = locateGitRepository('/main/wt/src/a.py', ['/main'], true, deps);
    expect(r).toEqual({ kind: 'repo', repoRoot: '/main/wt', gitDir: wtGitDir, isWorktree: true });
  });

  it('子模块:.git 文件 gitdir 指针但 gitDir 无 commondir → 非 worktree,repoRoot=子模块目录', () => {
    const subGitDir = '/main/.git/modules/m';
    const { deps } = makeDeps({
      markers: { [join('/main/m', '.git')]: 'file' },
      gitFiles: { [join('/main/m', '.git')]: `gitdir: ${subGitDir}` },
      gitDirs: new Set(),
    });
    const r = locateGitRepository('/main/m/src/a.py', ['/main'], true, deps);
    expect(r).toEqual({ kind: 'repo', repoRoot: '/main/m', gitDir: subGitDir, isWorktree: false });
  });

  it('非 Git 文件:工作区内无任何 .git → none/outside-repo', () => {
    const { deps } = makeDeps({ markers: {}, gitFiles: {}, gitDirs: new Set() });
    const r = locateGitRepository('/ws/scripts/a.py', ['/ws'], true, deps);
    expect(r).toEqual({ kind: 'none', reason: 'outside-repo' });
  });

  it('文件不在任何工作区 → none/no-workspace', () => {
    const { deps } = makeDeps({ markers: {}, gitFiles: {}, gitDirs: new Set() });
    const r = locateGitRepository('/elsewhere/a.py', ['/ws'], true, deps);
    expect(r).toEqual({ kind: 'none', reason: 'no-workspace' });
  });

  it('关闭时不定位:返回 disabled 且不探测任何目录(只在启用后的请求中定位)', () => {
    const { deps, calls } = makeDeps({
      markers: { [join('/ws', '.git')]: 'dir' },
      gitFiles: {},
      gitDirs: new Set(),
    });
    const r = locateGitRepository('/ws/a.py', ['/ws'], false, deps);
    expect(r).toEqual({ kind: 'none', reason: 'disabled' });
    expect(calls.probe).not.toHaveBeenCalled();
  });

  it('不越过工作区根:根无 .git 时不吃根目录之外的 .git(根之上不探测)', () => {
    const { deps, calls } = makeDeps({
      markers: { [join('/', '.git')]: 'dir' }, // 根之外(父目录)有 .git
      gitFiles: {},
      gitDirs: new Set(),
    });
    const r = locateGitRepository('/ws/src/a.py', ['/ws'], true, deps);
    expect(r).toEqual({ kind: 'none', reason: 'outside-repo' });
    // 只探测 /ws/src 与 /ws 两级(到根为止),绝不探测 /ws 之上
    const probed = (calls.probe as any).mock.calls.map((c: any) => c[0]);
    expect(probed).toContain('/ws');
    expect(probed).not.toContain('/');
  });
});

describe('IDE-GIT-002 反馈文案', () => {
  it('非 Git 文件:明确反馈(不在任何 Git 仓库内)', () => {
    expect(describeGitRepoLocation({ kind: 'none', reason: 'outside-repo' })).toContain('不在任何 Git 仓库');
  });

  it('无工作区:明确反馈', () => {
    expect(describeGitRepoLocation({ kind: 'none', reason: 'no-workspace' })).toContain('工作区');
  });

  it('关闭:反馈关闭状态', () => {
    expect(describeGitRepoLocation({ kind: 'none', reason: 'disabled' })).toContain('关闭');
  });

  it('Git 不可用:可操作提示(引导安装/配置)', () => {
    const msg = describeGitUnavailable();
    expect(msg).toMatch(/安装 Git|Git 未|PATH|git/);
    expect(msg).toMatch(/重试|配置/);
  });

  it('仓库命中:反馈 repoRoot 与 worktree 标记', () => {
    const r: GitRepoLocation = { kind: 'repo', repoRoot: '/ws/repo', gitDir: '/ws/repo/.git', isWorktree: true };
    const msg = describeGitRepoLocation(r);
    expect(msg).toContain('/ws/repo');
    expect(msg).toContain('worktree');
  });
});
