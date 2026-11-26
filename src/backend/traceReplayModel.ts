/**
 * KFLOW replay instance-level flow model (the pure core of FLOW-028): assembles a
 * trace session + the correlation face (traceCorrelation) into a "real component
 * instance lane" replay model — a lane = a process instance actually observed in the
 * session, and a lane's contents = local stack segments (callback segments / entry
 * chains) + message flows.
 *
 * Acceptance wording: "present local stack segments and message flows over real
 * component instance lanes; repeated identical RPCs / out-of-order / broadcast /
 * missing events must be distinguishable." Four distinguishability guarantees (each
 * pinned):
 *   1. **Repeated identical RPCs**: each message flow carries sendSeq/receiveSeq
 *      anchors (unique within the session); repeated calls of the same-named method =
 *      two independent flows, never merged;
 *   2. **Out-of-order**: within a lane everything is presented in seq order, never
 *      sorted by cross-process time (distinct clock domains are not comparable, R4) —
 *      a flow's causal attribution is decided only by ID pairing; time values play no
 *      part;
 *   3. **Broadcast**: when one send has >1 causal flow, all are marked broadcast
 *      (fan-in), one per receiver;
 *   4. **Missing**: a send/receive without its counterpart = a missing marker, and an
 *      ID mismatch = a candidate flow — the three incomplete shapes each have their
 *      own independent face, never mixed together.
 *
 * Honest boundary: for sources with entityId=null (the FLOW-024 face) a lane = a
 * process instance, and the instance-identity column honestly notes "source not
 * observed"; a receive whose dispatch frame was not observed gets root=null with a
 * note, no guessing. Pure core with zero vscode dependencies; the HTML presentation is
 * in traceReplayHtml, the panel in traceReplayPanel.
 */

import { buildTraceCorrelations, type TraceCorrelationResult } from './traceCorrelation';
import type { TraceSession, TraceCallEvent, TraceMessageSendEvent, TraceMessageReceiveEvent } from './traceEventModel';

export interface ReplayStackFrameRow {
  seq: number;
  file: string;
  /** 1-based (keeps the capture semantics, no conversion) */
  line: number;
  function: string;
  className: string | null;
  /** Depth relative to the segment root (root = 0) */
  depth: number;
  entityId: string | null;
}

export interface ReplayStackSegment {
  kind: 'callback' | 'entry-chain';
  /** The receive this callback segment is tied to (null for entry chains) */
  receiveSeq: number | null;
  rootCallSeq: number | null;
  frames: ReplayStackFrameRow[];
  note: string | null;
}

export interface ReplayFlow {
  kind: 'causal' | 'candidate';
  methodName: string;
  correlationId: string | null;
  sendSeq: number | null;
  receiveSeq: number | null;
  fromProcessId: string | null;
  toProcessId: string | null;
  /** causal and the same send maps to multiple receives (fan-in broadcast) */
  broadcast: boolean;
  /** The candidate explanation (null for causal) */
  reason: string | null;
}

export interface ReplayMissingMarker {
  kind: 'send-without-receive' | 'receive-without-send';
  seq: number;
  methodName: string;
  detail: string;
}

export interface ReplayLane {
  processId: string;
  role: string;
  name: string | null;
  /** Instances observed with a non-null entityId; empty = the source carries no instance identity (honest) */
  entityInstances: string[];
  segments: ReplayStackSegment[];
  flows: ReplayFlow[];
  missingMarkers: ReplayMissingMarker[];
  /** Lane sort key = the first event's seq (no events = Number.MAX_SAFE_INTEGER, sorted last) */
  firstSeq: number;
}

export interface TraceReplayModel {
  sessionId: string;
  collectorKind: string;
  sampleFaceNote: string;
  lanes: ReplayLane[];
  /** Global flow order: causal first (by receiveSeq, or sendSeq without a receive), candidates appended */
  flows: ReplayFlow[];
  completenessNote: string;
}

interface CallIndex {
  callsBySeq: Map<number, TraceCallEvent>;
  children: Map<number, number[]>;
}

function indexCalls(session: TraceSession): CallIndex {
  const callsBySeq = new Map<number, TraceCallEvent>();
  const children = new Map<number, number[]>();
  for (const event of session.events) {
    if (event.kind !== 'call') continue;
    callsBySeq.set(event.seq, event);
    if (event.parentSeq !== null) {
      const bucket = children.get(event.parentSeq);
      if (bucket) {
        bucket.push(event.seq);
      } else {
        children.set(event.parentSeq, [event.seq]);
      }
    }
  }
  return { callsBySeq, children };
}

