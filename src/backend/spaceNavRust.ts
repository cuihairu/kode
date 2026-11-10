/**
 * SP-4 空间导航诊断收编 Rust(AUDIT-005 B2 车道批 3):`$/kode/lint/analyzeSpaceNav`
 * 的 TS 装配面。纯分析在 spaceNavDiagnostics.ts(消息渲染/结构面),本模块只做
 * gate.runInRust + 结构面 → 诊断面(经 renderRustSpaceNavItems);Rust 不可用/
 * 失败/畸形返回 null,调用方(diagnostics.ts 空间导航臂)回 TS 同步兜底——
 * 禁止部分采用(静默丢能力)。
 */
import { getKodeCoreShadowGate } from './kodeCoreShadowFaces';
import {
  renderRustSpaceNavItems,
  type SpaceNavFinding
} from './spaceNavDiagnostics';

const SPACE_NAV_RUST_METHOD = '$/kode/lint/analyzeSpaceNav';

/**
 * Rust-first 空间导航产物:gate.runInRust 跑 `$/kode/lint/analyzeSpaceNav`,
 * 结构面经 renderRustSpaceNavItems 渲染;不可用/失败/畸形返回 null(调用方
 * 回 TS 兜底 computeSpaceNavFindings)。
 */
export async function buildSpaceNavItemsWithRust(
  text: string
): Promise<SpaceNavFinding[] | null> {
  const gate = getKodeCoreShadowGate();
  if (!gate) {
    return null;
  }
  const response = await gate.runInRust<unknown>(SPACE_NAV_RUST_METHOD, { text });
  if (!response.ok) {
    return null;
  }
  const items = (response.result as { items?: unknown }).items;
  if (!Array.isArray(items)) {
    return null;
  }
  return renderRustSpaceNavItems(items);
}
