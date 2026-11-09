import type * as vscode from 'vscode';
import { describe, expect, it } from 'vitest';
import { EntityDependencyWebView } from '../src/entityDependencyWebView';
import { statCard as renderStatCard } from '../src/entityDependencyWebViewHtml';
import { EntityFlowWebView } from '../src/entityFlowWebView';
import type { EntityFlowGraph } from '../src/backend/entityFlowGraph';
import { KBEngineLogCollector } from '../src/logCollector';
import { LogEntry, LogLevel, LogType } from '../src/backend/logParser';
import { LogViewerWebView } from '../src/logWebView';
import { MonitoringCollector } from '../src/monitoringCollector';
import type { ComponentMetrics } from '../src/monitoringCollector';
import { MonitoringWebView } from '../src/monitoringWebView';
import { RuntimeQueryWebView } from '../src/runtimeQueryWebView';
import { TelnetWebView } from '../src/telnetWebView';
import type { TelnetProbeState, TelnetService, TelnetTarget } from '../src/telnetService';
import { randomNonce, toJsonForScript, webviewScriptCsp } from '../src/webviewSecurity';
import { messages, panelRegistry, windowState } from './helpers/vscodeStub';

// webview 安全域判别测试(KR-AUD-38/43/49/50/53+08):
// - XSS 判别:恶意字段(日志行/指标/目标配置/统计卡)整页渲染后不得产生新标签
//   或提前断开 <script> 上下文;
// - CSP 判别:六个 webview 的整页 HTML 都必须带 Content-Security-Policy,内联
//   脚本只认本次渲染 nonce;mermaid/Chart.js 走扩展自带 media/ 离线打包
//   (与 cspSource 同源),整页不出现任何 CDN 域名,mermaid securityLevel=strict。

const stubContext = {} as unknown as vscode.ExtensionContext;

/* ---------------- webviewSecurity 共享件 ---------------- */

describe('webviewSecurity.randomNonce', () => {
  it('yields unique 32-char hex strings', () => {
    const seen = new Set<string>();
    for (let index = 0; index < 64; index += 1) {
      const nonce = randomNonce();
      expect(nonce).toMatch(/^[0-9a-f]{32}$/);
      seen.add(nonce);
    }
    expect(seen.size).toBe(64);
  });
});

describe('webviewSecurity.toJsonForScript', () => {
  it('eats `<` so `</script>` cannot close the inline script context', () => {
    const json = toJsonForScript([{ text: '</script><img src=x onerror=alert(1)>' }]);
    expect(json).not.toContain('</script>');
    expect(json).not.toContain('<img');
    expect(json).toContain('\\u003c/script\\u003e\\u003cimg');
    // 反序列化后数据不变
    expect(JSON.parse(json)).toEqual([{ text: '</script><img src=x onerror=alert(1)>' }]);
  });
});

describe('webviewSecurity.webviewScriptCsp', () => {
  it('locks scripts to the nonce and nothing else by default', () => {
    const csp = webviewScriptCsp('abc123');
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'nonce-abc123';");
    expect(csp).toContain("style-src 'unsafe-inline'");
    expect(csp.includes("script-src 'unsafe-inline'")).toBe(false);
  });

  it('pins extra script sources', () => {
    const csp = webviewScriptCsp('abc123', ['https://cdn.example.com/x.min.js']);
    expect(csp).toContain("script-src 'nonce-abc123' https://cdn.example.com/x.min.js;");
  });
});

/* ---------------- KR-AUD-38: logWebView ---------------- */

const makeLogWebView = () =>
  new LogViewerWebView(stubContext, new KBEngineLogCollector(
    { host: '127.0.0.1', port: 30000, autoReconnect: false, reconnectInterval: 1000, maxBufferSize: 100 },
    stubContext
  ));

const logEntry = (over: Partial<LogEntry> = {}): LogEntry => ({
  id: 1,
  timestamp: new Date(Date.UTC(2026, 8, 24, 12, 0, 0)),
  component: 'cellapp',
  level: LogLevel.INFO,
  type: LogType.LOG_TYPE_NORMAL,
  message: 'entity created',
  raw: 'raw line',
  ...over
});

describe('KR-AUD-38: LogViewerWebView.formatLogEntry 恶意日志行不产生标签', () => {
  const impl = makeLogWebView() as unknown as {
    formatLogEntry: (log: LogEntry) => string;
    getHtml: (logs: LogEntry[]) => string;
  };

  it('escapes title(raw) 与 component 两处插值', () => {
    const html = impl.formatLogEntry(logEntry({
      raw: '"><img src=x onerror=alert(1)>',
      component: '<script>alert(2)</script>'
    }));

    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('"><img');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('&lt;SCRIPT&gt;');
  });

  it('整页 getHtml 渲染恶意日志后无注入标签,且带 nonce CSP', () => {
    const html = impl.getHtml([logEntry({ raw: '</div><script>alert(3)</script>' })]);
    expect(html).not.toContain('</div><script>');
    expect(html).not.toContain('<script>alert(3)');
    const nonce = html.match(/script-src 'nonce-([0-9a-f]+)'/)?.[1];
    expect(nonce).toBeDefined();
    expect(html).toContain(`<script nonce="${nonce}">`);
  });
});

