// PR5 去全仓阻塞实测(tests/perf 专用 bench 配置,不进 pnpm test 门禁):
//   KODE_PERF_LARGE_FILES=30000 npx vitest run --config vitest.bench.config.ts tests/perf/unblockedDefinition.bench.ts
//
// 对照 PR1 基线(docs/perf/2026-baseline.md S1=107,737ms 冷启动首次类名查询,
// 即「首次 Definition 被全量 .py 索引阻塞」的量化)量测:
//   U1 大仓冷启动 Definition 首查(首扫在途,不等待)——PR5 主指标;
//   U2 首查后后台全量扫描收尾耗时(对照 PR1 S1,验证扫描本体未退化);
//   U3 索引就绪后 Definition 重复查询分布(热路径);
//   U4 全量口径 API(等扫描)首查耗时(与 PR1 S1 同口径对照)。
// 输出行以 UNBLOCKED-METRIC 前缀打印,汇总进 docs/perf/2026-pr5-unblocked-definition.md。

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { Uri } from '../fake-vscode/core';
import { workspace as stubWorkspace } from '../fake-vscode/workspaceState';
import { PythonClassIndex } from '../../src/pythonClassIndex';
import { IndexScheduler } from '../../src/indexScheduler';
import { resetScanRootCache } from '../../src/scanRoots';

const ASSETS_OUT = path.join(os.tmpdir(), 'kode-perf-unblocked-assets');
const LARGE_FILES = Number(process.env.KODE_PERF_LARGE_FILES ?? '30000');

const OUT_FILE = process.env.KODE_UNBLOCKED_OUT
  ?? path.resolve(__dirname, '../../docs/perf/unblocked-definition-run.txt');
const emit = (line: string): void => {
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.appendFileSync(OUT_FILE, line + '\n');
  console.log(line);
};

const percentile = (samples: number[], rank: number): number => {
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(rank * sorted.length) - 1));
  return Math.round(sorted[index] * 100) / 100;
};

const metric = (name: string, values: number[]): void => {
  const sorted = [...values].sort((a, b) => a - b);
  emit(
    `UNBLOCKED-METRIC ${name} n=${values.length} ` +
    `p50=${percentile(values, 0.5)}ms p95=${percentile(values, 0.95)}ms ` +
    `p99=${percentile(values, 0.99)}ms max=${sorted[sorted.length - 1] ?? 0}ms`
  );
};

const once = (name: string, value: number, unit = 'ms'): void => {
  emit(`UNBLOCKED-METRIC ${name} n=1 ${Math.round(value * 100) / 100}${unit}`);
};

describe('PR5 去全仓阻塞:冷启动 Definition 首查(large)', () => {
  let largeRoot = '';

  beforeAll(() => {
    execFileSync('node', [
      path.resolve(__dirname, '../../scripts/generate-perf-assets.mjs'),
      '--out', ASSETS_OUT,
      '--large-files', String(LARGE_FILES),
      '--keep'
    ], { stdio: 'inherit' });
    largeRoot = path.join(ASSETS_OUT, 'large');
    resetScanRootCache();
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(largeRoot), name: 'ws', index: 0 }];
    stubWorkspace.findFiles = (async (pattern: unknown): Promise<Uri[]> => {
      const glob = String(pattern);
      const match = /\*\.(\w+)$/.exec(glob);
      if (!match) {
        return [];
      }
      const suffix = `.${match[1]}`;
      const out: Uri[] = [];
      const walk = (dir: string): void => {
        let entries: fs.Dirent[] = [];
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            walk(full);
          } else if (entry.isFile() && entry.name.endsWith(suffix)) {
            out.push(Uri.file(full));
          }
        }
      };
      walk(largeRoot);
      return out;
    }) as typeof stubWorkspace.findFiles;
    emit(`UNBLOCKED-ENV node=${process.version} cpus=${os.cpus().length} largeFiles=${LARGE_FILES}`);
  });

  afterAll(() => {
    fs.rmSync(ASSETS_OUT, { recursive: true, force: true });
    stubWorkspace.workspaceFolders = [];
  });

  it('U1-U3:冷启动 Definition 首查 → 后台收尾 → 热查询', async () => {
    const scheduler = new IndexScheduler();
    const index = new PythonClassIndex(scheduler);
    const avatarPath = path.join(largeRoot, 'scripts/base/Avatar.py');

    // U1:冷启动首查(首扫仅在途,不等待全量)——Definition 主形态
    // (large 根脚手架 Avatar 定义 onEnterWorld,见 scripts/generate-perf-assets.mjs)
    const coldStarted = performance.now();
    const coldHit = await index.resolveSelfMethodCandidates(avatarPath, 1, 'onEnterWorld');
    const coldMs = performance.now() - coldStarted;
    once('U1.large.coldDefinitionFirstQuery', coldMs);
    once('U1.large.coldDefinitionFirstQueryHits', coldHit.length);

    // U2:后台全量收尾(对照 PR1 S1=107,737ms 的扫描本体口径)
    const scanStarted = performance.now();
    await index.waitForInitialScan();
    const scanMs = performance.now() - scanStarted;
    once('U2.large.backgroundScanCompletion', scanMs);

    // U3:热路径重复 Definition 查询
    const warm: number[] = [];
    for (let i = 0; i < 40; i += 1) {
      const started = performance.now();
      const hit = await index.resolveSelfMethodCandidates(avatarPath, 1, 'onEnterWorld');
      warm.push(performance.now() - started);
      if (i === 0 && hit.length === 0) {
        emit('UNBLOCKED-METRIC U3.large.warmDefinitionHits n=1 0');
      }
    }
    metric('U3.large.warmDefinitionQuery', warm);
  }, 600000);

  it('U4:全量口径 API 冷启动首查(等扫描,与 PR1 S1 同口径)', async () => {
    const index = new PythonClassIndex();
    const started = performance.now();
    const classes = await index.findClassesByName('Avatar');
    const elapsed = performance.now() - started;
    once('U4.large.coldFindClassesByName', elapsed);
    once('U4.large.coldFindClassesByNameHits', classes.length);
  }, 600000);
});
