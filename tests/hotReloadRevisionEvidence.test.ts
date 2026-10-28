import { describe, expect, it } from 'vitest';
import {
  compareRevisionEvidence,
  formatRevisionEvidence,
  formatRevisionEvidenceReport,
  makeRevisionEvidence,
  revisionEvidenceLabel
} from '../src/hotReloadRevisionEvidence';

// IDE-HOT-008 显示运行时 revision 的证据来源:三类证据各自带来源标签
// ——fileHash(本地文件内容 sha256 重算)/semanticHash(结构指纹)/
// engineDigest(运行时回执报告),展示逐条点名不混叫;跨类不比较:即便
// fileHash 与 engineDigest 的值巧合相同也不判「一致」(本地哈希不能冒
// 充运行时证据);报告只列实际提供的种类,缺的种类不填空不冒充。

const FILE_HASH = 'a'.repeat(64);
const ENGINE_DIGEST = 'b'.repeat(64);
const SEMANTIC_HASH = 'c'.repeat(64);

describe('makeRevisionEvidence(证据构造)', () => {
  it('三类证据各带 kind、全量 value 与 origin', () => {
    const evidence = makeRevisionEvidence('fileHash', FILE_HASH, 'hotReloadDefHash 重算');
    expect(evidence).toEqual({ kind: 'fileHash', value: FILE_HASH, origin: 'hotReloadDefHash 重算' });
  });

  it('空值证据不成立(拒绝构造)', () => {
    expect(() => makeRevisionEvidence('engineDigest', '')).toThrow();
    expect(() => makeRevisionEvidence('semanticHash', '  ')).toThrow();
  });
});

describe('revisionEvidenceLabel + formatRevisionEvidence(标签明确)', () => {
  it('三类标签各自点名来源,不共用一个笼统说法', () => {
    expect(revisionEvidenceLabel.fileHash).toContain('本地');
    expect(revisionEvidenceLabel.semanticHash).toContain('语义');
    expect(revisionEvidenceLabel.engineDigest).toContain('运行时');
    expect(new Set(Object.values(revisionEvidenceLabel)).size).toBe(3);
  });

  it('format 输出含来源标签、值截断与 origin', () => {
    const line = formatRevisionEvidence(makeRevisionEvidence('engineDigest', ENGINE_DIGEST, 'HOT-004 applied 回执'));
    expect(line).toContain('engineDigest');
    expect(line).toContain(ENGINE_DIGEST.slice(0, 12));
    expect(line).toContain('HOT-004 applied 回执');
    expect(line).not.toContain(ENGINE_DIGEST.slice(0, 40));
  });
});

describe('compareRevisionEvidence(跨类不冒充)', () => {
  it('同类同值 → match', () => {
    const a = makeRevisionEvidence('fileHash', FILE_HASH, '重算 A');
    const b = makeRevisionEvidence('fileHash', FILE_HASH, '重算 B');
    expect(compareRevisionEvidence(a, b)).toBe('match');
  });

  it('同类异值 → mismatch', () => {
    expect(
      compareRevisionEvidence(
        makeRevisionEvidence('engineDigest', ENGINE_DIGEST),
        makeRevisionEvidence('engineDigest', FILE_HASH)
      )
    ).toBe('mismatch');
  });

  it('跨类同值 → incomparable(本地哈希不冒充运行时证据)', () => {
    const sameValue = 'd'.repeat(64);
    expect(
      compareRevisionEvidence(
        makeRevisionEvidence('fileHash', sameValue),
        makeRevisionEvidence('engineDigest', sameValue)
      )
    ).toBe('incomparable');
    expect(
      compareRevisionEvidence(
        makeRevisionEvidence('semanticHash', sameValue),
        makeRevisionEvidence('fileHash', sameValue)
      )
    ).toBe('incomparable');
  });

  it('跨类异值 → 同样 incomparable(不做跨类大小判定)', () => {
    expect(
      compareRevisionEvidence(
        makeRevisionEvidence('fileHash', FILE_HASH),
        makeRevisionEvidence('semanticHash', SEMANTIC_HASH)
      )
    ).toBe('incomparable');
  });
});

describe('formatRevisionEvidenceReport(证据集合展示)', () => {
  it('逐行带标签只列提供的种类,缺的种类不出现', () => {
    const report = formatRevisionEvidenceReport({
      fileHash: makeRevisionEvidence('fileHash', FILE_HASH, '重算'),
      engineDigest: makeRevisionEvidence('engineDigest', ENGINE_DIGEST, '回执')
    });
    expect(report).toContain('fileHash');
    expect(report).toContain(FILE_HASH.slice(0, 12));
    expect(report).toContain('engineDigest');
    expect(report).toContain(ENGINE_DIGEST.slice(0, 12));
    expect(report).not.toContain('semanticHash');
  });

  it('证据集合全空 → 如实无证据文案(不填空冒充)', () => {
    expect(formatRevisionEvidenceReport({})).toContain('无');
  });

  it('三类齐 → 三行各带标签', () => {
    const report = formatRevisionEvidenceReport({
      fileHash: makeRevisionEvidence('fileHash', FILE_HASH),
      semanticHash: makeRevisionEvidence('semanticHash', SEMANTIC_HASH),
      engineDigest: makeRevisionEvidence('engineDigest', ENGINE_DIGEST)
    });
    for (const kind of ['fileHash', 'semanticHash', 'engineDigest'] as const) {
      expect(report).toContain(revisionEvidenceLabel[kind]);
    }
    expect(report.split('\n').filter(line => line.includes(':')).length).toBe(3);
  });
});
