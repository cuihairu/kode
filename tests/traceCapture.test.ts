import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { TraceCaptureController, type RawTraceEvent } from '../src/backend/traceCaptureController';
import { buildCollectorArgs, runControlledCapture } from '../src/backend/traceCaptureRun';
import type { TraceCallEvent, TraceExceptionEvent, TraceReturnEvent } from '../src/backend/traceEventModel';

// FLOW-025 受控采集验收:「独立可关闭的采集入口和有界缓冲,记录开始/结束/
// 异常/丢弃;不默认开启高开销全量 trace。」四条产品面各有钉:
//   默认关闭 —— 构造即 idle,ingest 拒收,采集只因显式 start() 发生;
//   有界缓冲 —— maxEvents 打满只计丢弃(buffer-full),丢异数入 loss 对账;
//   开始/结束 —— startedAtEpochMs/stoppedAtEpochMs/endReason 记账入 raw.meta;
//   异常/丢弃 —— exception 事件计数+协议红线全走 FLOW-024 导入面(不自带
//   宽松规则);运行面超时 kill(可关闭红线),命令行组装注入可测。

const REPO_ROOT = path.resolve(__dirname, '..');

const callEvent = (seq: number, fn: string, parentSeq: number | null, ts: number): RawTraceEvent => ({
  kind: 'call',
  timestamp: ts,
  processId: 'py-1',
  threadId: 'MainThread',
  entityId: null,
  frame: {
    file: path.join('tests', 'fixtures', 'trace', 'workload_login.py'),
    line: 11,
    function: fn,
    className: 'Account'
  },
  parentSeq
});
const returnEvent = (ts: number, unwound = false): RawTraceEvent => ({
  kind: 'return',
  timestamp: ts,
  processId: 'py-1',
  threadId: 'MainThread',
  entityId: null,
  unwound
});
const exceptionEvent = (atSeq: number, ts: number): RawTraceEvent => ({
  kind: 'exception',
  timestamp: ts,
  processId: 'py-1',
  threadId: 'MainThread',
  entityId: null,
  atSeq,
  exceptionType: 'KeyError',
  message: "'hero'",
  propagated: true
});

const makeController = (maxEvents = 100) =>
  new TraceCaptureController({
    sessionId: 'capture-t',
    maxEvents,
    processId: 'py-1',
    threadId: 'MainThread',
    windowNote: '受控窗口测试声明',
    startedAtEpochMs: 1000
  });

describe('traceCaptureController: 默认关闭与显式启停(FLOW-025)', () => {
  it('构造后默认关闭:ingest 拒收,采集只因显式 start() 发生', () => {
    const controller = makeController();
    expect(controller.state).toBe('idle');
    expect(() => controller.ingest(callEvent(0, 'main', null, 1))).toThrow(/不默认开启/);
    expect(controller.accounting().bufferedEvents).toBe(0);
  });

  it('启停状态机:start 只一次;stop 前须 start;窗口外 ingest 拒收', () => {
    const controller = makeController();
    expect(() => controller.stop()).toThrow(/stop 只在采集窗口内/);
    controller.start();
    expect(() => controller.start()).toThrow(/start 只允许一次/);
    controller.ingest(callEvent(0, 'main', null, 1));
    const result = controller.stop();
    expect(controller.state).toBe('stopped');
    expect(() => controller.ingest(returnEvent(2))).toThrow(/未在采集窗口内/);
    // 关窗后事件仍在缓冲(关窗前的采集是真实发生的)
    expect(result.accounting.bufferedEvents).toBe(1);
  });

  it('fail(reason) 收口:state=failed、endReason=collector-error,已缓冲事件如实保留', () => {
    const controller = makeController();
    controller.start();
    controller.ingest(callEvent(0, 'main', null, 1));
    const result = controller.fail('collector crashed mid-window');
    expect(controller.state).toBe('failed');
    expect(result.accounting.endReason).toBe('collector-error');
    expect(result.accounting.endNote).toBe('collector crashed mid-window');
    // 已缓冲的真实数据不丢
    expect(result.session.events).toHaveLength(1);
    expect(result.raw.meta.endReason).toBe('collector-error');
  });
});

