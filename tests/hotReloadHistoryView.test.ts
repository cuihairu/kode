import { beforeEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import {
  HOT_RELOAD_HISTORY_EXPORT_COMMAND,
  HOT_RELOAD_HISTORY_PANEL_COMMAND,
  HOT_RELOAD_HISTORY_SEARCH_COMMAND,
  HOT_RELOAD_HISTORY_STATE_KEY,
  renderHistoryPanelHtml,
  setupHotReloadHistoryView,
  translateDeliveryRecord,
  type HotReloadNamesResolver
} from '../src/hotReloadHistoryView';
import {
  HotReloadHistoryCore,
  HOT_RELOAD_HISTORY_EXPORT_FIELDS,
  buildHistoryEntryTooltipLines,
  type HotReloadHistoryEntry
} from '../src/backend/hotReloadHistoryCore';
import { buildHotReloadTargetKeyId, type HotReloadDeliveryRecord } from '../src/backend/hotReloadTargetState';
import { panelRegistry, windowState } from './helpers/vscodeStub';
import { treeRegistrations } from './fake-vscode/windowState';
import { memoryFileSystem } from './fake-vscode/workspaceState';

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

  it('HR-STATE-010 错误摘要过七类分类:已知加标签+原文保留,未知原样透传', () => {
    // 已知类别:回执不可信 → 加 [回执不可信] 标签,原文保留(定性不吞原文)
    const untrusted = translateDeliveryRecord(
      recordOf({ outcome: 'failed', detail: 'applied 回执不可信(digest 缺失或与所发内容不符):保持未确认' }),
      resolver
    );
    expect(untrusted.errorSummary).toContain('[回执不可信]');
    expect(untrusted.errorSummary).toContain('digest 缺失或与所发内容不符');
    // 未知类别:裸 HTTP 500 无可辨信号 → 原样透传,不猜不污染
    const bare = translateDeliveryRecord(recordOf({ outcome: 'failed', detail: 'HTTP 500' }), resolver);
    expect(bare.errorSummary).toBe('HTTP 500');
  });
});

