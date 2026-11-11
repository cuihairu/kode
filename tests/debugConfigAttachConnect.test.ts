// DebugConfigManager connect 系分派:IDE-PDBG-002 端口模式前置探测(通则
// 零弹窗直附加;不通分开说端口未开/未装 debugpy,未装给一键安装)、
// IDE-PDBG-004 远程分派(ssh 隧道附加/连接声明优先级)、IDE-PDBG-002b
// 端口模式全流程(下一步控件 + 动态写 launch.json)。

import { describe, expect, it, afterAll, beforeAll, beforeEach } from 'vitest';
import {
  MemoryMemento,
  seededMemento,
  windowish,
  warnQueue,
  pickQueue,
  pickOffers,
  warnOffers,
  messages,
  debugCalls,
  makeManager,
  preflightStatus,
  setWorkspaceAt,
  flushAsync,
  setDebugResult,
  stubDebug,
  memoryFileSystem,
  registerAttachTestHooks
} from './helpers/debugConfigAttachHarness';

registerAttachTestHooks();

describe('IDE-PDBG-002 端口模式前置探测(端口未开 / 未装 debugpy 分开说)', () => {
  const writeDebugJson = (components: Record<string, unknown>): void => {
    memoryFileSystem.set('/tmp/kode-dbg/.kbengine/debug.json', JSON.stringify({ debug: { components } }));
  };
  const closedProbe = (reason: string, detail = reason) =>
    async () => ({ open: false, reason, detail });

  it('端口通:直接 connect 附加,零多余弹窗', async () => {
    setWorkspaceAt('/tmp/kode-dbg');
    writeDebugJson({ baseapp: { debugpyHost: '127.0.0.1', debugpyPort: 5678 } });
    const manager = makeManager([], new MemoryMemento(), {
      probeTcpPort: async () => ({ open: true })
    });
    await flushAsync();

    expect(await manager.attachToComponent('baseapp')).toBe(true);

    expect(debugCalls).toHaveLength(1);
    expect(debugCalls[0].config.connect).toEqual({ host: '127.0.0.1', port: 5678 });
    // 零多余弹窗:无警告、无错误、无选择器
    expect(messages.warn).toHaveLength(0);
    expect(messages.error).toHaveLength(0);
    expect(pickOffers).toHaveLength(0);
  });

  it('端口未开 + 本机 debugpy 就绪:不附加,警告给端口原因与起监听指引', async () => {
    setWorkspaceAt('/tmp/kode-dbg');
    writeDebugJson({ cellapp: { debugpyPort: 5679 } });
    const manager = makeManager([], new MemoryMemento(), {
      probeTcpPort: closedProbe('refused', 'ECONNREFUSED'),
      checkDebugpy: async () => preflightStatus('ok')
    });
    await flushAsync();

    expect(await manager.attachToComponent('cellapp')).toBe(false);

    expect(debugCalls).toHaveLength(0);
    expect(messages.warn).toHaveLength(1);
    // 原因可定位:端口未开(没人监听)与起监听三条路径分开说
    expect(messages.warn[0]).toContain('debugpy 端口未开');
    expect(messages.warn[0]).toContain('连接被拒');
    expect(messages.warn[0]).toContain('debugpy.listen');
    // 本机 debugpy 就绪时无安装动作,但死路已补上下一步控件(起监听/重试/指引)
    expect(warnOffers[0].actions).not.toContain('一键安装 debugpy');
    expect(warnOffers[0].actions).toEqual([
      '起监听并附加',
      '重试附加',
      '起监听指引'
    ]);
    // 下一步文案带 launch.json 落点与起监听路径(不只一句端口未开)
    expect(messages.warn[0]).toContain('launch.json');
    expect(messages.warn[0]).toContain('autoDebugpy');
  });

  it('端口未开 + 本机未装 debugpy:警告给安装动作;一键安装成功且端口随后开→附加', async () => {
    setWorkspaceAt('/tmp/kode-dbg');
    writeDebugJson({ baseapp: { debugpyPort: 5678 } });
    // 探测序列:先不通(触发分诊),装完再探通了(引擎恰好起监听)
    const probeResults = [{ open: false, reason: 'refused', detail: 'ECONNREFUSED' }, { open: true }];
    let probeIndex = 0;
    const installCalls: string[] = [];
    const manager = makeManager([], new MemoryMemento(), {
      probeTcpPort: async () => probeResults[probeIndex++],
      checkDebugpy: async () => preflightStatus('debugpy-missing'),
      installDebugpy: async interpreterPath => {
        installCalls.push(interpreterPath);
        return { ok: true, detail: 'Successfully installed debugpy' };
      }
    });
    await flushAsync();
    warnQueue.push('一键安装 debugpy');

    expect(await manager.attachToComponent('baseapp')).toBe(true);

    // 主因分开说:端口未开 + 未装 debugpy 两个事实都在
    expect(messages.warn[0]).toContain('debugpy 端口未开');
    expect(messages.warn[0]).toContain('没有 debugpy');
    expect(warnOffers[0].actions).toContain('一键安装 debugpy');
    // 安装动作真实执行在对的解释器上
    expect(installCalls).toEqual(['/usr/bin/python3']);
    // 装完 + 端口开 → 附加
    expect(debugCalls).toHaveLength(1);
    expect(debugCalls[0].config.connect).toEqual({ host: '127.0.0.1', port: 5678 });
  });

  it('一键安装失败:如实报错(含原因),不附加不假成功', async () => {
    setWorkspaceAt('/tmp/kode-dbg');
    writeDebugJson({ baseapp: { debugpyPort: 5678 } });
    const manager = makeManager([], new MemoryMemento(), {
      probeTcpPort: closedProbe('refused', 'ECONNREFUSED'),
      checkDebugpy: async () => preflightStatus('debugpy-missing'),
      installDebugpy: async () => ({ ok: false, detail: 'pip 退出码 1: no network' })
    });
    await flushAsync();
    warnQueue.push('一键安装 debugpy');

    expect(await manager.attachToComponent('baseapp')).toBe(false);

    expect(messages.error).toHaveLength(1);
    expect(messages.error[0]).toContain('debugpy 安装失败');
    expect(messages.error[0]).toContain('pip 退出码 1');
    expect(debugCalls).toHaveLength(0);
  });

  it('装好但端口仍未开:如实说装包≠起监听,不附加', async () => {
    setWorkspaceAt('/tmp/kode-dbg');
    writeDebugJson({ baseapp: { debugpyPort: 5678 } });
    const manager = makeManager([], new MemoryMemento(), {
      probeTcpPort: closedProbe('refused', 'ECONNREFUSED'),
      checkDebugpy: async () => preflightStatus('debugpy-missing'),
      installDebugpy: async () => ({ ok: true, detail: 'Successfully installed debugpy' })
    });
    await flushAsync();
    warnQueue.push('一键安装 debugpy');

    expect(await manager.attachToComponent('baseapp')).toBe(false);

    expect(debugCalls).toHaveLength(0);
    expect(messages.warn).toHaveLength(2); // 分诊警告 + 装完仍未开警告
    expect(messages.warn[1]).toContain('仍未开');
    expect(messages.warn[1]).toContain('debugpy.listen');
  });

  it('手动安装指引:给可复制命令与后续两步,不附加', async () => {
    setWorkspaceAt('/tmp/kode-dbg');
    writeDebugJson({ baseapp: { debugpyPort: 5678 } });
    const manager = makeManager([], new MemoryMemento(), {
      probeTcpPort: closedProbe('refused', 'ECONNREFUSED'),
      checkDebugpy: async () => preflightStatus('debugpy-missing')
    });
    await flushAsync();
    warnQueue.push('手动安装指引');

    expect(await manager.attachToComponent('baseapp')).toBe(false);

    expect(debugCalls).toHaveLength(0);
    expect(messages.info).toHaveLength(1);
    // DBG-COMPAT-02:手装命令来自预检精确 spec,不再写死 -U 盲装最新
    expect(messages.info[0]).toContain('/usr/bin/python3 -m pip install debugpy>=1.8.0');
    expect(messages.info[0]).toContain('kbengine.python.debugpySync');
  });

  it('debugpy 与目标不兼容也归因缺包给安装动作;未找到解释器只给设置指引', async () => {
    setWorkspaceAt('/tmp/kode-dbg');
    writeDebugJson({ baseapp: { debugpyPort: 5678 }, cellapp: { debugpyPort: 5679 } });
    const outdatedManager = makeManager([], new MemoryMemento(), {
      probeTcpPort: closedProbe('timeout', 'connect timeout after 1500ms'),
      checkDebugpy: async () => preflightStatus('debugpy-incompatible', '/usr/bin/python3', '1.6.0', ['install', 'debugpy>=1.8.0'])
    });
    await flushAsync();
    expect(await outdatedManager.attachToComponent('baseapp')).toBe(false);
    expect(messages.warn[0]).toContain('不兼容');
    expect(warnOffers[0].actions).toContain('一键安装 debugpy');

    const noInterpreterManager = makeManager([], new MemoryMemento(), {
      probeTcpPort: closedProbe('timeout', 'connect timeout after 1500ms'),
      checkDebugpy: async () => preflightStatus('interpreter-missing', null, null)
    });
    await flushAsync();
    expect(await noInterpreterManager.attachToComponent('cellapp')).toBe(false);
    expect(messages.warn[1]).toContain('kbengine.python.interpreterPath');
    // 解释器都没有:无安装面,但端口仍未开的下一步控件照给(起监听/重试/指引)
    expect(warnOffers[1].actions).not.toContain('一键安装 debugpy');
    expect(warnOffers[1].actions).toEqual(['起监听并附加', '重试附加', '起监听指引']);
    expect(debugCalls).toHaveLength(0);
  });
});

