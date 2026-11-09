/**
 * Redis 只读漂移面(KODE-REDIS-UI-001):极简 RESP2 客户端,零新依赖。
 *
 * 只做 kode 自身所需的只读面——连接(AUTH/SELECT/PING)、键空间枚举
 * (SCAN)与哈希预览(HGETALL),不实现写,不实现完整 Redis 命令集。
 *
 * 口径(与 kbe/src/lib/db_redis 对齐):
 * - 引擎 `<type>redis</type>` 后连接要素=host/port/<auth.password>/<databaseName>;
 *   kbe 只发 `auth <password>`(不带头 user),`select <databaseName>`(索引,缺省 "0")。
 * - 引擎实体持久化不走 redis(EntityTableRedis::writeTable/queryTable 空实现;
 *   kode-db-clone source-evidence §1:redis 后端不持久化实体),本面不模拟
 *   mysql 表结构,只列真实存在的键(SCAN `kbe_*`)与读哈希(HGETALL)。
 *
 * 测试面:RESP 解码器(RespDecoder)纯函数可直驱;会话经 SocketFactory 注入
 * 假 socket,单测不发真实网络包。
 */

/** RESP2 解码后的值(客户端只关心 string/int/array;null 表示 nil)。 */
export type RespValue =
  | { kind: 'simple'; value: string }
  | { kind: 'error'; value: string }
  | { kind: 'integer'; value: number }
  | { kind: 'bulk'; value: string | null }
  | { kind: 'array'; value: RespValue[] };

import * as net from 'net';

/** 命令失败(服务端 -ERR / 网络断 / 解码失败)。 */
export class RedisProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RedisProtocolError';
  }
}

/**
 * RESP2 帧解码器:喂字节流,产出完整消息(跨 chunk 缓冲不完整帧)。
 * 单命令请求-响应,同一 socket 上消息严格按到达序(不并行管道,简化正确性)。
 */
export class RespDecoder {
  private buffer = Buffer.alloc(0);

  /** 喂入一块字节,返回新解码出的完整消息(无则不返回)。 */
  push(chunk: Buffer): RespValue[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const out: RespValue[] = [];
    for (;;) {
      const { value, consumed } = this.tryDecode();
      if (value === undefined) {
        break;
      }
      out.push(value);
      this.buffer = this.buffer.subarray(consumed);
    }
    return out;
  }

  /** 尝试解码一条完整消息;不完整返回 consumed=0/value=undefined。 */
  private tryDecode(): { value?: RespValue; consumed: number } {
    const crlf = this.buffer.indexOf('\r\n');
    if (crlf === -1) {
      return { consumed: 0 };
    }
    const head = this.buffer.subarray(0, crlf);
    const headText = head.toString('latin1');
    const afterHead = crlf + 2;
    const prefix = headText[0];

    if (prefix === '+') {
      return { value: { kind: 'simple', value: headText.slice(1) }, consumed: afterHead };
    }
    if (prefix === '-') {
      return { value: { kind: 'error', value: headText.slice(1) }, consumed: afterHead };
    }
    if (prefix === ':') {
      const num = Number(headText.slice(1));
      if (!Number.isFinite(num)) {
        throw new RedisProtocolError(`RESP integer 非法: ${headText}`);
      }
      return { value: { kind: 'integer', value: num }, consumed: afterHead };
    }
    if (prefix === '$') {
      return this.decodeBulk(headText, afterHead);
    }
    if (prefix === '*') {
      return this.decodeArray(headText, afterHead);
    }
    throw new RedisProtocolError(`RESP 未知类型前缀: ${prefix}`);
  }

  private decodeBulk(headText: string, afterHead: number): { value?: RespValue; consumed: number } {
    const len = Number(headText.slice(1));
    if (!Number.isFinite(len)) {
      throw new RedisProtocolError(`RESP 长度非法: ${headText}`);
    }
    if (len === -1) {
      return { value: { kind: 'bulk', value: null }, consumed: afterHead };
    }
    const total = afterHead + len + 2;
    if (this.buffer.length < total) {
      return { consumed: 0 };
    }
    const payload = this.buffer.subarray(afterHead, afterHead + len).toString('utf8');
    return { value: { kind: 'bulk', value: payload }, consumed: total };
  }

  private decodeArray(headText: string, afterHead: number): { value?: RespValue; consumed: number } {
    const count = Number(headText.slice(1));
    if (!Number.isFinite(count)) {
      throw new RedisProtocolError(`RESP 数组长度非法: ${headText}`);
    }
    if (count === -1) {
      return { value: { kind: 'array', value: [] }, consumed: afterHead };
    }
    const items: RespValue[] = [];
    let offset = afterHead;
    for (let i = 0; i < count; i += 1) {
      const item = this.tryDecodeAt(offset);
      if (item === null) {
        return { consumed: 0 };
      }
      items.push(item.value);
      offset = item.consumed;
    }
    return { value: { kind: 'array', value: items }, consumed: offset };
  }

