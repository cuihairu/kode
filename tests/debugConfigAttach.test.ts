import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DebugConfigManager, DEBUG_ATTACH_MODE_STATE_KEY, readRemoteTargets } from '../src/debugConfig';
import type * as vscode from 'vscode';
import {
  debug as stubDebug,
  memoryFileSystem,
  window as stubWindow,
  workspace as stubWorkspace,
  Uri
} from './helpers/vscodeStub';
import { configurationOverrides } from './fake-vscode/workspaceState';

// DebugConfigManager 的调试会话编排:startDebugging 的 modal 提示两分支
// (有/无 telnet 命令)、attachToComponent 的进程选择(批112 用户令:按组件名
// 过滤的 quick pick,选中 PID 直接写入 DebugConfiguration)→
// vscode.debug.startDebugging、createExampleConfig/updateLaunchJson 的写盘
// 失败通道。配置装载与 launch 生成已由 debugConfig.test.ts 覆盖。
// IDE-PDBG-001:附加入口分派端口模式(debugpy connect 直连)与进程附加
// 模式(既有选择器);未配置端口首次弹模式选择并记住(workspaceState)。
// IDE-PDBG-002:端口模式 connect 前置探测——通则零弹窗直附加;不通分
// 开说端口未开/未装 debugpy,未装给一键安装,装完/端口开了再附加。

interface InputBoxOptions {
  prompt?: string;
  validateInput?: (value: string) => string | null;
}

interface QuickPickLike {
  label: string;
  description?: string;
  mode?: string;
}

/** workspaceState 替身:模式选择记忆(IDE-PDBG-001)落这里读回 */
class MemoryMemento {
  private readonly map = new Map<string, unknown>();
  get<T>(key: string, defaultValue?: T): T | undefined {
    return this.map.has(key) ? (this.map.get(key) as T) : defaultValue;
  }
  update(key: string, value: unknown): Promise<void> {
    if (value === undefined) {
      this.map.delete(key);
    } else {
      this.map.set(key, value);
    }
    return Promise.resolve();
  }
  keys(): readonly string[] {
    return [...this.map.keys()];
  }
  setKeysForSync(_keys: readonly string[]): void {
    // 内存替身不参与云同步
  }
}

/** 已记住进程附加模式的 memento:既有进程选择器用例的前提(PDBG-001 起,未配置端口的首次会先问模式) */
const seededMemento = (mode: string): MemoryMemento => {
  const memento = new MemoryMemento();
  memento.map.set(DEBUG_ATTACH_MODE_STATE_KEY, mode);
  return memento;
};

const windowish = stubWindow as unknown as Record<string, unknown>;
const originalWindow: Record<string, unknown> = {};
const patchedKeys = [
  'showInputBox',
  'showInformationMessage',
  'showErrorMessage',
  'showQuickPick',
  'showWarningMessage'
];

const inputs: Array<string | undefined> = [];
const inputOptions: InputBoxOptions[] = [];
const infoQueue: Array<string | undefined> = [];
const warnQueue: Array<string | undefined> = [];
const pickQueue: Array<QuickPickLike | undefined> = [];
/** 每次选择器弹出的条目面(模式选择/进程选择都在此对账) */
const pickOffers: QuickPickLike[][] = [];
/** 每次警告弹窗的 (文案, 动作清单) 面(IDE-PDBG-002 端口分诊在此对账) */
const warnOffers: Array<{ message: string; actions: string[] }> = [];
const messages = { info: [] as string[], error: [] as string[], warn: [] as string[] };

interface DebugCall {
  folder: unknown;
  config: Record<string, unknown>;
  result: boolean;
  throws: Error | null;
}

const debugCalls: DebugCall[] = [];
let debugResult = true;
let debugThrows: Error | null = null;

