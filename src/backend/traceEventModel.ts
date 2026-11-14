/**
 * KFLOW trace 事件协议(FLOW-002 契约的 G3 运行时调用栈模型,FLOW-023 交付)。
 *
 * 上位契约:docs/design/kflow-three-graph-contract.md §1-G3 + §2-R2/R4;采集
 * 渠道能力边界以 FLOW-022 核实报告为准(docs/review/
 * 2026-11-14-kflow-trace-01-feasibility.md)。验收映射:
 *   会话/进程/线程/实体 = TraceSession/TraceProcessRecord/TraceThreadRecord/
 *              事件 entityId(未知=null 如实);
 *   时间      = 事件 timestamp + TraceClockDomain(跨进程时钟不可比时链接层
 *              只走因果边,不比时间——R4 落点);
 *   帧        = TraceFrame(真实帧顺序=同线程 seq/parentSeq 链);
 *   消息关联  = message-send/receive 事件 + correlationId(唯一跨进程因果边);
 *   来源      = TraceSource(采集器标识+采样事实;R2 runtime-source 分型);
 *   丢失标记 = TraceLossRecord + drop 事件(数量对账)。
 *
 * 两条构造期红线(不伪装共享栈,FLOW-023 验收原文):
 *   1. 同步栈边(parentSeq/return 链)只允许同进程同线程——跨线程/跨进程
 *      引用直接抛错;跨进程衔接唯一合法形态是消息因果边(correlationId);
 *   2. 来源与采样面绑定成表(setprofile→complete-within-window、
 *      py-spy-record→sampled 等),配错即抛——采样栈不冒充完整请求轨迹
 *      (FLOW-022 结论落到协议层)。
 *
 * 纯协议面(类型+构造校验+关系裁定),零 vscode 依赖;采集入口是 FLOW-025
 * 独立增量,导入/回放消费面在 FLOW-024/028。
 */

/** 运行时进程角色(G3 观察,KSEM 身份事实同源;bridge:* 同 G2 口径)。 */
export type TraceProcessRole =
  | 'client'
  | 'base'
  | 'cell'
  | 'bridge:loginapp'
  | 'bridge:dbmgr'
  | 'bridge:interfaces'
  | 'bridge:other'
  | 'unknown';

/** 采集器形态(与 FLOW-022 五渠道一一对应;settrace 只进协议不进产品面)。 */
export type TraceCollectorKind =
  | 'setprofile'
  | 'settrace'
  | 'py-spy-dump'
  | 'py-spy-record'
  | 'debugpy-stop'
  | 'log-evidence';

/**
 * 采样面(不得宣称的边界由 describeSampleFace 给出):
 *   complete-within-window —— 受控窗口内逐事件完整(窗口外未知);
 *   sampled                —— 采样,样本之间的调用不可见;
 *   stop-only              —— 单次停止/瞬时栈,无连续性;
 *   sparse-points          —— 稀疏证据点(日志面),无栈序列。
 */
export type TraceSampleFace =
  | 'complete-within-window'
  | 'sampled'
  | 'stop-only'
  | 'sparse-points';

export interface TraceSource {
  kind: TraceCollectorKind;
  /** 采集器/解释器版本;未知=null 如实(不猜) */
  collectorVersion: string | null;
  sampleFace: TraceSampleFace;
  /** 采样率(record 面=N Hz;其余面恒 null) */
  samplingHz: number | null;
  /** 受控窗口说明(complete-within-window 必填;其余 null) */
  windowNote: string | null;
}

/** 时间基准:事件 timestamp 的含义由 basis 解释;unknown=如实,链接层禁比时间。 */
export interface TraceClockDomain {
  basis: 'epoch-ms' | 'process-mono' | 'unknown';
  note: string | null;
}

export interface TraceProcessRecord {
  processId: string;
  role: TraceProcessRole;
  /** 进程名/命令行摘要;未知=null */
  name: string | null;
  /** 引擎目标 Python 版本(与采集组件配对核对用);未知=null */
  enginePythonVersion: string | null;
}

export interface TraceThreadRecord {
  threadId: string;
  processId: string;
  name: string | null;
}

