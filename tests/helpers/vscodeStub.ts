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

const URI_SCHEME_PATTERN = /^([A-Za-z][A-Za-z0-9+.-]*):\/?\/?/;

export class Uri {
  readonly scheme: string;
  readonly path: string;

  static file(fsPath: string): Uri {
    return new Uri(fsPath, 'file');
  }

  static parse(value: string): Uri {
    // 带自定义 scheme 的虚拟 URI(如 kbengine-db-schema:/Hero.schema):
    // scheme 单独记账,剩余部分作为 fsPath/path 供文档定位使用。
    const match = URI_SCHEME_PATTERN.exec(value);
    if (match && match[1] !== 'file') {
      return new Uri(value.slice(match[0].length), match[1]);
    }
    return new Uri(value, 'file');
  }

  static joinPath(base: Uri, ...segments: string[]): Uri {
    const baseDir = base.fsPath.replace(/\/+$/, '');
    return new Uri([baseDir, ...segments].join('/'), base.scheme);
  }

  private constructor(public readonly fsPath: string, scheme: string) {
    this.scheme = scheme;
    this.path = fsPath;
  }

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

export interface Command {
  command: string;
  title: string;
  arguments?: unknown[];
}

// explorerProviders 的树项子类 extends TreeItem,模块求值即需要此基类。
export enum TreeItemCollapsibleState {
  None = 0,
  Collapsed = 1,
  Expanded = 2
}

// logWebView 的 show() 以 vscode.ViewColumn.Two 创建面板,模块命名空间
// frozen,常量必须由 stub 导出;面板工厂与保存对话框由测试文件按用例
// monkey-patch 到 window 上。
export enum ViewColumn {
  Active = 1,
  Beside = 2,
  One = 3,
  Two = 4
}

// debugConfig 的 attachToComponent 经 vscode.debug.startDebugging 启动
// 调试会话;对象成员可变,测试按用例 monkey-patch startDebugging。
export const debug = {
  startDebugging: async (_folder: unknown, _config: unknown): Promise<boolean> => false
};

export class ThemeIcon {
  static readonly File = new ThemeIcon('file');
  static readonly Folder = new ThemeIcon('folder');
  constructor(public readonly id: string) {}
}

export class TreeItem {
  label?: string;
  description?: string | boolean;
  iconPath?: ThemeIcon | { light?: Uri; dark?: Uri };
  command?: Command;
  contextValue?: string;
  tooltip?: string;

