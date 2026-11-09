import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONSOLE_LOG_MSG_ID, buildFrame, buildLogWatcherRequestBody, KBELOG_TYPES_MASK } from '../src/backend/kbengineProtocol';
import { ConsoleLogTailController, buildTailCodeActions, formatTailLine } from '../src/backend/consoleLogTail';

// KB-GC-001 日志实时 tail 控制器:65501 长连推流 → IDE Output。状态机
// (disabled/waiting-machined/connecting/connected/backoff)与指数退避、
// machined 缺席如实提示、组件过滤、错误行跳转目标,全部可注入单测;
// socket 由 fake 双工替身提供,零真网。

interface FakeSocket extends EventEmitter {
  writes: Buffer[];
  destroyed: boolean;
  destroy(): void;
  connectTriggered: boolean;
}

const makeFakeSocket = (): FakeSocket => {
  const socket = new EventEmitter() as FakeSocket;
  socket.writes = [];
  socket.destroyed = false;
  socket.connectTriggered = false;
  socket.write = ((chunk: Buffer) => {
    socket.writes.push(Buffer.from(chunk));
    return true;
  }) as FakeSocket['write'];
  socket.destroy = () => {
    socket.destroyed = true;
  };
  return socket;
};

const logReceipt = (line: string): Buffer => {
  const blob = Buffer.from(line, 'utf8');
  const body = Buffer.alloc(4 + blob.length);
  body.writeUInt32LE(blob.length, 0);
  blob.copy(body, 4);
  return buildFrame(CONSOLE_LOG_MSG_ID, body);
};

const ERROR_LINE = '   ERROR cellapp01 1000 7129652375332859799 [2026-11-07 16:30:00 123] - Traceback (most recent call last):\n  File "scripts/cell/Avatar.py", line 21, in onTimer';
const INFO_LINE = '    INFO logger00 1000 111 [2026-11-07 16:30:01 4] - rotated';

interface Harness {
  controller: ConsoleLogTailController;
  sockets: FakeSocket[];
  output: { lines: string[]; shown: boolean };
  status: { item: { text: string; shows: number } };
  setLogger: (addr: { host: string; port: number } | null) => void;
  setMachined: (state: 'reachable' | 'unreachable') => void;
  /** 可变配置,供测试改后验证下次重连生效 */
  config: { enabled: boolean; components: string[] };
}

