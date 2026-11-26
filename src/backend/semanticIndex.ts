import { normalizeLookupPath } from './definitionSemantics';

// Unified semantic query layer (PR4, user order 2026-10-23): the multi-asset
// root model plus the unified carrier of entity/Python-class/type registration
// relations. The query APIs return entries and snapshot copies only, exposing no
// internal Maps/traversals — consumers (EntityMappingManager etc.) must not scan
// the index's internals themselves.
//
// Explicit lookup-order strategy (A4-5/A4-6 evidence-frozen; no behavior change,
// only a contract):
// (1) same-name entities: the semantic index keeps "one winner per entity name"
//     in registration order, a later registration overwriting the earlier —
//     byte-for-byte identical to the existing
//     EntityMappingManager.mappingIndexes (Map.set same-name overwrite); the
//     conflict's all-roots list is exposed via findEntityConflicts for
//     evidence/diagnostics, never silently swallowed.
// (2) Python file → entity: exact owner-file matching first, falling back to the
//     basename (.py stripped) against entity names — the same two stages as the
//     existing findIndexForPythonFile; with multiple owner matches, the first in
//     registration order wins (the existing [...values()].find semantics).
// (3) root order: registerRoot registers explicitly (workspace roots first,
//     external asset roots in declaration order); queries are decided by that
//     explicit sequence, independent of any Map insertion order.

export interface SemanticRootDescriptor {
  /** Stable root ID = the normalized path (lowercase slashes), cross-platform comparable */
  readonly rootId: string;
  readonly normalizedPath: string;
  /** Explicit lookup order (0-based), assigned at registration, independent of Map insertion order */
  readonly order: number;
}

/** Entity registration entry (the semantic projection EntityMappingManager submits when storing its index) */
export interface SemanticEntityRegistration {
  readonly rootId: string;
  readonly entityName: string;
  /** Normalized .def path */
  readonly defFile: string;
  /** Normalized owner-attributed Python files (registration order keeps the submission order) */
  readonly pythonFiles: readonly string[];
  /** Owner attributions (kind+name, registration order; the entity/interface/component segments each deduped) */
  readonly owners: readonly SemanticOwnerRef[];
}

export interface SemanticOwnerRef {
  readonly kind: string;
  readonly name: string;
}

export interface SemanticEntityEntry {
  readonly rootId: string;
  readonly entityName: string;
  readonly defFile: string;
  readonly pythonFiles: readonly string[];
  readonly owners: readonly SemanticOwnerRef[];
}

/** Type-registry snapshot (A4-3): queries are pure in-memory, rebuilds driven only by update events */
export interface SemanticTypeRegistrySnapshot<T = unknown> {
  readonly rootId: string;
  readonly aliasDiscovery: boolean;
  /** Snapshot generation: incremented after event invalidation, for observability/metrics */
  readonly generation: number;
  /** The snapshot's physical file dependencies (normalized): invalidation notifications are decided precisely against these */
  readonly dependencies: readonly string[];
  /** Registry entries (the structure is owned by the caller, e.g. CustomTypeInfo[]) */
  readonly entries: readonly T[];
  /**
   * IDE-SNP-004: the source version of each dependency file at build time
   * (dependency path → the open document's edit sequence number; undefined or a
   * missing key when not open at build time). A dirty types.xml version bump
   * means stale; consumers decide by this — no per-query disk stat (rebuilds are
   * driven only by events/version advances).
   */
  readonly sourceVersions?: Readonly<Record<string, number | undefined>>;
}

interface EntityRecord {
  entry: SemanticEntityEntry;
}

interface TypeRegistryRecord<T = unknown> {
  snapshot: SemanticTypeRegistrySnapshot<T>;
}

export class SemanticIndex {
  private readonly roots = new Map<string, SemanticRootDescriptor>();
  private rootOrderCounter = 0;
  /** Entity name → the single winner (later registration overrides, strategy (1)) */
  private readonly entitiesByName = new Map<string, EntityRecord>();
  /** All-roots entity list (same-name conflict evidence): normalized def path → entry */
  private readonly entitiesByDefFile = new Map<string, EntityRecord>();
  /** Owner-attributed file → entity list (registration order, normalized paths) */
  private readonly entitiesByPythonOwner = new Map<string, EntityRecord[]>();
  /** Python class name → entity (first-come-first-served, same as the existing ownerName scan order) */
  private readonly entitiesByClassName = new Map<string, EntityRecord>();
  /** kind:name → entity (first-come-first-served, for interface/component symbol backtracking) */
  private readonly entitiesByOwnerRef = new Map<string, EntityRecord>();
  private readonly typeRegistry = new Map<string, TypeRegistryRecord>();
  private typeRegistryGeneration = 0;

