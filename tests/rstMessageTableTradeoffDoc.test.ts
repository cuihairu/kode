import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

// IDE-RST-005 messageTable 迁移取舍记录锁:docs/review/2026-10-29-messagetable-migration-tradeoff.md
// 必须计入产品调用频率、types.xml/alias 配置与装配语义成本,并给出采纳/暂缓结论。
// 耗时数字来自 2026-10-29 本机单轮合成语料探针(临时文件,已删;方法在记录内
// 复述可复现),引用时不得跨机器比较(PERF-015)。

const root = join(__dirname, '..');
const doc = readFileSync(
  join(root, 'docs/review/2026-10-29-messagetable-migration-tradeoff.md'),
  'utf8'
);

describe('messageTable 迁移取舍记录(IDE-RST-005)', () => {
  it('四节齐备', () => {
    for (const section of [
      '# messageTable 迁移取舍',
      '## 1. 产品调用频率',
      '## 2. types.xml 与 alias 配置',
      '## 3. 装配语义成本',
      '## 4. 采纳/暂缓结论',
    ]) {
      expect(doc, `缺章节 ${section}`).toContain(section);
    }
  });

  it('实测数字与口径在档(单轮/合成语料免责)', () => {
    for (const fact of ['41.05', '65.52', '43.65', '23.53']) {
      expect(doc, `缺实测数字 ${fact}`).toContain(fact);
    }
    expect(doc).toContain('单轮');
    expect(doc).toContain('合成语料');
    expect(doc).toContain('PERF-015');
  });

  it('产品调用频率面:两命令入口在档,范围评审旧结论更正在档', () => {
    expect(doc).toContain('kbengine.messagetable.preview');
    expect(doc).toContain('kbengine.messagetable.export');
    // 范围评审「messageTable 无产品调用点」已被 SDK-001/002 接线取代
    expect(doc).toMatch(/SDK-001|98f4a06/);
    expect(doc).toMatch(/更正|过时/);
  });

  it('配置面事实:产品接线不传 options(aliasIdEnabled 恒 false/typesXml 未喂)', () => {
    expect(doc).toContain('aliasIdEnabled');
    expect(doc).toMatch(/恒\s*false|不传 options|未接配置/);
    expect(doc).toContain('typesXml');
    expect(doc).toContain('entitydefAliasID');
  });

  it('装配语义成本面:引擎装配序与 R2 缺口点名', () => {
    expect(doc).toMatch(/loadDefInfo|装配序/);
    expect(doc).toMatch(/Interfaces|组件模块/);
    // R2 输入缺口点名(r2-index-inventory §4):MethodDef 五字段无编号
    expect(doc).toMatch(/MethodDef/);
    expect(doc).toMatch(/编号|Utype/);
    // SDK-005 审计面作 parity 资产
    expect(doc).toContain('f85ad81');
    expect(doc).toContain('r2-index-inventory');
  });

  it('结论为暂缓且带复评触发条件', () => {
    expect(doc).toMatch(/暂缓/);
    expect(doc).toMatch(/复评触发|触发条件/);
  });
});
