import { describe, expect, it } from 'vitest';
import { createHttpTargetQueue } from '../src/backend/httpRequestQueue';

// HR-HTTP-007(RUST-349)按目标有界并发队列纯逻辑:同目标默认串行(FIFO)、
// 不同目标独立并发、全局在途上限、任务拒绝如实透传且队列不停摆。
// 执行器接线面(executeHttpRequest 走队列)见 httpRequestExecutor.test.ts。

/** 手动闸门:open() 前 await gate 的任务挂起 */
const makeGate = (): { gate: Promise<void>; open: () => void } => {
  let open: () => void = () => undefined;
  const gate = new Promise<void>(resolve => {
    open = resolve;
  });
  return { gate, open };
};

/** 微任务排空(起跑/结算都在微任务边界,多拍数轮确保确定性) */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
};

describe('HttpTargetQueue(同目标串行/异目标独立/全局上限)', () => {
  it('同目标默认串行:前一任务未结算,后入队任务不起跑', async () => {
    const queue = createHttpTargetQueue();
    const first = makeGate();
    const order: string[] = [];
    const p1 = queue.run('t1', async () => {
      order.push('first-start');
      await first.gate;
      order.push('first-end');
    });
    const p2 = queue.run('t1', async () => {
      order.push('second-start');
    });
    await flush();
    expect(order).toEqual(['first-start']);
    first.open();
    await Promise.all([p1, p2]);
    expect(order).toEqual(['first-start', 'first-end', 'second-start']);
  });

  it('不同目标独立并发:后目标不等先目标结算', async () => {
    const queue = createHttpTargetQueue();
    const first = makeGate();
    const order: string[] = [];
    const p1 = queue.run('t1', async () => {
      order.push('a');
      await first.gate;
    });
    const p2 = queue.run('t2', async () => {
      order.push('b');
    });
    await flush();
    await p2; // 异目标不等 t1,已起跑并完成
    expect(order).toEqual(['a', 'b']);
    first.open();
    await p1;
  });

  it('全局在途上限:两槽占满后第三任务(即使异目标)排队,槽释放即起跑', async () => {
    const queue = createHttpTargetQueue({ globalConcurrency: 2 });
    const g1 = makeGate();
    const g2 = makeGate();
    let thirdStarted = false;
    const p1 = queue.run('t1', () => g1.gate);
    const p2 = queue.run('t2', () => g2.gate);
    const p3 = queue.run('t3', async () => {
      thirdStarted = true;
    });
    await flush();
    expect(thirdStarted).toBe(false);
    g1.open();
    await p1;
    await flush();
    expect(thirdStarted).toBe(true);
    g2.open();
    await p2;
    await p3;
  });

  it('任务拒绝如实透传给调用方,队列照常推进后续任务', async () => {
    const queue = createHttpTargetQueue();
    const g = makeGate();
    const boom = queue.run('t1', async () => {
      await g.gate;
      throw new Error('boom');
    });
    const after = queue.run('t1', async () => 'ok-after-reject');
    g.open();
    await expect(boom).rejects.toThrow('boom');
    await expect(after).resolves.toBe('ok-after-reject');
  });

  it('同目标并发上限可配:perTarget=2 允许同目标两任务并行,第三个仍排队', async () => {
    const queue = createHttpTargetQueue({ perTargetConcurrency: 2, globalConcurrency: 4 });
    const g1 = makeGate();
    const g2 = makeGate();
    let thirdStarted = false;
    const p1 = queue.run('t1', () => g1.gate);
    const p2 = queue.run('t1', () => g2.gate);
    const p3 = queue.run('t1', async () => {
      thirdStarted = true;
    });
    await flush();
    expect(thirdStarted).toBe(false);
    g1.open();
    g2.open();
    await Promise.all([p1, p2]);
    await flush();
    expect(thirdStarted).toBe(true);
    await p3;
  });

  it('非正整数上限回落默认:perTarget=0 与未配同形(串行)', async () => {
    const queue = createHttpTargetQueue({ perTargetConcurrency: 0, globalConcurrency: 0 });
    const first = makeGate();
    const order: string[] = [];
    const p1 = queue.run('t1', async () => {
      await first.gate;
      order.push('first');
    });
    const p2 = queue.run('t1', async () => {
      order.push('second');
    });
    await flush();
    expect(order).toEqual([]);
    first.open();
    await Promise.all([p1, p2]);
    expect(order).toEqual(['first', 'second']);
  });
});
