import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import {
  describeImportedSession,
  frameJumpTarget,
  importMonitoringSession,
  type RawMonitoringSession
} from '../src/backend/traceImport';
import type {
  TraceCallEvent,
  TraceEvent,
  TraceExceptionEvent,
  TraceReturnEvent
} from '../src/backend/traceEventModel';

// FLOW-024 导入面验收:唯一来源=真实采集工件(session-001.json,由
// scripts/trace/monitoring_capture.py 在本机 CPython 3.14.4 实采;重新生成:
// python3 scripts/trace/monitoring_capture.py --out tests/fixtures/trace/session-001.json
//   tests/fixtures/trace/workload_login.py)。
// 验收原文:「先支持一个已验证来源的真实帧顺序、文件行和异常位置;字段缺失
// 明示,栈展开可跳源码。」所有行号/帧序断言都运行时从真实工件与真实负载
// 文件推导——不手写行号、不冒充实采。

const TRACE_DIR = path.join(__dirname, 'fixtures', 'trace');
const WORKLOAD_REL = path.join('tests', 'fixtures', 'trace', 'workload_login.py');

const RAW = JSON.parse(
  readFileSync(path.join(TRACE_DIR, 'session-001.json'), 'utf8')
) as RawMonitoringSession;
const SESSION = importMonitoringSession(RAW, 'session-001');

const workloadLines = readFileSync(path.join(TRACE_DIR, 'workload_login.py'), 'utf8').split(
  /\r?\n/
);

/** 1 基 def 声明行,从真实负载文件运行时推导(采集口径 co_firstlineno)。 */
const defLine = (fn: string): number => {
  const idx = workloadLines.findIndex(line => new RegExp(`^[ \t]*def ${fn}\\(`).test(line));
  expect(idx, `workload 里找不到 def ${fn}`).toBeGreaterThanOrEqual(0);
  return idx + 1;
};

const callsOf = (events: TraceEvent[]): TraceCallEvent[] =>
  events.filter((event): event is TraceCallEvent => event.kind === 'call');
const returnsOf = (events: TraceEvent[]): TraceReturnEvent[] =>
  events.filter((event): event is TraceReturnEvent => event.kind === 'return');

const callByFunction = (fn: string): TraceCallEvent => {
  const hits = callsOf(SESSION.events).filter(call => call.frame.function === fn);
  expect(hits, `call ${fn} 应恰一次`).toHaveLength(1);
  return hits[0];
};

const clone = (): RawMonitoringSession => JSON.parse(JSON.stringify(RAW)) as RawMonitoringSession;

