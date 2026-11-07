import { describe, expect, it } from 'vitest';
import {
  CONSOLE_LOG_MSG_ID,
  KBELOG_TYPES_MASK,
  LOGGER_APP_ACTIVE_TICK_MSG_ID,
  LOGGER_DEREGISTER_LOG_WATCHER_MSG_ID,
  LOGGER_REGISTER_LOG_WATCHER_MSG_ID,
  buildAppActiveTickBody,
  buildFrame,
  buildFixedFrame,
  buildLogWatcherRequestBody,
  kbelogLevelBit,
  parseConsoleLogBody,
  parseLogStream
} from '../src/kbengineProtocol';
import {
  CONSOLE_PROTOCOL_AUDIT,
  CONSOLE_PROTOCOL_AUDIT_VERSION,
  verifyConsoleProtocolAgainstAudit
} from '../src/watcherProtocolAudit';

// guiconsole console 链路期一(KB-GC-001)协议面:
// 注册 702 / 注销 703 / 日志回执 65501 / logger 心跳 701 的帧构造与解析。
// 线序依据(引擎树 kode 仓 ../kbengine @3082ab5,逐字段引证):
// - 写侧 = guiconsole LogWindow.cpp:376-433(uid i32 → logtypes u32 →
//   globalOrder i32(COMPONENT_ORDER=int32,platform.h:346)→ groupOrder i32 →
//   date cstr → keyStr cstr → count i8 → count×COMPONENT_TYPE
//   (Bundle::operator<< 固定 int32,bundle.h:227-231)→ isfind bool i8 →
//   first bool i8(bundle.h:239-242));
// - 读侧 = logger logwatcher.cpp:37-70(updateSetting + isfind),与写侧互逆;
// - 65501 body = appendBlob(u32 长度 + 字节,bundle.h:324-328),载荷是
//   logger.cpp:265-280 拼出的 logstream 文本(级别名/组件名/uid/componentID/
//   [YYYY-MM-DD HH:MM:SS mmm] - 消息体,级别名表 debug_helper.h:55-68)。

const i32 = (value: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeInt32LE(value, 0);
  return b;
};

const u32 = (value: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(value, 0);
  return b;
};

const cstr = (value: string): Buffer => Buffer.concat([Buffer.from(value, 'utf8'), Buffer.from([0])]);

describe('console protocol message ids (audit-locked)', () => {
  it('carries the engine-cited constants', () => {
    expect(LOGGER_REGISTER_LOG_WATCHER_MSG_ID).toBe(702);
    expect(LOGGER_DEREGISTER_LOG_WATCHER_MSG_ID).toBe(703);
    expect(LOGGER_APP_ACTIVE_TICK_MSG_ID).toBe(701);
    expect(CONSOLE_LOG_MSG_ID).toBe(65501);
    // KBELOG_TYPES 并集(debug_helper.h:46-47):12 个位全录
    expect(KBELOG_TYPES_MASK).toBe(0x7ff);
  });

  it('locks production constants to the audit table', () => {
    const verdict = verifyConsoleProtocolAgainstAudit();
    expect(verdict.ok).toBe(true);
    expect(CONSOLE_PROTOCOL_AUDIT.registerLogWatcher.requestMsgId).toBe(702);
    expect(CONSOLE_PROTOCOL_AUDIT.registerLogWatcher.requestSource).toContain('messages_fixed_defaults.xml');
    expect(CONSOLE_PROTOCOL_AUDIT.consoleLog.msgId).toBe(65501);
    expect(CONSOLE_PROTOCOL_AUDIT.consoleLog.source).toContain('console_helper.h');
    expect(CONSOLE_PROTOCOL_AUDIT_VERSION.commit.length).toBeGreaterThan(0);
  });

  it('reports a mismatch when a constant drifts', () => {
    const fake = {
      ...CONSOLE_PROTOCOL_AUDIT,
      registerLogWatcher: { ...CONSOLE_PROTOCOL_AUDIT.registerLogWatcher, requestMsgId: 712 }
    };
    const verdict = verifyConsoleProtocolAgainstAudit(fake);
    expect(verdict.ok).toBe(false);
    expect(verdict.mismatches.join('\n')).toContain('registerLogWatcher');
  });
});

