/**
 * KBEngine telnet 控制面板 WebView(工单:telnet 探测+联动):
 * - 目标列表状态灯:未配置/未开启/已开启/端口开·未配密码/密码被拒/已连接;
 * - 已开启目标可建立持久会话(自动握手登录),面板活化:白名单命令输入、
 *   内置只读快捷命令钮、输出流回显;
 * - 未开启目标如实提示 + 附 kbengine.xml <telnet_service> 开启配置片段,
 *   不空转;
 * - 运行中断线:状态翻转提示,面板保留可重连,不崩。
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

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly service: TelnetService
  ) {
    service.onDidChange(() => this.updateWebView());
    service.onOutput(line => {
      if (line.key === this.selectedKey) {
        this.updateWebView();
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
      this.updateWebView();
    }
  }

  private updateWebView(): void {
    if (!this.panel) {
      return;
    }
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
  window.addEventListener('message', event => {
    const message = event.data;
    if (message.command === 'rejected') {
      const output = document.querySelector('.output');
      if (output) {
        const line = document.createElement('div');
        line.className = 'line rejected';
        line.textContent = '已拒绝(白名单外或会话未就绪): ' + message.text;
        output.appendChild(line);
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
