import { beforeEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { setupHotReload, type HotReloadTimerDeps } from '../src/hotReload';
import {
  HOT_RELOAD_LOG_CHANNEL_NAME,
  HOT_RELOAD_SHOW_LOG_COMMAND,
  HOT_RELOAD_STATUS_THROTTLE_MS,
  HotReloadStatusController,
  formatHotReloadTime,
  type OutputChannelLike,
  type StatusBarItemLike
} from '../src/hotReloadStatus';
import {
  channels,
  configurationOverrides,
  lastFileSystemWatcher,
  statusBars,
  workspaceEvents
} from './helpers/vscodeStub';

// 热更新状态栏反馈(KODE2 backlog HR-UI-001):状态机 Watch Off → Ready →
// Sending → Sent(未确认) → Failed。口径:动作完成且无错只记未确认,禁标
// 成功/Applied;点击状态栏项开日志;状态渲染节流合并;deactivate 释放。
// 控制器用注入假体直测;装配级转移表经 setupHotReload 的 status 注入驱动。

const OFF_FACE = '$(eye-closed) 热更: 关';
const READY_FACE = '$(eye) 热更: 就绪';
const SENDING_FACE = '$(sync~spin) 热更: 发送中';
const SENT_FACE = '$(cloud-upload) 热更: 已发送(未确认)';
const FAILED_FACE = '$(error) 热更: 失败';

const makeTimers = (): {
  timers: HotReloadTimerDeps;
  pending: () => number;
  tick: () => number;
} => {
  const handles = new Map<unknown, () => void>();
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
        const handle = handles.size;
        handles.set(handle, callback);
        return handle;
      },
      clear: (handle): void => {
        handles.delete(handle);
      }
    }
  };
};

/** 状态控制器假体:双通道分别记账,bar/channel/command 的释放可断言 */
const makeStatus = (timers: HotReloadTimerDeps) => {
  const bar: StatusBarItemLike & { showCount: number; disposed: boolean } = {
    text: '',
    command: undefined,
    tooltip: '',
    visible: false,
    showCount: 0,
    disposed: false,
    show(): void {
      this.visible = true;
      this.showCount += 1;
    },
    hide(): void {
      this.visible = false;
    },
    dispose(): void {
      this.disposed = true;
    }
  };
  const lines: string[] = [];
  const showCalls: number[] = [];
  const channelState = { disposed: false };
  const channel: OutputChannelLike = {
    appendLine: (line: string): void => {
      lines.push(line);
    },
    show: (): void => {
      showCalls.push(showCalls.length);
    },
    dispose: (): void => {
      channelState.disposed = true;
    }
  };
  let handler: (() => void) | undefined;
  const commandState = { disposed: false };
  const controller = new HotReloadStatusController({
    createStatusBarItem: () => bar,
    createOutputChannel: () => channel,
    registerCommand: (_command, registered) => {
      handler = registered;
      return {
        dispose: (): void => {
          commandState.disposed = true;
        }
      };
    },
    timers,
    // 固定时钟:本地构造,日志行断言不随宿主时区漂移
    now: () => new Date(2026, 9, 27, 12, 34, 56).getTime()
  });
  return {
    controller,
    bar,
    lines,
    showCalls,
    channelState,
    commandState,
    clickBar: (): void => handler?.()
  };
};

/** 排干节流窗:尾沿渲染后再开的空窗一并收敛(有界循环防挂死) */
const settle = (clock: { pending: () => number; tick: () => number }): void => {
  for (let guard = 0; guard < 8 && clock.pending() > 0; guard += 1) {
    clock.tick();
  }
};

describe('formatHotReloadTime(时间格式)', () => {
  it('本地 HH:MM:SS 逐位补零', () => {
    expect(formatHotReloadTime(new Date(2026, 9, 27, 12, 34, 56).getTime())).toBe('12:34:56');
    expect(formatHotReloadTime(new Date(2026, 9, 27, 1, 2, 3).getTime())).toBe('01:02:03');
  });
});

