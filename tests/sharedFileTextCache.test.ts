// 共享文件原文缓存(2026-11-24 批 1)——「读一次、扇出多次」核心语义:
// stat 校验命中免读/变更重读/失败不缓存且原样抛/单飞并入不重复记账/LRU
// 有界淘汰/超大透传不入缓存/fileReadMetrics 记账入口只记真盘读。

import { describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  SHARED_FILE_TEXT_BUDGET_BYTES,
  SharedFileTextCache,
  type SharedFileTextCacheDeps
} from '../src/backend/sharedFileTextCache';
import { getSharedFileTextCache, resetSharedFileTextCacheForTests } from '../src/backend/sharedFileTextCache';
import {
  getFileReadTotals,
  readFileUtf8Recorded,
  readFileSyncUtf8Recorded,
  resetFileReadMetrics
} from '../src/backend/fileReadMetrics';

const makeDeps = (overrides: Partial<SharedFileTextCacheDeps> = {}): SharedFileTextCacheDeps => ({
  statAsync: vi.fn(async () => ({ mtimeMs: 100, size: 6 })),
  readAsync: vi.fn(async () => 'abcdef'),
  statSync: vi.fn(() => ({ mtimeMs: 100, size: 6 })),
  readSync: vi.fn(() => 'abcdef'),
  ...overrides
});

