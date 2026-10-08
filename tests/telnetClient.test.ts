import * as net from 'net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BUILTIN_QUICK_COMMANDS,
  isCommandAllowed,
  KBEngineTelnetClient,
  looksLikePrompt,
  parseBanner,
  stripAnsiEscapes,
  stripTelnetControl,
  TelnetClientState
} from '../src/telnetClient';

// KBEngineTelnetClient 与引擎 telnet_server.cpp/telnet_handler.cpp 的对齐
// 验证:真 TCP localhost 仿真服务端按引擎剧本发字节(欢迎横幅/password:
// 提示/IAC 协商噪声/密码拒重提示/提示符),断言三态握手、密码只写 socket、
// :quit 恒拒、断线翻转。

const servers: net.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve())))
  );
});

const listen = (handler: (socket: net.Socket) => void): Promise<number> =>
  new Promise(resolve => {
    const server = net.createServer(handler);
    servers.push(server);
    server.listen(0, '127.0.0.1', () => {
      resolve((server.address() as net.AddressInfo).port);
    });
  });

const untilState = async (
  client: KBEngineTelnetClient,
  state: TelnetClientState,
  timeoutMs = 2000
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (client.state !== state) {
    if (Date.now() > deadline) {
      throw new Error(`state not reached: ${state} (current: ${client.state})`);
    }
    await new Promise(resolve => setTimeout(resolve, 15));
  }
};

const collect = (client: KBEngineTelnetClient): { chunks: string[]; closes: boolean[] } => {
  const collected = { chunks: [] as string[], closes: [] as boolean[] };
  client.options.events.onData = text => collected.chunks.push(text);
  client.options.events.onClose = hadError => collected.closes.push(hadError);
  return collected;
};

const makeClient = (port: number, password?: string): KBEngineTelnetClient =>
  new KBEngineTelnetClient({
    host: '127.0.0.1',
    port,
    password,
    events: {}
  });

describe('telnet 文本清洗纯函数', () => {
  it('stripTelnetControl:协商两字节/子协商整段吞掉,IAC IAC 转义为字面 IAC', () => {
    const plain = Buffer.from('hello');
    expect(stripTelnetControl(plain).toString()).toBe('hello');

    // IAC DO ECHO(255 253 1) + IAC WILL SUPPRESS_GO_AHEAD(255 251 3)
    const negotiate = Buffer.from([104, 255, 253, 1, 255, 251, 3, 105]);
    expect(stripTelnetControl(negotiate).toString()).toBe('hi');

    // IAC SB 31 <payload> IAC SE 整段吞
    const sub = Buffer.from([255, 250, 31, 7, 7, 255, 240, 65]);
    expect(stripTelnetControl(sub).toString()).toBe('A');

    // IAC IAC → 字面 IAC
    const escaped = Buffer.from([65, 255, 255, 66]);
    expect([...stripTelnetControl(escaped)]).toEqual([65, 255, 66]);

    // IAC + 非协商字节(未知两字节命令):命令字节吞掉、正文保留
    const unknown = Buffer.from([65, 255, 200, 66]);
    expect([...stripTelnetControl(unknown)]).toEqual([65, 66]);
  });

  it('stripAnsiEscapes:CSI 与单字符 ESC 序列剥除,正文保留', () => {
    expect(stripAnsiEscapes('\x1b[32mok\x1b[0m')).toBe('ok');
    // ESC + 单字符(0x40-0x7E)序列整段剥除
    expect(stripAnsiEscapes('a\x1bb')).toBe('a');
    expect(stripAnsiEscapes('plain')).toBe('plain');
  });

  it('parseBanner:password: 提示/密码拒提示符/普通横幅三判', () => {
    expect(parseBanner('password:')).toEqual({
      requiresPassword: true,
      passwordRejected: false,
      text: 'password:'
    });
    expect(parseBanner('[dbmgr@password ~]# \r\n')).toMatchObject({
      requiresPassword: false,
      passwordRejected: true
    });
    const banner = parseBanner('KBEngine Welcome\r\n');
    expect(banner.requiresPassword).toBe(false);
    expect(banner.passwordRejected).toBe(false);
    expect(banner.text).toBe('KBEngine Welcome');
  });

  it('looksLikePrompt:引擎 root 层 # 与 python 层 >>> 识别', () => {
    expect(looksLikePrompt('[cellapp@python ~]# ')).toBe(true);
    expect(looksLikePrompt('[cellapp@root ~]# ')).toBe(true);
    expect(looksLikePrompt('[cellapp@python ~] >>> ')).toBe(true);
    expect(looksLikePrompt('some command output')).toBe(false);
    expect(looksLikePrompt('')).toBe(false);
  });

  it('isCommandAllowed:精确/带参前缀/空命令/:quit 恒拒/空白白名单项', () => {
    const whitelist = ['getCtrlEntities', 'set', '  '];
    expect(isCommandAllowed('getCtrlEntities', whitelist)).toBe(true);
    expect(isCommandAllowed('  getCtrlEntities  ', whitelist)).toBe(true);
    expect(isCommandAllowed('set foo bar', whitelist)).toBe(true);
    expect(isCommandAllowed('setfoo', whitelist)).toBe(false);
    expect(isCommandAllowed('len(entities)', whitelist)).toBe(false);
    expect(isCommandAllowed('', whitelist)).toBe(false);
    expect(isCommandAllowed('   ', whitelist)).toBe(false);
    // :quit 会关闭服务端进程,配进白名单也恒拒
    expect(isCommandAllowed(':quit', [':quit'])).toBe(false);
    expect(isCommandAllowed(':QUIT', whitelist)).toBe(false);
  });

  it('内置快捷命令均为只读表达式', () => {
    expect(BUILTIN_QUICK_COMMANDS.map(entry => entry.command)).toEqual([
      'len(entities)',
      'sorted(entities.keys())[:50]',
      'list(KBEngine.globalData.keys())',
      ':help'
    ]);
  });
});

