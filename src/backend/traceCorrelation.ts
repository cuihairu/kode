/**
 * KFLOW 跨进程/回调串联面(FLOW-027):在 traceEventModel 会话上把
 * message-send / message-receive 串成因果边或候选关联,并把 message-receive
 * 的派发帧落地为本地回调执行段。验收原文:「有可靠 ID 时连接事件,无 ID 只
 * 展示候选关联并解释;禁止仅按方法名/邻近时间宣称因果。」
 *
 * 三条裁定红线(全部构造期可查):
 *   1. **causal 只认关联 ID**:两侧 correlationId 非空且相等才算因果(复用
 *      relateMessages 的裁定,不另设宽松规则);令牌面按 FLOW-026 设计=载荷
 *      opt-in,没装适配的来源天然无 ID;
 *   2. **候选必须解释**:缺侧/无对侧同 ID/ID 不一致 → candidate,reason 带
 *      出处与「禁止按方法名/邻近时间宣称因果」口径;同一方法名、时间邻近
 *      永远不升格 causal;
 *   3. **回调段=观察事实**:派发帧按 (进程,线程,帧全等,seq 在 receive 之后
 *      最近) 落到 call 事件;帧缺失或会话内没观察到该帧 → rootCallSeq=null
 *      如实,不猜。跨进程时间**不可比**(各时钟域,R4),因果方向只由 ID 配对
 *      决定,不做时间序裁剪。
 *
 * 纯核心,零 vscode 依赖;呈现面在 FLOW-028。
 */

import {
  relateMessages,
  type TraceSession,
  type TraceCallEvent,
  type TraceMessageSendEvent,
  type TraceMessageReceiveEvent
} from './traceEventModel';

export interface TraceCausalLink {
  kind: 'causal';
  correlationId: string;
  sendSeq: number;
  receiveSeq: number;
}

export interface TraceCandidateLink {
  kind: 'candidate';
  /** 单侧无对侧时另一侧为 null(如实) */
  sendSeq: number | null;
  receiveSeq: number | null;
  reason: string;
}

export interface TraceCallbackSegment {
  receiveSeq: number;
  /** 派发帧对应的本地 call(帧全等且 seq 在 receive 之后最近);观察不到=null 如实 */
  rootCallSeq: number | null;
  /** 回调执行段:根及其全部后代 call(前序) */
  callSeqs: number[];
  /** 执行段内 call 对应的 return 事件 seq */
  returnSeqs: number[];
  /** 根缺失/帧缺失时如实说明 */
  note: string | null;
}

export interface TraceCorrelationResult {
  causalLinks: TraceCausalLink[];
  candidateLinks: TraceCandidateLink[];
  callbackSegments: TraceCallbackSegment[];
}

function framesEqual(a: TraceCallEvent['frame'], b: TraceCallEvent['frame']): boolean {
  return (
    a.file === b.file && a.line === b.line && a.function === b.function && a.className === b.className
  );
}

function collectCallbackSubtree(session: TraceSession, rootSeq: number, threadId: string, processId: string): {
  callSeqs: number[];
  returnSeqs: number[];
} {
  const callsBySeq = new Map<number, TraceCallEvent>();
  const children = new Map<number, number[]>();
  for (const event of session.events) {
    if (event.kind !== 'call' || event.processId !== processId || event.threadId !== threadId) {
      continue;
    }
    callsBySeq.set(event.seq, event);
    const parent = event.parentSeq;
    if (parent !== null) {
      (children.get(parent) ?? children.set(parent, []).get(parent)!).push(event.seq);
    }
  }
  const callSeqs: number[] = [];
  const stack = [rootSeq];
  while (stack.length > 0) {
    const seq = stack.pop() as number;
    if (!callsBySeq.has(seq)) continue;
    callSeqs.push(seq);
    const kids = children.get(seq) ?? [];
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
  }
  const callSet = new Set(callSeqs);
  const returnSeqs = session.events
    .filter(event => event.kind === 'return' && callSet.has(event.correspondsToCallSeq))
    .map(event => event.seq);
  return { callSeqs, returnSeqs };
}

/**
 * 串联发送/接收与回调。裁定规则见文件头;配对判定一律走 relateMessages
 * (协议层),本函数只做索引、派发帧落地与候选解释。
 */
