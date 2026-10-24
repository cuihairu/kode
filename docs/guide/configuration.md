# Configuration Reference


Kode's configuration falls into two piles: `kbengine.*` settings (VS Code `settings.json`) and the server-side XML configuration (`kbengine_defaults.xml`, the component `kbengine.xml`). Settings are introduced **by feature area** (diagnostics, hover, CodeLens and inlay, jumps, paths, config view, server and logs, remote debugging, Python, generators, telnet, HTTP, hot reload, database) — one small table per area with type, default value, and purpose, followed by that area's impact of changes and common misconfigurations; for how the server configuration layers and merges, and where the telnet port/password come from, read "The Three Layers of Server Configuration" first.

Setting default values are all taken from this extension's package.json contributions, and engine-side values from `kbengine_defaults.xml`; entries found in neither place are marked 「来源未考」 (source unverified).

## The Three Layers of Server Configuration

The engine loads server configuration by this rule: read the engine defaults first, then the component config, same keys overriding. Kode's telnet probing and the "final config" view both take values by this rule.

| Layer | File | How it is located |
| --- | --- | --- |
| 1 Engine defaults | `kbe/res/server/kbengine_defaults.xml` | Derived upward from `kbengine.binPath` (which points at `kbe/bin/server`) |
| 2 Component override | `kbengine.xml` | The `kbengine.xml` under `kbengine.assetsRoot` and its `res/server/kbengine.xml` take priority; when unset or missed, the discovered assets root (batch 128) participates; finally the workspace root is probed along conventional paths: `kbengine.xml` → `res/server/kbengine.xml` → `assets/res/server/kbengine.xml`, taking the first that exists |
| 3 Final effective | (composed, never on disk) | Layer 1 loads first, layer 2 overrides by same key |

The locating settings in the table, `kbengine.binPath` and `kbengine.assetsRoot`, are directories that support VS Code variables: values go through variable expansion first (`${workspaceFolder}`/`${env:NAME}` and friends), and relative paths join against the workspace root. A value that expands to an empty string counts as unset and falls through to auto-discovery as usual.

Override rules:

- Same-named key present on both sides: the component config's value wins;
- Only in defaults: the default is kept;
- Only in the component config: added;
- Container sections present on both sides: recurse down, sub-keys aligned by name;
- Repeated-name lists (e.g. multiple addresses under `<addresses>`): the component config replaces the whole list, never interleaved with the default one.

Before/after comparison:

| Key | Engine default | Component kbengine.xml | Final effective |
| --- | --- | --- | --- |
| `baseapp/telnet_service/port` | 40000 | 41000 | 41000 (overridden) |
| `baseapp/telnet_service/password` | `pwd123456` | (not written) | `pwd123456` (only in defaults, kept) |
| `baseapp/archivePeriod` | 300 | 600 | 600 (overridden) |
| `baseapp/externalAddress` | (not written) | `10.0.0.9` | 10.0.0.9 (added) |

### Viewing the Final Config

Three entries, same content — the read-only virtual document `kbengine-final.xml`, never written to disk:

- The 「最终配置」 (final config) node in the sidebar KBEngine → Config view; click to open;
- Command palette `Show Final Server Config` (`kbengine.config.showFinal`);
- Auto-opens in the background when the extension activates and defaults can be located (setting `kbengine.showFinalConfigOnOpen`, default on; silently skipped when defaults are not found).

The document's header comment notes the source paths of defaults and component config. Saving, adding, or deleting defaults or the component `kbengine.xml` triggers recomposition (`kbengine.autoRefreshFinalConfig`, default on). Hover a field to see what it does.

### How the telnet Port/Password Are Read

telnet has no parameter set of its own — it is the three layers above plus one explicit-settings layer, taking the first non-empty value in order:

| Parameter | Order of resolution |
| --- | --- |
| Port | Setting `kbengine.telnet.port` (>0) → the component `kbengine.xml` `<telnet_service>`'s `port` → that component's port in engine defaults |
| Password | Setting `kbengine.telnet.password` → the component section's `password` → engine defaults' `password` → empty (no auto login) |
| Host | Setting `kbengine.telnet.host`; left empty uses `127.0.0.1` |

Two boundaries:

- When the component `kbengine.xml` has no `<telnet_service>` section and the settings give no port → no probing; the telnet panel, status lights, and the standalone tree view all stay hidden. The engine defaults do contain a `<telnet_service>` section, but defaults only supply value fallbacks and never turn telnet "on" by themselves;
- When the component section exists but writes no port → probe per component against the engine's default component port table: loginapp 31000 / dbmgr 32000 / interfaces 33000 / logger 34000 / baseapp 40000 / cellapp 50000 / bots 51000; components whose port is written in defaults follow defaults.

`.kbengine/debug.json` is unrelated to this chain — it serves only the debugging flow (see the "Debug Configuration File" section).

## Overview of `kbengine.*` Settings (by Feature Area)

The 74 settings are grouped by feature — one small table per area (Setting/Type/Default/Purpose), immediately followed by that area's impact of changes and common misconfigurations; no more one 74-row table. To find a setting, locate the feature area first, then the row within it.

### Diagnostics

| Setting | Type | Default | Purpose |
| --- | --- | --- | --- |
| `kbengine.enableDiagnostics` | boolean | `true` | Master switch for `.def` diagnostics (since batch 147 it also gates the duplicate entity registration check in `entities.xml`) |
| `kbengine.enableStructureDiagnostics` | boolean | `true` | Switch for structural validation (duplicate properties/methods, child-tag position, missing fields, duplicated field definitions) |
| `kbengine.diagnostics.checkUnknownTypes` | boolean | `true` | Check unknown type names |
| `kbengine.diagnostics.checkUnknownFlags` | boolean | `true` | Check unknown Flags values |
| `kbengine.diagnostics.checkUnknownDetailLevels` | boolean | `true` | Check illegal DetailLevel values |
| `kbengine.diagnostics.checkDuplicateDefinitions` | boolean | `true` | Check duplicate property/method names |
| `kbengine.diagnostics.checkMissingPropertyFields` | boolean | `true` | Check properties missing `Type`/`Flags` or duplicated fields |

| Setting | What turning it off does | Common misconfiguration |
| --- | --- | --- |
| `enableDiagnostics` | Type, Flags, and structural problems in `.def`, plus duplicate `entities.xml` registrations, are no longer flagged | Forgetting to reopen the file and assuming the code has no errors |
| `enableStructureDiagnostics` | Duplicate properties/methods, misplaced child tags, missing `Type`/`Flags`, and duplicated field definitions all go unreported | Confusing this with the item above: this one covers structure only; a misspelled type name belongs to `checkUnknownTypes` |
| `diagnostics.checkUnknownTypes` | Misspelled type names no longer reported | Custom types must be locatable to avoid false positives: check `entity_defs/types.xml`, `scripts/entity_defs/types.xml`, `assets/scripts/entity_defs/types.xml` first, then `user_type/<Type>.py`, `scripts/user_type/<Type>.py`, `assets/scripts/user_type/<Type>.py` |
| `diagnostics.checkUnknownFlags` | Misspelled Flags no longer reported | — |
| `diagnostics.checkUnknownDetailLevels` | Illegal DetailLevel values no longer reported | — |
| `diagnostics.checkDuplicateDefinitions` | Real duplicates go unreported | Projects with too many hints may turn this off, at the cost of missing real duplicates |
| `diagnostics.checkMissingPropertyFields` | Properties missing `Type`/`Flags` go unreported | — |

