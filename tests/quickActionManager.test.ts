import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { QuickActionManager } from '../src/quickActions';
import type {
  HttpRunResult,
  QuickActionManagerDeps,
  ScriptRunResult
} from '../src/quickActions';
import {
  memoryFileSystem,
  messages,
  Uri,
  window as stubWindow,
  windowState,
  workspace as stubWorkspace
} from './helpers/vscodeStub';
import { commands as stubCommands } from './helpers/vscodeStub';

// QuickActionManager 装配层:动作清单 quick pick、三后端执行(runScript/
// runHttp/executeCommand 全注入,不真跑 spawn/fetch)、确认框语义(缺省弹,
// confirm:false 跳过)、OUTPUT 通道流水、首装扫描(经内存 fs 目录表)与
// 取消记忆(memento)。配置读写走内存 fs 的 .kbengine/debug.json。

const windowish = stubWindow as unknown as Record<string, unknown>;
const originalShowQuickPick = windowish.showQuickPick;
const originalShowInfo = windowish.showInformationMessage;

interface PickCall {
  items: Array<Record<string, unknown>>;
  options?: Record<string, unknown>;
}
const pickCalls: PickCall[] = [];
const pickAnswers: Array<Array<Record<string, unknown>> | Record<string, unknown> | undefined> = [];

interface ConfirmCall {
  message: string;
  options?: unknown;
  actions?: unknown[];
}
const confirmCalls: ConfirmCall[] = [];
const confirmAnswers: Array<string | undefined> = [];

const memento = new Map<string, unknown>();

const makeContext = (): vscode.ExtensionContext =>
  ({
    subscriptions: [],
    extensionUri: Uri.file('/ext'),
    workspaceState: {
      get: <T>(key: string): T | undefined => memento.get(key) as T | undefined,
      update: async (key: string, value: unknown): Promise<void> => {
        memento.set(key, value);
      }
    }
  }) as unknown as vscode.ExtensionContext;

const scriptRuns: Array<{ script: string; cwd?: string; background: boolean }> = [];
const httpRuns: Array<{ url: string; method: string; body?: string }> = [];
const commandRuns: Array<{ command: string; args: unknown[] }> = [];

let scriptResult: ScriptRunResult = { code: 0, stdout: 'server stopped', stderr: '' };
let scriptError: Error | null = null;
let httpResult: HttpRunResult = { status: 200, body: '' };
let httpError: Error | null = null;
let commandError: Error | null = null;

const makeDeps = (): QuickActionManagerDeps => ({
  runScript: async options => {
    scriptRuns.push(options);
    if (scriptError) {
      throw scriptError;
    }
    return scriptResult;
  },
  runHttp: async options => {
    httpRuns.push(options);
    if (httpError) {
      throw httpError;
    }
    return httpResult;
  },
  executeCommand: async (command, args) => {
    commandRuns.push({ command, args });
    if (commandError) {
      throw commandError;
    }
    return undefined;
  }
});

const channelLines = (): string => windowState.channels.map(channel => channel.lines.join('')).join('');

const setConfig = (config: unknown): void => {
  memoryFileSystem.set('/ws/.kbengine/debug.json', JSON.stringify(config));
};

beforeAll(() => {
  windowish.showQuickPick = async (items: Array<Record<string, unknown>>, options?: Record<string, unknown>) => {
    pickCalls.push({ items, options });
    return pickAnswers.shift();
  };
  windowish.showInformationMessage = async (
    message: string,
    options?: unknown,
    ...actions: unknown[]
  ) => {
    // 与 vscode.showInformationMessage(message, options, ...items) 同形:
    // 带 actions 的调用即确认框,按脚本化应答回按钮或 undefined(取消);
    // 不带 actions 的普通信息提示交给 fake 默认实现(入账 messages.info)。
    if (actions.length === 0) {
      return (originalShowInfo as (message: string) => Promise<undefined>)(message);
    }
    confirmCalls.push({ message, options, actions });
    return confirmAnswers.shift();
  };
});

afterAll(() => {
  windowish.showQuickPick = originalShowQuickPick;
  windowish.showInformationMessage = originalShowInfo;
});