/** IDE-PDBG-002 附加依赖注入面:探测/预检/安装都可控 */
interface ManagerExtraDeps {
  probeTcpPort?: (
    host: string,
    port: number,
    timeoutMs: number
  ) => Promise<{ open: boolean; reason?: string; detail?: string }>;
  checkDebugpy?: () => Promise<{
    kind: string;
    interpreterPath: string | null;
    version: string | null;
    message: string;
  }>;
  installDebugpy?: (interpreterPath: string) => Promise<{ ok: boolean; detail: string }>;
}

const makeManager = (
  processes: Array<{ pid: number; name: string }> = [],
  workspaceState: unknown = seededMemento('process-attach'),
  extraDeps: ManagerExtraDeps = {}
) =>
  new DebugConfigManager(
    { subscriptions: [], workspaceState } as unknown as vscode.ExtensionContext,
    {
      listProcesses: () => processes,
      // 端口探测缺省打「通」:既有端口模式用例都在端口可达面上(探测门是
      // IDE-PDBG-002 的产品行为,专用 describe 注入「不通」逐因分诊)
      probeTcpPort: extraDeps.probeTcpPort ?? (async () => ({ open: true })),
      ...(extraDeps.checkDebugpy ? { checkDebugpy: extraDeps.checkDebugpy } : {}),
      ...(extraDeps.installDebugpy ? { installDebugpy: extraDeps.installDebugpy } : {})
    }
  );

/** 本机 debugpy 预检替身(IDE-PDBG-002 分诊的注入面) */
const preflightStatus = (
  kind: string,
  interpreterPath: string | null = '/usr/bin/python3',
  version: string | null = '1.8.0'
) => ({ kind, interpreterPath, version, message: `debugpy 预检:${kind}` });

const setWorkspaceAt = (fsPath: string | null): void => {
  stubWorkspace.workspaceFolders = fsPath
    ? [{ uri: Uri.file(fsPath), name: 'ws', index: 0 }]
    : [];
};

// 构造器内 loadConfig 是异步读盘,留一个宏任务节拍让它落地
const flushAsync = () => new Promise<void>(resolve => setTimeout(resolve, 0));

beforeAll(() => {
  for (const key of patchedKeys) {
    originalWindow[key] = windowish[key];
  }
  windowish.showInputBox = async (options?: InputBoxOptions): Promise<string | undefined> => {
    if (options) {
      inputOptions.push(options);
    }
    return inputs.shift();
  };
  windowish.showInformationMessage = async (message: string) => {
    messages.info.push(message);
    return infoQueue.shift();
  };
  windowish.showErrorMessage = async (message: string) => {
    messages.error.push(message);
    return undefined;
  };
  windowish.showWarningMessage = async (
    message: string,
    ...actions: string[]
  ): Promise<string | undefined> => {
    messages.warn.push(message);
    warnOffers.push({ message, actions });
    return warnQueue.shift();
  };
  windowish.showQuickPick = async (items: QuickPickLike[]) => {
    pickOffers.push(items);
    return pickQueue.shift();
  };
  (stubDebug as unknown as Record<string, unknown>).startDebugging = async (
    folder: unknown,
    config: Record<string, unknown>
  ) => {
    if (debugThrows) {
      throw debugThrows;
    }
    debugCalls.push({ folder, config, result: debugResult, throws: null });
    return debugResult;
  };
});

afterAll(() => {
  for (const key of patchedKeys) {
    windowish[key] = originalWindow[key];
  }
  delete (stubDebug as unknown as Record<string, unknown>).startDebugging;
});

beforeEach(() => {
  memoryFileSystem.reset();
  setWorkspaceAt(null);
  inputs.length = 0;
  inputOptions.length = 0;
  infoQueue.length = 0;
  warnQueue.length = 0;
  pickQueue.length = 0;
  messages.info.length = 0;
  messages.error.length = 0;
  messages.warn.length = 0;
  pickOffers.length = 0;
  warnOffers.length = 0;
  debugCalls.length = 0;
  debugResult = true;
  debugThrows = null;
});

