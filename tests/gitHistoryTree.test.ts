import { describe, expect, it, vi } from 'vitest';
import {
  buildHistoryItems,
  GitHistoryTreeProvider,
  historyViewTitle,
  summarizeGitError,
  type GitHistoryDeps,
  type GitHistoryItem,
} from '../src/gitHistoryTree';
import type { GitCommitEntry } from '../src/gitCommitLog';
import type { GitRepoLocation } from '../src/gitRepoLocate';

/**
 * IDE-GIT-005:文件历史列表入口(侧边栏历史视图)。
 * 验收:资源管理器/编辑器右键与命令面板均能以「Kode：查看文件历史」打开正确
 * 文件(经命令体,本测试验证定位+查询+视图状态);视图呈现作者/时间/说明及
 * 下一页;标题明确文件与基准提交;无查询时显示引导且零 Git 调用;关闭功能时
 * 入口与查询均不活跃(disabled 短路,不定位不查询)。
 *
 * 纯状态机 + 薄 TreeDataProvider 包装(fake-vscode TreeItem 断言)。
 */

function entry(
  hash: string,
  subject: string,
  authorName = '作者甲',
  authorDate = '2026-11-01T10:00:00+08:00',
  body = ''
): GitCommitEntry {
  return { hash, authorName, authorEmail: 'jia@example.com', authorDate, commitDate: authorDate, subject, body };
}

function makeProvider(opts?: {
  location?: GitRepoLocation;
  pageResults?: Array<{ entries: GitCommitEntry[]; hasMore: boolean }>;
}) {
  const locate = vi.fn((_filePath: string, _enabled: boolean): GitRepoLocation => {
    if (opts?.location) return opts.location;
    return { kind: 'repo', repoRoot: '/repo', gitDir: '/repo/.git', isWorktree: false };
  });
  const results = opts?.pageResults ?? [{ entries: [entry('abc12345', '主题一')], hasMore: false }];
  const queryLog = vi.fn(
    async (_filePath: string, repoRoot: string, page: number, pageSize: number, _continuation?: unknown, _request?: unknown) => {
      const r = results[Math.min(page, results.length - 1)];
      return { kind: 'page', status: 'ok', entries: r.entries, hasMore: r.hasMore, page, pageSize } as const;
    }
  );
  const deps: GitHistoryDeps = { locateGitRepo: locate, queryLog, pageSize: 50 };
  const provider = new GitHistoryTreeProvider(deps);
  return { provider, deps, locate, queryLog };
}