describe('traceCaptureController: 有界缓冲与丢弃记账(FLOW-025)', () => {
  it('maxEvents 打满:后续事件不入缓冲只计丢弃,loss 对账一致', () => {
    const controller = makeController(5);
    controller.start();
    const outcomes = [];
    for (let i = 0; i < 8; i++) {
      outcomes.push(controller.ingest(callEvent(i, `fn${i}`, null, i + 1)));
    }
    expect(outcomes.filter(outcome => outcome.accepted)).toHaveLength(5);
    expect(outcomes.filter(outcome => !outcome.accepted)).toHaveLength(3);
    const result = controller.stop();
    expect(result.accounting.droppedBufferFull).toBe(3);
    expect(result.session.events).toHaveLength(5);
    expect(result.session.loss.totalDropped).toBe(3);
    expect(result.session.loss.drops[0].reason).toBe('buffer-full');
    expect(result.session.loss.drops[0].note).toContain('max-events=5');
  });

  it('maxEvents<1 与缺窗口声明构造即拒(无界缓冲/无窗口不交付)', () => {
    expect(
      () =>
        new TraceCaptureController({
          sessionId: 't',
          maxEvents: 0,
          processId: 'py-1',
          threadId: 'MainThread',
          windowNote: 'w'
        })
    ).toThrow(/有界/);
    expect(
      () =>
        new TraceCaptureController({
          sessionId: 't',
          maxEvents: 10,
          processId: 'py-1',
          threadId: 'MainThread',
          windowNote: ''
        })
    ).toThrow(/窗口/);
  });
});

describe('traceCaptureController: 开始/结束/异常记账与红线委派(FLOW-025)', () => {
  it('开始/结束记账入 raw.meta(startedAt 注入;endedAt≥startedAt;endReason=completed)', () => {
    const controller = makeController();
    controller.start();
    const result = controller.stop();
    expect(result.accounting.startedAtEpochMs).toBe(1000);
    expect(result.accounting.endedAtEpochMs).toBeGreaterThanOrEqual(1000);
    expect(result.accounting.endReason).toBe('completed');
    expect(result.raw.meta.startedAtEpochMs).toBe(1000);
    expect(result.raw.meta.stoppedAtEpochMs).toBe(result.accounting.endedAtEpochMs);
    expect(result.raw.meta.endReason).toBe('completed');
  });

  it('异常事件计数+落会话:return 括号配对与 unwind 注记由导入面完成', () => {
    const controller = makeController();
    controller.start();
    controller.ingest(callEvent(0, 'main', null, 1));
    controller.ingest(callEvent(1, 'loadAccount', 0, 2));
    controller.ingest(exceptionEvent(1, 3));
    controller.ingest(returnEvent(4, true));
    controller.ingest(returnEvent(5));
    const result = controller.stop();
    expect(result.accounting.calls).toBe(2);
    expect(result.accounting.returns).toBe(2);
    expect(result.accounting.exceptions).toBe(1);
    const exceptions = result.session.events.filter(
      (event): event is TraceExceptionEvent => event.kind === 'exception'
    );
    expect(exceptions).toHaveLength(1);
    expect(exceptions[0].atSeq).toBe(1);
    expect(exceptions[0].propagated).toBe(true);
    const returns = result.session.events.filter(
      (event): event is TraceReturnEvent => event.kind === 'return'
    );
    const unwound = returns.find(ret => ret.correspondsToCallSeq === 1);
    expect(unwound!.returnValueNote).toContain('PY_UNWIND');
  });

  it('红线委派:事件带未登记进程时 close 经导入面如实抛错(控制器不自带宽松规则)', () => {
    const controller = makeController();
    controller.start();
    controller.ingest({ ...callEvent(0, 'main', null, 1), processId: 'other-proc' });
    expect(() => controller.stop()).toThrow(/未登记进程/);
  });

  it('完整合成登录流过协议:parentSeq 链+return 多重集配对', () => {
    const controller = makeController();
    controller.start();
    controller.ingest(callEvent(0, 'main', null, 1));
    controller.ingest(callEvent(1, 'onClientEnabled', 0, 2));
    controller.ingest(callEvent(2, 'buildLoginMsg', 1, 3));
    controller.ingest(returnEvent(4));
    controller.ingest(returnEvent(5));
    controller.ingest(returnEvent(6));
    const result = controller.stop();
    const calls = result.session.events.filter(
      (event): event is TraceCallEvent => event.kind === 'call'
    );
    expect(calls.map(call => call.parentSeq)).toEqual([null, 0, 1]);
    const returns = result.session.events.filter(
      (event): event is TraceReturnEvent => event.kind === 'return'
    );
    expect([...returns.map(ret => ret.correspondsToCallSeq)].sort((a, b) => a - b)).toEqual([0, 1, 2]);
  });
});

