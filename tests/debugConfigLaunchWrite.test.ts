import type * as vscode from 'vscode';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEBUG_ATTACH_MODE_STATE_KEY,
  DebugConfigManager,
  KBENGINE_LAUNCH_GENERATED_KEY,
  buildPortLaunchEntry,
  dropSupersededPortEntries,
  mergePortLaunchEntry,
  portLaunchEntryName
} from '../src/debugConfig';
import {
  configurationOverrides,
  memoryFileSystem,
  workspace as stubWorkspace,
  Uri
} from './helpers/vscodeStub';

// 端口模式动态写 launch.json(IDE-PDBG-002 死路修复)的落盘面:
// 保留既有配置 / 幂等 / 同组件旧端口回收 / 坏文件不盲写 / 并发串行不丢条目,
// 以及「Update launch.json 与动态写入不互相拆台」的生成面。
// 文件读写走 fake-vscode 内存 fs,路径语义真实。

type ManagerInternals = DebugConfigManager & {
  generateLaunchConfigurations(
    runningInstances?: ReadonlyArray<{ component: string; targetId: string; port: number }>
  ): any[];
};

interface MementoLike {
  get<T>(key: string, defaultValue?: T): T | undefined;
  update(key: string, value: unknown): Promise<void>;
  keys(): readonly string[];
  setKeysForSync(keys: readonly string[]): void;
}

/** 只认模式键的 memento 替身(生成面读的是记没记住端口模式) */
const seededMemento = (mode: string): MementoLike => ({
  get<T>(key: string, defaultValue?: T): T | undefined {
    return key === DEBUG_ATTACH_MODE_STATE_KEY ? (mode as T) : defaultValue;
  },
  update: async () => undefined,
  keys: () => [DEBUG_ATTACH_MODE_STATE_KEY],
  setKeysForSync: () => undefined
});

const makeManager = (workspaceState?: MementoLike): ManagerInternals =>
  new DebugConfigManager({
    subscriptions: [],
    ...(workspaceState ? { workspaceState } : {})
  } as unknown as vscode.ExtensionContext) as ManagerInternals;

const setWorkspaceAt = (fsPath: string | null): void => {
  stubWorkspace.workspaceFolders = fsPath
    ? [{ uri: Uri.file(fsPath), name: 'ws', index: 0 }]
    : [];
};

const flushAsync = () => new Promise<void>(resolve => setTimeout(resolve, 0));

const launchPath = (root: string): string => `${root}/.vscode/launch.json`;

const readLaunch = (root: string): any => {
  const bytes = memoryFileSystem.files.get(launchPath(root));
  if (bytes === undefined) {
    throw new Error(`launch.json 不在盘: ${launchPath(root)}`);
  }
  return JSON.parse(Buffer.from(bytes).toString('utf8'));
};

const rawLaunch = (root: string): string =>
  Buffer.from(memoryFileSystem.files.get(launchPath(root)) as Uint8Array).toString('utf8');

const entryNames = (root: string): string[] =>
  (readLaunch(root).configurations as Array<{ name?: string }>).map(item => item.name ?? '');

const writeLaunchAt = (root: string, content: unknown): void => {
  memoryFileSystem.set(launchPath(root), typeof content === 'string' ? content : JSON.stringify(content));
};

const writeDebugJsonAt = (root: string, components: Record<string, unknown>): void => {
  memoryFileSystem.set(
    `${root}/.kbengine/debug.json`,
    JSON.stringify({ debug: { components } })
  );
};

beforeEach(() => {
  memoryFileSystem.reset();
  setWorkspaceAt(null);
  configurationOverrides.delete('kbengine');
});

afterEach(() => {
  memoryFileSystem.reset();
  setWorkspaceAt(null);
  configurationOverrides.delete('kbengine');
});

