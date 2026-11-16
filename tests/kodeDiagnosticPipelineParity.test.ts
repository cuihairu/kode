// kode2 Phase2 诊断调度状态机回放对拍门禁(RUST-142 批 1):读 Rust 侧
// 生成的 golden(crates/kode-server/tests/golden/diagnostic-pipeline-parity.json)
// 的 traces 驱动**生产** DiagnosticScheduler(四层管线 = 4 个独立实例,每层
// 独立节流)逐迹复算,逐条对拍 outcomes(publishLog/stats/workload)——
// 语义真值源是生产调度器,镜像红 = Rust 移植错,按 src/backend/
// diagnosticScheduler.ts 源码重推(本文件只读 golden,不改 src/)。
//
// 解释器与生产微任务序同构:computeAsync 用 async fn + await gate 形态
// (体恢复先于 flush-resume 排队、返回值落定才排 onOk 尾随——让出窗口
// resolve 的异步,其发布落在 flush 恢复并处理完同步条目之后);每事件后
// await setImmediate 排空微任务与定时器前队列。
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { DiagnosticScheduler } from '../src/backend/diagnosticScheduler';

const REPO_ROOT = path.resolve(__dirname, '..');
const GOLDEN_PATH = path.join(REPO_ROOT, 'crates/kode-server/tests/golden/diagnostic-pipeline-parity.json');

/** 回放管线层名(golden BTreeMap 字节序:engineCompat < localSyntax <
 *  runtimeConfig < semantic;publishLog 按此序拼接) */
const PIPELINE_LAYERS = ['engineCompat', 'localSyntax', 'runtimeConfig', 'semantic'] as const;
type PipelineLayer = (typeof PIPELINE_LAYERS)[number];

/** golden 事件面(Rust TraceEvent 的 serde 序列化形态;tag = "op") */
interface GoldenEvent {
  op: 'request' | 'requestQueued' | 'flush' | 'resolveAsync' | 'awaitMacrotask' | 'release' | 'setEnabled' | 'invalidate';
  uri?: string;
  version?: number | null;
  items?: number[];
  async_compute?: boolean;
  side_effects?: Array<{ op: 'mutateVersion'; version: number } | { op: 'release'; uri: string }>;
  slice_ms?: number;
  during_yields?: GoldenEvent[];
  async_id?: number;
  outcome?: { op: 'items'; items: number[] } | { op: 'null' } | { op: 'error' };
  enabled?: boolean;
  layer?: string;
}

interface GoldenTrace {
  name: string;
  events: GoldenEvent[];
}

interface GoldenOutcome {
  name: string;
  publishLog: Array<{ op: 'publish' | 'clearAll'; layer: string; uri?: string; items?: number[] }>;
  stats: Record<PipelineLayer, Record<string, number>>;
  workload: Record<PipelineLayer, { queued: number; inFlight: number }>;
}

/** 回放态:四层生产调度器 + 发布收集 + 异步 gate 表(事件时刻分配 id,
 *  与 Rust make_task 事件时刻分配 async_id 同刻同序) */
interface ReplayState {
  pipeline: Record<PipelineLayer, DiagnosticScheduler>;
  records: Array<{ op: 'publish' | 'clearAll'; layer: PipelineLayer; uri?: string; items?: number[] }>;
  gates: Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>;
  nextAsyncId: Record<PipelineLayer, number>;
  /** flush 让出脚本(构造器级 yieldToHost 经此读取当轮脚本) */
  script: GoldenEvent[];
  scriptIndex: number;
}

const isPipelineLayer = (layer: string): layer is PipelineLayer =>
  (PIPELINE_LAYERS as readonly string[]).includes(layer);

const layerOf = (event: GoldenEvent): PipelineLayer => {
  const layer = event.layer ?? 'localSyntax';
  expect(isPipelineLayer(layer), `事件层名非法: ${layer}`).toBe(true);
  return layer;
};

/** TS DiagnosticLayer 只有 local|semantic 两值(只影响 metrics fileKind,
 *  不影响调度语义);目标设计面四层在 TS 侧按 local 路由 */
const tsLayer = (layer: PipelineLayer): 'local' | 'semantic' => (layer === 'semantic' ? 'semantic' : 'local');

const makeDoc = (event: { uri: string; version?: number | null }): { uri: { toString(): string }; version?: number } => ({
  uri: { toString: () => event.uri },
  version: event.version === null || event.version === undefined ? undefined : event.version
});

const drainHost = (): Promise<void> => new Promise(resolve => { setImmediate(resolve); });

/** 计算体内重入副作用(MutateVersion 改本任务捕获的 doc 对象;Release
 *  重入同层 releaseDocument) */
