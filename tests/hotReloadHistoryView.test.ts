import { beforeEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import {
  HOT_RELOAD_HISTORY_PANEL_COMMAND,
  HOT_RELOAD_HISTORY_SEARCH_COMMAND,
  HOT_RELOAD_HISTORY_STATE_KEY,
  renderHistoryPanelHtml,
  setupHotReloadHistoryView,
  translateDeliveryRecord,
  type HotReloadNamesResolver
} from '../src/hotReloadHistoryView';
import { HotReloadHistoryCore, type HotReloadHistoryEntry } from '../src/backend/hotReloadHistoryCore';
import { buildHotReloadTargetKeyId, type HotReloadDeliveryRecord } from '../src/backend/hotReloadTargetState';
import { panelRegistry, windowState } from './helpers/vscodeStub';
import { treeRegistrations } from './fake-vscode/windowState';

// HR-PR-06 装配钉:台账记录→历史行翻译(requestId 同执行稳定/状态三态如实
// 不拔高)+树三组(最近/按文件/按目标,同路径不同 target 分行)+搜索过滤+
// 节流刷新(窗内合并,面板开即时)+历史面板(过滤/分页/加载更多)+持久化
// 回载(形状不符如实丢弃)+面板关闭不停 feed(HR-UI-012)+dispose 清钟。

interface TestNode {
  kind: string;
  label?: string;
  groupKind?: string;
  entry?: HotReloadHistoryEntry;
  rows?: HotReloadHistoryEntry[];
}

interface TestProvider {
  onDidChangeTreeData: vscode.Event<TestNode | undefined | null | void>;
  getTreeItem(node: TestNode): vscode.TreeItem;
  getChildren(node?: TestNode): TestNode[];
}

const FILE_A = '/ws/scripts/entities/fight/FightAI.py';
const FILE_B = '/ws/scripts/entities/spawn/Spawner.py';

const recordOf = (overrides: Partial<HotReloadDeliveryRecord> = {}): HotReloadDeliveryRecord => ({
  rootId: 'r1',
  targetId: '',
  file: FILE_A,
  outcome: 'accepted',
  recordedAt: 1700000000000,
  attempt: 1,
  ...overrides
});

const resolver: HotReloadNamesResolver = file =>
  file.endsWith('Spawner.py')
    ? { fullModule: 'entities.spawn.Spawner', requestModule: 'spawn.Spawner' }
    : { fullModule: 'entities.fight.FightAI', requestModule: 'fight.FightAI' };

const contextOf = (): vscode.ExtensionContext =>
  ({ subscriptions: [] as Array<{ dispose(): void }> } as unknown as vscode.ExtensionContext);

/** 假钟:手动 advance 触发;clear 置 cleared;pendingCount=未触发未清数 */
const makeTimers = () => {
  let seq = 0;
  const pending = new Map<number, { cb: () => void; cleared: boolean; fired: boolean }>();
  return {
    set: (cb: () => void, _ms: number): number => {
      const id = ++seq;
      pending.set(id, { cb, cleared: false, fired: false });
      return id;
    },
    clear: (handle: unknown): void => {
      const entry = pending.get(handle as number);
      if (entry) {
        entry.cleared = true;
      }
    },
    advance: (): void => {
      for (const entry of [...pending.values()]) {
        if (!entry.cleared && !entry.fired) {
          entry.fired = true;
          entry.cb();
        }
      }
    },
    pendingCount: (): number => [...pending.values()].filter(entry => !entry.cleared && !entry.fired).length
  };
};

const lastProvider = (): TestProvider => {
  const registration = treeRegistrations[treeRegistrations.length - 1];
  return registration?.provider as unknown as TestProvider;
};

describe('translateDeliveryRecord(HR-PR-06 台账→历史行翻译)', () => {
  it('requestId 同执行稳定=目标键/文件名#代际;状态三态如实(accepted 不拔高);双名与错误摘要透传', () => {
    const sent = translateDeliveryRecord(recordOf(), resolver);
    expect(sent.requestId).toBe(`${buildHotReloadTargetKeyId({ rootId: 'r1', targetId: '' })}/FightAI.py#1`);
    expect(sent.status).toBe('sent-unverified');
    expect(sent.fullModule).toBe('entities.fight.FightAI');
    expect(sent.requestModule).toBe('fight.FightAI');
    expect(sent.fileUri).toBe(FILE_A);
    expect(sent.time).toBe(1700000000000);
    expect(sent.errorSummary).toBeUndefined();

    expect(translateDeliveryRecord(recordOf({ outcome: 'applied' }), resolver).status).toBe('applied');
    const failed = translateDeliveryRecord(recordOf({ outcome: 'failed', detail: 'HTTP 500' }), resolver);
    expect(failed.status).toBe('failed');
    expect(failed.errorSummary).toBe('HTTP 500');

    // 代际进 requestId:新代际=新行,回执升级=同 id
    const nextAttempt = translateDeliveryRecord(recordOf({ attempt: 2 }), resolver);
    expect(nextAttempt.requestId.endsWith('#2')).toBe(true);
    expect(nextAttempt.requestId).not.toBe(sent.requestId);
  });

  it('回执升级幂等原位替换:同代际发送+回执两次 record 只一行,状态如实推进', () => {
    const core = new HotReloadHistoryCore();
    core.record(translateDeliveryRecord(recordOf({ outcome: 'accepted' }), resolver));
    core.record(translateDeliveryRecord(recordOf({ outcome: 'applied', recordedAt: 1700000001000 }), resolver));
    expect(core.size()).toBe(1);
    expect(core.entries()[0].status).toBe('applied');
    expect(core.entries()[0].requestId).toBe(`${buildHotReloadTargetKeyId({ rootId: 'r1', targetId: '' })}/FightAI.py#1`);
  });
});

describe('setupHotReloadHistoryView 树装配(HR-UI-002/010/014)', () => {
  beforeEach(() => {
    windowState.reset();
    panelRegistry.reset();
  });

  it('受限宿主退化为 registerTreeDataProvider:视图登记;根三组=最近/按文件/按目标', () => {
    setupHotReloadHistoryView(contextOf(), { core: new HotReloadHistoryCore(), resolveNames: resolver });
    expect(treeRegistrations).toHaveLength(1);
    expect(treeRegistrations[0].viewId).toBe('kbengine.hotReloadHistory');
    const provider = lastProvider();
    const root = provider.getChildren();
    expect(root.map(node => node.label)).toEqual(['最近更新', '按文件', '按目标']);
    expect(root.map(node => node.kind)).toEqual(['group', 'group', 'group']);
  });

  it('最近更新组最新在前;行节点标题=fullModule,description 带状态与目标,tooltip 双名/file/target/requestId', () => {
    const feed = setupHotReloadHistoryView(contextOf(), { core: new HotReloadHistoryCore(), resolveNames: resolver });
    feed.handle(recordOf({ file: FILE_A, recordedAt: 1000 }));
    feed.handle(recordOf({ file: FILE_B, recordedAt: 2000 }));
    const provider = lastProvider();
    const recent = provider.getChildren(provider.getChildren()[0]);
    expect(recent.map(node => node.entry?.fileUri)).toEqual([FILE_B, FILE_A]);
    const item = provider.getTreeItem(recent[0]);
    expect(item.label).toBe('entities.spawn.Spawner');
    expect(item.description).toContain('sent-unverified');
    const tooltip = String(item.tooltip);
    expect(tooltip).toContain('requestModule: spawn.Spawner');
    expect(tooltip).toContain(`file: ${FILE_B}`);
    expect(tooltip).toContain('target: (default)');
    expect(tooltip).toContain('requestId: ');
  });

  it('按文件/按目标键组:同路径不同 target 分行(HR-UI-010/014),键组内行数入账', () => {
    const feed = setupHotReloadHistoryView(contextOf(), { core: new HotReloadHistoryCore(), resolveNames: resolver });
    feed.handle(recordOf({ file: FILE_A, targetId: '' }));
    feed.handle(recordOf({ file: FILE_A, targetId: 'cell-1' }));
    feed.handle(recordOf({ file: FILE_B, targetId: '' }));
    const provider = lastProvider();
    const root = provider.getChildren();
    const fileGroups = provider.getChildren(root[1]);
    expect(fileGroups.map(node => node.label).sort()).toEqual([FILE_A, FILE_B].sort());
    expect(provider.getChildren(root[1]).length).toBe(2);
    const targetGroups = provider.getChildren(root[2]);
    expect(targetGroups.map(node => node.label).sort()).toEqual(['', 'cell-1'].sort());
    // 同路径(FILE_A)两个 target 各自成组,组内各 1 行
    const cellGroup = targetGroups.find(node => node.label === 'cell-1');
    expect(cellGroup?.rows).toHaveLength(1);
    expect(cellGroup?.rows?.[0].targetId).toBe('cell-1');
  });

  it('节流刷新(HR-UI-007):窗内多次台账事件合并一次 fire;dispose 清 pending 钟', () => {
    const timers = makeTimers();
    const context = contextOf();
    const feed = setupHotReloadHistoryView(context, { core: new HotReloadHistoryCore(), resolveNames: resolver, timers, refreshWindowMs: 500 });
    const provider = lastProvider();
    let fires = 0;
    provider.onDidChangeTreeData(() => {
      fires += 1;
    });
    feed.handle(recordOf());
    feed.handle(recordOf({ file: FILE_B }));
    feed.handle(recordOf({ attempt: 2 }));
    expect(fires).toBe(0);
    expect(timers.pendingCount()).toBe(1);
    timers.advance();
    expect(fires).toBe(1);
    expect(timers.pendingCount()).toBe(0);

    // dispose 后 pending 清空:再 handle 也不产生可触发的钟
    for (const disposable of context.subscriptions) {
      disposable.dispose();
    }
    expect(timers.pendingCount()).toBe(0);
  });

  it('搜索命令(HR-UI-010):输入子串过滤树(大小写不敏),留空清除,取消不动', async () => {
    const savedWindow = vscode.window as unknown as Record<string, unknown>;
    const originalInputBox = savedWindow.showInputBox;
    try {
      const feed = setupHotReloadHistoryView(contextOf(), { core: new HotReloadHistoryCore(), resolveNames: resolver });
      feed.handle(recordOf({ file: FILE_A }));
      feed.handle(recordOf({ file: FILE_B }));
      const provider = lastProvider();

      savedWindow.showInputBox = async () => 'fightai';
      await vscode.commands.executeCommand(HOT_RELOAD_HISTORY_SEARCH_COMMAND);
      expect(provider.getChildren(provider.getChildren()[0])).toHaveLength(1);

      savedWindow.showInputBox = async () => '';
      await vscode.commands.executeCommand(HOT_RELOAD_HISTORY_SEARCH_COMMAND);
      expect(provider.getChildren(provider.getChildren()[0])).toHaveLength(2);

      savedWindow.showInputBox = async () => undefined;
      await vscode.commands.executeCommand(HOT_RELOAD_HISTORY_SEARCH_COMMAND);
      expect(provider.getChildren(provider.getChildren()[0])).toHaveLength(2);
    } finally {
      savedWindow.showInputBox = originalInputBox;
    }
  });
});

describe('setupHotReloadHistoryView 历史面板(HR-UI-004/006/007/010)', () => {
  beforeEach(() => {
    windowState.reset();
    panelRegistry.reset();
  });

  const feedStatus = (): { watchMode: string; target: string } => ({ watchMode: '保存时', target: 'dev-1' });

  it('面板打开:页头监听模式/目标/计数;行=fullModule+发送并列+文件+目标+状态+时间+requestId', async () => {
    const feed = setupHotReloadHistoryView(contextOf(), { core: new HotReloadHistoryCore(), resolveNames: resolver, feedStatus });
    feed.handle(recordOf({ outcome: 'accepted', detail: 'HTTP 202' }));
    await vscode.commands.executeCommand(HOT_RELOAD_HISTORY_PANEL_COMMAND);
    const panel = panelRegistry.panels[panelRegistry.panels.length - 1];
    expect(panel.title).toBe('热更历史');
    const html = panel.webview.html;
    expect(html).toContain('监听模式: 保存时');
    expect(html).toContain('目标: dev-1');
    expect(html).toContain('显示 1/1 行');
    expect(html).toContain('entities.fight.FightAI');
    expect(html).toContain('发送: fight.FightAI');
    expect(html).toContain(`title="${FILE_A}"`);
    expect(html).toContain('(default)');
    expect(html).toContain('已发送(未确认)');
    expect(html).toContain(new Date(1700000000000).toISOString());
    expect(html).toContain(`${buildHotReloadTargetKeyId({ rootId: 'r1', targetId: '' })}/FightAI.py#1`);
    expect(html).toContain('HTTP 202');
    expect(html).not.toContain('加载更多');
  });

  it('默认 feedStatus 如实占位:未配置/默认;双名不同才出发送行', async () => {
    const feed = setupHotReloadHistoryView(contextOf(), { core: new HotReloadHistoryCore(), resolveNames: () => ({ fullModule: 'm.A', requestModule: 'm.A' }) });
    feed.handle(recordOf());
    await vscode.commands.executeCommand(HOT_RELOAD_HISTORY_PANEL_COMMAND);
    const html = panelRegistry.panels[panelRegistry.panels.length - 1].webview.html;
    expect(html).toContain('监听模式: (未配置)');
    expect(html).toContain('目标: (默认)');
    expect(html).not.toContain('发送: ');
  });

  it('过滤消息(HR-UI-010):模块子串/状态过滤重渲染,计数随过滤更新;清除筛选拉全量', async () => {
    const feed = setupHotReloadHistoryView(contextOf(), { core: new HotReloadHistoryCore(), resolveNames: resolver });
    feed.handle(recordOf({ file: FILE_A }));
    feed.handle(recordOf({ file: FILE_B, outcome: 'failed', detail: 'conn refused' }));
    await vscode.commands.executeCommand(HOT_RELOAD_HISTORY_PANEL_COMMAND);
    const panel = panelRegistry.panels[panelRegistry.panels.length - 1];
    const fire = (message: unknown): void => {
      for (const listener of panel.messageListeners) {
        listener(message);
      }
    };

    fire({ type: 'filter', fullModuleContains: 'spawner', targetId: '', status: '' });
    let html = panel.webview.html;
    expect(html).toContain('Spawner.py');
    expect(html).not.toContain('FightAI.py');
    expect(html).toContain('显示 1/1 行');

    fire({ type: 'filter', fullModuleContains: '', targetId: '', status: 'failed' });
    html = panel.webview.html;
    expect(html).toContain('失败');
    expect(html).toContain('conn refused');
    expect(html).toContain('显示 1/1 行');

    fire({ type: 'filter', fullModuleContains: '', targetId: '', status: '' });
    html = panel.webview.html;
    expect(html).toContain('FightAI.py');
    expect(html).toContain('Spawner.py');
  });

  it('分页(HR-UI-007):超页大小出「加载更多」,loadMore 增量拉满后按钮消失', async () => {
    const feed = setupHotReloadHistoryView(contextOf(), {
      core: new HotReloadHistoryCore(),
      resolveNames: resolver,
      pageSize: 3
    });
    for (let i = 0; i < 5; i += 1) {
      feed.handle(recordOf({ file: FILE_A, attempt: i + 1, recordedAt: 1700000000000 + i }));
    }
    await vscode.commands.executeCommand(HOT_RELOAD_HISTORY_PANEL_COMMAND);
    const panel = panelRegistry.panels[panelRegistry.panels.length - 1];
    expect(panel.webview.html).toContain('显示 3/5 行');
    expect(panel.webview.html).toContain('加载更多');
    // 首页=最新 3 条(attempt 5/4/3)
    expect(panel.webview.html).toContain('#5');
    expect(panel.webview.html).not.toContain('#1<');

    for (const listener of panel.messageListeners) {
      listener({ type: 'loadMore' });
    }
    expect(panel.webview.html).toContain('显示 5/5 行');
    expect(panel.webview.html).not.toContain('加载更多');
    expect(panel.webview.html).toContain('#1');
  });

  it('面板关闭不停 feed(HR-UI-012):dispose 后照常入账,重开面板见新行', async () => {
    const feed = setupHotReloadHistoryView(contextOf(), { core: new HotReloadHistoryCore(), resolveNames: resolver, feedStatus });
    feed.handle(recordOf());
    await vscode.commands.executeCommand(HOT_RELOAD_HISTORY_PANEL_COMMAND);
    const panel = panelRegistry.panels[panelRegistry.panels.length - 1];
    panel.dispose();

    feed.handle(recordOf({ file: FILE_B, attempt: 1 }));
    // dispose 后 feed 照常(内部 core 增长且不崩)
    await vscode.commands.executeCommand(HOT_RELOAD_HISTORY_PANEL_COMMAND);
    const reopened = panelRegistry.panels[panelRegistry.panels.length - 1];
    expect(reopened.webview.html).toContain('显示 2/2 行');
    expect(reopened.webview.html).toContain('Spawner.py');
  });
});

describe('setupHotReloadHistoryView 持久化与 feed(HR-MOD-014)', () => {
  beforeEach(() => {
    windowState.reset();
    panelRegistry.reset();
  });

  it('启动回载:合法形状条目进历史,形状不符如实丢弃;每次 handle 落全量', () => {
    const valid: HotReloadHistoryEntry = {
      requestId: 'r1//FightAI.py#1',
      fullModule: 'entities.fight.FightAI',
      requestModule: 'fight.FightAI',
      fileUri: FILE_A,
      targetId: '',
      time: 1700000000000,
      status: 'applied'
    };
    const saved: Array<readonly HotReloadHistoryEntry[]> = [];
    const feed = setupHotReloadHistoryView(contextOf(), {
      core: new HotReloadHistoryCore(),
      resolveNames: resolver,
      persist: {
        load: (): unknown => [valid, { requestId: 42 }, null, 'junk'],
        save: entries => {
          saved.push(entries);
        }
      }
    });
    const provider = lastProvider();
    const recent = provider.getChildren(provider.getChildren()[0]);
    expect(recent).toHaveLength(1);
    expect(recent[0].entry?.status).toBe('applied');

    feed.handle(recordOf());
    expect(saved).toHaveLength(1);
    expect(saved[0]).toHaveLength(2);
    expect(saved[0].some(entry => entry.requestId === valid.requestId)).toBe(true);
  });

  it('persist.load 非数组:如实忽略不崩', () => {
    const feed = setupHotReloadHistoryView(contextOf(), {
      core: new HotReloadHistoryCore(),
      resolveNames: resolver,
      persist: { load: (): unknown => 'corrupted', save: () => undefined }
    });
    feed.handle(recordOf());
    const provider = lastProvider();
    expect(provider.getChildren(provider.getChildren()[0])).toHaveLength(1);
  });

  it('键名面:HOT_RELOAD_HISTORY_STATE_KEY 与宿主 workspaceState 适配契约(字符串键,读写直传)', () => {
    expect(HOT_RELOAD_HISTORY_STATE_KEY).toBe('kbengine.hotReload.history');
    const store = new Map<string, unknown>();
    const context = {
      subscriptions: [],
      workspaceState: {
        get: (key: string): unknown => store.get(key),
        update: async (key: string, value: unknown): Promise<void> => {
          store.set(key, value);
        }
      }
    } as unknown as vscode.ExtensionContext;
    const feed = setupHotReloadHistoryView(context, {
      core: new HotReloadHistoryCore(),
      resolveNames: resolver,
      persist: {
        load: (): unknown => context.workspaceState.get(HOT_RELOAD_HISTORY_STATE_KEY),
        save: entries => {
          void context.workspaceState.update(HOT_RELOAD_HISTORY_STATE_KEY, entries);
        }
      }
    });
    feed.handle(recordOf());
    const persisted = store.get(HOT_RELOAD_HISTORY_STATE_KEY) as readonly HotReloadHistoryEntry[];
    expect(persisted).toHaveLength(1);
    expect(persisted[0].fullModule).toBe('entities.fight.FightAI');
  });
});

describe('renderHistoryPanelHtml 纯呈现面', () => {
  it('三态状态标签与状态类名如实;错误列空缺不占位', () => {
    const base = {
      requestId: 'r1//A.py#1',
      fullModule: 'm.A',
      requestModule: 'm.A',
      fileUri: FILE_A,
      targetId: 't1',
      time: 1700000000000
    };
    const rows: HotReloadHistoryEntry[] = [
      { ...base, status: 'applied' },
      { ...base, status: 'failed', errorSummary: 'boom' },
      { ...base, status: 'sent-unverified' }
    ];
    const html = renderHistoryPanelHtml({
      state: { feedStatus: { watchMode: '', target: '' }, filter: {}, page: 1 },
      rows,
      total: 3,
      hasMore: false,
      pageSize: 50
    });
    expect(html).toContain('class="st-applied">已应用');
    expect(html).toContain('class="st-failed">失败');
    expect(html).toContain('class="st-sent-unverified">已发送(未确认)');
    expect(html).toContain('boom');
    expect(html).toContain('t1');
  });
});
