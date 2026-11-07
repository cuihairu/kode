/**
 * 首激活非模态提示(用户令 2026-11-06):热更默认开启后,第一次激活弹一次
 * 「保存 .py 会自动发到 127.0.0.1:8090/hotfix,一键关在状态栏/命令」的提示。
 *
 * - 非模态:走 showInformationMessage(默认非 modal),不挡编辑器;
 * - 可永久关闭:弹出即记 flag(workspaceState),此后不再打扰;
 * - 选「立即关闭」直接写回配置把热更关掉(不等用户自己找开关)。
 */

import { l10nText } from './nlsRuntime';

export const HOT_RELOAD_NOTICE_KEY = 'kbengine.hotReload.firstRunNotice';

// 取词在调用期(notice 弹出时):默认英文 locale 出英文源串,zh-cn bundle 出中文
export const HOT_RELOAD_NOTICE_MESSAGE = l10nText(
  'Auto hot reload is on by default: saving a .py sends a hot-reload request to http://127.0.0.1:8090/hotfix?module_name=<module name> (both query and body carry module_name, compatible with different server sides; duplicate values are harmless); failures are shown honestly when the engine is not running. To turn it off: click the hot-reload item in the status bar, or run the kbengine.hotReload.toggle command.'
);

export interface HotReloadNoticeDeps {
  /** 是否已提示过(flag 在工作区状态里) */
  isShown(): boolean;
  /** 记下「已提示过」,保证只弹一次 */
  markShown(): PromiseLike<void> | void;
  /** 非模态提示;返回用户点的按钮(没点/关窗为 undefined) */
  show(message: string, ...items: string[]): PromiseLike<string | undefined>;
  /** 用户点「立即关闭」:写回配置关掉热更 */
  turnOff(): Promise<void> | void;
}

/**
 * 首次激活提示。已提示过直接返回 false(零打扰);未提示则记 flag 再弹,
 * 返回是否真的弹了。任何一步抛错都不影响激活链(调用方 fire-and-forget)。
 */
export async function showHotReloadFirstRunNotice(deps: HotReloadNoticeDeps): Promise<boolean> {
  if (deps.isShown()) {
    return false;
  }
  await deps.markShown();
  const choice = await deps.show(HOT_RELOAD_NOTICE_MESSAGE, l10nText('Open logs'), l10nText('Turn off now'));
  if (choice === l10nText('Turn off now')) {
    await deps.turnOff();
  }
  return true;
}