describe('portLaunchEntryName / buildPortLaunchEntry(条目体单一真源)', () => {
  it('条目名带组件与端口;条目体是 attach 断点可用的三件套 + 路径映射', () => {
    setWorkspaceAt('/ws');
    expect(portLaunchEntryName('baseapp', 5678)).toBe(
      'KBEngine: Python attach to baseapp (debugpy 5678)'
    );

    const entry = buildPortLaunchEntry('baseapp', '127.0.0.1', 5678, undefined, 'debugpy');
    expect(entry).toEqual({
      name: 'KBEngine: Python attach to baseapp (debugpy 5678)',
      type: 'debugpy',
      request: 'attach',
      connect: { host: '127.0.0.1', port: 5678 },
      justMyCode: false,
      pathMappings: [{ localRoot: '/ws', remoteRoot: '/ws' }],
      presentation: { group: 'KBEngine', order: 3 },
      // KR-AUD-42:动态写入口与生成面同标记——updateLaunchJson 按标记清理
      // 才不会把动态写入的条目当用户条目留下同名重份
      [KBENGINE_LAUNCH_GENERATED_KEY]: true
    });
  });

  it('组件自带 pathMappings 时用组件的,不覆盖成工作区映射', () => {
    setWorkspaceAt('/ws');
    const entry = buildPortLaunchEntry(
      'cellapp',
      '127.0.0.1',
      5679,
      [{ localRoot: '/src', remoteRoot: '/mnt/src' }],
      'debugpy'
    );
    expect(entry.pathMappings).toEqual([{ localRoot: '/src', remoteRoot: '/mnt/src' }]);
  });
});

describe('mergePortLaunchEntry(幂等合并纯函数:保留既有配置)', () => {
  const userEntry = { name: '我的调试配置', type: 'node', request: 'launch' };

  it('无同名:追加在用户条目之后,用户条目原样', () => {
    const entry = buildPortLaunchEntry('baseapp', '127.0.0.1', 5678, undefined, 'debugpy');
    const merged = mergePortLaunchEntry([userEntry], entry);

    expect(merged.changed).toBe(true);
    expect(merged.configurations.map((item: any) => item.name)).toEqual([
      '我的调试配置',
      'KBEngine: Python attach to baseapp (debugpy 5678)'
    ]);
    expect(merged.configurations[0]).toBe(userEntry);
  });

  it('已有同名:只更托管字段(type/request/connect),手改字段与位置保留', () => {
    const existing = {
      name: 'KBEngine: Python attach to baseapp (debugpy 5678)',
      type: 'node', // 用户改过适配器类型:托管字段要拉回来
      request: 'launch',
      connect: { host: '127.0.0.1', port: 5678, someExtra: 'keep-me' },
      presentation: { group: '自定义组', order: 9 },
      justMyCode: true,
      console: 'integratedTerminal'
    };
    const entry = buildPortLaunchEntry('baseapp', '127.0.0.1', 5678, undefined, 'debugpy');

    const merged = mergePortLaunchEntry([userEntry, existing], entry);

    expect(merged.changed).toBe(true);
    expect(merged.configurations[0]).toBe(userEntry);
    const kept = merged.configurations[1] as any;
    expect(kept.type).toBe('debugpy');
    expect(kept.request).toBe('attach');
    expect(kept.connect).toEqual({ host: '127.0.0.1', port: 5678, someExtra: 'keep-me' });
    // 非托管字段一字不动
    expect(kept.presentation).toEqual({ group: '自定义组', order: 9 });
    expect(kept.justMyCode).toBe(true);
    expect(kept.console).toBe('integratedTerminal');
    // 位置不动:仍在用户条目之后的原位
    expect(merged.configurations.map((item: any) => item.name)).toEqual([
      '我的调试配置',
      'KBEngine: Python attach to baseapp (debugpy 5678)'
    ]);
  });

  it('已在位且字段一致:changed=false(重复调用零写入)', () => {
    const entry = buildPortLaunchEntry('baseapp', '127.0.0.1', 5678, undefined, 'debugpy');
    const first = mergePortLaunchEntry([userEntry], entry);
    const second = mergePortLaunchEntry(first.configurations, entry);

    expect(second.changed).toBe(false);
    expect(second.configurations).toBe(first.configurations);
  });

  it('configurations 缺失/非数组:按空表起算,不动用户对象本身', () => {
    const entry = buildPortLaunchEntry('baseapp', '127.0.0.1', 5678, undefined, 'debugpy');
    expect(mergePortLaunchEntry(undefined as unknown as unknown[], entry).configurations).toHaveLength(1);
    expect(mergePortLaunchEntry(null as unknown as unknown[], entry).changed).toBe(true);
  });
});

