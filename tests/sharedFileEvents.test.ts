import { describe, expect, it } from 'vitest';
import { createSharedFileEventMerger } from '../src/sharedFileEvents';

// IDE-SNP-008:共享文件事件按 URI 合并——同一保存的重复通知(同 URI 同 kind)
// 只让每个消费索引应用一次;kind 变化是不同版本语义,立即投递不延迟。每个
// 消费索引一个合并器实例(互不串线)。

describe('IDE-SNP-008:共享文件事件按 URI 合并', () => {
  it('首报即达(消费端同步可用),窗口内同 kind 重复只应用一次', () => {
    const merger = createSharedFileEventMerger();
    const seen: string[] = [];
    merger.subscribe(event => { seen.push(`${event.fsPath}:${event.kind}`); });

    merger.emit('/ws/a.py', 'change');
    expect(seen).toEqual(['/ws/a.py:change']); // 首报即达

    merger.emit('/ws/a.py', 'change');
    merger.emit('/ws/a.py', 'change');
    merger.flushForTests();
    expect(seen).toEqual(['/ws/a.py:change']); // 重复被合并掉
  });

  it('kind 变化立即投递:change 后 delete 两次都到达,终态不丢', () => {
    const merger = createSharedFileEventMerger();
    const seen: string[] = [];
    merger.subscribe(event => { seen.push(`${event.fsPath}:${event.kind}`); });

    merger.emit('/ws/b.def', 'change');
    merger.emit('/ws/b.def', 'delete');
    merger.emit('/ws/b.def', 'delete');
    expect(seen).toEqual(['/ws/b.def:change', '/ws/b.def:delete']);
  });

  it('不同 URI 互不合并:各自首报即达', () => {
    const merger = createSharedFileEventMerger();
    const seen: string[] = [];
    merger.subscribe(event => { seen.push(`${event.fsPath}:${event.kind}`); });

    merger.emit('/ws/c.py', 'change');
    merger.emit('/ws/d.py', 'change');
    merger.emit('/ws/c.py', 'change');
    merger.flushForTests();
    expect(seen).toEqual(['/ws/c.py:change', '/ws/d.py:change']);
  });

  it('路径归一:同一文件的点段/反斜杠拼写合并为一次', () => {
    const merger = createSharedFileEventMerger();
    const seen: string[] = [];
    merger.subscribe(event => { seen.push(`${event.fsPath}:${event.kind}`); });

    merger.emit('/ws/e.def', 'change');
    merger.emit('\\ws\\.\\e.def', 'change');
    merger.flushForTests();
    expect(seen).toEqual(['/ws/e.def:change']);
  });

  it('同一合并器的多个订阅者各自收到一次(每个索引只应用一次)', () => {
    const merger = createSharedFileEventMerger();
    let consumerA = 0;
    let consumerB = 0;
    merger.subscribe(() => { consumerA += 1; });
    merger.subscribe(() => { consumerB += 1; });

    merger.emit('/ws/f.py', 'change');
    merger.emit('/ws/f.py', 'change');
    merger.emit('/ws/f.py', 'change');
    merger.flushForTests();
    expect(consumerA).toBe(1);
    expect(consumerB).toBe(1);
  });

  it('两个合并器实例互不串线', () => {
    const mergerA = createSharedFileEventMerger();
    const mergerB = createSharedFileEventMerger();
    const seenA: string[] = [];
    const seenB: string[] = [];
    mergerA.subscribe(event => { seenA.push(event.kind); });
    mergerB.subscribe(event => { seenB.push(event.kind); });

    mergerA.emit('/ws/g.py', 'change');
    expect(seenA).toEqual(['change']);
    expect(seenB).toEqual([]);
  });

  it('窗口到期后同 kind 再报是新一轮(真定时器)', async () => {
    const merger = createSharedFileEventMerger(5);
    const seen: string[] = [];
    merger.subscribe(event => { seen.push(event.kind); });

    merger.emit('/ws/h.py', 'change');
    merger.emit('/ws/h.py', 'change'); // 窗口内重复,吞掉
    await new Promise(resolve => setTimeout(resolve, 20));
    merger.emit('/ws/h.py', 'change'); // 新一轮,照常投递
    expect(seen).toEqual(['change', 'change']);
  });

  it('退订后不再收', () => {
    const merger = createSharedFileEventMerger();
    const seen: string[] = [];
    const unsubscribe = merger.subscribe(event => { seen.push(event.kind); });

    merger.emit('/ws/i.py', 'change');
    unsubscribe();
    merger.emit('/ws/i.py', 'delete');
    merger.flushForTests();
    expect(seen).toEqual(['change']);
  });

  it('dispose 后 emit 不投递也不再保留状态', () => {
    const merger = createSharedFileEventMerger();
    const seen: string[] = [];
    merger.subscribe(event => { seen.push(event.kind); });

    merger.emit('/ws/j.py', 'change');
    merger.dispose();
    merger.emit('/ws/j.py', 'delete');
    merger.flushForTests();
    expect(seen).toEqual(['change']);
  });
});
