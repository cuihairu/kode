/**
 * RUST-378 (HR-UI-005):热更配置面板化编辑 UI(表单化界面)。
 * - 纯核渲染 renderHotReloadSettingsFormHtml(零 vscode 零 IO):表单字段直出
 *   当前 kbengine.hotReload.* 的有效值(经 readHotReloadSettings 容忍式读,
 *   类型写坏如实回落默认,与装配同口径——表单所见=装配所用);
 * - 薄控制器 HotReloadSettingsPanel:读配置→渲染→webview「保存/复位」消息
 *   写回(workspaceConfiguration.update,Workspace 作用域;复位=update
 *   undefined 清键回默认);
 * - root/target/网络超时/敏感操作警告不是 package.json 设置键(见 RUST-378
 *   注:配置键族已齐,这些维度由引擎 profile/运行时承担),表单只覆盖既有
 *   HotReloadSettings 字段,诚实不造键不冒充;
 * - webview 入站值不信任:coerceHotReloadSettingsFormValues 逐字段规范化
 *   (类型写坏/越界如实回落,不把 webview 的任意值直接写进配置)。
 */

import * as vscode from 'vscode';
import { randomNonce, webviewScriptCsp, toJsonForScript } from './webviewSecurity';
import {
  HOT_RELOAD_DEFAULT_BATCH_PREVIEW_THRESHOLD,
  HOT_RELOAD_DEFAULT_DEBOUNCE_MS,
  hotReloadSectionReader,
  readHotReloadSettings,
  type ConfigReader,
  type HotReloadSettings,
  type HotReloadTriggerMode
} from './hotReload';

/** 表单值(与 HotReloadSettings 同面,去掉派生的 globsSpec) */
export interface HotReloadSettingsFormValues {
  enabled: boolean;
  actionName: string;
  globs: string[];
  debounceMs: number;
  triggerMode: HotReloadTriggerMode;
  stabilityWindowMs: number;
  syntaxGate: boolean;
  batchFlushMs: number;
  batchPreviewThreshold: number;
  sendViaProviders: boolean;
  allowRootLevelStem: boolean;
}

/** 可写键清单(与表单字段一一对应;复位=逐键 update undefined) */
export const HOT_RELOAD_SETTINGS_WRITABLE_KEYS = [
  'enabled',
  'actionName',
  'globs',
  'debounceMs',
  'triggerMode',
  'stabilityWindowMs',
  'syntaxGate',
  'batchFlushMs',
  'batchPreviewThreshold',
  'sendViaProviders',
  'allowRootLevelStem'
] as const;

export type HotReloadSettingsWritableKey = (typeof HOT_RELOAD_SETTINGS_WRITABLE_KEYS)[number];

/** 有效值投影:表单所见=装配所用(readHotReloadSettings 同口径,零分叉) */
export function toHotReloadSettingsFormValues(settings: HotReloadSettings): HotReloadSettingsFormValues {
  return {
    enabled: settings.enabled,
    actionName: settings.actionName,
    globs: settings.globs,
    debounceMs: settings.debounceMs,
    triggerMode: settings.triggerMode,
    stabilityWindowMs: settings.stabilityWindowMs,
    syntaxGate: settings.syntaxGate,
    batchFlushMs: settings.batchFlushMs,
    batchPreviewThreshold: settings.batchPreviewThreshold,
    sendViaProviders: settings.sendViaProviders,
    allowRootLevelStem: settings.allowRootLevelStem
  };
}

/**
 * 容忍式表单读:缺省走 hotReloadSectionReader(装配同一函数)——
 * 表单所见=装配所用,零分叉;可注入 reader(测试替身)。
 */
export function readHotReloadSettingsFormValues(
  readerFactory: () => ConfigReader = hotReloadSectionReader
): HotReloadSettingsFormValues {
  return toHotReloadSettingsFormValues(readHotReloadSettings(readerFactory()));
}

const isFiniteNonNegativeNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

/**
 * webview 入站值规范化(安全边界):只认已知键,类型/越界如实回落默认,
 * 绝不把 webview 的任意形状直接写进配置。裸对象按白名单逐键取。
 */
