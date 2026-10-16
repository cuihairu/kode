# Def / custom type → `.pyi` type stubs: feasibility analysis (analysis only, no implementation)

> Source: user request on 2026-10-16 — "Can the extension generate `.pyi` files for the utype-defined types, producing type hints automatically; is that realistic?"
> This round only settles design and conclusions, no implementation code is written; every judgment carries a `file:line`, and corpus limitations are stated as they are.

## 0. Verdict summary

| # | Question | Verdict | Effort |
|---|---|---|---|
| 1 | Can the existing parsers read a utype definition | **Yes, but not in the entityMapping/PythonClassIndex track** — definitions are parsed by `databaseSchema.parseTypeAliases` (types.xml); `.def`/`PythonClassIndex` only store references and Python classes | Small (wiring) |
| 2 | utype → Python annotation mapping | **Realistic**: scalars/ARRAY/aliases translate directly, FIXED_DICT → `TypedDict`; deep nesting needs a real project to verify | Small–medium |
| 3 | Generated artifact + Pylance wiring | **Realistic only with a precondition**: reuse the existing `stubDir`+`extraPaths` facilities; but a **pure `.pyi` module cannot be `import`-ed at runtime**, so choose a real `.py` (TypedDict) or a `TYPE_CHECKING` convention; and **never** generate a same-named `.pyi` that shadows a project `.py` | Medium |
| 4 | Timing and updates | **Realistic**: the auto-export-on-activation + manual command precedents exist, and a debounced `.def`/types.xml watcher has a precedent; default-dir artifacts are **not committed** | Small–medium |
| 5 | Making `self.x` statically knowable to Pylance (without changing user code) | **Not realistic** (the only Pylance path is shadowing a project `.py`, which breaks implementation semantics); today kode's own providers fill this surface | — |
| — | Overall | **Realistic with a precondition**: "generate a type module for the type surface" = doable at medium effort; "self-annotation of entities" = not realistic without changing user code or keeping the kode providers | Medium |

## 1. Current state: how far the existing parsers reach

### 1.1 The entityMapping / PythonClassIndex track **cannot** read utype definitions

- `src/defParser.ts:58` `parseDefDocument` is a generic XML parser (fxp, `parseTagValue:false` see `:55`), it carries no type semantics.
- `src/entityMapping.ts:152` builds its index only from `findFiles('**/*.def')`; the index structure `:107-123` (`EntityMappingIndex`) only has `methodDefinitions`, `properties: { [name]: { defFile, line } }` etc. — it stores **reference landing points**, passing the Type string through verbatim, storing no type definitions.
- `src/pythonClassIndex.ts:40` `parsePythonFile` only parses classes/methods of `.py`, scan surface `:247` `findFiles('**/*.py', ...)` — it **never looks at .def**.

→ Conclusion: neither of the two indexes named in the question **contains utype definitions**; the definitions live in `entity_defs/types.xml`, parsed by a different line below.

### 1.2 The three places that actually parse type definitions (already in this repo, reusable)

1. **types.xml alias definitions (= the utype definitions themselves)**: `src/databaseSchema.ts:724` `parseTypeAliases` → `Map<name, { kind: 'fixedDict'|'array'|'builtin'|'unresolved', ... }>`; the comment aligns with the engine's `DataTypes::loadTypes` (alias = entry tag, `FIXED_DICT`/`ARRAY` go structural, the rest reuse registered types as text), see `:96`, `:742-747`; wiring at `:246`. FIXED_DICT keys and element types are kept on the XML `node`, so sub-parsing can continue.
2. **Type strings in `.def` (including inline ARRAY)**:
   - `src/kbengineMetadata.ts:11-12` notes the engine's `entitydef.cpp` special case for the property `<Type>ARRAY<of>…</of></Type>` form, `:41` lands it in the completion docs;
   - `src/definitionSemantics.ts:74-88` structures the `<Arg>` sequence (ARRAY via the `<of>` chain, recursive nesting, `:627`, `:693` comments align with `FixedArrayType::initialize`);
   - `src/clientSdkGenerator.ts:116-118`, `:197` read the `<Type>` direct text and the `<of>` element type in two columns per the engine convention.
