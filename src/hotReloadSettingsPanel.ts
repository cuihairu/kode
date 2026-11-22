//! RUST-378(HR-UI-005)配置界面批:热更设置表单面板(webview 单列,沿用
//! HR-UI-004 既有 createWebviewPanel 模式,不新造框架)。
//!
//! - **表单面**:编辑工作区设置键族(启用/监听模式/去抖/语法检查/经 Provider
//!   发送/根下单层回退/波次冲口/批量预览阈值/写入稳定窗)。channel 面
//!   (root/target/网络超时)由既有 kbengine.hotReload.configureChannel 覆
//!   盖,本面板不重复;「敏感操作警告」无对应设置键,工作区信任闸
//!   (HR-HTTP-005/RUST-422)是既有安全门,不新造键。
//! - **校验**:host 侧 validateHotReloadSettingsValues 全量验证 webview 传回
//!   值(布尔真布尔/数值有限非负/枚举在表),非法如实报字段名不写盘——
//!   不信任 webview,与 hotReloadSectionReader 容忍式读同源但更严(表单
//!   是写入口,写坏要当场指正)。
//! - **写盘**:点串键单键 update('hotReload.<key>', value, target),target=
//!   工作区(有 folder)或全局(无 folder),与既有 materializeGlobs 写口径
//!   同源——不覆盖同段兄弟键。
//! - **渲染纯函数化**(render/validate 可独立断言),vscode 面只留薄壳。
//! - **i18n(RUST-384 批B)**:面板全部文案(含校验错误/按钮/JS 状态串)走
//!   既有 webviewStrings 表(strings(locale).hotReloadSettings),纯渲染
//!   函数由装配面注入 t/lang,不依赖 vscode——与其余 9 个 webview 面板
//!   同机制,不新造轮子。

import * as vscode from 'vscode';
import type { HotReloadSettings } from './hotReload';
import { htmlLang, resolvePanelLocale, strings, type WebviewStrings } from './webviewStrings';

/** RUST-378 设置面板命令 */
export const HOT_RELOAD_SETTINGS_PANEL_COMMAND = 'kbengine.hotReload.settingsPanel';

/** 表单可编辑的设置键(与 render 表单字段一一对应;globs/actionName 走
 *  VS Code 设置面不重复,channel 面走 configureChannel) */
export const HOT_RELOAD_SETTINGS_FORM_KEYS = [
  'enabled',
  'triggerMode',
  'debounceMs',
  'syntaxGate',
  'sendViaProviders',
  'allowRootLevelStem',
  'batchFlushMs',
  'batchPreviewThreshold',
  'stabilityWindowMs',
  'notify'
] as const;

export type HotReloadSettingsFormKey = (typeof HOT_RELOAD_SETTINGS_FORM_KEYS)[number];

/** 面板文案类型(webviewStrings.hotReloadSettings;装配面注入,渲染纯) */
export type HotReloadSettingsPanelStrings = WebviewStrings['hotReloadSettings'];

/** 表单保存值(host 验证后的形状;webview 传回的是 unknown,须过验证) */
export interface HotReloadSettingsSaveValues {
  readonly enabled: boolean;
  readonly triggerMode: string;
  readonly debounceMs: number;
  readonly syntaxGate: boolean;
  readonly sendViaProviders: boolean;
  readonly allowRootLevelStem: boolean;
  readonly batchFlushMs: number;
  readonly batchPreviewThreshold: number;
  readonly stabilityWindowMs: number;
  readonly notify: string;
}

/** 验证结果:ok=true 携带已验证值;ok=false 携带如实字段错误 */
export type HotReloadSettingsValidation =
  | { readonly ok: true; readonly values: HotReloadSettingsSaveValues }
  | { readonly ok: false; readonly error: string };

const isFiniteNonNegative = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** RUST-378 host 侧验证(不信任 webview):布尔真布尔、数值有限非负整数、
 *  枚举在表;非法如实报字段名,不猜默认。错误文案经 t(注入,双语)。 */