export function coerceHotReloadSettingsFormValues(
  raw: unknown,
  fallback: HotReloadSettingsFormValues
): HotReloadSettingsFormValues {
  const input = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const globsRaw = input.globs;
  const globs = Array.isArray(globsRaw)
    ? globsRaw.filter((item): item is string => typeof item === 'string')
    : fallback.globs;
  return {
    enabled: typeof input.enabled === 'boolean' ? input.enabled : fallback.enabled,
    actionName: typeof input.actionName === 'string' ? input.actionName : fallback.actionName,
    globs,
    debounceMs: isFiniteNonNegativeNumber(input.debounceMs)
      ? input.debounceMs
      : fallback.debounceMs,
    triggerMode: input.triggerMode === 'onDiskChange' ? 'onDiskChange' : 'onSave',
    stabilityWindowMs: isFiniteNonNegativeNumber(input.stabilityWindowMs)
      ? input.stabilityWindowMs
      : fallback.stabilityWindowMs,
    syntaxGate: typeof input.syntaxGate === 'boolean' ? input.syntaxGate : fallback.syntaxGate,
    batchFlushMs: isFiniteNonNegativeNumber(input.batchFlushMs)
      ? input.batchFlushMs
      : fallback.batchFlushMs,
    batchPreviewThreshold: isFiniteNonNegativeNumber(input.batchPreviewThreshold)
      ? input.batchPreviewThreshold
      : fallback.batchPreviewThreshold,
    sendViaProviders:
      typeof input.sendViaProviders === 'boolean' ? input.sendViaProviders : fallback.sendViaProviders,
    allowRootLevelStem:
      typeof input.allowRootLevelStem === 'boolean' ? input.allowRootLevelStem : fallback.allowRootLevelStem
  };
}

/** HTML 转义(纯):webview 文本一律转义,不裸插用户串 */
const esc = (text: string): string =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** 表单面标签(与字段对应;装配面由调用方注入,测试用替身) */
export interface HotReloadSettingsFormLabels {
  title: string;
  description: string;
  enabled: string;
  enabledHint: string;
  triggerMode: string;
  onSave: string;
  onDiskChange: string;
  actionName: string;
  actionNameHint: string;
  globs: string;
  globsHint: string;
  debounceMs: string;
  stabilityWindowMs: string;
  syntaxGate: string;
  batchFlushMs: string;
  batchPreviewThreshold: string;
  sendViaProviders: string;
  allowRootLevelStem: string;
  save: string;
  reset: string;
  saved: string;
  resetDone: string;
}

/**
 * 纯渲染:表单 HTML(webview 一次性渲染)。字段直出当前有效值;
 * globs 以逗号分隔文本呈现(数组↔文本仅在 webview/装配边界转换)。
 */
export function renderHotReloadSettingsFormHtml(input: {
  values: HotReloadSettingsFormValues;
  labels: HotReloadSettingsFormLabels;
  nonce: string;
  csp?: string;
}): string {
  const v = input.values;
  const l = input.labels;
  const csp = input.csp ?? webviewScriptCsp(input.nonce);
  const globsText = v.globs.join(', ');
  const numberField = (id: string, label: string, value: number): string => `
      <label for="${id}">${esc(label)}</label>
      <input id="${id}" data-key="${id}" type="number" min="0" value="${value}" />`;
  const checkboxField = (id: string, label: string, checked: boolean): string => `
      <label class="check"><input id="${id}" data-key="${id}" type="checkbox"${
        checked ? ' checked' : ''
      } />${esc(label)}</label>`;
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 16px; }
  h2 { margin: 0 0 4px; font-size: 15px; }
  .desc { color: var(--vscode-descriptionForeground); margin-bottom: 14px; }
  .grid { display: grid; grid-template-columns: 160px 1fr; gap: 10px 12px; align-items: center; }
  label { color: var(--vscode-foreground); }
  label.check { display: inline-flex; gap: 6px; align-items: center; }
  input[type="text"], input[type="number"], select {
    width: 100%; box-sizing: border-box; padding: 4px 6px;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent);
  }
  .hint { color: var(--vscode-descriptionForeground); font-size: 11px; grid-column: 2; margin-top: -6px; }
  .actions { margin-top: 16px; display: flex; gap: 8px; align-items: center; }
  button {
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    border: none; padding: 6px 14px; cursor: pointer;
  }
  button.secondary { background: var(--vscode-button-secondaryBackground, transparent); color: var(--vscode-button-secondaryForeground, var(--vscode-foreground)); }
  #status { color: var(--vscode-descriptionForeground); margin-left: 8px; }
