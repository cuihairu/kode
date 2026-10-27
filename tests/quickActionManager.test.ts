import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { QuickActionManager, terminalScript } from '../src/quickActions';
import { QuickActionTreeProvider } from '../src/quickActionTree';
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

const scriptRuns: Array<{ name?: string; script: string; cwd?: string; background: boolean }> = [];
const scriptEnvs: Array<NodeJS.ProcessEnv | undefined> = [];
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
    scriptEnvs.push(options.env);
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
  scriptEnvs.length = 0;
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
  it('merges debug and settings HTTP rows, hides setting-disabled and gives settings duplicate priority', async () => {
    setConfig({ httpRequests: [
      { name: 'debug-only', method: 'POST', url: 'http://debug/only', body: 'd' },
      { name: 'collision', method: 'GET', url: 'http://debug/collision' }
    ] });
    const manager = new QuickActionManager(makeContext(), {
      ...makeDeps(),
      getSettingHttpEntries: () => [
        { name: 'setting-only', method: 'PUT', url: 'http://settings/only', body: 's', headers: {}, enabled: true, keybinding: '' },
        { name: 'collision', method: 'PATCH', url: 'http://settings/collision', body: '', headers: {}, enabled: true, keybinding: '' },
        { name: 'off', method: 'GET', url: 'http://settings/off', body: '', headers: {}, enabled: false, keybinding: '' }
      ]
    });
    const rows = (await manager.getTreeData()).httpRequests;
    expect(rows.map(row => [row.name, row.requestSource, row.requestIndex, row.target])).toEqual([
      ['debug-only', 'debug', 0, 'http://debug/only'],
      ['setting-only', 'settings', 0, 'http://settings/only'],
      ['collision', 'settings', 1, 'http://settings/collision']
    ]);
    expect(rows).toHaveLength(3);
    const provider = new QuickActionTreeProvider({ getActions: async () => ({ registered: [], scripts: [], httpRequests: rows }) });
    const [group] = await provider.getChildren();
    expect(group.label).toBe('已登记 0');
    expect((await provider.getChildren())[2].label).toBe('HTTP 请求 3');
    const httpRows = await provider.getChildren((await provider.getChildren())[2]);
    expect(httpRows[0].tooltip).toContain('来源：.kbengine/debug.json');
    expect(httpRows[1].tooltip).toContain('来源：kbengine.httpRequests 设置');
  });

  it('routes settings source plus original index to the shared HTTP service entry', async () => {
    const received: Array<{ name: string; url: string }> = [];
    const manager = new QuickActionManager(makeContext(), {
      ...makeDeps(),
      getSettingHttpEntries: () => [
        { name: 'first', method: 'GET', url: 'http://settings/first', body: '', headers: {}, enabled: true, keybinding: '' },
        { name: 'second', method: 'POST', url: 'http://settings/second', body: '{"x":2}', headers: {}, enabled: true, keybinding: '' }
      ],
      runHttpEntry: async entry => { received.push({ name: entry.name, url: entry.url }); return true; }
    });
    await expect(manager.runByName('@http:settings:1')).resolves.toBe(true);
    expect(received).toEqual([{ name: 'second', url: 'http://settings/second' }]);
  });

  it('tells the user where to configure when no actions exist', async () => {
    const manager = new QuickActionManager(makeContext(), makeDeps());

    await manager.show();

    expect(messages.info[0]).toContain('未配置快速执行动作');
    expect(messages.info[0]).toContain('.kbengine/debug.json');
    expect(pickCalls).toHaveLength(0);

  });

  it('shows the same hint when no workspace folder is open', async () => {
    stubWorkspace.workspaceFolders = undefined as unknown as Array<{ uri: Uri; name: string; index: number }>;
    const manager = new QuickActionManager(makeContext(), makeDeps());

    await manager.show();

    expect(messages.info[0]).toContain('未配置快速执行动作');
    expect(pickCalls).toHaveLength(0);

  });

  it('background 非布尔:show() 播报告警且动作保留清单照常(2026-10-27 ①)', async () => {
    setConfig({ quickActions: [
      { name: '起服', type: 'script', script: 'start_server.bat', background: 'true' }
    ] });
    const manager = new QuickActionManager(makeContext(), makeDeps());
    pickAnswers.push(undefined);

    await manager.show();

    expect(messages.warning[0]).toContain('「起服」');
    expect(messages.warning[0]).toContain('不带引号');
    // 条目保留:清单照常给出(取消不执行),工作流不断
    expect(pickCalls).toHaveLength(1);
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
        detail: '/ws/start_server.bat'
      })
    ]);
    expect(scriptRuns).toEqual([
      { name: 'start_server', script: '/ws/start_server.bat', background: false, cwd: '/ws' }
    ]);

  });

  it('shows real commands and middle-truncates long targets while preserving the script name', async () => {
    const longRoot = '/workspace/'.concat(Array.from({ length: 24 }, (_, index) => `very-long-directory-${index}`).join('/'));
    const longScript = `${longRoot}/launch_dedicated_server_with_every_option.sh --environment production --port 28015 --region north-america`;
    setConfig({ quickActions: [
      { name: '启动服务器', type: 'script', script: 'scripts/start_server.sh --env dev', confirm: false },
      { name: '启动专服', type: 'script', script: longScript, confirm: false }
    ] });
    pickAnswers.push(undefined);
    const manager = new QuickActionManager(makeContext(), makeDeps());

    await manager.show();

    const items = pickCalls[0].items.filter(item => item.kind !== vscode.QuickPickItemKind.Separator);
    expect(items[0]).toMatchObject({ label: '启动服务器', detail: 'scripts/start_server.sh --env dev' });
    expect(items[1].detail).toContain('...');
    expect(items[1].detail).toContain('launch_dedicated_server_with_every_option.sh');
    expect(items[1].detail).not.toContain('very-long-directory-3/very-long-directory-4');
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

  });

  it('treats an unreadable config file as no actions', async () => {
    memoryFileSystem.set('/ws/.kbengine/debug.json', '{broken json');
    const manager = new QuickActionManager(makeContext(), makeDeps());

    await manager.show();

    expect(messages.info[0]).toContain('未配置快速执行动作');
    expect(pickCalls).toHaveLength(0);

  });

  it('treats an editor without any workspace folder as no actions', async () => {
    // 真 vscode 在未开文件夹时给的是 undefined 而不是空数组
    stubWorkspace.workspaceFolders = undefined as unknown as typeof stubWorkspace.workspaceFolders;
    const manager = new QuickActionManager(makeContext(), makeDeps());

    await manager.show();

    expect(messages.info[0]).toContain('未配置快速执行动作');
    expect(pickCalls).toHaveLength(0);

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

  });

  it('runs the first action when nothing was run before', async () => {
    setConfig({
      quickActions: [
        { name: 'restart', type: 'command', command: 'kbengine.server.restart', confirm: false },
        { name: 'refresh', type: 'command', command: 'kbengine.refreshExplorer', confirm: false }
      ]
    });
    pickAnswers.push({ label: 'restart' });
    const manager = new QuickActionManager(makeContext(), makeDeps());

    await manager.runDefault();

    expect(commandRuns).toEqual([{ command: 'kbengine.server.restart', args: [] }]);
    expect(memento.get('kbengine.quickActions.lastRun')).toBe('restart');
    expect(pickCalls[0].options?.placeHolder).toContain('kbengine.server.restart');

  });

  it('runs the action remembered from a previous pick', async () => {
    setConfig({
      quickActions: [
        { name: 'restart', type: 'command', command: 'kbengine.server.restart', confirm: false },
        { name: 'refresh', type: 'command', command: 'kbengine.refreshExplorer', confirm: false }
      ]
    });
    memento.set('kbengine.quickActions.lastRun', 'refresh');
    pickAnswers.push({ label: 'refresh' });
    const manager = new QuickActionManager(makeContext(), makeDeps());

    await manager.runDefault();

    expect(commandRuns).toEqual([{ command: 'kbengine.refreshExplorer', args: [] }]);

  });

  it('falls back to the first action when the remembered one is gone', async () => {
    setConfig({
      quickActions: [{ name: 'restart', type: 'command', command: 'kbengine.server.restart', confirm: false }]
    });
    memento.set('kbengine.quickActions.lastRun', 'removed');
    pickAnswers.push({ label: 'restart' });
    const manager = new QuickActionManager(makeContext(), makeDeps());

    await manager.runDefault();

    expect(commandRuns).toEqual([{ command: 'kbengine.server.restart', args: [] }]);

  });

  it('still runs the first action without a workspace state host', async () => {
    // 极简装配上下文(嵌入/烟测替身)没有 workspaceState:执行照常,只是不记忆
    setConfig({
      quickActions: [{ name: 'restart', type: 'command', command: 'kbengine.server.restart', confirm: false }]
    });
    pickAnswers.push({ label: 'restart' });
    const manager = new QuickActionManager(
      { subscriptions: [] } as unknown as vscode.ExtensionContext,
      makeDeps()
    );

    await manager.runDefault();

    expect(commandRuns).toEqual([{ command: 'kbengine.server.restart', args: [] }]);

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
    expect(scriptRuns).toEqual([{ name: 'stop_all', script: '/ws/stop.bat', background: false, cwd: undefined }]);

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
    expect(scriptRuns).toEqual([{ name: 'start_server', script: '/ws/start.bat', background: true, cwd: undefined }]);

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
    expect(messages.error[0]).toBe('执行快速动作失败: boot (exit 3)');

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
    expect(messages.error[0]).toContain('spawn ENOENT');

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
      { name: 'export_tables', script: '/ws/export_tables.bat', background: false, cwd: '/ws/tools' }
    ]);

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
    expect(messages.error[0]).toBe('执行快速动作失败: stop_all (exit 未知)');

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
    expect(messages.error[0]).toBe('spawn threw a string');

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
    expect(messages.error[0]).toBe('执行快速动作失败: hotfix (HTTP 500)');

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
    registration.dispose();

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
    registration.dispose();

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

  });
});

