// fake-vscode 值类型层(docs/redesign.md 阶段 3):与 vscode 真实语义对齐的
// 类/枚举/工厂。状态化的 workspace/window/commands/languages/panel 分层见
// 同目录各模块;tests/helpers/vscodeStub.ts 是它们的兼容 re-export 薄壳。

export class RelativePattern {
  constructor(public readonly base: string | Uri, public readonly pattern: string) {}
}

export class Position {
  constructor(public readonly line: number, public readonly character: number) {}
}

export class Range {
  constructor(
    public readonly start: Position,
    public readonly end: Position
  ) {}
}

export class CodeLens {
  constructor(public readonly range: Range, public readonly command?: unknown) {}
}

// inlay hints 替身(批154 类型 inlay 用):只保留构造面,断言读字段即可
export class InlayHint {
  constructor(
    public readonly position: Position,
    public readonly label: unknown,
    public readonly kind?: unknown
  ) {}
}

export enum InlayHintKind {
  Type = 1,
  Parameter = 2
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
// new 实例时才需要)。这里提供最小事件语义。
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

// 仅作构造参数占位;extension 装配测试用 { subscriptions: [], extensionUri }。
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

// logWebView/monitoringWebView 的 show() 以 vscode.ViewColumn.Two 创建面板。
export enum ViewColumn {
  Active = 1,
  Beside = 2,
  One = 3,
  Two = 4
}

// extension.ts 的状态栏经 vscode.window.createStatusBarItem(Alignment, priority)。
export enum StatusBarAlignment {
  Left = 1,
  Right = 2
}

// quickActions 的 show() 用分隔线分组展示不同后端;真值与 vscode 对齐。
export enum QuickPickItemKind {
  Separator = -1,
  Default = 0
}

// pythonExtraPaths 的同步写 python.analysis.extraPaths 用
// updateWorkspaceConfiguration(WorkspaceFolder 级);真值与 vscode 对齐。
export enum ConfigurationTarget {
  Global = 1,
  Workspace = 2,
  WorkspaceFolder = 3
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

// ---- languageProviders 测试所需(vscode 真实枚举值对齐) ----

export enum CompletionItemKind {
  Method = 1,
  Function = 2,
  Class = 6,
  Property = 9,
  Enum = 12,
  Constant = 20
}

// IDE-NAV-005:def Outline 用(children 初始空数组,供段容器挂子符号)
export class DocumentSymbol {
  children: DocumentSymbol[] = [];
  constructor(
    public name: string,
    public detail: string,
    public kind: SymbolKind,
    public range: Range,
    public selectionRange: Range
  ) {}
}

// IDE-NAV-006:工作区符号(Ctrl+T)用(4 参构造与真实 vscode 对齐)
export class SymbolInformation {
  constructor(
    public name: string,
    public kind: SymbolKind,
    public containerName: string,
    public location: unknown
  ) {}
}

export interface CompletionItemLabel {
  label: string;
  description?: string;
  detail?: string;
}

export class CompletionItem {
  detail?: string;
  documentation?: string | MarkdownString;
  // 真实 vscode API 第二参兼收 string | CompletionItemLabel(批形升级单:
  // 内建属性补全 label 右列灰字类型传对象形态)
  constructor(public label: string | CompletionItemLabel, public kind?: CompletionItemKind) {}
}

// IDE-NAV-016:冷补全可刷新状态(vscode 真实语义——isIncomplete=true 时
// 编辑器继续输入会重查同前缀;items 为构造面,断言读字段即可)
export class CompletionList {
  constructor(
    public readonly items: CompletionItem[],
    public readonly isIncomplete = false
  ) {}
}

export class MarkdownString {
  constructor(initialValue = '') {
    this.value = initialValue;
  }

  value = '';
  appendMarkdown(value: string): void {
    this.value += value;
  }
  appendCodeblock(code: string, lang = ''): void {
    this.value += `\n\`\`\`${lang}\n${code}\n\`\`\`\n`;
  }
}

export class ParameterInformation {
  constructor(public label: string) {}
}

export class SignatureInformation {
  label: string;
  parameters: ParameterInformation[] = [];

  constructor(label: string) {
    this.label = label;
  }

