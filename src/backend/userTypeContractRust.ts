/**
 * user_type triple-contract probing/collection absorbed into Rust (RUST-MIGRATION-
 * AUDIT-006 B1 lane batch 4): the TS wiring face of `$/kode/python/userTypeContract`.
 * The probe core (implFileHasContractMethod) and the missing-method collection core
 * (collectUserTypeContractMissing) are ported verbatim into Rust; the registry half
 * (types.xml/alias.xml parsing, impl-line locating, and file reading = definition-
 * Workspace host binding) stays in TS — this module only assembles: snapshot
 * collection (statuses carry methods for the TS fall back; the RPC wire strips
 * methods and Rust re-probes from the verbatim sources) →
 * gate.runInRust({file, sources, statuses}) → items shape validation (message/method
 * ∈ the three methods/typeName/symbolName/symbolLength a non-negative integer/line a
 * non-negative integer/related a pair of strings; a malformed shape discards the
 * whole face) → items (line already attached). A status not bound to this file → a
 * legitimate empty face [] (no empty RPC is sent); no gate / failure / malformed →
 * null → the caller falls back to the TS collectUserTypeContractMissingByImplFile —
 * partial adoption is forbidden; the kill switch kbengine.core.backend=ts keeps its
 * semantics unchanged.
 */
import { readWorkspaceTextFile } from '../definitionWorkspace';
import {
  USER_TYPE_CONTRACT_METHODS,
  type UserTypeContractMethod,
  type UserTypeContractMissingItem,
  type UserTypeContractStatus
} from './userTypeContract';
import { getKodeCoreShadowGate } from './kodeCoreShadowFaces';

const USER_TYPE_CONTRACT_RUST_METHOD = '$/kode/python/userTypeContract';

const CONTRACT_METHOD_SET = new Set<string>(USER_TYPE_CONTRACT_METHODS);

/** One missing-method diagnostic item (line already attached; isomorphic to the TS collectUserTypeContractMissingByImplFile output) */
export type RustUserTypeContractMissingItem = UserTypeContractMissingItem & { line: number };

/**
 * Rust-first missing-method collection: no gate / failure / malformed → null (the
 * caller falls back to TS); a status not bound to the target file → a legitimate
 * empty face [] (no empty RPC is sent).
 */
export async function collectUserTypeContractMissingByImplFileFromRust(
  statuses: readonly UserTypeContractStatus[],
  implFile: string
): Promise<RustUserTypeContractMissingItem[] | null> {
  const gate = getKodeCoreShadowGate();
  if (!gate) {
    return null;
  }
  if (!statuses.some(status => status.implFile === implFile)) {
    return [];
  }
  const sources: Record<string, string> = {};
  for (const status of statuses) {
    if (status.implFile && sources[status.implFile] === undefined) {
      sources[status.implFile] = readWorkspaceTextFile(status.implFile);
    }
  }
  const response = await gate.runInRust<unknown>(USER_TYPE_CONTRACT_RUST_METHOD, {
    file: implFile,
    sources,
    statuses: statuses.map(status => {
      // methods is not sent over the wire: probing is redone in Rust from the verbatim sources (the TS snapshot's methods only serve the fall back)
      const wire: Record<string, unknown> = { name: status.name };
      if (status.implementedBy !== undefined) {
        wire.implementedBy = status.implementedBy;
      }
      if (status.implFile !== undefined) {
        wire.implFile = status.implFile;
      }
      if (status.implLine !== undefined) {
        wire.implLine = status.implLine;
      }
      return wire;
    })
  });
  if (!response.ok) {
    return null;
  }
  const items = (response.result as { items?: unknown }).items;
  if (!Array.isArray(items)) {
    return null;
  }
  const collected: RustUserTypeContractMissingItem[] = [];
  for (const item of items) {
    if (item === null || typeof item !== 'object') {
      return null;
    }
    const record = item as Record<string, unknown>;
    if (typeof record.message !== 'string') {
      return null;
    }
    if (typeof record.method !== 'string' || !CONTRACT_METHOD_SET.has(record.method)) {
      return null;
    }
    if (typeof record.typeName !== 'string' || typeof record.symbolName !== 'string') {
      return null;
    }
    if (
      typeof record.symbolLength !== 'number' ||
      !Number.isInteger(record.symbolLength) ||
      record.symbolLength < 0
    ) {
      return null;
    }
    if (typeof record.line !== 'number' || !Number.isInteger(record.line) || record.line < 0) {
      return null;
    }
    const related = record.related;
    if (related === null || typeof related !== 'object') {
      return null;
    }
    const relatedRecord = related as Record<string, unknown>;
    if (
      typeof relatedRecord.targetFile !== 'string' ||
      typeof relatedRecord.label !== 'string'
    ) {
      return null;
    }
    collected.push({
      message: record.message,
      method: record.method as UserTypeContractMethod,
      typeName: record.typeName,
      symbolName: record.symbolName,
      symbolLength: record.symbolLength,
      line: record.line,
      related: { targetFile: relatedRecord.targetFile, label: relatedRecord.label }
    });
  }
  return collected;
}
