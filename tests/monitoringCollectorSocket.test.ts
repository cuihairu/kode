import * as dgram from 'dgram';
import * as net from 'net';
import { afterEach, describe, expect, it } from 'vitest';
import type { ComponentMetrics } from '../src/monitoringCollector';
import { MonitoringCollector } from '../src/monitoringCollector';
import type * as vscode from 'vscode';

// MonitoringCollector 的 refresh 链路:真实回环上起 UDP machine 应答端与
// TCP watcher 服务端,零 mock 走完 discover → watcher 查询 → 指标聚合 →
// 诊断/历史/状态汇总全链路(UDP/TCP 帧格式与 kbengineProtocolSocket 一致)。

type ValueMap = Record<string, string | number | boolean | bigint>;

const CONSOLE_WATCHER_CB_MSG_ID = 65502;
const VALUE_TYPE_UINT32 = 3;
const VALUE_TYPE_UINT64 = 4;
const VALUE_TYPE_STRING = 12;
const VALUE_TYPE_BOOL = 13;

const cstring = (value: string): Buffer => Buffer.concat([Buffer.from(value, 'utf8'), Buffer.from([0])]);

const u16 = (value: number): Buffer => {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value, 0);
  return buffer;
};

const u32 = (value: number): Buffer => {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value, 0);
  return buffer;
};

const u64 = (value: bigint): Buffer => {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(value, 0);
  return buffer;
};

const frame = (messageId: number, body: Buffer): Buffer =>
  Buffer.concat([u16(messageId), u16(body.length), body]);

const encodeValue = (value: string | number | boolean | bigint): Buffer => {
  if (typeof value === 'boolean') {
    return Buffer.concat([Buffer.from([VALUE_TYPE_BOOL]), Buffer.from([value ? 1 : 0])]);
  }
  if (typeof value === 'bigint') {
    return Buffer.concat([Buffer.from([VALUE_TYPE_UINT64]), u64(value)]);
  }
  if (typeof value === 'string') {
    return Buffer.concat([Buffer.from([VALUE_TYPE_STRING]), cstring(value)]);
  }
  return Buffer.concat([Buffer.from([VALUE_TYPE_UINT32]), u32(value)]);
};

// type 0 值帧:首字节 type 标记,后接若干 path/name/uid/type/value 元组;
// 补一帧 type 1 目录帧触发客户端 results>=2 提前结束
const watcherReply = (path: string, values: ValueMap): Buffer => {
  let offset = 0;
  const tuples: Buffer[] = [Buffer.from([0])];
  for (const [name, value] of Object.entries(values)) {
    tuples.push(
      Buffer.concat([
        cstring(path),
        cstring(name),
        u16(offset + 1),
        encodeValue(value)
      ])
    );
    offset += 1;
  }
  const valueFrame = frame(CONSOLE_WATCHER_CB_MSG_ID, Buffer.concat(tuples));
  const dirFrame = frame(CONSOLE_WATCHER_CB_MSG_ID, Buffer.concat([Buffer.from([1]), cstring('/')]));
  return Buffer.concat([valueFrame, dirFrame]);
};

interface WatcherServer {
  port: number;
  requests: Array<{ messageId: number; path: string }>;
  close(): void;
}

// 每个组件一个 watcher 服务端(按路径应答,记录请求 msgid+path)
const startWatcherServer = (routeMap: Record<string, ValueMap>): Promise<WatcherServer> =>
  new Promise(resolve => {
    const requests: Array<{ messageId: number; path: string }> = [];
    const server = net.createServer(socket => {
      socket.on('data', data => {
        const messageId = data.readUInt16LE(0);
        const bodyLength = data.readUInt16LE(2);
        const path = data.subarray(4, 4 + bodyLength - 1).toString('utf8');
        requests.push({ messageId, path });
        socket.write(watcherReply(path, routeMap[path] ?? {}));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: (server.address() as net.AddressInfo).port,
        requests,
        close: () => server.close()
      });
    });
  });

// parseComponentInfo 的逆过程(线序全 LE),组件可绑定独立 watcher 端口
const componentPacket = (options: {
  componentType: number;
  componentID: bigint;
  pid: number;
  watcherPort: number;
  groupOrderID?: number;
  extradata?: bigint;
  extradata1?: bigint;
}): Buffer => {
  const i32 = (value: number): Buffer => {
    const buffer = Buffer.alloc(4);
    buffer.writeInt32LE(value, 0);
    return buffer;
  };
  return Buffer.concat([
    i32(1001),
    cstring('ci'),
    i32(options.componentType),
    u64(options.componentID),
    u64(options.componentID + 1n),
    i32(1),
    i32(options.groupOrderID ?? 0),
    i32(0),
    Buffer.from([127, 0, 0, 1]),
    u16(((options.watcherPort & 0xff) << 8) | ((options.watcherPort >> 8) & 0xff)),
    Buffer.from([127, 0, 0, 1]),
    u16(((options.watcherPort & 0xff) << 8) | ((options.watcherPort >> 8) & 0xff)),
    cstring(''),
    u32(options.pid),
    (() => {
      const buffer = Buffer.alloc(4);
      buffer.writeFloatLE(0.5, 0);
      return buffer;
    })(),
    (() => {
      const buffer = Buffer.alloc(4);
      buffer.writeFloatLE(25, 0);
      return buffer;
    })(),
    u32(1024),
    Buffer.from([1]),
    u32(7),
    u64(options.extradata ?? 0n),
    u64(options.extradata1 ?? 0n),
    u64(0n),
    u64(0n),
    u32(0),
    u16(0)
  ]);
};

