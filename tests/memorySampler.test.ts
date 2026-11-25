import { describe, expect, it } from 'vitest';
import {
  MEMORY_SAMPLE_MARKER,
  MEMORY_WINDOW_CAPACITY,
  MemorySampleWindow,
  buildMemorySampleCommand,
  buildMemorySampleScript,
  computeYRange,
  LeakAlertGate,
  nextBackoffMs,
  parseLeakCounters,
  parseMemorySample
} from '../src/backend/memorySampler';

// Pure sampling core for the memory monitor panel: script building, marker
// parsing (both debugTracing wordings), Y range, sliding window, backoff,
// leak alert gate. No vscode, no IO — every rule is asserted on text/numbers.

describe('buildMemorySampleScript', () => {
  it('prints the marker JSON and calls debugTracing', () => {
    const script = buildMemorySampleScript();
    expect(script).toContain(MEMORY_SAMPLE_MARKER);
    expect(script).toContain('len(entities)');
    expect(script).toContain('KBEngine.debugTracing()');
  });

  it('reads current RSS from statm and peak from ru_maxrss', () => {
    const script = buildMemorySampleScript();
    expect(script).toContain("/proc/self/statm");
    expect(script).toContain('ru_maxrss');
  });

  it('falls back to peak when statm is unreadable (no invented numbers)', () => {
    const script = buildMemorySampleScript();
    // the statm except-branch assigns peak, never a constant
    expect(script).toContain('    rss = peak');
  });

  it('command wraps the script in exec() with JSON escaping', () => {
    const command = buildMemorySampleCommand();
    expect(command.startsWith('exec(')).toBe(true);
    expect(command.endsWith(')')).toBe(true);
    // the inner payload must be a valid JSON string literal round-tripping
    // to the exact script (hot-reload channel same shape)
    const inner = JSON.parse(command.slice('exec('.length, -1)) as string;
    expect(inner).toBe(buildMemorySampleScript());
  });
});

describe('parseMemorySample', () => {
  it('parses a marker line at line start', () => {
    const sample = parseMemorySample(`${MEMORY_SAMPLE_MARKER}{"rss":1024,"peak":2048,"entities":7}`);
    expect(sample).toEqual({ rssKb: 1024, peakKb: 2048, entities: 7 });
  });

  it('handles CRLF downstream text', () => {
    const sample = parseMemorySample(`banner\r\n${MEMORY_SAMPLE_MARKER}{"rss":1,"peak":2,"entities":3}\r\nmore`);
    expect(sample).toEqual({ rssKb: 1, peakKb: 2, entities: 3 });
  });

  it('never matches a prompt-prefixed echo line (the exec command itself)', () => {
    // the telnet echo of the sampling command contains the marker inline,
    // but carries a prompt/exec prefix — line-start match must reject it
    expect(parseMemorySample(`>>> print('${MEMORY_SAMPLE_MARKER}{"rss":1,"peak":1,"entities":1}')`)).toBeNull();
    expect(parseMemorySample(`exec("${MEMORY_SAMPLE_MARKER}")`)).toBeNull();
  });

  it('broken JSON returns null honestly', () => {
    expect(parseMemorySample(`${MEMORY_SAMPLE_MARKER}{"rss":`)).toBeNull();
    expect(parseMemorySample(`${MEMORY_SAMPLE_MARKER}not json`)).toBeNull();
  });

  it('negative or non-finite numbers return null', () => {
    expect(parseMemorySample(`${MEMORY_SAMPLE_MARKER}{"rss":-1,"peak":2,"entities":3}`)).toBeNull();
    expect(parseMemorySample(`${MEMORY_SAMPLE_MARKER}{"rss":1,"peak":Infinity,"entities":3}`)).toBeNull();
    expect(parseMemorySample(`${MEMORY_SAMPLE_MARKER}{"rss":1,"peak":2}`)).toBeNull();
  });

  it('no marker in the stream returns null', () => {
    expect(parseMemorySample('welcome banner\n>>> ')).toBeNull();
  });

  it('last valid marker line wins (stale output loses to the newest)', () => {
    const text = [
      `${MEMORY_SAMPLE_MARKER}{"rss":1,"peak":1,"entities":1}`,
      `${MEMORY_SAMPLE_MARKER}{"rss":2,"peak":2,"entities":2}`
    ].join('\n');
    expect(parseMemorySample(text)).toEqual({ rssKb: 2, peakKb: 2, entities: 2 });
  });

  it('broken marker lines are skipped, the good line still parses', () => {
    const text = [
      `${MEMORY_SAMPLE_MARKER}{"rss":`,
      `${MEMORY_SAMPLE_MARKER}{"rss":20,"peak":24,"entities":2}`
    ].join('\n');
    expect(parseMemorySample(text)).toEqual({ rssKb: 20, peakKb: 24, entities: 2 });
  });
});

