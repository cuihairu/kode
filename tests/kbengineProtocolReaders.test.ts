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
  parseWatcherFrame,
  queryWatcherPath,
  swapUint16
} from '../src/kbengineProtocol';
import type { KBEngineComponentInfo } from '../src/kbengineProtocol';

// kbengineProtocol 的剩余缺口:parseWatcherFrame 的全部取值类型分支
// (BufferCursor 各读取器经此触达)、discoverLocalComponents 请求体里的
// uid/username 探测回落链、queryWatcherPath 的半帧重组断点/非回调
// msgid 忽略/连接中途被对端 RST。除 UDP/TCP 回环外零 mock。

// ---- parseWatcherFrame 值类型矩阵 ----

describe('parseWatcherFrame value type matrix', () => {
  // 线格式:type 标记 + path + name + watcherId(u16) + valueType(u8) + value
  const frameFor = (valueType: number, value: Buffer): Buffer =>
    Buffer.concat([
      Buffer.from([0]),
      buildCString('cellapp/1'),
      buildCString('metric'),
      Buffer.from([0x01, 0x00]),
      Buffer.from([valueType]),
      value
    ]);

  const scalar = (write: (b: Buffer) => void, size = 8): Buffer => {
    const b = Buffer.alloc(size);
    write(b);
    return b;
  };

  it('decodes the unsigned integer widths', () => {
    expect(
      parseWatcherFrame(frameFor(2, scalar(b => b.writeUInt16LE(65535), 2))).values.metric
    ).toBe(65535);
    expect(
      parseWatcherFrame(frameFor(3, scalar(b => b.writeUInt32LE(4000000000, 0), 4))).values.metric
    ).toBe(4000000000);
    // uint64 经 bigIntToNumber:安全范围内原值,超界钳到 MAX_SAFE_INTEGER
    expect(
      parseWatcherFrame(frameFor(4, scalar(b => b.writeBigUInt64LE(42n)))).values.metric
    ).toBe(42);
    expect(
      parseWatcherFrame(frameFor(4, scalar(b => b.writeBigUInt64LE(9007199254740993n))))
        .values.metric
    ).toBe(9007199254740991);
  });

  it('decodes the signed integer widths', () => {
    expect(parseWatcherFrame(frameFor(5, Buffer.from([0xfb]))).values.metric).toBe(-5);
    expect(
      parseWatcherFrame(frameFor(6, scalar(b => b.writeInt16LE(-300), 2))).values.metric
    ).toBe(-300);
    expect(
      parseWatcherFrame(frameFor(7, scalar(b => b.writeInt32LE(-70000), 4))).values.metric
    ).toBe(-70000);
    expect(
      parseWatcherFrame(frameFor(8, scalar(b => b.writeBigInt64LE(-5000000000n)))).values.metric
    ).toBe(-5000000000);
  });

  it('decodes float, char and component-type payloads', () => {
    expect(
      parseWatcherFrame(frameFor(9, scalar(b => b.writeFloatLE(1.25), 4))).values.metric
    ).toBe(1.25);
    expect(parseWatcherFrame(frameFor(11, Buffer.from([0x41]))).values.metric).toBe('A');
    expect(
      parseWatcherFrame(frameFor(14, scalar(b => b.writeInt32LE(6), 4))).values.metric
    ).toBe(6);
  });
});

// ---- discoverLocalComponents 的身份探测回落(UDP 回环捕获)----

interface PatchState {
  getuid?: () => number;
  uid?: string;
  UID?: string;
  USER?: string;
  LOGNAME?: string;
}

const patchIdentity = (over: PatchState): (() => void) => {
  const target = process as unknown as Record<string, unknown>;
  const original = {
    getuid: target.getuid,
    uid: process.env.uid,
    UID: process.env.UID,
    USER: process.env.USER,
    LOGNAME: process.env.LOGNAME
  };
  const setEnv = (key: 'uid' | 'UID' | 'USER' | 'LOGNAME', value: string | undefined): void => {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  };

  target.getuid = over.getuid;
  setEnv('uid', over.uid);
  setEnv('UID', over.UID);
  setEnv('USER', over.USER);
  setEnv('LOGNAME', over.LOGNAME);

  return () => {
    target.getuid = original.getuid;
    setEnv('uid', original.uid);
    setEnv('UID', original.UID);
    setEnv('USER', original.USER);
    setEnv('LOGNAME', original.LOGNAME);
  };
};

const decodeRequest = (frame: Buffer): { messageId: number; uid: number; username: string; portField: number } => {
  const messageId = frame.readUInt16LE(0);
  const bodyLength = frame.readUInt16LE(2);
  const body = frame.subarray(4, 4 + bodyLength);
  const uid = body.readInt32LE(0);
  const nullAt = body.indexOf(0, 4);
  const username = body.subarray(4, nullAt).toString('utf8');
  const portField = body.readUInt16LE(nullAt + 1);
  return { messageId, uid, username, portField };
};

