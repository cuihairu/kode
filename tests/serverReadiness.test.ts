import * as fs from 'fs';
import * as path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  KBEngineServerManager,
  SERVER_COMPONENTS,
  ServerStatus,
  createComponentReadinessProbe,
  type ServerComponent
} from '../src/serverManager';
import type * as vscode from 'vscode';
import { window as stubWindow, workspace as stubWorkspace } from './helpers/vscodeStub';
import { FakeComponentBin } from './sim/fakeComponentBin';

// IDE-RUN-003 真实就绪探针:固定 1 秒宽限期不再单方面把组件标成 Running,
// 探针(组件 telnet 端口 TCP 连通)通过才 ready。服务不可用 → 一直
// Starting(RUN-004 再补超时/取消)。未开 telnet 的组件无探针可依,如实
// 回落宽限期。进程为真实子进程 + 真实 TCP 监听(fakeComponentBin listen
// 行为),探针走 makeProbeOne 真套接字,零 mock。

interface ConfigTable {
  [key: string]: unknown;
}

const configTable: ConfigTable = {};
const channels: Array<{ name: string; lines: string[]; disposed: boolean }> = [];
const messages = { info: [] as string[], warning: [] as string[], error: [] as string[] };

const windowish = stubWindow as unknown as Record<string, unknown>;
const patchedKeys = [
  'createOutputChannel',
  'showInformationMessage',
  'showWarningMessage',
  'showErrorMessage'
];

let root = '';
let currentManager: KBEngineServerManager | undefined;

const until = async (predicate: () => boolean, timeoutMs = 5000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('condition not met before deadline');
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
};

const cellapp = SERVER_COMPONENTS.find(component => component.name === 'cellapp') as ServerComponent;
expect(cellapp, 'SERVER_COMPONENTS 里应有 cellapp').toBeTruthy();

const pidAlive = (pid: number | undefined): boolean => {
  if (!pid || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const makeManager = (): KBEngineServerManager => {
  const manager = new KBEngineServerManager({} as unknown as vscode.ExtensionContext);
  currentManager = manager;
  return manager;
};

let bin: FakeComponentBin;
let probePort = 0;

/** 选一个本机空闲端口:先占住再释放,拿内核分配值 */
const reserveFreePort = async (): Promise<number> => {
  const net = await import('net');
  return new Promise(resolve => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address() as net.AddressInfo;
      const { port } = address;
      probe.close(() => resolve(port));
    });
  });
};

beforeAll(() => {
  windowish.createOutputChannel = (name: string) => {
    const channel = { name, lines: [] as string[], disposed: false };
    channels.push(channel);
    return {
      append: (value: string) => {
        channel.lines.push(value);
      },
      appendLine: (value: string) => {
        channel.lines.push(`${value}\n`);
      },
      show: () => undefined,
      dispose: () => {
        channel.disposed = true;
      }
    };
  };
  const record = (bucket: string[]) => async (message: string) => {
    bucket.push(message);
    return undefined;
  };
  windowish.showInformationMessage = record(messages.info);
  windowish.showWarningMessage = record(messages.warning);
  windowish.showErrorMessage = record(messages.error);

  (stubWorkspace as unknown as Record<string, unknown>).getConfiguration = () => ({
    get: (key: string, defaultValue: unknown) =>
      key in configTable ? configTable[key] : defaultValue
  });
});

afterAll(() => {
  for (const key of patchedKeys) {
    delete windowish[key];
  }
  delete (stubWorkspace as unknown as Record<string, unknown>).getConfiguration;
});

beforeEach(async () => {
  bin = await FakeComponentBin.create();
  root = bin.root;
  fs.mkdirSync(path.join(root, 'ws', 'cfg'), { recursive: true });
  probePort = await reserveFreePort();

  configTable.binPath = bin.binPath;
  configTable.assetsRoot = path.join(root, 'ws', 'cfg');

  channels.length = 0;
  messages.info.length = 0;
  messages.warning.length = 0;
  messages.error.length = 0;

  stubWorkspace.workspaceFolders = [
    { uri: { fsPath: path.join(root, 'ws') } as vscode.Uri, name: 'ws', index: 0 }
  ];
});

afterEach(async () => {
  const running = currentManager?.getRunningServers();
  if (running) {
    for (const server of running.values()) {
      try {
        server.process.kill('SIGKILL');
      } catch {
        // 进程已退出
      }
    }
    await until(
      () => (currentManager as KBEngineServerManager).getRunningServers().size === 0,
      2000
    ).catch(() => undefined);
  }
  currentManager = undefined;
  stubWorkspace.workspaceFolders = [];
  fs.rmSync(root, { recursive: true, force: true });
});

