/**
 * Pure core for the def-to-python method jump reverse-lookup table (DEF-LUT-001,
 * inspection ticket 2026-10-20/2026-11-18, user ruling "execute"): once the gate
 * opens, a global reverse-lookup table is built in the background, turning the
 * def-method F12 flow from "lazy build on demand + slow fallback wait (waiting
 * for the index / full project scan)" into an O(1) table lookup.
 *
 * Iron rules (per the task brief):
 * - The LUT is an **acceleration layer, not the sole source of truth**: hits are
 *   answered directly, missing returns empty immediately; if the table does not
 *   contain the entry (miss), fall back to the existing slow chain -- after
 *   clearing the LUT, query results must match the slow chain exactly (pin 4).
 * - Build/query/invalidate must be independently testable with zero vscode
 *   dependencies (IO and document opening are injected by the assembly layer).
 * - Gate red line: zero builds for a gated-off workspace -- build scheduling is
 *   only initiated from the warmup-complete callback after the gate opens
 *   (monitoring.ts); this core itself has zero startup side effects.
 *
 * Invalidation contract (borrowed from the semanticIndex snapshot-store idea,
 * event-driven precise invalidation):
 * - .def change -> removeDef (all entries for that def leave the table);
 * - .py change -> invalidatePythonFile (the contributor index reverse-looks-up
 *   affected keys, removing precisely);
 * - generation advances on every eviction/rebuild, for tests and instrumentation
 *   to assert invalidation actually happened.
 */
import { normalizeFileIdentity } from './pathIdentity';

// Disk version discipline: when the defLUT payload shape changes, bump it
// together with INDEX_CACHE_SCHEMA_VERSION (existing indexDiskCache semantics:
// a version mismatch discards the whole old cache; no compatibility baggage).

/** Jump landing point (same shape as the EntityMappingManager resolution surface: line is 1-based) */
export interface DefMethodLutTarget {
  filePath: string;
  line: number;
  character: number;
}

/**
 * Single-method entry. implementations = owner/binding-surface hits (same
 * source as listMethodImplementations ByIdentity); mroImplementations =
 * supplementary implementations outside the owner (landing points from the
 * parent def / interface convention chain and the whole-project unique-name
 * fallback); missing=true means the entire chain found no implementation (the
 * def declares it, but neither the owner py, the convention chain, nor the
 * whole-project fallback has one) -- the query surface returns empty
 * immediately on that basis, without entering the fallback wait.
 */
export interface DefMethodLutEntry {
  /** Owning def file (original path, for comparison with the current document on the query side) */
  defFile: string;
  /** Declaration line in the def (1-based) */
  defDeclLine: number;
  section: string;
  implementations: DefMethodLutTarget[];
  mroImplementations: DefMethodLutTarget[];
  missing: boolean;
}

/**
 * Reverse-lookup key: isomorphic to
 * entityMappingHelpers.buildMethodOwnerBindingKey
 * (ownerKind::ownerName::section::symbolName joined lowercased) -- the module
 * hosting that function imports vscode, which the pure core cannot, so the
 * same formula is replicated here; tests pin an equivalence test locking the
 * two formulas from drifting.
 */
export function buildDefMethodLutKey(identity: {
  ownerKind: string;
  ownerName: string;
  section?: string;
  symbolName: string;
}): string {
  return [
    identity.ownerKind,
    identity.ownerName,
    identity.section || '',
    identity.symbolName
  ].join('::').toLowerCase();
}

/** On-disk entry for a single def: indexDiskCache paradigm, stat snapshot for the restore side to verify (drift is rejected) */
export interface DefLutDiskFile {
  defPath: string;
  mtimeMs: number;
  size: number;
  entries: Array<[string, DefMethodLutEntry]>;
}

interface DefTable {
  stat: { mtimeMs: number; size: number };
  entries: Map<string, DefMethodLutEntry>;
}

/** stat verification injection surface (used by the restore side; defaults to always passing, the assembly layer passes an fs.stat version) */
export type DefStatProbe = (defPath: string) => { mtimeMs: number; size: number } | null;

export interface DefMethodLutRestoreReport {
  adoptedDefs: number;
  rejectedDefs: number;
  adoptedEntries: number;
}

/**
 * The reverse-lookup table itself: tables are bucketed per def (a full table
 * rebuild = per-def upsert with atomic replacement); the contributor index
 * (py file -> key set) supports precise invalidation on python changes. The
 * getHit query has three states: hit (with landing point) / missing
 * (immediate empty) / undefined (miss -> slow chain).
 */
export class DefMethodLut {
  private readonly tables = new Map<string, DefTable>();
  /** Normalized def path -> original path (for restoring defPath from the on-disk payload) */
  private readonly originalPaths = new Map<string, string>();
  private readonly contributors = new Map<string, Set<string>>();
  private generationCounter = 0;

    /** Current generation: advances on every eviction/restore (test surface for invalidation assertions and "a rebuild actually happened") */
  generation(): number {
    return this.generationCounter;
  }

  /** Total entry count (test / instrumentation forensics) */
  size(): number {
    let total = 0;
    for (const table of this.tables.values()) {
      total += table.entries.size;
    }
    return total;
  }

  defFileCount(): number {
    return this.tables.size;
  }

