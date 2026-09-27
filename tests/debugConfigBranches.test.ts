import type * as vscode from 'vscode';
import * as path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DebugConfigManager } from '../src/debugConfig';
import type { DebugConfigFile } from '../src/debugConfig';
import { memoryFileSystem, window as stubWindow, debug as stubDebug, workspace as stubWorkspace, Uri } from './helpers/vscodeStub';

// DebugConfigManager 批68 分支补测:startDebugging 组装 telnet 简报时
// `config.telnetHost || '127.0.0.1'` 的假臂——用户配置把 defaultTelnetHost
// 与组件 telnetHost 同时置空串,经 getComponentConfig 归一化后仍为空串。
// `telnetPassword`/`telnetDefaultLayer` 的同形假臂契约性不可达
// (getComponentConfig 已做同款归一化,产出恒非空),已以精确单行区间
// ignore 定案,理由见源码注记与 TESTING.md 批68 段。

type ManagerInternals = DebugConfigManager & {
  config: { defaultTelnetHost: string };
};

const makeManager = (): ManagerInternals =>
  new DebugConfigManager({ subscriptions: [] } as unknown as vscode.ExtensionContext) as ManagerInternals;

const setWorkspaceAt = (fsPath: string | null): void => {
  stubWorkspace.workspaceFolders = fsPath
    ? [{ uri: Uri.file(fsPath), name: 'ws', index: 0 }]
    : [];
};

const flushAsync = () => new Promise<void>(resolve => setTimeout(resolve, 0));

interface UiState {
  inputs: Array<string | undefined>;
  infoQueue: Array<string | undefined>;
  info: string[];
  error: string[];
  debugCalls: Array<{ folder: unknown; config: Record<string, unknown> }>;
}

const ui: UiState = { inputs: [], infoQueue: [], info: [], error: [], debugCalls: [] };

const windowish = stubWindow as unknown as Record<string, unknown>;
const debugish = stubDebug as unknown as Record<string, unknown>;
const originalWindow: Record<string, unknown> = {};
const originalDebugStart = debugish.startDebugging;

beforeAll(() => {
  for (const key of ['showInputBox', 'showInformationMessage', 'showErrorMessage']) {
    originalWindow[key] = windowish[key];
  }
  windowish.showInputBox = async (): Promise<string | undefined> => ui.inputs.shift();
  windowish.showInformationMessage = async (message: string): Promise<unknown> => {
    ui.info.push(message);
    return ui.infoQueue.shift();
  };
  windowish.showErrorMessage = async (message: string): Promise<unknown> => {
    ui.error.push(message);
    return undefined;
  };
  debugish.startDebugging = async (folder: unknown, config: Record<string, unknown>) => {
    ui.debugCalls.push({ folder, config });
    return true;
  };
});

afterAll(() => {
  for (const [key, value] of Object.entries(originalWindow)) {
    windowish[key] = value;
  }
  if (originalDebugStart === undefined) {
    delete debugish.startDebugging;
  } else {
    debugish.startDebugging = originalDebugStart;
  }
});

beforeEach(() => {
  memoryFileSystem.reset();
  setWorkspaceAt(null);
  ui.inputs.length = 0;
  ui.infoQueue.length = 0;
  ui.info.length = 0;
  ui.error.length = 0;
  ui.debugCalls.length = 0;
});

afterEach(() => {
  memoryFileSystem.reset();
  setWorkspaceAt(null);
});

describe('startDebugging telnet briefing fallbacks (批68)', () => {
  it('renders an empty telnet host when the user config blanks it out', async () => {
    setWorkspaceAt('/proj');
    memoryFileSystem.set(
      path.join('/proj', '.kbengine', 'debug.json'),
      JSON.stringify({
        version: '1.0.0',
        debug: {
          defaultTelnetHost: '',
          components: {
            cellapp: { telnetHost: '' }
          }
        }
      } satisfies DebugConfigFile)
    );

    const manager = makeManager();
    await flushAsync();
    expect(manager.config.defaultTelnetHost).toBe('');

    ui.infoQueue.push('继续附加');
    ui.inputs.push('4321');

    const result = await manager.startDebugging('cellapp');

    expect(result).toBe(true);
    // getComponentConfig 归一化后 telnetHost 仍为空串(defaultTelnetHost 同为 '')
    expect(manager.getComponentConfig('cellapp').telnetHost).toBe('');
    expect(ui.info).toHaveLength(1);
    // 空串落入 `|| '127.0.0.1'` 右臂:简报里出现兜底主机名
    expect(ui.info[0]).toContain('telnet 127.0.0.1 0');
    expect(ui.debugCalls).toHaveLength(1);
  });
});
