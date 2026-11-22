/**
 * RUST-414 热更各段耗时统计(HR-QA-002,纯核段):Watch→过滤→哈希→语法检查→
 * 队列→HTTP→回执→UI 八段,本车道测前四段(纯核面),HTTP→回执→UI 三段为
 * 装配面(接线批/kode5 分项,诚实未覆盖注记)。
 *   S1 过滤段:isWatchableScriptFile 逐事件纯词法(Watch→过滤);
 *   S2 哈希段:readSnapshot 读盘+sha256(过滤→哈希);
 *   S3 语法段:checkSyntax 判定(哈希→语法检查);
 *   S4 队列段:定稿→波次→发出,派生=(flushed-scheduled)-hash-syntax
 *      (语法检查→队列→发出;总 CPU=flushed-scheduled 即「本地 pipeline CPU」);
 *   S5 排队/丢弃原因:debounced(归并)/deduped(去重)/blocked(语法拦)/
 *      preview(批量滞留)各自计数(丢弃原因全量在 RUST-341 诊断面板,此处统计)。
 * 只观测不改行为;断言=语义计数命中面,墙钟一律不进断言(P95/P99/max 只记录,
 * 阈值化归后续)。输出 HRS-ENV/HRS-METRIC/HRS-NOTE 落
 * docs/perf/hot-reload-segment-run.txt(追加制,KODE_SEG_OUT 可覆盖),与主
 * unit 门无交集(.bench.ts 独立 lane)。
 *
 * 跑法:npx vitest run --config vitest.bench.config.ts tests/perf/hotReloadSegment.bench.ts
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
  type HotReloadSavePipelineOptions,
  type SavePipelineDiagnostic,
  type SavePipelineDiagnosticType
} from '../../src/backend/hotReloadSavePipeline';

const ASSETS_OUT = process.env.KODE_SEG_ASSETS_OUT
  ?? path.join(os.tmpdir(), 'kode-seg-assets');
const FILE_COUNT = 200;

const OUT_FILE = process.env.KODE_SEG_OUT
  ?? path.resolve(__dirname, '../../docs/perf/hot-reload-segment-run.txt');
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

const readSnapshot = async (file: string): Promise<{ hash: string; content: string } | null> => {
  try {
    const content = await fs.promises.readFile(file, 'utf8');
    return { hash: createHash('sha256').update(content).digest('hex'), content };
  } catch {
    return null;
  }
};

const PASS_SYNTAX = (): { ok: true } => ({ ok: true });

/** 装配面必注入语法闸/稳定窗才激活读路径(续96 判例 1);本基准窗=0+透传闸=单读 */
const buildPipeline = (opts: Partial<HotReloadSavePipelineOptions>): {
  pipeline: HotReloadSavePipeline;
  emitted: FileChanged[];
  diagnostics: SavePipelineDiagnostic[];
} => {
  const emitted: FileChanged[] = [];
  const diagnostics: SavePipelineDiagnostic[] = [];
  const pipeline = new HotReloadSavePipeline({
    ...opts,
    onEmit: events => {
      emitted.push(...events);
    },
    onDiagnostic: diagnostic => {
      diagnostics.push(diagnostic);
    }
  });
  return { pipeline, emitted, diagnostics };
};

const countDiagnostics = (
  diagnostics: readonly SavePipelineDiagnostic[],
  type: SavePipelineDiagnosticType
): number => diagnostics.filter(diagnostic => diagnostic.type === type).length;

const scriptPath = (index: number): string =>
  path.join(ASSETS_OUT, 'scripts', `m${String(index).padStart(5, '0')}.py`);
const firstScripts = (count: number): string[] =>
  Array.from({ length: count }, (_unused, index) => scriptPath(index));