</style>
</head>
<body>
<h2>${esc(l.title)}</h2>
<div class="desc">${esc(l.description)}</div>
<div class="grid">
  ${checkboxField('enabled', l.enabled, v.enabled)}
  <div class="hint">${esc(l.enabledHint)}</div>
  <label for="triggerMode">${esc(l.triggerMode)}</label>
  <select id="triggerMode" data-key="triggerMode">
    <option value="onSave" ${v.triggerMode === 'onSave' ? 'selected' : ''}>${esc(l.onSave)}</option>
    <option value="onDiskChange" ${v.triggerMode === 'onDiskChange' ? 'selected' : ''}>${esc(l.onDiskChange)}</option>
  </select>
  <label for="actionName">${esc(l.actionName)}</label>
  <input id="actionName" data-key="actionName" type="text" value="${esc(v.actionName)}" />
  <div class="hint">${esc(l.actionNameHint)}</div>
  <label for="globs">${esc(l.globs)}</label>
  <input id="globs" data-key="globs" type="text" value="${esc(globsText)}" />
  <div class="hint">${esc(l.globsHint)}</div>
  ${numberField('debounceMs', l.debounceMs, v.debounceMs)}
  ${numberField('stabilityWindowMs', l.stabilityWindowMs, v.stabilityWindowMs)}
  ${numberField('batchFlushMs', l.batchFlushMs, v.batchFlushMs)}
  ${numberField('batchPreviewThreshold', l.batchPreviewThreshold, v.batchPreviewThreshold)}
  ${checkboxField('syntaxGate', l.syntaxGate, v.syntaxGate)}
  ${checkboxField('sendViaProviders', l.sendViaProviders, v.sendViaProviders)}
  ${checkboxField('allowRootLevelStem', l.allowRootLevelStem, v.allowRootLevelStem)}
</div>
<div class="actions">
  <button id="save">${esc(l.save)}</button>
  <button id="reset" class="secondary">${esc(l.reset)}</button>
  <span id="status"></span>
</div>
<script nonce="${input.nonce}">
  const $$ = (id) => document.getElementById(id);
  const collect = () => {
    const getNum = (id, fb) => { const n = Number($$(id).value); return Number.isFinite(n) && n >= 0 ? n : fb; };
    const globsText = $$('globs').value;
    const globs = globsText.split(',').map(s => s.trim()).filter(s => s.length > 0);
    return {
      enabled: $$('enabled').checked,
      triggerMode: $$('triggerMode').value,
      actionName: $$('actionName').value,
      globs,
      debounceMs: getNum('debounceMs', ${toJsonForScript(v.debounceMs)}),
      stabilityWindowMs: getNum('stabilityWindowMs', ${toJsonForScript(v.stabilityWindowMs)}),
      batchFlushMs: getNum('batchFlushMs', ${toJsonForScript(v.batchFlushMs)}),
      batchPreviewThreshold: getNum('batchPreviewThreshold', ${toJsonForScript(v.batchPreviewThreshold)}),
      syntaxGate: $$('syntaxGate').checked,
      sendViaProviders: $$('sendViaProviders').checked,
      allowRootLevelStem: $$('allowRootLevelStem').checked
    };
  };
  $$('save').addEventListener('click', () => {
    acquireVsCodeApi().postMessage({ command: 'save', values: collect() });
  });
  $$('reset').addEventListener('click', () => {
    acquireVsCodeApi().postMessage({ command: 'reset' });
  });
  window.addEventListener('message', (event) => {
    if (event.data && event.data.command === 'saved') {
      $$('status').textContent = event.data.message;
    }
  });