  /** 在 buffer 的绝对偏移处解码一条消息(供数组递归;不完整返回 null)。 */
  private tryDecodeAt(offset: number): { value: RespValue; consumed: number } | null {
    const window = this.buffer.subarray(offset);
    if (window.length === 0) {
      return null;
    }
    const crlf = window.indexOf('\r\n');
    if (crlf === -1) {
      return null;
    }
    const headText = window.subarray(0, crlf).toString('latin1');
    const prefix = headText[0];
    const afterHead = crlf + 2;

    if (prefix === '+') {
      return { value: { kind: 'simple', value: headText.slice(1) }, consumed: offset + afterHead };
    }
    if (prefix === '-') {
      return { value: { kind: 'error', value: headText.slice(1) }, consumed: offset + afterHead };
    }
    if (prefix === ':') {
      const num = Number(headText.slice(1));
      if (!Number.isFinite(num)) {
        throw new RedisProtocolError(`RESP integer 非法: ${headText}`);
      }
      return { value: { kind: 'integer', value: num }, consumed: offset + afterHead };
    }
    if (prefix === '$') {
      const len = Number(headText.slice(1));
      if (!Number.isFinite(len)) {
        throw new RedisProtocolError(`RESP 长度非法: ${headText}`);
      }
      if (len === -1) {
        return { value: { kind: 'bulk', value: null }, consumed: offset + afterHead };
      }
      const total = afterHead + len + 2;
      if (window.length < total) {
        return null;
      }
      const payload = window.subarray(afterHead, afterHead + len).toString('utf8');
      return { value: { kind: 'bulk', value: payload }, consumed: offset + total };
    }
    if (prefix === '*') {
      const count = Number(headText.slice(1));
      if (!Number.isFinite(count)) {
        throw new RedisProtocolError(`RESP 数组长度非法: ${headText}`);
      }
      const items: RespValue[] = [];
      let inner = afterHead;
      for (let i = 0; i < count; i += 1) {
        const item = this.tryDecodeAt(offset + inner);
        if (item === null) {
          return null;
        }
        items.push(item.value);
        inner = item.consumed - offset;
      }
      return { value: { kind: 'array', value: items }, consumed: offset + inner };
    }
    throw new RedisProtocolError(`RESP 未知类型前缀: ${prefix}`);
  }
}

/** RESP2 请求编码:命令 + 参数 → `*N\r\n$len\r\narg\r\n...`。 */
export function encodeCommand(args: string[]): Buffer {
  const parts: Buffer[] = [Buffer.from(`*${args.length}\r\n`)];
  for (const arg of args) {
    const bytes = Buffer.from(arg, 'utf8');
    parts.push(Buffer.from(`$${bytes.length}\r\n`), bytes, Buffer.from('\r\n'));
  }
  return Buffer.concat(parts);
}

/** 极小 socket 接口(与 net.Socket 兼容;测试注入假实现)。 */
export interface RedisSocketLike {
  write(chunk: Buffer): boolean;
  end(): void;
  destroy(): void;
  on(event: 'data', listener: (chunk: Buffer) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'close', listener: (hadError: boolean) => void): unknown;
}

export type RedisSocketFactory = (options: { host: string; port: number }) => RedisSocketLike;

/** 连接要素(与引擎 dbInterface 同口径;dbIndex=<databaseName> 缺省 0)。 */
export interface RedisConnectionConfig {
  host: string;
  port: number;
  password?: string;
  dbIndex?: number;
}

export interface RedisSessionOptions {
  socketFactory?: RedisSocketFactory;
  connectTimeoutMs?: number;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const REDIS_DEFAULT_PORT = 6379;

/**
 * 只读 Redis 会话:连接即 AUTH(有口令)/SELECT(索引非 0)/PING,随后可
 * SCAN 枚举键、HGETALL 读哈希。命令严格顺序请求-响应,不并行管道。
 */
export class RedisSession {
  private readonly decoder = new RespDecoder();
  private pending: {
    resolve: (value: RespValue) => void;
    reject: (error: Error) => void;
  } | null = null;
  private closed = false;

  constructor(
    private readonly socket: RedisSocketLike,
    private readonly write: (args: string[]) => void
  ) {
    // 会话自接线:数据/错误直达本会话(连接期同用——握手命令也经此解析)。
    socket.on('data', (chunk: Buffer) => this.handleData(chunk));
    socket.on('error', (error: Error) => this.handleError(error));
  }

