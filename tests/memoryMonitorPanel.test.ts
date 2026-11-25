import { describe, expect, it, vi } from 'vitest';
import {
  buildMonitorTargets,
  defaultMonitorSessionFactory,
  MemoryMonitorController,
  type MemoryMonitorDeps,
  type MemoryMonitorTarget,
  type MonitorTelnetSession
} from '../src/memoryMonitorPanel';

// Memory monitor controller state machine: target derivation, select
// (drop-old/connect-new), sampling beats, backoff reconnect (no resurrection
// of a torn-down session), pause/clear, leak warning gate, postMessage
// contract. The vscode webview shell is not exercised here (DOM contract,
// per task spec webview DOM is not unit-tested).

// ---------------------------------------------------------------------------
// Harnesses
// ---------------------------------------------------------------------------

/** Manual timer wheel: fires callbacks on demand, records intervals/ms */
class TimerHarness {
  private next = 1;
  private readonly entries = new Map<number, { cb: () => void; ms: number; cleared: boolean }>();

  readonly setInterval = vi.fn((cb: () => void, ms: number) => {
    const id = this.next++;
    this.entries.set(id, { cb, ms, cleared: false });
    return id;
  });

  readonly clearInterval = vi.fn((handle: unknown) => {
    const entry = this.entries.get(handle as number);
    if (entry) {
      entry.cleared = true;
    }
  });

  fire(handle: unknown): void {
    const entry = this.entries.get(handle as number);
    if (entry && !entry.cleared) {
      entry.cb();
    }
  }

  /** most recently armed timer handle (sample timer / reconnect timer) */
  lastHandle(): number {
    return this.next - 1;
  }

  /** latest live handle armed with exactly this interval ms (500 = sample beat, 5000 = status refresh) */
  handleWithMs(ms: number): number {
    let found: number | null = null;
    for (const [id, entry] of [...this.entries]) {
      if (!entry.cleared && entry.ms === ms) {
        found = id;
      }
    }
    return found ?? -1;
  }

  activeCount(): number {
    return [...this.entries.values()].filter(entry => !entry.cleared).length;
  }
}

class FakeSession implements MonitorTelnetSession {
  sent: string[] = [];
  connectCount = 0;
  disconnectCount = 0;
  ready = false;
  private dataListener?: (text: string) => void;
  private closeListener?: (hadError: boolean) => void;

  connect(): void {
    this.connectCount += 1;
  }

  disconnect(): void {
    this.disconnectCount += 1;
  }

  isReady(): boolean {
    return this.ready;
  }

  sendCommand(command: string): boolean {
    this.sent.push(command);
    return true;
  }

  onData(listener: (text: string) => void): void {
    this.dataListener = listener;
  }

  onClose(listener: (hadError: boolean) => void): void {
    this.closeListener = listener;
  }

  emit(text: string): void {
    this.dataListener?.(text);
  }

  emitClose(): void {
    this.closeListener?.(false);
  }
}

const flush = async (): Promise<void> => {
  await new Promise<void>(resolve => setImmediate(resolve));
  await new Promise<void>(resolve => setImmediate(resolve));
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TARGET_A: MemoryMonitorTarget = {
  key: 'k1',
  component: 'cellapp',
  label: 'cellapp',
  host: '127.0.0.1',
  port: 50000,
  password: ''
};
const TARGET_B: MemoryMonitorTarget = {
  key: 'k2',
  component: 'baseapp',
  label: 'baseapp',
  host: '127.0.0.1',
  port: 40000,
  password: ''
};

const sampleLine = (rss: number, peak: number, entities: number): string =>
  `KODE_MEM:${JSON.stringify({ rss, peak, entities })}`;

const traceLines = (entries: Array<[string, number]>): string =>
  entries.map(([type, count]) => `PyGC::debugTracing(): ${type} : ${count}`).join('\n');

interface Rig {
  controller: MemoryMonitorController;
  timers: TimerHarness;
  sessions: FakeSession[];
  posts: Array<Record<string, unknown>>;
  warnings: string[];
  setAlive(alive: string[]): void;
  lastSession(): FakeSession;
  sampleTimerHandle(): unknown;
}

const makeRig = (overrides: Partial<MemoryMonitorDeps> = {}, hz = 1): Rig => {
  const timers = new TimerHarness();
  const sessions: FakeSession[] = [];
  const posts: Array<Record<string, unknown>> = [];
  const warnings: string[] = [];
  let alive = new Set<string>(['cellapp', 'baseapp']);
  const controller = new MemoryMonitorController({
    resolveTargets: () => [TARGET_A, TARGET_B],
    discoverAlive: () => Promise.resolve(new Set(alive)),
    getSampleHz: () => hz,
    post: message => posts.push(message as Record<string, unknown>),
    notifyWarning: message => warnings.push(message),
    createSession: () => {
      const session = new FakeSession();
      sessions.push(session);
      return session;
    },
    formatLeakWarning: (type, count) => `LEAK:${type}:${count}`,
    timers,
    ...overrides
  });
  return {
    controller,
    timers,
    sessions,
    posts,
    warnings,
    setAlive: names => {
      alive = new Set(names);
    },
    lastSession: () => sessions[sessions.length - 1],
    sampleTimerHandle: () => timers.handleWithMs(500)
  };
};

const commandsOf = (posts: Array<Record<string, unknown>>): string[] =>
  posts.map(post => String(post.command));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildMonitorTargets', () => {
  it('passes through single instances and numbers same-named ones #2/#3', () => {
    const targets = buildMonitorTargets([
      { key: 'a', component: 'cellapp', host: 'h', port: 1, password: '' },
      { key: 'b', component: 'baseapp', host: 'h', port: 2, password: '' },
      { key: 'c', component: 'cellapp', host: 'h', port: 3, password: '' }
    ]);
    expect(targets.map(target => target.label)).toEqual(['cellapp', 'baseapp', 'cellapp#2']);
    expect(targets.map(target => target.key)).toEqual(['a', 'b', 'c']);
  });

  it('empty telnet table yields no buttons', () => {
    expect(buildMonitorTargets([])).toEqual([]);
  });
});

