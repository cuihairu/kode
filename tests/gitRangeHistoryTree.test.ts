import { describe, expect, it, vi } from 'vitest';
import {
  buildRangeHistoryItems,
  GitRangeHistoryTreeProvider,
  rangeHistoryViewTitle,
  type RangeHistoryDeps,
  type RangeHistoryItem,
} from '../src/gitRangeHistoryTree';
import type { RangeChangeEntry, RangeTimelineResult } from '../src/gitRangeTimeline';
import type { SelectionMapResult, SelectionRange } from '../src/gitSelectionMap';
import type { GitRepoLocation } from '../src/gitRepoLocate';

/**
 * IDE-GIT-010:展示选区历史并定位该次修改(侧边栏范围历史视图)。
 * 验收:选中代码后经「Kode：查看选中范围历史」→ 侧边栏显示对应范围时间线;
 * 点击条目在主编辑区打开对应版本 diff 并定位历史范围;展示查询基准提交与
 * 原选区;切换编辑器不错套选区且不自动重查;无选区时直接调用命令给出提示;
 * 两类命令均可绑定快捷键。
 *
 * 纯状态机(item 构造/标题)+ 薄 TreeDataProvider 包装(fake-vscode TreeItem
 * 断言);流程经依赖注入 mock(定位/映射/查询三面)。
 */

function entry(
  hash: string,
  subject: string,
  opts?: {
    authorName?: string;
    path?: string;
    rangeStart?: number;
    rangeEnd?: number;
    date?: string;
  }
): RangeChangeEntry {
  return {
    hash,
    authorName: opts?.authorName ?? '作者甲',
    authorEmail: 'jia@example.com',
    authorDate: opts?.date ?? '2026-11-01T10:00:00+08:00',
    commitDate: opts?.date ?? '2026-11-01T10:00:00+08:00',
    subject,
    path: opts?.path ?? 'src/a.py',
    rangeStart: opts?.rangeStart ?? 1,
    rangeEnd: opts?.rangeEnd ?? 3,
  };
}

function repoLocation(): GitRepoLocation {
  return { kind: 'repo', repoRoot: '/repo', gitDir: '/repo/.git', isWorktree: false };
}

/** mock 三面依赖 + 直接实例化(与 gitHistoryTree.test.ts makeProvider 同构)。 */
function makeProvider(opts?: {
  location?: GitRepoLocation;
  mapped?: SelectionMapResult;
  timeline?: RangeTimelineResult;
}) {
  const locateGitRepo = vi.fn((_filePath: string, _enabled: boolean): GitRepoLocation => {
    if (opts?.location) return opts.location;
    return repoLocation();
  });
  const mapSelection = vi.fn(
    async (_filePath: string, _repoRoot: string, _range: SelectionRange): Promise<SelectionMapResult> => {
      if (opts?.mapped) return opts.mapped;
      return {
        kind: 'mapped',
        segments: [{ firstLine: 1, lastLine: 3, headFirstLine: 1, headLastLine: 3 }],
        selectionLineCount: 3,
      };
    }
  );
  const queryTimeline = vi.fn(
    async (_filePath: string, _repoRoot: string, _range: SelectionRange): Promise<RangeTimelineResult> => {
      if (opts?.timeline) return opts.timeline;
      return {
        kind: 'timeline',
        status: 'ok',
        entries: [entry('abc12345', '主题一')],
        boundary: { kind: 'origin', atCommit: 'abc12345', atPath: 'src/a.py' },
      };
    }
  );
  const deps: RangeHistoryDeps = { locateGitRepo, mapSelection, queryTimeline };
  const provider = new GitRangeHistoryTreeProvider(deps);
  return { provider, deps, locateGitRepo, mapSelection, queryTimeline };
}

