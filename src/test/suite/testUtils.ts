import Module = require('module');

export class FakePosition {
  constructor(public line: number, public character: number) {}
}

export class FakeRange {
  constructor(public start: FakePosition, public end: FakePosition) {}
}

export class FakeUri {
  constructor(public fsPath: string) {}

  static parse(fsPath: string): FakeUri {
    return new FakeUri(fsPath);
  }

  static file(fsPath: string): FakeUri {
    return new FakeUri(fsPath);
  }

  static joinPath(base: FakeUri, ...paths: string[]): FakeUri {
    return new FakeUri([base.fsPath, ...paths].join('/'));
  }

  toString(): string {
    return this.fsPath;
  }
}

export class FakeLocation {
  constructor(public uri: FakeUri, public position: FakePosition) {}
}

export class FakeMarkdownString {
  value: string;

  constructor(value = '') {
    this.value = value;
  }

  appendMarkdown(text: string): void {
    this.value += text;
  }

  appendCodeblock(code: string, language?: string): void {
    this.value += `\n\`\`\`${language || ''}\n${code}\n\`\`\`\n`;
  }
}

export class FakeHover {
  constructor(public contents: FakeMarkdownString) {}
}

export class FakeDiagnostic {
  constructor(
    public range: FakeRange,
    public message: string,
    public severity: number
  ) {}
}

export class FakeCompletionItem {
  detail?: string;
  documentation?: FakeMarkdownString;

  constructor(public label: string, public kind?: number) {}
}

export class FakeDiagnosticCollection {
  entries = new Map<string, FakeDiagnostic[]>();
  deleted: string[] = [];

  set(uri: FakeUri, diagnostics: FakeDiagnostic[]): void {
    this.entries.set(uri.fsPath, diagnostics);
  }

  delete(uri: FakeUri): void {
    this.deleted.push(uri.fsPath);
    this.entries.delete(uri.fsPath);
  }
}

export class FakeTextDocument {
  readonly uri: FakeUri;

  constructor(
    public fileName: string,
    public languageId: string,
    private text: string
  ) {
    this.uri = new FakeUri(fileName);
  }

  getText(range?: FakeRange): string {
    if (!range) {
      return this.text;
    }

    return this.text.slice(this.offsetAt(range.start), this.offsetAt(range.end));
  }

  lineAt(line: number): { text: string } {
    return { text: this.text.split('\n')[line] || '' };
  }

  offsetAt(position: FakePosition): number {
    const lines = this.text.split('\n');
    let offset = 0;

    for (let i = 0; i < position.line; i += 1) {
      offset += lines[i].length + 1;
    }

    return offset + position.character;
  }

  positionAt(offset: number): FakePosition {
    const before = this.text.slice(0, offset);
    const lines = before.split('\n');
    return new FakePosition(lines.length - 1, lines[lines.length - 1].length);
  }

  getWordRangeAtPosition(position: FakePosition): FakeRange | undefined {
    const offset = this.offsetAt(position);
    const wordRegex = /\w+/g;
    let match: RegExpExecArray | null;

    while ((match = wordRegex.exec(this.text)) !== null) {
      const start = match.index;
      const end = start + match[0].length;
      if (offset >= start && offset <= end) {
        return new FakeRange(this.positionAt(start), this.positionAt(end));
      }
    }

    return undefined;
  }
}

export const defaultKbengineConfig = {
  enableDiagnostics: true,
  enableStructureDiagnostics: true,
  'diagnostics.checkUnknownTypes': true,
  'diagnostics.checkUnknownFlags': true,
  'diagnostics.checkUnknownDetailLevels': true,
  'diagnostics.checkFlagConflicts': true,
  'diagnostics.checkDuplicateDefinitions': true,
  'diagnostics.checkInvalidChildren': true,
  'diagnostics.checkMissingPropertyFields': true,
  'hover.showTagDocs': true,
  'hover.showValueDocs': true,
  'hover.showSymbolDocs': true
} as const;

export function createVscodeStub(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    workspace: {
      workspaceFolders: [{ uri: new FakeUri('/workspace') }],
      getConfiguration: () => ({
        get<T>(key: keyof typeof defaultKbengineConfig, defaultValue: T): T {
          return (defaultKbengineConfig[key] as T | undefined) ?? defaultValue;
        }
      })
    },
    Uri: FakeUri,
    Position: FakePosition,
    Range: FakeRange,
    Location: FakeLocation,
    MarkdownString: FakeMarkdownString,
    Hover: FakeHover,
    Diagnostic: FakeDiagnostic,
    DiagnosticSeverity: {
      Error: 0,
      Warning: 1,
      Information: 2
    },
    CompletionItem: FakeCompletionItem,
    CompletionItemKind: {
      Property: 10,
      Method: 1
    },
    ...overrides
  };
}

export function createModuleLoader(): {
  _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
  createRequire(filename: string): NodeRequire;
} {
  return Module as unknown as {
    _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
    createRequire(filename: string): NodeRequire;
  };
}

export function loadModuleWithMocks<T>(
  testFile: string,
  modulePath: string,
  mocks: Record<string, unknown>,
  clearCache = false
): { loadedModule: T; restore: () => void } {
  const moduleLoader = createModuleLoader();
  const originalLoad = moduleLoader._load;

  moduleLoader._load = function patchedLoad(request: string, parent: NodeModule | null, isMain: boolean) {
    if (Object.prototype.hasOwnProperty.call(mocks, request)) {
      return mocks[request];
    }

    return originalLoad(request, parent, isMain);
  };

  const runtimeRequire = moduleLoader.createRequire(testFile);
  if (clearCache) {
    delete require.cache[runtimeRequire.resolve(modulePath)];
  }

  return {
    loadedModule: runtimeRequire(modulePath) as T,
    restore() {
      moduleLoader._load = originalLoad;
    }
  };
}
