import { describe, expect, it } from 'vitest';

import { computeReceiverNoneFindings } from '../src/backend/receiverNoneDiagnostics';

// USER-LINT-01(用户报 2026-11-04):`kbe.isValid(entityRef)` 是 KBEngine
// 全局 API——实体引用有效(未销毁)返回 True,`isValid(None)`/无效引用返回
// False,故 `kbe.isValid(X)` 真值 ⟹ X 可安全解引用,是引擎惯用的正向判空
// 守卫。guard 分析须识别:①正向 `if kbe.isValid(subject)`(含单行体);
// ②早退 `if not kbe.isValid(subject)`;③复合 `kbe.isValid(c) and ready`
// 按既有 and 分句规则认正;④`kbe.isValid(c) or other` 顶层有 or 不构成
// guard 仍报;⑤别名链 `c=self.client; if kbe.isValid(c)` 同形识别。

const py = (body: string[]): string => body.join('\n');

describe('USER-LINT-01:kbe.isValid 引擎校验器守卫', () => {
  it('①正向块体:if kbe.isValid(self.client): 块内调用不报', () => {
    const source = py([
      'class Avatar:',
      '    def f(self):',
      '        if kbe.isValid(self.client):',
      '            self.client.gameTick()',
      ''
    ]);
    expect(computeReceiverNoneFindings(source, '/a.py')).toEqual([]);
  });

  it('①b正向单行体:if kbe.isValid(self.client): self.client.xxx() 不报', () => {
    const source = py([
      'class Avatar:',
      '    def f(self):',
      '        if kbe.isValid(self.client): self.client.gameTick()',
      ''
    ]);
    expect(computeReceiverNoneFindings(source, '/a.py')).toEqual([]);
  });

  it('②早退:if not kbe.isValid(self.cell): return 后使用不报', () => {
    const source = py([
      'class Avatar:',
      '    def f(self):',
      '        if not kbe.isValid(self.cell):',
      '            return',
      '        self.cell.tick()',
      ''
    ]);
    expect(computeReceiverNoneFindings(source, '/a.py')).toEqual([]);
  });

  it('②b早退 raise 形:if not kbe.isValid(self.base): raise 后使用不报', () => {
    const source = py([
      'class Avatar:',
      '    def f(self):',
      '        if not kbe.isValid(self.base):',
      '            raise RuntimeError("no base")',
      '        self.base.notify()',
      ''
    ]);
    expect(computeReceiverNoneFindings(source, '/a.py')).toEqual([]);
  });

  it('③复合正向:if kbe.isValid(c) and ready: 已判空不报', () => {
    const source = py([
      'class Avatar:',
      '    def f(self):',
      '        c = self.client',
      '        if kbe.isValid(c) and ready:',
      '            c.gameTick()',
      ''
    ]);
    expect(computeReceiverNoneFindings(source, '/a.py')).toEqual([]);
  });

  it('④or 不构成 guard:if kbe.isValid(c) or other: 仍报', () => {
    const source = py([
      'class Avatar:',
      '    def f(self):',
      '        c = self.client',
      '        if kbe.isValid(c) or other:',
      '            c.gameTick()',
      ''
    ]);
    expect(computeReceiverNoneFindings(source, '/a.py')).toMatchObject([
      { receiver: 'client', kind: 'receiver-none', methodName: 'gameTick' }
    ]);
  });

  it('⑤别名链:c=self.client; if kbe.isValid(c): c.xxx() 与 self.client.xxx() 都不报', () => {
    const source = py([
      'class Avatar:',
      '    def f(self):',
      '        c = self.client',
      '        if kbe.isValid(c):',
      '            c.gameTick()',
      '            self.client.gameTick()',
      ''
    ]);
    expect(computeReceiverNoneFindings(source, '/a.py')).toEqual([]);
  });

  it('⑥校验器实参不同名不构成 guard:kbe.isValid(other) 后用 self.client 仍报', () => {
    const source = py([
      'class Avatar:',
      '    def f(self):',
      '        if kbe.isValid(other):',
      '            self.client.gameTick()',
      ''
    ]);
    expect(computeReceiverNoneFindings(source, '/a.py')).toMatchObject([
      { receiver: 'client', kind: 'receiver-none', methodName: 'gameTick' }
    ]);
  });
});
