// RUST-429(旧 HR-QA-017):性能不达标时允许关 Watch 和回退至手动 Quick Requests;
// 设置可恢复且无状态数据破坏。
//
// 架构分界(本车道钉的事实):
//   * Watch(磁盘事件 → pipeline → flush → runAction)只是**自动触发源**;
//   * 手动 Quick Request 走 QuickActionManager(views.ts 树/命令 → runByName →
//     runHttpEntry),与 Watch 面零共享状态——关 Watch 拆自动面,绝不碰手动面;
//   * 关 Watch 的口径:kbengine.hotReload.enabled=false(或显式空 globs)→
//     plan.watchOff → apply 拆 watcher(HR-WATCH-005),状态栏「关」面;
//   * 设置可恢复:改回 enabled=true → §11.4 apply 重建自动面(新 watcher 身份),
//     磁盘事件重新喂链;
//   * 无状态数据破坏:台账 store 在 activate 建一次注入(activate/hotReload.ts:120,
//     wiring.store 经 hotReload.ts:542 接线),apply 重建流水线/磁盘面/trigger/
//     pendingOut 但**不重建 store**——关/开循环不丢台账不重置,重开后新发送仍
//     落同一 store 实例;by-design 弃置只含未定稿进料(pendingOut),台账不含它们。
//
// 手动面正交性判据:getTreeData/runByName 的 HTTP 请求过滤只看**请求自身**的
// enabled 开关(quickActions.ts:573 `request.enabled !== false`),与
// kbengine.hotReload.enabled 是两条独立轴——关 Watch 不误伤手动,手动停用
// 只影响手动。本车道以 watch 关着时「启用请求仍列仍可跑 / 停用请求隐藏」钉住。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

import { setupHotReload, type HotReloadTimerDeps } from '../src/hotReload';
import {
  HotReloadStatusController,
  type OutputChannelLike,
  type StatusBarItemLike
} from '../src/hotReloadStatus';
import { HotReloadTargetStateStore } from '../src/backend/hotReloadTargetState';
import type { HttpRequestEntry } from '../src/backend/httpRequests';
import { QuickActionManager } from '../src/quickActions';
import { allFileSystemWatchers, configurationOverrides, workspaceEvents } from './helpers/vscodeStub';
import { Uri } from './fake-vscode/core';

const READY_FACE = '$(eye) 热更: 就绪';
const OFF_FACE = '$(eye-closed) 热更: 关';

const makeTimers = (): {
  timers: HotReloadTimerDeps;
  pending: () => number;
  tick: () => number;
} => {
  const handles = new Map<unknown, () => void>();
  let nextHandle = 0;
  return {
    pending: () => handles.size,
    tick: () => {
      const callbacks = [...handles.values()];
      handles.clear();
      for (const callback of callbacks) {
        callback();
      }
      return callbacks.length;
    },
    timers: {
      set: (callback): unknown => {
        const handle = nextHandle++;
        handles.set(handle, callback);
        return handle;
      },
      clear: (handle): void => {
        handles.delete(handle);
      }
    }
  };
};

/** 排干节流窗(状态栏尾沿渲染):有界循环防挂死 */
const settle = (clock: { pending: () => number; tick: () => number }): void => {
  for (let guard = 0; guard < 8 && clock.pending() > 0; guard += 1) {
    clock.tick();
  }
};

const makeStatus = (timers: HotReloadTimerDeps) => {
  const bar: StatusBarItemLike = {
    text: '',
    command: undefined,
    tooltip: '',
    show(): void {},
    hide(): void {},
    dispose(): void {}
  };
  const lines: string[] = [];
  const channel: OutputChannelLike = {
    appendLine: (line: string): void => {
      lines.push(line);
    },
    show(): void {},
    dispose(): void {}
  };
  const controller = new HotReloadStatusController({
    createStatusBarItem: () => bar,
    createOutputChannel: () => channel,
    registerCommand: () => ({ dispose: (): void => undefined }),
    timers,
    now: () => new Date(2026, 10, 22, 9, 0, 0).getTime()
  });
  return { controller, bar, lines };
};

const makeContext = (): vscode.ExtensionContext =>
  ({ subscriptions: [] }) as unknown as vscode.ExtensionContext;

const fireConfig = (section = 'kbengine'): void => {
  workspaceEvents.configurationChanged.fire({
    affectsConfiguration: (candidate: string) => candidate === section
  });
};

/** 本用例建的装配 context 台账:用例后逐个释放,否则残留的配置监听器会在
 *  后续 fireConfig 里各自重建 watcher,污染 allFileSystemWatchers 共享替身的账 */
