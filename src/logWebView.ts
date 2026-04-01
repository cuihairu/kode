/**
 * KBEngine 日志查看器 WebView
 * 提供可视化的日志查看界面
 */

import * as vscode from 'vscode';
import { LogEntry, LogParser, LogLevel } from './logParser';
import { KBEngineLogCollector } from './logCollector';

/**
 * 日志过滤器配置
 */
export interface LogFilter {
  levels: LogLevel[];
  components: string[];
  keyword: string;
  useRegex: boolean;
}

/**
 * 日志查看器 WebView
 */
export class LogViewerWebView {
  private panel: vscode.WebviewPanel | null = null;
  private currentLogs: LogEntry[] = [];
  private filter: LogFilter = {
    levels: [],
    components: [],
    keyword: '',
    useRegex: false
  };

  constructor(
    private context: vscode.ExtensionContext,
    private collector: KBEngineLogCollector
  ) {
    // 监听日志事件
    collector.onLogEntry(entry => {
      this.currentLogs.push(entry);
      if (this.panel) {
        this.updateWebView();
      }
    });
  }

  /**
   * 显示日志查看器
   */
  show(): void {
    if (this.panel) {
      this.panel.reveal();
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      'kbengine.logViewer',
      'KBEngine Logs',
      vscode.ViewColumn.Two,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(this.context.extensionUri, 'resources')
        ]
      }
    );

    // 设置初始日志
    this.currentLogs = this.collector.getLogEntries();

    // 更新 WebView
    this.updateWebView();

    // 处理消息
    this.panel.webview.onDidReceiveMessage(
      message => {
        this.handleMessage(message);
      },
      undefined,
      this.context.subscriptions
    );

    // 关闭时清理
    this.panel.onDidDispose(
      () => {
        this.panel = null;
      },
      undefined,
      this.context.subscriptions
    );
  }

  /**
   * 更新 WebView 内容
   */
  private updateWebView(): void {
    if (!this.panel) {
      return;
    }

    const filteredLogs = this.applyFilter(this.currentLogs);
    const html = this.getHtml(filteredLogs);
    this.panel.webview.html = html;
  }

  /**
   * 应用过滤器
   */
  private applyFilter(logs: LogEntry[]): LogEntry[] {
    let filtered = logs;

    // 按级别过滤
    if (this.filter.levels.length > 0) {
      filtered = filtered.filter(log => this.filter.levels.includes(log.level));
    }

    // 按组件过滤
    if (this.filter.components.length > 0) {
      filtered = filtered.filter(log => this.filter.components.includes(log.component));
    }

    // 按关键词过滤
    if (this.filter.keyword) {
      if (this.filter.useRegex) {
        try {
          const regex = new RegExp(this.filter.keyword, 'i');
          filtered = filtered.filter(log => regex.test(log.message));
        } catch {
          // 正则表达式错误，不过滤
        }
      } else {
        filtered = filtered.filter(log =>
          log.message.toLowerCase().includes(this.filter.keyword.toLowerCase())
        );
      }
    }

    return filtered;
  }

  /**
   * 处理来自 WebView 的消息
   */
  private handleMessage(message: any): void {
    switch (message.command) {
      case 'clear':
        this.clearLogs();
        break;
      case 'export':
        this.exportLogs();
        break;
      case 'filter':
        this.filter = message.filter;
        this.updateWebView();
        break;
      case 'search':
        this.filter.keyword = message.keyword;
        this.filter.useRegex = message.useRegex;
        this.updateWebView();
        break;
      case 'connect':
        void this.connectCollector();
        break;
      case 'disconnect':
        this.collector.disconnect();
        break;
    }
  }

  private async connectCollector(): Promise<void> {
    try {
      await this.collector.connect();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`日志连接不可用: ${message}`);
    }
  }

  /**
   * 清空日志
   */
  clearLogs(): void {
    this.currentLogs = [];
    this.collector.clearLogs();
    this.updateWebView();
  }

  /**
   * 导出日志
   */
  exportLogs(): void {
    const filteredLogs = this.applyFilter(this.currentLogs);

    vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file('kbengine_logs.txt'),
      filters: {
        'Text Files': ['txt'],
        'Log Files': ['log'],
        'JSON Files': ['json'],
        'All Files': ['*']
      }
    }).then(uri => {
      if (uri) {
        const lowerPath = uri.fsPath.toLowerCase();
        const content = lowerPath.endsWith('.json')
          ? JSON.stringify(filteredLogs, null, 2)
          : filteredLogs.map(log => LogParser.formatLogEntry(log)).join('\n');

        vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'))
          .then(() => {
            vscode.window.showInformationMessage(`日志已导出到 ${uri.fsPath}`);
          }, (error: unknown) => {
            vscode.window.showErrorMessage(`导出日志失败: ${error}`);
          });
      }
    });
  }

  /**
   * 生成 HTML
   */
  private getHtml(logs: LogEntry[]): string {
    const logsHtml = logs.map(log => this.formatLogEntry(log)).join('\n');
    const statusSummary = this.escapeHtml(this.collector.getStatusSummary());

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>KBEngine Logs</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      background-color: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
      padding: 10px;
    }

    .toolbar {
      display: flex;
      gap: 10px;
      padding: 10px;
      background-color: var(--vscode-editorGroupHeader-tabsBackground);
      border-bottom: 1px solid var(--vscode-panel-border);
      margin-bottom: 10px;
    }

    .toolbar input, .toolbar select {
      padding: 5px;
      background-color: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border);
      border-radius: 2px;
    }

    .toolbar button {
      padding: 5px 15px;
      background-color: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 2px;
      cursor: pointer;
    }

    .toolbar button:hover {
      background-color: var(--vscode-button-hoverBackground);
    }

    .stats {
      padding: 5px 10px;
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
    }

    .notice {
      margin-bottom: 10px;
      padding: 10px 12px;
      border-left: 3px solid var(--vscode-testing-iconFailed);
      background-color: var(--vscode-inputValidation-errorBackground);
      color: var(--vscode-editor-foreground);
      line-height: 1.5;
    }

    .log-container {
      max-height: calc(100vh - 150px);
      overflow-y: auto;
    }

    .log-entry {
      padding: 8px;
      margin-bottom: 2px;
      border-left: 3px solid transparent;
      font-family: var(--vscode-editor-font-family);
      font-size: var(--vscode-editor-font-size);
      line-height: 1.5;
      cursor: pointer;
    }

    .log-entry:hover {
      background-color: var(--vscode-list-hoverBackground);
    }

    .log-entry.level-debug {
      border-left-color: #888888;
    }

    .log-entry.level-info {
      border-left-color: #2196F3;
    }

    .log-entry.level-warning {
      border-left-color: #FF9800;
      background-color: rgba(255, 152, 0, 0.1);
    }

    .log-entry.level-error {
      border-left-color: #F44336;
      background-color: rgba(244, 67, 54, 0.1);
    }

    .log-entry.level-critical {
      border-left-color: #D32F2F;
      background-color: rgba(211, 47, 47, 0.2);
    }

    .log-timestamp {
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
    }

    .log-component {
      font-weight: bold;
      padding: 2px 6px;
      border-radius: 2px;
      font-size: 11px;
      text-transform: uppercase;
    }

    .log-message {
      white-space: pre-wrap;
      word-break: break-word;
    }

    .empty-state {
      text-align: center;
      padding: 50px;
      color: var(--vscode-descriptionForeground);
    }
  </style>