beforeEach(() => {
  messages.info.length = 0;
  messages.warning.length = 0;
  messages.error.length = 0;
  windowState.reset();
  memoryFileSystem.reset();
  pickCalls.length = 0;
  pickAnswers.length = 0;
  confirmCalls.length = 0;
  confirmAnswers.length = 0;
  memento.clear();
  scriptRuns.length = 0;
  httpRuns.length = 0;
  commandRuns.length = 0;
  scriptResult = { code: 0, stdout: 'server stopped', stderr: '' };
  scriptError = null;
  httpResult = { status: 200, body: '' };
  httpError = null;
  commandError = null;
  stubWorkspace.workspaceFolders = [{ uri: Uri.file('/ws'), name: 'ws', index: 0 }];
});

afterEach(() => {
  stubWorkspace.workspaceFolders = [];
});

describe('QuickActionManager.show', () => {
  it('tells the user where to configure when no actions exist', async () => {
    const manager = new QuickActionManager(makeContext(), makeDeps());

    await manager.show();

    expect(messages.info[0]).toContain('未配置快速执行动作');
    expect(messages.info[0]).toContain('.kbengine/debug.json');
    expect(pickCalls).toHaveLength(0);
    manager.dispose();
  });

  it('shows the same hint when no workspace folder is open', async () => {
    stubWorkspace.workspaceFolders = undefined as unknown as Array<{ uri: Uri; name: string; index: number }>;
    const manager = new QuickActionManager(makeContext(), makeDeps());

    await manager.show();

    expect(messages.info[0]).toContain('未配置快速执行动作');
    expect(pickCalls).toHaveLength(0);
    manager.dispose();
  });

  it('shows a script action target in the list and runs the picked one', async () => {
    setConfig({
      quickActions: [{ name: 'start_server', type: 'script', script: '${workspaceFolder}/start_server.bat' }]
    });
    pickAnswers.push({ label: 'start_server' });
    confirmAnswers.push('执行');
    const manager = new QuickActionManager(makeContext(), makeDeps());

    await manager.show();

    expect(pickCalls[0].items).toEqual([
      expect.objectContaining({ label: 'script', kind: vscode.QuickPickItemKind.Separator }),
      expect.objectContaining({
        label: 'start_server',
        description: 'script',
        detail: '${workspaceFolder}/start_server.bat'
      })
    ]);
    expect(scriptRuns).toEqual([
      { script: '/ws/start_server.bat', background: false, cwd: undefined }
    ]);
    manager.dispose();
  });

  it('does nothing when the picked label is not in the configured list', async () => {
    setConfig({
      quickActions: [{ name: 'restart', type: 'command', command: 'kbengine.server.restart', confirm: false }]
    });
    pickAnswers.push({ label: 'not-configured' });
    const manager = new QuickActionManager(makeContext(), makeDeps());

    await manager.show();

    expect(commandRuns).toHaveLength(0);
    expect(confirmCalls).toHaveLength(0);
    manager.dispose();
  });

  it('lists configured actions for picking and does nothing on cancel', async () => {
    setConfig({
      quickActions: [
        { name: 'restart', type: 'command', command: 'kbengine.server.restart', args: ['baseapp'] },
        { name: 'hotfix', type: 'http', url: 'http://127.0.0.1:9000/reload', confirm: false }
      ]
    });
    pickAnswers.push(undefined);
    const manager = new QuickActionManager(makeContext(), makeDeps());

    await manager.show();

    expect(pickCalls).toHaveLength(1);
    expect(pickCalls[0].items).toEqual([
      expect.objectContaining({ label: 'command', kind: vscode.QuickPickItemKind.Separator }),
      expect.objectContaining({ label: 'restart', description: 'command', detail: 'kbengine.server.restart baseapp' }),
      expect.objectContaining({ label: 'http', kind: vscode.QuickPickItemKind.Separator }),
      expect.objectContaining({ label: 'hotfix', description: 'http', detail: 'http://127.0.0.1:9000/reload' })
    ]);
    expect(commandRuns).toHaveLength(0);
    expect(httpRuns).toHaveLength(0);
    manager.dispose();
  });

  it('runs the picked command action with confirm and resolved args', async () => {
    setConfig({
      quickActions: [
        {
          name: 'open-conf',
          type: 'command',
          command: 'kbengine.entity.open',
          args: ['${workspaceFolder}/scripts/entity_defs/Hero.def']
        }
      ]
    });
    pickAnswers.push({ label: 'open-conf' });
    confirmAnswers.push('执行');
    const manager = new QuickActionManager(makeContext(), makeDeps());

    await manager.show();

    expect(commandRuns).toEqual([
      { command: 'kbengine.entity.open', args: ['/ws/scripts/entity_defs/Hero.def'] }
    ]);
    expect(confirmCalls[0].message).toContain('open-conf');
    expect((confirmCalls[0].options as { modal: boolean }).modal).toBe(true);
    expect(channelLines()).toContain('open-conf → ✓');
    manager.dispose();
  });

  it('reports skipped invalid config entries alongside the action list', async () => {
    setConfig({
      quickActions: [
        { name: 'ok', type: 'command', command: 'kbengine.refreshExplorer', confirm: false },
        { name: 'broken', type: 'shell' }
      ]
    });
    pickAnswers.push(undefined);
    const manager = new QuickActionManager(makeContext(), makeDeps());

    await manager.show();

    expect(messages.info[0]).toBe('快速执行动作配置中有 1 条无效，已跳过');
    // 唯一有效动作 + 它前面那条组名分隔线
    expect(pickCalls[0].items).toHaveLength(2);
    manager.dispose();
  });

  it('treats an unreadable config file as no actions', async () => {
    memoryFileSystem.set('/ws/.kbengine/debug.json', '{broken json');
    const manager = new QuickActionManager(makeContext(), makeDeps());

    await manager.show();

    expect(messages.info[0]).toContain('未配置快速执行动作');
    expect(pickCalls).toHaveLength(0);
    manager.dispose();
  });

  it('treats an editor without any workspace folder as no actions', async () => {
    // 真 vscode 在未开文件夹时给的是 undefined 而不是空数组
    stubWorkspace.workspaceFolders = undefined as unknown as typeof stubWorkspace.workspaceFolders;
    const manager = new QuickActionManager(makeContext(), makeDeps());

    await manager.show();

    expect(messages.info[0]).toContain('未配置快速执行动作');
    expect(pickCalls).toHaveLength(0);
    manager.dispose();
  });

  it('groups consecutive actions of the same backend under one separator', async () => {
    // 用户令「学 debugger 那样下拉选目标」:下拉=清单 quick pick,同后端连续段
    // 共用一条分隔线,不重排用户配置顺序
    setConfig({
      quickActions: [
        { name: 'restart', type: 'command', command: 'kbengine.server.restart', confirm: false },
        { name: 'refresh', type: 'command', command: 'kbengine.refreshExplorer', confirm: false },
        { name: 'hotfix', type: 'http', url: 'http://127.0.0.1:9000/reload', confirm: false }
      ]
    });
    pickAnswers.push(undefined);
    const manager = new QuickActionManager(makeContext(), makeDeps());

    await manager.show();

    const items = pickCalls[0].items as Array<{ label?: string; kind?: number }>;
    expect(items.map(item => item.label)).toEqual(['command', 'restart', 'refresh', 'http', 'hotfix']);
    expect(items[0].kind).toBe(vscode.QuickPickItemKind.Separator);
    expect(items[1].kind).toBeUndefined();
    expect(items[3].kind).toBe(vscode.QuickPickItemKind.Separator);
    manager.dispose();
  });

  it('ignores a separator answer without running anything', async () => {
    // 真 UI 分隔线不可选;替身能给出,按防御口径当取消,不猜着执行
    setConfig({
      quickActions: [{ name: 'restart', type: 'command', command: 'kbengine.server.restart', confirm: false }]
    });
    pickAnswers.push({ label: 'command', kind: vscode.QuickPickItemKind.Separator });
    const manager = new QuickActionManager(makeContext(), makeDeps());

    await manager.show();

    expect(commandRuns).toHaveLength(0);
    manager.dispose();
  });
});

