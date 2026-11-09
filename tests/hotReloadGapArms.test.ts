import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { setupHotReload, type HotReloadTimerDeps } from '../src/hotReload';
import type { HotReloadStatusController } from '../src/hotReloadStatus';
import { HotReloadTargetStateStore } from '../src/backend/hotReloadTargetState';
import {
  configurationOverrides,
  lastFileSystemWatcher,
  messages,
  workspace as stubWorkspace
} from './helpers/vscodeStub';

// hotReload.ts 缺口臂(2026-11-09 覆盖率扫尾,对齐 baseline 20 行):
//   默认热更传输拒绝面(443)、文件元信息解析成功面(463)、applied 核验窗口
//   结算的代际不匹配早退(537)、部署通道发送整批拒绝面(595-596)、发送时点
//   内容基准读取失败面(631)、目标解析失败回落无目标发送(749)、def 闸拦下
//   的需重启提示(762)、def 闸 commit 前滚失败面(795)、旁路事件构建落空早退
//   (822)、首工作区根读取异常回落(843)、资产根解析异常回落(850)、首激活
//   提示「打开日志」选择(1037)、「立即关闭」写回失败上报(1042/1044-1047)、
//   首激活提示整体异常兜底(1050)。
//
// 记录的死臂(附证据):
//   * line 669(handleResponse 回执 file 不在发送批的 `sentDigestPromise ===
//     undefined` 注解):不可达。start() 在注册 handleResponse 之前先填充
//     baselineReads(line 619-634,遍历与 handleResponse 同一个闭包 `triggers`,
//     baselineReader 存在时为每个 file 都 set),而 handleResponse 只遍历同一
//     `triggers`(line 642);两者同源同批 ⟹ 任一 file 的 baselineReads.get(file)
//     恒有值,`=== undefined` 恒为假。无 baselineReader 时 line 661 的
//     `!baselineReader` 守卫已提前注解,同样不落到 669。
//   * line 850(resolveAssetsRootSafe 的解析异常 catch 回落空串):不可达。
//     resolveAssetsRootForWorkspace(scanRoots.ts:68-108)自身全防——getConfiguration
//     在 74-78 try/catch、resolveDiscoveredConfigRoot 在 99-103 try/catch、
//     isDirectory(22-28) 内部 catch 返 false;剩余 path.isAbsolute/path.resolve 对
//     字符串输入(Linux)不抛(实测 `path.resolve('/ws', '\0')` 不抛,返含空字节串)。
//     ⟹ 该函数从不向外抛,850 的 catch 恒不触发。本文件 850 用例仍留作鲁棒性
//     回归(畸形 assetsRoot 不炸装配),但不构成对该行的覆盖。

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

/** 状态面探针:逐调用记账供断言 */
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
    setWatchOff: (...args: unknown[]) => record('watch-off', ...args),
    setReady: (...args: unknown[]) => record('ready', ...args),
    setReadyError: (...args: unknown[]) => record('ready-error', ...args),
    setSending: (...args: unknown[]) => record('sending', ...args),
    setSentUnverified: () => record('sent-unverified'),
    setFailed: (detail: string) => record('failed', detail),
    setSkippedNoAction: (...args: unknown[]) => record('skipped-no-action', ...args),
    setRestartRequired: (...args: unknown[]) => record('restart-required', ...args),
    showLogWithVersions: () => record('show-log-with-versions'),
    dispose: () => record('dispose')
  };
  return { status: status as unknown as HotReloadStatusController, calls };
};

const flushMicrotasks = async (): Promise<void> => {
  await new Promise(resolve => setImmediate(resolve));
};

