/**
 * Redis read-only drift surface (KODE-REDIS-UI-001); the wire client is
 * delegated to the ioredis library (KODE-REDIS-LIB-001), replacing the
 * previous hand-rolled wire codec (the user's standing rule: redis/mysql
 * must ride mature libraries, never hand-written protocol code).
 *
 * Library choice, ioredis v5 over node-redis v4:
 * - its handshake is plain `auth <password>` (no leading user) / `select <db>`,
 *   matching the engine's kbe/src/lib/db_redis convention, with no extra
 *   HELLO or CLIENT SETINFO traffic;
 * - `lazyConnect` + `retryStrategy: () => null` + `enableOfflineQueue: false`
 *   reproduce the old single-shot fail-fast session: one connect, no
 *   background reconnects, commands issued before ready reject instead of
 *   hanging in an offline queue;
 * - the typed reply surfaces (`ping`/`scan`/`hgetall`/`type`) map 1:1 onto
 *   this surface's return shapes.
 *
 * Only the read-only surface kode itself needs -- connecting
 * (AUTH/SELECT/PING), keyspace enumeration (SCAN) and hash preview
 * (HGETALL); no writes, no full Redis command set.
 *
 * Conventions (aligned with kbe/src/lib/db_redis):
 * - after the engine's `<type>redis</type>`, the connection elements are
 *   host/port/<auth.password>/<databaseName>; kbe only sends
 *   `auth <password>` (no leading user), and
 *   `select <databaseName>` (index, defaulting to "0").
 * - engine entity persistence does not go through redis
 *   (EntityTableRedis::writeTable/queryTable are empty implementations;
 *   kode-db-clone source-evidence section 1: the redis backend does not
 *   persist entities), so this surface does not simulate mysql table
 *   structure -- it only lists keys that really exist (SCAN `kbe_*`) and
 *   reads hashes (HGETALL).
 *
 * Test surface: sessions run against a fake redis wire server over a real
 * TCP socket, so unit tests drive the library's actual codec without ever
 * touching a real redis instance.
 */

import Redis, { type RedisOptions } from 'ioredis';

/** Connection elements (same conventions as the engine dbInterface; dbIndex=<databaseName>, defaulting to 0). */
export interface RedisConnectionConfig {
  host: string;
  port: number;
  password?: string;
  dbIndex?: number;
}

export interface RedisSessionOptions {
  connectTimeoutMs?: number;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const REDIS_DEFAULT_PORT = 6379;

/**
 * Read-only Redis session over an ioredis client: opened with AUTH (when a
 * password exists) / SELECT (when the index is not 0) / PING; SCAN enumerates
 * keys and HGETALL reads hashes. Consumers keep the pre-library session
 * shape: close() stays synchronous (fire-and-forget in finally blocks) and
 * every failure surfaces as a rejected promise with a plain Error.
 */
export class RedisSession {
  constructor(private readonly client: Redis) {}

  async ping(): Promise<void> {
    const reply = await this.client.ping();
    if (reply !== 'PONG') {
      throw new Error(`PING 意外回复: ${reply}`);
    }
  }

  /**
   * One SCAN page: returns the page's keys and the next cursor ("0" means done).
   * The library resolves the server's reply into [cursor, keys[]].
   */
  async scanKeys(cursor: string, pattern = 'kbe_*'): Promise<{ cursor: string; keys: string[] }> {
    const [next, keys] = await this.client.scan(cursor, 'MATCH', pattern, 'COUNT', '100');
    return { cursor: next, keys };
  }

  /** HGETALL: read a whole hash into a field->value map (empty hash / nonexistent -> empty map). */
  async hashGetAll(key: string): Promise<Record<string, string>> {
    return await this.client.hgetall(key);
  }

  /** TYPE: return the key's type name (nonexistent -> "none"). */
  async typeOf(key: string): Promise<string> {
    return await this.client.type(key);
  }

  /**
   * Hard close: drift sessions are never reused, and consumers call this
   * synchronously in finally blocks, so take the synchronous teardown (no
   * async QUIT round-trip).
   */
  close(): void {
    this.client.disconnect();
  }
}

/**
 * Open a read-only Redis session: connect -> AUTH (when a password exists) ->
 * SELECT (when the index is not 0) -> PING, the whole handshake bounded by
 * connectTimeoutMs (ioredis bounds the TCP phase; the manual budget also
 * covers a server that accepts the socket but never answers the handshake).
 * Any failed step rejects (connect failure / auth failure / timeout) and the
 * underlying client is torn down; the caller is responsible for closing and
 * for the degraded display. dbIndex defaulting to 0 skips SELECT (the redis
 * default database is 0).
 */
export async function openRedisSession(
  config: RedisConnectionConfig,
  options: RedisSessionOptions = {}
): Promise<RedisSession> {
  const port = config.port || REDIS_DEFAULT_PORT;
  const timeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const clientOptions: RedisOptions = {
    host: config.host,
    port,
    lazyConnect: true,
    // single-shot fail-fast session: never reconnect in the background and
    // never queue commands issued before the connection is ready
    retryStrategy: () => null,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    // bounds the TCP connect phase; the handshake budget below covers the rest
    connectTimeout: timeoutMs
  };
  // engine convention: `auth <password>` with no leading user; skip AUTH
  // entirely when no password is configured (empty string included)
  if (config.password) {
    clientOptions.password = config.password;
  }
  // engine convention: `select <databaseName>`; ioredis skips SELECT for db 0
  if (config.dbIndex) {
    clientOptions.db = config.dbIndex;
  }
  const client = new Redis(clientOptions);
  // Handshake-level failures (auth rejection, socket errors) surface as
  // 'error' events, while the connect() promise only rejects with a bare
  // "Connection is closed." after the socket drops; capture the first real
  // error and prefer it as the rejection cause, which also keeps ioredis's
  // "Unhandled error event" stderr noise away from the degraded surface.
  let firstError: Error | null = null;
  client.on('error', error => {
    if (firstError === null) {
      firstError = error;
    }
  });

  const handshake = (async () => {
    await client.connect();
    await client.ping();
  })();
  // a handshake rejection after the timeout settled the race must not become
  // an unhandled rejection
  handshake.catch(() => undefined);

  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      handshake,
      new Promise<never>((_, rejectTimeout) => {
        timer = setTimeout(() => {
          // reject first so the race settles with the timeout message;
          // disconnect() would synchronously reject the in-flight handshake
          // with a bare "Connection is closed." instead
          rejectTimeout(new Error(`redis 连接超时(${config.host}:${port},${timeoutMs}ms)`));
          client.disconnect();
        }, timeoutMs);
        timer.unref?.();
      })
    ]);
  } catch (error) {
    client.disconnect();
    throw firstError ?? error;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
  return new RedisSession(client);
}
