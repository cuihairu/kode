/**
 * 按引擎版本保存 drift 联验证据(IDE-DB-006):记录把「实际查询面」
 * (真实 MySQL 查询所得)与「模拟 schema 面」(虚拟表结构推导)分开
 * 存,结论分类不冒充——引擎版本 unknown 只给 unknown-version(不宣
 * 称兼容);没有实际查询(queried=null)只给 unverified;实测无漂移
 * 才 compatible-verified;有漂移如实 drift-found。按版本保存,同版
 * 本重录覆盖为最新一次;持久化经注入 load/save(workspaceState 形)。
 */

export interface DriftEvidenceFace {
  summary: string;
}

export interface DriftEvidenceRecord {
  /** 引擎版本标识;探测不到记 'unknown' */
  engineVersion: string;
  /** 实际查询面:真实 MySQL 查询所得摘要;未连接未查询为 null */
  queried: DriftEvidenceFace | null;
  /** 模拟 schema 面:虚拟表结构推导摘要(始终有——drift 对比的基准侧) */
  simulated: DriftEvidenceFace;
  /** 漂移结论摘要;空串=未发现漂移 */
  driftSummary: string;
  recordedAt: number;
}

export type DriftEvidenceVerdict =
  | { verdict: 'compatible-verified'; detail: string }
  | { verdict: 'unverified'; detail: string }
  | { verdict: 'unknown-version'; detail: string }
  | { verdict: 'drift-found'; detail: string };

/** 结论分类:版本未知不宣称兼容,纯模拟面不冒充实测 */
export function classifyDriftEvidence(recorded: DriftEvidenceRecord): DriftEvidenceVerdict {
  if (recorded.engineVersion === 'unknown' || recorded.engineVersion.trim().length === 0) {
    return { verdict: 'unknown-version', detail: `引擎版本 unknown:不宣称兼容(证据与哪个版本对不上,结论悬置)` };
  }
  if (recorded.queried === null) {
    return { verdict: 'unverified', detail: `仅模拟 schema 面(虚拟表结构推导),无实际查询:未验证,不冒充实测` };
  }
  if (recorded.driftSummary.length > 0) {
    return { verdict: 'drift-found', detail: `实测发现漂移:${recorded.driftSummary}` };
  }
  return { verdict: 'compatible-verified', detail: `实测无漂移(${recorded.queried.summary})` };
}

export interface DriftEvidenceStoreDeps {
  now(): number;
  load?(): unknown;
  save?(data: unknown): void;
}

interface StoredEvidence {
  byVersion: DriftEvidenceRecord[];
}

const isRecordShape = (value: unknown): value is DriftEvidenceRecord => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.engineVersion === 'string' &&
    (candidate.queried === null || (typeof candidate.queried === 'object' && candidate.queried !== null)) &&
    typeof candidate.simulated === 'object' &&
    candidate.simulated !== null &&
    typeof candidate.driftSummary === 'string' &&
    typeof candidate.recordedAt === 'number'
  );
};

/** 按版本保存:同版本覆盖为最新一次;持久化注入 */
export class DriftEvidenceStore {
  private readonly now: () => number;
  private readonly persist?: (data: unknown) => void;
  private readonly byVersionMap = new Map<string, DriftEvidenceRecord>();

  constructor(deps: DriftEvidenceStoreDeps) {
    this.now = deps.now;
    this.persist = deps.save;
    const payload = deps.load?.();
    if (typeof payload === 'object' && payload !== null && !Array.isArray(payload)) {
      const list = (payload as StoredEvidence).byVersion;
      if (Array.isArray(list)) {
        for (const entry of list) {
          if (isRecordShape(entry)) {
            this.byVersionMap.set(entry.engineVersion, entry);
          }
        }
      }
    }
  }

  save(recorded: DriftEvidenceRecord): DriftEvidenceRecord {
    const entry = { ...recorded, recordedAt: recorded.recordedAt || this.now() };
    this.byVersionMap.set(entry.engineVersion, entry);
    this.persist?.({ byVersion: [...this.byVersionMap.values()] });
    return entry;
  }

  /** 各版本最新一条(按 recordedAt 降序) */
  byVersion(): DriftEvidenceRecord[] {
    return [...this.byVersionMap.values()].sort((a, b) => b.recordedAt - a.recordedAt);
  }

  /** 全部版本里最新的一条;无记录 undefined */
  latest(): DriftEvidenceRecord | undefined {
    return this.byVersion()[0];
  }
}