describe('HR-STATE-007 操作史九字段(trigger/duration/errorCategory/hash)', () => {
  it('触发源与内容指纹从事实源透传:source→trigger,sentDigest→hash;未记录如实不写', () => {
    const withFields = translateDeliveryRecord(
      recordOf({ source: 'watcher-auto', sentDigest: 'a'.repeat(64) }),
      resolver
    );
    expect(withFields.trigger).toBe('watcher-auto');
    expect(withFields.hash).toBe('a'.repeat(64));

    const bare = translateDeliveryRecord(recordOf(), resolver);
    expect(bare.trigger).toBeUndefined();
    expect(bare.hash).toBeUndefined();
  });

  it('时长=发送→观察墙钟差;无时钟如实不写;时钟倒退钳 0', () => {
    const withNow = translateDeliveryRecord(recordOf(), resolver, 1700000001500);
    expect(withNow.durationMs).toBe(1500);

    const sendMoment = translateDeliveryRecord(recordOf(), resolver, 1700000000000);
    expect(sendMoment.durationMs).toBe(0);

    const noClock = translateDeliveryRecord(recordOf(), resolver);
    expect(noClock.durationMs).toBeUndefined();

    const regressed = translateDeliveryRecord(recordOf(), resolver, 1699999999000);
    expect(regressed.durationMs).toBe(0);
  });

  it('错误分类只对失败行:传输五分类定性;非失败行如实不写;原始 detail 仍留 errorSummary', () => {
    const refused = translateDeliveryRecord(recordOf({ outcome: 'failed', detail: 'ECONNREFUSED' }), resolver);
    expect(refused.errorCategory).toBe('endpoint-unreachable');
    expect(refused.errorSummary).toBe('ECONNREFUSED');

    const cert = translateDeliveryRecord(recordOf({ outcome: 'failed', detail: 'self signed certificate' }), resolver);
    expect(cert.errorCategory).toBe('certificate');

    const unknown = translateDeliveryRecord(recordOf({ outcome: 'failed', detail: 'HTTP 500' }), resolver);
    expect(unknown.errorCategory).toBe('unknown');

    const applied = translateDeliveryRecord(recordOf({ outcome: 'applied' }), resolver);
    expect(applied.errorCategory).toBeUndefined();

    const sent = translateDeliveryRecord(recordOf({ outcome: 'accepted' }), resolver);
    expect(sent.errorCategory).toBeUndefined();
  });

  it('tooltip 字段投影:四新字段在即列,缺如实不列(不拼空行)', () => {
    const entry = translateDeliveryRecord(
      recordOf({ source: 'retry', sentDigest: 'b'.repeat(64), outcome: 'failed', detail: 'ETIMEDOUT' }),
      resolver,
      1700000000500
    );
    const lines = buildHistoryEntryTooltipLines(entry);
    expect(lines).toContain('trigger: retry');
    expect(lines).toContain('duration: 500ms');
    expect(lines).toContain('errorCategory: endpoint-unreachable');
    expect(lines).toContain(`hash: ${'b'.repeat(64)}`);

    const bareLines = buildHistoryEntryTooltipLines(translateDeliveryRecord(recordOf(), resolver));
    expect(bareLines.some(line => line.startsWith('trigger:'))).toBe(false);
    expect(bareLines.some(line => line.startsWith('duration:'))).toBe(false);
    expect(bareLines.some(line => line.startsWith('errorCategory:'))).toBe(false);
    expect(bareLines.some(line => line.startsWith('hash:'))).toBe(false);
  });

  it('装配 handle 经注入 now 落时长;未注入如实不写(与核心同口径)', () => {
    const core = new HotReloadHistoryCore();
    const feed = setupHotReloadHistoryView(contextOf(), {
      core,
      resolveNames: resolver,
      now: () => 1700000002000
    });
    feed.handle(recordOf({ outcome: 'failed', detail: 'ECONNREFUSED' }));
    const entry = core.entries()[0];
    expect(entry.durationMs).toBe(2000);
    expect(entry.trigger).toBeUndefined();
    expect(entry.hash).toBeUndefined();
    expect(entry.errorCategory).toBe('endpoint-unreachable');

    const bareCore = new HotReloadHistoryCore();
    const bareFeed = setupHotReloadHistoryView(contextOf(), { core: bareCore, resolveNames: resolver });
    bareFeed.handle(recordOf({ outcome: 'failed', detail: 'ECONNREFUSED' }));
    expect(bareCore.entries()[0].durationMs).toBeUndefined();
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

  it('HR-UI-004 实时队列面:注入 pipelineQueue 快照→面板三阶段列文件(计数+文件名+全路径 title)', async () => {
    const feed = setupHotReloadHistoryView(contextOf(), {
      core: new HotReloadHistoryCore(),
      resolveNames: resolver,
      pipelineQueue: () => ({ pending: [FILE_A], previewHeld: [FILE_B], wave: [] })
    });
    feed.handle(recordOf());
    await vscode.commands.executeCommand(HOT_RELOAD_HISTORY_PANEL_COMMAND);
    const html = panelRegistry.panels[panelRegistry.panels.length - 1].webview.html;
    expect(html).toContain('实时队列');
    expect(html).toContain('归并中(1)');
    expect(html).toContain('预览滞留(1)');
    expect(html).toContain('本波已定稿未发出(0)');
    expect(html).toContain('FightAI.py');
    expect(html).toContain('Spawner.py');
    expect(html).toContain(`title="${FILE_A}"`);
    expect(html).toContain(`title="${FILE_B}"`);
  });

  it('HR-UI-004 实时队列面:不注入 pipelineQueue=如实空三队列,面板照常开', async () => {
    setupHotReloadHistoryView(contextOf(), { core: new HotReloadHistoryCore(), resolveNames: resolver });
    await vscode.commands.executeCommand(HOT_RELOAD_HISTORY_PANEL_COMMAND);
    const html = panelRegistry.panels[panelRegistry.panels.length - 1].webview.html;
    expect(html).toContain('实时队列');
    expect(html).toContain('归并中(0)');
    expect(html).toContain('(空)');
  });

  it('预览队列变化无需投递回执即可刷新，且保留面板表单', async () => {
    const timers = makeTimers();
    let held: string[] = [];
    const feed = setupHotReloadHistoryView(contextOf(), {
      core: new HotReloadHistoryCore(),
      resolveNames: resolver,
      pipelineQueue: () => ({ pending: [], previewHeld: held, wave: [] }),
      timers
    });
    await vscode.commands.executeCommand(HOT_RELOAD_HISTORY_PANEL_COMMAND);
    const panel = panelRegistry.panels.at(-1)!;
    const panelHtml = panel.webview.html;
    held = [FILE_A];
    feed.queueChanged();
    feed.queueChanged();
    expect(timers.pendingCount()).toBe(1);
    timers.advance();
    expect(panel.webview.html).toBe(panelHtml);
    expect(panel.webview.postedMessages).toEqual([
      { message: { type: 'queueChanged', rows: expect.stringContaining('预览滞留(1)') } }
    ]);
  });

  it('RUST-372 风暴限频(面板开):千级事件至多前沿+尾帧 2 次全量渲染,落账同窗批处理', async () => {
    const timers = makeTimers();
    const saves: number[] = [];
    const feed = setupHotReloadHistoryView(contextOf(), {
      core: new HotReloadHistoryCore(),
      resolveNames: resolver,
      timers,
      persist: { load: () => undefined, save: entries => saves.push(entries.length) }
    });
    await vscode.commands.executeCommand(HOT_RELOAD_HISTORY_PANEL_COMMAND);
    const panel = panelRegistry.panels[panelRegistry.panels.length - 1];
    let renderCount = 0;
    let currentHtml = panel.webview.html;
    Object.defineProperty(panel.webview, 'html', {
      get: (): string => currentHtml,
      set: (value: string): void => {
        renderCount += 1;
        currentHtml = value;
      }
    });
    // 1000 事件/秒:每条尝试代际不同 → 1000 条 requestId(容量 200 淘汰最旧)
    for (let i = 0; i < 1000; i += 1) {
      feed.handle(recordOf({ attempt: i + 1 }));
    }
    // 前沿:首事件即时渲染 1 次,其余 999 次窗内合并(只置 dirty)
    expect(renderCount).toBe(1);
    expect(saves).toHaveLength(1);
    expect(saves[0]).toBe(1);
    timers.advance();
    // 窗末:尾帧 1 次读最新态(容量 200);1000 事件 → 共 2 次全量渲染、2 次落账
    expect(renderCount).toBe(2);
    expect(saves).toHaveLength(2);
    expect(saves[1]).toBe(200);
  });

  it('RUST-372 面板开孤立事件:前沿即时渲染保持;窗末无后续事件不补帧', async () => {
    const timers = makeTimers();
    const feed = setupHotReloadHistoryView(contextOf(), {
      core: new HotReloadHistoryCore(),
      resolveNames: resolver,
      timers
    });
    await vscode.commands.executeCommand(HOT_RELOAD_HISTORY_PANEL_COMMAND);
    const panel = panelRegistry.panels[panelRegistry.panels.length - 1];
    let renderCount = 0;
    let currentHtml = panel.webview.html;
    Object.defineProperty(panel.webview, 'html', {
      get: (): string => currentHtml,
      set: (value: string): void => {
        renderCount += 1;
        currentHtml = value;
      }
    });
    feed.handle(recordOf());
    // 前沿即时(「面板打开时即时重渲染」语义保持)
    expect(renderCount).toBe(1);
    timers.advance();
    // 窗内无后续事件:不补帧(前沿已渲),不产生无谓二次全量渲染
    expect(renderCount).toBe(1);
  });

  it('RUST-372 树模式落账同窗批处理(前沿+尾帧各 1 次);dispose 清风暴限频钟', () => {
    const timers = makeTimers();
    const context = contextOf();
    const saves: number[] = [];
    const feed = setupHotReloadHistoryView(context, {
      core: new HotReloadHistoryCore(),
      resolveNames: resolver,
      timers,
      persist: { load: () => undefined, save: entries => saves.push(entries.length) }
    });
    feed.handle(recordOf({ attempt: 1 }));
    feed.handle(recordOf({ attempt: 2 }));
    feed.handle(recordOf({ attempt: 3 }));
    // 树模式:前沿只落账 1 次(渲染合并进窗末 fire);单钟
    expect(saves).toHaveLength(1);
    expect(timers.pendingCount()).toBe(1);
    timers.advance();
    expect(saves).toHaveLength(2);
    expect(saves[1]).toBe(3);
    // dispose 清风暴限频钟(HR-UI-012)
    for (const disposable of context.subscriptions) {
      disposable.dispose();
    }
    expect(timers.pendingCount()).toBe(0);
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

  it('HR-UI-004 实时队列面:快照三阶段计数+文件名如实;文件名 HTML 转义(文本与 title 全路径双面)', () => {
    const html = renderHistoryPanelHtml({
      state: { feedStatus: { watchMode: '', target: '' }, filter: {}, page: 1 },
      rows: [],
      total: 0,
      hasMore: false,
      pageSize: 50,
      queue: { pending: ['/x/<evil>&.py', '/x/A.py'], previewHeld: [], wave: [] }
    });
    expect(html).toContain('归并中(2)');
    expect(html).toContain('预览滞留(0)');
    expect(html).toContain('本波已定稿未发出(0)');
    expect(html).toContain('title="/x/&lt;evil&gt;&amp;.py"');
    expect(html).toContain('&lt;evil&gt;&amp;.py');
    expect(html).not.toContain('<evil>&.py');
  });
});

describe('renderHistoryPanelHtml 虚拟滚动(HR-UI-007 上千记录渲染面)', () => {
  const makeRows = (count: number): HotReloadHistoryEntry[] =>
    Array.from({ length: count }, (_, i) => ({
      requestId: `r${i}`,
      fullModule: `m.M${i}`,
      requestModule: `m.M${i}`,
      fileUri: `/repo/scripts/M${i}.py`,
      targetId: '',
      time: 1700000000000 + i,
      status: 'sent-unverified' as const
    }));
  const virtualize = { rowHeightPx: 26, viewportHeightPx: 480, overscanRows: 5 };
  const render = (rows: readonly HotReloadHistoryEntry[]) =>
    renderHistoryPanelHtml({
      state: { feedStatus: { watchMode: '', target: '' }, filter: {}, page: 1 },
      rows,
      total: rows.length,
      hasMore: false,
      pageSize: 50,
      virtualize
    });

  it('行数超阈值:只渲染视口窗口行(非全量),滚动条按内容总高', () => {
    const rows = makeRows(205);
    const html = render(rows);
    expect(html).toContain('id="vlist"');
    // 视口 480/26 → ceil=19 行 + overscan 5 → 窗口 24 行(script 内 JS 镜像的
    // '<td class="module">' 字面量不带 8 空格缩进,不进渲染行计数)
    expect((html.match(/\n {8}<td class="module">/g) || []).length).toBe(24);
    // 窗口首行=第 0 行(M0),末窗口行=M23;越窗行(M100)只进 DATA 非 tbody 行
    expect(html).toContain('M0.py');
    expect(html).toContain('M23.py');
    expect(html).not.toContain('<td class="module">m.M100</td>');
    // 滚动条几何:内容总高经 spacer 撑出——底垫=(205-24)*26=4706px(全量内容
    // 高在滚动几何里,不因只渲染窗口行而缩)
    expect(html).toContain('4706px');
    // JS 镜像窗口公式在 webview 脚本里
    expect(html).toContain('windowFor');
    expect(html).toContain('renderWindow');
  });

  it('行数未超阈值或未给 virtualize:走既有分页路径,无 vlist', () => {
    const small = render(makeRows(150));
    expect(small).not.toContain('id="vlist"');
    // 150 行全量渲染(非虚拟路径无 JS 镜像行字面量,行数即渲染数)
    expect((small.match(/\n {8}<td class="module">/g) || []).length).toBe(150);
    const noOpt = renderHistoryPanelHtml({
      state: { feedStatus: { watchMode: '', target: '' }, filter: {}, page: 1 },
      rows: makeRows(205),
      total: 205,
      hasMore: false,
      pageSize: 50
    });
    expect(noOpt).not.toContain('id="vlist"');
  });

  it('窗口内嵌全量 DATA 供滚动重渲(滚动不 postMessage 全量重渲)', () => {
    const html = render(makeRows(205));
    // DATA 全量 205 行内嵌(JSON),滚动 JS 据此窗口化
    expect(html).toContain('const DATA = [');
    expect(html).toContain('"requestId":"r100"');
    expect(html).toContain('list.addEventListener(\'scroll\', renderWindow)');
  });
});

describe('HR-STATE-008 导出脱敏 JSON(命令面)', () => {
  const SAVE_PATH = '/tmp/kode-hot-reload-history-export.json';
  const patchSaveDialog = (uri: { fsPath: string } | undefined): void => {
    (vscode.window as unknown as { showSaveDialog: unknown }).showSaveDialog = async () => uri;
  };

  it('导出命令:保存对话框给路径→白名单投影 JSON 落盘;取消=不落盘', async () => {
    memoryFileSystem.reset();
    const core = new HotReloadHistoryCore();
    const feed = setupHotReloadHistoryView(contextOf(), {
      core,
      resolveNames: resolver,
      now: () => 1700000002000
    });
    feed.handle(
      recordOf({
        source: 'command',
        sentDigest: 'a'.repeat(64),
        outcome: 'failed',
        detail: 'ECONNREFUSED'
      })
    );
    const original = (vscode.window as unknown as { showSaveDialog: unknown }).showSaveDialog;
    try {
      patchSaveDialog({ fsPath: SAVE_PATH });
      await vscode.commands.executeCommand(HOT_RELOAD_HISTORY_EXPORT_COMMAND);
      const written = memoryFileSystem.files.get(SAVE_PATH);
      expect(written).toBeDefined();
      const parsed = JSON.parse(Buffer.from(written as Uint8Array).toString('utf8'));
      expect(parsed.schema).toBe('kbengine.hotReloadHistory');
      expect(parsed.count).toBe(1);
      expect(Object.keys(parsed.entries[0]).sort()).toEqual([...HOT_RELOAD_HISTORY_EXPORT_FIELDS].sort());
      expect(parsed.entries[0].errorCategory).toBe('endpoint-unreachable');
      expect(parsed.entries[0].trigger).toBe('command');
      expect(JSON.stringify(parsed)).not.toMatch(/header|token/i);

      patchSaveDialog(undefined);
      memoryFileSystem.files.delete(SAVE_PATH);
      await vscode.commands.executeCommand(HOT_RELOAD_HISTORY_EXPORT_COMMAND);
      expect(memoryFileSystem.files.has(SAVE_PATH)).toBe(false);
    } finally {
      patchSaveDialog(original);
      memoryFileSystem.reset();
    }
  }, 10000);
});
