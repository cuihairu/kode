/**
 * Core 健康灯(2026-11-24 用户令「server 死了我怎么去判断」):
 *  - 六态仲裁纯函数矩阵(off/bypassed/unresponsive/degraded/ok/idle 优先级);
 *  - 控制器假依赖面:渲染/探针自续/off 隐藏/面板动作(重启须用户选择)/dispose。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CORE_ERROR_BACKGROUND_COLOR_ID,
  CORE_HEALTH_LIGHT_FACES,
  CORE_HEALTH_PANEL_COMMAND,
  CoreHealthGateSnapshot,
  CoreHealthLightKind,
  CoreHealthStatusBarItemLike,
  KodeCoreHealthLightController,
  KodeCoreHealthLightDeps,
  resolveCoreHealthLight,
} from '../src/kodeCoreHealthLight';

const baseSnapshot = (): CoreHealthGateSnapshot => ({
  backendMode: 'rust',
  serverPathPresent: true,
  clientAlive: true,
  commandCircuit: { open: false, timeoutStreak: 0 },
});

describe('resolveCoreHealthLight 六态仲裁', () => {
  it('backend=ts → off(探针结果与熔断账都不翻案)', () => {
    expect(
      resolveCoreHealthLight({
        ...baseSnapshot(),
        backendMode: 'ts',
        commandCircuit: { open: true, timeoutStreak: 9 },
        probe: { ok: false, latencyMs: 5000 },
      })
    ).toBe('off');
  });

  it('rust/shadow 配置但 serverPath 落空 → bypassed(静默 TS 必须可见)', () => {
    expect(
      resolveCoreHealthLight({ ...baseSnapshot(), serverPathPresent: false, probe: { ok: true, latencyMs: 3 } })
    ).toBe('bypassed');
    expect(
      resolveCoreHealthLight({
        ...baseSnapshot(),
        backendMode: 'shadow',
        serverPathPresent: false,
        probe: null,
      })
    ).toBe('bypassed');
  });

  it('探针未返回 → idle(启动窗口)', () => {
    expect(resolveCoreHealthLight({ ...baseSnapshot(), probe: null })).toBe('idle');
  });

  it('探针失败 → unresponsive(熔断账干净也照报)', () => {
    expect(
      resolveCoreHealthLight({ ...baseSnapshot(), probe: { ok: false, latencyMs: 2000 } })
    ).toBe('unresponsive');
  });

  it('探针通过 + 命令腿熔断开放或 streak>0 → degraded', () => {
    expect(
      resolveCoreHealthLight({
        ...baseSnapshot(),
        commandCircuit: { open: true, timeoutStreak: 3 },
        probe: { ok: true, latencyMs: 4 },
      })
    ).toBe('degraded');
    expect(
      resolveCoreHealthLight({
        ...baseSnapshot(),
        commandCircuit: { open: false, timeoutStreak: 1 },
        probe: { ok: true, latencyMs: 4 },
      })
    ).toBe('degraded');
  });

  it('探针通过 + 命令腿干净 → ok', () => {
    expect(resolveCoreHealthLight({ ...baseSnapshot(), probe: { ok: true, latencyMs: 7 } })).toBe('ok');
  });

  it('六态脸面齐全(文案与高危底色标记)', () => {
    const kinds: CoreHealthLightKind[] = ['off', 'bypassed', 'unresponsive', 'degraded', 'ok', 'idle'];
    for (const kind of kinds) {
      const face = CORE_HEALTH_LIGHT_FACES[kind];
      expect(face.text.length, `${kind} 有状态栏文案`).toBeGreaterThan(0);
      expect(face.tooltip.length, `${kind} 有 tooltip`).toBeGreaterThan(0);
    }
    expect(CORE_HEALTH_LIGHT_FACES.unresponsive.errorBackground).toBe(true);
    expect(CORE_HEALTH_LIGHT_FACES.bypassed.errorBackground).toBe(true);
    expect(CORE_HEALTH_LIGHT_FACES.ok.errorBackground).toBeFalsy();
  });
});

/** 假状态栏项:记录 show/hide/dispose 调用序 */
const makeBar = (): CoreHealthStatusBarItemLike & { calls: string[] } => {
  const calls: string[] = [];
  return {
    text: '',
    command: undefined,
    tooltip: undefined,
    backgroundColor: undefined,
    show: () => void calls.push('show'),
    hide: () => void calls.push('hide'),
    dispose: () => void calls.push('dispose'),
    calls,
  };
};

