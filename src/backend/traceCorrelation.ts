/**
 * KFLOW cross-process/callback correlation face (FLOW-027): on a traceEventModel
 * session, threads message-send / message-receive into causal edges or candidate
 * correlations, and grounds a message-receive's dispatch frame as a local callback
 * execution segment. Acceptance wording: "connect events when reliable IDs exist;
 * with no ID only show candidate correlations and explain; never claim causality
 * purely from a method name or time proximity."
 *
 * Three ruling red lines (all checkable at construction time):
 *   1. **causal accepts only correlation IDs**: an edge is causal only when both
 *      sides' correlationIds are non-null and equal (reusing relateMessages'
 *      ruling; no laxer rule set up separately); the token face per the FLOW-026
 *      design = payload opt-in, so sources without the adapter attached naturally
 *      have no ID;
 *   2. **candidates must be explained**: missing side / no counterpart with the same
 *      ID / ID mismatch → candidate, with reason carrying provenance and the "never
 *      claim causality from method name / time proximity" semantics; the same method
 *      name or time proximity never gets promoted to causal;
 *   3. **callback segments = observed facts**: the dispatch frame grounds onto a call
 *      event by (process, thread, frame fully equal, nearest seq after the receive);
 *      frame missing or unobserved in the session → rootCallSeq=null, honestly, no
 *      guessing. Cross-process times are **not comparable** (distinct clock domains,
 *      R4); the causal direction is decided only by ID pairing, never by timeline
 *      trimming.
 *
 * Pure core, zero vscode dependencies; the presentation face is FLOW-028.
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
  /** When one side has no counterpart, the other side is null (honest) */
  sendSeq: number | null;
  receiveSeq: number | null;
  reason: string;
}

export interface TraceCallbackSegment {
  receiveSeq: number;
  /** The local call grounding the dispatch frame (frame fully equal, nearest seq after the receive); unobservable = null, honestly */
  rootCallSeq: number | null;
  /** Callback execution segment: the root and all its descendant calls (pre-order) */
  callSeqs: number[];
  /** The seqs of the return events corresponding to the calls in the segment */
  returnSeqs: number[];
  /** An honest explanation when the root or the frame is missing */
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
 * Correlate sends/receives and callbacks. Ruling rules are in the file header; pairing
 * verdicts always go through relateMessages (the protocol layer); this function only
 * indexes, grounds dispatch frames, and explains candidates.
 */
export function buildTraceCorrelations(session: TraceSession): TraceCorrelationResult {
  const sends = session.events.filter(
    (event): event is TraceMessageSendEvent => event.kind === 'message-send'
  );
  const receives = session.events.filter(
    (event): event is TraceMessageReceiveEvent => event.kind === 'message-receive'
  );

  // Index by ID (null never enters the index — null only ever yields candidates)
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

  // causal: both sides' IDs non-null and equal (relateMessages ruling; 1:N = N pairings, each judged the same)
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
  // Mismatched-ID pairings also pass through the ruling (= candidate, with reason carrying the mismatch semantics)
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

  // Missing side / no ID: one-sided candidates, explained honestly (FLOW-026: token face = payload opt-in, no adapter attached = no ID)
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

  // Callback execution segments: dispatch-frame grounding + descendant-subtree collection (observed facts, no guessing)
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

/** Correlation-face summary (honest semantics; cited directly by the presentation layer / logs). */
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
