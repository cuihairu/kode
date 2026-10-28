import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it, vi } from 'vitest';
import { LogHub } from '../src/logHub';

describe('LogHub', () => {
  it('deduplicates stdout and file events from the same source', async () => {
    const hub = new LogHub({ flushIntervalMs: 5 });
    hub.stdout({ source: 'stdout', component: 'svc', text: 'same\n', origin: 'shared' });
    hub.ingest({ source: 'file', component: 'svc', text: 'same', origin: 'shared' });
    hub.flush();
    expect(hub.getRetained()).toHaveLength(1);
    expect(hub.getRetained()[0].text).toBe('same');
    hub.dispose();
  });

  it('deduplicates repeated lines only inside the source window and keeps their count', () => {
    vi.useFakeTimers();
    const hub = new LogHub({ flushIntervalMs: 5, dedupeWindowMs: 1000 });
    hub.info({ source: 'stdout', component: 'svc', origin: 'source-a', text: 'ready' });
    hub.info({ source: 'stdout', component: 'svc', origin: 'source-b', text: 'ready' });
    hub.info({ source: 'stdout', component: 'svc', origin: 'source-a', text: 'ready' });
    vi.advanceTimersByTime(1001);
    hub.info({ source: 'stdout', component: 'svc', origin: 'source-a', text: 'ready' });

    expect(hub.getRetained().map(event => [event.origin, event.duplicateCount])).toEqual([
      ['source-a', 2],
      ['source-b', 1],
      ['source-a', 1]
    ]);
    hub.dispose();
    vi.useRealTimers();
  });

  it('batches increments and caps retained memory', async () => {
    const hub = new LogHub({ capacity: 2, flushIntervalMs: 5000 });
    hub.info({ source: 'process', component: 'a', text: '1' });
    hub.info({ source: 'process', component: 'a', text: '2' });
    hub.info({ source: 'process', component: 'a', text: '3' });
    hub.flush();
    const batches: number[] = [];
    const unsubscribe = hub.onBatch(batch => batches.push(batch.events.length));
    hub.info({ source: 'process', component: 'a', text: '4' });
    hub.flush();
    unsubscribe();
    expect(hub.getRetained().map(event => event.text)).toEqual(['3', '4']);
    expect(batches).toEqual([1]);
    hub.dispose();
  });

  it('reads only file increments including truncation', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'kode-loghub-'));
    const file = join(directory, 'server.log');
    const hub = new LogHub({ flushIntervalMs: 5 });
    writeFileSync(file, 'first\n');
    hub.watchFile('svc', file, 5);
    await new Promise(resolve => setTimeout(resolve, 100));
    writeFileSync(file, 'first\nsecond\n');
    await new Promise(resolve => setTimeout(resolve, 100));
    const lines = hub.getRetained().map(event => event.text);
    expect(lines).toEqual(['first', 'second']);
    writeFileSync(file, 'tiny\n');
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(hub.getRetained().map(event => event.text)).toEqual(['first', 'second', 'tiny']);
    hub.dispose();
    rmSync(directory, { recursive: true, force: true });
  });

  it('日志突增分批读取:单次分配不超过批上限,绝不一次吃下全部增量(IDE-RES-005)', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'kode-loghub-chunk-'));
    const file = join(directory, 'surge.log');
    const hub = new LogHub({ flushIntervalMs: 5 });
    // 突增 ≈2.6MiB:3 行各 ≈900KB,行边界横跨 1MiB 批界(批边界切在行中间)
    const lines = ['l1', 'l2', 'l3'].map(tag => `${tag}:${'x'.repeat(900 * 1024)}`);
    writeFileSync(file, `${lines.join('\n')}\n`);

    const allocOriginal = Buffer.alloc;
    const allocSizes: number[] = [];
    // watchFile 首轮 poll 在其调用栈内同步执行:记账 spy 必须先于 watchFile 挂上
    const allocSpy = vi
      .spyOn(Buffer, 'alloc')
      .mockImplementation((size: number, fill?: string | number | Uint8Array, encoding?: BufferEncoding) => {
        allocSizes.push(size);
        return allocOriginal(size, fill, encoding);
      });
    hub.watchFile('svc', file, 5);
    await new Promise(resolve => setTimeout(resolve, 50));
    allocSpy.mockRestore();
    hub.dispose();

    // 分批生效:任何一次分配都 ≤1MiB 批上限(旧实现一次 alloc 2.6MiB 全量)
    expect(allocSizes.length).toBeGreaterThan(0);
    expect(Math.max(...allocSizes)).toBeLessThanOrEqual(1024 * 1024);
    // 内容完整且行不被批边界拆断:3 行原文整行按序 ingest
    expect(hub.getRetained().map(event => event.text)).toEqual(lines);
    rmSync(directory, { recursive: true, force: true });
  });
});

describe('LogHub subscriber contract', () => {
  it('delivers only new events after subscription', () => {
    const hub = new LogHub({ flushIntervalMs: 5000 });
    const batches: string[][] = [];
    hub.onBatch(batch => batches.push(batch.events.map(event => event.text)));
    hub.info({ source: 'process', component: 'svc', text: 'first' });
    hub.flush();
    hub.info({ source: 'process', component: 'svc', text: 'second' });
    hub.flush();
    expect(batches).toEqual([['first'], ['second']]);
    hub.dispose();
  });
});

describe('LogHub webview source', () => {
  it('deduplicates webview events by origin and preserves the client timestamp', () => {
    const hub = new LogHub({ flushIntervalMs: 5, dedupeWindowMs: 1000 });
    const timestamp = Date.parse('2026-10-22T00:00:00Z');
    const input = { source: 'webview' as const, component: 'webview', origin: 'page-a', text: 'same', timestamp };
    hub.ingest(input);
    hub.ingest(input);
    hub.ingest({ ...input, origin: 'page-b' });
    hub.flush();

    expect(hub.getRetained()).toEqual([
      expect.objectContaining({ source: 'webview', origin: 'page-a', duplicateCount: 2, timestamp }),
      expect.objectContaining({ source: 'webview', origin: 'page-b', duplicateCount: 1, timestamp })
    ]);
    hub.dispose();
  });
});
