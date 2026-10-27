import { afterEach, describe, expect, it } from 'vitest';
import {
  computeReceiverNoneFindings,
  getGuardPrefixScanCountForTests,
  resetGuardPrefixScanCountForTests
} from '../src/receiverNoneDiagnostics';

// IDE-DIA-004:按方法复用 receiver guard 分析——同方法同接收者的多处调用
// 共享一次 guard 前缀扫描(候选行一次收集,逐调用只过闸判定),不再每个
// 调用点从头遍历;既有告警语义保持(含正向 guard 保护块内后续同缩进使用
// 的保守口径)。

const FILE = '/ws/avatar.py';

const multiCallSource = [
  'class Avatar(Base):',
  '    def tick(self):',
  '        self.cell.a()',        // guard 前 → 报
  '        if self.cell:',
  '            self.cell.b()',    // guard 块内(缩进更深) → 不报
  '        self.cell.c()',        // 去缩进回 use 同缩进,ifIndent < useIndent 不成立 → 报(旧语义同口径)
  '',
  '    def tock(self):',
  '        self.cell.d()',        // 另一方法无 guard → 报
  '        self.cell.e()',
  ''
].join('\n');

const crossReceiverSource = [
  'class Avatar(Base):',
  '    def ping(self):',
  '        self.cell.a()',
  '        self.client.b()',
  ''
].join('\n');

afterEach(() => {
  resetGuardPrefixScanCountForTests();
});

describe('IDE-DIA-004:按方法复用 receiver guard 分析', () => {
  it('同方法同接收者多次调用只做一次 guard 前缀扫描', () => {
    resetGuardPrefixScanCountForTests();
    const findings = computeReceiverNoneFindings(multiCallSource, FILE);

    // 语义保持:tick 的 a/c 报、b 不报;tock 的 d/e 各报(与逐点遍历旧口径一致)
    const reported = findings
      .filter(finding => finding.kind === 'receiver-none')
      .map(finding => finding.methodName)
      .sort();
    expect(reported).toEqual(['a', 'c', 'd', 'e']);

    // tick(cell) 一次 + tock(cell) 一次 = 2,而非逐调用 5 次
    expect(getGuardPrefixScanCountForTests()).toBe(2);
  });

  it('同方法不同接收者各扫一次(候选按接收者分账)', () => {
    resetGuardPrefixScanCountForTests();
    const findings = computeReceiverNoneFindings(crossReceiverSource, FILE);
    expect(findings.filter(finding => finding.kind === 'receiver-none')).toHaveLength(2);
    expect(getGuardPrefixScanCountForTests()).toBe(2);
  });

  it('无 guard 方法与有 guard 方法共享语义:重复计算幂等且扫描数稳定', () => {
    resetGuardPrefixScanCountForTests();
    const first = computeReceiverNoneFindings(multiCallSource, FILE);
    const scansAfterFirst = getGuardPrefixScanCountForTests();
    const second = computeReceiverNoneFindings(multiCallSource, FILE);
    expect(second).toEqual(first); // 逐次计算幂等(同文本同产出)
    expect(getGuardPrefixScanCountForTests()).toBe(scansAfterFirst * 2); // 复用不跨计算泄漏
  });
});
