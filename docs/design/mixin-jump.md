# Mixin Jump and CodeLens Design (mixin jump + provenance)

> Goal: fix "call sites on cross-class calls cannot jump to method
> implementations provided by mixins", and use CodeLens at classes/methods to
> annotate "which mixins provide this". Jumping and CodeLens **share one
> resolution** — not two. Acceptance standard: judged by **real-code jump
> success rate**, not test coverage.

## Current implementation (2026-10-18)

The following historical analysis records the design's original background;
current behavior defers to this section and the regression tests.

- Python classes are identified by file path, qualified name, and declaration
  position; the inheritance graph computes C3 MRO from class identity, without
  merging same-named classes across base/cell or other packages.
- Multi-line class headers, comments, in-parenthesis imports, import aliases,
  module prefixes, relative imports, and in-package re-exports are supported.
  When explicit import resolution fails, same-named classes in other modules
  are not guessed.
- `self.method` use sites prefer jumping to the Python implementation; when
  the implementation is missing they fall back to `.def` method declarations.
  Properties and method declarations keep `.def` navigation. When multiple
  valid combinations map to multiple implementations, a candidate list is
  returned.
- An unknown `self.object.method` is not treated as `self.method`, nor is the
  object type guessed merely because some same-named method exists in the
  same file.
- Ordinary mixin base classes in class headers are also jumpable, including
  multi-line and aliased forms. Call text inside comments or strings never
  triggers navigation.
- Open Python files, entity manifests, and definition files are read from the
  document buffer first; after closing, the disk index is restored. Stale
  async reads must never overwrite newer versions.
- Existing Python files update incrementally on save; create, delete,
  configuration, and workspace directory changes invalidate scans. An
  assetsRoot outside the workspace also gets file watching.
- The composition root derives per asset directory, preventing same-named
  entities in different projects from mixing their `.def`s.

Regression cases live in `tests/pythonMixinNavigation.test.ts`, covering the
above inputs and cache lifecycles; `tests/layeredJump.test.ts` verifies the
complete provider chain. These tests do not represent acceptance in real
game assets or the VS Code UI.

Static resolution still never executes Python: runtime injection, dynamically
computed base classes, factory-generated classes, and complex object type
inference are left to the Python language service or runtime analysis.

## 0. Historical conclusions at a glance

- **Solvability: partial.**
  - **Solvable (requires a new Python class hierarchy index)**: same-name
    multiple implementations, diamond inheritance, binding in `__init__` —
    all three share one root cause (currently **zero** Python class
    hierarchy/MRO resolution); adding a Python class symbol table + MRO
    solves them.
  - **Unsolvable (a fundamental limit of static analysis)**: runtime
    injection (`setattr` / decorators attaching methods at runtime) —
    statically invisible; only heuristic hints are possible, with no
    guarantee of a hit.
- **Root cause (one sentence)**: method ownership is currently decided by the
  **file-name basename** and the index **is built only from `.def`**, while
  mixins are ordinary Python classes with no `.def` — so any mixin-provided
  method is unfindable.

---

## 1. Current state: how jumping resolves method ownership (file:line)

### 1.1 Registration
- `PythonDefinitionProvider` is registered for
  `{ language: 'python', scheme: 'file' }` — `src/extension.ts:92-95`.

### 1.2 Entry
- `provideDefinition` — `src/languageProviders.ts:1900`. Two triggers:
  1. a `self.xxx` access → `getPythonSelfAccessAtPosition`
     (`src/pythonLanguageUtils.ts:14`, regex
     `/\bself\.(\w+(?:\.\w+)*)/g` at `:18`) → first
     `resolvePropertyDefinition` (`:1907`) then
     `resolveMethodDefinition` (`:1919`).
  2. a method declaration line → `getPythonMethodDeclarationAtPosition`
     (`src/languageProviders.ts:2126`) → `resolveMethodDefinition` (`:1933`).

### 1.3 Ownership resolution (core)
`EntityMappingManager.resolveMethodDefinition(pythonFile, methodName)` —
`src/entityMapping.ts:568`:
1. `ensureIndexForPythonFile(pythonFile)` — the index **is built only from
   `**/*.def`** (`src/entityMapping.ts:134` `findFiles('**/*.def')`, `:141`
   uses the `.def` file name as entityName, `:162` `buildIndex`).
2. `inferOwnerNameFromPythonFile(pythonFile)` = **`path.basename(pythonFile, '.py')`** —
   `src/entityMapping.ts:1073-1075`. **The owner is just the current Python
   file name.**
3. `inferOwnerKindFromPythonFile` — `:1077-1091`: path containing
   `/components/` → `component`, `/interfaces/` → `interface`, `.py` →
   `entity`.
4. `inferMethodSectionFromPythonFile` — `:1093-1109`: `/scripts/base/` →
   `BaseMethods`, `/scripts/cell/` → `CellMethods`, `/scripts/client/` →
   `ClientMethods`.
