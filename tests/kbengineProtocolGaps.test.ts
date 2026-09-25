import { describe, expect, it, vi } from 'vitest';
import {
  discoverLocalComponents,
  queryWatcherPath,
  type KBEngineComponentInfo
} from '../src/kbengineProtocol';

// discoverLocalComponents 的 UDP 生命周期缺口:socket error 事件拒绝、
// 绑定回调里 string 地址的绑定失败形态、settled 重入守卫(timer 晚到
// 不二次 close/resolve)。真实回环里 dgram error 与绑定失败几乎不可稳定
// 触发(批32 结论),这里用 vi.mock('dgram') getter 工厂注入受控假例,
// 纯真实 UDP 路径仍由 kbengineProtocolSocket.test.ts 覆盖。

interface FakeSocket {
  handlers: Record<string, Array<(...args: unknown[]) => void>>;
  sent: Array<{ frame: Buffer; port: number; address: string }>;
  closeCalls: number;
  addressResult: unknown;
  on: (event: string, handler: (...args: unknown[]) => void) => void;
  bind: (port: number, address: string, callback: () => void) => void;
  address: () => unknown;
  send: (frame: Buffer, port: number, address: string) => void;
  close: () => void;
  emit: (event: string, ...args: unknown[]) => void;
}

const dgramState = vi.hoisted(() => ({
  impl: undefined as undefined | (() => FakeSocket)
}));

vi.mock('dgram', async importOriginal => {
  const actual = await importOriginal<typeof import('dgram')>();
  return {
    ...actual,
    default: actual,
    get createSocket() {
      if (dgramState.impl) {
        return dgramState.impl as unknown as typeof actual.createSocket;
      }
      return actual.createSocket;
    }
  };
});

interface FakeTcpSocket {
  handlers: Record<string, Array<(...args: unknown[]) => void>>;
  writes: Buffer[];
  connects: Array<{ port: number; address: string }>;
  destroyCalls: number;
  on: (event: string, handler: (...args: unknown[]) => void) => void;
  once: (event: string, handler: (...args: unknown[]) => void) => void;
  connect: (port: number, address: string) => void;
  write: (frame: Buffer) => void;
  destroy: () => void;
  emit: (event: string, ...args: unknown[]) => void;
}

// queryWatcherPath 经 new net.Socket() 构造,假例须以 class 形态提供
class FakeTcpSocketImpl implements FakeTcpSocket {
  handlers: Record<string, Array<(...args: unknown[]) => void>> = {};
  writes: Buffer[] = [];
  connects: Array<{ port: number; address: string }> = [];
  destroyCalls = 0;

  on = (event: string, handler: (...args: unknown[]) => void) => {
    this.handlers[event] = this.handlers[event] || [];
    this.handlers[event].push(handler);
  };

  once = (event: string, handler: (...args: unknown[]) => void) => {
    this.on(event, handler);
  };

  connect = (port: number, address: string) => {
    this.connects.push({ port, address });
  };

  write = (frame: Buffer) => {
    this.writes.push(frame);
  };

  destroy = () => {
    this.destroyCalls += 1;
  };

  emit = (event: string, ...args: unknown[]) => {
    for (const handler of this.handlers[event] || []) {
      handler(...args);
    }
  };
}

const netState = vi.hoisted(() => ({
  impl: undefined as undefined | (() => unknown),
  last: undefined as undefined | FakeTcpSocket
}));

vi.mock('net', async importOriginal => {
  const actual = await importOriginal<typeof import('net')>();
  return {
    ...actual,
    default: actual,
    get Socket() {
      if (netState.impl) {
        const Impl = netState.impl() as unknown as new () => FakeTcpSocketImpl;
        return class {
          constructor() {
            netState.last = new Impl();
            return netState.last;
          }
        } as unknown as typeof actual.Socket;
      }
      return actual.Socket;
    }
  };
});

const makeFakeSocket = (addressResult: unknown = { address: '0.0.0.0', port: 54321 }): FakeSocket => {
  const socket: FakeSocket = {
    handlers: {},
    sent: [],
    closeCalls: 0,
    addressResult,
    on: (event, handler) => {
      socket.handlers[event] = socket.handlers[event] || [];
      socket.handlers[event].push(handler);
    },
    bind: (port, address, callback) => {
      setTimeout(() => callback(), 0);
    },
    address: () => socket.addressResult,
    send: (frame, port, address) => {
      socket.sent.push({ frame, port, address });
    },
    close: () => {
      socket.closeCalls += 1;
    },
    emit: (event, ...args) => {
      for (const handler of socket.handlers[event] || []) {
        handler(...args);
      }
    }
  };
  return socket;
};

