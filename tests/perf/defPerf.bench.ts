import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { beforeAll, describe, expect, it } from 'vitest';
import type { IGrammar, IRawGrammar } from 'vscode-textmate';
import { INITIAL, Registry } from 'vscode-textmate';
import { createOnigScanner, createOnigString, loadWASM } from 'vscode-oniguruma';
import { parseDefDocument } from '../../src/defParser';
import { analyzeDefDocument, formatDefAnalysisReport } from '../../src/defAnalyzer';
import { buildLargeDefFixture } from '../helpers/largeDefFixture';

// 批92 性能基准(大 .def 解析/诊断/高亮三条路径)。运行方式:
//   npx vitest run --config vitest.bench.config.ts
// 输出的中位数毫秒是 TESTING.md 批92 前后对照的原始数字。fixture 取
// tests/helpers/largeDefFixture.ts(确定性生成,无随机),同一台机器上
// before/after 可比;断言只锁正确性,不做计时断言(门禁内计时断言易受
// 负载抖动,非交互环境按批72 口径记账)。

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const largeDef = buildLargeDefFixture();

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

const RUNS = 9;
const WARMUPS = 2;

const bench = (name: string, fn: () => void): number => {
  for (let i = 0; i < WARMUPS; i += 1) {
    fn();
  }
  const samples: number[] = [];
  for (let i = 0; i < RUNS; i += 1) {
    const start = performance.now();
    fn();
    samples.push(performance.now() - start);
  }
  const mid = median(samples);
  console.log(
    `BENCH ${name} size=${(largeDef.length / 1024).toFixed(1)}KB runs=${RUNS} median=${mid.toFixed(1)}ms p95=${Math.max(...samples).toFixed(1)}ms`
  );
  return mid;
};

describe('性能基准:大 .def 三路径(批92)', () => {
  it('解析路径 parseDefDocument', () => {
    let nodes = 0;
    const ms = bench('parseDefDocument', () => {
      const document = parseDefDocument(largeDef);
      nodes = document.nodes.length;
    });
    expect(nodes).toBeGreaterThan(0);
    expect(ms).toBeGreaterThanOrEqual(0);
  });

  it('建议路径 analyzeDefDocument + 报告格式化', () => {
    let findings: ReturnType<typeof analyzeDefDocument> = [];
    let reportLength = 0;
    const ms = bench('analyzeDefDocument', () => {
      findings = analyzeDefDocument(largeDef);
      reportLength = formatDefAnalysisReport('big.def', findings).length;
    });
    // broken* 幻影类型样本应被发现(fixture 自带)
    expect(findings.length).toBeGreaterThan(0);
    expect(reportLength).toBeGreaterThan(0);
    expect(ms).toBeGreaterThanOrEqual(0);
  });

  it('诊断路径 validateDocument(语言服务)', async () => {
    const { validateDocument } = await import('../../src/languageProviders');
    const { languages } = await import('../fake-vscode/languages');
    const { makeTextDocument } = await import('../fake-vscode/core');

    const document = makeTextDocument(largeDef, { fileName: '/tmp/bench-large.def' });
    const collection = languages.createDiagnosticCollection('bench');

    let diagnosticCount = 0;
    const ms = bench('validateDocument', () => {
      validateDocument(document as never, collection as never);
      diagnosticCount = collection.get(document.uri).length;
    });
    expect(ms).toBeGreaterThanOrEqual(0);
    console.log(`BENCH validateDocument.diagnostics=${diagnosticCount}`);
  });

  describe('高亮路径 tmLanguage tokenizeLine', () => {
    let grammar: IGrammar;
    const lineCount = largeDef.split('\n').length;

    beforeAll(async () => {
      const grammarJson = JSON.parse(
        fs.readFileSync(path.join(root, 'syntaxes', 'kbengine.tmLanguage.json'), 'utf8')
      ) as IRawGrammar;
      const wasm = fs.readFileSync(
        path.join(root, 'node_modules', 'vscode-oniguruma', 'release', 'onig.wasm')
      );
      await loadWASM(
        wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) as ArrayBuffer
      );
      const registry = new Registry({
        onigLib: Promise.resolve({
          createOnigScanner: (sources: string[]) => createOnigScanner(sources),
          createOnigString: (source: string) => createOnigString(source)
        }),
        loadGrammar: async scopeName =>
          scopeName === 'source.kbengine-def' ? grammarJson : null
      });
      const loaded = await registry.loadGrammar('source.kbengine-def');
      if (!loaded) {
        throw new Error('grammar load failed');
      }
      grammar = loaded;
    });

    it('tokenizeDoc(全文件逐行分词)', () => {
      const lines = largeDef.split('\n');
      let tokenTotal = 0;
      const ms = bench('tmLanguage.tokenizeDoc', () => {
        let stack = INITIAL;
        tokenTotal = 0;
        for (const line of lines) {
          const result = grammar.tokenizeLine(line, stack);
          stack = result.ruleStack;
          tokenTotal += result.tokens.length;
        }
      });
      expect(tokenTotal).toBeGreaterThan(lineCount);
      expect(ms).toBeGreaterThanOrEqual(0);
    });
  });
});
