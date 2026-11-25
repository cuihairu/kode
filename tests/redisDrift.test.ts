import * as net from 'net';
import { describe, expect, it } from 'vitest';
import { openRedisSession, type RedisConnectionConfig } from '../src/backend/redisDrift';

/**
 * The session under test rides the ioredis library (KODE-REDIS-LIB-001), so
 * the tests drive a fake redis wire server over a real TCP socket: the
 * library's actual codec decodes every reply and every command echo is read
 * back off the wire. The parser below is a TEST fixture only (it reassembles
 * what the library under test sends); production keeps zero hand-written
 * wire code.
 */

/** Reassembles complete wire commands out of a byte stream. */
class RequestReader {
  private buffer = Buffer.alloc(0);

  push(chunk: Buffer): string[][] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const out: string[][] = [];
    for (;;) {
      const command = this.tryRead();
      if (command === null) {
        break;
      }
      out.push(command);
    }
    return out;
  }

  private tryRead(): string[] | null {
    const headerEnd = this.buffer.indexOf('\r\n');
    if (headerEnd === -1) {
      return null;
    }
    const count = Number(this.buffer.subarray(1, headerEnd).toString('latin1'));
    if (!Number.isFinite(count)) {
      return null;
    }
    let offset = headerEnd + 2;
    const args: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const lenEnd = this.buffer.indexOf('\r\n', offset);
      if (lenEnd === -1) {
        return null;
      }
      const len = Number(this.buffer.subarray(offset + 1, lenEnd).toString('latin1'));
      const total = lenEnd + 2 + len + 2;
      if (this.buffer.length < total) {
        return null;
      }
      args.push(this.buffer.subarray(lenEnd + 2, lenEnd + 2 + len).toString('utf8'));
      offset = total;
    }
    this.buffer = this.buffer.subarray(offset);
    return args;
  }
}

/** Handler for one command (name matched case-insensitively); returns the raw reply bytes to write (empty string = stay silent). */
type FakeHandler = (args: string[], socket: net.Socket) => string | Buffer | void;

interface FakeRedis {
  port: number;
  /** Every command the client sent, in arrival order (args[0] kept as sent). */
  requests(): string[][];
  close(): Promise<void>;
}

async function startFakeRedis(handlers: Record<string, FakeHandler> = {}): Promise<FakeRedis> {
  const received: string[][] = [];
  const open: net.Socket[] = [];
  const server = net.createServer(socket => {
    open.push(socket);
    const reader = new RequestReader();
    socket.on('data', chunk => {
      for (const args of reader.push(chunk)) {
        received.push(args);
        const handler = handlers[args[0].toLowerCase()];
        const reply = handler ? handler(args.slice(1), socket) : '-ERR unknown command\r\n';
        if (typeof reply === 'string') {
          if (reply.length > 0) {
            socket.write(Buffer.from(reply, 'latin1'));
          }
        } else if (reply instanceof Buffer) {
          socket.write(reply);
        }
      }
    });
  });
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port));
  });
  return {
    port,
    requests: () => received,
    close: () =>
      new Promise(resolve => {
        for (const socket of open) {
          socket.destroy();
        }
        server.close(() => resolve());
      })
  };
}

/**
 * The replies a happy handshake needs. ioredis probes more than the surface's
 * own commands: CLIENT SETINFO (library name/version, sent twice) and an INFO
 * ready check both precede the session's PING.
 */
const openHandshake = (): Record<string, FakeHandler> => ({
  client: () => '+OK\r\n',
  info: () => '$15\r\nredis_version:7\r\n',
  auth: () => '+OK\r\n',
  select: () => '+OK\r\n',
  ping: () => '+PONG\r\n'
});

/** Collapses each CLIENT SETINFO probe to its fixed first three args, so the pinned wire order stays version-proof (LIB-NAME/LIB-VER values carry the library version). */
const collapseSetInfo = (requests: string[][]): (string | number)[][] =>
  requests.map(args => (args[0].toLowerCase() === 'client' ? args.slice(0, 3) : args));

/** Drops the library's own handshake probes (CLIENT SETINFO, INFO ready check), leaving the drift surface's own commands. */
const driftCommands = (fake: FakeRedis): string[][] =>
  fake.requests().filter(args => {
    const name = args[0].toLowerCase();
    return name !== 'client' && name !== 'info';
  });

