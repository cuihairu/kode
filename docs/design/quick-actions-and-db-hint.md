# kode Quick Actions and Property → Database Design (six items ratified 2026-10-14 · seven decided-on-behalf 2026-10-15)

## Unified HTTP request sources

The HTTP tree and `kbengine.httpRequests.run` picker merge `.kbengine/debug.json` `httpRequests` with the VS Code `kbengine.httpRequests` setting. Rows identify their source and the group count is the combined total. Setting entries with `enabled: false` are hidden and cannot run. When names collide, the setting entry takes precedence and the debug.json duplicate is hidden. Both paths are dispatched by `HttpRequestService`; debug.json keeps its existing curl terminal executor so the real curl command remains visible.


> Status: **Quick actions: six items ratified, four decisions decided on the user's behalf (see 1.7); property → database: eight items ratified, 2.4 has three decided-on-behalf items (two SQL template questions + the MySQL access channel)**. The on-behalf decisions follow the user's 2026-10-14 authorization (pending decisions may be taken and marked as decided-on-behalf), all taking this document's "recommended" first option; **the user can overturn and roll back**, and the implementation adjusts to the post-overturn wording. Marketplace publishing is outside the on-behalf scope (red line; wait for the user to explicitly say "release" and give a version number). This document is the authoritative design wording; implementations must match it item by item, reuse this repo's existing vocabulary, and coin no new terms.
> Source: the user's 2026-10-14 multi-round statements, registered in `todo.md` (with source dates).

## Current State (verify before implementing; do not start a parallel version)

- **VSCode extension** (`.vsix`, `vscode:prepublish`)
- **31 commands** registered: including `kbengine.server.start/stop/restart/showLogs`, `kbengine.database.simulate/exportSimulation`, `kbengine.logs.connect/disconnect/clear/showViewer`
- **`src/debugConfig.ts`** exists: `KBEngineDebugConfig` / `ComponentDebugConfig` / `DebugConfigFile`
- **`src/databaseSchema.ts`** (block 19 database schema view) and **`src/databaseSimulator.ts`** exist
- 1 sidebar view + 2 `view/title` menu entries exist

---

# 1. Quick Actions

## 1.1 The Six Ratified Items

1. **Config-driven action registration** (plan A) — actions are defined by configuration, **not hardcoded into `contributes.commands`**; adding a new action **changes no code, no repackaging**
2. **The configuration travels with the KBEngine project**, not with the editor — actions are a KBEngine project property (carried by the project across people/machines). It lands in **the existing `kbengine_debug.json` configuration set** (already parsed by `debugConfig.ts`)
3. **Paths are never hardcoded** — everyone opens different directories; variable substitution must be supported (`${workspaceFolder}` / `${env:XXX}` etc.)
4. **Buttons must be able to appear on panels** — both the sidebar view title bar and the editor top-right (`editor/title`)
5. **First-install automatic `.bat` scan generates configuration** — useful right after installing, no hand-written configuration required
6. **The local script scope is settled**: basically just **server start/stop** and **config-table export**; the scan and the configuration model are designed for these two classes, **no generalization**

## 1.2 Execution Backends for the Three Action Types (unified model)

| Type | Execution | Existing base |
|---|---|---|
| `command` | invoke a VSCode command | server.start/stop/restart already exist |
| `script` | `child_process` runs a bat (start/stop / config export) | to be added |
| `http` | `fetch` hits HTTP (homegrown local hot update) | to be added |

KBEngine's own hot update → goes through `command` (can reuse the server group).

## 1.3 Two Explicitly Excluded Boundaries

- **Not carried by `launch.json`**: it only starts debug sessions; hot update/script running is not debugging — a semantic mismatch. `debugConfig.ts`'s parsing can be reused, but actions must not be shoved into the debug config types.
- **No "universal command execution"**: actions are **whitelist-style** (types fixed to `command`/`script`/`http`), no arbitrary shell — that would open an arbitrary execution entry inside the editor.

## 1.4 First-Install Automatic Scan (details are analysis recommendations, not ratified)

