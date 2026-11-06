/**
 * 部署级热更新通道配置(IDE-HOT-102,设计 §5.1)+ 快捷启用/快捷切换(本批):
 * - 预设一键启用:首屏三预设(自研接收器[推荐] / KBEngine 官方 / 未配置)+
 *   「高级配置」入口;选预设即按默认参数(本机端口/路径)一键探活,通过才写
 *   profile(全程 ≤2 步、零输入框),多步流(选通道 → 逐项收参数 → 保存/探测)
 *   保留在高级配置里。探测只走 transport.probe(),不保存;确认保存才写 profile。
 * - 状态栏快捷开关(HotReloadChannelQuickSwitch):状态栏项显示当前通道,点击
 *   弹三选 QuickPick 即切,选中即探活——绿=通(落 profile)、红=不通(不写 +
 *   一键修=打开高级配置)。既有发送态灯(hotReloadStatus,优先级 98)不动。
 * 通道的 UI/文档标签统一称「自研接收器」(代码值 'http' 不变防破坏);官方通道
 * 标注「依赖引擎 reloadScript」。
 */

import type { ProjectProfile } from './projectProfiles';
import {
  resolveReloadTransport,
  type ReloadChannelConfig,
  type ReloadTransportKind
} from './hotReloadTransport';

/** UI 面(真装配=vscode.window 对应 API;测试注入替身) */
export interface HotReloadChannelConfigUi {
  showQuickPick<T extends { label: string }>(items: T[], options: { title: string }): Promise<T | undefined>;
  showInputBox(options: { title: string; value?: string; prompt: string }): Promise<string | undefined>;
  showInformationMessage(message: string): Promise<unknown>;
  showErrorMessage(message: string): Promise<unknown>;
}

/** 面板依赖:profile 读写 + UI + 可注入的连通性探测(测试替身) */
export interface HotReloadChannelConfigDeps {
  listProfiles(): ProjectProfile[];
  saveHotReload(id: string, config: ReloadChannelConfig | undefined): Promise<ProjectProfile | null>;
  ui: HotReloadChannelConfigUi;
  /**
   * 连通性测试:给定配置返回 probe 结果。缺省经 resolveReloadTransport 建
   * 真实通道调 probe();未配/字段缺失返回 ok:false 如实说明。测试注入为
   * 探真 transport.probe,不触碰 profile(探测不保存)。
   */
  probe?(config: ReloadChannelConfig): Promise<{ ok: boolean; detail: string }>;
}

/**
 * 通道展示标签(UI/文档口径;代码值 'http' / 'kbengine-official' 不变防破坏)。
 * 自研 HTTP 接收器(本仓 scripts/hot-reload-receiver)不再自称「第三方」。
 */
export const CHANNEL_LABEL: Record<ReloadTransportKind, string> = {
  'kbengine-official': 'KBEngine 官方(依赖引擎 reloadScript,经控制台)',
  http: '自研接收器(HTTP,accepted/applied 回执契约)'
};

/** 状态栏短标签(空间有限,只留通道身份) */
export const CHANNEL_SHORT_LABEL: Record<ReloadTransportKind, string> = {
  'kbengine-official': 'KBEngine官方',
  http: '自研HTTP'
};

/** 短标签:未配通道如实显示未配置 */
export const shortChannelLabel = (channel: ReloadTransportKind | undefined): string =>
  channel === undefined ? '未配置' : CHANNEL_SHORT_LABEL[channel];

/** 自研接收器预设默认:本机端口/路径(接收器 referenceReceiver.mjs 的 /reload 端点;接收器须以 --port 8000 启动) */
export const DEFAULT_HTTP_RECEIVER_URL = 'http://127.0.0.1:8000/reload';
/**
 * 预设默认请求体:JSON **对象**——只有对象体才会被 transport 自动附加
 * `targetId` 与 `sender_digests`(hotReloadTransport autoAttach*),接收端核对
 * digest 后才回 applied;裸 `${files}` 数组体带不上这两个字段,永远到不了 applied。
 */
