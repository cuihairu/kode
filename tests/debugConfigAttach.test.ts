import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DebugConfigManager } from '../src/debugConfig';
import type * as vscode from 'vscode';
import {
  debug as stubDebug,
  memoryFileSystem,
  window as stubWindow,
  workspace as stubWorkspace,
  Uri
} from './helpers/vscodeStub';

// DebugConfigManager 的调试会话编排:startDebugging 的 modal 提示两分支
// (有/无 telnet 命令)、attachToComponent 的 PID 输入→DebugConfiguration
// 组装→vscode.debug.startDebugging、promptForProcessId 的输入校验链、
// createExampleConfig/updateLaunchJson 的写盘失败通道。配置装载与 launch
// 生成已由 debugConfig.test.ts 覆盖。

interface InputBoxOptions {
  prompt?: string;
  validateInput?: (value: string) => string | null;
}

const windowish = stubWindow as unknown as Record<string, unknown>;
const originalWindow: Record<string, unknown> = {};
const patchedKeys = [
  'showInputBox',
  'showInformationMessage',
  'showErrorMessage'
];

const inputs: Array<string | undefined> = [];
const inputOptions: InputBoxOptions[] = [];
const infoQueue: Array<string | undefined> = [];
const messages = { info: [] as string[], error: [] as string[] };

interface DebugCall {
  folder: unknown;
  config: Record<string, unknown>;
  result: boolean;
  throws: Error | null;
}

const debugCalls: DebugCall[] = [];
let debugResult = true;
let debugThrows: Error | null = null;

const makeManager = () =>
  new DebugConfigManager({ subscriptions: [] } as unknown as vscode.ExtensionContext);

const setWorkspaceAt = (fsPath: string | null): void => {
  stubWorkspace.workspaceFolders = fsPath
    ? [{ uri: Uri.file(fsPath), name: 'ws', index: 0 }]
    : [];
};

beforeAll(() => {
  for (const key of patchedKeys) {
    originalWindow[key] = windowish[key];
  }
  windowish.showInputBox = async (options?: InputBoxOptions): Promise<string | undefined> => {
    if (options) {
      inputOptions.push(options);
    }
    return inputs.shift();
  };
  windowish.showInformationMessage = async (message: string) => {
    messages.info.push(message);
    return infoQueue.shift();
  };
  windowish.showErrorMessage = async (message: string) => {
    messages.error.push(message);
    return undefined;
  };
  (stubDebug as unknown as Record<string, unknown>).startDebugging = async (
    folder: unknown,
    config: Record<string, unknown>
  ) => {
    if (debugThrows) {
      throw debugThrows;
    }
    debugCalls.push({ folder, config, result: debugResult, throws: null });
    return debugResult;
  };
});

afterAll(() => {
  for (const key of patchedKeys) {
    windowish[key] = originalWindow[key];
  }
  delete (stubDebug as unknown as Record<string, unknown>).startDebugging;
});

beforeEach(() => {
  memoryFileSystem.reset();
  setWorkspaceAt(null);
  inputs.length = 0;
  inputOptions.length = 0;
  infoQueue.length = 0;
  messages.info.length = 0;
  messages.error.length = 0;
  debugCalls.length = 0;
  debugResult = true;
  debugThrows = null;
});

