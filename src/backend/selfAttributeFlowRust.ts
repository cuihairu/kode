/**
 * 流敏感 self.<attr> 类型收编 Rust(RUST-MIGRATION-AUDIT-006 B1 车道批 1):
 * `$/kode/python/selfAttributeFlow` 的 TS 装配面。引擎本体=TS
 * selfAttributeFlowTypes.ts 逐字移植(kode-python self_flow.rs,含类跨度提取
 * 与 versionKey LRU 解析缓存);TS 引擎保留为兜底(kbengine.core.backend=ts
 * 杀开关语义不变)。入参 lines 为调用方行数组原样(inlay 路原文行/诊断路掩码
 * 行,Rust 不二次掩码),queryLine/行号 0 基,versionKey 为
 * flowVersionKeyForDocument 产物的不透明缓存键。响应 flow 缺失/畸形
 * (types 非字符串数组/annotation 非 null 或串/两布尔缺失)整面弃用返回
 * null(调用方回 TS 引擎)——禁止部分采用;Rust flow:null 与 TS 引擎
 * 返回 null 同判据(attr 空/查询行越界),装配面预检同判据先行短路不发 RPC。
 */
import { getKodeCoreShadowGate } from './kodeCoreShadowFaces';

const SELF_ATTRIBUTE_FLOW_RUST_METHOD = '$/kode/python/selfAttributeFlow';

/** Rust 流事实面(与 TS SelfAttributeFlow 字段同形) */
export interface SelfAttributeFlowFace {
  types: string[];
  annotation: string | null;
  hasNone: boolean;
  narrowed: boolean;
}

/**
 * Rust-first 流敏感类型:无门/失败/畸形/非法入参一律 null(纯函数回退面)。
 * attr 空/查询行越界与 TS 引擎判据一致,不发 RPC。
 */
export async function inferSelfAttributeFlowFromRust(
  lines: readonly string[],
  queryLine: number,
  attr: string,
  versionKey?: string
): Promise<SelfAttributeFlowFace | null> {
  const gate = getKodeCoreShadowGate();
  if (!gate) {
    return null;
  }
  if (!attr || queryLine < 0 || queryLine >= lines.length) {
    return null;
  }
  const params: Record<string, unknown> = { lines, queryLine, attr };
  if (versionKey !== undefined) {
    params.versionKey = versionKey;
  }
  const response = await gate.runInRust<unknown>(SELF_ATTRIBUTE_FLOW_RUST_METHOD, params);
  if (!response.ok) {
    return null;
  }
  const flow = (response.result as { flow?: unknown } | undefined)?.flow;
  if (flow === null) {
    return null;
  }
  if (typeof flow !== 'object') {
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
  return {
    types: face.types as string[],
    annotation: face.annotation,
    hasNone: face.hasNone,
    narrowed: face.narrowed
  };
}
