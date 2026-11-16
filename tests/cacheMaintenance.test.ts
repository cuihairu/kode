import { describe, expect, it } from 'vitest';
import {
  renderCacheClearConfirmation,
  renderCacheClearedReport,
  type CacheClearBeforeAfter,
  type CacheClearEntryGauge
} from '../src/backend/cacheMaintenance';

// RUST-221(旧 UI-004)缓存维护纯核:确认文案列范围与影响(内存缓存重建,
// 不动磁盘与工作区文件,无数据丢失——「勿要求用户清空 workspace 才能修」的
// 直接对答),清后摘要逐条报差值、空清如实说明。动作组合在接线层。

describe('renderCacheClearConfirmation (RUST-221)', () => {
  it('范围段列出三缓存与在册条数,影响段如实声明无数据丢失', () => {
    const gauges: CacheClearEntryGauge[] = [
      { label: '解析文档缓存', entries: 12 },
      { label: '数据库 schema 缓存', entries: 3 },
      { label: '返回注解索引', entries: 5 }
    ];
    const text = renderCacheClearConfirmation(gauges);
    expect(text).toContain('解析文档缓存 12 条');
    expect(text).toContain('数据库 schema 缓存 3 条');
    expect(text).toContain('返回注解索引 5 条');
    expect(text).toContain('下次查询自动重建');
    expect(text).toContain('不动磁盘与工作区文件,无数据丢失');
    expect(text).toContain('重启窗口不是第一步');
  });

  it('零条目也如实列出(0 条),不隐藏空缓存', () => {
    const text = renderCacheClearConfirmation([{ label: '解析文档缓存', entries: 0 }]);
    expect(text).toContain('解析文档缓存 0 条');
  });
});

describe('renderCacheClearedReport (RUST-221)', () => {
  it('逐缓存报前后差值', () => {
    const rows: CacheClearBeforeAfter[] = [
      { label: '解析文档缓存', before: 12, after: 0 },
      { label: '数据库 schema 缓存', before: 3, after: 1 },
      { label: '返回注解索引', before: 5, after: 5 }
    ];
    const text = renderCacheClearedReport(rows);
    expect(text).toContain('解析文档缓存: 清掉 12 条');
    expect(text).toContain('数据库 schema 缓存: 清掉 2 条');
    expect(text).toContain('返回注解索引: 清掉 0 条');
    expect(text).not.toContain('本次没有清掉任何条目');
  });

  it('缓存本已空 → 如实说明,不虚报清掉条数', () => {
    const text = renderCacheClearedReport([{ label: '解析文档缓存', before: 0, after: 0 }]);
    expect(text).toContain('本次没有清掉任何条目(缓存本已为空)。');
  });
});
