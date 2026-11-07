import { describe, expect, it, vi } from 'vitest';
import { buildComponentInfo, type KBEngineComponentInfo } from '../src/kbengineProtocol';
import { ConsoleHub, type MachinedState } from '../src/kbengineConsoleHub';

// KB-GC-001 共享连接面:machined UDP 发现轮询 + 组件台账。tail(日志长连)与
// 组件状态面板共用这一个 hub,不建两套链。发现函数可注入(测试不发真广播);
// machined 不可达如实记账(unreachable + 错误文案),不硬试、不伪造组件表。

const makeComponent = (
  componentType: number,
  componentID: bigint,
  overrides: Partial<KBEngineComponentInfo> = {}
): KBEngineComponentInfo => {
  const base = {
    uid: 1001,
    username: 'cui',
    componentType,
    componentID,
    componentIDEx: 0n,
    globalOrderID: 1,
    groupOrderID: 0,
    genuuidSections: 0,
    intaddr: '192.168.5.117',
    intport: 20001,
    extaddr: '0.0.0.0',
    extport: 0,
    extaddrEx: '',
    pid: 1000 + componentType,
    cpu: 0.5,
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
    componentName: '',
    fullName: ''
  };
  const info = { ...base, ...overrides } as KBEngineComponentInfo;
  // componentName/fullName 语义与 parseComponentInfo 一致(测试手搓时补齐)
  const names = ['unknown', 'dbmgr', 'loginapp', 'baseappmgr', 'cellappmgr', 'cellapp', 'baseapp', 'client', 'machine', 'console', 'logger', 'bots', 'watcher', 'interfaces', 'tool'];
  info.componentName = names[componentType] ?? `component_${componentType}`;
  info.fullName = componentType === 5 || componentType === 6
    ? `${info.componentName}${info.groupOrderID}`
    : info.componentName;
  return info;
};

