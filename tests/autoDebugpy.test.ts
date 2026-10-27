import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import {
  AUTO_DEBUGPY_ENABLED_DEFAULT,
  DEBUGPY_PORT_TABLE,
  EMBEDDED_PYTHON_VERSION,
  MIN_DEBUGPY_VERSION,
  buildDebugpyListenCommand,
  compareVersions,
  debugpyPackageDir,
  debugpyPortFor,
  injectDebugpyAfterStart,
  injectDebugpyListen,
  readDebugpyVersionFromSource,
  syncDebugpyPackage,
  type DebugpySyncDeps
} from '../src/autoDebugpy';
import { DebugConfigManager } from '../src/debugConfig';
import { ENGINE_DEFAULT_TELNET_PORTS, type TelnetTarget } from '../src/telnetService';
import { configurationOverrides, workspace as stubWorkspace, workspaceState, Uri } from './helpers/vscodeStub';

// 调试启动即 attach(2026-10-27 ③)三件套:端口分配表/系统 debugpy 复制
// (版本闸+不覆盖用户手放)/telnet 注入(真 KBEngineTelnetClient 对假引擎
// 服务端,记录 ':python' 与 listen 命令的到达面)/启动联动编排(开关默认
// 关零动作、单组件失败只记日志)/launch 生成快照(设置开才追加)。

const servers: net.Server[] = [];
const tempDirs: string[] = [];

const makeTempDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-autodebugpy-'));
  tempDirs.push(dir);
  return dir;
};

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve())))
  );
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  }
  stubWorkspace.workspaceFolders = [];
});

const freePort = (): Promise<number> =>
  new Promise(resolve => {
    const server = http.createServer();
    servers.push(server);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port;
      server.close(() => resolve(port));
    });
  });

/** 假引擎 telnet 服务端:可选密码握手,root 层起步,:python 切层,命令回执 */
interface FakeEngineOptions {
  password?: string;
  /** listen 命令的回执文本(默认空提示符;测试给 Traceback 造失败) */
  listenReply?: string;
}

const startFakeEngine = async (options: FakeEngineOptions = {}): Promise<{
  port: number;
  received: string[];
}> => {
  const received: string[] = [];
  const server = net.createServer(socket => {
    let layer: 'password' | 'root' | 'python' = options.password ? 'password' : 'root';
    socket.write(options.password ? 'password: ' : '\r\nKBEngine console\r\n[baseapp@root ~]# ');
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim().length === 0) {
          continue;
        }
        received.push(line);
        if (layer === 'password') {
          layer = 'root';
          socket.write('\r\nKBEngine console\r\n[baseapp@root ~]# ');
        } else if (line.trim() === ':python') {
          layer = 'python';
          socket.write('[baseapp@python ~] >>> ');
        } else if (layer === 'python' && line.includes('debugpy.listen')) {
          socket.write(options.listenReply ?? '>>> ');
        } else {
          socket.write(layer === 'python' ? '>>> ' : '[baseapp@root ~]# ');
        }
      }
    });
  });
  servers.push(server);
  const port = await new Promise<number>(resolve => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port));
  });
  return { port, received };
};

const memento = new Map<string, unknown>();

const makeContext = (): vscode.ExtensionContext =>
  ({
    subscriptions: [],
    workspaceState: {
      get: <T>(key: string): T | undefined => memento.get(key) as T | undefined,
      update: async (key: string, value: unknown): Promise<void> => {
        if (value === undefined) {
          memento.delete(key);
        } else {
          memento.set(key, value);
        }
      }
    }
  }) as unknown as vscode.ExtensionContext;

const syncDeps = (overrides: Partial<DebugpySyncDeps> = {}): DebugpySyncDeps & {
  copies: Array<{ from: string; to: string }>;
} => {
  const copies: Array<{ from: string; to: string }> = [];
  return {
    copies,
    runPython: async () => ({ stdout: '', exitCode: 1 }),
    exists: () => false,
    readFileText: () => '',
    copyTree: async (from, to) => {
      copies.push({ from, to });
    },
    ...overrides
  };
};

