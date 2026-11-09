# kode Hot-Reload Capability Design (user directive 2026-11-01 · Review Draft)

> Status: **review draft**. This document precedes the code; implementation
> starts only after review passes, and the implementation must align with this
> document's wording item by item, reusing the repo's existing vocabulary
> (`HotReloadDeliveryOutcome` etc.) — no new coinage. Unimplemented surfaces
> are honestly marked "not implemented" in the text and never dressed up as
> implemented.
>
> Task source: `~/.hermes/cache/scratch/tasks/kode-hotreload-design.md`
> (user directive 2026-11-01, priority P1). Three entries land in `todo.md`:
> IDE-HOT-100 (state machine), IDE-HOT-101 (channel abstraction),
> IDE-HOT-102 (configuration and audit).

## 1. Requirements

1. **File hot-reload state visualization**: every script file needs a state
   marker — unmodified / modified-not-reloaded / sent-awaiting-receipt /
   reloaded-and-effective / reload failed.
2. **Two reload channel options**: the official KBEngine option (depends on
   the engine's `reloadScript`, via the console) + the in-house receiver
   option (this repo's HTTP receiver `scripts/hot-reload-receiver/`, with the
   endpoint configured by the user).

## 2. Existing foundations (current-state check; must be re-verified before implementation)

All of the following are surfaces already landed in `src/` and pinned by
existing tests; this design layers on top of them and does not establish a
second identity system.

| Surface | Location | Semantics |
|---|---|---|
| Delivery-result ledger | `src/hotReloadTargetState.ts` | Four states `sent-unverified \| accepted \| applied \| failed`; key = `rootId × targetId × file` (rootId = the file's owning scan root, targetId = the service instance); `attempt` = the send generation (IDE-AUD-005); `sentDigest` = content sha256 frozen at send time (IDE-AUD-006) |
| accepted receipt protocol | `src/hotReloadReceipt.ts` | JSON `{"status":"accepted","file":"<verbatim echo>"}` (optional matching targetId) |
| Hot-reload request body | `src/hotReloadTransport.ts` + `scripts/hot-reload-receiver/referenceReceiver.mjs` | Request body `{"files":[...],"targetId"?,"sender_digests"?}`; `sender_digests` = sha256 frozen at send time (F3 round three: delivered with the payload); the receiver writes that content itself into the engine directory, recomputes the artifact's sha256, and only replies applied when the comparison matches (F3 round four) |
| applied receipt protocol | `src/hotReloadAppliedCheck.ts` | JSON `{"status":"applied","file":"<verbatim echo>","digest":"<sha256>"}`; digest compared against the frozen send-time baseline; `settleAppliedStatus` keeps unconfirmed on timeout |
| HTTP delivery classification | `src/hotReloadDelivery.ts` | Only transport facts count: 2xx→sent-unverified, non-2xx/transport failure→failed; the response body is never evidence of application |
| Status-bar feedback | `src/hotReloadStatus.ts` | `watch-off \| ready \| sending \| sent-unverified \| failed`; structural def changes fall back to ready (IDE-REV-024) |
| def structure gate | `src/hotReload.ts:442-484` | Structural def changes: the whole batch sends no ordinary reload, `setRestartRequired` (IDE-HOT-005 / IDE-REV-024) |
| HTTP quick action | `src/quickActions.ts` / `src/httpRequests.ts` | `@http:` actions → `runHttpRequest`; `HttpRequestEntry{url,method,headers,body}` templates carry `${module}/${filename}` and other placeholders; the `onHttpResponse` response surface |
| Official KBEngine reload surface | Engine-source survey (AUD-007) | Python module function `KBEngine.reloadScript(fullReload)`; **not an HTTP interface, no receipt**; reached via the console/management interface on baseapp/cellapp |
| Console access | `src/telnetClient.ts` | `KBEngineTelnetClient` (telnet console, command whitelist) |
| Deployment configuration | `src/projectProfiles.ts` | `ProjectProfile{id,displayName,assetsRoot,engineRoot,interpreterPath}` — the deployment-level configuration carrier |

**Existing ledger vs this design's file state machine — a clear division of
labor**: the ledger (`HotReloadTargetStateStore`) records **the result of each
delivery** (latest entry per rootId×targetId×file); the new state machine
layers on the ledger to give a `CLEAN/DIRTY/SENT/APPLIED/FAILED` lifecycle
state per **file × target** — the ledger is the source of truth, the state
machine is a derived view. Their keys share the same shape
(rootId×targetId×file); no second identity system.

## 3. IDE-HOT-100 [P1] Script-file hot-reload state machine

### 3.1 State definitions

One state per `(rootId, targetId, file)`. The state basis = **file content
hash + the existing receipt protocols** (accepted/applied of
IDE-HOT-002/003/004), **never file mtime**.

| State | Meaning | Entry condition |
|---|---|---|
| `CLEAN` | Unmodified: content matches the last successfully applied baseline | content sha256 == baseline hash (baseline = the content hash at the most recent APPLIED, or the file's first appearance in the session baseline book with an equal hash) |
| `DIRTY` | Modified, not reloaded: content diverges from the baseline | content sha256 != baseline hash (edited but not sent) |
| `SENT` | Sent, awaiting receipt | the file is in this batch's send set and no accepted/applied/failed settlement has arrived yet |
| `APPLIED` | Effective: baseline updated | the applied receipt verified (digest matches the frozen send-time baseline) → baseline hash updated to the sent content's hash |
| `FAILED` | Reload failed | delivery failed (failed) or receipt timed out unconfirmed (unconfirmed-timeout) |

### 3.2 State transitions

```
CLEAN ──(content hash diverges from baseline)──▶ DIRTY
DIRTY ──(enters send set)────────────▶ SENT
SENT ──(applied receipt + digest match)──▶ APPLIED (baseline = sent content hash)
SENT ──(accepted receipt)────────▶ SENT (stays awaiting receipt, annotated accepted; still waiting for applied)
SENT ──(delivery failure/receipt timeout)──▶ FAILED (with cause; never poses as applied)
APPLIED ──(file edited again)────────▶ DIRTY (new divergence)
FAILED ──(file edited/user retries)──▶ DIRTY (can resend)
```

Constraints:
- **mtime plays no part** — only content-hash divergence from the baseline
  marks DIRTY; permission changes/touch without content change never mark
  dirty.
- **SENT does not jump to APPLIED on accepted** — accepted only annotates
  (HOT-003 rule: "application still needs verification"); it still waits for
  applied or timeout.
- **FAILED never poses as applied** — a receipt timeout keeps the
  unconfirmed semantics (`unconfirmed-timeout`), honestly marked FAILED with
  detail noting "unconfirmed/timeout", never claiming effective.
- **Retry**: FAILED resends go through the existing retry surface
  (IDE-HOT-007 / IDE-REV-026); a resend is a new SENT (a new generation
  attempt advances).
- **Structural def changes do not enter this state machine** — they take
  IDE-HOT-005's `restartRequired` surface (whole batch not sent); this state
  machine marks that batch's files `RESTART_REQUIRED` (see supplementary
  state in 3.3).

### 3.3 Supplementary state: structural def

IDE-HOT-005's `setRestartRequired` intercepts structural def changes before
sending. This state machine gives that batch of files a presentable
supplementary state:

| Supplementary state | Meaning |
|---|---|
| `RESTART_REQUIRED` | Structural def change; the ordinary reload was intercepted; requires a process restart before re-applying |

`RESTART_REQUIRED` is a neighbor of `FAILED` but semantically different
(not a failure — a conservative interception), displayed with its own color,
never conflated with FAILED.

### 3.4 IDE presentation

- **File tree badges** (FileDecorationProvider): per-state file-name
  badge/color — DIRTY=orange, SENT=blue, APPLIED=green, FAILED=red,
  RESTART_REQUIRED=purple; CLEAN has no badge.
- **CodeLens state dot**: at the top of the file (or above the first entity
  definition), a state dot + the first 12 characters of the current baseline
  hash + the latest delivery detail.
- **State filter**: commands/view toolbar filter by state — "see what changed
  but hasn't reloaded" (a filtered view of DIRTY ∪ SENT).

### 3.5 Acceptance (IDE-HOT-100)

1. Content hash diverges from baseline → DIRTY; restoring the original
   content (hash back to baseline) → CLEAN (mtime changes irrelevant).
2. Enters the send set → SENT; applied receipt + digest match → APPLIED and
   the baseline updates to the sent hash.
3. accepted receipt → stays SENT (annotated accepted), no premature APPLIED.
4. Delivery failure / receipt timeout → FAILED with cause in detail, never
   posing as applied.
5. Structural def change → RESTART_REQUIRED, no ordinary reload.
6. Retry → new SENT (attempt advances), then APPLIED on success.
7. State filter lists only DIRTY/SENT ("changed but not reloaded").

### 3.6 状态栏文件版本号(HOT-VER)

状态栏在五种既有状态(`watch-off / ready / sending / sent-unverified / failed`)
之上**正交叠加**每文件版本号:不新增状态、不改五态原文案,版本号只描述
「盘上内容变了几次/基线在哪」。

| 情形 | 状态栏文案 | 含义 |
|---|---|---|
| 已同步 | `$(eye) 热更: 就绪 v3` | 单号 = 盘上当前版本,基线已追平 |
| 待同步 | `$(cloud-upload) 热更: 已发送(未确认) v2→v3` | 双号 = 基线/上次发送版本 → 盘上当前版本 |
| 未跟踪 / 不在监视范围 | `$(eye-closed) 热更: 关` | 不显版本号 |
| watch-off 且无版本上下文 | 同上 | 五态原文案逐字不变 |

- **版本 = 每文件单调递增整数**:首次跟踪记 v1;盘上 version token(异步
  stat 的 `mtimeMs:size`,与 `src/backend/sharedFileEvents.ts` 合并窗口同一口径)变则
  +1;回退到旧内容也算新一次变化,版本**绝不倒退**。原始 token 不上屏,只显示
  `vN`。
- **基线随台账**:`HotReloadTargetStateStore` 内的文件版本簿与投递台账同
  生命周期(不新开存储)。回执 `applied` 且 digest 与**当前盘上内容**一致时
  基线追平到当前版本(转单号);盘上已变则不追平,双号如实保留——未校验回执
  不标成功,版本号也不声称已生效。
- **版本台账独立于 watcher**:`kbengine.hotReload.enabled=false` 时手动触发
  路径(`kbengine.hotReload.showFileState`、`kbengine.hotReload.retryFailed`、
  右键手动跑一次热更动作)照样建档出号,与开监视时**同文件同版本逐字相等**
  ——watcher 只是版本簿的默认事件来源,不是它的前提;两条路径写同一份台账
  同一实现(`noteFileVersion` 按 token 判重,同 token 只 +1,不产生两套计数)。
  监视范围只看 `kbengine.hotReload.globs`(与 `enabled` 正交)。
- **活动文档优先**:活动文档在监视范围且已跟踪 → 显示它的版本;否则回落
  「最近变更文件」的版本;tooltip 列出全部待同步文件及其版本对;开日志命令
  `kbengine.hotReload.showLog`(状态栏开关提示的「打开日志」入口)→ 「KBEngine
  热更新」OUTPUT 列版本台账(当前文件、基线版本、盘上版本,以及
  每次版本跃迁的时间、发送状态与回执:attempt、digest 前 8 位、
  accepted/applied/failed)。
- **红线**:版本号与五种状态正交,不构成新状态;applied 只来自双证核验,
  未校验回执不标成功。

> **English (status bar version badge).** The status bar stacks a per-file
> version number orthogonally on the five existing states — no new state, no
> rewritten face. One number (`热更: 就绪 v3`) means the on-disk content
> matches the verified baseline (synced); a pair (`热更: … v2→v3`) means
> baseline → current on-disk version (pending). Versions are monotonically
> increasing integers per file: first observation = v1, each change of the
> `mtimeMs:size` version token (same helper as `src/backend/sharedFileEvents.ts`) = +1,
> reverting to older content still counts as a change — the number never goes
> down, and the raw token is never displayed. The baseline lives in the
> target-state ledger (`HotReloadTargetStateStore`, same lifetime, no extra
> store) and catches up to the current version only when an `applied` receipt's
> digest matches the **current** disk content; if the disk moved on, the pair
> stays. The ledger is **independent of the watcher switch**: with
> `kbengine.hotReload.enabled=false`, the manual paths
> (`kbengine.hotReload.showFileState`, `kbengine.hotReload.retryFailed`, a
> hand-run hot reload action) produce the same numbers for the same file as
> the watched path — the watcher is only the default event source, never a
> prerequisite, and both paths write one ledger through one implementation
> (`noteFileVersion` de-duplicates by token, so one token = one increment, no
> second counter). Scope is decided by `kbengine.hotReload.globs` alone,
> orthogonal to `enabled`. An active document in scope that is tracked shows
> its own version, otherwise the badge falls back to the most recently changed
the tooltip lists every pending file with its version pair; running
`kbengine.hotReload.showLog` (the 「打开日志」 button in the toggle notice)
appends the version ledger (current file, baseline, disk version, and every
version jump with time, attempt, digest prefix and accepted/applied/failed
outcome) to the 「KBEngine 热更新」 OUTPUT channel.
> Version numbers only describe how many times the disk changed and where the
> baseline sits — they never claim a reload took effect.

## 4. IDE-HOT-101 [P1] Reload channel abstraction (the transport interface)

### 4.1 Interface

```ts
interface ReloadTransport {
  /** Channel identifier (for config/audit): 'kbengine-official' | 'http' */
  readonly kind: 'kbengine-official' | 'http';
  /** Connectivity test (for the config panel button) */
  probe(): Promise<{ ok: boolean; detail: string }>;
  /**
   * Send a set of files for reload. Returns a receipt stream — every receipt
   * (accepted/applied/failed) is pushed item by item; the HTTP implementation
   * = the existing onHttpResponse surface, the official implementation =
   * console output parsing.
   */
  send(
    target: { rootId: string; targetId: string },
    fileSet: readonly string[],
    onReceipt: (receipt: ReloadReceipt) => void,
    senderDigests?: ReadonlyMap<string, string>
  ): Promise<ReloadSendSummary>;
}
```

`ReloadReceipt` reuses the existing receipt shapes
(`{status:'accepted'|'applied',file,digest?}` or
`{status:'failed',file,reason}`) — no new protocol.

### 4.2 Built-in implementation A: the official KBEngine option (depends on the engine's reloadScript, via the console)

- The engine's official reload surface = Python
  `KBEngine.reloadScript(fullReload)` (AUD-007 survey; registered on both
  baseapp/cellapp), **no HTTP receipt**.
- Reach path = via the existing `KBEngineTelnetClient` (console) executing
  `reloadScript(fullReload)` (or an equivalent console command) on
  baseapp/cellapp; fullReload=true full, false incremental — chosen by
  whether the file set involves def.
- Receipt = console output line parsing; **no JSON receipt protocol** — this
  implementation can only provide "command sent / console echoed"-grade
  evidence and never claims applied (AUD-007 rule: the engine has no applied
  receipt; applied can only come from the HTTP channel under the
  extension-side custom contract).

### 4.3 Built-in implementation B: the in-house receiver (the HTTP option, built in this repo)

- Follows the deployment config's `HttpRequestEntry` shape (url/method/
  headers/body templates), with placeholder substitution of the file list
  (existing `${module}`/`${filename}` etc. + this design's extension
  `${files}` = the file-list JSON / `${fileList}` = comma-separated).
- F3 round three (2026-11-06 re-review): the request body automatically
  carries a `sender_digests` field — content sha256 frozen at send time (the
  IDE-AUD-006 baseline) delivered with the payload, shaped
  `{"files":[...],"targetId":"...","sender_digests":{"<file>":"<sha256 hex>"}}`.
- F3 round four (2026-11-06 re-review, design level): the applied path
  changes to **the receiver writing the artifacts itself** — after reading
  the contents per the payload's files, the receiver's own code writes them
  directly into the engine directory (`--artifact-dir`), then recomputes the
  artifact's sha256 and only replies applied when it matches
  `sender_digest`.
- The external apply-command mode (`--apply-command`) is demoted: command
  side effects are unverifiable (the receiver cannot prove the artifact was
  written by this command), so exit 0 earns at most accepted — never applied,
  never entering the application ledger; command execution failure is still
  failed. The no-op scenario can by design never produce a fake applied.
  (F3 round five's "rollback best-effort/restore original content" wording is
  retired per the round-seven ④ / round-eight ② mechanisms: under the
  current mechanisms, pre-existing artifacts are never touched; cleanup only
  removes "confirmed self-built" temp files.)
  Reference implementation: `scripts/hot-reload-receiver/referenceReceiver.mjs`.
- F3 round seven (2026-11-07 seventh re-review: namespace uniqueness +
  dangling-symlink sealing + temp+rename atomic write):
  - **The artifact namespace only accepts paths inside the staging root
    (`--root`)**: absolute paths outside the root reject the whole batch
    outright (failed receipt; nothing written, nothing in the ledger) —
    round six's "outside-root fallback expanding the full structure by
    absolute path" shared one namespace with in-root relative paths
    (`/stage/tmp/X.py` and `/tmp/X.py` both map to `tmp/X.py`, so separate
    batches overwrite each other); after the fix, collisions cannot exist by
    mapping rule. The send side sends only staging-root paths in sync: the
    reference sender (`roundtripProbe.mjs`) verifies before sending that each
    file is inside the staging root and refuses out-of-bounds sends.
  - **Symlink escape protection (lstat rejects links)**: before writing, the
    artifact path's parent chain is resolved via realpath first (any level
    resolving outside `--artifact-dir` is rejected), then the final component
    is lstat'd — if it is a symlink (dangling or not) it is rejected outright
    (failed receipt; nothing written or deleted). Round six only did
    realpath: for a dangling symlink "pointing at a nonexistent file outside
    the directory", realpath throws ENOENT and falls back to the deepest
    existing ancestor (the engine directory itself), misjudging it safe, and
    the write escapes along the dangling link; lstat does not follow links
    and gets symlink status even when dangling — that road is sealed.
  - **temp+rename atomic write (check-then-write TOCTOU eliminated)**: the
    artifact is first written as a self-built temp file created exclusively
    with `'wx'` inside the engine directory (process-unique name, never
    colliding; O_EXCL never writes along any existing path — including
    symlinks); the content sha256 vs `sender_digest` verification all happens
    on the temp file, and finally `fs.rename` atomically replaces it into the
    artifact position — rename does not follow a target symlink, so even a
    race that swaps the artifact position for a symlink after the check gets
    the whole thing replaced rather than written through; the rename target's
    directory components are built from the realpath-resolved real parent
    (no symlink intermediate layers in the path). The temp file passes the
    same lstat/realpath checks before writing.
  - **Failure cleanup only removes self-built temp files**: disk-write
    failure/read-back failure/hash mismatch/rename failure are all failed;
    cleanup only unlinks the temp file, reporting `rollback_failed` honestly
    on failure (= the leftover temp file path), and notes no residue only
    when fully cleaned — pre-existing artifacts in the engine directory are
    never touched end to end, so the original artifact is naturally preserved
    (rounds five/six's "restore original content" rollback path is retired;
    pre-existing artifacts are never mistakenly deleted or rewritten). The
    ENOENT-only semantics of reading the old artifact before writing is
    kept: non-ENOENT read exceptions (`EACCES`/`EISDIR` etc.) still honestly
    refuse the write without touching, never overwriting an unverifiable
    pre-existing artifact.
