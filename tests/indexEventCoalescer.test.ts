import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  INDEX_COALESCE_MAX_DEFER_MS,
  INDEX_COALESCE_WINDOW_MS,
  createIndexEventCoalescer,
  decideCoalesceFlush
} from '../src/backend/indexEventCoalescer';

// INDEX-DISCIPLINE-001 ①:索引重扫事件合并器。TS 镜像决策核与 Rust
// `$/kode/events/coalesce`(kode-server event_coalesce.rs)语义同构——
// 窗口 hold → dirty 尾随顺延 → flush 按「最近修改的最后出」排序。
// 壳:pending Map(latest-wins)+ 窗口轮询钟 + isDirty 采样 + 入队。

afterEach(() => { vi.useRealTimers(); });

describe('decideCoalesceFlush 镜像决策核(与 Rust decide_coalesce 内联用例同语料)', () => {
  it('窗口内 → hold;窗口外 → flush', () => {
    const decision = decideCoalesceFlush(
      [{ file: 'a.py', firstPushedAtMs: 6000, lastPushedAtMs: 6200 }],
      [],
      6300
    );
    expect(decision).toEqual({ flush: [], defer: [], hold: 1 });
    const later = decideCoalesceFlush(
      [{ file: 'a.py', firstPushedAtMs: 6000, lastPushedAtMs: 6200 }],
      [],
      6600
    );
    expect(later).toEqual({ flush: ['a.py'], defer: [], hold: 0 });
  });

  it('flush 时 dirty → 顺延下一窗(尾随顺延);max_defer 到顶 → dirty 也 flush(有界)', () => {
    const entry = { file: 'a.py', firstPushedAtMs: 0, lastPushedAtMs: 0 };
    expect(decideCoalesceFlush([entry], ['a.py'], 1000))
      .toEqual({ flush: [], defer: ['a.py'], hold: 0 });
    const pushedLater = { file: 'a.py', firstPushedAtMs: 100, lastPushedAtMs: 4700 };
    expect(decideCoalesceFlush([pushedLater], ['a.py'], 5000))
      .toEqual({ flush: [], defer: ['a.py'], hold: 0 });
    const beyond = { file: 'a.py', firstPushedAtMs: 0, lastPushedAtMs: 5000 };
    expect(decideCoalesceFlush([beyond], ['a.py'], 5600))
      .toEqual({ flush: ['a.py'], defer: [], hold: 0 });
  });

  it('flush 序=最近修改的最后出(last 升序)', () => {
    const decision = decideCoalesceFlush(
      [
        { file: 'newest.py', firstPushedAtMs: 700, lastPushedAtMs: 900 },
        { file: 'oldest.py', firstPushedAtMs: 0, lastPushedAtMs: 100 },
        { file: 'middle.py', firstPushedAtMs: 400, lastPushedAtMs: 500 }
      ],
      [],
      10000
    );
    expect(decision.flush).toEqual(['oldest.py', 'middle.py', 'newest.py']);
  });

  it('干净文件永不顺延(顺延只对编辑中的文件)', () => {
    const decision = decideCoalesceFlush(
      [
        { file: 'dirty.py', firstPushedAtMs: 0, lastPushedAtMs: 0 },
        { file: 'clean.py', firstPushedAtMs: 0, lastPushedAtMs: 50 }
      ],
      ['dirty.py'],
      1000
    );
    expect(decision.flush).toEqual(['clean.py']);
    expect(decision.defer).toEqual(['dirty.py']);
  });

  it('窗口内重复推送以最新 last 判窗(合并的意义)', () => {
    const decision = decideCoalesceFlush(
      [{ file: 'a.py', firstPushedAtMs: 0, lastPushedAtMs: 800 }],
      [],
      1000
    );
    expect(decision.hold).toBe(1);
  });
});

