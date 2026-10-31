# KBEngine entitydef Source Analysis (Design Draft for the kode Entity Index)


> A product of the source-first order. Every conclusion is based on the local KBEngine
> source checkout (`~/workspaces/kbengine`; all paths below are relative to that root). The
> repository's existing analysis documents were read first (`docs/study/05-entitydef-and-entity-definition.md`,
> `docs/book-legacy/05-entitydef-and-runtime.md`,
> `docs/study/06-python-runtime-and-script-bridge.md`), then each point was checked back
> against the source. Every item carries `file:line`; where nothing could be found it explicitly
> says "not found in source". When documentation and source conflict, the source wins; the
> differences are summarised in section 4. In this engine version the loading of
> interface/parent/components is entirely inlined in `entitydef.cpp` (there is no separate
> interface.cpp); it was verified paragraph by paragraph.

## 1. The Real Resolution Chain

The entry point for entity definitions on the engine side is `EntityDef::initialize`
(`kbe/src/lib/entitydef/entitydef.cpp:153-250`), split into three phases.

### Phase 0: Path Resolution

1. `getPyUserResPath`: takes the resource root that contains `matchRes("server/kbengine.xml")`;
   if the match fails it falls back to `respaths_[1]`, then `respaths_[0]`
   (`kbe/src/lib/resmgr/resmgr.cpp:462-486`).
2. `getPyUserScriptsPath`: within the resource root it strips the last `res` segment and
   everything after it, then appends `scripts/` (`resmgr.cpp:489-503`). That is
   `<resource root>/../scripts/`.
3. The per-side component directories are appended by `getPyUserComponentScriptsPath`:
   `cell/`, `base/`, `bots/`, `client/` (`resmgr.cpp:506-540`). Note that inside
   `autoMatchCompOwn` what is actually used are hardcoded resource paths such as
   `scripts/client/<name>.py` rather than that function (`scriptdef_module.cpp:416、459、495`).

That root is called `<userScripts>` below.

### Phase 1: Registration on the def Side (`entitydef.cpp:153-250`)

1. `__entitiesPath = getPyUserScriptsPath()` (`entitydef.cpp:159`);
   `entitiesFile = <userScripts>/entities.xml`,
   `defFilePath = <userScripts>/entity_defs/` (`entitydef.cpp:176-177`).
2. **types.xml loads before any entity**: `DataTypes::initialize(defFilePath +
   "types.xml")` (`entitydef.cpp:181`); types.xml lives inside `entity_defs/`.
3. Initialisation of the flag-name mapping table: `CELL`/`BASE`/`CELL_AND_CLIENT` etc. → ED_FLAG
   bits (`entitydef.cpp:161-174`).
4. **entities.xml may be absent**: parsing is only entered when `access(entitiesFile, 0) == 0`,
   with the comment "a purely script-defined setup may have no such file"
   (`entitydef.cpp:184-186`).
5. Per entity node (`entitydef.cpp:198-237`):
   - `moduleName = getKey(node)` — **the entity name is the XML element name, not an attribute**
     (`entitydef.cpp:200`);
   - `registerNewScriptDefModule(moduleName)` (`entitydef.cpp:202`) —
     **the type number is assigned here**: `__scriptTypeMappingUType[moduleName] =
     g_scriptUtype`, and the module takes `g_scriptUtype++`
     (`entitydef.cpp:253-265`); that is, utype = the **order of appearance** in entities.xml
     (starting at 1; read back via `findScriptModule(utype)`, `entitydef.cpp:2382-2396`);
   - def file = `defFilePath + moduleName + ".def"` (`entitydef.cpp:204`), parsed and handed to
     `loadDefInfo` (`entitydef.cpp:218`);
   - the detailLevel inside the def is then loaded a second time independently (`entitydef.cpp:227`).