export const DEFAULT_HTTP_RECEIVER_BODY = '{"files":${files}}';
/** 官方通道预设默认:本机控制台(host/port 不对可走高级配置逐项核对) */
export const DEFAULT_OFFICIAL_HOST = '127.0.0.1';
export const DEFAULT_OFFICIAL_PORT = 2560;

/** 默认连通性探测:经真实 transport.probe();不配/畸形如实 ok:false */
export const defaultProbe = async (config: ReloadChannelConfig): Promise<{ ok: boolean; detail: string }> => {
  const transport = resolveReloadTransport(config);
  if (!transport) {
    return { ok: false, detail: '通道配置不完整,无法探测' };
  }
  try {
    return await transport.probe();
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
};

/**
 * 自研接收器预设配置:默认参数自动填好(本机端口/路径),已配过的同通道参数
 * 优先沿用(不把自定义 URL 冲回默认)。
 */
export function buildHttpPresetConfig(existing: ReloadChannelConfig | undefined): ReloadChannelConfig {
  const prior = existing?.channel === 'http' ? existing.http : undefined;
  return {
    channel: 'http',
    http: {
      name: 'hot-reload',
      url: prior?.url ?? DEFAULT_HTTP_RECEIVER_URL,
      method: prior?.method ?? 'POST',
      headers: prior?.headers ?? {},
      body: prior?.body ?? DEFAULT_HTTP_RECEIVER_BODY,
      enabled: prior?.enabled ?? true,
      keybinding: prior?.keybinding ?? ''
    }
  };
}

/** 官方通道预设配置:默认本机控制台,已配参数优先沿用 */
export function buildOfficialPresetConfig(existing: ReloadChannelConfig | undefined): ReloadChannelConfig {
  const prior = existing?.channel === 'kbengine-official' ? existing.official : undefined;
  return {
    channel: 'kbengine-official',
    official: {
      host: prior?.host ?? DEFAULT_OFFICIAL_HOST,
      port: prior?.port ?? DEFAULT_OFFICIAL_PORT,
      ...(prior?.password !== undefined ? { password: prior.password } : {}),
      fullReload: prior?.fullReload ?? true
    }
  };
}

/** 预设选择条目(首屏);value 同时是测试脚本的选择键 */
interface PresetChoice {
  readonly label: string;
  readonly preset: 'http-receiver' | 'kbengine-official' | 'unset' | 'advanced';
}

const buildPresetOptions = (existing: ReloadChannelConfig | undefined): PresetChoice[] => {
  const current = existing?.channel;
  const mark = (match: boolean): string => (match ? ' (当前)' : '');
  return [
    {
      label: `$(zap) 自研接收器(HTTP,推荐)一键启用${mark(current === 'http')}`,
      preset: 'http-receiver'
    },
    {
      label: `KBEngine 官方(依赖引擎 reloadScript)一键启用${mark(current === 'kbengine-official')}`,
      preset: 'kbengine-official'
    },
    { label: `未配置(回落既有 actionName 通道)${mark(current === undefined)}`, preset: 'unset' },
    { label: '高级配置(逐项填参数 / 手动探测)', preset: 'advanced' }
  ];
};

/** 高级配置里的通道选择(未配/官方/HTTP) */
interface ChannelChoice {
  readonly label: string;
  readonly value: ReloadTransportKind | 'unset';
}

const CHANNEL_OPTIONS: ChannelChoice[] = [
  { label: '未配(回落既有 kbengine.hotReload.actionName 通道)', value: 'unset' },
  { label: CHANNEL_LABEL['kbengine-official'], value: 'kbengine-official' },
  { label: CHANNEL_LABEL.http, value: 'http' }
];

async function collectOfficialConfig(
  ui: HotReloadChannelConfigUi,
  existing: ReloadChannelConfig | undefined
): Promise<ReloadChannelConfig | undefined> {
  const prior = existing?.channel === 'kbengine-official' ? existing.official : undefined;
  const host = await ui.showInputBox({
    title: '官方通道:控制台主机',
    value: prior?.host,
    prompt: 'KBEngine 控制台(telnet)主机,如 127.0.0.1'
  });
  if (host === undefined || host.length === 0) {
    return undefined;
  }
  const portRaw = await ui.showInputBox({
    title: '官方通道:控制台端口',
    value: prior?.port !== undefined ? String(prior.port) : undefined,
    prompt: '控制台端口(1..65535)'
  });
  if (portRaw === undefined) {
    return undefined;
  }
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    await ui.showErrorMessage(`官方通道端口无效: ${portRaw}(需 1..65535 整数)`);
    return undefined;
  }
  const password = await ui.showInputBox({
    title: '官方通道:控制台密码(可空)',
    value: prior?.password,
    prompt: '控制台密码;留空表示无密码'
  });
  if (password === undefined) {
    return undefined;
  }
  return {
    channel: 'kbengine-official',
    official: {
      host,
      port,
      ...(password.length > 0 ? { password } : {}),
      fullReload: prior?.fullReload ?? true
    }
  };
}

