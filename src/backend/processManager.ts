import { ChildProcess, ChildProcessWithoutNullStreams, spawn, SpawnOptionsWithoutStdio } from 'child_process';
import { EventEmitter } from 'events';

import { LogHubLike, normalizeText } from './logHub';

export interface ProcessSpawnRequest {
  id: string;
  command: string;
  args?: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  component?: string;
  readyAfterMs?: number;
  /** The IDE-RUN-003 readiness probe: when given, it replaces the fixed grace period, and the state advances to running only once the probe passes */
  readiness?: ProcessReadiness;
}

/**
 * The readiness probe (RUN-003): the state advances to running only when probe returns true; a
 * false result or a thrown exception both count as not ready, and polling continues. Polling stops
 * when the process exits.
 * RUN-004: when timeoutMs elapses or the cancelHandle is set, the wait is given up -- polling ends,
 * onGiveUp is called, and running is never advanced; giving up only ends the wait, the process
 * itself is untouched.
 */
export interface ProcessReadiness {
  probe: () => Promise<boolean> | boolean;
  /** The polling interval, 250ms by default */
  intervalMs?: number;
  /** The waiting cap: give up when it elapses (no cap by default) */
  timeoutMs?: number;
  /** The cancellation handle: give up once aborted is set */
  cancelHandle?: { aborted: boolean };
  /** The give-up callback (a timeout/cancellation) */
  onGiveUp?: (reason: 'timeout' | 'cancelled') => void;
}

export interface ManagedProcess {
  id: string;
  component: string;
  process: ChildProcess;
  pid: number;
  startedAt: number;
}

export type ManagedProcessState = 'starting' | 'running' | 'stopping' | 'exited' | 'error';

export interface ManagedProcessEvent {
  id: string;
  component: string;
  state: ManagedProcessState;
  exitCode?: number | null;
  signal?: NodeJS.Signals | string | null;
  error?: Error;
}

export type ProcessSpawnRunner = (request: ProcessSpawnRequest) => ChildProcess;

/**
 * WIN-2: on Windows, a direct Node spawn of a batch file is rejected (EINVAL, CVE-2024-27980), and
 * a bare name does not resolve PATHEXT -- .cmd/.bat are run through `cmd /d /c` uniformly (`@`
 * suppresses command echo). A component's defaultArgs are space-free tokens (the --key=value
 * convention), so passing them through is safe; other platforms/extensions spawn as is. A real
 * .exe engine is unaffected.
 *
 * The dual signature mirrors child_process.spawn: a caller that gives no stdio gets a
 * ChildProcessWithoutNullStreams (stdout/stderr are non-null and can be attached directly).
 */
/** An injectable spawn (isomorphic with child_process.spawn's three-argument form): a test stand-in verifies the command-line assembly without really starting a child process */
export type SpawnLike = (
  command: string,
  args: readonly string[],
  options?: Parameters<typeof spawn>[2]
) => ChildProcess;
export function spawnProcess(
  command: string,
  args: readonly string[],
  options?: SpawnOptionsWithoutStdio,
  spawnFn?: SpawnLike
): ChildProcessWithoutNullStreams;
export function spawnProcess(
  command: string,
  args: readonly string[],
  options?: Parameters<typeof spawn>[2],
  spawnFn?: SpawnLike
): ChildProcess;
export function spawnProcess(
  command: string,
  args: readonly string[],
  options?: Parameters<typeof spawn>[2],
  spawnFn: SpawnLike = (cmd, spawnArgs, spawnOptions) => spawn(cmd, spawnArgs, spawnOptions ?? {})
): ChildProcess {
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(command)) {
    // The absolute ComSpec path: the caller's face may narrow PATH (tests/sandbox), where cmd.exe is not found in PATH.
    const shell = process.env.ComSpec || 'cmd.exe';
    // Audit finding: handing `@${command}` to Node's default quoting rules means that a path with
    // spaces gets the whole string re-wrapped in quotes and backslash-escaped, breaking cmd /c's
    // quote-preservation test and truncating the command at the first space (Program Files and the
    // like). windowsVerbatimArguments owns the whole line: `@` stays outside the quotes (cmd's
    // prefix modifier), and a token with whitespace/special characters wraps itself in quotes.
    const line = [`@${quoteForCmd(command)}`, ...args.map(token => quoteForCmd(token))].join(' ');
    return spawnFn(shell, ['/d', '/c', line], {
      ...(options ?? {}),
      windowsVerbatimArguments: true
    });
  }
  return spawnFn(command, [...args], options ?? {});
}

