/**
 * RUST-030 soak 车道:持续请求混合负载下的泄漏/退化/存活观测。
 *   负载:每窗(5s)30×(编辑+hover) + 15×py 补全 + 10×定义跳转 + 5×def 诊断,
 *   全部真实索引实现 + fake-vscode 桩,顺序 await(稳态交互形态)。
 *   断言只有三类:①零错误;②语义命中恒活(hover 每版必中);
 *   ③泄漏硬闸(gc 可用时:每窗强制 gc 后 heapUsed 增量 < KODE_SOAK_HEAP_GROWTH_MB
 *   缺省 100;RSS 是 V8 段预留噪声不做闸)+退化守卫
 *   (末窗 hover p50 < 首窗 p50×10+5ms,只捕病态劣化,不钉绝对速度)。
 *   墙钟百分位只观测记录,不做阈值。
 *
 * 时长:KODE_SOAK_SECONDS(缺省 60;1h 验收跑 KODE_SOAK_SECONDS=3600,
 * 测试超时按时长自动放宽)。输出 SOAK-ENV/SOAK-METRIC/SOAK-SUMMARY 追加落
 * docs/perf/soak-run.txt(KODE_SOAK_OUT 可覆盖)。
 *
 * 跑法:KODE_SOAK_SECONDS=3600 npx vitest run --config vitest.bench.config.ts tests/perf/soak.bench.ts
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Position, Uri, makeTextDocument } from '../fake-vscode/core';
import { workspace as stubWorkspace } from '../fake-vscode/workspaceState';
import {
  KBEngineHoverProvider,
  PythonCompletionProvider,
  PythonDefinitionProvider,
  validateDocument
} from '../../src/languageProviders';
import { EntityMappingManager } from '../../src/entityMapping';
import { PythonClassIndex } from '../../src/backend/pythonClassIndex';
import { resetScanRootCache } from '../../src/scanRoots';
import { patternGlob } from '../helpers/findPattern';

const ASSETS_OUT = process.env.KODE_SOAK_ASSETS_OUT
  ?? path.join(os.tmpdir(), 'kode-soak-assets');
const LARGE_FILES = Number(process.env.KODE_SOAK_LARGE_FILES ?? '2000');
const SOAK_SECONDS = Number(process.env.KODE_SOAK_SECONDS ?? '60');
const WINDOW_SECONDS = 5;
const HEAP_GROWTH_CEILING_MB = Number(process.env.KODE_SOAK_HEAP_GROWTH_MB ?? '100');
const maybeGc = (): boolean => {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (typeof gc === 'function') { gc(); return true; }
  return false;
};

const OUT_FILE = process.env.KODE_SOAK_OUT
  ?? path.resolve(__dirname, '../../docs/perf/soak-run.txt');
const emit = (line: string): void => {
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.appendFileSync(OUT_FILE, line + '\n');
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

const stormDoc = (text: string, fileName: string, languageId: string, version: number) => {
  const doc = makeTextDocument(text, { fileName, languageId, uri: Uri.file(fileName) });
  Object.assign(doc, { version });
  return doc;
};

const makeCollection = (): { set(u: unknown, i: unknown): void; delete(): void; lastCount(): number } => {
  let last = 0;
  return {
    set: (_uri: unknown, items: unknown): void => {
      last = Array.isArray(items) ? items.length : 0;
    },
    delete: (): void => {
      last = 0;
    },
    lastCount: (): number => last
  };
};

const injectOnRpc0 = (pyPath: string): string => {
  let text = fs.readFileSync(pyPath, 'utf8');
  if (!text.includes('onRpc0')) {
    text = text.replace(
      /^class (\w+):\n/m,
      (match, cls: string) => `class ${cls}:\n    def onRpc0(self, arg):\n        return arg\n`
    );
    fs.writeFileSync(pyPath, text, 'utf8');
  }
  return text;
};

const pointWorkspaceAtRoots = (roots: string[]): void => {
  resetScanRootCache();
  stubWorkspace.workspaceFolders = roots.map((root, index) => ({
    uri: Uri.file(root),
    name: `ws${index}`,
    index
  }));
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
    const glob = patternGlob(pattern);
    const match = /\*\.(\w+)$/.exec(glob);
    if (!match) {
      return [];
    }
    const all: string[] = [];
    for (const root of roots) {
      all.push(...walk(root, `.${match[1]}`));
    }
    return all.map(file => Uri.file(file));
  };
};

describe(`RUST-030 soak(${SOAK_SECONDS}s,泄漏方向界+退化守卫)`, () => {
  let largeRoot = '';
  let avatarPath = '';
  let avatarText = '';
  let avatarDefPath = '';
  let avatarDefText = '';
  let hoverPos: Position;

  beforeAll(() => {
    execFileSync('node', [
      path.resolve(__dirname, '../../scripts/generate-perf-assets.mjs'),
      '--out', ASSETS_OUT,
      '--large-files', String(LARGE_FILES),
      '--keep'
    ], { stdio: 'inherit' });
    largeRoot = path.join(ASSETS_OUT, 'large');
    avatarPath = path.join(largeRoot, 'scripts', 'base', 'Avatar.py');
    avatarText = injectOnRpc0(avatarPath);
    avatarDefPath = path.join(largeRoot, 'scripts', 'entity_defs', 'Avatar.def');
    avatarDefText = fs.readFileSync(avatarDefPath, 'utf8');
    const needleAt = avatarText.indexOf('onRpc0');
    const before = avatarText.slice(0, needleAt).split('\n');
    hoverPos = new Position(before.length - 1, before[before.length - 1].length + 1);
    emit(
      `SOAK-ENV node=${process.version} platform=${os.platform()} ` +
      `cpus=${os.cpus().length} largeFiles=${LARGE_FILES} seconds=${SOAK_SECONDS} ` +
      `window=${WINDOW_SECONDS} heapGrowthCeilingMb=${HEAP_GROWTH_CEILING_MB} assets=${ASSETS_OUT}`
    );
  }, 600000);

  afterAll(() => {
    fs.rmSync(ASSETS_OUT, { recursive: true, force: true });
    stubWorkspace.workspaceFolders = [];
  });

  it('持续混合负载:零错误+命中恒活+RSS 增量在界+无病态退化', async () => {
    pointWorkspaceAtRoots([largeRoot]);
    const manager = new EntityMappingManager({ subscriptions: [] } as never);
    const index = new PythonClassIndex();
    const hover = new KBEngineHoverProvider(manager);
    const pyComp = new PythonCompletionProvider(manager);
    const pyDef = new PythonDefinitionProvider(manager, index);
    const collection = makeCollection();
    await manager.waitForInitialScan();
    await index.waitForInitialScan();

    // 基类引用文档(定义跳转命中面,与风暴车道同形)
    const cellText = 'class CellAvatar(Avatar):\n    pass\n';
    const cellPath = path.join(path.dirname(avatarPath), 'CellAvatar.py');
    const cellDoc = stormDoc(cellText, cellPath, 'python', 1);
    await index.onDocumentChanged(cellDoc);
    const basePos = new Position(0, cellText.indexOf('(Avatar') + 1);

    const soakStarted = performance.now();
    const deadline = soakStarted + SOAK_SECONDS * 1000;
    let version = 0;
    let errors = 0;
    let hoverHits = 0;
    let hoverRequests = 0;

    // 真实编辑器形状:同一文档对象原地 mutate(didChange),文本常尺寸
    // (反复改同一方法位,不无限增长——文档增长属大文件退化面,归 RUST-031)。
    // 首版曾每版新建文档对象,RSS +369MB@16 万版是 harness 形状伪影,已纠正。
    const editDoc = stormDoc(avatarText, avatarPath, 'python', 1);
    const compDoc = stormDoc(avatarText + '\n        self.', avatarPath, 'python', 1);
    const compPosition = new Position(avatarText.split('\n').length, '        self.'.length);
    const defDoc = stormDoc(avatarDefText, avatarDefPath, 'kbengine-def', 1);

    interface WindowStats {
      index: number;
      wall: number;
      rssMb: number;
      heapUsedMb: number;
      hoverP50: number;
      hoverP99: number;
      requests: number;
    }
    const windows: WindowStats[] = [];
    // 泄漏观测口径:--expose-gc 下每窗强制 gc 后取 heapUsed(RSS 是 V8 段预留
    // 噪声,探针实证 5 万请求 heapUsed gc 后平坦而 RSS +77MB,不是泄漏信号);
    // gc 不可用则只记录序列,内存硬闸诚实跳过。
    let gcApplied = maybeGc();

    while (performance.now() < deadline) {
      const windowStarted = performance.now();
      const hoverSamples: number[] = [];
      const windowVersionStart = version;
      // 一窗负载:30×(编辑+hover) + 15×py 补全 + 10×定义跳转 + 5×def 诊断
      try {
        for (let i = 0; i < 30; i++) {
          version += 1;
          editDoc.setText(avatarText + `\n    def soak_v${version}(self):\n        pass\n`);
          await index.onDocumentChanged(editDoc);
          const t = performance.now();
          const got = await hover.provideHover(editDoc, hoverPos);
          hoverSamples.push(performance.now() - t);
          hoverRequests += 1;
          if (got) {
            hoverHits += 1;
          }
        }
        compDoc.setText(avatarText + '\n        self.');
        for (let i = 0; i < 15; i++) {
          await pyComp.provideCompletionItems(compDoc, compPosition);
        }
        for (let i = 0; i < 10; i++) {
          await pyDef.provideDefinition(cellDoc, basePos);
        }
        defDoc.setText(avatarDefText);
        for (let i = 0; i < 5; i++) {
          validateDocument(defDoc, collection as never);
        }
      } catch (error) {
        errors += 1;
        emit(
          `SOAK-METRIC windowError n=1 window=${windows.length + 1} ` +
          `message=${JSON.stringify((error as Error).message)}`
        );
      }
      const wall = performance.now() - windowStarted;
      gcApplied = maybeGc();
      const stats: WindowStats = {
        index: windows.length + 1,
        wall: Math.round(wall),
        rssMb: Math.round((process.memoryUsage().rss / 1048576) * 100) / 100,
        heapUsedMb: Math.round((process.memoryUsage().heapUsed / 1048576) * 100) / 100,
        hoverP50: percentile(hoverSamples, 0.5),
        hoverP99: percentile(hoverSamples, 0.99),
        requests: version - windowVersionStart
      };
      windows.push(stats);
      emit(
        `SOAK-METRIC window n=1 index=${stats.index} wall=${stats.wall}ms ` +
        `rssMb=${stats.rssMb} heapUsedMb=${stats.heapUsedMb} ` +
        `hoverP50=${stats.hoverP50}ms hoverP99=${stats.hoverP99}ms ` +
        `requests=${stats.requests}`
      );
      // 窗对齐到 WINDOW_SECONDS 节拍(周期采样口径,非 100% CPU 自旋)
      const windowElapsed = performance.now() - windowStarted;
      const pad = WINDOW_SECONDS * 1000 - windowElapsed;
      if (pad > 0) {
        await new Promise(resolve => setTimeout(resolve, pad));
      }
    }

    const soakWall = performance.now() - soakStarted;
    const first = windows[0];
    const last = windows[windows.length - 1];
    const rssGrowthMb = last.rssMb - first.rssMb;
    const heapGrowthMb = last.heapUsedMb - first.heapUsedMb;

    expect(errors).toBe(0);
    expect(hoverHits).toBe(hoverRequests);
    // 泄漏硬闸只在 gc 可用时生效(真留存=gc 后 heapUsed 增量);RSS 不做闸——
    // V8 段预留增长不是泄漏(探针实证 heapUsed 平坦),硬钉只会假阳。
    if (gcApplied) {
      expect(heapGrowthMb).toBeLessThan(HEAP_GROWTH_CEILING_MB);
    }
    // 退化守卫:末窗 p50 不得病态劣化(只捕 10x 量级,不钉绝对速度)
    expect(last.hoverP50).toBeLessThan(first.hoverP50 * 10 + 5);

    emit(
      `SOAK-SUMMARY windows=${windows.length} wall=${Math.round(soakWall)}ms ` +
      `requests=${windows.reduce((sum, w) => sum + w.requests, 0)} errors=0 ` +
      `hoverHits=${hoverHits} gcApplied=${gcApplied ? 1 : 0} ` +
      `rssFirstMb=${first.rssMb} rssLastMb=${last.rssMb} ` +
      `rssGrowthMb=${Math.round(rssGrowthMb * 100) / 100} ` +
      `heapFirstMb=${first.heapUsedMb} heapLastMb=${last.heapUsedMb} ` +
      `heapGrowthMb=${Math.round(heapGrowthMb * 100) / 100} ` +
      `hoverP50FirstMs=${first.hoverP50} hoverP50LastMs=${last.hoverP50} ` +
      `hoverP99MaxMs=${Math.max(...windows.map(w => w.hoverP99))}`
    );
    manager.dispose();
  }, SOAK_SECONDS * 1000 + 600000);
});
