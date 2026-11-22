import { describe, expect, it } from 'vitest';
import {
  buildHistoryEntryLabel,
  buildHistoryEntryTooltipLines,
  coalesceHistoryUpdates,
  computeVirtualScrollWindow,
  HotReloadHistoryCore,
  HOT_RELOAD_HISTORY_EXPORT_FIELDS,
  projectHotReloadHistoryExportRow,
  serializeHotReloadHistoryJson,
  type HotReloadHistoryInput
} from '../src/backend/hotReloadHistoryCore';

// HR-PR-06(HR-UI-002/004/006/007/010/014 + HR-MOD-014):热更历史库纯核
// 测试。历史行身份=requestId(幂等替换);同文件不同 target 是两行;
// 状态迁移单向 sent-unverified→applied/failed;过滤/分组/分页/合并全纯。

const makeEntry = (overrides: Partial<HotReloadHistoryInput> = {}): HotReloadHistoryInput => ({
  requestId: overrides.requestId ?? 'req-1',
  fullModule: overrides.fullModule ?? 'entities.fight.FightAI',
  requestModule: overrides.requestModule ?? 'fight.FightAI',
  fileUri: overrides.fileUri ?? '/ws/scripts/fight/FightAI.py',
  targetId: overrides.targetId ?? 'cellapp-1',
  time: overrides.time ?? 1000,
  status: overrides.status ?? 'sent-unverified',
  ...(overrides.errorSummary !== undefined ? { errorSummary: overrides.errorSummary } : {}),
  // HR-STATE-007 九要素其余四要素:缺省如实不给(不伪造占位)
  ...(overrides.trigger !== undefined ? { trigger: overrides.trigger } : {}),
  ...(overrides.durationMs !== undefined ? { durationMs: overrides.durationMs } : {}),
  ...(overrides.errorCategory !== undefined ? { errorCategory: overrides.errorCategory } : {}),
  ...(overrides.hash !== undefined ? { hash: overrides.hash } : {})
});

const makeCore = (capacity?: number): HotReloadHistoryCore =>
  new HotReloadHistoryCore(capacity !== undefined ? { capacity } : {});

const seed = (core: HotReloadHistoryCore, entries: HotReloadHistoryInput[]): void => {
  for (const entry of entries) {
    core.record(entry);
  }
};

describe('记录与顺序(HR-UI-002 最近更新)', () => {
  it('插入序=新旧序;newestFirst 最新在前', () => {
    const core = makeCore();
    seed(core, [
      makeEntry({ requestId: 'r1', time: 1000 }),
      makeEntry({ requestId: 'r2', time: 2000 }),
      makeEntry({ requestId: 'r3', time: 3000 })
    ]);
    expect(core.size()).toBe(3);
    expect(core.entries().map(e => e.requestId)).toEqual(['r1', 'r2', 'r3']);
    expect(core.newestFirst().map(e => e.requestId)).toEqual(['r3', 'r2', 'r1']);
  });

  it('同 requestId 重记录=原位幂等替换,不重复成行顺序不动', () => {
    const core = makeCore();
    seed(core, [makeEntry({ requestId: 'r1' }), makeEntry({ requestId: 'r2' })]);
    core.record(makeEntry({ requestId: 'r1', status: 'applied', time: 5000 }));
    expect(core.size()).toBe(2);
    expect(core.entries().map(e => e.requestId)).toEqual(['r1', 'r2']);
    expect(core.entries()[0].status).toBe('applied');
    expect(core.entries()[0].time).toBe(5000);
  });

  it('容量有界:超出淘汰最旧,被淘汰行状态推进如实 false(索引已清)', () => {
    const core = makeCore(2);
    seed(core, [makeEntry({ requestId: 'r1' }), makeEntry({ requestId: 'r2' }), makeEntry({ requestId: 'r3' })]);
    expect(core.size()).toBe(2);
    expect(core.entries().map(e => e.requestId)).toEqual(['r2', 'r3']);
    expect(core.updateStatus('r1', 'applied')).toBe(false);
    expect(core.updateStatus('r3', 'applied')).toBe(true);
  });
});

