import { describe, expect, it } from 'vitest';
import {
  GitQueryGate,
  deriveQueryCost,
  gitQueryIdentity,
  defaultGitQueryGateLimits
} from '../src/gitQueryGate';
import type { GitCancellationToken, GitRunOptions, GitRunOutcome } from '../src/gitRunner';

// IDE-GIT-011:历史查询协调门(去重/并发上限/有界队列/隔离缓存/取消清理)。
// 全部用例经注入假 spawn(手工结算)验证调度,不触碰真实 Git 子进程。

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
      // 镜像 runGitReadOnly:取消令牌触发即结算 cancelled(子进程终止)。
      options.token?.onRequestCancel?.(() => resolve({ kind: 'cancelled' }));
    });
  return { spawn, calls };
};

const ok = (stdout = 'x'): GitRunOutcome => ({ kind: 'ok', stdout, stderr: '' });
const runOpts = (cwd = '/repo'): GitRunOptions => ({ cwd, timeoutMs: 1000, maxOutputBytes: 1024 });

describe('deriveQueryCost', () => {
  it('git log -L 判为高成本范围追踪,其余标准', () => {
    expect(deriveQueryCost(['log', '-L', '10,20:file.py', '--', 'file.py'])).toBe('range');
    expect(deriveQueryCost(['log', '--oneline', '--', 'file.py'])).toBe('standard');
    expect(deriveQueryCost(['show', 'HEAD:file.py'])).toBe('standard');
    expect(deriveQueryCost(['rev-list', '--parents', '-n1', 'HEAD'])).toBe('standard');
  });
});

describe('gitQueryIdentity', () => {
  it('键区分 cwd 与完整参数(仓库/提交/路径/范围/选项隔离)', () => {
    expect(gitQueryIdentity('/a', ['log', '--', 'x.py'])).not.toBe(gitQueryIdentity('/b', ['log', '--', 'x.py']));
    expect(gitQueryIdentity('/a', ['log', '--', 'x.py'])).not.toBe(gitQueryIdentity('/a', ['log', '--', 'y.py']));
    expect(gitQueryIdentity('/a', ['log', '--', 'x.py'])).toBe(gitQueryIdentity('/a', ['log', '--', 'x.py']));
  });
});

describe('同查询合并', () => {
  it('相同 (cwd,args) 并发查询共享一次子进程', async () => {
    const { spawn, calls } = makeSpawn();
    const gate = new GitQueryGate(undefined, { spawn });
    const p1 = gate.run(['log', '--', 'x.py'], runOpts());
    const p2 = gate.run(['log', '--', 'x.py'], runOpts());
    expect(calls).toHaveLength(1);
    calls[0].resolve(ok('one'));
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toEqual(ok('one'));
    expect(r2).toEqual(ok('one'));
  });

  it('排队中也合并:同键请求在等待期共享一次,不新增队列项', async () => {
    const { spawn, calls } = makeSpawn();
    const gate = new GitQueryGate({ maxConcurrent: 1 }, { spawn });
    const p1 = gate.run(['log', '--', 'a.py'], runOpts()); // 运行
    const p2 = gate.run(['log', '--', 'b.py'], runOpts()); // 排队
    expect(gate.queuedCount()).toBe(1);
    // 与排队请求同键 → 合并,队列项数不变,不新增 spawn。
    const p3 = gate.run(['log', '--', 'b.py'], runOpts());
    expect(calls).toHaveLength(1);
    expect(gate.queuedCount()).toBe(1);
    calls[0].resolve(ok('a'));
    // 释放后 b 启动(仍只有 1 次 spawn 给 b)。
    await p1;
    expect(calls).toHaveLength(2);
    expect(calls[1].args).toEqual(['log', '--', 'b.py']);
    calls[1].resolve(ok('b'));
    const [r2, r3] = await Promise.all([p2, p3]);
    expect(r2).toEqual(ok('b'));
    expect(r3).toEqual(ok('b'));
  });
});