6. Load order inside `loadDefInfo` (`entitydef.cpp:339-400`):
   `loadAllDefDescriptions` (:345, the Properties/Methods blocks) →
   `loadInterfaces` (:354) → `loadComponents` (:363) →
   `loadParentClass` (:372) → `loadDetailLevelInfo` (:381) →
   `loadVolatileInfo` (:390) → `autoMatchCompOwn()` (:398, see phase 2.5).
7. After the def side wraps up, before entering the script phase: `script::entitydef::initialize()`
   (`entitydef.cpp:240`) and `EntityDef::md5().final()` (:243); the DBMGR process returns here
   and does not load entity scripts (`entitydef.cpp:245-246`).

#### Interfaces

`<Interfaces>` iterates the interfaces, taking the wrapper element (four spellings:
`interface`/`Interface`/`type`/`Type`, cascaded at the `enterNode` level), then takes the
**element name of its first child** as the interface name — a child element named directly
after an interface (such as `<MoveIface/>`) is skipped by the `getKey` check and not loaded;
when `enterNode` returns the first child, tinyxml has already discarded pure-whitespace text
nodes during parsing (`condenseWhiteSpace=true` by default), so line breaks and indentation
do not affect the name lookup. The def file is
`defFilePath + "interfaces/" + name + ".def"`, and methods and properties are **flattened into
the same module**; the interface def can itself carry further `Components`/`Interfaces`,
handled recursively (`entitydef.cpp:551-639`, call site `entitydef.cpp:354`).

#### Components

`<Components>` iterates the components: the component name is the element name, and the `<Type>`
child gives the component type name (`entitydef.cpp:654、669-671`); the component def is
`defFilePath + "components/" + typeName + ".def"` (`entitydef.cpp:681`); the component is
registered with `registerNewScriptDefModule(typeName)` and marked `isComponentModule(true)`
(`entitydef.cpp:716-722`); it is then attached as one property of the host entity via
`addComponentProperty` (default flags = `ED_FLAG_BASE | ED_FLAG_CELL_PUBLIC |
ENTITY_CLIENT_DATA_FLAGS`, `entitydef.cpp:686-743`), and `addComponentDescription` records the
ownership (`entitydef.cpp:745`).

#### Inheritance (Parent)

The element name of the `<Parent>` child = the parent entity name, the parent def is
`defFilePath + parentName + ".def"`, and it **recursively `loadDefInfo`s and merges the content
into the same ScriptDefModule** — inheritance at the def layer is a merge, not the registration
of a separate parent module (`entitydef.cpp:890-924`, call site `entitydef.cpp:372`). Cycle
protection: **not found in source** — `loadParentClass` has no visited/already-registered
check, and relies on the caller guaranteeing acyclicity; the kode implementation must carry
its own visited set.

### Phase 2: Loading on the Script Side (`loadAllEntityScriptModules`, `entitydef.cpp:2255-2379`)

1. entities.xml may be absent: returns `true` immediately if it does not exist
   (`entitydef.cpp:2260-2262`).
2. **Component scripts load before entity scripts**: `loadAllComponentScriptModules`
   (`entitydef.cpp:2264-2265`; function body `entitydef.cpp:1984-2110`): component names are
   collected from each entity's componentDescrs (`:2006-2018`), then `loadScriptModule` is
   called one by one (`:2026`); when one is missing and the current process needs it,
   `Could not load EntityComponentModule` is reported (`:2045-2052`), and TOOL_TYPE(kbcmd) has
   a dedicated bypass (`:2031-2042`).