5. `selectMethodDefinition(index.methodDefinitions, {methodName, ownerKind,
   ownerName, section})` — **flat matching** among methods declared in
   `.def`s.

### 1.4 What kode actually reads from Python (determines what it can solve)
- `parsePythonMethodBlocks` — `src/entityMapping.ts:1142-1187`: regex
  `/^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/` (`:1148`) **flat-scans
  `def` lines one by one**.
  **It does not record which class a `def` belongs to, does not read the
  bases of `class X(A, B):`, and builds no scopes.**
- `parsePythonSelfCalls` — `:1189-1211`: regex `/\bself\.(\w*)\s*\(/g`
  (`:1195`), **recognizing only `self.x(` calls**.
- `getPythonSelfAccessAtPosition` — `src/pythonLanguageUtils.ts:14-45`:
  recognizes only `self.`-prefixed accesses.

→ **The repo has no Python class hierarchy / base class / MRO resolution at
all.** This is the common root cause of every mixin shape failing.

---

## 2. Mixin shape classification and "why the jump misses"

For a call site `self.doTick()` (provided by a mixin) inside
`class ServerEntity(ServerEntityCommon, RunnableMixin, ...)`:

| # | Shape | Why the jump misses (basis) | Solvability |
|---|---|---|---|
| A | **Same-name multiple implementations** | `parsePythonMethodBlocks` (`entityMapping.ts:1148`) **flat-scans `def`s without recording class scopes**, so same-named `def`s in multiple classes cannot have their ownership distinguished; `resolveMethodDefinition` also queries `.def`s only by **file-name basename** (`:1073-1075`). → cannot decide which to jump to | **Solvable** (after adding class scopes + MRO, all candidates can be listed) |
| B | **Diamond inheritance** | C3 linearization (MRO) is needed to decide "which base class's implementation wins first". Currently **zero base-class resolution** (`parsePythonMethodBlocks` does not read `class X(A,B):`), so no MRO can be computed | **Solvable** (requires implementing MRO) |
| C | **Runtime injection** (`setattr`/decorators attaching methods at runtime) | `parsePythonMethodBlocks` (`:1148`) matches only literal `def` lines; runtime-injected methods **have no `def` line at all** and are statically invisible | **Unsolvable** (a fundamental limit of static analysis; heuristics only) |
| D | **Binding in `__init__`** (`self.run = self._run_impl` / class attribute assignment) | `parsePythonSelfCalls` (`:1195`) matches only `self.x(` (parenthesized calls); `getPythonSelfAccessAtPosition` (`pythonLanguageUtils.ts:18`) matches only `self.x` accesses. **Assignment statements (`self.run = ...`) are recognized by neither**, and resolution still falls back to `.def` owner lookup | **Solvable** (requires assignment/alias tracking) |

**Common root cause**: A/B/D fail because "there is no Python class hierarchy
index"; C fails because it is statically invisible. The index eats only
`.def`s (`entityMapping.ts:134`), and mixins are pure Python classes with no
`.def`, so they are naturally absent from the index.

---

## 3. Verification against real kbengine code (limitations stated honestly)

**This machine's `D:\workspaces\kbengine` copy does not contain the mixin
entity shape the task exemplified.** Measured:
- `grep 'class ServerEntity(' --include='*.py'` → **no hits**;
  `ServerEntityCommon` → **no hits**.
- Repo-wide `Mixin` matches only vendored third-party perf code
  (`BigWorld-Engine-14.4.1/.../perf/sqlalchemy/*`,
  `perf/simplejson/ordered_dict.py`) — **not kbengine's own entity code**.
- KBEngine SDK template entities are all **single inheritance**:
  `class Account(KBEngine.Proxy)`
  (`kbe/res/sdk_templates/server/python_assets/scripts/base/Account.py:5`),
  `class Account(KBEngine.Entity)` (bots),
  `class Account(KBEngine.EntityComponent)` (components).

→ Conclusion: **this kbengine is engine + SDK templates, containing no game
assets with mixins**. Therefore **the mixin jump success rate cannot be
tested on this repo's kbengine** (there are no testable mixin entities).
`class ServerEntity(ServerEntityCommon, RunnableMixin)` is a **real KBEngine
game asset** idiom, not in this engine repo.

**What this repo can verify**: single-inheritance entities' existing jumps
follow §1's logic through the `.def` owner lookup, and the mechanism holds;
mixin scenarios can only be judged with **constructed fixtures + source
reasoning from §1/§2**, and must not pose as "real kbengine measured
results". If acceptance insists on "real kbengine jump success rate", a
**game-asset repo containing mixins** (not this engine repo) is required.

---

## 4. Implementation path (jump + CodeLens share one system)

