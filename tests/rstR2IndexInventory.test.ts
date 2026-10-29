import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

// IDE-RST-003 R2 索引字段清单锁:文档必须分 AST/语义模型/公开索引接口
// 三面列出 Rust R2(kode-parser/kode-types/kode-index)已提供的字段,
// 并把派生计算需要而索引没有的面标成【缺失】——「解析过同一份 XML」
// 不等于索引具备派生计算所需的全部输入(范围评审修正建议 2)。
// 本测试把清单钉在 crate 源码上:①SymbolIndex 公开方法清单与 index.rs
// 实际 pub fn 集合恰好相等(API 漂移=红);②关键字段逐名对账;③缺失面
// 标注在位且不少于六项。

const root = join(__dirname, '..');
const read = (relative: string): string => readFileSync(join(root, relative), 'utf8');
const doc = read('docs/review/2026-10-29-r2-index-inventory.md');
const indexRs = read('crates/kode-index/src/index.rs');
const modelRs = read('crates/kode-parser/src/model.rs');

function structFields(source: string, structName: string): string[] {
  const start = source.indexOf(`pub struct ${structName} {`);
  expect(start, `源码缺 pub struct ${structName}`).toBeGreaterThan(0);
  const end = source.indexOf('}', start);
  const body = source.slice(start, end);
  return [...body.matchAll(/pub (\w+):/g)].map(match => match[1]);
}

describe('R2 索引字段清单(IDE-RST-003)', () => {
  it('三面+缺失面章节在位', () => {
    for (const section of [
      '# R2 索引字段清单',
      '## 1. AST 面',
      '## 2. 语义模型面',
      '## 3. 公开索引接口面',
      '## 4. 缺失面',
    ]) {
      expect(doc, `缺章节 ${section}`).toContain(section);
    }
  });

  it('SymbolIndex 公开方法清单与 index.rs 实际 pub fn 集合恰好相等', () => {
    const censusLine = doc.split('\n').find(line => line.startsWith('SymbolIndex 公开方法:'));
    expect(censusLine, '缺方法清单行(SymbolIndex 公开方法:…)').toBeDefined();
    const documented = new Set(
      (censusLine ?? '').split(':').slice(1).join(':').trim().split(/\s+/).filter(Boolean)
    );
    const actual = new Set(
      [...indexRs.matchAll(/pub fn (\w+)\(/g)].map(m => m[1])
    );
    expect(documented, '清单与 index.rs pub fn 集合不一致(漂移须同笔改清单)').toEqual(actual);
  });

  it('关键字段逐名对账(DefFile/PropertyDef/MethodDef/TypeDecl)', () => {
    for (const structName of ['DefFile', 'PropertyDef', 'MethodDef', 'TypeDecl']) {
      for (const field of structFields(modelRs, structName)) {
        expect(doc, `${structName}.${field} 未入册`).toContain(field);
      }
    }
  });

  it('MethodDef 只保留部分字段的事实入册;缺失面标注不少于六项', () => {
    expect(doc).toMatch(/MethodDef[^\n]*(只|仅).{0,20}(name|暴露)/);
    const missingMarkers = (doc.match(/【缺失】/g) ?? []).length;
    expect(missingMarkers, '【缺失】标注应不少于六项').toBeGreaterThanOrEqual(6);
    // 范围评审的缺口结论至少覆盖:未保存缓冲区/VS Code 配置/Python 语义
    expect(doc).toMatch(/【缺失】[^\n]*缓冲区|缓冲区[^\n]*【缺失】/);
    expect(doc).toMatch(/【缺失】[^\n]*配置|配置[^\n]*【缺失】/);
    expect(doc).toMatch(/Python/);
  });
});