describe('IDE-GIT-005 状态机(纯)', () => {
  it('空闲:显示操作引导,零 Git 调用', () => {
    const { provider, locate, queryLog } = makeProvider();
    const items = buildHistoryItems(provider.getState());
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('message');
    if (items[0].kind === 'message') expect(items[0].message).toContain('查看文件历史');
    expect(locate).not.toHaveBeenCalled();
    expect(queryLog).not.toHaveBeenCalled();
    expect(historyViewTitle(provider.getState())).toBe('文件历史');
  });

  it('装载:提交行(说明/作者·时间)+ 有下一页时补「加载下一页」', () => {
    const items = buildHistoryItems({
      kind: 'loaded',
      filePath: '/repo/src/a.py',
      repoRoot: '/repo',
      entries: [entry('h1', '主题一', '作者甲', '2026-11-01T10:00:00+08:00'), entry('h2', '主题二', '作者乙', '2026-11-02T10:00:00+08:00')],
      page: 0,
      pageSize: 50,
      hasMore: true,
    });
    const commits = items.filter((i): i is Extract<GitHistoryItem, { kind: 'commit' }> => i.kind === 'commit');
    expect(commits).toHaveLength(2);
    expect(commits[0].entry.subject).toBe('主题一');
    expect(items.some((i) => i.kind === 'next-page')).toBe(true);
  });

  it('未跟踪/已跟踪无历史/空仓库:各自明确警告', () => {
    expect(buildHistoryItems({ kind: 'untracked', filePath: '/repo/src/x.py' })[0]).toMatchObject({ kind: 'message' });
    expect(buildHistoryItems({ kind: 'no-history', filePath: '/repo/src/x.py' })[0]).toMatchObject({ kind: 'message' });
    expect(buildHistoryItems({ kind: 'no-commits' })[0]).toMatchObject({ kind: 'message' });
  });

  it('标题:文件名 @ 基准提交(最新一页顶条短哈希)', () => {
    const title = historyViewTitle({
      kind: 'loaded',
      filePath: '/repo/src/a.py',
      repoRoot: '/repo',
      entries: [entry('0123456789abcdef', 's')],
      page: 0,
      pageSize: 50,
      hasMore: false,
    });
    expect(title).toBe('a.py @ 01234567');
  });

  it('git 失败摘要:结构化结果 → 一行文案', () => {
    expect(summarizeGitError({ kind: 'exit', exitCode: 128, stderr: 'fatal: bad object\n' })).toContain('fatal: bad object');
    expect(summarizeGitError({ kind: 'timeout', timeoutMs: 10 })).toContain('超时');
    expect(summarizeGitError({ kind: 'cancelled' })).toContain('取消');
    expect(summarizeGitError({ kind: 'output-limit', limitBytes: 1, receivedBytes: 2 })).toContain('输出超限');
    expect(summarizeGitError({ kind: 'spawn', message: 'Git 进程启动失败:ENOENT' })).toContain('ENOENT');
    expect(summarizeGitError({ kind: 'invalid-args', reason: 'args 为空' })).toContain('参数被拒');
  });

  it('IDE-GIT-007:提交行按 pathAtCommit 定打开路径(重命名前老路径)', () => {
    const items = buildHistoryItems({
      kind: 'loaded',
      filePath: '/repo/src/new.py',
      repoRoot: '/repo',
      entries: [entry('h1', '改新'), { ...entry('h2', '改老'), pathAtCommit: 'src/old.py' }],
      page: 0,
      pageSize: 50,
      hasMore: false,
    });
    const commits = items.filter((i): i is Extract<GitHistoryItem, { kind: 'commit' }> => i.kind === 'commit');
    // 当前路径提交 → 打开当前路径;重命名前提交 → 打开老路径(绝对化)
    expect(commits[0].filePath).toBe('/repo/src/new.py');
    expect(commits[1].filePath).toBe('/repo/src/old.py');
  });

  it('IDE-GIT-007:到头且最老提交以复制/删除收尾 → 边界警告行', () => {
    const items = buildHistoryItems({
      kind: 'loaded',
      filePath: '/repo/src/new.py',
      repoRoot: '/repo',
      entries: [entry('h1', '改新')],
      page: 0,
      pageSize: 50,
      hasMore: false,
      boundary: { kind: 'copy-or-move', atCommit: 'abc12345', atPath: 'src/old.py' },
    });
    const warnings = items.filter((i) => i.kind === 'message');
    expect(warnings).toHaveLength(1);
    if (warnings[0].kind === 'message') {
      expect(warnings[0].message).toContain('复制/移动边界');
      expect(warnings[0].message).toContain('abc12345');
    }
  });

  it('IDE-GIT-007:还有下一页时边界不显示(未到头不断言)', () => {
    const items = buildHistoryItems({
      kind: 'loaded',
      filePath: '/repo/src/new.py',
      repoRoot: '/repo',
      entries: [entry('h1', '改新')],
      page: 0,
      pageSize: 50,
      hasMore: true,
      boundary: null,
    });
    expect(items.some((i) => i.kind === 'message')).toBe(false);
  });
});

