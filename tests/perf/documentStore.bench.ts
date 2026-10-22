// PR2 文档快照接入前后对比(tests/perf 专用 bench 配置,不进 pnpm test 门禁):
//   npx vitest run --config vitest.bench.config.ts tests/perf/documentStore.bench.ts
//
// 口径:同一份文档、同一段热路径代码,分别用
//   A「接入前」:document.getText().split(/\r?\n/) 每次全文拆行;
//   B「接入后」:documentStore.getDocumentLines() 同版本复用快照行索引;
// 以及 .def 解析面:
//   A「接入前」:parseDefDocument(document.getText()) 每次;
//   B「接入后」:getOrParseDocumentSync('def-ast') 同版本复用。
// document-parse 事件全量走 PR1 埋点,汇总直接读 getOperationSummary。
// 输出行以 PR2-METRIC 前缀打印,便于汇总进 docs/perf/2026-pr2-documentstore.md。

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { Uri, makeTextDocument } from '../fake-vscode/core';
import {
  getDocumentLines,
  getOrParseDocumentSync,
  releaseAllDocumentSnapshots,
  updateDocumentSnapshot
} from '../../src/documentStore';
import { getOperationSummary } from '../../src/languageServiceMetrics';
import { parseDefDocument } from '../../src/defParser';

const ASSETS_OUT = path.join(os.tmpdir(), 'kode-perf-pr2-assets');
const OUT = process.env.KODE_PR2_OUT
  ?? path.resolve(__dirname, '../../docs/perf/pr2-documentstore-run.txt');

const emit = (line: string): void => {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.appendFileSync(OUT, line + '\n');
  console.log(line);
};

const percentile = (samples: number[], rank: number): number => {
  if (samples.length === 0) {
    return 0;
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(rank * sorted.length) - 1));
  return Math.round(sorted[index] * 100) / 100;
};

const metric = (name: string, values: number[]): void => {
  const sorted = [...values].sort((a, b) => a - b);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  emit(
    `PR2-METRIC ${name} n=${values.length} ` +
    `p50=${percentile(values, 0.5)}ms p95=${percentile(values, 0.95)}ms ` +
    `p99=${percentile(values, 0.99)}ms avg=${values.length ? Math.round((total / values.length) * 100) / 100 : 0}ms`
  );
};

interface BenchDoc {
  uri: { toString(): string; fsPath: string };
  version?: number;
  getText(): string;
}

const docFor = (filePath: string, text: string, version: number): BenchDoc => {
  const document = makeTextDocument(text, {
    fileName: filePath,
    languageId: 'python',
    uri: Uri.file(filePath)
  }) as unknown as BenchDoc;
  document.version = version;
  return document;
};

