/**
 * KFLOW 流转图节点/边协议(FLOW-002 契约的 G2 静态调用路径模型,FLOW-003 交付)。
 *
 * 上位契约:docs/design/kflow-three-graph-contract.md §1-G2(数据面)+ §2-R2
 * (证据分型;本模型没有运行时证据位,「栈帧」词汇只属 G3 trace 事件模型,
 * 本文件的类型/字段/文案一律用「调用帧/候选帧」)。验收映射:
 *   节点六面  = 工程(rootKey)/角色(role)/实例候选(instanceCandidates)/
 *              实体(entity)/函数(fn)/源码(declaration);
 *   边七面    = 调用点(callSite)/方向(direction)/同步异步(syncAsync)/
 *              条件(condition)/消息RPC(messageKind)/证据(evidence)/
 *              未解析原因(unresolvedReason)。
 *
 * 边身份含调用点:同一函数对之间的多次调用是**多条边**(FLOW-005 验收:
 * 保留调用点,不压成一个帧);未解析节点的归属是调用点所属实体
 * (FLOW-001 S4 教训),由构造方负责,协议只在 reason 里如实记录。
 *
 * 本模块是纯协议面(类型+构造校验),零 vscode 依赖;消费面在 FLOW-004/005
 * (解析与展开)与 FLOW-014+(呈现)接线。
 */

/** 静态进程角色。bridge:* 只在已核实契约的桥接上出现(FLOW-002 §1-G1/G2:
 * 禁止拓扑全连接;machine/logger 等无真实业务边不出现)。 */
export type FlowProcessRole =
  | 'client'
  | 'base'
  | 'cell'
  | 'bridge:loginapp'
  | 'bridge:dbmgr'
  | 'bridge:interfaces'
  | 'bridge:other'
  | 'unknown';

/** 节点形态。 */
export type FlowGraphNodeKind =
  /** 可展开的本地调用帧(候选帧,静态) */
  | 'function'
  /** RPC 声明面节点(def 方法,发送边的远端落点候选) */
  | 'rpc-declaration'
  /** 外部入口(client 无源码时的 Exposed 入口标记等,带证据不造假帧) */
  | 'external-entry'
  /** 未解析节点(带原因码,归属=调用点所属实体) */
  | 'unresolved';

/** 实例候选:静态角色不冒充运行实例(FLOW-015 同源),只列静态可证的候选。 */
export type FlowInstanceCandidate =
  | { kind: 'entity-type'; identity: string }
  | { kind: 'component-slot'; identity: string }
  | { kind: 'known-instance'; identity: string };

export interface FlowEntityRef {
  /** 实体类型名(def 名) */
  name: string;
  defFile: string;
}

export interface FlowFunctionRef {
  name: string;
  /** 实现文件(python);声明面节点可为 def 文件 */
  filePath: string;
  signature: string;
}

/** 源码位置(0 基行/列由构造方声明,协议不换算)。 */
export interface FlowSourceLocation {
  file: string;
  line: number;
  character: number;
}

/** 证据分型(契约 R2):G2 只有静态证据;运行时证据(runtime-source)不进本模型。 */
export type FlowEvidence =
  | { type: 'syntax-anchor'; /** 调用点语法锚(与 callSite 一致;广播/入口边可只带此处) */ detail: string }
  | { type: 'declaration-contract'; /** 声明契约证据(<Exposed>/def 段/引擎出处 file:line) */ detail: string }
  | { type: 'external-source'; /** 外部来源证据(客户端源码调用点/文档/用户声明) */ detail: string };

/** 未解析原因码(FLOW-001 S1-S6 全谱 + FLOW-011 要求的动态面)。 */
export type FlowUnresolvedReasonCode =
  | 'dynamic-getattr'
  | 'unknown-receiver'
  | 'third-party-function'
  | 'native-function'
  | 'face-invalid-receiver'
  | 'no-client-source'
  | 'ambiguous-name'
  | 'missing-declaration'
  | 'depth-truncated'
  | 'recursion';

export interface FlowUnresolvedReason {
  code: FlowUnresolvedReasonCode;
  /** 人读细节(不进身份;同 code 不同 detail 不拆边身份) */
  detail: string;
}

/** 同步/异步形态。engine-callback 单列:请求与回调是两段边(FLOW-010)。 */
export type FlowSyncAsync = 'sync' | 'async-send' | 'async-callback' | 'unknown';

/** 消息/RPC 形态(契约 §1-G2:跨进程=消息边两段,不画成同步 Python 子栈)。 */
export type FlowMessageKind =
  | 'local-call'
  | 'rpc'
  | 'broadcast'
  | 'engine-callback'
  | 'external-call'
  | 'unresolved';

/** 边方向:进程间方向 + 调用相对方向。 */
export interface FlowEdgeDirection {
  fromRole: FlowProcessRole;
  toRole: FlowProcessRole;
  /** downstream-call=入口向下查询里的边;upstream-caller=调用者向上查询里的边 */
  kind: 'downstream-call' | 'upstream-caller' | 'cross-process';
}

export interface FlowEdgeCondition {
  /** 条件表达式原文(如 if 分支/类型判别);候选标记,不是执行顺序 */
  text: string;
  /** 条件来源形态 */
  kind: 'if-branch' | 'type-discriminant' | 'caller-asserted' | 'other';
}

// ── 节点 ──────────────────────────────────────────────────────────────

