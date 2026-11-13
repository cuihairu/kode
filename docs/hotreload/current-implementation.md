> 2026-11-13 refresh (HR-PR-01 re-execution): audited at HEAD `6934c63a` (main). The 2026-11-11 audit (SHA `36052c47`) is superseded — the hot-reload surface grew from ~5 modules to 30+ (state machine, receipts, retry, channels, UI cluster). Receiver-side implementation record (demo loopback + Python 3.7.3 xreload): [demo-hot-reload design](../design/demo-hot-reload.md).

# Hot Reload — Current Implementation Audit (HR-PR-01)

- Fixed audit SHA: `6934c63abd9b21afaff51a135d69535ea167f069` (branch `main`).
- Scope: HR-AUDIT-001..012, book `docs/kode2/KODE_2_COMPLETE_TODO.md` §19.2.
- Red lines honored: Watch/Hash/success-confirmation degree reported as evidence-backed facts or `unknown`; nothing below claims more than the code does.
- Standing endpoint/parameter contract (2026-11-06 user order): quick-request example carries `module_name=<module>` in both query and body; the repo-wide spelling gate stays (`tests/hotfixSpellingGate.test.ts`).
- This PR changes no behavior. Audit only.

## 1. Fact table (verified against source at the SHA above)

### HR-AUDIT-001 — Anchors: package.json / README / docs

| Item | Fact | Evidence |
| --- | --- | --- |
| Commands | 12 `kbengine.hotReload.*` commands: `tempEdit.run`, `showLog`, `toggle`, `showBatchSummary`, `retryFailed`, `showRevisionEvidence`, `filterByState`, `showFileState`, `configureChannel`, `switchChannel`, `confirmDefBaseline`, `materializeGlobs`; plus legacy `kbengine.httpRequests.run` / `kbengine.httpRequest.run` | `package.json:846-968` (hotReload block), `:1042-1045` (mcp toggle, non-HR); registrations `src/activate/hotReload.ts` (table in §4) |
| Activation events | All 12 hotReload commands have matching `onCommand:` events (programmatic cross-check: zero missing) | `package.json:36-37,161-176` |
| Keybindings | None registered for hot reload | `package.json` keybindings (telnet only) |
| Views | No hot-reload TreeView/webview. State surfaces instead: global FileDecorationProvider + CodeLens + OUTPUT channel ledger | `src/activate/hotReload.ts:582,592`; `src/hotReloadStatus.ts:21` |
| Config: `kbengine.hotReload.*` | `enabled=true` (default on), `actionName=""`, `globs=null` (unset → derived from `kbengine.assetsRoot`, `src/hotReload.ts:83-95`), `debounceMs=500`, `tempEdit.enabled=false`, `tempEdit.actionName=""`, `tempEdit.autoRestore=true`, `tempEdit.scriptRoot=""` | `package.json:2058-2098` |
| Config: channel/profile | No `kbengine.hotReload.channel` key — channel lives in the deployment-profile store (`workspaceState`), surfaced via `configureChannel`/`switchChannel` | `src/projectProfiles.ts:31,170`; `src/backend/hotReloadChannelConfig.ts:349-425` |
| Config: `kbengine.httpRequests` | array; default = one **disabled** example `POST http://127.0.0.1:8090/hotfix?module_name=${module}` body `module_name=${module}` | `src/backend/httpRequests.ts:53-61` (`BUILTIN_HTTP_REQUEST_EXAMPLE`) |
| README/docs | README(.zh)/`docs/guide/configuration.md`/features docs cover quick requests + zero-config auto reload + endpoint shape | files at fixed SHA |

### HR-AUDIT-002 — Module inventory (registration entry points)

| Cluster | Modules | Role |
| --- | --- | --- |
| Trigger core | `src/hotReload.ts` (1118 L) | settings read, watch plan, two-stage trigger chain (HR-PR-04 wiring, :825-859): intake `HotReloadSavePipeline` (:840-858, per-file tail-window debounce/max-delay cap/dedup fingerprints/revisions) + merge window `HotReloadTrigger` (:224-265, `pending()` :255); fire-path orchestration: def gate (:786-818) → channel send (:570) → actionName quick action (:618) → default hotfix POST (:436-455); watcher attach/rebuild (:976-1062); config-change rebuild (:1064-1074) |
| Activation wiring | `src/activate/hotReload.ts` (742 L), entered from `src/extension.ts:1360-1367` | ledger + version tracker + status controller instantiation (:91-133), def-gate shared instance (:246-250), all 12 command registrations, decoration/lens provider registration (:574-615) |
| Send cluster | `src/backend/hotReloadDefaultHotfix.ts`, `hotReloadChannelConfig.ts` (679 L), `hotReloadChannelSend.ts`, `hotReloadTransport.ts` (739 L), `hotReloadDelivery.ts` | channel config panel + quick switch lamp; batch channel send with receipt switch; transport abstraction (http / kbengine-official); delivery classifier |
| Receipt cluster | `src/backend/hotReloadReceipt.ts`, `hotReloadAppliedCheck.ts`, `hotReloadRetry.ts` (65 L), `hotReloadRetryCommand.ts` (361 L), `hotReloadRevisionEvidence.ts` + `Command.ts`, `hotReloadTargetState.ts` (401 L), `hotReloadBatchSummary.ts` + `Command.ts` | accepted receipt parser; applied digest double-evidence + 10 s settle; retry planner + single-target resend command; three-kind revision evidence; dual-dimension delivery ledger + HOT-VER version book; per-target aggregation |
| State/UI cluster | `src/backend/hotReloadFileState.ts` (368 L), `hotReloadFileStateFilter.ts`, `hotReloadFileVersion.ts` (303 L), `src/hotReloadStatus.ts` (476 L), `src/hotReloadToggle.ts`, `src/hotReloadFileDecorations.ts`, `src/hotReloadFileStateLens.ts`, `src/backend/hotReloadNotice.ts`, `src/backend/hotReloadGlobsMaterialize.ts`, `src/backend/hotReloadTempEdit.ts`, `src/backend/hotReloadDefGate.ts`, `hotReloadDefHash.ts`, `hotReloadDefStructure.ts` | lifecycle state machine; attention filter/detail commands; per-file version book; send-state lamp; toggle; file decorations; CodeLens; first-run notice; globs materialization; temp-edit reload; def structural gate; def hash three-path; def structural classifier |
| Legacy quick requests | `src/backend/httpRequests.ts`, `src/backend/httpRequestService.ts`, `src/quickActions.ts`, `src/quickActionConfig.ts`, `src/quickActionTree.ts`, `src/variableSubstitution.ts`, `src/backend/debugJsonSchema.ts`, `src/debugConfigBootstrap.ts` | unchanged semantics; moved under `src/backend/` (SRC-001); HTTP registration now `src/activate/views.ts:233-303` (call site `src/extension.ts:1276-1277`) |
| Receiver side (repo, non-extension) | `templates/demo-game/scripts/common/KodeHotReload.py` (352 L) + `xreload.py` (214 L, Python 3.7.3), mirrored in `tests/fixtures/kbengine-demo-assets/`; `scripts/hot-reload-receiver/referenceReceiver.mjs` | demo loopback bridge: HTTP `/hotfix` `/reload` `/status` on 127.0.0.1, ports 8090 base / 8091 cell; xreload = Guido van Rossum's algorithm adapted to 3.7.3; digest validation + applied receipts |

