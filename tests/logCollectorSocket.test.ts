import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { CollectorStatus, KBEngineLogCollector } from '../src/logCollector';
import type { LogEntry } from '../src/logParser';

// KBEngineLogCollector 的 socket 辅助路径:connect() 按设计直接拒绝,
// 但 deregister/heartbeat 帧组装、心跳定时器、重连调度、UID 探测与
// Connected/Connecting 状态文本仍可经 internals 驱动。socket 用记录型
// 假例,定时器走 vitest fake timers。

interface FakeSocketState {
  destroyed: boolean;
  writes: Buffer[];
  removeAllListenersCalls: number;
  destroyCalls: number;
}

const makeFakeSocket = () => {
  const state: FakeSocketState = {
    destroyed: false,
    writes: [],
    removeAllListenersCalls: 0,
    destroyCalls: 0
  };
  const socket = {
    get destroyed(): boolean {
      return state.destroyed;
    },
    write(buffer: Buffer): void {
      state.writes.push(Buffer.from(buffer));
    },
    removeAllListeners(): void {
      state.removeAllListenersCalls += 1;
    },
    destroy(): void {
      state.destroyCalls += 1;
      state.destroyed = true;
    }
  };
  return { socket: socket as unknown as import('net').Socket, state };
};

const makeCollector = (over: Partial<{
  autoReconnect: boolean;
  reconnectInterval: number;
  maxBufferSize: number;
}> = {}) =>
  new KBEngineLogCollector(
    {
      host: '127.0.0.1',
      port: 30000,
      autoReconnect: over.autoReconnect ?? false,
      reconnectInterval: over.reconnectInterval ?? 250,
      maxBufferSize: over.maxBufferSize ?? 100
    },
    {} as unknown as vscode.ExtensionContext
  );

interface Internals {
  socket: import('net').Socket | null;
  heartbeatTimer: NodeJS.Timeout | null;
  reconnectTimer: NodeJS.Timeout | null;
  isManualDisconnect: boolean;
  status: CollectorStatus;
  lastError: Error | null;
  startHeartbeat(): void;
  stopHeartbeat(): void;
  sendHeartbeat(): void;
  sendDeregister(): void;
  scheduleReconnect(): void;
  clearReconnectTimer(): void;
  getDefaultUid(): number;
  pushLogEntry(entry: LogEntry): void;
}

const internalsOf = (collector: KBEngineLogCollector): Internals =>
  collector as unknown as Internals;

afterEach(() => {
  vi.useRealTimers();
});

describe('KBEngineLogCollector deregister frame', () => {
  it('writes the 703 deregister frame and destroys the socket on disconnect', () => {
    const collector = makeCollector();
    const internals = internalsOf(collector);
    const { socket, state } = makeFakeSocket();
    internals.socket = socket;

    collector.disconnect();

    expect(state.writes).toHaveLength(1);
    expect([...state.writes[0]]).toEqual([191, 2, 0, 0]);
    expect(state.removeAllListenersCalls).toBe(1);
    expect(state.destroyCalls).toBe(1);
    expect(internals.socket).toBeNull();
    expect(internals.isManualDisconnect).toBe(true);
    expect(collector.getStatus()).toBe(CollectorStatus.Disconnected);
  });

  it('skips the deregister frame when the socket is already destroyed', () => {
    const collector = makeCollector();
    const internals = internalsOf(collector);
    const { socket, state } = makeFakeSocket();
    state.destroyed = true;
    internals.socket = socket;

    collector.disconnect();

    expect(state.writes).toHaveLength(0);
    expect(state.destroyCalls).toBe(1);
    expect(internals.socket).toBeNull();
  });
});