describe('IDE-GIT-010 状态机(纯)', () => {
  it('空闲:显示操作引导', () => {
    const items = buildRangeHistoryItems({ kind: 'idle' });
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('message');
    if (items[0].kind === 'message') {
      expect(items[0].message).toContain('查看选中范围历史');
      expect(items[0].tone).toBe('guidance');
    }
    expect(rangeHistoryViewTitle({ kind: 'idle' })).toBe('选区历史');
  });

  it('装载:条目按 entries 顺序,末条追加上边界说明行', () => {
    const items = buildRangeHistoryItems({
      kind: 'loaded',
      filePath: '/repo/src/a.py',
      repoRoot: '/repo',
      headStart: 1,
      headEnd: 3,
      selectionStart: 1,
      selectionEnd: 3,
      entries: [entry('h1', '改一'), entry('h2', '改二', { path: 'src/old.py' })],
      boundary: { kind: 'origin', atCommit: 'h2', atPath: 'src/old.py' },
      unmappedLines: 0,
    });
    const entries = items.filter((i): i is Extract<RangeHistoryItem, { kind: 'entry' }> => i.kind === 'entry');
    expect(entries).toHaveLength(2);
    expect(entries[0].entry.subject).toBe('改一');
    // 条目绝对路径(沿重命名:老提交记老路径)
    expect(entries[0].filePath).toBe('/repo/src/a.py');
    expect(entries[1].filePath).toBe('/repo/src/old.py');
    // 父路径 = 更老一条的路径(重命名提交的父侧在老路径)
    expect(entries[0].parentFilePath).toBe('/repo/src/old.py');
    expect(entries[1].parentFilePath).toBe('/repo/src/old.py');
    const tail = items[items.length - 1];
    expect(tail.kind).toBe('message');
    if (tail.kind === 'message') {
      expect(tail.message).toContain('已追溯到行段引入处');
      expect(tail.message).toContain('h2');
    }
  });

  it('装载且有未映射行:顶部警告,时间线仅已提交部分', () => {
    const items = buildRangeHistoryItems({
      kind: 'loaded',
      filePath: '/repo/src/a.py',
      repoRoot: '/repo',
      headStart: 1,
      headEnd: 1,
      selectionStart: 1,
      selectionEnd: 5,
      entries: [entry('h1', '改一')],
      boundary: { kind: 'origin', atCommit: 'h1', atPath: 'src/a.py' },
      unmappedLines: 4,
    });
    const first = items[0];
    expect(first.kind).toBe('message');
    if (first.kind === 'message') {
      expect(first.message).toContain('4 行');
      expect(first.message).toContain('未提交');
      expect(first.tone).toBe('warning');
    }
  });

  it('stopped 边界:如实标注不代表完整历史', () => {
    const items = buildRangeHistoryItems({
      kind: 'loaded',
      filePath: '/repo/src/a.py',
      repoRoot: '/repo',
      headStart: 1,
      headEnd: 1,
      selectionStart: 1,
      selectionEnd: 1,
      entries: [entry('h1', '改一')],
      boundary: { kind: 'stopped', atCommit: 'h1', atPath: 'src/a.py' },
      unmappedLines: 0,
    });
    const tail = items[items.length - 1];
    if (tail.kind === 'message') {
      expect(tail.message).toContain('不代表完整历史');
      expect(tail.tone).toBe('warning');
    }
  });

  it('标题:文件 @ HEAD 行 N-M(查询基准);非装载态回缺省', () => {
    expect(
      rangeHistoryViewTitle({
        kind: 'loaded',
        filePath: '/repo/src/a.py',
        repoRoot: '/repo',
        headStart: 2,
        headEnd: 7,
        selectionStart: 3,
        selectionEnd: 8,
        entries: [],
        boundary: { kind: 'origin', atCommit: '', atPath: '' },
        unmappedLines: 0,
      })
    ).toBe('a.py @ HEAD 行 2-7');
    expect(rangeHistoryViewTitle({ kind: 'loading' })).toBe('选区历史');
    expect(rangeHistoryViewTitle({ kind: 'error', message: 'x' })).toBe('选区历史');
  });

  it('无选区/未跟踪/无提交/无效/错误:各自明确提示', () => {
    expect(buildRangeHistoryItems({ kind: 'no-selection' })[0]).toMatchObject({ kind: 'message', tone: 'guidance' });
    expect(buildRangeHistoryItems({ kind: 'untracked' })[0]).toMatchObject({ kind: 'message', tone: 'warning' });
    expect(buildRangeHistoryItems({ kind: 'no-commits' })[0]).toMatchObject({ kind: 'message', tone: 'warning' });
    expect(buildRangeHistoryItems({ kind: 'invalid', message: '二进制文件' })[0]).toMatchObject({
      kind: 'message',
      message: '二进制文件',
    });
    expect(buildRangeHistoryItems({ kind: 'error', message: 'git 没了' })[0]).toMatchObject({
      kind: 'message',
      message: 'git 没了',
    });
  });

  it('has-uncommitted 全未提交:如实警告', () => {
    const items = buildRangeHistoryItems({ kind: 'has-uncommitted', message: '选区 5 行均未提交' });
    expect(items[0]).toMatchObject({ kind: 'message', message: '选区 5 行均未提交', tone: 'warning' });
  });
});

