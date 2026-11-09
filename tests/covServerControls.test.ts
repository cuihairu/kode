// serverControls 命令装配面补测(覆盖率 98% 目标批次):dbid 输入臂
// (gate 放行 → showInputBox → 只读查询 → 消息回填)、focusDebugTarget
// 降级臂、调试会话起止事件面(fake debug 事件回放)、launch.json/示例
// 配置/等待连接开关/附加模式清除/远程附加空表/失败重试空表的如实降级。
// 依赖 mock 边界 = configDerive/serverConfigMerge/databaseDrift(查询链
// 纯逻辑已在 playerDataPanelCoverage 收口,此处只补装配臂);spawn 面
// (debugpy 注入/进程启停/py-spy)一律不触,降级臂即止。

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/configDerive', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/configDerive')>();
  return {
    ...actual,
    getDerivedDatabaseProfile: vi.fn(),
    // 缺省实现必须给 Promise(telnetDeriveTargets 首取未就绪即
    // `ensure().catch(...)`,undefined 会当场炸)
    ensureConfigDerivedScanRoot: vi.fn(async () => ({ ok: true } as never))
  };
});
vi.mock('../src/serverConfigMerge', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/serverConfigMerge')>();
  return { ...actual, resolveDatabaseInterfaceConfig: vi.fn() };
});
vi.mock('../src/backend/databaseDrift', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/backend/databaseDrift')>();
  return { ...actual, createMysqlDriftExecutor: vi.fn() };
});

// 依赖 mock 后的模块(import 顺序须在 vi.mock 之后)
import { activate, deactivate } from '../src/extension';
import { commandRegistry, commands } from './fake-vscode/commandRegistry';
import { languagesRegistry } from './fake-vscode/languages';
import { channels, messages, window as fakeWindow, windowState } from './fake-vscode/windowState';
import { panelRegistry } from './fake-vscode/panelRegistry';
import {
  configurationOverrides,
  globalConfigurationOverrides,
  workspace
} from './fake-vscode/workspaceState';
import {
  fireDebugSessionEvent,
  Uri,
  type ExtensionContext
} from './fake-vscode/core';
import { ensureConfigDerivedScanRoot, getDerivedDatabaseProfile } from '../src/configDerive';
import { createMysqlDriftExecutor, type DriftQueryExecutor } from '../src/backend/databaseDrift';
import { resolveDatabaseInterfaceConfig } from '../src/serverConfigMerge';
import { playerTaskStatusStore } from '../src/playerDataPanel';

const mockedProfile = vi.mocked(getDerivedDatabaseProfile);
const mockedEnsure = vi.mocked(ensureConfigDerivedScanRoot);
const mockedResolve = vi.mocked(resolveDatabaseInterfaceConfig);
const mockedCreate = vi.mocked(createMysqlDriftExecutor);

const derivedState = () => ({
  generation: 1,
  roots: [] as string[],
  fallback: null,
  degraded: false,
  diagnostics: [] as Array<{ scope: string; severity: string; message: string }>,
  entryScripts: [] as Array<{ process: string; module: string; path: string | null; exists: boolean }>,
  debug: { ready: false, reasons: [] as string[] },
  telnet: { enabled: false, endpoints: [] as Array<{ component: string; host: string; port: number; passwordSet: boolean }> },
  ok: true
});

const mysqlProfile = () => ({
  available: true,
  dbType: 'mysql',
  host: '127.0.0.1',
  port: 13306,
  username: 'kbe',
  databaseName: 'kbe',
  characterSet: 'utf8mb4',
  encrypt: false,
  passwordAvailable: true
});

/** 假只读执行器:记录查询与关闭;一条命中行供成功臂断言。 */
class FakeExecutor implements DriftQueryExecutor {
  queries: string[] = [];
  closed = 0;
  async runQuery(sql: string): Promise<{ columns: never[]; rows: Array<Record<string, unknown>> }> {
    this.queries.push(sql);
    return { columns: [], rows: [{ id: 42, sm_name: 'hero' }] };
  }
  async close(): Promise<void> {
    this.closed += 1;
  }
}