describe('createComponentReadinessProbe', () => {
  it('builds a probe from the matching telnet target', async () => {
    const probe = createComponentReadinessProbe('cellapp', {
      getTargets: () => [{
        key: '127.0.0.1:40000', label: 'cellapp', component: 'cellapp',
        host: '127.0.0.1', port: probePort, password: '', enableCommands: []
      }]
    });
    expect(probe).toBeTypeOf('function');

    // 端口没人听 → false;起一个真监听 → true
    expect(await probe?.()).toBe(false);
    const net = await import('net');
    const server = net.createServer();
    await new Promise<void>(resolve => server.listen(probePort, '127.0.0.1', resolve));
    try {
      expect(await probe?.()).toBe(true);
    } finally {
      server.close();
    }
  });

  it('returns undefined without a matching target or with a zero port', () => {
    expect(createComponentReadinessProbe('cellapp', { getTargets: () => [] })).toBeUndefined();
    expect(createComponentReadinessProbe('cellapp', {
      getTargets: () => [{
        key: '127.0.0.1:0', label: 'cellapp', component: 'cellapp',
        host: '127.0.0.1', port: 0, password: '', enableCommands: []
      }]
    })).toBeUndefined();
  });
});

describe('KBEngineServerManager readiness probes', () => {
  it('stays starting past the fixed grace period while the service is down, then runs when the probe passes', async () => {
    // 延迟 2500ms 才开监听:旧 1 秒宽限期在 1000ms 就会误标 Running
    bin.write('cellapp', { kind: 'listen', port: probePort, delayMs: 2500 });
    const manager = makeManager();
    const probe = createComponentReadinessProbe('cellapp', {
      getTargets: () => [{
        key: `127.0.0.1:${probePort}`, label: 'cellapp', component: 'cellapp',
        host: '127.0.0.1', port: probePort, password: '', enableCommands: []
      }]
    });

    expect(await manager.startComponent(cellapp, { readinessProbe: probe })).toBe(true);
    expect(manager.getServerStatus('cellapp')).toBe(ServerStatus.Starting);

    // 越过固定宽限期(1000ms)+探测间隔,服务仍未开 → 仍为 Starting
    await new Promise(resolve => setTimeout(resolve, 1600));
    expect(manager.getServerStatus('cellapp')).toBe(ServerStatus.Starting);

    // 监听开(2500ms)后探针通过 → Running
    await until(() => manager.getServerStatus('cellapp') === ServerStatus.Running, 6000);
    await manager.stopComponent('cellapp');
  }, 12000);

  it('never promotes to running while the probe keeps failing', async () => {
    // 进程常驻但从不监听:服务不可用,探针一直失败
    bin.write('cellapp', { kind: 'run' });
    const manager = makeManager();
    const probe = createComponentReadinessProbe('cellapp', {
      getTargets: () => [{
        key: `127.0.0.1:${probePort}`, label: 'cellapp', component: 'cellapp',
        host: '127.0.0.1', port: probePort, password: '', enableCommands: []
      }]
    });

    expect(await manager.startComponent(cellapp, { readinessProbe: probe })).toBe(true);

    // 远超旧宽限期,状态仍是 Starting(不误标 Running)
    await new Promise(resolve => setTimeout(resolve, 1800));
    expect(manager.getServerStatus('cellapp')).toBe(ServerStatus.Starting);
    expect(manager.getRunningServers().get('cellapp')?.status).toBe(ServerStatus.Starting);

    await manager.stopComponent('cellapp');
  }, 10000);

  it('treats a throwing probe as not ready and recovers when it passes', async () => {
    bin.write('cellapp', { kind: 'listen', port: probePort, delayMs: 0 });
    const manager = makeManager();
    let calls = 0;
    const probe = async (): Promise<boolean> => {
      calls += 1;
      if (calls <= 2) {
        throw new Error('probe backend down');
      }
      const net = await import('net');
      return new Promise(resolve => {
        const socket = net.connect({ host: '127.0.0.1', port: probePort });
        socket.setTimeout(800, () => {
          socket.destroy();
          resolve(false);
        });
        socket.once('connect', () => {
          socket.destroy();
          resolve(true);
        });
        socket.once('error', () => {
          socket.destroy();
          resolve(false);
        });
      });
    };

    expect(await manager.startComponent(cellapp, { readinessProbe: probe })).toBe(true);
    await until(() => manager.getServerStatus('cellapp') === ServerStatus.Running, 6000);
    expect(calls).toBeGreaterThanOrEqual(3);

    await manager.stopComponent('cellapp');
  }, 10000);

  it('falls back to the fixed grace period when no probe applies', async () => {
    // 配置未开 telnet(测试环境无 kbengine.xml/显式端口)→ 无探针 → 旧宽限期行为
    bin.write('cellapp', { kind: 'run' });
    const manager = makeManager();

    expect(await manager.startComponent(cellapp)).toBe(true);
    await until(() => manager.getServerStatus('cellapp') === ServerStatus.Running, 4000);
    expect(messages.info.some(text => text.startsWith('CellApp 启动成功'))).toBe(true);

    await manager.stopComponent('cellapp');
  }, 8000);
});