const contexts: vscode.ExtensionContext[] = [];

/** 关/开循环用的自动面装配:同 context 多轮 fireConfig(apply 同实例) */
const bootWatch = (
  runAction: (name: string) => void,
  extra: { store?: HotReloadTargetStateStore } = {}
): { clock: ReturnType<typeof makeTimers>; status: ReturnType<typeof makeStatus> } => {
  const clock = makeTimers();
  const status = makeStatus(clock.timers);
  const context = makeContext();
  contexts.push(context);
  setupHotReload(context, runAction, {
    timers: clock.timers,
    status: status.controller,
    ...(extra.store
      ? {
          targetState: {
            store: extra.store,
            resolveTargetId: () => 't-manual',
            resolveRootId: () => '/ws'
          }
        }
      : {})
  });
  settle(clock);
  return { clock, status };
};

const WATCH_ON = {
  hotReload: { enabled: true, globs: ['**/*.py'], actionName: '热更', debounceMs: 100 }
};
const WATCH_OFF = {
  hotReload: { enabled: false, globs: ['**/*.py'], actionName: '热更', debounceMs: 100 }
};

describe('RUST-429 关 Watch:自动面拆除(性能降级面)', () => {
  let workspaceFoldersBackup: typeof vscode.workspace.workspaceFolders;

  beforeEach(() => {
    configurationOverrides.clear();
    allFileSystemWatchers.length = 0;
    contexts.length = 0;
    workspaceFoldersBackup = vscode.workspace.workspaceFolders;
  });

  afterEach(() => {
    // 释放本用例建的装配:否则它们的配置监听器会在后续 fireConfig 里各自重建
    // watcher,污染 allFileSystemWatchers 计数(共享替身的账)
    for (const context of contexts) {
      try {
        context.subscriptions[0]?.dispose();
      } catch {
        // 释放失败不掩盖用例本身的断言
      }
    }
    contexts.length = 0;
    vscode.workspace.workspaceFolders = workspaceFoldersBackup;
    configurationOverrides.clear();
  });

  it('开→关:旧 watcher 全拆,状态栏「关」面,被拆 watcher 事件不再喂链(零排程零动作)', () => {
    configurationOverrides.set('kbengine', WATCH_ON);
    const runCalls: string[] = [];
    const { clock, status } = bootWatch(name => void runCalls.push(name));
    const first = allFileSystemWatchers[0];
    expect(first.pattern).toBe('**/*.py');
    expect(status.bar.text).toBe(READY_FACE);
    // 计数窥探而不破坏语义:包住真 dispose(真 dispose 会清空 watcher 监听器,
    // 后续 fireChange 才真正不再进链)
    let firstDisposed = 0;
    const originalDispose = first.dispose.bind(first);
    first.dispose = (): void => {
      firstDisposed += 1;
      originalDispose();
    };

    // 关 Watch:apply 拆 watcher(HR-WATCH-005),状态栏「关」面,不建新面
    configurationOverrides.set('kbengine', WATCH_OFF);
    fireConfig();
    settle(clock); // 排干状态栏节流窗,余下 pending 才反映喂链
    expect(firstDisposed).toBe(1);
    expect(allFileSystemWatchers).toHaveLength(1); // 不建新 watcher
    expect(status.bar.text).toBe(OFF_FACE);
    expect(status.lines.some(line => line.includes('未开启: kbengine.hotReload.enabled=false'))).toBe(true);

    // 被拆 watcher 的事件不再进链:零排程、零动作(自动源已全停)
    first.fireChange(Uri.file('/ws/a.py'));
    expect(clock.pending()).toBe(0);
    expect(runCalls).toEqual([]);
  });

  it('关→开可恢复:重建新 watcher(新身份),READY 面,事件重新喂链跑动作', () => {
    configurationOverrides.set('kbengine', WATCH_OFF);
    const runCalls: string[] = [];
    const { clock, status } = bootWatch(name => void runCalls.push(name));
    expect(status.bar.text).toBe(OFF_FACE);

    // 改回开:§11.4 apply 重建自动面
    configurationOverrides.set('kbengine', WATCH_ON);
    fireConfig();
    expect(allFileSystemWatchers).toHaveLength(1);
    const restored = allFileSystemWatchers[0];
    expect(restored.pattern).toBe('**/*.py');
    expect(status.bar.text).toBe(READY_FACE);

    // 新 watcher 事件重新喂链:排程+动作触发
    restored.fireChange(Uri.file('/ws/a.py'));
    expect(clock.pending()).toBeGreaterThan(0);
    clock.tick();
    expect(runCalls).toEqual(['热更']);
  });

  it('无状态数据破坏:台账 store 跨关/开循环存活,重开后新发送仍落同一 store 实例', async () => {
    configurationOverrides.set('kbengine', WATCH_ON);
    const store = new HotReloadTargetStateStore({ now: () => 1_000 });
    const runCalls: string[] = [];
    const { clock } = bootWatch(name => void runCalls.push(name), { store });
    const watcher = allFileSystemWatchers[0];

    // 开态发送 a.py → 台账落 sent-unverified
    watcher.fireChange(Uri.file('/ws/a.py'));
    clock.tick();
    await vi.waitFor(() => expect(store.files({ rootId: '/ws', targetId: 't-manual' })).toHaveLength(1));
    expect(store.get({ rootId: '/ws', targetId: 't-manual' }, '/ws/a.py')?.outcome).toBe('sent-unverified');

    // 关 Watch(apply 不重建 store)
    configurationOverrides.set('kbengine', WATCH_OFF);
    fireConfig();
    // 关本身不造假状态:无新记录、既有记录原样
    expect(store.files({ rootId: '/ws', targetId: 't-manual' })).toHaveLength(1);
    expect(store.get({ rootId: '/ws', targetId: 't-manual' }, '/ws/a.py')?.outcome).toBe('sent-unverified');

    // 重开:新 watcher 事件发 b.py → 落**同一** store(记录累加,未被关/开重置)
    configurationOverrides.set('kbengine', WATCH_ON);
    fireConfig();
    const restored = allFileSystemWatchers[1];
    expect(restored).not.toBe(watcher);
    restored.fireChange(Uri.file('/ws/b.py'));
    clock.tick();
    await vi.waitFor(() => expect(store.files({ rootId: '/ws', targetId: 't-manual' })).toHaveLength(2));
    expect(store.get({ rootId: '/ws', targetId: 't-manual' }, '/ws/a.py')?.outcome).toBe('sent-unverified');
    expect(store.get({ rootId: '/ws', targetId: 't-manual' }, '/ws/b.py')?.outcome).toBe('sent-unverified');
  });
});