describe('parseLeakCounters', () => {
  it('accepts the stdouterr wording (no leaked(...))', () => {
    const counters = parseLeakCounters('PyGC::debugTracing(): FixedArray : 3');
    expect(counters).toEqual([{ type: 'FixedArray', count: 3 }]);
  });

  it('accepts the shutdown leaked(N) wording', () => {
    const counters = parseLeakCounters('PyGC::debugTracing(): PyObject : leaked(12)');
    expect(counters).toEqual([{ type: 'PyObject', count: 12 }]);
  });

  it('collects all types; same type keeps the last reading', () => {
    const text = [
      'PyGC::debugTracing(): FixedArray : 3',
      'PyGC::debugTracing(): KBEngine::MemoryStream : 0',
      'PyGC::debugTracing(): FixedArray : 5'
    ].join('\n');
    const counters = parseLeakCounters(text);
    expect(counters).toHaveLength(2);
    expect(counters.find(c => c.type === 'FixedArray')?.count).toBe(5);
    expect(counters.find(c => c.type === 'KBEngine::MemoryStream')?.count).toBe(0);
  });

  it('unrelated lines yield an empty list', () => {
    expect(parseLeakCounters('no counters here\nINFO: all good')).toEqual([]);
  });
});

describe('computeYRange', () => {
  it('empty data returns null (caller draws no axis)', () => {
    expect(computeYRange([], 6)).toBeNull();
  });

  it('pads a small window with a tidy 1/2/2.5/5 step and never anchors at 0', () => {
    // dataMin=1000, dataMax=1100 → rawRange=100, padded=125, mag=10,
    // first candidate ≥ 41.67 is 50; lo=floor(992/50)*50=950,
    // hi=ceil(1112/50)*50=1150 (prototype panel.html same algorithm)
    expect(computeYRange([1000, 1100], 6)).toEqual({ lo: 950, hi: 1150, step: 50 });
  });

  it('minSpan pads flat data so a single value still draws a range', () => {
    // dataMin=5, dataMax=max(7, 11)=11 → rawRange=6, padded=7.5, mag=1,
    // first candidate ≥ 2.5 is 2.5; lo clamps at 0 only if the floor goes
    // negative — here floor(4.52/2.5)*2.5=2.5
    expect(computeYRange([5, 7], 6)).toEqual({ lo: 2.5, hi: 12.5, step: 2.5 });
  });

  it('lo clamps at 0 (memory has no negatives)', () => {
    const range = computeYRange([1, 2], 6);
    expect(range?.lo).toBeGreaterThanOrEqual(0);
  });

  it('step is always a tidy 1/2/2.5/5 x 10^n value', () => {
    const range = computeYRange([0, 123456], 6);
    expect(range).not.toBeNull();
    const mantissa = range!.step / Math.pow(10, Math.floor(Math.log10(range!.step)));
    expect([1, 2, 2.5, 5, 10]).toContain(mantissa);
  });
});

describe('MemorySampleWindow', () => {
  it('holds up to 60 samples then slides the oldest out', () => {
    const window = new MemorySampleWindow();
    for (let i = 0; i < MEMORY_WINDOW_CAPACITY + 5; i++) {
      window.push({ rssKb: i, peakKb: i * 2, entities: i * 3 });
    }
    expect(window.length).toBe(MEMORY_WINDOW_CAPACITY);
    expect(window.rss()[0]).toBe(5);
    expect(window.rss()[window.rss().length - 1]).toBe(64);
    expect(window.entitiesSeries()[0]).toBe(15);
  });

  it('returned arrays are copies (mutating them never corrupts the window)', () => {
    const window = new MemorySampleWindow();
    window.push({ rssKb: 1, peakKb: 1, entities: 1 });
    window.rss().push(999);
    expect(window.rss()).toEqual([1]);
  });

  it('windowPeakKb reports the max peak, null when empty', () => {
    const window = new MemorySampleWindow();
    expect(window.windowPeakKb()).toBeNull();
    window.push({ rssKb: 10, peakKb: 40, entities: 0 });
    window.push({ rssKb: 20, peakKb: 30, entities: 0 });
    expect(window.windowPeakKb()).toBe(40);
  });

  it('clear drops everything (process switch / panel clear)', () => {
    const window = new MemorySampleWindow();
    window.push({ rssKb: 1, peakKb: 1, entities: 1 });
    window.clear();
    expect(window.length).toBe(0);
    expect(window.windowPeakKb()).toBeNull();
  });
});

