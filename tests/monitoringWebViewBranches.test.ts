import type * as vscode from 'vscode';
import { describe, expect, it } from 'vitest';
import {
  MonitoringCollector,
  MonitoringDiagnostic
} from '../src/monitoringCollector';
import type { ComponentMetrics } from '../src/monitoringCollector';
import { MonitoringWebView } from '../src/monitoringWebView';

// MonitoringWebView 批66 分支补测:onMetricsUpdate 回调在面板未打开时的
// no-op 臂、诊断/刷新间隔/历史窗口下拉框的选中态假臂、formatDiagnostic
// 的 error 分级臂。回调臂以捕获式 fake collector 直接触发;选项臂经
// getHtml 产物断言。

type Overview = ReturnType<MonitoringCollector['getSystemOverview']>;

const makeCollector = () =>
  new MonitoringCollector({} as unknown as vscode.ExtensionContext);

// getHtml 依赖 collector 的状态查询接口,渲染类用例一律挂真实 collector;
// 捕获式 fake collector 只服务面板未打开的回调 no-op 用例。
const makeWebView = () =>
  new MonitoringWebView({} as unknown as vscode.ExtensionContext, makeCollector());

const internals = (webview: MonitoringWebView) =>
  webview as unknown as {
    panel: unknown;
    diagnosticFilter: string;
    historyWindow: number;
    buildOverview: (metrics: ComponentMetrics[]) => Overview;
    formatDiagnostic: (item: MonitoringDiagnostic) => string;
    getHtml: (
      overview: Overview,
      metrics: ComponentMetrics[],
      diagnostics: MonitoringDiagnostic[]
    ) => string;
  };

const makeWebViewWithCapturedUpdate = (): { webview: MonitoringWebView; fireUpdate: () => void } => {
  let handler: (() => void) | null = null;
  const fakeCollector = {
    onMetricsUpdate: (listener: () => void) => {
      handler = listener;
      return { dispose: () => undefined };
    }
  } as unknown as MonitoringCollector;
  const webview = new MonitoringWebView({} as unknown as vscode.ExtensionContext, fakeCollector);
  return {
    webview,
    fireUpdate: () => handler?.()
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

describe('MonitoringWebView branch gaps (批66)', () => {
  it('drops metric updates fired before the panel opens', () => {
    const { webview, fireUpdate } = makeWebViewWithCapturedUpdate();
    const impl = internals(webview);

    // 构造后未 show ⇒ panel 为 null,回调走 no-op 臂且不得触达 updateWebView
    expect(impl.panel).toBeNull();
    expect(() => fireUpdate()).not.toThrow();
  });

  it('marks the selected option for warning and error diagnostic filters', () => {
    const impl = internals(makeWebView());
    const overview = impl.buildOverview([metric()]);
    const render = () => impl.getHtml(overview, [metric()], []);

    impl.diagnosticFilter = 'warning';
    expect(render()).toContain('value="warning" selected');

    impl.diagnosticFilter = 'error';
    expect(render()).toContain('value="error" selected');
  });

  it('marks the selected option for the 1s and 10s refresh intervals', () => {
    const collector = makeCollector();
    const impl = internals(
      new MonitoringWebView({} as unknown as vscode.ExtensionContext, collector)
    );
    const overview = impl.buildOverview([metric()]);
    const render = () => impl.getHtml(overview, [metric()], []);

    collector.setRefreshInterval(1000);
    expect(render()).toContain('value="1000" selected');

    collector.setRefreshInterval(10000);
    expect(render()).toContain('value="10000" selected');
  });

  it('marks the selected option for the 120s history window', () => {
    const impl = internals(makeWebView());
    impl.historyWindow = 120;
    const overview = impl.buildOverview([metric()]);

    expect(impl.getHtml(overview, [metric()], [])).toContain('value="120" selected');
  });

  it('grades error diagnostics with the error class', () => {
    const impl = internals(makeWebView());

    const html = impl.formatDiagnostic(diagnostic({ severity: 'error', message: 'boom' }));
    expect(html).toContain('diagnostic-item error');
    // 对照:info 分级走空 class 臂(既有覆盖),warning 已由既有用例覆盖
    expect(html).toContain('boom');
  });
});