describe('状态推进(HR-UI-009 可信回执口径)', () => {
  it('sent-unverified→applied / →failed 单向推进', () => {
    const core = makeCore();
    core.record(makeEntry({ requestId: 'r1' }));
    expect(core.updateStatus('r1', 'applied')).toBe(true);
    expect(core.entries()[0].status).toBe('applied');
    core.record(makeEntry({ requestId: 'r2', status: 'sent-unverified' }));
    expect(core.updateStatus('r2', 'failed', 'HTTP 500')).toBe(true);
    expect(core.entries()[1].status).toBe('failed');
    expect(core.entries()[1].errorSummary).toBe('HTTP 500');
  });

  it('终态不回退:applied/failed 任何迁移与自迁移拒,不存在的 id 拒', () => {
    const core = makeCore();
    core.record(makeEntry({ requestId: 'r1' }));
    core.updateStatus('r1', 'applied');
    expect(core.updateStatus('r1', 'sent-unverified')).toBe(false);
    expect(core.updateStatus('r1', 'failed')).toBe(false);
    expect(core.updateStatus('r1', 'applied')).toBe(false);
    core.record(makeEntry({ requestId: 'r2' }));
    core.updateStatus('r2', 'failed');
    expect(core.updateStatus('r2', 'applied')).toBe(false);
    expect(core.updateStatus('missing', 'applied')).toBe(false);
    // 拒绝不动原状态
    expect(core.entries()[0].status).toBe('applied');
  });
});

describe('过滤(HR-UI-010)', () => {
  const rows = (): HotReloadHistoryInput[] => [
    makeEntry({ requestId: 'r1', fullModule: 'entities.fight.FightAI', targetId: 'cellapp-1', time: 1000 }),
    makeEntry({ requestId: 'r2', fullModule: 'entities.fight.FightAI', targetId: 'cellapp-2', time: 2000 }),
    makeEntry({
      requestId: 'r3',
      fullModule: 'entities.base.Avatar',
      fileUri: '/ws/scripts/base/Avatar.py',
      targetId: 'cellapp-1',
      time: 3000,
      status: 'failed'
    }),
    makeEntry({
      requestId: 'r4',
      fullModule: 'entities.fight.Boss',
      fileUri: '/ws/scripts/fight/Boss.py',
      targetId: 'loginapp-1',
      time: 4000,
      status: 'applied'
    })
  ];

  it('fullModule 子串大小写不敏', () => {
    const core = makeCore();
    seed(core, rows());
    expect(core.filter({ fullModuleContains: 'fight' }).map(e => e.requestId)).toEqual(['r1', 'r2', 'r4']);
    expect(core.filter({ fullModuleContains: 'FIGHTAI' }).map(e => e.requestId)).toEqual(['r1', 'r2']);
  });

  it('HR-UI-010/014 同路径不同 target 是两行,按 targetId 过滤各归各', () => {
    const core = makeCore();
    seed(core, rows());
    expect(core.filter({ targetId: 'cellapp-1' }).map(e => e.requestId)).toEqual(['r1', 'r3']);
    expect(core.filter({ targetId: 'cellapp-2' }).map(e => e.requestId)).toEqual(['r2']);
    // 全量里同文件两行并存不合并
    expect(core.entries().filter(e => e.fullModule === 'entities.fight.FightAI')).toHaveLength(2);
  });

  it('状态+时间范围组合 AND 过滤(含边界)', () => {
    const core = makeCore();
    seed(core, rows());
    expect(core.filter({ status: 'failed' }).map(e => e.requestId)).toEqual(['r3']);
    expect(core.filter({ timeFrom: 2000, timeTo: 3000 }).map(e => e.requestId)).toEqual(['r2', 'r3']);
    expect(core.filter({ status: 'applied', timeFrom: 3500 }).map(e => e.requestId)).toEqual(['r4']);
    expect(core.filter({ fileUri: '/ws/scripts/fight/FightAI.py' })).toHaveLength(2);
    expect(core.filter({ fullModuleContains: 'fight', status: 'failed' })).toHaveLength(0);
  });

  it('HR-STATE-007 按触发源/错误七类过滤(全条件 AND;缺省字段行不命中)', () => {
    const core = makeCore();
    seed(core, [
      makeEntry({ requestId: 'r1', trigger: 'watcher-auto' }),
      makeEntry({ requestId: 'r2', trigger: 'command' }),
      makeEntry({ requestId: 'r3', status: 'failed', errorSummary: 'HTTP 状态 500:非 2xx 不算送达', errorCategory: 'apply-failed' }),
      makeEntry({ requestId: 'r4', status: 'failed', errorSummary: '端点不可达(拒绝连接)', errorCategory: 'target-unreachable' }),
      // r5 失败但未定类(unknown 不入字段):errorCategory 过滤不命中
      makeEntry({ requestId: 'r5', status: 'failed', errorSummary: '自定义失败文本' })
    ]);
    expect(core.filter({ trigger: 'watcher-auto' }).map(e => e.requestId)).toEqual(['r1']);
    expect(core.filter({ trigger: 'command' }).map(e => e.requestId)).toEqual(['r2']);
    // 无 trigger 字段的行不命中 trigger 过滤(如实不猜)
    expect(core.filter({ trigger: 'retry' })).toHaveLength(0);
    expect(core.filter({ errorCategory: 'apply-failed' }).map(e => e.requestId)).toEqual(['r3']);
    expect(core.filter({ errorCategory: 'target-unreachable' }).map(e => e.requestId)).toEqual(['r4']);
    // 未定类失败行不被任何 errorCategory 过滤命中
    expect(core.filter({ errorCategory: 'unknown' })).toHaveLength(0);
    // 组合 AND:同一 target 的失败按类分拣
    expect(core.filter({ status: 'failed', errorCategory: 'apply-failed', targetId: 'cellapp-1' })).toHaveLength(1);
  });
});

