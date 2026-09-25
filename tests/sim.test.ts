import { afterEach, describe, expect, it } from 'vitest';
import {
  buildComponentInfo,
  buildWatcherDirFrameBody,
  buildWatcherValueFrameBody,
  discoverLocalComponents,
  encodeWatcherValue,
  parseComponentInfo,
  parseWatcherFrame,
  queryWatcherPath
} from '../src/kbengineProtocol';
import type { KBEngineComponentInfo } from '../src/kbengineProtocol';
import { MachineSimulator, makeSimComponentInfo } from './sim/machineSimulator';
import { WatcherSimulator } from './sim/watcherSimulator';
import { startSimCluster } from './sim/simCluster';

// 仿真器基座自测:协议编解码往返(生产侧 parse 的对偶 buildComponentInfo/
// buildWatcher*FrameBody)与 Machine/Watcher/Cluster 三件套的行为规格。
// 全部端口动态分配,不触碰 20086 等固定端口(docs/redesign.md 阶段 1)。

const activeStoppers: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (activeStoppers.length > 0) {
    await activeStoppers.pop()?.();
  }
});

describe('wire codec round trips', () => {
  it('buildComponentInfo inverts parseComponentInfo across the full field matrix', () => {
    const info: KBEngineComponentInfo = {
      uid: 1001,
      username: 'ci',
      componentType: 6,
      componentID: 18446744073709551000n,
      componentIDEx: 901n,
      globalOrderID: 3,
      groupOrderID: 2,
      genuuidSections: 0,
      intaddr: '192.168.1.7',
      intport: 20013,
      extaddr: '10.0.0.9',
      extport: 40021,
      extaddrEx: 'kbengine.example',
      pid: 4321,
      cpu: 0.25,
      mem: 12.5,
      usedmem: 2048,
      state: 1,
      machineID: 7,
      extradata: 7n,
      extradata1: 3n,
      extradata2: 0n,
      extradata3: 0n,
      backaddr: 2130706433,
      backport: 20086,
      componentName: 'baseapp',
      fullName: 'baseapp2'
    };

    const decoded = parseComponentInfo(buildComponentInfo(info));
    // 派生字段(componentName/fullName)按线序重推,语义与引擎一致
    expect(decoded).toMatchObject({
      uid: 1001,
      username: 'ci',
      componentType: 6,
      componentID: 18446744073709551000n,
      componentIDEx: 901n,
      globalOrderID: 3,
      groupOrderID: 2,
      intaddr: '192.168.1.7',
      intport: 20013,
      extaddr: '10.0.0.9',
      extport: 40021,
      extaddrEx: 'kbengine.example',
      pid: 4321,
      cpu: 0.25,
      mem: 12.5,
      usedmem: 2048,
      state: 1,
      machineID: 7,
      extradata: 7n,
      extradata1: 3n,
      backaddr: 2130706433,
      backport: 20086,
      componentName: 'baseapp',
      fullName: 'baseapp2'
    });
  });

  it('buildWatcherValueFrameBody inverts parseWatcherFrame for every value kind', () => {
    const body = buildWatcherValueFrameBody('/cellapp/clients', {
      uptime: 3600,
      label: 'running',
      heavy: 9007199254740993n,
      alive: true
    });
    const result = parseWatcherFrame(body);
    expect(result.type).toBe(0);
    expect(result.path).toBe('/cellapp/clients');
    // UINT64 超过 MAX_SAFE_INTEGER 时客户端钳制(实现语义)
    expect(result.values).toEqual({
      uptime: 3600,
      label: 'running',
      heavy: Number.MAX_SAFE_INTEGER,
      alive: true
    });
  });

  it('buildWatcherDirFrameBody normalizes rootPath and preserves key order', () => {
    const result = parseWatcherFrame(buildWatcherDirFrameBody('/', ['children1', 'children2']));
    expect(result.type).toBe(1);
    expect(result.path).toBe('');
    expect(result.keys).toEqual(['children1', 'children2']);
  });

  it('encodeWatcherValue maps string/bigint/bool/number onto tagged payloads', () => {
    expect(encodeWatcherValue('x')[0]).toBe(12);
    expect(encodeWatcherValue(1n)[0]).toBe(4);
    expect(encodeWatcherValue(true)[0]).toBe(13);
    expect(encodeWatcherValue(42)[0]).toBe(3);
  });
});