const applyEffects = (
  effects: GoldenEvent['side_effects'],
  document: { uri: { toString(): string }; version?: number },
  state: ReplayState,
  layer: PipelineLayer
): void => {
  for (const effect of effects ?? []) {
    if (effect.op === 'mutateVersion') {
      document.version = effect.version;
    } else {
      state.pipeline[layer].releaseDocument(document);
    }
  }
};

const runEvent = async (event: GoldenEvent, state: ReplayState): Promise<void> => {
  const layer = layerOf(event);
  const scheduler = state.pipeline[layer];
  switch (event.op) {
    case 'request':
    case 'requestQueued': {
      const document = makeDoc(event);
      const options: {
        layer: 'local' | 'semantic';
        compute?: () => readonly number[];
        computeAsync?: () => Promise<readonly number[] | null>;
        publish: (items: readonly number[]) => void;
      } = {
        layer: tsLayer(layer),
        publish: items => { state.records.push({ op: 'publish', layer, uri: event.uri, items: [...items] }); }
      };
      if (event.async_compute === true) {
        // gate 于事件时刻预建(async_id 分配序与 Rust make_task 同刻同序);
        // computeAsync 用 async fn + await gate 形态(生产 worker 形状):
        // gate 拒绝 → 体内后续(副作用)不执行;正常落定 → 副作用 → 返回值
        const asyncId = state.nextAsyncId[layer];
        state.nextAsyncId[layer] = asyncId + 1;
        let resolveFn!: (value: unknown) => void;
        let rejectFn!: (error: Error) => void;
        const gate = new Promise((resolve, reject) => { resolveFn = resolve; rejectFn = reject; });
        state.gates.set(asyncId, { resolve: resolveFn, reject: rejectFn });
        options.computeAsync = async () => {
          const outcome = await gate;
          applyEffects(event.side_effects, document, state, layer);
          return outcome as readonly number[] | null;
        };
      } else {
        options.compute = () => {
          applyEffects(event.side_effects, document, state, layer);
          return event.items ?? [];
        };
      }
      if (event.op === 'request') {
        scheduler.request(document, options);
      } else {
        scheduler.requestQueued(document, options);
      }
      break;
    }
    case 'flush': {
      state.script = event.during_yields ?? [];
      state.scriptIndex = 0;
      await scheduler.flushQueued();
      break;
    }
    case 'resolveAsync': {
      const gate = state.gates.get(event.async_id ?? -1);
      expect(gate, `resolveAsync 指向未分配的 async_id: ${event.async_id}`).toBeDefined();
      const outcome = event.outcome;
      expect(outcome, 'resolveAsync 缺 outcome').toBeDefined();
      if (outcome!.op === 'items') {
        gate!.resolve(outcome!.items);
      } else if (outcome!.op === 'null') {
        gate!.resolve(null);
      } else {
        gate!.reject(new Error('trace async error'));
      }
      break;
    }
    case 'awaitMacrotask':
      // 解释器每事件后的 setImmediate 排空已覆盖宏任务边界
      break;
    case 'release':
      scheduler.releaseDocument(makeDoc(event));
      break;
    case 'setEnabled':
      scheduler.setEnabled(event.enabled === true, () => {
        state.records.push({ op: 'clearAll', layer });
      });
      break;
    case 'invalidate':
      scheduler.invalidateAll();
      break;
  }
  await drainHost();
};

