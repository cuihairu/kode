import * as fs from 'fs';
import * as path from 'path';

import { recordLanguageServiceOperation } from './languageServiceMetrics';
import { annotationSourceLog } from './annotationSourceLog';

/**
 * 局部变量返回类型推导(用户令 2026-10-21:「data = activity_data.get_data()
 * → data: JSONDATA」):`<名> = <右值>` 的 hover 面按右值被调函数的返回注解
 * 推导变量类型。目录发现和源码读取均异步执行，不 import vscode。
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
const ANNOTATION_READ_CONCURRENCY = 8;

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

/** 异步目录发现；取消后不再访问后续目录。 */
export async function collectProjectPythonFilesAsync(
  workspaceRoot: string,
  limit = 20000,
  token?: { readonly isCancellationRequested: boolean }
): Promise<string[]> {
  const files: string[] = [];
  const visit = async (dir: string): Promise<void> => {
    if (token?.isCancellationRequested || files.length >= limit) return;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (token?.isCancellationRequested || files.length >= limit) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SCAN_EXCLUDED_DIRS.has(entry.name)) await visit(full);
      } else if (entry.isFile() && entry.name.endsWith('.py')) {
        files.push(full);
      }
    }
  };
  await visit(workspaceRoot);
  return files.sort();
}

/** 方法名 → 返回注解(同名多定义时取扫描序里第一个有注解的;缺注解不入表) */
export type PythonReturnAnnotationIndex = Map<string, string>;

/**
 * 一次按行遍历提取「每个方法首次定义」的注解事实(IDE-HOV-002/003 同口径):
 * record(name, annotation) 在签名收口处触发;def 在而 `->` 缺 → annotation=null
 * (文档桶据此遮蔽磁盘同名的旧注解);截断/被后续定义顶替的签名不记事实。
 */
function collectFileAnnotationFacts(
  source: string,
  record: (name: string, annotation: string | null) => void
): void {
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
        record(current.name, annotation.length > 0 ? annotation : null);
        current = undefined;
        break;
      }
      current.signature += ch;
    }
    if (current && current.lines >= 64) { current = undefined; }
  }
}

/** 一次按行遍历源码，提取每个函数首次定义的返回注解。 */
export function extractFileReturnAnnotations(source: string): PythonReturnAnnotationIndex {
  const result: PythonReturnAnnotationIndex = new Map();
  collectFileAnnotationFacts(source, (name, annotation) => {
    if (annotation !== null) { result.set(name, annotation); }
  });
  return result;
}

const ANNOTATION_YIELD_INTERVAL = 16 * 1024;
type YieldBudget = { remaining: number };

async function maskCodeLineCooperatively(raw: string, budget: YieldBudget): Promise<string> {
  let quote = '';
  let triple = false;
  let masked = '';
  for (let col = 0; col < raw.length; col += 1) {
    if (--budget.remaining <= 0) {
      budget.remaining = ANNOTATION_YIELD_INTERVAL;
      await new Promise<void>(resolve => setImmediate(resolve));
    }
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
      if (triple) col += 2;
      continue;
    }
    masked += ch;
  }
  return masked;
}

/** 让出式逐行收集:与同步 collectFileAnnotationFacts 同口径(截断签名
 * 不借后续定义、同名首个定义),按字符预算 setImmediate 让出事件循环。 */
