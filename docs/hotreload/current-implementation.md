# Hot Reload — Current Implementation Audit (HR-PR-01)

- Fixed audit SHA: `36052c47cb26290b6829632c6c3ca31341161c96` (branch `v0.2`).
- Scope: HR-AUDIT-001..012, book `docs/kode2/KODE_2_COMPLETE_TODO.md` §19.2.
- Red lines honored: Watch/Hash/success-confirmation implementation degree is reported as evidence-backed facts or `unknown`; the `relaod` spelling in HTTP examples is preserved verbatim as compatibility input, never corrected.
- This PR changes no behavior. Audit only.

## 1. Fact table (verified against source at the SHA above)

### HR-AUDIT-001 — Anchors: package.json / README / old docs

| Item | Fact | Evidence |
| --- | --- | --- |
| Commands | `kbengine.httpRequests.run` (quick pick over merged list), `kbengine.httpRequest.run` (named, needs `args.name`) | `package.json` contributes.commands; `src/extension.ts:1135,1163` |
| Keybindings | None registered for the two HTTP commands (only display string `keybinding` per entry; real binding is manual via VS Code keybindings UI) | `package.json` keybindings (telnet only); `src/httpRequests.ts:36-41` |
| Views | No hot-reload view. `kbengine.quickActions` TreeView lists HTTP request entries as runnable nodes | `package.json` contributes.views; `src/quickActions.ts:507` |
| Config: `kbengine.httpRequests` | array; default = one **disabled** example `{"name":"热更新(示例)","url":"http://127.0.0.1:8000/api/hotfix?relaod=${module}","method":"GET"}` | `package.json` configuration default; `src/httpRequests.ts:45-53` (test-locked sync) |
| Config: `kbengine.hotReload.*` | `enabled=false`, `actionName=""`, `globs=["**/*.py"]`, `debounceMs=500` | `package.json`; `src/hotReload.ts:7-8` |
| README/docs | `README.md:174`, `README.zh.md`, `docs/guide/configuration.md` (HTTP Quick Requests section), `docs/zh/guide/configuration.md`, `docs/features.md:134` all document the settings list, the `${module}` package-boundary semantics, and the real-service shape `curl 'http://127.0.0.1:8000/api/hotfix?relaod=entities.fight.FightAI'` | files at fixed SHA |
| Old gap ledger | `docs/reference-feature-gap.md` G5 claims "automatic hot reload implemented (batch 136)" — that claim covers **watch→trigger a quick action** only, not the §19 state/confirmation model | `docs/reference-feature-gap.md:40,55` |

### HR-AUDIT-002 — rg sweep: all implementation and registration entry points

Sweeps run: `httpRequests|reload|hotfix|hotReload|watch|\.def|digest|md5|sha256|hash` over `src/`, `package.json`, README, `docs/`, `tests/` (node_modules excluded).

| Module | Role |
| --- | --- |
| `src/httpRequests.ts` | Pure logic: entry parsing, custom template vars, `${module}` resolver, request assembly |
| `src/httpRequestService.ts` | Settings-path executor: node http/https transport, OUTPUT panel流水, error popup |
| `src/quickActions.ts` | Second HTTP executor (`fetchHttp`/`terminalHttp`) for `.kbengine/debug.json` actions; dispatch `@http:debug|settings:<idx>`; curl command builder (tests only) |
| `src/quickActionConfig.ts` | debug.json/httpRequests parsing; `resolveActionVariables` (official variable table, throws on unresolved) |
| `src/quickActionTree.ts` | TreeView nodes for quick actions + HTTP requests |
| `src/variableSubstitution.ts` | Official VS Code variable family (single source of truth) |
| `src/hotReload.ts` | Auto hot reload: config gate, per-glob `FileSystemWatcher`, global debounce, runs quick action by name |
| `src/debugJsonSchema.ts` | Schema for `.kbengine/debug.json` incl. `httpRequests` and quick-action `type:"http"` |
| `src/debugConfigBootstrap.ts` | Generates `.kbengine/debug.json` template with commented `http` hot-update action example (`/hotfix`, POST) |
| Registration | `src/extension.ts:1113-1180` (channel + service + 2 commands), `:1591-1592` (settings entries injected into QuickActionManager), `:1624-1626` (`setupHotReload` → `quickActionManager.runByName(name, {suppressConfirm:true})`) |
| Engine-side metadata | `src/kbengineMetadata.ts:114-116` documents `KBEngine.reloadScript(fullReload)` (baseapp/cellapp only) — hover/snippet surface, no HTTP involved |

### HR-AUDIT-003 — Quick Request end-to-end trace (settings path)

