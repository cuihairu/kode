import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  KBEngineServerManager,
  SERVER_COMPONENTS,
  type ServerComponent
} from '../src/serverManager';
import type * as vscode from 'vscode';
import { window as stubWindow, workspace as stubWorkspace } from './helpers/vscodeStub';

// spawn 同步 throw(参数已校验后几乎不可抛)经模块级 getter 工厂驱动:
// impl 置位时返回抛错假例,否则回落真实 spawn。
const spawnState = vi.hoisted(() => ({
  impl: undefined as undefined | ((...args: unknown[]) => unknown)
}));

vi.mock('child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    default: actual,
    get spawn() {
      if (spawnState.impl) {
        return spawnState.impl as typeof actual.spawn;
      }
      return actual.spawn;
    }
  };
});

// KBEngineServerManager 的配置解析与环境装配缺口:binPath 空配置的自动
// 检测(detectBinPath 候选探测)、${env:} 变量替换、KBE_ROOT 的环境变量
// 优先与 binPath 推导、buildComponentEnvironment 的 KBE_ROOT/KBE_RES_PATH
// 装配、spawn 同步抛错的启动失败 catch、startAutoComponents 的乱序排序、
// getAllServers 与 showComponentLogs 的双分支。

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

let root = '';

const makeManager = (): KBEngineServerManager =>
  new KBEngineServerManager({} as unknown as vscode.ExtensionContext);

const internals = (manager: KBEngineServerManager): {
  detectKbeRoot: (binPath: string) => string;
  buildComponentEnvironment: (configPath: string, binPath: string) => NodeJS.ProcessEnv;
} => manager as unknown as never;

