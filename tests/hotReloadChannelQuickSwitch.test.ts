import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import {
  HOT_RELOAD_CHANNEL_STATUS_PRIORITY,
  HOT_RELOAD_SWITCH_CHANNEL_COMMAND,
  HotReloadChannelQuickSwitch
} from '../src/backend/hotReloadChannelConfig';
import type {
  HotReloadChannelSwitchDeps,
  HotReloadChannelSwitchUi
} from '../src/backend/hotReloadChannelConfig';
import type { ReloadChannelConfig } from '../src/backend/hotReloadTransport';
import type { ProjectProfile } from '../src/projectProfiles';

// 热更通道状态栏快捷开关(本批):状态栏项显示当前通道(如 `热更:自研HTTP`),
// 点击弹三选 QuickPick(自研接收器[推荐] / KBEngine 官方 / 未配置)即切,选中即
// 探活——绿=通(落 profile)、红=不通(不写 + 一键修=打开高级配置)。既有发送态灯
// (hotReloadStatus,优先级 98)不动,两灯各渲染各的,不抢位不抢色。

const profile = (id: string, hotReload?: ReloadChannelConfig): ProjectProfile => ({
  id,
  displayName: '主线服',
  assetsRoot: '/ws/assets',
  engineRoot: '/ws/engine',
  interpreterPath: null,
  interpreterSource: 'missing',
  ...(hotReload ? { hotReload } : {})
});

const HTTP_CONFIG: ReloadChannelConfig = {
  channel: 'http',
  http: {
    name: 'hot-reload',
    url: 'http://127.0.0.1:8090/hotfix',
    method: 'POST',
    headers: {},
    body: '{"files":${files}}',
    enabled: true,
    keybinding: ''
  }
};

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

/** 三选条目(实现面带 value:自研/官方/未配置) */
interface PickItem {
  readonly label: string;
  readonly value?: string;
}

interface Harness {
  deps: HotReloadChannelSwitchDeps;
  bar: FakeBar;
  active: { profile: ProjectProfile } | null;
  saved: Array<{ id: string; config: ReloadChannelConfig | undefined }>;
  probed: ReloadChannelConfig[];
  /** 脚本化三选应答:value=选哪项,undefined=取消 */
  picks: Array<string | undefined>;
  /** 脚本化错误按钮应答:undefined=不点 */
  errorReplies: Array<string | undefined>;
  lastPicks: PickItem[];
  quickPickTitles: string[];
  infos: string[];
  errors: Array<{ message: string; actions?: readonly string[] }>;
  advancedCalls: number;
  advancedProfileIds: string[];
  advancedResult: boolean;
  /** 一键修(高级配置)跑完后模拟读回的激活 profile */
  advancedProfile: { profile: ProjectProfile } | null;
  /** 三选弹出等待期间把激活 profile 换成它(模拟选择器开着时被切换) */
  switchProfileDuringPick: { profile: ProjectProfile } | null;
  /** 写盘挂起钩子:saveHotReload 落盘后、返回前 await 它(模拟返回前的并发窗口) */
  saveHook?: () => Promise<void>;
  /** 零 profile 兜底钩子(用户令 2026-11-10「创建默认的」):设置即注入 ensure 依赖 */
  ensureHook?: () => Promise<ProjectProfile | null>;
  /** profile 注册表(按 id 写盘的事实源;active 只是「当前显示哪条」) */
  registry: ProjectProfile[];
  commands: Map<string, () => unknown>;
}

