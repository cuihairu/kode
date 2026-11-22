import { beforeEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import {
  HOT_RELOAD_SETTINGS_PANEL_COMMAND,
  HOT_RELOAD_SETTINGS_FORM_KEYS,
  renderHotReloadSettingsPanelHtml,
  setupHotReloadSettingsPanel,
  validateHotReloadSettingsValues
} from '../src/hotReloadSettingsPanel';
import type { HotReloadSettings } from '../src/hotReload';
import { panelRegistry, windowState, workspaceState } from './helpers/vscodeStub';

// RUST-378(HR-UI-005)配置界面批:设置表单面板(表单字段与当前设置一致/host
// 侧验证写入口/点串键逐键写盘不覆盖兄弟键/非法值如实报字段名不写盘)。

const baseSettings = (overrides: Partial<HotReloadSettings> = {}): HotReloadSettings => ({
  enabled: true,
  actionName: 'hot_reload',
  globs: ['**/*.py'],
  globsSpec: 'explicit',
  debounceMs: 150,
  triggerMode: 'onSave',
  stabilityWindowMs: 0,
  syntaxGate: true,
  batchFlushMs: 0,
  batchPreviewThreshold: 50,
  sendViaProviders: true,
  allowRootLevelStem: false,
  ...overrides
});

const validValues = {
  enabled: false,
  triggerMode: 'onDiskChange',
  debounceMs: 300,
  syntaxGate: false,
  sendViaProviders: true,
  allowRootLevelStem: true,
  batchFlushMs: 200,
  batchPreviewThreshold: 10,
  stabilityWindowMs: 500
};

const contextOf = (): vscode.ExtensionContext =>
  ({ subscriptions: [] as Array<{ dispose(): void }> } as unknown as vscode.ExtensionContext);

/** 与装配面同源写法:点串键单键 update(不覆盖兄弟键);无 folder=全局 */
const saveThroughRealConfig = (key: string, value: unknown): vscode.Thenable<void> =>
  vscode.workspace
    .getConfiguration('kbengine')
    .update(
      `hotReload.${key}`,
      value,
      (vscode.workspace.workspaceFolders ?? []).length > 0
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global
    );

beforeEach(() => {
  windowState.reset();
  panelRegistry.reset();
});

describe('RUST-378 设置表单渲染', () => {
  it('表单字段齐(九键)且当前值一致(勾选/数值/枚举)', () => {
    const html = renderHotReloadSettingsPanelHtml({ settings: baseSettings() });
    for (const key of HOT_RELOAD_SETTINGS_FORM_KEYS) {
      expect(html, `字段 ${key} 缺` ).toContain(`id="f-${key}"`);
    }
    // 开=勾选;关=不勾选
    expect(html).toContain('id="f-enabled" checked');
    expect(html).not.toContain('id="f-allowRootLevelStem" checked');
    // 数值原样带出
    expect(html).toContain('id="f-debounceMs" value="150"');
    expect(html).toContain('id="f-batchPreviewThreshold" value="50"');
    // 监听模式枚举按当前值选中
    expect(html).toContain('<option value="onSave" selected>');
    expect(html).toContain('<option value="onDiskChange">');
  });

  it('渲染如实:另一组设置(关/磁盘变更)字段值随之变', () => {
    const html = renderHotReloadSettingsPanelHtml({
      settings: baseSettings({ enabled: false, triggerMode: 'onDiskChange', debounceMs: 250 })
    });
    expect(html).not.toContain('id="f-enabled" checked');
    expect(html).toContain('id="f-debounceMs" value="250"');
    expect(html).toContain('<option value="onDiskChange" selected>');
    expect(html).toContain('<option value="onSave">');
  });

  it('状态条按语义上色(已保存=ok,错误=error,空=无)', () => {
    expect(renderHotReloadSettingsPanelHtml({ settings: baseSettings(), note: '已保存' })).toContain(
      'class="ok">已保存'
    );
    expect(renderHotReloadSettingsPanelHtml({ settings: baseSettings(), note: '去抖(ms)须为非负整数' })).toContain(
      'class="error">去抖(ms)须为非负整数'
    );
    expect(renderHotReloadSettingsPanelHtml({ settings: baseSettings() })).toContain('<span id="status" class="">');
  });
});

describe('RUST-378 host 侧验证(不信任 webview)', () => {
  it('合法值全收(逐键原样)', () => {
    const verdict = validateHotReloadSettingsValues(validValues);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.values).toEqual(validValues);
    }
  });

  it('布尔写坏如实报字段名(不猜默认)', () => {
    const verdict = validateHotReloadSettingsValues({ ...validValues, enabled: 'true' });
    expect(verdict).toEqual({ ok: false, error: '启用自动更新须为开关' });
  });

  it('数值写坏如实报字段名(负数/非整数/非数值)', () => {
    expect(validateHotReloadSettingsValues({ ...validValues, debounceMs: -1 })).toEqual({
      ok: false,
      error: '去抖(ms)须为非负整数'
    });
    expect(validateHotReloadSettingsValues({ ...validValues, batchFlushMs: 1.5 })).toEqual({
      ok: false,
      error: '波次冲口(ms)须为非负整数'
    });
    expect(validateHotReloadSettingsValues({ ...validValues, stabilityWindowMs: '500' })).toEqual({
      ok: false,
      error: '写入稳定窗(ms)须为非负整数'
    });
  });

  it('监听模式枚举外如实报;整体非对象如实报', () => {
    expect(validateHotReloadSettingsValues({ ...validValues, triggerMode: 'whenever' })).toEqual({
      ok: false,
      error: '监听模式须为 onSave 或 onDiskChange'
    });
    expect(validateHotReloadSettingsValues('nope')).toEqual({ ok: false, error: '配置值非对象' });
    expect(validateHotReloadSettingsValues(undefined)).toEqual({ ok: false, error: '配置值非对象' });
  });
});

