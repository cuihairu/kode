/**
 * 首激活非模态提示(用户令 2026-11-06):热更默认开启后,第一次激活弹一次
 * 「保存 .py 会自动发到 127.0.0.1:8090/hotfix,一键关在状态栏/命令」的提示。
 *
 * - 非模态:走 showInformationMessage(默认非 modal),不挡编辑器;
 * - 可永久关闭:弹出即记 flag(workspaceState),此后不再打扰;
 * - 选「立即关闭」直接写回配置把热更关掉(不等用户自己找开关)。
 */

export const HOT_RELOAD_NOTICE_KEY = 'kbengine.hotReload.firstRunNotice';

export const HOT_RELOAD_NOTICE_MESSAGE =
  '自动热更已默认开启:保存 .py 即向 http://127.0.0.1:8090/hotfix?module_name=<模块名> 发送热更请求' +
  '(query 与 body 各带一份 module_name,兼容不同服务端,同值重复无害);引擎未启动会如实显示失败。' +
  '一键关:点击底部状态栏「热更」项,或运行命令 kbengine.hotReload.toggle。';

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
  const choice = await deps.show(HOT_RELOAD_NOTICE_MESSAGE, '打开日志', '立即关闭');
  if (choice === '立即关闭') {
    await deps.turnOff();
  }
  return true;
}
