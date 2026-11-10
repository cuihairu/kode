import { describe, expect, it } from 'vitest';
import {
  defaultProbe,
  HOT_RELOAD_SWITCH_CHANNEL_COMMAND,
  HotReloadChannelQuickSwitch,
  runHotReloadChannelConfigCommand,
  type HotReloadChannelConfigCommandOptions,
  type HotReloadChannelConfigDeps,
  type HotReloadChannelConfigUi,
  type HotReloadChannelSwitchDeps,
  type HotReloadChannelSwitchUi
} from '../src/backend/hotReloadChannelConfig';
import type { ReloadChannelConfig } from '../src/backend/hotReloadTransport';
import type { ProjectProfile } from '../src/projectProfiles';

// hotReloadChannelConfig 缺口臂(2026-11-09 覆盖率扫尾)。
//
// 已覆盖臂:
// - defaultProbe:resolveReloadTransport 未配/字段缺失 → {ok:false}(75-77);
//   http 条目 + 无法解析 URL → 经真实 transport.probe() 失败速回(79-80,
//   URL 解析失败路径零 socket、零定时器,defaultTransport 在 URL 解析失败即
//   resolve)。
// - 高级配置收集取消/空值:官方 host 空串(166)、port 取消(174)、密码取消
//   (187);HTTP method 取消/空(219)、body 取消(227)。
// - 多 profile 选择取消(368)、预设一键探活通过后写盘失败(402-403)、
//   状态栏命令注册处理器实调(493 箭头)、stateKey 无激活 profile 返回 ''
//   (513)、切换写盘失败(602-605)。
//
// 死臂(证据):
// - 82(defaultProbe 的 catch):defaultProbe 只能经 resolveReloadTransport 建
//   HttpReloadTransport 或 KbengineOfficialTransport,两者 probe() 恒 resolve
//   ——http 的 substituteReloadVariables 是纯字符串替换、runner 调用包在
//   try/catch(361-370),官方通道 probe 的 waitForReady 恒返回布尔、try/finally
//   不抛;且 defaultProbe 无 deps 注入面,无法构造会 reject 的 probe。
//   该 catch 仅是防御性守卫,无运行时路径可达。

const profile = (id: string, displayName: string, hotReload?: ReloadChannelConfig): ProjectProfile => ({
  id,
  displayName,
  assetsRoot: '/ws/assets',
  engineRoot: '/ws/engine',
  interpreterPath: null,
  interpreterSource: 'missing',
  ...(hotReload ? { hotReload } : {})
});

// ---- 配置面板脚本化 UI(与 hotReloadChannelConfig.test.ts 同款) ----

type UiStep = (
  args: { items?: Array<{ label: string }>; prompt?: string; value?: string; message?: string }
) => Promise<unknown>;

const makeUi = (steps: UiStep[]): { ui: HotReloadChannelConfigUi; calls: { quickPick: number; inputBox: number } } => {
  const calls = { quickPick: 0, inputBox: 0 };
  const next = (where: string): UiStep => {
    const step = steps.shift();
    if (!step) {
      throw new Error(`ui script exhausted at ${where}`);
    }
    return step;
  };
  const ui: HotReloadChannelConfigUi = {
    showQuickPick: <T extends { label: string }>(items: T[]): Promise<T | undefined> => {
      calls.quickPick += 1;
      return next('quickPick')({ items }) as Promise<T | undefined>;
    },
    showInputBox: options => {
      calls.inputBox += 1;
      return next('inputBox')({ prompt: options.prompt, value: options.value }) as Promise<
        string | undefined
      >;
    },
    showInformationMessage: async () => undefined,
    showErrorMessage: async () => undefined
  };
  return { ui, calls };
};

const makeDeps = (
  overrides: Partial<HotReloadChannelConfigDeps> & { profiles?: ProjectProfile[] } = {}
): HotReloadChannelConfigDeps & { saved: Array<{ id: string; config: ReloadChannelConfig | undefined }> } => {
  const saved: Array<{ id: string; config: ReloadChannelConfig | undefined }> = [];
  return {
    saved,
    listProfiles: () => overrides.profiles ?? [profile('p1', '主线服')],
    saveHotReload: async (id, config) => {
      saved.push({ id, config });
      return profile(id, '主线服');
    },
    ui: overrides.ui ?? makeUi([]).ui,
    ...(overrides.probe ? { probe: overrides.probe } : {})
  };
};

const run = (
  deps: HotReloadChannelConfigDeps,
  options?: HotReloadChannelConfigCommandOptions
): Promise<boolean> => runHotReloadChannelConfigCommand(deps, options ?? {});

const pickChannel = (value: string): UiStep => async ({ items }) =>
  items!.find(item => (item as { value?: string }).value === value) ?? items![0];