async function collectHttpConfig(
  ui: HotReloadChannelConfigUi,
  existing: ReloadChannelConfig | undefined
): Promise<ReloadChannelConfig | undefined> {
  const prior = existing?.channel === 'http' ? existing.http : undefined;
  const url = await ui.showInputBox({
    title: '自研接收器:URL 模板',
    value: prior?.url,
    prompt: '热更端点 URL,可含 ${files}/${fileList} 占位'
  });
  if (url === undefined || url.length === 0) {
    return undefined;
  }
  const method = await ui.showInputBox({
    title: '自研接收器:方法',
    value: prior?.method ?? 'POST',
    prompt: 'HTTP 方法(默认 POST)'
  });
  if (method === undefined || method.length === 0) {
    return undefined;
  }
  const body = await ui.showInputBox({
    title: '自研接收器:请求体模板(可空)',
    value: prior?.body ?? DEFAULT_HTTP_RECEIVER_BODY,
    prompt: '请求体模板,可含 ${files}/${fileList} 占位;默认 JSON 对象体(能带 targetId/sender_digests);留空表示无体'
  });
  if (body === undefined) {
    return undefined;
  }
  return {
    channel: 'http',
    http: {
      name: 'hot-reload',
      url,
      method: method.toUpperCase(),
      headers: prior?.headers ?? {},
      body,
      enabled: true,
      keybinding: ''
    }
  };
}

/** 保存/探测/取消三选一 quick-pick */
interface FinalChoice {
  readonly label: string;
  readonly action: 'save' | 'probe' | 'cancel';
}

const FINAL_OPTIONS: FinalChoice[] = [
  { label: '保存通道配置', action: 'save' },
  { label: '测试连通性(不保存)', action: 'probe' },
  { label: '取消(不保存)', action: 'cancel' }
];

/** 保存 + 成功回执(预设一键启用与高级配置共用) */
async function persistChannelConfig(
  deps: HotReloadChannelConfigDeps,
  profile: ProjectProfile,
  config: ReloadChannelConfig | undefined
): Promise<boolean> {
  const saved = await deps.saveHotReload(profile.id, config);
  if (!saved) {
    await deps.ui.showErrorMessage('保存失败:profile 不存在');
    return false;
  }
  await deps.ui.showInformationMessage(
    config === undefined
      ? `[${profile.displayName}] 热更通道已清除(回落 actionName 通道)`
      : `[${profile.displayName}] 热更通道已保存: ${CHANNEL_LABEL[config.channel]}`
  );
  return true;
}