/* ---------------- KR-AUD-43: monitoringWebView ---------------- */

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

const makeMonitoringInternals = () =>
  new MonitoringWebView(stubContext, new MonitoringCollector(stubContext)) as unknown as {
    formatMetricCard: (metric: ComponentMetrics) => string;
    getHtml: (
      overview: ReturnType<MonitoringCollector['getSystemOverview']>,
      metrics: ComponentMetrics[],
      diagnostics: never[]
    ) => string;
  };

describe('KR-AUD-43: MonitoringWebView 恶意指标不产生标签/不炸脚本上下文', () => {
  it('formatMetricCard 全量转义字符串字段', () => {
    const impl = makeMonitoringInternals();
    const html = impl.formatMetricCard(metric({
      component: 'app"><img src=x onerror=alert(1)>',
      componentType: '<script>alert(2)</script>',
      status: '" onmouseover="alert(3)',
      internalAddress: '</td><script>alert(4)</script>'
    }));

    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&quot; onmouseover=&quot;');
  });

  it('getHtml 指标 JSON 直插经 \\u003c 替换,</script> 无法断开脚本', () => {
    const impl = makeMonitoringInternals();
    const webview = new MonitoringWebView(stubContext, new MonitoringCollector(stubContext));
    const overview = (webview as unknown as {
      buildOverview: (metrics: ComponentMetrics[]) => ReturnType<MonitoringCollector['getSystemOverview']>;
    }).buildOverview([metric()]);
    const html = impl.getHtml(overview, [metric({
      component: '</script><img src=x onerror=alert(1)>'
    })], []);

    expect(html).not.toContain('</script><img');
    expect(html).toContain('\\u003c/script\\u003e\\u003cimg');
    // CSP:nonce + Chart.js 离线打包(media/chart.min.js,与 cspSource 同源)
    const nonce = html.match(/script-src 'nonce-([0-9a-f]+)'/)?.[1];
    expect(nonce).toBeDefined();
    expect(html).toContain(`<script nonce="${nonce}">`);
    expect(html).toContain('<script src="media/chart.min.js">');
    expect(html).toContain(`script-src 'nonce-${nonce}' vscode-webview:`);
    expect(html).not.toContain('cdn.jsdelivr');
    expect(html.match(/Content-Security-Policy" content="[^"]*"/)?.[0]).not.toContain("script-src 'unsafe-inline'");
  });
});

/* ---------------- KR-AUD-49: telnetWebView ---------------- */

const telnetTarget = (over: Partial<TelnetTarget> = {}): TelnetTarget => ({
  key: '127.0.0.1:31000',
  label: 'loginapp',
  component: 'loginapp',
  host: '127.0.0.1',
  port: 31000,
  password: 'pwd123456',
  enableCommands: [],
  ...over
});

const makeTelnetService = (
  targets: TelnetTarget[],
  states: Map<string, TelnetProbeState> = new Map()
): TelnetService =>
  ({
    getTargets: () => targets,
    getState: (key: string) => states.get(key) ?? 'closed',
    getSessionState: () => null,
    getOutput: () => [],
    onDidChange: () => () => undefined,
    onOutput: () => () => undefined
  }) as unknown as TelnetService;

const showTelnetHtml = (targets: TelnetTarget[], states?: Map<string, TelnetProbeState>): string => {
  panelRegistry.reset();
  windowState.reset();
  messages.length = 0;
  const webview = new TelnetWebView({} as never, makeTelnetService(targets, states));
  webview.show();
  const html = panelRegistry.panels[0].webview.html;
  webview.dispose();
  return html;
};

describe('KR-AUD-49: TelnetWebView 恶意目标配置不产生标签', () => {
  it('renderTargets 的 key/label/host 全量转义', () => {
    const html = showTelnetHtml([
      telnetTarget({
        key: 'h"="x"><img src=y onerror=1>:31000',
        label: '<script>alert(1)</script>',
        host: '" onfocus="alert(2)'
      })
    ]);

    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&quot; onfocus=&quot;alert(2)');
  });

  it('closed 目标的指引(label/host)与 data-key 转义;脚本 querySelector 走 CSS.escape', () => {
    const html = showTelnetHtml([
      telnetTarget({ label: '<b>bold</b>', host: 'evil"><svg onload=1>' })
    ]);

    expect(html).not.toContain('<b>bold</b>');
    expect(html).toContain('&lt;b&gt;bold&lt;/b&gt;');
    expect(html).not.toContain('<svg onload');
    expect(html).toContain('CSS.escape(entry.key)');
    // CSP:nonce 面板
    const nonce = html.match(/script-src 'nonce-([0-9a-f]+)'/)?.[1];
    expect(nonce).toBeDefined();
    expect(html).toContain(`<script nonce="${nonce}">`);
  });
});

/* ---------------- KR-AUD-50+08: 六个 webview 统一带 CSP ---------------- */

const expectNonceCsp = (html: string, label: string): void => {
  const meta = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/);
  expect(meta, label).toBeDefined();
  const nonce = meta![1].match(/script-src 'nonce-([0-9a-f]+)'/)?.[1];
  expect(nonce, label).toBeDefined();
  expect(meta![1].includes("script-src 'unsafe-inline'"), label).toBe(false);
  expect(html).toContain(`<script nonce="${nonce}">`, label);
  expect(html).toContain("default-src 'none'", label);
};

