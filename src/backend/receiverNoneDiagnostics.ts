import type { EntityMapping } from '../entityMapping';
import { pythonScriptDomain } from '../entityMapping';
import { l10nText } from '../nlsRuntime';
import {
  PYTHON_RECEIVER_SECTIONS,
  findPythonReceiverCalls,
  pythonReceiverSectionFor,
  type PythonCallerFace,
  type PythonReceiverCall
} from './pythonLanguageUtils';
import { parsePythonFile } from './pythonParser';
import { parsePythonFileResponsive } from './pythonParserWorkerHost';
import { maskPythonNonCode } from './pythonLexicalMask';

/**
 * receiver 可能为 None 的诊断(用户令 2026-10-27,任务1):
 * self.client/self.cell/self.base 是引擎 EntityCall getter,引用为空直接返回
 * None(server/baseapp/entity.cpp:800 pyGetClientEntityCall、:750
 * pyGetCellEntityCall、cellapp/entity.cpp:74),玩家离线/掉线
 * (onClientDeath、onLoseCell → S_RELEASE)后即为 None。kode 已建模
 * Union[EntityCall, None](entityBuiltinProperties.ts),hover/实参 inlay 都有,
 * 此处补诊断面:无判空 guard 的成员调用/属性访问报 Warning;.def 段错配同源
 * 可报(经 self.cell 调 ClientMethods 声明的方法)。guard 分析用 in-tree
 * pythonParser 定方法界,行文本做形态判定(与 CodeLens 镜链同口径)。
 */

export const RECEIVER_NONE_DIAGNOSTICS_ENABLED_DEFAULT = true;

/**
 * 诊断稳定 code(B-7,2026-10-29):快速修复与诊断按 code 对账(与
 * kbengine.unknownType 同款纪律)——守卫 QuickFix 只吃 receiver-none 码,
 * 段错配是路由问题不是判空问题,不出守卫动作。
 */
export const RECEIVER_NONE_DIAGNOSTIC_CODE = 'kbengine.receiverNone';
export const RECEIVER_SECTION_MISMATCH_DIAGNOSTIC_CODE = 'kbengine.sectionMismatch';

/** 引擎源码引用(随诊断消息携带,给「为什么可能是 None」的直接证据) */
export const RECEIVER_NONE_SOURCES: Record<PythonReceiverCall['receiver'], string> = {
  client: 'server/baseapp/entity.cpp:800 pyGetClientEntityCall',
  cell: 'server/baseapp/entity.cpp:750 pyGetCellEntityCall',
  base: 'server/cellapp/entity.cpp:74 pyGetBaseEntityCall'
};

/** receiver-none 消息(单一来源:TS 同步/异步面与 Rust 结构面渲染共用) */
export function renderReceiverNoneMessage(receiver: PythonReceiverCall['receiver']): string {
  return l10nText(
    'self.{receiver} may be None (the engine returns None directly once the player goes offline/disconnects, onClientDeath/onLoseCell → S_RELEASE); check for None before use; engine source: {source}',
    { receiver, source: RECEIVER_NONE_SOURCES[receiver] }
  );
}

export interface ReceiverNoneFinding {
  /** 0 起行(方法名 token 所在行) */
  line: number;
  /** 0 起列(方法名 token 起) */
  character: number;
  receiver: PythonReceiverCall['receiver'];
  methodName: string;
  kind: 'receiver-none' | 'section-mismatch';
  message: string;
}

const COMMENT_ONLY = /^\s*(#.*)?$/;

const escapeSubject = (subject: string): string => subject.replace(/\./g, '\\.');
const unescapeSubject = (subject: string): string => subject.replace(/\\\./g, '.');

/**
 * IDE-LINT-002:if 头条件提取(掩码行:字符串/注释已空白)。从 `if` 后扫到
 * 括号深度 0 的首个 `:`——下标切片等代码内冒号不截断条件。
 */
function extractIfHeader(line: string): { condition: string; bodyStart: number } | null {
  const match = /^\s*if\s+/.exec(line);
  if (!match) { return null; }
  let depth = 0;
  for (let i = match[0].length; i < line.length; i += 1) {
    const char = line[i];
    if (char === '(' || char === '[' || char === '{') { depth += 1; continue; }
    if (char === ')' || char === ']' || char === '}') { depth = Math.max(0, depth - 1); continue; }
    if (char === ':' && depth === 0) {
      return { condition: line.slice(match[0].length, i).trim(), bodyStart: i + 1 };
    }
  }
  return null;
}

/** 剥最外层配对括号(`(a) and (b)` 的外括号不包全则原样返回) */
function stripOuterParens(expr: string): string {
  let current = expr.trim();
  while (current.startsWith('(') && current.endsWith(')')) {
    let depth = 0;
    let wraps = true;
    for (let i = 0; i < current.length; i += 1) {
      if (current[i] === '(') { depth += 1; } else if (current[i] === ')') {
        depth -= 1;
        if (depth === 0 && i < current.length - 1) { wraps = false; break; }
      }
    }
    if (!wraps || depth !== 0) { break; }
    current = current.slice(1, -1).trim();
  }
  return current;
}

/**
 * USER-LINT-01(用户报 2026-11-04):引擎校验器名单。KBEngine 全局 API
 * `kbe.isValid(entityRef)`——实体引用有效(未销毁)返回 True,
 * `isValid(None)`/无效引用返回 False,故 `kbe.isValid(X)` 真值 ⟹ X 可
 * 安全解引用,是引擎惯用的正向判空守卫。名单收敛于此一处常量表,后续
 * 引擎侧新增校验器(如 kbe.hasClient 等)在此追加限定名即可,勿散落
 * 硬编码到形态判定里。
 */
const ENGINE_VALIDATOR_NAMES: readonly string[] = ['kbe.isValid'];

/** 正则字面元转义(subject 含 `self.client` 的点号) */
const escapeRegexLiteral = (text: string): string =>
  text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 名单校验器调用形态:atom 恰为 `<validator>(subject)`(实参内空白宽容;
 * 多余实参/前缀后缀不匹配——`kbe.isValid(other)` 不构成对 subject 的守卫)。
 */
const isEngineValidatorCall = (atom: string, subject: string): boolean => {
  const pattern = new RegExp(
    `^(?:${ENGINE_VALIDATOR_NAMES.map(escapeRegexLiteral).join('|')})\\(\\s*${escapeRegexLiteral(subject)}\\s*\\)$`
  );
  return pattern.test(atom);
};

const TOP_LEVEL_AND = /^(\s+)(and)(\s|$)/;
const TOP_LEVEL_OR = /^(\s+)(or)(\s|$)/;

/** 顶层(括号深度 0)按 and/or 切分——替代旧朴素字符串 split,不再被
 * 字符串内容/括号误切(掩码行内字符串已空白,这里是结构级切分) */
function splitTopLevel(expr: string, op: 'and' | 'or'): string[] {
  const pattern = op === 'and' ? TOP_LEVEL_AND : TOP_LEVEL_OR;
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < expr.length; i += 1) {
    const char = expr[i];
    if (char === '(' || char === '[' || char === '{') { depth += 1; continue; }
    if (char === ')' || char === ']' || char === '}') { depth = Math.max(0, depth - 1); continue; }
    if (depth === 0) {
      const rest = pattern.exec(expr.slice(i));
      if (rest) {
        parts.push(expr.slice(start, i));
        i += rest[0].length - 1;
        start = i + 1;
      }
    }
  }
  parts.push(expr.slice(start));
  return parts;
}

