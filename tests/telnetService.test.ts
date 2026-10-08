import { EventEmitter } from 'events';
import * as net from 'net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildTelnetTargets,
  makeProbeOne,
  parseKbengineXmlTelnet,
  TelnetService,
  TelnetTarget
} from '../src/telnetService';

// TelnetService 探测状态机与联动:目标解析(设置 → kbengine.xml → 引擎
// 默认表)、注入型探测/定时器的状态迁移、真 TCP 会话的自动登录/白名单
// 闸/输出回显/断线拆除、dispose 清理。密码只写 socket,不进输出面。

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

const until = async (predicate: () => boolean, timeoutMs = 2000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('condition not met before deadline');
    }
    await new Promise(resolve => setTimeout(resolve, 15));
  }
};

const makeTimers = () => {
  const jobs: Array<{ callback: () => void }> = [];
  return {
    jobs,
    tick(): void {
      for (const job of [...jobs]) {
        job.callback();
      }
    },
    timers: {
      setInterval(callback: () => void): unknown {
        const job = { callback };
        jobs.push(job);
        return job;
      },
      clearInterval(handle: unknown): void {
        const index = jobs.indexOf(handle as { callback: () => void });
        if (index >= 0) {
          jobs.splice(index, 1);
        }
      }
    }
  };
};

const settings = (over: Partial<Parameters<typeof buildTelnetTargets>[0]> = {}) => ({
  host: '127.0.0.1',
  port: 0,
  password: '',
  enableCommands: [] as string[],
  ...over
});

describe('parseKbengineXmlTelnet', () => {
  it('解析 <telnet_service> 的端口/密码/默认层(容忍空白)', () => {
    const xml = [
      '<root>',
      '  <telnet_service>',
      '    <port> 31000 </port>',
      '    <password> pwd123456 </password>',
      '    <default_layer> python </default_layer>',
      '  </telnet_service>',
      '</root>'
    ].join('\n');
    expect(parseKbengineXmlTelnet(xml)).toEqual({
      port: 31000,
      password: 'pwd123456',
      defaultLayer: 'python'
    });
  });

  it('无 <telnet_service> 段返回 null;空标签解析为 undefined', () => {
    expect(parseKbengineXmlTelnet('<root><other/></root>')).toBeNull();
    expect(
      parseKbengineXmlTelnet('<telnet_service><port></port><password>  </password></telnet_service>')
    ).toEqual({ port: undefined, password: undefined, defaultLayer: undefined });
  });
});

describe('buildTelnetTargets', () => {
  it('设置显式 port > 0:单目标,优先设置密码', () => {
    const targets = buildTelnetTargets(settings({ port: 31000, password: 'set-pwd' }), {
      port: 32000,
      password: 'xml-pwd'
    });
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({
      key: '127.0.0.1:31000',
      label: '自定义目标',
      port: 31000,
      password: 'set-pwd'
    });
  });

  it('设置未指定端口:回落 kbengine.xml 段端口与密码', () => {
    const targets = buildTelnetTargets(settings(), { port: 33000, password: 'xml-pwd' });
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({ key: '127.0.0.1:33000', label: 'kbengine.xml', port: 33000, password: 'xml-pwd' });
  });

  it('设置与 xml 均无端口:引擎默认七组件端口表,密码沿用设置', () => {
    const targets = buildTelnetTargets(settings({ password: 'p', enableCommands: ['get'] }), null);
    expect(targets.map(target => `${target.component}:${target.port}`)).toEqual([
      'loginapp:31000', 'dbmgr:32000', 'interfaces:33000', 'logger:34000',
      'baseapp:40000', 'cellapp:50000', 'bots:51000'
    ]);
    expect(targets[0].password).toBe('p');
    expect(targets[0].enableCommands).toEqual(['get']);
  });

  it('设置显式端口且无密码无 xml:password 尾臂落空串', () => {
    const targets = buildTelnetTargets(settings({ port: 31000 }), null);
    expect(targets[0].password).toBe('');
  });

  it('host 空白回落 127.0.0.1', () => {
    const targets = buildTelnetTargets(settings({ host: '   ' }), null);
    expect(targets[0].host).toBe('127.0.0.1');
  });
});