describe('KR-AUD-50: 六个 webview 的 CSP 接入', () => {
  it('logWebView: nonce CSP,无 unsafe-inline', () => {
    const impl = makeLogWebView() as unknown as { getHtml: (logs: LogEntry[]) => string };
    expectNonceCsp(impl.getHtml([]), 'logWebView');
  });

  it('runtimeQueryWebView: unsafe-inline 收紧为 nonce', () => {
    const impl = new RuntimeQueryWebView(stubContext) as unknown as { render: () => string };
    expectNonceCsp(impl.render(), 'runtimeQueryWebView');
  });

  it('entityDependencyWebView: nonce CSP + mermaid 离线打包 + strict', () => {
    const impl = new EntityDependencyWebView(
      stubContext,
      {} as unknown as vscode.OutputChannel
    ) as unknown as {
      getWebviewContent: (m: string, g: null, c: null, r: boolean) => string;
    };
    const html = impl.getWebviewContent('graph TD', null, null, false);
    expect(html).toContain("default-src 'none'");
    const nonce = html.match(/script-src 'nonce-([0-9a-f]+)'/)?.[1];
    expect(nonce).toBeDefined();
    expect(html).toContain(`<script nonce="${nonce}">`);
    expect(html).toContain('<script src="media/mermaid.tiny.js">');
    expect(html).toContain(`script-src 'nonce-${nonce}' vscode-webview:`);
    expect(html).not.toContain('cdn.jsdelivr');
    expect(html).not.toContain("script-src 'unsafe-inline'");
    // 内联事件处理器在 nonce CSP 下不执行:工具栏一律脚本绑定
    expect(html).not.toContain('onclick=');
    expect(html).not.toContain('onchange=');
    expect(html).toContain("securityLevel: 'strict'");
    // 点击打开文件:strict 下 mermaid 丢弃自带 click 回调,面板按指令自绑
    expect(html).toContain('resolveOpenPath');
    expect(html).toContain('addEventListener(\'click\'');
  });

  it('entityDependencyWebView: 统计卡字符串面全量转义(标签注入)', () => {
    // SRC-012:statCard 自 hub 迁 HTML 半边为导出自由函数;直调断言转义。
    const html = renderStatCard('进程角色', 'cellapp<img src=x onerror=alert(1)>');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  const flowGraph = (stats: Record<string, unknown> = {}): EntityFlowGraph =>
    ({
      entityName: 'Hero',
      defFilePath: 'scripts/entity_defs/Hero.def',
      hasCell: false,
      actors: [],
      edges: [],
      blocked: [],
      stats: {
        properties: 0,
        methods: 0,
        exposedCalls: 0,
        clientCallbacks: 0,
        persistentProperties: 0,
        ...stats
      }
    }) as unknown as EntityFlowGraph;

  it('entityFlowWebView: nonce CSP + mermaid 离线打包 + strict', () => {
    const impl = new EntityFlowWebView(stubContext) as unknown as {
      getWebviewContent: (graph: EntityFlowGraph) => string;
    };
    const html = impl.getWebviewContent(flowGraph());
    expect(html).toContain("default-src 'none'");
    const nonce = html.match(/script-src 'nonce-([0-9a-f]+)'/)?.[1];
    expect(nonce).toBeDefined();
    expect(html).toContain(`<script nonce="${nonce}">`);
    expect(html).toContain('<script src="media/mermaid.tiny.js">');
    expect(html).toContain(`script-src 'nonce-${nonce}' vscode-webview:`);
    expect(html).not.toContain('cdn.jsdelivr');
    expect(html).not.toContain("script-src 'unsafe-inline'");
    expect(html).not.toContain('onclick=');
    expect(html).toContain("securityLevel: 'strict'");
    expect(html).toContain('refresh-flow-btn');
  });

  it('entityFlowWebView: 统计卡字符串面全量转义(标签注入)', () => {
    const impl = new EntityFlowWebView(stubContext) as unknown as {
      getWebviewContent: (graph: EntityFlowGraph) => string;
    };
    const html = impl.getWebviewContent(flowGraph({
      properties: '<img src=x onerror=alert(1)>'
    }));
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });
});