3. Per entity (`entitydef.cpp:2278-2375`):
   - `loadScriptModule(moduleName)` = `PyImport_ImportModule(moduleName)`
     (`entitydef.cpp:1944-1947`), with a **path guard**: the module file must live under
     `<userScripts>` (compared after stripping the separator), otherwise it is set to NULL under
     "module name collides with a system module" (`entitydef.cpp:1952-1977`) — preventing
     accidental import of a same-named module;
   - when the module is missing, `isLoadScriptModule` decides whether to error: that function
     queries `hasBase/hasCell/hasClient` by process type (BASEAPP queries base, CELLAPP queries
     cell, CLIENT/BOTS query client, TOOL is always false, `entitydef.cpp:1741-1782`);
     needed → report `Could not load EntityModule` and return (`:2287-2294`); not needed →
     skip silently (`:2296-2300`);
   - **same-named class**: `PyObject_GetAttrString(pyModule, moduleName)` — the class name must
     equal the entity name; if missing, report `Could not find EntityClass` (`:2305-2314`);
   - **base class check**: `isSubClass(pyClass)`; if it is not a descendant of a KBEngine base
     class, report `not derived from KBEngine.[X]` (`:2317-2325`); a non-type is an error
     (`:2328-2334`);
   - **def method reconciliation**: `checkDefMethod` verifies that the methods declared in the
     def exist on the class (`:2336-2342`; implementation at `entitydef.cpp:1785+`, borrowing
     `inspect.getfullargspec`);
   - only after everything passes does `setScriptType` run (`:2347`);
   - component module fallback check: if a component referenced by the entity is not loaded and
     is needed, report `Could not load ComponentModule` (`:2350-2374`).

### Phase 2.5: Three-Side Existence Determination (`autoMatchCompOwn`, `scriptdef_module.cpp:302-530`)

The single source of truth for `hasCell / hasBase / hasClient`, triggered at the tail of
`loadDefInfo` (`entitydef.cpp:398`).

- Component module branch (`scriptdef_module.cpp:304-331`): if
  `scripts/base/components/<name>.py` exists → `setBase(true)` (:306-312), if
  `scripts/cell/components/<name>.py` exists → `setCell(true)` (:314-320); if base/cell has
  exposed methods → additionally `setClient(true)` (:322-328).
- Entity branch: reads the assertion attributes `hasClient` (:366), `hasCell`
  (:377), `hasBase` (:388) from entities.xml — a case-insensitive `true` counts as 1,
  anything else as 0 (:369-372), and an absent attribute stays at -1 (:341-343); the assertion
  values feed the def md5 (:375、386、397). A purely script def (no .def file) can also
  contribute a hasClient assertion via `DefContext::findDefContext(name)`
  (:405-414).
- Per-side determination (taking client as the example, `:416-450`; base `:459-493`; cell
  `:495-529`), where `matchRes(f) != f` means a resource hit:
  - script present + no assertion → `set(true)` (:421-428);
  - script present + assertion → **the assertion wins** `set(assertion==1)` (:429-434);
  - script missing + no assertion → `set(false)` (:435-444);
  - script missing + assertion → the assertion wins (:445-450).
- Client processes (CLIENT_TYPE) set `setBase(true)+setCell(true)` up front and return
  (:452-457).

### The Registration Chain's Error Messages (Checked Against the User's Anchors)

The exact text of the error emitted by `EntityApp::createEntity` when the entity type is not
found is the registration triad: "Please register in entities.xml and implement a %s.def and
%s.py" (`kbe/src/lib/server/entity_app.h:567`); at creation time `hasCell`
(cellapp) / `hasBase` (everything else) is checked by process (`entity_app.h:573-582`).

## 2. The Fields of entities.xml and the Boundary of Its Responsibilities

Only two things are consumed from entities.xml in the source:

| Content | Role | Evidence |
| --- | --- | --- |
| **Element name** (one per node) | The entity module name; determines the def file name, the py module/class name, and **the order of type-number assignment** | `entitydef.cpp:200、204、253-265` |
| **Attributes `hasClient` / `hasCell` / `hasBase`** (optional) | Three-side existence assertions, able to override the derivation from script presence | `scriptdef_module.cpp:366、377、388、416-529` |

Responsibility boundaries:

- entities.xml is the **entity manifest** — it declares "which entities exist" and their
  per-side existence, and it fixes the type numbers by the order of its child nodes.
- **extends is not in entities.xml: not found in source**. Inheritance is written only as
  `<Parent>` in the .def (`entitydef.cpp:896-915`); the requirement description and some
  materials put extends / the type-number field into entities.xml, which contradicts the source
  (the type number is derived from order, it is not a field).