/**
 * IDE-LINT-002:条件布尔语义分诊。subject(原文,未转义)视角:
 * - positive:顶层无 or(优先级 and 紧于 or,顶层有 or 即不确定);顶层 and
 *   分句(剥外层括号)恰为 `subject` / `subject is not None` /
 *   `not (subject is None)` / 引擎校验器真值 `kbe.isValid(subject)`
 *   (USER-LINT-01:真值 ⟹ subject 可安全解引用);
 * - early-exit:单一原子恰为 `not subject` / `subject is None` /
 *   `not kbe.isValid(subject)`(校验器为假 ⟹ subject 无效,反向同理);
 * - null:不确定形态(保留警告)。
 */
type ConditionVerdict = 'positive' | 'early-exit' | null;

function conditionVerdict(condition: string, subject: string): ConditionVerdict {
  const expr = stripOuterParens(condition);
  if (splitTopLevel(expr, 'or').length > 1) { return null; }
  const conjuncts = splitTopLevel(expr, 'and');
  const positiveAtom = (atomRaw: string): boolean => {
    const atom = stripOuterParens(atomRaw);
    if (atom === subject || atom === `${subject} is not None`) { return true; }
    if (isEngineValidatorCall(atom, subject)) { return true; }
    // `not kbe.isValid(subject)` 是反向(校验器为假才走块体)→ 早退非正向,
    // 此处只认 `not (subject is None)`
    if (/^not\b/.test(atom)) { return stripOuterParens(atom.slice(3)) === `${subject} is None`; }
    return false;
  };
  if (conjuncts.length > 1) {
    return conjuncts.some(positiveAtom) ? 'positive' : null;
  }
  const atom = stripOuterParens(conjuncts[0]);
  if (positiveAtom(atom)) { return 'positive'; }
  if (/^not\b/.test(atom)) {
    const inner = stripOuterParens(atom.slice(3));
    if (inner === subject) { return 'early-exit'; }
    if (isEngineValidatorCall(inner, subject)) { return 'early-exit'; }
  }
  if (atom === `${subject} is None`) { return 'early-exit'; }
  return null;
}

/** 接收者本地别名赋值:`x = self.<role>`(第 4 组须纯空白/已掩注释才算完赋值) */
const RECEIVER_ALIAS_ASSIGN =
  /^([ \t]*)([A-Za-z_]\w*)\s*=\s*self\.(cell|base|client)(.*)$/;

/** 方法/类作用域头(掩码行;方法自身的 def 行由调用方排除) */
const NESTED_SCOPE_HEADER = /^\s*(?:async\s+)?def\s|^\s*class\s/;

/** 目标(别名名或 self.<role>)重绑:普通/增强赋值、海象;`==` `<=` 等比较不算 */
const rebindPattern = (target: string): RegExp =>
  new RegExp(`\\b${target}\\s*(?:(?:\\*\\*|//|>>|<<|[-+*/%&|^])?=(?!=)|:=)`);

/** for/del/as 对名字的重绑 */
const nameRebindExtras = (name: string): RegExp =>
  new RegExp(`\\b(?:for|del|as)\\s+${name}\\b`);

interface MethodSpan {
  startLine: number;
  endLine: number;
}

interface ClassMethodSpans {
  startLine: number;
  endLine: number;
  methods: MethodSpan[];
}

function buildMethodSpans(parsed: ReturnType<typeof parsePythonFile>): ClassMethodSpans[] {
  return parsed.classes.map(cls => {
    const starts = [...cls.methods.values()].map(loc => loc.line).sort((left, right) => left - right);
    return {
      startLine: cls.startLine,
      endLine: cls.endLine,
      methods: starts.map((startLine, i) => ({
        startLine,
        endLine: i + 1 < starts.length ? starts[i + 1] - 1 : cls.endLine - 1
      }))
    };
  });
}

/** 方法体界(0 起行,含尾):保留原有类顺序，复用预先排序的方法区间。 */
function enclosingMethodSpan(classes: readonly ClassMethodSpans[], line: number): MethodSpan | undefined {
  for (const cls of classes) {
    if (line < cls.startLine || line >= cls.endLine) { continue; }
    for (let i = cls.methods.length - 1; i >= 0; i -= 1) {
      if (cls.methods[i].startLine <= line) return cls.methods[i];
    }
    return undefined;
  }
  return undefined;
}

/**
 * use 行之前是否存在接收者判空 guard:
 * a) 正向 if(`if self.cell:`/`if self.cell is not None:`/别名同形)
 *    且 use 行在其块体内(缩进更深且之间无同级去缩进);
 * b) 早退 if(`if not self.cell:`/`if self.cell is None:`)块体内含 return/raise;
 * c) use 行同行的单行 if guard(`if self.cell: self.cell.x()`)/三元前置判空。
 *
 * IDE-DIA-004:guard 前缀扫描按(方法,接收者)一次完成(scanGuardCandidates
 * 单趟收集候选行+别名),同方法同接收者的多处调用共享同一份候选,逐调用
 * 只做位置闸判定,不再每个调用点从头遍历方法体。
 */
