/**
 * KFLOW trace event protocol (the G3 runtime call-stack model of the FLOW-002 contract,
 * delivered by FLOW-023).
 *
 * Governing contract: docs/design/kflow-three-graph-contract.md §1-G3 + §2-R2/R4; the
 * collector-channel capability boundary follows the FLOW-022 verification report
 * (docs/review/2026-11-14-kflow-trace-01-feasibility.md). Acceptance mapping:
 *   session/process/thread/entity = TraceSession/TraceProcessRecord/TraceThreadRecord/
 *              event entityId (unknown = null, honestly);
 *   time      = event timestamp + TraceClockDomain (when cross-process clocks are not
 *              comparable, the linking layer only walks causal edges, never compares
 *              time — the R4 landing point);
 *   frame     = TraceFrame (real frame order = the same-thread seq/parentSeq chain);
 *   message correlation = message-send/receive events + correlationId (the only
 *              cross-process causal edge);
 *   source    = TraceSource (collector identity + sampling facts; R2 runtime-source
 *              typing);
 *   loss marks = TraceLossRecord + drop events (count reconciliation).
 *
 * Two construction-time red lines (no pretending to share a stack, FLOW-023 acceptance
 * wording):
 *   1. Synchronous stack edges (parentSeq/return chains) only allow same process, same
 *      thread — cross-thread/cross-process references throw immediately; the only legal
 *      form of cross-process linkage is a message causal edge (correlationId);
 *   2. Source and sample face are bound in a table (setprofile→complete-within-window,
 *      py-spy-record→sampled, etc.); a mismatch throws — a sampled stack never poses as
 *      a complete request trajectory (the FLOW-022 conclusion lands at the protocol layer).
 *
 * Pure protocol face (types + construction validation + relation rulings), zero vscode
 * dependencies; the capture entry is the independent FLOW-025 increment; the
 * import/replay consumer faces are FLOW-024/028.
 */

/** Runtime process role (G3 observation, same source as KSEM identity facts; bridge:* follows the G2 semantics). */
export type TraceProcessRole =
  | 'client'
  | 'base'
  | 'cell'
  | 'bridge:loginapp'
  | 'bridge:dbmgr'
  | 'bridge:interfaces'
  | 'bridge:other'
  | 'unknown';

/** Collector kind (one-to-one with the five FLOW-022 channels; settrace enters the protocol only, not the product face;
 *  sys-monitoring = the PEP 669 controlled per-event face, 3.12+, source verified by FLOW-024). */
export type TraceCollectorKind =
  | 'setprofile'
  | 'settrace'
  | 'sys-monitoring'
  | 'py-spy-dump'
  | 'py-spy-record'
  | 'debugpy-stop'
  | 'log-evidence';

/**
 * Sample face (the must-not-claim boundaries are given by describeSampleFace):
 *   complete-within-window —— complete per event inside a controlled window (unknown outside);
 *   sampled                —— sampled, calls between samples are invisible;
 *   stop-only              —— a single stop/ephemeral stack, no continuity;
 *   sparse-points          —— sparse evidence points (log face), no stack sequence.
 */
export type TraceSampleFace =
  | 'complete-within-window'
  | 'sampled'
  | 'stop-only'
  | 'sparse-points';

export interface TraceSource {
  kind: TraceCollectorKind;
  /** Collector/interpreter version; unknown = null, honestly (no guessing) */
  collectorVersion: string | null;
  sampleFace: TraceSampleFace;
  /** Sampling rate (record face = N Hz; other faces always null) */
  samplingHz: number | null;
  /** Controlled-window note (required for complete-within-window; null otherwise) */
  windowNote: string | null;
}

/** Clock basis: the meaning of an event timestamp is interpreted by basis; unknown = honest, the linking layer must not compare times. */
export interface TraceClockDomain {
  basis: 'epoch-ms' | 'process-mono' | 'unknown';
  note: string | null;
}

