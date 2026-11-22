import { describe, expect, it } from 'vitest';
import {
  HotReloadTargetStateStore,
  buildHotReloadTargetKeyId
} from '../src/backend/hotReloadTargetState';

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
      recordedAt: 7,
      attempt: 1
    });
  });

  it('重发=新一次投递:同目标同文件推进代际', () => {
    const store = new HotReloadTargetStateStore({ now: () => 1000 });
    const key = { rootId: 'r', targetId: 't' };
    const file = '/x.py';

    const first = store.record(key, file, 'failed', { detail: '第一次失败' });
    const second = store.record(key, file, 'sent-unverified', {});
    expect(first?.attempt).toBe(1);
    expect(second?.attempt).toBe(2);
    expect(store.get(key, file)?.attempt).toBe(2);
    expect(store.get(key, file)?.outcome).toBe('sent-unverified');
  });

  it('IDE-AUD-005:旧代写回被拒——绑定过时 attempt 不改新记录', () => {
    const store = new HotReloadTargetStateStore({ now: () => 1000 });
    const key = { rootId: 'r', targetId: 't' };
    const file = '/x.py';

    store.record(key, file, 'failed', { detail: '第一次失败' }); // attempt 1
    store.record(key, file, 'failed', { detail: '第二次失败' }); // attempt 2

    // 第一次发送的旧代回执/注解/结算写回:被拒,记录原样不动
    const stale = store.record(key, file, 'applied', { attempt: 1, detail: '旧回执' });
    expect(stale).toBeUndefined();
    expect(store.get(key, file)?.outcome).toBe('failed');
    expect(store.get(key, file)?.attempt).toBe(2);
    expect(store.get(key, file)?.detail).toBe('第二次失败');

    // 当前代写回照常
    const current = store.record(key, file, 'applied', { attempt: 2, detail: '当前回执' });
    expect(current?.outcome).toBe('applied');
    expect(current?.attempt).toBe(2);
    expect(current?.detail).toBe('当前回执');
  });

  it('IDE-AUD-006:发送时点冻结基准落台账,升格/注解改写不动基准', () => {
    const store = new HotReloadTargetStateStore({ now: () => 1000 });
    const key = { rootId: 'r', targetId: 't' };
    const file = '/x.py';
    const frozen = 'a'.repeat(64);

    const record = store.record(key, file, 'sent-unverified', { sentDigest: frozen });
    expect(record?.sentDigest).toBe(frozen);
    // 升格(applied)改写不丢基准
    store.record(key, file, 'applied', { attempt: record?.attempt });
    expect(store.get(key, file)?.outcome).toBe('applied');
    expect(store.get(key, file)?.sentDigest).toBe(frozen);
    // 注解(带 attempt)改写不丢基准
    store.record(key, file, 'applied', { attempt: record?.attempt, detail: '补充' });
    expect(store.get(key, file)?.sentDigest).toBe(frozen);
    expect(store.get(key, file)?.detail).toBe('补充');
    // 新发送(无 attempt)无基准=新代不带旧基准
    const next = store.record(key, file, 'failed', { detail: '新失败' });
    expect(next?.sentDigest).toBeUndefined();
    expect(store.get(key, file)?.attempt).toBe((record?.attempt ?? 0) + 1);
  });

  it('KODE-AUD-003:回执路径写回携带 sentDigest 落台账(代际守卫下可审计基准)', () => {
    const store = new HotReloadTargetStateStore({ now: () => 1000 });
    const key = { rootId: 'r', targetId: 't' };
    const file = '/x.py';
    const frozen = 'b'.repeat(64);

    // 与 hotReload.ts:348 同径:新发送(无 attempt)不携基准创建
    const record = store.record(key, file, 'sent-unverified', {});
    expect(record?.sentDigest).toBeUndefined();
    const attempt = record?.attempt;

    // 与 hotReload.ts:377 同径:发送时点冻结基准经带 attempt 写回补进台账
    // (修前该分支只补 detail,sentDigest 被静默丢弃,记录恒无基准)
    store.record(key, file, 'sent-unverified', { sentDigest: frozen, attempt });
    expect(store.get(key, file)?.sentDigest).toBe(frozen);
    expect(store.get(key, file)?.attempt).toBe(attempt);

    // 代际守卫仍有效:旧代写回携基准被拒,不污染新代记录
    const next = store.record(key, file, 'failed', { detail: '新失败' });
    const stale = store.record(key, file, 'sent-unverified', { sentDigest: 'c'.repeat(64), attempt });
    expect(stale).toBeUndefined();
    expect(store.get(key, file)?.attempt).toBe((attempt ?? 0) + 1);
    expect(store.get(key, file)?.sentDigest).toBeUndefined();
    void next;
  });

  it('IDE-AUD-005:无当前记录时带 attempt 写回被拒(记录已清),不凭空造记录', () => {
    const store = new HotReloadTargetStateStore({ now: () => 1000 });
    const key = { rootId: 'r', targetId: 't' };
    const file = '/x.py';

    expect(store.record(key, file, 'applied', { attempt: 3 })).toBeUndefined();
    expect(store.get(key, file)).toBeUndefined();
  });

  it('IDE-HOT-100:onRecorded 在每次落账/升格后触发,被拒旧代写回不触发', () => {
    let fired = 0;
    const store = new HotReloadTargetStateStore({ now: () => 1000, onRecorded: () => { fired += 1; } });
    const key = { rootId: 'r', targetId: 't' };
    const file = '/x.py';

    // 新发送落账触发一次
    const first = store.record(key, file, 'sent-unverified', { sentDigest: 'a'.repeat(64) });
    expect(fired).toBe(1);
    // 升格(带 attempt 写回)触发一次
    store.record(key, file, 'applied', { attempt: first?.attempt });
    expect(fired).toBe(2);
    // 被拒旧代写回(attempt 不匹配)不触发(记录原样不动)
    store.record(key, file, 'failed', { attempt: (first?.attempt ?? 0) + 99 });
    expect(fired).toBe(2);
    // 新一次发送(换代)再触发
    store.record(key, file, 'failed', { detail: '失败' });
    expect(fired).toBe(3);
  });
});

