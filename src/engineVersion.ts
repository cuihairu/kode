/**
 * 引擎版本感知面(todo.md「版本感知」KB-VER-001):kode 需要知道当前集成的
 * KBEngine 版本——魔改 fork 各异,不同版本支持的特性不同,知识库/诊断按此做
 * 版本门控(KB-VER-002 分层标注 / KB-VER-003 越界提示都是本设置的消费方)。
 *
 * 设置键 `kbengine.engineVersion`,默认 "3.7.3"(官方最新稳定基线);魔改
 * fork 填自定义版本号(fork-3.12 之类自由串)。读取走仓内既有容错口径
 * (readHotReloadSettings 同款 ConfigReader 注入):非字符串/空串回落默认,
 * 配置写坏不拖垮装配。变更联动仿 kodeCoreGateWiring 的
 * onDidChangeConfiguration + affectsConfiguration(精确键)模式,命中即向
 * 内部事件播报新值,消费方按需订阅。
 */

import * as vscode from 'vscode';

/** 设置键(package.json contributes.configuration 同名) */
export const ENGINE_VERSION_SETTING = 'kbengine.engineVersion';
/** 缺省版本:官方 3.7.3 基线 */
export const DEFAULT_ENGINE_VERSION = '3.7.3';

/** 配置读取口:与 vscode.ConfigurationShape 同形,测试用内存替身驱动 */
export interface ConfigReader {
  get: <T>(key: string, defaultValue: T) => T;
}

/** 常见预设条目(未来 quick pick 直接喂 label/detail;本任务不建 UI) */
export interface EngineVersionPreset {
  /** 写入设置的值(自由串,fork 条目带 fork- 前缀口径) */
  readonly value: string;
  /** quick pick 主行 */
  readonly label: string;
  /** quick pick 详情行 */
  readonly detail: string;
}

/**
 * 常见预设常量表:官方稳定线 + 常见魔改 fork 示例。仅供选择面板与
 * isKnownEnginePreset 提示用,设置本身是自由串,不在表内不报错。
 */
export const ENGINE_VERSION_PRESETS: readonly EngineVersionPreset[] = [
  {
    value: '3.7.3',
    label: 'KBEngine 3.7.3',
    detail: '官方最新稳定基线(默认)'
  },
  {
    value: '3.7.2',
    label: 'KBEngine 3.7.2',
    detail: '官方 3.7 线前一个稳定版'
  },
  {
    value: '3.6.3',
    label: 'KBEngine 3.6.3',
    detail: '官方 3.6 线稳定版'
  },
  {
    value: 'fork-3.12',
    label: 'Fork 3.12(魔改)',
    detail: '基于上游 3.x 的魔改 fork 示例,含 fork-only 特性'
  },
  {
    value: '2.5.10',
    label: 'KBEngine 2.5.10',
    detail: '旧版基线(kbeversion.h 三宏口径)'
  }
];

/** 容错归一:非字符串剥掉,trim 后空串回落默认;合法值原样回显 */
export function normalizeEngineVersion(raw: unknown): string {
  if (typeof raw !== 'string') {
    return DEFAULT_ENGINE_VERSION;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : DEFAULT_ENGINE_VERSION;
}

// getConfiguration('kbengine') 段内的键名(不带 kbengine. 前缀)
const ENGINE_VERSION_SETTING_KEY = 'engineVersion';

/** 容错读取:注入 ConfigReader(装配层=vscode.workspace.getConfiguration('kbengine')) */
export function readEngineVersion(reader: ConfigReader): string {
  return normalizeEngineVersion(reader.get<string>(ENGINE_VERSION_SETTING_KEY, DEFAULT_ENGINE_VERSION));
}

/** 真装配读取口:每次现读,不做缓存失效(kodeCoreGateWiring 同款口径) */
export function getEngineVersion(): string {
  return readEngineVersion(vscode.workspace.getConfiguration('kbengine'));
}

/** 是否命中常见预设(不在表内的自由串合法,调用方自行决定是否提示) */
export function isKnownEnginePreset(version: string): boolean {
  return ENGINE_VERSION_PRESETS.some(preset => preset.value === version);
}

/** 内部变更事件监听器:收到归一后的当前版本值 */
export type EngineVersionListener = (version: string) => void;

const engineVersionListeners = new Set<EngineVersionListener>();

/** 订阅内部变更事件(仓内 diffLog.subscribe 同款返回可 dispose 句柄) */
export function onEngineVersionChanged(listener: EngineVersionListener): { dispose(): void } {
  engineVersionListeners.add(listener);
  return {
    dispose: (): void => {
      engineVersionListeners.delete(listener);
    }
  };
}

function fireEngineVersionChanged(version: string): void {
  for (const listener of [...engineVersionListeners]) {
    listener(version);
  }
}

/**
 * 变更联动装配:精确监听 kbengine.engineVersion,命中即现读新值向内部
 * 事件播报。句柄入 context.subscriptions;dispose 同时撤 vscode 订阅与
 * 内部监听器,重复装配不留脏监听。
 */
export function watchEngineVersion(subscriptions: { push(disposable: unknown): void }): void {
  const configWatcher = vscode.workspace.onDidChangeConfiguration(event => {
    if (event.affectsConfiguration(ENGINE_VERSION_SETTING)) {
      fireEngineVersionChanged(getEngineVersion());
    }
  });
  subscriptions.push({
    dispose: (): void => {
      configWatcher.dispose();
      engineVersionListeners.clear();
    }
  });
}