describe('并发上限', () => {
  it('标准查询并发上限 2,第三个排队;释放后补位', async () => {
    const { spawn, calls } = makeSpawn();
    const gate = new GitQueryGate({ maxConcurrent: 2 }, { spawn });
    gate.run(['log', '--', 'a.py'], runOpts());
    gate.run(['log', '--', 'b.py'], runOpts());
    expect(gate.runningCount()).toBe(2);
    gate.run(['log', '--', 'c.py'], runOpts());
    expect(calls).toHaveLength(2);
    expect(gate.queuedCount()).toBe(1);
    calls[0].resolve(ok());
    await Promise.resolve();
    expect(gate.runningCount()).toBe(2); // b 仍在跑,c 已补位
    expect(calls).toHaveLength(3);
    expect(calls[2].args).toEqual(['log', '--', 'c.py']);
  });

  it('高成本范围追踪并发最多 1', async () => {
    const { spawn, calls } = makeSpawn();
    const gate = new GitQueryGate(undefined, { spawn });
    const rangeArgs = ['log', '-L', '1,5:a.py', '--', 'a.py'];
    const rangeArgs2 = ['log', '-L', '1,5:c.py', '--', 'c.py']; // 不同键,防去重
    gate.run(rangeArgs, runOpts());
    gate.run(['log', '--', 'b.py'], runOpts()); // 标准可并行
    gate.run(rangeArgs2, runOpts()); // 第二 range 排队
    expect(gate.runningCount()).toBe(2); // 1 range + 1 standard
    expect(gate.queuedCount()).toBe(1);
    calls[0].resolve(ok());
    await Promise.resolve();
    // 释放 range 槽后,排队 range 启动;standard 槽仍被 b 占用。
    expect(calls).toHaveLength(3);
    expect(calls[2].args).toEqual(rangeArgs2);
  });
});

describe('有界队列与拒绝', () => {
  it('队列满即拒绝新请求(spawn 结果),不无限堆积', async () => {
    const { spawn, calls } = makeSpawn();
    const gate = new GitQueryGate({ maxConcurrent: 1, maxQueue: 1 }, { spawn });
    gate.run(['log', '--', 'a.py'], runOpts()); // 运行
    gate.run(['log', '--', 'b.py'], runOpts()); // 排队 1(满)
    const rejected = await gate.run(['log', '--', 'c.py'], runOpts()); // 满 → 拒绝
    expect(rejected.kind).toBe('spawn');
    expect(calls).toHaveLength(1);
    expect(gate.queuedCount()).toBe(1);
    // 拒绝不占 pending:释放后仍可正常跑新查询。
    calls[0].resolve(ok()); // a 完成 → b 启动
    await Promise.resolve();
    expect(calls).toHaveLength(2);
    const p = gate.run(['log', '--', 'd.py'], runOpts()); // b 运行,d 排队
    expect(calls).toHaveLength(2);
    expect(gate.queuedCount()).toBe(1);
    calls[1].resolve(ok()); // b 完成 → d 启动
    await Promise.resolve();
    expect(calls).toHaveLength(3);
    expect(calls[2].args).toEqual(['log', '--', 'd.py']);
    calls[2].resolve(ok());
    expect((await p).kind).toBe('ok');
    expect(gate.runningCount()).toBe(0);
  });
});

