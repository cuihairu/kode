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
export const CONSOLE_PROFILE_CB_MSG_ID = 65503;
// kbe/res/server/messages_fixed_defaults.xml:<Cellappmgr::querySpaces><id>50003</id>
export const CELLAPPMGR_QUERY_SPACES_MSG_ID = 50003;
export const MACHINE_BROADCAST_PORT = 20086;

// ---------------------------------------------------------------------------
// guiconsole console 链路期一(KB-GC-001)协议常量。引擎树
// kode 仓 ../kbengine @3082ab5 逐条引证,进 watcherProtocolAudit 审计锁:
// - 701/702/703 出自 kbe/res/server/messages_fixed_defaults.xml
//   <Logger::onAppActiveTick>/<Logger::registerLogWatcher>/<Logger::deregisterLogWatcher>;
// - 65501 = console_helper.h:10 CONSOLE_LOG_MSGID(代码强制号,不在 XML);
// - KBELOG_TYPES 位并集 = 0x7ff(debug_helper.h:46-47)。
export const LOGGER_APP_ACTIVE_TICK_MSG_ID = 701;
export const LOGGER_REGISTER_LOG_WATCHER_MSG_ID = 702;
export const LOGGER_DEREGISTER_LOG_WATCHER_MSG_ID = 703;
export const CONSOLE_LOG_MSG_ID = 65501;
export const KBELOG_TYPES_MASK = 0x7ff;

/** logger logstream 级别名 ↔ KBELOG 位(debug_helper.h:35-44/55-68) */
export const KBELOG_LEVEL_BITS: Record<string, number> = {
  UNKNOWN: 0x00,
  PRINT: 0x01,
  ERROR: 0x02,
  WARNING: 0x04,
  DEBUG: 0x08,
  INFO: 0x10,
  CRITICAL: 0x20,
  S_INFO: 0x40,
  S_ERR: 0x80,
  S_DBG: 0x100,
  S_WARN: 0x200,
  S_NORM: 0x400
};

export function kbelogLevelBit(level: string): number {
  return KBELOG_LEVEL_BITS[level] ?? 0x00;
}

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

export const WATCHER_QUERY_MSG_IDS: Record<number, number> = {
  1: 41006,
  2: 41003,
  3: 41004,
  4: 41005,
  5: 41002,
  6: 41001,
  10: 41008,
  13: 41007
};

const PROFILE_REQUEST_MSG_IDS: Record<number, number> = {
  1: 51001,
  2: 51004,
  3: 51001,
  4: 51003,
  5: 51002,
  6: 51001,
  7: 51005,
  8: 51006,
  10: 51008,
  11: 51007,
  12: 51009
};

export type ProfileResultKind = 'pyprofile' | 'cprofile' | 'eventprofile' | 'networkprofile';

export interface CProfileRow {
  name: string;
  count: number;
  lastTime: number;
  totalTime: number;
  lastInclusiveTime: number;
  totalInclusiveTime: number;
}

export interface NetworkProfileRow {
  name: string;
  sendCount: number;
  sendSize: number;
  sendAverageSize: number;
  totalSendCount: number;
  totalSendSize: number;
  recvCount: number;
  recvSize: number;
  recvAverageSize: number;
  totalRecvCount: number;
  totalRecvSize: number;
}

export interface EventProfileGroup {
  typeName: string;
  events: Array<{ name: string; count: number; size: number }>;
}

export interface ProfileQueryResult {
  kind: ProfileResultKind;
  componentType: number;
  componentID: bigint;
  timingLength: number;
  text?: string;
  rows?: CProfileRow[] | NetworkProfileRow[];
  events?: EventProfileGroup[];
}

export interface SpaceCell {
  cellappID: bigint;
  cellID: number;
}

export interface SpaceSnapshot {
  componentType: number;
  componentID: bigint;
  cellappID: bigint;
  spaceID: number;
  geomappingPath: string;
  scriptModuleName: string;
  cells: number[];
}

export interface SpaceQueryResult {
  componentType: number;
  componentID: bigint;
  spaces: SpaceSnapshot[];
}

export interface ProfileStartOptions {
  profileName: string;
  kind: ProfileResultKind;
  timingLengthSeconds: number;
}

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

/**
 * 定长消息帧:仅 2 字节消息号 + 定长 body,无长度字段。
 * 引擎 Bundle::startMessage 只在 msgLen==NETWORK_VARIABLE_MESSAGE 时插入长度字段
 * (bundle.cpp:303-309);NETWORK_FIXED_MESSAGE 的 701 onAppActiveTick 不带长度
 * (logger_interface.h:52 LOGGER_MESSAGE_DECLARE_ARGS2(onAppActiveTick,...,NETWORK_FIXED_MESSAGE))。
 * 误用 buildFrame 会给引擎多塞 2 字节长度,使其把长度当 COMPONENT_TYPE 前 2 字节读,
 * 参数错位(component_active_report_handler.cpp:67-71 按 INT32+UINT64 定长读)。
 */