/** Opens a session on a fake server with the happy handshake preloaded. */
async function openOn(
  handlers: Record<string, FakeHandler>,
  config: Partial<RedisConnectionConfig> = {}
): Promise<{ fake: FakeRedis; session: Awaited<ReturnType<typeof openRedisSession>> }> {
  const fake = await startFakeRedis({ ...openHandshake(), ...handlers });
  const session = await openRedisSession(
    { host: '127.0.0.1', port: fake.port, ...config },
    { connectTimeoutMs: 2000 }
  );
  return { fake, session };
}

describe('openRedisSession handshake', () => {
  it('sends AUTH -> SELECT -> PING in order when password and db index are set', async () => {
    const { fake, session } = await openOn({}, { password: 'secret', dbIndex: 2 });
    try {
      // pinned wire order: the library's own probes (SETINFO, INFO ready
      // check) ride between SELECT and the surface's PING
      // ioredis writes command names in lowercase; SETINFO's subcommand
      // literals stay as the library passes them
      expect(collapseSetInfo(fake.requests())).toEqual([
        ['auth', 'secret'],
        ['select', '2'],
        ['client', 'SETINFO', 'LIB-NAME'],
        ['client', 'SETINFO', 'LIB-VER'],
        ['info'],
        ['ping']
      ]);
      await expect(session.ping()).resolves.toBeUndefined();
    } finally {
      session.close();
      await fake.close();
    }
  });

  it('skips AUTH when no password is configured and SELECT when the db index is 0', async () => {
    const { fake, session } = await openOn({});
    try {
      expect(driftCommands(fake)).toEqual([['ping']]);
    } finally {
      session.close();
      await fake.close();
    }

    const withPassword = await openOn({}, { password: 'secret', dbIndex: 0 });
    try {
      expect(driftCommands(withPassword.fake)).toEqual([['auth', 'secret'], ['ping']]);
    } finally {
      withPassword.session.close();
      await withPassword.fake.close();
    }
  });

  it('surfaces a server auth rejection', async () => {
    const fake = await startFakeRedis({
      ...openHandshake(),
      auth: () => '-ERR invalid password\r\n'
    });
    try {
      await expect(
        openRedisSession(
          { host: '127.0.0.1', port: fake.port, password: 'wrong' },
          { connectTimeoutMs: 2000 }
        )
      ).rejects.toThrow(/invalid password/);
    } finally {
      await fake.close();
    }
  });

  it('rejects when nothing listens on the port', async () => {
    await expect(
      openRedisSession({ host: '127.0.0.1', port: 1 }, { connectTimeoutMs: 2000 })
    ).rejects.toThrow();
  });

  it('rejects when the server drops the socket mid-handshake', async () => {
    const fake = await startFakeRedis({
      auth: (_args, socket) => {
        socket.destroy();
        return '';
      }
    });
    try {
      await expect(
        openRedisSession(
          { host: '127.0.0.1', port: fake.port, password: 'secret' },
          { connectTimeoutMs: 2000 }
        )
      ).rejects.toThrow();
    } finally {
      await fake.close();
    }
  });

  it('rejects with the timeout message when the server accepts but never answers', async () => {
    // happy path except PING: the server accepts, reads the command, stays silent
    const fake = await startFakeRedis({ ...openHandshake(), ping: () => '' });
    try {
      const started = Date.now();
      await expect(
        openRedisSession({ host: '127.0.0.1', port: fake.port }, { connectTimeoutMs: 300 })
      ).rejects.toThrow(/redis 连接超时/);
      expect(Date.now() - started).toBeLessThan(5000);
      expect(fake.requests().at(-1)).toEqual(['ping']);
    } finally {
      await fake.close();
    }
  });
});

