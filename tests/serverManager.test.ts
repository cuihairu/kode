import type * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import {
  KBEngineServerManager,
  SERVER_COMPONENTS,
  ServerStatus
} from '../src/serverManager';
import { LogHub } from '../src/logHub';
import {
  channels,
  configurationOverrides,
  messages,
  workspace as stubWorkspace
} from './helpers/vscodeStub';

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
  let rootBase = '';

  beforeAll(() => {
    // 私有父目录:第二候选 <ws>/../../kbe/bin/server 落在 base 下(base/kbe
    // 恒不存在),不受共享 /tmp/kbe 瞬时目录影响(与 serverManagerGaps 并行不互踩)
    rootBase = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-srv-'));
    root = path.join(rootBase, 'srv');
    fs.mkdirSync(root, { recursive: true });
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
    fs.rmSync(rootBase, { recursive: true, force: true });
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

describe('getConfigPath 资产根发现兜底(批128)', () => {
  let rootBase = '';
  let root = '';

  beforeAll(() => {
    rootBase = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-srvcfg-'));
    root = path.join(rootBase, 'cfg');
    fs.mkdirSync(root, { recursive: true });
    stubWorkspace.workspaceFolders = [{
      uri: { fsPath: root } as vscode.Uri,
      name: 'cfg',
      index: 0
    }];
  });

  afterAll(() => {
    stubWorkspace.workspaceFolders = [];
    fs.rmSync(rootBase, { recursive: true, force: true });
  });

  it('falls back to the discovered assets root when the default misses the probe', () => {
    // 默认值 ${workspaceFolder}/server 未过探针,约定 assets 命中
    fs.mkdirSync(path.join(root, 'assets', 'res', 'server'), { recursive: true });
    fs.writeFileSync(path.join(root, 'assets', 'res', 'server', 'kbengine.xml'), '<xml/>', 'utf8');
    configurationOverrides.set('kbengine', {});

    expect(makeManager().getConfigPath()).toBe(path.join(root, 'assets'));
  });

  it('keeps an explicit setting that passes the engine probe', () => {
    fs.mkdirSync(path.join(root, 'myassets', 'res', 'server'), { recursive: true });
    fs.writeFileSync(path.join(root, 'myassets', 'res', 'server', 'kbengine.xml'), '<xml/>', 'utf8');
    configurationOverrides.set('kbengine', { assetsRoot: path.join(root, 'myassets') });

    expect(makeManager().getConfigPath()).toBe(path.join(root, 'myassets'));
  });

  it('keeps the raw setting when both probe and discovery fail', () => {
    // 都失败:原样返回,让启动检查链给出带期望形态的报错(批127 口径)。
    // 独立空工作区:共享夹具里 assets/ 已被前面的用例建出,会合法命中发现
    const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-srvcfg-empty-'));
    const savedFolders = stubWorkspace.workspaceFolders;
    try {
      stubWorkspace.workspaceFolders = [{
        uri: { fsPath: emptyRoot } as vscode.Uri,
        name: 'empty',
        index: 0
      }];
      configurationOverrides.set('kbengine', { assetsRoot: path.join(emptyRoot, 'nowhere') });

      expect(makeManager().getConfigPath()).toBe(path.join(emptyRoot, 'nowhere'));
    } finally {
      stubWorkspace.workspaceFolders = savedFolders;
      fs.rmSync(emptyRoot, { recursive: true, force: true });
    }
  });

  it('expands the workspace placeholder before probing', () => {
    fs.mkdirSync(path.join(root, 'server', 'res', 'server'), { recursive: true });
    fs.writeFileSync(path.join(root, 'server', 'res', 'server', 'kbengine.xml'), '<xml/>', 'utf8');
    configurationOverrides.set('kbengine', { assetsRoot: '${workspaceFolder}/server' });

    expect(makeManager().getConfigPath()).toBe(path.join(root, 'server'));
  });
});

describe('KBEngineServerManager startup grace guard (批73)', () => {
  it('does not resurrect a disposed server when the grace timer fires', async () => {
    // 竞态守卫真臂:dispose() 清空 runningServers 但不清 startupTimer;
    // 假进程吞掉 kill(不发 exit)时,start-flow 的 exit 处理器无从清 timer,
    // 宽限定时器到点后守卫判空,静默跳过——不复活状态、不发启动成功提示
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-srv-grace-'));
    fs.mkdirSync(path.join(root, 'kbengine', 'kbe', 'bin', 'server'), { recursive: true });
    fs.writeFileSync(path.join(root, 'kbengine', 'kbe', 'bin', 'server', 'machine'), '#!/bin/sh\n');
    const configRoot = path.join(root, 'configs');
    fs.mkdirSync(configRoot, { recursive: true });
    stubWorkspace.workspaceFolders = [
      { uri: { fsPath: path.join(root, 'ws') } as vscode.Uri, name: 'ws', index: 0 }
    ];
    configurationOverrides.set('kbengine', { assetsRoot: configRoot });

    // 吞 kill 的假进程:kill 只翻标记,不触发 exit/error
    const runner = {
      spawn: (): ChildProcess =>
        Object.assign(new EventEmitter(), {
          pid: 4321,
          stdout: new EventEmitter(),
          stderr: new EventEmitter(),
          killed: false,
          kill: function kill(): void {
            this.killed = true;
          }
        }) as unknown as ChildProcess
    };

    const manager = new KBEngineServerManager({} as unknown as vscode.ExtensionContext, runner);

    const started = await manager.startComponent(SERVER_COMPONENTS[0]);
    expect(started).toBe(true);
    expect(manager.getServerStatus('machine')).toBe(ServerStatus.Starting);

    await manager.dispose();
    expect(manager.getRunningServers().size).toBe(0);

    // 宽限期(1000ms)过后:守卫判空走假臂,无"启动成功"提示,状态不复活
    await new Promise(resolve => setTimeout(resolve, 1300));
    expect(messages.info.filter(message => message.includes('启动成功'))).toHaveLength(0);
    expect(manager.getServerStatus('machine')).toBe(ServerStatus.Stopped);

    configurationOverrides.delete('kbengine');
    stubWorkspace.workspaceFolders = [];
    fs.rmSync(root, { recursive: true, force: true });
  }, 10000);
});

describe('detectBinPath kbe 源码根锚点兜底(批125 自动发现)', () => {
  let rootBase = '';

  beforeAll(() => {
    // 私有父目录 + 二级 ws:候选 <ws>/../../kbe/bin/server 落在 rootBase 下
    // (恒不存在),不受共享 /tmp/kbe 瞬时目录影响
    rootBase = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-srv-disc-'));
    const ws = path.join(rootBase, 'disc', 'ws');
    fs.mkdirSync(path.join(ws, 'kbe', 'src', 'lib', 'entitydef'), { recursive: true });
    fs.writeFileSync(
      path.join(ws, 'kbe', 'src', 'lib', 'entitydef', 'entitydef.cpp'),
      '// anchor\n',
      'utf8'
    );
    fs.mkdirSync(path.join(ws, 'kbe', 'bin', 'server'), { recursive: true });
    stubWorkspace.workspaceFolders = [{ uri: { fsPath: ws } } as never];
  });

  afterAll(() => {
    stubWorkspace.workspaceFolders = [];
    fs.rmSync(rootBase, { recursive: true, force: true });
  });

  it('binPath 未配时优先从引擎源码根推导 kbe/bin/server', () => {
    const savedHome = process.env.KBENGINE_HOME;
    delete process.env.KBENGINE_HOME;
    configurationOverrides.set('kbengine', { binPath: '' });
    try {
      expect(makeManager().getBinPath())
        .toBe(path.join(rootBase, 'disc', 'ws', 'kbe', 'bin', 'server'));
    } finally {
      if (savedHome === undefined) {
        delete process.env.KBENGINE_HOME;
      } else {
        process.env.KBENGINE_HOME = savedHome;
      }
      configurationOverrides.delete('kbengine');
    }
  });

  it('无锚点也无兄弟目录时仍为空,不假装找到', () => {
    const bare = path.join(rootBase, 'bare', 'ws');
    fs.mkdirSync(bare, { recursive: true });
    const savedHome = process.env.KBENGINE_HOME;
    delete process.env.KBENGINE_HOME;
    configurationOverrides.set('kbengine', { binPath: '' });
    stubWorkspace.workspaceFolders = [{ uri: { fsPath: bare } } as never];
    try {
      expect(makeManager().getBinPath()).toBe('');
    } finally {
      stubWorkspace.workspaceFolders = [{
        uri: { fsPath: path.join(rootBase, 'disc', 'ws') }
      } as never];
      if (savedHome === undefined) {
        delete process.env.KBENGINE_HOME;
      } else {
        process.env.KBENGINE_HOME = savedHome;
      }
      configurationOverrides.delete('kbengine');
    }
  });
});

describe('showComponentLogs(已保留日志回放输出通道)', () => {
  it('回放对应组件日志到其通道;未知组件不建通道返回 false', () => {
    const logHub = new LogHub({ flushIntervalMs: 25, maxListeners: 256 });
    logHub.ingest({ text: 'server ready', component: 'machine', source: 'machine' });
    logHub.ingest({ text: 'db alive', component: 'dbmgr', source: 'dbmgr' });
    const manager = new KBEngineServerManager(
      {} as unknown as vscode.ExtensionContext,
      undefined,
      logHub
    );

    expect(manager.showComponentLogs('machine')).toBe(true);
    expect(manager.showComponentLogs('dbmgr')).toBe(true);
    expect(manager.showComponentLogs('nope')).toBe(false);

    // channels 是共享入账表(跨用例累积):取本次用例新建的通道(尾部匹配)
    const machineChannel = channels.filter(c => /machine/i.test(c.name)).at(-1);
    expect(machineChannel).toBeDefined();
    expect(machineChannel!.lines.join('')).toContain('server ready');
    const dbmgrChannel = channels.filter(c => /dbmgr/i.test(c.name)).at(-1);
    expect(dbmgrChannel).toBeDefined();
    expect(dbmgrChannel!.lines.join('')).toContain('db alive');
  });
});