describe('dropSupersededPortEntries(同组件旧端口回收,不误伤)', () => {
  it('只回收同组件的旧端口生成条目;PID/命名实例/远程/用户条目原样', () => {
    const list = [
      { name: '我的调试配置', type: 'node' },
      { name: 'KBEngine: Python attach to baseapp', processId: '${command:pickProcess}' },
      { name: 'KBEngine: Python attach to baseapp (debugpy 5678)' },
      { name: 'KBEngine: Python attach to baseapp#a (debugpy 5700)' },
      { name: 'KBEngine: Python attach 外网 (remote)' },
      { name: 'KBEngine: Python attach to baseapp (debugpy 9999)' }
    ];

    const result = dropSupersededPortEntries(list, 'baseapp', 9999);

    expect(result.removed).toBe(1);
    // filter 保序:9999 条目仍在原来的末位,5678 那条消失
    expect(result.configurations.map((item: any) => item.name)).toEqual([
      '我的调试配置',
      'KBEngine: Python attach to baseapp',
      'KBEngine: Python attach to baseapp#a (debugpy 5700)',
      'KBEngine: Python attach 外网 (remote)',
      'KBEngine: Python attach to baseapp (debugpy 9999)'
    ]);
    // 5678 那条(旧口)被回收,9999(当前口)留着
    expect(result.configurations.some((item: any) => item.name?.endsWith('(debugpy 5678)'))).toBe(false);
  });

  it('端口没变:零回收', () => {
    const list = [{ name: 'KBEngine: Python attach to baseapp (debugpy 5678)' }];
    expect(dropSupersededPortEntries(list, 'baseapp', 5678)).toEqual({
      configurations: list,
      removed: 0
    });
  });

  it('不同组件同端口的条目不动(组件名前缀不误匹配)', () => {
    const list = [{ name: 'KBEngine: Python attach to baseapp2 (debugpy 5678)' }];
    expect(dropSupersededPortEntries(list, 'baseapp', 5690).removed).toBe(0);
  });
});

describe('ensurePortLaunchConfig(端口模式动态写落盘)', () => {
  it('launch.json 不在盘:落一条 connect 条目,用户其余键不臆造', async () => {
    setWorkspaceAt('/proj');
    const manager = makeManager();
    await flushAsync();

    const state = await manager.ensurePortLaunchConfig('baseapp', '127.0.0.1', 5678);

    expect(state.ok).toBe(true);
    expect(state.entryName).toBe('KBEngine: Python attach to baseapp (debugpy 5678)');
    const written = readLaunch('/proj');
    expect(written.version).toBe('0.2.0');
    expect(written.configurations).toHaveLength(1);
    expect(written.configurations[0]).toMatchObject({
      name: state.entryName,
      type: 'debugpy',
      request: 'attach',
      connect: { host: '127.0.0.1', port: 5678 }
    });
  });

  it('已有用户配置:version/inputs/用户条目逐字保留,新条目追加在后', async () => {
    setWorkspaceAt('/proj');
    writeLaunchAt('/proj', {
      version: '0.4.0',
      configurations: [{ name: 'My own config', type: 'node', request: 'launch' }],
      inputs: [{ id: 'userAsk', type: 'promptString', description: 'keep me' }]
    });
    const manager = makeManager();
    await flushAsync();

    await manager.ensurePortLaunchConfig('baseapp', '127.0.0.1', 5678);

    const written = readLaunch('/proj');
    expect(written.version).toBe('0.4.0');
    expect(written.inputs).toEqual([{ id: 'userAsk', type: 'promptString', description: 'keep me' }]);
    expect(written.configurations[0]).toEqual({ name: 'My own config', type: 'node', request: 'launch' });
    expect(written.configurations.map((item: any) => item.name)).toEqual([
      'My own config',
      'KBEngine: Python attach to baseapp (debugpy 5678)'
    ]);
  });

  it('幂等:连写两次仍只有一条,第二次 detail=已在位', async () => {
    setWorkspaceAt('/proj');
    const manager = makeManager();
    await flushAsync();

    const first = await manager.ensurePortLaunchConfig('baseapp', '127.0.0.1', 5678);
    const second = await manager.ensurePortLaunchConfig('baseapp', '127.0.0.1', 5678);

    expect(first.detail).toContain('已写入');
    expect(second.detail).toContain('已在位');
    const names = entryNames('/proj');
    expect(names).toEqual(['KBEngine: Python attach to baseapp (debugpy 5678)']);
  });

  it('端口变了:新口条目落位,同组件旧口条目回收;手写同名前缀条目不误删', async () => {
    setWorkspaceAt('/proj');
    writeLaunchAt('/proj', {
      version: '0.4.0',
      configurations: [
        { name: 'My own config', type: 'node' },
        { name: 'KBEngine: Python attach to baseapp (debugpy 5678)' },
        { name: 'KBEngine: Python attach to baseapp#a (debugpy 5700)' }
      ],
      inputs: []
    });
    const manager = makeManager();
    await flushAsync();

    const state = await manager.ensurePortLaunchConfig('baseapp', '127.0.0.1', 5690);

    expect(state.ok).toBe(true);
    expect(state.detail).toContain('回收 1 条');
    const written = readLaunch('/proj');
    expect(written.configurations.map((item: any) => item.name)).toEqual([
      'My own config',
      'KBEngine: Python attach to baseapp#a (debugpy 5700)',
      'KBEngine: Python attach to baseapp (debugpy 5690)'
    ]);
  });

  it('带注释(JSONC)的 launch.json:拒绝改写,原字节不动,如实回原因', async () => {
    setWorkspaceAt('/proj');
    const original = `{
  // 用户注释:这行不能丢
  "version": "0.4.0",
  "configurations": []
}`;
    writeLaunchAt('/proj', original);
    const manager = makeManager();
    await flushAsync();

    const state = await manager.ensurePortLaunchConfig('baseapp', '127.0.0.1', 5678);

    expect(state.ok).toBe(false);
    expect(state.detail).toContain('注释');
    expect(rawLaunch('/proj')).toBe(original);
  });

  it('坏 JSON:拒绝改写,原字节不动', async () => {
    setWorkspaceAt('/proj');
    const original = '{ "version": "0.4.0", "configurations": [ ';
    writeLaunchAt('/proj', original);
    const manager = makeManager();
    await flushAsync();

    const state = await manager.ensurePortLaunchConfig('baseapp', '127.0.0.1', 5678);

    expect(state.ok).toBe(false);
    expect(state.detail).toContain('无法按 JSON 解析');
    expect(rawLaunch('/proj')).toBe(original);
  });

  it('没有工作区:如实 ok=false,不写盘不抛', async () => {
    setWorkspaceAt(null);
    const manager = makeManager();
    await flushAsync();

    const state = await manager.ensurePortLaunchConfig('baseapp', '127.0.0.1', 5678);

    expect(state.ok).toBe(false);
    expect(state.detail).toContain('没有打开的工作区');
    expect(memoryFileSystem.files.size).toBe(0);
  });

  it('写盘抛错(只读盘):ok=false 带原始错误,不抛给调用方', async () => {
    setWorkspaceAt('/proj');
    const manager = makeManager();
    await flushAsync();
    const originalWrite = stubWorkspace.fs.writeFile;
    stubWorkspace.fs.writeFile = async () => {
      throw new Error('read-only fs');
    };

    try {
      const state = await manager.ensurePortLaunchConfig('baseapp', '127.0.0.1', 5678);
      expect(state.ok).toBe(false);
      expect(state.detail).toContain('read-only fs');
    } finally {
      stubWorkspace.fs.writeFile = originalWrite;
    }
  });
});