describe('QuickActionManager.runByName(自动热重载按名触发)', () => {
  const runByName = (
    manager: QuickActionManager,
    name: string,
    options?: { suppressConfirm?: boolean; skipLastRun?: boolean }
  ): Promise<boolean> =>
    (manager as unknown as { runByName: (n: string, o?: unknown) => Promise<boolean> }).runByName(
      name,
      options
    );

  it('按名命中即执行,suppressConfirm 跳过确认框', async () => {
    setConfig({
      quickActions: [{ name: '热更', type: 'command', command: 'kbengine.server.restart', args: [] }]
    });
    const manager = new QuickActionManager(makeContext(), makeDeps());

    const ok = await runByName(manager, '热更', { suppressConfirm: true });

    expect(ok).toBe(true);
    expect(confirmCalls).toHaveLength(0);
    expect(commandRuns).toEqual([{ command: 'kbengine.server.restart', args: [] }]);

  });

  it('未传 suppressConfirm 时按动作自身的 confirm 弹确认框', async () => {
    setConfig({
      quickActions: [{ name: '重启', type: 'command', command: 'kbengine.server.restart', args: [] }]
    });
    const manager = new QuickActionManager(makeContext(), makeDeps());

    const ok = await runByName(manager, '重启');

    expect(ok).toBe(false);
    expect(confirmCalls).toHaveLength(1);
    expect(commandRuns).toHaveLength(0);

  });

  it('skipLastRun 不写 lastRun 记忆,默认仍写', async () => {
    setConfig({
      quickActions: [{ name: '热更', type: 'command', command: 'kbengine.server.restart', args: [] }]
    });
    const manager = new QuickActionManager(makeContext(), makeDeps());

    await runByName(manager, '热更', { suppressConfirm: true, skipLastRun: true });
    expect(memento.get('kbengine.quickActions.lastRun')).toBeUndefined();

    await runByName(manager, '热更', { suppressConfirm: true });
    expect(memento.get('kbengine.quickActions.lastRun')).toBe('热更');

  });

  it('找不到名字:只记 OUTPUT 流水,不弹窗不打扰', async () => {
    setConfig({
      quickActions: [{ name: '热更', type: 'command', command: 'kbengine.server.restart', args: [] }]
    });
    const manager = new QuickActionManager(makeContext(), makeDeps());

    const ok = await runByName(manager, '不存在的热更');

    expect(ok).toBe(false);
    expect(confirmCalls).toHaveLength(0);
    expect(commandRuns).toHaveLength(0);
    expect(messages.error).toHaveLength(0);
    expect(messages.info).toHaveLength(0);

  });

  it('空名字直接返回,不读配置也不落流水', async () => {
    const manager = new QuickActionManager(makeContext(), makeDeps());

    const ok = await runByName(manager, '');

    expect(ok).toBe(false);
    expect(commandRuns).toHaveLength(0);
    expect(confirmCalls).toHaveLength(0);

  });
});

