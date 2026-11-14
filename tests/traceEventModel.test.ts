import { describe, expect, it } from 'vitest';
import {
  buildTraceSession,
  describeSampleFace,
  relateMessages,
  type TraceMessageReceiveEvent,
  type TraceMessageSendEvent,
  type TraceSessionInput
} from '../src/backend/traceEventModel';

// FLOW-023(旧 KFLOW-TRACE-02)trace 事件协议钉:会话/进程/线程/实体/时间/
// 帧/消息关联/来源/丢失标记全字段面;异步跨进程只走因果边(correlationId),
// 同步栈边(parentSeq/return 链)跨线程/跨进程=伪装共享栈,构造期直接拒绝。

const baseThread = { threadId: 'base-main', processId: 'baseapp-1', name: 'main' };
const cellThread = { threadId: 'cell-main', processId: 'cellapp-1', name: 'main' };

const registries = {
  processes: [
    { processId: 'baseapp-1', role: 'base' as const, name: 'baseapp', enginePythonVersion: '3.7.3' },
    { processId: 'cellapp-1', role: 'cell' as const, name: null, enginePythonVersion: null }
  ],
  threads: [baseThread, cellThread]
};

const setprofileSource = {
  kind: 'setprofile' as const,
  collectorVersion: 'CPython 3.7.3',
  sampleFace: 'complete-within-window' as const,
  samplingHz: null,
  windowNote: 'reqCreateAvatar 派发窗口(FLOW-025 受控入口)'
};

const input = (overrides: Partial<TraceSessionInput> = {}): TraceSessionInput => ({
  sessionId: 'trace-001',
  source: setprofileSource,
  clock: { basis: 'process-mono' as const, note: '每进程独立单调钟' },
  ...registries,
  events: [
    {
      kind: 'call',
      timestamp: 100,
      processId: 'baseapp-1',
      threadId: 'base-main',
      entityId: 'Account#7',
      frame: { file: '/ws/scripts/base/Account.py', line: 22, function: 'onClientEnabled', className: 'Account' },
      parentSeq: null
    },
    {
      kind: 'message-send',
      timestamp: 101,
      processId: 'baseapp-1',
      threadId: 'base-main',
      entityId: 'Account#7',
      fromEntityId: 'Account#7',
      toProcessId: null,
      toRole: 'client' as const,
      toEntityId: null,
      methodName: 'onLoginOK',
      correlationId: 'msg-0001'
    },
    {
      kind: 'message-receive',
      timestamp: 200,
      processId: 'cellapp-1',
      threadId: 'cell-main',
      entityId: null,
      methodName: 'onEnterSpace',
      fromEntityId: null,
      frame: null,
      correlationId: 'msg-0001'
    }
  ],
  ...overrides
});

