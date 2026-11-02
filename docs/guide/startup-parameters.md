# Startup Parameters

KBEngine server processes accept a small set of CLI parameters and read a small set of environment variables at startup. Every server process (`machine`/`logger`/`interfaces`/`dbmgr`/`baseappmgr`/`cellappmgr`/`baseapp`/`cellapp`/`loginapp`/`bots`) parses them through the same entry point — `parseMainCommandArgs` in `kbe/src/lib/server/kbemain.h:238`. This page is the quick reference for both surfaces; every row cites the engine source that implements it.

The `kbcmd` utility and `guiconsole` are separate tools with their own parameter surfaces (`kbcmd --clientsdk`/`--outpath`/`--getuid`; `guiconsole` takes none) — they are not part of this server-process surface, so Kode's startup diagnostics never treats a `kbcmd`/`guiconsole` line as a server-process launch line.

Kode surfaces these in the editor (since KBEXP-1):

- **Hover / completion** — inside `.sh`/`.bat` startup scripts, hovering a known parameter or env var shows its bilingual doc with the engine source line; typing `--` completes CLI params and typing `KBE_` (or `$KBE_`) completes env vars. Behind `kbengine.hover.startupScript`.
- **Diagnostics** — on real server-process launch lines only: unknown `--param` (misspelling), non-numeric `--cid`/`--gus`, or `$KBE_RES_PATH`/`$KBE_BIN_PATH`/`$KBE_ROOT` referenced but never assigned in-file and never sourced. Behind `kbengine.startupScriptDiagnostics`.

The per-project config file is **`res/server/kbengine.xml`** (layered over the engine's `kbengine_defaults.xml`) — KBEngine has no `engine_config.xml`. Field-by-field hover for those XML files is covered by the server config hover, not this page.

## CLI parameters

| Parameter | Value type | Purpose | Source |
| --- | --- | --- | --- |
| `--cid=<id>` | uint64 | Component ID (the per-process unique identity). Startup scripts usually give a fixed value; omit it and the ID falls to `-1` (auto) — `machine`/`logger` derive one from UID+MAC+type, the other processes query the machine for one (`checkComponentID`) | kbe/src/lib/server/kbemain.h:250 |
| `--gus=<n>` | uint16 (≤65535) | Group order — the UUID generator section; distinguishes startup batches when running multiple instances / groups on one machine | kbe/src/lib/server/kbemain.h:278 |
| `--hide=<n>` | int (Win32) | Hide the console window on Win32 (`>0` hides; a silent no-op elsewhere). Used with `--hide=1` for extra bat-launched instances | kbe/src/lib/server/kbemain.h:302 |
| `--KBE_ROOT=<dir>` | path | Same as the `KBE_ROOT` env var, set for this process and its children | kbe/src/lib/server/kbemain.h:331 |
| `--KBE_RES_PATH=<paths>` | colon/semicolon-separated | Same as `KBE_RES_PATH`; must include `kbe/res/` plus the project `res/` and `scripts/` | kbe/src/lib/server/kbemain.h:344 |
| `--KBE_BIN_PATH=<dir>` | path | Same as `KBE_BIN_PATH`; where the server binaries live (e.g. `…/kbe/bin/server/`) | kbe/src/lib/server/kbemain.h:357 |

That is the entire CLI surface — there is no `--cidauto`; auto-ID is simply "omit `--cid`".

## Environment variables

| Variable | Read or written | Purpose | Source |
| --- | --- | --- | --- |
| `KBE_ROOT` | read | Root of the KBEngine install tree; exported by the startup script, read via resmgr. Missing means resource resolution fails | kbe/src/lib/resmgr/resmgr.cpp:140 |
| `KBE_RES_PATH` | read | Resource search path (multi-segment, colon on Linux / semicolon on Win32). Missing means the engine cannot find `kbengine.xml`/scripts and the process fails to start | kbe/src/lib/resmgr/resmgr.cpp:141 |
| `KBE_BIN_PATH` | read | Directory of the server binaries. Missing means `$KBE_BIN_PATH/<proc>` expands empty and the process cannot be found | kbe/src/lib/resmgr/resmgr.cpp:142 |
| `KBE_TIMING_METHOD` | read | High-resolution timing method (`rdtsc` / `gettimeofday` / `gettime`); defaults if unset — usually no need to change | kbe/src/lib/common/timestamp.cpp:102 |
| `KBE_COMPONENTID` | written | The component ID as a string — written by `setEvns` for script children to read | kbe/src/lib/server/kbemain.h:100 |
| `KBE_BOOTIDX_GLOBAL` | written | Global boot index, written for script children; re-exported into the Python env by baseapp/cellapp | kbe/src/lib/server/kbemain.h:101 |
| `KBE_BOOTIDX_GROUP` | written | Group boot index, same write path as above | kbe/src/lib/server/kbemain.h:102 |
| `UID` | read | User ID — separates deployments (component-ID derivation, DB account). May come from env, else `getuid()` or a hardware-digest auto-derivation (`autoFixUserDigestUID`) | kbe/src/lib/common/platform.h:566 |
| `UUID` | read | User ID override (on Linux takes precedence over `UID`/`getuid`); when set it is used as the UID | kbe/src/lib/common/platform.h:589 |

## The startup script chain

The templates in `kbe/res/sdk_templates/server/python_assets/` define the chain; the names are what Kode's startup-script diagnostics recognize as server-process launch lines:

| Script | What it does |
| --- | --- |
| `start_server.sh` / `start_server.bat` | kills leftovers, then starts machine → logger → interfaces → dbmgr → baseappmgr → cellappmgr → baseapp → cellapp → loginapp, each with `--cid` + `--gus` (bat adds `--hide=1` for extra instances) |
| `start_bots.sh` / `start_bots.bat` | starts `bots` with no params (its ID is queried from the machine) |
| `safe_kill.sh` / `safe_kill.bat` | takes the UID via `kbcmd --getuid`, then stops the cluster through `cluster_controller.py` |
| `kill_server.sh` / `kill_server.bat` | kills by process name (`pkill` / `taskkill`) |
| `guiconsole.bat` | starts `guiconsole` |
