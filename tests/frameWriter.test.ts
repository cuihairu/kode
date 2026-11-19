import { describe, expect, it } from 'vitest';

import { FrameWriter, type FrameWriterHooks } from '../src/backend/frameWriter';

// KODE-RESP-009 纯核验收:drain 感知帧写器——stdin.write 返回 false(管道
// 满/服务端停读)后,下一帧必须等 drain 才写(响应式背压),帧序=入队序
// (FIFO 串行),close/error 放行不悬挂,写口异常吞掉不炸链,在队帧数可
// 观测(缓冲上界口)。

interface FakeHooks {
  hooks: FrameWriterHooks;
  writes: Buffer[];
  listeners: Map<string, Set<() => void>>;
  failWrites: () => void;
  emit: (event: 'drain' | 'close' | 'error') => void;
}

/** firstWriteReturnsFalse=管道写满形态:首写返回 false(触发等 drain),
 * 其后写返回 true(drain 后缓冲已空)——贴近真实 drain 语义。 */
const makeHooks = (firstWriteReturnsFalse = false): FakeHooks => {
  const writes: Buffer[] = [];
  const listeners = new Map<string, Set<() => void>>([
    ['drain', new Set()],
    ['close', new Set()],
    ['error', new Set()]
  ]);
  let pendingFalse = firstWriteReturnsFalse;
  return {
    writes,
    listeners,
    failWrites: () => {
      pendingFalse = true;
    },
    emit: event => {
      const set = listeners.get(event)!;
      for (const listener of [...set]) {
        set.delete(listener); // once 语义
        listener();
      }
    },
    hooks: {
      write: frame => {
        writes.push(frame);
        if (pendingFalse) {
          pendingFalse = false;
          return false;
        }
        return true;
      },
      once: (event, listener) => {
        listeners.get(event)!.add(listener);
      },
      off: (event, listener) => {
        listeners.get(event)!.delete(listener);
      }
    }
  };
};

const flushMicrotasks = async (): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, 0));
  await new Promise(resolve => setTimeout(resolve, 0));
};

const frame = (label: string): Buffer => Buffer.from(label, 'utf8');

describe('FrameWriter:drain 感知帧写器(RESP-009)', () => {
  it('管道畅通(write 恒 true):帧按入队序串行写完,drained() 即完成', async () => {
    const fake = makeHooks();
    const writer = new FrameWriter(fake.hooks);
    writer.send(frame('f1'));
    writer.send(frame('f2'));
    writer.send(frame('f3'));
    await writer.drained();
    expect(fake.writes.map(b => b.toString())).toEqual(['f1', 'f2', 'f3']);
    expect(writer.pendingFrames).toBe(0);
  });

  it('写返回 false 后:下一帧不写,等 drain 才写(响应式背压)', async () => {
    const fake = makeHooks(true);
    const writer = new FrameWriter(fake.hooks);
    writer.send(frame('f1'));
    await writer.drained(); // f1 写完且 write 返回 false → 进入等 drain 态
    expect(fake.writes.map(b => b.toString())).toEqual(['f1']);

    writer.send(frame('f2'));
    let done = false;
    void writer.drained().then(() => {
      done = true;
    });
    await flushMicrotasks();
    expect(done).toBe(false); // 等 drain:f2 不得写
    expect(fake.writes).toHaveLength(1);

    fake.emit('drain');
    await flushMicrotasks();
    expect(done).toBe(true);
    expect(fake.writes.map(b => b.toString())).toEqual(['f1', 'f2']);
  });

  it('背压期间 FIFO:阻塞中入队多帧,drain 后按序全部写出;在队帧数可观测', async () => {
    const fake = makeHooks(true);
    const writer = new FrameWriter(fake.hooks);
    writer.send(frame('f1'));
    await writer.drained(); // 阻塞态(write 返回 false)
    writer.send(frame('f2'));
    writer.send(frame('f3'));
    writer.send(frame('f4'));
    await flushMicrotasks();
    expect(writer.pendingFrames).toBe(3); // 在队未写 = 硬上界观测口
    expect(fake.writes).toHaveLength(1);

    fake.emit('drain');
    await writer.drained();
    expect(fake.writes.map(b => b.toString())).toEqual(['f1', 'f2', 'f3', 'f4']);
    expect(writer.pendingFrames).toBe(0);
  });

  it('close/error 事件放行(进程死掉链不悬挂):等 drain 中的帧继续走写口', async () => {
    for (const event of ['close', 'error'] as const) {
      const fake = makeHooks(true);
      const writer = new FrameWriter(fake.hooks);
      writer.send(frame('f1'));
      await writer.drained(); // 阻塞态
      writer.send(frame('f2'));
      let done = false;
      void writer.drained().then(() => {
        done = true;
      });
      await flushMicrotasks(); // 等 writeFrame 真正进入等 drain(监听已注册)
      fake.emit(event);
      await flushMicrotasks();
      expect(done).toBe(true);
      expect(fake.writes).toHaveLength(2); // 写口照常被调(真实 stdin 已死时由写口返回值/异常兜底)
    }
  });

  it('写口抛异常(exit 竞态 EPIPE 窗口):吞掉不悬挂,后续帧继续', async () => {
    const fake = makeHooks();
    let boom = true;
    const throwingHooks: FrameWriterHooks = {
      ...fake.hooks,
      write: f => {
        if (boom) {
          boom = false;
          throw new Error('EPIPE race');
        }
        return fake.hooks.write(f);
      }
    };
    const writer = new FrameWriter(throwingHooks);
    writer.send(frame('f1'));
    writer.send(frame('f2'));
    await writer.drained();
    expect(fake.writes.map(b => b.toString())).toEqual(['f2']);
  });
});
