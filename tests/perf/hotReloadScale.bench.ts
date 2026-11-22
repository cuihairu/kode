/**
 * RUST-413 热更新规模基准(HR-QA-001,基准定义):真实盘上脚本树 + 真实
 * readSnapshot(读盘+sha256)+ 真实定时器,五面——
 *   M1 规模矩阵 200/2k/10k/50k 文件:前端过滤扫描(isWatchableScriptFile
 *      纯词法)+ 流水线吸收吞吐(定稿即发 debounce=0/flush=0,隔离每文件
 *      吸收成本;默认阈值 50 在单文件波次下不触发);读路径经透传语法闸激活
 *      (本核 due() 只在 readSnapshot && (window>0 || checkSyntax) 时读盘,
 *      生产装配必注入稳定窗或语法闸,窗=0+透传闸=单读盘+sha256,读路径即
 *      生产形状);
 *   M2 单文件持续保存 100 次:吞吐 + revision 单调 + 不丢版;
 *   M3 Git checkout 500 文件爆发:生产配置(debounce=500/flush=500/默认
 *      阈值 50)→ 500 只预览不自动发(HR-WATCH-016 批量闸,无全仓热更风暴),
 *      显式放行才发;
 *   M4 写入风暴 100 文件×(save+disk-change)重叠归并:同文件 save 后紧跟
 *      disk-change 归并为一发(HR-WATCH-003),100 发非 200;
 *   M5 远端 SSH/workspace:远端形态路径规范化面(canonicalizeScriptFilePath
 *      键口径与本地一致)+ 端到端诚实未覆盖注记(需活 SSH 会话+远端文件系统
 *      延迟,纯核基准无此面)。
 *
 * 只观测不改行为;断言只有语义命中面(确定性的 hits/计数),墙钟一律不进断言
 * (只捕数量级回退的阈值属 RUST-414 后续批次;本批先建测量)。输出
 * HRS-ENV/HRS-METRIC/HRS-NOTE 落 docs/perf/hot-reload-scale-run.txt(追加制,
 * KODE_HRS_OUT 可覆盖),与主 unit 门无交集(.bench.ts 独立 lane,仅
 * vitest.bench.config.ts 收录)。
 *
 * 跑法:KODE_HRS_FILES=50000 npx vitest run --config vitest.bench.config.ts tests/perf/hotReloadScale.bench.ts
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  HotReloadSavePipeline,
  isWatchableScriptFile,
  type FileChanged,
  type HotReloadSavePipelineOptions
} from '../../src/backend/hotReloadSavePipeline';
import { canonicalizeScriptFilePath } from '../../src/backend/hotReloadModuleIdentity';

const ASSETS_OUT = process.env.KODE_HRS_ASSETS_OUT
  ?? path.join(os.tmpdir(), 'kode-hrs-assets');
const LARGEST = Number(process.env.KODE_HRS_FILES ?? '50000');
const SCALES = [...new Set([200, 2000, 10000, LARGEST].filter(n => n > 0 && n <= LARGEST))].sort((a, b) => a - b);

const OUT_FILE = process.env.KODE_HRS_OUT
  ?? path.resolve(__dirname, '../../docs/perf/hot-reload-scale-run.txt');
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

const pooled = (name: string, samples: number[]): void => {
  emit(
    `HRS-METRIC ${name} n=${samples.length} ` +
    `p50=${percentile(samples, 0.5)}ms p95=${percentile(samples, 0.95)}ms ` +
    `p99=${percentile(samples, 0.99)}ms max=${percentile(samples, 1)}ms`
  );
};

const once = (name: string, value: number, unit = 'ms'): void => {
  emit(`HRS-METRIC ${name} n=1 ${Math.round(value * 100) / 100}${unit}`);
};

const waitFor = async (predicate: () => boolean, timeoutMs: number, label: string): Promise<void> => {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() > deadline) {
      throw new Error(`waitFor timeout: ${label}`);
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};

/** 真实快照读:读盘 + sha256(装配面真实现同口径:内容与哈希都来自磁盘) */
const readSnapshot = async (file: string): Promise<{ hash: string; content: string } | null> => {
  try {
    const content = await fs.promises.readFile(file, 'utf8');
    return { hash: createHash('sha256').update(content).digest('hex'), content };
  } catch {
    return null;
  }
};

/** 每文件读取成本(哈希路径的真实每文件成本) */
const makeTimedSnapshot = (): {
  read: (file: string) => Promise<{ hash: string; content: string } | null>;
  samples: number[];
} => {
  const samples: number[] = [];
  return {
    read: async (file: string): Promise<{ hash: string; content: string } | null> => {
      const started = performance.now();
      const result = await readSnapshot(file);
      samples.push(performance.now() - started);
      return result;
    },
    samples
  };
};

/**
 * 生产装配面必注入稳定窗(默认 200ms)或语法闸——本核 due() 只在
 * `readSnapshot && (window>0 || checkSyntax)` 时读盘(hotReloadSavePipeline.ts:429)。
 * 本基准隔离「每文件吸收成本」用窗=0 + 透传语法闸:强制单读盘+sha256,
 * 稳定等待不进场,读路径即生产路径(纯核不注入时是空壳 settle,非生产形状)。
 */