const makeHarness = (overrides: Partial<{ components: string[]; enabled: boolean }> = {}): Harness => {
  const sockets: FakeSocket[] = [];
  const output = { lines: [] as string[], shown: false };
  const status = { item: { text: '', shows: 0 } };
  let loggerAddr: { host: string; port: number } | null = { host: '192.168.5.117', port: 30010 };
  let machined: 'reachable' | 'unreachable' = 'reachable';
  // 可变配置:测试可在重连间改 config,验证 getConfig 每次重读(下次重连生效)
  const config = {
    enabled: overrides.enabled ?? true,
    components: overrides.components ?? []
  };

  const hubLike = {
    getLogger: () => (machined === 'reachable' && loggerAddr
      ? { intaddr: loggerAddr.host, intport: loggerAddr.port, uid: 1001, componentID: 900n }
      : undefined),
    getMachinedState: () => machined,
    onDidChange: (_cb: () => void) => ({ dispose: () => undefined })
  };

  const controller = new ConsoleLogTailController({
    hub: hubLike,
    workspaceRoots: () => [],
    resolveSource: () => null,
    output: {
      appendLine: (line: string) => {
        output.lines.push(line);
      },
      show: () => {
        output.shown = true;
      }
    },
    statusItem: {
      get text(): string {
        return status.item.text;
      },
      set text(value: string) {
        status.item.text = value;
        status.item.shows += 1;
      },
      show: () => undefined,
      hide: () => undefined
    },
    getConfig: () => ({
      enabled: config.enabled,
      components: config.components
    }),
    createConnection: () => {
      const socket = makeFakeSocket();
      sockets.push(socket);
      queueMicrotask(() => {
        socket.connectTriggered = true;
        socket.emit('connect');
      });
      return socket;
    },
    backoffBaseMs: 1000,
    backoffMaxMs: 30000,
    tickIntervalMs: 10000
  });
  return {
    controller,
    sockets,
    output,
    status,
    config,
    setLogger: addr => {
      loggerAddr = addr;
    },
    setMachined: state => {
      machined = state;
    }
  };
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ConsoleLogTailController state machine', () => {
  it('stays honest when machined is missing: no socket attempts, one notice', async () => {
    const h = makeHarness();
    h.setMachined('unreachable');
    h.controller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.sockets).toHaveLength(0);
    expect(h.controller.getState()).toBe('waiting-machined');
    expect(h.output.lines.join('\n')).toContain('machined');
    expect(h.status.item.text).toContain('$(circle-slash)');
    h.controller.dispose();
  });

  it('waits without hard retrying when the logger component is absent', async () => {
    const h = makeHarness();
    h.setLogger(null);
    h.controller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.sockets).toHaveLength(0);
    expect(h.controller.getState()).toBe('waiting-machined');
    expect(h.output.lines.join('\n')).toContain('logger');
    h.controller.dispose();
  });

  it('connects to the discovered logger and sends the 702 registration frame', async () => {
    const h = makeHarness();
    h.controller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.sockets).toHaveLength(1);
    expect(h.controller.getState()).toBe('connected');
    expect(h.output.lines.join('\n')).not.toContain('machined');

    const expected = buildLogWatcherRequestBody({
      uid: 1001,
      logtypes: KBELOG_TYPES_MASK,
      globalOrder: 0,
      groupOrder: 0,
      date: '',
      keyStr: '',
      componentTypes: [1, 2, 3, 4, 5, 6, 8, 10, 11, 13],
      isfind: false,
      first: true
    });
    const frame = h.sockets[0].writes[0];
    expect(frame.readUInt16LE(0)).toBe(702);
    expect(frame.subarray(4).equals(expected)).toBe(true);
    h.controller.dispose();
  });

  it('writes structured lines to output and keeps multi-line traceback bodies', async () => {
    const h = makeHarness();
    h.controller.start();
    await vi.advanceTimersByTimeAsync(0);
    h.sockets[0].emit('data', logReceipt(ERROR_LINE));
    h.sockets[0].emit('data', logReceipt(INFO_LINE));

    const lines = h.output.lines;
    expect(lines.some(l => l.includes('[ERROR]') && l.includes('cellapp01') && l.includes('16:30:00'))).toBe(true);
    // traceback 体多行整体进通道(与源行同现,不拆散)
    const joined = lines.join('\n');
    expect(joined).toContain('Traceback (most recent call last):');
    expect(joined).toContain('"scripts/cell/Avatar.py", line 21');
    expect(lines.some(l => l.includes('[INFO]') && l.includes('logger00'))).toBe(true);
    // 错误行进跳转台账
    expect(h.controller.getJumpTargets()).toHaveLength(1);
    expect(h.controller.getJumpTargets()[0].location.file).toBe('scripts/cell/Avatar.py');
    h.controller.dispose();
  });

  it('honors the component filter (kbengine.consoleLogTail.components)', async () => {
    const h = makeHarness({ components: ['logger'] });
    h.controller.start();
    await vi.advanceTimersByTimeAsync(0);
    h.sockets[0].emit('data', logReceipt(ERROR_LINE));
    h.sockets[0].emit('data', logReceipt(INFO_LINE));
    const joined = h.output.lines.join('\n');
    expect(joined).toContain('logger00');
    expect(joined).not.toContain('cellapp01');
    h.controller.dispose();
  });

  it('re-reads the component filter after reconnect (next-connect-effective, not activation snapshot)', async () => {
    const h = makeHarness(); // 初始无过滤
    h.controller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.controller.getState()).toBe('connected');
    // 第一段:不过滤,cellapp01 放行
    h.sockets[0].emit('data', logReceipt(ERROR_LINE));
    expect(h.output.lines.join('\n')).toContain('cellapp01');
    // 改过滤为只看 logger(模拟用户在设置里改 consoleLogTail.components)
    h.config.components = ['logger'];
    // 断线重连
    h.controller.stop();
    await vi.advanceTimersByTimeAsync(0);
    h.controller.toggle();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.controller.getState()).toBe('connected');
    // 第二段:重连后按新过滤,cellapp01 被拦、logger00 放行
    // 只断言重连后新增的行(第一段不过滤时 cellapp01 已合法出现,不能拿
    // 全量累计输出断言「不再含 cellapp01」)
    const afterReconnect = h.output.lines.length;
    h.sockets.at(-1)!.emit('data', logReceipt(ERROR_LINE));
    h.sockets.at(-1)!.emit('data', logReceipt(INFO_LINE));
    const joined = h.output.lines.slice(afterReconnect).join('\n');
    expect(joined).not.toContain('cellapp01');
    expect(joined).toContain('logger00');
    h.controller.dispose();
  });

  it('reconnects with exponential backoff and caps at the maximum', async () => {
    const h = makeHarness();
    h.controller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.controller.getState()).toBe('connected');

    h.sockets[0].emit('error', new Error('ECONNRESET'));
    expect(h.controller.getState()).toBe('backoff');
    await vi.advanceTimersByTimeAsync(999);
    expect(h.sockets).toHaveLength(1); // 1s 未到不重连
    await vi.advanceTimersByTimeAsync(1);
    expect(h.sockets).toHaveLength(2);

    // 连上又断:退避翻倍
    h.sockets[1].emit('error', new Error('ECONNRESET'));
    await vi.advanceTimersByTimeAsync(1999);
    expect(h.sockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.sockets).toHaveLength(3);

    // 连续失败退避翻倍:1s→2s→4s→8s→16s→32s 封顶 30s
    h.sockets[2].emit('error', new Error('x'));
    await vi.advanceTimersByTimeAsync(3999);
    expect(h.sockets).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.sockets).toHaveLength(4);
    h.sockets[3].emit('error', new Error('x'));
    await vi.advanceTimersByTimeAsync(7999);
    expect(h.sockets).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.sockets).toHaveLength(5);
    h.sockets[4].emit('error', new Error('x'));
    await vi.advanceTimersByTimeAsync(15999);
    expect(h.sockets).toHaveLength(5);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.sockets).toHaveLength(6);
    h.sockets[5].emit('error', new Error('x'));
    await vi.advanceTimersByTimeAsync(29999);
    expect(h.sockets).toHaveLength(6);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.sockets).toHaveLength(7);
    h.controller.dispose();
  });

  it('resets backoff after a prior connection that stayed up past the stability window', async () => {
    const h = makeHarness();
    h.controller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.controller.getState()).toBe('connected');
    // 活满 60s 稳定窗 → 断开后清零,下一轮从 1s 起
    await vi.advanceTimersByTimeAsync(60000);
    h.sockets[0].emit('error', new Error('ECONNRESET'));
    await vi.advanceTimersByTimeAsync(999);
    expect(h.sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.sockets).toHaveLength(2); // 1s 档(不是 2s:退避已清零)
    h.controller.dispose();
  });

  it('does not reset backoff for short-lived connections (lifetime, not offline gap, decides)', async () => {
    // 口径:清零判定在「下次 connect」读上一次连接的实际存活时长(<60s 即不清零),
    // 不看断线到重连之间的离线间隔——短命连接后即使离线很久,退避仍续档。
    const h = makeHarness();
    h.controller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.controller.getState()).toBe('connected');
    // 首连只活 5s 就断 → 上次存活 <60s,退避从 1s 档起(未清零)
    await vi.advanceTimersByTimeAsync(5000);
    h.sockets[0].emit('error', new Error('x'));
    await vi.advanceTimersByTimeAsync(999);
    expect(h.sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.sockets).toHaveLength(2); // 1s 档
    // 第二连仍短命 → 不清零,续档到 2s
    await vi.advanceTimersByTimeAsync(5000);
    h.sockets[1].emit('error', new Error('x'));
    await vi.advanceTimersByTimeAsync(1999);
    expect(h.sockets).toHaveLength(2); // 未在 1s 重连 → 未清零
    await vi.advanceTimersByTimeAsync(1);
    expect(h.sockets).toHaveLength(3); // 2s 档
    // 第三连短命 → 续档到 4s(离线间隔本身不参与稳定判定)
    await vi.advanceTimersByTimeAsync(5000);
    h.sockets[2].emit('error', new Error('x'));
    await vi.advanceTimersByTimeAsync(3999);
    expect(h.sockets).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.sockets).toHaveLength(4); // 4s 档
    h.controller.dispose();
  });

  it('sends the 703 deregistration and a heartbeat tick while connected', async () => {
    const h = makeHarness();
    h.controller.start();
    await vi.advanceTimersByTimeAsync(0);
    h.sockets[0].writes.length = 0;
    await vi.advanceTimersByTimeAsync(10000);
    // 701 心跳:NETWORK_FIXED_MESSAGE 定长帧 = 2 字节消息号 + 定长 body(无长度字段)
    const tick = h.sockets[0].writes.at(-1)!;
    expect(tick.readUInt16LE(0)).toBe(701);
    expect(tick.length).toBe(2 + 12);
    expect(tick.readInt32LE(2)).toBe(9); // COMPONENT_TYPE 直接跟在消息号后(偏移 2 非 4)

    h.controller.stop();
    const stopFrames = h.sockets[0].writes;
    expect(stopFrames.some(b => b.readUInt16LE(0) === 703)).toBe(true);
    expect(h.sockets[0].destroyed).toBe(true);
    expect(h.controller.getState()).toBe('disabled');
    h.controller.dispose();
  });

  it('does nothing when disabled by config', async () => {
    const h = makeHarness({ enabled: false });
    h.controller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.sockets).toHaveLength(0);
    expect(h.controller.getState()).toBe('disabled');
    h.controller.dispose();
  });

  it('toggle flips disabled → connected and connected → disabled', async () => {
    const h = makeHarness({ enabled: false });
    h.controller.toggle();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.controller.getState()).toBe('connected');
    h.controller.toggle();
    expect(h.controller.getState()).toBe('disabled');
    h.controller.dispose();
  });
});

