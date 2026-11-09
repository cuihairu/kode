// redisDrift.ts 覆盖收口(测试扇出 2026-11-08):RESP2 解码器边界形态、
// 会话方法错误分支、openRedisSession 缺省端口/缺省 socket 工厂/连接期关闭。
// 全部真实行为:字节手工喂入,断言解码产物与拒绝原因;不发真实网络包
// (defaultSocketFactory 用例连本机必然拒连的端口,属真实网络行为)。

import { describe, expect, it, vi } from 'vitest';
import {
  RespDecoder,
  RedisProtocolError,
  RedisSession,
  encodeCommand,
  openRedisSession,
  type RedisConnectionConfig,
  type RedisSocketFactory,
  type RedisSocketLike
} from '../src/backend/redisDrift';

/** 假 socket:记录写入字节,测试喂响应/触发 error/close。 */
class MockSocket implements RedisSocketLike {
  readonly written: Buffer[] = [];
  private readonly listeners = new Map<string, Array<(...args: never[]) => void>>();

  write(chunk: Buffer): boolean {
    this.written.push(chunk);
    return true;
  }

  end(): void {}

  destroy(): void {}

  on(event: string, listener: (...args: never[]) => void): unknown {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
    return this;
  }

  feed(data: string): void {
    this.emit('data', Buffer.from(data, 'latin1'));
  }

  fail(error: Error): void {
    this.emit('error', error);
  }

  closeEvent(hadError: boolean): void {
    this.emit('close', hadError);
  }

  requests(): string[][] {
    const all = Buffer.concat(this.written).toString('latin1');
    const out: string[][] = [];
    let offset = 0;
    while (offset < all.length) {
      const headerEnd = all.indexOf('\r\n', offset);
      const count = Number(all.slice(offset + 1, headerEnd));
      let cursor = headerEnd + 2;
      const args: string[] = [];
      for (let i = 0; i < count; i += 1) {
        const lenEnd = all.indexOf('\r\n', cursor);
        const len = Number(all.slice(cursor + 1, lenEnd));
        cursor = lenEnd + 2;
        args.push(all.slice(cursor, cursor + len));
        cursor += len + 2;
      }
      out.push(args);
      offset = cursor;
    }
    return out;
  }

  private emit(event: string, ...args: never[]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(...args);
    }
  }
}

const makeSession = (): { session: RedisSession; socket: MockSocket } => {
  const socket = new MockSocket();
  const session = new RedisSession(socket, args => socket.write(encodeCommand(args)));
  return { session, socket };
};

