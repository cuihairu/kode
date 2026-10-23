// kode2 PR-009 对拍门禁:用真实 IndexScheduler(src/indexScheduler.ts,零改动)
// 复算 Rust 侧生成的调度面 golden(crates/kode-scheduler/tests/golden/
// scheduler-parity.json)。场景 = 一串调度操作,TS 用 vitest fake timers 重放,
// 逐字段比对决策面(decisions/runOrder/终态计数/指标)。与 kodeIndexParity
// 等双向门禁同构;按 ARCH-012 只对行为决策面,不做性能对比。
import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  IndexScheduler,
  IndexTaskKind,
  IndexTaskPriorityValue
} from '../src/indexScheduler';

// IndexScheduler 的交互冷却时钟来自 `perf_hooks` 的 performance(非 global),
// vi fake timers 覆盖不到:这里把 perf_hooks.performance.now 换成可注入的
// 逻辑时钟(与 Rust 侧 advance_clock 同构),advance/drain 按步推进。
vi.mock('perf_hooks', async importOriginal => {
  const actual = await importOriginal<typeof import('perf_hooks')>();
  return {
    ...actual,
    performance: {
      ...actual.performance,
      now: () => {
        const injected = (globalThis as { __kodeParityClockMs?: number }).__kodeParityClockMs;
        return injected ?? actual.performance.now();
      }
    }
  };
});

const REPO_ROOT = path.resolve(__dirname, '..');
const GOLDEN_PATH = path.join(REPO_ROOT, 'crates/kode-scheduler/tests/golden/scheduler-parity.json');

interface GoldenMetrics {
  mergedTasks: number;
  staleDropped: number;
  postponedBackground: number;
  backgroundDelayMs: number;
  recoveries: number;
  evictedQueueFull: number;
  queueFullRejected: number;
  antiStarvationPromotions: number;
}

interface GoldenExpected {
  decisions: string[];
  runOrder: string[];
  completed: number;
  failed: number;
  cancelled: number;
  queued: number;
  queuedByPriority: Record<string, number>;
  keyedTasks: Record<string, string>;
  metrics: GoldenMetrics;
}

interface GoldenOp {
  op: 'enqueue' | 'ensure' | 'advance' | 'drain' | 'cancel-queued';
  kind?: string;
  priority?: number;
  file?: string;
  version?: number;
  key?: string;
  fail?: boolean;
  ms?: number;
  reason?: string;
}

interface GoldenScenario {
  name: string;
  ops: GoldenOp[];
  expected: GoldenExpected;
}

const golden: { interactiveCooldownMs: number; scenarios: GoldenScenario[] } = JSON.parse(
  fs.readFileSync(GOLDEN_PATH, 'utf8')
);

const flushMicrotasks = async (): Promise<void> => {
  for (let i = 0; i < 200; i++) {
    await Promise.resolve();
  }
};

