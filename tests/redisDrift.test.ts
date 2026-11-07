import { describe, expect, it, vi } from 'vitest';
import {
  RespDecoder,
  RedisSession,
  RedisProtocolError,
  encodeCommand,
  openRedisSession,
  type RedisSocketLike
} from '../src/redisDrift';

/** 假 socket:记录写入的字节,测试可喂响应字节。 */
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

  private emit(event: string, ...args: never[]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(...args);
    }
  }

  /** 解码写入的 RESP 请求为命令参数数组。 */
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
}

describe('RespDecoder', () => {
  it('解码简单字符串/整数/错误/空 bulk', () => {
    const decoder = new RespDecoder();
    const messages = decoder.push(Buffer.from('+PONG\r\n:42\r\n-ERR boom\r\n$-1\r\n', 'latin1'));
    expect(messages).toEqual([
      { kind: 'simple', value: 'PONG' },
      { kind: 'integer', value: 42 },
      { kind: 'error', value: 'ERR boom' },
      { kind: 'bulk', value: null }
    ]);
  });

  it('解码 bulk 与数组(SCAN 形态)', () => {
    const decoder = new RespDecoder();
    const messages = decoder.push(
      Buffer.from('*2\r\n$1\r\n0\r\n*2\r\n$1\r\na\r\n$1\r\nb\r\n', 'latin1')
    );
    expect(messages).toHaveLength(1);
    const reply = messages[0];
    expect(reply.kind).toBe('array');
    if (reply.kind !== 'array') return;
    expect(reply.value[0]).toEqual({ kind: 'bulk', value: '0' });
    expect(reply.value[1]).toEqual({ kind: 'array', value: [
      { kind: 'bulk', value: 'a' },
      { kind: 'bulk', value: 'b' }
    ] });
  });

  it('跨 chunk 缓冲不完整帧', () => {
    const decoder = new RespDecoder();
    const first = decoder.push(Buffer.from('$5\r\nhel', 'latin1'));
    expect(first).toEqual([]);
    const second = decoder.push(Buffer.from('lo\r\n', 'latin1'));
    expect(second).toEqual([{ kind: 'bulk', value: 'hello' }]);
  });

  it('解码非法前缀抛 RedisProtocolError', () => {
    const decoder = new RespDecoder();
    expect(() => decoder.push(Buffer.from('?wat\r\n', 'latin1'))).toThrow(RedisProtocolError);
  });
});

describe('encodeCommand', () => {
  it('编码数组 bulk 字符串', () => {
    expect(encodeCommand(['PING']).toString('latin1')).toBe('*1\r\n$4\r\nPING\r\n');
    expect(encodeCommand(['SCAN', '0', 'MATCH', 'kbe_*', 'COUNT', '100']).toString('latin1'))
      .toBe('*6\r\n$4\r\nSCAN\r\n$1\r\n0\r\n$5\r\nMATCH\r\n$5\r\nkbe_*\r\n$5\r\nCOUNT\r\n$3\r\n100\r\n');
  });
});

describe('RedisSession', () => {
  it('command 请求-响应:写入命令并消化回复', async () => {
    const socket = new MockSocket();
    const session = new RedisSession(socket, args => socket.write(encodeCommand(args)));
    const promise = session.command('PING');
    expect(socket.requests()).toEqual([['PING']]);
    socket.feed('+PONG\r\n');
    await expect(promise).resolves.toEqual({ kind: 'simple', value: 'PONG' });
  });

  it('服务端 -ERR 拒绝为 RedisProtocolError', async () => {
    const socket = new MockSocket();
    const session = new RedisSession(socket, args => socket.write(encodeCommand(args)));
    const promise = session.command('AUTH', 'bad');
    socket.feed('-ERR invalid password\r\n');
    await expect(promise).rejects.toBeInstanceOf(RedisProtocolError);
  });

  it('scanKeys 解析 SCAN 回复', async () => {
    const socket = new MockSocket();
    const session = new RedisSession(socket, args => socket.write(encodeCommand(args)));
    const promise = session.scanKeys('0', 'kbe_*');
    socket.feed('*2\r\n$1\r\n0\r\n*2\r\n$1\r\na\r\n$1\r\nb\r\n');
    await expect(promise).resolves.toEqual({ cursor: '0', keys: ['a', 'b'] });
  });

  it('hashGetAll 解析 HGETALL 回复', async () => {
    const socket = new MockSocket();
    const session = new RedisSession(socket, args => socket.write(encodeCommand(args)));
    const promise = session.hashGetAll('kbe_entitylog:1:2');
    socket.feed('*4\r\n$1\r\na\r\n$1\r\n1\r\n$1\r\nb\r\n$1\r\n2\r\n');
    await expect(promise).resolves.toEqual({ a: '1', b: '2' });
  });

  it('close 拒绝在途命令', async () => {
    const socket = new MockSocket();
    const session = new RedisSession(socket, args => socket.write(encodeCommand(args)));
    const promise = session.command('PING');
    session.close();
    await expect(promise).rejects.toBeInstanceOf(RedisProtocolError);
  });
});

describe('openRedisSession', () => {
  it('无口令无索引:仅 PING,成功返回会话', async () => {
    const socket = new MockSocket();
    const promise = openRedisSession(
      { host: 'localhost', port: 6379 },
      { socketFactory: () => socket, connectTimeoutMs: 500 }
    );
    socket.feed('+PONG\r\n');
    const session = await promise;
    expect(socket.requests()).toEqual([['PING']]);
    session.close();
  });

  it('有口令有索引:AUTH → SELECT → PING 顺序握手', async () => {
    const socket = new MockSocket();
    const promise = openRedisSession(
      { host: 'localhost', port: 6379, password: 'secret', dbIndex: 2 },
      { socketFactory: () => socket, connectTimeoutMs: 500 }
    );
    // 每步握手命令 await 后才发下一命令;回复须与在途命令配对(真实
    // 请求-响应时序),故每喂一回复让出宏任务,令微任务续接下一命令。
    socket.feed('+OK\r\n');
    await new Promise(resolve => setImmediate(resolve));
    socket.feed('+OK\r\n');
    await new Promise(resolve => setImmediate(resolve));
    socket.feed('+PONG\r\n');
    await promise;
    expect(socket.requests()).toEqual([
      ['AUTH', 'secret'],
      ['SELECT', '2'],
      ['PING']
    ]);
  });

  it('AUTH 失败整体拒绝', async () => {
    const socket = new MockSocket();
    const promise = openRedisSession(
      { host: 'localhost', port: 6379, password: 'wrong' },
      { socketFactory: () => socket, connectTimeoutMs: 500 }
    );
    socket.feed('-ERR invalid password\r\n');
    await expect(promise).rejects.toBeInstanceOf(RedisProtocolError);
  });

  it('连接超时拒绝', async () => {
    vi.useFakeTimers();
    try {
      const socket = new MockSocket();
      const promise = openRedisSession(
        { host: 'localhost', port: 6379 },
        { socketFactory: () => socket, connectTimeoutMs: 50 }
      );
      const assertion = expect(promise).rejects.toBeInstanceOf(RedisProtocolError);
      await vi.advanceTimersByTimeAsync(60);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