export function validateHotReloadSettingsValues(
  values: unknown,
  t: HotReloadSettingsPanelStrings
): HotReloadSettingsValidation {
  if (typeof values !== 'object' || values === null) {
    return { ok: false, error: t.errNotObject };
  }
  const v = values as Record<string, unknown>;
  const labels: Record<HotReloadSettingsFormKey, string> = {
    enabled: t.enabled,
    triggerMode: t.triggerMode,
    debounceMs: t.debounceMs,
    syntaxGate: t.syntaxGate,
    sendViaProviders: t.sendViaProviders,
    allowRootLevelStem: t.allowRootLevelStem,
    batchFlushMs: t.batchFlushMs,
    batchPreviewThreshold: t.batchPreviewThreshold,
    stabilityWindowMs: t.stabilityWindowMs,
    notify: t.notify
  };
  for (const key of ['enabled', 'syntaxGate', 'sendViaProviders', 'allowRootLevelStem'] as const) {
    if (typeof v[key] !== 'boolean') {
      return { ok: false, error: t.errMustBeSwitch(labels[key]) };
    }
  }
  for (const key of ['debounceMs', 'batchFlushMs', 'batchPreviewThreshold', 'stabilityWindowMs'] as const) {
    if (!isFiniteNonNegative(v[key]) || !Number.isInteger(v[key])) {
      return { ok: false, error: t.errMustBeNonNegativeInt(labels[key]) };
    }
  }
  if (v.triggerMode !== 'onSave' && v.triggerMode !== 'onDiskChange') {
    return { ok: false, error: t.errTriggerMode(labels.triggerMode) };
  }
  if (v.notify !== 'silent' && v.notify !== 'errors' && v.notify !== 'summary') {
    return { ok: false, error: t.errNotify(labels.notify) };
  }
  return {
    ok: true,
    values: {
      enabled: v.enabled as boolean,
      triggerMode: v.triggerMode as string,
      debounceMs: v.debounceMs as number,
      syntaxGate: v.syntaxGate as boolean,
      sendViaProviders: v.sendViaProviders as boolean,
      allowRootLevelStem: v.allowRootLevelStem as boolean,
      batchFlushMs: v.batchFlushMs as number,
      batchPreviewThreshold: v.batchPreviewThreshold as number,
      stabilityWindowMs: v.stabilityWindowMs as number,
      notify: v.notify as string
    }
  };
}

