/**
 * Pure sampling core for the memory monitor panel (no vscode, no IO).
 * Sampling rides the existing telnet face: each sample period sends one
 * exec command; engine-side Python prints one KODE_MEM: marker line with
 * JSON and calls KBEngine.debugTracing() for object counters. This file
 * only builds/parses and computes range/window/backoff/thresholds;
 * connection lifecycle belongs to the panel layer (memoryMonitorPanel.ts).
 *
 * Sampled quantities (engine-side ground truth):
 * - rss: /proc/self/statm resident pages x page size (current RSS in KB;
 *   Linux face; falls back to peak when the read fails, never invented);
 * - peak: resource.getrusage(RUSAGE_SELF).ru_maxrss (peak RSS, KB on Linux);
 * - entities: len(entities);
 * - object counters: KBEngine.debugTracing() goes through stdouterr and
 *   prints `PyGC::debugTracing(): <Type> : <N>` (py_gc.cpp:218); the
 *   `leaked(N)` wording only appears in the shutdown ERROR_MSG branch
 *   (py_gc.cpp:214) — the parser accepts both wordings, no picking.
 */

/** Sample marker line prefix (must match at line start; command echo lines carry prompt prefixes and never mis-match) */
export const MEMORY_SAMPLE_MARKER = 'KODE_MEM:';

/** Engine-side Python sampling script (run via exec; entities/KBEngine are preloaded by the console layer) */
export function buildMemorySampleScript(): string {
  return [
    'import json, resource',
    'rss = peak = 0',
    'try:',
    '    peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss',
    'except Exception:',
    '    pass',
    'try:',
    "    rss = int(open('/proc/self/statm').read().split()[1]) * resource.getpagesize() // 1024",
    'except Exception:',
    '    rss = peak',
    "print('" + MEMORY_SAMPLE_MARKER + "' + json.dumps({'rss': rss, 'peak': peak, 'entities': len(entities)}))",
    'KBEngine.debugTracing()'
  ].join('\n');
}

/** Full telnet command (exec-wrapped, quotes escaped via JSON; same shape as the hot-reload channel) */
export function buildMemorySampleCommand(): string {
  return `exec(${JSON.stringify(buildMemorySampleScript())})`;
}

export interface MemorySample {
  /** Current RSS (KB; Linux statm face, falls back to peak on read failure) */
  rssKb: number;
  /** Peak RSS (KB; ru_maxrss) */
  peakKb: number;
  entities: number;
}

/**
 * Parse the sample marker lines from downstream text: must match the marker
 * at line start (echo lines with `>>> ` style prefixes never mis-match);
 * each line's JSON must hold finite non-negative numbers; the last valid
 * marker line wins (stale/interleaved output loses to the newest, same rule
 * as parseLeakCounters; broken lines are skipped, not fatal); no valid line
 * → null, no guessing.
 */
export function parseMemorySample(text: string): MemorySample | null {
  let last: MemorySample | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith(MEMORY_SAMPLE_MARKER)) {
      continue;
    }
    const sample = parseMarkerLine(line);
    if (sample !== null) {
      last = sample;
    }
  }
  return last;
}

function parseMarkerLine(line: string): MemorySample | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line.slice(MEMORY_SAMPLE_MARKER.length));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const rss = record['rss'];
  const peak = record['peak'];
  const entities = record['entities'];
  if (
    typeof rss !== 'number' || !Number.isFinite(rss) || rss < 0 ||
    typeof peak !== 'number' || !Number.isFinite(peak) || peak < 0 ||
    typeof entities !== 'number' || !Number.isFinite(entities) || entities < 0
  ) {
    return null;
  }
  return { rssKb: rss, peakKb: peak, entities };
}

export interface LeakCounter {
  type: string;
  count: number;
}

/**
 * Parse debugTracing object counter lines, accepting both wordings:
 * - `PyGC::debugTracing(): FixedArray : 3` (stdouterr face, steady state);
 * - `PyGC::debugTracing(): FixedArray : leaked(3)` (shutdown ERROR face);
 * last occurrence wins per type (stale output in the stream loses to the
 * newest reading).
 */
export function parseLeakCounters(text: string): LeakCounter[] {
  const byType = new Map<string, number>();
  // lazy (.+?) lets the type name carry "::" (e.g. KBEngine::MemoryStream);
  // the match is pinned by "colon then the number" backtracking
  const pattern = /PyGC::debugTracing\(\):\s*(.+?)\s*:\s*(?:leaked\()?(\d+)\)?/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    byType.set(match[1], Number(match[2]));
  }
  return [...byType.entries()].map(([type, count]) => ({ type, count }));
}

