import * as dgram from 'dgram';
import * as net from 'net';

export interface KBEngineComponentInfo {
  uid: number;
  username: string;
  componentType: number;
  componentID: bigint;
  componentIDEx: bigint;
  globalOrderID: number;
  groupOrderID: number;
  genuuidSections: number;
  intaddr: string;
  intport: number;
  extaddr: string;
  extport: number;
  extaddrEx: string;
  pid: number;
  cpu: number;
  mem: number;
  usedmem: number;
  state: number;
  machineID: number;
  extradata: bigint;
  extradata1: bigint;
  extradata2: bigint;
  extradata3: bigint;
  backaddr: number;
  backport: number;
  componentName: string;
  fullName: string;
}

export interface WatcherQueryResult {
  type: number;
  path: string;
  values: Record<string, string | number | boolean>;
  keys: string[];
}

/**
 * machine 发现的可注入目标。生产默认 127.0.0.1:20086(引擎广播端口);
 * 测试/仿真通过覆盖 host/port 指向本地仿真器,避免固定端口争用。
 */
export interface MachineDiscoveryOptions {
  host?: string;
  port?: number;
  timeoutMs?: number;
}

export const MACHINE_MSG_QUERY_ALL_INTERFACES = 4;
// 引擎侧依据:CONSOLE_WATCHERCB_MSGID = 65502(kbe/src/lib/helper/console_helper.h);
// KBE_MACHINE_BROADCAST_SEND_PORT = KBE_PORT_START + 86(kbe/src/lib/network/common.h)。
export const CONSOLE_WATCHER_CB_MSG_ID = 65502;
export const MACHINE_BROADCAST_PORT = 20086;

// 与引擎 COMPONENT_TYPE 枚举(kbe/src/lib/common/common.h)逐值对齐:
// UNKNOWN=0 … INTERFACES=13,TOOL=14;COMPONENT_END_TYPE=15 为哨兵不收录。
export const COMPONENT_NAMES = [
  'unknown',
  'dbmgr',
  'loginapp',
  'baseappmgr',
  'cellappmgr',
  'cellapp',
  'baseapp',
  'client',
  'machine',
  'console',
  'logger',
  'bots',
  'watcher',
  'interfaces',
  'tool'
];

const WATCHER_QUERY_MSG_IDS: Record<number, number> = {
  1: 41006,
  2: 41003,
  3: 41004,
  4: 41005,
  5: 41002,
  6: 41001,
  10: 41008,
  13: 41007
};

const WATCHER_VALUE_TYPE_UINT8 = 1;
const WATCHER_VALUE_TYPE_UINT16 = 2;
const WATCHER_VALUE_TYPE_UINT32 = 3;
const WATCHER_VALUE_TYPE_UINT64 = 4;
const WATCHER_VALUE_TYPE_INT8 = 5;
const WATCHER_VALUE_TYPE_INT16 = 6;
const WATCHER_VALUE_TYPE_INT32 = 7;
const WATCHER_VALUE_TYPE_INT64 = 8;
const WATCHER_VALUE_TYPE_FLOAT = 9;
const WATCHER_VALUE_TYPE_DOUBLE = 10;
const WATCHER_VALUE_TYPE_CHAR = 11;
const WATCHER_VALUE_TYPE_STRING = 12;
const WATCHER_VALUE_TYPE_BOOL = 13;
const WATCHER_VALUE_TYPE_COMPONENT_TYPE = 14;

class BufferCursor {
  constructor(private readonly buffer: Buffer, private offset = 0) {}

  eof(): boolean {
    return this.offset >= this.buffer.length;
  }

  read(count: number): Buffer {
    const value = this.buffer.subarray(this.offset, this.offset + count);
    this.offset += count;
    return value;
  }

  readInt8(): number {
    const value = this.buffer.readInt8(this.offset);
    this.offset += 1;
    return value;
  }

  readUInt8(): number {
    const value = this.buffer.readUInt8(this.offset);
    this.offset += 1;
    return value;
  }

  readInt16(): number {
    const value = this.buffer.readInt16LE(this.offset);
    this.offset += 2;
    return value;
  }

  readUInt16(): number {
    const value = this.buffer.readUInt16LE(this.offset);
    this.offset += 2;
    return value;
  }

  readInt32(): number {
    const value = this.buffer.readInt32LE(this.offset);
    this.offset += 4;
    return value;
  }

  readUInt32(): number {
    const value = this.buffer.readUInt32LE(this.offset);
    this.offset += 4;
    return value;
  }

  readInt64(): bigint {
    const value = this.buffer.readBigInt64LE(this.offset);
    this.offset += 8;
    return value;
  }

  readUInt64(): bigint {
    const value = this.buffer.readBigUInt64LE(this.offset);
    this.offset += 8;
    return value;
  }

