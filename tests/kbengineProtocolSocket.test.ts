import * as dgram from 'dgram';
import * as net from 'net';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  CONSOLE_WATCHER_CB_MSG_ID,
  MACHINE_BROADCAST_PORT,
  MACHINE_MSG_QUERY_ALL_INTERFACES,
  buildCString,
  buildFrame,
  discoverLocalComponents,
  queryWatcherPath,
  swapUint16
} from '../src/kbengineProtocol';
import type { KBEngineComponentInfo } from '../src/kbengineProtocol';

// kbengineProtocol 的真实 socket 客户端:discoverLocalComponents(UDP 广播
// 发现)与 queryWatcherPath(TCP watcher 查询)。测试在本机回环上起真实
// 服务端应答,验证请求帧格式、分包重组与解析全链路——零 mock。

interface ServerComponent {
  componentType: number;
  componentID: bigint;
  pid: number;
  intport: number;
}

// parseComponentInfo 的逆过程,按线序全 LE 构造组件信息包
const buildComponentPacket = (component: ServerComponent): Buffer => {
  const parts: Buffer[] = [];
  const i32 = (value: number): Buffer => {
    const buffer = Buffer.alloc(4);
    buffer.writeInt32LE(value, 0);
    return buffer;
  };
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
  const f32 = (value: number): Buffer => {
    const buffer = Buffer.alloc(4);
    buffer.writeFloatLE(value, 0);
    return buffer;
  };
  const addr4 = (a: number, b: number, c: number, d: number): Buffer =>
    Buffer.from([a, b, c, d]);

  parts.push(i32(1001));
  parts.push(Buffer.from('ci\0', 'utf8'));
  parts.push(i32(component.componentType));
  parts.push(u64(component.componentID));
  parts.push(u64(component.componentID + 1n));
  parts.push(i32(1));
  parts.push(i32(0));
  parts.push(i32(0));
  parts.push(addr4(127, 0, 0, 1));
  parts.push(u16(swapUint16(component.intport)));
  parts.push(addr4(127, 0, 0, 1));
  parts.push(u16(swapUint16(component.intport)));
  parts.push(Buffer.from('\0', 'utf8'));
  parts.push(u32(component.pid));
  parts.push(f32(0.5));
  parts.push(f32(25));
  parts.push(u32(1024));
  parts.push(Buffer.from([1]));
  parts.push(u32(7));
  parts.push(u64(0n));
  parts.push(u64(0n));
  parts.push(u64(0n));
  parts.push(u64(0n));
  parts.push(u32(0));
  parts.push(u16(0));
  return Buffer.concat(parts);
};

const makeComponentInfo = (overrides: Partial<KBEngineComponentInfo>): KBEngineComponentInfo => ({
  uid: 1001,
  username: 'ci',
  componentType: 1,
  componentID: 900n,
  componentIDEx: 901n,
  globalOrderID: 1,
  groupOrderID: 0,
  genuuidSections: 0,
  intaddr: '127.0.0.1',
  intport: 0,
  extaddr: '127.0.0.1',
  extport: 0,
  extaddrEx: '',
  pid: 4321,
  cpu: 0.5,
  mem: 25,
  usedmem: 1024,
  state: 1,
  machineID: 7,
  extradata: 0n,
  extradata1: 0n,
  extradata2: 0n,
  extradata3: 0n,
  backaddr: 0,
  backport: 0,
  componentName: 'baseapp',
  fullName: 'baseapp',
  ...overrides
});

const watchers: Array<{ close(): void }> = [];

afterEach(() => {
  while (watchers.length > 0) {
    watchers.pop()?.close();
  }
});

afterAll(() => {
  watchers.forEach(watcher => watcher.close());
});