describe('HR-STATE-007 可检索九要素字段面', () => {
  it('新四要素(trigger/durationMs/errorCategory/hash)记录后在行上原样可读', () => {
    const core = makeCore();
    core.record(
      makeEntry({
        requestId: 'r1',
        status: 'failed',
        errorSummary: 'HTTP 状态 500:非 2xx 不算送达',
        errorCategory: 'apply-failed',
        trigger: 'watcher-auto',
        durationMs: 1234,
        hash: 'a'.repeat(64)
      })
    );
    const row = core.entries()[0];
    expect(row.trigger).toBe('watcher-auto');
    expect(row.durationMs).toBe(1234);
    expect(row.errorCategory).toBe('apply-failed');
    expect(row.hash).toBe('a'.repeat(64));
  });

  it('tooltip 投影:新要素各占安全前缀行,缺省不伪造占位', () => {
    const full = buildHistoryEntryTooltipLines(
      makeEntry({ trigger: 'command', durationMs: 42, errorCategory: 'target-unreachable', hash: 'cafecafecafecafe' })
    );
    expect(full.filter(line => /^(trigger|duration|hash|errorCategory):/.test(line))).toEqual([
      'trigger: command',
      'duration: 42ms',
      'hash: cafecafecafecafe',
      'errorCategory: target-unreachable'
    ]);
    const bare = buildHistoryEntryTooltipLines(makeEntry());
    expect(bare.some(line => /^(trigger|duration|hash|errorCategory):/.test(line))).toBe(false);
  });

  it('幂等替换保留新字段:requestId 重记录整体覆盖', () => {
    const core = makeCore();
    core.record(makeEntry({ requestId: 'r1', trigger: 'retry', hash: 'old' }));
    core.record(makeEntry({ requestId: 'r1', status: 'applied', trigger: 'retry', hash: 'new' }));
    const row = core.entries()[0];
    expect(row.hash).toBe('new');
    expect(row.trigger).toBe('retry');
  });
});

