import * as vscode from 'vscode';

export interface ComponentMetrics {
  component: string;
  componentID: number;
  cpuUsage: number;
  memoryUsage: number;
  connections: number;
  entityCount: number;
  messagesPerSecond: number;
  uptime: number;
  lastUpdate: Date;
}

export interface SystemOverview {
  totalEntities: number;
  totalConnections: number;
  totalMessagesPerSecond: number;
  runningComponents: number;
  totalMemoryUsage: number;
  totalCpuUsage: number;
}

/**
 * KBEngine 的监控数据来自 watcher 系统。
 * 当前插件尚未实现 watcher 协议，因此不能继续返回随机数据伪装成功能可用。
 */
export class MonitoringCollector {
  private updateInterval: NodeJS.Timeout | null = null;
  private readonly metrics: ComponentMetrics[] = [];

  private _onMetricsUpdate = new vscode.EventEmitter<void>();
  readonly onMetricsUpdate = this._onMetricsUpdate.event;

  constructor(private context: vscode.ExtensionContext) {}

  start(updateIntervalMs: number = 1000): void {
    if (this.updateInterval) {
      return;
    }

    this.updateInterval = setInterval(() => {
      this._onMetricsUpdate.fire();
    }, updateIntervalMs);

    this._onMetricsUpdate.fire();
  }

  stop(): void {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
  }

  getAllMetrics(): ComponentMetrics[] {
    return [...this.metrics];
  }

  getSystemOverview(): SystemOverview {
    return {
      totalEntities: 0,
      totalConnections: 0,
      totalMessagesPerSecond: 0,
      runningComponents: 0,
      totalMemoryUsage: 0,
      totalCpuUsage: 0
    };
  }

  getMetricsHistory(componentName: string, duration: number = 60): ComponentMetrics[] {
    void componentName;
    void duration;
    return [];
  }

  getUnavailableReason(): string {
    return 'KBEngine watcher 协议尚未接入，监控面板当前不提供实时数据。';
  }

  dispose(): void {
    this.stop();
    this._onMetricsUpdate.dispose();
    void this.context;
  }
}