/** 高级配置多步流:选通道 → 逐项收参数 → 保存/探测/取消 */
async function runAdvancedChannelFlow(
  deps: HotReloadChannelConfigDeps,
  profile: ProjectProfile,
  existing: ReloadChannelConfig | undefined
): Promise<boolean> {
  const channelPick = await deps.ui.showQuickPick(
    CHANNEL_OPTIONS.map(option => ({
      label: existing?.channel === option.value ? `${option.label} (当前)` : option.label,
      value: option.value
    })),
    { title: `[${profile.displayName}] 高级配置:选择热更通道` }
  );
  if (!channelPick) {
    return false;
  }
  let config: ReloadChannelConfig | undefined;
  if (channelPick.value === 'unset') {
    config = undefined;
  } else if (channelPick.value === 'kbengine-official') {
    config = await collectOfficialConfig(deps.ui, existing);
    if (config === undefined) {
      return false;
    }
  } else {
    config = await collectHttpConfig(deps.ui, existing);
    if (config === undefined) {
      return false;
    }
  }
  const finalPick = await deps.ui.showQuickPick(FINAL_OPTIONS, { title: '热更通道:下一步' });
  if (!finalPick || finalPick.action === 'cancel') {
    return false;
  }
  if (finalPick.action === 'probe') {
    if (!config) {
      await deps.ui.showInformationMessage('未配通道:无通道可探测(将回落 actionName 通道)');
      return false;
    }
    const result = await (deps.probe ?? defaultProbe)(config);
    if (result.ok) {
      await deps.ui.showInformationMessage(`连通性测试通过: ${result.detail}`);
    } else {
      await deps.ui.showErrorMessage(`连通性测试失败: ${result.detail}`);
    }
    return false;
  }
  return persistChannelConfig(deps, profile, config);
}

/** 命令入口选项(状态栏「一键修」与快捷键共用同一命令) */
export interface HotReloadChannelConfigCommandOptions {
  /** 'advanced' = 直接进高级配置多步流(跳过预设首屏);缺省 = 预设一键启用首屏 */
  readonly entry?: 'preset' | 'advanced';
  /** 指定 profile id(一键修带上失败时的 profile);找不到如实报错,不猜不新建 */
  readonly profileId?: string;
}

/**
 * 配置面板主流程。返回是否成功写盘(取消/无 profile/无 UI 结果=false)。
 * 首屏即预设一键启用:单 profile 直接进预设列表、多 profile 先选 profile,
 * 两步到顶(≤2 步)——选预设 → 自动探活 → 通过即启用;「高级配置」进多步流
 * (options.entry='advanced' 为状态栏一键修的直达入口)。全程每步可取消,
 * 取消不写 profile(探测也不保存)。
 */
export async function runHotReloadChannelConfigCommand(
  deps: HotReloadChannelConfigDeps,
  options: HotReloadChannelConfigCommandOptions = {}
): Promise<boolean> {
  const profiles = deps.listProfiles();
  if (profiles.length === 0) {
    await deps.ui.showInformationMessage('无部署 profile:先创建 profile 再配置热更通道');
    return false;
  }
  let profile: ProjectProfile;
  if (options.profileId !== undefined) {
    const found = profiles.find(candidate => candidate.id === options.profileId);
    if (!found) {
      await deps.ui.showErrorMessage(`配置目标 profile 不存在: ${options.profileId}(不猜、不新建)`);
      return false;
    }
    profile = found;
  } else if (profiles.length === 1) {
    // 单 profile 直接用它:省掉一次选择,预设列表就是首屏
    profile = profiles[0];
  } else {
    const profilePick = await deps.ui.showQuickPick(
      profiles.map(candidate => ({
        label: `${candidate.displayName} (${candidate.id.slice(0, 8)})`,
        profile: candidate
      })),
      { title: '选择要配置热更通道的部署 profile' }
    );
    if (!profilePick) {
      return false;
    }
    profile = profilePick.profile;
  }
  const existing = profile.hotReload;
  if (options.entry === 'advanced') {
    return runAdvancedChannelFlow(deps, profile, existing);
  }
  const presetPick = await deps.ui.showQuickPick(buildPresetOptions(existing), {
    title: `[${profile.displayName}] 热更通道预设:一键启用`
  });
  if (!presetPick) {
    return false;
  }
  if (presetPick.preset === 'advanced') {
    return runAdvancedChannelFlow(deps, profile, existing);
  }
  if (presetPick.preset === 'unset') {
    return persistChannelConfig(deps, profile, undefined);
  }
  const config =
    presetPick.preset === 'http-receiver'
      ? buildHttpPresetConfig(existing)
      : buildOfficialPresetConfig(existing);
  const result = await (deps.probe ?? defaultProbe)(config);
  if (!result.ok) {
    await deps.ui.showErrorMessage(
      `[${profile.displayName}] 预设探活不通,未启用: ${CHANNEL_LABEL[config.channel]} — ${result.detail}` +
        '(端口/路径对不上走「高级配置」逐项核对)'
    );
    return false;
  }
  const saved = await deps.saveHotReload(profile.id, config);
  if (!saved) {
    await deps.ui.showErrorMessage('保存失败:profile 不存在');
    return false;
  }
  await deps.ui.showInformationMessage(
    `[${profile.displayName}] 热更通道已启用: ${CHANNEL_LABEL[config.channel]} · 探活通过: ${result.detail}`
  );
  return true;
}

