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

## Not done (explicitly outside the current state)

| Capability | Status | Tracking |
|---|---|---|
| py-spy record flamegraph (`--format flamegraph` SVG) | Not implemented (no `record`/`flamegraph` references in the repo) | IDE-PYSPY-001; shape investigated (pending-feature-shapes.md §3) |
| Timed/periodic collection (sample X times every N seconds) | Not implemented | Same IDE-PYSPY-001 entry |
| Webview display of flamegraph/sampling results | Not implemented | Same IDE-PYSPY-001 entry (proposed along the `runtimeQueryWebView` pattern) |
| Historical time series of runtime metrics (storage/trends/alerts) | Not implemented (monitoring panel is snapshot-only) | No entry; creating one requires deciding the storage surface first (in-memory ring buffer vs on-disk) |
| Wrapping engine telnet console profile commands (cellapp/baseapp `profile`) | Not implemented | No entry |
| Continuous-sampling background tasks (CPU/memory curves over time) | Not implemented | No entry; extendable via the same watcher protocol as the monitoring panel |

## Conclusion

- The "snapshot" side (watcher metrics + py-spy dump) is closed-loop and works
  remotely; the "continuous" side (sampling, time series, flamegraphs) is
  entirely not done. Flamegraph/periodic collection has a ticket
  (IDE-PYSPY-001); the rest (metric time series, telnet profile wrapping) has
  no entry and needs one before any work starts.
- Reuse constraint (binding on PYSPY-001 and later entries): periodic
  collection/flamegraphs must reuse `pyspyDump.ts`'s interpreter resolution
  (`resolvePyspyCommand`), ptrace guidance, `killProcessTree`, and the ssh
  dispatch surface — no second probe/install path may be spun up.
