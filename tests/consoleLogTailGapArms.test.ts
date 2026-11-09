import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONSOLE_LOG_MSG_ID, buildFrame } from '../src/backend/kbengineProtocol';
import { ConsoleLogTailController, buildTailCodeActions, type TailJumpTarget } from '../src/backend/consoleLogTail';

// consoleLogTail.ts 缺口臂(2026-11-09 覆盖率扫尾):
//   buildTailCodeActions 的「错误级但无 file:line 落点 → 如实空」(L113)、
//   默认 createConnection 工厂构造面(L156)、start() 重入早退(L161)、
//   stop() 清重连定时器(L189-190)、resolveJumpTarget 落点解析空/命中两面
//   (L218-219)、attemptConnect 重入守卫(L261)、close 事件断流(L326)、
//   machined 不可达通知去重(notice 守卫)、半帧缓冲等待(L400)、
//   非 65501 帧跳过(L405)、畸形 body 跳过(L409)、跳转台账截断(L433)。
//
// 记录的死臂(附证据,不伪造套接字行为强测):
//   * L284-285(connect 陈旧守卫 `if (this.socket !== socket)` + destroy):
//     不可达。once('connect') 处理器在 attemptConnect 内 this.socket=socket
//     赋值(280)之后才注册(282);this.socket 之后只有两条离开路径——
//     (a) teardownSocket 置 null,但它在置空前 removeAllListeners('connect')
//     (360),处理器已被摘除,emit 到不了;(b) 下一次 attemptConnect 重赋值,
//     但其入口守卫(260)要求 state ∉ {connected, connecting},而 socket 尚未
//     connect/断开期间 state 恒为 connecting——归纳可证:处理器可触发的任一
//     时刻恒有 this.socket === socket。工厂内同步 emit 更到不了(监听器尚未
//     注册,EventEmitter 静默丢弃)。
//   * L318(data 陈旧守卫 `if (this.socket !== socket) return`):
//     不可达,同一不变量。data 监听(316)注册时 this.socket 已 === socket;
//     this.socket 的两条离开路径与上同——teardownSocket 先移除 data 监听
//     (357)再置空;重赋值的 attemptConnect 被 260 守卫挡在 connecting 态。
//   * L373-374(handleDisconnect 陈旧守卫 `if (this.socket !== socket) return`):
//     不可达,与 L318 同一不变量。error/close 监听(322-327)在 attemptConnect
//     注册时 this.socket 已 === socket;this.socket 的两条离开路径——teardownSocket
//     先移除 error/close 监听(358-359)再置空(353);重赋值的 attemptConnect 被
//     260 守卫挡在非 connecting 态(该态下旧 socket 已被拆除)。
//   * L382(handleDisconnect `if (!this.started) return`):
//     不可达。this.started 只在 stop() 置 false,而 stop() 先 teardownSocket
//     (移除 error/close 监听)再继续;handleDisconnect 只由 error/close 监听
//     触发,监听只在 attemptConnect(started=true)里注册——stop 后无监听器,
//     断流回调不可能以 !started 进入。
//   * L156 默认工厂箭头函数体(options => net.connect(...)):
//     net.connect 是真实 TCP 拨号,按本测试纪律(零真网)不可调用;L156 赋值
//     语句本身由「不传 createConnection 构造」用例执行(语句面已覆盖),工厂体
//     只有真实连接才触发,如实记录为不可达。

interface FakeSocket extends EventEmitter {
  writes: Buffer[];
  destroyed: boolean;
  destroy(): void;
}

const makeFakeSocket = (): FakeSocket => {
  const socket = new EventEmitter() as FakeSocket;
  socket.writes = [];
  socket.destroyed = false;
  socket.write = ((chunk: Buffer) => {
    socket.writes.push(Buffer.from(chunk));
    return true;
  }) as FakeSocket['write'];
  socket.destroy = () => {
    socket.destroyed = true;
  };
  return socket;
};

/** 65501 帧(与 reference harness 同构):4 字节长度前缀 + 文本。 */
const logReceipt = (line: string): Buffer => {
  const blob = Buffer.from(line, 'utf8');
  const body = Buffer.alloc(4 + blob.length);
  body.writeUInt32LE(blob.length, 0);
  blob.copy(body, 4);
  return buildFrame(CONSOLE_LOG_MSG_ID, body);
};

const ERROR_LINE = '   ERROR cellapp01 1000 7129652375332859799 [2026-11-07 16:30:00 123] - Traceback (most recent call last):\n  File "scripts/cell/Avatar.py", line 21, in onTimer';
/** 错误级但消息无 file:line 落点 → buildTailCodeActions 如实空(L113)。 */
const ERROR_NO_SOURCE_LINE = '   ERROR cellapp01 1000 111 [2026-11-07 16:30:01 4] - generic failure';

interface Harness {
  controller: ConsoleLogTailController;
  sockets: FakeSocket[];
  output: { lines: string[] };
}