describe('QuickActionManager.offerScanOnActivate', () => {
  it('does nothing without a workspace folder', async () => {
    stubWorkspace.workspaceFolders = [];
    const manager = new QuickActionManager(makeContext(), makeDeps());

    await manager.offerScanOnActivate();

    expect(pickCalls).toHaveLength(0);

  });

  it('does nothing when actions are already configured', async () => {
    setConfig({ quickActions: [{ name: 'keep', type: 'command', command: 'kbengine.refreshExplorer' }] });
    memoryFileSystem.setDirectory('/ws', [['start.bat', 1]]);
    const manager = new QuickActionManager(makeContext(), makeDeps());

    await manager.offerScanOnActivate();

    expect(pickCalls).toHaveLength(0);

  });

  it('does nothing when the dismissal was remembered', async () => {
    memento.set('kbengine.quickActions.scanDismissed', true);
    memoryFileSystem.setDirectory('/ws', [['start.bat', 1]]);
    const manager = new QuickActionManager(makeContext(), makeDeps());

    await manager.offerScanOnActivate();

    expect(pickCalls).toHaveLength(0);

  });

  it('does nothing when no bat script matches the word list', async () => {
    memoryFileSystem.setDirectory('/ws', [['readme.txt', 1]]);
    const manager = new QuickActionManager(makeContext(), makeDeps());

    await manager.offerScanOnActivate();

    expect(pickCalls).toHaveLength(0);
    expect(memento.has('kbengine.quickActions.scanDismissed')).toBe(false);

  });

  it('does nothing when the workspace directory cannot be read', async () => {
    const manager = new QuickActionManager(makeContext(), makeDeps());

    await manager.offerScanOnActivate();

    expect(pickCalls).toHaveLength(0);

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

  });

  it('remembers the dismissal when the user cancels the confirmation list', async () => {
    memoryFileSystem.setDirectory('/ws', [['start_server.bat', 1], ['convert.bat', 1]]);
    pickAnswers.push(undefined);
    const manager = new QuickActionManager(makeContext(), makeDeps());

    await manager.offerScanOnActivate();

    expect(pickCalls[0].options).toMatchObject({ canPickMany: true });
    expect(memento.get('kbengine.quickActions.scanDismissed')).toBe(true);
    expect(memoryFileSystem.files.has('/ws/.kbengine/debug.json')).toBe(false);

  });

  it('lists .bat/.ps1 outside the word list when the config has no quickActions', async () => {
    setConfig({ version: '1.0.0', debug: {} });
    memoryFileSystem.setDirectory('/ws', [['build.ps1', 1], ['docs-dev.bat', 1], ['readme.txt', 1]]);
    pickAnswers.push([]);
    const manager = new QuickActionManager(makeContext(), makeDeps());

    await manager.offerScanOnActivate();

    expect(pickCalls).toHaveLength(1);
    expect(pickCalls[0].items.map(item => item.label)).toEqual(['build.ps1', 'docs-dev.bat']);
    expect(pickCalls[0].items.map(item => item.description)).toEqual(['', '']);
    // 取消后不写配置、记住不再弹(与既有口径一致)
    const untouched = JSON.parse(
      Buffer.from(memoryFileSystem.files.get('/ws/.kbengine/debug.json') ?? '').toString('utf8')
    );
    expect(untouched.quickActions).toBeUndefined();
    expect(memento.get('kbengine.quickActions.scanDismissed')).toBe(true);

  });

  it('writes a selected .ps1 without a category field', async () => {
    setConfig({ version: '1.0.0', debug: {} });
    memoryFileSystem.setDirectory('/ws', [['build.ps1', 1]]);
    pickAnswers.push([
      { label: 'build.ps1', value: { path: '/ws/build.ps1', category: null } }
    ]);
    const manager = new QuickActionManager(makeContext(), makeDeps());

    await manager.offerScanOnActivate();

    const written = JSON.parse(
      Buffer.from(memoryFileSystem.files.get('/ws/.kbengine/debug.json') ?? '').toString('utf8')
    );
    expect(written.quickActions).toEqual([
      {
        name: 'build',
        type: 'script',
        script: '${workspaceFolder}/build.ps1',
        cwd: '${workspaceFolder}',
        background: false,
        confirm: true,
        source: 'scan'
      }
    ]);
    expect(written.quickActions[0]).not.toHaveProperty('category');
    expect(messages.info[0]).toBe('已写入 1 个快速执行动作到 .kbengine/debug.json');

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
        cwd: '${workspaceFolder}',
        background: true,
        confirm: true,
        source: 'scan',
        category: 'server'
      },
      {
        name: 'convert',
        type: 'script',
        script: '${workspaceFolder}/convert.bat',
        cwd: '${workspaceFolder}',
        background: false,
        confirm: true,
        source: 'scan',
        category: 'export'
      }
    ]);
    expect(messages.info[0]).toBe('已写入 2 个快速执行动作到 .kbengine/debug.json');

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
        cwd: '${workspaceFolder}',
        background: true,
        confirm: true,
        source: 'scan',
        category: 'server'
      }
    ]);

  });
});