describe('并发(串行闸:读-改-写不互相覆盖)', () => {
  it('两个组件的 ensure 并发:两条都落盘,不丢彼此', async () => {
    setWorkspaceAt('/proj');
    const manager = makeManager();
    await flushAsync();

    const [baseapp, cellapp] = await Promise.all([
      manager.ensurePortLaunchConfig('baseapp', '127.0.0.1', 5678),
      manager.ensurePortLaunchConfig('cellapp', '127.0.0.1', 5679)
    ]);

    expect(baseapp.ok).toBe(true);
    expect(cellapp.ok).toBe(true);
    expect(entryNames('/proj').sort()).toEqual([
      'KBEngine: Python attach to baseapp (debugpy 5678)',
      'KBEngine: Python attach to cellapp (debugpy 5679)'
    ]);
  });

  it('updateLaunchJson 与 ensure 并发:用户条目/PID 条目/端口条目一个都不少,端口条目只一条', async () => {
    setWorkspaceAt('/proj');
    writeDebugJsonAt('/proj', { baseapp: { debugpyPort: 5678 } });
    writeLaunchAt('/proj', {
      version: '0.4.0',
      configurations: [{ name: 'My own config', type: 'node', request: 'launch' }],
      inputs: [{ id: 'userAsk', type: 'promptString', description: 'keep me' }]
    });
    const manager = makeManager();
    await flushAsync();

    const [updated, ensured] = await Promise.all([
      manager.updateLaunchJson(),
      manager.ensurePortLaunchConfig('baseapp', '127.0.0.1', 5678)
    ]);

    expect(updated).toBe(true);
    expect(ensured.ok).toBe(true);
    const written = readLaunch('/proj');
    const names = written.configurations.map((item: any) => item.name);
    // 用户条目与 inputs 原样
    expect(written.version).toBe('0.4.0');
    expect(names).toContain('My own config');
    expect(written.inputs).toEqual([{ id: 'userAsk', type: 'promptString', description: 'keep me' }]);
    // PID 附加形态照生成(debug.json 只声明了 baseapp,生成面按其清单走)
    expect(names).toContain('KBEngine: Python attach to baseapp');
    // 端口条目恰好一条(两个写口都没把它弄丢/弄重)
    expect(
      names.filter(
        (name: string) => name === 'KBEngine: Python attach to baseapp (debugpy 5678)'
      )
    ).toHaveLength(1);
    // 生成面与动态写入同名同体:不会出现第二条同组件端口条目
    expect(
      names.filter((name: string) =>
        String(name).startsWith('KBEngine: Python attach to baseapp (debugpy')
      )
    ).toHaveLength(1);
    // 三个来源各就其位:用户 1 + PID 1 + 端口 1
    expect(names).toHaveLength(3);
  });
});

