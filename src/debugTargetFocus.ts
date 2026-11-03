/**
 * Debug Targets 树「监听」行的点击收口(IDE-DBG-008 × IDE-PDBG-002 端口模式
 * 补控件):点行不再停在「去 launch.json 找」一句话上——提示之后给两个下一步
 * 动作:
 * - 立即附加:走端口模式整条链(端口不开自动进「起监听并附加/重试附加/
 *   起监听指引」下一步引导);
 * - 打开 launch.json:先动态写好该口的 connect 条目再打开(写不成如实说,
 *   不装作能打开)。
 * 命名实例行(`组件#实例`)只给「打开 launch.json」:attachToComponent 按组件
 * 配置/端口表附加,指不到该实例自己的口——如实不给会指错目标的按钮。
 * 副作用经 effects 注入,装配层与测试共用同一份行为面。
 */

import { DEBUG_PHASE_LABELS } from './debugStatusTree';

/** 「监听」行的下一步控件文案(单一真源:扩展装配与测试同用) */
export const DEBUG_LISTENING_ROW_ACTIONS = {
  attachNow: '立即附加',
  openLaunch: '打开 launch.json'
} as const;

/** 默认实例行的控件顺序(即弹窗按钮顺序) */
export const DEBUG_LISTENING_ROW_ACTION_LIST: readonly string[] = [
  DEBUG_LISTENING_ROW_ACTIONS.attachNow,
  DEBUG_LISTENING_ROW_ACTIONS.openLaunch
];

/** 行键 → 组件名:命名实例 `组件#实例` 只取组件段 */
export function componentNameFromServerKey(serverKey: string): string {
  return serverKey.split('#')[0];
}

export interface ListeningRowEffects {
  /** 立即附加(端口模式整条链) */
  attach(componentName: string): Promise<boolean>;
  /** 动态写该口的 connect 条目并打开 launch.json */
  openLaunchJson(componentName: string, port: number): Promise<{ ok: boolean; detail: string }>;
  /** 提示 + 动作(装配层=showInformationMessage) */
  show(message: string, actions: readonly string[]): Promise<string | undefined>;
}

export type ListeningRowOutcome =
  | 'attached'
  | 'launch-opened'
  | 'write-failed'
  | 'dismissed';

export interface ListeningRowResult {
  outcome: ListeningRowOutcome;
  /** write-failed 时带(装配层如实播报) */
  detail?: string;
}

/** 缺省口:行没带端口时按 debugpy 官方默认口写条目(与 attach 缺省同口径) */
const FALLBACK_PORT = 5678;

export async function runListeningRowFocus(
  serverKey: string,
  port: number | undefined,
  effects: ListeningRowEffects
): Promise<ListeningRowResult> {
  const componentName = componentNameFromServerKey(serverKey);
  const isInstance = serverKey.includes('#');
  const actions = isInstance ? [DEBUG_LISTENING_ROW_ACTIONS.openLaunch] : DEBUG_LISTENING_ROW_ACTION_LIST;
  const message =
    `${serverKey} ${DEBUG_PHASE_LABELS.listening}中(debugpy ${port ?? '?'}):` +
    '用 launch.json 里对应的 attach 配置附加';
  const pick = await effects.show(message, actions);
  if (pick === DEBUG_LISTENING_ROW_ACTIONS.attachNow && !isInstance) {
    await effects.attach(componentName);
    return { outcome: 'attached' };
  }
  if (pick === DEBUG_LISTENING_ROW_ACTIONS.openLaunch) {
    const state = await effects.openLaunchJson(componentName, port ?? FALLBACK_PORT);
    return state.ok
      ? { outcome: 'launch-opened', detail: state.detail }
      : { outcome: 'write-failed', detail: state.detail };
  }
  return { outcome: 'dismissed' };
}