const makeHarness = (): Harness => {
  const sockets: FakeSocket[] = [];
  const output = { lines: [] as string[] };

  const controller = new ConsoleLogTailController({
    hub: {
      getLogger: () => ({ intaddr: '192.168.5.117', intport: 30010, uid: 1001, componentID: 900n }),
      getMachinedState: () => 'reachable',
      onDidChange: (_cb: () => void) => ({ dispose: () => undefined })
    },
    workspaceRoots: () => ['/ws'],
    resolveSource: () => null,
    output: {
      appendLine: (line: string) => {
        output.lines.push(line);
      },
      show: () => undefined
    },
    statusItem: {
      text: '',
      show: () => undefined,
      hide: () => undefined
    },
    getConfig: () => ({ enabled: true, components: [] }),
    createConnection: () => {
      const socket = makeFakeSocket();
      sockets.push(socket);
      queueMicrotask(() => {
        socket.emit('connect');
      });
      return socket;
    },
    backoffBaseMs: 1000,
    backoffMaxMs: 30000,
    tickIntervalMs: 10000
  });
  return { controller, sockets, output };
};

/** 不连真网的静默控制器(构造面用):machined 不可达,永不拨号。 */
const makeDormantController = (resolveSource: () => { absolutePath: string } | null): ConsoleLogTailController => new ConsoleLogTailController({
  hub: {
    getLogger: () => undefined,
    getMachinedState: () => 'unreachable',
    onDidChange: () => ({ dispose: () => undefined })
  },
  workspaceRoots: () => ['/ws'],
  resolveSource,
  output: { appendLine: () => undefined, show: () => undefined },
  statusItem: { text: '', show: () => undefined, hide: () => undefined },
  getConfig: () => ({ enabled: false, components: [] })
});

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('consoleLogTail 缺口臂:buildTailCodeActions 无落点', () => {
  it('错误级但消息无 file:line → 如实空(L113)', () => {
    expect(buildTailCodeActions(ERROR_NO_SOURCE_LINE, () => ({ absolutePath: '/ws/x.py' }))).toEqual([]);
  });
});

describe('consoleLogTail 缺口臂:构造与生命周期', () => {
  it('默认 createConnection 工厂构造面(不传 createConnection,不启动 → 无真网)(L156)', () => {
    // 不传 createConnection 走 `deps.createConnection ?? ((options) => net.connect(...))`
    // (L156 语句面);machined 不可达 + start() 不调,永不触发真实拨号。
    const controller = makeDormantController(() => null);
    expect(controller.getState()).toBe('disabled');
    controller.dispose();
  });

  it('start() 二次调用直接早退(L161)', async () => {
    const h = makeHarness();
    h.controller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.controller.getState()).toBe('connected');
    h.controller.start(); // 已 started → 早退
    expect(h.sockets).toHaveLength(1);
    h.controller.dispose();
  });

  it('stop() 清挂起重连定时器(L189-190)', async () => {
    const h = makeHarness();
    h.controller.start();
    await vi.advanceTimersByTimeAsync(0);
    // 断开 → 退避定时器挂起
    h.sockets[0].emit('error', new Error('ECONNRESET'));
    expect(h.controller.getState()).toBe('backoff');
    // stop() 清定时器:推进时间不再重连
    h.controller.stop();
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.sockets).toHaveLength(1);
    expect(h.controller.getState()).toBe('disabled');
  });
});

describe('consoleLogTail 缺口臂:resolveJumpTarget 两面(L218-219)', () => {
  it('落点解析命中 → 绝对路径;落空 → null', () => {
    const hitController = makeDormantController(() => ({ absolutePath: '/ws/scripts/cell/Avatar.py' }));
    const missController = makeDormantController(() => null);
    const target = {
      raw: ERROR_LINE,
      parsed: {
        level: 'ERROR',
        component: 'cellapp',
        groupOrder: 1,
        uid: 1000,
        componentID: '3',
        timestamp: '[2026-11-07 16:30:00 123]',
        message: 'File "scripts/cell/Avatar.py", line 21, in onTimer'
      },
      location: { file: 'scripts/cell/Avatar.py', line: 21 }
    } as unknown as TailJumpTarget;
    expect(hitController.resolveJumpTarget(target)).toBe('/ws/scripts/cell/Avatar.py');
    expect(missController.resolveJumpTarget(target)).toBeNull();
    hitController.dispose();
    missController.dispose();
  });
});