describe('DebugConfigManager.startDebugging', () => {
  it('shows the modal briefing with telnet commands and attaches on confirm', async () => {
    setWorkspaceAt('/tmp/kode-dbg');
    const manager = makeManager([{ pid: 4321, name: 'baseapp' }]);
    pickQueue.push({ label: '$(check) baseapp', description: '4321' });
    const config = manager.getComponentConfig('baseapp');
    infoQueue.push('继续附加');

    const result = await manager.startDebugging('baseapp');

    expect(result).toBe(true);
    expect(messages.info).toHaveLength(1);
    const message = messages.info[0];
    expect(message).toContain('telnet 控制端口');
    expect(message).toContain(`telnet ${config.telnetHost} ${config.telnetPort}`);
    expect(message).toContain(`password: ${config.telnetPassword}`);
    expect(message).toContain(`default layer: ${config.telnetDefaultLayer}`);
    for (const command of config.telnetEnableCommands ?? []) {
      expect(message).toContain(command);
    }

    expect(debugCalls).toHaveLength(1);
    const attachConfig = debugCalls[0].config;
    expect(attachConfig.name).toBe('KBEngine: Python attach to baseapp');
    expect(attachConfig.request).toBe('attach');
    // 批112 用户令:附加前经进程选择器选进程,PID 直接写入配置(不再走
    // ${command:pickProcess} 原生选择器)
    expect(attachConfig.processId).toBe(4321);
    expect(attachConfig.pathMappings).toEqual(config.pathMappings);
    expect(attachConfig.justMyCode).toBe(false);
    // 选择器形态下扩展自身不再弹输入框
    expect(inputOptions).toHaveLength(0);
  }, 8000);

  it('shows the short briefing when the component has no telnet commands', async () => {
    setWorkspaceAt('/tmp/kode-dbg');
    const manager = makeManager();
    const config = manager.getComponentConfig('cellapp');
    infoQueue.push(undefined);

    const result = await manager.startDebugging('cellapp');

    expect(result).toBe(false);
    expect(debugCalls).toHaveLength(0);
    expect(messages.info).toHaveLength(1);
    expect(messages.info[0]).toContain(`telnet ${config.telnetHost} ${config.telnetPort}`);
  }, 8000);

  it('lists configured telnet enable commands in the long briefing', async () => {
    setWorkspaceAt('/tmp/kode-dbg');
    memoryFileSystem.set(
      '/tmp/kode-dbg/.kbengine/debug.json',
      JSON.stringify({
        debug: {
          components: {
            baseapp: { telnetEnableCommands: ['layer 1', 'lookup 123'] }
          }
        }
      })
    );
    const manager = makeManager();
    await flushAsync();
    infoQueue.push(undefined);

    const result = await manager.startDebugging('baseapp');

    // 长 briefing 分支:逐条列出开启调试的 telnet 命令;看完即取消不进附加
    expect(result).toBe(false);
    expect(debugCalls).toHaveLength(0);
    const message = messages.info[0];
    expect(message).toContain('以 telnet 控制端口为前提');
    expect(message).toContain('telnet 127.0.0.1 0');
    expect(message).toContain('layer 1');
    expect(message).toContain('lookup 123');
  }, 8000);

  it('falls back to documented defaults for explicitly empty telnet fields', async () => {
    setWorkspaceAt('/tmp/kode-dbg');
    memoryFileSystem.set(
      '/tmp/kode-dbg/.kbengine/debug.json',
      JSON.stringify({
        debug: {
          components: {
            cellapp: { telnetHost: '', telnetPort: 0, telnetPassword: '', telnetDefaultLayer: '' }
          }
        }
      })
    );
    const manager = makeManager();
    await flushAsync();
    infoQueue.push(undefined);

    const result = await manager.startDebugging('cellapp');

    // 显式空值与缺省键同观感:主机/端口/密码/层级全部走文档默认
    expect(result).toBe(false);
    expect(messages.info[0]).toContain('telnet 127.0.0.1 0');
    expect(messages.info[0]).toContain('password: pwd123456');
    expect(messages.info[0]).toContain('default layer: python');
  }, 8000);

  it('uses the literal host fallback when the merged host is empty', async () => {
    setWorkspaceAt('/tmp/kode-dbg');
    // 合并层 defaultTelnetHost 置空串:getComponentConfig 吐出空主机,
    // 提示层的 '127.0.0.1' 字面量兜底由此可达
    memoryFileSystem.set(
      '/tmp/kode-dbg/.kbengine/debug.json',
      JSON.stringify({
        debug: {
          defaultTelnetHost: '',
          components: { cellapp: {} }
        }
      })
    );
    const manager = makeManager();
    await flushAsync();
    infoQueue.push(undefined);

    expect(await manager.startDebugging('cellapp')).toBe(false);
    expect(messages.info[0]).toContain('telnet 127.0.0.1 0');
  }, 8000);

  it('propagates a false startDebugging result', async () => {
    setWorkspaceAt('/tmp/kode-dbg');
    const manager = makeManager([{ pid: 4321, name: 'loginapp' }]);
    pickQueue.push({ label: '$(check) loginapp', description: '4321' });
    infoQueue.push('继续附加');
    debugResult = false;

    expect(await manager.startDebugging('loginapp')).toBe(false);
    expect(debugCalls).toHaveLength(1);
    expect(messages.error).toEqual([]);
  }, 8000);

  it('reports startDebugging failures through the error channel', async () => {
    setWorkspaceAt('/tmp/kode-dbg');
    const manager = makeManager([{ pid: 4321, name: 'loginapp' }]);
    pickQueue.push({ label: '$(check) loginapp', description: '4321' });
    infoQueue.push('继续附加');
    debugThrows = new Error('no debugpy');

    const result = await manager.startDebugging('loginapp');

    expect(result).toBe(false);
    expect(messages.error).toEqual(['附加调试失败: Error: no debugpy']);
  }, 8000);
});

