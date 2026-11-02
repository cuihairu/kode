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
}

export interface HotReloadTargetStateDeps {
  now(): number;
  /**
   * 台账写入后回调(IDE-HOT-100 呈现面):任何一条记录落账/升级(新发送、
   * 回执升级、注解写回)都触发一次;被拒的旧代写回(record 返回 undefined,
   * 记录原样不动)不触发。接线方借它刷文件树角标/CodeLens 状态点,使呈
   * 现面跟住台账事实(回执落地即时反映,不等下次保存)。
   */
  onRecorded?: () => void;
}

/**
 * 双维隔离台账:内层 rootId → targetId → file → 最新一条记录。
 * 同目标同文件重发=覆盖为最新一次(重试语义),跨目标零牵连。
 */
export class HotReloadTargetStateStore {
  private readonly now: () => number;
  private readonly onRecorded?: () => void;
  private readonly targets = new Map<string, Map<string, Map<string, HotReloadDeliveryRecord>>>();
  /** IDE-AUD-005:发送代际计数——(rootId::targetId::file) → 已发生的发送次数 */
  private readonly attempts = new Map<string, number>();

  constructor(deps: HotReloadTargetStateDeps) {
    this.now = deps.now;
    this.onRecorded = deps.onRecorded;
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
    options: { detail?: string; now?: number; attempt?: number; sentDigest?: string } = {}
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
      this.put(key, file, updated);
      this.onRecorded?.();
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
    this.put(key, file, record);
    this.onRecorded?.();
    return record;
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