Diagnostics trigger only when a `.def` file is opened or edited; after `kbengine.*` configuration changes, already-open `.def` files are rescanned.

### Hover

| Setting | Type | Default | Purpose |
| --- | --- | --- | --- |
| `kbengine.hover.showTagDocs` | boolean | `true` | Hover docs for tags like `<Type>`, `<Flags>`, `<Properties>` (the most frequent; turn this one off first if hints feel too many) |
| `kbengine.hover.showValueDocs` | boolean | `true` | Hover docs for values like `UINT32`, `BASE_AND_CLIENT`, `FAR` |
| `kbengine.hover.showSymbolDocs` | boolean | `true` | Hovering a custom property/method name shows the current definition's `Type`, `Flags`, `Arg` context |
| `kbengine.hover.typeStorage` | boolean | `true` | Storage hover (landed table/column/type and shape) for `types.xml` custom types, in `.def`/`types.xml` |
| `kbengine.hover.implementedBy` | boolean | `true` | Backlink when hovering a Python-side symbol referenced by a `types.xml` `implementedBy` |
| `kbengine.hover.entityRegistration` | boolean | `true` | Registration info (`Utype`/list position) when hovering an `entities.xml` entity name |
| `kbengine.hover.defChain` | boolean | `true` | Merged def chain when hovering `Parent`/`Interfaces` declaration elements |
| `kbengine.hover.eventStats` | boolean | `true` | Registration/emit stats when hovering an event name in Python |
| `kbengine.hover.serverConfig` | boolean | `true` | Value and docs when hovering a `kbengine.xml` server config field (turns off the batch-112 hover face entirely) |
| `kbengine.hover.asyncBudgetMs` | number | `2500` | Total budget (ms) for the hover def-method / receiver-call / builtin-property async chains; past the budget the layer is cut short and a timeout line is logged to LogHub (filter `[kode-hover][timeout]`) instead of spinning forever; `<= 0` disables the gate (legacy unbounded wait) |

With the first three off, `.def` hover keeps only syntax highlighting. Since batch 154 (2026-10-20) the other six faces each get an independent per-feature switch — no master switch cutting everything off at once; mute only the noisy face and the rest carry on.

### CodeLens and inlay hints

| Setting | Type | Default | Purpose |
| --- | --- | --- | --- |
| `kbengine.codeLens.rpc` | boolean | `true` | RPC markers above `def`-declared method lines in Python implementation scripts (batch 126) |
| `kbengine.codeLens.eventCallbacks` | boolean | `true` | Event callback markers — the event name on callback `def` lines and the listener count on `emitEvent` (since batch 154, split out of the RPC lens chain into its own registration) |
| `kbengine.codeLens.property` | boolean | `true` | Property markers at `self.<property>` access sites in Python scripts (batch 135) |
| `kbengine.codeLens.typesXml` | boolean | `true` | Storage lens chain on `types.xml` declaration lines (batch 134) |
| `kbengine.inlayHints.typeData` | boolean | `true` | Inline hint showing the `.def`-declared `<Type>` data type (types.xml custom alias or built-in) at `self.<property>` access sites in Python, and the declared parameter types (`argN: type`) after each argument of `self.base/cell/client` RPC call sites (declared args only, section-gated) — same resolution index as property F12 (batch 154) |

The four CodeLens switches take effect on change, no window reload needed; inlay hints have no change event, so turning one off takes effect on the next render.

### Jumps and Navigation

| Setting | Type | Default | Purpose |
| --- | --- | --- | --- |
| `kbengine.jumpLog` | boolean | `false` | Jump decision-path logging (Output panel KBEngine Navigation, filter `[kode-jump]`; zero overhead when off) |
| `kbengine.python.enableMroJump` | boolean | `true` | Switch for Python jump layer 2 (cross-file C3-MRO + composition roots resolving mixin/base-class methods); when off, layer 2 records a skip and no full-repo scan runs — jumps fall back to layer 1 (the `.def` derived index) and layer 3 (current-file class scopes) |
| `kbengine.python.callChainHints` | boolean | `true` | Python entity-method call-chain lenses and the `Show Call Chain` command; off removes the lens entry and suppresses preview generation |
| `kbengine.python.callChainView` | string | `graph` | Initial `Show Call Chain` panel view: `graph` (mermaid rendered from the bundled npm package, offline-capable) or `text` (text chain fallback); the in-panel tab choice persists to workspace state and takes precedence over this setting; graph render failures fall back to text automatically with a header notice |
| `kbengine.python.apiMetadata` | boolean | `true` | Engine-aware KBEngine API metadata (version, source commit/description and original declaration locations); missing source identity shows `unknown` instead of invented values |

`kbengine.python.enableMroJump` changes take effect immediately (no window reload); when off, layer 2 only records a skip in the jump trace and no full-repo `.py` scan runs, and `.py` changes stop being fed to the index. Method use sites prefer the Python implementation, with `.def` method declarations staged as fallback targets; `.def` navigation is kept at property accesses and method declarations. The index distinguishes modules from base/cell same-named classes and uses unsaved editor content. For the per-layer trace and troubleshooting, see the `[kode-jump]` decision-path section of the Logging guide. Engine source settings feed `kbengine.python.apiMetadata`; metadata is derived at activation, not by hard-coding a machine path.

### Paths and Workspace Discovery

| Setting | Type | Default | Purpose |
| --- | --- | --- | --- |
| `kbengine.entityDefsPath` | string | `scripts/entity_defs` | Entity definitions directory (entity explorer list, `entities.xml` navigation, generator `.def` output) |
| `kbengine.entitiesXmlPath` | string | `scripts/entities.xml` | `entities.xml` path (dependency graph reads and entity registration) |
| `kbengine.binPath` | string | `${workspaceFolder}/../kbe/bin/server` | Engine binaries directory; also derives the engine root (`KBE_ROOT`) and the engine default config path |
| `kbengine.assetsRoot` | string | `""` | Assets root (containing `res/`, `scripts/` below); empty = auto-discover |

All four are "optional overrides": a configured value is honored as-is, an unconfigured one goes through the discovery chain — see "Auto-Discovery of Path Settings" below. Per-key details:

#### `kbengine.entityDefsPath`

- Type: string; default `scripts/entity_defs` (relative to the workspace root)
- Used by: the entity explorer list, `entities.xml` navigation, generator `.def` output
- Since batch 125, when unset or the default path does not exist it auto-discovers (conventional layouts → unique deep-scan hit → multi-candidate asks once during activation and remembers); config serves only as override
- Misconfiguration: pointing at the wrong directory leaves the entity explorer empty

