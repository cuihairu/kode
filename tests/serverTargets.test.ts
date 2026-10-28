import * as fs from 'fs';
import * as path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_TARGET_ID,
  KBEngineServerManager,
  SERVER_COMPONENTS,
  buildServerKey,
  parseServerKey,
  type ServerComponent
} from '../src/serverManager';
import type * as vscode from 'vscode';
import { window as stubWindow, workspace as stubWorkspace } from './helpers/vscodeStub';
import { FakeComponentBin } from './sim/fakeComponentBin';

// IDE-RUN-001 同组件多实例:targetId 区分登记键,两个 cellapp 各自
// 启动/停止,进程记录互不覆盖。默认实例(省略 targetId)的键保持纯组件
// 名,UI 树/命令/调试注入等既有调用面零变化。进程为真实回环子进程,
// "实例还活着/已死"用 process.kill(pid, 0) 探测,零 mock。

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

const makeManager = (): KBEngineServerManager => {
  const manager = new KBEngineServerManager({} as unknown as vscode.ExtensionContext);
  currentManager = manager;
  return manager;
};

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

const pidDead = async (pid: number | undefined): Promise<void> => {
  await until(() => !pidAlive(pid));
};

let bin: FakeComponentBin;

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

describe('server target keys', () => {
  it('builds the default instance key as the plain component name', () => {
    expect(buildServerKey('cellapp', DEFAULT_TARGET_ID)).toBe('cellapp');
  });

  it('appends the targetId for named instances', () => {
    expect(buildServerKey('cellapp', 'b')).toBe('cellapp#b');
  });

  it('parses composite keys back into component and target', () => {
    expect(parseServerKey('cellapp#b')).toEqual({ componentName: 'cellapp', targetId: 'b' });
    expect(parseServerKey('cellapp')).toEqual({ componentName: 'cellapp', targetId: DEFAULT_TARGET_ID });
  });
});

describe('KBEngineServerManager multi-instance targets', () => {
  it('registers and stops two cellapp instances independently', async () => {
    bin.write('cellapp', { kind: 'run', stdoutMarker: 'cellapp-up' });
    const manager = makeManager();

    expect(await manager.startComponent(cellapp, { targetId: 'a' })).toBe(true);
    expect(await manager.startComponent(cellapp, { targetId: 'b' })).toBe(true);

    const running = manager.getRunningServers();
    expect(Array.from(running.keys()).sort()).toEqual(['cellapp#a', 'cellapp#b']);
    const pidA = running.get('cellapp#a')?.pid;
    const pidB = running.get('cellapp#b')?.pid;
    expect(pidA).toBeGreaterThan(0);
    expect(pidB).toBeGreaterThan(0);
    expect(pidA).not.toBe(pidB);
    // 两个都是真实活进程
    expect(pidAlive(pidA)).toBe(true);
    expect(pidAlive(pidB)).toBe(true);

    // 分别停止:先停 a,b 的进程记录与进程本体都不受影响
    expect(await manager.stopComponent('cellapp', 'a')).toBe(true);
    expect(Array.from(manager.getRunningServers().keys())).toEqual(['cellapp#b']);
    expect(pidAlive(pidB)).toBe(true);
    await pidDead(pidA);

    expect(await manager.stopComponent('cellapp', 'b')).toBe(true);
    expect(manager.getRunningServers().size).toBe(0);
    await pidDead(pidB);
  }, 12000);

  it('refuses a duplicate start of the same component and targetId', async () => {
    bin.write('cellapp', { kind: 'run' });
    const manager = makeManager();

    expect(await manager.startComponent(cellapp, { targetId: 'a' })).toBe(true);
    expect(await manager.startComponent(cellapp, { targetId: 'a' })).toBe(false);

    expect(messages.warning).toEqual(['CellApp 实例 a 已在运行中']);
    expect(Array.from(manager.getRunningServers().keys())).toEqual(['cellapp#a']);
  }, 8000);

  it('treats an omitted targetId and explicit default as the same instance', async () => {
    bin.write('cellapp', { kind: 'run' });
    const manager = makeManager();

    expect(await manager.startComponent(cellapp)).toBe(true);
    expect(await manager.startComponent(cellapp, { targetId: DEFAULT_TARGET_ID })).toBe(false);

    // 默认实例警告文案保持原样(UI/测试既有断言面)
    expect(messages.warning).toEqual(['CellApp 已在运行中']);
    // 显式命名实例可与默认实例并存
    expect(await manager.startComponent(cellapp, { targetId: 'x' })).toBe(true);
    expect(Array.from(manager.getRunningServers().keys()).sort()).toEqual(['cellapp', 'cellapp#x']);

    // stopAll 能同时回收默认键与复合键
    await manager.stopAll();
    expect(manager.getRunningServers().size).toBe(0);
  }, 10000);

  it('reports status per instance and falls back to stopped for absent targets', async () => {
    bin.write('cellapp', { kind: 'run' });
    const manager = makeManager();

    await manager.startComponent(cellapp, { targetId: 'a' });
    expect(manager.getServerStatus('cellapp', 'a')).not.toBe('stopped');
    // 默认实例从未登记:不串到别的实例上
    expect(manager.getServerStatus('cellapp')).toBe('stopped');

    await manager.stopComponent('cellapp', 'a');
    expect(manager.getServerStatus('cellapp', 'a')).toBe('stopped');
  }, 8000);
});