### HR-AUDIT-003 — Send path end-to-end trace (current fire path)

1. Trigger (two-stage since HR-PR-04 wiring): FileSystemWatcher events → `scheduleHot` (`src/hotReload.ts:1032-1038`) → intake `HotReloadSavePipeline.offer` (per-file tail-window debounce, same-file bursts coalesce) + merge-window reschedule (`trigger.schedule` :1037) → settled files join `pendingOut` (:832) → merge-window fire (:834-841) → `runFire` (:429).
2. Gate: pure-Python batch passes synchronously (:779-782); batch containing `.def` runs the structural gate (`gateDefChanges` :777-809 → `hotReloadDefGate.check` :107-166). Structural diff → **blocked**: `RESTART_REQUIRED` marked (:784), audit line `拦截:需重启` (:792), baseline NOT rolled forward (:805 runs only on pass).
3. Dispatch (first match wins): deployment channel → `sendFilesViaReloadChannel` (`src/hotReload.ts:561`; transport resolved at `src/activate/hotReload.ts:340-361`, default channel with `targetId='default'` at :347); else `actionName` quick action (:609-756); else default hotfix POST (`runDefaultHotfix` :427-446).
4. Channel send sequence (`hotReloadChannelSend.ts:68-328`): generation records before transport (:74-93) → frozen sha256 digests read per file (:95-116) → root grouping (:117-123) → send → receipts parsed (`parseReloadHttpReceipts` :163-253) → ledger switch `applied`/`accepted`/`failed`/`sent-unverified` (:219-306) → applied settle window anchored at send start (:172-197).
5. Receipt upgrade ladder: transport 2xx = `sent-unverified` only (`hotReloadDelivery.ts:24-35`; non-2xx = `failed` :34); `status:"accepted"` + file echo → `accepted` (`hotReloadReceipt.ts:25-52`); `status:"applied"` + file echo + `digest` == frozen sha256 → `applied` (`hotReloadAppliedCheck.ts:43-96`); settle 10 s (`HOT_RELOAD_APPLIED_SETTLE_MS` :21) ends `unconfirmed-timeout`, never a fake terminal state (:105-119).
6. Failure handling: retry command re-enters the same gate + channel/receipt stream (`hotReloadRetryCommand.ts:101-303`, `source:'retry'` :136-147).

### HR-AUDIT-004 — Module identity and template variables (dual-name model)

- **Dual-name resolver** `resolveModuleDualName` (`src/backend/hotReloadTempEdit.ts:61-102`): KBEngine process-role dirs `base|cell|client|bots` (:58-59) are **stripped from module segments** (:94) — baseapp loads `scripts/base` as process root, `sys.modules` has no `base.` prefix (rationale :50-57; the 2026-11-12 "sent but not applied" bug). Returns `fullModule` (:97) + `requestModule` (last real module dir + stem, :98).
- **Legacy resolver** `resolvePythonModulePath` (`src/backend/httpRequests.ts:130-156`): `__init__.py` package-boundary walk upward, **breaks the chain at a role dir** (:150-152); used by `resolveDefaultHotfixModule` fallback (`hotReloadDefaultHotfix.ts:44-53`) and legacy `${module}`.
- Default-hotfix module choice: dual-name when `scriptRoot` given, else legacy walk (`hotReloadDefaultHotfix.ts:44-53`).
- `__init__.py` still has no special-case beyond rejection in the dual-name path (:82); case preserved; `.pyi`/`.pyc` not matched (`$` anchor).
- Variable inventory: custom `${module}`/`${moduleBasename}`/`${filename}`/`${line}`/`${sel}` (settings path) + official VS Code family (`variableSubstitution.ts`) + channel placeholders `${files}` (JSON array), `${fileList}`, `${targetId}` (`hotReloadTransport.ts:89-92`). Values still not URL-encoded.
- Derived `package` field no longer reports a dotless module as its own package (`src/backend/fileChangeMeta.ts:381-385`).

### HR-AUDIT-005 — Watchers: creation, purpose, lifecycle

| Location | Pattern | Purpose | Lifecycle |
| --- | --- | --- | --- |
| `src/hotReload.ts:976-994` (`attachWatcher` :976-994) | per explicit glob / `**/*` bypass surface / derived dual-duty (`assetsRoot/**/*.py`) | hot reload: change/create/delete → `scheduleHot` (:1032-1038) → intake pipeline offer + merge-window reschedule → gate → send | off until `enabled` (boot `apply()` :1091); full rebuild on config change (:1064-1074, signature `watchSignatureOf` :931-947); composite dispose :1075-1090 |
| bypass merger | `**/*` non-py surface | 30 ms shared-file event merge → state/version bookkeeping (`createSharedFileEventMerger`, `src/backend/sharedFileEvents.ts:47,91`) | same composite |
| `src/extension.ts:491` | `**/*.{py,def,xml}` | python class index invalidation | unchanged |
| other watchers | unchanged from 2026-11-11 audit (config view, asset regen, stubs, CodeLens, mapping, workspace index, debug config) | — | — |