#### `kbengine.entitiesXmlPath`

- Type: string; default `scripts/entities.xml`
- Used by: dependency graph reads and entity registration. Change this when the project puts the registry file in a custom location
- Since batch 125, a deep-scan fallback covers all-missed conventions (preferring the def root's parent); config serves only as override

#### `kbengine.binPath`

- Type: string; default `${workspaceFolder}/../kbe/bin/server`
- Placeholders supported: `${workspaceFolder}`, `${env:VAR}`
- Used for: ① starting/stopping component processes; ② deriving the engine root (`KBE_ROOT`) and the engine default config path — replacing the trailing `kbe/bin/server` with `kbe/res/server/kbengine_defaults.xml`
- Since batch 125, when unset it first derives `kbe/bin/server` via engine source-root anchors (`kbe/src/lib/entitydef/entitydef.cpp`, `entity_table_mysql.cpp`, etc.), then falls back to sibling-directory guessing
- Misconfiguration: not pointing at the `kbe/bin/server` level → server start fails, and the final config view and defaults value fallback become unavailable; `kbengine.config.showFinal` then errors plainly, and the activation auto-open silently skips

#### `kbengine.assetsRoot`

- Type: string; default `""` (empty = auto-discover). Renamed from `kbengine.configPath` in batch 131 (2026-10-15): aligning with engine-domain terminology (the engine assets tree is literally called assets, and the convention scan is `*_assets`, see `../../../assets/res/server/` at kbemain.h:133-137); the old default `${workspaceFolder}/server` was dropped at the same time — that default disguised "unconfigured" as "explicitly configured", and only the empty string lets the code's "unset → auto-discover" path take real effect
- This is the assets root (the engine assets tree root, e.g. `flyff_assets`), effective in three places:
  1. The working directory (cwd) of component processes — the engine resolves asset-relative paths against it;
  2. The project-side entry of the process env `KBE_RES_PATH`: full order `KBE_ROOT/kbe/res`, the assets root, `assetsRoot/res`, `assetsRoot/scripts`;
  3. The preferred location of the component `kbengine.xml`: `assetsRoot/kbengine.xml`.
- Since batch 128, auto-discovery: when the original value fails the engine-loading probe (no `res/server/kbengine.xml` below it), fall back through convention chain → remembered multi-candidate choice → unique deep-scan hit; the discovered root likewise feeds telnet probing and the final config view's component `kbengine.xml`. Since batch 129 the convention chain includes first-level `*_assets` workspace directories (like `flyff_assets`) — the directory name is only admission; a hit is still accepted by probe
- The probe validates only the user copy `kbengine.xml` and does not require `kbengine_defaults.xml` to be present: the engine loads the two configs each in its own tree (kbemain.h:71-74 loads defaults first, then the user copy overrides; the engine comments at kbemain.h:133-137 exemplify defaults in the engine res tree and the user copy in the assets tree), and the assets root's anchor is exactly the user copy — the engine's `getPyUserResPath()` also locates the assets tree via `matchRes("server/kbengine.xml")`. The extension follows the same rule: defaults are derived from binPath/the engine source root (`deriveEngineDefaultsXmlPath`), the user copy is found from the assets root — the two trees are independent
- Before starting, it validates: empty string when both discovery and explicit config fail, a nonexistent directory, or a path that is not a directory all error and abort the start; directory present but probe file missing → a `[WARN]` is left in the output channel without blocking (batch 127)
- Misconfiguration: pointing at the repo root instead of the assets directory → the probe fails and auto-discovery takes over; when discovery also fails, the engine cannot find scripts under `res`/`scripts` subdirectories and components will not start; when the component `kbengine.xml` cannot be located, telnet and the final config fall back to pure defaults

### Final Config View

| Setting | Type | Default | Purpose |
| --- | --- | --- | --- |
| `kbengine.showFinalConfigOnOpen` | boolean | `true` | When the extension activates and defaults can be located, auto-open `kbengine-final.xml` in the background (a preview tab, not stealing focus); on location failure it silently skips without an error popup. When off, it can still be opened manually via the command or the sidebar Config view's 「最终配置」 node |
| `kbengine.autoRefreshFinalConfig` | boolean | `true` | After defaults or the component `kbengine.xml` is saved, added, or deleted, recompose the open composed document automatically. When off, reopen the document or rerun the command |

### Server and Logs

| Setting | Type | Default | Purpose |
| --- | --- | --- | --- |
| `kbengine.autoStart` | string[] | `["machine","logger","dbmgr"]` | Components brought up by a start without arguments. Legal values come from the component registry (`src/serverManager.ts`): `machine`, `logger`, `interfaces`, `dbmgr`, `baseappmgr`, `cellappmgr`, `loginapp`, `baseapp`, `cellapp`, `bots` |
| `kbengine.loggerPort` | number | `20022` | Log collector connection port; must match the engine logger's listen port — a mismatch leaves the panel unconnected (it retries on an interval internally) |
| `kbengine.logAutoConnect` | boolean | `true` | Try connecting to the logger once on activation; failure is silent and goes through reconnection |
| `kbengine.webviewConsoleLogs` | boolean | `true` | Collect the log panel page's `console` output and uncaught exceptions into the same log stream |
| `kbengine.maxLogEntries` | number | `10000` | Log WebView cache cap (entries). Lower it to save memory on heavy log volume; raise it to keep longer history |

### Remote Debugging

| Setting | Type | Default | Purpose |
| --- | --- | --- | --- |
| `kbengine.debug.remoteTargets` | array | `[]` | Remote debug target list — the target source for `Attach to Remote Component`; `Update launch.json` appends them into `launch.json` as debugpy `connect` entries |

Fields per entry:

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `name` | string | Yes | Target display name (the identifier in the picker) |
| `host` | string | Yes | Remote IP or hostname |
| `port` | number | No | debugpy listen port, default `5678` |

- Prerequisite: the remote component must first have been sent the enable-debugging command over telnet and have a debugpy listener up; the extension attaches with `connect: {host, port}`, without `pathMappings`
- Misconfiguration: a wrong `host` → attach fails through the error channel; a wrong `port` → debugpy unreachable; entries with empty `name`/`host` are not collected

### Python Integration

| Setting | Type | Default | Purpose |
| --- | --- | --- | --- |
| `kbengine.python.extraPathsSync` | boolean | `true` | Auto-write the workspace-discovered KBEngine scripts root into `python.analysis.extraPaths` (WorkspaceFolder level; manages only the segment this extension wrote, user-entered paths are never touched; no write when unchanged). When off, the `kbengine.python.syncExtraPaths` command only explains without writing |
| `kbengine.python.stubExport` | boolean | `true` | Auto-export the built-in KBEngine Python API index (same source as completion/hover/navigation) as a `KBEngine.pyi` stub, and export the types.xml custom types into a `kbe_types.py` type stub module (`FIXED_DICT` → `TypedDict`, aliases → type names), which together with the extraPaths wiring lets Pylance resolve `import KBEngine` / `import kbe_types` (virtual stub documents are invisible to the Python extension). Silent auto-export once on activation; `kbengine.python.exportStubs` / `kbengine.python.exportTypeStubs` are the manual entries |
| `kbengine.python.stubDir` | string | empty | The `.pyi` stub directory, resolved in three tiers: setting > env var `KBENGINE_STUB_DIR` > default convention `.kbengine/stubs`. VS Code variables like `${workspaceFolder}`/`${env:NAME}` are supported; relative paths join against the workspace root, absolute paths are used as-is |
| `kbengine.python.stubEngineTypings` | boolean | `true` | Prefer concatenating the full API from a local engine typings checkout when exporting `KBEngine.pyi` (default: enabled); when off, fall back to the built-in curated catalog. The master switch is still `kbengine.python.stubExport` |
| `kbengine.python.entityStubMethods` | boolean | `true` | Include the def method surface (Base/Cell/ClientMethods) in `entity_types.pyi` stubs (default: enabled); when off, keep the properties-only stub surface |

### Entity Script Enhancements (2026-10-21)

| Setting | Type | Default | Purpose |
| --- | --- | --- | --- |
| `kbengine.entity.builtinProperties` | boolean | `true` | Hover annotations and `self.` completion for built-in entity properties (per base/cell/client face; default: enabled); when off, falls back to the plain symbol chain |
| `kbengine.entity.receiverSections` | boolean | `true` | Filter def candidates by receiver section on `self.cell.`/`self.base.`/`self.client.` calls — hover, F12, RPC lens (default: enabled); when off, falls back to section-unaware resolution while the def signature (arg/type) gate stays on |
| `kbengine.python.builtinTypeInlayHints` | boolean | `true` | Inline `: <type>` hints after `self.<builtin property>` accesses in entity scripts (same hit basis as hover; default: enabled); double-gated by `kbengine.entity.builtinProperties` (master switch) and this key — either off renders no builtin-property inlay hints |
| `kbengine.types.aliasDiscovery` | boolean | `true` | Discover custom types from `scripts/entity_defs/alias.xml` into the type list (default: enabled); when off, falls back to `types.xml` only |

With `kbengine.python.stubDir` left empty (the default), the directory is kode-managed `.kbengine/stubs`: zero write when content matches disk, stale content (after an index update) is automatically rewritten, manual edits are not kept — ignoring it in `.gitignore` is recommended. **With a directory configured, the directory is user-owned**: kode only scans, never overwrites — any `.pyi` already in the directory is treated as a user asset and left untouched; one is generated only when no `.pyi` exists; an unreadable directory (missing/no permission) is reported honestly, never blindly written.

Boundary: the extraPaths managed segment recognizes only the default convention directory `.kbengine/stubs` (joined when export is on and `KBEngine.pyi` or `kbe_types.py` is on disk; both generated artifacts share the one directory); a user-configured `kbengine.python.stubDir` directory does not join the managed segment — add it to `python.analysis.extraPaths` yourself if needed.

### Code Generators

| Setting | Type | Default | Purpose |
| --- | --- | --- | --- |
| `kbengine.generator.defOutputPath` | string | `scripts/entity_defs` | Where generated `.def` files go; the default value is itself the discovered def root, config serves only as override |
| `kbengine.generator.pythonOutputPath` | string | `scripts` | Where generated Python goes; with the default value it is derived from the discovered def root's parent (e.g. `assets/scripts`), config serves only as override |
| `kbengine.generator.generatePython` | boolean | `true` | Whether wizard/template entity creation also generates the Python file |
| `kbengine.generator.registerInEntitiesXml` | boolean | `true` | Auto-write into `entities.xml` after generation (writing the file pointed to by `entitiesXmlPath`) |

#### `kbengine.clientSdk.outputDir`

| Setting | Type | Default | Purpose |
| --- | --- | --- | --- |
| `kbengine.clientSdk.outputDir` | string | `scripts/client_entities` | Output directory of the client entity SDK generator (`kbengine.clientSdk.generate`) — TypeScript / C# skeletons and companion files all land here; relative to the workspace root |

The language list and overwrite policy are chosen in the command's quick pick; existing files are not overwritten by default — see [Client Entity SDK Generation](./client-sdk.md).

### telnet Probing

telnet's presentation surface (standalone tree view, status lights, panel) appears only when the configuration explicitly enables telnet; the resolution chain is in "How the telnet Port/Password Are Read".

| Setting | Type | Default | Purpose |
| --- | --- | --- | --- |
| `kbengine.telnet.host` | string | `127.0.0.1` | Probe target host. For a remote machine, enter its IP |
| `kbengine.telnet.port` | number | `0` | Explicit port. >0 locks a single target (no more per-component probing); 0 = not explicitly set, falling back to the component `kbengine.xml` section and defaults |
| `kbengine.telnet.password` | string | empty | Used by the automatic handshake login; written to the socket only, never to logs. Empty = no auto login; the status light stays at 「端口开·未配密码」 (port open, no password set) |
| `kbengine.telnet.enableCommands` | string[] | `[]` | The command whitelist the telnet panel may send (exact match, or "command + space + arguments" prefix match). Built-in read-only shortcut commands (entity count/entity list/global data keys/`:help`) are allowed by default; `:quit` shuts the server process down and is always refused even if whitelisted |
| `kbengine.telnet.configXmlPath` | string | empty | Explicitly specifies the component `kbengine.xml` (`${workspaceFolder}` supported), taking priority over auto-probing; when the setting gives an explicit port >0, the port follows the setting |
| `kbengine.telnet.probeIntervalSeconds` | number | `5` | Probe polling interval (seconds); values below 1 run at 1 second |

### HTTP Quick Requests

| Setting | Type | Default | Purpose |
| --- | --- | --- | --- |
| `kbengine.httpRequests` | array | see below | HTTP quick request list (one disabled example by default) |

Type: array; the default contains one disabled example (a hot-reload example, `enabled: false`), shaped after a real local hot-reload service — equivalent to:

```bash
curl 'http://127.0.0.1:8000/api/hotfix?relaod=entities.fight.FightAI'
```

Add/remove/edit via the settings UI's list editor; enable/disable = the entry's `enabled` switch. Fields per entry:

| Field | Type | Notes |
|------|------|------|
| `name` | string | Request name (identifier in the quick pick and logs), required |
| `url` | string | URL template, may contain template variables, required |
| `method` | string | HTTP method, default `GET` |
| `headers` | object | Request headers (values also go through template substitution) |
| `body` | string | Request body (sent only when non-empty, also through template substitution) |
| `enabled` | boolean | Enable switch, default enabled |
| `keybinding` | string | Keybinding display string (shown in the quick pick's detail column) |

Template variables (shared by URL/body/header values, literal substitution, no URL encoding):

| Variable | Meaning |
|------|------|
| `${module}` | Module path scanned along `__init__.py` package boundaries: when `entities/` and `fight/` each contain `__init__.py`, `entities/fight/FightAI.py` → `entities.fight.FightAI`; KBEngine scripts live under `base/`/`cell/` role directories which have no `__init__.py`, so those do not count as module segments — the module name is then just the file name without `.py` (the "no module, use the file name" form) |
| `${moduleBasename}` | Last segment of the module path: `entities.fight.FightAI` → `FightAI`; in the no-package form it matches `${module}` |
| `${filename}` | File name (`FightAI.py`) |
| `${line}` | Cursor line (1-based) |
| `${sel}` | Selected text |

The official VS Code variable family is also supported (`${file}`=absolute path, `${workspaceFolder}`, `${workspaceFolderBasename}`, `${fileBasename}`, `${fileBasenameNoExtension}`, `${fileDirname}`, `${fileExtname}`, `${relativeFile}`, `${relativeFileDirname}`, `${env:NAME}`, `${cwd}`, `${userHome}`, `${pathSeparator}`; in multi-root workspaces `${workspaceFolder:Name}` picks a folder by name). Placeholders unknown to both tables are kept as-is (not wiped to an empty string).

> History: before batch 152 the file-name placeholder was named `${file}`; since the official variable family landed, `${file}` follows the official absolute-path semantics — use `${filename}` for the file name.

With no active editor, each variable substitutes to the empty string.

Keybinding: VS Code has no API to register keybindings at runtime; bind a key to `kbengine.httpRequest.run` in "Keyboard Shortcuts" and carry the request name in `args`:

```json
{
  "key": "ctrl+alt+h",
  "command": "kbengine.httpRequest.run",
  "args": { "name": "热更新(示例)" }
}
```

The run log goes to the OUTPUT channel 「KBEngine HTTP 快捷请求」 (KBEngine HTTP quick requests): `▶` request line → `✓` status code · duration → response body (truncated past 4000 characters, full length noted); failures render as a `✗` mark + an error popup.

### Auto Hot Reload

File save/watch → trigger the `quickActions` action by name. Gated **off by default** against accidental fires: before enabling, no file watchers are created and the assembly chain and activation behavior are unchanged; switching `enabled` to `true` immediately creates watchers per `globs`, switching to `false` tears them down — config changes take effect immediately, no window restart needed.

| Setting | Type | Default | Purpose |
| --- | --- | --- | --- |
| `kbengine.hotReload.enabled` | boolean | `false` | Master switch; when on, one file watcher per `globs` pattern |
| `kbengine.hotReload.actionName` | string | empty | The action name to trigger; must exist in the `quickActions` array |
| `kbengine.hotReload.globs` | string[] | `["**/*.py"]` | Watch patterns (VS Code globs); one file watcher per pattern |
| `kbengine.hotReload.debounceMs` | number | `500` | Debounce milliseconds before triggering; `0` = no debounce |
| `kbengine.hotReload.tempEdit.enabled` | boolean | `false` | Master switch for the temp-edit hot reload command (default off, same gate style as `hotReload.enabled`) |
| `kbengine.hotReload.tempEdit.actionName` | string | empty | Quick action fired for the reload step (HTTP or terminal); empty aborts with a config error |
| `kbengine.hotReload.tempEdit.autoRestore` | boolean | `true` | Restore the original content before sending the reload request; a failed restore aborts the request |
| `kbengine.hotReload.tempEdit.scriptRoot` | string | empty | Script resource root for dual-name resolution (fullModule / requestModule); empty echoes the module name as unresolved, no guessing |

Behavior rules:

- **All three channels trigger**: a file's change, creation, and deletion all count as save events; any of them enters debounce.
- **Debounce merges**: bursts of events between one trigger and the next merge into one execution; turning the switch off during debounce cancels the pending timer.
- **Unattended**: the trigger path skips the execution confirmation box (even if the action's `confirm` is `true`); the action's own failures still pop up their errors as usual — that is an execution result, not an interaction confirmation. Executions are still written into the "last run" memory, so the Explorer's top-bar ▶ also points at the most recently triggered action.
- **No disturbance on missing names**: when `actionName` is empty or matches no action, the event still fires but only drops one log line into the OUTPUT channel 「KBEngine 快速执行动作」 (KBEngine quick actions) — no popup, no execution.
- **Config tolerance**: wrong types (`enabled` not a boolean, `globs` not an array, `debounceMs` negative or non-numeric) all fall back to defaults, erroring nothing and interrupting nothing; empty strings and non-string items in `globs` are pruned, and pruning to empty falls back to the default `**/*.py`.

### Runtime Queries

The Runtime Queries panel (`kbengine.runtimeQuery.show`) queries a running KBEngine over the engine's console protocol: component discovery, a single watcher path query rendered as a table, and space snapshots. Its operation surface — the watcher watch-list (add/remove) and the result subscription stream — is gated **off by default** against accidental polling against a live server.

| Setting | Type | Default | Purpose |
| --- | --- | --- | --- |
| `kbengine.runtimeQuery.enabled` | boolean | `false` | Master switch for the operation surface (watch-list add/remove and the result stream); off keeps the panel to single manual queries |
| `kbengine.runtimeQuery.pollIntervalMs` | number | `2000` | Result stream interval in milliseconds; applies only when `kbengine.runtimeQuery.enabled` is on |

Behavior rules:

- **Default off is enforced at the boundary**: with `kbengine.runtimeQuery.enabled` unset or false, starting the stream reports `watchList: Result stream is off by default; enable kbengine.runtimeQuery.enabled.` and issues no query at all — the panel stays on single manual queries.
- **Watch-list entries are query targets, not engine watchers**: `KBEngine.addWatcher` / `delWatcher` are in-process script APIs (`kbe/src/lib/pyscript/pywatcher.cpp`), not console-protocol messages, so the panel cannot add or remove watchers inside the engine. Adding a path only registers it for the panel's own queries.
- **Interval floor**: values below `500` are clamped to `500` at run time (the schema also declares `minimum: 500`), so a mis-typed `50` polls at 500 ms, not 50 ms.
- **Empty list is a no-op round**: with no watch-list entries a stream round issues no request and does not clear the existing table rows.
- **The stream stops with the panel**: closing the webview tears the interval down; rounds that resolve after the panel closed are dropped instead of posted back.

Boundary: these are engine *runtime* console-observation protocol messages, only reachable against a running KBEngine server. End-to-end assertions cannot run in-repo or in CI — see `docs/design/space-viewer-watcher.md` §8 for the conditions under which a real end-to-end run would be worth reopening.

### Dual-Track Backend Gate (kode2 Rust Core)

| Setting | Type | Default | Purpose |
| --- | --- | --- | --- |
| `kbengine.core.backend` | string | `"ts"` | Dual-track backend switch (kill-switch): `ts` = single track (current truth); `rust` is a reserved value — refused by the serving gate until cutover preconditions are all green, the effective track stays `ts`; `shadow` = shadow comparison — TS keeps serving while same-parameter requests are mirrored to kode-server and only diff-logged. Any invalid value falls back to `ts`; switching back to `ts` stops the Rust process immediately for a user-invisible rollback |
| `kbengine.core.serverPath` | string | empty | kode-server binary path; only used when `backend=shadow`. When empty, shadow comparison logs `rust-unavailable` and spawns nothing |
| `kbengine.core.shadow.timeoutMs` | number | `2000` | Mirror-request timeout (ms) for shadow comparison; timeouts only log `rust-timeout` and never affect the TS serving path |

Iron rule: with the default `ts`, the Rust path is not involved at all and user-visible behavior matches the pure-TS single track; in `shadow` mode Rust results go only into the diff log of the 「KBEngine Core Shadow」 output channel (inspect via `kbengine.core.showShadowDiffLog`) and never affect any user-visible result.

### Database

| Setting | Type | Default | Purpose |
| --- | --- | --- | --- |
| `kbengine.db.tablePrefix` | string | `""` (empty = engine default `tbl_`) | Database table name prefix; replaced in the schema view and SQL templates from the same source |

With a custom value (e.g. `kb_`), table names in the schema view and the three SQL template lines are replaced from the same source:

| Template | Purpose |
| --- | --- |
| `SQL: SELECT * FROM ...` | All columns (engine structural columns + property columns) |
| `SQL(属性列): SELECT ...` | Lists only the columns landed from def properties, dropping `id` / `sm_autoLoad` / `parentID` / the six position-orientation columns |
| `SQL(子表 JOIN): ...` | ARRAY / component child tables only: joins the parent by `parentID`; `LEFT JOIN` keeps property rows of empty elements |

The child-table JOIN also appears in the hover line of ARRAY / component properties. Projects not changing the engine default prefix can leave it empty — behavior is unchanged.

#### Connection Info of the Database Drift Check

`kbengine.database.checkDrift`'s connection info **all comes from the engine config, with no new settings**: the composed `<dbmgr><databaseInterfaces><default>` (engine `kbengine_defaults.xml` + component `kbengine.xml` same-key override); port `0` lands on the MySQL default 3306.

The credentials must be stored in plaintext (`<encrypt>false</encrypt>`). The engine default `encrypt=true` is RSA ciphertext, which kode does not decrypt; the command then honestly reports 「未校验」 (not verified) — it never asks you to change the engine config or type a password just to run one check. The verification rules and the read-only red line: see [Database Drift Check](./database-drift-check.md).

## Debug Configuration File (`.kbengine/debug.json`)

This file serves only the debugging flow and quick actions. telnet probing, the telnet panel, status lights, and the telnet tree view never read it.

### Quick Actions (the `quickActions` key)

Actions are the **top-level `quickActions` array** (not inside the `debug` section: actions are not debug config); they travel with the KBEngine project, with no new `kbengine.*` settings.

**Editor-side validation**: kode ships a JSON Schema for this file with the package (matching `.kbengine/debug.json` at any subfolder depth); VS Code's JSON extension flags errors while editing — a wrong backend type, `telnetPort` written as a string, a `pathMappings` entry missing `localRoot`/`remoteRoot`, a `method` outside the whitelist — all surface before saving instead of at run time. The schema is generated from the parser's own definitions (backend and method enums take the constants of `quickActionConfig.ts`), byte-identical with the inline object in `package.json` and locked by tests against drift. Validation is a hint, not a gate: the parser still prunes bad entries one by one, and per-field type fallback rules are unchanged.

| Field | Applicable types | Notes |
|------|------|------|
| `name` | all | Display name, required |
| `type` | all | `command` / `script` / `http`; anything outside the whitelist is pruned whole |
| `command` | command | VS Code command id, required |
| `args` | command | Argument array; string items go through variable substitution, default `[]` |
| `script` | script | Script path, required, variables supported |
| `cwd` | script | Working directory, variables supported, default the workspace root |
| `venv` | script | Optional `{ "enabled": true, "path": "${workspaceFolder}/.venv" }`; prepends `bin` (`Scripts` on Windows) to the child `PATH` and sets `VIRTUAL_ENV`; without `path`, searches `.venv` / `venv` beside the script and under the config root |
| `background` | script | `true` means server-start types don't wait for the exit code, default `false` |
| `url` | http | URL, required, variables supported; only the address hard-coded in the config is requested — no runtime concatenation |
| `method` | http | `GET` / `POST` / `PUT` / `PATCH` / `HEAD` / `OPTIONS`, default `POST` |
| `body` | http | Request body (sent only when non-empty), variables supported |
| `confirm` | all | Modal confirmation before execution, default `true` |
| `source` | all | `manual` / `scan`; entries generated by the first-install scan are automatically recorded `scan` |
| `category` | all | `server` / `export`, written only for scan-generated entries that hit the word list (omitted for word-list outsiders) |

Variables (substituted at run time, applied to config literal strings only):

| Variable | Meaning |
|------|------|
| `${workspaceFolder}` | The effective quick-action config root (normally the first workspace root) |
| `${workspaceFolder:Name}` | The workspace root by view name (multi-root projects) |
| `${env:VAR_NAME}` | A process environment variable |

An unknown variable errors out immediately, naming the variable — a silent empty-string substitution would run the script into a fake success with an "empty path", worse than an error.

Example:

```json
{
  "version": "1.0.0",
  "quickActions": [
    { "name": "重启 BaseApp", "type": "command",
      "command": "kbengine.server.restart", "args": ["baseapp"] },
    { "name": "启动全部组件", "type": "script",
      "script": "${workspaceFolder}/start_server.bat", "background": true },
    { "name": "导配置表", "type": "script",
      "script": "${workspaceFolder}/export_tables.bat" },
    { "name": "本地热更", "type": "http",
      "url": "http://127.0.0.1:9000/reload", "method": "POST", "confirm": false }
  ]
}
```

The first-install scan checks the effective config root and the top level of `assetsRoot` for `.bat` / `.ps1`, listing **all of them** for confirmation (the start/stop (`start` / `stop` / `restart` / `boot` / `server`) and table-export (`export` / `convert` / `导表`) vocabulary only **assigns a category** — hits get `server` / `export`, non-hits omit it); after checking, they are written in the `${workspaceFolder}/<filename>` variable form (those starting with `start` / `boot` automatically get `background: true`), preserving existing `version` / `debug` sections. Use `Rescan Scripts for Quick Actions` to scan again at any time. Generated script paths and `cwd` both point to the script's directory; venv is off by default for scanned actions — opt in with `"venv": { "enabled": true }` or specify a `path`. A rescan replaces only `source: "scan"` actions and preserves manual actions and `debug` settings.

### Debug Fields (the `debug` section)

| Field | Purpose |
| --- | --- |
| `debug.defaultTelnetHost` / `defaultTelnetPort` | The telnet address in `Start Debugging`'s instructions (hint only, not part of actual probing) |
| `debug.components.<Component>.telnetHost` / `telnetPort` | Same as above, overridden per component |
| `debug.components.<Component>.telnetEnableCommands` | The "enable-debugging commands" listed in the instructions, reminding you to first send the project's actual command over telnet |
| `debug.components.<Component>.pathMappings` | The path mappings written when `Update launch.json` generates the attach configuration |

Local attach does not take the process id from here: `Attach to Component` lists local processes (matches of the component name pinned with ✓), and assembling the configuration from the selected PID. Remote attach targets come from the setting `kbengine.debug.remoteTargets` and never read this file either.

Recommended structure:

```json
{
  "version": "1.0.0",
  "debug": {
    "defaultTelnetHost": "127.0.0.1",
    "defaultTelnetPort": 0,
    "components": {
      "baseapp": {
        "telnetHost": "127.0.0.1",
        "telnetPort": 0,
        "telnetEnableCommands": [
          "# 先连接 telnet",
          "# 再输入项目实际使用的开启调试命令"
        ],
        "pathMappings": [
          {
            "localRoot": "${workspaceFolder}",
            "remoteRoot": "${workspaceFolder}"
          }
        ]
      }
    }
  }
}
```

#### Generated When Missing (batch 143)

When `.kbengine/debug.json` is absent from the workspace, the extension writes an annotated skeleton at activation — you no longer have to create the file first and guess what each field means:

- The skeleton is written as **JSONC**, so `//` and block comments are allowed (same convention as `tsconfig.json`); every field carries a one-line explanation. Kode strips comments before parsing, so comments you write yourself never make the file unreadable.
- Path examples always use the `${workspaceFolder}/...` form — open and edit.
- Scripts found by the existing scan rule (one level of `.bat`/`.ps1` under the working directory; the word list only assigns a category) are written into `quickActions`; when nothing matches, the array stays empty.
- **An existing file is never overwritten**: repeated activations and your edits are preserved as-is. If the directory is not writable, the extension says so in the `KBEngine 配置` output channel and nothing else is affected.

#### Working Directory and the Environment Variable

The scaffold location and the `.pyi` stub directory share one effective working directory, resolved highest priority first:

| Tier | Source | Notes |
| --- | --- | --- |
| 1 | `KBENGINE_WORKSPACE` environment variable | Supports official VS Code variable substitution, e.g. `${workspaceFolder}/server`; the name follows this repo's existing `KBENGINE_*` style |
| 2 | Top-level `workspaceRoot` in the config file | Shipped commented out in the skeleton — uncomment to take over |
| 3 | Default | The first workspace folder |

Values go through variable substitution first; a value that expands to an empty string counts as unset and falls through to the next tier. The effective value, its source, and every overridden alternative are written into the skeleton comments and the `KBEngine 配置` output channel — no tier is picked silently.

## Auto-Discovery of Path Settings (batch 125)

Design constraint: **minimize settings; whatever can be auto-discovered, auto-discover**. The core features (open a `.def` → entity explorer/dependency graph/property panel/database schema/hover storage info) work in a clean workspace with zero configuration — all five path settings below degrade to "optional override": configured values are honored; unconfigured ones go through the discovery chain.

Discovery chain (first hit wins, in order):

1. **Explicit config**: the setting values of `kbengine.entityDefsPath` / `kbengine.entitiesXmlPath` / `kbengine.binPath` (`${workspaceFolder}` supported);
2. **Conventional paths**: fixed engine/official-asset layouts, e.g. `entity_defs`, `scripts/entity_defs`, `assets/scripts/entity_defs`, `server_assets/scripts/entity_defs`;
3. **Bounded deep scan**: when conventions all miss, scan the workspace for anchors (directory name `entity_defs`, file names `entities.xml`/`types.xml`/`messages_fixed.xml`/`messages_fixed_defaults.xml` (batch 129 dual names), engine source anchors `entitydef.cpp`/`entity_table_mysql.cpp`), bounded to depth 7 and 20k entries, pruning `node_modules`/`.git`/`out`/`dist`/dot-directories; results cached per workspace;
4. **Unique hit wins; multiple candidates never guessed**: synchronous read paths accept only a unique hit — with multiple candidates, nothing beats a guess (a guess would rewrite the whole set of interfaces/components/user_type root directories); instead, a quick pick pops **once** during activation for you to choose, the choice is remembered per workspace (`workspaceState`), and you are never asked again.

Sub-paths inferable from existing files never become settings: the def root derives `interfaces/`, `components/`, `user_type/` subdirectories; `types.xml` is preferred under the def root; `entities.xml` is preferred at the def root's parent; `messages_fixed(_defaults).xml` since batch 129 has four priority levels aligned with the engine loading order (kbemain.h:71-74, defaults load first as the base, the user copy loads after and overrides): workspace user copy `messages_fixed.xml` → engine source-root user copy → workspace `messages_fixed_defaults.xml` → engine source-root default; the user copy and the default each live in their own tree (engine comments kbemain.h:133-137: defaults in the engine res tree, the user copy in the assets tree), the four levels are taken independently with no same-directory requirement; an assets-only workspace having both or neither is normal, and having neither is marked informational in the discovery report, not a problem.

**Three kinds of purely discovered resources with no settings at all** (since batch 125): `types.xml`, `messages_fixed(_defaults).xml`, and the engine `kbengine_defaults.xml` (when binPath cannot derive it, fall back via the engine source-root anchor, then derive).

### Full Setting Comparison Table (batch-125 inventory of 32 items; more added continuously since batch 126, 74 today — the new ones are in the feature-area groups of "Overview of `kbengine.*` Settings (by Feature Area)" above)

`How it resolves now` = how the value is actually taken today; `Auto-discoverable` = whether the value can be derived from the workspace/environment; `Disposition` = this round's conclusion and reasoning.

| Setting | How it resolves now | Auto-discoverable | Disposition |
| --- | --- | --- | --- |
| `kbengine.entityDefsPath` | Explicit config → 4 conventional layouts → unique deep-scan hit → multi-candidate quick pick with memory | **Yes** (conventional layouts + deep scan) | **Auto-discover**; config serves only as override |
| `kbengine.entitiesXmlPath` | Same chain; additionally prefers the def root's parent directory | **Yes** | **Auto-discover**; config serves only as override |
| `kbengine.binPath` | Explicit config → engine source-root anchor derives `kbe/bin/server` → sibling-directory/environment-variable guessing | **Yes** (source-root anchors `entitydef.cpp`/`entity_table_mysql.cpp`) | **Auto-discover**; config serves only as override |
| `kbengine.generator.defOutputPath` | The default value itself uses the discovered def root (`resolveDefOutputPath`) | **Yes** (reuses def-root discovery) | **Auto-discover**; config serves only as override |
| `kbengine.generator.pythonOutputPath` | When the default `scripts` applies, derived from the discovered def root's parent; derived outside the workspace or empty segments keep the default | **Yes** (def root's parent) | **Auto-discover**; config serves only as override |
| `kbengine.assetsRoot` | Explicit config (default empty = auto-discover); since batch 128, when the original value fails the `res/server/kbengine.xml` probe it auto-discovers: convention chain (workspace root, `assets/`, `server_assets/`, and since batch 129 first-level `*_assets` directories like `flyff_assets`) → remembered choice → unique deep-scan hit; multi-candidate asks during activation | **Yes** (validated by the engine-loading probe, done in batch 128) | **Auto-discover**; config serves only as override; the probe's criterion = the engine's real loading location, eliminating the risk of a wrong guess failing to start |
| `kbengine.telnet.port` | Explicit >0 locks it; 0 = per the component section → engine defaults chain (batch 112) | **Yes** (config chain, done in batch 112) | **Auto-resolve**; config serves only as override |
| `kbengine.telnet.password` | Settings → component section → defaults → empty (batch 112) | **Yes** (same as above) | **Auto-resolve**; config serves only as override |
| `kbengine.telnet.configXmlPath` | Empty = auto-find `kbengine.xml` at 3 conventional locations | **Yes** (already override-style) | **Auto-discover**; config serves only as override |
| `kbengine.enableDiagnostics` | Switch, default on | No (user preference, not a discoverable fact) | **Keep**; default-on means zero-config usability |
| `kbengine.enableStructureDiagnostics` | Same as above | No | **Keep**, same reasoning |
| `kbengine.diagnostics.checkUnknownTypes` | Switch, default on | No | **Keep** (preference switch; the 5 fine-grained diagnostics likewise) |
| `kbengine.diagnostics.checkUnknownFlags` | Same as above | No | **Keep** |
| `kbengine.diagnostics.checkUnknownDetailLevels` | Same as above | No | **Keep** |
| `kbengine.diagnostics.checkDuplicateDefinitions` | Same as above | No | **Keep** |
| `kbengine.diagnostics.checkMissingPropertyFields` | Same as above | No | **Keep** |
| `kbengine.hover.showTagDocs` | Switch, default on | No | **Keep** (preference switch; the 3 fine-grained hovers likewise) |
| `kbengine.hover.showValueDocs` | Same as above | No | **Keep** |
| `kbengine.hover.showSymbolDocs` | Same as above | No | **Keep** |
| `kbengine.showFinalConfigOnOpen` | Switch, default on; silently skipped when defaults cannot be located | No | **Keep**; default-on is zero-disturbance |
| `kbengine.autoRefreshFinalConfig` | Switch, default on | No | **Keep** |
| `kbengine.autoStart` | Component name list, default `["machine","logger","dbmgr"]` | No (start strategy is a decision, not a fact) | **Keep**; the default is the official minimal runnable set |
| `kbengine.loggerPort` | Fixed 20022 (the engine logger listen port) | No (a runtime network port leaves no workspace trace) | **Keep**; the default = the engine default port |
| `kbengine.logAutoConnect` | Switch, default on | No | **Keep** |
| `kbengine.webviewConsoleLogs` | Switch, default on | No | **Keep** (page diagnostics should arrive without an extra step) |
| `kbengine.maxLogEntries` | Value 10000 | No | **Keep** (a memory/history trade-off preference) |
| `kbengine.debug.remoteTargets` | Empty list; remote machine + port | No (remote infrastructure does not exist in the workspace) | **Keep**; default empty = don't configure if unused |
| `kbengine.generator.generatePython` | Switch, default on | No | **Keep** |
| `kbengine.generator.registerInEntitiesXml` | Switch, default on | No | **Keep** |
| `kbengine.telnet.host` | Default `127.0.0.1` | No (entering a remote IP is user knowledge) | **Keep**; local default works out of the box |
| `kbengine.telnet.enableCommands` | Empty whitelist = only built-in read-only shortcuts are allowed | No (a security policy; the allowance scope is a decision) | **Keep**; deny-by-default is the security baseline and must not be guessed on the user's behalf |
| `kbengine.telnet.probeIntervalSeconds` | Value 5 | No | **Keep** (frequency preference) |
| `kbengine.httpRequests` | Default: one disabled example (`enabled: false`) | No (the user's business endpoints) | **Keep**; the example is disabled by default and has no side effects |

Counted: **all 32 kept, 0 deleted** (deleting entries would break existing user settings — not done); of them, 5 path settings were downgraded from "must configure" to "optional override", 3 telnet/value settings were already override-style, and 21 are preference/security/business switches (whose defaults carry zero-config semantics). Additionally, 3 kinds of purely discovered resources with **no settings** were added (types.xml, messages_fixed(_defaults).xml, and the engine defaults' source-root fallback). Since batch 126, 10 more settings were added beyond this table (`kbengine.db.tablePrefix`, 4 × `kbengine.hotReload.*`, `kbengine.clientSdk.outputDir`, `kbengine.python.extraPathsSync`/`stubExport`/`stubDir`, and `kbengine.python.enableMroJump`), all registered in the grouped overview tables above.

## FAQ

### Why didn't my settings change take effect immediately?

The extension watches `kbengine.*` configuration changes and normally applies them instantly. If not refreshed: confirm you changed the current workspace's or the user settings; confirm the currently open file is a `.def`; in extreme cases close and reopen the file.

### Which settings are most worth tuning first?

If hints feel too many, turn these four off first:

```json
{
  "kbengine.hover.showTagDocs": false,
  "kbengine.diagnostics.checkDuplicateDefinitions": false,
  "kbengine.diagnostics.checkUnknownDetailLevels": false,
  "kbengine.diagnostics.checkMissingPropertyFields": false
}
```

## Debugging Model Notes

KBEngine components are C++ processes with an embedded Python runtime — not something the extension launches as a Python script. Debugging is fixed at two steps:

1. First send the project's actual enable-debugging command to the component over telnet (telnet address/port/password confirmed along the three-layer chain in "How the telnet Port/Password Are Read")
2. Then attach to the process: local components via `Attach to Component` (process list, matches of the component name pinned with ✓); remote components via `Attach to Remote Component` (targets from `kbengine.debug.remoteTargets`, debugpy `connect` mode)

### Attach Error Troubleshooting

Check in this order:

1. Whether the target component has really enabled debugging over telnet (telnet parameters confirmed along the three-layer chain, unrelated to `.kbengine/debug.json`)
2. Whether the process picked in the list is the target component itself, not a machine/logger helper process
3. Whether `telnetEnableCommands` in `.kbengine/debug.json` matches the project's real command (affects the instructions only)
4. Whether `pathMappings` in `.kbengine/debug.json` maps to the current source directory (the remote connect mode writes no `pathMappings`)
5. Whether `ms-python.debugpy` is installed on this machine and VS Code can attach through it normally

The old `kbengine.pythonPath`, `kbengine.debugPort`, `kbengine.autoAttachDebug` have been removed; `kbengine.pythonDefsPath`, `kbengine.enablePythonNavigation` have also been removed (navigation goes through the `.def` definition system — see the entity explorer).
