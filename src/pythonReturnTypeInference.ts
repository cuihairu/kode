import * as fs from 'fs';
import * as path from 'path';

/**
 * 局部变量返回类型推导(用户令 2026-10-21:「data = activity_data.get_data()
 * → data: JSONDATA」):`<名> = <右值>` 的 hover 面按右值被调函数的返回注解
 * 推导变量类型。纯逻辑 + 同步 fs 扫描,不 import vscode。
 *
 * 解析优先级(用户令原话):python 实现的 `def get_data(...) -> X:` 返回注解
 * (按方法名在项目 python 文件内定位定义,单层调用 + 属性直调 a.b() 一层即
 * 可,不追跨变量传播)→ .def 方法返回声明若有 → 未知则不显示。KBEngine 的
 * .def 方法格式只有 <Arg> 形参声明、没有返回声明语法,故第二层在当前 def
 * 格式下结构性地不存在,不解不造。解出才有提示(「能推才显」):注解缺失/
 * 解析链断一律返回 null,调用方不显示任何类型(不显 Any、不显空类型)。
 *
 * 索引按工作区缓存,TTL 3 秒自愈(新文件/改动 3 秒内可见,无 watch 依赖);
 * 测试用 resetPythonReturnAnnotationCache() 即时清。
 */

/** 扫描排除面:与 pythonClassIndex.PY_SCAN_EXCLUDE 同口径的目录名清单 */
const SCAN_EXCLUDED_DIRS = new Set([
  'node_modules', 'third_party', '.git', 'vcpkg', 'build', 'dist', 'out',
  '.tmp', 'perf', '.venv', 'venv', 'site-packages', '__pycache__', 'coverage'
]);

const INDEX_TTL_MS = 3000;

/** 一条 `名 = 右值` 赋值里的单层调用(简单调用 f() 或属性直调 a.b()) */
export interface LocalAssignmentCall {
  /** 被赋值变量名(简单标识符,不含点) */
  target: string;
  /** 属性直调的接收者(a.b() 的 a);简单调用 f() 为 null */
  receiver: string | null;
  /** 被调函数/方法名 */
  methodName: string;
}

const ASSIGNMENT_PATTERN = /^(\s*)([A-Za-z_]\w*)\s*=\s*(?!=)(.+)$/;
const SIMPLE_CALL_PATTERN = /^([A-Za-z_]\w*)\s*\(/;
const ATTRIBUTE_CALL_PATTERN = /^([A-Za-z_]\w*)\s*\.\s*([A-Za-z_]\w*)\s*\(/;

/** 去注释去字符串但不移位(与 pythonClassIndex.pythonCodeLines 同法,精简版) */
function maskCodeLine(raw: string): string {
  let quote = '';
  let triple = false;
  let masked = '';
  for (let col = 0; col < raw.length; col += 1) {
    const ch = raw[col];
    if (quote) {
      if (ch === '\\') { masked += '  '; col += 1; continue; }
      if (triple && raw.slice(col, col + 3) === quote.repeat(3)) {
        quote = ''; triple = false; masked += '   '; col += 2;
      } else if (!triple && ch === quote) { quote = ''; masked += ' '; }
      else { masked += ' '; }
      continue;
    }
    if (ch === '#') { masked += ' '.repeat(raw.length - col); break; }
    if (ch === "'" || ch === '"') {
      quote = ch;
      triple = raw.slice(col, col + 3) === ch.repeat(3);
      masked += triple ? '___' : '_';
      if (triple) { col += 2; }
      continue;
    }
    masked += ch;
  }
  return masked;
}

/**
 * 单行赋值解析:`data = activity_data.get_data()` → 命中;右值不是「单层
 * 调用整体」(链式 f().g()、二元表达式、字面量等)→ null(一层即可,不追)。
 */
export function parseLocalAssignmentCall(lineText: string): LocalAssignmentCall | null {
  const match = ASSIGNMENT_PATTERN.exec(lineText);
  if (!match) {
    return null;
  }
  const rhs = maskCodeLine(match[3]).trim();
  const attribute = ATTRIBUTE_CALL_PATTERN.exec(rhs);
  if (attribute && rhs.endsWith(')')) {
    return { target: match[2], receiver: attribute[1], methodName: attribute[2] };
  }
  const simple = SIMPLE_CALL_PATTERN.exec(rhs);
  if (simple && rhs.endsWith(')') && !rhs.includes('.')) {
    return { target: match[2], receiver: null, methodName: simple[1] };
  }
  return null;
}

/**
 * 从 python 源码里读 `def <methodName>(...) -> X:` 的返回注解文本。
 * 签名允许多行(括号深度归零的冒号收口);def 在而 `->` 缺 → null
 * (无注解不显示);def 不在 → null。返回的注解串已去空白。
 */
export function extractDefReturnAnnotation(source: string, methodName: string): string | null {
  const lines = source.split(/\r?\n/);
  const defHead = new RegExp(`^\\s*def\\s+${methodName}\\s*\\(`);
  for (let start = 0; start < lines.length; start += 1) {
    if (!defHead.test(maskCodeLine(lines[start]))) {
      continue;
    }
    // 收口:参数括号闭合后深度归零的冒号即签名结束(形参注解里的冒号在括号
    // 内,不收口);与 def 同行或后续行都收。
    let depth = 0;
    let sawParens = false;
    let signature = '';
    for (let line = start; line < Math.min(lines.length, start + 64); line += 1) {
      const masked = maskCodeLine(lines[line]);
      for (const ch of masked) {
        if (ch === '(') { depth += 1; sawParens = true; }
        else if (ch === ')') { depth = Math.max(0, depth - 1); }
        else if (ch === ':' && sawParens && depth === 0) {
          const arrow = signature.indexOf('->');
          if (arrow < 0) {
            return null;
          }
          const annotation = signature.slice(arrow + 2).trim();
          return annotation.length > 0 ? annotation : null;
        }
        signature += ch;
      }
    }
    return null;
  }
  return null;
}

/** 项目 python 文件清单(同步走根树,排除面同 PY_SCAN_EXCLUDE 口径),排序保确定 */
export function collectProjectPythonFiles(workspaceRoot: string, limit = 20000): string[] {
  const files: string[] = [];
  const visit = (dir: string): void => {
    if (files.length >= limit) {
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= limit) {
        return;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SCAN_EXCLUDED_DIRS.has(entry.name)) {
          visit(full);
        }
      } else if (entry.isFile() && entry.name.endsWith('.py')) {
        files.push(full);
      }
    }
  };
  visit(workspaceRoot);
  return files.sort();
}

