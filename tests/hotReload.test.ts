import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import {
  HOT_RELOAD_DEFAULT_DEBOUNCE_MS,
  HOT_RELOAD_DEFAULT_GLOBS,
  HotReloadTrigger,
  readHotReloadSettings,
  realHotReloadTimerDeps,
  setupHotReload
} from '../src/hotReload';
import type { HotReloadTimerDeps } from '../src/hotReload';
import {
  configurationOverrides,
  lastFileSystemWatcher,
  workspaceEvents
} from './helpers/vscodeStub';

// 功能差距盘点 G5(docs/reference-feature-gap.md):文件保存/监视 → 触发指定
// quick action。默认关防误触;启用后才建 watcher,去抖合并连发保存。
// 定时器注入,不用假时钟,断言顺序确定。

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

const readerOf = (values: Record<string, unknown>): {
  get: <T>(key: string, defaultValue: T) => T;
} => ({ get: <T>(key: string, defaultValue: T): T => (values[key] as T) ?? defaultValue });

describe('readHotReloadSettings(默认值与畸形值回落)', () => {
  it('全部缺省:关、无动作名、默认匹配与去抖', () => {
    expect(readHotReloadSettings(readerOf({}))).toEqual({
      enabled: false,
      actionName: '',
      globs: ['**/*.py'],
      debounceMs: 500
    });
    expect(HOT_RELOAD_DEFAULT_GLOBS).toEqual(['**/*.py']);
    expect(HOT_RELOAD_DEFAULT_DEBOUNCE_MS).toBe(500);
  });

  it('合法值原样回显(多模式与 0 去抖都收)', () => {
    expect(
      readHotReloadSettings(
        readerOf({
          enabled: true,
          actionName: '热更',
          globs: ['**/*.py', '**/*.def'],
          debounceMs: 0
        })
      )
    ).toEqual({ enabled: true, actionName: '热更', globs: ['**/*.py', '**/*.def'], debounceMs: 0 });
  });

  it('类型错就回落:非布尔 enabled、非数组 globs、坏去抖值', () => {
    expect(
      readHotReloadSettings(
        readerOf({
          enabled: 'yes',
          actionName: 42,
          globs: '**/*.py',
          debounceMs: -1
        })
      )
    ).toEqual({ enabled: false, actionName: '', globs: ['**/*.py'], debounceMs: 500 });
    // 非数字不硬转:字符串去抖值同样回落默认
    expect(readHotReloadSettings(readerOf({ debounceMs: '500' }))).toMatchObject({
      debounceMs: 500
    });
  });

  it('globs 里的空串与非字符串项被剔除,剔空则回落默认', () => {
    expect(
      readHotReloadSettings(readerOf({ globs: ['', '  ', 7, '**/*.def'] }))
    ).toEqual({ enabled: false, actionName: '', globs: ['**/*.def'], debounceMs: 500 });
    expect(readHotReloadSettings(readerOf({ globs: ['', 7] }))).toMatchObject({
      globs: ['**/*.py']
    });
  });
});

