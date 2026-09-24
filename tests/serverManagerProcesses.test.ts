import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  KBEngineServerManager,
  ServerStatus,
  type ServerComponent
} from '../src/serverManager';
import type * as vscode from 'vscode';
import { window as stubWindow, workspace as stubWorkspace } from './helpers/vscodeStub';

// KBEngineServerManager 的进程编排层:startComponent 检查链(已运行/可执行
// 文件缺失/配置目录三态)、真实 spawn 的 stdout/stderr/error/exit 事件流、
// stopComponent 的 SIGTERM→SIGKILL 阶梯、startAutoComponents/stopAll/
// restartComponent/dispose。进程全部为真实回环子进程(bin 目录下 chmod 的
// shell 脚本),零 mock;vscodeStub 仅兜住配置读取与输出通道,由本文件
// monkey-patch 成可记录的脚本化版本。

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

const makeComponent = (executable: string, name = executable): ServerComponent => ({
  name,
  displayName: name.charAt(0).toUpperCase() + name.slice(1),
  executable,
  defaultArgs: ['--flag'],
  order: 1,
  required: false,
  description: '测试用组件'
});

const makeManager = (): KBEngineServerManager => {
  const manager = new KBEngineServerManager({} as unknown as vscode.ExtensionContext);
  currentManager = manager;
  return manager;
};

const channelText = (fragment: string): string => {
  const channel = channels.find(item => item.name.includes(fragment));
  expect(channel, `channel ${fragment} exists`).toBeTruthy();
  return (channel as { lines: string[] }).lines.join('');
};

const writeScript = (name: string, body: string, mode = 0o755): string => {
  const scriptPath = path.join(root, 'bin', name);
  fs.writeFileSync(scriptPath, `#!/bin/sh\n${body}`, 'utf8');
  fs.chmodSync(scriptPath, mode);
  return scriptPath;
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

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-srvproc-'));
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(root, 'ws', 'cfg'), { recursive: true });

  configTable.binPath = path.join(root, 'bin');
  configTable.configPath = path.join(root, 'ws', 'cfg');
  configTable.autoStart = ['logger'];

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

describe('KBEngineServerManager startComponent preflight', () => {
  it('warns and refuses when the component is already running', async () => {
    writeScript('dup', 'exec sleep 30');
    const manager = makeManager();
    const component = makeComponent('dup');

    expect(await manager.startComponent(component)).toBe(true);
    expect(await manager.startComponent(component)).toBe(false);

    expect(messages.warning).toEqual(['Dup 已在运行中']);
    expect(manager.getRunningServers().size).toBe(1);
  });

  it('reports a missing executable through the error channel', async () => {
    const manager = makeManager();

    expect(await manager.startComponent(makeComponent('ghost'))).toBe(false);

    expect(messages.error).toHaveLength(1);
    expect(messages.error[0]).toBe(`找不到 ghost 可执行文件：${path.join(root, 'bin', 'ghost')}`);
  });

  it('rejects an empty configured config path', async () => {
    writeScript('svc', 'exec sleep 30');
    configTable.configPath = '';
    const manager = makeManager();

    expect(await manager.startComponent(makeComponent('svc'))).toBe(false);

    expect(messages.error).toEqual(['KBEngine 配置目录为空，请检查 kbengine.configPath']);
  });

  it('rejects a config path that does not exist', async () => {
    writeScript('svc', 'exec sleep 30');
    configTable.configPath = path.join(root, 'ws', 'missing');
    const manager = makeManager();

    expect(await manager.startComponent(makeComponent('svc'))).toBe(false);

    expect(messages.error).toEqual([
      `找不到 KBEngine 配置目录：${path.join(root, 'ws', 'missing')}`
    ]);
  });

  it('rejects a config path that is a plain file', async () => {
    writeScript('svc', 'exec sleep 30');
    const filePath = path.join(root, 'ws', 'cfg-file');
    fs.writeFileSync(filePath, 'x', 'utf8');
    configTable.configPath = filePath;
    const manager = makeManager();

    expect(await manager.startComponent(makeComponent('svc'))).toBe(false);

    expect(messages.error).toEqual([`KBEngine 配置路径不是目录：${filePath}`]);
  });
});