const makeHarness = (active: { profile: ProjectProfile } | null, bar: FakeBar): Harness => {
  const harness: Harness = {
    bar,
    active,
    saved: [],
    probed: [],
    picks: [],
    errorReplies: [],
    lastPicks: [],
    quickPickTitles: [],
    infos: [],
    errors: [],
    advancedCalls: 0,
    advancedProfileIds: [],
    advancedResult: true,
    advancedProfile: null,
    switchProfileDuringPick: null,
    registry: active ? [active.profile] : [],
    commands: new Map(),
    deps: undefined as unknown as HotReloadChannelSwitchDeps
  };
  const ui: HotReloadChannelSwitchUi = {
    showQuickPick: async <T extends { label: string }>(items: T[], options: { title: string }) => {
      harness.quickPickTitles.push(options.title);
      harness.lastPicks = items as PickItem[];
      const want = harness.picks.shift();
      // 选择器等待期间可被切 profile(真 UI 就是用户开着面板时切了活动 profile)
      if (harness.switchProfileDuringPick) {
        harness.active = harness.switchProfileDuringPick;
        harness.switchProfileDuringPick = null;
      }
      if (want === undefined) {
        return undefined;
      }
      return items.find(item => (item as { value?: string }).value === want);
    },
    showInformationMessage: async message => {
      harness.infos.push(message);
      return undefined;
    },
    showErrorMessage: async (message, actions) => {
      harness.errors.push({ message, ...(actions !== undefined ? { actions } : {}) });
      return harness.errorReplies.shift();
    }
  };
  harness.deps = {
    getActiveProfile: () => harness.active,
    saveHotReload: async (id, config) => {
      harness.saved.push({ id, config });
      const index = harness.registry.findIndex(entry => entry.id === id);
      if (index < 0) {
        return null;
      }
      const updated = config
        ? { ...harness.registry[index], hotReload: config }
        : withoutHotReload(harness.registry[index]);
      harness.registry[index] = updated;
      if (harness.active?.profile.id === id) {
        harness.active = { profile: updated };
      }
      // 写盘已落、返回前的窗口:调用方仍可能切 profile/改配置(慢写盘/并发写方)
      if (harness.saveHook) {
        await harness.saveHook();
      }
      return updated;
    },
    probe: async config => {
      harness.probed.push(config);
      return { ok: true, detail: '端点可达(HTTP 200)' };
    },
    createStatusBarItem: () => harness.bar,
    registerCommand: (command, handler) => {
      harness.commands.set(command, handler as () => unknown);
      return { dispose: () => harness.commands.delete(command) };
    },
    runAdvancedConfig: async profileId => {
      harness.advancedCalls += 1;
      harness.advancedProfileIds.push(profileId);
      if (harness.advancedProfile) {
        harness.active = harness.advancedProfile;
      }
      return harness.advancedResult;
    },
    ui,
    // 零 profile 兜底:调用期读钩子(测试在 build() 之后才脚本化 ensureHook)
    ensureDefaultProfile: () => (harness.ensureHook ? harness.ensureHook() : Promise.resolve(null))
  };
  return harness;
};

const withoutHotReload = (input: ProjectProfile): ProjectProfile => {
  const { hotReload: _dropped, ...rest } = input;
  return rest as ProjectProfile;
};

const build = (active: { profile: ProjectProfile } | null): {
  harness: Harness;
  bar: FakeBar;
  controller: HotReloadChannelQuickSwitch;
} => {
  const bar = makeBar();
  const harness = makeHarness(active, bar);
  const controller = new HotReloadChannelQuickSwitch(harness.deps);
  return { harness, bar, controller };
};

const HTTP_ACTIVE = { profile: profile('p1', HTTP_CONFIG) };

