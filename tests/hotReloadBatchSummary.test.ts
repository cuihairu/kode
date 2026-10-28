import { describe, expect, it } from 'vitest';
import { batchHotReloadDetail, summarizeHotReloadBatch } from '../src/hotReloadBatchSummary';
import { HotReloadTargetStateStore } from '../src/hotReloadTargetState';

// IDE-HOT-006 按目标聚合部分成功结果:跨目标归并批次状态——两个目标
// 一成一败显示 partial,各目标 reason 可查(逐文件 outcome+detail);目
// 标级归并=名下任一 failed 即 failed,否则任一 sent-unverified 即
// sent-unverified,再否则 accepted,全 applied 才 applied;批次=全部
// failed→all-failed/有败有成→partial/无败→all-succeeded/无记录→
// no-targets。成功=发出面口径,sent-unverified 不冒充 applied(明细如实)。

const FILE_A = '/ws/r/assets/scripts/base/Avatar.py';
const FILE_B = '/ws/r/assets/scripts/base/Monster.py';
const KEY_OK = { rootId: 'r', targetId: 'cellapp#a' };
const KEY_BAD = { rootId: 'r', targetId: 'cellapp#b' };

const storeWith = (
  seed: (store: HotReloadTargetStateStore) => void
): HotReloadTargetStateStore => {
  const store = new HotReloadTargetStateStore({ now: () => 1 });
  seed(store);
  return store;
};

describe('summarizeHotReloadBatch(跨目标聚合)', () => {
  it('两个目标一成一败 → partial,失败原因与成功明细各自可查', () => {
    const store = storeWith(s => {
      s.record(KEY_OK, FILE_A, 'applied', { detail: '回执 applied 且 digest 一致:已应用' });
      s.record(KEY_BAD, FILE_B, 'failed', { detail: 'HTTP 500:internal error' });
    });

    const summary = summarizeHotReloadBatch(store);

    expect(summary.status).toBe('partial');
    expect(summary.targets).toHaveLength(2);
    const bad = summary.targets.find(t => t.key.targetId === 'cellapp#b');
    expect(bad?.outcome).toBe('failed');
    expect(bad?.reason).toContain(FILE_B);
    expect(bad?.reason).toContain('HTTP 500');
    const ok = summary.targets.find(t => t.key.targetId === 'cellapp#a');
    expect(ok?.outcome).toBe('applied');
    expect(ok?.files[0]?.outcome).toBe('applied');
  });

  it('全部目标成功侧 → all-succeeded', () => {
    const store = storeWith(s => {
      s.record(KEY_OK, FILE_A, 'applied');
      s.record(KEY_BAD, FILE_A, 'accepted');
    });
    expect(summarizeHotReloadBatch(store).status).toBe('all-succeeded');
  });

  it('全部目标失败 → all-failed', () => {
    const store = storeWith(s => {
      s.record(KEY_OK, FILE_A, 'failed', { detail: 'HTTP 500' });
      s.record(KEY_BAD, FILE_A, 'failed', { detail: 'connect ECONNREFUSED' });
    });
    const summary = summarizeHotReloadBatch(store);
    expect(summary.status).toBe('all-failed');
    expect(summary.targets.every(t => t.outcome === 'failed')).toBe(true);
  });

  it('无任何记录 → no-targets', () => {
    expect(summarizeHotReloadBatch(storeWith(() => undefined)).status).toBe('no-targets');
  });

  it('同目标多文件一败一成 → 目标级 failed,原因只点名失败文件', () => {
    const store = storeWith(s => {
      s.record(KEY_OK, FILE_A, 'applied');
      s.record(KEY_OK, FILE_B, 'failed', { detail: 'HTTP 502' });
    });
    const summary = summarizeHotReloadBatch(store);
    expect(summary.targets).toHaveLength(1);
    expect(summary.targets[0]?.outcome).toBe('failed');
    expect(summary.targets[0]?.reason).toContain('HTTP 502');
    expect(summary.targets[0]?.files).toHaveLength(2);
  });

  it('sent-unverified 不冒充 applied:目标级如实 sent-unverified,批次无败仍 all-succeeded', () => {
    const store = storeWith(s => {
      s.record(KEY_OK, FILE_A, 'sent-unverified', { detail: 'HTTP 200:应用层未证实' });
    });
    const summary = summarizeHotReloadBatch(store);
    expect(summary.status).toBe('all-succeeded');
    expect(summary.targets[0]?.outcome).toBe('sent-unverified');
    expect(summary.targets[0]?.files[0]?.detail).toContain('未证实');
  });

  it('指定 keys 只聚合点名目标,台账邻居不混入', () => {
    const store = storeWith(s => {
      s.record(KEY_OK, FILE_A, 'applied');
      s.record(KEY_BAD, FILE_A, 'failed');
      s.record({ rootId: 'other', targetId: 'cellapp#c' }, FILE_A, 'failed');
    });
    const summary = summarizeHotReloadBatch(store, { keys: [KEY_OK, KEY_BAD] });
    expect(summary.targets).toHaveLength(2);
    expect(summary.targets.every(t => t.key.rootId === 'r')).toBe(true);
  });

  it('点名目标已 clearTarget(无记录) → 不进聚合', () => {
    const store = storeWith(s => {
      s.record(KEY_OK, FILE_A, 'applied');
      s.record(KEY_BAD, FILE_A, 'failed');
      s.clearTarget(KEY_BAD);
    });
    const summary = summarizeHotReloadBatch(store, { keys: [KEY_OK, KEY_BAD] });
    expect(summary.targets.map(t => t.key.targetId)).toEqual(['cellapp#a']);
    expect(summary.status).toBe('all-succeeded');
  });

  it('目标排序稳定(rootId、targetId 字典序),keyId 可直接展示', () => {
    const store = storeWith(s => {
      s.record(KEY_BAD, FILE_A, 'failed');
      s.record(KEY_OK, FILE_A, 'applied');
    });
    const summary = summarizeHotReloadBatch(store);
    expect(summary.targets.map(t => t.keyId)).toEqual(['r::cellapp#a', 'r::cellapp#b']);
  });
});

describe('batchHotReloadDetail(批次标注文案)', () => {
  it('partial 文案点名失败目标与原因', () => {
    const store = storeWith(s => {
      s.record(KEY_OK, FILE_A, 'applied');
      s.record(KEY_BAD, FILE_B, 'failed', { detail: 'HTTP 500:internal error' });
    });
    const detail = batchHotReloadDetail(summarizeHotReloadBatch(store));
    expect(detail).toContain('部分成功');
    expect(detail).toContain('cellapp#b');
    expect(detail).toContain('HTTP 500');
  });

  it('all-succeeded 不冒充 applied(提示看各目标明细);all-failed/no-targets 如实', () => {
    const okStore = storeWith(s => {
      s.record(KEY_OK, FILE_A, 'sent-unverified');
    });
    const okDetail = batchHotReloadDetail(summarizeHotReloadBatch(okStore));
    expect(okDetail).toContain('all-succeeded'.length > 0 ? '全部目标' : '');
    expect(okDetail).toContain('明细');

    const failStore = storeWith(s => {
      s.record(KEY_BAD, FILE_A, 'failed', { detail: 'connect refused' });
    });
    expect(batchHotReloadDetail(summarizeHotReloadBatch(failStore))).toContain('全部失败');

    expect(batchHotReloadDetail(summarizeHotReloadBatch(storeWith(() => undefined)))).toContain('无投递记录');
  });
});