const SYSTEM_DEBUGPY = { version: '1.8.0', dir: '/usr/lib/python3/dist-packages/debugpy' };

describe('端口分配表', () => {
  it('五组件定口,互不冲突且全在 5678-5682 段', () => {
    const ports = DEBUGPY_PORT_TABLE.map(entry => entry.port);
    expect(ports).toHaveLength(5);
    expect(new Set(ports).size).toBe(5);
    for (const port of ports) {
      expect(port).toBeGreaterThanOrEqual(5678);
      expect(port).toBeLessThanOrEqual(5682);
    }
  });

  it('不与引擎 telnet 端口段(31000-51000)重叠', () => {
    const telnetPorts = ENGINE_DEFAULT_TELNET_PORTS.map(entry => entry.port);
    for (const entry of DEBUGPY_PORT_TABLE) {
      expect(telnetPorts).not.toContain(entry.port);
    }
  });

  it('debugpyPortFor 逐组件查表;表外组件(machine/interfaces/bots)无口', () => {
    expect(debugpyPortFor('baseapp')).toBe(5678);
    expect(debugpyPortFor('cellapp')).toBe(5679);
    expect(debugpyPortFor('loginapp')).toBe(5680);
    expect(debugpyPortFor('dbmgr')).toBe(5681);
    expect(debugpyPortFor('logger')).toBe(5682);
    expect(debugpyPortFor('machine')).toBeUndefined();
    expect(debugpyPortFor('interfaces')).toBeUndefined();
    expect(debugpyPortFor('bots')).toBeUndefined();
  });

  it('compareVersions 语义化三段比较(后缀按 0)', () => {
    expect(compareVersions('1.8.0', '1.6.7')).toBeGreaterThan(0);
    expect(compareVersions('1.8.0', MIN_DEBUGPY_VERSION)).toBe(0);
    expect(compareVersions('1.7.9', '1.8.0')).toBeLessThan(0);
    expect(compareVersions('2.0.0', '1.99.99')).toBeGreaterThan(0);
    expect(compareVersions('1.8', '1.8.0')).toBe(0);
  });

  it('注入命令形面:只绑 127.0.0.1,端口来自分配表', () => {
    expect(buildDebugpyListenCommand(5678))
      .toBe('import debugpy; debugpy.listen(("127.0.0.1", 5678))');
  });
});