</head>
<body>
  <div class="toolbar">
    <input type="text" id="search" placeholder="搜索日志..." />
    <select id="levelFilter">
      <option value="">所有级别</option>
      <option value="0">DEBUG</option>
      <option value="1">INFO</option>
      <option value="2">WARNING</option>
      <option value="3">ERROR</option>
      <option value="4">CRITICAL</option>
    </select>
    <select id="componentFilter">
      <option value="">所有组件</option>
      <option value="machine">Machine</option>
      <option value="logger">Logger</option>
      <option value="dbmgr">DBMgr</option>
      <option value="baseappmgr">BaseAppMgr</option>
      <option value="cellappmgr">CellAppMgr</option>
      <option value="loginapp">LoginApp</option>
      <option value="baseapp">BaseApp</option>
      <option value="cellapp">CellApp</option>
    </select>
    <button id="clearBtn">清空</button>
    <button id="exportBtn">导出</button>
    <button id="connectBtn">连接</button>
    <button id="disconnectBtn">断开</button>
  </div>
  <div class="notice">连接状态：${statusSummary}</div>
  <div class="stats">
    显示 ${logs.length} 条日志（总计 ${this.currentLogs.length} 条）
  </div>
  <div class="log-container" id="logContainer">
    ${logsHtml || '<div class="empty-state">暂无日志<br><small>启动 KBEngine 服务器后，日志将在此显示</small></div>'}
  </div>

  <script>
    const vscode = acquireVsCodeApi();

    // 搜索
    document.getElementById('search').addEventListener('input', (e) => {
      vscode.postMessage({
        command: 'search',
        keyword: e.target.value,
        useRegex: false
      });
    });

    // 级别过滤
    document.getElementById('levelFilter').addEventListener('change', (e) => {
      const filter = {
        levels: e.target.value ? [parseInt(e.target.value)] : [],
        components: [],
        keyword: '',
        useRegex: false
      };
      vscode.postMessage({
        command: 'filter',
        filter: filter
      });
    });

    // 组件过滤
    document.getElementById('componentFilter').addEventListener('change', (e) => {
      const filter = {
        levels: [],
        components: e.target.value ? [e.target.value] : [],
        keyword: '',
        useRegex: false
      };
      vscode.postMessage({
        command: 'filter',
        filter: filter
      });
    });

    // 清空
    document.getElementById('clearBtn').addEventListener('click', () => {
      vscode.postMessage({ command: 'clear' });
    });

    // 导出
    document.getElementById('exportBtn').addEventListener('click', () => {
      vscode.postMessage({ command: 'export' });
    });

    // 连接
    document.getElementById('connectBtn').addEventListener('click', () => {
      vscode.postMessage({ command: 'connect' });
    });

    // 断开
    document.getElementById('disconnectBtn').addEventListener('click', () => {
      vscode.postMessage({ command: 'disconnect' });
    });

    // 自动滚动到底部
    const logContainer = document.getElementById('logContainer');
    logContainer.scrollTop = logContainer.scrollHeight;
  </script>
