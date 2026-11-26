/**
 * Evidence source labels for runtime revision (IDE-HOT-008): the three kinds
 * of evidence each carry a source label -- fileHash (a hash recomputed locally
 * over the file content) / semanticHash (the structural fingerprint) /
 * engineDigest (the digest reported by the runtime receipt), displayed one by
 * one with named sources and never mixed up. Kinds are never compared across
 * categories: even if a fileHash and an engineDigest value coincidentally
 * match, they are never judged "identical" (a local hash cannot masquerade
 * as runtime evidence); comparing same-kind values is an in-protocol
 * verification means (HOT-004's digest recomputation is the very use of
 * the fileHash evidence), and across categories each is just displayed. An
 * evidence-set report only lists the kinds actually provided, and a missing
 * kind is neither padded nor faked.
 */

export type HotReloadRevisionEvidenceKind = 'fileHash' | 'semanticHash' | 'engineDigest';

export interface HotReloadRevisionEvidence {
  kind: HotReloadRevisionEvidenceKind;
  /** Full fingerprint value (hex); the display surface truncates it, the store surface keeps it whole */
  value: string;
  /** Source description (who computed it / where it came from) */
  origin: string;
}

/** The three labels each name their own source; no catch-all shared phrasing */
export const revisionEvidenceLabel: Record<HotReloadRevisionEvidenceKind, string> = {
  fileHash: 'fileHash(本地文件内容哈希重算)',
  semanticHash: 'semanticHash(结构语义指纹)',
  engineDigest: 'engineDigest(运行时回执报告)'
};

/** Evidence construction: an empty / whitespace-only value does not become evidence -- reject it */
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

/** Single-item display: source label + truncated value (first 12 chars) + origin */
export function formatRevisionEvidence(evidence: HotReloadRevisionEvidence): string {
  const origin = evidence.origin.length > 0 ? `,${evidence.origin}` : '';
  return `${revisionEvidenceLabel[evidence.kind]}: ${evidence.value.slice(0, 12)}…${origin}`;
}

export type RevisionEvidenceComparison = 'match' | 'mismatch' | 'incomparable';

/**
 * Evidence comparison: same-kind values (equal = match / different =
 * mismatch); cross-category is always incomparable -- a coincidental value
 * match is never judged identical, and a local hash never masquerades as
 * runtime evidence.
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

/** Evidence-set display: line by line with labels, listing only the kinds provided (missing ones are not padded) */
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

/**
 * Digest extraction from the runtime receipt (IDE-REV-027 wiring): only a
 * reply body that is a JSON object carrying a non-empty digest and a
 * non-empty file echo counts as the runtime having reported a digest; the
 * file echo is used for attribution -- if the receipt does not name that
 * file, the digest is not recorded under it (attribution is never guessed
 * at). Not-JSON / missing digest / missing echo all return null.
 */
export function parseEngineDigestReceipt(
  body: string | undefined
): { digest: string; file: string } | null {
  if (typeof body !== 'string' || body.length === 0) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const receipt = parsed as Record<string, unknown>;
  if (typeof receipt.digest !== 'string' || receipt.digest.length === 0) {
    return null;
  }
  if (typeof receipt.file !== 'string' || receipt.file.length === 0) {
    return null;
  }
  return { digest: receipt.digest, file: receipt.file };
}

/** An engine-receipt digest evidence-register entry: value + the moment it was registered (the "most recent receipt" display convention) */
export interface EngineDigestRecord {
  digest: string;
  at: number;
}

/**
 * In-session engine digest evidence register (IDE-REV-027): records, per
 * (rootId,targetId,file), the digest of the most recent runtime receipt --
 * it is runtime evidence (the engineDigest kind), displayed alongside the
 * locally recomputed fileHash, and across categories never compared and
 * never impersonating one another.
 */
export class HotReloadEngineDigestRegister {
  private readonly byKeyFile = new Map<string, EngineDigestRecord>();
  private readonly now: () => number;

  constructor(deps: { now?: () => number } = {}) {
    this.now = deps.now ?? Date.now;
  }

  /** Feed the raw reply body in: only the protocol surface accepts it (non-empty digest + a byte-identical echo of that file) for registration */
  note(key: { rootId: string; targetId: string }, file: string, body: string | undefined): void {
    const receipt = parseEngineDigestReceipt(body);
    if (!receipt || receipt.file !== file) {
      return;
    }
    this.byKeyFile.set(`${key.rootId}::${key.targetId}\u0000${file}`, {
      digest: receipt.digest,
      at: this.now()
    });
  }

  /** The most recent runtime-receipt digest for that (target, file); no record = null (honestly absent) */
  receipt(key: { rootId: string; targetId: string }, file: string): EngineDigestRecord | null {
    return this.byKeyFile.get(`${key.rootId}::${key.targetId}\u0000${file}`) ?? null;
  }
}
