# File Change Meta (plan B): identity + version memoised resolution

> Status: **implemented** (`src/fileChangeMeta.ts`, `src/fileChangeMetaLog.ts`).
> This document is the authoritative wording for the field surface, the cache
> key, and the process-attribution rules; the implementation and the tests must
> match it item by item. Test ground truth:
> `tests/fileChangeMeta.test.ts` (field surface / memoisation / watcher
> independence / process attribution) and
> `tests/fileChangeMetaConsumers.test.ts` (the two consumers).

## 1. Why this module exists

`createSharedFileEventMerger` (`src/sharedFileEvents.ts`) delivers only
`fsPath`, `identity`, `kind` and a disk **version token** (`${mtimeMs}:${size}`,
see `SharedFileEvent.version`). Everything else a consumer wants — module name,
owning process, content hash, byte size — is derived **lazily** by this module,
once per `identity + version`. The watcher path itself never gains IO: the
merger stays synchronous ("first report lands immediately"), and consumers that
never `await` keep working exactly as before.

## 2. Field surface

| Field | Source | Absent when |
|---|---|---|
| `fsPath` | event / argument | never |
| `identity` | `normalizeFileIdentity(fsPath)` (same key as the merger) | never |
| `kind` | event (`create`/`change`/`delete`) | never |
| `fileName` | basename of the posix-normalised path | never |
| `ext` | `path.posix.extname(fileName)` (`.py`), `''` when there is none | never |
| `module` | `resolveModuleDualName(fsPath, scriptRoot).fullModule` — **the same 口径 as hot reload's dual-name resolution** (`.py` only, strictly inside the script root, no `__init__.py`, no single-level script, no traversal) | path unresolvable (outside script root, non-`.py`, …) — never invented |
| `package` | first segment of `module` | `module` absent |
| `processKind` | path attribution, see §5 | unresolved |
| `processSource` | `'path'` when attributed, `'unresolved'` otherwise | never |
| `processReason` | why it is `shared` / `ambiguous` / `unresolved` | attributed to a single process |
| `processCandidates` | candidate list for `ambiguous` (path order, de-duplicated) | any other verdict |
| `sha256` | `createHash('sha256')` over the file bytes — same primitive as `hotReloadDefHash` / the hot reload `sentDigest`; **read-time snapshot**, see §3 | `kind === 'delete'` (no content to hash, **not** a failure) or read failed |
| `size`, `mtimeMs` | from the version token when it parses, else from `stat` | both unavailable (no token + `stat` failed) |
| `version` | event token, else the token this resolver stat'd | `stat` failed and the event carried none |
| `reason` | concatenation of `stat`/read failures (`'; '`-joined) | full resolution |

Failure rule: **partial fields plus `reason`, never a throw** — consumers call
`metaFor` without `await` on watcher callbacks, so a rejection would surface as
an unhandled rejection.

## 3. Resolution and caching (the memoisation contract)

- Key = `identity + version + path shape` (`fsPath`, `scriptRoot`). Content is
  still de-duplicated per version, while the path-derived fields (`module`,
  `package`, process attribution) are recomputed whenever the root or the path
  spelling changes — so a runtime switch of `kbengine.hotReload.tempEdit
  .scriptRoot` can never hand back a stale module/process, and two spellings of
  one file never masquerade as each other. Same root + version still returns
  **the same object** (`toBe`).
