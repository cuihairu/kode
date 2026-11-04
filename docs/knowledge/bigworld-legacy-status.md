# BigWorld API legacy stubs: disposal decision (KB-API-009)

> Status: **decision record** (2026-11-04). Source material:
> `../kbengine/docs/api/bigworld/{index,base,bigworld-module,bwpersonality,entity}.md`
> — five skeletal stubs (1.2k–1.7k each) left over from the `kbengine_api(cn).chm`
> conversion. This record decides their disposal and states the evidence that
> backs the decision. It is **not** an API reference and contains no integrated
> API item.

## 1. Decision: explicitly do not integrate (`明确不整合`)

The five `bigworld/` stubs are **not** integrated into any KBEngine API article.
They remain only as source-material index notes (their current form) inside the
KBEngine fork's `docs/api/bigworld/`. The reason is scope, not source
unavailability:

1. **They document a different engine.** The stubs are the API of
   **BigWorld-Engine-14.4.1** (the commercial upstream), not KBEngine. The kode
   knowledge base is grounded in the KBEngine source (`kbe/src`, commit
   `kbengine@c2a3b8f` per `docs/knowledge/README.md`), and the KBEngine API
   reference is the actual deliverable — already built as KB-API-001..008.
2. **No kode consumer targets BigWorld.** kode is a KBEngine extension; its
   hover / completion / diagnostics / knowledge consumption operate on KBEngine
   projects. A BigWorld API reference would serve no consumer.
3. **The extraction is large and redundant.** Per the stubs' own "Next steps",
   integration means extracting from `/*~` source comments and comparing item by
   item with KBEngine. Verified scope below (§3): ~532 server-side `/*~` blocks
   (249 function + 175 attribute + 47 callback + 22 class + 8 module). Each item
   would need per-item grounding, and the stubs themselves warn against carrying
   KBEngine component names and semantics over directly.
4. **The submodule is not checked out.** The BigWorld source lives in the
   fork's `BigWorld-Engine-14.4.1` git submodule, which is **uninitialized** in
   the fork working tree (empty directory). Reading the source requires
   initializing the submodule or cloning the repo first (§2).
5. **Acceptance forbids it.** KB-API-009's own acceptance says stub content must
   not be integrated as verified API into any article; these stubs have no
   signatures or semantics, only source locations + recognized API groups.

## 2. Evidence: where the source actually lives

The stub-referenced source is **not** in the fork's checked-out tree; it is a
git submodule:

- `../kbengine/.gitmodules`:
  `[submodule "BigWorld-Engine-14.4.1"] url = git@github.com:cuihairu/BigWorld-Engine-14.4.1.git`
- `git ls-tree HEAD BigWorld-Engine-14.4.1` → mode `160000` (gitlink), commit
  `3d3cc16ae60bb1d71cb014e9b0539e54e6d8c4fb`.
- Working tree: `BigWorld-Engine-14.4.1/` is **empty** (submodule not
  initialized) → the `/*~` surface is absent from the fork's checked-out state.

The BigWorld source **is** accessible (the submodule repo reachable; verified by
shallow-fetching the pinned commit `3d3cc16`), so unavailability is **not** the
reason for the decision — scope is (§1).

## 3. Evidence: the `/*~` comment surface exists at the pinned commit

Verified by shallow-fetching the pinned commit `3d3cc16` (`Update README.md`)
and grepping the checked-out tree:

| Query | Result |
|---|---|
| `programming/bigworld/server` exists | yes |
| `server/baseapp/base.hpp` exists | yes — `/*~ class BigWorld.Base` at **base.hpp:38** |
| `server/baseapp/base.cpp` `/*~` blocks | **33** |
| All 11 stub-referenced source files exist | yes (base.hpp, base.cpp, bigworld.mpp, script_bigworld.cpp, bwpersonality.mpp, cellapp/entity.cpp, real_entity.cpp, witness.cpp, cellapp.cpp, lib/server/app_script_timers.cpp, lib/server/bwpersonality.mpp) |
| `programming/bigworld/server` — files with `/*~` | **57** files |
| `programming/bigworld/server` — `/*~` blocks | **532** |
| … breakdown | 249 function · 175 attribute · 47 callback · 22 class · 8 module · 31 empty |
| `programming/` (whole tree) — `/*~` blocks | **2734** (409 files) |

Conclusion: the `/*~` surface the stubs point at **exists** (server side ~532
items), but it is a BigWorld surface, and integrating it is a separate,
non-KBEngine knowledge track.

## 4. Reasoning (three-way evaluation)

| Option | Cost | Benefit | Verdict |
|---|---|---|---|
| **整合** (integrate) | Extract + ground ~532 server items (249 fn / 175 attr / 47 cb / 22 class / 8 module); per-item BigWorld↔KBEngine comparison; submodule init/clone first | A BigWorld API reference with **no kode consumer**; parallel to the already-complete KBEngine reference | **rejected** — out of KB-API scope, no consumer, redundant |
| **只留状态说明** (status-note only) | Write this record | Stubs remain discoverable as source-material index | kept (this record is the status note) |
| **明确不整合** (explicitly don't integrate) | Document the boundary | Prevents future mis-scoped work; keeps the KBEngine reference the single API source | **chosen** |

## 5. Scope boundary (prevents future mis-scoped tasks)

- The `bigworld/` stubs are **BigWorld-Engine-14.4.1** source-extraction notes,
  **not** KBEngine. Do not fold them into any KBEngine API article
  (KB-API-001..008) or into the KBEngine knowledge base.
- The KBEngine API reference is complete via KB-API-001..008; bigworld adds no
  KBEngine content.
- If BigWorld API support is ever genuinely needed (out of kode's current
  scope), it is a **separate BigWorld knowledge track**, not a KB-API task, and
  requires: initializing/cloning the `BigWorld-Engine-14.4.1` submodule →
  extracting from `/*~` comments → per-item grounding with the BigWorld source
  `file:line` → a BigWorld↔KBEngine item-by-item comparison (the stubs'
  `docs/study/23-bigworld-and-kbengine-comparison.md` reference is the map).
- Nothing in this record is a verified API claim; it cites only source locations
  and grep counts, no behavior.

## 6. Acceptance mapping (KB-API-009)

- [x] Decision backed by evidence: `/*~` surface verified at pinned commit
  `3d3cc16` (grep counts + `base.hpp:38` in §3); submodule-not-checked-out state
  verified in §2.
- [x] Three-way recommendation with reasons: §1 (choose `明确不整合`) + §4 table.
- [x] Stub content **not** integrated as verified API: no API item from the
  stubs appears in any KBEngine article; this record is a decision, not a
  reference.
- [x] Scope boundary documented: §5.
