import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
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
