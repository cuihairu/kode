import type { EntityMapping } from './entityMapping';
import {
  PYTHON_RECEIVER_SECTIONS,
  findPythonReceiverCalls,
  type PythonReceiverCall
} from './pythonLanguageUtils';
import { parsePythonFile } from './pythonParser';

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

/** 正向 guard:`if x:` / `if x is not None:`(x 为接收者或其本地别名) */
const positiveGuard = (subject: string): RegExp =>
  new RegExp(`^\\s*if\\s+${subject}\\s*(is\\s+not\\s+None)?\\s*:`);

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
      if (positiveGuard(subject).test(text) || hasattrGuard.test(text)) {
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
  return { receiver, candidates, aliases };
}

/** 候选过闸:与逐点遍历同谓词(位置/缩进/块体),只对已收集候选判定 */
function hasReceiverGuardFromScan(
  lines: readonly string[],
  scan: MethodGuardScan,
  useLine: number
): boolean {
  const useIndent = indentOf(lines[useLine]);
  for (const candidate of scan.candidates) {
    if (candidate.line >= useLine) { continue; }
    if (candidate.kind === 'positive') {
      if (candidate.indent < useIndent && blockContains(lines, candidate.line, useLine, candidate.indent)) {
        return true;
      }
    } else if (candidate.indent <= useIndent && blockExits(lines, candidate.line, useLine, candidate.indent)) {
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

/** use 行是否仍在 if 块体内:j+1..useLine 之间无非空非注释行缩进 <= ifIndent */
function blockContains(
  lines: readonly string[],
  ifLine: number,
  useLine: number,
  ifIndent: number
): boolean {
  for (let j = ifLine + 1; j < useLine; j += 1) {
    const text = lines[j];
    if (COMMENT_ONLY.test(text)) { continue; }
    if (indentOf(text) <= ifIndent) { return false; }
  }
  return true;
}

/** if 块体内(j+1..stopLine 前、去缩进前)是否含 return/raise(早退)——
 * 早退只在 use 行之前发生才有保护作用,故止于 use 行 */
function blockExits(
  lines: readonly string[],
  ifLine: number,
  stopLine: number,
  ifIndent: number
): boolean {
  for (let j = ifLine + 1; j < stopLine; j += 1) {
    const text = lines[j];
    if (COMMENT_ONLY.test(text)) { continue; }
    if (indentOf(text) <= ifIndent) { break; }
    if (/\b(return|raise)\b/.test(text)) { return true; }
  }
  return false;
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

export function computeReceiverNoneFindings(
  text: string,
  filePath: string,
  mapping?: EntityMapping,
  preparsed?: PreparsedPythonProvider
): ReceiverNoneFinding[] {
  const calls = findPythonReceiverCalls(text);
  if (calls.length === 0) return [];
  const findings: ReceiverNoneFinding[] = [];
  const parsed = typeof preparsed === 'function'
    ? preparsed()
    : preparsed ?? parsePythonFile(text, filePath);
  const methodSpans = buildMethodSpans(parsed);
  const lines = text.split(/\r?\n/);
  // IDE-DIA-004:guard 前缀扫描按(方法区间, 接收者)一_methodMemo 一次,
  // 同方法同接收者的多处调用共享同一份候选
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
  return computeReceiverNoneFindings(text, filePath, mapping, preparsed).map(finding => ({
    range: {
      start: { line: finding.line, character: finding.character },
      end: { line: finding.line, character: finding.character + finding.methodName.length }
    },
    message: finding.message,
    severity: 'Warning' as const,
    source: 'kbengine' as const
  }));
}