describe('RespDecoder 边界形态(覆盖收口)', () => {
  it('整数载荷非法 → RedisProtocolError', () => {
    const decoder = new RespDecoder();
    expect(() => decoder.push(Buffer.from(':abc\r\n', 'latin1'))).toThrow(RedisProtocolError);
  });

  it('bulk 长度非法 → RedisProtocolError', () => {
    const decoder = new RespDecoder();
    expect(() => decoder.push(Buffer.from('$abc\r\n', 'latin1'))).toThrow(RedisProtocolError);
  });

  it('顶层数组长度非法 → RedisProtocolError', () => {
    const decoder = new RespDecoder();
    expect(() => decoder.push(Buffer.from('*abc\r\n', 'latin1'))).toThrow(RedisProtocolError);
  });

  it('顶层数组 -1(nil)→ 空数组', () => {
    const decoder = new RespDecoder();
    expect(decoder.push(Buffer.from('*-1\r\n', 'latin1'))).toEqual([{ kind: 'array', value: [] }]);
  });

  it('数组元素不完整:整帧保留(consumed=0),补齐后一次解码', () => {
    const decoder = new RespDecoder();
    // 第二个元素是 *1 数组但载荷未到 → decodeArray 返回 consumed=0,本帧不出消息
    expect(decoder.push(Buffer.from('*2\r\n$1\r\na\r\n*1\r\n', 'latin1'))).toEqual([]);
    const done = decoder.push(Buffer.from('$1\r\nb\r\n', 'latin1'));
    expect(done).toHaveLength(1);
    const reply = done[0];
    expect(reply.kind).toBe('array');
    if (reply.kind !== 'array') return;
    expect(reply.value[1].kind).toBe('array');
  });

  it('数组元素恰在缓冲末端(window 空)→ 不完整,补齐后解码', () => {
    const decoder = new RespDecoder();
    expect(decoder.push(Buffer.from('*2\r\n+OK\r\n', 'latin1'))).toEqual([]);
    const done = decoder.push(Buffer.from('+OK\r\n', 'latin1'));
    expect(done).toEqual([
      { kind: 'array', value: [{ kind: 'simple', value: 'OK' }, { kind: 'simple', value: 'OK' }] }
    ]);
  });

  it('数组元素头部无 CRLF → 不完整,补齐后解码', () => {
    const decoder = new RespDecoder();
    expect(decoder.push(Buffer.from('*2\r\n+OK\r\n$5', 'latin1'))).toEqual([]);
    const done = decoder.push(Buffer.from('\r\nhello\r\n', 'latin1'));
    expect(done).toEqual([
      { kind: 'array', value: [{ kind: 'simple', value: 'OK' }, { kind: 'bulk', value: 'hello' }] }
    ]);
  });

  it('数组内 bulk 载荷不完整 → 不完整,补齐后解码', () => {
    const decoder = new RespDecoder();
    expect(decoder.push(Buffer.from('*1\r\n$5\r\nab', 'latin1'))).toEqual([]);
    const done = decoder.push(Buffer.from('cde\r\n', 'latin1'));
    expect(done).toEqual([
      { kind: 'array', value: [{ kind: 'bulk', value: 'abcde' }] }
    ]);
  });

  it('数组内 simple/error/integer/bulk-nil/bulk/嵌套数组 全形态解码', () => {
    const decoder = new RespDecoder();
    const messages = decoder.push(
      Buffer.from(
        '*6\r\n+PONG\r\n-ERR boom\r\n:7\r\n$-1\r\n$5\r\nhello\r\n*1\r\n:1\r\n',
        'latin1'
      )
    );
    expect(messages).toHaveLength(1);
    const reply = messages[0];
    expect(reply.kind).toBe('array');
    if (reply.kind !== 'array') return;
    expect(reply.value).toEqual([
      { kind: 'simple', value: 'PONG' },
      { kind: 'error', value: 'ERR boom' },
      { kind: 'integer', value: 7 },
      { kind: 'bulk', value: null },
      { kind: 'bulk', value: 'hello' },
      { kind: 'array', value: [{ kind: 'integer', value: 1 }] }
    ]);
  });

  it('数组内整数/bulk/数组长度非法 → RedisProtocolError', () => {
    expect(() => new RespDecoder().push(Buffer.from('*2\r\n:abc\r\n', 'latin1'))).toThrow(
      RedisProtocolError
    );
    expect(() => new RespDecoder().push(Buffer.from('*2\r\n$abc\r\n', 'latin1'))).toThrow(
      RedisProtocolError
    );
    expect(() => new RespDecoder().push(Buffer.from('*2\r\n*abc\r\n', 'latin1'))).toThrow(
      RedisProtocolError
    );
  });

  it('数组内未知前缀 → RedisProtocolError', () => {
    expect(() => new RespDecoder().push(Buffer.from('*2\r\n?wat\r\n$1\r\nx\r\n', 'latin1'))).toThrow(
      RedisProtocolError
    );
  });

  it('顶层 bulk:完整 / -1 null / 跨 chunk', () => {
    const full = new RespDecoder();
    expect(full.push(Buffer.from('$5\r\nhello\r\n', 'latin1'))).toEqual([
      { kind: 'bulk', value: 'hello' }
    ]);
    const nil = new RespDecoder();
    expect(nil.push(Buffer.from('$-1\r\n', 'latin1'))).toEqual([{ kind: 'bulk', value: null }]);
    const split = new RespDecoder();
    expect(split.push(Buffer.from('$5\r\nhel', 'latin1'))).toEqual([]);
    expect(split.push(Buffer.from('lo\r\n', 'latin1'))).toEqual([{ kind: 'bulk', value: 'hello' }]);
  });
});

