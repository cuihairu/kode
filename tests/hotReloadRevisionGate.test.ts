import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { setupHotReload, type HotReloadTimerDeps } from '../src/hotReload';
import { HotReloadTargetStateStore } from '../src/backend/hotReloadTargetState';
import type { ReloadReceipt, ReloadTarget, ReloadTransport } from '../src/backend/hotReloadTransport';
import { allFileSystemWatchers, configurationOverrides } from './helpers/vscodeStub';

// HR-WATCH-011 响应面(执行点接线):发送时点版本快照——响应落地时该文件
// 已又定稿新版本(isStaleResponse 真)则如实注解/上日志,旧响应绝不作为
// 新版本的成功依据;「末版本必被请求」由链路保证(再定稿必再进合并窗再
// fire),两件事都钉在本文件。真实现经 defaultHotfix.transport /
// resolveChannelTransport 替身顶替,只钉装配语义。

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

describe('setupHotReload revision 消费面(HR-WATCH-011 响应面)', () => {
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
    transportUrls?: string[];
    channelTransport?: ReloadTransport;
    store?: HotReloadTargetStateStore;
  } = {}): { clock: ReturnType<typeof makeTimers>; fireChange: (fsPath: string) => void } => {
    configurationOverrides.set('kbengine', {
      hotReload: {
        enabled: true,
        globs: ['**/*.py'],
        actionName: options.channelTransport ? '热更' : '',
        debounceMs: 100
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
      ...(options.transportUrls
        ? {
            defaultHotfix: {
              transport: request => {
                options.transportUrls?.push(request.url);
                return Promise.resolve({ ok: true, status: 200, durationMs: 1, body: 'ok' });
              }
            }
          }
        : {}),
      ...(options.channelTransport
        ? {
            resolveChannelTransport: () => ({
              transport: options.channelTransport,
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

  it('末版本必被请求:发送在途时文件再定稿 → 再进合并窗再 fire(HR-WATCH-011 前半)', async () => {
    const transportUrls: string[] = [];
    const { clock, fireChange } = boot({ transportUrls });
    fireChange('/ws/scripts/A.py');
    expect(clock.tick()).toBe(2); // 定稿 rev1 + 合并窗 → fire#1
    fireChange('/ws/scripts/A.py');
    expect(clock.tick()).toBe(2); // 再定稿 rev2 + 合并窗 → fire#2
    await flush();
    expect(transportUrls).toHaveLength(2); // 末版本确实又被请求
  });

  it('旧响应不冒充新版本成功:响应落地时已再定稿 → 上「响应过期」日志,新响应不注(HR-WATCH-011 后半)', async () => {
    const transportUrls: string[] = [];
    const { clock, fireChange } = boot({ transportUrls });
    fireChange('/ws/scripts/A.py');
    expect(clock.tick()).toBe(2); // fire#1(rev1 在途)
    fireChange('/ws/scripts/A.py');
    expect(clock.tick()).toBe(2); // fire#2(rev2)——响应#1 尚未落地
    await flush(); // 两个响应落地:#1 相对 rev2 已过期
    expect(transportUrls).toHaveLength(2);
    const stale = statusCalls.filter(line => line.includes('响应过期'));
    expect(stale).toHaveLength(1); // 只有旧响应注解,新响应如实不注
    expect(stale[0]).toContain('/ws/scripts/A.py');
    expect(stale[0]).toContain('不作为新版本的成功依据');
  });

  it('无再定稿:响应如实落地,不上「响应过期」日志', async () => {
    const transportUrls: string[] = [];
    const { clock, fireChange } = boot({ transportUrls });
    fireChange('/ws/scripts/A.py');
    expect(clock.tick()).toBe(2);
    await flush();
    expect(transportUrls).toHaveLength(1);
    expect(statusCalls.some(line => line.includes('响应过期'))).toBe(false);
  });

  it('通道面:滞代响应上「响应过期」日志;台账最新代不被注解(注解绑定本代,通道面只做日志)', async () => {
    const receipts: ReloadReceipt[] = [
      { status: 'sent', file: '/ws/A.py', detail: 'ok' }
    ];
    const transport: ReloadTransport = {
      kind: 'http',
      probe: async () => ({ ok: true, detail: 'ok' }),
      send: async (_target: ReloadTarget, _files: readonly string[], onReceipt) => {
        for (const receipt of receipts) {
          onReceipt(receipt);
        }
        return { kind: 'http', receipts };
      }
    };
    const store = new HotReloadTargetStateStore({ now: () => 7 });
    const { clock, fireChange } = boot({ channelTransport: transport, store });
    fireChange('/ws/A.py');
    expect(clock.tick()).toBe(2); // fire#1(rev1),回执随 send 同步落账
    fireChange('/ws/A.py');
    expect(clock.tick()).toBe(2); // fire#2(rev2)
    await flush(); // 响应#1 相对 rev2 已过期
    const stale = statusCalls.filter(line => line.includes('响应过期'));
    expect(stale).toHaveLength(1);
    // 台账最新代=rev2 的记录(fresh),不被旧响应的注解污染
    const latest = store.get({ rootId: '/ws', targetId: 'profile-1' }, '/ws/A.py');
    expect(latest?.outcome).toBe('sent-unverified');
    expect(latest?.detail ?? '').not.toContain('响应过期');
  });
});
