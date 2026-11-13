import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import {
  HOT_RELOAD_DEFAULT_DEBOUNCE_MS,
  HOT_RELOAD_TOGGLE_COMMAND,
  HotReloadTrigger,
  readHotReloadSettings,
  realHotReloadTimerDeps,
  setupHotReload
} from '../src/hotReload';
import type { HotReloadTimerDeps } from '../src/hotReload';
import type { HotReloadStatusController } from '../src/hotReloadStatus';
import {
  channels,
  commands,
  configurationOverrides,
  lastFileSystemWatcher,
  messages,
  workspace,
  workspaceEvents,
  workspaceState
} from './helpers/vscodeStub';
import { readHotReloadEnabled } from '../src/hotReloadToggle';
import packageJson from '../package.json';
import * as fs from 'fs';
import * as path from 'path';

/** 「KBEngine 热更新」审计通道的全部行(装配逐次建通道,取同名通道并集) */
const hotReloadLogLines = (): string[] =>
  channels.filter(channel => channel.name === 'KBEngine 热更新').flatMap(channel => channel.lines);

// 功能差距盘点 G5(docs/reference-feature-gap.md):文件保存/监视 → 触发指定
// quick action。用户令 2026-11-06:热更默认开启,未配动作名时保存即按默认
// 热更端点 POST(模块名入 body),一键关 = 状态栏点击/ kbengine.hotReload.toggle。
// 定时器注入,不用假时钟,断言顺序确定。

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

const readerOf = (values: Record<string, unknown>): {
  get: <T>(key: string, defaultValue: T) => T;
} => ({ get: <T>(key: string, defaultValue: T): T => (values[key] as T) ?? defaultValue });

/** 状态面探针:装配注入口的最小同形替身,逐调用记账供断言 */
const makeStatusProbe = (): {
  status: HotReloadStatusController;
  calls: Array<[string, ...unknown[]]>;
} => {
  const calls: Array<[string, ...unknown[]]> = [];
  const record = (name: string, ...args: unknown[]): void => {
    calls.push([name, ...args]);
  };
  const status = {
    log: (text: string) => record('log', text),
    setWatchOff: () => record('watch-off'),
    setReady: (...args: unknown[]) => record('ready', ...args),
    setSending: (...args: unknown[]) => record('sending', ...args),
    setSentUnverified: () => record('sent-unverified'),
    setFailed: (detail: string) => record('failed', detail),
    setSkippedNoAction: (...args: unknown[]) => record('skipped-no-action', ...args),
    setRestartRequired: (...args: unknown[]) => record('restart-required', ...args),
    dispose: () => record('dispose')
  };
  return { status: status as unknown as HotReloadStatusController, calls };
};

/** 让注入的异步发送链跑完(传输与状态回写都在微任务里) */
const flushMicrotasks = (): Promise<void> =>
  new Promise(resolve => {
    setImmediate(resolve);
  });

/** 极简 memento(workspaceState 面),首激活提示记账用 */
const makeMemento = (): { get: <T>(key: string, defaultValue?: T) => T | undefined; update: (key: string, value: unknown) => Promise<void> } => {
  const store = new Map<string, unknown>();
  return {
    get: <T,>(key: string, defaultValue?: T): T | undefined =>
      store.has(key) ? (store.get(key) as T) : defaultValue,
    update: async (key: string, value: unknown): Promise<void> => {
      if (value === undefined) store.delete(key);
      else store.set(key, value);
    }
  };
};

