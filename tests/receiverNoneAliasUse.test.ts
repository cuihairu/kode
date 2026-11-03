import { describe, expect, it } from 'vitest';

import {
  computeReceiverNoneFindings,
  receiverNoneDiagnosticItems
} from '../src/receiverNoneDiagnostics';

// IDE-LINT-006:receiver lint 覆盖本地别名使用点。peer = self.cell 之后
// peer.send() 未判空报 Warning;判空 guard 正例不报;重赋值(含 for 重绑)
// 之后不再当作 EntityCall 报;诊断定位实际 token(别名方法名所在列)。

const py = (body: string[]): string => body.join('\n');

describe('IDE-LINT-006:本地别名使用点', () => {
  it('peer = self.cell 后 peer.send() 未判空报 Warning,定位 send token', () => {
    const source = py([
      'class Avatar:',
      '    def f(self):',
      '        peer = self.cell',
      '        peer.send()',
      ''
    ]);
    const findings = computeReceiverNoneFindings(source, '/a.py');
    expect(findings).toMatchObject([
      { receiver: 'cell', kind: 'receiver-none', methodName: 'send', line: 3 }
    ]);
    const items = receiverNoneDiagnosticItems(source, '/a.py', undefined, true);
    expect(items).toHaveLength(1);
    // `        peer.send()` → send 起于第 13 列(定位实际 token,非行首)
    expect(items[0].range.start).toEqual({ line: 3, character: 13 });
    expect(items[0].range.end).toEqual({ line: 3, character: 17 });
  });

  it('别名判空 guard 正例不报', () => {
    const source = py([
      'class Avatar:',
      '    def f(self):',
      '        peer = self.cell',
      '        if peer:',
      '            peer.send()',
      ''
    ]);
    expect(computeReceiverNoneFindings(source, '/a.py')).toEqual([]);
  });

  it('接收者 guard 块内取别名再用不报', () => {
    const source = py([
      'class Avatar:',
      '    def f(self):',
      '        if self.cell:',
      '            peer = self.cell',
      '            peer.send()',
      ''
    ]);
    expect(computeReceiverNoneFindings(source, '/a.py')).toEqual([]);
  });

  it('同行别名 guard 不报:if peer: peer.send()', () => {
    const source = py([
      'class Avatar:',
      '    def f(self):',
      '        peer = self.cell',
      '        if peer: peer.send()',
      ''
    ]);
    expect(computeReceiverNoneFindings(source, '/a.py')).toEqual([]);
  });

  it('别名重赋值后 peer.send() 不误判 EntityCall,零诊断', () => {
    const source = py([
      'class Avatar:',
      '    def f(self):',
      '        peer = self.cell',
      '        peer = Other()',
      '        peer.send()',
      ''
    ]);
    expect(computeReceiverNoneFindings(source, '/a.py')).toEqual([]);
  });

  it('for 重绑同名后循环体内使用不报', () => {
    const source = py([
      'class Avatar:',
      '    def f(self):',
      '        peer = self.cell',
      '        for peer in peers:',
      '            peer.send()',
      ''
    ]);
    expect(computeReceiverNoneFindings(source, '/a.py')).toEqual([]);
  });

  it('嵌套 def 内的别名使用不沿用外层证明', () => {
    const source = py([
      'class Avatar:',
      '    def f(self):',
      '        peer = self.cell',
      '        if peer:',
      '            def g():',
      '                peer.send()',
      ''
    ]);
    expect(computeReceiverNoneFindings(source, '/a.py')).toHaveLength(1);
  });
});
