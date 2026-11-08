// MonitoringWebView UI 重设计(UI-01):
// - 14 张指标行按真实业务域分组(服务进程/性能/连接/存储),组头 <details>
//   可折叠并带条目计数;
// - 面板接入 webviewTheme 统一 token(Material 三色退场);
// - 全部文案走 webviewStrings(zh 默认/en 全量,kbengine.webviewLocale 覆盖)。
import { beforeEach, describe, expect, it } from 'vitest';
import type { ComponentMetrics, SystemOverview } from '../src/monitoringCollector';
import { MonitoringWebView } from '../src/monitoringWebView';
import { configurationOverrides, envState } from './helpers/vscodeStub';

const makeWebView = () =>
  new MonitoringWebView({} as unknown as import('vscode').ExtensionContext, {
    getAllMetrics: () => [],
    getDiagnostics: () => [],
    getStatusSummary: () => 'FAKE SUMMARY',
    onMetricsUpdate: () => ({ dispose: () => undefined }),
    isPaused: () => false,
    getRefreshInterval: () => 2000,
    getMetricsHistory: () => []
  } as never);

const internals = (webview: MonitoringWebView) =>
  webview as unknown as {
    getHtml: (overview: SystemOverview, metrics: ComponentMetrics[], diagnostics: never[]) => string;
  };

const overview: SystemOverview = {
  totalEntities: 5,
  totalConnections: 2,
  totalMessagesPerSecond: 7,
  runningComponents: 1,
  totalMemoryUsage: 100,
  totalCpuUsage: 10
};

const metric = (over: Partial<ComponentMetrics> = {}): ComponentMetrics => ({
  component: 'cellapp1',
  componentID: 101,
  componentType: 'cellapp',
  pid: 1000,
  internalAddress: '127.0.0.1:20001',
  cpuUsage: 91.2,
  memoryUsage: 100,
  load: 0.5,
  connections: 2,
  entityCount: 5,
  messagesPerSecond: 7,
  objectPoolMemory: 1,
  objectPoolSize: 2,
  uptime: 600,
  status: 'running',
  statusLevel: 'info',
  details: [],
  lastUpdate: new Date(Date.UTC(2026, 8, 24, 12, 0, 0)),
  ...over
});

const renderZh = (metrics: ComponentMetrics[] = [metric()]): string => {
  envState.language = 'zh-cn';
  configurationOverrides.delete('kbengine');
  return internals(makeWebView()).getHtml(overview, metrics, []);
};

beforeEach(() => {
  configurationOverrides.delete('kbengine');
  envState.language = 'zh-cn';
});

describe('MonitoringWebView 分类管理重设计(业务域分组)', () => {
  it('labels each filter and refresh control for keyboard and assistive technology', () => {
    const html = renderZh();
    for (const id of ['componentFilter', 'diagnosticFilter', 'keywordFilter', 'refreshInterval', 'historyWindow']) {
      expect(html).toContain(`<label for="${id}">`);
      expect(html).toContain(`id="${id}"`);
    }
    expect(html).toContain('刷新间隔');
    expect(html).toContain('历史范围');
    expect(html).toContain('flex-wrap: wrap');
  });
  it('指标行按真实域分组:服务进程/性能/连接/存储', () => {
    const html = renderZh();
    expect(html).toContain('data-domain="process"');
    expect(html).toContain('data-domain="performance"');
    expect(html).toContain('data-domain="connections"');
    expect(html).toContain('data-domain="storage"');
    expect(html).toContain('服务进程');
    expect(html).toContain('性能');
    expect(html).toContain('连接');
    expect(html).toContain('存储');
  });

  it('组头可折叠(<details>/<summary>)且带条目计数', () => {
    const html = renderZh();
    expect(html).toContain('<details class="mgroup"');
    expect(html).toContain('<summary');
    // process=4(组件类型/状态/运行时间/PID)、performance=4、connections=2、storage=3
    expect(html).toContain('data-count="4"');
    expect(html).toContain('data-count="2"');
    expect(html).toContain('data-count="3"');
  });

  it('设计系统 token 进面板,Material 旧色退场', () => {
    const html = renderZh();
    expect(html).toContain('--kode-ok:#89d185');
    expect(html).toContain('--kode-accent:#3794ff');
    expect(html).not.toContain('#4CAF50');
    expect(html).not.toContain('#FF9800');
    expect(html).not.toContain('#F44336');
    expect(html).not.toContain('rgba(33, 150, 243');
  });
});

describe('MonitoringWebView i18n', () => {
  it('zh:工具条与 KPI 沿用现有中文文案', () => {
    const html = renderZh();
    expect(html).toContain('KBEngine 服务器监控');
    expect(html).toContain('全部组件');
    expect(html).toContain('总实体数');
    expect(html).toContain('服务进程');
  });

  it('en:kbengine.webviewLocale=en 输出英文面板', () => {
    envState.language = 'zh-cn';
    configurationOverrides.set('kbengine', { webviewLocale: 'en' });
    const html = internals(makeWebView()).getHtml(overview, [metric()], []);
    expect(html).toContain('KBEngine Server Monitoring');
    expect(html).toContain('Process');
    expect(html).toContain('Performance');
    expect(html).toContain('Connections');
    expect(html).toContain('Storage');
    expect(html).toContain('Total entities');
    expect(html).not.toContain('总实体数');
  });

  it('en 诊断过滤项本地化(信息/警告/错误 → Info/Warning/Error)', () => {
    envState.language = 'zh-cn';
    configurationOverrides.set('kbengine', { webviewLocale: 'en' });
    const html = internals(makeWebView()).getHtml(overview, [metric()], []);
    expect(html).toContain('>Info<');
    expect(html).toContain('>Warning<');
    expect(html).toContain('>Error<');
  });
});
