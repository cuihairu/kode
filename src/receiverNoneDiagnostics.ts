import type { EntityMapping } from './entityMapping';
import {
  PYTHON_RECEIVER_SECTIONS,
  findPythonReceiverCalls,
  type PythonReceiverCall
} from './pythonLanguageUtils';
import { parsePythonFile } from './pythonParser';
import { parsePythonFileResponsive } from './pythonParserWorkerHost';

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

/** 正向 guard 行判定:`if x:` / `if x is not None:`(x 为接收者或其本地
 * 别名)。2026-10-30 用户令:链式 `if ok and self.client:` 已判空不得再报——
 * 条件按顶层 `and` 分拆,任一完整分句恰为 `x` 或 `x is not None` 即认;
 * `or` 分句不算(`if ok or self.client:` 不保证非 None,仍报)。subject 传
 * 转义形(同 earlyExitGuard 口径),比较前解转义回原文。 */
const unescapeSubject = (subject: string): string => subject.replace(/\\\./g, '.');

const isPositiveGuardLine = (subject: string, text: string): boolean => {
  const condition = /^\s*if\s+([^:]*):/.exec(text)?.[1];
  if (condition === undefined) {
    return false;
  }
  const target = unescapeSubject(subject);
  return condition.split(/\s+and\s+/).some(part => {
    const trimmed = part.trim();
    return trimmed === target || trimmed === `${target} is not None`;
  });
};

/** 早退 guard:`if not x:` / `if x is None:`(块体内 return/raise 才算) */
const earlyExitGuard = (subject: string): RegExp =>
  new RegExp(`^\\s*if\\s+(?:not\\s+${subject}|${subject}\\s+is\\s+None)\\s*:`);

