/**
 * KBEngine 监控面板 WebView
 * 可视化显示服务器性能和状态指标
 */

import * as vscode from 'vscode';
import {
  ComponentMetrics,
  MonitoringCollector,
  MonitoringDiagnostic,
  SystemOverview
} from './monitoringCollector';
import { randomNonce, toJsonForScript, webviewAssetUri, webviewScriptCsp } from './webviewSecurity';
import { WEBVIEW_THEME_CSS } from './webviewTheme';
import { htmlLang, resolvePanelLocale, strings } from './webviewStrings';


/**
 * 监控面板 WebView
 */
export class MonitoringWebView {
  private panel: vscode.WebviewPanel | null = null;
  private updateTimer: NodeJS.Timeout | null = null;
  private componentFilter = '';
  private diagnosticFilter = '';
  private keywordFilter = '';
  private refreshIntervalMs = 2000;
  private historyWindow = 30;
  /**
   * KR-AUD-44 数据更新节流窗口:collector 每拍 onMetricsUpdate 都整页重建
   * (HTML + JSON 快照 + Chart.js 重建),突发更新按尾沿合并成窗口内至多一次
   * 渲染;过滤/刷新间隔/显隐等用户与生命周期动作仍走 updateWebView 即时渲。
   */
  private static readonly RENDER_THROTTLE_MS = 150;

  constructor(
    private context: vscode.ExtensionContext,
    private collector: MonitoringCollector
  ) {
    // 监听数据更新(updateWebView 自守卫:无面板或隐藏时零渲染)
    collector.onMetricsUpdate(() => {
      this.scheduleUpdate();
    });
  }

  /** 数据更新入口:窗口内只排一次渲染(尾沿),窗口内突发全部合并 */
  private scheduleUpdate(): void {
    if (this.updateTimer !== null) {
      return;
    }
    this.updateTimer = setTimeout(() => {
      this.updateTimer = null;
      this.updateWebView();
    }, MonitoringWebView.RENDER_THROTTLE_MS);
  }