/* ------------------------------------------------------------------ */
/* 状态栏快捷开关(三选即切 + 探活反馈)                                    */
/* ------------------------------------------------------------------ */

/** 状态栏切换命令(点击通道灯即触发) */
export const HOT_RELOAD_SWITCH_CHANNEL_COMMAND = 'kbengine.hotReload.switchChannel';
/** 通道灯优先级:避开既有发送态灯(98)/telnet(99)/server(100)/解释器(97) */
export const HOT_RELOAD_CHANNEL_STATUS_PRIORITY = 96;

/** 状态栏项最小面:真 vscode.StatusBarItem 的结构子集,测试用假体同形 */
export interface ChannelStatusItemLike {
  text: string;
  command?: string | { command: string } | undefined;
  tooltip?: unknown;
  /** 红底(探活不通);真装配传 vscode.ThemeColor,测试传 { id } 替身 */
  backgroundColor?: unknown;
  show(): void;
  hide(): void;
  dispose(): void;
}

/** 切换命令的 UI 面:三选 + 信息 + 带按钮的错误提示(一键修) */
export interface HotReloadChannelSwitchUi {
  showQuickPick<T extends { label: string }>(items: T[], options: { title: string }): Promise<T | undefined>;
  showInformationMessage(message: string): Promise<unknown>;
  /** actions=错误提示按钮(一键修);返回点中的按钮或 undefined */
  showErrorMessage(message: string, actions?: readonly string[]): Promise<string | undefined>;
}

export interface HotReloadChannelSwitchDeps {
  /** 当前激活 profile(含其 hotReload 段);无激活 profile 返回 null */
  getActiveProfile(): { profile: ProjectProfile } | null;
  saveHotReload(id: string, config: ReloadChannelConfig | undefined): Promise<ProjectProfile | null>;
  createStatusBarItem(): ChannelStatusItemLike;
  registerCommand(command: string, handler: () => unknown): { dispose(): void };
  ui: HotReloadChannelSwitchUi;
  /** 连通性探测;缺省走 defaultProbe(真实通道) */
  probe?(config: ReloadChannelConfig): Promise<{ ok: boolean; detail: string }>;
  /** 一键修:带 profile id 直达该 profile 的高级配置流程,返回是否写盘成功 */
  runAdvancedConfig?(profileId: string): Promise<boolean>;
  /**
   * 探活不通时的状态栏红底:真装配传 new vscode.ThemeColor(
   * 'statusBarItem.errorBackground');缺省 { id: 'statusBarItem.errorBackground' }
   * (测试替身同形)。
   */
  dangerBackgroundColor?: unknown;
}

const FIX_ACTION = '打开高级配置修参数';