- Apart from those three attributes, the `Attribute(...)` reads of entities.xml from the entity
  def directory occur in only three places in the source: `scriptdef_module.cpp:366、377、388`;
  no other field consumption is found in source.
- An absent entities.xml is legal (purely script-defined): `entitydef.cpp:184-186`,
  `scriptdef_module.cpp:347-349`, `entitydef.cpp:2260-2262`.

## 3. The kode Entity Index Design (each item cites source evidence, to be reviewed before implementation)

Goal: for navigation/completion over things like `class GameObject(kbe.KBEntity)`, stop guessing
symbols in isolation and instead follow the same chain as the engine: entities.xml manifest →
`entity_defs/<Name>.def` → merging of `interfaces/`, `components/`, `<Parent>` →
same-named classes in `scripts/{base,cell, client}/<Name>.py`.

- **D1 Index entry point and path discovery**: the entry file = the entities.xml inside the
  workspace. Discovery order: the existing `getDefinitionWorkspaceLayout` entitiesXmlPath
  candidates (src/definitionWorkspace.ts, the logic currently in force) →
  `findFiles('**/entities.xml')` as a fallback. Source evidence: entities.xml always sits at the
  `<userScripts>` root (`resmgr.cpp:489-503`; `entitydef.cpp:176`;
  `scriptdef_module.cpp:345`); kode cannot obtain the engine's resource root, so it can only
  enumerate candidates by the workspace's shape.
- **D2 Parse timing and cache**: built lazily on first use (triggered by the first
  navigation/completion/explorer request), invalidated and rebuilt when entities.xml or an
  indexed def file is saved. Source evidence: the engine builds it once inside
  `EntityDef::initialize` (`entitydef.cpp:153-250`); kode's "process start" corresponds to the
  host's first request, which does not consume activate start-up cost.
- **D3 The module table keeps manifest order**: the index stores entries in the order of
  entities.xml's child nodes, unsorted; that order is the engine's utype order (source evidence:
  `entitydef.cpp:253-265、2382-2396`). Duplicate same-named entries: the engine silently merges
  by reusing the existing module (`registerNewScriptDefModule`
  `entitydef.cpp:255-262`), while kode should surface a diagnostic instead of staying silent.
- **D4 Def location and pure script modules**: module → `<scripts root>/entity_defs/<Name>.def`
  (source evidence: `entitydef.cpp:204、177`); a missing def = a pure script module, which is
  legal and can still be indexed from the py side (source evidence: `entitydef.cpp:184-186`;
  the DefContext channel in `scriptdef_module.cpp:405-414`).
- **D5 Building the inheritance chains**: navigation presents two chains. The def chain:
  `<Parent>` recursion + `interfaces/` flattening + `components/` attachment, matching the
  engine's merge semantics (source evidence:
  `entitydef.cpp:890-924、551-639、642-771`); the py chain: the entity py =
  `scripts/{base,cell,client}/<Name>.py` (`scriptdef_module.cpp:416、459、
  495`), the class name must equal the entity name (`entitydef.cpp:2305-2314`), and the base
  class must be a descendant of a KBEngine base class (`entitydef.cpp:2317-2325`) — the
  `kbe.KBEntity` segment goes through the kbe stub index, while the project parent-class segment
  follows Python inheritance through this index. kode must carry visited-set cycle protection:
  the engine's `loadParentClass` has **no cycle protection found in source**, so it cannot be
  copied verbatim.
- **D6 Recomputing three-side existence**: kode computes hasCell/hasBase/hasClient by the same
  rules as autoMatchCompOwn, for the explorer's type display and to disambiguate jump targets
  (which of base/cell/client py to open). Rules: per side, "script present || entities.xml
  assertion, the assertion wins" (source evidence: `scriptdef_module.cpp:416-450、459-493、495-529`;
  attribute reads `:366、377、388`; the CLIENT_TYPE bypass `:452-457`).
