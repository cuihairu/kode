/**
 * receiverNone diagnostics consolidated into Rust (AUDIT-005 B2 lane batch 3):
 * the TS wiring layer for `$/kode/lint/analyzeReceiverNone`. Guard analysis /
 * alias use points / section mismatch verdicts live in Rust
 * (receiver_none.rs, same masking and same semantics as TS); this module only
 * does: cheap pre-check (zero receiver clues means zero output; no parse
 * fetched, no RPC sent) -> parse-surface supply of the method spans
 * (parsePythonFile is the shared upstream, the same conventions as the
 * roleMisuse face) -> mapping.methods projected into declarations ->
 * gate.runInRust -> the structure surface rendered through
 * renderRustReceiverNoneItems. Unavailable/parse-aborted/failed/malformed
 * returns null and the caller (the receiver arm in diagnostics.ts) falls
 * back to the TS async path -- partial adoption is forbidden (silently
 * dropping the capability).
 */
import type { EntityMapping } from '../entityMapping';
import { pythonScriptDomain } from '../entityMapping';
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

/** Parse-surface resolution (same semantics as
 * receiverNoneDiagnostics.resolveParsedAsync: provider first (may be async /
 * may be null); without a provider, self-parsing also routes through the
 * worker) */
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
 * Rust-first receiverNone artifact: gate.runInRust runs
 * `$/kode/lint/analyzeReceiverNone` and the structure surface renders through
 * renderRustReceiverNoneItems; no gate / zero clues (a legitimate empty face
 * [) / parse aborted / failure / malformed returns null (a zero-clues face
 * returns [] directly, the same output as the TS fallback, so no empty RPC is
 * sent).
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
  // Cheap pre-check (same conventions as computeReceiverNoneFindings): one
  // masking pass + a linear scan; zero receiver clues means zero output, with
  // no parse fetched and no RPC sent (lazy-parse semantics preserved). The
  // per-surface semantic gate (deep audit 3): the caller surface goes down
  // with the RPC, and invalid face references are filtered out on the Rust
  // side under the same conventions
  const callerFace = pythonScriptDomain(filePath) ?? undefined;
  const masked = maskPythonNonCode(text);
  const baseCalls = findPythonReceiverCalls(masked, callerFace);
  if (baseCalls.length === 0 && !RECEIVER_ALIAS_HINT.test(masked)) {
    return [];
  }
  const parsed = await resolveParsed(text, filePath, preparsed);
  if (!parsed) {
    return null; // the shared parse is unavailable: abort this round (the caller's fallback arm aborts the same way, same semantics)
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
    declarations,
    callerFace
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
