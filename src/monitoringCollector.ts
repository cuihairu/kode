import * as vscode from 'vscode';
import {
  discoverLocalComponents,
  KBEngineComponentInfo,
  queryWatcherPath,
  WatcherQueryResult
} from './kbengineProtocol';

export interface ComponentMetrics {
  component: string;
  componentID: number;
  componentType: string;
  pid: number;
  internalAddress: string;
  cpuUsage: number;
  memoryUsage: number;
  load: number;
  connections: number;
  entityCount: number;
  messagesPerSecond: number;
  objectPoolMemory: number;
  objectPoolSize: number;
  uptime: number;
  status: string;
  statusLevel: 'info' | 'warning' | 'error';
  details: Array<{ label: string; value: string }>;
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

export interface MonitoringDiagnostic {
  timestamp: Date;
  severity: 'info' | 'warning' | 'error';
  source: 'collector' | 'machine' | 'watcher';
  component?: string;
  message: string;
}

type WatcherValueMap = Record<string, string | number | boolean>;

export class MonitoringCollector {
  private updateInterval: NodeJS.Timeout | null = null;
  private readonly metrics: ComponentMetrics[] = [];
  private readonly metricsHistory = new Map<string, ComponentMetrics[]>();
  private diagnostics: MonitoringDiagnostic[] = [];
  private refreshInFlight = false;
  private lastError: Error | null = null;
  private lastStatus = '尚未开始监控。';
  private refreshIntervalMs = 2000;
  private paused = false;

  private _onMetricsUpdate = new vscode.EventEmitter<void>();
  readonly onMetricsUpdate = this._onMetricsUpdate.event;

  constructor(private context: vscode.ExtensionContext) {}

  start(updateIntervalMs: number = 1000): void {
    this.refreshIntervalMs = updateIntervalMs;

    if (!this.paused) {
      this.startTimer();
      void this.refresh();
    }
  }

  async refreshNow(): Promise<void> {
    await this.refresh();
  }

  stop(): void {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
  }

  setRefreshInterval(intervalMs: number): void {
    this.refreshIntervalMs = intervalMs;

    if (!this.paused) {
      this.startTimer();
    }
  }

  pause(): void {
    this.paused = true;
    this.stop();
  }

  resume(): void {
    if (!this.paused) {
      return;
    }

    this.paused = false;
    this.startTimer();
    void this.refresh();
  }

  isPaused(): boolean {
    return this.paused;
  }

  getRefreshInterval(): number {
    return this.refreshIntervalMs;
  }

  getAllMetrics(): ComponentMetrics[] {
    return [...this.metrics];
  }