describe('IDE-GIT-005 提供者(fake-vscode)', () => {
  it('showHistory 装载:状态含条目,首页查询 page=0', async () => {
    const { provider, queryLog } = makeProvider();
    await provider.showHistory('/repo/src/a.py', true);
    const state = provider.getState();
    expect(state.kind).toBe('loaded');
    if (state.kind === 'loaded') {
      expect(state.entries[0].subject).toBe('主题一');
      expect(state.repoRoot).toBe('/repo');
    }
    // IDE-GIT-011:首页显式查询绕过缓存(重新获取 HEAD),并携带视图级取消令牌。
    expect(queryLog).toHaveBeenCalledWith(
      '/repo/src/a.py',
      '/repo',
      0,
      50,
      undefined,
      expect.objectContaining({ bypassCache: true, token: expect.anything() })
    );
  });

  it('关闭功能:disabled 短路,不定位不查询(入口与查询均不活跃)', async () => {
    const { provider, locate, queryLog } = makeProvider();
    await provider.showHistory('/repo/src/a.py', false);
    expect(provider.getState().kind).toBe('error');
    expect(locate).not.toHaveBeenCalled();
    expect(queryLog).not.toHaveBeenCalled();
  });

  it('定位失败:结构化原因 → 明确反馈(不查询)', async () => {
    const { provider, queryLog } = makeProvider({ location: { kind: 'none', reason: 'no-workspace' } });
    await provider.showHistory('/elsewhere/a.py', true);
    expect(provider.getState()).toMatchObject({ kind: 'error', message: expect.stringContaining('工作区') });
    expect(queryLog).not.toHaveBeenCalled();
  });

  it('未跟踪:首页空 + ls-files 空 → untracked 状态', async () => {
    const queryLog = vi.fn(async () => ({ kind: 'untracked' }) as const);
    const deps: GitHistoryDeps = {
      locateGitRepo: () => ({ kind: 'repo', repoRoot: '/repo', gitDir: '/repo/.git', isWorktree: false }),
      queryLog,
      pageSize: 50,
    };
    const p2 = new GitHistoryTreeProvider(deps);
    await p2.showHistory('/repo/src/new.py', true);
    expect(p2.getState()).toEqual({ kind: 'untracked', filePath: '/repo/src/new.py' });
  });

  it('翻页:追加不重复;到底 hasMore=false;非装载态不查询', async () => {
    const { provider, queryLog } = makeProvider({
      pageResults: [
        { entries: [entry('h1', 's1'), entry('h2', 's2')], hasMore: true },
        { entries: [entry('h3', 's3')], hasMore: false },
      ],
    });
    await provider.showHistory('/repo/src/a.py', true);
    await provider.loadNextPage();
    const state = provider.getState();
    expect(state.kind).toBe('loaded');
    if (state.kind === 'loaded') {
      expect(state.entries.map((e) => e.hash)).toEqual(['h1', 'h2', 'h3']);
      expect(state.hasMore).toBe(false);
    }
    // 到底后再点:不查询
    const calls = queryLog.mock.calls.length;
    await provider.loadNextPage();
    expect(queryLog.mock.calls.length).toBe(calls);
  });

  it('TreeItem 映射:提交行/下一页命令/消息', () => {
    const { provider } = makeProvider();
    const commitItem = provider.getTreeItem({
      kind: 'commit',
      entry: entry('h1', '主题一', '作者甲'),
      index: 0,
      filePath: '/repo/src/a.py',
      repoRoot: '/repo',
      parentFilePath: '/repo/src/a.py',
    });
    expect(commitItem.label).toBe('主题一');
    expect(commitItem.description).toContain('作者甲');
    expect(commitItem.contextValue).toBe('gitCommit');
    expect(commitItem.tooltip).toContain('h1');
    // IDE-GIT-006:点击提交记录 → 打开该版本 vs 父版本只读 diff(参数=hash/文件/仓库/父路径)
    expect(commitItem.command?.command).toBe('kbengine.git.openVersionDiff');
    expect(commitItem.command?.arguments).toEqual(['h1', '/repo/src/a.py', '/repo', '/repo/src/a.py']);

    const next = provider.getTreeItem({ kind: 'next-page', loadedCount: 50 });
    expect(next.label).toContain('50');
    expect(next.command?.command).toBe('kbengine.git.historyNextPage');

    const msg = provider.getTreeItem({ kind: 'message', message: '尚未查询', tone: 'guidance' });
    expect(msg.label).toBe('尚未查询');
  });

  it('showUnavailable:给出 git 不可用的可操作提示', () => {
    const { provider } = makeProvider();
    provider.showUnavailable();
    const state = provider.getState();
    expect(state.kind).toBe('error');
    if (state.kind === 'error') expect(state.message).toMatch(/安装 Git|PATH/);
  });
});

