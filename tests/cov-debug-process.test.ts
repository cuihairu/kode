import { spawn } from 'child_process';
import { ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CONSOLE_PROFILE_CB_MSG_ID,
  buildCString,
  buildFrame,
  parseProfileFrame,
  startProfileQuery
} from '../src/kbengineProtocol';
import {
  WAIT_BOOTSTRAP_BEGIN,
  WAIT_BOOTSTRAP_END,
  findEngineEntryScript,
  injectWaitBootstrap,
  removeWaitBootstrap
} from '../src/debugpyWaitAtStartup';
import {
  injectDebugpyAfterStart,
  injectDebugpyListen,
  syncDebugpyPackage,
  type InjectionClientFactory
} from '../src/autoDebugpy';
import { defaultDebugpyInstallRunner, defaultTcpConnect } from '../src/debugpyPortProbe';
import { checkInterpreterDebugpy, debugpyPreflightDeps } from '../src/debugpyPreflight';
import { defaultSpawnRunner } from '../src/pyspyDump';
import { ProcessManager, killProcessTree } from '../src/processManager';
import { PYLANCE_EXTENSION_ID, collectPythonServiceFacts } from '../src/pythonLanguageServiceStatus';
import {
  findPythonReceiverCallArguments,
  getPythonCallAtPosition,
  getPythonMemberAccessAtPosition
} from '../src/pythonLanguageUtils';
import type { TelnetTarget } from '../src/telnetService';
import { configurationOverrides, fakeExtensionList } from './helpers/vscodeStub';
import { makeSimComponentInfo } from './sim/machineSimulator';

// 调试/进程链路模块的未覆盖分支补角(ground truth = coverage/lcov.info):
// 各模块「真实 spawn/socket/fs」默认通道(defaultSpawnRunner/defaultTcpConnect/
// runInterpreterCodeDefault/defaultRunPython+defaultDeps)、parseProfileFrame 的
// event/network/cprofile 三种结果帧、queryConsoleFrames 的无关帧重挂超时与
// 连接被拒、ProcessManager 就绪探针终局面与 list/stop/restart 冒面、
// killProcessTree 的 POSIX 单 pid 回落、debugpyWaitAtStartup 依赖注入的
// 格式/错误分支、collectPythonServiceFacts 事实采集,以及 pythonLanguageUtils
// 实参切分/成员访问/调用解析的字符串与深度边界。不可达分支见文末定性注释。

// ---------------------------------------------------------------------------
// 公共替身与工具
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];
const originalPath = process.env.PATH;

const makeTempDir = (prefix: string): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
};

/** 假解释器:可执行 shell 脚本冒充 python3(spawn 面只看存在与退出码) */
const writeFakeInterpreter = (dir: string, body: string): string => {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'python3');
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, 'utf8');
  fs.chmodSync(file, 0o755);
  return file;
};

/** 已关闭端口:连接必被拒(ECONNREFUSED),区别于无路由黑洞 */
const deadPort = async (): Promise<number> => {
  const server = net.createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
};

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

const u32 = (value: number): Buffer => {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value, 0);
  return buffer;
};

const f32 = (value: number): Buffer => {
  const buffer = Buffer.alloc(4);
  buffer.writeFloatLE(value, 0);
  return buffer;
};

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  }
  process.env.PATH = originalPath;
  configurationOverrides.delete('kbengine');
  configurationOverrides.delete('python.analysis');
});

// ---------------------------------------------------------------------------
// pyspyDump.defaultSpawnRunner:真实 spawn 的收尾通道
// ---------------------------------------------------------------------------

describe('defaultSpawnRunner(真实 spawn 通道)', () => {
  it('正常退出:stdout 收齐、退出码原样带回', async () => {
    const result = await defaultSpawnRunner(process.execPath, ['-e', 'console.log("stack line")'], 4000);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('stack line\n');
    expect(result.stderr).toBe('');
  }, 8000);

  it('stderr 分收:错误输出不混进 stdout', async () => {
    const result = await defaultSpawnRunner(process.execPath, ['-e', 'console.error("boom")'], 4000);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('boom\n');
  }, 8000);

  it('命令不存在:error 通道把 ENOENT 写进 stderr,按 -1 退出', async () => {
    const result = await defaultSpawnRunner('/nonexistent-kode-pyspy', ['--version'], 2000);
    expect(result.exitCode).toBe(-1);
    expect(result.stderr).toContain('ENOENT');
  }, 8000);

  it('超时:杀进程按 -1 退出,迟到的 close 不改结果', async () => {
    const result = await defaultSpawnRunner(
      process.execPath,
      ['-e', 'setTimeout(() => {}, 8000)'],
      150
    );
    expect(result.exitCode).toBe(-1);
    await sleep(50); // kill 后的 close 事件只会撞 settled 守卫
    expect(result.exitCode).toBe(-1);
  }, 8000);

  it('空命令同步抛:被兜住按 -1 返回,不炸调用方', async () => {
    const result = await defaultSpawnRunner('', [], 500);
    expect(result.exitCode).toBe(-1);
    expect(result.stderr).toContain('TypeError');
  }, 8000);
});

