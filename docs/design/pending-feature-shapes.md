# Design-First Item Shape Surveys (2026-11-05)

> Scope: the five todo.md items marked "prerequisite: none (survey first) /
> shape pending survey". This document is a **shape survey**; it fixes each
> feature's shape only (architecture / data surface / control surface /
> boundary) and **implements no code**. All paths are real paths; the
> "proposed shapes" are proposals whose acceptance is still finalized per
> item before implementation.

Survey subjects (todo.md line / priority):

| Item | Line | Priority | One-liner |
|---|---|---|---|
| IDE-BOT-001 | 801 | P1 | KBEngine bot framework support and multi-machine management |
| IDE-PROP-001 | 802 | P2 | Visualizing properties loaded before `__init__` |
| IDE-DB-001 | 803 | P2 | Database type/size limit hints for persisted fields |
| IDE-I18N-002 | 804 | P2 | Configurable hover language |
| IDE-PYSPY-001 | 805 | P2 | py-spy flamegraph integration and periodic collection |

---

## 1. IDE-PROP-001 Visualizing properties loaded before `__init__`

**Acceptance original text**: a one-line CodeLens at the entity class
definition/`__init__` reading "properties loaded before `__init__` · from
Entity.def" (the same surface as the existing `PropertyCodeLensProvider`, an
independent switch); F12 on `self.hp` inside `__init__` can already navigate
(`provideDefinitionTraced` four-tier anchors: class definition line →
`__init__` line → first class line → script first line — the engine loads
properties before `__init__`, so it locates even without a same-name
assignment); confirm no regression; docs in sync.

### Current state (implemented surfaces)

- **Semantic comment** ("properties loaded before `__init__`"):
  `src/languageProviders.ts:3697-3720`.
