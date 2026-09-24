import type * as vscode from 'vscode';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DebugConfigManager } from '../src/debugConfig';
import type { DebugConfigFile, KBEngineDebugConfig } from '../src/debugConfig';
import { memoryFileSystem, workspace as stubWorkspace, Uri } from './helpers/vscodeStub';

// DebugConfigManager 的配置装载/合并/launch 配置生成纯逻辑。
// startDebugging/promptForProcessId 依赖真实 vscode.debug 与输入框,
// 不在纯逻辑测试域。文件读写经 stub 的内存 fs,路径语义真实。

type ManagerInternals = DebugConfigManager & {
  getDefaultConfig(): KBEngineDebugConfig;
  getDebuggerType(): string;
  config: KBEngineDebugConfig;
};

const makeManager = (): ManagerInternals =>
  new DebugConfigManager({ subscriptions: [] } as unknown as vscode.ExtensionContext) as ManagerInternals;

const setWorkspaceAt = (fsPath: string | null): void => {
  stubWorkspace.workspaceFolders = fsPath
    ? [{ uri: Uri.file(fsPath), name: 'ws', index: 0 }]
    : [];
};

const flushAsync = () => new Promise<void>(resolve => setTimeout(resolve, 0));

beforeEach(() => {
  memoryFileSystem.reset();
  setWorkspaceAt(null);
});

afterEach(() => {
  memoryFileSystem.reset();
  setWorkspaceAt(null);
});

describe('default debug configuration', () => {
  it('seeds the seven components with their telnet ports', () => {
    const config = makeManager().getDefaultConfig();

    expect(Object.keys(config.components)).toEqual([
      'loginapp', 'dbmgr', 'interfaces', 'logger', 'baseapp', 'cellapp', 'bots'
    ]);
    expect(Object.values(config.components).map(c => c.telnetPort)).toEqual([
      31000, 32000, 33000, 34000, 40000, 50000, 51000
    ]);
    expect(config.defaultTelnetHost).toBe('127.0.0.1');
    expect(config.defaultTelnetPort).toBe(0);
  });

  it('gives every component shared defaults but omits logger path mappings', () => {
    const config = makeManager().getDefaultConfig();

    for (const [name, component] of Object.entries(config.components)) {
      expect(component.telnetHost, name).toBe('127.0.0.1');
      expect(component.telnetPassword, name).toBe('pwd123456');
      expect(component.telnetDefaultLayer, name).toBe('python');
      expect(component.telnetEnableCommands, name).toEqual([]);
    }

    // logger 是纯日志进程,不映射工作区路径
    expect(config.components.logger.pathMappings).toBeUndefined();
    expect(config.components.baseapp.pathMappings).toEqual([{ localRoot: '', remoteRoot: '' }]);
  });

  it('maps the workspace folder into default path mappings', () => {
    setWorkspaceAt('/proj');
    const config = makeManager().getDefaultConfig();

    expect(config.components.cellapp.pathMappings).toEqual([
      { localRoot: '/proj', remoteRoot: '/proj' }
    ]);
  });
});

