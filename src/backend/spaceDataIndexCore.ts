/**
 * KSEM-DATA-06(SEM-047)空间数据读写关联 — 纯核(零 vscode 依赖)。
 *
 * 引擎真源(kbengine fork,kbe/src/server/cellapp/spacememory.cpp):
 *  - `KBEngine.setSpaceData(spaceID, key, value)` / `getSpaceData(spaceID, key)`
 *    / `delSpaceData(spaceID, key)` 仅 cellapp 注册(cellapp.cpp:183-185),
 *    逐空间存储,spaceID 运行期不存在即 AssertionError;
 *  - key/value 只收字符串(PyArg "Iss"/"Is"),空 key 拒;
 *  - `_mapping` 保护:set 与 del 大小写不敏感拒(:740-742/:862-864),
 *    get 放行(即几何映射路径,引擎自写 :543-554)——保护键写入诊断的事实
 *    依据,非发明契约。
 *
 * 面边界(诚实):key 只收字符串字面量内部原文(不解转义——"a\nb" 与
 * "a\\nb" 视为不同键,罕见形态如实不归一);spaceID 只收 int 字面量或本
 * 文件模块级 int 常量绑定(冲突→动态);调用必须同行闭合且元数精确
 * (set=3/get=2/del=2,引擎 argssize 断言同口径);跨行调用不入索引。
 * 动态 spaceID 的调用一律不入族(动态空间不合并为同一确定对象)。
 */
import { buildPythonCodeMask, type KbeDataDictName } from './globalDataIndexCore';

export type KbeSpaceDataFn = 'setSpaceData' | 'getSpaceData' | 'delSpaceData';

export const SPACE_DATA_FNS: readonly KbeSpaceDataFn[] = [
  'setSpaceData',
  'getSpaceData',
  'delSpaceData'
];

/** 引擎元数断言口径(spacememory.cpp:703/760/816 argssize 检查) */
const SPACE_DATA_ARITY: Record<KbeSpaceDataFn, number> = {
  setSpaceData: 3,
  getSpaceData: 2,
  delSpaceData: 2
};

export interface KbeSpaceDataCall {
  fn: KbeSpaceDataFn;
  line: number;
  /** key 实参签名(引号内原文;非字面量键→null 不入索引) */
  keySignature: string | null;
  /** key 内容区间(行内 0 基列,不含引号) */
  keyStart: number;
  keyEnd: number;
  /** spaceID 签名(int 字面量/int 常量绑定值);动态→null,不入族 */
  spaceIdSignature: string | null;
  /** alias 起始列(词法掩码面) */
  callStart: number;
}

export interface SpaceDataProtectedKeyFinding {
  fn: 'setSpaceData' | 'delSpaceData';
  line: number;
  /** 引号内原文(保留原大小写,报文引用用) */
  keyText: string;
  keyStart: number;
  keyEnd: number;
}

/** 行内字符是否 Python 引号串定界符 */
function isQuote(ch: string): boolean {
  return ch === '"' || ch === "'";
}

/** 从 from 起跳过空白,返回首个非空白下标 */
function skipWhitespace(lineText: string, from: number): number {
  let index = from;
  while (index < lineText.length && (lineText[index] === ' ' || lineText[index] === '\t')) {
    index += 1;
  }
  return index;
}

/** 掩码区间是否全为代码(与 data dict 扫描同判据) */
function spanIsCode(mask: Uint8Array, start: number, length: number): boolean {
  for (let index = start; index < start + length; index += 1) {
    if (mask[index] !== 0) {
      return false;
    }
  }
  return true;
}

interface ArgSpan {
  raw: string;
  start: number;
  end: number;
}

/**
 * 括号内顶层实参切分(深度+引号感知;`{...}`/`f(x)` 内逗号不劈)。
 * openParen 指向 `(`;返回 null=同行未闭合(跨行调用不判,边界如实)。
 */
function splitCallArgs(
  lineText: string,
  openParen: number
): ArgSpan[] | null {
  let depth = 0;
  let inString: string | null = null;
  for (let index = openParen + 1; index < lineText.length; index += 1) {
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
    if (isQuote(ch)) {
      inString = ch;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') {
      depth += 1;
      continue;
    }
    if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0 && ch === ')') {
        return sliceArgs(lineText, openParen + 1, index);
      }
      depth -= 1;
      continue;
    }
    if (ch === '#') {
      return null; // 行内注释(含括号内):参数扫描不可靠,不判
    }
  }
  return null; // 未闭合
}

