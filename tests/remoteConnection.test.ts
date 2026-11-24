import { describe, expect, it } from 'vitest';
import {
  buildSshExecArgs,
  buildSshTunnelArgs,
  openSshTunnel,
  pickFreeLocalPort,
  readSshHosts,
  resolveComponentConnection,
  validateSshEntry
} from '../src/backend/remoteConnection';

// IDE-PDBG-004 远程连接分派:声明优先级(组件>全局>视图选中>本地)、ssh
// 命令拼装(远程执行/-L 隧道)、隧道就绪门(起不来如实报错不假成功)、
// ssh config 读取(文件不存在=空表)。

describe('resolveComponentConnection', () => {
  const hosts = [
    { host: 'bastion', hostname: '10.0.0.1', user: 'dev', port: 2222, proxyJump: 'jump1' },
    { host: 'gamesrv', hostname: '10.2.0.5' }
  ];

  it('缺省/空串/local 都归本地', () => {
    expect(resolveComponentConnection(undefined, undefined, hosts)).toBe('local');
    expect(resolveComponentConnection('local', 'gamesrv', hosts)).toBe('local');
    expect(resolveComponentConnection('  ', undefined, hosts)).toBe('local');
  });

  it('优先级:组件级 > debug.json 全局 > 视图选中', () => {
    const byComponent = resolveComponentConnection('bastion', 'gamesrv', hosts, 'other');
    expect(byComponent).toEqual({ ssh: hosts[0] });
    const byGlobal = resolveComponentConnection(undefined, 'gamesrv', hosts, 'other');
    expect(byGlobal).toEqual({ ssh: hosts[1] });
    const bySelected = resolveComponentConnection(undefined, undefined, hosts, 'gamesrv');
    expect(bySelected).toEqual({ ssh: hosts[1] });
  });

  it('别名不在 config 表:按裸主机名连(HostName 缺省=别名,ssh 语义)', () => {
    expect(resolveComponentConnection('unknown-host', undefined, hosts)).toEqual({
      ssh: { host: 'unknown-host' }
    });
  });
});

describe('ssh 命令拼装', () => {
  const entry = { host: 'gamesrv', hostname: '10.2.0.5', user: 'ops', port: 2222, proxyJump: 'jump1,jump2' };

  it('远程执行:BatchMode + 跳板 + 端口 + user@host -- 命令', () => {
    expect(buildSshExecArgs(entry, ['py-spy', 'dump', '--pid', '42'])).toEqual([
      '-o', 'BatchMode=yes',
      '-J', 'jump1,jump2',
      '-p', '2222',
      'ops@gamesrv',
      '--',
      'py-spy', 'dump', '--pid', '42'
    ]);
  });

  it('无跳板无端口无用户:裸别名直连', () => {
    expect(buildSshExecArgs({ host: 'plain' }, ['true'])).toEqual([
      '-o', 'BatchMode=yes',
      'plain',
      '--',
      'true'
    ]);
  });

  it('隧道:-N -L localPort:127.0.0.1:remotePort', () => {
    expect(buildSshTunnelArgs(entry, 15678, 5678)).toEqual([
      '-o', 'BatchMode=yes',
      '-J', 'jump1,jump2',
      '-p', '2222',
      'ops@gamesrv',
      '-N',
      '-L', '15678:127.0.0.1:5678'
    ]);
  });

  // ssh 位置参数注入防线:目标/跳板来自半信任输入(.kbengine/debug.json、
  // ssh config),`-oProxyCommand=…` 形状会被 ssh 解析成本地执行的选项,
  // 空白/控制字符切出额外 token——前导 '-' 与空白/控制字符一律拒收。
  it('注入防线:前导 - 的 host/user/proxyJump 拒收且带原因', () => {
    expect(validateSshEntry({ host: '-oProxyCommand=touch/tmp/x' }))
      .toContain("以 '-' 开头");
    expect(validateSshEntry({ host: 'gamesrv', user: '-oBatchMode=no' }))
      .toContain('user');
    expect(validateSshEntry({ host: 'gamesrv', proxyJump: '-J evil' }))
      .toContain('proxyJump');
    expect(() => buildSshExecArgs({ host: '-oProxyCommand=evil' }, ['true']))
      .toThrow(/ssh 目标声明非法/);
    expect(() => buildSshTunnelArgs({ host: '-oProxyCommand=evil' }, 1, 2))
      .toThrow(/ssh 目标声明非法/);
  });

  it('注入防线:空白与控制字符拒收,正常 host 不误伤', () => {
    expect(validateSshEntry({ host: 'gamesrv extra' })).toContain('空白或控制字符');
    expect(validateSshEntry({ host: 'gamesrv\n' })).toContain('空白或控制字符');
    expect(validateSshEntry({ host: '' })).toContain('为空');
    expect(validateSshEntry({ host: 'gamesrv', user: 'ops', proxyJump: 'jump1,jump2' }))
      .toBeNull();
  });
});