describe('configuration loading', () => {
  it('keeps defaults without a workspace and registers no watcher', () => {
    const context = { subscriptions: [] } as unknown as vscode.ExtensionContext;
    const manager = new DebugConfigManager(context) as ManagerInternals;

    expect(manager.getComponentConfig('baseapp').telnetPort).toBe(40000);
    expect(context.subscriptions).toHaveLength(0);
  });

  it('registers a watcher when a workspace exists', async () => {
    setWorkspaceAt('/proj');
    const context = { subscriptions: [] } as unknown as vscode.ExtensionContext;
    const manager = new DebugConfigManager(context);

    await flushAsync();

    // watchConfig 向 subscriptions 推入 FileSystemWatcher
    expect(context.subscriptions.length).toBeGreaterThan(0);
    expect(manager.getComponentConfig('dbmgr').telnetPort).toBe(32000);
  });

  it('merges .kbengine/debug.json over the defaults', async () => {
    setWorkspaceAt('/proj');
    memoryFileSystem.set(
      path.join('/proj', '.kbengine', 'debug.json'),
      JSON.stringify({
        version: '1.0.0',
        debug: {
          defaultTelnetHost: '10.0.0.1',
          components: {
            dbmgr: { telnetHost: '192.168.1.9', telnetPort: 32001 }
          }
        }
      } satisfies DebugConfigFile)
    );

    const manager = makeManager();
    await flushAsync();

    const dbmgr = manager.getComponentConfig('dbmgr');
    expect(dbmgr.telnetHost).toBe('192.168.1.9');
    expect(dbmgr.telnetPort).toBe(32001);

    // 未覆盖的组件继承文件里的顶层默认(10.0.0.1)
    expect(manager.getComponentConfig('baseapp').telnetHost).toBe('10.0.0.1');
  });

  it('falls back to defaults on malformed json', async () => {
    setWorkspaceAt('/proj');
    memoryFileSystem.set(path.join('/proj', '.kbengine', 'debug.json'), '{ not json');

    const manager = makeManager();
    await flushAsync();

    expect(manager.getComponentConfig('dbmgr').telnetPort).toBe(32000);
    expect(manager.getComponentConfig('dbmgr').telnetHost).toBe('127.0.0.1');
  });
});

describe('getComponentConfig', () => {
  it('resolves a known component from defaults', () => {
    const manager = makeManager();

    expect(manager.getComponentConfig('cellapp')).toEqual({
      telnetHost: '127.0.0.1',
      telnetPort: 50000,
      telnetPassword: 'pwd123456',
      telnetDefaultLayer: 'python',
      telnetEnableCommands: [],
      pathMappings: [{ localRoot: '', remoteRoot: '' }]
    });
  });

  it('falls back to the zero-port defaults for unknown components', () => {
    const manager = makeManager();

    expect(manager.getComponentConfig('kbmachined')).toEqual({
      telnetHost: '127.0.0.1',
      telnetPort: 0,
      telnetPassword: 'pwd123456',
      telnetDefaultLayer: 'python',
      telnetEnableCommands: [],
      pathMappings: [{ localRoot: '', remoteRoot: '' }]
    });
  });

  it('keeps explicit false-y user values distinct from absent ones', () => {
    setWorkspaceAt('/proj');
    const manager = makeManager();
    const internals = manager as ManagerInternals;

    internals.config = {
      defaultTelnetHost: '127.0.0.1',
      defaultTelnetPort: 0,
      components: {
        baseapp: { telnetEnableCommands: ['import debugpy'] }
      }
    };

    const baseapp = manager.getComponentConfig('baseapp');
    expect(baseapp.telnetEnableCommands).toEqual(['import debugpy']);
    // 未提供 host 时回落顶层默认
    expect(baseapp.telnetHost).toBe('127.0.0.1');
    expect(baseapp.telnetPort).toBe(0);
  });
});

describe('launch configuration generation', () => {
  it('always reports the debugpy debugger type', () => {
    expect(makeManager().getDebuggerType()).toBe('debugpy');
  });

  it('rebuilds the prompt input and keeps foreign inputs', () => {
    const manager = makeManager();

    expect(manager.generateLaunchInputs()).toEqual([
      {
        id: 'kbengineProcessId',
        type: 'promptString',
        description: '请输入已开启调试的 KBEngine 进程 PID'
      }
    ]);

    const merged = manager.generateLaunchInputs([
      { id: 'kbengineProcessId', type: 'promptString', description: 'stale' },
      { id: 'userAsk', type: 'promptString', description: 'keep me' }
    ]);

    expect(merged).toHaveLength(2);
    expect(merged[0]).toEqual({ id: 'userAsk', type: 'promptString', description: 'keep me' });
    expect(merged[1].id).toBe('kbengineProcessId');
    expect(merged[1].description).not.toBe('stale');
  });

  it('generates one attach configuration per component in seed order', () => {
    setWorkspaceAt('/proj');
    const manager = makeManager();
    const configurations = manager.generateLaunchConfigurations();

    expect(configurations).toHaveLength(7);
    expect(configurations.map(c => c.name)).toEqual([
      'KBEngine: Python attach to loginapp',
      'KBEngine: Python attach to dbmgr',
      'KBEngine: Python attach to interfaces',
      'KBEngine: Python attach to logger',
      'KBEngine: Python attach to baseapp',
      'KBEngine: Python attach to cellapp',
      'KBEngine: Python attach to bots'
    ]);

    expect(configurations[4]).toEqual({
      name: 'KBEngine: Python attach to baseapp',
      type: 'debugpy',
      request: 'attach',
      processId: '${input:kbengineProcessId}',
      justMyCode: false,
      pathMappings: [{ localRoot: '/proj', remoteRoot: '/proj' }],
      presentation: { group: 'KBEngine', order: 1 }
    });
    // logger 无组件映射时回落工作区映射
    expect(configurations[3].pathMappings).toEqual([{ localRoot: '/proj', remoteRoot: '/proj' }]);
  });
});