describe('分页窗口(HR-UI-007 虚拟滚动数据面)', () => {
  it('正常页/部分尾页/越界空页如实', () => {
    const rows = [1, 2, 3, 4, 5].map(String);
    expect(HotReloadHistoryCore.page(rows, 0, 2)).toEqual({ items: ['1', '2'], total: 5, hasMore: true });
    expect(HotReloadHistoryCore.page(rows, 4, 2)).toEqual({ items: ['5'], total: 5, hasMore: false });
    expect(HotReloadHistoryCore.page(rows, 9, 2)).toEqual({ items: [], total: 5, hasMore: false });
  });

  it('分页作用于过滤结果(过滤+分页组合)', () => {
    const core = makeCore();
    seed(
      core,
      Array.from({ length: 6 }, (_, i) => makeEntry({ requestId: `r${i}`, fullModule: i < 2 ? 'a.B' : 'a.A', time: i }))
    );
    const filtered = core.filter({ fullModuleContains: 'a.a' });
    expect(HotReloadHistoryCore.page(filtered, 0, 2).total).toBe(4);
    expect(HotReloadHistoryCore.page(filtered, 0, 2).items.map(e => e.requestId)).toEqual(['r2', 'r3']);
  });
});

describe('分组(HR-UI-002 树视图)', () => {
  it('groupByFile:组键首次出现序,组内最新在前(输入须 newestFirst)', () => {
    const core = makeCore();
    seed(core, [
      makeEntry({ requestId: 'r1', fileUri: '/ws/A.py', time: 1000 }),
      makeEntry({ requestId: 'r2', fileUri: '/ws/B.py', time: 2000 }),
      makeEntry({ requestId: 'r3', fileUri: '/ws/A.py', time: 3000 })
    ]);
    const groups = HotReloadHistoryCore.groupByFile(core.newestFirst());
    expect([...groups.keys()]).toEqual(['/ws/A.py', '/ws/B.py']);
    expect(groups.get('/ws/A.py')!.map(e => e.requestId)).toEqual(['r3', 'r1']);
  });

  it('groupByTarget:同路径不同 target 落不同组(HR-UI-014)', () => {
    const core = makeCore();
    seed(core, [
      makeEntry({ requestId: 'r1', targetId: 'cellapp-1' }),
      makeEntry({ requestId: 'r2', targetId: 'cellapp-2', fileUri: '/ws/scripts/fight/FightAI.py' })
    ]);
    const groups = HotReloadHistoryCore.groupByTarget(core.newestFirst());
    expect([...groups.keys()]).toEqual(['cellapp-2', 'cellapp-1']);
    expect(groups.get('cellapp-1')!).toHaveLength(1);
    expect(groups.get('cellapp-2')!).toHaveLength(1);
  });
});

describe('高频合并(HR-UI-007 呈现层节流决策)', () => {
  it('同 requestId 窗内多条合并取末态;跨窗保留;不同 id 独立', () => {
    const merged = coalesceHistoryUpdates(
      [
        { requestId: 'r1', status: 'sent-unverified', time: 0 },
        { requestId: 'r2', status: 'sent-unverified', time: 10 },
        { requestId: 'r1', status: 'failed', time: 50, errorSummary: 'HTTP 500' },
        { requestId: 'r1', status: 'applied', time: 90 },
        { requestId: 'r2', status: 'applied', time: 120 }
      ],
      100
    );
    // r1 的 0/50/90 三条在窗内连成一条取 90 的 applied;
    // r2 的 10 与 120 差 110ms 超窗 → 各自成条(跨窗不合并)
    expect(merged).toEqual([
      { requestId: 'r1', status: 'applied', time: 90 },
      { requestId: 'r2', status: 'sent-unverified', time: 10 },
      { requestId: 'r2', status: 'applied', time: 120 }
    ]);
  });

  it('跨窗不合并:超过 windowMs 的后续更新独立成条', () => {
    const merged = coalesceHistoryUpdates(
      [
        { requestId: 'r1', status: 'sent-unverified', time: 0 },
        { requestId: 'r1', status: 'applied', time: 101 }
      ],
      100
    );
    expect(merged).toHaveLength(2);
    expect(merged[1].status).toBe('applied');
  });
});

