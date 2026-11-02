import * as path from 'path';
import * as vscode from 'vscode';
import { performance } from 'perf_hooks';
import { findFilesAcrossRoots, getExternalScanRoots } from './scanRoots';
import { PY_SCAN_EXCLUDE } from './pythonScanRules';
import { getKbeAliases } from './kbeModuleIndex';

// GLOBDATA-001(2026-10-30 用户令):KBEngine.globalData / baseAppData /
// cellAppData 三个跨进程数据字典的键访问索引。引擎侧事实(源码核验,
// /home/cui/workspaces/kbengine):三者为 GlobalDataClient(Dict[str, Any])
// 模块属性,key/value 经 script::Pickler(pickle.dumps)序列化→dbmgr
// GlobalDataServer 广播→接收侧 Pickler::unpickle 还原同一 Python 对象
// (globaldata_client.cpp:98-104、entity_app.h:1261-1308)——一侧设置的
// 类型在另一侧可恢复,故写点值类型可在读点推导。拓扑:globalData→全部
// 进程、baseAppData→仅 baseapp、cellAppData→仅 cellapp(globaldata_
// server.cpp:60-110)。
//
// 键粒度(用户定口径):字符串字面量按键值、标识符按键名文本;计算键
// `"SERVER_" + str(id)` / f"SERVER_{id}" 归一化为「字面量骨架 + `*` 通配」
// 签名(如 SERVER_*),同签名即同键族互链;全动态(a + b,无字面量锚点)
// 不索引。写点 `[K] = RHS`(增强赋值算写但无值类型)、读点 `[K]` 与
// `.get(K[, default])`。纯逻辑扫描面不依赖 vscode,索引类仿 WorkspaceIndex
// (cache/revisions/building + findFilesAcrossRoots + watcher + noteSaved)。

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
  kind: 'write' | 'read';
  /** 写点 RHS 直文本(增强赋值/无值时 null) */
  valueText: string | null;
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
 * `.get(KEY[, default])` 读点:只取首个实参(首个顶层逗号或闭括号为界),
 * 括号不闭合(跨行)不取;exprEnd=闭括号尾后一列(inlay/hover 标注位)。
 */
function parseGetAccess(lineText: string, from: number): AccessSpan | null {
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
      const span = trimSpan(lineText, openParen + 1, index);
      return span ? { ...span, exprEnd: close + 1 } : null;
    }
  }
  const span = trimSpan(lineText, openParen + 1, close);
  return span ? { ...span, exprEnd: close + 1 } : null;
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
  onCallKey?: (fn: string) => void
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
    const push = (span: AccessSpan, kind: 'write' | 'read', valueText: string | null): void => {
      const keySignature = normalizeKeySignature(span.keyRaw);
      if (keySignature !== null) {
        accesses.push({
          dict,
          keySignature,
          line,
          keyStart: span.keyStart,
          keyEnd: span.keyEnd,
          kind,
          valueText,
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
        exprEnd: span.exprEnd
      });
    };
    if (lineText[after] === '[') {
      const subscript = parseSubscriptAccess(lineText, after);
      if (subscript) {
        push(subscript, subscript.kind, subscript.valueText);
      }
      continue;
    }
    const getCall = parseGetAccess(lineText, after);
    if (getCall) {
      push(getCall, 'read', null);
    }
  }
}