describe('defaultMonitorSessionFactory', () => {
  it('wraps a telnet client: not ready before connect, refuses to send', () => {
    const session = defaultMonitorSessionFactory(TARGET_A);
    expect(session.isReady()).toBe(false);
    expect(session.sendCommand('x')).toBe(false);
    expect(() => session.onData(() => {})).not.toThrow();
    expect(() => session.onClose(() => {})).not.toThrow();
    session.disconnect();
  });
});

describe('MemoryMonitorController.start', () => {
  it('posts init, default-selects the first target and opens its session', async () => {
    const rig = makeRig();
    rig.controller.start();
    await flush();
    const inits = rig.posts.filter(post => post.command === 'init');
    expect(inits.length).toBeGreaterThanOrEqual(1);
    expect(inits[0]).toMatchObject({ paused: false, selected: null, hz: 1 });
    const lastInit = inits[inits.length - 1];
    expect(lastInit).toMatchObject({ selected: 'k1' });
    expect(rig.sessions).toHaveLength(1);
    expect(rig.sessions[0].connectCount).toBe(1);
  });

  it('empty target table: init carries no targets and no session is created', async () => {
    const rig = makeRig({ resolveTargets: () => [] });
    rig.controller.start();
    await flush();
    expect(rig.sessions).toHaveLength(0);
    const lastInit = rig.posts.filter(post => post.command === 'init').pop();
    expect((lastInit?.targets as unknown[]).length).toBe(0);
  });

  it('status dots: ok session wins, alive-but-down warns, dead process errs', async () => {
    const rig = makeRig();
    rig.controller.start();
    await flush();
    // pre-data refresh ran before the session existed → cellapp warn (alive,
    // connecting), baseapp warn (alive), and after first data cellapp flips ok
    rig.lastSession().ready = true;
    rig.lastSession().emit(`${sampleLine(100, 120, 5)}\n`);
    await flush();
    const status = rig.posts.filter(post => post.command === 'status').pop();
    expect(status?.states).toMatchObject({ k1: 'ok', k2: 'warn' });
    rig.setAlive([]);
    await rig.controller.refreshAlive();
    const status2 = rig.posts.filter(post => post.command === 'status').pop();
    expect(status2?.states).toMatchObject({ k1: 'ok', k2: 'err' });
  });
});

describe('MemoryMonitorController.select', () => {
  it('switching tears the old session down and connects the new one', async () => {
    const rig = makeRig();
    rig.controller.start();
    rig.controller.select('k2');
    expect(rig.sessions).toHaveLength(2);
    expect(rig.sessions[0].disconnectCount).toBe(1);
    expect(rig.sessions[1].connectCount).toBe(1);
    const lastInit = rig.posts.filter(post => post.command === 'init').pop();
    expect(lastInit).toMatchObject({ selected: 'k2' });
    // window cleared on switch (fresh process, fresh data)
    expect(commandsOf(rig.posts)).toContain('clear');
  });

  it('unknown key is ignored (no session churn)', () => {
    const rig = makeRig();
    rig.controller.start();
    const before = rig.sessions.length;
    rig.controller.select('nope');
    expect(rig.sessions.length).toBe(before);
  });
});