describe('formatTailLine', () => {
  it('formats structured lines and passes raw text through honestly', () => {
    const formatted = formatTailLine(ERROR_LINE);
    expect(formatted).toContain('[ERROR]');
    expect(formatted).toContain('cellapp01');
    expect(formatted).toContain('Traceback (most recent call last):');
    const raw = formatTailLine('not a logstream line');
    expect(raw).toBe('not a logstream line');
  });
});

describe('buildTailCodeActions (IDE-LIV-007 wiring)', () => {
  it('offers a jump action for error lines carrying a traceback', () => {
    const actions = buildTailCodeActions(ERROR_LINE, () => ({ absolutePath: '/ws/scripts/cell/Avatar.py' }));
    expect(actions).toHaveLength(1);
    expect(actions[0].title).toContain('Avatar.py');
    expect(actions[0].file).toBe('/ws/scripts/cell/Avatar.py');
    expect(actions[0].line).toBe(21);
  });

  it('offers nothing for non-error lines or unresolvable sources', () => {
    expect(buildTailCodeActions(INFO_LINE, () => '/ws/x.py')).toHaveLength(0);
    expect(buildTailCodeActions(ERROR_LINE, () => null)).toHaveLength(0);
    expect(buildTailCodeActions('plain', () => '/ws/x.py')).toHaveLength(0);
  });
});
