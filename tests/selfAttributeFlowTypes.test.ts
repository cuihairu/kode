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

  it('KODE-AUD-004:else 块体赋值不再被跳过(if/else 两侧并集)', () => {
    const lines = py([
      'class Foo:',
      '    def __init__(self):',
      '        self.X = None',
      '    def method(self):',
      '        if cond:',
      '            self.X = None',
      '        else:',
      '            self.X = [2]',
      '        y = self.X'
    ]);
    // 块后并 then 侧(None)+ else 侧(list):types 含 None 与 list(修前只并
    // then 侧,else 块体被跳过,漏 list)
    const flow = inferSelfAttributeFlow(lines, 8, 'X');
    expect(flow!.types).toContain('None');
    expect(flow!.types).toContain('list');
  });

  it('KODE-AUD-004:if/elif/else 链三侧并集', () => {
    const lines = py([
      'class Foo:',
      '    def method(self):',
      '        if a:',
      '            self.X = None',
      '        elif b:',
      '            self.X = [1]',
      '        else:',
      '            self.X = "s"',
      '        y = self.X'
    ]);
    const flow = inferSelfAttributeFlow(lines, 8, 'X');
    expect(flow!.types).toContain('None');
    expect(flow!.types).toContain('list');
    expect(flow!.types).toContain('str');
  });

  it('KODE-AUD-004:try/except/else/finally 块体赋值并入', () => {
    const lines = py([
      'class Foo:',
      '    def method(self):',
      '        try:',
      '            self.X = [1]',
      '        except ValueError:',
      '            self.X = None',
      '        else:',
      '            self.X = [2]',
      '        finally:',
      '            cleanup()',
      '        y = self.X'
    ]);
    const flow = inferSelfAttributeFlow(lines, 10, 'X');
    expect(flow!.types).toContain('list');
    expect(flow!.types).toContain('None');
  });

  it('KODE-AUD-004:提前 return 分支不落到块后(then 早退,else 侧继续)', () => {
    const lines = py([
      'class Foo:',
      '    def method(self):',
      '        if self.X is None:',
      '            return',
      '        else:',
      '            self.X = [2]',
      '        y = self.X'
    ]);
    // then 早退不落块后;else 侧 X=[2] 生效 → 无 None
    const flow = inferSelfAttributeFlow(lines, 6, 'X');
    expect(flow!.hasNone).toBe(false);
    expect(flow!.types).toContain('list');
  });

  it('KODE-AUD-004:bytes 字面量 b/B 前缀判 bytes,其余前缀判 str', () => {
    const lines = py([
      'class Foo:',
      '    def __init__(self):',
      "        self.B = b'abc'",
      "        self.BR = br'abc'",
      "        self.RB = rb'abc'",
      "        self.S = 'abc'",
      "        self.R = r'abc'",
      "        self.F = f'{x}'"
    ]);
    expect(inferSelfAttributeFlow(lines, 2, 'B')!.annotation).toBe('bytes');
    expect(inferSelfAttributeFlow(lines, 3, 'BR')!.annotation).toBe('bytes');
    expect(inferSelfAttributeFlow(lines, 4, 'RB')!.annotation).toBe('bytes');
    expect(inferSelfAttributeFlow(lines, 5, 'S')!.annotation).toBe('str');
    expect(inferSelfAttributeFlow(lines, 6, 'R')!.annotation).toBe('str');
    expect(inferSelfAttributeFlow(lines, 7, 'F')!.annotation).toBe('str');
  });
});

describe('KR-AUD-59 增强赋值不误捕获 RHS(UI-9)', () => {
  it('self.items += [1] 不作为赋值解;流类型保持 __init__ 的 list', () => {
    const lines = [
      'class Foo:',
      '    def __init__(self):',
      '        self.items = []',
      '    def add(self):',
      '        self.items += [1]',
      '    def use(self):',
      '        x = self.items'
    ];
    // 查询位 = 行 6(`x = self.items`)
    const flow = inferSelfAttributeFlow(lines, 6, 'items', {});
    expect(flow).not.toBeNull();
    // `+= [1]` 不是重新赋值:类型保持 __init__ 的 list,不得被 RHS `+ [1]` 污染
    expect(flow!.annotation).toBe('list');
    expect(flow!.hasNone).toBe(false);
  });
});

