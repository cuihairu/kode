import { describe, expect, it } from 'vitest';

import { countCallArguments } from '../src/rpcArgCountDiagnostics';

/**
 * IDE-LINT-008 补臂(countCallArguments 词法态剩余分支):
 * 既有 rpcArgCountDiagnostics.test.ts 已覆盖主计数面(空/单/多参/跨行/星号
 * 段首/注释/字符串逗号);本文件专门补基线缺口语句:
 *   - 方法名后同行无 '('(只余空白)→ 未知(null)[73]
 *   - 字符串内反斜杠转义(跳过一个字符)[92]
 *   - 三引号字符串开/闭(docstring)[94-97,112]
 *   - 调用内 '#' 注释到行尾(跳出内层循环)[116]
 *   - 顶层逗号处段首星号(*args, x 形态)→ 未知(null)[124]
 *   - 嵌套结构内的开括号入栈([…,(…)] 形态)[153]
 *
 * 死臂(公开 API + 真实输入不可达,不强制测试):
 *   - resolveDeclaredArgCount 的 `if (declaredCount === null) return null;`[186]:
 *     函数唯一入口先按 expectedSection 过滤,length===0 已在行 167 返回 null;
 *     length>0 时首轮循环必先过 declaredArgs===undefined 检查(行 173 返回
 *     null)或把 declaredCount 赋为非 null(行 180)。故行 185 恒假,186 不可达。
 */

const callAt = (line: number, character: number, methodName: string) => ({
  line,
  character,
  receiver: 'cell' as const,
  section: 'CellMethods' as const,
  methodName
});

const count = (source: string): number | null =>
  countCallArguments(source.split('\n'), callAt(0, 'self.cell.'.length, 'foo'));

describe('countCallArguments 词法态补臂', () => {
  it('方法名后同行无左括号(仅空白)→ 未知(null)', () => {
    // 括号在下一行/缺失:openParen 保持 -1 → 行 73 返回 null
    expect(count('self.cell.foo   ')).toBeNull();
  });

  it('字符串内反斜杠转义跳过下一字符,不误当字符串闭合', () => {
    // `"a\"b"` 中 \" 是字符串内容;转义后字符串到行 19 的 " 才闭合,
    // 故两个实参 → 2
    expect(count('self.cell.foo("a\\"b", 2)')).toBe(2);
  });

  it('三引号字符串开/闭:"""...""" 整段一个实参,闭合检测走 startsWith 三连', () => {
    expect(count('self.cell.foo("""hi""", 2)')).toBe(2);
  });

  it('调用内 # 注释到行尾跳出内层循环,后续行继续计数', () => {
    expect(count('self.cell.foo(1, # comment\n 2)')).toBe(2);
  });

  it('顶层逗号处段首星号(收集)→ 未知(null)', () => {
    // *args 后跟逗号:逗号分支检查 segmentHasStar → null(区别于 `)` 分支)
    expect(count('self.cell.foo(*args, 2)')).toBeNull();
  });

  it('嵌套结构内开括号入栈(方括号内圆括号)不影响顶层计数', () => {
    expect(count('self.cell.foo([1, (2, 3)])')).toBe(1);
  });
});
