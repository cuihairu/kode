import { describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import {
  describeGitUnavailable,
  describeGitRepoLocation,
  locateGitRepository,
  realGitRepoLocationDeps,
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

/** WIN-3:夹具键归一为 / 形态——src 按输入风格选 path.posix/win32(见 pathApiFor),
 * 桌平台 join 产的 \ 键在 win32 上会与 POSIX 形态入参错配;两侧归一后等价。 */
const normKey = (p: string): string => p.replace(/\\/g, '/');

function makeDeps(tree: FakeTree) {
  const markers: Record<string, 'dir' | 'file' | null> = {};
  for (const [k, v] of Object.entries(tree.markers)) markers[normKey(k)] = v;
  const gitFiles: Record<string, string> = {};
  for (const [k, v] of Object.entries(tree.gitFiles)) gitFiles[normKey(k)] = v;
  const gitDirs = new Set([...tree.gitDirs].map(normKey));
  const deps: GitRepoLocationDeps = {
    probeGitMarker: vi.fn((dir: string) => markers[normKey(join(dir, '.git'))] ?? null),
    readGitFile: vi.fn((p: string) => gitFiles[normKey(p)] ?? null),
    isDirectory: vi.fn((p: string) => gitDirs.has(normKey(p))),
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

  it('嵌套工作区根:文件同时命中多根 → 最长前缀根胜出(排序比较器生效)', () => {
    const { deps } = makeDeps({
      markers: { [join('/ws/sub', '.git')]: 'dir' },
      gitFiles: {},
      gitDirs: new Set(),
    });
    // 文件同时落在 /ws 与 /ws/sub 两根下:sort 比较器必须跑且取更长前缀
    const r = locateGitRepository('/ws/sub/x.py', ['/ws', '/ws/sub'], true, deps);
    expect(r).toEqual({ kind: 'repo', repoRoot: '/ws/sub', gitDir: '/ws/sub/.git', isWorktree: false });
  });
});

describe('IDE-GIT-002 真实 fs 依赖面', () => {
  it('realGitRepoLocationDeps:目录/文件/缺失 .git、读指针命中与缺失、判目录', () => {
    const dir = fs.mkdtempSync(join(os.tmpdir(), 'kode-git-locate-real-'));
    try {
      // .git 目录形态
      const withDir = join(dir, 'repo-dir');
      fs.mkdirSync(join(withDir, '.git'), { recursive: true });
      // .git 文件形态(worktree 指针)
      const withFile = join(dir, 'repo-wt');
      fs.mkdirSync(withFile, { recursive: true });
      fs.writeFileSync(join(withFile, '.git'), 'gitdir: /else/main/.git/worktrees/wt', 'utf8');
      const deps = realGitRepoLocationDeps();
      expect(deps.probeGitMarker(withDir)).toBe('dir');
      expect(deps.probeGitMarker(withFile)).toBe('file');
      expect(deps.probeGitMarker(join(dir, 'no-such'))).toBeNull();
      // 读指针:命中与缺失
      expect(deps.readGitFile(join(withFile, '.git'))).toContain('gitdir:');
      expect(deps.readGitFile(join(dir, 'no-such', '.git'))).toBeNull();
      // 判目录:目录 true;文件与缺失 false
      expect(deps.isDirectory(withDir)).toBe(true);
      expect(deps.isDirectory(join(withFile, '.git'))).toBe(false);
      expect(deps.isDirectory(join(dir, 'no-such'))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('realGitRepoLocationDeps 装配后走通端到端定位(tmp 目录真 .git)', () => {
    const root = fs.mkdtempSync(join(os.tmpdir(), 'kode-git-locate-e2e-'));
    try {
      fs.mkdirSync(join(root, 'scripts'), { recursive: true });
      fs.mkdirSync(join(root, '.git'), { recursive: true });
      const r = locateGitRepository(join(root, 'scripts', 'a.py'), [root], true, realGitRepoLocationDeps());
      expect(r.kind).toBe('repo');
      if (r.kind === 'repo') {
        expect(r.repoRoot).toBe(root);
        expect(r.isWorktree).toBe(false);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
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
