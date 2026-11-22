import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { setupHotReload, type HotReloadTimerDeps } from '../src/hotReload';
import { HotReloadTargetStateStore } from '../src/backend/hotReloadTargetState';
import type { ReloadReceipt, ReloadTarget, ReloadTransport } from '../src/backend/hotReloadTransport';
import { allFileSystemWatchers, configurationOverrides, workspaceEvents } from './helpers/vscodeStub';

// HR-WATCH-014 停用时在途请求策略(装配面):策略=自然完成(收编残差不建 abort
// 抽象)——停用清理待提交队列并停受理(纯核面已钉 hotReloadSavePipeline.test.ts:536),
// 但已发出的在途请求不打断:transport 结算照常回执落台账(台账=UI 数据面),
// 不因停用丢回执;停用后不再入队(watcher 已断,同文件再变动不产生新发送)。
// 各面钉一条:①停用后在途请求回执仍落台账(不丢)②停用后不再产生新发送
// ③旧代回执不冒当前由代际结算(hotReloadChannelSend.ts:177)保证,本面不重复钉。

const makeTimers = (): { timers: HotReloadTimerDeps; tick: () => number } => {
  const handles = new Map<unknown, () => void>();
  let nextHandle = 0;
  return {
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

const flush = async (): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, 0));
  await new Promise(resolve => setTimeout(resolve, 0));
};

