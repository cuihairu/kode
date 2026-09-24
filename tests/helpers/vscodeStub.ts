// vitest 用的最小 vscode stub:仅满足模块加载求值与无文档上下文的
// workspace 查询(getWorkspaceRootForDocument 在无 workspaceFolders 时
// 返回 null)。凡真正触碰 vscode 行为的测试一律走 mocha + test-electron。
export class Position {
  constructor(public readonly line: number, public readonly character: number) {}
}

export class Range {
  constructor(
    public readonly start: Position,
    public readonly end: Position
  ) {}
}

export class Uri {
  static file(fsPath: string): Uri {
    return new Uri(fsPath);
  }

  static parse(value: string): Uri {
    return new Uri(value);
  }

  static joinPath(base: Uri, ...segments: string[]): Uri {
    const baseDir = base.fsPath.replace(/\/+$/, '');
    return new Uri([baseDir, ...segments].join('/'));
  }

  private constructor(public readonly fsPath: string) {}

  toString(): string {
    return this.fsPath;
  }
}

// monitoringCollector 在实例字段初始化 EventEmitter(模块求值不触发,
// new 实例时才需要)。这里提供最小事件语义,真实事件行为仍由 mocha 层覆盖。
export class EventEmitter<T> {
  private listeners: Array<(value: T) => void> = [];

  readonly event = (listener: (value: T) => void): { dispose: () => void } => {
    this.listeners.push(listener);
    return {
      dispose: () => {
        this.listeners = this.listeners.filter(candidate => candidate !== listener);
      }
    };
  };

  fire(value: T): void {
    for (const listener of [...this.listeners]) {
      listener(value);
    }
  }

  dispose(): void {
    this.listeners = [];
  }
}

// 仅作构造参数占位(真实上下文行为由 mocha 层覆盖)。
export interface ExtensionContext {
  subscriptions: Array<{ dispose(): void }>;
  [key: string]: unknown;
}

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

export const workspace = {
  workspaceFolders: [] as Array<{ uri: Uri; name: string; index: number }>,
  fs,
  findFiles: async () => [] as Uri[],
  getConfiguration: () => ({ get: <T>(_key: string, defaultValue: T): T => defaultValue }),
  openTextDocument: async () => ({ uri: Uri.file('') }),
  createFileSystemWatcher: () => ({
    onDidChange: () => ({ dispose: () => undefined }),
    onDidCreate: () => ({ dispose: () => undefined }),
    onDidDelete: () => ({ dispose: () => undefined }),
    dispose: () => undefined
  })
};

export const window = {
  showErrorMessage: async () => undefined,
  showInformationMessage: async () => undefined,
  showWarningMessage: async () => undefined,
  createOutputChannel: () => ({
    appendLine: () => undefined,
    show: () => undefined,
    dispose: () => undefined
  })
};