describe('discoverLocalComponents identity fallbacks', () => {
  const responder = dgram.createSocket('udp4');
  const captured: Array<{ frame: Buffer; sourcePort: number }> = [];
  responder.on('message', (message, rinfo) =>
    captured.push({ frame: Buffer.from(message), sourcePort: rinfo.port })
  );

  afterEach(() => {
    captured.length = 0;
  });

  afterAll(async () => {
    await new Promise<void>(resolve => responder.close(() => resolve()));
  });

  it('fills the request body from env and username fallbacks', async () => {
    await new Promise<void>(resolve => responder.bind(MACHINE_BROADCAST_PORT, '127.0.0.1', () => resolve()));

    const restoreA = patchIdentity({ getuid: undefined, uid: '4321', USER: 'tester' });
    const discoveredA = await discoverLocalComponents(60);
    restoreA();

    expect(discoveredA).toEqual([]);
    expect(captured).toHaveLength(1);
    const requestA = decodeRequest(captured[0].frame);
    expect(requestA.messageId).toBe(MACHINE_MSG_QUERY_ALL_INTERFACES);
    expect(requestA.uid).toBe(4321);
    expect(requestA.username).toBe('tester');
    // 端口字段按实现语义回填客户端自身绑定端口(网络序字节交换)
    expect(requestA.portField).toBe(swapUint16(captured[0].sourcePort));

    // uid 走 UID,用户名走 LOGNAME
    const restoreB = patchIdentity({
      getuid: undefined,
      uid: undefined,
      UID: '77',
      USER: undefined,
      LOGNAME: 'fallbackuser'
    });
    await discoverLocalComponents(60);
    restoreB();

    expect(captured).toHaveLength(2);
    const requestB = decodeRequest(captured[1].frame);
    expect(requestB.uid).toBe(77);
    expect(requestB.username).toBe('fallbackuser');

    // 不可解析的 uid 与无名环境:uid=-1、username=unknown
    const restoreC = patchIdentity({
      getuid: undefined,
      uid: 'not-a-number',
      UID: undefined,
      USER: undefined,
      LOGNAME: undefined
    });
    await discoverLocalComponents(60);
    restoreC();

    expect(captured).toHaveLength(3);
    const requestC = decodeRequest(captured[2].frame);
    expect(requestC.uid).toBe(-1);
    expect(requestC.username).toBe('unknown');
  }, 8000);
});

// ---- queryWatcherPath 的 TCP 缺口 ----

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

const listen = (server: net.Server): Promise<number> =>
  new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port));
  });

const watchers: Array<{ close(): void }> = [];

afterEach(() => {
  while (watchers.length > 0) {
    watchers.pop()?.close();
  }
});

describe('queryWatcherPath framing gaps', () => {
  it('waits out a truncated frame body instead of misparsing it', async () => {
    // 帧头声明 1000 字节 body,只发帧头:while 循环在长度不足处断开,
    // 等超时收尾,resolve 空 results 而非把残包喂给解析器。
    const server = net.createServer(socket => {
      const header = Buffer.alloc(4);
      header.writeUInt16LE(CONSOLE_WATCHER_CB_MSG_ID, 0);
      header.writeUInt16LE(1000, 2);
      socket.write(header);
      socket.resume();
    });
    watchers.push({ close: () => server.close() });
    const port = await listen(server);

    const results = await queryWatcherPath(makeComponentInfo({ intport: port }), '/x', 80);

    expect(results).toEqual([]);
  }, 8000);

  it('ignores frames with a non-callback msg id and keeps the rest', async () => {
    const server = net.createServer(socket => {
      socket.on('data', () => {
        const junkFrame = buildFrame(65500, buildCString('not-a-watcher-callback'));
        const first = buildFrame(CONSOLE_WATCHER_CB_MSG_ID, Buffer.concat([
          Buffer.from([2]),
          buildCString('/stats'),
          buildCString('k1')
        ]));
        const second = buildFrame(CONSOLE_WATCHER_CB_MSG_ID, Buffer.concat([
          Buffer.from([2]),
          buildCString('/stats'),
          buildCString('k2')
        ]));
        socket.write(Buffer.concat([junkFrame, first, second]));
      });
    });
    watchers.push({ close: () => server.close() });
    const port = await listen(server);

    const results = await queryWatcherPath(makeComponentInfo({ intport: port }), '/stats', 2000);

    expect(results).toHaveLength(2);
    expect(results.map(result => result.keys)).toEqual([['k1'], ['k2']]);
  }, 8000);

  it('rejects when the peer resets mid query after the timeout is armed', async () => {
    // 服务端收到查询帧后不读不回用 resetAndDestroy 发 RST(Node 的
    // destroy 已把内核缓冲读空只会送 FIN):客户端在 connect→
    // resetTimeout 之后走 error→clearTimeout→reject。
    const server = net.createServer(socket => {
      setTimeout(() => socket.resetAndDestroy(), 40);
    });
    watchers.push({ close: () => server.close() });
    const port = await listen(server);

    await expect(
      queryWatcherPath(makeComponentInfo({ intport: port }), '/x', 4000)
    ).rejects.toThrow();
  }, 8000);
});
