/**
 * 脚本文件热更状态机(IDE-HOT-100):在既有投递台账(HOT-001 双维隔离,
 * HotReloadTargetStateStore=事实源)之上按 (rootId,targetId,file) 给出
 * CLEAN/DIRTY/SENT/APPLIED/FAILED 生命周期态,外加结构性 def 拦下的补充态
 * RESTART_REQUIRED(HOT-005 闸拦,不是失败是保守拦下)。状态依据=文件内容
 * sha256 + 既有 accepted/applied 回执协议(HOT-002/003/004),不靠文件
 * mtime——touch/改权限不改内容不标脏。台账是事实源,状态机是派生视图,
 * 二者键同形(rootId×targetId×file),不另立第二套身份。
 *
 * 基线(hash)解析:最近一次 APPLIED 时的内容 hash(台账 applied 记录的
 * sentDigest,IDE-AUD-006 冻结基准),或会话基线册内首次出现且 hash 相等;
 * applied 后基线滚动更新为所发 hash,会话基线册记最近一次 applied,台账
 * 被后续发送覆盖(重试语义)时基线不丢。
 *
 * 口径红线:accepted 只注解不提前转 APPLIED(HOT-003:应用仍需核验);
 * 回执超时保持未确认语义如实标 FAILED(detail 注明未确认/超时),不冒充
 * applied;FAILED 后文件再改=新一次编辑回落 DIRTY 可再发。
 */

import { createHash } from 'crypto';

import { settleAppliedStatus, type AppliedSettleStatus } from './hotReloadAppliedCheck';
import {
  buildHotReloadTargetKeyId,
  HOT_RELOAD_TARGET_KEY_SEPARATOR,
  type HotReloadDeliveryRecord,
  type HotReloadTargetKey,
  type HotReloadTargetStateStore
} from './hotReloadTargetState';

/** 六态生命周期:未修改/已改未重载/已发送待回执/已生效/重载失败/需重启 */
export type HotReloadFileLifecycleState =
  | 'CLEAN'
  | 'DIRTY'
  | 'SENT'
  | 'APPLIED'
  | 'FAILED'
  | 'RESTART_REQUIRED';

/** 单 (rootId,targetId,file) 的状态视图:态 + 判定依据 + 透传台账明细 */
export interface HotReloadFileStateView {
  /** 状态所属文件(绝对路径,过滤/角标渲染用) */
  file: string;
  state: HotReloadFileLifecycleState;
  /** 当前内容 sha256(可读时);undefined=不可读/不存在 */
  currentDigest?: string;
  /** 基线 hash(最近一次 APPLIED 所发 hash,或会话基线册首见 hash) */
  baselineDigest?: string;
  /** 最近一次投递 detail(透传台账,原样不加工) */
  detail?: string;
  /** 最近一次投递代际(IDE-AUD-005) */
  attempt?: number;
  /** FAILED 原因(投递失败 detail 或 未确认/超时 说明);RESTART_REQUIRED 带拦截原因 */
  reason?: string;
  /** SENT 注解(accepted 已到仍等 applied,HOT-003 口径) */
  annotation?: string;
}

/** 内容 sha256(UTF-8 hex;与 applied 核验/def 指纹同源的现成 node:crypto 原语) */
export const sha256Hex = (content: string): string =>
  createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex');

/**
 * 纯派生状态表(类方法读台账并算 settle 后落到这里):结构性 def 拦下最
 * 先(保守拦下优先于一切投递态);无台账记录按基线 CLEAN/DIRTY;有记录按
 * settle 结算——applied 后内容再偏离=新 DIRTY,failed 如实 FAILED(内容
 * 再改=新编辑回落 DIRTY),超时未确认如实 FAILED 不冒充 applied,窗口内
 * pending 一律 SENT(accepted 只是注解)。
 */
