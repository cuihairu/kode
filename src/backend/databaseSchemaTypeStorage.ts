import * as path from 'path';
import { getDirectChildElement, getDirectChildElements, getScalarChildValue } from './defParser';
import { getDefinitionEntries } from '../definitionWorkspace';
import { buildSchemaSourcePorts } from './databaseSchemaSource';
import {
  buildDatabaseSchemaSnapshotAsync,
  getDatabaseSchemaSnapshot,
  type DatabaseSchemaSnapshot
} from '../databaseSchema';
import {
  normalizePath,
  parseTypeAliases,
  resolveAliasType,
  resolveDbTypeLabel,
  type BuildContext,
  type SchemaBuildProgress
} from './databaseSchemaCore';

// ---- persisted shape and usage-site back-scan for types.xml types (batch 134) ----
//
// The persistence rules have exactly one implementation, the schema builder
// (alias resolution / column expansion / sub-table naming all live up there);
// here we only re-render its output as two views:
// - getTypeStorageShape: shape data for types.xml hovers (FIXED_DICT top-level
//   keys / one level of ARRAY element recursion), without repeating the
//   persistence rules;
// - buildTypeStorageUsageIndex / findTypeStorageUsages: walk the entity
//   snapshots and file every non-synthetic column under its declaredType (the
//   raw <Type> text) as "type -> actual landing spot"; the landing table/column
//   is taken straight from the snapshot, and both the types.xml CodeLens and
//   the hover consume it.

export type TypeStorageShape =
  | { kind: 'builtin'; rawType: string; typeName: string; columnType: string | null }
  | { kind: 'fixedDict'; rawType: string; topLevelKeys: string[] }
  | { kind: 'array'; rawType: string; element: TypeStorageShape | null }
  | { kind: 'unresolved'; rawType: string };

export interface TypeStorageUsage {
  /** Entity the usage site belongs to (ARRAY / FD-key landing spots follow the entity property) */
  entity: string;
  /** Declared path, e.g. itemId / items[] / skills[].count */
  property: string;
  /** Landing table name (tbl_...) */
  table: string;
  /** Landing column name (sm_...) */
  column: string;
  /** Declaration-site file (the entity def, or the FD key declaration in types.xml) */
  defFile: string;
  /** Declaration-site line number (1-based) */
  line: number;
}

export function getTypeStorageShape(typesXmlPath: string | null, typeName: string): TypeStorageShape {
  const context: BuildContext = {
    workspaceRoot: '',
    entityDefsRoot: '',
    entityScriptsRoot: null,
    visitedDefinitions: new Set(),
    componentCache: new Map(),
    componentScopesCache: new Map(),
    typeAliases: parseTypeAliases(typesXmlPath, undefined, buildSchemaSourcePorts().readInputFile),
    entityHasCell: false,
    inputVersions: new Map(),
    // IDE-SCH-004: shape queries produce no snapshot; consumption bookkeeping lands in an empty Map (placeholder, not cached)
    typeRegistryPath: null,
    typeRegistryConsumed: new Map<string, string>(),
    ports: buildSchemaSourcePorts()
  };
  return typeShapeOf(typeName, context, new Set());
}

function typeShapeOf(typeName: string, context: BuildContext, seen: Set<string>): TypeStorageShape {
  if (seen.has(typeName)) {
    // Alias cycle: the engine's resolveAlias short-circuits on seen the same way, so the shape level does not expand further
    return { kind: 'unresolved', rawType: typeName };
  }
  seen.add(typeName);

  const resolved = resolveAliasType(typeName, context);
  if (resolved.kind === 'builtin') {
    return {
      kind: 'builtin',
      rawType: typeName,
      typeName: resolved.typeName,
      columnType: resolveDbTypeLabel(resolved.typeName)
    };
  }
  if (resolved.kind === 'fixedDict') {
    const propertiesNode = getDirectChildElement(resolved.node, 'Properties');
    return {
      kind: 'fixedDict',
      rawType: typeName,
      topLevelKeys: getDirectChildElements(propertiesNode).map(node => node.name)
    };
  }
  if (resolved.kind === 'array') {
    // Element type = the text of <of> (same reading as parseArrayElementDescriptor)
    const rawElementType = getScalarChildValue(resolved.node, 'of');
    return {
      kind: 'array',
      rawType: typeName,
      element: rawElementType ? typeShapeOf(rawElementType, context, seen) : null
    };
  }
  return { kind: 'unresolved', rawType: typeName };
}

