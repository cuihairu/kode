import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { KBEngineLogCollector } from '../src/logCollector';
import { LogViewerWebView } from '../src/logWebView';
import { LogEntry, LogLevel, LogParser, LogType } from '../src/logParser';
import type * as vscode from 'vscode';
import {
  Uri,
  ViewColumn,
  memoryFileSystem,
  window as stubWindow,
  workspace as stubWorkspace
} from './helpers/vscodeStub';

// LogViewerWebView 的面板生命周期:show 的面板创建/复用/重建、经
// onDidReceiveMessage 捕获的 handler 驱动 handleMessage 六类消息、
// exportLogs 的保存对话框与内容落盘。collector 用可控假例(记录
// connect/disconnect/clearLogs 调用、保留订阅回调可手动触发),
// WebviewPanel 由 monkey-patch 的工厂返回可观察 stub。

interface PanelRecord {
  viewType: string;
  title: string;
  column: number;
  options: { enableScripts: boolean };
}

interface StubPanel extends PanelRecord {
  revealCalls: number;
  webview: {
    html: string;
    handlers: Array<(message: unknown) => void>;
    onDidReceiveMessage(handler: (message: unknown) => void): { dispose(): void };
  };
  disposeHandlers: Array<() => void>;
  onDidDispose(handler: () => void): { dispose(): void };
  reveal(): void;
}

const panels: StubPanel[] = [];
const saveDialogUris: Array<vscode.Uri | undefined> = [];
const messages = { info: [] as string[], error: [] as string[] };

const windowish = stubWindow as unknown as Record<string, unknown>;
const originalWindow: Record<string, unknown> = {};
const patchedKeys = [
  'createWebviewPanel',
  'showSaveDialog',
  'showInformationMessage',
  'showErrorMessage'
];

const originalWriteFile = stubWorkspace.fs.writeFile;

const entry = (over: Partial<LogEntry> = {}): LogEntry => ({
  id: 1,
  timestamp: new Date(Date.UTC(2026, 8, 24, 12, 0, 0)),
  component: 'cellapp',
  level: LogLevel.INFO,
  type: LogType.LOG_TYPE_NORMAL,
  message: 'entity created',
  raw: 'raw line',
  ...over
});

interface FakeCollector {
  collector: KBEngineLogCollector;
  emit(entry: LogEntry): void;
  stats(): { cleared: number; disconnected: number; connected: number };
  failConnect(message: string): void;
  setEntries(entries: LogEntry[]): void;
}

const makeFakeCollector = (): FakeCollector => {
  const listeners: Array<(entry: LogEntry) => void> = [];
  const state = {
    cleared: 0,
    disconnected: 0,
    connected: 0,
    connectError: null as string | null,
    entries: [] as LogEntry[]
  };
  const collector = {
    onLogEntry: (listener: (entry: LogEntry) => void) => {
      listeners.push(listener);
      return { dispose: () => undefined };
    },
    getLogEntries: () => [...state.entries],
    clearLogs: () => {
      state.cleared += 1;
      state.entries = [];
    },
    getStatusSummary: () => 'FAKE STATUS',
    connect: async () => {
      if (state.connectError !== null) {
        throw new Error(state.connectError);
      }
      state.connected += 1;
    },
    disconnect: () => {
      state.disconnected += 1;
    }
  } as unknown as KBEngineLogCollector;
  return {
    collector,
    emit: (logEntry: LogEntry) => {
      for (const listener of [...listeners]) {
        listener(logEntry);
      }
    },
    stats: () => ({ cleared: state.cleared, disconnected: state.disconnected, connected: state.connected }),
    failConnect: (message: string) => {
      state.connectError = message;
    },
    setEntries: (entries: LogEntry[]) => {
      state.entries = entries;
    }
  };
};

let fake: FakeCollector;

const makeWebView = () =>
  new LogViewerWebView({ extensionUri: Uri.file('/ext/root') } as unknown as vscode.ExtensionContext, fake.collector);

const currentPanel = (): StubPanel => panels[panels.length - 1];

const show = (): StubPanel => {
  makeWebView().show();
  return currentPanel();
};

const send = (message: unknown): void => {
  for (const handler of [...currentPanel().webview.handlers]) {
    handler(message);
  }
};

const until = async (predicate: () => boolean, timeoutMs = 2000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('condition not met before deadline');
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
};