describe('PR2 文档快照接入前后对比(big-py / def-heavy)', () => {
  beforeAll(() => {
    execFileSync('node', [
      path.resolve(__dirname, '../../scripts/generate-perf-assets.mjs'),
      '--out', ASSETS_OUT,
      '--large-files', '0',
      '--keep'
    ], { stdio: 'ignore' });
    emit(`PR2-ENV node=${process.version} platform=${os.platform()} cpus=${os.cpus().length}`);
  });

  afterAll(() => {
    fs.rmSync(ASSETS_OUT, { recursive: true, force: true });
  });

  it('Hover 行准备:接入前 getText().split vs 接入后快照行索引(big-py 8,000 方法)', () => {
    releaseAllDocumentSnapshots();
    const filePath = path.join(ASSETS_OUT, 'big-py', 'scripts/cell/BigEntity.py');
    const text = fs.readFileSync(filePath, 'utf8');
    const document = docFor(filePath, text, 1);
    const rounds = 50;

    // 接入前口径:每次 hover 都全文拆行
    const before: number[] = [];
    for (let i = 0; i < rounds; i += 1) {
      const startedAt = performance.now();
      const lines = document.getText().split(/\r?\n/);
      void lines[positionLine(i)];
      before.push(performance.now() - startedAt);
    }
    metric('hoverLinePrep.before.getTextSplit', before);

    // 接入后口径:建档一次,之后同版本复用行索引
    updateDocumentSnapshot(document);
    const rebuild: number[] = [];
    for (let v = 2; v <= 21; v += 1) {
      document.version = v;
      const startedAt = performance.now();
      updateDocumentSnapshot(document);
      rebuild.push(performance.now() - startedAt);
    }
    metric('hoverLinePrep.after.snapshotRebuildOnEdit', rebuild);

    const after: number[] = [];
    for (let i = 0; i < rounds; i += 1) {
      const startedAt = performance.now();
      const lines = getDocumentLines(document);
      void lines[positionLine(i)];
      after.push(performance.now() - startedAt);
    }
    metric('hoverLinePrep.after.getDocumentLines', after);
  }, 120000);

  it('诊断 def AST:接入前逐次解析 vs 接入后同版本复用(def-heavy 大 .def)', () => {
    releaseAllDocumentSnapshots();
    const filePath = path.join(ASSETS_OUT, 'def-heavy', 'scripts/entity_defs/Unit0.def');
    const text = fs.readFileSync(filePath, 'utf8');
    const document = docFor(filePath, text, 1);

    const rounds = 50;
    const before: number[] = [];
    for (let i = 0; i < rounds; i += 1) {
      const startedAt = performance.now();
      void parseDefDocument(document.getText());
      before.push(performance.now() - startedAt);
    }
    metric('defAst.before.parseEachTime', before);

    const after: number[] = [];
    for (let i = 0; i < rounds; i += 1) {
      const startedAt = performance.now();
      getOrParseDocumentSync(document, parsed => parseDefDocument(parsed), 'def-ast');
      after.push(performance.now() - startedAt);
    }
    metric('defAst.after.getCached', after);

    // 版本前进一次的真实成本(编辑后首次诊断)
    document.version = 2;
    const rebuildStart = performance.now();
    getOrParseDocumentSync(document, parsed => parseDefDocument(parsed), 'def-ast');
    metric('defAst.after.reparseOnEdit', [performance.now() - rebuildStart]);

    const summary = getOperationSummary('document-parse');
    if (summary) {
      emit(
        `PR2-METRIC documentParse.summary count=${summary.count} ` +
        `cacheHits=${summary.cacheHits} cacheMisses=${summary.cacheMisses} ` +
        `hitRate=${summary.cacheHitRate}% p50=${summary.p50Ms}ms p95=${summary.p95Ms}ms`
      );
    }
  }, 120000);

  it('诊断 def AST(合成大文档:300 连拼 .def,量级压力口径)', () => {
    releaseAllDocumentSnapshots();
    const filePath = path.join(ASSETS_OUT, 'def-heavy', 'scripts/entity_defs/Unit0.def');
    const unitText = fs.readFileSync(filePath, 'utf8');
    // 合成口径:真实资产集的单 .def 都很小(基线 §4:单位文件解析非主要矛盾),
    // 这里连拼 300 份构造大文档,只为量出「每次重解析」的真实成本上界。
    const bigText = Array.from({ length: 300 }, (_, i) =>
      unitText.replace(/Unit0/, `Unit0_${i}`)
    ).join('\n');
    const document = docFor(path.join(ASSETS_OUT, 'def-heavy', 'scripts/entity_defs/Big.def'), bigText, 1);
    const rounds = 30;
    const before: number[] = [];
    for (let i = 0; i < rounds; i += 1) {
      const startedAt = performance.now();
      void parseDefDocument(document.getText());
      before.push(performance.now() - startedAt);
    }
    metric('defAstBig.before.parseEachTime', before);
    const after: number[] = [];
    for (let i = 0; i < rounds; i += 1) {
      const startedAt = performance.now();
      getOrParseDocumentSync(document, parsed => parseDefDocument(parsed), 'def-ast');
      after.push(performance.now() - startedAt);
    }
    metric('defAstBig.after.getCached', after);
    document.version = 2;
    const rebuildStart = performance.now();
    getOrParseDocumentSync(document, parsed => parseDefDocument(parsed), 'def-ast');
    metric('defAstBig.after.reparseOnEdit', [performance.now() - rebuildStart]);
  }, 120000);
});

// 取一条中段行,模拟真实 hover 对行数组的消费(避免死代码消除)
function positionLine(round: number): number {
  return 100 + (round % 400);
}
