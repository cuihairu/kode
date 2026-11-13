/**
 * 按 rootId 与 targetId 隔离热更新状态(IDE-HOT-001):热更投递结果台
 * 账按「文件归属扫描根 rootId × 服务实例 targetId」双维隔离——同文
 * 件发给不同实例各自落各自的记录,后一个目标的失败/成功既不覆盖也
 * 不复用前一个目标的绿色状态;查别的目标拿不到邻居的记录。后续回
 * 执面(sent_unverified/accepted/applied,HOT-002..004)都在这同一
 * 键上收紧,不另立第二套目标身份。
 */

/** 投递目标 = rootId(文件归属扫描根) + targetId(服务实例) */
export interface HotReloadTargetKey {
  rootId: string;
  targetId: string;
}

export const HOT_RELOAD_TARGET_KEY_SEPARATOR = '::';

/** 目标键的稳定串形(日志/展示用;串回拆由调用方按 :: 切) */
export function buildHotReloadTargetKeyId(key: HotReloadTargetKey): string {
  return `${key.rootId}${HOT_RELOAD_TARGET_KEY_SEPARATOR}${key.targetId}`;
}

/** 四态:发出未确认(绿但未证实)/回执 accepted(HOT-003)/applied 已核验(HOT-004)/失败 */
export type HotReloadDeliveryOutcome = 'sent-unverified' | 'accepted' | 'applied' | 'failed';

export interface HotReloadDeliveryRecord {
  rootId: string;
  targetId: string;
  /** 绝对路径 */
  file: string;
  outcome: HotReloadDeliveryOutcome;
  /** 失败原因/补充说明 */
  detail?: string;
  /** 记录时刻(注入时钟,ms) */
  recordedAt: number;
  /**
   * 发送代际(IDE-AUD-005):同 (rootId,targetId,file) 每次新发送递增。
   * 回执/注解/核验结算都绑定所属代际写回——旧代异步回执绝不改新代记录
   * (否则晚到的第一次核验会把第二次的失败翻成 applied)。
   */
  attempt: number;
  /**
   * 发送时点冻结的内容 sha256(IDE-AUD-006):发送前读一次所发内容算的核验
   * 基准。响应后核验用它,绝不再读文件当前内容冒充所发版本(响应后文件已
   * 变也不影响判定)。读取失败=无基准(如实 undefined,核验面注解阻塞)。
   */
  sentDigest?: string;
  /**
   * 触发源(IDE-HOT-102 审计五要素「谁」):watcher-auto(自动监视)/
   * command(手动)/retry(重试)/temp-edit(临时编辑);未提供=来源未记录。
   */
  source?: string;
  /**
   * 通道(IDE-HOT-102 审计五要素「通道」):kbengine-official/http(部署通道)
   * 或 actionName:<名>(quick action 回落通道);未提供=通道未记录。
   */
  channel?: string;
}

/**
 * 文件版本事件(HOT-VER 状态栏版本号):一个文件的版本史,按发生序追加。
 * 只描述「盘上内容变了几次/基线在哪」,不声称已生效——生效与否仍由投递
 * 回执面(applied 双证核验)说了算,版本号与五种状态正交。
 */
export type HotReloadFileVersionEventKind = 'tracked' | 'bump' | 'delivery' | 'baseline';

export interface HotReloadFileVersionEvent {
  /** 事件时刻(注入时钟,ms) */
  at: number;
  kind: HotReloadFileVersionEventKind;
  /** 事件落账后该文件的版本(单调整数) */
  version: number;
  /** delivery 专属:send=新一次发送,receipt=回执/注解写回 */
  stage?: 'send' | 'receipt';
  outcome?: HotReloadDeliveryOutcome;
  attempt?: number;
  /** 发送时点冻结内容 sha256 前 8 位(报告展示用;全量基准仍在记录 sentDigest) */
  digest8?: string;
  rootId?: string;
  targetId?: string;
}

export interface HotReloadFileVersionState {
  readonly file: string;
  /** 盘上当前版本(首次跟踪=1,token 变 +1,绝不倒退) */
  version: number;
  /** 基线版本(最近一次 applied 且 digest 与盘上一致时追平;≤ version,只前进) */
  baseline: number;
  /** 最近一次采到的盘上版本 token(mtimeMs:size);undefined=尚未采样 */
  token?: string;
  /** 变更序号(tracked/bump 各 +1):「最近变更文件」回落的稳定排序,不靠时钟 */
  seq: number;
  readonly events: HotReloadFileVersionEvent[];
}