describe('RedisSession read-only commands', () => {
  it('scanKeys resolves one page and keeps the next cursor', async () => {
    const { fake, session } = await openOn({
      scan: () => '*2\r\n$1\r\n0\r\n*2\r\n$1\r\na\r\n$1\r\nb\r\n'
    });
    try {
      await expect(session.scanKeys('0')).resolves.toEqual({ cursor: '0', keys: ['a', 'b'] });
      expect(driftCommands(fake)).toEqual([['ping'], ['scan', '0', 'MATCH', 'kbe_*', 'COUNT', '100']]);
    } finally {
      session.close();
      await fake.close();
    }
  });

  it('scanKeys walks pages by the returned cursor until it comes back "0"', async () => {
    const { fake, session } = await openOn({
      scan: args =>
        args[0] === '0'
          ? '*2\r\n$2\r\n17\r\n*1\r\n$1\r\na\r\n'
          : '*2\r\n$1\r\n0\r\n*1\r\n$1\r\nb\r\n'
    });
    try {
      const page1 = await session.scanKeys('0');
      expect(page1).toEqual({ cursor: '17', keys: ['a'] });
      const page2 = await session.scanKeys(page1.cursor);
      expect(page2).toEqual({ cursor: '0', keys: ['b'] });
    } finally {
      session.close();
      await fake.close();
    }
  });

  it('surfaces a server rejection on SCAN', async () => {
    const { fake, session } = await openOn({ scan: () => '-ERR busy\r\n' });
    try {
      await expect(session.scanKeys('0')).rejects.toThrow(/busy/);
    } finally {
      session.close();
      await fake.close();
    }
  });

  it('hashGetAll maps a flat reply into field->value and an empty hash into an empty map', async () => {
    const { fake, session } = await openOn({
      hgetall: () => '*4\r\n$1\r\na\r\n$1\r\n1\r\n$1\r\nb\r\n$1\r\n2\r\n'
    });
    try {
      await expect(session.hashGetAll('kbe_entitylog:1:2')).resolves.toEqual({ a: '1', b: '2' });
    } finally {
      session.close();
      await fake.close();
    }

    const empty = await openOn({ hgetall: () => '*0\r\n' });
    try {
      await expect(empty.session.hashGetAll('kbe_missing')).resolves.toEqual({});
    } finally {
      empty.session.close();
      await empty.fake.close();
    }
  });

  it('KODE-REDIS-LIB-001: non-ASCII hash fields survive a chunk split inside a multibyte char', async () => {
    // '中文键'/'中文值' are 9 utf8 bytes each; the fake server writes the reply
    // in two chunks splitting INSIDE the first field's multibyte char, so the
    // library must buffer by byte count, never by character count
    const reply = Buffer.concat([
      Buffer.from('*2\r\n$9\r\n', 'latin1'),
      Buffer.from('中文键', 'utf8'),
      Buffer.from('\r\n$9\r\n', 'latin1'),
      Buffer.from('中文值', 'utf8'),
      Buffer.from('\r\n', 'latin1')
    ]);
    const { fake, session } = await openOn({
      hgetall: (_args, socket) => {
        socket.write(reply.subarray(0, 12));
        setImmediate(() => socket.write(reply.subarray(12)));
        return '';
      }
    });
    try {
      await expect(session.hashGetAll('kbe_entitylog:1:2')).resolves.toEqual({
        '中文键': '中文值'
      });
    } finally {
      session.close();
      await fake.close();
    }
  });

  it('typeOf returns the key type name and "none" for a missing key', async () => {
    const { fake, session } = await openOn({ type: () => '+hash\r\n' });
    try {
      await expect(session.typeOf('kbe_entitylog:1:2')).resolves.toBe('hash');
    } finally {
      session.close();
      await fake.close();
    }

    const missing = await openOn({ type: () => '+none\r\n' });
    try {
      await expect(missing.session.typeOf('kbe_missing')).resolves.toBe('none');
    } finally {
      missing.session.close();
      await missing.fake.close();
    }
  });

  it('rejects commands issued after close', async () => {
    const { fake, session } = await openOn({});
    session.close();
    await expect(session.hashGetAll('kbe_entitylog:1:2')).rejects.toThrow();
    await fake.close();
  });

  it('rejects an in-flight command when the server closes the socket', async () => {
    const { fake, session } = await openOn({
      hgetall: (_args, socket) => {
        socket.destroy();
        return '';
      }
    });
    try {
      await expect(session.hashGetAll('kbe_entitylog:1:2')).rejects.toThrow();
    } finally {
      session.close();
      await fake.close();
    }
  });
});
