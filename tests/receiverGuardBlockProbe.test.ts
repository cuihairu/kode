import { afterEach, describe, expect, it } from 'vitest';
import {
  computeReceiverNoneFindings,
  getGuardBlockProbeCountForTests,
  resetGuardBlockProbeCountForTests
} from '../src/receiverNoneDiagnostics';

// 2026-10-28 审核整改(DIA-004 二次方残留):guard 候选记忆化之后,逐调用
// 仍对每个候选重跑 blockContains/blockExits(从 guard 行扫到 use 行)——
// 同 guard 下 1k/2k/4k 调用 ≈ 324/1265/4875ms,仍是平方级。整改:块界/
// 早退位置在 guard 前缀扫描时一次预计算(每候选一次),逐调用只做位置闸
// (O(1)),不再触碰文本。
// 验证口径(审核令「操作计数和事件循环延迟」):
// a) 块探测计数:guard 前缀扫描期每候选恰 1 次,逐调用 0 次;
// b) 规模比:同 guard 下 4k 调用耗时不超 1k 的 8 倍(平方级 ≈ 15 倍)。

const FILE = '/ws/avatar.py';

const guardedCallsSource = (callCount: number): string => [
  'class Avatar(Base):',
  '    def tick(self):',
  '        if self.cell:',
  ...Array.from({ length: callCount }, (_, i) => `            self.cell.m${i}()`),
  ''
].join('\n');

const blockClosesSource = [
  'class Avatar(Base):',
  '    def tick(self):',
  '        if self.cell:',
  '            self.cell.a()',
  '        ready = True',
  '        self.cell.b()',
  ''
].join('\n');

afterEach(() => {
  resetGuardBlockProbeCountForTests();
});

describe('2026-10-28 审核整改:guard 块界预计算,逐调用零文本重扫', () => {
  it('块探测只在扫描期发生:1 guard + 200 块内调用,探测数 = 1(非 199)', () => {
    const findings = computeReceiverNoneFindings(guardedCallsSource(200), FILE);
    // 全部调用都在 guard 块内 → 无告警(语义保持)
    expect(findings.filter(finding => finding.kind === 'receiver-none')).toHaveLength(0);
    expect(getGuardBlockProbeCountForTests()).toBe(1);
  });

  it('块已闭的后续使用仍报:预计算不改变告警语义', () => {
    const findings = computeReceiverNoneFindings(blockClosesSource, FILE);
    const reported = findings
      .filter(finding => finding.kind === 'receiver-none')
      .map(finding => finding.methodName)
      .sort();
    expect(reported).toEqual(['b']); // a 在块内不报;b 前有去缩进行,块已闭 → 报
  });

  it('规模比近线性:同 guard 下 4k 调用 < 8×1k 耗时', () => {
    const timed = (callCount: number): number => {
      const source = guardedCallsSource(callCount);
      const start = process.hrtime.bigint();
      computeReceiverNoneFindings(source, FILE);
      return Number(process.hrtime.bigint() - start) / 1e6;
    };
    timed(200); // 预热(JIT/缓存)
    const t1k = timed(1000);
    const t4k = timed(4000);
    expect(t4k).toBeLessThan(t1k * 8);
  });
});
