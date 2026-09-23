import type { ComponentMetrics } from '../src/monitoringCollector';
import type * as vscode from 'vscode';
import { beforeEach, describe, expect, it } from 'vitest';
import { MonitoringCollector } from '../src/monitoringCollector';

// MonitoringCollector 的状态机与数值归一纯逻辑。refresh/refreshNow 会真实
// 发起 machine discovery 与 watcher 查询(UDP/TCP),不在纯逻辑测试域;
// 数值归一是私有方法,经实例视图直测真实行为(非 mock)。

const makeCollector = (): MonitoringCollector =>
  new MonitoringCollector({} as unknown as vscode.ExtensionContext);

const internals = (collector: MonitoringCollector): {
  metrics: ComponentMetrics[];
  metricsHistory: Map<string, ComponentMetrics[]>;
  resolveNumber(value: unknown): unknown;
  resolveBooleanLabel(value: unknown): unknown;
  toSafeNumber(value: bigint): number;
} => collector as unknown as never;

const metric = (overrides: Partial<ComponentMetrics> = {}): ComponentMetrics => ({
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
  lastUpdate: new Date(0),
  ...overrides
});

describe('MonitoringCollector initial state', () => {
  it('exposes an empty snapshot before any refresh', () => {
    const collector = makeCollector();

    expect(collector.getAllMetrics()).toEqual([]);
    expect(collector.getSystemOverview()).toEqual({
      totalEntities: 0,
      totalConnections: 0,
      totalMessagesPerSecond: 0,
      runningComponents: 0,
      totalMemoryUsage: 0,
      totalCpuUsage: 0
    });
    expect(collector.isPaused()).toBe(false);
    expect(collector.getRefreshInterval()).toBe(2000);
    expect(collector.getStatusSummary()).toBe('尚未开始监控。');
    expect(collector.getUnavailableReason()).toBe('尚未开始监控。');
    expect(collector.getDiagnostics()).toEqual([]);
    expect(collector.getMetricsHistory('cellapp')).toEqual([]);
  });

  it('publishes the partial data warning for the webview', () => {
    expect(MonitoringCollector.PARTIAL_DATA_WARNING.length).toBeGreaterThan(0);
  });
});

describe('MonitoringCollector paused state and interval', () => {
  let collector: MonitoringCollector;

  beforeEach(() => {
    collector = makeCollector();
  });

  it('updates the refresh interval without starting anything when paused', () => {
    collector.setRefreshInterval(5000);
    expect(collector.getRefreshInterval()).toBe(5000);

    collector.pause();
    expect(collector.isPaused()).toBe(true);

    // 暂停中只改值,不起定时器(无法直接观测定时器,但不应抛出)
    expect(() => collector.setRefreshInterval(7000)).not.toThrow();
    expect(collector.getRefreshInterval()).toBe(7000);
  });

  it('resumes and reports unpaused state', () => {
    collector.pause();
    collector.resume();
    expect(collector.isPaused()).toBe(false);
  });

  it('treats resume without pause as a no-op', () => {
    expect(() => collector.resume()).not.toThrow();
    expect(collector.isPaused()).toBe(false);
  });

  it('stop and dispose stay safe when never started', () => {
    expect(() => collector.stop()).not.toThrow();
    expect(() => collector.dispose()).not.toThrow();
    // dispose 幂等:再次调用不应抛出
    expect(() => collector.dispose()).not.toThrow();
  });
});

describe('MonitoringCollector history slicing', () => {
  it('keeps per-component history and slices to the last N entries', () => {
    const collector = makeCollector();
    const store = internals(collector).metricsHistory;

    const a1 = metric({ componentID: 1 });
    const a2 = metric({ componentID: 2 });
    const a3 = metric({ componentID: 3 });
    const b1 = metric({ component: 'baseapp1', componentType: 'baseapp', componentID: 9 });

    store.set('cellapp', [a1, a2, a3]);
    store.set('baseapp', [b1]);

    expect(collector.getMetricsHistory('cellapp')).toEqual([a1, a2, a3]);
    expect(collector.getMetricsHistory('cellapp', 2)).toEqual([a2, a3]);
    expect(collector.getMetricsHistory('baseapp', 5)).toEqual([b1]);
    expect(collector.getMetricsHistory('missing')).toEqual([]);
  });
});

describe('MonitoringCollector.getSystemOverview', () => {
  it('sums every current metric into the overview', () => {
    const collector = makeCollector();
    const store = internals(collector).metrics;

    store.push(
      metric({ entityCount: 5, connections: 2, messagesPerSecond: 7, memoryUsage: 100, cpuUsage: 10 }),
      metric({
        component: 'baseapp1',
        componentType: 'baseapp',
        componentID: 102,
        entityCount: 6,
        connections: 3,
        messagesPerSecond: 8,
        memoryUsage: 200,
        cpuUsage: 20
      })
    );

    // runningComponents 按当前条目数计(与 status 无关)——锁定实现语义
    expect(collector.getSystemOverview()).toEqual({
      totalEntities: 11,
      totalConnections: 5,
      totalMessagesPerSecond: 15,
      runningComponents: 2,
      totalMemoryUsage: 300,
      totalCpuUsage: 30
    });
    expect(collector.getAllMetrics()).toHaveLength(2);
  });
});

describe('MonitoringCollector value normalization', () => {
  // 方法从实例上以对象调用(不解构),保留 this——resolveBooleanLabel
  // 内部会 this.resolveNumber
  const impl = internals(makeCollector());

  it('resolves watcher values to numbers', () => {
    expect(impl.resolveNumber(10)).toBe(10);
    expect(impl.resolveNumber(true)).toBe(1);
    expect(impl.resolveNumber(false)).toBe(0);
    expect(impl.resolveNumber('3.5')).toBe(3.5);
    expect(impl.resolveNumber('')).toBeUndefined();
    expect(impl.resolveNumber('abc')).toBeUndefined();
    expect(impl.resolveNumber(undefined)).toBeUndefined();
  });

  it('labels boolean-ish watcher values in Chinese', () => {
    expect(impl.resolveBooleanLabel(true)).toBe('是');
    expect(impl.resolveBooleanLabel(false)).toBe('否');
    expect(impl.resolveBooleanLabel(1)).toBe('是');
    expect(impl.resolveBooleanLabel(0)).toBe('否');
    expect(impl.resolveBooleanLabel('2')).toBe('是');
    expect(impl.resolveBooleanLabel(undefined)).toBeUndefined();
    expect(impl.resolveBooleanLabel('abc')).toBeUndefined();
  });

  it('clamps uint64 ids into the safe integer range', () => {
    expect(impl.toSafeNumber(123n)).toBe(123);
    expect(impl.toSafeNumber(BigInt(Number.MAX_SAFE_INTEGER) + 1n)).toBe(Number.MAX_SAFE_INTEGER);
  });
});