describe('IDE-GIT-011 文件历史视图取消面', () => {
  it('视图隐藏(cancelInFlight):取消旧令牌并更换新令牌,重开可用', async () => {
    const tokens: Array<{ isCancellationRequested: boolean } | undefined> = [];
    const queryLog = vi.fn(
      async (
        _f: string,
        _r: string,
        _p: number,
        _s: number,
        _continuation?: unknown,
        request?: { token?: { isCancellationRequested: boolean } }
      ) => {
        tokens.push(request?.token as { isCancellationRequested: boolean } | undefined);
        return {
          kind: 'page',
          status: 'ok',
          entries: [entry('abc12345', '主题一')],
          hasMore: false,
          page: 0,
          pageSize: 50,
        } as const;
      }
    );
    const provider = new GitHistoryTreeProvider({
      locateGitRepo: () => ({ kind: 'repo', repoRoot: '/repo', gitDir: '/repo/.git', isWorktree: false }),
      queryLog,
      pageSize: 50,
    });
    await provider.showHistory('/repo/src/a.py', true);
    expect(tokens[0]?.isCancellationRequested).toBe(false);
    // 视图隐藏:取消当前在途查询(令牌置位,经协调门终止子进程)。
    provider.cancelInFlight();
    expect(tokens[0]?.isCancellationRequested).toBe(true);
    // 重开视图:新查询使用新令牌(未取消,功能仍可用)。
    await provider.showHistory('/repo/src/a.py', true);
    expect(tokens[1]).toBeDefined();
    expect(tokens[1]?.isCancellationRequested).toBe(false);
  });

  it('并发请求代际检查:先发起的慢查询回归时不覆盖用户刚选的文件历史', async () => {
    let resolveFirst!: (r: GitCommitLogResult) => void;
    let callCount = 0;
    const queryLog = vi.fn(
      async (): Promise<GitCommitLogResult> => {
        callCount += 1;
        if (callCount === 1) {
          return new Promise((resolve) => {
            resolveFirst = resolve;
          });
        }
        return {
          kind: 'page',
          status: 'ok',
          entries: [entry('h2', '新选择', '作者甲', '2026-11-01T10:00:00+08:00')],
          hasMore: false,
          page: 0,
          pageSize: 50,
        } as const;
      }
    );
    const provider = new GitHistoryTreeProvider({
      locateGitRepo: () => ({ kind: 'repo', repoRoot: '/repo', gitDir: '/repo/.git', isWorktree: false }),
      queryLog,
      pageSize: 50,
    });
    const first = provider.showHistory('/repo/src/a.py', true);
    const second = provider.showHistory('/repo/src/b.py', true);
    await second;
    let state = provider.getState();
    expect(state.kind).toBe('loaded');
    if (state.kind === 'loaded') {
      expect(state.filePath).toBe('/repo/src/b.py');
      expect(state.entries[0].subject).toBe('新选择');
    }
    // 先发起的查询此刻才回归:代际已更替,丢弃,不覆盖最新选择。
    resolveFirst({
      kind: 'page',
      status: 'ok',
      entries: [entry('h1', '旧选择', '作者乙', '2026-11-01T10:00:00+08:00')],
      hasMore: false,
      page: 0,
      pageSize: 50,
    });
    await first;
    state = provider.getState();
    expect(state.kind).toBe('loaded');
    if (state.kind === 'loaded') {
      expect(state.filePath).toBe('/repo/src/b.py'); // 仍是最新选择
      expect(state.entries[0].subject).toBe('新选择');
    }
  });
});
