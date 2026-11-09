// UX-REVIEW-007b 监控工具栏窄面板适配:
// - 「筛选组 / 操作组」分组换行:窄面板下筛选控件先在组内流式折行,
//   刷新/暂停/导出按钮作为整体折行,不再与筛选控件交错;
// - 筛选值保留:控件仍按 id 取值并服务端回填 selected/value,重渲染不丢值;
// - 主题颜色与对比度遵循 VS Code:工具栏区域零硬编码色值,焦点走 focusBorder。
// UX-REVIEW-007c 可访问性验证:键盘顺序(零 tabindex=自然 DOM 序)、
// 程序化名称(label for 配对/按钮可见文本)、状态经可访问名称呈现。
import { beforeEach, describe, expect, it } from 'vitest';
import type { ComponentMetrics, SystemOverview } from '../src/monitoringCollector';
import { MonitoringWebView } from '../src/monitoringWebView';
import { configurationOverrides, envState } from './helpers/vscodeStub';

const overview: SystemOverview = {
  totalEntities: 5,
  totalConnections: 2,
  totalMessagesPerSecond: 7,
  runningComponents: 1,
  totalMemoryUsage: 100,
  totalCpuUsage: 10
};

const FILTER_IDS = ['componentFilter', 'diagnosticFilter', 'keywordFilter', 'refreshInterval', 'historyWindow'];
const ACTION_IDS = ['refreshBtn', 'pauseBtn', 'exportBtn'];

const makeWebView = (isPaused = false) =>
  new MonitoringWebView({} as unknown as import('vscode').ExtensionContext, {
    getAllMetrics: () => [],
    getDiagnostics: () => [],
    getStatusSummary: () => 'FAKE SUMMARY',
    onMetricsUpdate: () => ({ dispose: () => undefined }),
    isPaused: () => isPaused,
    getRefreshInterval: () => 2000,
    getMetricsHistory: () => []
  } as never);

interface MonitoringInternals {
  getHtml: (overview: SystemOverview, metrics: ComponentMetrics[], diagnostics: never[]) => string;
  componentFilter: string;
  diagnosticFilter: string;
  keywordFilter: string;
}

const internals = (webview: MonitoringWebView): MonitoringInternals =>
  webview as unknown as MonitoringInternals;

const renderZh = (isPaused = false): string => {
  envState.language = 'zh-cn';
  configurationOverrides.delete('kbengine');
  return internals(makeWebView(isPaused)).getHtml(overview, [], []);
};

/** 工具栏样式区(断言主题遵循 VS Code 时不波及面板其余部分) */
const toolbarCss = (html: string): string => {
  const start = html.indexOf('.toolbar {');
  const end = html.indexOf('.notice {');
  return html.slice(start, end);
};

const toolbarMarkup = (html: string): string => {
  const start = html.indexOf('<div class="toolbar">');
  const end = html.indexOf('<div class="notice">');
  return html.slice(start, end);
};

beforeEach(() => {
  configurationOverrides.delete('kbengine');
  envState.language = 'zh-cn';
});