// ---------------------------------------------------------------------------
// debugpyPortProbe:defaultTcpConnect 归类面 + defaultDebugpyInstallRunner
// ---------------------------------------------------------------------------

describe('defaultTcpConnect(未开原因归类)', () => {
  it('无路由测试网段:到点归 timeout,带超时毫秒数', async () => {
    // 240.0.0.1=Class E 保留段(RFC 1112),比 TEST-NET-1(192.0.2.1)更可靠——
    // 实测部分网络把 TEST-NET 路由掉并接受连接,Class E 无真实主机不路由
    const probe = await defaultTcpConnect('240.0.0.1', 81, 250);
    expect(probe.open).toBe(false);
    expect(probe.reason).toBe('timeout');
    expect(probe.detail).toContain('250ms');
  }, 8000);

  it('非法主机名(含空格):getaddrinfo ENOTFOUND 归 unresolved-host', async () => {
    const probe = await defaultTcpConnect('no such host', 80, 1000);
    expect(probe.open).toBe(false);
    expect(probe.reason).toBe('unresolved-host');
    expect(probe.detail).toBe('ENOTFOUND');
  }, 8000);

  it('超长主机名 EINVAL:归 unknown 带错误码', async () => {
    const probe = await defaultTcpConnect('x'.repeat(300), 80, 1000);
    expect(probe.open).toBe(false);
    expect(probe.reason).toBe('unknown');
    expect(probe.detail).toBe('EINVAL');
  }, 8000);

  it('非法端口同步抛 RangeError:兜住归 unknown', async () => {
    const probe = await defaultTcpConnect('127.0.0.1', -1, 500);
    expect(probe.open).toBe(false);
    expect(probe.reason).toBe('unknown');
    expect(probe.detail).toContain('RangeError');
  }, 8000);
});

describe('defaultDebugpyInstallRunner(真实 spawn 安装通道)', () => {
  it('假解释器零退出:ok 带输出尾三行(更早行剔除)', async () => {
    const bin = makeTempDir('kode-pip-');
    writeFakeInterpreter(bin, 'printf \'l1\\nl2\\nl3\\nl4\\n\'');
    const result = await defaultDebugpyInstallRunner(path.join(bin, 'python3'));
    expect(result.ok).toBe(true);
    expect(result.detail).toContain('l2 | l3 | l4');
    expect(result.detail).not.toContain('l1');
  }, 8000);

  it('空命令同步抛:兜住如实失败不假成功', async () => {
    const result = await defaultDebugpyInstallRunner('');
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('TypeError');
  }, 8000);
});

// ---------------------------------------------------------------------------
// debugpyPreflight:runInterpreterCodeDefault + debugpyPreflightDeps(真实 spawn)
// ---------------------------------------------------------------------------

describe('debugpyPreflightDeps(真实 spawn 探测面)', () => {
  it('PATH 上的假解释器:版本探测零退出,预检 kind=ok 带版本', async () => {
    const bin = makeTempDir('kode-preflight-');
    writeFakeInterpreter(bin, 'printf \'1.8.0\\n\'');
    process.env.PATH = bin;
    const status = await checkInterpreterDebugpy(debugpyPreflightDeps());
    expect(status.kind).toBe('ok');
    expect(status.interpreterPath).toBe(path.join(bin, 'python3'));
    expect(status.version).toBe('1.8.0');
  }, 8000);

  it('解释器起不来:error 事件按非零退出,预检如实归缺包', async () => {
    const resolution = { interpreterPath: '/nonexistent-kode-python', interpreterSource: 'setting' as const };
    const status = await checkInterpreterDebugpy({
      resolveInterpreter: () => resolution,
      runInterpreterCode: debugpyPreflightDeps().runInterpreterCode
    });
    expect(status.kind).toBe('debugpy-missing');
    expect(status.version).toBeNull();
  }, 8000);

  it('空解释器同步抛:兜住按 -1 返回;探测代码原样作 -c 入参', async () => {
    const { runInterpreterCode } = debugpyPreflightDeps();
    const thrown = await runInterpreterCode('', 'print(1)');
    expect(thrown).toEqual({ stdout: '', exitCode: -1 });
  }, 8000);
});

// ---------------------------------------------------------------------------
// autoDebugpy:defaultRunPython + defaultDeps(真实 spawn/fs 全链)
// ---------------------------------------------------------------------------

