import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import * as vscode from 'vscode';
import {
  HOT_RELOAD_SETTINGS_PANEL_COMMAND,
  HOT_RELOAD_SETTINGS_FORM_KEYS,
  renderHotReloadSettingsPanelHtml,
  setupHotReloadSettingsPanel,
  validateHotReloadSettingsValues
} from '../src/hotReloadSettingsPanel';
import type { HotReloadSettings } from '../src/hotReload';
import { htmlLang, strings } from '../src/webviewStrings';
import { panelRegistry, windowState, workspaceState } from './helpers/vscodeStub';

// RUST-378(HR-UI-005)配置界面批:设置表单面板(表单字段与当前设置一致/host
// 侧验证写入口/点串键逐键写盘不覆盖兄弟键/非法值如实报字段名不写盘)。
// RUST-384 批B:面板文案走 webviewStrings(注入 t/lang),两态断言(zh 默认/en)。

const t = strings('zh').hotReloadSettings;
const tEn = strings('en').hotReloadSettings;
const render = (opts: Parameters<typeof renderHotReloadSettingsPanelHtml>[0]): string =>
  renderHotReloadSettingsPanelHtml({ t, lang: htmlLang('zh'), ...opts });
const validate = (values: unknown): ReturnType<typeof validateHotReloadSettingsValues> =>
  validateHotReloadSettingsValues(values, t);

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
  notify: 'errors',
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
  stabilityWindowMs: 500,
  notify: 'errors'
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
  it('表单字段齐(十键)且当前值一致(勾选/数值/枚举)', () => {
    const html = render({ settings: baseSettings() });
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
    // 通知模式枚举按当前值选中(RUST-386)
    expect(html).toContain('<option value="errors" selected>');
    expect(html).toContain('<option value="silent">');
    expect(html).toContain('<option value="summary">');
  });

  it('渲染如实:另一组设置(关/磁盘变更)字段值随之变', () => {
    const html = render({
      settings: baseSettings({
        enabled: false,
        triggerMode: 'onDiskChange',
        debounceMs: 250,
        notify: 'summary'
      })
    });
    expect(html).not.toContain('id="f-enabled" checked');
    expect(html).toContain('id="f-debounceMs" value="250"');
    expect(html).toContain('<option value="onDiskChange" selected>');
    expect(html).toContain('<option value="onSave">');
    expect(html).toContain('<option value="summary" selected>');
    expect(html).toContain('<option value="errors">');
  });

  it('状态条按语义上色(已保存=ok,错误=error,空=无)', () => {
    expect(render({ settings: baseSettings(), note: t.saved, noteState: 'ok' })).toContain(
      `class="ok">${t.saved}`
    );
    expect(render({ settings: baseSettings(), note: t.errMustBeNonNegativeInt(t.debounceMs), noteState: 'error' })).toContain(
      `class="error">${t.errMustBeNonNegativeInt(t.debounceMs)}`
    );
    expect(render({ settings: baseSettings() })).toContain(
      '<span id="status" role="status" aria-live="polite" class="">'
    );
  });

  it('RUST-384 批B:en 注入渲染英文(标题/按钮/字段/状态串),zh 默认中文(两态)', () => {
    const enHtml = renderHotReloadSettingsPanelHtml({
      settings: baseSettings(),
      t: tEn,
      lang: htmlLang('en')
    });
    expect(enHtml).toContain('<html lang="en">');
    expect(enHtml).toContain('<h2>Hot Reload Settings</h2>');
    expect(enHtml).toContain('> Enable hot reload</label>');
    expect(enHtml).toContain('>Save</button>');
    expect(enHtml).toContain("status.textContent = \"Saved\";");
    expect(enHtml).not.toContain('启用自动更新');
    expect(render({ settings: baseSettings() })).toContain('<html lang="zh-CN">');
    expect(render({ settings: baseSettings() })).toContain(`<h2>${t.title}</h2>`);
  });

  it('RUST-386:通知模式枚举两态(zh 默认中文/en 英文;按当前值选中)', () => {
    const enHtml = renderHotReloadSettingsPanelHtml({
      settings: baseSettings({ notify: 'silent' }),
      t: tEn,
      lang: htmlLang('en')
    });
    expect(enHtml).toContain('<span>Notification mode</span>');
    expect(enHtml).toContain('>All silent (silent)</option>');
    expect(enHtml).toContain('<option value="silent" selected>');
    const zhHtml = render({ settings: baseSettings({ notify: 'summary' }) });
    expect(zhHtml).toContain(`<span>${t.notify}</span>`);
    expect(zhHtml).toContain('>批量摘要(summary)</option>');
    expect(zhHtml).toContain('<option value="summary" selected>');
  });

  it('RUST-384 批B:校验错误文案经 t(en/zh 两态)', () => {
    expect(validateHotReloadSettingsValues({ ...validValues, enabled: 'true' }, tEn)).toEqual({
      ok: false,
      error: tEn.errMustBeSwitch(tEn.enabled)
    });
    expect(validateHotReloadSettingsValues('nope', tEn)).toEqual({
      ok: false,
      error: tEn.errNotObject
    });
  });
});