/** 假定时器:手动泵(探针自续节奏确定化) */
const makeTimers = (): {
  deps: KodeCoreHealthLightDeps['timers'];
  fireAll: () => void;
  pending: () => number;
} => {
  const handles: Array<{ callback: () => void; cleared: boolean }> = [];
  return {
    deps: {
      set: (callback: () => void) => {
        const handle = { callback, cleared: false };
        handles.push(handle);
        return handle;
      },
      clear: handle => {
        (handle as { cleared: boolean }).cleared = true;
      },
    },
    fireAll: () => {
      for (const handle of [...handles]) {
        if (!handle.cleared) {
          handle.cleared = true;
          handle.callback();
        }
      }
    },
    pending: () => handles.filter(handle => !handle.cleared).length,
  };
};

interface Harness {
  controller: KodeCoreHealthLightController;
  bar: ReturnType<typeof makeBar>;
  timers: ReturnType<typeof makeTimers>;
  probeCalls: () => number;
  setProbeOutcome: (outcome: { ok: boolean; latencyMs: number; reason?: string } | 'throw') => void;
  messages: () => string[];
  pickPrompts: () => string[][];
  resolvePicks: (label: string | undefined) => void;
  restarts: () => number;
  firePanel: () => void;
}

const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

/** 装配假依赖控制器;snapshot 可后期改写以驱动不同仲裁分支 */
const makeHarness = (overrides?: {
  snapshot?: Partial<CoreHealthGateSnapshot>;
}): Harness => {
  const bar = makeBar();
  const timers = makeTimers();
  let probeOutcome: { ok: boolean; latencyMs: number; reason?: string } | 'throw' = {
    ok: true,
    latencyMs: 5,
  };
  let probeCount = 0;
  const messages: string[] = [];
  const pickPrompts: string[][] = [];
  let pickResolver: ((label: string | undefined) => void) | null = null;
  let restartCount = 0;
  let panelHandler: (() => void) | null = null;
  const snapshot: CoreHealthGateSnapshot = { ...baseSnapshot(), ...overrides?.snapshot };
  const deps: KodeCoreHealthLightDeps = {
    createStatusBarItem: () => bar,
    registerCommand: (_command, handler) => {
      panelHandler = handler;
      return { dispose: () => undefined };
    },
    timers: timers.deps,
    snapshot: () => snapshot,
    probe: async () => {
      probeCount += 1;
      if (probeOutcome === 'throw') {
        throw new Error('probe transport blew up');
      }
      return probeOutcome;
    },
    showMessage: text => void messages.push(text),
    pickAction: async labels => {
      pickPrompts.push([...labels]);
      return await new Promise<string | undefined>(resolve => {
        pickResolver = resolve as (label: string | undefined) => void;
      });
    },
    restartCore: () => {
      restartCount += 1;
    },
  };
  const controller = new KodeCoreHealthLightController(deps);
  return {
    controller,
    bar,
    timers,
    probeCalls: () => probeCount,
    setProbeOutcome: outcome => {
      probeOutcome = outcome;
    },
    messages: () => messages,
    pickPrompts: () => pickPrompts,
    resolvePicks: label => {
      pickResolver?.(label);
      pickResolver = null;
    },
    restarts: () => restartCount,
    firePanel: () => {
      panelHandler?.();
    },
  };
};