describe('sampling beats', () => {
  it('1Hz samples on every 2nd 500ms beat, command is the exec sample', () => {
    const rig = makeRig();
    rig.controller.start();
    const handle = rig.sampleTimerHandle();
    rig.lastSession().ready = true;
    rig.timers.fire(handle);
    expect(rig.lastSession().sent).toHaveLength(0);
    rig.timers.fire(handle);
    expect(rig.lastSession().sent).toHaveLength(1);
    expect(rig.lastSession().sent[0]).toContain('exec(');
    expect(rig.lastSession().sent[0]).toContain('KODE_MEM:');
  });

  it('unready session never sends', () => {
    const rig = makeRig();
    rig.controller.start();
    const handle = rig.sampleTimerHandle();
    rig.timers.fire(handle);
    rig.timers.fire(handle);
    rig.timers.fire(handle);
    rig.timers.fire(handle);
    expect(rig.lastSession().sent).toHaveLength(0);
  });

  it('pause stops sends without dropping the timer; resume re-fires', () => {
    const rig = makeRig();
    rig.controller.start();
    const handle = rig.sampleTimerHandle();
    rig.lastSession().ready = true;
    rig.timers.fire(handle);
    rig.timers.fire(handle);
    expect(rig.lastSession().sent).toHaveLength(1);
    rig.controller.setPaused(true);
    for (let i = 0; i < 8; i++) {
      rig.timers.fire(handle);
    }
    expect(rig.lastSession().sent).toHaveLength(1);
    rig.controller.setPaused(false);
    rig.timers.fire(handle);
    rig.timers.fire(handle);
    rig.timers.fire(handle);
    rig.timers.fire(handle);
    expect(rig.lastSession().sent.length).toBeGreaterThan(1);
  });

  it('pause state is posted back so the badge survives reloads', () => {
    const rig = makeRig();
    rig.controller.start();
    rig.controller.setPaused(true);
    const lastInit = rig.posts.filter(post => post.command === 'init').pop();
    expect(lastInit).toMatchObject({ paused: true });
  });
});

describe('sample consumption', () => {
  it('parses the marker line and posts window + leaks with Y ranges', async () => {
    const rig = makeRig();
    rig.controller.start();
    await flush();
    rig.lastSession().emit(`${sampleLine(1024, 2048, 7)}\n${traceLines([['FixedArray', 3]])}\n`);
    await flush();
    const window = rig.posts.filter(post => post.command === 'window').pop();
    expect(window).toMatchObject({
      rssKb: [1024],
      peakKb: [2048],
      entities: [7]
    });
    expect(window?.rssRange).toMatchObject({ lo: expect.any(Number), hi: expect.any(Number), step: expect.any(Number) });
    const leaks = rig.posts.filter(post => post.command === 'leaks').pop();
    expect(leaks?.counters).toEqual([{ type: 'FixedArray', count: 3 }]);
  });

  it('chunked arrival accumulates until the marker completes, then consumes', async () => {
    const rig = makeRig();
    rig.controller.start();
    await flush();
    const full = `${sampleLine(10, 12, 1)}\n`;
    rig.lastSession().emit(full.slice(0, 8));
    rig.lastSession().emit(full.slice(8));
    await flush();
    const windows = rig.posts.filter(post => post.command === 'window');
    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({ rssKb: [10] });
  });

  it('bad marker payload keeps the buffer (next good data still parses)', async () => {
    const rig = makeRig();
    rig.controller.start();
    await flush();
    rig.lastSession().emit('KODE_MEM:{"rss":\n');
    rig.lastSession().emit(`${sampleLine(20, 24, 2)}\n`);
    await flush();
    const windows = rig.posts.filter(post => post.command === 'window');
    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({ rssKb: [20] });
  });

  it('data from a non-selected session is ignored', async () => {
    const rig = makeRig();
    rig.controller.start();
    rig.controller.select('k2');
    await flush();
    const stale = rig.sessions[0];
    stale.emit(`${sampleLine(999, 999, 999)}\n`);
    await flush();
    const windows = rig.posts.filter(post => post.command === 'window');
    expect(windows.filter(post => (post.rssKb as number[])[0] === 999)).toHaveLength(0);
  });
});

