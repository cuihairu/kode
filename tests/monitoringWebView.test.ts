import type * as vscode from 'vscode';
import { describe, expect, it } from 'vitest';
import {
  MonitoringCollector,
  MonitoringDiagnostic
} from '../src/monitoringCollector';
import type { ComponentMetrics } from '../src/monitoringCollector';
import { MonitoringWebView } from '../src/monitoringWebView';

// MonitoringWebView 的纯过滤/聚合/渲染逻辑:webview 面板(show)与消息
// 处理依赖真实 vscode.WebviewPanel,不在纯逻辑测试域。collector 用真实例,
// 私有方法经实例直调,零 mock。

const makeCollector = () =>
  new MonitoringCollector({} as unknown as vscode.ExtensionContext);

const makeWebView = () =>
  new MonitoringWebView({} as unknown as vscode.ExtensionContext, makeCollector());

const internals = (webview: MonitoringWebView) =>
  webview as unknown as {
    componentFilter: string;
    diagnosticFilter: string;
    keywordFilter: string;
    escapeHtml: (text: string) => string;
    applyMetricFilter: (metrics: ComponentMetrics[]) => ComponentMetrics[];
    applyDiagnosticFilter: (
      diagnostics: MonitoringDiagnostic[],
      metrics: ComponentMetrics[]
    ) => MonitoringDiagnostic[];
    buildOverview: (metrics: ComponentMetrics[]) => ReturnType<MonitoringCollector['getSystemOverview']>;
    buildHistorySeries: (metrics: ComponentMetrics[], length: number) => Array<{
      component: string;
      points: Array<{ timestamp: string; cpuUsage: number; entityCount: number }>;
    }>;
    formatMetricCard: (metric: ComponentMetrics) => string;
    formatDiagnostic: (item: MonitoringDiagnostic) => string;
    getHtml: (
      overview: ReturnType<MonitoringCollector['getSystemOverview']>,
      metrics: ComponentMetrics[],
      diagnostics: MonitoringDiagnostic[]
    ) => string;
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

describe('MonitoringWebView.escapeHtml', () => {
  it('escapes the five html specials', () => {
    const impl = internals(makeWebView());

    expect(impl.escapeHtml('&<>"\'')).toBe('&amp;&lt;&gt;&quot;&#039;');
  });
});

describe('MonitoringWebView.applyMetricFilter', () => {
  it('passes everything through empty filters', () => {
    const impl = internals(makeWebView());
    const metrics = [metric({ componentID: 1 }), metric({ componentID: 2, componentType: 'baseapp' })];

    expect(impl.componentFilter).toBe('');
    expect(impl.keywordFilter).toBe('');
    // 实现无条件走 filter(),空过滤返回内容相同的新数组
    expect(impl.applyMetricFilter(metrics)).toEqual(metrics);
    expect(impl.applyMetricFilter(metrics)).not.toBe(metrics);
  });

  it('filters by exact component type', () => {
    const impl = internals(makeWebView());
    const metrics = [
      metric({ componentID: 1 }),
      metric({ componentID: 2, componentType: 'baseapp', component: 'baseapp1' })
    ];

    impl.componentFilter = 'baseapp';
    expect(impl.applyMetricFilter(metrics).map(m => m.componentID)).toEqual([2]);
  });

  it('matches keywords across component, address, status and details', () => {
    const impl = internals(makeWebView());
    const metrics = [
      metric({
        componentID: 1,
        details: [{ label: 'entities', value: 'Hero*12' }]
      }),
      metric({
        componentID: 2,
        componentType: 'baseapp',
        component: 'baseapp1',
        internalAddress: '127.0.0.1:21001'
      })
    ];

    impl.keywordFilter = 'HERO';
    // 命中 details 的 'entities:Hero*12',大小写不敏感
    expect(impl.applyMetricFilter(metrics).map(m => m.componentID)).toEqual([1]);

    impl.keywordFilter = '  baseapp  ';
    // trim 后命中 componentType
    expect(impl.applyMetricFilter(metrics).map(m => m.componentID)).toEqual([2]);

    impl.keywordFilter = '20001';
    // 命中 internalAddress
    expect(impl.applyMetricFilter(metrics).map(m => m.componentID)).toEqual([1]);
  });
});

describe('MonitoringWebView.applyDiagnosticFilter', () => {
  const metrics = [
    metric({ componentID: 1 }),
    metric({ componentID: 2, componentType: 'baseapp', component: 'baseapp1' })
  ];
  const diagnostics = [
    diagnostic({ source: 'machine', message: 'discovery ok' }),
    diagnostic({ source: 'watcher', severity: 'warning', component: 'cellapp1', message: 'high cpu' }),
    diagnostic({ source: 'collector', severity: 'error', component: 'baseapp1', message: 'query failed' })
  ];

  it('filters by exact severity', () => {
    const impl = internals(makeWebView());

    impl.diagnosticFilter = 'error';
    expect(impl.applyDiagnosticFilter(diagnostics, metrics)).toHaveLength(1);
    expect(impl.applyDiagnosticFilter(diagnostics, metrics)[0].severity).toBe('error');
  });

  it('drops diagnostics whose component is of another filtered type', () => {
    const impl = internals(makeWebView());

    impl.componentFilter = 'baseapp';
    const kept = impl.applyDiagnosticFilter(diagnostics, metrics);
    // cellapp1 属于 cellapp 类型被剔除;machine 诊断无 component 保留
    expect(kept.map(d => d.source)).toEqual(['machine', 'collector']);
  });

  it('matches keywords across source, component and message', () => {
    const impl = internals(makeWebView());

    impl.keywordFilter = 'cpu';
    expect(impl.applyDiagnosticFilter(diagnostics, metrics).map(d => d.message)).toEqual(['high cpu']);

    impl.keywordFilter = 'machine';
    expect(impl.applyDiagnosticFilter(diagnostics, metrics).map(d => d.source)).toEqual(['machine']);
  });
});

describe('MonitoringWebView.buildOverview', () => {
  it('sums every metric into the six-field overview', () => {
    const impl = internals(makeWebView());
    const overview = impl.buildOverview([
      metric({ entityCount: 5, connections: 2, messagesPerSecond: 7, memoryUsage: 100, cpuUsage: 10 }),
      metric({
        componentID: 2,
        componentType: 'baseapp',
        component: 'baseapp1',
        entityCount: 6,
        connections: 3,
        messagesPerSecond: 8,
        memoryUsage: 200,
        cpuUsage: 20
      })
    ]);

    expect(overview).toEqual({
      totalEntities: 11,
      totalConnections: 5,
      totalMessagesPerSecond: 15,
      runningComponents: 2,
      totalMemoryUsage: 300,
      totalCpuUsage: 30
    });
  });

  it('returns the zero overview for no metrics', () => {
    const impl = internals(makeWebView());

    expect(impl.buildOverview([])).toEqual({
      totalEntities: 0,
      totalConnections: 0,
      totalMessagesPerSecond: 0,
      runningComponents: 0,
      totalMemoryUsage: 0,
      totalCpuUsage: 0
    });
  });
});

describe('MonitoringWebView.buildHistorySeries', () => {
  it('maps collector history into per-component chart points', () => {
    const collector = makeCollector();
    const webview = new MonitoringWebView({} as unknown as vscode.ExtensionContext, collector);
    const impl = internals(webview);
    const store = (collector as unknown as {
      metricsHistory: Map<string, ComponentMetrics[]>;
    }).metricsHistory;

    const first = metric({ componentID: 1, cpuUsage: 10, entityCount: 5, uptime: 10 });
    const second = metric({ componentID: 1, cpuUsage: 20, entityCount: 6, uptime: 20 });
    store.set('cellapp1', [first, second]);

    const series = impl.buildHistorySeries([first], 30);

    expect(series).toHaveLength(1);
    expect(series[0].component).toBe('cellapp1');
    expect(series[0].points.map(p => p.cpuUsage)).toEqual([10, 20]);
    expect(series[0].points.map(p => p.entityCount)).toEqual([5, 6]);
    expect(series[0].points[0].timestamp).toBe(first.lastUpdate.toISOString());
  });
});

describe('MonitoringWebView.formatMetricCard', () => {
  it('renders status classes, thresholds and pooled rows', () => {
    const impl = internals(makeWebView());
    const html = impl.formatMetricCard(metric({
      component: 'cellapp1',
      componentType: 'cellapp',
      cpuUsage: 90,
      statusLevel: 'error',
      load: 0.5,
      uptime: 600,
      details: [{ label: 'entities', value: 'Hero<12>' }]
    }));

    expect(html).toContain('CELLAPP1');
    expect(html).toContain('metric-status error');
    expect(html).toContain('progress-fill error');
    expect(html).toContain('90.0%');
    expect(html).toContain('50.0%');
    expect(html).toContain('10 分钟');
    // cellapp 的明细标题是 Object Pools
    expect(html).toContain('Object Pools');
    expect(html).toContain('entities');
    expect(html).toContain('Hero&lt;12&gt;');
    // 对象池行出现(metric helper 默认 size=2/memory=1)
    expect(html).toContain('对象池容量');
    expect(html).toContain('1 B');
  });

  it('warns above 50% cpu and hides pool rows when both pool fields are zero', () => {
    const impl = internals(makeWebView());
    const html = impl.formatMetricCard(metric({
      component: 'baseapp1',
      componentType: 'baseapp',
      cpuUsage: 60,
      statusLevel: 'warning',
      objectPoolSize: 0,
      objectPoolMemory: 0
    }));

    expect(html).toContain('progress-fill warning');
    expect(html).toContain('metric-status warning');
    expect(html).toContain('Watcher Details');
    expect(html).not.toContain('对象池容量');
  });

  it('keeps neutral classes below thresholds', () => {
    const impl = internals(makeWebView());
    const html = impl.formatMetricCard(metric());

    expect(html).toContain('metric-status ');
    expect(html).toContain('progress-fill ');
    expect(html).not.toContain('progress-fill error');
    expect(html).not.toContain('progress-fill warning');
  });
});

describe('MonitoringWebView.formatDiagnostic', () => {
  it('renders severity classes and scoped sources', () => {
    const impl = internals(makeWebView());
    const html = impl.formatDiagnostic(diagnostic({
      severity: 'warning',
      source: 'watcher',
      component: 'cellapp1',
      message: 'cpu & load <high>'
    }));

    expect(html).toContain('diagnostic-item warning');
    expect(html).toContain('watcher:cellapp1');
    expect(html).toContain('cpu &amp; load &lt;high&gt;');
  });

  it('uses the bare source without a component and no class for info', () => {
    const impl = internals(makeWebView());
    const html = impl.formatDiagnostic(diagnostic());

    expect(html).toContain('diagnostic-item ');
    // meta 格式为 "scope | 时间",无 component 时 scope 就是裸 source
    expect(html).toContain('>collector |');
  });
});

describe('MonitoringWebView.getHtml', () => {
  it('renders the document skeleton with overview, cards and diagnostics', () => {
    const impl = internals(makeWebView());
    const overview = impl.buildOverview([metric()]);
    const html = impl.getHtml(overview, [metric()], [diagnostic()]);

    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    // 组件类型下拉来自当前 metrics 的去重排序
    expect(html).toContain('cellapp');
    expect(html).toContain('CELLAPP1');
    expect(html).toContain('diagnostic-item');
    expect(html).toContain('snapshot ok');
  });
});
