/**
 * def 指纹台账接线核(HR-HASH-007/008 接线批):
 * - 台账:每个 .def 文件存底「上次本地指纹快照」(fileHash+语义指纹+来源+
 *   计时),修改触发面据此与当前快照做三路判定;
 * - 来源标签(HR-HASH-002 VFS 字节复用):document=打开缓冲区字节(已复用,
 *   不重读磁盘),disk=磁盘补载——读面经 readSharedFileSnapshot(缓冲区
 *   优先),UI 显示与修改触发都走同一读面,不为显示单独重读文件;
 * - 三路判定输入组装:上次/当前同类对(fileHash 对+语义指纹对)如实映射进
 *   compareFingerprints;applied 维度(def 无逐文件运行时回执)由调用方给,
 *   不给=该路如实 unknown+点名原因,绝不拿客户端 sha256 冒充引擎摘要;
 * - 纯逻辑零 vscode;快照生产(读面/计时)与呈现面归装配(defFingerprintInspector)。
 */

import { DEF_FINGERPRINT_SPEC_VERSION } from './hotReloadDefStructure';
import {
  compareFingerprints,
  type FingerprintTriCompareInput,
  type FingerprintTriVerdict
} from './hotReloadFingerprintCompare';

/** RUST-401 持久化存底键(workspaceState Memento 命名空间) */
export const DEF_FINGERPRINT_LEDGER_STORAGE_KEY = 'kbengine.defFingerprintLedger';

/**
 * RUST-401 持久化面:workspaceState Memento 的结构子集(get/update)。
 * update 可返回 Thenable(真 Memento 即 Thenable);调用方不阻塞等待落盘
 * (持久化是尽力而为的审计/恢复面,失败静默——不阻断指纹判定主路径)。
 */
export interface DefFingerprintLedgerStorage {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<unknown> | unknown;
}

/** 持久化表项:file 键(绝对 fsPath,契约同台账)+ 元数据快照 */
interface PersistedDefFingerprintEntry {
  readonly file: string;
  readonly snapshot: DefFingerprintSnapshot;
}

/** 持久化载荷:规范版本键 + 表项数组(不匹配即整体丢弃) */
interface PersistedDefFingerprintLedger {
  readonly specVersion: string;
  readonly entries: PersistedDefFingerprintEntry[];
}

/** 单次快照:读面来源 + 三类值 + 计时(HR-HASH-007 Inspector 展示字段) */
export interface DefFingerprintSnapshot {
  /** hashDefContent 产物 sha256 hex(64 位小写) */
  readonly fileHash: string;
  /** 摘要输入字节数(回显/对账,不参与判定) */
  readonly byteLength: number;
  /** structuralFingerprintHash 产物;null=当前解析失败(如实 unknown) */
  readonly semanticHash: string | null;
  /** 读面来源:document=打开缓冲区字节(VFS 已有字节复用,不重读)/disk=磁盘补载 */
  readonly source: 'document' | 'disk';
  /** 计算时点(epoch ms,装配 now 面注入) */
  readonly at: number;
  /** 指纹计算耗时 ms(读面耗时不含) */
  readonly durationMs: number;
}

/** applied 维度输入(可选;def 逐文件运行时回执缺位时调用方不传=unknown) */
export interface DefAppliedDigestInput {
  readonly localRecomputedMd5?: string;
  readonly serverAppliedDigest?: string;
  readonly engineMd5?: string;
}

/**
 * def 指纹台账:按文件存底上次快照(接线批装配持有,生命周期随宿主)。
 *
 * 键形态契约(RUST-003 收口,tests/hotReloadDefFingerprintLedger.test.ts
 * 「键形态契约」块钉):键必须**根无歧义**——多 root 工作区同一相对路径
 * (rootA/scripts/x.def 与 rootB/scripts/x.def)是两个不同文件,键若用
 * 相对路径必串册。装配侧一律传绝对 fsPath(或含 root 前缀的等价键);
 * 台账是纯核不做路径解析,键区分度责任在装配(装配批接线时受此契约约束)。
 * 语义:同键重记录=时间性覆盖(上次 vs 当前判变更,不判版本身份)。
 */
export class DefFingerprintLedger {
  private readonly byFile = new Map<string, DefFingerprintSnapshot>();

  constructor(
    /** RUST-401:持久化面(Memento 子集;缺省=会话内存,不落盘);写只存元数据快照 */
    private readonly storage?: DefFingerprintLedgerStorage,
    /** 指纹规范版本键(破坏性变更分级):不匹配的旧存底丢弃,重算 */
    private readonly specVersion: string = DEF_FINGERPRINT_SPEC_VERSION
  ) {
    this.hydrate();
  }

