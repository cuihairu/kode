import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
  COMPONENT_NAMES,
  CONSOLE_WATCHER_CB_MSG_ID,
  MACHINE_BROADCAST_PORT,
  bigIntToNumber,
  buildCString,
  buildFrame,
  parseComponentInfo,
  parseWatcherFrame,
  swapUint16,
  toIPv4
} from '../src/kbengineProtocol';
import { resolveEngineRoot } from './helpers/engineRoot';

// 构造与 parseComponentInfo 读取序逐字段对齐的广播包。
// 端口按网络序(大端)写入——实现端 swapUint16(readUInt16LE) 还原。
function buildComponentPacket(fields: {
  uid?: number;
  username?: string;
  componentType?: number;
  componentID?: bigint;
  intaddr?: [number, number, number, number];
  intport?: number;
  extaddrEx?: string;
  state?: number;
  groupOrderID?: number;
}): Buffer {
  const chunks: Buffer[] = [];
  const push = (fn: () => void) => {
    const b = Buffer.alloc(8);
    const written = fn.call(null, b) ?? b;
    chunks.push(written);
  };
  const le32 = (value: number) => {
    const b = Buffer.alloc(4);
    b.writeInt32LE(value, 0);
    chunks.push(b);
  };
  const u64 = (value: bigint) => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(value, 0);
    chunks.push(b);
  };

  le32(fields.uid ?? 1001);
  chunks.push(buildCString(fields.username ?? 'cui'));
  le32(fields.componentType ?? 5);
  u64(fields.componentID ?? 9007199254740993n);
  u64(0n);
  le32(1); // globalOrderID
  le32(fields.groupOrderID ?? 0);
  le32(0); // genuuidSections
  chunks.push(Buffer.from(fields.intaddr ?? [192, 168, 1, 10]));
  const portBE = Buffer.alloc(2);
  portBE.writeUInt16BE(fields.intport ?? MACHINE_BROADCAST_PORT, 0);
  chunks.push(portBE);
  chunks.push(Buffer.from([10, 0, 0, 1])); // extaddr
  const extPortBE = Buffer.alloc(2);
  extPortBE.writeUInt16BE(20040, 0);
  chunks.push(extPortBE);
  chunks.push(buildCString(fields.extaddrEx ?? 'kb.local'));
  const u32 = (value: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(value >>> 0, 0);
    chunks.push(b);
  };
  u32(4242); // pid
  const float = (value: number) => {
    const b = Buffer.alloc(4);
    b.writeFloatLE(value, 0);
    chunks.push(b);
  };
  float(0.5); // cpu
  float(1.5); // mem
  u32(2048); // usedmem
  const state = Buffer.alloc(1);
  state.writeInt8(fields.state ?? 1, 0);
  chunks.push(state);
  u32(7); // machineID
  u64(0n);
  u64(0n);
  u64(0n);
  u64(0n);
  u32(3232235777); // backaddr
  const portLE = Buffer.alloc(2);
  portLE.writeUInt16LE(20086, 0);
  chunks.push(portLE);

  return Buffer.concat(chunks);
}

describe('protocol byte helpers', () => {
  it('swaps uint16 endianness involutionally', () => {
    expect(swapUint16(0x1234)).toBe(0x3412);
    expect(swapUint16(swapUint16(0xabcd))).toBe(0xabcd);
  });

  it('formats ipv4 and clamps bigint to MAX_SAFE_INTEGER', () => {
    expect(toIPv4(Buffer.from([192, 168, 1, 10]))).toBe('192.168.1.10');
    expect(bigIntToNumber(42n)).toBe(42);
    expect(bigIntToNumber(9007199254740993n)).toBe(9007199254740991);
  });

  it('builds cstrings and length-prefixed frames', () => {
    expect(buildCString('hi')).toEqual(Buffer.from([0x68, 0x69, 0x00]));
    expect(buildCString('')).toEqual(Buffer.from([0x00]));

    const frame = buildFrame(65502, Buffer.from([0x01, 0x02]));
    expect(frame.length).toBe(6);
    expect(frame.readUInt16LE(0)).toBe(65502);
    expect(frame.readUInt16LE(2)).toBe(2);
    expect(frame[4]).toBe(0x01);
  });
});

