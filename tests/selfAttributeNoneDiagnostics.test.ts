import { describe, expect, it } from 'vitest';

import {
  ATTRIBUTE_NONE_DIAGNOSTIC_CODE,
  attributeNoneDiagnosticItems,
  computeSelfAttributeNoneFindings
} from '../src/selfAttributeNoneDiagnostics';

// LANG-NAR-1 诊断面:自管属性 self.<attr> 含 None 且未窄化的成员访问报 Warning;
// 守卫/__init__ 赋值窄化后不报(镜像 receiverNone 判定语义)。

const py = (body: string[]): string => body.join('\n');

describe('自管属性可能为 None 诊断(用户令 2026-11-02)', () => {
  it('__init__ 仅 = None,无守卫访问成员 → 报 Warning', () => {
    const source = py([
      'class Foo:',
      '    def __init__(self):',
      '        self.TalentTree = None',
      '    def method(self):',
      '        self.TalentTree.get(0)'
    ]);
    const findings = computeSelfAttributeNoneFindings(source);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ attr: 'TalentTree', member: 'get', line: 4 });
    expect(findings[0].message).toContain('可能为 None');
  });

  it('守卫窄化:if self.X is None: self.X = expr → 其后不报', () => {
    const source = py([
      'class Foo:',
      '    def __init__(self):',
      '        self.TalentTree = None',
      '    def method(self):',
      '        if self.TalentTree is None:',
      '            self.TalentTree = make_tree()',
      '        self.TalentTree.get(0)'
    ]);
    expect(computeSelfAttributeNoneFindings(source)).toEqual([]);
  });

  it('__init__ 赋值窄化:= None 后被 = [] 覆盖 → 其他方法访问不报', () => {
    const source = py([
      'class Foo:',
      '    def __init__(self):',
      '        self.TalentTree = None',
      '        self.TalentTree = []',
      '    def other(self):',
      '        self.TalentTree.get(0)'
    ]);
    expect(computeSelfAttributeNoneFindings(source)).toEqual([]);
  });

  it('类级 X = None,无守卫 → 报', () => {
    const source = py([
      'class Foo:',
      '    TalentTree = None',
      '    def method(self):',
      '        self.TalentTree.get(0)'
    ]);
    expect(computeSelfAttributeNoneFindings(source)).toHaveLength(1);
  });

  it('内建 receiver 跳过(归 receiverNone 专责)', () => {
    const source = py([
      'class Foo:',
      '    def method(self):',
      '        self.cell.tick()'
    ]);
    expect(computeSelfAttributeNoneFindings(source)).toEqual([]);
  });

  it('非 None 属性(仅 = [])不报', () => {
    const source = py([
      'class Foo:',
      '    def __init__(self):',
      '        self.X = []',
      '    def method(self):',
      '        self.X.append(1)'
    ]);
    expect(computeSelfAttributeNoneFindings(source)).toEqual([]);
  });

  it('早退守卫:if self.X is None: return → 其后不报', () => {
    const source = py([
      'class Foo:',
      '    def __init__(self):',
      '        self.X = None',
      '    def method(self):',
      '        if self.X is None:',
      '            return',
      '        self.X.foo()'
    ]);
    expect(computeSelfAttributeNoneFindings(source)).toEqual([]);
  });

  it('多访问同属性记忆化:同一 (行,属性) 只推一次,多处访问各自判定', () => {
    const source = py([
      'class Foo:',
      '    def __init__(self):',
      '        self.X = None',
      '    def method(self):',
      '        self.X.foo()',
      '        if self.X is None:',
      '            self.X = []',
      '        self.X.foo()'
    ]);
    // 行 4 未窄化 → 报;行 7 已窄化 → 不报
    const findings = computeSelfAttributeNoneFindings(source);
    expect(findings).toHaveLength(1);
    expect(findings[0].line).toBe(4);
  });

  it('诊断 code 稳定', () => {
    expect(ATTRIBUTE_NONE_DIAGNOSTIC_CODE).toBe('kbengine.attributeNone');
  });

  it('属性访问(非方法)亦报:自管属性成员读取', () => {
    const source = py([
      'class Foo:',
      '    def __init__(self):',
      '        self.X = None',
      '    def method(self):',
      '        y = self.X.count'
    ]);
    const items = attributeNoneDiagnosticItems(source);
    expect(items).toHaveLength(1);
    expect(items[0].member).toBe('count');
  });
});