interface GuardCandidate {
  line: number;
  indent: number;
  kind: 'positive' | 'early-exit';
  /** 命中的分句 subject(转义形):过闸时查 (guard 行, use 行) 间有无重绑 */
  subject: string;
  /** 正向 guard:if 块的闭合行(首个缩进 ≤ ifIndent 的非空行;无则方法体界+1)。
   * use 行 < blockEnd 即仍在块体内(2026-10-28 审核整改:预计算一次,逐调用零重扫) */
  blockEnd?: number;
  /** 早退 guard:块体内首个无条件 return/raise 行(0 起行;无则 undefined) */
  exitLine?: number;
}

interface MethodGuardScan {
  receiver: PythonReceiverCall['receiver'];
  candidates: GuardCandidate[];
  /** 别名赋值行与名(`x = self.<role>`),同行闸判定按 use 之前的过滤 */
  aliases: Array<{ line: number; name: string }>;
  /** 转义 subject → 重绑行表(别名再赋值/for/del、self.<role> 属性重赋值):
   * guard 与 use 之间的重绑使旧证明失效(IDE-LINT-004) */
  rebinds: Map<string, number[]>;
  /** 方法体内嵌套 def/class 头行:guard 证明不跨作用域边界(IDE-LINT-004) */
  nestedHeaders: number[];
}

let guardPrefixScanCount = 0;

/** 测试面:guard 前缀扫描计数(按方法×接收者记账) */
export function getGuardPrefixScanCountForTests(): number {
  return guardPrefixScanCount;
}

export function resetGuardPrefixScanCountForTests(): void {
  guardPrefixScanCount = 0;
}

/** 测试面:块探测计数(blockContains/blockExits 触发次数) */
let guardBlockProbeCount = 0;

export function getGuardBlockProbeCountForTests(): number {
  return guardBlockProbeCount;
}

export function resetGuardBlockProbeCountForTests(): void {
  guardBlockProbeCount = 0;
}

/** 单趟扫方法体(掩码行):维持存活 subject 集(self.<role> 起步,遇别名
 * 赋值追加),记录重绑行与嵌套 def/class 头,guard 形态按条件布尔语义分诊 */
function scanGuardCandidates(
  lines: readonly string[],
  span: MethodSpan,
  receiver: PythonReceiverCall['receiver']
): MethodGuardScan {
  guardPrefixScanCount += 1;
  const candidates: GuardCandidate[] = [];
  const aliases: Array<{ line: number; name: string }> = [];
  const rebinds = new Map<string, number[]>();
  const nestedHeaders: number[] = [];
  const subjects: Array<{ escaped: string; plain: string }> = [
    { escaped: escapeSubject(`self.${receiver}`), plain: `self.${receiver}` }
  ];
  const aliasNames = new Set<string>();
  const nestedIndents: number[] = [];
  const recordRebind = (escaped: string, line: number): void => {
    const list = rebinds.get(escaped);
    if (list) { list.push(line); } else { rebinds.set(escaped, [line]); }
  };
  for (let j = span.startLine; j <= span.endLine; j += 1) {
    const text = lines[j];
    if (COMMENT_ONLY.test(text)) { continue; }
    const indent = indentOf(text);
    while (nestedIndents.length > 0 && indent <= nestedIndents[nestedIndents.length - 1]) {
      nestedIndents.pop();
    }
    if (j > span.startLine && NESTED_SCOPE_HEADER.test(text)) {
      nestedIndents.push(indent);
      nestedHeaders.push(j);
      continue; // 嵌套作用域头行本身不是 guard/别名行
    }
    const nested = nestedIndents.length > 0;
    if (!nested) {
      const assigned = RECEIVER_ALIAS_ASSIGN.exec(text);
      if (assigned && assigned[3] === receiver && /^\s*$/.test(assigned[4] ?? '')) {
        const name = assigned[2];
        aliases.push({ line: j, name });
        if (!aliasNames.has(name)) {
          aliasNames.add(name);
          subjects.push({ escaped: escapeSubject(name), plain: name });
        }
        continue; // 别名赋值行本身不是 guard 行
      }
    }
    // 重绑记账(IDE-LINT-004):别名名与 self.<role> 属性的重赋值/for/del/as
    for (const subject of subjects) {
      const hit = rebindPattern(subject.plain).test(text)
        || (!subject.plain.startsWith('self.') && nameRebindExtras(subject.plain).test(text));
      if (hit) { recordRebind(subject.escaped, j); }
    }
    // guard 形态判定:if 头条件按布尔语义分诊(IDE-LINT-002;行内单行体不算
    // 块 guard,正向单行走 hasReceiverGuardFromScan 的同行闸)
    const header = extractIfHeader(text);
    if (!header) { continue; }
    const inlineBody = /\S/.test(text.slice(header.bodyStart));
    let positive: string | null = null;
    let early: string | null = null;
    for (const subject of subjects) {
      const verdict = conditionVerdict(header.condition, subject.plain);
      if (verdict === 'positive' && positive === null) { positive = subject.escaped; }
      if (verdict === 'early-exit' && early === null) { early = subject.escaped; }
    }
    if (inlineBody) { continue; }
    if (positive !== null) {
      candidates.push({ line: j, indent, kind: 'positive', subject: positive });
    } else if (early !== null) {
      candidates.push({ line: j, indent, kind: 'early-exit', subject: early });
    }
  }
  // 2026-10-28 审核整改:块界/早退位置每候选预计算一次(扫描期,计探测数),
  // 逐调用只做位置闸判定,不再从 guard 行重扫文本(平方级 → 近线性)
  for (const candidate of candidates) {
    if (candidate.kind === 'positive') {
      candidate.blockEnd = firstDedentAfter(lines, span, candidate);
    } else {
      candidate.exitLine = firstExitAfter(lines, span, candidate);
    }
  }
  return { receiver, candidates, aliases, rebinds, nestedHeaders };
}