  readFloat(): number {
    const value = this.buffer.readFloatLE(this.offset);
    this.offset += 4;
    return value;
  }

  readDouble(): number {
    const value = this.buffer.readDoubleLE(this.offset);
    this.offset += 8;
    return value;
  }

  readBool(): boolean {
    return this.readInt8() > 0;
  }

  readCString(): string {
    const start = this.offset;
    while (this.offset < this.buffer.length && this.buffer[this.offset] !== 0) {
      this.offset += 1;
    }

    const value = this.buffer.toString('utf8', start, this.offset);
    if (this.offset < this.buffer.length) {
      this.offset += 1;
    }

    return value;
  }
}

export function swapUint16(value: number): number {
  return ((value & 0xff) << 8) | ((value >> 8) & 0xff);
}

export function buildFrame(messageId: number, body: Buffer): Buffer {
  const buffer = Buffer.alloc(4 + body.length);
  buffer.writeUInt16LE(messageId, 0);
  buffer.writeUInt16LE(body.length, 2);
  body.copy(buffer, 4);
  return buffer;
}

export function buildCString(value: string): Buffer {
  return Buffer.concat([Buffer.from(value, 'utf8'), Buffer.from([0])]);
}

function getDefaultUid(): number {
  if (typeof process.getuid === 'function') {
    return process.getuid();
  }

  const envUid = process.env.uid || process.env.UID;
  const parsed = envUid ? Number(envUid) : NaN;
  return Number.isFinite(parsed) ? parsed : -1;
}

function getDefaultUsername(): string {
  return process.env.USER || process.env.LOGNAME || 'unknown';
}

export function toIPv4(buffer: Buffer): string {
  return Array.from(buffer.values()).join('.');
}

export function bigIntToNumber(value: bigint): number {
  return value > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(value);
}

export function parseComponentInfo(buffer: Buffer): KBEngineComponentInfo {
  const reader = new BufferCursor(buffer);
  const uid = reader.readInt32();
  const username = reader.readCString();
  const componentType = reader.readInt32();
  const componentID = reader.readUInt64();
  const componentIDEx = reader.readUInt64();
  const globalOrderID = reader.readInt32();
  const groupOrderID = reader.readInt32();
  const genuuidSections = reader.readInt32();
  const intaddr = toIPv4(reader.read(4));
  const intport = swapUint16(reader.readUInt16());
  const extaddr = toIPv4(reader.read(4));
  const extport = swapUint16(reader.readUInt16());
  const extaddrEx = reader.readCString();
  const pid = reader.readUInt32();
  const cpu = reader.readFloat();
  const mem = reader.readFloat();
  const usedmem = reader.readUInt32();
  const state = reader.readInt8();
  const machineID = reader.readUInt32();
  const extradata = reader.readUInt64();
  const extradata1 = reader.readUInt64();
  const extradata2 = reader.readUInt64();
  const extradata3 = reader.readUInt64();
  const backaddr = reader.readUInt32();
  const backport = reader.readUInt16();
  const componentName = COMPONENT_NAMES[componentType] || `component_${componentType}`;

  return {
    uid,
    username,
    componentType,
    componentID,
    componentIDEx,
    globalOrderID,
    groupOrderID,
    genuuidSections,
    intaddr,
    intport,
    extaddr,
    extport,
    extaddrEx,
    pid,
    cpu,
    mem,
    usedmem,
    state,
    machineID,
    extradata,
    extradata1,
    extradata2,
    extradata3,
    backaddr,
    backport,
    componentName,
    fullName:
      componentType === 5 || componentType === 6
        ? `${componentName}${groupOrderID}`
        : componentName
  };
}