export interface TraceProcessRecord {
  processId: string;
  role: TraceProcessRole;
  /** Process name/command-line summary; unknown = null */
  name: string | null;
  /** Engine target Python version (for pairing checks with the capture component); unknown = null */
  enginePythonVersion: string | null;
}

export interface TraceThreadRecord {
  threadId: string;
  processId: string;
  name: string | null;
}

/** Real stack frame (G3 only; G2 does not use this type — the R1 vocabulary boundary). */
export interface TraceFrame {
  file: string;
  /** 1-based line number (keeps the source semantics, no conversion) */
  line: number;
  function: string;
  className: string | null;
}

export type TraceDropReason =
  | 'buffer-full'
  | 'collector-error'
  | 'unsupported'
  | 'clock-gap'
  | 'source-unknown';

export interface TraceDropEvent {
  seq: number;
  /** Ledger time; loss summarized when the capture side ends may have no timestamp = omitted (no fabricated timeline) */
  timestamp?: number;
  /** Owning process; session-level loss = null */
  processId: string | null;
  reason: TraceDropReason;
  count: number;
  note: string | null;
}

export interface TraceLossRecord {
  /** Total dropped count (reconciled against the drops counts at construction; a mismatch throws) */
  totalDropped: number;
  drops: TraceDropEvent[];
  /** Completeness note (e.g. "sample face: invisible between samples"; an honest statement of the source) */
  completenessNote: string;
}

interface TraceEventCommon {
  /** Unique within the session, strictly increasing, assigned by the constructor (callers do not carry it) */
  seq: number;
  timestamp: number;
  processId: string;
  threadId: string;
  /** Entity identity (e.g. 'Avatar#42'); unobservable = null, honestly */
  entityId: string | null;
}

export interface TraceCallEvent extends TraceEventCommon {
  kind: 'call';
  frame: TraceFrame;
  /** Same-thread synchronous stack edge: the parent call's seq (thread root = null); cross-thread/cross-process references throw at construction */
  parentSeq: number | null;
}

export interface TraceReturnEvent extends TraceEventCommon {
  kind: 'return';
  /** The corresponding call's seq (same thread, validated at construction) */
  correspondsToCallSeq: number;
  returnValueNote: string | null;
}

export interface TraceExceptionEvent extends TraceEventCommon {
  kind: 'exception';
  /** The seq of the call where the throw occurred; unknown = null */
  atSeq: number | null;
  exceptionType: string | null;
  message: string | null;
  /** Whether it propagates upward; unknown = null */
  propagated: boolean | null;
}

export interface TraceMessageSendEvent extends TraceEventCommon {
  kind: 'message-send';
  fromEntityId: string | null;
  /** Target process (e.g. entities.get, an engine reference whose target is unobservable = null) */
  toProcessId: string | null;
  toRole: TraceProcessRole | null;
  toEntityId: string | null;
  methodName: string;
  /** The sole carrier of a cross-process causal edge; the source has no correlation ID = null (candidate correlation only, no causal claim) */
  correlationId: string | null;
}

export interface TraceMessageReceiveEvent extends TraceEventCommon {
  kind: 'message-receive';
  methodName: string;
  fromEntityId: string | null;
  /** The first frame entered at dispatch (unobservable = null) */
  frame: TraceFrame | null;
  correlationId: string | null;
}

export type TraceEvent =
  | TraceCallEvent
  | TraceReturnEvent
  | TraceExceptionEvent
  | TraceMessageSendEvent
  | TraceMessageReceiveEvent;

export interface TraceSession {
  sessionId: string;
  source: TraceSource;
  clock: TraceClockDomain;
  processes: TraceProcessRecord[];
  threads: TraceThreadRecord[];
  events: TraceEvent[];
  loss: TraceLossRecord;
}

