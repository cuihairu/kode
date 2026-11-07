# Performance Analysis Capability Boundary (KODE-FEAT-002 · 2026-11-05)

> Original entry: make the performance-analysis capability boundary explicit:
> existing runtime metrics / py-spy snapshots vs the unimplemented
> flamegraph / periodic sampling — separate done from not-done.
>
> This document only draws the boundary; it changes no code. All findings come
> from the real source in this worktree (file:line reflects the investigation
> moment). Shape proposals for the not-done items live in
> `docs/design/pending-feature-shapes.md`.

## Done (existing capabilities)

### 1. Runtime metrics: monitoring panel (polled snapshots, not time series)

- Entry: command `kbengine.monitoring.show` (Monitoring Panel webview).
- Data path: `src/monitoringCollector.ts` — `MonitoringCollector` polls over
  the engine watcher protocol via `discoverLocalComponents` / `queryWatcherPath`
  in `src/kbengineProtocol.ts`; one `ComponentMetrics` per component
  (cpuUsage/memoryUsage/load/connections/entityCount/messagesPerSecond/
  objectPoolMemory/objectPoolSize/uptime/status) plus a global `SystemOverview`
  summary.
- Boundary: **the panel holds only the latest snapshot and diagnostic events
  (`MonitoringDiagnostic`); there is no historical time-series store, no trend
  charts, no alerting**. Data between two refreshes does not exist (the
  investigation confirmed monitoringCollector/monitoringWebView carry no
  history/samples/ring structures).

### 2. Call-stack snapshot: py-spy dump (one-shot, not continuous)

- Entry: Servers tree `$(pulse)` icon / command `kbengine.debug.pyspyDump`.
- Data path: `src/pyspyDump.ts` — `runPyspyDump` runs
  `py-spy dump --pid <pid> --nonblocking` (does not pause the target process)
  and writes the call stack to the `KBEngine py-spy` output channel; probe and
  install resolve through the selected interpreter (`resolvePyspyCommand`,
  IDE-PDBG-006); ptrace permission failures append guidance text.
- Remote path: py-spy probe/install/dump dispatch through the ssh prefix
  (`src/remoteConnection.ts`, IDE-PDBG-004/005); remote PIDs go through the
  remote process-list picker.
- Boundary: **single process, single shot, plain-text stack**. No sampling
  period, no aggregation, no visualization.

### 2b. Flamegraph / timed collection: py-spy record (IDE-PYSPY-001, landed
2026-11-07 — moved here from "not done")

- Entry: Servers tree `$(flame)` icon / command `kbengine.debug.pyspyFlamegraph`.
- Data path: `src/pyspyDump.ts` — `runPyspyRecord` runs
  `py-spy record --format flamegraph` with frictionless defaults
  (`PYSPY_RECORD_DEFAULTS`: 10 s window, 100 samples/s, `--nonblocking` never
  pausing the target; timeout = window + 15 s grace); `runPyspySchedule`
  implements "collect X times every N seconds" (per-run
  `flame-<timestamp>-<index>.svg`, any failure stops the run and keeps the
  files already collected; sleep/now injected, tests never really sleep).
- Display: a successful collect opens the SVG in the editor (VS Code native
  image preview); per-run results and the summary go to the `KBEngine py-spy`
  output channel — no separate webview was built.
- Boundary: **local only** — a remote dispatch says so honestly and suggests
  `dump` for call stacks (remote file retrieval is a follow-up); the record
  output is a static SVG per run, not a time series.

### 3. Engine runtime query: telnet watcher surface (general queries, not dedicated profiling)

- `src/runtimeQueryWebView.ts` queries arbitrary watcher paths and the space
  list via `queryWatcherPath`/`querySpaces`. This is a general query surface,
  not a profiler; the telnet console's profile-family commands on the engine
  side are not wrapped by kode.

### 4. Extension-host self-observation (the subject is kode itself, not the engine)

- `kbengine.metrics.showSummary` / `showActiveTasks`
  (`src/languageServiceMetrics.ts`): the language service's own task/CPU
  counters.
- `kbengine.metrics.startCpuProfile` / `stopCpuProfile`
  (`src/cpuProfileCapture.ts`): extension-host CPU profile capture.
- Baseline suite: `tests/perf/*.bench.ts` + `docs/perf/` (v0.2 baseline etc.),
  all targeting the extension's own overhead.

## Not done (explicitly outside the current state; rechecked 2026-11-07)

| Capability | Status | Tracking |
|---|---|---|
| ~~py-spy record flamegraph (`--format flamegraph` SVG)~~ | **Done 2026-11-07** (IDE-PYSPY-001, `runPyspyRecord`/`pyspyFlamegraph`) — see §2b | Closed by IDE-PYSPY-001 |
| ~~Timed/periodic collection (sample X times every N seconds)~~ | **Done 2026-11-07** (same landing, `runPyspySchedule`) | Closed by IDE-PYSPY-001 |
| ~~Webview display of flamegraph/sampling results~~ | Resolved differently: results open in the editor's native image preview + output channel, no webview | Closed by IDE-PYSPY-001 |
| Historical time series of runtime metrics (storage/trends/alerts) | Not implemented (monitoring panel is snapshot-only) | No entry; creating one requires deciding the storage surface first (in-memory ring buffer vs on-disk) |
| Wrapping engine telnet console profile commands (cellapp/baseapp `profile`) | Not implemented | No entry |
| Continuous-sampling background tasks (CPU/memory curves over time) | Not implemented | No entry; extendable via the same watcher protocol as the monitoring panel |
| Remote flamegraph collection (record on an SSH host + file retrieval) | Not implemented (record dispatch honestly refuses remote and suggests `dump`) | No entry; follow-up of IDE-PYSPY-001 |

## Conclusion

- The "snapshot" side (watcher metrics + py-spy dump) and the flamegraph /
  timed-collection side (py-spy record, IDE-PYSPY-001, landed 2026-11-07)
  both work on the local machine, and the dump side also works remotely.
  Still entirely not done: metric time series, telnet profile-command
  wrapping, continuous-sampling background tasks, and remote flamegraph
  retrieval — the last four rows of the table above have no ticket and need
  one before any work starts.
- Reuse constraint (binding on PYSPY-001 and later entries): periodic
  collection/flamegraphs must reuse `pyspyDump.ts`'s interpreter resolution
  (`resolvePyspyCommand`), ptrace guidance, `killProcessTree`, and the ssh
  dispatch surface — no second probe/install path may be spun up. (Held:
  PYSPY-001 landed inside `pyspyDump.ts` on the same chain.)
