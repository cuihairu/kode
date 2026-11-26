/**
 * rpcArgCount diagnostics absorbed into Rust (AUDIT-005 B2 lane batch 8): the
 * TS wiring face for `$/kode/lint/analyzeRpcArgCount`. Call-site discovery
 * (findPythonReceiverCalls walks masked text, column offsets unchanged), the
 * semantic gate (mapping.methods declaration cross-check / section matching /
 * star parameters) and message rendering all stay in TS as the single source;
 * Rust only does the actual-argument counting face (countCallArguments ported
 * verbatim, with its own string/comment lexical state over the raw text and a
 * bracket stack that crosses lines). counts aligns with the calls order,
 * null = unknown, a legal slot; a missing response / length mismatch / slot
 * that is not "non-negative integer or null" invalidates the whole face and
 * returns null (the caller falls back to local counting) — partial adoption is
 * forbidden.
 */
import { getKodeCoreShadowGate } from './kodeCoreShadowFaces';
import type { PythonReceiverCall } from './pythonLanguageUtils';

const RPC_ARG_COUNT_RUST_METHOD = '$/kode/lint/analyzeRpcArgCount';

/** Counting slot: a non-negative integer or null (unknown); malformed true */
const badSlot = (value: unknown): boolean =>
  value !== null && (typeof value !== 'number' || !Number.isInteger(value) || value < 0);

/**
 * Rust-first actual-argument counting: gate.runInRust runs
 * `$/kode/lint/analyzeRpcArgCount` with
 * params = {text (raw source), calls (discovery-face coordinates, a structural
 * subset)}; the response counts aligns with the calls order. No gate / failure /
 * malformed response returns null (no RPC is sent for empty calls; an empty
 * array is legal).
 */
export async function buildRpcArgCountsFromRust(
  text: string,
  calls: readonly PythonReceiverCall[]
): Promise<Array<number | null> | null> {
  const gate = getKodeCoreShadowGate();
  if (!gate) {
    return null;
  }
  if (calls.length === 0) {
    return [];
  }
  const response = await gate.runInRust<unknown>(RPC_ARG_COUNT_RUST_METHOD, {
    text,
    calls: calls.map(call => ({
      line: call.line,
      character: call.character,
      methodName: call.methodName
    }))
  });
  if (!response.ok) {
    return null;
  }
  const counts = (response.result as { counts?: unknown } | undefined)?.counts;
  if (!Array.isArray(counts) || counts.length !== calls.length) {
    return null;
  }
  for (const slot of counts) {
    if (badSlot(slot)) {
      return null;
    }
  }
  return counts as Array<number | null>;
}
