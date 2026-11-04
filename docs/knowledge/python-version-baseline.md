# Python version baseline: 3.7 source material vs fork 3.12

> KB-001 · KB-API-001 (P0) version baseline. The official KBEngine `docs/api`
> source material (kbengine fork `docs/api/`, CHM conversion) was written
> against the 3.7-era embedded runtime; the fork builds against CPython 3.12
> on Windows. This page fixes the version baseline every KB-API-002~008
> article annotates against. Grounding is split into two domains and every
> claim is marked with its domain:
> - **Fork domain**: `kbe/src` at `/home/cui/workspaces/kbengine`
>   (fork HEAD `6d12b8f`; grounding base `c2a3b8f` is an ancestor of HEAD and
>   every line cited below was re-verified at HEAD on 2026-11-04).
> - **Python domain**: official CPython release notes at `docs.python.org`
>   (URL given per claim). The vendored `kbe/src/lib/python/` tree is neither
>   in git nor on disk, so 3.7→3.12 deltas are **never** reverse-inferred
>   from the 3.7 sources — the official 3.12 change record is the only
>   reference.
>
> Companion pages: [Entity lifecycle & reference release](entity-lifecycle-reference.md),
> [Fixed directories and path resolution](fixed-directories-and-path-resolution.md).

## 1. Version timeline

| When | What | Evidence |
| --- | --- | --- |
| Upstream KBEngine (official v3.x line) | Embedded runtime is vendored CPython **3.7.3** at `kbe/src/lib/python` | Fork doc `docs/zh/guide/engineering/python-3.12-upgrade.md:7-9` (stated baseline; the fork flipped its locale layout — `docs/guide/engineering/python-3.12-upgrade.md` is a redirect stub to this zh page); the vendored tree itself is not tracked (see §2.4) |
| 2026-09-25 | Fork import commit `0bc93d5` (repo root, single root, 95 commits) **already carries the 3.12 build glue**: 9 Windows `.vcxproj` link `python312(_d).lib`, `script.cpp` has the 3.11+ `PyConfig` init path | `git rev-list --max-parents=0 HEAD` = `0bc93d5`; `kbe/src/server/baseapp/baseapp.vcxproj:118` (`python312_d.lib`), `:174` (`python312.lib`); `kbe/src/lib/pyscript/script.cpp:26-88` |
| 2026-11-02 | Linux build + full server startup **verified against Python 3.7.17** (deadsnakes `libpython3.7m.so`, CMake `Python3_LIBRARY`/`Python3_INCLUDE_DIR`); 9 server processes alive, DB tables created | `BUILD-NOTES.md` as committed in `855a06d` (baseline commit `a3c481d`); the file is **not present at HEAD** — read it via `git show 855a06d:BUILD-NOTES.md` |
| 2026-11-02 | Grounding base commit `c2a3b8f` | `git show -s c2a3b8f` |
| 2026-11-04 (HEAD `6d12b8f`) | Build files contain **zero** `python37` references; the Unix `Makefile` is version-agnostic (detects `libpython*.a`); the upgrade guide page still describes the 3.7.3 baseline — doc drift, see §2.2 | `grep -rl python37 kbe/src` = 0; `kbe/src/lib/Makefile:46`; `docs/zh/guide/engineering/python-3.12-upgrade.md:8` |

**No in-repo 3.7→3.12 transition commit exists**: the fork's history starts at
`0bc93d5` with the 3.12 glue already in place, and the 3.7 vendored sources
were never committed. The only in-repo record of the 3.7 state is the fork's
own docs and the `BUILD-NOTES.md` build log.

## 2. Runtime baseline: the four verified facts

1. **Windows projects already link 3.12.** Nine `.vcxproj` files reference
   `python312_d.lib` / `python312.lib` — e.g.
   `kbe/src/server/baseapp/baseapp.vcxproj:118` and `:174`; the full list:
   baseapp, cellapp, dbmgr, loginapp, bots, guiconsole, interfaces, kbcmd,
   logger. `grep -rl python37 kbe/src --include=*.vcxproj` returns nothing.