describe('traceCaptureRun: 命令行组装与子进程交互(FLOW-025)', () => {
  it('buildCollectorArgs:无空格 token 口径;maxEvents/timeoutMs 非法即拒', () => {
    const request = {
      pythonPath: 'python3',
      collectorScript: 'scripts/trace/monitoring_capture.py',
      targetScript: 'workload.py',
      maxEvents: 500,
      timeoutMs: 30000,
      cwd: REPO_ROOT,
      sessionId: 's'
    };
    expect(buildCollectorArgs(request, '/tmp/out.json')).toEqual([
      'scripts/trace/monitoring_capture.py',
      '--max-events=500',
      '--out=/tmp/out.json',
      'workload.py'
    ]);
    expect(() => buildCollectorArgs({ ...request, maxEvents: 0 }, '/tmp/o.json')).toThrow(/有界/);
    expect(() => buildCollectorArgs({ ...request, timeoutMs: 0 }, '/tmp/o.json')).toThrow(/可关闭/);
  });

  it('spawn 失败路径:非零退出抛错并带 stderr 尾行', async () => {
    const fakeSpawn = ((_cmd: string, _args: readonly string[]) => {
      const child = {
        stdout: { on: () => undefined },
        stderr: {
          on: (_event: string, listener: (chunk: Buffer) => void) => listener(Buffer.from('boom: bad workload'))
        },
        on: (event: string, listener: (code: number | null, signal: string | null) => void) => {
          if (event === 'exit') {
            setTimeout(() => listener(2, null), 0);
          }
        },
        kill: () => true
      };
      return child;
    }) as unknown as typeof import('node:child_process').spawn;

    await expect(
      runControlledCapture(
        {
          pythonPath: 'python3',
          collectorScript: 'collector.py',
          targetScript: 'workload.py',
          maxEvents: 100,
          timeoutMs: 5000,
          cwd: REPO_ROOT,
          sessionId: 's'
        },
        { spawn: fakeSpawn }
      )
    ).rejects.toThrow(/boom: bad workload/);
  });

  it('可关闭红线:超时 kill 采集器并如实丢弃产物', async () => {
    const killed: string[] = [];
    const fakeSpawn = ((_cmd: string, _args: readonly string[]) => {
      const listeners: Record<string, Array<(code: number | null, signal: string | null) => void>> = {};
      const child = {
        stdout: { on: () => undefined },
        stderr: { on: () => undefined },
        on: (event: string, listener: (code: number | null, signal: string | null) => void) => {
          (listeners[event] ??= []).push(listener);
        },
        kill: (signal?: string) => {
          killed.push(signal ?? 'SIGTERM');
          for (const listener of listeners['exit'] ?? []) {
            listener(null, signal ?? 'SIGTERM');
          }
          return true;
        }
      };
      return child;
    }) as unknown as typeof import('node:child_process').spawn;

    await expect(
      runControlledCapture(
        {
          pythonPath: 'python3',
          collectorScript: 'collector.py',
          targetScript: 'workload.py',
          maxEvents: 100,
          timeoutMs: 30,
          cwd: REPO_ROOT,
          sessionId: 's'
        },
        { spawn: fakeSpawn }
      )
    ).rejects.toThrow(/超时关闭/);
    expect(killed).toEqual(['SIGKILL']);
  });

  it('断连面:子进程被外部信号杀掉(exit=null+signal)如实抛错,不读残缺产物', async () => {
    const fakeSpawn = ((_cmd: string, _args: readonly string[]) => {
      const child = {
        stdout: { on: () => undefined },
        stderr: { on: () => undefined },
        on: (event: string, listener: (code: number | null, signal: string | null) => void) => {
          if (event === 'exit') {
            // 外部 SIGTERM(如宿主回收):非超时路径,exit 码为 null
            setTimeout(() => listener(null, 'SIGTERM'), 0);
          }
        },
        kill: () => true
      };
      return child;
    }) as unknown as typeof import('node:child_process').spawn;

    await expect(
      runControlledCapture(
        {
          pythonPath: 'python3',
          collectorScript: 'collector.py',
          targetScript: 'workload.py',
          maxEvents: 100,
          timeoutMs: 5000,
          cwd: REPO_ROOT,
          sessionId: 's'
        },
        { spawn: fakeSpawn }
      )
    ).rejects.toThrow(/signal=SIGTERM/);
  });

  it('spawn 成功路径:读产物→导入协议,组装参数含 --max-events 与 --out', async () => {
    const seenArgs: string[][] = [];
    const raw = {
      meta: {
        collector: 'sys-monitoring',
        windowNote: 'fake window',
        clock: 'process-mono',
        startedAtEpochMs: 1
      },
      processes: [{ processId: 'py-1', role: 'unknown', name: null, enginePythonVersion: null }],
      threads: [{ threadId: 'MainThread', processId: 'py-1', name: 'MainThread' }],
      events: [
        {
          kind: 'call',
          timestamp: 1,
          processId: 'py-1',
          threadId: 'MainThread',
          entityId: null,
          frame: { file: 'w.py', line: 1, function: 'main', className: null },
          parentSeq: null
        },
        {
          kind: 'return',
          timestamp: 2,
          processId: 'py-1',
          threadId: 'MainThread',
          entityId: null,
          unwound: false
        }
      ],
      drops: []
    };
    const fakeSpawn = ((_cmd: string, args: readonly string[]) => {
      seenArgs.push([...args]);
      const outPath = (args.find(arg => arg.startsWith('--out=')) as string).slice(6);
      writeFileSync(outPath, JSON.stringify(raw));
      const child = {
        stdout: { on: () => undefined },
        stderr: {
          on: (_event: string, listener: (chunk: Buffer) => void) => listener(Buffer.from('captured 2 events'))
        },
        on: (event: string, listener: (code: number | null, signal: string | null) => void) => {
          if (event === 'exit') {
            setTimeout(() => listener(0, null), 0);
          }
        },
        kill: () => true
      };
      return child;
    }) as unknown as typeof import('node:child_process').spawn;

    const result = await runControlledCapture(
      {
        pythonPath: 'python3',
        collectorScript: 'collector.py',
        targetScript: 'workload.py',
        maxEvents: 100,
        timeoutMs: 5000,
        cwd: REPO_ROOT,
        sessionId: 'spawned'
      },
      { spawn: fakeSpawn, now: () => 42 }
    );
    expect(seenArgs[0]).toContain('--max-events=100');
    expect(seenArgs[0].some(arg => arg.startsWith('--out='))).toBe(true);
    expect(result.session.sessionId).toBe('spawned');
    expect(result.session.events).toHaveLength(2);
    expect(result.session.source.kind).toBe('sys-monitoring');
    expect(result.stderrTail).toBe('captured 2 events');
    expect(result.durationMs).toBe(0);
  });
});