describe('generateLaunchConfigurations 端口模式条目(生成面与动态写入合流)', () => {
  it('debug.json 显式 debugpyPort:无论 autoDebugpy 开关都给 connect 条目', async () => {
    setWorkspaceAt('/proj');
    writeDebugJsonAt('/proj', { baseapp: { debugpyPort: 5690, debugpyHost: '127.0.0.1' } });
    const manager = makeManager();
    await flushAsync();

    const configurations = manager.generateLaunchConfigurations();
    const portEntries = configurations.filter((item: any) => String(item.name).includes('(debugpy'));
    expect(portEntries.map((item: any) => item.name)).toEqual([
      'KBEngine: Python attach to baseapp (debugpy 5690)'
    ]);
    expect(portEntries[0].connect).toEqual({ host: '127.0.0.1', port: 5690 });
    expect(portEntries[0].type).toBe('debugpy');
    expect(portEntries[0].request).toBe('attach');
    // 与动态写入口同名同体(Update launch.json 重跑不会刷掉它)
    expect(portEntries[0].name).toBe(portLaunchEntryName('baseapp', 5690));
  });

  it('显式端口 + autoDebugpy 开:表条目不重复(同组件只一条端口条目)', async () => {
    configurationOverrides.set('kbengine', { 'debug.autoDebugpy': true });
    setWorkspaceAt('/proj');
    writeDebugJsonAt('/proj', { baseapp: { debugpyPort: 5690 } });
    const manager = makeManager();
    await flushAsync();

    const names = manager
      .generateLaunchConfigurations()
      .map((item: any) => item.name)
      .filter((name: string) => String(name).includes('(debugpy'));

    expect(names.filter((name: string) => name.startsWith('KBEngine: Python attach to baseapp '))).toEqual([
      'KBEngine: Python attach to baseapp (debugpy 5690)'
    ]);
    // 其余表组件照旧
    expect(names).toContain('KBEngine: Python attach to cellapp (debugpy 5679)');
    // 条目名不重复(重复会让 launch.json 出现两条同名配置)
    expect(new Set(names).size).toBe(names.length);
  });

  it('记住端口模式(未显式声明):每组件按分配表/缺省口各一条,autoDebugpy 开也不重', async () => {
    configurationOverrides.set('kbengine', { 'debug.autoDebugpy': true });
    setWorkspaceAt('/proj');
    const manager = makeManager(seededMemento('debugpy-port'));
    await flushAsync();

    const names = manager
      .generateLaunchConfigurations()
      .map((item: any) => item.name)
      .filter((name: string) => String(name).includes('(debugpy'));

    expect(names).toEqual([
      'KBEngine: Python attach to loginapp (debugpy 5680)',
      'KBEngine: Python attach to dbmgr (debugpy 5681)',
      'KBEngine: Python attach to interfaces (debugpy 5678)',
      'KBEngine: Python attach to logger (debugpy 5682)',
      'KBEngine: Python attach to baseapp (debugpy 5678)',
      'KBEngine: Python attach to cellapp (debugpy 5679)',
      'KBEngine: Python attach to bots (debugpy 5678)'
    ]);
    expect(new Set(names).size).toBe(names.length);
    // PID 条目同时保留(两种附加形态并存)
    const configurations = manager.generateLaunchConfigurations();
    expect(configurations.filter((item: any) => item.processId === '${command:pickProcess}')).toHaveLength(7);
  });

  it('没记住端口模式也没显式端口:零端口条目(默认关的 autoDebugpy 面不变)', async () => {
    setWorkspaceAt('/proj');
    const manager = makeManager();
    await flushAsync();

    const configurations = manager.generateLaunchConfigurations();
    expect(configurations.filter((item: any) => String(item.name).includes('(debugpy'))).toEqual([]);
    expect(configurations).toHaveLength(7);
  });
});