describe('syncDebugpyPackage(系统 debugpy 复制)', () => {
  beforeEach(() => {
    memento.clear();
  });

  it('资产根未配置:如实报错不动手', async () => {
    const result = await syncDebugpyPackage(makeContext(), '', syncDeps());
    expect(result.status).toBe('error');
    expect(result.message).toContain('assetsRoot');
  });

  it('系统 Python 没装 debugpy:如实报错不抛', async () => {
    const result = await syncDebugpyPackage(makeContext(), '/ws', syncDeps());
    expect(result.status).toBe('error');
    expect(result.message).toContain('pip install debugpy');
  });

  it('版本闸:低于 1.8.0 拒绝复制(内嵌 Python 3.12.13 兼容)', async () => {
    const deps = syncDeps({
      runPython: async () => ({
        stdout: JSON.stringify({ version: '1.6.7', dir: '/old/debugpy' }),
        exitCode: 0
      })
    });
    const result = await syncDebugpyPackage(makeContext(), '/ws', deps);
    expect(result.status).toBe('error');
    expect(result.message).toContain('1.6.7');
    expect(result.message).toContain(EMBEDDED_PYTHON_VERSION);
    expect(deps.copies).toHaveLength(0);
  });

  it('目标不存在:整包复制到 scripts/common/debugpy 并记账', async () => {
    const deps = syncDeps({
      runPython: async () => ({ stdout: JSON.stringify(SYSTEM_DEBUGPY), exitCode: 0 }),
      exists: candidate => candidate === SYSTEM_DEBUGPY.dir
    });
    const result = await syncDebugpyPackage(makeContext(), '/ws/assets', deps);
    expect(result.status).toBe('synced');
    expect(deps.copies).toEqual([
      { from: SYSTEM_DEBUGPY.dir, to: debugpyPackageDir('/ws/assets') }
    ]);
    expect(memento.get(`kbengine.debugpySync.managed:${debugpyPackageDir('/ws/assets')}`)).toBe('1.8.0');
  });

  it('同版本已在位:跳过零写入', async () => {
    const target = debugpyPackageDir('/ws/assets');
    const deps = syncDeps({
      runPython: async () => ({ stdout: JSON.stringify(SYSTEM_DEBUGPY), exitCode: 0 }),
      exists: candidate => candidate === SYSTEM_DEBUGPY.dir || candidate === target || candidate === path.join(target, '__init__.py'),
      readFileText: () => "__version__ = '1.8.0'\n"
    });
    const result = await syncDebugpyPackage(makeContext(), '/ws/assets', deps);
    expect(result.status).toBe('skipped-same');
    expect(deps.copies).toHaveLength(0);
  });

  it('目录已存在但非本扩展写入(无记账)且版本不同:不覆盖用户手放', async () => {
    const target = debugpyPackageDir('/ws/assets');
    const deps = syncDeps({
      runPython: async () => ({ stdout: JSON.stringify(SYSTEM_DEBUGPY), exitCode: 0 }),
      exists: candidate => candidate === SYSTEM_DEBUGPY.dir || candidate === target || candidate === path.join(target, '__init__.py'),
      readFileText: () => "__version__ = '1.8.2'\n"
    });
    const result = await syncDebugpyPackage(makeContext(), '/ws/assets', deps);
    expect(result.status).toBe('skipped-user');
    expect(deps.copies).toHaveLength(0);
    expect(result.message).toContain('手动删除');
  });

  it('自己的旧版本(有记账)升级到系统版本', async () => {
    const target = debugpyPackageDir('/ws/assets');
    memento.set(`kbengine.debugpySync.managed:${target}`, '1.8.0');
    const deps = syncDeps({
      runPython: async () => ({
        stdout: JSON.stringify({ version: '1.8.2', dir: SYSTEM_DEBUGPY.dir }),
        exitCode: 0
      }),
      exists: candidate => candidate === SYSTEM_DEBUGPY.dir || candidate === target || candidate === path.join(target, '__init__.py'),
      readFileText: () => "__version__ = '1.8.0'\n"
    });
    const result = await syncDebugpyPackage(makeContext(), '/ws/assets', deps);
    expect(result.status).toBe('upgraded');
    expect(deps.copies).toHaveLength(1);
    expect(memento.get(`kbengine.debugpySync.managed:${target}`)).toBe('1.8.2');
  });

  it('目录已存在但不是 debugpy 布局(无 __init__.py):视为用户手放不动', async () => {
    const target = debugpyPackageDir('/ws/assets');
    const deps = syncDeps({
      runPython: async () => ({ stdout: JSON.stringify(SYSTEM_DEBUGPY), exitCode: 0 }),
      exists: candidate => candidate === SYSTEM_DEBUGPY.dir || candidate === target
    });
    const result = await syncDebugpyPackage(makeContext(), '/ws/assets', deps);
    expect(result.status).toBe('skipped-user');
    expect(deps.copies).toHaveLength(0);
  });

  it('复制失败(只读盘等):如实报错不抛', async () => {
    const deps = syncDeps({
      runPython: async () => ({ stdout: JSON.stringify(SYSTEM_DEBUGPY), exitCode: 0 }),
      exists: candidate => candidate === SYSTEM_DEBUGPY.dir,
      copyTree: async () => {
        throw new Error('EROFS: read-only file system');
      }
    });
    const result = await syncDebugpyPackage(makeContext(), '/ws/assets', deps);
    expect(result.status).toBe('error');
    expect(result.message).toContain('EROFS');
  });

  it('真实目录往返:版本探测走真 fs(readDebugpyVersionFromSource)', () => {
    expect(readDebugpyVersionFromSource("__version__ = '1.8.0'\n")).toBe('1.8.0');
    expect(readDebugpyVersionFromSource('not a debugpy init')).toBeNull();
  });
});