const channelText = (fragment: string): string => {
  const channel = channels.find(item => item.name.includes(fragment));
  expect(channel, `channel ${fragment} exists`).toBeTruthy();
  return (channel as { lines: string[] }).lines.join('');
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

beforeAll(() => {
  windowish.createOutputChannel = (name: string) => {
    const channel = { name, lines: [] as string[] };
    channels.push(channel);
    return {
      append: (value: string) => {
        channel.lines.push(value);
      },
      appendLine: (value: string) => {
        channel.lines.push(`${value}\n`);
      },
      show: () => undefined,
      dispose: () => undefined
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
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-srvgap-'));
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(root, 'ws', 'cfg'), { recursive: true });

  configTable.binPath = path.join(root, 'bin');
  configTable.configPath = path.join(root, 'ws', 'cfg');
  configTable.autoStart = [];

  channels.length = 0;
  messages.info.length = 0;
  messages.warning.length = 0;
  messages.error.length = 0;

  stubWorkspace.workspaceFolders = [
    { uri: { fsPath: path.join(root, 'ws') } as vscode.Uri, name: 'ws', index: 0 }
  ];
});

afterEach(async () => {
  stubWorkspace.workspaceFolders = [];
  fs.rmSync(root, { recursive: true, force: true });
});

describe('bin path resolution gaps', () => {
  it('auto-detects the first existing candidate when binPath is empty', () => {
    // 第一候选 <root>/../kbe/bin/server = <tmp>/kbe/bin/server
    const candidate = path.join(root, '..', 'kbe', 'bin', 'server');
    fs.mkdirSync(path.join(root, '..', 'kbe', 'bin', 'server'), { recursive: true });
    configTable.binPath = '';

    try {
      expect(makeManager().getBinPath()).toBe(candidate);
    } finally {
      fs.rmSync(path.join(root, '..', 'kbe'), { recursive: true, force: true });
    }
  });

  it('resolves ${env:} placeholders in the configured binPath', () => {
    configTable.binPath = '${env:KODE_SRVGAP_BIN}/bin';
    process.env.KODE_SRVGAP_BIN = root;

    try {
      expect(makeManager().getBinPath()).toBe(path.join(root, 'bin'));
    } finally {
      delete process.env.KODE_SRVGAP_BIN;
    }
  });

  it('returns an empty bin path without a workspace folder', () => {
    configTable.binPath = '';
    stubWorkspace.workspaceFolders = [];

    expect(makeManager().getBinPath()).toBe('');
  });

  it('returns an empty bin path when no candidate exists', () => {
    // 本机无 /usr/local/kbengine、/opt/kbengine,KBENGINE_HOME 未设,
    // tmp 下也不建任何候选目录
    configTable.binPath = '';
    const detected = makeManager().getBinPath();

    expect([root, path.join(root, 'bin')]).not.toContain(detected);
    expect(detected).toBe('');
  });
});

describe('kbe root and component environment gaps', () => {
  it('prefers the KBE_ROOT environment variable', () => {
    process.env.KBE_ROOT = '/fake-kbe-root';

    try {
      expect(internals(makeManager()).detectKbeRoot(path.join(root, 'bin'))).toBe('/fake-kbe-root');
    } finally {
      delete process.env.KBE_ROOT;
    }
  });

  it('derives KBE_ROOT from a kbe/bin/server suffix and rejects other shapes', () => {
    delete process.env.KBE_ROOT;
    const manager = makeManager();
    const detect = (binPath: string): string => internals(manager).detectKbeRoot(binPath);

    expect(detect(path.join(root, 'kbe', 'bin', 'server'))).toBe(root);
    expect(detect(path.join(root, 'bin'))).toBe('');
    expect(detect('')).toBe('');
  });

  it('assembles KBE_ROOT and KBE_RES_PATH when a root is available', () => {
    delete process.env.KBE_ROOT;
    const configPath = path.join(root, 'ws', 'cfg');
    const binPath = path.join(root, 'kbe', 'bin', 'server');
    const env = internals(makeManager()).buildComponentEnvironment(configPath, binPath);

    expect(env.KBE_ROOT).toBe(root);
    expect((env.KBE_RES_PATH ?? '').split(path.delimiter)).toEqual([
      path.join(root, 'kbe', 'res'),
      configPath,
      path.join(configPath, 'res'),
      path.join(configPath, 'scripts')
    ]);
    expect(env.KBE_BIN_PATH).toBe(`${binPath}${path.sep}`);
  });

  it('keeps an empty KBE_BIN_PATH for an empty bin path', () => {
    // ensureTrailingSeparator('') 的空串早退
    const env = internals(makeManager()).buildComponentEnvironment(root, '');

    expect(env.KBE_BIN_PATH).toBe('');
    expect(env.KBE_ROOT).toBeUndefined();
  });
});

describe('startup failure and orchestration gaps', () => {
  it('reports a synchronous spawn throw through the failure catch', async () => {
    fs.writeFileSync(path.join(root, 'bin', 'jinxed'), '#!/bin/sh\nexec sleep 30', 'utf8');
    fs.chmodSync(path.join(root, 'bin', 'jinxed'), 0o755);

    // 参数校验后 spawn 同步 throw 在真实取值域下几乎不可抛,
    // 用模块级 spawn 假例驱动 catch 分支(行为断言不受影响)
    spawnState.impl = () => {
      throw new Error('spawn-boom');
    };

    try {
      const manager = makeManager();
      expect(await manager.startComponent(makeComponent('jinxed'))).toBe(false);
      expect(manager.getRunningServers().size).toBe(0);

      const text = channelText('Jinxed');
      expect(text).toContain('[ERROR] 启动失败');
      expect(text).toContain('spawn-boom');
    } finally {
      spawnState.impl = undefined;
    }
  }, 8000);

  it('orders auto-start components by their configured order', async () => {
    // 乱序声明 dbmgr(4)→machine(1)→logger(2):实际按 order 升序启动;
    // bin 下无这些可执行文件,全部走"找不到可执行文件"分支,不 spawn
    configTable.autoStart = ['dbmgr', 'machine', 'logger'];

    await makeManager().startAutoComponents();

    expect(messages.error).toHaveLength(3);
    expect(messages.error[0]).toContain('machine');
    expect(messages.error[1]).toContain('logger');
    expect(messages.error[2]).toContain('dbmgr');
  }, 15000);

  it('exposes the component catalog and shows component logs', () => {
    const manager = makeManager();

    expect(manager.getAllServers()).toEqual(SERVER_COMPONENTS);
    expect(manager.getAllServers().length).toBeGreaterThanOrEqual(8);
    expect(manager.showComponentLogs('no-such-component')).toBe(false);

    expect(manager.showComponentLogs('machine')).toBe(true);
    expect(channels.some(channel => channel.name.includes('Machine'))).toBe(true);
  });
});