describe('QuickActionManager.runDefault(Explorer ▶ 主按钮)', () => {
  it('points at the config file when no actions exist', async () => {
    const manager = new QuickActionManager(makeContext(), makeDeps());

    await manager.runDefault();

    expect(messages.info[0]).toContain('未发现可执行脚本');
    expect(messages.info[0]).toContain('.kbengine/debug.json');
    expect(commandRuns).toHaveLength(0);
    expect(scriptRuns).toHaveLength(0);
    manager.dispose();
  });

  it('runs the first action when nothing was run before', async () => {
    setConfig({
      quickActions: [
        { name: 'restart', type: 'command', command: 'kbengine.server.restart', confirm: false },
        { name: 'refresh', type: 'command', command: 'kbengine.refreshExplorer', confirm: false }
      ]
    });
    const manager = new QuickActionManager(makeContext(), makeDeps());

    await manager.runDefault();

    expect(commandRuns).toEqual([{ command: 'kbengine.server.restart', args: [] }]);
    expect(memento.get('kbengine.quickActions.lastRun')).toBe('restart');
    manager.dispose();
  });

  it('runs the action remembered from a previous pick', async () => {
    setConfig({
      quickActions: [
        { name: 'restart', type: 'command', command: 'kbengine.server.restart', confirm: false },
        { name: 'refresh', type: 'command', command: 'kbengine.refreshExplorer', confirm: false }
      ]
    });
    memento.set('kbengine.quickActions.lastRun', 'refresh');
    const manager = new QuickActionManager(makeContext(), makeDeps());

    await manager.runDefault();

    expect(commandRuns).toEqual([{ command: 'kbengine.refreshExplorer', args: [] }]);
    manager.dispose();
  });

  it('falls back to the first action when the remembered one is gone', async () => {
    setConfig({
      quickActions: [{ name: 'restart', type: 'command', command: 'kbengine.server.restart', confirm: false }]
    });
    memento.set('kbengine.quickActions.lastRun', 'removed');
    const manager = new QuickActionManager(makeContext(), makeDeps());

    await manager.runDefault();

    expect(commandRuns).toEqual([{ command: 'kbengine.server.restart', args: [] }]);
    manager.dispose();
  });

  it('still runs the first action without a workspace state host', async () => {
    // 极简装配上下文(嵌入/烟测替身)没有 workspaceState:执行照常,只是不记忆
    setConfig({
      quickActions: [{ name: 'restart', type: 'command', command: 'kbengine.server.restart', confirm: false }]
    });
    const manager = new QuickActionManager(
      { subscriptions: [] } as unknown as vscode.ExtensionContext,
      makeDeps()
    );

    await manager.runDefault();

    expect(commandRuns).toEqual([{ command: 'kbengine.server.restart', args: [] }]);
    manager.dispose();
  });

  it('records the picked action as the last run for the default button', async () => {
    setConfig({
      quickActions: [{ name: 'start_server', type: 'script', script: '${workspaceFolder}/start_server.bat' }]
    });
    pickAnswers.push({ label: 'start_server' });
    confirmAnswers.push('执行');
    const manager = new QuickActionManager(makeContext(), makeDeps());

    await manager.show();

    expect(memento.get('kbengine.quickActions.lastRun')).toBe('start_server');
    manager.dispose();
  });
});