- **Four-tier property navigation anchors** (F12 implemented; this pass only
  confirms no regression):
  - `findPropertyScriptLocationInDef` `src/languageProviders.ts:3703` —
    collects candidate scripts from the `.def` along the engine's loading
    chain (this def's role script → the interfaces def's `scripts/interfaces/`
    → each level's role script along the `<Parent>` chain), finding the
    landing point per script.
  - `resolvePropertyLandingLine` `src/languageProviders.ts:3722` — four
    tiers: the class definition line matching the def name → the `__init__`
    line → the first class line (when the class name differs from the def) →
    the script's first line.
  - Wiring point `src/languageProviders.ts:3113`
    (`propertyScriptLocation = findPropertyScriptLocationInDef(document)`).
- **Existing CodeLens surface**:
  - `PropertyCodeLensProvider` `src/languageProviders.ts:5475` — shows up on
    `self.<property>` access sites, resolving to the def definition via
    `entityMappingManager.resolvePropertyDefinitionInfo`, clicking goes
    through `kbengine.source.reveal`. Controlled by the independent switch
    `kbengine.codeLens.property` (default true).
  - Switch reading: `src/languageProviders.ts:312`
    `config.get<boolean>('codeLens.property', true)`.
  - Registration: `src/extension.ts:1172-1177` (`registerCodeLensProvider`
    hung on Python documents), `fireConfigurationChanged`
    `src/extension.ts:2128` (refresh on config change).
  - Config schema: `package.json:1155` `kbengine.codeLens.property`
    (boolean, default true).

### Proposed shape

- **New switch**: `kbengine.codeLens.propertyPreInit` (boolean, default
  true), schema mirroring `package.json:1155`; reading added next to
  `src/languageProviders.ts:312`
  (`config.get<boolean>('codeLens.propertyPreInit', true)`).
- **New CodeLens surface**: extend the existing `PropertyCodeLensProvider`
  (or add a lightweight provider in the same file); when the document is a
  KBEngine entity script, emit a one-line CodeLens at the landing point
  returned by `resolvePropertyLandingLine` (class definition line/`__init__`
  line), titled `Properties loaded before __init__ · from Entity.def`. This
  line differs from the existing per-access lens: it is a **class-level
  semantic note** not bound to a specific `self.<property>` access; the
  suggested click behavior is `kbengine.source.reveal` locating the def's
  `<Properties>` section (or `none`, a pure note).
- **Entity-script detection**: reuse `findPropertyScriptLocationInDef`'s
  candidate chain (`collectPropertyCandidateScripts`) or a reverse lookup
  (script basename matching a workspace def of the same name). The CodeLens
  appears only when `resolvePropertyLandingLine` is non-empty.
- **No-regression confirmation**: `provideDefinitionTraced`
  (`src/languageProviders.ts:4514`) untouched; acceptance adds one existing
  case regression assertion for F12 on `self.hp` inside `__init__`.
- **Boundary**: no touching existing registrations in
  `src/dependencyGraph.ts` / `extension.ts`; only one switch + one CodeLens
  generation site. `EntityMappingManager` reused, no new parsing surface.

---

## 2. IDE-I18N-002 Configurable hover language

**Acceptance original text**: hover copy language configurable (default
English, selectable zh/Chinese); defaults to Chinese when a Chinese system
or the UTC+8 timezone is detected; configuration generated at install
(settings default values); existing English hovers do not regress; shape
pending survey (reuse the `vscode.l10n` mechanism or a standalone
configuration item).

### Current state

- **I18N-001 done** (655494a): quick-fix titles go through `vscode.l10n` +
  the `l10n/` directory, English by default, Chinese in Chinese
  environments. `package.json:145` `"l10n": "./l10n"`;
  `l10n/bundle.l10n.json` (English) + `l10n/bundle.l10n.zh-cn.json`
  (Chinese).
- **l10n usage**: `src/quickActions.ts:58` `vscode.l10n.t(...)` etc.;
  `src/languageProviders.ts` has 7 `l10n.t(` sites but **~99 hover-related
  references are still basically hard-coded English** — the vast majority of
  hover copy is not internationalized.
- **The limits of vscode.l10n**: `vscode.l10n.t()` picks strings from
  VS Code's current UI language (`vscode.env.language`) automatically and
  **cannot be overridden by extension configuration**. So "configurable
  hover language" cannot be done by `vscode.l10n` alone — a standalone
  configuration item is needed.

### Proposed shape

- **Standalone configuration item**: `kbengine.hover.language`
  (`'auto' | 'en' | 'zh'`, default `'auto'`). Declaration follows
  `package.json`'s `contributes.configuration`; the default value is the
  "settings default" — nothing is written into settings.json at install
  (the package.json default already satisfies the "settings default"
  semantics, visible and changeable in the settings UI).
- **Resolver**: `resolveHoverLocale(config, env)`:
  - `'en'` → en; `'zh'` → zh;
  - `'auto'` (default) → `vscode.env.language` starting with `zh` **or**
    `new Date().getTimezoneOffset() === -480` (UTC+8) → zh, otherwise en.
- **Copy surface**: a new hover copy table
  `hoverTexts: Record<key, { en: string; zh: string }>` with
  `hoverText(key)` reading per the resolved language; **unmigrated keys fall
  back to English** (`en` always has a value) → existing English hovers do
  not regress.
- **Migration scope**: the **user-visible hover markdown strings** (not
  internal function names) of `src/languageProviders.ts` migrate one by one
  into `hoverTexts`, incrementally; after each batch, the existing `l10n.t`
  (quick fixes) is untouched.
- **Detection surface**: `zh` system detection uses `vscode.env.language`
  (the VS Code UI language) + `Intl`/`process.env.LANG` as backstop; UTC+8
  uses `getTimezoneOffset()`. Pure functions for easy unit testing.

---

## 3. IDE-PYSPY-001 py-spy flamegraph integration and periodic collection

**Acceptance original text**: `py-spy record --format flamegraph` produces a
flamegraph (the existing py-spy dump surface is already integrated); support
timed/periodic collection (e.g. X samples every N seconds); foolproof usage
(default parameters / one-click collection); UI needs separate design
(collection configuration + graph display).

### Current state

- **Existing dump surface**: `src/pyspyDump.ts` (IDE-PDBG-003) —
  `py-spy dump` writes the target component process's call stack into the
  output channel; includes pip auto-install (installs per interpreter when
  py-spy is missing locally, honest reporting on failure), ptrace permission
  guidance (`kernel.yama.ptrace_scope`=1 needs ptrace_scope=0 or sudo/cap,
  containers `--cap-add=SYS_PTRACE`), spawn-timeout group kill
  (`killProcessTree`), the `SpawnRunner` injection surface
  (`defaultSpawnRunner`).
- **Remote surface (concurrent sessions IDE-PDBG-004/005 in flight)**:
  `src/remoteConnection.ts:60` (py-spy probe/install/dump over ssh on the
  remote), `src/sshConfig.ts` (ssh config parsing), `src/remoteServerTree.ts`
  (local/remote target dispatch), `src/remoteProcessList.ts:13` (reuses
  `defaultSpawnRunner`). **PYSPY-001's remote part should reuse this
  surface, not rebuild it**.
- **Existing webview patterns**: `src/runtimeQueryWebView.ts`,
  `src/monitoringWebView.ts` etc. — `randomNonce` from `webviewSecurity`,
  JSON-safe shapes across the boundary (bigint conversions etc.), the
  `postMessage` protocol.
- **No existing py-spy record references**: the repo has no
  `record`/`flamegraph`/`--duration`/`--rate` references — a brand-new
  surface. `py-spy` was not on PATH locally at survey time; the record
  invocation follows the standard CLI
  `py-spy record --format flamegraph --output <file> --pid <pid> --duration <sec> --rate <hz>`;
  **the implementation must verify flags against the installed version**
  (`--format` values `flamegraph|raw|speedscope`, `--native` optional).

### Proposed shape

- **Data/control surface**: `src/pyspyRecord.ts` (new, following
  `pyspyDump.ts`'s structure) — `pySpyRecord({ pid, outputPath, durationSec,
  rateHz })` builds the `record` command; reuses `defaultSpawnRunner`/
  `SpawnRunner` injection and ptrace permission guidance; `--format
  flamegraph` outputs SVG.
- **Periodic collection**:
  `collectFlamegraph({ pid, durationSec, rateHz, intervalSec, count })` —
  runs `count` records, each `durationSec` seconds, `intervalSec` seconds
  apart; results land one by one in `docs/../py-spy/` or a temp directory;
  cancellable (reusing cancel tokens).
- **Foolproof defaults**: duration 5s, rate 99Hz, interval 30s, count 3
  (proposal; finalized at acceptance).
- **UI**: a new webview `flamegraphWebView.ts` (following the
  `runtimeQueryWebView` pattern) — a collection configuration form (pid
  reusing the existing component picker, duration/rate/interval/count) +
  flamegraph SVG display (SVG embedded in the webview or opened in a
  browser); one-click collection.
- **Boundary**: after remote dispatch (IDE-PDBG-004/005 in flight) lands,
  `pySpyRecord` runs remotely via `remoteConnection`'s py-spy dispatch
  surface; **this item's implementation must wait for the concurrent
  sessions' remote surface to merge before wiring**, local surface first.
- **Risk**: `py-spy record`'s SVG generation depends on the py-spy version;
  periodic collection's process lifecycle (group kill per sample) must reuse
  `killProcessTree` to prevent residue.

---

## 4. IDE-BOT-001 KBEngine bot framework support and multi-machine management

**Acceptance original text**: analyze kbe's bundled bot framework
(`kbe/src/lib/bot` and bot scripts/entities, the `createBot` interface) for
support options; manage bots (create/start-stop/state/count); coordinate
bots across multiple machines (remote orchestration/aggregation); shape
pending survey (whether to use Rust core orchestration + a TS management
UI).

### Current state (engine-side source evidence, `/home/cui/workspaces/kbengine/kbe/`)

- **bots is a standalone executable tool**: `src/server/tools/bots/` (build
  artifact: the `bots` binary), not lib/bot. Entry `main.cpp:59-63`
  (`g_componentType = BOTS_TYPE` → `kbeMainT<Bots>`).
- **The process = one bot pool**: `Bots : ClientApp` (`bots.h:40`) holds
  `CLIENTS clients_` (`bots.h:103-104`, `map<Channel*, ClientObject*>`);
  each bot = `ClientObject : ClientObjectBase` (`clientobject.h:20`), a
  standard client_lib client (TCP/KCP transceivers; the loginapp→baseapp
  handshake chain at `clientobject.cpp:132-411`,
  `clientobjectbase.cpp:604-652`).
- **Lifecycle**: 7 states
  `C_STATE_INIT/CREATE/LOGIN/LOGIN_BASEAPP_CREATE/LOGIN_BASEAPP/PLAY/DESTROYED`
  (`clientobject.h:37-46`), transitions in `ClientObject::gameTick()`
  (`clientobject.cpp:446-498`).
- **The "createBot" equivalent entry (no literal createBot)**: count-driven —
  - RPC `Bots::addBots` (`bots.cpp:321-341`, `bots_interface.h:48`) and
    Python `KBEngine.addBots()` (`bots.cpp:344-389`) only accumulate
    `reqCreateAndLoginTotalCount_/TickCount_/TickTime_`;
  - actual instantiation is in `CreateAndLoginHandler::handleTimeout`
    (`create_and_login_handler.cpp:37-62`), incrementing by `tickCount` per
    tick and rate-limited by `tickTime`,
    `new ClientObject(prefix+cid+"_"+accountID++, ...)`
    (`create_and_login_handler.cpp:56-60`).
- **Configuration**: `bots` has no XML of its own; configuration comes from
  `res/server/kbengine_defaults.xml`'s `<bots>` section (**lines 833-902**,
  `entryScriptFile=kbemain`, `host=localhost`, `port_min=20013`,
  `defaultAddBots` `totalCount=10/tickTime=0.1/tickCount=5`,
  `account_infos.account_name_prefix=bot_`, `telnet_service.port=51000`,
  etc.) + `kbengine.xml` overrides. CLI only `--cid`/`--gus`
  (`kbemain.h:147-204`).
- **Python-driven**: C++ drives connection/state machine, Python drives game
  logic — entry `scripts/bots/kbemain.py` (imported at `bots.cpp:174-239`),
  entity `Account.py` (`class Account(KBEngine.Entity)`, SDK template at
  `res/sdk_templates/server/python_assets/scripts/bots/`). The global `bots`
  (PyBots) supports `len/keys/values/items` (`pybots.cpp:56-172`).
- **Multi-machine coordination (feasible; no built-in master/slave)**:
  cluster primitives already exist — `tools/server/pycommon/Machines.py`
  `startServer/stopServer/killServer` (239-286, UDP broadcast to kbemachine
  20086), `queryAllInterfaces` (211)/`queryMachines` (225);
  `src/server/machine/machine_interface.h:95-107`;
  `tools/server/pycluster/cluster_controller.py:48` (bots included in the
  component enumeration); the official guiconsole already controls bots via
  `BotsInterface::onExecScriptCommand`/`queryWatcher`/`lookApp`
  (guiconsoleDlg.cpp:601,1206).
- **Control surface (ready-made RPCs, no engine changes needed)**:
  `BotsInterface` — `onExecScriptCommand` (arbitrary Python execution,
  `bots_interface.h:40`, `bots.cpp:467-497`), `addBots` (:48),
  `queryWatcher` (:51), `lookApp` (:34), `startProfile` (:54),
  `reqCloseServer/reqKillServer` (`bots.cpp:430-464`); plus a TelnetServer
  REPL (port 51000).

### Proposed shape

- **Process orchestration (control-surface lifecycle, multi-machine)**:
  reuse `Machines.py`'s `startServer/stopServer/killServer`
  (`componentType=BOTS_TYPE`, one `cid` per machine doubling as the account
  suffix, `targetIP=that machine's kbemachine`) to raise/stop `bots`
  processes; kode wraps `tools/server/pycommon/` (the kbemachine UDP
  protocol and component discovery are already included).
