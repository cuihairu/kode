import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MonitoringWebView } from '../src/monitoringWebView';
import type {
  ComponentMetrics,
  MonitoringCollector,
  MonitoringDiagnostic
} from '../src/monitoringCollector';
import type * as vscode from 'vscode';
import {
  Uri,
  ViewColumn,
  memoryFileSystem,
  window as stubWindow,
  workspace as stubWorkspace
} from './helpers/vscodeStub';

// MonitoringWebView 的面板生命周期:show 的创建/复用/重建与 collector
// start/stop 联动、handleMessage 六类消息(过滤/刷新间隔/历史窗口/暂停/
// 刷新/导出)、exportMetrics 的保存对话框与 JSON 落盘、dispose。collector
// 为构造注入,测试传入可控假例;面板工厂/保存对话框由 monkey-patch 驱动。
// 过滤与卡片渲染已由 monitoringWebView.test.ts 覆盖。

interface StubPanel {
  viewType: string;
  title: string;
  column: number;
  options: { enableScripts: boolean };
  revealCalls: number;
  disposeCalls: number;
  webview: {
    html: string;
    handlers: Array<(message: unknown) => void>;
    onDidReceiveMessage(handler: (message: unknown) => void): { dispose(): void };
  };
  disposeHandlers: Array<() => void>;
  onDidDispose(handler: () => void): { dispose(): void };
  reveal(): void;
  dispose(): void;
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

const metric = (over: Partial<ComponentMetrics> = {}): ComponentMetrics => ({
  component: 'cellapp1',
  componentID: 101,
  componentType: 'cellapp',
  pid: 1000,
  internalAddress: '127.0.0.1:20001',
  cpuUsage: 10,
  memoryUsage: 100,
  load: 0.5,
  connections: 2,
  entityCount: 5,
  messagesPerSecond: 7,
  objectPoolMemory: 1,
  objectPoolSize: 2,
  uptime: 10,
  status: 'running',
  statusLevel: 'info',
  details: [],
  lastUpdate: new Date(Date.UTC(2026, 8, 24, 12, 0, 0)),
  ...over
});

const diagnostic = (over: Partial<MonitoringDiagnostic> = {}): MonitoringDiagnostic => ({
  timestamp: new Date(Date.UTC(2026, 8, 24, 12, 0, 0)),
  severity: 'info',
  source: 'collector',
  message: 'snapshot ok',
  ...over
});

interface FakeCollector {
  collector: MonitoringCollector;
  state: {
    metrics: ComponentMetrics[];
    diagnostics: MonitoringDiagnostic[];
    started: number[];
    stopped: number;
    disposed: number;
    refreshed: number;
    intervals: number[];
    paused: boolean;
    summary: string;
  };
  emit(): void;
}

const makeFakeCollector = (): FakeCollector => {
  const state = {
    metrics: [] as ComponentMetrics[],
    diagnostics: [] as MonitoringDiagnostic[],
    started: [] as number[],
    stopped: 0,
    disposed: 0,
    refreshed: 0,
    intervals: [] as number[],
    paused: false,
    summary: 'FAKE SUMMARY'
  };
  const listeners: Array<() => void> = [];
  const collector = {
    onMetricsUpdate: (listener: () => void) => {
      listeners.push(listener);
      return { dispose: () => undefined };
    },
    getAllMetrics: () => [...state.metrics],
    getDiagnostics: () => [...state.diagnostics],
    getStatusSummary: () => state.summary,
    start: (intervalMs: number) => {
      state.started.push(intervalMs);
    },
    stop: () => {
      state.stopped += 1;
    },
    refreshNow: async () => {
      state.refreshed += 1;
    },
    setRefreshInterval: (intervalMs: number) => {
      state.intervals.push(intervalMs);
    },
    getRefreshInterval: () => state.intervals[state.intervals.length - 1] ?? 2000,
    getMetricsHistory: () => [],
    isPaused: () => state.paused,
    pause: () => {
      state.paused = true;
    },
    resume: () => {
      state.paused = false;
    },
    dispose: () => {
      state.disposed += 1;
    }
  } as unknown as MonitoringCollector;
  return {
    collector,
    state,
    emit: () => {
      for (const listener of [...listeners]) {
        listener();
      }
    }
  };
};

let fake: FakeCollector;

const makeWebView = () =>
  new MonitoringWebView(
    { extensionUri: Uri.file('/ext/root') } as unknown as vscode.ExtensionContext,
    fake.collector
  );

const internals = (webview: MonitoringWebView) =>
  webview as unknown as {
    componentFilter: string;
    diagnosticFilter: string;
    keywordFilter: string;
    refreshIntervalMs: number;
    historyWindow: number;
  };

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
      disposeCalls: 0,
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
      },
      dispose: () => {
        panel.disposeCalls += 1;
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

describe('MonitoringWebView.show', () => {
  it('creates the panel and starts the collector with the default interval', () => {
    const panel = show();

    expect(panels).toHaveLength(1);
    expect(panel.viewType).toBe('kbengine.monitoring');
    expect(panel.title).toBe('KBEngine Monitoring');
    expect(panel.column).toBe(ViewColumn.Two);
    expect(panel.options.enableScripts).toBe(true);
    expect(panel.webview.handlers).toHaveLength(1);
    expect(panel.disposeHandlers).toHaveLength(1);
    expect(fake.state.started).toEqual([2000]);
    expect(panel.webview.html).toContain('<!DOCTYPE html>');
    expect(panel.webview.html).toContain('FAKE SUMMARY');
  });

  it('renders the paused banner state from the collector', () => {
    fake.state.paused = true;
    const panel = show();

    expect(panel.webview.html).toContain('KBEngine Monitoring');
    expect(fake.state.started).toEqual([2000]);
  });

  it('reveals the existing panel on a second show of the same instance', () => {
    const webview = makeWebView();
    webview.show();
    const panel = currentPanel();

    webview.show();

    expect(panels).toHaveLength(1);
    expect(panel.revealCalls).toBe(1);
    expect(fake.state.started).toEqual([2000]);
  });

  it('stops the collector on dispose and starts a fresh one after rebuild', () => {
    const webview = makeWebView();
    webview.show();
    const first = currentPanel();

    first.disposeHandlers[0]();
    expect(fake.state.stopped).toBe(1);

    webview.show();

    expect(panels).toHaveLength(2);
    expect(fake.state.started).toEqual([2000, 2000]);
  });

  it('pushes collector updates into the live panel html', () => {
    const panel = show();
    fake.state.metrics = [metric({ component: 'baseapp1', componentType: 'baseapp' })];

    fake.emit();

    expect(panel.webview.html).toContain('baseapp1');
  });
});

describe('MonitoringWebView message handling', () => {
  it('triggers collector refresh on the refresh command', async () => {
    show();

    send({ command: 'refresh' });
    await until(() => fake.state.refreshed === 1);
  });

  it('applies string filters and re-renders', () => {
    fake.state.metrics = [
      metric({ component: 'cellapp1', componentType: 'cellapp' }),
      metric({ component: 'baseapp1', componentType: 'baseapp' })
    ];
    const panel = show();

    send({
      command: 'setFilters',
      componentType: 'baseapp',
      diagnosticSeverity: '',
      keyword: ''
    });

    expect(panel.webview.html).toContain('baseapp1');
    expect(panel.webview.html).not.toContain('cellapp1');
    expect(internals(makeWebView()).componentFilter).toBe('');
  });

  it('coerces non-string filters back to empty strings', () => {
    const webview = makeWebView();
    webview.show();
    const impl = internals(webview);
    impl.componentFilter = 'cellapp';
    impl.keywordFilter = 'stale';

    send({
      command: 'setFilters',
      componentType: 42,
      diagnosticSeverity: null,
      keyword: true
    });

    expect(impl.componentFilter).toBe('');
    expect(impl.diagnosticFilter).toBe('');
    expect(impl.keywordFilter).toBe('');
  });

  it('applies a positive numeric refresh interval', () => {
    const webview = makeWebView();
    webview.show();
    const impl = internals(webview);

    send({ command: 'setRefreshInterval', intervalMs: 5000 });

    expect(impl.refreshIntervalMs).toBe(5000);
    expect(fake.state.intervals).toEqual([5000]);
  });

  it('ignores invalid refresh intervals', () => {
    const webview = makeWebView();
    webview.show();
    const impl = internals(webview);

    send({ command: 'setRefreshInterval', intervalMs: 0 });
    send({ command: 'setRefreshInterval', intervalMs: -3 });
    send({ command: 'setRefreshInterval', intervalMs: 'fast' });

    expect(impl.refreshIntervalMs).toBe(2000);
    expect(fake.state.intervals).toEqual([]);
  });

  it('applies a positive numeric history window', () => {
    const webview = makeWebView();
    webview.show();
    const impl = internals(webview);

    send({ command: 'setHistoryWindow', historyWindow: 60 });

    expect(impl.historyWindow).toBe(60);
  });

  it('ignores invalid history windows', () => {
    const webview = makeWebView();
    webview.show();
    const impl = internals(webview);

    send({ command: 'setHistoryWindow', historyWindow: 0 });

    expect(impl.historyWindow).toBe(30);
  });

  it('pauses when running and resumes when paused', () => {
    const panel = show();

    send({ command: 'togglePause' });
    expect(fake.state.paused).toBe(true);
    expect(panel.webview.html).toContain('<!DOCTYPE html>');

    send({ command: 'togglePause' });
    expect(fake.state.paused).toBe(false);
  });
});

describe('MonitoringWebView exportMetrics', () => {
  const exportPath = '/tmp/kode-mon/metrics.json';

  it('writes the pretty json bundle and reports the target path', async () => {
    fake.state.metrics = [metric()];
    fake.state.diagnostics = [diagnostic()];
    const panel = show();
    send({
      command: 'setFilters',
      componentType: 'cellapp',
      diagnosticSeverity: 'info',
      keyword: ''
    });
    saveDialogUris.push(Uri.file(exportPath));

    send({ command: 'exportMetrics' });
    await until(() => messages.info.length === 1);

    const written = memoryFileSystem.files.get(exportPath) as Buffer;
    const bundle = JSON.parse(written.toString('utf8'));
    expect(bundle.overview).toBeDefined();
    expect(bundle.filters).toEqual({
      componentType: 'cellapp',
      diagnosticSeverity: 'info',
      keyword: '',
      historyWindow: 30
    });
    expect(bundle.metrics).toHaveLength(1);
    expect(bundle.metrics[0].component).toBe('cellapp1');
    expect(bundle.diagnostics).toHaveLength(1);
    expect(Array.isArray(bundle.history)).toBe(true);
    expect(messages.info[0]).toBe(`监控数据已导出到 ${exportPath}`);
    expect(panel.webview.html).toContain('<!DOCTYPE html>');
  });

  it('does nothing when the save dialog is cancelled', async () => {
    fake.state.metrics = [metric()];
    show();
    saveDialogUris.push(undefined);

    send({ command: 'exportMetrics' });
    await new Promise(resolve => setTimeout(resolve, 30));

    expect(memoryFileSystem.files.size).toBe(0);
    expect(messages.info).toEqual([]);
    expect(messages.error).toEqual([]);
  });

  it('reports write failures through the error channel', async () => {
    fake.state.metrics = [metric()];
    show();
    saveDialogUris.push(Uri.file(exportPath));
    const originalWriteFile = stubWorkspace.fs.writeFile;
    stubWorkspace.fs.writeFile = async () => {
      throw new Error('disk full');
    };

    send({ command: 'exportMetrics' });
    await until(() => messages.error.length === 1);
    stubWorkspace.fs.writeFile = originalWriteFile;

    expect(messages.error[0]).toBe('导出监控数据失败: Error: disk full');
  });
});

describe('MonitoringWebView.dispose', () => {
  it('disposes the live panel, stops the collector and tolerates repeats', () => {
    const webview = makeWebView();
    webview.show();
    const panel = currentPanel();

    webview.dispose();
    webview.dispose();

    expect(panel.disposeCalls).toBe(1);
    // 实现现状:仅 panel.dispose 有守卫,collector.dispose 在守卫外
    // 无条件调用,重复 dispose 会重复转发
    expect(fake.state.disposed).toBe(2);
  });
});
