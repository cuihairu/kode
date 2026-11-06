# Unified Semantic Index Architecture (after the 2026-10 refactor)

- Scope: the language service's data and scheduling surfaces after PR2–PR6
  landed, as the architecture deliverable referenced by
  docs/perf/2026-final-report.md §8 (review §11 deliverables 3/4/5).
- Nature: describes **current code facts** (modules under src/ and their
  locked tests); not a concept sketch.
- Source index: src/documentStore.ts (342 lines), src/indexScheduler.ts (422), src/semanticIndex.ts (329), src/dependencyGraph.ts (164), src/diagnosticScheduler.ts (322), src/entityMapping.ts, src/pythonClassIndex.ts, src/scanRoots.ts, src/workspaceIndex.ts, src/languageServiceMetrics.ts.

## 1. Architecture diagram

```text
                       ┌──────────────────────────────────────────────┐
                       │            VS Code Providers (entries)        │
                       │  Hover / Definition / Completion / Diagnostics│
                       └──────┬───────────────┬───────────────┬───────┘
                              │               │               │
                    ┌─────────▼──────┐ ┌──────▼───────┐ ┌─────▼──────────────┐
   open doc (mem)──▶│ DocumentStore  │ │ SemanticIndex│ │ DiagnosticScheduler │
   disk file────────▶│ (snapshot+    │ │ (entity/type/│ │ (version tokens+    │
                    │  parse cache)  │ │  symbol find)│ │  layered accounting)│
                    │ version=parse  │ │              │ │ same-URI new ver    │
                    │       once     │ │              │ │ wins                │
                    └─────────┬──────┘ └──────┬───────┘ └─────┬──────────────┘
                              │               │               │
                    ┌─────────▼───────────────▼───────────────▼───────┐
                    │       SemanticDependencyGraph (invalidation)     │
                    │  file→symbol deps; changes adjudicated by deps;  │
                    │  fullRebuild always false                        │
                    └─────────┬───────────────────────────────────────┘
                              │ invalidation notice (notifySemanticFilesChanged)
                    ┌─────────▼───────────────────────────────────────┐
                    │              IndexScheduler (sole entry)          │
                    │ priority queue + interactive cooldown + task     │
                    │ merge + failure recovery                         │
                    └──────┬──────────────┬──────────────┬────────────┘
                           │              │              │
                 ┌─────────▼───┐  ┌───────▼──────┐  ┌────▼──────────────┐
                 │EntityMapping │  │PythonClassIndex│  │ WorkspaceIndex    │
                 │Manager (.def)│  │(class/MRO/comp│  │(local symbol      │
                 │              │  │  roots)       │  │  index)           │
                 └─────────┬───┘  └───────┬──────┘  └────┬──────────────┘
                           │              │              │
                    ┌──────▼──────────────▼──────────────▼─────┐
                    │  ScanRoots (file discovery, cross-root +  │
                    │  external roots, cached results)          │
                    └──────────────────────────────────────────┘
                              │
              languageServiceMetrics (instrumented on every path, P50/95/99)
```

Key point: providers **only read snapshots and indexes** and never walk
directories on the request path; full scans are background tasks inside the
scheduler; every invalidation is adjudicated through the dependency graph.

## 2. Index data model

### 2.1 DocumentStore (src/documentStore.ts)

- Key: normalized file path; value: document snapshot { version, text line
  index, lightweight parse structure (parse result), parse status, last
  successfully parsed version }.
- Contract: parse once per version (`getOrParseDocumentSync` version axis);
  edits arriving during a parse do not overwrite the new version; open
  documents follow VS Code's in-memory text.
- Measured figure: same-version .def parse hit rate 96.1% (n=51, see
  docs/perf/final-pr2-run.txt).

### 2.2 SemanticIndex (src/semanticIndex.ts)

- Data: `SemanticEntityRegistration` (entity registrations),
  `SemanticEntityEntry` (entity entries: owner reference, def, root),
  `SemanticTypeRegistrySnapshot<T>` (type-registry snapshots),
  `EntityRecord`/`TypeRegistryRecord` internal records.
- Query APIs: resolve entity ownership per root, same-name conflict list
  (`findEntityConflicts`, winner first), type-registry snapshot reads, and the
  file-change invalidation entry `notifySemanticFilesChanged(changedFiles)`
  (returns the invalidated count).
- EntityMappingManager's queries go through its compatibility layer with the
  same ordering (no parallel index is built).

### 2.3 SemanticDependencyGraph (src/dependencyGraph.ts)

- Records: file ↔ dependency files/symbols (`DependencyRecord`); invalidation
  plan `InvalidationPlan { invalidateFiles }`.
- Rule: a single-file change → `invalidate = { that file } ∪ transitive
  dependents`, output sorted; **escalating any change into a whole-repo
  rebuild is forbidden** (`fullRebuild` always false, asserted since PR5).

### 2.4 PythonClassIndex five version axes (src/pythonClassIndex.ts)

- Per-file `revisions` Map (each file increments independently) +
  `fileCache` (version→ParsedPythonFile); composition-root derivation
  stability uses "composition-root epoch (rootsEpoch) + assignment-bridge
  fingerprint", not the per-increment generation.
