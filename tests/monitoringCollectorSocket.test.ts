import * as net from 'net';
import { afterEach, describe, expect, it } from 'vitest';
import type { ComponentMetrics } from '../src/monitoringCollector';
import { MonitoringCollector } from '../src/monitoringCollector';
import type * as vscode from 'vscode';
import { MachineSimulator, makeSimComponentInfo } from './sim/machineSimulator';
import { startSimCluster } from './sim/simCluster';
import type { SimCluster } from './sim/simCluster';

// MonitoringCollector 的 refresh 链路:仿真集群(tests/sim,端口全部动态
// 分配)上走 discover → watcher 查询 → 指标聚合 → 诊断/历史/状态汇总
// 全链路,零 mock、零固定端口(docs/redesign.md 阶段 1)。

const clusters: SimCluster[] = [];
const machines: MachineSimulator[] = [];

afterEach(async () => {
  while (clusters.length > 0) {
    await clusters.pop()?.stop();
  }
  while (machines.length > 0) {
    await machines.pop()?.stop();
  }
});

const startCluster = async (specs: Parameters<typeof startSimCluster>[0]): Promise<SimCluster> => {
  const cluster = await startSimCluster(specs);
  clusters.push(cluster);
  return cluster;
};

const startMachine = async (options?: Parameters<typeof MachineSimulator.start>[0]): Promise<MachineSimulator> => {
  const machine = await MachineSimulator.start(options);
  machines.push(machine);
  return machine;
};

const makeCollector = (cluster: SimCluster): MonitoringCollector =>
  new MonitoringCollector({} as unknown as vscode.ExtensionContext, cluster.discoveryOptions);

const internals = (collector: MonitoringCollector): {
  metrics: ComponentMetrics[];
} => collector as unknown as { metrics: ComponentMetrics[] };

// 已关闭端口的连接被拒(ECONNREFUSED),驱动 watcher 不可达路径
const deadPort = async (): Promise<number> => {
  const dead = net.createServer();
  await new Promise<void>(resolve => dead.listen(0, '127.0.0.1', () => resolve()));
  const port = (dead.address() as net.AddressInfo).port;
  await new Promise<void>(resolve => dead.close(() => resolve()));
  return port;
};