- **In-process bot counts**: reuse `BotsInterface::addBots` /
  `KBEngine.addBots(total, tickCount, tickTime)`.
- **Runtime remote control**: `onExecScriptCommand` (the most general;
  per-bot/global Python) + `queryWatcher`.
- **Data surface (state/count)**: the engine has no structured JSON API —
  kode sends probes via `onExecScriptCommand` (`len(KBEngine.bots)`,
  `[(b.appID(), b.state) for b in KBEngine.bots]`) + aggregates via
  `queryWatcher`; the panel renders "bot count / per-machine summary".
- **Shape recommendation**: **a TS management UI (bot management panel) as
  the main form**; engine-side `Machines.py`/`BotsInterface` already suffice
  for create/start-stop/state/count/multi-machine raising — **no Rust core
  orchestration needed, no engine fork needed** (fine-grained "independent
  start/stop per bot" would need engine extensions to ClientObject
  stop/destroy RPC — out of first-phase scope).
- **Dependencies**: engine source path (`kbengine/`, KBENGINE_ROOT unset —
  the implementation must allow configuring the engine root); `Machines.py`
  depends on `kbe_res_path/kbe_bin_path` parameters.

---

## 5. IDE-DB-001 Database type/size limit hints for persisted fields

**Acceptance original text**: hint the database type/length/limit for
def/types.xml persisted fields (shape pending survey).

