import { describe, expect, it } from 'vitest';
import {
  DriftEvidenceStore,
  classifyDriftEvidence,
  type DriftEvidenceRecord
} from '../src/databaseDriftEvidence';

// IDE-DB-006 按引擎版本保存 drift 联验证据:记录把「实际查询面」(真实
// MySQL 查询所得)与「模拟 schema 面」(虚拟表结构推导)分开存,结论分
// 类不冒充——引擎版本 unknown 时只给 unknown-version(不宣称兼容);
// 没有实际查询(queried=null)只给 unverified;实测无漂移才 compatible-
// verified;有漂移如实 drift-found。按版本保存,同版本重录覆盖为最新,
// 持久化经注入 load/save。

const record = (overrides: Partial<DriftEvidenceRecord> = {}): DriftEvidenceRecord => ({
  engineVersion: 'v2.5.10',
  queried: { summary: 'SHOW COLUMNS 所得 3 表真实结构' },
  simulated: { summary: 'def 推导虚拟表结构 3 表' },
  driftSummary: '',
  recordedAt: 1000,
  ...overrides
});

describe('classifyDriftEvidence(结论不冒充)', () => {
  it('实测无漂移 → compatible-verified', () => {
    expect(classifyDriftEvidence(record())).toEqual(
      expect.objectContaining({ verdict: 'compatible-verified' })
    );
  });

  it('实测发现漂移 → drift-found 带摘要', () => {
    const verdict = classifyDriftEvidence(record({ driftSummary: 'tbl_Account 缺 sm_hp 列' }));
    expect(verdict.verdict).toBe('drift-found');
    expect(verdict.detail).toContain('sm_hp');
  });

  it('无实际查询(纯模拟面) → unverified,不冒充实测', () => {
    const verdict = classifyDriftEvidence(record({ queried: null }));
    expect(verdict.verdict).toBe('unverified');
    expect(verdict.detail).toContain('模拟');
  });

  it('引擎版本 unknown → unknown-version,不宣称兼容', () => {
    const verdict = classifyDriftEvidence(record({ engineVersion: 'unknown' }));
    expect(verdict.verdict).toBe('unknown-version');
    expect(verdict.detail).toContain('不宣称兼容');
  });

  it('unknown 版本即便实测无漂移也不给 verified', () => {
    const verdict = classifyDriftEvidence(
      record({ engineVersion: 'unknown', queried: { summary: '实测无漂移' }, driftSummary: '' })
    );
    expect(verdict.verdict).toBe('unknown-version');
  });
});

describe('DriftEvidenceStore(按版本保存)', () => {
  it('记录两面分开可查:queried 与 simulated 各自摘要', () => {
    const store = new DriftEvidenceStore({ now: () => 1 });
    store.save(record({ queried: { summary: '真实查询 A' }, simulated: { summary: '模拟 B' } }));
    const stored = store.latest();
    expect(stored?.queried?.summary).toBe('真实查询 A');
    expect(stored?.simulated.summary).toBe('模拟 B');
  });

  it('多版本共存,latest 取最新 recordedAt', () => {
    const store = new DriftEvidenceStore({ now: () => 1 });
    store.save(record({ engineVersion: 'v2.5.10', recordedAt: 1000 }));
    store.save(record({ engineVersion: 'v0.9.0', recordedAt: 2000 }));
    store.save(record({ engineVersion: 'v2.5.10', recordedAt: 3000 }));

    expect(store.byVersion().map(entry => entry.engineVersion).sort()).toEqual(['v0.9.0', 'v2.5.10']);
    expect(store.latest()?.recordedAt).toBe(3000);
  });

  it('同版本重录覆盖为最新一次', () => {
    const store = new DriftEvidenceStore({ now: () => 1 });
    store.save(record({ driftSummary: '旧漂移', recordedAt: 1000 }));
    store.save(record({ driftSummary: '', recordedAt: 2000 }));

    expect(store.byVersion()).toHaveLength(1);
    expect(store.latest()?.driftSummary).toBe('');
  });

  it('持久化:save 落盘,新 store 同 load 读回', () => {
    let stored: unknown;
    const deps = {
      now: () => 1,
      load: () => stored,
      save: (data: unknown) => { stored = data; }
    };
    const first = new DriftEvidenceStore(deps);
    first.save(record({ recordedAt: 1234 }));

    const reopened = new DriftEvidenceStore(deps);
    expect(reopened.latest()?.recordedAt).toBe(1234);
    expect(reopened.byVersion().map(entry => entry.engineVersion)).toEqual(['v2.5.10']);
  });

  it('损坏载荷(非数组)静默空,不炸', () => {
    const store = new DriftEvidenceStore({ now: () => 1, load: () => 42 });
    expect(store.latest()).toBeUndefined();
    expect(store.byVersion()).toEqual([]);
  });
});
