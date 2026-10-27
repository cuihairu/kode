// fake-vscode 工作区状态层(docs/redesign.md 阶段 3):workspace 对象的
// 状态化实现——内存文件系统、配置覆写、文档集合、三个可 fire 的工作区
// 事件、TextDocumentContentProvider 记账。tests/helpers/vscodeStub.ts
// re-export 本模块的 `workspace`,既有用例对它的 monkey-patch 语义不变
// (共享同一可变对象)。

import { EventEmitter, Uri } from './core';

// 内存文件系统:debugConfig 的 loadConfig/updateLaunchJson 等经
// workspace.fs 读写真实路径内容;文件不存在时按实现语义抛错(进 catch)。
// 目录读取(quickActionScanner 经 readDirectory 扫一层 .bat)同法记账。
const memoryFiles = new Map<string, Uint8Array>();
const memoryDirectories = new Map<string, Array<[string, number]>>();

export const memoryFileSystem = {
  files: memoryFiles,
  directories: memoryDirectories,
  reset: (): void => {
    memoryFiles.clear();
    memoryDirectories.clear();
  },
  set: (fsPath: string, content: string): void => {
    memoryFiles.set(fsPath, Buffer.from(content, 'utf8'));
  },
  setDirectory: (fsPath: string, entries: Array<[string, number]>): void => {
    memoryDirectories.set(fsPath, entries);
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
  /** 创建/删除两类事件分开 fire(最终配置联动 watcher 三臂分别驱动) */
  fireCreate(uri: Uri): void;
  fireDelete(uri: Uri): void;
}

export const lastFileSystemWatcher: { current: StubFileSystemWatcher | null } = {
  current: null
};

// extension.ts 装配链的三个工作区事件:测试经 workspaceEvents.fire 驱动
// (事件对象由测试构造,如 { affectsConfiguration: s => s === 'kbengine' })。
export const workspaceEvents = {
  documentChanged: new EventEmitter<{ document: unknown }>(),
  documentSaved: new EventEmitter<unknown>(),
  documentOpened: new EventEmitter<unknown>(),
  documentClosed: new EventEmitter<unknown>(),
  filesRenamed: new EventEmitter<{ files: Array<{ oldUri: Uri; newUri: Uri }> }>(),
  foldersChanged: new EventEmitter<unknown>(),
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
  readDirectory: async (uri: Uri): Promise<Array<[string, number]>> => {
    const entries = memoryDirectories.get(uri.fsPath);
    if (entries === undefined) {
      throw new Error(`ENOENT: ${uri.fsPath}`);
    }
    return entries;
  },
  // stat 返回 vscode.FileType 真值(File=1/Directory=2,logErrorScan 按位
  // 判目录)与字节量;文件与目录都不存在时按实现语义抛错(进调用方 catch)。
  stat: async (uri: Uri): Promise<{ type: number; size: number }> => {
    const data = memoryFiles.get(uri.fsPath);
    if (data !== undefined) {
      return { type: 1, size: data.byteLength };
    }
    if (memoryDirectories.has(uri.fsPath)) {
      return { type: 2, size: 0 };
    }
    throw new Error(`ENOENT: ${uri.fsPath}`);
  },
  delete: async (uri: Uri): Promise<void> => {
    memoryFiles.delete(uri.fsPath);
  }
};

// openTextDocument 调用记账(kbengine.entity.open / kbengine.database.open
// 装配断言用);默认返回值与旧 stub 完全一致,测试可整体替换。
const openTextDocumentCalls: unknown[] = [];
// updateWorkspaceConfiguration 记账(pythonExtraPaths 写 python.analysis.extraPaths)
const workspaceConfigurationUpdates: Array<Record<string, unknown>> = [];

export const workspace = {
  workspaceFolders: [] as Array<{ uri: Uri; name: string; index: number }>,
  textDocuments: [] as unknown[],
  fs,
  findFiles: async () => [] as Uri[],
  getConfiguration: (section?: string, scope?: unknown) => ({
    get: <T>(key: string, defaultValue: T): T => {
      const overrides = section ? configurationOverrides.get(section) : undefined;
      const value = overrides ? overrides[key] : undefined;
      return (value === undefined ? defaultValue : value) as T;
    },
    update: async (key: string, value: unknown, target: unknown): Promise<void> => {
      workspaceConfigurationUpdates.push({
        key: section ? `${section}.${key}` : key,
        value,
        scope: target,
        folder: scope
      });
    }
  }),
  openTextDocument: async (uri: unknown): Promise<unknown> => {
    openTextDocumentCalls.push(uri);
    return { uri: Uri.file('') };
  },
  onDidChangeTextDocument: workspaceEvents.documentChanged.event,
  onDidSaveTextDocument: workspaceEvents.documentSaved.event,
  onDidOpenTextDocument: workspaceEvents.documentOpened.event,
  onDidCloseTextDocument: workspaceEvents.documentClosed.event,
  onDidRenameFiles: workspaceEvents.filesRenamed.event,
  onDidChangeWorkspaceFolders: workspaceEvents.foldersChanged.event,
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
      },
      fireCreate(uri: Uri): void {
        for (const listener of [...createListeners]) {
          listener(uri);
        }
      },
      fireDelete(uri: Uri): void {
        for (const listener of [...deleteListeners]) {
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
  workspaceConfigurationUpdates,
  contentProviders: textDocumentContentProviders,
  /** 重置装配痕迹(事件监听器、文档集合、Provider 记账、内存 fs 与配置覆写)。
   *  workspaceFolders 由测试自行管理,不在此清空。 */
  reset: (): void => {
    workspaceEvents.documentChanged.dispose();
    workspaceEvents.documentSaved.dispose();
    workspaceEvents.documentOpened.dispose();
    workspaceEvents.documentClosed.dispose();
    workspaceEvents.filesRenamed.dispose();
    workspaceEvents.foldersChanged.dispose();
    workspaceEvents.configurationChanged.dispose();
    workspace.textDocuments = [];
    textDocumentContentProviders.clear();
    openTextDocumentCalls.length = 0;
    workspaceConfigurationUpdates.length = 0;
    lastFileSystemWatcher.current = null;
    memoryFileSystem.reset();
    configurationOverrides.clear();
  }
};
