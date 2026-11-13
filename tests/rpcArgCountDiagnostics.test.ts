import { describe, expect, it } from 'vitest';

import {
  RPC_ARG_COUNT_DIAGNOSTIC_CODE,
  computeRpcArgCountFindings,
  countCallArguments
} from '../src/backend/rpcArgCountDiagnostics';
import type { EntityMapping } from '../src/entityMapping';

// IDE-LINT-008 验收(KBE-PY-009 诊断面):RPC 调用点顶层实参数与 .def 该方法
// <Arg> 数对账,明确数量不符才报;星号实参/动态接收者/声明未就绪/段外声明
// 保留未知一律不报;inlay 提示不替代诊断。
// 两层:countCallArguments 纯计数(掩码文本口径);computeRpcArgCountFindings
// 端到端(声明绑定当前接收者 section 的 <Arg> 数)。

/** 最小 EntityMapping 桩:只喂本诊断用到的 methods 表(section + declaredArgs) */
const mappingWithMethods = (
  methods: Record<string, Array<{ section: string; declaredArgs?: string[] }>>
): EntityMapping => ({
  methods: Object.fromEntries(
    Object.entries(methods).map(([name, defs]) => [
      name,
      defs.map(def => ({
        defFile: 'avatar.def',
        line: 10,
        section: def.section,
        exposed: false,
        declaredArgs: def.declaredArgs,
        identity: {
          ownerKind: 'method' as never,
          ownerName: 'Avatar',
          sourceKind: 'def' as never,
          sourceChain: [],
          symbolName: name
        }
      }))
    ])
  )
}) as unknown as EntityMapping;

const callAt = (line: number, character: number, methodName: string) => ({
  line,
  character,
  receiver: 'cell' as const,
  section: 'CellMethods' as const,
  methodName
});

const linesOf = (text: string): string[] => text.split('\n');

describe('IDE-LINT-008 调用点顶层实参计数(countCallArguments)', () => {
  // 契约:输入是原始文本(计数面自带字符串/注释词法态)——与生产调用方同口径
  const count = (source: string): number | null =>
    countCallArguments(linesOf(source), callAt(0, 'self.cell.'.length, 'foo'));

  it('空括号计 0,单实参计 1,多实参按顶层逗号计', () => {
    expect(count('self.cell.foo()')).toBe(0);
    expect(count('self.cell.foo(1)')).toBe(1);
    expect(count('self.cell.foo(1, 2)')).toBe(2);
    expect(count('self.cell.foo( 1 , 2 , 3 )')).toBe(3);
  });

  it('尾随逗号不多计', () => {
    expect(count('self.cell.foo(1, )')).toBe(1);
    expect(count('self.cell.foo(1, 2,)')).toBe(2);
  });

  it('嵌套括号内的逗号不算顶层分隔', () => {
    expect(count('self.cell.foo(bar(1, 2), 3)')).toBe(2);
    expect(count('self.cell.foo({1: 2, 3: 4})')).toBe(1);
    expect(count('self.cell.foo([a, b], c)')).toBe(2);
  });

  it('跨行调用计数到配对括号', () => {
    expect(count('self.cell.foo(\n  "hello",\n  1,\n)')).toBe(2);
    expect(count('self.cell.foo(\n  1,\n  2,\n  3\n)')).toBe(3);
  });

  it('顶层段首星号(解包/收集)→ 未知(null)', () => {
    expect(count('self.cell.foo(*args)')).toBeNull();
    expect(count('self.cell.foo(1, *rest)')).toBeNull();
    expect(count('self.cell.foo(**kw)')).toBeNull();
  });

  it('二元乘法星号(非段首)不影响计数;嵌套段内星号不影响外层', () => {
    expect(count('self.cell.foo(a * b)')).toBe(1);
    expect(count('self.cell.foo(a * b, c)')).toBe(2);
    expect(count('self.cell.foo(bar(*x))')).toBe(1);
  });

  it('括号不闭合到文件尾 / 方法名与 ( 之间有其他 token → 未知(null)', () => {
    expect(count('self.cell.foo(')).toBeNull();
    expect(count('self.cell.foo(1,\n2')).toBeNull();
    expect(count('self.cell.foo [0]')).toBeNull();
  });

  it('字符串/注释里的逗号与括号经掩码后不参与(掩码口径间接验证:文本含字符串逗号)', () => {
    // 字符串内容在掩码后空白,"," 不构成顶层分隔
    expect(count('self.cell.foo("a,b")')).toBe(1);
  });
});