beforeAll(() => {
  for (const key of patchedKeys) {
    originalWindow[key] = windowish[key];
  }
  windowish.createWebviewPanel = (
    viewType: string,
    title: string,
    column: number,
    options: { enableScripts: boolean }
  ) => {
    const panel = {
      viewType,
      title,
      column,
      options,
      revealCalls: 0,
      disposeHandlers: [] as Array<() => void>,
      webview: {
        html: '',
        handlers: [] as Array<(message: unknown) => void>,
        onDidReceiveMessage: (handler: (message: unknown) => void) => {
          panel.webview.handlers.push(handler);
          return { dispose: () => undefined };
        }
      },
      onDidDispose: (handler: () => void) => {
        panel.disposeHandlers.push(handler);
        return { dispose: () => undefined };
      },
      reveal: () => {
        panel.revealCalls += 1;
      }
    };
    panels.push(panel as unknown as StubPanel);
    return panel;
  };
  windowish.showSaveDialog = async () => saveDialogUris.shift();
  windowish.showInformationMessage = async (message: string) => {
    messages.info.push(message);
    return undefined;
  };
  windowish.showErrorMessage = async (message: string) => {
    messages.error.push(message);
    return undefined;
  };
});

afterAll(() => {
  for (const key of patchedKeys) {
    windowish[key] = originalWindow[key];
  }
  stubWorkspace.fs.writeFile = originalWriteFile;
  memoryFileSystem.reset();
});

beforeEach(() => {
  panels.length = 0;
  saveDialogUris.length = 0;
  messages.info.length = 0;
  messages.error.length = 0;
  memoryFileSystem.reset();
  stubWorkspace.workspaceFolders = [];
  fake = makeFakeCollector();
});

afterEach(() => {
  stubWorkspace.fs.writeFile = originalWriteFile;
});

describe('LogViewerWebView.show', () => {
  it('creates the panel once with initial collector entries rendered', () => {
    fake.setEntries([entry({ id: 7, message: 'boot sequence' })]);
    const panel = show();

    expect(panels).toHaveLength(1);
    expect(panel.viewType).toBe('kbengine.logViewer');
    expect(panel.title).toBe('KBEngine Logs');
    expect(panel.column).toBe(ViewColumn.Two);
    expect(panel.options.enableScripts).toBe(true);
    expect(panel.webview.handlers).toHaveLength(1);
    expect(panel.disposeHandlers).toHaveLength(1);
    expect(panel.webview.html).toContain('<!DOCTYPE html>');
    expect(panel.webview.html).toContain('FAKE STATUS');
    expect(panel.webview.html).toContain('boot sequence');
  });

  it('renders the empty state when no logs exist', () => {
    const panel = show();

    expect(panel.webview.html).toContain('暂无日志');
  });

  it('reveals the existing panel instead of creating a second one', () => {
    const webview = makeWebView();
    webview.show();
    const panel = currentPanel();

    // panel 是实例私有状态:同一实例二次 show 走 reveal 分支
    webview.show();

    expect(panels).toHaveLength(1);
    expect(panel.revealCalls).toBe(1);
  });

  it('builds a fresh panel after the previous one is disposed', () => {
    const webview = makeWebView();
    webview.show();
    const first = currentPanel();
    expect(first.disposeHandlers).toHaveLength(1);

    first.disposeHandlers[0]();
    webview.show();
    const second = currentPanel();

    expect(panels).toHaveLength(2);
    expect(second).not.toBe(first);
    expect(second.webview.html).toContain('<!DOCTYPE html>');
  });

  it('pushes collector entries into the live panel html', () => {
    const panel = show();
    fake.emit(entry({ id: 9, component: 'baseapp', message: 'live tail' }));

    expect(panel.webview.html).toContain('live tail');
    expect(panel.webview.html).toContain('BASEAPP');
  });
});

