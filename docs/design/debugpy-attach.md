# debugpy Early-Attach Design (Proposal)

> Status: **implemented in three landings** — option ② shipped as the one-shot
> command `kbengine.debug.debugpyInject` (KODE-DBG-001, gated by
> `kbengine.debug.debugpyInject`, default on; src/debugpyInjectCommand.ts,
> tests/debugpyInjectCommand.test.ts); option ① shipped as the
> `kbengine.debug.waitAtStartup` bootstrap (`waitAtStartup.on/off` commands,
> src/debugpyWaitAtStartup.ts); the surrounding automation — per-process port
> allocation, launch.json attach-config generation, the
> not-injected/listening/attached/failed state board — shipped earlier as
> IDE-DBG-001..008 and IDE-PDBG-001..006. Option ③ (`debugpy --pid`) remains
> intentionally unused. All engine references below anchor to
> `kbengine@c2a3b8f`, with `kbe/src` `file:line` citations from source; the
> original proposal text is kept as the design record.

## Goal

After KBEngine services start (baseapp/cellapp and other multi-process
components), open a debugpy listen port as early as possible so VS Code / Kode
can attach the debugger before Entity scripts execute; Kode should also be
able to automate the process (port allocation, bootstrap or console injection,
attach configuration generation, status display).

## Engine-side facts (they decide the options; anchored to source)

1. **KBEngine disables the `site` module** (both Python init paths turn it off):
   - Python ≥ 3.11 (PyConfig path): `config.site_import = 0` — `kbe/src/lib/pyscript/script.cpp:32`
   - Python < 3.11 (Py_Initialize path): `Py_NoSiteFlag = 1` — `kbe/src/lib/pyscript/script.cpp:223`
   - Corollary: `sitecustomize.py` / `usercustomize.py` / `.pth` files are
     **never auto-loaded**.
2. **KBEngine ignores Python environment variables**: `config.use_environment = 0` — `script.cpp:33`;
   `Py_IgnoreEnvironmentFlag = 1` — `script.cpp:224`. Corollary: `PYTHONSTARTUP`,
   `PYTHONPATH`, etc. have no effect; but `os.environ` inside a script still
   reads the process environment, so custom `KBE_DEBUGPY_*` variables work.
3. **Python readiness point**: `Script::install()` — `script.cpp:197-294`
   (`Py_InitializeFromConfig` → register the `KBEngine` extension module →
   install GC/Pickle/Profile etc.). On return, Python is fully usable.
4. **First business-script import point**: `EntityApp::installPyModules` →
   `PyImport_Import(entryScript_)` — `kbe/src/lib/server/entity_app.h:509`,
   importing `scripts/base/<entry>.py` (baseapp) or `scripts/cell/<entry>.py`
   (cellapp). This is the **earliest user-code point reachable without engine
   changes**.
5. **The console executes arbitrary Python**: `TelnetHandler::processPythonCommand` —
   `kbe/src/lib/server/telnet_handler.cpp:795` (via `PyUnicode_DecodeUTF8` →
   eval). Kode's existing `KBEngineTelnetClient` (which sends
   `KBEngine.reloadScript(True)`) already uses this surface.
6. **debugpy must be importable by the engine's own Python**: `sys.path` is
   pinned explicitly by `config.module_search_paths` (`script.cpp:60`) /
   `Py_SetPath` (`script.cpp:226`); debugpy must be placed into that Python's
   site-packages, or appended to `sys.path` in the bootstrap.

## Feasible options without engine changes (in recommendation order)

### ① Bootstrap at the top of the entry script (earliest, most practical)
Put the bootstrap on **line 1** of `scripts/base/<entry>.py` and
`scripts/cell/<entry>.py`:

```python
import os, sys
# Ensure debugpy is visible (optional): sys.path.append("<debugpy dir>")
import debugpy
debugpy.listen(("127.0.0.1", int(os.environ.get("KBE_DEBUGPY_PORT", "5678"))))
```

- Coverage: every business import after the entry, module initialization,
  Entity initialization.
- Blind spot: only the few lines of the entry file before its own bootstrap.
- Requires a service restart to take effect; `wait_for_client` is enabled
  explicitly via `KBE_DEBUGPY_WAIT=="1"` (does not block startup by default).

### ② Console runtime injection (zero file changes, existing Kode capability)
Send arbitrary Python over the console:

```
import debugpy; debugpy.listen(("127.0.0.1", 5678))
```

- Timing: any moment after the console is ready; cannot catch early imports
  that already ran — fits "process already started, debug the running phase".
- Complementary to ①: ① covers the early phase, ② the running phase.

### ③ debugpy `--pid` injection (Linux, most fragile, fallback)
`python -m debugpy --pid <PID> --listen 5678` (gdb/ptrace injection into a
running process). Version-sensitive, cannot catch the startup phase; fallback
only.

## Explicitly not workable (without engine changes)
`sitecustomize.py` / `usercustomize.py` / `.pth` / `PYTHONSTARTUP` — with
`site` disabled and Python environment variables ignored (see engine-side
facts 1/2), none of them trigger.

## Automation shape (Kode side)

- **Debug session manager**: allocate a port per process (baseapp01/02,
  cellapp01/02… each exclusive, never shared) and write the allocation into
  process state; bind `127.0.0.1`, access via SSH tunnel/private network (a
  debug port = arbitrary code execution and must never be exposed publicly).
- **Bootstrap generator** (option ①): behind a configuration gate
  (`kbengine.debugpy.enabled` + port), generate/pre-place the bootstrap at the
  top of entry scripts before service start; Kode already has same-kind
  injection precedents (pyi/stub, extraPathsSync).
- **Console injection command** (option ②): one Kode command "attach
  debugger" = connect console → send the listen command.
- **VS Code launch configuration generation**: attach + pathMapping +
  breakpoints, hung off the existing debug configuration surface.
- **State machine**: `Disabled → Listening → ClientAttached`. ① reports via
  the bootstrap (logs/status file); ② the manager judges from the console
  echo.

## Recommendation
Do ② first (pure automation, no side effects, telnet client already exists);
① as the "break at startup" enhancement (requires restart); ③ not used.