/**
 * 探活记录:stateKey=记录时的「激活 profile + 该 profile 的通道配置身份」——
 * profile 切换、通道改参数、面板写盘都会让 key 变化,旧红/绿结论随即作废
 * (跨 profile/跨参数绝不残留)。channel=本次试的通道(只用于 tooltip 文案)。
 */
interface ChannelProbeNote {
  readonly channel: ReloadTransportKind;
  readonly ok: boolean;
  readonly detail: string;
  readonly stateKey: string;
}

/**
 * 状态栏通道灯:显示当前通道,点击弹三选 QuickPick 即切(选中即探活)。
 * 绿(默认底 + $(plug))=通或未验证;红($(error) + errorBackground)=最近一次
 * 探活不通且通道未切换。既有发送态灯(hotReloadStatus)各渲染各的,不抢位。
 */
export class HotReloadChannelQuickSwitch {
  private readonly deps: HotReloadChannelSwitchDeps;
  private readonly bar: ChannelStatusItemLike;
  private readonly dangerBackgroundColor: unknown;
  private readonly registration: { dispose(): void };
  private currentChannel: ReloadTransportKind | undefined;
  private note: ChannelProbeNote | undefined;

  constructor(deps: HotReloadChannelSwitchDeps) {
    this.deps = deps;
    this.dangerBackgroundColor = deps.dangerBackgroundColor ?? {
      id: 'statusBarItem.errorBackground'
    };
    this.bar = deps.createStatusBarItem();
    this.bar.command = HOT_RELOAD_SWITCH_CHANNEL_COMMAND;
    this.registration = deps.registerCommand(HOT_RELOAD_SWITCH_CHANNEL_COMMAND, () => this.run());
    this.refresh();
    this.bar.show();
  }

  /** 重读激活 profile 的通道(配置面板写盘后 / profile 切换后调用) */
  refresh(): void {
    const active = this.deps.getActiveProfile();
    this.currentChannel = active?.profile.hotReload?.channel;
    if (this.note !== undefined && this.note.stateKey !== this.stateKey()) {
      // profile 或通道配置身份已变:旧探活结论不再适用
      this.note = undefined;
    }
    this.render();
  }

  /** 「激活 profile id + 其通道配置」的身份串(探活结论的归属键) */
  private stateKey(): string {
    const active = this.deps.getActiveProfile();
    if (!active) {
      return '';
    }
    const config = active.profile.hotReload;
    return `${active.profile.id}|${config === undefined ? '' : JSON.stringify(config)}`;
  }