describe('隔离缓存与上限', () => {
  it('相同查询第二次命中缓存,不重复 spawn', async () => {
    const { spawn, calls } = makeSpawn();
    const gate = new GitQueryGate(undefined, { spawn });
    const p1 = gate.run(['show', 'HEAD:x.py'], runOpts());
    calls[0].resolve(ok('content'));
    await p1;
    const p2 = gate.run(['show', 'HEAD:x.py'], runOpts());
    expect(calls).toHaveLength(1); // 未再 spawn
    expect(await p2).toEqual(ok('content'));
  });

  it('缓存按 cwd 与参数隔离(仓库/提交/路径/范围/选项)', async () => {
    const { spawn, calls } = makeSpawn();
    const gate = new GitQueryGate(undefined, { spawn });
    const p1 = gate.run(['show', 'HEAD:x.py'], runOpts('/a'));
    calls[0].resolve(ok('a'));
    await p1;
    // 同参数不同 cwd → 未命中,再 spawn。
    const p2 = gate.run(['show', 'HEAD:x.py'], runOpts('/b'));
    expect(calls).toHaveLength(2);
    calls[1].resolve(ok('b'));
    await p2;
    expect(gate.cacheCount()).toBe(2);
  });

  it('失败/超时/取消结果不缓存', async () => {
    const { spawn, calls } = makeSpawn();
    const gate = new GitQueryGate(undefined, { spawn });
    const p1 = gate.run(['log', '--', 'x.py'], runOpts());
    calls[0].resolve({ kind: 'exit', exitCode: 128, stderr: 'fatal' });
    await p1;
    expect(gate.cacheCount()).toBe(0);
    // 再次发起仍会 spawn(未缓存)。
    const p2 = gate.run(['log', '--', 'x.py'], runOpts());
    expect(calls).toHaveLength(2);
    calls[1].resolve(ok());
    await p2;
  });

  it('LRU 淘汰:超条目数逐最旧', async () => {
    const { spawn, calls } = makeSpawn();
    const gate = new GitQueryGate({ maxCacheEntries: 2 }, { spawn });
    for (const f of ['a.py', 'b.py', 'c.py']) {
      const p = gate.run(['show', `HEAD:${f}`], runOpts());
      calls.shift()!.resolve(ok(f));
      await p;
    }
    expect(gate.cacheCount()).toBe(2); // b,c 留存
    // a 已淘汰 → 重新 spawn。
    const pa = gate.run(['show', 'HEAD:a.py'], runOpts());
    expect(calls).toHaveLength(1);
    calls.shift()!.resolve(ok('a2'));
    await pa;
  });

  it('字节上限:超限逐最旧', async () => {
    const { spawn, calls } = makeSpawn();
    const gate = new GitQueryGate({ maxCacheBytes: 10 }, { spawn });
    // 每结果 6 字节;10 字节上限只容 1 条。
    const p1 = gate.run(['show', 'HEAD:a.py'], runOpts());
    calls.shift()!.resolve(ok('aaaaaa'));
    await p1;
    const p2 = gate.run(['show', 'HEAD:b.py'], runOpts());
    calls.shift()!.resolve(ok('bbbbbb'));
    await p2;
    expect(gate.cacheCount()).toBe(1); // b 留,a 逐出
  });

  it('显式刷新 bypassCache 重新获取但仍写回', async () => {
    const { spawn, calls } = makeSpawn();
    const gate = new GitQueryGate(undefined, { spawn });
    const p1 = gate.run(['log', '-n1', 'HEAD'], runOpts());
    calls.shift()!.resolve(ok('v1'));
    await p1;
    const p2 = gate.run(['log', '-n1', 'HEAD'], runOpts(), { bypassCache: true });
    expect(calls).toHaveLength(1); // 跳过读
    calls.shift()!.resolve(ok('v2'));
    const r2 = await p2;
    expect(r2).toEqual(ok('v2'));
    expect(gate.cacheCount()).toBe(1);
  });
});

