/**
 * 部署级热更新通道配置面板(IDE-HOT-102,设计 §5.1):按 ProjectProfile 读
 * 写 hotReload 段(通道选择 + 参数),未配回落既有 actionName 通道;面板内
 * 提供连通性测试按钮(调 transport.probe(),显示 ok/detail)。
 * 走 quick-pick + input 流(仓内 profile 编辑既有模式),每步可取消;测试
 * 连通性不保存(仅探测),确认保存才写 profile。
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

const CHANNEL_LABEL: Record<ReloadTransportKind, string> = {
  'kbengine-official': 'KBEngine 官方方案(引擎内建 reloadScript,经控制台)',
  http: '第三方 HTTP(自定 accepted/applied 回执契约)'
};

/** 默认连通性探测:经真实 transport.probe();不配/畸形如实 ok:false */
const defaultProbe = async (config: ReloadChannelConfig): Promise<{ ok: boolean; detail: string }> => {
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

/** 通道选择 quick-pick 条目 */
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
    title: 'HTTP 通道:URL 模板',
    value: prior?.url,
    prompt: '热更端点 URL,可含 ${files}/${fileList} 占位'
  });
  if (url === undefined || url.length === 0) {
    return undefined;
  }
  const method = await ui.showInputBox({
    title: 'HTTP 通道:方法',
    value: prior?.method ?? 'POST',
    prompt: 'HTTP 方法(默认 POST)'
  });
  if (method === undefined || method.length === 0) {
    return undefined;
  }
  const body = await ui.showInputBox({
    title: 'HTTP 通道:请求体模板(可空)',
    value: prior?.body ?? '${files}',
    prompt: '请求体模板,可含 ${files}/${fileList} 占位;留空表示无体'
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

/**
 * 配置面板主流程。返回是否成功写盘(取消/无 profile/无 UI 结果=false)。
 * 全程每步可取消:取消返回 false 且不写 profile(测试连通性也不保存)。
 */
export async function runHotReloadChannelConfigCommand(deps: HotReloadChannelConfigDeps): Promise<boolean> {
  const profiles = deps.listProfiles();
  if (profiles.length === 0) {
    await deps.ui.showInformationMessage('无部署 profile:先创建 profile 再配置热更通道');
    return false;
  }
  const profilePick = await deps.ui.showQuickPick(
    profiles.map(profile => ({ label: `${profile.displayName} (${profile.id.slice(0, 8)})`, profile })),
    { title: '选择要配置热更通道的部署 profile' }
  );
  if (!profilePick) {
    return false;
  }
  const profile = profilePick.profile;
  const existing = profile.hotReload;
  const channelPick = await deps.ui.showQuickPick(
    CHANNEL_OPTIONS.map(option => ({
      label: existing?.channel === option.value ? `${option.label} (当前)` : option.label,
      value: option.value
    })),
    { title: `[${profile.displayName}] 选择热更通道` }
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
