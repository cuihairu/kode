# Runtime batch V-01 implementation notes

## Entry audit

- `src/quickActions.ts:118` reused named VS Code terminals and sent shell text for scripts; the old curl fallback also built a terminal.
- `src/quickActions.ts:134` now routes background scripts through `ProcessManager.start`; `src/quickActions.ts:161` creates interactive terminals with `hideFromUser`.
- HTTP quick actions remain pure HTTP and no longer construct a shell terminal.
- `src/serverManager.ts:189` delegates component ownership to `ProcessManager`; component OutputChannel reveal remains an explicit on-demand action, not launch UI.
- `src/processManager.ts:47` enforces `windowsHide`; the server runner repeats the invariant at `src/serverManager.ts:189`.
- `src/extension.ts:654` injects one shared `ProcessManager` + `LogHub` into quick actions; `src/extension.ts:866` subscribes the log WebView to the same hub.
- `src/processManager.ts:76` owns reuse, stop, restart, and abnormal-exit state; `src/processManager.ts:168` awaits SIGTERM exit or escalates to SIGKILL.

## Semantics

`windowsHide` and a hidden VS Code terminal suppress window activation only. Neither makes a child survive VS Code shutdown. Closing VS Code terminates the extension host and child processes unless an explicitly designed detached daemon is added; this batch intentionally does not provide detached daemon semantics.

## Log contract

Process stdout/stderr, managed-process lifecycle, quick-action HTTP results, and incrementally watched files enter `LogHub`. The default flush cadence is 40 ms (`src/logHub.ts:35`); batches are byte-bounded and the retained ring buffer is capped. `src/logWebView.ts:51` consumes increments only with a 5000-entry display limit; `src/logHub.ts:161` reads file increments and detects truncation. Origin fingerprints deduplicate duplicate delivery (`src/logHub.ts:77`).

Legacy server OutputChannels remain projection surfaces; they are updated from the same `LogHub` batches at `src/serverManager.ts:204`.

## Verification evidence

- Unit gate: 2494 passed / 2 skipped (baseline +7, no skips added).
- Root TypeScript gate: `pnpm run compile` passed with 0 errors.
- Editor demo smoke: `xvfb-run -a pnpm run test:demo:editor` passed (25 tests).
