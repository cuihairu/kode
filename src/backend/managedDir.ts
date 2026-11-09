/**
 * kode 托管目录(用户令 2026-10-21,任务 B):`.kbengine` 一个目录收拢 kode
 * 生成的全部托管资产——debug.json、stubs/KBEngine.pyi、kbe_types.pyi 分件与
 * entity_types.pyi 同居。目录名可配置(新键 `kbengine.managedDir`,默认值就是
 * `.kbengine`);既有分散设置不废(旧键兼容):
 * - `kbengine.python.stubDir` / 环境变量 `KBENGINE_STUB_DIR` 仍按既有三级解析
 *   (设置 > 环境变量 > 默认约定)优先于「托管目录/stubs」,指定了就扫描、
 *   不覆盖用户资产——语义原样;
 * - `kbengine.managedDir` 只决定 kode 自管目录的落点,默认约定下所有生成物
 *   (含 debug.json)随之同迁,新键收拢于此单点。
 * 纯逻辑层,不 import vscode;装配层读取口在 pythonStubExport(readManagedDirSetting)。
 * 默认自动重建:目录被删后不需重载窗口,下一次相关事件(托管目录 watcher /
 * types.xml watcher / 激活)即重建全链——各导出链本就按内容比对零写,重复
 * 触发无副作用(接线在 extension.ts 的托管目录 watcher)。
 */

/** 设置键(getConfiguration('kbengine') 下的段名;完整键 kbengine.managedDir) */
export const MANAGED_DIR_SETTING_KEY = 'managedDir';
/** 完整设置键(展示用) */
export const MANAGED_DIR_SETTING_FULL = `kbengine.${MANAGED_DIR_SETTING_KEY}`;
/** 默认值就是 `.kbengine`(用户令:默认值约定) */
export const MANAGED_DIR_DEFAULT = '.kbengine';
/** 托管目录内的调试配置文件名 */
export const MANAGED_DIR_DEBUG_CONFIG_FILE = 'debug.json';

export interface ResolvedManagedDirName {
  /** 生效目录名(相对工作区根;相对形态) */
  name: string;
  /** true = 未配置,走默认 .kbengine */
  fromDefault: boolean;
}

/**
 * 目录名解析:空/非字符串 → 默认 `.kbengine`;配置值剥首尾空白与尾部斜杠
 * (相对形态,与存根目录三级解析的相对值同口径,绝对路径不在本键语义内)。
 */
export function resolveManagedDirName(setting?: unknown): ResolvedManagedDirName {
  const raw = typeof setting === 'string' ? setting.trim().replace(/\/+$/, '') : '';
  return raw.length > 0
    ? { name: raw, fromDefault: false }
    : { name: MANAGED_DIR_DEFAULT, fromDefault: true };
}