describe('热更通道状态栏快捷开关', () => {
  it('初始渲染:状态栏显示当前通道(自研HTTP)+ 点击命令即切换入口', () => {
    const { harness, bar } = build(HTTP_ACTIVE);
    expect(bar.text).toBe('$(plug) 热更:自研HTTP');
    expect(bar.command).toBe(HOT_RELOAD_SWITCH_CHANNEL_COMMAND);
    expect(bar.shown).toBe(true);
    expect(bar.backgroundColor).toBeUndefined();
    expect(harness.commands.has(HOT_RELOAD_SWITCH_CHANNEL_COMMAND)).toBe(true);
    // 既有发送态灯(hotReloadStatus)优先级 98 不被占用:两灯不撞位
    expect(HOT_RELOAD_CHANNEL_STATUS_PRIORITY).not.toBe(98);
  });

  it('未配通道的 profile → 状态栏显示默认(http)(用户令 2026-11-10:默认部署通道即 http)', () => {
    const { bar } = build({ profile: profile('p1') });
    expect(bar.text).toBe('$(plug) 热更:默认(http)');
  });

  it('三选 QuickPick:自研接收器[推荐] / KBEngine 官方(依赖引擎 reloadScript) / 未配置,当前项标记', async () => {
    const { harness, controller } = build(HTTP_ACTIVE);
    harness.picks.push(undefined); // 看首屏后取消
    expect(await controller.run()).toBe(false);
    expect(harness.quickPickTitles).toHaveLength(1);
    expect(harness.quickPickTitles[0]).toContain('三选');
    const labels = harness.lastPicks.map(item => item.label);
    expect(labels).toHaveLength(3);
    const joined = labels.join('\n');
    expect(joined).toContain('自研接收器');
    expect(joined).toContain('依赖引擎 reloadScript');
    expect(joined).toContain('未配置');
    expect(joined).toContain('(当前)');
    expect(joined).not.toContain('第三方');
    expect(harness.saved).toHaveLength(0);
  });

  it('选未配置 → 写 profile 清空通道,状态栏转未配置 + 信息提示(不探活)', async () => {
    const { harness, controller } = build(HTTP_ACTIVE);
    harness.picks.push('unset');
    expect(await controller.run()).toBe(true);
    expect(harness.saved).toEqual([{ id: 'p1', config: undefined }]);
    expect(harness.infos.join('')).toContain('已清除');
    expect(harness.probed).toHaveLength(0);
    expect(harness.bar.text).toBe('$(plug) 热更:默认(http)');
  });

  it('选自研接收器 → 默认参数探活通过 → 落 profile,状态栏保持自研 + 提示探活通过', async () => {
    const { harness, controller } = build({ profile: profile('p1') });
    harness.picks.push('http');
    expect(await controller.run()).toBe(true);
    expect(harness.probed).toEqual([HTTP_CONFIG]);
    expect(harness.saved).toEqual([{ id: 'p1', config: HTTP_CONFIG }]);
    expect(harness.infos.join('')).toContain('自研接收器');
    expect(harness.infos.join('')).toContain('探活通过');
    expect(harness.bar.text).toBe('$(plug) 热更:自研HTTP');
    expect(harness.bar.backgroundColor).toBeUndefined();
  });

  it('选 KBEngine 官方 → 默认控制台参数探活通过 → 落 profile,状态栏转 KBEngine官方', async () => {
    const { harness, controller } = build({ profile: profile('p1') });
    harness.picks.push('kbengine-official');
    expect(await controller.run()).toBe(true);
    expect(harness.probed).toEqual([
      { channel: 'kbengine-official', official: { host: '127.0.0.1', port: 40000, password: 'pwd123456', fullReload: true } }
    ]);
    expect(harness.saved[0].config?.channel).toBe('kbengine-official');
    expect(harness.bar.text).toBe('$(plug) 热更:KBEngine官方');
  });

  it('探活不通 → 不写 profile,状态栏转红($(error)+红底),错误提示带一键修按钮', async () => {
    const { harness, controller } = build({ profile: profile('p1') });
    harness.deps.probe = async () => ({ ok: false, detail: '端点不可达(ECONNREFUSED)' });
    harness.picks.push('http');
    expect(await controller.run()).toBe(false);
    expect(harness.saved).toHaveLength(0);
    expect(harness.errors).toHaveLength(1);
    expect(harness.errors[0].message).toContain('探活不通');
    expect(harness.errors[0].actions).toContain('打开高级配置修参数');
    // 状态栏文字只显示**当前**通道(本次没落盘,仍是我配置),红标 + tooltip 点名试的通道
    expect(harness.bar.text).toBe('$(error) 热更:默认(http)');
    expect(harness.bar.backgroundColor?.id).toBe('statusBarItem.errorBackground');
    expect(String(harness.bar.tooltip)).toContain('ECONNREFUSED');
    expect(String(harness.bar.tooltip)).toContain('自研接收器');
  });

  it('探活不通 → 一键修(打开高级配置)→ 高级配置写盘后状态栏跟住刷新(红标清掉)', async () => {
    const { harness, controller } = build({ profile: profile('p1') });
    harness.deps.probe = async () => ({ ok: false, detail: '端点不可达' });
    harness.picks.push('http');
    harness.errorReplies.push('打开高级配置修参数');
    harness.advancedProfile = {
      profile: profile('p1', { ...HTTP_CONFIG, http: { ...HTTP_CONFIG.http!, url: 'http://127.0.0.1:9001/reload' } })
    };
    expect(await controller.run()).toBe(false);
    expect(harness.advancedCalls).toBe(1);
    // 一键修带 profile id 直达该 profile 的高级配置(不再从首屏重走)
    expect(harness.advancedProfileIds).toEqual(['p1']);
    expect(harness.bar.text).toBe('$(plug) 热更:自研HTTP');
    expect(harness.bar.backgroundColor).toBeUndefined();
  });

  it('无激活 profile → 错误提示,不弹三选也不写盘', async () => {
    const { harness, controller } = build(null);
    expect(await controller.run()).toBe(false);
    expect(harness.quickPickTitles).toHaveLength(0);
    expect(harness.saved).toHaveLength(0);
    expect(harness.errors).toHaveLength(1);
    expect(harness.errors[0].message).toContain('无激活');
  });

  it('无激活 profile + 默认档兜底(ensure 建档激活)→ 不报错直接进三选(用户令 2026-11-10)', async () => {
    const { harness, controller } = build(null);
    // 兜底:自动创建 default 档并激活(真装配 = ensureDefaultDeploymentProfile)
    harness.ensureHook = async () => {
      const created = profile('pd');
      harness.registry.push(created);
      harness.active = { profile: created };
      return created;
    };
    // 三选弹出后取消:run 返回 false,但走的是「有 profile 的正常流」
    expect(await controller.run()).toBe(false);
    expect(harness.errors).toHaveLength(0);
    expect(harness.quickPickTitles).toHaveLength(1);
    expect(harness.quickPickTitles[0]).toContain('主线服');
    expect(harness.saved).toHaveLength(0);
  });

  it('兜底返回 null(已有档/未注入同路)→ 维持旧错误,不弹三选', async () => {
    const { harness, controller } = build(null);
    harness.ensureHook = async () => null;
    expect(await controller.run()).toBe(false);
    expect(harness.errors).toHaveLength(1);
    expect(harness.errors[0].message).toContain('无激活');
    expect(harness.quickPickTitles).toHaveLength(0);
  });

  it('已配官方通道、试自研探活不通 → 状态栏仍显示当前通道(官方),红标 + tooltip 点名自研', async () => {
    const official: ReloadChannelConfig = {
      channel: 'kbengine-official',
      official: { host: '127.0.0.1', port: 2560, fullReload: true }
    };
    const { harness, controller } = build({ profile: profile('p1', official) });
    harness.deps.probe = async () => ({ ok: false, detail: 'ECONNREFUSED 127.0.0.1:8000' });
    harness.picks.push('http');
    expect(await controller.run()).toBe(false);
    expect(harness.saved).toHaveLength(0);
    // 未落盘的通道绝不冒充当前状态:文字还是当前(官方),红标/tooltip 才说自研不通
    expect(harness.bar.text).toBe('$(error) 热更:KBEngine官方');
    expect(harness.bar.backgroundColor?.id).toBe('statusBarItem.errorBackground');
    expect(String(harness.bar.tooltip)).toContain('自研接收器');
  });

  it('探活期间 profile 被切换 → 本次结果作废(不写盘、不落红标)', async () => {
    const { harness, controller } = build({ profile: profile('p1') });
    harness.deps.probe = async () => {
      harness.active = { profile: profile('p2') }; // 探活等待中切了 profile
      return { ok: false, detail: '端点不可达' };
    };
    harness.picks.push('http');
    expect(await controller.run()).toBe(false);
    expect(harness.saved).toHaveLength(0);
    expect(harness.infos.join('')).toContain('作废');
    expect(harness.bar.backgroundColor).toBeUndefined();
    expect(harness.errors).toHaveLength(0);
  });

  it('三选等待期间 profile 被切换 → 本次切换作废(不写盘、不落红标),灯跟到新 profile', async () => {
    const { harness, controller } = build({ profile: profile('p1') });
    harness.picks.push('http');
    // 切到**有通道**的 p2:灯文字若真刷新必须从「未配置」翻到 p2 的通道(否则本断言不成立)
    harness.switchProfileDuringPick = { profile: profile('p2', HTTP_CONFIG) };
    expect(await controller.run()).toBe(false);
    expect(harness.saved).toHaveLength(0);
    expect(harness.probed).toHaveLength(0); // 身份已变,连探活都不该发起
    expect(harness.infos.join('')).toContain('作废');
    expect(harness.errors).toHaveLength(0);
    expect(harness.bar.backgroundColor).toBeUndefined();
    // 作废后跟住新 profile 重读
    expect(harness.bar.text).toBe('$(plug) 热更:自研HTTP');
  });

  it('红标不跨 profile 残留:切到另一 profile 后 refresh 即清', async () => {
    const { harness, controller } = build({ profile: profile('p1') });
    harness.deps.probe = async () => ({ ok: false, detail: '端点不可达' });
    harness.picks.push('http');
    expect(await controller.run()).toBe(false);
    expect(harness.bar.backgroundColor?.id).toBe('statusBarItem.errorBackground');
    harness.active = { profile: profile('p2') };
    controller.refresh();
    expect(harness.bar.backgroundColor).toBeUndefined();
    expect(harness.bar.text).toBe('$(plug) 热更:默认(http)');
  });

  it('红标不跨同 profile 的通道参数变更残留:配置身份一变 refresh 即清', async () => {
    const official: ReloadChannelConfig = {
      channel: 'kbengine-official',
      official: { host: '127.0.0.1', port: 2560, fullReload: true }
    };
    const { harness, controller } = build({ profile: profile('p1', official) });
    harness.deps.probe = async () => ({ ok: false, detail: '端点不可达' });
    harness.picks.push('http');
    expect(await controller.run()).toBe(false);
    expect(harness.bar.backgroundColor?.id).toBe('statusBarItem.errorBackground');
    // 高级配置把同通道参数改了(端口 2560 → 2561):旧探活结论作废
    harness.active = {
      profile: profile('p1', {
        channel: 'kbengine-official',
        official: { host: '127.0.0.1', port: 2561, fullReload: true }
      })
    };
    controller.refresh();
    expect(harness.bar.backgroundColor).toBeUndefined();
  });

  it('写盘返回前切到同通道的另一 profile → p1 已保存、灯显 p2、绿标不冒领 p1 的探活详情', async () => {
    const { harness, controller } = build({ profile: profile('p1') });
    let release: () => void = () => undefined;
    let markStarted: () => void = () => undefined;
    const started = new Promise<void>(resolve => {
      markStarted = resolve;
    });
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    harness.saveHook = async () => {
      markStarted();
      await gate;
    };
    harness.deps.probe = async () => ({ ok: true, detail: 'HTTP 200 (p1 probe)' });
    harness.picks.push('http');
    const pending = controller.run();
    await started;
    // 写盘返回前活动 profile 已切到**同通道**的 p2(最像误归属的场景)
    harness.active = { profile: profile('p2', HTTP_CONFIG) };
    release();
    expect(await pending).toBe(true);
    expect(harness.saved).toHaveLength(1);
    expect(harness.saved[0].id).toBe('p1'); // p1 的写盘确实成功(不谎称不写)
    expect(harness.bar.text).toBe('$(plug) 热更:自研HTTP'); // 灯已跟到 p2
    // 绿标不得把 p1 的探活结果记到 p2 头上
    expect(String(harness.bar.tooltip)).not.toContain('HTTP 200 (p1 probe)');
    expect(String(harness.bar.tooltip)).not.toContain('探活通过');
  });

  it('写盘返回前同 profile 同通道参数被改 → 绿标不立(配置身份对不上,不冒领)', async () => {
    const { harness, controller } = build({ profile: profile('p1') });
    let release: () => void = () => undefined;
    let markStarted: () => void = () => undefined;
    const started = new Promise<void>(resolve => {
      markStarted = resolve;
    });
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    harness.saveHook = async () => {
      markStarted();
      await gate;
    };
    harness.deps.probe = async () => ({ ok: true, detail: 'HTTP 200 (url A)' });
    harness.picks.push('http');
    const pending = controller.run();
    await started;
    // 同 profile、同通道,但参数已是另一个 url(并发写方落了别的配置)
    harness.active = {
      profile: {
        ...harness.active!.profile,
        hotReload: {
          channel: 'http',
          http: { ...HTTP_CONFIG.http!, url: 'http://127.0.0.1:9100/reload' }
        }
      }
    };
    release();
    expect(await pending).toBe(true);
    expect(harness.saved[0].id).toBe('p1');
    expect(String(harness.bar.tooltip)).not.toContain('探活通过');
  });

  it('refresh:profile 换通道后状态栏跟住刷新;dispose 拆干净', () => {
    const { harness, bar, controller } = build(HTTP_ACTIVE);
    harness.active = { profile: profile('p1') };
    controller.refresh();
    expect(bar.text).toBe('$(plug) 热更:默认(http)');
    controller.dispose();
    expect(bar.disposed).toBe(true);
    expect(harness.commands.size).toBe(0);
  });
});