describe('discoverLocalComponents failure paths', () => {
  it('rejects on a socket error and lets the late finish tick observe the guard', async () => {
    const socket = makeFakeSocket();
    dgramState.impl = () => socket;

    // 超时计时器换成 fake:真实 20ms 计时会在等待期间先 settle
    vi.useFakeTimers();

    try {
      const promise = discoverLocalComponents({ timeoutMs: 60000 });
      await vi.advanceTimersByTimeAsync(1);
      expect(socket.sent).toHaveLength(1);

      socket.emit('error', new Error('udp-boom'));
      await expect(promise).rejects.toThrow('udp-boom');

      // 超时计时器随后触发:finish 的 settled 守卫直接返回,不二次 close
      await vi.advanceTimersByTimeAsync(60000);
      expect(socket.closeCalls).toBe(1);
    } finally {
      vi.useRealTimers();
      dgramState.impl = undefined;
    }
  }, 10000);

  it('rejects when the bind callback reports a string address', async () => {
    const socket = makeFakeSocket('0.0.0.0:0');
    dgramState.impl = () => socket;

    try {
      const promise = discoverLocalComponents({ timeoutMs: 20 });
      await expect(promise).rejects.toThrow('Failed to bind UDP socket for machine discovery.');
      expect(socket.sent).toHaveLength(0);
      expect(socket.closeCalls).toBe(1);

      // 同一计时器晚到的 finish 同样命中 settled 守卫
      await new Promise(resolve => setTimeout(resolve, 60));
      expect(socket.closeCalls).toBe(1);
    } finally {
      dgramState.impl = undefined;
    }
  });
});

describe('queryWatcherPath guards', () => {
  it('returns no results for a component type without a watcher message id', async () => {
    const machine = { componentType: 8 } as unknown as KBEngineComponentInfo;

    await expect(queryWatcherPath(machine, '/')).resolves.toEqual([]);
  });

  it('rejects on a watcher socket error without further finish ticks', async () => {
    netState.impl = () => FakeTcpSocketImpl;
    vi.useFakeTimers();

    try {
      const cellapp = {
        componentType: 5,
        intport: 12345,
        intaddr: '127.0.0.1'
      } as unknown as KBEngineComponentInfo;
      const promise = queryWatcherPath(cellapp, '/');

      // executor 同步 connect;connect 事件驱动写查询帧
      netState.last!.emit('connect');
      expect(netState.last!.writes).toHaveLength(1);

      netState.last!.emit('error', new Error('tcp-boom'));
      await expect(promise).rejects.toThrow('tcp-boom');
      expect(netState.last!.destroyCalls).toBe(1);
    } finally {
      vi.useRealTimers();
      netState.impl = undefined;
    }
  });

  it('lets a late data frame rearm the timer and observe the finish guard', async () => {
    netState.impl = () => FakeTcpSocketImpl;
    vi.useFakeTimers();

    try {
      const cellapp = {
        componentType: 5,
        intport: 12345,
        intaddr: '127.0.0.1'
      } as unknown as KBEngineComponentInfo;
      const promise = queryWatcherPath(cellapp, '/');

      // 非 CONSOLE 回执帧不产生结果,仅重置超时计时器
      netState.last!.emit('connect');
      netState.last!.emit('data', Buffer.from([0x01, 0x00, 0x00, 0x00]));
      await vi.advanceTimersByTimeAsync(800);
      await expect(promise).resolves.toEqual([]);
      expect(netState.last!.destroyCalls).toBe(1);

      // 完成后再来的 data 不检查 settled:重置计时器让 finish 再次触发,
      // 第二次调用命中 settled 守卫直接返回,不二次 destroy
      netState.last!.emit('data', Buffer.from([0x01, 0x00, 0x00, 0x00]));
      await vi.advanceTimersByTimeAsync(800);
      expect(netState.last!.destroyCalls).toBe(1);
    } finally {
      vi.useRealTimers();
      netState.impl = undefined;
    }
  });
});
