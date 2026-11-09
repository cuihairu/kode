import { describe, expect, it } from 'vitest';

import {
  computeReceiverNoneFindings,
  receiverNoneDiagnosticItems,
  receiverNoneDiagnosticItemsAsync
} from '../src/backend/receiverNoneDiagnostics';
import { parsePythonFile } from '../src/backend/pythonParser';

// USER-LINT-02(用户报 2026-11-04):注释形态漏屏蔽复现矩阵。用户实测「整行
// 注释掉的 self.client 调用仍报 receiver-none Warning」。本矩阵锁定全部注释/
// 字面量形态的屏蔽口径,并双向覆盖:掩码形态零诊断(不能误报),真实代码形态
// 恰一条(不能漏报——掩码不许把真代码也掩掉)。
//
// 泄漏路径考古(prove-red 依据):矩阵全部掩码形态在掩码落地前提交(58493bc^
// =36dd6a6)上逐一复现误报(整行/行尾/docstring/字面量/多行块/缩进/撇号/CRLF),
// 即用户所见;词法掩码(IDE-LINT-005,58493bc)落地后同矩阵全绿。运行期入口
// (同步 items/异步 items/异步+preparsed/分片)均过掩码,无第二条未掩码诊断
// 路径(extension.ts 仅 receiverNoneDiagnosticItemsAsync 一处消费)。

const py = (lines: string[]): string => lines.join('\n');

describe('USER-LINT-02:注释/字面量形态屏蔽矩阵(不得误报)', () => {
  const maskedForms: Array<[string, string]> = [
    ['① 整行注释掉的调用', py([
      'class Avatar:',
      '    def f(self):',
      '        # self.client.send()',
      '        return 42',
      ''
    ])],
    ['② 行尾注释', py([
      'class Avatar:',
      '    def f(self):',
      '        x = 1  # self.client.send() 已判空',
      '        return 42',
      ''
    ])],
    ['③ docstring 内的形态', py([
      'class Avatar:',
      '    def f(self):',
      '        """用法:',
      '        self.client.send()',
      '        """',
      '        return 42',
      ''
    ])],
    ['④ f-string 字面量段', py([
      'class Avatar:',
      '    def f(self):',
      '        return f"call self.client.send() first"',
      ''
    ])],
    ['⑤ 多行注释块中段', py([
      'class Avatar:',
      '    def f(self):',
      '        # 步骤一',
      '        # self.client.send() 占位',
      '        # 步骤二',
      '        return 42',
      ''
    ])],
    ['⑥ 深缩进内注释', py([
      'class Avatar:',
      '    def f(self):',
      '        if True:',
      '            # self.client.send()',
      '            return 42',
      ''
    ])],
    ['⑦ guard 行尾注释(守卫仍识别)', py([
      'class Avatar:',
      '    def f(self):',
      '        if self.client:  # 已判空',
      '            self.client.send()',
      '            return 42',
      ''
    ])],
    ['⑧ 注释含撇号不脱同步', py([
      'class Avatar:',
      '    def f(self):',
      "        # don't call self.client.send() here",
      '        return 42',
      ''
    ])],
    ['⑨ CRLF 整行注释', 'class Avatar:\r\n    def f(self):\r\n        # self.client.send()\r\n        return 42\r\n'],
    ['⑩ encoding 声明 + 注释', py([
      '# -*- coding: utf-8 -*-',
      '# self.client.send()',
      'class Avatar:',
      '    def f(self):',
      '        return 42',
      ''
    ])],
    ['⑪ 早退守卫 + 注释掉的旧调用', py([
      'class Avatar:',
      '    def f(self):',
      '        if not self.client:',
      '            return',
      '        # self.client.send()  # 旧写法',
      '        self.client.send()',
      ''
    ])]
  ];

  for (const [name, source] of maskedForms) {
    it(`${name} → compute 零诊断`, () => {
      expect(computeReceiverNoneFindings(source, '/a.py')).toEqual([]);
    });
    it(`${name} → 诊断 items 面零产出`, () => {
      expect(receiverNoneDiagnosticItems(source, '/a.py', undefined, true)).toEqual([]);
    });
  }

  it('⑫ 异步入口(生产消费面)同样屏蔽整行注释', async () => {
    const source = py([
      'class Avatar:',
      '    def onClientDeath(self):',
      '        # self.client.send()',
      '        # self.client.show()',
      '        return 42',
      ''
    ]);
    const items = await receiverNoneDiagnosticItemsAsync(source, '/a.py', undefined, true);
    expect(items).toEqual([]);
  });

  it('⑬ 异步入口 + preparsed 提供器同样屏蔽', async () => {
    const source = py([
      'class Avatar:',
      '    def f(self):',
      '        # self.client.send()',
      '        return 42',
      ''
    ]);
    const items = await receiverNoneDiagnosticItemsAsync(
      source, '/a.py', undefined, true,
      () => parsePythonFile(source, '/a.py')
    );
    expect(items).toEqual([]);
  });

  it('⑭ 大文件分片异步面同样屏蔽(注释行不产出)', async () => {
    const filler = Array.from({ length: 300 }, (_, i) => `        x${i} = ${i}`);
    const source = py([
      'class Avatar:',
      '    def onClientDeath(self):',
      ...filler,
      '        # self.client.send()',
      '        return 42',
      ''
    ]);
    const items = await receiverNoneDiagnosticItemsAsync(
      source, '/a.py', undefined, true, undefined, { chunkSize: 50 }
    );
    expect(items).toEqual([]);
  });
});

