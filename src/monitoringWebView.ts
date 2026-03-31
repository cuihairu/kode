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

  constructor(
    private context: vscode.ExtensionContext,
    private collector: MonitoringCollector
  ) {
    // 监听数据更新
    collector.onMetricsUpdate(() => {
      if (this.panel) {
        this.updateWebView();
      }
    });
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

    // 关闭时清理
    this.panel.onDidDispose(
      () => {
        this.collector.stop();
        this.panel = null;
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
    if (!this.panel) {
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
    const componentTypes = [...new Set(metrics.map(metric => metric.componentType))].sort();
    const metricsHtml = metrics.map(m => this.formatMetricCard(m)).join('\n');
    const diagnosticsHtml = diagnostics.map(item => this.formatDiagnostic(item)).join('\n');
    const statusSummary = this.escapeHtml(this.collector.getStatusSummary());
    const isPaused = this.collector.isPaused();
    const refreshInterval = this.collector.getRefreshInterval();
    const historySeries = this.buildHistorySeries(metrics, this.historyWindow);

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>KBEngine Monitoring</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@3.9.1/dist/chart.min.js"></script>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      background-color: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
      padding: 20px;
    }

    .header {
      margin-bottom: 20px;
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
      background-color: #4CAF50;
    }

    .metric-status.warning {
      background-color: #FF9800;
    }

    .metric-status.error {
      background-color: #F44336;
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
      background-color: #4CAF50;
      transition: width 0.3s ease;
    }

    .progress-fill.warning {
      background-color: #FF9800;
    }

    .progress-fill.error {
      background-color: #F44336;
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
      padding: 12px 14px;
      border-left: 3px solid var(--vscode-testing-iconFailed);
      background-color: var(--vscode-inputValidation-errorBackground);
      color: var(--vscode-editor-foreground);
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
      background-color: var(--vscode-editorGroupHeader-tabsBackground);
      border: 1px solid var(--vscode-panel-border);
      border-left: 3px solid #4CAF50;
      border-radius: 4px;
      padding: 10px 12px;
      line-height: 1.5;
    }

    .diagnostic-item.warning {
      border-left-color: #FF9800;
    }

    .diagnostic-item.error {
      border-left-color: #F44336;
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
      color: var(--vscode-descriptionForeground);
    }
  </style>
</head>
<body>
  <div class="header">
    <h1>KBEngine 服务器监控</h1>
  </div>

  <div class="toolbar">
    <select id="componentFilter">
      <option value="">全部组件</option>
      ${componentTypes
        .map(
          type =>
            `<option value="${this.escapeHtml(type)}"${this.componentFilter === type ? ' selected' : ''}>${this.escapeHtml(type)}</option>`
        )
        .join('')}
    </select>
    <select id="diagnosticFilter">
      <option value=""${this.diagnosticFilter === '' ? ' selected' : ''}>全部诊断</option>
      <option value="info"${this.diagnosticFilter === 'info' ? ' selected' : ''}>信息</option>
      <option value="warning"${this.diagnosticFilter === 'warning' ? ' selected' : ''}>警告</option>
      <option value="error"${this.diagnosticFilter === 'error' ? ' selected' : ''}>错误</option>
    </select>
    <input id="keywordFilter" type="text" placeholder="搜索组件/诊断..." value="${this.escapeHtml(this.keywordFilter)}" />
    <select id="refreshInterval">
      <option value="1000"${refreshInterval === 1000 ? ' selected' : ''}>1 秒</option>
      <option value="2000"${refreshInterval === 2000 ? ' selected' : ''}>2 秒</option>
      <option value="5000"${refreshInterval === 5000 ? ' selected' : ''}>5 秒</option>
      <option value="10000"${refreshInterval === 10000 ? ' selected' : ''}>10 秒</option>
    </select>
    <select id="historyWindow">
      <option value="30"${this.historyWindow === 30 ? ' selected' : ''}>最近 30 点</option>
      <option value="60"${this.historyWindow === 60 ? ' selected' : ''}>最近 60 点</option>
      <option value="120"${this.historyWindow === 120 ? ' selected' : ''}>最近 120 点</option>
    </select>
    <button id="refreshBtn">刷新</button>
    <button id="pauseBtn">${isPaused ? '恢复' : '暂停'}</button>
    <button id="exportBtn">导出数据</button>
  </div>

  <div class="notice">连接状态：${statusSummary} | 自动刷新：${isPaused ? '已暂停' : `${refreshInterval / 1000} 秒`} | 历史窗口：最近 ${this.historyWindow} 点</div>

  <div class="overview">
    <div class="overview-card">
      <div class="overview-title">运行组件</div>
      <div class="overview-value">${overview.runningComponents}</div>
    </div>
    <div class="overview-card">
      <div class="overview-title">总实体数</div>
      <div class="overview-value">${overview.totalEntities}</div>
    </div>
    <div class="overview-card">
      <div class="overview-title">总连接数</div>
      <div class="overview-value">${overview.totalConnections}</div>
    </div>
    <div class="overview-card">
      <div class="overview-title">消息/秒</div>
      <div class="overview-value">${overview.totalMessagesPerSecond}</div>
    </div>
    <div class="overview-card">
      <div class="overview-title">总内存</div>
      <div class="overview-value">${overview.totalMemoryUsage.toFixed(1)} MB</div>
    </div>
    <div class="overview-card">
      <div class="overview-title">总 CPU</div>
      <div class="overview-value">${overview.totalCpuUsage.toFixed(1)}%</div>
    </div>
  </div>

  <div class="metrics-grid">
    ${metricsHtml || '<div class="empty-state">暂无监控数据<br><small>启动 KBEngine 服务器后，监控数据将在此显示</small></div>'}
  </div>

  <div class="diagnostics">
    ${diagnosticsHtml || '<div class="empty-state">暂无诊断信息</div>'}
  </div>

  <div class="charts-container">
    <div class="chart-card">
      <div class="chart-title">CPU 使用率</div>
      <canvas id="cpuChart"></canvas>
    </div>
    <div class="chart-card">
      <div class="chart-title">内存使用</div>
      <canvas id="memoryChart"></canvas>
    </div>
    <div class="chart-card">
      <div class="chart-title">负载变化</div>
      <canvas id="loadChart"></canvas>
    </div>
    <div class="chart-card">
      <div class="chart-title">消息速率</div>
      <canvas id="messagesChart"></canvas>
    </div>
    <div class="chart-card">
      <div class="chart-title">Cell 对象池内存</div>
      <canvas id="objectPoolChart"></canvas>
    </div>
    <div class="chart-card">
      <div class="chart-title">Cell 对象池容量</div>
      <canvas id="objectPoolSizeChart"></canvas>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const metrics = ${JSON.stringify(metrics)};
    const historySeries = ${JSON.stringify(historySeries)};

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
      const colors = [
        'rgba(33, 150, 243, 1)',
        'rgba(156, 39, 176, 1)',
        'rgba(76, 175, 80, 1)',
        'rgba(233, 30, 99, 1)',
        'rgba(255, 152, 0, 1)',
        'rgba(121, 85, 72, 1)'
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
   * 格式化指标卡片
   */
  private formatMetricCard(metric: ComponentMetrics): string {
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
    const detailTitle = metric.componentType === 'cellapp' ? 'Object Pools' : 'Watcher Details';
    const detailHtml = metric.details
      .map(
        detail => `<div class="metric-detail">
        <span class="metric-detail-label">${this.escapeHtml(detail.label)}</span>
        <span>${this.escapeHtml(detail.value)}</span>
      </div>`
      )
      .join('\n');

    return `<div class="metric-card">
      <div class="metric-header">
        <div class="metric-name">${metric.component.toUpperCase()}</div>
        <div class="metric-status ${statusClass}"></div>
      </div>
      <div class="metric-row">
        <span class="metric-label">组件类型</span>
        <span class="metric-value">${metric.componentType}</span>
      </div>
      <div class="metric-row">
        <span class="metric-label">状态</span>
        <span class="metric-value">${metric.status}</span>
      </div>
      <div class="metric-row">
        <span class="metric-label">CPU 使用率</span>
        <span class="metric-value">${cpuPercent}%</span>
      </div>
      <div class="progress-bar">
        <div class="progress-fill ${cpuClass}" style="width: ${cpuPercent}%"></div>
      </div>
      <div class="metric-row">
        <span class="metric-label">内存使用</span>
        <span class="metric-value">${memoryMB} MB</span>
      </div>
      <div class="metric-row">
        <span class="metric-label">负载</span>
        <span class="metric-value">${loadPercent}%</span>
      </div>
      <div class="metric-row">
        <span class="metric-label">连接数</span>
        <span class="metric-value">${metric.connections}</span>
      </div>
      <div class="metric-row">
        <span class="metric-label">实体数</span>
        <span class="metric-value">${metric.entityCount}</span>
      </div>
      <div class="metric-row">
        <span class="metric-label">消息/秒</span>
        <span class="metric-value">${metric.messagesPerSecond}</span>
      </div>
      ${metric.objectPoolSize > 0 || metric.objectPoolMemory > 0 ? `<div class="metric-row">
        <span class="metric-label">对象池容量</span>
        <span class="metric-value">${metric.objectPoolSize}</span>
      </div>
      <div class="metric-row">
        <span class="metric-label">对象池内存</span>
        <span class="metric-value">${objectPoolMemoryMB} B</span>
      </div>` : ''}
      <div class="metric-row">
        <span class="metric-label">运行时间</span>
        <span class="metric-value">${uptimeMin} 分钟</span>
      </div>
      <div class="metric-row">
        <span class="metric-label">进程 PID</span>
        <span class="metric-value">${metric.pid}</span>
      </div>
      <div class="metric-row">
        <span class="metric-label">监听地址</span>
        <span class="metric-value">${metric.internalAddress}</span>
      </div>
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
    if (this.updateTimer) {
      clearTimeout(this.updateTimer);
      this.updateTimer = null;
    }
    this.collector.dispose();
  }
}
