/**
 * attributeNone 诊断收编 Rust(AUDIT-005 B2 车道批 6;批 2 流证据内联):
 * `$/kode/lint/analyzeAttributeNone` 的 TS 装配面。词法扫描 + 逐项内联流事实
 * (flow:{types,annotation,hasNone,narrowed},引擎 kode-python::self_flow 与
 * typeInlayHints 同源)都在 Rust,本模块只做:廉价预检(原文零 `self.` 线索
 * 零产出,不发 RPC——掩码只减不增,原文无线索则掩码后必无线索)→ 掩码
 * (maskPythonNonCode 单一来源)→ gate.runInRust(text 掩码文本 + versionKey
 * 直传 KODE-PERF-001 版本键控解析缓存)→ 结构面+流事实经
 * renderAttributeNoneRustItems 校验渲染(消息渲染本侧,畸形/内建漂移/流事实
 * 矛盾整面作废)。不可用/失败/畸形返回 null,调用方(diagnostics.ts
 * attributeNone 臂)回 TS 兜底——禁止部分采用(静默丢能力)。
 */
import { maskPythonNonCode } from './pythonLexicalMask';
import { getKodeCoreShadowGate } from './kodeCoreShadowFaces';
import {
  renderAttributeNoneRustItems,
  type SelfAttributeNoneFinding
} from './selfAttributeNoneDiagnostics';

const ATTRIBUTE_NONE_RUST_METHOD = '$/kode/lint/analyzeAttributeNone';

/**
 * Rust-first attributeNone 产物:gate.runInRust 跑 `$/kode/lint/analyzeAttributeNone`,
 * 结构面+内联流事实经 renderAttributeNoneRustItems 校验渲染;无门/零线索/失败/
 * 畸形返回 null(零线索合法空面 [] 与兜底同输出,不空发 RPC)。
 */
export async function buildAttributeNoneItemsWithRust(
  text: string,
  versionKey?: string
): Promise<SelfAttributeNoneFinding[] | null> {
  const gate = getKodeCoreShadowGate();
  if (!gate) {
    return null;
  }
  if (!text.includes('self.')) {
    return [];
  }
  const masked = maskPythonNonCode(text);
  const params: Record<string, unknown> = { text: masked };
  if (versionKey !== undefined) {
    params.versionKey = versionKey;
  }
  const response = await gate.runInRust<unknown>(ATTRIBUTE_NONE_RUST_METHOD, params);
  if (!response.ok) {
    return null;
  }
  const items = (response.result as { items?: unknown }).items;
  if (!Array.isArray(items)) {
    return null;
  }
  return renderAttributeNoneRustItems(items);
}