describe('syncDebugpyPackage 默认依赖链(真实 spawn + 真 fs)', () => {
  const makeMemento = () => {
    const store = new Map<string, unknown>();
    return {
      get: <T>(key: string): T | undefined => store.get(key) as T | undefined,
      update: async (key: string, value: unknown): Promise<void> => {
        store.set(key, value);
      },
      keys: (): string[] => [...store.keys()]
    };
  };

  let bin = '';
  let assets = '';

  beforeEach(() => {
    bin = makeTempDir('kode-sync-bin-');
    assets = makeTempDir('kode-sync-assets-');
  });

  it('全链:假解释器报版本与目录,真 cpSync 落包,状态 synced 且记账', async () => {
    const src = path.join(makeTempDir('kode-sync-src-'), 'debugpy');
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, '__init__.py'), "__version__ = '1.8.0'\n", 'utf8');
    fs.writeFileSync(path.join(src, 'server.py'), '# payload\n', 'utf8');
    writeFakeInterpreter(bin, `printf '{"version":"1.8.0","dir":"${src}"}\\n'`);
    process.env.PATH = bin;

    const memento = makeMemento();
    const result = await syncDebugpyPackage({ workspaceState: memento }, assets);

    expect(result.status).toBe('synced');
    const target = path.join(assets, 'scripts', 'common', 'debugpy');
    expect(fs.readFileSync(path.join(target, '__init__.py'), 'utf8')).toContain("'1.8.0'");
    expect(fs.existsSync(path.join(target, 'server.py'))).toBe(true);
    expect(memento.get<string>(`kbengine.debugpySync.managed:${target}`)).toBe('1.8.0');
  }, 8000);

  it('PATH 上无任何解释器:候选逐个 ENOENT,如实 error 不抛', async () => {
    const empty = makeTempDir('kode-sync-empty-');
    process.env.PATH = empty;

    const result = await syncDebugpyPackage({ workspaceState: makeMemento() }, assets);

    expect(result.status).toBe('error');
    expect(result.message).toContain('没有可用的 debugpy 包');
  }, 8000);

  it('解释器输出非 JSON:解析失败如实 error 带原文截断', async () => {
    writeFakeInterpreter(bin, 'printf \'not-json-at-all\\n\'');
    process.env.PATH = bin;

    const result = await syncDebugpyPackage({ workspaceState: makeMemento() }, assets);

    expect(result.status).toBe('error');
    expect(result.message).toContain('无法解析');
    expect(result.message).toContain('not-json-at-all');
  }, 8000);

  it('报出的目录不在盘:如实 error 带路径', async () => {
    writeFakeInterpreter(bin, 'printf \'{"version":"1.8.0","dir":"/nonexistent-kode-debugpy-dir"}\\n\'');
    process.env.PATH = bin;

    const result = await syncDebugpyPackage({ workspaceState: makeMemento() }, assets);

    expect(result.status).toBe('error');
    expect(result.message).toContain('/nonexistent-kode-debugpy-dir');
  }, 8000);

  it('目标目录在盘但读不出版本:视为用户手放 skipped-user 零写入', async () => {
    const src = path.join(makeTempDir('kode-sync-src2-'), 'debugpy');
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, '__init__.py'), 'pass\n', 'utf8');
    writeFakeInterpreter(bin, `printf '{"version":"1.8.0","dir":"${src}"}\\n'`);
    process.env.PATH = bin;
    const target = path.join(assets, 'scripts', 'common', 'debugpy');
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, '__init__.py'), '# 用户手放,无版本行\n', 'utf8');

    const result = await syncDebugpyPackage({ workspaceState: makeMemento() }, assets);

    expect(result.status).toBe('skipped-user');
    expect(fs.readFileSync(path.join(target, '__init__.py'), 'utf8')).toContain('用户手放');
  }, 8000);
});

// ---------------------------------------------------------------------------
// autoDebugpy.injectDebugpyListen:失败分支(注入客户端替身)
// ---------------------------------------------------------------------------

