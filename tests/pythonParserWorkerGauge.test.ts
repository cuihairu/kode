import * as fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PYTHON_WORKER_PARSE_THRESHOLD } from '../src/pythonParserWorkerHost';

// IDE-REV-030:解析 worker 队列与字节占用接入现场报告——挂起 worker
// (已派发不回包)、超预算排队(拒绝+峰值顶格)及恢复(排干)都能从量规
// 辨认;字节口径与 MAX_QUEUED_PARSE_BYTES 同源(源码串 length,不做额外
// 估算);实测面是 worker host 自身,不是 indexTasksQueued(索引任务层)。

const workerState = vi.hoisted(() => {
  return {
    instances: [] as Array<{
      posted: Array<Record<string, unknown>>;
      emit: (event: string, ...args: unknown[]) => boolean;
      terminate: () => Promise<number>;
    }>,
    existsProbe: undefined as undefined | ((candidate: string) => boolean)
  };
});

vi.mock('worker_threads', () => {
  const { EventEmitter } = require('events') as typeof import('events');
  class FakeWorker extends EventEmitter {
    posted: Array<Record<string, unknown>> = [];
    constructor() {
      super();
      workerState.instances.push(this);
    }
    unref(): void { /* 桩无需行为 */ }
    postMessage(message: Record<string, unknown>): void {
      this.posted.push(message);
    }
    terminate(): Promise<number> { return Promise.resolve(0); }
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

/** 回包所有已派发任务直至排干(链式派发的下一份也会被回包) */
const drainPosted = (host: HostModule): void => {
  const worker = workerState.instances[0];
  let replied = 0;
  while (replied < worker.posted.length) {
    const message = worker.posted[replied];
    replied += 1;
    worker.emit('message', { id: message.id, revision: message.revision, parsed: parsedStub });
  }
};

afterEach(() => {
  workerState.existsProbe = undefined;
  vi.restoreAllMocks();
});

describe('解析 worker 队列与字节占用(IDE-REV-030)', () => {
  beforeEach(() => {
    workerState.existsProbe = candidate => candidate.endsWith('pythonParserWorker.js');
  });

  it('挂起 worker 可辨认:已派发不回包时 running 持续可见,同文件待派发计入 queued/字节', async () => {
    const host = await loadHost();
    const a = host.parsePythonFileResponsive(bigContent, '/hang/a.py', 1);
    const b = host.parsePythonFileResponsive(bigContent, '/hang/b.py', 1);
    // 同文件第二版:未派发,保留源码串占字节
    const a2 = host.parsePythonFileResponsive(bigContent, '/hang/a.py', 2);
    // 挂起面:FakeWorker 收到消息但不回包——量规必须照实显示在途
    const hung = host.getPythonParserWorkerGauge();
    expect(hung.running).toBe(2);
    expect(hung.queued).toBe(1);
    expect(hung.queuedBytes).toBe(bigContent.length);
    expect(hung.maxQueuedBytes).toBe(8 * 1024 * 1024);

    drainPosted(host);
    await Promise.allSettled([a, b, a2]);
    const drained = host.getPythonParserWorkerGauge();
    expect(drained.running).toBe(0);
    expect(drained.queued).toBe(0);
    expect(drained.queuedBytes).toBe(0);
  });

  it('超预算排队可辨认:拒绝累计+排队字节顶格停在预算内,峰值=高水位', async () => {
    const host = await loadHost();
    host.resetPythonParserWorkerGaugeCountersForTests();
    const promises: Array<Promise<unknown>> = [];
    for (let i = 0; i < 40; i += 1) {
      const file = `/over/f${i}.py`;
      promises.push(host.parsePythonFileResponsive(bigContent, file, 1));
      promises.push(host.parsePythonFileResponsive(bigContent, file, 2));
    }
    const over = host.getPythonParserWorkerGauge();
    // AUD-022:首份任务也不绕过在途硬上限——16 份直接 post(数量顶格),
    // 其余首份转待派发排队,受 8MiB 字节预算约束。
    // 31 份待派发留在预算内(31×262145=8126495 ≤ 8MiB),第 32 份起拒绝;
    // 文件 32-40 各 2 笔(首份+次份)= 18 笔。
    expect(over.maxQueuedBytes).toBe(8 * 1024 * 1024);
    expect(over.running).toBe(16);
    expect(over.running).toBeLessThanOrEqual(over.maxPostedJobs);
    expect(over.postedBytes).toBe(16 * bigContent.length);
    expect(over.postedBytes).toBeLessThanOrEqual(over.maxPostedBytes);
    expect(over.queued).toBe(31);
    expect(over.queuedBytes).toBe(31 * bigContent.length);
    expect(over.queuedBytes).toBeLessThanOrEqual(over.maxQueuedBytes);
    expect(over.budgetRejects).toBe(18);
    expect(over.peakQueuedBytes).toBe(over.queuedBytes);

    // 18 笔拒绝立即结算(可解释错误);在途/待派发部分回包后结算
    drainPosted(host);
    const settled = await Promise.allSettled(promises);
    const rejected = settled.filter(o => o.status === 'rejected');
    expect(rejected).toHaveLength(18);
    const recoveredAll = host.getPythonParserWorkerGauge();
    expect(recoveredAll.running).toBe(0);
    expect(recoveredAll.queued).toBe(0);
    expect(recoveredAll.queuedBytes).toBe(0);
    expect(recoveredAll.postedBytes).toBe(0);
    expect(recoveredAll.budgetRejects).toBe(18);
    expect(recoveredAll.peakQueuedBytes).toBe(31 * bigContent.length);
  });

  it('恢复可辨认:排干后 queued/字节归零,峰值与拒绝计数保留(积压史不抹)', async () => {
    const host = await loadHost();
    const a = host.parsePythonFileResponsive(bigContent, '/rec/a.py', 1);
    const a2 = host.parsePythonFileResponsive(bigContent, '/rec/a.py', 2);
    expect(host.getPythonParserWorkerGauge().peakQueuedBytes).toBe(bigContent.length);
    drainPosted(host);
    await Promise.allSettled([a, a2]);
    const recovered = host.getPythonParserWorkerGauge();
    expect(recovered.running).toBe(0);
    expect(recovered.queued).toBe(0);
    expect(recovered.queuedBytes).toBe(0);
    // 峰值不随排干回落:报告仍能辨认此前积压到过多高
    expect(recovered.peakQueuedBytes).toBe(bigContent.length);
  });

  it('同文件顶替不虚增峰值:旧版字节先释放再记新版,峰值=单份而非两份', async () => {
    const host = await loadHost();
    const v1 = host.parsePythonFileResponsive(bigContent, '/sup/x.py', 1);
    const v2 = host.parsePythonFileResponsive(bigContent, '/sup/x.py', 2);
    const v3 = host.parsePythonFileResponsive(bigContent, '/sup/x.py', 3);
    const gauge = host.getPythonParserWorkerGauge();
    expect(gauge.queued).toBe(1);
    expect(gauge.queuedBytes).toBe(bigContent.length);
    expect(gauge.peakQueuedBytes).toBe(bigContent.length);
    drainPosted(host);
    await Promise.allSettled([v1, v2, v3]);
  });

  it('源锁:现场报告两处接入 worker 量规,渲染面带排队字节/预算/峰值;不用 indexTasksQueued 代替', async () => {
    const extension = await fs.promises.readFile('src/extension.ts', 'utf8');
    expect(extension.split('worker: getPythonParserWorkerGauge()').length).toBe(3);
    expect(extension).toContain('getPythonParserWorkerGauge } from');
    const summary = await fs.promises.readFile('src/reproductionSummary.ts', 'utf8');
    expect(summary).toContain('worker=运行');
    expect(summary).toContain('worker排队字节=');
    expect(summary).toContain('/预算');
    expect(summary).toContain('/峰值');
    expect(summary).toContain('/超预算拒');
    // 口径锁:字节与 MAX_QUEUED_PARSE_BYTES 同源,不做第二套估算
    const host = await fs.promises.readFile('src/pythonParserWorkerHost.ts', 'utf8');
    expect(host).toContain('maxQueuedBytes: MAX_QUEUED_PARSE_BYTES');
  });
});