describe('TelnetService 探测状态机(注入探测/定时器)', () => {
  const makeService = (
    targets: TelnetTarget[],
    probePorts: Set<number>,
    intervalMs = 5000
  ): {
    service: TelnetService;
    timers: ReturnType<typeof makeTimers>;
    changes: { count: number };
  } => {
    const kit = makeTimers();
    // 计数器走对象:数字返回值是快照,闭包后续递增不可见
    const changes = { count: 0 };
    const service = new TelnetService({
      getTargets: () => targets,
      probeOne: async (host, port) => probePorts.has(port),
      intervalMs,
      timers: kit.timers
    });
    service.onDidChange(() => {
      changes.count += 1;
    });
    return { service, timers: kit, changes };
  };

  const target = (port: number, over: Partial<TelnetTarget> = {}): TelnetTarget => ({
    key: `127.0.0.1:${port}`,
    label: `comp-${port}`,
    component: `comp-${port}`,
    host: '127.0.0.1',
    port,
    password: '',
    enableCommands: [],
    ...over
  });

  it('端口开且有密码 → open;开但无密码 → auth-required;未开 → closed', async () => {
    const targets = [target(31000, { password: 'p' }), target(32000), target(33000)];
    const kit = makeService(targets, new Set([31000, 32000]));
    const { service } = kit;
    service.start();

    // 等最后一个真实迁移(auth-required);33000 的 closed 是预设默认值,无信号意义
    await until(() => service.getState('127.0.0.1:32000') === 'auth-required');
    expect(service.getState('127.0.0.1:31000')).toBe('open');
    expect(service.getState('127.0.0.1:33000')).toBe('closed');
    expect(kit.changes.count).toBeGreaterThan(0);
    service.dispose();
  });

  it('状态不变不重复发事件;探测重入被吞;dispose 后 probeOnce 为空转', async () => {
    const targets = [target(31000, { password: 'p' })];
    const kit = makeService(targets, new Set([31000]));
    const { service } = kit;
    service.start();
    await until(() => service.getState('127.0.0.1:31000') === 'open');
    const changesAfterFirst = kit.changes.count;

    // 状态不变的第二轮:不发事件
    kit.timers.tick();
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(kit.changes.count).toBe(changesAfterFirst);
    service.dispose();

    // dispose 后 probeOnce 空转(不炸、不发事件)
    await service.probeOnce();
    expect(kit.changes.count).toBe(changesAfterFirst);
    expect(kit.timers.jobs).toHaveLength(0);
  });

  it('目标集变化随每轮重读:清空时状态表清空', async () => {
    const mutable: TelnetTarget[] = [target(31000, { password: 'p' })];
    const kit = makeService(mutable, new Set([31000]));
    const { service } = kit;
    service.start();
    await until(() => service.getState('127.0.0.1:31000') === 'open');

    mutable.length = 0;
    kit.timers.tick();
    await until(() => service.getTargets().length === 0);
    expect(kit.changes.count).toBeGreaterThan(1);
    service.dispose();
  });

  it('无目标时 start 不挂定时器,状态 unconfigured 语义由 getTargets 空表达', () => {
    const kit = makeService([], new Set());
    kit.service.start();
    expect(kit.timers.jobs).toHaveLength(0);
    // 未知 key 的回落臂:状态 closed、输出空
    expect(kit.service.getState('nope')).toBe('closed');
    expect(kit.service.getOutput('nope')).toEqual([]);
    kit.service.dispose();
    kit.service.dispose(); // 二次 dispose 幂等
  });

  it('start 时状态表已有同 key:不重复预设 closed', async () => {
    const kit = makeService([target(31000, { password: 'p' })], new Set([31000]));
    // 模拟上轮遗留状态:probeOnce 先行落 key,再 start 走 has(key) 假臂
    await kit.service.probeOnce();
    expect(kit.service.getState('127.0.0.1:31000')).toBe('open');
    kit.service.start();
    expect(kit.service.getState('127.0.0.1:31000')).toBe('open'); // 预设不覆盖
    kit.service.dispose();
  });

  it('start 重复调用不重复挂定时器', () => {
    const kit = makeService([target(31000)], new Set());
    kit.service.start();
    kit.service.start();
    expect(kit.timers.jobs).toHaveLength(1);
    kit.service.dispose();
  });
});

