import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

// IDE-RST-004 defAnalyzer 迁移取舍记录锁:docs/review/2026-10-29-defanalyzer-migration-tradeoff.md
// 必须给出输入缺口、当前耗时(实测数字+口径)、位置对拍范围和采纳/暂缓结论。
// 耗时数字来自 2026-10-29 本机单轮合成语料探针(临时文件,已删;方法与
// 口径在记录内复述可复现),引用时不得跨机器比较(PERF-015)。

const root = join(__dirname, '..');
const doc = readFileSync(join(root, 'docs/review/2026-10-29-defanalyzer-migration-tradeoff.md'), 'utf8');

describe('defAnalyzer 迁移取舍记录(IDE-RST-004)', () => {
  it('四节齐备', () => {
    for (const section of [
      '# defAnalyzer 迁移取舍',
      '## 1. 输入缺口',
      '## 2. 当前耗时',
      '## 3. 位置对拍范围',
      '## 4. 采纳/暂缓结论',
    ]) {
      expect(doc, `缺章节 ${section}`).toContain(section);
    }
  });

  it('实测数字与口径在档(单轮/合成语料/不含宿主 IO 免责)', () => {
    for (const fact of ['824.94', '2325.88', '16.43', '754.41', '2159.13']) {
      expect(doc, `缺实测数字 ${fact}`).toContain(fact);
    }
    expect(doc).toContain('单轮');
    expect(doc).toContain('合成语料');
    expect(doc).toMatch(/openTextDocument/);
  });

  it('输入缺口四处点名(未保存缓冲区/Interfaces 与组件闭包/引擎真值表/UTF-16 与字节)', () => {
    expect(doc).toMatch(/未保存|脏缓冲/);
    expect(doc).toMatch(/Interfaces/);
    expect(doc).toMatch(/真值表|PROPERTY_FLAG_DOMAINS/);
    expect(doc).toMatch(/UTF-16/);
    expect(doc).toMatch(/字节/);
  });

  it('结论为暂缓且带复评触发条件与 RST-003 引用', () => {
    expect(doc).toMatch(/暂缓/);
    expect(doc).toMatch(/复评触发|触发条件/);
    expect(doc).toContain('r2-index-inventory');
    // 九类检查清单入档(检查语义移植量依据)
    for (const check of ['phantom-type', 'method-property-collision', 'inherited-name-collision']) {
      expect(doc, `缺检查项 ${check}`).toContain(check);
    }
  });
});
