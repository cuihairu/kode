import { describe, expect, it } from 'vitest';

import { resendHotReloadTarget } from '../src/backend/hotReloadRetryCommand';
import { HotReloadTargetStateStore } from '../src/backend/hotReloadTargetState';
import type { HotReloadTimerDeps } from '../src/hotReload';
import type { ReloadTarget, ReloadTransport } from '../src/backend/hotReloadTransport';

// 交叉修复(2026-11-05 二轮复审):部署通道的目标是 profile ID,quick action
// 反查(resolveActionNameForTarget)找不到对应动作——旧实现失败重试只反查
// quick action,部署通道发送失败后重试要么找不到动作(重试失效),要么走错
// 发送通道(quick action ≠ 部署通道)。修后:重试目标=当前部署通道目标时接回
// resolveChannelTransport,经同一 transport 发送,回执流/冻结 digest/代际结算
// 与 fire 路径同语义;通道目标不符(或未注入)才回落动作反查路径。

const KEY = { rootId: '/ws', targetId: 'profile-9' };

const makeTimers = (): HotReloadTimerDeps => {
  const handles = new Map<unknown, () => void>();
  return {
    set: (callback): unknown => {
      const handle = handles.size;
      handles.set(handle, callback);
      return handle;
    },
    clear: (handle): void => {
      handles.delete(handle);
    }
  };
};

const makeTransport = (
  onSend: (target: ReloadTarget, files: readonly string[], onReceipt: (r: never) => void) => Promise<unknown>
): ReloadTransport => ({
  kind: 'http',
  probe: async () => ({ ok: true, detail: 'ok' }),
  send: async (target, fileSet, onReceipt) => {
    await onSend(target, fileSet, onReceipt as never);
    return { kind: 'http', receipts: [] };
  }
});

describe('部署通道失败重试接回同一发送通道(交叉修复)', () => {
  it('目标=部署通道目标(profile ID)→ 经 resolveChannelTransport 原通道重发,不走动作反查', async () => {
    const store = new HotReloadTargetStateStore({ now: () => 1_000 });
    store.record(KEY, '/ws/a.py', 'failed', { detail: 'ECONNREFUSED' });
    const sentTargets: string[] = [];
    const transport = makeTransport((target, files, onReceipt) => {
      sentTargets.push(target.targetId);
      onReceipt({ status: 'sent', file: files[0], detail: '通道已送达' });
    });
    let actionLookups = 0;
    let actionCalls = 0;
    const result = await resendHotReloadTarget(store, KEY, {
      runAction: () => {
        actionCalls += 1;
        return true;
      },
      resolveActionNameForTarget: () => {
        actionLookups += 1;
        return null; // profile ID 反查不到 quick action
      },
      // 交叉修复:重试接回部署通道
      resolveChannelTransport: () => ({ transport, targetId: 'profile-9' }),
      timers: makeTimers(),
      settleHandles: new Set<unknown>(),
      targetState: {
        store,
        resolveTargetId: () => null,
        resolveRootId: () => '/ws',
        readFileContent: async () => 'print("x")'
      }
    });
    expect(result.ok).toBe(true);
    // 同一发送通道,且不再依赖动作反查/动作入口
    expect(sentTargets).toEqual(['profile-9']);
    expect(actionLookups).toBe(0);
    expect(actionCalls).toBe(0);
    const record = store.get(KEY, '/ws/a.py');
    expect(record?.outcome).toBe('sent-unverified');
    expect(record?.attempt).toBe(2);
    expect(record?.channel).toBe('http');
    expect(record?.source).toBe('retry');
  });

  it('通道目标不符(目标是 quick action 的)→ 回落动作反查路径,通道不动', async () => {
    const store = new HotReloadTargetStateStore({ now: () => 1_000 });
    const key = { rootId: '/ws', targetId: 'baseapp#1' };
    store.record(key, '/ws/a.py', 'failed', { detail: 'ECONNREFUSED' });
    let channelSends = 0;
    const transport = makeTransport(() => {
      channelSends += 1;
    });
    const result = await resendHotReloadTarget(store, key, {
      runAction: () => true,
      resolveActionNameForTarget: () => '热更',
      resolveChannelTransport: () => ({ transport, targetId: 'profile-9' }),
      timers: makeTimers(),
      settleHandles: new Set<unknown>(),
      targetState: {
        store,
        resolveTargetId: () => 'baseapp#1',
        resolveRootId: () => '/ws'
      }
    });
    expect(result.ok).toBe(true);
    expect(channelSends).toBe(0);
    expect(result.detail).toContain('已重新发送');
  });

  it('通道重发整组失败 → ok=false,台账 failed 绑定本次重发代际', async () => {
    const store = new HotReloadTargetStateStore({ now: () => 1_000 });
    store.record(KEY, '/ws/a.py', 'failed', { detail: '第一次失败' });
    const transport = makeTransport(async () => {
      throw new Error('channel down again');
    });
    const result = await resendHotReloadTarget(store, KEY, {
      runAction: () => true,
      resolveActionNameForTarget: () => null,
      resolveChannelTransport: () => ({ transport, targetId: 'profile-9' }),
      timers: makeTimers(),
      settleHandles: new Set<unknown>(),
      targetState: {
        store,
        resolveTargetId: () => null,
        resolveRootId: () => '/ws'
      }
    });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('部署通道重发失败');
    const record = store.get(KEY, '/ws/a.py');
    expect(record?.outcome).toBe('failed');
    expect(record?.attempt).toBe(2);
    expect(record?.detail).toContain('channel down again');
  });
});