describe('parseComponentInfo', () => {
  it('decodes every broadcast field of a cellapp packet', () => {
    const info = parseComponentInfo(buildComponentPacket({ groupOrderID: 3 }));

    expect(info.uid).toBe(1001);
    expect(info.username).toBe('cui');
    expect(info.componentType).toBe(5);
    // uint64 以 bigint 无损保留(超出 Number.MAX_SAFE_INTEGER)
    expect(info.componentID).toBe(9007199254740993n);
    expect(info.globalOrderID).toBe(1);
    expect(info.groupOrderID).toBe(3);
    expect(info.intaddr).toBe('192.168.1.10');
    expect(info.intport).toBe(20086);
    expect(info.extaddr).toBe('10.0.0.1');
    expect(info.extport).toBe(20040);
    expect(info.extaddrEx).toBe('kb.local');
    expect(info.pid).toBe(4242);
    expect(info.cpu).toBeCloseTo(0.5);
    expect(info.mem).toBeCloseTo(1.5);
    expect(info.usedmem).toBe(2048);
    expect(info.state).toBe(1);
    expect(info.machineID).toBe(7);
    expect(info.backaddr).toBe(3232235777);
    expect(info.backport).toBe(20086);
  });

  it('names components by type and appends group order for cellapp/baseapp', () => {
    const cellapp = parseComponentInfo(buildComponentPacket({ componentType: 5, groupOrderID: 2 }));
    expect(cellapp.componentName).toBe('cellapp');
    expect(cellapp.fullName).toBe('cellapp2');

    const baseapp = parseComponentInfo(buildComponentPacket({ componentType: 6, groupOrderID: 1 }));
    expect(baseapp.fullName).toBe('baseapp1');

    const dbmgr = parseComponentInfo(buildComponentPacket({ componentType: 1, groupOrderID: 4 }));
    expect(dbmgr.fullName).toBe('dbmgr');

    // 未收录类型回退到 component_<n>
    const custom = parseComponentInfo(buildComponentPacket({ componentType: 99 }));
    expect(custom.componentName).toBe('component_99');
  });
});

describe('parseWatcherFrame', () => {
  it('decodes a tree-style frame with mixed value types', () => {
    const chunks = [Buffer.from([0])]; // type 0: 展开条目

    const entry = (watcherPath: string, name: string, valueType: number, value: Buffer) =>
      Buffer.concat([
        buildCString(watcherPath),
        buildCString(name),
        (() => {
          const b = Buffer.alloc(2);
          b.writeUInt16LE(1, 0);
          return b;
        })(),
        Buffer.from([valueType]),
        value
      ]);

    const str = Buffer.alloc(8);
    str.writeUInt32LE(4, 0); // 字符串长度前缀(引擎 stream 写法外的既有实现按 CString 读,占位长度不参与)
    chunks.push(
      entry('cellapp/1', 'load', 12, buildCString('0.35')),
      entry('cellapp/1', 'entities', 1, Buffer.from([0xc8])),
      entry('cellapp/1', 'online', 13, Buffer.from([1])),
      entry('cellapp/1', 'uptime', 10, (() => {
        const b = Buffer.alloc(8);
        b.writeDoubleLE(12.5, 0);
        return b;
      })())
    );

    const result = parseWatcherFrame(Buffer.concat(chunks));

    expect(result.type).toBe(0);
    // path 为最后一条展开条目的路径
    expect(result.path).toBe('cellapp/1');
    expect(result.values['load']).toBe('0.35');
    expect(result.values['entities']).toBe(200);
    expect(result.values['online']).toBe(true);
    expect(result.values['uptime']).toBe(12.5);
  });

  it('keeps explicit paths verbatim and only empties the whole-tree root', () => {
    // 既有实现语义:rootPath 为 '/'(整棵 watcher 树)时置空;具体路径原样保留。
    const body = Buffer.concat([
      Buffer.from([2]), // type != 0
      buildCString('/stats'),
      buildCString('fps'),
      buildCString('entities')
    ]);

    const result = parseWatcherFrame(body);

    expect(result.type).toBe(2);
    expect(result.path).toBe('/stats');
    expect(result.keys).toEqual(['fps', 'entities']);

    const wholeTree = parseWatcherFrame(
      Buffer.concat([Buffer.from([2]), buildCString('/'), buildCString('fps')])
    );
    expect(wholeTree.path).toBe('');
    expect(wholeTree.keys).toEqual(['fps']);
  });

  it('throws on unsupported watcher value types', () => {
    const body = Buffer.concat([
      Buffer.from([0]),
      buildCString('p'),
      buildCString('n'),
      Buffer.from([0x01, 0x00]),
      Buffer.from([99])
    ]);

    expect(() => parseWatcherFrame(body)).toThrow(/Unsupported watcher value type: 99/);
  });
});

