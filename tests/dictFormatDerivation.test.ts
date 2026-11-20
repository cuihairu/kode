/**
 * KSEM-SER-09:项目静态字典格式推导(纯核心)。
 *
 * 验收(todo.md):从确定的 dict 构造/写点提取必有、可选及值类型;
 * 分支合流、多写者和动态 update 扩展为开放结构。
 *
 * 面分组:字面量写点(值类型)/ 重绑与顺序语义 / 分支合流(if/else
 * 全臂齐键 → 必有)/ 动态写点(开放结构)/ 作用域诚实(函数局部
 * 同名绝不并入)。全部纯函数直查,零 vscode 依赖。
 */

import { describe, it, expect } from 'vitest';
import {
  classifyValue,
  deriveDictFormats,
  type DictFormat,
  type DictValueKind
} from '../src/backend/dictFormatDerivation';

type LiteralFormat = Extract<DictFormat, { kind: 'literal' }>;
type OpenFormat = Extract<DictFormat, { kind: 'open' }>;
type ScalarName = Extract<DictValueKind, { kind: 'scalar' }>['scalar'];

const fmts = (rows: string[]): Map<string, DictFormat> =>
  deriveDictFormats(rows.join('\n'));

function asLiteral(name: string, rows: string[]): LiteralFormat {
  const fmt = fmts(rows).get(name);
  if (!fmt || fmt.kind !== 'literal') {
    throw new Error(`${name} expected literal, got ${fmt?.kind ?? 'absent'}`);
  }
  return fmt;
}

function asOpen(name: string, rows: string[]): OpenFormat {
  const fmt = fmts(rows).get(name);
  if (!fmt || fmt.kind !== 'open') {
    throw new Error(`${name} expected open, got ${fmt?.kind ?? 'absent'}`);
  }
  return fmt;
}

const scalar = (s: ScalarName): DictValueKind => ({ kind: 'scalar', scalar: s });

// ---------------------------------------------------------------------------
// 字面量写点:必有键与值类型
// ---------------------------------------------------------------------------

