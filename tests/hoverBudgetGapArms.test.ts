import { describe, expect, it } from 'vitest';
import {
  clearRecentHoverTimeouts,
  createLinkedCancellationToken,
  createWaiterUnionToken,
  getRecentHoverTimeouts,
  raceWithBudget,
  setHoverBudgetLogHub
} from '../src/hoverBudget';

// hoverBudget.ts 缺口臂(2026-11-09 覆盖率扫尾):raceWithBudget 的取消即弃
// 臂(在飞 work 拒收仍吞掉)、预算窗口 finally 的吞拒收臂、waiter 联合 token
// 的已触发早退/事后订阅即发臂、无 token/已 dispose 登记早退臂、链接 token
// 的取消后订阅即发臂。
//
// 记录的死臂(不以真实 fs/公共 API 强测,附证据):
//   * line 86(`if (token?.isCancellationRequested) { onStop?.(); resolve(null); }`):
//     不可达。该行在 `stopped` promise 执行体内(line 77-87),执行体同步运行;
//     入口 line 66 的 `if (token?.isCancellationRequested)` 已先返回。二者之间
//     无 await/微任务,真实 vscode.CancellationToken 的 isCancellationRequested
//     是稳定只读属性,不会在 line 66→86 之间翻转 → 该防御性重查无触发路径。
//     (仅当替身用带副作用 getter 的 token 才可触发,非真实 token 语义,不测。)
//   * line 169 的 `waiters.size === 0` 子臂(createWaiterUnionToken.reevaluate):
//     不可达。addWaiter 在调用 reevaluate 前先 waiters.set(新增);waiters.size
//     在 reevaluate 时恒 >= 1。零在册只在 dispose 清空后出现,但 dispose 不调用
//     reevaluate。该子臂无触发路径;整行经 `fired` 子臂覆盖。

const cancelableToken = () => {
  let listener: (() => void) | undefined;
  const token = {
    isCancellationRequested: false,
    onCancellationRequested(callback: () => void) {
      listener = callback;
      return { dispose: () => { listener = undefined; } };
    }
  };
  return {
    token: token as never,
    cancel: () => { token.isCancellationRequested = true; listener?.(); }
  };
};

describe('hoverBudget 缺口臂:raceWithBudget 取消即弃与吞拒收', () => {
  it('进入即取消:onStop 触发,在飞 work 拒收被吞掉,如实 null', async () => {
    clearRecentHoverTimeouts();
    setHoverBudgetLogHub(null);
    const token = { isCancellationRequested: true };
    let onStopCalled = false;
    const result = await raceWithBudget(
      'layer',
      Promise.reject(new Error('in-flight boom')),
      100,
      token as never,
      () => { onStopCalled = true; }
    );
    expect(result).toBeNull();
    expect(onStopCalled).toBe(true);
    // 取消路径不记超时(不是预算到期)
    expect(getRecentHoverTimeouts()).toEqual([]);
  });

  it('预算窗口内 work 拒收:race 透传拒绝,finally 吞掉重复拒收', async () => {
    clearRecentHoverTimeouts();
    setHoverBudgetLogHub(null);
    await expect(raceWithBudget('layer', Promise.reject(new Error('boom')), 1000))
      .rejects.toThrow('boom');
  });
});

describe('hoverBudget 缺口臂:waiter 联合 token 已触发面', () => {
  it('全部等待者取消 → 联合触发;事后订阅即发,再登记即早退', () => {
    const union = createWaiterUnionToken();
    const tokA = cancelableToken();
    union.addWaiter(tokA.token);
    tokA.cancel(); // 全部在册已取消 → reevaluate → fired=true
    expect(union.token.isCancellationRequested).toBe(true);

    // 事后订阅:已触发 → 监听器立即调用(不排队);返回的 no-op dispose 可调用
    let notified = false;
    const sub = union.token.onCancellationRequested(() => { notified = true; });
    expect(notified).toBe(true);
    sub.dispose();

    // 已触发后再登记:reevaluate 首行 `if (fired || ...)` 早退
    const tokB = cancelableToken();
    const detachB = union.addWaiter(tokB.token);
    expect(typeof detachB).toBe('function');
    expect(union.token.isCancellationRequested).toBe(true);
    union.dispose();
  });

  it('无等待者 token / 已 dispose → 登记直接返回注销函数(不登记)', () => {
    const union = createWaiterUnionToken();
    const noop = union.addWaiter(undefined);
    expect(typeof noop).toBe('function');
    noop(); // 返回的 no-op 注销函数可调用
    union.dispose();
    const noopAfterDispose = union.addWaiter(cancelableToken().token);
    expect(typeof noopAfterDispose).toBe('function');
    noopAfterDispose();
  });
});

describe('hoverBudget 缺口臂:链接 token 取消后订阅即发', () => {
  it('cancel 后 onCancellationRequested 订阅立即回调', () => {
    const linked = createLinkedCancellationToken(undefined);
    linked.cancel();
    let called = false;
    const sub = linked.token.onCancellationRequested(() => { called = true; });
    expect(called).toBe(true);
    sub.dispose();
    linked.dispose();
  });
});