describe('HotReloadStatusController(渲染与节流)', () => {
  it('构造即上屏 Watch Off 并挂点击开日志命令', () => {
    const clock = makeTimers();
    const fake = makeStatus(clock.timers);

    expect(fake.bar.text).toBe(OFF_FACE);
    expect(fake.bar.visible).toBe(true);
    expect(fake.bar.command).toBe(HOT_RELOAD_SHOW_LOG_COMMAND);
    settle(clock);
    fake.clickBar();
    expect(fake.showCalls).toHaveLength(1);
  });

  it('五态文案逐态落屏,未确认态禁称成功/禁用 Applied', () => {
    const clock = makeTimers();
    const fake = makeStatus(clock.timers);

    fake.controller.setReady(1, 500);
    settle(clock);
    expect(fake.bar.text).toBe(READY_FACE);
    fake.controller.setSending(['/a.py'], 500);
    settle(clock);
    expect(fake.bar.text).toBe(SENDING_FACE);
    fake.controller.setSentUnverified();
    settle(clock);
    expect(fake.bar.text).toBe(SENT_FACE);
    fake.controller.setFailed('boom');
    settle(clock);
    expect(fake.bar.text).toBe(FAILED_FACE);
    fake.controller.setWatchOff();
    settle(clock);
    expect(fake.bar.text).toBe(OFF_FACE);

    // 诚实口径:已发送态与全部状态文案不出现 成功/Applied
    fake.controller.setSentUnverified();
    settle(clock);
    expect(fake.bar.text).toContain('未确认');
    expect(fake.bar.text).not.toMatch(/成功|Applied/i);
    expect(fake.bar.tooltip).not.toMatch(/成功|Applied/i);
  });

  it('节流合并:窗内后续状态不上屏,尾沿一次渲染最终态', () => {
    const clock = makeTimers();
    const fake = makeStatus(clock.timers);
    settle(clock); // 构造渲染开的窗先关掉,驱动序列从干净基线开始

    fake.controller.setReady(1, 500);
    expect(fake.bar.text).toBe(READY_FACE);
    expect(clock.pending()).toBe(1);

    // 窗内连换两态:都不上屏,只留最新
    fake.controller.setSending(['/a.py'], 500);
    fake.controller.setSentUnverified();
    expect(fake.bar.text).toBe(READY_FACE);

    clock.tick(); // 尾沿:合并成一次最终态渲染
    expect(fake.bar.text).toBe(SENT_FACE);
  });

  it('日志行带 time 前缀,触发/结果/跳过逐条落账(不走节流)', () => {
    const clock = makeTimers();
    const fake = makeStatus(clock.timers);

    fake.controller.setReady(1, 500);
    fake.controller.setSending(['/ws/a.py', '/ws/b.py'], 500);
    fake.controller.setSentUnverified();
    fake.controller.setFailed('boom');
    fake.controller.setSkippedNoAction(['/ws/c.py']);

    expect(fake.lines).toEqual([
      `[12:34:56] 监视就绪: 1 个模式, 去抖 500ms`,
      `[12:34:56] 触发: /ws/a.py, /ws/b.py (去抖 500ms 到点)`,
      `[12:34:56] 结果: 已发送(未确认)——未校验业务回执`,
      `[12:34:56] 结果: 失败: boom`,
      `[12:34:56] 触发到点但未配动作名(kbengine.hotReload.actionName), 跳过: /ws/c.py`
    ]);
    // 日志即时落账:节流窗未 tick 也在账上
    expect(clock.pending()).toBeGreaterThan(0);
  });

  it('同类状态不重复记变更日志(防配置抖动刷屏)', () => {
    const clock = makeTimers();
    const fake = makeStatus(clock.timers);

    fake.controller.setReady(2, 500);
    fake.controller.setReady(3, 300);

    expect(fake.lines).toEqual(['[12:34:56] 监视就绪: 2 个模式, 去抖 500ms']);
  });

  it('dispose:清节流计时、释放命令/状态栏/通道,之后无迟到渲染', () => {
    const clock = makeTimers();
    const fake = makeStatus(clock.timers);
    settle(clock);

    fake.controller.setReady(1, 500);
    fake.controller.setSending(['/a.py'], 500); // 留在节流窗内
    fake.controller.dispose();

    expect(clock.pending()).toBe(0);
    expect(fake.commandState.disposed).toBe(true);
    expect(fake.bar.disposed).toBe(true);
    expect(fake.channelState.disposed).toBe(true);

    clock.tick();
    expect(fake.bar.text).toBe(READY_FACE); // 不再翻成 Sending
  });

  it('默认节流窗 200ms(HR-UI-007 同思路)', () => {
    expect(HOT_RELOAD_STATUS_THROTTLE_MS).toBe(200);
  });
});