### 4.1 A new Python class hierarchy index (single source of truth)
Add `PythonClassIndex`, consumed **jointly** by jumping and CodeLens
(avoiding two logics):
- **Enumerate classes**: parse the base list of
  `class X(Base1, Base2, metaclass=M):` plus each `def`'s **owning class
  scope** (fixing `parsePythonMethodBlocks`'s `entityMapping.ts:1142` flat
  scan: maintain class scopes via indentation/stack, recording
  `def → containing class`).
- **Resolve MRO**: C3-linearize `X`'s bases
  (`X → Base1 → Base2 → ... → object`) to get the **method lookup order**.
  When resolving `self.foo()`, find the first `def foo` in each class along
  MRO order — the real runtime implementation.
- **Import resolution**: a base may come from
  `from pkg.mixin import RunnableMixin`, requiring resolution to the defining
  file by module path (reuse/extend the existing workspace file index).

### 4.2 Jump behavior (merged with the existing jump)
- **Keep the existing `.def` path untouched** (`resolveMethodDefinition`
  `entityMapping.ts:568`): entity-declared methods still go through `.def`
  (KBEngine semantics: the method contract lives in `.def`).
- **Add a Python-hierarchy fallback**: when `.def` finds nothing (i.e.
  mixin-provided methods), consult `PythonClassIndex` to find the
  implementation by MRO. The merge point is `provideDefinition`
  (`languageProviders.ts:1900`): `.def` miss → try Python MRO → if neither,
  return null.
- **UI when multiple implementations exist**:
  - **MRO unique hit** (only 1 class in the MRO defines the method) → jump
    straight there (same experience as today).
  - **Multiple candidates** (same-name multiple implementations / diamond) →
    return `vscode.Location[]` and let VS Code natively pop a **list picker**.
    Each item's label carries "class name + defining file"; its description
    carries "MRO index + whether mixin".
  - **Never jump to the first**: jumping to the first misleads under diamonds
    (it may be an implementation that never executes); the list picker is the
    only presentation that does not lie.

### 4.3 Large-repo performance (incremental/caching mandatory)
- **Per-file caching + invalidation**: follow `EntityMappingManager`'s index
  cache approach; a Python file change (`onDidChangeTextDocument` / file
  watcher) re-parses **only that file's** class definitions — no repo-wide
  rescan.
- **Lazy MRO**: MRO is computed on demand only at **jump/CodeLens request
  time**, never pre-computing a repo-wide class graph.
- **Cross-file base resolution cache**: memoize import → defining-file
  resolution results; invalidate via a reverse import index on file change.
- **Budget caps**: a single jump's MRO traversal gets depth/node caps
  (defending against cyclic-import infinite loops); beyond the cap, degrade
  to "list direct bases".

### 4.4 CodeLens (shares `PythonClassIndex` with jumping)
- **Trigger points**: class definition lines (`class X(...)`) and method
  definition lines (`def foo`).
- **Content**:
  - At the class definition: "provided by: RunnableMixin, ServerEntityCommon"
    — listing which mixins/base classes the class inherits capabilities
    from; all sources **listed in full, each clickable**
    (`CodeLens.command` carries a location; clicking jumps to the
    corresponding mixin definition).
  - At the method definition: if that `def` is one of the same-named
    methods **shared by multiple classes in the MRO**, annotate "overrides
    Base.foo / provided to N subclasses".
- **Merged with jumping**: CodeLens's "source list" and jumping's
  "multiple-implementations list" come from **the same `PythonClassIndex`
  query result**; when jumping returns `Location[]`, CodeLens renders from
  the same candidate set, without re-implementing ownership resolution.
- **Fires on every class → incremental/caching** (avoid typing jank):
  - The CodeLens provider **reads caches only** (`PythonClassIndex` updates
    incrementally on file open/change) and does no re-parsing inside
    `provideCodeLenses`.
  - `vscode.languages.registerCodeLensProvider` results are cached per
    document version; only that file's change recomputes that file's lenses.
  - Large repos: with many class definitions, throttle lenses (e.g. a 100ms
    debounce) + emit lenses only for "classes with mixin bases" (classes
    single-inheriting `KBEngine.Entity` emit none, skipping the vast
    majority).

---

## 5. Acceptance standard
- **Judge by real jump success rate**: requires a **real asset repo
  containing mixins** (this engine repo has none; see §3). Sample on that
  repo: the ratio of `self.<mixin method>()` call sites whose jump hits the
  MRO-correct implementation.
- Layered acceptance:
  1. Single-inheritance entities (existing capability) do not regress — the
     `.def` path unchanged.
  2. Mixin methods (A/B/D) jump to the MRO-correct implementation; with
     multiple candidates the list is selectable and every item clickable.
  3. CodeLens lists all sources at mixin classes/methods, each clickable.
  4. No typing jank on large repos (lens incremental + caching effective).
- **Test coverage is not the metric**; C (runtime injection) is marked
  "statically unsolvable", excluded from the success-rate denominator, with
  only optional heuristic hints.
