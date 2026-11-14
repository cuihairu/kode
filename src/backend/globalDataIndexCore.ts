// SRC-003(阶段 1):globalDataIndex.ts 纯逻辑面(键归一化/词法掩码/访问扫描/
// 函数返回/值类型推断,原 25..1374)迁出。纯移动:区域原文零改动,无
// vscode/path/fs 依赖,仅需 perf_hooks 计时;生命周期类经本模块导入回注,
// 公开导出在 globalDataIndex.ts 经 re-export 保持既有导入路径不变(消费
// 者零改动)。
import { performance } from 'perf_hooks';

/** KBEngine 模块级跨进程数据字典名(接收者必须是已引入的 kbe 别名) */
export const KBENGINE_DATA_DICTS = ['globalData', 'baseAppData', 'cellAppData'] as const;
export type KbeDataDictName = (typeof KBENGINE_DATA_DICTS)[number];

/** 一处字典键访问(单行口径;跨行/括号不闭合不取) */
export interface KbeDataDictAccess {
  dict: KbeDataDictName;
  /**
   * 归一化键签名:字面量→原值、标识符→名字、计算键→字面量骨架+`*`;
   * 函数调用键未解析(无解析器查询面)时为 null,此时 callFn 已设。
   */
  keySignature: string | null;
  /**
   * 键为纯函数调用形态 `Fn(args)` 时被调函数名(已解析记录与未解析
   * 标记记录都设);无解析器(查询面)的标记记录靠它识别调用键并现解。
   */
  callFn?: string;
  /** 行号(0 起) */
  line: number;
  /** 键表达式起始列(0 起,行内) */
  keyStart: number;
  /** 键表达式尾后一列 */
  keyEnd: number;
  kind: 'write' | 'read' | 'delete';
  /** 写点 RHS 直文本(增强赋值/无值时 null) */
  valueText: string | null;
  /**
   * `.get(KEY, DEFAULT)` 读点的 DEFAULT 直文本(KSEM-DATA-04:读点有效
   * 类型=写点类型 union ∪ default 类型);非 get 读点/写点缺省(不设)。
   */
  defaultText?: string | null;
  /** 访问表达式尾后一列(写点=RHS 尾、读点=`]`/`)` 尾);inlay/hover 标注位 */
  exprEnd: number;
}

/** 索引查询命中的一个访问点(带文件) */
export interface KbeDataDictSite extends KbeDataDictAccess {
  file: string;
}

const DATA_DICT_PATTERN = new RegExp(`(\\w+)\\.(${KBENGINE_DATA_DICTS.join('|')})\\b`, 'g');

/** 同步掩码包装的分块大小(输出与不分块逐字节一致,仅控制单段耗时) */
const MASK_CHUNK = 1 << 20;

/**
 * AUD-076(R4-F11):编辑路径调度预算——
 * - `EDIT_ASYNC_THRESHOLD_BYTES`:超过该字节数的文档改走异步预算化重扫
 *   (同步一次全量扫描大文件会连续阻塞宿主,审计实测单文件 292ms);
 *   预算内的常规小文件保持同步刷新(即时一致,无调度延迟)。
 * - `EDIT_SCAN_LINE_SLICE`:异步扫描每片行数(掩码+行扫描片)。
 * - `EDIT_COMMIT_ACCESS_SLICE`:异步倒排提交每片访问数(移除+新增)。
 */
const EDIT_ASYNC_THRESHOLD_BYTES = 64 * 1024;
const EDIT_SCAN_LINE_SLICE = 4000;
const EDIT_COMMIT_ACCESS_SLICE = 8000;

/** 让出宿主一个宏任务节拍(与冷扫同款) */
const yieldToHost = (): Promise<void> => new Promise<void>(resolve => setImmediate(resolve));

/** 增强赋值符(算写点,但值类型不可推);长符在前防前缀截断 */
const AUGMENTED_ASSIGN_OPS = [
  '**=', '//=', '<<=', '>>=',
  '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '@='
].sort((a, b) => b.length - a.length);

const NUMERIC_PATTERN = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/** 裸标识符(键静态常量解析位:非数字字面量) */
const IDENTIFIER_PATTERN = /^[A-Za-z_]\w*$/;

/**
 * 模块级静态常量绑定(KSEM-DATA-02):顶格 `NAME = "literal"` / 带注解
 * `NAME: str = "literal"`。同名多次赋值:值全等 → 该值;值冲突 → null
 * (条件分支序静态不可知,不猜运行时终值);RHS 非单段字符串字面量
 * (f-string/拼接/调用/引用)不入绑定(动态,不解析)。缩进赋值(函数/
 * 类体)不是模块作用域,不收——类常量解析需类域追踪,不在本面。
 */