  /** 单条命令请求-响应。 */
  command(...args: string[]): Promise<RespValue> {
    if (this.closed) {
      return Promise.reject(new RedisProtocolError('redis 会话已关闭'));
    }
    if (this.pending) {
      return Promise.reject(new RedisProtocolError('redis 会话已有在途命令(不支持并行)'));
    }
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
      this.write(args);
    });
  }

  async ping(): Promise<void> {
    const reply = await this.command('PING');
    if (reply.kind === 'error') {
      throw new RedisProtocolError(`PING 失败: ${reply.value}`);
    }
    if (reply.kind === 'simple' && reply.value !== 'PONG') {
      throw new RedisProtocolError(`PING 意外回复: ${reply.value}`);
    }
  }

  /**
   * SCAN 一页:返回该页键与下一游标("0" 表示结束)。
   * 服务端 SCAN 回复为 `*2` [cursor, [keys...]]。
   */
  async scanKeys(cursor: string, pattern = 'kbe_*'): Promise<{ cursor: string; keys: string[] }> {
    const reply = await this.command('SCAN', cursor, 'MATCH', pattern, 'COUNT', '100');
    if (reply.kind === 'error') {
      throw new RedisProtocolError(`SCAN 失败: ${reply.value}`);
    }
    if (reply.kind !== 'array' || reply.value.length !== 2) {
      throw new RedisProtocolError('SCAN 回复形态非法');
    }
    const next = reply.value[0];
    const keysArr = reply.value[1];
    const nextCursor = next.kind === 'bulk' && next.value !== null ? next.value : String(next.kind === 'integer' ? next.value : '0');
    const keys =
      keysArr.kind === 'array'
        ? keysArr.value.map(item => (item.kind === 'bulk' && item.value !== null ? item.value : '')).filter(k => k.length > 0)
        : [];
    return { cursor: nextCursor, keys };
  }

  /** HGETALL:读整个哈希为字段→值映射(空哈希/不存在 → 空映射)。 */
  async hashGetAll(key: string): Promise<Record<string, string>> {
    const reply = await this.command('HGETALL', key);
    if (reply.kind === 'error') {
      throw new RedisProtocolError(`HGETALL 失败: ${reply.value}`);
    }
    if (reply.kind !== 'array') {
      throw new RedisProtocolError('HGETALL 回复形态非法');
    }
    const out: Record<string, string> = {};
    for (let i = 0; i + 1 < reply.value.length; i += 2) {
      const field = reply.value[i];
      const value = reply.value[i + 1];
      if (field.kind === 'bulk' && field.value !== null) {
        out[field.value] = value.kind === 'bulk' && value.value !== null ? value.value : '';
      }
    }
    return out;
  }

  /** TYPE:返回键类型名(不存在 → none)。 */
  async typeOf(key: string): Promise<string> {
    const reply = await this.command('TYPE', key);
    if (reply.kind === 'error') {
      throw new RedisProtocolError(`TYPE 失败: ${reply.value}`);
    }
    return reply.kind === 'simple' ? reply.value : '';
  }

  close(): void {
    this.closed = true;
    const waiter = this.pending;
    this.pending = null;
    if (waiter) {
      waiter.reject(new RedisProtocolError('redis 会话关闭'));
    }
    this.socket.end();
  }

  /** 会话内部:数据到达 → 解码 → 交还等待者。 */
  handleData(chunk: Buffer): void {
    let messages: RespValue[];
    try {
      messages = this.decoder.push(chunk);
    } catch (error) {
      const waiter = this.pending;
      this.pending = null;
      waiter?.reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    for (const message of messages) {
      const waiter = this.pending;
      this.pending = null;
      if (!waiter) {
        continue;
      }
      if (message.kind === 'error') {
        waiter.reject(new RedisProtocolError(message.value));
      } else {
        waiter.resolve(message);
      }
    }
  }

  handleError(error: Error): void {
    const waiter = this.pending;
    this.pending = null;
    waiter?.reject(error);
  }
}

const defaultSocketFactory: RedisSocketFactory = options =>
  net.connect({ host: options.host, port: options.port }) as unknown as RedisSocketLike;

/**
 * 打开只读 Redis 会话:连接(超时)→ AUTH(有口令)→ SELECT(索引非 0)→ PING。
 * 任一步失败抛 RedisProtocolError(连接失败/认证失败/库索引失败),调用方
 * 负责关闭与降级展示。dbIndex 缺省 0 不发送 SELECT(redis 默认库 0)。
 */
export function openRedisSession(
  config: RedisConnectionConfig,
  options: RedisSessionOptions = {}
): Promise<RedisSession> {
  const port = config.port || REDIS_DEFAULT_PORT;
  const factory = options.socketFactory ?? defaultSocketFactory;
  const timeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = factory({ host: config.host, port });
    const write = (args: string[]): void => {
      socket.write(encodeCommand(args));
    };
    const session = new RedisSession(socket, write);

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        socket.destroy();
        reject(new RedisProtocolError(`redis 连接超时(${config.host}:${port},${timeoutMs}ms)`));
      }
    }, timeoutMs);
    timer.unref?.();

    const finish = (error: Error | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (error) {
        socket.destroy();
        reject(error);
      } else {
        resolve(session);
      }
    };

    // 数据/错误由 session 自接线(握手命令也经 session 解析);close 在连接
    // 期(无命令在途)由这里收口——session 的错误通道只对在途命令生效。
    socket.on('close', () => {
      if (!settled) {
        finish(new RedisProtocolError('redis 连接关闭'));
      }
    });

    // 顺序握手:AUTH(有口令)→ SELECT(索引非 0)→ PING;任一步失败即整体失败。
    void (async () => {
      try {
        if (config.password !== undefined && config.password.length > 0) {
          await session.command('AUTH', config.password);
        }
        if (config.dbIndex !== undefined && config.dbIndex !== 0) {
          await session.command('SELECT', String(config.dbIndex));
        }
        await session.command('PING');
        finish(null);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    })();
  });
}
