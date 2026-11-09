import { describe, expect, it } from 'vitest';
import {
  getPythonMaskPassCountForTests,
  maskPythonNonCode,
  resetPythonMaskPassCountForTests
} from '../src/backend/pythonLexicalMask';

// pythonLexicalMask 缺口臂(2026-11-09 覆盖率扫尾):字符串前缀识别(普通/
// 原始/字节/unicode 前缀与非前缀标识符)、f-string 转义花括号/表达式段/
// 反斜杠/三引号、普通字符串行尾未闭合与 EOF 未闭合臂。
//
// 死臂取证:
// - maskPythonNonCode 顶层 fexprDepth 分支(114-119):顶层循环声明
//   fexprDepth=0 后从不递增(表达式段只在 maskStringAt 内部递归处理),
//   分支恒假,不可达。

const mask = (text: string): string => maskPythonNonCode(text);

describe('pythonLexicalMask 缺口臂:字符串前缀', () => {
  it('前缀识别:r/f/b/u 与组合前缀保前缀字节,非前缀标识符不误认', () => {
    // r 前缀:引号前的 while 回走收集前缀 run(掩从引号起,前缀字节保留)
    expect(mask('x = r"hi"')).toBe('x = r    ');
    // 组合前缀 rb:run='rb' 匹配
    expect(mask('x = rb"hi"')).toBe('x = rb    ');
    // u 前缀
    expect(mask('x = u"hi"')).toBe('x = u    ');
    // f 前缀(表达式段入口臂在下一组测)
    expect(mask('x = f"hi"')).toBe('x = f    ');
    // 非前缀标识符(x 紧贴引号)run='abc' 不匹配 → 按普通字符串继续掩,
    // 前缀字节 a/b/c 保留
    expect(mask('x = abc"hi"')).toBe('x = abc    ');
  });
});

describe('pythonLexicalMask 缺口臂:f-string 各段', () => {
  it('字面量段掩掉,{{ 转义随字面量掩,{ 进表达式段保持可见', () => {
    // f"{{lit}}":{{ 是字面量花括号,随字面量全掩
    expect(mask('v = f"{{lit}}"')).toBe('v = f         ');
    // f"{expr}":引号掩掉,{expr} 保持可见
    const out = mask('v = f"{a + 1}"');
    expect(out.indexOf('{a + 1}')).toBe(6);
    expect(out[5]).toBe(' ');
    expect(out[out.length - 1]).toBe(' ');
  });

  it('表达式段:嵌套花括号保持可见,内嵌字符串照掩,注释到行尾掩', () => {
    // 嵌套花括号 {a:{b}c}:全部表达式保持可见
    const nested = mask('v = f"{a:{b}c}"');
    expect(nested.indexOf('{a:{b}c}')).toBe(6);
    // 表达式内嵌字符串:内层字符串掩掉(引号与内容)
    const inner = mask("v = f\"{x + 's'}\"");
    expect(inner).not.toContain("'s'");
    expect(inner.indexOf('x +')).toBe(7);
    // 表达式内注释到行尾掩掉,配对 } 回字面量段
    const withComment = mask('v = f"{x # note\n}"');
    expect(withComment).not.toContain('note');
    expect(withComment.indexOf('}')).toBeGreaterThan(0);
  });

  it('f-string 三引号与反斜杠:closeLen 3 收口,字面量段反斜杠成对掩', () => {
    // 三引号 f-string:整个字面量(含引号/内容/反斜杠)全掩
    const triple = mask('v = f"""a\\nb"""');
    expect(triple.slice(0, 6)).toBe('v = f ');
    expect(triple.slice(6)).toMatch(/^ +$/);
    // 普通三引号内单个引号(非三连):不误当闭合,继续掩(普通串收口臂)
    const lone = mask('v = """a"b"""');
    expect(lone.slice(0, 7)).toBe('v =    ');
    expect(lone.slice(7)).toMatch(/^ +$/);
    // 字面量段反斜杠转义成对掩(普通字符串:引号也随字面量全掩)
    const esc = mask('v = "a\\"b"');
    expect(esc).toBe('v =       ');
  });
});

describe('pythonLexicalMask 缺口臂:普通字符串未闭合边界', () => {
  it('行尾未闭合掩到换行前;EOF 未闭合掩到文件尾不越界', () => {
    expect(mask('v = "abc\nw = 1')).toBe('v =     \nw = 1');
    expect(mask('v = "abc')).toBe('v =     ');
  });

  it('测试面计数器:每轮 mask 恰一次,可重置', () => {
    resetPythonMaskPassCountForTests();
    mask('a = 1');
    mask('# c\nb = 2');
    expect(getPythonMaskPassCountForTests()).toBe(2);
    resetPythonMaskPassCountForTests();
    expect(getPythonMaskPassCountForTests()).toBe(0);
  });
});