describe('KBEngineTelnetClient 边界分支', () => {
  it('服务端只发协商字节(清洗后空文本):不触发 onData 也不翻转状态', async () => {
    const port = await listen(socket => {
      socket.write(Buffer.from([255, 251, 3]));
    });
    const client = makeClient(port);
    const collected = collect(client);
    client.connect();

    await new Promise(resolve => setTimeout(resolve, 60));
    expect(collected.chunks).toEqual([]);
    expect(client.state).toBe('connecting');
    client.disconnect();
  });

  it('非提示符下行文本(横幅片段):入 onData 但不翻转 ready', async () => {
    const port = await listen(socket => {
      socket.write('KBEngine 正在启动,请稍候\r\n');
    });
    const client = makeClient(port);
    const collected = collect(client);
    client.connect();

    await new Promise(resolve => setTimeout(resolve, 60));
    expect(collected.chunks.join('')).toContain('KBEngine 正在启动');
    expect(client.state).toBe('connecting'); // 无提示符不得就绪
    client.disconnect();
  });

  it('会话未就绪(connecting 态)sendCommand 拒绝', async () => {
    // 连接一个永不应答的端口:状态停在 connecting
    const port = await listen(() => undefined);
    const client = makeClient(port);
    client.connect();

    expect(client.state).toBe('connecting');
    expect(client.sendCommand('len(entities)')).toBe(false);
    client.disconnect();
  });
});

