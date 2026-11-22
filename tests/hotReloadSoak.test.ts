// RUST-428(旧 HR-QA-016):24h Watch/HTTP soak——无 watcher 泄漏、状态增长无界、
// 连接泄漏、错误重试风暴。四项性质以**确定性不变量**钉住(load 无关,非墙钟),
// 是 24h 真跑应观测到的性质本身:高迭代计数下的
//   (1) watcher 泄漏:apply/rebuild/dispose 高循环,创建数恒=销毁数+存活,存活数
//       有界(==根数),dispose 后归零——重建不累积;
//   (2) 状态增长无界:台账按 (root×target×file) 键替换不逐事件追加,同一文件 K 次
//       操作后条目数恒 1;N 个不同文件=N(线性于文件数非操作数);历史库容量环形
//       淘汰(≤capacity)+requestId 幂等替换不重复成行;版本簿按文件有界;
//   (3) 连接泄漏:keepAlive 连接池(HR-HTTP-006/RUST-348)对同一引擎串行热更复用
//       连接——K 次串行请求经真实 defaultTransport,服务端 connection 计数恒 1
//       (复用,非逐请求新建),非 2xx 面亦复用不累积;
//   (4) 错误重试风暴:retryFailedHotReloadTargets 每次调用每失败目标恰发 1 次
//       (一次性,无放大),成功目标跳过,取消即停,二次调用只重发仍失败者。
// 诚实边界:①24h 墙钟 soak 非本车道目标(共享 runner 负载下墙钟噪声支配,见
//   RUST-425 判例),本车道钉不变量=soak 应观测的性质;②(3) 的 keepAlive 池是
//   单主机复用优化(懒建单例),跨不同主机连接数增长受 agent 池面约束,非本
//   soak 场景(单一引擎)范围;③(2) 的「无界」指逐事件增长,逐文件线性增长是
//   固有(文件数有界于工作区),如实记录。

import * as http from 'http';
import { afterEach, describe, expect, it } from 'vitest';

import { HotReloadDiskWatchController, type DiskWatcherHandle } from '../src/backend/hotReloadDiskWatch';
import { HotReloadTargetStateStore, buildHotReloadTargetKeyId, type HotReloadDeliveryOutcome } from '../src/backend/hotReloadTargetState';
import { HotReloadHistoryCore, type HotReloadHistoryStatus } from '../src/backend/hotReloadHistoryCore';
import { defaultTransport, type OutgoingHttpRequest } from '../src/backend/httpRequestService';
import { retryFailedHotReloadTargets, type HotReloadRetryDeps } from '../src/backend/hotReloadRetry';
import type { HotReloadBatchSummary } from '../src/backend/hotReloadBatchSummary';

const key = (targetId: string) => ({ rootId: '/ws', targetId });
const KEY = key('soak-target');
const FILE = '/ws/scripts/base/Avatar.py';

/* ------------------------------------------------------------------ */
/* (1) watcher 泄漏:高循环重建/停用不累积                                */
/* ------------------------------------------------------------------ */

const makeCountingWatcherFactory = (): {
  createWatcher: (pattern: string) => DiskWatcherHandle;
  created: () => number;
  disposed: () => number;
  live: () => number;
} => {
  let created = 0;
  let disposed = 0;
  const live = new Set<() => void>();
  return {
    createWatcher: (pattern: string): DiskWatcherHandle => {
      created += 1;
      let disposedFlag = false;
      const disposer = (): void => {
        if (!disposedFlag) {
          disposedFlag = true;
          disposed += 1;
        }
      };
      live.add(disposer);
      return {
        pattern,
        dispose: () => {
          disposer();
          live.delete(disposer);
        },
        onDidChange: () => {},
        onDidCreate: () => {},
        onDidDelete: () => {}
      };
    },
    created: () => created,
    disposed: () => disposed,
    live: () => live.size
  };
};