describe('KBEngineLogCollector heartbeat frames', () => {
  it('writes a 701 heartbeat every second and stops after stopHeartbeat', () => {
    vi.useFakeTimers();
    const collector = makeCollector();
    const internals = internalsOf(collector);
    const { socket, state } = makeFakeSocket();
    internals.socket = socket;

    internals.startHeartbeat();
    expect(internals.heartbeatTimer).not.toBeNull();

    vi.advanceTimersByTime(999);
    expect(state.writes).toHaveLength(0);

    vi.advanceTimersByTime(1);
    expect(state.writes).toHaveLength(1);
    expect(state.writes[0].length).toBe(14);
    expect([...state.writes[0].subarray(0, 6)]).toEqual([189, 2, 12, 0, 0, 0]);

    vi.advanceTimersByTime(1000);
    expect(state.writes).toHaveLength(2);

    internals.stopHeartbeat();
    expect(internals.heartbeatTimer).toBeNull();
    vi.advanceTimersByTime(5000);
    expect(state.writes).toHaveLength(2);
  });

  it('restarts the heartbeat timer instead of stacking intervals', () => {
    vi.useFakeTimers();
    const collector = makeCollector();
    const internals = internalsOf(collector);
    const { socket, state } = makeFakeSocket();
    internals.socket = socket;

    internals.startHeartbeat();
    const firstTimer = internals.heartbeatTimer;
    internals.startHeartbeat();

    expect(internals.heartbeatTimer).not.toBe(firstTimer);

    vi.advanceTimersByTime(1000);
    expect(state.writes).toHaveLength(1);
  });

  it('is a no-op without a live socket', () => {
    const collector = makeCollector();
    const internals = internalsOf(collector);

    expect(() => internals.sendHeartbeat()).not.toThrow();
    expect(() => internals.sendDeregister()).not.toThrow();
  });
});

describe('KBEngineLogCollector reconnect scheduling', () => {
  it('retries connect once per interval and resets the timer', () => {
    vi.useFakeTimers();
    const collector = makeCollector({ autoReconnect: true, reconnectInterval: 250 });
    const internals = internalsOf(collector);
    const errors: Error[] = [];
    collector.onError(error => errors.push(error));

    internals.scheduleReconnect();
    expect(internals.reconnectTimer).not.toBeNull();

    vi.advanceTimersByTime(250);
    // 回调里 connect() 必然拒绝:错误事件已发出、状态置 Error、timer 复位
    expect(errors).toHaveLength(1);
    expect(collector.getStatus()).toBe(CollectorStatus.Error);
    expect(internals.reconnectTimer).toBeNull();

    // timer 复位后可以再次排程
    internals.scheduleReconnect();
    expect(internals.reconnectTimer).not.toBeNull();
  });

  it('ignores scheduling when autoReconnect is off, manual, or already pending', () => {
    vi.useFakeTimers();
    const collector = makeCollector({ autoReconnect: false });
    const internals = internalsOf(collector);

    internals.scheduleReconnect();
    expect(internals.reconnectTimer).toBeNull();

    const manual = makeCollector({ autoReconnect: true });
    const manualInternals = internalsOf(manual);
    manualInternals.isManualDisconnect = true;
    manualInternals.scheduleReconnect();
    expect(manualInternals.reconnectTimer).toBeNull();

    const pending = makeCollector({ autoReconnect: true });
    const pendingInternals = internalsOf(pending);
    pendingInternals.scheduleReconnect();
    const existing = pendingInternals.reconnectTimer;
    pendingInternals.scheduleReconnect();
    expect(pendingInternals.reconnectTimer).toBe(existing);
  });

  it('drops a pending reconnect on disconnect', () => {
    vi.useFakeTimers();
    const collector = makeCollector({ autoReconnect: true, reconnectInterval: 60000 });
    const internals = internalsOf(collector);

    internals.scheduleReconnect();
    expect(internals.reconnectTimer).not.toBeNull();

    collector.disconnect();

    expect(internals.reconnectTimer).toBeNull();
    vi.advanceTimersByTime(120000);
    expect(collector.getStatus()).toBe(CollectorStatus.Disconnected);
  });
});