describe('IDE-PDBG-004 远程分派(ssh 隧道附加 / 连接声明优先级)', () => {
  const writeDebugJson = (debug: Record<string, unknown>): void => {
    memoryFileSystem.set('/tmp/kode-dbg/.kbengine/debug.json', JSON.stringify({ debug }));
  };
  /** 隧道进程替身:记 args,kill 记账,退出回调可手动触发 */
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
  const sshHosts = [
    { host: 'bastion', hostname: '10.0.0.1', user: 'dev', port: 2222, proxyJump: 'jump1' },
    { host: 'gamesrv', hostname: '10.2.0.5' }
  ];

  // IDE-AUD-003:隧道存活要绑真实会话生命周期——本块补会话启动/终止事件
  // 替身,供「成功附加后会话终止才拆隧道」与「会话未识别时卸载兜底」对账。
  const debugish = stubDebug as unknown as Record<string, unknown>;
  const sessionStartListeners: Array<(session: unknown) => void> = [];
  const sessionTerminateListeners: Array<(session: unknown) => void> = [];
  let originalSessionStart: unknown;
  let originalSessionTerminate: unknown;
  beforeAll(() => {
    originalSessionStart = debugish.onDidStartDebugSession;
    originalSessionTerminate = debugish.onDidTerminateDebugSession;
    debugish.onDidStartDebugSession = (listener: (session: unknown) => void) => {
      sessionStartListeners.push(listener);
      return { dispose: () => undefined };
    };
    debugish.onDidTerminateDebugSession = (listener: (session: unknown) => void) => {
      sessionTerminateListeners.push(listener);
      return { dispose: () => undefined };
    };
  });
  afterAll(() => {
    debugish.onDidStartDebugSession = originalSessionStart;
    debugish.onDidTerminateDebugSession = originalSessionTerminate;
  });
  beforeEach(() => {
    sessionStartListeners.length = 0;
    sessionTerminateListeners.length = 0;
  });
  const waitUntil = async (predicate: () => boolean, maxBeats = 80): Promise<void> => {
    for (let i = 0; i < maxBeats && !predicate(); i += 1) {
      await flushAsync();
    }
  };

  it('组件声明远程:起 -L 隧道 connect 附加,成功隧道仍存活,会话终止才拆', async () => {
    setWorkspaceAt('/tmp/kode-dbg');
    writeDebugJson({ components: { baseapp: { debugpyPort: 5678, sshHost: 'gamesrv' } } });
    const fake = makeFakeTunnel();
    const manager = makeManager([], new MemoryMemento(), {
      listSshHosts: () => sshHosts,
      spawnTunnel: fake.spawnTunnel,
      probeTcpPort: async () => ({ open: true })
    });
    await flushAsync();

    // 成功附加需有真实会话:startDebugging 内同步回放会话启动事件(携带本次
    // 配置,含 __kodeAttachId 标记),与会话追踪/隧道归属的生产序一致
    const originalStart = debugish.startDebugging;
    let ownSession: { id: string; name: string; configuration: Record<string, unknown> };
    debugish.startDebugging = async (_folder: unknown, config: Record<string, unknown>) => {
      debugCalls.push({ folder: _folder, config, result: true, throws: null });
      ownSession = { id: 'own', name: config.name, configuration: config };
      for (const listener of [...sessionStartListeners]) {
        listener(ownSession);
      }
      return true;
    };
    try {
      expect(await manager.attachToComponent('baseapp')).toBe(true);
    } finally {
      debugish.startDebugging = originalStart;
    }

    // 附加是 connect 到本地隧道口(127.0.0.1),不是直连远端
    expect(debugCalls).toHaveLength(1);
    expect(debugCalls[0].config.connect.host).toBe('127.0.0.1');
    // 隧道形状:-N -L 本地口:127.0.0.1:5678(本地口=附加实际用的口)
    const localPort = debugCalls[0].config.connect.port;
    expect(fake.calls.args).toContain('-N');
    expect(fake.calls.args).toContain(`${localPort}:127.0.0.1:5678`);
    // IDE-AUD-003:startDebugging 成功 ≠ 会话结束——隧道不得随 Boolean 立即拆
    expect(fake.calls.killed).toBe(false);
    // 会话终止才是拆隧道时点
    for (const listener of [...sessionTerminateListeners]) {
      listener(ownSession);
    }
    expect(fake.calls.killed).toBe(true);
    expect(messages.error).toHaveLength(0);
  });

  it('启动失败:隧道立即拆,不留后台 ssh', async () => {
    setWorkspaceAt('/tmp/kode-dbg');
    writeDebugJson({ components: { baseapp: { debugpyPort: 5678, sshHost: 'gamesrv' } } });
    const fake = makeFakeTunnel();
    const manager = makeManager([], new MemoryMemento(), {
      listSshHosts: () => sshHosts,
      spawnTunnel: fake.spawnTunnel,
      probeTcpPort: async () => ({ open: true })
    });
    await flushAsync();

    setDebugResult(false); // startDebugging 返回 false = 启动失败
    try {
      expect(await manager.attachToComponent('baseapp')).toBe(false);
    } finally {
      setDebugResult(true);
    }
    expect(fake.calls.killed).toBe(true);
    expect(debugCalls).toHaveLength(1);
  });

  it('取消附加:隧道立即拆,不留后台 ssh', async () => {
    setWorkspaceAt('/tmp/kode-dbg');
    writeDebugJson({ components: { baseapp: { debugpyPort: 5678, sshHost: 'gamesrv' } } });
    const fake = makeFakeTunnel();
    const manager = makeManager([], new MemoryMemento(), {
      listSshHosts: () => sshHosts,
      spawnTunnel: fake.spawnTunnel,
      probeTcpPort: async () => ({ open: true })
    });
    await flushAsync();

    const originalProgress = windowish.withProgress;
    const originalStart = debugish.startDebugging;
    let fireCancelNow: (() => void) | undefined;
    windowish.withProgress = async (
      _options: unknown,
      task: (progress: unknown, token: unknown) => Promise<unknown>
    ) =>
      task(undefined, {
        isCancellationRequested: false,
        onCancellationRequested: (listener: () => void) => {
          fireCancelNow = listener;
          return { dispose: () => undefined };
        }
      });
    // start 永不落定(无人监听端口形状),取消面接管
    debugish.startDebugging = async () => new Promise<boolean>(() => undefined);
    try {
      const attaching = manager.attachToComponent('baseapp');
      await waitUntil(() => fireCancelNow !== undefined);
      fireCancelNow?.();
      expect(await attaching).toBe(false);
    } finally {
      windowish.withProgress = originalProgress;
      debugish.startDebugging = originalStart;
    }
    expect(fake.calls.killed).toBe(true);
  });

  it('会话未识别即卸载:成功附加后未归属会话的隧道由管理器兜底拆', async () => {
    setWorkspaceAt('/tmp/kode-dbg');
    writeDebugJson({ components: { baseapp: { debugpyPort: 5678, sshHost: 'gamesrv' } } });
    const fake = makeFakeTunnel();
    const manager = makeManager([], new MemoryMemento(), {
      listSshHosts: () => sshHosts,
      spawnTunnel: fake.spawnTunnel,
      probeTcpPort: async () => ({ open: true })
    });
    await flushAsync();

    // 文件级 startDebugging 不回放会话事件:成功但会话从未被识别
    expect(await manager.attachToComponent('baseapp')).toBe(true);
    expect(fake.calls.killed).toBe(false);
    manager.dispose();
    expect(fake.calls.killed).toBe(true);
  });

  it('远程组件进程附加:明确拒绝,绝不把本地 PID 当远端', async () => {
    setWorkspaceAt('/tmp/kode-dbg');
    // 组件声明远程主机但未配 debugpy 端口 → 进程附加(PID)模式
    writeDebugJson({ components: { baseapp: { sshHost: 'gamesrv' } } });
    const manager = makeManager([{ pid: 4321, name: 'baseapp' }], seededMemento('process-attach'), {
      listSshHosts: () => sshHosts
    });
    await flushAsync();
    // 本地进程选择器若被调用会返回此 PID(旧实现静默走本地的形状)
    pickQueue.push({ label: '$(check) baseapp', description: '4321' });

    expect(await manager.attachToComponent('baseapp')).toBe(false);

    // 本地进程列表绝不冒充远端:进程选择器未弹出、未朝本地 debugpy 附加
    expect(pickOffers).toHaveLength(0);
    expect(debugCalls).toHaveLength(0);
    // 明确拒绝并说明原因
    expect(messages.error).toHaveLength(1);
    expect(messages.error[0]).toContain('远程');
    expect(messages.error[0]).toContain('进程附加');
  });

  it('隧道起不来(跳板/主机不可达):如实报错不附加', async () => {
    setWorkspaceAt('/tmp/kode-dbg');
    writeDebugJson({ components: { baseapp: { debugpyPort: 5678, sshHost: 'bastion' } } });
    const fake = makeFakeTunnel();
    const manager = makeManager([], new MemoryMemento(), {
      listSshHosts: () => sshHosts,
      spawnTunnel: args => {
        const handle = fake.spawnTunnel(args);
        // 起来之前就退出(连不上跳板的形状)
        queueMicrotask(() => fake.calls.exitCallbacks.forEach(cb => cb()));
        return handle;
      },
      probeTcpPort: async () => ({ open: false, reason: 'refused' })
    });
    await flushAsync();

    expect(await manager.attachToComponent('baseapp')).toBe(false);

    expect(debugCalls).toHaveLength(0); // 不朝空隧道附加
    expect(messages.error).toHaveLength(1);
    expect(messages.error[0]).toContain('远程附加失败');
    expect(messages.error[0]).toContain('BatchMode'); // 定位到免密登录
    expect(fake.calls.killed).toBe(true);
  });

  it('连接声明优先级:组件级 > debug.json 全局 > 视图选中;local 归本地;未知名按裸主机连', async () => {
    setWorkspaceAt('/tmp/kode-dbg');
    writeDebugJson({
      defaultSshHost: 'gamesrv',
      components: { cellapp: { sshHost: 'bastion' }, baseapp: {}, loginapp: { sshHost: 'local' }, dbmgr: { sshHost: 'ghost' } }
    });
    const manager = makeManager([], new MemoryMemento(), {
      listSshHosts: () => sshHosts,
      selectedServer: () => 'gamesrv'
    });
    await flushAsync();

    expect(manager.getConnectionFor('cellapp')).toEqual({ ssh: sshHosts[0] }); // 组件级赢
    expect(manager.getConnectionFor('baseapp')).toEqual({ ssh: sshHosts[1] }); // 全局兜底
    expect(manager.getConnectionFor('interfaces')).toEqual({ ssh: sshHosts[1] }); // 视图选中最后
    expect(manager.getConnectionFor('logger')).toEqual({ ssh: sshHosts[1] });
    expect(manager.getConnectionFor('loginapp')).toBe('local'); // local 显式归本地
    // 组件声明的别名不在 config:按裸主机名连(HostName 缺省 = 别名,ssh 语义)
    expect(manager.getConnectionFor('dbmgr')).toEqual({ ssh: { host: 'ghost' } });
  });
});