  // ---- Root model (A4-5) ----

  /** Register a scan root (idempotent on the normalized path): returns the stable rootId */
  registerRoot(rootPath: string): string {
    const normalizedPath = normalizeLookupPath(rootPath);
    const existing = this.roots.get(normalizedPath);
    if (existing) {
      return existing.rootId;
    }
    const rootId = normalizedPath;
    this.roots.set(normalizedPath, {
      rootId,
      normalizedPath,
      order: this.rootOrderCounter
    });
    this.rootOrderCounter += 1;
    return rootId;
  }

  /** Root list (ascending explicit order, copied) */
  getRoots(): readonly SemanticRootDescriptor[] {
    return [...this.roots.values()].sort((left, right) => left.order - right.order);
  }

  /** The file's owning root (longest-prefix match; null when owned by no root) */
  resolveRootIdForPath(filePath: string): string | null {
    const normalized = normalizeLookupPath(filePath);
    let best: SemanticRootDescriptor | null = null;
    for (const root of this.roots.values()) {
      if ((normalized === root.normalizedPath || normalized.startsWith(`${root.normalizedPath}/`))
        && (!best || root.normalizedPath.length > best.normalizedPath.length)) {
        best = root;
      }
    }
    return best ? best.rootId : null;
  }

  // ---- Entity registration and queries ----

  /** Register an entity's semantic projection (same-name overwrite = strategy (1); py owner/class name first-come-first-served = strategies (2)(3)) */
  registerEntity(registration: SemanticEntityRegistration): SemanticEntityEntry {
    const entry: SemanticEntityEntry = {
      rootId: registration.rootId,
      entityName: registration.entityName,
      defFile: normalizeLookupPath(registration.defFile),
      pythonFiles: registration.pythonFiles.map(normalizeLookupPath),
      owners: [...registration.owners]
    };
    this.removeEntityByDefFile(entry.defFile);
    const record: EntityRecord = { entry };
    this.entitiesByName.set(entry.entityName, record);
    this.entitiesByDefFile.set(entry.defFile, record);
    for (const pythonFile of entry.pythonFiles) {
      const owners = this.entitiesByPythonOwner.get(pythonFile) ?? [];
      if (!owners.includes(record)) owners.push(record);
      this.entitiesByPythonOwner.set(pythonFile, owners);
    }
    for (const owner of entry.owners) {
      if (owner.name && !this.entitiesByClassName.has(owner.name)) {
        this.entitiesByClassName.set(owner.name, record);
      }
      const ownerKey = `${owner.kind}:${owner.name}`;
      if (owner.name && !this.entitiesByOwnerRef.has(ownerKey)) {
        this.entitiesByOwnerRef.set(ownerKey, record);
      }
    }
    return entry;
  }

  /** Remove an entity registration by .def path (targeted invalidation); returns the removed entry or null */
  removeEntityByDefFile(defFile: string): SemanticEntityEntry | null {
    const normalized = normalizeLookupPath(defFile);
    const record = this.entitiesByDefFile.get(normalized);
    if (!record) {
      return null;
    }
    if (this.entitiesByName.get(record.entry.entityName) === record) {
      this.entitiesByName.delete(record.entry.entityName);
    }
    for (const [pythonFile, owners] of this.entitiesByPythonOwner) {
      const remaining = owners.filter(owner => owner !== record);
      if (remaining.length) this.entitiesByPythonOwner.set(pythonFile, remaining);
      else this.entitiesByPythonOwner.delete(pythonFile);
    }
    for (const [className, owner] of this.entitiesByClassName) {
      if (owner === record) {
        this.entitiesByClassName.delete(className);
      }
    }
    for (const [ownerKey, owner] of this.entitiesByOwnerRef) {
      if (owner === record) {
        this.entitiesByOwnerRef.delete(ownerKey);
      }
    }
    this.entitiesByDefFile.delete(normalized);
    // IDE-IDX-008: when the removed entry was the same-name winner, re-elect a
    // winner from the remaining same-name entries (the last-registered wins, the
    // same contract as registration overwrite) — deleting B's Hero does not drag
    // away A's Hero; the name slot always points at an entity that still
    // exists.
    if (!this.entitiesByName.has(record.entry.entityName)) {
      let successor: EntityRecord | undefined;
      for (const candidate of this.entitiesByDefFile.values()) {
        if (candidate.entry.entityName === record.entry.entityName) {
          successor = candidate;
        }
      }
      if (successor) {
        this.entitiesByName.set(record.entry.entityName, successor);
      }
    }
    return record.entry;
  }