async function collectFileAnnotationFactsAsync(
  source: string,
  record: (name: string, annotation: string | null) => void
): Promise<void> {
  const seen = new Set<string>();
  const defHead = /^\s*def\s+([A-Za-z_]\w*)\s*\(/;
  const budget: YieldBudget = { remaining: ANNOTATION_YIELD_INTERVAL };
  let current: { name: string; signature: string; depth: number; sawParens: boolean; lines: number } | undefined;
  for (const rawLine of source.split(/\r?\n/)) {
    const masked = await maskCodeLineCooperatively(rawLine, budget);
    const nextDef = defHead.exec(masked)?.[1];
    if (current && nextDef) current = undefined;
    if (!current) {
      const name = nextDef;
      if (!name || seen.has(name)) continue;
      seen.add(name);
      current = { name, signature: '', depth: 0, sawParens: false, lines: 0 };
    }
    current.lines += 1;
    for (const ch of masked) {
      if (--budget.remaining <= 0) {
        budget.remaining = ANNOTATION_YIELD_INTERVAL;
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      if (ch === '(') { current.depth += 1; current.sawParens = true; }
      else if (ch === ')') { current.depth = Math.max(0, current.depth - 1); }
      else if (ch === ':' && current.sawParens && current.depth === 0) {
        const arrow = current.signature.indexOf('->');
        const annotation = arrow < 0 ? '' : current.signature.slice(arrow + 2).trim();
        record(current.name, annotation.length > 0 ? annotation : null);
        current = undefined;
        break;
      }
      current.signature += ch;
    }
    if (current && current.lines >= 64) current = undefined;
  }
}

/** 与同步提取器同口径；大文件和单个长签名均按字符预算让出事件循环。 */
export async function extractFileReturnAnnotationsAsync(source: string): Promise<PythonReturnAnnotationIndex> {
  const result: PythonReturnAnnotationIndex = new Map();
  await collectFileAnnotationFactsAsync(source, (name, annotation) => {
    if (annotation !== null) { result.set(name, annotation); }
  });
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
  /** 磁盘面按文件桶(IDE-HOV-012):保存只替换该文件桶,合并视图纯内存重算,不重读其他文件 */
  fileBuckets: Map<string, PythonReturnAnnotationIndex>;
}

/** 按插入序合并文件桶(先见优先,与全量扫描合并语义一致;Map.set 换桶不换位,序稳定)。 */
function mergeAnnotationBuckets(
  fileBuckets: Map<string, PythonReturnAnnotationIndex>
): PythonReturnAnnotationIndex {
  const index: PythonReturnAnnotationIndex = new Map();
  for (const bucket of fileBuckets.values()) {
    for (const [name, annotation] of bucket) {
      if (!index.has(name)) { index.set(name, annotation); }
    }
  }
  return index;
}

/**
 * IDE-HOV-012:保存文件时只替换该文件注解桶——提取已保存文本(调用方给
 * document.getText(),零文件读取),内存合并出新视图,其他文件桶不动、不重读。
 * 删除的返回注解随换桶不再可查。冷缓存(尚无全量索引)为 no-op:下一次查询
 * 按磁盘真值全量建,不虚建部分索引;首扫在途(2026-10-28 审核整改)记入
 * 待重放事件,发布前换桶,扫描期旧读不吞新注解。
 */
export function applySavedFileAnnotations(
  workspaceRoot: string | null,
  filePath: string,
  source: string
): void {
  if (!workspaceRoot) { return; }
  // IDE-REV-006:在途重建(TTL 过期重建/首扫)一律登记保存事件——仅改已发布
  // 桶时,重建的扫描期旧读会在发布时覆盖本次保存;登记后发布前重放,新值不丢
  annotationBuilds.get(workspaceRoot)?.pendingFileEvents.push({ kind: 'save', filePath, source });
  const cached = returnAnnotationCaches.get(workspaceRoot);
  if (!cached) { return; }
  cached.fileBuckets.set(filePath, extractFileReturnAnnotations(source));
  cached.index = mergeAnnotationBuckets(cached.fileBuckets);
}

/**
 * IDE-HOV-014:删除文件时移除该文件注解桶——弃桶后纯内存重合并,该来源
 * 注解不再可查,其他文件同名方法来源仍按原次序兜底。冷缓存与不在册路径
 * 均为 no-op:下一次查询按磁盘真值全量建,不虚建部分索引;首扫在途
 * (2026-10-28 审核整改)记入待重放事件,发布前弃桶,已删文件注解不驻留。
 */
export function removeSavedFileAnnotations(
  workspaceRoot: string | null,
  filePath: string
): void {
  if (!workspaceRoot) { return; }
  // IDE-REV-007:在途重建一律登记删除事件——仅弃已发布桶时,重建的扫描期
  // 旧读会在发布时把已删来源复活;登记后发布前重放弃桶,来源不驻留
  annotationBuilds.get(workspaceRoot)?.pendingFileEvents.push({ kind: 'delete', filePath });
  const cached = returnAnnotationCaches.get(workspaceRoot);
  if (!cached) { return; }
  if (!cached.fileBuckets.delete(filePath)) { return; }
  cached.index = mergeAnnotationBuckets(cached.fileBuckets);
}

/**
 * IDE-HOV-015:重命名文件时迁移注解来源——旧键桶原位换新键(保插入序,
 * 先见优先语义不因重命名洗牌),内容承接不丢、不留下双份。冷缓存与不在册
 * 路径均为 no-op:下一次查询按磁盘真值全量建;首扫在途(2026-10-28 审核
 * 整改)记入待重放事件,发布时对扫描收集的桶迁键,import 绑定按新模块命中。
 */
export function renameSavedFileAnnotations(
  workspaceRoot: string | null,
  oldFilePath: string,
  newFilePath: string
): void {
  if (!workspaceRoot) { return; }
  // IDE-REV-008:在途重建一律登记迁移事件——仅迁已发布桶时,重建的扫描期
  // 旧读会在发布时把旧键带回来;发布前重放迁键,旧模块不命中、新模块可查
  annotationBuilds.get(workspaceRoot)?.pendingFileEvents.push({ kind: 'rename', oldFilePath, newFilePath });
  const cached = returnAnnotationCaches.get(workspaceRoot);
  if (!cached) { return; }
  if (!cached.fileBuckets.has(oldFilePath)) { return; }
  const renamed = new Map<string, PythonReturnAnnotationIndex>();
  for (const [key, bucket] of cached.fileBuckets) {
    renamed.set(key === oldFilePath ? newFilePath : key, bucket);
  }
  cached.fileBuckets = renamed;
  cached.index = mergeAnnotationBuckets(renamed);
}

const returnAnnotationCaches = new Map<string, ReturnAnnotationCacheEntry>();
type AnnotationCancellation = { readonly isCancellationRequested: boolean };
/** 首扫在途窗口内到达的文件事件(2026-10-28 审核整改):发布前重放,
 * 扫描期读到的旧内容不再吞掉窗口内的保存/删除/重命名。 */
type PendingFileEvent =
  | { kind: 'save'; filePath: string; source: string }
  | { kind: 'delete'; filePath: string }
  | { kind: 'rename'; oldFilePath: string; newFilePath: string };
interface AnnotationBuild {
  waiters: Set<{ token?: AnnotationCancellation }>;
  promise: Promise<PythonReturnAnnotationIndex>;
  pendingFileEvents: PendingFileEvent[];
  /** 共享取消令牌(IDE-REV-029 量规的取消归属面):全体等待者取消才取消 */
  sharedToken: AnnotationCancellation;
}
const annotationBuilds = new Map<string, AnnotationBuild>();

/** 残留任务量规(P0-4b 审核重开 2026-10-28):编辑路径去抖在途的文档注解
 * 更新数——现场验收观测取消/风暴后无未泄残留的只读面。
 * IDE-REV-028(2026-10-30):待处理量覆盖 pending(去抖排队)与 inflight
 * (异步提取执行中)两面——门住提取时仍显示在途,不再只看去抖队列。 */
export function getPendingDocumentUpdateCount(): number {
  return pendingDocumentUpdates.size + inflightDocumentUpdates.size;
}

/** 执行中(inflight)文档注解更新数(IDE-REV-028):按文件计——异步提取
 * 真正执行中的文件数,与去抖排队面分开可观测。 */
export function getInflightDocumentUpdateCount(): number {
  return inflightDocumentUpdates.size;
}

/**
 * 注解索引共享构建的在途量(IDE-REV-029,原 IDE-MET-008):冷构建与 TTL
 * 过期重建都走共享构建(annotationBuilds)——running=执行中的共享构建数
 * (按工作区计);waiting=搭这些共享构建的请求数(等待面);cancelled=
 * 全体等待者都已取消、正在收尾的共享构建数(取消归属:共享构建只认全体
 * 取消,单个请求取消不拖死构建)。发布(缓存落账)或取消收尾后归零。
 * 与 REV-028 的逐文件文档更新(请求独占任务)分开计量,不混账。
 */
export interface AnnotationBuildWorkload {
  running: number;
  waiting: number;
  cancelled: number;
}
export function getAnnotationBuildWorkload(): AnnotationBuildWorkload {
  let waiting = 0;
  let cancelled = 0;
  for (const build of annotationBuilds.values()) {
    waiting += build.waiters.size;
    if (build.sharedToken.isCancellationRequested) {
      cancelled += 1;
    }
  }
  return { running: annotationBuilds.size, waiting, cancelled };
}

/** IDE-REV-031:注解索引缓存容量面——按工作区根每根一份,TTL 过期重建;
 * 无条目上限(条目数受工作区根数约束)、无字节占用量可取,口径如实注明,
 * 不臆造字节估算。 */
export function getReturnAnnotationCacheGauge(): { entries: number; ttlMs: number } {
  return { entries: returnAnnotationCaches.size, ttlMs: INDEX_TTL_MS };
}

/** 测试用:清全部工作区缓存(换临时根/改文件后立即生效) */
export function resetPythonReturnAnnotationCache(): void {
  returnAnnotationCaches.clear();
  annotationBuilds.clear();
  documentAnnotationBuckets.clear();
  for (const pending of pendingDocumentUpdates.values()) {
    clearTimeout(pending.timer);
  }
  pendingDocumentUpdates.clear();
  inflightDocumentUpdates.clear();
  documentBucketGenerations.clear();
}

/**
 * IDE-HOV-011 按文档版本更新的当前文件注解桶:打开文档未保存的返回注解
 * 变化按版本立即生效(同文件优先于磁盘索引;「def 在而注解缺」遮蔽磁盘
 * 同名旧注解,不借旧值)。桶只由文档版本驱动:版本前进才重提取,旧版本/
 * 同版本不得覆盖新版本;关闭文档弃桶回到磁盘口径(未保存修改随关闭消失)。
 */
export interface DocumentAnnotationBucket {
  version: number;
  annotations: PythonReturnAnnotationIndex;
  /** def 存在但无返回注解的方法名:遮蔽磁盘索引同名的旧注解 */
  unannotatedNames: Set<string>;
}

const documentAnnotationBuckets = new Map<string, Map<string, DocumentAnnotationBucket>>();

export interface DocumentAnnotationContext {
  /** 文档身份(URI 串):hover/保存/关闭事件共用同一键 */
  fileKey: string;
  /** 文档版本:递增才重提取;旧版本不得覆盖新版本 */
  version: number;
  /** 惰性取文档全文:仅在版本前进需要重提取时调用一次 */
  source: () => string;
}

/** 按文档版本更新该文件桶;同版本幂等,旧版本不覆盖新版本。 */
export function updateDocumentReturnAnnotations(
  workspaceRoot: string | null,
  context: DocumentAnnotationContext
): void {
  if (!workspaceRoot) { return; }
  let rootBuckets = documentAnnotationBuckets.get(workspaceRoot);
  if (!rootBuckets) {
    rootBuckets = new Map();
    documentAnnotationBuckets.set(workspaceRoot, rootBuckets);
  }
  const existing = rootBuckets.get(context.fileKey);
  if (existing && context.version <= existing.version) { return; }
  const annotations: PythonReturnAnnotationIndex = new Map();
  const unannotatedNames = new Set<string>();
  collectFileAnnotationFacts(context.source(), (name, annotation) => {
    if (annotation === null) { unannotatedNames.add(name); }
    else { annotations.set(name, annotation); }
  });
  rootBuckets.set(context.fileKey, { version: context.version, annotations, unannotatedNames });
}

/**
 * 关闭文档弃桶:未保存修改不再遮蔽磁盘口径。2026-10-28 审核整改:同时
 * 取消该文件的在途/待冲刷注解更新(否则关闭后异步提取落桶,复活已弃桶)。
 */
export function releaseDocumentReturnAnnotations(workspaceRoot: string | null, fileKey: string): void {
  if (!workspaceRoot) { return; }
  documentBucketGenerations.set(fileKey, (documentBucketGenerations.get(fileKey) ?? 0) + 1);
  const pending = pendingDocumentUpdates.get(fileKey);
  if (pending) {
    clearTimeout(pending.timer);
    pendingDocumentUpdates.delete(fileKey);
  }
  documentAnnotationBuckets.get(workspaceRoot)?.delete(fileKey);
}

// ====== 2026-10-28 审核整改(HOV-011):编辑事件注解提取移出同步路径 ======
// 每个 onDidChangeTextDocument 事件此前同步整文件提取(889KB ≈ 120ms 阻塞
// 事件循环)。改为:同文件按最新版本合并(旧版本事件覆盖不提取),宏任务
// 冲刷时用让出式异步提取(collectFileAnnotationFactsAsync,按字符预算
// setImmediate 让出),版本/关闭竞态由版本闸+文档代际守卫兜住。
const pendingDocumentUpdates = new Map<string, {
  workspaceRoot: string;
  version: number;
  source: () => string;
  timer: NodeJS.Timeout;
}>();
const inflightDocumentUpdates = new Map<string, Promise<void>>();
const documentBucketGenerations = new Map<string, number>();

/** 编辑面入口:排队(同文件合并到最新版本),宏任务后异步提取,不阻塞编辑同步路径 */
export function queueDocumentReturnAnnotations(
  workspaceRoot: string | null,
  context: DocumentAnnotationContext
): void {
  if (!workspaceRoot) { return; }
  const key = context.fileKey;
  const pending = pendingDocumentUpdates.get(key);
  if (pending) {
    pending.version = context.version;
    pending.source = context.source;
    return; // 已有定时器在途:合并到最新版本,不重复提取旧版本
  }
  const entry = {
    workspaceRoot,
    version: context.version,
    source: context.source,
    timer: undefined as unknown as NodeJS.Timeout
  };
  entry.timer = setTimeout(() => {
    pendingDocumentUpdates.delete(key);
    scheduleInflight(entry.workspaceRoot, key, entry.version, entry.source);
  }, 0);
  pendingDocumentUpdates.set(key, entry);
}

/** 测试面(IDE-REV-028):门住异步提取的确定性在途窗口——每笔提取发起前
 * 调一次,返回的 promise 放行才继续。生产恒 null(零行为变化)。 */
let documentExtractionGateForTests: (() => Promise<void>) | null = null;
export function setDocumentExtractionGateForTests(gate: (() => Promise<void>) | null): void {
  documentExtractionGateForTests = gate;
}

function scheduleInflight(
  workspaceRoot: string,
  fileKey: string,
  version: number,
  source: () => string
): void {
  const extraction = (async (): Promise<void> => {
    if (documentExtractionGateForTests) {
      await documentExtractionGateForTests();
    }
    await updateDocumentReturnAnnotationsAsync(workspaceRoot, { fileKey, version, source });
  })().catch(() => {});
  inflightDocumentUpdates.set(fileKey, extraction);
  void extraction.finally(() => {
    // IDE-REV-028:旧任务的 finally 不删除同文件新任务的在途记录——同文件
    // 重叠版本各归各:只有记录仍属于本任务才删,新版本已接管则留给它自己。
    if (inflightDocumentUpdates.get(fileKey) === extraction) {
      inflightDocumentUpdates.delete(fileKey);
    }
  });
}

/** 让出式异步提取:按字符预算让出事件循环(大文件不再整段阻塞宿主) */
export async function updateDocumentReturnAnnotationsAsync(
  workspaceRoot: string | null,
  context: DocumentAnnotationContext
): Promise<void> {
  if (!workspaceRoot) { return; }
  const generation = documentBucketGenerations.get(context.fileKey) ?? 0;
  const existing = documentAnnotationBuckets.get(workspaceRoot)?.get(context.fileKey);
  if (existing && context.version <= existing.version) { return; }
  const annotations: PythonReturnAnnotationIndex = new Map();
  const unannotatedNames = new Set<string>();
  await collectFileAnnotationFactsAsync(context.source(), (name, annotation) => {
    if (annotation === null) { unannotatedNames.add(name); }
    else { annotations.set(name, annotation); }
  });
  if ((documentBucketGenerations.get(context.fileKey) ?? 0) !== generation) {
    return; // 提取期间文档已关:弃桶不复活
  }
  let rootBuckets = documentAnnotationBuckets.get(workspaceRoot);
  if (!rootBuckets) {
    rootBuckets = new Map();
    documentAnnotationBuckets.set(workspaceRoot, rootBuckets);
  }
  const after = rootBuckets.get(context.fileKey);
  if (after && context.version <= after.version) { return; } // 期间已入更新版本
  rootBuckets.set(context.fileKey, { version: context.version, annotations, unannotatedNames });
}

/** 测试面:冲刷全部待更新并等异步提取完成(同步断言口径) */
export async function flushPendingDocumentReturnAnnotationsForTests(): Promise<void> {
  for (const [key, entry] of [...pendingDocumentUpdates.entries()]) {
    pendingDocumentUpdates.delete(key);
    clearTimeout(entry.timer);
    scheduleInflight(entry.workspaceRoot, key, entry.version, entry.source);
  }
  await Promise.all([...inflightDocumentUpdates.values()]);
}

/** 悬停文档自己的桶(最优先)之外,其余打开文档的桶按 fileKey 序合并(先见优先)。 */
function mergedOtherDocumentAnnotations(
  workspaceRoot: string,
  hoveredFileKey: string | null
): { annotations: PythonReturnAnnotationIndex; shadowedNames: Set<string> } {
  const annotations: PythonReturnAnnotationIndex = new Map();
  const shadowedNames = new Set<string>();
  const rootBuckets = documentAnnotationBuckets.get(workspaceRoot);
  if (!rootBuckets) { return { annotations, shadowedNames }; }
  for (const fileKey of [...rootBuckets.keys()].sort()) {
    const bucket = rootBuckets.get(fileKey)!;
    if (fileKey === hoveredFileKey) {
      for (const name of bucket.unannotatedNames) { shadowedNames.add(name); }
      continue;
    }
    for (const [name, annotation] of bucket.annotations) {
      if (!annotations.has(name)) { annotations.set(name, annotation); }
    }
    for (const name of bucket.unannotatedNames) { shadowedNames.add(name); }
  }
  return { annotations, shadowedNames };
}

async function getReturnAnnotationIndex(workspaceRoot: string, token?: AnnotationCancellation): Promise<PythonReturnAnnotationIndex> {
  const now = Date.now();
  const cached = returnAnnotationCaches.get(workspaceRoot);
  if (cached && now - cached.builtAtMs < INDEX_TTL_MS) {
    return cached.index;
  }
  let build = annotationBuilds.get(workspaceRoot);
  if (!build) {
    const waiters = new Set<{ token?: AnnotationCancellation }>();
    const sharedToken = { get isCancellationRequested() {
      return waiters.size === 0 || [...waiters].every(waiter => waiter.token?.isCancellationRequested === true);
    } };
    const entry: AnnotationBuild = {
      waiters,
      promise: Promise.resolve().then(() => buildReturnAnnotationIndexForRoot(workspaceRoot, sharedToken, entry)),
      pendingFileEvents: [],
      sharedToken
    };
    annotationBuilds.set(workspaceRoot, entry);
    build = entry;
  }
  const waiter = { token };
  build.waiters.add(waiter);
  try {
    return await build.promise;
  } finally {
    build.waiters.delete(waiter);
    if (annotationBuilds.get(workspaceRoot) === build) annotationBuilds.delete(workspaceRoot);
  }
}

async function buildReturnAnnotationIndexForRoot(workspaceRoot: string, token: AnnotationCancellation, build: AnnotationBuild): Promise<PythonReturnAnnotationIndex> {
  const files = await collectProjectPythonFilesAsync(workspaceRoot, 20000, token);
  if (token.isCancellationRequested) return new Map();
  const sources = new Array<string>(files.length).fill('');
  let nextFile = 0;
  const readWorker = async (): Promise<void> => {
    while (!token.isCancellationRequested && nextFile < files.length) {
      const i = nextFile++;
      try {
        sources[i] = await fs.promises.readFile(files[i], 'utf8');
      } catch {
        // 单个不可读文件不影响其他文件。
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(ANNOTATION_READ_CONCURRENCY, files.length) }, readWorker));
  if (token.isCancellationRequested) return new Map();
  let fileBuckets = new Map<string, PythonReturnAnnotationIndex>();
  for (let i = 0; i < files.length; i += 1) {
    if (token.isCancellationRequested) return new Map();
    fileBuckets.set(files[i], await extractFileReturnAnnotationsAsync(sources[i]));
  }
  // 2026-10-28 审核整改:首扫在途窗口内的文件事件在发布前按到达序重放
  // (保存换桶/删除弃桶/重命名迁键),扫描期旧读不吞掉窗口内的新状态。
  for (const event of build.pendingFileEvents) {
    if (event.kind === 'save') {
      fileBuckets.set(event.filePath, extractFileReturnAnnotations(event.source));
    } else if (event.kind === 'delete') {
      fileBuckets.delete(event.filePath);
    } else if (fileBuckets.has(event.oldFilePath)) {
      const renamed = new Map<string, PythonReturnAnnotationIndex>();
      for (const [key, bucket] of fileBuckets) {
        renamed.set(key === event.oldFilePath ? event.newFilePath : key, bucket);
      }
      fileBuckets = renamed;
    }
  }
  const index = mergeAnnotationBuckets(fileBuckets);
  if (annotationBuilds.get(workspaceRoot) === build) {
    returnAnnotationCaches.set(workspaceRoot, { builtAtMs: Date.now(), index, fileBuckets });
  }
  return index;
}

/** 推导结果:注解串 + 来源方法名(hover 标注「推导自 get_data() 返回注解」) */
export interface LocalVariableReturnType {
  target: string;
  annotation: string;
  methodName: string;
}

/** IDE-HOV-017:文件级显式 import 绑定——`from X import n [as a]` 绑定名 n/a
 * 到模块 X;`import X [as Y]` 绑定接收者 Y/X 到模块 X(供 `X.fn()` 用)。
 * 通配 `import *` 非显式绑定,不参与;相对导入的前导点按后缀匹配近似。 */
interface FileImportBindings {
  names: Map<string, string>;
  receivers: Map<string, string>;
}

const FROM_IMPORT_PATTERN = /^\s*from\s+([.\w]+)\s+import\s+([^#]*?)(?:#.*)?$/;
/** `import X` / `import pkg.good as g`:模块可点分(2026-10-28 审核整改,
 * 子模块别名也是合法绑定,漏认会回退全局同名方法给出错误注解)。 */
const BARE_IMPORT_PATTERN =
  /^\s*import\s+([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)(?:\s+as\s+([A-Za-z_]\w*))?\s*(?:#.*)?$/;
const IMPORT_ALIAS_PATTERN = /^([A-Za-z_]\w*)(?:\s+as\s+([A-Za-z_]\w*))?$/;

function extractFileImports(lines: readonly string[]): FileImportBindings {
  const names = new Map<string, string>();
  const receivers = new Map<string, string>();
  for (const raw of lines) {
    const line = raw ?? '';
    const from = FROM_IMPORT_PATTERN.exec(line);
    if (from) {
      const module = from[1].replace(/^[.]+/, '').replace(/\./g, '/');
      if (!module || from[2].includes('*')) { continue; }
      for (const part of from[2].split(',')) {
        const alias = IMPORT_ALIAS_PATTERN.exec(part.trim());
        if (alias) { names.set(alias[2] ?? alias[1], module); }
      }
      continue;
    }
    const bare = BARE_IMPORT_PATTERN.exec(line);
    if (bare) {
      // Python 绑定名=别名(有则)否则首段;别名绑到完整子模块路径
      // (pkg.good → pkg/good),无别名时维持单段 `import pkg` 语义。
      const dotted = bare[1];
      const firstSegment = dotted.split('.')[0];
      const boundName = bare[2] ?? firstSegment;
      const module = bare[2] !== undefined ? dotted.replace(/\./g, '/') : firstSegment;
      receivers.set(boundName, module);
    }
  }
  return { names, receivers };
}

/** 模块 → 唯一匹配的文件桶;找不到或多处同名模块均为 null(无法确定 → 未知)。 */
function locateModuleBucket(
  fileBuckets: Map<string, PythonReturnAnnotationIndex>,
  module: string
): PythonReturnAnnotationIndex | null {
  const suffix = `${module}.py`;
  let found: PythonReturnAnnotationIndex | null = null;
  for (const [filePath, bucket] of fileBuckets) {
    const normalized = filePath.replace(/\\/g, '/');
    if (normalized !== suffix && !normalized.endsWith(`/${suffix}`)) { continue; }
    if (found) { return null; }
    found = bucket;
  }
  return found;
}

/**
 * IDE-HOV-016:自 hover 行向上找赋值,只在未跨出作用域前有效——上行路上
 * 每跨过一条 `def`/`class` 头(缩进 i),其上缩进 ≥ i+1 的赋值即属别的
 * 作用域(兄弟方法/被嵌套函数),不再借用;模块级(缩进 0)赋值不受限
 * (Python 全局读语义)。作用域内的同名重赋值仍按原次序全量收集。
 */
function matchingAssignments(lines: readonly string[], hoverLine: number, word: string): LocalAssignmentCall[] {
  const candidates: LocalAssignmentCall[] = [];
  let scopeIndentLimit = Number.POSITIVE_INFINITY;
  for (let line = Math.min(hoverLine, lines.length - 1); line >= 0; line -= 1) {
    const text = lines[line] ?? '';
    const indent = text.length - text.trimStart().length;
    if (indent < scopeIndentLimit) {
      const assignment = parseLocalAssignmentCall(text);
      if (assignment?.target === word) candidates.push(assignment);
    }
    const scopeHeader = /^\s*(?:async\s+def|def|class)\s/.exec(text);
    if (scopeHeader) {
      scopeIndentLimit = Math.min(scopeIndentLimit, indent + 1);
    }
  }
  return candidates;
}

function resolveFromAnnotationIndex(candidates: readonly LocalAssignmentCall[], word: string, index: PythonReturnAnnotationIndex): LocalVariableReturnType | null {
  for (const assignment of candidates) {
    const annotation = index.get(assignment.methodName);
    if (annotation && annotation !== 'Any') return { target: word, annotation, methodName: assignment.methodName };
  }
  return null;
}

/** 交互查询只读已发布快照；冷查询和过期快照触发后台重建。文档桶(IDE-HOV-011)
 * 先于磁盘索引:悬停文档自己的桶最优先,其余打开文档的桶次之,被「注解已删」
 * 遮蔽的名字不再从磁盘旧值借。 */
export function resolveLocalVariableReturnTypeFromSnapshot(
  lines: readonly string[],
  hoverLine: number,
  word: string,
  workspaceRoot: string | null,
  documentContext?: DocumentAnnotationContext
): LocalVariableReturnType | null {
  // IDE-RST-009:查询段耗时(python-annotation-query)——普通变量 hover 的
  // 注解路径全量计入(含无候选早退),真实查询口径不做旁路
  const queryStartedAt = performance.now();
  try {
    return resolveLocalVariableReturnTypeFromSnapshotImpl(lines, hoverLine, word, workspaceRoot, documentContext);
  } finally {
    recordLanguageServiceOperation('python-annotation-query', performance.now() - queryStartedAt, {
      fileKind: 'python'
    });
  }
}

function resolveLocalVariableReturnTypeFromSnapshotImpl(
  lines: readonly string[],
  hoverLine: number,
  word: string,
  workspaceRoot: string | null,
  documentContext?: DocumentAnnotationContext
): LocalVariableReturnType | null {
  if (!workspaceRoot || !word || /^[A-Z_][A-Z0-9_]*$/.test(word)) return null;
  const candidates = matchingAssignments(lines, hoverLine, word);
  if (candidates.length === 0) return null;
  // 2026-10-28 审核整改(HOV-009):先查赋值候选——无候选的 hover 不做全文
  // 注解提取(此前先更新桶再查候选,无赋值词的 hover 也白做全文件提取)。
  // IDE-REV-010:首次 hover 不做同步整文件提取——本查询只读已发布桶;桶
  // 版本落后(首次/编辑后)交给受控异步更新发布(queueDocumentReturnAnnotations
  // 同文件合并到最新版本、让出式提取、版本/关闭竞态守卫),发布后下次查询
  // 可见;冷版本本轮回级联(其余打开文档桶→磁盘新鲜索引),不等待发布。
  if (documentContext) {
    queueDocumentReturnAnnotations(workspaceRoot, documentContext);
  }
  const hoveredBucket = documentContext
    ? documentAnnotationBuckets.get(workspaceRoot)?.get(documentContext.fileKey)
    : undefined;
  const { annotations: otherAnnotations, shadowedNames } = mergedOtherDocumentAnnotations(
    workspaceRoot,
    hoveredBucket ? documentContext!.fileKey : null
  );
  const cached = returnAnnotationCaches.get(workspaceRoot);
  // 2026-10-28 审核整改:TTL 过期检查必须在命中之前——过期索引不再答磁盘
  // 旧注解(原检查放在级联命中返回之后,过期旧值可无限命中)。
  const diskIndexFresh = cached !== undefined && Date.now() - cached.builtAtMs < INDEX_TTL_MS;
  // 三段级联(单名):悬停文档桶 → 其余打开文档桶 → 磁盘已发布索引(仅新鲜;遮蔽名不借)
  // IDE-REV-037:级联各层答话时把所用来源落日志(验收「日志明确所用来源」)
  const cascadeAnnotation = (methodName: string): { annotation: string; source: string } | null => {
    const fromHovered = hoveredBucket?.annotations.get(methodName);
    if (fromHovered && fromHovered !== 'Any') { return { annotation: fromHovered, source: 'hovered-document' }; }
    const fromOthers = otherAnnotations.get(methodName);
    if (fromOthers && fromOthers !== 'Any') { return { annotation: fromOthers, source: 'other-document' }; }
    if (shadowedNames.has(methodName)) { return null; }
    const fromDisk = diskIndexFresh ? cached!.index.get(methodName) : undefined;
    if (fromDisk && fromDisk !== 'Any') { return { annotation: fromDisk, source: 'disk-snapshot' }; }
    return null;
  };
  // IDE-HOV-017:显式 import 绑定的候选只解析到对应模块的文件桶;
  // 绑定模块无注解、模块文件找不到或多处同名(无法确定)都不回退全局。
  const bindings = extractFileImports(lines);
  for (const assignment of candidates) {
    const module = assignment.receiver
      ? bindings.receivers.get(assignment.receiver)
      : bindings.names.get(assignment.methodName);
    if (module !== undefined) {
      const bucket = diskIndexFresh ? locateModuleBucket(cached!.fileBuckets, module) : null;
      const annotation = bucket?.get(assignment.methodName);
      if (annotation && annotation !== 'Any') {
        annotationSourceLog('info', () =>
          `hover-resolve word=${word} method=${assignment.methodName} source=disk-snapshot(import) module=${module}`
        );
        return { target: word, annotation, methodName: assignment.methodName };
      }
      continue;
    }
    const resolved = cascadeAnnotation(assignment.methodName);
    if (resolved) {
      annotationSourceLog('info', () =>
        `hover-resolve word=${word} method=${assignment.methodName} source=${resolved.source}`
      );
      return { target: word, annotation: resolved.annotation, methodName: assignment.methodName };
    }
  }
  if (!cached || Date.now() - cached.builtAtMs >= INDEX_TTL_MS) {
    // IDE-REV-037:过期/冷盘未命中在日志里明确——不借旧值答话,受控重建
    // 异步排队,新快照发布后恢复命中。
    annotationSourceLog('info', () =>
      `hover-miss word=${word} disk-index=${cached ? 'expired' : 'cold'} rebuild=queued`
    );
    void getReturnAnnotationIndex(workspaceRoot).catch(() => {});
  }
  return null;
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
  workspaceRoot: string | null,
  token?: { readonly isCancellationRequested: boolean }
): Promise<LocalVariableReturnType | null> | null {
  if (!workspaceRoot || !word || /^[A-Z_][A-Z0-9_]*$/.test(word)) {
    return null;
  }
  const candidates = matchingAssignments(lines, hoverLine, word);
  if (candidates.length === 0) return null;
  return getReturnAnnotationIndex(workspaceRoot, token).then(index => {
    if (token?.isCancellationRequested) return null;
    return resolveFromAnnotationIndex(candidates, word, index);
  });
}