describe('合并器壳(pending 状态 + 轮询钟 + 采样 + 入队)', () => {
  it('同文件 N 次推送 → 窗口到只入队一次(latest-wins 并一)', async () => {
    vi.useFakeTimers();
    const reindexed: string[] = [];
    const coalescer = createIndexEventCoalescer({
      isDirty: () => false,
      enqueueReindex: file => { reindexed.push(file); }
    });
    for (let i = 0; i < 5; i += 1) {
      coalescer.push('/ws/a.py');
      await vi.advanceTimersByTimeAsync(50);
    }
    expect(coalescer.getPendingCount()).toBe(1);
    // 钟从首推起跳:推完时last=T0+200,须越过 T0+600 的轮询拍(300 对齐)
    await vi.advanceTimersByTimeAsync(INDEX_COALESCE_WINDOW_MS + 150);
    expect(reindexed).toEqual(['/ws/a.py']);
    expect(coalescer.getPendingCount()).toBe(0);
    expect(coalescer.getStatsForTests()).toEqual({ pushed: 5, flushed: 1, deferred: 0 });
    coalescer.dispose();
  });

  it('编辑中(dirty)的文件尾随顺延,直到 max_defer 到顶或有界释放', async () => {
    vi.useFakeTimers();
    const reindexed: string[] = [];
    let dirty = true;
    const coalescer = createIndexEventCoalescer({
      isDirty: () => dirty,
      enqueueReindex: file => { reindexed.push(file); }
    });
    coalescer.push('/ws/a.py');
    // 每窗都顺延:dirty 期间绝不重索引(编辑中反复重建没意义)
    for (let i = 0; i < 6; i += 1) {
      await vi.advanceTimersByTimeAsync(INDEX_COALESCE_WINDOW_MS);
    }
    expect(reindexed).toEqual([]);
    expect(coalescer.getPendingCount()).toBe(1);
    // max_defer(5s)到顶:dirty 也有界放行(不让单个文件无限饿死队列)
    await vi.advanceTimersByTimeAsync(INDEX_COALESCE_MAX_DEFER_MS);
    expect(reindexed).toEqual(['/ws/a.py']);
    // 不再 dirty 时下一窗即正常走(保存自愈路径)
    dirty = false;
    coalescer.push('/ws/a.py');
    await vi.advanceTimersByTimeAsync(INDEX_COALESCE_WINDOW_MS);
    expect(reindexed).toEqual(['/ws/a.py', '/ws/a.py']);
    coalescer.dispose();
  });

  it('多文件 flush 按「最近修改的最后出」入队', async () => {
    vi.useFakeTimers();
    const reindexed: string[] = [];
    const coalescer = createIndexEventCoalescer({
      isDirty: () => false,
      enqueueReindex: file => { reindexed.push(file); }
    });
    coalescer.push('/ws/old.py');
    await vi.advanceTimersByTimeAsync(100);
    coalescer.push('/ws/new.py');
    // 首推 T0,新文件 last=T0+100;两件都要过窗 → 须越过 T0+600 的轮询拍
    await vi.advanceTimersByTimeAsync(INDEX_COALESCE_WINDOW_MS * 2);
    expect(reindexed).toEqual(['/ws/old.py', '/ws/new.py']);
    coalescer.dispose();
  });

  it('dispose 清钟清列;注入 decide 可直钉决策面', async () => {
    vi.useFakeTimers();
    const reindexed: string[] = [];
    const decide = vi.fn(async () => ({ flush: [], defer: [], hold: 42 }));
    const coalescer = createIndexEventCoalescer({
      isDirty: () => false,
      enqueueReindex: file => { reindexed.push(file); },
      decide
    });
    coalescer.push('/ws/a.py');
    await vi.advanceTimersByTimeAsync(INDEX_COALESCE_WINDOW_MS * 2);
    expect(decide).toHaveBeenCalled();
    expect(reindexed).toEqual([]);
    coalescer.dispose();
    expect(coalescer.getPendingCount()).toBe(0);
  });
});
