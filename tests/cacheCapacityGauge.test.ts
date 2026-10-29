import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  clearParsedDocumentCacheForTests,
  getParsedDocumentCacheGauge,
  parseDefDocument,
  setParsedDocumentCacheByteBudgetForTests
} from '../src/defParser';
import { clearDatabaseSchemaCacheForTests, getDatabaseSchemaCacheGauge } from '../src/databaseSchema';
import {
  getReturnAnnotationCacheGauge,
  resetPythonReturnAnnotationCache,
  resolveLocalVariableReturnType
} from '../src/pythonReturnTypeInference';

// IDE-REV-031:相关缓存的容量面接入现场报告——条目数、可获取的占用量与
// 配置上限;填充/淘汰后从量规核对;容量=当前实际持有条目/字节,绝不把
// 累计 cacheHits 当容量;无字节估算的缓存(注解索引)只报条目并注明口径。

const DEFAULT_BUDGET = 8 * 1024 * 1024;

function makeXml(bytes: number, seed = 'a'): string {
  const filler = seed.repeat(2) + 'x'.repeat(Math.max(0, bytes - 42 - seed.length * 2));
  return `<root>\n  <a>${filler}</a>\n</root>`;
}

afterEach(() => {
  setParsedDocumentCacheByteBudgetForTests(DEFAULT_BUDGET);
  clearParsedDocumentCacheForTests();
  clearDatabaseSchemaCacheForTests();
  resetPythonReturnAnnotationCache();
});

describe('缓存容量面(IDE-REV-031)', () => {
  it('def 文档缓存:填充后条目/字节如实,越线 LRU 淘汰后容量可核对', () => {
    expect(getParsedDocumentCacheGauge()).toMatchObject({ entries: 0, maxEntries: 8, maxBytes: DEFAULT_BUDGET });
    // 填满 8 份(默认预算下条目上限先生效)
    for (let i = 0; i < 8; i += 1) {
      parseDefDocument(makeXml(100, `s${i}`));
    }
    expect(getParsedDocumentCacheGauge().entries).toBe(8);

    // 第 9 份:条目上限淘汰最旧,容量停在 8 不越线
    parseDefDocument(makeXml(100, 's9'));
    const capped = getParsedDocumentCacheGauge();
    expect(capped.entries).toBe(8);
    expect(capped.entries).toBeLessThanOrEqual(capped.maxEntries);

    // 字节预算面:收紧预算后越线淘汰,字节回落到预算内
    setParsedDocumentCacheByteBudgetForTests(10000);
    parseDefDocument(makeXml(6000, 'bb'));
    parseDefDocument(makeXml(6000, 'cc'));
    const budgetGauge = getParsedDocumentCacheGauge();
    expect(budgetGauge.maxBytes).toBe(10000);
    expect(budgetGauge.entries).toBe(1);
    expect(budgetGauge.bytes).toBeLessThanOrEqual(budgetGauge.maxBytes);
  });

  it('schema 快照缓存:容量=在册条目数与 LRU 上限,不是累计命中数', () => {
    const gauge = getDatabaseSchemaCacheGauge();
    expect(gauge.capacity).toBe(32);
    expect(typeof gauge.entries).toBe('number');
    // 容量面与命中计数严格分家:量规上根本没有 hits 字段
    expect(Object.keys(gauge).sort()).toEqual(['capacity', 'entries']);
    expect(getDatabaseSchemaCacheGauge().entries).toBe(gauge.entries);
  });

  it('注解索引缓存:按工作区根计条目,口径带 TTL,不臆造字节', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'anno-cache-gauge-'));
    try {
      fs.writeFileSync(path.join(root, 'svc.py'), 'def get_data() -> VAL:\n    pass\n');
      expect(getReturnAnnotationCacheGauge()).toMatchObject({ entries: 0, ttlMs: 3000 });
      await resolveLocalVariableReturnType(['data = get_data()'], 0, 'data', root);
      const warmed = getReturnAnnotationCacheGauge();
      expect(warmed.entries).toBe(1);
      expect(warmed.ttlMs).toBe(3000);
      // 淘汰面:清缓存后条目归零可核对
      resetPythonReturnAnnotationCache();
      expect(getReturnAnnotationCacheGauge().entries).toBe(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('源锁:现场报告两处接入缓存容量面,渲染三缓存口径,不渲染累计命中', async () => {
    const extension = await fs.promises.readFile('src/extension.ts', 'utf8');
    expect(extension.split('caches: {').length).toBe(3);
    expect(extension).toContain('getParsedDocumentCacheGauge()');
    expect(extension).toContain('getDatabaseSchemaCacheGauge()');
    expect(extension).toContain('getReturnAnnotationCacheGauge()');
    const summary = await fs.promises.readFile('src/reproductionSummary.ts', 'utf8');
    expect(summary).toContain('缓存:def文档=');
    expect(summary).toContain('schema快照=');
    expect(summary).toContain('注解索引=');
    expect(summary).toContain('无字节估算');
    // 累计命中计数不进容量面渲染
    expect(summary).not.toContain('cacheHits');
  });
});