/** noteFileVersion 的结果:建档/跳号/补采 token/无变化 */
export type HotReloadFileVersionChange = 'tracked' | 'bump' | 'adopted' | 'unchanged';

/** 单文件版本史事件上限(会话内防无界增长;超出丢最旧,版本号本身不丢) */
export const HOT_RELOAD_VERSION_EVENT_CAP = 200;

export interface HotReloadTargetStateDeps {
  now(): number;
  /**
   * 台账写入后回调(IDE-HOT-100 呈现面):任何一条记录落账/升级(新发送、
   * 回执升级、注解写回)都触发一次;被拒的旧代写回(record 返回 undefined,
   * 记录原样不动)不触发。接线方借它刷文件树角标/CodeLens 状态点,使呈
   * 现面跟住台账事实(回执落地即时反映,不等下次保存)。
   */
  onRecorded?: () => void;
  /**
   * 台账单条写入回调(HR-PR-06 接线批):与 onRecorded 同点位触发,携带
   * 最终记录(新发送/回执升级/注解写回各一次);被拒的旧代写回不触发。
   * 接线方据此把台账事实投影进历史面板,不再轮询。
   */
  onRecord?: (record: HotReloadDeliveryRecord) => void;
}

/**
 * 双维隔离台账:内层 rootId → targetId → file → 最新一条记录。
 * 同目标同文件重发=覆盖为最新一次(重试语义),跨目标零牵连。
 */
export class HotReloadTargetStateStore {
  private readonly now: () => number;
  private readonly onRecorded?: () => void;
  private readonly onRecord?: (record: HotReloadDeliveryRecord) => void;
  private readonly targets = new Map<string, Map<string, Map<string, HotReloadDeliveryRecord>>>();
  /** IDE-AUD-005:发送代际计数——(rootId::targetId::file) → 已发生的发送次数 */
  private readonly attempts = new Map<string, number>();
  /**
   * HOT-VER 文件版本簿:file → 版本状态。与投递台账同一对象同一生命周期
   * (不新开存储):基线随台账存亡,watcher 事件流与手动触发路径写同一份计数。
   */
  private readonly versionStates = new Map<string, HotReloadFileVersionState>();
  /** 版本变更序号(tracked/bump 各 +1):「最近变更文件」回落的稳定排序 */
  private versionSeq = 0;

  constructor(deps: HotReloadTargetStateDeps) {
    this.now = deps.now;
    this.onRecorded = deps.onRecorded;
    this.onRecord = deps.onRecord;
  }

  /**
   * 落一条记录。两种写法:
   * - 不带 options.attempt = 新发送(重发=新一次投递):推进代际并覆盖为最新一次;
   * - 带 options.attempt = 绑定所属发送代际的写回(回执/注解/核验结算):
   *   当前记录已换代(更新的发送在途)则拒绝——返回 undefined,记录原样不动,
   *   旧代异步结果绝不改新代记录(IDE-AUD-005)。
   */
  record(
    key: HotReloadTargetKey,
    file: string,
    outcome: HotReloadDeliveryOutcome,
    options: { detail?: string; now?: number; attempt?: number; sentDigest?: string; source?: string; channel?: string } = {}
  ): HotReloadDeliveryRecord | undefined {
    const attemptKey = `${buildHotReloadTargetKeyId(key)}${HOT_RELOAD_TARGET_KEY_SEPARATOR}${file}`;
    const current = this.get(key, file);
    if (options.attempt !== undefined) {
      if (!current || current.attempt !== options.attempt) {
        return undefined;
      }
      const updated: HotReloadDeliveryRecord = {
        ...current,
        outcome,
        recordedAt: options.now ?? current.recordedAt
      };
      if (options.detail !== undefined) {
        updated.detail = options.detail;
      }
      // KODE-AUD-003:回执路径漏写 options.sentDigest——hotReload.ts:377 与
      // hotReloadRetryCommand.ts:138 都经带 attempt 的写回把发送时点冻结的
      // 内容 sha256 基准带进台账(IDE-AUD-006「可审计」),此前该分支只补
      // detail,sentDigest 被静默丢弃,记录恒无基准,hotReloadFileState 的
      // applied 基线回落重算。与 detail 同模式:提供了才覆写,未提供保留旧值。
      if (options.sentDigest !== undefined) {
        updated.sentDigest = options.sentDigest;
      }
      // IDE-HOT-102:触发源/通道与 detail/sentDigest 同模式——提供了才覆写,
      // 未提供保留旧值(回执写回不动首次发送记录的来源/通道)。
      if (options.source !== undefined) {
        updated.source = options.source;
      }
      if (options.channel !== undefined) {
        updated.channel = options.channel;
      }
      this.noteDeliveryEvent(file, current, updated, 'receipt');
      this.put(key, file, updated);
      this.onRecorded?.();
      this.onRecord?.(updated);
      return updated;
    }
    const attempt = (this.attempts.get(attemptKey) ?? 0) + 1;
    this.attempts.set(attemptKey, attempt);
    const record: HotReloadDeliveryRecord = {
      rootId: key.rootId,
      targetId: key.targetId,
      file,
      outcome,
      attempt,
      recordedAt: options.now ?? this.now()
    };
    if (options.detail !== undefined) {
      record.detail = options.detail;
    }
    if (options.sentDigest !== undefined) {
      record.sentDigest = options.sentDigest;
    }
    // IDE-HOT-102:首次发送记录带触发源/通道(审计五要素);未提供=该记录
    // 无来源/通道字段(旧调用面如实无,不虚构)。
    if (options.source !== undefined) {
      record.source = options.source;
    }
    if (options.channel !== undefined) {
      record.channel = options.channel;
    }
    this.noteDeliveryEvent(file, undefined, record, 'send');
    this.put(key, file, record);
    this.onRecorded?.();
    this.onRecord?.(record);
    return record;
  }

