// IDE-LINT-007:基于引擎属性表(EntityBuiltinProperty)的只读写入 lint——实体
// 脚本里对引擎内建只读属性(self.id / self.isDestroyed / self.className / 各
// 面只读项)的普通赋值 / 增强赋值 / 注解赋值 / del 报 Warning;合法可写属性
// (self.position / self.shouldAutoBackup 等)与普通 Python 同名字段(非实体
// 脚本)不报。
//
// 纯逻辑层,不 import vscode。实体身份与角色判定直接复用 entityBuiltinProperties
// 的面解析(resolveEntityComponentFaceFromPath / resolveEntityBuiltinPropertyHit),
// 与内建属性 hover / inlay 同一底座同一口径,不自创一套。
//
// 写入形态检测在 pythonLexicalMask 掩码文本上做(字符串/注释内容不误认),
// 只认单段 `self.<属性>` 整体作写目标:
//   - 普通赋值  self.<属性> = <值>
//   - 增强赋值  self.<属性> <augop>= <值>
//   - 注解赋值  self.<属性>: <类型> = <值>
//   - 删除      del self.<属性>
// 显式排除比较(==/!=/<=/>=)、海象(:=,属性目标非法)、属性续写(self.<p>.x,
// 不是重绑定)、下标写(self.<p>[i]=x,不是重绑定)与算术(self.<p> + x)。
// 已知边界(与同族 self-属性 lint 一致):嵌套非实体类内的同名 self.<p> 不
// 单列(文件级实体身份判定);`del (self.<p>)`/`del self.<p>, x` 的第二项不
// 报(括号/逗号前缀形态,罕见)。

import { maskPythonNonCode } from './pythonLexicalMask';
import { l10nText } from '../nlsRuntime';
import {
  resolveEntityBuiltinPropertyHit,
  resolveEntityComponentFaceFromPath,
  formatEntityBuiltinPropertyDetail,
  type EntityBuiltinPropertyHit,
  type EntityComponentFace
} from './entityBuiltinProperties';

export const READONLY_WRITE_DIAGNOSTIC_CODE = 'kbengine.readOnlyWrite';
export const READONLY_WRITE_DIAGNOSTICS_ENABLED_DEFAULT = true;

/** 写入形态(诊断文案与测试断言共用) */
export type ReadOnlyWriteKind = 'assign' | 'augmented' | 'annotated' | 'del';

const KIND_VERB: Record<ReadOnlyWriteKind, string> = {
  assign: 'plain assignment',
  augmented: 'augmented assignment',
  annotated: 'annotated assignment',
  del: 'deletion'
};

const AUGMENTED_OPS = new Set([
  '+=', '-=', '*=', '/=', '//=', '%=', '**=', '&=', '|=', '^=', '<<=', '>>=', '@='
]);

/** 消息模板单一来源(TS 渲染,Rust 只回结构面) */
export function renderReadOnlyWriteMessage(propertyName: string, hit: EntityBuiltinPropertyHit, kind: ReadOnlyWriteKind): string {
  return l10nText(
    'self.{property} read-only write: {property} is an engine built-in read-only property ({detail}; {source}); {verb} would be rejected by the engine',
    {
      property: propertyName,
      detail: formatEntityBuiltinPropertyDetail(hit.face, hit.property),
      source: hit.property.source,
      verb: l10nText(KIND_VERB[kind])
    }
  );
}

/** 引入复合语句套件(一行体 `:`)的语句头关键字 */
const COMPOUND_KEYWORDS = new Set([
  'if', 'elif', 'else', 'for', 'while', 'with', 'try', 'except', 'finally', 'def', 'class', 'match', 'case'
]);