describe('QuickActionManager.run backends', () => {
  it('runs a waiting script and streams stdout with the exit code', async () => {
    const manager = new QuickActionManager(makeContext(), makeDeps());
    const run = (
      manager as unknown as { run: (action: unknown) => Promise<boolean> }
    ).run.bind(manager);

    const ok = await run({
      name: 'stop_all',
      type: 'script',
      script: '${workspaceFolder}/stop.bat',
      background: false,
      confirm: false,
      source: 'manual'
    });

    expect(ok).toBe(true);
    expect(scriptRuns).toEqual([{ script: '/ws/stop.bat', background: false, cwd: undefined }]);
    expect(channelLines()).toContain('stop_all → ✓ exit 0');
    expect(channelLines()).toContain('server stopped');

    manager.dispose();
  });

  it('runs a background script without waiting for the exit', async () => {
    const manager = new QuickActionManager(makeContext(), makeDeps());
    const run = (manager as unknown as { run: (action: unknown) => Promise<boolean> }).run.bind(manager);

    const ok = await run({
      name: 'start_server',
      type: 'script',
      script: '${workspaceFolder}/start.bat',
      background: true,
      confirm: false,
      source: 'scan'
    });

    expect(ok).toBe(true);
    expect(scriptRuns).toEqual([{ script: '/ws/start.bat', background: true, cwd: undefined }]);
    expect(channelLines()).toContain('start_server → 已启动');

    manager.dispose();
  });

  it('marks a failed script with the exit code, stderr and an error popup', async () => {
    scriptResult = { code: 3, stdout: '', stderr: 'port in use' };
    const manager = new QuickActionManager(makeContext(), makeDeps());
    const run = (manager as unknown as { run: (action: unknown) => Promise<boolean> }).run.bind(manager);

    const ok = await run({
      name: 'boot',
      type: 'script',
      script: '/ws/boot.bat',
      background: false,
      confirm: false,
      source: 'manual'
    });

    expect(ok).toBe(false);
    expect(channelLines()).toContain('boot → ✗ exit 3');
    expect(channelLines()).toContain('port in use');
    expect(messages.error[0]).toBe('执行快速动作失败: boot (exit 3)');

    manager.dispose();
  });

  it('reports a script runner exception', async () => {
    scriptError = new Error('spawn ENOENT');
    const manager = new QuickActionManager(makeContext(), makeDeps());
    const run = (manager as unknown as { run: (action: unknown) => Promise<boolean> }).run.bind(manager);

    const ok = await run({
      name: 'start_server',
      type: 'script',
      script: '/ws/start.bat',
      background: true,
      confirm: false,
      source: 'manual'
    });

    expect(ok).toBe(false);
    expect(channelLines()).toContain('start_server → ✗');
    expect(messages.error[0]).toContain('spawn ENOENT');

    manager.dispose();
  });

  it('runs a script in the configured working directory', async () => {
    const manager = new QuickActionManager(makeContext(), makeDeps());
    const run = (manager as unknown as { run: (action: unknown) => Promise<boolean> }).run.bind(manager);

    const ok = await run({
      name: 'export_tables',
      type: 'script',
      script: '${workspaceFolder}/export_tables.bat',
      cwd: '${workspaceFolder}/tools',
      background: false,
      confirm: false,
      source: 'scan'
    });

    expect(ok).toBe(true);
    expect(scriptRuns).toEqual([
      { script: '/ws/export_tables.bat', background: false, cwd: '/ws/tools' }
    ]);
    manager.dispose();
  });

  it('reports a missing exit code as unknown instead of inventing one', async () => {
    scriptResult = { code: null, stdout: '', stderr: '' };
    const manager = new QuickActionManager(makeContext(), makeDeps());
    const run = (manager as unknown as { run: (action: unknown) => Promise<boolean> }).run.bind(manager);

    const ok = await run({
      name: 'stop_all',
      type: 'script',
      script: '/ws/stop.bat',
      background: false,
      confirm: false,
      source: 'manual'
    });

    expect(ok).toBe(false);
    expect(channelLines()).toContain('stop_all → ✗ exit 未知');
    expect(messages.error[0]).toBe('执行快速动作失败: stop_all (exit 未知)');
    manager.dispose();
  });

  it('reports a non-Error rejection as its string form', async () => {
    scriptError = 'spawn threw a string' as unknown as Error;
    const manager = new QuickActionManager(makeContext(), makeDeps());
    const run = (manager as unknown as { run: (action: unknown) => Promise<boolean> }).run.bind(manager);

    const ok = await run({
      name: 'start_server',
      type: 'script',
      script: '/ws/start.bat',
      background: false,
      confirm: false,
      source: 'manual'
    });

    expect(ok).toBe(false);
    expect(channelLines()).toContain('start_server → ✗ spawn threw a string');
    expect(messages.error[0]).toBe('spawn threw a string');
    manager.dispose();
  });

  it('runs an http action and reports the status code', async () => {
    const manager = new QuickActionManager(makeContext(), makeDeps());
    const run = (manager as unknown as { run: (action: unknown) => Promise<boolean> }).run.bind(manager);

    const ok = await run({
      name: 'hotfix',
      type: 'http',
      url: 'http://127.0.0.1:9000/reload',
      method: 'POST',
      body: '{"scope":"all"}',
      confirm: false,
      source: 'manual'
    });

    expect(ok).toBe(true);
    expect(httpRuns).toEqual([
      { url: 'http://127.0.0.1:9000/reload', method: 'POST', body: '{"scope":"all"}' }
    ]);
    expect(channelLines()).toContain('hotfix → ✓ HTTP 200');

    manager.dispose();
  });

  it('fails loudly on a non-2xx http answer', async () => {
    httpResult = { status: 500, body: 'boom' };
    const manager = new QuickActionManager(makeContext(), makeDeps());
    const run = (manager as unknown as { run: (action: unknown) => Promise<boolean> }).run.bind(manager);

    const ok = await run({
      name: 'hotfix',
      type: 'http',
      url: 'http://127.0.0.1:9000/reload',
      method: 'GET',
      confirm: false,
      source: 'manual'
    });

    expect(ok).toBe(false);
    expect(channelLines()).toContain('hotfix → ✗ HTTP 500');
    expect(messages.error[0]).toBe('执行快速动作失败: hotfix (HTTP 500)');

    manager.dispose();
  });

  it('reports an http runner exception such as a timeout', async () => {
    httpError = new Error('abort: timeout');
    const manager = new QuickActionManager(makeContext(), makeDeps());
    const run = (manager as unknown as { run: (action: unknown) => Promise<boolean> }).run.bind(manager);

    const ok = await run({
      name: 'hotfix',
      type: 'http',
      url: 'http://127.0.0.1:9000/reload',
      method: 'POST',
      confirm: false,
      source: 'manual'
    });

    expect(ok).toBe(false);
    expect(messages.error[0]).toContain('abort: timeout');

    manager.dispose();
  });

  it('falls back to the vscode command registry when no command runner is injected', async () => {
    const received: unknown[][] = [];
    const registration = stubCommands.registerCommand('kbengine.test.quickAction', (...args: unknown[]) => {
      received.push(args);
      return 'ok';
    });
    // 不注入 executeCommand:走真 vscode 分发链(命令已登记在上面)
    const deps = makeDeps();
    delete (deps as { executeCommand?: unknown }).executeCommand;
    const manager = new QuickActionManager(makeContext(), deps);
    const run = (manager as unknown as { run: (action: unknown) => Promise<boolean> }).run.bind(manager);

    const ok = await run({
      name: 'open-conf',
      type: 'command',
      command: 'kbengine.test.quickAction',
      args: ['${workspaceFolder}/Hero.def'],
      confirm: false,
      source: 'manual'
    });

    expect(ok).toBe(true);
    expect(received).toEqual([['/ws/Hero.def']]);
    expect(channelLines()).toContain('open-conf → ✓');
    registration.dispose();
    manager.dispose();
  });

  it('reports a failing vscode command backend', async () => {
    commandError = new Error('command not registered');
    const manager = new QuickActionManager(makeContext(), makeDeps());
    const run = (manager as unknown as { run: (action: unknown) => Promise<boolean> }).run.bind(manager);

    const ok = await run({
      name: 'restart',
      type: 'command',
      command: 'kbengine.server.restart',
      args: [],
      confirm: false,
      source: 'manual'
    });

    expect(ok).toBe(false);
    expect(commandRuns).toHaveLength(1);
    expect(messages.error[0]).toContain('command not registered');

    manager.dispose();
  });

  it('dispatches through the real command registry when no runner is injected', async () => {
    const seen: unknown[][] = [];
    const registration = vscode.commands.registerCommand('kbengine.test.quickAction', (...args: unknown[]) => {
      seen.push(args);
      return undefined;
    });
    const manager = new QuickActionManager(makeContext());
    const run = (manager as unknown as { run: (action: unknown) => Promise<boolean> }).run.bind(manager);

    const ok = await run({
      name: 'noop',
      type: 'command',
      command: 'kbengine.test.quickAction',
      args: ['baseapp'],
      confirm: false,
      source: 'manual'
    });

    expect(ok).toBe(true);
    expect(seen).toEqual([['baseapp']]);
    expect(channelLines()).toContain('noop → ✓');
    registration.dispose();
    manager.dispose();
  });

  it('aborts with a named-variable error and never touches the runner', async () => {
    const manager = new QuickActionManager(makeContext(), makeDeps());
    const run = (manager as unknown as { run: (action: unknown) => Promise<boolean> }).run.bind(manager);

    const ok = await run({
      name: 'badvar',
      type: 'script',
      script: '${workspaceFolder}/${unknown:x}/run.bat',
      background: false,
      confirm: false,
      source: 'manual'
    });

    expect(ok).toBe(false);
    expect(scriptRuns).toHaveLength(0);
    expect(messages.error[0]).toContain('变量无法解析');

    manager.dispose();
  });

  it('asks for confirmation by default and honours confirm:false', async () => {
    const manager = new QuickActionManager(makeContext(), makeDeps());
    const run = (manager as unknown as { run: (action: unknown) => Promise<boolean> }).run.bind(manager);

    confirmAnswers.push(undefined);
    const cancelled = await run({
      name: 'restart',
      type: 'command',
      command: 'kbengine.server.restart',
      args: [],
      confirm: true,
      source: 'manual'
    });
    expect(cancelled).toBe(false);
    expect(commandRuns).toHaveLength(0);
    expect(confirmCalls).toHaveLength(1);

    const direct = await run({
      name: 'restart',
      type: 'command',
      command: 'kbengine.server.restart',
      args: [],
      confirm: false,
      source: 'manual'
    });
    expect(direct).toBe(true);
    expect(commandRuns).toHaveLength(1);
    expect(confirmCalls).toHaveLength(1);

    manager.dispose();
  });
});

