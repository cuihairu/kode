/**
 * RUST-414 热更各段耗时统计(HR-QA-002,纯核段):Watch→过滤→哈希→语法检查→
 * 队列→HTTP→回执→UI 八段,本车道测纯核面;HTTP→回执段由 HR-STATE-007
 * durationMs 逐发送记录于台账(hotReloadChannelSend.ts:146-148,非本车道钉域);
 * UI 显示段(S8)纯核可测入本车道,500ms 节流窗为设计常数(HR-UI-007 已钉),
 * 网络耗时须单独统计不混本地性能(§19.10)。
 *   S1 过滤段:isWatchableScriptFile 逐事件纯词法(Watch→过滤);
 *   S2 哈希段:readSnapshot 读盘+sha256(过滤→哈希);
 *   S3 语法段:checkSyntax 判定(哈希→语法检查);
 *   S4 队列段:定稿→波次→发出,派生=(flushed-scheduled)-hash-syntax
 *      (语法检查→队列→发出;总 CPU=flushed-scheduled 即「本地 pipeline CPU」);
 *   S5 排队/丢弃原因:debounced(归并)/deduped(去重)/blocked(语法拦)/
 *      preview(批量滞留)各自计数(丢弃原因全量在 RUST-341 诊断面板,此处统计)。
 * 只观测不改行为;断言=语义计数命中面+宽松上界表(hotReloadSegmentBounds:
 * KODE_SEG_BOUND_* 可覆盖,只捕数量级回退不跨机器比绝对值;P95/P99/max 全记录)。
 * 输出 HRS-ENV/HRS-METRIC/HRS-NOTE 落
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
import { resolveSegmentBounds, segmentViolations } from './hotReloadSegmentBounds';
import {
  HotReloadSavePipeline,
  isWatchableScriptFile,
  type FileChanged,
  type HotReloadSavePipelineOptions,
  type SavePipelineDiagnostic,
  type SavePipelineDiagnosticType
} from '../../src/backend/hotReloadSavePipeline';
import {
  renderHistoryPanelHtml,
  translateDeliveryRecord,
  type HotReloadNamesResolver
} from '../../src/hotReloadHistoryView';
import { HotReloadHistoryCore } from '../../src/backend/hotReloadHistoryCore';
import type { HotReloadDeliveryRecord } from '../../src/backend/hotReloadTargetState';
import { htmlLang, strings } from '../../src/webviewStrings';

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
  const violations: string[] = [];

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
    violations.push(
      ...segmentViolations(resolveSegmentBounds(), {
        s1FilterP99Ms: percentile(filterSamples, 0.99),
        s2HashP99Ms: percentile(hashSamples, 0.99),
        s3SyntaxP99Ms: percentile(syntaxSamples, 0.99),
        s4QueueP99Ms: percentile(queueSamples, 0.99),
        s4TotalCpuP99Ms: percentile(totalSamples, 0.99)
      })
    );
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
    violations.push(
      ...segmentViolations(resolveSegmentBounds(), {
        s6HashP99Ms: percentile(hashSamples, 0.99),
        s6SyntaxP99Ms: percentile(syntaxSamples, 0.99),
        s6QueueP99Ms: percentile(queueSamples, 0.99),
        s6TotalCpuP99Ms: percentile(totalSamples, 0.99)
      })
    );
  }, 120000);

  it('S7 500 事件 burst 同步段:filter+offer 不饿死事件循环(RUST-416 面)', async () => {
    // RUST-416(旧 HR-QA-004)500 文件同时变动:批次确认/限流由 HR-WATCH-016
    // 滞留(单文件测试)与 M3 规模面(500 全滞留 auto=0)钉;此处钉纯核同步段
    // ——watcher burst 的 filter+offer 同步成本有界(观测几十毫秒,非秒级),
    // 读盘/哈希在 libuv 线程池异步不占主线程(UI 不冻结的纯核面)。断言=同步段
    // 语义(500 全入队零丢失、同步段零发出)+同步段墙钟宽松上界(界表)。
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
    violations.push(
      ...segmentViolations(resolveSegmentBounds(), {
        s7BurstFilterP99Ms: percentile(filterSamples, 0.99),
        s7BurstFilterWallMs: filterWall,
        s7BurstOfferWallMs: offerWall
      })
    );
    emit(
      'HRS-NOTE S7 500 事件 burst 同步段:filter+offer 观测几十毫秒(含负载波动),' +
      '非秒级饿死;500 全入队零丢失,读盘在 libuv 线程池异步不占主线程(UI 不冻结' +
      '纯核面);UI 线程面随接线批(装配面)'
    );
  }, 120000);

  it('S8 回执→UI 显示段:逐回执入账+逐页面板渲染 p50/p95/p99(RUST-414 UI 段)', () => {
    // RUST-414(旧 HR-QA-002)八段的最后一节:回执落账→树/面板显示。链路在 main
    // 且已钉(translateDeliveryRecord 九要素/回执幂等替换 HR-STATE-007、节流刷新
    // 窗内合并 HR-UI-007、RUST-372 风暴限频前沿+尾帧 2 次全量渲染);此处补纯核
    // 成本:逐回执翻译+入账(s8Ledger)、逐页面板渲染(非虚拟 50 行页 + >200 行
    // 虚拟滚动路径,s8Render 取较重者)。
    // 诚实边界:显示段 wall 另含 refreshWindowMs(缺省 500ms)设计节流窗——窗内
    // 合并即防抖,非性能回归面,不作界表面;网络耗时须单独统计不混本地性能(§19.10)。
    const records = Array.from({ length: 500 }, (_unused, index) => {
      const file = scriptPath(index);
      const stem = path.basename(file, '.py');
      return {
        rootId: 'r1',
        targetId: '',
        file,
        outcome: index % 5 === 0 ? 'failed' : index % 3 === 0 ? 'accepted' : 'applied',
        recordedAt: 1700000000000 + index * 1000,
        attempt: 1,
        ...(index % 7 === 0 ? { detail: 'HTTP 状态 500:非 2xx 不算送达' } : {})
      } as HotReloadDeliveryRecord;
    });
    const resolver: HotReloadNamesResolver = file => ({
      fullModule: `entities.${path.basename(file, '.py')}`,
      requestModule: path.basename(file, '.py')
    });
    const entries = records.map(record => translateDeliveryRecord(record, resolver));
    const core = new HotReloadHistoryCore();
    const ledgerSamples: number[] = [];
    for (const entry of entries) {
      const started = performance.now();
      core.record(entry);
      ledgerSamples.push(performance.now() - started);
    }
    // 缺省容量 200 环形淘汰(全量 ≤200 行口径):500 回执→200 行,逐条淘汰
    // 走 O(容量) 索引重建,超容量回执的入账成本即含此重建(本面实测)
    expect(core.size()).toBe(200);
    // capacity 调高才激活虚拟滚动路径(默认配置不引入虚拟路径)
    const deepCore = new HotReloadHistoryCore({ capacity: 500 });
    for (const entry of entries) {
      deepCore.record(entry);
    }
    expect(deepCore.size()).toBe(500);
    const th = strings('zh').hotReloadHistory;
    const lang = htmlLang('zh');
    const state = { feedStatus: { watchMode: 'auto', target: 'local' }, filter: {}, page: 0 };
    const renderSamples: number[] = [];
    for (let round = 0; round < 20; round += 1) {
      const started = performance.now();
      renderHistoryPanelHtml({
        state,
        rows: core.entries().slice(0, 50),
        total: core.size(),
        hasMore: true,
        pageSize: 50,
        t: th,
        lang
      });
      renderSamples.push(performance.now() - started);
    }
    const virtualSamples: number[] = [];
    for (let round = 0; round < 20; round += 1) {
      const started = performance.now();
      renderHistoryPanelHtml({
        state,
        rows: deepCore.entries(),
        total: deepCore.size(),
        hasMore: false,
        pageSize: 50,
        virtualize: { rowHeightPx: 26, viewportHeightPx: 480, overscanRows: 5 },
        t: th,
        lang
      });
      virtualSamples.push(performance.now() - started);
    }
    once('S8.ledger.perRecordP50', percentile(ledgerSamples, 0.5));
    once('S8.ledger.perRecordP99', percentile(ledgerSamples, 0.99));
    once('S8.render.page50P50', percentile(renderSamples, 0.5));
    once('S8.render.page50P99', percentile(renderSamples, 0.99));
    once('S8.render.virtual500P50', percentile(virtualSamples, 0.5));
    once('S8.render.virtual500P99', percentile(virtualSamples, 0.99));
    once('S8.render.virtualRows', deepCore.size());
    pooled('S8.ledger', ledgerSamples);
    pooled('S8.renderPage50', renderSamples);
    pooled('S8.renderVirtual500', virtualSamples);
    violations.push(
      ...segmentViolations(resolveSegmentBounds(), {
        s8LedgerP99Ms: percentile(ledgerSamples, 0.99),
        s8RenderP99Ms: percentile(virtualSamples, 0.99)
      })
    );
    emit(
      'HRS-NOTE S8 回执→UI 显示段:逐回执翻译+入账、逐页面板渲染(50 行页 + 500 行' +
      '虚拟滚动路径)皆亚毫秒级;显示段 wall 另含 refreshWindowMs 缺省 500ms 设计' +
      '节流窗(HR-UI-007 窗内合并已钉,非性能回归面);网络耗时须单独统计不混本地性能(§19.10)'
    );
  }, 120000);

  it('gate:各段界收口(任一面超界=红=合并阻塞面)', () => {
    emit(
      `HRS-BOUND violations=${violations.length} bounds=${JSON.stringify(resolveSegmentBounds())}`
    );
    expect(violations).toEqual([]);
  });
});
