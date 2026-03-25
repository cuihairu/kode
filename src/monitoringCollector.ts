/**
 * KBEngine 监控数据收集器
 * 从 KBEngine 组件收集性能和状态指标
 */

import * as vscode from 'vscode';
import * as net from 'net';

/**
 * 组件性能指标
 */
export interface ComponentMetrics {
  /** 组件名称 */
  component: string;
  /** 组件 ID */
  componentID: number;
  /** CPU 使用率 (%) */
  cpuUsage: number;
  /** 内存使用量 (MB) */
  memoryUsage: number;
  /** 网络连接数 */
  connections: number;
  /** 实体数量 */
  entityCount: number;
  /** 每秒消息数 */
  messagesPerSecond: number;
  /** 运行时间（秒） */
  uptime: number;
  /** 最后更新时间 */
  lastUpdate: Date;
}

/**
 * 系统概览指标
 */
export interface SystemOverview {
  /** 总实体数 */
  totalEntities: number;
  /** 总连接数 */
  totalConnections: number;
  /** 总消息吞吐量 */
  totalMessagesPerSecond: number;
  /** 运行中的组件数 */
  runningComponents: number;
  /** 总内存使用 */
  totalMemoryUsage: number;
  /** 总 CPU 使用 */
  totalCpuUsage: number;
}

/**
 * KBEngine 监控数据收集器
 * 通过 KBEngine 的 Watcher 系统收集性能数据
 */
export class MonitoringCollector {
  private metrics: Map<string, ComponentMetrics> = new Map();
  private updateInterval: NodeJS.Timeout | null = null;
  private socket: net.Socket | null = null;

  private _onMetricsUpdate = new vscode.EventEmitter<void>();
  readonly onMetricsUpdate = this._onMetricsUpdate.event;

  constructor(private context: vscode.ExtensionContext) {}

  /**
   * 启动监控数据收集
   */
  start(updateIntervalMs: number = 1000): void {
    if (this.updateInterval) {
      return; // 已经在运行
    }

    this.updateInterval = setInterval(() => {
      this.collectMetrics();
    }, updateIntervalMs);

    this.collectMetrics(); // 立即收集一次
  }

  /**
   * 停止监控数据收集
   */
  stop(): void {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }

    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
  }

  /**
   * 收集性能指标
   */
  private async collectMetrics(): Promise<void> {
    try {
      // 尝试连接到 KBEngine 的内部监控接口
      // 这里模拟收集数据，实际应该从 KBEngine 的 Watcher 系统获取
      const components = ['machine', 'dbmgr', 'baseappmgr', 'cellappmgr', 'baseapp', 'cellapp'];

      for (const component of components) {
        const metrics = await this.getComponentMetrics(component);
        if (metrics) {
          this.metrics.set(component, metrics);
        }
      }

      this._onMetricsUpdate.fire();
    } catch (error) {
      console.error('收集监控数据失败:', error);
    }
  }

  /**
   * 获取单个组件的指标
   */
  private async getComponentMetrics(componentName: string): Promise<ComponentMetrics | null> {
    // 这里应该实际连接到 KBEngine 的监控接口
    // 目前返回模拟数据
    return {
      component: componentName,
      componentID: this.getComponentID(componentName),
      cpuUsage: Math.random() * 10 + this.getRandomBase(componentName),
      memoryUsage: Math.random() * 100 + this.getMemoryBase(componentName),
      connections: Math.floor(Math.random() * 100) + this.getConnectionBase(componentName),
      entityCount: Math.floor(Math.random() * 1000) + 10,
      messagesPerSecond: Math.floor(Math.random() * 1000) + 100,
      uptime: Math.floor(Math.random() * 3600) + 60,
      lastUpdate: new Date()
    };
  }

  /**
   * 获取组件 ID（KBEngine 内部）
   */
  private getComponentID(componentName: string): number {
    const ids: { [key: string]: number } = {
      'machine': 1,
      'logger': 10,
      'dbmgr': 2,
      'baseappmgr': 3,
      'cellappmgr': 4,
      'loginapp': 5,
      'baseapp': 6,
      'cellapp': 7,
      'bots': 9
    };
    return ids[componentName] || 0;
  }

  /**
   * 获取随机基数（模拟数据）
   */
  private getRandomBase(componentName: string): number {
    const bases: { [key: string]: number } = {
      'machine': 0,
      'dbmgr': 2,
      'baseapp': 5,
      'cellapp': 8,
      'loginapp': 1
    };
    return bases[componentName] || 0;
  }

  /**
   * 获取内存基数（MB）
   */
  private getMemoryBase(componentName: string): number {
    const bases: { [key: string]: number } = {
      'machine': 50,
      'dbmgr': 200,
      'baseapp': 100,
      'cellapp': 150,
      'loginapp': 80
    };
    return bases[componentName] || 50;
  }

  /**
   * 获取连接基数
   */
  private getConnectionBase(componentName: string): number {
    const bases: { [key: string]: number } = {
      'baseapp': 100,
      'cellapp': 50,
      'loginapp': 10
    };
    return bases[componentName] || 0;
  }

  /**
   * 获取所有组件的指标
   */
  getAllMetrics(): ComponentMetrics[] {
    return Array.from(this.metrics.values());
  }

  /**
   * 获取系统概览
   */
  getSystemOverview(): SystemOverview {
    const allMetrics = this.getAllMetrics();

    return {
      totalEntities: allMetrics.reduce((sum, m) => sum + m.entityCount, 0),
      totalConnections: allMetrics.reduce((sum, m) => sum + m.connections, 0),
      totalMessagesPerSecond: allMetrics.reduce((sum, m) => sum + m.messagesPerSecond, 0),
      runningComponents: allMetrics.length,
      totalMemoryUsage: allMetrics.reduce((sum, m) => sum + m.memoryUsage, 0),
      totalCpuUsage: allMetrics.reduce((sum, m) => sum + m.cpuUsage, 0)
    };
  }

  /**
   * 获取组件指标历史（用于绘制图表）
   */
  getMetricsHistory(componentName: string, duration: number = 60): ComponentMetrics[] {
    // 这里应该返回历史数据，目前返回空数组
    // 实际实现需要保存历史数据点
    return [];
  }

  /**
   * 清理资源
   */
  dispose(): void {
    this.stop();
    this._onMetricsUpdate.dispose();
  }
}