/** 真实栈帧(G3 专用;G2 不使用本类型——R1 词汇分界)。 */
export interface TraceFrame {
  file: string;
  /** 1 基行号(保留来源口径,不换算) */
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
  timestamp: number;
  /** 归属进程;会话级丢失=null */
  processId: string | null;
  reason: TraceDropReason;
  count: number;
  note: string | null;
}

export interface TraceLossRecord {
  /** 丢弃总数(构造期与 drops 计数对账,不一致抛错) */
  totalDropped: number;
  drops: TraceDropEvent[];
  /** 完整性备注(如「采样面:样本间不可见」;来源如实陈述) */
  completenessNote: string;
}

interface TraceEventCommon {
  /** 会话内唯一、由构造器严格递增分配(调用方不携带) */
  seq: number;
  timestamp: number;
  processId: string;
  threadId: string;
  /** 实体身份(如 'Avatar#42');观察不到=null 如实 */
  entityId: string | null;
}

export interface TraceCallEvent extends TraceEventCommon {
  kind: 'call';
  frame: TraceFrame;
  /** 同线程同步栈边:父 call 的 seq(线程根=null);跨线程/跨进程引用构造期抛错 */
  parentSeq: number | null;
}

export interface TraceReturnEvent extends TraceEventCommon {
  kind: 'return';
  /** 对应 call 的 seq(同线程,构造期校验) */
  correspondsToCallSeq: number;
  returnValueNote: string | null;
}

export interface TraceExceptionEvent extends TraceEventCommon {
  kind: 'exception';
  /** 抛出位置所在 call 的 seq;未知=null */
  atSeq: number | null;
  exceptionType: string | null;
  message: string | null;
  /** 是否向上传播;未知=null */
  propagated: boolean | null;
}

export interface TraceMessageSendEvent extends TraceEventCommon {
  kind: 'message-send';
  fromEntityId: string | null;
  /** 目标进程(如 entities.get 引擎引用观察不到目标=null) */
  toProcessId: string | null;
  toRole: TraceProcessRole | null;
  toEntityId: string | null;
  methodName: string;
  /** 跨进程因果边唯一载体;来源没有关联 ID=null(只允许候选关联,不宣称因果) */
  correlationId: string | null;
}

export interface TraceMessageReceiveEvent extends TraceEventCommon {
  kind: 'message-receive';
  methodName: string;
  fromEntityId: string | null;
  /** 派发进入的首帧(观察不到=null) */
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

/** 采集形态与采样面的合法配对表(FLOW-022 结论;配错即抛)。 */
const COLLECTOR_FACE_TABLE: Record<TraceCollectorKind, TraceSampleFace> = {
  setprofile: 'complete-within-window',
  settrace: 'complete-within-window',
  'py-spy-dump': 'stop-only',
  'py-spy-record': 'sampled',
  'debugpy-stop': 'stop-only',
  'log-evidence': 'sparse-points'
};

/** 采样面的不得宣称边界(R2/R3 呈现层直接引用的口径)。 */
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

/** 分布式 Omit(联合类型逐成员去掉 seq,保住判别字段) */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type TraceEventInput = DistributiveOmit<TraceEvent, 'seq'>;

export interface TraceSessionInput {
  sessionId: string;
  source: TraceSource;
  clock: TraceClockDomain;
  processes: TraceProcessRecord[];
  threads: TraceThreadRecord[];
  /** 事件(不携带 seq,构造器统一分配) */
  events: TraceEventInput[];
  /** 会话级/进程级丢弃记录(不携带 seq/timestamp 的简式 + 可选时间戳) */
  drops?: Array<Omit<TraceDropEvent, 'seq'> & { timestamp?: number }>;
  completenessNote?: string;
}

/**
 * 构造 trace 会话:分配 seq、校验红线。校验失败抛错(诚实失败,不静默裁剪):
 *   - 来源/采样面配对表;
 *   - timestamp 同线程单调不降;
 *   - parentSeq/correspondsToCallSeq 必须指向**同线程**更早事件(跨线程/
 *     跨进程同步栈边=伪装共享栈,直接拒绝);
 *   - drop 计数与 totalDropped 对账。
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

  // 丢失标记:totalDropped 由构造器按 drops 计数生成(调用方不另行报数)
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

/** 消息关联裁定(FLOW-027 前置):只有两侧 correlationId 非空且相等才是因果边。 */
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