describe('deriveDictFormats 字面量写点', () => {
  it('单字面量写点:必有键全收,标量值类型逐键分类', () => {
    const fmt = asLiteral('d', ['d = {"s": "x", "i": 1, "f": 1.5, "b": True, "n": None}']);
    expect(fmt.required.size).toBe(5);
    expect(fmt.optional.size).toBe(0);
    expect(fmt.required.get('s')).toEqual(scalar('str'));
    expect(fmt.required.get('i')).toEqual(scalar('int'));
    expect(fmt.required.get('f')).toEqual(scalar('float'));
    expect(fmt.required.get('b')).toEqual(scalar('bool'));
    expect(fmt.required.get('n')).toEqual(scalar('none'));
  });

  it('嵌套 dict 值递归:内层单写点全键必有', () => {
    const fmt = asLiteral('d', ['d = {"cfg": {"a": 1, "b": "s"}}']);
    const cfg = fmt.required.get('cfg');
    if (!cfg || cfg.kind !== 'dict' || cfg.dict.kind !== 'literal') {
      throw new Error(`cfg expected nested literal dict, got ${cfg?.kind}`);
    }
    expect(cfg.dict.required.get('a')).toEqual(scalar('int'));
    expect(cfg.dict.required.get('b')).toEqual(scalar('str'));
    expect(cfg.dict.optional.size).toBe(0);
  });

  it('list 元素同质收敛:元素类型取自全部元素', () => {
    const fmt = asLiteral('d', ['d = {"xs": [1, 2, 3]}']);
    expect(fmt.required.get('xs')).toEqual({ kind: 'list', element: scalar('int') });
  });

  it('list 空与混合:元素面未知(element null),不猜', () => {
    const fmt = asLiteral('d', ['d = {"empty": [], "mixed": [1, "a"]}']);
    expect(fmt.required.get('empty')).toEqual({ kind: 'list', element: null });
    expect(fmt.required.get('mixed')).toEqual({ kind: 'list', element: null });
  });

  it('未知值不猜:调用/f 串/裸名 → unknown', () => {
    const fmt = asLiteral('d', ['d = {"c": load(), "f": f"{x}", "b": other}']);
    expect(fmt.required.get('c')).toEqual({ kind: 'unknown' });
    expect(fmt.required.get('f')).toEqual({ kind: 'unknown' });
    expect(fmt.required.get('b')).toEqual({ kind: 'unknown' });
  });

  it('注解赋值形态容忍:d: dict[str, int] = {…} 照常推导', () => {
    const fmt = asLiteral('d', ['d: dict[str, int] = {"a": 1}']);
    expect(fmt.required.get('a')).toEqual(scalar('int'));
  });

  it('多行字面量写点整体消费:跨行键全收', () => {
    const fmt = asLiteral('d', ['d = {', '    "a": 1,', '    "b": "s",', '}']);
    expect(fmt.required.get('a')).toEqual(scalar('int'));
    expect(fmt.required.get('b')).toEqual(scalar('str'));
    expect(fmt.required.size).toBe(2);
  });

  it('空字面量零键面:无形状声称,变量不入 map', () => {
    expect(fmts(['d = {}']).has('d')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 重绑与顺序语义
// ---------------------------------------------------------------------------

describe('deriveDictFormats 重绑与顺序语义', () => {
  it('字面量重绑后者胜:先前证据作废', () => {
    const fmt = asLiteral('d', ['d = {"a": 1}', 'd = {"b": "s"}']);
    expect(fmt.required.size).toBe(1);
    expect(fmt.required.get('b')).toEqual(scalar('str'));
    expect(fmt.required.has('a')).toBe(false);
  });

  it('无条件重绑作废先前条件写点(旧绑定证据不跨重绑)', () => {
    const fmt = asLiteral('d', [
      'if cond:',
      '    d = {"x": 1}',
      'd = {"a": 2}'
    ]);
    expect(fmt.required.size).toBe(1);
    expect(fmt.required.get('a')).toEqual(scalar('int'));
    expect(fmt.required.has('x')).toBe(false);
    expect(fmt.optional.size).toBe(0);
  });

  it('重绑非字面量 → unknown 终局:变量缺席(零键面声称)', () => {
    expect(fmts(['d = {"a": 1}', 'd = load()']).has('d')).toBe(false);
  });

  it('unknown 基上的字面量键写点 → 开放结构 + 观测键保留', () => {
    const fmt = asOpen('d', ['d = load()', 'd["a"] = 1']);
    expect(fmt.observed.get('a')).toEqual(scalar('int'));
    expect(fmt.observed.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 分支合流与可选键
// ---------------------------------------------------------------------------

describe('deriveDictFormats 分支合流', () => {
  it('if/else 全臂齐键(带 else,恰好一臂执行)→ 必有', () => {
    const fmt = asLiteral('d', [
      'if cond:',
      '    d = {"x": 1}',
      'else:',
      '    d = {"x": 2}'
    ]);
    expect(fmt.required.size).toBe(1);
    expect(fmt.required.get('x')).toEqual(scalar('int'));
    expect(fmt.optional.size).toBe(0);
  });

  it('if/elif/else 三臂齐键值类型分歧 → 必有但类型 unknown(不猜)', () => {
    const fmt = asLiteral('d', [
      'if a:',
      '    d = {"x": 1}',
      'elif b:',
      '    d = {"x": "s"}',
      'else:',
      '    d = {"x": None}'
    ]);
    expect(fmt.required.size).toBe(1);
    expect(fmt.required.get('x')).toEqual({ kind: 'unknown' });
  });

  it('无 else 的 if 臂写点 → 可选(可能不执行)', () => {
    const fmt = asLiteral('d', ['d = {"a": 1}', 'if cond:', '    d["x"] = 2']);
    expect(fmt.required.get('a')).toEqual(scalar('int'));
    expect(fmt.optional.get('x')).toEqual(scalar('int'));
    expect(fmt.required.size).toBe(1);
    expect(fmt.optional.size).toBe(1);
  });

  it('if/else 部分臂键(非全臂齐)→ 双键皆可选', () => {
    const fmt = asLiteral('d', [
      'if cond:',
      '    d = {"x": 1}',
      'else:',
      '    d = {"y": 2}'
    ]);
    expect(fmt.required.size).toBe(0);
    expect(fmt.optional.get('x')).toEqual(scalar('int'));
    expect(fmt.optional.get('y')).toEqual(scalar('int'));
  });

  it('for 体写点 → 可选(maybe 压过组占位)', () => {
    const fmt = asLiteral('d', [
      'd = {"a": 1}',
      'for i in xs:',
      '    d["b"] = i'
    ]);
    expect(fmt.required.get('a')).toEqual(scalar('int'));
    expect(fmt.optional.has('b')).toBe(true);
    expect(fmt.optional.get('b')).toEqual({ kind: 'unknown' });
  });

  it('try/except 体写点 → 可选(除 body 归 maybe)', () => {
    const fmt = asLiteral('d', [
      'd = {"a": 1}',
      'try:',
      '    d["b"] = 1',
      'except KeyError:',
      '    d["c"] = 2'
    ]);
    expect(fmt.required.get('a')).toEqual(scalar('int'));
    expect(fmt.optional.has('b')).toBe(true);
    expect(fmt.optional.has('c')).toBe(true);
    expect(fmt.required.size).toBe(1);
  });

  it('for 体中的 if/else 合流不升必有(maybe 优先,保守方向)', () => {
    const fmt = asLiteral('d', [
      'for i in xs:',
      '    if cond:',
      '        d = {"x": 1}',
      '    else:',
      '        d = {"x": 2}'
    ]);
    expect(fmt.required.size).toBe(0);
    expect(fmt.optional.get('x')).toEqual(scalar('int'));
  });
});

// ---------------------------------------------------------------------------
// 动态写点:开放结构
// ---------------------------------------------------------------------------

describe('deriveDictFormats 动态写点开放结构', () => {
  it('变量键下标写 → 开放,观测键保留原类型', () => {
    const fmt = asOpen('d', ['d = {"a": 1}', 'd[k] = 2']);
    expect(fmt.observed.get('a')).toEqual(scalar('int'));
    expect(fmt.observed.size).toBe(1);
  });

  it('update 字面量实参并入且保持闭合(多写者合并)', () => {
    const fmt = asLiteral('d', ['d = {"a": 1}', 'd.update({"b": 2})']);
    expect(fmt.kind).toBe('literal');
    expect(fmt.required.get('a')).toEqual(scalar('int'));
    expect(fmt.required.get('b')).toEqual(scalar('int'));
    expect(fmt.required.size).toBe(2);
  });

  it('update 非字面量实参 → 开放,观测键保留', () => {
    const fmt = asOpen('d', ['d = {"a": 1}', 'd.update(other)']);
    expect(fmt.observed.get('a')).toEqual(scalar('int'));
  });

  it('setdefault 字面量 dict 实参并入', () => {
    const fmt = asLiteral('d', ['d = {}', 'd.setdefault("cfg", {"a": 1})']);
    const cfg = fmt.required.get('cfg');
    if (!cfg || cfg.kind !== 'dict' || cfg.dict.kind !== 'literal') {
      throw new Error(`cfg expected nested literal dict, got ${cfg?.kind}`);
    }
    expect(cfg.dict.required.get('a')).toEqual(scalar('int'));
  });

  it('|= 字面量并入保持闭合(增量写点不触发重绑重置)', () => {
    const fmt = asLiteral('d', ['d = {"a": 1}', 'd |= {"x": 2}']);
    expect(fmt.required.get('a')).toEqual(scalar('int'));
    expect(fmt.required.get('x')).toEqual(scalar('int'));
    expect(fmt.required.size).toBe(2);
  });

  it('|= 裸名 → 开放', () => {
    const fmt = asOpen('d', ['d = {"a": 1}', 'd |= other']);
    expect(fmt.observed.get('a')).toEqual(scalar('int'));
  });

  it('del 键 → 开放(键证据作废面)', () => {
    const fmt = asOpen('d', ['d = {"a": 1}', 'del d["a"]']);
    expect(fmt.observed.get('a')).toEqual(scalar('int'));
  });

  it('推导式值 → 开放(该键不入观测,其余键照收)', () => {
    const fmt = asOpen('d', ['d = {"a": 1, "cfg": {k: 1 for k in xs}}']);
    expect(fmt.observed.get('a')).toEqual(scalar('int'));
    expect(fmt.observed.has('cfg')).toBe(false);
  });

  it('** 展开 → 开放,实键照收', () => {
    const fmt = asOpen('d', ['d = {"a": 1, **extra}']);
    expect(fmt.observed.get('a')).toEqual(scalar('int'));
  });
});

// ---------------------------------------------------------------------------
// 作用域诚实
// ---------------------------------------------------------------------------

describe('deriveDictFormats 作用域诚实', () => {
  it('def 体同名写点绝不并入模块作用域形状', () => {
    const fmt = asLiteral('d', [
      'd = {"a": 1}',
      'def f():',
      '    d = {"z": 9}'
    ]);
    expect(fmt.required.get('a')).toEqual(scalar('int'));
    expect(fmt.required.has('z')).toBe(false);
    expect(fmt.required.size).toBe(1);
  });

  it('函数局部写点不入 map', () => {
    expect(fmts(['def f():', '    loc = {"a": 1}']).has('loc')).toBe(false);
  });

  it('class 体写点不入 map', () => {
    expect(fmts(['class C:', '    d = {"z": 9}']).has('d')).toBe(false);
  });

  it('无 dict 写点变量不入 map', () => {
    const out = fmts(['x = 1', 'y = load()']);
    expect(out.has('x')).toBe(false);
    expect(out.has('y')).toBe(false);
  });

  it('注释/字符串位的写点形态不判', () => {
    const out = fmts([
      'd = {"a": 1}',
      '# d["x"] = 2',
      's = "d[k] = 9"',
      '# d = load()'
    ]);
    const fmt = out.get('d');
    if (!fmt || fmt.kind !== 'literal') {
      throw new Error(`d expected literal, got ${fmt?.kind ?? 'absent'}`);
    }
    expect(fmt.required.get('a')).toEqual(scalar('int'));
    expect(fmt.required.has('x')).toBe(false);
    expect(out.has('s')).toBe(false);
  });

  it('无条件非字面量重绑单独出现 → 变量缺席', () => {
    expect(fmts(['d = load()']).has('d')).toBe(false);
  });

  it('空文件/无写点 → 空 map', () => {
    expect(fmts(['']).size).toBe(0);
    expect(fmts([]).size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 元组值类型(SER-10 JSON 转换面的序列化方向证据;dumps 后 tuple→list)
// ---------------------------------------------------------------------------

describe('classifyValue 元组面', () => {
  it('(1, 2) 双元素同质 → tuple{int}', () => {
    const fmt = asLiteral('d', ['d = {"t": (1, 2)}']);
    expect(fmt.required.get('t')).toEqual({ kind: 'tuple', element: scalar('int') });
  });

  it("('a', 'b') → tuple{str}", () => {
    const fmt = asLiteral('d', ['d = {"t": (\'a\', \'b\')}']);
    expect(fmt.required.get('t')).toEqual({ kind: 'tuple', element: scalar('str') });
  });

  it('(1,) 单元素尾逗号 → tuple{int}', () => {
    const fmt = asLiteral('d', ['d = {"t": (1,)}']);
    expect(fmt.required.get('t')).toEqual({ kind: 'tuple', element: scalar('int') });
  });

  it('(1) 纯括号标量 → int 非元组', () => {
    const fmt = asLiteral('d', ['d = {"t": (1)}']);
    expect(fmt.required.get('t')).toEqual(scalar('int'));
  });

  it('(1, "x") 混合元素 → 元素未收敛(element null)', () => {
    const fmt = asLiteral('d', ['d = {"t": (1, "x")}']);
    expect(fmt.required.get('t')).toEqual({ kind: 'tuple', element: null });
  });

  it('嵌套元组递归:((1, 2), (3, 4)) → tuple{tuple{int}}', () => {
    const fmt = asLiteral('d', ['d = {"t": ((1, 2), (3, 4))}']);
    expect(fmt.required.get('t')).toEqual({
      kind: 'tuple',
      element: { kind: 'tuple', element: scalar('int') }
    });
  });

  it('(x for x in xs) 生成器表达式不是元组:嵌套值 unknown', () => {
    const fmt = asLiteral('d', ['d = {"t": {"inner": (x for x in xs)}}']);
    const t = fmt.required.get('t');
    if (!t || t.kind !== 'dict' || t.dict.kind !== 'literal') {
      throw new Error(`t expected literal dict, got ${t?.kind ?? 'absent'}`);
    }
    expect(t.dict.required.get('inner')).toEqual({ kind: 'unknown' });
  });

  it('顶层生成器值 → 推导式开放宇宙零观测(缺席,既有语义)', () => {
    expect(fmts(['d = {"t": (x for x in xs)}']).has('d')).toBe(false);
  });

  it('元组跨写点类型分歧 → unknown', () => {
    const fmt = asLiteral('d', [
      'if c:',
      '    d["t"] = (1, 2)',
      'else:',
      '    d["t"] = ("a", "b")'
    ]);
    expect(fmt.required.get('t')).toEqual({ kind: 'unknown' });
  });
});

// ---------------------------------------------------------------------------
// COV-98-TS-BACKEND 批 6:值分类族(逃逸/推导/残缺/嵌套等形)与收集
// 容错臂。九臂死码论证:282(group≠null ⟹ 栈内必有组帧,armIndex 反向
// 扫描必命中)、326(掩码全空行先被空行闸拦)、432(braceAt≥0 ⟹ probe
// 恒为 '{')、437(argText 是 rawTrim 子串,indexOf 必中)、552
// (splitTopLevel 恒返数组)、616(调用方已验首字符)、734(collector
// state 与首 rec 同 push 创建)、744(臂下标取值 1..armCount-1 不够
// armCount 个,arm0 缺席则 size<armCount 先拦)、784(unknownBase 路径
// 保留自身 rec,过滤只落非 always)。
// ---------------------------------------------------------------------------

describe('KSEM-SER-09 sweep: classifyValue 值分类族', () => {
  it('空值/推导式/残缺括号 → 不猜', () => {
    expect(classifyValue('')).toEqual({ kind: 'unknown' });
    expect(classifyValue('[x for x in y]')).toEqual({ kind: 'list', element: null });
    expect(classifyValue('[1, 2')).toEqual({ kind: 'unknown' });
    expect(classifyValue('(x for x in y)')).toEqual({ kind: 'unknown' });
    expect(classifyValue('(1')).toEqual({ kind: 'unknown' });
  });

  it('字典推导式与展开 → 嵌套开放;串内转义容忍', () => {
    const comp = classifyValue('{a for b in c}');
    expect(comp).toEqual({ kind: 'dict', dict: { kind: 'open', observed: new Map() } });
    const spread = classifyValue("{'a': 1, **r}");
    if (spread.kind !== 'dict' || spread.dict.kind !== 'open') {
      throw new Error('expected nested open dict');
    }
    expect(spread.dict.observed.get('a')).toEqual(scalar('int'));
    expect(classifyValue('["a\\\'b" for x in y]')).toEqual({ kind: 'list', element: null });
    expect(classifyValue("['a\\\"b', 1]")).toEqual({ kind: 'list', element: null });
    expect(classifyValue('"a\\\'b"')).toEqual(scalar('str'));
  });

  it('嵌套等形收敛与混合不猜', () => {
    expect(classifyValue('[[1], [2]]')).toEqual({
      kind: 'list',
      element: { kind: 'list', element: scalar('int') }
    });
    expect(classifyValue('[[1], []]')).toEqual({ kind: 'list', element: null });
    expect(classifyValue('((1,), (2,))')).toEqual({
      kind: 'tuple',
      element: { kind: 'tuple', element: scalar('int') }
    });
    expect(classifyValue('(1,)')).toEqual({ kind: 'tuple', element: scalar('int') });
    expect(classifyValue('(1)')).toEqual(scalar('int'));
  });
});

describe('KSEM-SER-09 sweep: 收集容错与合流边界', () => {
  it('未闭合字面量与 unknown 基条件写点:整变量不声称', () => {
    expect(fmts(['d = {"a": 1']).get('d')).toBeUndefined();
    expect(fmts(['d = make()', 'if c:', '    d["k"] = 1']).get('d')).toBeUndefined();
  });

  it('非写点行正常推进;def 域缩退后回到模块作用域', () => {
    const fmt = asLiteral('d', ['import json', 'd = {"a": 1}']);
    expect(fmt.required.get('a')).toEqual(scalar('int'));
    const afterDef = asLiteral('d', ['def f():', '    pass', 'd = {"a": 1}']);
    expect(afterDef.required.size).toBe(1);
  });

  it('for 体写点为 maybe 键', () => {
    const fmt = asLiteral('d', ['d = {}', 'for x in y:', '    d["k"] = 1']);
    expect(fmt.optional.get('k')).toEqual(scalar('int'));
    expect(fmt.required.size).toBe(0);
  });

  it('setdefault 变量键 / update 非字面量实参 → 开放(观测键面保留)', () => {
    const setd = asOpen('d', ['d = {"a": 1}', 'd.setdefault(k, 1)']);
    expect(setd.observed.get('a')).toEqual(scalar('int'));
    const upd = asOpen('d', ['d = {"a": 1}', 'd.update(other)']);
    expect(upd.observed.get('a')).toEqual(scalar('int'));
  });

  it('同秩类型冲突 → 该键值 unknown(不猜)', () => {
    const fmt = asLiteral('d', ['d = {}', 'if c:', '    d["k"] = 1', 'else:', '    d["k"] = "s"']);
    expect(fmt.required.get('k')).toEqual({ kind: 'unknown' });
  });

  it('字面量内 spread → 开放(观测键面保留)', () => {
    const fmt = asOpen('d', ['d = {**rest, "a": 1}']);
    expect(fmt.observed.get('a')).toEqual(scalar('int'));
  });

  it('嵌套多行 dict 值:递归全键必有', () => {
    const fmt = asLiteral('d', ['d = {"outer": {', '    "a": 1}}']);
    const outer = fmt.required.get('outer');
    if (outer?.kind !== 'dict' || outer.dict.kind !== 'literal') {
      throw new Error('expected nested literal dict');
    }
    expect(outer.dict.required.get('a')).toEqual(scalar('int'));
  });
});

describe('KSEM-SER-09 sweep 二批: 动态键冒号态与秩升位', () => {
  it('带冒号的动态键:顶层与嵌套各自开放,观测键面保留', () => {
    const top = asOpen('d', ['d = {k: 1, "a": 2}']);
    expect(top.observed.get('a')).toEqual(scalar('int'));
    const nested = classifyValue("{'a': 1, k: 2}");
    if (nested.kind !== 'dict' || nested.dict.kind !== 'open') {
      throw new Error('expected nested open dict');
    }
    expect(nested.dict.observed.get('a')).toEqual(scalar('int'));
  });

  it('sameKind:元组递归与 dict/unknown 同形收敛', () => {
    expect(classifyValue('[(1,), (2,)]')).toEqual({
      kind: 'list',
      element: { kind: 'tuple', element: scalar('int') }
    });
    expect(classifyValue('((1,), (2,))')).toEqual({
      kind: 'tuple',
      element: { kind: 'tuple', element: scalar('int') }
    });
    expect(classifyValue('[{"a": 1}, {"b": 2}]')).toEqual({
      kind: 'list',
      element: {
        kind: 'dict',
        dict: { kind: 'literal', required: new Map([['a', scalar('int')]]), optional: new Map() }
      }
    });
  });

  it('秩升位:后位 always 写点覆盖前位 maybe(同键)', () => {
    const fmt = asLiteral('d', ['if c:', '    d["k"] = 1', 'd["k"] = 2']);
    expect(fmt.required.get('k')).toEqual(scalar('int'));
  });

  it('带真实换行的嵌套字面量直查(合成行起始表)', () => {
    const nested = classifyValue('{\n"a": 1}');
    if (nested.kind !== 'dict' || nested.dict.kind !== 'literal') {
      throw new Error('expected nested literal dict');
    }
    expect(nested.dict.required.get('a')).toEqual(scalar('int'));
  });
});

describe('KSEM-SER-09 sweep 三批: sameKind 空元素同形', () => {
  it('元组空元素与元组空元素同形(递归不猜面)', () => {
    // 内层 ((1,), ("a",)) 混合 → tuple element null;两个同形互比 → 空元素相等臂
    expect(classifyValue('[((1,), ("a",)), ((2,), ("b",))]')).toEqual({
      kind: 'list',
      element: { kind: 'tuple', element: null }
    });
  });
});

// ---------------------------------------------------------------------------
// 批 29 语义钉面:注释/字符串位写点不判、未闭合括号退路、空写点集、
// unknown 基、字面量基+条件键并入。
// 覆盖口径残余:9 miss(282/326/432/437/552/616/734/744/784)与批 6 定性
// 一致(见下方九臂死码论证),本组不改变覆盖数,只补行为钉面。
// ---------------------------------------------------------------------------
describe('批 29:写点位与括号退路容错', () => {
  it('注释行里的 NAME = {…} 不是写点', () => {
    const out = fmts(['# CFG = {1: 2}', 'x = 1']);
    expect(out.has('CFG')).toBe(false);
  });

  it('字符串里的 name[...] = 不是写点(名位非真代码)', () => {
    const out = fmts(['s = "CFG[1] = 2"', 'x = 1']);
    expect(out.has('CFG')).toBe(false);
  });

  it('元组/括号未闭合 → unknown,不猜', () => {
    expect(classifyValue('(1, (2')).toEqual({ kind: 'unknown' });
    expect(classifyValue('(1')).toEqual({ kind: 'unknown' });
  });

  it('列表字面量在非 [ 开头时不进列表分支(dispatch 由首字符决定)', () => {
    expect(classifyValue('None')).toEqual(scalar('none'));
    expect(classifyValue('(1, 2)')).toEqual({ kind: 'tuple', element: scalar('int') });
  });
});

describe('批 29 续:空写点与纯 unknown 基', () => {
  it('无写点变量 → 不入表(空形状声称)', () => {
    expect(fmts(['x = 1', 'y = 2']).size).toBe(0);
  });

  it('模块级 unknown 基 + 无条件非字面量 → 表内无该名', () => {
    expect(fmts(['CFG = build()', 'CFG = other()']).size).toBe(0);
  });

  it('无条件字面量 + 条件写点 → 保留字面量基,键并入', () => {
    const fmt = asLiteral('CFG', [
      "CFG = {'a': 1}",
      'if c:',
      "    CFG['b'] = 2"
    ]);
    expect([...fmt.required.keys()]).toEqual(['a']);
    expect([...fmt.optional.keys()]).toEqual(['b']);
  });
});