describe('injectDebugpyListen(telnet 注入,真客户端对假引擎)', () => {
  it('root 层起步:先到 :python 再到 listen 命令,端口来自分配表', async () => {
    const engine = await startFakeEngine();
    const result = await injectDebugpyListen(
      { host: '127.0.0.1', port: engine.port, password: '' },
      5678,
      { stepTimeoutMs: 4000 }
    );

    expect(result.status).toBe('injected');
    expect(engine.received).toEqual([
      ':python',
      'import debugpy; debugpy.listen(("127.0.0.1", 5678))'
    ]);
  });

  it('有密码组件:握手复用 KBEngineTelnetClient 同一密码链', async () => {
    const engine = await startFakeEngine({ password: 'pwd123456' });
    const result = await injectDebugpyListen(
      { host: '127.0.0.1', port: engine.port, password: 'pwd123456' },
      5681,
      { stepTimeoutMs: 4000 }
    );

    expect(result.status).toBe('injected');
    expect(engine.received[0]).toBe('pwd123456');
    expect(engine.received[engine.received.length - 1]).toContain('5681');
  });

  it('python 层 Traceback:判失败带末三行,不抛', async () => {
    const engine = await startFakeEngine({
      listenReply: "Traceback (most recent call last):\r\nModuleNotFoundError: No module named 'debugpy'\r\n>>> "
    });
    const result = await injectDebugpyListen(
      { host: '127.0.0.1', port: engine.port, password: '' },
      5678,
      { stepTimeoutMs: 4000 }
    );

    expect(result.status).toBe('failed');
    expect(result.detail).toContain('ModuleNotFoundError');
  });

  it('端口没人监听:等待提示符超时如实失败,不抛不炸启动', async () => {
    const port = await freePort();
    const result = await injectDebugpyListen(
      { host: '127.0.0.1', port, password: '' },
      5678,
      { stepTimeoutMs: 500 }
    );

    expect(result.status).toBe('failed');
    expect(result.detail).toContain('超时');
  });
});

describe('injectDebugpyAfterStart(启动联动编排)', () => {
  const logs: Array<{ component: string; level: string; text: string }> = [];
  const recorder = (component: string, level: 'info' | 'warning' | 'error', text: string): void => {
    logs.push({ component, level, text });
  };
  const target = (port: number): TelnetTarget => ({
    key: `baseapp:${port}`,
    label: 'baseapp',
    component: 'baseapp',
    host: '127.0.0.1',
    port,
    password: '',
    enableCommands: []
  });

  beforeEach(() => {
    logs.length = 0;
    workspaceState.reset();
    configurationOverrides.delete('kbengine');
  });

  it('开关默认关:零探测零日志零注入', async () => {
    let probeCalls = 0;
    await injectDebugpyAfterStart(['baseapp'], () => [target(40000)], {
      log: recorder,
      probe: async () => {
        probeCalls += 1;
        return true;
      }
    });

    expect(AUTO_DEBUGPY_ENABLED_DEFAULT).toBe(false);
    expect(probeCalls).toBe(0);
    expect(logs).toHaveLength(0);
  });

  it('开关开了但组件不在端口分配表:记 info 跳过(不探测)', async () => {
    configurationOverrides.set('kbengine', { 'debug.autoDebugpy': true });
    let probeCalls = 0;
    await injectDebugpyAfterStart(['machine'], () => [target(40000)], {
      log: recorder,
      probe: async () => {
        probeCalls += 1;
        return true;
      }
    });

    expect(probeCalls).toBe(0);
    expect(logs[0].level).toBe('info');
    expect(logs[0].text).toContain('端口分配表');
  });

  it('配置未开该组件 telnet:记 warning 跳过', async () => {
    configurationOverrides.set('kbengine', { 'debug.autoDebugpy': true });
    await injectDebugpyAfterStart(['baseapp'], () => [], { log: recorder });

    expect(logs[0].level).toBe('warning');
    expect(logs[0].text).toContain('telnet');
  });

  it('telnet 一直不就绪:readyTimeout 到点放弃,记 error 不抛', async () => {
    configurationOverrides.set('kbengine', { 'debug.autoDebugpy': true });
    await injectDebugpyAfterStart(['baseapp'], () => [target(40000)], {
      log: recorder,
      probe: async () => false,
      readyTimeoutMs: 120,
      pollIntervalMs: 40,
      schedule: async () => undefined
    });

    expect(logs[0].level).toBe('error');
    expect(logs[0].text).toContain('放弃注入');
  });

  it('telnet 就绪即注入成功:log 落 injected 面', async () => {
    configurationOverrides.set('kbengine', { 'debug.autoDebugpy': true });
    const engine = await startFakeEngine();
    await injectDebugpyAfterStart(['baseapp'], () => [target(engine.port)], {
      log: recorder,
      probe: async () => true,
      deps: { stepTimeoutMs: 4000 }
    });

    expect(logs).toEqual([
      { component: 'baseapp', level: 'info', text: expect.stringContaining('debugpy.listen 127.0.0.1:5678') }
    ]);
  });

  it('单组件注入失败:只记 error,不影响其余组件也不抛(并行面)', async () => {
    configurationOverrides.set('kbengine', { 'debug.autoDebugpy': true });
    const deadPort = await freePort();
    const engine = await startFakeEngine();
    const targets = [
      { ...target(deadPort), component: 'cellapp', key: `cellapp:${deadPort}` },
      { ...target(engine.port), component: 'baseapp' }
    ];
    await injectDebugpyAfterStart(['cellapp', 'baseapp'], () => targets, {
      log: recorder,
      probe: async () => true,
      deps: { stepTimeoutMs: 400 }
    });

    const failed = logs.find(entry => entry.component === 'cellapp');
    const injectedOne = logs.find(entry => entry.component === 'baseapp');
    expect(failed?.level).toBe('error');
    expect(injectedOne?.level).toBe('info');
    expect(logs).toHaveLength(2);
  });
});