describe('KBEngineServerManager readiness wait timeout and cancel', () => {
  const closedPortProbe = () => createComponentReadinessProbe('cellapp', {
    getTargets: () => [{
      key: `127.0.0.1:${probePort}`, label: 'cellapp', component: 'cellapp',
      host: '127.0.0.1', port: probePort, password: '', enableCommands: []
    }]
  }) as () => Promise<boolean>;

  it('gives up the wait on timeout, reports the target, and never marks running', async () => {
    // 进程常驻但从不监听:探针一直失败
    bin.write('cellapp', { kind: 'run' });
    const manager = makeManager();

    expect(await manager.startComponent(cellapp, {
      targetId: 'a',
      readinessProbe: closedPortProbe(),
      readinessTimeoutMs: 1500
    })).toBe(true);

    await until(() => manager.getRunningServers().get('cellapp#a')?.readinessGivenUp === 'timeout', 4000);

    // 停止等待 ≠ 进程死了:仍在册、仍 Starting、绝不误标 Running
    const server = manager.getRunningServers().get('cellapp#a');
    expect(server?.status).toBe(ServerStatus.Starting);
    expect(manager.getServerStatus('cellapp', 'a')).toBe(ServerStatus.Starting);
    // 报告对应 target:实例 a 点名
    expect(messages.warning.some(text => text.includes('CellApp') && text.includes('a'))).toBe(true);
    const channelText = channels.map(channel => channel.lines.join('')).join('');
    expect(channelText).toContain('就绪等待超时');

    // 等待已放弃是终态:此后服务真的开起来也不再推进 Running
    const net = await import('net');
    const server2 = net.createServer();
    await new Promise<void>(resolve => server2.listen(probePort, '127.0.0.1', resolve));
    try {
      await new Promise(resolve => setTimeout(resolve, 900));
      expect(manager.getServerStatus('cellapp', 'a')).toBe(ServerStatus.Starting);
    } finally {
      server2.close();
    }

    await manager.stopComponent('cellapp', 'a');
  }, 12000);

  it('cancels the wait through the cancel handle and keeps the process untouched', async () => {
    bin.write('cellapp', { kind: 'run' });
    const manager = makeManager();
    const cancel = { aborted: false };

    expect(await manager.startComponent(cellapp, {
      targetId: 'a',
      readinessProbe: closedPortProbe(),
      readinessTimeoutMs: 60_000,
      cancel
    })).toBe(true);

    // 取消前一直在等
    await new Promise(resolve => setTimeout(resolve, 600));
    expect(manager.getRunningServers().get('cellapp#a')?.readinessGivenUp).toBeUndefined();

    cancel.aborted = true;
    await until(() => manager.getRunningServers().get('cellapp#a')?.readinessGivenUp === 'cancelled', 3000);

    // 取消只停等待:进程本体还活着,状态保持 Starting
    const pid = manager.getRunningServers().get('cellapp#a')?.pid;
    expect(manager.getServerStatus('cellapp', 'a')).toBe(ServerStatus.Starting);
    expect(pidAlive(pid)).toBe(true);

    await manager.stopComponent('cellapp', 'a');
  }, 12000);

  it('cancels the readiness wait when the component is stopped', async () => {
    // ignore-sigterm:SIGTERM 杀不死,取消与进程死亡解耦,可观察到取消先行
    bin.write('cellapp', { kind: 'ignore-sigterm', marker: 'trapped' });
    const manager = makeManager();

    expect(await manager.startComponent(cellapp, {
      readinessProbe: closedPortProbe(),
      readinessTimeoutMs: 60_000
    })).toBe(true);
    const server = manager.getRunningServers().get('cellapp');
    await until(() => (server?.logs ?? []).join('').includes('trapped'));

    // 停组件即取消就绪等待:进程还活着(SIGTERM 被忽略),等待已放弃
    void manager.stopComponent('cellapp');
    await until(() => manager.getRunningServers().get('cellapp')?.readinessGivenUp === 'cancelled', 3000);
    expect(manager.getRunningServers().has('cellapp')).toBe(true);

    // 清理:绕过优雅停止直接击杀
    manager.getRunningServers().get('cellapp')?.process.kill('SIGKILL');
    await until(() => manager.getRunningServers().size === 0);
  }, 12000);

  it('keeps polling without a timeout when readinessTimeoutMs is null', async () => {
    bin.write('cellapp', { kind: 'run' });
    const manager = makeManager();
    let calls = 0;
    const probe = async (): Promise<boolean> => {
      calls += 1;
      return false;
    };

    expect(await manager.startComponent(cellapp, {
      readinessProbe: probe,
      readinessTimeoutMs: null
    })).toBe(true);

    // 1.5s(≈6 个轮询周期)后仍在轮询、未放弃
    await new Promise(resolve => setTimeout(resolve, 1500));
    expect(calls).toBeGreaterThanOrEqual(4);
    expect(manager.getRunningServers().get('cellapp')?.readinessGivenUp).toBeUndefined();

    await manager.stopComponent('cellapp');
  }, 10000);
});