describe('QuickActionManager.scanScriptsAndRefresh', () => {
  it('lists unregistered scan results and runs a clicked script without waiting for registration', async () => {
    memoryFileSystem.setDirectory('/ws', [['cleanup.bat', 1]]);
    const terminalCalls: unknown[][] = [];
    const originalCreateTerminal = stubWindow.createTerminal;
    stubWindow.createTerminal = ((options: unknown) => {
      terminalCalls.push([options]);
      return { sendText: (...args: unknown[]) => terminalCalls.push(args) } as never;
    }) as never;
    const manager = new QuickActionManager(makeContext(), { runScript: terminalScript });
    const data = await manager.getTreeData();
    expect(data.scripts).toEqual([{ name: 'cleanup.bat', type: 'script', target: '/ws/cleanup.bat', runDirect: true }]);

    try {
      await manager.runScannedScript('/ws/cleanup.bat');
      expect(terminalCalls).toEqual([
        [{ name: 'Kode: cleanup · cleanup.bat', cwd: '/ws', hideFromUser: true }],
        [expect.stringContaining('即将执行：/ws/cleanup.bat'), true],
        ['/ws/cleanup.bat', true]
      ]);
      expect(messages.info.some(message => String(message).includes('是否登记'))).toBe(true);
      expect(memoryFileSystem.files.has('/ws/.kbengine/debug.json')).toBe(false);
    } finally {
      stubWindow.createTerminal = originalCreateTerminal;
    }
  });

  it('scans the effective config root and assetsRoot, preserves manual actions, and writes to that config root', async () => {
    memoryFileSystem.set('/repo/server/.kbengine/debug.json', JSON.stringify({
      version: 1,
      debug: { defaultTelnetHost: 'localhost' },
      quickActions: [{ name: 'manual', type: 'command', command: 'kbengine.refreshExplorer' }]
    }));
    memoryFileSystem.setDirectory('/repo/server', [['local.bat', 1]]);
    memoryFileSystem.setDirectory('/outside/assets', [['export_tables.ps1', 1]]);
    const manager = new QuickActionManager(makeContext(), makeDeps());
    manager.setConfigurationRoots('/repo/server', ['/outside/assets']);
    pickAnswers.push([{ label: 'export_tables.ps1', value: { path: '/outside/assets/export_tables.ps1', category: 'export' } }]);

    await manager.scanScriptsAndRefresh();

    const written = JSON.parse(Buffer.from(
      memoryFileSystem.files.get('/repo/server/.kbengine/debug.json') ?? ''
    ).toString('utf8'));
    expect(written.debug).toEqual({ defaultTelnetHost: 'localhost' });
    expect(written.quickActions.map((action: { name: string }) => action.name)).toEqual(['manual', 'export_tables']);
    expect(written.quickActions[1]).toMatchObject({
      script: '${workspaceFolder}/../../outside/assets/export_tables.ps1',
      cwd: '${workspaceFolder}/../../outside/assets'
    });

  });
});

describe('QuickActionManager venv', () => {
  it('adds the selected virtual environment to the child process environment', async () => {
    const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'kode-venv-'));
    const venvPath = path.join(tempRoot, '.venv');
    mkdirSync(path.join(venvPath, 'bin'), { recursive: true });
    try {
      const manager = new QuickActionManager(makeContext(), makeDeps());
      const run = (manager as unknown as { run: (action: unknown) => Promise<boolean> }).run.bind(manager);
      const ok = await run({
        name: 'task', type: 'script', script: '${workspaceFolder}/task.bat', cwd: '${workspaceFolder}',
        background: false, confirm: false, source: 'manual', venv: { enabled: true, path: venvPath }
      });
      expect(ok).toBe(true);
      expect(scriptEnvs[0]?.VIRTUAL_ENV).toBe(venvPath);
      expect(scriptEnvs[0]?.PATH?.split(path.delimiter)[0]).toBe(path.join(venvPath, 'bin'));

    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
