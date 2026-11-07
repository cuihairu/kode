# Knowledge Base (KB-001)

> KB-001 [P2]: a bilingual (en + zh) engine knowledge base, grounded in the
> KBEngine source under `kbe/src` (`kbengine@c2a3b8f`). Every claim cites the
> exact `file:line`; no fabricated behavior, no unimplemented feature written
> as implemented.

## Structure

| Bucket | Content | Status |
| --- | --- | --- |
| ① API 知识 | `KBEngine.*` Python API reference | **done**（KB-API-001~009 全部落地;C-21 消费:225 条抽取库喂 hover/RPC） |
| ② 引擎机制文档 | lifecycle, references, callbacks, timers, network | **first pass done**（lifecycle + migration/teleport + startup + entry SPI + directories;baseapp 路径细节仍为后续批次 TODO） |
| ③ 使用模式与统计 | canonical usage patterns, frequency stats | **first pass done**（`kbe-api-scan.py` + api-usage-stats,仅本仓库两树口径;官方示例/真实项目扩大属后续） |
| ④ 踩坑经验 | traps, footguns, common bugs | **index established**（traps-index 汇总各页陷阱;随页面增长持续对账） |

Language convention (matches the doc site's locale mirror, same as
`guide/` ↔ `zh/guide/`): the `en/` tree is at `docs/knowledge/<topic>.md` and
the `zh/` twin at `docs/zh/knowledge/<topic>.md`, same citations, same claims.
The `en/` file is canonical for line-number drift checks.

## Articles

- **Entity lifecycle & object reference release** — the user-named head topic
  (memory object reference & release):
  - [English](entity-lifecycle-reference.md)
  - [中文](../zh/knowledge/entity-lifecycle-reference.md)
  - Covers: the live registry strong reference (`entities.h:24`); the destroy
    flow out of the registry into `garbages` (`entity_macro.h:1486`,
    `entity_app.h:713`, `entities.h:331`); the non-owning `garbages` registry
    (`entity_garbages.h:23`); reference semantics after destroy; the 3600 s
    leak detection (`entity_garbages.h:289`); destroy guards /
    AssertionError traps (`cellapp/entity.cpp:315/:322`); `onDestroy`
    callScript semantics and cell-data backup (`cellapp/entity.cpp:204`);
    timer registration/removal (`entity_macro.h:1478`); pending
    engine-held callbacks — the "Functor" question resolved as
    `PY_CALLBACKMGR` strong-ref + timeout + migration pickling
    (`callbackmgr.h:215`).

- **Entity teleport, cross-cellapp migration & cross-process references**:
  - [English](entity-migration-and-cross-process-references.md)
  - [中文](../zh/knowledge/entity-migration-and-cross-process-references.md)
  - Covers: the three addressable faces and `EntityCall` as a
    `(component, id)` remote handle (`entity_call.h:15`,
    `common.h:285-291`); `cellData` as a stale-by-design snapshot
    (`baseapp/entity.cpp:250/:1024/:1112`); `teleport` routing and guards
    (`cellapp/entity.cpp:3394/:3713`); the full cross-cellapp message flow —
    ghost transition (`:3964`), baseapp message buffering + in-place
    `cellEntityCall_` retarget (`baseapp/entity.cpp:1571/:1622/:1635`),
    target rebuild (`cellapp/cellapp.cpp:1880`), success destroy vs failure
    restore (`:2075/:2143`); which teleport callbacks actually fire at HEAD
    (base callbacks are a dead path, `baseapp/entity.cpp:1543-1546`);
    reference-invalidation rules and the traps checklist. Grounded at
    `kbengine@3082ab5`.

- **Python version baseline: 3.7 source material vs fork 3.12** (KB-API-001):
  - [English](python-version-baseline.md)
  - [中文](../zh/knowledge/python-version-baseline.md)

  - Covers: the 3.7.3 → fork-3.12 version timeline with per-claim evidence;
    the four verified runtime-baseline facts (python312 vcxproj links, source
    repo doc drift, the neutralized `PyEval_InitThreads` call site, the
    untracked vendored `kbe/src/lib/python` tree); the embedding-layer C API
    audit table (`script.cpp:203/:239` are the only 3.13-blocking calls); the
    script-layer deviation skeleton; the fixed deviation-annotation template
    used by KB-API-002~008.

## Pipeline

Source extraction → manual curation → consumers. Planned consumers
(later batches, not fabricated as done):


- **API reference: client face** (KB-API-002):
  - [English](api-client.md)
  - [中文](../zh/knowledge/api-client.md)
