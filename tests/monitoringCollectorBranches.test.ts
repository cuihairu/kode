import * as net from 'net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MonitoringCollector } from '../src/monitoringCollector';
import type { KBEngineComponentInfo, MachineDiscoveryOptions } from '../src/kbengineProtocol';
import type * as vscode from 'vscode';
import { MachineSimulator, makeSimComponentInfo } from './sim/machineSimulator';
import { WatcherSimulator } from './sim/watcherSimulator';

// 批61 分支覆盖专项(monitoringCollector.ts):逐分支补齐——
// - start() 在暂停态的两级回落(不起定时器、不触发刷新,恢复后再生效);
// - refresh 的 catch 对非 Error 抛出值的归一(Error 保原文,其余 String 化);
// - 无 watcher 消息 id 的可监控组件类型(bots=11):queryWatcherPath 直接空
//   结果 → queryWatcherValues 的 values 回落、buildDetails 的 switch default;
// - logger(type 10)的 stats 缺 secsNumlogs 时的 ?? 0 回落;
// - details 全空时的 'Watcher' 占位行两臂(根值空 → 短路取 stats 键数)。
// 后两条走 tests/sim 仿真器(动态端口、复用生产编解码器)的真实 UDP/TCP 链路;
// 前一条与非 Error 抛出用 vi.mock('../src/kbengineProtocol') 的 getter 工厂
// 局部替换 discoverLocalComponents(其余导出透传实际实现),用以观察"刷新未
// 发生"与注入语言合法但实现链不产生的抛出值。

const discoveryState = vi.hoisted(() => ({
  impl: undefined as undefined
    | ((options?: MachineDiscoveryOptions) => Promise<KBEngineComponentInfo[]>)
}));

vi.mock('../src/kbengineProtocol', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/kbengineProtocol')>();
  return {
    ...actual,
    default: actual,
    get discoverLocalComponents() {
      return discoveryState.impl ?? actual.discoverLocalComponents;
    }
  };
});

const stoppers: Array<() => Promise<void>> = [];

afterEach(() => {
  discoveryState.impl = undefined;
});

const stopAll = async (): Promise<void> => {
  while (stoppers.length > 0) {
    await stoppers.pop()?.();
  }
};

