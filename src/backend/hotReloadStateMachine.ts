/**
 * HR-STATE-001 热更文件状态模型 + 迁移表(纯核,零 vscode 零 IO):
 * - 13 态统一模型,把既有四面状态收拢成一列可迁移的每文件状态机——
 *   投递台账四态(HotReloadDeliveryOutcome:sent-unverified/accepted/applied/failed,
 *   hotReloadTargetState.ts)、状态栏七态(HotReloadStatusKind:watch-off/ready/
 *   ready-with-error/sending/sent-unverified/applied/failed,hotReloadStatus.ts)、
 *   流水线队列段(pending/previewHeld/wave,hotReloadSavePipeline.ts)、语法闸
 *   (blocked,HR-WATCH-012) 都是本模型的投影/阶段;
 * - 迁移表=HOT_RELOAD_STATE_TRANSITIONS(from → 合法 to[]),非法迁移如实拒
 *   (canTransition false;状态机类 set 拒抛)。迁移表是**定义**,不是运行时
 *   唯一闸——既有四面各自的守卫(IDE-AUD-005 代际绑定、applied 双证核验等)
 *   原样保留,本表只统一口径,不替代守卫;
 * - 状态文案/阶段语义随注释逐态标明,只描述已核实事实,未确认不称成功
 *   (与状态栏脸面同纪律)。
 */

/** 13 态统一模型(HR-STATE-001):名字与 todo 行逐字一致 */
export type HotReloadState =
  | 'disabled' // 监视关(per target/root):不监听,不发送
  | 'idle' // 监视中,文件稳定,无待发变更
  | 'dirty' // 文件已变(保存/磁盘变更),去抖窗内未入管线
  | 'queued' // 已入管线(pending/预览滞留/波次),未开始定稿
  | 'checking' // 稳定窗/语法闸检查进行中(HR-WATCH-007/012 窗)
  | 'sending' // HTTP 请求在途
  | 'sent_unverified' // 已发(2xx)无业务回执:未确认,不称成功
  | 'accepted' // 服务端回执 accepted
  | 'applied' // 回执 applied+指纹核验一致:已核实生效
  | 'failed' // 发送失败/应用失败
  | 'blocked' // 语法闸/门禁拦下,不发
  | 'restart_required' // def 结构变更需引擎重启
  | 'unknown'; // 结果不可判定(如 2xx 但状态不可辨)

/** 状态中文标签(状态栏/面板展示面用;只述已核实事实) */
export const HOT_RELOAD_STATE_LABELS: Record<HotReloadState, string> = {
  disabled: '关',
  idle: '就绪',
  dirty: '待定稿',
  queued: '已入队',
  checking: '检查中',
  sending: '发送中',
  sent_unverified: '已发送(未确认)',
  accepted: '已接受',
  applied: '已应用',
  failed: '失败',
  blocked: '已拦下',
  restart_required: '需重启',
  unknown: '未知'
};

/**
 * 迁移表(HR-STATE-001 定义):from → 合法 to[]。
 * 设计依据=既有四面已证的迁移(回执升级 sent-unverified→accepted/applied/failed、
 * 应用后再编辑→dirty、闸拦→blocked、def 结构→restart_required、关/拆→disabled)
 * 收拢成单表;每行只列事实可达的目标,不列不可达/非法迁移。
 */