describe('RedisSession 方法错误分支(覆盖收口)', () => {
  it('已关闭会话 command → 拒绝「会话已关闭」', async () => {
    const { session } = makeSession();
    session.close();
    await expect(session.command('PING')).rejects.toThrow('redis 会话已关闭');
  });

  it('在途未决再发命令 → 拒绝「已有在途命令」', async () => {
    const { session } = makeSession();
    const first = session.command('PING');
    await expect(session.command('PING')).rejects.toThrow('已有在途命令');
    // 收尾:喂回复让首条命令落定,避免悬挂
    (session as unknown as { handleData: (chunk: Buffer) => void }).handleData(
      Buffer.from('+PONG\r\n', 'latin1')
    );
    await expect(first).resolves.toEqual({ kind: 'simple', value: 'PONG' });
  });

  it('ping 收到 -ERR → 拒绝(错误直达调用方)', async () => {
    // 注:handleData 对 error-kind 消息先拒绝,方法层「PING 失败」包装为防御死代码。
    const { session, socket } = makeSession();
    const promise = session.ping();
    socket.feed('-ERR busy\r\n');
    await expect(promise).rejects.toBeInstanceOf(RedisProtocolError);
    await expect(promise).rejects.toThrow('ERR busy');
  });

  it('ping 收到非 PONG 简单串 → 「PING 意外回复」', async () => {
    const { session, socket } = makeSession();
    const promise = session.ping();
    socket.feed('+OK\r\n');
    await expect(promise).rejects.toThrow('PING 意外回复: OK');
  });

  it('scanKeys 收到 -ERR → 拒绝(错误直达调用方)', async () => {
    // 注:方法层「SCAN 失败」包装为防御死代码(handleData 已先拒 error-kind)。
    const { session, socket } = makeSession();
    const promise = session.scanKeys('0', 'kbe_*');
    socket.feed('-ERR noauth\r\n');
    await expect(promise).rejects.toThrow('ERR noauth');
  });

  it.each([
    ['非数组回复', '+OK\r\n'],
    ['数组长度 ≠ 2', '*1\r\n$1\r\n0\r\n']
  ])('scanKeys 回复形态非法(%s)→ 拒绝', async (_label, wire) => {
    const { session, socket } = makeSession();
    const promise = session.scanKeys('0', 'kbe_*');
    socket.feed(wire);
    await expect(promise).rejects.toThrow('SCAN 回复形态非法');
  });

  it('scanKeys 成功解析:bulk 游标 + 键数组', async () => {
    const { session, socket } = makeSession();
    const promise = session.scanKeys('0', 'kbe_*');
    socket.feed('*2\r\n$1\r\n3\r\n*2\r\n$1\r\na\r\n$1\r\nb\r\n');
    await expect(promise).resolves.toEqual({ cursor: '3', keys: ['a', 'b'] });
  });

  it('scanKeys 解析回退:整数游标 / 键非数组 → 空键 / null 键过滤', async () => {
    const intCursor = makeSession();
    const p1 = intCursor.session.scanKeys('0', 'kbe_*');
    intCursor.socket.feed('*2\r\n:5\r\n*1\r\n$1\r\nx\r\n');
    await expect(p1).resolves.toEqual({ cursor: '5', keys: ['x'] });

    const keysNotArray = makeSession();
    const p2 = keysNotArray.session.scanKeys('0', 'kbe_*');
    keysNotArray.socket.feed('*2\r\n$1\r\n0\r\n:7\r\n');
    await expect(p2).resolves.toEqual({ cursor: '0', keys: [] });

    const nilKey = makeSession();
    const p3 = nilKey.session.scanKeys('0', 'kbe_*');
    nilKey.socket.feed('*2\r\n$1\r\n0\r\n*2\r\n$-1\r\n$1\r\na\r\n');
    await expect(p3).resolves.toEqual({ cursor: '0', keys: ['a'] });
  });

  it('hashGetAll 收到 -ERR → 拒绝(错误直达调用方)', async () => {
    // 注:方法层「HGETALL 失败」包装为防御死代码(handleData 已先拒 error-kind)。
    const { session, socket } = makeSession();
    const promise = session.hashGetAll('kbe_entitylog:1:2');
    socket.feed('-ERR wrong type\r\n');
    await expect(promise).rejects.toThrow('ERR wrong type');
  });

  it('hashGetAll 非数组回复 → 「回复形态非法」', async () => {
    const { session, socket } = makeSession();
    const promise = session.hashGetAll('kbe_entitylog:1:2');
    socket.feed('+OK\r\n');
    await expect(promise).rejects.toThrow('HGETALL 回复形态非法');
  });

  it('hashGetAll 成功:字段值成对入映射', async () => {
    const { session, socket } = makeSession();
    const promise = session.hashGetAll('kbe_entitylog:1:2');
    socket.feed('*4\r\n$1\r\na\r\n$1\r\n1\r\n$1\r\nb\r\n$1\r\n2\r\n');
    await expect(promise).resolves.toEqual({ a: '1', b: '2' });
  });

  it('hashGetAll 回退:null 字段跳过 / null 值记空串 / 奇数尾忽略', async () => {
    const { session, socket } = makeSession();
    const promise = session.hashGetAll('kbe_entitylog:1:2');
    socket.feed('*5\r\n$-1\r\n$1\r\n1\r\n$1\r\nb\r\n$-1\r\n$1\r\nc\r\n');
    await expect(promise).resolves.toEqual({ b: '' });
  });

  it('typeOf:简单串回类型名;-ERR 拒绝;非简单串回空串', async () => {
    const { session, socket } = makeSession();
    const ok = session.typeOf('kbe_entitylog:1:2');
    socket.feed('+hash\r\n');
    await expect(ok).resolves.toBe('hash');

    const { session: s2, socket: sock2 } = makeSession();
    const err = s2.typeOf('k');
    sock2.feed('-ERR nope\r\n');
    await expect(err).rejects.toThrow('ERR nope');

    const { session: s3, socket: sock3 } = makeSession();
    const odd = s3.typeOf('k');
    sock3.feed(':7\r\n');
    await expect(odd).resolves.toBe('');
  });

  it('解码出错且有在途命令 → 该命令被拒绝', async () => {
    const { session, socket } = makeSession();
    const promise = session.command('PING');
    socket.feed('?wat\r\n');
    await expect(promise).rejects.toBeInstanceOf(RedisProtocolError);
  });

  it('无等待者的消息 → 丢弃不抛', () => {
    const { session, socket } = makeSession();
    expect(() => socket.feed('+PONG\r\n')).not.toThrow();
    void session;
  });

  it('socket error 事件 → 在途命令被拒绝(会话自接线)', async () => {
    const { session, socket } = makeSession();
    const promise = session.command('PING');
    socket.fail(new Error('ECONNRESET'));
    await expect(promise).rejects.toThrow('ECONNRESET');
  });

  it('close 时有在途命令 → 该命令拒绝「会话关闭」', async () => {
    const { session } = makeSession();
    const promise = session.command('PING');
    session.close();
    await expect(promise).rejects.toThrow('redis 会话关闭');
  });
});