export interface FlowGraphNode {
  /** 稳定身份;由 flowGraphNodeIdentity 生成(调用点不在节点身份里) */
  readonly id: string;
  readonly kind: FlowGraphNodeKind;
  /** 工程/资源根身份(跨根隔离) */
  readonly rootKey: string;
  readonly role: FlowProcessRole;
  /** 实例候选;空数组=静态无候选(诚实),不许编造 */
  readonly instanceCandidates: readonly FlowInstanceCandidate[];
  readonly entity: FlowEntityRef | null;
  readonly fn: FlowFunctionRef | null;
  /** 声明源码位置(可空) */
  readonly declaration: FlowSourceLocation | null;
  /** 展示名(候选帧/声明/外部入口,不含「栈帧」词汇——契约 R1) */
  readonly label: string;
}

/** 节点稳定身份:同函数只一节点;实体缺省用 unknown。 */
export function flowGraphNodeIdentity(input: {
  rootKey: string;
  role: FlowProcessRole;
  entity?: FlowEntityRef | null;
  fn?: FlowFunctionRef | null;
  kind: FlowGraphNodeKind;
  /** 未解析节点带原因码进身份(不同原因不合并);其余形态可空 */
  unresolvedCode?: FlowUnresolvedReasonCode;
}): string {
  const parts = [
    input.rootKey,
    input.role,
    input.kind,
    input.entity ? input.entity.name : 'no-entity',
    input.fn ? `${input.fn.filePath}#${input.fn.name}` : 'no-fn',
    input.unresolvedCode ?? 'no-reason'
  ];
  return parts.join('\u001f');
}

export function flowGraphNode(input: {
  rootKey: string;
  role: FlowProcessRole;
  kind: FlowGraphNodeKind;
  instanceCandidates?: readonly FlowInstanceCandidate[];
  entity?: FlowEntityRef | null;
  fn?: FlowFunctionRef | null;
  declaration?: FlowSourceLocation | null;
  label: string;
  unresolvedCode?: FlowUnresolvedReasonCode;
  unresolvedDetail?: string;
}): FlowGraphNode {
  if (input.kind === 'unresolved' && !input.unresolvedCode) {
    throw new Error('unresolved node requires a reason code');
  }
  if (input.kind === 'external-entry' && input.fn) {
    throw new Error('external-entry node carries no fabricated function frame');
  }
  return {
    id: flowGraphNodeIdentity(input),
    kind: input.kind,
    rootKey: input.rootKey,
    role: input.role,
    instanceCandidates: Object.freeze([...(input.instanceCandidates ?? [])]),
    entity: input.entity ?? null,
    fn: input.fn ?? null,
    declaration: input.declaration ?? null,
    label: input.label
  };
}

// ── 边 ────────────────────────────────────────────────────────────────

export interface FlowGraphEdge {
  /** 稳定身份:节点对 + 调用点(同函数对多次调用=多条边,FLOW-005) */
  readonly id: string;
  readonly fromNodeId: string;
  readonly toNodeId: string;
  /** 调用点(语法锚);broadcast/engine-callback 的发送段允许 null(证据代替) */
  readonly callSite: FlowSourceLocation | null;
  readonly direction: FlowEdgeDirection;
  readonly syncAsync: FlowSyncAsync;
  readonly condition: FlowEdgeCondition | null;
  readonly messageKind: FlowMessageKind;
  readonly evidence: FlowEvidence;
  /** 解析失败必填(构造器强制);成功边为 null */
  readonly unresolvedReason: FlowUnresolvedReason | null;
}

export function flowGraphEdgeIdentity(input: {
  fromNodeId: string;
  toNodeId: string;
  callSite: FlowSourceLocation | null;
  directionKind: FlowEdgeDirection['kind'];
}): string {
  const site = input.callSite
    ? `${input.callSite.file}#${input.callSite.line}#${input.callSite.character}`
    : 'no-site';
  return [input.fromNodeId, input.toNodeId, site, input.directionKind].join('\u001f');
}

export function flowGraphEdge(input: {
  fromNodeId: string;
  toNodeId: string;
  callSite?: FlowSourceLocation | null;
  direction: FlowEdgeDirection;
  syncAsync: FlowSyncAsync;
  condition?: FlowEdgeCondition | null;
  messageKind: FlowMessageKind;
  evidence: FlowEvidence;
  unresolvedReason?: FlowUnresolvedReason | null;
}): FlowGraphEdge {
  const callSite = input.callSite ?? null;
  if (input.evidence.type === 'syntax-anchor' && !callSite) {
    throw new Error('syntax-anchor evidence requires a call site');
  }
  const needsReason =
    input.messageKind === 'unresolved' || input.toNodeId.includes('unresolved');
  if (needsReason && !input.unresolvedReason) {
    throw new Error('unresolved edge requires a reason');
  }
  return {
    id: flowGraphEdgeIdentity({
      fromNodeId: input.fromNodeId,
      toNodeId: input.toNodeId,
      callSite,
      directionKind: input.direction.kind
    }),
    fromNodeId: input.fromNodeId,
    toNodeId: input.toNodeId,
    callSite,
    direction: input.direction,
    syncAsync: input.syncAsync,
    condition: input.condition ?? null,
    messageKind: input.messageKind,
    evidence: input.evidence,
    unresolvedReason: input.unresolvedReason ?? null
  };
}

/** 图容器:节点集 + 边集;不设「栈」语义容器(契约 R1)。 */
export interface FlowGraph {
  /** 查询方向(入口向下/调用者向上)与根节点 */
  readonly query: {
    kind: 'downstream' | 'upstream';
    rootNodeId: string;
    /** 深度截断时如实记录(FLOW-005),不静默 */
    truncatedAtDepth: number | null;
  };
  readonly nodes: readonly FlowGraphNode[];
  /** 多条边可同节点对(调用点区分);顺序=构造序,渲染层再排序 */
  readonly edges: readonly FlowGraphEdge[];
}