describe('DebugConfigManager.attachToComponent (批112 进程选择器)', () => {
  it('进程选择后以数字 PID 组装附加配置,不带输入框', async () => {
    setWorkspaceAt('/tmp/kode-dbg');
    const manager = makeManager([
      { pid: 1, name: 'systemd' },
      { pid: 4321, name: 'baseapp' }
    ]);
    pickQueue.push({ label: '$(check) baseapp', description: '4321' });

    expect(await manager.attachToComponent('baseapp')).toBe(true);

    expect(debugCalls).toHaveLength(1);
    const attachConfig = debugCalls[0].config;
    expect(attachConfig.name).toBe('KBEngine: Python attach to baseapp');
    expect(attachConfig.type).toBe('debugpy');
    expect(attachConfig.request).toBe('attach');
    expect(attachConfig.processId).toBe(4321);
    expect(attachConfig.justMyCode).toBe(false);
    expect(inputOptions).toHaveLength(0);
  }, 8000);

  it('匹配组件名的进程置顶并带 $(check) 标记', async () => {
    setWorkspaceAt('/tmp/kode-dbg');
    const manager = makeManager([
      { pid: 1, name: 'systemd' },
      { pid: 40001, name: 'BASEAPP' }, // 大小写不敏感命中
      { pid: 4321, name: 'baseapp' },
      { pid: 4322, name: 'cellapp' }
    ]);
    let offered: QuickPickLike[] = [];
    windowish.showQuickPick = async (items: QuickPickLike[]) => {
      offered = items;
      return pickQueue.shift();
    };
    pickQueue.push({ label: '$(check) baseapp', description: '4321' });

    await manager.attachToComponent('baseapp');

    expect(offered.map(item => item.label)).toEqual([
      '$(check) BASEAPP',
      '$(check) baseapp',
      'systemd',
      'cellapp'
    ]);
    windowish.showQuickPick = async (items: QuickPickLike[]) => {
      pickOffers.push(items);
      return pickQueue.shift();
    };
  }, 8000);

  it('选择器取消 → 不附加(false 且无 startDebugging)', async () => {
    setWorkspaceAt('/tmp/kode-dbg');
    const manager = makeManager([{ pid: 4321, name: 'baseapp' }]);
    pickQueue.push(undefined);

    expect(await manager.attachToComponent('baseapp')).toBe(false);
    expect(debugCalls).toHaveLength(0);
    expect(messages.error).toEqual([]);
  }, 8000);

  it('进程清单为空 → 错误提示且不附加', async () => {
    setWorkspaceAt('/tmp/kode-dbg');
    const manager = makeManager([]);

    expect(await manager.attachToComponent('baseapp')).toBe(false);
    expect(debugCalls).toHaveLength(0);
    expect(messages.error[0]).toContain('未获取到进程列表');
  }, 8000);

  it('reports failures through the error channel', async () => {
    setWorkspaceAt('/tmp/kode-dbg');
    const manager = makeManager([{ pid: 4322, name: 'cellapp' }]);
    pickQueue.push({ label: '$(check) cellapp', description: '4322' });
    debugThrows = new Error('no debugpy');

    expect(await manager.attachToComponent('cellapp')).toBe(false);
    expect(messages.error).toEqual(['附加调试失败: Error: no debugpy']);
  }, 8000);

  it('propagates a false startDebugging result without error spam', async () => {
    setWorkspaceAt('/tmp/kode-dbg');
    const manager = makeManager([{ pid: 4321, name: 'loginapp' }]);
    pickQueue.push({ label: '$(check) loginapp', description: '4321' });
    debugResult = false;

    expect(await manager.attachToComponent('loginapp')).toBe(false);
    expect(debugCalls).toHaveLength(1);
    expect(messages.error).toEqual([]);
  }, 8000);

  it('default 清单器走真 ps(注入缺省臂),选择取消收尾', async () => {
    setWorkspaceAt('/tmp/kode-dbg');
    const bareManager = new DebugConfigManager(
      { subscriptions: [], workspaceState: seededMemento('process-attach') } as unknown as vscode.ExtensionContext
    );
    pickQueue.push(undefined);

    // 真机 ps 至少能看到 ps 自身/node 测试进程;取消选择即整体不附加
    expect(await bareManager.attachToComponent('baseapp')).toBe(false);
    expect(debugCalls).toHaveLength(0);
  }, 8000);
});