describe('KodeCoreHealthLightController 假依赖面', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('装配即首探:探针通过 → ok 脸上屏,command 绑定面板命令,排下一轮', async () => {
    const h = makeHarness();
    await tick();
    expect(h.probeCalls()).toBe(1);
    expect(h.controller.kind).toBe('ok');
    expect(h.bar.text).toBe('$(check) Core: 正常');
    expect(h.bar.command).toBe(CORE_HEALTH_PANEL_COMMAND);
    expect(h.bar.backgroundColor).toBeUndefined();
    expect(h.bar.calls).toContain('show');
    expect(h.timers.pending()).toBe(1);
    h.controller.dispose();
  });

  it('backend=ts → off 整灯隐藏(零噪音),探针仍按节奏走但不影响仲裁', async () => {
    const h = makeHarness({ snapshot: { backendMode: 'ts' } });
    await tick();
    expect(h.controller.kind).toBe('off');
    expect(h.bar.calls).toContain('hide');
    expect(h.bar.calls).not.toContain('show');
    h.controller.dispose();
  });

  it('探针转败:下一轮起 unresponsive + errorBackground 底色', async () => {
    const h = makeHarness();
    await tick();
    expect(h.controller.kind).toBe('ok');
    h.setProbeOutcome({ ok: false, latencyMs: 2000 });
    h.timers.fireAll();
    await tick();
    expect(h.controller.kind).toBe('unresponsive');
    expect(h.bar.text).toBe('$(error) Core: 无响应');
    expect(h.bar.backgroundColor?.id).toBe(CORE_ERROR_BACKGROUND_COLOR_ID);
    h.controller.dispose();
  });

  it('探针抛异常也如实 unresponsive(probe 永不炸控制器)', async () => {
    const h = makeHarness();
    await tick();
    h.setProbeOutcome('throw');
    h.timers.fireAll();
    await tick();
    expect(h.controller.kind).toBe('unresponsive');
    expect(h.timers.pending()).toBe(1);
    h.controller.dispose();
  });

  it('面板:点击出详情 + QuickPick 选「重启核心服务」才真重启', async () => {
    const h = makeHarness();
    await tick();
    h.resolvePicks(undefined);
    h.firePanel();
    expect(h.messages()).toHaveLength(1);
    expect(h.messages()[0]).toContain('正常');
    expect(h.messages()[0]).toContain('5ms');
    expect(h.pickPrompts()).toEqual([['重启核心服务']]);
    // 面板未决的选择先撤销,再驱动新面板(同一 resolver 槽位)
    h.resolvePicks(undefined);
    expect(h.restarts(), '取消选择不重启').toBe(0);
    h.firePanel();
    h.resolvePicks('重启核心服务');
    await tick();
    expect(h.restarts(), '选中才重启').toBe(1);
    h.controller.dispose();
  });

  it('面板:失败详情带原因词(快速失败臂=原错误词,预算未决臂=疑似挂死)', async () => {
    const h = makeHarness();
    await tick();
    h.setProbeOutcome({ ok: false, latencyMs: 31, reason: 'server process exited (code 1)' });
    h.timers.fireAll();
    await tick();
    h.firePanel();
    expect(h.messages()[0]).toContain('失败原因:server process exited (code 1)');
    expect(h.messages()[0]).toContain('31ms');
    h.resolvePicks(undefined);
    // 预算未决臂(reason 缺省)→ 疑似挂死措辞
    h.setProbeOutcome({ ok: false, latencyMs: 2000 });
    h.timers.fireAll();
    await tick();
    h.firePanel();
    expect(h.messages()[1]).toContain('失败原因:探针预算内未决(疑似挂死)');
    h.controller.dispose();
  });

  it('面板:熔断开放时详情注明新命令已瞬时回落(76 连超时波次不再误导为仍在等待)', async () => {
    const h = makeHarness({
      snapshot: { commandCircuit: { open: true, timeoutStreak: 76 } },
    });
    await tick();
    h.firePanel();
    expect(h.messages()[0]).toContain('连续超时 76 次');
    expect(h.messages()[0]).toContain('瞬时回落 TS');
    h.controller.dispose();
  });

  it('面板:backend=ts 不提供重启项(如实没有 Rust 进程可重启)', async () => {
    const h = makeHarness({ snapshot: { backendMode: 'ts' } });
    await tick();
    h.firePanel();
    expect(h.messages()[0]).toContain('ts(纯 TS 轨道)');
    expect(h.pickPrompts(), 'ts 轨道不提供重启动作').toHaveLength(0);
    h.controller.dispose();
  });

  it('dispose:撤定时器、撤命令、弃状态栏;之后不再探活', async () => {
    const h = makeHarness();
    await tick();
    expect(h.timers.pending()).toBe(1);
    h.controller.dispose();
    expect(h.bar.calls).toContain('dispose');
    expect(h.timers.pending()).toBe(0);
    const before = h.probeCalls();
    h.timers.fireAll();
    await tick();
    expect(h.probeCalls()).toBe(before);
  });
});
