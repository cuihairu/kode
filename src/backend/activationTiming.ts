// Activation segmented latency parsing (RUST-022 extension activation segment).
//
// Data source = the exthost.log the host itself writes (activation lines appear at
// info level, so no --verbose or --prof-startup is needed — measured on VS Code 1.141,
// --prof-startup writes no extra artifacts, but `_doActivateExtension`/`Eager
// extensions activated` are always at info level in the log).
// This module is a pure parsing core: it takes log text and outputs segment marks plus
// derived latencies; it reads no files and starts no host, so unit tests can run
// offline (see tests/activationTiming.test.ts).
//
// Honest boundary: the host log contains no `activate()` return moment. The earliest
// observable end marker is "Eager extensions activated" (all startup-phase activations
// complete). So the activate duration this module reports uses the
// "activation entry -> eager fully complete" contract, a host-side provable lower
// bound, and is not the exact duration of the extension's synchronous activate body
// (that needs instrumentation inside the extension; see the staged timing in
// docs/perf/2026-11-07-activation-views-first.md).
// Returns null when the log has no activation line for the target extension — no
// invented numbers.

/** Observable activation segment marks in one host run (ms, parsed from log timestamps) */
export interface ActivationSegments {
  /** `Extension host with pid N started` — extension host process start */
  hostStartMs: number;
  /** `ExtensionService#_doActivateExtension <id>` — this extension's activation entry */
  activateEnterMs: number;
  /** `Eager extensions activated` — all startup-phase activations complete */
  eagerActivatedMs: number | null;
  /** `Extension host with pid N exiting with code N` — host exit (optional segment) */
  hostExitMs: number | null;
}

/** Derived latencies: all obtained by subtracting the marks above, no external clock */
export interface ActivationDerived {
  /** Host start -> this extension's activation entry */
  hostStartToActivateMs: number;
  /** Activation entry -> eager fully complete */
  activateToEagerMs: number | null;
  /** Host start -> eager fully complete */
  hostStartToEagerMs: number | null;
  /**
   * **Number of other startup activations still queued** after this extension's
   * activation entry and before eager completion.
   * When non-zero, `activateToEagerMs` is a mixed window (includes other extensions'
   * activation bodies) and cannot be taken as the cost of this extension's activate()
   * — the report must give this number alongside.
   */
  trailingStartupActivations: number;
}

export interface ActivationReport {
  extensionId: string;
  /** Raw activation-triggering event (e.g. a workspaceContains-style glob), else null */
  activationEvent: string | null;
  segments: ActivationSegments;
  derived: ActivationDerived;
}

// Host log line: `2026-11-15 13:16:19.842 [info] <message>`, level inside brackets
const LINE_RE = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}) \[[a-z]+\] (.*)$/;
const HOST_START_RE = /^Extension host with pid \d+ started$/;
const HOST_EXIT_RE = /^Extension host with pid \d+ exiting with code \d+$/;
const EAGER_RE = /^Eager extensions activated$/;
// `_doActivateExtension cuihairu.kode-kbengine, startup: true, activationEvent: '...'`
const ACTIVATE_RE = /^ExtensionService#_doActivateExtension ([^,]+), startup: (true|false)(?:, activationEvent: (.+))?$/;

/** Strip a wrapping pair of quotes (activationEvent appears in the log as 'workspaceContains:...'). */
const stripQuotes = (value: string): string =>
  value.length >= 2
    && ((value.startsWith("'") && value.endsWith("'"))
      || (value.startsWith('"') && value.endsWith('"')))
    ? value.slice(1, -1)
    : value;

interface ActivationRecord {
  at: number;
  id: string;
  isStartup: boolean;
}

/** Parse host log text into an activation segment report for the target extension; null when there is no target activation line. */
export function parseActivationLog(text: string, extensionId: string): ActivationReport | null {
  const hostStartMs: number[] = [];
  const hostExitMs: number[] = [];
  const activations: ActivationRecord[] = [];
  let eagerActivatedMs: number | null = null;
  let activateEnterMs: number | null = null;
  let activationEvent: string | null = null;

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0) { continue; }
    const match = LINE_RE.exec(line);
    if (!match) { continue; }
    const at = Date.parse(`${match[1].replace(' ', 'T')}Z`);
    if (Number.isNaN(at)) { continue; }
    const message = match[2];

    if (HOST_START_RE.test(message)) {
      hostStartMs.push(at);
      continue;
    }
    if (HOST_EXIT_RE.test(message)) {
      hostExitMs.push(at);
      continue;
    }
    if (EAGER_RE.test(message)) {
      if (eagerActivatedMs === null) { eagerActivatedMs = at; }
      continue;
    }
    const activate = ACTIVATE_RE.exec(message);
    if (!activate) { continue; }
    const id = activate[1].trim();
    const isStartup = activate[2] === 'true';
    activations.push({ at, id, isStartup });
    if (id === extensionId && activateEnterMs === null) {
      // If the same extension is reactivated by multiple events, take the first entry
      activateEnterMs = at;
      activationEvent = activate[3] ? stripQuotes(activate[3].trim()) : null;
    }
  }

  if (hostStartMs.length === 0 || activateEnterMs === null) { return null; }
  const start = hostStartMs[0];
  const enter = activateEnterMs;
  const trailingStartupActivations = activations.filter(
    record => record.id !== extensionId
      && record.isStartup
      && record.at > enter
      && (eagerActivatedMs === null || record.at < eagerActivatedMs)
  ).length;
  return {
    extensionId,
    activationEvent,
    segments: {
      hostStartMs: start,
      activateEnterMs: enter,
      eagerActivatedMs: eagerActivatedMs,
      hostExitMs: hostExitMs.length > 0 ? hostExitMs[0] : null
    },
    derived: {
      hostStartToActivateMs: enter - start,
      activateToEagerMs: eagerActivatedMs === null ? null : eagerActivatedMs - enter,
      hostStartToEagerMs: eagerActivatedMs === null ? null : eagerActivatedMs - start,
      trailingStartupActivations
    }
  };
}