/** 逐迹回放:四层管线,事件按层路由(返回与 golden TraceOutcome 同构) */
const replayTrace = async (trace: GoldenTrace): Promise<GoldenOutcome> => {
  const state: ReplayState = {
    pipeline: {
      engineCompat: new DiagnosticScheduler(),
      localSyntax: new DiagnosticScheduler(),
      runtimeConfig: new DiagnosticScheduler(),
      semantic: new DiagnosticScheduler()
    },
    records: [],
    gates: new Map(),
    nextAsyncId: { engineCompat: 0, localSyntax: 0, runtimeConfig: 0, semantic: 0 },
    script: [],
    scriptIndex: 0
  };
  // sliceMs 构造器级:回放迹内所有 flush 共用同一域(0=每条目必让出 /
  // 巨值=零让出);生产 yieldToHost 每次让出同步跑一条脚本事件
  const flushSlices = new Set<number>();
  const collectSlices = (events: GoldenEvent[]): void => {
    for (const event of events) {
      if (event.op === 'flush') {
        flushSlices.add(event.slice_ms ?? Number.NaN);
        collectSlices(event.during_yields ?? []);
      }
    }
  };
  collectSlices(trace.events);
  expect(flushSlices.size, `迹 ${trace.name} flush slice_ms 必须一致(构造器级)`).toBeLessThanOrEqual(1);
  const sliceMs = [...flushSlices][0];
  for (const layer of PIPELINE_LAYERS) {
    state.pipeline[layer] = new DiagnosticScheduler({
      sliceMs,
      // 生产让出面形状:setImmediate 宏任务边界;脚本事件(外部 resolve)
      // 是让出窗口内的宏任务轮,gate 续延链是微任务、在 flush 恢复宏任务
      // 之前排空——让出窗口 resolve 的异步先于 flush 恢复发布
      yieldToHost: async () => {
        await new Promise<void>(resolve => { setImmediate(resolve); });
        const scriptEvent = state.script[state.scriptIndex];
        state.scriptIndex += 1;
        if (scriptEvent) {
          await runEvent(scriptEvent, state);
        }
      }
    });
  }
  for (const event of trace.events) {
    await runEvent(event, state);
  }
  // publishLog 按层名字节序拼接(golden BTreeMap 序)
  const publishLog: GoldenOutcome['publishLog'] = [];
  for (const layer of PIPELINE_LAYERS) {
    for (const record of state.records) {
      if (record.layer === layer) {
        publishLog.push(record);
      }
    }
  }
  return {
    name: trace.name,
    publishLog,
    stats: {
      engineCompat: { ...state.pipeline.engineCompat.getStats() },
      localSyntax: { ...state.pipeline.localSyntax.getStats() },
      runtimeConfig: { ...state.pipeline.runtimeConfig.getStats() },
      semantic: { ...state.pipeline.semantic.getStats() }
    },
    workload: {
      engineCompat: state.pipeline.engineCompat.pendingWorkload(),
      localSyntax: state.pipeline.localSyntax.pendingWorkload(),
      runtimeConfig: state.pipeline.runtimeConfig.pendingWorkload(),
      semantic: state.pipeline.semantic.pendingWorkload()
    }
  };
};

describe('kode2 Phase2 诊断调度回放对拍(Rust golden ↔ 生产调度器复算)', () => {
  const golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8')) as {
    generator: string;
    traceCount: number;
    traces: GoldenTrace[];
    outcomes: GoldenOutcome[];
  };

  it('golden 语料同集与规模(17 迹权威定义)', () => {
    expect(golden.generator).toBe('dump-diagnostic-pipeline-golden');
    expect(golden.traceCount).toBe(golden.traces.length);
    expect(golden.traceCount).toBe(golden.outcomes.length);
    expect(golden.traceCount).toBe(17);
    for (const [index, trace] of golden.traces.entries()) {
      expect(trace.events.length, `迹 ${trace.name} 事件表非空`).toBeGreaterThan(0);
      expect(golden.outcomes[index].name).toBe(trace.name);
    }
  });

  it('逐迹复算深等(生产四层管线:publishLog/stats/workload)', { timeout: 120_000 }, async () => {
    for (const [index, trace] of golden.traces.entries()) {
      const replayed = await replayTrace(trace);
      expect(replayed.publishLog, `迹 ${trace.name} 发布序`).toEqual(golden.outcomes[index].publishLog);
      expect(replayed.stats, `迹 ${trace.name} 四层统计`).toEqual(golden.outcomes[index].stats);
      expect(replayed.workload, `迹 ${trace.name} 四层残留量规`).toEqual(golden.outcomes[index].workload);
    }
  });

  it('护栏:发布记录层名合法 + 12 计数器全点亮(镜像复算面独立审计)', async () => {
    const counterKeys = [
      'requested', 'computed', 'published', 'coalescedStale', 'staleDropped',
      'releasedDropped', 'skippedCurrentVersion', 'disabledSkipped',
      'disabledAsyncDropped', 'staleGenerationDropped', 'errored', 'cleared'
    ];
    const lit = new Set<string>();
    for (const [index, trace] of golden.traces.entries()) {
      const replayed = await replayTrace(trace);
      for (const record of replayed.publishLog) {
        expect(isPipelineLayer(record.layer), `发布层名非法: ${record.layer}`).toBe(true);
        if (record.op === 'publish') {
          expect(Array.isArray(record.items), `发布缺 items: ${JSON.stringify(record)}`).toBe(true);
          expect(typeof record.uri).toBe('string');
        }
      }
      for (const per of Object.values(replayed.stats)) {
        expect(Object.keys(per).sort()).toEqual([...counterKeys].sort());
        for (const key of counterKeys) {
          if (per[key] > 0) {
            lit.add(key);
          }
        }
      }
    }
    for (const key of counterKeys) {
      expect(lit.has(key), `计数器 ${key} 未被任何镜像复算点亮`).toBe(true);
    }
  });
});
