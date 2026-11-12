/**
 * cellData 键访问扫描(KSEM-CELL-05 跳转/引用):`self.cellData["key"]` /
 * `self.cellData.get("key")` 字符串字面量键的落点探测与全文扫描。
 *
 * 与 cellDataCompletion 分工:补全只关心开引号+片段(键入中),本模块只认
 * 完整闭合的字符串字面量键(落点在键上才跳转/引用)。诚实边界:
 * - 只收字符串字面量键;动态键(`self.cellData[var]`)/f-string/拼接 → 不
 *   扫描不探测(不可静态关联,不硬猜);
 * - 词法掩码剔除注释/字符串里的伪访问(跨行三引号/docstring 同口径);
 * - 键字面量解引支持转义(\\ \' \" \n \t 等单字符 + 八进制/十六进制/Unicode,
 *   非法转义 → 该键跳过,不改写键值)。
 */
import { buildPythonCodeMask, findLineCommentIndex } from './globalDataIndexCore';

/** 一次 cellData 键访问(字符串字面量键,闭合)。 */
export interface CellDataKeyAccessSite {
  /** 解引后的键(字符串字面量值)。 */
  key: string;
  /** 键内容起点(0 基字符列,行内;不含引号)。 */
  keyStart: number;
  /** 键内容尾后一列(0 基,不含引号)。 */
  keyEnd: number;
  /** 行号(0 基)。 */
  line: number;
  /** 访问形态:下标 `[..]` 或 `.get(..)`。 */
  kind: 'subscript' | 'get';
}

interface ParsedKeyAccess {
  key: string;
  keyStart: number;
  keyEnd: number;
  /** 整个访问表达式尾后一列(扫描前进位)。 */
  accessEnd: number;
  kind: 'subscript' | 'get';
}

/** 全文每行起始偏移(按 `\n` 切分,兼容 `\r\n`)。 */
function lineStartOffsetsOf(text: string): number[] {
  const starts: number[] = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\n') {
      starts.push(index + 1);
    }
  }
  return starts;
}

/** `[start,start+length)` 全段是否代码(掩码全 0)。 */
function spanIsCode(mask: Uint8Array, start: number, length: number): boolean {
  for (let index = start; index < start + length; index += 1) {
    if (mask[index] !== 0) {
      return false;
    }
  }
  return true;
}

/** 跳过行内空白后取列。 */
function skipWhitespace(lineText: string, from: number): number {
  let index = from;
  while (index < lineText.length && /[ \t]/.test(lineText[index])) {
    index += 1;
  }
  return index;
}

/**
 * 转义序列解码:`\` 后一个字符按 Python 字面量语义解出。支持单字符转义
 * (\\ \' \" \n \t \r \a \b \f \v)、八进制 1-3 位、十六进制 \xNN、Unicode
 * \uNNNN / \UNNNNNNNN;不支持/非法转义 → null(如实跳过)。next=已消费最后下标。
 */
function decodeEscape(text: string, index: number): { value: string; next: number } | null {
  const next = text[index + 1];
  if (next === undefined) {
    return null;
  }
  const simple: Record<string, string> = {
    '\\': '\\',
    "'": "'",
    '"': '"',
    n: '\n',
    t: '\t',
    r: '\r',
    a: '\x07',
    b: '\b',
    f: '\f',
    v: '\x0b'
  };
  if (next in simple) {
    return { value: simple[next], next: index + 1 };
  }
  if (/[0-7]/.test(next)) {
    let octal = '';
    let j = index + 1;
    while (j < text.length && j < index + 4 && /[0-7]/.test(text[j])) {
      octal += text[j];
      j += 1;
    }
    const code = parseInt(octal, 8);
    if (code > 0xff) {
      return null;
    }
    return { value: String.fromCharCode(code), next: j - 1 };
  }
  if (next === 'x') {
    const hex = text.slice(index + 2, index + 4);
    if (!/^[0-9a-fA-F]{2}$/.test(hex)) {
      return null;
    }
    return { value: String.fromCharCode(parseInt(hex, 16)), next: index + 3 };
  }
  if (next === 'u') {
    const hex = text.slice(index + 2, index + 6);
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
      return null;
    }
    return { value: String.fromCharCode(parseInt(hex, 16)), next: index + 5 };
  }
  if (next === 'U') {
    const hex = text.slice(index + 2, index + 10);
    if (!/^[0-9a-fA-F]{8}$/.test(hex)) {
      return null;
    }
    return { value: String.fromCodePoint(parseInt(hex, 16)), next: index + 9 };
  }
  return null;
}

