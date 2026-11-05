import { ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { describe, expect, it } from 'vitest';
import { LogHub } from '../src/logHub';
import { ProcessManager } from '../src/processManager';

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

/** KR-AUD-39:对信号装死的子进程——收信号不退出,永不发 exit/error */
class DeafChild extends FakeChild {
  kill(): boolean {
    this.killed = true;
    return true;
  }
}

describe('ProcessManager', () => {
  it('reuses an existing process and emits unified state transitions', async () => {
    const hub = new LogHub({ flushIntervalMs: 5 });
    const child = new FakeChild();
    const children: ChildProcess[] = [];
    const manager = new ProcessManager(() => {
      children.push(new FakeChild());
      return children[children.length - 1];
    }, hub);
    const running = manager.start({ id: 'svc', command: 'server' });
    expect(manager.start({ id: 'svc', command: 'server' })).toBe(running);
    expect(children).toHaveLength(1);
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(manager.get('svc')).toBe(running);
    hub.dispose();
    void manager.dispose();
  });

  it('distinguishes requested stop from abnormal exit and awaits termination', async () => {
    const manager = new ProcessManager(() => new FakeChild());
    const states: string[] = [];
    manager.onState(event => states.push(event.state));
    manager.start({ id: 'svc', command: 'server', readyAfterMs: 1 });
    await new Promise(resolve => setTimeout(resolve, 5));
    await expect(manager.stop('svc')).resolves.toBe(true);
    expect(manager.get('svc')).toBeUndefined();
    expect(states).toEqual(['starting', 'running', 'stopping', 'exited']);
    manager.dispose();
  });

  it('reports process errors and exits without leaving reusable state', async () => {
    const child = new FakeChild();
    const states: string[] = [];
    const manager = new ProcessManager(() => child);
    manager.onState(event => states.push(event.state));
    manager.start({ id: 'bad', command: 'bad' });
    child.emit('exit', 1, null);
    expect(manager.get('bad')).toBeUndefined();
    expect(states).toEqual(['starting', 'error']);
  });

  // KR-AUD-39:spawn 失败的子进程只发 error 永不发 exit(error-only)——stop
  // 的等待面必须同样认 error 为终局,否则只能干等超时升级击杀(装死进程连
  // 升级击杀也不产生 exit,直接悬挂)。RUN-007 树杀结构不动。
  it('stop 对 error-only 子进程即时返回,不等超时升级击杀', async () => {
    const child = new DeafChild();
    const manager = new ProcessManager(() => child);
    manager.start({ id: 'svc', command: 'server', readyAfterMs: 1 });
    await new Promise(resolve => setTimeout(resolve, 5));

    const stopped = manager.stop('svc', 60_000);
    // spawn 失败:error 到场,exit 永不来
    child.emit('error', new Error('spawn ENOENT'));

    const startedAt = Date.now();
    await expect(stopped).resolves.toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    void manager.dispose();
  });

  // KR-AUD-39 超时兜底:升级击杀被 R2-F23 无效 pid 闸挡下或进程装死时 exit
  // 也不来——等待面必须按时终结,stop 绝不悬挂
  it('stop 超时兜底:树杀后仍无 exit/error 也按时终结,不悬挂', async () => {
    const child = new DeafChild();
    child.pid = 0; // spawn 失败形态:pid 空落 0,树杀被闸挡下(R2-F23)
    const manager = new ProcessManager(() => child);
    manager.start({ id: 'svc', command: 'server', readyAfterMs: 1 });
    await new Promise(resolve => setTimeout(resolve, 5));

    const startedAt = Date.now();
    await expect(manager.stop('svc', 60)).resolves.toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    void manager.dispose();
  });

  // IDE-REV-004:probe 挂起期间取消/到点,迟到 true 不得把已放弃的等待
  // 又推进 running——回包后必须复核终局条件并如实报对应 target 的原因
  it('probe 挂起期间取消:迟到 true 不误标 running,仍报 cancelled', async () => {
    const child = new FakeChild();
    const states: string[] = [];
    const giveUps: string[] = [];
    const cancelHandle = { aborted: false };
    let resolveProbe: (value: boolean) => void = () => undefined;
    const manager = new ProcessManager(() => child);
    manager.onState(event => states.push(event.state));
    manager.start({
      id: 'svc', command: 'server',
      readiness: {
        probe: () => new Promise<boolean>(resolve => (resolveProbe = resolve)),
        cancelHandle,
        onGiveUp: reason => giveUps.push(reason)
      }
    });
    await new Promise(resolve => setTimeout(resolve, 5));
    // probe 在途时取消,随后 probe 才回 true
    cancelHandle.aborted = true;
    resolveProbe(true);
    await new Promise(resolve => setTimeout(resolve, 5));

    expect(giveUps).toEqual(['cancelled']);
    expect(states).toEqual(['starting']);
    expect(manager.get('svc')).toBeDefined();
    void manager.dispose();
  });

  it('probe 挂起期间超时:迟到 true 不误标 running,仍报 timeout', async () => {
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
        timeoutMs: 5,
        onGiveUp: reason => giveUps.push(reason)
      }
    });
    await new Promise(resolve => setTimeout(resolve, 15));
    // 截止已过 probe 才回 true
    resolveProbe(true);
    await new Promise(resolve => setTimeout(resolve, 5));

    expect(giveUps).toEqual(['timeout']);
    expect(states).toEqual(['starting']);
    expect(manager.get('svc')).toBeDefined();
    void manager.dispose();
  });

  // IDE-REV-005:probe 永不结束也必须有等待边界——截止/取消由独立盯守
  // 计时器兜底按时终局,迟到回包不改终态不二次报;其他 target 不受连坐
  it('probe 永不结束:截止由盯守计时器按时终局,迟到 true 不改终态不二次报', async () => {
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
        intervalMs: 2,
        timeoutMs: 5,
        onGiveUp: reason => giveUps.push(reason)
      }
    });
    // probe 挂起不回包,截止仍须按时终局(远小于测试步长)
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(giveUps).toEqual(['timeout']);
    expect(states).toEqual(['starting']);

    // 迟到 true 不改变终态,也不二次报
    resolveProbe(true);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(giveUps).toEqual(['timeout']);
    expect(states).toEqual(['starting']);
    expect(manager.get('svc')).toBeDefined();
    void manager.dispose();
  });

  it('probe 永不结束:取消由盯守采样发现,等待按时退出', async () => {
    const child = new FakeChild();
    const states: string[] = [];
    const giveUps: string[] = [];
    const cancelHandle = { aborted: false };
    const manager = new ProcessManager(() => child);
    manager.onState(event => states.push(event.state));
    manager.start({
      id: 'svc', command: 'server',
      readiness: {
        probe: () => new Promise<boolean>(() => undefined),
        intervalMs: 2,
        cancelHandle,
        onGiveUp: reason => giveUps.push(reason)
      }
    });
    await new Promise(resolve => setTimeout(resolve, 5));
    cancelHandle.aborted = true;
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(giveUps).toEqual(['cancelled']);
    expect(states).toEqual(['starting']);
    void manager.dispose();
  });

  it('probe 永不结束:其他 target 的就绪推进不受连坐', async () => {
    const manager = new ProcessManager(() => new FakeChild());
    const states: string[] = [];
    manager.onState(event => states.push(event.state));
    manager.start({
      id: 'hung', command: 'a',
      readiness: {
        probe: () => new Promise<boolean>(() => undefined),
        intervalMs: 2,
        timeoutMs: 10_000,
        onGiveUp: () => undefined
      }
    });
    manager.start({
      id: 'healthy', command: 'b',
      readiness: {
        probe: () => true,
        intervalMs: 2,
        onGiveUp: () => undefined
      }
    });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(states).toContain('running');
    expect(manager.get('hung')).toBeDefined();
    expect(manager.get('healthy')).toBeDefined();
    void manager.dispose();
  });
});