describe('HR-UI-006 名称投影(完整名 vs 发送名)', () => {
  it('标题取 fullModule;缺失如实回落 requestModule/占位', () => {
    expect(buildHistoryEntryLabel(makeEntry())).toBe('entities.fight.FightAI');
    expect(buildHistoryEntryLabel(makeEntry({ fullModule: '' }))).toBe('fight.FightAI');
    expect(buildHistoryEntryLabel(makeEntry({ fullModule: '', requestModule: '' }))).toBe('(unknown module)');
  });

  it('tooltip 字段齐:双名仅在与 fullModule 不同时列 requestModule;错误摘要如实', () => {
    const lines = buildHistoryEntryTooltipLines(makeEntry({ errorSummary: 'HTTP 500' }));
    expect(lines.some(l => l.startsWith('requestModule: fight.FightAI'))).toBe(true);
    expect(lines.some(l => l.includes('entities.fight.FightAI'))).toBe(true);
    expect(lines.some(l => l.startsWith('target: cellapp-1'))).toBe(true);
    expect(lines.some(l => l.startsWith('requestId: req-1'))).toBe(true);
    expect(lines.some(l => l.startsWith('error: HTTP 500'))).toBe(true);

    const same = buildHistoryEntryTooltipLines(
      makeEntry({ fullModule: 'fight.FightAI', requestModule: 'fight.FightAI' })
    );
    expect(same.some(l => l.startsWith('requestModule:'))).toBe(false);
  });
});

describe('HR-UI-007 虚拟滚动窗口(computeVirtualScrollWindow 纯决策)', () => {
  it('初始视口:scrollTop=0 从首行起,窗口=视口行数+上下 overscan', () => {
    const w = computeVirtualScrollWindow({
      totalRows: 1000, rowHeightPx: 26, viewportHeightPx: 520, scrollTopPx: 0, overscanRows: 5
    });
    expect(w.startIndex).toBe(0);
    // ceil(520/26)=20 视口行 + 5 overscan = 25
    expect(w.endIndex).toBe(25);
    expect(w.totalHeightPx).toBe(26000);
  });

  it('滚动中段:首行随 scrollTop 前移,overscan 向上扩', () => {
    const w = computeVirtualScrollWindow({
      totalRows: 1000, rowHeightPx: 26, viewportHeightPx: 520, scrollTopPx: 2600, overscanRows: 5
    });
    // floor(2600/26)=100 - 5 = 95;100+20+5=125
    expect(w.startIndex).toBe(95);
    expect(w.endIndex).toBe(125);
  });

  it('滚过尾:first/end 都夹到 totalRows=尾后空窗,不产倒挂窗口', () => {
    const w = computeVirtualScrollWindow({
      totalRows: 1000, rowHeightPx: 26, viewportHeightPx: 520, scrollTopPx: 30000, overscanRows: 5
    });
    expect(w.endIndex).toBe(1000);
    expect(w.startIndex).toBe(1000);
  });

  it('夹紧防御:零行如实空窗,负值/零行高/零视口不产非法窗口', () => {
    const empty = computeVirtualScrollWindow({
      totalRows: 0, rowHeightPx: 26, viewportHeightPx: 520, scrollTopPx: 0, overscanRows: 5
    });
    expect(empty.startIndex).toBe(0);
    expect(empty.endIndex).toBe(0);
    expect(empty.totalHeightPx).toBe(0);

    const clamped = computeVirtualScrollWindow({
      totalRows: -3, rowHeightPx: 0, viewportHeightPx: -10, scrollTopPx: -100, overscanRows: -2
    });
    expect(clamped.startIndex).toBe(0);
    expect(clamped.endIndex).toBe(0);
    expect(clamped.totalHeightPx).toBe(0);
  });

  it('overscan 超总量时 endIndex=totalRows、startIndex=0(小列表不越界)', () => {
    const w = computeVirtualScrollWindow({
      totalRows: 3, rowHeightPx: 26, viewportHeightPx: 520, scrollTopPx: 0, overscanRows: 50
    });
    expect(w.startIndex).toBe(0);
    expect(w.endIndex).toBe(3);
    expect(w.totalHeightPx).toBe(78);
  });
});

