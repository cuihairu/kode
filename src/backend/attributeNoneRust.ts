/**
 * attributeNone diagnostics incorporated into Rust (AUDIT-005 B2 lane batch 6;
 * batch 2 inlines the flow evidence): the TS assembly surface for
 * `$/kode/lint/analyzeAttributeNone`. The lexical scan plus per-item inline
 * flow facts (flow:{types,annotation,hasNone,narrowed}, same source in the
 * engine as kode-python::self_flow and typeInlayHints) all live in Rust; this
 * module only does: cheap precheck (zero `self.` leads in the raw text means
 * zero output, and no RPC is sent — masking only shrinks the lead set, so no
 * leads in the raw text means no leads after masking) -> masking (maskPythonNonCode
 * is the single source) -> gate.runInRust (the masked text plus versionKey
 * passed straight through to the KODE-PERF-001 version-keyed parse cache) ->
 * the structure surface plus flow facts validated and rendered by
 * renderAttributeNoneRustItems (message rendering happens on this side;
 * malformed input / builtin drift / flow-fact contradictions void the whole
 * surface). Unavailable/failed/malformed returns null, and the caller (the
 * attributeNone arm of diagnostics.ts) falls back to TS — partial adoption is
 * forbidden (it would silently lose capability).
 */
import { maskPythonNonCode } from './pythonLexicalMask';
import { getKodeCoreShadowGate } from './kodeCoreShadowFaces';
import {
  renderAttributeNoneRustItems,
  type SelfAttributeNoneFinding
} from './selfAttributeNoneDiagnostics';

const ATTRIBUTE_NONE_RUST_METHOD = '$/kode/lint/analyzeAttributeNone';

/**
 * Rust-first attributeNone product: gate.runInRust runs
 * `$/kode/lint/analyzeAttributeNone`, and the structure surface plus the inline
 * flow facts are validated and rendered by renderAttributeNoneRustItems; no
 * gate / zero leads / failure / malformed returns null (the legitimate empty
 * surface [] for zero leads is the same output as the fallback, so no RPC is
 * sent for nothing).
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