1. User: `kbengine.httpRequests.run` → quick pick of merged entries (debug.json + settings, annotated by source) or `kbengine.httpRequest.run` with `args.name`.
2. Parse: `parseHttpRequestEntries` (`src/httpRequests.ts:62`) — bad entries skipped as-is, method uppercased, headers string-only.
3. Variables: `buildTemplateVars(editorContext, isPackageDir)` + `buildOfficialVariableContext` → `buildHttpRequest` single-pass substitution (custom placeholders first, then official table, unknown kept literal).
4. Transport: `defaultTransport` (`src/httpRequestService.ts:47-123`) — `URL` parse guard, http/https only, `req.setTimeout` 10s destroys request, receive window capped at `RESPONSE_PREVIEW_LIMIT*4` bytes (16 KiB).
5. Output: channel `KBEngine HTTP 快捷请求` — `▶ [name] METHOD URL`, then `✓ <status> · <ms>` + body preview (4000 chars, truncated marker), or `✗ …` + error popup. `result.ok` is true for **any** status the server returned (including non-2xx); status semantics are not classified.
6. Failure modes covered: URL unparseable, unsupported protocol, timeout, socket/DNS error (all resolve, never reject).

debug.json quick-action path diverges: `runHttpRequestFrom` resolves **official variables only** (unresolved → throw), then `terminalHttp` → `fetchHttp` → result logged to LogHub as `http:<name>` component, info if 2xx else error.

### HR-AUDIT-004 — `${module}` exact logic and all template variables

`resolvePythonModulePath` (`src/httpRequests.ts:122-141`):

- Splits the POSIX-normalized file path; stem = filename with trailing `.py` stripped via regex `/\.py$/i` (case-insensitive; `.PY` stripped; `.pyi`/`.pyc` **not** matched due to the `$` anchor).
- Walks from the file's directory upward; a directory counts as a package segment **only if** the injected probe says it contains `__init__.py`; first non-package directory stops the walk. Drive-letter segments cannot be packages.
- KBEngine role dirs (`base/`, `cell/`) have no `__init__.py` → module name = bare file stem. With real packages (`entities/`, `fight/` each containing `__init__.py`) → `entities.fight.FightAI`.
- No probe injected → module = file stem only.
- Case preserved everywhere. `__init__.py` gets stem `__init__` — **no special-case handling exists**.

Full variable inventory:

| Variable | Source | Semantics |
| --- | --- | --- |
| `${module}` | custom | package-boundary module path (above) |
| `${moduleBasename}` | custom | last `.` segment of `${module}` |
| `${filename}` | custom | file name incl. `.py` (renamed from `${file}` in batch 153) |
| `${line}` | custom | cursor line, 1-based |
| `${sel}` | custom | selected text |
| official family | `src/variableSubstitution.ts` | `${file}`=abs path, `${workspaceFolder}`, `${workspaceFolder:Name}`, `${fileBasename}`, `${fileBasenameNoExtension}`, `${fileDirname}`, `${fileExtname}`, `${relativeFile}`, `${relativeFileDirname}`, `${env:NAME}`, `${cwd}`, `${userHome}`, `${pathSeparator}` |
| unknown placeholders | — | kept literal, never emptied; values are **not URL-encoded** |

debug.json quick-action variables: official table only, unresolved → hard error (different failure semantics from settings path — both paths verified).

### HR-AUDIT-005 — File watchers: creation, purpose, lifecycle

| Location | Pattern | Purpose | Lifecycle |
| --- | --- | --- | --- |
| `src/hotReload.ts:162-193` | per `kbengine.hotReload.globs` (default `**/*.py`) | hot reload: 3-channel events (change/create/delete) → single global debounce trigger → run quick action by name | default **off** (no watcher created); `onDidChangeConfiguration('kbengine')` disposes+rebuilds; one composite disposable in `context.subscriptions` disposes watchers + timer + config listener |
| `src/extension.ts:491` | `**/*.{py,def,xml}` + external scan roots | Python class index invalidation | disposed via `context.subscriptions` array |
| `src/extension.ts:1395` | `**/kbengine*.xml` | final server config view refresh | `context.subscriptions` |
| `src/extension.ts:1720` | `**/<managedDir>`, `**/<managedDir>/**` | `.kbengine` asset regeneration | per-watcher `context.subscriptions` |
| `src/pythonTypeStubs.ts:602` | `**/types.xml` | stub re-export | `context.subscriptions` |
| `src/languageProviders.ts:4321` | `**/*.def`, `**/types.xml`, `**/entities.xml` | CodeLens invalidation | provider-level, disposed with subscription |
| `src/entityMapping.ts:829,859,898` | def/xml patterns | entity mapping caches | `context.subscriptions` |
| `src/workspaceIndex.ts:36` | `**/*.py` glob | workspace python index | explicit dispose |
| `src/debugConfig.ts:221` | config pattern | debug config regeneration | `this.configWatcher` disposed |

