import { parsePythonFile, type ParsedPythonFile } from './backend/pythonParser';

/**
 * LANG-NAR-1 语义引擎流敏感窄化(用户令 2026-11-02):
 * `self.<attr>` 用户自管属性(非 .def 声明、非内建 receiver)的流敏感类型推导。
 *
 * 背景:GEN-DEF-1a/1b 已把 .def 声明属性的注解定为非 Optional(FixedArray[T]/
 * FixedDict/内建直译),但用户在 __init__ 里自管的属性(如 self.TalentTree 先
 * `= None` 再 `= [...]`)在语义引擎里完全不可见——hover/inlay 全落 null
 * (propertyCodeLens/typeInlayHints 的 resolvePropertyDefinitionInfo 只走 .def)。
 * 本模块补齐:对自管属性做 (a) 类型收敛(__init__ 赋值 ∪ 类级声明,声明∪赋值),
 * (b) 流敏感窄化(`if self.X is None: self.X = expr` 后收窄为 expr 类型;
 * `if self.X is not None:` 块内去 None;早退 `if self.X is None: return` 后去
 * None)。纯函数面(文本 + 可选回调),零 vscode 依赖,供诊断/悬停消费。
 *
 * 收敛口径:基类 = __init__ 体流扫描末态(尾部赋值覆盖,`= None` 后被 `= []`
 * 覆盖即收敛为 list,故「__init__ 初始化后无警告」成立)∪ 类级声明;无 __init__
 * 时 = 类级声明(含 `X = None` → None)。流扫描在查询方法内自基类起步,按
 * 赋值/守卫逐点推进,返回查询位的收窄类型。
 *
 * 诚实边界:类型以原子注解字符串集合表示(如 'None' / 'list' / 'list[int]' /
 * 'TalentNode');表达式类型推不出即空集(不硬造 Any)——空集在收窄并集里
 * 等价于「未知,不新增 None」,诊断侧按「有 None 证据才报」保守闸,不误报。
 */

/**
 * KODE-PERF-001:按文档版本键的解析缓存(有界 LRU)。同文档版本(键=
 * `${uri}|${version}`)的多次流查询——诊断/inlay 同版本共享——只解析一次
 * AST;版本递增或换文档自然换键,旧键靠有界淘汰回收;无键调用(纯函数/
 * 测试)不读写缓存,行为与既有纯函数逐字节一致。
 */
const PARSE_CACHE_MAX_ENTRIES = 8;
const flowParseCache = new Map<string, ParsedPythonFile>();
let flowParseCountForTests = 0;

/** 清缓存并归零解析计数(测试注入口;生产不用) */
export function resetSelfAttributeFlowParseCacheForTests(): void {
  flowParseCache.clear();
  flowParseCountForTests = 0;
}

/** 实际解析次数(缓存命中不计;测试断言「访问点增多不重复解析」用) */
export function selfAttributeFlowParseCountForTests(): number {
  return flowParseCountForTests;
}

/** 按版本键取/建解析结果;无键=每次现解析(纯函数回退) */
function parseWithVersionCache(
  lines: readonly string[],
  versionKey: string | undefined
): ParsedPythonFile {
  if (versionKey !== undefined) {
    const cached = flowParseCache.get(versionKey);
    if (cached) {
      // LRU 触碰:移到尾(最近使用)
      flowParseCache.delete(versionKey);
      flowParseCache.set(versionKey, cached);
      return cached;
    }
  }
  flowParseCountForTests += 1;
  const parsed = parsePythonFile(lines.join('\n'), '<flow>');
  if (versionKey !== undefined) {
    flowParseCache.set(versionKey, parsed);
    if (flowParseCache.size > PARSE_CACHE_MAX_ENTRIES) {
      const oldest = flowParseCache.keys().next().value;
      if (oldest !== undefined) {
        flowParseCache.delete(oldest);
      }
    }
  }
  return parsed;
}

/** 查询位自管属性的流敏感类型事实 */
export interface SelfAttributeFlow {
  /** 去重排序的原子类型名(如 ['None','list']);空 = 无法确定 */
  types: string[];
  /** 格式化注解串('list | None'/'None'/'list')或 null(types 空) */
  annotation: string | null;
  /** 流类型含 None */
  hasNone: boolean;
  /** 窄化生效:收敛基类含 None 而查询位流类型不含(守卫/赋值已去 None) */
  narrowed: boolean;
}