const engineRoot = resolveEngineRoot();

describe.skipIf(!engineRoot)('protocol constants vs engine source', () => {
  if (!engineRoot) {
    return; // skipIf 不阻止 describe 回调体的注册期执行
  }

  const commonHeader = path.join(engineRoot, 'kbe', 'src', 'lib', 'common', 'common.h');
  const networkCommon = path.join(engineRoot, 'kbe', 'src', 'lib', 'network', 'common.h');
  const consoleHelper = path.join(engineRoot, 'kbe', 'src', 'lib', 'helper', 'console_helper.h');

  it('aligns COMPONENT_NAMES with the engine COMPONENT_TYPE enum order', () => {
    const source = fs.readFileSync(commonHeader, 'utf8');
    const enumNames = [
      'UNKNOWN_COMPONENT_TYPE',
      'DBMGR_TYPE',
      'LOGINAPP_TYPE',
      'BASEAPPMGR_TYPE',
      'CELLAPPMGR_TYPE',
      'CELLAPP_TYPE',
      'BASEAPP_TYPE',
      'CLIENT_TYPE',
      'MACHINE_TYPE',
      'CONSOLE_TYPE',
      'LOGGER_TYPE',
      'BOTS_TYPE',
      'WATCHER_TYPE',
      'INTERFACES_TYPE',
      'TOOL_TYPE'
    ];

    enumNames.forEach((enumName, index) => {
      const literal = new RegExp(`^\\s*${enumName}\\s*=\\s*${index}\\b`, 'm');
      expect(source, `${enumName} = ${index}`).toMatch(literal);
      expect(COMPONENT_NAMES[index], `index ${index}`).toBe(
        enumName.replace('_TYPE', '').replace('UNKNOWN_COMPONENT', 'unknown').replace(/^/, '')
          .toLowerCase()
      );
    });
  });

  it('matches the machine broadcast port and watcher callback msg id', () => {
    const networkSource = fs.readFileSync(networkCommon, 'utf8');
    expect(networkSource).toMatch(/^#define KBE_PORT_START\s+20000\b/m);
    expect(networkSource).toMatch(
      /^#define KBE_MACHINE_BROADCAST_SEND_PORT\s+KBE_PORT_START \+ 86\b/m
    );
    expect(MACHINE_BROADCAST_PORT).toBe(20086);

    const helperSource = fs.readFileSync(consoleHelper, 'utf8');
    expect(helperSource).toMatch(/^#define CONSOLE_WATCHERCB_MSGID\s+65502\b/m);
    expect(CONSOLE_WATCHER_CB_MSG_ID).toBe(65502);
  });
});
