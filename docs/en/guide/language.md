# Language Features


This page covers Kode's language features on `.def` files: highlighting, completion, hover, navigation, and diagnostics.

## Supported Scope

The current focus:

- `.def` files
- `entities.xml`
- `types.xml`
- Bidirectional association between generated Python entity files and `.def`

## Syntax Highlighting

`.def` is itself an XML dialect: the whole file is colored by the built-in XML grammar (tags blue, attribute names light blue, punctuation gray, strings orange — the same look as regular XML editing), with a layer of KBEngine semantic colors on top.

### Semantic Coloring (layered over the XML base colors)

- Section tags:
  - `Properties` — player properties
  - `BaseMethods` — methods on the BaseApp, remotely callable
  - `CellMethods` — methods on the CellApp, remotely callable
  - `ClientMethods` — client callback methods
- `Exposed` and its `true` value — the method can be requested directly by the client
- `Persistent` and its `true` value — the property is persisted automatically
- Flag values: engine constants such as `BASE_AND_CLIENT`, `ALL_CLIENTS`

These colors come from the extension's bundled theme (Properties amber, BaseMethods green, CellMethods cyan, ClientMethods purple — the four sections bold, Exposed red, Persistent orange, flag values blue; all at ≥4.5:1 contrast on dark backgrounds); with other themes the semantic scopes remain, and colors follow that theme.

### Everything Else

Type values (like `UINT32`), `DetailLevel` values, and custom property/method names are ordinary XML tokens with no dedicated coloring — type/value alignment is handled by diagnostics and completion. `<` and `>` participate in editor bracket-pair coloring; comment blocks are `<!-- -->`.

### types.xml Semantic Coloring (injection grammar)

`types.xml` does not register its own language; the VS Code XML extension owns the base coloring by default. Kode uses an injection grammar to layer engine semantic scopes on top without stealing the host tokenization:

- KBEngine built-in types (`UINT32`, the `ARRAY` element type position, etc.) → `support.type.kbengine.builtin`
- User-defined type references (e.g. `<Type>SKILL_SLOT</Type>`) → `entity.name.type.kbengine.custom`
- The `ARRAY` directive → `keyword.other.kbengine.array`
- The `FIXED_DICT` directive → `keyword.other.kbengine.fixed-dict`
- `<implementedBy>` value segment coloring (batch 131): each dot-separated segment before the last (the module path) → `entity.name.namespace.kbengine.implmodule`, and the final segment right before the closing tag (the implementation object) → `variable.other.kbengine.implementedby`; a bare value (no dot) is scoped whole as the symbol segment. The segmentation aligns with the engine's loading semantics (`loadImplModule` in `datatype.cpp` treats the value as "module path.implementation object")

The injection selector carries a `- (comment, string)` exclusion: semantic colors do not enter comments or attribute values; the type definition tag (`<SKILL_SLOT>` itself) keeps the XML tag color — only `<Type>` reference sites get semantic colors. Colors are decided by the theme per scope, never hard-coded — under the bundled "KBEngine Dark" theme: built-in green `#98C379` / custom amber `#E5C07B` / ARRAY purple `#C678DD` bold / FIXED_DICT orange `#D19A66` bold / implementedBy module segments purple `#C678DD` (same color as ARRAY but a different scene; ARRAY is bold and never appears in the same value) + symbol segment blue `#61AFEF`, all ≥4.5:1 on `#272822`; built-in VS Code themes such as Dark+/Light+ fold built-in and custom into that theme's standard type color and the two directives into the standard keyword color (the scope semantics remain; switching back to KBEngine Dark restores full differentiation).

### Design Goals

- Visual correspondence consistent with regular XML editing; structure readable at a glance
- The engine elements the user named (four sections, Exposed, Persistent, flag constants) recognizable at a glance
- The semantic layer covers only the listed elements; no invented syntax

## Completion

### Type Completion

Inside the value context of `<Type>` or `<Arg>`, common types are offered.

### Flags Completion

Inside `<Flags>`, flag suggestions are offered.

### DetailLevel Completion

Inside `<DetailLevel>`, offered:

- `NEAR`
- `MEDIUM`
- `FAR`

### Tag Completion

Typing `<` suggests common structural tags.

## Hover

Hover currently falls into three classes, each individually switchable.

### Tag Documentation

For example, hovering:

- `Type`
- `Flags`
- `Properties`
- `FIXED_DICT`

shows what the tag is for.

Setting:

- `kbengine.hover.showTagDocs`

### Value Documentation

For example, hovering:

- `UINT32`
- `BASE_AND_CLIENT`
- `FAR`

shows the value's meaning, usage, and notes.

Setting:

- `kbengine.hover.showValueDocs`

### Custom Symbol Summary

For example, hovering a custom property or method:

```xml
<HP>
  <Type> UINT32 </Type>
  <Flags> BASE_AND_CLIENT </Flags>
</HP>
```