describe('KBEngineServerManager real process lifecycle', () => {
  it('starts a real process and promotes it to running after the grace period', async () => {
    writeScript('long', 'echo ready\npwd\necho "KBE_BIN_PATH=$KBE_BIN_PATH"\nexec sleep 30');
    const manager = makeManager();
    let statusFires = 0;
    manager.onDidChangeStatus(() => {
      statusFires += 1;
    });

    expect(await manager.startComponent(makeComponent('long'))).toBe(true);

    const running = manager.getRunningServers();
    expect(running.get('long')?.status).toBe(ServerStatus.Starting);
    expect(manager.getServerStatus('long')).toBe(ServerStatus.Starting);
    expect(statusFires).toBeGreaterThan(0);

    await until(() => manager.getServerStatus('long') === ServerStatus.Running);

    const server = running.get('long');
    expect(server?.pid).toBeGreaterThan(0);
    // stdout 日志、cwd 与注入的环境变量全部来自真实子进程
    const logs = (server?.logs ?? []).join('');
    expect(logs).toContain('ready');
    expect(logs).toContain(path.join(root, 'ws', 'cfg'));
    expect(logs).toContain(`KBE_BIN_PATH=${path.join(root, 'bin')}${path.sep}`);

    expect(messages.info).toHaveLength(1);
    expect(messages.info[0]).toBe(`Long 启动成功 (PID: ${server?.pid})`);
    expect(channelText('Long')).toContain('[INFO] 正在启动 Long...');
    expect(channelText('Long')).toContain('[INFO] 可执行文件:');
    expect(channelText('Long')).toContain(`[INFO] 启动参数: --flag`);
    await manager.stopComponent('long');
  });

  it('routes child stderr into the [ERROR] output channel', async () => {
    writeScript('noisy', 'echo boom >&2\nexec sleep 30');
    const manager = makeManager();

    expect(await manager.startComponent(makeComponent('noisy'))).toBe(true);
    await until(() => (manager.getRunningServers().get('noisy')?.logs ?? []).join('').includes('boom'));

    expect(channelText('Noisy')).toContain('[ERROR] boom');
    await manager.stopComponent('noisy');
  });

  it('removes an exiting child and logs its exit code', async () => {
    writeScript('flash', 'exit 3');
    const manager = makeManager();

    expect(await manager.startComponent(makeComponent('flash'))).toBe(true);
    await until(() => manager.getRunningServers().size === 0);

    expect(manager.getServerStatus('flash')).toBe(ServerStatus.Stopped);
    expect(channelText('Flash')).toContain('[INFO] 进程退出: code=3, signal=null');
    // 提前退出的进程不会等到 1 秒宽限期的“启动成功”提示
    expect(messages.info).toEqual([]);
  });

  it('surfaces spawn errors for an unexecutable binary and drops the entry', async () => {
    writeScript('locked', 'exec sleep 30', 0o000);
    const manager = makeManager();

    // existsSync 通过但 exec 权限被剥,spawn 发出 EACCES error 事件
    expect(await manager.startComponent(makeComponent('locked'))).toBe(true);
    await until(() => manager.getRunningServers().size === 0);

    expect(channelText('Locked')).toContain('[ERROR] 进程错误:');
    expect(manager.getServerStatus('locked')).toBe(ServerStatus.Stopped);
  });

  it('stops a live process via SIGTERM and resolves true', async () => {
    writeScript('term', 'exec sleep 30');
    const manager = makeManager();
    const component = makeComponent('term');

    await manager.startComponent(component);
    const pid = manager.getRunningServers().get('term')?.pid;
    expect(pid).toBeGreaterThan(0);

    expect(await manager.stopComponent('term')).toBe(true);
    expect(manager.getRunningServers().has('term')).toBe(false);
    expect(channelText('Term')).toContain('[INFO] 正在停止 Term...');
    expect(channelText('Term')).toContain('[INFO] Term 已停止');
    // 进程真的死了:向已退出 pid 发信号应抛错
    await until(() => {
      try {
        process.kill(pid as number, 0);
        return false;
      } catch {
        return true;
      }
    });
  }, 8000);

  it('escalates to SIGKILL when the child ignores SIGTERM', async () => {
    writeScript('stubborn', "trap '' TERM\necho trapped\nexec sleep 30");
    const manager = makeManager();

    await manager.startComponent(makeComponent('stubborn'));
    const server = manager.getRunningServers().get('stubborn');
    expect(server?.pid).toBeGreaterThan(0);
    // 高负载下 SIGTERM 可能抢在 bash 执行 trap 行之前送达并被默认动作
    // 杀死;等到脚本输出 trap 之后的标记,确认忽略已生效再停止
    await until(() => (server?.logs ?? []).join('').includes('trapped'));

    expect(await manager.stopComponent('stubborn')).toBe(true);
    expect(channelText('Stubborn')).toContain('[INFO] Stubborn 已强制停止');
    await until(() => {
      try {
        process.kill(pid as number, 0);
        return false;
      } catch {
        return true;
      }
    });
  }, 10000);

  it('returns false when stopping a component that never ran', async () => {
    expect(await makeManager().stopComponent('absent')).toBe(false);
  });
});

