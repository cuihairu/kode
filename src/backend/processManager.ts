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
 * WIN-2:Windows 上 Node 直 spawn 批处理被拒(EINVAL,CVE-2024-27980)且裸名
 * 不解析 PATHEXT——.cmd/.bat 统一经 `cmd /d /c` 运行(`@` 抑制命令回显)。
 * 组件 defaultArgs 为无空格 token(--key=value 口径),透传安全;其余平台/
 * 扩展原样 spawn。真实 .exe 引擎不受影响。
 *
 * 双签名镜像 child_process.spawn:未给 stdio 的调用面拿
 * ChildProcessWithoutNullStreams(stdout/stderr 非空可直接挂)。
 */
/** 可注入 spawn(与 child_process.spawn 三参形态同构):测试替身验证命令行组装,不真起子进程 */
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
    // ComSpec 绝对路径:调用面可能收窄 PATH(测试/沙箱),PATH 里找不到 cmd.exe。
    const shell = process.env.ComSpec || 'cmd.exe';
    // 审核发现:`@${command}` 交给 Node 默认引号规则,路径含空格时 Node 把
    // 整串再包引号并反斜杠转义,cmd /c 的引号保留判定被破坏,命令在首个
    // 空格处截断(Program Files 等)。windowsVerbatimArguments 自负整行:
    // `@` 留在引号外(cmd 的前缀修饰符),含空白/特殊字符的 token 自包引号。
    const line = [`@${quoteForCmd(command)}`, ...args.map(token => quoteForCmd(token))].join(' ');
    return spawnFn(shell, ['/d', '/c', line], {
      ...(options ?? {}),
      windowsVerbatimArguments: true
    });
  }
  return spawnFn(command, [...args], options ?? {});
}

/** cmd 命令行 token 引用:含空白/引号/cmd 元字符时整体包双引号,内嵌引号双写。 */
function quoteForCmd(token: string): string {
  if (!/[\s"&|<>^]/.test(token)) {
    return token;
  }
  return `"${token.replace(/"/g, '""')}"`;
}


/**
 * 进程树终止(RUN-007):清理由组件派生的子进程。
 * - POSIX:启动即 detached 进程组长(setsid),负 pid 信号杀全组;组长已
 *   回收(ESRCH)或并非组长时回落 child.kill(单 pid 语义,测试替身同型)
 * - Windows:无进程组语义,taskkill /PID /T /F 按进程树递归终止
 * - R2-F23:无效 PID(缺失/0/负/非整数)绝不发信号——process.kill(-0) 命中
 *   调用方自身进程组(误杀宿主组),taskkill /PID 0 同理;spawn 失败时
 *   child.pid 为空落 0,停止/升级击杀/dispose 三路都经此闸挡下
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
        // taskkill 失败(进程已退出/PID 不存在/测试替身假 pid):回落
        // child.kill——与 POSIX 分支同语义,否则 stop 干等到超时升级。
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
   * IDE-REV-005:等待边界不依赖 probe 回包——盯守计时器独立采样取消与
   * 截止(cancelHandle 是轮询标志无事件可订阅,采样间隔同 intervalMs;
   * 截止另有一次性硬定时器兜底),probe 永不结束也按时终局;终局后迟到
   * 回包不改终态不二次报,计时器全清,其他 target 各自独立不受连坐。
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
        // 进程已不在册/已退出:等待面随之收场,无需继续盯守
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
        // KR-AUD-39:spawn 失败的子进程 error-only——只发 error 永不发 exit,
        // 等待面同样认 error 为终局,不再干等超时升级击杀
        managed.process.once('error', resolveExited);
      });

      timer = setTimeout(() => {
        // RUN-007:升级击杀同样走进程树,孙进程不残留
        void killProcessTree(managed.pid, 'SIGKILL', managed.process);
        // KR-AUD-39 兜底:击杀被 R2-F23 无效 pid 闸挡下或进程装死时 exit 仍
        // 不来——等待面按时终结,stop 绝不悬挂。先给 SIGKILL 一个短暂的真
        // 实终局窗口,让 exit/error 正常触发(日志/状态完整),窗口内不来
        // 才兜底 resolve。
        setTimeout(() => {
          // WIN:极端调度下 taskkill 的 error/exit 事件迟到,窗口内 child.kill
          // 也没跑到——兜底前补一次单进程 kill,保证 exit 先于 resolve:否则
          // 进程滞留 processes,后续 start 复用旧实例(restart 断裂面)。
          managed.process.kill('SIGKILL');
          resolveExited();
        }, 250);
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
        // KR-AUD-39 同族:spawn 失败子进程 error-only(只发 error 不发 exit),
        // dispose 等待面认 error 为终局,不悬挂
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