- Data axes: classes / bases / methods / mro / compositionRoots invalidate
  independently; deletes/renames go through `unindexFile` for precise removal
  (scenario 6: zero stale hits after deletion).
- Composition-root cache: mtime+size fingerprint over XML/def content —
  re-derivation re-reads nothing.

### 2.5 DiagnosticScheduler (src/diagnosticScheduler.ts)

- Tasks carry document version tokens; the per-URI queue is "newest version
  wins", superseded stale tasks (`coalescedStale`) never execute; versions are
  re-checked before flush, and stale results are `staleDropped`.
- Layering: 'local' (pure text/AST) and 'semantic' (index-dependent) are
  accounted separately; per-URI keying means unrelated file changes cause zero
  tasks; same version + same diagnostics generation = zero recompute
  (`skippedCurrentVersion`).

## 3. Scope rules (multiple asset roots)

Basis: docs/review/2026-10-23-pr4-lookup-order-forensics.md (forensics +
locked tests).

1. **Root registration**: `registerRoot(normalized path)` is idempotent; the
   stable rootID = the normalized path; explicit order = registration order
   (workspace roots first, external asset roots in getIndexScanRoots
   declaration order) — query results **never depend on Map insertion order
   or OS enumeration order**.
2. **File-to-root ownership**: longest-prefix match (nested asset roots win).
3. **Scan order = registration order**: `findFilesAcrossRoots` enumerates in
   root order, so "first registration wins"-style rules are reproducible.
4. **Same-name symbol policies** (locked tests in semanticIndex.test.ts):
   - Entity-name mapping: later registration overwrites earlier (single
     winner); conflicts are fully exposed via `findEntityConflicts`, never
     silent;
   - Class name→entity and owner (kind+name) backtracking: first registration
     wins (first in registration order);
   - Python file→entity: exact owner match (case-insensitive path) → basename
     entity-name fallback → upper-layer PythonClassIndex as backstop;
   - Invalidation is root-isolated: rootB's types.xml change does not
     invalidate rootA snapshots; same-name defs across roots stay separate via
     the documentStore version axis.

## 4. Invalidation rules

| Change | Invalidation scope | Mechanism |
|---|---|---|
| Python file edit | that file's revisions+1 → classes/bases/methods/mro axes rebuilt per parse result; MRO cache cleared | documentStore version check + pythonClassIndex single-file path |
| .def / entities.xml / types.xml / alias.xml | composition-root fingerprint (mtime+size) mismatch triggers re-derivation; affected symbols adjudicated via SemanticDependencyGraph | notifySemanticFilesChanged → InvalidationPlan |
| Type-registry files | only that root's type-registry snapshot is invalidated, rebuilt keyed by (root, switch) | PR4: per-call statSync fingerprints removed; rebuilds driven only by update events |
| File delete/rename | unindexFile removes the old symbol entries precisely | Scenario 6: 11.3ms, 0 stale hits |
| Diagnostics config change | only diagnostics-related keys (enableDiagnostics/enableStructureDiagnostics/diagnostics.*) trigger cleanup (invalidateAll) or recompute; other kbengine.* changes cause 0 recomputes | extension.ts config surface + diagnosticScheduler |
| When VS Code file events are unreliable | explicit consistency-check entry (bounded rescan / manual refresh); no per-query full metadata checks | scanRoots result lifecycle cache |

## 5. Task scheduling (src/indexScheduler.ts)

- Task kinds: `initial-scan` / `single-file-update` / `dependency-update` /
  `delete-cleanup` / `full-reindex` / `non-interactive`.
- Priority (lower number first): CurrentFileLight 0 → RequestLocal 1 →
  DependencyUpdate 2 → BackgroundFull 3 → NonInteractive 4;
  `isInteractivePriority` = priority < 3.
- Mechanics:
  - same-key task merge (same URI, newest version wins; stale tasks
    cancelled/dropped);
  - interactive cooldown (interactiveCooldownMs): background full tasks yield
    to interactive tasks, chunked 16-way concurrency per chunk with
    inter-chunk preemption;
  - failure recovery: failed tasks retry and never sit in pending forever
    (locked test); staging probe failures are not cached forever;
  - status queries: `SchedulerStatus` / `SchedulerMetrics` (includes
    backgroundDelayMs);
  - activation schedules initial-scan + full-reindex immediately
    (extension.ts); providers only wait for RequestLocal-level tasks.

## 6. Data-flow example (cold-start Definition; final report U1=475.34ms)

```text
activation ─▶ scheduler queues initial-scan (discovery) + full-reindex (chunked background)
user's first Definition ─▶ Provider: ① static MRO hit? ② composition-root hit? ──yes──▶ answer now (no waiting)
                                        └──no──▶ RequestLocal on-demand single-file parse (query file/import candidates/same dir)
                                                 still missing ▶ re-query after background convergence (③ reverse shape)
background scan of 30,001 files continues ▶ finishes at U2=106.6s; interaction never blocked meanwhile
```

## 7. Related documents

- Final performance report: docs/perf/2026-final-report.md
- Baseline: docs/perf/2026-baseline.md; per-PR reports: docs/perf/2026-pr2/3/5/6-*.md
- Lookup-order forensics: docs/review/2026-10-23-pr4-lookup-order-forensics.md
- Review master doc: docs/review/2026-10-22-unified-semantic-index-refactor.md