function sliceArgs(lineText: string, from: number, to: number): ArgSpan[] {
  const args: ArgSpan[] = [];
  let depth = 0;
  let inString: string | null = null;
  let argStart = from;
  for (let index = from; index < to; index += 1) {
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
    if (isQuote(ch)) {
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
      args.push({ raw: lineText.slice(argStart, index), start: argStart, end: index });
      argStart = index + 1;
    }
  }
  args.push({ raw: lineText.slice(argStart, to), start: argStart, end: to });
  return args;
}

function trimSpan(lineText: string, span: ArgSpan): ArgSpan {
  let start = span.start;
  let end = span.end;
  while (start < end && (lineText[start] === ' ' || lineText[start] === '\t')) {
    start += 1;
  }
  while (end > start && (lineText[end - 1] === ' ' || lineText[end - 1] === '\t')) {
    end -= 1;
  }
  return { raw: lineText.slice(start, end), start, end };
}

/**
 * 引号字符串字面量内部原文(单双引号;含引号定界检测,不含转义解义)。
 * 返回 null=非(简单)字面量;inner 起止为内容列(不含引号)。
 */
function matchQuotedLiteral(
  span: ArgSpan
): { text: string; start: number; end: number } | null {
  const { raw, start } = span;
  if (raw.length < 2) {
    return null;
  }
  const quote = raw[0];
  // 首尾须为同引号——前缀限定形态(r"…"/f'…')首字符非引号,已在此拒绝
  if (!isQuote(quote) || raw[raw.length - 1] !== quote) {
    return null;
  }
  // 内嵌同引号未转义闭合('a' + 'b' 被当整体裁进来)=非简单字面量
  const inner = raw.slice(1, -1);
  if (inner.includes(quote) && !new RegExp(`\\\\${quote}`).test(inner)) {
    return null;
  }
  return { text: inner, start: start + 1, end: start + raw.length - 1 };
}

const INT_LITERAL_PATTERN = /^-?\d+$/;
const IDENTIFIER_PATTERN = /^([A-Za-z_]\w*)$/;

/**
 * 模块级 int 常量绑定(spaceData 专用;data dict 的字符串绑定不混用):
 * 顶格 `NAME = <int 字面量>` 注解形态同收;同名全等→值,冲突→null
 * (动态),非 int RHS/缩进赋值→不入表。
 */