describe('launch 生成(autoDebugpy 三件套之 c)', () => {
  beforeEach(() => {
    workspaceState.reset();
    configurationOverrides.delete('kbengine');
  });

  const manager = (): DebugConfigManager =>
    new DebugConfigManager(makeContext());

  it('开关默认关:不追加任何 debugpy 端口附加配置', () => {
    stubWorkspace.workspaceFolders = [{ uri: Uri.file('/ws'), name: 'ws', index: 0 }];
    const configurations = manager().generateLaunchConfigurations();

    const autoEntries = configurations.filter(item => String(item.name).includes('debugpy 5'));
    expect(autoEntries).toEqual([]);
    stubWorkspace.workspaceFolders = [];
  });

  it('开关开:五组件各一条 connect 附加配置,端口=分配表,localRoot=工作区根', () => {
    configurationOverrides.set('kbengine', { 'debug.autoDebugpy': true });
    stubWorkspace.workspaceFolders = [{ uri: Uri.file('/ws'), name: 'ws', index: 0 }];
    const configurations = manager().generateLaunchConfigurations();

    const autoEntries = configurations.filter(item => String(item.name).includes('(debugpy '));
    expect(autoEntries.map(item => item.name)).toEqual([
      'KBEngine: Python attach to baseapp (debugpy 5678)',
      'KBEngine: Python attach to cellapp (debugpy 5679)',
      'KBEngine: Python attach to loginapp (debugpy 5680)',
      'KBEngine: Python attach to dbmgr (debugpy 5681)',
      'KBEngine: Python attach to logger (debugpy 5682)'
    ]);
    for (const entry of autoEntries) {
      expect(entry.type).toBe('debugpy');
      expect(entry.request).toBe('attach');
      expect(entry.connect.host).toBe('127.0.0.1');
      expect(entry.pathMappings).toEqual([{ localRoot: '/ws', remoteRoot: '/ws' }]);
      expect(entry.presentation.group).toBe('KBEngine');
    }
    // 原有三类面(pickProcess attach / remote)不受影响
    expect(configurations.some(item => item.processId === '${command:pickProcess}')).toBe(true);
    stubWorkspace.workspaceFolders = [];
  });
});