describe('RUST-429 手动 Quick Request 与 Watch 正交(回退面)', () => {
  beforeEach(() => {
    configurationOverrides.clear();
  });

  const entry = (name: string, enabled: boolean): HttpRequestEntry => ({
    name,
    url: `http://127.0.0.1:9/hot/${name}`,
    method: 'POST',
    headers: {},
    body: '',
    enabled,
    keybinding: ''
  });

  const makeManager = (): {
    manager: QuickActionManager;
    ran: string[];
  } => {
    const ran: string[] = [];
    const manager = new QuickActionManager(makeContext(), {
      getSettingHttpEntries: () => [entry('热更', true), entry('停用请求', false)],
      runHttpEntry: async httpEntry => {
        ran.push(httpEntry.name);
        return true;
      }
    });
    return { manager, ran };
  };

  it('watch 关着:启用 HTTP 请求仍列仍可跑(手动回退可用),停用请求隐藏(请求自身开关轴)', async () => {
    configurationOverrides.set('kbengine', WATCH_OFF); // 自动面关着
    const { manager, ran } = makeManager();

    // 手动面仍在:启用的请求列入树,停用的隐藏——过滤只认请求自身 enabled,
    // 与 kbengine.hotReload.enabled 是独立轴
    const tree = await manager.getTreeData();
    const listed = tree.httpRequests.map(item => item.name);
    expect(listed).toContain('热更');
    expect(listed).not.toContain('停用请求');

    // 手动执行可用(与 watch 状态无关):关 Watch 不误伤手动回退面
    expect(await manager.runByName('@http:settings:0')).toBe(true);
    expect(ran).toEqual(['热更']);
  });

  it('正交轴钉:watch 开/关两态手动面逐项一致(关 Watch 不改变手动面)', async () => {
    const { manager } = makeManager();
    configurationOverrides.set('kbengine', WATCH_ON);
    const treeOn = await manager.getTreeData();
    const onNames = treeOn.httpRequests.map(item => item.name);

    configurationOverrides.set('kbengine', WATCH_OFF);
    const treeOff = await manager.getTreeData();
    expect(treeOff.httpRequests.map(item => item.name)).toEqual(onNames);
    expect(onNames).toEqual(['热更']);
  });
});