describe('nextBackoffMs', () => {
  it('starts at 1s and doubles per attempt', () => {
    expect(nextBackoffMs(0)).toBe(1000);
    expect(nextBackoffMs(1)).toBe(2000);
    expect(nextBackoffMs(4)).toBe(16000);
  });

  it('caps at 30s', () => {
    expect(nextBackoffMs(5)).toBe(30000);
    expect(nextBackoffMs(20)).toBe(30000);
  });

  it('negative attempts clamp to the base (no reverse backoff)', () => {
    expect(nextBackoffMs(-3)).toBe(1000);
  });

  it('base and cap are injectable (tests / future tuning)', () => {
    expect(nextBackoffMs(1, 500, 900)).toBe(900);
  });
});

describe('LeakAlertGate', () => {
  const countersOf = (type: string, count: number) => [{ type, count }];

  it('stays quiet below 3 consecutive nonzero samples', () => {
    const gate = new LeakAlertGate();
    expect(gate.feed(countersOf('FixedArray', 1))).toEqual([]);
    expect(gate.feed(countersOf('FixedArray', 2))).toEqual([]);
  });

  it('fires once on the 3rd consecutive nonzero, then stays deduplicated', () => {
    const gate = new LeakAlertGate();
    gate.feed(countersOf('FixedArray', 1));
    gate.feed(countersOf('FixedArray', 2));
    expect(gate.feed(countersOf('FixedArray', 3))).toEqual(['FixedArray']);
    // still nonzero: no re-fire
    expect(gate.feed(countersOf('FixedArray', 4))).toEqual([]);
    expect(gate.feed(countersOf('FixedArray', 5))).toEqual([]);
  });

  it('back to zero re-arms (next sustained run can fire again)', () => {
    const gate = new LeakAlertGate();
    for (const n of [1, 2, 3, 4]) {
      gate.feed(countersOf('FixedArray', n));
    }
    expect(gate.feed(countersOf('FixedArray', 0))).toEqual([]);
    expect(gate.feed(countersOf('FixedArray', 1))).toEqual([]);
    expect(gate.feed(countersOf('FixedArray', 2))).toEqual([]);
    expect(gate.feed(countersOf('FixedArray', 3))).toEqual(['FixedArray']);
  });

  it('a type absent from a round counts as back-to-zero', () => {
    const gate = new LeakAlertGate();
    gate.feed(countersOf('FixedArray', 1));
    gate.feed(countersOf('FixedArray', 2));
    // parser returned nothing for FixedArray this round (missing output)
    gate.feed([]);
    expect(gate.feed(countersOf('FixedArray', 1))).toEqual([]);
    expect(gate.feed(countersOf('FixedArray', 2))).toEqual([]);
    expect(gate.feed(countersOf('FixedArray', 3))).toEqual(['FixedArray']);
  });

  it('types alert independently', () => {
    const gate = new LeakAlertGate();
    gate.feed([{ type: 'FixedArray', count: 1 }, { type: 'PyObject', count: 1 }]);
    gate.feed([{ type: 'FixedArray', count: 2 }, { type: 'PyObject', count: 2 }]);
    expect(gate.feed([{ type: 'FixedArray', count: 3 }, { type: 'PyObject', count: 3 }]))
      .toEqual(['FixedArray', 'PyObject']);
  });

  it('reset clears streaks and dedup state (process switch)', () => {
    const gate = new LeakAlertGate();
    for (const n of [1, 2, 3]) {
      gate.feed(countersOf('FixedArray', n));
    }
    gate.reset();
    expect(gate.feed(countersOf('FixedArray', 4))).toEqual([]);
  });
});