describe('USER-LINT-02:掩码不得掩掉真实代码(不许漏报)', () => {
  it('f-string 表达式段按真实代码处理(恰一条)', () => {
    const source = py([
      'class Avatar:',
      '    def f(self):',
      '        return f"{self.client.send()}"',
      ''
    ]);
    const findings = computeReceiverNoneFindings(source, '/a.py');
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ line: 2, kind: 'receiver-none' });
  });

  it('无守卫的真实调用恰一条(掩码只掩注释)', () => {
    const source = py([
      'class Avatar:',
      '    def f(self):',
      '        # self.client.send()',
      '        self.client.send()',
      ''
    ]);
    const findings = computeReceiverNoneFindings(source, '/a.py');
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ line: 3, kind: 'receiver-none' });
  });

  it('早退块内注释掉的 return 不构成早退证明(仍报)', () => {
    const source = py([
      'class Avatar:',
      '    def f(self):',
      '        if not self.client:',
      '            # return  # 旧写法已注释',
      '            pass',
      '        self.client.send()',
      ''
    ]);
    expect(computeReceiverNoneFindings(source, '/a.py')).toHaveLength(1);
  });

  it('guard 与 use 之间注释掉的重赋值不使证明失效(仍报)', () => {
    const source = py([
      'class Avatar:',
      '    def f(self):',
      '        if self.client is not None:',
      '            self.client.send()',
      '        # self.client = None',
      '        self.client.send()',
      ''
    ]);
    const findings = computeReceiverNoneFindings(source, '/a.py');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.line).toBe(5);
  });

  it('带行尾注释的 guard 形态族仍全识别', () => {
    const guarded = [
      ['        if self.client is not None:  # 已判空', '            self.client.send()'],
      ['        if not self.client:  # 掉线', '            return', '        self.client.send()'],
      ['        if self.client is None:  # 掉线', '            return', '        self.client.send()'],
      ['        if self.client is not None: self.client.send()  # 判空后发'],
      ['        c = self.client  # 取引用', '        if c is not None:  # 判空', '            c.send()']
    ];
    for (const body of guarded) {
      const source = py(['class Avatar:', '    def f(self):', ...body, '']);
      expect(computeReceiverNoneFindings(source, '/a.py'), body.join(' | ')).toEqual([]);
    }
  });
});