const esc = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** RUST-378 设置表单渲染(纯;字段值与当前设置一致;note=状态条(空=无;
 *  noteState=语义着色,不靠中文前缀猜)。t/lang 由装配面注入(双语)。 */
export function renderHotReloadSettingsPanelHtml(opts: {
  settings: HotReloadSettings;
  note?: string;
  noteState?: 'ok' | 'error';
  t: HotReloadSettingsPanelStrings;
  lang: string;
}): string {
  const s = opts.settings;
  const t = opts.t;
  const note = opts.note ?? '';
  const noteClass = opts.noteState === 'ok' ? 'ok' : opts.noteState === 'error' ? 'error' : '';
  const checkbox = (key: HotReloadSettingsFormKey, value: boolean, label: string): string =>
    `<label class="field"><input type="checkbox" id="f-${key}" ${value ? 'checked' : ''}> ${esc(label)}</label>`;
  const numberInput = (key: HotReloadSettingsFormKey, value: number, label: string): string =>
    `<label class="field"><span>${esc(label)}</span><input type="number" id="f-${key}" value="${value}" min="0" step="1"></label>`;
  const selectOption = (value: string, label: string, selected: boolean): string =>
    `<option value="${value}"${selected ? ' selected' : ''}>${label}</option>`;
  return `<!DOCTYPE html>
<html lang="${opts.lang}">
<head>
<meta charset="utf-8">
<style>
body { font-family: var(--vscode-font-family); padding: 12px; color: var(--vscode-foreground); }
h2 { font-size: 1.1em; margin: 0 0 8px; }
.field { display: block; margin: 6px 0; }
.field input[type="number"] { width: 120px; }
select { padding: 2px 4px; }
.actions { margin-top: 12px; display: flex; gap: 8px; align-items: center; }
button { padding: 4px 12px; }
#status { margin-left: 8px; }
#status.error { color: var(--vscode-errorForeground, #f14c4c); }
#status.ok { color: var(--vscode-charts-green, #2e7d32); }
</style>
</head>
<body>
<h2>${esc(t.title)}</h2>
<form id="cfg">
${checkbox('enabled', s.enabled, t.enabled)}
<label class="field"><span>${esc(t.triggerMode)}</span>
<select id="f-triggerMode">
  ${selectOption('onSave', t.triggerOnSave, s.triggerMode === 'onSave')}
  ${selectOption('onDiskChange', t.triggerOnDiskChange, s.triggerMode === 'onDiskChange')}
</select></label>
${numberInput('debounceMs', s.debounceMs, t.debounceMs)}
${checkbox('syntaxGate', s.syntaxGate, t.syntaxGate)}
${checkbox('sendViaProviders', s.sendViaProviders, t.sendViaProviders)}
${checkbox('allowRootLevelStem', s.allowRootLevelStem, t.allowRootLevelStem)}
${numberInput('batchFlushMs', s.batchFlushMs, t.batchFlushMs)}
${numberInput('batchPreviewThreshold', s.batchPreviewThreshold, t.batchPreviewThreshold)}
${numberInput('stabilityWindowMs', s.stabilityWindowMs, t.stabilityWindowMs)}
<label class="field"><span>${esc(t.notify)}</span>
<select id="f-notify">
  ${selectOption('silent', t.notifySilent, s.notify === 'silent')}
  ${selectOption('errors', t.notifyErrors, s.notify === 'errors')}
  ${selectOption('summary', t.notifySummary, s.notify === 'summary')}
</select></label>
<div class="actions">
  <button type="button" id="btn-save">${esc(t.save)}</button>
  <button type="button" id="btn-cancel">${esc(t.cancel)}</button>
  <span id="status" role="status" aria-live="polite" class="${noteClass}">${esc(note)}</span>
</div>
</form>
<script>
(function() {
  const vscode = acquireVsCodeApi();
  const send = () => {
    const values = {
      enabled: document.getElementById('f-enabled').checked,
      triggerMode: document.getElementById('f-triggerMode').value,
      debounceMs: Number(document.getElementById('f-debounceMs').value),
      syntaxGate: document.getElementById('f-syntaxGate').checked,
      sendViaProviders: document.getElementById('f-sendViaProviders').checked,
      allowRootLevelStem: document.getElementById('f-allowRootLevelStem').checked,
      batchFlushMs: Number(document.getElementById('f-batchFlushMs').value),
      batchPreviewThreshold: Number(document.getElementById('f-batchPreviewThreshold').value),
      stabilityWindowMs: Number(document.getElementById('f-stabilityWindowMs').value),
      notify: document.getElementById('f-notify').value
    };
    vscode.postMessage({ type: 'save', values });
  };
  document.getElementById('btn-save').addEventListener('click', send);
  document.getElementById('btn-cancel').addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
  window.addEventListener('message', event => {
    const msg = event.data;
    const status = document.getElementById('status');
    if (msg && msg.type === 'saved') {
      status.textContent = ${JSON.stringify(t.saved)};
      status.className = 'ok';
    } else if (msg && msg.type === 'error') {
      status.textContent = msg.message || ${JSON.stringify(t.saveFailed)};
      status.className = 'error';
    }
  });
})();
</script>
</body>
</html>`;
}

/** RUST-378 面板装配:open() 建 webview 表单(读当前设置渲染);保存消息经
 *  host 验证后逐键写盘(点串键 update,不覆盖兄弟键),取消关闭面板。 */
export function setupHotReloadSettingsPanel(
  context: vscode.ExtensionContext,
  deps: {
    readSettings(): HotReloadSettings;
    save(
      key: HotReloadSettingsFormKey,
      value: boolean | number | string
    ): Promise<void> | void | PromiseLike<void>;
  }
): { open(): void } {
  let panel: vscode.WebviewPanel | null = null;
  const render = (note?: string, noteState?: 'ok' | 'error'): void => {
    if (panel === null) {
      return;
    }
    const locale = resolvePanelLocale();
    panel.webview.html = renderHotReloadSettingsPanelHtml({
      settings: deps.readSettings(),
      note,
      noteState,
      t: strings(locale).hotReloadSettings,
      lang: htmlLang(locale)
    });
  };
  const open = (): void => {
    if (panel !== null) {
      panel.reveal();
      render();
      return;
    }
    panel = vscode.window.createWebviewPanel(
      'kbengineHotReloadSettings',
      strings(resolvePanelLocale()).hotReloadSettings.title,
      vscode.ViewColumn.Beside,
      {
        enableScripts: true
      }
    );
    panel.webview.onDidReceiveMessage(
      message => {
        if (panel === null) {
          return;
        }
        if (message?.type === 'save') {
          const t = strings(resolvePanelLocale()).hotReloadSettings;
          const verdict = validateHotReloadSettingsValues(message.values, t);
          if (!verdict.ok) {
            void panel.webview.postMessage({ type: 'error', message: verdict.error });
            return;
          }
          void Promise.all(
            HOT_RELOAD_SETTINGS_FORM_KEYS.map(async key => {
              await deps.save(key, verdict.values[key]);
            })
          ).then(() => {
            void panel?.webview.postMessage({ type: 'saved' });
          });
          return;
        }
        if (message?.type === 'cancel') {
          panel.dispose();
        }
      },
      undefined,
      context.subscriptions
    );
    panel.onDidDispose(() => {
      panel = null;
    }, undefined, context.subscriptions);
    render();
  };
  context.subscriptions.push(vscode.commands.registerCommand(HOT_RELOAD_SETTINGS_PANEL_COMMAND, open));
  return { open };
}
