import { describe, expect, it } from 'vitest';
import {
  buildTraceCorrelations,
  describeTraceCorrelations
} from '../src/backend/traceCorrelation';
import { buildTraceSession, type TraceSessionInput } from '../src/backend/traceEventModel';

// FLOW-027 串联验收:「有可靠 ID 时连接事件,无 ID 只展示候选关联并解释;
// 禁止仅按方法名/邻近时间宣称因果。」
// 钉面:causal 只认 ID 相等(relateMessages 协议裁定);同方法名+时间邻近的
// 无 ID 配对永远不升 causal(名匹配禁令钉);跨进程时间不可比(客户端时钟
// 数值更小照样 causal,不做时间序裁剪);回调段=派发帧全等落地+parentSeq
// 子树,帧缺失/未观察到=如实 null 不猜;广播 fan-in 一发两收=两条 causal。

const dispatchFrame = { file: 'client/Avatar.py', line: 5, function: 'onLoginOK', className: 'Avatar' };

const callEvent = (
  processId: string,
  threadId: string,
  ts: number,
  frame: { file: string; line: number; function: string; className: string | null },
  parentSeq: number | null
) => ({
  kind: 'call' as const,
  timestamp: ts,
  processId,
  threadId,
  entityId: null,
  frame,
  parentSeq
});
const returnEvent = (processId: string, threadId: string, ts: number, callSeq: number) => ({
  kind: 'return' as const,
  timestamp: ts,
  processId,
  threadId,
  entityId: null,
  correspondsToCallSeq: callSeq,
  returnValueNote: null
});
const sendEvent = (
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
  fromEntityId: 'Account#1',
  toProcessId: 'py-client',
  toRole: 'client' as const,
  toEntityId: null,
  methodName,
  correlationId
});
const receiveEvent = (
  processId: string,
  threadId: string,
  ts: number,
  methodName: string,
  correlationId: string | null,
  frame: typeof dispatchFrame | null
) => ({
  kind: 'message-receive' as const,
  timestamp: ts,
  processId,
  threadId,
  entityId: null,
  methodName,
  fromEntityId: 'Account#1',
  frame,
  correlationId
});

const build = (events: TraceSessionInput['events'], sessionId = 'corr'): ReturnType<typeof buildTraceSession> =>
  buildTraceSession({
    sessionId,
    source: {
      kind: 'sys-monitoring',
      collectorVersion: '3.14.4',
      sampleFace: 'complete-within-window',
      samplingHz: null,
      windowNote: 'synthetic session for correlation pins'
    },
    clock: { basis: 'process-mono', note: null },
    processes: [
      { processId: 'py-base', role: 'base', name: null, enginePythonVersion: null },
      { processId: 'py-client', role: 'client', name: null, enginePythonVersion: null }
    ],
    threads: [
      { threadId: 't-base', processId: 'py-base', name: 't-base' },
      { threadId: 't-client', processId: 'py-client', name: 't-client' }
    ],
    events
  });

describe('traceCorrelation: causal 只认关联 ID(FLOW-027)', () => {
  it('两侧 ID 相等=causal;跨进程时间不可比(客户端时钟数值更小不裁剪)', () => {
    const session = build([
      // base 进程时钟从 100 起;client 进程时钟从 1 起(数值上"更早",不可比)
      callEvent('py-base', 't-base', 100, { file: 'base/Account.py', line: 10, function: 'onReqLogin', className: 'Account' }, null),
      sendEvent('py-base', 't-base', 101, 'onLoginOK', 'tok-1'),
      returnEvent('py-base', 't-base', 102, 0),
      receiveEvent('py-client', 't-client', 1, 'onLoginOK', 'tok-1', dispatchFrame),
      callEvent('py-client', 't-client', 2, dispatchFrame, null),
      callEvent('py-client', 't-client', 3, { file: 'client/Avatar.py', line: 12, function: 'showName', className: 'Avatar' }, 4),
      returnEvent('py-client', 't-client', 4, 5),
      returnEvent('py-client', 't-client', 5, 4)
    ]);
    const result = buildTraceCorrelations(session);
    expect(result.causalLinks).toHaveLength(1);
    expect(result.causalLinks[0]).toEqual({
      kind: 'causal',
      correlationId: 'tok-1',
      sendSeq: 1,
      receiveSeq: 3
    });
    expect(result.candidateLinks).toHaveLength(0);
  });

  it('同一方法名+时间邻近但无 ID:只有候选,绝不升 causal(名匹配禁令钉)', () => {
    const session = build([
      sendEvent('py-base', 't-base', 10, 'onLevelUp', null),
      receiveEvent('py-client', 't-client', 11, 'onLevelUp', null, dispatchFrame)
    ]);
    const result = buildTraceCorrelations(session);
    expect(result.causalLinks).toHaveLength(0);
    expect(result.candidateLinks).toHaveLength(2);
    for (const link of result.candidateLinks) {
      expect(link.reason).toContain('禁止按方法名/邻近时间宣称因果');
    }
  });

  it('ID 不一致=候选且 reason 带 mismatch 口径', () => {
    const session = build([
      sendEvent('py-base', 't-base', 10, 'onLoginOK', 'tok-x'),
      receiveEvent('py-client', 't-client', 11, 'onLoginOK', 'tok-y', null)
    ]);
    const result = buildTraceCorrelations(session);
    expect(result.causalLinks).toHaveLength(0);
    const mismatch = result.candidateLinks.find(link => link.sendSeq !== null && link.receiveSeq !== null);
    expect(mismatch!.reason).toContain('tok-x');
    expect(mismatch!.reason).toContain('tok-y');
  });

  it('广播 fan-in:一发两收同 ID=两条 causal,各自带回调段', () => {
    const session = build([
      sendEvent('py-base', 't-base', 10, 'onMonsterNear', 'tok-b'),
      receiveEvent('py-client', 't-client', 1, 'onMonsterNear', 'tok-b', dispatchFrame),
      callEvent('py-client', 't-client', 2, dispatchFrame, null),
      returnEvent('py-client', 't-client', 3, 2),
      receiveEvent('py-client', 't-client', 4, 'onMonsterNear', 'tok-b', dispatchFrame),
      callEvent('py-client', 't-client', 5, dispatchFrame, null),
      returnEvent('py-client', 't-client', 6, 5)
    ]);
    const result = buildTraceCorrelations(session);
    expect(result.causalLinks).toHaveLength(2);
    expect(result.causalLinks.map(link => link.receiveSeq).sort((a, b) => a - b)).toEqual([1, 4]);
    expect(result.callbackSegments).toHaveLength(2);
    // 最近邻派发帧:第一段落 seq2,第二段落 seq5(同帧两次派发不互相吞)
    expect(result.callbackSegments[0].rootCallSeq).toBe(2);
    expect(result.callbackSegments[1].rootCallSeq).toBe(5);
  });
});

