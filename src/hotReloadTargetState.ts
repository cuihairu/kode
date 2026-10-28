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

/** 三态:发出未确认(绿但未证实)/回执 accepted(HOT-003)/失败 */
export type HotReloadDeliveryOutcome = 'sent-unverified' | 'accepted' | 'failed';

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
}

export interface HotReloadTargetStateDeps {
  now(): number;
}

/**
 * 双维隔离台账:内层 rootId → targetId → file → 最新一条记录。
 * 同目标同文件重发=覆盖为最新一次(重试语义),跨目标零牵连。
 */
export class HotReloadTargetStateStore {
  private readonly now: () => number;
  private readonly targets = new Map<string, Map<string, Map<string, HotReloadDeliveryRecord>>>();

  constructor(deps: HotReloadTargetStateDeps) {
    this.now = deps.now;
  }

  record(
    key: HotReloadTargetKey,
    file: string,
    outcome: HotReloadDeliveryOutcome,
    options: { detail?: string; now?: number } = {}
  ): HotReloadDeliveryRecord {
    const record: HotReloadDeliveryRecord = {
      rootId: key.rootId,
      targetId: key.targetId,
      file,
      outcome,
      recordedAt: options.now ?? this.now()
    };
    if (options.detail !== undefined) {
      record.detail = options.detail;
    }
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
    return record;
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