describe('readHotReloadSettings(默认值与畸形值回落)', () => {
  it('全部缺省:开(用户令 2026-11-06 热更默认开启)、无动作名、globs 未写(交派生)与默认去抖', () => {
    expect(readHotReloadSettings(readerOf({}))).toEqual({
      enabled: true,
      actionName: '',
      globs: [],
      globsSpec: 'unset',
      debounceMs: 500
    });
    // §11.1:未写 globs 不再回落裸 `**/*.py`(旧默认会全工作区扫),
    // 空表 + spec=unset 交给 assetsRoot 派生(见 hotReloadAssetsRootWatch)
    expect(HOT_RELOAD_DEFAULT_DEBOUNCE_MS).toBe(500);
  });

  it('合法值原样回显(多模式与 0 去抖都收,来源标 explicit)', () => {
    expect(
      readHotReloadSettings(
        readerOf({
          enabled: true,
          actionName: '热更',
          globs: ['**/*.py', '**/*.def'],
          debounceMs: 0
        })
      )
    ).toEqual({
      enabled: true,
      actionName: '热更',
      globs: ['**/*.py', '**/*.def'],
      globsSpec: 'explicit',
      debounceMs: 0
    });
  });

  it('类型错就回落:非布尔 enabled、非数组 globs(按未写处理)、坏去抖值', () => {
    expect(
      readHotReloadSettings(
        readerOf({
          enabled: 'yes',
          actionName: 42,
          globs: '**/*.py',
          debounceMs: -1
        })
      )
    ).toEqual({
      enabled: true,
      actionName: '',
      globs: [],
      globsSpec: 'unset',
      debounceMs: 500
    });
    // 非数字不硬转:字符串去抖值同样回落默认
    expect(readHotReloadSettings(readerOf({ debounceMs: '500' }))).toMatchObject({
      debounceMs: 500
    });
  });

  it('globs 里的空串与非字符串项被剔除,剔空按「显式空数组」处理(watch-off)', () => {
    expect(
      readHotReloadSettings(readerOf({ globs: ['', '  ', 7, '**/*.def'] }))
    ).toEqual({
      enabled: true,
      actionName: '',
      globs: ['**/*.def'],
      globsSpec: 'explicit',
      debounceMs: 500
    });
    // 用户碰过 globs 字段(哪怕全是空项)= 显式空 → 不监视,既不回落旧默认
    // `**/*.py`,也不交给 assetsRoot 派生(§11.1 empty-globs 关法)
    expect(readHotReloadSettings(readerOf({ globs: ['', 7] }))).toEqual({
      enabled: true,
      actionName: '',
      globs: [],
      globsSpec: 'explicit',
      debounceMs: 500
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

  it('零热更配置默认开:未写 globs 按 assetsRoot 派生建 watcher(复合订阅随装配释放)', () => {
    const context = makeContext();
    const clock = makeTimers();
    const runCalls: string[] = [];
    // §11.1:派生需要解析得到的资产根(未写 globs → `<assetsRoot>/**/*.py`),
    // 不再有裸 `**/*.py` 全工作区默认
    configurationOverrides.set('kbengine', { assetsRoot: process.cwd() });

    setupHotReload(context, name => void runCalls.push(name), {
      timers: clock.timers,
      defaultHotfix: { transport: () => Promise.resolve({ ok: true, status: 200, durationMs: 1, body: '' }) }
    });

    expect(context.subscriptions).toHaveLength(1);
    expect(lastFileSystemWatcher.current).not.toBeNull();
  });

  it('package.json 默认 enabled=true,markdownDescription 不再是「默认关防误触」', () => {
    const raw = packageJson as unknown as {
      contributes: { configuration: { properties: Record<string, { default: unknown; markdownDescription: string }> } };
    };
    // KODE-I18N-001 起描述文案外置 package.nls*.json(%key% 占位),契约按解析后默认包文案断言
    const nls = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.nls.json'), 'utf8')) as Record<string, string>;
    const desc = raw.contributes.configuration.properties['kbengine.hotReload.enabled'].markdownDescription
      .replace(/^%([^%]+)%$/, (_m, key: string) => nls[key] ?? key);
    expect(raw.contributes.configuration.properties['kbengine.hotReload.enabled'].default).toBe(true);
    // 2026-11-06 起配置键提示统一 markdownDescription,裸 description 已移除
    expect(desc).not.toContain('默认关防误触');
    expect(desc).toContain('127.0.0.1:8090/hotfix');
  });

  it('启用即按模式各建一个 watcher,保存事件去抖后按名执行', () => {
    configurationOverrides.set('kbengine', {
      hotReload: { enabled: true, globs: ['**/*.py'], actionName: '热更', debounceMs: 100 }
    });
    const context = makeContext();
    const clock = makeTimers();
    const runCalls: string[] = [];

    setupHotReload(context, name => void runCalls.push(name), { timers: clock.timers });

    expect(lastFileSystemWatcher.current).not.toBeNull();
    lastFileSystemWatcher.current!.fireChange({ fsPath: '/ws/scripts/base/Account.py' } as never);
    // HR-PR-04 两级形态:在途计时=进料级流水线去抖 + 合并窗,各一枚
    expect(clock.pending()).toBe(2);
    lastFileSystemWatcher.current!.fireCreate({ fsPath: '/ws/scripts/base/Account.py' } as never);
    // 同文件重排:两枚都重排(尾窗),不增枚
    expect(clock.pending()).toBe(2);

    clock.tick();
    expect(runCalls).toEqual(['热更']);
  });

  it('三种事件通道都触发,连发仍合并成一次', () => {
    configurationOverrides.set('kbengine', { hotReload: { enabled: true, globs: ['**/*.py'], actionName: '热更' } });
    const context = makeContext();
    const clock = makeTimers();
    const runCalls: string[] = [];

    setupHotReload(context, name => void runCalls.push(name), { timers: clock.timers });

    lastFileSystemWatcher.current!.fireDelete({ fsPath: '/a.py' } as never);
    lastFileSystemWatcher.current!.fireChange({ fsPath: '/a.py' } as never);
    clock.tick();
    lastFileSystemWatcher.current!.fireChange({ fsPath: '/b.py' } as never);
    // HR-PR-04 两级形态:b.py 的进料级去抖 + 合并窗,同拍各一枚
    expect(clock.tick()).toBe(2);

    expect(runCalls).toEqual(['热更', '热更']);
  });

  it('未配动作名:事件到了改走默认热更 POST(不再空转),quick action 通道不触发', async () => {
    configurationOverrides.set('kbengine', { hotReload: { enabled: true, globs: ['**/*.py'] } });
    const context = makeContext();
    const clock = makeTimers();
    const runCalls: string[] = [];
    const sent: Array<{ url: string; method: string; body: string }> = [];
    const probe = makeStatusProbe();

    setupHotReload(context, name => void runCalls.push(name), {
      timers: clock.timers,
      status: probe.status,
      defaultHotfix: {
        transport: request => {
          sent.push({ url: request.url, method: request.method, body: request.body });
          return Promise.resolve({ ok: true, status: 200, durationMs: 1, body: 'ok' });
        }
      }
    });

    lastFileSystemWatcher.current!.fireChange({ fsPath: '/ws/scripts/base/Account.py' } as never);
    clock.tick();
    await flushMicrotasks();

    expect(runCalls).toEqual([]);
    expect(sent).toEqual([
      {
        url: 'http://127.0.0.1:8090/hotfix?module_name=Account',
        method: 'POST',
        body: 'module_name=Account'
      }
    ]);
    // 发出面只到「已发送(未确认)」,绝不标已生效
    expect(probe.calls).toContainEqual(['sent-unverified']);
    expect(probe.calls.some(call => call[0] === 'failed')).toBe(false);
  });

  it('默认热更:引擎不可达如实报 failed(不假成功)', async () => {
    configurationOverrides.set('kbengine', {
      hotReload: { enabled: true, globs: ['**/*.py'] }
    });
    const context = makeContext();
    const clock = makeTimers();
    const probe = makeStatusProbe();

    setupHotReload(context, () => undefined, {
      timers: clock.timers,
      status: probe.status,
      defaultHotfix: {
        transport: () =>
          Promise.resolve({
            ok: false,
            status: 0,
            durationMs: 1,
            body: '',
            error: 'connect ECONNREFUSED 127.0.0.1:8090'
          })
      }
    });

    lastFileSystemWatcher.current!.fireChange({ fsPath: '/ws/scripts/base/Account.py' } as never);
    clock.tick();
    await flushMicrotasks();

    expect(probe.calls).toContainEqual(['failed', expect.stringContaining('ECONNREFUSED')]);
    expect(probe.calls).not.toContainEqual(['sent-unverified']);
  });

  it('显式写死 false 仍必须关(不被默认开顶掉):不建 watcher', () => {
    configurationOverrides.set('kbengine', { hotReload: { enabled: false } });
    const context = makeContext();
    const clock = makeTimers();

    setupHotReload(context, () => undefined, { timers: clock.timers });

    expect(lastFileSystemWatcher.current).toBeNull();
    expect(readHotReloadSettings(readerOf({ enabled: false })).enabled).toBe(false);
  });

  it('触发期同步执行抛错:不外抛并报告错误', () => {
    configurationOverrides.set('kbengine', { hotReload: { enabled: true, globs: ['**/*.py'], actionName: '热更' } });
    const context = makeContext();
    const clock = makeTimers();
    const errors: unknown[] = [];

    setupHotReload(
      context,
      () => {
        throw new Error('boom');
      },
      { timers: clock.timers, onActionError: error => errors.push(error) }
    );

    lastFileSystemWatcher.current!.fireChange({ fsPath: '/a.py' } as never);
    expect(() => clock.tick()).not.toThrow();
    expect(errors).toEqual([new Error('boom')]);
  });

  it('触发期异步执行拒绝:捕获并报告,不产生未处理拒绝', async () => {
    configurationOverrides.set('kbengine', { hotReload: { enabled: true, globs: ['**/*.py'], actionName: '热更' } });
    const context = makeContext();
    const clock = makeTimers();
    const errors: unknown[] = [];

    setupHotReload(
      context,
      async () => {
        throw new Error('async boom');
      },
      { timers: clock.timers, onActionError: error => errors.push(error) }
    );

    lastFileSystemWatcher.current!.fireChange({ fsPath: '/a.py' } as never);
    expect(() => clock.tick()).not.toThrow();
    await Promise.resolve();
    expect(errors).toEqual([new Error('async boom')]);
  });

  it('配置变更联动:关→开建 watcher,开→关拆除(去抖中一并取消)', () => {
    configurationOverrides.set('kbengine', { hotReload: { enabled: false } });
    const context = makeContext();
    const clock = makeTimers();
    const runCalls: string[] = [];

    setupHotReload(context, name => void runCalls.push(name), {
      timers: clock.timers,
      defaultHotfix: { transport: () => Promise.resolve({ ok: true, status: 200, durationMs: 1, body: '' }) }
    });
    expect(lastFileSystemWatcher.current).toBeNull();

    configurationOverrides.set('kbengine', {
      hotReload: { enabled: true, globs: ['**/*.py'], actionName: '热更', debounceMs: 100 }
    });
    workspaceEvents.configurationChanged.fire({
      affectsConfiguration: (section: string) => section === 'kbengine'
    });
    const watcher = lastFileSystemWatcher.current;
    expect(watcher).not.toBeNull();
    watcher!.fireChange({ fsPath: '/a.py' } as never);
    // HR-PR-04 两级形态:进料级去抖 + 合并窗,在途两枚
    expect(clock.pending()).toBe(2);

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
      hotReload: { enabled: true, globs: ['**/*.py'], actionName: '热更' }
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

  it('一键关:kbengine.hotReload.toggle 写回配置并当场拆 watcher', async () => {
    const context = makeContext();
    const clock = makeTimers();
    workspaceState.workspaceConfigurationUpdates.length = 0;
    // 零热更配置(默认开)+ 资产根可解析 → 派生出监视,才有可拆的 watcher
    configurationOverrides.set('kbengine', { assetsRoot: process.cwd() });

    setupHotReload(context, () => undefined, {
      timers: clock.timers,
      defaultHotfix: { transport: () => Promise.resolve({ ok: true, status: 200, durationMs: 1, body: '' }) }
    });
    expect(lastFileSystemWatcher.current).not.toBeNull();
    let disposed = 0;
    lastFileSystemWatcher.current!.dispose = () => {
      disposed += 1;
    };

    await commands.executeCommand(HOT_RELOAD_TOGGLE_COMMAND);

    expect(workspaceState.workspaceConfigurationUpdates).toContainEqual(
      expect.objectContaining({ key: 'kbengine.hotReload.enabled', value: false })
    );
    // 配置写回后即时生效:配置事件一到 watcher 拆除(不必重启窗口)
    workspaceEvents.configurationChanged.fire({
      affectsConfiguration: (section: string) => section === 'kbengine'
    });
    expect(disposed).toBe(1);
  });

  it('显式关着再点一键开关 = 打开(写回 true)', async () => {
    configurationOverrides.set('kbengine', { hotReload: { enabled: false } });
    const context = makeContext();
    const clock = makeTimers();
    workspaceState.workspaceConfigurationUpdates.length = 0;

    setupHotReload(context, () => undefined, { timers: clock.timers });

    await commands.executeCommand(HOT_RELOAD_TOGGLE_COMMAND);

    expect(workspaceState.workspaceConfigurationUpdates).toContainEqual(
      expect.objectContaining({ key: 'kbengine.hotReload.enabled', value: true })
    );
  });

  it('一键关写工作区级(开着文件夹就写 .vscode/settings.json),写后生效值真翻转', async () => {
    // 工作区级覆盖存在时,误写用户级盖不掉它——必须写 Workspace 才改得到生效值
    configurationOverrides.set('kbengine', { hotReload: { enabled: false } });
    const previousFolders = workspace.workspaceFolders;
    workspace.workspaceFolders = [{ uri: vscode.Uri.file('/ws'), name: 'ws', index: 0 }];
    try {
      const context = makeContext();
      const clock = makeTimers();
      workspaceState.workspaceConfigurationUpdates.length = 0;

      setupHotReload(context, () => undefined, { timers: clock.timers });
      expect(readHotReloadEnabled()).toBe(false);

      await commands.executeCommand(HOT_RELOAD_TOGGLE_COMMAND);

      expect(workspaceState.workspaceConfigurationUpdates).toContainEqual(
        expect.objectContaining({
          key: 'kbengine.hotReload.enabled',
          value: true,
          scope: vscode.ConfigurationTarget.Workspace
        })
      );
      expect(readHotReloadEnabled()).toBe(true);
    } finally {
      workspace.workspaceFolders = previousFolders;
    }
  });

  it('写错作用域被工作区覆盖压住时如实报错(不谎报成功),生效值不动', async () => {
    // 没有文件夹 → 目标是用户级;但工作区级覆盖仍在 → 生效值翻不动 → 必须报错
    configurationOverrides.set('kbengine', { hotReload: { enabled: false } });
    const context = makeContext();
    const clock = makeTimers();
    workspaceState.workspaceConfigurationUpdates.length = 0;

    setupHotReload(context, () => undefined, { timers: clock.timers });

    await commands.executeCommand(HOT_RELOAD_TOGGLE_COMMAND);
    await flushMicrotasks();

    expect(readHotReloadEnabled()).toBe(false);
    expect(hotReloadLogLines().some(line => line.includes('一键开关写回配置失败'))).toBe(true);
    expect(messages.error.some(message => message.includes('未生效'))).toBe(true);
  });

  it('写回配置被拒(只读/远程受限)如实上报,不静默吞', async () => {
    const context = makeContext();
    const clock = makeTimers();
    const original = workspace.getConfiguration;
    workspace.getConfiguration = ((section?: string, scope?: unknown) => {
      const real = original(section, scope);
      return {
        get: real.get.bind(real),
        update: () => Promise.reject(new Error('settings file is read-only'))
      } as typeof real;
    }) as typeof workspace.getConfiguration;
    try {
      setupHotReload(context, () => undefined, { timers: clock.timers });

      await commands.executeCommand(HOT_RELOAD_TOGGLE_COMMAND);
      await flushMicrotasks();

      expect(hotReloadLogLines().some(line => line.includes('一键开关写回配置失败'))).toBe(true);
      expect(messages.error.some(message => message.includes('read-only'))).toBe(true);
    } finally {
      workspace.getConfiguration = original;
    }
  });

  it('首次激活弹一次非模态提示(可永久关闭),记 flag 后不再打扰', async () => {
    const context = {
      subscriptions: [],
      workspaceState: makeMemento()
    } as unknown as vscode.ExtensionContext;
    const clock = makeTimers();
    const before = messages.info.length;

    setupHotReload(context, () => undefined, {
      timers: clock.timers,
      defaultHotfix: { transport: () => Promise.resolve({ ok: true, status: 200, durationMs: 1, body: '' }) }
    });
    await flushMicrotasks();

    const notice = messages.info.slice(before);
    expect(notice).toHaveLength(1);
    expect(notice[0]).toContain('127.0.0.1:8090/hotfix');
    expect(notice[0]).toContain(HOT_RELOAD_TOGGLE_COMMAND);
    expect(context.workspaceState.get<boolean>('kbengine.hotReload.firstRunNotice')).toBe(true);

    // 再装配一次(等价再次激活):flag 已在,不再弹
    setupHotReload(context, () => undefined, {
      timers: clock.timers,
      defaultHotfix: { transport: () => Promise.resolve({ ok: true, status: 200, durationMs: 1, body: '' }) }
    });
    await flushMicrotasks();
    expect(messages.info.length).toBe(before + 1);
  });
});