### Current state

- **The engine's authoritative mapping** (the only mapping table in this
  source tree): `EntityTableMysql::createItem()`
  (`kbengine/kbe/src/lib/db_mysql/entity_table_mysql.cpp:505-763`), producing
  column DDL per `DataType::getName()`:
  - INT8→tinyint / INT16→smallint / INT32→int / INT64→bigint; UINT8..UINT64
    the same +`unsigned`; FLOAT→float / DOUBLE→double; STRING/UNICODE→
    `varchar(@DATALEN@)`; PYTHON/PY_DICT/PY_TUPLE/PY_LIST/BLOB→blob.
  - VECTOR2/3/4→2/3/4 `float` (`int` under `CLIENT_NO_FLOAT`) columns,
    named `sm_<i>_<item>`.
  - ARRAY→no parent-table column; a child table `tbl_<entity>_<prop>` is
    created (element column `value`).
  - FIXED_DICT→no parent-table column; expanded to one column per persisted
    key (key names accumulate an FD prefix level by level).
  - ENTITY_COMPONENT→child table; ENTITYCALL→`syncToDB` no-op, **no column
    created**.
  - ⚠ `property_mapping.cpp:231-304` mentioned in docs **does not exist** in
    this source tree (find returns nothing) — a stale documentation
    reference, **not usable as a replication basis**.