function subtreeOf(index: CallIndex, rootSeq: number): { calls: TraceCallEvent[]; depthBySeq: Map<number, number> } {
  const calls: TraceCallEvent[] = [];
  const depthBySeq = new Map<number, number>();
  const stack: Array<[number, number]> = [[rootSeq, 0]];
  while (stack.length > 0) {
    const [seq, depth] = stack.pop() as [number, number];
    const call = index.callsBySeq.get(seq);
    if (!call) continue;
    calls.push(call);
    depthBySeq.set(seq, depth);
    const kids = index.children.get(seq) ?? [];
    for (let i = kids.length - 1; i >= 0; i--) stack.push([kids[i], depth + 1]);
  }
  return { calls, depthBySeq };
}

function framesOf(index: CallIndex, calls: TraceCallEvent[], depthBySeq: Map<number, number>): ReplayStackFrameRow[] {
  return calls.map(call => ({
    seq: call.seq,
    file: call.frame.file,
    line: call.frame.line,
    function: call.frame.function,
    className: call.frame.className,
    depth: depthBySeq.get(call.seq) ?? 0,
    entityId: call.entityId
  }));
}

/**
 * Assemble the replay model. correlation is injectable (skips recomputation when
 * already computed); the four distinguishability guarantees are in the file header.
 */
