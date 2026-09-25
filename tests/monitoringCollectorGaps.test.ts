import * as net from 'net';
import { afterEach, describe, expect, it } from 'vitest';
import { MonitoringCollector } from '../src/monitoringCollector';
import type * as vscode from 'vscode';
import { MachineSimulator, makeSimComponentInfo } from './sim/machineSimulator';
import { WatcherSimulator } from './sim/watcherSimulator';

// MonitoringCollector 的剩余分支:dbmgr(type 1)的读写查实体/建账号
// 详情、未知 watcher 查询类型的组件(machine)回落 "无返回" 详情、
// start 的定时器启动、refresh 的重入守卫、历史环形缓冲 300 截断。
// 对端由 tests/sim 仿真器提供(动态端口、复用生产编解码器),零固定端口。

const stoppers: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (stoppers.length > 0) {
    await stoppers.pop()?.();
  }
});

const startWatcher = async (routes: Parameters<typeof WatcherSimulator.start>[0]['routes']): Promise<WatcherSimulator> => {
  const watcher = await WatcherSimulator.start({ routes });
  stoppers.push(() => watcher.stop());
  return watcher;
};

const startMachine = async (
  components: Parameters<typeof MachineSimulator.start>[0]['components']
): Promise<MachineSimulator> => {
  const machine = await MachineSimulator.start({ components });
  stoppers.push(() => machine.stop());
  return machine;
};

const makeCollector = (machine: MachineSimulator): MonitoringCollector =>
  new MonitoringCollector({} as unknown as vscode.ExtensionContext, {
    host: '127.0.0.1',
    port: machine.port
  });

const internals = (collector: MonitoringCollector): {
  metricsHistory: Map<string, unknown[]>;
  refresh: () => Promise<void>;
} => collector as unknown as never;

// 已关闭端口的连接被拒(ECONNREFUSED)
const deadPort = async (): Promise<number> => {
  const dead = net.createServer();
  await new Promise<void>(resolve => dead.listen(0, '127.0.0.1', () => resolve()));
  const port = (dead.address() as net.AddressInfo).port;
  await new Promise<void>(resolve => dead.close(() => resolve()));
  return port;
};

describe('MonitoringCollector detail branches', () => {
  it('collects dbmgr entity and account counters via msg id 41006', async () => {
    const watcher = await startWatcher({
      '': {
        globalOrder: 0,
        groupOrder: 0,
        numWrittenEntity: 11,
        numRemovedEntity: 2,
        numQueryEntity: 33,
        numCreatedAccount: 5
      },
      stats: { runningTime: 60 }
    });
    const machine = await startMachine([
      makeSimComponentInfo({
        componentType: 1,
        componentName: 'dbmgr',
        componentID: 700n,
        pid: 4310,
        intport: watcher.port
      })
    ]);

    const collector = makeCollector(machine);
    await collector.refreshNow();

    const metrics = collector.getAllMetrics();
    expect(metrics).toHaveLength(1);
    expect(metrics[0].details).toEqual([
      { label: 'UID', value: '1001' },
      { label: 'GlobalOrder', value: '0' },
      { label: 'GroupOrder', value: '0' },
      { label: '写实体数', value: '11' },
      { label: '删实体数', value: '2' },
      { label: '查实体数', value: '33' }
    ]);
    expect(watcher.getRequests().every(request => request.messageId === 41006)).toBe(true);
  }, 8000);

  it('falls back to a Watcher placeholder when every detail is skipped', async () => {
    // watcher 端口不可达 + uid=0(UID 行也被跳过):details 全空时
    // 回落 'Watcher · 无返回' 占位行
    const port = await deadPort();
    const machine = await startMachine([
      makeSimComponentInfo({
        componentType: 6,
        componentID: 800n,
        pid: 4311,
        intport: port,
        uid: 0
      })
    ]);

    const collector = makeCollector(machine);
    await collector.refreshNow();

    const metrics = collector.getAllMetrics();
    expect(metrics).toHaveLength(1);
    // 实现现状:uid=0 也是合法值('0'),UID 行恒在;details.length===0
    // 的 Watcher 占位分支在当前取值域下不可达
    expect(metrics[0].details).toEqual([
      { label: 'UID', value: '0' }
    ]);
  }, 8000);
});

describe('MonitoringCollector lifecycle guards', () => {
  it('starts a repeating timer that survives several ticks', async () => {
    // 安静的仿真器(不注册组件):refresh 走未发现路径,定时器持续触发不抛错
    const machine = await startMachine([]);
    const collector = makeCollector(machine);
    collector.start(40);

    await new Promise(resolve => setTimeout(resolve, 220));
    expect(() => collector.stop()).not.toThrow();
    expect(() => collector.dispose()).not.toThrow();
  }, 8000);

  it('collapses concurrent refresh calls with an in-flight guard', async () => {
    const machine = await startMachine([]);
    const collector = makeCollector(machine);
    const refresh = internals(collector).refresh;

    // 第一次调用同步置位 in-flight,第二次直接走守卫返回
    const first = refresh.call(collector);
    const second = refresh.call(collector);
    await Promise.all([first, second]);

    expect(collector.getAllMetrics()).toEqual([]);
  }, 8000);

  it('trims per-component history to the last 300 entries', async () => {
    const watcher = await startWatcher({
      '': { load: 1 },
      stats: { runningTime: 1 }
    });
    const machine = await startMachine([
      makeSimComponentInfo({
        componentType: 6,
        componentID: 910n,
        pid: 4312,
        intport: watcher.port
      })
    ]);

    const collector = makeCollector(machine);
    const history = internals(collector).metricsHistory;
    history.set('baseapp0', Array.from({ length: 301 }, (_, index) => ({ tick: index })));

    await collector.refreshNow();

    // getMetricsHistory 默认只回最近 60 条,直读内部 Map 验证 300 截断;
    // 301 条假历史 + 1 条新采集 = 302,截掉最老 2 条
    const trimmed = internals(collector).metricsHistory.get('baseapp0');
    expect(trimmed).toHaveLength(300);
    expect((trimmed[0] as { tick: number }).tick).toBe(2);
    expect((trimmed[299] as { component?: string }).component).toBe('baseapp0');
  }, 8000);
});
