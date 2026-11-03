/**
 * Python 词法掩码(IDE-LINT-005):一次全文扫描,把注释与字符串字面量
 * (普通/三引号/原始/字节前缀)替换为同长度空白,f-string 的 `{...}` 表达式
 * 部分保留为可见代码、字面量部分掩掉。掩码保长保行(换行不掩),所有列
 * 偏移不变——receiver lint 的调用发现与 guard 分析都在掩码文本上做,天然
 * 不被字符串/注释内容误认(条件里的引号冒号、字面量里的 return 等)。
 * 每轮诊断计算只调一次(计数器供测试面核对),不逐命中重扫。
 */

let maskPassCount = 0;

/** 测试面:掩码全文扫描次数(每轮 compute 恰 1 次,与命中数无关) */
export function getPythonMaskPassCountForTests(): number {
  return maskPassCount;
}

export function resetPythonMaskPassCountForTests(): void {
  maskPassCount = 0;
}

const isQuote = (char: string): boolean => char === '"' || char === "'";

/** 引号前的字符串前缀(如 r/f/rb/fr);非前缀字母串(如标识符)返回空 */
const stringPrefixBefore = (text: string, quoteIndex: number): string => {
  let start = quoteIndex;
  while (start > 0 && /\w/.test(text[start - 1])) { start -= 1; }
  const run = text.slice(start, quoteIndex);
  return /^[rbfu]{0,2}$/i.test(run) ? run : '';
};

/**
 * 掩掉 text[start..] 起的一个字符串字面量(含引号),返回结束后的下标。
 * f-string:字面量部分掩掉,遇 `{`(非 `{{`)进入表达式段——表达式段保持
 * 可见,内嵌字符串/注释递归掩掉,配对 `}` 回到字面量段。
 */
function maskStringAt(text: string, out: string[], start: number): number {
  const n = text.length;
  const quote = text[start];
  const fstring = /f/i.test(stringPrefixBefore(text, start));
  const triple = text.slice(start, start + 3) === quote.repeat(3);
  const openLen = triple ? 3 : 1;
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to && k < n; k += 1) {
      if (text[k] !== '\n' && text[k] !== '\r') { out[k] = ' '; }
    }
  };
  blank(start, start + openLen);
  let i = start + openLen;
  let fexprDepth = 0; // >0:f-string 表达式段(代码可见)
  while (i < n) {
    const char = text[i];
    if (fexprDepth > 0) {
      if (char === '{') { fexprDepth += 1; i += 1; continue; }
      if (char === '}') { fexprDepth -= 1; i += 1; continue; }
      if (char === '#') { i = maskCommentAt(text, out, i); continue; }
      if (isQuote(char)) { i = maskStringAt(text, out, i); continue; }
      i += 1; continue; // 表达式代码保持可见
    }
    if (fstring) {
      // f-string 字面量段:掩掉;`{{` 转义随段掩,`{` 进入表达式段
      if (char === quote && (!triple || text.slice(i, i + 3) === quote.repeat(3))) {
        const closeLen = triple ? 3 : 1;
        blank(i, i + closeLen);
        return i + closeLen;
      }
      if (char === '{' && text[i + 1] === '{') { blank(i, i + 2); i += 2; continue; }
      if (char === '{') { fexprDepth = 1; i += 1; continue; }
      if (char === '\\') { blank(i, i + 2); i += 2; continue; }
      blank(i, i + 1);
      i += 1;
      continue;
    }
    // 普通字符串:掩到结束引号/行尾(转义成对跳过)
    if (char === '\\') { blank(i, i + 2); i += 2; continue; }
    if (char === quote) {
      if (triple && text.slice(i, i + 3) !== quote.repeat(3)) { blank(i, i + 1); i += 1; continue; }
      blank(i, i + openLen);
      return i + openLen;
    }
    if (!triple && (char === '\n' || char === '\r')) { return i; }
    blank(i, i + 1);
    i += 1;
  }
  return n;
}

/** 顶层代码段掩一行内注释(到行尾) */
function maskCommentAt(text: string, out: string[], start: number): number {
  const n = text.length;
  let j = start;
  while (j < n && text[j] !== '\n' && text[j] !== '\r') {
    out[j] = ' ';
    j += 1;
  }
  return j;
}

/**
 * 全文一次扫描产出掩码文本(与输入等长,换行原样保留):
 * - 注释 → 空白;字符串字面量(含引号与前缀外内容)→ 空白;
 * - f-string `{...}` 表达式段保持可见,其中嵌套字符串/注释仍掩掉;
 * - `{{`/`}}` 是字面量花括号,随字面量段掩掉。
 */
export function maskPythonNonCode(text: string): string {
  maskPassCount += 1;
  const out = text.split('');
  const n = text.length;
  let i = 0;
  let fexprDepth = 0;
  while (i < n) {
    const char = text[i];
    if (fexprDepth > 0) {
      // f-string 表达式段:代码可见,花括号记深,嵌套字符串/注释照掩
      if (char === '{') { fexprDepth += 1; i += 1; continue; }
      if (char === '}') { fexprDepth -= 1; i += 1; continue; }
      if (char === '#') { i = maskCommentAt(text, out, i); continue; }
      if (isQuote(char)) { i = maskStringAt(text, out, i); continue; }
      i += 1;
      continue;
    }
    if (char === '#') { i = maskCommentAt(text, out, i); continue; }
    if (isQuote(char)) { i = maskStringAt(text, out, i); continue; }
    i += 1;
  }
  return out.join('');
}