- Event carries `version` → **zero `stat`**; `size`/`mtimeMs` are parsed out of
  the token (`<mtimeMs>:<size>`, `mtimeMs` may be fractional). A token that does
  not parse (e.g. a test's `v1`) leaves `size`/`mtimeMs` undefined and still
  performs no `stat`.
- Event carries no `version` → the resolver stats once to mint the key
  (`stat` failure ⇒ `reason`, no key, **no caching**, so a transient failure is
  never pinned to that path).
- `kind === 'delete'` → no `stat`, no read, no cache entry (terminal state, no
  content to compare).
- Concurrent first requests share one in-flight promise → one read; later
  requests with the same key return **the same object** (`toBe`). A different
  `kind` on the same key reuses the parsed fields and only swaps `kind`
  (no second read).
- Failed resolutions are dropped from the cache as soon as they settle; a
  subsequent non-delete event may attempt another read.
- Bounded: the cache is an LRU capped at 512 entries (in-flight promises
  counted too); after eviction, a subsequent non-delete event may read the file
  again.
- **`sha256` is a read-time snapshot.** With an event-borne version token the
  read necessarily happens after delivery, so a concurrent write in between can
  leave the hash describing content newer than `version`. We deliberately do
  **not** spend an extra `stat` to verify — that would break the zero-stat
  contract above; the boundary is stated here instead. While the memo entry for
  the full key (identity + version + path shape) is still present and complete,
  a content change that leaves `${mtimeMs}:${size}` untouched triggers no
  re-read and is therefore invisible to this resolver — exactly the price of the
  zero-stat contract. On a cache miss (for example, after eviction or a failed
  resolution, or when the path / `scriptRoot` changes), a non-delete event may
  read the file again; a successful read refreshes the snapshot.
- The cache lives **per resolver instance**; two instances compute their own
  objects that are field-for-field equal (watcher independence: `metaForPath`
  and the event path are the same implementation and the same cache).

`metaForPath(fsPath)` is `metaFor({ fsPath, identity, kind: 'change' })` — the
manual path (no watcher, no event stream) yields exactly what the event path
yields.

## 4. Why we do not enrich synchronously

- The merger's "first report lands immediately" contract is synchronous;
  `stat` is async (KR-AUD-30 moved the hot path off `statSync`), so a
  synchronous enrich would either block the watcher callback or reintroduce
  sync IO on the event hot path.
- Old consumers subscribe and return without awaiting; making enrichment
  synchronous would put IO (and its failure modes) in front of index
  invalidation, which must stay cheap and total.
- Enrichment is therefore a **separate, lazy, best-effort** step: the meta line
  lands after the consumer has already done its job, and a failed resolve costs
  one missing log line rather than a broken callback chain.

## 5. Process attribution (KBEngine script-directory convention)

Rules, evaluated on the script-root-relative segments:

1. The path must sit **inside the script root**; anything else (asset `res/`,
   foreign trees, single-level files) → `processKind` undefined,
   `processSource = 'unresolved'`, `processReason = 'unresolved'`.
2. `base`, `cell`, `login`, `logger` at **any** depth are process segments;
   `interfaces` counts only as a **first-level** segment — a nested
   `base/interfaces/…` is that process's interface package and belongs to the
   outer process (`base/interfaces/Interface_X.py` → `baseapp`, no candidates).
3. Exactly one process segment → that process, `processSource = 'path'`, no
   `processReason`.
4. Two or more distinct process segments (anomalous layout such as
   `base/cell/…`) → `processKind = 'ambiguous'` with `processCandidates` in
   path order; **no guessing**, no silent pick.
5. No process segment, but a `common`/`user` directory → `processKind =
   'shared'` with a `processReason` (shared code belongs to no single process).
6. Nothing applies (e.g. `entity_defs/`, `bots/`, outside the script root) →
   unresolved, as in rule 1. **Never fabricate a process.**

## 6. One line format, two consumers

`formatFileChangeMeta(meta)` renders a single line:

```
Avatar.py kind=change ext=.py module=cell.Avatar package=cell process=cellapp sha256=8c66f0378e91… version=1700000000000:19
```

- hash is truncated to 12 hex chars + `…`, `-` when unavailable;
- an unresolved process prints `process=unresolved`;
- `reason=…` appears **only** when resolution failed (a clean line has no
  `reason=`), process notes print as `note=…`.

Wired consumers:

1. **Hot reload delivery** (`src/hotReload.ts`): `SetupHotReloadOptions
   .fileChangeMeta` — when injected, every audit line is followed by one
   `文件元信息: …` line per triggered file (module/process/hash/version) on the
   existing "KBEngine 热更新" log channel. Not injected ⇒ zero IO. The meta line
   is appended, never replacing the five-element audit line.
2. **Python index events** (`src/fileChangeMetaLog.ts`, wired in
   `src/extension.ts`): the index merger's subscription resolves the meta and
   writes `py 变更 …` through the existing `kbengine.jumpLog` switch and the
   "KBEngine Navigation" channel — **off by default, and off means zero IO**
   (the resolve is not even started). It is a second subscriber, so the legacy
   subscriber's synchronous contract is untouched.

## 7. Tests and gates

- `tests/fileChangeMeta.test.ts` — field surface, same-口径 module names,
  delete/`stat`/read failure honesty, memoisation (concurrent and sequential),
  watcher independence (`metaForPath` vs event), process attribution.
- `tests/fileChangeMetaConsumers.test.ts` — both wiring points: injected hot
  reload audit line, "not injected ⇒ no meta line", index leg gated by
  `jumpLog` (off ⇒ no IO, on ⇒ same line format).
- Gates: `pnpm exec vitest run`, `pnpm run compile` (tsc), `pnpm run lint`.