  /**
   * 采样文件的盘上版本(HOT-VER 状态栏版本号):token 与最近一次相同=无变化;
   * 不同=+1(回退到旧内容也算新一次变化,版本只前进绝不倒退);无记录且
   * token 不可得=不建档(未跟踪如实缺席)。首次建档记 v1、基线同为 1。
   * watcher 事件流与手动触发路径共用本方法——同一文件同一 token 只 +1,
   * 两条路径不产生两套计数。
   */
  noteFileVersion(
    file: string,
    token: string | undefined,
    at?: number
  ): { state: HotReloadFileVersionState; change: HotReloadFileVersionChange } | undefined {
    const when = at ?? this.now();
    const existing = this.versionStates.get(file);
    if (!existing) {
      if (token === undefined) {
        return undefined;
      }
      const state: HotReloadFileVersionState = {
        file,
        version: 1,
        baseline: 1,
        token,
        seq: ++this.versionSeq,
        events: []
      };
      this.pushVersionEvent(state, { at: when, kind: 'tracked', version: 1 });
      this.versionStates.set(file, state);
      return { state, change: 'tracked' };
    }
    if (token === undefined) {
      // 盘上版本不可得(stat 失败):不猜、不跳号,原样返回
      return { state: existing, change: 'unchanged' };
    }
    if (existing.token === undefined) {
      // 记录先行(手动发送先建档、token 未知):首次采样只补 token,不跳号
      existing.token = token;
      return { state: existing, change: 'adopted' };
    }
    if (existing.token === token) {
      return { state: existing, change: 'unchanged' };
    }
    existing.token = token;
    existing.version += 1;
    existing.seq = ++this.versionSeq;
    this.pushVersionEvent(existing, { at: when, kind: 'bump', version: existing.version });
    return { state: existing, change: 'bump' };
  }

  /** 已跟踪文件的版本状态(未跟踪=undefined,不虚构版本号) */
  fileVersion(file: string): HotReloadFileVersionState | undefined {
    return this.versionStates.get(file);
  }

  /** 全部已跟踪文件(按建档序) */
  fileVersions(): HotReloadFileVersionState[] {
    return [...this.versionStates.values()];
  }

  /**
   * 基线追平到当前版本(HOT-VER:applied 回执且 digest 与当前盘上一致时调用):
   * 只前进不后退,已追平返回 false(幂等);基线恒 ≤ 当前版本。
   */
  advanceFileVersionBaseline(file: string, at?: number): boolean {
    const state = this.versionStates.get(file);
    if (!state || state.baseline >= state.version) {
      return false;
    }
    state.baseline = state.version;
    this.pushVersionEvent(state, { at: at ?? this.now(), kind: 'baseline', version: state.version });
    return true;
  }

