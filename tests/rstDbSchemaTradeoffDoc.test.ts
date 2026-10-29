import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

// IDE-RST-006 数据库纯推导迁移取舍记录锁:docs/review/2026-10-29-dbschema-migration-tradeoff.md
// 验收口径:同 URI/版本比较 TS 与 Rust 含 IPC 的总耗时,不以行数代替收益。
// 数字来自 2026-10-29 本机单轮合成语料探针(临时文件,已删;方法在记录内
// 复述可复现),跨机器绝对值禁止比较(PERF-015)。

const root = join(__dirname, '..');
const doc = readFileSync(
  join(root, 'docs/review/2026-10-29-dbschema-migration-tradeoff.md'),
  'utf8'
);

describe('数据库纯推导迁移取舍记录(IDE-RST-006)', () => {
  it('四节齐备', () => {
    for (const section of [
      '# 数据库纯推导迁移取舍',
      '## 1. 调用面与缓存形态',
      '## 2. 输入缺口(相对 R2)',
      '## 3. 含 IPC 的耗时对比',
      '## 4. 采纳/暂缓结论',
    ]) {
      expect(doc, `缺章节 ${section}`).toContain(section);
    }
  });

  it('实测数字与口径在档(单轮/合成语料/含 IPC 免责)', () => {
    for (const fact of ['18.25', '18.12', '5.46', '0.550', '0.339', '0.047']) {
      expect(doc, `缺实测数字 ${fact}`).toContain(fact);
    }
    expect(doc).toContain('单轮');
    expect(doc).toContain('合成语料');
    expect(doc).toContain('PERF-015');
    expect(doc).toMatch(/含 IPC|IPC/);
  });

  it('调用面事实:hover 走缓存/预热在后台/纯面已拆出', () => {
    expect(doc).toMatch(/SCH-007|describePropertyDatabaseStorage|hover/);
    expect(doc).toMatch(/SCH-006|预热|后台/);
    expect(doc).toMatch(/deriveDatabaseTables|SCH-001/);
    expect(doc).toMatch(/缓存/);
  });

  it('输入缺口点名 R2 缺失项', () => {
    expect(doc).toContain('r2-index-inventory');
    // §4 缺口三处:VS Code 配置(tablePrefix)/项目布局与文件存在性/未保存缓冲区
    expect(doc).toMatch(/tablePrefix|配置/);
    expect(doc).toMatch(/项目布局|文件存在性|entities\.xml/);
    expect(doc).toMatch(/未保存|缓冲区/);
  });

  it('结论为暂缓且 IPC 结论方向正确(Rust 往返下界不低于 TS 命中成本)', () => {
    expect(doc).toMatch(/暂缓/);
    expect(doc).toMatch(/复评触发|触发条件/);
    // 核心判据:含 IPC 后 Rust 单次往返已 ≥ TS 缓存命中,交互面无收益
    expect(doc).toMatch(/高于|不低于|无收益|慢/);
  });
});
