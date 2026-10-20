import { ChildProcess, spawn } from 'child_process';
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

export class ProcessManager {
  private readonly processes = new Map<string, ManagedProcess>();
  private readonly stateEvents = new EventEmitter();
  private readonly runner: ProcessSpawnRunner;

  constructor(runner?: ProcessSpawnRunner, private readonly logHub?: LogHubLike) {
    this.runner = runner ?? ((request: ProcessSpawnRequest) =>
      spawn(request.command, [...(request.args ?? [])], {
        cwd: request.cwd,
        env: request.env,
        windowsHide: true,
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
      this.emitState({
        id: request.id,
        component,
        state: exitCode === 0 || child.killed ? 'exited' : 'error',
        exitCode,
        signal
      });
      if (this.processes.get(request.id)?.process === child) {
        this.processes.delete(request.id);
      }
      this.logHub?.flush?.();
    });
    const readinessTimer = setTimeout(() => {
      if (this.processes.get(request.id)?.process === child && !child.killed) {
        this.states.set(request.id, 'running');
        this.emitState({ id: request.id, component, state: 'running' });
      }
    }, request.readyAfterMs ?? 0);
    readinessTimer.unref?.();
    return managed;
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
      let timer: NodeJS.Timeout | undefined;
      const exited = new Promise<void>(resolveExit => {
        if (managed.process.exitCode !== null || managed.process.signalCode !== null) {
          resolveExit();
        }
        managed.process.once('exit', () => {
          if (timer) clearTimeout(timer);
          resolveExit();
        });
      });

      timer = setTimeout(() => {
        managed.process.kill('SIGKILL');
      }, timeoutMs);
      managed.process.kill('SIGTERM');
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
    await Promise.all(managed.map(item => {
      item.process.kill('SIGKILL');
      return new Promise<void>(resolve => {
        if (item.process.exitCode !== null || item.process.signalCode !== null) resolve();
        item.process.once('exit', resolve);
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
