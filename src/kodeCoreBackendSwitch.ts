/**
 * Core 轨道切换写回(2026-11-24 用户令「core 的位置如果降级了就展示降级」+
 * 点击灯切换):把 `kbengine.core.backend` 写回配置面(不是内存开关),既有
 * onDidChangeConfiguration → gate.setConfig 链即时重装配轨道,不必重载窗口。
 *
 * 读写口径与 readHotReloadEnabled/writeHotReloadEnabled 同源:段内嵌套读、
 * 作用域按「有工作区文件夹写工作区级,否则用户级」选(单文件夹工作区按
 * workspaceFile 选会误写用户级,被工作区覆盖压住后开关看着成功实际没生效)。
 */

import * as vscode from 'vscode';

/** 配置键(相对 kbengine 段) */
export const CORE_BACKEND_SETTING = 'core.backend';

export type CoreBackendMode = 'ts' | 'rust' | 'shadow';

/** 合法轨道值(package.json 声明的 enum;缺省 rust) */
export const CORE_BACKEND_MODES: readonly CoreBackendMode[] = ['ts', 'rust', 'shadow'];

export const CORE_BACKEND_DEFAULT_MODE: CoreBackendMode = 'rust';

/** 读回当前轨道:raw 是配置原文(可能非法),effective 是实际生效值 */
export interface CoreBackendRead {
  raw: string;
  effective: CoreBackendMode;
}

/** 读当前配置值并归一到合法轨道(非法值诚实归缺省,与 gate 同判据) */
export function readCoreBackendMode(): CoreBackendRead {
  const raw =
    vscode.workspace
      .getConfiguration('kbengine')
      .get<string>(CORE_BACKEND_SETTING, CORE_BACKEND_DEFAULT_MODE) ?? CORE_BACKEND_DEFAULT_MODE;
  const effective = (CORE_BACKEND_MODES as readonly string[]).includes(raw)
    ? (raw as CoreBackendMode)
    : CORE_BACKEND_DEFAULT_MODE;
  return { raw, effective };
}

/**
 * 写回轨道并核对生效值:被别的作用域覆盖压住时不谎报成功,如实抛错由调用方上报。
 */
export async function writeCoreBackendMode(mode: CoreBackendMode): Promise<void> {
  if (!(CORE_BACKEND_MODES as readonly string[]).includes(mode)) {
    throw new Error(`非法 Core 轨道:${mode}(合法值 ${CORE_BACKEND_MODES.join('/')})`);
  }
  const configuration = vscode.workspace.getConfiguration('kbengine');
  const target =
    (vscode.workspace.workspaceFolders ?? []).length > 0
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;
  await configuration.update(CORE_BACKEND_SETTING, mode, target);
  if (readCoreBackendMode().effective !== mode) {
    throw new Error(
      `Core 轨道写入后未生效(被工作区/文件夹级配置覆盖?),请检查 kbengine.${CORE_BACKEND_SETTING} 的作用域`
    );
  }
}
