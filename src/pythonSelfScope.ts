// AUD-028(R2-F05):属性引用的「确定归属」不完整——getIncomingPythonPropertyAccesses
// 按 owner 文件原文正则扫描,结果混入字符串、注释、同文件另一普通类、嵌套重绑
// self 的 self.hp。此模块做词法/作用域过滤:经 pythonCodeLines 掩码排除字符串/
// 注释(位置不位移),按缩进栈跟踪 class/function 作用域与函数首个参数是否为
// self,只保留 owner 类直接方法内「self 即 owner 实例」的真读写点。
//
// 规则(对每个 self.<prop> 匹配,基于掩码文本与作用域栈):
//   ① 掩码后该位置已被替换为空白 → 字符串/注释,排除;
//   ② 归属类(掩码行所在顶层类)必须恰为 owner 类,同文件其它类排除;
//   ③ self 归属:最近一个「以 self 为首参」的函数作用域必须满足——其所在类
//      恰为 owner 类(嵌套类/其它类排除),且它不是嵌套在另一函数里的重绑
//      (def helper(self) 嵌套 → 该 self 非 owner 实例,排除);闭包(无 self
//      首参)不重绑,沿用外层方法 self,保留;
//   ④ self.<prop>( 带调用括号 → 方法调用(NAV-003 面),排除。

import { pythonCodeLines } from './pythonParser';

/** 一处 owner 类内的 self.<prop> 访问(0 基行/列;列指向属性名) */
export interface OwnerSelfPropertyAccess {
  line: number;
  character: number;
}

interface FunctionScope {
  /** 0 基 def 行 */
  startLine: number;
  /** 0 基结束行(不含;类/文件边界收口) */
  endLine: number;
  /** 首个参数名是否为 self(重绑判定) */
  selfBound: boolean;
  /** def 行所在最内层类名(无类=模块级函数) */
  className: string | null;
}

interface ClassScope {
  name: string;
  /** 0 基 class 行 */
  startLine: number;
  /** 0 基结束行(不含) */
  endLine: number;
}

/** 从函数头提取首个参数名(支持续行括号);掩码文本内取,字符串已屏蔽 */
function firstParamName(maskedLines: string[], defLine: number): string | null {
  let header = maskedLines[defLine] ?? '';
  let depth = 0;
  let started = false;
  let line = defLine;
  for (; line < maskedLines.length; line += 1) {
    const text = line === defLine ? header : maskedLines[line];
    for (const ch of text) {
      if (ch === '(') { depth += 1; started = true; }
      if (ch === ')') { depth -= 1; }
    }
    if (line > defLine) { header = `${header} ${text}`; }
    if (started && depth <= 0) { break; }
  }
  const open = header.indexOf('(');
  const close = header.lastIndexOf(')');
  if (open < 0 || close <= open) {
    return null;
  }
  const params = header.slice(open + 1, close).split(',');
  const first = params[0]?.trim();
  return /^self\b/.test(first ?? '') ? 'self' : first ?? null;
}

const computeIndent = (line: string): number =>
  (/^[ \t]*/.exec(line)?.[0] ?? '').replace(/\t/g, '    ').length;

/**
 * 在 owner 类作用域内找 self.<prop> 真读写点。
 * @param ownerClassName owner 类名(实体名/文件基名回退)
 * @returns 0 基行列列表,列指向属性名起点(与既有口径一致)
 */
export function findOwnerSelfPropertyAccesses(
  content: string,
  ownerClassName: string,
  propertyName: string
): OwnerSelfPropertyAccess[] {
  const masked = pythonCodeLines(content);
  const lineCount = masked.length;

  const classes: ClassScope[] = [];
  const functions: FunctionScope[] = [];
  const classStack: ClassScope[] = [];
  const functionStack: FunctionScope[] = [];

  // 第一遍:按缩进栈建立 class/function 作用域(闭括号以缩进回退判定)
  for (let line = 0; line < lineCount; line += 1) {
    const raw = masked[line];
    if (!raw || !raw.trim()) { continue; }
    const indent = computeIndent(raw);
    while (classStack.length && computeIndent(masked[classStack[classStack.length - 1].startLine]) >= indent) {
      classStack.pop()!.endLine = line;
    }
    while (functionStack.length && computeIndent(masked[functionStack[functionStack.length - 1].startLine]) >= indent) {
      functionStack.pop()!.endLine = line;
    }
    const classMatch = /^\s*class\s+([A-Za-z_]\w*)\s*(?:\(.*\))?\s*:/.exec(raw);
    if (classMatch) {
      const cls: ClassScope = { name: classMatch[1], startLine: line, endLine: lineCount };
      classes.push(cls);
      classStack.push(cls);
      continue;
    }
    const defMatch = /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/.exec(raw);
    if (defMatch) {
      const first = firstParamName(masked, line);
      functions.push({
        startLine: line,
        endLine: lineCount,
        selfBound: first === 'self',
        className: classStack.length > 0 ? classStack[classStack.length - 1].name : null
      });
      functionStack.push(functions[functions.length - 1]);
    }
  }
  for (const cls of classStack) { cls.endLine = lineCount; }
  for (const fn of functionStack) { fn.endLine = lineCount; }

  const ownerClass = classes.find(cls => cls.name === ownerClassName)
    ?? (classes.length === 1 ? classes[0] : null);

  const results: OwnerSelfPropertyAccess[] = [];
  const regex = new RegExp(`\\bself\\.${propertyName}\\b(?!\\s*\\()`, 'g');

  for (let line = 0; line < lineCount; line += 1) {
    const raw = masked[line];
    if (!raw) { continue; }
    regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(raw)) !== null) {
      // ② 归属类:掩码行所在顶层类必须为 owner 类(同文件其它类排除)
      if (ownerClass && (line < ownerClass.startLine || line >= ownerClass.endLine)) { continue; }
      // ③ self 归属:最近一个 self 首参函数作用域须为 owner 类直接方法
      const containing = functions.filter(fn => line >= fn.startLine && line < fn.endLine);
      const selfBinder = [...containing].reverse().find(fn => fn.selfBound);
      if (!selfBinder) { continue; } // 无 self 绑定(类体/模块级)→ 非实例访问
      if (ownerClass && selfBinder.className !== ownerClass.name) { continue; } // 其它/嵌套类
      // 嵌套重绑(def helper(self) 在方法内)→ 该 self 非 owner 实例,排除;
      // 闭包(无 self 首参)不构成 selfBinder,自会沿用外层方法
      const nestedInFunction = functions.some(fn =>
        fn !== selfBinder && fn.startLine < selfBinder.startLine && selfBinder.startLine < fn.endLine);
      if (nestedInFunction) { continue; }
      results.push({ line, character: match.index + 'self.'.length });
    }
  }
  return results;
}