</body>
</html>`;
  }

  /**
   * 格式化日志条目为 HTML
   */
  private formatLogEntry(log: LogEntry): string {
    const levelClass = `level-${LogLevel[log.level].toLowerCase()}`;
    const levelIcon = LogParser.getLevelIcon(log.level);
    const timestamp = log.timestamp.toLocaleTimeString('zh-CN');

    // 组件名称颜色
    const componentColors: { [key: string]: string } = {
      'machine': '#9C27B0',
      'logger': '#4CAF50',
      'dbmgr': '#FF5722',
      'baseappmgr': '#2196F3',
      'cellappmgr': '#00BCD4',
      'loginapp': '#FF9800',
      'baseapp': '#3F51B5',
      'cellapp': '#E91E63'
    };

    const componentColor = componentColors[log.component] || '#757575';

    return `<div class="log-entry ${levelClass}" title="${log.raw}">
      <span class="log-timestamp">${timestamp}</span>
      <span class="log-component" style="background-color: ${componentColor}; color: white;">
        ${levelIcon} ${log.component.toUpperCase()}
      </span>
      <span class="log-message">${this.escapeHtml(log.message)}</span>
    </div>`;
  }

  /**
   * 转义 HTML 特殊字符
   */
  private escapeHtml(text: string): string {
    const map: { [key: string]: string } = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;'
    };
    return text.replace(/[&<>"']/g, m => map[m]);
  }

  /**
   * 清理资源
   */
  dispose(): void {
    if (this.panel) {
      this.panel.dispose();
      this.panel = null;
    }
  }
}