describe('injectDebugpyListen 失败分支(客户端替身)', () => {
  interface Stub {
    createClient: InjectionClientFactory;
    sent: string[];
    disconnected: boolean;
    emitData(text: string): void;
    emitState(state: 'auth-rejected'): void;
  }

  const makeStub = (): Stub => {
    const sent: string[] = [];
    let disconnected = false;
    let events: Parameters<InjectionClientFactory>[0]['events'];
    const createClient: InjectionClientFactory = options => {
      events = options.events;
      return {
        sendCommand: command => {
          sent.push(command);
          return true;
        },
        disconnect: () => {
          disconnected = true;
        }
      };
    };
    return {
      createClient,
      sent,
      get disconnected() {
        return disconnected;
      },
      emitData: text => events?.onData?.(text),
      emitState: state => events?.onStateChange?.(state, 'test')
    };
  };

  it('密码被拒:立即判失败,一条命令都不发,断开收尾', async () => {
    const stub = makeStub();
    const pending = injectDebugpyListen(
      { host: '127.0.0.1', port: 40000, password: 'bad' },
      5678,
      { createClient: stub.createClient, stepTimeoutMs: 500 }
    );
    // 工厂一建客户端即收到 auth-rejected
    stub.emitState('auth-rejected');
    const result = await pending;

    expect(result.status).toBe('failed');
    expect(result.detail).toContain('密码被拒');
    expect(stub.sent).toEqual([]);
    expect(stub.disconnected).toBe(true);
  }, 8000);

  it(':python 切层无回执:等待超时如实失败,只发过 :python', async () => {
    const stub = makeStub();
    const pending = injectDebugpyListen(
      { host: '127.0.0.1', port: 40000, password: '' },
      5678,
      { createClient: stub.createClient, stepTimeoutMs: 300 }
    );
    stub.emitData('[baseapp@root ~]# ');
    const result = await pending;

    expect(result.status).toBe('failed');
    expect(result.detail).toContain(':python');
    expect(stub.sent).toEqual([':python']);
  }, 8000);

  it('listen 命令无回执:等待回执超时如实失败,只发过 listen 命令', async () => {
    const stub = makeStub();
    const pending = injectDebugpyListen(
      { host: '127.0.0.1', port: 40000, password: '' },
      5679,
      { createClient: stub.createClient, stepTimeoutMs: 300 }
    );
    stub.emitData('>>> ');
    const result = await pending;

    expect(result.status).toBe('failed');
    expect(result.detail).toContain('listen 命令回执提示符超时');
    expect(stub.sent).toEqual(['import debugpy; debugpy.listen(("127.0.0.1", 5679))']);
  }, 8000);
});

describe('injectDebugpyAfterStart 默认探测面', () => {
  const target = (port: number): TelnetTarget => ({
    key: `baseapp:${port}`,
    label: 'baseapp',
    component: 'baseapp',
    host: '127.0.0.1',
    port,
    password: '',
    enableCommands: []
  });

  it('未传 probe:默认走真实 TCP 探测,死端口到点放弃回 failed', async () => {
    configurationOverrides.set('kbengine', { 'debug.autoDebugpy': true });
    const port = await deadPort();
    const logs: Array<{ component: string; level: string; text: string }> = [];
    const reported: Array<{ serverKey: string; outcome: string; detail: string }> = [];

    await injectDebugpyAfterStart(['baseapp'], () => [target(port)], {
      log: (component, level, text) => logs.push({ component, level, text }),
      readyTimeoutMs: 150,
      pollIntervalMs: 40,
      schedule: async () => undefined,
      report: (serverKey, outcome, detail) => reported.push({ serverKey, outcome, detail })
    });

    expect(logs[0].level).toBe('error');
    expect(logs[0].text).toContain('未就绪');
    expect(reported[0]).toMatchObject({ serverKey: 'baseapp', outcome: 'failed' });
  }, 8000);
});

// ---------------------------------------------------------------------------
// processManager:killProcessTree POSIX 回落 + ProcessManager 冒面
// ---------------------------------------------------------------------------

describe('killProcessTree(POSIX 单 pid 回落)', () => {
  it('非组长真实进程:负 pid 组信号 ESRCH,回落单 pid 击杀', async () => {
    const child = spawn('sleep', ['30'], { stdio: 'ignore' });
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
    const pid = child.pid;
    expect(pid).toBeTruthy();
    if (!pid) {
      return;
    }

    await expect(killProcessTree(pid, 'SIGTERM')).resolves.toBe(true);
    await exited;
    // 信号击杀:exitCode 为 null、signalCode 落在 SIGTERM
    expect(child.signalCode ?? child.exitCode).not.toBeNull();
  }, 8000);

  it('已退出的 pid:组信号与单 pid 都杀不到,如实 false', async () => {
    const child = spawn('sleep', ['0.2'], { stdio: 'ignore' });
    const pid = child.pid;
    expect(pid).toBeTruthy();
    if (!pid) {
      return;
    }
    await new Promise<void>(resolve => child.once('exit', () => resolve()));

    await expect(killProcessTree(pid, 'SIGTERM')).resolves.toBe(false);
  }, 8000);
});

