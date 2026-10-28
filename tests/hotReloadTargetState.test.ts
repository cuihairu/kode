import { describe, expect, it } from 'vitest';
import {
  HotReloadTargetStateStore,
  buildHotReloadTargetKeyId
} from '../src/hotReloadTargetState';

// IDE-HOT-001 按 rootId 与 targetId 隔离热更新状态:投递结果台账按
// (文件归属扫描根 rootId × 服务实例 targetId)双维隔离——同文件发给
// 不同实例各自落各自的记录,后一个目标的失败/成功不覆盖、也不复用
// 前一个目标的绿色状态;查别的目标拿不到邻居的记录。

describe('buildHotReloadTargetKeyId(键形态)', () => {
  it('rootId 与 targetId 组成稳定键', () => {
    expect(buildHotReloadTargetKeyId({ rootId: 'root-a', targetId: 'cellapp#b' })).toBe(
      'root-a::cellapp#b'
    );
  });
});

describe('HotReloadTargetStateStore(双维隔离台账)', () => {
  it('同文件发给不同实例分别保存结果,互不覆盖', () => {
    const store = new HotReloadTargetStateStore({ now: () => 1000 });
    const file = '/ws/root-a/assets/scripts/base/Avatar.py';

    store.record({ rootId: 'root-a', targetId: 'cellapp#a' }, file, 'sent-unverified');
    store.record({ rootId: 'root-a', targetId: 'cellapp#b' }, file, 'failed', { detail: 'telnet 拒连' });

    expect(store.get({ rootId: 'root-a', targetId: 'cellapp#a' }, file)?.outcome).toBe('sent-unverified');
    expect(store.get({ rootId: 'root-a', targetId: 'cellapp#b' }, file)?.outcome).toBe('failed');
    expect(store.get({ rootId: 'root-a', targetId: 'cellapp#b' }, file)?.detail).toBe('telnet 拒连');
  });

  it('没发过的目标拿不到邻居的绿色状态(不复用)', () => {
    const store = new HotReloadTargetStateStore({ now: () => 1000 });
    const file = '/ws/root-a/assets/scripts/base/Avatar.py';

    store.record({ rootId: 'root-a', targetId: 'cellapp#a' }, file, 'sent-unverified');

    expect(store.get({ rootId: 'root-a', targetId: 'cellapp#b' }, file)).toBeUndefined();
    // b 失败后,a 的绿色状态原样不动
    store.record({ rootId: 'root-a', targetId: 'cellapp#b' }, file, 'failed');
    expect(store.get({ rootId: 'root-a', targetId: 'cellapp#a' }, file)?.outcome).toBe('sent-unverified');
  });

  it('同 targetId 不同 rootId 也隔离(root 维度)', () => {
    const store = new HotReloadTargetStateStore({ now: () => 1000 });
    const fileA = '/ws/root-a/assets/scripts/base/Avatar.py';
    const fileB = '/ws/root-b/assets/scripts/base/Avatar.py';

    store.record({ rootId: 'root-a', targetId: 'baseapp' }, fileA, 'sent-unverified');

    expect(store.get({ rootId: 'root-b', targetId: 'baseapp' }, fileB)).toBeUndefined();
    expect(store.get({ rootId: 'root-b', targetId: 'baseapp' }, fileA)).toBeUndefined();
  });

  it('同目标同文件重发=覆盖为最新一次', () => {
    const store = new HotReloadTargetStateStore({ now: () => 1000 });
    const key = { rootId: 'root-a', targetId: 'baseapp' };
    const file = '/ws/root-a/assets/scripts/base/Avatar.py';

    store.record(key, file, 'failed', { detail: '第一次拒连' });
    store.record(key, file, 'sent-unverified', { now: 2000 });

    const record = store.get(key, file);
    expect(record?.outcome).toBe('sent-unverified');
    expect(record?.detail).toBeUndefined();
    expect(record?.recordedAt).toBe(2000);
  });

  it('recordedAt 走注入时钟,缺省快照带时间', () => {
    const store = new HotReloadTargetStateStore({ now: () => 4242 });
    store.record({ rootId: 'r', targetId: 't' }, '/r/x.py', 'sent-unverified');
    expect(store.get({ rootId: 'r', targetId: 't' }, '/r/x.py')?.recordedAt).toBe(4242);
  });

  it('targets 列出有记录的目标,files 列该目标的文件', () => {
    const store = new HotReloadTargetStateStore({ now: () => 1000 });
    store.record({ rootId: 'root-a', targetId: 'baseapp' }, '/a1.py', 'sent-unverified');
    store.record({ rootId: 'root-a', targetId: 'baseapp' }, '/a2.py', 'failed');
    store.record({ rootId: 'root-b', targetId: 'cellapp#a' }, '/b1.py', 'sent-unverified');

    expect(store.targetsWithRecords()).toEqual([
      { rootId: 'root-a', targetId: 'baseapp' },
      { rootId: 'root-b', targetId: 'cellapp#a' }
    ]);
    expect(store.files({ rootId: 'root-a', targetId: 'baseapp' })).toEqual(['/a1.py', '/a2.py']);
  });

  it('clearTarget 只清该目标,别的目标原样', () => {
    const store = new HotReloadTargetStateStore({ now: () => 1000 });
    const file = '/x.py';
    store.record({ rootId: 'r', targetId: 'a' }, file, 'sent-unverified');
    store.record({ rootId: 'r', targetId: 'b' }, file, 'sent-unverified');

    store.clearTarget({ rootId: 'r', targetId: 'a' });

    expect(store.get({ rootId: 'r', targetId: 'a' }, file)).toBeUndefined();
    expect(store.get({ rootId: 'r', targetId: 'b' }, file)?.outcome).toBe('sent-unverified');
    expect(store.targetsWithRecords()).toEqual([{ rootId: 'r', targetId: 'b' }]);
  });

  it('record 返回刚写入的记录(不用回查)', () => {
    const store = new HotReloadTargetStateStore({ now: () => 7 });
    const record = store.record({ rootId: 'r', targetId: 't' }, '/x.py', 'failed', { detail: 'boom' });
    expect(record).toEqual({
      rootId: 'r',
      targetId: 't',
      file: '/x.py',
      outcome: 'failed',
      detail: 'boom',
      recordedAt: 7
    });
  });
});
