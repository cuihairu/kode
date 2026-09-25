import * as net from 'net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MACHINE_MSG_QUERY_ALL_INTERFACES,
  buildCString,
  discoverLocalComponents,
  queryWatcherPath,
  swapUint16
} from '../src/kbengineProtocol';
import { MachineSimulator, makeSimComponentInfo } from './sim/machineSimulator';
import { WatcherSimulator } from './sim/watcherSimulator';

// kbengineProtocol 的真实 socket 客户端:discoverLocalComponents(UDP 广播
// 发现)与 queryWatcherPath(TCP watcher 查询)。machine/watcher 对端由
// tests/sim 仿真器提供(动态端口,复用生产编解码器);请求帧仍以原始字节
// 独立断言,不信仿真器的解码。零 mock、零固定端口。

const stoppers: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (stoppers.length > 0) {
    await stoppers.pop()?.();
  }
});

const startMachine = async (options?: Parameters<typeof MachineSimulator.start>[0]): Promise<MachineSimulator> => {
  const machine = await MachineSimulator.start(options);
  stoppers.push(() => machine.stop());
  return machine;
};

const startWatcher = async (options?: Parameters<typeof WatcherSimulator.start>[0]): Promise<WatcherSimulator> => {
  const watcher = await WatcherSimulator.start(options);
  stoppers.push(() => watcher.stop());
  return watcher;
};

// 已关闭端口的连接被拒(ECONNREFUSED),区别于 RST 拒绝路径
const deadPort = async (): Promise<number> => {
  const dead = net.createServer();
  await new Promise<void>(resolve => dead.listen(0, '127.0.0.1', () => resolve()));
  const port = (dead.address() as net.AddressInfo).port;
  await new Promise<void>(resolve => dead.close(() => resolve()));
  return port;
};

describe('discoverLocalComponents over real UDP', () => {
  it('sends the machine query and parses the broadcast replies', async () => {
    const machine = await startMachine({
      components: [
        makeSimComponentInfo({ componentType: 6, componentID: 900n, pid: 4321, intport: 20001 }),
        makeSimComponentInfo({ componentType: 5, componentID: 901n, pid: 4322, intport: 20002 })
      ]
    });

    const components = await discoverLocalComponents({ port: machine.port, timeoutMs: 1200 });

    // 请求帧逐字节独立断言(不信任仿真器解码)
    const requests = machine.getRequests();
    expect(requests).toHaveLength(1);
    const raw = requests[0].raw;
    expect(raw.readUInt16LE(0)).toBe(MACHINE_MSG_QUERY_ALL_INTERFACES);
    const body = raw.subarray(4);
    const uid = body.readInt32LE(0);
    let offset = 4;
    while (body[offset] !== 0) {
      offset += 1;
    }
    const username = body.toString('utf8', 4, offset);
    const replyPort = swapUint16(body.readUInt16LE(offset + 1));
    expect(uid).toBe(process.getuid?.() ?? 1001);
    expect(username.length).toBeGreaterThan(0);
    // 客户端以自身 bind 的临时端口发包,帧内回填端口须与源端口一致
    expect(replyPort).toBe(requests[0].sourcePort);

    expect(components).toHaveLength(2);
    const baseapp = components.find(component => component.componentType === 6);
    expect(baseapp).toMatchObject({
      componentName: 'baseapp',
      // type 5/6 的 fullName 引擎语义为 componentName+groupOrderID(多实例编号)
      fullName: 'baseapp0',
      uid: 1001,
      username: 'ci',
      pid: 4321,
      intaddr: '127.0.0.1',
      intport: 20001
    });
    expect(baseapp?.componentID).toBe(900n);
    expect(baseapp?.cpu).toBeCloseTo(0.5, 5);
    const cellapp = components.find(component => component.componentType === 5);
    expect(cellapp?.componentName).toBe('cellapp');
    expect(cellapp?.fullName).toBe('cellapp0');
    expect(cellapp?.intport).toBe(20002);
  }, 8000);

  it('rejects when a discovery packet is malformed', async () => {
    const machine = await startMachine({ mode: 'garbage' });
    await expect(
      discoverLocalComponents({ port: machine.port, timeoutMs: 1200 })
    ).rejects.toThrow();
  }, 8000);
});

describe('queryWatcherPath over real TCP', () => {
  it('returns empty results for unknown component types', async () => {
    const component = makeSimComponentInfo({ componentType: 99 });
    expect(await queryWatcherPath(component, '/cellapp', 50)).toEqual([]);
  }, 8000);

  it('reassembles split frames and parses watcher values', async () => {
    // split 模式:先发 3 字节再延时补齐两帧——验证客户端的分包重组
    const watcher = await startWatcher({
      routes: { '/cellapp/clients': { uptime: 42 } },
      behavior: 'split',
      dirKeys: ['children1', 'children2']
    });

    const results = await queryWatcherPath(
      makeSimComponentInfo({ componentType: 1, intport: watcher.port }),
      '/cellapp/clients',
      2000
    );

    const requests = watcher.getRequests();
    expect(requests).toHaveLength(1);
    expect(requests[0].messageId).toBe(41006);
    expect(requests[0].path).toBe('/cellapp/clients');

    expect(results).toHaveLength(2);
    expect(results[0].type).toBe(0);
    expect(results[0].path).toBe('/cellapp/clients');
    expect(results[0].values.uptime).toBe(42);
    expect(results[1].type).toBe(1);
    expect(results[1].path).toBe('');
    expect(results[1].keys).toEqual(['children1', 'children2']);
  }, 8000);

  it('rejects when the watcher endpoint refuses the connection', async () => {
    const port = await deadPort();

    await expect(
      queryWatcherPath(makeSimComponentInfo({ componentType: 1, intport: port }), '/x', 2000)
    ).rejects.toThrow();
  }, 8000);
});