shows a summary of the current definition, for example:

- `Type`
- `Flags`
- `Default`
- `DetailLevel`
- `Arg`

Setting:

- `kbengine.hover.showSymbolDocs`

### Database Storage (Persistent Properties)

Hovering a property with `<Persistent>true</Persistent>` appends a database landing line:

- The full `` `db`.`table`.`column` `` name (database name read from the engine config; when unreadable, only the table-level full name, nothing invented)
- The engine DDL fragment (column type, `not null`, `DEFAULT`) and concrete value constraints: integers per MySQL ranges, varchar per the parsed length (default 255 when `<DatabaseLength>` is not declared)
- Same-DDL columns merge into one line (e.g. VECTOR3's three columns); ARRAY / component properties explain the destination child table and its `parentID` relation

The full capability description: "Property → database hints and the schema view" in [Feature Overview](./features.md).

### types.xml Type Forms (Database Form)

Hovering a `types.xml` type declaration name appends a "database form" section after the custom type summary:

- Alias to a built-in type: one main-table column (with the parsed column type, e.g. `smallint unsigned`)
- FIXED_DICT: flattened into columns, no table; top-level keys one column each
- ARRAY: becomes the child table `tbl_<Entity>_<Property>`, elements one row each; element columns recurse one level by element type (built-in gives `sm_value` + column type, FIXED_DICT flattens its keys, nested arrays nest a deeper child table, a missing `<of>` states plainly that the element type is unknown)
- Unresolved types (broken chain or alias cycle): plainly "unknown type; engine loading of types.xml will fail"

Form determination and the schema view share one set of engine semantics (alias resolution, column expansion from the same source); hover on an `implementedBy` value talks about references only, without the form section.

## Go to Definition

### Currently Supported

- From `entities.xml` to the corresponding `.def`
- From entity references in `Type` / `Arg` inside `.def` to the corresponding entity definition (entity references resolve to the flattened definition-root position; component references resolve into the `components/` subdirectory)
- From a `.def`'s `Parent` to the parent def; interface names inside an `<Interfaces>` wrapper to the interface def under `interfaces/`
- From a `Properties` field's `DetailLevel` value to the level declaration line under the same file's `<DetailLevels>`
- From generated Python files back to the properties and methods in `.def`
- `types.xml`'s `<implementedBy>` value (shaped like `MODULE.symbol`; the engine splits on `.` into two: `ImportModule` takes the front + `GetAttrString` takes the back) bidirectional navigation: forward from the implementedBy value to the symbol's definition line in the implementation file (three forms: `class`/`def`/assignment; falls back to the file's first line only when the symbol cannot be resolved); backward from a Python symbol (definition name or any reference site) to the `types.xml` implementedBy line, with hover showing the referencing type and the landing line — clicking uses the same resolution as the hint
- RPC method markers: in Python implementation scripts, functions whose method name hits an entity def method declaration (`BaseMethods`/`CellMethods`/`ClientMethods`) get a CodeLens above the declaration line (`RPC · <section> · [Exposed ·] <source def filename>`); clicking jumps back to the def declaration line; ordinary functions not declared in a def get no lens
- types.xml type declaration reference back-scan CodeLens (batch 134): above the declaration name, one lens per real reference (in the `Hero.itemId → tbl_Hero.sm_itemId` form, one lens per use); clicking runs `kbengine.database.open` to open that entity's schema view at the matching column; a type used at more than 10 sites folds into one `+N 处落库未列出` count lens (no command, hint only); a type with no references gets no lens; any add/remove/edit of `.def` / `types.xml` / `entities.xml` invalidates and rescans
- From a `Properties` field name to the implementation script, landing in four tiers: the `class` definition line named like the def → the `__init__` line → the first `class` line (when the class name differs from the def) → the script's first line (base→cell→client takes the first script on disk; the engine loads properties before `__init__`, so the property name may not appear in the script — the class/`__init__` lines remain reliable anchors)
- The script directory is inferred from the `.def` file's own location: from the `.def`, walk up to the nearest `entity_defs` directory (matched by name, or whose sibling holds `entities.xml`/`types.xml`); its parent is the script root, and the script = `<parent>/{base,cell,client}/<EntityName>.py`; if not found, fall back to the workspace candidate chain (`entity_defs`, `scripts/entity_defs`, `assets/scripts/entity_defs`, `server_assets/scripts/entity_defs`); when all conventions miss, a bounded deep scan runs (depth 7 / 20k entries, pruning `node_modules`/`.git`/`out`/`dist`), synchronous reads accept only a unique hit — multiple candidates mean nothing rather than a guess. File-relative resolution takes priority over workspace-relative resolution, so non-standard layouts (like `server/scripts/entity_defs`) navigate too
- Property implementation scripts resolve by reference closure: a component def lands in role scripts like `scripts/cell/<Component>.py`; an interface def lands in `scripts/interfaces/<InterfaceName>.py` (does not follow `Parent`); an entity def walks its own role scripts → `<Interfaces>` mixin scripts → up the `Parent` chain level by level; when the whole chain misses and the database schema also misses, there is always a landing: if the script truly does not exist → the entity's declaration line in `entities.xml` (falling back to the def's first line without a registry), plus an assist notice listing every candidate path checked — never again a notice without a jump
- Clicking a property's `<Type>` value: built-in types (`UINT32` etc.) get an "engine built-in, no declaration file" notice; custom types not declared in types.xml get a "declaration not found" notice — neither is silent
- From a `BaseMethods` / `CellMethods` / `ClientMethods` method name to the `def` line in the matching role script; when the project index does not cover the symbol or script, fall back per file conventions (the def-relative candidate chain); if the implementation is still not found → land on the `entities.xml` declaration line or the def's first line (same rule as properties — always a landing), with the notice as assistance only
- Method implementation scripts resolve by reference closure: own role scripts → the `<Interfaces>`-mixed `scripts/interfaces/<Interface>.py` → up the `Parent` chain level by level (an interface def's own implementation lives in `scripts/interfaces/<InterfaceName>.py`; interfaces do not follow `Parent`)
- Script paths in hovers and completion hints are always really resolved paths (workspace-relative inside the workspace, absolute outside); when resolution fails, it says plainly "未找到实体脚本，期望位置：" (entity script not found, expected locations:) and lists all candidates — no more `scripts/{base,cell,client}/xxx.py` brace templates

### Typical Example

```xml
<Target>
  <Type> Avatar </Type>
  <Flags> BASE_AND_CLIENT </Flags>
</Target>
```

Put the cursor on `Avatar` to jump to `Avatar.def`.

## Rename

In a `.def` file, put the cursor on a top-level property or method name (opening or closing tag both work) and press `F2`.

### Update Scope

- Same-named declarations in the same file: all Flags-scope variants of a property; same-named methods within a method's section
- Same-named restatements in descendant entity definitions: the `.def` files covered by the transitive closure of the `Parent` chain and `Interfaces` mixins (propagation edges align with the engine's loading path: `Parent`/interface names take the element's **first non-whitespace child node** — text yields text, an element yields its tag name, matching the engine's `getKey` semantics; tinyxml discards pure-whitespace text nodes between elements by default (`condenseWhiteSpace=true`, unchanged in KBEngine), so both the indented spread form and the compact form load; a `<Parent>` containing only whitespace has no child node and produces no edge; an entity's parent class resolves to the flattened definition-root position, a component def's `Parent` resolves inside `components/`, and interfaces always resolve into the `interfaces/` subdirectory; interface files do not read `Parent` when loading; `<Interfaces>` recognizes only the four wrapper spellings `interface`/`Interface`/`type`/`Type` — child elements named directly after the interface (like `<MoveIface/>`) are not loaded by the engine and produce no propagation edge)
- Names on both the opening and closing tags update together

### Boundaries

- Only the `.def` surface updates; Python-side `self.x` accesses and method calls, `entities.xml`, `types.xml`, and the database schema view do not participate
- Renaming initiated at a restatement propagates downward only (that file and its descendants); the ancestor source declaration is never rewritten back
- `BaseMethods` / `CellMethods` / `ClientMethods` are three independent namespaces; same-named methods do not affect each other
- The new name must be a legal identifier (starting with a letter or underscore); when no `entities.xml` can be located to fix the definition root, only the current file updates
- A new name equal to an existing method/property/component name gets no loading check (same names are engine loading errors; the "performance analysis" command's same-name check can flag them)
- File enumeration covers the whole definition-root tree (including `.def` files not registered in `entities.xml`), targeting "files that may be edited" rather than "files loaded this round"

## Diagnostics

Diagnostics are split into a "master switch" and per-rule switches.

### Current Rules

- Unknown type
- Unknown Flags
- Unknown DetailLevel
- Duplicate property or method
- Property missing `Type` / `Flags`

### Recommended Usage

If they feel too frequent, do not turn off all diagnostics; prefer disabling the noisier rules:

- `kbengine.diagnostics.checkDuplicateDefinitions`
- `kbengine.diagnostics.checkMissingPropertyFields`

See the [configuration reference](./configuration.md) for the full settings.

## Current Boundaries

Not fully done yet:

- Rename covers only the `.def` declaration and reference surface; Python-side reference syncing and renaming the entity itself belong to the next stage
- RPC method markers match by method name, regardless of implementation ownership: a helper function in a closure script (parent/interface implementation) that happens to share a name with an entity def declaration also gets a lens; the parser answers only "is this name a def-declared RPC method", not "is this line its implementation"
- Strict matching checks of default values against types
- Deep static analysis across all project entity references

These belong to next-stage enhancements.
