// PR1 基线实测(tests/perf 专用 bench 配置,不进 pnpm test 门禁):
//   npx vitest run --config vitest.bench.config.ts tests/perf/baseline.bench.ts
//
// 按 docs/review/2026-10-22 §2.3 的七场景,在 fake-vscode 桩 + 真实索引实现
// (PythonClassIndex / EntityMappingManager / findFilesAcrossRoots)上量测;
// 资产集由 scripts/generate-perf-assets.mjs 确定性生成(--large-files 可调)。
// 输出行以 BASELINE-METRIC 前缀打印,便于汇总进 docs/perf/2026-baseline.md。
// 本文件只做观测:全部走真实代码路径,不修改任何语言服务行为。

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { Uri, makeTextDocument } from '../fake-vscode/core';
import { workspace as stubWorkspace } from '../fake-vscode/workspaceState';
import {
  getLanguageServiceSummaryReport,
  resetLanguageServiceMetrics
} from '../../src/languageServiceMetrics';
import { EntityMappingManager } from '../../src/entityMapping';
import { PythonClassIndex, PY_SCAN_EXCLUDE } from '../../src/pythonClassIndex';
import {
  findFilesAcrossRoots,
  resetScanRootCache
} from '../../src/scanRoots';

const ASSETS_OUT = path.join(os.tmpdir(), 'kode-perf-baseline-assets');
const LARGE_FILES = Number(process.env.KODE_PERF_LARGE_FILES ?? '30000');

const BASELINE_OUT = process.env.KODE_BASELINE_OUT
  ?? path.resolve(__dirname, '../../docs/perf/baseline-run.txt');
const emit = (line: string): void => {
  fs.mkdirSync(path.dirname(BASELINE_OUT), { recursive: true });
  fs.appendFileSync(BASELINE_OUT, line + '\n');
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
    `BASELINE-METRIC ${name} n=${values.length} ` +
    `p50=${percentile(values, 0.5)}ms p95=${percentile(values, 0.95)}ms ` +
    `p99=${percentile(values, 0.99)}ms max=${sorted[sorted.length - 1] ?? 0}ms ` +
    `avg=${values.length ? Math.round((total / values.length) * 100) / 100 : 0}ms`
  );
};

const once = (name: string, elapsedMs: number): void => {
  emit(`BASELINE-METRIC ${name} n=1 elapsed=${Math.round(elapsedMs * 100) / 100}ms`);
};

interface MinimalDoc {
  fileName: string;
  version?: number;
  getText(): string;
}

const docFor = (filePath: string, text: string, version = 1): MinimalDoc =>
  makeTextDocument(text, { fileName: filePath, languageId: 'python', uri: Uri.file(filePath) }) as unknown as MinimalDoc;

const readPy = (filePath: string): string => fs.readFileSync(filePath, 'utf8');

const sampleQueries = (index: PythonClassIndex, names: string[], rounds: number): number[] => {
  const samples: number[] = [];
  for (let round = 0; round < rounds; round += 1) {
    for (const name of names) {
      const startedAt = performance.now();
      void index.findClassesByName(name);
      samples.push(performance.now() - startedAt);
    }
  }
  return samples;
};