describe('IDE-GIT-010 提供者(依赖注入 mock)', () => {
  it('装载:HEAD 行段=映射段并集,原选区=传入选区,条目与边界入状态', async () => {
    const { provider, mapSelection, queryTimeline } = makeProvider();
    await provider.showSelectionHistory('/repo/src/a.py', { startLine: 3, endLine: 8 }, true);
    const state = provider.getState();
    expect(state.kind).toBe('loaded');
    if (state.kind === 'loaded') {
      expect(state.filePath).toBe('/repo/src/a.py');
      expect(state.repoRoot).toBe('/repo');
      expect(state.headStart).toBe(1);
      expect(state.headEnd).toBe(3);
      expect(state.selectionStart).toBe(3);
      expect(state.selectionEnd).toBe(8);
      expect(state.entries[0].subject).toBe('主题一');
      expect(state.boundary.kind).toBe('origin');
    }
    expect(mapSelection).toHaveBeenCalledWith('/repo/src/a.py', '/repo', { startLine: 3, endLine: 8 });
    expect(queryTimeline).toHaveBeenCalledWith('/repo/src/a.py', '/repo', { startLine: 1, endLine: 3 });
  });

  it('多段映射:并集传入查询(跨段并集,不逐段查询)', async () => {
    const { provider, queryTimeline } = makeProvider({
      mapped: {
        kind: 'mapped',
        segments: [
          { firstLine: 1, lastLine: 1, headFirstLine: 2, headLastLine: 2 },
          { firstLine: 3, lastLine: 3, headFirstLine: 9, headLastLine: 9 },
        ],
        selectionLineCount: 3,
      },
    });
    await provider.showSelectionHistory('/repo/src/a.py', { startLine: 1, endLine: 3 }, true);
    expect(queryTimeline).toHaveBeenCalledWith('/repo/src/a.py', '/repo', { startLine: 2, endLine: 9 });
    const state = provider.getState();
    if (state.kind === 'loaded') {
      expect(state.headStart).toBe(2);
      expect(state.headEnd).toBe(9);
    }
  });

  it('has-uncommitted 且有已提交段:装载 + 未映射行数如实', async () => {
    const { provider } = makeProvider({
      mapped: {
        kind: 'has-uncommitted',
        segments: [{ firstLine: 1, lastLine: 2, headFirstLine: 1, headLastLine: 2 }],
        unmappedLines: 3,
        selectionLineCount: 5,
      },
    });
    await provider.showSelectionHistory('/repo/src/a.py', { startLine: 1, endLine: 5 }, true);
    const state = provider.getState();
    expect(state.kind).toBe('loaded');
    if (state.kind === 'loaded') expect(state.unmappedLines).toBe(3);
  });

  it('has-uncommitted 全未提交:警告,不查询', async () => {
    const { provider, queryTimeline } = makeProvider({
      mapped: { kind: 'has-uncommitted', segments: [], unmappedLines: 5, selectionLineCount: 5 },
    });
    await provider.showSelectionHistory('/repo/src/a.py', { startLine: 1, endLine: 5 }, true);
    expect(provider.getState()).toMatchObject({ kind: 'has-uncommitted', message: expect.stringContaining('5 行') });
    expect(queryTimeline).not.toHaveBeenCalled();
  });

  it('关闭功能:disabled 短路,不定位不映射不查询', async () => {
    const { provider, locateGitRepo, mapSelection, queryTimeline } = makeProvider();
    await provider.showSelectionHistory('/repo/src/a.py', { startLine: 1, endLine: 1 }, false);
    expect(provider.getState()).toMatchObject({ kind: 'error', message: '历史功能已关闭' });
    expect(locateGitRepo).not.toHaveBeenCalled();
    expect(mapSelection).not.toHaveBeenCalled();
    expect(queryTimeline).not.toHaveBeenCalled();
  });

  it('定位失败:结构化原因 → 明确反馈(不映射不查询)', async () => {
    const { provider, mapSelection, queryTimeline } = makeProvider({
      location: { kind: 'none', reason: 'no-workspace' },
    });
    await provider.showSelectionHistory('/elsewhere/a.py', { startLine: 1, endLine: 1 }, true);
    expect(provider.getState()).toMatchObject({ kind: 'error', message: expect.stringContaining('工作区') });
    expect(mapSelection).not.toHaveBeenCalled();
    expect(queryTimeline).not.toHaveBeenCalled();
  });

  it('映射终态:未跟踪/无提交/二进制/无效选区/git 错误 → 各自状态,不查询', async () => {
    const cases: Array<[SelectionMapResult, unknown]> = [
      [{ kind: 'untracked' }, { kind: 'untracked' }],
      [{ kind: 'no-commits' }, { kind: 'no-commits' }],
      [{ kind: 'binary' }, { kind: 'invalid', message: expect.stringContaining('二进制') }],
      [{ kind: 'invalid-selection', reason: '行号倒置' }, { kind: 'invalid', message: '行号倒置' }],
      [
        { kind: 'git-error', outcome: { kind: 'timeout', timeoutMs: 10 } },
        { kind: 'error', message: expect.stringContaining('映射失败') },
      ],
    ];
    for (const [mapped, expected] of cases) {
      const { provider, queryTimeline } = makeProvider({ mapped });
      await provider.showSelectionHistory('/repo/src/a.py', { startLine: 1, endLine: 1 }, true);
      expect(provider.getState()).toMatchObject(expected as Record<string, unknown>);
      expect(queryTimeline).not.toHaveBeenCalled();
    }
  });

  it('查询终态:invalid-range/未跟踪/无提交/git 错误 → 各自状态', async () => {
    const cases: Array<[RangeTimelineResult, unknown]> = [
      [{ kind: 'invalid-range', reason: 'file 越界' }, { kind: 'invalid', message: 'file 越界' }],
      [{ kind: 'untracked' }, { kind: 'untracked' }],
      [{ kind: 'no-commits' }, { kind: 'no-commits' }],
      [
        { kind: 'git-error', outcome: { kind: 'exit', exitCode: 128, stderr: 'fatal: bad object\n' } },
        { kind: 'error', message: expect.stringContaining('查询失败') },
      ],
    ];
    for (const [timeline, expected] of cases) {
      const { provider } = makeProvider({ timeline });
      await provider.showSelectionHistory('/repo/src/a.py', { startLine: 1, endLine: 1 }, true);
      expect(provider.getState()).toMatchObject(expected as Record<string, unknown>);
    }
  });

  it('no-selection / unavailable:直接提示,零 Git 调用', () => {
    const { provider, locateGitRepo, mapSelection, queryTimeline } = makeProvider();
    provider.showNoSelection();
    expect(provider.getState().kind).toBe('no-selection');
    provider.showUnavailable('Git 不可用');
    expect(provider.getState()).toEqual({ kind: 'error', message: 'Git 不可用' });
    expect(locateGitRepo).not.toHaveBeenCalled();
    expect(mapSelection).not.toHaveBeenCalled();
    expect(queryTimeline).not.toHaveBeenCalled();
  });
});