/** cmd command-line token quoting: a token with whitespace/quotes/cmd metacharacters is wrapped whole in double quotes, with embedded quotes doubled. */
function quoteForCmd(token: string): string {
  if (!/[\s"&|<>^]/.test(token)) {
    return token;
  }
  return `"${token.replace(/"/g, '""')}"`;
}


/**
 * Process-tree termination (RUN-007): clean up the child processes a component derived.
 * - POSIX: start as a detached process-group leader (setsid), and a negative-pid signal kills the
 *   whole group; when the leader has already been reaped (ESRCH) or is not a leader at all, fall
 *   back to child.kill (single-pid semantics, a test stand-in has the same shape)
 * - Windows: there is no process-group semantics, so taskkill /PID /T /F terminates recursively by
 *   process tree
 * - R2-F23: an invalid PID (missing/0/negative/non-integer) never gets a signal --
 *   process.kill(-0) would hit the caller's own process group (mistakenly killing the host group),
 *   and taskkill /PID 0 likewise; when spawn fails child.pid is empty and lands on 0, and the
 *   stop / escalated kill / dispose paths are all stopped here at this gate
 */
export const killProcessTree = async (
  pid: number,
  signal: NodeJS.Signals,
  child?: ChildProcess,
  deps: {
    runTaskkill?: (args: string[]) => { on: (event: string, listener: (code: number | null) => void) => void };
    platform?: NodeJS.Platform;
  } = {}
): Promise<boolean> => {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  const platform = deps.platform ?? process.platform;
  if (platform === 'win32') {
    const taskkill = deps.runTaskkill
      ? deps.runTaskkill(['/PID', String(pid), '/T', '/F'])
      : spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
    return new Promise(resolve => {
      taskkill.on('exit', code => {
        if (code === 0) {
          resolve(true);
          return;
        }
        // taskkill failed (the process already exited / the PID does not exist / a test stand-in's fake pid):
        // fall back to child.kill -- the same semantics as the POSIX branch, otherwise stop would
        // dry-wait until the timeout escalation.
        resolve(child ? child.kill(signal) : false);
      });
      taskkill.on('error', () => resolve(child ? child.kill(signal) : false));
    });
  }
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    if (child) {
      return child.kill(signal);
    }
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  }
};

export class ProcessManager {
  private readonly processes = new Map<string, ManagedProcess>();
  private readonly stateEvents = new EventEmitter();
  private readonly runner: ProcessSpawnRunner;

  constructor(runner?: ProcessSpawnRunner, private readonly logHub?: LogHubLike) {
    this.runner = runner ?? ((request: ProcessSpawnRequest) =>
      spawnProcess(request.command, request.args ?? [], {
        cwd: request.cwd,
        env: request.env,
        windowsHide: true,
        // On POSIX, become a process-group leader: a stop can then kill the whole group with a negative pid (RUN-007); Windows kills the tree via taskkill
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe']
      }));
    this.stateEvents.setMaxListeners(0);
  }

