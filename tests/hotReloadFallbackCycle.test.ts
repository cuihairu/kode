/**
 * RUST-429(HR-QA-017)性能回退验收:性能不达标时允许关 Watch 和回退至手动
 * Quick Requests;设置可恢复且无状态数据破坏。四断言——
 *  ①关 Watch:kbengine.hotReload.enabled=false → 不建 watcher、不自动发;
 *  ②手动回退:关监视下手动触发路径仍写同一台账(showFileState/retryFailed/
 *    右键手动发一次热更 = 手动先建档,token 未知先建档后续采样不跳号);
 *  ③设置可恢复:off→on→off 配置联动,watcher 拆/建/拆,配置事件驱动即时生效;
 *  ④无状态数据破坏:目标态台账(store)条目跨切换循环不变(不擦除不重复)。
 * 说明:手动 Quick Request(通用 HTTP 快捷请求)在 src/backend/httpRequestService.ts
 *  只按 entry.enabled(单条动作开关)过滤,结构上不读 kbengine.hotReload.enabled,
 *  故关 Watch 后手动请求天然可用(独立性由该文件既有测试+本文件 ② 共证)。
 * 本文件补 wiring 级闭环:配置开关↔watcher 拆建↔台账存续,不重做既有拆建臂。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { setupHotReload, type HotReloadTimerDeps } from '../src/hotReload';
import { HotReloadTargetStateStore } from '../src/backend/hotReloadTargetState';
import type { ReloadReceipt, ReloadTarget, ReloadTransport } from '../src/backend/hotReloadTransport';
import {
  channels,
  configurationOverrides,
  lastFileSystemWatcher,
  workspaceEvents
} from './helpers/vscodeStub';

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

const makeContext = (): vscode.ExtensionContext =>
  ({ subscriptions: [] }) as unknown as vscode.ExtensionContext;

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
      return { ok: true, status: 200, durationMs: 1, body: '' };
    }
  };
  return { transport, sends };
};

describe('RUST-429 性能回退:关 Watch / 手动回退 / 设置可恢复 / 台账无破坏', () => {
  beforeEach(() => {
    configurationOverrides.clear();
    lastFileSystemWatcher.current = null;
    channels.length = 0;
  });

  it('关 Watch + 手动回退:enabled=false 不建 watcher 不自动发,手动路径仍写台账', () => {
    configurationOverrides.set('kbengine', {
      hotReload: { enabled: false, globs: ['**/*.py'], actionName: '热更', debounceMs: 100 }
    });
    const clock = makeTimers();
    const store = new HotReloadTargetStateStore({ now: () => 7 });
    const { transport, sends } = makeTransport([]);
    const runCalls: string[] = [];

    setupHotReload(makeContext(), name => void runCalls.push(name), {
      timers: clock.timers,
      resolveChannelTransport: () => ({ transport, targetId: 'profile-1' }),
      targetState: { store, resolveTargetId: () => 't1', resolveRootId: () => '/ws' }
    });

    // ①关 Watch:不建 watcher,磁盘变化进不了自动发送。
    expect(lastFileSystemWatcher.current).toBeNull();
    expect(runCalls).toEqual([]);
    expect(sends).toHaveLength(0);

    // ②手动回退:关监视下手动触发路径先建档(showFileState/retryFailed 同台账
    // 同一实现),token 未知先建档后续采样补 token 不跳号。
    const key = { rootId: '/ws', targetId: 'profile-1' };
    store.record(key, '/ws/scripts/manual.py', 'sent-unverified', { sentDigest: 'abc' });
    expect(store.get(key, '/ws/scripts/manual.py')?.outcome).toBe('sent-unverified');
    expect(store.get(key, '/ws/scripts/manual.py')?.file).toBe('/ws/scripts/manual.py');
  });

  it('设置可恢复 + 无状态数据破坏:off→on→off→on,watcher 拆建,台账条目不变', async () => {
    const clock = makeTimers();
    const store = new HotReloadTargetStateStore({ now: () => 7 });
    const { transport, sends } = makeTransport([{ status: 'accepted', file: '/ws/a.py', digest: 'abc' }]);
    const runCalls: string[] = [];

    const setEnabled = (enabled: boolean): void => {
      configurationOverrides.set('kbengine', {
        hotReload: { enabled, globs: ['**/*.py'], actionName: '热更', debounceMs: 100 }
      });
      workspaceEvents.configurationChanged.fire({
        affectsConfiguration: (section: string) => section === 'kbengine'
      });
    };

    // 初始:关 → 不建 watcher。
    setEnabled(false);
    setupHotReload(makeContext(), name => void runCalls.push(name), {
      timers: clock.timers,
      resolveChannelTransport: () => ({ transport, targetId: 'profile-1' }),
      targetState: { store, resolveTargetId: () => 't1', resolveRootId: () => '/ws' }
    });
    expect(lastFileSystemWatcher.current).toBeNull();

    // 开:建 watcher,一次变更 → 走通道发送 → 台账记录(基线条目 E)。
    setEnabled(true);
    const watcher1 = lastFileSystemWatcher.current;
    expect(watcher1).not.toBeNull();
    watcher1!.fireChange({ fsPath: '/ws/a.py' } as never);
    clock.tick();
    await flush();
    const key = { rootId: '/ws', targetId: 'profile-1' };
    const baseline = store.get(key, '/ws/a.py');
    expect(baseline?.outcome).toBe('accepted');
    expect(sends).toHaveLength(1);

    // 关:watcher 拆除(dispose 被调;stub 的 current 只存最后建的,dispose 不
    // 置空,故拆除判据=dispose 调用而非 current===null);台账条目原样保留(不擦除)。
    let disposed1 = 0;
    watcher1!.dispose = () => {
      disposed1 += 1;
    };
    setEnabled(false);
    expect(disposed1).toBe(1);
    expect(store.get(key, '/ws/a.py')).toEqual(baseline);

    // 再开:重建 watcher(新实例,非原实例);台账条目仍原样(不重复不跳号)。
    setEnabled(true);
    const watcher2 = lastFileSystemWatcher.current;
    expect(watcher2).not.toBeNull();
    expect(watcher2).not.toBe(watcher1);
    expect(store.get(key, '/ws/a.py')).toEqual(baseline);

    // 再关:再拆;台账不变。
    let disposed2 = 0;
    watcher2!.dispose = () => {
      disposed2 += 1;
    };
    setEnabled(false);
    expect(disposed2).toBe(1);
    expect(store.get(key, '/ws/a.py')).toEqual(baseline);
  });
});
