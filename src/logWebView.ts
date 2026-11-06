/**
 * KBEngine 日志查看器 WebView
 * 提供可视化的日志查看界面
 */

import * as vscode from 'vscode';
import { LogEntry, LogParser, LogLevel } from './logParser';
import { KBEngineLogCollector } from './logCollector';
import { LogEvent, LogHub, RuntimeLogLevel } from './logHub';
import { getWebviewConsoleScript, WEBVIEW_LOG_COMMAND, WebviewLogMessage } from './webviewConsoleBridge';
import { randomNonce, webviewScriptCsp } from './webviewSecurity';

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
  private currentLogs: Array<LogEntry | LogEvent> = [];
  private logSubscription?: () => void;
  private logHub?: LogHub;
  private readonly displayedLimit = 5000;
  // 发送积压上限(IDE-RES-006):webview 暂停消费时在途只留一批,待发槽
  // 只留一批——新批顶替旧槽(顶替事件计数累计进 webviewDropped 随批可观测),
  // 宿主不为暂停的页面无限堆 postMessage。
  private pendingWebviewBatch: { events: readonly LogEvent[]; dropped: number; capacity: number } | null = null;
  private webviewPosting = false;
  private webviewDropped = 0;
  private filter: LogFilter = {
    levels: [],
    components: [],
    keyword: '',
    useRegex: false
  };
  /**
   * KR-AUD-44:collector 直连路径的攒批窗口。此前每条日志都整页重渲
   * (getHtml 全量重建 + nonce CSP + 过滤重算),高频日志下是热路径;logHub
   * 增量 appendLogs 路径早就存在却没接过来。现在按窗口攒批,窗口末一次性
   * 追加(过滤在宿主侧先算,页面只 append),整页重渲只留给用户动作
   * (开面板/改过滤/清空)。
   */
  private static readonly COLLECTOR_FLUSH_MS = 250;
  private pendingCollectorEntries: LogEntry[] = [];
  private collectorFlushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private context: vscode.ExtensionContext,
    private collector: KBEngineLogCollector,
    logHub?: LogHub
  ) {
    this.logHub = logHub;
    // 监听日志事件
    collector.onLogEntry(entry => {
      this.currentLogs.push(entry);
      if (this.currentLogs.length > this.displayedLimit) {
        this.currentLogs.splice(0, this.currentLogs.length - this.displayedLimit);
      }
      if (this.panel) {
        this.enqueueCollectorEntry(entry);
      }
    });
  }

  /** collector 条目入窗口批:窗口内零重渲,首条起一个定时器(尾沿) */
  private enqueueCollectorEntry(entry: LogEntry): void {
    this.pendingCollectorEntries.push(entry);
    if (this.collectorFlushTimer !== null) {
      return;
    }
    this.collectorFlushTimer = setTimeout(
      () => this.flushCollectorEntries(),
      LogViewerWebView.COLLECTOR_FLUSH_MS
    );
  }

  /** 窗口到期:按当前过滤筛过的一批走增量 appendLogs(append-only) */
  private flushCollectorEntries(): void {
    this.collectorFlushTimer = null;
    const pending = this.pendingCollectorEntries;
    this.pendingCollectorEntries = [];
    if (pending.length === 0 || !this.panel) {
      return;
    }
    const matched = this.applyFilter(pending);
    if (matched.length === 0) {
      return;
    }
    this.enqueueWebviewBatch(matched.map(toLogEvent), 0, this.displayedLimit);
  }

  /** 作废待发批(整页重渲已含窗口内条目,再追加即重复) */
  private cancelCollectorFlush(): void {
    if (this.collectorFlushTimer !== null) {
      clearTimeout(this.collectorFlushTimer);
      this.collectorFlushTimer = null;
    }
    this.pendingCollectorEntries = [];
  }

  subscribeLogHub(hub: LogHub): void {
    this.logSubscription?.();
    this.logSubscription = hub.onBatch(batch => {
      batch.events.forEach(event => this.currentLogs.push(toLegacyEntry(event)));
      if (this.currentLogs.length > this.displayedLimit) {
        this.currentLogs.splice(0, this.currentLogs.length - this.displayedLimit);
      }
      if (!this.panel) return;
      // 增量追加同样过当前过滤(KR-AUD-44 口径统一):过滤激活时新条目不再照登
      const displayEvents = batch.events.filter(event => this.matchesFilter({
        level: event.level as unknown as LogLevel,
        component: event.component,
        message: event.text
      }));
      if (displayEvents.length === 0) return;
      this.enqueueWebviewBatch(displayEvents, batch.dropped, batch.capacity);
    });
  }

  /** webview 发送面:在途挂起时新批顶替待发槽(有界),槽顶替计数可观测 */
  private enqueueWebviewBatch(events: readonly LogEvent[], dropped: number, capacity: number): void {
    if (this.webviewPosting) {
      if (this.pendingWebviewBatch) {
        this.webviewDropped += this.pendingWebviewBatch.events.length;
      }
      this.pendingWebviewBatch = { events, dropped, capacity };
      return;
    }
    this.deliverWebviewBatch(events, dropped, capacity);
  }

  private deliverWebviewBatch(events: readonly LogEvent[], dropped: number, capacity: number): void {
    const panel = this.panel;
    if (!panel) return;
    this.webviewPosting = true;
    const settled = (): void => {
      this.webviewPosting = false;
      const next = this.pendingWebviewBatch;
      this.pendingWebviewBatch = null;
      if (next) {
        this.deliverWebviewBatch(next.events, next.dropped, next.capacity);
      }
    };
    void panel.webview.postMessage({
      command: 'appendLogs',
      events,
      dropped,
      capacity,
      displayLimit: this.displayedLimit,
      webviewDropped: this.webviewDropped,
      // 宿主侧累计条目数(过滤前),页面用它刷新「总计」计数
      total: this.currentLogs.length
    }).then(settled, settled);
  }

  attachLogHub(hub: LogHub): void {
    this.logHub = hub;
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

    // 首开时保留 hub 订阅已积累的历史，并合并 collector 缓存。
    const collectorLogs = this.collector.getLogEntries();
    this.currentLogs.push(...collectorLogs);
    if (this.currentLogs.length > this.displayedLimit) {
      this.currentLogs.splice(0, this.currentLogs.length - this.displayedLimit);
    }

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

    // 整页重渲包含窗口内全部条目:作废待发批,避免随后又追加一遍(KR-AUD-44)
    this.cancelCollectorFlush();
    const filteredLogs = this.applyFilter(this.currentLogs.map(toLegacyEntry));
    const html = this.getHtml(filteredLogs);
    this.panel.webview.html = html;
  }

  /**
   * 单条是否命中当前过滤(KR-AUD-44:整页渲染与两条增量追加路径共用同一
   * 口径——此前只有整页渲染过滤,增量批追加无视过滤,过滤激活时新条目照登)。
   */
  private matchesFilter(log: { level: LogLevel; component: string; message: string }): boolean {
    // 按级别过滤
    if (this.filter.levels.length > 0 && !this.filter.levels.includes(log.level)) {
      return false;
    }

    // 按组件过滤
    if (this.filter.components.length > 0 && !this.filter.components.includes(log.component)) {
      return false;
    }

    // 按关键词过滤
    if (this.filter.keyword) {
      if (this.filter.useRegex) {
        try {
          const regex = new RegExp(this.filter.keyword, 'i');
          if (!regex.test(log.message)) {
            return false;
          }
        } catch {
          // 正则表达式错误，不过滤
        }
      } else if (!log.message.toLowerCase().includes(this.filter.keyword.toLowerCase())) {
        return false;
      }
    }

    return true;
  }

  /**
   * 应用过滤器
   */
  private applyFilter(logs: LogEntry[]): LogEntry[] {
    // 空过滤:原样返回(调用方依赖同一引用,不复制)
    if (
      this.filter.levels.length === 0 &&
      this.filter.components.length === 0 &&
      !this.filter.keyword
    ) {
      return logs;
    }
    return logs.filter(log => this.matchesFilter(log));
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
      case WEBVIEW_LOG_COMMAND:
        this.logWebviewMessage(message as WebviewLogMessage);
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

  private logWebviewMessage(message: WebviewLogMessage): void {
    const text = typeof message.text === 'string' ? message.text : String(message.text);
    if (!text.trim()) return;
    const timestamp = Number.isFinite(message.timestamp) ? message.timestamp : Date.now();
    const origin = typeof message.origin === 'string' && message.origin ? message.origin : 'webview:page';
    const levelByMessage: Record<WebviewLogMessage['level'], RuntimeLogLevel> = {
      debug: RuntimeLogLevel.DEBUG,
      info: RuntimeLogLevel.INFO,
      warning: RuntimeLogLevel.WARNING,
      error: RuntimeLogLevel.ERROR
    };
    this.logHub?.ingest({
      source: 'webview',
      component: 'webview',
      text,
      level: levelByMessage[message.level] ?? RuntimeLogLevel.INFO,
      origin,
      timestamp
    });
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
    const filteredLogs = this.applyFilter(this.currentLogs.map(toLegacyEntry));

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
    const nonce = randomNonce();
    const logsHtml = logs.map(log => this.formatLogEntry(log)).join('\n');
    const statusSummary = this.escapeHtml(this.collector.getStatusSummary());

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <!-- 最小 CSP:内联脚本只认本次渲染的 nonce,断掉一切外联/外帧/连接 -->
  <meta http-equiv="Content-Security-Policy" content="${webviewScriptCsp(nonce)}">
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
  <div class="stats" id="logStats" data-displayed="${logs.length}" data-total="${this.currentLogs.length}">
    显示 ${logs.length} 条日志（总计 ${this.currentLogs.length} 条）
  </div>
  <div class="log-container" id="logContainer">
    ${logsHtml || '<div class="empty-state">暂无日志<br><small>启动 KBEngine 服务器后，日志将在此显示</small></div>'}
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    ${getWebviewConsoleScript({ throttle: true })}

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

    const container = document.getElementById('logContainer');
    const levelClasses = ['level-debug', 'level-info', 'level-warning', 'level-error', 'level-critical'];
    const appendEvent = (event, limit = 5000) => {
      const entry = document.createElement('div');
      entry.className = 'log-entry ' + (levelClasses[Number(event.level)] || 'level-info');
      const timestamp = document.createElement('span');
      timestamp.className = 'log-timestamp';
      timestamp.textContent = new Date(event.timestamp).toLocaleTimeString('zh-CN');
      const component = document.createElement('span');
      component.className = 'log-component';
      component.textContent = event.component.toUpperCase();
      const message = document.createElement('span');
      message.className = 'log-message';
      message.textContent = event.text;
      entry.append(timestamp, component, message);
      container.appendChild(entry);
      while (container.querySelectorAll('.log-entry').length > limit) {
        container.querySelector('.log-entry')?.remove();
      }
      container.scrollTop = container.scrollHeight;
    };
    window.addEventListener('message', (event) => {
      const message = event.data;
      if (message.command === 'appendLogs') {
        const events = message.events || [];
        if (events.length > 0) {
          container.querySelector('.empty-state')?.remove();
          const stats = document.getElementById('logStats');
          if (stats) {
            // 追加是增量的,计数也增量走(整页重渲时由宿主重算基准)
            const displayed = Number(stats.dataset.displayed || 0) + events.length;
            const total = Number(message.total ?? stats.dataset.total ?? displayed);
            stats.dataset.displayed = String(displayed);
            stats.dataset.total = String(total);
            stats.textContent = '显示 ' + displayed + ' 条日志（总计 ' + total + ' 条）';
          }
        }
        events.forEach(event => appendEvent(event, message.displayLimit ?? 5000));
      }
    });

    // 自动滚动到底部
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

    return `<div class="log-entry ${levelClass}" title="${this.escapeHtml(log.raw)}">
      <span class="log-timestamp">${timestamp}</span>
      <span class="log-component" style="background-color: ${componentColor}; color: white;">
        ${levelIcon} ${this.escapeHtml(log.component.toUpperCase())}
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
    this.logSubscription?.();
    this.cancelCollectorFlush();
    this.pendingWebviewBatch = null;
    this.webviewPosting = false;
    if (this.panel) {
      this.panel.dispose();
      this.panel = null;
    }
  }
}

/** collector 条目 → webview 增量批事件(KR-AUD-44:两条路径共用 appendLogs) */
function toLogEvent(entry: LogEntry): LogEvent {
  return {
    id: String(entry.id),
    timestamp: entry.timestamp.getTime(),
    level: entry.level as unknown as RuntimeLogLevel,
    source: 'collector',
    component: entry.component,
    text: entry.message,
    origin: 'collector',
    duplicateCount: 1
  };
}

function toLegacyEntry(value: LogEvent | LogEntry): LogEntry {
  if ('message' in value && 'raw' in value && value.timestamp instanceof Date) {
    return value;
  }

  const event = value as LogEvent;
  return {
    id: Number.parseInt(event.id.replace(/-/g, '').slice(0, 12), 16),
    timestamp: new Date(event.timestamp),
    component: event.component,
    level: event.level as unknown as LogLevel,
    type: 0,
    message: event.text,
    raw: event.text
  };
}

export { RuntimeLogLevel };