describe('IDE-GIT-010 TreeItem 映射(fake-vscode)', () => {
  it('条目行:说明=作者·时间,命令=打开版本差异并定位(参数含 entry/路径/仓库/父路径)', () => {
    const { provider } = makeProvider();
    const item = provider.getTreeItem({
      kind: 'entry',
      entry: entry('h1', '改一', { authorName: '乙', path: 'src/old.py', rangeStart: 2, rangeEnd: 5 }),
      filePath: '/repo/src/old.py',
      repoRoot: '/repo',
      parentFilePath: '/repo/src/new.py',
    });
    expect(item.label).toBe('改一');
    expect(item.description).toContain('乙');
    expect(item.contextValue).toBe('gitRangeEntry');
    expect(item.tooltip).toContain('h1');
    expect(item.tooltip).toContain('行 2-5');
    expect(item.command?.command).toBe('kbengine.git.openRangeHistoryDiff');
    const args = item.command?.arguments as unknown[];
    expect(args).toHaveLength(4);
    expect(args[0]).toMatchObject({ hash: 'h1', rangeStart: 2, rangeEnd: 5 });
    expect(args[1]).toBe('/repo/src/old.py');
    expect(args[2]).toBe('/repo');
    expect(args[3]).toBe('/repo/src/new.py');
  });

  it('消息行:label=文案,警告行带 contextValue', () => {
    const { provider } = makeProvider();
    const warn = provider.getTreeItem({ kind: 'message', message: '选区未提交', tone: 'warning' });
    expect(warn.label).toBe('选区未提交');
    expect(warn.contextValue).toBe('gitRangeHistoryWarning');
    const guide = provider.getTreeItem({ kind: 'message', message: '尚未查询', tone: 'guidance' });
    expect(guide.label).toBe('尚未查询');
    expect(guide.contextValue).toBeUndefined();
  });
});