describe('HotReloadTrigger(去抖)', () => {
  it('schedule 按给定毫秒建计时,tick 后触发一次', () => {
    const clock = makeTimers();
    let fired = 0;
    const trigger = new HotReloadTrigger(() => void fired++, clock.timers);

    trigger.schedule(250);

    expect(clock.pending()).toBe(1);
    expect(clock.tick()).toBe(1);
    expect(fired).toBe(1);
    expect(clock.pending()).toBe(0);
  });

  it('连发只保留最后一次(去抖),前一次被清掉', () => {
    const clock = makeTimers();
    let fired = 0;
    const trigger = new HotReloadTrigger(() => void fired++, clock.timers);

    trigger.schedule(500);
    trigger.schedule(500);
    trigger.schedule(500);

    expect(clock.pending()).toBe(1);
    clock.tick();
    expect(fired).toBe(1);
  });

  it('cancel 取消未触发的计时', () => {
    const clock = makeTimers();
    let fired = 0;
    const trigger = new HotReloadTrigger(() => void fired++, clock.timers);

    trigger.schedule(500);
    trigger.cancel();

    expect(clock.pending()).toBe(0);
    expect(clock.tick()).toBe(0);
    expect(fired).toBe(0);
  });

  it('dispose 清掉计时且不再触发', () => {
    const clock = makeTimers();
    let fired = 0;
    const trigger = new HotReloadTrigger(() => void fired++, clock.timers);

    trigger.schedule(500);
    trigger.dispose();

    expect(clock.pending()).toBe(0);
    expect(clock.tick()).toBe(0);
    expect(fired).toBe(0);
  });

  it('装配缺省走真 setTimeout(set 与 clear 都落实)', () => {
    vi.useFakeTimers();
    try {
      let fired = 0;
      const trigger = new HotReloadTrigger(() => void fired++, realHotReloadTimerDeps);

      trigger.schedule(250);
      trigger.schedule(100);
      expect(fired).toBe(0);

      vi.advanceTimersByTime(250);
      expect(fired).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('setupHotReload(装配)', () => {
  beforeEach(() => {
    configurationOverrides.clear();
    lastFileSystemWatcher.current = null;
  });

  const makeContext = (): vscode.ExtensionContext =>
    ({ subscriptions: [] }) as unknown as vscode.ExtensionContext;

  it('默认关:不建 watcher,只挂配置变更监听', () => {
    const context = makeContext();
    const clock = makeTimers();
    const runCalls: string[] = [];

    setupHotReload(context, name => void runCalls.push(name), { timers: clock.timers });

    expect(context.subscriptions).toHaveLength(1);
    expect(lastFileSystemWatcher.current).toBeNull();
  });

  it('启用即按模式各建一个 watcher,保存事件去抖后按名执行', () => {
    configurationOverrides.set('kbengine', {
      hotReload: { enabled: true, actionName: '热更', debounceMs: 100 }
    });
    const context = makeContext();
    const clock = makeTimers();
    const runCalls: string[] = [];

    setupHotReload(context, name => void runCalls.push(name), { timers: clock.timers });

    expect(lastFileSystemWatcher.current).not.toBeNull();
    lastFileSystemWatcher.current!.fireChange({ fsPath: '/ws/scripts/base/Account.py' } as never);
    expect(clock.pending()).toBe(1);
    lastFileSystemWatcher.current!.fireCreate({ fsPath: '/ws/scripts/base/Account.py' } as never);
    expect(clock.pending()).toBe(1);

    clock.tick();
    expect(runCalls).toEqual(['热更']);
  });

  it('三种事件通道都触发,连发仍合并成一次', () => {
    configurationOverrides.set('kbengine', { hotReload: { enabled: true, actionName: '热更' } });
    const context = makeContext();
    const clock = makeTimers();
    const runCalls: string[] = [];

    setupHotReload(context, name => void runCalls.push(name), { timers: clock.timers });

    lastFileSystemWatcher.current!.fireDelete({ fsPath: '/a.py' } as never);
    lastFileSystemWatcher.current!.fireChange({ fsPath: '/a.py' } as never);
    clock.tick();
    lastFileSystemWatcher.current!.fireChange({ fsPath: '/b.py' } as never);
    expect(clock.tick()).toBe(1);

    expect(runCalls).toEqual(['热更', '热更']);
  });

  it('未配动作名:事件到了也不触发执行', () => {
    configurationOverrides.set('kbengine', { hotReload: { enabled: true } });
    const context = makeContext();
    const clock = makeTimers();
    const runCalls: string[] = [];

    setupHotReload(context, name => void runCalls.push(name), { timers: clock.timers });

    lastFileSystemWatcher.current!.fireChange({ fsPath: '/a.py' } as never);
    clock.tick();
    expect(runCalls).toEqual([]);
  });

  it('触发期执行抛错:不外抛(事件回调不能炸)', () => {
    configurationOverrides.set('kbengine', { hotReload: { enabled: true, actionName: '热更' } });
    const context = makeContext();
    const clock = makeTimers();

    setupHotReload(
      context,
      () => {
        throw new Error('boom');
      },
      { timers: clock.timers }
    );

    lastFileSystemWatcher.current!.fireChange({ fsPath: '/a.py' } as never);
    expect(() => clock.tick()).not.toThrow();
  });

  it('配置变更联动:关→开建 watcher,开→关拆除(去抖中一并取消)', () => {
    const context = makeContext();
    const clock = makeTimers();
    const runCalls: string[] = [];

    setupHotReload(context, name => void runCalls.push(name), { timers: clock.timers });
    expect(lastFileSystemWatcher.current).toBeNull();

    configurationOverrides.set('kbengine', {
      hotReload: { enabled: true, actionName: '热更', debounceMs: 100 }
    });
    workspaceEvents.configurationChanged.fire({
      affectsConfiguration: (section: string) => section === 'kbengine'
    });
    const watcher = lastFileSystemWatcher.current;
    expect(watcher).not.toBeNull();
    watcher!.fireChange({ fsPath: '/a.py' } as never);
    expect(clock.pending()).toBe(1);

    // 去抖期间关掉:计时取消、watcher 拆除、动作不执行
    let firstDisposed = 0;
    watcher!.dispose = () => {
      firstDisposed += 1;
    };
    configurationOverrides.set('kbengine', { hotReload: { enabled: false } });
    workspaceEvents.configurationChanged.fire({
      affectsConfiguration: (section: string) => section === 'kbengine'
    });
    expect(firstDisposed).toBe(1);
    expect(clock.pending()).toBe(0);
    clock.tick();
    expect(runCalls).toEqual([]);

    // 非 kbengine 段的配置变更不触碰 watcher
    workspaceEvents.configurationChanged.fire({
      affectsConfiguration: (section: string) => section === 'files'
    });
    expect(lastFileSystemWatcher.current).toBe(watcher);

    // 改回开:重建 watcher
    configurationOverrides.set('kbengine', {
      hotReload: { enabled: true, actionName: '热更' }
    });
    workspaceEvents.configurationChanged.fire({
      affectsConfiguration: (section: string) => section === 'kbengine'
    });
    const secondWatcher = lastFileSystemWatcher.current;
    expect(secondWatcher).not.toBeNull();
    expect(secondWatcher).not.toBe(watcher);

    // 装配拆除:新建的 watcher 被 dispose
    let secondDisposed = 0;
    secondWatcher!.dispose = () => {
      secondDisposed += 1;
    };
    context.subscriptions[0].dispose();
    expect(secondDisposed).toBe(1);
  });
});
