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
// (有/无 telnet 命令)、attachToComponent 的 ${command:pickProcess}
// DebugConfiguration 组装→vscode.debug.startDebugging(批111 用户令:进程
// 选择改走 VS Code 内建进程选择器,不再手输 PID)、createExampleConfig/
// updateLaunchJson 的写盘失败通道。配置装载与 launch 生成已由
// debugConfig.test.ts 覆盖。

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

// 构造器内 loadConfig 是异步读盘,留一个宏任务节拍让它落地
const flushAsync = () => new Promise<void>(resolve => setTimeout(resolve, 0));

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
    // 批111 用户令:进程选择走 VS Code 内建进程选择器,不再手输 PID
    expect(attachConfig.processId).toBe('${command:pickProcess}');
    expect(attachConfig.pathMappings).toEqual(config.pathMappings);
    expect(attachConfig.justMyCode).toBe(false);
    // 选择器形态下扩展自身不再弹输入框
    expect(inputOptions).toHaveLength(0);
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

  it('lists configured telnet enable commands in the long briefing', async () => {
    setWorkspaceAt('/tmp/kode-dbg');
    memoryFileSystem.set(
      '/tmp/kode-dbg/.kbengine/debug.json',
      JSON.stringify({
        debug: {
          components: {
            baseapp: { telnetEnableCommands: ['layer 1', 'lookup 123'] }
          }
        }
      })
    );
    const manager = makeManager();
    await flushAsync();
    infoQueue.push(undefined);

    const result = await manager.startDebugging('baseapp');

    // 长 briefing 分支:逐条列出开启调试的 telnet 命令;看完即取消不进附加
    expect(result).toBe(false);
    expect(debugCalls).toHaveLength(0);
    const message = messages.info[0];
    expect(message).toContain('以 telnet 控制端口为前提');
    expect(message).toContain('telnet 127.0.0.1 0');
    expect(message).toContain('layer 1');
    expect(message).toContain('lookup 123');
  }, 8000);

  it('falls back to documented defaults for explicitly empty telnet fields', async () => {
    setWorkspaceAt('/tmp/kode-dbg');
    memoryFileSystem.set(
      '/tmp/kode-dbg/.kbengine/debug.json',
      JSON.stringify({
        debug: {
          components: {
            cellapp: { telnetHost: '', telnetPort: 0, telnetPassword: '', telnetDefaultLayer: '' }
          }
        }
      })
    );
    const manager = makeManager();
    await flushAsync();
    infoQueue.push(undefined);

    const result = await manager.startDebugging('cellapp');

    // 显式空值与缺省键同观感:主机/端口/密码/层级全部走文档默认
    expect(result).toBe(false);
    expect(messages.info[0]).toContain('telnet 127.0.0.1 0');
    expect(messages.info[0]).toContain('password: pwd123456');
    expect(messages.info[0]).toContain('default layer: python');
  }, 8000);

  it('uses the literal host fallback when the merged host is empty', async () => {
    setWorkspaceAt('/tmp/kode-dbg');
    // 合并层 defaultTelnetHost 置空串:getComponentConfig 吐出空主机,
    // 提示层的 '127.0.0.1' 字面量兜底由此可达
    memoryFileSystem.set(
      '/tmp/kode-dbg/.kbengine/debug.json',
      JSON.stringify({
        debug: {
          defaultTelnetHost: '',
          components: { cellapp: {} }
        }
      })
    );
    const manager = makeManager();
    await flushAsync();
    infoQueue.push(undefined);

    expect(await manager.startDebugging('cellapp')).toBe(false);
    expect(messages.info[0]).toContain('telnet 127.0.0.1 0');
  }, 8000);

  it('propagates a false startDebugging result', async () => {
    setWorkspaceAt('/tmp/kode-dbg');
    const manager = makeManager();
    infoQueue.push('继续附加');
    debugResult = false;

    expect(await manager.startDebugging('loginapp')).toBe(false);
    expect(debugCalls).toHaveLength(1);
    expect(messages.error).toEqual([]);
  }, 8000);

  it('reports startDebugging failures through the error channel', async () => {
    setWorkspaceAt('/tmp/kode-dbg');
    const manager = makeManager();
    infoQueue.push('继续附加');
    debugThrows = new Error('no debugpy');

    const result = await manager.startDebugging('loginapp');

    expect(result).toBe(false);
    expect(messages.error).toEqual(['附加调试失败: Error: no debugpy']);
  }, 8000);
});

describe('DebugConfigManager.attachToComponent (批111 pickProcess)', () => {
  it('attaches through the built-in process picker without any input box', async () => {
    setWorkspaceAt('/tmp/kode-dbg');
    const manager = makeManager();

    expect(await manager.attachToComponent('baseapp')).toBe(true);

    expect(debugCalls).toHaveLength(1);
    const attachConfig = debugCalls[0].config;
    expect(attachConfig.name).toBe('KBEngine: Python attach to baseapp');
    expect(attachConfig.type).toBe('debugpy');
    expect(attachConfig.request).toBe('attach');
    // ${command:pickProcess} 由 debugpy 解析弹出原生进程列表;取消选择时
    // debugpy 侧放弃会话,startDebugging 返回 false 即附加未发生
    expect(attachConfig.processId).toBe('${command:pickProcess}');
    expect(attachConfig.justMyCode).toBe(false);
    expect(inputOptions).toHaveLength(0);
  }, 8000);

  it('reports failures through the error channel', async () => {
    setWorkspaceAt('/tmp/kode-dbg');
    const manager = makeManager();
    debugThrows = new Error('no debugpy');

    expect(await manager.attachToComponent('cellapp')).toBe(false);
    expect(messages.error).toEqual(['附加调试失败: Error: no debugpy']);
  }, 8000);

  it('propagates a false startDebugging result without error spam', async () => {
    setWorkspaceAt('/tmp/kode-dbg');
    const manager = makeManager();
    debugResult = false;

    expect(await manager.attachToComponent('loginapp')).toBe(false);
    expect(debugCalls).toHaveLength(1);
    expect(messages.error).toEqual([]);
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
