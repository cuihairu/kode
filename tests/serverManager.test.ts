import type * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  KBEngineServerManager,
  SERVER_COMPONENTS,
  ServerStatus
} from '../src/serverManager';
import { workspace as stubWorkspace } from './helpers/vscodeStub';

// KBEngineServerManager 的可测纯逻辑:组件常量表、状态枚举、二进制/配置
// 路径解析与环境构造(detectBinPath/detectKbeRoot/buildComponentEnvironment
// 经实例直调,真实文件系统探测)。startComponent 等真实 spawn 路径不在
// 纯逻辑测试域。vscodeStub 兜住 vscode(workspaceFolders 由本文件自行布置)。

const makeManager = () =>
  new KBEngineServerManager({} as unknown as vscode.ExtensionContext);

const internals = (manager: KBEngineServerManager) =>
  manager as unknown as {
    detectBinPath: () => string;
    detectKbeRoot: (binPath: string) => string;
    buildComponentEnvironment: (configPath: string, binPath: string) => NodeJS.ProcessEnv;
  };

describe('SERVER_COMPONENTS constant table', () => {
  it('lists the ten components in strict launch order', () => {
    expect(SERVER_COMPONENTS.map(c => c.name)).toEqual([
      'machine', 'logger', 'interfaces', 'dbmgr', 'baseappmgr',
      'cellappmgr', 'baseapp', 'cellapp', 'loginapp', 'bots'
    ]);
    SERVER_COMPONENTS.forEach((component, index) => {
      expect(component.order, component.name).toBe(index + 1);
      expect(component.executable, component.name).toBe(component.name);
    });
  });

  it('marks machine/dbmgr/baseappmgr/cellappmgr/baseapp/cellapp/loginapp as required', () => {
    expect(SERVER_COMPONENTS.filter(c => c.required).map(c => c.name)).toEqual([
      'machine', 'dbmgr', 'baseappmgr', 'cellappmgr', 'baseapp', 'cellapp', 'loginapp'
    ]);
  });

  it('carries per-component cid/gus args with bots as the gus=1 client', () => {
    expect(SERVER_COMPONENTS[0].defaultArgs).toEqual([
      '--cid=2129652375332859700', '--gus=1'
    ]);

    for (const component of SERVER_COMPONENTS) {
      const args = component.defaultArgs ?? [];
      if (component.name === 'bots') {
        // bots 是机器人客户端,不注册到 uid 空间,只有 gus
        expect(args).toEqual(['--gus=1']);
        continue;
      }
      expect(args.some(arg => arg.startsWith('--cid=')), component.name).toBe(true);
      expect(args).toContain(`--gus=${component.order}`);
    }
  });
});

describe('ServerStatus enum', () => {
  it('uses the five string states', () => {
    expect(ServerStatus.Stopped).toBe('stopped');
    expect(ServerStatus.Starting).toBe('starting');
    expect(ServerStatus.Running).toBe('running');
    expect(ServerStatus.Stopping).toBe('stopping');
    expect(ServerStatus.Error).toBe('error');
  });
});

describe('KBEngineServerManager state helpers', () => {
  it('reports every component as stopped before anything runs', () => {
    const manager = makeManager();

    expect(manager.getServerStatus('machine')).toBe(ServerStatus.Stopped);
    expect(manager.getServerStatus('unknown')).toBe(ServerStatus.Stopped);
    expect(manager.getRunningServers().size).toBe(0);
    expect(manager.getAllServers()).toBe(SERVER_COMPONENTS);
  });

  it('shows output channels only for known components', () => {
    const manager = makeManager();

    expect(manager.showComponentLogs('machine')).toBe(true);
    expect(manager.showComponentLogs('nope')).toBe(false);
  });
});

describe('KBEngineServerManager path resolution', () => {
  let root = '';

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-srv-'));
    // 命中候选 join(workspaceFolder, '../kbengine/kbe/bin/server')
    fs.mkdirSync(path.join(root, 'kbengine', 'kbe', 'bin', 'server'), { recursive: true });
    stubWorkspace.workspaceFolders = [{
      uri: { fsPath: path.join(root, 'ws') } as vscode.Uri,
      name: 'ws',
      index: 0
    }];
  });

  afterAll(() => {
    stubWorkspace.workspaceFolders = [];
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('detects the binary root next to the workspace', () => {
    const manager = makeManager();

    expect(manager.getBinPath()).toBe(path.join(root, 'kbengine', 'kbe', 'bin', 'server'));
  });

  it('detects the kbe root from a kbe/bin/server bin path', () => {
    const impl = internals(makeManager());
    const binPath = path.join(root, 'kbengine', 'kbe', 'bin', 'server');

    expect(impl.detectBinPath()).toBe(binPath);
    expect(impl.detectKbeRoot(binPath)).toBe(path.join(root, 'kbengine'));
    // 不以 kbe/bin/server 结尾的路径剥不出根
    expect(impl.detectKbeRoot('/usr/bin')).toBe('');
  });

  it('builds component environments with kbe root resources', () => {
    const impl = internals(makeManager());
    const kbeRoot = path.join(root, 'kbengine');
    const binPath = path.join(kbeRoot, 'kbe', 'bin', 'server');
    const configPath = path.join(root, 'ws', 'kbengine_defaults.xml');

    const env = impl.buildComponentEnvironment(configPath, binPath);

    expect(env.KBE_ROOT).toBe(kbeRoot);
    expect(env.KBE_RES_PATH).toBe([
      path.join(kbeRoot, 'kbe', 'res'),
      configPath,
      path.join(configPath, 'res'),
      path.join(configPath, 'scripts')
    ].join(path.delimiter));
    // 二进制目录路径补尾分隔符
    expect(env.KBE_BIN_PATH).toBe(binPath + path.sep);
  });

  it('omits kbe root variables when the bin path carries no kbe suffix', () => {
    const impl = internals(makeManager());

    const env = impl.buildComponentEnvironment('/cfg', path.join(root, 'bin'));

    expect(env.KBE_ROOT).toBeUndefined();
    expect(env.KBE_RES_PATH).toBeUndefined();
    expect(env.KBE_BIN_PATH).toBe(path.join(root, 'bin') + path.sep);
  });
});