- The scan recognizes common naming for the **server start/stop / config export** classes; hits generate action items
- **Recommendation**: scan results **prompt the user to confirm before writing** the configuration file, to avoid polluting project files (not ratified; implement this way and document it)

Details (decided on behalf 2026-10-15 taking the "recommended" column; the user can overturn and roll back):

| Detail | Decided | Alternatives (not taken) |
|---|---|---|
| Scan scope | only one level of `.bat` under `${workspaceFolder}`, no recursion | recursion depth-limited to 2 (would scan into assets/ and the engine source tree, too noisy) |
| Recognition vocabulary | word lists: start/stop class `start/stop/restart/boot/server`, export class `export/convert/导表`; a hit is a candidate | list every bat for the user to check (no word list, too many candidates) |
| Dedup | key = "absolute path + category"; paths already registered in the config are not regenerated; one path hitting both classes yields one entry | dedup by action name (collisions) |
| Scan timing | once in the background on activation when the workspace is a KBEngine project; **only when the config has no actions yet**, pop a confirmation list (quick pick multi-select, written on confirm); after the user cancels, never auto-pop again for this workspace (memento memory) | prompt every activation (annoying) |
| Write form | into a new key of the same `kbengine_debug.json` config file (the actions array), each entry carrying a source annotation (scan-generated) | a separate actions config file (contradicts ratified #2 "reuse the existing config", not recommended) |

> **2026-10-16 user order (overrides the "Scan scope" and "Identification rule" rows of 1.4):** the scan collects `.bat` and `.ps1`, listing **all** of them at one level for confirmation; the start/stop / table-export vocabulary only **assigns a category** (hits get `server`/`export`, non-hits omit `category`) and no longer filters.

## 1.5 Variable Substitution and Scope (analysis-documented wording, effective together with the 1.7 #1-4 on-behalf decisions)

- **Supported set (recommendation)**: `${workspaceFolder}`, `${workspaceFolder:Name}`, `${env:XXX}` — the two families named by ratified #3, plus the multi-root qualified form. **Not supported**: `${config:}` / `${command:}` (couples actions into editor state, violating the "project property" positioning); editor variables like `${file}` / `${line}` also stay out of actions (actions are project-level, not selection-dependent).
- **Resolution timing (recommendation)**: resolve at execution time, not at scan/registration time — the same config opened on another machine still resolves per that session's workspace; this is how "paths never hardcoded" lands.
- **Scope (recommendation)**: `${workspaceFolder}` takes the root containing the KBEngine project (same source as the `kbengine.assetsRoot` discovery chain); with multiple roots holding multiple KBEngine projects, take the root of the active asset; if undecidable fall back to the first root with a notice.
- **Unknown variables (recommendation)**: validate before execution; an unknown variable or failed resolution → the action does not run, the error names the variable; **no silent empty-string substitution** — an empty string assembles a wrong path, and a script landing in the wrong directory is dangerous.

## 1.6 Error Handling and Log Destination (decided on behalf 2026-10-15 taking this section's wording; the user can overturn and roll back)

- **Destructive action confirmation (recommendation)**: hot-update/restart/stop classes add `confirm: true` in the action config to pop a confirmation carrying the action name and target (script path / HTTP address); **recommended default: pop**; actions generated by the first-install scan always carry confirm.
- **Unified log outlet**: a dedicated OUTPUT panel channel (named "KBEngine 快速执行动作", same form as "KBEngine HTTP 快捷请求"); each log line carries the action name, time, and result (exit code / HTTP status).
- **Failure presentation**: per-line OUTPUT logs + a one-time error popup (same "✗ mark + error popup" as HTTP requests); no new webview.
- **`script` backend**: the bat subprocess runs; stdout/stderr go into the log verbatim; a non-zero exit code is a failure, and the code is logged. Long-running server-start scripts **do not wait for exit** — marked "started" and the log moves on; the stop entry reuses the existing `kbengine.server.stop` command group.
- **`http` backend**: non-2xx is failure; the timeout cap is recommended at 10 seconds (a local hot update should not take longer), with the timeout reason stated.
- **`command` backend**: reuse the invoked command's own error path; the action layer adds no second wrapper (avoiding double prompts).
- **Log destination (recommendation)**: OUTPUT channel only, no log files — no new files polluting the project directory; copy the whole thing when archiving is needed (same form as the discovery report). Alternative: an opt-in switch writing `${workspaceFolder}/.kbengine/actions.log` (default off).

## 1.7 Decision Record (decided on behalf 2026-10-15; the user can overturn and roll back)

The following four items were "pending"; on 2026-10-15 the patrol took them per the user's 2026-10-14 authorization (pending designs may be decided and marked as on-behalf), all taking the "recommended" first options above. **The user can overturn and roll back**: after an overturn, change this table and the matching sections; implemented parts adjust to the post-overturn wording.

| # | Decision point | Decided |
|---|---|---|
| 1 | Scope and timing of the automatic scan | the 1.4 table's "Decided" column (one level of `.bat` / word lists / path+category dedup / prompt-confirm only when no actions exist / cancel remembered by memento, no more pops) |
| 2 | Whether scan results are written after confirmation | quick pick multi-select; written into the config only after the user checks entries |
| 3 | Whether destructive actions get confirmation | confirmation pops by default (carrying action name and target); first-install scanned actions always confirm |
| 4 | Output and log destination for action failures | dedicated OUTPUT channel + one-time error popup, no files |

## 1.8 Implementation · Data Structures (start after user confirmation)

The action config lands in the existing `.kbengine/debug.json` (ratified #2's config file), adding the top-level key `quickActions`; the `debug` section stays untouched:

```json
{
  "version": "1.0.0",
  "debug": { "…existing debug config, untouched…" : 0 },
  "quickActions": [
    { "name": "start_server", "type": "script",
      "script": "${workspaceFolder}/start_server.bat",
      "background": true, "confirm": true,
      "source": "scan", "category": "server" },
    { "name": "重启 baseapp", "type": "command",
      "command": "kbengine.server.restart", "args": ["baseapp"],
      "confirm": true, "source": "manual" },
    { "name": "本地热更", "type": "http",
      "url": "http://127.0.0.1:9000/reload", "method": "POST",
      "confirm": false, "source": "manual" }
  ]
}
```

Type definitions (`src/quickActionConfig.ts`):

```ts
export type QuickActionType = 'command' | 'script' | 'http';      // whitelist, ratified 1.3
export type QuickActionSource = 'scan' | 'manual';                // source annotation
export type QuickActionCategory = 'server' | 'export';            // scan recognition classes

export interface QuickActionConfig {
  name: string;              // display name, required
  type: QuickActionType;     // required; outside the whitelist the whole entry is dropped
  command?: string;          // required for type=command, a VS Code command id
  args?: unknown[];          // command args, passed through verbatim (string items support variables)
  script?: string;           // required for type=script, supports variables
  cwd?: string;              // script working directory, supports variables, defaults to the workspace root
  background?: boolean;      // script-only, default false; true = don't wait for exit (server-start class)
  url?: string;              // required for type=http, supports variables
  method?: 'GET' | 'POST';   // http-only, default POST
  body?: string;             // http-only
  confirm?: boolean;         // confirm before execution, default true (on-behalf #3, pop by default)
  source?: QuickActionSource;// default manual
  category?: QuickActionCategory; // written only for scan-generated entries
}
```

## 1.9 Implementation · Interfaces and Layout (start after user confirmation)

New files (three sources + three test files, all inside the affected-path gate):

| File | Responsibility | Key exports |
|---|---|---|
| `src/quickActionConfig.ts` | pure function layer: config parse/validation, variable substitution, word-list classification, scanned entry construction | `parseQuickActionConfigs(raw): { actions, invalidCount }`; `resolveActionVariables(text, folders): string` (unknown variables throw, named); `classifyBatchScript(fileName): QuickActionCategory \| null`; `buildScannedActions(candidates, workspaceRoot): QuickActionConfig[]` |
| `src/quickActionScanner.ts` | one-level `.bat` scan (inject `readDir` for testability; no direct disk API) | `scanBatchScripts(workspaceRoot, readDir): BatchScriptCandidate[]` (`{path, category}`, dedup key = absolute path + category) |
| `src/quickActions.ts` | `QuickActionManager`: the action-list quick pick, three-backend execution, confirmation box, OUTPUT channel, first-install scan write-back | class `QuickActionManager(context, deps?)`; methods `show()` / `run(action)` / `offerScanOnActivate()`; injected deps `deps.runScript` / `deps.runHttp` (defaults are the real `child_process.spawn` / `fetch`+10s timeout) |

Modified files:

| File | Change |
|---|---|
| `src/extension.ts` | register command `kbengine.quickActions.show` (callback `manager.show()`); `manager.offerScanOnActivate()` at the end of activation; dispose chain |
| `package.json` | `contributes.commands` adds `kbengine.quickActions.show` (`Run Quick Actions`, icon `$(run-all)` — the Servers view title bar already has `kbengine.server.start` holding `$(play)`; no duplicate icon in the same bar); `menus.view/title` mounts `view == kbengine.serverControl`; `menus.editor/title` mounts `editorLangId == kbengine-def \|\| python \|\| xml`; `activationEvents` adds `onCommand:` |
| `tests/extension.test.ts` | the assembly consistency assertions automatically include the new command (`contributes.commands` ↔ registration surface), no list change needed; the bare context given to assembly tests has no `workspaceState`, so memento absence is treated as "first run" (tolerated on the manager side — the first-install scan is only a prompt and must not break the activation chain) |
| `tests/quickActionConfig.test.ts` etc. | new (see 1.11) |
| `docs/guide/commands.md` `docs/guide/features.md` `docs/guide/configuration.md` | new command section (forced by the docs gate), the tool panel list, the `.kbengine/debug.json` `quickActions` key description and variable table |

The buttons land in two places (ratified #4): `view/title` (Servers view title bar) + `editor/title` (top-right of def/python/xml editors); the command itself is a single `show` that pops the action-list quick pick; action count and content are entirely config-driven (plan A: no per-action hardcoding into `contributes.commands`).

## 1.10 Implementation · Execution Flow (start after user confirmation)

`show()`: read config → no actions, info prompt (pointing at `.kbengine/debug.json`'s `quickActions` and the first-install scan) → actions exist, quick pick (label = name, description = type, detail = target) → on selection, `run()`.

`run(action)`:
1. Variable substitution (`script`/`cwd`/`url` and string items of `args`): unknown variable → error popup naming it, action not executed (1.5 rejects empty-string substitution)
2. `confirm !== false` (pop by default, on-behalf #3) → modal confirmation "执行 <名称>：<目标>?" — run "name: target" — with an "Execute" button; cancel aborts
3. Dispatch by type: `command` → `vscode.commands.executeCommand(command, ...args)`; `script` → the injected `runScript` (background=true does not wait for exit, marked "started"); `http` → the injected `runHttp` (non-2xx fails, 10s timeout)
4. Log lines go to the OUTPUT channel "KBEngine 快速执行动作": `[HH:mm:ss] 名称 → ✓ exit 0` / `✗ exit 3` / `✗ HTTP 500`; script stdout/stderr go into the channel verbatim
5. Failure → one-time error popup (action name + reason); the `command` backend reuses the invoked command's own errors, no second wrapper

`offerScanOnActivate()` (once per activation): no workspace → return; memento `kbengine.quickActions.scanDismissed` true → return; config already has actions → return; one-level `.bat` scan with zero hits → return; hits → quick pick multi-select confirm (label = bat name, description = class); empty/cancel → memento set true (no more auto-pops); checked → `buildScannedActions` (paths written in `${workspaceFolder}/x.bat` variable form; names containing `start/boot` → `background: true`; always `confirm: true`, `source: 'scan'`) → write back `.kbengine/debug.json` (preserving the `debug` section, JSON indent 2) → info notice of how many entries were written.

## 1.11 Implementation · Test Plan (tests before implementation)

| Test file | Coverage |
|---|---|
| `tests/quickActionConfig.test.ts` | parse validation (three legal types; illegal type / missing required fields / wrong field types drop whole entries and count); variable substitution (`${workspaceFolder}`, `${workspaceFolder:Name}` multi-root by name, `${env:XXX}`, unknown variables throw named, embedded mid-path); word-list classification (start/stop and export word hits, case-insensitive, miss → null); scanned entry construction (variable paths, start/boot→background, confirm/source/category annotations) |
| `tests/quickActionScanner.test.ts` | injected directory reads: one level of `.bat` collected, subdirectories and non-`.bat` ignored, same file hitting both classes yields one entry (start/stop wins), empty directory, path joining |
| `tests/quickActionManager.test.ts` | show (no-action prompt / quick pick cancel / select-and-run); run (success and failure arms of all three backends, background no-wait, confirm pops by default and false skips, confirm cancel, unknown-variable abort, failure into channel + error popup, stdout/stderr into channel); offerScanOnActivate (no workspace / cancel remembered / actions exist / zero hits / multi-select confirm writes preserving the debug section / cancel sets memento); dispose |
| `tests/extension.test.ts` | one line added to the command scan; `makeContext` memento |

Coverage keeps the repo gate 100%×4 (all three backends and file IO go through injection/in-memory fs; no unreachable defensive arms).

---

# 2. Property → Database

## 2.1 The Eight Ratified Items

1. **Hint on a property what field it is in the database**
2. Click-through to **the database table design virtually generated from the property**
3. **Quickly generate query statements**, convenient for running in **other MySQL clients**
4. **Hints must carry the table name**: give the full `db.table.column`, paste-ready, not just a column name
5. **Size limits must be read from source**: the type's size limits in the database are **read from KBEngine source**, not guessed
6. **Limits configured in XML show concrete values**: if a limit is configured in def/xml (e.g. a length cap), show that value, not just "there is a limit"
7. **ARRAY/container properties jump to the matching child table**: container properties are not in the main table; the hint explains where they went, and the jump lands on the right child table
8. **The MySQL connection is read straight from config**: connection details need no hand-filling — **read KBEngine's own configuration** (db host/port/account/name)

## 2.2 The Verification Loop (this design's key value)

```
def property ──derive──► virtual table structure ──compare──► real table structure (read MySQL)
                        │
                        └──► mismatch reported as drift
```

**The real table structure can reverse-check the virtual one**: since the connection can read it, take the real structures and check the def-derived virtual tables, **finding and reporting mismatches**.

This also covers the biggest risk — **if the property→field mapping is wrong** (which properties enter tables, type mapping, container splitting, column name conversion), it is exposed here instead of the user pasting broken SQL that finds nothing.

Side value: a missing real table = the entity has not gone through table creation yet; a table with no def = a leftover after a property was deleted.

## 2.3 Mapping Rules to Verify Before Implementing

| Rule | Notes |
|---|---|
| Which properties enter tables | not all properties persist; **the `Persistent` flag is the key** |
| Type mapping | def's `UINT8`/`STRING`/`ARRAY`/`PY` → MySQL column types |
| Container splitting | KBEngine usually creates **child tables** for arrays — the easiest place to hint wrong |
| Column name conversion | case, reserved words, special-character escaping |

**Requirement**: `src/databaseSchema.ts` and `src/databaseSimulator.ts` are the existing base — **first verify how much is reusable; do not start a parallel mapping rule set**.

## 2.4 Decision Record (decided on behalf 2026-10-15; the user can overturn and roll back)

- SQL template coverage: **add both JOIN (by parentID) and the Persistent-filtered column set** (the hint batch's minimal SELECT stays) — decided on behalf (patrol, 2026-10-15)
- Custom table prefix: **support an optional setting**, default empty = engine default `tbl_`; when set, SELECT/JOIN templates and schema-view table names substitute from the same source — decided on behalf (patrol, 2026-10-15)
- 2.2 drift-check MySQL access channel: **the mysql2 npm dependency** (no local mysql client required; touches package.json, run the full gate) — decided on behalf (patrol, 2026-10-15)

---

# 3. Telnet

## 3.1 Defect: the window cannot type after connecting

- Symptom: after telnet connects to KBEngine, **the window cannot accept input**
- Requirement: reproduce first and give the root cause with `file:line`. Prime suspects: input focus never lands on the session, the input box is not bound to that session, the PTY/stream never takes over input, the UI state machine never switches to the "connected" branch
- Hints: `kbengine.logs.connect/disconnect/clear` already exist; if telnet shares the same terminal machinery, **first check whether the input channel is taken over after a successful connection**; do not start a parallel terminal implementation
- After the fix, verify **under a real connection**: commands can be typed and echo back

## 3.2 Companion Requirement: exit shortcuts

- Support **`Ctrl+]`** (the standard telnet escape) and **`Ctrl+D`** to exit
- **Also give a top-level entry** (shortcut + top menu/button), not just the shortcut — the user needs to see and click it up top

---

# 4. Implementation Order and Batches (updated 2026-10-15: both telnet items delivered in b2394ba; the rest proceeds in this order)

1. **Quick actions** (1.8-1.11; the plan is on file, start after user confirmation)
2. **SQL template extension + custom prefix** (batch B sketch in 4.1)
3. **MySQL drift check** (batch C sketch in 4.2; touches package.json → full gate)

Each step follows this repo's gates: run tests over the change scope, all green before pushing; single commit, short English title, push after rebase, no tags.

## 4.1 Batch B Sketch · SQL Template Extension + Custom Prefix (decided on behalf; plan pending confirmation)

- `src/databaseSchema.ts`: next to the existing minimal SELECT template add two more — the **child-table JOIN** (main table `tbl_<Entity>` joined to child table `tbl_<Entity>_<Property>` by `parentID`, taking the child column set) and the **Persistent-filtered column set** (only columns of `Persistent=true` properties); the templates ship with the schema view rows and hover SQL together
- New optional setting `kbengine.db.tablePrefix` (string, default empty = engine default `tbl_`, source entity_table_mysql.cpp); when set, SELECT/JOIN templates and schema-view table names substitute from one source (one value function, not written twice)
- Tests: `tests/databaseSchema.test.ts` adds three groups — JOIN / filter / prefix (empty prefix = status-quo lock, set value = consistent substitution across all templates)
- Docs: `docs/guide/database-schema.md` (if that name exists; the actual file governs) and `docs/guide/configuration.md` document the setting and templates

## 4.2 Batch C Sketch · MySQL Drift Check (mysql2 decided on behalf; plan pending confirmation)

- Dependency: `package.json` adds `mysql2` (dependencies, pnpm install; touching the dependency list → run the full gate)
- New `src/databaseDrift.ts`: an injected query-executor interface (`runQuery(sql): Promise<{columns: …}>`), default implementation an mysql2 connection — connection details reuse the hint batch's engine-config reading (`<dbmgr><databaseInterfaces><default>`, dbmgr port 0→3306); testable without a real connection
- Comparison basis: virtual tables (reusing databaseSchema's derivation, no parallel mapping — the 2.3 iron rule) compared table by table against real `SHOW COLUMNS`: three drift classes — missing column / extra column / type mismatch; a table missing in the real DB = not created yet; table without def = leftover; the resulting report goes to the output panel + a schema view status line
- New command `kbengine.database.checkDrift` (title `Check Database Drift`); the docs/guide trio syncs
- Tests: `tests/databaseDrift.test.ts` (injected query executor: consistent / missing column / extra column / type mismatch / no table / leftover / connection failure reported honestly); `package.json` command-list consistency is locked by the existing docs gate

## 4.3 Commit Plan

- Batch A: one feat commit (source + tests + package.json + the docs gate trio) + one docs commit (todo reconciliation with hash + test counts)
- Batches B and C each isomorphic; batch C runs the full suite for touching the dependency list (vitest coverage + lint + docs:build + compile + mocha smoke)
- Marketplace publishing is not in this list (red line; wait for the user to explicitly say "release" and give a version number)