describe('traceImport: sys-monitoring 真实会话导入(FLOW-024)', () => {
  it('source face 如实声明 sys-monitoring / complete-within-window', () => {
    expect(SESSION.source.kind).toBe('sys-monitoring');
    expect(SESSION.source.sampleFace).toBe('complete-within-window');
    expect(SESSION.source.samplingHz).toBeNull();
    expect(SESSION.source.windowNote).toContain('main()');
    // 采集解释器版本如实携带(真实工件=本机 3.14.4;断形态不钉死版本号)
    expect(SESSION.source.collectorVersion).toMatch(/^\d+\.\d+/);
    expect(SESSION.clock.basis).toBe('process-mono');
    expect(SESSION.events).toHaveLength(11);
    expect(SESSION.loss.totalDropped).toBe(0);
  });

  it('真实帧顺序与 parentSeq 嵌套(main←onClientEnabled←buildLoginMsg←sanitizeName)', () => {
    const main = callByFunction('main');
    const onClientEnabled = callByFunction('onClientEnabled');
    const buildLoginMsg = callByFunction('buildLoginMsg');
    const sanitizeName = callByFunction('sanitizeName');
    const loadAccount = callByFunction('loadAccount');

    expect(main.parentSeq).toBeNull();
    expect(onClientEnabled.parentSeq).toBe(main.seq);
    expect(buildLoginMsg.parentSeq).toBe(onClientEnabled.seq);
    expect(sanitizeName.parentSeq).toBe(buildLoginMsg.seq);
    // loadAccount 在 buildLoginMsg 返回之后才进入,父仍是 onClientEnabled
    const buildReturn = returnsOf(SESSION.events).find(
      ret => ret.correspondsToCallSeq === buildLoginMsg.seq
    );
    expect(buildReturn).toBeDefined();
    expect(loadAccount.seq).toBeGreaterThan(buildReturn!.seq);
    expect(loadAccount.parentSeq).toBe(onClientEnabled.seq);
  });

  it('文件行可跳源码:帧行=真实负载的 def 声明行(1 基)', () => {
    const methodClasses: Record<string, string | null> = {
      main: null,
      onClientEnabled: 'Account',
      buildLoginMsg: 'Account',
      loadAccount: 'Account',
      sanitizeName: null
    };
    for (const [fn, className] of Object.entries(methodClasses)) {
      const call = callByFunction(fn);
      expect(call.frame.file, `${fn} 帧文件=负载相对路径`).toBe(WORKLOAD_REL);
      expect(call.frame.line, `${fn} 帧=真实 def 行`).toBe(defLine(fn));
      expect(call.frame.className, `${fn} 类名如实`).toBe(className);
      expect(frameJumpTarget(call.frame)).toEqual({ file: call.frame.file, line: call.frame.line });
    }
  });

  it('异常位置与传播:KeyError 落在 loadAccount,展开链可达捕获者', () => {
    const exceptions = SESSION.events.filter(
      (event): event is TraceExceptionEvent => event.kind === 'exception'
    );
    expect(exceptions).toHaveLength(1);
    const exc = exceptions[0];
    const loadAccount = callByFunction('loadAccount');
    expect(exc.exceptionType).toBe('KeyError');
    expect(exc.message).toContain('hero');
    expect(exc.atSeq).toBe(loadAccount.seq);
    expect(exc.propagated).toBe(true);

    // 栈展开沿 parentSeq 可走:loadAccount → onClientEnabled(捕获者)→ main → 根
    const bySeq = new Map(SESSION.events.map(event => [event.seq, event]));
    const chain: string[] = [];
    let cursor: number | null = loadAccount.seq;
    while (cursor !== null) {
      const event = bySeq.get(cursor);
      if (!event || event.kind !== 'call') break;
      chain.push(event.frame.function);
      cursor = event.parentSeq;
    }
    expect(chain).toEqual(['loadAccount', 'onClientEnabled', 'main']);
  });

  it('return 按同线程括号对称配对(PY_UNWIND 如实注记)', () => {
    const returns = returnsOf(SESSION.events);
    const calls = callsOf(SESSION.events);
    expect(returns).toHaveLength(5);
    expect(calls).toHaveLength(5);
    // 配对多重集相等:每个 call 恰被一个 return 闭合
    expect([...returns.map(ret => ret.correspondsToCallSeq)].sort((a, b) => a - b)).toEqual(
      [...calls.map(call => call.seq)].sort((a, b) => a - b)
    );
    // 逐函数配对正确且同线程
    for (const fn of ['main', 'onClientEnabled', 'buildLoginMsg', 'sanitizeName', 'loadAccount']) {
      const call = callByFunction(fn);
      const ret = returns.find(r => r.correspondsToCallSeq === call.seq);
      expect(ret, `${fn} 的 return`).toBeDefined();
      expect(ret!.threadId).toBe(call.threadId);
    }
    // 异常驱动的返回(loadAccount)带 unwind 注记;正常返回注记=null
    const loadReturn = returns.find(ret => ret.correspondsToCallSeq === callByFunction('loadAccount').seq);
    expect(loadReturn!.returnValueNote).toContain('PY_UNWIND');
    const normalReturn = returns.find(ret => ret.correspondsToCallSeq === callByFunction('sanitizeName').seq);
    expect(normalReturn!.returnValueNote).toBeNull();
  });

  it('字段缺失明示:entityId/引擎版本/关联 ID 面全部如实 null', () => {
    for (const event of SESSION.events) {
      expect(event.entityId, `seq#${event.seq} 实体身份本来源观察不到`).toBeNull();
    }
    expect(SESSION.processes[0].role).toBe('unknown');
    expect(SESSION.processes[0].enginePythonVersion).toBeNull();
    const messageEvents = SESSION.events.filter(
      event => event.kind === 'message-send' || event.kind === 'message-receive'
    );
    expect(messageEvents).toHaveLength(0);
    const summary = describeImportedSession(SESSION);
    expect(summary).toContain('sys-monitoring');
    expect(summary).toContain('events=11');
  });

  it('拒绝非 sys-monitoring 来源(来源配对是红线)', () => {
    const raw = clone();
    raw.meta.collector = 'setprofile';
    expect(() => importMonitoringSession(raw, 'wrong-source')).toThrow(/sys-monitoring/);
  });

  it('括号对称破坏(return 无未闭合 call)如实抛错,不猜配对', () => {
    const raw = clone();
    const lastReturn = [...raw.events].reverse().find(event => event['kind'] === 'return');
    raw.events.push({ ...(lastReturn as Record<string, unknown>) });
    expect(() => importMonitoringSession(raw, 'broken-brackets')).toThrow(/括号对称/);
  });

  it('drop 记录对账进 loss(buffer-full 口径)', () => {
    const raw = clone();
    raw.drops = [
      { processId: null, reason: 'buffer-full', count: 3, note: 'max-events 打满' }
    ];
    const session = importMonitoringSession(raw, 'with-drops');
    expect(session.loss.totalDropped).toBe(3);
    expect(session.loss.drops).toHaveLength(1);
    expect(session.loss.drops[0].reason).toBe('buffer-full');
    expect(session.loss.completenessNote).toContain('受控窗口');
  });
});