describe('IDE-LINT-008 RPC 实参数量对账(computeRpcArgCountFindings)', () => {
  const sourceOf = (line: string): string =>
    ['class Avatar:', '    def tick(self):', `        ${line}`].join('\n');

  it('数量明确不符才报:声明 1 Arg 调用 0/2 实参均报,声明 3 报实际数', () => {
    const mapping = mappingWithMethods({ login: [{ section: 'CellMethods', declaredArgs: ['INT32'] }] });
    const less = computeRpcArgCountFindings(sourceOf('self.cell.login()'), mapping);
    expect(less).toHaveLength(1);
    expect(less[0]).toMatchObject({
      line: 2,
      character: '        self.cell.'.length,
      methodName: 'login',
      receiver: 'cell',
      declaredCount: 1,
      actualCount: 0
    });
    expect(less[0].message).toContain('argument count mismatch');
    expect(less[0].message).toContain('1 Arg(s)');
    expect(less[0].message).toContain('passes 0');
    expect(RPC_ARG_COUNT_DIAGNOSTIC_CODE).toBe('kbengine.rpcArgCount');

    const more = computeRpcArgCountFindings(sourceOf('self.cell.login(1, 2)'), mapping);
    expect(more).toHaveLength(1);
    expect(more[0].actualCount).toBe(2);
  });

  it('数量一致不报', () => {
    const mapping = mappingWithMethods({ login: [{ section: 'CellMethods', declaredArgs: ['INT32'] }] });
    expect(computeRpcArgCountFindings(sourceOf('self.cell.login(1)'), mapping)).toEqual([]);
    expect(computeRpcArgCountFindings(sourceOf('self.cell.login(1,)'), mapping)).toEqual([]);
    expect(
      computeRpcArgCountFindings(sourceOf('self.cell.login(\n    1,\n)'), mapping)
    ).toEqual([]);
  });

  it('声明未就绪保留未知:无该方法声明 / declaredArgs 缺失 → 不报', () => {
    expect(computeRpcArgCountFindings(sourceOf('self.cell.login()'), undefined)).toEqual([]);
    const noMethod = mappingWithMethods({ other: [{ section: 'CellMethods', declaredArgs: [] }] });
    expect(computeRpcArgCountFindings(sourceOf('self.cell.login()'), noMethod)).toEqual([]);

    const noArgs = mappingWithMethods({ login: [{ section: 'CellMethods' }] });
    expect(computeRpcArgCountFindings(sourceOf('self.cell.login()'), noArgs)).toEqual([]);
  });

  it('段外声明不重复报(sectionMismatch 面):方法只在别的 section 声明 → 不报', () => {
    const mapping = mappingWithMethods({ login: [{ section: 'BaseMethods', declaredArgs: ['INT32'] }] });
    expect(computeRpcArgCountFindings(sourceOf('self.cell.login()'), mapping)).toEqual([]);
  });

  it('同 section 多来源 Arg 数不一致(歧义)→ 不报;一致多来源可判', () => {
    const ambiguous = mappingWithMethods({
      login: [
        { section: 'CellMethods', declaredArgs: ['INT32'] },
        { section: 'CellMethods', declaredArgs: ['INT32', 'STRING'] }
      ]
    });
    expect(computeRpcArgCountFindings(sourceOf('self.cell.login()'), ambiguous)).toEqual([]);

    const consistent = mappingWithMethods({
      login: [
        { section: 'CellMethods', declaredArgs: ['INT32'] },
        { section: 'BaseMethods', declaredArgs: ['INT32', 'STRING'] }
      ]
    });
    expect(computeRpcArgCountFindings(sourceOf('self.cell.login()'), consistent)).toHaveLength(1);
  });

  it('声明带星号形参 → 数量可变,未知不报', () => {
    const mapping = mappingWithMethods({
      login: [{ section: 'CellMethods', declaredArgs: ['*args'] }]
    });
    expect(computeRpcArgCountFindings(sourceOf('self.cell.login(1)'), mapping)).toEqual([]);
  });

  it('调用点星号实参(*args/**kw)→ 未知不报', () => {
    const mapping = mappingWithMethods({ login: [{ section: 'CellMethods', declaredArgs: [] }] });
    expect(computeRpcArgCountFindings(sourceOf('self.cell.login(*payload)'), mapping)).toEqual([]);
    expect(computeRpcArgCountFindings(sourceOf('self.cell.login(**kw)'), mapping)).toEqual([]);
  });

  it('动态接收者(别名/局部变量)不在发现面,天然未知不报', () => {
    const mapping = mappingWithMethods({ login: [{ section: 'CellMethods', declaredArgs: [] }] });
    const source = [
      'class Avatar:',
      '    def tick(self):',
      '        peer = self.cell',
      '        peer.login(1, 2, 3)'
    ].join('\n');
    expect(computeRpcArgCountFindings(source, mapping)).toEqual([]);
  });

  it('注释/字符串里的调用形态经词法掩码不报', () => {
    const mapping = mappingWithMethods({ login: [{ section: 'CellMethods', declaredArgs: [] }] });
    expect(computeRpcArgCountFindings('# self.cell.login(1, 2)', mapping)).toEqual([]);
    expect(computeRpcArgCountFindings('s = "self.cell.login(1, 2)"', mapping)).toEqual([]);
  });

  it('同一文件多处调用各自对账;三个接收者段各绑定各自 section', () => {
    const mapping = mappingWithMethods({
      login: [{ section: 'CellMethods', declaredArgs: ['INT32'] }],
      logout: [{ section: 'BaseMethods', declaredArgs: [] }],
      notify: [{ section: 'ClientMethods', declaredArgs: ['STRING'] }]
    });
    const source = [
      'class Avatar:',
      '    def tick(self):',
      '        self.cell.login(1)',
      '        self.cell.login()',
      '        self.base.logout()',
      '        self.base.logout(1)',
      '        self.client.notify("hi")',
      '        self.client.notify()'
    ].join('\n');
    const findings = computeRpcArgCountFindings(source, mapping);
    expect(findings.map(f => [f.receiver, f.methodName, f.actualCount])).toEqual([
      ['cell', 'login', 0],
      ['base', 'logout', 1],
      ['client', 'notify', 0]
    ]);
  });
});

