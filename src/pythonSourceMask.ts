/**
 * Python 源码「非代码面」掩码:注释尾与字符串字面量内容(含三引号、转义、
 * r/b/f 前缀)整体替换为空格,保留换行与行宽。供逐行扫描型分析器
 * (engineSpiCodeLens 作用域识别、configDataMutation 写点扫描)统一使用——
 * 字符串/注释里的 `def onInit` / `ITEMS[1]=2` 形态不再误认,多行字符串内的
 * 低缩进行也不再干扰缩进栈。
 *
 * 边界:按字符状态机掩码,不解析表达式;行尾 `\` 续行不合并(逐行扫描器的
 * 既有边界,文档化)。
 */

/** 把注释尾与字符串字面量(含三引号/f 前缀)整体替换为空格,保留换行 */
export function maskPythonNonCode(source: string): string {
  const out = source.split('');
  let i = 0;
  const n = source.length;
  const blank = (idx: number) => {
    if (out[idx] !== '\n' && out[idx] !== '\r') {
      out[idx] = ' ';
    }
  };
  while (i < n) {
    const ch = source[i];
    if (ch === '#') {
      while (i < n && source[i] !== '\n') {
        blank(i);
        i += 1;
      }
      continue;
    }
    if (ch === '"' || ch === '\'') {
      i = consumeMaskedString(source, out, i, blank);
      continue;
    }
    i += 1;
  }
  return out.join('');
}

/** 掩码从 startIdx 起的字符串字面量,返回字面量结束下标(越过闭引号) */
function consumeMaskedString(
  source: string,
  out: string[],
  startIdx: number,
  blank: (idx: number) => void
): number {
  const ch = source[startIdx];
  const triple = source.slice(startIdx, startIdx + 3) === ch.repeat(3);
  const quoteLen = triple ? 3 : 1;
  const closer = ch.repeat(quoteLen);
  for (let k = 0; k < quoteLen; k += 1) {
    blank(startIdx + k);
  }
  let i = startIdx + quoteLen;
  const n = source.length;
  while (i < n) {
    if (source[i] === '\\') {
      blank(i);
      if (i + 1 < n) {
        blank(i + 1);
      }
      i += 2;
      continue;
    }
    if (source.slice(i, i + quoteLen) === closer) {
      for (let k = 0; k < quoteLen; k += 1) {
        blank(i + k);
      }
      return i + quoteLen;
    }
    blank(i);
    i += 1;
  }
  return n;
}