describe('KBEngineTelnetClient 握手三态(真 TCP localhost 仿真)', () => {
  it('无密码组件:连接后直接欢迎横幅 + 提示符 → ready,清洗后文本入 onData', async () => {
    const port = await listen(socket => {
      // 引擎协商噪声 + 欢迎横幅 + python 层提示符
      socket.write(Buffer.from([255, 251, 3]));
      socket.write('KBEngine cellapp Welcome\r\n[cellapp@python ~]# ');
    });
    const client = makeClient(port);
    const collected = collect(client);
    client.connect();

    await untilState(client, 'ready');
    expect(collected.chunks.join('')).toContain('KBEngine cellapp Welcome');
    expect(collected.chunks.join('')).toContain('[cellapp@python ~]#');
    client.disconnect();
  });

  it('有密码组件:先 password: 提示,密码经 socket 提交后进 ready(密码不出现在 onData)', async () => {
    let received = '';
    const port = await listen(socket => {
      socket.write('password:');
      socket.on('data', chunk => {
        received = chunk.toString();
        socket.write('Welcome dbmgr\r\n[dbmgr@python ~]# ');
      });
    });
    const client = makeClient(port, 'pwd123456');
    const collected = collect(client);
    client.connect();

    await untilState(client, 'ready');
    expect(received.trim()).toBe('pwd123456');
    expect(collected.chunks.join('')).not.toContain('pwd123456');
    client.disconnect();
  });

  it('密码被拒:引擎停在 PASSWD 态重发 @password 提示符 → auth-rejected;随后断线 detail 区分', async () => {
    let serverSocket: net.Socket | null = null;
    const port = await listen(socket => {
      socket.on('error', () => undefined);
      socket.on('end', () => socket.end());
      serverSocket = socket;
      socket.write('password:');
      socket.on('data', () => {
        socket.write('[dbmgr@password ~]# ');
      });
    });
    const client = makeClient(port, 'wrong-password');
    const collected = collect(client);
    client.connect();

    await untilState(client, 'auth-rejected');
    serverSocket!.destroy(new Error('ECONNRESET'));
    await untilState(client, 'closed');
    // auth-rejected 后的 close:detail 走「认证被拒后连接关闭」分支
    expect(collected.closes).toEqual([false]);
  });

  it('不装 onClose/onData 回调也能完整走完 close 清理', async () => {
    const port = await listen(socket => {
      socket.on('error', () => undefined);
      socket.write('[cellapp@python ~]# ');
    });
    const client = new KBEngineTelnetClient({
      host: '127.0.0.1',
      port,
      events: { onStateChange: state => void state }
    });
    client.connect();
    await untilState(client, 'ready');
    client.disconnect();
    expect(client.state).toBe('closed');
  });

  it('未配密码:端口通但停在 awaiting-password,不自动登录', async () => {
    const port = await listen(socket => {
      socket.write('password:');
    });
    const client = makeClient(port);
    client.connect();

    await untilState(client, 'awaiting-password');
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(client.state).toBe('awaiting-password');
    client.disconnect();
  });

  it('ready 后 sendCommand 经服务层语义直接发送,:quit 恒拒', async () => {
    let received = '';
    const port = await listen(socket => {
      socket.write('[cellapp@python ~]# ');
      socket.on('data', chunk => {
        received = chunk.toString();
      });
    });
    const client = makeClient(port);
    client.connect();
    await untilState(client, 'ready');

    expect(client.sendCommand('len(entities)')).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(received).toBe('len(entities)\r\n');

    expect(client.sendCommand(':quit')).toBe(false);
    client.disconnect();
  });

  it('服务端断线:onClose 通知且状态翻转 closed;重连可再握手', async () => {
    let acceptCount = 0;
    const port = await listen(socket => {
      socket.on('error', () => undefined); // 服务端 RST 侧:吞掉自身 error 事件
      acceptCount += 1;
      if (acceptCount === 1) {
        // 首连即 RST 断线,模拟运行中断(引擎进程死)
        setTimeout(() => socket.destroy(new Error('ECONNRESET')), 20);
      } else {
        socket.write('[cellapp@python ~]# ');
      }
    });
    const client = makeClient(port);
    const collected = collect(client);
    client.connect();

    await untilState(client, 'closed');
    // 服务端 RST 到客户端走 EOF 路径,hadError 如实为 false;断线以 close 通知为准
    expect(collected.closes).toEqual([false]);

    client.connect();
    await untilState(client, 'ready');
    client.disconnect();
  });

  it('connect 失败(端口未开):error + close → closed 并通知 onClose', async () => {
    // 占住一个端口然后立刻关掉,拿到一个确定无人监听的端口号
    const port = await new Promise<number>(resolve => {
      const probe = net.createServer();
      probe.listen(0, '127.0.0.1', () => {
        const address = (probe.address() as net.AddressInfo).port;
        probe.close(() => resolve(address));
      });
    });
    const client = makeClient(port);
    const collected = collect(client);
    client.connect();

    await untilState(client, 'closed');
    expect(collected.closes).toEqual([true]);
  });

  it('disconnect 主动断开:状态 closed,重复 connect 在会话存活期内被忽略', async () => {
    const port = await listen(socket => {
      socket.write('[cellapp@python ~]# ');
    });
    const client = makeClient(port);
    client.connect();
    await untilState(client, 'ready');

    client.connect();
    client.disconnect();
    expect(client.state).toBe('closed');
    client.disconnect();
    expect(client.state).toBe('closed');
  });
});