describe('IDE-PDBG-002b 端口模式全流程(下一步控件 + 动态写 launch.json)', () => {
  const writeDebugJson = (components: Record<string, unknown>): void => {
    memoryFileSystem.set(
      '/tmp/kode-dbg/.kbengine/debug.json',
      JSON.stringify({ debug: { components } })
    );
  };
  const launchPath = '/tmp/kode-dbg/.vscode/launch.json';
  const readLaunch = (): any =>
    JSON.parse(Buffer.from(memoryFileSystem.files.get(launchPath) as Uint8Array).toString('utf8'));
  /** 探测序列替身:逐次取值,取尽后重复最后一个 */
  const probeSequence = (results: Array<{ open: boolean; reason?: string; detail?: string }>) => {
    let index = 0;
    return async (): Promise<{ open: boolean; reason?: string; detail?: string }> =>
      results[Math.min(index++, results.length - 1)];
  };
  const closedProbe = (): { open: false; reason: 'refused'; detail: string } => ({
    open: false,
    reason: 'refused',
    detail: 'ECONNREFUSED'
  });
  const preflightOk = async () => preflightStatus('ok');
  const preflightMissing = async () => preflightStatus('debugpy-missing');

  it('端口通:附加前已静默落 connect 条目进 launch.json(断点可用三件套,零弹窗)', async () => {
    setWorkspaceAt('/tmp/kode-dbg');
    writeDebugJson({ baseapp: { debugpyPort: 5678 } });
    const manager = makeManager([], new MemoryMemento(), {
      probeTcpPort: async () => ({ open: true })
    });
    await flushAsync();

    expect(await manager.attachToComponent('baseapp')).toBe(true);

    // 动态写入已发生:attach 本体不读 launch.json,但 F5 落点必须在
    const entry = readLaunch().configurations.find(
      (item: any) => item.name === 'KBEngine: Python attach to baseapp (debugpy 5678)'
    );
    expect(entry).toMatchObject({
      type: 'debugpy',
      request: 'attach',
      connect: { host: '127.0.0.1', port: 5678 }
    });
    expect(entry.pathMappings).toEqual([
      { localRoot: '/tmp/kode-dbg', remoteRoot: '/tmp/kode-dbg' }
    ]);
    // 零多余弹窗(既有口径不回归)
    expect(messages.warn).toHaveLength(0);
    expect(messages.info).toHaveLength(0);
    expect(messages.error).toHaveLength(0);
    // 会话本体与 launch 条目同名同体(Run and Debug 里选它=同一配置)
    expect(debugCalls[0].config.name).toBe(entry.name);
    expect(debugCalls[0].config.connect).toEqual({ host: '127.0.0.1', port: 5678 });
    expect(debugCalls[0].config.pathMappings).toEqual(entry.pathMappings);
  });

  it('装完仍未开不再是死路:下一步三控件;起监听成功→重探通→附加', async () => {
    setWorkspaceAt('/tmp/kode-dbg');
    writeDebugJson({ baseapp: { debugpyPort: 5678 } });
    const listenCalls: Array<{ component: string; port: number }> = [];
    const installCalls: string[] = [];
    const manager = makeManager([], new MemoryMemento(), {
      // 探测:初探不通(分诊)→ 装完再探仍不通 → 起监听后通了
      probeTcpPort: probeSequence([closedProbe(), closedProbe(), { open: true }]),
      checkDebugpy: preflightMissing,
      installDebugpy: async interpreterPath => {
        installCalls.push(interpreterPath);
        return { ok: true, detail: 'Successfully installed debugpy' };
      },
      startDebugpyListener: async (component, port) => {
        listenCalls.push({ component, port });
        return { ok: true, detail: `debugpy.listen 127.0.0.1:${port} 已执行` };
      }
    });
    await flushAsync();
    warnQueue.push('一键安装 debugpy'); // 分诊:点安装
    warnQueue.push('起监听并附加'); // 装完仍未开:点下一步

    expect(await manager.attachToComponent('baseapp')).toBe(true);

    expect(installCalls).toEqual(['/usr/bin/python3']);
    expect(listenCalls).toEqual([{ component: 'baseapp', port: 5678 }]);
    // 两个弹窗:分诊(带安装动作)+ 下一步(带三控件)
    expect(warnOffers).toHaveLength(2);
    expect(warnOffers[1].actions).toEqual(['起监听并附加', '重试附加', '起监听指引']);
    expect(messages.warn[1]).toContain('仍未开');
    expect(messages.warn[1]).toContain('debugpy.listen');
    expect(messages.warn[1]).toContain('launch.json');
    // 附加落到 connect 三件套(断点/单步面)
    expect(debugCalls).toHaveLength(1);
    expect(debugCalls[0].config).toMatchObject({
      type: 'debugpy',
      request: 'attach',
      connect: { host: '127.0.0.1', port: 5678 }
    });
    // launch.json 端口条目在盘
    expect(
      readLaunch().configurations.some(
        (item: any) => item.name === 'KBEngine: Python attach to baseapp (debugpy 5678)'
      )
    ).toBe(true);
  });

  it('起监听失败:如实报错(带原因),不附加不假成功', async () => {
    setWorkspaceAt('/tmp/kode-dbg');
    writeDebugJson({ baseapp: { debugpyPort: 5678 } });
    const manager = makeManager([], new MemoryMemento(), {
      probeTcpPort: probeSequence([closedProbe()]),
      checkDebugpy: preflightOk,
      startDebugpyListener: async () => ({ ok: false, detail: 'telnet 40000 连不上(组件未运行)' })
    });
    await flushAsync();
    warnQueue.push('起监听并附加');

    expect(await manager.attachToComponent('baseapp')).toBe(false);

    expect(debugCalls).toHaveLength(0);
    expect(messages.error).toHaveLength(1);
    expect(messages.error[0]).toContain('起 debugpy 监听失败');
    expect(messages.error[0]).toContain('telnet 40000 连不上');
  });

  it('重试附加:端口已从别处起监听时,再探一次就直接接上', async () => {
    setWorkspaceAt('/tmp/kode-dbg');
    writeDebugJson({ baseapp: { debugpyPort: 5678 } });
    const listenCalls: string[] = [];
    const manager = makeManager([], new MemoryMemento(), {
      probeTcpPort: probeSequence([closedProbe(), { open: true }]),
      checkDebugpy: preflightOk,
      startDebugpyListener: async component => {
        listenCalls.push(component);
        return { ok: true, detail: 'ok' };
      }
    });
    await flushAsync();
    warnQueue.push('重试附加');

    expect(await manager.attachToComponent('baseapp')).toBe(true);

    expect(listenCalls).toHaveLength(0); // 重试不起监听,只重探
    expect(debugCalls).toHaveLength(1);
    expect(debugCalls[0].config.connect).toEqual({ host: '127.0.0.1', port: 5678 });
  });

  it('起监听指引:给三条现成路径与可复制命令,看完即止不附加', async () => {
    setWorkspaceAt('/tmp/kode-dbg');
    writeDebugJson({ baseapp: { debugpyPort: 5678 } });
    const manager = makeManager([], new MemoryMemento(), {
      probeTcpPort: probeSequence([closedProbe()]),
      checkDebugpy: preflightOk
    });
    await flushAsync();
    warnQueue.push('起监听指引');

    expect(await manager.attachToComponent('baseapp')).toBe(false);

    expect(debugCalls).toHaveLength(0);
    expect(messages.info).toHaveLength(1);
    expect(messages.info[0]).toContain('kbengine.debug.autoDebugpy');
    expect(messages.info[0]).toContain('kbengine.debug.waitAtStartup');
    expect(messages.info[0]).toContain('kbengine.python.debugpySync');
    expect(messages.info[0]).toContain('--listen 127.0.0.1:5678');
  });

  it('起监听成功但端口仍不开:按最新原因再来一轮,重试通了才附加', async () => {
    setWorkspaceAt('/tmp/kode-dbg');
    writeDebugJson({ baseapp: { debugpyPort: 5678 } });
    const manager = makeManager([], new MemoryMemento(), {
      probeTcpPort: probeSequence([closedProbe(), closedProbe(), { open: true }]),
      checkDebugpy: preflightOk,
      startDebugpyListener: async () => ({ ok: true, detail: 'listen 已发' })
    });
    await flushAsync();
    warnQueue.push('起监听并附加'); // 听了但没生效 → 再来一轮
    warnQueue.push('重试附加'); // 第二轮重探:通了

    expect(await manager.attachToComponent('baseapp')).toBe(true);

    expect(messages.warn).toHaveLength(2);
    expect(messages.warn[1]).toContain('仍未开');
    expect(messages.warn[1]).toContain('连接被拒'); // 第二轮带最新未开原因
    expect(warnOffers[1].actions).toEqual(['起监听并附加', '重试附加', '起监听指引']);
    expect(debugCalls).toHaveLength(1);
  });

  it('起监听面未接线:不假装能起,错误里给出指引口径', async () => {
    setWorkspaceAt('/tmp/kode-dbg');
    writeDebugJson({ baseapp: { debugpyPort: 5678 } });
    const manager = makeManager([], new MemoryMemento(), {
      probeTcpPort: probeSequence([closedProbe()]),
      checkDebugpy: preflightOk
      // 无 startDebugpyListener:极简装配面
    });
    await flushAsync();
    warnQueue.push('起监听并附加');

    expect(await manager.attachToComponent('baseapp')).toBe(false);

    expect(debugCalls).toHaveLength(0);
    expect(messages.error[0]).toContain('起监听指引');
  });

  it('关掉下一步弹窗:就此为止(不再探测不再附加)', async () => {
    setWorkspaceAt('/tmp/kode-dbg');
    writeDebugJson({ baseapp: { debugpyPort: 5678 } });
    let probeCount = 0;
    const manager = makeManager([], new MemoryMemento(), {
      probeTcpPort: async () => {
        probeCount += 1;
        return closedProbe();
      },
      checkDebugpy: preflightOk
    });
    await flushAsync();
    warnQueue.push(undefined); // 直接关掉

    expect(await manager.attachToComponent('baseapp')).toBe(false);
    await flushAsync();

    expect(probeCount).toBe(1); // 只有初探,没有重探
    expect(debugCalls).toHaveLength(0);
    expect(messages.error).toHaveLength(0);
  });
});