describe('RUST-428 soak(1):watcher 高循环不泄漏', () => {
  it('200 次 rebuild 循环:创建数恒=销毁数+存活,存活有界(==根数),dispose 归零', () => {
    const factory = makeCountingWatcherFactory();
    const controller = new HotReloadDiskWatchController({
      offer: () => {},
      createWatcher: factory.createWatcher,
      filterOptions: {}
    });
    const roots = ['/ws/scripts/base', '/ws/scripts/cell'];
    for (let i = 0; i < 200; i += 1) {
      controller.rebuild(roots);
      // 每轮重建后:旧 watcher 全销毁,存活=本轮根数(有界,不随循环累积)
      expect(factory.live()).toBe(roots.length);
      expect(factory.created() - factory.disposed()).toBe(factory.live());
      expect(controller.watchedPatterns()).toHaveLength(roots.length);
    }
    // 200 轮重建:创建=400,销毁=400(每轮销毁前一轮),存活=2
    expect(factory.created()).toBe(200 * roots.length);
    expect(factory.disposed()).toBe(200 * roots.length - roots.length);
    expect(factory.live()).toBe(roots.length);
    controller.dispose();
    expect(factory.live()).toBe(0);
    expect(factory.disposed()).toBe(factory.created());
    // dispose 幂等:二次调用无副作用
    controller.dispose();
    expect(factory.disposed()).toBe(factory.created());
  });

  it('停用后事件不再受理,watcher 全清不半态(dispose 后再 rebuild 无新 watcher)', () => {
    const factory = makeCountingWatcherFactory();
    const controller = new HotReloadDiskWatchController({
      offer: () => {},
      createWatcher: factory.createWatcher,
      filterOptions: {}
    });
    controller.watchRoots(['/ws']);
    controller.arm();
    expect(factory.live()).toBe(1);
    controller.dispose();
    expect(factory.live()).toBe(0);
    controller.rebuild(['/ws2']); // 已停用:不建
    expect(factory.live()).toBe(0);
    expect(controller.watchedPatterns()).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* (2) 状态增长无界:台账/历史库/版本簿逐事件有界                         */
/* ------------------------------------------------------------------ */

describe('RUST-428 soak(2):状态增长无界(逐事件不增长,逐文件线性)', () => {
  it('台账:同一文件 500 次操作后条目恒 1(键替换不逐事件追加),500 文件=500', () => {
    const store = new HotReloadTargetStateStore({ now: () => 1_000 });
    // 首次无 attempt(新建记录),后续带 attempt(回执写回路径,须匹配既有记录)
    store.record(KEY, FILE, 'sent-unverified', {});
    for (let i = 0; i < 500; i += 1) {
      store.record(KEY, FILE, i % 2 === 0 ? 'accepted' : 'applied', { attempt: 1 });
    }
    // 同一 (root×target×file):targetsWithRecords 恒 1 个目标,该目标下恒 1 文件
    expect(store.targetsWithRecords()).toHaveLength(1);
    expect(store.files(KEY)).toHaveLength(1);
    // 带 attempt 写回(回执路径)不新造记录,仍 1 文件
    store.record(KEY, FILE, 'applied', { attempt: 1, detail: 'receipt' });
    expect(store.files(KEY)).toHaveLength(1);
    // 500 个不同文件:线性于文件数(固有),非操作数
    for (let i = 0; i < 500; i += 1) {
      store.record(KEY, `/ws/f${i}.py`, 'sent-unverified', {});
    }
    expect(store.files(KEY)).toHaveLength(501);
    expect(store.targetsWithRecords()).toHaveLength(1);
    // 版本簿按文件有界
    expect(store.fileVersions().length).toBeLessThanOrEqual(501);
  });

  it('历史库:容量环形淘汰(≤capacity),requestId 幂等替换不重复成行', () => {
    const history = new HotReloadHistoryCore({ capacity: 50 });
    const mk = (id: string, status: HotReloadHistoryStatus, time: number) => ({
      requestId: id,
      fullModule: 'Avatar',
      requestModule: 'Avatar',
      fileUri: FILE,
      targetId: 'soak-target',
      time,
      status
    });
    // 同一 requestId 500 次:幂等替换,恒 1 行
    for (let i = 0; i < 500; i += 1) {
      history.record(mk('req-same', i % 2 === 0 ? 'failed' : 'applied', 1_000 + i));
    }
    expect(history.size()).toBe(1);
    // 500 个不同 requestId:容量淘汰,≤50
    for (let i = 0; i < 500; i += 1) {
      history.record(mk(`req-${i}`, 'sent-unverified', 2_000 + i));
    }
    expect(history.size()).toBeLessThanOrEqual(50);
    expect(history.size()).toBe(50); // 满容量(环形淘汰到上限)
    // 保留时间限额:maxAgeMs 淘汰早于窗口的行
    const aged = new HotReloadHistoryCore({ capacity: 200, maxAgeMs: 1000 });
    aged.record(mk('old', 'applied', 1_000));
    aged.record(mk('new', 'applied', 3_000));
    expect(aged.pruneExpired(3_500)).toBe(1);
    expect(aged.size()).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* (3) 连接泄漏:keepAlive 池串行复用,非逐请求新建                        */
/* ------------------------------------------------------------------ */

describe('RUST-428 soak(3):HTTP 连接池串行复用不泄漏', () => {
  let servers: http.Server[] = [];

  afterEach(async () => {
    for (const server of servers) {
      server.closeAllConnections?.();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
    servers = [];
  });

  const startSoakServer = (respond: (res: http.ServerResponse) => void): Promise<{ port: number; connections: () => number; requests: () => number }> =>
    new Promise(resolve => {
      let connections = 0;
      let requests = 0;
      const server = http.createServer((_req, res) => {
        requests += 1;
        respond(res);
      });
      server.on('connection', () => {
        connections += 1;
      });
      server.listen(0, '127.0.0.1', () => {
        servers.push(server);
        const address = server.address();
        const port = typeof address === 'object' && address !== null ? address.port : 0;
        resolve({ port, connections: () => connections, requests: () => requests });
      });
    });

  const send = (port: number, body: string): Promise<{ ok: boolean; status: number }> =>
    defaultTransport({
      url: `http://127.0.0.1:${port}/reload`,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      timeoutMs: 5000
    } as OutgoingHttpRequest);

  it('300 次串行成功发送:服务端 connection 计数恒 1(keepAlive 复用,非逐请求新建)', async () => {
    const server = await startSoakServer(res => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'applied', file: '/ws/A.py', digest: 'a'.repeat(64) }));
    });
    for (let i = 0; i < 300; i += 1) {
      const result = await send(server.port, '{"files":["/ws/A.py"]}');
      expect(result.ok).toBe(true);
      expect(result.status).toBe(200);
    }
    expect(server.requests()).toBe(300);
    // 连接复用:300 次请求只建 1 条连接(无逐请求新建/无累积)
    expect(server.connections()).toBe(1);
  });

  it('300 次串行非 2xx 发送:状态 500 如实呈现且连接仍复用不累积,连接计数恒 1', async () => {
    const server = await startSoakServer(res => {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('receiver error');
    });
    for (let i = 0; i < 300; i += 1) {
      const result = await send(server.port, '{"files":["/ws/A.py"]}');
      // 传输面 ok=true=已收到回包(500 响应也是「收到回包」,非 2xx 由投递面定 failed)
      expect(result.ok).toBe(true);
      expect(result.status).toBe(500);
    }
    expect(server.requests()).toBe(300);
    expect(server.connections()).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* (4) 错误重试风暴:每失败目标恰 1 次,无放大,取消即停                      */
/* ------------------------------------------------------------------ */

describe('RUST-428 soak(4):错误重试风暴(一次性,无放大)', () => {
  const makeSummary = (targets: Array<{ id: string; outcome: HotReloadDeliveryOutcome }>): HotReloadBatchSummary => ({
    status: targets.some(t => t.outcome === 'failed') ? 'partial' : 'all-succeeded',
    targets: targets.map(t => ({
      key: key(t.id),
      keyId: buildHotReloadTargetKeyId(key(t.id)),
      outcome: t.outcome,
      reason: '',
      files: []
    }))
  });

  it('2 失败+1 成功:恰发 2 次(每失败目标 1 次),成功目标跳过', async () => {
    const sent: string[] = [];
    const deps: HotReloadRetryDeps = {
      send: async target => {
        sent.push(buildHotReloadTargetKeyId(target));
        return { ok: true };
      },
      isCancelled: () => false
    };
    const actions = await retryFailedHotReloadTargets(
      makeSummary([
        { id: 'a', outcome: 'failed' },
        { id: 'b', outcome: 'failed' },
        { id: 'c', outcome: 'applied' }
      ]),
      deps
    );
    expect(actions.filter(a => a.action === 'resent')).toHaveLength(2);
    expect(actions.filter(a => a.action === 'skipped-confirmed')).toHaveLength(1);
    expect(sent).toHaveLength(2); // 无放大:每次调用每失败目标恰 1 次
    // keyId=rootId::targetId(台账稳定串形)
    expect(new Set(sent)).toEqual(new Set([buildHotReloadTargetKeyId(key('a')), buildHotReloadTargetKeyId(key('b'))]));
  });

  it('取消即停:后续不再发起(不冒充已发),已发保留', async () => {
    let cancelled = false;
    const sent: string[] = [];
    const deps: HotReloadRetryDeps = {
      send: async target => {
        sent.push(buildHotReloadTargetKeyId(target));
        cancelled = true; // 第一跳后取消
        return { ok: true };
      },
      isCancelled: () => cancelled
    };
    const actions = await retryFailedHotReloadTargets(
      makeSummary([
        { id: 'a', outcome: 'failed' },
        { id: 'b', outcome: 'failed' },
        { id: 'c', outcome: 'failed' }
      ]),
      deps
    );
    expect(sent).toHaveLength(1);
    expect(actions.filter(a => a.action === 'resent')).toHaveLength(1);
    expect(actions.filter(a => a.action === 'skipped-cancelled')).toHaveLength(2);
  });

  it('二次调用只重发仍失败者(不重发已成功侧,无风暴累积)', async () => {
    const sent: string[] = [];
    const failB = true;
    const deps: HotReloadRetryDeps = {
      send: async target => {
        sent.push(buildHotReloadTargetKeyId(target));
        return failB && buildHotReloadTargetKeyId(target) === buildHotReloadTargetKeyId(key('b'))
          ? { ok: false, detail: 'still down' }
          : { ok: true };
      },
      isCancelled: () => false
    };
    const first = await retryFailedHotReloadTargets(
      makeSummary([
        { id: 'a', outcome: 'failed' },
        { id: 'b', outcome: 'failed' }
      ]),
      deps
    );
    expect(first.filter(a => a.action === 'resent')).toHaveLength(2);
    // 第二轮:仅 b 仍失败 → 恰 1 次(a 成功侧跳过)
    const second = await retryFailedHotReloadTargets(
      makeSummary([
        { id: 'a', outcome: 'applied' },
        { id: 'b', outcome: 'failed' }
      ]),
      deps
    );
    expect(second.filter(a => a.action === 'resent')).toHaveLength(1);
    expect(second.filter(a => a.action === 'skipped-confirmed')).toHaveLength(1);
    expect(sent).toHaveLength(3); // 2 + 1,无风暴
  });
});