- F3 round eight (2026-11-08 eighth re-review: directory-race containment
  verification + cleanup clearance flag + staging unique subdirectory):
  - **Rename target parent directory double verification**: immediately
    before rename, `realpathSync(parent dir)` and verification of ①
    **containment** — the resolved result must be inside the engine directory
    (realpath); ② **consistency** — the resolved result must be verbatim
    identical to the original path (otherwise the path contains a symlink
    component); failing either rejects the file (failed receipt; nothing
    written, nothing in the ledger); on pass, the resolved real parent does
    the rename. Round seven's pre-rename realpath only took without
    verifying: if a middle directory was race-swapped to an external symlink,
    rename landed outside the engine directory; swapped to an internal link,
    it still arrived elsewhere along the symlink component. **The residual
    window is recorded honestly**: JS has no `O_NOFOLLOW`, so in the instant
    between realpath and rename the parent chain can still be race-swapped
    (window = adjacent syscall spacing, cannot be zeroed); swaps within the
    window are caught by the same containment+consistency verification;
    cross-window races are honestly a known limitation — never claimed as
    "eliminated".
  - **Failure cleanup only removes "confirmed self-built" temp files**: the
    `'wx'` exclusive `openSync` succeeding is an independent **creation
    success point**; temp-file verification order = create → write →
    lstat/realpath check → read-back verification → rename. When creation
    itself fails (`EEXIST` etc.), the same-named existing file is not this
    creation's, and cleanup never touches it (round seven's failure branch
    unconditionally unlinking could delete a file this run did not create —
    that road is sealed); only failures after creation success (half-written
    `EFBIG`/read-back failure/hash mismatch/rename failure) permit cleanup to
    unlink the self-built temp file, reporting `rollback_failed` honestly on
    failure.
  - **Staging copies get their own unique subdirectory**: staging copies no
    longer land at the staging-root top level by basename — in the same
    batch, `<root>/sub/X.py` and `<root>/X.py` had the same top-level staging
    path, so the former's staging action would directly overwrite the
    latter's **source file** (the later read-back would get polluted content,
    and digests naturally mismatch). After the fix, staging expands along the
    sanitized collision-proof payload relative path to
    `<root>/.staged/<relative path>` (the same collision/escape-proof rule
    set as artifact mapping), so same-batch entries never overwrite each
    other and never touch any source file or the application ledger.