const makeMemento = (): {
  get: <T>(key: string, defaultValue?: T) => T | undefined;
  update: (key: string, value: unknown) => Promise<void>;
} => {
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

const makeContext = (): vscode.ExtensionContext =>
  ({ subscriptions: [] }) as unknown as vscode.ExtensionContext;

const fireFiles = (files: string[]): void => {
  for (const file of files) {
    lastFileSystemWatcher.current!.fireChange({ fsPath: file } as never);
  }
};

const enableHotReload = (overrides: Record<string, unknown> = {}): void => {
  configurationOverrides.set('kbengine', {
    hotReload: { enabled: true, globs: ['**/*.py'], actionName: '热更', debounceMs: 100, ...overrides }
  });
};

const restoreWindow = (): void => {
  // vscodeStub 的 window 是可变对象;每次用例结束把三个提示口还原为默认记录实现。
  // 注意:必须「赋回」而非 delete——delete 会让后续用例读到 undefined,而
  // hotReload 对这些口是 fire-and-forget(带 .catch 吞错),undefined 时直接同步
  // TypeError 逃出 catch 回调,既不落 messages 也不报测试错,造成「状态栏日志有、
  // messages.error 空」的假象(首轮 762/1042 双红即此根因)。
  vscode.window.showInformationMessage = (async (message: string) => {
    messages.info.push(message);
    return undefined;
  }) as typeof vscode.window.showInformationMessage;
  vscode.window.showWarningMessage = (async (message: string) => {
    messages.warning.push(message);
    return undefined;
  }) as typeof vscode.window.showWarningMessage;
  vscode.window.showErrorMessage = (async (message: string) => {
    messages.error.push(message);
    return undefined;
  }) as typeof vscode.window.showErrorMessage;
};

const originalGetConfiguration = stubWorkspace.getConfiguration;

beforeEach(() => {
  configurationOverrides.clear();
  lastFileSystemWatcher.current = null;
  stubWorkspace.getConfiguration = originalGetConfiguration;
  restoreWindow();
});

afterEach(() => {
  configurationOverrides.clear();
  lastFileSystemWatcher.current = null;
  stubWorkspace.getConfiguration = originalGetConfiguration;
  restoreWindow();
});

describe('hotReload 缺口臂:默认热更与元信息面', () => {
  it('默认热更传输拒绝 → 443 如实报 failed(引擎没起 ECONNREFUSED 口径)', async () => {
    enableHotReload({ actionName: '' });
    const clock = makeTimers();
    const probe = makeStatusProbe();
    setupHotReload(makeContext(), () => undefined, {
      timers: clock.timers,
      status: probe.status,
      defaultHotfix: { transport: () => Promise.reject(new Error('ECONNREFUSED')) }
    });
    fireFiles(['/ws/scripts/base/Account.py']);
    clock.tick();
    await flushMicrotasks();
    expect(probe.calls.some(([name, detail]) => name === 'failed' && String(detail).includes('ECONNREFUSED'))).toBe(true);
  });

  it('文件元信息解析成功 → 463 审计行后补一行元信息', async () => {
    enableHotReload();
    const clock = makeTimers();
    const store = new HotReloadTargetStateStore({ now: () => 111 });
    const probe = makeStatusProbe();
    setupHotReload(makeContext(), () => Promise.resolve(true), {
      timers: clock.timers,
      status: probe.status,
      targetState: {
        store,
        resolveTargetId: () => 'http://127.0.0.1:21345/reload',
        resolveRootId: file => (file.startsWith('/wsA/') ? '/wsA' : null)
      },
      fileChangeMeta: {
        metaFor: async () => ({
          fsPath: '/wsA/scripts/base/Account.py',
          identity: '/wsA/scripts/base/Account.py',
          kind: 'change' as const,
          fileName: 'Account.py',
          ext: '.py',
          processSource: 'path' as const
        }),
        metaForPath: async () => ({
          fsPath: '/wsA/scripts/base/Account.py',
          identity: '/wsA/scripts/base/Account.py',
          kind: 'change' as const,
          fileName: 'Account.py',
          ext: '.py',
          processSource: 'path' as const
        })
      }
    });
    fireFiles(['/wsA/scripts/base/Account.py']);
    clock.tick();
    await flushMicrotasks();
    expect(probe.calls.some(([name, text]) => name === 'log' && String(text).includes('文件元信息:'))).toBe(true);
  });
});

describe('hotReload 缺口臂:applied 核验与通道发送', () => {
  it('applied 核验窗口到点但代际已前进 → 537 早退不动结算', async () => {
    enableHotReload();
    const clock = makeTimers();
    const store = new HotReloadTargetStateStore({ now: () => 111 });
    setupHotReload(makeContext(), (_name, sendOptions) => {
      sendOptions?.onHttpResponse?.({ status: 200, body: 'abc' });
    }, {
      timers: clock.timers,
      targetState: {
        store,
        resolveTargetId: () => 'http://127.0.0.1:21345/reload',
        resolveRootId: () => '/wsA',
        readFileContent: async () => 'content'
      }
    });
    fireFiles(['/wsA/scripts/base/Account.py']);
    clock.tick();
    await flushMicrotasks();
    // 结算窗口定时器已排;结算前再发一次(新代际)→ 结算回调看 attempt 不匹配
    store.record({ rootId: '/wsA', targetId: 'http://127.0.0.1:21345/reload' }, '/wsA/scripts/base/Account.py', 'failed', {});
    expect(clock.tick()).toBeGreaterThan(0);
    expect(store.get({ rootId: '/wsA', targetId: 'http://127.0.0.1:21345/reload' }, '/wsA/scripts/base/Account.py')?.outcome).toBe('failed');
  });

  it('部署通道发送整批异常(目标根解析抛错)→ 595-596 如实报 failed + onActionError', async () => {
    enableHotReload();
    const clock = makeTimers();
    const store = new HotReloadTargetStateStore({ now: () => 111 });
    const errors: unknown[] = [];
    setupHotReload(makeContext(), () => undefined, {
      timers: clock.timers,
      onActionError: error => errors.push(error),
      resolveChannelTransport: () => ({
        transport: {
          kind: 'http',
          probe: async () => ({ ok: true, detail: '' }),
          send: async () => ({ kind: 'http' as const, receipts: [] })
        },
        targetId: 't1'
      }),
      targetState: {
        store,
        resolveTargetId: () => 't1',
        resolveRootId: () => { throw new Error('root resolve boom'); }
      }
    });
    fireFiles(['/ws/scripts/base/Account.py']);
    clock.tick();
    await flushMicrotasks();
    expect(errors.length).toBeGreaterThan(0);
    expect(String((errors[0] as Error).message)).toContain('root resolve boom');
  });
});

describe('hotReload 缺口臂:目标解析与发送基准读取', () => {
  it('发送时点内容基准读取失败 → 631 吞掉,digest 无基准不炸发送', async () => {
    enableHotReload();
    const clock = makeTimers();
    const store = new HotReloadTargetStateStore({ now: () => 111 });
    const errors: unknown[] = [];
    setupHotReload(makeContext(), () => Promise.resolve(true), {
      timers: clock.timers,
      onActionError: error => errors.push(error),
      targetState: {
        store,
        resolveTargetId: () => 'http://127.0.0.1:21345/reload',
        resolveRootId: file => (file.startsWith('/wsA/') ? '/wsA' : null),
        readFileContent: async () => { throw new Error('read boom'); }
      }
    });
    fireFiles(['/wsA/scripts/base/Account.py']);
    clock.tick();
    await flushMicrotasks();
    expect(errors).toHaveLength(0);
    expect(store.get({ rootId: '/wsA', targetId: 'http://127.0.0.1:21345/reload' }, '/wsA/scripts/base/Account.py')?.outcome).toBe('sent-unverified');
  });

  it('目标解析失败 → 749 回落 start(null) 无目标发送,不抛', async () => {
    enableHotReload();
    const clock = makeTimers();
    const store = new HotReloadTargetStateStore({ now: () => 111 });
    const errors: unknown[] = [];
    let ranAction = false;
    setupHotReload(makeContext(), () => { ranAction = true; return Promise.resolve(true); }, {
      timers: clock.timers,
      onActionError: error => errors.push(error),
      targetState: {
        store,
        resolveTargetId: () => Promise.reject(new Error('target resolve boom')),
        resolveRootId: file => (file.startsWith('/wsA/') ? '/wsA' : null)
      }
    });
    fireFiles(['/wsA/scripts/base/Account.py']);
    clock.tick();
    await flushMicrotasks();
    expect(ranAction).toBe(true);
    expect(errors).toHaveLength(0);
  });
});

describe('hotReload 缺口臂:def 闸与旁路面', () => {
  it('def 结构闸拦下(无读取通道保守拦)→ 762 需重启提示(showWarningMessage)', async () => {
    enableHotReload();
    const clock = makeTimers();
    const warningBefore = messages.warning.length;
    setupHotReload(makeContext(), () => undefined, {
      timers: clock.timers,
      // 无 readFileContent 目标态 → def 闸无基线,结构性 def 保守拦下
      targetState: {
        store: new HotReloadTargetStateStore({ now: () => 111 }),
        resolveTargetId: () => 't1',
        resolveRootId: () => '/wsA'
      }
    });
    fireFiles(['/wsA/scripts/base/Avatar.def']);
    clock.tick();
    await flushMicrotasks();
    expect(messages.warning.length).toBeGreaterThan(warningBefore);
  });

  it('def 闸放行但 commit 前滚失败 → 795 吞掉不阻塞发送', async () => {
    enableHotReload();
    const clock = makeTimers();
    const probe = makeStatusProbe();
    const errors: unknown[] = [];
    setupHotReload(makeContext(), () => Promise.resolve(true), {
      timers: clock.timers,
      status: probe.status,
      onActionError: error => errors.push(error),
      targetState: {
        store: new HotReloadTargetStateStore({ now: () => 111 }),
        resolveTargetId: () => 't1',
        resolveRootId: () => '/wsA'
      },
      defGate: {
        check: async () => ({ reasons: [], token: { commit: 'x' } }),
        commit: async () => { throw new Error('commit boom'); }
      }
    });
    fireFiles(['/wsA/scripts/base/Avatar.def']);
    clock.tick();
    await flushMicrotasks();
    // 前滚失败不阻塞放行:动作照常执行,无 onActionError
    expect(errors).toHaveLength(0);
  });

  it('旁路事件构建落空(目录非常规文件)→ 822 早退不投递', async () => {
    // 派生场景单 watcher:非 py 走旁路;目录 stat 非 isFile → buildNonPythonChangeEvent 返 null
    const dir = `${process.cwd()}/tests`; // 真实存在的目录
    configurationOverrides.set('kbengine', { assetsRoot: dir });
    const clock = makeTimers();
    const probe = makeStatusProbe();
    setupHotReload(makeContext(), () => undefined, {
      timers: clock.timers,
      status: probe.status
    });
    // 目录事件进旁路 → buildNonPythonChangeEvent 判定非文件 → 早退
    fireFiles([dir]);
    await flushMicrotasks();
    expect(probe.calls.some(([name, text]) => name === 'log' && String(text).includes('非 py 变化待路由'))).toBe(false);
  });
});

describe('hotReload 缺口臂:根解析与首激活提示', () => {
  it('首工作区根读取异常 → 843 回落空根,不炸装配', () => {
    enableHotReload();
    const clock = makeTimers();
    const probe = makeStatusProbe();
    Object.defineProperty(stubWorkspace, 'workspaceFolders', {
      get: () => { throw new Error('folders boom'); },
      configurable: true
    });
    try {
      expect(() => setupHotReload(makeContext(), () => undefined, {
        timers: clock.timers,
        status: probe.status
      })).not.toThrow();
    } finally {
      // 还原为普通数组属性(供后续用例)
      Object.defineProperty(stubWorkspace, 'workspaceFolders', {
        value: [],
        writable: true,
        configurable: true
      });
    }
  });

  it('资产根解析异常(配置含空字节路径)→ 850 回落空串,不回落全扫', () => {
    configurationOverrides.set('kbengine', { assetsRoot: '\0' });
    stubWorkspace.workspaceFolders = [{ uri: vscode.Uri.file('/ws'), name: 'ws', index: 0 }];
    const clock = makeTimers();
    const probe = makeStatusProbe();
    expect(() => setupHotReload(makeContext(), () => undefined, {
      timers: clock.timers,
      status: probe.status
    })).not.toThrow();
  });

  it('首激活提示选「打开日志」→ 1037 showLogWithVersions', async () => {
    const context = {
      subscriptions: [],
      workspaceState: makeMemento()
    } as unknown as vscode.ExtensionContext;
    const clock = makeTimers();
    const probe = makeStatusProbe();
    vscode.window.showInformationMessage = (async () => '打开日志') as typeof vscode.window.showInformationMessage;
    setupHotReload(context, () => undefined, {
      timers: clock.timers,
      status: probe.status,
      defaultHotfix: { transport: () => Promise.resolve({ ok: true, status: 200, durationMs: 1, body: '' }) }
    });
    await flushMicrotasks();
    expect(probe.calls.some(([name]) => name === 'show-log-with-versions')).toBe(true);
  });

  it('首激活提示选「立即关闭」且写回失败 → 1042/1044-1047 如实上报', async () => {
    const context = {
      subscriptions: [],
      workspaceState: makeMemento()
    } as unknown as vscode.ExtensionContext;
    const clock = makeTimers();
    const probe = makeStatusProbe();
    vscode.window.showInformationMessage = (async (_msg, ...items) => items[1]) as typeof vscode.window.showInformationMessage;
    // 上报口本身也拒(async 拒 → 走 1047 的 .catch(() => undefined) 兜底吞掉):
    // 既覆盖 1047,又保持 messages.error 入账(先 push 后拒,推送不丢)
    vscode.window.showErrorMessage = (async (message: string) => {
      messages.error.push(message);
      throw new Error('window closed');
    }) as typeof vscode.window.showErrorMessage;
    // 写回配置失败:update 拒 → writeHotReloadEnabled 抛 → turnOff catch 上报
    stubWorkspace.getConfiguration = ((section?: string, scope?: unknown) => {
      const real = originalGetConfiguration(section, scope);
      return {
        get: real.get.bind(real),
        update: () => Promise.reject(new Error('settings read-only'))
      } as typeof real;
    }) as typeof stubWorkspace.getConfiguration;
    setupHotReload(context, () => undefined, {
      timers: clock.timers,
      status: probe.status,
      defaultHotfix: { transport: () => Promise.resolve({ ok: true, status: 200, durationMs: 1, body: '' }) }
    });
    await flushMicrotasks();
    expect(probe.calls.some(([name, text]) => name === 'log' && String(text).includes('写回配置失败'))).toBe(true);
    expect(messages.error.some(message => message.includes('写回配置失败'))).toBe(true);
  });

  it('首激活提示整体异常(提示 API 抛)→ 1050 兜底不炸激活链', async () => {
    const context = {
      subscriptions: [],
      workspaceState: makeMemento()
    } as unknown as vscode.ExtensionContext;
    const clock = makeTimers();
    vscode.window.showInformationMessage = (async () => { throw new Error('window closed'); }) as typeof vscode.window.showInformationMessage;
    expect(() => setupHotReload(context, () => undefined, {
      timers: clock.timers,
      defaultHotfix: { transport: () => Promise.resolve({ ok: true, status: 200, durationMs: 1, body: '' }) }
    })).not.toThrow();
    await flushMicrotasks();
  });
});
