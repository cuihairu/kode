// fake-vscode 工作区状态层(docs/redesign.md 阶段 3):workspace 对象的
// 状态化实现——内存文件系统、配置覆写、文档集合、三个可 fire 的工作区
// 事件、TextDocumentContentProvider 记账。tests/helpers/vscodeStub.ts
// re-export 本模块的 `workspace`,既有用例对它的 monkey-patch 语义不变
// (共享同一可变对象)。

import { ConfigurationTarget, EventEmitter, RelativePattern, Uri } from './core';

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

// 用户级(Global)覆写:ConfigurationTarget.Global 的写入落这里,读取时作为
// 工作区级的兜底(作用域优先级:工作区 > 用户)。没有这层,一键开关写错作用域
// 也会在同一个表里「看起来生效」,生效值核对咬不出来。
export const globalConfigurationOverrides = new Map<string, Record<string, unknown>>();

// 按配置段覆写 getConfiguration 返回值(如 hover.showValueDocs=false);
// 未覆写的键回落到实现提供的默认值。clear() 连用户级表一并清——测试的
// 「清配置」语义是回到零配置,只清一张会跨用例漏作用域。
class ConfigurationOverrideMap extends Map<string, Record<string, unknown>> {
  clear(): void {
    super.clear();
    globalConfigurationOverrides.clear();
  }
}
export const configurationOverrides = new ConfigurationOverrideMap();

