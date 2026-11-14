import { describe, expect, it } from 'vitest';
import { buildTraceReplayModel, describeTraceReplayModel } from '../src/backend/traceReplayModel';
import { buildTraceSession, type TraceSessionInput } from '../src/backend/traceEventModel';
import type { TraceFrame } from '../src/backend/traceEventModel';

// FLOW-028 回放验收:「以真实组件实例泳道展示本地栈段和消息流;多次相同
// RPC/乱序/广播/缺失事件可区分。」
// 四条可区分性钉:①同名方法重复 RPC=两条独立流(seq 锚不同,不合并);
// ②乱序=泳道/流一律按 seq 序,跨进程时间数值不参与排序(客户端时钟数值
// 更大/更小都不改变序);③广播 fan-in=每接收者一条流且全标 broadcast;
// ④缺失=send-without-receive / receive-without-send 独立标记,不与候选
// 流混装。另钉:泳道=真实观察到的进程实例(实体身份空=如实)、回调段
// 深度标注、入口链与回调段重叠注记。

const source = {
  kind: 'sys-monitoring' as const,
  collectorVersion: '3.14.4',
  sampleFace: 'complete-within-window' as const,
  samplingHz: null,
  windowNote: 'tests: replay window'
};

const process = (processId: string, role: TraceSessionInput['processes'][number]['role']) => ({
  processId,
  role,
  name: null,
  enginePythonVersion: '3.14.4'
});
const thread = (threadId: string, processId: string) => ({ threadId, processId, name: null });

const call = (
  processId: string,
  threadId: string,
  ts: number,
  frame: TraceFrame,
  parentSeq: number | null,
  entityId: string | null = null
) => ({ kind: 'call' as const, timestamp: ts, processId, threadId, entityId, frame, parentSeq });
const send = (
  processId: string,
  threadId: string,
  ts: number,
  methodName: string,
  correlationId: string | null
) => ({
  kind: 'message-send' as const,
  timestamp: ts,
  processId,
  threadId,
  entityId: null,
  fromEntityId: null,
  toProcessId: null,
  toRole: null,
  toEntityId: null,
  methodName,
  correlationId
});
const receive = (
  processId: string,
  threadId: string,
  ts: number,
  methodName: string,
  correlationId: string | null,
  frame: TraceFrame | null
) => ({
  kind: 'message-receive' as const,
  timestamp: ts,
  processId,
  threadId,
  entityId: null,
  methodName,
  fromEntityId: null,
  frame,
  correlationId
});

const build = (input: Omit<TraceSessionInput, 'source'>) =>
  buildTraceSession({ ...input, source });