describe('traceCorrelation: 候选解释(FLOW-027)', () => {
  it('缺侧如实:发送无对侧/接收无发送侧各给候选,reason 提 opt-in 出处', () => {
    const session = build([
      sendEvent('py-base', 't-base', 10, 'onLoginOK', 'tok-only-send'),
      receiveEvent('py-client', 't-client', 11, 'onMonsterNear', null, null)
    ]);
    const result = buildTraceCorrelations(session);
    expect(result.candidateLinks).toHaveLength(2);
    const sendSide = result.candidateLinks.find(link => link.sendSeq !== null);
    expect(sendSide!.reason).toContain('无对侧同 ID');
    expect(sendSide!.receiveSeq).toBeNull();
    const receiveSide = result.candidateLinks.find(link => link.receiveSeq !== null);
    expect(receiveSide!.reason).toContain('载荷 opt-in');
    expect(receiveSide!.sendSeq).toBeNull();
  });
});

describe('traceCorrelation: 回调执行段(FLOW-027)', () => {
  it('派发帧全等落地+parentSeq 子树收集;兄弟子树不吞', () => {
    const session = build([
      receiveEvent('py-client', 't-client', 1, 'onLoginOK', 'tok-1', dispatchFrame),
      callEvent('py-client', 't-client', 2, dispatchFrame, null),
      callEvent('py-client', 't-client', 3, { file: 'client/Avatar.py', line: 12, function: 'showName', className: 'Avatar' }, 1),
      callEvent('py-client', 't-client', 4, { file: 'client/Avatar.py', line: 20, function: 'unrelated', className: null }, null),
      callEvent('py-client', 't-client', 5, { file: 'client/Avatar.py', line: 30, function: 'nested', className: null }, 3),
      returnEvent('py-client', 't-client', 6, 2),
      returnEvent('py-client', 't-client', 7, 1),
      returnEvent('py-client', 't-client', 8, 3),
      returnEvent('py-client', 't-client', 9, 4)
    ]);
    const result = buildTraceCorrelations(session);
    expect(result.callbackSegments).toHaveLength(1);
    const segment = result.callbackSegments[0];
    expect(segment.rootCallSeq).toBe(1);
    // 根 onLoginOK + 后代 showName;unrelated(独立根)与 nested(挂 unrelated)不吞
    expect(segment.callSeqs).toEqual([1, 2]);
    expect(segment.returnSeqs).toEqual([5, 6]);
    expect(segment.note).toBeNull();
  });

  it('派发帧=null 与会话内无全等帧:rootCallSeq 如实 null 并说明,不猜', () => {
    const session = build([
      receiveEvent('py-client', 't-client', 1, 'onEnterSpace', null, null),
      receiveEvent('py-client', 't-client', 2, 'onOther', null, { file: 'x.py', line: 1, function: 'neverCalled', className: null }),
      callEvent('py-client', 't-client', 3, dispatchFrame, null),
      returnEvent('py-client', 't-client', 4, 2)
    ]);
    const result = buildTraceCorrelations(session);
    expect(result.callbackSegments).toHaveLength(2);
    expect(result.callbackSegments[0].rootCallSeq).toBeNull();
    expect(result.callbackSegments[0].note).toContain('frame=null');
    expect(result.callbackSegments[1].rootCallSeq).toBeNull();
    expect(result.callbackSegments[1].note).toContain('未观察到');
  });

  it('摘要串:三面计数与诚实口径', () => {
    const session = build([
      sendEvent('py-base', 't-base', 10, 'onLoginOK', 'tok-1'),
      receiveEvent('py-client', 't-client', 11, 'onLoginOK', 'tok-1', null)
    ]);
    const result = buildTraceCorrelations(session);
    const summary = describeTraceCorrelations(result);
    expect(summary).toContain('causal=1');
    expect(summary).toContain('candidate=');
    expect(summary).toContain('rooted=0');
  });
});