export function extractModuleConstantBindings(text: string): Map<string, string | null> {
  const bindings = new Map<string, string[]>();
  for (const lineText of text.split(/\r?\n/)) {
    const match = /^([A-Za-z_]\w*)\s*(?::[^=]*)?=\s*(\S.*)$/.exec(lineText);
    if (!match) {
      continue;
    }
    const rhs = match[2].replace(/\s+#.*$/, '').trim();
    const literal = matchStringLiteral(rhs);
    if (literal === null) {
      continue;
    }
    const values = bindings.get(match[1]) ?? [];
    values.push(literal);
    bindings.set(match[1], values);
  }
  const resolved = new Map<string, string | null>();
  for (const [name, values] of bindings) {
    resolved.set(name, values.every(value => value === values[0]) ? values[0] : null);
  }
  return resolved;
}

/**
 * 裸标识符键静态常量解析(KSEM-DATA-02 验收句「静态常量按真实绑定解析,
 * 不把同名标识符恒当同一键值」):键表达式是裸标识符且本文件模块级绑定
 * 值确定(全等)→ 解析为绑定值(两文件各自 `KEY` 绑不同字面量 → 两个
 * 不同键族,不再按标识符名并作一族);无绑定/绑定冲突/非裸标识符 →
 * 原签名(标识符名,现状语义)。
 */
function resolveIdentifierSignature(
  signature: string,
  rawKey: string,
  bindings?: ReadonlyMap<string, string | null>
): string {
  if (!bindings || !IDENTIFIER_PATTERN.test(rawKey.trim())) {
    return signature;
  }
  return bindings.get(signature) ?? signature;
}

/**
 * 归一化键签名。精确形态(字符串字面量解引/标识符/数字字面量)→原文;
 * f-string 与顶层 `+` 拼接(至少一个字面量段)→字面量骨架+`*` 通配
 * (f"SERVER_{id}" → SERVER_*,"A"+str(x)+"B" → A*B);全动态/复杂表达式
 * → null(不索引,不硬猜)。
 */
export function normalizeKeySignature(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const literal = matchStringLiteral(trimmed);
  if (literal !== null) {
    return literal;
  }
  if (/^[A-Za-z_]\w*$/.test(trimmed) || NUMERIC_PATTERN.test(trimmed)) {
    return trimmed;
  }
  const fstring = matchFStringSignature(trimmed);
  if (fstring !== null) {
    return fstring;
  }
  return matchConcatSignature(trimmed);
}

/**
 * 转义序列解码(AUD-067):`\` 后一个字符按 Python 字面量语义解出。
 * 支持单字符转义(\\ \' \" \n \t \r \a \b \f \v)、八进制 1-3 位
 * (\0-\377)、十六进制 \xNN、Unicode \uNNNN / \UNNNNNNNN;不支持/非法
 * 转义 → null(如实跳过,不改写键值)。next=已消费的最后下标。
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
    while (j < text.length - 1 && j < index + 4 && /[0-7]/.test(text[j])) {
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
 * 单段字符串字面量 → 按 Python 值解引内容(AUD-067);非字面量/含未转义
 * 同引号/含不支持转义 → null。支持前缀:裸引号(普通转义)与 r/R(原始,
 * 反斜杠保留,仅 `\` 仍避免下一引号闭合,与 Python 同);b/B/u/U/f 前缀
 * 不在此处理(各自走字节/Unicode/f-string 或如实跳过)。
 */
function matchStringLiteral(text: string): string | null {
  const head = /^([rR]?)(['"])/.exec(text);
  if (!head) {
    return null;
  }
  const raw = head[1] !== '';
  const quote = head[2];
  if (text.length < 2 || text[text.length - 1] !== quote) {
    return null;
  }
  let inner = '';
  for (let index = head[0].length; index < text.length - 1; index += 1) {
    const ch = text[index];
    if (ch === '\\') {
      if (raw) {
        if (index + 1 >= text.length - 1) {
          return null;
        }
        inner += '\\';
        inner += text[index + 1];
        index += 1;
        continue;
      }
      const decoded = decodeEscape(text, index);
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

/** f-string → 字面量骨架,每个 {插值} 折叠为 `*`;非 f-string → null */
function matchFStringSignature(text: string): string | null {
  if (!/^[fF]['"]/.test(text) || text.length < 3 || text[text.length - 1] !== text[1]) {
    return null;
  }
  const inner = text.slice(2, -1);
  let skeleton = '';
  let index = 0;
  while (index < inner.length) {
    const ch = inner[index];
    if (ch === '{' && inner[index + 1] === '{') {
      skeleton += '{';
      index += 2;
      continue;
    }
    if (ch === '}' && inner[index + 1] === '}') {
      skeleton += '}';
      index += 2;
      continue;
    }
    if (ch === '{') {
      let depth = 1;
      let scan = index + 1;
      while (scan < inner.length && depth > 0) {
        if (inner[scan] === '{') {
          depth += 1;
        } else if (inner[scan] === '}') {
          depth -= 1;
        }
        scan += 1;
      }
      skeleton += '*';
      index = scan;
      continue;
    }
    skeleton += ch;
    index += 1;
  }
  return skeleton;
}

/**
 * 顶层 `+` 拼接 → 逐段签名:字面量/f-string 段出内容,其余段(标识符/
 * str(...) 等)折为 `*`;至少一个字面量段才有效(全动态无法可靠关联)。
 */
function matchConcatSignature(text: string): string | null {
  const parts = splitTopLevelPlus(text);
  if (parts.length < 2) {
    return null;
  }
  const emitted: string[] = [];
  let literalSegments = 0;
  for (const part of parts) {
    const piece = part.trim();
    const literal = matchStringLiteral(piece);
    if (literal !== null) {
      emitted.push(literal);
      literalSegments += 1;
      continue;
    }
    const fstring = matchFStringSignature(piece);
    if (fstring !== null) {
      emitted.push(fstring);
      literalSegments += 1;
      continue;
    }
    if (NUMERIC_PATTERN.test(piece)) {
      emitted.push(piece);
      literalSegments += 1;
      continue;
    }
    emitted.push('*');
  }
  if (literalSegments === 0) {
    return null;
  }
  return emitted.join('');
}

interface KeySpan {
  keyRaw: string;
  keyStart: number;
  keyEnd: number;
}

interface SubscriptParse extends KeySpan {
  kind: 'write' | 'read';
  valueText: string | null;
  exprEnd: number;
}

/** 访问表达式尾后一列(写点=RHS 尾、读点=`]`/`)` 尾);inlay/hover 标注位 */
type AccessSpan = KeySpan & { exprEnd: number };

/** 跳过行内空白后取列 */
function skipWhitespace(lineText: string, from: number): number {
  let index = from;
  while (index < lineText.length && /[ \t]/.test(lineText[index])) {
    index += 1;
  }
  return index;
}

/**
 * `[KEY]` 下标访问:闭合 `]` 须同行(深度计,字符串内不计);`]` 后是
 * `=`(非 `==`)为写点(RHS 为同行余文),增强赋值算写但无值文本,
 * 其余为读点。
 */
function parseSubscriptAccess(lineText: string, openBracket: number): SubscriptParse | null {
  let depth = 0;
  let inString: string | null = null;
  let close = -1;
  for (let index = openBracket; index < lineText.length; index += 1) {
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
    if (ch === '(' || ch === '[' || ch === '{') {
      depth += 1;
      continue;
    }
    if (ch === ')' || ch === ']' || ch === '}') {
      depth -= 1;
      if (depth < 0) {
        return null;
      }
      if (depth === 0 && ch === ']') {
        close = index;
        break;
      }
    }
  }
  if (close === -1) {
    return null;
  }
  const span = trimSpan(lineText, openBracket + 1, close);
  if (!span) {
    return null;
  }
  const after = skipWhitespace(lineText, close + 1);
  const nextChar = lineText[after];
  if (nextChar === '=' && lineText[after + 1] !== '=') {
    // RHS 去尾随注释(引号内 `#` 不算注释);valueText=去注释去空白原文,
    // exprEnd=值表达式尾后一列(inlay 标注位)
    const raw = lineText.slice(after + 1);
    const commentAt = findLineCommentIndex(raw);
    const valueText = (commentAt >= 0 ? raw.slice(0, commentAt) : raw).trim() || null;
    const valueStart = valueText !== null ? raw.indexOf(valueText) : -1;
    return {
      ...span,
      kind: 'write',
      valueText,
      exprEnd: valueText !== null && valueStart >= 0 ? after + 1 + valueStart + valueText.length : close + 1
    };
  }
  if (AUGMENTED_ASSIGN_OPS.some(op => lineText.startsWith(op, after))) {
    return { ...span, kind: 'write', valueText: null, exprEnd: close + 1 };
  }
  return { ...span, kind: 'read', valueText: null, exprEnd: close + 1 };
}

/** 从开括号列找匹配闭括号(引号/深度感知);未闭合(跨行)返回 -1 */
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
 * `.get(KEY[, default])` 读点:取首个实参为键(首个顶层逗号或闭括号为界),
 * 括号不闭合(跨行)不取;有顶层逗号时逗号后到闭括号的 trim 文本为
 * default(KSEM-DATA-04:读点有效类型 union ∪ default 类型;缺省不取
 * default 为 null)。exprEnd=闭括号尾后一列(inlay/hover 标注位)。
 */
function parseGetAccess(
  lineText: string,
  from: number
): (AccessSpan & { defaultText: string | null }) | null {
  const head = /^\.get[ \t]*\(/.exec(lineText.slice(from));
  if (!head) {
    return null;
  }
  const openParen = from + head[0].length - 1;
  const close = matchCloseParen(lineText, openParen);
  if (close < 0) {
    return null;
  }
  let depth = 0;
  let inString: string | null = null;
  let firstComma = -1;
  let secondComma = -1;
  for (let index = openParen + 1; index < close; index += 1) {
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
    if (ch === '(' || ch === '[' || ch === '{') {
      depth += 1;
      continue;
    }
    if (ch === ')' || ch === ']' || ch === '}') {
      depth -= 1;
      continue;
    }
    if (depth === 0 && ch === ',') {
      if (firstComma < 0) {
        firstComma = index;
      } else if (secondComma < 0) {
        secondComma = index;
        break;
      }
    }
  }
  const span = trimSpan(lineText, openParen + 1, firstComma < 0 ? close : firstComma);
  if (!span) {
    return null;
  }
  // default=第二实参(首顶层逗号到次顶层逗号/闭括号);超参形态只取第二参
  const defaultText =
    firstComma >= 0
      ? trimSpan(lineText, firstComma + 1, secondComma < 0 ? close : secondComma)?.keyRaw ?? null
      : null;
  return { ...span, defaultText, exprEnd: close + 1 };
}

/** 区间去首尾空白;空区间 → null */
function trimSpan(lineText: string, start: number, end: number): KeySpan | null {
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
  return { keyRaw: lineText.slice(lo, hi), keyStart: lo, keyEnd: hi };
}

/**
 * 词法分类掩码(AUD-065):逐字符标注 0=代码 / 1=字符串 / 2=注释,供扫描
 * 器剔除注释、普通字符串与三引号字符串(含跨行 docstring)里的伪访问。
 * 支持单/双引号字面量与 `'''`/`"""` 三引号字面量,字符串内 `\` 跳过下一
 * 字符(含 `\<newline>` 行延续);引号外 `#` 起到行尾为注释。字面量前缀
 * (r/b/f/u)不影响掩码——前缀字符留在代码域,引号起才进字符串。
 */
/** 掩码扫描的可续状态(字符串/注释跨块延续)。 */
interface MaskState {
  inString: { quote: string; triple: boolean } | null;
  index: number;
}

/**
 * 把词法掩码从 state.index 续写到 `end`(含状态延续)。分块调用时输出与
 * 一次性 `buildPythonCodeMask` 逐字节一致——仅把迭代序列按 `end` 分段,
 * 每段携带 inString 状态;注释/三引号快进可越过 `end`,由下一块从越过处续。
 */
function extendPythonCodeMask(
  text: string,
  mask: Uint8Array,
  state: MaskState,
  end: number
): void {
  let inString = state.inString;
  let index = state.index;
  for (; index < end && index < text.length; index += 1) {
    const ch = text[index];
    if (inString) {
      mask[index] = 1;
      if (ch === '\\') {
        if (index + 1 < text.length) {
          mask[index + 1] = 1;
          index += 1;
        }
        continue;
      }
      if (inString.triple) {
        if (text.startsWith(inString.quote, index)) {
          mask[index + 1] = 1;
          mask[index + 2] = 1;
          index += 2;
          inString = null;
        }
      } else if (ch === inString.quote) {
        inString = null;
      }
      continue;
    }
    if (ch === '#') {
      for (let j = index; j < text.length && text[j] !== '\n'; j += 1) {
        mask[j] = 2;
      }
      while (index < text.length && text[index] !== '\n') {
        index += 1;
      }
      index -= 1;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const triple = text.startsWith(ch.repeat(3), index);
      inString = { quote: ch, triple };
      mask[index] = 1;
      if (triple) {
        mask[index + 1] = 1;
        mask[index + 2] = 1;
        index += 2;
      }
      continue;
    }
    mask[index] = 0;
  }
  state.inString = inString;
  state.index = index;
}

export function buildPythonCodeMask(text: string): Uint8Array {
  const mask = new Uint8Array(text.length);
  const state: MaskState = { inString: null, index: 0 };
  while (state.index < text.length) {
    extendPythonCodeMask(text, mask, state, Math.min(state.index + MASK_CHUNK, text.length));
  }
  return mask;
}

/** `[start,start+length)` 全段是否代码(掩码全 0) */
function spanIsCode(mask: Uint8Array, start: number, length: number): boolean {
  for (let index = start; index < start + length; index += 1) {
    if (mask[index] !== 0) {
      return false;
    }
  }
  return true;
}

/** 全文每行起始偏移(按 `\n` 切分,兼容 `\r\n`) */
function lineStartOffsets(text: string): number[] {
  const starts: number[] = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\n') {
      starts.push(index + 1);
    }
  }
  return starts;
}

/**
 * 全文扫描字典键访问:接收者须为已引入的 kbe 别名(非 `alias.dict` 不
 * 认);别名前若是 `.`(如 x.KBEngine.globalData)视为属性链不接管,与
 * resolveKbeAccessAtPosition 同款守卫。键签名归一失败(全动态/复杂
 * 表达式)的访问跳过。AUD-065:只收词法代码域里的访问——注释、普通字符
 * 串、三引号字符串中的伪写/读点不入索引,真实下标与 get 的字符串键照常。
 */
/**
 * 扫描单行字典键访问(lineOffset=该行在全文中的起始偏移);同步与切片
 * 扫描共用。resolveCallKey 提供时,函数调用键 `Fn(args)` 按现解签名逐
 * 签名展开(一访问点可多条记录);无解析器(查询面)时以 callFn 标记记录
 * 保留,provider 据此现解。onCallKey 无论是否可解都回调(依赖追踪)。
 */
function scanLineDictAccesses(
  lineText: string,
  line: number,
  lineOffset: number,
  aliases: Set<string>,
  mask: Uint8Array,
  accesses: KbeDataDictAccess[],
  resolveCallKey?: (fn: string) => string[] | null,
  onCallKey?: (fn: string) => void,
  bindings?: ReadonlyMap<string, string | null>
): void {
  DATA_DICT_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = DATA_DICT_PATTERN.exec(lineText)) !== null) {
    if (!aliases.has(match[1])) {
      continue;
    }
    // 别名前是 '.'(x.KBEngine.globalData / self.kbe)→ 属性访问非模块访问
    if (match.index > 0 && lineText[match.index - 1] === '.') {
      continue;
    }
    // 词法上下文:alias.dict 整段必须是代码,注释/字符串里的假访问不入索引
    if (!spanIsCode(mask, lineOffset + match.index, match[0].length)) {
      continue;
    }
    const dict = match[2] as KbeDataDictName;
    const after = skipWhitespace(lineText, match.index + match[0].length);
    // KSEM-DATA-04:`del alias.dict[...]` 删除点(行内前缀 del 令牌;`del
    // x.get(k)` 非法语法不判——.get 臂不落 delete)。词法掩码已剔注释/
    // 字符串里的伪 del(访问段必须是代码)。
    const isDelete = /(?:^|[^\w])del[ \t]+$/.test(lineText.slice(0, match.index));
    const push = (
      span: AccessSpan,
      kind: 'write' | 'read' | 'delete',
      valueText: string | null,
      defaultText?: string | null
    ): void => {
      const keySignature = normalizeKeySignature(span.keyRaw);
      if (keySignature !== null) {
        accesses.push({
          dict,
          keySignature: resolveIdentifierSignature(keySignature, span.keyRaw, bindings),
          line,
          keyStart: span.keyStart,
          keyEnd: span.keyEnd,
          kind,
          valueText,
          defaultText,
          exprEnd: span.exprEnd
        });
        return;
      }
      // 归一失败:仅纯函数调用形态走调用键解析;其余复杂键(如 data[k])不索引
      const callForm = matchCallForm(span.keyRaw);
      if (!callForm) {
        return;
      }
      onCallKey?.(callForm.fn);
      if (resolveCallKey) {
        const sigs = resolveCallKey(callForm.fn);
        if (sigs !== null) {
          for (const sig of sigs) {
            accesses.push({
              dict,
              keySignature: sig,
              callFn: callForm.fn,
              line,
              keyStart: span.keyStart,
              keyEnd: span.keyEnd,
              kind,
              valueText,
              defaultText,
              exprEnd: span.exprEnd
            });
          }
        }
        return;
      }
      // 查询面无解析器:标记记录(键签名 null + callFn),provider 现解签名
      accesses.push({
        dict,
        keySignature: null,
        callFn: callForm.fn,
        line,
        keyStart: span.keyStart,
        keyEnd: span.keyEnd,
        kind,
        valueText,
        defaultText,
        exprEnd: span.exprEnd
      });
    };
    if (lineText[after] === '[') {
      const subscript = parseSubscriptAccess(lineText, after);
      if (subscript) {
        push(subscript, isDelete ? 'delete' : subscript.kind, isDelete ? null : subscript.valueText);
      }
      continue;
    }
    const getCall = parseGetAccess(lineText, after);
    if (getCall) {
      push(getCall, 'read', null, getCall.defaultText);
    }
  }
}

export function findKbeDataDictAccesses(
  text: string,
  aliases: Set<string>,
  resolveCallKey?: (fn: string) => string[] | null,
  onCallKey?: (fn: string) => void,
  bindings?: ReadonlyMap<string, string | null>
): KbeDataDictAccess[] {
  if (aliases.size === 0) {
    return [];
  }
  const mask = buildPythonCodeMask(text);
  const lineStarts = lineStartOffsets(text);
  const accesses: KbeDataDictAccess[] = [];
  // 模块常量绑定缺省自本全文取(全文扫描=同一文件);逐行扫描的调用方
  // (inlay 视口行)显式传全文绑定,单行自查无模块级赋值面
  const moduleBindings = bindings ?? extractModuleConstantBindings(text);
  const lines = text.split(/\r?\n/);
  for (let line = 0; line < lines.length; line += 1) {
    scanLineDictAccesses(
      lines[line],
      line,
      lineStarts[line] ?? 0,
      aliases,
      mask,
      accesses,
      resolveCallKey,
      onCallKey,
      moduleBindings
    );
  }
  return accesses;
}

/** 切片扫描统计(AUD-076:测试与诊断取证最大执行片) */
export interface SlicedScanStats {
  sliceCount: number;
  maxSliceMs: number;
}

/**
 * AUD-076(R4-F11):预算化切片扫描——掩码与行扫描同一条流式遍历(流式
 * 掩码对本行足够:spanIsCode 只查本行区间),每片 `EDIT_SCAN_LINE_SLICE`
 * 行让出一个宏任务节拍;片间复核 `isCancelled`,取消即放弃整份结果
 * (旧结果丢弃,由最新代重扫)。输出与同步 `findKbeDataDictAccesses`
 * 逐项一致(同一逐行体 + 同一分块掩码)。
 */
export async function findKbeDataDictAccessesSliced(
  text: string,
  aliases: Set<string>,
  isCancelled: () => boolean,
  lineSlice = EDIT_SCAN_LINE_SLICE,
  resolveCallKey?: (fn: string) => string[] | null,
  onCallKey?: (fn: string) => void,
  bindings?: ReadonlyMap<string, string | null>
): Promise<{ accesses: KbeDataDictAccess[] | null } & SlicedScanStats> {
  if (aliases.size === 0) {
    return { accesses: [], sliceCount: 0, maxSliceMs: 0 };
  }
  const moduleBindings = bindings ?? extractModuleConstantBindings(text);
  const mask = new Uint8Array(text.length);
  const maskState: MaskState = { inString: null, index: 0 };
  const accesses: KbeDataDictAccess[] = [];
  let offset = 0;
  let line = 0;
  let sliceCount = 0;
  let maxSliceMs = 0;
  while (offset < text.length) {
    const sliceStartedAt = performance.now();
    const sliceStart = offset;
    // 片尾 = 向前数 lineSlice 个换行(含其后换行符);末片到文末
    for (let i = 0; i < lineSlice && offset < text.length; i += 1) {
      const nl = text.indexOf('\n', offset);
      offset = nl === -1 ? text.length : nl + 1;
    }
    extendPythonCodeMask(text, mask, maskState, offset);
    let cursor = sliceStart;
    while (cursor < offset) {
      const nl = text.indexOf('\n', cursor);
      const lineEnd = nl === -1 ? text.length : nl;
      let lineText = text.slice(cursor, lineEnd);
      if (lineText.endsWith('\r')) {
        lineText = lineText.slice(0, -1);
      }
      scanLineDictAccesses(lineText, line, cursor, aliases, mask, accesses, resolveCallKey, onCallKey, moduleBindings);
      line += 1;
      cursor = lineEnd + 1;
    }
    sliceCount += 1;
    maxSliceMs = Math.max(maxSliceMs, performance.now() - sliceStartedAt);
    if (isCancelled()) {
      return { accesses: null, sliceCount, maxSliceMs };
    }
    await yieldToHost();
  }
  return { accesses, sliceCount, maxSliceMs };
}

/**
 * 落点命中某访问的键表达式区间(含首尾)时返回该访问;provider 定位用。
 * 逐行定位时显式传所属文件的模块常量绑定——裸标识符键的签名要与索引
 * 侧(全文绑定解析)一致,否则查询签名按标识符名查不到已解析键族。
 */
export function getKbeDataDictAccessAtPosition(
  lineText: string,
  character: number,
  aliases: Set<string>,
  bindings?: ReadonlyMap<string, string | null>
): KbeDataDictAccess | null {
  for (const access of findKbeDataDictAccesses(lineText, aliases, undefined, undefined, bindings)) {
    if (character >= access.keyStart && character <= access.keyEnd) {
      return access;
    }
  }
  return null;
}

/** 重扫该行,定位与 access 键区间对齐的 alias.dict 命中 span */
function findAliasDictSpanForAccess(
  lineText: string,
  access: KbeDataDictAccess
): { start: number; length: number } | null {
  DATA_DICT_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = DATA_DICT_PATTERN.exec(lineText)) !== null) {
    if (match[2] !== access.dict) {
      continue;
    }
    const after = skipWhitespace(lineText, match.index + match[0].length);
    if (lineText[after] === '[') {
      const subscript = parseSubscriptAccess(lineText, after);
      if (subscript && subscript.keyStart === access.keyStart) {
        return { start: match.index, length: match[0].length };
      }
    } else {
      const getCall = parseGetAccess(lineText, after);
      if (getCall && getCall.keyStart === access.keyStart) {
        return { start: match.index, length: match[0].length };
      }
    }
  }
  return null;
}

/**
 * AUD-066:查询源词法上下文验证。落点命中字典键访问且该访问的 alias.dict
 * 段在全文词法代码域(跨行三引号、外层字符串、注释里的伪访问一律 null;
 * 真实下标与 get 的字符串键允许)时返回该访问。provider 冷查前调用,保证
 * 外层字符串/注释中的伪访问不启动全量索引、不返回定义/引用。
 */
export function getDataDictAccessInCodeContext(
  documentText: string,
  line: number,
  character: number,
  aliases: Set<string>,
  bindings?: ReadonlyMap<string, string | null>
): KbeDataDictAccess | null {
  const lineStart = lineStartOffsets(documentText)[line];
  if (lineStart === undefined) {
    return null;
  }
  const rawLine = documentText.slice(lineStart).split(/\r?\n/, 1)[0];
  // 查询签名与索引侧同口径:裸标识符键按本文件模块常量绑定解析
  const moduleBindings = bindings ?? extractModuleConstantBindings(documentText);
  const access = getKbeDataDictAccessAtPosition(rawLine, character, aliases, moduleBindings);
  if (!access) {
    return null;
  }
  const aliasSpan = findAliasDictSpanForAccess(rawLine, access);
  if (!aliasSpan) {
    return null;
  }
  const mask = buildPythonCodeMask(documentText);
  return spanIsCode(mask, lineStart + aliasSpan.start, aliasSpan.length) ? access : null;
}

/** 共享数据键补全上下文(KSEM-DATA-02:键位里列出本域已知键) */
export interface DataDictKeyCompletionContext {
  /** 目标共享数据域(globalData/baseAppData/cellAppData) */
  dict: KbeDataDictName;
  /** 引号内已输入片段(片段内无引号无反斜杠;光标刚过 `[`/`.get(` 时空) */
  partial: string;
  /** 片段首列(替换范围起,不含引号) */
  replaceStart: number;
}

/**
 * 数据字典键位上下文(KSEM-DATA-02,cellData 键位同款口径):
 * `alias.globalData["片段` / `alias.globalData.get("片段` / 光标刚过 `[`
 * / `.get(`。接收者必须是已引入的 kbe 别名前缀(非 `x.KBEngine.globalData`
 * 属性链,与扫描器同守卫);无引号片段(空区间)与未开引号的键位也返回
 * 上下文(插入即引号后位置)。
 */
export function dataDictKeyCompletionContext(
  lineText: string,
  character: number,
  aliases: ReadonlySet<string>
): DataDictKeyCompletionContext | null {
  const text = lineText.slice(0, character);
  // 别名来自 import 解析(Python 标识符,无正则元字符)
  for (const alias of aliases) {
    const quoted = new RegExp(
      `(?:^|[^.\\w])${alias}\\.(globalData|baseAppData|cellAppData)\\s*(?:\\[\\s*|\\.get\\s*\\(\\s*)(["'])([^"'\\\\]*)$`
    );
    const bare = new RegExp(
      `(?:^|[^.\\w])${alias}\\.(globalData|baseAppData|cellAppData)\\s*(?:\\[\\s*|\\.get\\s*\\(\\s*)$`
    );
    const quotedMatch = quoted.exec(text);
    if (quotedMatch) {
      return {
        dict: quotedMatch[1] as KbeDataDictName,
        partial: quotedMatch[3],
        replaceStart: character - quotedMatch[3].length
      };
    }
    const bareMatch = bare.exec(text);
    if (bareMatch) {
      return { dict: bareMatch[1] as KbeDataDictName, partial: '', replaceStart: character };
    }
  }
  return null;
}

/** 行内首个引号外 `#` 注释列;无注释返回 -1(引号内 `#` 是字面量不算)。
 * 供扫描器剥离 RHS 尾随注释与 provider 排除注释里的假访问。
 */
export function findLineCommentIndex(lineText: string, from = 0): number {
  let inString: string | null = null;
  for (let index = from; index < lineText.length; index += 1) {
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
    if (ch === '#') {
      return index;
    }
  }
  return -1;
}

/** 键起点之前存在引号外 `#` 即注释里的假访问(provider 排除用) */
export function isKeyInsideLineComment(lineText: string, keyStart: number): boolean {
  const commentAt = findLineCommentIndex(lineText);
  return commentAt !== -1 && commentAt < keyStart;
}

/**
 * 键表达式是否为纯函数调用形态 `Fn(args)`(整体即调用,尾后无残余)。
 * 返回被调函数名;否则 null。供函数调用键识别与解析(与 f-string/拼接
 * 归一失败后的回退)。
 */
function matchCallForm(raw: string): { fn: string } | null {
  const trimmed = raw.trim();
  const head = /^([A-Za-z_]\w*)[ \t]*\(/.exec(trimmed);
  if (!head) {
    return null;
  }
  const fn = head[1];
  const open = head[0].length - head[1].length;
  const close = matchCloseParen(trimmed, open);
  if (close < 0 || trimmed.slice(close + 1).trim() !== '') {
    return null;
  }
  return { fn };
}

/**
 * 提取全文各模块级 `def Fn(...)` 的 return 表达式列表(Fn → 表达式列表,
 * 去 `return None`/裸 return;嵌套 def 体整体跳过——闭包函数不能按名在
 * 模块级调用,不属于调用键解析面;注释与字符串里的伪 def/return 由词法
 * 掩码剔除,与索引扫描同口径)。用于函数调用键 `Fn(args)` 跨文件静态解析。
 */
export function extractFunctionReturns(text: string): Map<string, string[]> {
  // 快路径:全文无 def 词(字符串/注释里的 def 也算命中,只影响是否走
  // 慢路径)→ 必无函数定义,免建全文词法掩码(大文件交互预算)
  if (!/(^|\W)def(\W|$)/.test(text)) {
    return new Map();
  }
  const mask = buildPythonCodeMask(text);
  const lineStarts = lineStartOffsets(text);
  const lines = text.split(/\r?\n/);
  const result = new Map<string, string[]>();
  const pushReturn = (fn: string, expr: string): void => {
    const list = result.get(fn) ?? [];
    list.push(expr);
    result.set(fn, list);
  };
  let line = 0;
  while (line < lines.length) {
    const raw = lines[line];
    const lineStart = lineStarts[line] ?? 0;
    const defMatch = /^(\s*)(?:async\s+)?def[ \t]+([A-Za-z_]\w*)[ \t]*\(/.exec(raw);
    if (defMatch) {
      const kwIndex = raw.indexOf('def', defMatch[1].length);
      if (spanIsCode(mask, lineStart + kwIndex, 3)) {
        const fn = defMatch[2];
        const defIndent = defMatch[1].length;
        // 同体 return(`def f(): return expr` 单行形态;头冒号在参数表
        // 闭括号后首个顶层面)
        const openParen = defMatch[0].length - 1;
        const closeParen = matchCloseParen(raw, openParen);
        if (closeParen >= 0) {
          const colon = raw.indexOf(':', closeParen + 1);
          if (colon >= 0) {
            const inlineRet = /^(\s*)return\b(.*)$/.exec(raw.slice(colon + 1));
            if (inlineRet) {
              const exprRaw = inlineRet[2];
              const commentAt = findLineCommentIndex(exprRaw);
              const expr = (commentAt >= 0 ? exprRaw.slice(0, commentAt) : exprRaw).trim();
              if (expr.length > 0 && expr !== 'None') {
                pushReturn(fn, expr);
              }
            }
          }
        }
        let cursor = line + 1;
        while (cursor < lines.length) {
          const bodyRaw = lines[cursor];
          if (bodyRaw.trim().length === 0) {
            cursor += 1;
            continue;
          }
          const bodyIndent = (/^[ \t]*/.exec(bodyRaw)?.[0].length) ?? 0;
          if (bodyIndent <= defIndent) {
            break;
          }
          // 嵌套 def:整段跳过(其 return 归属嵌套函数,由外层循环自会扫到)
          if (/^[ \t]*(?:async\s+)?def[ \t]+/.test(bodyRaw)) {
            const nestedIndent = bodyIndent;
            cursor += 1;
            while (cursor < lines.length) {
              const nr = lines[cursor];
              if (nr.trim().length === 0) {
                cursor += 1;
                continue;
              }
              if (((/^[ \t]*/.exec(nr)?.[0].length) ?? 0) <= nestedIndent) {
                break;
              }
              cursor += 1;
            }
            continue;
          }
          // return 语句(关键词在代码域;尾随注释剥离,裸/None 归动态)
          const retMatch = /^(\s*)return\b(.*)$/.exec(bodyRaw);
          if (retMatch) {
            const kwPos = bodyRaw.indexOf('return', retMatch[1].length);
            if (spanIsCode(mask, (lineStarts[cursor] ?? 0) + kwPos, 6)) {
              const exprRaw = retMatch[2];
              const commentAt = findLineCommentIndex(exprRaw);
              const expr = (commentAt >= 0 ? exprRaw.slice(0, commentAt) : exprRaw).trim();
              if (expr.length > 0 && expr !== 'None') {
                pushReturn(fn, expr);
              }
            }
          }
          cursor += 1;
        }
        line = cursor;
        continue;
      }
    }
    line += 1;
  }
  return result;
}

/** 嵌套调用解析深度上限(超限 → 不可静态求值,不硬猜) */
const MAX_RETURN_CALL_DEPTH = 3;

/**
 * 单个 return 表达式的签名集合(多签名来自嵌套调用的多 return):
 * 字面量→原值;f-string/顶层 `+` 拼接→骨架+`*`;裸标识符/数字→原文;
 * 纯调用 `G(...)`→递归解析 G 的 return 签名;其余(动态)→null。
 */
function returnExprSignatures(
  expr: string,
  fnDefs: ReadonlyMap<string, Map<string, string[]>>,
  depth: number,
  visiting: ReadonlySet<string>,
  onVisit?: (fn: string) => void
): string[] | null {
  const trimmed = expr.trim();
  if (trimmed.length === 0 || trimmed === 'None') {
    return null;
  }
  const literal = matchStringLiteral(trimmed);
  if (literal !== null) {
    return [literal];
  }
  if (/^[A-Za-z_]\w*$/.test(trimmed) || NUMERIC_PATTERN.test(trimmed)) {
    return [trimmed];
  }
  const fstring = matchFStringSignature(trimmed);
  if (fstring !== null) {
    return [fstring];
  }
  const concat = matchConcatSignature(trimmed);
  if (concat !== null) {
    return [concat];
  }
  const call = matchCallForm(trimmed);
  if (call) {
    return resolveFunctionReturns(call.fn, fnDefs, depth + 1, visiting, onVisit);
  }
  return null;
}

/**
 * 跨文件解析函数 Fn 的静态返回签名集合(并集:同一 Fn 多文件/多 return
 * 全部计入)。规则:Fn 不在工作区→null;递归/自指(visiting 环)→null;
 * 深度超限→null;全部 return 均动态(无静态签名)→null(不硬猜)。
 * onVisit 记录被访问函数(供调用方追踪依赖)。
 */
export function resolveFunctionReturns(
  fn: string,
  fnDefs: ReadonlyMap<string, Map<string, string[]>>,
  depth = 0,
  visiting: ReadonlySet<string> = new Set(),
  onVisit?: (fn: string) => void
): string[] | null {
  if (depth > MAX_RETURN_CALL_DEPTH || visiting.has(fn)) {
    return null;
  }
  onVisit?.(fn);
  const nextVisiting = new Set(visiting).add(fn);
  const allReturns: string[] = [];
  let found = false;
  for (const fileDefs of fnDefs.values()) {
    const returns = fileDefs.get(fn);
    if (returns && returns.length > 0) {
      found = true;
      for (const expr of returns) {
        allReturns.push(expr);
      }
    }
  }
  if (!found) {
    return null;
  }
  const signatures = new Set<string>();
  for (const expr of allReturns) {
    const sigs = returnExprSignatures(expr, fnDefs, depth, nextVisiting, onVisit);
    if (sigs !== null) {
      for (const sig of sigs) {
        signatures.add(sig);
      }
    }
  }
  return signatures.size > 0 ? [...signatures] : null;
}

/** 前后函数定义表的差异函数名集(新增/删除/return 列表变化) */
function diffFunctionDefs(
  prev: Map<string, string[]> | undefined,
  next: Map<string, string[]>
): string[] {
  const changed: string[] = [];
  const all = new Set([...(prev?.keys() ?? []), ...next.keys()]);
  for (const fn of all) {
    const a = prev?.get(fn) ?? [];
    const b = next.get(fn) ?? [];
    if (a.length !== b.length || a.some((value, index) => value !== b[index])) {
      changed.push(fn);
    }
  }
  return changed;
}

/** 顶层(深度 0、字符串外)按分隔符切分;段保留原文 */
function splitTopLevel(text: string, sep: string): string[] {
  const parts: string[] = [];
  let current = '';
  let depth = 0;
  let inString: string | null = null;
  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index];
    if (inString) {
      current += ch;
      if (ch === '\\') {
        index += 1;
        if (index < text.length) {
          current += text[index];
        }
        continue;
      }
      if (ch === inString) {
        inString = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      inString = ch;
      current += ch;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') {
      depth += 1;
      current += ch;
      continue;
    }
    if (ch === ')' || ch === ']' || ch === '}') {
      depth -= 1;
      current += ch;
      continue;
    }
    if (ch === sep && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts;
}

/**
 * 顶层(深度 0、字符串外)`+` 切分(原 splitTopLevelPlus 改经通用 splitTopLevel);
 * 段保留原文。
 */
function splitTopLevelPlus(text: string): string[] {
  return splitTopLevel(text, '+');
}

/** 取成对括号内文:`[..]`/`{..}`/`(..)` 全闭合且其后仅空白才认;未闭合 → null */
function bracketedInner(text: string, open: string, close: string): string | null {
  if (!text.startsWith(open)) {
    return null;
  }
  let depth = 0;
  let inString: string | null = null;
  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index];
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
    if (ch === open) {
      depth += 1;
      continue;
    }
    if (ch === close) {
      depth -= 1;
      if (depth === 0) {
        return text.slice(index + 1).trim() === '' ? text.slice(open.length, index) : null;
      }
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') {
      depth += 1;
      continue;
    }
    if (ch === ')' || ch === ']' || ch === '}') {
      depth -= 1;
      continue;
    }
  }
  return null;
}

/** 顶层(深度 0、字符串外)存在冒号(字典对 `k: v` 判据) */
function hasTopLevelColon(text: string): boolean {
  let depth = 0;
  let inString: string | null = null;
  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index];
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
    if (ch === '(' || ch === '[' || ch === '{') {
      depth += 1;
      continue;
    }
    if (ch === ')' || ch === ']' || ch === '}') {
      depth -= 1;
      continue;
    }
    if (ch === ':' && depth === 0) {
      return true;
    }
  }
  return false;
}

/** 去重保序,`|` 连接(单类型不包) */
function unionJoin(types: Array<string | null>): string | null {
  const distinct: string[] = [];
  for (const type of types) {
    if (type !== null && !distinct.includes(type)) {
      distinct.push(type);
    }
  }
  return distinct.length > 0 ? distinct.join(' | ') : null;
}

/**
 * 字典值类型推断(能推才显,严格面):字面量/集合/元组/已知构造可推,
 * 任何未知成分(Any/未推断元素/运算符/链式/小写函数调用)整体 null,
 * 不显 Any、不硬猜。写点 RHS → 类型;读点侧由调用方并同键写点类型。
 */
export function inferDataDictValueType(valueText: string | null): string | null {
  if (!valueText) {
    return null;
  }
  return inferTypeExpr(valueText.trim());
}

function inferTypeExpr(text: string): string | null {
  const t = text.trim();
  if (!t) {
    return null;
  }
  if (t === 'None') {
    return 'None';
  }
  if (t === 'True' || t === 'False') {
    return 'bool';
  }
  if (NUMERIC_PATTERN.test(t)) {
    return /^[+-]?\d+$/.test(t) ? 'int' : 'float';
  }
  if (matchStringLiteral(t) !== null || matchFStringSignature(t) !== null) {
    return 'str';
  }
  const listInner = bracketedInner(t, '[', ']');
  if (listInner !== null) {
    const elements = splitTopLevel(listInner, ',')
      .map(piece => piece.trim())
      .filter(piece => piece.length > 0);
    if (elements.length === 0) {
      return null;
    }
    const elementType = unionJoin(elements.map(inferTypeExpr));
    return elementType === null ? null : `List[${elementType}]`;
  }
  const tupleInner = bracketedInner(t, '(', ')');
  if (tupleInner !== null) {
    const elements = splitTopLevel(tupleInner, ',')
      .map(piece => piece.trim())
      .filter(piece => piece.length > 0);
    if (elements.length === 0) {
      return null;
    }
    const memberTypes = elements.map(inferTypeExpr);
    if (memberTypes.some(type => type === null)) {
      return null;
    }
    return `Tuple[${memberTypes.join(', ')}]`;
  }
  const braceInner = bracketedInner(t, '{', '}');
  if (braceInner !== null) {
    const pairs = splitTopLevel(braceInner, ',')
      .map(piece => piece.trim())
      .filter(piece => piece.length > 0);
    if (pairs.length === 0) {
      return null;
    }
    if (hasTopLevelColon(braceInner)) {
      const keyTypes: string[] = [];
      const valueTypes: string[] = [];
      for (const pair of pairs) {
        const colon = splitTopLevel(pair, ':');
        if (colon.length < 2) {
          return null;
        }
        const keyType = inferTypeExpr(colon[0]);
        const valueType = inferTypeExpr(colon.slice(1).join(':'));
        if (keyType === null || valueType === null) {
          return null;
        }
        keyTypes.push(keyType);
        valueTypes.push(valueType);
      }
      const keyUnion = unionJoin(keyTypes);
      const valueUnion = unionJoin(valueTypes);
      return keyUnion === null || valueUnion === null ? null : `Dict[${keyUnion}, ${valueUnion}]`;
    }
    const elementType = unionJoin(pairs.map(inferTypeExpr));
    return elementType === null ? null : `Set[${elementType}]`;
  }
  const call = /^([A-Za-z_]\w*)\s*\(/.exec(t);
  if (call && t.endsWith(')')) {
    const fn = call[1];
    if (fn === 'str' || fn === 'int' || fn === 'float' || fn === 'bool') {
      return fn;
    }
    // list()/dict()/set() 元素未知(Any)→ 严格面不出;类构造(大写)返回实例类名
    if (fn === 'list' || fn === 'dict' || fn === 'set') {
      return null;
    }
    if (/^[A-Z]/.test(fn)) {
      return fn;
    }
    return null;
  }
  // 裸标识符/属性链/运算符/其余调用 → 未知(能推才显,不硬猜)
  return null;
}

// SRC-003:供 globalDataIndex.ts 生命周期面回注的非公开内部符号。
export {
  EDIT_ASYNC_THRESHOLD_BYTES,
  EDIT_COMMIT_ACCESS_SLICE,
  EDIT_SCAN_LINE_SLICE,
  diffFunctionDefs,
  yieldToHost
};