describe('HR-STATE-007 残差检索键(requestModule 子串/哈希前缀/耗时区间)', () => {
  it('requestModuleContains 子串(大小写不敏),与 fullModule 检索互不串台', () => {
    const core = makeCore();
    seed(core, [
      makeEntry({ requestId: 'r1', fullModule: 'entities.fight.FightAI', requestModule: 'fight.FightAI' }),
      makeEntry({ requestId: 'r2', fullModule: 'entities.spawn.Spawner', requestModule: 'spawn.Spawner' })
    ]);
    expect(core.filter({ requestModuleContains: 'SPAWN' }).map(e => e.requestId)).toEqual(['r2']);
    expect(core.filter({ requestModuleContains: 'fight' }).map(e => e.requestId)).toEqual(['r1']);
  });

  it('hash 前缀匹配;空串=不限定(与子串字段同口径);未知前缀零命中', () => {
    const core = makeCore();
    seed(core, [
      makeEntry({ requestId: 'r1', hash: 'abcdef1234567890' }),
      makeEntry({ requestId: 'r2', hash: 'fedcba0987654321' }),
      makeEntry({ requestId: 'r3' })
    ]);
    expect(core.filter({ hash: 'abcdef' }).map(e => e.requestId)).toEqual(['r1']);
    expect(core.filter({ hash: 'f' }).map(e => e.requestId)).toEqual(['r2']);
    expect(core.filter({ hash: 'zzz' })).toHaveLength(0);
    // 空哈希串不作过滤(与 fullModuleContains 同口径)
    expect(core.filter({ hash: '' })).toHaveLength(3);
  });

  it('耗时区间含边界命中;无耗时行(基准冻结/未记录)不命中区间,不计 0 也不计 ∞', () => {
    const core = makeCore();
    seed(core, [
      makeEntry({ requestId: 'r-fast', durationMs: 12 }),
      makeEntry({ requestId: 'r-mid', durationMs: 300 }),
      makeEntry({ requestId: 'r-slow', durationMs: 900 }),
      makeEntry({ requestId: 'r-no-dur' })
    ]);
    expect(core.filter({ durationFrom: 10, durationTo: 300 }).map(e => e.requestId)).toEqual(['r-fast', 'r-mid']);
    expect(core.filter({ durationTo: 900 }).map(e => e.requestId)).toEqual(['r-fast', 'r-mid', 'r-slow']);
    expect(core.filter({ durationFrom: 900 }).map(e => e.requestId)).toEqual(['r-slow']);
    // 无耗时行被区间查询排除
    expect(core.filter({ durationFrom: 0 })).toHaveLength(3);
  });

  it('残差键与既有键全 AND 正交叠加', () => {
    const core = makeCore();
    seed(core, [
      makeEntry({ requestId: 'a', trigger: 'command', hash: 'aaa111', durationMs: 50, targetId: 'cellapp-1' }),
      makeEntry({ requestId: 'b', trigger: 'command', hash: 'aaa222', durationMs: 50, targetId: 'cellapp-2' }),
      makeEntry({ requestId: 'c', trigger: 'watcher-auto', hash: 'aaa111', durationMs: 900, targetId: 'cellapp-1' }),
      makeEntry({ requestId: 'd', trigger: 'command', hash: 'bbb111', durationMs: 900, targetId: 'cellapp-1' })
    ]);
    expect(
      core.filter({ trigger: 'command', hash: 'aaa', durationTo: 500 }).map(e => e.requestId)
    ).toEqual(['a', 'b']);
    expect(
      core.filter({ trigger: 'command', hash: 'aaa', durationTo: 500, targetId: 'cellapp-1' }).map(e => e.requestId)
    ).toEqual(['a']);
    // 全条目 requestModule 缺省 'fight.FightAI':子串命中全部,再叠耗时区间
    expect(core.filter({ requestModuleContains: 'fight', durationFrom: 900 }).map(e => e.requestId)).toEqual(['c', 'd']);
  });
});
describe('HR-STATE-008 保留时间限额(maxAgeMs 剪除过期行)', () => {
  it('配置 maxAgeMs:以每次记录时刻为参考,早于 (参考−maxAgeMs) 的行剪除;边界(=minTime)保留', () => {
    const core = new HotReloadHistoryCore({ maxAgeMs: 10000 });
    core.record(makeEntry({ requestId: 'r-old', time: 0 }));
    core.record(makeEntry({ requestId: 'r-mid', time: 4000 }));
    core.record(makeEntry({ requestId: 'r-new', time: 10000 }));
    expect(core.size()).toBe(3);
    // 参考=12000 → minTime=2000:time 0 剪除,4000/10000 保留(4000 仍 >2000)
    core.record(makeEntry({ requestId: 'r-latest', time: 12000 }));
    expect(core.size()).toBe(3);
    expect(core.entries().map(e => e.time).sort((a, b) => a - b)).toEqual([4000, 10000, 12000]);
    expect(core.entries().map(e => e.requestId).sort()).toEqual(['r-latest', 'r-mid', 'r-new']);
  });

  it('未配 maxAgeMs:只受容量限制,不随时间剪除', () => {
    const core = new HotReloadHistoryCore({ capacity: 5 });
    core.record(makeEntry({ requestId: 'a', time: 0 }));
    core.record(makeEntry({ requestId: 'b', time: 1000000000 }));
    expect(core.size()).toBe(2);
  });

  it('同 requestId 替换也触发保留参考滚动(索引随剪除重建,updateStatus 仍可寻址)', () => {
    const core = new HotReloadHistoryCore({ maxAgeMs: 10000 });
    core.record(makeEntry({ requestId: 'x', time: 0 }));
    core.record(makeEntry({ requestId: 'y', time: 1000 }));
    // 替换 x 推进参考到 12000 → minTime 2000:y@1000 剪除,x@12000 保留
    core.record(makeEntry({ requestId: 'x', time: 12000 }));
    expect(core.entries().map(e => e.requestId)).toEqual(['x']);
    expect(core.updateStatus('y', 'applied')).toBe(false);
    expect(core.updateStatus('x', 'failed')).toBe(true);
  });
});

