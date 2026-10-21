import { describe, expect, it } from 'vitest';
import { benchmarkStartupPerformance } from '../src/performanceBenchmark';

describe('startup performance benchmark', () => {
  it('records named samples and evaluates the activation budget', async () => {
    const report = await benchmarkStartupPerformance({
      imports: () => undefined,
      graph: () => Array.from({ length: 1000 }, (_, index) => index).filter(value => value % 2 === 0)
    }, 250);
    expect(report.samples.map(sample => sample.name)).toEqual(['imports', 'graph']);
    expect(report.samples.every(sample => sample.durationMs >= 0)).toBe(true);
    expect(report.withinBudget).toBe(true);
    expect(report.totalMs).toBeGreaterThanOrEqual(report.samples.reduce((total, sample) => total + sample.durationMs, 0) - 0.1);
  });
});