describe('consoleLogTail 缺口臂:连接窗口', () => {
  it('attemptConnect 重入守卫(state 已是 connecting → 早退)(L261)', async () => {
    // hub.onDidChange 订阅即同步回调:start() 内订阅触发一次 attemptConnect
    // (state 初始 disabled → 通过守卫,建连进入 connecting),其后 start()
    // 自身的 attemptConnect 看到 connecting → 早退。
    const sockets: FakeSocket[] = [];
    let hubCallback: (() => void) | null = null;
    const output = { lines: [] as string[] };
    const controller = new ConsoleLogTailController({
      hub: {
        getLogger: () => ({ intaddr: '192.168.5.117', intport: 30010, uid: 1001, componentID: 900n }),
        getMachinedState: () => 'reachable',
        onDidChange: (cb: () => void) => {
          hubCallback = cb;
          cb(); // 订阅即同步触发一次(start 真实生产时序:hub 变更先行唤醒)
          return { dispose: () => undefined };
        }
      },
      workspaceRoots: () => [],
      resolveSource: () => null,
      output: {
        appendLine: (line: string) => {
          output.lines.push(line);
        },
        show: () => undefined
      },
      statusItem: { text: '', show: () => undefined, hide: () => undefined },
      getConfig: () => ({ enabled: true, components: [] }),
      createConnection: () => {
        const socket = makeFakeSocket();
        sockets.push(socket);
        queueMicrotask(() => {
          socket.emit('connect');
        });
        return socket;
      },
      backoffBaseMs: 1000,
      backoffMaxMs: 30000,
      tickIntervalMs: 10000
    });
    controller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(hubCallback).not.toBeNull();
    // hub 再唤醒一次:state 已 connected → 守卫早退,不新建套接字
    hubCallback!();
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets).toHaveLength(1);
    expect(controller.getState()).toBe('connected');
    controller.dispose();
  });

  it('close 事件断流进退避(L326)', async () => {
    const h = makeHarness();
    h.controller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.controller.getState()).toBe('connected');
    h.sockets[0].emit('close');
    expect(h.controller.getState()).toBe('backoff');
    h.controller.dispose();
  });

  it('machined 不可达两次通知:同文案去重(notice 守卫)', async () => {
    // machined 不可达 → attemptConnect 写一条 notice;hub 再唤醒 →
    // 同文案再写被 lastNotice 去重(仅一条)。
    const lines: string[] = [];
    let hubCallback: (() => void) | null = null;
    const controller = new ConsoleLogTailController({
      hub: {
        getLogger: () => undefined,
        getMachinedState: () => 'unreachable',
        onDidChange: (cb: () => void) => {
          hubCallback = cb;
          return { dispose: () => undefined };
        }
      },
      workspaceRoots: () => [],
      resolveSource: () => null,
      output: {
        appendLine: (line: string) => {
          lines.push(line);
        },
        show: () => undefined
      },
      statusItem: { text: '', show: () => undefined, hide: () => undefined },
      getConfig: () => ({ enabled: true, components: [] })
    });
    controller.start();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('machined');
    expect(hubCallback).not.toBeNull();
    hubCallback!(); // 再唤醒:同文案被去重
    expect(lines).toHaveLength(1);
    controller.dispose();
  });
});

describe('consoleLogTail 缺口臂:帧解析', () => {
  it('半帧缓冲:长度声明超出当前缓冲 → 等待后续(L400)', async () => {
    const h = makeHarness();
    h.controller.start();
    await vi.advanceTimersByTimeAsync(0);
    // 基线:connect 已写「registered」提示行
    const before = h.output.lines.length;
    // 只发前 4 字节(消息号 + 大 frameLength)→ totalLength 不足 → break
    const full = logReceipt(ERROR_LINE);
    h.sockets[0].emit('data', full.subarray(0, 4));
    expect(h.output.lines).toHaveLength(before);
    // 补发剩余字节 → 整帧解析出日志行
    h.sockets[0].emit('data', full.subarray(4));
    expect(h.output.lines.slice(before).some(l => l.includes('[ERROR]'))).toBe(true);
    h.controller.dispose();
  });

  it('非 65501 消息号帧跳过(L405)', async () => {
    const h = makeHarness();
    h.controller.start();
    await vi.advanceTimersByTimeAsync(0);
    const before = h.output.lines.length;
    // 702 注册帧同构:消息号 ≠ 65501 → continue
    const body = Buffer.alloc(4);
    body.writeUInt32LE(2, 0);
    h.sockets[0].emit('data', buildFrame(702, body));
    expect(h.output.lines).toHaveLength(before);
    expect(h.controller.getJumpTargets()).toHaveLength(0);
    h.controller.dispose();
  });

  it('畸形 body(长度前缀超实际)→ parseConsoleLogBody null → 跳过(L409)', async () => {
    const h = makeHarness();
    h.controller.start();
    await vi.advanceTimersByTimeAsync(0);
    const before = h.output.lines.length;
    // body 声明长度 50,实际只有 4 字节文本 → 4+50 > 8 → null → continue
    const blob = Buffer.from('boom', 'utf8');
    const body = Buffer.alloc(4 + blob.length);
    body.writeUInt32LE(50, 0);
    blob.copy(body, 4);
    h.sockets[0].emit('data', buildFrame(CONSOLE_LOG_MSG_ID, body));
    expect(h.output.lines).toHaveLength(before);
    h.controller.dispose();
  });

  it('跳转台账超 50 条截断(L433)', async () => {
    const h = makeHarness();
    h.controller.start();
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 51; i += 1) {
      h.sockets[0].emit('data', logReceipt(ERROR_LINE));
    }
    const targets = h.controller.getJumpTargets();
    expect(targets).toHaveLength(50);
    expect(targets[0].parsed.message).toContain('line 21');
    h.controller.dispose();
  });
});
