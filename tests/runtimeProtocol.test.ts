import * as net from 'net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildComponentInfo,
  buildFrame,
  buildProfileRequestBody,
  CELLAPPMGR_QUERY_SPACES_MSG_ID,
  CONSOLE_PROFILE_CB_MSG_ID,
  parseProfileFrame,
  parseSpaceFrame,
  querySpaces,
  startProfileQuery,
  type KBEngineComponentInfo
} from '../src/kbengineProtocol';

const cstring = (value: string): Buffer => Buffer.concat([Buffer.from(value), Buffer.from([0])]);
const u32 = (value: number): Buffer => {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value, 0);
  return buffer;
};
const f32 = (value: number): Buffer => {
  const buffer = Buffer.alloc(4);
  buffer.writeFloatLE(value);
  return buffer;
};

const component: KBEngineComponentInfo = {
  uid: 1,
  username: 'test',
  componentType: 6,
  componentID: 0x11n,
  componentIDEx: 0x11n,
  globalOrderID: 1,
  groupOrderID: 1,
  genuuidSections: 1,
  intaddr: '127.0.0.1',
  intport: 0,
  extaddr: '127.0.0.1',
  extport: 0,
  extaddrEx: '',
  pid: 123,
  cpu: 0,
  mem: 0,
  usedmem: 0,
  state: 1,
  machineID: 1,
  extradata: 0n,
  extradata1: 0n,
  extradata2: 0n,
  extradata3: 0n,
  backaddr: 0,
  backport: 0,
  componentName: 'baseapp',
  fullName: 'baseapp1'
};

let baseServer: net.Server;
let cellServer: net.Server;

beforeAll(async () => {
  baseServer = net.createServer(socket => {
    let first = true;
    socket.on('data', data => {
      if (!first) return;
      first = false;
      const body = Buffer.concat([
        Buffer.from([0]),
        u32(2),
        cstring('main'),
        u32(12), f32(1), f32(2), f32(.5), f32(3)
      ]);
      socket.end(Buffer.concat([
        (() => { const frame = Buffer.alloc(4); frame.writeUInt16LE(CONSOLE_PROFILE_CB_MSG_ID); frame.writeUInt16LE(body.length, 2); return frame; })(),
        body
      ]));
    });
  });
  await new Promise<void>(resolve => baseServer.listen(0, '127.0.0.1', resolve));
  component.intport = (baseServer.address() as net.AddressInfo).port;

  cellServer = net.createServer(socket => {
    let first = true;
    socket.on('data', data => {
      if (!first) return;
      first = false;
      expect(data.readUInt16LE(0)).toBe(CELLAPPMGR_QUERY_SPACES_MSG_ID);
      const payload = Buffer.concat([
        (() => { const b=Buffer.alloc(4); b.writeInt32LE(4); return b; })(),
        (() => { const b=Buffer.alloc(8); b.writeBigUInt64LE(0x44n); return b; })(),
        (() => { const b=Buffer.alloc(8); b.writeBigUInt64LE(0x22n); return b; })(),
        u32(1), u32(7), cstring('maps/world'), cstring('World'), u32(1), u32(99)
      ]);
      const response = buildFrame(CONSOLE_PROFILE_CB_MSG_ID, payload);
      console.log('sending spaces response', response.length);
      socket.end(response);
    });
  });
  await new Promise<void>(resolve => cellServer.listen(0, '127.0.0.1', resolve));
});

afterAll(async () => {
  await new Promise<void>(resolve => baseServer.close(() => resolve()));
  await new Promise<void>(resolve => cellServer.close(() => resolve()));
});

describe('classic KBEngine runtime protocols', () => {
  it('encodes the guiconsole-compatible startProfile request', () => {
    expect([...buildProfileRequestBody({ profileName: 'probe', kind: 'pyprofile', timingLengthSeconds: 3 })])
      .toEqual([...Buffer.concat([cstring('probe'), Buffer.from([0]), u32(3)])]);
  });

  it('queries real profile frames from a baseapp-compatible socket', async () => {
    const results = await startProfileQuery(
      component,
      { profileName: 'probe', kind: 'pyprofile', timingLengthSeconds: 1 },
      500
    );
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      kind: 'pyprofile',
      text: 'main',
      timingLength: 2,
      componentID: 0x11n
    });
  });

  it('parses cellappmgr spaces and cells without synthetic transport data', () => {
    const body = Buffer.concat([
      (() => { const b=Buffer.alloc(4); b.writeInt32LE(4); return b; })(),
      (() => { const b=Buffer.alloc(8); b.writeBigUInt64LE(0x44n); return b; })(),
      (() => { const b=Buffer.alloc(8); b.writeBigUInt64LE(0x22n); return b; })(),
      u32(1), u32(7), cstring('maps/world'), cstring('World'), u32(1), u32(99)
    ]);
    const result = parseSpaceFrame(body);
    expect(result.spaces[0]).toMatchObject({
      cellappID: 0x22n,
      spaceID: 7,
      geomappingPath: 'maps/world',
      scriptModuleName: 'World',
      cells: [99]
    });
  });

  it('queries spaces using the fixed cellappmgr message id', async () => {
    const spacesServer = net.createServer(socket => {
      socket.once('data', data => {
        const payload = Buffer.concat([
          (() => { const b=Buffer.alloc(4); b.writeInt32LE(4); return b; })(),
          (() => { const b=Buffer.alloc(8); b.writeBigUInt64LE(0x44n); return b; })(),
          (() => { const b=Buffer.alloc(8); b.writeBigUInt64LE(0x22n); return b; })(),
          u32(1), u32(7), cstring('maps/world'), cstring('World'), u32(1), u32(99)
        ]);
        socket.end(buildFrame(CONSOLE_PROFILE_CB_MSG_ID, payload));
      });
    });
    await new Promise<void>(resolve => spacesServer.listen(0, '127.0.0.1', resolve));
    const manager = { ...component, componentType: 4, componentID: 0x44n };
    manager.intport = (spacesServer.address() as net.AddressInfo).port;
    try {
      const result = await querySpaces(manager, 1000);
      expect(result.componentID).toBe(0x44n);
      expect(result.spaces[0]).toMatchObject({ spaceID: 7, scriptModuleName: 'World' });
    } finally {
      await new Promise<void>(resolve => spacesServer.close(() => resolve()));
    }
  });
});
