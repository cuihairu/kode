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
import { webviewAssetUri } from './webviewSecurity';
import { renderMonitoringWebview, escapeHtml, formatMetricCard, formatDiagnostic } from './monitoringWebViewHtml';


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
  /**
   * 生成 HTML
   */
  private getHtml(
    overview: SystemOverview,
    metrics: ComponentMetrics[],
    diagnostics: MonitoringDiagnostic[]
  ): string {
    return renderMonitoringWebview({
      overview,
      metrics,
      diagnostics,
      componentFilter: this.componentFilter,
      diagnosticFilter: this.diagnosticFilter,
      keywordFilter: this.keywordFilter,
      historyWindow: this.historyWindow,
      statusSummary: this.collector.getStatusSummary(),
      isPaused: this.collector.isPaused(),
      refreshInterval: this.collector.getRefreshInterval(),
      historySeries: this.buildHistorySeries(metrics, this.historyWindow),
      cspSource: this.panel?.webview.cspSource ?? 'vscode-webview:',
      chartAssetUri: webviewAssetUri(this.panel?.webview, this.context.extensionUri, 'media', 'chart.min.js')
    });
  }

  private escapeHtml(text: string): string {
    return escapeHtml(text);
  }

  private formatMetricCard(metric: ComponentMetrics): string {
    return formatMetricCard(metric);
  }

  private formatDiagnostic(item: MonitoringDiagnostic): string {
    return formatDiagnostic(item);
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

