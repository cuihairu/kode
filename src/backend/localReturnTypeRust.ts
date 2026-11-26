/**
 * Absorbing the local-variable return annotation into Rust (the precision main lane, batch D):
 * the TS wiring face for `$/kode/python/localReturnType`. The engine body =
 * kode-python local_return.rs (the same-file derivable subset of
 * TS pythonReturnTypeInference.ts after its cascade fallback was deleted: same-file def
 * calls / self methods / class qualification / chains / alias chains, with
 * matchingAssignments under the same-scope accounting); the TS chain keeps the import-binding
 * path as a fallback (the kill-switch semantics of kbengine.core.backend=ts are unchanged).
 * The input lines is the caller's line array as-is, hoverLine is 0-based, hoverColumn is a
 * 0-based UTF-16 column (absent = conservatively fall back to the line's first non-whitespace
 * column, never fabricating the line's last write point), and versionKey is an opaque cache
 * key produced by flowVersionKeyForDocument. A missing/malformed response ret (any of
 * target/annotation/methodName not a string) discards the whole face and returns null (hover
 * falls back to the TS chain) -- partial adoption is forbidden; Rust ret:null and a TS-chain
 * miss share the same criterion. The wiring face's pre-checks (empty word / all-uppercase
 * constant / out-of-range line) short circuit on the same criterion as the TS Impl guards,
 * without sending an RPC.
 */
import { awaitWithInteractiveBudget, getKodeCoreShadowGate } from './kodeCoreShadowFaces';

const LOCAL_RETURN_RUST_METHOD = '$/kode/python/localReturnType';

/**
 * End-to-end budget for an interactive request (KBUG-TIME-02): the total elapsed time from
 * issuance (including client.start/queuing/response) down to degrading to null. The transport
 * layer's hard timeout waits a further +2000ms beyond this budget for a fallback rejection
 * (explicitly accounting for the cleanup window, so resources are reclaimed as usual). The
 * background command face (messageTable/def lint etc.) does not go through this budget and
 * keeps its own semantics.
 */
export const LOCAL_RETURN_RUST_BUDGET_MS = 2000;

/** The Rust local return annotation face (same field shape as the TS LocalVariableReturnType) */
export interface LocalReturnTypeFace {
  target: string;
  annotation: string;
  methodName: string;
}

/**
 * Rust-first local variable return annotation: no gate / failure / malformed / illegal input
 * all yield null (the pure-function fallback face). An empty word / all-uppercase constant /
 * out-of-range line matches the TS chain's criterion and sends no RPC. The entire call
 * (including client.start/queuing/response) is bounded end to end by
 * LOCAL_RETURN_RUST_BUDGET_MS, degrading to null on expiry or when isCancelled() is true
 * (KBUG-TIME-03/04, no more unbounded waiting).
 */
export async function inferLocalReturnTypeFromRust(
  lines: readonly string[],
  hoverLine: number,
  word: string,
  versionKey?: string,
  isCancelled?: () => boolean,
  hoverColumn?: number
): Promise<LocalReturnTypeFace | null> {
  const gate = getKodeCoreShadowGate();
  if (!gate) {
    return null;
  }
  // The same guards as the TS Impl (an all-uppercase/underscore constant name is not queried)
  if (!word || hoverLine < 0 || hoverLine >= lines.length || /^[A-Z_][A-Z0-9_]*$/.test(word)) {
    return null;
  }
  const params: Record<string, unknown> = { lines, hoverLine, word };
  if (hoverColumn !== undefined) {
    // KBUG-ORDER-04: pass through the cursor column on the same line (0-based UTF-16; a negative value is not sent, and the Rust side makes the same conservative fallback)
    if (hoverColumn >= 0) {
      params.hoverColumn = hoverColumn;
    }
  }
  if (versionKey !== undefined) {
    params.versionKey = versionKey;
  }
  const response = await awaitWithInteractiveBudget(
    opts => gate.runInRust<unknown>(LOCAL_RETURN_RUST_METHOD, params, opts),
    LOCAL_RETURN_RUST_BUDGET_MS,
    isCancelled
  );
  if (!response || !response.ok) {
    return null;
  }
  const ret = (response.result as { ret?: unknown } | undefined)?.ret;
  if (ret === null || typeof ret !== 'object') {
    return null;
  }
  const face = ret as Record<string, unknown>;
  if (
    typeof face.target !== 'string' ||
    typeof face.annotation !== 'string' ||
    typeof face.methodName !== 'string'
  ) {
    return null;
  }
  return {
    target: face.target,
    annotation: face.annotation,
    methodName: face.methodName
  };
}