describe('DebugConfigManager write-failure channels', () => {
  it('reports example config write failures', async () => {
    setWorkspaceAt('/tmp/kode-dbg');
    const manager = makeManager();
    const originalWriteFile = stubWorkspace.fs.writeFile;
    stubWorkspace.fs.writeFile = async () => {
      throw new Error('read-only fs');
    };

    const result = await manager.createExampleConfig();
    stubWorkspace.fs.writeFile = originalWriteFile;

    expect(result).toBe(false);
    expect(messages.error[0]).toContain('创建调试配置失败');
    expect(messages.error[0]).toContain('read-only fs');
  });

  it('reports launch.json write failures', async () => {
    setWorkspaceAt('/tmp/kode-dbg');
    const manager = makeManager();
    const originalWriteFile = stubWorkspace.fs.writeFile;
    stubWorkspace.fs.writeFile = async () => {
      throw new Error('disk full');
    };

    const result = await manager.updateLaunchJson();
    stubWorkspace.fs.writeFile = originalWriteFile;

    expect(result).toBe(false);
    expect(messages.error[0]).toContain('更新 launch.json 失败');
    expect(messages.error[0]).toContain('disk full');
  });
});

describe('DebugConfigManager.attachRemote + readRemoteTargets (批112 远程调试)', () => {
  it('未配置 remoteTargets:提示去设置,false 且无调试会话', async () => {
    setWorkspaceAt('/tmp/kode-dbg');
    const manager = makeManager();

    expect(await manager.attachRemote()).toBe(false);
    expect(debugCalls).toHaveLength(0);
    expect(messages.info[0]).toContain('kbengine.debug.remoteTargets');
  });

  it('选择目标 + 模态确认后以 debugpy connect 配置附加', async () => {
    setWorkspaceAt('/tmp/kode-dbg');
    configurationOverrides.set('kbengine', {
      'debug.remoteTargets': [
        { name: '外网 baseapp', host: '10.0.0.8', port: 5678 },
        { name: '', host: '10.0.0.9' }, // name 空:不收
        { name: '内网', host: '' }, // host 空:不收
        { name: 123, host: '10.0.0.10' }, // name 非字符串:不收
        { name: '内网', host: null }, // host 非字符串:不收
        null, // 条目非对象:optional chain 短路,不收
        undefined, // 同上
        {}, // 无 name 键:undefined → 空名不收
        { name: '内网', host: '192.168.1.5' } // port 缺省落 5678
      ]
    });
    const manager = makeManager();
    pickQueue.push({ label: '外网 baseapp', description: '10.0.0.8:5678' });
    infoQueue.push('开始附加');

    expect(await manager.attachRemote()).toBe(true);

    expect(debugCalls).toHaveLength(1);
    const attachConfig = debugCalls[0].config;
    expect(attachConfig.name).toBe('KBEngine: Python attach 外网 baseapp (remote)');
    expect(attachConfig.type).toBe('debugpy');
    expect(attachConfig.request).toBe('attach');
    expect(attachConfig.connect).toEqual({ host: '10.0.0.8', port: 5678 });
    expect(attachConfig.justMyCode).toBe(false);
    expect(messages.info[0]).toContain('10.0.0.8:5678');
    configurationOverrides.clear();
  });

  it('选择取消 / 模态取消 / startDebugging 失败三态', async () => {
    setWorkspaceAt('/tmp/kode-dbg');
    configurationOverrides.set('kbengine', {
      'debug.remoteTargets': [{ name: '外网', host: '10.0.0.8' }]
    });
    const manager = makeManager();

    // quick pick 取消
    pickQueue.push(undefined);
    expect(await manager.attachRemote()).toBe(false);
    expect(debugCalls).toHaveLength(0);

    // 模态确认取消
    pickQueue.push({ label: '外网', description: '10.0.0.8:5678' });
    infoQueue.push(undefined);
    expect(await manager.attachRemote()).toBe(false);
    expect(debugCalls).toHaveLength(0);

    // startDebugging 异常走错误通道
    pickQueue.push({ label: '外网', description: '10.0.0.8:5678' });
    infoQueue.push('开始附加');
    debugThrows = new Error('no route');
    expect(await manager.attachRemote()).toBe(false);
    expect(messages.error).toEqual(['附加远程调试失败: Error: no route']);

    // startDebugging 返回 false 不刷错误
    debugThrows = null;
    debugResult = false;
    pickQueue.push({ label: '外网', description: '10.0.0.8:5678' });
    infoQueue.push('开始附加');
    expect(await manager.attachRemote()).toBe(false);
    expect(debugCalls).toHaveLength(1);
    expect(messages.error).toEqual(['附加远程调试失败: Error: no route']);
    configurationOverrides.clear();
  });

  it('选中项 PID 描述非法:不附加(pid 校验拒绝)', async () => {
    setWorkspaceAt('/tmp/kode-dbg');
    const manager = makeManager([{ pid: 4321, name: 'baseapp' }]);
    pickQueue.push({ label: '$(check) baseapp', description: 'not-a-pid' });

    expect(await manager.attachToComponent('baseapp')).toBe(false);
    expect(debugCalls).toHaveLength(0);
  });

  it('选择项不在目标列表:不附加(false 且无 startDebugging)', async () => {
    setWorkspaceAt('/tmp/kode-dbg');
    configurationOverrides.set('kbengine', {
      'debug.remoteTargets': [{ name: '外网', host: '10.0.0.8' }]
    });
    const manager = makeManager();
    pickQueue.push({ label: '不存在', description: '10.0.0.9:5678' });

    expect(await manager.attachRemote()).toBe(false);
    expect(debugCalls).toHaveLength(0);
    configurationOverrides.clear();
  });

  it('remoteTargets 显式 null:?? 兜底空数组,返回空清单', () => {
    setWorkspaceAt('/tmp/kode-dbg');
    configurationOverrides.set('kbengine', { 'debug.remoteTargets': null });

    expect(readRemoteTargets()).toEqual([]);
    configurationOverrides.clear();
  });

  it('generateLaunchConfigurations 把远程目标追加为 order 2 的 connect 配置', () => {
    setWorkspaceAt('/tmp/kode-dbg');
    configurationOverrides.set('kbengine', {
      'debug.remoteTargets': [{ name: '外网', host: '10.0.0.8', port: 6666 }]
    });
    const manager = makeManager();

    const configurations = manager.generateLaunchConfigurations();
    const remote = configurations.filter(
      (item: { name: string }) => item.name === 'KBEngine: Python attach 外网 (remote)'
    );
    expect(remote).toHaveLength(1);
    expect(remote[0].connect).toEqual({ host: '10.0.0.8', port: 6666 });
    expect(remote[0].presentation).toEqual({ group: 'KBEngine', order: 2 });
    expect(remote[0].pathMappings).toBeUndefined();
    // 本地组件配置照旧在前
    expect(configurations[0].processId).toBe('${command:pickProcess}');
    configurationOverrides.clear();
  });
});

