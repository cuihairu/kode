import { maskPythonNonCode } from './pythonLexicalMask';
import { l10nText } from '../nlsRuntime';
import { inferSelfAttributeFlow, type SelfAttributeFlowOptions } from './selfAttributeFlowTypes';

/**
 * LANG-NAR-1 语义引擎流敏感窄化(用户令 2026-11-02)——诊断面:
 * 用户自管属性 self.<attr>(非 .def 声明、非内建 receiver)的成员访问/方法调用,
 * 当该属性流敏感类型含 None 且无判空守卫时报 Warning(镜像 receiverNone 的
 * 判定语义:有 None 证据才报,窄化生效即不报)。
 *
 * 与 receiverNone 的边界:receiverNone 只查 self.cell/base/client(引擎 getter
 * 可为 None);本诊断查任意自管属性——凡流类型含 None(如 __init__ `= None`
 * 且未被后续赋值覆盖、或类级 `X = None`)且查询位未窄化即报。def 声明属性
 * 经 GEN-DEF-1a/1b 口径恒非 Optional,流引擎无 None 证据自然不报(无需特判)。
 *
 * 纯函数面(文本 + 可选回调),零 vscode 依赖,供诊断调度器同步/异步消费。
 */

export const ATTRIBUTE_NONE_DIAGNOSTICS_ENABLED_DEFAULT = true;
export const ATTRIBUTE_NONE_DIAGNOSTIC_CODE = 'kbengine.attributeNone';

/** 内建 receiver 属性(receiverNone 专责,此处跳过避免重复/口径分叉) */
const BUILTIN_RECEIVERS = new Set(['cell', 'base', 'client']);

export interface SelfAttributeNoneFinding {
  /** 0 起行(成员访问所在行) */
  line: number;
  /** 0 起列(成员 token 起) */
  character: number;
  attr: string;
  member: string;
  message: string;
}

/** `self.<attr>.<member>`(成员访问/方法调用;attr 非内建 receiver) */
const SELF_MEMBER_ACCESS = /\bself\.([A-Za-z_]\w*)\.([A-Za-z_]\w*)/g;

function buildMessage(attr: string, member: string): string {
  return l10nText(
    'self.{attr} may be None: check for None before accessing/calling {member} (self-managed property, __init__/class-level declaration includes None and the current position is not narrowed)',
    { attr, member }
  );
}

/** 消息模板单一来源导出(Rust 面渲染与对拍测试共用;Rust 只回结构面) */
export const renderAttributeNoneMessage = buildMessage;

/**
 * KODE-PERF-002:一次行起始偏移表(每 '\n' 后一位置;0 起行 0 从 0)。
 * 与旧口径 `slice(0, index).split('\n').length - 1` 等值——行号='\n' 计数
 * ('\r' 留在行尾不影响计数,CRLF/LF 同值);g 正则匹配 index 单调递增,配
 * 双指针整体 O(n),替代每匹配 O(index) 切片分裂的平方级。
 */
function buildLineStarts(source: string): number[] {
  const starts: number[] = [0];
  for (let offset = 0; offset < source.length; offset += 1) {
    if (source.charCodeAt(offset) === 10) {
      starts.push(offset + 1);
    }
  }
  return starts;
}

/**
 * 全量计算:无判空窄化的自管属性成员访问(Warning)。纯函数(文本 + 回调)。
 * 逐访问按 (行, 属性) 记忆化流类型——同一访问行同属性只推一次。
 */
export function computeSelfAttributeNoneFindings(
  source: string,
  options?: SelfAttributeFlowOptions,
  versionKey?: string
): SelfAttributeNoneFinding[] {
  // KR-AUD-58:匹配跑词法掩码文本(注释/字符串字面量替换为同长空白,行/列
  // 偏移不变)——原文行匹配会把字符串/注释里的 self.x.y 提及当真实访问误报。
  const masked = maskPythonNonCode(source);
  const lines = masked.split(/\r?\n/);
  const findings: SelfAttributeNoneFinding[] = [];
  const memo = new Map<string, boolean>();
  // KODE-PERF-002:行起始偏移表一次建好,匹配 index 单调递增 → 双指针推进
  const lineStarts = buildLineStarts(masked);
  let lineStartIdx = 0;
  SELF_MEMBER_ACCESS.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SELF_MEMBER_ACCESS.exec(masked)) !== null) {
    const attr = match[1];
    if (BUILTIN_RECEIVERS.has(attr)) {
      continue;
    }
    // 行内计算匹配的 0 起行号与成员列
    while (lineStartIdx + 1 < lineStarts.length && lineStarts[lineStartIdx + 1] <= match.index) {
      lineStartIdx += 1;
    }
    const line = lineStartIdx;
    const member = match[2];
    // 成员列 = 匹配起点 + `self.<attr>.` 长度
    const memberCharacter = match.index + match[0].indexOf(member);
    const key = `${line}\u0000${attr}`;
    if (!memo.has(key)) {
      // KODE-PERF-001:版本键传入 → 同版本多次流查询共享一次解析。
      const flow = inferSelfAttributeFlow(lines, line, attr, options, versionKey);
      memo.set(key, flow !== null && flow.hasNone);
    }
    if (memo.get(key)) {
      findings.push({
        line,
        character: memberCharacter,
        attr,
        member,
        message: buildMessage(attr, member)
      });
    }
  }
  return findings;
}

