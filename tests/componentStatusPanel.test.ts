import { describe, expect, it, vi } from 'vitest';
import { ThemeColor, ThemeIcon, TreeItemCollapsibleState } from './helpers/vscodeStub';
import {
  ComponentStatusTreeProvider,
  describeComponentRow,
  resolveThresholds
} from '../src/componentStatusPanel';
import type { KBEngineComponentInfo } from '../src/kbengineProtocol';

// KB-GC-001 组件状态面板:kbengine-explorer 容器新视图。数据源 = ConsoleHub
// 组件台账(machine 发现回包即含 cpu/mem/usedmem/state 负载快照,不另起链);
// 异常态(进程消失/负载超阈/state≠RUN)红色标记;刷新间隔可配。

let nextPid = 5000;
const makeComponent = (
  componentType: number,
  componentID: bigint,
  overrides: Partial<KBEngineComponentInfo> = {}
): KBEngineComponentInfo => {
  const names = ['unknown', 'dbmgr', 'loginapp', 'baseappmgr', 'cellappmgr', 'cellapp', 'baseapp', 'client', 'machine', 'console', 'logger', 'bots', 'watcher', 'interfaces', 'tool'];
  const componentName = names[componentType] ?? `component_${componentType}`;
  const groupOrderID = overrides.groupOrderID ?? 0;
  return {
    uid: 1001,
    username: 'cui',
    componentType,
    componentID,
    componentIDEx: 0n,
    globalOrderID: 1,
    groupOrderID,
    genuuidSections: 0,
    intaddr: '192.168.5.117',
    intport: 30000 + (nextPid % 1000),
    extaddr: '0.0.0.0',
    extport: 0,
    extaddrEx: '',
    pid: nextPid++,
    cpu: 1.5,
    mem: 42.5,
    usedmem: 1024,
    state: 1,
    machineID: 1,
    extradata: 0n,
    extradata1: 0n,
    extradata2: 0n,
    extradata3: 0n,
    backaddr: 0,
    backport: 0,
    componentName,
    fullName: componentType === 5 || componentType === 6 ? `${componentName}${groupOrderID}` : componentName,
    ...overrides
  } as KBEngineComponentInfo;
};

describe('resolveThresholds', () => {
  it('reads configured thresholds with documented defaults', () => {
    expect(resolveThresholds(() => undefined)).toEqual({ cpuPercent: 90, memMb: 1024 });
    expect(resolveThresholds(key => (key === 'cpu' ? 75 : 512))).toEqual({ cpuPercent: 75, memMb: 512 });
    // 非法值回落默认,不把 NaN 喂进面板
    expect(resolveThresholds(() => Number.NaN)).toEqual({ cpuPercent: 90, memMb: 1024 });
  });
});

describe('describeComponentRow', () => {
  it('normal rows carry identity/load/liveness and no abnormal flag', () => {
    const row = describeComponentRow(makeComponent(5, 901n, { groupOrderID: 1 }), {
      cpuPercent: 90,
      memMb: 1024
    });
    expect(row.abnormal).toBe(false);
    expect(row.reasons).toEqual([]);
    expect(row.label).toBe('cellapp1');
    expect(row.description).toContain('pid=');
    expect(row.description).toContain('192.168.5.117');
  });

  it('flags shutting-down state, and treats INIT(0) as normal (live-engine reality)', () => {
    const row = describeComponentRow(makeComponent(6, 700n, { state: 3 }), { cpuPercent: 90, memMb: 1024 });
    expect(row.abnormal).toBe(true);
    expect(row.reasons.join(';')).toContain('state');
    const init = describeComponentRow(makeComponent(8, 800n, { state: 0 }), { cpuPercent: 90, memMb: 1024 });
    expect(init.abnormal).toBe(false);
  });

  it('flags cpu and memory above thresholds (usedmem is bytes on the wire)', () => {
    const row = describeComponentRow(makeComponent(5, 902n, { cpu: 95.5, usedmem: 3 * 1024 * 1024 }), {
      cpuPercent: 90,
      memMb: 1
    });
    expect(row.abnormal).toBe(true);
    expect(row.reasons.join(';')).toContain('CPU');
    expect(row.reasons.join(';')).toContain('memory');
    expect(row.reasons.join(';')).toContain('3.0MB');
  });
});