export function deriveHotReloadFileState(input: {
  record: HotReloadDeliveryRecord | undefined;
  file: string;
  currentDigest: string | undefined;
  baselineDigest: string | undefined;
  restartRequired: boolean;
  /** settleAppliedStatus 结算;record 为空时不参与(无记录分支先行) */
  settle: AppliedSettleStatus;
}): HotReloadFileStateView {
  const { record, file, currentDigest, baselineDigest, restartRequired, settle } = input;
  const view: HotReloadFileStateView = { file, state: 'CLEAN' };
  if (currentDigest !== undefined) {
    view.currentDigest = currentDigest;
  }
  if (baselineDigest !== undefined) {
    view.baselineDigest = baselineDigest;
  }
  if (record !== undefined) {
    view.attempt = record.attempt;
    if (record.detail !== undefined) {
      view.detail = record.detail;
    }
  }
  // 结构性 def 变更被 HOT-005 闸拦下:普通 reload 不发,需重启进程后再应用。
  // 是保守拦下不是失败,单独着色不与 FAILED 混用。
  if (restartRequired) {
    view.state = 'RESTART_REQUIRED';
    view.reason = '结构性 def 变更,普通 reload 被拦,需重启进程后再应用';
    return view;
  }
  if (record === undefined) {
    // 从未发送:内容与基线一致=CLEAN,偏离=DIRTY。内容不可读(文件不在/
    // 读不了)且无台账记录=无可判依据,如实 CLEAN(无待办,不猜脏)。
    view.state =
      currentDigest === undefined || currentDigest === baselineDigest ? 'CLEAN' : 'DIRTY';
    return view;
  }
  if (settle === 'applied') {
    // applied 已核验:基线=所发 hash(IDE-AUD-006 冻结基准);内容再偏离=新一次偏离
    view.state = currentDigest !== undefined && currentDigest !== baselineDigest ? 'DIRTY' : 'APPLIED';
    return view;
  }
  if (settle === 'failed') {
    // 投递失败:内容仍为所发失败内容=FAILED 如实保持;内容再改=新一次编辑
    // 回落 DIRTY 可再发(FAILED──文件改──▶DIRTY)
    if (record.sentDigest !== undefined && currentDigest !== undefined && currentDigest !== record.sentDigest) {
      view.state = 'DIRTY';
      return view;
    }
    view.state = 'FAILED';
    view.reason = record.detail ?? '投递失败';
    return view;
  }
  if (settle === 'unconfirmed-timeout') {
    // 回执超时:保持未确认语义如实标 FAILED,不冒充 applied;内容再改=新编辑回落 DIRTY
    if (record.sentDigest !== undefined && currentDigest !== undefined && currentDigest !== record.sentDigest) {
      view.state = 'DIRTY';
      return view;
    }
    view.state = 'FAILED';
    view.reason = `applied 核验超时:保持未确认,不确认已生效${record.detail !== undefined ? `(${record.detail})` : ''}`;
    return view;
  }
  // 窗口内 pending(sent-unverified/accepted):已发送待回执。accepted 只
  // 注解不提前转 APPLIED(HOT-003 口径),仍等 applied 或超时。
  view.state = 'SENT';
  if (record.outcome === 'accepted') {
    view.annotation = record.detail ?? '回执 accepted:应用仍需核验,仍等 applied';
  }
  return view;
}

export interface HotReloadFileStateMachineDeps {
  /** 注入时钟(超时结算/日志同源) */
  now(): number;
  /** applied 核验超时窗口 ms(与 HOT_RELOAD_APPLIED_SETTLE_MS 同值) */
  timeoutWindowMs: number;
}

/**
 * 文件热更状态机:会话基线册 + 结构性 def 拦下集 + 派生视图。台账
 * (HotReloadTargetStateStore)是事实源,本类只在其上派生生命周期态,
 * 键同形(rootId×targetId×file)不另立身份。
 */
export class HotReloadFileStateMachine {
  private readonly deps: HotReloadFileStateMachineDeps;
  /** 会话基线册:rootId::targetId::file → 最近一次 applied 所发 hash(或首见 hash) */
  private readonly baselines = new Map<string, string>();
  /** 结构性 def 拦下集:rootId::targetId::file → 拦截原因(HOT-005 闸写入) */
  private readonly restartReasons = new Map<string, string[]>();

  constructor(deps: HotReloadFileStateMachineDeps) {
    this.deps = deps;
  }

  private keyOf(key: HotReloadTargetKey, file: string): string {
    return `${buildHotReloadTargetKeyId(key)}${HOT_RELOAD_TARGET_KEY_SEPARATOR}${file}`;
  }