describe('attachToComponent/attachRemote 截止与取消(DBG-007)', () => {
  const debugish = stubDebug as unknown as Record<string, unknown>;
  let hung = false;
  const stopCalls: unknown[][] = [];
  const warnings: string[] = [];
  let fireCancel: (() => void) | undefined;
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
    for (const listener of [...sessionListeners]) {
      listener({ id: `late:${name}`, name });
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
        const session = item === 'own'
          ? { id: `own:${config.name}`, name: config.name }
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
    // 可控取消面:捕获 token 的取消订阅
    windowish.withProgress = async (
      _options: unknown,
      task: (progress: unknown, token: unknown) => Promise<unknown>
    ) =>
      task(undefined, {
        isCancellationRequested: false,
        onCancellationRequested: (listener: () => void) => {
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
    // 会话追踪订阅随守卫收口释放,不遗留
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
    // 本机 debugpy 就绪时无安装动作
    expect(warnOffers[0].actions).toHaveLength(0);
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
    expect(messages.info[0]).toContain('/usr/bin/python3 -m pip install -U debugpy');
    expect(messages.info[0]).toContain('kbengine.python.debugpySync');
  });

  it('debugpy 过老也归因缺包给安装动作;未找到解释器只给设置指引', async () => {
    setWorkspaceAt('/tmp/kode-dbg');
    writeDebugJson({ baseapp: { debugpyPort: 5678 }, cellapp: { debugpyPort: 5679 } });
    const outdatedManager = makeManager([], new MemoryMemento(), {
      probeTcpPort: closedProbe('timeout', 'connect timeout after 1500ms'),
      checkDebugpy: async () => preflightStatus('debugpy-outdated', '/usr/bin/python3', '1.6.0')
    });
    await flushAsync();
    expect(await outdatedManager.attachToComponent('baseapp')).toBe(false);
    expect(messages.warn[0]).toContain('过老');
    expect(warnOffers[0].actions).toContain('一键安装 debugpy');

    const noInterpreterManager = makeManager([], new MemoryMemento(), {
      probeTcpPort: closedProbe('timeout', 'connect timeout after 1500ms'),
      checkDebugpy: async () => preflightStatus('interpreter-missing', null, null)
    });
    await flushAsync();
    expect(await noInterpreterManager.attachToComponent('cellapp')).toBe(false);
    expect(messages.warn[1]).toContain('kbengine.python.interpreterPath');
    expect(warnOffers[1].actions).toHaveLength(0); // 解释器都没有:无可安装面
    expect(debugCalls).toHaveLength(0);
  });
});