/** 表达式类型解析回调(调用方注入,如 pythonReturnTypeInference 的索引) */
export interface SelfAttributeFlowOptions {
  /** 函数调用返回注解:`make_tree()` → 'list' 等;未注入/未解出 → null */
  resolveCallAnnotation?: (callee: string) => string | null;
  /** 裸名/属性末段注解(非调用形态):`TalentNode` → 'TalentNode' 等 */
  resolveNameAnnotation?: (name: string) => string | null;
}

interface ClassSpan {
  name: string;
  startLine: number;
  endLine: number;
  /** 方法名 → 起始行(0 起) */
  methods: Map<string, { line: number; character: number }>;
}

interface MethodSpan {
  startLine: number;
  endLine: number;
  /** 方法体基础缩进(首个非空体行缩进;无体行则方法行缩进+1) */
  baseIndent: number;
}

/** 类型集合运算:并集(原子去重) */
function unionTypes(...sets: ReadonlyArray<ReadonlySet<string>>): Set<string> {
  const out = new Set<string>();
  for (const set of sets) {
    for (const item of set) {
      out.add(item);
    }
  }
  return out;
}

/** 去 None */
function withoutNone(types: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  for (const item of types) {
    if (item !== 'None') {
      out.add(item);
    }
  }
  return out;
}

/** 排序 + ` | ` 联接(测试确定性;'None' 字典序在前) */
function formatTypes(types: ReadonlySet<string>): string | null {
  if (types.size === 0) {
    return null;
  }
  return [...types].sort().join(' | ');
}

const indentOf = (line: string): number => {
  const match = /^[ \t]*/.exec(line);
  return match ? match[0].replace(/\t/g, '    ').length : 0;
};