  /** rootId::targetId::file 键拆回 (rootId,targetId);文件路径可能含 ::,从头部拆两次 */
  private splitKeyId(keyId: string): HotReloadTargetKey | null {
    const sep = HOT_RELOAD_TARGET_KEY_SEPARATOR;
    const first = keyId.indexOf(sep);
    if (first < 0) {
      return null;
    }
    const second = keyId.indexOf(sep, first + sep.length);
    if (second < 0) {
      return null;
    }
    return { rootId: keyId.slice(0, first), targetId: keyId.slice(first + sep.length, second) };
  }

  /**
   * 基线解析:最近一次 APPLIED 的所发 hash 优先(台账 applied 记录的
   * sentDigest);否则会话基线册(首次出现或 applied 后被后续发送覆盖的
   * 旧 applied);都没有=undefined(无基线)。
   */
  resolveBaseline(
    ledger: HotReloadTargetStateStore,
    key: HotReloadTargetKey,
    file: string
  ): string | undefined {
    const record = ledger.get(key, file);
    if (record?.outcome === 'applied' && record.sentDigest !== undefined) {
      return record.sentDigest;
    }
    return this.baselines.get(this.keyOf(key, file));
  }

  /**
   * 派生单文件生命周期态。currentContent=当前文件内容(调用方读好传入,
   * 读不到=undefined);状态机内部只对内容算 sha256,mtime 从不参与判定。
   * 副作用仅限会话册维护:applied 记录把基线滚到所发 hash;无记录首见
   * 文件把当前内容 hash 注册为会话基线(文件从干净开始)。
   */
  derive(
    ledger: HotReloadTargetStateStore,
    key: HotReloadTargetKey,
    file: string,
    currentContent: string | undefined
  ): HotReloadFileStateView {
    const record = ledger.get(key, file);
    const currentDigest = currentContent === undefined ? undefined : sha256Hex(currentContent);
    const keyId = this.keyOf(key, file);
    let baseline = this.resolveBaseline(ledger, key, file);
    if (record?.outcome === 'applied' && record.sentDigest !== undefined) {
      // 基线滚动:applied 即基线=所发 hash(设计 §3.2),会话册同步留档,
      // 后续重试覆盖台账时基线不丢
      baseline = record.sentDigest;
      this.baselines.set(keyId, record.sentDigest);
    } else if (record === undefined && baseline === undefined && currentDigest !== undefined) {
      // 首见注册:会话基线册内首次出现,当前内容即基线(该文件从 CLEAN 开始)
      baseline = currentDigest;
      this.baselines.set(keyId, currentDigest);
    }
    const restartRequired = this.restartReasons.has(keyId);
    // 超时结算:deadline=发送时点(recordedAt 随代际写回保持发送时刻)+ 窗口;
    // 无记录时 settle 不参与(无记录分支先行),占位值不进判定
    const settle =
      record === undefined
        ? 'pending'
        : settleAppliedStatus(record, {
            deadlineMs: record.recordedAt + this.deps.timeoutWindowMs,
            now: this.deps.now
          });
    return deriveHotReloadFileState({
      record,
      file,
      currentDigest,
      baselineDigest: baseline,
      restartRequired,
      settle
    });
  }

  /** 结构性 def 拦下(HOT-005 闸写入):该批文件标 RESTART_REQUIRED 呈现 */
  markRestartRequired(key: HotReloadTargetKey, files: readonly string[], reasons: readonly string[]): void {
    for (const file of files) {
      this.restartReasons.set(this.keyOf(key, file), [...reasons]);
    }
  }

  /** 解除拦下(重启后/人工确认):文件回落其投递事实对应的生命周期态 */
  clearRestartRequired(key: HotReloadTargetKey, files: readonly string[]): void {
    for (const file of files) {
      this.restartReasons.delete(this.keyOf(key, file));
    }
  }

  /** 被拦文件清单(该目标名下,按写入序) */
  restartRequiredFiles(key: HotReloadTargetKey): string[] {
    const prefix = `${buildHotReloadTargetKeyId(key)}${HOT_RELOAD_TARGET_KEY_SEPARATOR}`;
    return [...this.restartReasons.entries()]
      .filter(([keyId]) => keyId.startsWith(prefix))
      .map(([keyId]) => keyId.slice(prefix.length));
  }