export function findKbeDataDictAccesses(
  text: string,
  aliases: Set<string>,
  resolveCallKey?: (fn: string) => string[] | null,
  onCallKey?: (fn: string) => void
): KbeDataDictAccess[] {
  if (aliases.size === 0) {
    return [];
  }
  const mask = buildPythonCodeMask(text);
  const lineStarts = lineStartOffsets(text);
  const accesses: KbeDataDictAccess[] = [];
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
      onCallKey
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
  onCallKey?: (fn: string) => void
): Promise<{ accesses: KbeDataDictAccess[] | null } & SlicedScanStats> {
  if (aliases.size === 0) {
    return { accesses: [], sliceCount: 0, maxSliceMs: 0 };
  }
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
      scanLineDictAccesses(lineText, line, cursor, aliases, mask, accesses, resolveCallKey, onCallKey);
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

/** 落点命中某访问的键表达式区间(含首尾)时返回该访问;provider 定位用 */
export function getKbeDataDictAccessAtPosition(
  lineText: string,
  character: number,
  aliases: Set<string>
): KbeDataDictAccess | null {
  for (const access of findKbeDataDictAccesses(lineText, aliases)) {
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
  aliases: Set<string>
): KbeDataDictAccess | null {
  const lineStart = lineStartOffsets(documentText)[line];
  if (lineStart === undefined) {
    return null;
  }
  const rawLine = documentText.slice(lineStart).split(/\r?\n/, 1)[0];
  const access = getKbeDataDictAccessAtPosition(rawLine, character, aliases);
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

/**
 * 行内首个引号外 `#` 注释列;无注释返回 -1(引号内 `#` 是字面量不算)。
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

/**
 * AUD-068:文件所属作用域根(跨进程字典不跨工程/集群共享命名空间)。
 * 最深的 workspace 根前缀,否则外部扫描根(assetsRoot)前缀,否则 ''(独立
 * 作用域)。倒排键与查询都带根身份,不同根同名键不再互跳。
 */
export function resolveScopeRoot(fsPath: string): string {
  let best: string | null = null;
  const consider = (root: string): void => {
    const base = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
    if (fsPath === root || fsPath.startsWith(base)) {
      if (best === null || root.length > best.length) {
        best = root;
      }
    }
  };
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    consider(folder.uri.fsPath);
  }
  if (best === null) {
    for (const root of getExternalScanRoots()) {
      consider(root);
    }
  }
  return best ?? '';
}

const siteKey = (root: string, dict: string, keySignature: string): string =>
  `${root}\u0000${dict}\u0000${keySignature}`;

/**
 * AUD-076(R4-F11):预算化倒排提交——移除旧访问 + 新增新访问,每片
 * `EDIT_COMMIT_ACCESS_SLICE` 个访问让出一个宏任务节拍。提交本身
 * 不可中途取消(中断会留半提交状态),但片间让路保证宿主不被连续
 * 占用;是否放行由调用方在提交前一次性复核(仅最新代进提交)。
 */
export async function replaceFileSitesSliced(
  byKey: Map<string, KbeDataDictSite[]>,
  fsPath: string,
  previous: KbeDataDictAccess[],
  next: KbeDataDictAccess[],
  accessSlice = EDIT_COMMIT_ACCESS_SLICE
): Promise<SlicedScanStats> {
  const root = resolveScopeRoot(fsPath);
  let sliceCount = 0;
  let maxSliceMs = 0;
  for (let start = 0; start < previous.length; start += accessSlice) {
    const t0 = performance.now();
    const end = Math.min(start + accessSlice, previous.length);
    for (let i = start; i < end; i += 1) {
      const access = previous[i];
      if (access.keySignature === null) {
        continue;
      }
      const key = siteKey(root, access.dict, access.keySignature);
      const sites = byKey.get(key);
      if (!sites) {
        continue;
      }
      const kept = sites.filter(site => site.file !== fsPath);
      if (kept.length === 0) {
        byKey.delete(key);
      } else {
        byKey.set(key, kept);
      }
    }
    sliceCount += 1;
    maxSliceMs = Math.max(maxSliceMs, performance.now() - t0);
    if (end < previous.length) {
      await yieldToHost();
    }
  }
  for (let start = 0; start < next.length; start += accessSlice) {
    const t0 = performance.now();
    const end = Math.min(start + accessSlice, next.length);
    for (let i = start; i < end; i += 1) {
      const access = next[i];
      if (access.keySignature === null) {
        continue;
      }
      const key = siteKey(root, access.dict, access.keySignature);
      const sites = byKey.get(key) ?? [];
      sites.push({ ...access, file: fsPath });
      byKey.set(key, sites);
    }
    sliceCount += 1;
    maxSliceMs = Math.max(maxSliceMs, performance.now() - t0);
    if (end < next.length) {
      await yieldToHost();
    }
  }
  return { sliceCount, maxSliceMs };
}

const INITIAL_SCAN_CONCURRENCY = 8;

/** 单文件的索引缓存项:访问记录 + 该文件调用键引用的函数名集(依赖追踪) */
interface FileIndexEntry {
  accesses: KbeDataDictAccess[];
  callFns: Set<string>;
}

/**
 * 跨文件字典键索引(仿 WorkspaceIndex):首次查询建全量索引 +
 * watcher 增量失效,`noteSaved` 走编辑器路径免读盘;查询走内存
 * `(dict, 键签名) → 访问点[]`,不每次重扫。单实例由 extension 装配,
 * references/definition 共用。
 */
export class GlobalDataDictIndex {
  private readonly cache = new Map<string, FileIndexEntry>();
  private readonly building = new Map<string, Promise<{ accesses: KbeDataDictAccess[] } | null>>();
  private readonly byKey = new Map<string, KbeDataDictSite[]>();
  /** 每文件 `def Fn` → return 表达式列表(函数调用键跨文件解析用) */
  private readonly fnDefsByFile = new Map<string, Map<string, string[]>>();
  /** 函数名 → 引用它的调用键文件集(函数定义变化时重扫这些文件) */
  private readonly callKeyDependents = new Map<string, Set<string>>();
  /** 待处理调用键依赖重扫(冷启动/重建时一并等待,防查询时索引未收敛) */
  private readonly pendingDependentIndexes = new Set<Promise<unknown>>();
  private readonly revisions = new Map<string, number>();
  private watchers: vscode.Disposable[] = [];
  private documentListener?: vscode.Disposable;
  private saveListener?: vscode.Disposable;
  private closeListener?: vscode.Disposable;
  private foldersListener?: vscode.Disposable;
  private renameListener?: vscode.Disposable;
  /** 当前脏(未保存)编辑的 .py 文档;弃改关闭时据此回读盘版本。 */
  private readonly dirtyDocs = new Set<string>();
  /** 根集世代:removeRoot/invalidate 前进,在飞旧读不得发布旧根(AUD-071)。 */
  private generation = 0;
  private started = false;
  private starting?: Promise<void>;
  private disposed = false;
  /**
   * AUD-076:大文件编辑路径的最新缓冲快照(noteSaved 登记,异步重扫
   * 迭代开始时读——同一文件的连续编辑自然合并为最新一份)。
   */
  private readonly editBuffers = new Map<string, string>();
  /** AUD-076:每文件在飞异步重扫(合并窗:在飞时新编辑只更新缓冲+revision) */
  private readonly editInProgress = new Set<string>();
  /** AUD-076:最近一次大文件编辑重扫统计(测试与诊断取证最大执行片) */
  readonly lastEditStats = {
    commits: 0,
    scansCancelled: 0,
    maxSliceMs: 0,
    sliceCount: 0
  };

  constructor(private readonly pyGlob = '**/*.py') {}

  /** 首次使用时建全量索引并挂 watcher(幂等)。 */
  async ensureStarted(): Promise<void> {
    if (this.started || this.disposed) {
      return;
    }
    const starting = this.starting ??= this.startIndex();
    try {
      await starting;
    } catch (error) {
      if (this.starting === starting) {
        this.starting = undefined;
      }
      throw error;
    }
  }

  private async startIndex(): Promise<void> {
    this.documentListener ??= vscode.workspace.onDidChangeTextDocument(event => {
      this.noteSaved(event.document);
    });
    this.saveListener ??= vscode.workspace.onDidSaveTextDocument(document => {
      this.dirtyDocs.delete(document.uri.fsPath);
    });
    this.closeListener ??= vscode.workspace.onDidCloseTextDocument(document => {
      if (this.disposed) {
        return;
      }
      const fsPath = document.uri.fsPath;
      if (!fsPath.endsWith('.py')) {
        return;
      }
      // 弃改关闭:缓冲消失,回读盘版本覆盖索引(干净关闭为 no-op 不丢正确索引)
      if (this.dirtyDocs.delete(fsPath)) {
        this.revisions.set(fsPath, (this.revisions.get(fsPath) ?? 0) + 1);
        void this.indexFile(document.uri);
      }
    });
    this.foldersListener ??= vscode.workspace.onDidChangeWorkspaceFolders(event => {
      // AUD-071:根集变化——移除根立即撤回其贡献;添加根/资产根切换整库重建
      const removed = (event as { removed?: ReadonlyArray<{ uri: { fsPath: string } }> }).removed ?? [];
      const added = (event as { added?: ReadonlyArray<{ uri: { fsPath: string } }> }).added ?? [];
      for (const folder of removed) {
        this.removeRoot(folder.uri.fsPath);
      }
      if (added.length > 0) {
        this.invalidate();
      }
    });
    this.renameListener ??= vscode.workspace.onDidRenameFiles(event => {
      for (const { oldUri, newUri } of event.files) {
        this.revisions.set(oldUri.fsPath, (this.revisions.get(oldUri.fsPath) ?? 0) + 1);
        this.revisions.set(newUri.fsPath, (this.revisions.get(newUri.fsPath) ?? 0) + 1);
        const entry = this.cache.get(oldUri.fsPath);
        this.replaceFileSites(oldUri.fsPath, entry?.accesses ?? [], []);
        this.cache.delete(oldUri.fsPath);
        if (newUri.fsPath.endsWith('.py')) {
          if (entry) {
            this.cache.set(newUri.fsPath, entry);
            this.replaceFileSites(newUri.fsPath, [], entry.accesses);
            // 函数定义表随文件移动;调用键依赖表键从旧路径改新路径
            const defs = this.fnDefsByFile.get(oldUri.fsPath);
            if (defs) {
              this.fnDefsByFile.delete(oldUri.fsPath);
              this.fnDefsByFile.set(newUri.fsPath, defs);
            }
            for (const fn of entry.callFns) {
              const deps = this.callKeyDependents.get(fn);
              if (deps) {
                deps.delete(oldUri.fsPath);
                deps.add(newUri.fsPath);
              }
            }
          } else {
            void this.indexFile(newUri);
          }
        } else {
          this.fnDefsByFile.delete(oldUri.fsPath);
        }
      }
    });
    for (const document of vscode.workspace.textDocuments) {
      if (document.isDirty) {
        this.noteSaved(document);
      }
    }
    const initialRevisions = new Map(this.revisions);
    // AUD-074(R4-F09):监听先挂——初扫到挂 watcher 之间的空窗会让真实
    // create/change/delete 事件丢失(捕获旧字节后删文件→幽灵写点,捕获后
    // 改文件→旧内容发布)。watcher 先于 findFiles/扫描创建:变更升 revision
    // 使在飞旧读作废(AUD-070 追读接手),删除撤 cache+revision;扫描 worker
    // 对升过 revision 的文件跳过交由监听器,监听与全扫互不覆盖(最新者胜)。
    const watcher = vscode.workspace.createFileSystemWatcher(this.pyGlob);
    watcher.onDidCreate(uri => {
      void this.indexFile(uri);
    });
    watcher.onDidChange(uri => {
      // AUD-070:变更升 revision——在飞读盘若读到旧字节即作废,由追读接手
      this.revisions.set(uri.fsPath, (this.revisions.get(uri.fsPath) ?? 0) + 1);
      void this.indexFile(uri);
    });
    watcher.onDidDelete(uri => {
      this.revisions.set(uri.fsPath, (this.revisions.get(uri.fsPath) ?? 0) + 1);
      const entry = this.cache.get(uri.fsPath);
      this.replaceFileSites(uri.fsPath, entry?.accesses ?? [], []);
      this.cache.delete(uri.fsPath);
    });
    this.watchers.push(watcher);
    const files = await findFilesAcrossRoots(this.pyGlob, PY_SCAN_EXCLUDE);
    if (this.disposed) {
      return;
    }
    let nextFile = 0;
    const scanWorker = async (): Promise<void> => {
      while (!this.disposed && nextFile < files.length) {
        const uri = files[nextFile++];
        if ((this.revisions.get(uri.fsPath) ?? 0) !== (initialRevisions.get(uri.fsPath) ?? 0)) {
          continue;
        }
        await this.indexFile(uri);
      }
    };
    await Promise.all(Array.from({ length: Math.min(INITIAL_SCAN_CONCURRENCY, files.length) }, scanWorker));
    if (this.disposed) {
      return;
    }
    // 调用键依赖重扫(函数定义晚到触发的重扫)收敛后才算索引就绪
    await this.drainPendingDependents();
    if (this.disposed) {
      return;
    }
    this.started = true;
  }

  dispose(): void {
    this.disposed = true;
    this.documentListener?.dispose();
    this.documentListener = undefined;
    this.saveListener?.dispose();
    this.saveListener = undefined;
    this.closeListener?.dispose();
    this.closeListener = undefined;
    this.foldersListener?.dispose();
    this.foldersListener = undefined;
    this.renameListener?.dispose();
    this.renameListener = undefined;
    for (const watcher of this.watchers) {
      watcher.dispose();
    }
    this.watchers = [];
    this.cache.clear();
    this.byKey.clear();
    this.revisions.clear();
    this.dirtyDocs.clear();
    this.editBuffers.clear();
    this.editInProgress.clear();
    this.fnDefsByFile.clear();
    this.callKeyDependents.clear();
    this.pendingDependentIndexes.clear();
  }

  /** 单文件建/重建索引;并发去重(同文件不重复读)。 */
  private indexFile(uri: vscode.Uri): Promise<{ accesses: KbeDataDictAccess[] } | null> {
    if (this.disposed) {
      return Promise.resolve(null);
    }
    const fsPath = uri.fsPath;
    // AUD-070:在飞读盘期间又来变更——不吞,等先前读结束后核对 revision,
    // 有更新版本(升过)则由本读追赶重读最新;无更新版本则直接沿用先前结果。
    const prior = this.building.get(fsPath) ?? null;
    const revision = this.revisions.get(fsPath) ?? 0;
    // AUD-071:根集变化(removeRoot/invalidate)升 generation,旧读作废不发布旧根
    const generation = this.generation;
    const holder: { task: Promise<{ accesses: KbeDataDictAccess[] } | null> } = {
      task: Promise.resolve(null)
    };
    holder.task = (async (): Promise<{ accesses: KbeDataDictAccess[] } | null> => {
      try {
        if (prior) {
          await prior.catch(() => undefined);
          if (this.disposed || (this.revisions.get(fsPath) ?? 0) !== revision) {
            return this.cache.get(fsPath) ?? null;
          }
        }
        const bytes = await vscode.workspace.fs.readFile(uri);
        if (this.disposed) {
          return null;
        }
        if ((this.revisions.get(fsPath) ?? 0) !== revision || this.generation !== generation) {
          return this.cache.get(fsPath) ?? null;
        }
        const dirty = vscode.workspace.textDocuments.find(
          document => document.uri.fsPath === fsPath && document.isDirty
        );
        if (dirty) {
          this.noteSaved(dirty);
          return this.cache.get(fsPath) ?? null;
        }
        const text = Buffer.from(bytes).toString('utf8');
        // 冷扫让出宿主:正则扫描轻,逐文件一个宏任务节拍即可
        await new Promise<void>(resolve => setImmediate(resolve));
        if (
          this.disposed ||
          (this.revisions.get(fsPath) ?? 0) !== revision ||
          this.generation !== generation
        ) {
          return this.cache.get(fsPath) ?? null;
        }
        this.commitFile(fsPath, text);
        return this.cache.get(fsPath) ?? null;
      } catch {
        if ((this.revisions.get(fsPath) ?? 0) === revision) {
          const entry = this.cache.get(fsPath);
          this.replaceFileSites(fsPath, entry?.accesses ?? [], []);
          this.cache.delete(fsPath);
        }
        return null;
      } finally {
        // 只清自己占位的项(后到变更会覆盖 slot,不得误删其追读)
        if (this.building.get(fsPath) === holder.task) {
          this.building.delete(fsPath);
        }
      }
    })();
    this.building.set(fsPath, holder.task);
    return holder.task;
  }

  /** 重扫文件文本并同步倒排(byKey)+ 函数定义表 + 调用键依赖刷新 */
  private commitFile(fsPath: string, text: string): void {
    // 先落函数定义表(解析器据此现解;同文件调用链也可见),差异函数记下
    const changedFns = this.updateFnDefs(fsPath, text);
    const aliases = getKbeAliases(text);
    const newCallFns = new Set<string>();
    const accesses =
      aliases.size > 0
        ? findKbeDataDictAccesses(
            text,
            aliases,
            this.buildCallKeyResolver(),
            fn => {
              newCallFns.add(fn);
            }
          )
        : [];
    const previous = this.cache.get(fsPath);
    this.updateCallKeyDependents(fsPath, previous?.callFns ?? new Set<string>(), newCallFns);
    this.cache.set(fsPath, { accesses, callFns: newCallFns });
    this.replaceFileSites(fsPath, previous?.accesses ?? [], accesses);
    this.reindexCallKeyDependents(changedFns, fsPath);
  }

  /** 函数调用键的现解解析器(跨文件;闭包现读 fnDefsByFile,不缓存) */
  private buildCallKeyResolver(): (fn: string) => string[] | null {
    return (fn: string) => resolveFunctionReturns(fn, this.fnDefsByFile, 0, new Set());
  }

  /** 更新文件函数定义表,返回与旧表差异的函数名集(新增/删除/return 变) */
  private updateFnDefs(fsPath: string, text: string): string[] {
    const fnDefs = extractFunctionReturns(text);
    const prev = this.fnDefsByFile.get(fsPath);
    const changed = diffFunctionDefs(prev, fnDefs);
    this.fnDefsByFile.set(fsPath, fnDefs);
    return changed;
  }

  /** 调用键依赖表:文件不再引用某 fn → 移除;新引用 → 加入 */
  private updateCallKeyDependents(
    fsPath: string,
    previousCallFns: ReadonlySet<string>,
    newCallFns: ReadonlySet<string>
  ): void {
    for (const fn of previousCallFns) {
      if (newCallFns.has(fn)) {
        continue;
      }
      const deps = this.callKeyDependents.get(fn);
      deps?.delete(fsPath);
      if (deps && deps.size === 0) {
        this.callKeyDependents.delete(fn);
      }
    }
    for (const fn of newCallFns) {
      const deps = this.callKeyDependents.get(fn) ?? new Set<string>();
      deps.add(fsPath);
      this.callKeyDependents.set(fn, deps);
    }
  }

  /** 函数定义变化 → 重扫引用该函数调用键的其它文件(签名已变/变可解) */
  private reindexCallKeyDependents(
    changedFns: ReadonlySet<string> | readonly string[],
    exceptFile: string
  ): void {
    if (this.disposed) {
      return;
    }
    for (const fn of changedFns) {
      for (const dep of this.callKeyDependents.get(fn) ?? []) {
        if (dep === exceptFile) {
          continue;
        }
        this.revisions.set(dep, (this.revisions.get(dep) ?? 0) + 1);
        const task = this.indexFile(vscode.Uri.file(dep));
        this.pendingDependentIndexes.add(task);
        void task.finally(() => this.pendingDependentIndexes.delete(task));
      }
    }
  }

  /** 冷启动/重建时等待所有在飞调用键依赖重扫收敛(防查询时索引未定) */
  private async drainPendingDependents(): Promise<void> {
    while (!this.disposed && this.pendingDependentIndexes.size > 0) {
      await Promise.all([...this.pendingDependentIndexes]);
    }
  }

  /**
   * 函数调用键的现解签名(跨文件,现算不缓存);Fn 不在工作区/无静态可求
   * return/递归自指/深度超限 → null(不硬猜)。查询面与索引面共用。
   */
  resolveCallSignatures(fn: string): string[] | null {
    return resolveFunctionReturns(fn, this.fnDefsByFile, 0, new Set());
  }

  /**
   * 保存时由编辑器路径直接刷新(免读盘);脏标记随之维护。
   * AUD-076(R4-F11):超过预算的文档改走异步预算化重扫(合并连续编辑/
   * 取消旧代/切片限阻塞),预算内的小文件保持同步即时刷新。
   */
  noteSaved(document: vscode.TextDocument): void {
    if (this.disposed) {
      return;
    }
    if (!document.uri.fsPath.endsWith('.py')) {
      return;
    }
    if (document.isDirty) {
      this.dirtyDocs.add(document.uri.fsPath);
    } else {
      this.dirtyDocs.delete(document.uri.fsPath);
    }
    this.revisions.set(document.uri.fsPath, (this.revisions.get(document.uri.fsPath) ?? 0) + 1);
    const text = document.getText();
    if (text.length > EDIT_ASYNC_THRESHOLD_BYTES) {
      this.editBuffers.set(document.uri.fsPath, text);
      this.scheduleEditRecompute(document.uri.fsPath);
      return;
    }
    this.commitFile(document.uri.fsPath, text);
  }

  /**
   * AUD-076:调度大文件异步重扫。合并窗 = 同文件在飞时只更新缓冲+revision,
   * 由在飞循环复核后重扫(取消旧代);无在飞则启动一个(逐代最新者胜)。
   */
  private scheduleEditRecompute(fsPath: string): void {
    if (this.disposed) {
      return;
    }
    if (this.editInProgress.has(fsPath)) {
      return;
    }
    this.editInProgress.add(fsPath);
    void this.runEditRecompute(fsPath);
  }

  /**
   * AUD-076:预算化编辑重扫循环。每次迭代捕获 revision/generation 与最新
   * 缓冲,切片扫描(片间让路+复核取消);扫描被取消(旧代)则循环重扫;
   * 扫描完成后一次性复核,最新者才进倒排提交(提交自身不可中途取消)。
   * 提交期间又来新编辑 → 提交完成(书账不可中断)后循环重扫,最终收敛最新。
   */
  private async runEditRecompute(fsPath: string): Promise<void> {
    try {
      // 扫描被取消(又来新编辑)时定义表已前进但依赖未重扫;函数差异跨迭代
      // 累积,提交成功后统一重扫一次,避免取消轮次丢失依赖刷新
      const pendingReindex = new Set<string>();
      while (!this.disposed) {
        const text = this.editBuffers.get(fsPath);
        if (text === undefined) {
          return;
        }
        const revision = this.revisions.get(fsPath) ?? 0;
        const generation = this.generation;
        const isCancelled = (): boolean =>
          this.disposed ||
          (this.revisions.get(fsPath) ?? 0) !== revision ||
          this.generation !== generation;
        // 先落函数定义表(解析器据此现解;同文件调用链也可见),差异记入
        // pendingReindex——取消轮次不丢,提交成功后统一重扫引用方
        const changedFns = this.updateFnDefs(fsPath, text);
        for (const fn of changedFns) {
          pendingReindex.add(fn);
        }
        const aliases = getKbeAliases(text);
        const newCallFns = new Set<string>();
        const scanned = await findKbeDataDictAccessesSliced(
          text,
          aliases,
          isCancelled,
          EDIT_SCAN_LINE_SLICE,
          this.buildCallKeyResolver(),
          fn => {
            newCallFns.add(fn);
          }
        );
        if (scanned.accesses === null) {
          this.lastEditStats.scansCancelled += 1;
          this.lastEditStats.maxSliceMs = Math.max(this.lastEditStats.maxSliceMs, scanned.maxSliceMs);
          continue;
        }
        if (isCancelled()) {
          this.lastEditStats.scansCancelled += 1;
          this.lastEditStats.maxSliceMs = Math.max(this.lastEditStats.maxSliceMs, scanned.maxSliceMs);
          continue;
        }
        this.lastEditStats.maxSliceMs = Math.max(this.lastEditStats.maxSliceMs, scanned.maxSliceMs);
        this.lastEditStats.sliceCount = Math.max(this.lastEditStats.sliceCount, scanned.sliceCount);
        const previous = this.cache.get(fsPath);
        this.updateCallKeyDependents(
          fsPath,
          previous?.callFns ?? new Set<string>(),
          newCallFns
        );
        this.cache.set(fsPath, { accesses: scanned.accesses, callFns: newCallFns });
        const committed = await replaceFileSitesSliced(
          this.byKey,
          fsPath,
          previous?.accesses ?? [],
          scanned.accesses
        );
        this.lastEditStats.maxSliceMs = Math.max(this.lastEditStats.maxSliceMs, committed.maxSliceMs);
        this.lastEditStats.commits += 1;
        this.reindexCallKeyDependents(pendingReindex, fsPath);
        pendingReindex.clear();
        // 提交期间又来新编辑(revision/代际前进)→ 循环重扫,否则本轮完成
        if ((this.revisions.get(fsPath) ?? 0) === revision && this.generation === generation) {
          return;
        }
      }
    } finally {
      this.editInProgress.delete(fsPath);
    }
  }

  /** (作用域根, 字典, 键签名) 的全部写+读点(走内存索引,不重扫)。 */
  query(dict: string, keySignature: string, root = ''): KbeDataDictSite[] {
    return this.byKey.get(siteKey(root, dict, keySignature)) ?? [];
  }

  /**
   * AUD-071:整根移除(workspace 根或外部 assetsRoot)。立即撤回该根下各文件
   * 贡献(按该根身份键),并升 generation 使在飞旧读不得重新发布旧根;文件仍属
   * 其他根(嵌套根)或外部根则重建,否则保持撤回。
   */
  removeRoot(rootPath: string): void {
    if (this.disposed) {
      return;
    }
    this.generation += 1;
    const base = rootPath.endsWith(path.sep) ? rootPath : `${rootPath}${path.sep}`;
    for (const [fsPath, entry] of [...this.cache]) {
      if (fsPath !== rootPath && !fsPath.startsWith(base)) {
        continue;
      }
      // 撤回该文件在 rootPath 身份下的贡献(嵌套根文件本就不挂 rootPath 键,无项可撤)
      for (const access of entry.accesses) {
        if (access.keySignature === null) {
          continue;
        }
        const key = siteKey(rootPath, access.dict, access.keySignature);
        const sites = this.byKey.get(key);
        if (sites) {
          const kept = sites.filter(site => site.file !== fsPath);
          if (kept.length === 0) {
            this.byKey.delete(key);
          } else {
            this.byKey.set(key, kept);
          }
        }
      }
      // 撤回调用键依赖与函数定义表贡献
      this.fnDefsByFile.delete(fsPath);
      for (const fn of entry.callFns) {
        const deps = this.callKeyDependents.get(fn);
        deps?.delete(fsPath);
        if (deps && deps.size === 0) {
          this.callKeyDependents.delete(fn);
        }
      }
      this.cache.delete(fsPath);
      // 仍属其他根 → 立即重建;脏文档 → 缓冲优先;无根 → 保持撤回
      const dirty = vscode.workspace.textDocuments.find(
        document => document.uri.fsPath === fsPath && document.isDirty
      );
      if (dirty) {
        this.noteSaved(dirty);
      } else if (resolveScopeRoot(fsPath)) {
        void this.indexFile(vscode.Uri.file(fsPath));
      }
    }
  }

  /**
   * AUD-071:根集添加/资产根切换——整库失效后重建,新根下文件按新根身份入键;
   * 旧任务(若在飞)经 generation 作废,不发布旧根。
   */
  invalidate(): void {
    if (this.disposed) {
      return;
    }
    this.generation += 1;
    this.byKey.clear();
    this.cache.clear();
    this.fnDefsByFile.clear();
    this.callKeyDependents.clear();
    void this.rebuild();
  }

  /** 按当前根集重扫全部(重建覆盖;根再变则放弃,由新 invalidate 接手)。 */
  private async rebuild(): Promise<void> {
    const generation = this.generation;
    if (this.disposed) {
      return;
    }
    const files = await findFilesAcrossRoots(this.pyGlob, PY_SCAN_EXCLUDE);
    if (this.disposed || this.generation !== generation) {
      return;
    }
    await Promise.all(files.map(uri => this.indexFile(uri)));
    await this.drainPendingDependents();
  }

  /** 文件重扫后替换其贡献的倒排项(先撤旧再进新)。 */
  private replaceFileSites(
    fsPath: string,
    previous: KbeDataDictAccess[],
    next: KbeDataDictAccess[]
  ): void {
    const root = resolveScopeRoot(fsPath);
    for (const access of previous) {
      if (access.keySignature === null) {
        continue;
      }
      const key = siteKey(root, access.dict, access.keySignature);
      const sites = this.byKey.get(key);
      if (!sites) {
        continue;
      }
      const kept = sites.filter(site => site.file !== fsPath);
      if (kept.length === 0) {
        this.byKey.delete(key);
      } else {
        this.byKey.set(key, kept);
      }
    }
    for (const access of next) {
      if (access.keySignature === null) {
        continue;
      }
      const key = siteKey(root, access.dict, access.keySignature);
      const sites = this.byKey.get(key) ?? [];
      sites.push({ ...access, file: fsPath });
      this.byKey.set(key, sites);
    }
  }
}

/**
 * 查询面统一路由:普通键 → 单键查询;函数调用键(callFn)→ 现解全部签名
 * 并对每签名查询取并集(一访问点对应多签名);未解出 → 空数组(保持现状
 * null 口径,不硬猜)。definition/references/hover/inlay 同源。
 */
export function queryDataDictSitesForAccess(
  index: GlobalDataDictIndex,
  access: KbeDataDictAccess,
  root = ''
): KbeDataDictSite[] {
  if (!access.callFn) {
    if (access.keySignature === null) {
      return [];
    }
    return index.query(access.dict, access.keySignature, root);
  }
  const sigs = index.resolveCallSignatures(access.callFn);
  if (sigs === null) {
    return [];
  }
  const seen = new Set<string>();
  const sites: KbeDataDictSite[] = [];
  for (const sig of sigs) {
    for (const site of index.query(access.dict, sig, root)) {
      const id = `${site.file}\u0000${site.dict}\u0000${site.keySignature ?? ''}\u0000${site.line}\u0000${site.keyStart}`;
      if (seen.has(id)) {
        continue;
      }
      seen.add(id);
      sites.push(site);
    }
  }
  return sites;
}