describe('热更快捷键与命令声明(package.json)', () => {
  interface Pkg {
    activationEvents: string[];
    contributes: {
      commands: Array<{ command: string }>;
      keybindings: Array<{ command: string; key?: string; mac?: string; when?: string }>;
    };
  }
  const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as Pkg;

  it('configureChannel 注册默认键位 ctrl+alt+r 且无收窄 when(编辑器/工作区都可用)', () => {
    const binding = pkg.contributes.keybindings.find(
      entry => entry.command === 'kbengine.hotReload.configureChannel'
    );
    expect(binding, 'contributes.keybindings 缺 configureChannel 默认键位').toBeDefined();
    // 避让依据:ctrl+alt+h 已是配置指南里 kbengine.httpRequest.run 的既有示例
    // 键位,ctrl+]/ctrl+d 是 telnet 面板键位——默认键位改用 ctrl+alt+r
    expect(binding!.key).toBe('ctrl+alt+r');
    expect(binding!.when).toBeUndefined();
  });

  it('默认键位不落在仓库既有/文档既占键位上(避撞锁)', () => {
    const binding = pkg.contributes.keybindings.find(
      entry => entry.command === 'kbengine.hotReload.configureChannel'
    )!;
    // 文档示例键位(配置指南 kbengine.httpRequest.run)与 telnet 面板键位
    expect(['ctrl+alt+h', 'ctrl+]', 'ctrl+d']).not.toContain(binding.key);
    expect(['cmd+alt+h', 'ctrl+]', 'ctrl+d']).not.toContain(binding.mac);
  });

  it('键位不与本扩展既有键位冲突(逐条比对,撞则测试红)', () => {
    const seen = new Map<string, string>();
    for (const binding of pkg.contributes.keybindings) {
      const key = binding.key ?? binding.mac;
      expect(key, `键位条目缺 key: ${binding.command}`).toBeTruthy();
      const owner = seen.get(key!);
      expect(owner, `键位冲突: ${key} 同时绑给 ${owner} 与 ${binding.command}`).toBeUndefined();
      seen.set(key!, binding.command);
    }
  });

  it('状态栏切换命令已贡献并有激活事件', () => {
    expect(pkg.contributes.commands.map(entry => entry.command)).toContain(
      HOT_RELOAD_SWITCH_CHANNEL_COMMAND
    );
    expect(pkg.activationEvents).toContain(`onCommand:${HOT_RELOAD_SWITCH_CHANNEL_COMMAND}`);
  });
});