// 真采集集成(端到端):本机解释器 ≥3.12 且带 sys.monitoring 才跑;
// CI 无此能力时整套 skip(skipIf 机制同 apiDocsRustParity 口径)。
let hasMonitoring = false;
try {
  execFileSync(
    'python3',
    ['-c', 'import sys; assert sys.version_info >= (3, 12); from sys import monitoring'],
    { stdio: 'ignore' }
  );
  hasMonitoring = true;
} catch {
  hasMonitoring = false;
}

describe.skipIf(!hasMonitoring)('traceCaptureRun: 真实受控采集端到端(FLOW-025)', () => {
  it('真解释器+真采集器+真实负载:11 事件/KeyError 位置/丢弃 0', async () => {
    const result = await runControlledCapture({
      pythonPath: 'python3',
      collectorScript: path.join(REPO_ROOT, 'scripts', 'trace', 'monitoring_capture.py'),
      targetScript: path.join(REPO_ROOT, 'tests', 'fixtures', 'trace', 'workload_login.py'),
      maxEvents: 1000,
      timeoutMs: 30000,
      cwd: REPO_ROOT,
      sessionId: 'real-capture'
    });
    expect(result.session.events).toHaveLength(11);
    expect(result.session.loss.totalDropped).toBe(0);
    const exceptions = result.session.events.filter(
      (event): event is TraceExceptionEvent => event.kind === 'exception'
    );
    expect(exceptions).toHaveLength(1);
    expect(exceptions[0].exceptionType).toBe('KeyError');
    expect(exceptions[0].propagated).toBe(true);
    const calls = result.session.events.filter(
      (event): event is TraceCallEvent => event.kind === 'call'
    );
    const main = calls.find(call => call.frame.function === 'main');
    expect(main!.parentSeq).toBeNull();
    expect(result.stderrTail).toContain('captured 11 events');
    expect(result.durationMs).toBeGreaterThan(0);
  });

  it('FLOW-029 开销预算实测:缺省预算跑 2000 环负载,每事件开销在预算数量级内', async () => {
    // 2000 环=约 4k 事件(预算默认 20000 缓冲内);环境变量经继承传给子进程
    const previous = process.env['TRACE_LOOP_N'];
    process.env['TRACE_LOOP_N'] = '2000';
    try {
      const result = await runControlledCapture({
        pythonPath: 'python3',
        collectorScript: path.join(REPO_ROOT, 'scripts', 'trace', 'monitoring_capture.py'),
        targetScript: path.join(REPO_ROOT, 'tests', 'fixtures', 'trace', 'workload_loop.py'),
        // 缺省 maxEvents/timeoutMs:走 FLOW-029 预登记预算(真实链路消费默认值)
        cwd: REPO_ROOT,
        sessionId: 'real-overhead'
      });
      expect(result.session.events.length).toBeGreaterThanOrEqual(4000);
      expect(result.session.loss.totalDropped).toBe(0);
      // 宽松上界(防负载抖动误报):每事件 < 0.5ms = 预算 0.05ms 的 10 倍
      // 护栏;实测值与预算对照见 docs/perf/kflow-029 报告
      const perEventMs = result.durationMs / result.session.events.length;
      expect(perEventMs).toBeLessThan(0.5);
    } finally {
      if (previous === undefined) {
        delete process.env['TRACE_LOOP_N'];
      } else {
        process.env['TRACE_LOOP_N'] = previous;
      }
    }
  });
});