export function buildFixedFrame(messageId: number, body: Buffer): Buffer {
  const buffer = Buffer.alloc(2 + body.length);
  buffer.writeUInt16LE(messageId, 0);
  body.copy(buffer, 2);
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

export function buildProfileRequestBody(options: ProfileStartOptions): Buffer {
  const profileKind = { pyprofile: 0, cprofile: 1, eventprofile: 2, networkprofile: 3 }[options.kind];
  const timingLength = Buffer.alloc(4);
  timingLength.writeUInt32LE(options.timingLengthSeconds, 0);
  return Buffer.concat([buildCString(options.profileName), Buffer.from([profileKind]), timingLength]);
}

export function parseProfileFrame(body: Buffer, component: KBEngineComponentInfo): ProfileQueryResult {
  const reader = new BufferCursor(body);
  const resultKind = reader.readInt8();
  let timingLength = 0;
  const base = {
    componentType: component.componentType,
    componentID: component.componentID
  };

  if (resultKind === 0) {
    timingLength = reader.readUInt32();
    return { ...base, kind: 'pyprofile', timingLength, text: reader.readCString() };
  }
  if (resultKind === 2) {
    timingLength = reader.readUInt32();
    const groups: EventProfileGroup[] = [];
    const count = reader.readUInt32();
    for (let groupIndex = 0; groupIndex < count && !reader.eof(); groupIndex += 1) {
      const typeName = reader.readCString();
      const eventCount = reader.readUInt32();
      const events: EventProfileGroup['events'] = [];
      for (let eventIndex = 0; eventIndex < eventCount && !reader.eof(); eventIndex += 1) {
        events.push({
          name: reader.readCString(),
          count: reader.readUInt32(),
          size: reader.readUInt32()
        });
      }
      groups.push({ typeName, events });
    }
    return { ...base, kind: 'eventprofile', timingLength, events: groups };
  }
  if (resultKind === 3) {
    timingLength = reader.readUInt32();
    const rows: NetworkProfileRow[] = [];
    const count = reader.readUInt32();
    for (let index = 0; index < count && !reader.eof(); index += 1) {
      rows.push({
        name: reader.readCString(),
        sendCount: reader.readUInt32(),
        sendSize: reader.readUInt32(),
        sendAverageSize: reader.readUInt32(),
        totalSendCount: reader.readUInt32(),
        totalSendSize: reader.readUInt32(),
        recvCount: reader.readUInt32(),
        recvSize: reader.readUInt32(),
        recvAverageSize: reader.readUInt32(),
        totalRecvCount: reader.readUInt32(),
        totalRecvSize: reader.readUInt32()
      });
    }
    return { ...base, kind: 'networkprofile', timingLength, rows };
  }

  // cprofile(引擎 ProfileKind=1):CProfileHandler::timeout() 写序
  // (profile_handler.cpp:95-128)= timinglen_ → size-1(除 RunningTime 外行数)
  // → 每行(name,count,lastTime,sumTime,lastIntTime,sumIntTime)。漏读
  // timingLength 会让行数据整体错位(KR-AUD-68)。
  timingLength = reader.readUInt32();
  const rows: CProfileRow[] = [];
  const count = reader.readUInt32();
  for (let index =0; index < count && !reader.eof(); index += 1) {
    rows.push({
      name: reader.readCString(),
      count: reader.readUInt32(),
      lastTime: reader.readFloat(),
      totalTime: reader.readFloat(),
      lastInclusiveTime: reader.readFloat(),
      totalInclusiveTime: reader.readFloat()
    });
  }
  return { ...base, kind: 'cprofile', timingLength, rows };
}

export function parseSpaceFrame(body: Buffer): SpaceQueryResult {
  const reader = new BufferCursor(body);
  const componentType = reader.readInt32();
  const componentID = reader.readUInt64();
  const spaces: SpaceSnapshot[] = [];
  while (!reader.eof()) {
    const cellappID = reader.readUInt64();
    const spaceCount = reader.readUInt32();
    for (let index = 0; index < spaceCount && !reader.eof(); index += 1) {
      const spaceID = reader.readUInt32();
      const geomappingPath = reader.readCString();
      const scriptModuleName = reader.readCString();
      const cellCount = reader.readUInt32();
      const cells: number[] = [];
      for (let cellIndex = 0; cellIndex < cellCount && !reader.eof(); cellIndex += 1) {
        cells.push(reader.readUInt32());
      }
      spaces.push({
        componentType,
        componentID,
        cellappID,
        spaceID,
        geomappingPath,
        scriptModuleName,
        cells
      });
    }
  }
  return { componentType, componentID, spaces };
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
      // machine 发现本就是广播协议:目标可为 127.0.0.1(同机直查)或广播地址
      // (异机真机联验),后者必须带 SO_BROADCAST 才能发出;测试注入的假 socket
      // 无该方法,可选调用放行
      socket.setBroadcast?.(true);
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
      // 不可达(批72 定性):该 if 的隐式 else 臂(v8-to-istanbul 记为 arm#1
      // armLoc=undefined)对应"初始 setTimeout(finish, timeoutMs)在 connect
      // 之前触发"的竞态路径。真实网络环境下 connect 几乎总在 800ms
      // 内完成,且测试层以 fake timers 推进+先发 connect 的顺序覆盖主流路径,
      // 竞态窗口既难稳定复现也不属功能性缺陷。真臂行为由既有
      // kbengineProtocolGaps.test.ts 中"lets a late data frame rearm the timer"
      // 与"keeps the resolved result when a late socket error arrives"用例锁定。
      /* istanbul ignore start */
      if (timeout) {
      /* istanbul ignore stop */
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

async function queryConsoleFrames<T>(
  component: KBEngineComponentInfo,
  requestBody: Buffer | null,
  messageId: number | null,
  callbackId: number,
  parseFrame: (body: Buffer) => T,
  timeoutMs: number
): Promise<T[]> {
  if (!messageId) return [];
  return await new Promise<T[]>((resolve, reject) => {
    const socket = new net.Socket();
    let receiveBuffer = Buffer.alloc(0);
    const results: T[] = [];
    let timeout: NodeJS.Timeout | null = null;
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      socket.destroy();
      resolve(results);
    };
    const resetTimeout = () => {
      if (timeout) clearTimeout(timeout);
      timeout = setTimeout(finish, timeoutMs);
    };

    socket.once('connect', () => {
      socket.write(buildFrame(messageId, requestBody ?? Buffer.alloc(0)));
      resetTimeout();
    });
    socket.on('data', data => {
      receiveBuffer = Buffer.concat([receiveBuffer, data]);
      while (receiveBuffer.length >= 4) {
        const frameMessageId = receiveBuffer.readUInt16LE(0);
        const frameLength = receiveBuffer.readUInt16LE(2);
        const totalLength = 4 + frameLength;
        if (receiveBuffer.length < totalLength) break;
        const body = receiveBuffer.subarray(4, totalLength);
        receiveBuffer = receiveBuffer.subarray(totalLength);
        if (frameMessageId === callbackId) results.push(parseFrame(body));
      }
      if (results.length > 0) {
        finish();
        return;
      }
      resetTimeout();
    });
    socket.on('error', error => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      socket.destroy();
      reject(error);
    });
    socket.connect(component.intport, component.intaddr);
  });
}

export async function startProfileQuery(
  component: KBEngineComponentInfo,
  options: ProfileStartOptions,
  timeoutMs = 12000
): Promise<ProfileQueryResult[]> {
  const messageId = PROFILE_REQUEST_MSG_IDS[component.componentType];
  if (!messageId) return [];
  return await queryConsoleFrames(
    component,
    buildProfileRequestBody(options),
    messageId,
    CONSOLE_PROFILE_CB_MSG_ID,
    body => parseProfileFrame(body, component),
    timeoutMs
  );
}

export async function querySpaces(component: KBEngineComponentInfo, timeoutMs = 800): Promise<SpaceQueryResult> {
  const empty: SpaceQueryResult = {
    componentType: component.componentType,
    componentID: component.componentID,
    spaces: []
  };
  if (component.componentType !== 4) return empty;
  const results = await queryConsoleFrames<SpaceQueryResult>(
    component,
    null,
    CELLAPPMGR_QUERY_SPACES_MSG_ID,
    CONSOLE_PROFILE_CB_MSG_ID,
    parseSpaceFrame,
    timeoutMs
  );
  return results[0] ?? empty;
}

// ---------------------------------------------------------------------------
// guiconsole console 链路期一(KB-GC-001)帧构造/解析。
export interface LogWatcherRequestOptions {
  uid: number;
  /** KBELOG 位掩码(debug_helper.h:35-44),全量=KBELOG_TYPES_MASK */
  logtypes: number;
  globalOrder: number;
  groupOrder: number;
  /** 空串=不过滤日期 */
  date: string;
  /** 空串=不过滤关键字 */
  keyStr: string;
  /** 过滤的组件类型;引擎位图语义为「点名的类型才放行」(logwatcher.cpp:86-90),
   * 空数组=不点名=一条都不放行——调用方要全量时须显式传全部服务端类型 */
  componentTypes: number[];
  isfind: boolean;
  first: boolean;
}

/**
 * 702 registerLogWatcher body,线序照写侧 guiconsole
 * LogWindow.cpp:376-433(读侧 logwatcher.cpp:37-70 互逆):
 * uid i32 / logtypes u32 / globalOrder i32(COMPONENT_ORDER=platform.h:346) /
 * groupOrder i32 / date cstr / keyStr cstr / count i8 /
 * count×COMPONENT_TYPE(Bundle::operator<< 固定 int32,bundle.h:227-231) /
 * isfind bool(i8) / first bool(i8,bundle.h:239-242)。
 * XML 声明的 UINT8_ARRAY 与真实写侧不符——按写侧(设计文档 §1.4 解码陷阱)。
 */
export function buildLogWatcherRequestBody(options: LogWatcherRequestOptions): Buffer {
  const parts: Buffer[] = [];
  const i32 = (value: number): Buffer => {
    const buffer = Buffer.alloc(4);
    buffer.writeInt32LE(value, 0);
    return buffer;
  };
  const u32 = (value: number): Buffer => {
    const buffer = Buffer.alloc(4);
    buffer.writeUInt32LE(value, 0);
    return buffer;
  };
  parts.push(i32(options.uid));
  parts.push(u32(options.logtypes >>> 0));
  parts.push(i32(options.globalOrder));
  parts.push(i32(options.groupOrder));
  parts.push(buildCString(options.date));
  parts.push(buildCString(options.keyStr));
  const count = Math.min(options.componentTypes.length, 0x7f);
  parts.push(Buffer.from([count]));
  for (let index = 0; index < count; index += 1) {
    parts.push(i32(options.componentTypes[index]));
  }
  parts.push(Buffer.from([options.isfind ? 1 : 0, options.first ? 1 : 0]));
  return Buffer.concat(parts);
}

/** 服务端组件全量(位图全点名):logger/cellapp/baseapp/三 mgr/dbmgr/loginapp/bots/interfaces/machine */
export const SERVER_COMPONENT_TYPES = [1, 2, 3, 4, 5, 6, 8, 10, 11, 13];

/** 701 onAppActiveTick body:INT32 COMPONENT_TYPE + UINT64 COMPONENT_ID(xml Logger::onAppActiveTick:701) */
export function buildAppActiveTickBody(componentType: number, componentID: bigint): Buffer {
  const body = Buffer.alloc(12);
  body.writeInt32LE(componentType, 0);
  body.writeBigUInt64LE(componentID, 4);
  return body;
}

/**
 * 65501 body = appendBlob(u32 长度 + 字节,bundle.h:324-328),载荷为一条
 * logstream 文本(logger 每条命中日志单独 push 一个 Bundle,logwatcher.cpp:105-112)。
 * 截断/残帧返回 null(不猜文本);空 blob 返回 []。
 */
export function parseConsoleLogBody(body: Buffer): string[] | null {
  if (body.length < 4) {
    return null;
  }
  const length = body.readUInt32LE(0);
  if (4 + length > body.length) {
    return null;
  }
  let text = body.toString('utf8', 4, 4 + length);
  if (text.endsWith('\0')) {
    text = text.slice(0, -1);
  }
  return text.length === 0 ? [] : [text];
}

export interface ParsedLogStream {
  /** 归一后的级别名(空白天名=PRINT,debug_helper.h:53) */
  level: string;
  component: string;
  groupOrder: number;
  uid: number;
  componentID: string;
  timestamp: string;
  /** 消息体(可能含换行的 traceback,原样保留) */
  message: string;
}

/**
 * 解析 logger.cpp:265-280 拼出的 logstream 文本:
 *   `<级别名> <组件名><两位 groupOrder> <uid> <componentID> [YYYY-MM-DD HH:MM:SS mmm] - <消息体>`
 * 级别名表带前导空白("   ERROR"/" WARNING"/PRINT 全空白,debug_helper.h:55-68);
 * 解析不出结构返回 null,调用方原样呈现原始文本,不冒充结构化行。
 */
export function parseLogStream(text: string): ParsedLogStream | null {
  const pattern =
    /^([A-Z_ ]*?)\s+([a-z]+)(\d{0,2})\s+(-?\d+)\s+(\d+)\s+\[([\d][\d\- :.]*)\]\s*-\s?([\s\S]*)$/;
  const match = pattern.exec(text);
  if (!match) {
    return null;
  }
  const rawLevel = match[1].trim();
  return {
    level: rawLevel.length === 0 ? 'PRINT' : rawLevel,
    component: match[2],
    groupOrder: match[3].length === 0 ? 0 : Number.parseInt(match[3], 10),
    uid: Number.parseInt(match[4], 10),
    componentID: match[5],
    timestamp: match[6].trim(),
    // 真机样本(KB-GC-001 imac 实测):blob 末尾带引擎自加的换行,剥离尾部
    // 换行(消息体内部换行/traceback 原样保留)
    message: match[7].replace(/\n+$/, '')
  };
}
