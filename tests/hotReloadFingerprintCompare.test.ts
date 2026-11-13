import { describe, expect, it } from 'vitest';
import {
  compareFingerprints,
  resolveFingerprintProfile
} from '../src/backend/hotReloadFingerprintCompare';

// HR-PR-07(HR-HASH-006/008):指纹三路比对纯核测试。
// 三路独立(file/semantic/applied),跨类永不互比(客户端 sha256 ≠ 引擎
// MD5),缺证据如实 unknown 并点名原因,不猜。

// 协商输入=引擎回执的真实 32 位摘要形(negotiateEngineDigest 以长度 32 判定)
const ENGINE_MD5 = 'd41d8cd98f00b204e9800998ecf8427e';

describe('HR-HASH-008 fileChanged 路(fileHash 对)', () => {
  it('两侧都有值:相等=unchanged,不等=changed', () => {
    expect(
      compareFingerprints({ lastLocalFileHash: 'aaa', currentFileHash: 'aaa' }).fileChanged
    ).toBe('unchanged');
    expect(
      compareFingerprints({ lastLocalFileHash: 'aaa', currentFileHash: 'bbb' }).fileChanged
    ).toBe('changed');
  });

  it('任一侧缺失=unknown 且原因点名(不猜)', () => {
    const verdict = compareFingerprints({ currentFileHash: 'aaa' });
    expect(verdict.fileChanged).toBe('unknown');
    expect(verdict.reasons.some(r => r.includes('fileHash 缺失'))).toBe(true);
    expect(compareFingerprints({}).fileChanged).toBe('unknown');
  });

  it('fileChanged 与 semanticChanged 各自独立判定不并路', () => {
    const verdict = compareFingerprints({
      lastLocalFileHash: 'aaa',
      currentFileHash: 'aaa',
      lastSemanticHash: 's1',
      currentSemanticHash: 's2'
    });
    expect(verdict.fileChanged).toBe('unchanged');
    expect(verdict.semanticChanged).toBe('changed');
  });
});

describe('HR-HASH-008 semanticChanged 路(语义指纹对)', () => {
  it('两侧都有值:相等/不等如实', () => {
    expect(
      compareFingerprints({ lastSemanticHash: 's1', currentSemanticHash: 's1' }).semanticChanged
    ).toBe('unchanged');
    expect(
      compareFingerprints({ lastSemanticHash: 's1', currentSemanticHash: 's2' }).semanticChanged
    ).toBe('changed');
  });

  it('任一侧 null(解析失败)或缺失=unknown+原因', () => {
    const nullSide = compareFingerprints({ lastSemanticHash: null, currentSemanticHash: 's1' });
    expect(nullSide.semanticChanged).toBe('unknown');
    expect(nullSide.reasons.some(r => r.includes('解析失败'))).toBe(true);
    const missing = compareFingerprints({ lastSemanticHash: 's1' });
    expect(missing.semanticChanged).toBe('unknown');
    expect(missing.reasons.some(r => r.includes('语义指纹缺失'))).toBe(true);
  });
});

describe('HR-HASH-008 appliedConsistency 路(引擎 Digest 同类对拍)', () => {
  const negotiated = { engineMd5: ENGINE_MD5 };

  it('协商成功+两侧齐:相等=consistent,不等=different', () => {
    expect(
      compareFingerprints({ ...negotiated, localRecomputedMd5: 'm1', serverAppliedDigest: 'm1' })
        .appliedConsistency
    ).toBe('consistent');
    expect(
      compareFingerprints({ ...negotiated, localRecomputedMd5: 'm1', serverAppliedDigest: 'm2' })
        .appliedConsistency
    ).toBe('different');
  });

  it('算法未协商=unknown(跨类不比,不猜引擎算法)', () => {
    const verdict = compareFingerprints({ localRecomputedMd5: 'm1', serverAppliedDigest: 'm1' });
    expect(verdict.appliedConsistency).toBe('unknown');
    expect(verdict.reasons.some(r => r.includes('未协商'))).toBe(true);
    expect(verdict.reasons.some(r => r.includes('not available'))).toBe(true);
  });

  it('协商成功但引擎未报告 Digest=unknown;本地未按同算法重算=unknown', () => {
    const noServer = compareFingerprints({ ...negotiated, localRecomputedMd5: 'm1' });
    expect(noServer.appliedConsistency).toBe('unknown');
    expect(noServer.reasons.some(r => r.includes('未报告'))).toBe(true);

    const noLocal = compareFingerprints({ ...negotiated, serverAppliedDigest: 'm1' });
    expect(noLocal.appliedConsistency).toBe('unknown');
    expect(noLocal.reasons.some(r => r.includes('跨类不比'))).toBe(true);
  });

  it('全路齐的完整判定:三路独立给出,unknown 原因不串路', () => {
    const verdict = compareFingerprints({
      lastLocalFileHash: 'a1',
      currentFileHash: 'a2',
      lastSemanticHash: 's1',
      currentSemanticHash: 's1',
      ...negotiated,
      localRecomputedMd5: 'm1',
      serverAppliedDigest: 'm1'
    });
    expect(verdict.fileChanged).toBe('changed');
    expect(verdict.semanticChanged).toBe('unchanged');
    expect(verdict.appliedConsistency).toBe('consistent');
    expect(verdict.reasons).toHaveLength(0);
  });
});

describe('HR-HASH-006 FingerprintProvider(profile)', () => {
  it('协商出算法:label=算法名', () => {
    expect(resolveFingerprintProfile(ENGINE_MD5)).toEqual({
      digestAlgorithm: 'md5',
      negotiated: true,
      label: 'md5'
    });
  });

  it('协商不出(缺省/未知):label=not available,不猜算法', () => {
    expect(resolveFingerprintProfile()).toEqual({
      digestAlgorithm: 'unknown',
      negotiated: false,
      label: 'not available'
    });
    expect(resolveFingerprintProfile(undefined).label).toBe('not available');
  });
});