describe('setupHotReload 状态机转移表(装配级)', () => {
  beforeEach(() => {
    configurationOverrides.clear();
    lastFileSystemWatcher.current = null;
  });

  const makeContext = (): vscode.ExtensionContext =>
    ({ subscriptions: [] }) as unknown as vscode.ExtensionContext;

  const fireConfig = (section: string): void => {
    workspaceEvents.configurationChanged.fire({
      affectsConfiguration: (candidate: string) => candidate === section
    });
  };

  it('默认关:初始态 Watch Off;配置改开 → Ready', () => {
    const clock = makeTimers();
    const statusClock = makeTimers();
    const fake = makeStatus(statusClock.timers);
    const context = makeContext();

    setupHotReload(context, () => undefined, {
      timers: clock.timers,
      status: fake.controller
    });
    settle(statusClock);
    expect(fake.bar.text).toBe(OFF_FACE);

    configurationOverrides.set('kbengine', {
      hotReload: { enabled: true, actionName: '热更', debounceMs: 100 }
    });
    fireConfig('kbengine');
    settle(statusClock);
    expect(fake.bar.text).toBe(READY_FACE);
    expect(fake.lines.some(line => line.includes('监视就绪: 1 个模式, 去抖 100ms'))).toBe(true);
  });

  it('事件→去抖到点→Sending→动作无错完成→Sent(未确认)+结果日志', async () => {
    configurationOverrides.set('kbengine', {
      hotReload: { enabled: true, actionName: '热更', debounceMs: 100 }
    });
    const clock = makeTimers();
    const statusClock = makeTimers();
    const fake = makeStatus(statusClock.timers);
    const runCalls: string[] = [];

    setupHotReload(makeContext(), name => void runCalls.push(name), {
      timers: clock.timers,
      status: fake.controller
    });
    settle(statusClock);

    lastFileSystemWatcher.current!.fireChange({ fsPath: '/ws/scripts/base/Account.py' } as never);
    expect(clock.pending()).toBe(1);
    clock.tick();
    settle(statusClock);
    expect(fake.bar.text).toBe(SENDING_FACE);

    await Promise.resolve();
    settle(statusClock);
    expect(fake.bar.text).toBe(SENT_FACE);
    expect(fake.bar.text).not.toMatch(/成功|Applied/i);
    expect(runCalls).toEqual(['热更']);
    expect(fake.lines).toEqual([
      expect.stringContaining('监视就绪: 1 个模式'),
      '[12:34:56] 触发: /ws/scripts/base/Account.py (去抖 100ms 到点)',
      '[12:34:56] 结果: 已发送(未确认)——未校验业务回执'
    ]);
  });

  it('动作异步拒绝 → Failed(保留既有错误报告通道)', async () => {
    configurationOverrides.set('kbengine', {
      hotReload: { enabled: true, actionName: '热更' }
    });
    const clock = makeTimers();
    const statusClock = makeTimers();
    const fake = makeStatus(statusClock.timers);
    const errors: unknown[] = [];

    setupHotReload(
      makeContext(),
      async () => {
        throw new Error('async boom');
      },
      {
        timers: clock.timers,
        status: fake.controller,
        onActionError: error => errors.push(error)
      }
    );
    settle(statusClock);

    lastFileSystemWatcher.current!.fireChange({ fsPath: '/a.py' } as never);
    clock.tick();
    await Promise.resolve();
    settle(statusClock);

    expect(fake.bar.text).toBe(FAILED_FACE);
    expect(errors).toEqual([new Error('async boom')]);
    expect(fake.lines.some(line => line.includes('结果: 失败: async boom'))).toBe(true);
  });

  it('转移表:debounce 期间关开关 → Watch Off(动作不执行、去抖取消)', () => {
    configurationOverrides.set('kbengine', {
      hotReload: { enabled: true, actionName: '热更', debounceMs: 100 }
    });
    const clock = makeTimers();
    const statusClock = makeTimers();
    const fake = makeStatus(statusClock.timers);
    const runCalls: string[] = [];

    setupHotReload(makeContext(), name => void runCalls.push(name), {
      timers: clock.timers,
      status: fake.controller
    });
    settle(statusClock);
    expect(fake.bar.text).toBe(READY_FACE);

    lastFileSystemWatcher.current!.fireChange({ fsPath: '/a.py' } as never);
    expect(clock.pending()).toBe(1);

    configurationOverrides.set('kbengine', { hotReload: { enabled: false } });
    fireConfig('kbengine');
    settle(statusClock);

    expect(clock.pending()).toBe(0);
    clock.tick();
    expect(runCalls).toEqual([]);
    expect(fake.bar.text).toBe(OFF_FACE);
  });

  it('转移表:到点但未配动作名 → 状态回落 Ready 不悬在 Sending', () => {
    configurationOverrides.set('kbengine', { hotReload: { enabled: true } });
    const clock = makeTimers();
    const statusClock = makeTimers();
    const fake = makeStatus(statusClock.timers);
    const runCalls: string[] = [];

    setupHotReload(makeContext(), name => void runCalls.push(name), {
      timers: clock.timers,
      status: fake.controller
    });
    settle(statusClock);

    lastFileSystemWatcher.current!.fireChange({ fsPath: '/a.py' } as never);
    clock.tick();
    settle(statusClock);

    expect(runCalls).toEqual([]);
    expect(fake.bar.text).toBe(READY_FACE);
    expect(fake.lines.some(line => line.includes('触发到点但未配动作名'))).toBe(true);
  });

  it('deactivate:复合 disposable 释放 watcher 与状态栏/通道/命令', () => {
    configurationOverrides.set('kbengine', {
      hotReload: { enabled: true, actionName: '热更' }
    });
    const clock = makeTimers();
    const statusClock = makeTimers();
    const fake = makeStatus(statusClock.timers);
    const context = makeContext();

    setupHotReload(context, () => undefined, {
      timers: clock.timers,
      status: fake.controller
    });
    expect(context.subscriptions).toHaveLength(1);

    let watcherDisposed = 0;
    const watcher = lastFileSystemWatcher.current!;
    watcher.dispose = (): void => {
      watcherDisposed += 1;
    };
    context.subscriptions[0].dispose();

    expect(watcherDisposed).toBe(1);
    expect(fake.bar.disposed).toBe(true);
    expect(fake.channelState.disposed).toBe(true);
    expect(fake.commandState.disposed).toBe(true);
  });

  it('缺省构造:走真 vscode 工厂,状态栏项/日志通道/命令齐备', () => {
    const context = makeContext();
    const clock = makeTimers();
    const barCount = statusBars.length;
    const channelCount = channels.length;

    setupHotReload(context, () => undefined, { timers: clock.timers });

    const bar = statusBars[barCount];
    expect(bar).toBeDefined();
    expect(bar.alignment).toBe(vscode.StatusBarAlignment.Right);
    expect(bar.priority).toBe(98);
    expect(bar.command).toBe(HOT_RELOAD_SHOW_LOG_COMMAND);
    expect(bar.visible).toBe(true);
    expect(bar.text).toBe(OFF_FACE);
    expect(channels[channelCount].name).toBe(HOT_RELOAD_LOG_CHANNEL_NAME);
    expect(context.subscriptions).toHaveLength(1);

    context.subscriptions[0].dispose();
    expect(bar.disposed).toBe(true);
    expect(channels[channelCount].disposed).toBe(true);
  });
});
