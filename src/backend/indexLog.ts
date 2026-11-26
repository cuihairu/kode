import * as vscode from 'vscode';

// Unified index work log (WARM-VISIBILITY-004 blade B, 2026-11-20):
// index-related logs used to be scattered across several channels (jumpLog ->
// the "KBEngine Navigation" channel defaulting to off; Runtime /
// Compatibility / Console each independent), so the user had no idea which
// one to read and could not judge "is the index engine alive or dead". This
// module = the always-on "KBEngine Index" channel, aggregating key events
// from five sources:
//   - discovery    the discovery chain (def first-scan start / completion /
//                  slow files / failed retries)
//   - event-index  event/method index (cold-scan start / completion, cache
//                  recovery)
//   - python-index python class index (full-scan start / throttled progress /
//                  completion / checkpoint adoption / pending gap)
//   - cache        warmup disk cache (hit injection / restore / warmup done)
//   - server       kode-server process lifecycle (spawned / ready / exit /
//                  restart loop; FREEZE blade-3 heartbeat, a line appears only
//                  when the Rust helper process is actually running)
// Every line carries a relative timestamp (the first line anchors [+0.0s]).
//
// Always-on red line (user lesson: the Navigation channel went fully silent
// because jumpLog defaults to false): this channel has no switch, and key
// fact lines (scan start / completion / cache / recovery) always come out.
// The task brief's "no mirroring when the switch is off" is implemented as
// "decision-path traffic (jumpLog debug / decision lines) never enters this
// channel" — the mirrored face is only the two pre-existing fact lines (def
// full index completion / def parsing slow files), one-to-one in content with
// the Navigation channel; when jumpLog is off the Navigation channel goes
// silent while this channel keeps emitting.
// The test stub records by channel name (windowState.channels), the same
// infrastructure as navigationLog.

export type IndexLogSource = 'discovery' | 'event-index' | 'python-index' | 'cache' | 'server';

export const INDEX_LOG_CHANNEL_NAME = 'KBEngine Index';

const RECENT_LIMIT = 400;
const recentLines: string[] = [];

let channel: vscode.OutputChannel | undefined;
/** Relative-time anchor (the moment of the first line); null = no line emitted yet */
let anchorMs: number | null = null;
/** Test clock injection (deterministic timestamp assertions) */
let testClock: (() => number) | null = null;

export function setIndexLogClockForTests(clock: (() => number) | null): void {
  testClock = clock;
}

const nowMs = (): number => (testClock ? testClock() : Date.now());

export function getIndexLogRecentLines(): readonly string[] {
  return recentLines;
}

export function clearIndexLogRecentLines(): void {
  recentLines.length = 0;
  // Test convenience: clearing the ring buffer also resets the time anchor, so assertions can count anew from [+0.0s]
  anchorMs = null;
}

/**
 * Index key event line. The lazy message form matches jumpLog (zero
 * concatenation cost on a disabled face — this channel is always on, so the
 * laziness is mostly about keeping call sites stylistically uniform; what
 * really matters is not stuffing high-frequency loops in here).
 */
export function indexLog(source: IndexLogSource, message: string | (() => string)): void {
  const text = typeof message === 'function' ? message() : message;
  if (anchorMs === null) {
    anchorMs = nowMs();
  }
  const line = `[+${((nowMs() - anchorMs) / 1000).toFixed(1)}s][kode-index][${source}] ${text}`;
  recentLines.push(line);
  if (recentLines.length > RECENT_LIMIT) {
    recentLines.shift();
  }
  if (!channel) {
    channel = vscode.window.createOutputChannel(INDEX_LOG_CHANNEL_NAME);
  }
  channel.appendLine(line);
}