export function parseWatcherFrame(body: Buffer): WatcherQueryResult {
  const reader = new BufferCursor(body);
  const type = reader.readUInt8();
  const result: WatcherQueryResult = {
    type,
    path: '',
    values: {},
    keys: []
  };

  if (type === 0) {
    while (!reader.eof()) {
      const path = reader.readCString();
      const name = reader.readCString();
      const watcherId = reader.readUInt16();
      const valueType = reader.readUInt8();
      void watcherId;

      let value: string | number | boolean;

      switch (valueType) {
        case WATCHER_VALUE_TYPE_UINT8:
          value = reader.readUInt8();
          break;
        case WATCHER_VALUE_TYPE_UINT16:
          value = reader.readUInt16();
          break;
        case WATCHER_VALUE_TYPE_UINT32:
          value = reader.readUInt32();
          break;
        case WATCHER_VALUE_TYPE_UINT64:
          value = bigIntToNumber(reader.readUInt64());
          break;
        case WATCHER_VALUE_TYPE_INT8:
          value = reader.readInt8();
          break;
        case WATCHER_VALUE_TYPE_INT16:
          value = reader.readInt16();
          break;
        case WATCHER_VALUE_TYPE_INT32:
          value = reader.readInt32();
          break;
        case WATCHER_VALUE_TYPE_INT64:
          value = bigIntToNumber(reader.readInt64());
          break;
        case WATCHER_VALUE_TYPE_FLOAT:
          value = reader.readFloat();
          break;
        case WATCHER_VALUE_TYPE_DOUBLE:
          value = reader.readDouble();
          break;
        case WATCHER_VALUE_TYPE_CHAR:
          value = reader.read(1).toString('utf8');
          break;
        case WATCHER_VALUE_TYPE_STRING:
          value = reader.readCString();
          break;
        case WATCHER_VALUE_TYPE_BOOL:
          value = reader.readBool();
          break;
        case WATCHER_VALUE_TYPE_COMPONENT_TYPE:
          value = reader.readInt32();
          break;
        default:
          throw new Error(`Unsupported watcher value type: ${valueType}`);
      }

      result.path = path;
      result.values[name] = value;
    }

    return result;
  }

  const rootPath = reader.readCString();
  result.path = rootPath === '/' ? '' : rootPath;

  while (!reader.eof()) {
    result.keys.push(reader.readCString());
  }

  return result;
}