describe('setupHotReload 停用时在途请求自然完成(HR-WATCH-014 装配面)', () => {
  let workspaceFoldersBackup: typeof vscode.workspace.workspaceFolders;
  let contexts: vscode.ExtensionContext[] = [];

  beforeEach(() => {
    configurationOverrides.clear();
    allFileSystemWatchers.length = 0;
    workspaceFoldersBackup = vscode.workspace.workspaceFolders;
    vscode.workspace.workspaceFolders = [{ uri: { fsPath: '/ws' } as never, name: 'ws', index: 0 }];
  });

  afterEach(() => {
    for (const context of contexts) {
      for (const subscription of [...context.subscriptions].reverse()) {
        try {
          subscription.dispose();
        } catch {
          // 释放失败不掩盖用例本身的断言
        }
      }
    }
    contexts = [];
    vscode.workspace.workspaceFolders = workspaceFoldersBackup;
    configurationOverrides.clear();
    allFileSystemWatchers.length = 0;
  });

  const makeContext = (): vscode.ExtensionContext =>
    ({ subscriptions: [] }) as unknown as vscode.ExtensionContext;

  const boot = (options: {
    transport: ReloadTransport;
    store: HotReloadTargetStateStore;
  }): {
    clock: ReturnType<typeof makeTimers>;
    fireChange: (fsPath: string) => void;
    dispose: () => void;
  } => {
    configurationOverrides.set('kbengine', {
      hotReload: {
        enabled: true,
        globs: ['**/*.py'],
        actionName: '热更',
        debounceMs: 100,
        syntaxGate: true
      }
    });
    const clock = makeTimers();
    const context = makeContext();
    contexts.push(context);
    setupHotReload(context, () => undefined, {
      timers: clock.timers,
      status: {
        log: () => undefined,
        setWatchOff: () => undefined,
        setReady: () => undefined,
        setSending: () => undefined,
        setSentUnverified: () => undefined,
        setFailed: () => undefined,
        setSkippedNoAction: () => undefined,
        setRestartRequired: () => undefined,
        dispose: () => undefined
      } as never,
      pipelineFaces: {
        readSnapshot: async () => ({ hash: 'hash-a', content: 'a = 1' }),
        syntaxCheck: async () => ({ ok: true })
      },
      resolveChannelTransport: () => ({
        transport: options.transport,
        targetId: 'profile-1'
      }),
      targetState: {
        store: options.store,
        resolveTargetId: () => 'profile-1',
        resolveRootId: () => '/ws'
      }
    });
    const saveWatcher = allFileSystemWatchers[allFileSystemWatchers.length - 1];
    return {
      clock,
      fireChange: (fsPath: string) => saveWatcher.fireChange({ fsPath } as never),
      dispose: () => {
        for (const subscription of [...context.subscriptions].reverse()) {
          subscription.dispose();
        }
      }
    };
  };

  it('停用(装配 dispose)时在途请求不打断:回执仍落台账;停用后不再产生新发送', async () => {
    const releaseSend: Array<() => void> = [];
    let sendCalls = 0;
    const transport: ReloadTransport = {
      kind: 'http',
      probe: async () => ({ ok: true, detail: 'ok' }),
      send: (_target: ReloadTarget, files: readonly string[], onReceipt) =>
        new Promise(resolve => {
          sendCalls += 1;
          releaseSend.push(() => {
            const receipts: ReloadReceipt[] = files.map(
              file => ({ status: 'sent', file, detail: 'ok' }) as ReloadReceipt
            );
            for (const receipt of receipts) {
              onReceipt(receipt);
            }
            resolve({ kind: 'http', receipts });
          });
        })
    };
    const store = new HotReloadTargetStateStore({ now: () => 7 });
    const { clock, fireChange, dispose } = boot({ transport, store });
    fireChange('/ws/A.py');
    expect(clock.tick()).toBe(2); // 定稿(异步起)+ 合并窗(空转)
    await flush(); // 定稿落地 → emit → 补排合并窗
    expect(clock.tick()).toBe(1); // 补排窗 → fire#1
    await flush();
    expect(sendCalls).toBe(1); // 在途:send 已发起未结算,回执未落地

    // 停用(装配 dispose):待提交队列清+停受理;在途请求不打断
    dispose();

    // 在途请求自然完成:回执仍落台账(UI 数据面),不因停用丢回执
    releaseSend[0]();
    await flush();
    const record = store.get({ rootId: '/ws', targetId: 'profile-1' }, '/ws/A.py');
    expect(record?.outcome).toBe('sent-unverified');
    expect(record?.detail).toContain('ok');

    // 停用后不再入队:同文件再变动不产生新发送(watcher 已断;send 结算后的
    // 定时器排空属正常收尾,与受理面无关——受理面断言=sendCalls 不增)
    fireChange('/ws/A.py');
    for (let drain = 0; drain < 10 && clock.tick() > 0; drain += 1) {
      await flush();
    }
    await flush();
    expect(sendCalls).toBe(1);
    expect(releaseSend).toHaveLength(1);
  });

  it('停用=配置关(§11.4 apply 重建)时在途请求仍自然完成;停用后不再产生新发送', async () => {
    const releaseSend: Array<() => void> = [];
    let sendCalls = 0;
    const transport: ReloadTransport = {
      kind: 'http',
      probe: async () => ({ ok: true, detail: 'ok' }),
      send: (_target: ReloadTarget, files: readonly string[], onReceipt) =>
        new Promise(resolve => {
          sendCalls += 1;
          releaseSend.push(() => {
            const receipts: ReloadReceipt[] = files.map(
              file => ({ status: 'sent', file, detail: 'ok' }) as ReloadReceipt
            );
            for (const receipt of receipts) {
              onReceipt(receipt);
            }
            resolve({ kind: 'http', receipts });
          });
        })
    };
    const store = new HotReloadTargetStateStore({ now: () => 7 });
    const { clock, fireChange } = boot({ transport, store });
    fireChange('/ws/A.py');
    expect(clock.tick()).toBe(2);
    await flush();
    expect(clock.tick()).toBe(1);
    await flush();
    expect(sendCalls).toBe(1); // 在途:send 已发起未结算

    // 停用=配置关:装配按 §11.4 重建流水线(清待提交队列+停受理)
    configurationOverrides.set('kbengine', {
      hotReload: { enabled: false, globs: ['**/*.py'], actionName: '热更' }
    });
    workspaceEvents.configurationChanged.fire({ affectsConfiguration: s => s === 'kbengine' });

    // 在途请求自然完成:回执仍落台账,不因停用丢回执
    releaseSend[0]();
    await flush();
    const record = store.get({ rootId: '/ws', targetId: 'profile-1' }, '/ws/A.py');
    expect(record?.outcome).toBe('sent-unverified');

    // 停用后不再入队:同文件再变动不产生新发送(watcher 已断)
    fireChange('/ws/A.py');
    for (let drain = 0; drain < 10 && clock.tick() > 0; drain += 1) {
      await flush();
    }
    await flush();
    expect(sendCalls).toBe(1);
    expect(releaseSend).toHaveLength(1);
  });
});