- **D7 Division of labour with the kbe stub index**: the `kbe.*` module surface (engine API)
  goes through the built-in stub index (to be submitted separately); the entity manifest surface
  (the entities.xml chain) goes through this design. The engine natively has no KBEntity symbol
  (not found in source; there is no such registration under `kbe/src/lib`) — it is a project-side
  base class convention, which the stub index honestly carries as an alias entry.
- **D8 Degradation when there is no entities.xml**: when entities.xml cannot be found, report
  "未找到 entities.xml" once (via the output channel / status bar, not per keystroke), and
  navigation/completion falls back to the per-file logic currently in force. Source evidence:
  the engine explicitly allows it to be absent (`entitydef.cpp:184-186、2260-2262`;
  `scriptdef_module.cpp:347-349`) — degradation is a legal form supported by the source, not a
  patch.
- **D9 Explicitly out of scope**: types.xml alias expansion (`DataTypes::initialize`,
  `entitydef.cpp:181`), def md5 (`scriptdef_module.cpp:375、386、397`), exposed method code
  generation, detailLevel/volatile semantics — all of these belong to the engine's
  serialisation/sync domain; the kode index does not model them and keeps only a diagnostic
  surface.
- **D10 Test approach**: the fixture workspace replicates the engine layout (scripts/entities.xml +
  entity_defs/{*.def,interfaces/,components/} + base/cell/client same-named classes), covering:
  order fidelity, the Parent chain (including cycles), interface flattening, the four quadrants
  of three-side determination, pure script modules, and degradation without entities.xml; the
  `kbe.KBEntity` navigation regression reuses the batch-108 stub index cases.

## 4. Differences Between Documentation and Source (the Source Wins)

1. `docs/study/05` cites the setting point of the three-side flags as
   `scriptdef_module.cpp:846-861`; that range is actually `findAliasMethodDescription` /
   `addCellMethodDescription` (only the `setCell(true)` at `:883` in between belongs to the
   component-method registration side effect). The real flag-driven setting points are:
   `entitydef.cpp:847-861` (addComponentProperty taking the union of flags),
   `scriptdef_module.cpp:302-530` (the whole autoMatchCompOwn family),
   `entitydef.cpp:1922-1941` (setScriptModuleHasComponentEntity setting per process).
2. The requirement description / some materials list extends and the type number as entities.xml
   fields; in the source extends = `.def <Parent>` (`entitydef.cpp:896-915`) and the type number
   = manifest order (`entitydef.cpp:253-265`); entities.xml itself has neither field (not found
   in source, see section 2).
3. `docs/book-legacy/05` is a narrative survey without line-number citations; wherever its details
   diverge from the source, this document's source citation rules apply.

## 5. Implementation Boundary

- The design was approved by the user, with one hard requirement attached: the interface names
  inside `<Interfaces>` in a def must cross-file jump to `entity_defs/interfaces/<name>.def`.
  Batches 108/109 landed this: the kbe stub index (src/kbeModuleIndex.ts) corresponds to the D7
  division of labour; chain navigation (src/languageProviders.ts, src/definitionWorkspace.ts)
  covers D1/D4, the py chain and the cross-file Interfaces segment of D5, D6, and D8;
- D3 has landed (batch 147): the manifest-ordered index is carried by the existing
  getRegisteredEntities, which preserves child-node order, and the hover presents the
  manifest ordinal; same-name duplicate entry diagnostics (src/entitiesXmlAnalysis.ts)
  land in the kbengine collection through the same document-event lifecycle as .def
  files, sharing the kbengine.enableDiagnostics master switch;