/**
 * `:` 是否为复合语句套件冒号(if/for/while 等一行体的 body 分隔冒号)。
 * 判据:该冒号是所在简单语句内的**首个**括号深度 0 冒号,且该简单语句的
 * 起始关键字是复合语句头关键字。
 * - `if self.isDestroyed: self.counter = 0` → 冒号是首个深度0冒号且语句以
 *   `if` 起 → 套件冒号(体里的 `=` 属别的语句,不是注解赋值)。
 * - `def m(self): self.x: int = 0` → self.x 的冒号前已有深度0冒号(def 的
 *   套件冒号)→ 非套件冒号,是注解冒号(正确放行)。
 * - `self.x: int = 0` → 语句以 `self` 起,非复合关键字 → 非套件冒号。
 */
function isSuiteColon(line: string, colonIndex: number): boolean {
  let depth = 0;
  let i = colonIndex - 1;
  // 向左扫到简单语句边界(行首或括号深度 0 的 `;`);途中遇到深度 0 冒号
  // 说明我们的冒号不是语句内首个深度 0 冒号 → 非套件冒号。
  while (i >= 0) {
    const ch = line[i];
    if (ch === ')' || ch === ']' || ch === '}') { depth += 1; }
    else if (ch === '(' || ch === '[' || ch === '{') { depth -= 1; }
    else if (ch === ';' && depth === 0) { break; }
    else if (ch === ':' && depth === 0) { return false; }
    i -= 1;
  }
  // 语句起始(行首或 `;` 后)的第一个词是否为复合关键字。
  let j = i + 1;
  while (j < line.length && (line[j] === ' ' || line[j] === '\t')) { j += 1; }
  const start = j;
  while (j < line.length && /[A-Za-z_]/.test(line[j])) { j += 1; }
  return COMPOUND_KEYWORDS.has(line.slice(start, j));
}

/** 匹配的 `self.<name>` 之后同一行紧跟的运算符分类;null = 非写目标 */
function classifyWriteKindAfter(line: string, afterIndex: number): ReadOnlyWriteKind | null {
  let i = afterIndex;
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) { i += 1; }
  if (i >= line.length) { return null; }
  const c = line[i];
  if (c === '.') { return null; } // self.<p>.x:续写属性,不是重绑定
  if (c === '[') { return null; } // self.<p>[i]=x:下标写,不是重绑定
  if (c === '=') {
    if (line[i + 1] === '=') { return null; } // 比较 ==
    return 'assign'; // 普通赋值 =
  }
  if (c === ':') {
    if (line[i + 1] === '=') { return null; } // 海象 :=(属性目标非法,不写)
    // 复合语句套件冒号(if/for/while 一行体):体里的顶层 `=` 属体语句,
    // 不是对 `self.<p>` 的注解赋值(如 `if self.isDestroyed: self.counter = 0`)。
    if (isSuiteColon(line, i)) { return null; }
    // 注解赋值 `: <类型> =`:同层(括号深度 0)、同语句(`;` 前)找到 `=` 才算
    // 写目标;`if self.<p>:`(行尾)/切片 `d[self.<p>:2]`/字典 `{self.<p>: x}`
    // 都找不到顶层 `=` → 不写。
    let depth = 0;
    for (let j = i; j < line.length; j += 1) {
      const ch = line[j];
      if (ch === '(' || ch === '[' || ch === '{') { depth += 1; }
      else if (ch === ')' || ch === ']' || ch === '}') { depth -= 1; }
      else if (ch === ';' && depth === 0) { return null; } // 语句边界:注解的 `=` 不会在其后
      else if (ch === '=' && depth === 0 && line[j - 1] !== '=' && line[j + 1] !== '=' && line[j + 1] !== '>') {
        return 'annotated';
      }
    }
    return null;
  }
  const two = c + (line[i + 1] ?? '');
  if (AUGMENTED_OPS.has(two)) { return 'augmented'; }
  // 三字符增强赋值(**= //= <<= >>=):两字符前缀不在集合,再拼一位判定;
  // 旧实现只拼两字符永不命中,`self.id **= 1` 等漏检(审核发现修复)。
  if (AUGMENTED_OPS.has(two + (line[i + 2] ?? ''))) { return 'augmented'; }
  if (c === '<' || c === '>' || c === '!') { return null; } // <= >= !=
  return null; // 单目算术 + - * / % & | ^ @ << >> 等:值上下文,非写目标
}

