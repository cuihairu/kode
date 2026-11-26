/**
 * Flow-sensitive self.<attr> type inference absorbed into Rust
 * (RUST-MIGRATION-AUDIT-006 B1 lane batch 1): the TS wiring face for
 * `$/kode/python/selfAttributeFlow`. The engine body is a verbatim port of the TS
 * selfAttributeFlowTypes.ts (kode-python self_flow.rs, including class span
 * extraction and the versionKey LRU parse cache); the TS engine is kept as the
 * fallback (the kbengine.core.backend=ts kill-switch semantics unchanged). The
 * input lines is the caller's line array verbatim (the inlay path passes raw
 * lines / the diagnostics path passes masked lines; Rust does not mask again),
 * queryLine/line numbers are 0-based, and versionKey is the opaque cache key
 * produced by flowVersionKeyForDocument. A missing/malformed flow in the
 * response (types not a string array / annotation neither null nor string /
 * either boolean missing) discards the whole face and returns null (the caller
 * falls back to the TS engine) — partial adoption is forbidden; Rust flow:null
 * and a TS engine null share the same criteria (empty attr / query line out of
 * range), and the wiring face pre-checks with the same criteria and short-circuits
 * without sending the RPC.
 */
import { getKodeCoreShadowGate } from './kodeCoreShadowFaces';

const SELF_ATTRIBUTE_FLOW_RUST_METHOD = '$/kode/python/selfAttributeFlow';

/** Rust flow facts face (same shape as the TS SelfAttributeFlow fields) */
export interface SelfAttributeFlowFace {
  types: string[];
  annotation: string | null;
  hasNone: boolean;
  narrowed: boolean;
}

/**
 * Rust-first flow-sensitive types: no gate / failure / malformed / invalid input
 * all return null (pure function fallback face). Empty attr / query line out of
 * range share the TS engine criteria and do not send the RPC.
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