describe('HR-STATE-008 脱敏 JSON 导出(白名单投影)', () => {
  const fullEntry = (): HotReloadHistoryInput => ({
    requestId: 'req-1',
    fullModule: 'entities.fight.FightAI',
    requestModule: 'fight.FightAI',
    fileUri: '/ws/fight/FightAI.py',
    targetId: 'cellapp-1',
    time: 1700000000000,
    status: 'failed',
    errorSummary: 'ECONNREFUSED',
    trigger: 'retry',
    durationMs: 120,
    errorCategory: 'endpoint-unreachable',
    hash: 'a'.repeat(64)
  });

  it('投影只取白名单在场字段:全字段行=12 键;缺省可选字段如实不落', () => {
    const full = projectHotReloadHistoryExportRow(fullEntry());
    expect(Object.keys(full).sort()).toEqual([...HOT_RELOAD_HISTORY_EXPORT_FIELDS].sort());
    const partial = projectHotReloadHistoryExportRow(makeEntry({ requestId: 'p' }));
    expect(Object.keys(partial).sort()).toEqual(['fileUri', 'fullModule', 'requestId', 'requestModule', 'status', 'targetId', 'time']);
  });

  it('白名单是脱敏闸:DTO 上额外密钥形状字段不透传(不整体 JSON.stringify)', () => {
    const entry = fullEntry() as unknown as Record<string, unknown>;
    entry.header = 'Bearer secret';
    entry.token = 'abc123';
    const row = projectHotReloadHistoryExportRow(entry as unknown as HotReloadHistoryInput);
    expect('header' in row).toBe(false);
    expect('token' in row).toBe(false);
    const json = serializeHotReloadHistoryJson([entry as unknown as HotReloadHistoryInput]);
    expect(json).not.toMatch(/header|token/i);
  });

  it('序列化:顶层 schema/version/count;entries 白名单投影;无 HTTP body 字段', () => {
    const json = serializeHotReloadHistoryJson([fullEntry()]);
    const parsed = JSON.parse(json);
    expect(parsed.schema).toBe('kbengine.hotReloadHistory');
    expect(parsed.version).toBe(1);
    expect(parsed.count).toBe(1);
    expect(Object.keys(parsed.entries[0]).sort()).toEqual([...HOT_RELOAD_HISTORY_EXPORT_FIELDS].sort());
    expect('body' in parsed.entries[0]).toBe(false);
    expect(parsed.entries[0].errorCategory).toBe('endpoint-unreachable');
  });
});