describe('openRedisSession 缺省面(覆盖收口)', () => {
  it('port 缺省 6379(factory 收到的连接要素)', async () => {
    let captured: { host: string; port: number } | null = null;
    const socket = new MockSocket();
    const factory: RedisSocketFactory = options => {
      captured = options;
      return socket;
    };
    const promise = openRedisSession({ host: 'localhost' }, { socketFactory: factory, connectTimeoutMs: 500 });
    socket.feed('+PONG\r\n');
    const session = await promise;
    expect(captured).toEqual({ host: 'localhost', port: 6379 });
    expect(socket.requests()).toEqual([['PING']]);
    session.close();
  });

  it('未注入 socketFactory → 走真实 net.connect(本机必拒连端口)', async () => {
    const config: RedisConnectionConfig = { host: '127.0.0.1', port: 1 };
    await expect(openRedisSession(config, { connectTimeoutMs: 5000 })).rejects.toThrow();
  }, 10000);

  it('连接期 socket close(未 settled)→ 拒绝「连接关闭」', async () => {
    const socket = new MockSocket();
    const promise = openRedisSession(
      { host: 'localhost', port: 6379 },
      { socketFactory: () => socket, connectTimeoutMs: 500 }
    );
    socket.closeEvent(false);
    await expect(promise).rejects.toThrow('redis 连接关闭');
  });

  it('握手完成后 socket close → 不影响已就绪会话(finish 已 settled)', async () => {
    const socket = new MockSocket();
    const promise = openRedisSession(
      { host: 'localhost', port: 6379 },
      { socketFactory: () => socket, connectTimeoutMs: 500 }
    );
    socket.feed('+PONG\r\n');
    const session = await promise;
    expect(() => socket.closeEvent(false)).not.toThrow();
    session.close();
  });

  it('握手期错误载荷非 Error → 仍以 Error 拒绝', async () => {
    const socket = new MockSocket();
    const promise = openRedisSession(
      { host: 'localhost', port: 6379, password: 'secret' },
      { socketFactory: () => socket, connectTimeoutMs: 500 }
    );
    // AUTH 在途;error 事件载荷为字符串(非 Error)→ 会话照样拒绝
    socket.fail('boom' as unknown as Error);
    await expect(promise).rejects.toThrow('boom');
  });

  it('dbIndex 非 0 → AUTH → SELECT → PING 三步握手', async () => {
    const socket = new MockSocket();
    const promise = openRedisSession(
      { host: 'localhost', port: 6379, password: 'p', dbIndex: 2 },
      { socketFactory: () => socket, connectTimeoutMs: 500 }
    );
    // 每步 await 落定后才发下一步(请求-响应时序),喂一回复让出宏任务。
    socket.feed('+OK\r\n');
    await new Promise(resolve => setImmediate(resolve));
    socket.feed('+OK\r\n');
    await new Promise(resolve => setImmediate(resolve));
    socket.feed('+PONG\r\n');
    const session = await promise;
    expect(socket.requests()).toEqual([['AUTH', 'p'], ['SELECT', '2'], ['PING']]);
    session.close();
  });

  it('连接超时拒绝;迟到数据不二次 finish(settled 早退)', async () => {
    vi.useFakeTimers();
    try {
      const socket = new MockSocket();
      const promise = openRedisSession(
        { host: 'localhost', port: 6379 },
        { socketFactory: () => socket, connectTimeoutMs: 50 }
      );
      const assertion = expect(promise).rejects.toThrow('redis 连接超时');
      await vi.advanceTimersByTimeAsync(60);
      // 超时后迟到的 PONG:PING 落定 → 握手继续 → finish 已 settled → 早退
      socket.feed('+PONG\r\n');
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