describe('PR1 基线七场景(fake-vscode + 真实索引实现)', () => {
  let largeRoot = '';
  let multiRoot = '';
  let defHeavyRoot = '';
  let bigPyRoot = '';
  let noiseRoot = '';

  beforeAll(() => {
    execFileSync('node', [
      path.resolve(__dirname, '../../scripts/generate-perf-assets.mjs'),
      '--out', ASSETS_OUT,
      '--large-files', String(LARGE_FILES),
      '--keep'
    ], { stdio: 'inherit' });
    largeRoot = path.join(ASSETS_OUT, 'large');
    multiRoot = path.join(ASSETS_OUT, 'multi-root');
    defHeavyRoot = path.join(ASSETS_OUT, 'def-heavy');
    bigPyRoot = path.join(ASSETS_OUT, 'big-py');
    noiseRoot = path.join(ASSETS_OUT, 'noise');
    emit(
      `BASELINE-ENV node=${process.version} platform=${os.platform()} ` +
      `cpus=${os.cpus().length} largeFiles=${LARGE_FILES} assets=${ASSETS_OUT}`
    );
  });

  afterAll(() => {
    fs.rmSync(ASSETS_OUT, { recursive: true, force: true });
  });

  const pointWorkspaceAt = (root: string): void => {
    resetScanRootCache();
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
    const walk = (dir: string, suffix: string): string[] => {
      const found: string[] = [];
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return found;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== '.git' && entry.name !== 'build' && entry.name !== 'third_party') {
            found.push(...walk(full, suffix));
          }
        } else if (entry.isFile() && entry.name.endsWith(suffix)) {
          found.push(full);
        }
      }
      return found;
    };
    stubWorkspace.findFiles = async (pattern: unknown): Promise<Uri[]> => {
      const glob = String(pattern);
      const match = /\*\.(\w+)$/.exec(glob);
      if (!match) {
        return [];
      }
      return walk(stubWorkspace.workspaceFolders?.[0]?.uri.fsPath ?? '', `.${match[1]}`)
        .map(file => Uri.file(file));
    };
  };

  it('场景1+2:冷启动首次索引 → 索引就绪后重复查询(large)', async () => {
    pointWorkspaceAt(largeRoot);
    const index = new PythonClassIndex();
    let coldStarted = performance.now();
    await index.findClassesByName('Avatar');
    const coldMs = performance.now() - coldStarted;
    once('S1.large.coldFindClassesByName', coldMs);

    // 同实现把全量扫描装进 python-index-scan 事件(含 file-discovery/document-parse)
    const discovery = await findFilesAcrossRoots('**/*.py', PY_SCAN_EXCLUDE);
    once('S1.large.pyFilesDiscovered', discovery.length);

    // 场景2:索引就绪后重复类名查询(热缓存)
    const classNames = ['Avatar', 'Gen0', 'Gen100', 'Gen5000', 'Gen12345'];
    metric('S2.large.warmFindClassesByName', sampleQueries(index, classNames, 40));

    const mroSamples: number[] = [];
    for (let i = 0; i < 40; i += 1) {
      const startedAt = performance.now();
      await index.computeMRO('Avatar');
      mroSamples.push(performance.now() - startedAt);
    }
    metric('S2.large.warmComputeMRO', mroSamples);
  }, 240000);

  it('场景1b:entity-mapping 冷启动首扫 + 热复扫(def-heavy)', async () => {
    pointWorkspaceAt(defHeavyRoot);
    resetLanguageServiceMetrics();
    let started = performance.now();
    const manager = new EntityMappingManager({ subscriptions: [] });
    await manager.waitForInitialScan();
    once('S1.defHeavy.entityMappingColdScan', performance.now() - started);

    // 热复扫:清空映射索引后重走全量扫描(模拟 .def 变更后的整表失效路径),
    // mtime 缓存让重复解析显著快于冷扫
    const probe = manager as unknown as {
      mappingIndexes: Map<string, unknown>;
      scanEntityMappings(): Promise<void>;
    };
    probe.mappingIndexes.clear();
    started = performance.now();
    await probe.scanEntityMappings();
    once('S5.defHeavy.entityMappingWarmRescan', performance.now() - started);
  }, 240000);

  it('场景3+4:打开未索引文件后首次查询 / 编辑当前文件后查询(big-py)', async () => {
    pointWorkspaceAt(bigPyRoot);
    const index = new PythonClassIndex();
    await index.findClassesByName('BigEntity'); // 预热全量索引

    // 场景3:磁盘上新文件(未索引)落盘后第一次查询
    const freshFile = path.join(bigPyRoot, 'scripts/cell/FreshEntity.py');
    const freshText = 'class FreshEntity:\n    def ignite(self):\n        return 1\n';
    fs.writeFileSync(freshFile, freshText);
    const freshDoc = docFor(freshFile, freshText);
    let started = performance.now();
    await index.onDocumentChanged(freshDoc as never);
    await index.findEnclosingClass(freshFile, 0);
    once('S3.bigPy.firstQueryNewFile', performance.now() - started);

    // 场景4:编辑当前文件(版本+1)后查询局部变量归属
    const bigFile = path.join(bigPyRoot, 'scripts/cell/BigEntity.py');
    const originalText = readPy(bigFile);
    const editedText = originalText.replace(
      'class BigEntity:',
      'class BigEntity:\n    def appended_after_edit(self):\n        payload_99 = loader.fetch(99)\n        return payload_99'
    );
    const editedDoc = docFor(bigFile, editedText, 2);
    const editSamples: number[] = [];
    for (let round = 0; round < 20; round += 1) {
      started = performance.now();
      await index.onDocumentChanged(editedDoc as never);
      await index.resolveClassBase(editedDoc as never, 'payload_99', 1);
      editSamples.push(performance.now() - started);
    }
    metric('S4.bigPy.queryAfterDocumentEdit', editSamples);
  }, 240000);

  it('场景6:删除文件后旧索引项不再命中(large)', async () => {
    pointWorkspaceAt(largeRoot);
    const index = new PythonClassIndex();
    await index.findClassesByName('Avatar');
    const victim = path.join(largeRoot, 'scripts/base/gen/m0/Gen0.py');
    fs.rmSync(victim, { force: true });
    const started = performance.now();
    await index.onFileChanged(victim);
    const invalidateMs = performance.now() - started;
    once('S6.large.fileDeleteInvalidation', invalidateMs);
    const remaining = await index.findClassesByName('Gen0');
    once('S6.large.deletedClassHits', remaining.length);
  }, 240000);

  it('场景7:多请求并发(multi-root 同名实体/同名类)', async () => {
    pointWorkspaceAt(multiRoot);
    const index = new PythonClassIndex();
    await index.findClassesByName('Avatar'); // 冷启动完成后进入并发段

    const started = performance.now();
    const concurrent = await Promise.all(Array.from({ length: 60 }, () =>
      index.findClassesByName('Inventory')));
    once('S7.multiRoot.concurrent60FindInventory.wall', performance.now() - started);
    const totalHits = concurrent.reduce((sum, hits) => sum + hits.length, 0);
    once('S7.multiRoot.concurrent60FindInventory.totalHits', totalHits);

    const rootSamples: number[] = [];
    for (let i = 0; i < 20; i += 1) {
      const t = performance.now();
      await index.rootsContaining('Inventory');
      rootSamples.push(performance.now() - t);
    }
    metric('S7.multiRoot.rootsContaining', rootSamples);
  }, 240000);

  it('场景8(噪声):排除式目录不进索引(noise)', async () => {
    pointWorkspaceAt(noiseRoot);
    resetLanguageServiceMetrics();
    const index = new PythonClassIndex();
    const started = performance.now();
    await index.findClassesByName('Avatar');
    once('S8.noise.coldScanWithExcludes', performance.now() - started);
    const leaked = await index.findClassesByName('Obj7');
    once('S8.noise.excludedDirClassHits', leaked.length);
    emit('BASELINE-METRICS-REPORT\n' + getLanguageServiceSummaryReport());
  }, 240000);
});