describe('FLOW-028 回放模型:真实组件实例泳道', () => {
  it('泳道=会话内真实进程实例,按首事件 seq 排序;无事件进程排末尾;实体身份空=如实', () => {
    const session = build({
      sessionId: 'lanes',
      clock: { basis: 'process-mono', note: null },
      processes: [process('base-1', 'base'), process('py-client', 'client'), process('cell-1', 'cell')],
      threads: [thread('t-base', 'base-1'), thread('t-client', 'py-client')],
      events: [
        call('py-client', 't-client', 10, { file: 'client/Avatar.py', line: 3, function: 'pick', className: 'Avatar' }, null),
        send('py-client', 't-client', 20, 'fire', 'c1'),
        receive('base-1', 't-base', 30, 'fire', 'c1', {
          file: 'base/Turret.py',
          line: 7,
          function: 'fire',
          className: 'Turret'
        }),
        call('base-1', 't-base', 40, { file: 'base/Turret.py', line: 7, function: 'fire', className: 'Turret' }, null, 'Turret#9')
      ]
    });
    const model = buildTraceReplayModel(session);
    // 事件空进程 cell-1 也在泳道里(登记即观察面),排末尾
    expect(model.lanes.map(lane => lane.processId)).toEqual(['py-client', 'base-1', 'cell-1']);
    // 实体身份:base 观察到 Turret#9;client 全 null=空数组如实,不造实例
    expect(model.lanes[1].entityInstances).toEqual(['Turret#9']);
    expect(model.lanes[0].entityInstances).toEqual([]);
    expect(model.lanes[2].entityInstances).toEqual([]);
    expect(model.lanes[2].segments).toEqual([]);
  });

  it('多次相同 RPC=两条独立流不合并(seq 锚各归各)', () => {
    const frame = { file: 'base/Turret.py', line: 7, function: 'fire', className: 'Turret' };
    const session = build({
      sessionId: 'repeat',
      clock: { basis: 'process-mono', note: null },
      processes: [process('py-client', 'client'), process('base-1', 'base')],
      threads: [thread('t-client', 'py-client'), thread('t-base', 'base-1')],
      events: [
        send('py-client', 't-client', 10, 'fire', 'c1'),
        send('py-client', 't-client', 20, 'fire', 'c2'),
        receive('base-1', 't-base', 30, 'fire', 'c1', frame),
        call('base-1', 't-base', 40, frame, null),
        receive('base-1', 't-base', 50, 'fire', 'c2', frame),
        call('base-1', 't-base', 60, frame, null)
      ]
    });
    const model = buildTraceReplayModel(session);
    const causal = model.flows.filter(flow => flow.kind === 'causal');
    expect(causal).toHaveLength(2);
    // 同名 fire 两次:锚=seq 对,两条流互不合并
    expect(causal[0].sendSeq).not.toBe(causal[1].sendSeq);
    expect(causal[0].receiveSeq).not.toBe(causal[1].receiveSeq);
    expect(new Set(causal.map(flow => flow.correlationId))).toEqual(new Set(['c1', 'c2']));
    expect(causal.every(flow => flow.methodName === 'fire')).toBe(true);
    expect(causal.every(flow => !flow.broadcast)).toBe(true);
  });

  it('乱序:泳道/流按 seq 序展示,跨进程时间数值不参与排序(客户端时钟数值更大也在前)', () => {
    const frame = { file: 'base/Turret.py', line: 7, function: 'fire', className: 'Turret' };
    const session = build({
      sessionId: 'skew',
      clock: { basis: 'process-mono', note: '两时钟域,数值不可比' },
      processes: [process('py-client', 'client'), process('base-1', 'base')],
      threads: [thread('t-client', 'py-client'), thread('t-base', 'base-1')],
      events: [
        // client 首事件 ts=900,base 首事件 ts=100:按时间排会颠倒,按 seq 排不颠倒
        call('py-client', 't-client', 900, { file: 'client/Avatar.py', line: 3, function: 'pick', className: 'Avatar' }, null),
        send('py-client', 't-client', 950, 'fire', 'c1'),
        receive('base-1', 't-base', 100, 'fire', 'c1', frame),
        call('base-1', 't-base', 150, frame, null)
      ]
    });
    const model = buildTraceReplayModel(session);
    // 泳道序=seq 序(py-client 首事件 seq=0 在前),时间数值更大不改变
    expect(model.lanes[0].processId).toBe('py-client');
    // 接收时间戳(100)数值小于发送(950)照样 causal:因果只认 ID 配对
    expect(model.flows).toHaveLength(1);
    expect(model.flows[0].kind).toBe('causal');
    expect(model.flows[0].sendSeq).toBe(1);
    expect(model.flows[0].receiveSeq).toBe(2);
    expect(model.flows[0].fromProcessId).toBe('py-client');
    expect(model.flows[0].toProcessId).toBe('base-1');
  });

  it('广播 fan-in:一发送两接收=两条流且全标 broadcast,各接收泳道各留一条', () => {
    const frame = { file: 'client/Avatar.py', line: 11, function: 'onFire', className: 'Avatar' };
    const session = build({
      sessionId: 'broadcast',
      clock: { basis: 'process-mono', note: null },
      processes: [process('base-1', 'base'), process('client-a', 'client'), process('client-b', 'client')],
      threads: [thread('t-base', 'base-1'), thread('t-a', 'client-a'), thread('t-b', 'client-b')],
      events: [
        send('base-1', 't-base', 10, 'onFire', 'c1'),
        receive('client-a', 't-a', 20, 'onFire', 'c1', frame),
        call('client-a', 't-a', 30, frame, null),
        receive('client-b', 't-b', 40, 'onFire', 'c1', frame),
        call('client-b', 't-b', 50, frame, null)
      ]
    });
    const model = buildTraceReplayModel(session);
    expect(model.flows).toHaveLength(2);
    expect(model.flows.every(flow => flow.kind === 'causal' && flow.broadcast)).toBe(true);
    // 每条流锚到各自 receiveSeq(逐接收者可区分)
    expect(new Set(model.flows.map(flow => flow.receiveSeq))).toEqual(new Set([1, 3]));
    const laneA = model.lanes.find(lane => lane.processId === 'client-a');
    const laneB = model.lanes.find(lane => lane.processId === 'client-b');
    expect(laneA?.flows).toHaveLength(1);
    expect(laneB?.flows).toHaveLength(1);
    expect(laneA?.flows[0].receiveSeq).toBe(1);
    expect(laneB?.flows[0].receiveSeq).toBe(3);
  });

  it('缺失:发送无接收/接收无发送=两类缺失标记,无流混装', () => {
    const session = build({
      sessionId: 'missing',
      clock: { basis: 'process-mono', note: null },
      processes: [process('py-client', 'client'), process('base-1', 'base')],
      threads: [thread('t-client', 'py-client'), thread('t-base', 'base-1')],
      events: [
        send('py-client', 't-client', 10, 'lost', 'c9'),
        receive('base-1', 't-base', 20, 'orphan', null, null)
      ]
    });
    const model = buildTraceReplayModel(session);
    expect(model.flows).toHaveLength(0);
    const clientLane = model.lanes.find(lane => lane.processId === 'py-client');
    const baseLane = model.lanes.find(lane => lane.processId === 'base-1');
    expect(clientLane?.missingMarkers).toHaveLength(1);
    expect(clientLane?.missingMarkers[0]).toMatchObject({
      kind: 'send-without-receive',
      seq: 0,
      methodName: 'lost'
    });
    expect(baseLane?.missingMarkers).toHaveLength(1);
    expect(baseLane?.missingMarkers[0]).toMatchObject({
      kind: 'receive-without-send',
      seq: 1,
      methodName: 'orphan'
    });
    // 两类标记不混装:detail 各带各自解释
    expect(clientLane?.missingMarkers[0].detail).not.toBe(baseLane?.missingMarkers[0].detail);
  });

  it('本地栈段:回调段深度标注;入口链只收未覆盖调用,与回调段重叠如实注记', () => {
    const dispatch = { file: 'base/Door.py', line: 10, function: 'onFoo', className: 'Door' };
    const session = build({
      sessionId: 'segments',
      clock: { basis: 'process-mono', note: null },
      processes: [process('base-1', 'base')],
      threads: [thread('t-base', 'base-1')],
      events: [
        receive('base-1', 't-base', 10, 'onFoo', 'c1', dispatch),
        call('base-1', 't-base', 20, { file: 'base/Main.py', line: 1, function: 'main', className: null }, null),
        call('base-1', 't-base', 30, dispatch, 1),
        call('base-1', 't-base', 40, { file: 'base/Door.py', line: 18, function: 'unlock', className: 'Door' }, 2),
        {
          kind: 'return' as const,
          timestamp: 50,
          processId: 'base-1',
          threadId: 't-base',
          entityId: null,
          correspondsToCallSeq: 3,
          returnValueNote: null
        }
      ]
    });
    const model = buildTraceReplayModel(session);
    const lane = model.lanes[0];
    expect(lane.segments).toHaveLength(2);
    const entry = lane.segments.find(segment => segment.kind === 'entry-chain');
    const callback = lane.segments.find(segment => segment.kind === 'callback');
    // 回调段=派发帧落地子树,深度相对段根
    expect(callback?.rootCallSeq).toBe(2);
    expect(callback?.frames.map(frame => [frame.function, frame.depth])).toEqual([
      ['onFoo', 0],
      ['unlock', 1]
    ]);
    expect(callback?.receiveSeq).toBe(0);
    // 入口链只收未覆盖调用(main);重叠处注记不计重复
    expect(entry?.frames.map(frame => frame.function)).toEqual(['main']);
    expect(entry?.note).toContain('2');
    // 段序=seq 序(receive 在前)
    expect(lane.segments[0].kind).toBe('callback');
    expect(lane.segments[1].kind).toBe('entry-chain');
  });

  it('摘要串诚实计数(lanes/segments/flows/missing)', () => {
    const frame = { file: 'base/Turret.py', line: 7, function: 'fire', className: 'Turret' };
    const session = build({
      sessionId: 'summary',
      clock: { basis: 'process-mono', note: null },
      processes: [process('py-client', 'client'), process('base-1', 'base')],
      threads: [thread('t-client', 'py-client'), thread('t-base', 'base-1')],
      events: [
        send('py-client', 't-client', 10, 'fire', 'c1'),
        receive('base-1', 't-base', 20, 'fire', 'c1', frame),
        call('base-1', 't-base', 30, frame, null),
        send('py-client', 't-client', 40, 'lost', null)
      ]
    });
    const summary = describeTraceReplayModel(buildTraceReplayModel(session));
    expect(summary).toContain('lanes=2');
    expect(summary).toContain('flows causal=1');
    expect(summary).toContain('missing=1');
    expect(summary).toContain('受控窗口内逐事件完整');
  });
});