describe('KR-AUD-59 增强赋值不误捕获 RHS(UI-9)·判别面', () => {
  it('同方法内增强赋值不得以误捕获 RHS 清 None', () => {
    const lines = [
      'class Foo:',
      '    def __init__(self):',
      '        self.items = None',
      '    def use(self):',
      '        self.items += [1]',
      '        x = self.items'
    ];
    // 查询位 = 行 5。增强赋值不是重新赋值:不得以 RHS `+ [1]`(解不出类型,
    // 旧实现误捕获为空集)覆盖流状态 —— None 保持(保守正确)
    const flow = inferSelfAttributeFlow(lines, 5, 'items', {});
    expect(flow).not.toBeNull();
    expect(flow!.hasNone).toBe(true);
  });

  it('裸赋值仍正常覆盖:同方法内 = [] 覆盖去 None 为 list', () => {
    const lines = [
      'class Foo:',
      '    def __init__(self):',
      '        self.items = None',
      '    def use(self):',
      '        self.items = []',
      '        x = self.items'
    ];
    const flow = inferSelfAttributeFlow(lines, 5, 'items', {});
    expect(flow).not.toBeNull();
    expect(flow!.hasNone).toBe(false);
    expect(flow!.annotation).toBe('list');
  });
});

describe('KR-AUD-59 取证钉面:增强/比较形态不作为赋值(UI-9)', () => {
  it('`+=` 增强赋值不匹配赋值正则:流状态保持(None 不被清)', () => {
    const lines = [
      'class Foo:',
      '    def __init__(self):',
      '        self.items = None',
      '    def use(self):',
      '        self.items += [1]',
      '        x = self.items'
    ];
    const flow = inferSelfAttributeFlow(lines, 5, 'items', {});
    expect(flow).not.toBeNull();
    expect(flow!.hasNone).toBe(true);
  });

  it('`!=` 比较语句不得误捕获 RHS 清 None(残边)', () => {
    const lines = [
      'class Foo:',
      '    def __init__(self):',
      '        self.items = None',
      '    def use(self):',
      '        self.items != []',
      '        x = self.items'
    ];
    const flow = inferSelfAttributeFlow(lines, 5, 'items', {});
    expect(flow).not.toBeNull();
    expect(flow!.hasNone).toBe(true);
  });
});

describe('KR-AUD-59 取证钉面:类型保持与裸赋值对照', () => {
  it('`+=` 行不打断类型:__init__=[] 后 augmented 行,查询位仍 list', () => {
    const lines = [
      'class Foo:',
      '    def __init__(self):',
      '        self.items = []',
      '    def use(self):',
      '        self.items += [1]',
      '        x = self.items'
    ];
    const flow = inferSelfAttributeFlow(lines, 5, 'items', {});
    expect(flow).not.toBeNull();
    expect(flow!.annotation).toBe('list');
    expect(flow!.hasNone).toBe(false);
  });

  it('`!=` 行不打断类型:__init__=[] 后比较语句,查询位仍 list', () => {
    const lines = [
      'class Foo:',
      '    def __init__(self):',
      '        self.items = []',
      '    def use(self):',
      '        self.items != []',
      '        x = self.items'
    ];
    const flow = inferSelfAttributeFlow(lines, 5, 'items', {});
    expect(flow).not.toBeNull();
    expect(flow!.annotation).toBe('list');
  });
});

