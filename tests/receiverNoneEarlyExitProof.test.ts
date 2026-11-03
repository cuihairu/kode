import { describe, expect, it } from 'vitest';

import { computeReceiverNoneFindings } from '../src/receiverNoneDiagnostics';

// IDE-LINT-003:早退证明要求相关路径真正退出。嵌套条件内的 return(分支可
// 不走)、字符串字面量/行尾注释里的 return/raise 都不算所有路径退出,仍报;
// 块内无条件 return/raise(可前置普通语句)的正例保持不报。

const py = (body: string[]): string => body.join('\n');

describe('IDE-LINT-003:早退证明的真退出要求', () => {
  it('嵌套条件 return 不算所有路径退出,仍报', () => {
    const source = py([
      'class Avatar:',
      '    def f(self):',
      '        if not self.cell:',
      '            if self.busy:',
      '                return',
      '        self.cell.tick()',
      ''
    ]);
    expect(computeReceiverNoneFindings(source, '/a.py')).toMatchObject([
      { receiver: 'cell', kind: 'receiver-none' }
    ]);
  });

  it('字符串字面量里的 return 不算退出,仍报', () => {
    const source = py([
      'class Avatar:',
      '    def f(self):',
      '        if self.client is None:',
      '            note = "will return soon"',
      '        self.client.show()',
      ''
    ]);
    expect(computeReceiverNoneFindings(source, '/a.py')).toHaveLength(1);
  });

  it('行尾注释里的 raise 不算退出,仍报', () => {
    const source = py([
      'class Avatar:',
      '    def f(self):',
      '        if self.base is None:',
      '            ready = False  # raise later',
      '        self.base.notify()',
      ''
    ]);
    expect(computeReceiverNoneFindings(source, '/a.py')).toHaveLength(1);
  });

  it('块内直接 return 正例不报', () => {
    const source = py([
      'class Avatar:',
      '    def f(self):',
      '        if self.cell is None:',
      '            return',
      '        self.cell.tick()',
      ''
    ]);
    expect(computeReceiverNoneFindings(source, '/a.py')).toEqual([]);
  });

  it('块内普通语句后跟无条件 return 正例不报', () => {
    const source = py([
      'class Avatar:',
      '    def f(self):',
      '        if self.client is None:',
      '            self.flag = True',
      '            return',
      '        self.client.show()',
      ''
    ]);
    expect(computeReceiverNoneFindings(source, '/a.py')).toEqual([]);
  });

  it('块内直接 raise 正例不报', () => {
    const source = py([
      'class Avatar:',
      '    def f(self):',
      '        if not self.base:',
      '            raise RuntimeError("offline")',
      '        self.base.notify()',
      ''
    ]);
    expect(computeReceiverNoneFindings(source, '/a.py')).toEqual([]);
  });
});
