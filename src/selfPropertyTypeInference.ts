/**
 * TYP-ARRAY:python 侧 `self.<def 属性>` 的类型推导与数组元素类型。
 *
 * 背景(2026-10-30 用户反馈):def 已声明 `equip_track_list` 类型 EQUIP_TRACK_LIST,
 * python 里 `self.equip_track_list` 仍 Any;EQUIP_TRACK_LIST 是数组,取出元素应能
 * 推导元素类型而不是 Any。现状:存根面/内建面已能展开 ARRAY→FixedArray[元素]
 * (pythonTypeStubs.resolveStructureElement),但 python 脚本里 `self.<def 属性>` 的
 * hover/变量推导没有吃到这个展开——hover 只见内建属性面,`for x in self.a` /
 * `x = self.a[i]` 取不出 `<of>` 元素类型。
 *
 * 本模块是纯分析层(不 import vscode):输入文档行 + 悬停位 + self 访问上下文,
 * 输出「该表达式的 def 属性注解(容器)或数组元素注解」;类型注册表(def 属性
 * 类型名 → Python 注解)与 def 属性定位(entityMappingManager)由调用方注入。
 *
 * 诚实面(④):空 `<of>`/别名链环/类型缺失 → 注解 Any + reason,绝不伪造。
 * 深度界:变量间接一层(赋值/迭代目标 → 其源表达式再追一层),防环与长链。
 *
 * 边界(如实,不虚标):
 * - 只认 `self.<属性>` 读形态与 `for x in ...`/`x = ...[i]` 变量延续;
 *   `self.<FIXED_DICT>.<字段>` 子成员(下标后的成员访问)由 FIXED_DICT 子成员
 *   面(inlay resolveFixedDictMember)管,此处不接管(诚实返回 null)。
 * - 元素型本身是 FIXED_DICT 时注解落其 TypedDict 类名(如 EQUIP_INFO),不做
 *   成员面展开——元素成员访问是另一条推导链,不在本任务验收面。
 */
import { PYTHON_TYPE_STUB_FALLBACK } from './pythonTypeStubs';
import type { PythonSelfAccess } from './pythonLanguageUtils';

/** def 属性定位结果(.def 声明面) */
export interface DefPropertyLocation {
  typeName?: string | null;
  line: number;
  defFile: string;
}

/** def 属性定位(调用方注入):(完整路径, 根段) → .def 声明位置 */
export type DefPropertyLocator = (
  fullPath: string,
  rootSymbol: string
) => Promise<DefPropertyLocation | null>;

/** 类型名 → Python 注解 + 诚实 Any 原因(调用方注入 workspace 注册表快照) */
export type AnnotationResolver = (raw: string) => { annotation: string; reason: string | null };

/** 解析结果(容器或元素) */
export interface SelfPropertyResolved {
  /** 最终 Python 注解(容器或元素) */
  annotation: string;
  /** 诚实 Any 原因(④);非 Any 恒 null */
  reason: string | null;
  /** def-property=容器注解;element=<of> 元素注解 */
  kind: 'def-property' | 'element';
  /** 属性名(.def 声明) */
  propertyName: string;
  /** .def 文件与声明行(来源标注) */
  defFile: string;
  defLine: number;
  /** 目标表达式文本(悬停目标,来源标注) */
  expr: string;
}

/** 变量间接最大深度(赋值/迭代目标 → 源表达式再追一层;防环/长链) */
const MAX_VAR_INDIRECTION = 2;

/**
 * 悬停位 → def 属性/元素注解(①-④)。悬停词是 `self.<属性>` 段 → 容器注解
 * (①);悬停词是普通变量 → 向上找最近写入(for-target 取元素 / 赋值取 RHS
 * 注解),元素型经下标后缀或 for-iterable 剥离(②);赋值局部变量延续推导
 * (变量间接一层);空 <of>/环/缺失 → Any + reason(④)。形状不匹配(不是
 * def 属性/元素位)或解析不出 → null(调用方落回普通 hover 链,能推才显)。
 */
