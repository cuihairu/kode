import { beforeEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { setupHotReload, type HotReloadTimerDeps } from '../src/hotReload';
import { HotReloadTargetStateStore } from '../src/hotReloadTargetState';
import type { ReloadReceipt, ReloadTarget, ReloadTransport } from '../src/hotReloadTransport';
import {
  channels,
  configurationOverrides,
  lastFileSystemWatcher
} from './helpers/vscodeStub';

// IDE-HOT-102 部署通道接线:装配注入了 resolveChannelTransport 时,触发批整
// 批走通道发送(transport.send 逐条回执直喂台账,回执语义 sent/accepted/
// applied/failed 映射对应 outcome),不回落 actionName 通道;审计行带触发源/
// 文件/通道/结果;未配(resolveChannelTransport=null)回落既有 actionName。

const makeTimers = (): { timers: HotReloadTimerDeps; tick: () => number } => {
  const handles = new Map<unknown, () => void>();
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

const flush = async (): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, 0));
  await new Promise(resolve => setTimeout(resolve, 0));
};

const hotReloadLog = (): string[] =>
  channels.find(entry => entry.name === 'KBEngine 热更新')?.lines ?? [];

const makeTransport = (receipts: ReloadReceipt[] = []): {
  transport: ReloadTransport;
  sends: Array<{ target: ReloadTarget; files: string[] }>;
} => {
  const sends: Array<{ target: ReloadTarget; files: string[] }> = [];
  const transport: ReloadTransport = {
    kind: 'http',
    probe: async () => ({ ok: true, detail: 'ok' }),
    send: async (target, fileSet, onReceipt) => {
      sends.push({ target, files: [...fileSet] });
      for (const receipt of receipts) {
        onReceipt(receipt);
      }
      return { kind: 'http', receipts };
    }
  };
  return { transport, sends };
};