describe('TelnetService 联动会话(真 TCP localhost 仿真)', () => {
  const makeRealService = (getTargets: () => TelnetTarget[]): TelnetService =>
    // 不注入 probeOne/timers:走默认实现与默认定时器(interval 拉大避免测试期轮询)
    new TelnetService({ getTargets, intervalMs: 3600000 });

  const engineTarget = (port: number, over: Partial<TelnetTarget> = {}): TelnetTarget => ({
    key: `127.0.0.1:${port}`,
    label: 'dbmgr',
    component: 'dbmgr',
    host: '127.0.0.1',
    port,
    password: 'pwd123456',
    enableCommands: ['getStatus'],
    ...over
  });

  const engineServer = (): Promise<number> =>
    listen(socket => {
      // 探测型连接(defaultProbeOne)探完即 destroy,吞掉服务端侧 ECONNRESET;
      // client 半关(end)时回应 FIN,否则 server 侧 socket 悬挂、close() 永不完成
      socket.on('error', () => undefined);
      socket.on('end', () => socket.end());
      socket.write('password:');
      let authed = false;
      socket.on('data', chunk => {
        const command = chunk.toString().trim();
        if (!authed) {
          // 首条下行即密码:回欢迎横幅 + 提示符(引擎握手语义)
          authed = true;
          socket.write('Welcome dbmgr\r\n[dbmgr@python ~]# ');
          return;
        }
        if (command === 'getStatus') {
          socket.write('status: ok\r\n[dbmgr@python ~]# ');
        } else {
          socket.write(`echo: ${command}\r\n[dbmgr@python ~]# `);
        }
      });
    });

  it('默认 probeOne 真 TCP 探测:端口通 → open,未开 → closed', async () => {
    const port = await engineServer();
    const service = makeRealService(() => [
      engineTarget(port),
      engineTarget(port + 1, { key: `127.0.0.1:${port + 1}`, label: 'ghost' })
    ]);
    service.start();

    await until(() => service.getState(`127.0.0.1:${port}`) === 'open');
    await until(() => service.getState(`127.0.0.1:${port + 1}`) === 'closed');
    service.dispose();
  });

  it('自动登录:connectTarget 后 ready → connected;输出回显入账', async () => {
    const port = await engineServer();
    const service = makeRealService(() => [engineTarget(port)]);
    service.start();

    const outputs: string[] = [];
    service.onOutput(line => outputs.push(line.text));
    service.connectTarget(`127.0.0.1:${port}`);

    await until(() => service.getState(`127.0.0.1:${port}`) === 'connected');
    expect(service.getSessionState(`127.0.0.1:${port}`)).toBe('ready');
    expect(outputs.join('')).toContain('Welcome');
    service.dispose();
  });

  it('白名单闸:enableCommands + 内置快捷命令放行,白名单外与 :quit 拒;拒绝时无会话返回 false', async () => {
    const port = await engineServer();
    const service = makeRealService(() => [engineTarget(port)]);
    const key = `127.0.0.1:${port}`;

    service.start();
    // targets 已就位:会话未建立时过闸命令也返回 false(白名单闸过、无客户端)
    expect(service.sendCommand(key, 'getStatus')).toBe(false);
    // 内置快捷命令豁免(enableCommands 不含)
    expect(service.isAllowed(key, 'len(entities)')).toBe(true);
    expect(service.isAllowed('key-not-exists', 'len(entities)')).toBe(true);

    service.connectTarget(key);
    await until(() => service.getState(key) === 'connected');

    expect(service.sendCommand(key, 'getStatus')).toBe(true);
    expect(service.sendCommand(key, 'getStatus extra-arg')).toBe(true);
    expect(service.sendCommand(key, 'rm -rf /')).toBe(false);
    expect(service.sendCommand(key, ':quit')).toBe(false);
    await until(() => service.getOutput(key).some(line => line.includes('status: ok')));
    service.dispose();
  });

  it('输出超限裁剪到 500 行;断线拆除会话,状态回落由下一轮探测刷新', async () => {
    let clientSocket: net.Socket | null = null;
    const port = await listen(socket => {
      socket.on('error', () => undefined); // 探测型连接探完即 destroy
      socket.on('end', () => socket.end());
      clientSocket = socket;
      socket.write('password:');
      socket.on('data', () => {
        const lines: string[] = [];
        for (let index = 0; index < 505; index += 1) {
          lines.push(`line-${index}`);
        }
        socket.write(`${lines.join('\r\n')}\r\n[dbmgr@python ~]# `);
      });
    });
    const service = makeRealService(() => [engineTarget(port)]);
    const key = `127.0.0.1:${port}`;
    service.start();
    service.connectTarget(key);

    await until(() => service.getState(key) === 'connected');
    await until(() => service.getOutput(key).length > 0);
    await until(() => clientSocket !== null);
    clientSocket!.end();
    await until(() => service.getSessionState(key) === null);

    // 505 行数据 + 1 行提示符 = 506 行,裁到 500:丢最老 6 行(line-0..line-5)
    const output = service.getOutput(key);
    expect(output.length).toBeLessThanOrEqual(500);
    expect(output[0]).toContain('line-6');
    expect(output[output.length - 1]).toContain('[dbmgr@python ~]#');
    service.dispose();
  });

  it('未配密码 target 建会话:停在 awaiting-password → 灯 auth-required;错密码 → auth-rejected', async () => {
    let serverSocket: net.Socket | null = null;
    const port = await listen(socket => {
      socket.on('error', () => undefined);
      socket.on('end', () => socket.end());
      serverSocket = socket;
      socket.write('password:');
      socket.on('data', chunk => {
        const command = chunk.toString().trim();
        if (command === 'pwd123456') {
          socket.write('Welcome\r\n[dbmgr@python ~]# ');
        } else {
          socket.write('[dbmgr@password ~]# ');
        }
      });
    });
    // 无密码:不自动登录,灯停在 auth-required
    const noPwd = new TelnetService({
      getTargets: () => [engineTarget(port, { password: '' })],
      intervalMs: 3600000
    });
    noPwd.start();
    noPwd.connectTarget(`127.0.0.1:${port}`);
    await until(() => noPwd.getState(`127.0.0.1:${port}`) === 'auth-required');
    noPwd.dispose();

    // 错密码:引擎停 PASSWD 态,灯 auth-rejected
    serverSocket!.destroy();
    const wrongPwd = new TelnetService({
      getTargets: () => [engineTarget(port, { password: 'wrong' })],
      intervalMs: 3600000
    });
    wrongPwd.start();
    wrongPwd.connectTarget(`127.0.0.1:${port}`);
    await until(() => wrongPwd.getState(`127.0.0.1:${port}`) === 'auth-rejected');
    wrongPwd.dispose();
  });

  it('探测超时臂:停摆 socket 到点未连上判未开(注入 connect,不依赖环境路由)', async () => {
    // 真实网络里「连不上」可能是超时也可能是瞬时 ENETUNREACH(后者走 error 臂),
    // 故超时回调用停摆 socket 确定性驱动
    const stalled = (): net.Socket => {
      const socket = new EventEmitter() as unknown as net.Socket & {
        setTimeout: (ms: number, cb: () => void) => void;
        destroy: () => void;
      };
      socket.setTimeout = (ms, cb) => void setTimeout(cb, ms);
      socket.destroy = () => undefined;
      return socket;
    };
    const probe = makeProbeOne(30, stalled);
    await expect(probe('127.0.0.1', 1)).resolves.toBe(false);
  });

  it('持久会话在位时 probeOnce 跳过该目标(会话态即灯色)', async () => {
    const port = await engineServer();
    let probeCalls = 0;
    const service = new TelnetService({
      getTargets: () => [engineTarget(port)],
      probeOne: async (host, probePort) => {
        probeCalls += 1;
        return probePort === port;
      },
      intervalMs: 3600000
    });
    const key = `127.0.0.1:${port}`;
    service.start();
    await until(() => service.getState(key) === 'open');
    const callsBeforeSession = probeCalls;

    service.connectTarget(key);
    await until(() => service.getState(key) === 'connected');

    await service.probeOnce();
    expect(probeCalls).toBe(callsBeforeSession); // 会话在,未再探测
    expect(service.getState(key)).toBe('connected');
    service.dispose();
  });

  it('输出回显跳过空行', async () => {
    const port = await listen(socket => {
      socket.on('error', () => undefined);
      socket.on('end', () => socket.end());
      socket.write('password:');
      let authed = false;
      socket.on('data', () => {
        if (!authed) {
          authed = true;
          socket.write('first\r\n\r\n\r\nsecond\r\n[dbmgr@python ~]# ');
          return;
        }
        socket.write('[dbmgr@python ~]# ');
      });
    });
    const service = makeRealService(() => [engineTarget(port)]);
    const key = `127.0.0.1:${port}`;
    service.start();
    service.connectTarget(key);
    await until(() => service.getState(key) === 'connected');
    const texts = service.getOutput(key).filter(line => line.includes('first') || line.includes('second'));
    expect(texts).toHaveLength(2); // 两个空行未入账
    service.dispose();
  });

  it('过闸命令在会话未就绪时返回 false', async () => {
    const port = await engineServer();
    const service = makeRealService(() => [engineTarget(port)]);
    const key = `127.0.0.1:${port}`;
    service.start();
    service.connectTarget(key); // 握手进行中(connecting/awaiting-password)
    expect(service.sendCommand(key, 'getStatus')).toBe(false);
    await until(() => service.getState(key) === 'connected');
    expect(service.sendCommand(key, 'getStatus')).toBe(true);
    service.dispose();
  });

  it('connectTarget 对未知目标为空转;已存在会话先断旧再建新', async () => {
    const port = await engineServer();
    const service = makeRealService(() => [engineTarget(port)]);
    const key = `127.0.0.1:${port}`;
    service.start();

    service.connectTarget('nope:1');
    expect(service.getSessionState('nope:1')).toBeNull();

    service.connectTarget(key);
    await until(() => service.getSessionState(key) === 'ready');
    service.connectTarget(key);
    await until(() => service.getSessionState(key) === 'ready');
    service.dispose();
    expect(service.getSessionState(key)).toBeNull();
  });
});
