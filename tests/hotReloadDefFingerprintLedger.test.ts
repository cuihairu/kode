import { describe, expect, it } from 'vitest';
import {
  DEF_FINGERPRINT_LEDGER_STORAGE_KEY,
  DEF_FINGERPRINT_NO_BASELINE_REASON,
  DefFingerprintLedger,
  buildTriCompareInput,
  evaluateDefFingerprint,
  type DefFingerprintSnapshot
} from '../src/backend/hotReloadDefFingerprintLedger';
import { hashDefContent } from '../src/backend/hotReloadDefHash';
import { DEF_FINGERPRINT_SPEC_VERSION, semanticFingerprintReport } from '../src/backend/hotReloadDefStructure';

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

describe('键形态契约(RUST-003 收口:多 root 同相对路径不串册)', () => {
  it('两 root 同名相对路径(绝对键)=台账互不相串;键区分度在装配(契约见模块头注)', () => {
    const ledger = new DefFingerprintLedger();
    const rootA = snapshotOf({ fileHash: 'hash-root-a' });
    const rootB = snapshotOf({ fileHash: 'hash-root-b' });
    // 同一相对路径 scripts/entities/avatar.def,分属两个 root:绝对键必不同。
    ledger.record('/wsA/scripts/entities/avatar.def', rootA);
    ledger.record('/wsB/scripts/entities/avatar.def', rootB);
    expect(ledger.last('/wsA/scripts/entities/avatar.def')).toBe(rootA);
    expect(ledger.last('/wsB/scripts/entities/avatar.def')).toBe(rootB);
    // 相对路径键若被装配误用,台账无法拯救——契约上这类键禁止入册:
    // 两个 root 的相对键会互相覆盖(此处只钉该行为可见,防装配误用后无痕)。
    ledger.record('scripts/entities/avatar.def', snapshotOf({ fileHash: 'hash-relative' }));
    expect(ledger.last('scripts/entities/avatar.def')?.fileHash).toBe('hash-relative');
  });

  it('同键重记录=时间性覆盖(上次 vs 当前判变更,不判版本身份)', () => {
    const ledger = new DefFingerprintLedger();
    ledger.record('/ws/entities/avatar.def', snapshotOf({ fileHash: 'v1' }));
    ledger.record('/ws/entities/avatar.def', snapshotOf({ fileHash: 'v2' }));
    expect(ledger.last('/ws/entities/avatar.def')?.fileHash).toBe('v2');
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

describe('RUST-401 持久化(HR-HASH-014:必要元数据存底/版本键失效/不缓存源码)', () => {
  /** 内存 Memento 假体:记录每次 update,可回读整份存底载荷 */
  const makeStorage = (initial?: unknown) => {
    const map = new Map<string, unknown>();
    const updates: Array<{ key: string; value: unknown }> = [];
    if (initial !== undefined) {
      map.set(DEF_FINGERPRINT_LEDGER_STORAGE_KEY, initial);
    }
    return {
      get: <T>(key: string): T | undefined => map.get(key) as T | undefined,
      update: (key: string, value: unknown): unknown => {
        updates.push({ key, value });
        map.set(key, value);
        return undefined;
      },
      updates,
      stored: (): unknown => map.get(DEF_FINGERPRINT_LEDGER_STORAGE_KEY)
    };
  };

  it('record → 同存底新台账恢复:last 命中(重启恢复,不重算)', () => {
    const storage = makeStorage();
    const first = new DefFingerprintLedger(storage);
    const snap = snapshotOf({ fileHash: 'persist-hash', semanticHash: 'persist-sem' });
    first.record('/ws/entities/avatar.def', snap);

    const revived = new DefFingerprintLedger(storage);
    expect(revived.last('/ws/entities/avatar.def')).toEqual(snap);
    // 未记录的文件不凭空出现
    expect(revived.last('/ws/entities/other.def')).toBeNull();
  });

  it('版本键不匹配:旧存底整体丢弃(启动即 last=null,下次记录重算)', () => {
    // 模拟旧算法/旧规范的存底(版本键不同)
    const stale = {
      specVersion: 'def-structural-fp/0',
      entries: [{ file: '/ws/entities/avatar.def', snapshot: snapshotOf({ fileHash: 'stale' }) }]
    };
    const storage = makeStorage(stale);
    const ledger = new DefFingerprintLedger(storage);
    expect(ledger.last('/ws/entities/avatar.def')).toBeNull();
  });

  it('同版本键但载荷畸形(null/非对象/非数组 entries):静默丢弃不崩', () => {
    for (const bad of [null, 42, 'x', {}, { specVersion: DEF_FINGERPRINT_SPEC_VERSION, entries: 'nope' }]) {
      const storage = makeStorage(bad);
      const ledger = new DefFingerprintLedger(storage);
      expect(ledger.last('/ws/entities/avatar.def')).toBeNull();
    }
  });

  it('同版本键但表项畸形(非对象项/file 非字符串/snapshot.fileHash 非字符串):逐项静默跳过', () => {
    const badEntries = {
      specVersion: DEF_FINGERPRINT_SPEC_VERSION,
      entries: [
        42,
        { file: 42, snapshot: snapshotOf() },
        { file: '/ws/entities/avatar.def', snapshot: { fileHash: 42 } },
        { file: null, snapshot: null }
      ]
    };
    const ledger = new DefFingerprintLedger(makeStorage(badEntries));
    expect(ledger.last('/ws/entities/avatar.def')).toBeNull();
    // 合法项仍入册(坏项不污染好项)
    const mixed = {
      specVersion: DEF_FINGERPRINT_SPEC_VERSION,
      entries: [{ file: '/ws/entities/ok.def', snapshot: snapshotOf({ fileHash: 'good' }) }]
    };
    const revived = new DefFingerprintLedger(makeStorage(mixed));
    expect(revived.last('/ws/entities/ok.def')?.fileHash).toBe('good');
  });

  it('只持久化必要元数据,绝不缓存源码内容副本(快照无 content 字段)', () => {
    const storage = makeStorage();
    const ledger = new DefFingerprintLedger(storage);
    const snap = snapshotOf({ fileHash: 'abc', semanticHash: 'def', byteLength: 14 });
    ledger.record('/ws/entities/avatar.def', snap);

    expect(storage.updates).toHaveLength(1);
    const payload = storage.stored() as { specVersion: string; entries: Array<{ file: string; snapshot: Record<string, unknown> }> };
    expect(payload.specVersion).toBe(DEF_FINGERPRINT_SPEC_VERSION);
    expect(payload.entries).toHaveLength(1);
    expect(payload.entries[0].file).toBe('/ws/entities/avatar.def');
    // 快照只含元数据字段,无 content/源码文本键
    expect(Object.keys(payload.entries[0].snapshot).sort()).toEqual(
      ['at', 'byteLength', 'durationMs', 'fileHash', 'semanticHash', 'source']
    );
    // 序列化后不含源码内容(源码不在任何值里)
    expect(JSON.stringify(payload)).not.toContain('<root>');
  });

  it('clear → 同存底新台账恢复为空(清空语义落盘,不复活旧表项)', () => {
    const storage = makeStorage();
    const first = new DefFingerprintLedger(storage);
    first.record('/ws/entities/avatar.def', snapshotOf({ fileHash: 'x' }));
    first.clear();

    const revived = new DefFingerprintLedger(storage);
    expect(revived.last('/ws/entities/avatar.def')).toBeNull();
    // 清空后存底载荷 entries 为空数组(非缺失,显式清空)
    const payload = storage.stored() as { entries: unknown[] };
    expect(payload.entries).toEqual([]);
  });

  it('storage.update 同步抛错:record 不抛,主路径判定不受阻(静默吞)', () => {
    const storage = {
      get: <T>(_key: string): T | undefined => undefined,
      update: (): unknown => {
        throw new Error('memento write failed');
      }
    };
    const ledger = new DefFingerprintLedger(storage);
    const snap = snapshotOf({ fileHash: 'ok' });
    expect(() => ledger.record('/ws/entities/avatar.def', snap)).not.toThrow();
    expect(ledger.last('/ws/entities/avatar.def')).toBe(snap);
  });

  it('storage.update 异步拒绝:record 不抛,静默吞(不冒 unhandled)', async () => {
    const storage = {
      get: <T>(_key: string): T | undefined => undefined,
      update: (): Promise<unknown> => Promise.reject(new Error('async write failed'))
    };
    const ledger = new DefFingerprintLedger(storage);
    const snap = snapshotOf({ fileHash: 'ok' });
    expect(() => ledger.record('/ws/entities/avatar.def', snap)).not.toThrow();
    // 排干微任务,确认无未处理拒绝
    await new Promise(resolve => setImmediate(resolve));
    expect(ledger.last('/ws/entities/avatar.def')).toBe(snap);
  });

  it('无 storage:纯会话内存(既有行为不回归,record 不落盘)', () => {
    const ledger = new DefFingerprintLedger();
    ledger.record('/ws/entities/avatar.def', snapshotOf({ fileHash: 'mem' }));
    expect(ledger.last('/ws/entities/avatar.def')?.fileHash).toBe('mem');
    ledger.clear();
    expect(ledger.last('/ws/entities/avatar.def')).toBeNull();
  });
});
