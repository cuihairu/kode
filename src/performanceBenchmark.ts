import { performance } from 'perf_hooks';

export interface BenchmarkSample {
  readonly name: string;
  readonly durationMs: number;
}

export interface StartupBenchmarkReport {
  readonly samples: BenchmarkSample[];
  readonly totalMs: number;
  readonly budgetMs: number;
  readonly withinBudget: boolean;
}

export function benchmarkStartupPerformance(
  tasks: Record<string, () => void | Promise<void>>,
  budgetMs = 250
): Promise<StartupBenchmarkReport> {
  const samples: BenchmarkSample[] = [];
  return (async () => {
    const totalStart = performance.now();
    for (const [name, task] of Object.entries(tasks)) {
      const started = performance.now();
      await task();
      samples.push({ name, durationMs: Number((performance.now() - started).toFixed(3)) });
    }
    const totalMs = Number((performance.now() - totalStart).toFixed(3));
    return {
      samples,
      totalMs,
      budgetMs,
      withinBudget: totalMs <= budgetMs
    };
  })();
}
