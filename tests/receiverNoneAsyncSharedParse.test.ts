import * as fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  disposePythonParserWorker,
  PYTHON_WORKER_PARSE_THRESHOLD
} from '../src/pythonParserWorkerHost';
import type { ParsedPythonFile } from '../src/pythonParser';
import { DiagnosticScheduler } from '../src/diagnosticScheduler';
import { PythonClassIndex } from '../src/pythonClassIndex';
import {
  computeReceiverNoneFindings,
  receiverNoneDiagnosticItemsAsync
} from '../src/receiverNoneDiagnostics';
import {
  getOperationSummary,
  resetLanguageServiceMetrics
} from '../src/languageServiceMetrics';
import { makeTextDocument } from './fake-vscode/core';

// IDE-REV-009:receiver 异步诊断入口不吃整文件同步解析——
// ① >256KiB 真实入口:解析走 worker(宿主零 parsePythonFile 调用),计算期间
//   记录最大宿主阻塞(定时器延迟采样),且采样落在解析等待中段(不是只在
//   末尾证明定时器曾运行);
// ② 版本共享:asyncDocumentParse 与类索引/同步面同版本消费同一份解析
//   (同对象零重解);
// ③ 旧回包丢弃:解析在途期间版本前进,本轮中止返回 null,调度器不发布。

const workerState = vi.hoisted(() => {
  return {
    instances: [] as Array<{
      posted: Array<Record<string, unknown>>;
      emit: (event: string, ...args: unknown[]) => boolean;
      terminated: number;
    }>,
    existsProbe: undefined as undefined | ((candidate: string) => boolean),
    hostParseCalls: 0
  };
});