- **DatabaseLength semantics**: undeclared=0 (`entitydef.cpp:1114`/
  `datatype.cpp:2077`); at table creation STRING/UNICODE
  `if (length<=0) length=255` (`entity_table_mysql.cpp:1829-1833`/
  `1899-1903`); numeric types with length≤0 drop the `(@DATALEN@)` display
  width (:1643-1655). FIXED_DICT keys persist by default
  (`datatype.cpp:2065-2081`).
- **No hard-coded limit**: the engine has no VARCHAR/BLOB hard limit;
  `SYSTEM_CHARSET_MBMAXLEN=3` (`db_interface_mysql.h:16-18`) is only for
  length comparison of "already existing columns", not a table-creation
  constraint. The practical limit is MySQL's 65,535-byte row: default
  charset utf8mb4 (`kbengine_defaults.xml:368`, code fallback utf8
  `serverconfig.cpp:1125-1129`) → a single VARCHAR column ≈ 16,383
  characters (utf8mb4) / 21,845 (utf8).
- **kode's existing surface** (IDE-RUST-008 delivered):
  `crates/kode-server/src/database_schema.rs`'s `resolveDbTypeLabel`/
  `resolveEffectiveDatabaseLength` (Rust authoritative); TS side
  `src/databaseSchemaCore.ts`: `SIMPLE_DB_TYPE_LABELS`(:182-201) already
  covers scalar/string/blob/ENTITYCALL, `resolveDbTypeLabel`(:1398)/
  `resolveEffectiveDatabaseLength`(:1403)/`expandColumnNames`(:1365) already
  replicate VECTOR `sm_N_` and the FD prefix correctly.
- **Gaps**:
  1. `SIMPLE_DB_TYPE_LABELS` lacks VECTOR2/3/4, ARRAY, FIXED_DICT,
     ENTITY_COMPONENT → `resolveDbTypeLabel` falls back to the lowercased
     original name (e.g. "vector2"), mismatching the engine's actual
     behavior.
  2. ENTITYCALL is labeled 'blob' in TS, but the engine's `syncToDB` no-op
     **creates no column** — a misleading annotation.
  3. No UI surface shows any of this (no CodeLens/hover/diagnostic hint).

### Proposed shape

- **Hint carrier**: Hover/CodeLens (informational) as the main form, hung on
  def/types.xml persisted fields or `<DatabaseLength>` nodes, showing
  "effective type · VARCHAR(N) · charset · default/limit". Since omitting
  DatabaseLength is legal, the hint is **informational**, not a warning.
- **Diagnostics (error level)**: only when an explicit `DatabaseLength > the
  limit` (converted per the configured charset's byte width) or a restricted
  type is illegal.
- **Mapping data surface**: prefer reusing Rust's
  `resolveDbTypeLabel`/`resolveEffectiveDatabaseLength`; fill
  `SIMPLE_DB_TYPE_LABELS`'s gaps (VECTOR2/3/4→multiple float columns,
  ARRAY/FIXED_DICT/ENTITY_COMPONENT→"child table/expansion",
  ENTITYCALL→"no column").
- **Charset**: take kode's configuration (default utf8mb4, aligned with the
  engine default); the hint notes the engine's internal `/3` comparison
  (`entity_table_mysql.cpp:42-43`) as a potential inconsistency.
- **Numeric types**: undeclared → no display width `int`; declared N →
  `int(N)` (:1643-1655).

### Dependencies

- Engine source path (`kbengine/`, KBENGINE_ROOT unset — the implementation
  must allow configuring the engine root); `entity_table_mysql.cpp`'s
  authoritative mapping table (:505-763); charset config
  `kbengine_defaults.xml:368`.