let root = '';
let extDir = '';
let gsDir = '';
let context: ExtensionContext;

const makeMemento = (store: Map<string, unknown>) => ({
  get: <T,>(key: string, defaultValue?: T): T | undefined => {
    if (!store.has(key)) {
      return defaultValue;
    }
    return store.get(key) as T | undefined;
  },
  update: (key: string, value: unknown): Promise<void> => {
    if (value === undefined) {
      store.delete(key);
    } else {
      store.set(key, value);
    }
    return Promise.resolve();
  }
});

const disposeContext = (target: ExtensionContext): void => {
  for (const disposable of target.subscriptions) {
    disposable.dispose();
  }
};

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-server-controls-'));
  const defsRoot = path.join(root, 'scripts', 'entity_defs');
  fs.mkdirSync(defsRoot, { recursive: true });
  fs.writeFileSync(
    path.join(defsRoot, 'Avatar.def'),
    [
      '<root>',
      '  <Properties>',
      '    <hp>',
      '      <Type>UINT32</Type>',
      '      <Flags>BASE_AND_CLIENT</Flags>',
      '    </hp>',
      '  </Properties>',
      '</root>'
    ].join('\n'),
    'utf8'
  );
  fs.writeFileSync(
    path.join(root, 'scripts', 'entities.xml'),
    '<root>\n  <Avatar> <hasClient/></Avatar>\n</root>\n',
    'utf8'
  );
  // 最小引擎资产树(waitAtStartup 开/关臂):assetsRoot 指这里,
  // 入口脚本 = <assets>/scripts/kbengine.py(entity_defs 同级,引擎约定)
  fs.mkdirSync(path.join(root, 'assets', 'scripts', 'entity_defs'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'assets', 'scripts', 'kbengine.py'),
    'import kbengine\n\nkbengine.init()\n',
    'utf8'
  );
  extDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-sc-manifest-'));
  fs.writeFileSync(
    path.join(extDir, 'package.json'),
    JSON.stringify({ name: 'kode', version: '0.2.0', engines: { vscode: '^1.84.0' } }),
    'utf8'
  );
  fs.mkdirSync(path.join(extDir, 'out'), { recursive: true });
  fs.writeFileSync(path.join(extDir, 'out', 'extension.js'), '', 'utf8');
  gsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-sc-gs-'));
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(extDir, { recursive: true, force: true });
  fs.rmSync(gsDir, { recursive: true, force: true });
});

beforeAll(async () => {
  commandRegistry.reset();
  languagesRegistry.reset();
  windowState.reset();
  panelRegistry.reset();
  workspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
  workspace.textDocuments = [];
  workspace.findFiles = async (pattern: string): Promise<Uri[]> =>
    pattern === '**/*.def' ? [Uri.file(path.join(root, 'scripts', 'entity_defs', 'Avatar.def'))] : [];
  context = {
    subscriptions: [],
    extensionUri: Uri.file(extDir),
    extensionPath: extDir,
    extension: { id: 'cuihairu.kode', extensionKind: 'workspace' },
    globalStoragePath: gsDir,
    workspaceState: makeMemento(new Map())
  };
  activate(context);
  await new Promise(resolve => setTimeout(resolve, 400));
});

afterAll(() => {
  disposeContext(context);
  expect(deactivate()).toBeUndefined();
});

beforeEach(() => {
  playerTaskStatusStore.clear();
  messages.info.length = 0;
  messages.warning.length = 0;
  messages.error.length = 0;
  mockedProfile.mockReturnValue(undefined);
  mockedResolve.mockReturnValue(null);
  mockedEnsure.mockResolvedValue(derivedState() as never);
});

const lastInfo = (): string => messages.info[messages.info.length - 1] ?? '';