  clearEntities(): void {
    this.entitiesByName.clear();
    this.entitiesByDefFile.clear();
    this.entitiesByPythonOwner.clear();
    this.entitiesByClassName.clear();
    this.entitiesByOwnerRef.clear();
  }

  getEntityNames(): readonly string[] {
    return [...this.entitiesByName.keys()];
  }

  /** Entity name → .def path (single winner, strategy (1)) */
  getEntityDefFile(entityName: string): string | null {
    return this.entitiesByName.get(entityName)?.entry.defFile ?? null;
  }

  /** Entity name → all def files (IDE-IDX-003: same-name entities are chosen by the calling root, no single winner) */
  getEntityDefFilesByName(entityName: string): string[] {
    const out: string[] = [];
    for (const [defFile, record] of this.entitiesByDefFile) {
      if (record.entry.entityName === entityName) { out.push(defFile); }
    }
    return out;
  }

  /** Entity name → a copy of the entry */
  findEntityByName(entityName: string): SemanticEntityEntry | null {
    return this.entitiesByName.get(entityName)?.entry ?? null;
  }

  /** The same-name entities' all-roots list (conflict evidence, registration order) */
  findEntityConflicts(entityName: string): readonly SemanticEntityEntry[] {
    const winner = this.entitiesByName.get(entityName)?.entry ?? null;
    const conflicts = [...this.entitiesByDefFile.values()]
      .map(record => record.entry)
      .filter(entry => entry.entityName === entityName);
    // The winner first, the rest in registration order
    return conflicts.sort((left, right) =>
      (left === winner ? -1 : right === winner ? 1 : 0));
  }

  /** Python file → entity: exact owner match first, entity-name fallback (strategy (2)) */
  findEntityByPythonFile(pythonFile: string): SemanticEntityEntry | null {
    const normalized = normalizeLookupPath(pythonFile);
    const ownerRecord = this.entitiesByPythonOwner.get(normalized)?.[0];
    if (ownerRecord) {
      return ownerRecord.entry;
    }
    // The entity-name fallback keeps the existing case-sensitive contract (the
    // original path.basename compared verbatim, not normalized)
    const baseName = pythonFile.replace(/\\/g, '/').split('/').pop()
      ?.replace(/\.py$/i, '') ?? '';
    return this.entitiesByName.get(baseName)?.entry ?? null;
  }

  /** Python file → owner-attributed entities (no entity-name fallback; used for change decisions) */
  findEntitiesByPythonOwner(pythonFile: string): readonly SemanticEntityEntry[] {
    const records = this.entitiesByPythonOwner.get(normalizeLookupPath(pythonFile)) ?? [];
    return records.map(record => record.entry);
  }

  /** Python class name → owner entity (the existing ownerName backtracking contract) */
  findEntityByClassName(className: string): SemanticEntityEntry | null {
    return this.entitiesByClassName.get(className)?.entry ?? null;
  }

  /** owner (kind+name) attributed entity (interface/component symbol backtracking, first registration-order hit) */
  findEntitiesByOwner(kind: string, name: string): readonly SemanticEntityEntry[] {
    const record = this.entitiesByOwnerRef.get(`${kind}:${name}`);
    return record ? [record.entry] : [];
  }

  // ---- Type-registry snapshots (A4-3) ----