describe('RUST-414 热更各段耗时统计(过滤/哈希/语法/队列+丢弃原因)', () => {
  beforeAll(() => {
    fs.rmSync(ASSETS_OUT, { recursive: true, force: true });
    const scriptsRoot = path.join(ASSETS_OUT, 'scripts');
    fs.mkdirSync(scriptsRoot, { recursive: true });
    for (let index = 0; index < FILE_COUNT; index++) {
      fs.writeFileSync(
        scriptPath(index),
        `class Seg${String(index).padStart(5, '0')}:\n    def onFoo(self, arg):\n        return arg\n`,
        'utf8'
      );
    }
    emit(
      `HRS-ENV node=${process.version} platform=${os.platform()} ` +
      `cpus=${os.cpus().length} load1=${os.loadavg()[0].toFixed(2)} ` +
      `files=${FILE_COUNT} assets=${ASSETS_OUT}`
    );
  }, 600000);

  afterAll(() => {
    fs.rmSync(ASSETS_OUT, { recursive: true, force: true });
  });

  it('S1-S4 四段耗时:过滤/哈希/语法/队列(P95/P99/max)+总 CPU', async () => {
    const paths = firstScripts(FILE_COUNT);
    // S1 过滤段(Watch→过滤):纯词法逐事件
    const filterSamples: number[] = [];
    let accepted = 0;
    for (const p of paths) {
      const t0 = performance.now();
      if (isWatchableScriptFile(p, { roots: [ASSETS_OUT] })) {
        accepted += 1;
      }
      filterSamples.push(performance.now() - t0);
    }
    expect(accepted).toBe(FILE_COUNT);
    pooled('S1.filter', filterSamples);
    once('S1.filter.accepted', accepted, ' files');

    // S2/S3/S4 哈希/语法/队列:定稿即发(隔离 CPU 路径,波次=单文件)
    const hashSamples: number[] = [];
    const syntaxSamples: number[] = [];
    const { pipeline, emitted, diagnostics } = buildPipeline({
      debounceMs: 0,
      batchFlushMs: 0,
      stabilityWindowMs: 0,
      readSnapshot: async file => {
        const t0 = performance.now();
        const result = await readSnapshot(file);
        hashSamples.push(performance.now() - t0);
        return result;
      },
      checkSyntax: content => {
        const t0 = performance.now();
        syntaxSamples.push(performance.now() - t0);
        void content;
        return { ok: true };
      }
    });
    for (const p of paths) {
      pipeline.offer(p, 'save');
    }
    await waitFor(() => emitted.length === FILE_COUNT, 600000, 'segment absorb');
    pipeline.dispose();
    expect(emitted.length).toBe(FILE_COUNT);
    pooled('S2.hash', hashSamples);
    pooled('S3.syntax', syntaxSamples);
    // 诊断计数如实:200 trigger + 200 flushed + ≥200 scheduled(波次冲口再+)
    once('S1.diag.trigger', countDiagnostics(diagnostics, 'trigger'), ' events');
    once('S1.diag.flushed', countDiagnostics(diagnostics, 'flushed'), ' events');

    // S4 队列段:总 CPU(flushed-scheduled) - hash - syntax = 定稿+波次逻辑
    // (诊断时间戳:trigger=offer,scheduled=排窗,flushed=成批发出)
    const flushTimes = diagnostics
      .filter(d => d.type === 'flushed')
      .map(d => d.time);
    const scheduleTimes = diagnostics
      .filter(d => d.type === 'scheduled')
      .map(d => d.time);
    const triggerTimes = diagnostics
      .filter(d => d.type === 'trigger')
      .map(d => d.time);
    expect(flushTimes.length).toBe(FILE_COUNT);
    expect(triggerTimes.length).toBe(FILE_COUNT);
    expect(scheduleTimes.length).toBeGreaterThanOrEqual(FILE_COUNT);
    const queueSamples: number[] = [];
    const totalSamples: number[] = [];
    for (let i = 0; i < FILE_COUNT; i++) {
      const cpu = flushTimes[i] - scheduleTimes[i];
      const read = hashSamples[i] ?? 0;
      const syntax = syntaxSamples[i] ?? 0;
      queueSamples.push(Math.max(0, cpu - read - syntax));
      totalSamples.push(Math.max(0, flushTimes[i] - triggerTimes[i]));
    }
    pooled('S4.queue', queueSamples);
    once('S4.queue.count', queueSamples.length, ' samples');
    pooled('S4.totalCpu', totalSamples);
    once('S4.totalCpu.count', totalSamples.length, ' samples');
  }, 600000);

  it('S5 排队与丢弃原因:归并/去重/语法拦/批量滞留各自计数', async () => {
    // (a) 去重(deduped):同文件同内容第二次 offer → 同哈希不重发
    const dedup = buildPipeline({
      debounceMs: 0,
      batchFlushMs: 0,
      stabilityWindowMs: 0,
      checkSyntax: PASS_SYNTAX,
      readSnapshot
    });
    dedup.pipeline.offer(scriptPath(0), 'save');
    await waitFor(() => dedup.emitted.length === 1, 30000, 'dedup first');
    dedup.pipeline.offer(scriptPath(0), 'save');
    await waitFor(() => countDiagnostics(dedup.diagnostics, 'deduped') === 1, 30000, 'dedup second');
    dedup.pipeline.dispose();
    expect(dedup.emitted.length).toBe(1);
    once('S5.reason.deduped', countDiagnostics(dedup.diagnostics, 'deduped'), ' events');
    expect(countDiagnostics(dedup.diagnostics, 'deduped')).toBe(1);

    // (b) 语法拦(blocked):检查器不通过 → 不发半成品
    let blockedSeen = false;
    const blocked = buildPipeline({
      debounceMs: 0,
      batchFlushMs: 0,
      stabilityWindowMs: 0,
      readSnapshot,
      checkSyntax: () => {
        blockedSeen = true;
        return { ok: false, errors: ['def broken(:'] };
      }
    });
    blocked.pipeline.offer(scriptPath(1), 'save');
    await waitFor(() => countDiagnostics(blocked.diagnostics, 'blocked') === 1, 30000, 'blocked');
    blocked.pipeline.dispose();
    expect(blockedSeen).toBe(true);
    expect(blocked.emitted.length).toBe(0);
    once('S5.reason.blocked', countDiagnostics(blocked.diagnostics, 'blocked'), ' events');
    expect(countDiagnostics(blocked.diagnostics, 'blocked')).toBe(1);

    // (c) 归并(debounced):同窗内同文件 save 后紧跟 disk-change → 归并不双发
    const coalesce = buildPipeline({
      debounceMs: 500,
      batchFlushMs: 500,
      stabilityWindowMs: 0,
      batchPreviewThreshold: 100000,
      checkSyntax: PASS_SYNTAX,
      readSnapshot
    });
    coalesce.pipeline.offer(scriptPath(2), 'save');
    coalesce.pipeline.offer(scriptPath(2), 'disk-change');
    await waitFor(() => coalesce.emitted.length === 1, 30000, 'coalesce');
    coalesce.pipeline.dispose();
    expect(coalesce.emitted.length).toBe(1);
    expect(coalesce.emitted[0].coalesced).toBe(2);
    once('S5.reason.debounced', countDiagnostics(coalesce.diagnostics, 'debounced'), ' events');
    expect(countDiagnostics(coalesce.diagnostics, 'debounced')).toBe(1);

    // (d) 批量滞留(preview):同窗 100 文件(>默认阈值 50)只预览不自动发
    const preview = buildPipeline({
      debounceMs: 500,
      batchFlushMs: 500,
      stabilityWindowMs: 0,
      checkSyntax: PASS_SYNTAX,
      readSnapshot
    });
    for (const p of firstScripts(100)) {
      preview.pipeline.offer(p, 'save');
    }
    await waitFor(() => preview.pipeline.previewHeldFiles().length === 100, 30000, 'preview hold');
    preview.pipeline.dispose();
    expect(preview.emitted.length).toBe(0);
    once('S5.reason.preview', countDiagnostics(preview.diagnostics, 'preview'), ' events');
    expect(countDiagnostics(preview.diagnostics, 'preview')).toBeGreaterThanOrEqual(1);

    emit(
      'HRS-NOTE S5 队列/丢弃原因全量出口=RUST-341 诊断面板(八型全量落通道),' +
      '本面只统计四主因计数;filtered(空路径/读不到)不在本面(属异常路径非稳态)'
    );
  }, 120000);

  it('S6 无竞争段基线:顺序单文件 50 保存,逐段 p50/p95 对齐候选线口径', async () => {
    // 顺序(逐保存 await 上一笔发出)=无 libuv 读盘排队:段值是单文件固有成本,
    // 与候选线(Save→队列 P95≤30ms / 本地 pipeline CPU P95≤15ms)同口径。
    // S2/S4 的并发值含爆发排队(libuv 线程池),本面给无竞争基线。
    const target = scriptPath(FILE_COUNT); // 专用文件,与 S1-S5 的 0..FILE_COUNT-1 不相撞
    const base = 'class SegSequential:\n    def onFoo(self, arg):\n        return arg\n';
    const hashSamples: number[] = [];
    const syntaxSamples: number[] = [];
    const diagnostics: SavePipelineDiagnostic[] = [];
    let saveResolve: (() => void) | null = null;
    const pipeline = new HotReloadSavePipeline({
      debounceMs: 0,
      batchFlushMs: 0,
      stabilityWindowMs: 0,
      readSnapshot: async file => {
        const t0 = performance.now();
        const result = await readSnapshot(file);
        hashSamples.push(performance.now() - t0);
        return result;
      },
      checkSyntax: content => {
        const t0 = performance.now();
        syntaxSamples.push(performance.now() - t0);
        void content;
        return { ok: true };
      },
      onDiagnostic: diagnostic => {
        diagnostics.push(diagnostic);
      },
      onEmit: () => {
        saveResolve?.();
        saveResolve = null;
      }
    });
    const queueSamples: number[] = [];
    const totalSamples: number[] = [];
    for (let i = 1; i <= 50; i++) {
      fs.writeFileSync(target, `${base}    def seg_seq${i}(self):\n        pass\n`, 'utf8');
      const before = diagnostics.length;
      saveResolve = null;
      pipeline.offer(target, 'save');
      await new Promise<void>(resolve => {
        saveResolve = resolve;
      });
      // 逐保存诊断三连:trigger / scheduled / flushed
      const slice = diagnostics.slice(before);
      expect(slice.length).toBe(3);
      expect(slice[0].type).toBe('trigger');
      expect(slice[1].type).toBe('scheduled');
      expect(slice[2].type).toBe('flushed');
      totalSamples.push(Math.max(0, slice[2].time - slice[0].time));
      queueSamples.push(
        Math.max(0, slice[2].time - slice[1].time - (hashSamples[i - 1] ?? 0) - (syntaxSamples[i - 1] ?? 0))
      );
    }
    pipeline.dispose();
    expect(hashSamples.length).toBe(50);
    expect(syntaxSamples.length).toBe(50);
    pooled('S6.hash', hashSamples);
    pooled('S6.syntax', syntaxSamples);
    pooled('S6.queue', queueSamples);
    pooled('S6.totalCpu', totalSamples);
    once('S6.saves', 50, ' saves');
  }, 120000);

  it('S7 500 事件 burst 同步段:filter+offer 不饿死事件循环(RUST-416 面)', async () => {
    // RUST-416(旧 HR-QA-004)500 文件同时变动:批次确认/限流由 HR-WATCH-016
    // 滞留(单文件测试)与 M3 规模面(500 全滞留 auto=0)钉;此处钉纯核同步段
    // ——watcher burst 的 filter+offer 同步成本有界(观测几十毫秒,非秒级),
    // 读盘/哈希在 libuv 线程池异步不占主线程(UI 不冻结的纯核面)。断言只有
    // 同步段语义(500 全入队零丢失、同步段零发出);墙钟只观测不进断言。
    const paths = firstScripts(500);
    const filterSamples: number[] = [];
    let accepted = 0;
    const filterStart = performance.now();
    for (const p of paths) {
      const started = performance.now();
      if (isWatchableScriptFile(p, { roots: [ASSETS_OUT] })) {
        accepted += 1;
      }
      filterSamples.push(performance.now() - started);
    }
    const filterWall = performance.now() - filterStart;
    expect(accepted).toBe(500);
    const { pipeline, emitted } = buildPipeline({
      debounceMs: 0,
      batchFlushMs: 0,
      stabilityWindowMs: 0,
      checkSyntax: PASS_SYNTAX,
      readSnapshot
    });
    const offerStart = performance.now();
    for (const p of paths) {
      pipeline.offer(p, 'save');
    }
    const offerWall = performance.now() - offerStart;
    // 同步段语义:500 全入队无丢失;定稿在异步面,同步段零发出
    expect(emitted).toHaveLength(0);
    expect(pipeline.pendingFiles()).toHaveLength(500);
    pipeline.dispose();
    once('S7.burst500.filterWall', filterWall);
    once('S7.burst500.filterPerEvent', filterWall / 500);
    once('S7.burst500.offerWall', offerWall);
    once('S7.burst500.offerPerEvent', offerWall / 500);
    pooled('S7.burst500.filterSamples', filterSamples);
    emit(
      'HRS-NOTE S7 500 事件 burst 同步段:filter+offer 观测几十毫秒(含负载波动),' +
      '非秒级饿死;500 全入队零丢失,读盘在 libuv 线程池异步不占主线程(UI 不冻结' +
      '纯核面);UI 线程面随接线批(装配面)'
    );
  }, 120000);
});
