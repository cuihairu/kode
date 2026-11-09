import { describe, expect, it } from 'vitest';

import {
  GitCancelSource,
  GitQueryGate,
  gitQueryIdentity
} from '../src/backend/gitQueryGate';
import type { GitRunOptions, GitRunOutcome } from '../src/backend/gitRunner';

/**
 * IDE-GIT-011 补臂(协调门调度剩余分支):
 * 既有 gitQueryGate.test.ts 已覆盖去重/并发上限/有界队列/隔离缓存/取消清理;
 * 本文件专门补基线缺口语句:
 *   - GitCancelSource.cancel 幂等守卫(已取消时早退)[55]
 *   - invalidate(identity):命中删除并回退字节[285-288]
 *   - canStart 高成本上限(并发未满但 rangeRunning 已达 maxRangeConcurrent)[335]
 *   - spawn 拒绝(子进程启动失败)→ 结构化 spawn 结果[353]
 *   - drain 队首不可启动(释放槽后补位遇 range 满/并发满)→ 返回[369]
 *   - LRU 淘汰循环(超条目数逐最旧,执行 oldest.done/!evicted 检查)[385,388]
 *
 * 死臂(公开 API 不可达,不强制测试):
 *   - writeCache 的 `if (outcome.kind !== 'ok') return;`[376]:唯一调用点
 *     在 start 内 `outcome.kind === 'ok' && ...` 已过滤(行 346),writeCache
 *     只被传入 ok 结果,376 恒假不可达。
 *   - LRU 淘汰循环 `if (oldest.done) break;`[385] 的 break 臂:进入循环时
 *     while 条件 `size>maxCacheEntries || bytes>maxCacheBytes` 已保证缓存非空
 *     (size>maxCacheEntries 则 size≥1;bytes>上限则至少一条),oldest.done 恒假。
 *   - LRU 淘汰循环 `if (!evicted) break;`[388] 的 break 臂:key 取自已迭代的
 *     cache.keys().next() 后立即 get,恒命中,!evicted 恒假。
 *   (行 385/388 的 if 检查本身经 LRU 淘汰用例覆盖;仅其 break 返回臂不可达。)
 */

type SpawnCall = {
  args: string[];
  options: GitRunOptions;
  resolve: (outcome: GitRunOutcome) => void;
};

const makeSpawn = (): { spawn: (args: string[], options: GitRunOptions) => Promise<GitRunOutcome>; calls: SpawnCall[] } => {
  const calls: SpawnCall[] = [];
  const spawn = (args: string[], options: GitRunOptions): Promise<GitRunOutcome> =>
    new Promise<GitRunOutcome>((resolve) => {
      const call: SpawnCall = { args: [...args], options, resolve };
      calls.push(call);
      options.token?.onRequestCancel?.(() => resolve({ kind: 'cancelled' }));
    });
  return { spawn, calls };
};

const ok = (stdout = 'x'): GitRunOutcome => ({ kind: 'ok', stdout, stderr: '' });
const runOpts = (cwd = '/repo'): GitRunOptions => ({ cwd, timeoutMs: 1000, maxOutputBytes: 1024 });

describe('GitCancelSource.cancel 幂等守卫', () => {
  it('二次 cancel 早退,回调只触发一次', () => {
    const source = new GitCancelSource();
    let count = 0;
    source.onRequestCancel(() => {
      count += 1;
    });
    expect(source.isCancellationRequested).toBe(false);
    source.cancel();
    source.cancel(); // 已取消 → 行 55 早退
    expect(source.isCancellationRequested).toBe(true);
    expect(count).toBe(1);
  });
});