describe('监控工具栏分组(UX-REVIEW-007b)', () => {
  it('筛选控件归入筛选组,操作按钮归入操作组,按钮不与筛选控件交错', () => {
    const html = renderZh();
    const filtersStart = html.indexOf('toolbar-group toolbar-filters');
    const actionsStart = html.indexOf('toolbar-group toolbar-actions');
    expect(filtersStart).toBeGreaterThan(-1);
    expect(actionsStart).toBeGreaterThan(filtersStart);

    const filtersRegion = html.slice(filtersStart, actionsStart);
    for (const id of FILTER_IDS) {
      expect(filtersRegion).toContain(`id="${id}"`);
    }
    expect(filtersRegion).not.toContain('<button');

    const actionsRegion = html.slice(actionsStart, html.indexOf('<div class="notice">'));
    for (const id of ACTION_IDS) {
      expect(actionsRegion).toContain(`id="${id}"`);
    }
    for (const id of FILTER_IDS) {
      expect(actionsRegion).not.toContain(`id="${id}"`);
    }
  });

  it('组容器允许换行,筛选控件随面板伸缩:窄面板不溢出不交错', () => {
    const css = toolbarCss(renderZh());
    expect(css).toContain('flex-wrap: wrap'); // 组容器在窄面板下折行
    expect(css).toMatch(/\.toolbar label\s*{[^}]*flex: 1 1 170px/); // 筛选项可伸缩
    expect(css).toMatch(/\.toolbar label\s*{[^}]*min-width: 150px/); // 折行下限
    expect(css).toMatch(/\.toolbar select,[^{]*{[^}]*width: 100%/); // 控件填满所在筛选格
  });

  it('筛选值跨重渲染保留:选中项与关键词经 selected/value 服务端回填', () => {
    const webview = makeWebView();
    const fields = internals(webview);
    fields.componentFilter = 'cellapp';
    fields.keywordFilter = '<script>';
    // 组件下拉的选项来自当前指标里的组件类型,须有一台 cellapp 才有该选项
    const metric: ComponentMetrics = {
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
      uptime: 600,
      status: 'running',
      statusLevel: 'info',
      details: [],
      lastUpdate: new Date(Date.UTC(2026, 8, 24, 12, 0, 0))
    };
    const html = fields.getHtml(overview, [metric], []);
    expect(html).toContain('<option value="cellapp" selected');
    expect(html).toContain('value="&lt;script&gt;"'); // 回填同时转义
  });

  it('刷新/暂停/导出行为保留:暂停态渲染「恢复」按钮,按钮 id 不变', () => {
    const paused = renderZh(true);
    const pausedActions = toolbarMarkup(paused);
    expect(pausedActions).toContain('>恢复</button>');
    expect(pausedActions).not.toContain('>暂停</button>');

    const running = renderZh(false);
    expect(toolbarMarkup(running)).toContain('>暂停</button>');
    expect(toolbarMarkup(running)).toContain('>刷新</button>');
    expect(toolbarMarkup(running)).toContain('>导出数据</button>');
  });

  it('主题颜色与对比度遵循 VS Code:工具栏样式零硬编码色值,焦点走 focusBorder', () => {
    const css = toolbarCss(renderZh());
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(css).toContain('var(--vscode-button-background)');
    expect(css).toContain('var(--vscode-button-hoverBackground)');
    expect(css).toContain('var(--vscode-input-background)');
    expect(css).toContain('var(--vscode-input-foreground)');
    expect(css).toContain('var(--vscode-input-border)');
    expect(css).toContain('outline: 1px solid var(--vscode-focusBorder)'); // 焦点可见(007c 验证面)
  });
});

describe('监控工具栏可访问性验证(UX-REVIEW-007c)', () => {
  it('键盘顺序=自然 DOM 序:工具栏零 tabindex,控件按组件→诊断→关键词→刷新间隔→历史→操作排列', () => {
    const html = renderZh();
    const toolbar = toolbarMarkup(html);
    // 零 tabindex:键盘 Tab 序即 DOM 序,无正 tabindex 打乱阅读顺序
    expect(toolbar.includes('tabindex')).toBe(false);
    // 8 个控件在 DOM 中按逻辑阅读顺序出现(筛选组在前、操作组在后)
    let cursor = toolbar.indexOf('<div class="toolbar">');
    for (const id of [...FILTER_IDS, ...ACTION_IDS]) {
      const at = toolbar.indexOf(`id="${id}"`, cursor);
      expect(at, `${id} 未按声明顺序出现`).toBeGreaterThan(-1);
      cursor = at;
    }
  });

  it('程序化名称齐全:每个筛选控件有 label for 配对,按钮可见文本即可访问名称', () => {
    const toolbar = toolbarMarkup(renderZh());
    for (const id of FILTER_IDS) {
      expect(toolbar.includes(`<label for="${id}">`), `${id} 缺 label for`).toBe(true);
    }
    for (const id of ACTION_IDS) {
      const at = toolbar.indexOf(`id="${id}"`);
      expect(at).toBeGreaterThan(-1);
      const openTagEnd = toolbar.indexOf('>', at);
      const closeTag = toolbar.indexOf('</button>', openTagEnd);
      const text = toolbar.slice(openTagEnd + 1, closeTag).trim();
      expect(text.length, `${id} 可见文本为空`).toBeGreaterThan(0);
    }
  });

  it('暂停/恢复状态经可访问名称呈现:暂停态名称为「恢复」,运行态为「暂停」', () => {
    // 状态入名称:屏幕阅读器朗读按钮文本即获知当前状态(007c 名称与状态面)
    expect(toolbarMarkup(renderZh(true))).toContain('>恢复</button>');
    expect(toolbarMarkup(renderZh(false))).toContain('>暂停</button>');
  });
});