  /**
   * Pure in-memory snapshot query: no filesystem checks at all (the statSync
   * fingerprint was retired). Key = the normalized root path + the aliasDiscovery
   * switch; a miss returns undefined, and the caller builds then stores back via
   * storeTypeRegistrySnapshot.
   */
  getTypeRegistrySnapshot<T = unknown>(rootPath: string, aliasDiscovery: boolean): SemanticTypeRegistrySnapshot<T> | undefined {
    const key = this.typeRegistryKey(rootPath, aliasDiscovery);
    return this.typeRegistry.get(key)?.snapshot as SemanticTypeRegistrySnapshot<T> | undefined;
  }

  storeTypeRegistrySnapshot<T>(
    rootPath: string,
    aliasDiscovery: boolean,
    entries: readonly T[],
    dependencies: readonly string[],
    sourceVersions?: Readonly<Record<string, number | undefined>>
  ): SemanticTypeRegistrySnapshot<T> {
    this.typeRegistryGeneration += 1;
    const snapshot: SemanticTypeRegistrySnapshot<T> = {
      rootId: normalizeLookupPath(rootPath),
      aliasDiscovery,
      generation: this.typeRegistryGeneration,
      dependencies: dependencies.map(normalizeLookupPath),
      entries: [...entries],
      ...(sourceVersions ? { sourceVersions } : {})
    };
    this.typeRegistry.set(this.typeRegistryKey(rootPath, aliasDiscovery), { snapshot });
    return snapshot;
  }

  /**
   * Update-event-driven invalidation (A4-3): a physical-file change notification
   * → only snapshots depending on that file are voided. types.xml/alias.xml
   * paths are decided precisely by the snapshot's dependencies; an empty path is
   * treated as a full invalidation (test/shutdown face; the production hot path
   * does not go through it).
   */
  notifySemanticFilesChanged(changedFiles: readonly string[]): number {
    const changed = new Set(changedFiles.map(normalizeLookupPath));
    let invalidated = 0;
    for (const [key, record] of this.typeRegistry) {
      const hit = changed.size === 0
        || record.snapshot.dependencies.some(dependency => changed.has(dependency));
      if (hit) {
        this.typeRegistry.delete(key);
        invalidated += 1;
      }
    }
    return invalidated;
  }

  getTypeRegistrySnapshotCount(): number {
    return this.typeRegistry.size;
  }

  /**
   * IDE-IDX-015: whole-root removal — all type-registry snapshots under that
   * root are deleted and the root descriptor deregistered. Keys carry the `#`
   * separator, so prefix comparison never harms other roots sharing the prefix
   * (/ws/a vs /ws/ab).
   */
  removeRoot(rootPath: string): number {
    const normalizedRoot = normalizeLookupPath(rootPath);
    let removed = 0;
    for (const key of [...this.typeRegistry.keys()]) {
      if (key.startsWith(`${normalizedRoot}#`)) {
        this.typeRegistry.delete(key);
        removed += 1;
      }
    }
    this.roots.delete(normalizedRoot);
    return removed;
  }

  getTypeRegistryGeneration(): number {
    return this.typeRegistryGeneration;
  }

  private typeRegistryKey(rootPath: string, aliasDiscovery: boolean): string {
    return `${normalizeLookupPath(rootPath)}#${aliasDiscovery ? '1' : '0'}`;
  }
}

/** types.xml/alias.xml discrimination (for routing invalidation notifications) */
export function isTypeRegistryFile(filePath: string): boolean {
  const normalized = normalizeLookupPath(filePath);
  return normalized.endsWith('/types.xml') || normalized.endsWith('/alias.xml');
}

// Process-level shared instance: carries only the type-registry snapshot store
// (definitionWorkspace queries and EntityMappingManager's invalidation
// notifications must hit the same one). Entity registries are held by each
// EntityMappingManager itself (tests do not pollute each other) and are not
// shared.
let sharedTypeRegistryIndex: SemanticIndex | null = null;

export function getSemanticIndex(): SemanticIndex {
  if (!sharedTypeRegistryIndex) {
    sharedTypeRegistryIndex = new SemanticIndex();
  }
  return sharedTypeRegistryIndex;
}

/** Test face: reset the shared type-registry snapshot store (entity registries are not in the shared instance) */
export function resetSemanticTypeRegistryForTests(): void {
  sharedTypeRegistryIndex = new SemanticIndex();
}
