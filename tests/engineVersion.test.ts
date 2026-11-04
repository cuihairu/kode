import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_ENGINE_VERSION,
  ENGINE_VERSION_PRESETS,
  ENGINE_VERSION_SETTING,
  getEngineVersion,
  isKnownEnginePreset,
  normalizeEngineVersion,
  onEngineVersionChanged,
  readEngineVersion,
  watchEngineVersion
} from '../src/engineVersion';
import {
  configurationOverrides,
  workspaceEvents
} from './helpers/vscodeStub';

// KB-VER-001(todo.md「版本感知」):kbengine.engineVersion 设置读取链。
// 默认 3.7.3;魔改 fork 自由串;变更经 ConfigurationChangeEvent 命中精确键
// 后向内部事件播报。vscode 侧用仓内 fake 替身驱动(workspaceState 配置
// 覆写 + configurationChanged 事件)。

const readerOf = (values: Record<string, unknown>): {
  get: <T>(key: string, defaultValue: T) => T;
} => ({ get: <T>(key: string, defaultValue: T): T => (values[key] as T) ?? defaultValue });

beforeEach(() => {
  configurationOverrides.clear();
});

afterEach(() => {
  configurationOverrides.clear();
});

describe('readEngineVersion(默认值与畸形值回落)', () => {
  it('全部缺省:回落默认 3.7.3', () => {
    expect(readEngineVersion(readerOf({}))).toBe('3.7.3');
    expect(DEFAULT_ENGINE_VERSION).toBe('3.7.3');
  });

  it('合法自由串原样回显(官方版本与 fork 版本都收)', () => {
    expect(readEngineVersion(readerOf({ engineVersion: '3.7.2' }))).toBe('3.7.2');
    expect(readEngineVersion(readerOf({ engineVersion: 'fork-3.12' }))).toBe('fork-3.12');
  });

  it('空串/纯空白回落默认', () => {
    expect(readEngineVersion(readerOf({ engineVersion: '' }))).toBe('3.7.3');
    expect(readEngineVersion(readerOf({ engineVersion: '   ' }))).toBe('3.7.3');
  });

  it('类型错回落默认:数字/对象/布尔都不当版本串', () => {
    expect(readEngineVersion(readerOf({ engineVersion: 3.12 }))).toBe('3.7.3');
    expect(readEngineVersion(readerOf({ engineVersion: { major: 3 } }))).toBe('3.7.3');
    expect(readEngineVersion(readerOf({ engineVersion: true }))).toBe('3.7.3');
  });

  it('normalizeEngineVersion:trim 首尾空白但保留内部字符', () => {
    expect(normalizeEngineVersion('  fork-3.12  ')).toBe('fork-3.12');
    expect(normalizeEngineVersion(undefined)).toBe('3.7.3');
    expect(normalizeEngineVersion(null)).toBe('3.7.3');
  });
});

describe('getEngineVersion(真装配读取口)', () => {
  it('无覆写时读到默认值', () => {
    expect(getEngineVersion()).toBe('3.7.3');
  });

  it('经 kbengine 配置段覆写后读到设置值(容错口径同链)', () => {
    configurationOverrides.set('kbengine', { engineVersion: 'fork-3.12' });
    expect(getEngineVersion()).toBe('fork-3.12');
    configurationOverrides.set('kbengine', { engineVersion: '' });
    expect(getEngineVersion()).toBe('3.7.3');
  });
});

describe('预设常量表(未来 quick pick 数据源,本任务不建 UI)', () => {
  it('默认值在预设表内且首个预设即默认', () => {
    expect(isKnownEnginePreset('3.7.3')).toBe(true);
    expect(ENGINE_VERSION_PRESETS[0]?.value).toBe('3.7.3');
  });

  it('覆盖官方稳定线与 fork 示例', () => {
    const values = ENGINE_VERSION_PRESETS.map(preset => preset.value);
    expect(values).toContain('3.7.2');
    expect(values).toContain('fork-3.12');
    // value 无重复(quick pick 去重前置条件)
    expect(new Set(values).size).toBe(values.length);
    // 每条都有 label/detail(面板行必需字段)
    for (const preset of ENGINE_VERSION_PRESETS) {
      expect(preset.label.length).toBeGreaterThan(0);
      expect(preset.detail.length).toBeGreaterThan(0);
    }
  });

  it('表外自由串合法但不命中预设', () => {
    expect(isKnownEnginePreset('my-fork-9.9')).toBe(false);
  });
});

describe('watchEngineVersion(ConfigurationChangeEvent 联动)', () => {
  it('命中 kbengine.engineVersion 的变更向内部事件播报新值', () => {
    const subscriptions: Array<{ dispose(): void }> = [];
    watchEngineVersion(subscriptions);
    const listener = vi.fn();
    const unsubscribe = onEngineVersionChanged(listener);
    try {
      configurationOverrides.set('kbengine', { engineVersion: '3.7.2' });
      workspaceEvents.configurationChanged.fire({
        affectsConfiguration: section => section === ENGINE_VERSION_SETTING
      });
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith('3.7.2');
    } finally {
      unsubscribe.dispose();
      for (const handle of [...subscriptions]) {
        handle.dispose();
      }
    }
  });

  it('其他键的变更不播报(affectsConfiguration 未命中精确键)', () => {
    const subscriptions: Array<{ dispose(): void }> = [];
    watchEngineVersion(subscriptions);
    const listener = vi.fn();
    const unsubscribe = onEngineVersionChanged(listener);
    try {
      workspaceEvents.configurationChanged.fire({
        affectsConfiguration: section => section === 'kbengine.hotReload.actionName'
      });
      expect(listener).not.toHaveBeenCalled();
    } finally {
      unsubscribe.dispose();
      for (const handle of [...subscriptions]) {
        handle.dispose();
      }
    }
  });

  it('播报值走容错归一:设置改成空串时收到默认值', () => {
    const subscriptions: Array<{ dispose(): void }> = [];
    watchEngineVersion(subscriptions);
    const listener = vi.fn();
    const unsubscribe = onEngineVersionChanged(listener);
    try {
      configurationOverrides.set('kbengine', { engineVersion: '   ' });
      workspaceEvents.configurationChanged.fire({
        affectsConfiguration: () => true
      });
      expect(listener).toHaveBeenCalledWith('3.7.3');
    } finally {
      unsubscribe.dispose();
      for (const handle of [...subscriptions]) {
        handle.dispose();
      }
    }
  });

  it('dispose 撤内部监听器:dispose 后不再收到播报', () => {
    const subscriptions: Array<{ dispose(): void }> = [];
    watchEngineVersion(subscriptions);
    const listener = vi.fn();
    const unsubscribe = onEngineVersionChanged(listener);
    unsubscribe.dispose();
    workspaceEvents.configurationChanged.fire({
      affectsConfiguration: () => true
    });
    expect(listener).not.toHaveBeenCalled();
    for (const handle of [...subscriptions]) {
      handle.dispose();
    }
  });
});