/**
 * 字符串字面量(整体为 `'...'`/`"..."`)→ 按 Python 值解引内容;非字面量/
 * 含未转义同引号/含非法转义 → null。
 */
function decodeStringLiteral(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length < 2) {
    return null;
  }
  const quote = trimmed[0];
  if ((quote !== "'" && quote !== '"') || trimmed[trimmed.length - 1] !== quote) {
    return null;
  }
  let inner = '';
  for (let index = 1; index < trimmed.length - 1; index += 1) {
    const ch = trimmed[index];
    if (ch === '\\') {
      const decoded = decodeEscape(trimmed, index);
      if (decoded === null) {
        return null;
      }
      inner += decoded.value;
      index = decoded.next;
      continue;
    }
    if (ch === quote) {
      return null;
    }
    inner += ch;
  }
  return inner;
}

/** 区间去首尾空白;空区间 → null。 */
function trimSpan(lineText: string, start: number, end: number): { raw: string; lo: number; hi: number } | null {
  let lo = start;
  let hi = end;
  while (lo < hi && /\s/.test(lineText[lo])) {
    lo += 1;
  }
  while (hi > lo && /\s/.test(lineText[hi - 1])) {
    hi -= 1;
  }
  if (lo >= hi) {
    return null;
  }
  return { raw: lineText.slice(lo, hi), lo, hi };
}

