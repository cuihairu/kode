import { afterEach, describe, expect, it } from 'vitest';
import {
  clearParsedDocumentCacheForTests,
  getParsedDocumentCacheStats,
  parseDefDocument,
  setParsedDocumentCacheByteBudgetForTests
} from '../src/defParser';

// IDE-SNP-007:XML 解析缓存字节预算——超预算按 LRU 淘汰旧条目;单份巨型文档
// 最多独占一条(允许字节超限但条目=1,不给 8 条目无限保留留门)。

function makeXml(bytes: number, seed = 'a'): string {
  const filler = seed.repeat(2) + 'x'.repeat(Math.max(0, bytes - 42 - seed.length * 2));
  return `<root>\n  <a>${filler}</a>\n</root>`;
}

const DEFAULT_BUDGET = 8 * 1024 * 1024;

afterEach(() => {
  setParsedDocumentCacheByteBudgetForTests(DEFAULT_BUDGET);
  clearParsedDocumentCacheForTests();
});

describe('IDE-SNP-007:XML 解析缓存字节预算', () => {
  it('超预算:总字节越线后最旧条目被淘汰,再解析得到新对象', () => {
    setParsedDocumentCacheByteBudgetForTests(10000);
    clearParsedDocumentCacheForTests();
    const textA = makeXml(6000, 'aa');
    const textB = makeXml(6000, 'bb');
    const docA = parseDefDocument(textA);
    parseDefDocument(textB);

    // 12KB > 10KB 预算 → A(最旧)被淘汰,只剩 B
    expect(getParsedDocumentCacheStats().entries).toBe(1);
    expect(parseDefDocument(textA)).not.toBe(docA);
  });

  it('LRU 顺序:近期访问过的条目比更旧条目活得久', () => {
    setParsedDocumentCacheByteBudgetForTests(10000);
    clearParsedDocumentCacheForTests();
    const textA = makeXml(4000, 'aa');
    const textB = makeXml(4000, 'bb');
    const textC = makeXml(4000, 'cc');
    const docA = parseDefDocument(textA);
    parseDefDocument(textB);
    // 刷新 A 的最近使用,再插入 C → 超线应淘汰 B(更旧)而不是 A
    expect(parseDefDocument(textA)).toBe(docA);
    parseDefDocument(textC);

    const stats = getParsedDocumentCacheStats();
    expect(stats.entries).toBe(2);
    expect(stats.bytes).toBeLessThanOrEqual(10000);
    expect(parseDefDocument(textA)).toBe(docA);
  });

  it('单份巨型文档:最多独占一条,不牵连预算内其他条目之外的保留', () => {
    setParsedDocumentCacheByteBudgetForTests(10000);
    clearParsedDocumentCacheForTests();
    const giant = makeXml(30000, 'gg');
    const giantDoc = parseDefDocument(giant);
    parseDefDocument(makeXml(1000, 'ss'));

    // 巨型条目本身超预算 → 插入 1KB 后立即把它挤成只剩 1 条(新条目)
    const stats = getParsedDocumentCacheStats();
    expect(stats.entries).toBe(1);
    expect(parseDefDocument(giant)).not.toBe(giantDoc);
  });

  it('条目上限 8 保持不变:9 份小文档只留 8 条', () => {
    clearParsedDocumentCacheForTests();
    for (let index = 0; index < 9; index += 1) {
      parseDefDocument(makeXml(1000 + index, `s${index}`));
    }
    expect(getParsedDocumentCacheStats().entries).toBe(8);
  });
});
