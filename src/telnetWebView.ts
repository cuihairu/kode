/**
 * KBEngine telnet 控制面板 WebView(工单:telnet 探测+联动):
 * - 目标列表状态灯:未配置/未开启/已开启/端口开·未配密码/密码被拒/已连接;
 * - 已开启目标可建立持久会话(自动握手登录),面板活化:白名单命令输入、
 *   内置只读快捷命令钮、输出流回显;
 * - 未开启目标如实提示 + 附 kbengine.xml <telnet_service> 开启配置片段,
 *   不空转;
 * - 运行中断线:状态翻转提示,面板保留可重连,不崩;
 * - 输出与状态灯走 postMessage 原地增量更新,不整页重渲——整页重渲会
 *   连输入框一起重建,连接后一有下行输出,正在输入的命令与焦点全丢
 *   (工单:telnet 连接后无法输入的 UI 侧根因);
 * - Ctrl+] / Ctrl+D 断开会话(telnet 标准转义),面板内任意处生效。
 */

import * as vscode from 'vscode';
import { BUILTIN_QUICK_COMMANDS } from './telnetClient';
import { TelnetProbeState, TelnetService, TelnetTarget } from './telnetService';

const STATE_LABELS: Record<TelnetProbeState, string> = {
  unconfigured: '未配置',
  closed: '未开启',
  open: '已开启(未接会话)',
  'auth-required': '端口开·未配密码',
  'auth-rejected': '密码被拒',
  connected: '已连接'
};

const STATE_COLORS: Record<TelnetProbeState, string> = {
  unconfigured: '#888888',
  closed: '#d9534f',
  open: '#5cb85c',
  'auth-required': '#f0ad4e',
  'auth-rejected': '#d9534f',
  connected: '#5cb85c'
};

const KBENGINE_XML_SNIPPET = [
  '<telnet_service>',
  '    <port> 31000 </port>',
  '    <password> pwd123456 </password>',
  '    <default_layer> python </default_layer>',
  '</telnet_service>'
].join('\n');

interface TelnetPanelMessage {
  command: 'select' | 'connect' | 'disconnect' | 'send';
  key?: string;
  text?: string;
}

