// C-17: process topology findings -> diagnostic spec mapping (the pure-logic half, no vscode
// dependencies, unit-testable).
//
// Boundary: the findings (returned by Rust) carry 1-based line numbers and file paths; this
// module groups them by file and resolves the target URI (the manifest uses the sentinel
// "<manifest>" -> the real process_topology.xml path; a def uses its filePath) and produces
// the diagnostic specs; the extension side converts the spec plus the document text into a
// vscode.Range and publishes it into the dedicated collection `kbengine-process-topology`.

import type { ProcessTopologyFinding } from './processTopologyRust';

/** Sentinel path for the manifest file inside findings (a convention on the Rust side) */
export const MANIFEST_FINDING_SENTINEL = '<manifest>';

/** Diagnostic code prefix (the C-19 convention kbengine.<camelCase>) */
export const PROCESS_TOPOLOGY_DIAGNOSTIC_PREFIX = 'kbengine.processTopology';

/** A single diagnostic spec (location = a 1-based line number; converting to a Range on the extension side needs the document text) */
export interface ProcessTopologyDiagnosticSpec {
  /** fsPath of the target document */
  filePath: string;
  /** 1-based line number */
  line: number;
  message: string;
  code: string;
  /** Diagnostic severity (a vscode.DiagnosticSeverity number; 2=Warning) */
  severity: number;
  related: Array<{ filePath: string; line: number; message: string }>;
}

/**
 * findings -> diagnostic specs grouped by file.
 * `resolveManifestPath` swaps the sentinel "<manifest>" for the real manifest path (the
 * workspace root + process_topology.xml); a def finding uses its filePath directly.
 */
export function mapFindingsToDiagnostics(
  findings: ProcessTopologyFinding[],
  resolveManifestPath: () => string | null
): ProcessTopologyDiagnosticSpec[] {
  const specs: ProcessTopologyDiagnosticSpec[] = [];
  for (const finding of findings) {
    const filePath = resolveTargetPath(finding.filePath, resolveManifestPath);
    if (!filePath) {
      // The manifest path cannot be resolved (no workspace root) -> skip the entry rather than misreport.
      continue;
    }
    specs.push({
      filePath,
      line: Math.max(1, finding.line),
      message: finding.message,
      code: finding.code,
      severity: finding.severity,
      related: (finding.related ?? []).map(related => ({
        filePath: resolveTargetPath(related.filePath, resolveManifestPath) ?? related.filePath,
        line: Math.max(1, related.line),
        message: related.message
      }))
    });
  }
  return specs;
}

function resolveTargetPath(
  filePath: string,
  resolveManifestPath: () => string | null
): string | null {
  if (filePath === MANIFEST_FINDING_SENTINEL) {
    return resolveManifestPath();
  }
  return filePath;
}