export function extractModuleIntConstantBindings(text: string): Map<string, number | null> {
  const values = new Map<string, number[]>();
  for (const lineText of text.split(/\r?\n/)) {
    const match = /^([A-Za-z_]\w*)\s*(?::[^=]*)?=\s*(\S.*)$/.exec(lineText);
    if (!match) {
      continue;
    }
    const rhs = match[2].replace(/\s+#.*$/, '').trim();
    if (!INT_LITERAL_PATTERN.test(rhs)) {
      continue;
    }
    const list = values.get(match[1]) ?? [];
    list.push(Number(rhs));
    values.set(match[1], list);
  }
  const resolved = new Map<string, number | null>();
  for (const [name, list] of values) {
    resolved.set(name, list.every(value => value === list[0]) ? list[0] : null);
  }
  return resolved;
}

/** spaceID 实参签名:int 字面量原样;裸标识符按 int 绑定解析;其余→null(动态) */
function resolveSpaceIdSignature(
  lineText: string,
  span: ArgSpan,
  intBindings?: ReadonlyMap<string, number | null>
): string | null {
  const raw = span.raw;
  if (INT_LITERAL_PATTERN.test(raw)) {
    return raw;
  }
  if (intBindings && IDENTIFIER_PATTERN.test(raw)) {
    const bound = intBindings.get(raw);
    return bound === undefined ? null : bound === null ? null : String(bound);
  }
  return null;
}

/**
 * 逐行扫描 spaceData 调用(词法掩码剔注释/字符串伪调用;别名同 data dict
 * 守卫——`x.KBEngine.` 属性链不收)。元数精确才收(引擎 argssize 断言同
 * 口径);key 非字面量→记录但 keySignature null(不入族);spaceID 动态→
 * spaceIdSignature null(不入族)。
 */
export function findKbeSpaceDataCalls(
  text: string,
  aliases: ReadonlySet<string>,
  intBindings?: ReadonlyMap<string, number | null>
): KbeSpaceDataCall[] {
  if (aliases.size === 0) {
    return [];
  }
  const mask = buildPythonCodeMask(text);
  const lineStarts: number[] = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\n') {
      lineStarts.push(index + 1);
    }
  }
  const pattern =
    /([A-Za-z_]\w*)\.(setSpaceData|getSpaceData|delSpaceData)[ \t]*\(/g;
  const calls: KbeSpaceDataCall[] = [];
  const lines = text.split(/\r?\n/);
  for (let line = 0; line < lines.length; line += 1) {
    const lineText = lines[line];
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(lineText)) !== null) {
      const [full, alias, fnName] = match;
      if (!aliases.has(alias) || !SPACE_DATA_FNS.includes(fnName as KbeSpaceDataFn)) {
        continue;
      }
      if (match.index > 0 && lineText[match.index - 1] === '.') {
        continue; // x.KBEngine.setSpaceData 属性链非模块访问
      }
      if (!spanIsCode(mask, lineStarts[line] + match.index, full.length)) {
        continue; // 注释/字符串里的伪调用
      }
      const fn = fnName as KbeSpaceDataFn;
      const openParen = match.index + full.length - 1;
      const args = splitCallArgs(lineText, openParen);
      if (args === null || args.length !== SPACE_DATA_ARITY[fn]) {
        continue; // 跨行/元数不符:不入索引(诚实边界)
      }
      const spaceIdSpan = trimSpan(lineText, args[0]);
      const keySpan = trimSpan(lineText, args[1]);
      const keyLiteral = matchQuotedLiteral(keySpan);
      calls.push({
        fn,
        line,
        keySignature: keyLiteral ? keyLiteral.text : null,
        keyStart: keyLiteral ? keyLiteral.start : keySpan.start,
        keyEnd: keyLiteral ? keyLiteral.end : keySpan.end,
        spaceIdSignature: resolveSpaceIdSignature(lineText, spaceIdSpan, intBindings),
        callStart: match.index
      });
    }
  }
  return calls;
}

/**
 * 保护键写入发现(KSEM-DATA-06 诊断事实源):set/del 的 key 实参为
 * `_mapping`(大小写不敏感,kbe_stricmp 同口径)→ 引擎 AssertionError。
 * get 放行(引擎允许读 _mapping);动态 spaceID 的 set/del 同样在
 * spaceID 存在时被拒——键保护与空间可解性正交,一律报。
 */
export function findSpaceDataProtectedKeyFindings(
  text: string,
  aliases: ReadonlySet<string>
): SpaceDataProtectedKeyFinding[] {
  const findings: SpaceDataProtectedKeyFinding[] = [];
  for (const call of findKbeSpaceDataCalls(text, aliases)) {
    if (call.fn === 'getSpaceData' || call.keySignature === null) {
      continue;
    }
    if (call.keySignature.toLowerCase() !== '_mapping') {
      continue;
    }
    findings.push({
      fn: call.fn as 'setSpaceData' | 'delSpaceData',
      line: call.line,
      keyText: call.keySignature,
      keyStart: call.keyStart,
      keyEnd: call.keyEnd
    });
  }
  return findings;
}

/** 键位补全上下文(spaceData 键位):`alias.fn(<可解 sid>, "片段` 等 */
export interface SpaceDataKeyCompletionContext {
  fn: KbeSpaceDataFn;
  /** 已解析 spaceID 签名;动态→null(不给补全,动态空间不造键) */
  spaceIdSignature: string | null;
  /** 引号内已输入片段 */
  partial: string;
  /** 片段首列(替换范围起,不含引号;未开引号=光标位) */
  replaceStart: number;
}

/**
 * 键位上下文识别:光标在 `alias.setSpaceData(<sid>, "` / `getSpaceData(`
 * / `delSpaceData(` 的第二实参(引号内片段/刚过首逗号)。sid 必须可解
 * (int 字面量/int 常量绑定);动态 sid → 上下文仍返回但签名 null,调用方
 * 不给项(与「动态不合并」一致)。第一实参未闭合/调用名不符→null。
 */
