/**
 * Core 健康灯(2026-11-24 用户令「server 死了我怎么去判断」):
 *  - 六态仲裁纯函数矩阵(off/bypassed/unresponsive/degraded/ok/idle 优先级);
 *  - 控制器假依赖面:渲染/探针自续/off 隐藏/面板动作(重启须用户选择)/dispose。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CORE_ERROR_BACKGROUND_COLOR_ID,
  CORE_HEALTH_PANEL_COMMAND,
  CORE_RELOAD_WINDOW_HINT,
  CoreHealthGateSnapshot,
  CoreHealthLightKind,
  CoreHealthStatusBarItemLike,
  KodeCoreHealthLightController,
  KodeCoreHealthLightDeps,
  coreHealthActionFromLabel,
  coreHealthActionLabel,
  coreHealthLightFaces,
  resolveCoreHealthLight,
  resolveCoreHealthPanelActions,
} from '../src/kodeCoreHealthLight';
import zhCnBundle from '../l10n/bundle.l10n.zh-cn.json';
import { setL10nBundle } from './fake-vscode/l10n';

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

  it('点击面板动作矩阵:重启只在有 Rust 进程时出,切轨按当前轨道排除自身', () => {
    expect(resolveCoreHealthPanelActions('rust', true, true)).toEqual(['restart', 'ts', 'shadow']);
    expect(resolveCoreHealthPanelActions('shadow', true, true)).toEqual(['restart', 'ts', 'rust']);
    // backend=ts 如实没有 Rust 进程可重启,只给切轨项
    expect(resolveCoreHealthPanelActions('ts', true, true)).toEqual(['rust', 'shadow']);
    expect(resolveCoreHealthPanelActions('ts', true, false)).toEqual([]);
    // 能力面缺失(接线层未注入对应 dep)→ 不出该项,不谎报能做的事
    expect(resolveCoreHealthPanelActions('rust', false, false)).toEqual([]);
    expect(resolveCoreHealthPanelActions('rust', false, true)).toEqual(['ts', 'shadow']);
  });

  it('六态脸面齐全(文案与高危底色标记)', () => {
    const kinds: CoreHealthLightKind[] = ['off', 'bypassed', 'unresponsive', 'degraded', 'ok', 'idle'];
    const faces = coreHealthLightFaces();
    for (const kind of kinds) {
      expect(faces[kind].text.length, `${kind} 有状态栏文案`).toBeGreaterThan(0);
      expect(faces[kind].tooltip.length, `${kind} 有 tooltip`).toBeGreaterThan(0);
    }
    expect(faces.unresponsive.errorBackground).toBe(true);
    expect(faces.bypassed.errorBackground).toBe(true);
    expect(faces.ok.errorBackground).toBeFalsy();
  });

  it('KODE-COREDISCOVER-001: reload guidance appears only on the bypassed face', () => {
    const faces = coreHealthLightFaces();
    expect(faces.bypassed.tooltip).toContain('Developer: Reload Window');
    expect(faces.bypassed.tooltip).toContain(CORE_RELOAD_WINDOW_HINT);
    expect(faces.ok.tooltip).not.toContain('Developer: Reload Window');
    expect(faces.off.tooltip).not.toContain('Developer: Reload Window');
  });

  it('脸面文案经 l10n 双态:英文系统=英文源串,中文系统=zh-cn 包译文', () => {
    try {
      expect(coreHealthLightFaces().ok.text).toBe('$(check) Core: ok');
      setL10nBundle(zhCnBundle);
      const faces = coreHealthLightFaces();
      expect(faces.ok.text).toBe('$(check) Core: 正常');
      expect(faces.bypassed.text).toBe('$(plug) Core: 降级(未接入)');
      expect(faces.bypassed.tooltip).toContain('实际回落 TS 轨道');
    } finally {
      setL10nBundle(null);
    }
  });

  it('点击面板动作文案双态:回查按当前语言取词,硬编中文常量在此红', () => {
    try {
      expect(coreHealthActionLabel('restart')).toBe('Restart core service');
      expect(coreHealthActionFromLabel('Switch to rust track')).toBe('rust');
      setL10nBundle(zhCnBundle);
      expect(coreHealthActionLabel('restart')).toBe('重启核心服务');
      expect(coreHealthActionFromLabel('重启核心服务')).toBe('restart');
      // 中文 locale 下英文源串必须判成未识别(回查按语言取词,禁字面量映射)
      expect(coreHealthActionFromLabel('Switch to rust track')).toBeUndefined();
    } finally {
      setL10nBundle(null);
    }
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
  switches: () => Array<'ts' | 'rust' | 'shadow'>;
  firePanel: () => void;
  order: string[];
}

const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

/** 装配假依赖控制器;snapshot 可后期改写以驱动不同仲裁分支 */
const makeHarness = (overrides?: {
  snapshot?: Partial<CoreHealthGateSnapshot>;
  rerediscover?: () => void;
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
  const backendSwitches: Array<'ts' | 'rust' | 'shadow'> = [];
  let panelHandler: (() => void) | null = null;
  const snapshot: CoreHealthGateSnapshot = { ...baseSnapshot(), ...overrides?.snapshot };
  const callOrder: string[] = [];
  const deps: KodeCoreHealthLightDeps = {
    createStatusBarItem: () => bar,
    registerCommand: (_command, handler) => {
      panelHandler = handler;
      return { dispose: () => undefined };
    },
    timers: timers.deps,
    snapshot: () => {
      callOrder.push('snapshot');
      return snapshot;
    },
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
    // 与生产接线同形:切轨动作写配置面(这里记账,接线层注 writeCoreBackendMode)
    setBackend: mode => {
      backendSwitches.push(mode);
    },
    rerediscover: overrides?.rerediscover
      ? () => {
          callOrder.push('rerediscover');
          overrides.rerediscover?.();
        }
      : undefined,
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
    switches: () => backendSwitches,
    firePanel: () => {
      callOrder.length = 0;
      panelHandler?.();
    },
    order: callOrder,
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
    expect(h.bar.text).toBe('$(check) Core: ok');
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
    expect(h.bar.text).toBe('$(error) Core: no response');
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
    h.firePanel();
    expect(h.messages()).toHaveLength(1);
    expect(h.messages()[0]).toContain('Core health: ok');
    expect(h.messages()[0]).toContain('5ms');
    // 动作是语义项,按当前语言渲染成文案:rust 轨道=重启 + 切 ts/shadow
    expect(h.pickPrompts()).toEqual([
      ['Restart core service', 'Switch to ts track', 'Switch to shadow track']
    ]);
    // 面板未决的选择先撤销,再驱动新面板(同一 resolver 槽位)
    h.resolvePicks(undefined);
    expect(h.restarts(), '取消选择不重启').toBe(0);
    h.firePanel();
    h.resolvePicks('Restart core service');
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
    expect(h.messages()[0]).toContain('Failure reason: server process exited (code 1)');
    expect(h.messages()[0]).toContain('31ms');
    h.resolvePicks(undefined);
    // 预算未决臂(reason 缺省)→ 疑似挂死措辞
    h.setProbeOutcome({ ok: false, latencyMs: 2000 });
    h.timers.fireAll();
    await tick();
    h.firePanel();
    expect(h.messages()[1]).toContain('Failure reason: probe inconclusive within budget (likely hung)');
    h.controller.dispose();
  });

  it('面板:熔断开放时详情注明新命令已瞬时回落(76 连超时波次不再误导为仍在等待)', async () => {
    const h = makeHarness({
      snapshot: { commandCircuit: { open: true, timeoutStreak: 76 } },
    });
    await tick();
    h.firePanel();
    expect(h.messages()[0]).toContain('76 consecutive timeouts');
    expect(h.messages()[0]).toContain('fall back to TS immediately');
    h.controller.dispose();
  });

  it('面板:backend=ts 不提供重启项,只给切轨项(如实没有 Rust 进程可重启)', async () => {
    const h = makeHarness({ snapshot: { backendMode: 'ts' } });
    await tick();
    h.firePanel();
    expect(h.messages()[0]).toContain('backend=ts (pure TS track)');
    expect(h.pickPrompts(), 'ts 轨道不提供重启动作').toEqual([
      ['Switch to rust track', 'Switch to shadow track']
    ]);
    h.resolvePicks('Switch to rust track');
    await tick();
    expect(h.switches(), '选中才切轨').toEqual(['rust']);
    h.controller.dispose();
  });

  it('KODE-COREDISCOVER-001: panel re-discovers before reading the snapshot; bypassed detail carries the reload hint', async () => {
    const rediscoveries: string[] = [];
    const h = makeHarness({
      snapshot: { backendMode: 'rust', serverPathPresent: false },
      rerediscover: () => {
        rediscoveries.push('rerediscover');
      },
    });
    await tick();
    expect(h.controller.kind).toBe('bypassed');
    h.order.length = 0;
    h.firePanel();
    expect(h.order[0]).toBe('rerediscover');
    expect(h.order.indexOf('rerediscover')).toBeLessThan(h.order.indexOf('snapshot'));
    expect(rediscoveries).toHaveLength(1);
    expect(h.messages()[0]).toContain(CORE_RELOAD_WINDOW_HINT);
    h.resolvePicks(undefined);
    h.controller.dispose();
  });

  it('KODE-COREDISCOVER-001: panel re-discovery runs before the first snapshot read', async () => {
    const h = makeHarness({ rerediscover: () => undefined });
    await tick();
    h.order.length = 0;
    h.firePanel();
    expect(h.order[0]).toBe('rerediscover');
    expect(h.order.indexOf('rerediscover')).toBeLessThan(h.order.indexOf('snapshot'));
    // ok face detail does not carry the bypassed-only guidance
    expect(h.messages()[0]).not.toContain(CORE_RELOAD_WINDOW_HINT);
    h.resolvePicks(undefined);
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