// IDE-SCH-008: incremental maintenance per entity -- usage records are kept
// per entity, and the records for an entity are reused when the snapshot object
// identity is unchanged (editing one entity rebuilds only that one, record
// objects for unrelated entities are kept as they are); the aggregate index is
// aggregated lazily from the records and reused while the records are unchanged.
interface TypeStorageUsageEntityRecord {
  snapshot: DatabaseSchemaSnapshot | null;
  usages: Array<{ typeName: string; usage: TypeStorageUsage }>;
}

let typeStorageUsageState: {
  key: string;
  entityRecords: Map<string, TypeStorageUsageEntityRecord>;
  index: Map<string, TypeStorageUsage[]> | null;
} | null = null;

function collectTypeStorageUsagesForSnapshot(snapshot: DatabaseSchemaSnapshot | null): Array<{ typeName: string; usage: TypeStorageUsage }> {
  const usages: Array<{ typeName: string; usage: TypeStorageUsage }> = [];
  if (!snapshot) {
    return usages;
  }
  for (const table of snapshot.tables) {
    for (const field of table.fields) {
      if (field.synthetic || !field.declaredType) {
        continue;
      }
      usages.push({
        typeName: field.declaredType,
        usage: {
          entity: snapshot.entityName,
          property: field.sourcePath,
          table: table.name,
          column: field.name,
          defFile: field.source.filePath,
          line: field.source.line
        }
      });
    }
  }
  return usages;
}

function refreshTypeStorageUsageRecord(workspaceRoot: string, entityName: string): boolean {
  const state = typeStorageUsageState;
  if (!state) {
    return false;
  }
  const snapshot = getDatabaseSchemaSnapshot(entityName, workspaceRoot);
  const existing = state.entityRecords.get(entityName);
  if (existing && existing.snapshot === snapshot) {
    return false; // snapshot object unchanged: records contributed by this entity are reused as-is
  }
  state.entityRecords.set(entityName, {
    snapshot,
    usages: collectTypeStorageUsagesForSnapshot(snapshot)
  });
  return true;
}

/** IDE-AUD-013 (F13): single-entity refresh surface for phased cold builds --
 * the async build pipeline yields within a single entity according to the
 * budget (property loops / components / parent-chain recursion), and a
 * mid-flight cancellation stops immediately through the gate.
 * Returning 'cancelled' means the entity was not fully processed (the record
 * is not updated, and the caller should stop without publishing). */
async function refreshTypeStorageUsageRecordAsync(
  workspaceRoot: string,
  entityName: string,
  progress: SchemaBuildProgress,
  gate: () => Promise<boolean>
): Promise<'updated' | 'unchanged' | 'cancelled'> {
  const state = typeStorageUsageState;
  if (!state) {
    return 'cancelled'; // state already discarded: cannot record, the caller should stop
  }
  let cancelled = false;
  const snapshot = await buildDatabaseSchemaSnapshotAsync(entityName, workspaceRoot, {
    budgetMs: progress.budgetMs,
    progress,
    gate: async () => {
      if (!(await gate())) {
        cancelled = true;
        return false;
      }
      return true;
    }
  });
  if (cancelled) {
    return 'cancelled'; // mid-flight cancel: no usable snapshot produced, record not updated
  }
  const existing = state.entityRecords.get(entityName);
  if (existing && existing.snapshot === snapshot) {
    return 'unchanged'; // snapshot object unchanged: records contributed by this entity are reused as-is
  }
  state.entityRecords.set(entityName, {
    snapshot,
    usages: collectTypeStorageUsagesForSnapshot(snapshot)
  });
  return 'updated';
}

export function invalidateTypeStorageUsageIndex(): void {
  typeStorageUsageState = null;
}

function rebuildTypeStorageUsageAggregate(state: NonNullable<typeof typeStorageUsageState>): Map<string, TypeStorageUsage[]> {
  const index = new Map<string, TypeStorageUsage[]>();
  for (const record of state.entityRecords.values()) {
    for (const { typeName, usage } of record.usages) {
      const usages = index.get(typeName) || [];
      usages.push(usage);
      index.set(typeName, usages);
    }
  }
  state.index = index;
  return index;
}