const makeHub = (rounds: KBEngineComponentInfo[][], opts: { machinedState?: 'idle' | 'reachable' | 'unreachable' } = {}) => {
  let round = 0;
  const changeCallbacks: Array<() => void> = [];
  return {
    getComponents: () => rounds[Math.min(round, rounds.length - 1)],
    getMachinedState: () => opts.machinedState ?? 'reachable',
    pollOnce: vi.fn(async () => {
      round += 1;
      changeCallbacks.forEach(cb => cb());
    }),
    onDidChange: (cb: () => void) => {
      changeCallbacks.push(cb);
      return { dispose: () => undefined };
    }
  };
};

const itemOf = async (provider: ComponentStatusTreeProvider, index: number) => {
  const children = await provider.getChildren();
  return provider.getTreeItem(children[index]);
};

describe('ComponentStatusTreeProvider', () => {
  it('renders one red item per component with identity description', async () => {
    const hub = makeHub([
      [
        makeComponent(10, 900n),
        makeComponent(5, 901n, { groupOrderID: 1, cpu: 95, state: 3 })
      ]
    ]);
    const provider = new ComponentStatusTreeProvider(hub, () => ({ cpuPercent: 90, memMb: 1024 }));
    const normal = await itemOf(provider, 0);
    const abnormal = await itemOf(provider, 1);
    expect(normal.label).toBe('logger');
    expect(normal.contextValue).toBe('normal');
    expect(normal.collapsibleState).toBe(TreeItemCollapsibleState.None);
    expect(abnormal.label).toBe('cellapp1');
    expect(abnormal.contextValue).toBe('abnormal');
    expect((abnormal.iconPath as ThemeIcon).color?.id).toBe(new ThemeColor('errorForeground').id);
    expect(abnormal.description).toContain('state');
  });

  it('keeps a red tombstone row for a process that vanished from discovery', async () => {
    const hub = makeHub([
      [makeComponent(5, 901n, { groupOrderID: 1 })],
      []
    ]);
    const provider = new ComponentStatusTreeProvider(hub, () => ({ cpuPercent: 90, memMb: 1024 }));
    await provider.getChildren(); // round 1
    await hub.pollOnce(); // round 2:进程消失
    const item = await itemOf(provider, 0);
    expect(item.contextValue).toBe('abnormal');
    expect(String(item.label)).toContain('cellapp1');
    expect(item.description).toContain('vanished');
  });

  it('inserts a red machined-unreachable notice row and keeps the stale snapshot', async () => {
    const hub = makeHub([[makeComponent(10, 900n)]], { machinedState: 'unreachable' });
    const provider = new ComponentStatusTreeProvider(hub, () => ({ cpuPercent: 90, memMb: 1024 }));
    const children = await provider.getChildren();
    // 顶行 = machined 不可达说明(如实标注快照过期,不冒充实时;文案走 l10n 双语)
    expect(String(children[0].label)).toContain('machined');
    expect(children[0].abnormal).toBe(true);
    // 台账仍保留上一轮快照(不因不可达而清空),逐行渲染
    expect(children[1].label).toBe('logger');
    expect(children[1].description).toContain('pid');
  });

  it('manual refresh triggers a hub poll and fires the tree change event', async () => {
    const hub = makeHub([[makeComponent(10, 900n)]]);
    const provider = new ComponentStatusTreeProvider(hub, () => ({ cpuPercent: 90, memMb: 1024 }));
    let fired = 0;
    const sub = provider.onDidChangeTreeData(() => {
      fired += 1;
    });
    await provider.refresh();
    expect(hub.pollOnce).toHaveBeenCalledTimes(1);
    expect(fired).toBe(1);
    sub.dispose();
  });

  it('auto-refresh uses the configured interval via the injected timer surface', () => {
    const hub = makeHub([[makeComponent(10, 900n)]]);
    const provider = new ComponentStatusTreeProvider(hub, () => ({ cpuPercent: 90, memMb: 1024 }));
    const registered: Array<{ ms: number; fire: () => void }> = [];
    const stop = provider.startAutoRefresh((ms, fire) => {
      registered.push({ ms, fire });
      return () => undefined;
    });
    expect(registered).toHaveLength(1);
    expect(registered[0].ms).toBe(2000);
    stop();
    provider.dispose();
  });
});