const PASS_SYNTAX = (): { ok: true } => ({ ok: true });

/** 流水线装配:收集 auto/preview 两模式出口与全部事件 */
const buildPipeline = (opts: Partial<HotReloadSavePipelineOptions>): {
  pipeline: HotReloadSavePipeline;
  emitted: FileChanged[];
  auto: FileChanged[][];
  preview: FileChanged[][];
  whenEmit: () => Promise<void>;
} => {
  const emitted: FileChanged[] = [];
  const auto: FileChanged[][] = [];
  const preview: FileChanged[][] = [];
  const emitWaiters: Array<() => void> = [];
  const pipeline = new HotReloadSavePipeline({
    ...opts,
    onEmit: (events, mode) => {
      if (mode === 'auto') {
        auto.push(events);
      } else {
        preview.push(events);
      }
      emitted.push(...events);
      for (const resolve of emitWaiters.splice(0)) {
        resolve();
      }
    }
  });
  const whenEmit = (): Promise<void> => new Promise<void>(resolve => emitWaiters.push(resolve));
  return { pipeline, emitted, auto, preview, whenEmit };
};

const scriptPath = (index: number): string =>
  path.join(ASSETS_OUT, 'scripts', `m${String(index).padStart(6, '0')}.py`);
const firstScripts = (count: number): string[] =>
  Array.from({ length: count }, (_unused, index) => scriptPath(index));

