import * as fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PYTHON_WORKER_PARSE_THRESHOLD } from '../src/pythonParserWorkerHost';

// worker host 直接测试(审核发现 :185):此前只有同步 parsePythonFile 有测试,
// 大文件 worker 路径、worker 崩溃(failPending)、dispose 停用、旧 revision 回包
// 均无直接覆盖。这里以可控行为的 FakeWorker 隔离真线程,逐条锁行为面。

const workerState = vi.hoisted(() => {
  return {
    instances: [] as Array<{
      file: string;
      posted: Array<Record<string, unknown>>;
      terminated: number;
      emit: (event: string, ...args: unknown[]) => boolean;
      terminate: () => Promise<number>;
    }>,
    existsProbe: undefined as undefined | ((candidate: string) => boolean)
  };
});

vi.mock('worker_threads', () => {
  // EventEmitter 在工厂内经 require 取 hoisted 安全形态
  const { EventEmitter } = require('events') as typeof import('events');
  class FakeWorker extends EventEmitter {
    readonly file: string;
    posted: Array<Record<string, unknown>> = [];
    terminated = 0;

    constructor(file: string) {
      super();
      this.file = file;
      workerState.instances.push(this);
    }

    unref(): void { /* 线程不阻塞进程退出:桩无需行为 */ }

    postMessage(message: Record<string, unknown>): void {
      this.posted.push(message);
    }

    terminate(): Promise<number> {
      this.terminated += 1;
      return Promise.resolve(0);
    }
  }
  return { Worker: FakeWorker };
});

vi.mock('fs', async importOriginal => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: (candidate: fs.PathLike) => {
      if (workerState.existsProbe) { return workerState.existsProbe(String(candidate)); }
      return actual.existsSync(candidate);
    },
    promises: actual.promises,
    default: actual
  };
});

type HostModule = typeof import('../src/pythonParserWorkerHost');

const loadHost = async (): Promise<HostModule> => {
  vi.resetModules();
  workerState.instances.length = 0;
  return import('../src/pythonParserWorkerHost');
};

const bigContent = 'x'.repeat(PYTHON_WORKER_PARSE_THRESHOLD + 1);

const parsedStub = {
  classes: [],
  imports: new Map(),
  instanceAssignments: []
} as unknown as import('../src/pythonParser').ParsedPythonFile;

afterEach(() => {
  workerState.existsProbe = undefined;
  vi.restoreAllMocks();
});