/** if 块闭合行:candidate 行之后首个非空且缩进 ≤ ifIndent 的行;块贯通到方法体界则界+1 */
function firstDedentAfter(
  lines: readonly string[],
  span: MethodSpan,
  candidate: GuardCandidate
): number {
  guardBlockProbeCount += 1;
  for (let j = candidate.line + 1; j <= span.endLine; j += 1) {
    const text = lines[j];
    if (COMMENT_ONLY.test(text)) { continue; }
    if (indentOf(text) <= candidate.indent) { return j; }
  }
  return span.endLine + 1;
}

/**
 * if 块体内首个无条件 return/raise 行(IDE-LINT-003):块体首行定块缩进,
 * 按块级语句顺序扫——首个块级 return/raise 即退出;首个块级复合语句
 * (嵌套 if/for/…,其 return 可不走)即不确定;更深缩进是续行/嵌套块,跳过。
 * 掩码行保证字符串/注释里的 return/raise 不再误判。
 */
function firstExitAfter(
  lines: readonly string[],
  span: MethodSpan,
  candidate: GuardCandidate
): number | undefined {
  guardBlockProbeCount += 1;
  let bodyIndent = -1;
  for (let j = candidate.line + 1; j <= span.endLine; j += 1) {
    const text = lines[j];
    if (COMMENT_ONLY.test(text)) { continue; }
    const indent = indentOf(text);
    if (indent <= candidate.indent) { return undefined; } // 块已闭
    if (bodyIndent === -1) { bodyIndent = indent; }
    if (indent === bodyIndent) {
      if (/^\s*(?:return|raise)\b/.test(text)) { return j; }
      // 块级复合语句(嵌套 if/for/…):其后 return 不保证所有路径退出;
      // 块级普通语句:无条件执行,继续向后找
      if (/^\s*(?:if|elif|else|for|while|try|except|finally|with|def|class|match|case)\b/.test(text)) {
        return undefined;
      }
    }
  }
  return undefined;
}

/** guard 与 use 之间 subject 无重绑(IDE-LINT-004:重赋值使旧证明失效) */
function bindingStableBetween(
  scan: MethodGuardScan,
  escapedSubject: string,
  fromLine: number,
  toLine: number
): boolean {
  const list = scan.rebinds.get(escapedSubject);
  if (!list) { return true; }
  return !list.some(line => line > fromLine && line < toLine);
}

/**
 * IDE-LINT-004:别名 guard 的证明窗口起点不是 guard 行,而是 guard 前最近
 * 一次该名的 receiver 赋值——赋值与 guard 之间的重赋值意味着 guard 测的
 * 已不是 receiver 值。self.<role> 本体的窗口就是 guard 行。
 */
function proofWindowStart(scan: MethodGuardScan, candidate: GuardCandidate): number {
  const selfSubject = escapeSubject(`self.${scan.receiver}`);
  if (candidate.subject === selfSubject) { return candidate.line; }
  const name = unescapeSubject(candidate.subject);
  let start = -1;
  for (const alias of scan.aliases) {
    if (alias.name === name && alias.line < candidate.line) { start = alias.line; }
  }
  return start;
}

/** guard 与 use 之间不跨嵌套 def/class 边界(IDE-LINT-004) */
function crossesNestedScope(scan: MethodGuardScan, fromLine: number, toLine: number): boolean {
  return scan.nestedHeaders.some(header => header > fromLine && header < toLine);
}

/** 候选过闸:位置闸(块界/早退已预计算)+ 重绑/跨作用域失效闸,零文本重扫 */
function hasReceiverGuardFromScan(
  lines: readonly string[],
  scan: MethodGuardScan,
  useLine: number
): boolean {
  const useIndent = indentOf(lines[useLine]);
  for (const candidate of scan.candidates) {
    if (candidate.line >= useLine) { continue; }
    if (crossesNestedScope(scan, candidate.line, useLine)) { continue; }
    const proofStart = proofWindowStart(scan, candidate);
    if (proofStart === -1
      || !bindingStableBetween(scan, candidate.subject, proofStart, useLine)
      // 别名值与接收者属性同源:期间 self.<role> 被重赋值则旧证明同失效
      || !bindingStableBetween(scan, escapeSubject(`self.${scan.receiver}`), proofStart, useLine)) {
      continue;
    }
    if (candidate.kind === 'positive') {
      if (candidate.indent < useIndent && (candidate.blockEnd ?? 0) > useLine) {
        return true;
      }
    } else if (candidate.indent <= useIndent && candidate.exitLine !== undefined && candidate.exitLine < useLine) {
      return true;
    }
  }
  // 同行 guard:单行 if(条件按布尔语义判定)/ 三元前置判空
  const useText = lines[useLine];
  for (const subject of scanSubjectsUpTo(scan, useLine)) {
    const header = extractIfHeader(useText);
    if (header
      && /\S/.test(useText.slice(header.bodyStart))
      && conditionVerdict(header.condition, unescapeSubject(subject)) === 'positive') {
      return true;
    }
    const sameLineTernary = new RegExp(`\\bif\\s+${subject}\\s*(is\\s+not\\s+None)?\\s+else\\b`);
    if (sameLineTernary.test(useText)) {
      return true;
    }
  }
  return false;
}

/** 同行闸的 subject 集:接收者本体 + use 之前赋值且未被重绑的别名 */
function scanSubjectsUpTo(scan: MethodGuardScan, useLine: number): string[] {
  const subjects = [escapeSubject(`self.${scan.receiver}`)];
  for (const alias of scan.aliases) {
    if (alias.line < useLine
      && bindingStableBetween(scan, escapeSubject(alias.name), alias.line, useLine)) {
      subjects.push(escapeSubject(alias.name));
    }
  }
  return subjects;
}

/** 方法体内别名属性使用点:`name.attr`(name 仍绑定 receiver 才算) */
const ALIAS_ATTR_USE = /\b([A-Za-z_]\w*)\.([A-Za-z_]\w*)/g;

interface AliasScope {
  indent: number;
  /** 名 → receiver 绑定(行号);null = 已重绑为其他值 */
  bindings: Map<string, { receiver: PythonReceiverCall['receiver']; line: number } | null>;
}

/**
 * IDE-LINT-006:收集方法体内本地别名的使用点(单趟,掩码行,按方法区间一次)。
 * 作用域链解析:嵌套 def/class 各自持绑定表;use 从最内层向外找首个绑定该名
 * 的作用域——内层有赋值(遮蔽)则不沿用外层 receiver 证明;外层绑定经闭包
 * 可见时按外层绑定报。产出与 self.<role>.<name> 同形的调用点(列=属性名
 * token),与直接调用共用同一 guard 闸与段错配检查。
 */