describe('buildLogWatcherRequestBody (702 wire order)', () => {
  it('serializes the guiconsole field order with component types as int32', () => {
    const body = buildLogWatcherRequestBody({
      uid: 1000,
      logtypes: KBELOG_TYPES_MASK,
      globalOrder: 0,
      groupOrder: 0,
      date: '',
      keyStr: '',
      componentTypes: [5, 6],
      isfind: false,
      first: true
    });

    let offset = 0;
    expect(body.readInt32LE(offset)).toBe(1000);
    offset += 4;
    expect(body.readUInt32LE(offset)).toBe(0x7ff);
    offset += 4;
    expect(body.readInt32LE(offset)).toBe(0);
    offset += 4;
    expect(body.readInt32LE(offset)).toBe(0);
    offset += 4;
    expect(body[offset]).toBe(0); // date ''
    offset += 1;
    expect(body[offset]).toBe(0); // keyStr ''
    offset += 1;
    expect(body.readInt8(offset)).toBe(2); // count
    offset += 1;
    expect(body.readInt32LE(offset)).toBe(5);
    offset += 4;
    expect(body.readInt32LE(offset)).toBe(6);
    offset += 4;
    expect(body[offset]).toBe(0); // isfind
    offset += 1;
    expect(body[offset]).toBe(1); // first
    expect(offset + 1).toBe(body.length);
  });

  it('writes date/keyStr as cstrings and all-component bitmap when no filter', () => {
    const body = buildLogWatcherRequestBody({
      uid: 1001,
      logtypes: 2,
      globalOrder: 3,
      groupOrder: 4,
      date: '2026-11-07',
      keyStr: 'Traceback',
      componentTypes: [],
      isfind: true,
      first: false
    });
    const expected = Buffer.concat([
      i32(1001),
      u32(2),
      i32(3),
      i32(4),
      cstr('2026-11-07'),
      cstr('Traceback'),
      Buffer.from([0]),
      Buffer.from([1, 0])
    ]);
    expect(body.equals(expected)).toBe(true);
  });

  it('round-trips against the engine reader semantics (logwatcher.cpp:37-70)', () => {
    // 逐字段消费顺序与 logger 侧 updateSetting+createFromStream 一致:
    // uid/logtypes/globalOrder/groupOrder/date/keyStr/count/types/isfind。
    const body = buildLogWatcherRequestBody({
      uid: -1,
      logtypes: 0x7ff,
      globalOrder: 0,
      groupOrder: 0,
      date: '',
      keyStr: 'foo',
      componentTypes: [1, 2, 3, 4, 5, 6, 10, 11, 13],
      isfind: false,
      first: false
    });
    let offset = 0;
    const uid = body.readInt32LE(offset); offset += 4;
    const logtypes = body.readUInt32LE(offset); offset += 4;
    const globalOrder = body.readInt32LE(offset); offset += 4;
    const groupOrder = body.readInt32LE(offset); offset += 4;
    const readCstr = (): string => {
      const start = offset;
      while (body[offset] !== 0) offset += 1;
      const value = body.toString('utf8', start, offset);
      offset += 1;
      return value;
    };
    const date = readCstr();
    const keyStr = readCstr();
    const count = body.readInt8(offset); offset += 1;
    const types: number[] = [];
    for (let i = 0; i < count; i += 1) {
      types.push(body.readInt32LE(offset));
      offset += 4;
    }
    const isfind = body.readInt8(offset) !== 0;
    offset += 1;

    expect(uid).toBe(-1);
    expect(logtypes).toBe(0x7ff);
    expect(globalOrder).toBe(0);
    expect(groupOrder).toBe(0);
    expect(date).toBe('');
    expect(keyStr).toBe('foo');
    expect(types).toEqual([1, 2, 3, 4, 5, 6, 10, 11, 13]);
    expect(isfind).toBe(false);
    expect(offset + 1).toBe(body.length); // first 尾字节
  });

  it('embeds into a buildFrame message with id 702', () => {
    const body = buildLogWatcherRequestBody({
      uid: 0, logtypes: 0x7ff, globalOrder: 0, groupOrder: 0,
      date: '', keyStr: '', componentTypes: [10], isfind: false, first: true
    });
    const frame = buildFrame(LOGGER_REGISTER_LOG_WATCHER_MSG_ID, body);
    expect(frame.readUInt16LE(0)).toBe(702);
    expect(frame.readUInt16LE(2)).toBe(body.length);
  });
});

