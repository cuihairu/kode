/**
 * 运行时 revision 的证据来源标签(IDE-HOT-008):三类证据各自带来源标
 * 签——fileHash(本地对文件内容重算的哈希)/semanticHash(结构指纹)/
 * engineDigest(运行时回执报告的 digest),展示逐条点名不混叫。跨类
 * 不比较:即便 fileHash 与 engineDigest 的值巧合相同也不判「一致」
 * (本地哈希不能冒充运行时证据);同类值比对是协议内验证手段(HOT-004
 * 的 digest 重算即 fileHash 证据的用途),跨类只各自展示。证据集合报
 * 告只列实际提供的种类,缺的种类不填空不冒充。
 */

export type HotReloadRevisionEvidenceKind = 'fileHash' | 'semanticHash' | 'engineDigest';

export interface HotReloadRevisionEvidence {
  kind: HotReloadRevisionEvidenceKind;
  /** 完整指纹值(hex),展示面截断、存取面全量 */
  value: string;
  /** 来源说明(谁算的/从哪来) */
  origin: string;
}

/** 三类标签各自点名来源,不共用笼统说法 */
export const revisionEvidenceLabel: Record<HotReloadRevisionEvidenceKind, string> = {
  fileHash: 'fileHash(本地文件内容哈希重算)',
  semanticHash: 'semanticHash(结构语义指纹)',
  engineDigest: 'engineDigest(运行时回执报告)'
};

/** 证据构造:空/纯空白值不成证据,拒绝 */
export function makeRevisionEvidence(
  kind: HotReloadRevisionEvidenceKind,
  value: string,
  origin = ''
): HotReloadRevisionEvidence {
  if (value.trim().length === 0) {
    throw new Error(`revision 证据(${kind})值不能为空:没有值不成证据`);
  }
  return { kind, value, origin };
}

/** 单条展示:来源标签+截断值(前 12 位)+origin */
export function formatRevisionEvidence(evidence: HotReloadRevisionEvidence): string {
  const origin = evidence.origin.length > 0 ? `,${evidence.origin}` : '';
  return `${revisionEvidenceLabel[evidence.kind]}: ${evidence.value.slice(0, 12)}…${origin}`;
}

export type RevisionEvidenceComparison = 'match' | 'mismatch' | 'incomparable';

/**
 * 证据比对:同类比值(同=match/异=mismatch);跨类一律 incomparable——
 * 值巧合相同也不判一致,本地哈希不冒充运行时证据。
 */
export function compareRevisionEvidence(
  a: HotReloadRevisionEvidence,
  b: HotReloadRevisionEvidence
): RevisionEvidenceComparison {
  if (a.kind !== b.kind) {
    return 'incomparable';
  }
  return a.value === b.value ? 'match' : 'mismatch';
}

/** 证据集合展示:逐行带标签,只列提供的种类(缺的不填空) */
export function formatRevisionEvidenceReport(
  evidences: Partial<Record<HotReloadRevisionEvidenceKind, HotReloadRevisionEvidence>>
): string {
  const lines: string[] = [];
  for (const kind of ['fileHash', 'semanticHash', 'engineDigest'] as const) {
    const evidence = evidences[kind];
    if (evidence) {
      lines.push(formatRevisionEvidence(evidence));
    }
  }
  if (lines.length === 0) {
    return '无 revision 证据(未重算本地哈希、无语义指纹、运行时也未回执)';
  }
  return lines.join('\n');
}