describe('RUST-378 host 侧验证(不信任 webview)', () => {
  it('合法值全收(逐键原样)', () => {
    const verdict = validate(validValues);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.values).toEqual(validValues);
    }
  });

  it('布尔写坏如实报字段名(不猜默认)', () => {
    const verdict = validate({ ...validValues, enabled: 'true' });
    expect(verdict).toEqual({ ok: false, error: t.errMustBeSwitch(t.enabled) });
  });

  it('数值写坏如实报字段名(负数/非整数/非数值)', () => {
    expect(validate({ ...validValues, debounceMs: -1 })).toEqual({
      ok: false,
      error: t.errMustBeNonNegativeInt(t.debounceMs)
    });
    expect(validate({ ...validValues, batchFlushMs: 1.5 })).toEqual({
      ok: false,
      error: t.errMustBeNonNegativeInt(t.batchFlushMs)
    });
    expect(validate({ ...validValues, stabilityWindowMs: '500' })).toEqual({
      ok: false,
      error: t.errMustBeNonNegativeInt(t.stabilityWindowMs)
    });
  });

  it('监听模式枚举外如实报;整体非对象如实报', () => {
    expect(validate({ ...validValues, triggerMode: 'whenever' })).toEqual({
      ok: false,
      error: t.errTriggerMode(t.triggerMode)
    });
    expect(validate('nope')).toEqual({ ok: false, error: t.errNotObject });
    expect(validate(undefined)).toEqual({ ok: false, error: t.errNotObject });
  });

  it('RUST-386:通知模式枚举外如实报字段名;三值原样收', () => {
    expect(validate({ ...validValues, notify: 'loud' })).toEqual({
      ok: false,
      error: t.errNotify(t.notify)
    });
    for (const mode of ['silent', 'errors', 'summary'] as const) {
      const verdict = validate({ ...validValues, notify: mode });
      expect(verdict.ok).toBe(true);
      if (verdict.ok) {
        expect(verdict.values.notify).toBe(mode);
      }
    }
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
      { message: { type: 'error', message: t.errMustBeSwitch(t.syntaxGate) } }
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

describe('RUST-384 设置面板无障碍面', () => {
  it('状态条=live 区(screen reader 播报保存/校验结果)', () => {
    const html = render({ settings: baseSettings(), note: t.saved, noteState: 'ok' });
    expect(html).toContain('<span id="status" role="status" aria-live="polite"');
  });
});

describe('RUST-384 热更快捷键(package.json 避撞锁)', () => {
  interface Pkg {
    contributes: {
      keybindings: Array<{ command: string; key?: string; mac?: string; when?: string }>;
    };
  }
  const pkg = JSON.parse(
    readFileSync(join(__dirname, '..', 'package.json'), 'utf8')
  ) as Pkg;
  const bindingOf = (command: string): { key?: string; mac?: string; when?: string } | undefined =>
    pkg.contributes.keybindings.find(entry => entry.command === command);

  it('三命令默认键位齐(ctrl+alt+p/l/s),无收窄 when', () => {
    const cases: Array<[string, string, string]> = [
      ['kbengine.hotReload.historyPanel', 'ctrl+alt+p', 'cmd+alt+p'],
      ['kbengine.hotReload.showDiagnostics', 'ctrl+alt+l', 'cmd+alt+l'],
      ['kbengine.hotReload.settingsPanel', 'ctrl+alt+s', 'cmd+alt+s']
    ];
    for (const [command, key, mac] of cases) {
      const binding = bindingOf(command);
      expect(binding, `${command} 缺默认键位`).toBeDefined();
      expect(binding!.key, `${command} 键位不符`).toBe(key);
      expect(binding!.mac).toBe(mac);
      expect(binding!.when).toBeUndefined();
    }
  });

  it('新键位不撞仓库既有/文档既占键位(避撞锁)', () => {
    // 文档示例键位(配置指南 kbengine.httpRequest.run)、telnet 面板键位、
    // 通道配置键位、python 编辑器命令键位
    const occupied = [
      'ctrl+alt+h',
      'ctrl+]',
      'ctrl+d',
      'ctrl+alt+r',
      'ctrl+alt+shift+c',
      'ctrl+alt+shift+b'
    ];
    for (const command of ['kbengine.hotReload.historyPanel', 'kbengine.hotReload.showDiagnostics', 'kbengine.hotReload.settingsPanel']) {
      expect(occupied, `${command} 键位撞既有键位`).not.toContain(bindingOf(command)!.key);
      expect(['ctrl+alt+h', 'ctrl+]', 'ctrl+d', 'ctrl+alt+r']).not.toContain(bindingOf(command)!.mac);
    }
  });
});