describe('MachineSimulator', () => {
  it('binds a dynamic port away from the engine broadcast port', async () => {
    const machine = await MachineSimulator.start();
    activeStoppers.push(() => machine.stop());
    expect(machine.port).toBeGreaterThan(0);
    expect(machine.port).not.toBe(20086);
  });

  it('records discovery requests with identity and reply-port backfill', async () => {
    const machine = await MachineSimulator.start();
    activeStoppers.push(() => machine.stop());

    await discoverLocalComponents({ port: machine.port, timeoutMs: 80 });

    const requests = machine.getRequests();
    expect(requests).toHaveLength(1);
    expect(requests[0].messageId).toBe(4);
    expect(requests[0].uid).toBe(process.getuid?.() ?? -1);
    expect(requests[0].username.length).toBeGreaterThan(0);
    // 帧内回填端口与 UDP 源端口一致(客户端回复地址语义)
    expect(requests[0].replyPort).toBe(requests[0].sourcePort);
  });

  it('replies with registered components and collapses duplicate identities', async () => {
    const machine = await MachineSimulator.start({
      components: [
        makeSimComponentInfo({ componentType: 6, componentID: 900n, pid: 4321 }),
        makeSimComponentInfo({ componentType: 5, componentID: 901n, pid: 4322 }),
        // 与第一条同 componentType:componentID:pid → 去重
        makeSimComponentInfo({ componentType: 6, componentID: 900n, pid: 4321, cpu: 0.9 })
      ]
    });
    activeStoppers.push(() => machine.stop());

    const components = await discoverLocalComponents({ port: machine.port, timeoutMs: 300 });
    expect(components).toHaveLength(2);
    expect(components.find(component => component.componentType === 6)?.cpu).toBe(0.5);
  });

  it('setComponents hot-swaps the broadcast topology', async () => {
    const machine = await MachineSimulator.start({
      components: [makeSimComponentInfo({ componentType: 1 })]
    });
    activeStoppers.push(() => machine.stop());

    const before = await discoverLocalComponents({ port: machine.port, timeoutMs: 200 });
    expect(before.map(component => component.componentType)).toEqual([1]);

    machine.setComponents([makeSimComponentInfo({ componentType: 10 })]);
    const after = await discoverLocalComponents({ port: machine.port, timeoutMs: 200 });
    expect(after.map(component => component.componentType)).toEqual([10]);
  });

  it('garbage mode drives the client into the reject path', async () => {
    const machine = await MachineSimulator.start({ mode: 'garbage' });
    activeStoppers.push(() => machine.stop());
    await expect(
      discoverLocalComponents({ port: machine.port, timeoutMs: 300 })
    ).rejects.toThrow();
  });
});

describe('WatcherSimulator', () => {
  it('responds along the route table and records msgid + path', async () => {
    const watcher = await WatcherSimulator.start({
      routes: { '': { load: 5 } }
    });
    activeStoppers.push(() => watcher.stop());

    const results = await queryWatcherPath(
      makeSimComponentInfo({ componentType: 1, intport: watcher.port }),
      '',
      300
    );
    expect(results[0].values.load).toBe(5);
    expect(watcher.getRequests()).toEqual([{ messageId: 41006, path: '' }]);
  });

  it('split behavior still reassembles on the client (streaming reassembly)', async () => {
    const watcher = await WatcherSimulator.start({
      routes: { '/cellapp/clients': { uptime: 42 } },
      behavior: 'split'
    });
    activeStoppers.push(() => watcher.stop());

    const results = await queryWatcherPath(
      makeSimComponentInfo({ componentType: 1, intport: watcher.port }),
      '/cellapp/clients',
      2000
    );
    expect(results[0].values.uptime).toBe(42);
  });

  it('silent behavior resolves empty after the client timeout', async () => {
    const watcher = await WatcherSimulator.start({ behavior: 'silent' });
    activeStoppers.push(() => watcher.stop());

    const results = await queryWatcherPath(
      makeSimComponentInfo({ componentType: 1, intport: watcher.port }),
      '',
      120
    );
    expect(results).toEqual([]);
    expect(watcher.getRequests()).toHaveLength(1);
  });

  it('garbage behavior sends non-watcher frames the client skips', async () => {
    const watcher = await WatcherSimulator.start({ behavior: 'garbage' });
    activeStoppers.push(() => watcher.stop());

    const results = await queryWatcherPath(
      makeSimComponentInfo({ componentType: 1, intport: watcher.port }),
      '',
      150
    );
    // 非 65502 msgid 帧被跳过,超时后按已有结果收尾
    expect(results).toEqual([]);
  });

  it('refuse behavior rejects the client with a real RST', async () => {
    const watcher = await WatcherSimulator.start({ behavior: 'refuse' });
    activeStoppers.push(() => watcher.stop());

    await expect(
      queryWatcherPath(
        makeSimComponentInfo({ componentType: 1, intport: watcher.port }),
        '',
        2000
      )
    ).rejects.toThrow();
  });
});

describe('startSimCluster', () => {
  it('wires machine discovery options to per-component watcher ports', async () => {
    const cluster = await startSimCluster([
      { componentType: 6, routes: { '': { load: 3 } } },
      { componentType: 5, withoutWatcher: true }
    ]);
    activeStoppers.push(() => cluster.stop());

    expect(cluster.discoveryOptions.port).toBe(cluster.machine.port);

    const components = await discoverLocalComponents({
      port: cluster.discoveryOptions.port,
      timeoutMs: 300
    });
    expect(components).toHaveLength(2);
    const baseapp = components.find(component => component.componentType === 6);
    const cellapp = components.find(component => component.componentType === 5);
    expect(baseapp?.intport).toBe(cluster.watchers[0].port);
    expect(baseapp?.fullName).toBe('baseapp0');
    // 无 watcher 组件端口为 0(machine 基础状态语义)
    expect(cellapp?.intport).toBe(0);

    const results = await queryWatcherPath(
      components.find(component => component.componentType === 6)!,
      '',
      300
    );
    expect(results[0].values.load).toBe(3);
  });
});