Facts: since the HR-PR-04 wiring (2026-11-13) the trigger is a **two-stage chain** — intake `HotReloadSavePipeline` (per-file tail-window debounce, max-delay cap, dedup fingerprints/revisions; stability window & syntax gate not injected = honestly not done) and merge window `HotReloadTrigger` (:224, the def structural gate's block-whole-batch contract needs the batch to be seen together — per-file direct sends would let the `.py` of a mixed batch slip past the gate); per-file intelligence lives in the version book (`hotReloadFileVersion.ts:154`) and the state machine (`hotReloadFileState.ts:159`), both fed from watcher events. Save events: 4 `onDidSaveTextDocument` registrations exist (`src/globalDataIndex.ts:233`, `src/extension.ts:568`, `src/activate/hotReload.ts:603` — decorations/lens refresh only, no send, `src/activate/diagnostics.ts:562`); **none triggers a send**; `onWillSaveTextDocument`: zero.

### HR-AUDIT-006 — HTTP capability inventory (no rebuilding)

| Capability | Legacy quick-request service (`httpRequestService.ts`) | Channel transport (`hotReloadTransport.ts`) | Default hotfix |
| --- | --- | --- | --- |
| Methods | any, default GET | template method verbatim | POST fixed |
| Headers | sent (settings entries) | substituted; auto `Content-Type` on default channel | form-urlencoded |
| Body | templated | JSON object auto-augmented with `targetId` (:306-321) + `sender_digests` (:326-353) | `module_name=<module>` |
| Timeout | 10 s fixed (`DEFAULT_HTTP_TIMEOUT_MS`, `httpRequestService.ts:22`) | same runner | same |
| Probe | none | GET empty-body probe (:263-287) | none |
| Response | 2xx/not classified as `ok` (any status) | receipts protocol; non-2xx = per-file `failed` (:373-380); non-JSON = `sent` ("无协议回执,不 claim applied", :171-177) | 200-299 ok, else failure |
| Retry | none | none (explicit retry command only) | none |
| Cancellation | none | none | none |
| SecretStorage | zero usage (unchanged) | none | none |

### HR-AUDIT-007 — Status / history / UI surface

- Status bar lamps: 8 total, all Right — 100 server count, 99 telnet, **98 hot-reload send-state** (`src/hotReloadStatus.ts:168`; 7 faces :40-70: 关/就绪/就绪(未监视)/发送中/已发送(未确认)/已应用/失败 + HOT-VER version suffix `v3`/`v2→v3` :421-422), 97 interpreter, **96 hot-reload channel** (`hotReloadChannelConfig.ts:434`; `默认(http)` label, red on failed probe), 95 console tail, 94 Kode core, 93 MCP toggle.
- File decorations: global provider (`src/activate/hotReload.ts:582`), 5 decorated states — DIRTY/D orange, SENT/S blue, APPLIED/A green, FAILED/F red, RESTART_REQUIRED/R purple (`src/backend/hotReloadFileState.ts:358-368`), worst-wins per file.
- CodeLens on `**/*.{py,def}`: top-of-file state line (state | baseline hash12 | last time | reason) (`src/hotReloadFileStateLens.ts:32-45`).
- Commands: filterByState (DIRTY ∪ SENT report), showFileState (per-file detail), showBatchSummary (worst-wins per target, `hotReloadBatchSummary.ts:45-50`), retryFailed, showRevisionEvidence (fileHash/semanticHash/engineDigest), confirmDefBaseline (clears R marks), toggle, switchChannel, configureChannel, materializeGlobs, tempEdit.run, showLog.
- History: **no webview/TreeView history store** — the OUTPUT channel `KBEngine 热更新` append-only ledger + version ledger dump is the only history.
- Notifications: first-run notice (once per workspace, `hotReloadNotice.ts`) with Open logs / Turn off now; per-send errors.

### HR-AUDIT-008 — `.def` Hash / Digest status

- `hashDefContent` (`src/backend/hotReloadDefHash.ts:39-43`): sha256 over raw UTF-8 + byteLength; boundary declared "local reconciliation only". **Not wired into any gate — production callers zero (tests only).**
- The live gate is **structural, not content-hash**: `classifyDefChange` (`hotReloadDefStructure.ts:186`) fingerprints Properties `{Type,Flags,Persistent,Utype}` (:109-119), method Arg signatures (:120-129), Parent/Interfaces/Components (:130-153); comments/whitespace/order/description non-structural (:5-11); unparseable = conservative structural (:189-195).
- Engine digest: `negotiateEngineDigest` (:172) — `md5` only when a 32-char engine-format MD5 is handed over (client side computes it in Rust, `computeDefMd5InRust`, consumer `src/defMd5Check.ts:213,225`, command `kbengine.def.checkEngineMd5`, verdict `match|mismatch|unverifiable`); `compareEngineDigest` (:203-217) is a **permanent refuse** (`comparable: false` both branches) — raw-content sha256 and engine composite MD5 are never cross-compared.
- Revision evidence (`hotReloadRevisionEvidence.ts`): three kinds `fileHash` (local sha256) / `semanticHash` (structural fingerprint hash, `hotReloadDefStructure.ts:165`) / `engineDigest` (parsed from responses only, :85-108); cross-kind comparison always `incomparable` (:52-60).
- Engine API metadata: `KBEngine.reloadScript(fullReload)` (baseapp/cellapp) remains the only engine-side reload surface; `reloadEntityDef()`/`isReload()` retracted as non-existent.

### HR-AUDIT-009 — Server-side protocol evidence

- **HTTP receipt contract (now implemented end-to-end)**: request = channel body JSON object (auto `targetId` + `sender_digests`); response = JSON (array or object), per-item `file` (verbatim echo, required), `status` ∈ `accepted|applied|failed` (+`reason`), optional `targetId` (mismatch → rejected), `digest` (applied requires frozen-sha256 equality), `note`, `revision` (number only). Non-JSON → all `sent`. (`hotReloadTransport.ts:163-253`)
- **Official-channel echo contract**: telnet console exec script with unique marker `KODE_RELOAD_<uuid>:`; payload `{files,targetId,sender_digests}`; when the engine has `KodeHotReload` installed it is preferred (`hotReloadTransport.ts:558-561`), receipts returned via printed marker line, re-parsed through the same HTTP receipt parser (:582-590); without observer: Traceback → `failed`, else `sent` ("引擎无回执协议").
- Demo receiver: `templates/demo-game/scripts/common/KodeHotReload.py` — HTTP loopback `/hotfix` `/reload` `/status`, ports 8090 base / 8091 cell (env-overridable), validates `sender_digests`, computes sha256, replies `applied`, downlinks cell files base→cell; `xreload.py` = Python 3.7.3 adaptation of Guido van Rossum's xreload.
- Applied-revision queryability: **still not implemented** — no polling/validation request; `revision` is only parsed from receipts (informational).
- Target-process identification: `targetId` is a channel-attached label (`'default'` for the built-in channel; per-instance otherwise), not a server-discovered process identity — `unknown` how real deployments will map it.

### HR-AUDIT-010 — Real-project test record

- **External real engine/HTTP service: still untested** from this environment (unchanged from 2026-11-11).
- What exists now beyond scripted transports: demo loopback bridge (Python) + pytest suite `tests/python/test_xreload_py37.py` (220 L, CPython 3.7.3 + newer), `test_demo_hot_reload.py`, `test_demo_official_reload.py`; TS receiver roundtrip harness (`tests/hotReloadReceiverRoundtrip.test.ts`, helpers/hotReloadReceiverHarness) covering 200-but-unapplied / digest mismatch / stale-generation / non-JSON / non-2xx / targetId mismatch classes; ~49 hot-reload test files ≈560 tests.
- Remaining HR-AUDIT-010 items (real-network silence, real module-name conflicts, raw-response capture from a production service): blocked on a live service.

### HR-AUDIT-011 — Keep / Wrap / Replace matrix (refreshed)

| Existing module | Verdict | Rationale |
| --- | --- | --- |
| Legacy quick-request entry parsing + templates (`backend/httpRequests.ts`) | **Keep** | generic Quick Requests must not regress; legacy `${module}` compat stays |
| `backend/httpRequestService.ts` transport | **Keep** | now also the channel transport runner; single seam `ReloadHttpRunner` |
| `hotReloadTransport.ts` channel abstraction | **Keep** | the HR-HTTP adapter seam itself (http + kbengine-official) |
| `hotReload.ts` global debounce watcher | **Replace progressively** (HR-WATCH per-file pipeline still pending) | per-file dedupe/syntax gate/stability wait not yet built |
| `resolvePythonModulePath` | **Keep as legacy** | dual-name `resolveModuleDualName` is the hot-reload face; both strip role dirs |
| State machine / receipts / retry / evidence / UI cluster | **Keep** | these already implement large parts of HR-STATE/HR-UI/HR-HTTP |
| `hashDefContent` | **Decide** (wire or delete) | sha256 face exists, zero production callers |
| `buildCurlCommand` (`src/quickActions.ts:205`) | **Keep or delete** | still test-only |
| demo receiver `KodeHotReload.py`/`xreload.py` | **Keep** (template-scoped) | reference receiver, not shipped as engine code |

### HR-AUDIT-012 — Reuse module paths and owners

| Reuse target | Exact path | Key exports | Owner |
| --- | --- | --- | --- |
| Trigger/debounce/gate orchestration | `src/hotReload.ts` | `setupHotReload`, `readHotReloadSettings`, `planHotReloadWatch`, `HotReloadTrigger` | cuihairu |
| Activation wiring + commands | `src/activate/hotReload.ts` | `activateHotReload` | cuihairu |
| Channel transport | `src/backend/hotReloadTransport.ts` | `ReloadTransport`, `HttpReloadTransport`, `KbengineOfficialTransport`, `resolveReloadTransport`, `parseReloadHttpReceipts`, `createDefaultHotReloadChannel` | cuihairu |
| Ledger + versions | `src/backend/hotReloadTargetState.ts` | `HotReloadTargetStateStore`, `HotReloadDeliveryRecord` | cuihairu |
| Receipt chain | `src/backend/hotReloadDelivery.ts` / `hotReloadReceipt.ts` / `hotReloadAppliedCheck.ts` | `classifyHttpDelivery`, `parseHotReloadAcceptedReceipt`, `verifyAppliedReceipt`, `settleAppliedStatus` | cuihairu |
| Def gate/hash | `src/backend/hotReloadDefGate.ts` / `hotReloadDefStructure.ts` / `hotReloadDefHash.ts` | `createDefStructuralGate`, `classifyDefChange`, `hashDefContent`, `negotiateEngineDigest` | cuihairu |
| Module identity | `src/backend/hotReloadTempEdit.ts` / `backend/httpRequests.ts` | `resolveModuleDualName`, `resolvePythonModulePath`, `PYTHON_PROCESS_ROLE_DIRS` | cuihairu |
| UI faces | `src/hotReloadStatus.ts`, `hotReloadFileDecorations.ts`, `hotReloadFileStateLens.ts` | `HotReloadStatusController`, `HotReloadFileDecorationProvider`, `HotReloadFileStateCodeLensProvider` | cuihairu |
| Legacy quick requests | `src/backend/httpRequests.ts` / `httpRequestService.ts` / `src/variableSubstitution.ts` | `parseHttpRequestEntries`, `buildHttpRequest`, `HttpRequestService`, `resolveVariableExpression` | cuihairu |

## 2. Implemented vs missing vs unknown (summary matrix)

| Area | Implemented (evidence above) | Missing / Unknown |
| --- | --- | --- |
| Manual HTTP quick request | yes (settings + debug.json paths, unchanged) | per-entry timeout, retry, secrets |
| Template vars incl. `${module}` | yes + dual-name model (role dirs stripped) | URL encoding; `${targetId}` in legacy quick requests |
| Watch → trigger | yes (globs explicit/derived/bypass; auto default on) | per-file debounce dedupe, syntax gate, stability wait, save-trigger |
| Def structural gate | yes (send-block + RESTART_REQUIRED + confirm command) | — |
| `.def` file hash | sha256 face exists (`hashDefContent`) | **not wired into any gate** |
| Semantic fingerprint | structural fingerprint hash (as revision evidence) | unwired beyond evidence display |
| Engine digest | md5 negotiation stub + `defMd5Check` command comparison | algorithm negotiation with a real engine: `unknown`; cross-comparison permanently refused |
| Success confirmation | accepted receipt + applied digest double-evidence + 10 s settle + worst-wins aggregation | applied-revision polling: no; real-engine semantics: `unknown` |
| Status/UI | 2 lamps, 5-state decorations, CodeLens, batch summary, evidence/retry/state commands, first-run notice | history webview/TreeView: no; applied-timeline view: no |
| Retry | explicit command, one pass, gate-checked, channel re-entry | no automatic backoff/attempt cap |
| Receiver side | demo loopback bridge + xreload (py3.7.3) + reference receiver + receipt protocol | production-grade external receiver: `unknown` |
| Known defect (recorded, not fixed here) | — | first-run notice "Open logs" click compares hard-coded `'打开日志'` against `l10nText('Open logs')` — under a non-zh locale the button does not open the log channel (`src/hotReload.ts:1046` vs `src/backend/hotReloadNotice.ts:39`) |

## 3. Facts vs Unknowns carry-over from 2026-11-11

Resolved by implementation since the last audit: status/history surface (§19.6/§19.7 no longer greenfield — lamps/decorations/lens/ledger exist), success-confirmation model (accepted/applied contract + settle), def structural gate, dual-name module identity, channel model with default. Still `unknown`: server response contract of a production (non-demo) service, engine Digest algorithm, applied-revision query, target-process identity mapping, all real-network behaviors (HR-AUDIT-010).

## 4. HR-PR-02 increment (2026-11-13, module identity pure facade)

Landed in this block (pure logic + template layer; no new user-visible send path):

- `src/backend/hotReloadModuleIdentity.ts` — `HotReloadModuleIdentity` 9-field DTO (HR-MOD-001) + `resolveHotReloadModuleIdentity` pure resolver (HR-MOD-002: root-candidate selection → delegation to `resolveModuleDualName` → diagnostics; zero IO, zero vscode imports) + `canonicalizeScriptFilePath` lexical canonicalization (HR-MOD-009: `file://` strip + guarded percent-decode, backslash→slash, UNC `//` preserved, slash collapse, `.`/`..` lexical resolution, drive-letter uppercase, case preserved; symlink/fs-level case semantics = IO face, explicitly out of pure scope, same boundary as kode-vfs VFS-001).
- Core `resolveModuleDualName` (success shape unchanged, pinned by toEqual) now tags every unsupported return with a machine-readable `reason` code (HR-MOD-002 single mapping source) and accepts opt-in `allowRootLevelStem` (HR-MOD-008 explicit single-level fallback; default still refuses).
- Template layer (HR-MOD-012): `${reloadModule}`/`${fullModule}`/`${fileName}`/`${relativePath}`/`${workspaceRoot}`/`${targetId}` added to `buildTemplateVars`/`applyTemplate`/`applyTemplateWithContext`. Dual names resolve only when `kbengine.hotReload.tempEdit.scriptRoot` is configured, else honest empty string — legacy `${module}` keeps its `__init__.py` package-walk semantics untouched (compat decision recorded at `buildTemplateVars`; URL encoding still not applied, repo-wide contract).
- Tests: `tests/hotReloadModuleIdentity.test.ts` (§19.1 four examples incl. engine-verified deviation `base/Avatar.py → Avatar` per 879f47d5; canonicalization; multi-root unique/out-of-root/ambiguous-lists-all; adjacent-directory false containment; override valid/invalid; root-level default refuse + explicit fallback; `%20`-decoded space stem refused, dotted stem refused, Unicode stem allowed; diagnostic-code passthrough) + core reason/option cases in `tests/hotReloadTempEdit.test.ts` + template shape pins in `tests/httpRequests.test.ts`.

Deferred with reasons (ledger lines stay unchecked, no fake completion):

- HR-MOD-006 full engine-profile root priority: needs the engine-profile config face (kode2 §6); ambiguity refusal (the "don't guess" essence) already landed in the resolver.
- HR-MOD-008 user-visible `allowRootLevelStem` config key + send-path wiring: would change zero-config default-hotfix behavior; core opt-in landed, exposure deferred.
- HR-MOD-010 wire-level root/target context on the request: receiver contract frozen pending real-service validation (HR-AUDIT-009); resolver-side rootId + ambiguity refusal landed as essence.
- HR-MOD-011 UI display of `fullModule`/`requestModule`: HR-UI cluster (HR-PR-06).
- HR-MOD-013 old-config migration/preview UX: user-facing command deferred; pure core + template dual face exist.
- HR-MOD-014 ledger/history dual-name fields: history shape extension deferred (HR-PR-06).

## 5. HR-PR-03 increment (2026-11-13, generic request executor)

- `src/backend/httpRequestExecutor.ts` — single execution path (HR-HTTP-001): both quick requests (`HttpRequestService.runEntry`) and default hot reload (`sendDefaultHotfix`) now go through `executeHttpRequest` + the exchange state machine (`idle→in-flight→settled`, one-way, illegal transitions refused with a reason) instead of each carrying their own transport branching. Generic HTTP semantics unchanged: service branches still read `transportOk` = the transport's original `ok` boolean, so log lines, error toasts and boolean returns are byte-identical.
- Structured outcome (HR-HTTP-010): `classifyExecution` maps transport facts to six kinds (`ok` / `non-2xx` / `timeout` / `network-error` / `invalid-url` / `unsupported-protocol`) plus an error sub-category (`connection-refused` / `dns` / `connection-reset` / `timeout` / `invalid-url` / `unsupported-protocol` / `http-status` / `unknown`). Classification is driven by transport facts; an unrecognized message is `unknown`, never guessed. Receipt parsing (`parseReloadHttpReceipts`) sits above and is unchanged.
- Correlation id (HR-HTTP-014): every execution gets a `crypto.randomUUID()`, threaded through the outcome (caller may supply its own). Header propagation is deliberately not done — it changes wire bytes, same boundary as "no URL encoding"; wire threading awaits the receiver contract (HR-AUDIT-009).
- Mock server e2e (HR-HTTP-017): `tests/httpRequestExecutorMockServer.test.ts` drives the real node transport against per-test ephemeral servers — 2xx JSON receipt → applied, 2xx non-JSON → `sent` (no applied claim), 500 → `non-2xx`, slow response + short timeout → `timeout` (and the server still completes 200 afterwards: a local timeout is never reported as an application failure), closed port → `connection-refused`, mid-response socket destroy → `connection-reset`, chunked assembly, duplicate requests (2 hits, distinct correlation ids), unparseable URL / unsupported protocol.
- Defect fixed (found by the new e2e): the default transport resolved nothing when the server aborted mid-response — node fires `aborted` on the response stream while `req` is already destroyed, so neither `req.on('error')` nor the socket timeout could settle the promise, and the caller hung forever. The old comment claimed `req.on('error')` would catch it; it does not. Now `res.on('aborted')` / `res.on('error')` settle as failures (the Promise honors the first resolution). The pre-existing service-level "does not hang" test stayed green because it injects a fake transport — mock-vs-wire drift.

## 6. HR-PR-04 increment (2026-11-13, save event pipeline pure core)

- `src/backend/hotReloadSavePipeline.ts` — pure core, no IO and no `vscode` import (clock, timers, snapshot read and syntax check are injected; the same boundary as `kode-vfs` VFS-001 and `hotReloadModuleIdentity`). The wiring side — vscode event binding, config faces, default switch — is not in this core.
- Per-file trailing debounce + global max-delay cap (HR-WATCH-006): a re-offer reschedules the window (true trailing debounce, not a fixed leading window) and the window budget is capped by `maxDelayMs`, so a save storm is deferred at most to `maxDelay` and never indefinitely. Cap truncation is recorded honestly as `max-delay-capped` on the event. The cap is enforced at scheduling time, not at due time: the trailing formula already bounds the timer at `first + maxDelay`, so a due-time check would be unreachable. The first window is capped too (`min(debounceMs, maxDelayMs)`), so `maxDelay < debounce` caps immediately.
- Event source coalescing (HR-WATCH-003/009): same canonical URI + same pending merge into one `FileChanged{uri,revision,diskHash,source,time}` with a coalesce reason; `disk-save-overlap` is only recorded in the save→disk-change direction (one write producing both events), and the representative source is the latest one.
- Write stability (HR-WATCH-007): two consecutive snapshot hashes must agree before sending; probe count is bounded (`maxStabilityProbes`), beyond which the last snapshot is sent honestly with an `unstable-after-N-probes` reason. Unreadable/deleted snapshots are dropped with a diagnostic, never guessed. A `settling` guard stops a second concurrent settle for the same URI while an async two-shot wait is in flight.
- Wave aggregation: files settled inside the same debounce window are merged into one batch (wave flush at `batchFlushMs`). Without a wave every settle passed exactly one event, so the HR-WATCH-016 threshold could never fire — the batch path was dead code.
- Dedupe key (HR-WATCH-010): canonical URI + targetId + content hash, reusing `canonicalizeScriptFilePath` from HR-PR-02 (so `file://` and bare-path forms of one file merge).
- Version guard (HR-WATCH-011): `revision` increments only when a new content version is actually emitted — dedupe and syntax blocks do not consume a number. Consuming one at offer time made an in-flight response for unchanged content look stale to `isStaleResponse(sent, current)`.
- Delivery fingerprint is separate from the dedupe key (HR-WATCH-008): the fingerprint is recorded when the batch is handed to the sender (in `emitBatch` / `releasePreview`), because the core cannot know whether delivery succeeded. `forgetSent(file)` withdraws it on failure, so the same content is not permanently skipped after one failed send.
- Syntax gate (HR-WATCH-012) is injected; a failing verdict emits `blocked` and no half-finished file is sent. The check runs once per settle (checked-once; the first draft called it twice).
- HR-WATCH-014 `dispose` clears pending, wave and preview-held together, and stops accepting events. HR-WATCH-016 batches over the threshold are preview-only and release explicitly; while held, later batches merge into the single held batch. HR-WATCH-017 diagnostics: `trigger` / `filtered` / `debounced` / `deduped` / `blocked` / `scheduled` / `preview` / `flushed`.
- `isWatchableScriptFile` (HR-WATCH-004) is a pure lexical filter: extensions (default `.py`, case-insensitive), explicit roots matched as a strict prefix with a segment boundary (`/ws/scripts` does not admit `/ws/scripts2`), default excluded dirs (`.git`, `.venv`, `venv`, `node_modules`, `__pycache__`, `.kbengine`, `.mypy_cache`, `.pytest_cache`, `.ruff_cache`) plus caller-supplied ones, and backup-like names (`.swp` / `.swo` / `.bak` / `.tmp` / trailing `~` / `#name#`).
- Wiring deferred, on purpose: the ledger item HR-WATCH-001 says "default off" while the standing order from 2026-11-06 is zero-config default **on** (save posts automatically) — that conflict is resolved by the standing order (default on supersedes the ledger text; the live code already defaults to enabled). The mode-selection config face and the default switch are not implemented here. The live fire path (global `HotReloadTrigger` + `pendingTriggers` batch) is pinned by roughly fifty `hotReload*` test files, so rewiring it is a separate sub-batch rather than a drive-by change. (Update 2026-11-13, HR-PR-04 sub-batch: the save-side wiring has landed — the live trigger chain is now the two-stage form; see the §6 note and §12.)
- Tests: `tests/hotReloadSavePipeline.test.ts`, 31 cases, with all clocks and timers virtual (an in-memory timer queue drained by `advance()` in expiry order). Three prove-red rounds: removing the max-delay cap turns the save-storm case red; disabling the preview threshold turns three preview cases red; making `forgetSent` a no-op turns the HR-WATCH-008 case red.

## 7. HR-PR-05 increment (2026-11-13, disk-watch assembly core)

- `src/backend/hotReloadDiskWatch.ts` — assembly core with zero `vscode` imports: `FileSystemWatcher` is injected as a `DiskWatcherFactory` (real wiring will adapt `vscode.createFileSystemWatcher`; tests drive an in-memory watcher bus), the same boundary as the save pipeline core.
- HR-WATCH-004 watcher face: `watchRoots` derives one recursive glob per canonical root (all `.py` under the root; `deriveWatchGlob` is reusable by the adapter), so out-of-root events never reach the controller. Excluded directories are caught by the filter layer with `filtered` diagnostics; backup-like names are stopped at the watcher glob layer itself (a `.bak` name never arrives at the filter through a `.py` glob — verified in tests), with `isWatchableScriptFile` kept as defense in depth for broader event sources.
- HR-WATCH-015 baseline gate: every disk event arriving before `arm()` is dropped with a `dropped-before-arm` diagnostic — activation creates watchers first and arms after, so startup never treats existing files as changes. `rebuild` preserves `armed`: recreating a watcher must not reopen the baseline window (real watcher recreation does not replay existing files; reopening would risk a startup whole-repo send).
- HR-WATCH-003: change/create events pass the filter and are offered as `disk-change` after canonicalization — same key as the sender face, so `file://` and UNC `//wsl$` forms merge with bare paths. Delete events never enter the pipeline (a `delete-ignored` diagnostic only): deleted files are dropped honestly by the pipeline's stability wait. Save+disk overlap goes through the real pipeline and merges as one event with a `disk-save-overlap` reason, no double send.
- Git batch changes (branch switch / checkout burst) are handled by the pipeline's three layers, verified end-to-end against the real HR-PR-04 core: a 30-file burst aggregates into one wave batch (no amplification); restoring identical bytes dedupes (checking out unchanged content does not re-send); a burst over the preview threshold is held preview-only until explicit release (HR-WATCH-016 backstop).
- HR-WATCH-005 controller face: `dispose` disposes every watcher and rejects all further calls (`watchRoots` / `arm` / `rebuild` included); `rebuild(roots)` disposes old watchers and recreates per the new roots while keeping `armed`.
- JSDoc pitfall recorded: a block comment containing the literal `/**/*.py` terminates itself early (the `*/` inside), which surfaced as cascading TS1109 parse errors — comments now describe globs in prose and keep the literal only inside string literals.
- Wiring deferred, on purpose: the `vscode.createFileSystemWatcher` adapter and the `extension.ts` wiring feeding save+disk events into the live fire path (global `HotReloadTrigger` + `pendingTriggers`) are a separate sub-batch — that path is pinned by ~50 `hotReload*` test files and must not be rewired as a drive-by. The HR-WATCH-001 conflict noted in §6 is resolved per the 2026-11-06 standing order; the mode-selection config face stays with the config sub-batch. (Update 2026-11-13: the save-side chain and the disk-side feed are both wired — see §12 and §13; the mode-selection config face stays with the config sub-batch.)
- Tests: `tests/hotReloadDiskWatch.test.ts`, 16 cases — in-memory watcher bus + virtual clock driving the real save pipeline end-to-end. Two prove-red rounds: removing the arm gate turns the HR-WATCH-015 case red; bypassing the filter layer turns the filtered-diagnostics case red. Gates: lint 0 / tsc 0 / unit 754 files 9286 tests / xvfb demo 25 RC=0.

## 8. HR-PR-06 increment (2026-11-13, ui-status audit + history core)

- Audit result first: a large part of the HR-UI cluster already exists live and is test-pinned — the seven-state status machine (`src/hotReloadStatus.ts`, including `watch-off` with two honest reasons per §11.1), file decorations + targeted CodeLens (`hotReloadFileDecorations.ts` / `hotReloadFileStateLens.ts`), the trusted-receipt semantics (`setApplied` only after receipt verification; `setSentUnverified` for 2xx without a business receipt), and the retry family (`hotReloadRetry` core + command + channel + def-gate, four pinned test files). Ledger items HR-UI-001/003/009 are checked off on that evidence.
- The genuinely missing piece was history: no store existed anywhere. New pure core `src/backend/hotReloadHistoryCore.ts` — zero `vscode` imports, capacity semantics injected (same boundary as the pipeline and disk-watch cores).
- Entry shape (HR-UI-002/006/HR-MOD-014): every row stores `fullModule` and `requestModule` side by side plus `fileUri` / `targetId` / `time` / `requestId` / `status` / `errorSummary` — the name the user sees and the name the request carries are never conflated. `buildHistoryEntryLabel` titles by `fullModule` (honest fallback when absent); `buildHistoryEntryTooltipLines` projects requestModule (only when it differs), file, target, time (ISO), requestId, status, error.
- Row identity: `requestId` (HR-HTTP-014's per-execution id). Re-recording the same id replaces in place — idempotent, no duplicate rows, order preserved. Same file with a different target stays two rows (HR-UI-010/014); `targetId` is part of the row identity.
- Trusted-receipt parity (HR-UI-009): status transitions are one-way `sent-unverified → applied | failed`; terminal states refuse any transition and same-status re-writes are refused, each honestly returning `false` rather than silently pretending. Evicted/unknown ids also return `false`.
- Filters (HR-UI-010): AND-composed — `fullModuleContains` (case-insensitive substring), `targetId`, `fileUri`, `status`, and an inclusive time range.
- High-frequency merging + bounded memory (HR-UI-007): `coalesceHistoryUpdates` merges multiple updates for the same requestId inside the window into one (last state wins; across-window stays separate — different requestIds are independent); `page(offset, pageSize)` returns `{items, total, hasMore}` with out-of-range offsets honestly empty; default capacity 200 with oldest-first eviction.
- Grouping for the tree view (HR-UI-002): `groupByFile` / `groupByTarget` keep group keys in first-seen order and entries newest-first (feed them `newestFirst()`).
- Wiring deferred, on purpose: TreeView / panel / search-box registration, config faces (HR-UI-005), i18n + a11y rendering (HR-UI-011), lifecycle binding (HR-UI-012), and click-through actions (HR-UI-008 locate/open-log) are the wiring batch.
- Tests: `tests/hotReloadHistoryCore.test.ts`, 16 cases. Three prove-red rounds: allowing terminal-state transitions turns the transition-guard case red; dropping case-insensitivity turns the substring cases red; disabling the merge window turns the coalescing case red. Gates: lint 0 / tsc 0 / unit 756 files 9302 tests / xvfb demo 25 RC=0.

## 9. HR-PR-07 increment (2026-11-13, def-fingerprint audit + tri-compare core)

- Audit first: the three hash layers already exist live and pinned — `hashDefContent` (sha256 over raw bytes), `structuralFingerprintHash` (normalized structural fingerprint), `negotiateEngineDigest` (md5 per C-18, or honest `unknown`), with `hotReloadRevisionEvidence` naming all three kinds and refusing cross-kind comparison. Ledger HR-HASH-001/003/004/005 are checked off on that evidence (004 via the honest-marking arm, 003 needed the spec version which this batch adds).
- New pure core `src/backend/hotReloadFingerprintCompare.ts`:
  - HR-HASH-008 `compareFingerprints` — three independent verdicts: `fileChanged` compares only the fileHash pair, `semanticChanged` only the semantic pair, `appliedConsistency` requires all three rings (engine algorithm negotiated + server-reported digest + local recomputation with the same algorithm) before saying consistent/different; any missing ring is an honest `unknown` with a named reason. Cross-class comparison (client sha256 vs engine composite MD5) is never performed — the discipline inherited from `compareEngineDigest`.
  - HR-HASH-006 `resolveFingerprintProfile` — negotiated algorithm gets its name as the label; unresolved is labeled exactly `not available`, never a guess.
- Real defect caught by the new tests: `compareSameKind` tested empty-string before null, so a null semantic hash (unparseable def) crashed with `TypeError: Cannot read properties of null`. Fixed by ordering the null check before the length check.
- Additive extension in `hotReloadDefStructure.ts`: `DEF_FINGERPRINT_SPEC_VERSION` (`'def-structural-fp/1'`, fingerprint values are version-scoped and never comparable across versions) and `semanticFingerprintReport` (specVersion + `scope: 'file-only-semantic'` + note naming the dependency-verification obligation; unparseable → `hash: null`, never fabricated). Consumers (`hotReloadDefGate`, `hotReloadRevisionEvidenceCommand`) are read-only and unaffected.
- Wiring deferred: HR-HASH-002 (VFS byte reuse on change), 006 profile consumption, 007 full Hash Inspector UI, 008 on-modify trigger and verdict display — all wiring-batch. HR-HASH-009 (diff classification detail) is a separate account.
- Tests: `tests/hotReloadFingerprintCompare.test.ts` 11 cases + 2 new `hotReloadDefStructure.test.ts` cases. Two prove-red rounds: removing the negotiation gate turns the applied-unknown case red; changing the scope marker turns the report case red (the null-order defect was caught red organically by the null case before the fix). Gates: lint 0 / tsc 0 / unit 757 files 9323 tests / xvfb demo 25 RC=0.

## 10. HR-PR-08 increment (2026-11-13, versioned plugin API core)

- New pure core `src/backend/hotReloadPluginApi.ts` — zero `vscode`, `HOT_RELOAD_PLUGIN_API_VERSION = '1'` pins the interface shape; incompatible changes bump the version so consumers can reject old implementations instead of misreading them.
- `FingerprintProvider` with a default implementation that purely delegates to the proven cores (`hashDefContent` / `semanticFingerprintReport` / `negotiateEngineDigest` / `resolveFingerprintProfile`) — no invented hashing, no engine-algorithm guessing (HR-HASH-005/006 discipline inherited verbatim). Fork/version differences are handled by swapping provider implementations, not by the default pretending.
- `HotReloadProvider` send slot: `canSend(profile)` dispatches on the engine profile; `send` is transport-faithful (result passed through, not interpreted). The default registry ships no send provider — resolution returning null is honest.
- `EngineProfile` versioned: `engineVersion: null` means unknown (never fabricated, same semantics as `engineVersionDetect`); `buildEngineProfile` is pure (detection value and negotiation input supplied by the caller, no IO here).
- `HotReloadProviderRegistry` honesty rules: duplicate ids and api-version mismatches are rejected with a named reason (never silently replaced or adopted); `resolveSendProvider` first-canSend-wins and returns `null` when nobody answers — no fallback to a default, because hot reload writes engine memory and a silent fallback would pass the default implementation off as the user's environment.
- Wiring deferred: real extension-host assembly (registration timing, lifecycle) and concrete fork-side provider implementations are the wiring batch.
- Tests: `tests/hotReloadPluginApi.test.ts`, 9 cases. Three prove-red rounds: allowing duplicate-id overwrite turns the duplicate case red; falling back to the first registered provider when nobody answers turns the honest-null case red; removing the version gate turns the mismatch case red. Gates: lint 0 / tsc 0 / unit 758 files 9332 tests / xvfb demo 25 RC=0.

## 11. HR-PR-09 increment (2026-11-13, reliability gate suite + perf report)

- New composed gate suite `tests/hotReloadReliabilityGate.test.ts` — no new production code; it composes the already-proven pure core (`hotReloadSavePipeline`) under storm/stale/offline/safety scenarios with the virtual clock (zero IO). Four gates + scaled soak, 7 cases:
  - **Storm** (HR-WATCH-006/016): 50 files × 4 rapid offers = 200 offers → each file emitted exactly once with `coalesced=4` (no event amplification); 5001 files over the 5000 preview threshold → preview-only hold, released as one batch by `releasePreview`.
  - **Stale** (HR-WATCH-011): new content sent while the first send is in flight → the late v1 response is `isStaleResponse`-stale and must not be recorded as the new version's success.
  - **Offline** (HR-WATCH-008): delivery failure withdrawn via `forgetSent` in the async send-result callback (the real assembly timing — the core marks the fingerprint *after* `onEmit` returns, so synchronous in-`onEmit` withdrawal would be overwritten; the harness models the callback timing faithfully). Same content re-sends after recovery; an offline burst (20 files) withdraws all and re-sends as one batch.
  - **Safety** (HR-WATCH-012): syntactically broken content in a storm is always blocked — never sent, never occupies a revision number (recovery resumes at revision 1).
  - **Scaled soak**: 1000 files × 10 = 10,000 offers → exactly 1000 emitted events, every file once, pending empty at the end.
- Prove-red: removing the harness `forgetSent` withdrawal turns both offline-gate recovery cases red (fingerprint kept → same content judged duplicate → no re-send), restore → green. The withdrawal-timing modeling was itself a caught test defect: an in-`onEmit` synchronous withdrawal is overwritten by the core's post-`onEmit` `markSent` — the suite now models the async callback honestly.
- Perf report: `docs/perf/2026-11-13-hotreload-reliability-gate.md` (+ run record). Real-clock pure-memory measurements: 10k offers → 1000 events, offer path 37 ms, full chain 157 ms; same-content second wave fully deduped (0 new emissions with stability window on). Honest boundaries: **24h soak not run** (needs the wired live path; scaled soak is this lane's scope), **Linux-only measurements** (pure-core suite runs anywhere vitest runs; no cross-platform numbers fabricated), no end-to-end network latency (that is HR-HTTP-017's real-network suite).
- Live-path storm/decay acceptance for the assembled extension stays with the wiring batch (HR-PR-02..08 lines remain annotated, not checked).

## 12. HR-PR-04 wiring increment (2026-11-13, two-stage trigger chain live)

- The live trigger chain is rewired as a **two-stage form** (`src/hotReload.ts` :825-859): (1) intake `HotReloadSavePipeline` — per-file tail-window debounce (same-file bursts coalesce), global max-delay cap, dedup fingerprints/revisions built in; the stability window and syntax gate activate with their injectable faces (not injected in this batch = honestly not done). (2) merge window `HotReloadTrigger` (the existing global debounce, now with a `pending()` query :255) — coalesces same-window settlements into one batch for the send orchestration.
- **Why a merge window must exist**: the def structural gate's block-whole-batch contract (pinned by the mixed-batch case in `tests/hotReloadDefGateWiring.test.ts`) depends on the batch being seen together — per-file direct sends would let the `.py` of a mixed batch slip past the gate and reload while a structural def change is blocked; engine state would diverge. Same-instant ordering is guaranteed by timer insertion order (offer arms the intake timer first, then the merge window; same-tick settles before merge). The real-time fire moment stays at "last event + window" (emit only back-fills the merge window when none is in flight, via `pending()`), matching the old global-debounce timing.
- `batchFlushMs: 0` = a settlement joins the merge pool immediately, no wave window; wave coalescing / batch preview threshold / preview release are reserved for the config sub-batch (core mechanics HR-WATCH-013/016 pinned in-library; the `batchFlushMs=0` semantic has a core test pin).
- Test-double clock handle-collision fix: 20 test files' `makeTimers` used `handles.size` as the timer id — after a clear+set cycle the id collides and overwrites the other timer (real `setTimeout` ids are monotonic; the double's semantics were wrong). All unified to a monotonic `nextHandle++` counter. In-flight timer counts 1→2 (two stages) are honest re-pins (4 `toBe(1)`→`toBe(2)` sites, 2 `tick()` return values); behavioral assertions unchanged.
- Gates: eslint 0 / tsc 0 / unit 759 files 9345+8skip RC=0 (+1 core pin: batchFlushMs=0 emits at settlement) / xvfb demo 25 RC=0. Still deferred: the config face (mode selection + stability/syntax/wave/preview-threshold keys) and revision consumption (stale-response gate). (Disk-side wiring landed 2026-11-13 — see §13.)

## 13. HR-PR-05 wiring increment (2026-11-13, disk-side feed live)

- The disk-side feed is wired (`src/hotReload.ts` + `src/activate/hotReload.ts`): the assembly injects a real `vscode.createFileSystemWatcher` adapter (`hotReloadDiskWatcherFactory`, thin `DiskWatcherHandle` wrapper, uri→fsPath) into `setupHotReload`'s new `diskWatch` option. `setupHotReload` builds a `HotReloadDiskWatchController` per `apply()`: per declared root a `${root}/**/*.py` watcher (HR-WATCH-004), change/create canonicalized and offered as `disk-change` into the same two-stage chain (same intake pipeline + merge window), delete never enters (diagnostic only), `arm()` right after creation — the apply block is synchronous, so real events can only arrive in later macrotasks and the HR-WATCH-015 baseline window cannot leak startup files. Not injecting `diskWatch` = the old assembly behavior (all pre-existing tests unaffected).
- Scope parity: the disk plane never watches wider than the existing hot domain. An in-assembly scope gate (`diskOfferInScope`) mirrors the same plan — derived mode = assetsRoot prefix (both sides canonicalized), explicit mode = `matchesHotReloadGlob` on the workspace-relative path (the same matcher the version badge uses, no second glob semantics). Out-of-scope disk events are dropped at the gate without diagnostics: the controller's own filter layer already reports `filtered` for extension/dir/backup violations, and the gate sits above it (a double report would double-count).
- Lifecycle (HR-WATCH-005): the controller is rebuilt on every `apply()` — config/root/signature changes already re-run apply; the old controller disposes all its watchers and the new one takes the current folder roots (`filterOptions.roots` is never stale). Plan off/error → old controller disposed, no new one built. Extension dispose clears it with the rest of the assembly.
- Diagnostics routing: lifecycle kinds (`watch-created` / `dropped-before-arm` / `disposed`) go to the hot-reload channel log; `filtered` / `delete-ignored` are not logged per-event live — a git checkout bursts hundreds of deletes and would flood the audit channel; their semantics stay pinned in the core tests.
- Overlap dedup is live (HR-WATCH-003): both planes feed one pipeline, so an editor save that also surfaces as a disk write merges into one pending entry (`disk-save-overlap`, single batch) — the book's two-entry-points-one-pipeline model.
- Tests: `tests/hotReloadDiskWatchWiring.test.ts`, 8 cases — no-injection unchanged / per-root pattern + one-batch fire / save+disk overlap single batch / delete ignored with diagnostic / explicit narrow globs not widened / config-off tears the plane down / context dispose silences it / source-lock on the real adapter.
- Still deferred: the config face (mode selection + stability/syntax/wave/preview-threshold keys) and revision consumption (stale-response gate).