export interface YRange {
  lo: number;
  hi: number;
  step: number;
}

/**
 * Auto Y range: never anchored at 0 (follows the data window); tick steps
 * take tidy 1/2/2.5/5x10^n values (same algorithm as prototype panel.html;
 * minSpan pads tiny data; lo clamps at 0 — memory has no negatives).
 * Empty data returns null (caller draws no axis, invents nothing).
 */
export function computeYRange(values: readonly number[], minSpan: number): YRange | null {
  if (values.length === 0) {
    return null;
  }
  const dataMin = Math.min(...values);
  const dataMax = Math.max(...values, dataMin + minSpan);
  const rawRange = dataMax - dataMin;
  const padded = rawRange * 1.25;
  const magnitude = Math.pow(10, Math.floor(Math.log10(padded / 3)));
  let step = magnitude * 10;
  for (const candidate of [1, 2, 2.5, 5, 10]) {
    if (magnitude * candidate >= padded / 3) {
      step = magnitude * candidate;
      break;
    }
  }
  const lo = Math.max(0, Math.floor((dataMin - rawRange * 0.08) / step) * step);
  const hi = Math.ceil((dataMax + rawRange * 0.12) / step) * step;
  return { lo, hi, step };
}

/** 60-point sample window (60s @ 1Hz; fixed capacity, oldest slides out on overflow) */
export const MEMORY_WINDOW_CAPACITY = 60;

export class MemorySampleWindow {
  private readonly rssKb: number[] = [];
  private readonly peakKb: number[] = [];
  private readonly entities: number[] = [];

  constructor(private readonly capacity: number = MEMORY_WINDOW_CAPACITY) {}

  push(sample: MemorySample): void {
    this.rssKb.push(sample.rssKb);
    this.peakKb.push(sample.peakKb);
    this.entities.push(sample.entities);
    const overflow = this.rssKb.length - this.capacity;
    if (overflow > 0) {
      this.rssKb.splice(0, overflow);
      this.peakKb.splice(0, overflow);
      this.entities.splice(0, overflow);
    }
  }

  get length(): number {
    return this.rssKb.length;
  }

  rss(): number[] {
    return [...this.rssKb];
  }

  peaks(): number[] {
    return [...this.peakKb];
  }

  entitiesSeries(): number[] {
    return [...this.entities];
  }

  /** Peak RSS within the window (same source for the peak line and peak card) */
  windowPeakKb(): number | null {
    return this.peakKb.length > 0 ? Math.max(...this.peakKb) : null;
  }

  clear(): void {
    this.rssKb.length = 0;
    this.peakKb.length = 0;
    this.entities.length = 0;
  }
}

/**
 * Reconnect backoff: starts at 1s, doubles, caps at 30s (same parameter
 * face as the log tail channel). attempt starts at 0 (first reconnect
 * waits 1s).
 */
export function nextBackoffMs(attempt: number, baseMs = 1000, maxMs = 30000): number {
  return Math.min(baseMs * 2 ** Math.max(0, attempt), maxMs);
}

/**
 * Leak alert gate: a type must stay nonzero for 3 consecutive sample
 * periods before alerting (single-period spikes stay quiet); alerts are
 * deduplicated — staying nonzero never re-fires; returning to zero re-arms
 * (another sustained nonzero run can alert again). feed returns the types
 * that newly crossed the threshold this round.
 */
export class LeakAlertGate {
  private readonly streaks = new Map<string, number>();
  private readonly alerted = new Set<string>();

  constructor(private readonly streakNeeded: number = 3) {}

  feed(counters: readonly LeakCounter[]): string[] {
    const seen = new Set(counters.map(counter => counter.type));
    for (const [type, count] of byTypeOf(counters)) {
      const streak = count > 0 ? (this.streaks.get(type) ?? 0) + 1 : 0;
      this.streaks.set(type, streak);
      if (count === 0) {
        this.alerted.delete(type);
      }
    }
    const fired: string[] = [];
    for (const [type, streak] of this.streaks) {
      if (streak >= this.streakNeeded && !this.alerted.has(type)) {
        this.alerted.add(type);
        fired.push(type);
      }
    }
    // Types absent this round count as back-to-zero (process switch or
    // missing output never leaves stale counters hanging)
    for (const type of [...this.streaks.keys()]) {
      if (!seen.has(type)) {
        this.streaks.set(type, 0);
        this.alerted.delete(type);
      }
    }
    return fired;
  }

  reset(): void {
    this.streaks.clear();
    this.alerted.clear();
  }
}

function byTypeOf(counters: readonly LeakCounter[]): Array<[string, number]> {
  return counters.map(counter => [counter.type, counter.count] as [string, number]);
}
