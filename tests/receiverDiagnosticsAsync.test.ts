import { afterEach, describe, expect, it } from 'vitest';
import { DiagnosticScheduler } from '../src/diagnosticScheduler';
import {
  computeReceiverNoneFindings,
  computeReceiverNoneFindingsAsync
} from '../src/receiverNoneDiagnostics';

// IDE-DIA-005:大文件 receiver 诊断移出同步入口——计算分片让出宿主
// (8,000 调用样本计算期间定时器仍能插进来),版本前进即中止返回 null
// (旧版本回包丢弃),调度器异步面完成后复核版本才发布。

afterEach(() => {
  // 模块级计数器复位(guard 扫描计数在 receiverGuardMethodMemo.test.ts 面测)
});

/** 8,000 调用样本:一个方法体内 8,000 处 self.cell.mN() 无 guard 调用 */
function bigSource(calls: number): string {
  const lines: string[] = ['class Avatar(Base):', '    def tick(self):'];
  for (let i = 0; i < calls; i += 1) {
    lines.push(`        self.cell.m${i}()`);
  }
  lines.push('');
  return lines.join('\n');
}

interface MutableDoc {
  uri: { toString(): string };
  version: number;
}

describe('IDE-DIA-005:receiver 诊断异步分片计算', () => {
  it('8,000 调用样本:计算期间宿主可响应,产出与同步面一致', async () => {
    const text = bigSource(8000);
    // 同步面基准
    const syncFindings = computeReceiverNoneFindings(text, '/ws/big.py');
    expect(syncFindings).toHaveLength(8000);

    let hostServed = false;
    setTimeout(() => { hostServed = true; }, 0);
    const asyncFindings = await computeReceiverNoneFindingsAsync(text, '/ws/big.py');
    // 异步分片期间宿主拿到了控制权(定时器在计算完成前已执行)
    expect(hostServed).toBe(true);
    expect(asyncFindings).not.toBeNull();
    expect((asyncFindings as typeof syncFindings).length).toBe(syncFindings.length);
  });

  it('版本前进即中止:shouldContinue 为假返回 null(旧版本回包丢弃)', async () => {
    const text = bigSource(2000);
    let chunks = 0;
    const findings = await computeReceiverNoneFindingsAsync(text, '/ws/big.py', undefined, undefined, {
      chunkSize: 100,
      yieldToHost: async () => { chunks += 1; },
      shouldContinue: () => chunks < 3 // 第 3 次让出后版本不再匹配
    });
    expect(findings).toBeNull(); // 中止不产出部分结果
    expect(chunks).toBeGreaterThanOrEqual(3);
    expect(chunks).toBeLessThan(20); // 远未扫完 2,000 调用即停
  });
});

describe('IDE-DIA-005:诊断调度器异步面', () => {
  it('computeAsync 完成后复核版本才发布;版本前进丢弃不发布', async () => {
    const scheduler = new DiagnosticScheduler();
    const document: MutableDoc = { uri: { toString: () => 'file:///a.py' }, version: 1 };
    const published: number[][] = [];
    let releaseCompute: (() => void) | null = null;
    const gate = new Promise<void>(resolve => { releaseCompute = resolve; });

    const options = {
      layer: 'local' as const,
      computeAsync: async (): Promise<number[] | null> => {
        await gate; // 挂起计算,期间文档版本前进
        return [1, 2, 3];
      },
      publish: (items: readonly number[]) => { published.push([...items]); }
    };
    scheduler.requestQueued(document, options);
    scheduler.flushQueued();
    expect(published).toEqual([]); // 异步计算未完成不发布
    expect(scheduler.hasPendingComputations()).toBe(true);

    document.version = 2; // 计算期间版本前进
    releaseCompute!();
    await scheduler.pendingComputations();
    expect(published).toEqual([]); // 旧版本回包丢弃
    expect(scheduler.getStats().staleDropped).toBe(1);
    expect(scheduler.getStats().published).toBe(0);
  });

  it('computeAsync 返回 null(中止)记过期不发布;同版本完成正常发布', async () => {
    const scheduler = new DiagnosticScheduler();
    const document: MutableDoc = { uri: { toString: () => 'file:///b.py' }, version: 7 };
    const published: number[][] = [];

    scheduler.request(document, {
      layer: 'local',
      computeAsync: async () => null, // 中止口径
      publish: (items: readonly number[]) => { published.push([...items]); }
    });
    await scheduler.pendingComputations();
    expect(published).toEqual([]);
    expect(scheduler.getStats().staleDropped).toBe(1);

    scheduler.request(document, {
      layer: 'local',
      computeAsync: async () => [9],
      publish: (items: readonly number[]) => { published.push([...items]); }
    });
    await scheduler.pendingComputations();
    expect(published).toEqual([[9]]);
    expect(scheduler.getStats().published).toBe(1);
    expect(scheduler.getStats().computed).toBe(2);
  });
});