  start(request: ProcessSpawnRequest): ManagedProcess {
    const existing = this.processes.get(request.id);
    if (existing) {
      this.logHub?.info({
        source: 'process',
        component: request.component ?? request.id,
        text: 'process already running; reusing it'
      });
      return existing;
    }

    const component = request.component ?? request.id;
    this.logHub?.info({
      source: 'process',
      component,
      text: `starting ${request.command} ${(request.args ?? []).join(' ')}`.trim()
    });
    let child: ChildProcess;
    try {
      child = this.runner({ ...request, args: [...(request.args ?? [])] });
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.logHub?.error({ source: 'process', component, text: failure.message });
      this.stateEvents.emit('state', {
        id: request.id,
        component,
        state: 'error',
        error: failure
      } satisfies ManagedProcessEvent);
      throw failure;
    }

    const managed: ManagedProcess = {
      id: request.id,
      component,
      process: child,
      pid: child.pid ?? 0,
      startedAt: Date.now()
    };
    this.processes.set(request.id, managed);
    this.emitState({ id: request.id, component, state: 'starting' });
    this.logHub?.info({ source: 'process', component, text: `PID ${managed.pid}` });

    child.stdout?.setEncoding?.('utf8');
    child.stderr?.setEncoding?.('utf8');
    child.stdout?.on('data', chunk => this.logHub?.stdout({
      source: 'stdout', component, text: normalizeText(String(chunk))
    }));
    child.stderr?.on('data', chunk => this.logHub?.stderr({
      source: 'stderr', component, text: normalizeText(String(chunk))
    }));
    child.on('error', error => {
      this.logHub?.error({ source: 'process', component, text: `进程错误: ${error.message}` });
      this.emitState({ id: request.id, component, state: 'error', error });
      this.processes.delete(request.id);
      this.logHub?.flush?.();
    });
    child.on('exit', (exitCode, signal) => {
      this.logHub?.info({
        source: 'process',
        component,
        text: `进程退出: code=${exitCode}, signal=${signal}`
      });
      // The terminal semantics are judged from the manager's own ledger: when stop()/dispose() kills the
      // tree via the group-signal main path it never goes through child.kill, so child.killed is
      // still false -- trusting it alone would misreport a process we deliberately stopped as an
      // error (while the fallback path reports exited, two semantics for the same action). A
      // stopping entry on the ledger = a deliberate stop, and a signal-terminated outcome also
      // counts as exited; only a process that dies of its own signal is an error.
      const stopping = this.states.get(request.id) === 'stopping';
      this.emitState({
        id: request.id,
        component,
        state: exitCode === 0 || stopping || child.killed ? 'exited' : 'error',
        exitCode,
        signal
      });
      if (this.processes.get(request.id)?.process === child) {
        this.processes.delete(request.id);
      }
      this.logHub?.flush?.();
    });
    if (request.readiness) {
      this.scheduleReadinessProbe(request, component, child);
    } else {
      const readinessTimer = setTimeout(() => {
        if (this.processes.get(request.id)?.process === child && !child.killed) {
          this.states.set(request.id, 'running');
          this.emitState({ id: request.id, component, state: 'running' });
        }
      }, request.readyAfterMs ?? 0);
      readinessTimer.unref?.();
    }
    return managed;
  }