const pickPreset = (value: string): UiStep => async ({ items }) =>
  items!.find(item => (item as { preset?: string }).preset === value) ?? items![0];
const input = (value: string | undefined): UiStep => async () => value;
const toAdvanced = (): UiStep => pickPreset('advanced');

describe('hotReloadChannelConfig 缺口臂:defaultProbe', () => {
  it('通道字段缺失/未配 → resolveReloadTransport 返回 null,ok:false 如实说明', async () => {
    expect(await defaultProbe({ channel: 'http' })).toEqual({
      ok: false,
      detail: '通道配置不完整,无法探测'
    });
    expect(await defaultProbe({ channel: 'kbengine-official' })).toEqual({
      ok: false,
      detail: '通道配置不完整,无法探测'
    });
    expect(await defaultProbe(undefined as unknown as ReloadChannelConfig)).toEqual({
      ok: false,
      detail: '通道配置不完整,无法探测'
    });
  });

  it('http 条目 + 无法解析 URL → 经 transport.probe() 失败速回(零 socket、零定时器)', async () => {
    const result = await defaultProbe({
      channel: 'http',
      http: {
        name: 'hot-reload',
        url: 'not-a-url::', // defaultTransport 对不可解析 URL 直接 resolve,不建连
        method: 'POST',
        headers: {},
        body: '',
        enabled: true,
        keybinding: ''
      }
    });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('HTTP 0');
  });
});

describe('hotReloadChannelConfig 缺口臂:高级配置收集取消/空值', () => {
  it('官方 host 空串 → 166 return,不落参数不写盘', async () => {
    const deps = makeDeps();
    const { ui, calls } = makeUi([toAdvanced(), pickChannel('kbengine-official'), input('')]);
    deps.ui = ui;
    expect(await run(deps)).toBe(false);
    expect(calls.inputBox).toBe(1);
    expect(deps.saved).toHaveLength(0);
  });

  it('官方 port 取消 → 174 return', async () => {
    const deps = makeDeps();
    const { ui } = makeUi([toAdvanced(), pickChannel('kbengine-official'), input('127.0.0.1'), input(undefined)]);
    deps.ui = ui;
    expect(await run(deps)).toBe(false);
    expect(deps.saved).toHaveLength(0);
  });

  it('官方密码取消 → 187 return', async () => {
    const deps = makeDeps();
    const { ui } = makeUi([
      toAdvanced(),
      pickChannel('kbengine-official'),
      input('127.0.0.1'),
      input('2560'),
      input(undefined)
    ]);
    deps.ui = ui;
    expect(await run(deps)).toBe(false);
    expect(deps.saved).toHaveLength(0);
  });

  it('HTTP method 取消 → 219 return', async () => {
    const deps = makeDeps();
    const { ui } = makeUi([toAdvanced(), pickChannel('http'), input('http://127.0.0.1:8000/reload'), input(undefined)]);
    deps.ui = ui;
    expect(await run(deps)).toBe(false);
    expect(deps.saved).toHaveLength(0);
  });

  it('HTTP body 取消 → 227 return', async () => {
    const deps = makeDeps();
    const { ui } = makeUi([
      toAdvanced(),
      pickChannel('http'),
      input('http://127.0.0.1:8000/reload'),
      input('POST'),
      input(undefined)
    ]);
    deps.ui = ui;
    expect(await run(deps)).toBe(false);
    expect(deps.saved).toHaveLength(0);
  });
});

describe('hotReloadChannelConfig 缺口臂:预设流与多 profile', () => {
  it('多 profile 选 profile 取消 → 368 return false', async () => {
    const deps = makeDeps({ profiles: [profile('p1', '主线服'), profile('p2', '压测服')] });
    const { ui } = makeUi([async () => undefined]);
    deps.ui = ui;
    expect(await run(deps)).toBe(false);
    expect(deps.saved).toHaveLength(0);
  });

  it('预设探活通过但写盘失败 → 402-403 报错返回 false', async () => {
    const deps = makeDeps();
    deps.probe = async () => ({ ok: true, detail: 'ok' });
    deps.saveHotReload = async () => null;
    const errors: string[] = [];
    const { ui } = makeUi([pickPreset('http-receiver')]);
    ui.showErrorMessage = async message => {
      errors.push(message);
      return undefined;
    };
    deps.ui = ui;
    expect(await run(deps)).toBe(false);
    expect(errors.join('')).toContain('保存失败:profile 不存在');
  });
});

// ---- 状态栏快捷开关替身(与 hotReloadChannelQuickSwitch.test.ts 同款) ----

interface FakeBar {
  text: string;
  command: string | { command: string } | undefined;
  tooltip: unknown;
  backgroundColor: { id: string } | undefined;
  shown: boolean;
  disposed: boolean;
  show(): void;
  hide(): void;
  dispose(): void;
}

