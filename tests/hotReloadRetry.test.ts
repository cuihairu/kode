import { describe, expect, it, vi } from 'vitest';
import { retryFailedHotReloadTargets } from '../src/hotReloadRetry';
import { summarizeHotReloadBatch } from '../src/hotReloadBatchSummary';
import { HotReloadTargetStateStore, type HotReloadTargetKey } from '../src/hotReloadTargetState';

// IDE-HOT-007 只重试失败目标:重试遍历批次目标,只对 outcome=failed 的
// 目标重新发送;已确认成功侧(applied/accepted/sent-unverified=已发出
// 面成功)不重复发送;每跳发起前探针取消——取消后停止后续发送,已完
// 成的动作保留,未发起的标 skipped 不冒充已发。

const FILE = '/ws/r/assets/scripts/base/Avatar.py';
const KEY_OK: HotReloadTargetKey = { rootId: 'r', targetId: 'cellapp#a' };
const KEY_BAD: HotReloadTargetKey = { rootId: 'r', targetId: 'cellapp#b' };
const KEY_UGLY: HotReloadTargetKey = { rootId: 'r', targetId: 'cellapp#c' };

const batchOf = (seed: (store: HotReloadTargetStateStore) => void) => {
  const store = new HotReloadTargetStateStore({ now: () => 1 });
  seed(store);
  return summarizeHotReloadBatch(store);
};

const send = vi.fn(async (key: HotReloadTargetKey) => ({ ok: key.targetId !== 'cellapp#b', detail: `resend ${key.targetId}` }));

describe('retryFailedHotReloadTargets(只重试失败目标)', () => {
  it('一成一败:只对失败目标重发,成功目标不重复发送', async () => {
    send.mockClear();
    const summary = batchOf(s => {
      s.record(KEY_OK, FILE, 'applied');
      s.record(KEY_BAD, FILE, 'failed', { detail: 'HTTP 500' });
    });

    const actions = await retryFailedHotReloadTargets(summary, { send, isCancelled: () => false });

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(KEY_BAD);
    expect(actions.map(a => [a.keyId, a.action])).toEqual([
      ['r::cellapp#a', 'skipped-confirmed'],
      ['r::cellapp#b', 'resent']
    ]);
  });

  it('sent-unverified/accepted 同样不重发(已发出面,重发会重复投递)', async () => {
    send.mockClear();
    const summary = batchOf(s => {
      s.record(KEY_OK, FILE, 'sent-unverified');
      s.record(KEY_UGLY, FILE, 'accepted');
    });

    const actions = await retryFailedHotReloadTargets(summary, { send, isCancelled: () => false });

    expect(send).not.toHaveBeenCalled();
    expect(actions.every(a => a.action === 'skipped-confirmed')).toBe(true);
  });

  it('全部失败:逐个重发', async () => {
    send.mockClear();
    const summary = batchOf(s => {
      s.record(KEY_BAD, FILE, 'failed');
      s.record(KEY_UGLY, FILE, 'failed');
    });

    const actions = await retryFailedHotReloadTargets(summary, { send, isCancelled: () => false });

    expect(send).toHaveBeenCalledTimes(2);
    expect(actions.every(a => a.action === 'resent')).toBe(true);
  });

  it('开跑前已取消:零发起,全部 skipped-cancelled', async () => {
    send.mockClear();
    const summary = batchOf(s => {
      s.record(KEY_OK, FILE, 'applied');
      s.record(KEY_BAD, FILE, 'failed');
    });

    const actions = await retryFailedHotReloadTargets(summary, { send, isCancelled: () => true });

    expect(send).not.toHaveBeenCalled();
    expect(actions.map(a => a.action)).toEqual(['skipped-confirmed', 'skipped-cancelled']);
  });

  it('首跳重发后取消:已完成保留,后续不再发起', async () => {
    send.mockClear();
    const summary = batchOf(s => {
      s.record(KEY_BAD, FILE, 'failed');
      s.record(KEY_UGLY, FILE, 'failed');
    });
    let calls = 0;
    const isCancelled = () => calls >= 1;
    const sendOnce = vi.fn(async (key: HotReloadTargetKey) => {
      calls += 1;
      return { ok: true, detail: `resend ${key.targetId}` };
    });

    const actions = await retryFailedHotReloadTargets(summary, { send: sendOnce, isCancelled });

    expect(sendOnce).toHaveBeenCalledTimes(1);
    expect(sendOnce).toHaveBeenCalledWith(KEY_BAD);
    expect(actions.map(a => [a.keyId, a.action])).toEqual([
      ['r::cellapp#b', 'resent'],
      ['r::cellapp#c', 'skipped-cancelled']
    ]);
  });

  it('skipped-confirmed 带原状态说明(可查为什么不发)', async () => {
    const summary = batchOf(s => {
      s.record(KEY_OK, FILE, 'applied', { detail: 'digest 一致:已应用' });
    });

    const actions = await retryFailedHotReloadTargets(summary, { send, isCancelled: () => false });

    expect(actions[0]?.action).toBe('skipped-confirmed');
    expect(actions[0]?.detail).toContain('applied');
  });

  it('重发结果 ok/detail 透传进动作(失败如实呈现)', async () => {
    const summary = batchOf(s => {
      s.record(KEY_BAD, FILE, 'failed');
    });

    const actions = await retryFailedHotReloadTargets(summary, { send, isCancelled: () => false });

    expect(actions[0]?.action).toBe('resent');
    expect(actions[0]?.result?.ok).toBe(false);
    expect(actions[0]?.result?.detail).toContain('cellapp#b');
  });

  it('无目标批次 → 空动作列表,零发起', async () => {
    send.mockClear();
    const actions = await retryFailedHotReloadTargets(batchOf(() => undefined), { send, isCancelled: () => false });
    expect(actions).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });

  it('动作顺序跟随批次目标序(keyId 字典序稳定)', async () => {
    const summary = batchOf(s => {
      s.record(KEY_UGLY, FILE, 'failed');
      s.record(KEY_BAD, FILE, 'failed');
      s.record(KEY_OK, FILE, 'failed');
    });
    const actions = await retryFailedHotReloadTargets(summary, { send, isCancelled: () => false });
    expect(actions.map(a => a.keyId)).toEqual(['r::cellapp#a', 'r::cellapp#b', 'r::cellapp#c']);
  });
});