describe('LogViewerWebView message handling', () => {
  it('replaces the whole filter and re-renders', () => {
    fake.setEntries([
      entry({ id: 1, level: LogLevel.INFO, message: 'keep calm' }),
      entry({ id: 2, level: LogLevel.ERROR, message: 'explode' })
    ]);
    const panel = show();

    send({
      command: 'filter',
      filter: { levels: [LogLevel.ERROR], components: [], keyword: '', useRegex: false }
    });

    expect(panel.webview.html).toContain('explode');
    expect(panel.webview.html).not.toContain('keep calm');
  });

  it('applies search keyword and regex flag on top of the current filter', () => {
    fake.setEntries([
      entry({ id: 1, message: 'hero spawned' }),
      entry({ id: 2, message: 'bot spawned' }),
      entry({ id: 3, message: 'world saved' })
    ]);
    const panel = show();

    send({ command: 'search', keyword: 'spawned', useRegex: false });
    expect(panel.webview.html).toContain('hero spawned');
    expect(panel.webview.html).not.toContain('world saved');

    send({ command: 'search', keyword: 'hero|world', useRegex: true });
    expect(panel.webview.html).toContain('hero spawned');
    expect(panel.webview.html).toContain('world saved');
    expect(panel.webview.html).not.toContain('bot spawned');
  });

  it('clears logs, notifies the collector and re-renders the empty state', () => {
    fake.setEntries([entry({ id: 1 })]);
    const panel = show();

    send({ command: 'clear' });

    expect(fake.stats().cleared).toBe(1);
    expect(panel.webview.html).toContain('暂无日志');
  });

  it('forwards disconnect to the collector', () => {
    show();
    send({ command: 'disconnect' });

    expect(fake.stats().disconnected).toBe(1);
  });

  it('connects through the collector without errors', async () => {
    show();
    send({ command: 'connect' });

    await until(() => fake.stats().connected === 1);
    expect(messages.error).toEqual([]);
  });

  it('surfaces collector connect failures through the error channel', async () => {
    fake.failConnect('port closed');
    show();
    send({ command: 'connect' });

    await until(() => messages.error.length === 1);
    expect(messages.error[0]).toBe('日志连接不可用: port closed');
  });
});

describe('LogViewerWebView exportLogs', () => {
  const logsPath = '/tmp/kode-export/logs.txt';
  const jsonPath = '/tmp/kode-export/logs.json';

  it('writes the formatted text export and reports success', async () => {
    fake.setEntries([
      entry({ id: 1, message: 'first line' }),
      entry({ id: 2, message: 'second line' })
    ]);
    show();
    saveDialogUris.push(Uri.file(logsPath));

    send({ command: 'export' });
    await until(() => messages.info.length === 1);

    const written = memoryFileSystem.files.get(logsPath) as Buffer;
    expect(written.toString('utf8')).toBe(
      [
        LogParser.formatLogEntry(entry({ id: 1, message: 'first line' })),
        LogParser.formatLogEntry(entry({ id: 2, message: 'second line' }))
      ].join('\n')
    );
    expect(messages.info[0]).toBe(`日志已导出到 ${logsPath}`);
  });

  it('writes pretty-printed json when the target ends with .json', async () => {
    const entries = [entry({ id: 3, message: 'json bound' })];
    fake.setEntries(entries);
    show();
    saveDialogUris.push(Uri.file(jsonPath));

    send({ command: 'export' });
    await until(() => messages.info.length === 1);

    const written = memoryFileSystem.files.get(jsonPath) as Buffer;
    expect(JSON.parse(written.toString('utf8'))).toEqual(
      entries.map(item => ({ ...item, timestamp: item.timestamp.toISOString() }))
    );
  });

  it('exports only the filtered subset', async () => {
    fake.setEntries([
      entry({ id: 1, component: 'cellapp', message: 'cell line' }),
      entry({ id: 2, component: 'baseapp', message: 'base line' })
    ]);
    const panel = show();
    send({
      command: 'filter',
      filter: {
        levels: [],
        components: ['baseapp'],
        keyword: '',
        useRegex: false
      }
    });
    saveDialogUris.push(Uri.file(logsPath));

    send({ command: 'export' });
    await until(() => messages.info.length === 1);

    const written = memoryFileSystem.files.get(logsPath) as Buffer;
    expect(written.toString('utf8')).toContain('base line');
    expect(written.toString('utf8')).not.toContain('cell line');
    expect(panel.webview.html).toContain('base line');
  });

  it('does nothing when the save dialog is cancelled', async () => {
    fake.setEntries([entry({ id: 1 })]);
    show();
    saveDialogUris.push(undefined);

    send({ command: 'export' });
    await new Promise(resolve => setTimeout(resolve, 30));

    expect(memoryFileSystem.files.size).toBe(0);
    expect(messages.info).toEqual([]);
    expect(messages.error).toEqual([]);
  });

  it('reports write failures through the error channel', async () => {
    fake.setEntries([entry({ id: 1 })]);
    show();
    saveDialogUris.push(Uri.file(logsPath));
    stubWorkspace.fs.writeFile = async () => {
      throw new Error('disk full');
    };

    send({ command: 'export' });
    await until(() => messages.error.length === 1);

    expect(messages.error[0]).toBe('导出日志失败: Error: disk full');
    expect(messages.info).toEqual([]);
  });
});