  /**
   * The readiness-probe polling (RUN-003): it continues only while the process is still on the
   * ledger and has not exited; a passing probe advances to running exactly once. A probe exception
   * is swallowed as not-ready -- the probe backend's own jitter must not misjudge the process
   * state.
   * RUN-004: a timeout/cancellation is a terminal give-up -- once onGiveUp has been called nothing
   * is scheduled again, so even a service that truly becomes ready afterwards is not mislabelled
   * running.
   * IDE-REV-005: the waiting boundary does not rely on the probe's reply -- the watchdog timers
   * sample cancellation and the deadline independently (cancelHandle is a polled flag with no
   * subscribable event, sampled at the same interval as intervalMs; the deadline additionally has
   * a one-shot hard timer as a backstop), so a probe that never ends still settles on time; after
   * the terminal state a late reply neither changes it nor reports a second time, all timers are
   * cleared, and other targets each stay independent without collateral damage.
   */
  private scheduleReadinessProbe(
    request: ProcessSpawnRequest,
    component: string,
    child: ChildProcess
  ): void {
    const readiness = request.readiness as ProcessReadiness;
    const intervalMs = readiness.intervalMs ?? 250;
    const startedAt = Date.now();
    let gaveUp = false;
    let cancelSampler: ReturnType<typeof setInterval> | undefined;
    let hardDeadline: ReturnType<typeof setTimeout> | undefined;
    const stopWatchdog = (): void => {
      if (cancelSampler) { clearInterval(cancelSampler); cancelSampler = undefined; }
      if (hardDeadline) { clearTimeout(hardDeadline); hardDeadline = undefined; }
    };
    const giveUp = (reason: 'timeout' | 'cancelled'): void => {
      if (gaveUp) { return; }
      gaveUp = true;
      stopWatchdog();
      this.logHub?.info({
        source: 'process',
        component,
        text: reason === 'timeout' ? `readiness wait timed out after ${readiness.timeoutMs}ms` : 'readiness wait cancelled'
      });
      readiness.onGiveUp?.(reason);
    };
    if (readiness.cancelHandle || readiness.timeoutMs !== undefined) {
      cancelSampler = setInterval(() => {
        if (gaveUp) { stopWatchdog(); return; }
        // The process is no longer on the ledger / has exited: the waiting face winds down with it, no need to keep watching
        if (this.processes.get(request.id)?.process !== child ||
            child.exitCode !== null || child.signalCode !== null) {
          stopWatchdog();
          return;
        }
        if (readiness.cancelHandle?.aborted) {
          giveUp('cancelled');
          return;
        }
        if (readiness.timeoutMs !== undefined && Date.now() - startedAt >= readiness.timeoutMs) {
          giveUp('timeout');
        }
      }, intervalMs);
      cancelSampler.unref?.();
      if (readiness.timeoutMs !== undefined) {
        hardDeadline = setTimeout(() => {
          if (!gaveUp) { giveUp('timeout'); return; }
          stopWatchdog();
        }, readiness.timeoutMs);
        hardDeadline.unref?.();
      }
    }
    const poll = async (): Promise<void> => {
      if (gaveUp) return;
      if (this.processes.get(request.id)?.process !== child) return;
      if (child.exitCode !== null || child.signalCode !== null) return;
      if (readiness.cancelHandle?.aborted) {
        giveUp('cancelled');
        return;
      }
      if (readiness.timeoutMs !== undefined && Date.now() - startedAt >= readiness.timeoutMs) {
        giveUp('timeout');
        return;
      }
      let ready = false;
      try {
        ready = await readiness.probe();
      } catch {
        ready = false;
      }
      if (gaveUp) return;
      if (this.processes.get(request.id)?.process !== child) return;
      if (child.exitCode !== null || child.signalCode !== null) return;
      // IDE-REV-004: a probe that hangs across a cancellation/deadline must have the terminal conditions re-checked once its reply arrives --
      // a late true must not advance an already-given-up wait to running again; report the corresponding reason honestly
      if (readiness.cancelHandle?.aborted) {
        giveUp('cancelled');
        return;
      }
      if (readiness.timeoutMs !== undefined && Date.now() - startedAt >= readiness.timeoutMs) {
        giveUp('timeout');
        return;
      }
      if (ready && !child.killed) {
        stopWatchdog();
        this.states.set(request.id, 'running');
        this.logHub?.info({ source: 'process', component, text: 'readiness probe passed' });
        this.emitState({ id: request.id, component, state: 'running' });
        return;
      }
      if (readiness.timeoutMs !== undefined && Date.now() - startedAt >= readiness.timeoutMs) {
        giveUp('timeout');
        return;
      }
      const timer = setTimeout(() => {
        void poll();
      }, intervalMs);
      timer.unref?.();
    };
    void poll();
  }

  get(id: string): ManagedProcess | undefined {
    return this.processes.get(id);
  }

  list(): ManagedProcess[] {
    return [...this.processes.values()];
  }