/** 方法名 → 返回注解(同名多定义时取扫描序里第一个有注解的;缺注解不入表) */
export type PythonReturnAnnotationIndex = Map<string, string>;

/** 一次按行遍历源码，提取每个函数首次定义的返回注解。 */
export function extractFileReturnAnnotations(source: string): PythonReturnAnnotationIndex {
  const result: PythonReturnAnnotationIndex = new Map();
  const seen = new Set<string>();
  const defHead = /^\s*def\s+([A-Za-z_]\w*)\s*\(/;
  let current: { name: string; signature: string; depth: number; sawParens: boolean; lines: number } | undefined;

  for (const rawLine of source.split(/\r?\n/)) {
    const masked = maskCodeLine(rawLine);
    const nextDef = defHead.exec(masked)?.[1];
    // 不完整的签名不能吞掉后续定义，也不能借用后续定义的冒号或注解。
    if (current && nextDef) { current = undefined; }
    if (!current) {
      const name = nextDef;
      if (!name || seen.has(name)) { continue; }
      seen.add(name);
      current = { name, signature: '', depth: 0, sawParens: false, lines: 0 };
    }
    current.lines += 1;
    for (const ch of masked) {
      if (ch === '(') { current.depth += 1; current.sawParens = true; }
      else if (ch === ')') { current.depth = Math.max(0, current.depth - 1); }
      else if (ch === ':' && current.sawParens && current.depth === 0) {
        const arrow = current.signature.indexOf('->');
        const annotation = arrow < 0 ? '' : current.signature.slice(arrow + 2).trim();
        if (annotation) { result.set(current.name, annotation); }
        current = undefined;
        break;
      }
      current.signature += ch;
    }
    if (current && current.lines >= 64) { current = undefined; }
  }
  return result;
}

export function buildReturnAnnotationIndex(sources: readonly string[]): PythonReturnAnnotationIndex {
  const index: PythonReturnAnnotationIndex = new Map();
  for (const source of sources) {
    for (const [name, annotation] of extractFileReturnAnnotations(source)) {
      if (!index.has(name)) { index.set(name, annotation); }
    }
  }
  return index;
}

interface ReturnAnnotationCacheEntry {
  builtAtMs: number;
  index: PythonReturnAnnotationIndex;
}

const returnAnnotationCaches = new Map<string, ReturnAnnotationCacheEntry>();

/** 测试用:清全部工作区缓存(换临时根/改文件后立即生效) */
export function resetPythonReturnAnnotationCache(): void {
  returnAnnotationCaches.clear();
}

function getReturnAnnotationIndex(workspaceRoot: string): PythonReturnAnnotationIndex {
  const now = Date.now();
  const cached = returnAnnotationCaches.get(workspaceRoot);
  if (cached && now - cached.builtAtMs < INDEX_TTL_MS) {
    return cached.index;
  }
  const index = buildReturnAnnotationIndex(
    collectProjectPythonFiles(workspaceRoot).map(file => {
      try {
        return fs.readFileSync(file, 'utf8');
      } catch {
        return '';
      }
    })
  );
  returnAnnotationCaches.set(workspaceRoot, { builtAtMs: Date.now(), index });
  return index;
}

/** 推导结果:注解串 + 来源方法名(hover 标注「推导自 get_data() 返回注解」) */
export interface LocalVariableReturnType {
  target: string;
  annotation: string;
  methodName: string;
}

/**
 * hover 求值:光标落在 `word` 上时,在 [0, hoverLine] 内找 `word = <单层调用>`
 * 的赋值,**自 hover 行向上取最后一条可解析的**(同名重赋值取最后一次可解析
 * 值);右值被调方法名在项目 python 索引有返回注解才解出,否则 null(不显示)。
 */
export function resolveLocalVariableReturnType(
  lines: readonly string[],
  hoverLine: number,
  word: string,
  workspaceRoot: string | null
): LocalVariableReturnType | null {
  if (!workspaceRoot || !word || /^[A-Z_][A-Z0-9_]*$/.test(word)) {
    return null;
  }
  let index: PythonReturnAnnotationIndex | undefined;
  for (let line = Math.min(hoverLine, lines.length - 1); line >= 0; line -= 1) {
    const assignment = parseLocalAssignmentCall(lines[line] ?? '');
    if (!assignment || assignment.target !== word) {
      continue;
    }
    index ??= getReturnAnnotationIndex(workspaceRoot);
    const annotation = index.get(assignment.methodName);
    if (annotation && annotation !== 'Any') {
      return { target: word, annotation, methodName: assignment.methodName };
    }
    // 右值是赋值但解不出注解:继续向上找更早的可解析赋值(取最后一次可解析值)
  }
  return null;
}