function collectAliasUseCalls(
  lines: readonly string[],
  span: MethodSpan,
  callerFace?: PythonCallerFace
): PythonReceiverCall[] {
  const calls: PythonReceiverCall[] = [];
  const scopes: AliasScope[] = [{ indent: -1, bindings: new Map() }];
  for (let j = span.startLine + 1; j <= span.endLine; j += 1) {
    const text = lines[j];
    if (COMMENT_ONLY.test(text)) { continue; }
    const indent = indentOf(text);
    while (scopes.length > 1 && indent <= scopes[scopes.length - 1].indent) {
      scopes.pop();
    }
    if (NESTED_SCOPE_HEADER.test(text)) {
      scopes.push({ indent, bindings: new Map() });
      continue;
    }
    const scope = scopes[scopes.length - 1];
    const assigned = RECEIVER_ALIAS_ASSIGN.exec(text);
    if (assigned && /^\s*$/.test(assigned[4] ?? '')) {
      scope.bindings.set(assigned[2], {
        receiver: assigned[3] as PythonReceiverCall['receiver'],
        line: j
      });
      continue;
    }
    // 本作用域内重绑(普通/增强赋值、for/del/as)使该名绑定失效
    for (const [name, binding] of scope.bindings) {
      if (binding === null) { continue; }
      if (rebindPattern(name).test(text) || nameRebindExtras(name).test(text)) {
        scope.bindings.set(name, null);
      }
    }
    let match: RegExpExecArray | null;
    ALIAS_ATTR_USE.lastIndex = 0;
    while ((match = ALIAS_ATTR_USE.exec(text)) !== null) {
      // 作用域链向外解析:最内层持有该名绑定的作用域
      let holder: AliasScope | undefined;
      for (let s = scopes.length - 1; s >= 0; s -= 1) {
        if (scopes[s].bindings.has(match[1])) { holder = scopes[s]; break; }
      }
      const binding = holder?.bindings.get(match[1]);
      if (!binding || binding.line === j) { continue; }
      // 逐面语义闸(深审-3):调用面无此角色属性(如 cellapp 上 self.cell
      // 别名)→ 绑定源头即 AttributeError,使用点不进诊断面。
      const section = pythonReceiverSectionFor(callerFace, binding.receiver);
      if (section === null) { continue; }
      calls.push({
        line: j,
        character: match.index + match[0].length - match[2].length,
        receiver: binding.receiver,
        section,
        methodName: match[2],
        callerFace
      });
    }
  }
  return calls;
}

const indentOf = (line: string): number => {
  const match = /^[ \t]*/.exec(line);
  return match ? match[0].replace(/\t/g, '    ').length : 0;
};

/** .def 段错配消息(声明非空且无一处在接收者对应段时才成消息;否则 undefined) */
function sectionMismatchMessage(
  receiver: PythonReceiverCall['receiver'],
  methodName: string,
  mapping: EntityMapping
): string | undefined {
  const expected = PYTHON_RECEIVER_SECTIONS[receiver];
  const declarations = mapping.methods?.[methodName] ?? [];
  if (declarations.length === 0) { return undefined; }
  if (declarations.some(declaration => declaration.section === expected)) { return undefined; }
  const declared = [...new Set(declarations.map(declaration => declaration.section))].join('/');
  return l10nText(
    'self.{receiver}.{method} section mismatch: {method} is declared in .def {declared}; calling via {receiver} will not route to that method (use the {expected} declaration)',
    { receiver, method: methodName, declared, expected }
  );
}

/** .def 段错配:方法在 def 声明了,但没有任何一处在接收者对应的 section */
function sectionMismatch(call: PythonReceiverCall, mapping: EntityMapping): string | undefined {
  return sectionMismatchMessage(call.receiver, call.methodName, mapping);
}

/**
 * 全量计算:无判空 guard 的接收者引用(Warning)+ .def 段错配(Warning)。
 * 纯函数(文本 + 内存映射快照),供诊断调度器同步 compute 面调用。
 * preparsed(IDE-DIA-003):同版本共享解析——直接给对象或给惰性提供器
 * (仅当确有 receiver 使用点过闸后才调用,IDE-DIA-001 零使用点不解析
 * 语义保持);给了就不各自完整解析一次。
 */
export type PreparsedPythonProvider = ReturnType<typeof parsePythonFile> | (() => ReturnType<typeof parsePythonFile>);

/**
 * IDE-REV-009 异步面提供器:在同步形态之上允许异步取解析(如
 * asyncDocumentParse 的 worker 路径)与 null(本轮共享解析不可用——
 * worker 停用/积压上限/版本代被并发编辑顶掉):null 时异步面中止本轮
 * 返回 null,不回退宿主同步整文件解析。
 */
export type AsyncPreparsedPythonProvider =
  | PreparsedPythonProvider
  | (() => ReturnType<typeof parsePythonFile> | null | Promise<ReturnType<typeof parsePythonFile> | null>);

/** 逐调用求值(同步/异步面共用):guard 过闸判定 + 段错配,结果入 findings */
function appendCallFindings(
  calls: readonly PythonReceiverCall[],
  lines: readonly string[],
  methodSpans: readonly ClassMethodSpans[],
  scanFor: (span: MethodSpan, receiver: PythonReceiverCall['receiver']) => MethodGuardScan,
  mapping: EntityMapping | undefined,
  findings: ReceiverNoneFinding[]
): void {
  for (const call of calls) {
    const span = enclosingMethodSpan(methodSpans, call.line);
    if (span && !hasReceiverGuardFromScan(lines, scanFor(span, call.receiver), call.line)) {
      findings.push({
        line: call.line,
        character: call.character,
        receiver: call.receiver,
        methodName: call.methodName,
        kind: 'receiver-none',
        message: renderReceiverNoneMessage(call.receiver)
      });
    }
    if (mapping) {
      const mismatch = sectionMismatch(call, mapping);
      if (mismatch) {
        findings.push({
          line: call.line,
          character: call.character,
          receiver: call.receiver,
          methodName: call.methodName,
          kind: 'section-mismatch',
          message: mismatch
        });
      }
    }
  }
}

