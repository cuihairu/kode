/**
 * KBEngine 监控面板 WebView
 * 可视化显示服务器性能和状态指标
 */

import * as vscode from 'vscode';
import { ComponentMetrics, SystemOverview, MonitoringCollector } from './monitoringCollector';

/**
 * 监控面板 WebView
 */
export class MonitoringWebView {
  private panel: vscode.WebviewPanel | null = null;
  private updateTimer: NodeJS.Timeout | null = null;

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
    this.collector.start(2000);

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

    const overview = this.collector.getSystemOverview();
    const metrics = this.collector.getAllMetrics();
    const html = this.getHtml(overview, metrics);
    this.panel.webview.html = html;
  }

  /**
   * 处理来自 WebView 的消息
   */
  private handleMessage(message: any): void {
    switch (message.command) {
      case 'refresh':
        this.updateWebView();
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
    const metrics = this.collector.getAllMetrics();
    const data = JSON.stringify(metrics, null, 2);

    vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file('kbengine_metrics.json'),
      filters: {
        'JSON Files': ['json'],
        'All Files': ['*']
      }
    }).then(uri => {
      if (uri) {
        vscode.workspace.fs.writeFile(uri, Buffer.from(data, 'utf8')).then(() => {
          vscode.window.showInformationMessage(`监控数据已导出到 ${uri.fsPath}`);
        });
      }
    });
  }

  /**
   * 生成 HTML
   */
  private getHtml(overview: SystemOverview, metrics: ComponentMetrics[]): string {
    const metricsHtml = metrics.map(m => this.formatMetricCard(m)).join('\n');

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
  </style>
</head>
<body>
  <div class="header">
    <h1>KBEngine 服务器监控</h1>
  </div>

  <div class="toolbar">
    <button id="refreshBtn">刷新</button>
    <button id="exportBtn">导出数据</button>
  </div>

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
      <div class="chart-title">网络流量</div>
      <canvas id="networkChart"></canvas>
    </div>
    <div class="chart-card">
      <div class="chart-title">实体数量</div>
      <canvas id="entityChart"></canvas>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const metrics = ${JSON.stringify(metrics)};

    // 刷新
    document.getElementById('refreshBtn').addEventListener('click', () => {
      vscode.postMessage({ command: 'refresh' });
    });

    // 导出
    document.getElementById('exportBtn').addEventListener('click', () => {
      vscode.postMessage({ command: 'exportMetrics' });
    });

    // 创建图表
    createCharts(metrics);

    function createCharts(metrics) {
      const labels = metrics.map(m => m.component);
      const cpuData = metrics.map(m => m.cpuUsage);
      const memoryData = metrics.map(m => m.memoryUsage);
      const connectionsData = metrics.map(m => m.connections);
      const entityData = metrics.map(m => m.entityCount);

      // CPU 图表
      new Chart(document.getElementById('cpuChart'), {
        type: 'bar',
        data: {
          labels: labels,
          datasets: [{
            label: 'CPU 使用率 (%)',
            data: cpuData,
            backgroundColor: 'rgba(33, 150, 243, 0.6)',
            borderColor: 'rgba(33, 150, 243, 1)',
            borderWidth: 1
          }]
        },
        options: {
          responsive: true,
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
        type: 'bar',
        data: {
          labels: labels,
          datasets: [{
            label: '内存使用 (MB)',
            data: memoryData,
            backgroundColor: 'rgba(156, 39, 176, 0.6)',
            borderColor: 'rgba(156, 39, 176, 1)',
            borderWidth: 1
          }]
        },
        options: {
          responsive: true,
          scales: {
            y: {
              beginAtZero: true
            }
          }
        }
      });

      // 网络流量图表
      new Chart(document.getElementById('networkChart'), {
        type: 'line',
        data: {
          labels: labels,
          datasets: [{
            label: '连接数',
            data: connectionsData,
            borderColor: 'rgba(76, 175, 80, 1)',
            backgroundColor: 'rgba(76, 175, 80, 0.2)',
            tension: 0.4,
            fill: true
          }]
        },
        options: {
          responsive: true,
          scales: {
            y: {
              beginAtZero: true
            }
          }
        }
      });

      // 实体数量图表
      new Chart(document.getElementById('entityChart'), {
        type: 'line',
        data: {
          labels: labels,
          datasets: [{
            label: '实体数',
            data: entityData,
            borderColor: 'rgba(233, 30, 99, 1)',
            backgroundColor: 'rgba(233, 30, 99, 0.2)',
            tension: 0.4,
            fill: true
          }]
        },
        options: {
          responsive: true,
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

  /**
   * 格式化指标卡片
   */
  private formatMetricCard(metric: ComponentMetrics): string {
    const cpuPercent = metric.cpuUsage.toFixed(1);
    const cpuClass = metric.cpuUsage > 80 ? 'error' : (metric.cpuUsage > 50 ? 'warning' : '');
    const memoryMB = metric.memoryUsage.toFixed(1);
    const uptimeMin = Math.floor(metric.uptime / 60);

    return `<div class="metric-card">
      <div class="metric-header">
        <div class="metric-name">${metric.component.toUpperCase()}</div>
        <div class="metric-status"></div>
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
      <div class="metric-row">
        <span class="metric-label">运行时间</span>
        <span class="metric-value">${uptimeMin} 分钟</span>
      </div>
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