describe('FLOW-023 trace 事件协议', () => {
  it('会话/进程/线程/来源/时钟字段原样保留;seq 构造器统一分配严格递增', () => {
    const session = buildTraceSession(input());
    expect(session.sessionId).toBe('trace-001');
    expect(session.source).toEqual(setprofileSource);
    expect(session.clock.basis).toBe('process-mono');
    expect(session.processes[1]).toEqual({
      processId: 'cellapp-1',
      role: 'cell',
      name: null,
      enginePythonVersion: null
    });
    expect(session.threads.map(thread => thread.threadId)).toEqual(['base-main', 'cell-main']);
    expect(session.events.map(event => event.seq)).toEqual([0, 1, 2]);
  });

  it('同线程同步栈边合法:parentSeq/return 对应链指向同线程更早 call', () => {
    const session = buildTraceSession(input({
      events: [
        {
          kind: 'call',
          timestamp: 10,
          processId: 'cellapp-1',
          threadId: 'cell-main',
          entityId: 'Monster#3',
          frame: { file: '/ws/scripts/cell/Monster.py', line: 71, function: 'receiveDamage', className: 'Monster' },
          parentSeq: null
        },
        {
          kind: 'call',
          timestamp: 11,
          processId: 'cellapp-1',
          threadId: 'cell-main',
          entityId: 'Monster#3',
          frame: { file: '/ws/scripts/cell/Monster.py', line: 36, function: 'onDamaged', className: 'Monster' },
          parentSeq: 0
        },
        {
          kind: 'return',
          timestamp: 12,
          processId: 'cellapp-1',
          threadId: 'cell-main',
          entityId: 'Monster#3',
          correspondsToCallSeq: 1,
          returnValueNote: null
        }
      ]
    }));
    expect(session.events[1]).toMatchObject({ seq: 1, parentSeq: 0 });
    expect(session.events[2]).toMatchObject({ seq: 2, correspondsToCallSeq: 1 });
  });

  it('伪装共享栈构造期拒绝:parentSeq 跨进程/跨线程直接抛错(不静默裁剪)', () => {
    const events: TraceSessionInput['events'] = [
      {
        kind: 'call',
        timestamp: 100,
        processId: 'baseapp-1',
        threadId: 'base-main',
        entityId: null,
        frame: { file: '/a.py', line: 1, function: 'f', className: null },
        parentSeq: null
      },
      {
        kind: 'call',
        timestamp: 200,
        processId: 'cellapp-1',
        threadId: 'cell-main',
        entityId: null,
        frame: { file: '/b.py', line: 2, function: 'g', className: null },
        parentSeq: 0
      }
    ];
    expect(() => buildTraceSession(input({ events }))).toThrow(/同步栈边跨线程\/跨进程/);
  });

  it('return 对应链跨线程拒绝;时间回退拒绝(时间轴不造假)', () => {
    expect(() =>
      buildTraceSession(input({
        events: [
          {
            kind: 'call',
            timestamp: 10,
            processId: 'baseapp-1',
            threadId: 'base-main',
            entityId: null,
            frame: { file: '/a.py', line: 1, function: 'f', className: null },
            parentSeq: null
          },
          {
            kind: 'return',
            timestamp: 11,
            processId: 'cellapp-1',
            threadId: 'cell-main',
            entityId: null,
            correspondsToCallSeq: 0,
            returnValueNote: null
          }
        ]
      }))
    ).toThrow(/对应链跨线程\/跨进程/);
    expect(() =>
      buildTraceSession(input({
        events: [
          {
            kind: 'call',
            timestamp: 50,
            processId: 'cellapp-1',
            threadId: 'cell-main',
            entityId: null,
            frame: { file: '/b.py', line: 1, function: 'g', className: null },
            parentSeq: null
          },
          {
            kind: 'call',
            timestamp: 49,
            processId: 'cellapp-1',
            threadId: 'cell-main',
            entityId: null,
            frame: { file: '/b.py', line: 2, function: 'h', className: null },
            parentSeq: 0
          }
        ]
      }))
    ).toThrow(/时间回退/);
  });

  it('未登记进程/线程拒绝;实体未知如实 null', () => {
    expect(() =>
      buildTraceSession(input({
        events: [
          {
            kind: 'call',
            timestamp: 1,
            processId: 'bots-1',
            threadId: 'cell-main',
            entityId: null,
            frame: { file: '/c.py', line: 1, function: 'f', className: null },
            parentSeq: null
          }
        ]
      }))
    ).toThrow(/未登记进程 bots-1/);
    const session = buildTraceSession(input());
    expect(session.events[2].entityId).toBeNull();
  });

  it('来源/采样面配对表:配错即抛(FLOW-022 结论落协议层)', () => {
    expect(() =>
      buildTraceSession(input({
        source: { kind: 'py-spy-dump', collectorVersion: '0.4.3', sampleFace: 'sampled', samplingHz: 25, windowNote: null }
      }))
    ).toThrow(/采样面必须是 stop-only/);
    expect(() =>
      buildTraceSession(input({
        source: { kind: 'py-spy-record', collectorVersion: '0.4.3', sampleFace: 'sampled', samplingHz: null, windowNote: null }
      }))
    ).toThrow(/sampled 必须携带 samplingHz/);
    expect(() =>
      buildTraceSession(input({
        source: { kind: 'py-spy-dump', collectorVersion: '0.4.3', sampleFace: 'stop-only', samplingHz: 25, windowNote: null }
      }))
    ).toThrow(/不得携带 samplingHz/);
    expect(() =>
      buildTraceSession(input({
        source: { kind: 'setprofile', collectorVersion: null, sampleFace: 'complete-within-window', samplingHz: null, windowNote: null }
      }))
    ).toThrow(/必须携带受控窗口说明/);
  });

  it('采样面不得宣称边界口径(R2/R3 呈现层引用)', () => {
    expect(describeSampleFace('sampled')).toContain('不冒充完整请求轨迹');
    expect(describeSampleFace('stop-only')).toContain('无连续性');
    expect(describeSampleFace('complete-within-window')).toContain('窗口外未知');
    expect(describeSampleFace('sparse-points')).toContain('只允许候选关联');
  });

  it('消息因果裁定:两侧关联 ID 非空且相等才是因果;缺侧/不一致只给候选(禁止按方法名/邻近时间宣称因果)', () => {
    const send: TraceMessageSendEvent = {
      seq: 0,
      timestamp: 1,
      processId: 'baseapp-1',
      threadId: 'base-main',
      entityId: null,
      kind: 'message-send',
      fromEntityId: null,
      toProcessId: null,
      toRole: 'client',
      toEntityId: null,
      methodName: 'onLevelUp',
      correlationId: 'msg-9'
    };
    const receive: TraceMessageReceiveEvent = {
      seq: 1,
      timestamp: 2,
      processId: 'client-1',
      threadId: 'client-main',
      entityId: null,
      kind: 'message-receive',
      methodName: 'onLevelUp',
      fromEntityId: null,
      frame: null,
      correlationId: 'msg-9'
    };
    expect(relateMessages(send, receive)).toEqual({ kind: 'causal', correlationId: 'msg-9' });
    expect(relateMessages(send, { ...receive, correlationId: null }).kind).toBe('candidate');
    expect(relateMessages({ ...send, correlationId: null }, receive).kind).toBe('candidate');
    const mismatch = relateMessages(send, { ...receive, correlationId: 'msg-8' });
    expect(mismatch.kind).toBe('candidate');
    if (mismatch.kind === 'candidate') {
      expect(mismatch.reason).toContain('不得宣称因果');
    }
  });

  it('丢失标记:drop 事件入账,totalDropped=计数和;count<=0 拒绝', () => {
    const session = buildTraceSession(input({
      drops: [
        { timestamp: 300, processId: 'cellapp-1', reason: 'buffer-full', count: 120, note: '有界缓冲打满(FLOW-025)' },
        { timestamp: 310, processId: null, reason: 'clock-gap', count: 3, note: null }
      ]
    }));
    expect(session.loss.totalDropped).toBe(123);
    expect(session.loss.drops).toHaveLength(2);
    expect(session.loss.drops[1].processId).toBeNull();
    expect(() =>
      buildTraceSession(input({
        drops: [{ timestamp: 1, processId: null, reason: 'unsupported', count: 0, note: null }]
      }))
    ).toThrow(/count 必须 >0/);
  });

  it('默认完整性注记来自采样面口径;显式 completenessNote 优先', () => {
    const session = buildTraceSession(input());
    expect(session.loss.completenessNote).toContain('窗口外未知');
    const custom = buildTraceSession(input({ completenessNote: '窗口=单次派发;采集器异常中断于 t=500' }));
    expect(custom.loss.completenessNote).toBe('窗口=单次派发;采集器异常中断于 t=500');
  });

  it('异常事件字段面:atSeq/类型/消息/传播未知如实 null;时钟基准 unknown 可携带', () => {
    const session = buildTraceSession(input({
      clock: { basis: 'unknown', note: '日志面无统一时钟' },
      source: { kind: 'log-evidence', collectorVersion: null, sampleFace: 'sparse-points', samplingHz: null, windowNote: null },
      events: [
        {
          kind: 'exception',
          timestamp: 5,
          processId: 'cellapp-1',
          threadId: 'cell-main',
          entityId: 'Avatar#42',
          atSeq: null,
          exceptionType: null,
          message: 'reqRadarPing EXC KeyError',
          propagated: null
        }
      ]
    }));
    const exception = session.events[0];
    expect(exception.kind).toBe('exception');
    if (exception.kind === 'exception') {
      expect(exception.atSeq).toBeNull();
      expect(exception.propagated).toBeNull();
      expect(exception.message).toContain('EXC');
    }
    expect(session.clock.basis).toBe('unknown');
  });
});
