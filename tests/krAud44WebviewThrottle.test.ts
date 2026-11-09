import type * as vscode from 'vscode';
import { beforeEach, describe, expect, it } from 'vitest';
import { KBEngineLogCollector } from '../src/logCollector';
import { LogViewerWebView } from '../src/logWebView';
import { LogEntry, LogLevel, LogType } from '../src/backend/logParser';
import type { ComponentMetrics, MonitoringCollector } from '../src/monitoringCollector';
import { MonitoringWebView } from '../src/monitoringWebView';
import { panelRegistry, Uri, windowState } from './helpers/vscodeStub';
import type { FakeWebviewPanel } from './helpers/vscodeStub';

// KR-AUD-44:高频路径节流 + append-only。
// - logWebView:collector 直连路径此前每条日志整页重渲(getHtml 全量重建),
//   与 logHub 的增量 appendLogs 路径并存却没走它;现在按窗口攒批,窗口结束
//   一次性 postMessage 追加(过滤仍走整页重渲,那是用户动作不是热路径)。
// - monitoringWebView:collector 每拍 onMetricsUpdate 直接整页重建(含 Chart.js
//   重建),突发更新按尾沿节流合并成至多一次渲染;过滤/显隐等用户动作即时渲。
// 判别点:窗口内 html 字节不动、零重渲;窗口结束后恰好一批 appendLogs;
// 过滤消息仍同步渲染。

const ctx = { extensionUri: Uri.file('/ext/root') } as unknown as vscode.ExtensionContext;

/** 窗口时长须小于本等待(源码常量 + 余量) */
const WAIT_FLUSH_MS = 600;

const sleep = (ms: number): Promise<void> =>
  new Promise(resolve => { setTimeout(resolve, ms); });

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

interface FakeLogCollector {
  collector: KBEngineLogCollector;
  emit(logEntry: LogEntry): void;
}

const makeFakeLogCollector = (): FakeLogCollector => {
  const listeners: Array<(logEntry: LogEntry) => void> = [];
  const state = { entries: [] as LogEntry[] };
  const collector = {
    onLogEntry: (listener: (logEntry: LogEntry) => void) => {
      listeners.push(listener);
      return { dispose: () => undefined };
    },
    getLogEntries: () => [...state.entries],
    clearLogs: () => { state.entries = []; },
    getStatusSummary: () => 'FAKE STATUS',
    connect: async () => undefined,
    disconnect: () => undefined
  } as unknown as KBEngineLogCollector;
  return {
    collector,
    emit: (logEntry: LogEntry) => {
      for (const listener of [...listeners]) {
        listener(logEntry);
      }
    }
  };
};

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
  objectPoolSize: 10,
  uptime: 10,
  status: 'running',
  statusLevel: 'info',
  details: [],
  lastUpdate: new Date(Date.UTC(2026, 8, 24, 12, 0, 0)),
  ...over
});

interface FakeMonitoringCollector {
  collector: MonitoringCollector;
  fireUpdate(): void;
}

const makeFakeMonitoringCollector = (): FakeMonitoringCollector => {
  let listener: (() => void) | null = null;
  const overview = {
    totalComponents: 1,
    runningComponents: 1,
    totalCpu: 10,
    totalMemory: 100,
    averageLoad: 0.5,
    totalConnections: 2,
    totalEntities: 5,
    totalMessagesPerSecond: 7,
    status: 'running' as const
  };
  const collector = {
    onMetricsUpdate: (callback: () => void) => {
      listener = callback;
      return { dispose: () => undefined };
    },
    start: () => undefined,
    stop: () => undefined,
    dispose: () => undefined,
    getAllMetrics: () => [metric()],
    getDiagnostics: () => [],
    getSystemOverview: () => overview,
    getRefreshInterval: () => 2000,
    getMetricsHistory: () => [],
    getStatusSummary: () => '1 运行中',
    setRefreshInterval: () => undefined,
    refreshNow: async () => undefined,
    isPaused: () => false,
    pause: () => undefined,
    resume: () => undefined
  } as unknown as MonitoringCollector;
  return {
    collector,
    fireUpdate: () => listener?.()
  };
};

/** html 写入计数(替换面板 webview.html 的数据属性) */
const countHtmlWrites = (panel: FakeWebviewPanel): { writes: () => number } => {
  let html = panel.webview.html;
  let writes = 0;
  Object.defineProperty(panel.webview, 'html', {
    configurable: true,
    get: () => html,
    set: (value: string) => {
      html = value;
      writes += 1;
    }
  });
  return { writes: () => writes };
};

beforeEach(() => {
  panelRegistry.reset();
  windowState.reset();
});