export function spaceDataKeyCompletionContext(
  lineText: string,
  character: number,
  aliases: ReadonlySet<string>,
  intBindings?: ReadonlyMap<string, number | null>
): SpaceDataKeyCompletionContext | null {
  if (aliases.size === 0) {
    return null;
  }
  const before = lineText.slice(0, character);
  const pattern =
    /([A-Za-z_]\w*)\.(setSpaceData|getSpaceData|delSpaceData)[ \t]*\(/g;
  pattern.lastIndex = 0;
  let match: RegExpExecArray | null;
  let hit: { fn: KbeSpaceDataFn; openParen: number } | null = null;
  while ((match = pattern.exec(before)) !== null) {
    const [, alias, fnName] = match;
    if (!aliases.has(alias) || !SPACE_DATA_FNS.includes(fnName as KbeSpaceDataFn)) {
      continue;
    }
    if (match.index > 0 && before[match.index - 1] === '.') {
      continue;
    }
    hit = { fn: fnName as KbeSpaceDataFn, openParen: match.index + match[0].length - 1 };
  }
  if (!hit) {
    return null;
  }
  // 第一实参:openParen 后到光标前的顶层首逗号
  let depth = 0;
  let inString: string | null = null;
  let firstComma = -1;
  for (let index = hit.openParen + 1; index < before.length; index += 1) {
    const ch = before[index];
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
    if (isQuote(ch)) {
      inString = ch;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') {
      depth += 1;
      continue;
    }
    if (ch === ')' || ch === ']' || ch === '}') {
      return null; // 调用已闭合,不在键位
    }
    if (depth === 0 && ch === ',') {
      firstComma = index;
      break;
    }
  }
  if (firstComma < 0) {
    return null; // 首实参未完(spaceID 位,不是键位)
  }
  const spaceIdSpan = trimSpan(lineText, {
    raw: before.slice(hit.openParen + 1, firstComma),
    start: hit.openParen + 1,
    end: firstComma
  });
  const spaceIdSignature = resolveSpaceIdSignature(lineText, spaceIdSpan, intBindings);
  // 光标后(firstComma 之后)到行尾:找第二实参的引号片段
  const afterComma = skipWhitespace(lineText, firstComma + 1);
  // 未开引号(光标刚过逗号):空片段,插入位=光标
  const rest = lineText.slice(afterComma, character);
  const trimmedRest = rest.trim();
  if (trimmedRest.length === 0 || !isQuote(trimmedRest[0])) {
    return { fn: hit.fn, spaceIdSignature, partial: '', replaceStart: character };
  }
  // 开了引号:片段=引号后到光标(不得含未转义同引号——闭合后不在键位)
  const quote = trimmedRest[0];
  const quotePos = afterComma + (rest.length - rest.trimStart().length);
  const partialStart = quotePos + 1;
  const partial = lineText.slice(partialStart, character);
  if (partial.includes(quote)) {
    return null; // 键串已闭合
  }
  return {
    fn: hit.fn,
    spaceIdSignature,
    partial,
    replaceStart: partialStart
  };
}

/** 倒排键(spaceID+key 全等归族;键区分大小写——引擎按精确串存取) */
export function spaceDataFamilyKey(spaceIdSignature: string, keySignature: string): string {
  return `${spaceIdSignature}\u001f${keySignature}`;
}

/**
 * 光标键位探测(definition/references 面):落点在同行 spaceData 调用的
 * key 字面量内(含两枚引号列)。命中返回该调用(spaceIdSignature/keySignature
 * 可为 null——动态/非字面量调用不建族,调用方裁定);无命中 null。
 */
export function findKbeSpaceDataCallAtPosition(
  text: string,
  line: number,
  character: number,
  aliases: ReadonlySet<string>,
  intBindings?: ReadonlyMap<string, number | null>
): KbeSpaceDataCall | null {
  const lines = text.split(/\r?\n/);
  if (line < 0 || line >= lines.length) {
    return null;
  }
  const lineText = lines[line];
  if (character < 0 || character > lineText.length) {
    return null;
  }
  for (const call of findKbeSpaceDataCalls(text, aliases, intBindings)) {
    if (call.line !== line) {
      continue;
    }
    // keyStart-1 = 开引号列,keyEnd = 内容末列 +1 = 闭引号列
    if (character >= call.keyStart - 1 && character <= call.keyEnd + 1) {
      return call;
    }
  }
  return null;
}

/** 类型再输出:调用方(索引/诊断装配)引用 dict 名面时不重复定义 */
export type { KbeDataDictName };
