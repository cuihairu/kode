// fake-vscode 工作区状态层(docs/redesign.md 阶段 3):workspace 对象的
// 状态化实现——内存文件系统、配置覆写、文档集合、三个可 fire 的工作区
// 事件、TextDocumentContentProvider 记账。tests/helpers/vscodeStub.ts
// re-export 本模块的 `workspace`,既有用例对它的 monkey-patch 语义不变
// (共享同一可变对象)。

import { EventEmitter, Uri } from './core';

// 内存文件系统:debugConfig 的 loadConfig/updateLaunchJson 等经
// workspace.fs 读写真实路径内容;文件不存在时按实现语义抛错(进 catch)。
const memoryFiles = new Map<string, Uint8Array>();

export const memoryFileSystem = {
  files: memoryFiles,
  reset: (): void => {
    memoryFiles.clear();
  },
  set: (fsPath: string, content: string): void => {
    memoryFiles.set(fsPath, Buffer.from(content, 'utf8'));
  }
};

// 按配置段覆写 getConfiguration 返回值(如 hover.showValueDocs=false);
// 未覆写的键回落到实现提供的默认值。
export const configurationOverrides = new Map<string, Record<string, unknown>>();

// entityMapping 的 watchPythonFiles 需要可观察的 watcher:记录回调并允许
// 测试主动 fire。
export interface StubFileSystemWatcher {
  onDidChange(listener: (uri: Uri) => void): { dispose(): void };
  onDidCreate(listener: (uri: Uri) => void): { dispose(): void };
  onDidDelete(listener: (uri: Uri) => void): { dispose(): void };
  dispose(): void;
  fireChange(uri: Uri): void;
}

export const lastFileSystemWatcher: { current: StubFileSystemWatcher | null } = {
  current: null
};

// extension.ts 装配链的三个工作区事件:测试经 workspaceEvents.fire 驱动
// (事件对象由测试构造,如 { affectsConfiguration: s => s === 'kbengine' })。
export const workspaceEvents = {
  documentChanged: new EventEmitter<{ document: unknown }>(),
  documentOpened: new EventEmitter<unknown>(),
  configurationChanged: new EventEmitter<{ affectsConfiguration: (section: string) => boolean }>()
};

// extension.ts 经 registerTextDocumentContentProvider 注册
// kbengine-db-schema 虚拟文档提供者;这里记账供装配断言与阶段 4 消费。
const textDocumentContentProviders = new Map<string, unknown>();

export const fs = {
  createDirectory: async (): Promise<void> => undefined,
  readFile: async (uri: Uri): Promise<Uint8Array> => {
    const data = memoryFiles.get(uri.fsPath);
    if (data === undefined) {
      throw new Error(`ENOENT: ${uri.fsPath}`);
    }
    return data;
  },
  writeFile: async (uri: Uri, content: Uint8Array): Promise<void> => {
    memoryFiles.set(uri.fsPath, content);
  },
  delete: async (uri: Uri): Promise<void> => {
    memoryFiles.delete(uri.fsPath);
  }
};

// openTextDocument 调用记账(kbengine.entity.open / kbengine.database.open
// 装配断言用);默认返回值与旧 stub 完全一致,测试可整体替换。
const openTextDocumentCalls: unknown[] = [];

export const workspace = {
  workspaceFolders: [] as Array<{ uri: Uri; name: string; index: number }>,
  textDocuments: [] as unknown[],
  fs,
  findFiles: async () => [] as Uri[],
  getConfiguration: (section?: string) => ({
    get: <T>(key: string, defaultValue: T): T => {
      const overrides = section ? configurationOverrides.get(section) : undefined;
      const value = overrides ? overrides[key] : undefined;
      return (value === undefined ? defaultValue : value) as T;
    }
  }),
  openTextDocument: async (uri: unknown): Promise<unknown> => {
    openTextDocumentCalls.push(uri);
    return { uri: Uri.file('') };
  },
  onDidChangeTextDocument: workspaceEvents.documentChanged.event,
  onDidOpenTextDocument: workspaceEvents.documentOpened.event,
  onDidChangeConfiguration: workspaceEvents.configurationChanged.event,
  registerTextDocumentContentProvider: (scheme: string, provider: unknown): { dispose(): void } => {
    textDocumentContentProviders.set(scheme, provider);
    return {
      dispose: (): void => {
        textDocumentContentProviders.delete(scheme);
      }
    };
  },
  createFileSystemWatcher: (): StubFileSystemWatcher => {
    const changeListeners: Array<(uri: Uri) => void> = [];
    const createListeners: Array<(uri: Uri) => void> = [];
    const deleteListeners: Array<(uri: Uri) => void> = [];
    const watcher: StubFileSystemWatcher = {
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
        changeListeners.length = 0;
        createListeners.length = 0;
        deleteListeners.length = 0;
      },
      fireChange(uri: Uri): void {
        for (const listener of [...changeListeners]) {
          listener(uri);
        }
      }
    };
    lastFileSystemWatcher.current = watcher;
    return watcher;
  }
};

export const workspaceState = {
  openTextDocumentCalls,
  contentProviders: textDocumentContentProviders,
  /** 重置装配痕迹(事件监听器、文档集合、Provider 记账、内存 fs 与配置覆写)。
   *  workspaceFolders 由测试自行管理,不在此清空。 */
  reset: (): void => {
    workspaceEvents.documentChanged.dispose();
    workspaceEvents.documentOpened.dispose();
    workspaceEvents.configurationChanged.dispose();
    workspace.textDocuments = [];
    textDocumentContentProviders.clear();
    openTextDocumentCalls.length = 0;
    lastFileSystemWatcher.current = null;
    memoryFileSystem.reset();
    configurationOverrides.clear();
  }
};
