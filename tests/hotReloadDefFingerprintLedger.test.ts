import { describe, expect, it } from 'vitest';
import {
  DEF_FINGERPRINT_NO_BASELINE_REASON,
  DefFingerprintLedger,
  buildTriCompareInput,
  evaluateDefFingerprint,
  type DefFingerprintSnapshot
} from '../src/backend/hotReloadDefFingerprintLedger';
import { hashDefContent } from '../src/backend/hotReloadDefHash';
import { semanticFingerprintReport } from '../src/backend/hotReloadDefStructure';

// HR-HASH-007/008 接线批纯核钉:def 指纹台账(last/record/clear 生命周期)+
// 三路判定输入组装(同类才可比;applied 维度缺位=unknown 不猜)+首见只存底。
// 快照生产与呈现归装配(defFingerprintInspector),本文件零 vscode。

const snapshotOf = (overrides: Partial<DefFingerprintSnapshot> = {}): DefFingerprintSnapshot => ({
  fileHash: hashDefContent('<root></root>\n').digest,
  byteLength: 14,
  semanticHash: semanticFingerprintReport('<root></root>\n').hash,
  source: 'document',
  at: 1000,
  durationMs: 0,
  ...overrides
});

describe('DefFingerprintLedger 生命周期(HR-HASH-008 存底面)', () => {
  it('首见 last=null(如实缺,不编基线);record 后可取;clear 清册', () => {
    const ledger = new DefFingerprintLedger();
    expect(ledger.last('/ws/entities/avatar.def')).toBeNull();

    const snap = snapshotOf({ fileHash: 'aa' });
    ledger.record('/ws/entities/avatar.def', snap);
    expect(ledger.last('/ws/entities/avatar.def')).toBe(snap);
    // 其他文件不受影响
    expect(ledger.last('/ws/entities/other.def')).toBeNull();

    ledger.clear();
    expect(ledger.last('/ws/entities/avatar.def')).toBeNull();
  });
});

describe('buildTriCompareInput 组装(HR-HASH-008 同类对拍入参面)', () => {
  it('首见(null last):只带当前值对,不带 last 键', () => {
    const current = snapshotOf({ fileHash: 'cc', semanticHash: 'ss' });
    const input = buildTriCompareInput(null, current);
    expect(input.lastLocalFileHash).toBeUndefined();
    expect(input.lastSemanticHash).toBeUndefined();
    expect(input.currentFileHash).toBe('cc');
    expect(input.currentSemanticHash).toBe('ss');
    expect(input.localRecomputedMd5).toBeUndefined();
    expect(input.serverAppliedDigest).toBeUndefined();
    expect(input.engineMd5).toBeUndefined();
  });

  it('有上次:同类对齐射(last/current 各就各位);applied 透传', () => {
    const last = snapshotOf({ fileHash: 'aa', semanticHash: 's1' });
    const current = snapshotOf({ fileHash: 'bb', semanticHash: 's2' });
    const input = buildTriCompareInput(last, current, {
      localRecomputedMd5: 'md5-x',
      serverAppliedDigest: 'md5-x',
      engineMd5: 'd41d8cd98f00b204e9800998ecf8427e'
    });
    expect(input.lastLocalFileHash).toBe('aa');
    expect(input.currentFileHash).toBe('bb');
    expect(input.lastSemanticHash).toBe('s1');
    expect(input.currentSemanticHash).toBe('s2');
    expect(input.localRecomputedMd5).toBe('md5-x');
    expect(input.serverAppliedDigest).toBe('md5-x');
    expect(input.engineMd5).toBe('d41d8cd98f00b204e9800998ecf8427e');
  });
});

describe('evaluateDefFingerprint 三路判定(HR-HASH-008 判定面)', () => {
  it('首见:file/semantic 两路 unknown + applied unknown,原因带首见存底说明', () => {
    const verdict = evaluateDefFingerprint(null, snapshotOf());
    expect(verdict.fileChanged).toBe('unknown');
    expect(verdict.semanticChanged).toBe('unknown');
    expect(verdict.appliedConsistency).toBe('unknown');
    expect(verdict.reasons).toContain(DEF_FINGERPRINT_NO_BASELINE_REASON);
  });

  it('哈希不变+语义不变:两路 unchanged;applied 未给仍 unknown(不冒充)', () => {
    const same = snapshotOf();
    const verdict = evaluateDefFingerprint(same, snapshotOf({ at: 2000 }));
    expect(verdict.fileChanged).toBe('unchanged');
    expect(verdict.semanticChanged).toBe('unchanged');
    expect(verdict.appliedConsistency).toBe('unknown');
    expect(verdict.reasons.some(reason => reason.includes('未协商'))).toBe(true);
  });

  it('字节变语义不变:file=changed + semantic=unchanged(空格改动的如实分路)', () => {
    const last = snapshotOf();
    // 字节不同(加一空格)但结构语义同
    const current = snapshotOf({ fileHash: hashDefContent('<root> </root>\n').digest });
    const verdict = evaluateDefFingerprint(last, current);
    expect(verdict.fileChanged).toBe('changed');
    expect(verdict.semanticChanged).toBe('unchanged');
  });

  it('一侧解析失败(semanticHash=null):semantic=unknown 点名解析失败,不并入文件路', () => {
    const last = snapshotOf({ semanticHash: 's1' });
    const current = snapshotOf({ fileHash: 'bb', semanticHash: null });
    const verdict = evaluateDefFingerprint(last, current);
    expect(verdict.fileChanged).toBe('changed');
    expect(verdict.semanticChanged).toBe('unknown');
    expect(verdict.reasons.some(reason => reason.includes('解析失败'))).toBe(true);
  });

  it('applied 三环齐:consistent/different 真判;缺任一环=unknown+点名', () => {
    const last = snapshotOf();
    const current = snapshotOf({ at: 3000 });
    expect(
      evaluateDefFingerprint(last, current, { localRecomputedMd5: 'm', serverAppliedDigest: 'm', engineMd5: 'd41d8cd98f00b204e9800998ecf8427e' })
        .appliedConsistency
    ).toBe('consistent');
    expect(
      evaluateDefFingerprint(last, current, { localRecomputedMd5: 'm', serverAppliedDigest: 'n', engineMd5: 'd41d8cd98f00b204e9800998ecf8427e' })
        .appliedConsistency
    ).toBe('different');
    // 缺引擎回执
    expect(
      evaluateDefFingerprint(last, current, { localRecomputedMd5: 'm', engineMd5: 'd41d8cd98f00b204e9800998ecf8427e' }).appliedConsistency
    ).toBe('unknown');
    // 缺本地重算
    expect(
      evaluateDefFingerprint(last, current, { serverAppliedDigest: 'm', engineMd5: 'd41d8cd98f00b204e9800998ecf8427e' }).appliedConsistency
    ).toBe('unknown');
  });
});