/** 一次解析的求值上下文(同步/异步面共用构建) */
interface ReceiverEvalContext {
  lines: string[];
  methodSpans: ClassMethodSpans[];
  scanFor: (span: MethodSpan, receiver: PythonReceiverCall['receiver']) => MethodGuardScan;
  /** IDE-LINT-006:本地别名使用点(掩码文本上按方法区间一次收集) */
  aliasUseCalls: PythonReceiverCall[];
}

/** 文本里疑似有别名赋值(决定是否做别名使用点收集的廉价预检) */
export const RECEIVER_ALIAS_HINT = /\b[A-Za-z_]\w*\s*=\s*self\.(?:cell|base|client)\b/;

function buildEvalContextFromParsed(
  maskedText: string,
  parsed: ReturnType<typeof parsePythonFile>,
  callerFace?: PythonCallerFace
): ReceiverEvalContext {
  const methodSpans = buildMethodSpans(parsed);
  const lines = maskedText.split(/\r?\n/);
  // IDE-DIA-004:guard 前缀扫描按(方法区间, 接收者)一次,同方法同接收者的
  // 多处调用共享同一份候选
  const guardScans = new Map<MethodSpan, Map<PythonReceiverCall['receiver'], MethodGuardScan>>();
  const scanFor = (span: MethodSpan, receiver: PythonReceiverCall['receiver']): MethodGuardScan => {
    let byReceiver = guardScans.get(span);
    if (!byReceiver) {
      byReceiver = new Map();
      guardScans.set(span, byReceiver);
    }
    let scan = byReceiver.get(receiver);
    if (!scan) {
      scan = scanGuardCandidates(lines, span, receiver);
      byReceiver.set(receiver, scan);
    }
    return scan;
  };
  // IDE-LINT-006:掩码一次全文扫描(IDE-LINT-005)复用于调用发现与别名收集,
  // 不逐命中重扫
  const aliasUseCalls: PythonReceiverCall[] = [];
  if (RECEIVER_ALIAS_HINT.test(maskedText)) {
    for (const cls of methodSpans) {
      for (const span of cls.methods) {
        aliasUseCalls.push(...collectAliasUseCalls(lines, span, callerFace));
      }
    }
  }
  return { lines, methodSpans, scanFor, aliasUseCalls };
}

/** 异步面解析求值(IDE-REV-009):提供器优先(惰性——仅过闸后调用);无提供器
 * 默认自解析同样经 parsePythonFileResponsive 分流(≥256KiB 进 worker,宿主
 * 不落整文件同步解析;阈值下宿主同步与全仓口径一致)。null=本轮不可用。 */
async function resolveParsedAsync(
  text: string,
  filePath: string,
  preparsed: AsyncPreparsedPythonProvider | undefined
): Promise<ReturnType<typeof parsePythonFile> | null> {
  if (typeof preparsed === 'function') {
    return preparsed();
  }
  if (preparsed !== undefined) {
    return preparsed;
  }
  const responsive = await parsePythonFileResponsive(text, filePath, 0);
  return responsive.parsed;
}

export function computeReceiverNoneFindings(
  text: string,
  filePath: string,
  mapping?: EntityMapping,
  preparsed?: PreparsedPythonProvider
): ReceiverNoneFinding[] {
  // IDE-LINT-005:全文掩码一次,调用发现与 guard 分析共用(列偏移不变)
  const masked = maskPythonNonCode(text);
  // 逐面语义闸(深审-3):调用面由脚本目录域换算;面上无此角色属性的引用
  // (base.base/cell.cell/client.client)在发现面即滤除——AttributeError 面,
  // guard/段对账都不适用,与 Rust bind_self_role 九面表同口径
  const callerFace = pythonScriptDomain(filePath) ?? undefined;
  const baseCalls = findPythonReceiverCalls(masked, callerFace);
  if (baseCalls.length === 0 && !RECEIVER_ALIAS_HINT.test(masked)) { return []; }
  const parsed = typeof preparsed === 'function'
    ? preparsed()
    : preparsed ?? parsePythonFile(text, filePath);
  const context = buildEvalContextFromParsed(masked, parsed, callerFace);
  const findings: ReceiverNoneFinding[] = [];
  appendCallFindings(baseCalls.concat(context.aliasUseCalls), context.lines,
    context.methodSpans, context.scanFor, mapping, findings);
  return findings;
}

/** IDE-DIA-005 异步分片面:大文件计算移出同步入口 */
export interface ReceiverNoneAsyncDeps {
  /** 每片处理的调用数(默认 200) */
  chunkSize?: number;
  /** 片间让出宿主(默认 setTimeout 0;测试可替换) */
  yieldToHost?: () => Promise<void>;
  /** 片间检查:返回 false 即中止(版本已前进,旧版本回包丢弃)→ 整体返回 null */
  shouldContinue?: () => boolean;
}

const RECEIVER_NONE_CHUNK_SIZE = 200;

const yieldToHostDefault = (): Promise<void> =>
  new Promise(resolve => { setTimeout(resolve, 0); });

/**
 * computeReceiverNoneFindings 的分片异步面:调用点按 chunkSize 分片,
 * 片间让出宿主(计算期间宿主仍可响应定时器/请求);shouldContinue 为假
 * (版本已前进)中止并返回 null——调用方丢弃,绝不产出部分结果被当全量。
 * 产出与同步面逐项一致(同解析/同 guard 候选记忆化)。
 *
 * IDE-REV-009:解析消费异步面(resolveParsedAsync——提供器可异步/可 null,
 * 无提供器默认自解析同样 worker 分流),首个 yield 之前的宿主工作只剩
 * findPythonReceiverCalls 这一次线性正则扫描(无解析、无逐行状态机),
 * 整文件同步解析窗口不再存在;解析落定后复核版本(等待期间前进即中止)。
 */