// entityMapping 的 watchPythonFiles 需要可观察的 watcher:记录回调并允许
// 测试主动 fire。
export interface StubFileSystemWatcher {
  /** 创建时的 glob(装配线 watcher 断言用;IDE-ACC-011 起可为 RelativePattern) */
  pattern?: string | RelativePattern;
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
  filesDeleted: new EventEmitter<{ uris: Uri[] }>(),
  // PROC-TAG-001 进程归属镜的刷新源:同名对应文件新建触发重取(真 API
  // FileCreateEvent 形状 files: Uri[])
  filesCreated: new EventEmitter<{ files: Uri[] }>(),
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
// applyEdit 调用记账(AUD-030:打开文档走缓冲写入而非原子写盘,测试断言
// 未打开路径零调用)。
const applyEditCalls: unknown[] = [];
// 可被 applyEdit 变更的文档面(MinimalTextDocument + setText)
interface MutableDoc {
  uri: Uri;
  getText(): string;
  offsetAt(position: { line: number; character: number }): number;
  setText(next: string): void;
}
// updateWorkspaceConfiguration 记账(pythonExtraPaths 写 python.analysis.extraPaths)
const workspaceConfigurationUpdates: Array<Record<string, unknown>> = [];

export const workspace = {
  workspaceFolders: [] as Array<{ uri: Uri; name: string; index: number }>,
  textDocuments: [] as unknown[],
  fs,
  findFiles: async () => [] as Uri[],
  getConfiguration: (section?: string, scope?: unknown) => ({
    get: <T>(key: string, defaultValue: T): T => {
      // 作用域优先级:工作区级 > 用户级(Global) > 实现默认值
      const overrides = section ? configurationOverrides.get(section) : undefined;
      const globals = section ? globalConfigurationOverrides.get(section) : undefined;
      const workspaceValue = overrides ? overrides[key] : undefined;
      const value = workspaceValue !== undefined ? workspaceValue : globals ? globals[key] : undefined;
      return (value === undefined ? defaultValue : value) as T;
    },
    update: async (key: string, value: unknown, target: unknown): Promise<void> => {
      workspaceConfigurationUpdates.push({
        key: section ? `${section}.${key}` : key,
        value,
        scope: target,
        folder: scope
      });
      // 同步写回覆写表:模拟真实 VS Code「写配置后 get 立即读到新值」——
      // 一键开关(kbengine.hotReload.toggle)写回后,配置事件驱动的重建面
      // 才能按新值生效(嵌套段按 . 拆首段落表)。落哪张表按作用域分:
      // Global 进用户级表,其余(Workspace/WorkspaceFolder/未指定)进工作区级表。
      if (section) {
        const store =
          target === ConfigurationTarget.Global ? globalConfigurationOverrides : configurationOverrides;
        const parts = key.split('.');
        const base = store.get(section) ?? {};
        let node: Record<string, unknown> = base;
        for (const part of parts.slice(0, -1)) {
          const next = node[part];
          if (typeof next !== 'object' || next === null || Array.isArray(next)) {
            node[part] = {};
          }
          node = node[part] as Record<string, unknown>;
        }
        const leaf = parts[parts.length - 1];
        if (value === undefined) {
          delete node[leaf];
        } else {
          node[leaf] = value;
        }
        store.set(section, base);
      }
    }
  }),
  openTextDocument: async (uri: unknown): Promise<unknown> => {
    openTextDocumentCalls.push(uri);
    return { uri: Uri.file('') };
  },
  // AUD-030:把 WorkspaceEdit 应用到打开文档缓冲区(按 offset 逆序重组文本,
  // 命中一个文档即视为已应用);未打开的文档面不命中返回 false。
  applyEdit: async (edit: { entries(): Array<[Uri, Array<{ range: { start: { line: number; character: number }; end: { line: number; character: number } }; newText: string }>]> }): Promise<boolean> => {
    applyEditCalls.push(edit);
    let any = false;
    for (const [uri, edits] of edit.entries()) {
      const doc = (workspace.textDocuments as MutableDoc[]).find(candidate => candidate.uri.fsPath === uri.fsPath);
      if (!doc) {
        continue;
      }
      const ordered = [...edits].sort((a, b) => doc.offsetAt(b.range.start) - doc.offsetAt(a.range.start));
      let text = doc.getText();
      for (const item of ordered) {
        const start = doc.offsetAt(item.range.start);
        const end = doc.offsetAt(item.range.end);
        text = `${text.slice(0, start)}${item.newText}${text.slice(end)}`;
      }
      doc.setText(text);
      any = true;
    }
    return any;
  },
  onDidChangeTextDocument: workspaceEvents.documentChanged.event,
  onDidSaveTextDocument: workspaceEvents.documentSaved.event,
  onDidOpenTextDocument: workspaceEvents.documentOpened.event,
  onDidCloseTextDocument: workspaceEvents.documentClosed.event,
  onDidRenameFiles: workspaceEvents.filesRenamed.event,
  onDidDeleteFiles: workspaceEvents.filesDeleted.event,
  onDidCreateFiles: workspaceEvents.filesCreated.event,
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
  createFileSystemWatcher: (pattern?: string | RelativePattern): StubFileSystemWatcher => {
    const changeListeners: Array<(uri: Uri) => void> = [];
    const createListeners: Array<(uri: Uri) => void> = [];
    const deleteListeners: Array<(uri: Uri) => void> = [];
    const watcher: StubFileSystemWatcher = {
      pattern,
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
    allFileSystemWatchers.push(watcher);
    return watcher;
  }
};

/** 供测试按创建顺序取 watcher(lastFileSystemWatcher 只留最后一个) */
export const allFileSystemWatchers: StubFileSystemWatcher[] = [];

export const workspaceState = {
  openTextDocumentCalls,
  applyEditCalls,
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
    workspaceEvents.filesDeleted.dispose();
    workspaceEvents.foldersChanged.dispose();
    workspaceEvents.configurationChanged.dispose();
    workspace.textDocuments = [];
    textDocumentContentProviders.clear();
    openTextDocumentCalls.length = 0;
    applyEditCalls.length = 0;
    workspaceConfigurationUpdates.length = 0;
    lastFileSystemWatcher.current = null;
    allFileSystemWatchers.length = 0;
    memoryFileSystem.reset();
    configurationOverrides.clear();
    globalConfigurationOverrides.clear();
  }
};