describe('updateLaunchJson', () => {
  it('fails without a workspace', async () => {
    await expect(makeManager().updateLaunchJson()).resolves.toBe(false);
  });

  it('merges into an existing launch.json with user configs first', async () => {
    setWorkspaceAt('/proj');
    memoryFileSystem.set(
      path.join('/proj', '.vscode', 'launch.json'),
      JSON.stringify({
        version: '0.4.0',
        configurations: [
          { name: 'KBEngine: Python attach to old', type: 'debugpy' },
          { name: 'My own config', type: 'node' }
        ],
        inputs: [
          { id: 'kbengineProcessId', type: 'promptString', description: 'stale' },
          { id: 'userAsk', type: 'promptString', description: 'keep me' }
        ]
      })
    );

    const manager = makeManager();
    await expect(manager.updateLaunchJson()).resolves.toBe(true);

    const written = JSON.parse(Buffer.from(
      memoryFileSystem.files.get(path.join('/proj', '.vscode', 'launch.json')) as Uint8Array
    ).toString('utf8'));

    expect(written.version).toBe('0.4.0');
    expect(written.configurations.map((c: { name: string }) => c.name)).toEqual([
      'My own config',
      ...makeManager().generateLaunchConfigurations().map(c => c.name)
    ]);
    expect(written.inputs.map((i: { id: string }) => i.id)).toEqual([
      'userAsk',
      'kbengineProcessId'
    ]);
  });

  it('creates the standard skeleton when launch.json is absent', async () => {
    setWorkspaceAt('/proj');
    const manager = makeManager();

    await expect(manager.updateLaunchJson()).resolves.toBe(true);

    const written = JSON.parse(Buffer.from(
      memoryFileSystem.files.get(path.join('/proj', '.vscode', 'launch.json')) as Uint8Array
    ).toString('utf8'));

    expect(written.version).toBe('0.2.0');
    expect(written.configurations).toHaveLength(7);
    expect(written.inputs).toHaveLength(1);
    expect(written.inputs[0].id).toBe('kbengineProcessId');
  });
});

describe('createExampleConfig', () => {
  it('writes the documented example with the three key components', async () => {
    setWorkspaceAt('/proj');
    const manager = makeManager();

    await expect(manager.createExampleConfig()).resolves.toBe(true);

    const written = JSON.parse(Buffer.from(
      memoryFileSystem.files.get(path.join('/proj', '.kbengine', 'debug.json')) as Uint8Array
    ).toString('utf8')) as DebugConfigFile;

    expect(written.version).toBe('1.0.0');
    expect(Object.keys(written.debug.components)).toEqual(['baseapp', 'cellapp', 'loginapp']);
    expect(written.debug.components.baseapp.telnetPort).toBe(40000);
    expect(written.debug.components.baseapp.telnetEnableCommands).toHaveLength(2);
    expect(written.debug.components.baseapp.pathMappings).toEqual([
      { localRoot: '${workspaceFolder}', remoteRoot: '${workspaceFolder}' }
    ]);
    // 未指定 pathMappings 的组件按类型省略该可选字段
    expect(written.debug.components.cellapp.pathMappings).toBeUndefined();
  });

  it('fails without a workspace', async () => {
    await expect(makeManager().createExampleConfig()).resolves.toBe(false);
  });
});