  /** 三选切换;返回是否写盘成功(取消/探活不通/无 profile=false) */
  async run(): Promise<boolean> {
    const active = this.deps.getActiveProfile();
    if (!active) {
      await this.deps.ui.showErrorMessage('无激活部署 profile:先创建并激活 profile 再切换热更通道');
      return false;
    }
    // 打开三选前冻结「激活 profile + 该 profile 通道配置」身份:选择器等待期间
    // 或探活期间 profile/配置被改,本次切换一律作废不写(不把旧状态的结论算到新状态上)
    const stateKeyAtOpen = this.stateKey();
    const existing = active.profile.hotReload;
    const current = existing?.channel;
    const mark = (match: boolean): string => (match ? ' (当前)' : '');
    const choice = await this.deps.ui.showQuickPick(
      [
        {
          label: `自研接收器(HTTP,推荐)一键启用${mark(current === 'http')}`,
          value: 'http'
        },
        {
          label: `KBEngine 官方(依赖引擎 reloadScript)一键启用${mark(current === 'kbengine-official')}`,
          value: 'kbengine-official'
        },
        {
          label: `未配置(回落既有 actionName 通道)${mark(current === undefined)}`,
          value: 'unset'
        }
      ],
      { title: `热更通道三选:一键切换(选中即探活 · ${active.profile.displayName})` }
    );
    if (!choice) {
      return false;
    }
    if (stateKeyAtOpen !== this.stateKey()) {
      await this.deps.ui.showInformationMessage(
        '选择期间 profile/通道配置已变化,本次切换作废(不写盘)'
      );
      this.refresh();
      return false;
    }
    const config =
      choice.value === 'unset'
        ? undefined
        : choice.value === 'http'
          ? buildHttpPresetConfig(existing)
          : buildOfficialPresetConfig(existing);
    let probeDetail = '';
    if (config) {
      // 探活期间 profile/通道被改即判过期(与选择前冻结的同一把身份键),作废不落账
      const result = await (this.deps.probe ?? defaultProbe)(config);
      probeDetail = result.detail;
      if (stateKeyAtOpen !== this.stateKey()) {
        await this.deps.ui.showInformationMessage(
          `探活期间 profile/通道配置已变化,本次结果作废(不写盘): ${result.detail}`
        );
        this.refresh();
        return false;
      }
      this.note = {
        channel: config.channel,
        ok: result.ok,
        detail: result.detail,
        stateKey: stateKeyAtOpen
      };
      if (!result.ok) {
        this.render();
        const action = await this.deps.ui.showErrorMessage(
          `[${active.profile.displayName}] ${CHANNEL_LABEL[config.channel]} 探活不通,通道未切换: ${result.detail}`,
          [FIX_ACTION]
        );
        if (action === FIX_ACTION && this.deps.runAdvancedConfig !== undefined) {
          // 一键修直达该 profile 的高级配置(不再从 profile/预设首屏重走)
          const fixed = await this.deps.runAdvancedConfig(active.profile.id);
          if (fixed) {
            this.note = undefined;
          }
          this.refresh();
        }
        return false;
      }
    }
    const saved = await this.deps.saveHotReload(active.profile.id, config);
    if (!saved) {
      this.note = undefined;
      this.refresh();
      await this.deps.ui.showErrorMessage('保存失败:profile 不存在');
      return false;
    }
    this.refresh();
    if (config) {
      // 绿标只在「刚写盘返回的 profile+配置」仍等于当前状态时才立:写盘 await 期间
      // 若被切到别的 profile(尤其同通道)或配置被改,该结论归属不成立 → 不立绿标,
      // 保持 refresh() 读到的当前状态(写盘本身已成功,如实不谎称不写)。
      const savedKey = `${saved.id}|${saved.hotReload === undefined ? '' : JSON.stringify(saved.hotReload)}`;
      if (savedKey === this.stateKey()) {
        this.note = {
          channel: config.channel,
          ok: true,
          detail: probeDetail,
          stateKey: savedKey
        };
        this.render();
      }
    }
    await this.deps.ui.showInformationMessage(
      config === undefined
        ? `[${active.profile.displayName}] 热更通道已清除(回落 actionName 通道)`
        : `[${active.profile.displayName}] 热更通道已切换: ${CHANNEL_LABEL[config.channel]} · 探活通过: ${probeDetail}`
    );
    return true;
  }

  dispose(): void {
    this.registration.dispose();
    this.bar.dispose();
  }

  private render(): void {
    // 状态栏文字只显示**当前已配置**的通道(探活失败时配置没动,就还是原通道);
    // 红标 + tooltip 才说明最近一次试的通道不通——未落盘的通道绝不冒充当前状态
    const failed = this.note !== undefined && !this.note.ok;
    this.bar.text = `${failed ? '$(error)' : '$(plug)'} 热更:${shortChannelLabel(this.currentChannel)}`;
    this.bar.tooltip =
      failed && this.note
        ? `热更通道探活不通: 试的 ${CHANNEL_LABEL[this.note.channel]} — ${this.note.detail}(点击三选切换,或高级配置核对参数)`
        : this.note?.ok && this.note.channel === this.currentChannel
          ? `热更通道探活通过: ${this.note.detail}(点击三选切换通道)`
          : '点击切换热更通道(三选一键,选中即探活)';
    this.bar.backgroundColor = failed ? this.dangerBackgroundColor : undefined;
  }
}