3. **The existing "utype → target language" precedent (closest finished artifact to this need)**: `src/clientSdkGenerator.ts:152` `aliases: ReadonlyMap<string,string>`; `:272-295` "language-neutral type table: builtin table per language, aliases and FIXED_DICT share the same origin as the project types.xml"; `:301-321` resolution chain **builtin → FIXED_DICT name → alias recursion → fallback**; FIXED_DICT companion classes emitted at `:559` (TS), `:571` (C#), `:667` (separate file). **This isomorphic problem has already been solved once in the TS/C# generator**; `.pyi` is a third emission target.

### 1.3 Terminology: this repo's "utype" has two layers (don't mix them)

- **Message-layer utype = type/method number**, not a custom type: `src/messageTable.ts:127` "this-level type utype (ARRAY level = the inline array type's own utype)"; engine side `kbe/res/sdk_templates/client/ue4/Source/KBEnginePlugins/Engine/Bundle.h:133` (`uint16 utype`), `EntityCall.cpp:67` (`methodUtype`).
- **This request's "utype" = custom type alias / composite type**, i.e. types.xml alias entries + `.def` references. The `.def` `<Aliases>` section has **0 hits** in this repo's corpus (`grep '<Aliases>' --include='*.def'` is empty repo-wide); alias definitions actually all live in `types.xml`.

### 1.4 Real samples (corpus stated as is)

**Sample 1 — definition (composite type)**, `D:\workspaces\kbengine\.tmp\kbengine_typing_fixed_dict_fixture\scripts\entity_defs\types.xml` (13 lines total):

```xml
2:  <AVATAR_INFO> FIXED_DICT
3:      <Properties>
4:          <name><Type> STRING </Type></name>
7:          <level><Type> UINT32 </Type></level>
10:     </Properties>
11: </AVATAR_INFO>
12: <AVATAR_INFO_LIST> ARRAY <of> AVATAR_INFO </of> </AVATAR_INFO_LIST>
```

**Sample 2 — reference (a `.def` using a utype)**, the same fixture's `scripts/entity_defs/Avatar.def`:

```xml
4:      <Type> AVATAR_INFO </Type>          <!-- profile 属性 -->
8:      <Type> AVATAR_INFO_LIST </Type>     <!-- history 属性 -->
14:     <Arg> AVATAR_INFO </Arg>            <!-- BaseMethods.updateProfile -->
19:     <Arg> AVATAR_INFO_LIST </Arg>       <!-- CellMethods.syncSnapshots -->
```

**Sample 3 — inline ARRAY form (engine special case)**: the doc text registered at `src/kbengineMetadata.ts:41` — "inline form `<Type>ARRAY<of>element type</of></Type>`, the element type goes in the `<of>` child node", per the property-loading special case in `kbe/src/lib/entitydef/entitydef.cpp` (`:11-12`).

**Corpus limits (stated as is)**:

- Non-third-party `.def` files in the whole repo: **18** (mostly `.tmp` type fixtures + SDK templates + BigWorld samples); visible `<Type>` values are only `STRING`/`INT32`/`INT16`/`INT8` plus the two fixture utypes above.
- **The SDK template `types.xml` is an empty shell** (2 lines); complex type distributions (multi-level nesting, VECTOR3 keys, mixed ARRAY) **have no real samples in this repo**; the type surface of a real game project must be re-verified once available (see §7).
- The word "utype" actually appears in this repo only in the message/method-number context (§1.3); there is **no** `.def` structure named utype.

## 2. Mapping feasibility: utype → Python type annotations

| utype form | Real example | Target annotation | Tier |
|---|---|---|---|
| Scalar | `STRING`/`INT32` (Avatar.def:4 same shape on the reference surface) | `str` / `int`; `FLOAT`/`DOUBLE`→`float`; `BOOL`→`bool` | **Direct (small)** |
| `PYTHON` / `PY` / unrecognized | outside the corpus, engine semantics = arbitrary object | `typing.Any` (lossy but legal) | Direct (small) |
| Alias → registered type | types.xml third form (`parseTypeAliases` 'builtin' arm `databaseSchema.ts:750`) | `AVATAR_NAME = str` (type alias) | **Direct (small)** |
| ARRAY element type | `AVATAR_INFO_LIST` (types.xml:12) | `list[AVATAR_INFO]`; nested `list[list[T]]` (recursion chain already in `definitionSemantics.ts:75`) | **Direct (small)** |
| FIXED_DICT | `AVATAR_INFO` (types.xml:2-11) | `class AVATAR_INFO(TypedDict): name: str; level: int` | **Needs a generated class (small–medium)** |
| Nested FIXED_DICT / vector keys | no real sample in this repo | nested `TypedDict` recursion; key types reference the vector class (see §7 to verify) | Medium (needs a real project) |
| Fixed-length array (FIXEDARRAY) | engine DB layer `kbe/src/lib/db_interface/entity_table.h:24`, `FixedArrayType` (`entity_table_mysql.cpp:1261`) | **In Python it is just a list** → folds into the ARRAY direct translation; it is a DB storage structure, not a new Python shape | Direct (small) |
| Message/method utype number | `messageTable.ts:127`, `Bundle.h:133` | **Unrelated to type hints, not generated** | Excluded |

**Verdict**: the mapping surface is **realistic** — all three tiers are present, and the hardest part ("alias recursion + FIXED_DICT structure") already has an implementation path proven by `clientSdkGenerator.ts:301-321` to copy the convention from; the uncertainty is concentrated in real projects' composite depth (no samples in this repo).

## 3. Artifact form and Pylance wiring

### 3.1 Where it goes: reuse `stubDir`, never same-named with a `.def`

- The three-tier directory resolution already exists: **setting `kbengine.python.stubDir` (`package.json:1001`) > env var `KBENGINE_STUB_DIR` > default convention `.kbengine/stubs`** (`src/pythonStubExport.ts:24/:31/:37-39`, docs `docs/guide/configuration.md:277`).
- A `.def` has no same-named `.py` module, so "same-named with the .def" has nothing to hang on; suggested **single-module concentration**: `kbe_types.pyi` or `kbe_types.py` (see 3.2), living alongside the existing `KBEngine.pyi` (`pythonStubExport.ts:21`).

### 3.2 Getting Pylance to use it (existing wiring + one hard precondition)

- **The wiring already exists**: `python.analysis.extraPaths` is written by `src/pythonExtraPaths.ts:24` (the comment at `:4` states Pylance resolves through it); the default stub directory sits in the managed segment (`:8-9` "merged only when the setting is on and KBEngine.pyi is on disk"; boundary at `configuration.md:281`). Auto-sync on activation `extension.ts:972-975`, manual command `extension.ts:964-971` (`kbengine.python.exportStubs`).
- **Hard precondition (the whole line collapses without it)**: **a pure `.pyi` module cannot be `import`-ed at runtime** — Python's importer has no `.pyi` loader, so user code writing `from kbe_types import AVATAR_INFO` fails at runtime with `ModuleNotFoundError`, and is only safe inside a `TYPE_CHECKING` branch. Two viable landing options:
  - **Option A (recommended)**: generate a **real `.py`** (content = `TypedDict`/type aliases, usable at runtime) — holds for both Pylance and runtime; reuse the `stubDir` directory and the "content-identical zero-write" discipline (`pythonStubExport.ts:5-7/:58`).
  - **Option B**: keep a pure `.pyi`, **convention**: users write `if TYPE_CHECKING: from kbe_types import ...` plus string annotations — zero runtime dependency, but requires changing user code and writing it into the docs.
- **`python.analysis.stubPath`**: Pylance's other stub path, **0 hits in this repo** (not wired), listed as a to-verify option, not a dependency.
- **Red line: never generate a `.pyi` same-named with a project `.py`** (entity-class stubs). Under extraPaths/stub precedence, a same-named `.pyi` **shadows the project implementation file**, and Pylance would stop seeing the real method bodies (completion/navigation semantics replaced by the stub) — more harm than good → explicitly excluded.

### 3.3 Coexisting with the existing navigation index

- Everything **reads** `.def`/`types.xml` read-only; writes only land in `stubDir` (default dir is kode-managed, content-identical zero-write, suggest gitignore: `configuration.md:279`; the `KBEngine.pyi` header also carries that suggestion itself, `kbeModuleIndex.ts:513`).
- `entityMapping` (`:152`) and `PythonClassIndex` (`:247`) do not read `.pyi` — mutually unaffected; kode's own hover/completion/navigation (`languageProviders`, data source = `.def`) **does not depend on Pylance** — the two are **complementary, not conflicting**: Pylance gets type names, kode gets project semantics (RPC, DB storage, navigation).

## 4. Timing and updates

- **The precedent trio is complete**: auto-export on activation (`extension.ts:972-975`, `{ silent: true }`) + manual command (`:964-971`) + content-identical zero-write / stale-only rewrite (`pythonStubExport.ts:5-7/:58`).
- **`.def`/types.xml change → regenerate**: a debounced watcher has a ready precedent (`src/hotReload.ts:5` builds a watcher, debounce-merges successive saves, `:38-44` debounceMs convention) → suggested same approach; the minimal start can be **manual command + activation only**, the watcher as phase two (small → medium).
- **Whether artifacts are committed**: the default `.kbengine/stubs` is already characterized as "kode-managed, suggest `.gitignore`, artifacts follow the index" (`configuration.md:279`, `kbeModuleIndex.ts:513`) → **not committed**; a user-configured directory = user assets, kode only scans, never overwrites (`configuration.md:279`).

## 5. Per-item conclusions and effort

1. **Reading a utype definition — realistic (small)**: no new parser; reuse `parseTypeAliases` (`databaseSchema.ts:724`) + the `clientSdkGenerator` resolution chain (`:301-321`); the only gap is **joining** the `.def` reference surface (`entityMapping.ts:107-123` Type strings) with the types.xml definitions into one type table.
2. **Mapping — realistic (small–medium)**: three direct-translation tiers + `FIXED_DICT→TypedDict` covers every sample-level shape; deep nesting needs re-verification on a real project (uncertainty = medium, not effort).
3. **Artifact and wiring — realistic only with a precondition (medium)**: precondition A picks "real `.py` (TypedDict)" or precondition B establishes the `TYPE_CHECKING` convention (§3.2); keep the "don't shadow a project `.py`" red line. Once satisfied, reuse `stubDir`+`extraPaths`+the zero-write facility; the incremental work is mostly an **emitter + type table**.
4. **Making the entity property `self.x` statically knowable to Pylance — not realistic**: a stub cannot hang annotations anywhere without rewriting the user's `.py`; the only Pylance path is same-name shadowing (already excluded). That surface keeps being filled by kode's own providers (`languageProviders` hover/completion/navigation); if it is ever to be truly done, it is a "in-code annotation generation" new requirement (modifies user files, separate ignition).
5. **Auto-update — realistic (small–medium)**: the precedent trio is complete, the debounced watcher has the `hotReload` convention.
6. **Overall: realistic with a precondition (total effort "medium")** — "type module generation" is doable and reuses mostly existing pieces; "entity self-annotation surface" is not realistic without changing user code or keeping the kode providers.

## 6. Design points (for the next ignition round, not produced this round)

- Type table: `types.xml` aliases (`parseTypeAliases`) + the `.def` reference surface (`entityMapping` Type strings) compose a `Map<type name, type description>`; alias-recursion cycle protection follows the `clientSdkGenerator.ts:301` convention.
- Emission: direct translation for the scalar/ARRAY/type-alias three tiers; FIXED_DICT emits a `TypedDict` (key order follows the types.xml document order, `databaseSchema.ts:724` node traversal); a `from __future__ import annotations` header, zero runtime dependency.
- Landing: default `.kbengine/stubs/kbe_types.py(±.pyi)`, the same zero-write discipline as `KBEngine.pyi`; header states "generated artifact, suggest gitignore".
- Wiring: the file joins the `extraPaths` managed segment (aligned with the join condition at `pythonExtraPaths.ts:8-9`); either add one more emit on the `kbengine.python.exportStubs` surface or add a separate `kbengine.python.exportTypeStubs`.

## 7. To-verify list (cannot be asserted within this repo)

1. `python.analysis.stubPath` hit precedence over `extraPaths` for `.pyi` — not wired in this repo (0 hits), measure before implementing.
2. Type distribution of a real game project (multi-level nested FIXED_DICT, VECTOR3 keys, mixed ARRAY) — this repo's corpus only has fixture-level samples (§1.4); the SDK template `types.xml` is an empty shell.
3. Availability of the vector type (`VECTOR3`) inside `KBEngine.pyi` — the symbol table `KbeSymbolKind` in `src/kbeModuleIndex.ts` only has `class|function` (`:18`), and `VECTOR3`/`vector` have **0 hits** → whether the generated stub has a vector class to reference is unproven.