export async function resolveSelfPropertyAnnotation(
  lines: readonly string[],
  hoverLine: number,
  word: string,
  selfAccess: PythonSelfAccess | null,
  locator: DefPropertyLocator,
  annotate: AnnotationResolver
): Promise<SelfPropertyResolved | null> {
  // 悬停词是 self.<属性> 段 → 容器注解(①;下标后缀属外层表达式,悬停基名
  // 恒给容器型,元素型由变量延续面给——两义不猜,给基名本身的类型)。
  if (selfAccess) {
    return resolveSelfAccess(selfAccess, locator, annotate);
  }
  if (!/^[A-Za-z_]\w*$/.test(word)) {
    return null;
  }
  // 悬停词是普通变量 → 向上找最近写入(for-target / assignment)
  const write = findNearestWrite(lines, hoverLine, word);
  if (!write) {
    return null;
  }
  if (write.kind === 'for') {
    // `for word in ITER:` → ITER 容器注解后取 <of> 元素
    const container = await resolveExpr(
      write.iterable, 0, lines, write.line, locator, annotate
    );
    if (!container) {
      return null;
    }
    return takeElement(container, word);
  }
  // `word = RHS` → RHS 自身注解(下标后缀在 RHS 里解析);来源标注表达式
  // 用悬停目标词本身(非 RHS 文本),展示位与用户悬停一致。
  const resolved = await resolveExpr(write.rhs, 0, lines, write.line, locator, annotate);
  if (!resolved) {
    return null;
  }
  return { ...resolved, expr: word };
}

/** self.<path> 访问 → def 属性容器注解 */
async function resolveSelfAccess(
  selfAccess: PythonSelfAccess,
  locator: DefPropertyLocator,
  annotate: AnnotationResolver
): Promise<SelfPropertyResolved | null> {
  const fullPath = selfAccess.fullPath;
  const root = fullPath.split('.')[0];
  const location = await locator(fullPath, root);
  if (!location) {
    return null;
  }
  if (!location.typeName) {
    // def 属性未声明 <Type>:诚实 Any,不伪造
    return {
      annotation: PYTHON_TYPE_STUB_FALLBACK,
      reason: 'def 属性未声明 <Type> 类型,回退 Any',
      kind: 'def-property',
      propertyName: fullPath.split('.').pop()!,
      defFile: location.defFile,
      defLine: location.line,
      expr: `self.${fullPath}`
    };
  }
  const resolved = annotate(location.typeName);
  return {
    annotation: resolved.annotation,
    reason: resolved.reason,
    kind: 'def-property',
    propertyName: fullPath.split('.').pop()!,
    defFile: location.defFile,
    defLine: location.line,
    expr: `self.${fullPath}`
  };
}

/** 表达式 → 注解(base 解析 + 下标后缀逐层取元素) */
async function resolveExpr(
  expr: string,
  depth: number,
  lines: readonly string[],
  searchLine: number,
  locator: DefPropertyLocator,
  annotate: AnnotationResolver
): Promise<SelfPropertyResolved | null> {
  if (depth > MAX_VAR_INDIRECTION) {
    return null;
  }
  const { base, subscripts } = splitSubscripts(expr);
  if (!base) {
    return null;
  }
  const baseResolved = await resolveBase(base, depth, lines, searchLine, locator, annotate);
  if (!baseResolved) {
    return null;
  }
  let current = baseResolved;
  for (let i = 0; i < subscripts; i += 1) {
    const element = takeElement(current, current.expr);
    if (!element) {
      // 对非数组下标:不接管(诚实,不伪造元素型)
      return null;
    }
    current = element;
  }
  return current;
}

/** base 表达式 → 注解:`self.<path>` 直解;`<var>` 向上追最近写入(限深) */
async function resolveBase(
  base: string,
  depth: number,
  lines: readonly string[],
  searchLine: number,
  locator: DefPropertyLocator,
  annotate: AnnotationResolver
): Promise<SelfPropertyResolved | null> {
  const selfMatch = /^self\.(\w+(?:\.\w+)*)$/.exec(base);
  if (selfMatch) {
    return resolveSelfAccess(
      { rootSymbol: selfMatch[1].split('.')[0], currentSymbol: selfMatch[1], fullPath: selfMatch[1] },
      locator,
      annotate
    );
  }
  if (!/^[A-Za-z_]\w*$/.test(base)) {
    return null;
  }
  const write = findNearestWrite(lines, searchLine, base);
  if (!write) {
    return null;
  }
  if (write.kind === 'for') {
    const container = await resolveExpr(write.iterable, depth + 1, lines, write.line, locator, annotate);
    if (!container) {
      return null;
    }
    return takeElement(container, base);
  }
  return resolveExpr(write.rhs, depth + 1, lines, write.line, locator, annotate);
}

