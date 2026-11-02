import { describe, expect, it } from 'vitest';

import { inferSelfAttributeFlow } from '../src/selfAttributeFlowTypes';

// LANG-NAR-1 语义引擎流敏感窄化(用户令 2026-11-02):自管属性 self.<attr> 的
// 流敏感类型推导——`if self.X is None: self.X = expr` 后收窄为 expr 类型;
// __init__ 内赋值参与类型收敛(声明∪赋值)。纯函数面,验收场景:
// self.TalentTree is None 守卫后 .get 无 List|None 警告 + __init__ 初始化后无警告。

const py = (body: string[]): string[] => body;

describe('语义引擎流敏感窄化(纯函数面)', () => {
  it('守卫后收窄:if self.X is None: self.X = expr → 查询位无 None', () => {
    const lines = py([
      'class Foo:',
      '    def __init__(self):',
      '        self.TalentTree = None',
      '    def method(self):',
      '        if self.TalentTree is None:',
      '            self.TalentTree = make_tree()',
      '        x = self.TalentTree'
    ]);
    // 查询位 = `x = self.TalentTree`(行 6)
    const flow = inferSelfAttributeFlow(lines, 6, 'TalentTree', {
      resolveCallAnnotation: callee => (callee === 'make_tree' ? 'list' : null)
    });
    expect(flow).not.toBeNull();
    expect(flow!.hasNone).toBe(false);
    expect(flow!.narrowed).toBe(true);
    expect(flow!.annotation).toBe('list');
  });

  it('守卫后收窄(调用注解解不出):仍去 None,不硬造 Any', () => {
    const lines = py([
      'class Foo:',
      '    def __init__(self):',
      '        self.TalentTree = None',
      '    def method(self):',
      '        if self.TalentTree is None:',
      '            self.TalentTree = make_tree()',
      '        x = self.TalentTree'
    ]);
    const flow = inferSelfAttributeFlow(lines, 6, 'TalentTree');
    expect(flow!.hasNone).toBe(false);
    expect(flow!.narrowed).toBe(true);
    // 类型推不出(无回调)→ 空集(annotation null),但无 None = 不告警
    expect(flow!.annotation).toBeNull();
  });

  it('__init__ 初始化后无警告:尾部赋值覆盖 None 声明', () => {
    const lines = py([
      'class Foo:',
      '    def __init__(self):',
      '        self.TalentTree = None',
      '        self.TalentTree = []',
      '    def method(self):',
      '        x = self.TalentTree'
    ]);
    const flow = inferSelfAttributeFlow(lines, 5, 'TalentTree');
    expect(flow!.hasNone).toBe(false);
    expect(flow!.annotation).toBe('list');
  });

  it('__init__ 初始化后无警告(其他方法,无守卫):收敛基类已去 None', () => {
    const lines = py([
      'class Foo:',
      '    def __init__(self):',
      '        self.TalentTree = None',
      '        self.TalentTree = []',
      '    def other(self):',
      '        self.TalentTree.get(0)'
    ]);
    const flow = inferSelfAttributeFlow(lines, 5, 'TalentTree');
    expect(flow!.hasNone).toBe(false);
    expect(flow!.annotation).toBe('list');
  });

  it('无守卫 + 基类含 None(仅 = None):hasNone true(应告警)', () => {
    const lines = py([
      'class Foo:',
      '    def __init__(self):',
      '        self.TalentTree = None',
      '    def method(self):',
      '        self.TalentTree.get(0)'
    ]);
    const flow = inferSelfAttributeFlow(lines, 4, 'TalentTree');
    expect(flow!.hasNone).toBe(true);
    expect(flow!.narrowed).toBe(false);
    expect(flow!.annotation).toBe('None');
  });

  it('类级 X = None → 基类含 None,无守卫应告警', () => {
    const lines = py([
      'class Foo:',
      '    TalentTree = None',
      '    def method(self):',
      '        self.TalentTree.get(0)'
    ]);
    const flow = inferSelfAttributeFlow(lines, 3, 'TalentTree');
    expect(flow!.hasNone).toBe(true);
  });

  it('not None 守卫块内收窄:if self.X is not None: 块内无 None', () => {
    const lines = py([
      'class Foo:',
      '    def __init__(self):',
      '        self.TalentTree = None',
      '        self.TalentTree = []',
      '    def method(self):',
      '        if self.TalentTree is not None:',
      '            self.TalentTree.get(0)'
    ]);
    // 查询位在守卫块内(行 6)
    const flow = inferSelfAttributeFlow(lines, 6, 'TalentTree');
    expect(flow!.hasNone).toBe(false);
  });

  it('早退守卫:if self.X is None: return → 其后无 None', () => {
    const lines = py([
      'class Foo:',
      '    def __init__(self):',
      '        self.TalentTree = None',
      '    def method(self):',
      '        if self.TalentTree is None:',
      '            return',
      '        self.TalentTree.get(0)'
    ]);
    const flow = inferSelfAttributeFlow(lines, 6, 'TalentTree');
    expect(flow!.hasNone).toBe(false);
    expect(flow!.narrowed).toBe(true);
  });

  it('其他属性不受影响:同名守卫不窄化另一属性', () => {
    const lines = py([
      'class Foo:',
      '    def __init__(self):',
      '        self.Alpha = None',
      '        self.Beta = None',
      '    def method(self):',
      '        if self.Alpha is None:',
      '            self.Alpha = []',
      '        x = self.Beta'
    ]);
    // 查询 Beta(行 7):Alpha 的守卫不影响 Beta → Beta 仍 None
    const flow = inferSelfAttributeFlow(lines, 7, 'Beta');
    expect(flow!.hasNone).toBe(true);
  });

  it('字面量赋值:list/dict/str/int 精确注解', () => {
    const lines = py([
      'class Foo:',
      '    def __init__(self):',
      '        self.A = [1, 2, 3]',
      '        self.B = {"k": 1}',
      '        self.C = "hi"',
      '        self.D = 7'
    ]);
    expect(inferSelfAttributeFlow(lines, 2, 'A')!.annotation).toBe('list');
    expect(inferSelfAttributeFlow(lines, 3, 'B')!.annotation).toBe('dict');
    expect(inferSelfAttributeFlow(lines, 4, 'C')!.annotation).toBe('str');
    expect(inferSelfAttributeFlow(lines, 5, 'D')!.annotation).toBe('int');
  });

  it('None 显式赋值 → 查询位 None', () => {
    const lines = py([
      'class Foo:',
      '    def __init__(self):',
      '        self.X = None'
    ]);
    const flow = inferSelfAttributeFlow(lines, 2, 'X');
    expect(flow!.annotation).toBe('None');
    expect(flow!.hasNone).toBe(true);
  });

  it('守卫并集:块内赋值 list + 入口含 None → 块后 list(无 None)', () => {
    const lines = py([
      'class Foo:',
      '    def __init__(self):',
      '        self.X = None',
      '        self.X = []',
      '    def method(self):',
      '        if self.X is None:',
      '            self.X = [1]',
      '        y = self.X'
    ]);
    const flow = inferSelfAttributeFlow(lines, 7, 'X');
    expect(flow!.hasNone).toBe(false);
  });
});
