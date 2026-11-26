/**
 * .def fingerprint three-way comparison pure core (HR-PR-07, spec §19.8
 * HR-HASH-006/008):
 * - HR-HASH-008 three-way judgment after a file modification: last local
 *   fingerprint vs current fingerprint vs the server-side applied Digest.
 *   Each lane reports match / differ / unknown independently — lanes are
 *   never merged and never masquerade for one another;
 * - Cross-kind discipline inherited from hotReloadDefHash /
 *   RevisionEvidence: fileHash (sha256) and engineDigest (the engine's
 *   composite MD5) are different algorithms over different inputs and are
 *   **never compared against each other**;
 *   appliedConsistency only yields consistent / different when "the engine
 *   algorithm has been negotiated (md5) + locally recomputed with the same
 *   algorithm + the engine's receipt Digest" are all three present — if any
 *   link is missing it is honestly unknown, with the reason named, never
 *   guessed;
 * - Only same-kind values are comparable: fileChanged compares only the
 *   fileHash pair, semanticChanged only the semantic fingerprint pair
 *   (structuralFingerprintHash output); a missing value or parse failure
 *   (null) -> unknown;
 * - HR-HASH-006 FingerprintProvider (profile) face: engine fork / version
 *   differences are handed to negotiation (negotiateEngineDigest); when no
 *   algorithm negotiates, it is honestly labeled `not available` — we do not
 *   guess an algorithm on the engine's behalf, and local sha256 never
 *   impersonates the runtime protocol Hash (same origin as HR-HASH-005).
 * Pure logic, zero vscode; execution orchestration still belongs to the
 * existing tempEdit / defMd5Check faces.
 */

import { negotiateEngineDigest } from './hotReloadDefHash';

/** Three-way comparison input: each lane is optional; missing = that lane is honestly unknown (never guessed, never filled in) */
export interface FingerprintTriCompareInput {
  /** Last recorded fileHash (hashDefContent output, sha256 hex) */
  readonly lastLocalFileHash?: string;
  /** Current fileHash */
  readonly currentFileHash?: string;
  /** Last semantic fingerprint (structuralFingerprintHash output; null = the parse had failed then) */
  readonly lastSemanticHash?: string | null;
  /** Current semantic fingerprint (null = the current parse failed) */
  readonly currentSemanticHash?: string | null;
  /** MD5 recomputed locally with the engine's negotiated algorithm (same-kind pairing only; sha256 never enters this parameter) */
  readonly localRecomputedMd5?: string;
  /** Digest reported by the engine's receipt (runtime evidence) */
  readonly serverAppliedDigest?: string;
  /** Engine Digest negotiation input (the algorithm identifier reported by the engine; defaults to not negotiated) */
  readonly engineMd5?: string;
}

export type FingerprintTriState = 'changed' | 'unchanged' | 'unknown';
export type AppliedConsistency = 'consistent' | 'different' | 'unknown';

export interface FingerprintTriVerdict {
  readonly fileChanged: FingerprintTriState;
  readonly semanticChanged: FingerprintTriState;
  readonly appliedConsistency: AppliedConsistency;
  /** The unknown reason named one by one for each lane (auditable on the display face; decidable lanes produce no reason) */
  readonly reasons: string[];
}

/** Same-kind pairing: only judged when both sides have a value; missing = unknown + reason (null is checked before the empty string, so we never take length on null) */
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
 * HR-HASH-008 three-way judgment: after a file modification, produce the
 * independent conclusions for the fileHash pair, the semantic fingerprint
 * pair, and the engine's applied Digest. The unknown reasons are auditable
 * one by one.
 */
export function compareFingerprints(input: FingerprintTriCompareInput): FingerprintTriVerdict {
  const reasons: string[] = [];

  const file = compareSameKind(
    input.lastLocalFileHash,
    input.currentFileHash,
    'fileHash 缺失(上次或当前),文件是否变化未知',
    '一侧 def 解析失败无语义可比(如实未知)' // fileHash is not involved in parsing, so this reason is actually unreachable; kept for the symmetric convention
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

/** HR-HASH-006 fingerprint profile: the algorithm negotiation result plus the honest UI-facing label */
export interface FingerprintProfile {
  readonly digestAlgorithm: 'md5' | 'unknown';
  readonly negotiated: boolean;
  /** When an algorithm negotiates, give its name; when none negotiates, honestly report `not available` — never guess */
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
