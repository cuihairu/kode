/**
 * Per-file return-annotation extraction folded into Rust (RUST-MIGRATION-AUDIT-006 B1 lane
 * batch 3): the TS wiring surface of `$/kode/python/returnAnnotations`. The extraction core
 * (maskCodeLine/collectFileAnnotationFacts/extractFileImports/parseLocalAssignmentCall from
 * pythonReturnTypeInference.ts, ported verbatim, including single-line masking and the
 * first-definition-wins semantics) lives in Rust; this module only does: a cheap precheck (no
 * `def` substring in the source -> zero facts, no RPC sent) -> gate.runInRust({text: source}) ->
 * facts shape validation (array / non-empty-string names / annotation null or string; a malformed
 * whole face is discarded) -> the fact sequence. Import bindings and per-line call facts ride
 * along with the same RPC and the parity tests consume them directly; the production consumers
 * are the annotation fact buckets (cold build), while query cascades (matchingAssignments / import
 * bindings) stay in TS. Unavailable / failed / malformed returns null -> the caller falls back to
 * cooperative TS extraction -- partial adoption is forbidden; the kill switch
 * kbengine.core.backend=ts keeps its semantics unchanged.
 */
import { getKodeCoreShadowGate } from './kodeCoreShadowFaces';

const RETURN_ANNOTATIONS_RUST_METHOD = '$/kode/python/returnAnnotations';

/** One annotation fact (name = the method name; annotation=null means the def is there but `->` is missing) */
export interface RustReturnAnnotationFact {
  name: string;
  annotation: string | null;
}

/**
 * Rust-first annotation facts: no gate / zero `def` clue in the source / failure / malformed ->
 * null or a legitimately empty face ([] for zero clues, the same output as the fallback, no
 * wasted RPC).
 */
export async function extractFileReturnAnnotationFactsFromRust(
  source: string
): Promise<RustReturnAnnotationFact[] | null> {
  const gate = getKodeCoreShadowGate();
  if (!gate) {
    return null;
  }
  if (!source.includes('def')) {
    return [];
  }
  const response = await gate.runInRust<unknown>(RETURN_ANNOTATIONS_RUST_METHOD, {
    text: source
  });
  if (!response.ok) {
    return null;
  }
  const facts = (response.result as { facts?: unknown }).facts;
  if (!Array.isArray(facts)) {
    return null;
  }
  for (const fact of facts) {
    if (fact === null || typeof fact !== 'object') {
      return null;
    }
    const record = fact as Record<string, unknown>;
    if (typeof record.name !== 'string' || record.name.length === 0) {
      return null;
    }
    if (record.annotation !== null && typeof record.annotation !== 'string') {
      return null;
    }
  }
  return facts.map(fact => {
    const record = fact as { name: string; annotation: string | null };
    return { name: record.name, annotation: record.annotation };
  });
}