/** 最近一次对 target 的写入(for-target 或赋值),自 fromLine 向上,跨作用域即止 */
type NearestWrite =
  | { kind: 'assignment'; line: number; rhs: string }
  | { kind: 'for'; line: number; iterable: string };

function findNearestWrite(
  lines: readonly string[],
  fromLine: number,
  target: string
): NearestWrite | null {
  let scopeIndentLimit = Number.POSITIVE_INFINITY;
  const lastIndex = Math.min(fromLine, lines.length - 1);
  for (let line = lastIndex; line >= 0; line -= 1) {
    const text = lines[line] ?? '';
    const indent = text.length - text.trimStart().length;
    if (indent < scopeIndentLimit) {
      const forMatch = /^\s*for\s+([A-Za-z_]\w*)\s+in\s+(.+?)\s*:\s*(?:#.*)?$/.exec(text);
      if (forMatch && forMatch[1] === target) {
        return { kind: 'for', line, iterable: forMatch[2].trim() };
      }
      const assign = /^\s*([A-Za-z_]\w*)\s*=\s*(?!=)(.+)$/.exec(text);
      if (assign && assign[1] === target) {
        return { kind: 'assignment', line, rhs: assign[2].trim() };
      }
    }
    const scopeHeader = /^\s*(?:async\s+def|def|class)\s/.exec(text);
    if (scopeHeader) {
      scopeIndentLimit = Math.min(scopeIndentLimit, indent + 1);
    }
  }
  return null;
}

/**
 * 剥离下标后缀:`self.a[i][j]` → base `self.a` + 2 下标;`x[0]` → base `x` + 1。
 * 下标后接成员(`a[0].b`)不接管(子成员面另管):返回空 base。仅剥尾随 `[]`,
 * 无 base 或形态不纯 → 空 base(调用方落回,不硬猜)。
 */
function splitSubscripts(expr: string): { base: string; subscripts: number } {
  let trimmed = expr;
  let count = 0;
  for (;;) {
    const end = trimmed.length - 1;
    if (end < 0 || trimmed[end] !== ']') {
      break;
    }
    let depth = 0;
    let open = -1;
    for (let i = end; i >= 0; i -= 1) {
      if (trimmed[i] === ']') {
        depth += 1;
      } else if (trimmed[i] === '[') {
        depth -= 1;
        if (depth === 0) {
          open = i;
          break;
        }
      }
    }
    if (open <= 0) {
      // 无 base(如 `[0]` 开头)或下标包住整式 → 不接管
      return { base: '', subscripts: count };
    }
    trimmed = trimmed.slice(0, open).trimEnd();
    count += 1;
  }
  if (count === 0 && /\]/.test(trimmed)) {
    // 形如 `a[0].b`:下标后接成员 → 不接管(子成员面另管)
    return { base: '', subscripts: 0 };
  }
  return { base: trimmed, subscripts: count };
}

/** 容器注解 → <of> 元素注解;非数组(未匹配 FixedArray[X]/list[X])→ null(不接管) */
function takeElement(
  container: SelfPropertyResolved,
  target: string
): SelfPropertyResolved | null {
  const arrayMatch = /^(?:FixedArray|list)\[(.+)\]$/.exec(container.annotation);
  if (!arrayMatch) {
    return null;
  }
  const element = arrayMatch[1].trim();
  const emptyOf = element === PYTHON_TYPE_STUB_FALLBACK;
  return {
    annotation: emptyOf ? PYTHON_TYPE_STUB_FALLBACK : element,
    reason: emptyOf
      ? 'ARRAY 缺 <of> 元素声明,元素型回退 Any'
      : (container.reason ?? null),
    kind: 'element',
    propertyName: container.propertyName,
    defFile: container.defFile,
    defLine: container.defLine,
    expr: target
  };
}
