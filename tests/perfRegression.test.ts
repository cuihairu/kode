import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { INITIAL, Registry } from 'vscode-textmate';
import type { IGrammar, IRawGrammar, IToken } from 'vscode-textmate';
import { createOnigScanner, createOnigString, loadWASM } from 'vscode-oniguruma';
import { parseDefDocument } from '../src/defParser';
import { analyzeDefDocument, formatDefAnalysisReport } from '../src/defAnalyzer';
import { validateDocument } from '../src/languageProviders';
import { languages } from './fake-vscode/languages';
import { makeTextDocument } from './fake-vscode/core';
import { workspaceState } from './fake-vscode/workspaceState';
import { buildLargeDefFixture } from './helpers/largeDefFixture';

// 批92 性能优化行为回归锁:确定性大 .def(~170KB,800 属性 + 600 方法 + 缺陷
// 样本)在三条路径上的完整行为摘要——语法分词 token 流、语言服务诊断、
// defAnalyzer 建议——用 djb2 摘要固化。优化(语法规则消重编译、诊断单次解析)
// 必须保持这些摘要逐位不变;任何 scope/诊断/建议漂移都会在此失败。
// golden 取自优化前实现(批92 记账时以本文件为对照);批96 defAnalyzer 引擎
// 复核(客户端可见旗标集对齐 ENTITY_CLIENT_DATA_FLAGS + 检查口径改写)后,
// 建议 goldens 重取(220→620:夹具里 CELL_PUBLIC|ANY_CLIENTS 与
// BASE_PUBLIC|CELL_PUBLIC 两类旗标的 DetailLevel 由漏转报),其余路径不变。

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const djb2 = (input: string): string => {
  let hash = 5381;
  for (let i = 0; i < input.length; i += 1) {
    hash = ((hash * 33) ^ input.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
};

const fixture = buildLargeDefFixture();

// 批96 defAnalyzer 引擎对齐后的行为摘要
const GOLDEN = {
  tokenCount: 47726,
  tokenDigest: 'c3c0cf5f',
  diagnosticCount: 400,
  diagnosticDigest: '910801f9',
  findingCount: 620,
  findingDigest: '827fa39f',
  reportDigest: '77945013',
  astNodes: 1,
  astLineStarts: 7291,
  astRootChildren: 11
};

describe('批92 性能优化行为回归锁(大 .def 三路径 golden)', () => {
  beforeEach(() => {
    workspaceState.reset();
  });

  it('语法分词 token 流逐位不变(47726 tokens 摘要锁)', async () => {
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
    const grammar: IGrammar | null = await registry.loadGrammar('source.kbengine-def');
    expect(grammar, '语法应可加载').toBeTruthy();

    const lines = fixture.split('\n');
    let stack = INITIAL;
    const parts: string[] = [];
    let tokenCount = 0;
    for (const line of lines) {
      const result = grammar!.tokenizeLine(line, stack);
      stack = result.ruleStack;
      for (const token of result.tokens as IToken[]) {
        parts.push(`${token.startIndex}-${token.endIndex}:${token.scopes.join(' ')}`);
        tokenCount += 1;
      }
    }

    expect(tokenCount).toBe(GOLDEN.tokenCount);
    expect(djb2(parts.join('|'))).toBe(GOLDEN.tokenDigest);
  }, 120000);

  it('语言服务诊断逐条不变(400 条消息/区间/严重度摘要锁)', () => {
    const document = makeTextDocument(fixture, { fileName: '/tmp/bench-large.def' });
    const collection = languages.createDiagnosticCollection('perf-regression');
    validateDocument(document as never, collection as never);
    const diagnostics = collection.get(document.uri);
    const parts = diagnostics.map(
      item =>
        `${item.message}@${item.range.start.line},${item.range.start.character}` +
        `-${item.range.end.line},${item.range.end.character}#${item.severity}`
    );

    expect(diagnostics).toHaveLength(GOLDEN.diagnosticCount);
    expect(djb2(parts.join('|'))).toBe(GOLDEN.diagnosticDigest);
  });

  it('defAnalyzer 建议与报告逐条不变(220 条摘要锁)', () => {
    const findings = analyzeDefDocument(fixture);
    const parts = findings.map(
      item =>
        `${item.check}|${item.severity}|${item.line}|${item.offset}|${item.length}` +
        `|${item.message}|${item.name}`
    );
    expect(findings).toHaveLength(GOLDEN.findingCount);
    expect(djb2(parts.join('|'))).toBe(GOLDEN.findingDigest);

    const report = formatDefAnalysisReport('golden.def', findings);
    expect(djb2(report)).toBe(GOLDEN.reportDigest);
  });

  it('解析结构摘要不变(节点数/行表/根子节点)', () => {
    const document = parseDefDocument(fixture);
    expect(document.nodes).toHaveLength(GOLDEN.astNodes);
    expect(document.lineStarts).toHaveLength(GOLDEN.astLineStarts);
    // 根子节点 11 = 5 个区块元素 + 6 段区块间文本节点
    expect(document.root?.children).toHaveLength(GOLDEN.astRootChildren);
    expect(document.root?.children.filter(child => child.kind === 'element')).toHaveLength(5);
  });
});