export const HOT_RELOAD_STATE_TRANSITIONS: Record<HotReloadState, readonly HotReloadState[]> = {
  disabled: ['idle'], // 开监视
  idle: ['dirty', 'disabled'], // 文件变 / 关
  dirty: ['queued', 'disabled'], // 去抖窗到入管线 / 关
  queued: ['checking', 'disabled'], // 定稿开始(稳定窗/语法闸) / 拆
  checking: ['sending', 'blocked', 'idle', 'disabled'], // 过检发送 / 闸拦 / 还原无变 / 拆
  sending: ['sent_unverified', 'accepted', 'applied', 'failed', 'unknown', 'disabled'],
  sent_unverified: ['accepted', 'applied', 'failed', 'dirty', 'disabled'], // 晚回执 / 再编辑 / 关
  accepted: ['applied', 'failed', 'dirty', 'disabled'], // 升级 applied / 降失败 / 再编辑 / 关
  applied: ['dirty', 'restart_required', 'disabled'], // 再编辑 / def 结构变 / 关
  failed: ['dirty', 'restart_required', 'disabled'], // 重试/再编辑 / def 结构变 / 关
  blocked: ['dirty', 'disabled'], // 再编辑重检 / 关
  restart_required: ['idle', 'dirty', 'disabled'], // 重启后追平 / 重启后再编辑 / 关
  unknown: ['sent_unverified', 'failed', 'dirty', 'disabled'] // 可判定 / 判定失败 / 再编辑 / 关
};

/** 迁移是否合法(纯表查询;非法=如实 false,不猜不替代守卫) */
export function canHotReloadTransition(from: HotReloadState, to: HotReloadState): boolean {
  return HOT_RELOAD_STATE_TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * 每键(文件/目标/根)状态机:初始 unknown,set 校验迁移表,非法拒抛
 * (StateMachineTransitionError)。这是**口径面**,既有四面守卫原样保留;
 * 状态机只拒绝明显非法迁移,不代替守卫做决策。
 */
export class HotReloadStateMachine {
  private readonly states = new Map<string, HotReloadState>();

  get(key: string): HotReloadState {
    return this.states.get(key) ?? 'unknown';
  }

  /** 置状态;非法迁移拒抛。force=true 绕过迁移校验(初始/重置面)。 */
  set(key: string, state: HotReloadState, force = false): void {
    const current = this.get(key);
    if (!force && current !== state && !canHotReloadTransition(current, state)) {
      throw new HotReloadStateTransitionError(key, current, state);
    }
    this.states.set(key, state);
  }

  /** 若迁移合法则置状态并返回 true;非法返回 false 且状态原样 */
  trySet(key: string, state: HotReloadState): boolean {
    const current = this.get(key);
    if (current !== state && !canHotReloadTransition(current, state)) {
      return false;
    }
    this.states.set(key, state);
    return true;
  }

  keys(): string[] {
    return [...this.states.keys()];
  }

  clear(): void {
    this.states.clear();
  }
}

/** 非法迁移的如实错误(可审:来源键/from/to) */
export class HotReloadStateTransitionError extends Error {
  constructor(
    readonly key: string,
    readonly from: HotReloadState,
    readonly to: HotReloadState
  ) {
    super(`非法热更状态迁移 ${key}: ${from} → ${to}`);
    this.name = 'HotReloadStateTransitionError';
  }
}

/**
 * 投递台账四态 → 13 态投影(HR-STATE-001 收口:台账 outcome 是发送结果面,
 * 与生命周期状态同口径但不等价——outcome 缺 dirty/queued/checking 等
 * 发送前阶段,投影只在 outcome 可判定时用)。
 */
export function projectDeliveryOutcome(
  outcome: 'sent-unverified' | 'accepted' | 'applied' | 'failed'
): HotReloadState {
  switch (outcome) {
    case 'sent-unverified':
      return 'sent_unverified';
    case 'accepted':
      return 'accepted';
    case 'applied':
      return 'applied';
    case 'failed':
      return 'failed';
  }
}

/** 状态栏七态 → 13 态投影(全局面,单文件口径只取代表性:ready 类归 idle) */
export function projectStatusKind(
  kind: 'watch-off' | 'ready' | 'ready-with-error' | 'sending' | 'sent-unverified' | 'applied' | 'failed'
): HotReloadState {
  switch (kind) {
    case 'watch-off':
      return 'disabled';
    case 'ready':
    case 'ready-with-error':
      return 'idle';
    case 'sending':
      return 'sending';
    case 'sent-unverified':
      return 'sent_unverified';
    case 'applied':
      return 'applied';
    case 'failed':
      return 'failed';
  }
}