Additional facts: **no `onDidSaveTextDocument`/`onWillSaveTextDocument` usage anywhere** — save-triggered reload does not exist; `onDidChangeTextDocument` used once (`src/extension.ts:662`, call-chain view refresh, not hot reload). The hot-reload trigger is a **global single debounce** (not per-file) and does not dedupe by file, does not hash content, and fires the configured quick action regardless of which file changed.

### HR-AUDIT-006 — Existing HTTP capability inventory (avoid rebuilding)

| Capability | Settings path (`HttpRequestService`) | debug.json path (`fetchHttp`/`terminalHttp`) |
| --- | --- | --- |
| Methods | any, uppercased, default GET | any, default GET |
| URL/headers/body | templated (custom + official vars); headers sent | official vars only; **headers resolved but dropped — `HttpRunOptions` has no `headers` field, `fetchHttp` passes only `{method}`** (`src/quickActions.ts:75-79,217`) |
| Timeout | fixed 10s (`DEFAULT_HTTP_TIMEOUT_MS`), not configurable per entry | fixed 10s (`QUICK_ACTION_TIMEOUT_MS`) |
| Response cap | 16 KiB window / 4000-char preview | 4000-char window |
| Retry | none | none |
| Cancellation | none | none |
| SecretStorage | **zero `secrets`/SecretStorage usage in `src/`** (telnet password comes from settings, socket-only, never logged — separate feature) | none |
| Proxy/TLS options | none | none |
| Concurrency | unbounded, per-invocation | unbounded |
| Output | dedicated OUTPUT channel + error popup | LogHub entry + error popup |
| Non-2xx handling | reported as `ok:true` + status code (no classification) | info/error log level by 2xx |

A `buildCurlCommand` helper supporting headers exists (`src/quickActions.ts:178`) but is referenced only by tests — dead in the execution path.

### HR-AUDIT-007 — Hot reload history / status bar / decorations / retry

- No hot-reload history store, no request timeline, no failure retry anywhere in `src/`.
- Status bars: exactly two — telnet (`src/extension.ts:1593`) and running-server count (`src/extension.ts:2733`). No hot-reload status item.
- TreeView: `kbengine.quickActions` lists HTTP entries as static runnable nodes; no reload state, no decoration.
- Notifications: hot-reload path pops errors only; no success notification exists (nothing to silence).
- Conclusion: HR-STATE (§19.6) and HR-UI (§19.7) are **greenfield**; only the trigger plumbing and the two HTTP executors are reusable.

### HR-AUDIT-008 — `.def` Hash / Digest status

- Repo-wide `digest|md5|sha256|sha1|createHash|fingerprint` sweep: the only cryptographic hash is `src/logHub.ts:101` (sha256 of log text for dedupe fingerprinting). `src/defAnalyzer.ts`, `src/defParser.ts`, `src/semanticIndex.ts` contain **no hashing of any kind**.
- Three-layer model (fileHash / semanticHash / engineDigest): **none exists**. No file hash, no semantic fingerprint, no engine digest code.
- Engine-side evidence in repo: `KBENGINE_SOURCE_AUDIT_PLAN.md` §14 (source-verified) confirms `KBEngine.reloadScript(fullReload)` exists on baseapp/cellapp and that `KBEngine.reloadEntityDef()`/`isReload()` were **retracted** as non-existent public APIs. No engine Digest algorithm is documented anywhere in this repo.

### HR-AUDIT-009 — Server-side protocol evidence

- No server implementation ships in this repo. The only protocol evidence is the endpoint shape recorded from the user's real local service: `GET http://127.0.0.1:8000/api/hotfix?relaod=<module>` (README.md:174, docs/guide/configuration.md, builtin example, debug.json template comment shows a POST `/hotfix` variant on port 8080).
- `relaod` spelling: kept as-is everywhere per book rule; treated as compatibility input, not corrected pending server verification.
- Response JSON fields, target-process identification, applied-revision query: **unknown — no evidence in repo**.

### HR-AUDIT-010 — Real-project test record