describe('ConsoleHub discovery rounds', () => {
  it('collects components from the injected discovery function', async () => {
    const logger = makeComponent(10, 900n, { intport: 30010 });
    const cellapp = makeComponent(5, 901n);
    const discover = vi.fn().mockResolvedValue([logger, cellapp]);
    const hub = new ConsoleHub({ pollIntervalMs: 1000, discoverFn: discover });

    await hub.pollOnce();

    expect(discover).toHaveBeenCalledTimes(1);
    expect(hub.getMachinedState()).toBe<MachinedState>('reachable');
    expect(hub.getComponents()).toHaveLength(2);
    expect(hub.getLogger()).toBeDefined();
    expect(hub.getLogger()!.componentID).toBe(900n);
    expect(hub.getLastError()).toBeNull();
  });

  it('reports machined unreachable honestly and keeps the previous table', async () => {
    vi.useFakeTimers();
    try {
      const logger = makeComponent(10, 900n);
      const discover = vi.fn()
        .mockResolvedValueOnce([logger])
        .mockRejectedValueOnce(new Error('UDP send timeout'));
      const hub = new ConsoleHub({ pollIntervalMs: 1000, discoverFn: discover });

      await hub.pollOnce();
      expect(hub.getMachinedState()).toBe('reachable');

      await vi.advanceTimersByTime(10);
      await hub.pollOnce();
      expect(hub.getMachinedState()).toBe('unreachable');
      expect(hub.getLastError()).toContain('machined');
      // 上一轮台账保留(供面板展示陈旧数据并标记),但不伪造「本轮可见」
      expect(hub.getComponents()).toHaveLength(1);
      expect(hub.getLastSucceededAtMs()).toBeLessThan(hub.getLastAttemptAtMs());
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports machined missing when discovery returns zero components', async () => {
    const discover = vi.fn().mockResolvedValue([]);
    const hub = new ConsoleHub({ pollIntervalMs: 1000, discoverFn: discover });
    await hub.pollOnce();
    expect(hub.getMachinedState()).toBe('unreachable');
    expect(hub.getLastError()).toContain('machined');
    expect(hub.getLogger()).toBeUndefined();
  });

  it('fires onDidChange after each completed round', async () => {
    const discover = vi.fn().mockResolvedValue([makeComponent(10, 900n)]);
    const hub = new ConsoleHub({ pollIntervalMs: 1000, discoverFn: discover });
    const seen: number[] = [];
    const sub = hub.onDidChange(() => seen.push(hub.getComponents().length));
    await hub.pollOnce();
    sub.dispose();
    expect(seen).toEqual([1]);
    hub.dispose();
  });

  it('replaces stale entries for restarted components (same type, new id/pid)', async () => {
    const discover = vi.fn()
      .mockResolvedValueOnce([makeComponent(5, 901n, { pid: 111 })])
      .mockResolvedValueOnce([makeComponent(5, 902n, { pid: 222 })]);
    const hub = new ConsoleHub({ pollIntervalMs: 1000, discoverFn: discover });
    await hub.pollOnce();
    await hub.pollOnce();
    const components = hub.getComponents();
    expect(components).toHaveLength(1);
    expect(components[0].componentID).toBe(902n);
    expect(components[0].pid).toBe(222);
  });
});

describe('ConsoleHub lifecycle', () => {
  it('start polls immediately then on the interval; stop halts', async () => {
    vi.useFakeTimers();
    try {
      const discover = vi.fn().mockResolvedValue([makeComponent(10, 900n)]);
      const hub = new ConsoleHub({ pollIntervalMs: 5000, discoverFn: discover });
      hub.start();
      // 轮询在后台异步;推进时钟前先让首轮落地
      await vi.advanceTimersByTimeAsync(0);
      expect(discover).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(5000);
      expect(discover).toHaveBeenCalledTimes(2);
      hub.stop();
      await vi.advanceTimersByTimeAsync(5000);
      expect(discover).toHaveBeenCalledTimes(2);
      hub.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('serializes overlapping rounds (a slow round is not double-fired)', async () => {
    let release: (() => void) | null = null;
    const discover = vi.fn().mockImplementation(() => new Promise<KBEngineComponentInfo[]>(resolve => {
      release = () => resolve([]);
    }));
    const hub = new ConsoleHub({ pollIntervalMs: 10, discoverFn: discover });
    const first = hub.pollOnce();
    const second = hub.pollOnce();
    release!();
    await Promise.all([first, second]);
    expect(discover).toHaveBeenCalledTimes(1);
    hub.dispose();
  });
});

describe('ConsoleHub component identity', () => {
  it('looks up by type+id and preserves wire-order info', async () => {
    const cellapp = makeComponent(5, 901n, { pid: 4321, cpu: 12.5, mem: 88.25, usedmem: 2048, state: 1 });
    const discover = vi.fn().mockResolvedValue([cellapp]);
    const hub = new ConsoleHub({ pollIntervalMs: 1000, discoverFn: discover });
    await hub.pollOnce();
    expect(hub.getComponent(5, 901n)).toMatchObject({ pid: 4321, cpu: 12.5 });
    expect(hub.getComponent(5, 999n)).toBeUndefined();
    expect(hub.getComponents()[0].intaddr).toBe('192.168.5.117');
  });

  it('accepts wire-built component info (buildComponentInfo parity)', async () => {
    const info = makeComponent(6, 700n, { groupOrderID: 0 });
    const wire = buildComponentInfo(info);
    // hub 只消费 parseComponentInfo 的产物;这里用 buildComponentInfo 反构的
    // 缓冲再经协议解析进来,保证台账字段与真实广播回包同源
    const { parseComponentInfo } = await import('../src/kbengineProtocol');
    const parsed = parseComponentInfo(wire);
    const discover = vi.fn().mockResolvedValue([parsed]);
    const hub = new ConsoleHub({ pollIntervalMs: 1000, discoverFn: discover });
    await hub.pollOnce();
    expect(hub.getComponents()[0].fullName).toBe('baseapp0');
  });
});
