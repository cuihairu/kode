import * as fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEF_PARSE_WORKER_MIN_BYTES } from '../src/defParserWorkerHost';
import { parseDefDocument } from '../src/defParser';

// IDE-REV-039:def 解析 worker host 直接测试(镜像 pythonParserWorkerHost.test.ts
// 的 FakeWorker 手法)——大文本走 worker、阈值下同步、崩溃/dispose/错误回包、
// 在途硬上限逐条锁行为面。真实 worker 入口(parseDefDocument 回传)由
// defParser 自身测试覆盖,此处 host 用可控 FakeWorker 隔离真线程。

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

type HostModule = typeof import('../src/defParserWorkerHost');

const loadHost = async (): Promise<HostModule> => {
  vi.resetModules();
  workerState.instances.length = 0;
  return import('../src/defParserWorkerHost');
};

const bigContent = 'x'.repeat(DEF_PARSE_WORKER_MIN_BYTES + 1);

afterEach(() => {
  workerState.existsProbe = undefined;
  vi.restoreAllMocks();
});

describe('defParserWorkerHost worker 路径(IDE-REV-039)', () => {
  beforeEach(() => {
    // vitest 下 __dirname 是 src/,产物 defParserWorker.js 不在——用探针放行
    // 走 worker 分支(与 CI 打包后行为同口径)。
    workerState.existsProbe = candidate => candidate.endsWith('defParserWorker.js');
  });

  it('超阈值文本走 worker:请求入线程,回包 document 原样透传', async () => {
    const host = await loadHost();
    const document = parseDefDocument('<root><Properties/></root>');
    const promise = host.parseDefDocumentResponsive(bigContent, 'entity');
    expect(workerState.instances).toHaveLength(1);
    const worker = workerState.instances[0];
    expect(worker.posted).toHaveLength(1);
    expect(typeof worker.posted[0].id).toBe('number');
    expect((worker.posted[0].text as string).length).toBe(bigContent.length);
    worker.emit('message', { id: worker.posted[0].id, document });
    await expect(promise).resolves.toBe(document); // 原对象透传,host 不改形
  });

  it('worker 崩溃:在途请求全部拒绝,后续请求重建新线程', async () => {
    const host = await loadHost();
    const first = host.parseDefDocumentResponsive(bigContent, 'a');
    const second = host.parseDefDocumentResponsive(bigContent, 'b');
    expect(workerState.instances).toHaveLength(1);
    workerState.instances[0].emit('error', new Error('worker crash'));
    await expect(first).rejects.toThrow('worker crash');
    await expect(second).rejects.toThrow('worker crash');

    const third = host.parseDefDocumentResponsive(bigContent, 'c');
    expect(workerState.instances).toHaveLength(2);
    const rebuilt = workerState.instances[1];
    const document = parseDefDocument('<root/>');
    rebuilt.emit('message', { id: rebuilt.posted[0].id, document });
    await expect(third).resolves.toBe(document);
  });

  it('线程异常退出(exit code)等同崩溃:在途拒绝并给出退出码', async () => {
    const host = await loadHost();
    const pending = host.parseDefDocumentResponsive(bigContent, 'a');
    workerState.instances[0].emit('exit', 1);
    await expect(pending).rejects.toThrow('exited (1)');
  });

  it('dispose:在途拒绝、线程终止、不再复用旧实例', async () => {
    const host = await loadHost();
    const pending = host.parseDefDocumentResponsive(bigContent, 'a');
    const worker = workerState.instances[0];
    host.disposeDefParserWorker();
    await expect(pending).rejects.toThrow('Def parser worker disposed');
    expect(worker.terminated).toBe(1);

    const next = host.parseDefDocumentResponsive(bigContent, 'b');
    expect(workerState.instances).toHaveLength(2);
    const rebuilt = workerState.instances[1];
    const document = parseDefDocument('<root/>');
    rebuilt.emit('message', { id: rebuilt.posted[0].id, document });
    await expect(next).resolves.toBe(document);
  });

  it('回包带 error 或空结果:拒绝并携带错误信息', async () => {
    const host = await loadHost();
    const failed = host.parseDefDocumentResponsive(bigContent, 'a');
    const empty = host.parseDefDocumentResponsive(bigContent, 'b');
    const worker = workerState.instances[0];
    worker.emit('message', { id: worker.posted[0].id, error: 'parse blew up' });
    worker.emit('message', { id: worker.posted[1].id });
    await expect(failed).rejects.toThrow('parse blew up');
    await expect(empty).rejects.toThrow('empty def parser result');
  });

  it('阈值以下文本走同步解析,不建线程;worker 产物缺失同样回退同步', async () => {
    // 产物缺失探针:existsSync 恒 false —— 回退同步解析,不建线程
    workerState.existsProbe = () => false;
    let host = await loadHost();
    const small = await host.parseDefDocumentResponsive('<root><Properties/></root>', 'e');
    expect(small.root?.name).toBe('root');
    expect(workerState.instances).toHaveLength(0);

    // 阈值以下但产物在:也走同步(阈值口径),不建线程
    host = await loadHost();
    await host.parseDefDocumentResponsive('<root><Properties/></root>', 'e');
    expect(workerState.instances).toHaveLength(0);
  });

  it('在途任务硬上限:超限新请求可解释拒绝,不再无限 post', async () => {
    const host = await loadHost();
    const outcomes: Array<Promise<string>> = [];
    for (let i = 0; i < 100; i += 1) {
      outcomes.push(host.parseDefDocumentResponsive(bigContent, `f${i}`)
        .then(() => 'ok', () => 'rejected'));
    }
    const worker = workerState.instances[0];
    expect(worker.posted.length).toBeLessThan(100);
    // 排干在途:回包全部已派发,让 allSettled 结算(超限者已即时拒绝)
    const document = parseDefDocument('<root/>');
    for (const message of worker.posted) {
      worker.emit('message', { id: message.id, document });
    }
    const settled = await Promise.allSettled(outcomes);
    // .then(, () => 'rejected') 把超限拒绝映射为 fulfilled 值 'rejected'(与
    // python host 测试同口径)——按值过滤,不能按 status==='rejected'。
    const rejected = settled.filter(outcome =>
      outcome.status === 'fulfilled' && outcome.value === 'rejected');
    expect(rejected.length).toBeGreaterThan(0);
    expect(host.getDefParserWorkerGauge().running).toBe(0);
  });

  it('不认识 id 的回包被忽略,不影响在途请求', async () => {
    const host = await loadHost();
    const pending = host.parseDefDocumentResponsive(bigContent, 'a');
    const worker = workerState.instances[0];
    worker.emit('message', { id: 99999, error: 'stale' });
    const document = parseDefDocument('<root/>');
    worker.emit('message', { id: worker.posted[0].id, document });
    await expect(pending).resolves.toBe(document);
  });

  it('量规:在途计数随派发/回包正确入账', async () => {
    const host = await loadHost();
    const pending = host.parseDefDocumentResponsive(bigContent, 'a');
    const gauge = host.getDefParserWorkerGauge();
    expect(gauge.running).toBe(1);
    const worker = workerState.instances[0];
    const document = parseDefDocument('<root/>');
    worker.emit('message', { id: worker.posted[0].id, document });
    await pending;
    expect(host.getDefParserWorkerGauge().running).toBe(0);
  });
});
