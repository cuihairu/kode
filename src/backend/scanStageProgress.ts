// Fine-grained within-stage scan progress (WARM-VISIBILITY-004 cut A, 2026-11-20):
// first-scan stages (entityMapping def parsing / WorkspaceIndex event indexing)
// produce no visible output for a long time inside the stage, the status bar
// "1/5 entity discovery chain" sits still for minutes, and the user cannot tell
// working from wedged. This module = a throttled reporter shared by the two
// first-scan loops:
//   - count gate: at least SCAN_STAGE_PROGRESS_REPORT_EVERY files since the last
//     report before another report is allowed;
//   - time gate: at least SCAN_STAGE_PROGRESS_MIN_INTERVAL_MS since the last report
//     before another report is allowed (the first report is an exception: the
//     initial timestamp is 0, the first count boundary reports immediately, so
//     movement is visible within the first second of scanning);
//   - final report: finish() always emits a closing entry (N/N), not bound by the
//     two gates.
// Constants and behavior are pinned by the contract test
// (tests/scanStageProgress.test.ts): a large repo does not flood (report rate
// cap), progress-bar messages only increase. The report face has zero string
// building cost: a step that fails the gate only does integer comparisons.
// (Naming note: the repo already has scanProgress.ts = the SCAN-RESUME-001 scan
// resume module; this module is unrelated to it — that one is "where to resume
// from", this one is "where scanning is, shown to people".)

/** Count gate: how many files since the last report at minimum */
export const SCAN_STAGE_PROGRESS_REPORT_EVERY = 10;

/** Time gate: how many milliseconds since the last report at minimum */
export const SCAN_STAGE_PROGRESS_MIN_INTERVAL_MS = 500;

/** Test clock injection (deterministic assertions: with a fixed clock, whether the time gate blocks or passes is the test's choice) */
let testClock: (() => number) | null = null;

export function setScanStageProgressClockForTests(clock: (() => number) | null): void {
  testClock = clock;
}

const nowMs = (): number => (testClock ? testClock() : Date.now());

export interface ScanStageProgressReporter {
  /** Advance the count (count files processed); only reports after passing both gates */
  step(count?: number): void;
  /** Closing: always reports one final progress entry (N/N), not bound by the two gates */
  finish(): void;
}

/**
 * label examples: "entity discovery chain def", "event/method index" -> the report
 * message is `${label} ${done}/${total}`. The report callback's destination is the
 * caller's decision (warmup running = status bar message; otherwise a no-op).
 */
export function createScanStageProgressReporter(options: {
  label: string;
  total: number;
  report: (detail: string) => void;
}): ScanStageProgressReporter {
  let done = 0;
  let lastReportedAt = 0; // initial 0: the first report happens only at the first count boundary (the EVERY-th file)
  let lastTime = 0; // the first report is not blocked by the time gate (movement visible within the first second)
  const emit = (): void => {
    lastReportedAt = done;
    lastTime = nowMs();
    options.report(`${options.label} ${done}/${options.total}`);
  };
  return {
    step: (count = 1): void => {
      done += count;
      if (done - lastReportedAt >= SCAN_STAGE_PROGRESS_REPORT_EVERY && nowMs() - lastTime >= SCAN_STAGE_PROGRESS_MIN_INTERVAL_MS) {
        emit();
      }
    },
    finish: (): void => {
      // The final report is always sent: the progress bar closes at 100%, not stuck halfway by the two gates
      lastReportedAt = done;
      lastTime = nowMs();
      options.report(`${options.label} ${done}/${options.total}`);
    }
  };
}