/** Background task dispatcher: the rendering surface does not build the index; it is queued off the background thread (the extension registers the dispatcher) */
export type BackgroundSchemaTaskDispatcher = (run: () => Promise<void>) => Promise<void>;
let typeStorageUsageBackgroundDispatcher: BackgroundSchemaTaskDispatcher | null = null;

export function setTypeStorageUsageBackgroundDispatcher(dispatcher: BackgroundSchemaTaskDispatcher | null): void {
  typeStorageUsageBackgroundDispatcher = dispatcher;
}

const pendingTypeStorageColdBuildRoots = new Set<string>();
let typeStorageColdBuildChain: Promise<void> = Promise.resolve();
const typeStorageUsageIndexListeners = new Set<() => void>();

/** Cold-build completion (publish) listener: the rendering surface refreshes on it (re-renders the types.xml CodeLens) */
export function onTypeStorageUsageIndexPublished(listener: () => void): () => void {
  typeStorageUsageIndexListeners.add(listener);
  return () => { typeStorageUsageIndexListeners.delete(listener); };
}

/** Test surface: wait for the in-flight cold-build chain to drain */
export async function flushTypeStorageUsageColdBuildForTests(): Promise<void> {
  while (pendingTypeStorageColdBuildRoots.size > 0) {
    await typeStorageColdBuildChain;
  }
}

/** Residual-task gauge (P0-4b audit reopened 2026-10-28): number of in-flight cold-build roots (read-only). */
export function getPendingTypeStorageColdBuildCount(): number {
  return pendingTypeStorageColdBuildRoots.size;
}

const defaultBackgroundDispatch: BackgroundSchemaTaskDispatcher = run =>
  new Promise<void>(resolve => {
    setImmediate(() => { void run().then(resolve, resolve); });
  });

/** IDE-SCH-009 read-only back-lookup surface: if the aggregate is published,
 * return it with a pure read -- zero snapshot probing; freshness is carried by
 * the event surface (watcher -> per-entity replacement / whole-table reset).
 * 2026-10-28 audit remediation: the cold path (no state) no longer builds the
 * whole table on the interaction thread -- it dispatches one background build,
 * this render gets an empty table, and once the build finishes the rendering
 * surface is notified to refresh via onTypeStorageUsageIndexPublished. */
export function getTypeStorageUsageIndexReadOnly(workspaceRoot: string): Map<string, TypeStorageUsage[]> {
  if (typeStorageUsageState && typeStorageUsageState.key === workspaceRoot) {
    return typeStorageUsageState.index || rebuildTypeStorageUsageAggregate(typeStorageUsageState);
  }
  scheduleTypeStorageUsageColdBuild(workspaceRoot);
  return new Map();
}

function scheduleTypeStorageUsageColdBuild(workspaceRoot: string): void {
  if (pendingTypeStorageColdBuildRoots.has(workspaceRoot)) {
    return; // a cold build for the same root is in flight: dedupe
  }
  pendingTypeStorageColdBuildRoots.add(workspaceRoot);
  const dispatch = typeStorageUsageBackgroundDispatcher ?? defaultBackgroundDispatch;
  typeStorageColdBuildChain = typeStorageColdBuildChain
    .then(() => dispatch(async () => {
      try {
        // IDE-REV-013: the cold index is phased per entity -- no longer walking
        // all entities synchronously inside a single setImmediate callback; the
        // budget yields to the host plus cancellation checks, and a mid-flight
        // cancel discards the partial state so it can be rescheduled
        const outcome = await buildTypeStorageUsageIndexPhased(workspaceRoot, {
          shouldContinue: () => !typeStorageColdBuildCancelFlags.has(workspaceRoot)
        });
        if (outcome.stopped && typeStorageUsageState?.key === workspaceRoot) {
          typeStorageUsageState = null; // partial records cannot serve as the aggregate: discard, reschedule on next query
        }
      } finally {
        pendingTypeStorageColdBuildRoots.delete(workspaceRoot);
        typeStorageColdBuildCancelFlags.delete(workspaceRoot);
      }
    }))
    .catch(() => {});
  void typeStorageColdBuildChain.then(() => {
    for (const listener of [...typeStorageUsageIndexListeners]) {
      listener();
    }
  });
}

// IDE-REV-013: scheduling-surface cancel flags (key = root); an in-flight cold build stops as soon as it sees one at an entity boundary
const typeStorageColdBuildCancelFlags = new Set<string>();