describe('pythonParserWorkerHost worker 路径(审核发现 :185)', () => {
  beforeEach(() => {
    // vitest 下 __dirname 是 src/,编译产物 pythonParserWorker.js 不在——
    // 用探针放行走 worker 分支(与 CI 打包后行为同口径)。
    workerState.existsProbe = candidate => candidate.endsWith('pythonParserWorker.js');
  });

  it('超阈值内容走 worker:请求入线程,回包 resolve 且 revision 原样透传', async () => {
    const host = await loadHost();
    const promise = host.parsePythonFileResponsive(bigContent, '/big.py', 7);
    expect(workerState.instances).toHaveLength(1);
    const worker = workerState.instances[0];
    expect(worker.posted).toHaveLength(1);
    expect(worker.posted[0]).toMatchObject({ filePath: '/big.py', revision: 7 });
    expect((worker.posted[0].content as string).length).toBe(bigContent.length);
    worker.emit('message', { id: worker.posted[0].id, revision: 7, parsed: parsedStub });
    await expect(promise).resolves.toEqual({ revision: 7, parsed: parsedStub });
  });

  it('旧 revision 回包原样上抛:调用方负责比对丢弃(host 不代吞)', async () => {
    const host = await loadHost();
    const promise = host.parsePythonFileResponsive(bigContent, '/big.py', 9);
    const worker = workerState.instances[0];
    // 回包 revision=3(过期):host 必须原样 resolve,由 updateFileResponsive
    // 的 revision 比对丢弃——测试锁「host 不代吞」的契约。
    worker.emit('message', { id: worker.posted[0].id, revision: 3, parsed: parsedStub });
    await expect(promise).resolves.toEqual({ revision: 3, parsed: parsedStub });
  });

  it('worker 崩溃:在途请求全部拒绝,后续请求重建新线程', async () => {
    const host = await loadHost();
    const first = host.parsePythonFileResponsive(bigContent, '/a.py', 1);
    const second = host.parsePythonFileResponsive(bigContent, '/b.py', 2);
    expect(workerState.instances).toHaveLength(1);
    workerState.instances[0].emit('error', new Error('worker crash'));
    await expect(first).rejects.toThrow('worker crash');
    await expect(second).rejects.toThrow('worker crash');

    // 崩溃后单例置空:下一次解析重建线程继续服务
    const third = host.parsePythonFileResponsive(bigContent, '/c.py', 3);
    expect(workerState.instances).toHaveLength(2);
    const rebuilt = workerState.instances[1];
    rebuilt.emit('message', { id: rebuilt.posted[0].id, revision: 3, parsed: parsedStub });
    await expect(third).resolves.toEqual({ revision: 3, parsed: parsedStub });
  });

  it('线程异常退出(exit code)等同崩溃:在途拒绝并给出退出码', async () => {
    const host = await loadHost();
    const pending = host.parsePythonFileResponsive(bigContent, '/a.py', 1);
    workerState.instances[0].emit('exit', 1);
    await expect(pending).rejects.toThrow('exited (1)');
  });

  it('dispose:在途拒绝、线程终止、不再复用旧实例', async () => {
    const host = await loadHost();
    const pending = host.parsePythonFileResponsive(bigContent, '/a.py', 1);
    const worker = workerState.instances[0];
    host.disposePythonParserWorker();
    await expect(pending).rejects.toThrow('Python parser worker disposed');
    expect(worker.terminated).toBe(1);
    // 停用后再请求:重建新线程,不触碰已 terminate 的旧实例
    const next = host.parsePythonFileResponsive(bigContent, '/b.py', 2);
    expect(workerState.instances).toHaveLength(2);
    const rebuilt = workerState.instances[1];
    rebuilt.emit('message', { id: rebuilt.posted[0].id, revision: 2, parsed: parsedStub });
    await expect(next).resolves.toEqual({ revision: 2, parsed: parsedStub });
  });

  it('回包带 error 或空结果:拒绝并携带错误信息', async () => {
    const host = await loadHost();
    const failed = host.parsePythonFileResponsive(bigContent, '/a.py', 1);
    const empty = host.parsePythonFileResponsive(bigContent, '/b.py', 2);
    const worker = workerState.instances[0];
    worker.emit('message', { id: worker.posted[0].id, revision: 1, error: 'parse blew up' });
    worker.emit('message', { id: worker.posted[1].id, revision: 2 });
    await expect(failed).rejects.toThrow('parse blew up');
    await expect(empty).rejects.toThrow('empty parser result');
  });

  it('快速提交 v1/v2/v3:未运行的旧版本不逐份派发(同文件合并,只发最新)', async () => {
    const host = await loadHost();
    const v1 = host.parsePythonFileResponsive(bigContent, '/burst.py', 1);
    const v2 = host.parsePythonFileResponsive(bigContent, '/burst.py', 2);
    const v3 = host.parsePythonFileResponsive(bigContent, '/burst.py', 3);
    const worker = workerState.instances[0];
    // 同文件:仅 v1 在途,未回包前不逐份派发 v2/v3(未运行的旧版本不解析)
    expect(worker.posted).toHaveLength(1);
    expect(worker.posted[0]).toMatchObject({ filePath: '/burst.py', revision: 1 });

    worker.emit('message', { id: worker.posted[0].id, revision: 1, parsed: parsedStub });
    await expect(v1).resolves.toEqual({ revision: 1, parsed: parsedStub });
    // v1 回包后只派发最新 v3(v2 未运行即被合并)
    expect(worker.posted).toHaveLength(2);
    expect(worker.posted[1]).toMatchObject({ filePath: '/burst.py', revision: 3 });
    worker.emit('message', { id: worker.posted[1].id, revision: 3, parsed: parsedStub });
    // v2/v3 以同一(最新)结果结算;v2 调用方按 revision 比对丢弃
    await expect(v2).resolves.toEqual({ revision: 3, parsed: parsedStub });
    await expect(v3).resolves.toEqual({ revision: 3, parsed: parsedStub });
    // 链尾收口:全部结算后无残留待派发
    expect(worker.posted).toHaveLength(2);
  });

  it('合并不跨文件:不同文件的在途任务各自即时派发', async () => {
    const host = await loadHost();
    const a = host.parsePythonFileResponsive(bigContent, '/a.py', 1);
    const b = host.parsePythonFileResponsive(bigContent, '/b.py', 2);
    const worker = workerState.instances[0];
    expect(worker.posted).toHaveLength(2);
    worker.emit('message', { id: worker.posted[0].id, revision: 1, parsed: parsedStub });
    worker.emit('message', { id: worker.posted[1].id, revision: 2, parsed: parsedStub });
    await expect(a).resolves.toMatchObject({ revision: 1 });
    await expect(b).resolves.toMatchObject({ revision: 2 });
  });

  it('在途+未派发最新并存时 worker 崩溃:两代等待者全部拒绝,后续请求重开新线程', async () => {
    const host = await loadHost();
    const v1 = host.parsePythonFileResponsive(bigContent, '/c.py', 1);
    const v2 = host.parsePythonFileResponsive(bigContent, '/c.py', 2);
    workerState.instances[0].emit('error', new Error('worker crash'));
    await expect(v1).rejects.toThrow('worker crash');
    await expect(v2).rejects.toThrow('worker crash');
    // 队列已清:重开同文件不受上一代残留影响
    const v3 = host.parsePythonFileResponsive(bigContent, '/c.py', 3);
    const rebuilt = workerState.instances[1];
    rebuilt.emit('message', { id: rebuilt.posted[0].id, revision: 3, parsed: parsedStub });
    await expect(v3).resolves.toEqual({ revision: 3, parsed: parsedStub });
  });

  it('待处理字节量有上限:积压超限的新请求可解释拒绝,未超限照常结算', async () => {
    const host = await loadHost();
    // 40 个文件各「一份在途 + 一份待派发」:每份 ≈256KB,累计越过 8MiB 上限
    const promises: Array<Promise<unknown>> = [];
    for (let i = 0; i < 40; i += 1) {
      const file = `/backlog/f${i}.py`;
      promises.push(host.parsePythonFileResponsive(bigContent, file, 1));
      promises.push(host.parsePythonFileResponsive(bigContent, file, 2));
    }
    // 逐个回包直至无在途(回包后链式派发待派发项)
    const worker = workerState.instances[0];
    let replied = 0;
    while (replied < worker.posted.length) {
      const message = worker.posted[replied];
      replied += 1;
      worker.emit('message', { id: message.id, revision: message.revision, parsed: parsedStub });
    }
    const outcomes = await Promise.allSettled(promises);
    const rejected = outcomes.filter(outcome => outcome.status === 'rejected') as
      Array<PromiseRejectedResult>;
    // 上限真实生效:超限的待派发请求不再无限保留源码串
    expect(rejected.length).toBeGreaterThan(0);
    for (const outcome of rejected) {
      // 可解释结果:拒绝原因明说字节积压上限
      expect(outcome.reason.message).toMatch(/backlog/i);
    }
    // 上限内的请求(在途首份)不受影响,照常成功结算
    const fulfilled = outcomes.filter(outcome => outcome.status === 'fulfilled');
    expect(fulfilled.length).toBeGreaterThan(0);
  });

  it('同文件合并不重复记账:同文件快速多版不累积旧版本字节(单文件反复编辑不触上限)', async () => {
    const host = await loadHost();
    const versions: Array<Promise<unknown>> = [];
    // 同一文件 60 版(旧实现逐份派发;合并链下每代只保留最新一份 ≈256KB)
    for (let revision = 1; revision <= 60; revision += 1) {
      versions.push(host.parsePythonFileResponsive(bigContent, '/solo.py', revision));
    }
    const worker = workerState.instances[0];
    expect(worker.posted).toHaveLength(1);
    // 只保留最新一版:回包后链式派发最终版,全部以最新结果结算
    worker.emit('message', { id: worker.posted[0].id, revision: 1, parsed: parsedStub });
    expect(worker.posted).toHaveLength(2);
    worker.emit('message', { id: worker.posted[1].id, revision: 60, parsed: parsedStub });
    const outcomes = await Promise.allSettled(versions);
    expect(outcomes.every(outcome => outcome.status === 'fulfilled')).toBe(true);
  });

  it('dispose 结清全部等待者:在途+待派发+被合并等待者一个不漏全部结算', async () => {
    const host = await loadHost();
    // 文件 A:一份在途;文件 B:在途 + 待派发(含被合并进 v3 的 v2 等待者)
    const a1 = host.parsePythonFileResponsive(bigContent, '/settle/a.py', 1);
    const b1 = host.parsePythonFileResponsive(bigContent, '/settle/b.py', 1);
    const b2 = host.parsePythonFileResponsive(bigContent, '/settle/b.py', 2);
    const b3 = host.parsePythonFileResponsive(bigContent, '/settle/b.py', 3);
    host.disposePythonParserWorker();
    // 全部在途 Promise 都结算(dispose 错误),不挂任何等待者
    await expect(a1).rejects.toThrow('Python parser worker disposed');
    await expect(b1).rejects.toThrow('Python parser worker disposed');
    await expect(b2).rejects.toThrow('Python parser worker disposed');
    await expect(b3).rejects.toThrow('Python parser worker disposed');
  });

  it('旧 worker 晚到回包/错误/退出不污染新实例:新任务只由新线程回包结算', async () => {
    const host = await loadHost();
    const old = host.parsePythonFileResponsive(bigContent, '/old.py', 1);
    const staleWorker = workerState.instances[0];
    host.disposePythonParserWorker();
    await expect(old).rejects.toThrow('Python parser worker disposed');

    // 新请求重建新线程;旧线程随后一切事件都不得影响新实例
    const fresh = host.parsePythonFileResponsive(bigContent, '/new.py', 2);
    expect(workerState.instances).toHaveLength(2);
    const freshWorker = workerState.instances[1];
    staleWorker.emit('message', {
      id: staleWorker.posted[0].id, revision: 1, parsed: parsedStub
    });
    staleWorker.emit('error', new Error('old worker zombie error'));
    staleWorker.emit('exit', 1);
    // 新任务仍在途(未被旧线程事件结算/拒绝)
    const stillPending = await Promise.race([
      fresh.then(() => 'settled', () => 'settled'),
      new Promise<string>(resolve => { setImmediate(() => resolve('pending')); })
    ]);
    expect(stillPending).toBe('pending');
    // 新线程正确回包后正常结算
    freshWorker.emit('message', { id: freshWorker.posted[0].id, revision: 2, parsed: parsedStub });
    await expect(fresh).resolves.toEqual({ revision: 2, parsed: parsedStub });
  });

  it('terminate 拒绝也不产生 unhandled rejection(dispose 全路径可解释收口)', async () => {
    const host = await loadHost();
    const pendingParse = host.parsePythonFileResponsive(bigContent, '/term.py', 1);
    const worker = workerState.instances[0];
    worker.terminate = (): Promise<number> => Promise.reject(new Error('terminate blew up'));
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      host.disposePythonParserWorker();
      await expect(pendingParse).rejects.toThrow('Python parser worker disposed');
      await new Promise(resolve => { setImmediate(resolve); });
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('不认识 id 的回包被忽略,不影响在途请求', async () => {
    const host = await loadHost();
    const pending = host.parsePythonFileResponsive(bigContent, '/a.py', 1);
    const worker = workerState.instances[0];
    worker.emit('message', { id: 99999, revision: 1, error: 'stale' });
    worker.emit('message', { id: worker.posted[0].id, revision: 1, parsed: parsedStub });
    await expect(pending).resolves.toEqual({ revision: 1, parsed: parsedStub });
  });

  it('阈值以下内容走同步解析,不建线程;worker 产物缺失同样回退同步', async () => {
    // 产物缺失探针:existsSync 恒 false —— 回退同步解析,不建线程
    workerState.existsProbe = () => false;
    let host = await loadHost();
    const small = await host.parsePythonFileResponsive('class A:\n    def m(self): pass\n', '/small.py', 1);
    expect(small.revision).toBe(1);
    expect(small.parsed.classes).toHaveLength(1);
    expect(workerState.instances).toHaveLength(0);

    // 阈值以下但产物在:也走同步(阈值口径),不建线程
    host = await loadHost();
    await host.parsePythonFileResponsive('class B:\n    pass\n', '/tiny.py', 1);
    expect(workerState.instances).toHaveLength(0);
  });
});