describe('SharedFileTextCache 读一次扇出多次', () => {
  it('首次真读入缓存;第二次 stat 一致即命中免读', async () => {
    const deps = makeDeps();
    const cache = new SharedFileTextCache(SHARED_FILE_TEXT_BUDGET_BYTES, deps);
    const first = await cache.readThroughAsync('/p/a.py');
    expect(first.text).toBe('abcdef');
    expect(first.fromCache).toBe(false);
    const second = await cache.readThroughAsync('/p/a.py');
    expect(second.fromCache).toBe(true);
    expect(second.text).toBe('abcdef');
    expect(deps.readAsync).toHaveBeenCalledTimes(1);
    expect(deps.statAsync).toHaveBeenCalledTimes(2);
    expect(cache.snapshotStats()).toMatchObject({ hits: 1, misses: 1, failures: 0 });
  });

  it('mtime/size 任一漂移即重读(变了就重读的用户语义)', async () => {
    let fingerprint = { mtimeMs: 100, size: 6 };
    const deps = makeDeps({
      statAsync: vi.fn(async () => fingerprint),
      readAsync: vi.fn(async () => 'newer!')
    });
    const cache = new SharedFileTextCache(SHARED_FILE_TEXT_BUDGET_BYTES, deps);
    await cache.readThroughAsync('/p/a.py');
    fingerprint = { mtimeMs: 200, size: 6 };
    const second = await cache.readThroughAsync('/p/a.py');
    expect(second.fromCache).toBe(false);
    expect(second.text).toBe('newer!');
    // size 漂移单独也会重读(同 mtime 改写窗口被 size 键挡住)
    fingerprint = { mtimeMs: 200, size: 99 };
    const third = await cache.readThroughAsync('/p/a.py');
    expect(third.fromCache).toBe(false);
    expect(deps.readAsync).toHaveBeenCalledTimes(3);
  });

  it('stat 不可得 → 纯透传(读缝原样跑,不入缓存);指纹可得但读失败 → 清条目原样抛', async () => {
    let failStat = false;
    let failRead = false;
    let fingerprint = { mtimeMs: 100, size: 6 };
    const deps = makeDeps({
      statAsync: vi.fn(async () => {
        if (failStat) { throw new Error('EPERM: locked'); }
        return fingerprint;
      }),
      readAsync: vi.fn(async () => {
        if (failRead) { throw new Error('EBUSY: resource busy'); }
        return 'abcdef';
      })
    });
    const cache = new SharedFileTextCache(SHARED_FILE_TEXT_BUDGET_BYTES, deps);
    // stat 不可得:透传读缝(与接入前「直接读」同行为),不缓存不入账
    failStat = true;
    const bypassed = await cache.readThroughAsync('/p/locked.py');
    expect(bypassed.text).toBe('abcdef');
    expect(bypassed.fromCache).toBe(false);
    expect(cache.snapshotStats()).toMatchObject({ hits: 0, misses: 0, entries: 0 });
    expect((await cache.readThroughAsync('/p/locked.py')).fromCache).toBe(false);
    expect(deps.readAsync).toHaveBeenCalledTimes(2);
    // stat 恢复:正常入缓存
    failStat = false;
    const ok = await cache.readThroughAsync('/p/locked.py');
    expect(ok.fromCache).toBe(false);
    expect(cache.snapshotStats().entries).toBe(1);
    expect((await cache.readThroughAsync('/p/locked.py')).fromCache).toBe(true);
    // 指纹漂移后重读遇读失败:条目被清,错误原样抛(不毒化)
    fingerprint = { mtimeMs: 300, size: 6 };
    failRead = true;
    await expect(cache.readThroughAsync('/p/locked.py')).rejects.toThrow('EBUSY');
    expect(cache.snapshotStats().entries).toBe(0);
    failRead = false;
    expect((await cache.readThroughAsync('/p/locked.py')).fromCache).toBe(false);
  });

  it('loader 注入:未中缓存走注入读缝(面自有桩缝不被改道);命中不走读缝', async () => {
    const deps = makeDeps();
    const cache = new SharedFileTextCache(SHARED_FILE_TEXT_BUDGET_BYTES, deps);
    const loaderReads: string[] = [];
    const loader = vi.fn(async (p: string) => {
      loaderReads.push(p);
      return `via-loader:${p}`;
    });
    const first = await cache.readThroughAsync('/p/seam.py', loader);
    expect(first.text).toBe('via-loader:/p/seam.py');
    expect(first.fromCache).toBe(false);
    expect(deps.readAsync).not.toHaveBeenCalled();
    // 命中:免读,loader 不被调
    const second = await cache.readThroughAsync('/p/seam.py', loader);
    expect(second.fromCache).toBe(true);
    expect(second.text).toBe('via-loader:/p/seam.py');
    expect(loader).toHaveBeenCalledTimes(1);
    // stat 不可得的透传也走注入缝
    const failingStat = new SharedFileTextCache(SHARED_FILE_TEXT_BUDGET_BYTES, makeDeps({
      statAsync: vi.fn(async () => { throw new Error('ENOENT'); })
    }));
    const bypass = await failingStat.readThroughAsync('/p/gone.py', loader);
    expect(bypass.text).toBe('via-loader:/p/gone.py');
    expect(failingStat.snapshotStats().entries).toBe(0);
  });

  it('同路径并发并入单飞:一次真读,并入方 fromCache=true 不重复记账', async () => {
    let releaseRead!: (value: string) => void;
    const deps = makeDeps({
      readAsync: vi.fn(() => new Promise<string>(resolve => { releaseRead = resolve; }))
    });
    const cache = new SharedFileTextCache(SHARED_FILE_TEXT_BUDGET_BYTES, deps);
    const first = cache.readThroughAsync('/p/hot.py');
    const second = cache.readThroughAsync('/p/hot.py');
    // 让 stat 微任务走完,读才真正发起(单飞键此时已立)
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    releaseRead('shared');
    const [r1, r2] = await Promise.all([first, second]);
    expect(r1.fromCache).toBe(false);
    expect(r2.fromCache).toBe(true);
    expect(r2.text).toBe('shared');
    expect(deps.readAsync).toHaveBeenCalledTimes(1);
  });

  it('LRU 预算淘汰:超预算丢最旧;单条超预算透传不入缓存', async () => {
    const cache = new SharedFileTextCache(12, makeDeps());
    await cache.readThroughAsync('/p/one.py'); // 6B
    await cache.readThroughAsync('/p/two.py'); // 6B → 12B 满
    expect(cache.snapshotStats().entries).toBe(2);
    await cache.readThroughAsync('/p/three.py'); // 6B → 挤掉最旧 one
    const stats = cache.snapshotStats();
    expect(stats.entries).toBe(2);
    expect(stats.evictions).toBe(1);
    // 单条超预算:透传但不入缓存
    const deps2 = makeDeps({ readAsync: vi.fn(async () => 'x'.repeat(64)) });
    const big = new SharedFileTextCache(32, deps2);
    const read = await big.readThroughAsync('/p/big.py');
    expect(read.text).toHaveLength(64);
    expect(big.snapshotStats().entries).toBe(0);
  });

  it('同步入口同语义:命中免读;stat 不可得透传;读失败原样抛', () => {
    const deps = makeDeps();
    const cache = new SharedFileTextCache(SHARED_FILE_TEXT_BUDGET_BYTES, deps);
    expect(cache.readThroughSync('/p/s.py').fromCache).toBe(false);
    expect(cache.readThroughSync('/p/s.py').fromCache).toBe(true);
    expect(deps.readSync).toHaveBeenCalledTimes(1);
    // stat 不可得:透传读缝,不入缓存(与接入前「直接读」同行为)
    const noStat = new SharedFileTextCache(SHARED_FILE_TEXT_BUDGET_BYTES, makeDeps({
      statSync: vi.fn(() => { throw new Error('ENOENT'); })
    }));
    expect(noStat.readThroughSync('/p/gone.py').text).toBe('abcdef');
    expect(noStat.snapshotStats()).toMatchObject({ entries: 0, misses: 0 });
    // 指纹可得但读失败:原样抛
    const failing = new SharedFileTextCache(SHARED_FILE_TEXT_BUDGET_BYTES, makeDeps({
      readSync: vi.fn(() => { throw new Error('EBUSY'); })
    }));
    expect(() => failing.readThroughSync('/p/busy.py')).toThrow('EBUSY');
    expect(failing.snapshotStats().entries).toBe(0);
  });

  it('invalidate/clear 生效;异步与同步共享同一份数据', async () => {
    const cache = new SharedFileTextCache(SHARED_FILE_TEXT_BUDGET_BYTES, makeDeps());
    await cache.readThroughAsync('/p/x.py');
    expect(cache.readThroughSync('/p/x.py').fromCache).toBe(true);
    cache.invalidate('/p/x.py');
    expect(cache.readThroughSync('/p/x.py').fromCache).toBe(false);
    cache.clear();
    expect(cache.snapshotStats().entries).toBe(0);
  });

  it('宿主单例:跨调用共享缓存;reset 换新实例', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-sharedcache-'));
    const file = path.join(dir, 'singleton.py');
    fs.writeFileSync(file, 'singleton-text');
    // 桩环境 stat 缝接真盘(fake workspace.fs.stat 只认 memoryFileSystem,
    // 真临时文件查不到):异步腿入缓存靠真 stat 指纹
    const originalStat = vscode.workspace.fs.stat;
    vscode.workspace.fs.stat = async (uri: { fsPath: string }) => {
      const s = await fs.promises.stat(uri.fsPath);
      return { type: 1, ctime: s.birthtimeMs, mtime: s.mtimeMs, size: s.size };
    };
    try {
      resetSharedFileTextCacheForTests();
      const cache = getSharedFileTextCache();
      await cache.readThroughAsync(file);
      expect(getSharedFileTextCache().readThroughSync(file).fromCache).toBe(true);
      resetSharedFileTextCacheForTests();
      expect(getSharedFileTextCache()).not.toBe(cache);
      expect(getSharedFileTextCache().readThroughSync(file).fromCache).toBe(false);
    } finally {
      vscode.workspace.fs.stat = originalStat;
    }
  });

  it('热面收口验收:同步腿与异步腿(两热面同一读缝)读同一文件只读盘一次(2026-11-24 批 A-1)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-cache-faces-'));
    const file = path.join(dir, 'same-face-file.txt');
    fs.writeFileSync(file, 'abcdef', 'utf8');
    // 异步腿的 stat 缝走 vscode.workspace.fs.stat(缺省依赖),桩工作区查不到
    // 真临时文件 → 指纹不可得 = 纯透传不入缓存。接真盘 stat 才验缓存共享。
    const originalStat = vscode.workspace.fs.stat;
    vscode.workspace.fs.stat = async (uri: { fsPath: string }) => {
      const s = await fs.promises.stat(uri.fsPath);
      return { type: 1, ctime: s.birthtimeMs, mtime: s.mtimeMs, size: s.size };
    };
    try {
      resetFileReadMetrics(); // 一并清共享缓存
      const syncText = readFileSyncUtf8Recorded(file);
      const asyncText = await readFileUtf8Recorded(file);
      expect(syncText).toBe(asyncText);
      expect(getFileReadTotals().reads, '同一文件跨同步/异步腿只读盘一次').toBe(1);
      expect(getFileReadTotals().bytes).toBe(6);
    } finally {
      vscode.workspace.fs.stat = originalStat;
      resetFileReadMetrics();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
