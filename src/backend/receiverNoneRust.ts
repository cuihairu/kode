/**
 * receiverNone 诊断收编 Rust(AUDIT-005 B2 车道批 3):`$/kode/lint/analyzeReceiverNone`
 * 的 TS 装配面。guard 分析/别名使用点/段错配判定在 Rust(receiver_none.rs,掩码
 * 与逐语义同 TS),本模块只做:廉价预检(零 receiver 线索零产出,不取解析不发
 * RPC)→ 解析面供给方法区间(parsePythonFile 是共享上游,与 roleMisuse 的 face
 * 同口径)→ mapping.methods 投影 declarations → gate.runInRust → 结构面经
 * renderRustReceiverNoneItems 渲染。不可用/解析中止/失败/畸形返回 null,调用方
 * (diagnostics.ts receiver 臂)回 TS 异步兜底——禁止部分采用(静默丢能力)。
 */
import type { EntityMapping } from '../entityMapping';
import { findPythonReceiverCalls } from './pythonLanguageUtils';
import { getKodeCoreShadowGate } from './kodeCoreShadowFaces';
import { maskPythonNonCode } from './pythonLexicalMask';
import {
  RECEIVER_ALIAS_HINT,
  renderRustReceiverNoneItems,
  type AsyncPreparsedPythonProvider,
  type ReceiverDiagnosticItem
} from './receiverNoneDiagnostics';
import { type ParsedPythonFile } from './pythonParser';
import { parsePythonFileResponsive } from './pythonParserWorkerHost';

const RECEIVER_NONE_RUST_METHOD = '$/kode/lint/analyzeReceiverNone';

/** 解析面解析(与 receiverNoneDiagnostics.resolveParsedAsync 同语义:提供器
 * 优先(可异步/可 null),无提供器自解析同样 worker 分流) */
async function resolveParsed(
  text: string,
  filePath: string,
  preparsed?: AsyncPreparsedPythonProvider
): Promise<ParsedPythonFile | null> {
  if (typeof preparsed === 'function') {
    return preparsed();
  }
  if (preparsed !== undefined) {
    return preparsed;
  }
  const responsive = await parsePythonFileResponsive(text, filePath, 0);
  return responsive.parsed;
}

/**
 * Rust-first receiverNone 产物:gate.runInRust 跑 `$/kode/lint/analyzeReceiverNone`,
 * 结构面经 renderRustReceiverNoneItems 渲染;无门/零线索(合法空面 [])/解析
 * 中止/失败/畸形返回 null(零线索面直接 [],与 TS 兜底同输出,不空发 RPC)。
 */
export async function buildReceiverNoneItemsWithRust(
  text: string,
  filePath: string,
  mapping: EntityMapping | undefined,
  preparsed?: AsyncPreparsedPythonProvider
): Promise<ReceiverDiagnosticItem[] | null> {
  const gate = getKodeCoreShadowGate();
  if (!gate) {
    return null;
  }
  // 廉价预检(与 computeReceiverNoneFindings 同口径):掩码一次 + 线性扫描,
  // 零 receiver 线索零产出,不取解析也不发 RPC(懒解析语义保持)
  const masked = maskPythonNonCode(text);
  const baseCalls = findPythonReceiverCalls(masked);
  if (baseCalls.length === 0 && !RECEIVER_ALIAS_HINT.test(masked)) {
    return [];
  }
  const parsed = await resolveParsed(text, filePath, preparsed);
  if (!parsed) {
    return null; // 共享解析不可用:本轮中止(调用方兜底臂同样中止,同语义)
  }
  const methods = parsed.classes.map(cls => ({
    startLine: cls.startLine,
    endLine: cls.endLine,
    defLines: [...cls.methods.values()].map(location => location.line)
  }));
  const declarations: Record<string, string[]> = {};
  if (mapping?.methods) {
    for (const [name, locations] of Object.entries(mapping.methods)) {
      declarations[name] = locations.map(location => location.section);
    }
  }
  const response = await gate.runInRust<unknown>(RECEIVER_NONE_RUST_METHOD, {
    text,
    methods,
    declarations
  });
  if (!response.ok) {
    return null;
  }
  const items = (response.result as { items?: unknown }).items;
  if (!Array.isArray(items)) {
    return null;
  }
  return renderRustReceiverNoneItems(items, mapping);
}
