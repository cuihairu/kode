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

/**
 * 运行时回执的 digest 提取(IDE-REV-027 接线):回包体是 JSON 对象且带
 * 非空 digest 与非空 file 回显才算运行时报告过 digest;file 回显用于归
 * 属——回执不点名该文件就不把 digest 记到它名下(归属不猜)。非 JSON/
 * 缺 digest/缺回显一律 null。
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

/** 引擎回执 digest 证据册条目:值 + 入册时刻(展示用「最近一次回执」口径) */
export interface EngineDigestRecord {
  digest: string;
  at: number;
}

/**
 * 会话内引擎 digest 证据册(IDE-REV-027):按 (rootId,targetId,file) 记
 * 最近一次运行时回执报告的 digest——它是运行时证据(engineDigest 类),
 * 与本地重算的 fileHash 各自展示,跨类不比较、不互相冒充。
 */
export class HotReloadEngineDigestRegister {
  private readonly byKeyFile = new Map<string, EngineDigestRecord>();
  private readonly now: () => number;

  constructor(deps: { now?: () => number } = {}) {
    this.now = deps.now ?? Date.now;
  }

  /** 原始回包体喂入:协议面认得(非空 digest+逐字回显该文件)才入册 */
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

  /** 该 (目标,文件) 最近一次运行时回执 digest;无记录=null(如实缺) */
  receipt(key: { rootId: string; targetId: string }, file: string): EngineDigestRecord | null {
    return this.byKeyFile.get(`${key.rootId}::${key.targetId}\u0000${file}`) ?? null;
  }
}