describe('流类型原子面与扫描臂(覆盖补测)', () => {
  it('写字点 RHS 原子面:注释剥离/空表达式/bool/float/tuple/self 链/裸名回退', () => {
    const lines = [
      'class Foo:',
      '    def __init__(self):',
      '        pass',
      '    def method(self):',
      '        self.a = 1 # 整数注释',
      '        self.b = # 只剩注释',
      '        self.c = True',
      '        self.d = 3.14',
      '        self.e = (1, 2)',
      '        self.f = self.g',
      '        self.h = MAX_HP',
      '        self.i = UNKNOWN_NAME',
      '        self.j = a[0]'
    ];
    const withNames = {
      resolveNameAnnotation: (name: string): string | null => (name === 'MAX_HP' ? 'int' : null)
    };
    expect(inferSelfAttributeFlow(lines, 4, 'a', {})!.annotation).toBe('int');
    // RHS 只剩注释 → 空表达式,注解 null
    expect(inferSelfAttributeFlow(lines, 5, 'b', {})!.annotation).toBeNull();
    expect(inferSelfAttributeFlow(lines, 6, 'c', {})!.types).toEqual(['bool']);
    expect(inferSelfAttributeFlow(lines, 7, 'd', {})!.types).toEqual(['float']);
    expect(inferSelfAttributeFlow(lines, 8, 'e', {})!.types).toEqual(['tuple']);
    // self 链不递归:空集
    expect(inferSelfAttributeFlow(lines, 9, 'f', {})!.annotation).toBeNull();
    // 裸名经回调精化;解不出/未注入 → 空集
    expect(inferSelfAttributeFlow(lines, 10, 'h', withNames)!.types).toEqual(['int']);
    expect(inferSelfAttributeFlow(lines, 11, 'i', {})!.annotation).toBeNull();
    // 非调用/非裸名形态(下标) → 回落空集
    expect(inferSelfAttributeFlow(lines, 12, 'j', {})!.annotation).toBeNull();
  });

  it('非法入参:空 attr / 越界查询行 → null', () => {
    const lines = ['class Foo:', '    def m(self):', '        self.x = 1'];
    expect(inferSelfAttributeFlow(lines, 1, '')).toBeNull();
    expect(inferSelfAttributeFlow(lines, -1, 'x')).toBeNull();
    expect(inferSelfAttributeFlow(lines, lines.length, 'x')).toBeNull();
  });

  it('方法域定位:类外查询行跳过两类;类体首方法前(文档串)无方法流', () => {
    const outside = [
      'class A:',
      '    def m(self):',
      '        pass',
      'def free():',
      '    pass',
      'class B:',
      '    def n(self):',
      '        pass'
    ];
    // 行 4 在 free() 内:两类区间外,enclosing 全跳过 → 类外回落基线空集
    expect(inferSelfAttributeFlow(outside, 4, 'x', {})!.annotation).toBeNull();
    const docstring = [
      'class Foo:',
      '    """类文档串"""',
      '    def m(self):',
      '        self.x = 1'
    ];
    // 行 1 在类体内但先于首个方法 → 无方法流,回落类级基线(空)
    expect(inferSelfAttributeFlow(docstring, 1, 'x', {})!.annotation).toBeNull();
  });

  it('方法体缩进:首行注释体取首个实义行;无体方法回落缩进+1', () => {
    const commented = [
      'class Foo:',
      '    def m(self):',
      '        # 先注释',
      '        self.x = 1',
      '        return'
    ];
    expect(inferSelfAttributeFlow(commented, 4, 'x', {})!.annotation).toBe('int');
    const emptyBody = [
      'class Foo:',
      '    def m1(self):',
      '    def m2(self):',
      '        self.x = 1',
      '        return'
    ];
    // m1 无体(下一行即同级 def):baseIndent 回落方法缩进+1,扫描不炸
    expect(inferSelfAttributeFlow(emptyBody, 4, 'x', {})!.annotation).toBe('int');
    const blankBody = [
      'class Foo:',
      '    def m1(self):',
      '',
      '    def m2(self):',
      '        self.x = 1',
      '        return'
    ];
    // 查询位在 m1 域内的空行:m1 无实义体行,baseIndent 回落缩进+1 → 基线空集
    expect(inferSelfAttributeFlow(blankBody, 2, 'x', {})!.annotation).toBeNull();
  });

  it('is not None 守卫:then 早退保持入口态;块后与查询位在块内各归其位', () => {
    const terminal = [
      'class Foo:',
      '    def __init__(self):',
      '        self.x = None',
      '    def m(self):',
      '        if self.x is not None:',
      '            return',
      '        self.x = 1'
    ];
    // then 含 return:块后状态=入口态(None),随赋值覆盖为 int
    const flow = inferSelfAttributeFlow(terminal, 6, 'x', {});
    expect(flow!.annotation).toBe('int');
    const blockStop = [
      'class Foo:',
      '    def __init__(self):',
      '        self.x = None',
      '    def m(self):',
      '        if self.x is not None:',
      '            self.x = "s"',
      '        self.x = 1'
    ];
    // then 正常落回:块后并集;查询位在块后的覆盖赋值 → int
    expect(inferSelfAttributeFlow(blockStop, 6, 'x', {})!.annotation).toBe('int');
    // 查询位在 then 块内:立即返回块内状态(str)
    expect(inferSelfAttributeFlow(blockStop, 5, 'x', {})!.annotation).toBe('str');
  });

  it('普通块:then 早退并集、块内查询即返;块内空行不误闭块', () => {
    const terminal = [
      'class Foo:',
      '    def __init__(self):',
      '        self.x = None',
      '    def m(self):',
      '        if other:',
      '            return',
      '        self.x = 1'
    ];
    expect(inferSelfAttributeFlow(terminal, 6, 'x', {})!.annotation).toBe('int');
    const blockStop = [
      'class Foo:',
      '    def __init__(self):',
      '        self.x = None',
      '    def m(self):',
      '        if other:',
      '',
      '            self.x = "s"',
      '',
      '        self.x = 1'
    ];
    // 块内首行是空行:块体缩进取首个实义行;空行不闭块
    expect(inferSelfAttributeFlow(blockStop, 6, 'x', {})!.annotation).toBe('str');
    expect(inferSelfAttributeFlow(blockStop, 8, 'x', {})!.annotation).toBe('int');
  });

  it('无体块:if 后无实义体行,块体缩进回落块行缩进+1,不炸', () => {
    const lines = [
      'class Foo:',
      '    def __init__(self):',
      '        self.x = None',
      '        if other:',
      ''
    ];
    // 查询位在尾部空行(仍在 __init__ 域):if 无体,块体缩进回落
    const flow = inferSelfAttributeFlow(lines, 4, 'x', {});
    expect(flow).not.toBeNull();
  });

  it('更深缩进的散行:不属本层保守跳过,后续照常扫描', () => {
    const lines = [
      'class Foo:',
      '    def __init__(self):',
      '        pass',
      '    def m(self):',
      '        self.x = 1',
      '            stray = 2',
      '        return'
    ];
    expect(inferSelfAttributeFlow(lines, 6, 'x', {})!.annotation).toBe('int');
  });

  it('类级声明基线:空行跳过、异常缩进行跳过、注解声明 `X: T` 入基线', () => {
    const annotated = [
      'class Foo:',
      '',
      '    x: str = "d"',
      '        weird = 2',
      '    def __init__(self):',
      '        pass'
    ];
    // 查询位在 __init__ 末行:基线 = 类级注解 str(空行/深缩进行不参与)
    expect(inferSelfAttributeFlow(annotated, 5, 'x', {})!.types).toEqual(['str']);
    const bareAnnotated = [
      'class Foo:',
      '    x: list',
      '    def __init__(self):',
      '        pass'
    ];
    expect(inferSelfAttributeFlow(bareAnnotated, 3, 'x', {})!.types).toEqual(['list']);
  });
});