- **API reference: baseapp module + Entity/Proxy** (KB-API-003):
  - [English](api-baseapp.md)
  - [中文](../zh/knowledge/api-baseapp.md)
- **API reference: baseapp entity classes** (KB-API-003):
  - [English](api-baseapp-entity.md)
  - [中文](../zh/knowledge/api-baseapp-entity.md)
- **API reference: cellapp face** (KB-API-004):
  - [English](api-cellapp.md)
  - [中文](../zh/knowledge/api-cellapp.md)
- **API reference: bots face** (KB-API-007):
  - [English](api-bots.md)
  - [中文](../zh/knowledge/api-bots.md)

- **API reference: interfaces face** ((KB-API-005)):
  - [English](api-interfaces.md)
  - [中文](../zh/knowledge/api-interfaces.md)

- **API reference: loginapp / dbmgr / logger faces** ((KB-API-006)):
  - [English](api-loginapp-dbmgr-logger.md)
  - [中文](../zh/knowledge/api-loginapp-dbmgr-logger.md)

- **API core concepts map** ((KB-API-008)):
  - [English](api-core-concepts.md)
  - [中文](../zh/knowledge/api-core-concepts.md)
  - Covers: the bots process script-face assembly (six registration sites);
    19 `KBEngine` module functions (8 documented + 11 fork-only), with the
    `addBots` request-vs-instantiation semantics; entry-script callbacks
    `onInit`/`onFinish` (+ fork-only `onTargetChanged`); the read-only `bots`
    `PyBots` mapping; the client-object face (source name "PyClientApp" = fork
    `ClientObjectBase`); the shared `Entity` face re-anchored locally; the
    3.7-vs-fork deviation table (incl. the source material's phantom
    `cellData`/`isOnGround`/`PyClientApp` items).

- **BigWorld API legacy stubs disposal decision** ((KB-API-009)):
  - [English](bigworld-legacy-status.md)
  - [中文](../zh/knowledge/bigworld-legacy-status.md)
  - Covers: the five skeletal `bigworld/` stubs (BigWorld-Engine-14.4.1, not
    KBEngine) are explicitly **not** integrated; the `/*~` source-comment
    surface they reference is verified to exist at the submodule's pinned
    commit `3d3cc16` (server: 57 files / 532 `/*~` blocks, incl.
    `server/baseapp/base.hpp:38` `/*~ class BigWorld.Base`), but the submodule
    is uninitialized in the fork working tree and the surface is a different
    engine with no kode consumer; scope boundary documented so no future
    mis-scoped task folds BigWorld into the KBEngine reference.
- **C-21**: hover tooltips powered by KB articles (delivered — see
  `src/pythonApiHoverDocs.ts` and `crates/kode-server/api_docs.rs`).
- **MCP-001**: expose KB to MCP for agent consumption (delivered — the
  `explain` tool in `crates/kode-mcp/src/explain.rs`: API face = the C-21
  shared library, mechanism face = the article index above).
- **API usage patterns & frequency stats** (bucket ③):
  - [English](api-usage-stats.md)
  - [中文](../zh/knowledge/api-usage-stats.md)
  - Covers: `scripts/kbe-api-scan.py` (AST-based, stdlib-only) over the two
    in-repo trees (77 files, 0 parse errors); `KBEngine.*` module usage
    table; entity-API member popularity; engine-known vs project-defined
    callback split (~1/3 project-defined); observed patterns (timer
    discipline with `delTimer` never called, cell-creation pair, remote-handle
    direction, interfaces polling pair). Honest scope: in-repo trees only.
- **Traps index** (bucket ④):
  - [English](traps-index.md)
  - [中文](../zh/knowledge/traps-index.md)
  - Covers: one-row-per-trap index across the knowledge pages — memory &
    references, migration/teleport, timers & controllers, EntityCall
    semantics, callback naming/face placement, client-face availability,
    source-material hygiene. Each row links the article carrying the full
    grounded root cause; no claims beyond the targets.

## Grounding rules

- Citations must resolve to a real line in `kbe/src`; verify against the
  workspace commit before writing.
- Later-batch topics (baseapp path detail) are marked **TODO**, never written
  as complete. The cross-process reference flow (migration/teleport) and the
  timer/pending-callback reference holding (the "Functor" question — no
  Functor exists in KBEngine; the holder is `PY_CALLBACKMGR`) are covered by
  their articles (grounded at `kbengine@3082ab5`).
- KB-001 stays **unchecked** in `todo.md` until all buckets and consumers are
  delivered.
