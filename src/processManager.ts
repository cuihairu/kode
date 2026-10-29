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
  /** IDE-RUN-003 就绪探针:给出即取代固定宽限期,探针通过才推进 running */
  readiness?: ProcessReadiness;
}

/**
 * 就绪探针(RUN-003):probe 返回 true 才把状态推进 running;返回 false 或
 * 抛异常都视为未就绪,继续轮询。进程退出即停轮询。
 * RUN-004:timeoutMs 到期或 cancelHandle 置位即放弃等待——轮询终止、回调
 * onGiveUp、绝不推进 running;放弃只结束等待,进程本体不受影响。
 */
export interface ProcessReadiness {
  probe: () => Promise<boolean> | boolean;
  /** 轮询间隔,默认 250ms */
  intervalMs?: number;
  /** 等待上限:到期放弃(缺省无上限) */
  timeoutMs?: number;
  /** 取消柄:置 aborted 即放弃 */
  cancelHandle?: { aborted: boolean };
  /** 放弃回调(超时/取消) */
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
 * 进程树终止(RUN-007):清理由组件派生的子进程。
 * - POSIX:启动即 detached 进程组长(setsid),负 pid 信号杀全组;组长已
 *   回收(ESRCH)或并非组长时回落 child.kill(单 pid 语义,测试替身同型)
 * - Windows:无进程组语义,taskkill /PID /T /F 按进程树递归终止
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
  const platform = deps.platform ?? process.platform;
  if (platform === 'win32') {
    const taskkill = deps.runTaskkill
      ? deps.runTaskkill(['/PID', String(pid), '/T', '/F'])
      : spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
    return new Promise(resolve => {
      taskkill.on('exit', code => resolve(code === 0));
      taskkill.on('error', () => resolve(false));
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
      spawn(request.command, [...(request.args ?? [])], {
        cwd: request.cwd,
        env: request.env,
        windowsHide: true,
        // POSIX 下设进程组长:停止时可负 pid 杀全组(RUN-007);Windows 树杀走 taskkill
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
   * 就绪探针轮询(RUN-003):进程仍在册且未退出才继续;探针通过恰一次推进
   * running。探针异常吞作未就绪——探针后端自身抖动不该误判进程状态。
   * RUN-004:超时/取消即终局放弃——回调 onGiveUp 后不再排程,此后服务
   * 真的就绪也不会误标 running。
   */
  private scheduleReadinessProbe(
    request: ProcessSpawnRequest,
    component: string,
    child: ChildProcess
  ): void {
    const readiness = request.readiness as ProcessReadiness;
    const intervalMs = readiness.intervalMs ?? 250;
    const startedAt = Date.now();
    const giveUp = (reason: 'timeout' | 'cancelled'): void => {
      this.logHub?.info({
        source: 'process',
        component,
        text: reason === 'timeout' ? `readiness wait timed out after ${readiness.timeoutMs}ms` : 'readiness wait cancelled'
      });
      readiness.onGiveUp?.(reason);
    };
    const poll = async (): Promise<void> => {
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
      if (this.processes.get(request.id)?.process !== child) return;
      if (child.exitCode !== null || child.signalCode !== null) return;
      // IDE-REV-004:probe 挂起跨过取消/截止,回包后必须复核终局条件——
      // 迟到的 true 不得把已放弃的等待又推进 running,如实报对应原因
      if (readiness.cancelHandle?.aborted) {
        giveUp('cancelled');
        return;
      }
      if (readiness.timeoutMs !== undefined && Date.now() - startedAt >= readiness.timeoutMs) {
        giveUp('timeout');
        return;
      }
      if (ready && !child.killed) {
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
        // RUN-007:升级击杀同样走进程树,孙进程不残留
        void killProcessTree(managed.pid, 'SIGKILL', managed.process);
      }, timeoutMs);
      // RUN-007:停止即进程树终止(POSIX 负 pid 组信号/Windows taskkill /T)
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
    await Promise.all(managed.map(item => {
      // RUN-007:dispose 同样树杀,不留孙进程
      void killProcessTree(item.pid, 'SIGKILL', item.process);
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