  pushParameter(label: string): this {
    this.parameters.push(new ParameterInformation(label));
    return this;
  }
}

export class SignatureHelp {
  signatures: SignatureInformation[] = [];
  activeSignature = 0;
  activeParameter = 0;
}

export class Hover {
  constructor(public contents: MarkdownString | MarkdownString[]) {}
}

// call hierarchy 三件套(真实 vscode 构造签名对齐);IDE-NAV-005 起 def
// Outline 复用同一枚举(取值与真实 vscode.SymbolKind 对齐)
export enum SymbolKind {
  Class = 5,
  Method = 6,
  Field = 8,
  Struct = 23
}

export class CallHierarchyItem {
  constructor(
    public kind: SymbolKind,
    public name: string,
    public detail: string,
    public uri: Uri,
    public range: Range,
    public selectionRange: Range
  ) {}
}

export class CallHierarchyIncomingCall {
  constructor(public item: CallHierarchyItem, public fromRanges: Range[]) {}
}

export class CallHierarchyOutgoingCall {
  constructor(public item: CallHierarchyItem, public toRanges: Range[]) {}
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

// IDE-NAV-013:Code Action 面值类型(kind 分级与动作壳;context/provider
// 为纯类型面由 @types/vscode 提供,替身只补运行时值)
export class CodeActionKind {
  static readonly QuickFix = new CodeActionKind('quickfix');
  static readonly Refactor = new CodeActionKind('refactor');
  static readonly Source = new CodeActionKind('source');
  constructor(public readonly value: string) {}
  append(parts: string): CodeActionKind {
    return new CodeActionKind(`${this.value}.${parts}`);
  }
}

export class CodeAction {
  diagnostics?: Diagnostic[];
  edit?: WorkspaceEdit;
  command?: unknown;
  isPreferred?: boolean;
  constructor(
    public title: string,
    public kind?: CodeActionKind
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

  // 真实 vscode.DiagnosticCollection API 面:清空所有文件的诊断
  clear(): void {
    this.entries.clear();
  }

  dispose(): void {
    this.entries.clear();
  }
}

// rename provider 所需的 TextEdit/WorkspaceEdit(vscode 真实 API 面:
// set/get/has/delete/entries/insert/replace;provider 只消费 set 与构造,
// 其余供测试断言)。entries() 对齐真实(已废弃但仍存在)的同名方法。
export class TextEdit {
  constructor(public readonly range: Range, public readonly newText: string) {}

  static replace(range: Range, newText: string): TextEdit {
    return new TextEdit(range, newText);
  }

  static insert(position: Position, newText: string): TextEdit {
    return new TextEdit(new Range(position, position), newText);
  }
}

export class WorkspaceEdit {
  private readonly entriesMap = new Map<Uri, TextEdit[]>();

  set(uri: Uri, edits: TextEdit[]): void {
    this.entriesMap.set(uri, edits);
  }

  get(uri: Uri): TextEdit[] {
    return this.entriesMap.get(uri) ?? [];
  }

  delete(uri: Uri): void {
    this.entriesMap.delete(uri);
  }

  has(uri: Uri): boolean {
    return this.entriesMap.has(uri);
  }

  get size(): number {
    return this.entriesMap.size;
  }

  insert(uri: Uri, position: Position, newText: string): void {
    this.set(uri, [...this.get(uri), TextEdit.insert(position, newText)]);
  }

  replace(uri: Uri, range: Range, newText: string): void {
    this.set(uri, [...this.get(uri), TextEdit.replace(range, newText)]);
  }

  entries(): Array<[Uri, TextEdit[]]> {
    return [...this.entriesMap.entries()];
  }
}

// 测试用 TextDocument 工厂:按 \n 分行的最小实现,覆盖 languageProviders
// 用到的 getText/positionAt/offsetAt/lineAt/getWordRangeAtPosition 面。
export interface MinimalTextDocument {
  uri: Uri;
  fileName: string;
  languageId: string;
  /** 文档版本(真 TextDocument 同名面);缺省 undefined=版本不可知替身(documentStore 按每次都可能变处理) */
  version: number | undefined;
  getText(range?: Range): string;
  positionAt(offset: number): Position;
  offsetAt(position: Position): number;
  lineAt(line: number): { text: string };
  getWordRangeAtPosition(position: Position, rangeRegex?: RegExp): Range | undefined;
}

export function makeTextDocument(
  text: string,
  options?: { fileName?: string; languageId?: string; uri?: Uri; version?: number }
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
    version: options?.version,
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