- F3 round nine (2026-11-06 ninth re-review: staging namespace isolation +
  staging-path symlink protection + cleanup dev/ino comparison):
  - **Source namespace and staging namespace are disjoint**: round eight's
    `.staged` prefix was still inside the allowed source tree — when a batch
    contained a pre-existing `<root>/.staged/X.py` source file, the staging
    copy of `<root>/X.py` would `copyFileSync` right over that source. After
    the fix, a source path whose first segment is `.staged` belongs to the
    receiver's staging namespace and rejects the whole batch (the same line
    of defense as path sanitization). **Symlink alias gap closed**: lexical
    exclusion cannot stop aliases pointing into the staging tree (with
    `root/alias → root/.staged`, same-batch staging copies would still
    overwrite the aliased source file); after the fix, every source file is
    realpath-resolved, and a resolution landing inside the staging tree (the
    realpath of `<root>/.staged`) rejects the whole batch.
  - **Staging-path pre-write double verification** (`safeStagingTarget`):
    staging writes previously had no symlink checks; if any level of the
    `.staged` chain was swapped for a symlink, `copyFileSync` would escape
    along the link or write to the wrong place. After the fix, the staging
    parent chain resolves to its **deepest existing ancestor** and verifies:
    containment (inside the staging-root realpath) + consistency
    (**relative comparison**: the resolved path's path relative to the
    staging root must be verbatim identical to the original's — in-tree
    symlink components are rejected, while the staging root's own legitimate
    symlink ancestors (such as macOS `/tmp`) are not misjudged) + realpath
    failure with existing components (a dangling symlink chain) rejected
    outright + `lstat` on the final component rejecting symlinks; failing any
    check rejects that file's staging. **The residual window is recorded
    honestly**: the check→mkdir→copy instant races at the same level as
    rename and is never claimed as "eliminated".
  - **Cleanup dev/ino comparison**: the "confirmed self-built" flag cannot
    stop "the path being race-swapped after creation but before cleanup"
    (the swapped file has no tie to the creation determination). After the
    fix, the creation success point captures the temp file's dev/ino via
    `fstatSync(fd)`, and before cleanup unlink, `lstat` compares the path's
    current dev/ino with the capture — deleting only on match; on mismatch
    or a missing capture (identity unverifiable) it skips and reports
    `rollback_skipped` honestly. **The residual window is recorded honestly**:
    in the instant between the lstat comparison and unlink the path can
    still be race-swapped (window = adjacent syscall spacing, cannot be
    zeroed), the same level as the realpath→rename window — honestly a known
    limitation.