describe('serverControls 装配面(覆盖补测)', () => {
  it('playerData.queryByDbid:gate 放行 → 输入 dbid → 只读查询成功,会话关闭', async () => {
    const executor = new FakeExecutor();
    mockedProfile.mockReturnValue(mysqlProfile() as never);
    mockedResolve.mockReturnValue({ plainPassword: 'pw' } as never);
    mockedCreate.mockImplementation(async () => executor);
    const original = fakeWindow.showInputBox;
    fakeWindow.showInputBox = async () => '42';
    try {
      await commands.executeCommand('kbengine.playerData.queryByDbid');
    } finally {
      fakeWindow.showInputBox = original;
    }
    expect(lastInfo()).toContain('查询完成:1 行');
    expect(executor.queries).toHaveLength(1);
    expect(executor.queries[0]).toContain('`tbl_Account`');
    expect(executor.queries[0]).toContain('WHERE `id` = 42');
    expect(executor.closed).toBe(1);
    const playerChannel = channels.find(channel => channel.name.includes('玩家'));
    expect(playerChannel?.lines.join('')).toContain('[dbid 42]');
    // UX-REVIEW-008a:最近一次状态入账(成功),可回看入口命令已注册
    expect(playerTaskStatusStore.get('query')?.outcome).toBe('success');
    expect(playerTaskStatusStore.get('query')?.detailCommandId).toBe('kbengine.playerData.showResult');
    expect(commandRegistry.registrations.has('kbengine.playerData.showResult')).toBe(true);
  });

  it('playerData.queryByDbid:输入取消/空串即止,零消息;状态账本记已取消', async () => {
    mockedProfile.mockReturnValue(mysqlProfile() as never);
    const original = fakeWindow.showInputBox;
    fakeWindow.showInputBox = async () => undefined;
    try {
      await commands.executeCommand('kbengine.playerData.queryByDbid');
    } finally {
      fakeWindow.showInputBox = original;
    }
    expect(messages.info).toHaveLength(0);
    // UX-REVIEW-008a:取消也是一次可回看的结果(与未运行区分)
    expect(playerTaskStatusStore.get('query')?.outcome).toBe('cancelled');

    fakeWindow.showInputBox = async () => '   ';
    try {
      await commands.executeCommand('kbengine.playerData.queryByDbid');
    } finally {
      fakeWindow.showInputBox = original;
    }
    expect(messages.info).toHaveLength(0);
    expect(mockedCreate).not.toHaveBeenCalled();
    expect(playerTaskStatusStore.get('query')?.outcome).toBe('cancelled');
  });

  it('debug.focusTarget:无参=指引去视图点击;未知 key=如实不在运行中', async () => {
    await commands.executeCommand('kbengine.debug.focusTarget');
    expect(lastInfo()).toContain('Debug Targets');
    await commands.executeCommand('kbengine.debug.focusTarget', 'baseapp');
    expect(lastInfo()).toContain('baseapp 不在运行中(进程已停)');
  });

  it('调试会话起止事件面:attach 命名会话预填(派生未就绪=不可用不预填)+ 终止回调', async () => {
    const session = {
      name: 'KBEngine: Python attach to baseapp#2',
      configuration: { name: 'KBEngine: Python attach to baseapp#2', type: 'python', request: 'attach' }
    };
    fireDebugSessionEvent('start', session);
    fireDebugSessionEvent('terminate', session);
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(messages.error).toHaveLength(0);
  });

  it('debug.updateLaunchJson:无运行实例 → 幂等写空壳 launch.json', async () => {
    await commands.executeCommand('kbengine.debug.updateLaunchJson');
    expect(lastInfo()).toContain('launch.json 已更新');
  });

  it('debug.createConfig:示例配置落 .kbengine/debug.json', async () => {
    await commands.executeCommand('kbengine.debug.createConfig');
    expect(lastInfo()).toContain('示例调试配置已创建');
  });

  it('debug.waitAtStartup.on:资产根未知 → 如实报缺入口脚本', async () => {
    await commands.executeCommand('kbengine.debug.waitAtStartup.on');
    expect(messages.error[messages.error.length - 1]).toContain('未找到入口脚本');
    expect(messages.error[messages.error.length - 1]).toContain('资产根未知');
  });

  it('debug.waitAtStartup.on/off:真实入口脚本上注入/移除等待引导块', async () => {
    const entryPath = path.join(root, 'assets', 'scripts', 'kbengine.py');
    const original = fs.readFileSync(entryPath, 'utf8');
    try {
      configurationOverrides.set('kbengine', { assetsRoot: path.join(root, 'assets') });
      // 开:引导块落盘 + 设置置真 + 完成提示
      await commands.executeCommand('kbengine.debug.waitAtStartup.on');
      const injected = fs.readFileSync(entryPath, 'utf8');
      expect(injected).toContain('# kode:debugpy-wait BEGIN');
      expect(lastInfo()).toContain('等待连接模式已开');
      expect(lastInfo()).toContain('debugpy 等待引导块');
      // 关:块逐字节还原 + 设置置假
      await commands.executeCommand('kbengine.debug.waitAtStartup.off');
      expect(fs.readFileSync(entryPath, 'utf8')).toBe(original);
      expect(lastInfo()).toContain('等待连接模式已关');
      expect(lastInfo()).toContain('已移除入口脚本的 debugpy 等待引导块');
    } finally {
      configurationOverrides.delete('kbengine');
      globalConfigurationOverrides.delete('kbengine');
      fs.writeFileSync(entryPath, original, 'utf8');
    }
  });

  it('debug.waitAtStartup.off:入口未定位 → 如实说明引导块手动移除', async () => {
    await commands.executeCommand('kbengine.debug.waitAtStartup.off');
    expect(lastInfo()).toContain('等待连接模式已关');
    expect(lastInfo()).toContain('入口脚本未定位');
  });

  it('debug.resetAttachMode:清除记住的附加模式', async () => {
    await commands.executeCommand('kbengine.debug.resetAttachMode');
    expect(lastInfo()).toContain('已清除附加模式选择');
  });

  it('debug.attachRemote:无远程目标清单 → 如实指引设置项', async () => {
    await commands.executeCommand('kbengine.debug.attachRemote');
    expect(lastInfo()).toContain('尚未配置远程调试目标');
  });

  it('debug.start / debug.attach:无目标且选择器取消 → 零动作不抛;带目标各走降级', async () => {
    await commands.executeCommand('kbengine.debug.start');
    await commands.executeCommand('kbengine.debug.attach');
    expect(messages.error).toHaveLength(0);
    // 带树节点载荷:resolveServerComponent 命中 baseapp
    // start → 无 debugpy 端口 → telnet 简报(无密码如实警示 + 简报)
    await commands.executeCommand('kbengine.debug.start', { name: 'baseapp' });
    expect(messages.warning[messages.warning.length - 1]).toContain('未配置 telnet 密码');
    expect(messages.info.join('')).toContain('telnet');
    // attach → 附加模式选择取消(quickpick 默认 undefined)→ 不附加
    await commands.executeCommand('kbengine.debug.attach', { name: 'baseapp' });
    expect(messages.error).toHaveLength(0);
  });

  it('server.retry:无失败目标 → 如实说明', async () => {
    await commands.executeCommand('kbengine.server.retry');
    expect(lastInfo()).toContain('没有可重试的失败目标');
  });

  it('server.start/stop/restart:缺可执行如实降级,零进程启动', async () => {
    // 带目标:resolveServerComponent 命中 baseapp → 可执行缺失即报,不 spawn
    await commands.executeCommand('kbengine.server.start', { name: 'baseapp' });
    expect(messages.error[messages.error.length - 1]).toContain('找不到 baseapp 可执行文件');
    await commands.executeCommand('kbengine.server.stop', { name: 'baseapp' });
    // restart 先 stop(未运行=零动作)再 start(同样如实报缺)
    await commands.executeCommand('kbengine.server.restart', { name: 'baseapp' });
    expect(messages.error[messages.error.length - 1]).toContain('找不到 baseapp 可执行文件');
    // 无载荷:stopAll 零运行实例快速返回
    messages.error.length = 0;
    await commands.executeCommand('kbengine.server.stop');
    expect(messages.error).toHaveLength(0);
    // 无载荷 start:autoStart 组逐个缺可执行即报(组报告,不抛)
    await commands.executeCommand('kbengine.server.start');
    expect(messages.error.length).toBeGreaterThan(0);
  });
});