describe('MonitoringCollector refresh over real sockets', () => {
  it('collects full watcher metrics for a baseapp', async () => {
    const cluster = await startCluster([
      {
        componentType: 6,
        componentID: 900n,
        pid: 4321,
        extradata: 7n,
        extradata1: 3n,
        routes: {
          '': { load: 5, globalOrder: 2, groupOrder: 1, numProxices: 4, numClients: 11 },
          stats: { runningTime: 3600, messagesPerSecond: 42 }
        }
      }
    ]);

    const collector = makeCollector(cluster);
    let fired = 0;
    collector.onMetricsUpdate(() => {
      fired += 1;
    });

    await collector.refreshNow();

    const metrics = collector.getAllMetrics();
    expect(metrics).toHaveLength(1);
    expect(metrics[0]).toMatchObject({
      component: 'baseapp0',
      componentID: 900,
      componentType: 'baseapp',
      pid: 4321,
      internalAddress: `127.0.0.1:${cluster.watchers[0].port}`,
      cpuUsage: 0.5,
      memoryUsage: 25,
      load: 5,
      connections: 3,
      entityCount: 7,
      messagesPerSecond: 42,
      objectPoolMemory: 0,
      objectPoolSize: 0,
      uptime: 3600,
      status: 'watcher 已响应',
      statusLevel: 'info'
    });
    // baseapp 详情:UID+GlobalOrder+GroupOrder+numProxices+numClients
    expect(metrics[0].details).toEqual([
      { label: 'UID', value: '1001' },
      { label: 'GlobalOrder', value: '2' },
      { label: 'GroupOrder', value: '1' },
      { label: 'Proxy 数', value: '4' },
      { label: '客户端数', value: '11' }
    ]);
    expect(collector.getStatusSummary()).toBe(
      '已连接本地 machine，发现 1 个组件，watcher 数据完整。'
    );
    const diagnostics = collector.getDiagnostics();
    expect(diagnostics[0]).toMatchObject({ severity: 'info', source: 'machine' });
    expect(diagnostics[0].message).toContain('1 个可监控组件');
    expect(diagnostics[1]).toMatchObject({
      severity: 'info',
      source: 'watcher',
      component: 'baseapp0'
    });
    expect(diagnostics[1].message).toContain('root=5');
    expect(diagnostics[1].message).toContain('stats=2');
    expect(collector.getMetricsHistory('baseapp0')).toHaveLength(1);
    expect(collector.getUnavailableReason()).toBe(collector.getStatusSummary());
    expect(fired).toBeGreaterThan(0);

    const watcher = cluster.watchers[0];
    expect(watcher.getRequests()).toHaveLength(2);
    expect(watcher.getRequests().every(request => request.messageId === 41001)).toBe(true);
    expect(watcher.getRequests().map(request => request.path).sort()).toEqual(['', 'stats']);
  }, 8000);

  it('sums cellapp object pools and slices details to ten', async () => {
    const cluster = await startCluster([
      {
        componentType: 5,
        componentID: 901n,
        pid: 4322,
        extradata: 9n,
        routes: {
          '': { spaceSize: 3, load: 1 },
          stats: { runningTime: 60, messagesPerSecond: 7 },
          'objectPools/Witness': {
            size: 4,
            max: 10,
            memory: 2048,
            totalAllocs: 100,
            isDestroyed: true
          },
          'objectPools/EntityRef': {
            size: 6,
            max: 12,
            memory: 4096,
            totalAllocs: 200,
            isDestroyed: false
          }
        }
      }
    ]);

    const collector = makeCollector(cluster);
    await collector.refreshNow();

    const metric = collector.getAllMetrics()[0];
    expect(metric).toMatchObject({
      component: 'cellapp0',
      componentType: 'cellapp',
      entityCount: 9,
      objectPoolMemory: 6144,
      objectPoolSize: 10,
      uptime: 60
    });
    // cellapp 详情 UID + 11 项裁剪为 10(EntityRef 已销毁被裁)
    expect(metric.details).toHaveLength(10);
    expect(metric.details[0]).toEqual({ label: 'UID', value: '1001' });
    expect(metric.details[1]).toEqual({ label: 'Space 数', value: '3' });
    expect(metric.details[3]).toEqual({ label: 'Witness 池峰值', value: '10' });
    expect(metric.details[6]).toEqual({ label: 'Witness 已销毁', value: '是' });
    expect(metric.details[9]).toEqual({ label: 'EntityRef 池内存', value: '4096' });
    expect(metric.statusLevel).toBe('info');

    const watcher = cluster.watchers[0];
    expect(watcher.getRequests()).toHaveLength(4);
    expect(watcher.getRequests().every(request => request.messageId === 41002)).toBe(true);
    expect(watcher.getRequests().map(request => request.path).sort()).toEqual([
      '',
      'objectPools/EntityRef',
      'objectPools/Witness',
      'stats'
    ]);
  }, 8000);

  it('sorts multiple components and derives logger rate from secsNumlogs', async () => {
    const cluster = await startCluster([
      {
        componentType: 6,
        componentID: 900n,
        pid: 4321,
        routes: {
          '': { load: 2 },
          stats: { runningTime: 10, messagesPerSecond: 5 }
        }
      },
      {
        componentType: 10,
        componentID: 902n,
        pid: 4323,
        routes: {
          '': {},
          stats: { secsNumlogs: 33, totalNumlogs: 99, bufferedLogsSize: 5 }
        }
      }
    ]);

    const collector = makeCollector(cluster);
    await collector.refreshNow();

    const metrics = collector.getAllMetrics();
    expect(metrics.map(metric => metric.component)).toEqual(['baseapp0', 'logger']);
    // logger 的 fullName 不追加 groupOrderID(仅 type 5/6 追加)
    const logger = metrics[1];
    expect(logger.messagesPerSecond).toBe(33);
    expect(logger.uptime).toBe(0);
    expect(logger.load).toBe(0);
    expect(logger.details).toEqual([
      { label: 'UID', value: '1001' },
      { label: '总日志数', value: '99' },
      { label: '缓存日志', value: '5' }
    ]);
    expect(collector.getStatusSummary()).toBe(
      '已连接本地 machine，发现 2 个组件，watcher 数据完整。'
    );
    expect(cluster.watchers[0].getRequests().every(request => request.messageId === 41001)).toBe(true);
    expect(cluster.watchers[1].getRequests().every(request => request.messageId === 41008)).toBe(true);
  }, 8000);

  it('marks a machine-visible component as partial when watcher is unreachable', async () => {
    // 广播里组件的 watcher 端口指向已死端口:连接被拒,组件仅 machine 可见
    const watcherPort = await deadPort();
    const machine = await startMachine({
      components: [
        makeSimComponentInfo({
          componentType: 6,
          componentID: 900n,
          pid: 4321,
          extradata: 7n,
          intport: watcherPort
        })
      ]
    });

    const collector = new MonitoringCollector({} as unknown as vscode.ExtensionContext, {
      host: '127.0.0.1',
      port: machine.port
    });
    await collector.refreshNow();

    const metric = collector.getAllMetrics()[0];
    expect(metric).toMatchObject({
      component: 'baseapp0',
      entityCount: 7,
      load: 0,
      uptime: 0,
      status: '仅 machine 可见，watcher 无返回',
      statusLevel: 'warning'
    });
    // watcher 静默时详情只剩 UID
    expect(metric.details).toEqual([{ label: 'UID', value: '1001' }]);
    expect(collector.getStatusSummary()).toBe(
      `已连接本地 machine，发现 1 个组件，其中 1 个 watcher 无响应。${MonitoringCollector.PARTIAL_DATA_WARNING}`
    );
    const diagnostics = collector.getDiagnostics();
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics[1]).toMatchObject({
      severity: 'warning',
      source: 'watcher',
      component: 'baseapp0'
    });
    expect(diagnostics[1].message).toContain('watcher 查询没有返回值');
  }, 8000);

  it('clears metrics and reports an error when discovery finds nothing', async () => {
    // 预置一条旧指标,验证刷新后清空;machine 仿真器不注册组件 → discovery 空
    const machine = await startMachine();
    const collector = new MonitoringCollector({} as unknown as vscode.ExtensionContext, {
      host: '127.0.0.1',
      port: machine.port
    });
    internals(collector).metrics.push({
      component: 'stale',
      componentID: 1,
      componentType: 'baseapp',
      pid: 1,
      internalAddress: '127.0.0.1:1',
      cpuUsage: 0,
      memoryUsage: 0,
      load: 0,
      connections: 0,
      entityCount: 0,
      messagesPerSecond: 0,
      objectPoolMemory: 0,
      objectPoolSize: 0,
      uptime: 0,
      status: 'stale',
      statusLevel: 'info',
      details: [],
      lastUpdate: new Date(0)
    });

    let fired = 0;
    collector.onMetricsUpdate(() => {
      fired += 1;
    });

    await collector.refreshNow();

    expect(collector.getAllMetrics()).toEqual([]);
    expect(collector.getDiagnostics()).toHaveLength(1);
    expect(collector.getDiagnostics()[0]).toMatchObject({
      severity: 'error',
      source: 'machine',
      message: 'machine discovery 未发现任何本地 KBEngine 组件。'
    });
    expect(collector.getStatusSummary()).toBe(
      '未发现本地 KBEngine 组件，请确认 machine 与各服务已启动。'
    );
    expect(collector.getUnavailableReason()).toBe(collector.getStatusSummary());
    expect(fired).toBe(1);
  }, 8000);

  it('routes malformed discovery packets into collector diagnostics', async () => {
    const machine = await startMachine({ mode: 'garbage' });
    const collector = new MonitoringCollector({} as unknown as vscode.ExtensionContext, {
      host: '127.0.0.1',
      port: machine.port
    });

    await collector.refreshNow();

    expect(collector.getAllMetrics()).toEqual([]);
    const diagnostics = collector.getDiagnostics();
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ severity: 'error', source: 'collector' });
    expect(diagnostics[0].message.length).toBeGreaterThan(0);
    expect(collector.getStatusSummary()).toBe(diagnostics[0].message);
    expect(collector.getUnavailableReason()).toBe(diagnostics[0].message);
  }, 8000);
});