- Receipt = the response body goes through the existing accepted/applied
  parsing (HOT-003/004); this is the **only** channel that can produce
  applied evidence (AUD-007: `{"status":"applied",...}` is an extension-side
  custom contract, applied to the response body of the user-configured
  `@http:` URL).

### 4.4 Channel selection

- Channels are configured per **deployment profile**: under a
  `ProjectProfile`'s `id` hangs `hotReload.channel =
  'kbengine-official' | 'http'` + that channel's parameters.
- No channel configured → fall back to the existing
  `kbengine.hotReload.actionName` quick-action channel (`@http:`/script),
  behavior identical to the current state.
- **Structural def changes still take IDE-HOT-005's "restart required" path
  and never enter a hot-reload channel** (no channel sends an ordinary
  reload for a structural def batch).

### 4.5 Acceptance (IDE-HOT-101)

1. `send` delivers the file set per channel: HTTP channel = the existing
   HTTP request surface (url/method/headers/body templates + `${files}`
   placeholder); official channel = console reloadScript.
2. The receipt stream pushes item by item: HTTP channel = response-body
   parsing (accepted/applied); official channel = console echo (never
   produces applied).
3. Channels are chosen per deployment profile; unconfigured falls back to
   the existing actionName channel.
4. Structural def batches enter no hot-reload channel (they go to
   IDE-HOT-005's restart path).
5. `probe()` connectivity test: HTTP = endpoint reachable; official =
   console connectable.

## 5. IDE-HOT-102 [P2] Reload configuration and audit

### 5.1 Configuration panel

- A deployment-level reload channel configuration panel (in-house receiver /
  official KBEngine): a `hotReload` section under `ProjectProfile`, with
  channel choice + parameters (in-house receiver: url/method/headers/body
  templates; official: fullReload default).
- **One-click preset enablement (quick enable)**: a first screen of three
  presets — in-house receiver [recommended] (default parameters
  `http://127.0.0.1:8000/reload`, POST, body `{"files":${files}}` — a **JSON
  object body**; only object bodies get `targetId`/`sender_digests`
  auto-attached by the transport, and only after the receiver verifies the
  digest does it reply applied; a bare `${files}` array body can never reach
  applied, so presets and advanced config share this same default body) /
  KBEngine official (default `127.0.0.1:2560`) / unconfigured, plus an
  "advanced configuration" entry. A single profile goes straight to the
  preset first screen, multiple profiles pick a profile first — at most 2
  steps, zero input boxes; choosing a preset runs `transport.probe()` for
  one-click liveness, and **the profile is written only on pass**; on
  failure it honestly reports "liveness failed, not enabled" and points back
  to advanced config. The multi-step flow (choose channel → collect
  parameters one by one → save/probe) stays inside advanced configuration
  (the command with `{ entry: 'advanced', profileId }` jumps straight to
  that profile's  advanced flow). The receiver port must align: start with
  `node scripts/hot-reload-receiver/referenceReceiver.mjs --port 8000
  --root <staging root> --mode apply` (the script defaults to `--port 0`, a
  random port).
- **Connectivity test button**: calls `transport.probe()`, displaying
  ok/detail in the panel.
- **Status-bar quick switch**: the channel light shows the **currently
  configured** channel (`Hot reload: in-house HTTP` etc.); clicking pops a
  three-choice QuickPick to switch (choosing runs liveness immediately:
  green = passing and written to disk / red = nothing written; the red
  marker and tooltip name the channel just tried, and the light text never
  poses as an unwritten state); one-click fix jumps to that profile's
  advanced flow; liveness conclusions are owned by "active profile + channel
  configuration identity" and are voided by profile switches/parameter
  changes/panel writes, and a state change during liveness wait voids that
  result without writing. It is a separate light and color from the existing
  send-state light (priority 98); the channel light is 96.
- **Default keybinding**: `contributes.keybindings` registers `ctrl+alt+r`
  for `kbengine.hotReload.configureChannel` (macOS `cmd+alt+r`, no `when`
  narrowing), callable with zero configuration; the keybinding avoids
  `ctrl+alt+h` (the configuration guide's HTTP quick-request example key)
  and the telnet panel keybindings.
- Structural def's "restart required" hint shares one source with the
  existing `setRestartRequired`.

### 5.2 Audit

- Every reload action enters the audit: **who / when / which files / channel
  / result**.
  - who = the trigger source (watcher automatic / manual command / retry /
    temp edit).
  - when = injected clock timestamp.
  - which files = the file set.
  - channel = `transport.kind` (or the quick-action name of the actionName
    fallback channel).
  - result = terminal state (APPLIED/FAILED/unconfirmed) + detail.
- Audit landing = the existing `KBEngine hot reload` OUTPUT channel
  (hotReloadStatus.log) + the ledger `HotReloadDeliveryRecord` (the existing
  source of truth; no second one). The audit surface adds the two fields
  "trigger source/channel" to the record or an independent audit line.

### 5.3 Acceptance (IDE-HOT-102)

1. The configuration panel reads/writes channel and parameters per
   deployment profile; unconfigured falls back to existing behavior.
2. The connectivity test button calls probe and displays the result.
3. Every reload action's audit line carries the five elements
   who/when/which files/channel/result.
4. Structural def's restart-required also enters the audit
   (channel = "intercepted: restart required").

## 6. Boundaries and red lines

- **No receipt protocol, no posing**: the official channel (the engine's
  native reloadScript has no JSON receipt) and the HTTP channel are
  distinguished per AUD-007 — applied can only come from the HTTP custom
  contract's response body; the official channel offers at most
  "sent / console echoed" and never marks applied.
- **Never mtime**: state determination uses content hash only.
- **Reuse existing vocabulary**: state machine/channels/audit all use the
  repo's existing surfaces (ledger, receipt parsing, def structure gate,
  console client, ProjectProfile) — no second identity system.
- **No new dependencies**: no npm/cargo packages added; reuse the
  node:crypto sha256 primitive.
- **Documentation precedes code**: this document is a review draft; `src/`
  is not touched before review passes.

## 7. Implementation order (after review passes)

1. IDE-HOT-100: the state-machine module (`src/hotReloadFileState.ts`) +
   file tree badges/CodeLens/filter + prove-red.
2. IDE-HOT-101: the `ReloadTransport` interface + two implementations
   (HTTP reuses the existing request surface, official goes through the
   console) + per-profile selection + prove-red.
3. IDE-HOT-102: the configuration panel + connectivity test + the audit's
   five elements + prove-red.

Each step's gate = lint + tsc + test:unit + xvfb demo, checked lines carry a
commit hash, and the docs (features.md/zh) reconcile in sync.

## 8. Default behavior (user directive 2026-11-06 · landed)

1. **On by default**: `kbengine.hotReload.enabled` defaults to `true` — the
   `package.json` contribution default and `readHotReloadSettings`'s default
   change together, so it is on even when configuration is missing;
   **an explicit hard `false` still turns it off** (an explicit user off must
   take effect). The default `globs` are untouched (`**/*.py`), the default
   debounce stays `500ms`.
2. **Zero-config out of the box**: with `kbengine.hotReload.actionName` empty
   (the default), saving a .py → debounce → the default hot-reload request
   `POST http://127.0.0.1:8090/hotfix?module_name=<module name>`, with the
   body also carrying `module_name=<module name>` (one copy in query and one
   in body, compatible with different server-side parameter-reading
   conventions; harmless duplication of the same value). The endpoint and
   parameter name are defined in exactly one place, `BUILTIN_HTTP_REQUEST_EXAMPLE`,
   consumed from the same source by `src/hotReloadDefaultHotfix.ts`, with
   test-locked sync to the `package.json` default; the repo-wide old spelling
   is asserted purged by full grep in `tests/hotfixSpellingGate.test.ts`.
3. **Module-name rule**: prefer `resolveModuleDualName` (book §19.1, the same
   discipline as file-change-meta); when
   `kbengine.hotReload.tempEdit.scriptRoot` is unset or that file's resolution
   does not support it, fall back to `${module}`'s `__init__.py` package-boundary
   scan (the same placeholder source as the default example template — no new
   placeholder).
4. **Honest reporting**: connection refused/timeout/non-2xx are all `failed`
   (status bar + log with cause; if the engine is not up, it honestly reports
   failure); 2xx only reaches "sent (unconfirmed)" — the status bar never
   marks effective. The default path pops no error dialog (one per save would
   flood); causes land in the audit log.
5. **One-click off**: clicking the status bar's "hot reload" item runs
   `kbengine.hotReload.toggle`, which **writes the configuration back**
   (`kbengine.hotReload.enabled`; Workspace if a workspace file exists,
   otherwise Global); the configuration-change listener immediately
   tears down/rebuilds the watcher, effective without restarting the window;
   a non-modal notice states the new state and offers an "open log" entry.
   The command surface and the status-bar click share one path.
6. **First-activation notice**: the first activation pops a one-time
   non-modal notice (naming the endpoint and the one-click off entry),
   recording a `workspaceState` flag on pop so it never disturbs again;
   choosing "turn off now" writes the configuration back and disables hot
   reload directly. A minimal assembly context (no `workspaceState`) pops
   nothing.
7. **Structural def still intercepted**: the default path likewise runs after
   the def structure gate; structural changes are still intercepted whole-batch
   and marked `RESTART_REQUIRED` (no loosening).

## 9. Architecture boundary: HTTP hot-reload requests are issued by TS (not up for renegotiation)

**Conclusion (user directive 2026-11-06, effective as written): HTTP
hot-reload requests are issued by the extension (TS), not by Rust.**

Reasons:

1. `HttpReloadTransport` (`src/hotReloadTransport.ts`) already implements the
   full set — placeholder substitution / sender_digests freezing / targetId /
   receipt parsing / ledger;
2. Rust's 13 crates have zero HTTP client dependencies; adding reqwest hits
   the "zero-dependency iron rule";
3. The event source is already the VS Code watcher; events, meta info, module
   names, and the version ledger all live in TS — Rust sending would require
   a round trip back through IPC;
4. If Rust dies, hot reload still works (the structure gate and other
   judgments already live on the TS side); Rust sending would weld hot reload
   to the Rust process.

**Boundary**: TS owns orchestration and transport (state machine, ledger,
receipts, HTTP requests); Rust owns pure computation (parsing / indexing /
cloning). Rust is a spawned pure-function service and carries no I/O or
state.

**Exception**: if the future needs a resident Rust long connection/connection
pool to the engine (high-frequency batch pushes), sinking it will be
re-evaluated — provided the event and meta-info protocols have been made
pure data by then, so the implementation can change without changing the
contract.