const makeBar = (): FakeBar => ({
  text: '',
  command: undefined,
  tooltip: undefined,
  backgroundColor: undefined,
  shown: false,
  disposed: false,
  show() {
    this.shown = true;
  },
  hide() {
    this.shown = false;
  },
  dispose() {
    this.disposed = true;
    this.shown = false;
  }
});

interface SwitchHarness {
  deps: HotReloadChannelSwitchDeps;
  bar: FakeBar;
  active: { profile: ProjectProfile } | null;
  saved: Array<{ id: string; config: ReloadChannelConfig | undefined }>;
  infos: string[];
  errors: string[];
  picks: Array<string | undefined>;
  commands: Map<string, () => unknown>;
  probed: ReloadChannelConfig[];
}

const makeSwitchHarness = (active: { profile: ProjectProfile } | null): SwitchHarness => {
  const harness: SwitchHarness = {
    bar: makeBar(),
    active,
    saved: [],
    infos: [],
    errors: [],
    picks: [],
    commands: new Map(),
    probed: [],
    deps: undefined as unknown as HotReloadChannelSwitchDeps
  };
  const ui: HotReloadChannelSwitchUi = {
    showQuickPick: async <T extends { label: string }>(items: T[]): Promise<T | undefined> => {
      const want = harness.picks.shift();
      if (want === undefined) {
        return undefined;
      }
      return items.find(item => (item as { value?: string }).value === want);
    },
    showInformationMessage: async message => {
      harness.infos.push(message);
      return undefined;
    },
    showErrorMessage: async message => {
      harness.errors.push(message);
      return undefined;
    }
  };
  harness.deps = {
    getActiveProfile: () => harness.active,
    saveHotReload: async (id, config) => {
      harness.saved.push({ id, config });
      if (!harness.active || harness.active.profile.id !== id) {
        return null;
      }
      harness.active = {
        profile: config
          ? { ...harness.active.profile, hotReload: config }
          : (() => {
              const { hotReload: _drop, ...rest } = harness.active!.profile;
              return rest as ProjectProfile;
            })()
      };
      return harness.active.profile;
    },
    createStatusBarItem: () => harness.bar,
    registerCommand: (command, handler) => {
      harness.commands.set(command, handler as () => unknown);
      return { dispose: () => harness.commands.delete(command) };
    },
    probe: async config => {
      harness.probed.push(config);
      return { ok: true, detail: '端点可达(HTTP 200)' };
    },
    ui
  };
  return harness;
};

describe('hotReloadChannelConfig 缺口臂:状态栏开关', () => {
  it('注册命令处理器实调:状态栏点击即触发 run(493 箭头)', async () => {
    const harness = makeSwitchHarness({ profile: profile('p1', '主线服') });
    const controller = new HotReloadChannelQuickSwitch(harness.deps);
    harness.picks.push('unset');
    const handler = harness.commands.get(HOT_RELOAD_SWITCH_CHANNEL_COMMAND);
    expect(handler).toBeDefined();
    expect(await handler!()).toBe(true);
    expect(harness.saved).toEqual([{ id: 'p1', config: undefined }]);
    controller.dispose();
  });

  it('stateKey 无激活 profile → 返回空串(513),旧探活结论作废', async () => {
    const harness = makeSwitchHarness({ profile: profile('p1', '主线服') });
    const controller = new HotReloadChannelQuickSwitch(harness.deps);
    // 先成功切一次:绿标 note 建立(携带 stateKey)
    harness.picks.push('http');
    expect(await controller.run()).toBe(true);
    expect(String(harness.bar.tooltip)).toContain('探活通过');
    // 激活 profile 消失 → refresh 触发 stateKey(),line 513 空串分支
    harness.active = null;
    controller.refresh();
    expect(harness.bar.text).toBe('$(plug) 热更:默认(http)');
    expect(harness.bar.backgroundColor).toBeUndefined();
    expect(String(harness.bar.tooltip)).not.toContain('探活通过');
    controller.dispose();
  });

  it('切换写盘失败 → 602-605 note 清、refresh、错误提示返回 false', async () => {
    const harness = makeSwitchHarness({ profile: profile('p1', '主线服') });
    const controller = new HotReloadChannelQuickSwitch(harness.deps);
    harness.picks.push('http');
    // 写盘失败:saveHotReload 返回 null(profile 不存在)
    harness.deps.saveHotReload = async () => null;
    expect(await controller.run()).toBe(false);
    expect(harness.errors.join('')).toContain('保存失败:profile 不存在');
    expect(harness.bar.text).toBe('$(plug) 热更:默认(http)'); // note 已清,无红标
    expect(harness.bar.backgroundColor).toBeUndefined();
    controller.dispose();
  });
});