/** Legal pairing table between collector kind and sample face (FLOW-022 conclusion; a mismatch throws). */
const COLLECTOR_FACE_TABLE: Record<TraceCollectorKind, TraceSampleFace> = {
  setprofile: 'complete-within-window',
  settrace: 'complete-within-window',
  'sys-monitoring': 'complete-within-window',
  'py-spy-dump': 'stop-only',
  'py-spy-record': 'sampled',
  'debugpy-stop': 'stop-only',
  'log-evidence': 'sparse-points'
};

/** The sample-face must-not-claim boundaries (semantics cited directly by the R2/R3 presentation layer). */
export function describeSampleFace(face: TraceSampleFace): string {
  switch (face) {
    case 'complete-within-window':
      return '受控窗口内逐事件完整;窗口外未知,不宣称全程轨迹';
    case 'sampled':
      return '采样栈:样本之间的调用不可见,不冒充完整请求轨迹';
    case 'stop-only':
      return '单次停止/瞬时栈:无连续性,两次停止之间不可见';
    case 'sparse-points':
      return '稀疏证据点:无栈序列,事件间只允许候选关联';
  }
}

/** Distributed Omit (removes seq per union member, preserving the discriminant field) */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** Event input face (carries no seq; the constructor assigns it uniformly); shared by the import face and the capture wiring. */
export type TraceEventInput = DistributiveOmit<TraceEvent, 'seq'>;

export interface TraceSessionInput {
  sessionId: string;
  source: TraceSource;
  clock: TraceClockDomain;
  processes: TraceProcessRecord[];
  threads: TraceThreadRecord[];
  /** Events (no seq carried; assigned uniformly by the constructor) */
  events: TraceEventInput[];
  /** Session-level/process-level drop records (the compact form without seq/timestamp + optional timestamp) */
  drops?: Array<Omit<TraceDropEvent, 'seq' | 'timestamp'> & { timestamp?: number }>;
  completenessNote?: string;
}

/**
 * Build a trace session: assign seq, validate red lines. Validation failures throw
 * (honest failure, no silent trimming):
 *   - the source/sample-face pairing table;
 *   - per-thread monotone non-decreasing timestamps;
 *   - parentSeq/correspondsToCallSeq must point at an **earlier same-thread** event
 *     (cross-thread/cross-process synchronous stack edges = a disguised shared stack,
 *     rejected outright);
 *   - the drop counts reconcile against totalDropped.
 */
