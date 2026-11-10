/**
 * attributeNone 诊断收编 Rust(AUDIT-005 B2 车道批 6):`$/kode/lint/analyzeAttributeNone`
 * 的 TS 装配面。词法扫描(掩码文本 `\bself.<attr>.<member>` 匹配 + 内建 receiver
 * 跳过 + 行列计算)在 Rust,本模块只做:廉价预检(原文零 `self.` 线索零产出,
 * 不发 RPC——掩码只减不增,原文无线索则掩码后必无线索)→ 掩码(maskPythonNonCode
 * 单一来源,同一份掩码文本既作 RPC 入参又作流查询行)→ gate.runInRust → 结构面
 * 经 renderAttributeNoneRustItems 渲染(流敏感 None 证据 TS 裁定 + 消息渲染,
 * 畸形/内建漂移整面作废)。不可用/失败/畸形返回 null,调用方(diagnostics.ts
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
 * 结构面经 renderAttributeNoneRustItems 渲染(流证据按 (行, 属性) 记忆化,
 * versionKey 直传 KODE-PERF-001 版本键控解析缓存);无门/零线索/失败/畸形返回
 * null(零线索合法空面 [] 与兜底同输出,不空发 RPC)。
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
  const response = await gate.runInRust<unknown>(ATTRIBUTE_NONE_RUST_METHOD, {
    text: masked
  });
  if (!response.ok) {
    return null;
  }
  const items = (response.result as { items?: unknown }).items;
  if (!Array.isArray(items)) {
    return null;
  }
  return renderAttributeNoneRustItems(items, masked, versionKey);
}
