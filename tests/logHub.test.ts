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
    // AUD-024 后单轮读总量受 64KB 预算,2.6MiB 分多轮排干:轮询等完整
    const drainDeadline = Date.now() + 8000;
    while (hub.getRetained().length < lines.length && Date.now() < drainDeadline) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    allocSpy.mockRestore();
    hub.dispose();

    // 分批生效:任何一次分配都 ≤1MiB 批上限(旧实现一次 alloc 2.6MiB 全量)
    expect(allocSizes.length).toBeGreaterThan(0);
    expect(Math.max(...allocSizes)).toBeLessThanOrEqual(1024 * 1024);
    // 内容完整且行不被批边界拆断:3 行原文整行按序 ingest
    expect(hub.getRetained().map(event => event.text)).toEqual(lines);
    rmSync(directory, { recursive: true, force: true });
  });

  it('UTF-8 边界正确:跨块多字节字符不损坏(AUD-024)', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'kode-loghub-utf8-'));
    const file = join(directory, 'utf8.log');
    // 预算=1MiB 时读界仍在 1MiB:'你'(3 字节)恰跨界——旧实现
    // toString 在界上切出替代符 �,解码器须保留不完整字节
    const hub = new LogHub({ flushIntervalMs: 5, maxPollBytesPerRound: 1024 * 1024 });
    const expected = `${'x'.repeat(1024 * 1024 - 1)}你${'y'.repeat(16)}`;
    writeFileSync(file, `${expected}\n`);
    hub.watchFile('svc', file, 5);
    const deadline = Date.now() + 8000;
    while (hub.getRetained().length === 0 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    hub.dispose();
    expect(hub.getRetained()).toHaveLength(1);
    expect(hub.getRetained()[0].text).toBe(expected);
    rmSync(directory, { recursive: true, force: true });
  });

  it('每轮读取总量受预算:突增多轮读取,单轮分配不超预算(AUD-024)', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'kode-loghub-budget-'));
    const file = join(directory, 'surge.log');
    const lineCount = 30000;
    const hub = new LogHub({ flushIntervalMs: 5, maxPollBytesPerRound: 64 * 1024, capacity: lineCount + 10 });
    writeFileSync(file, Array.from({ length: lineCount }, (_, i) => `line-${i}`).join('\n') + '\n');

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
    const deadline = Date.now() + 8000;
    while (hub.getRetained().length < lineCount && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    allocSpy.mockRestore();
    hub.dispose();

    expect(hub.getRetained()).toHaveLength(lineCount);
    // 旧实现一次 alloc 全增量(≈240KB)单轮读尽;预算 64KB 须拆多轮
    expect(allocSizes.length).toBeGreaterThan(1);
    expect(Math.max(...allocSizes)).toBeLessThanOrEqual(64 * 1024);
    rmSync(directory, { recursive: true, force: true });
  });

  it('日志突增按时间片让出宿主:心跳可走,单轮阻塞入预算(AUD-024)', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'kode-loghub-slice-'));
    const file = join(directory, 'surge.log');
    const lineCount = 30000;
    const hub = new LogHub({ flushIntervalMs: 5, capacity: lineCount + 10 });
    // ≈2.1MiB/3 万行:与 R2-F02 实测增量同量级,单轮同步读全量约 170ms
    const lineText = `log-${'x'.repeat(60)}`;
    writeFileSync(file, Array.from({ length: lineCount }, (_, i) => `${lineText}-${i}`).join('\n') + '\n');

    let ticks = 0;
    const heartbeat = setInterval(() => { ticks += 1; }, 0);
    const drainStart = Date.now();
    hub.watchFile('svc', file, 5);
    const deadline = Date.now() + 8000;
    while (hub.getRetained().length < lineCount && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const drainMs = Date.now() - drainStart;
    clearInterval(heartbeat);
    hub.dispose();

    expect(hub.getRetained()).toHaveLength(lineCount); // 完整读取不丢行
    expect(ticks).toBeGreaterThan(0); // 心跳可走:宿主已被让出(旧码整块 ~170ms 阻塞)
    const gauge = hub.getLogPollGaugeForTests();
    // 字节预算 64KB 对 2.1MiB 突增应拆出 ≈33 轮(旧码单轮吃全量 polls=1);
    // 轮数由预算决定,与负载无关,是稳定的主断言
    expect(gauge.polls).toBeGreaterThanOrEqual(20);
    // 时间维度用相对断言抗负载抖动:任何单轮不占排干总量一半以上
    // (旧码单轮=全量 100%;负载尖峰下绝对毫秒阈值不稳定)
    expect(gauge.maxPollMs).toBeLessThan(Math.max(drainMs / 2, 1));
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