/** IDE-REV-013: cancel an in-flight type storage cold build for a root; returns false when no build is in flight */
export function cancelTypeStorageUsageColdBuild(workspaceRoot: string): boolean {
  if (!pendingTypeStorageColdBuildRoots.has(workspaceRoot)) {
    return false;
  }
  typeStorageColdBuildCancelFlags.add(workspaceRoot);
  return true;
}

/** IDE-REV-013: injection surface for yielding and cancellation of phased cold builds */
export interface TypeStorageUsageColdBuildOptions {
  /** Called at each entity boundary (and after each yield); returning false stops the build without publishing */
  shouldContinue?: () => boolean | Promise<boolean>;
  /** Yield to the host (setImmediate by default) */
  yieldControl?: () => Promise<void>;
  /** Continuous-execution time budget (milliseconds; yields once exceeded; default 25ms, same contract as the diagnostic time slice) */
  entityBudgetMs?: number;
}

/** IDE-REV-013: outcome gauge for one phased cold build (test/observability surface) */
export interface TypeStorageUsageColdBuildOutcome {
  /** Number of entities fully processed (before stopping) */
  entities: number;
  /** Whether the build stopped due to cancellation (true = aggregate not published) */
  stopped: boolean;
  /** Number of host yields (a real yield surface, not a beforeBuild fake gate) */
  yields: number;
  /** Longest continuous execution between two yields (milliseconds) -- the max continuous blocking gauge */
  maxSliceMs: number;
}

let lastTypeStorageColdBuildGauge: TypeStorageUsageColdBuildOutcome | null = null;

/** IDE-REV-013: read the gauge of the most recent phased cold build (test surface) */
export function getTypeStorageColdBuildGaugeForTests(): TypeStorageUsageColdBuildOutcome | null {
  return lastTypeStorageColdBuildGauge;
}

/**
 * IDE-REV-013: phased build of the type storage cold index -- refreshes usage
 * records entity by entity, checking for cancellation at entity boundaries;
 * when continuous execution exceeds the budget (default 25ms) it yields to the
 * host and resumes. Stopping (cancellation) does not publish the aggregate;
 * the caller decides whether to discard the partial records. The synchronous
 * surface buildTypeStorageUsageIndex keeps the query/test contract unchanged.
 */
export async function buildTypeStorageUsageIndexPhased(
  workspaceRoot: string,
  options: TypeStorageUsageColdBuildOptions = {}
): Promise<TypeStorageUsageColdBuildOutcome> {
  if (!typeStorageUsageState || typeStorageUsageState.key !== workspaceRoot) {
    typeStorageUsageState = { key: workspaceRoot, entityRecords: new Map(), index: null };
  }
  const state = typeStorageUsageState;
  const entries = getDefinitionEntries(workspaceRoot, 'entity').filter(entry => entry.exists);
  const liveEntities = new Set(entries.map(entry => entry.name));
  const shouldContinue = options.shouldContinue ?? (() => true);
  const yieldControl = options.yieldControl ?? (() => new Promise<void>(resolve => { setImmediate(resolve); }));
  const budgetMs = options.entityBudgetMs ?? 25;

  // IDE-AUD-013 (F13): shared yield gauge -- yields inside a single entity
  // (property loops / components / parent-chain recursion) and yields at entity
  // boundaries are recorded in the same gauge; the max continuous slice is
  // measured continuously across both.
  const progress: SchemaBuildProgress = { sliceStart: Date.now(), budgetMs, yields: 0, maxSliceMs: 0 };
  const gate = async (): Promise<boolean> => {
    await yieldControl();
    return shouldContinue();
  };

  let entities = 0;
  let stopped = false;
  for (const entry of entries) {
    if (!(await shouldContinue())) {
      stopped = true; // stopped at an entity boundary: remaining entities are not processed
      break;
    }
    const status = await refreshTypeStorageUsageRecordAsync(workspaceRoot, entry.name, progress, gate);
    if (status === 'cancelled') {
      stopped = true; // cancelled after a yield inside a single entity: that entity was not fully processed, stop without publishing
      break;
    }
    entities += 1;
    const now = Date.now();
    progress.maxSliceMs = Math.max(progress.maxSliceMs, now - progress.sliceStart);
    if (now - progress.sliceStart >= budgetMs) {
      progress.yields += 1;
      await yieldControl();
      if (!(await shouldContinue())) {
        stopped = true; // cancelled after a yield: stop before continuing the batch
        break;
      }
      progress.sliceStart = Date.now();
    }
  }

  const gauge: TypeStorageUsageColdBuildOutcome = {
    entities,
    stopped,
    yields: progress.yields,
    maxSliceMs: progress.maxSliceMs
  };
  lastTypeStorageColdBuildGauge = gauge;
  if (stopped) {
    return gauge; // no stale-record cleanup / no aggregation: the caller discards the partial state
  }
  for (const name of [...state.entityRecords.keys()]) {
    if (!liveEntities.has(name)) { // entity no longer in the definition list: clear its stale record
      state.entityRecords.delete(name);
    }
  }
  rebuildTypeStorageUsageAggregate(state);
  return gauge;
}