- The def-chain merged presentation of D5 has landed (batch 148): src/defChain.ts
  organizes the inheritance closure into three facets — `<Parent>` recursion, the
  flattened `interfaces/` list, and the `components/` hookup (engine merge semantics;
  edge resolution reuses the established defRenamer semantics), presented when hovering
  the root-level `<Parent>` element; a visited set truncates cycles and says so (the
  engine's loadParentClass has no cycle guard; kode does not copy that); still follow-up
  increments: D2 (an independent lazy index with rebuild-on-save invalidation) and the
  D9 diagnostic surface; navigation currently uses the layout/manifest reading in force
  plus per-file parsing, with the reconciliation rules recorded in the TESTING.md
  batch-108/109 sections;
- Acceptance walkthrough record: tests/batch109NavigationWalkthrough.test.ts (11 steps, each
  asserting that the jump target really exists on disk), with the outcome recorded in the same
  TESTING.md section.

## 6. Interfaces vs Components (is-a vs has-a Semantics)

The `#### Interfaces` / `#### Components` subsections of section 1 give the loading-chain view of
the two blocks; this section contrasts them at the semantic level. Everything below is
source-verified against `kbe/src/lib/entitydef/entitydef.cpp`.

**The distinction in one sentence**: `<Interfaces>` is *is-a* reuse — the interface's
Properties/Methods are **flattened into the host entity's own module**, so once loaded an
interface leaves no trace on the entity; `<Components>` is *has-a* reuse — each component slot
becomes **one property of the entity**, typed `EntityComponent`, whose members live in the
component's own module.

### Interfaces (is-a / mixin)

- Entry point: `loadInterfaces` (`entitydef.cpp:551-639`, call site `entitydef.cpp:354`).
- The interface def file sits in the **global shared directory**
  `defFilePath + "interfaces/" + <name> + ".def"` (`entitydef.cpp:586`) — one `interfaces/`
  directory under `entity_defs/`, shared by every entity, not per-entity.
- The interface's Properties/Methods (and DetailLevel) are loaded **into the entity's own
  ScriptDefModule**: `loadAllDefDescriptions(moduleName, ..., pScriptModule)` is called with
  `pScriptModule` = the entity (`entitydef.cpp:598`; `loadAllDefDescriptions` at
  `entitydef.cpp:927-964` routes to loadDefPropertys / loadDefCellMethods / loadDefBaseMethods /
  loadDefClientMethods), so the members are absorbed directly into the entity's def surface.
- Recursive nesting: an interface def may itself carry `<Components>`
  (`entitydef.cpp:616-625`) and further `<Interfaces>` (`entitydef.cpp:628-634`, unbounded
  self-recursion); `ignoreComponents` defaults to `false` at the entity level
  (`entitydef.h:103`), so nested components are honoured.
- **No trace left on the entity**: `loadInterfaces` contains no `registerNewScriptDefModule`, no
  `addComponentProperty` and no utype allocation — the interface is never registered as a module
  or as a property slot; only its merged members remain, indistinguishable from the entity's own.

### Components (has-a / composition)

- Entry point: `loadComponents` (`entitydef.cpp:642-818`, call site `entitydef.cpp:363`).
- Each child of `<Components>` is one **slot**: the slot name = the child element name
  (`entitydef.cpp:654`), validated by `validDefPropertyName` (`entitydef.cpp:660`; the check at
  `entitydef.cpp:967-1012` rejects the reserved `ENTITY_LIMITED_PROPERTYS` names — id, position,
  direction, spaceID, cell, base, component, ... (`entitydef/common.h:125`) — and any
  `KBEngine.Entity` attribute).
- The `<Type>` child names the component type (`entitydef.cpp:669-671`); the component def =
  `defFilePath + "components/" + <Type> + ".def"` (`entitydef.cpp:681`) — the `components/`
  directory is keyed by **type**, not by slot.
- `addComponentProperty` (`entitydef.cpp:821-887`) builds one `PropertyDescription` named after
  the slot, whose DataType is an `EntityComponentType` wrapping the component module
  (`entitydef.cpp:834-843`); the property's `DATATYPE` is `DATA_TYPE_ENTITY_COMPONENT = 15`
  (`entitydef/common.h:104`, `entitydef/datatype.h:801`). The slot therefore occupies the
  entity's property/utype namespace: `<Utype>` (`entitydef.cpp:698-701`) and `<Persistent>`
  (default `true`, `false` disables, `entitydef.cpp:703-713`) are honoured; the property is
  registered per-side by `addPropertyDescription` (`entitydef.cpp:864-874`) and
  `addComponentDescription` records the ownership (`entitydef.cpp:745、813`).
- The component def loads into **its own independent module**:
  `registerNewScriptDefModule(<Type>)` + `isPersistent(false)` + `isComponentModule(true)`
  (`entitydef.cpp:716-723`). If the type's module already exists it is reused and the def is not
  re-parsed (`entitydef.cpp:715-747`), so several slots (within one entity or across entities)
  may share one component type.
- The component def is a **full mini-entity**: `loadAllDefDescriptions` into its own module
  (`entitydef.cpp:756`), `loadInterfaces` (`entitydef.cpp:765`, called with `ignoreComponents=true`
  so an interface reached from a component does **not** pull in further components),
  `loadParentClass` with `components/` as the base path (`entitydef.cpp:774` — a component's
  `<Parent>` resolves inside `entity_defs/components/`), `loadDetailLevelInfo`
  (`entitydef.cpp:783`), then `autoMatchCompOwn()` (`entitydef.cpp:791`).
- Slot domain flags are derived from what the component module exposes after `autoMatchCompOwn`
  (`entitydef.cpp:793-811`): `hasBase → ED_FLAG_BASE` (`:795-796`); `hasCell →
  ED_FLAG_CELL_PUBLIC` (`:798-799`); `hasClient → ED_FLAG_BASE_AND_CLIENT` if the component also
  has base, plus the client union `ED_FLAG_ALL_CLIENTS | ED_FLAG_CELL_PUBLIC_AND_OWN |
  ED_FLAG_OTHER_CLIENTS | ED_FLAG_OWN_CLIENT` if it also has cell (`:801-808`). These bits feed
  back into the host entity's own hasBase/hasCell/hasClient inside `addComponentProperty`
  (`entitydef.cpp:847-861`). (On the pre-registered reuse path a fresh slot instead takes the
  default `ED_FLAG_BASE | ED_FLAG_CELL_PUBLIC | ENTITY_CLIENT_DATA_FLAGS`,
  `entitydef.cpp:686-688`.)

### is-a vs has-a at a glance

| Aspect | `<Interfaces>` (is-a) | `<Components>` (has-a) |
| --- | --- | --- |
| Reuse style | mixin: members merged into the entity | composition: a slot property of type EntityComponent on the entity |
| Script surface | the interface's members are the entity's own members after loading (no indirection) | the entity exposes one property named after the slot; the component's members stay in the component module |
| Def directory | one global `entity_defs/interfaces/<Name>.def` shared by all entities | `entity_defs/components/<Type>.def` keyed by the `<Type>` child |
| Trace left on the entity | none (no module, no property slot, no utype) | one PropertyDescription named after the slot (EntityComponent, with utype/persistent) |
| Load target module | the entity's own ScriptDefModule | a separate ScriptDefModule (isComponentModule(true), isPersistent(false)) |
| Own structure | may nest `<Components>` and `<Interfaces>` recursively | a full mini-def: Properties/Methods, Interfaces, `<Parent>` (resolved in components/), DetailLevel |
| Multiplicity | any number of `<Interfaces>` children, unbounded recursion | any number of slots; several slots may share one `<Type>` (module reused) |

### XML example (two blocks in one entity def)

```xml
<!-- entity_defs/Avatar.def -->
<root>
    <Interfaces>
        <Interface>
            <Combat/>   <!-- element name = interface name; loads entity_defs/interfaces/Combat.def and merges into Avatar -->
        </Interface>
    </Interfaces>

    <Components>
        <HP>            <!-- slot name: a property named HP appears on Avatar -->
            <Type>HPComponent</Type>   <!-- -> entity_defs/components/HPComponent.def -->
            <Utype> 10 </Utype>
            <Persistent> true </Persistent>
        </HP>
    </Components>
</root>
```