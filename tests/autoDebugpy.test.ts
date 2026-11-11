import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import {
  AUTO_DEBUGPY_ENABLED_DEFAULT,
  DEBUGPY_PORT_TABLE,
  defaultRunPython,
  buildDebugpyListenCommand,
  debugpyPackageDir,
  debugpyPortFor,
  injectDebugpyAfterStart,
  injectDebugpyListen,
  readDebugpyVersionFromSource,
  setRunPythonTimeoutMsForTests,
  syncDebugpyPackage,
  type DebugpySyncDeps
} from '../src/autoDebugpy';
import type { PythonTarget } from '../src/backend/pythonTarget';
import { PYTHON_TARGET_SETTING } from '../src/backend/pythonTarget';
import { DebugConfigManager } from '../src/debugConfig';
// KODE-CFG-009:TS 端口常量表删(core 唯一真源);测试对照值取 core 同表镜像
import { ENGINE_DEFAULT_TELNET_PORTS, type TelnetTarget } from './helpers/configCoreContract';
import { configurationOverrides, workspace as stubWorkspace, workspaceState, Uri } from './helpers/vscodeStub';

// 调试启动即 attach(2026-10-27 ③)三件套:端口分配表/系统 debugpy 复制
// (版本闸+不覆盖用户手放)/telnet 注入(真 KBEngineTelnetClient 对假引擎
// 服务端,记录 ':python' 与 listen 命令的到达面)/启动联动编排(开关默认
// 关零动作、单组件失败只记日志)/launch 生成快照(设置开才追加)。

const servers: net.Server[] = [];
const tempDirs: string[] = [];

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