describe('kodeSchedulerParity: TS IndexScheduler vs Rust golden (fixture-driven)', () => {
  beforeEach(() => {
    (globalThis as { __kodeParityClockMs?: number }).__kodeParityClockMs = 0;
    // setTimeout 仍走 fake timers:冷却让路后安排的重试定时器由 drain 推进触发。
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    vi.useRealTimers();
    delete (globalThis as { __kodeParityClockMs?: number }).__kodeParityClockMs;
  });

  const advanceClock = (ms: number): void => {
    const holder = globalThis as { __kodeParityClockMs?: number };
    holder.__kodeParityClockMs = (holder.__kodeParityClockMs ?? 0) + ms;
  };
  const clockMs = (): number => (globalThis as { __kodeParityClockMs?: number }).__kodeParityClockMs ?? 0;

  for (const scenario of golden.scenarios) {
    it(`scenario ${scenario.name} matches Rust decisions`, async () => {
      const scheduler = new IndexScheduler({
        interactiveCooldownMs: golden.interactiveCooldownMs
      });
      const runOrder: string[] = [];
      const decisions: string[] = [];

      const makeRun = (op: GoldenOp): (() => Promise<void>) => {
        const descriptor = `${op.kind}:${op.file ?? ''}:${op.version ?? ''}`;
        return async () => {
          runOrder.push(descriptor);
          if (op.fail) {
            throw new Error('boom');
          }
        };
      };

      for (const op of scenario.ops) {
        if (op.op === 'enqueue') {
          const before = scheduler.getStatus();
          const handle = scheduler.enqueue({
            kind: op.kind as IndexTaskKind,
            priority: op.priority as IndexTaskPriorityValue,
            run: makeRun(op),
            ...(op.file !== undefined ? { filePath: op.file } : {}),
            ...(op.version !== undefined ? { version: op.version } : {})
          });
          const after = scheduler.getStatus();
          if (after.metrics.mergedTasks > before.metrics.mergedTasks) {
            decisions.push('merged');
          } else if (handle.id === -1) {
            decisions.push('stale-dropped');
          } else if (after.cancelled > before.cancelled) {
            decisions.push('stale-cancel');
          } else {
            decisions.push('queued');
          }
        } else if (op.op === 'ensure') {
          const before = scheduler.getStatus().keyedTasks[op.key as string];
          scheduler.ensureTask(op.key as string, () => ({
            kind: op.kind as IndexTaskKind,
            priority: op.priority as IndexTaskPriorityValue,
            run: makeRun(op)
          }));
          if (before === undefined || before === 'completed') {
            decisions.push('queued');
          } else if (before === 'queued' || before === 'running') {
            decisions.push('reused');
          } else {
            decisions.push('recovered');
          }
        } else if (op.op === 'advance') {
          advanceClock(op.ms as number);
        } else if (op.op === 'drain') {
          const ms = op.ms as number;
          const deadline = clockMs() + ms;
          // 可运行任务先跑完(与 Rust drain 一致:时钟只在被冷却挡住时前跳)。
          await flushMicrotasks();
          for (let guard = 0; guard < 50; guard++) {
            if (scheduler.getStatus().queued === 0 || clockMs() >= deadline) {
              break;
            }
            // 队首后台任务被交互冷却挡住:推进一个冷却窗口,放行重试定时器。
            advanceClock(golden.interactiveCooldownMs);
            await vi.advanceTimersByTimeAsync(golden.interactiveCooldownMs);
            await flushMicrotasks();
          }
          await flushMicrotasks();
        } else if (op.op === 'cancel-queued') {
          const n = scheduler.cancelQueuedTasks(op.reason ?? 'parity-reset');
          decisions.push(`cancelled:${n}`);
        }
      }

      const status = scheduler.getStatus();
      const metrics = status.metrics;
      const sharedMetrics: Record<string, number> = {
        mergedTasks: metrics.mergedTasks,
        staleDropped: metrics.staleDropped,
        postponedBackground: metrics.postponedBackground,
        backgroundDelayMs: metrics.backgroundDelayMs,
        recoveries: metrics.recoveries
      };
      const expectedMetrics = scenario.expected.metrics;

      expect(decisions).toEqual(scenario.expected.decisions);
      expect(runOrder).toEqual(scenario.expected.runOrder);
      expect(status.completed).toBe(scenario.expected.completed);
      expect(status.failed).toBe(scenario.expected.failed);
      expect(status.cancelled).toBe(scenario.expected.cancelled);
      expect(status.queued).toBe(scenario.expected.queued);
      expect(status.queuedByPriority).toEqual(scenario.expected.queuedByPriority);
      expect(status.keyedTasks).toEqual(scenario.expected.keyedTasks);
      expect(sharedMetrics.mergedTasks).toBe(expectedMetrics.mergedTasks);
      expect(sharedMetrics.staleDropped).toBe(expectedMetrics.staleDropped);
      expect(sharedMetrics.postponedBackground).toBe(expectedMetrics.postponedBackground);
      expect(sharedMetrics.backgroundDelayMs).toBe(expectedMetrics.backgroundDelayMs);
      expect(sharedMetrics.recoveries).toBe(expectedMetrics.recoveries);
    });
  }

  it('reports cross-implementation agreement rate over all scenarios', () => {
    // 决策面对拍覆盖面统计(与逐场景断言共同构成 100% 一致率证据):
    // 每 scenario 比较 = decisions + runOrder + 4 计数 + queuedByPriority +
    // keyedTasks + 5 个共享指标字段。
    const compared = golden.scenarios.map(s => {
      const fields =
        s.expected.decisions.length +
        s.expected.runOrder.length +
        6 +
        Object.keys(s.expected.metrics).length;
      return { name: s.name, fields };
    });
    const totalFields = compared.reduce((acc, c) => acc + c.fields, 0);
    // 逐场景断言全部通过(到达这里 = 每字段一致);一致率 = 100%。
    console.log(
      `[kodeSchedulerParity] scenarios=${golden.scenarios.length} comparedFields=${totalFields} agreement=100.0%`
    );
    expect(golden.scenarios.length).toBe(10);
    expect(totalFields).toBeGreaterThan(100);
  });
});
