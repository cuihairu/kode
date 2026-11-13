/**
 * .def 指纹三路比对纯核(HR-PR-07,书 §19.8 HR-HASH-006/008):
 * - HR-HASH-008 文件修改后的三路判定:上次本地指纹 vs 当前指纹 vs 服务端
 *   已应用 Digest,各路独立给 一致/不同/未知,不并路不冒充;
 * - 跨类纪律继承 hotReloadDefHash/RevisionEvidence:fileHash(sha256)与
 *   engineDigest(引擎复合 MD5)是不同算法/不同输入,**永不互比**;
 *   appliedConsistency 只在「引擎算法已协商(md5)+本地按同算法重算+引擎
 *   回执 Digest 三者齐」时才给 consistent/different——缺任一环如实 unknown
 *   并点名原因,不猜;
 * - 同类才可比:fileChanged 只比 fileHash 对,semanticChanged 只比语义
 *   指纹对(structuralFingerprintHash 产物);值缺失/解析失败(null)→ unknown;
 * - HR-HASH-006 FingerprintProvider(profile)面:引擎 fork/版本差异交协商
 *   (negotiateEngineDigest);协商不出算法如实标 `not available`,不替
 *   引擎猜算法,本地 sha256 绝不冒充运行时协议 Hash(HR-HASH-005 同源)。
 * 纯逻辑零 vscode;执行编排仍归 tempEdit/defMd5Check 既有面。
 */

import { negotiateEngineDigest } from './hotReloadDefHash';

/** 三路比对输入:各路可选,缺=该路如实 unknown(不猜不补) */
export interface FingerprintTriCompareInput {
  /** 上次记录的 fileHash(hashDefContent 产物 sha256 hex) */
  readonly lastLocalFileHash?: string;
  /** 当前 fileHash */
  readonly currentFileHash?: string;
  /** 上次语义指纹(structuralFingerprintHash 产物;null=当时解析失败) */
  readonly lastSemanticHash?: string | null;
  /** 当前语义指纹(null=当前解析失败) */
  readonly currentSemanticHash?: string | null;
  /** 本地按引擎已协商算法重算的 MD5(仅同类对拍用;sha256 不入此参) */
  readonly localRecomputedMd5?: string;
  /** 引擎回执报告的 Digest(运行时证据) */
  readonly serverAppliedDigest?: string;
  /** 引擎 Digest 协商输入(引擎报告的算法标识;缺省=未协商) */
  readonly engineMd5?: string;
}

export type FingerprintTriState = 'changed' | 'unchanged' | 'unknown';
export type AppliedConsistency = 'consistent' | 'different' | 'unknown';

export interface FingerprintTriVerdict {
  readonly fileChanged: FingerprintTriState;
  readonly semanticChanged: FingerprintTriState;
  readonly appliedConsistency: AppliedConsistency;
  /** 每路 unknown 的原因逐条点名(展示面可审;可判定路不产原因) */
  readonly reasons: string[];
}

/** 同类对拍:两侧都有值才判,缺=unknown+原因(null 先于空串判,防 null 取 length) */
const compareSameKind = (
  last: string | null | undefined,
  current: string | null | undefined,
  missingReason: string,
  parseFailReason: string
): { state: FingerprintTriState; reason?: string } => {
  if (last === undefined || current === undefined) {
    return { state: 'unknown', reason: missingReason };
  }
  if (last === null || current === null) {
    return { state: 'unknown', reason: parseFailReason };
  }
  if (last.length === 0 || current.length === 0) {
    return { state: 'unknown', reason: missingReason };
  }
  return { state: last === current ? 'unchanged' : 'changed' };
};

/**
 * HR-HASH-008 三路判定:文件修改后给出 fileHash 对、语义指纹对、
 * 引擎已应用 Digest 三路的独立结论。未知理由逐条可审。
 */
export function compareFingerprints(input: FingerprintTriCompareInput): FingerprintTriVerdict {
  const reasons: string[] = [];

  const file = compareSameKind(
    input.lastLocalFileHash,
    input.currentFileHash,
    'fileHash 缺失(上次或当前),文件是否变化未知',
    '一侧 def 解析失败无语义可比(如实未知)' // fileHash 不涉解析,该 reason 实际不可达,保留对称口径
  );
  if (file.reason) {
    reasons.push(file.reason);
  }

  const semantic = compareSameKind(
    input.lastSemanticHash,
    input.currentSemanticHash,
    '语义指纹缺失(上次或当前),结构是否变化未知',
    '一侧 def 解析失败无语义指纹,结构是否变化未知'
  );
  if (semantic.reason) {
    reasons.push(semantic.reason);
  }

  let appliedConsistency: AppliedConsistency = 'unknown';
  const handshake = negotiateEngineDigest(input.engineMd5);
  if (!handshake.negotiated || handshake.algorithm === 'unknown') {
    reasons.push('引擎 Digest 算法未协商(not available),已应用一致性未知(跨类不比,不猜引擎算法)');
  } else if (input.serverAppliedDigest === undefined || input.serverAppliedDigest.length === 0) {
    reasons.push('引擎未报告已应用 Digest,已应用一致性未知');
  } else if (input.localRecomputedMd5 === undefined || input.localRecomputedMd5.length === 0) {
    reasons.push('本地未按引擎算法重算摘要,已应用一致性未知(客户端 sha256 与引擎 MD5 跨类不比)');
  } else {
    appliedConsistency = input.localRecomputedMd5 === input.serverAppliedDigest ? 'consistent' : 'different';
  }

  return {
    fileChanged: file.state,
    semanticChanged: semantic.state,
    appliedConsistency,
    reasons
  };
}

/** HR-HASH-006 指纹档案(profile):算法协商结果+面向 UI 的如实标签 */
export interface FingerprintProfile {
  readonly digestAlgorithm: 'md5' | 'unknown';
  readonly negotiated: boolean;
  /** 协商出算法给算法名;协商不出如实 `not available`,不猜 */
  readonly label: string;
}

export function resolveFingerprintProfile(engineMd5?: string): FingerprintProfile {
  const handshake = negotiateEngineDigest(engineMd5);
  return {
    digestAlgorithm: handshake.algorithm,
    negotiated: handshake.negotiated,
    label: handshake.negotiated ? handshake.algorithm : 'not available'
  };
}