  getSystemOverview(): SystemOverview {
    return this.metrics.reduce<SystemOverview>(
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

  getMetricsHistory(componentName: string, duration: number = 60): ComponentMetrics[] {
    const history = this.metricsHistory.get(componentName) || [];
    return history.slice(-duration);
  }

  getUnavailableReason(): string {
    return this.lastError?.message || this.lastStatus;
  }

  getStatusSummary(): string {
    return this.lastStatus;
  }

  getDiagnostics(): MonitoringDiagnostic[] {
    return [...this.diagnostics];
  }

  dispose(): void {
    this.stop();
    this._onMetricsUpdate.dispose();
    void this.context;
  }

  private startTimer(): void {
    this.stop();
    this.updateInterval = setInterval(() => {
      void this.refresh();
    }, this.refreshIntervalMs);
  }

  private async refresh(): Promise<void> {
    if (this.refreshInFlight) {
      return;
    }

    this.refreshInFlight = true;

    try {
      const diagnostics: MonitoringDiagnostic[] = [];
      const components = await discoverLocalComponents();
      const monitorable = components.filter(component =>
        [1, 2, 3, 4, 5, 6, 10, 11, 13].includes(component.componentType)
      );

      if (monitorable.length === 0) {
        this.metrics.length = 0;
        this.diagnostics = [
          {
            timestamp: new Date(),
            severity: 'error',
            source: 'machine',
            message: 'machine discovery 未发现任何本地 KBEngine 组件。'
          }
        ];
        this.lastError = new Error('未发现本地 KBEngine 组件，请确认 machine 与各服务已启动。');
        this.lastStatus = this.lastError.message;
        this._onMetricsUpdate.fire();
        return;
      }

      diagnostics.push({
        timestamp: new Date(),
        severity: 'info',
        source: 'machine',
        message: `machine discovery 返回 ${monitorable.length} 个可监控组件。`
      });

      const nextMetrics = await Promise.all(
        monitorable.map(component => this.collectComponentMetrics(component, diagnostics))
      );

      nextMetrics.sort((left, right) => left.component.localeCompare(right.component));
      this.metrics.splice(0, this.metrics.length, ...nextMetrics);
      this.diagnostics = diagnostics;

      for (const metric of nextMetrics) {
        const history = this.metricsHistory.get(metric.component) || [];
        history.push(metric);
        if (history.length > 300) {
          history.splice(0, history.length - 300);
        }
        this.metricsHistory.set(metric.component, history);
      }

      this.lastError = null;
      this.lastStatus = `已连接本地 machine，发现 ${nextMetrics.length} 个组件。`;
      this._onMetricsUpdate.fire();
    } catch (error) {
      this.metrics.length = 0;
      this.lastError = error instanceof Error ? error : new Error(String(error));
      this.lastStatus = this.lastError.message;
      this.diagnostics = [
        {
          timestamp: new Date(),
          severity: 'error',
          source: 'collector',
          message: this.lastError.message
        }
      ];
      this._onMetricsUpdate.fire();
    } finally {
      this.refreshInFlight = false;
    }
  }

  private async collectComponentMetrics(
    component: KBEngineComponentInfo,
    diagnostics: MonitoringDiagnostic[]
  ): Promise<ComponentMetrics> {
    const [rootResult, statsResult, witnessPoolResult, entityRefPoolResult] = await Promise.all([
      this.queryWatcherValues(component, ''),
      this.queryWatcherValues(component, 'stats'),
      component.componentType === 5
        ? this.queryWatcherValues(component, 'objectPools/Witness')
        : Promise.resolve({ values: {}, responded: false }),
      component.componentType === 5
        ? this.queryWatcherValues(component, 'objectPools/EntityRef')
        : Promise.resolve({ values: {}, responded: false })
    ]);
    const rootValues = rootResult.values;
    const statsValues = statsResult.values;
    const witnessPoolValues = witnessPoolResult.values;
    const entityRefPoolValues = entityRefPoolResult.values;

    const componentName = component.fullName;
    const entityCount = this.resolveEntityCount(component, rootValues);
    const connections = this.resolveConnections(component, rootValues);
    const uptime = this.resolveNumber(statsValues.runningTime) ?? 0;
    const messagesPerSecond = this.resolveMessagesPerSecond(component, statsValues);
    const load = this.resolveNumber(rootValues.load) ?? 0;
    const objectPoolMemory = this.resolveObjectPoolMemory(witnessPoolValues, entityRefPoolValues);
    const objectPoolSize = this.resolveObjectPoolSize(witnessPoolValues, entityRefPoolValues);
    const watcherResponded = rootResult.responded || statsResult.responded;
    const status = watcherResponded ? 'watcher 已响应' : '仅 machine 可见，watcher 无返回';
    const statusLevel = watcherResponded ? 'info' : 'warning';

    if (!watcherResponded) {
      diagnostics.push({
        timestamp: new Date(),
        severity: 'warning',
        source: 'watcher',
        component: componentName,
        message: 'TCP 连接已发现组件，但 root/stats watcher 查询没有返回值。'
      });
    } else {
      diagnostics.push({
        timestamp: new Date(),
        severity: 'info',
        source: 'watcher',
        component: componentName,
        message: `watcher 已返回 root=${Object.keys(rootValues).length} 项, stats=${Object.keys(statsValues).length} 项。`
      });
    }

    return {
      component: componentName,
      componentID: this.toSafeNumber(component.componentID),
      componentType: component.componentName,
      pid: component.pid,
      internalAddress: `${component.intaddr}:${component.intport}`,
      cpuUsage: component.cpu,
      memoryUsage: component.mem,
      load,
      connections,
      entityCount,
      messagesPerSecond,
      objectPoolMemory,
      objectPoolSize,
      uptime,
      status,
      statusLevel,
      details: this.buildDetails(
        component,
        rootValues,
        statsValues,
        witnessPoolValues,
        entityRefPoolValues
      ),
      lastUpdate: new Date()
    };
  }

  private async queryWatcherValues(
    component: KBEngineComponentInfo,
    path: string
  ): Promise<{ values: WatcherValueMap; responded: boolean }> {
    try {
      const responses = await queryWatcherPath(component, path);
      const valuesMessage = responses.find(response => response.type === 0);
      return {
        values: valuesMessage?.values || {},
        responded: responses.length > 0
      };
    } catch {
      return {
        values: {},
        responded: false
      };
    }
  }

  private buildDetails(
    component: KBEngineComponentInfo,
    rootValues: WatcherValueMap,
    statsValues: WatcherValueMap,
    witnessPoolValues: WatcherValueMap,
    entityRefPoolValues: WatcherValueMap
  ): Array<{ label: string; value: string }> {
    const details: Array<{ label: string; value: string }> = [];

    const push = (label: string, value: string | number | boolean | undefined) => {
      if (value === undefined || value === '') {
        return;
      }

      details.push({ label, value: String(value) });
    };

    push('UID', component.uid);
    push('GlobalOrder', this.resolveNumber(rootValues.globalOrder));
    push('GroupOrder', this.resolveNumber(rootValues.groupOrder));

    switch (component.componentType) {
      case 10:
        push('总日志数', this.resolveNumber(statsValues.totalNumlogs));
        push('缓存日志', this.resolveNumber(statsValues.bufferedLogsSize));
        break;
      case 1:
        push('写实体数', this.resolveNumber(rootValues.numWrittenEntity));
        push('删实体数', this.resolveNumber(rootValues.numRemovedEntity));
        push('查实体数', this.resolveNumber(rootValues.numQueryEntity));
        push('建账号数', this.resolveNumber(rootValues.numCreatedAccount));
        break;
      case 6:
        push('Proxy 数', this.resolveNumber(rootValues.numProxices));
        push('客户端数', this.resolveNumber(rootValues.numClients));
        break;
      case 5:
        push('Space 数', this.resolveNumber(rootValues.spaceSize));
        push('Witness 池大小', this.resolveNumber(witnessPoolValues.size));
        push('Witness 池峰值', this.resolveNumber(witnessPoolValues.max));
        push('Witness 池内存', this.resolveNumber(witnessPoolValues.memory));
        push('Witness 分配次数', this.resolveNumber(witnessPoolValues.totalAllocs));
        push('Witness 已销毁', this.resolveBooleanLabel(witnessPoolValues.isDestroyed));
        push('EntityRef 池大小', this.resolveNumber(entityRefPoolValues.size));
        push('EntityRef 池峰值', this.resolveNumber(entityRefPoolValues.max));
        push('EntityRef 池内存', this.resolveNumber(entityRefPoolValues.memory));
        push('EntityRef 分配次数', this.resolveNumber(entityRefPoolValues.totalAllocs));
        push('EntityRef 已销毁', this.resolveBooleanLabel(entityRefPoolValues.isDestroyed));
        break;
      default:
        break;
    }

    if (details.length === 0) {
      push('Watcher', Object.keys(rootValues).length > 0 || Object.keys(statsValues).length > 0 ? '已响应' : '无返回');
    }

    return details.slice(0, component.componentType === 5 ? 10 : 6);
  }

  private resolveObjectPoolMemory(
    witnessPoolValues: WatcherValueMap,
    entityRefPoolValues: WatcherValueMap
  ): number {
    return (
      (this.resolveNumber(witnessPoolValues.memory) ?? 0) +
      (this.resolveNumber(entityRefPoolValues.memory) ?? 0)
    );
  }

  private resolveObjectPoolSize(
    witnessPoolValues: WatcherValueMap,
    entityRefPoolValues: WatcherValueMap
  ): number {
    return (
      (this.resolveNumber(witnessPoolValues.size) ?? 0) +
      (this.resolveNumber(entityRefPoolValues.size) ?? 0)
    );
  }

  private resolveEntityCount(
    component: KBEngineComponentInfo,
    rootValues: WatcherValueMap
  ): number {
    if (component.componentType === 5 || component.componentType === 6) {
      return this.toSafeNumber(component.extradata);
    }

    return this.resolveNumber(rootValues.entitySize) ?? 0;
  }

  private resolveConnections(
    component: KBEngineComponentInfo,
    rootValues: WatcherValueMap
  ): number {
    if (component.componentType === 6) {
      return this.toSafeNumber(component.extradata1);
    }

    return (
      this.resolveNumber(rootValues.numClients) ??
      this.resolveNumber(rootValues.clients) ??
      0
    );
  }

  private resolveMessagesPerSecond(
    component: KBEngineComponentInfo,
    statsValues: WatcherValueMap
  ): number {
    if (component.componentType === 10) {
      return this.resolveNumber(statsValues.secsNumlogs) ?? 0;
    }

    return this.resolveNumber(statsValues.messagesPerSecond) ?? 0;
  }

  private resolveNumber(value: string | number | boolean | undefined): number | undefined {
    if (typeof value === 'number') {
      return value;
    }

    if (typeof value === 'boolean') {
      return value ? 1 : 0;
    }

    if (typeof value === 'string' && value.length > 0) {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : undefined;
    }

    return undefined;
  }

  private resolveBooleanLabel(value: string | number | boolean | undefined): string | undefined {
    if (typeof value === 'boolean') {
      return value ? '是' : '否';
    }

    const resolved = this.resolveNumber(value);
    if (resolved === undefined) {
      return undefined;
    }

    return resolved > 0 ? '是' : '否';
  }

  private toSafeNumber(value: bigint): number {
    return value > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(value);
  }
}