const startWatcher = async (options: Parameters<typeof WatcherSimulator.start>[0]): Promise<WatcherSimulator> => {
  const watcher = await WatcherSimulator.start(options);
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

const makeCollector = (machine?: MachineSimulator): MonitoringCollector =>
  new MonitoringCollector({} as unknown as vscode.ExtensionContext, machine
    ? { host: '127.0.0.1', port: machine.port }
    : {});

const internals = (collector: MonitoringCollector): {
  updateInterval: NodeJS.Timeout | null;
} => collector as unknown as never;

const until = async (predicate: () => boolean, timeoutMs = 4000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('condition not met before deadline');
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
};

// 已关闭端口的连接被拒(ECONNREFUSED)
const deadPort = async (): Promise<number> => {
  const dead = net.createServer();
  await new Promise<void>(resolve => dead.listen(0, '127.0.0.1', () => resolve()));
  const port = (dead.address() as net.AddressInfo).port;
  await new Promise<void>(resolve => dead.close(() => resolve()));
  return port;
};

describe('MonitoringCollector 暂停态 start 与非 Error 抛出归一', () => {
  it('start 在暂停态只记间隔,不起定时器也不刷新', async () => {
    const calls: Array<MachineDiscoveryOptions | undefined> = [];
    discoveryState.impl = async options => {
      calls.push(options);
      return [];
    };
    const collector = makeCollector();

    try {
      collector.pause();
      collector.start(30);

      // 间隔被记录,但暂停态下 start 既不建定时器也不发首轮刷新
      expect(collector.getRefreshInterval()).toBe(30);
      expect(collector.isPaused()).toBe(true);
      await new Promise(resolve => setTimeout(resolve, 120));
      expect(calls).toHaveLength(0);
      expect(internals(collector).updateInterval).toBeNull();

      // 恢复后间隔生效:首轮刷新立即发生,定时器随后建起
      collector.resume();
      await until(() => calls.length > 0);
      expect(internals(collector).updateInterval).not.toBeNull();

      collector.stop();
      expect(internals(collector).updateInterval).toBeNull();
    } finally {
      collector.dispose();
    }
  });

  it('catch 归一非 Error 抛出值,Error 值保留原对象', async () => {
    const collector = makeCollector();
    try {
      // 语言合法的 non-Error 抛出(discovery 的真实实现不会抛,故经接缝注入)
      discoveryState.impl = async () => {
        throw 'watcher gone';
      };
      await collector.refreshNow();
      expect(collector.getStatusSummary()).toBe('watcher gone');
      expect(collector.getUnavailableReason()).toBe('watcher gone');
      expect(collector.getDiagnostics()).toEqual([
        {
          timestamp: expect.any(Date),
          severity: 'error',
          source: 'collector',
          message: 'watcher gone'
        }
      ]);
      expect(collector.getAllMetrics()).toEqual([]);

      // 对照:Error 值原样采用,message 即其自身 message
      discoveryState.impl = async () => {
        throw new Error('discovery failed');
      };
      await collector.refreshNow();
      expect(collector.getUnavailableReason()).toBe('discovery failed');
      expect(collector.getDiagnostics()[0].source).toBe('collector');
    } finally {
      collector.dispose();
    }
  });
});

describe('MonitoringCollector 无 watcher 消息 id 的组件类型', () => {
  it('bots(type 11)查询空结果:values 回落空表且走 switch default', async () => {
    const watcher = await startWatcher({
      routes: { '': { load: 3 }, stats: { runningTime: 9 } }
    });
    const machine = await startMachine([
      makeSimComponentInfo({
        componentType: 11,
        componentName: 'bots',
        fullName: 'bots0',
        componentID: 1200n,
        pid: 4330,
        intport: watcher.port
      })
    ]);

    const collector = makeCollector(machine);
    try {
      await collector.refreshNow();

      const metrics = collector.getAllMetrics();
      expect(metrics).toHaveLength(1);
      // bots 有 watcher 端口但协议表里没有查询消息 id:两路查询都零结果,
      // root/stats 值表回落 {}(占位行断言见下一 suite)
      expect(metrics[0].componentType).toBe('bots');
      expect(metrics[0].load).toBe(0);
      expect(metrics[0].uptime).toBe(0);
      expect(metrics[0].messagesPerSecond).toBe(0);
      expect(metrics[0].entityCount).toBe(0);
      expect(metrics[0].connections).toBe(0);
      // type 11 不匹配任何 case,连类型特有行都不产生,只剩 UID 行
      expect(metrics[0].details).toEqual([{ label: 'UID', value: '1001' }]);
      expect(metrics[0].status).toBe('仅 machine 可见，watcher 无返回');
      expect(metrics[0].statusLevel).toBe('warning');
      expect(watcher.getRequests()).toHaveLength(0);

      // 对照:同端口换回有消息 id 的 baseapp(6),值表按帧解码
      machine.setComponents([
        makeSimComponentInfo({
          componentType: 6,
          componentName: 'baseapp',
          fullName: 'baseapp0',
          componentID: 1201n,
          pid: 4331,
          intport: watcher.port
        })
      ]);
      await collector.refreshNow();
      const baseapp = collector.getAllMetrics()[0];
      expect(baseapp.load).toBe(3);
      expect(baseapp.uptime).toBe(9);
      expect(baseapp.status).toBe('watcher 已响应');
      expect(baseapp.statusLevel).toBe('info');
    } finally {
      collector.dispose();
      await stopAll();
    }
  }, 10000);
});

describe('MonitoringCollector logger 的消息速率回落', () => {
  it('logger 的 stats 缺 secsNumlogs 时回落 0,存在时按值取', async () => {
    const silent = await startWatcher({
      routes: {
        '': { globalOrder: 2, groupOrder: 3 },
        stats: { runningTime: 7, totalNumlogs: 5, bufferedLogsSize: 9 }
      }
    });
    const verbose = await startWatcher({
      routes: {
        '': { globalOrder: 2, groupOrder: 3 },
        stats: { runningTime: 7, secsNumlogs: 4 }
      }
    });
    const machine = await startMachine([
      makeSimComponentInfo({
        componentType: 10,
        componentName: 'logger',
        fullName: 'logger0',
        componentID: 1210n,
        pid: 4340,
        intport: silent.port
      })
    ]);

    const collector = makeCollector(machine);
    try {
      await collector.refreshNow();
      const withoutRate = collector.getAllMetrics()[0];
      // secsNumlogs 缺席:?? 右侧回落 0,logger 特有行仍按 stats 值出
      expect(withoutRate.messagesPerSecond).toBe(0);
      expect(withoutRate.uptime).toBe(7);
      expect(withoutRate.details).toEqual([
        { label: 'UID', value: '1001' },
        { label: 'GlobalOrder', value: '2' },
        { label: 'GroupOrder', value: '3' },
        { label: '总日志数', value: '5' },
        { label: '缓存日志', value: '9' }
      ]);

      machine.setComponents([
        makeSimComponentInfo({
          componentType: 10,
          componentName: 'logger',
          fullName: 'logger0',
          componentID: 1210n,
          pid: 4340,
          intport: verbose.port
        })
      ]);
      await collector.refreshNow();
      // 对照:secsNumlogs 存在时按该键取(而非 messagesPerSecond)
      expect(collector.getAllMetrics()[0].messagesPerSecond).toBe(4);
      expect(silent.getRequests().every(request => request.messageId === 41008)).toBe(true);
    } finally {
      collector.dispose();
      await stopAll();
    }
  }, 10000);
});

describe('MonitoringCollector details 全空时的 Watcher 占位行', () => {
  // 契约边界如实记录:machine 发现链的 uid 恒为 number(0 也以 '0' 入列,
  // 见 monitoringCollectorGaps.test.ts 的锁定用例),该占位行在真实链路上
  // 不可达——批41 结论维持。这里经局部替换的 discovery 接缝喂一个不带 uid
  // 的组件(machine 报文缺字段的形态),锁定的仍是占位行的真实输出文案与
  // || 短路顺序,不代表发现链可产生该输入。
  const componentWithoutUid = (
    overrides: Partial<KBEngineComponentInfo>
  ): KBEngineComponentInfo => ({
    ...makeSimComponentInfo(overrides),
    uid: undefined
  } as unknown as KBEngineComponentInfo);

  it('根值与 stats 值全空时回落无返回占位行', async () => {
    discoveryState.impl = async () => [
      componentWithoutUid({
        componentType: 11,
        componentName: 'bots',
        fullName: 'bots0',
        componentID: 1300n,
        pid: 4350
      })
    ];
    const collector = makeCollector();
    try {
      await collector.refreshNow();
      const metric = collector.getAllMetrics()[0];
      expect(metric.details).toEqual([{ label: 'Watcher', value: '无返回' }]);
      expect(metric.statusLevel).toBe('warning');
    } finally {
      collector.dispose();
    }
  });

  it('根值空而 stats 有值时短路取 stats 键数并出已响应占位行', async () => {
    const watcher = await startWatcher({
      routes: { '': {}, stats: { runningTime: 5 } }
    });
    discoveryState.impl = async () => [
      componentWithoutUid({
        componentType: 6,
        componentName: 'baseapp',
        fullName: 'baseapp0',
        componentID: 1310n,
        pid: 4351,
        intport: watcher.port
      })
    ];
    const collector = makeCollector();
    try {
      await collector.refreshNow();
      const metric = collector.getAllMetrics()[0];
      // 根值帧为纯 type 0 空表:第一个操作数 false → 求值 stats 键数 → 已响应
      expect(metric.details).toEqual([{ label: 'Watcher', value: '已响应' }]);
      expect(metric.uptime).toBe(5);
      expect(metric.statusLevel).toBe('info');
      expect(watcher.getRequests().map(request => request.path)).toEqual(['', 'stats']);

      // 对照:端口不可达时两路值表都空,占位行退到另一臂
      const port = await deadPort();
      discoveryState.impl = async () => [
        componentWithoutUid({
          componentType: 6,
          componentName: 'baseapp',
          fullName: 'baseapp1',
          componentID: 1311n,
          pid: 4352,
          intport: port
        })
      ];
      const dead = makeCollector();
      try {
        await dead.refreshNow();
        expect(dead.getAllMetrics()[0].details).toEqual([{ label: 'Watcher', value: '无返回' }]);
      } finally {
        dead.dispose();
      }
    } finally {
      collector.dispose();
      await stopAll();
    }
  }, 10000);
});