export async function computeReceiverNoneFindingsAsync(
  text: string,
  filePath: string,
  mapping?: EntityMapping,
  preparsed?: AsyncPreparsedPythonProvider,
  deps: ReceiverNoneAsyncDeps = {}
): Promise<ReceiverNoneFinding[] | null> {
  const chunkSize = deps.chunkSize ?? RECEIVER_NONE_CHUNK_SIZE;
  const yieldToHost = deps.yieldToHost ?? yieldToHostDefault;
  // IDE-LINT-005:全文掩码一次,调用发现与 guard 分析共用(列偏移不变)
  const masked = maskPythonNonCode(text);
  // 逐面语义闸(深审-3):与同步面同口径(见 computeReceiverNoneFindings)
  const callerFace = pythonScriptDomain(filePath) ?? undefined;
  const baseCalls = findPythonReceiverCalls(masked, callerFace);
  if (baseCalls.length === 0 && !RECEIVER_ALIAS_HINT.test(masked)) { return []; }
  const parsed = await resolveParsedAsync(text, filePath, preparsed);
  if (!parsed) {
    return null; // 本轮共享解析不可用:中止,不产出,不回退宿主同步解析
  }
  if (deps.shouldContinue && !deps.shouldContinue()) {
    return null; // 解析等待期间版本已前进:旧版本回包由调用方丢弃
  }
  const context = buildEvalContextFromParsed(masked, parsed, callerFace);
  const calls = baseCalls.concat(context.aliasUseCalls);
  const findings: ReceiverNoneFinding[] = [];
  for (let start = 0; start < calls.length; start += chunkSize) {
    if (start > 0) {
      await yieldToHost();
      if (deps.shouldContinue && !deps.shouldContinue()) {
        return null; // 版本已前进:中止,旧版本回包由调用方丢弃
      }
    }
    const end = Math.min(start + chunkSize, calls.length);
    appendCallFindings(calls.slice(start, end), context.lines, context.methodSpans,
      context.scanFor, mapping, findings);
  }
  return findings;
}

/** 诊断项(纯数据;extension 侧转 vscode.Diagnostic,测试免 vscode 依赖) */
export interface ReceiverDiagnosticItem {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  message: string;
  severity: 'Warning';
  source: 'kbengine';
  /** 稳定 code(B-7):QuickFix provider 按此对账 */
  code: string;
}

const findingToDiagnosticItem = (finding: ReceiverNoneFinding): ReceiverDiagnosticItem => ({
  range: {
    start: { line: finding.line, character: finding.character },
    end: { line: finding.line, character: finding.character + finding.methodName.length }
  },
  message: finding.message,
  severity: 'Warning' as const,
  source: 'kbengine' as const,
  code: finding.kind === 'receiver-none'
    ? RECEIVER_NONE_DIAGNOSTIC_CODE
    : RECEIVER_SECTION_MISMATCH_DIAGNOSTIC_CODE
});

/**
 * 早退守卫插入编辑(B-7 纯函数):使用行之前插入
 * `<缩进>if not self.<receiver>:` + `<缩进+一级>return`。
 * 缩进复用使用行的前导空白原文(空格/制表符不混);内层一级=空格文件
 * 加 4 空格、tab 文件加 1 tab。守卫形态即诊断面自认的 early-exit
 * guard 一族,插入后重算该位不再报。行号越界/空文本返回 null(不猜)。
 */
export interface ReceiverNoneGuardEdit {
  /** 插入点(0 起行;插入该行行首之前) */
  line: number;
  /** 插入文本(两行,含尾换行) */
  text: string;
}

export function buildReceiverNoneGuardEdit(
  text: string,
  line: number,
  receiver: PythonReceiverCall['receiver']
): ReceiverNoneGuardEdit | null {
  if (!text || line < 0) {
    return null;
  }
  const lines = text.split(/\r?\n/);
  const useLine = lines[line];
  if (useLine === undefined || !useLine.trim()) {
    return null;
  }
  const leading = /^[ \t]*/.exec(useLine)?.[0] ?? '';
  const inner = leading.includes('\t') ? `${leading}\t` : `${leading}    `;
  return {
    line,
    text: `${leading}if not self.${receiver}:\n${inner}return\n`
  };
}

/**
 * 包裹式守卫替换编辑(2026-10-30 用户令):`if self.<receiver>:`(真值判定)
 * 包住当前语句与后续同级块并整体缩进一级、继续执行——用户:常见操作是
 * 判非 None 后继续,早退 `if not x: return` 反而不常见,故包裹式为首选。
 * 编辑=Range 替换 [startLine, endLine):原 `if self.<receiver>:` 行 +
 * 块内各行整体加一级缩进(前导原文空格/制表符不混;同级/更深行都进一级,
 * 相对深度保持)。块界=首个缩进低于使用行的非空非注释行(块贯通则文末)。
 * 行号越界/空文本/使用行为空行返回 null(不猜)。
 */
export interface ReceiverNoneWrapEdit {
  /** 替换起点行(0 起,含) */
  startLine: number;
  /** 替换终点行(0 起,不含;块闭行/文末) */
  endLine: number;
  /** 替换文本(块内行已加一级缩进,`if` 头行在前;不含文末换行) */
  text: string;
}

export function buildReceiverNoneWrapEdit(
  text: string,
  line: number,
  receiver: PythonReceiverCall['receiver']
): ReceiverNoneWrapEdit | null {
  if (!text || line < 0) {
    return null;
  }
  const lines = text.split(/\r?\n/);
  const useLine = lines[line];
  if (useLine === undefined || !useLine.trim()) {
    return null;
  }
  const leading = /^[ \t]*/.exec(useLine)?.[0] ?? '';
  const inner = leading.includes('\t') ? `${leading}\t` : `${leading}    `;
  const useIndent = indentOf(useLine);
  // 2026-10-30 用户反馈:包裹式不得把整段后续同级块都卷进来——只包「用到
  // 本 receiver 的连续语句」(以及它们的多行续行),首个不引用本 receiver 的
  // 同级语句即截断,避免无关语句(如后面的 self.base.notify())被误缩进。
  const receiverPattern = new RegExp(`\\bself\\.${receiver}\\b`);
  let end = line + 1;
  let balance = delimiterDelta(useLine);
  while (end < lines.length) {
    const current = lines[end];
    if (COMMENT_ONLY.test(current) || !current.trim()) {
      // 多行语句续行内(括号未闭合)不因空行/注释中断;否则语句组结束
      if (balance > 0) {
        end += 1;
        continue;
      }
      break;
    }
    if (indentOf(current) < useIndent) {
      break;
    }
    // 续行(balance>0 括号未闭合)或引用本 receiver → 纳入;否则语句组结束
    if (!receiverPattern.test(current) && balance <= 0) {
      break;
    }
    balance += delimiterDelta(current);
    end += 1;
  }
  const body = lines.slice(line, end).map(entry => {
    if (COMMENT_ONLY.test(entry) || !entry.trim()) {
      return entry;
    }
    return `${inner}${entry.slice(leading.length)}`;
  });
  return {
    startLine: line,
    endLine: end,
    text: [`${leading}if self.${receiver}:`, ...body].join('\n')
  };
}

