import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DebugConfigManager } from '../src/debugConfig';
import type * as vscode from 'vscode';
import {
  memoryFileSystem,
  window as stubWindow,
  workspace as stubWorkspace,
  Uri
} from './helpers/vscodeStub';

// DebugConfigManager 的配置 watcher 生命周期:watchConfig 挂载的
// onDidChange/onDidCreate/onDidDelete 三回调(重载配置+提示消息)、
// getConfig 读取、dispose 拆除。createFileSystemWatcher 用记录型假例
// 替换,配置文件走 stub 内存 fs。

interface FakeWatcher {
  pattern: string;
  disposeCalls: number;
  onDidChange(listener: () => void): { dispose(): void };
  onDidCreate(listener: () => void): { dispose(): void };
  onDidDelete(listener: () => void): { dispose(): void };
  dispose(): void;
  fireChange(): void;
  fireCreate(): void;
  fireDelete(): void;
}

const makeFakeWatcher = (pattern: string): FakeWatcher => {
  const changeListeners: Array<() => void> = [];
  const createListeners: Array<() => void> = [];
  const deleteListeners: Array<() => void> = [];
  const watcher: FakeWatcher = {
    pattern,
    disposeCalls: 0,
    onDidChange(listener) {
      changeListeners.push(listener);
      return { dispose: () => void changeListeners.splice(changeListeners.indexOf(listener), 1) };
    },
    onDidCreate(listener) {
      createListeners.push(listener);
      return { dispose: () => void createListeners.splice(createListeners.indexOf(listener), 1) };
    },
    onDidDelete(listener) {
      deleteListeners.push(listener);
      return { dispose: () => void deleteListeners.splice(deleteListeners.indexOf(listener), 1) };
    },
    dispose(): void {
      watcher.disposeCalls += 1;
    },
    fireChange(): void {
      for (const listener of [...changeListeners]) {
        listener();
      }
    },
    fireCreate(): void {
      for (const listener of [...createListeners]) {
        listener();
      }
    },
    fireDelete(): void {
      for (const listener of [...deleteListeners]) {
        listener();
      }
    }
  };
  return watcher;
};

const windowish = stubWindow as unknown as Record<string, unknown>;
const originalInfo = windowish.showInformationMessage;
const originalWarning = windowish.showWarningMessage;
const originalCreateWatcher = stubWorkspace.createFileSystemWatcher;

const watchers: FakeWatcher[] = [];
const infoMessages: string[] = [];
const warningMessages: string[] = [];

const configUri = (): Uri => Uri.file('/tmp/kode-dbg-watcher/.kbengine/debug.json');

const writeConfig = async (debug: Record<string, unknown>): Promise<void> => {
  await stubWorkspace.fs.writeFile(configUri(), Buffer.from(JSON.stringify({ debug }), 'utf8'));
};

const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 60));

const until = async (condition: () => boolean, what: string): Promise<void> => {
  for (let i = 0; i < 300; i += 1) {
    if (condition()) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`timeout waiting for ${what}`);
};

const makeManager = (): DebugConfigManager => {
  const manager = new DebugConfigManager({ subscriptions: [] } as unknown as vscode.ExtensionContext);
  return manager;
};

beforeEach(() => {
  memoryFileSystem.reset();
  watchers.length = 0;
  infoMessages.length = 0;
  warningMessages.length = 0;
  stubWorkspace.workspaceFolders = [{ uri: Uri.file('/tmp/kode-dbg-watcher'), name: 'ws', index: 0 }];
  stubWorkspace.createFileSystemWatcher = ((pattern: string) => {
    const watcher = makeFakeWatcher(pattern);
    watchers.push(watcher);
    return watcher;
  }) as unknown as typeof stubWorkspace.createFileSystemWatcher;
  windowish.showInformationMessage = async (message: string) => {
    infoMessages.push(message);
    return undefined;
  };
  windowish.showWarningMessage = async (message: string) => {
    warningMessages.push(message);
    return undefined;
  };
});

afterEach(() => {
  stubWorkspace.createFileSystemWatcher = originalCreateWatcher;
  windowish.showInformationMessage = originalInfo;
  windowish.showWarningMessage = originalWarning;
  stubWorkspace.workspaceFolders = [];
});

const latestWatcher = (): FakeWatcher => watchers[watchers.length - 1];

describe('DebugConfigManager config watcher', () => {
  it('watches .kbengine/debug.json and reloads on change with an info message', async () => {
    const manager = makeManager();
    await settle();

    const watcher = latestWatcher();
    expect(watcher.pattern).toContain('.kbengine/debug.json');
    expect(manager.getConfig().defaultTelnetPort).toBe(0);

    await writeConfig({ defaultTelnetPort: 12345 });
    watcher.fireChange();
    await until(() => manager.getConfig().defaultTelnetPort === 12345, 'reload on change');

    expect(infoMessages).toContain('KBEngine 调试配置已更新');
  });

  it('reloads on create and reports the creation', async () => {
    const manager = makeManager();
    await settle();

    await writeConfig({ defaultTelnetHost: '10.0.0.8' });
    latestWatcher().fireCreate();
    await until(() => manager.getConfig().defaultTelnetHost === '10.0.0.8', 'reload on create');

    expect(infoMessages).toContain('KBEngine 调试配置已创建');
  });

  it('restores defaults on delete with a warning', async () => {
    const manager = makeManager();
    await settle();
    await writeConfig({ defaultTelnetPort: 4321 });
    latestWatcher().fireChange();
    await until(() => manager.getConfig().defaultTelnetPort === 4321, 'initial load');

    await stubWorkspace.fs.delete(configUri());
    latestWatcher().fireDelete();
    await until(() => manager.getConfig().defaultTelnetPort === 0, 'restore defaults');

    expect(warningMessages).toContain('KBEngine 调试配置已删除，已恢复默认配置');
  });

  it('disposes the watcher and the change emitter', async () => {
    const manager = makeManager();
    await settle();
    const watcher = latestWatcher();

    expect(() => manager.dispose()).not.toThrow();
    expect(watcher.disposeCalls).toBe(1);
  });
});
