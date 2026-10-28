import * as net from 'net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import {
  DEBUGPY_INSTANCE_PORT_WINDOWS,
  DEBUGPY_INSTANCE_WINDOW_SIZE,
  DEBUGPY_PORT_TABLE,
  allocateDebugpyInstancePort,
  injectDebugpyAfterStart
} from '../src/autoDebugpy';
import { DebugConfigManager } from '../src/debugConfig';
import { ENGINE_DEFAULT_TELNET_PORTS, type TelnetTarget } from '../src/telnetService';
import { configurationOverrides, workspace as stubWorkspace, workspaceState, Uri } from './helpers/vscodeStub';

// DBG-001 按 targetId 分配 debugpy 端口:同组件多实例各持窗口内独立口
// (首闲分配,互不相同);注入对象形携带实例口与标签;launch 生成逐实例
// 追加指向指定实例的 attach 条目。纯函数面+真客户端对假引擎+生成快照。

const servers: net.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve())))
  );
  stubWorkspace.workspaceFolders = [];
});

/** 假引擎 telnet 服务端(与 autoDebugpy.test.ts 同面,本文件自持精简版) */
const startFakeEngine = async (): Promise<{ port: number; received: string[] }> => {
  const received: string[] = [];
  const server = net.createServer(socket => {
    socket.write('\r\nKBEngine console\r\n[baseapp@root ~]# ');
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
        if (line.trim() === ':python') {
          socket.write('[baseapp@python ~] >>> ');
        } else {
          socket.write('>>> ');
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

describe('命名实例端口窗口(DBG-001)', () => {
  it('五组件各 8 槽,窗口互不相交且避开 5678-5682 分配表与引擎 telnet 段', () => {
    expect(DEBUGPY_INSTANCE_PORT_WINDOWS).toHaveLength(5);
    expect(new Set(DEBUGPY_INSTANCE_PORT_WINDOWS.map(entry => entry.component)).size).toBe(5);
    const allPorts = DEBUGPY_INSTANCE_PORT_WINDOWS.flatMap(entry =>
      Array.from({ length: DEBUGPY_INSTANCE_WINDOW_SIZE }, (_, offset) => entry.start + offset)
    );
    // 窗口内互异(等价于窗口互不相交)
    expect(new Set(allPorts).size).toBe(allPorts.length);
    // 不与既有分配表/引擎 telnet 默认口撞车
    for (const entry of DEBUGPY_PORT_TABLE) {
      expect(allPorts).not.toContain(entry.port);
    }
    for (const entry of ENGINE_DEFAULT_TELNET_PORTS) {
      expect(allPorts).not.toContain(entry.port);
    }
    // 全落在 5700-5739 规划段
    for (const port of allPorts) {
      expect(port).toBeGreaterThanOrEqual(5700);
      expect(port).toBeLessThanOrEqual(5739);
    }
  });

  it('首闲分配:空占用取窗口起点,占用后顺延;已占口一律跳过', () => {
    expect(allocateDebugpyInstancePort('cellapp', [])).toBe(5708);
    expect(allocateDebugpyInstancePort('cellapp', [5708])).toBe(5709);
    expect(allocateDebugpyInstancePort('cellapp', [5709])).toBe(5708);
    expect(allocateDebugpyInstancePort('cellapp', [5708, 5709])).toBe(5710);
    // 他组件的占用不干扰本组件窗口
    expect(allocateDebugpyInstancePort('baseapp', [5708, 5709])).toBe(5700);
  });

  it('同类型多实例连续分配互不相同(装配层用法:把在册口回灌 taken)', () => {
    const taken: number[] = [];
    const ports: number[] = [];
    for (let i = 0; i < DEBUGPY_INSTANCE_WINDOW_SIZE; i += 1) {
      const port = allocateDebugpyInstancePort('cellapp', taken);
      expect(port).toBeDefined();
      ports.push(port as number);
      taken.push(port as number);
    }
    expect(new Set(ports).size).toBe(DEBUGPY_INSTANCE_WINDOW_SIZE);
  });

  it('窗口耗尽如实 undefined;表外组件无窗口', () => {
    const taken = Array.from(
      { length: DEBUGPY_INSTANCE_WINDOW_SIZE },
      (_, offset) => 5708 + offset
    );
    expect(allocateDebugpyInstancePort('cellapp', taken)).toBeUndefined();
    expect(allocateDebugpyInstancePort('machine', [])).toBeUndefined();
    expect(allocateDebugpyInstancePort('bots', [])).toBeUndefined();
  });
});

describe('injectDebugpyAfterStart 对象形(命名实例)', () => {
  const logs: Array<{ component: string; level: string; text: string }> = [];
  const recorder = (component: string, level: 'info' | 'warning' | 'error', text: string): void => {
    logs.push({ component, level, text });
  };
  const target = (port: number): TelnetTarget => ({
    key: `cellapp:${port}`,
    label: 'cellapp',
    component: 'cellapp',
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

  it('命名实例注入:命令带窗口口,日志带实例标签与端口', async () => {
    configurationOverrides.set('kbengine', { 'debug.autoDebugpy': true });
    const engine = await startFakeEngine();
    await injectDebugpyAfterStart(
      [{ component: 'cellapp', targetId: 'a', port: 5708 }],
      () => [target(engine.port)],
      {
        log: recorder,
        probe: async () => true,
        deps: { stepTimeoutMs: 4000 }
      }
    );

    expect(engine.received.some(line => line.includes('debugpy.listen(("127.0.0.1", 5708)'))).toBe(true);
    expect(logs).toEqual([
      { component: 'cellapp', level: 'info', text: expect.stringContaining('实例 a debugpy.listen 127.0.0.1:5708') }
    ]);
  });

  it('命名实例配置未开 telnet:warning 带实例标签,组件字段仍是组件名', async () => {
    configurationOverrides.set('kbengine', { 'debug.autoDebugpy': true });
    await injectDebugpyAfterStart(
      [{ component: 'cellapp', targetId: 'b', port: 5709 }],
      () => [],
      { log: recorder }
    );

    expect(logs).toHaveLength(1);
    expect(logs[0].component).toBe('cellapp');
    expect(logs[0].level).toBe('warning');
    expect(logs[0].text).toContain('实例 b ');
    expect(logs[0].text).toContain('telnet');
  });
});

describe('launch 生成(DBG-001 命名实例条目)', () => {
  beforeEach(() => {
    workspaceState.reset();
    configurationOverrides.delete('kbengine');
  });

  const makeContext = (): vscode.ExtensionContext =>
    ({ subscriptions: [], workspaceState }) as unknown as vscode.ExtensionContext;

  it('运行中的命名实例各一条 attach 条目:名带 component#targetId,connect 指向分配口', () => {
    configurationOverrides.set('kbengine', { 'debug.autoDebugpy': true });
    stubWorkspace.workspaceFolders = [{ uri: Uri.file('/ws'), name: 'ws', index: 0 }];
    const configurations = new DebugConfigManager(makeContext()).generateLaunchConfigurations([
      { component: 'cellapp', targetId: 'a', port: 5708 },
      { component: 'cellapp', targetId: 'b', port: 5709 }
    ]);

    const instanceEntries = configurations.filter(item => String(item.name).includes('#'));
    expect(instanceEntries.map(item => item.name)).toEqual([
      'KBEngine: Python attach to cellapp#a (debugpy 5708)',
      'KBEngine: Python attach to cellapp#b (debugpy 5709)'
    ]);
    for (const entry of instanceEntries) {
      expect(entry.type).toBe('debugpy');
      expect(entry.request).toBe('attach');
      expect(entry.connect).toEqual({ host: '127.0.0.1', port: entry.name.includes('5708') ? 5708 : 5709 });
      expect(entry.pathMappings).toEqual([{ localRoot: '/ws', remoteRoot: '/ws' }]);
      expect(entry.presentation.group).toBe('KBEngine');
      expect(entry.presentation.order).toBe(4);
    }
    // 表条目仍在且在前(order 3 < 4)
    const tableEntry = configurations.find(item => item.name === 'KBEngine: Python attach to cellapp (debugpy 5679)');
    expect(tableEntry).toBeDefined();
    expect(tableEntry?.presentation.order).toBe(3);
    stubWorkspace.workspaceFolders = [];
  });

  it('无运行实例:零 # 条目(默认实例由表条目覆盖,面不变)', () => {
    configurationOverrides.set('kbengine', { 'debug.autoDebugpy': true });
    stubWorkspace.workspaceFolders = [{ uri: Uri.file('/ws'), name: 'ws', index: 0 }];
    const configurations = new DebugConfigManager(makeContext()).generateLaunchConfigurations();

    expect(configurations.some(item => String(item.name).includes('#'))).toBe(false);
    stubWorkspace.workspaceFolders = [];
  });
});
