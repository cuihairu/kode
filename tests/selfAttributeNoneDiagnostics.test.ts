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
    expect(findings[0].message).toContain('may be None');
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

/* ---------------- KR-AUD-58: 掩码先行(字符串/注释提及不误报) ---------------- */

describe('KR-AUD-58: self.x.y 匹配跑词法掩码文本(字符串/注释不误报)', () => {
  it('字符串字面量与注释里的 self.TalentTree.get 提及不产 finding', () => {
    const source = py([
      'class Foo:',
      '    def __init__(self):',
      '        self.TalentTree = None',
      "    def method(self):",
      "        s = 'self.TalentTree.get(0)'",
      '        # self.TalentTree.get(1)',
      '        doc = """self.TalentTree.get(2)"""',
      '        self.TalentTree.get(3)'
    ]);
    const findings = computeSelfAttributeNoneFindings(source);
    // 唯一合法 finding:line 7 的真实访问
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ attr: 'TalentTree', member: 'get', line: 7 });
  });
});

/* ---------------- KR-AUD-59: 增强赋值不捕获 RHS,流类型保持 ---------------- */

describe('KR-AUD-59: 增强赋值(+=)不覆盖流类型', () => {
  it('None 属性 += 后流状态保持 None,后续访问仍报(不以 RHS 重推类型)', () => {
    const source = py([
      'class Foo:',
      '    def __init__(self):',
      '        self.Items = None',
      '    def method(self):',
      "        self.Items += ['a']",
      '        self.Items.append(1)'
    ]);
    const findings = computeSelfAttributeNoneFindings(source);
    // += 不得被当作 self.Items = <rhs> 覆盖流类型(否则误判窄化、漏报 line 5)
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ attr: 'Items', member: 'append', line: 5 });
  });

  it('list 属性 += 后流类型保持 list(不被 RHS 推导改写)', () => {
    const source = py([
      'class Foo:',
      '    def __init__(self):',
      '        self.Items = []',
      '    def method(self):',
      "        self.Items += [1]",
      '        self.Items.append(2)'
    ]);
    const findings = computeSelfAttributeNoneFindings(source);
    expect(findings).toHaveLength(0);
  });
});