  /**
   * 显示监控面板
   */
  show(): void {
    if (this.panel) {
      this.panel.reveal();
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      'kbengine.monitoring',
      'KBEngine Monitoring',
      vscode.ViewColumn.Two,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(this.context.extensionUri, 'resources')
        ]
      }
    );

    // 启动数据收集
    this.collector.start(this.refreshIntervalMs);

    // 更新 WebView
    this.updateWebView();

    // 处理消息
    this.panel.webview.onDidReceiveMessage(
      message => {
        this.handleMessage(message);
      },
      undefined,
      this.context.subscriptions
    );

    // 隐藏期间停刷(IDE-RES-007):updateWebView 对不可见面板零渲染;
    // 恢复可见时在此立即补渲一次,显示最新状态(不等下一拍)。
    this.panel.onDidChangeViewState(
      event => {
        if (event.webviewPanel.visible) {
          this.updateWebView();
        }
      },
      undefined,
      this.context.subscriptions
    );

    void this.panel.webview.postMessage({
      command: 'protocolCapabilities',
      capabilities: {
        profile: true,
        spaces: true,
        watcher: true
      }
    });

    // 关闭时清理
    this.panel.onDidDispose(
      () => {
        this.collector.stop();
        this.panel = null;
        // 面板销毁时在排的节流渲染一并作废(KR-AUD-44 接线后可达)
        if (this.updateTimer) {
          clearTimeout(this.updateTimer);
          this.updateTimer = null;
        }
      },
      undefined,
      this.context.subscriptions
    );
  }

  /**
   * 更新 WebView 内容
   */
  private updateWebView(): void {
    // 即时渲染顶掉在排的节流渲染(用户动作不等窗口)
    if (this.updateTimer !== null) {
      clearTimeout(this.updateTimer);
      this.updateTimer = null;
    }
    // 隐藏面板不渲染(IDE-RES-007):完整图表快照(historySeries JSON+
    // Chart.js 重建)只发给可见页面;恢复可见由 onDidChangeViewState 补渲。
    if (!this.panel || !this.panel.visible) {
      return;
    }

    const allMetrics = this.collector.getAllMetrics();
    const metrics = this.applyMetricFilter(allMetrics);
    const diagnostics = this.applyDiagnosticFilter(this.collector.getDiagnostics(), allMetrics);
    const overview = this.buildOverview(metrics);
    const html = this.getHtml(overview, metrics, diagnostics);
    this.panel.webview.html = html;
  }

  /**
   * 处理来自 WebView 的消息
   */
  private handleMessage(message: any): void {
    switch (message.command) {
      case 'refresh':
        void this.collector.refreshNow();
        break;
      case 'setFilters':
        this.componentFilter = typeof message.componentType === 'string' ? message.componentType : '';
        this.diagnosticFilter = typeof message.diagnosticSeverity === 'string' ? message.diagnosticSeverity : '';
        this.keywordFilter = typeof message.keyword === 'string' ? message.keyword : '';
        this.updateWebView();
        break;
      case 'setRefreshInterval':
        if (typeof message.intervalMs === 'number' && message.intervalMs > 0) {
          this.refreshIntervalMs = message.intervalMs;
          this.collector.setRefreshInterval(this.refreshIntervalMs);
          this.updateWebView();
        }
        break;
      case 'setHistoryWindow':
        if (typeof message.historyWindow === 'number' && message.historyWindow > 0) {
          this.historyWindow = message.historyWindow;
          this.updateWebView();
        }
        break;
      case 'togglePause':
        if (this.collector.isPaused()) {
          this.collector.resume();
        } else {
          this.collector.pause();
          this.updateWebView();
        }
        break;
      case 'exportMetrics':
        this.exportMetrics();
        break;
      case 'startProfile':
        vscode.commands.executeCommand('kbengine.profile.start', message.componentType, message.kind);
        break;
      case 'querySpaces':
        vscode.commands.executeCommand('kbengine.spaces.query');
        break;
    }
  }

  /**
   * 导出监控数据
   */
  exportMetrics(): void {
    const allMetrics = this.collector.getAllMetrics();
    const metrics = this.applyMetricFilter(allMetrics);
    const diagnostics = this.applyDiagnosticFilter(this.collector.getDiagnostics(), allMetrics);
    const history = this.buildHistorySeries(metrics, this.historyWindow);
    const data = JSON.stringify(
      {
        overview: this.buildOverview(metrics),
        filters: {
          componentType: this.componentFilter,
          diagnosticSeverity: this.diagnosticFilter,
          keyword: this.keywordFilter,
          historyWindow: this.historyWindow
        },
        metrics,
        diagnostics,
        history
      },
      null,
      2
    );

    vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file('kbengine_metrics.json'),
      filters: {
        'JSON Files': ['json'],
        'All Files': ['*']
      }
    }).then(uri => {
      if (uri) {
        vscode.workspace.fs.writeFile(uri, Buffer.from(data, 'utf8'))
          .then(() => {
            vscode.window.showInformationMessage(`监控数据已导出到 ${uri.fsPath}`);
          }, (error: unknown) => {
            vscode.window.showErrorMessage(`导出监控数据失败: ${error}`);
          });
      }
    });
  }

  /**
   * 生成 HTML
   */
  private getHtml(
    overview: SystemOverview,
    metrics: ComponentMetrics[],
    diagnostics: MonitoringDiagnostic[]
  ): string {
    const nonce = randomNonce();
    const t = strings(resolvePanelLocale()).monitoring;
    const c = strings(resolvePanelLocale()).common;
    const componentTypes = [...new Set(metrics.map(metric => metric.componentType))].sort();
    const metricsHtml = metrics.map(m => this.formatMetricCard(m)).join('\n');
    const diagnosticsHtml = diagnostics.map(item => this.formatDiagnostic(item)).join('\n');
    const statusSummary = this.escapeHtml(this.collector.getStatusSummary());
    const isPaused = this.collector.isPaused();
    const refreshInterval = this.collector.getRefreshInterval();
    const historySeries = this.buildHistorySeries(metrics, this.historyWindow);

    return `<!DOCTYPE html>
<html lang="${htmlLang(resolvePanelLocale())}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>KBEngine Monitoring</title>
  <!-- 最小 CSP:内联脚本只认本次渲染的 nonce;Chart.js 钉死到固定 CDN 路径(本地化 todo) -->
  <meta http-equiv="Content-Security-Policy" content="${webviewScriptCsp(nonce, [this.panel?.webview.cspSource ?? 'vscode-webview:'])}">
  <script src="${webviewAssetUri(this.panel?.webview, this.context.extensionUri, 'media', 'chart.min.js')}"></script>
  <style>
    ${WEBVIEW_THEME_CSS}
    body {
      padding: 20px;
    }

    .header {
      margin-bottom: 20px;
    }

    .header h1 {
      font-size: var(--kode-t-h1);
      font-weight: 600;
      color: #fff;
    }

    .overview {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 15px;
      margin-bottom: 20px;
    }

    .overview-card {
      background-color: var(--vscode-editorGroupHeader-tabsBackground);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      padding: 15px;
      text-align: center;
    }

    .overview-title {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 5px;
    }

    .overview-value {
      font-size: 24px;
      font-weight: bold;
      color: var(--vscode-editor-foreground);
    }

    .metrics-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
      gap: 15px;
    }

    .metric-card {
      background-color: var(--vscode-editorGroupHeader-tabsBackground);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      padding: 15px;
    }

    .metric-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 10px;
    }

    .metric-name {
      font-weight: bold;
      font-size: 14px;
    }

    .metric-status {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background-color: var(--kode-ok);
    }

    .metric-status.warning {
      background-color: var(--kode-warn);
    }

    .metric-status.error {
      background-color: var(--kode-err);
    }

    .metric-row {
      display: flex;
      justify-content: space-between;
      padding: 5px 0;
      border-bottom: 1px solid var(--vscode-panel-border);
    }

    .metric-row:last-child {
      border-bottom: none;
    }

    .metric-label {
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
    }

    .metric-value {
      font-weight: bold;
      font-size: 13px;
    }

    .progress-bar {
      width: 100%;
      height: 8px;
      background-color: var(--vscode-progressBar-background);
      border-radius: 4px;
      overflow: hidden;
      margin-top: 5px;
    }

    .progress-fill {
      height: 100%;
      background-color: var(--kode-ok);
      transition: width 0.3s ease;
    }

    .progress-fill.warning {
      background-color: var(--kode-warn);
    }

    .progress-fill.error {
      background-color: var(--kode-err);
    }

    .toolbar {
      display: flex;
      gap: 10px;
      padding: 10px;
      background-color: var(--vscode-editorGroupHeader-tabsBackground);
      border-bottom: 1px solid var(--vscode-panel-border);
      margin-bottom: 20px;
    }

    .toolbar button {
      padding: 5px 15px;
      background-color: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 2px;
      cursor: pointer;
    }

    .toolbar button:hover {
      background-color: var(--vscode-button-hoverBackground);
    }

    .toolbar select,
    .toolbar input {
      padding: 5px 8px;
      background-color: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border);
      border-radius: 2px;
      min-width: 140px;
    }

    .notice {
      margin-bottom: 20px;
      padding: 8px 12px;
      background-color: var(--kode-surface);
      border: 1px solid var(--kode-border);
      border-radius: var(--kode-r);
      color: var(--kode-fg-2);
      font-size: var(--kode-t-meta);
      line-height: 1.5;
    }

    .charts-container {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(400px, 1fr));
      gap: 15px;
      margin-top: 20px;
    }

    .chart-card {
      background-color: var(--vscode-editorGroupHeader-tabsBackground);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      padding: 15px;
    }

    .chart-title {
      font-weight: bold;
      margin-bottom: 10px;
    }

    .empty-state {
      text-align: center;
      padding: 50px;
      color: var(--vscode-descriptionForeground);
    }

    .diagnostics {
      margin-top: 20px;
      display: grid;
      gap: 10px;
    }

    .diagnostic-item {
      background-color: var(--kode-surface);
      border: 1px solid var(--kode-border);
      border-left: 3px solid var(--kode-info);
      border-radius: var(--kode-r);
      padding: 10px 12px;
      line-height: 1.5;
    }

    .diagnostic-item.warning {
      border-left-color: var(--kode-warn);
    }

    .diagnostic-item.error {
      border-left-color: var(--kode-err);
    }

    .diagnostic-meta {
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
      margin-bottom: 4px;
    }

    .metric-details {
      margin-top: 10px;
      padding-top: 8px;
      border-top: 1px dashed var(--vscode-panel-border);
      display: grid;
      gap: 4px;
    }

    .metric-details-title {
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      margin-bottom: 2px;
    }

    .metric-detail {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      font-size: 12px;
    }

    .metric-detail-label {
      color: var(--kode-fg-3);
    }

    /* 业务域分组(UI-01):组头可折叠 + 条目计数 */
    .mgroup {
      border-top: 1px dashed var(--kode-border-soft);
    }

    .mgroup > summary {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 0 2px;
      cursor: pointer;
      list-style: none;
      color: var(--kode-fg-3);
      font-size: var(--kode-t-meta);
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }

    .mgroup > summary::-webkit-details-marker {
      display: none;
    }

    .mgroup > summary::before {
      content: '▸';
      color: var(--kode-fg-4);
      font-size: 10px;
    }

    .mgroup[open] > summary::before {
      content: '▾';
    }

    .mgroup > summary:hover {
      color: var(--kode-fg-2);
    }

    .mgroup .mcount {
      background: var(--kode-surface-2);
      border: 1px solid var(--kode-border);
      border-radius: 8px;
      color: var(--kode-fg-3);
      font-family: var(--kode-mono);
      font-size: var(--kode-t-tag);
      font-weight: 400;
      padding: 0 7px;
      text-transform: none;
      letter-spacing: 0;
    }
  </style>
</head>
<body>
  <div class="header">
    <h1>${t.title}</h1>
  </div>

  <div class="toolbar">
    <select id="componentFilter">
      <option value="">${c.allComponents}</option>
      ${componentTypes
        .map(
          type =>
            `<option value="${this.escapeHtml(type)}"${this.componentFilter === type ? ' selected' : ''}>${this.escapeHtml(type)}</option>`
        )
        .join('')}
    </select>
    <select id="diagnosticFilter">
      <option value=""${this.diagnosticFilter === '' ? ' selected' : ''}>${t.filterAllDiagnostics}</option>
      <option value="info"${this.diagnosticFilter === 'info' ? ' selected' : ''}>${t.diagInfo}</option>
      <option value="warning"${this.diagnosticFilter === 'warning' ? ' selected' : ''}>${t.diagWarning}</option>
      <option value="error"${this.diagnosticFilter === 'error' ? ' selected' : ''}>${t.diagError}</option>
    </select>
    <input id="keywordFilter" type="text" placeholder="${t.searchPlaceholder}" value="${this.escapeHtml(this.keywordFilter)}" />
    <select id="refreshInterval">
      <option value="1000"${refreshInterval === 1000 ? ' selected' : ''}>1 ${t.second}</option>
      <option value="2000"${refreshInterval === 2000 ? ' selected' : ''}>2 ${t.second}</option>
      <option value="5000"${refreshInterval === 5000 ? ' selected' : ''}>5 ${t.second}</option>
      <option value="10000"${refreshInterval === 10000 ? ' selected' : ''}>10 ${t.second}</option>
    </select>
    <select id="historyWindow">
      <option value="30"${this.historyWindow === 30 ? ' selected' : ''}>${t.historyWindow(30)}</option>
      <option value="60"${this.historyWindow === 60 ? ' selected' : ''}>${t.historyWindow(60)}</option>
      <option value="120"${this.historyWindow === 120 ? ' selected' : ''}>${t.historyWindow(120)}</option>
    </select>
    <button id="refreshBtn">${c.refresh}</button>
    <button id="pauseBtn">${isPaused ? c.resume : c.pause}</button>
    <button id="exportBtn">${c.export}</button>
  </div>

  <div class="notice">${t.statusPrefix}：${statusSummary} | ${t.autoRefreshPrefix}：${isPaused ? t.pausedLabel : `${refreshInterval / 1000} ${t.second}`} | ${t.historyWindow(this.historyWindow)}</div>

  <div class="overview">
    <div class="overview-card">
      <div class="overview-title">${t.kpiComponents}</div>
      <div class="overview-value">${overview.runningComponents}</div>
    </div>
    <div class="overview-card">
      <div class="overview-title">${t.kpiEntities}</div>
      <div class="overview-value">${overview.totalEntities}</div>
    </div>
    <div class="overview-card">
      <div class="overview-title">${t.kpiConnections}</div>
      <div class="overview-value">${overview.totalConnections}</div>
    </div>
    <div class="overview-card">
      <div class="overview-title">${t.kpiMessages}</div>
      <div class="overview-value">${overview.totalMessagesPerSecond}</div>
    </div>
    <div class="overview-card">
      <div class="overview-title">${t.kpiMemory}</div>
      <div class="overview-value">${overview.totalMemoryUsage.toFixed(1)} MB</div>
    </div>
    <div class="overview-card">
      <div class="overview-title">${t.kpiCpu}</div>
      <div class="overview-value">${overview.totalCpuUsage.toFixed(1)}%</div>
    </div>
  </div>

  <div class="metrics-grid">
    ${metricsHtml || `<div class="empty-state">${t.empty}<br><small>${t.emptyHint}</small></div>`}
  </div>

  <div class="diagnostics">
    ${diagnosticsHtml || `<div class="empty-state">${t.noDiagnostics}</div>`}
  </div>

  <div class="charts-container">
    <div class="chart-card">
      <div class="chart-title">${t.chartCpu}</div>
      <canvas id="cpuChart"></canvas>
    </div>
    <div class="chart-card">
      <div class="chart-title">${t.chartMemory}</div>
      <canvas id="memoryChart"></canvas>
    </div>
    <div class="chart-card">
      <div class="chart-title">${t.chartLoad}</div>
      <canvas id="loadChart"></canvas>
    </div>
    <div class="chart-card">
      <div class="chart-title">${t.chartMessages}</div>
      <canvas id="messagesChart"></canvas>
    </div>
    <div class="chart-card">
      <div class="chart-title">${t.chartObjectPoolMemory}</div>
      <canvas id="objectPoolChart"></canvas>
    </div>
    <div class="chart-card">
      <div class="chart-title">${t.chartObjectPoolSize}</div>
      <canvas id="objectPoolSizeChart"></canvas>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const metrics = ${toJsonForScript(metrics)};
    const historySeries = ${toJsonForScript(historySeries)};

    // 刷新
    document.getElementById('refreshBtn').addEventListener('click', () => {
      vscode.postMessage({ command: 'refresh' });
    });

    // 导出
    document.getElementById('exportBtn').addEventListener('click', () => {
      vscode.postMessage({ command: 'exportMetrics' });
    });

    document.getElementById('pauseBtn').addEventListener('click', () => {
      vscode.postMessage({ command: 'togglePause' });
    });

    const pushFilters = () => {
      vscode.postMessage({
        command: 'setFilters',
        componentType: document.getElementById('componentFilter').value,
        diagnosticSeverity: document.getElementById('diagnosticFilter').value,
        keyword: document.getElementById('keywordFilter').value
      });
    };

    document.getElementById('componentFilter').addEventListener('change', pushFilters);
    document.getElementById('diagnosticFilter').addEventListener('change', pushFilters);
    document.getElementById('keywordFilter').addEventListener('input', pushFilters);
    document.getElementById('refreshInterval').addEventListener('change', event => {
      vscode.postMessage({
        command: 'setRefreshInterval',
        intervalMs: parseInt(event.target.value, 10)
      });
    });
    document.getElementById('historyWindow').addEventListener('change', event => {
      vscode.postMessage({
        command: 'setHistoryWindow',
        historyWindow: parseInt(event.target.value, 10)
      });
    });

    // 创建图表
    if (typeof Chart !== 'undefined') {
      createCharts(historySeries);
    }

    function createCharts(historySeries) {
      const sampleSize = historySeries.reduce((max, item) => Math.max(max, item.points.length), 0);
      const labels = Array.from({ length: sampleSize }, (_, index) => {
        const point = historySeries.find(item => item.points[index]);
        if (!point) {
          return '';
        }

        const timestamp = point.points[index].timestamp;
        return new Date(timestamp).toLocaleTimeString('zh-CN', {
          hour12: false,
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit'
        });
      });
      // UI-01:图表线色取统一状态色板/强调色(旧 Material 随机彩退场)
      const colors = [
        '#75beff', // info
        '#3794ff', // accent
        '#89d185', // ok
        '#cca700', // warn
        '#f14c4c', // err
        '#808080'  // neutral
      ];

      const createDatasets = (field, fill = false) =>
        historySeries.map((item, index) => ({
          label: item.component,
          data: item.points.map(point => point[field]),
          timestamps: item.points.map(point => point.timestamp),
          borderColor: colors[index % colors.length],
          backgroundColor: colors[index % colors.length].replace(', 1)', ', 0.18)'),
          tension: 0.3,
          fill,
          pointRadius: 0,
          pointHoverRadius: 4
        }));

      // CPU 图表
      new Chart(document.getElementById('cpuChart'), {
        type: 'line',
        data: {
          labels: labels,
          datasets: createDatasets('cpuUsage')
        },
        options: {
          responsive: true,
          interaction: {
            mode: 'nearest',
            intersect: false
          },
          plugins: {
            tooltip: {
              callbacks: {
                title: items => {
                  const item = items[0];
                  const timestamp = item.dataset.timestamps?.[item.dataIndex];
                  if (!timestamp) {
                    return '';
                  }

                  return new Date(timestamp).toLocaleString('zh-CN', { hour12: false });
                }
              }
            }
          },
          scales: {
            y: {
              beginAtZero: true,
              max: 100
            }
          }
        }
      });

      // 内存图表
      new Chart(document.getElementById('memoryChart'), {
        type: 'line',
        data: {
          labels: labels,
          datasets: createDatasets('memoryUsage')
        },
        options: {
          responsive: true,
          interaction: {
            mode: 'nearest',
            intersect: false
          },
          plugins: {
            tooltip: {
              callbacks: {
                title: items => {
                  const item = items[0];
                  const timestamp = item.dataset.timestamps?.[item.dataIndex];
                  if (!timestamp) {
                    return '';
                  }

                  return new Date(timestamp).toLocaleString('zh-CN', { hour12: false });
                }
              }
            }
          },
          scales: {
            y: {
              beginAtZero: true
            }
          }
        }
      });

      // 负载图表
      new Chart(document.getElementById('loadChart'), {
        type: 'line',
        data: {
          labels: labels,
          datasets: createDatasets('load', true)
        },
        options: {
          responsive: true,
          interaction: {
            mode: 'nearest',
            intersect: false
          },
          plugins: {
            tooltip: {
              callbacks: {
                title: items => {
                  const item = items[0];
                  const timestamp = item.dataset.timestamps?.[item.dataIndex];
                  if (!timestamp) {
                    return '';
                  }

                  return new Date(timestamp).toLocaleString('zh-CN', { hour12: false });
                }
              }
            }
          },
          scales: {
            y: {
              beginAtZero: true
            }
          }
        }
      });

      // 消息速率图表
      new Chart(document.getElementById('messagesChart'), {
        type: 'line',
        data: {
          labels: labels,
          datasets: createDatasets('messagesPerSecond', true)
        },
        options: {
          responsive: true,
          interaction: {
            mode: 'nearest',
            intersect: false
          },
          plugins: {
            tooltip: {
              callbacks: {
                title: items => {
                  const item = items[0];
                  const timestamp = item.dataset.timestamps?.[item.dataIndex];
                  if (!timestamp) {
                    return '';
                  }

                  return new Date(timestamp).toLocaleString('zh-CN', { hour12: false });
                }
              }
            }
          },
          scales: {
            y: {
              beginAtZero: true
            }
          }
        }
      });

      // Cell 对象池内存图表
      new Chart(document.getElementById('objectPoolChart'), {
        type: 'line',
        data: {
          labels: labels,
          datasets: createDatasets('objectPoolMemory', true).filter(dataset =>
            dataset.data.some(value => value > 0)
          )
        },
        options: {
          responsive: true,
          interaction: {
            mode: 'nearest',
            intersect: false
          },
          plugins: {
            tooltip: {
              callbacks: {
                title: items => {
                  const item = items[0];
                  const timestamp = item.dataset.timestamps?.[item.dataIndex];
                  if (!timestamp) {
                    return '';
                  }

                  return new Date(timestamp).toLocaleString('zh-CN', { hour12: false });
                }
              }
            }
          },
          scales: {
            y: {
              beginAtZero: true
            }
          }
        }
      });

      // Cell 对象池容量图表
      new Chart(document.getElementById('objectPoolSizeChart'), {
        type: 'line',
        data: {
          labels: labels,
          datasets: createDatasets('objectPoolSize', true).filter(dataset =>
            dataset.data.some(value => value > 0)
          )
        },
        options: {
          responsive: true,
          interaction: {
            mode: 'nearest',
            intersect: false
          },
          plugins: {
            tooltip: {
              callbacks: {
                title: items => {
                  const item = items[0];
                  const timestamp = item.dataset.timestamps?.[item.dataIndex];
                  if (!timestamp) {
                    return '';
                  }

                  return new Date(timestamp).toLocaleString('zh-CN', { hour12: false });
                }
              }
            }
          },
          scales: {
            y: {
              beginAtZero: true
            }
          }
        }
      });
    }
  </script>
</body>
</html>`;
  }

  private escapeHtml(text: string): string {
    const map: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;'
    };
    return text.replace(/[&<>"']/g, char => map[char]);
  }

  private applyMetricFilter(metrics: ComponentMetrics[]): ComponentMetrics[] {
    const keyword = this.keywordFilter.trim().toLowerCase();

    return metrics.filter(metric => {
      if (this.componentFilter && metric.componentType !== this.componentFilter) {
        return false;
      }

      if (!keyword) {
        return true;
      }

      const haystack = [
        metric.component,
        metric.componentType,
        metric.internalAddress,
        metric.status,
        ...metric.details.map(detail => `${detail.label}:${detail.value}`)
      ]
        .join(' ')
        .toLowerCase();

      return haystack.includes(keyword);
    });
  }

  private applyDiagnosticFilter(
    diagnostics: MonitoringDiagnostic[],
    metrics: ComponentMetrics[]
  ): MonitoringDiagnostic[] {
    const keyword = this.keywordFilter.trim().toLowerCase();

    return diagnostics.filter(item => {
      if (this.diagnosticFilter && item.severity !== this.diagnosticFilter) {
        return false;
      }

      if (this.componentFilter && item.component) {
        const component = metrics.find(metric => metric.component === item.component);
        if (component && component.componentType !== this.componentFilter) {
          return false;
        }
      }

      if (!keyword) {
        return true;
      }

      const haystack = [item.source, item.component || '', item.message]
        .join(' ')
        .toLowerCase();

      return haystack.includes(keyword);
    });
  }

  private buildOverview(metrics: ComponentMetrics[]): SystemOverview {
    return metrics.reduce<SystemOverview>(
      (overview, metric) => {
        overview.totalEntities += metric.entityCount;
        overview.totalConnections += metric.connections;
        overview.totalMessagesPerSecond += metric.messagesPerSecond;
        overview.runningComponents += 1;
        overview.totalMemoryUsage += metric.memoryUsage;
        overview.totalCpuUsage += metric.cpuUsage;
        return overview;
      },
      {
        totalEntities: 0,
        totalConnections: 0,
        totalMessagesPerSecond: 0,
        runningComponents: 0,
        totalMemoryUsage: 0,
        totalCpuUsage: 0
      }
    );
  }

  private buildHistorySeries(metrics: ComponentMetrics[], length: number): Array<{
    component: string;
    points: Array<{
      timestamp: string;
      cpuUsage: number;
      memoryUsage: number;
      load: number;
      messagesPerSecond: number;
      objectPoolMemory: number;
      objectPoolSize: number;
      connections: number;
      entityCount: number;
    }>;
  }> {
    return metrics.map(metric => ({
      component: metric.component,
      points: this.collector.getMetricsHistory(metric.component, length).map(item => ({
        timestamp: item.lastUpdate.toISOString(),
        cpuUsage: item.cpuUsage,
        memoryUsage: item.memoryUsage,
        load: item.load,
        messagesPerSecond: item.messagesPerSecond,
        objectPoolMemory: item.objectPoolMemory,
        objectPoolSize: item.objectPoolSize,
        connections: item.connections,
        entityCount: item.entityCount
      }))
    }));
  }

  /**
   * 格式化指标卡片(UI-01 分类管理重设计):原 13 行平铺按真实业务域分组
   * ——服务进程(组件类型/状态/运行时间/PID)、性能(CPU/内存/负载/消息)、
   * 连接(连接数/监听地址)、存储(实体数/对象池),组头 <details> 可折叠
   * 并带条目计数;文案走字符串表(zh/en)。
   */
  private formatMetricCard(metric: ComponentMetrics): string {
    const t = strings(resolvePanelLocale()).monitoring;
    const cpuPercent = metric.cpuUsage.toFixed(1);
    const cpuClass = metric.cpuUsage > 80 ? 'error' : (metric.cpuUsage > 50 ? 'warning' : '');
    const memoryMB = metric.memoryUsage.toFixed(1);
    const uptimeMin = Math.floor(metric.uptime / 60);
    const loadPercent = (metric.load * 100).toFixed(1);
    const objectPoolMemoryMB = metric.objectPoolMemory.toFixed(0);
    const statusClass = metric.statusLevel === 'error'
      ? 'error'
      : metric.statusLevel === 'warning'
        ? 'warning'
        : '';
    const detailTitle = metric.componentType === 'cellapp' ? t.objectPools : t.watcherDetails;
    const detailHtml = metric.details
      .map(
        detail => `<div class="metric-detail">
        <span class="metric-detail-label">${this.escapeHtml(detail.label)}</span>
        <span>${this.escapeHtml(detail.value)}</span>
      </div>`
      )
      .join('\n');

    const hasObjectPool = metric.objectPoolSize > 0 || metric.objectPoolMemory > 0;
    const group = (
      domain: string,
      label: string,
      rows: Array<{ render: string } | null>
    ): string => {
      const visible = rows.filter(row => row !== null);
      return `<details class="mgroup" data-domain="${domain}" open>
      <summary><span>${label}</span><span class="mcount" data-count="${visible.length}">${visible.length}</span></summary>
      ${visible.map(row => (row as { render: string }).render).join('\n')}
    </details>`;
    };
    const row = (label: string, value: string): { render: string } => ({
      render: `<div class="metric-row">
        <span class="metric-label">${label}</span>
        <span class="metric-value">${value}</span>
      </div>`
    });

    // 运行时间的值在 label 中(既有口径 "10 分钟"),行结构保持 label+value
    const processRows = group('process', t.domainProcess, [
      row(t.rowComponentType, this.escapeHtml(metric.componentType)),
      row(t.rowStatus, this.escapeHtml(metric.status)),
      { render: `<div class="metric-row">
        <span class="metric-label">${t.rowUptime(uptimeMin)}</span>
        <span class="metric-value"></span>
      </div>` },
      row(t.rowPid, String(metric.pid))
    ]);
    const performanceGroup = group('performance', t.domainPerformance, [
      { render: `<div class="metric-row">
        <span class="metric-label">${t.rowCpu}</span>
        <span class="metric-value">${cpuPercent}%</span>
      </div>
      <div class="progress-bar">
        <div class="progress-fill ${cpuClass}" style="width: ${cpuPercent}%"></div>
      </div>` },
      row(t.rowMemory, `${memoryMB} MB`),
      row(t.rowLoad, `${loadPercent}%`),
      row(t.rowMessages, String(metric.messagesPerSecond))
    ]);
    const connectionsGroup = group('connections', t.domainConnections, [
      row(t.rowConnections, String(metric.connections)),
      row(t.rowAddress, this.escapeHtml(metric.internalAddress))
    ]);
    const storageGroup = group('storage', t.domainStorage, [
      row(t.rowEntities, String(metric.entityCount)),
      hasObjectPool ? row(t.rowObjectPoolSize, String(metric.objectPoolSize)) : null,
      hasObjectPool ? row(t.rowObjectPoolMemory, `${objectPoolMemoryMB} B`) : null
    ]);

    return `<div class="metric-card">
      <div class="metric-header">
        <div class="metric-name">${this.escapeHtml(metric.component.toUpperCase())}</div>
        <div class="metric-status ${statusClass}"></div>
      </div>
      ${processRows}
      ${performanceGroup}
      ${connectionsGroup}
      ${storageGroup}
      <div class="metric-details">
        <div class="metric-details-title">${detailTitle}</div>
        ${detailHtml}
      </div>
    </div>`;
  }

  private formatDiagnostic(item: MonitoringDiagnostic): string {
    const severityClass = item.severity === 'error'
      ? 'error'
      : item.severity === 'warning'
        ? 'warning'
        : '';
    const scope = item.component ? `${item.source}:${item.component}` : item.source;

    return `<div class="diagnostic-item ${severityClass}">
      <div class="diagnostic-meta">${this.escapeHtml(scope)} | ${item.timestamp.toLocaleTimeString('zh-CN')}</div>
      <div>${this.escapeHtml(item.message)}</div>
    </div>`;
  }

  /**
   * 清理资源
   */
  dispose(): void {
    if (this.panel) {
      this.panel.dispose();
      this.panel = null;
    }
    // 在排的节流渲染一并作废(KR-AUD-44 接线后可达)
    if (this.updateTimer) {
      clearTimeout(this.updateTimer);
      this.updateTimer = null;
    }
    this.collector.dispose();
  }
}
