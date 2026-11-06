# Five-Index Ownership and Invalidation Contract (KODE-ARCH-003 · 2026-11-05)

> Original entry: establish an ownership and version-invalidation contract
> document plus assertions for the five indexes (SemanticIndex/EntityMapping/
> PythonClassIndex/WorkspaceIndex/GlobalDataIndex).
>
> This document describes current code facts; every contract has a matching
> assertion (`tests/indexOwnershipContracts.test.ts`, with test names numbered
> `C-<series>` aligned to this document). Any change to invalidation semantics
> must edit this document and the assertions in the same commit.

## General rules

- **Ownership**: all five indexes are constructed inside `activate()`
  (`src/extension.ts`) with the extension's lifecycle; whoever constructs,
  disposes — tests follow the same rule with `finally { index.dispose(); }`.
- **Invalidation principle**: a physical file change → each index **precisely
  adjudicates** the affected derived layers and bumps only the affected
  layers' version generation; no full-rescan self-healing (full invalidation
  is reserved for root-set switches, configuration switches, and shutdown
  surfaces).
- **In-flight guard**: every async task's callback compares the
  generation/revision token captured at task start; a stale-generation
  callback must never overwrite a newer generation (same-family discipline as
  IDE-REV-001 / AUD-034 / AUD-071).

## 1. SemanticIndex (`src/semanticIndex.ts`)

- **Ownership**: a private instance of `EntityMappingManager`
  (entityMapping.ts:208) exposed via `getSemanticIndex()`; the module-level
  singleton `getSemanticIndex()` (semanticIndex.ts:368) is a separate shared
  type-registry surface — the two are not interchangeable.
- **Data surface**: entity projection (name/defFile/pythonFiles/owners — five
  index Maps) + type-registry snapshots (key = normalized root path + the
  aliasDiscovery switch).
- **Invalidation contract**:
  - C-S1 snapshot invalidation adjudicates precisely by dependencies:
    `notifySemanticFilesChanged` invalidates only snapshots whose dependencies
    hit a changed file (semanticIndex.ts:313).
  - C-S2 an empty changed-files array = invalidate everything (documented
    escape hatch; production hot paths never take it).
  - C-S3 `removeRoot` removes the whole root; keys carry the `#` separator so
    other roots sharing a prefix are not hit (/ws/a vs /ws/ab); the root
    descriptor is deregistered together.
  - C-S4 snapshot generation is strictly monotonic (only increases across
    stores/invalidations, never decreases).
  - C-S5 re-registering the same defFile = replacement (a def file has unique
    ownership); same-name entities registered later overwrite (strategy ①).

## 2. EntityMappingManager (`src/entityMapping.ts`)

- **Ownership**: constructed in activate (extension.ts:712, shared
  IndexScheduler); holds the def/python/types-registry watchers +
  SharedFileEventMerger + the dependency graph; dispose unsubscribes
  everything (entityMapping.ts:2591). In gated mode (`deferStartup: true`)
  construction has zero side effects and `ensureStartup()` wires up
  idempotently.
- **Data surface**: the .def entity-mapping index (properties/methods/Python
  bindings/call graph), with the SemanticIndex projection registered in the
  same commit.
- **Invalidation contract**:
  - C-E1 gated construction has zero side effects (no watchers, no initial
    scan queued) — assembly order is free.
  - C-E2 `removeRoot(rootPath)` removes all mappings under that root and the
    external-watcher bookkeeping (isUnderRemovedRoot prefix adjudication).
  - C-E3 def changes → precise removal per def file (removeIndexByDefFile +
    dependency-graph removeFile), never a full rescan; unrelated files trigger
    nothing.
  - C-E4 dispose works before startup (idempotent, no observer leaks).

## 3. PythonClassIndex (`src/pythonClassIndex.ts`)

- **Ownership**: constructed in activate (extension.ts:1035, shared
  IndexScheduler).
- **Data surface**: py classes/MRO/composition roots; five-axis version
  generations `classes/bases/methods/mro/compositionRoots`
  (explicit query via `getIndexVersions()`, pythonClassIndex.ts:224).
- **Invalidation contract**:
  - C-P1 invalidating a never-indexed .py file = no-op (discovery-phase
    notifications must not restart scans).
  - C-P2 full `invalidate()` (root switch/shutdown surface): classes/bases/
    methods/compositionRoots each exactly +1; mro advances once via the
    five-axis loop and once via scan reset (+2 total — code fact).
  - C-P3 non-.py file changes: composition roots are invalidated only if the
    dependency graph has them on record (entities.xml/.def/types.xml/py with
    instance assignments); unrecorded files move none of the five axes.
  - C-P4 single-file invalidation of an indexed .py: only the `classes`+`mro`
    axes advance (precise adjudication of derived layers); the file's revision
    advances exactly +1.
  - C-P5 `syncDocumentParse` with a matching version returns the cached object
    directly (zero parsing).

## 4. WorkspaceIndex (`src/workspaceIndex.ts`)

- **Ownership**: constructed as an activate-time singleton (extension.ts:1208,
  `sharedWorkspaceIndex`), consumed through the event-call (`EventCallIndex`)
  surface; watchers attach before discovery (KR-AUD-27: changes during the
  initial scan enter the index via revisions without loss).
- **Data surface**: py file event-call (addEvent/sendEvent target) cache
  (path → IndexedFile); open documents follow the buffer, save/close
  self-heal back to disk.
- **Invalidation contract**:
  - C-W1 lazy start: queries before start return empty and create no watchers.
  - C-W2 dispose is idempotent; after dispose, `ensureStarted` no longer
    starts (watcher count does not grow), and the emptied cache is not
    resurrected.

## 5. GlobalDataDictIndex (`src/globalDataIndex.ts`)

- **Ownership**: constructed in activate (extension.ts:947, `dataDictIndex`).
- **Data surface**: an index of `kbe.dataDict` key-value access points
  (key signature → read/write points) + function return inference; scoped by
  asset root (`resolveScopeRoot`).
- **Invalidation contract**:
  - C-G1 root-set generation `generation`: advanced by `removeRoot`/
    `invalidate`; in-flight stale reads must not publish against the old root
    set (AUD-071, globalDataIndex.ts:1501).
  - C-G2 `invalidate()` clears byKey/cache/function-return surfaces and
    rebuilds against the current root set; after dispose, `invalidate()` is a
    no-op (no rebuild queued, no buffers left behind).
  - C-G3 large-file edit buffers: after convergence commits,
    `editBufferEntryCountForTests()` returns to zero (AUD-076: the merge
    window leaves no residue).

## Where the assertions live

`tests/indexOwnershipContracts.test.ts` — the C-* numbers above map one-to-one
to `it()` title prefixes; run
`pnpm vitest run tests/indexOwnershipContracts.test.ts` to verify.