describe('DebugConfigManager.startDebugging', () => {
  it('shows the modal briefing with telnet commands and attaches on confirm', async () => {
    setWorkspaceAt('/tmp/kode-dbg');
    const manager = makeManager();
    const config = manager.getComponentConfig('baseapp');
    infoQueue.push('继续附加');
    inputs.push('4321');

    const result = await manager.startDebugging('baseapp');

    expect(result).toBe(true);
    expect(messages.info).toHaveLength(1);
    const message = messages.info[0];
    expect(message).toContain('telnet 控制端口');
    expect(message).toContain(`telnet ${config.telnetHost} ${config.telnetPort}`);
    expect(message).toContain(`password: ${config.telnetPassword}`);
    expect(message).toContain(`default layer: ${config.telnetDefaultLayer}`);
    for (const command of config.telnetEnableCommands ?? []) {
      expect(message).toContain(command);
    }

    expect(debugCalls).toHaveLength(1);
    const attachConfig = debugCalls[0].config;
    expect(attachConfig.name).toBe('KBEngine: Python attach to baseapp');
    expect(attachConfig.request).toBe('attach');
    expect(attachConfig.processId).toBe(4321);
    expect(attachConfig.pathMappings).toEqual(config.pathMappings);
    expect(attachConfig.justMyCode).toBe(false);
  }, 8000);

  it('shows the short briefing when the component has no telnet commands', async () => {
    setWorkspaceAt('/tmp/kode-dbg');
    const manager = makeManager();
    const config = manager.getComponentConfig('cellapp');
    infoQueue.push(undefined);

    const result = await manager.startDebugging('cellapp');

    expect(result).toBe(false);
    expect(debugCalls).toHaveLength(0);
    expect(messages.info).toHaveLength(1);
    expect(messages.info[0]).toContain(`telnet ${config.telnetHost} ${config.telnetPort}`);
  }, 8000);

  it('propagates a false startDebugging result', async () => {
    setWorkspaceAt('/tmp/kode-dbg');
    const manager = makeManager();
    infoQueue.push('继续附加');
    inputs.push('77');
    debugResult = false;

    expect(await manager.startDebugging('loginapp')).toBe(false);
    expect(debugCalls).toHaveLength(1);
    expect(messages.error).toEqual([]);
  }, 8000);

  it('reports startDebugging failures through the error channel', async () => {
    setWorkspaceAt('/tmp/kode-dbg');
    const manager = makeManager();
    infoQueue.push('继续附加');
    inputs.push('77');
    debugThrows = new Error('no debugpy');

    const result = await manager.startDebugging('loginapp');

    expect(result).toBe(false);
    expect(messages.error).toEqual(['附加调试失败: Error: no debugpy']);
  }, 8000);
});

describe('DebugConfigManager.promptForProcessId', () => {
  it('rejects non numeric, zero and unsafe integer inputs', async () => {
    setWorkspaceAt('/tmp/kode-dbg');
    const manager = makeManager();
    infoQueue.push('继续附加');
    inputs.push(undefined);

    await manager.startDebugging('baseapp');

    const validate = inputOptions[0].validateInput;
    expect(validate?.('abc')).toBe('PID 必须是正整数');
    expect(validate?.('12x')).toBe('PID 必须是正整数');
    expect(validate?.('0')).toBe('PID 必须是有效的正整数');
    // 负号先被 /^\d+$/ 拦下,归入格式错误而非数值错误
    expect(validate?.('-5')).toBe('PID 必须是正整数');
    expect(validate?.('99999999999999999999')).toBe('PID 必须是有效的正整数');
    expect(validate?.('42')).toBeUndefined();
    expect(inputOptions[0].prompt).toContain('baseapp');
  }, 8000);

  it('aborts the attach when the pid prompt is cancelled', async () => {
    setWorkspaceAt('/tmp/kode-dbg');
    const manager = makeManager();
    inputs.push(undefined);
    infoQueue.push('继续附加');

    expect(await manager.startDebugging('baseapp')).toBe(false);
    expect(debugCalls).toHaveLength(0);
  }, 8000);

  it('attaches with the parsed pid when the input is valid', async () => {
    setWorkspaceAt('/tmp/kode-dbg');
    const manager = makeManager();
    inputs.push(' 9007 ');
    infoQueue.push('继续附加');

    expect(await manager.startDebugging('baseapp')).toBe(true);
    expect(debugCalls[0].config.processId).toBe(9007);
  }, 8000);
});

describe('DebugConfigManager write-failure channels', () => {
  it('reports example config write failures', async () => {
    setWorkspaceAt('/tmp/kode-dbg');
    const manager = makeManager();
    const originalWriteFile = stubWorkspace.fs.writeFile;
    stubWorkspace.fs.writeFile = async () => {
      throw new Error('read-only fs');
    };

    const result = await manager.createExampleConfig();
    stubWorkspace.fs.writeFile = originalWriteFile;

    expect(result).toBe(false);
    expect(messages.error[0]).toContain('创建调试配置失败');
    expect(messages.error[0]).toContain('read-only fs');
  });

  it('reports launch.json write failures', async () => {
    setWorkspaceAt('/tmp/kode-dbg');
    const manager = makeManager();
    const originalWriteFile = stubWorkspace.fs.writeFile;
    stubWorkspace.fs.writeFile = async () => {
      throw new Error('disk full');
    };

    const result = await manager.updateLaunchJson();
    stubWorkspace.fs.writeFile = originalWriteFile;

    expect(result).toBe(false);
    expect(messages.error[0]).toContain('更新 launch.json 失败');
    expect(messages.error[0]).toContain('disk full');
  });
});