  /**
   * Whole-def bucket replacement (the unit of background rebuilds): the old
   * bucket's contributor edges are removed first, then the new bucket is
   * registered. generation does not advance (a rebuild is not an invalidation;
   * the invalidation surface is handled by removeDef/invalidatePythonFile, and
   * generation assertions are only sensitive to invalidations).
   */
  upsertDef(defFile: string, stat: { mtimeMs: number; size: number }, entries: Map<string, DefMethodLutEntry>): void {
    const key = normalizeFileIdentity(defFile);
    this.removeDefByKey(key);
    this.originalPaths.set(key, defFile);
    const table: DefTable = { stat, entries };
    this.tables.set(key, table);
    for (const [entryKey, entry] of entries) {
      this.addContributorEdges(key, entryKey, entry);
    }
  }

  /** Invalidate on def change: all entries for that def leave the table (entry-level generation advance) */
  removeDef(defFile: string): number {
    return this.removeDefByKey(normalizeFileIdentity(defFile));
  }

  /** Invalidate on python change: the contributor index reverse-looks-up affected keys, removing the matching entries per bucket precisely */
  invalidatePythonFile(pythonFile: string): number {
    const pyKey = normalizeFileIdentity(pythonFile);
    const affected = this.contributors.get(pyKey);
    if (!affected || affected.size === 0) {
      return 0;
    }
    this.contributors.delete(pyKey);
    let removed = 0;
    for (const defKey of [...this.tables.keys()]) {
      const table = this.tables.get(defKey)!;
      for (const entryKey of [...table.entries.keys()]) {
        if (!affected.has(`${defKey}\u0000${entryKey}`)) {
          continue;
        }
        table.entries.delete(entryKey);
        removed += 1;
      }
      if (table.entries.size === 0) {
        this.tables.delete(defKey);
      }
    }
    // Edges for this py were deleted as a whole group; contributor edges of
    // other py files are kept (keys are already out of the table, so dangling
    // edges are harmless -- the next change to that py early-exits on the empty
    // set, avoiding the extra cost of a full-table edge sweep for cleanup)
    if (removed > 0) {
      this.generationCounter += 1;
    }
    return removed;
  }

  /** Query three states (pins 1, 2, 4): hit = has a landing point; missing = entire chain has no implementation, return empty immediately; undefined = miss, take the slow chain */
  getHit(key: string, defFile: string): { status: 'hit'; target: DefMethodLutTarget } | { status: 'missing' } | undefined {
    const table = this.tables.get(normalizeFileIdentity(defFile));
    if (!table) {
      return undefined;
    }
    const entry = table.entries.get(key);
    if (!entry) {
      return undefined;
    }
    if (entry.implementations.length > 0) {
      return { status: 'hit', target: entry.implementations[0] };
    }
    if (entry.mroImplementations.length > 0) {
      return { status: 'hit', target: entry.mroImplementations[0] };
    }
    return entry.missing ? { status: 'missing' } : undefined;
  }

  /** Direct entry read (test/forensics surface; the query surface goes through getHit) */
  getEntry(key: string, defFile: string): DefMethodLutEntry | undefined {
    return this.tables.get(normalizeFileIdentity(defFile))?.entries.get(key);
  }

  /** Snapshot of all def buckets (on-disk payload; an empty table returns [] rather than null -- an empty table is also a fact) */
  capture(): DefLutDiskFile[] {
    const files: DefLutDiskFile[] = [];
    for (const [defKey, table] of this.tables) {
      files.push({
        defPath: this.originalPaths.get(defKey) ?? defKey,
        mtimeMs: table.stat.mtimeMs,
        size: table.stat.size,
        entries: [...table.entries.entries()]
      });
    }
    return files;
  }

  /**
   * Disk restore (pin 6): stat verification per def (drift/missing rejects that
   * bucket, which is still rebuilt in the background as before; the version gate
   * is handled by the indexDiskCache meta). Restore itself does not advance
   * generation (restoring an empty table is not an invalidation; the background
   * rebuild's upsertDef after warmup completes naturally takes over).
   */
  restore(files: DefLutDiskFile[] | undefined, statOf: DefStatProbe = () => ({ mtimeMs: 0, size: 0 })): DefMethodLutRestoreReport {
    const report: DefMethodLutRestoreReport = { adoptedDefs: 0, rejectedDefs: 0, adoptedEntries: 0 };
    if (!files || files.length === 0) {
      return report;
    }
    for (const file of files) {
      if (!Array.isArray(file.entries)) {
        report.rejectedDefs += 1;
        continue;
      }
      const stat = statOf(file.defPath);
      if (!stat || stat.mtimeMs !== file.mtimeMs || stat.size !== file.size) {
        report.rejectedDefs += 1;
        continue;
      }
      this.upsertDef(file.defPath, { mtimeMs: file.mtimeMs, size: file.size }, new Map(file.entries));
      report.adoptedDefs += 1;
      report.adoptedEntries += file.entries.length;
    }
    return report;
  }

  private removeDefByKey(defKey: string): number {
    const table = this.tables.get(defKey);
    if (!table) {
      return 0;
    }
    this.tables.delete(defKey);
    this.originalPaths.delete(defKey);
    const removed = table.entries.size;
    if (removed > 0) {
      this.generationCounter += 1;
    }
    return removed;
  }

  private addContributorEdges(defKey: string, entryKey: string, entry: DefMethodLutEntry): void {
    for (const target of [...entry.implementations, ...entry.mroImplementations]) {
      const pyKey = normalizeFileIdentity(target.filePath);
      let edges = this.contributors.get(pyKey);
      if (!edges) {
        edges = new Set<string>();
        this.contributors.set(pyKey, edges);
      }
      edges.add(`${defKey}\u0000${entryKey}`);
    }
  }
}
