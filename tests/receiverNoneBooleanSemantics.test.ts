import { describe, expect, it } from 'vitest';

import { computeReceiverNoneFindings } from '../src/backend/receiverNoneDiagnostics';

// IDE-LINT-002:同行/复合条件按可靠布尔语义判定。`or` 不证明非 None 仍报;
// 顶层 and 分句(含括号包裹)恰为接收者/`is not None` 才认;优先级(and 紧于
// or)与括号、not 不得被朴素字符串拆分误认;不确定形态保留警告。

const py = (body: string[]): string => body.join('\n');

describe('IDE-LINT-002:同行与复合条件的布尔语义', () => {
  it('同行单行 if or 链不证明非 None:if self.cell or ready: 仍报', () => {
    const source = py([
      'class Avatar:',
      '    def f(self):',
      '        if self.cell or ready:',
      '            self.cell.tick()',
      ''
    ]);
    expect(computeReceiverNoneFindings(source, '/a.py')).toMatchObject([
      { receiver: 'cell', kind: 'receiver-none', methodName: 'tick' }
    ]);
  });

  it('同行单行 if is None 不是 guard:if self.cell is None: 调用仍报', () => {
    const source = py([
      'class Avatar:',
      '    def f(self):',
      '        if self.cell is None:',
      '            self.cell.tick()',
      ''
    ]);
    expect(computeReceiverNoneFindings(source, '/a.py')).toHaveLength(1);
  });

  it('and 紧于 or:if broken or ready and self.cell: 不保证非 None 仍报', () => {
    const source = py([
      'class Avatar:',
      '    def f(self):',
      '        if broken or ready and self.cell:',
      '            self.cell.tick()',
      ''
    ]);
    expect(computeReceiverNoneFindings(source, '/a.py')).toHaveLength(1);
  });

  it('括号包裹的真分句 (self.cell) and ok: 已判空不报', () => {
    const source = py([
      'class Avatar:',
      '    def f(self):',
      '        if (self.cell) and ok:',
      '            self.cell.tick()',
      ''
    ]);
    expect(computeReceiverNoneFindings(source, '/a.py')).toEqual([]);
  });

  it('括号包裹 ok and (self.cell is not None): 已判空不报', () => {
    const source = py([
      'class Avatar:',
      '    def f(self):',
      '        if ok and (self.cell is not None):',
      '            self.cell.tick()',
      ''
    ]);
    expect(computeReceiverNoneFindings(source, '/a.py')).toEqual([]);
  });

  it('not (self.client is None) 等价 is not None,已判空不报', () => {
    const source = py([
      'class Avatar:',
      '    def f(self):',
      '        if not (self.client is None):',
      '            self.client.tick()',
      ''
    ]);
    expect(computeReceiverNoneFindings(source, '/a.py')).toEqual([]);
  });

  it('条件内代码冒号(下标切片)不截断 if 头:d[1:2] and self.cell: 不报', () => {
    const source = py([
      'class Avatar:',
      '    def f(self):',
      '        if d[1:2] and self.cell:',
      '            self.cell.tick()',
      ''
    ]);
    expect(computeReceiverNoneFindings(source, '/a.py')).toEqual([]);
  });

  it('条件字符串里的 and 不被拆分误认:msg == "a and self.cell" 仍报', () => {
    const source = py([
      'class Avatar:',
      '    def f(self):',
      '        if msg == "a and self.cell":',
      '            self.cell.tick()',
      ''
    ]);
    expect(computeReceiverNoneFindings(source, '/a.py')).toHaveLength(1);
  });

  it('真 and 分句正例保持:ok and self.client: / self.client and ok: 不报', () => {
    const source = py([
      'class Avatar:',
      '    def f(self):',
      '        if ok and self.client:',
      '            self.client.tick()',
      '',
      '    def g(self):',
      '        if self.client and ok:',
      '            self.client.tick()',
      '',
      '    def h(self):',
      '        if (a or b) and self.client:',
      '            self.client.tick()',
      ''
    ]);
    expect(computeReceiverNoneFindings(source, '/a.py')).toEqual([]);
  });
});