describe('HR-STATE-007 发送耗时(HR-STATE-007 可检索历史「duration」)', () => {
  const key = { rootId: 'r', targetId: 't' };
  const file = '/x.py';

  it('新发送带 durationMs 落账;回执写回同模式覆写,未提供保留旧值', () => {
    const store = new HotReloadTargetStateStore({ now: () => 1000 });
    const first = store.record(key, file, 'sent-unverified', { durationMs: 12 });
    expect(first?.durationMs).toBe(12);
    // 回执写回:提供了才覆写(真实耗时来源),旧值不被抹掉
    store.record(key, file, 'applied', { attempt: first?.attempt, durationMs: 45 });
    expect(store.get(key, file)?.durationMs).toBe(45);
    store.record(key, file, 'applied', { attempt: first?.attempt });
    expect(store.get(key, file)?.durationMs).toBe(45);
  });

  it('未提供 durationMs 如实缺省(发送前基准冻结路径不冒充 0)', () => {
    const store = new HotReloadTargetStateStore({ now: () => 1000 });
    const record = store.record(key, file, 'sent-unverified', { sentDigest: 'a'.repeat(64) });
    expect(record?.durationMs).toBeUndefined();
    expect('durationMs' in (record ?? {})).toBe(false);
  });
});

describe('HR-MOD-014(双名同存:投递记录与版本事件日志)', () => {
  const key = { rootId: 'r', targetId: 't' };
  const file = '/ws/assets/scripts/entities/fight/FightAI.py';
  const NAMES = { fullModule: 'entities.fight.FightAI', requestModule: 'fight.FightAI' };

  const deliveryEvents = (store: HotReloadTargetStateStore): Record<string, unknown>[] =>
    store.fileVersions().flatMap(state => state.events.filter(e => e.kind === 'delivery'));

  it('显式给定双名:记录与版本事件日志都存全名/请求名', () => {
    const store = new HotReloadTargetStateStore({ now: () => 1000 });
    const record = store.record(key, file, 'sent-unverified', {
      fullModule: NAMES.fullModule,
      requestModule: NAMES.requestModule
    });
    expect(record?.fullModule).toBe(NAMES.fullModule);
    expect(record?.requestModule).toBe(NAMES.requestModule);
    const events = deliveryEvents(store);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ fullModule: NAMES.fullModule, requestModule: NAMES.requestModule });
  });

  it('注入解析口未显式给:自动按 file 盖双名(台账与事件同源)', () => {
    const store = new HotReloadTargetStateStore({
      now: () => 1000,
      resolveModuleNames: f => (f === file ? NAMES : undefined)
    });
    store.record(key, file, 'sent-unverified');
    expect(store.get(key, file)).toMatchObject(NAMES);
    expect(deliveryEvents(store)[0]).toMatchObject(NAMES);
  });

  it('解析口不可解/未注入:如实不写双名,不回落 stem 冒充', () => {
    const unresolved = new HotReloadTargetStateStore({
      now: () => 1000,
      resolveModuleNames: () => undefined
    });
    unresolved.record(key, file, 'sent-unverified');
    expect(unresolved.get(key, file)?.fullModule).toBeUndefined();
    expect(unresolved.get(key, file)?.requestModule).toBeUndefined();

    const noResolver = new HotReloadTargetStateStore({ now: () => 1000 });
    noResolver.record(key, file, 'sent-unverified');
    expect(noResolver.get(key, file)?.fullModule).toBeUndefined();
    expect(deliveryEvents(noResolver)[0]).not.toHaveProperty('fullModule');
  });

  it('回执写回保留首次发送的双名(不动);显式再给则覆写', () => {
    const store = new HotReloadTargetStateStore({ now: () => 1000 });
    const first = store.record(key, file, 'sent-unverified', NAMES);
    const applied = store.record(key, file, 'applied', { attempt: first?.attempt });
    expect(applied?.fullModule).toBe(NAMES.fullModule);
    expect(applied?.requestModule).toBe(NAMES.requestModule);
    const events = deliveryEvents(store);
    // 发送+回执各一条,双名都在
    expect(events).toHaveLength(2);
    expect(events.every(e => e.fullModule === NAMES.fullModule && e.requestModule === NAMES.requestModule)).toBe(true);
  });
});