export function buildTraceSession(input: TraceSessionInput): TraceSession {
  const face = COLLECTOR_FACE_TABLE[input.source.kind];
  if (face !== input.source.sampleFace) {
    throw new Error(
      `trace source 配对非法:采集器 ${input.source.kind} 的采样面必须是 ${face},收到 ${input.source.sampleFace}(采样栈不冒充完整请求轨迹)`
    );
  }
  if (input.source.sampleFace === 'sampled' && !(input.source.samplingHz !== null && input.source.samplingHz > 0)) {
    throw new Error('采样面 sampled 必须携带 samplingHz>0');
  }
  if (input.source.sampleFace !== 'sampled' && input.source.samplingHz !== null) {
    throw new Error(`采样面 ${input.source.sampleFace} 不得携带 samplingHz`);
  }
  if (input.source.sampleFace === 'complete-within-window' && !input.source.windowNote) {
    throw new Error('complete-within-window 必须携带受控窗口说明 windowNote');
  }

  const threadClock = new Map<string, number>();
  const knownThreads = new Set(input.threads.map(thread => thread.threadId));
  const knownProcesses = new Set(input.processes.map(process => process.processId));

  let nextSeq = 0;
  const events: TraceEvent[] = [];
  for (const raw of input.events) {
    const seq = nextSeq;
    nextSeq += 1;
    if (!knownProcesses.has(raw.processId)) {
      throw new Error(`trace 事件 seq#${seq} 引用未登记进程 ${raw.processId}`);
    }
    if (!knownThreads.has(raw.threadId)) {
      throw new Error(`trace 事件 seq#${seq} 引用未登记线程 ${raw.threadId}`);
    }
    const clockKey = `${raw.processId}\u001f${raw.threadId}`;
    const lastTime = threadClock.get(clockKey);
    if (lastTime !== undefined && raw.timestamp < lastTime) {
      throw new Error(
        `trace 事件 seq#${seq} 时间回退(${raw.timestamp} < ${lastTime},线程 ${raw.threadId});时间轴不造假`
      );
    }
    threadClock.set(clockKey, raw.timestamp);
    if (raw.kind === 'call') {
      if (raw.parentSeq !== null) {
        if (raw.parentSeq >= seq) {
          throw new Error(`trace call seq#${seq} 的 parentSeq#${raw.parentSeq} 指向未构造事件(栈链必须向早)`);
        }
        const parent = events[raw.parentSeq];
        if (!parent || parent.kind !== 'call') {
          throw new Error(`trace call seq#${seq} 的 parentSeq#${raw.parentSeq} 不指向 call 事件`);
        }
        if (parent.processId !== raw.processId || parent.threadId !== raw.threadId) {
          throw new Error(
            `trace call seq#${seq} 的同步栈边跨线程/跨进程(${parent.processId}/${parent.threadId} → ${raw.processId}/${raw.threadId});跨进程衔接只允许消息因果边(correlationId)`
          );
        }
      }
    }
    if (raw.kind === 'return') {
      if (raw.correspondsToCallSeq >= seq) {
        throw new Error(`trace return seq#${seq} 对应链指向未构造事件`);
      }
      const call = events[raw.correspondsToCallSeq];
      if (!call || call.kind !== 'call') {
        throw new Error(`trace return seq#${seq} 的对应链不指向 call 事件`);
      }
      if (call.processId !== raw.processId || call.threadId !== raw.threadId) {
        throw new Error(
          `trace return seq#${seq} 的对应链跨线程/跨进程;同步 return 边只住同线程`
        );
      }
    }
    events.push({ ...raw, seq } as TraceEvent);
  }

  // Loss marks: totalDropped is generated by the constructor from the drops counts (callers do not report numbers separately)
  let dropSeq = nextSeq;
  let totalDropped = 0;
  const drops: TraceDropEvent[] = [];
  for (const raw of input.drops ?? []) {
    if (raw.count <= 0) {
      throw new Error('trace drop 事件 count 必须 >0(零丢弃不入账)');
    }
    drops.push({ ...raw, seq: dropSeq });
    dropSeq += 1;
    totalDropped += raw.count;
  }

  return {
    sessionId: input.sessionId,
    source: input.source,
    clock: input.clock,
    processes: input.processes,
    threads: input.threads,
    events,
    loss: {
      totalDropped,
      drops,
      completenessNote:
        input.completenessNote ?? describeSampleFace(input.source.sampleFace)
    }
  };
}

/** Message correlation ruling (the FLOW-027 precondition): only when both sides carry a non-null equal correlationId is it a causal edge. */
export type TraceMessageRelation =
  | { kind: 'causal'; correlationId: string }
  | { kind: 'candidate'; reason: string };

export function relateMessages(
  send: TraceMessageSendEvent,
  receive: TraceMessageReceiveEvent
): TraceMessageRelation {
  if (send.correlationId !== null && receive.correlationId !== null) {
    if (send.correlationId === receive.correlationId) {
      return { kind: 'causal', correlationId: send.correlationId };
    }
    return {
      kind: 'candidate',
      reason: `correlationId 不一致(send=${send.correlationId}, receive=${receive.correlationId});不得宣称因果`
    };
  }
  const missing = send.correlationId === null ? '发送侧' : '接收侧';
  return {
    kind: 'candidate',
    reason: `${missing}无关联 ID(FLOW-026 未核实来源);只允许候选关联,禁止按方法名/邻近时间宣称因果`
  };
}
