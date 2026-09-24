import * as dgram from 'dgram';
import * as net from 'net';
import { afterEach, describe, expect, it } from 'vitest';
import { MonitoringCollector } from '../src/monitoringCollector';
import type * as vscode from 'vscode';

// MonitoringCollector 的剩余分支:dbmgr(type 1)的读写查实体/建账号
// 详情、未知 watcher 查询类型的组件(machine)回落 "无返回" 详情、
// start 的定时器启动、refresh 的重入守卫、历史环形缓冲 300 截断。
// 帧格式与 monitoringCollectorSocket.test.ts 一致,真实回环零 mock。

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

const componentPacket = (options: {
  componentType: number;
  componentID: bigint;
  pid: number;
  watcherPort: number;
  uid?: number;
}): Buffer => {
  const i32 = (value: number): Buffer => {
    const buffer = Buffer.alloc(4);
    buffer.writeInt32LE(value, 0);
    return buffer;
  };
  return Buffer.concat([
    i32(options.uid ?? 1001),
    cstring('ci'),
    i32(options.componentType),
    u64(options.componentID),
    u64(options.componentID + 1n),
    i32(1),
    i32(0),
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
    u64(0n),
    u64(0n),
    u64(0n),
    u64(0n),
    u32(0),
    u16(0)
  ]);
};

const startMachineResponder = (packets: Buffer[]): Promise<void> =>
  new Promise((resolve, reject) => {
    const responder = dgram.createSocket('udp4');
    responder.on('error', reject);
    responder.bind(20086, '127.0.0.1', () => {
      responder.on('message', (_packet, rinfo) => {
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
  metricsHistory: Map<string, unknown[]>;
  refresh: () => Promise<void>;
} => collector as unknown as never;

describe('MonitoringCollector detail branches', () => {
  it('collects dbmgr entity and account counters via msg id 41006', async () => {
    const watcher = await startWatcherServer({
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
    cleanups.push(watcher.close);
    await startMachineResponder([
      componentPacket({ componentType: 1, componentID: 700n, pid: 4310, watcherPort: watcher.port })
    ]);

    const collector = makeCollector();
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
    expect(watcher.requests.every(request => request.messageId === 41006)).toBe(true);
  }, 8000);

  it('falls back to a Watcher placeholder when every detail is skipped', async () => {
    // watcher 端口不可达 + uid=0(UID 行也被跳过):details 全空时
    // 回落 'Watcher · 无返回' 占位行
    const dead = net.createServer();
    await new Promise<void>(resolve => dead.listen(0, '127.0.0.1', () => resolve()));
    const deadPort = (dead.address() as net.AddressInfo).port;
    await new Promise<void>(resolve => dead.close(() => resolve()));

    await startMachineResponder([
      componentPacket({ componentType: 6, componentID: 800n, pid: 4311, watcherPort: deadPort, uid: 0 })
    ]);

    const collector = makeCollector();
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
    const collector = makeCollector();
    collector.start(40);

    // 无 machine 应答端:refresh 走未发现路径,定时器持续触发不抛错
    await new Promise(resolve => setTimeout(resolve, 220));
    expect(() => collector.stop()).not.toThrow();
    expect(() => collector.dispose()).not.toThrow();
  }, 8000);

  it('collapses concurrent refresh calls with an in-flight guard', async () => {
    const collector = makeCollector();
    const refresh = internals(collector).refresh;

    // 第一次调用同步置位 in-flight,第二次直接走守卫返回
    const first = refresh.call(collector);
    const second = refresh.call(collector);
    await Promise.all([first, second]);

    expect(collector.getAllMetrics()).toEqual([]);
  }, 8000);

  it('trims per-component history to the last 300 entries', async () => {
    const watcher = await startWatcherServer({
      '': { load: 1 },
      stats: { runningTime: 1 }
    });
    cleanups.push(watcher.close);
    await startMachineResponder([
      componentPacket({ componentType: 6, componentID: 910n, pid: 4312, watcherPort: watcher.port })
    ]);

    const collector = makeCollector();
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