describe('setupHotReload 部署通道接线(IDE-HOT-102)', () => {
  beforeEach(() => {
    configurationOverrides.clear();
    lastFileSystemWatcher.current = null;
    channels.length = 0;
  });

  const makeContext = (): vscode.ExtensionContext =>
    ({ subscriptions: [] }) as unknown as vscode.ExtensionContext;

  const enableHotReload = (): void => {
    configurationOverrides.set('kbengine', {
      hotReload: { enabled: true, actionName: '热更', debounceMs: 100 }
    });
  };

  it('配置通道:整批走 transport.send,不回落 actionName,回执 accepted 直喂台账', async () => {
    const clock = makeTimers();
    const store = new HotReloadTargetStateStore({ now: () => 7 });
    const { transport, sends } = makeTransport([
      { status: 'accepted', file: '/ws/a.py', digest: 'abc' }
    ]);
    const runCalls: string[] = [];
    enableHotReload();
    setupHotReload(makeContext(), name => void runCalls.push(name), {
      timers: clock.timers,
      auditSource: 'command',
      resolveChannelTransport: () => ({ transport, targetId: 'profile-1' }),
      targetState: { store, resolveTargetId: () => 't1', resolveRootId: () => '/ws' }
    });

    lastFileSystemWatcher.current!.fireChange({ fsPath: '/ws/a.py' } as never);
    clock.tick();
    await flush();

    expect(runCalls).toEqual([]);
    expect(sends).toHaveLength(1);
    expect(sends[0].target).toEqual({ rootId: '/ws', targetId: 'profile-1' });
    expect(sends[0].files).toEqual(['/ws/a.py']);

    const record = store.get({ rootId: '/ws', targetId: 'profile-1' }, '/ws/a.py');
    expect(record?.outcome).toBe('accepted');
    expect(record?.source).toBe('command');
    expect(record?.channel).toBe('http');

    const audit = hotReloadLog().find(line => line.includes('审计'));
    expect(audit).toBeDefined();
    expect(audit).toContain('触发源=command');
    expect(audit).toContain('文件=1 个');
    expect(audit).toContain('通道=http');
    expect(audit).toContain('结果=');
  });

  it('回执 sent/failed 分别映射 sent-unverified/failed(含 detail)', async () => {
    const clock = makeTimers();
    const store = new HotReloadTargetStateStore({ now: () => 7 });
    const { transport } = makeTransport([
      { status: 'sent', file: '/ws/a.py', detail: '控制台已回显' },
      { status: 'failed', file: '/ws/b.py', reason: 'conn refused' }
    ]);
    enableHotReload();
    setupHotReload(makeContext(), () => true, {
      timers: clock.timers,
      resolveChannelTransport: () => ({ transport, targetId: 'profile-1' }),
      targetState: { store, resolveTargetId: () => 't1', resolveRootId: () => '/ws' }
    });

    lastFileSystemWatcher.current!.fireChange({ fsPath: '/ws/a.py' } as never);
    lastFileSystemWatcher.current!.fireChange({ fsPath: '/ws/b.py' } as never);
    clock.tick();
    await flush();

    const key = { rootId: '/ws', targetId: 'profile-1' };
    expect(store.get(key, '/ws/a.py')).toMatchObject({ outcome: 'sent-unverified', detail: '控制台已回显' });
    expect(store.get(key, '/ws/b.py')).toMatchObject({ outcome: 'failed', detail: 'conn refused' });
    expect(hotReloadLog().some(line => line.includes('部分失败'))).toBe(true);
  });

  it('全部回执失败 → 结果=失败,记录 failed', async () => {
    const clock = makeTimers();
    const store = new HotReloadTargetStateStore({ now: () => 7 });
    const { transport } = makeTransport([{ status: 'failed', file: '/ws/a.py', reason: 'boom' }]);
    enableHotReload();
    setupHotReload(makeContext(), () => true, {
      timers: clock.timers,
      resolveChannelTransport: () => ({ transport, targetId: 'profile-1' }),
      targetState: { store, resolveTargetId: () => 't1', resolveRootId: () => '/ws' }
    });

    lastFileSystemWatcher.current!.fireChange({ fsPath: '/ws/a.py' } as never);
    clock.tick();
    await flush();

    expect(store.get({ rootId: '/ws', targetId: 'profile-1' }, '/ws/a.py')?.outcome).toBe('failed');
    expect(hotReloadLog().some(line => line.includes('结果: 失败') && line.includes('全部失败'))).toBe(true);
    const audit = hotReloadLog().find(line => line.includes('审计'));
    expect(audit).toContain('结果=失败(1)');
  });

  it('按 rootId 分组:两文件两个根 → 两次 send,各带各自 rootId', async () => {
    const clock = makeTimers();
    const store = new HotReloadTargetStateStore({ now: () => 7 });
    const { transport, sends } = makeTransport([{ status: 'sent', file: '/wsA/a.py' }]);
    enableHotReload();
    setupHotReload(makeContext(), () => true, {
      timers: clock.timers,
      resolveChannelTransport: () => ({ transport, targetId: 'profile-1' }),
      targetState: {
        store,
        resolveTargetId: () => 't1',
        resolveRootId: file => (file.startsWith('/wsA') ? '/wsA' : '/wsB')
      }
    });

    lastFileSystemWatcher.current!.fireChange({ fsPath: '/wsA/a.py' } as never);
    lastFileSystemWatcher.current!.fireChange({ fsPath: '/wsB/b.py' } as never);
    clock.tick();
    await flush();

    expect(sends).toHaveLength(2);
    expect(sends.map(entry => entry.target.rootId).sort()).toEqual(['/wsA', '/wsB']);
    expect(store.get({ rootId: '/wsA', targetId: 'profile-1' }, '/wsA/a.py')).toMatchObject({
      outcome: 'sent-unverified'
    });
  });

  it('send 单组抛错:整组按 failed 落账,如实上报', async () => {
    const clock = makeTimers();
    const store = new HotReloadTargetStateStore({ now: () => 7 });
    const transport: ReloadTransport = {
      kind: 'http',
      probe: async () => ({ ok: true, detail: 'ok' }),
      send: async () => {
        throw new Error('transport boom');
      }
    };
    const errors: unknown[] = [];
    enableHotReload();
    setupHotReload(makeContext(), () => true, {
      timers: clock.timers,
      onActionError: error => errors.push(error),
      resolveChannelTransport: () => ({ transport, targetId: 'profile-1' }),
      targetState: { store, resolveTargetId: () => 't1', resolveRootId: () => '/ws' }
    });

    lastFileSystemWatcher.current!.fireChange({ fsPath: '/ws/a.py' } as never);
    clock.tick();
    await flush();
    await flush();

    expect(store.get({ rootId: '/ws', targetId: 'profile-1' }, '/ws/a.py')).toMatchObject({
      outcome: 'failed',
      detail: 'transport boom'
    });
    // 组内错误落账 failed + 汇总上报一次(失败即报,与动作名回落面同口径)
    expect(errors.map(error => (error as Error).message)).toContain('通道 http 发送失败:1 个文件未送达');
    expect(hotReloadLog().some(line => line.includes('结果: 失败') && line.includes('全部失败'))).toBe(true);
  });

  it('resolveChannelTransport 未配(null)→ 回落既有 actionName 通道', async () => {
    const clock = makeTimers();
    const runCalls: string[] = [];
    enableHotReload();
    setupHotReload(makeContext(), name => void runCalls.push(name), {
      timers: clock.timers,
      resolveChannelTransport: () => null,
      targetState: {
        store: new HotReloadTargetStateStore({ now: () => 1 }),
        resolveTargetId: () => 't1',
        resolveRootId: () => '/ws'
      }
    });

    lastFileSystemWatcher.current!.fireChange({ fsPath: '/ws/a.py' } as never);
    clock.tick();
    await flush();

    expect(runCalls).toEqual(['热更']);
    const audit = hotReloadLog().find(line => line.includes('审计'));
    expect(audit).toContain('通道=actionName:热更');
  });
});