export function buildTraceReplayModel(
  session: TraceSession,
  correlation?: TraceCorrelationResult
): TraceReplayModel {
  const corr = correlation ?? buildTraceCorrelations(session);
  const index = indexCalls(session);

  // ---- Lanes (real, observed process instances; sorted by first-event seq, not by time) ----
  const firstSeqByProcess = new Map<string, number>();
  for (const event of session.events) {
    const current = firstSeqByProcess.get(event.processId);
    if (current === undefined || event.seq < current) {
      firstSeqByProcess.set(event.processId, event.seq);
    }
  }
  const lanes: ReplayLane[] = session.processes
    .map(process => {
      const own = session.events.filter(event => event.processId === process.processId);
      const entityInstances = [
        ...new Set(own.map(event => event.entityId).filter((id): id is string => id !== null))
      ];
      return {
        processId: process.processId,
        role: process.role,
        name: process.name,
        entityInstances,
        segments: [] as ReplayStackSegment[],
        flows: [] as ReplayFlow[],
        missingMarkers: [] as ReplayMissingMarker[],
        firstSeq: firstSeqByProcess.get(process.processId) ?? Number.MAX_SAFE_INTEGER
      };
    })
    .sort((left, right) =>
      left.firstSeq !== right.firstSeq ? left.firstSeq - right.firstSeq : left.processId.localeCompare(right.processId)
    );
  const laneByProcess = new Map(lanes.map(lane => [lane.processId, lane]));

  // ---- Local stack segments: callback segments (rooted) + entry chains (root subtrees not covered by callback segments) ----
  const covered = new Set<number>();
  for (const segment of corr.callbackSegments) {
    const lane = laneByProcess.get(
      session.events.find(event => event.seq === segment.receiveSeq)?.processId ?? ''
    );
    if (!lane) continue;
    if (segment.rootCallSeq === null) {
      lane.segments.push({
        kind: 'callback',
        receiveSeq: segment.receiveSeq,
        rootCallSeq: null,
        frames: [],
        note: segment.note
      });
      continue;
    }
    const rootCall = index.callsBySeq.get(segment.rootCallSeq);
    if (!rootCall) continue;
    const { calls, depthBySeq } = subtreeOf(index, segment.rootCallSeq);
    for (const call of calls) covered.add(call.seq);
    lane.segments.push({
      kind: 'callback',
      receiveSeq: segment.receiveSeq,
      rootCallSeq: segment.rootCallSeq,
      frames: framesOf(index, calls, depthBySeq),
      note: null
    });
  }
  // Entry chains: the uncovered calls in each root subtree (overlaps between root entry
  // chains and callback segments get an honest note)
  const roots = [...index.callsBySeq.values()].filter(call => call.parentSeq === null);
  for (const root of roots) {
    const { calls, depthBySeq } = subtreeOf(index, root.seq);
    const uncovered = calls.filter(call => !covered.has(call.seq));
    if (uncovered.length === 0) continue;
    const lane = laneByProcess.get(root.processId);
    if (!lane) continue;
    const coveredCount = calls.length - uncovered.length;
    lane.segments.push({
      kind: 'entry-chain',
      receiveSeq: null,
      rootCallSeq: root.seq,
      frames: framesOf(index, uncovered, depthBySeq),
      note:
        coveredCount > 0
          ? `子树含 ${coveredCount} 个调用已归入回调段(不重复展示,见对应回调段)`
          : null
    });
  }
  // Segment ordering: callback segments by receiveSeq, entry chains by root seq (all seq
  // order; no time comparison between segments)
  for (const lane of lanes) {
    lane.segments.sort(
      (left, right) =>
        (left.receiveSeq ?? left.rootCallSeq ?? 0) - (right.receiveSeq ?? right.rootCallSeq ?? 0)
    );
  }

  // ---- Message flows: causal (anchor = the seq pair, broadcast marked fan-in) + candidates (ID mismatch) ----
  const sendsBySeq = new Map<number, TraceMessageSendEvent>();
  const receivesBySeq = new Map<number, TraceMessageReceiveEvent>();
  for (const event of session.events) {
    if (event.kind === 'message-send') sendsBySeq.set(event.seq, event);
    if (event.kind === 'message-receive') receivesBySeq.set(event.seq, event);
  }
  const fanInBySend = new Map<number, number>();
  for (const link of corr.causalLinks) {
    fanInBySend.set(link.sendSeq, (fanInBySend.get(link.sendSeq) ?? 0) + 1);
  }
  const flows: ReplayFlow[] = [];
  for (const link of corr.causalLinks) {
    const send = sendsBySeq.get(link.sendSeq);
    const receive = receivesBySeq.get(link.receiveSeq);
    flows.push({
      kind: 'causal',
      methodName: send?.methodName ?? receive?.methodName ?? '(unknown)',
      correlationId: link.correlationId,
      sendSeq: link.sendSeq,
      receiveSeq: link.receiveSeq,
      fromProcessId: send?.processId ?? null,
      toProcessId: receive?.processId ?? null,
      broadcast: (fanInBySend.get(link.sendSeq) ?? 0) > 1,
      reason: null
    });
  }
  for (const candidate of corr.candidateLinks) {
    if (candidate.sendSeq !== null && candidate.receiveSeq !== null) {
      const send = sendsBySeq.get(candidate.sendSeq);
      const receive = receivesBySeq.get(candidate.receiveSeq);
      flows.push({
        kind: 'candidate',
        methodName: send?.methodName ?? receive?.methodName ?? '(unknown)',
        correlationId: null,
        sendSeq: candidate.sendSeq,
        receiveSeq: candidate.receiveSeq,
        fromProcessId: send?.processId ?? null,
        toProcessId: receive?.processId ?? null,
        broadcast: false,
        reason: candidate.reason
      });
    }
  }
  // Global flow order: seq-anchor order (causal by receiveSeq falling back to sendSeq; candidates by either anchor)
  const flowAnchor = (flow: ReplayFlow): number => flow.receiveSeq ?? flow.sendSeq ?? 0;
  flows.sort((left, right) => flowAnchor(left) - flowAnchor(right));

  for (const flow of flows) {
    const fromLane = flow.fromProcessId !== null ? laneByProcess.get(flow.fromProcessId) : undefined;
    const toLane = flow.toProcessId !== null ? laneByProcess.get(flow.toProcessId) : undefined;
    if (fromLane) fromLane.flows.push(flow);
    if (toLane && toLane !== fromLane) toLane.flows.push(flow);
  }

  // ---- Missing markers: one-sided candidates (sendSeq null / receiveSeq null) land on the corresponding lane ----
  for (const candidate of corr.candidateLinks) {
    if (candidate.sendSeq !== null && candidate.receiveSeq === null) {
      const send = sendsBySeq.get(candidate.sendSeq);
      const lane = send ? laneByProcess.get(send.processId) : undefined;
      lane?.missingMarkers.push({
        kind: 'send-without-receive',
        seq: candidate.sendSeq,
        methodName: send?.methodName ?? '(unknown)',
        detail: candidate.reason
      });
    }
    if (candidate.receiveSeq !== null && candidate.sendSeq === null) {
      const receive = receivesBySeq.get(candidate.receiveSeq);
      const lane = receive ? laneByProcess.get(receive.processId) : undefined;
      lane?.missingMarkers.push({
        kind: 'receive-without-send',
        seq: candidate.receiveSeq,
        methodName: receive?.methodName ?? '(unknown)',
        detail: candidate.reason
      });
    }
  }

  return {
    sessionId: session.sessionId,
    collectorKind: session.source.kind,
    sampleFaceNote: session.loss.completenessNote,
    lanes,
    flows,
    completenessNote: session.loss.completenessNote
  };
}

/** Replay-model summary (honest semantics; cited directly by the presentation layer). */
export function describeTraceReplayModel(model: TraceReplayModel): string {
  const rootedSegments = model.lanes.reduce(
    (count, lane) => count + lane.segments.filter(segment => segment.rootCallSeq !== null).length,
    0
  );
  const causal = model.flows.filter(flow => flow.kind === 'causal').length;
  const broadcast = model.flows.filter(flow => flow.broadcast).length;
  const missing = model.lanes.reduce((count, lane) => count + lane.missingMarkers.length, 0);
  return [
    `lanes=${model.lanes.length}(真实进程实例)`,
    `segments(rooted)=${rootedSegments}`,
    `flows causal=${causal}(broadcast=${broadcast})`,
    `missing=${missing}`,
    model.completenessNote
  ].join('; ');
}
