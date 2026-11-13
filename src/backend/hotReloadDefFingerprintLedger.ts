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

import {
  compareFingerprints,
  type FingerprintTriCompareInput,
  type FingerprintTriVerdict
} from './hotReloadFingerprintCompare';

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

/** def 指纹台账:按文件存底上次快照(接线批装配持有,生命周期随宿主) */
export class DefFingerprintLedger {
  private readonly byFile = new Map<string, DefFingerprintSnapshot>();

  /** 上次快照;首见=null(如实缺,不编基线) */
  last(file: string): DefFingerprintSnapshot | null {
    return this.byFile.get(file) ?? null;
  }

  record(file: string, snapshot: DefFingerprintSnapshot): void {
    this.byFile.set(file, snapshot);
  }

  /** 生命周期:清空存底(宿主 dispose;重记录即重建) */
  clear(): void {
    this.byFile.clear();
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
