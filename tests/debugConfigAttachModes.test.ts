// DebugConfigManager 附加模式机:DBG-007 截止与取消(超时/取消令牌/在途
// 守卫)与 IDE-PDBG-001 附加模式分派(端口模式 debugpy connect 直连 /
// 进程附加模式既有选择器;未配置端口首次弹模式选择并记住 workspaceState)。

import { describe, expect, it, afterAll, beforeAll, beforeEach } from 'vitest';
import { DEBUG_ATTACH_MODE_STATE_KEY } from '../src/debugConfig';
import {
  MemoryMemento,
  seededMemento,
  windowish,
  infoQueue,
  pickQueue,
  pickOffers,
  messages,
  debugCalls,
  makeManager,
  setWorkspaceAt,
  flushAsync,
  stubDebug,
  memoryFileSystem,
  registerAttachTestHooks
} from './helpers/debugConfigAttachHarness';
import { configurationOverrides } from './fake-vscode/workspaceState';

registerAttachTestHooks();

describe('attachToComponent/attachRemote 截止与取消(DBG-007)', () => {
  const debugish = stubDebug as unknown as Record<string, unknown>;
  let hung = false;
  const stopCalls: unknown[][] = [];
  const warnings: string[] = [];
  let fireCancel: (() => void) | undefined;
  // IDE-AUD-002:并发同名附加逐次收集取消触发器(首个=最先发起的附加),
  // 供按尝试单独取消;单附加用例沿用 fireCancel(最后注册的那个)
  const fireCancels: Array<() => void> = [];
  let cancelDisposals = 0;
  // IDE-REV-002:会话启动事件面——sessionFirePlan 控制本次 startDebugging
  // 期间先后「启动」哪些会话('own'=以本次配置名命名的自家会话,其余字串=
  // 并行运行的无关会话名),供停止面断言只停自家会话
  let sessionFirePlan: Array<'own' | string> | undefined;
  const sessionListeners: Array<(session: unknown) => void> = [];
  let sessionTrackerDisposals = 0;
  // REV-003:deferred=true 时 startDebugging 的落定权交测试——守卫已返回后
  // 测试手动 resolve/reject,并按需先触发会话启动事件(迟到成功时自家会话
  // 在 start 落定前才创建的真实序)
  let deferred = false;
  const pendingStarts: Array<{
    resolve: (value: boolean) => void;
    reject: (error: Error) => void;
  }> = [];
  const fireSessionStarted = (name: string): void => {
    // IDE-AUD-002:同名配置按已发起的 startDebugging 配置还原标记——自家
    // 会话携带本尝试配置(含 __kodeAttachId),无关同名会话不带标记。
    const config = debugCalls.find(call => (call.config as { name?: string }).name === name)?.config;
    const session = { id: `late:${name}`, name, ...(config ? { configuration: config } : {}) };
    for (const listener of [...sessionListeners]) {
      listener(session);
    }
  };
  let originalStart: unknown;
  let originalStop: unknown;
  let originalWithProgress: unknown;
  let originalWarn: unknown;
  let originalSessionEvent: unknown;

  beforeAll(() => {
    originalStart = debugish.startDebugging;
    originalStop = debugish.stopDebugging;
    originalWithProgress = windowish.withProgress;
    originalWarn = windowish.showWarningMessage;
    originalSessionEvent = debugish.onDidStartDebugSession;
    debugish.onDidStartDebugSession = (listener: (session: unknown) => void) => {
      sessionListeners.push(listener);
      return {
        dispose: () => {
          sessionTrackerDisposals += 1;
          // IDE-AUD-001:真 dispose 语义=退订——旧假替身只计数不移除,已释放
          // 的追踪器仍收事件,把 F01(迟到会话捕获不到句柄)长期掩盖成绿
          const index = sessionListeners.indexOf(listener);
          if (index >= 0) {
            sessionListeners.splice(index, 1);
          }
        }
      };
    };
    windowish.showWarningMessage = async (message: string) => {
      warnings.push(message);
      return undefined;
    };
    // 挂起面:hung=true 时 startDebugging 永不落定(模拟无人监听端口)
    debugish.startDebugging = async (
      folder: unknown,
      config: Record<string, unknown>
    ) => {
      debugCalls.push({ folder, config, result: true, throws: null });
      for (const item of sessionFirePlan ?? []) {
        // IDE-AUD-002:自家会话携带本尝试配置(含 __kodeAttachId 标记),
        // 会话追踪按标记归属;无关会话不带标记(同名也不被误捕获)。
        const session = item === 'own'
          ? { id: `own:${config.name}`, name: config.name, configuration: config }
          : { id: `other:${item}`, name: item };
        for (const listener of [...sessionListeners]) { listener(session); }
      }
      if (deferred) {
        return new Promise<boolean>((resolve, reject) => {
          pendingStarts.push({ resolve, reject });
        });
      }
      if (hung) {
        return new Promise<boolean>(() => undefined);
      }
      return true;
    };
    debugish.stopDebugging = async (...args: unknown[]) => {
      stopCalls.push(args);
    };
    // 可控取消面:捕获 token 的取消订阅(逐次收集,fireCancel 取最后注册者)
    windowish.withProgress = async (
      _options: unknown,
      task: (progress: unknown, token: unknown) => Promise<unknown>
    ) =>
      task(undefined, {
        isCancellationRequested: false,
        onCancellationRequested: (listener: () => void) => {
          fireCancels.push(listener);
          fireCancel = listener;
          return {
            dispose: () => {
              cancelDisposals += 1;
            }
          };
        }
      });
  });
  afterAll(() => {
    debugish.startDebugging = originalStart;
    debugish.stopDebugging = originalStop;
    debugish.onDidStartDebugSession = originalSessionEvent;
    windowish.withProgress = originalWithProgress;
    windowish.showWarningMessage = originalWarn;
  });
  beforeEach(() => {
    hung = false;
    stopCalls.length = 0;
    warnings.length = 0;
    cancelDisposals = 0;
    fireCancel = undefined;
    fireCancels.length = 0;
    sessionFirePlan = undefined;
    sessionListeners.length = 0;
    sessionTrackerDisposals = 0;
    deferred = false;
    pendingStarts.length = 0;
  });

  it('按期完成:withProgress 包裹,返回 true,零停止零警告,取消订阅已释放', async () => {
    setWorkspaceAt('/tmp/kode-dbg');
    pickQueue.push({ label: 'baseapp', description: '123' });
    const manager = makeManager([{ pid: 123, name: 'baseapp' }]);
    await flushAsync();

    expect(await manager.attachToComponent('baseapp')).toBe(true);

    expect(stopCalls).toHaveLength(0);
    expect(warnings).toHaveLength(0);
    expect(cancelDisposals).toBe(1);
  });

  it('不可达端口到点:自家会话未启动则零停止(无句柄不强杀他人)+超时提示,false 且不重试', async () => {
    setWorkspaceAt('/tmp/kode-dbg');
    configurationOverrides.set('kbengine', { 'debug.attachTimeoutMs': 5 });
    pickQueue.push({ label: 'baseapp', description: '123' });
    hung = true;
    const manager = makeManager([{ pid: 123, name: 'baseapp' }]);
    await flushAsync();

    expect(await manager.attachToComponent('baseapp')).toBe(false);

    expect(debugCalls).toHaveLength(1);
    // IDE-REV-002:挂起态自家会话从未启动,没有可停句柄——无参 stopDebugging
    // 会把并行无关会话一并停掉,此刻必须一次都不停
    expect(stopCalls).toHaveLength(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('超时');
    expect(warnings[0]).toContain('不再重试');
    configurationOverrides.clear();
  }, 10_000);

  it('进度通知上取消:同一停止路径,取消提示,false', async () => {
    setWorkspaceAt('/tmp/kode-dbg');
    pickQueue.push({ label: 'baseapp', description: '123' });
    hung = true;
    const manager = makeManager([{ pid: 123, name: 'baseapp' }]);
    await flushAsync();

    const attaching = manager.attachToComponent('baseapp');
    await new Promise(resolve => setTimeout(resolve, 0));
    fireCancel?.();
    expect(await attaching).toBe(false);

    // IDE-REV-002:挂起态无自家会话句柄,取消同样零停止
    expect(stopCalls).toHaveLength(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('已取消');
  });

  it('REV-002 并行无关会话:取消只停本次附加的自家会话,无关会话不动', async () => {
    setWorkspaceAt('/tmp/kode-dbg');
    pickQueue.push({ label: 'baseapp', description: '123' });
    // 并行面:无关会话已在运行;本次附加的会话随后启动(连接仍挂起)
    sessionFirePlan = ['无关的独立会话', 'own'];
    hung = true;
    const manager = makeManager([{ pid: 123, name: 'baseapp' }]);
    await flushAsync();

    const attaching = manager.attachToComponent('baseapp');
    await new Promise(resolve => setTimeout(resolve, 0));
    fireCancel?.();
    expect(await attaching).toBe(false);

    // 只停自家会话:stopDebugging 收到且仅收到本次附加的会话句柄,
    // 无关会话的名字绝不出现在任何停止调用里
    expect(stopCalls).toHaveLength(1);
    const stopped = (stopCalls[0] as Array<{ name?: string }>)[0];
    expect(stopped?.name).toBe('KBEngine: Python attach to baseapp');
    expect(stopCalls.some(call => (call[0] as { name?: string } | undefined)?.name === '无关的独立会话'))
      .toBe(false);
    // IDE-AUD-001:取消返回时 start 尚未落定(挂起),追踪订阅必须存活以捕获
    // 迟到会话——不得随守卫收口释放(F01 反例);卸载时兜底释放
    expect(sessionTrackerDisposals).toBe(0);
    manager.dispose();
    expect(sessionTrackerDisposals).toBe(1);
    expect(warnings[0]).toContain('已取消');
  });

  it('attachRemote 同一闸:远端会话已启动后到点,只停该远端会话', async () => {
    setWorkspaceAt('/tmp/kode-dbg');
    configurationOverrides.set('kbengine', {
      'debug.remoteTargets': [{ name: '外网', host: '10.0.0.8' }],
      'debug.attachTimeoutMs': 5
    });
    pickQueue.push({ label: '外网', description: '10.0.0.8:5678' });
    infoQueue.push('开始附加');
    sessionFirePlan = ['own'];
    hung = true;
    const manager = makeManager();
    await flushAsync();

    expect(await manager.attachRemote()).toBe(false);

    // IDE-REV-002:超时路径同一句柄语义——只停本次附加的远端会话
    expect(stopCalls).toHaveLength(1);
    const stopped = (stopCalls[0] as Array<{ name?: string }>)[0];
    expect(stopped?.name).toBe('KBEngine: Python attach 外网 (remote)');
    expect(warnings[0]).toContain('超时');
    // IDE-AUD-001:超时返回时 start 未落定,订阅存活;卸载兜底释放
    expect(sessionTrackerDisposals).toBe(0);
    manager.dispose();
    expect(sessionTrackerDisposals).toBe(1);
    configurationOverrides.clear();
  }, 10_000);

  it('REV-003 超时返回后 start 迟到成功:自家会话清一次,无关会话不动,无二次提示', async () => {
    setWorkspaceAt('/tmp/kode-dbg');
    configurationOverrides.set('kbengine', { 'debug.attachTimeoutMs': 5 });
    pickQueue.push({ label: 'baseapp', description: '123' });
    deferred = true;
    const manager = makeManager([{ pid: 123, name: 'baseapp' }]);
    await flushAsync();

    expect(await manager.attachToComponent('baseapp')).toBe(false);
    expect(stopCalls).toHaveLength(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('超时');

    // 迟到序:无关会话在场,自家会话此刻才启动,随后 start 才成功落定
    fireSessionStarted('无关的独立会话');
    fireSessionStarted('KBEngine: Python attach to baseapp');
    pendingStarts[0].resolve(true);
    await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => setTimeout(resolve, 0));

    // 迟到成功不遗留新会话:自家会话被清理恰一次,停止目标不含无关会话
    expect(stopCalls).toHaveLength(1);
    const stopped = (stopCalls[0] as Array<{ name?: string }>)[0];
    expect(stopped?.name).toBe('KBEngine: Python attach to baseapp');
    expect(stopCalls.some(call => (call[0] as { name?: string } | undefined)?.name === '无关的独立会话'))
      .toBe(false);
    // 不二次提示;会话追踪订阅在迟到落定后释放
    expect(warnings).toHaveLength(1);
    expect(sessionTrackerDisposals).toBe(1);
    configurationOverrides.clear();
  }, 10_000);

  it('REV-003 超时返回后 start 迟到拒绝:零停止,无二次提示,无 unhandled rejection', async () => {
    setWorkspaceAt('/tmp/kode-dbg');
    configurationOverrides.set('kbengine', { 'debug.attachTimeoutMs': 5 });
    pickQueue.push({ label: 'baseapp', description: '123' });
    deferred = true;
    const manager = makeManager([{ pid: 123, name: 'baseapp' }]);
    await flushAsync();

    expect(await manager.attachToComponent('baseapp')).toBe(false);

    pendingStarts[0].reject(new Error('迟到失败'));
    await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(stopCalls).toHaveLength(0);
    expect(warnings).toHaveLength(1);
    expect(sessionTrackerDisposals).toBe(1);
    configurationOverrides.clear();
  }, 10_000);

  it('AUD-001 超时返回后 start 永不落定:迟到自家会话立即停,卸载兜底释放订阅', async () => {
    setWorkspaceAt('/tmp/kode-dbg');
    configurationOverrides.set('kbengine', { 'debug.attachTimeoutMs': 5 });
    pickQueue.push({ label: 'baseapp', description: '123' });
    hung = true;
    const manager = makeManager([{ pid: 123, name: 'baseapp' }]);
    await flushAsync();

    expect(await manager.attachToComponent('baseapp')).toBe(false);
    // 超时返回零停止,订阅因 start 未落定而存活
    expect(stopCalls).toHaveLength(0);
    expect(sessionTrackerDisposals).toBe(0);

    // 迟到序:无关会话在场,自家会话此刻才启动——start 永不落定,只能靠
    // abandoned 标记立即停,不能等 onStartSettled
    fireSessionStarted('无关的独立会话');
    fireSessionStarted('KBEngine: Python attach to baseapp');
    await new Promise(resolve => setTimeout(resolve, 0));

    // 自家会话被停恰一次,无关会话不动
    expect(stopCalls).toHaveLength(1);
    const stopped = (stopCalls[0] as Array<{ name?: string }>)[0];
    expect(stopped?.name).toBe('KBEngine: Python attach to baseapp');
    expect(stopCalls.some(call => (call[0] as { name?: string } | undefined)?.name === '无关的独立会话'))
      .toBe(false);

    // 卸载兜底释放遗留订阅;已释放的订阅不再收事件,二次触发零新增停止
    manager.dispose();
    expect(sessionTrackerDisposals).toBe(1);
    fireSessionStarted('KBEngine: Python attach to baseapp');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(stopCalls).toHaveLength(1);
    configurationOverrides.clear();
  }, 10_000);

  it('AUD-002 并发同名附加:取消其一只停对应会话,另一尝试与无关同名会话不动', async () => {
    setWorkspaceAt('/tmp/kode-dbg');
    pickQueue.push(
      { label: 'baseapp', description: '123' },
      { label: 'baseapp', description: '456' }
    );
    hung = true;
    // 不随 startDebugging 同步发会话:两个尝试都挂起后由测试手动发,
    // 保证两个会话追踪器都在场(旧码按名字匹配时后者会捕获前者的会话)
    sessionFirePlan = [];
    const manager = makeManager([
      { pid: 123, name: 'baseapp' },
      { pid: 456, name: 'baseapp' }
    ]);
    await flushAsync();

    void manager.attachToComponent('baseapp');
    void manager.attachToComponent('baseapp');
    await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => setTimeout(resolve, 0));

    // 两个同名附加都已发起 startDebugging(hung),各带自己的尝试标记
    expect(debugCalls).toHaveLength(2);
    const config1 = debugCalls[0].config as Record<string, unknown>;
    const config2 = debugCalls[1].config as Record<string, unknown>;
    expect(config1.__kodeAttachId).toBeTruthy();
    expect(config2.__kodeAttachId).toBeTruthy();
    expect(config1.__kodeAttachId).not.toBe(config2.__kodeAttachId);

    const fireNow = (session: unknown): void => {
      for (const listener of [...sessionListeners]) { listener(session); }
    };
    // 无关同名会话(另一 workspace/窗口启动的同名会话,无本尝试标记)先到:
    // 不能被任一尝试误认为自家会话;两个本尝试会话随后启动(各带标记)
    const extSession = { id: 'ext:baseapp', name: 'KBEngine: Python attach to baseapp' };
    const ownSession1 = {
      id: 'own1',
      name: 'KBEngine: Python attach to baseapp',
      configuration: config1
    };
    const ownSession2 = {
      id: 'own2',
      name: 'KBEngine: Python attach to baseapp',
      configuration: config2
    };
    for (const session of [extSession, ownSession1, ownSession2]) {
      fireNow(session);
    }

    // 取消第二次尝试:只停该尝试的 ownSession2;另一尝试与无关同名会话不动
    fireCancels[1]?.();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(stopCalls).toHaveLength(1);
    const stopped = (stopCalls[0] as Array<{ id?: string; name?: string }>)[0];
    expect(stopped?.id).toBe('own2');
    expect(stopped?.name).toBe('KBEngine: Python attach to baseapp');
    expect(stopCalls.some(call => (call[0] as { id?: string } | undefined)?.id === 'own1'))
      .toBe(false);
    expect(stopCalls.some(call => (call[0] as { id?: string } | undefined)?.id === 'ext:baseapp'))
      .toBe(false);

    // hung=true:两个附加的 startDebugging 永不落定,attachToComponent 不会
    // resolve——只断言停止面,不等它们返回;管理器卸载兜底释放遗留订阅。
    manager.dispose();
  }, 10_000);
});

describe('IDE-PDBG-001 附加模式分派(端口模式 / 进程附加模式)', () => {
  const writeDebugJson = (components: Record<string, unknown>): void => {
    memoryFileSystem.set('/tmp/kode-dbg/.kbengine/debug.json', JSON.stringify({ debug: { components } }));
  };

  it('配置了 debugpyPort:直接 connect 附加,零选择器零模态', async () => {
    setWorkspaceAt('/tmp/kode-dbg');
    writeDebugJson({ baseapp: { debugpyHost: '10.1.2.3', debugpyPort: 5678 } });
    const memento = new MemoryMemento(); // 未记忆任何模式:配置即端口模式,不该问
    const manager = makeManager([], memento);
    await flushAsync();

    expect(await manager.attachToComponent('baseapp')).toBe(true);

    expect(debugCalls).toHaveLength(1);
    expect(debugCalls[0].config.connect).toEqual({ host: '10.1.2.3', port: 5678 });
    expect(debugCalls[0].config.name).toBe('KBEngine: Python attach to baseapp (debugpy 5678)');
    expect(debugCalls[0].config.request).toBe('attach');
    expect(pickOffers).toHaveLength(0); // 无模式选择器/进程选择器
    expect(memento.get<string>(DEBUG_ATTACH_MODE_STATE_KEY)).toBeUndefined(); // 不落记忆(配置即模式)
  });

  it('startDebugging 端口已配置:不弹 telnet 模态,直接端口模式附加', async () => {
    setWorkspaceAt('/tmp/kode-dbg');
    writeDebugJson({ cellapp: { debugpyPort: 5679 } });
    const manager = makeManager();
    await flushAsync();

    expect(await manager.startDebugging('cellapp')).toBe(true);

    expect(messages.info).toHaveLength(0); // telnet 简报不再打扰端口模式
    expect(debugCalls[0].config.connect).toEqual({ host: '127.0.0.1', port: 5679 }); // host 缺省 127.0.0.1
  });

  it('未配置且未记忆:首次弹模式选择,选端口模式→记忆落盘+组件默认端口表 connect', async () => {
    setWorkspaceAt('/tmp/kode-dbg');
    const memento = new MemoryMemento();
    const manager = makeManager([], memento);
    await flushAsync();

    pickQueue.push({ label: '$(plug) 端口模式', mode: 'debugpy-port' });
    expect(await manager.attachToComponent('cellapp')).toBe(true);

    // 首次:选择器是模式选择(两模式+清除),不是进程清单
    expect(pickOffers).toHaveLength(1);
    const labels = pickOffers[0].map(item => item.label);
    expect(labels.some(label => label.includes('端口模式'))).toBe(true);
    expect(labels.some(label => label.includes('进程附加模式'))).toBe(true);
    expect(labels.some(label => label.includes('清除记住的选择'))).toBe(true);
    // cellapp 未配置端口 → 端口表 5679
    expect(debugCalls[0].config.connect).toEqual({ host: '127.0.0.1', port: 5679 });
    expect(memento.get<string>(DEBUG_ATTACH_MODE_STATE_KEY)).toBe('debugpy-port');
  });

  it('表外组件端口模式落 debugpy 默认 5678', async () => {
    setWorkspaceAt('/tmp/kode-dbg');
    const memento = new MemoryMemento();
    const manager = makeManager([], memento);
    await flushAsync();

    pickQueue.push({ label: '$(plug) 端口模式', mode: 'debugpy-port' });
    expect(await manager.attachToComponent('bots')).toBe(true); // bots 不在端口表

    expect(debugCalls[0].config.connect).toEqual({ host: '127.0.0.1', port: 5678 });
  });

  it('选进程附加模式→记忆+走既有进程选择器(PID 入配置)', async () => {
    setWorkspaceAt('/tmp/kode-dbg');
    const memento = new MemoryMemento();
    const manager = makeManager([{ pid: 4321, name: 'baseapp' }], memento);
    await flushAsync();

    pickQueue.push({ label: '$(search) 进程附加模式', mode: 'process-attach' });
    pickQueue.push({ label: '$(check) baseapp', description: '4321' });
    expect(await manager.attachToComponent('baseapp')).toBe(true);

    expect(pickOffers).toHaveLength(2); // 模式选择 + 进程选择
    expect(debugCalls[0].config.processId).toBe(4321);
    expect(memento.get<string>(DEBUG_ATTACH_MODE_STATE_KEY)).toBe('process-attach');
  });

  it('第二次不再问:记住的模式直接走,零模式选择器', async () => {
    setWorkspaceAt('/tmp/kode-dbg');
    const memento = seededMemento('process-attach');
    const manager = makeManager([{ pid: 4321, name: 'baseapp' }], memento);
    await flushAsync();

    pickQueue.push({ label: '$(check) baseapp', description: '4321' });
    expect(await manager.attachToComponent('baseapp')).toBe(true);

    expect(pickOffers).toHaveLength(1); // 只有进程选择器
    expect(pickOffers[0].some(item => item.label.includes('进程附加模式'))).toBe(false);
    expect(debugCalls[0].config.processId).toBe(4321);
  });

  it('记住端口模式:直接 connect(未配置端口的组件也走端口表)', async () => {
    setWorkspaceAt('/tmp/kode-dbg');
    const manager = makeManager([], seededMemento('debugpy-port'));
    await flushAsync();

    expect(await manager.attachToComponent('loginapp')).toBe(true);

    expect(pickOffers).toHaveLength(0);
    expect(debugCalls[0].config.connect).toEqual({ host: '127.0.0.1', port: 5680 });
  });

  it('「清除记住的选择」:不记忆不附加,下次再问', async () => {
    setWorkspaceAt('/tmp/kode-dbg');
    const memento = new MemoryMemento();
    const manager = makeManager([], memento);
    await flushAsync();

    pickQueue.push({ label: '$(discard) 清除记住的选择', mode: 'clear' });
    expect(await manager.attachToComponent('baseapp')).toBe(false);

    expect(debugCalls).toHaveLength(0);
    expect(memento.get<string>(DEBUG_ATTACH_MODE_STATE_KEY)).toBeUndefined();

    // 下次再问:模式选择器再次出现
    pickQueue.push(undefined);
    expect(await manager.attachToComponent('baseapp')).toBe(false);
    expect(pickOffers.at(-1)?.some(item => item.label.includes('端口模式'))).toBe(true);
  });

  it('模式选择取消:不附加(false 且无调试会话)', async () => {
    setWorkspaceAt('/tmp/kode-dbg');
    const memento = new MemoryMemento();
    const manager = makeManager([], memento);
    await flushAsync();

    pickQueue.push(undefined);
    expect(await manager.attachToComponent('baseapp')).toBe(false);

    expect(debugCalls).toHaveLength(0);
    expect(memento.get<string>(DEBUG_ATTACH_MODE_STATE_KEY)).toBeUndefined(); // 取消不记忆
  });

  it('端口配置为 0/负数/非数:视为未配置走模式分派(缺省=未配置)', async () => {
    setWorkspaceAt('/tmp/kode-dbg');
    writeDebugJson({ baseapp: { debugpyPort: 0 }, cellapp: { debugpyPort: -5 }, loginapp: { debugpyPort: '5678' } });
    const manager = makeManager([], new MemoryMemento());
    await flushAsync();

    expect(manager.getComponentConfig('baseapp').debugpyPort).toBeUndefined();
    expect(manager.getComponentConfig('cellapp').debugpyPort).toBeUndefined();
    expect(manager.getComponentConfig('loginapp').debugpyPort).toBeUndefined();

    pickQueue.push({ label: '$(plug) 端口模式', mode: 'debugpy-port' });
    expect(await manager.attachToComponent('baseapp')).toBe(true);
    expect(debugCalls[0].config.connect).toEqual({ host: '127.0.0.1', port: 5678 }); // 端口表 baseapp=5678
  });
});