</script>
</body>
</html>`;
}

/** webview → 控制器消息 */
interface HotReloadSettingsWebviewMessage {
  command: string;
  values?: unknown;
}

/** 缺省标签(装配面 zh 面;测试注入替身) */
export function defaultHotReloadSettingsLabels(): HotReloadSettingsFormLabels {
  return {
    title: '热更设置',
    description: '编辑 kbengine.hotReload.* 工作区设置(保存即写回生效)',
    enabled: '启用自动热更',
    enabledHint: '关闭后保存事件不再自动触发热更(手动命令仍可用)',
    triggerMode: '监听模式',
    onSave: '保存时(onSave)',
    onDiskChange: '磁盘变化时(onDiskChange)',
    actionName: '动作名',
    actionNameHint: '留空=默认热更动作;发送 provider 开启时作回退',
    globs: '监视 globs',
    globsHint: '逗号分隔;空=按脚本资源根派生(不监视任何显式模式)',
    debounceMs: '去抖(ms)',
    stabilityWindowMs: '写入稳定窗(ms)',
    syntaxGate: '语法检查',
    batchFlushMs: '波次冲口(ms)',
    batchPreviewThreshold: '批量预览阈值',
    sendViaProviders: '发送 provider',
    allowRootLevelStem: '根下单层回退',
    save: '保存',
    reset: '恢复默认',
    saved: '已保存',
    resetDone: '已恢复默认'
  };
}

/**
 * 配置编辑面板:读 kbengine.hotReload.* 现值渲染表单;保存/复位经
 * workspaceConfiguration.update 写回(Workspace 作用域)。复用既有
 * hotReloadSectionReader + readHotReloadSettings(表单所见=装配所用,
 * 读同一函数零分叉);写回只走白名单键(段前缀 hotReload.)。
 */
export class HotReloadSettingsPanel {
  private panel: vscode.WebviewPanel | null = null;
  private readonly readSettings: () => HotReloadSettingsFormValues;
  private readonly writeSection: vscode.WorkspaceConfiguration;

  constructor(deps?: {
    readSettings?: () => HotReloadSettingsFormValues;
    writeSection?: vscode.WorkspaceConfiguration;
  }) {
    this.readSettings = deps?.readSettings ?? (() => readHotReloadSettingsFormValues());
    this.writeSection =
      deps?.writeSection ?? vscode.workspace.getConfiguration('kbengine');
  }

  async show(): Promise<void> {
    if (this.panel) {
      this.panel.reveal();
      return;
    }
    const labels = defaultHotReloadSettingsLabels();
    const values = this.readSettings();
    const nonce = randomNonce();
    this.panel = vscode.window.createWebviewPanel(
      'kbengine.hotReloadSettings',
      labels.title,
      vscode.ViewColumn.Two,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    this.panel.onDidDispose(() => {
      this.panel = null;
    });
    this.panel.webview.onDidReceiveMessage((message: HotReloadSettingsWebviewMessage) => {
      void this.onMessage(message);
    });
    this.panel.webview.html = renderHotReloadSettingsFormHtml({ values, labels, nonce });
  }

  dispose(): void {
    this.panel?.dispose();
    this.panel = null;
  }

  private async onMessage(message: HotReloadSettingsWebviewMessage): Promise<void> {
    if (message.command === 'save') {
      await this.save(message.values);
    } else if (message.command === 'reset') {
      await this.reset();
    }
  }

  /** 保存:白名单逐键写回(Workspace,键前缀 hotReload.);值经规范化,不信任 webview 原样 */
  private async save(rawValues: unknown): Promise<void> {
    const fallback = this.readSettings();
    const values = coerceHotReloadSettingsFormValues(rawValues, fallback);
    const section = this.writeSection;
    const write = async (key: string, value: unknown): Promise<void> => {
      await section.update(`hotReload.${key}`, value, vscode.ConfigurationTarget.Workspace);
    };
    await write('enabled', values.enabled);
    await write('actionName', values.actionName);
    await write('globs', values.globs);
    await write('debounceMs', values.debounceMs);
    await write('triggerMode', values.triggerMode);
    await write('stabilityWindowMs', values.stabilityWindowMs);
    await write('syntaxGate', values.syntaxGate);
    await write('batchFlushMs', values.batchFlushMs);
    await write('batchPreviewThreshold', values.batchPreviewThreshold);
    await write('sendViaProviders', values.sendViaProviders);
    await write('allowRootLevelStem', values.allowRootLevelStem);
    void this.panel?.webview.postMessage({
      command: 'saved',
      message: defaultHotReloadSettingsLabels().saved
    });
  }

  /** 复位:逐键 update undefined(清工作区覆写回默认) */
  private async reset(): Promise<void> {
    const section = this.writeSection;
    for (const key of HOT_RELOAD_SETTINGS_WRITABLE_KEYS) {
      await section.update(`hotReload.${key}`, undefined, vscode.ConfigurationTarget.Workspace);
    }
    void this.panel?.webview.postMessage({
      command: 'saved',
      message: defaultHotReloadSettingsLabels().resetDone
    });
  }
}

/** 装配面命令体(缺省段读取;测试直接 new HotReloadSettingsPanel 注入替身段) */
export function openHotReloadSettingsPanel(): Promise<void> {
  return new HotReloadSettingsPanel().show();
}

export const HOT_RELOAD_SETTINGS_COMMAND = 'kbengine.hotReload.settings';

export { HOT_RELOAD_DEFAULT_BATCH_PREVIEW_THRESHOLD, HOT_RELOAD_DEFAULT_DEBOUNCE_MS };