describe('KR-AUD-44: logWebView collector 路径 append-only + 节流', () => {
  it('窗口内连续 N 条日志零重渲,窗口结束恰好一批 appendLogs', async () => {
    const fake = makeFakeLogCollector();
    const view = new LogViewerWebView(ctx, fake.collector);
    view.show();
    const panel = panelRegistry.panels[0];
    const htmlBefore = panel.webview.html;
    const counter = countHtmlWrites(panel);

    for (let index = 0; index < 5; index += 1) {
      fake.emit(entry({ id: index + 1, message: `line ${index}` }));
    }

    expect(counter.writes()).toBe(0);
    expect(panel.webview.html).toBe(htmlBefore);
    expect(panel.webview.postedMessages).toHaveLength(0);

    await sleep(WAIT_FLUSH_MS);

    const appends = panel.webview.postedMessages
      .map(item => item.message as { command: string; events: unknown[] })
      .filter(message => message.command === 'appendLogs');
    expect(appends).toHaveLength(1);
    expect(appends[0].events).toHaveLength(5);
    expect(counter.writes()).toBe(0);
    view.dispose();
  });

  it('过滤激活时只追加命中的条目;过滤切换本身仍整页重渲', async () => {
    const fake = makeFakeLogCollector();
    const view = new LogViewerWebView(ctx, fake.collector);
    view.show();
    const panel = panelRegistry.panels[0];

    panelRegistry.fireMessage(panel, {
      command: 'filter',
      filter: { levels: [LogLevel.ERROR], components: [], keyword: '', useRegex: false }
    });
    const htmlAfterFilter = panel.webview.html;
    expect(htmlAfterFilter).not.toBe('');

    fake.emit(entry({ id: 1, level: LogLevel.INFO, message: 'ignored info' }));
    fake.emit(entry({ id: 2, level: LogLevel.ERROR, message: 'kept error' }));
    await sleep(WAIT_FLUSH_MS);

    const appends = panel.webview.postedMessages
      .map(item => item.message as { command: string; events: Array<{ level: number; text: string }> })
      .filter(message => message.command === 'appendLogs');
    expect(appends).toHaveLength(1);
    expect(appends[0].events).toHaveLength(1);
    expect(appends[0].events[0].text).toBe('kept error');
    view.dispose();
  });

  it('面板重建(show 全量渲染)后不重复追加窗口内已渲染的条目', async () => {
    const fake = makeFakeLogCollector();
    const view = new LogViewerWebView(ctx, fake.collector);
    view.show();
    const panel = panelRegistry.panels[0];

    fake.emit(entry({ id: 1, message: 'pending one' }));
    // 窗口未到即触发整页重渲(用户改过滤):待发批必须作废,防重复追加
    panelRegistry.fireMessage(panel, {
      command: 'search',
      keyword: 'pending',
      useRegex: false
    });
    await sleep(WAIT_FLUSH_MS);

    const appends = panel.webview.postedMessages
      .map(item => item.message as { command: string })
      .filter(message => message.command === 'appendLogs');
    expect(appends).toHaveLength(0);
    view.dispose();
  });

  it('dispose 作废在排的攒批:窗口到期后零追加', async () => {
    const fake = makeFakeLogCollector();
    const view = new LogViewerWebView(ctx, fake.collector);
    view.show();
    const panel = panelRegistry.panels[0];

    fake.emit(entry({ id: 1, message: 'never flushed' }));
    view.dispose();
    await sleep(WAIT_FLUSH_MS);

    expect(panel.webview.postedMessages).toHaveLength(0);
  });
});

describe('KR-AUD-44: monitoringWebView 数据更新节流', () => {
  it('突发 10 次 onMetricsUpdate 窗口内零重渲,窗口结束至多一次;过滤即时', async () => {
    const fake = makeFakeMonitoringCollector();
    const view = new MonitoringWebView(ctx, fake.collector);
    view.show();
    const panel = panelRegistry.panels[0];
    const counter = countHtmlWrites(panel);

    for (let index = 0; index < 10; index += 1) {
      fake.fireUpdate();
    }
    expect(counter.writes()).toBe(0);

    await sleep(WAIT_FLUSH_MS);
    expect(counter.writes()).toBe(1);

    panelRegistry.fireMessage(panel, {
      command: 'setFilters',
      componentType: 'cellapp',
      diagnosticSeverity: '',
      keyword: ''
    });
    expect(counter.writes()).toBe(2);
    view.dispose();
  });

  it('dispose 作废在排的节流渲染:窗口到期后零重渲', async () => {
    const fake = makeFakeMonitoringCollector();
    const view = new MonitoringWebView(ctx, fake.collector);
    view.show();
    const panel = panelRegistry.panels[0];
    const counter = countHtmlWrites(panel);

    fake.fireUpdate();
    view.dispose();
    await sleep(WAIT_FLUSH_MS);

    expect(counter.writes()).toBe(0);
  });
});