/** 同一行 `self` 之前紧邻(隔空白)是否为 `del` 关键字(整词) */
function precededByDel(line: string, selfIndex: number): boolean {
  let i = selfIndex - 1;
  while (i >= 0 && (line[i] === ' ' || line[i] === '\t')) { i -= 1; }
  if (i < 0) { return false; }
  const end = i + 1;
  while (i >= 0 && /[A-Za-z_]/.test(line[i])) { i -= 1; }
  return line.slice(i + 1, end) === 'del';
}

/** 一处只读写入(诊断面所需最小信息) */
export interface ReadOnlyWriteFinding {
  /** 行(0 起) */
  line: number;
  /** `self` 起始列(0 起;高亮整个 `self.<name>`) */
  character: number;
  /** 高亮长度(`self.<name>` 全长) */
  length: number;
  propertyName: string;
  kind: ReadOnlyWriteKind;
  /** 生效面(null = 宏公共 3 域) */
  face: EntityComponentFace | null;
  hit: EntityBuiltinPropertyHit;
  message: string;
  severity: 'Warning';
  code: string;
}

/**
 * 只读写入判定(纯函数):掩码文本上扫单段 `self.<属性>`,写目标且命中只读
 * 内建属性表 → Warning;可写属性/非实体脚本(表未命中)跳过。
 * pathFace 与 defFaces 由调用方提供(与内建属性 hover 同源面判定)。
 */
export function findReadOnlyWriteFindings(
  text: string,
  pathFace: EntityComponentFace | null,
  defFaces: readonly EntityComponentFace[] | null
): ReadOnlyWriteFinding[] {
  const masked = maskPythonNonCode(text);
  const lines = masked.split(/\r?\n/);
  const findings: ReadOnlyWriteFinding[] = [];
  const pattern = /\bself\.(\w+)\b/g;

  for (let line = 0; line < lines.length; line += 1) {
    const lineText = lines[line];
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(lineText)) !== null) {
      const propertyName = match[1];
      const selfIndex = match.index;
      const afterIndex = selfIndex + match[0].length;
      // 续写(self.<p>.x)/下标写(self.<p>[i]=x)都不是重绑定 `self.<p>` 本身,
      // 一律先排除(del 路径也不放行——del self.<p>.x 删的是值的属性)。
      let afterFirst = afterIndex;
      while (afterFirst < lineText.length && (lineText[afterFirst] === ' ' || lineText[afterFirst] === '\t')) { afterFirst += 1; }
      if (afterFirst < lineText.length && (lineText[afterFirst] === '.' || lineText[afterFirst] === '[')) { continue; }
      let kind = classifyWriteKindAfter(lineText, afterIndex);
      if (kind === null && precededByDel(lineText, selfIndex)) {
        kind = 'del';
      }
      if (kind === null) { continue; }

      const hit = resolveEntityBuiltinPropertyHit(propertyName, pathFace, defFaces);
      if (!hit || !hit.property.readonly) { continue; }

      findings.push({
        line,
        character: selfIndex,
        length: match[0].length,
        propertyName,
        kind,
        face: hit.face,
        hit,
        severity: 'Warning',
        code: READONLY_WRITE_DIAGNOSTIC_CODE,
        message: renderReadOnlyWriteMessage(propertyName, hit, kind)
      });
    }
  }
  return findings;
}

/** 诊断项(纯数据;extension 侧转 vscode.Diagnostic,测试免 vscode 依赖) */
export interface ReadOnlyWriteDiagnosticItem {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  message: string;
  severity: 'Warning';
  source: 'kbengine';
  code: string;
}

/**
 * 异步入口:pathFace 按目录域定面;pathFace 判不出时经 fetchDefFaces(通常
 * entityMappingManager.getEntityComponentFacesForPythonFile)取 def 归属面
 * (与内建属性 inlay provider 同源),失败按 null 兜底(非实体 → 零产出)。
 * enabled=false 零产出。
 */