2. **The fork's own upgrade docs are stale (source-repo drift).**
   `docs/zh/guide/engineering/python-3.12-upgrade.md:8` still says "当前 vendored
   版本是 3.7.3" and `:18-21` lists blockers (old `Makefile` lib naming,
   `PyEval_InitThreads`, hardcoded `python37`) that are already resolved at
   HEAD (Makefile is version-agnostic at `kbe/src/lib/Makefile:46`; see §3
   for the other two). `docs/python-3.12-upgrade-notes.md` and
   `docs/zh/python-3.12-upgrade-notes.md` are compatibility stubs pointing to
   that guide page. Per task scope this drift is **recorded here, not fixed** —
   it lives in the kbengine repo.
3. **`script.cpp:255` still contains a `PyEval_InitThreads()` call**, but the
   call site is neutralized for 3.11+ builds: `scriptstdouterrhook.h:11-15`
   (included via `script.h:11`) defines `PyEval_InitThreads()` as `((void)0)`
   when `PY_VERSION_HEX >= 0x030B0000`. Under a 3.12 build the text-level call
   at `script.cpp:255` expands to a no-op — no runtime call, no deprecation
   warning. Official status ([Python domain](https://docs.python.org/3/whatsnew/3.13.html#c-api-changes)):
   no-op since 3.7, deprecated since 3.9, removed in 3.13 (then restored as
   deprecated in 3.13 beta, [gh-117929](https://github.com/python/cpython/issues/117929)).
4. **The vendored `kbe/src/lib/python/` tree is not recoverable from the
   fork**: `git ls-files kbe/src/lib/python` = 0 entries at HEAD and at every
   revision (`git log --diff-filter=A` is empty), the directory is not on
   disk, and no `.gitignore` rule excludes it — it was simply never committed.
   Consequence: all 3.7→3.12 deltas must cite the official Python change
   record; the 3.7 `docs/api` CHM material must not be treated as source code
   truth.

## 3. Embedding-layer C API audit (`kbe/src/lib/pyscript` + `lib/server`)

Sweep pattern: `Py_UNICODE`, legacy `PyUnicode_*` wstr APIs, `PyString_*`,
`PyEval_Call*`, `Py_SetProgramName`, `Py_SetPythonHome`, `Py_SetPath`,
`Py_SetProgramFullPath`, `PySys_SetArgv(Ex)`, `PySys_SetPath`,
`PyEval_InitThreads`, `Py_InitModule`, `PyOS_AfterFork`, and the removed
`PyArg_ParseTuple` format codes `u` / `Z`. Result: `lib/server` and
`lib/client_lib` are **clean (0 hits)**; `lib/pyscript` yields exactly four
symbols:

| Symbol | Site (fork domain) | Under 3.12 | Under 3.13+ | Verdict |
| --- | --- | --- | --- | --- |
| `PyEval_InitThreads()` | `script.cpp:255` (call text) | Compiles as no-op — shadowed by the macro at `scriptstdouterrhook.h:11-15`; officially a deprecated no-op ([Python domain](https://docs.python.org/3/whatsnew/3.13.html#c-api-changes)) | Macro guard covers 3.13 too (function removed in 3.13, restored deprecated, [gh-117929](https://github.com/python/cpython/issues/117929)) | **No action** — dead text remains, behavior correct |
| `Py_SetPythonHome()` | `script.cpp:203` — **unconditional** (outside any version guard) | Deprecated since 3.11, still present, functional ([Python domain](https://docs.python.org/3/whatsnew/3.13.html#c-api-changes)) | **Removed in 3.13** → this line would fail to compile against 3.13 headers | **Must change before any 3.13 target** (replace with `PyConfig.home`, already done in the 3.11+ branch at `script.cpp:38`) |
| `PySys_SetArgvEx(0, NULL, 0)` | `script.cpp:239` — **unconditional** | Deprecated since 3.11, still present ([Python domain](https://docs.python.org/3/whatsnew/3.13.html#c-api-changes)) | **Removed in 3.13** → compile failure against 3.13 headers | **Must change before any 3.13 target** (`PyConfig.argv`, set via `config.parse_argv = 0` at `script.cpp:31`) |
| `Py_SetPath()` | `script.cpp:226` — inside the `#else` branch of `#if PY_VERSION_HEX >= 0x030B0000` (`script.cpp:215-235`) | **Not compiled** — dead under a 3.12 build | Same (branch still pre-3.11-only) | **No action** — dead code under current targets |

Legacy-Unicode sweep: **zero** hits for `Py_UNICODE` / `PyUnicode_AS_UNICODE`
/ `PyUnicode_FromUnicode` / `PyUnicode_GET_SIZE` / `PyString_*` anywhere in
`kbe/src` — PEP 623 removals ([Python domain](https://docs.python.org/3/whatsnew/3.12.html#porting-to-python-3-12))
do not bite this codebase. Removed `PyArg_ParseTuple` format codes `u`/`Z`
(same official source): zero hits.

## 4. Script-layer 3.7→3.12 deviation skeleton

Scope: only the subset that affects the KBEngine Python API integration
articles. Server-script-visible stdlib removals were swept against the fork's
own deployable templates (`kbe/res/sdk_templates/`, `kbe/res/scripts/`):

| Item | Official record (Python domain) | Fork-side check (fork domain) | Status |
| --- | --- | --- | --- |
| `distutils` removed (PEP 632) | [What's New 3.12](https://docs.python.org/3/whatsnew/3.12.html) | `import distutils` in templates/scripts: 0 hits | Verified — no deviation triggered |
| `asynchat` / `asyncore` removed | [What's New 3.12](https://docs.python.org/3/whatsnew/3.12.html#removed) | `import asyncore`/`import asynchat`: 0 hits | Verified — no deviation triggered |
| `imp` deprecated 3.11, removal announced for 3.12 | [What's New 3.11](https://docs.python.org/3/whatsnew/3.11.html) | `import imp`: 0 hits | Verified — no deviation triggered |
| int↔str conversion digit limit (default 4300, base≠2/4/8/16/32) | [3.11 changelog, CVE-2020-10735 mitigation](https://docs.python.org/release/3.11.1/whatsnew/changelog.html) | Largest scripted integer is `genUUID64` = unsigned 64-bit → ≤ 20 digits (`script.cpp:106` `PyLong_FromUnsignedLongLong`); entity integer properties are INT8..INT64-range declarations (`datatypes.cpp:58` `UINT64`, `:64` `INT64`) | Verified inference — no KBEngine API surface impact |
| Remaining str/bytes/iterator semantic deltas 3.8→3.12 | official What's New 3.8–3.12 | — | **待取证 (to be evidenced)** — path: sweep official What's New 3.8/3.9/3.10/3.11/3.12 per KB-API topic when its article is written, then run the 3.12 server build against official `python_assets` scripts. Do **not** infer from the 3.7 CHM text (see §2.4) |
| Other embedded-C-API deltas beyond the four above | official What's New 3.12/3.13 | — | **待取证** — path: re-run the §3 sweep against each new CPython minor the fork declares; today no other hits exist |

## 5. Impact on kode plugin users (script authors)

Only fork-landed / fork-declared facts; no speculation about unimplemented
migration steps:

- **Dual build reality**: Windows builds are pinned to CPython 3.12
  (`baseapp.vcxproj:118` and 8 siblings, §2.1); Linux builds link whatever
  `find_package(Python3 ... Development)` resolves — a 3.7.17 build was
  verified working on 2026-11-02 (`git show 855a06d:BUILD-NOTES.md`). Scripts
  should stay compatible with **both** 3.7 and 3.12; the engine source has
  version-conditional paths for exactly the `PY_VERSION_HEX >= 0x030B0000`
  boundary (`script.cpp:26`, `:215`).
- **Embedded interpreter environment is sealed**: on 3.11+ the init path sets
  `site_import = 0`, `use_environment = 0`, `parse_argv = 0`,
  `install_signal_handlers = 0` (`script.cpp:31-36`); the pre-3.11 branch
  sets `Py_NoSiteFlag = 1`, `Py_IgnoreEnvironmentFlag = 1`
  (`script.cpp:223-224`). Practical reading for both baselines: `PYTHONPATH`
  / env vars do not reach the embedded runtime, `sys.argv` is empty, no
  `site-packages`, and the engine does not install Python signal handlers.
- **Stdlib layout is engine-owned**: module search paths come from
  `SCRIPT_PATH`-derived engine script dirs (`script.cpp:200`, `APPEND_PYSYSPATH`
  at `:200`, `PyConfig.module_search_paths` at `:35-74`; legacy
  `Py_SetPath` at `:226`). The engine expects `kbe/res/scripts/common/` to be
  the stdlib root of the deployed layout (declared in
  `git show 855a06d:BUILD-NOTES.md`, 坑 7) — deploy stdlib there; do not
  assume a system Python installation.
- **Nothing else changed for scripts at the C boundary**: the audit in §3
  found no legacy-Unicode usage, no removed format codes, and the init path
  is already `PyConfig`-based on 3.12 — server script code written for
  official-3.7 docs runs through the same `Script::install()` registration
  path (`script.cpp:197-289`) regardless of baseline.

## 6. Relation to official KBEngine v3.7 material

- The fork is **not** official KBEngine v3.7: upstream's embedded runtime was
  vendored 3.7.3, the fork's Windows build targets 3.12 and its Linux builds
  are interpreter-agnostic (§1, §2.1).
- The knowledge base grounds on **this fork** (`c2a3b8f` ancestor of HEAD
  `6d12b8f`). Where the official 3.7-era `docs/api` CHM material and the fork
  disagree, **the fork wins** and the disagreement is annotated, not silently
  resolved.
- The source repo's own upgrade guide (`docs/zh/guide/engineering/
  python-3.12-upgrade.md:8`) still stating "vendored 3.7.3" is recorded as
  upstream doc drift (§2.2); KB articles must not cite that page as
  authoritative for the runtime baseline — cite §2 of this page instead.
- Fixing that drift page is a kbengine-repo task and is **out of scope** for
  KB-API-001.

## 7. Deviation-annotation template for KB-API-002~008

Every KB-API article ends with a fixed-format deviation section (keep the
heading, fill the rows; state "无偏离 / No deviation" explicitly when the
table is empty — do not leave the section out):

```markdown
## 3.7 source material vs fork 3.12 deviations

| Item | Official 3.7-era source material says | Fork 3.12 actually does | Domain | Evidence |
| --- | --- | --- | --- | --- |
| <API/behavior> | <claim from docs/api CHM text> | <verified fork behavior, or "same — no deviation"> | Fork / Python / Plugin-layer | `kbe/src file:line` or official CPython URL or "Plugin-layer (outside this repo)" |
```

Rules:
1. Every row cites exactly one evidence domain, marked in the **Domain**
   column: `Fork` (`kbe/src` file:line), `Python` (official
   `docs.python.org` URL), or `Plugin-layer` (implementation outside
   `kbe/src` — used for client-SDK APIs per KB-API-002 scope).
2. Unverified rows are written as **待取证 / to be evidenced** with the
   evidence path (which grep, which official page, which runtime test) —
   never left blank, never filled with plausible text.
3. Items in §4 of this page that are already "Verified — no deviation" may be
   referenced by pointer ("see python-version-baseline §4") instead of being
   re-proven per article.
4. The en article is canonical for line-number drift checks; the zh mirror
   carries identical claims and citations.

## References

- Fork: `kbe/src/lib/pyscript/script.cpp` (`:26-88`, `:197-289`), 
  `scriptstdouterrhook.h:10-15`, `script.h:11`, `kbe/src/lib/Makefile:46`,
  `kbe/src/server/baseapp/baseapp.vcxproj:118`, `:174`,
  `kbe/src/lib/entitydef/datatypes.cpp:53-64`
- Fork history: root `0bc93d5` (2026-09-25), `855a06d` (2026-11-02,
  `BUILD-NOTES.md`), `c2a3b8f` (grounding base), HEAD `6d12b8f`
- Fork docs: `docs/zh/guide/engineering/python-3.12-upgrade.md` (stale
  baseline; `docs/guide/engineering/python-3.12-upgrade.md` is a redirect
  stub), `docs/python-3.12-upgrade-notes.md` /
  `docs/zh/python-3.12-upgrade-notes.md` (stubs)
- Python: [What's New 3.12](https://docs.python.org/3/whatsnew/3.12.html)
  (PEP 623, PEP 632, removals),
  [What's New 3.13, Removed C APIs](https://docs.python.org/3/whatsnew/3.13.html#c-api-changes),
  [gh-117929 PyEval_InitThreads restore](https://github.com/python/cpython/issues/117929),
  [3.11 changelog: int↔str limit](https://docs.python.org/release/3.11.1/whatsnew/changelog.html)