  constructor(label?: string, public collapsibleState?: TreeItemCollapsibleState) {
    this.label = label;
  }
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

// 按配置段覆写 getConfiguration 返回值(如 hover.showValueDocs=false);
// 未覆写的键回落到实现提供的默认值。
export const configurationOverrides = new Map<string, Record<string, unknown>>();

export const workspace = {
  workspaceFolders: [] as Array<{ uri: Uri; name: string; index: number }>,
  fs,
  findFiles: async () => [] as Uri[],
  getConfiguration: (section?: string) => ({
    get: <T>(key: string, defaultValue: T): T => {
      const overrides = section ? configurationOverrides.get(section) : undefined;
      const value = overrides ? overrides[key] : undefined;
      return (value === undefined ? defaultValue : value) as T;
    }
  }),
  openTextDocument: async () => ({ uri: Uri.file('') }),
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

export const window = {
  showErrorMessage: async () => undefined,
  showInformationMessage: async () => undefined,
  showWarningMessage: async () => undefined,
  // 真实 vscode 返回 editor;openMethodTarget 断言 editor !== undefined,
  // 默认给真值对象,测试可临时覆盖为 undefined 模拟拒开。
  showTextDocument: async (_document: unknown, _options?: unknown): Promise<unknown> => ({}),
  createOutputChannel: () => ({
    appendLine: () => undefined,
    show: () => undefined,
    dispose: () => undefined
  })
};

// entityMapping 的 watchPythonFiles 需要可观察的 watcher:记录回调并允许
// 测试主动 fire;真实事件行为仍由 mocha 层覆盖。
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

// ---- languageProviders 测试所需(vscode 真实枚举值对齐) ----

export enum CompletionItemKind {
  Method = 1,
  Function = 2,
  Class = 6,
  Property = 9,
  Enum = 12,
  Constant = 20
}

export class CompletionItem {
  detail?: string;
  documentation?: string | MarkdownString;
  constructor(public label: string, public kind?: CompletionItemKind) {}
}

export class MarkdownString {
  value = '';
  appendMarkdown(value: string): void {
    this.value += value;
  }
  appendCodeblock(code: string, lang = ''): void {
    this.value += `\n\`\`\`${lang}\n${code}\n\`\`\`\n`;
  }
}

export class Hover {
  constructor(public contents: MarkdownString | MarkdownString[]) {}
}

// vscode.Location 第二参接受 Range|Position;传 Position 时真实 vscode
// 包装为 start=end 的 Range,stub 对齐该语义(languageProviders 全部传 Position)。
export class Location {
  constructor(public uri: Uri, rangeOrPosition: Range | Position) {
    this.range = rangeOrPosition instanceof Position
      ? new Range(rangeOrPosition, rangeOrPosition)
      : rangeOrPosition;
  }

  range: Range;
}

export enum DiagnosticSeverity {
  Error = 0,
  Warning = 1,
  Information = 2,
  Hint = 3
}

export class Diagnostic {
  source?: string;
  code?: string | number;
  constructor(
    public range: Range,
    public message: string,
    public severity: DiagnosticSeverity
  ) {}
}

// 仅支持 validateDocument 使用的 set/delete 面。
export class DiagnosticCollection {
  private entries = new Map<Uri, Diagnostic[]>();

  set(uri: Uri, diagnostics: Diagnostic[]): void {
    this.entries.set(uri, diagnostics);
  }

  delete(uri: Uri): void {
    this.entries.delete(uri);
  }

  get(uri: Uri): Diagnostic[] {
    return this.entries.get(uri) ?? [];
  }

  dispose(): void {
    this.entries.clear();
  }
}

// 测试用 TextDocument 工厂:按 \n 分行的最小实现,覆盖 languageProviders
// 用到的 getText/positionAt/offsetAt/lineAt/getWordRangeAtPosition 面。
export interface MinimalTextDocument {
  uri: Uri;
  fileName: string;
  languageId: string;
  getText(range?: Range): string;
  positionAt(offset: number): Position;
  offsetAt(position: Position): number;
  lineAt(line: number): { text: string };
  getWordRangeAtPosition(position: Position, rangeRegex?: RegExp): Range | undefined;
}

export function makeTextDocument(
  text: string,
  options?: { fileName?: string; languageId?: string; uri?: Uri }
): MinimalTextDocument {
  const fileName = options?.fileName ?? '/tmp/Anonymous.def';
  const languageId = options?.languageId ?? 'kbengine-def';
  const uri = options?.uri ?? Uri.file(fileName);
  const lineStarts: number[] = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\n') {
      lineStarts.push(i + 1);
    }
  }

  const offsetAt = (position: Position): number => {
    const base = lineStarts[Math.min(position.line, lineStarts.length - 1)] ?? 0;
    return base + position.character;
  };

  return {
    uri,
    fileName,
    languageId,
    getText(range?: Range): string {
      if (!range) {
        return text;
      }
      return text.slice(offsetAt(range.start), offsetAt(range.end));
    },
    positionAt(offset: number): Position {
      let line = 0;
      while (line + 1 < lineStarts.length && lineStarts[line + 1] <= offset) {
        line += 1;
      }
      return new Position(line, offset - lineStarts[line]);
    },
    offsetAt,
    lineAt(line: number): { text: string } {
      return { text: (text.split('\n')[line] ?? '') };
    },
    getWordRangeAtPosition(position: Position, rangeRegex: RegExp = /\w+/): Range | undefined {
      const lineText = text.split('\n')[position.line] ?? '';
      const wordRegex = new RegExp(
        rangeRegex.source,
        rangeRegex.flags.includes('g') ? rangeRegex.flags : `${rangeRegex.flags}g`
      );
      let match: RegExpExecArray | null;
      while ((match = wordRegex.exec(lineText)) !== null) {
        if (position.character >= match.index && position.character <= match.index + match[0].length) {
          return new Range(
            new Position(position.line, match.index),
            new Position(position.line, match.index + match[0].length)
          );
        }
        if (match[0].length === 0) {
          break;
        }
      }
      return undefined;
    }
  };
}