- **Not performed** (no reachable engine/HTTP service from this audit environment). Status: `untested`.
- Existing automated coverage (scripted transports only, no real server): `tests/httpRequests.test.ts`, `tests/httpRequestService.test.ts`, `tests/httpRequestWiring.test.ts`, `tests/quickActionManager.test.ts`, `tests/hotReload.test.ts`, `tests/quickActionRunners.test.ts`.
- Required fixtures (HTTP 200-but-failed, server silent, module-name conflict, raw responses) remain to be captured per HR-AUDIT-010; blocked on a live service.

## 2. Facts vs Unknowns summary

| Area | Implemented (evidence above) | Unknown / Not implemented |
| --- | --- | --- |
| Manual HTTP quick request (settings + debug.json) | yes | per-entry timeout, retry, secret storage |
| Template vars incl. `${module}` | yes (package-boundary scan) | no `${reloadModule}`/`${fullModule}`/`${relativePath}`/`${targetId}` |
| Watch → trigger quick action | yes (gated off, global debounce) | per-file dedupe, hash, syntax gate, save-trigger, root scoping, stability wait |
| Success confirmation | **no** — `ok` means transport answered, 2xx not distinguished | accepted/applied semantics entirely unknown |
| Status/history/UI for reload | **no** | all of §19.6/§19.7 |
| `.def` file/semantic/engine hash | **no** | engine Digest algorithm |
| Server response contract | request shape only (user's real service) | response fields, applied revision, target/process, `relaod` param true spelling |

## 3. Keep / Wrap / Replace matrix (HR-AUDIT-011)

| Existing module | Verdict | Rationale / target |
| --- | --- | --- |
| `src/httpRequests.ts` entry parsing + template machinery | **Keep** (general Quick Requests) | generic feature must not regress (HR-HTTP-001); `${module}` audited here, mapping to new vars decided in HR-MOD-012 |
| `src/httpRequestService.ts` `HttpRequestService` + transport | **Wrap** | extract reusable `RequestExecutor` behind `HttpTransport` seam (already injectable); Hot Reload becomes a caller |
| `src/quickActions.ts` `fetchHttp`/`terminalHttp` | **Wrap** (fix header drop separately) | second executor; unify on one executor or keep as debug.json adapter |
| `src/variableSubstitution.ts` | **Keep** | single source of truth for official vars |
| `src/quickActionConfig.ts` `resolveActionVariables` | **Keep** for quick actions | throw-on-unresolved semantics intentional |
| `src/hotReload.ts` watcher + debounce | **Replace** (progressively, HR-WATCH) | global debounce/per-glob model superseded by per-file pipeline; keep gate-off default and config-rebuild lifecycle pattern |
| `resolvePythonModulePath` | **Replace** in hot-reload path by pure `ModuleResolver` (HR-MOD-002) | stays for legacy `${module}` compat |
| quickActions TreeView HTTP nodes | **Keep** | hot-reload UI is new surface, not a fork of this tree |
| `buildCurlCommand` | **Keep or delete** | currently test-only |

## 4. Reuse module paths and owners (HR-AUDIT-012)

| Reuse target | Exact path | Key exports | Owner |
| --- | --- | --- | --- |
| Entry parsing / templates | `src/httpRequests.ts` | `parseHttpRequestEntries`, `buildTemplateVars`, `applyTemplateWithContext`, `buildHttpRequest`, `resolvePythonModulePath`, `BUILTIN_HTTP_REQUEST_EXAMPLE` | cuihairu (sole author per git log) |
| HTTP transport / execution | `src/httpRequestService.ts` | `HttpRequestService`, `HttpTransport`, `defaultTransport`, `DEFAULT_HTTP_TIMEOUT_MS` | cuihairu |
| debug.json HTTP path | `src/quickActions.ts` | `fetchHttp`, `terminalHttp`, `QuickActionManager.runHttpRequestFrom`, `runByName` | cuihairu |
| Official variable table | `src/variableSubstitution.ts` | `resolveVariableExpression`, `VariableContext` | cuihairu |
| Watcher lifecycle pattern | `src/hotReload.ts` | `setupHotReload`, `HotReloadTrigger`, `readHotReloadSettings` | cuihairu |
| Config schema surfaces | `package.json` (`kbengine.httpRequests`, `kbengine.hotReload.*`), `src/debugJsonSchema.ts` | — | cuihairu |
| Engine-side API metadata | `src/kbengineMetadata.ts` (`KBEngine.reloadScript`), `KBENGINE_SOURCE_AUDIT_PLAN.md` §14 | — | cuihairu |

Items without source evidence above are recorded as `unknown`: server response contract, engine Digest algorithm, applied-revision queryability, `relaod` server-side truth, all real-project behaviors (HR-AUDIT-010 untested).
