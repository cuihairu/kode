# Knowledge Base (KB-001)

> KB-001 [P2]: a bilingual (en + zh) engine knowledge base, grounded in the
> KBEngine source under `kbe/src` (`kbengine@c2a3b8f`). Every claim cites the
> exact `file:line`; no fabricated behavior, no unimplemented feature written
> as implemented.

## Structure

| Bucket | Content | Status |
| --- | --- | --- |
| ① API 知识 | `KBEngine.*` Python API reference | todo (later batch) |
| ② 引擎机制文档 | lifecycle, references, callbacks, timers, network | **in progress** |
| ③ 使用模式与统计 | canonical usage patterns, frequency stats | todo (later batch) |
| ④ 踩坑经验 | traps, footguns, common bugs | todo (later batch) |

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
    timer registration/removal (`entity_macro.h:1478`).

## Pipeline

Source extraction → manual curation → consumers. Planned consumers
(later batches, not fabricated as done):

- **C-21**: hover tooltips powered by KB articles.
- **MCP-001**: expose KB to MCP for agent consumption.
- A `kbe-api-scan.py` extraction script (bucket ①) is a **later-batch**
  deliverable — not yet written.

## Grounding rules

- Citations must resolve to a real line in `kbe/src`; verify against the
  workspace commit before writing.
- Later-batch topics (timer/Functor deep reference holding, baseapp path
  detail, cross-process reference flow) are marked **TODO**, never written as
  complete.
- KB-001 stays **unchecked** in `todo.md` until all buckets and consumers are
  delivered.