export async function readOnlyWriteDiagnosticItemsAsync(
  text: string,
  filePath: string,
  fetchDefFaces: () => Promise<readonly EntityComponentFace[] | null>,
  enabled: boolean
): Promise<ReadOnlyWriteDiagnosticItem[]> {
  if (!enabled) { return []; }
  const pathFace = resolveEntityComponentFaceFromPath(filePath);
  let defFaces: readonly EntityComponentFace[] | null = null;
  if (!pathFace) {
    try {
      defFaces = await fetchDefFaces();
    } catch {
      defFaces = null;
    }
  }
  return findReadOnlyWriteFindings(text, pathFace, defFaces).map(finding => ({
    range: {
      start: { line: finding.line, character: finding.character },
      end: { line: finding.line, character: finding.character + finding.length }
    },
    message: finding.message,
    severity: 'Warning' as const,
    source: 'kbengine' as const,
    code: finding.code
  }));
}

// ---- Rust 面(AUDIT-005 B2 车道批 5:readOnlyWrite 收编) -----------------------
// `$/kode/lint/analyzeReadOnlyWrite` 经 gate.runInRust(与 analyzeReceiverNone/
// analyzePostDestroy 同口径):Rust 只回结构面(line/character/length/
// propertyName/kind),只读属性闸由 TS 供给 readonlyNames 集(face 表 readonly
// 名集);消息渲染与引擎取证留本模块(l10n 单一来源)——TS 侧经
// resolveEntityBuiltinPropertyHit 重解析作完整性校验,不命中/非只读 = 语义
// 矛盾整面作废(禁止部分采用)。对拍测试共用。

const KIND_SET = new Set<string>(['assign', 'augmented', 'annotated', 'del']);
const PROPERTY_NAME_PATTERN = /^[A-Za-z_]\w*$/;
const SELF_DOT_LENGTH = 'self.'.length;

/**
 * 结构面数组 → 诊断面数组(属性表重解析 + 消息渲染);任一条畸形或属性表
 * 重解析矛盾(未命中/非只读)返回 null(整面作废,调用方回 TS 兜底 —— 禁止
 * 部分采用)。对拍测试共用。
 */
export function renderRustReadOnlyWriteItems(
  items: readonly unknown[],
  pathFace: EntityComponentFace | null,
  defFaces: readonly EntityComponentFace[] | null
): ReadOnlyWriteDiagnosticItem[] | null {
  const rendered: ReadOnlyWriteDiagnosticItem[] = [];
  for (const item of items) {
    if (item === null || typeof item !== 'object') {
      return null;
    }
    const record = item as Record<string, unknown>;
    if (record.code !== READONLY_WRITE_DIAGNOSTIC_CODE) {
      return null;
    }
    const kind = record.kind;
    if (typeof kind !== 'string' || !KIND_SET.has(kind)) {
      return null;
    }
    const propertyName = record.propertyName;
    if (typeof propertyName !== 'string' || !PROPERTY_NAME_PATTERN.test(propertyName)) {
      return null;
    }
    const length = record.length;
    if (typeof length !== 'number' || !Number.isInteger(length) || length !== SELF_DOT_LENGTH + propertyName.length) {
      return null;
    }
    for (const value of [record.line, record.character]) {
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
        return null;
      }
    }
    const hit = resolveEntityBuiltinPropertyHit(propertyName, pathFace, defFaces);
    if (!hit || !hit.property.readonly) {
      return null; // Rust 只读闸放行的名字属性表不认 = 契约漂移,整面作废
    }
    const line = record.line as number;
    const character = record.character as number;
    rendered.push({
      range: {
        start: { line, character },
        end: { line, character: character + length }
      },
      message: renderReadOnlyWriteMessage(propertyName, hit, kind as ReadOnlyWriteKind),
      severity: 'Warning',
      source: 'kbengine',
      code: READONLY_WRITE_DIAGNOSTIC_CODE
    });
  }
  return rendered;
}
