import * as net from 'net';
import {
  CONSOLE_WATCHER_CB_MSG_ID,
  buildCString,
  buildFrame,
  buildWatcherDirFrameBody,
  buildWatcherValueFrameBody
} from '../../src/kbengineProtocol';

/**
 * 本地 watcher 查询仿真器:每个组件一个 TCP 服务,端口动态分配。
 *
 * 行为规格(对齐引擎各组件的 watcher 查询端口,
 * kbe/src/lib/watcher,帧体见 parseWatcherFrame):
 * - 收到 msgid=WATCHER_QUERY_MSG_IDS[type] 的查询帧(path cstring)
 *   后,按路由表回 type 0 值帧 + type 1 目录帧两帧(客户端
 *   results>=2 提前收尾的语义前提);
 * - respond 模式默认整帧写回;split 模式先发 3 字节再延时补齐,
 *   驱动客户端流式重组;
 * - refuse 模式 accept 后立即 destroy(发 RST,走客户端 error);
 * - silent 模式收包不回(驱动客户端超时收尾 resolve []);
 * - garbage 模式回非 65502 msgid 帧(客户端静默跳过)。
 *
 * 帧体构造复用生产侧 buildWatcherValueFrameBody/
 * buildWatcherDirFrameBody 编码器(docs/redesign.md G4)。
 */

export type WatcherValueMap = Record<string, string | number | bigint | boolean>;

export interface WatcherRequestRecord {
  messageId: number;
  path: string;
}

export type WatcherBehavior = 'respond' | 'split' | 'refuse' | 'silent' | 'garbage';

export interface WatcherSimulatorOptions {
  /** path → 值表;命中 path 回值帧,未命中回空值帧(仍带目录帧) */
  routes?: Record<string, WatcherValueMap>;
  behavior?: WatcherBehavior;
  /** 目录帧携带的 keys(缺省空表;客户端 results>=2 收尾语义不变) */
  dirKeys?: string[];
}

export class WatcherSimulator {
  private constructor(
    readonly port: number,
    private readonly server: net.Server,
    private readonly requests: WatcherRequestRecord[]
  ) {}

  static async start(options: WatcherSimulatorOptions = {}): Promise<WatcherSimulator> {
    const requests: WatcherRequestRecord[] = [];
    const routes = options.routes ?? {};
    const behavior = options.behavior ?? 'respond';
    const dirKeys = options.dirKeys ?? [];

    const server = net.createServer(socket => {
      // 客户端在 results>=2 后提前拆除连接(接收缓冲尚有未读字节时 destroy
      // 会对端收 RST),服务侧必须容忍早关,否则未处理的 'error' 在并行负载
      // 下演变成未捕获异常炸掉测试进程
      socket.on('error', () => {
        // 客户端提前关闭属于协议允许的收尾方式,静默吸收
      });
      socket.on('data', data => {
        let offset = 0;
        while (offset + 4 <= data.length) {
          const messageId = data.readUInt16LE(offset);
          const bodyLength = data.readUInt16LE(offset + 2);
          const totalLength = 4 + bodyLength;
          if (offset + totalLength > data.length) {
            break;
          }
          const path = data.subarray(offset + 4, offset + 4 + bodyLength - 1).toString('utf8');
          requests.push({ messageId, path });

          if (behavior === 'refuse') {
            // 收到请求后发真 RST(而非仅 FIN),驱动客户端 error 拒绝路径;
            // Node >= 18.3 提供 resetAndDestroy。
            socket.resetAndDestroy?.();
            return;
          }

          if (behavior === 'silent') {
            offset += totalLength;
            continue;
          }

          if (behavior === 'garbage') {
            socket.write(buildFrame(12345, buildCString(path)));
            offset += totalLength;
            continue;
          }

          const reply = buildWatcherReply(path, routes[path] ?? {}, dirKeys);
          if (behavior === 'split') {
            socket.write(reply.subarray(0, 3));
            setTimeout(() => socket.write(reply.subarray(3)), 30);
          } else {
            socket.write(reply);
          }
          offset += totalLength;
        }
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });

    return new WatcherSimulator(
      (server.address() as net.AddressInfo).port,
      server,
      requests
    );
  }

  /** 已收到的查询请求(msgid + path) */
  getRequests(): WatcherRequestRecord[] {
    return [...this.requests];
  }

  async stop(): Promise<void> {
    await new Promise<void>(resolve => this.server.close(() => resolve()));
  }
}

/** 值帧 + 目录帧:两帧连发,满足客户端 results>=2 提前结束条件 */
export function buildWatcherReply(
  path: string,
  values: WatcherValueMap,
  dirKeys: string[] = []
): Buffer {
  const valueFrame = buildFrame(
    CONSOLE_WATCHER_CB_MSG_ID,
    buildWatcherValueFrameBody(path, values)
  );
  const dirFrame = buildFrame(
    CONSOLE_WATCHER_CB_MSG_ID,
    buildWatcherDirFrameBody('/', dirKeys)
  );
  return Buffer.concat([valueFrame, dirFrame]);
}