/** 测试面:诊断数据项(免 vscode 依赖;开关门由调用方控制) */
export function attributeNoneDiagnosticItems(
  source: string,
  options?: SelfAttributeFlowOptions,
  versionKey?: string
): SelfAttributeNoneFinding[] {
  return computeSelfAttributeNoneFindings(source, options, versionKey);
}

// ---- Rust 词法面(AUDIT-005 B2 车道批 6:attributeNone 收编;批 2 流证据内联) ----
// `$/kode/lint/analyzeAttributeNone` 经 gate.runInRust(与 receiverNone/
// postDestroy 同口径):入参 text 为 TS 预掩码文本(maskPythonNonCode 输出,注释/
// 字符串已换同长空白)+ versionKey(直传 KODE-PERF-001 版本键控解析缓存),Rust
// 回词法结构面(line/character/length/attr/member,成员列沿用 match[0].indexOf
// 首次出现语义)+ **逐项内联流事实**(flow:{types,annotation,hasNone,narrowed},
// 引擎 kode-python::self_flow 与 typeInlayHints 同源,每 (行,属性) 一次查询)。
// 本侧 render 退位为事实校验(types 字符串数组/annotation null 或串/两布尔)+
// 同 (行,属性) 流事实矛盾整面作废(禁止部分采用);兜底
// computeSelfAttributeNoneFindings 仍走 TS 引擎自算。对拍测试共用。

const ATTRIBUTE_NAME_PATTERN = /^[A-Za-z_]\w*$/;

/**
 * Rust 词法结构面+内联流事实 → findings(hasNone 事实为裁定依据,才报;窄化/
 * 无证据剔除但面合法)。逐条校验:code/attr/member 形态/length===member.length/
 * 非负整数/内建 receiver(Rust 漏跳=契约漂移)/flow 四字段,同 (行,属性) 流
 * 事实互相矛盾 → 整面作废返回 null(调用方回 TS 兜底,禁止部分采用)。
 * 对拍测试共用。
 */
export function renderAttributeNoneRustItems(
  items: readonly unknown[]
): SelfAttributeNoneFinding[] | null {
  const memo = new Map<string, boolean>();
  const findings: SelfAttributeNoneFinding[] = [];
  for (const item of items) {
    if (item === null || typeof item !== 'object') {
      return null;
    }
    const record = item as Record<string, unknown>;
    if (record.code !== ATTRIBUTE_NONE_DIAGNOSTIC_CODE) {
      return null;
    }
    const attr = record.attr;
    if (typeof attr !== 'string' || !ATTRIBUTE_NAME_PATTERN.test(attr)) {
      return null;
    }
    const member = record.member;
    if (typeof member !== 'string' || !ATTRIBUTE_NAME_PATTERN.test(member)) {
      return null;
    }
    if (BUILTIN_RECEIVERS.has(attr)) {
      return null; // Rust 漏跳内建 receiver = 契约漂移,整面作废
    }
    const length = record.length;
    if (typeof length !== 'number' || !Number.isInteger(length) || length !== member.length) {
      return null;
    }
    for (const value of [record.line, record.character]) {
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
        return null;
      }
    }
    const line = record.line as number;
    // 批 2:流证据随项内联(Rust 引擎同源);null/畸形 = 契约漂移整面作废
    const flow = record.flow;
    if (flow === null || typeof flow !== 'object') {
      return null;
    }
    const face = flow as Record<string, unknown>;
    if (!Array.isArray(face.types) || face.types.some(entry => typeof entry !== 'string')) {
      return null;
    }
    if (face.annotation !== null && typeof face.annotation !== 'string') {
      return null;
    }
    if (typeof face.hasNone !== 'boolean' || typeof face.narrowed !== 'boolean') {
      return null;
    }
    const key = `${line}\u0000${attr}`;
    const reported = face.hasNone as boolean;
    if (memo.has(key)) {
      if (memo.get(key) !== reported) {
        // 同 (行,属性) 流事实互相矛盾 = 契约漂移,整面作废
        return null;
      }
    } else {
      memo.set(key, reported);
    }
    if (reported) {
      findings.push({
        line,
        character: record.character as number,
        attr,
        member,
        message: buildMessage(attr, member)
      });
    }
  }
  return findings;
}