/** 从开括号列找匹配闭括号(引号/深度感知);未闭合(跨行)返回 -1。 */
function matchCloseParen(lineText: string, openParen: number): number {
  let depth = 0;
  let inString: string | null = null;
  for (let index = openParen; index < lineText.length; index += 1) {
    const ch = lineText[index];
    if (inString) {
      if (ch === '\\') {
        index += 1;
        continue;
      }
      if (ch === inString) {
        inString = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      inString = ch;
      continue;
    }
    if (ch === '(') {
      depth += 1;
      continue;
    }
    if (ch === ')') {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
      continue;
    }
  }
  return -1;
}

/**
 * 在 `self.cellData` 之后的 `[..]` / `.get(..)` 里解析字符串字面量键。
 * 键非字面量(动态/拼接/f-string)→ null(不静态关联)。返回访问面(键区间
 * + 访问尾位);`[`/`(` 未闭合(跨行)或键解析失败 → null。
 */
function parseCellDataKeyAccess(lineText: string, from: number): ParsedKeyAccess | null {
  const after = skipWhitespace(lineText, from);
  const ch = lineText[after];
  if (ch === '[') {
    // 找闭合 `]`(引号/深度感知,同行)
    let depth = 0;
    let inString: string | null = null;
    let close = -1;
    for (let index = after; index < lineText.length; index += 1) {
      const c = lineText[index];
      if (inString) {
        if (c === '\\') {
          index += 1;
          continue;
        }
        if (c === inString) {
          inString = null;
        }
        continue;
      }
      if (c === "'" || c === '"') {
        inString = c;
        continue;
      }
      if (c === '[') {
        depth += 1;
        continue;
      }
      if (c === ']') {
        depth -= 1;
        if (depth === 0) {
          close = index;
          break;
        }
        continue;
      }
    }
    if (close === -1) {
      return null;
    }
    const span = trimSpan(lineText, after + 1, close);
    if (!span) {
      return null;
    }
    const key = decodeStringLiteral(span.raw);
    if (key === null) {
      return null;
    }
    return { key, keyStart: span.lo + 1, keyEnd: span.hi - 1, accessEnd: close + 1, kind: 'subscript' };
  }
  if (ch === '.') {
    const head = /^\.get[ \t]*\(/.exec(lineText.slice(after));
    if (!head) {
      return null;
    }
    const openParen = after + head[0].length - 1;
    const close = matchCloseParen(lineText, openParen);
    if (close < 0) {
      return null;
    }
    // 首实参:首个顶层逗号或闭括号为界
    let depth = 0;
    let inString: string | null = null;
    let firstEnd = close;
    for (let index = openParen + 1; index < close; index += 1) {
      const c = lineText[index];
      if (inString) {
        if (c === '\\') {
          index += 1;
          continue;
        }
        if (c === inString) {
          inString = null;
        }
        continue;
      }
      if (c === "'" || c === '"') {
        inString = c;
        continue;
      }
      if (c === '(' || c === '[' || c === '{') {
        depth += 1;
        continue;
      }
      if (c === ')' || c === ']' || c === '}') {
        depth -= 1;
        continue;
      }
      if (depth === 0 && c === ',') {
        firstEnd = index;
        break;
      }
    }
    const span = trimSpan(lineText, openParen + 1, firstEnd);
    if (!span) {
      return null;
    }
    const key = decodeStringLiteral(span.raw);
    if (key === null) {
      return null;
    }
    return { key, keyStart: span.lo + 1, keyEnd: span.hi - 1, accessEnd: close + 1, kind: 'get' };
  }
  return null;
}

/**
 * 落点是否在 cellData 键字符串字面量内(键内容区间,含首尾;不含引号)。
 * 同行探测;非 self.cellData 键访问/动态键/未闭合 → null。落点在注释里
 * 的伪访问由调用方经 isKeyInsideLineComment 排除(与 globalData 同口径)。
 */
export function cellDataKeyAccessAtPosition(
  lineText: string,
  character: number
): { key: string; keyStart: number; keyEnd: number; kind: 'subscript' | 'get' } | null {
  let search = 0;
  while (search < lineText.length) {
    const match = /self\.cellData\b/.exec(lineText.slice(search));
    if (!match) {
      break;
    }
    const receiverStart = search + match.index;
    const receiverEnd = receiverStart + match[0].length;
    const parsed = parseCellDataKeyAccess(lineText, receiverEnd);
    // 键内容区间 [keyStart, keyEnd)(keyEnd 为尾后一列=闭引号列):闭引号/
    // 闭括号上的落点不是键内容,不命中。
    if (parsed && character >= parsed.keyStart && character < parsed.keyEnd) {
      return { key: parsed.key, keyStart: parsed.keyStart, keyEnd: parsed.keyEnd, kind: parsed.kind };
    }
    search = parsed ? Math.max(parsed.accessEnd, receiverEnd) : receiverEnd;
  }
  return null;
}

/**
 * 全文扫描 cellData 字符串字面量键访问(引用查询)。词法掩码剔除注释/普通
 * 字符串/三引号字符串里的伪访问;动态键跳过。只收当前行闭合的访问。
 */
export function scanCellDataKeyAccesses(text: string): CellDataKeyAccessSite[] {
  const mask = buildPythonCodeMask(text);
  const lineStarts = lineStartOffsetsOf(text);
  const lines = text.split(/\r?\n/);
  const sites: CellDataKeyAccessSite[] = [];
  for (let line = 0; line < lines.length; line += 1) {
    const raw = lines[line];
    const lineStart = lineStarts[line] ?? 0;
    let search = 0;
    while (search < raw.length) {
      const match = /self\.cellData\b/.exec(raw.slice(search));
      if (!match) {
        break;
      }
      const receiverStart = search + match.index;
      const receiverEnd = receiverStart + match[0].length;
      // self.cellData 段必须在词法代码域(注释/字符串里的伪访问不入索引)
      if (!spanIsCode(mask, lineStart + receiverStart, match[0].length)) {
        search = receiverEnd;
        continue;
      }
      const parsed = parseCellDataKeyAccess(raw, receiverEnd);
      if (parsed) {
        sites.push({ key: parsed.key, keyStart: parsed.keyStart, keyEnd: parsed.keyEnd, line, kind: parsed.kind });
        search = parsed.accessEnd;
        continue;
      }
      search = receiverEnd;
    }
  }
  return sites;
}

/**
 * 落点前的行内注释判断(与 globalData 同口径):键起点之前存在引号外 `#`
 * 即注释里的伪访问,provider 排除用。
 */
export function isCellDataKeyInsideLineComment(lineText: string, keyStart: number): boolean {
  const commentAt = findLineCommentIndex(lineText);
  return commentAt !== -1 && commentAt < keyStart;
}
