// C-17: wiring surface for the Rust-authoritative definition-time mismatch
// warning for process topology -- `$/kode/processTopology/validate`.
//
// Boundary (mirrors defMd5Rust/databaseSchemaRust "input collection stays in
// TS, validation belongs to Rust"): the manifest text + entities.xml text + the
// set of def texts are passed straight over RPC, and Rust parses the manifest,
// derives entity contents (closure walk), runs the M1-M6/D1-D3/O1-O2 rules and
// returns precisely located findings. When Rust is unavailable (no gate / no
// serverPath configured / call failure / shape mismatch) this returns null and
// the caller stays silent with zero findings (the diagnostics feature must not
// block; errors do not surface on the diagnostics face). There is no TS mirror --
// Rust is the single implementation.

import { getKodeCoreShadowGate } from './kodeCoreShadowFaces';

/** Rust `$/kode/processTopology/validate` inputs (mirrors BuildParams) */
export interface ProcessTopologyRustParams {
  /** raw text of `<root>/process_topology.xml` */
  manifestText: string;
  /** raw text of `scripts/entities.xml` (optional) */
  entitiesXmlText?: string;
  /** raw text of every def (entities/interfaces/components, for the closure walk) */
  defs: Array<{
    name: string;
    category: string;
    filePath: string;
    text: string;
  }>;
}

/** related information (relatedInformation payload) */
export interface ProcessTopologyRelated {
  filePath: string;
  line: number;
  message: string;
}

/** a single finding (raw diagnostic data; the TS side only maps locations) */
export interface ProcessTopologyFinding {
  /** "manifest" | "def" */
  target: string;
  filePath: string;
  /** 1-based line number */
  line: number;
  /** diagnostic severity (2=Warning) */
  severity: number;
  message: string;
  code: string;
  related?: ProcessTopologyRelated[];
}

/** Rust output: the findings array */
export interface ProcessTopologyRustResult {
  findings: ProcessTopologyFinding[];
}

/**
 * Process topology validation (via Rust): call once collection is done and the
 * findings are returned; returns null when Rust is unavailable / the call fails
 * / the shape mismatches. The diagnostics side treats null as zero findings
 * (the feature stays silent and never over-reports).
 */
export async function validateProcessTopologyInRust(
  params: ProcessTopologyRustParams
): Promise<ProcessTopologyRustResult | null> {
  const gate = getKodeCoreShadowGate();
  if (!gate) {
    return null;
  }
  const response = await gate.runInRust<ProcessTopologyRustResult>(
    '$/kode/processTopology/validate',
    {
      manifestText: params.manifestText,
      entitiesXmlText: params.entitiesXmlText ?? '',
      defs: params.defs
    }
  );
  if (!response.ok) {
    return null;
  }
  if (!shapeCheckProcessTopologyResult(response.result)) {
    return null;
  }
  return response.result;
}

function shapeCheckProcessTopologyResult(value: unknown): value is ProcessTopologyRustResult {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const result = value as Record<string, unknown>;
  if (!Array.isArray(result.findings)) {
    return false;
  }
  return result.findings.every(finding => {
    if (typeof finding !== 'object' || finding === null) {
      return false;
    }
    const item = finding as Record<string, unknown>;
    return (
      typeof item.target === 'string' &&
      typeof item.filePath === 'string' &&
      typeof item.line === 'number' &&
      typeof item.severity === 'number' &&
      typeof item.message === 'string' &&
      typeof item.code === 'string'
    );
  });
}