  /** 已知键集(过滤/角标候选):台账有记录 ∪ 会话基线册 ∪ 被拦集,键同形不另立身份 */
  knownKeys(ledger: HotReloadTargetStateStore): HotReloadTargetKey[] {
    const keys = new Map<string, HotReloadTargetKey>();
    for (const key of ledger.targetsWithRecords()) {
      keys.set(buildHotReloadTargetKeyId(key), key);
    }
    for (const keyId of this.baselines.keys()) {
      const key = this.splitKeyId(keyId);
      if (key) {
        keys.set(buildHotReloadTargetKeyId(key), key);
      }
    }
    for (const keyId of this.restartReasons.keys()) {
      const key = this.splitKeyId(keyId);
      if (key) {
        keys.set(buildHotReloadTargetKeyId(key), key);
      }
    }
    return [...keys.values()].sort((a, b) =>
      `${a.rootId}::${a.targetId}`.localeCompare(`${b.rootId}::${b.targetId}`)
    );
  }

  /**
   * 按状态过滤(呈现「看哪些改了还没重载」=DIRTY∪SENT 的过滤视图)。
   * 候选=该目标名下台账有记录 ∪ 会话基线册有名 ∪ 被拦文件——三类并集,
   * 缺一类就漏;逐一派生后按状态集合筛。readContent 读不到=undefined
   * (派生按不可读分支走)。
   */
  async filesByState(
    ledger: HotReloadTargetStateStore,
    key: HotReloadTargetKey,
    states: readonly HotReloadFileLifecycleState[],
    readContent: (file: string) => string | undefined | Promise<string | undefined>
  ): Promise<HotReloadFileStateView[]> {
    const keyIdPrefix = `${buildHotReloadTargetKeyId(key)}${HOT_RELOAD_TARGET_KEY_SEPARATOR}`;
    const files = new Set<string>(ledger.files(key));
    for (const keyId of this.baselines.keys()) {
      if (keyId.startsWith(keyIdPrefix)) {
        files.add(keyId.slice(keyIdPrefix.length));
      }
    }
    for (const file of this.restartRequiredFiles(key)) {
      files.add(file);
    }
    const wanted = new Set<HotReloadFileLifecycleState>(states);
    const views: HotReloadFileStateView[] = [];
    for (const file of files) {
      const view = this.derive(ledger, key, file, await readContent(file));
      if (wanted.has(view.state)) {
        views.push(view);
      }
    }
    return views.sort((a, b) => a.file.localeCompare(b.file));
  }
}

/** 严重度序(角标聚合「worst wins」):CLEAN 最轻,RESTART_REQUIRED 最重 */
export const HOT_RELOAD_STATE_SEVERITY: Record<HotReloadFileLifecycleState, number> = {
  CLEAN: 0,
  APPLIED: 1,
  SENT: 2,
  DIRTY: 3,
  FAILED: 4,
  RESTART_REQUIRED: 5
};

/** 跨目标聚合:同一文件多目标各自状态,文件树角标取最重一个呈现 */
export function worstHotReloadState(states: readonly HotReloadFileLifecycleState[]): HotReloadFileLifecycleState {
  let worst: HotReloadFileLifecycleState = 'CLEAN';
  for (const state of states) {
    if (HOT_RELOAD_STATE_SEVERITY[state] > HOT_RELOAD_STATE_SEVERITY[worst]) {
      worst = state;
    }
  }
  return worst;
}

/**
 * 注意力集:「看哪些改了还没重载」= DIRTY ∪ SENT 的过滤视图(设计 §3.4)。
 * FAILED/RESTART_REQUIRED 各有专项命令面,不混进这个过滤。
 */
export const HOT_RELOAD_ATTENTION_STATES: readonly HotReloadFileLifecycleState[] = ['DIRTY', 'SENT'];

/** 文件树角标脸面:CLEAN 无角标;其余按设计 §3.4 着色(DIRTY 橙/SENT 蓝/APPLIED 绿/FAILED 红/RESTART 紫) */
export const HOT_RELOAD_STATE_FACES: Record<
  HotReloadFileLifecycleState,
  { badge: string; color: string; tooltip: string } | undefined
> = {
  CLEAN: undefined,
  DIRTY: { badge: 'D', color: 'charts.orange', tooltip: '已修改未重载' },
  SENT: { badge: 'S', color: 'charts.blue', tooltip: '已发送待回执' },
  APPLIED: { badge: 'A', color: 'charts.green', tooltip: '已重载生效' },
  FAILED: { badge: 'F', color: 'charts.red', tooltip: '重载失败' },
  RESTART_REQUIRED: { badge: 'R', color: 'charts.purple', tooltip: '结构性 def 变更,需重启进程' }
};
