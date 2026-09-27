import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { KBEngineServerManager, type ProcessRunner, type ServerComponent } from '../src/serverManager';
import type * as vscode from 'vscode';
import { window as stubWindow, workspace as stubWorkspace } from './helpers/vscodeStub';
import { FakeComponentBin } from './sim/fakeComponentBin';

// ProcessRunner 注入点(重设计阶段 2):记录型 runner 验证 spawn 参数透传
// (命令/参数/cwd/KBE_* 环境装配),抛错型 runner 验证同步异常走 catch 报
// "启动失败";构造器缺省注入仍走真实 child_process.spawn(由
// serverManagerProcesses.test.ts 的真实进程用例覆盖)。

interface ConfigTable {
  [key: string]: unknown;
}

const configTable: ConfigTable = {};
const channels: Array<{ name: string; lines: string[] }> = [];
const messages = { info: [] as string[], warning: [] as string[], error: [] as string[] };

const windowish = stubWindow as unknown as Record<string, unknown>;
const patchedKeys = [
  'createOutputChannel',
  'showInformationMessage',
  'showWarningMessage',
  'showErrorMessage'
];

let bin: FakeComponentBin;
let configRoot = '';
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

const channelText = (fragment: string): string => {
  const channel = channels.find(item => item.name.includes(fragment));
  expect(channel, `channel ${fragment} exists`).toBeTruthy();
  return (channel as { lines: string[] }).lines.join('');
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
  configRoot = path.join(bin.root, 'cfg');
  fs.mkdirSync(configRoot, { recursive: true });

  configTable.binPath = bin.binPath;
  configTable.configPath = configRoot;

  channels.length = 0;
  messages.info.length = 0;
  messages.warning.length = 0;
  messages.error.length = 0;

  stubWorkspace.workspaceFolders = [
    { uri: { fsPath: bin.root } as vscode.Uri, name: 'ws', index: 0 }
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
  await bin.dispose();
});

describe('KBEngineServerManager ProcessRunner injection', () => {
  it('passes command, args, cwd and assembled environment to the runner', async () => {
    bin.write('probe', { kind: 'run', stdoutMarker: 'up' });
    const recorded: Array<{ cmd: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }> = [];
    const runner: ProcessRunner = {
      spawn: (cmd, args, options) => {
        recorded.push({ cmd, args, cwd: options.cwd, env: options.env });
        // 记录之余走真实 spawn,让 stopComponent 的 SIGTERM 链路完整成立
        return childProcess.spawn(cmd, args, options);
      }
    };
    const manager = new KBEngineServerManager({} as unknown as vscode.ExtensionContext, runner);
    currentManager = manager;

    expect(await manager.startComponent(makeComponent('probe'))).toBe(true);

    expect(recorded).toHaveLength(1);
    expect(recorded[0].cmd).toBe(path.join(bin.binPath, 'probe'));
    expect(recorded[0].args).toEqual(['--flag']);
    expect(recorded[0].cwd).toBe(configRoot);
    // 环境装配:KBE_BIN_PATH 注入值带尾分隔符
    expect(recorded[0].env.KBE_BIN_PATH).toBe(`${bin.binPath}${path.sep}`);

    await until(() => manager.getServerStatus('probe') === 'running');
    await manager.stopComponent('probe');
  }, 8000);

  it('routes a synchronously throwing runner into the startup failure channel', async () => {
    bin.write('boom', { kind: 'run' });
    const runner: ProcessRunner = {
      spawn: () => {
        throw new Error('spawn exploded');
      }
    };
    const manager = new KBEngineServerManager({} as unknown as vscode.ExtensionContext, runner);
    currentManager = manager;

    expect(await manager.startComponent(makeComponent('boom'))).toBe(false);
    expect(manager.getRunningServers().size).toBe(0);
    expect(channelText('Boom')).toContain('[ERROR] 启动失败: Error: spawn exploded');
  }, 8000);
});

describe('KBEngineServerManager fake child process events', () => {
  const makeFakeChild = (pid = 4242): childProcess.ChildProcess => {
    const child = new EventEmitter() as unknown as childProcess.ChildProcess;
    Object.assign(child, {
      pid,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: () => true
    });
    return child;
  };

  it('spawns argless and logs (none) for a component without defaultArgs', async () => {
    bin.write('bare', { kind: 'run' });
    const spawned: string[][] = [];
    const fakeChild = makeFakeChild();
    const runner: ProcessRunner = {
      spawn: (_cmd, args) => {
        spawned.push(args);
        return fakeChild;
      }
    };
    const manager = new KBEngineServerManager({} as unknown as vscode.ExtensionContext, runner);
    currentManager = manager;

    // defaultArgs 缺失是公开 API 的合法形态(JSON 装载/外部调用方):
    // 日志兜底 (none),spawn 参数兜底 []
    const bare = { ...makeComponent('bare'), defaultArgs: undefined } as unknown as ServerComponent;
    expect(await manager.startComponent(bare)).toBe(true);

    expect(spawned[0]).toEqual([]);
    expect(channelText('Bare')).toContain('启动参数: (none)');

    fakeChild.emit('exit', 0, null);
    expect(manager.getRunningServers().size).toBe(0);
  }, 8000);

  it('clears the startup timer on the first error and tolerates later events', async () => {
    bin.write('flux', { kind: 'run' });
    const fakeChild = makeFakeChild();
    const manager = new KBEngineServerManager({} as unknown as vscode.ExtensionContext, {
      spawn: () => fakeChild
    } as ProcessRunner);
    currentManager = manager;

    expect(await manager.startComponent(makeComponent('flux'))).toBe(true);

    // 第一次 error:启动定时器在 → 清除并移出运行表
    fakeChild.emit('error', new Error('EACCES'));
    expect(manager.getRunningServers().size).toBe(0);
    expect(channelText('Flux')).toContain('[ERROR] 进程错误: EACCES');

    // 定时器已空后的 exit 与二次 error:走 else,只记录日志不重复清理
    fakeChild.emit('exit', 1, null);
    fakeChild.emit('error', new Error('double fault'));
    const text = channelText('Flux');
    expect(text).toContain('[INFO] 进程退出: code=1, signal=null');
    expect(text.match(/\[ERROR\] 进程错误/g)).toHaveLength(2);
  }, 8000);

  it('derives the .exe suffix only for windows-style bin paths on win32', () => {
    // process.platform 可配置化驱动 win32 判定;vitest 5 默认 forks 池,
    // 本文件独占进程,补丁区间内无 await,不影响其他文件
    const manager = new KBEngineServerManager({} as unknown as vscode.ExtensionContext);
    const original = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

    try {
      configTable.binPath = 'D:\\kbengine\\kbe\\bin\\server';
      expect(manager.getExecutablePath(makeComponent('machine')))
        .toBe(path.win32.join('D:\\kbengine\\kbe\\bin\\server', 'machine.exe'));

      // win32 平台 + posix 风格 binPath 不加 .exe(usesPosixPath 守卫)
      configTable.binPath = '/usr/local/kbengine/kbe/bin/server';
      expect(manager.getExecutablePath(makeComponent('machine')))
        .toBe('/usr/local/kbengine/kbe/bin/server/machine');
    } finally {
      if (original) {
        Object.defineProperty(process, 'platform', original);
      }
    }
  });
});