describe('RUST-378 面板装配', () => {
  const openPanel = (): ReturnType<typeof panelRegistry.create> => {
    expect(panelRegistry.panels.length).toBe(0);
    void vscode.commands.executeCommand(HOT_RELOAD_SETTINGS_PANEL_COMMAND);
    expect(panelRegistry.panels.length).toBe(1);
    return panelRegistry.panels[0];
  };

  it('保存:合法值逐键写盘点串键(不覆盖兄弟键)+回执 saved', async () => {
    setupHotReloadSettingsPanel(contextOf(), {
      readSettings: () => baseSettings(),
      save: (key, value) => saveThroughRealConfig(key, value)
    });
    const panel = openPanel();
    panelRegistry.fireMessage(panel, { type: 'save', values: validValues });
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    const updates = workspaceState.workspaceConfigurationUpdates.map(u => ({ key: u.key, value: u.value }));
    expect(updates).toEqual(
      expect.arrayContaining([
        { key: 'kbengine.hotReload.enabled', value: false },
        { key: 'kbengine.hotReload.triggerMode', value: 'onDiskChange' },
        { key: 'kbengine.hotReload.debounceMs', value: 300 },
        { key: 'kbengine.hotReload.stabilityWindowMs', value: 500 }
      ])
    );
    expect(updates).toHaveLength(HOT_RELOAD_SETTINGS_FORM_KEYS.length);
    // 兄弟键(globs/actionName)不被本次保存触碰
    expect(workspaceState.workspaceConfigurationUpdates.map(u => u.key)).not.toContain('kbengine.hotReload.globs');
    expect(panel.webview.postedMessages).toEqual([{ message: { type: 'saved' } }]);
  });

  it('保存:写坏值零写盘+回执字段名错误', async () => {
    const writes: Array<{ key: string; value: unknown }> = [];
    setupHotReloadSettingsPanel(contextOf(), {
      readSettings: () => baseSettings(),
      save: (key, value) => {
        writes.push({ key, value });
      }
    });
    const panel = openPanel();
    panelRegistry.fireMessage(panel, { type: 'save', values: { ...validValues, syntaxGate: 'yes' } });
    await Promise.resolve();
    expect(writes).toEqual([]);
    expect(panel.webview.postedMessages).toEqual([
      { message: { type: 'error', message: '语法检查须为开关' } }
    ]);
  });

  it('取消:关闭面板且零写盘', () => {
    const writes: Array<{ key: string; value: unknown }> = [];
    setupHotReloadSettingsPanel(contextOf(), {
      readSettings: () => baseSettings(),
      save: (key, value) => {
        writes.push({ key, value });
      }
    });
    const panel = openPanel();
    panelRegistry.fireMessage(panel, { type: 'cancel' });
    expect(panel.disposed).toBe(true);
    expect(writes).toEqual([]);
  });

  it('重复打开:复用既有面板(不另开)', () => {
    setupHotReloadSettingsPanel(contextOf(), { readSettings: () => baseSettings(), save: () => undefined });
    openPanel();
    void vscode.commands.executeCommand(HOT_RELOAD_SETTINGS_PANEL_COMMAND);
    expect(panelRegistry.panels.length).toBe(1);
    expect(panelRegistry.panels[0].revealed).toBe(true);
  });
});