// R2-F23(IDE-AUD-050):无效 PID 绝不向内核或 taskkill 发信号——process.kill(-0)
// 会命中调用方自身进程组(误杀宿主组),taskkill /PID 0 同理;pid 缺失(0,来自
// child.pid ?? 0)/负/非整数一律拒绝,spawn 失败/退出并发下不误杀宿主组。
describe('killProcessTree(无效 PID 拒绝, R2-F23)', () => {
  const killSpy = () =>
    vi.spyOn(process, 'kill').mockImplementation(() => true);
  const withSpy = async (pid: number, signal: NodeJS.Signals, verify: (spy: ReturnType<typeof killSpy>) => void) => {
    const spy = killSpy();
    try {
      const result = await killProcessTree(pid, signal);
      expect(result).toBe(false);
      verify(spy);
    } finally {
      spy.mockRestore();
    }
  };

  it('pid 0(POSIX)不向内核发组信号', async () => {
    await withSpy(0, 'SIGTERM', spy => {
      expect(spy).not.toHaveBeenCalled();
    });
  });

  it('负 pid(POSIX)不向内核发信号', async () => {
    await withSpy(-5, 'SIGTERM', spy => {
      expect(spy).not.toHaveBeenCalled();
    });
  });

  it('非整数 pid(POSIX)不向内核发信号', async () => {
    await withSpy(1.5, 'SIGTERM', spy => {
      expect(spy).not.toHaveBeenCalled();
    });
  });

  it('pid 0(Windows)不调用 taskkill', async () => {
    const calls: string[][] = [];
    const result = await killProcessTree(0, 'SIGTERM', undefined, {
      platform: 'win32',
      runTaskkill: args => {
        calls.push(args);
        return { on: () => undefined };
      }
    });
    expect(result).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

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
  connected = true;
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
  send(): boolean {
    return false;
  }
}

describe('ProcessManager 冒面与就绪终局', () => {
  it('list() 如实反映在册进程', () => {
    const manager = new ProcessManager(() => new FakeChild());
    manager.start({ id: 'svc', command: 'server' });

    const listed = manager.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: 'svc', component: 'svc', pid: 123 });
    void manager.dispose();
  });

  it('stop 未知 id 与已 kill 进程:都如实 false', async () => {
    const manager = new ProcessManager(() => new FakeChild());
    await expect(manager.stop('missing')).resolves.toBe(false);
    void manager.dispose();

    const child = new FakeChild();
    const second = new ProcessManager(() => child);
    second.start({ id: 'svc', command: 'server' });
    child.killed = true; // 已请求击杀但 exit 事件未到
    await expect(second.stop('svc')).resolves.toBe(false);
    void second.dispose();
  });

  it('已退出的进程 stop:不等 exit 事件立即返回 true', async () => {
    const child = new FakeChild();
    const manager = new ProcessManager(() => child);
    manager.start({ id: 'svc', command: 'server' });
    child.exitCode = 0;

    await expect(manager.stop('svc', 100)).resolves.toBe(true);
    void manager.dispose();
  });

  it('restart:先停旧进程再起新进程,旧进程真被 kill', async () => {
    const children: FakeChild[] = [];
    const manager = new ProcessManager(() => {
      const child = new FakeChild();
      children.push(child);
      return child;
    });
    manager.start({ id: 'svc', command: 'server' });

    const restarted = await manager.restart({ id: 'svc', command: 'server' }, 100);

    expect(children).toHaveLength(2);
    expect(children[0].killed).toBe(true);
    expect(restarted?.process).toBe(children[1]);
    expect(manager.get('svc')?.process).toBe(children[1]);
    void manager.dispose();
  });

  it('取消柄预置 aborted:首轮轮询即终局 cancelled,probe 不被调用', async () => {
    const child = new FakeChild();
    const states: string[] = [];
    const giveUps: string[] = [];
    let probeCalls = 0;
    const manager = new ProcessManager(() => child);
    manager.onState(event => states.push(event.state));
    manager.start({
      id: 'svc',
      command: 'server',
      readiness: {
        probe: () => {
          probeCalls += 1;
          return true;
        },
        cancelHandle: { aborted: true },
        onGiveUp: reason => giveUps.push(reason)
      }
    });
    await sleep(20);

    expect(probeCalls).toBe(0);
    expect(giveUps).toEqual(['cancelled']);
    expect(states).toEqual(['starting']);
    expect(manager.get('svc')).toBeDefined();
    void manager.dispose();
  });

  it('timeoutMs=0:首轮即终局 timeout,硬定时器迟到只清守不二次报', async () => {
    const child = new FakeChild();
    const states: string[] = [];
    const giveUps: string[] = [];
    let probeCalls = 0;
    const manager = new ProcessManager(() => child);
    manager.onState(event => states.push(event.state));
    manager.start({
      id: 'svc',
      command: 'server',
      readiness: {
        probe: () => {
          probeCalls += 1;
          return true;
        },
        timeoutMs: 0,
        onGiveUp: reason => giveUps.push(reason)
      }
    });
    await sleep(30);

    expect(probeCalls).toBe(0);
    expect(giveUps).toEqual(['timeout']);
    expect(states).toEqual(['starting']);
    void manager.dispose();
  });
});

// ---------------------------------------------------------------------------
// debugpyWaitAtStartup:依赖注入面的格式与错误分支
// ---------------------------------------------------------------------------

describe('debugpyWaitAtStartup 补角', () => {
  const blockLines = [
    WAIT_BOOTSTRAP_BEGIN,
    'try:',
    '    pass',
    'except Exception:',
    '    pass',
    WAIT_BOOTSTRAP_END
  ];

  it('资产根没有 entity_defs:入口脚本如实 null 不猜别的落点', () => {
    const root = makeTempDir('kode-wait-bare-');
    expect(findEngineEntryScript(root)).toBeNull();
  });

  it('块后紧跟非空行:移除只删块本身,后续行零残留', () => {
    const text = `${blockLines.join('\n')}\nimport kbengine\n`;
    const writes: Array<{ file: string; text: string }> = [];
    const result = removeWaitBootstrap('/entry/kbengine.py', {
      readFileText: () => text,
      writeFile: (file, next) => writes.push({ file, text: next })
    });

    expect(result.status).toBe('removed');
    expect(writes[0].text).toBe('import kbengine\n');
  });

  it('单行 docstring:块插在其后,不破坏 __doc__ 与文件头', () => {
    const text = '"""one line doc"""\nimport kbengine\n';
    const writes: Array<{ file: string; text: string }> = [];
    const result = injectWaitBootstrap('/entry/kbengine.py', {
      readFileText: () => text,
      writeFile: (file, next) => writes.push({ file, text: next })
    });

    expect(result.status).toBe('written');
    expect(writes[0].text.startsWith('"""one line doc"""\n')).toBe(true);
    expect(writes[0].text.split('\n')[1]).toBe(WAIT_BOOTSTRAP_BEGIN);
  });

  it('注入写入失败:error 带原因不抛', () => {
    const result = injectWaitBootstrap('/entry/kbengine.py', {
      readFileText: () => 'import kbengine\n',
      writeFile: () => {
        throw new Error('EROFS: read-only filesystem');
      }
    });
    expect(result.status).toBe('error');
    expect(result.message).toContain('写入失败');
    expect(result.message).toContain('EROFS');
  });

  it('移除读失败与写失败:各自如实 error 不抛', () => {
    const unreadable = removeWaitBootstrap('/entry/kbengine.py', {
      readFileText: () => {
        throw new Error('EACCES');
      },
      writeFile: () => undefined
    });
    expect(unreadable.status).toBe('error');
    expect(unreadable.message).toContain('不可读');

    const unwritable = removeWaitBootstrap('/entry/kbengine.py', {
      readFileText: () => `${blockLines.join('\n')}\n`,
      writeFile: () => {
        throw new Error('ENOSPC');
      }
    });
    expect(unwritable.status).toBe('error');
    expect(unwritable.message).toContain('写入失败');
  });
});

// ---------------------------------------------------------------------------
// pythonLanguageServiceStatus.collectPythonServiceFacts:三面事实采集
// ---------------------------------------------------------------------------

describe('collectPythonServiceFacts(注册/配置/磁盘三面)', () => {
  const originalHome = process.env.HOME;
  let home = '';

  beforeEach(() => {
    home = makeTempDir('kode-pylance-');
    process.env.HOME = home;
    fakeExtensionList.splice(0);
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    fakeExtensionList.splice(0);
  });

  it('注册+激活+磁盘目录+extraPaths 已写:四事实如实采集', () => {
    fs.mkdirSync(path.join(home, '.vscode', 'extensions', `${PYLANCE_EXTENSION_ID}-2025.1.2`), {
      recursive: true
    });
    fakeExtensionList.push({ id: PYLANCE_EXTENSION_ID, isActive: true });
    configurationOverrides.set('python.analysis', { extraPaths: ['/tmp/extra'] });

    expect(collectPythonServiceFacts()).toEqual({
      registered: true,
      isActive: true,
      installDirExists: true,
      extraPathsWritten: true
    });
  });

  it('未注册且磁盘无目录:全 false;空 extraPaths 不算已写', () => {
    fakeExtensionList.push({ id: 'other.extension', isActive: true });
    configurationOverrides.set('python.analysis', { extraPaths: [] });

    expect(collectPythonServiceFacts()).toEqual({
      registered: false,
      isActive: false,
      installDirExists: false,
      extraPathsWritten: false
    });
  });
});

// ---------------------------------------------------------------------------
// pythonLanguageUtils:实参切分/成员访问/调用解析的边界
// ---------------------------------------------------------------------------

describe('findPythonReceiverCallArguments(单行实参切分边界)', () => {
  it('方法名与括号之间夹其他 token:不认,不出实参表', () => {
    const calls = findPythonReceiverCallArguments('y = self.cell.foo + (1, 2)\n');
    expect(calls).toHaveLength(1);
    expect(calls[0].arguments).toEqual([]);
  });

  it('没有括号:不认,不出实参表', () => {
    const calls = findPythonReceiverCallArguments('handler = self.cell.onMessage\n');
    expect(calls[0].arguments).toEqual([]);
  });

  it('字符串内的逗号与转义不切分:实参按顶层逗号如实切', () => {
    const line = 'self.cell.foo("a\\,b", 2)\n';
    const calls = findPythonReceiverCallArguments(line);
    expect(calls[0].arguments).toHaveLength(2);
    expect(calls[0].arguments[0].text).toBe('"a\\,b"');
    expect(calls[0].arguments[1].text).toBe('2');
  });

  it('括号/花括号嵌套按深度计数:整体作一个实参', () => {
    const line = 'self.base.foo([1, 2], {"k": 3})\n';
    const calls = findPythonReceiverCallArguments(line);
    expect(calls[0].arguments).toHaveLength(2);
    expect(calls[0].arguments[0].text).toBe('[1, 2]');
    expect(calls[0].arguments[1].text).toBe('{"k": 3}');
  });

  it('实参尾随空白剔除:span 落在紧凑文本上', () => {
    const line = 'self.client.foo(a , 2)\n';
    const calls = findPythonReceiverCallArguments(line);
    expect(calls[0].arguments[0].text).toBe('a');
    expect(line.slice(calls[0].arguments[0].start, calls[0].arguments[0].end)).toBe('a');
    expect(calls[0].arguments[1].text).toBe('2');
  });
});

describe('getPythonMemberAccessAtPosition(非 self 调用形)', () => {
  it('光标越过成员名段:不认(其余匹配也轮空)', () => {
    expect(getPythonMemberAccessAtPosition('avatar.foo(1)', 11)).toBeNull();
  });

  it('成员名与括号间允许空白:仍认调用形', () => {
    const access = getPythonMemberAccessAtPosition('avatar.foo  (1)', 8);
    expect(access).toEqual({
      receiverName: 'avatar',
      memberName: 'foo',
      fullPath: 'avatar.foo'
    });
  });
});

describe('getPythonCallAtPosition(签名帮助的实参归属)', () => {
  const line = 'self.client.poke("a,b)", 2)';

  it('字符串里的逗号与闭括号:不切实参不闭调用,光标在第二参归 1', () => {
    const call = getPythonCallAtPosition(line, line.length - 2);
    expect(call).toMatchObject({
      receiverName: 'self',
      methodName: 'poke',
      section: 'ClientMethods',
      activeArgument: 1
    });
  });

  it('光标落在字符串内:其后的顶层逗号不计入,归 0', () => {
    const insideString = line.indexOf('"') + 1;
    expect(getPythonCallAtPosition(line, insideString)?.activeArgument).toBe(0);
  });

  it('转义引号不闭合字符串:后续逗号不再切分,实参停在 0', () => {
    const escaped = 'self.client.poke("a\\", 2)';
    const call = getPythonCallAtPosition(escaped, escaped.length);
    expect(call).toMatchObject({ methodName: 'poke', activeArgument: 0 });
  });
});

// ---------------------------------------------------------------------------
// kbengineProtocol:parseProfileFrame 三种结果帧 + queryConsoleFrames 边路
// ---------------------------------------------------------------------------

describe('parseProfileFrame(event/network/cprofile 结果帧)', () => {
  const component = makeSimComponentInfo({ componentType: 6, componentID: 900n });

  it('eventprofile:分组与事件逐字段解析', () => {
    const body = Buffer.concat([
      Buffer.from([2]),
      u32(12),
      u32(2),
      buildCString('network'),
      u32(2),
      buildCString('onRecv'),
      u32(7),
      u32(128),
      buildCString('onSend'),
      u32(3),
      u32(64),
      buildCString('db'),
      u32(1),
      buildCString('query'),
      u32(9),
      u32(256)
    ]);

    const result = parseProfileFrame(body, component);
    expect(result.kind).toBe('eventprofile');
    expect(result.timingLength).toBe(12);
    expect(result.events).toEqual([
      {
        typeName: 'network',
        events: [
          { name: 'onRecv', count: 7, size: 128 },
          { name: 'onSend', count: 3, size: 64 }
        ]
      },
      { typeName: 'db', events: [{ name: 'query', count: 9, size: 256 }] }
    ]);
  });

  it('networkprofile:行内计数器逐字段解析', () => {
    const body = Buffer.concat([
      Buffer.from([3]),
      u32(30),
      u32(1),
      buildCString('avatar'),
      u32(1),
      u32(100),
      u32(100),
      u32(10),
      u32(1000),
      u32(2),
      u32(50),
      u32(25),
      u32(20),
      u32(500)
    ]);

    const result = parseProfileFrame(body, component);
    expect(result.kind).toBe('networkprofile');
    expect(result.timingLength).toBe(30);
    expect(result.rows).toEqual([
      {
        name: 'avatar',
        sendCount: 1,
        sendSize: 100,
        sendAverageSize: 100,
        totalSendCount: 10,
        totalSendSize: 1000,
        recvCount: 2,
        recvSize: 50,
        recvAverageSize: 25,
        totalRecvCount: 20,
        totalRecvSize: 500
      }
    ]);
  });

  it('cprofile 默认支:行带四个 float 时间,计时长度如实 0', () => {
    const body = Buffer.concat([
      Buffer.from([1]),
      u32(1),
      buildCString('KBEngine::onProcess'),
      u32(42),
      f32(0.5),
      f32(1.25),
      f32(0.75),
      f32(2.5)
    ]);

    const result = parseProfileFrame(body, component);
    expect(result.kind).toBe('cprofile');
    expect(result.timingLength).toBe(0);
    expect(result.rows).toEqual([
      {
        name: 'KBEngine::onProcess',
        count: 42,
        lastTime: 0.5,
        totalTime: 1.25,
        lastInclusiveTime: 0.75,
        totalInclusiveTime: 2.5
      }
    ]);
  });

  it('截断帧:eof 守卫止读不抛,分组/行按已有内容解析', () => {
    const truncatedEvent = Buffer.concat([
      Buffer.from([2]),
      u32(5),
      u32(2), // 声明 2 组,只给 1 组字节
      buildCString('network'),
      u32(1),
      buildCString('onRecv'),
      u32(7),
      u32(128)
    ]);
    const eventResult = parseProfileFrame(truncatedEvent, component);
    expect(eventResult.kind).toBe('eventprofile');
    expect(eventResult.events).toHaveLength(1);

    const truncatedC = Buffer.concat([
      Buffer.from([1]),
      u32(2), // 声明 2 行,只给 1 行字节
      buildCString('only'),
      u32(1),
      f32(0.5),
      f32(0.5),
      f32(0.5),
      f32(0.5)
    ]);
    const cResult = parseProfileFrame(truncatedC, component);
    expect(cResult.rows).toHaveLength(1);
    expect(cResult.rows?.[0]).toMatchObject({ name: 'only', count: 1 });
  });
});

describe('startProfileQuery(真实 TCP 客户端边路)', () => {
  const options = { profileName: 'tick', kind: 'pyprofile' as const, timingLengthSeconds: 9 };

  it('先到无关回调帧再迟到正确帧:超时重挂后仍完成重组解析', async () => {
    const pyBody = Buffer.concat([Buffer.from([0]), u32(9), buildCString('profile text')]);
    const server = net.createServer(socket => {
      socket.on('error', () => undefined);
      // 消费客户端请求帧:不读的套接字不会吞下对端 FIN,server.close 会滞留
      socket.on('data', () => undefined);
      // 无关消息帧:不产结果 → 客户端只能重挂超时等待
      socket.write(buildFrame(1, Buffer.alloc(0)));
      setTimeout(() => {
        socket.write(buildFrame(CONSOLE_PROFILE_CB_MSG_ID, pyBody));
      }, 40);
    });
    const port = await new Promise<number>(resolve => {
      server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port));
    });

    try {
      const results = await startProfileQuery(
        makeSimComponentInfo({ componentType: 6, intport: port }),
        options,
        1500
      );

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        kind: 'pyprofile',
        timingLength: 9,
        text: 'profile text'
      });
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }, 8000);

  it('连接被拒:reject 如实上抛,不静默成空结果', async () => {
    const port = await deadPort();
    await expect(
      startProfileQuery(makeSimComponentInfo({ componentType: 6, intport: port }), options, 800)
    ).rejects.toThrow();
  }, 8000);
});

// 不可达分支定性(未强行覆盖,据实登记):
// - debugpyPortProbe defaultTcpConnect 的 settled 双收尾守卫(~40)与 120s
//   pip 安装超时(~168):前者只在「超时后又有 error」的内核竞态出现,后者
//   常量 120s 不宜进单测。
// - debugpyPreflight runInterpreterCodeDefault 的 10s 探测超时(~111):同上,
//   常量超时不宜进单测。
// - processManager 就绪轮询 probe 回包后的二次超时复核(~294-307):硬定时器
//   与 cancel 盯守在 timeoutMs 到点必先置 gaveUp,回包后 285 行早退——两条
//   复核语句只在「毫秒级时钟恰跨过截止」的竞态里可达,属防御性写法。
// - processManager emitState 的 states.delete(~389):states 是只写不读的记账
//   面,且所有内部 emitState 调用点均保证 id 在册,else 臂无真实触发路径。
// - pythonLanguageServiceStatus collectPythonServiceFacts 的 catch(~105):
//   替身 getConfiguration 永不抛;真实 API 抛异常属防御面。
// - pythonLanguageUtils finishArgumentSpan 的前导空白剔除(~255):实参起点只
//   可能落在引号/括号/非空白字符上,lo 前不可能有空白。
