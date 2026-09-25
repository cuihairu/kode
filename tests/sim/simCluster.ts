import type { MachineDiscoveryOptions } from '../../src/kbengineProtocol';
import { MachineSimulator, makeSimComponentInfo } from './machineSimulator';
import { WatcherSimulator } from './watcherSimulator';
import type { WatcherValueMap } from './watcherSimulator';

/**
 * 仿真集群门面:一键拉起"machine 应答端 + 每组件一个 watcher TCP 服务"
 * 的本地 KBEngine 拓扑。所有端口动态分配,集群句柄回报实际端口,
 * 供被测代码经 MachineDiscoveryOptions 注入(docs/redesign.md 阶段 1)。
 */

export interface SimComponentSpec {
  componentType: number;
  componentID?: bigint;
  pid?: number;
  groupOrderID?: number;
  extradata?: bigint;
  extradata1?: bigint;
  uid?: number;
  /** watcher 查询路由;缺省空表(watcher 连得上但无指标) */
  routes?: Record<string, WatcherValueMap>;
  /** 覆盖该组件 watcher 的行为(缺省 respond) */
  watcherBehavior?: 'respond' | 'split' | 'refuse' | 'silent' | 'garbage';
  /** 不起 watcher 服务(组件广播里有端口但无人监听) */
  withoutWatcher?: boolean;
}

export interface SimCluster {
  machine: MachineSimulator;
  watchers: WatcherSimulator[];
  /** 直通 MonitoringCollector 构造器的发现选项 */
  discoveryOptions: MachineDiscoveryOptions;
  stop(): Promise<void>;
}

// 与生产侧 COMPONENT_NAMES 对齐的本地便捷表(spec 用可读组件名回填)
const COMPONENT_TYPE_NAMES: Record<number, string> = {
  1: 'dbmgr',
  2: 'loginapp',
  3: 'baseappmgr',
  4: 'cellappmgr',
  5: 'cellapp',
  6: 'baseapp',
  10: 'logger',
  11: 'bots',
  13: 'interfaces'
};

export async function startSimCluster(specs: SimComponentSpec[]): Promise<SimCluster> {
  const machine = await MachineSimulator.start();
  const watchers: WatcherSimulator[] = [];
  // 每个规格对应的 watcher(无 watcher 规格为 null,避免索引错位)
  const watcherBySpec: Array<WatcherSimulator | null> = [];

  for (const spec of specs) {
    if (spec.withoutWatcher) {
      watcherBySpec.push(null);
      continue;
    }
    const watcher = await WatcherSimulator.start({
      routes: spec.routes,
      behavior: spec.watcherBehavior
    });
    watcherBySpec.push(watcher);
    watchers.push(watcher);
  }

  machine.setComponents(
    specs.map((spec, index) => {
      const watcher = watcherBySpec[index];
      const componentName =
        COMPONENT_TYPE_NAMES[spec.componentType] ?? `component_${spec.componentType}`;
      return makeSimComponentInfo({
        componentType: spec.componentType,
        componentName,
        componentID: spec.componentID ?? BigInt(900 + index),
        pid: spec.pid ?? 4321 + index,
        groupOrderID: spec.groupOrderID,
        extradata: spec.extradata,
        extradata1: spec.extradata1,
        uid: spec.uid,
        intport: watcher ? watcher.port : 0,
        extport: watcher ? watcher.port : 0,
        // 引擎语义:type 5/6(cellapp/baseapp)fullName 带 groupOrderID 后缀
        fullName:
          spec.componentType === 5 || spec.componentType === 6
            ? `${componentName}${spec.groupOrderID ?? 0}`
            : componentName
      });
    })
  );

  return {
    machine,
    watchers,
    discoveryOptions: { host: '127.0.0.1', port: machine.port },
    async stop(): Promise<void> {
      await Promise.all([machine.stop(), ...watchers.map(watcher => watcher.stop())]);
    }
  };
}