describe('取消与清理', () => {
  const makeToken = (): { token: GitCancellationToken; cancel: () => void } => {
    const callbacks: Array<() => void> = [];
    const state = { cancelled: false };
    return {
      token: {
        get isCancellationRequested(): boolean {
          return state.cancelled;
        },
        onRequestCancel(cb: () => void) {
          callbacks.push(cb);
          return { dispose: () => {} };
        },
      },
      cancel: () => {
        state.cancelled = true;
        for (const cb of callbacks) cb();
      },
    };
  };

  it('调用方取消:运行中请求返回 cancelled,不残留子进程', async () => {
    const { spawn, calls } = makeSpawn();
    const gate = new GitQueryGate(undefined, { spawn });
    const { token, cancel } = makeToken();
    const p = gate.run(['log', '--', 'x.py'], { ...runOpts(), token });
    expect(calls).toHaveLength(1);
    // 取消令牌透传到 spawn(子进程可经 SIGKILL 终止)。
    cancel();
    const r = await p;
    expect(r.kind).toBe('cancelled');
    expect(gate.runningCount()).toBe(0);
  });

  it('预取消不启动子进程', async () => {
    const { spawn, calls } = makeSpawn();
    const gate = new GitQueryGate(undefined, { spawn });
    const { token, cancel } = makeToken();
    cancel();
    const r = await gate.run(['log', '--', 'x.py'], { ...runOpts(), token });
    expect(r.kind).toBe('cancelled');
    expect(calls).toHaveLength(0);
  });

  it('dispose 取消在途与排队并清缓存,后续 run 拒绝', async () => {
    const { spawn, calls } = makeSpawn();
    const gate = new GitQueryGate({ maxConcurrent: 1 }, { spawn });
    // 先填缓存:两独立查询依次结算(a 运行,b 排队→启动)。
    const p1 = gate.run(['show', 'HEAD:a.py'], runOpts());
    const p2 = gate.run(['show', 'HEAD:b.py'], runOpts());
    expect(calls).toHaveLength(1);
    calls[0].resolve(ok('a'));
    await p1;
    expect(calls).toHaveLength(2);
    calls[1].resolve(ok('b'));
    await p2;
    expect(gate.cacheCount()).toBe(2);

    // 再造在途与排队。
    const running = gate.run(['log', '--', 'r.py'], runOpts());
    expect(gate.runningCount()).toBe(1);
    const queued = gate.run(['log', '--', 'q.py'], runOpts());
    expect(gate.queuedCount()).toBe(1);

    gate.dispose();
    expect(gate.cacheCount()).toBe(0);
    expect(gate.queuedCount()).toBe(0);
    // 排队请求被取消结算。
    expect((await queued).kind).toBe('cancelled');
    // 在途请求经取消令牌结算。
    expect((await running).kind).toBe('cancelled');
    expect(gate.runningCount()).toBe(0);

    const after = await gate.run(['log', '--', 'c.py'], runOpts());
    expect(after.kind).toBe('spawn');
  });

  it('cancelAll(禁用配置):取消在途与排队并清缓存,门保持可用', async () => {
    const { spawn, calls } = makeSpawn();
    const gate = new GitQueryGate({ maxConcurrent: 2 }, { spawn });
    // 先填缓存:两独立查询结算。
    const p1 = gate.run(['show', 'HEAD:a.py'], runOpts());
    const p2 = gate.run(['show', 'HEAD:b.py'], runOpts());
    expect(calls).toHaveLength(2);
    calls[0].resolve(ok('a'));
    calls[1].resolve(ok('b'));
    await Promise.all([p1, p2]);
    expect(gate.cacheCount()).toBe(2);

    // 再造在途(x,y)+ 排队(z),触发 cancelAll(禁用配置)。
    const rx = gate.run(['log', '--', 'x.py'], runOpts());
    const ry = gate.run(['log', '--', 'y.py'], runOpts());
    const rz = gate.run(['log', '--', 'z.py'], runOpts());
    expect(calls).toHaveLength(4);
    expect(gate.queuedCount()).toBe(1);
    gate.cancelAll();
    expect(gate.cacheCount()).toBe(0);
    expect(gate.queuedCount()).toBe(0);
    expect((await rz).kind).toBe('cancelled'); // 排队 → 取消结算
    expect((await rx).kind).toBe('cancelled'); // 在途 → 经取消令牌终止
    expect((await ry).kind).toBe('cancelled');
    expect(gate.runningCount()).toBe(0);

    // 门保持可用:新查询照常受理(重新启用不失效)。
    const after = gate.run(['log', '--', 'w.py'], runOpts());
    expect(calls.length).toBeGreaterThan(4);
    calls[4].resolve(ok('w'));
    expect((await after).kind).toBe('ok');
  });

  it('dispose 幂等', async () => {
    const { spawn } = makeSpawn();
    const gate = new GitQueryGate({ maxConcurrent: 1 }, { spawn });
    gate.run(['log', '--', 'a.py'], runOpts());
    gate.run(['log', '--', 'b.py'], runOpts());
    gate.dispose();
    gate.dispose(); // 幂等
    expect(gate.queuedCount()).toBe(0);
  });
});

describe('默认限制与单例', () => {
  it('默认限制有界且符合验收', () => {
    const l = defaultGitQueryGateLimits();
    expect(l.maxConcurrent).toBe(2);
    expect(l.maxRangeConcurrent).toBe(1);
    expect(l.maxQueue).toBeGreaterThan(0);
    expect(l.maxCacheEntries).toBeGreaterThan(0);
    expect(l.maxCacheBytes).toBeGreaterThan(0);
  });
});