describe('KBEngineLogCollector.getDefaultUid', () => {
  const patchProcess = (mutate: (target: Record<string, unknown>) => void) => {
    const target = process as unknown as Record<string, unknown>;
    const originalGetuid = target.getuid;
    const originalUid = process.env.uid;
    const originalUID = process.env.UID;
    mutate(target);
    return () => {
      target.getuid = originalGetuid;
      if (originalUid === undefined) {
        delete process.env.uid;
      } else {
        process.env.uid = originalUid;
      }
      if (originalUID === undefined) {
        delete process.env.UID;
      } else {
        process.env.UID = originalUID;
      }
    };
  };

  it('prefers process.getuid', () => {
    const collector = makeCollector();
    expect(internalsOf(collector).getDefaultUid()).toBe(process.getuid());
  });

  it('falls back to env uid then UID, and to -1 when unusable', () => {
    const collector = makeCollector();
    const internals = internalsOf(collector);

    const restoreA = patchProcess(target => {
      target.getuid = undefined;
      process.env.uid = '12345';
    });
    expect(internals.getDefaultUid()).toBe(12345);
    restoreA();

    const restoreB = patchProcess(target => {
      target.getuid = undefined;
      process.env.uid = 'not-a-number';
      process.env.UID = '77';
    });
    expect(internals.getDefaultUid()).toBe(-1);
    restoreB();

    const restoreC = patchProcess(target => {
      target.getuid = undefined;
      delete process.env.uid;
      process.env.UID = '77';
    });
    expect(internals.getDefaultUid()).toBe(77);
    restoreC();

    const restoreD = patchProcess(target => {
      target.getuid = undefined;
      delete process.env.uid;
      delete process.env.UID;
    });
    expect(internals.getDefaultUid()).toBe(-1);
    restoreD();
  });
});

describe('KBEngineLogCollector connected and connecting texts', () => {
  it('reports the connected caveat via reason and summary', () => {
    const collector = makeCollector();
    const internals = internalsOf(collector);
    internals.status = CollectorStatus.Connected;

    expect(collector.getUnavailableReason()).toBe(KBEngineLogCollector.PROTOCOL_WARNING);
    expect(collector.getStatusSummary()).toBe(
      '已连接 127.0.0.1:30000，但 logger watcher 协议仍未完成适配'
    );
  });

  it('reports the connecting summary while the reason stays not-connected', () => {
    const collector = makeCollector();
    const internals = internalsOf(collector);
    internals.status = CollectorStatus.Connecting;

    expect(collector.getStatusSummary()).toBe('正在连接 127.0.0.1:30000');
    expect(collector.getUnavailableReason()).toContain('尚未连接');
  });
});

describe('KBEngineLogCollector.dispose tears down live resources', () => {
  it('destroys the socket and clears both timers', () => {
    const collector = makeCollector({ autoReconnect: true, reconnectInterval: 60000 });
    const internals = internalsOf(collector);
    const { socket, state } = makeFakeSocket();
    internals.socket = socket;
    internals.startHeartbeat();
    internals.scheduleReconnect();

    collector.dispose();

    expect(state.destroyCalls).toBe(1);
    expect(internals.socket).toBeNull();
    expect(internals.heartbeatTimer).toBeNull();
    expect(internals.reconnectTimer).toBeNull();
    expect(collector.getStatus()).toBe(CollectorStatus.Disconnected);

    // 重复 dispose:socket/timer 均已空,不抛
    expect(() => collector.dispose()).not.toThrow();
  });

  it('keeps firing entries into a disposed emitter harmless', () => {
    const collector = makeCollector();
    collector.dispose();
    const internals = internalsOf(collector);

    expect(() =>
      internals.pushLogEntry({
        id: 1,
        timestamp: new Date(),
        component: 'cellapp',
        level: 1,
        type: 0,
        message: 'after dispose',
        raw: 'raw'
      })
    ).not.toThrow();
    expect(collector.getLogCount()).toBe(1);
  });
});