  /** 该文件全部 applied 记录的发送时点冻结 digest(跨目标;无=[]) */
  appliedSentDigestsForFile(file: string): string[] {
    const digests: string[] = [];
    for (const byTarget of this.targets.values()) {
      for (const byFile of byTarget.values()) {
        const record = byFile.get(file);
        if (record?.outcome === 'applied' && record.sentDigest !== undefined) {
          digests.push(record.sentDigest);
        }
      }
    }
    return digests;
  }

  /** 首次跟踪建档(无 token):手动发送先于任何采样时用,后续采样补 token 不跳号 */
  private ensureFileVersionState(file: string, at: number): HotReloadFileVersionState {
    const existing = this.versionStates.get(file);
    if (existing) {
      return existing;
    }
    const state: HotReloadFileVersionState = {
      file,
      version: 1,
      baseline: 1,
      seq: ++this.versionSeq,
      events: []
    };
    this.pushVersionEvent(state, { at, kind: 'tracked', version: 1 });
    this.versionStates.set(file, state);
    return state;
  }

  /**
   * 投递事件进版本史(报告面):新发送推一条;回执改写 outcome 推一条;
   * 同代同态写回(如补落 sentDigest)并入既有事件,不重复计数。
   * 事件盖章的是写回时已知的版本——盘上采样滞后一拍时报告按时间序读,徽标
   * 号本身始终以最近一次采样为准。
   */
  private noteDeliveryEvent(
    file: string,
    previous: HotReloadDeliveryRecord | undefined,
    next: HotReloadDeliveryRecord,
    stage: 'send' | 'receipt'
  ): void {
    const state = this.ensureFileVersionState(file, next.recordedAt);
    if (stage === 'receipt' && previous && previous.attempt === next.attempt && previous.outcome === next.outcome) {
      const mergeTarget = [...state.events]
        .reverse()
        .find(event => event.kind === 'delivery' && event.attempt === next.attempt);
      if (mergeTarget) {
        if (mergeTarget.digest8 === undefined && next.sentDigest !== undefined) {
          mergeTarget.digest8 = next.sentDigest.slice(0, 8);
        }
        return;
      }
    }
    this.pushVersionEvent(state, {
      at: next.recordedAt,
      kind: 'delivery',
      version: state.version,
      stage,
      outcome: next.outcome,
      attempt: next.attempt,
      ...(next.sentDigest !== undefined ? { digest8: next.sentDigest.slice(0, 8) } : {}),
      rootId: next.rootId,
      targetId: next.targetId
    });
  }

  private pushVersionEvent(state: HotReloadFileVersionState, event: HotReloadFileVersionEvent): void {
    state.events.push(event);
    if (state.events.length > HOT_RELOAD_VERSION_EVENT_CAP) {
      state.events.splice(0, state.events.length - HOT_RELOAD_VERSION_EVENT_CAP);
    }
  }

  private put(key: HotReloadTargetKey, file: string, record: HotReloadDeliveryRecord): void {
    let byTarget = this.targets.get(key.rootId);
    if (!byTarget) {
      byTarget = new Map();
      this.targets.set(key.rootId, byTarget);
    }
    let byFile = byTarget.get(key.targetId);
    if (!byFile) {
      byFile = new Map();
      byTarget.set(key.targetId, byFile);
    }
    byFile.set(file, record);
  }

  get(key: HotReloadTargetKey, file: string): HotReloadDeliveryRecord | undefined {
    return this.targets.get(key.rootId)?.get(key.targetId)?.get(file);
  }

  /** 有记录的目标(按 rootId、targetId 字典序,输出稳定) */
  targetsWithRecords(): HotReloadTargetKey[] {
    const keys: HotReloadTargetKey[] = [];
    for (const [rootId, byTarget] of [...this.targets.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      for (const targetId of [...byTarget.keys()].sort((a, b) => a.localeCompare(b))) {
        keys.push({ rootId, targetId });
      }
    }
    return keys;
  }

  /** 某目标名下有记录的文件(按写入序) */
  files(key: HotReloadTargetKey): string[] {
    const byFile = this.targets.get(key.rootId)?.get(key.targetId);
    return byFile ? [...byFile.keys()] : [];
  }

  clearTarget(key: HotReloadTargetKey): void {
    this.targets.get(key.rootId)?.delete(key.targetId);
  }
}