export function findTypeStorageUsagesReadOnly(workspaceRoot: string, typeName: string): TypeStorageUsage[] {
  return getTypeStorageUsageIndexReadOnly(workspaceRoot).get(typeName) || [];
}

/**
 * IDE-SCH-008 event surface: after an entity def change, only the usage records
 * contributed by that entity are replaced; record objects of the other entities
 * stay untouched, and the aggregate index is re-aggregated on demand (no full
 * repository rebuild).
 */
export function replaceTypeStorageUsageForEntity(workspaceRoot: string, entityName: string): void {
  if (!typeStorageUsageState || typeStorageUsageState.key !== workspaceRoot) {
    return; // no index yet: the next query itself is a fresh build
  }
  if (refreshTypeStorageUsageRecord(workspaceRoot, entityName)) {
    rebuildTypeStorageUsageAggregate(typeStorageUsageState); // re-aggregate existing records only, no per-entity snapshot probing
  }
}

export function buildTypeStorageUsageIndex(workspaceRoot: string): Map<string, TypeStorageUsage[]> {
  if (!typeStorageUsageState || typeStorageUsageState.key !== workspaceRoot) {
    typeStorageUsageState = { key: workspaceRoot, entityRecords: new Map(), index: null };
  }
  const state = typeStorageUsageState;

  // Self-healing per entity by snapshot identity: unrelated entities are reused at zero cost, changed entities rebuild only themselves
  const entries = getDefinitionEntries(workspaceRoot, 'entity').filter(entry => entry.exists);
  let changed = false;
  const liveEntities = new Set(entries.map(entry => entry.name));
  for (const entry of entries) {
    if (refreshTypeStorageUsageRecord(workspaceRoot, entry.name)) {
      changed = true;
    }
  }
  for (const name of [...state.entityRecords.keys()]) {
    if (!liveEntities.has(name)) { // entity no longer in the definition list: clear its stale record
      state.entityRecords.delete(name);
      changed = true;
    }
  }

  if (!changed && state.index) {
    return state.index;
  }
  return rebuildTypeStorageUsageAggregate(state);
}

export function findTypeStorageUsages(workspaceRoot: string, typeName: string): TypeStorageUsage[] {
  return buildTypeStorageUsageIndex(workspaceRoot).get(typeName) || [];
}

/**
 * Index persisted schema columns by their source line in a file.
 * This exposes fields contributed by FIXED_DICT keys and ARRAY element aliases
 * without maintaining a second type-to-column expansion algorithm.
 */
export function indexTypeStorageUsagesBySourceLine(
  workspaceRoot: string,
  sourceFile: string
): Map<number, TypeStorageUsage[]> {
  return indexTypeStorageUsageEntries(buildTypeStorageUsageIndex(workspaceRoot), sourceFile);
}

/** IDE-SCH-009: group an already-fetched aggregate (usually the read-only surface) by source line, triggering no build */
export function indexTypeStorageUsageEntries(
  index: Map<string, TypeStorageUsage[]>,
  sourceFile: string
): Map<number, TypeStorageUsage[]> {
  const sourceKey = normalizePath(path.resolve(sourceFile));
  const byLine = new Map<number, TypeStorageUsage[]>();
  const seen = new Set<string>();
  for (const typeUsages of index.values()) {
    for (const usage of typeUsages) {
      const key = `${normalizePath(path.resolve(usage.defFile))}:${usage.line}:${usage.entity}:${usage.table}:${usage.column}`;
      if (normalizePath(path.resolve(usage.defFile)) !== sourceKey || seen.has(key)) {
        continue;
      }
      seen.add(key);
      const lineUsages = byLine.get(usage.line) || [];
      lineUsages.push(usage);
      byLine.set(usage.line, lineUsages);
    }
  }
  return byLine;
}