  onState(listener: (event: ManagedProcessEvent) => void): () => void {
    this.stateEvents.on('state', listener);
    return () => this.stateEvents.off('state', listener);
  }

  async stop(id: string, timeoutMs = 5000): Promise<boolean> {
    const managed = this.processes.get(id);
    if (!managed || managed.process.killed) {
      return false;
    }
    this.states.set(id, 'stopping');
    this.emitState({ id, component: managed.component, state: 'stopping' });

    return (async () => {
      let timer: NodeJS.Timeout | undefined = undefined; // eslint-disable-line prefer-const
      let resolveExited: () => void = () => undefined;
      const clearEscalation = (): void => {
        if (timer) clearTimeout(timer);
      };
      const exited = new Promise<void>(resolve => {
        resolveExited = () => {
          clearEscalation();
          resolve();
        };
        if (managed.process.exitCode !== null || managed.process.signalCode !== null) {
          resolveExited();
          return;
        }
        managed.process.once('exit', resolveExited);
        // KR-AUD-39: a child process whose spawn failed is error-only -- it emits error and never exit,
        // so the waiting face likewise treats error as terminal and no longer dry-waits for the
        // timeout escalation kill
        managed.process.once('error', resolveExited);
      });

      timer = setTimeout(() => {
        // RUN-007: the escalated kill likewise goes through the process tree, so no grandchild processes are left behind
        void killProcessTree(managed.pid, 'SIGKILL', managed.process);
        // The KR-AUD-39 backstop: when the kill is stopped by the R2-F23 invalid-pid gate, or the process
        // hangs, exit still never arrives -- the waiting face ends on schedule, and stop never
        // hangs. First give SIGKILL a brief genuine terminal window so exit/error fire normally
        // (logs/state complete); only when they do not arrive within it does the fallback resolve.
        setTimeout(() => {
          // WIN: under extreme scheduling taskkill's error/exit events arrive late and child.kill
          // never ran inside the window -- issue one single-process kill before the fallback to
          // guarantee exit precedes resolve: otherwise the process lingers in processes and a
          // later start reuses the stale instance (the restart fracture face).
          managed.process.kill('SIGKILL');
          resolveExited();
        }, 250);
      }, timeoutMs);
      // RUN-007: stopping means process-tree termination (POSIX negative-pid group signal / Windows taskkill /T)
      void killProcessTree(managed.pid, 'SIGTERM', managed.process);
      await exited;
      return true;
    })();
  }

  async restart(request: ProcessSpawnRequest, timeoutMs = 5000): Promise<ManagedProcess | undefined> {
    const existing = this.processes.get(request.id);
    if (existing) {
      await this.stop(request.id, timeoutMs);
    }
    return this.start(request);
  }

  async dispose(): Promise<void> {
    const managed = Array.from(this.processes.values());
    // A deliberate destruction records the stopping ledger first: the exit event's terminal semantics (see the exit handling) then judge it as
    // exited rather than error, on the same terms as stop()
    for (const item of managed) {
      this.states.set(item.id, 'stopping');
    }
    await Promise.all(managed.map(item => {
      // RUN-007: dispose likewise kills the tree, leaving no grandchild processes behind
      void killProcessTree(item.pid, 'SIGKILL', item.process);
      return new Promise<void>(resolve => {
        if (item.process.exitCode !== null || item.process.signalCode !== null) resolve();
        item.process.once('exit', resolve);
        // The KR-AUD-39 same family: a spawn-failed child process is error-only (it emits error and never
        // exit), so the dispose waiting face treats error as terminal and does not hang
        item.process.once('error', resolve);
      });
    }));
    this.processes.clear();
    this.stateEvents.removeAllListeners();
  }

  private readonly states = new Map<string, ManagedProcessState>();

  private emitState(event: ManagedProcessEvent): void {
    if (this.processes.has(event.id) || event.state === 'exited' || event.state === 'error') {
      this.states.set(event.id, event.state);
    } else {
      this.states.delete(event.id);
    }
    this.stateEvents.emit('state', event);
  }
}