describe('QuickActionManager.offerScanOnActivate', () => {
  it('does nothing without a workspace folder', async () => {
    stubWorkspace.workspaceFolders = [];
    const manager = new QuickActionManager(makeContext(), makeDeps());

    await manager.offerScanOnActivate();

    expect(pickCalls).toHaveLength(0);
    manager.dispose();
  });

  it('does nothing when actions are already configured', async () => {
    setConfig({ quickActions: [{ name: 'keep', type: 'command', command: 'kbengine.refreshExplorer' }] });
    memoryFileSystem.setDirectory('/ws', [['start.bat', 1]]);
    const manager = new QuickActionManager(makeContext(), makeDeps());

    await manager.offerScanOnActivate();

    expect(pickCalls).toHaveLength(0);
    manager.dispose();
  });

  it('does nothing when the dismissal was remembered', async () => {
    memento.set('kbengine.quickActions.scanDismissed', true);
    memoryFileSystem.setDirectory('/ws', [['start.bat', 1]]);
    const manager = new QuickActionManager(makeContext(), makeDeps());

    await manager.offerScanOnActivate();

    expect(pickCalls).toHaveLength(0);
    manager.dispose();
  });

  it('does nothing when no bat script matches the word list', async () => {
    memoryFileSystem.setDirectory('/ws', [['readme.txt', 1]]);
    const manager = new QuickActionManager(makeContext(), makeDeps());

    await manager.offerScanOnActivate();

    expect(pickCalls).toHaveLength(0);
    expect(memento.has('kbengine.quickActions.scanDismissed')).toBe(false);
    manager.dispose();
  });

  it('does nothing when the workspace directory cannot be read', async () => {
    const manager = new QuickActionManager(makeContext(), makeDeps());

    await manager.offerScanOnActivate();

    expect(pickCalls).toHaveLength(0);
    manager.dispose();
  });

  it('treats a context without memento as a first run', async () => {
    const context = makeContext() as unknown as { subscriptions: unknown[] };
    delete (context as { workspaceState?: unknown }).workspaceState;
    memoryFileSystem.setDirectory('/ws', [['start_server.bat', 1]]);
    pickAnswers.push([]);
    const manager = new QuickActionManager(context as never, makeDeps());

    await manager.offerScanOnActivate();

    expect(pickCalls).toHaveLength(1);
    expect(memento.has('kbengine.quickActions.scanDismissed')).toBe(false);
    manager.dispose();
  });

  it('remembers the dismissal when the user cancels the confirmation list', async () => {
    memoryFileSystem.setDirectory('/ws', [['start_server.bat', 1], ['convert.bat', 1]]);
    pickAnswers.push(undefined);
    const manager = new QuickActionManager(makeContext(), makeDeps());

    await manager.offerScanOnActivate();

    expect(pickCalls[0].options).toMatchObject({ canPickMany: true });
    expect(memento.get('kbengine.quickActions.scanDismissed')).toBe(true);
    expect(memoryFileSystem.files.has('/ws/.kbengine/debug.json')).toBe(false);
    manager.dispose();
  });

  it('writes the selected scripts into the config file and keeps the debug section', async () => {
    setConfig({ version: '1.0.0', debug: { defaultTelnetHost: '127.0.0.1' } });
    memoryFileSystem.setDirectory('/ws', [['start_server.bat', 1], ['convert.bat', 1]]);
    pickAnswers.push([
      { label: 'start_server.bat', value: { path: '/ws/start_server.bat', category: 'server' } },
      { label: 'convert.bat', value: { path: '/ws/convert.bat', category: 'export' } }
    ]);
    const manager = new QuickActionManager(makeContext(), makeDeps());

    await manager.offerScanOnActivate();

    const written = JSON.parse(
      Buffer.from(memoryFileSystem.files.get('/ws/.kbengine/debug.json') ?? '').toString('utf8')
    );
    expect(written.version).toBe('1.0.0');
    expect(written.debug).toEqual({ defaultTelnetHost: '127.0.0.1' });
    expect(written.quickActions).toEqual([
      {
        name: 'start_server',
        type: 'script',
        script: '${workspaceFolder}/start_server.bat',
        background: true,
        confirm: true,
        source: 'scan',
        category: 'server'
      },
      {
        name: 'convert',
        type: 'script',
        script: '${workspaceFolder}/convert.bat',
        background: false,
        confirm: true,
        source: 'scan',
        category: 'export'
      }
    ]);
    expect(messages.info[0]).toBe('已写入 2 个快速执行动作到 .kbengine/debug.json');

    manager.dispose();
  });

  it('writes a fresh config file when none exists yet', async () => {
    memoryFileSystem.setDirectory('/ws', [['BOOT.bat', 1]]);
    pickAnswers.push([{ label: 'BOOT.bat', value: { path: '/ws/BOOT.bat', category: 'server' } }]);
    const manager = new QuickActionManager(makeContext(), makeDeps());

    await manager.offerScanOnActivate();

    const written = JSON.parse(
      Buffer.from(memoryFileSystem.files.get('/ws/.kbengine/debug.json') ?? '').toString('utf8')
    );
    expect(written.quickActions).toEqual([
      {
        name: 'BOOT',
        type: 'script',
        script: '${workspaceFolder}/BOOT.bat',
        background: true,
        confirm: true,
        source: 'scan',
        category: 'server'
      }
    ]);
    manager.dispose();
  });
});

describe('QuickActionManager.dispose', () => {
  it('disposes the output channel', () => {
    const manager = new QuickActionManager(makeContext(), makeDeps());
    manager.dispose();

    const channel = windowState.channels.find(entry => entry.name === 'KBEngine 快速执行动作');
    expect(channel?.disposed).toBe(true);
  });

  it('closes the channel through the context subscription too', () => {
    // 扩展卸载时走 subscriptions 链而不是显式 dispose,两条路都得收口
    const context = makeContext();
    new QuickActionManager(context, makeDeps());

    for (const subscription of context.subscriptions) {
      subscription.dispose();
    }

    const channel = windowState.channels.find(entry => entry.name === 'KBEngine 快速执行动作');
    expect(channel?.disposed).toBe(true);
  });

  it('is reached through the extension subscription chain', () => {
    const context = makeContext();
    new QuickActionManager(context, makeDeps());

    for (const subscription of context.subscriptions) {
      subscription.dispose();
    }

    const channel = windowState.channels.find(entry => entry.name === 'KBEngine 快速执行动作');
    expect(channel?.disposed).toBe(true);
  });
});