describe('invalidate 显式失效', () => {
  it('命中缓存删除条目并回退字节;未知键 no-op', async () => {
    const { spawn, calls } = makeSpawn();
    const gate = new GitQueryGate(undefined, { spawn });
    const identity = gitQueryIdentity('/repo', ['show', 'abc123:x.py']);
    const p = gate.run(['show', 'abc123:x.py'], runOpts());
    calls[0].resolve(ok('v'));
    await p;
    expect(gate.cacheCount()).toBe(1);
    expect(gate.cacheBytes()).toBe(1);
    gate.invalidate(identity);
    expect(gate.cacheCount()).toBe(0);
    expect(gate.cacheBytes()).toBe(0);
    // 未知键:不抛、不产生负字节
    gate.invalidate('no-such-identity');
    expect(gate.cacheCount()).toBe(0);
    expect(gate.cacheBytes()).toBe(0);
  });
});

describe('canStart 高成本范围并发上限', () => {
  it('并发未满但 rangeRunning 已达上限 → 排队(不越过 maxRangeConcurrent)', async () => {
    const { spawn, calls } = makeSpawn();
    const gate = new GitQueryGate({ maxConcurrent: 2, maxRangeConcurrent: 1 }, { spawn });
    gate.run(['log', '-L', '1,5:a.py', '--', 'a.py'], runOpts()); // range 运行
    const p2 = gate.run(['log', '-L', '1,5:c.py', '--', 'c.py'], runOpts()); // 第 2 range 排队
    expect(gate.runningCount()).toBe(1);
    expect(gate.queuedCount()).toBe(1);
    calls[0].resolve(ok());
    await Promise.resolve(); // 释放 range 槽 → 排队 range 启动
    expect(calls).toHaveLength(2);
    calls[1].resolve(ok());
    expect((await p2).kind).toBe('ok');
    expect(gate.queuedCount()).toBe(0);
  });
});

describe('spawn 启动失败映射', () => {
  it('spawn 拒绝 → 结构化 spawn 结果(Git 进程启动失败),不残留槽', async () => {
    const gate = new GitQueryGate(undefined, {
      spawn: () => Promise.reject(new Error('ENOENT'))
    });
    const r = await gate.run(['log', '--', 'x.py'], runOpts());
    expect(r).toEqual({ kind: 'spawn', message: 'Git 进程启动失败' });
    expect(gate.runningCount()).toBe(0);
    expect(gate.queuedCount()).toBe(0);
  });
});

describe('drain 队首不可启动', () => {
  it('释放槽后补位遇队首不可启动即返回,不越界启动后续项', async () => {
    const { spawn, calls } = makeSpawn();
    const gate = new GitQueryGate({ maxConcurrent: 1, maxRangeConcurrent: 1 }, { spawn });
    const pA = gate.run(['log', '--', 'a.py'], runOpts()); // 运行(并发 1 满)
    const pB = gate.run(['log', '-L', '1,5:b.py', '--', 'b.py'], runOpts()); // 排队
    const pC = gate.run(['log', '--', 'c.py'], runOpts()); // 排队(标准,队首 b 之后)
    expect(gate.queuedCount()).toBe(2);
    calls[0].resolve(ok());
    await pA;
    // b(range)启动占满并发;c 队首不可启动 → drain 行 369 返回
    expect(calls).toHaveLength(2);
    expect(gate.queuedCount()).toBe(1);
    calls[1].resolve(ok());
    await Promise.resolve(); // b 释放 → c 启动
    expect(calls).toHaveLength(3);
    calls[2].resolve(ok());
    await Promise.all([pB, pC]);
    expect(gate.runningCount()).toBe(0);
  });
});

describe('LRU 淘汰循环执行', () => {
  it('超条目数逐最旧:循环体执行(oldest.done/!evicted 检查经真值路径)', async () => {
    const { spawn, calls } = makeSpawn();
    const gate = new GitQueryGate({ maxCacheEntries: 1 }, { spawn });
    for (const f of ['a.py', 'b.py']) {
      const p = gate.run(['show', `def456:${f}`], runOpts());
      calls.shift()!.resolve(ok(f));
      await p;
    }
    expect(gate.cacheCount()).toBe(1); // b 留存,a 被逐出
    expect(gate.cacheBytes()).toBe('b.py'.length); // 留存条目字节=stdout 长
  });
});