export function buildTraceCorrelations(session: TraceSession): TraceCorrelationResult {
  const sends = session.events.filter(
    (event): event is TraceMessageSendEvent => event.kind === 'message-send'
  );
  const receives = session.events.filter(
    (event): event is TraceMessageReceiveEvent => event.kind === 'message-receive'
  );

  // 按 ID 索引(null 不入索引——null 永远只给候选)
  const sendsById = new Map<string, typeof sends>();
  for (const send of sends) {
    if (send.correlationId === null) continue;
    const bucket = sendsById.get(send.correlationId) ?? [];
    bucket.push(send);
    sendsById.set(send.correlationId, bucket);
  }
  const receivesById = new Map<string, typeof receives>();
  for (const receive of receives) {
    if (receive.correlationId === null) continue;
    const bucket = receivesById.get(receive.correlationId) ?? [];
    bucket.push(receive);
    receivesById.set(receive.correlationId, bucket);
  }

  const causalLinks: TraceCausalLink[] = [];
  const candidateLinks: TraceCandidateLink[] = [];
  const matchedSendSeqs = new Set<number>();
  const matchedReceiveSeqs = new Set<number>();

  // causal:两侧 ID 非空且相等(relateMessages 裁定;1:N=N 次配对同判)
  for (const send of sends) {
    if (send.correlationId === null) continue;
    const peers = receivesById.get(send.correlationId) ?? [];
    for (const receive of peers) {
      const verdict = relateMessages(send, receive);
      if (verdict.kind === 'causal') {
        causalLinks.push({
          kind: 'causal',
          correlationId: verdict.correlationId,
          sendSeq: send.seq,
          receiveSeq: receive.seq
        });
        matchedSendSeqs.add(send.seq);
        matchedReceiveSeqs.add(receive.seq);
      }
    }
  }
  // ID 不一致的配对也过一遍裁定(=candidate,reason 带 mismatch 口径)
  for (const send of sends) {
    if (send.correlationId === null) continue;
    for (const receive of receives) {
      if (receive.correlationId === null || receive.correlationId === send.correlationId) continue;
      const verdict = relateMessages(send, receive);
      if (verdict.kind === 'candidate' && !matchedSendSeqs.has(send.seq) && !matchedReceiveSeqs.has(receive.seq)) {
        candidateLinks.push({
          kind: 'candidate',
          sendSeq: send.seq,
          receiveSeq: receive.seq,
          reason: verdict.reason
        });
        matchedSendSeqs.add(send.seq);
        matchedReceiveSeqs.add(receive.seq);
      }
    }
  }

  // 缺侧/无 ID:单侧候选,如实解释(FLOW-026:令牌面=载荷 opt-in,未装适配=无 ID)
  for (const send of sends) {
    if (matchedSendSeqs.has(send.seq)) continue;
    const idNote =
      send.correlationId === null
        ? '发送侧无关联 ID(FLOW-026:令牌面是载荷 opt-in,本来源未接适配)'
        : '发送侧有 ID 但会话内无对侧同 ID 接收';
    candidateLinks.push({
      kind: 'candidate',
      sendSeq: send.seq,
      receiveSeq: null,
      reason: `${idNote};只展示候选,禁止按方法名/邻近时间宣称因果(R4)`
    });
  }
  for (const receive of receives) {
    if (matchedReceiveSeqs.has(receive.seq)) continue;
    const idNote =
      receive.correlationId === null
        ? '接收侧无关联 ID(FLOW-026:令牌面是载荷 opt-in,本来源未接适配)'
        : '接收侧有 ID 但会话内无对侧同 ID 发送';
    candidateLinks.push({
      kind: 'candidate',
      sendSeq: null,
      receiveSeq: receive.seq,
      reason: `${idNote};只展示候选,禁止按方法名/邻近时间宣称因果(R4)`
    });
  }

  // 回调执行段:派发帧落地 + 后代子树收集(观察事实,不猜)
  const calls = session.events.filter((event): event is TraceCallEvent => event.kind === 'call');
  const callbackSegments: TraceCallbackSegment[] = receives.map(receive => {
    if (receive.frame === null) {
      return {
        receiveSeq: receive.seq,
        rootCallSeq: null,
        callSeqs: [],
        returnSeqs: [],
        note: '派发帧未被来源观察到(frame=null 如实);不猜本地执行段'
      };
    }
    const dispatchFrame = receive.frame;
    const root = calls
      .filter(
        call =>
          call.seq > receive.seq &&
          call.processId === receive.processId &&
          call.threadId === receive.threadId &&
          framesEqual(call.frame, dispatchFrame)
      )
      .sort((a, b) => a.seq - b.seq)[0];
    if (!root) {
      return {
        receiveSeq: receive.seq,
        rootCallSeq: null,
        callSeqs: [],
        returnSeqs: [],
        note: '会话内未观察到与派发帧全等的 call(可能在采集窗口外);不猜'
      };
    }
    const subtree = collectCallbackSubtree(session, root.seq, receive.threadId, receive.processId);
    return {
      receiveSeq: receive.seq,
      rootCallSeq: root.seq,
      callSeqs: subtree.callSeqs,
      returnSeqs: subtree.returnSeqs,
      note: null
    };
  });

  return { causalLinks, candidateLinks, callbackSegments };
}

/** 串联面摘要(诚实口径;呈现层/日志直接引用)。 */
export function describeTraceCorrelations(result: TraceCorrelationResult): string {
  const causal = result.causalLinks.length;
  const candidate = result.candidateLinks.length;
  const rooted = result.callbackSegments.filter(segment => segment.rootCallSeq !== null).length;
  return [
    `causal=${causal}(仅关联 ID 相等面)`,
    `candidate=${candidate}(无 ID/无对侧/ID 不一致;禁止按方法名/邻近时间宣称因果)`,
    `callbackSegments=${result.callbackSegments.length}(rooted=${rooted},其余=帧未观察到如实 null)`
  ].join('; ');
}