export class TelnetWebView {
  private panel: vscode.WebviewPanel | null = null;
  private selectedKey: string | null = null;
  /** 最近一次整页渲染时的目标键序与选中目标状态:服务驱动的状态变化只在
   *  这些真变了的时候才值得整页重渲,其余走轻量状态灯补丁 */
  private renderedTargetKeys = '';
  private renderedSelectedState: TelnetProbeState | null = null;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly service: TelnetService
  ) {
    service.onDidChange(() => this.refreshWebView());
    service.onOutput(line => {
      if (line.key === this.selectedKey) {
        this.appendOutput(line.text);
      }
    });
  }

  show(): void {
    if (this.panel) {
      this.panel.reveal();
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      'kbengine.telnetPanel',
      'KBEngine Telnet',
      vscode.ViewColumn.Two,
      {
        enableScripts: true,
        retainContextWhenHidden: true
      }
    );

    this.panel.webview.onDidReceiveMessage(
      message => {
        void this.handleMessage(message as TelnetPanelMessage);
      },
      undefined,
      this.context.subscriptions
    );

    this.panel.onDidDispose(
      () => {
        this.panel = null;
      },
      undefined,
      this.context.subscriptions
    );

    this.updateWebView();
  }

  dispose(): void {
    this.panel?.dispose();
    this.panel = null;
  }

  private async handleMessage(message: TelnetPanelMessage): Promise<void> {
    const key = message.key ?? this.selectedKey;
    if (message.command === 'select' && key) {
      this.selectedKey = key;
      this.updateWebView();
      return;
    }
    if (!key) {
      return;
    }
    if (message.command === 'connect') {
      this.service.connectTarget(key);
      this.selectedKey = key;
      this.updateWebView();
      return;
    }
    if (message.command === 'disconnect') {
      this.service.disconnectTarget(key);
      this.updateWebView();
      return;
    }
    if (message.command === 'send') {
      const command = (message.text ?? '').trim();
      if (command.length === 0) {
        return;
      }
      if (!this.service.sendCommand(key, command)) {
        // 未过白名单或会话不在:面板输出区如实提示,不静默吞
        this.panel?.webview.postMessage({
          command: 'rejected',
          key,
          text: command
        });
        return;
      }
      // 命令回显与响应经 onOutput 追加,这里不重渲:重渲会重建输入框,
      // 刚输入的命令虽已发出,焦点却丢了,连发第二条就要重新点输入框。
      // 回显不用面板本地补:引擎 onRecvInput 的 default 分支逐字回显
      // (telnet_handler.cpp L396-411),本地再补一行会与服务端回显重复
    }
  }

  /** 断开当前会话:优先面板选中目标,否则取首个已连接目标;没有则如实提示。
   *  顶部入口(命令面板/telnet 树标题栏按钮)与本命令共用 */
  disconnectActive(): void {
    const connected = this.service
      .getTargets()
      .filter(target => this.service.getState(target.key) === 'connected');
    const key = connected.some(target => target.key === this.selectedKey)
      ? this.selectedKey
      : connected[0]?.key ?? null;
    if (!key) {
      void vscode.window.showInformationMessage('没有已连接的 telnet 会话');
      return;
    }
    this.service.disconnectTarget(key);
    this.updateWebView();
  }

  /** 面板当前展示的目标:显式选中优先,否则第一个目标(与 getHtml 同一口径,
   *  否则未显式选中时展示的目标状态变了不会重渲,面板停在过期指引上) */
  private effectiveSelectedKey(): string | null {
    const targets = this.service.getTargets();
    return targets.some(target => target.key === this.selectedKey)
      ? this.selectedKey
      : targets[0]?.key ?? null;
  }

  /** 服务驱动刷新:目标列表或展示目标状态变了才整页重渲,其余仅给面板
   *  发状态灯补丁——别的目标状态翻转不该打断正在输入的会话 */
  private refreshWebView(): void {
    if (!this.panel) {
      this.renderedTargetKeys = '';
      this.renderedSelectedState = null;
      return;
    }
    const targets = this.service.getTargets();
    const keys = JSON.stringify(targets.map(target => target.key));
    const effective = this.effectiveSelectedKey();
    const selectedState = effective ? this.service.getState(effective) : null;
    if (keys !== this.renderedTargetKeys || selectedState !== this.renderedSelectedState) {
      this.updateWebView();
      return;
    }
    this.panel.webview.postMessage({
      command: 'states',
      states: targets.map(target => ({
        key: target.key,
        state: this.service.getState(target.key)
      }))
    });
  }

  /** 输出追加走 postMessage,面板脚本原地插行;整页重渲会重建输入框,
   *  下行输出一流过,正在输入的命令与焦点全丢 */
  private appendOutput(text: string): void {
    const lines = text.split(/\r?\n/).filter(line => line.trim().length > 0);
    if (lines.length === 0 || !this.panel) {
      return;
    }
    void this.panel.webview.postMessage({ command: 'append', lines });
  }

  private updateWebView(): void {
    if (!this.panel) {
      return;
    }
    this.renderedTargetKeys = JSON.stringify(
      this.service.getTargets().map(target => target.key)
    );
    const effective = this.effectiveSelectedKey();
    this.renderedSelectedState = effective ? this.service.getState(effective) : null;
    this.panel.webview.html = this.getHtml();
  }

  private renderTargets(): string {
    const targets = this.service.getTargets();
    if (targets.length === 0) {
      return '<p class="muted">telnet 未配置:请在设置中填写 kbengine.telnet.host / kbengine.telnet.port,或在元件 kbengine.xml 的 &lt;telnet_service&gt; 段开启。</p>';
    }
    return targets
      .map(target => {
        const state = this.service.getState(target.key);
        const selected = target.key === this.selectedKey ? ' selected' : '';
        return [
          `<div class="target${selected}" data-key="${target.key}">`,
          `  <span class="light" style="background:${STATE_COLORS[state]}"></span>`,
          `  <span class="label">${target.label}</span>`,
          `  <span class="addr">${target.host}:${target.port}</span>`,
          `  <span class="state">${STATE_LABELS[state]}</span>`,
          '</div>'
        ].join('\n');
      })
      .join('\n');
  }

  private renderSession(target: TelnetTarget): string {
    const state = this.service.getState(target.key);
    if (state === 'closed') {
      return [
        '<div class="hint">',
        `  <p><strong>${target.label}(${target.host}:${target.port})的 telnet 未开启。</strong></p>`,
        '  <p>在元件配置 kbengine.xml 中加入以下段落并重启该组件即可开启:</p>',
        `  <pre>${escapeHtml(KBENGINE_XML_SNIPPET)}</pre>`,
        '</div>'
      ].join('\n');
    }
    const connectButton =
      state === 'connected'
        ? `<button class="connect" data-key="${target.key}" data-action="disconnect">断开会话</button>`
        : `<button class="connect" data-key="${target.key}" data-action="connect">连接会话(自动登录)</button>`;
    if (state === 'auth-required') {
      return [
        '<div class="hint">',
        `  <p><strong>${target.label} 的 telnet 端口已开启,但未配置密码。</strong></p>`,
        '  <p>在设置 kbengine.telnet.password 或 kbengine.xml <telnet_service><password> 中填写密码后即可自动登录。</p>',
        `  ${connectButton}`,
        '</div>'
      ].join('\n');
    }
    const sessionState = this.service.getSessionState(target.key);
    const output = this.service
      .getOutput(target.key)
      .map(line => `<div class="line">${escapeHtml(line)}</div>`)
      .join('\n');
    const quickButtons = BUILTIN_QUICK_COMMANDS.map(
      entry =>
        `<button class="quick" data-key="${target.key}" data-command="${escapeHtml(entry.command)}">${entry.label}</button>`
    ).join('\n');
    return [
      `<div class="session" data-session-state="${sessionState ?? ''}">`,
      `  <div class="quickrow">${connectButton}</div>`,
      output.length > 0 ? `<div class="output">${output}</div>` : '<div class="output muted">暂无输出</div>',
      `<div class="quickrow">${quickButtons}</div>`,
      `  <input class="cmd" data-key="${target.key}" placeholder="${sessionState === 'ready' ? '输入白名单内命令(回车发送)' : '等待会话就绪…'}" />`,
      `  <div class="keyshint">Ctrl+] / Ctrl+D 断开会话</div>`,
      '</div>'
    ].join('\n');
  }

  private getHtml(): string {
    const targets = this.service.getTargets();
    // 未显式选中时默认看第一个目标:打开面板即见状态与指引,不留空面板
    const selected =
      targets.find(target => target.key === this.selectedKey) ?? targets[0] ?? null;
    const sessionHtml = selected ? this.renderSession(selected) : '';
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-editor-foreground); padding: 8px; }
  .muted { color: var(--vscode-descriptionForeground); }
  .target { display: flex; gap: 8px; align-items: center; padding: 4px 6px; cursor: pointer; border-radius: 4px; }
  .target:hover { background: var(--vscode-list-hoverBackground); }
  .target.selected { background: var(--vscode-list-activeSelectionBackground); }
  .light { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
  .label { font-weight: bold; }
  .addr, .state { color: var(--vscode-descriptionForeground); }
  .hint { margin-top: 12px; line-height: 1.6; }
  .hint pre { background: var(--vscode-textCodeBlock-background); padding: 8px; border-radius: 4px; }
  .output { margin-top: 12px; max-height: 320px; overflow-y: auto; font-family: monospace;
            background: var(--vscode-terminal-background, #111); padding: 8px; border-radius: 4px; }
  .line { white-space: pre-wrap; word-break: break-all; }
  .quickrow { margin-top: 8px; display: flex; gap: 6px; flex-wrap: wrap; }
  button.quick { cursor: pointer; }
  input.cmd { width: 100%; margin-top: 8px; }
  .keyshint { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 4px; }
  .rejected { color: var(--vscode-errorForeground); }
</style>
</head>
<body>
<h3>KBEngine Telnet 探测</h3>
<div id="targets">
${this.renderTargets()}
</div>
<div id="session">
${sessionHtml}
</div>
<script>
  const vscode = acquireVsCodeApi();
  const stateLabels = ${JSON.stringify(STATE_LABELS)};
  const stateColors = ${JSON.stringify(STATE_COLORS)};
  document.getElementById('targets').addEventListener('click', event => {
    const item = event.target.closest('.target');
    if (item) {
      vscode.postMessage({ command: 'select', key: item.dataset.key });
    }
  });
  document.getElementById('session').addEventListener('click', event => {
    const quick = event.target.closest('button.quick');
    if (quick) {
      vscode.postMessage({ command: 'send', key: quick.dataset.key, text: quick.dataset.command });
      return;
    }
    const connect = event.target.closest('button.connect');
    if (connect) {
      vscode.postMessage({ command: connect.dataset.action === 'disconnect' ? 'disconnect' : 'connect', key: connect.dataset.key });
    }
  });
  document.getElementById('session').addEventListener('keydown', event => {
    const input = event.target.closest('input.cmd');
    if (input && event.key === 'Enter') {
      vscode.postMessage({ command: 'send', key: input.dataset.key, text: input.value });
      input.value = '';
    }
  });
  // telnet 标准转义 Ctrl+] 与 Ctrl+D 断开会话:面板内任意处生效
  document.addEventListener('keydown', event => {
    const isExit = event.ctrlKey && (event.key === ']' || event.key === 'd' || event.key === 'D');
    if (!isExit) {
      return;
    }
    event.preventDefault();
    const input = document.querySelector('input.cmd');
    vscode.postMessage({ command: 'disconnect', key: input ? input.dataset.key : undefined });
  });
  const appendLines = (lines, variant) => {
    const output = document.querySelector('.output');
    if (!output) {
      return;
    }
    if (output.classList.contains('muted')) {
      output.classList.remove('muted');
      output.textContent = '';
    }
    for (const text of lines) {
      const line = document.createElement('div');
      line.className = variant ? 'line ' + variant : 'line';
      line.textContent = text;
      output.appendChild(line);
    }
    while (output.childElementCount > 500) {
      output.removeChild(output.firstElementChild);
    }
    output.scrollTop = output.scrollHeight;
  };
  window.addEventListener('message', event => {
    const message = event.data;
    if (message.command === 'append') {
      appendLines(message.lines, '');
      return;
    }
    if (message.command === 'rejected') {
      appendLines(['已拒绝(白名单外或会话未就绪): ' + message.text], 'rejected');
      return;
    }
    if (message.command === 'states') {
      for (const entry of message.states) {
        const item = document.querySelector('.target[data-key="' + entry.key + '"]');
        if (!item) {
          continue;
        }
        const light = item.querySelector('.light');
        const label = item.querySelector('.state');
        if (light) {
          light.style.background = stateColors[entry.state];
        }
        if (label) {
          label.textContent = stateLabels[entry.state];
        }
      }
    }
  });
</script>
</body>
</html>`;
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
