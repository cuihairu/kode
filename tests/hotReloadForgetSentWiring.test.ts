import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { setupHotReload, type HotReloadTimerDeps } from '../src/hotReload';
import { HotReloadTargetStateStore } from '../src/backend/hotReloadTargetState';
import type { ReloadReceipt, ReloadTarget, ReloadTransport } from '../src/backend/hotReloadTransport';
import { allFileSystemWatchers, configurationOverrides } from './helpers/vscodeStub';

// HR-WATCH-008 投递失败撤回指纹(执行点接线):指纹在批次交发送面那一刻记
// (核面 markSent),投递如实失败后装配撤回(forgotSent),同内容变更照发,
// 不因一次失败永久跳过;成功代际不撤,同内容去重仍然有效。三个面各钉一条:
// 默认热更失败整批撤/通道逐文件精确撤(失败文件重发,已送达文件仍去重)/
// 成功不撤。语法闸开(内容面接通)才有真 hash 进指纹,替身经 pipelineFaces。

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

describe('setupHotReload 投递失败撤回指纹(HR-WATCH-008)', () => {
  let workspaceFoldersBackup: typeof vscode.workspace.workspaceFolders;
  let contexts: vscode.ExtensionContext[] = [];
  const statusCalls: string[] = [];

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
    transport?: (url: string) => Promise<{ ok: boolean; status: number; durationMs: number; body: string }>;
    channelTransport?: ReloadTransport;
    store?: HotReloadTargetStateStore;
  } = {}): { clock: ReturnType<typeof makeTimers>; fireChange: (fsPath: string) => void } => {
    configurationOverrides.set('kbengine', {
      hotReload: {
        enabled: true,
        globs: ['**/*.py'],
        actionName: options.channelTransport ? '热更' : '',
        debounceMs: 100,
        syntaxGate: true
      }
    });
    statusCalls.length = 0;
    const clock = makeTimers();
    const context = makeContext();
    contexts.push(context);
    setupHotReload(context, () => undefined, {
      timers: clock.timers,
      status: {
        log: (text: string) => void statusCalls.push(text),
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
        readSnapshot: async (file: string) =>
          file.endsWith('B.py') ? { hash: 'hash-b', content: 'b = 2' } : { hash: 'hash-a', content: 'a = 1' },
        syntaxCheck: async () => ({ ok: true })
      },
      ...(options.transport
        ? {
            defaultHotfix: {
              transport: request => options.transport!(request.url)
            }
          }
        : {}),
      ...(options.channelTransport
        ? {
            resolveChannelTransport: () => ({
              transport: options.channelTransport!,
              targetId: 'profile-1'
            }),
            targetState: {
              store:
                options.store ??
                new HotReloadTargetStateStore({
                  now: () => 7
                }),
              resolveTargetId: () => 't1',
              resolveRootId: () => '/ws'
            }
          }
        : {})
    });
    const saveWatcher = allFileSystemWatchers[allFileSystemWatchers.length - 1];
    return {
      clock,
      fireChange: (fsPath: string) => saveWatcher.fireChange({ fsPath } as never)
    };
  };

  it('默认热更投递失败 → 撤回指纹,同内容再定稿照发(不永久跳过)', async () => {
    const urls: string[] = [];
    const { clock, fireChange } = boot({
      transport: url => {
        urls.push(url);
        return Promise.resolve({ ok: false, status: 500, durationMs: 1, body: 'boom' });
      }
    });
    // 有读面时定稿是异步的:tick(2)=定稿起+合并窗空转,flush 后 emit 补排
    // 合并窗,tick(1) 才真正 fire
    fireChange('/ws/scripts/A.py');
    expect(clock.tick()).toBe(2); // 定稿(异步起)+ 合并窗(空转)
    await flush(); // 定稿落地 → emit → 补排合并窗
    expect(clock.tick()).toBe(1); // 补排窗 → fire#1
    await flush();
    expect(urls).toHaveLength(1);
    fireChange('/ws/scripts/A.py'); // 同内容(同 hash)再定稿
    expect(clock.tick()).toBe(2);
    await flush();
    expect(clock.tick()).toBe(1);
    await flush();
    expect(urls).toHaveLength(2); // 失败已撤指纹 → 同内容照发
  });

  it('投递成功不撤指纹:同内容再定稿仍去重,不重发', async () => {
    const urls: string[] = [];
    const { clock, fireChange } = boot({
      transport: url => {
        urls.push(url);
        return Promise.resolve({ ok: true, status: 200, durationMs: 1, body: 'ok' });
      }
    });
    fireChange('/ws/scripts/A.py');
    expect(clock.tick()).toBe(2);
    await flush();
    expect(clock.tick()).toBe(1);
    await flush();
    expect(urls).toHaveLength(1);
    fireChange('/ws/scripts/A.py');
    expect(clock.tick()).toBe(2);
    await flush();
    expect(clock.tick()).toBe(0); // 去重 → 不 emit → 无补排窗
    await flush();
    expect(urls).toHaveLength(1); // 同内容同目标,去重仍有效
  });

  it('通道面逐文件精确撤回:失败文件重发,已送达文件仍去重', async () => {
    const sendCalls: string[][] = [];
    const transport: ReloadTransport = {
      kind: 'http',
      probe: async () => ({ ok: true, detail: 'ok' }),
      send: async (_target: ReloadTarget, files: readonly string[], onReceipt) => {
        const list = [...files];
        sendCalls.push(list);
        const receipts: ReloadReceipt[] = list.map(file => ({
          status: file.endsWith('B.py') ? 'sent' : 'failed',
          file,
          ...(file.endsWith('B.py') ? { detail: 'ok' } : { reason: 'boom' })
        }) as ReloadReceipt);
        for (const receipt of receipts) {
          onReceipt(receipt);
        }
        return { kind: 'http', receipts };
      }
    };
    const store = new HotReloadTargetStateStore({ now: () => 7 });
    const { clock, fireChange } = boot({ channelTransport: transport, store });
    fireChange('/ws/A.py');
    fireChange('/ws/B.py');
    clock.tick();
    await flush();
    clock.tick(); // 补排合并窗 → fire#1
    await flush();
    expect(sendCalls).toHaveLength(1);
    expect([...sendCalls[0]].sort()).toEqual(['/ws/A.py', '/ws/B.py']);
    fireChange('/ws/A.py'); // 同内容再定稿:A 上次失败,B 上次已送达
    fireChange('/ws/B.py');
    clock.tick();
    await flush();
    clock.tick();
    await flush();
    expect(sendCalls).toHaveLength(2);
    expect(sendCalls[1]).toEqual(['/ws/A.py']); // 只有失败文件重发,B 去重
  });
});