  /** 上次快照;首见=null(如实缺,不编基线) */
  last(file: string): DefFingerprintSnapshot | null {
    return this.byFile.get(file) ?? null;
  }

  record(file: string, snapshot: DefFingerprintSnapshot): void {
    this.byFile.set(file, snapshot);
    this.persist();
  }

  /** 生命周期:清空存底(宿主 dispose;重记录即重建) */
  clear(): void {
    this.byFile.clear();
    this.persist();
  }

  /**
   * RUST-401:启动恢复——读持久化存底,只载入与当前指纹规范版本一致的表项;
   * 版本不一致 = 旧指纹算法/规范已变,跨版本不可比(HR-HASH-003 口径),
   * 丢弃让下一次记录重新计算(版本键分级只认破坏性变更)。
   */
  private hydrate(): void {
    if (!this.storage) {
      return;
    }
    const raw = this.storage.get(DEF_FINGERPRINT_LEDGER_STORAGE_KEY);
    if (raw === null || raw === undefined || typeof raw !== 'object') {
      return;
    }
    const persisted = raw as Partial<PersistedDefFingerprintLedger>;
    if (persisted.specVersion !== this.specVersion || !Array.isArray(persisted.entries)) {
      return;
    }
    for (const entry of persisted.entries) {
      if (entry && typeof entry === 'object' && typeof entry.file === 'string') {
        const snapshot = entry.snapshot;
        if (snapshot && typeof snapshot === 'object' && typeof snapshot.fileHash === 'string') {
          this.byFile.set(entry.file, snapshot as DefFingerprintSnapshot);
        }
      }
    }
  }

  /** RUST-401:落盘——只写必要元数据(fileHash/byteLength/语义/来源/计时),
   * 绝不缓存源码内容副本(快照本就无 content 字段,序列化天然只含元数据)。
   * 持久化是尽力而为的审计/恢复面:同步抛错与异步拒绝都静默,不阻断判定主路径。 */
  private persist(): void {
    if (!this.storage) {
      return;
    }
    const entries: PersistedDefFingerprintEntry[] = [...this.byFile].map(([file, snapshot]) => ({
      file,
      snapshot
    }));
    const payload: PersistedDefFingerprintLedger = {
      specVersion: this.specVersion,
      entries
    };
    try {
      const result = this.storage.update(DEF_FINGERPRINT_LEDGER_STORAGE_KEY, payload);
      void Promise.resolve(result).catch(() => undefined);
    } catch {
      // 同步抛错也吞:持久化失败不阻断指纹判定
    }
  }
}

/** 无上次快照的三路判定原因(首见只存底不判变更,原因如实点名) */
export const DEF_FINGERPRINT_NO_BASELINE_REASON = '无上次快照(首见只存底,不判变更)';

/**
 * 三路判定输入组装:上次/当前同类对如实映射;applied 维度由调用方给
 * (def 无逐文件回执=不传 → compareFingerprints 点名 unknown 原因)。
 */
export function buildTriCompareInput(
  last: DefFingerprintSnapshot | null,
  current: DefFingerprintSnapshot,
  applied?: DefAppliedDigestInput
): FingerprintTriCompareInput {
  return {
    ...(last ? { lastLocalFileHash: last.fileHash } : {}),
    currentFileHash: current.fileHash,
    ...(last ? { lastSemanticHash: last.semanticHash } : {}),
    currentSemanticHash: current.semanticHash,
    ...(applied?.localRecomputedMd5 !== undefined ? { localRecomputedMd5: applied.localRecomputedMd5 } : {}),
    ...(applied?.serverAppliedDigest !== undefined ? { serverAppliedDigest: applied.serverAppliedDigest } : {}),
    ...(applied?.engineMd5 !== undefined ? { engineMd5: applied.engineMd5 } : {})
  };
}

/** 三路判定(组装+判定一步;首见=null → 两路 unknown+首见原因) */
export function evaluateDefFingerprint(
  last: DefFingerprintSnapshot | null,
  current: DefFingerprintSnapshot,
  applied?: DefAppliedDigestInput
): FingerprintTriVerdict {
  if (last === null) {
    const verdict = compareFingerprints(buildTriCompareInput(null, current, applied));
    return {
      ...verdict,
      reasons: [...verdict.reasons, DEF_FINGERPRINT_NO_BASELINE_REASON]
    };
  }
  return compareFingerprints(buildTriCompareInput(last, current, applied));
}
