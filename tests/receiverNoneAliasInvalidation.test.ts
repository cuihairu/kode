import { describe, expect, it } from 'vitest';

import { computeReceiverNoneFindings } from '../src/backend/receiverNoneDiagnostics';

// IDE-LINT-004:别名证明随赋值与作用域失效。别名重赋值(含 guard 块内、
// 循环体内)、self.<role> 属性重赋值、嵌套函数边界的跨越都不沿用旧 receiver
// 证明;同一有效别名 guard 正例保留不报。

const py = (body: string[]): string => body.join('\n');

describe('IDE-LINT-004:别名证明随赋值与作用域失效', () => {
  it('别名重赋值后再 guard:旧证明不护 self.<role> 引用,仍报', () => {
    const source = py([
      'class Avatar:',
      '    def f(self):',
      '        cell = self.cell',
      '        cell = None',
      '        if cell:',
      '            self.cell.tick()',
      ''
    ]);
    expect(computeReceiverNoneFindings(source, '/a.py')).toHaveLength(1);
  });

  it('guard 块内重赋值别名,self.<role> 引用仍报', () => {
    const source = py([
      'class Avatar:',
      '    def f(self):',
      '        cell = self.cell',
      '        if cell:',
      '            cell = row.cell',
      '            self.cell.tick()',
      ''
    ]);
    expect(computeReceiverNoneFindings(source, '/a.py')).toHaveLength(1);
  });

  it('guard 块内循环体重赋值别名,循环后 self.<role> 引用仍报', () => {
    const source = py([
      'class Avatar:',
      '    def f(self):',
      '        cell = self.cell',
      '        if cell:',
      '            for row in rows:',
      '                cell = row.cell',
      '            self.cell.tick()',
      ''
    ]);
    expect(computeReceiverNoneFindings(source, '/a.py')).toHaveLength(1);
  });

  it('guard 块内重赋值 self.<role> 属性后再用,仍报', () => {
    const source = py([
      'class Avatar:',
      '    def f(self):',
      '        if self.cell:',
      '            self.cell = None',
      '            self.cell.tick()',
      ''
    ]);
    expect(computeReceiverNoneFindings(source, '/a.py')).toHaveLength(1);
  });

  it('正向 guard 不跨嵌套 def 边界保护内部使用,仍报', () => {
    const source = py([
      'class Avatar:',
      '    def f(self):',
      '        if self.cell:',
      '            def g():',
      '                self.cell.tick()',
      ''
    ]);
    expect(computeReceiverNoneFindings(source, '/a.py')).toHaveLength(1);
  });

  it('嵌套 def 内的别名赋值不为外层同名提供证明,仍报', () => {
    const source = py([
      'class Avatar:',
      '    def f(self):',
      '        def prepare():',
      '            cell = self.cell',
      '        cell = "x"',
      '        if cell:',
      '            self.cell.tick()',
      ''
    ]);
    expect(computeReceiverNoneFindings(source, '/a.py')).toHaveLength(1);
  });

  it('有效别名 guard 正例保留:cell = self.cell 后 if cell: 块内不报', () => {
    const source = py([
      'class Avatar:',
      '    def f(self):',
      '        cell = self.cell',
      '        if cell:',
      '            cell.tick()',
      ''
    ]);
    expect(computeReceiverNoneFindings(source, '/a.py')).toEqual([]);
  });

  it('循环体内的别名赋值+guard 正例保留(每轮重新绑定重新判)', () => {
    const source = py([
      'class Avatar:',
      '    def f(self):',
      '        for row in rows:',
      '            cell = self.cell',
      '            if cell:',
      '                cell.tick()',
      ''
    ]);
    expect(computeReceiverNoneFindings(source, '/a.py')).toEqual([]);
  });
});