vi.mock('worker_threads', () => {
  // 最小事件面自持(不引 events,测试目录 eslint 门禁禁 require):on/emit
  // 只服务测试手动回包,语义与 EventEmitter 足够同构
  class FakeWorker {
    private handlers = new Map<string, Array<(...args: unknown[]) => void>>();
    posted: Array<Record<string, unknown>> = [];
    terminated = 0;

    constructor(file: string) {
      void file;
      workerState.instances.push(this);
    }

    unref(): void { /* 线程不阻塞进程退出:桩无需行为 */ }

    on(event: string, handler: (...args: unknown[]) => void): void {
      const list = this.handlers.get(event) ?? [];
      list.push(handler);
      this.handlers.set(event, list);
    }

    emit(event: string, ...args: unknown[]): boolean {
      for (const handler of this.handlers.get(event) ?? []) { handler(...args); }
      return (this.handlers.get(event) ?? []).length > 0;
    }

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

// 宿主侧 parsePythonFile 调用计数:>256KiB 异步入口必须为零(worker 面算
// 测试线程代行,预先算好不入账)
vi.mock('../src/pythonParser', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/pythonParser')>();
  return {
    ...actual,
    parsePythonFile: (content: string, filePath: string): ParsedPythonFile => {
      workerState.hostParseCalls += 1;
      return actual.parsePythonFile(content, filePath);
    }
  };
});

const actualParser = async (): Promise<NonNullable<typeof import('../src/pythonParser')>> =>
  vi.importActual<typeof import('../src/pythonParser')>('../src/pythonParser');
const latestWorker = () => workerState.instances[workerState.instances.length - 1];

/** >256KiB 且有 receiver 调用的样本:行尾注释垫字节,调用数适中(guard 扫描一趟) */
function oversizeSource(calls: number): string {
  const lines: string[] = ['class Avatar(Base):', '    def tick(self):'];
  const pad = 'x'.repeat(48);
  for (let i = 0; i < calls; i += 1) {
    lines.push(`        self.cell.m${i}()  # ${pad}`);
  }
  lines.push('');
  return lines.join('\n');
}

interface MutableDoc {
  uri: { toString(): string };
  version: number;
}

const parseCount = (): number => getOperationSummary('document-parse')?.count ?? 0;

afterEach(() => {
  disposePythonParserWorker();
  workerState.existsProbe = undefined;
  workerState.hostParseCalls = 0;
  resetLanguageServiceMetrics();
  vi.restoreAllMocks();
});

beforeEach(() => {
  // vitest 下 __dirname 是 src/,编译产物不在——探针放行 worker 分支
  workerState.existsProbe = candidate => candidate.endsWith('pythonParserWorker.js');
});

describe('IDE-REV-009:超阈值入口解析走 worker,宿主零整文件同步解析', () => {
  it('>256KiB 真实入口:worker 派发+宿主零 parsePythonFile+产出与同步面一致+中段宿主可响应', async () => {
    const realParser = await actualParser();
    const text = oversizeSource(4200);
    expect(text.length).toBeGreaterThan(PYTHON_WORKER_PARSE_THRESHOLD);

    // 基准:同步面产出(宿主解析,此处允许)+ worker 侧应有的解析结果(预计算,
    // 计数清零后不再入账)
    const syncFindings = computeReceiverNoneFindings(text, '/ws/big.py');
    expect(syncFindings.length).toBe(4200);
    const workerParsed = realParser.parsePythonFile(text, '/ws/big.py');
    workerState.hostParseCalls = 0;

    // 宿主阻塞采样:10ms 间隔定时器,记录每次实际触发相对预期的延迟
    const latencies: number[] = [];
    let expectedAt = Date.now();
    let sampling = true;
    const sampler = setInterval(() => {
      const now = Date.now();
      latencies.push(now - expectedAt - 10);
      expectedAt = now;
    }, 10);

    const entry = receiverNoneDiagnosticItemsAsync(text, '/ws/big.py', undefined, true);
    // 解析在途(worker 回包未发):等待至少 3 个采样点,证明解析等待中段宿主
    // 仍在响应定时器——不是只在末尾证明定时器曾运行
    const midFlightDeadline = Date.now() + 500;
    while (latencies.length < 3 && Date.now() < midFlightDeadline) {
      await new Promise(resolve => { setTimeout(resolve, 5); });
    }
    expect(latencies.length).toBeGreaterThanOrEqual(3); // 中段采样在案
    const midFlightMax = Math.max(...latencies);

    const worker = latestWorker();
    expect(worker.posted.length).toBe(1); // 解析确实派发进线程
    expect(worker.posted[0].filePath).toBe('/ws/big.py');
    worker.emit('message', {
      id: worker.posted[0].id, revision: worker.posted[0].revision, parsed: workerParsed
    });

    const items = await entry;
    sampling = false;
    clearInterval(sampler);
    void sampling;

    expect(items).not.toBeNull();
    expect(items!.length).toBe(syncFindings.length); // 与同步面产出逐项一致
    expect(workerState.hostParseCalls).toBe(0); // 宿主零整文件同步解析(修复前红:同步自解析≥1)
    const maxBlock = Math.max(...latencies);
    expect(maxBlock, `max host block ${maxBlock}ms (mid-flight max ${midFlightMax}ms)`).toBeLessThan(100);
  });

  it('无共享提供器默认自解析同样走 worker(层2 关闭口径),小文件阈值下仍宿主同步', async () => {
    const realParser = await actualParser();

    // 小文件(<256KiB,无提供器):阈值口径=宿主同步解析,行为与既有同步面一致
    workerState.hostParseCalls = 0;
    const instancesBefore = workerState.instances.length;
    const small = 'class A(Base):\n    def f(self):\n        self.client.g()\n';
    const smallItems = await receiverNoneDiagnosticItemsAsync(small, '/ws/s.py', undefined, true);
    expect(smallItems!.some(item => item.code === 'kbengine.receiverNone')).toBe(true);
    expect(workerState.hostParseCalls).toBe(1);
    expect(workerState.instances.length).toBe(instancesBefore); // 阈值下不建新线程

    // 大文件自解析(>256KiB):默认面也进 worker,宿主零同步解析
    const text = oversizeSource(4200);
    const workerParsed = realParser.parsePythonFile(text, '/ws/big2.py');
    workerState.hostParseCalls = 0;
    const entry = receiverNoneDiagnosticItemsAsync(text, '/ws/big2.py', undefined, true);
    const worker = latestWorker();
    expect(worker.posted.length).toBe(1);
    worker.emit('message', {
      id: worker.posted[0].id, revision: worker.posted[0].revision, parsed: workerParsed
    });
    const items = await entry;
    expect(items!.length).toBe(4200);
    expect(workerState.hostParseCalls).toBe(0);
  });
});

describe('IDE-REV-009:asyncDocumentParse 版本共享', () => {
  it('与类索引/同步面同版本消费同一份解析:同对象零重解,防抖补喂零解析', async () => {
    const source = 'class Avatar(Base):\n    def onClientDeath(self):\n        self.client.leaveSpace()\n';
    const index = new PythonClassIndex();
    const document = makeTextDocument(source, {
      fileName: '/ws/shared/avatar.py', languageId: 'python', version: 3
    });

    const first = await index.asyncDocumentParse(document);
    expect(first).toBeTruthy();
    expect(parseCount()).toBe(1);

    // 同版本再取:同对象,零解析(缓存命中直取)
    const second = await index.asyncDocumentParse(document);
    expect(second).toBe(first);
    expect(parseCount()).toBe(1);

    // 类索引防抖补喂同版本命中:零解析(DIA-003 异步面同享)
    await index.onDocumentChanged(document as never);
    expect(parseCount()).toBe(1);

    // 同步面同版本命中:同对象零解析(跨面共享)
    expect(index.syncDocumentParse(document)).toBe(first);
    expect(parseCount()).toBe(1);

    // 诊断消费该解析:guard 分析完整可用
    const findings = computeReceiverNoneFindings(source, '/ws/shared/avatar.py', undefined, first!);
    expect(findings.some(finding => finding.kind === 'receiver-none')).toBe(true);
    expect(parseCount()).toBe(1);
  });

  it('>256KiB 经 worker 提交入版本键缓存:读回同对象,二次取零派发零解析', async () => {
    const realParser = await actualParser();
    const text = oversizeSource(4200);
    const workerParsed = realParser.parsePythonFile(text, '/ws/big3.py');
    const index = new PythonClassIndex();
    const document = makeTextDocument(text, {
      fileName: '/ws/big3.py', languageId: 'python', version: 11
    });

    workerState.hostParseCalls = 0;
    const pending = index.asyncDocumentParse(document);
    const worker = latestWorker();
    expect(worker.posted.length).toBe(1);
    expect(worker.posted[0]).toMatchObject({ filePath: '/ws/big3.py', revision: 1 });
    worker.emit('message', { id: worker.posted[0].id, revision: 1, parsed: workerParsed });
    const committed = await pending;
    expect(committed).toBe(workerParsed); // worker 产物原对象入账
    expect(workerState.hostParseCalls).toBe(0); // 宿主零同步解析
    expect(index.getParsedForVersion('/ws/big3.py', 11)).toBe(workerParsed);

    // 二次取:缓存命中直取,零派发零解析
    const again = await index.asyncDocumentParse(document);
    expect(again).toBe(workerParsed);
    expect(worker.posted.length).toBe(1);
    expect(workerState.hostParseCalls).toBe(0);
  });
});

describe('IDE-REV-009:解析在途版本前进,旧回包丢弃', () => {
  it('调度器真实入口:worker 解析在途版本前进→本轮 null 不发布,staleDropped 记账', async () => {
    const realParser = await actualParser();
    const text = oversizeSource(4200);
    const workerParsed = realParser.parsePythonFile(text, '/ws/race.py');

    const index = new PythonClassIndex();
    const mutable = { version: 1 };
    const document = makeTextDocument(text, {
      fileName: '/ws/race.py', languageId: 'python', version: 1
    });
    // 调度器看到的文档版本可变(模拟编辑前进),解析面用固定文本
    const scheduledDoc: MutableDoc = {
      uri: { toString: () => 'file:///ws/race.py' }, version: mutable.version
    };
    Object.defineProperty(scheduledDoc, 'version', {
      get: () => mutable.version
    });

    const scheduler = new DiagnosticScheduler();
    const published: unknown[][] = [];
    const capturedVersion = scheduledDoc.version;

    scheduler.requestQueued(scheduledDoc as never, {
      layer: 'local',
      computeAsync: async () => receiverNoneDiagnosticItemsAsync(
        text,
        '/ws/race.py',
        undefined,
        true,
        async () => index.asyncDocumentParse(document),
        {
          shouldContinue: () =>
            capturedVersion === undefined || scheduledDoc.version === capturedVersion
        }
      ),
      publish: items => { published.push([...items]); }
    });
    scheduler.flushQueued();

    // 解析在途:worker 已派发未回包
    const worker = latestWorker();
    expect(worker.posted.length).toBe(1);
    mutable.version = 2; // 版本前进(编辑发生)

    worker.emit('message', { id: worker.posted[0].id, revision: 1, parsed: workerParsed });
    await scheduler.pendingComputations();

    expect(published).toEqual([]); // 旧版本回包丢弃,不发布
    expect(scheduler.getStats().staleDropped).toBe(1);
    expect(scheduler.getStats().published).toBe(0);
  });
});
