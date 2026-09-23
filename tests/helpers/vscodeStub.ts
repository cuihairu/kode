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

  private constructor(public readonly fsPath: string) {}

  toString(): string {
    return this.fsPath;
  }
}

export const workspace = {
  workspaceFolders: [] as Array<{ uri: Uri; name: string; index: number }>,
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