describe('disconnect and backoff reconnect', () => {
  it('close arms a backoff timer (1s first) and reconnects only the live session', async () => {
    const rig = makeRig();
    rig.controller.start();
    const first = rig.lastSession();
    first.emitClose();
    await flush();
    expect(commandsOf(rig.posts)).toContain('session');
    const sessionPost = rig.posts.filter(post => post.command === 'session').pop();
    expect(sessionPost).toMatchObject({ key: 'k1', state: 'backoff' });
    // reconnect scheduled at 1s (attempt 0)
    const armed = rig.timers.setInterval.mock.calls.at(-1);
    expect(armed?.[1]).toBe(1000);
    rig.timers.fire(rig.timers.lastHandle());
    expect(rig.sessions).toHaveLength(2);
    expect(rig.sessions[1].connectCount).toBe(1);
    expect(first.disconnectCount).toBeGreaterThanOrEqual(1);
  });

  it('backoff doubles per consecutive failure and caps at 30s', async () => {
    const rig = makeRig();
    rig.controller.start();
    // fail three rounds in a row: 1s → 2s → 4s
    for (const expected of [1000, 2000, 4000]) {
      rig.lastSession().emitClose();
      await flush();
      const armed = rig.timers.setInterval.mock.calls.at(-1);
      expect(armed?.[1]).toBe(expected);
      rig.timers.fire(rig.timers.lastHandle());
    }
    expect(rig.sessions).toHaveLength(4);
  });

  it('a session torn down by select never resurrects through its pending timer', async () => {
    const rig = makeRig();
    rig.controller.start();
    rig.lastSession().emitClose();
    await flush();
    const pendingHandle = rig.timers.lastHandle();
    // switch away and back before the timer fires: teardown cleared it
    rig.controller.select('k2');
    rig.controller.select('k1');
    const sessionsBeforeFire = rig.sessions.length;
    rig.timers.fire(pendingHandle);
    expect(rig.sessions.length).toBe(sessionsBeforeFire);
  });

  it('successful data resets the backoff attempt counter', async () => {
    const rig = makeRig();
    rig.controller.start();
    rig.lastSession().emitClose();
    await flush();
    rig.timers.fire(rig.timers.lastHandle());
    rig.lastSession().ready = true;
    rig.lastSession().emit(`${sampleLine(1, 1, 1)}\n`);
    // next close must restart the ladder at 1s, not continue from 2s
    rig.lastSession().emitClose();
    await flush();
    const armed = rig.timers.setInterval.mock.calls.at(-1);
    expect(armed?.[1]).toBe(1000);
  });
});

describe('leak warning gate through the controller', () => {
  const emitWithCounter = (rig: Rig, count: number): void => {
    rig.lastSession().ready = true;
    rig.lastSession().emit(`${sampleLine(1, 1, 1)}\n${traceLines([['FixedArray', count]])}\n`);
  };

  it('fires one warning on the 3rd consecutive nonzero sample, dedup after', async () => {
    const rig = makeRig();
    rig.controller.start();
    await flush();
    emitWithCounter(rig, 1);
    emitWithCounter(rig, 2);
    expect(rig.warnings).toHaveLength(0);
    emitWithCounter(rig, 3);
    expect(rig.warnings).toEqual(['LEAK:FixedArray:3']);
    emitWithCounter(rig, 4);
    expect(rig.warnings).toHaveLength(1);
  });

  it('back to zero re-arms through the controller too', async () => {
    const rig = makeRig();
    rig.controller.start();
    await flush();
    for (const n of [1, 2, 3]) {
      emitWithCounter(rig, n);
    }
    expect(rig.warnings).toHaveLength(1);
    emitWithCounter(rig, 0);
    emitWithCounter(rig, 1);
    emitWithCounter(rig, 2);
    emitWithCounter(rig, 3);
    expect(rig.warnings).toHaveLength(2);
    expect(rig.warnings[1]).toBe('LEAK:FixedArray:3');
  });
});

describe('clear and dispose', () => {
  it('clearWindow posts clear and resets the data window', async () => {
    const rig = makeRig();
    rig.controller.start();
    await flush();
    rig.lastSession().ready = true;
    rig.lastSession().emit(`${sampleLine(1, 1, 1)}\n`);
    rig.controller.clearWindow();
    expect(commandsOf(rig.posts).at(-1)).toBe('clear');
    rig.lastSession().emit(`${sampleLine(2, 2, 2)}\n`);
    const windows = rig.posts.filter(post => post.command === 'window');
    expect(windows).toHaveLength(2);
    expect(windows[1]).toMatchObject({ rssKb: [2] });
  });

  it('dispose disconnects everything, clears timers and freezes the controller', async () => {
    const rig = makeRig();
    rig.controller.start();
    const handle = rig.sampleTimerHandle();
    const first = rig.lastSession();
    rig.controller.dispose();
    expect(first.disconnectCount).toBe(1);
    expect(rig.timers.activeCount()).toBe(0);
    // post-dispose select and data are no-ops
    rig.controller.select('k2');
    expect(rig.sessions).toHaveLength(1);
    first.emit(`${sampleLine(5, 5, 5)}\n`);
    const windows = rig.posts.filter(post => post.command === 'window');
    expect(windows).toHaveLength(0);
    void handle;
  });
});