describe('RUST-413 热更新规模基准(文件数矩阵/持续保存/checkout 爆发/写入风暴/远端)', () => {
  beforeAll(() => {
    // 确定性内容:每文件唯一类名,重复生成一致(与 generate-perf-assets 同纪律)
    fs.rmSync(ASSETS_OUT, { recursive: true, force: true });
    const scriptsRoot = path.join(ASSETS_OUT, 'scripts');
    fs.mkdirSync(scriptsRoot, { recursive: true });
    for (let index = 0; index < LARGEST; index++) {
      fs.writeFileSync(
        scriptPath(index),
        `class Bench${String(index).padStart(6, '0')}:\n    def onFoo(self, arg):\n        return arg\n`,
        'utf8'
      );
    }
    emit(
      `HRS-ENV node=${process.version} platform=${os.platform()} ` +
      `cpus=${os.cpus().length} scales=${SCALES.join(',')} largest=${LARGEST} assets=${ASSETS_OUT}`
    );
  }, 600000);

  afterAll(() => {
    fs.rmSync(ASSETS_OUT, { recursive: true, force: true });
  });

  it('M1 规模矩阵:200/2k/10k/50k 文件过滤扫描+吸收吞吐', async () => {
    for (const n of SCALES) {
      const paths = firstScripts(n);
      // (a) 前端过滤扫描(纯词法,零 IO):真实 watcher 前端逐事件判定成本
      const filterStart = performance.now();
      let accepted = 0;
      for (const p of paths) {
        if (isWatchableScriptFile(p, { roots: [ASSETS_OUT] })) {
          accepted += 1;
        }
      }
      const filterWall = performance.now() - filterStart;
      once(`M1.filter.${n}.wall`, filterWall);
      once(`M1.filter.${n}.perEvent`, filterWall / n);
      once(`M1.filter.${n}.accepted`, accepted, ' files');
      expect(accepted).toBe(n);
      // (b) 流水线吸收(定稿即发):每文件 settle+读盘+哈希后独立发,阈值 50
      // 在单文件波次下不触发,隔离「每文件吸收成本」的规模曲线
      const timedSnapshot = makeTimedSnapshot();
      const { pipeline, emitted } = buildPipeline({
        debounceMs: 0,
        batchFlushMs: 0,
        stabilityWindowMs: 0,
        checkSyntax: PASS_SYNTAX,
        readSnapshot: timedSnapshot.read
      });
      const absorbStart = performance.now();
      for (const p of paths) {
        pipeline.offer(p, 'save');
      }
      await waitFor(() => emitted.length === n, 600000, `M1 absorb ${n}`);
      const absorbWall = performance.now() - absorbStart;
      once(`M1.absorb.${n}.wall`, absorbWall);
      once(`M1.absorb.${n}.perFile`, absorbWall / n);
      once(`M1.absorb.${n}.throughput`, n / (absorbWall / 1000), ' files/s');
      // 每文件读延迟含全爆发并发排队(50k readFile 挤 libuv 线程池),
      // 非单读固有成本;固有成本=wall/N(perFile)
      pooled(`M1.absorb.${n}.readLatency`, timedSnapshot.samples);
      expect(emitted.length).toBe(n);
      expect(emitted.every(event => event.revision === 1)).toBe(true);
      pipeline.dispose();
    }
  }, 600000);

  it('M2 单文件持续保存:100 次连续保存吞吐+revision 单调', async () => {
    const target = scriptPath(LARGEST); // 专用文件,不与 M1/M3 的 0..49k 集合相撞
    const base = 'class BenchSustained:\n    def onFoo(self, arg):\n        return arg\n';
    const { pipeline, emitted, whenEmit } = buildPipeline({
      debounceMs: 0,
      batchFlushMs: 0,
      stabilityWindowMs: 0,
      checkSyntax: PASS_SYNTAX,
      readSnapshot
    });
    // 逐次 offer→emit 真延迟(去抖 0=不含配置 debounce,Promise 等待非 poll 量化)
    const perSave: number[] = [];
    const started = performance.now();
    for (let i = 1; i <= 100; i++) {
      fs.writeFileSync(target, `${base}    def sustained${i}(self):\n        pass\n`, 'utf8');
      const t0 = performance.now();
      const done = whenEmit();
      pipeline.offer(target, 'save');
      await done;
      perSave.push(performance.now() - t0);
      expect(emitted.length).toBe(i);
    }
    const wall = performance.now() - started;
    once('M2.sustained.wall', wall);
    once('M2.sustained.throughput', 100 / (wall / 1000), ' saves/s');
    pooled('M2.saveToQueue', perSave);
    expect(emitted.length).toBe(100);
    expect(emitted.map(event => event.revision)).toEqual([...Array(100).keys()].map(k => k + 1));
    expect(emitted.every(event => event.source === 'save')).toBe(true);
    pipeline.dispose();
  }, 120000);

  it('M3 Git checkout 500 文件爆发:默认阈值 50,只预览不自动发', async () => {
    const paths = firstScripts(500);
    const { pipeline, auto, preview } = buildPipeline({
      debounceMs: 500,
      batchFlushMs: 500,
      stabilityWindowMs: 0,
      checkSyntax: PASS_SYNTAX,
      readSnapshot
    });
    const burstStart = performance.now();
    for (const p of paths) {
      pipeline.offer(p, 'save');
    }
    // 波次归集窗 500ms + 批量冲口 500ms 后,500 文件合成一批 → 超阈值 50 滞留
    await waitFor(() => pipeline.previewHeldFiles().length === 500, 30000, 'M3 preview hold');
    once('M3.previewHold.wall', performance.now() - burstStart);
    expect(auto.length).toBe(0);
    expect(pipeline.previewHeldFiles().length).toBe(500);
    // 显式放行(HR-WATCH-016):才以 preview-release 模式发出
    const releaseStart = performance.now();
    pipeline.releasePreview();
    await waitFor(() => preview.length > 0, 10000, 'M3 release');
    once('M3.releasePreview.wall', performance.now() - releaseStart);
    expect(preview.flat().length).toBe(500);
    expect(preview[0].every(event => event.revision === 1)).toBe(true);
    pipeline.dispose();
  }, 120000);

  it('M4 写入风暴:100 文件×(save+disk-change)重叠归并,不双发', async () => {
    const paths = firstScripts(100);
    const { pipeline, emitted } = buildPipeline({
      debounceMs: 500,
      batchFlushMs: 500,
      stabilityWindowMs: 0,
      batchPreviewThreshold: 100000,
      checkSyntax: PASS_SYNTAX,
      readSnapshot
    });
    const stormStart = performance.now();
    for (const p of paths) {
      pipeline.offer(p, 'save');
    }
    for (const p of paths) {
      pipeline.offer(p, 'disk-change');
    }
    await waitFor(() => emitted.length === 100, 30000, 'M4 absorb');
    once('M4.storm.wall', performance.now() - stormStart);
    expect(emitted.length).toBe(100);
    expect(emitted.every(event => event.coalesced === 2)).toBe(true);
    expect(emitted.every(event => event.coalesceReason.includes('disk-save-overlap'))).toBe(true);
    pipeline.dispose();
  }, 120000);

  it('M5 远端 SSH/workspace:路径规范化面 + 端到端诚实未覆盖', () => {
    // 远端形态路径规范化:WSL/UNC/远端 share/盘符,键口径与本地一致
    const remoteForms: ReadonlyArray<readonly [string, string]> = [
      ['//wsl$/Ubuntu/home/user/scripts/base/Avatar.py', '//wsl$/Ubuntu/home/user/scripts/base/Avatar.py'],
      ['file://server/share/scripts/base/Avatar.py', '//server/share/scripts/base/Avatar.py'],
      ['file:///C:/scripts/base/Avatar.py', '/C:/scripts/base/Avatar.py'],
      ['c:\\scripts\\base\\Avatar.py', 'C:/scripts/base/Avatar.py']
    ];
    for (const [input, expected] of remoteForms) {
      expect(canonicalizeScriptFilePath(input)).toBe(expected);
    }
    // 规范化纯词法成本(零 IO)
    const canonicalStart = performance.now();
    for (let i = 0; i < 100000; i++) {
      canonicalizeScriptFilePath('//wsl$/Ubuntu/home/user/scripts/base/Avatar.py');
    }
    once('M5.canonicalize.100k', performance.now() - canonicalStart);
    emit(
      'HRS-NOTE M5 远端端到端延迟未覆盖:需活 SSH 会话+远端文件系统延迟,纯核基准' +
      '无此面;远端路径规范化已由本例覆盖,键口径与本地一致,端到端随接线批'
    );
  }, 600000);
});
