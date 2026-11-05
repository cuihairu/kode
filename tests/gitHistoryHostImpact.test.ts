import { describe, expect, it, vi } from 'vitest';
import { GitHistoryTreeProvider, type GitHistoryDeps } from '../src/gitHistoryTree';
import { GitRangeHistoryTreeProvider, type RangeHistoryDeps } from '../src/gitRangeHistoryTree';
import { runGitHistoryWhenEnabled } from '../src/gitHistory';
import { GitQueryGate } from '../src/gitQueryGate';

// IDE-GIT-012:历史功能对宿主与语言服务影响的确定性证据(单元层)。
// 验收「默认开启未查询的 Git 调用/历史任务必须为零」与「查询不同步阻塞宿主」的
// 结构性前提:树 provider 构造 + 空闲 getChildren 绝不查询(查询只在用户入口
// showHistory/showSelectionHistory);查询门空闲零 spawn/零任务/零缓存;
// 禁用配置经 runGitHistoryWhenEnabled 短路 body,零 Git。真实编辑器三态 P95 与
// 宿主延迟另走 src/test/electron/suite/gitHistoryHostImpact.test.ts(同机同项目交替采样)。

const makeCountingDeps = (): {
  historyDeps: GitHistoryDeps;
  rangeDeps: RangeHistoryDeps;
  queryLog: ReturnType<typeof vi.fn>;
  mapSelection: ReturnType<typeof vi.fn>;
  queryTimeline: ReturnType<typeof vi.fn>;
} => {
  const queryLog = vi.fn();
  const mapSelection = vi.fn();
  const queryTimeline = vi.fn();
  return {
    queryLog,
    mapSelection,
    queryTimeline,
    historyDeps: {
      locateGitRepo: () => ({ kind: 'repo' as const, repoRoot: '/repo', gitDir: '/repo/.git', isWorktree: false }),
      queryLog,
      pageSize: 50,
    },
    rangeDeps: {
      locateGitRepo: () => ({ kind: 'repo' as const, repoRoot: '/repo', gitDir: '/repo/.git', isWorktree: false }),
      mapSelection,
      queryTimeline,
    },
  };
};

describe('IDE-GIT-012 默认开启未查询零 Git(确定性)', () => {
  it('文件历史树:构造 + 空闲 getChildren 只出引导,不查询', () => {
    const { historyDeps, queryLog } = makeCountingDeps();
    const provider = new GitHistoryTreeProvider(historyDeps);
    const items = provider.getChildren();
    expect(queryLog).not.toHaveBeenCalled();
    expect(items.length).toBeGreaterThan(0);
    expect(items[0]).toMatchObject({ kind: 'message' });
  });

  it('范围历史树:构造 + 空闲 getChildren + showNoSelection 不查询/不映射', () => {
    const { rangeDeps, mapSelection, queryTimeline } = makeCountingDeps();
    const provider = new GitRangeHistoryTreeProvider(rangeDeps);
    provider.getChildren();
    provider.showNoSelection();
    expect(mapSelection).not.toHaveBeenCalled();
    expect(queryTimeline).not.toHaveBeenCalled();
  });

  it('查询门空闲:零 spawn/零任务/零缓存', () => {
    const gate = new GitQueryGate();
    expect(gate.spawnCount()).toBe(0);
    expect(gate.runningCount()).toBe(0);
    expect(gate.queuedCount()).toBe(0);
    expect(gate.cacheCount()).toBe(0);
    expect(gate.cacheBytes()).toBe(0);
  });

  it('禁用配置:命令门短路 body,零 Git 执行面', () => {
    const body = vi.fn();
    runGitHistoryWhenEnabled(false, body);
    expect(body).not.toHaveBeenCalled();
    runGitHistoryWhenEnabled(true, body);
    expect(body).toHaveBeenCalledTimes(1);
  });
});