describe('KBEngineServerManager batch orchestration', () => {
  it('starts the configured auto-start components in launch order', async () => {
    writeScript('logger', 'exec sleep 30');
    const manager = makeManager();

    await manager.startAutoComponents();

    expect(Array.from(manager.getRunningServers().keys())).toEqual(['logger']);
    expect(manager.getServerStatus('logger')).toBe(ServerStatus.Running);
  }, 8000);

  it('stops every running component in reverse launch order', async () => {
    writeScript('alpha', 'exec sleep 30');
    writeScript('beta', 'exec sleep 30');
    const manager = makeManager();

    await manager.startComponent(makeComponent('alpha'));
    await manager.startComponent(makeComponent('beta'));
    expect(manager.getRunningServers().size).toBe(2);

    await manager.stopAll();

    expect(manager.getRunningServers().size).toBe(0);
    expect(manager.getServerStatus('alpha')).toBe(ServerStatus.Stopped);
    expect(manager.getServerStatus('beta')).toBe(ServerStatus.Stopped);
  }, 8000);

  it('restarts an unknown component as a plain failure', async () => {
    expect(await makeManager().restartComponent('nope')).toBe(false);
    expect(messages.error).toEqual([]);
  }, 8000);

  // restartComponent 只认 SERVER_COMPONENTS 里的真名,这里用 logger
  it('restarts an idle component by starting it fresh', async () => {
    writeScript('logger', 'exec sleep 30');
    const manager = makeManager();

    expect(await manager.restartComponent('logger')).toBe(true);
    expect(manager.getRunningServers().has('logger')).toBe(true);
  }, 8000);

  it('replaces a live process with a fresh one on restart', async () => {
    writeScript('logger', 'exec sleep 30');
    const manager = makeManager();

    await manager.startComponent(makeComponent('logger'));
    const firstPid = manager.getRunningServers().get('logger')?.pid;
    expect(firstPid).toBeGreaterThan(0);

    expect(await manager.restartComponent('logger')).toBe(true);

    const restarted = manager.getRunningServers().get('logger');
    expect(restarted?.pid).toBeGreaterThan(0);
    expect(restarted?.pid).not.toBe(firstPid);
    expect(channelText('Logger')).toContain('[INFO] Logger 已停止');
  }, 10000);

  it('disposes channels and kills leftover processes', async () => {
    writeScript('doomed', 'exec sleep 30');
    const manager = makeManager();

    await manager.startComponent(makeComponent('doomed'));
    const pid = manager.getRunningServers().get('doomed')?.pid;
    expect(pid).toBeGreaterThan(0);

    expect(() => manager.dispose()).not.toThrow();
    expect(manager.getRunningServers().size).toBe(0);
    expect(channels.every(channel => channel.disposed)).toBe(true);
    await until(() => {
      try {
        process.kill(pid as number, 0);
        return false;
      } catch {
        return true;
      }
    });
  }, 8000);
});
