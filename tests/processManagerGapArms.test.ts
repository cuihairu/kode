import { ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { describe, expect, it } from 'vitest';
import { ProcessManager } from '../src/processManager';

/**
 * Gap-arm coverage for src/processManager.ts (baseline uncovered statement
 * start-lines 294, 306, 318, 325, 333, 349, 350, 358, 359, 369, 370, 403, 472).
 *
 * DEAD ARMS (each with concrete reasoning; never force-tested):
 *
 * - 294 (`if (gaveUp) { return; }` guard at the top of `giveUp`): `giveUp` is
 *   only invoked from the sampler tick (314/318), the hard deadline (324), or
 *   the poll (335/339/353/357/368). Every first invocation sets `gaveUp = true`
 *   and calls `stopWatchdog()`, which clears BOTH the sampler and the hard
 *   deadline; the poll path re-checks `if (gaveUp) return;` at 331/348 before
 *   any later give-up site. So the guard at 294 can never observe a second
 *   invocation — all re-triggers are torn down by the first `giveUp`.
 *
 * - 306 (`if (gaveUp) { stopWatchdog(); return; }` in the sampler tick): the
 *   sampler is only created while `gaveUp` is false, and `giveUp` always clears
 *   it via `stopWatchdog()`. After `gaveUp` is set the sampler cannot tick
 *   again, so the guard's `stopWatchdog()` is unreachable.
 *
 * - 325 (hard-deadline `else` branch, `stopWatchdog()` after a prior giveUp):
 *   `giveUp` clears the hard deadline, so for it to fire with `gaveUp` already
 *   true the timeout would have to be dequeued into the same timer batch as the
 *   sampler tick that gave up — but the sampler is registered first, wins the
 *   same-ms batch, and its `giveUp` clears the deadline before Node dequeues it.
 *   Confirmed empirically with `intervalMs === timeoutMs` (see the first test):
 *   exactly one `giveUp('timeout')` fires and the `else` branch never runs.
 *   Defensive guard for a same-ms race that Node's `clearTimeout` prevents.
 *
 * - 358/359 and 369/370 (post-await timeout give-ups in `poll`): whenever
 *   `readiness.timeoutMs !== undefined`, a hard deadline is scheduled at exactly
 *   `timeoutMs` (lines 322-327). If `await readiness.probe()` resolves at or
 *   after `timeoutMs`, the hard deadline has already fired `giveUp('timeout')`
 *   during the await (timers run before the poll continuation), so `gaveUp` is
 *   true and line 348 returns first; if it resolves before `timeoutMs`, the
 *   `Date.now() - startedAt >= timeoutMs` condition is false. Neither site can
 *   be reached with `!gaveUp && time >= timeoutMs` — the hard deadline makes
 *   these rechecks redundant/dead.
 *
 * - 403 (`let resolveExited: () => void = () => undefined` default arrow): the
 *   Promise executor (407-420) synchronously reassigns `resolveExited` to the
 *   real resolver before the promise can be awaited or invoked anywhere, so the
 *   initial no-op arrow body never executes.
 *
 * - 472 (`this.states.delete(event.id)` in `emitState`): `emitState` with a
 *   state other than `exited`/`error` is only ever emitted while the id is
 *   still present in `this.processes` — `starting` (219, after `set` at 218),
 *   `running` (260/365, guarded by an in-registry `process === child` check),
 *   `stopping` (399, the process stays in the registry until its `exit` handler
 *   deletes it). So the `else` branch (id absent AND state non-terminal) is
 *   unreachable.
 */

class FakeChild extends EventEmitter implements ChildProcess {
  stdin = null;
  stdout = new EventEmitter() as never;
  stderr = new EventEmitter() as never;
  stdio = [null, this.stdout, this.stderr] as never;
  killed = false;
  pid = 123;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  spawnargs: string[] = [];
  kill(signal?: NodeJS.Signals): boolean {
    this.killed = true;
    this.exitCode = null;
    this.signalCode = signal ?? 'SIGTERM';
    this.emit('exit', this.exitCode, this.signalCode);
    return true;
  }
  ref(): void {}
  unref(): void {}
  disconnect(): void {}
  send(): boolean { return false; }
  connected = true;
}

describe('processManager gap arms', () => {
  it('sampler wins the timeout race (318); hard deadline is cleared before firing (325 dead)', async () => {
    // intervalMs === timeoutMs:两者同一毫秒到期,采样器(先注册)先跑出
    // giveUp('timeout')——覆盖 318。硬截止被 giveUp 的 stopWatchdog 清除,
    // 不再触发其 else 分支(325),故仅一次 giveUp 落账(死臂证据见文件头)。
    const child = new FakeChild();
    const states: string[] = [];
    const giveUps: string[] = [];
    const manager = new ProcessManager(() => child);
    manager.onState(event => states.push(event.state));
    manager.start({
      id: 'svc', command: 'server',
      readiness: {
        probe: () => new Promise<boolean>(() => undefined),
        intervalMs: 5,
        timeoutMs: 5,
        onGiveUp: reason => giveUps.push(reason)
      }
    });
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(giveUps).toEqual(['timeout']);
    expect(states).toEqual(['starting']);
    expect(manager.get('svc')).toBeDefined();
    void manager.dispose();
  });

  it('poll bails when the child already exited before probing (333)', async () => {
    const child = new FakeChild();
    child.exitCode = 1; // 进程已退出的形态
    let probeCalls = 0;
    const manager = new ProcessManager(() => child);
    manager.start({
      id: 'svc', command: 'server',
      readiness: { probe: () => { probeCalls += 1; return true; } }
    });
    // poll 首跑即见 exitCode!==null → 返回,probe 从未被调用
    expect(probeCalls).toBe(0);
    expect(manager.get('svc')).toBeDefined();
    void manager.dispose();
  });

  it('process dropped from registry during probe: late true does not advance running (349)', async () => {
    const child = new FakeChild();
    const states: string[] = [];
    const giveUps: string[] = [];
    let resolveProbe: (value: boolean) => void = () => undefined;
    const manager = new ProcessManager(() => child);
    manager.onState(event => states.push(event.state));
    manager.start({
      id: 'svc', command: 'server',
      readiness: {
        probe: () => new Promise<boolean>(resolve => (resolveProbe = resolve)),
        onGiveUp: reason => giveUps.push(reason)
      }
    });
    await new Promise(resolve => setTimeout(resolve, 5));
    // probe 在途时进程退出并清册(exit handler delete)
    child.emit('exit', 0, null);
    resolveProbe(true);
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(giveUps).toEqual([]);
    expect(states).toEqual(['starting', 'exited']);
    expect(manager.get('svc')).toBeUndefined();
    void manager.dispose();
  });

  it('child exited during probe but still in registry: post-await recheck bails (350)', async () => {
    const child = new FakeChild();
    const states: string[] = [];
    let resolveProbe: (value: boolean) => void = () => undefined;
    const manager = new ProcessManager(() => child);
    manager.onState(event => states.push(event.state));
    manager.start({
      id: 'svc', command: 'server',
      readiness: {
        probe: () => new Promise<boolean>(resolve => (resolveProbe = resolve)),
        onGiveUp: () => undefined
      }
    });
    await new Promise(resolve => setTimeout(resolve, 5));
    // probe 在途时进程退出(仅置 exitCode,未触发 exit handler——仍在册)
    child.exitCode = 1;
    resolveProbe(true);
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(states).toEqual(['starting']);
    expect(manager.get('svc')).toBeDefined();
    void manager.dispose();
  });
});