const COMMENT_ONLY = /^\s*(#.*)?$/;
const BLANK = /^\s*$/;

/** `self.<attr> = <expr>`(attr 精确匹配;赋值形态非 `==`) */
const selfAssignment = (attr: string): RegExp =>
  new RegExp(`^\\s*self\\.${escapeRegExp(attr)}\\s*=\\s*(?!=)(.+)$`);

/** `if self.<attr> is None:`(正向判 None 守卫) */
const noneGuard = (attr: string): RegExp =>
  new RegExp(`^\\s*if\\s+self\\.${escapeRegExp(attr)}\\s+is\\s+None\\s*:`);

/** `if self.<attr> is not None:`(正向非 None 守卫) */
const notNoneGuard = (attr: string): RegExp =>
  new RegExp(`^\\s*if\\s+self\\.${escapeRegExp(attr)}\\s+is\\s+not\\s+None\\s*:`);

/**
 * 任何 `if`/`elif`/`else`/`for`/`while`/`try`/`except`/`finally`/`with` 块开
 * (非注释)。KODE-AUD-004:补 else/except/finally——此前这三类块体在
 * scanSequence 里不被 anyBlockOpen 识别,块体行以更深缩进被「跳过」分支吞掉,
 * 块内 `self.<attr> = ...` 赋值不贡献流类型(如 `if c: X=None / else: X=[..]`
 * 块后只并 then 侧,漏 else 侧)。else/except/finally 与 if/try 同缩进,并入
 * 通用块处理,块后并集语义原样。
 */
const anyBlockOpen = /^\s*(if|elif|else|for|while|try|except|finally|with)\b/;
const terminalLine = /^\s*(return|raise)\b/;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 提取赋值右侧(去掉尾注释) */
function assignmentRhs(text: string, attr: string): string | null {
  const match = selfAssignment(attr).exec(text);
  if (!match) {
    return null;
  }
  return stripTrailingComment(match[1]);
}

function stripTrailingComment(rhs: string): string {
  // 简单形态:不在字符串内的 `#` 视为注释截断(字面量面足够)
  let inString: string | null = null;
  for (let i = 0; i < rhs.length; i += 1) {
    const char = rhs[i];
    if (inString !== null) {
      if (char === inString && rhs[i - 1] !== '\\') {
        inString = null;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      inString = char;
      continue;
    }
    if (char === '#') {
      return rhs.slice(0, i).trim();
    }
  }
  return rhs.trim();
}

/**
 * 表达式类型(原子集合):字面量(list/dict/set/tuple/str/int/float/bool/None)、
 * 调用形态(经回调取返回注解)、裸名(经回调)、`self.Y`(递归本引擎)。推不出
 * → 空集(不硬造)。只做浅层形态判定,不解析任意表达式。
 */
function typeOfExpr(expr: string, options?: SelfAttributeFlowOptions): Set<string> {
  const text = stripTrailingComment(expr);
  if (text.length === 0) {
    return new Set();
  }
  if (text === 'None') {
    return new Set(['None']);
  }
  if (text === 'True' || text === 'False') {
    return new Set(['bool']);
  }
  if (/^[+-]?\d+$/.test(text)) {
    return new Set(['int']);
  }
  if (/^[+-]?\d+\.\d+$/.test(text)) {
    return new Set(['float']);
  }
  // 字符串字面量(带可选前缀 b/r/f/u):b/B 前缀=bytes(b''/br''/rb''/B''),
  // 其余(r/u/f 及无前缀)=str。KODE-AUD-004:此前一律判 str,b'...' 误判。
  const strPrefix = /^([bBrRuUfF]{0,2})['"]/.exec(text);
  if (strPrefix && /['"]$/.test(text)) {
    return new Set([/[bB]/.test(strPrefix[1]) ? 'bytes' : 'str']);
  }
  if (text.startsWith('[') && text.endsWith(']')) {
    return new Set(['list']);
  }
  if (text.startsWith('{') && text.endsWith('}')) {
    return new Set(['dict']);
  }
  if (text.startsWith('(') && text.endsWith(')')) {
    return new Set(['tuple']);
  }
  // 调用形态:name(...) / a.b.c(...) → 末段 callee 取返回注解
  const callMatch = /^([A-Za-z_]\w*(?:\s*\.\s*[A-Za-z_]\w*)*)\s*\(/.exec(text);
  if (callMatch) {
    const callee = callMatch[1].split('.').pop()!.trim();
    const annotation = options?.resolveCallAnnotation?.(callee) ?? null;
    return annotation ? new Set([annotation]) : new Set();
  }
  // self.Y(本引擎递归,有界:不解析嵌套 self 链更深一层)
  const selfChain = /^self\.([A-Za-z_]\w*)$/.exec(text);
  if (selfChain) {
    // 递归由调用方在已知行上下文调用;此处返回空避免无界(调用方处理)
    return new Set();
  }
  // 裸名(常量/变量):经回调
  const nameMatch = /^[A-Za-z_]\w*$/.exec(text);
  if (nameMatch) {
    const annotation = options?.resolveNameAnnotation?.(text) ?? null;
    return annotation ? new Set([annotation]) : new Set();
  }
  return new Set();
}

/** 方法体界(0 起行,含尾):复用类方法排序区间 */
function enclosingMethod(
  classes: readonly ClassSpan[],
  line: number
): { method: MethodSpan; cls: ClassSpan } | null {
  for (const cls of classes) {
    if (line < cls.startLine || line >= cls.endLine) {
      continue;
    }
    const starts = [...cls.methods.values()].map(loc => loc.line).sort((a, b) => a - b);
    for (let i = starts.length - 1; i >= 0; i -= 1) {
      if (starts[i] <= line) {
        const endLine = i + 1 < starts.length ? starts[i + 1] - 1 : cls.endLine - 1;
        return {
          method: { startLine: starts[i], endLine, baseIndent: 0 },
          cls
        };
      }
    }
    return null;
  }
  return null;
}

/** 方法体基础缩进:方法行后首个非空行的缩进;无体行则方法行缩进+1 */
function methodBaseIndent(lines: readonly string[], method: MethodSpan): number {
  const methodIndent = indentOf(lines[method.startLine]);
  for (let j = method.startLine + 1; j <= method.endLine; j += 1) {
    const text = lines[j];
    if (BLANK.test(text) || COMMENT_ONLY.test(text)) {
      continue;
    }
    return indentOf(text);
  }
  return methodIndent + 1;
}

interface ScanResult {
  state: Set<string>;
  /** then 分支以 return/raise 终止(不落到块后) */
  terminal: boolean;
  /** 扫描在 stopAtLine 前停住(查询位在本块内,外层须立即返回本态) */
  reachedStop: boolean;
}

/**
 * 顺序扫描一段语句序列(从 startLine 起,同一缩进层),推进 attr 流类型。
 * stopAtLine 非空时在到达该行前停止(返回该行前的状态,不处理该行)。
 * 递归处理 if/for/while 块:块后状态 = 并集(入口态, then 态)(else 路径 ∪
 * then 路径);早退(块内含 return/raise)then 不落到块后,块后 = 入口态。
 */
function scanSequence(
  lines: readonly string[],
  startLine: number,
  endLine: number,
  indent: number,
  attr: string,
  initialState: ReadonlySet<string>,
  options: SelfAttributeFlowOptions | undefined,
  stopAtLine: number | null
): ScanResult {
  let state = new Set(initialState);
  let line = startLine;
  while (line <= endLine) {
    if (stopAtLine !== null && line >= stopAtLine) {
      // 到达查询位:本块内停住,外层须立即返回(查询位在块内)。
      // 查询位恰是赋值行时先落赋值语义再停(写点 inlay 显 RHS 类型,
      // 与 def inlay 在写点显声明类型同口径,而非守卫真分支里的旧值 None)
      const rhsAtStop = assignmentRhs(lines[line] ?? '', attr);
      if (rhsAtStop !== null) {
        return { state: typeOfExpr(rhsAtStop, options), terminal: false, reachedStop: true };
      }
      return { state, terminal: false, reachedStop: true };
    }
    const text = lines[line];
    if (BLANK.test(text) || COMMENT_ONLY.test(text)) {
      line += 1;
      continue;
    }
    const thisIndent = indentOf(text);
    if (thisIndent < indent) {
      // 去缩进:本序列结束(调用方负责关块)
      break;
    }
    if (thisIndent > indent) {
      // 更深缩进(块体)不属本层,跳过(由块递归处理);保守步进
      line += 1;
      continue;
    }
    // 赋值:self.<attr> = expr → 覆盖流类型
    const rhs = assignmentRhs(text, attr);
    if (rhs !== null) {
      state = typeOfExpr(rhs, options);
      line += 1;
      continue;
    }
    // 守卫:if self.<attr> is None:
    if (noneGuard(attr).test(text)) {
      const blockEnd = findBlockEnd(lines, line, endLine, thisIndent);
      const bodyIndent = blockBodyIndent(lines, line, blockEnd);
      const inner = scanSequence(
        lines, line + 1, blockEnd, bodyIndent, attr, new Set(['None']), options, stopAtLine
      );
      if (inner.terminal) {
        // 早退:then 不落到块后;else 路径(X 非 None)继续 → 去 None
        state = unionTypes(withoutNone(state));
      } else {
        // then 落回块后:并集(else=X 非 None → 去 None, then=inner.state)
        state = unionTypes(withoutNone(state), inner.state);
      }
      if (inner.reachedStop) {
        return { state: inner.state, terminal: inner.terminal, reachedStop: true };
      }
      line = blockEnd + 1;
      continue;
    }
    // 守卫:if self.<attr> is not None:
    if (notNoneGuard(attr).test(text)) {
      const blockEnd = findBlockEnd(lines, line, endLine, thisIndent);
      const bodyIndent = blockBodyIndent(lines, line, blockEnd);
      const inner = scanSequence(
        lines, line + 1, blockEnd, bodyIndent, attr, withoutNone(state), options, stopAtLine
      );
      if (inner.terminal) {
        // 早退非 None 块:then 退出,else(X 可 None)继续 → 入口态
        state = unionTypes(state);
      } else {
        state = unionTypes(state, inner.state);
      }
      if (inner.reachedStop) {
        return { state: inner.state, terminal: inner.terminal, reachedStop: true };
      }
      line = blockEnd + 1;
      continue;
    }
    // 其他块(if/for/while/try/with):块体可能含赋值,块后并集
    if (anyBlockOpen.test(text)) {
      const blockEnd = findBlockEnd(lines, line, endLine, thisIndent);
      const bodyIndent = blockBodyIndent(lines, line, blockEnd);
      const inner = scanSequence(
        lines, line + 1, blockEnd, bodyIndent, attr, state, options, stopAtLine
      );
      if (inner.terminal) {
        state = unionTypes(state);
      } else {
        state = unionTypes(state, inner.state);
      }
      if (inner.reachedStop) {
        return { state: inner.state, terminal: inner.terminal, reachedStop: true };
      }
      line = blockEnd + 1;
      continue;
    }
    // return/raise:本序列终止(调用方标记 terminal)
    if (terminalLine.test(text)) {
      return { state, terminal: true, reachedStop: false };
    }
    line += 1;
  }
  return { state, terminal: false, reachedStop: false };
}

/** if/for/while 块闭合行:首个缩进 <= ifIndent 的非空行;无则 endLine+1 */
function findBlockEnd(
  lines: readonly string[],
  startLine: number,
  endLine: number,
  indent: number
): number {
  for (let j = startLine + 1; j <= endLine; j += 1) {
    const text = lines[j];
    if (BLANK.test(text) || COMMENT_ONLY.test(text)) {
      continue;
    }
    if (indentOf(text) <= indent) {
      return j - 1;
    }
  }
  return endLine;
}

/** 块体实际缩进:块行后首个非空行的缩进;无体行则块行缩进+1 */
function blockBodyIndent(
  lines: readonly string[],
  startLine: number,
  endLine: number
): number {
  for (let j = startLine + 1; j <= endLine; j += 1) {
    const text = lines[j];
    if (BLANK.test(text) || COMMENT_ONLY.test(text)) {
      continue;
    }
    return indentOf(text);
  }
  return indentOf(lines[startLine]) + 1;
}

/** 收敛基类:__init__ 体流扫描末态 ∪ 类级声明(含 `X = None`) */
function convergedBaseline(
  lines: readonly string[],
  cls: ClassSpan,
  attr: string,
  options: SelfAttributeFlowOptions | undefined
): Set<string> {
  let baseline = new Set<string>();
  // 类级声明:类体顶层(实际体缩进)的 `X = ...` / `X: T = ...`
  const classBodyIndent = blockBodyIndent(lines, cls.startLine, cls.endLine - 1);
  const firstMethodLine = cls.methods.size > 0
    ? Math.min(...[...cls.methods.values()].map(loc => loc.line))
    : cls.endLine - 1;
  const classAssignment = new RegExp(`^\\s*${escapeRegExp(attr)}\\s*=\\s*(?!=)(.+)$`);
  const classAnnotated = new RegExp(`^\\s*${escapeRegExp(attr)}\\s*:\\s*([^=#]+?)\\s*(?:=|$)`);
  for (let j = cls.startLine + 1; j < firstMethodLine && j < cls.endLine; j += 1) {
    const text = lines[j];
    if (BLANK.test(text) || COMMENT_ONLY.test(text)) {
      continue;
    }
    if (indentOf(text) !== classBodyIndent) {
      continue;
    }
    // 注解声明 `X: T = ...`(T 优先;`X: T` 无初始值亦算)
    const annotated = classAnnotated.exec(text);
    if (annotated) {
      baseline = unionTypes(baseline, new Set([annotated[1].trim()]));
    }
    // 赋值声明 `X = ...`(如 `X = None` 类级默认)
    const assigned = classAssignment.exec(text);
    if (assigned) {
      baseline = unionTypes(baseline, typeOfExpr(assigned[1], options));
    }
  }
  // __init__ 体流扫描末态(尾部赋值覆盖)
  const init = cls.methods.get('__init__');
  if (init) {
    const initMethod: MethodSpan = { startLine: init.line, endLine: cls.endLine - 1, baseIndent: 0 };
    initMethod.baseIndent = methodBaseIndent(lines, initMethod);
    const result = scanSequence(
      lines,
      init.line + 1,
      initMethod.endLine,
      initMethod.baseIndent,
      attr,
      baseline,
      options,
      null
    );
    baseline = result.state;
  }
  return baseline;
}

/**
 * 查询位自管属性流敏感类型(纯函数)。
 * 返回 null 当:不在类内方法/类体、attr 为空、无法定位上下文。
 * 调用方需先确定 attr(如从访问扫描 self.<attr> 提取)。
 */
export function inferSelfAttributeFlow(
  lines: readonly string[],
  queryLine: number,
  attr: string,
  options?: SelfAttributeFlowOptions,
  versionKey?: string
): SelfAttributeFlow | null {
  if (!attr || queryLine < 0 || queryLine >= lines.length) {
    return null;
  }
  // KODE-PERF-001:同文档版本多次流查询共享一次解析(键=uri|version);
  // 无键(纯函数/测试)=现解析,行为不变。
  const parsed = parseWithVersionCache(lines, versionKey);
  const classes = (parsed.classes as unknown as ClassSpan[]) ?? [];
  const enclosing = enclosingMethod(classes, queryLine);
  let baseline: Set<string>;
  let flow: Set<string>;
  if (enclosing) {
    baseline = convergedBaseline(lines, enclosing.cls, attr, options);
    const method = enclosing.method;
    method.baseIndent = methodBaseIndent(lines, method);
    const result = scanSequence(
      lines,
      method.startLine + 1,
      method.endLine,
      method.baseIndent,
      attr,
      baseline,
      options,
      queryLine
    );
    flow = result.state;
  } else {
    // 类体/模块层:无方法流,直接用收敛基类
    const cls = classes.find(c => queryLine >= c.startLine && queryLine < c.endLine);
    baseline = cls ? convergedBaseline(lines, cls, attr, options) : new Set<string>();
    flow = new Set(baseline);
  }
  const hasNone = flow.has('None');
  const narrowed = baseline.has('None') && !hasNone;
  return {
    types: [...flow].sort(),
    annotation: formatTypes(flow),
    hasNone,
    narrowed
  };
}