/** 引擎目标替身:三段版本 + 来源面(DBG-COMPAT-01 形状) */
const targetAt = (version: string): PythonTarget => ({
  version,
  source: 'project-setting',
  detail: `设置 ${PYTHON_TARGET_SETTING}=${version}`
});
/** 现代目标(3.12.13:与旧全局常量同版,回归既有流程面) */
const MODERN_TARGET = targetAt('3.12.13');
/** 3.7 目标(本批账本的主角:旧闸对其错用 1.8.0 下限) */
const TARGET_37 = targetAt('3.7.3');
const SYSTEM_DEBUGPY = { version: '1.8.0', dir: '/usr/lib/python3/dist-packages/debugpy', python: '3.12.13' };

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
    const result = await syncDebugpyPackage(makeContext(), '', MODERN_TARGET, syncDeps());
    expect(result.status).toBe('error');
    expect(result.message).toContain('assetsRoot');
  });

  it('目标未知:拒绝盲同步,文案带设置键(DBG-COMPAT-01 不再拿常量猜)', async () => {
    const unknown = { version: null, source: 'none' as const, detail: '引擎 Python 版本未知' };
    const deps = syncDeps();
    const result = await syncDebugpyPackage(makeContext(), '/ws', unknown, deps);
    expect(result.status).toBe('error');
    expect(result.message).toContain(PYTHON_TARGET_SETTING);
    expect(deps.copies).toHaveLength(0);
  });

  it('系统 Python 没装 debugpy:如实报错不抛', async () => {
    const result = await syncDebugpyPackage(makeContext(), '/ws', MODERN_TARGET, syncDeps());
    expect(result.status).toBe('error');
    expect(result.message).toContain('pip install debugpy');
  });

  it('3.7 目标 + debugpy 1.7.0(同 3.7 源):放行复制——旧 MIN 1.8.0 闸的账本缺陷反转', async () => {
    const deps = syncDeps({
      runPython: async () => ({
        stdout: JSON.stringify({ version: '1.7.0', dir: '/py37/debugpy', python: '3.7.3' }),
        exitCode: 0
      }),
      exists: candidate => candidate === '/py37/debugpy'
    });
    const result = await syncDebugpyPackage(makeContext(), '/ws/assets', TARGET_37, deps);
    expect(result.status).toBe('synced');
    expect(deps.copies).toEqual([{ from: '/py37/debugpy', to: debugpyPackageDir('/ws/assets') }]);
  });

  it('3.7 目标 + debugpy 1.8.0:严格锁版拒绝(过高也拒,1.8.0 起要求 ≥3.8)', async () => {
    const deps = syncDeps({
      runPython: async () => ({
        stdout: JSON.stringify({ version: '1.8.0', dir: SYSTEM_DEBUGPY.dir, python: '3.7.3' }),
        exitCode: 0
      })
    });
    const result = await syncDebugpyPackage(makeContext(), '/ws/assets', TARGET_37, deps);
    expect(result.status).toBe('error');
    expect(result.message).toContain('1.8.0');
    expect(result.message).toContain('1.7.0');
    expect(deps.copies).toHaveLength(0);
  });

  it('同步源解释器 Python 行与目标行不一致:ABI 拒绝(pydevd 原生扩展按 CPython 版本编译)', async () => {
    const deps = syncDeps({
      runPython: async () => ({
        stdout: JSON.stringify({ version: '1.8.13', dir: '/py312/debugpy', python: '3.12.13' }),
        exitCode: 0
      })
    });
    const result = await syncDebugpyPackage(makeContext(), '/ws/assets', TARGET_37, deps);
    expect(result.status).toBe('error');
    expect(result.message).toContain('3.12');
    expect(result.message).toContain('3.7');
    expect(deps.copies).toHaveLength(0);
  });

  it('探测输出缺 python 字段:拒绝同步(ABI 无法核对)', async () => {
    const deps = syncDeps({
      runPython: async () => ({
        stdout: JSON.stringify({ version: '1.8.0', dir: SYSTEM_DEBUGPY.dir }),
        exitCode: 0
      })
    });
    const result = await syncDebugpyPackage(makeContext(), '/ws/assets', MODERN_TARGET, deps);
    expect(result.status).toBe('error');
    expect(result.message).toContain('版本探测失败');
    expect(deps.copies).toHaveLength(0);
  });

  it('modern 目标 + debugpy 1.6.7:低于下限 1.8.0 拒绝复制', async () => {
    const deps = syncDeps({
      runPython: async () => ({
        stdout: JSON.stringify({ version: '1.6.7', dir: '/old/debugpy', python: '3.12.13' }),
        exitCode: 0
      })
    });
    const result = await syncDebugpyPackage(makeContext(), '/ws', MODERN_TARGET, deps);
    expect(result.status).toBe('error');
    expect(result.message).toContain('1.6.7');
    expect(result.message).toContain('1.8.0');
    expect(deps.copies).toHaveLength(0);
  });

  it('目标不存在:整包复制到 scripts/common/debugpy 并记账', async () => {
    const deps = syncDeps({
      runPython: async () => ({ stdout: JSON.stringify(SYSTEM_DEBUGPY), exitCode: 0 }),
      exists: candidate => candidate === SYSTEM_DEBUGPY.dir
    });
    const result = await syncDebugpyPackage(makeContext(), '/ws/assets', MODERN_TARGET, deps);
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
    const result = await syncDebugpyPackage(makeContext(), '/ws/assets', MODERN_TARGET, deps);
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
    const result = await syncDebugpyPackage(makeContext(), '/ws/assets', MODERN_TARGET, deps);
    expect(result.status).toBe('skipped-user');
    expect(deps.copies).toHaveLength(0);
    expect(result.message).toContain('手动删除');
  });

  it('自己的旧版本(有记账)升级到系统版本', async () => {
    const target = debugpyPackageDir('/ws/assets');
    memento.set(`kbengine.debugpySync.managed:${target}`, '1.8.0');
    const deps = syncDeps({
      runPython: async () => ({
        stdout: JSON.stringify({ version: '1.8.2', dir: SYSTEM_DEBUGPY.dir, python: '3.12.13' }),
        exitCode: 0
      }),
      exists: candidate => candidate === SYSTEM_DEBUGPY.dir || candidate === target || candidate === path.join(target, '__init__.py'),
      readFileText: () => "__version__ = '1.8.0'\n"
    });
    const result = await syncDebugpyPackage(makeContext(), '/ws/assets', MODERN_TARGET, deps);
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
    const result = await syncDebugpyPackage(makeContext(), '/ws/assets', MODERN_TARGET, deps);
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
    const result = await syncDebugpyPackage(makeContext(), '/ws/assets', MODERN_TARGET, deps);
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

  // DBG-008 状态板喂料面:report 逐目标回报 listening/failed(带端口/
  // 细节),跳过路径(不在表/没开 telnet)不回报——板据缺席=未注入
  it('report 面:注入成功回 listening 带口,命名实例按 component#id 键', async () => {
    configurationOverrides.set('kbengine', { 'debug.autoDebugpy': true });
    const engine = await startFakeEngine();
    const reported: Array<{ serverKey: string; outcome: string; detail: string; port?: number }> = [];
    await injectDebugpyAfterStart(
      ['baseapp', { component: 'cellapp', targetId: 'a', port: 5708 }],
      () => [{ ...target(engine.port), component: 'baseapp' }, { ...target(engine.port), component: 'cellapp' }],
      {
        log: recorder,
        probe: async () => true,
        deps: { stepTimeoutMs: 4000 },
        report: (serverKey, outcome, detail, port) => reported.push({ serverKey, outcome, detail, port })
      }
    );

    const baseapp = reported.find(entry => entry.serverKey === 'baseapp');
    const instance = reported.find(entry => entry.serverKey === 'cellapp#a');
    expect(baseapp?.outcome).toBe('listening');
    expect(baseapp?.port).toBe(5678);
    expect(baseapp?.detail).toContain('debugpy.listen');
    expect(instance?.outcome).toBe('listening');
    expect(instance?.port).toBe(5708);
  });

  it('report 面:telnet 到点放弃与注入落败都回 failed', async () => {
    configurationOverrides.set('kbengine', { 'debug.autoDebugpy': true });
    const reported: Array<{ serverKey: string; outcome: string; detail: string }> = [];
    // telnet 永不就绪 → failed
    await injectDebugpyAfterStart(['baseapp'], () => [target(40000)], {
      log: recorder,
      probe: async () => false,
      readyTimeoutMs: 120,
      pollIntervalMs: 40,
      schedule: async () => undefined,
      report: (serverKey, outcome, detail) => reported.push({ serverKey, outcome, detail })
    });
    // 假引擎拒不认注入命令 → failed
    const deadPort = await freePort();
    await injectDebugpyAfterStart(['cellapp'], () => [{ ...target(deadPort), component: 'cellapp' }], {
      log: recorder,
      probe: async () => true,
      deps: { stepTimeoutMs: 200 },
      report: (serverKey, outcome, detail) => reported.push({ serverKey, outcome, detail })
    });

    expect(reported).toHaveLength(2);
    expect(reported[0]).toMatchObject({ serverKey: 'baseapp', outcome: 'failed' });
    expect(reported[0].detail).toContain('放弃注入');
    expect(reported[1]).toMatchObject({ serverKey: 'cellapp', outcome: 'failed' });
  });

  it('report 面:不在端口表/没开 telnet 的跳过不回报(缺席=未注入)', async () => {
    configurationOverrides.set('kbengine', { 'debug.autoDebugpy': true });
    const reported: string[] = [];
    await injectDebugpyAfterStart(['machine'], () => [target(40000)], {
      log: recorder,
      probe: async () => true,
      report: serverKey => reported.push(serverKey)
    });
    await injectDebugpyAfterStart(['baseapp'], () => [], {
      log: recorder,
      report: serverKey => reported.push(serverKey)
    });

    expect(reported).toEqual([]);
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

describe('defaultRunPython(真实 spawn 的诚实通道)', () => {
  beforeEach(() => {
    setRunPythonTimeoutMsForTests(300);
    configurationOverrides.delete('kbengine');
  });

  afterEach(() => {
    setRunPythonTimeoutMsForTests(null);
    configurationOverrides.delete('kbengine');
  });

  // WIN-5:假解释器是 /bin/sh + sleep(POSIX 二进制),win32 上无此路径——
  // 截止组杀的 124 语义由 Linux CI 覆盖;win32 的截止杀路径另见 defaultRunPython
  // 平台分支用例。
  it.skipIf(process.platform === 'win32')('解释器挂起:按截止组杀并如实报超时失败,不再永久等待', async () => {
    // 用 node 自身当解释器,挂起脚本(node -c 跑 JS;设 10s 但 300ms 截止)
    // /bin/sh -c <code> 把 code 当 shell 脚本跑:sleep 100 挂起,300ms 截止组杀
    configurationOverrides.set('kbengine', { 'python.interpreterPath': '/bin/sh' });
    const started = Date.now();
    const result = await defaultRunPython('sleep 100');
    expect(result.exitCode).toBe(124);
    expect(Date.now() - started).toBeLessThan(5000);
  }, 8000);
});
