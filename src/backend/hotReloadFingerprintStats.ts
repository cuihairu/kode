/**
 * Incremental fingerprint statistics (RUST-403 / former HR-HASH-016): makes
 * "editing a single file does not trigger a project-wide hash recomputation"
 * observable -- not by claiming incrementality, but by keeping the incremental
 * workload in an account:
 * - bytes read: bytes the fingerprint computation actually read (a single-file
 *   save is about that file's byte count; if the implementation degenerates into
 *   a project-wide rescan this number swells to the whole corpus and it is
 *   immediately visible);
 * - rehashed files: how many files were actually rehashed (a single-file save = 1);
 * - affected dependency nodes: affected nodes hit by the dependency traversal
 *   (the reverse-dependency closure for a changed custom type in types.xml,
 *   i.e. analyzeTypesImpact's affectedDefCount; a change in the entities.xml
 *   registry is a registry surface, not the dependency graph, and stays out of
 *   this account).
 *
 * The accounting scope is the **change-trigger surface** (def save /
 * fingerprint command / types.xml change); the display surface (CodeLens
 * lazy reads) only reads and never recomputes the baseline, so it is not
 * counted. Pure logic, zero vscode; the wiring layer owns it and its
 * lifetime follows the host.
 */

/** Read-only stats view (cumulative values; the wiring layer reads via view() and clears via reset()) */
export interface FingerprintStatsView {
  readonly bytesRead: number;
  readonly rehashedFiles: number;
  readonly affectedDependencyNodes: number;
}

/**
 * Fingerprint stats ledger: the cumulative face of three counters. Defensive
 * clamping (negative inputs are treated as 0) -- statistics are an
 * observation surface, not a verdict surface, so bad input neither throws
 * nor poisons the account.
 */
export class FingerprintStats {
  private bytes = 0;
  private files = 0;
  private nodes = 0;

  /** One fingerprint computation: bytesRead = bytes read this round, rehashedFiles = files rehashed this round (defaults to 1) */
  recordCompute(bytesRead: number, rehashedFiles = 1): void {
    this.bytes += Math.max(0, Math.floor(bytesRead));
    this.files += Math.max(0, Math.floor(rehashedFiles));
  }

  /** One dependency-impact analysis: affectedNodes = affected dependency node count (types closure hits) */
  recordDependencyTraversal(affectedNodes: number): void {
    this.nodes += Math.max(0, Math.floor(affectedNodes));
  }

  /** Cumulative read-only snapshot */
  view(): FingerprintStatsView {
    return { bytesRead: this.bytes, rehashedFiles: this.files, affectedDependencyNodes: this.nodes };
  }

  /** Zero out (session reset / test use) */
  reset(): void {
    this.bytes = 0;
    this.files = 0;
    this.nodes = 0;
  }
}

/** Stats echo line (shared with the OUTPUT/audit text) */
export function formatFingerprintStats(view: FingerprintStatsView): string {
  return `指纹统计: bytes read=${view.bytesRead} B, rehashed files=${view.rehashedFiles}, affected dependency nodes=${view.affectedDependencyNodes}`;
}
