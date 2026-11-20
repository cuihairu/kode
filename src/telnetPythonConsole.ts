/**
 * TELNET-EZ-001 ②「Python 控制台」浅入口:侧边栏 telnet 树顶部按钮 +
 * 命令面板双入口,点击→自动探测全部组件 telnet 端口(既有探测链,端口/
 * 密码来自 kbengine.xml/引擎 defaults 真值)→已开组件一键选→进面板会话;
 * 全未开→一次性引导(附 kbengine.xml 片段口径,面板内有完整片段)。
 * 全程零配置知识。编排面纯函数(依赖注入),会话/白名单闸仍在服务层。
 */

import type { TelnetProbeState, TelnetTarget } from './telnetService';

export interface PythonConsolePickItem {
  key: string;
  label: string;
  detail: string;
  description: string;
}

export interface TelnetPythonConsoleDeps {
  /** 立即跑一轮探测(不等的缓存):探测链复用既有 TelnetService.probeOnce */
  probeOnce(): Promise<void>;
  getTargets(): TelnetTarget[];
  getState(key: string): TelnetProbeState;
  showQuickPick(
    items: PythonConsolePickItem[],
    options: { placeHolder: string }
  ): Thenable<PythonConsolePickItem | undefined>;
  showInformationMessage(
    message: string,
    ...actions: string[]
  ): Thenable<string | undefined>;
  /** 打开 telnet 面板并选中所给目标 */
  openPanelWithTarget(key: string): void;
  /** 仅打开面板(引导消息的「打开 Telnet 面板」动作) */
  openPanel(): void;
}

/** 状态文案(QuickPick description):与面板状态灯同口径 */
function stateText(state: TelnetProbeState): string {
  switch (state) {
    case 'connected':
      return '已连接';
    case 'open':
      return '已开启';
    case 'auth-required':
      return '端口开·未配密码';
    case 'auth-rejected':
      return '密码被拒';
    default:
      return '未开启';
  }
}

/** 探测→选组件→进会话编排。返回值用于测试与日志,不外抛。 */
export async function runPythonConsoleEntry(
  deps: TelnetPythonConsoleDeps
): Promise<'picked' | 'no-targets' | 'cancelled' | 'guided'> {
  // 立即探测一轮:不拿旧缓存判「全未开」(探测链本来就是低频轮询)
  await deps.probeOnce();
  const targets = deps.getTargets();
  if (targets.length === 0) {
    const action = await deps.showInformationMessage(
      '未发现 telnet 目标:请在设置 kbengine.telnet.host/port 配置,或在元件 kbengine.xml 的 <telnet_service> 段开启(面板内有配置片段)。',
      '打开 Telnet 面板'
    );
    if (action === '打开 Telnet 面板') {
      deps.openPanel();
    }
    return 'no-targets';
  }
  // 已开组件:端口开(open/connected)可一键进;auth-required 端口也开着,
  // 一并可选(进面板看密码指引,不硬连);closed 的不进选择列表
  const openStates: TelnetProbeState[] = ['open', 'connected', 'auth-required'];
  const openTargets = targets.filter(target => openStates.includes(deps.getState(target.key)));
  if (openTargets.length === 0) {
    const action = await deps.showInformationMessage(
      '全部组件的 telnet 均未开启:在元件 kbengine.xml 中加入 <telnet_service> 段(端口/密码)并重启组件即可,面板内有完整配置片段。',
      '打开 Telnet 面板'
    );
    if (action === '打开 Telnet 面板') {
      deps.openPanel();
    }
    return 'guided';
  }
  const picked = await deps.showQuickPick(
    openTargets.map(target => ({
      key: target.key,
      label: target.label,
      detail: `${target.host}:${target.port}`,
      description: stateText(deps.getState(target.key))
    })),
    { placeHolder: '选择要进入 Python 交互的组件(已开启)' }
  );
  if (!picked) {
    return 'cancelled';
  }
  deps.openPanelWithTarget(picked.key);
  return 'picked';
}
