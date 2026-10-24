// 书 PR-002 ②:hover 冷启动实测(tests/perf 专用 bench 配置,不进 pnpm test 门禁):
//   KODE_PERF_LARGE_FILES=30000 npx vitest run --config vitest.bench.config.ts tests/perf/coldHover.bench.ts
//
// 背景(AUDIT-007/PERF-005 遗留):hover 冷启动在首扫在途时走定向解析,
// 等不到才被 hover.asyncBudgetMs(2500ms)/initial-scan 5s 兜底放行;基线 §6
// 一直缺冷悬停数字。本 bench 用 PR1 资产集(large,30k .py)量测:
//   H1 首扫在途冷悬停(before):manager 构造即悬停,首扫未完成;
//   H2 首扫完成时点(扫描本体耗时,对照 PR1 S1 口径的 .def 侧);
//   H3 首扫完成后同点悬停(after);
//   H4 热悬停分布(40 次,p50/p95/p99)。
// 输出行以 HOVER-METRIC 前缀打印并落 docs/perf/cold-hover-run.txt。

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'perf_hooks';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { Position, Uri, makeTextDocument } from '../fake-vscode/core';
import { workspace as stubWorkspace } from '../fake-vscode/workspaceState';
import { KBEngineHoverProvider } from '../../src/languageProviders';
import { EntityMappingManager } from '../../src/entityMapping';
import { IndexScheduler } from '../../src/indexScheduler';
import { resetScanRootCache } from '../../src/scanRoots';
import { preheatDiscoveryScan, resetDiscoveryState } from '../../src/workspaceDiscovery';

const ASSETS_OUT = path.join(os.tmpdir(), 'kode-perf-hover-assets');
const LARGE_FILES = Number(process.env.KODE_PERF_LARGE_FILES ?? '30000');

const OUT_FILE = process.env.KODE_HOVER_OUT
  ?? path.resolve(__dirname, '../../docs/perf/cold-hover-run.txt');
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
  emit(
    `HOVER-METRIC ${name} n=${values.length} ` +
    `p50=${percentile(values, 0.5)}ms p95=${percentile(values, 0.95)}ms ` +
    `p99=${percentile(values, 0.99)}ms max=${Math.max(...values)}ms`
  );
};

const once = (name: string, value: number, unit = 'ms'): void => {
  emit(`HOVER-METRIC ${name} n=1 ${Math.round(value * 100) / 100}${unit}`);
};

describe('书 PR-002 ②:hover 冷启动(large 30k)', () => {
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
    emit(`HOVER-ENV node=${process.version} cpus=${os.cpus().length} largeFiles=${LARGE_FILES}`);
  }, 600000);

  afterAll(() => {
    fs.rmSync(ASSETS_OUT, { recursive: true, force: true });
    stubWorkspace.workspaceFolders = [];
  });

  it('H1-H4:首扫在途冷悬停 → 扫描收尾 → 热悬停', async () => {
    // 大集脚手架的 Avatar.def 声明 onRpc0..3 而 Avatar.py 只有 onEnterWorld
    // (生成器口径),def 方法标注链需要「py 方法名 = def 声明方法」才进闸。
    // 这里覆写 Avatar.py 补 onRpc0(py 侧签名 self+1 参 = def args=UInt32,
    // 过形参闸),30k 文件树其余部分不动。
    const avatarPath = path.join(largeRoot, 'scripts', 'base', 'Avatar.py');
    fs.writeFileSync(
      avatarPath,
      'class Avatar:\n    def onEnterWorld(self):\n        return 0\n\n    def onRpc0(self, arg):\n        return arg\n',
      'utf8'
    );

    const managerConstructionAt = performance.now();
    const scheduler = new IndexScheduler();
    const manager = new EntityMappingManager({ subscriptions: [] } as never, scheduler);
    const provider = new KBEngineHoverProvider(manager);

    const document = makeTextDocument(
      fs.readFileSync(avatarPath, 'utf8'),
      { fileName: avatarPath, languageId: 'python' }
    );
    // onRpc0 方法名上(第 5 行,字符 13 落在方法名内)
    const position = new Position(4, 13);

    // H1:首扫在途冷悬停(before)。manager 构造后首扫经 setImmediate 才入队,
    // 立即连发 5 次悬停——全部落在首扫窗口内,记录逐次延迟。
    const coldSamples: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const started = performance.now();
      const hover = await provider.provideHover(document, position);
      coldSamples.push(performance.now() - started);
      if (i === 0) {
        once('H1.large.coldHoverFirstAnnotationHits', hover ? 1 : 0, ' hit');
      }
    }
    metric('H1.large.coldHoverDuringInitialScan', coldSamples);

    // H2:首扫收尾(构造期入队 → 完成,含 .def 枚举 walk + 解析)
    await manager.waitForInitialScan();
    once('H2.large.initialScanCompletion', performance.now() - managerConstructionAt);

    // H3:首扫完成后同点悬停(after)
    const afterStarted = performance.now();
    const afterHover = await provider.provideHover(document, position);
    once('H3.large.hoverAfterInitialScan', performance.now() - afterStarted);
    once('H3.large.hoverAfterInitialScanHits', afterHover ? 1 : 0, ' hit');

    // H4:热悬停分布
    const warm: number[] = [];
    for (let i = 0; i < 40; i += 1) {
      const started = performance.now();
      await provider.provideHover(document, position);
      warm.push(performance.now() - started);
    }
    metric('H4.large.warmHover', warm);

    manager.dispose();

    // H5:激活期预热后的冷悬停(书 PR-002 ③):深扫描缓存激活期已付,
    // 冷悬停不再在交互路径付有界 walk——对照 H1 首样本。
    resetDiscoveryState();
    preheatDiscoveryScan(largeRoot);
    const preheatedScheduler = new IndexScheduler();
    const preheatedManager = new EntityMappingManager(
      { subscriptions: [] } as never,
      preheatedScheduler
    );
    const preheatedProvider = new KBEngineHoverProvider(preheatedManager);
    const preheatedStarted = performance.now();
    const preheatedHover = await preheatedProvider.provideHover(document, position);
    once('H5.large.coldHoverAfterPreheat', performance.now() - preheatedStarted);
    once('H5.large.coldHoverAfterPreheatHits', preheatedHover ? 1 : 0, ' hit');
    preheatedManager.dispose();
  }, 600000);
});