describe('buildAppActiveTickBody (701)', () => {
  it('serializes CONSOLE_TYPE + component id (xml Logger::onAppActiveTick:701)', () => {
    expect(buildAppActiveTickBody(9, 123456789n)).toEqual(
      Buffer.concat([i32(9), (() => { const b = Buffer.alloc(8); b.writeBigUInt64LE(123456789n, 0); return b; })()])
    );
  });

  it('701 frame is fixed-length (no length field), unlike 702 variable', () => {
    const body = buildAppActiveTickBody(9, 0n);
    const fixed = buildFixedFrame(LOGGER_APP_ACTIVE_TICK_MSG_ID, body);
    // 定长帧 = 2 字节消息号 + body,无长度字段;误用 buildFrame 会多塞 2 字节长度致引擎错位
    expect(fixed.length).toBe(2 + body.length);
    expect(fixed.readUInt16LE(0)).toBe(LOGGER_APP_ACTIVE_TICK_MSG_ID);
    expect(fixed.readInt32LE(2)).toBe(9);
    // 对照:702 是 NETWORK_VARIABLE_MESSAGE,带长度字段(4 字节头)
    const regBody = buildLogWatcherRequestBody({
      uid: 1000, logTypes: 0, globalOrder: 0, groupOrder: 0,
      date: '2026-11-07', keyStr: '', componentTypes: [1], isfind: false, first: true
    });
    const variable = buildFrame(LOGGER_REGISTER_LOG_WATCHER_MSG_ID, regBody);
    expect(variable.readUInt16LE(0)).toBe(LOGGER_REGISTER_LOG_WATCHER_MSG_ID);
    expect(variable.readUInt16LE(2)).toBe(regBody.length);
  });
});

describe('parseConsoleLogBody (65501 blob)', () => {
  it('reads the u32-length blob payload', () => {
    const text = '   ERROR cellapp01 1000 7129652375332859799 [2026-11-07 16:30:00 123] - boom';
    const inner = Buffer.from(text, 'utf8');
    const body = Buffer.alloc(4 + inner.length);
    body.writeUInt32LE(inner.length, 0);
    inner.copy(body, 4);
    expect(parseConsoleLogBody(body)).toEqual([text]);
  });

  it('tolerates a NUL-terminated payload and empty payload', () => {
    const inner = Buffer.concat([Buffer.from('hello', 'utf8'), Buffer.from([0])]);
    const body = Buffer.alloc(4 + inner.length);
    body.writeUInt32LE(inner.length, 0);
    inner.copy(body, 4);
    expect(parseConsoleLogBody(body)).toEqual(['hello']);

    const empty = Buffer.alloc(4);
    empty.writeUInt32LE(0, 0);
    expect(parseConsoleLogBody(empty)).toEqual([]);
  });

  it('returns null on truncated length header instead of inventing text', () => {
    expect(parseConsoleLogBody(Buffer.from([2, 0, 0]))).toBeNull();
  });
});

describe('parseLogStream (logger.cpp:265-280 format)', () => {
  it('parses a real engine error line with traceback body', () => {
    const line = '   ERROR cellapp01 1000 7129652375332859799 [2026-11-07 16:30:00 123] - Traceback (most recent call last):\n  File "scripts/cell/Avatar.py", line 21, in onTimer';
    const parsed = parseLogStream(line);
    expect(parsed).not.toBeNull();
    expect(parsed!.level).toBe('ERROR');
    expect(parsed!.component).toBe('cellapp');
    expect(parsed!.groupOrder).toBe(1);
    expect(parsed!.uid).toBe(1000);
    expect(parsed!.componentID).toBe('7129652375332859799');
    expect(parsed!.timestamp).toBe('2026-11-07 16:30:00 123');
    expect(parsed!.message.startsWith('Traceback (most recent call last):')).toBe(true);
    expect(parsed!.message).toContain('"scripts/cell/Avatar.py", line 21');
    expect(kbelogLevelBit('ERROR')).toBe(0x02);
  });

  it('parses warning / script-error / info / print levels', () => {
    const warning = parseLogStream(' WARNING baseapp00 1000 111 [2026-11-07 16:30:01 4] - slow op');
    expect(warning!.level).toBe('WARNING');
    expect(warning!.component).toBe('baseapp');
    const sErr = parseLogStream('   S_ERR cellapp01 1000 222 [2026-11-07 16:30:02 5] - script boom');
    expect(sErr!.level).toBe('S_ERR');
    expect(kbelogLevelBit('S_ERR')).toBe(0x80);
    const info = parseLogStream('    INFO logger00 1000 333 [2026-11-07 16:30:03 6] - rotated');
    expect(info!.level).toBe('INFO');
    // PRINT 的级别名是全空白(debug_helper.h:53),解析为 PRINT 不冒充 UNKNOWN
    const print = parseLogStream('         machine00 1000 444 [2026-11-07 16:30:04 7] - stdout line');
    expect(print!.level).toBe('PRINT');
  });

  it('returns null for non-logstream text (raw passthrough stays honest)', () => {
    expect(parseLogStream('plain output without the engine log shape')).toBeNull();
    expect(parseLogStream('')).toBeNull();
  });

  it('accepts multi-digit group orders and negative uid', () => {
    const parsed = parseLogStream('    INFO cellapp12 -1 999 [2026-11-07 09:00:00 0] - hi');
    expect(parsed!.component).toBe('cellapp');
    expect(parsed!.groupOrder).toBe(12);
    expect(parsed!.uid).toBe(-1);
  });
});