describe('pickFreeLocalPort', () => {
  it('首选空闲给首选;被占换临时口(真实套接字)', async () => {
    const probePort = await pickFreeLocalPort(0); // 0=强制内核分临时口,拿到一个必空口
    expect(probePort).toBeGreaterThan(0);
    const preferred = await pickFreeLocalPort(probePort);
    expect(preferred).toBe(probePort);
  }, 8000);
});

describe('openSshTunnel', () => {
  /** 隧道进程替身:open 门控由 probe 替身决定,kill 记账 */
  const makeFakeTunnel = () => {
    const calls: { args: string[]; killed: boolean; exitCallbacks: Array<() => void> } = {
      args: [],
      killed: false,
      exitCallbacks: []
    };
    return {
      calls,
      spawnTunnel: (args: string[]) => {
        calls.args = args;
        return {
          onExit: (cb: () => void) => {
            calls.exitCallbacks.push(cb);
          },
          kill: () => {
            calls.killed = true;
          }
        };
      }
    };
  };

  it('本地端口开 → 隧道就绪,localPort=远端口,stop 杀进程', async () => {
    const fake = makeFakeTunnel();
    const outcome = await openSshTunnel({ host: 'gamesrv' }, 5678, {
      spawnTunnel: fake.spawnTunnel,
      probe: async () => ({ open: true }),
      waitMs: 500
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    expect(outcome.tunnel.localPort).toBe(5678);
    expect(fake.calls.args).toContain('-L');
    expect(fake.calls.args).toContain('5678:127.0.0.1:5678');
    expect(fake.calls.killed).toBe(false);
    outcome.tunnel.stop();
    expect(fake.calls.killed).toBe(true);
  });

  it('窗口内本地端口没开 → 如实失败(进程被收走)', async () => {
    const fake = makeFakeTunnel();
    const outcome = await openSshTunnel({ host: 'gamesrv' }, 5678, {
      spawnTunnel: fake.spawnTunnel,
      probe: async () => ({ open: false, reason: 'refused' }),
      waitMs: 400
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      return;
    }
    expect(outcome.reason).toContain('未就绪');
    expect(fake.calls.killed).toBe(true); // 失败也收走 ssh,不留后台
  });

  it('ssh 进程直接退出(跳板/主机不可达)→ 立刻失败带定位原因', async () => {
    const fake = makeFakeTunnel();
    const outcome = await openSshTunnel({ host: 'gamesrv', proxyJump: 'bastion' }, 5678, {
      spawnTunnel: args => {
        const handle = fake.spawnTunnel(args);
        // 起 exeunt 之前就退出(连不上跳板的形状)
        queueMicrotask(() => fake.calls.exitCallbacks.forEach(cb => cb()));
        return handle;
      },
      probe: async () => ({ open: false, reason: 'refused' }),
      waitMs: 500
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      return;
    }
    expect(outcome.reason).toContain('退出');
    expect(outcome.reason).toContain('BatchMode');
    expect(fake.calls.killed).toBe(true);
  });
});

describe('readSshHosts', () => {
  it('读到 config:解析+去重,configExists=true', async () => {
    const snapshot = await readSshHosts(
      async () => 'Host gamesrv\n  HostName 10.2.0.5\n',
      '/home/u/.ssh/config'
    );
    expect(snapshot.configExists).toBe(true);
    expect(snapshot.hosts).toEqual([{ host: 'gamesrv', hostname: '10.2.0.5', user: undefined, port: undefined, proxyJump: undefined }]);
  });

  it('文件不存在:空表 configExists=false(不抛,视图只剩本地+手动项)', async () => {
    const snapshot = await readSshHosts(
      async () => {
        throw new Error('ENOENT');
      },
      '/home/u/.ssh/config'
    );
    expect(snapshot.configExists).toBe(false);
    expect(snapshot.hosts).toEqual([]);
  });
});