const hasattrGuard =
  /^\s*if\s+hasattr\(self,\s*['"](cell|base|client)['"]\s*\)\s*:/;

/** 接收者本地别名:`x = self.<role>`(其后 `if x:` 一族算 guard) */
const aliasAssignment = /^\s*([A-Za-z_]\w*)\s*=\s*self\.(cell|base|client)\s*(?:#.*)?$/;

const escapeSubject = (subject: string): string => subject.replace(/\./g, '\\.');

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
 * a) 正向 if(`if self.cell:`/`if self.cell is not None:`/别名同形/hasattr)
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
  /** 正向 guard:if 块的闭合行(首个缩进 ≤ ifIndent 的非空行;无则方法体界+1)。
   * use 行 < blockEnd 即仍在块体内(2026-10-28 审核整改:预计算一次,逐调用零重扫) */
  blockEnd?: number;
  /** 早退 guard:块体内首个 return/raise 行(去缩进前;无则 undefined)。
   * exitLine < use 行即早退生效 */
  exitLine?: number;
}

interface MethodGuardScan {
  receiver: PythonReceiverCall['receiver'];
  candidates: GuardCandidate[];
  /** 别名赋值行与名(`x = self.<role>`),同行闸判定按 use 之前的过滤 */
  aliases: Array<{ line: number; name: string }>;
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

/** 单趟扫方法体:维持存活 subject 集(self.<role> 起步,遇别名赋值追加),
 * 命中正向/早退 guard 形态的行记为候选 */
function scanGuardCandidates(
  lines: readonly string[],
  span: MethodSpan,
  receiver: PythonReceiverCall['receiver']
): MethodGuardScan {
  guardPrefixScanCount += 1;
  const candidates: GuardCandidate[] = [];
  const aliases: Array<{ line: number; name: string }> = [];
  const subjects = new Set([escapeSubject(`self.${receiver}`)]);
  for (let j = span.startLine; j <= span.endLine; j += 1) {
    const text = lines[j];
    if (COMMENT_ONLY.test(text)) { continue; }
    const assigned = aliasAssignment.exec(text);
    if (assigned && assigned[2] === receiver) {
      subjects.add(escapeSubject(assigned[1]));
      aliases.push({ line: j, name: assigned[1] });
      continue; // 别名赋值行本身不是 guard 行
    }
    let matched = false;
    for (const subject of subjects) {
      if (isPositiveGuardLine(subject, text) || hasattrGuard.test(text)) {
        candidates.push({ line: j, indent: indentOf(text), kind: 'positive' });
        matched = true;
        break;
      }
      if (earlyExitGuard(subject).test(text)) {
        candidates.push({ line: j, indent: indentOf(text), kind: 'early-exit' });
        matched = true;
        break;
      }
    }
    if (matched) { continue; }
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
  return { receiver, candidates, aliases };
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

/** if 块体内首个 return/raise 行(缩进 > ifIndent;遇去缩进行即块闭,终止) */
function firstExitAfter(
  lines: readonly string[],
  span: MethodSpan,
  candidate: GuardCandidate
): number | undefined {
  guardBlockProbeCount += 1;
  for (let j = candidate.line + 1; j <= span.endLine; j += 1) {
    const text = lines[j];
    if (COMMENT_ONLY.test(text)) { continue; }
    if (indentOf(text) <= candidate.indent) { return undefined; }
    if (/\b(return|raise)\b/.test(text)) { return j; }
  }
  return undefined;
}

/** 候选过闸:与逐点遍历同谓词,但块界/早退位置已扫描期预计算——逐调用
 * 只比位置(candidate.line < use < blockEnd / exitLine < use),零文本重扫 */
function hasReceiverGuardFromScan(
  lines: readonly string[],
  scan: MethodGuardScan,
  useLine: number
): boolean {
  const useIndent = indentOf(lines[useLine]);
  for (const candidate of scan.candidates) {
    if (candidate.line >= useLine) { continue; }
    if (candidate.kind === 'positive') {
      if (candidate.indent < useIndent && (candidate.blockEnd ?? 0) > useLine) {
        return true;
      }
    } else if (candidate.indent <= useIndent && candidate.exitLine !== undefined && candidate.exitLine < useLine) {
      return true;
    }
  }
  // 同行 guard:`if self.cell: self.cell.send(...)` / `self.cell.x() if self.cell else ...`
  const useText = lines[useLine];
  for (const subject of scanSubjectsUpTo(scan, useLine)) {
    const sameLineIf = new RegExp(`^\\s*if\\s+${subject}\\b[^:]*:\\s*\\S`);
    const sameLineTernary = new RegExp(`\\bif\\s+${subject}\\s*(is\\s+not\\s+None)?\\s+else\\b`);
    if (sameLineIf.test(useText) || sameLineTernary.test(useText)) {
      return true;
    }
  }
  return false;
}

/** 同行闸的 subject 集:接收者本体 + use 之前赋值的别名 */
function scanSubjectsUpTo(scan: MethodGuardScan, useLine: number): string[] {
  const subjects = [escapeSubject(`self.${scan.receiver}`)];
  for (const alias of scan.aliases) {
    if (alias.line < useLine) { subjects.push(escapeSubject(alias.name)); }
  }
  return subjects;
}

const indentOf = (line: string): number => {
  const match = /^[ \t]*/.exec(line);
  return match ? match[0].replace(/\t/g, '    ').length : 0;
};

/** .def 段错配:方法在 def 声明了,但没有任何一处在接收者对应的 section */
function sectionMismatch(call: PythonReceiverCall, mapping: EntityMapping): string | undefined {
  const expected = PYTHON_RECEIVER_SECTIONS[call.receiver];
  const declarations = mapping.methods?.[call.methodName] ?? [];
  if (declarations.length === 0) { return undefined; }
  if (declarations.some(declaration => declaration.section === expected)) { return undefined; }
  const declared = [...new Set(declarations.map(declaration => declaration.section))].join('/');
  return `self.${call.receiver}.${call.methodName} 段错配:${call.methodName} 在 .def 声明于 ${declared},`
    + `经 ${call.receiver} 侧调用不会路由到该方法(应走 ${expected} 声明)`;
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
        message: `self.${call.receiver} 可能为 None(玩家离线/掉线后引擎直接返回 None,`
          + `onClientDeath/onLoseCell → S_RELEASE),引用前需判空;引擎源码:${RECEIVER_NONE_SOURCES[call.receiver]}`
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
}

function buildEvalContextFromParsed(
  text: string,
  parsed: ReturnType<typeof parsePythonFile>
): ReceiverEvalContext {
  const methodSpans = buildMethodSpans(parsed);
  const lines = text.split(/\r?\n/);
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
  return { lines, methodSpans, scanFor };
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
  const calls = findPythonReceiverCalls(text);
  if (calls.length === 0) return [];
  const parsed = typeof preparsed === 'function'
    ? preparsed()
    : preparsed ?? parsePythonFile(text, filePath);
  const context = buildEvalContextFromParsed(text, parsed);
  const findings: ReceiverNoneFinding[] = [];
  appendCallFindings(calls, context.lines, context.methodSpans, context.scanFor, mapping, findings);
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
  const calls = findPythonReceiverCalls(text);
  if (calls.length === 0) { return []; }
  const parsed = await resolveParsedAsync(text, filePath, preparsed);
  if (!parsed) {
    return null; // 本轮共享解析不可用:中止,不产出,不回退宿主同步解析
  }
  if (deps.shouldContinue && !deps.shouldContinue()) {
    return null; // 解析等待期间版本已前进:旧版本回包由调用方丢弃
  }
  const context = buildEvalContextFromParsed(text, parsed);
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
  let end = line + 1;
  while (end < lines.length) {
    const current = lines[end];
    if (!COMMENT_ONLY.test(current) && indentOf(current) < useIndent) {
      break;
    }
    end += 1;
  }
  // 回退块尾的尾随空行/注释(块中段空白保留,尾随的不包进缩进)
  while (end > line + 1 && COMMENT_ONLY.test(lines[end - 1])) {
    end -= 1;
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