/** 统计行内未闭合括号差(续行判定:>0 表示语句在下一行继续) */
function delimiterDelta(line: string): number {
  let delta = 0;
  for (const char of line) {
    if (char === '(' || char === '[' || char === '{') {
      delta += 1;
    } else if (char === ')' || char === ']' || char === '}') {
      delta -= 1;
    }
  }
  return delta;
}

/** 开关口:enabled=false 零产出(用户令:配置开关默认开可关,severity=Warning) */
export function receiverNoneDiagnosticItems(
  text: string,
  filePath: string,
  mapping: EntityMapping | undefined,
  enabled: boolean,
  preparsed?: PreparsedPythonProvider
): ReceiverDiagnosticItem[] {
  if (!enabled) {
    return [];
  }
  return computeReceiverNoneFindings(text, filePath, mapping, preparsed).map(findingToDiagnosticItem);
}

/** IDE-DIA-005 异步面:分片计算 + 中止返回 null(旧版本回包丢弃)。
 * IDE-REV-009:preparsed 放宽为异步提供器(共享解析经 asyncDocumentParse
 * 的 worker 路径;null=本轮不可用,整体中止) */
export async function receiverNoneDiagnosticItemsAsync(
  text: string,
  filePath: string,
  mapping: EntityMapping | undefined,
  enabled: boolean,
  preparsed?: AsyncPreparsedPythonProvider,
  deps: ReceiverNoneAsyncDeps = {}
): Promise<ReceiverDiagnosticItem[] | null> {
  if (!enabled) {
    return [];
  }
  const findings = await computeReceiverNoneFindingsAsync(text, filePath, mapping, preparsed, deps);
  return findings === null ? null : findings.map(findingToDiagnosticItem);
}

// ---- Rust 面(AUDIT-005 B2 车道批 3:receiverNone 收编) ------------------------
// `$/kode/lint/analyzeReceiverNone` 经 gate.runInRust(与 analyzeSpaceNav/
// analyzeRoleMisuse 同口径):Rust 只回结构面(code/line/character/length +
// kind/receiver/methodName),消息渲染留本模块(l10n 单一来源);段错配的
// declared 由 TS 侧同一 mapping 快照重算——重算不构成错配 = 语义矛盾,
// 整面作废回 TS 兜底(禁止部分采用)。

/** Rust 结构面单条产物(`$/kode/lint/analyzeReceiverNone` 应答) */
export interface ReceiverNoneRustItem {
  code: string;
  line: number;
  character: number;
  length: number;
  /** 消息判别:receiverNone | sectionMismatch */
  kind: string;
  /** client | cell | base(消息与段错配重算都用) */
  receiver: string;
  methodName: string;
}

/** 结构面单条 → 诊断面(消息渲染);缺参/未知 kind/契约漂移 = 畸形 */
function renderRustReceiverNoneItem(
  item: ReceiverNoneRustItem,
  mapping: EntityMapping | undefined
): ReceiverDiagnosticItem | null {
  if (
    !item
    || typeof item.code !== 'string'
    || typeof item.kind !== 'string'
    || typeof item.line !== 'number'
    || typeof item.character !== 'number'
    || typeof item.length !== 'number'
    || typeof item.receiver !== 'string'
    || typeof item.methodName !== 'string'
    || item.methodName.length === 0
  ) {
    return null;
  }
  const receiver = item.receiver as PythonReceiverCall['receiver'];
  if (!(receiver in RECEIVER_NONE_SOURCES)) {
    return null;
  }
  if (
    !Number.isInteger(item.line) || !Number.isInteger(item.character) || !Number.isInteger(item.length)
    || item.line < 0 || item.character < 0 || item.length < 0
    || item.length !== item.methodName.length
  ) {
    return null;
  }
  if (item.kind === 'receiverNone') {
    if (item.code !== RECEIVER_NONE_DIAGNOSTIC_CODE) {
      return null;
    }
    return {
      range: {
        start: { line: item.line, character: item.character },
        end: { line: item.line, character: item.character + item.length }
      },
      message: renderReceiverNoneMessage(receiver),
      severity: 'Warning' as const,
      source: 'kbengine' as const,
      code: RECEIVER_NONE_DIAGNOSTIC_CODE
    };
  }
  if (item.kind === 'sectionMismatch') {
    if (item.code !== RECEIVER_SECTION_MISMATCH_DIAGNOSTIC_CODE) {
      return null;
    }
    if (!mapping) {
      return null; // 无映射不可能出段错配条(契约漂移)
    }
    const message = sectionMismatchMessage(receiver, item.methodName, mapping);
    if (!message) {
      return null; // TS 映射下不构成错配 = 语义矛盾,整面作废
    }
    return {
      range: {
        start: { line: item.line, character: item.character },
        end: { line: item.line, character: item.character + item.length }
      },
      message,
      severity: 'Warning' as const,
      source: 'kbengine' as const,
      code: RECEIVER_SECTION_MISMATCH_DIAGNOSTIC_CODE
    };
  }
  return null;
}

/**
 * 结构面数组 → 诊断面数组(消息渲染);任一条畸形返回 null(整面作废,调用方
 * 回 TS 兜底 —— 禁止部分采用)。对拍测试共用。
 */
export function renderRustReceiverNoneItems(
  items: readonly unknown[],
  mapping: EntityMapping | undefined
): ReceiverDiagnosticItem[] | null {
  const rendered: ReceiverDiagnosticItem[] = [];
  for (const item of items) {
    const renderedItem = renderRustReceiverNoneItem(item as ReceiverNoneRustItem, mapping);
    if (!renderedItem) {
      return null;
    }
    rendered.push(renderedItem);
  }
  return rendered;
}