// UDP machine 应答端:收到 discovery 请求即回指定组件包(或垃圾包)
const startMachineResponder = (mode: 'components' | 'garbage', packets: Buffer[]): Promise<void> =>
  new Promise((resolve, reject) => {
    const responder = dgram.createSocket('udp4');
    responder.on('error', reject);
    responder.bind(20086, '127.0.0.1', () => {
      responder.on('message', (_packet, rinfo) => {
        if (mode === 'garbage') {
          responder.send(Buffer.from([0x01, 0x02]), rinfo.port, '127.0.0.1');
          return;
        }
        for (const packet of packets) {
          responder.send(packet, rinfo.port, '127.0.0.1');
        }
      });
      resolve();
    });
    cleanups.push(() => responder.close());
  });

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
});

const makeCollector = (): MonitoringCollector =>
  new MonitoringCollector({} as unknown as vscode.ExtensionContext);

const internals = (collector: MonitoringCollector): {
  metrics: ComponentMetrics[];
} => collector as unknown as { metrics: ComponentMetrics[] };

describe('MonitoringCollector refresh over real sockets', () => {
  it('collects full watcher metrics for a baseapp', async () => {
    const watcher = await startWatcherServer({
      '': { load: 5, globalOrder: 2, groupOrder: 1, numProxices: 4, numClients: 11 },
      stats: { runningTime: 3600, messagesPerSecond: 42 }
    });
    cleanups.push(watcher.close);
    await startMachineResponder('components', [
      componentPacket({
        componentType: 6,
        componentID: 900n,
        pid: 4321,
        watcherPort: watcher.port,
        extradata: 7n,
        extradata1: 3n
      })
    ]);

    const collector = makeCollector();
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
      internalAddress: `127.0.0.1:${watcher.port}`,
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

    expect(watcher.requests).toHaveLength(2);
    expect(watcher.requests.every(request => request.messageId === 41001)).toBe(true);
    expect(watcher.requests.map(request => request.path).sort()).toEqual(['', 'stats']);
  }, 8000);

  it('sums cellapp object pools and slices details to ten', async () => {
    const watcher = await startWatcherServer({
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
    });
    cleanups.push(watcher.close);
    await startMachineResponder('components', [
      componentPacket({
        componentType: 5,
        componentID: 901n,
        pid: 4322,
        watcherPort: watcher.port,
        extradata: 9n
      })
    ]);

    const collector = makeCollector();
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

    expect(watcher.requests).toHaveLength(4);
    expect(watcher.requests.every(request => request.messageId === 41002)).toBe(true);
    expect(watcher.requests.map(request => request.path).sort()).toEqual([
      '',
      'objectPools/EntityRef',
      'objectPools/Witness',
      'stats'
    ]);
  }, 8000);

  it('sorts multiple components and derives logger rate from secsNumlogs', async () => {
    const baseappWatcher = await startWatcherServer({
      '': { load: 2 },
      stats: { runningTime: 10, messagesPerSecond: 5 }
    });
    const loggerWatcher = await startWatcherServer({
      '': {},
      stats: { secsNumlogs: 33, totalNumlogs: 99, bufferedLogsSize: 5 }
    });
    cleanups.push(baseappWatcher.close, loggerWatcher.close);
    await startMachineResponder('components', [
      componentPacket({
        componentType: 6,
        componentID: 900n,
        pid: 4321,
        watcherPort: baseappWatcher.port
      }),
      componentPacket({
        componentType: 10,
        componentID: 902n,
        pid: 4323,
        watcherPort: loggerWatcher.port
      })
    ]);

    const collector = makeCollector();
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
    expect(baseappWatcher.requests.every(request => request.messageId === 41001)).toBe(true);
    expect(loggerWatcher.requests.every(request => request.messageId === 41008)).toBe(true);
  }, 8000);

  it('marks a machine-visible component as partial when watcher is unreachable', async () => {
    const dead = net.createServer();
    await new Promise<void>(resolve => dead.listen(0, '127.0.0.1', () => resolve()));
    const deadPort = (dead.address() as net.AddressInfo).port;
    await new Promise<void>(resolve => dead.close(() => resolve()));

    await startMachineResponder('components', [
      componentPacket({
        componentType: 6,
        componentID: 900n,
        pid: 4321,
        watcherPort: deadPort,
        extradata: 7n
      })
    ]);

    const collector = makeCollector();
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
    // 预置一条旧指标,验证刷新后清空;不绑 UDP 应答端 → discovery 超时为空
    const collector = makeCollector();
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
    await startMachineResponder('garbage', []);

    const collector = makeCollector();
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