// 逐面语义闸(深审-3 收口):发现面带调用面(第三参)后,面上无此角色属性的
// 引用(cellapp 上 self.cell 等)不进对账面——AttributeError 引用没有「Arg 数
// 对不对」可言,报它就是把非法派发当合法对账。面上有效引用照常对账。
describe('逐面语义闸(发现面过滤)', () => {
  const text = [
    'class Avatar:',
    '    def onTick(self):',
    '        self.cell.tick(1)',
    '        self.base.backup(1, 2)',
    ''
  ].join('\n');

  const mapping = mappingWithMethods({
    tick: [{ section: 'CellMethods', declaredArgs: ['a', 'b'] }],
    backup: [{ section: 'BaseMethods', declaredArgs: ['x', 'y'] }]
  });

  it('cellapp 面:self.cell 引用滤除,self.base 照常对账(2 实参对 2 形参不报)', () => {
    expect(computeRpcArgCountFindings(text, mapping, 'cell')).toEqual([]);
  });

  it('cellapp 面:self.base 数量不符照常报', () => {
    const bad = [
      'class Avatar:',
      '    def onTick(self):',
      '        self.base.backup(1)',
      ''
    ].join('\n');
    const findings = computeRpcArgCountFindings(bad, mapping, 'cell');
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ receiver: 'base', methodName: 'backup', declaredCount: 2, actualCount: 1 });
  });

  it('无调用面(旧口径):self.cell 照常对账(1 实参对 2 形参报不符)', () => {
    const findings = computeRpcArgCountFindings(text, mapping);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ receiver: 'cell', methodName: 'tick', declaredCount: 2, actualCount: 1 });
  });
});
