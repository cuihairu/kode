/**
 * KFLOW 回放实例级流转模型(FLOW-028 的纯核):把 trace 会话 + 串联面
 * (traceCorrelation)装配成「真实组件实例泳道」回放模型——泳道=会话内
 * 真实观察到的进程实例,泳道内=本地栈段(回调段/入口链)+消息流。
 *
 * 验收原文:「以真实组件实例泳道展示本地栈段和消息流;多次相同 RPC/乱序/
 * 广播/缺失事件可区分。」四条可区分性保证(每条有钉):
 *   1. **多次相同 RPC**:每条消息流带 sendSeq/receiveSeq 锚(会话内唯一),
 *      同名方法重复调用=两条独立流,不合并;
 *   2. **乱序**:泳道内一律按 seq 序展示,不做跨进程时间排序(各时钟域
 *      不可比,R4)——流的因果归属只由 ID 配对决定,时间数值不参与;
 *   3. **广播**:同一 send 的 causal 流>1 条时全部标 broadcast(fan-in),
 *      逐接收者各一条;
 *   4. **缺失**:无对侧发送/接收=缺失标记(marker),ID 不一致=候选流——
 *      三种不完整形态各有独立面,不混装。
 *
 * 诚实边界:entityId=null 的来源(FLOW-024 面)泳道=进程实例,实例身份列
 * 如实标「来源未观察」;派发帧未观察到的 receive 根=null 带 note,不猜。
 * 纯核心零 vscode 依赖;HTML 呈现见 traceReplayHtml,面板见 traceReplayPanel。
 */

import { buildTraceCorrelations, type TraceCorrelationResult } from './traceCorrelation';
import type { TraceSession, TraceCallEvent, TraceMessageSendEvent, TraceMessageReceiveEvent } from './traceEventModel';

export interface ReplayStackFrameRow {
  seq: number;
  file: string;
  /** 1 基(保留采集口径,不换算) */
  line: number;
  function: string;
  className: string | null;
  /** 相对段根深度(根=0) */
  depth: number;
  entityId: string | null;
}

export interface ReplayStackSegment {
  kind: 'callback' | 'entry-chain';
  /** callback 段关联的 receive(入口链=null) */
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
  /** causal 且同一 send 对多个 receive(fan-in 广播) */
  broadcast: boolean;
  /** candidate 解释(causal=null) */
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
  /** 观察到非 null entityId 的实例;空=来源无实例身份(如实) */
  entityInstances: string[];
  segments: ReplayStackSegment[];
  flows: ReplayFlow[];
  missingMarkers: ReplayMissingMarker[];
  /** 泳道排序键=首个事件 seq(事件空=Number.MAX_SAFE_INTEGER,排末尾) */
  firstSeq: number;
}

export interface TraceReplayModel {
  sessionId: string;
  collectorKind: string;
  sampleFaceNote: string;
  lanes: ReplayLane[];
  /** 全局流序:causal 先(按 receiveSeq,无 receive 按 sendSeq),候选追加 */
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
 * 装配回放模型。correlation 可注入(已算过时免重算);四条可区分性保证
 * 见文件头。
 */
export function buildTraceReplayModel(
  session: TraceSession,
  correlation?: TraceCorrelationResult
): TraceReplayModel {
  const corr = correlation ?? buildTraceCorrelations(session);
  const index = indexCalls(session);

  // ---- 泳道(真实观察到的进程实例;按首事件 seq 排序,不按时间)----
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

  // ---- 本地栈段:回调段(rooted)+ 入口链(未被回调段覆盖的根子树)----
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
  // 入口链:每棵根子树里未covered的调用(根入口链与回调段重叠处如实注记)
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
  // 段排序:回调段按 receiveSeq,入口链按根 seq(全部 seq 序,段间不比时间)
  for (const lane of lanes) {
    lane.segments.sort(
      (left, right) =>
        (left.receiveSeq ?? left.rootCallSeq ?? 0) - (right.receiveSeq ?? right.rootCallSeq ?? 0)
    );
  }

  // ---- 消息流:causal(锚=seq 对,广播标 fan-in)+ 候选(ID 不一致)----
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
  // 全局流序:seq 锚序(causal 按 receiveSeq 回退 sendSeq;候选按两侧锚)
  const flowAnchor = (flow: ReplayFlow): number => flow.receiveSeq ?? flow.sendSeq ?? 0;
  flows.sort((left, right) => flowAnchor(left) - flowAnchor(right));

  for (const flow of flows) {
    const fromLane = flow.fromProcessId !== null ? laneByProcess.get(flow.fromProcessId) : undefined;
    const toLane = flow.toProcessId !== null ? laneByProcess.get(flow.toProcessId) : undefined;
    if (fromLane) fromLane.flows.push(flow);
    if (toLane && toLane !== fromLane) toLane.flows.push(flow);
  }

  // ---- 缺失标记:单侧候选(sendSeq null / receiveSeq null)落到对应泳道 ----
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

/** 回放模型摘要(诚实口径;呈现层直接引用)。 */
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
