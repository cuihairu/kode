import { afterEach, describe, expect, it } from 'vitest';

import {
  computeReceiverNoneFindings,
  receiverNoneDiagnosticItems
} from '../src/receiverNoneDiagnostics';
import {
  getPythonMaskPassCountForTests,
  resetPythonMaskPassCountForTests
} from '../src/backend/pythonLexicalMask';

// IDE-LINT-005:receiver lint 屏蔽注释与字面量。注释、普通/三引号字符串里
// 的 self.<role>.<name> 形态不产生诊断;f-string 表达式部分按真实代码处理,
// 字面量部分不算;全文只做一次词法掩码扫描,供调用发现与 guard 分析复用,
// 不逐命中重扫。

const py = (body: string[]): string => body.join('\n');

afterEach(() => {
  resetPythonMaskPassCountForTests();
});

describe('IDE-LINT-005:注释与字面量屏蔽', () => {
  it('注释里的 receiver 形态不产生诊断', () => {
    const source = py([
      'class Avatar:',
      '    def f(self):',
      '        # self.cell.send() 应被屏蔽',
      '        return 42',
      ''
    ]);
    expect(computeReceiverNoneFindings(source, '/a.py')).toEqual([]);
    expect(receiverNoneDiagnosticItems(source, '/a.py', undefined, true)).toEqual([]);
  });

  it('普通单引号/双引号字符串里的形态不产生诊断', () => {
    const source = py([
      'class Avatar:',
      '    def f(self):',
      "        tip = 'please call self.cell.send() first'",
      '        tip2 = "or self.base.notify()"',
      '        return 42',
      ''
    ]);
    expect(computeReceiverNoneFindings(source, '/a.py')).toEqual([]);
  });

  it('三引号多行字符串里的形态不产生诊断', () => {
    const source = py([
      'class Avatar:',
      '    def f(self):',
      '        """用法示例:',
      '        self.cell.tick()',
      '        self.client.show()',
      '        """',
      '        return 42',
      ''
    ]);
    expect(computeReceiverNoneFindings(source, '/a.py')).toEqual([]);
  });

  it('f-string 字面量部分不算,表达式部分按真实代码报', () => {
    const literalOnly = py([
      'class Avatar:',
      '    def f(self):',
      '        log(f"self.cell.send() is the way")',
      '        return 42',
      ''
    ]);
    expect(computeReceiverNoneFindings(literalOnly, '/a.py')).toEqual([]);

    const exprOnly = py([
      'class Avatar:',
      '    def f(self):',
      '        log(f"{self.cell.send()}")',
      ''
    ]);
    expect(computeReceiverNoneFindings(exprOnly, '/a.py')).toMatchObject([
      { receiver: 'cell', kind: 'receiver-none', methodName: 'send' }
    ]);
  });

  it('掩码一次扫描复用:每轮 compute 恰一次,与命中数无关', () => {
    const small = py([
      'class Avatar:',
      '    def f(self):',
      '        self.cell.tick()',
      '        msg = "self.base.notify()"',
      ''
    ]);
    resetPythonMaskPassCountForTests();
    computeReceiverNoneFindings(small, '/a.py');
    expect(getPythonMaskPassCountForTests()).toBe(1);

    const manyCalls = py([
      'class Avatar:',
      '    def f(self):',
      ...Array.from({ length: 40 }, (_, i) => `        self.cell.m${i}()`),
      ''
    ]);
    resetPythonMaskPassCountForTests();
    computeReceiverNoneFindings(manyCalls, '/a.py');
    // 40 个命中也只有一次全文掩码(不逐命中重扫)
    expect(getPythonMaskPassCountForTests()).toBe(1);
  });
});