describe('discoverLocalComponents over real UDP', () => {
  it('sends the machine query and parses the broadcast replies', async () => {
    const responder = dgram.createSocket('udp4');
    watchers.push(responder);

    const requestFrame: Promise<{ uid: number; username: string; replyPort: number; sourcePort: number }> =
      new Promise((resolve, reject) => {
        responder.once('error', reject);
        responder.once('message', (packet, rinfo) => {
          expect(packet.readUInt16LE(0)).toBe(MACHINE_MSG_QUERY_ALL_INTERFACES);
          const body = packet.subarray(4);
          const uid = body.readInt32LE(0);
          let offset = 4;
          while (body[offset] !== 0) {
            offset += 1;
          }
          const username = body.toString('utf8', 4, offset);
          const replyPort = swapUint16(body.readUInt16LE(offset + 1));
          resolve({ uid, username, replyPort, sourcePort: rinfo.port });
        });
      });

    await new Promise<void>((resolve, reject) => {
      responder.once('error', reject);
      responder.bind(MACHINE_BROADCAST_PORT, '127.0.0.1', () => resolve());
    });

    responder.on('message', (_packet, rinfo) => {
      // baseapp=6, cellapp=5(引擎 COMPONENT_TYPE 序)
      const first = buildComponentPacket({
        componentType: 6,
        componentID: 900n,
        pid: 4321,
        intport: 20001
      });
      const second = buildComponentPacket({
        componentType: 5,
        componentID: 901n,
        pid: 4322,
        intport: 20002
      });
      responder.send(first, rinfo.port, '127.0.0.1');
      responder.send(second, rinfo.port, '127.0.0.1');
      // 重复包按 componentType:componentID:pid 去重
      responder.send(first, rinfo.port, '127.0.0.1');
    });

    const components = await discoverLocalComponents(1200);

    const request = await requestFrame;
    expect(request.uid).toBe(process.getuid?.() ?? 1001);
    expect(request.username.length).toBeGreaterThan(0);
    // 客户端以自身 bind 的临时端口发包,帧内回填端口须与源端口一致
    expect(request.replyPort).toBe(request.sourcePort);

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
    const responder = dgram.createSocket('udp4');
    watchers.push(responder);

    await new Promise<void>((resolve, reject) => {
      responder.once('error', reject);
      responder.bind(MACHINE_BROADCAST_PORT, '127.0.0.1', () => resolve());
    });

    responder.on('message', (_packet, rinfo) => {
      responder.send(Buffer.from([0x01, 0x02]), rinfo.port, '127.0.0.1');
    });

    await expect(discoverLocalComponents(1200)).rejects.toThrow();
  }, 8000);
});

describe('queryWatcherPath over real TCP', () => {
  it('returns empty results for unknown component types', async () => {
    const component = makeComponentInfo({ componentType: 99 });
    expect(await queryWatcherPath(component, '/cellapp', 50)).toEqual([]);
  });

  it('reassembles split frames and parses watcher values', async () => {
    const connections: net.Socket[] = [];
    const receivedFrames: Array<{ messageId: number; body: Buffer }> = [];

    const server = net.createServer(socket => {
      connections.push(socket);
      socket.on('data', data => {
        receivedFrames.push({
          messageId: data.readUInt16LE(0),
          body: data.subarray(4)
        });

        // 帧格式:首字节 type(0=值),路径/名/uid/值类型/值
        const watchBody = Buffer.concat([
          Buffer.from([0]),
          buildCString('/cellapp/clients'),
          buildCString('uptime'),
          (() => {
            const buffer = Buffer.alloc(2);
            buffer.writeUInt16LE(7, 0);
            return buffer;
          })(),
          Buffer.from([3]),
          (() => {
            const buffer = Buffer.alloc(4);
            buffer.writeUInt32LE(42, 0);
            return buffer;
          })()
        ]);
        const watchFrame = buildFrame(CONSOLE_WATCHER_CB_MSG_ID, watchBody);

        // type=1 目录帧:rootPath + keys cstring 串
        const dirBody = Buffer.concat([
          Buffer.from([1]),
          buildCString('/'),
          buildCString('children1'),
          buildCString('children2')
        ]);
        const dirFrame = buildFrame(CONSOLE_WATCHER_CB_MSG_ID, dirBody);

        // 先只发 3 字节,再补齐两帧——验证客户端的分包重组
        socket.write(watchFrame.subarray(0, 3));
        setTimeout(() => {
          socket.write(Buffer.concat([watchFrame.subarray(3), dirFrame]));
        }, 30);
      });
    });
    const listening = new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
    watchers.push({ close: () => server.close() });
    await listening;
    const port = (server.address() as net.AddressInfo).port;

    const results = await queryWatcherPath(
      makeComponentInfo({ componentType: 1, intport: port }),
      '/cellapp/clients',
      2000
    );

    expect(receivedFrames).toHaveLength(1);
    expect(receivedFrames[0].messageId).toBe(41006);
    expect(receivedFrames[0].body).toEqual(buildCString('/cellapp/clients'));
    connections.forEach(socket => socket.destroy());

    expect(results).toHaveLength(2);
    expect(results[0].type).toBe(0);
    expect(results[0].path).toBe('/cellapp/clients');
    expect(results[0].values.uptime).toBe(42);
    expect(results[1].type).toBe(1);
    expect(results[1].path).toBe('');
    expect(results[1].keys).toEqual(['children1', 'children2']);
  }, 8000);

  it('rejects when the watcher endpoint refuses the connection', async () => {
    const dead = net.createServer();
    const listening = new Promise<void>(resolve => dead.listen(0, '127.0.0.1', () => resolve()));
    await listening;
    const port = (dead.address() as net.AddressInfo).port;
    await new Promise<void>(resolve => dead.close(() => resolve()));

    await expect(
      queryWatcherPath(makeComponentInfo({ componentType: 1, intport: port }), '/x', 2000)
    ).rejects.toThrow();
  }, 8000);
});
