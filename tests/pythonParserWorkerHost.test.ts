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
