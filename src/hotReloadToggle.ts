/**
 * 热更一键关/开(用户令 2026-11-06):默认开 = 保存即自动发请求,必须给
 * 一键关——状态栏点击与命令 kbengine.hotReload.toggle 同一条路,写回配置
 * (不是内存开关),配置事件驱动 watcher 拆建,即时生效不必重启窗口。
 *
 * 读面与 readHotReloadSettings 同口径:段内嵌套读,类型不符按默认开。
 */

import * as vscode from 'vscode';

export const HOT_RELOAD_TOGGLE_COMMAND = 'kbengine.hotReload.toggle';

/** 当前生效值:读 kbengine.hotReload 段的 enabled,缺失/类型错按默认开 */
export function readHotReloadEnabled(): boolean {
  const section = vscode.workspace
    .getConfiguration('kbengine')
    .get<Record<string, unknown> | undefined>('hotReload', undefined);
  const value = section === undefined ? undefined : section['enabled'];
  return typeof value === 'boolean' ? value : true;
}

/**
 * 写回配置:只要开着工作区文件夹就写**工作区级**(.vscode/settings.json /
 * *.code-workspace)——单文件夹工作区没有 workspaceFile,按它选会误写用户级,
 * 被工作区覆盖压住后开关看着成功实际没生效。没有任何文件夹才写用户级。
 * 写后核对生效值:被别的作用域覆盖压住时不谎报成功,如实抛错由调用方上报。
 */
export async function writeHotReloadEnabled(enabled: boolean): Promise<void> {
  const configuration = vscode.workspace.getConfiguration('kbengine');
  const target =
    (vscode.workspace.workspaceFolders ?? []).length > 0
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;
  await configuration.update('hotReload.enabled', enabled, target);
  if (readHotReloadEnabled() !== enabled) {
    throw new Error('热更开关写入后未生效(被工作区/文件夹级配置覆盖?),请检查 kbengine.hotReload.enabled 的作用域');
  }
}

/** 取反写回,返回写入后的新值(命令与状态栏点击共用) */
export async function toggleHotReloadEnabled(): Promise<boolean> {
  const next = !readHotReloadEnabled();
  await writeHotReloadEnabled(next);
  return next;
}