function ipv4ToBytes(value: string): Buffer {
  const octets = value.split('.').map(octet => Number.parseInt(octet, 10));
  if (octets.length !== 4 || octets.some(octet => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return Buffer.from([127, 0, 0, 1]);
  }
  return Buffer.from(octets);
}

/**
 * parseComponentInfo 的逆过程:按线序全 LE 编码组件广播包。
 * machine 侧(与本地仿真器)用它构造应答,客户端用 parseComponentInfo
 * 解析——同一份协议规格的正反两面,防止两侧漂移。
 */
export function buildComponentInfo(info: KBEngineComponentInfo): Buffer {
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

  parts.push(i32(info.uid));
  parts.push(buildCString(info.username));
  parts.push(i32(info.componentType));
  parts.push(u64(info.componentID));
  parts.push(u64(info.componentIDEx));
  parts.push(i32(info.globalOrderID));
  parts.push(i32(info.groupOrderID));
  parts.push(i32(info.genuuidSections));
  parts.push(ipv4ToBytes(info.intaddr));
  parts.push(u16(swapUint16(info.intport)));
  parts.push(ipv4ToBytes(info.extaddr));
  parts.push(u16(swapUint16(info.extport)));
  parts.push(buildCString(info.extaddrEx));
  parts.push(u32(info.pid));
  parts.push(f32(info.cpu));
  parts.push(f32(info.mem));
  parts.push(u32(info.usedmem));
  parts.push(Buffer.from([info.state]));
  parts.push(u32(info.machineID));
  parts.push(u64(info.extradata));
  parts.push(u64(info.extradata1));
  parts.push(u64(info.extradata2));
  parts.push(u64(info.extradata3));
  parts.push(u32(info.backaddr));
  parts.push(u16(info.backport));
  return Buffer.concat(parts);
}

/**
 * watcher 值编码:string→STRING(12)、bigint→UINT64(4)、boolean→BOOL(13)、
 * 其余 number→UINT32(3)。取值类型集与 parseWatcherFrame 的读取矩阵一致。
 */
export function encodeWatcherValue(value: string | number | bigint | boolean): Buffer {
  const typeTag = (type: number): Buffer => Buffer.from([type]);
  const u32 = (numeric: number): Buffer => {
    const buffer = Buffer.alloc(4);
    buffer.writeUInt32LE(numeric, 0);
    return buffer;
  };
  const u64 = (bigValue: bigint): Buffer => {
    const buffer = Buffer.alloc(8);
    buffer.writeBigUInt64LE(bigValue, 0);
    return buffer;
  };

  if (typeof value === 'boolean') {
    return Buffer.concat([typeTag(WATCHER_VALUE_TYPE_BOOL), Buffer.from([value ? 1 : 0])]);
  }
  if (typeof value === 'bigint') {
    return Buffer.concat([typeTag(WATCHER_VALUE_TYPE_UINT64), u64(value)]);
  }
  if (typeof value === 'string') {
    return Buffer.concat([typeTag(WATCHER_VALUE_TYPE_STRING), buildCString(value)]);
  }
  return Buffer.concat([typeTag(WATCHER_VALUE_TYPE_UINT32), u32(value)]);
}

/**
 * 构造 type 0 值帧 body:首字节 type 标记 + 若干
 * path/name/watcherId/valueType/value 元组(与 parseWatcherFrame 对偶)。
 */
export function buildWatcherValueFrameBody(
  path: string,
  entries: Record<string, string | number | bigint | boolean>
): Buffer {
  const tuples: Buffer[] = [Buffer.from([0])];
  let watcherId = 1;
  for (const [name, value] of Object.entries(entries)) {
    const id = Buffer.alloc(2);
    id.writeUInt16LE(watcherId, 0);
    tuples.push(Buffer.concat([buildCString(path), buildCString(name), id, encodeWatcherValue(value)]));
    watcherId += 1;
  }
  return Buffer.concat(tuples);
}

/**
 * 构造 type 1 目录帧 body:首字节 type 标记 + rootPath + keys cstring 串。
 * rootPath 传 '/' 时 parseWatcherFrame 归一为 ''。
 */
export function buildWatcherDirFrameBody(rootPath: string, keys: string[]): Buffer {
  return Buffer.concat([Buffer.from([1]), buildCString(rootPath), ...keys.map(key => buildCString(key))]);
}

export async function discoverLocalComponents(
  options: MachineDiscoveryOptions = {}
): Promise<KBEngineComponentInfo[]> {
  const { host = '127.0.0.1', port = MACHINE_BROADCAST_PORT, timeoutMs = 800 } = options;
  const socket = dgram.createSocket('udp4');
  const components = new Map<string, KBEngineComponentInfo>();

  return await new Promise<KBEngineComponentInfo[]>((resolve, reject) => {
    let settled = false;

    const finish = () => {
      if (settled) {
        return;
      }

      settled = true;
      socket.close();
      resolve([...components.values()]);
    };

    socket.on('message', message => {
      try {
        const component = parseComponentInfo(message);
        const key = `${component.componentType}:${component.componentID.toString()}:${component.pid}`;
        components.set(key, component);
      } catch (error) {
        if (!settled) {
          settled = true;
          socket.close();
          reject(error);
        }
      }
    });

    socket.on('error', error => {
      if (!settled) {
        settled = true;
        socket.close();
        reject(error);
      }
    });

    socket.bind(0, '0.0.0.0', () => {
      const address = socket.address();
      if (typeof address === 'string') {
        if (!settled) {
          settled = true;
          socket.close();
          reject(new Error('Failed to bind UDP socket for machine discovery.'));
        }
        return;
      }

      const username = buildCString(getDefaultUsername());
      const body = Buffer.alloc(4 + username.length + 2);
      let offset = 0;
      body.writeInt32LE(getDefaultUid(), offset);
      offset += 4;
      username.copy(body, offset);
      offset += username.length;
      body.writeUInt16LE(swapUint16(address.port), offset);

      const frame = buildFrame(MACHINE_MSG_QUERY_ALL_INTERFACES, body);
      socket.send(frame, port, host);
      setTimeout(finish, timeoutMs);
    });
  });
}

export async function queryWatcherPath(
  component: KBEngineComponentInfo,
  path: string,
  timeoutMs = 800
): Promise<WatcherQueryResult[]> {
  const messageId = WATCHER_QUERY_MSG_IDS[component.componentType];
  if (!messageId) {
    return [];
  }

  return await new Promise<WatcherQueryResult[]>((resolve, reject) => {
    const socket = new net.Socket();
    let receiveBuffer = Buffer.alloc(0);
    const results: WatcherQueryResult[] = [];
    let timeout: NodeJS.Timeout | null = null;
    let settled = false;

    const finish = () => {
      if (settled) {
        return;
      }

      settled = true;
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }

      socket.destroy();
      resolve(results);
    };

    const resetTimeout = () => {
      if (timeout) {
        clearTimeout(timeout);
      }

      timeout = setTimeout(finish, timeoutMs);
    };

    socket.once('connect', () => {
      socket.write(buildFrame(messageId, buildCString(path)));
      resetTimeout();
    });

    socket.on('data', data => {
      receiveBuffer = Buffer.concat([receiveBuffer, data]);

      while (receiveBuffer.length >= 4) {
        const frameMessageId = receiveBuffer.readUInt16LE(0);
        const frameLength = receiveBuffer.readUInt16LE(2);
        const totalLength = 4 + frameLength;

        if (receiveBuffer.length < totalLength) {
          break;
        }

        const body = receiveBuffer.subarray(4, totalLength);
        receiveBuffer = receiveBuffer.subarray(totalLength);

        if (frameMessageId === CONSOLE_WATCHER_CB_MSG_ID) {
          results.push(parseWatcherFrame(body));
        }
      }

      if (results.length >= 2) {
        finish();
        return;
      }

      resetTimeout();
    });

    socket.on('error', error => {
      if (!settled) {
        settled = true;
        if (timeout) {
          clearTimeout(timeout);
        }
        socket.destroy();
        reject(error);
      }
    });

    socket.connect(component.intport, component.intaddr);
  });
}
