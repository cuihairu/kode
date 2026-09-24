import type * as vscode from 'vscode';
import { describe, expect, it } from 'vitest';
import { KBEngineLogCollector } from '../src/logCollector';
import { LogViewerWebView } from '../src/logWebView';
import { LogEntry, LogLevel, LogType } from '../src/logParser';
import type { LogFilter } from '../src/logWebView';

// LogViewerWebView 的纯渲染/过滤逻辑:webview 面板(show)与消息处理
// 依赖真实 vscode.WebviewPanel,不在纯逻辑测试域。collector 用真实例,
// 私有方法(applyFilter/formatLogEntry/escapeHtml)经实例直调。

const makeCollector = () =>
  new KBEngineLogCollector(
    {
      host: '127.0.0.1',
      port: 30000,
      autoReconnect: false,
      reconnectInterval: 1000,
      maxBufferSize: 100
    },
    {} as unknown as vscode.ExtensionContext
  );

const makeWebView = () =>
  new LogViewerWebView({} as unknown as vscode.ExtensionContext, makeCollector());

const internals = (webview: LogViewerWebView) =>
  webview as unknown as {
    filter: LogFilter;
    currentLogs: LogEntry[];
    applyFilter: (logs: LogEntry[]) => LogEntry[];
    formatLogEntry: (log: LogEntry) => string;
    escapeHtml: (text: string) => string;
    getHtml: (logs: LogEntry[]) => string;
  };

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

describe('LogViewerWebView.applyFilter', () => {
  it('passes everything through an empty filter untouched', () => {
    const webview = makeWebView();
    const impl = internals(webview);
    const logs = [entry({ id: 1 }), entry({ id: 2, level: LogLevel.ERROR })];

    expect(impl.filter).toEqual({ levels: [], components: [], keyword: '', useRegex: false });
    expect(impl.applyFilter(logs)).toBe(logs);
  });

  it('filters by levels and components', () => {
    const webview = makeWebView();
    const impl = internals(webview);
    const logs = [
      entry({ id: 1, component: 'cellapp', level: LogLevel.INFO }),
      entry({ id: 2, component: 'baseapp', level: LogLevel.ERROR }),
      entry({ id: 3, component: 'cellapp', level: LogLevel.ERROR })
    ];

    impl.filter.levels = [LogLevel.ERROR];
    expect(impl.applyFilter(logs).map(e => e.id)).toEqual([2, 3]);

    impl.filter.levels = [];
    impl.filter.components = ['cellapp'];
    expect(impl.applyFilter(logs).map(e => e.id)).toEqual([1, 3]);
  });

  it('matches keywords case-insensitively and via regex', () => {
    const webview = makeWebView();
    const impl = internals(webview);
    const logs = [entry({ id: 1, message: 'Hero#1 created' }), entry({ id: 2, message: 'save FAILED' })];

    impl.filter.keyword = 'FAILED';
    expect(impl.applyFilter(logs).map(e => e.id)).toEqual([2]);

    impl.filter.keyword = 'created|save';
    impl.filter.useRegex = true;
    expect(impl.applyFilter(logs).map(e => e.id)).toEqual([1, 2]);

    // 非法正则:catch 分支退回不过滤
    impl.filter.keyword = '[invalid';
    expect(impl.applyFilter(logs).map(e => e.id)).toEqual([1, 2]);
  });
});

describe('LogViewerWebView.formatLogEntry and escapeHtml', () => {
  it('escapes the five html specials', () => {
    const impl = internals(makeWebView());

    expect(impl.escapeHtml('&<>"\'')).toBe('&amp;&lt;&gt;&quot;&#039;');
    expect(impl.escapeHtml('plain text')).toBe('plain text');
  });

  it('renders level class, icon, component color and escaped message', () => {
    const webview = makeWebView();
    const impl = internals(webview);
    const html = impl.formatLogEntry(entry({
      component: 'machine',
      level: LogLevel.INFO,
      message: 'villains & <heroes>',
      raw: 'raw<line>'
    }));

    expect(html).toContain('log-entry level-info');
    expect(html).toContain('ℹ️ MACHINE');
    expect(html).toContain('background-color: #9C27B0');
    expect(html).toContain('villains &amp; &lt;heroes&gt;');
    // title 属性按实现现状直接插入未转义的 raw(与 message 的转义不对称)
    expect(html).toContain('title="raw<line>"');
    expect(html).toContain('log-timestamp');
  });

  it('falls back to the gray color for unknown components', () => {
    const impl = internals(makeWebView());
    const html = impl.formatLogEntry(entry({ component: 'unknown-thing', level: LogLevel.ERROR }));

    expect(html).toContain('log-entry level-error');
    expect(html).toContain('background-color: #757575');
  });
});

describe('LogViewerWebView.getHtml', () => {
  it('renders the document skeleton with entries and the collector status', () => {
    const collector = makeCollector();
    const webview = new LogViewerWebView({} as unknown as vscode.ExtensionContext, collector);
    const html = internals(webview).getHtml([
      entry({ level: LogLevel.CRITICAL, component: 'baseappmgr' })
    ]);

    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('<title>KBEngine Logs</title>');
    expect(html).toContain('log-entry level-critical');
    expect(html).toContain('🔥 BASEAPPMGR');
    // 状态摘要来自真实 collector(未连接)
    expect(html).toContain('未连接');
  });
});

describe('LogViewerWebView log subscription', () => {
  it('accumulates collector entries without needing a panel', () => {
    const collector = makeCollector();
    const webview = new LogViewerWebView({} as unknown as vscode.ExtensionContext, collector);
    const impl = internals(webview);

    expect(impl.currentLogs).toEqual([]);

    const push = collector as unknown as { pushLogEntry: (entry: LogEntry) => void };
    push.pushLogEntry(entry({ id: 5 }));
    push.pushLogEntry(entry({ id: 6 }));

    expect(impl.currentLogs.map(e => e.id)).toEqual([5, 6]);
  });
});
