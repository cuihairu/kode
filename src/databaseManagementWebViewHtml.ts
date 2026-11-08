/**
 * KBEngine 数据库管理 WebView 的 HTML 模板半边(SRC-012 拆半口径,与
 * entityDependencyWebViewHtml.ts 同构)。
 *
 * 内容:MySQL/Redis 双后端管理面板的整页 HTML/CSS/内联脚本生产
 * (renderDatabaseManagementWebview)及私有渲染辅助(escapeHtml 及三个测试
 * 导出辅助)。区域只做字符串生产,不触 vscode API;控制器
 * (databaseManagementWebView.ts)负责面板生命周期/数据获取/消息处理。
 *
 * 安全口径(KR-AUD-50/53):整页 nonce CSP(default-src 'none',脚本只认
 * nonce+cspSource,无 unsafe-inline);所有静态插值经 escapeHtml;JS 侧动态
 * 数据(表名/键名/单元格值/哈希字段)一律 document.createElement+textContent
 * 渲染,不碰 innerHTML 裸串——双保险(整页 CSP + DOM textContent)。
 */

import { WEBVIEW_THEME_CSS } from './webviewTheme';
import { htmlLang, resolvePanelLocale, strings } from './webviewStrings';
import { toJsonForScript, webviewScriptCsp } from './webviewSecurity';

/** 面板后端类型(profile.dbType;'none' = 无档案,后端标签全禁能)。 */
export type DatabaseBackendType = 'mysql' | 'redis' | 'none';

/** 连接摘要(自 getDerivedDatabaseProfile,无明文密码)。 */
export interface DatabaseManagementProfileSummary {
  host: string;
  port: number;
  username: string;
  databaseName: string;
  characterSet: string;
  encrypt: boolean;
  passwordAvailable: boolean;
}

/** 面板字符串键集(与 webviewStrings.ts 的 databaseManagement 块结构一致)。 */
export interface DatabaseManagementStrings {
  title: string;
  tabMysql: string;
  tabRedis: string;
  loadTables: string;
  scanKeys: string;
  noDatabaseProfile: string;
  passwordUnavailable: string;
  emptyTables: string;
  emptyKeys: string;
  keysTruncated: string;
  colField: string;
  colValue: string;
  colHost: string;
  colPort: string;
  colDatabase: string;
  colUser: string;
  colCharset: string;
  colPassword: string;
  loading: string;
  keyPreviewEmpty: string;
  previewTruncated: string;
}

export interface DatabaseManagementWebviewOptions {
  dbType: DatabaseBackendType;
  /** 连接摘要;null = 未读取到档案(出「无档案」注记,后端标签禁能)。 */
  profile: DatabaseManagementProfileSummary | null;
  /** 本次渲染 nonce(整页 CSP 脚本许可)。 */
  nonce: string;
  /** panel.webview.cspSource(与资源同源);无面板时回退 'vscode-webview:'。 */
  cspSource: string;
}

/** 全量字符串面转义(& < > " 五转义)。 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 连接摘要卡(测试导出直调;恶意 host/databaseName 等字符串面全量转义)。
 * passwordAvailable=false 时出「密码不可读」警告行(不尝试空密码连接)。
 */
export function renderConnectionSummary(
  s: DatabaseManagementProfileSummary,
  t: DatabaseManagementStrings
): string {
  const rows = [
    [t.colHost, `${s.host}:${s.port}`],
    [t.colDatabase, s.databaseName],
    [t.colUser, s.username],
    [t.colCharset, s.characterSet],
    [t.colPassword, s.passwordAvailable ? '✓' : '✗']
  ];
  const rowsHtml = rows
    .map(([label, value]) => `    <div class="summary-row">
      <span class="summary-label">${escapeHtml(label)}</span>
      <span class="summary-value">${escapeHtml(value)}</span>
    </div>`)
    .join('\n');
  const warning = s.passwordAvailable
    ? ''
    : `    <div class="summary-warning">⚠ ${escapeHtml(t.passwordUnavailable)}</div>`;
  return `${rowsHtml}\n${warning}`;
}

/** 表清单行(测试导出;表名全量转义)。 */
export function renderTableListRows(tables: string[], emptyLabel: string): string {
  if (tables.length === 0) {
    return `    <div class="empty-note">${escapeHtml(emptyLabel)}</div>`;
  }
  return tables
    .map(
      table => `    <div class="table-row" data-table="${escapeHtml(table)}">
      <span class="row-label">${escapeHtml(table)}</span>
    </div>`
    )
    .join('\n');
}

/** 键清单行(测试导出;键名全量转义;截断时出截断注记)。 */
export function renderKeyList(
  keys: string[],
  truncated: boolean,
  emptyLabel: string,
  truncatedLabel: string
): string {
  const rows = keys.length === 0
    ? `    <div class="empty-note">${escapeHtml(emptyLabel)}</div>`
    : keys
      .map(
        key => `    <div class="key-row" data-key="${escapeHtml(key)}">
      <span class="row-label">${escapeHtml(key)}</span>
    </div>`
      )
      .join('\n');
  const note = truncated
    ? `    <div class="truncated-note">⚠ ${escapeHtml(truncatedLabel)}</div>`
    : '';
  return `${rows}\n${note}`;
}

/**
 * 获取 Webview 内容:整页数据库管理面板(MySQL/Redis 双后端)。
 * 动态数据(表/键/预览)经 postMessage 增量推送,JS 侧 textContent 渲染;
 * 静态骨架(标题/标签/摘要)在此生产。
 */
export function renderDatabaseManagementWebview(
  options: DatabaseManagementWebviewOptions
): string {
  const { dbType, profile, nonce, cspSource } = options;
  const t: DatabaseManagementStrings = strings(resolvePanelLocale()).databaseManagement;
  const locale = htmlLang(resolvePanelLocale());
  const isMysql = dbType === 'mysql';
  const isRedis = dbType === 'redis';
  const noProfile = dbType === 'none';

  const summaryHtml = profile
    ? renderConnectionSummary(profile, t)
    : `    <div class="summary-warning">⚠ ${escapeHtml(t.noDatabaseProfile)}</div>`;

  const tabBtn = (tab: 'mysql' | 'redis', label: string, enabled: boolean): string =>
    `      <button class="tab-btn${enabled ? '' : ' disabled'}${(tab === 'mysql' && isMysql) || (tab === 'redis' && isRedis) ? ' active' : ''}"
        data-tab="${tab}"${enabled ? '' : ' disabled'}>${escapeHtml(label)}</button>`;

  return `<!DOCTYPE html>
<html lang="${locale}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <!-- 最小 CSP(KR-AUD-50/53):default-src 'none' 断掉一切外联/外帧/连接,
       脚本只认本次渲染 nonce + cspSource;无图片/无 CDN 依赖,故无 img-src。 -->
  <meta http-equiv="Content-Security-Policy" content="${webviewScriptCsp(nonce, [cspSource])}">
  <title>${escapeHtml(t.title)}</title>
  <style>
    ${WEBVIEW_THEME_CSS}
    body {
      margin: 0;
      padding: 20px;
    }

    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 20px;
      padding-bottom: 10px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .title {
      font-size: 24px;
      font-weight: bold;
    }
    .tabs {
      display: flex;
      gap: 8px;
    }
    .tab-btn {
      background-color: var(--vscode-button-secondaryBackground, var(--vscode-button-background));
      color: var(--vscode-button-secondaryForeground, var(--vscode-button-foreground));
      border: 1px solid var(--kode-border);
      padding: 6px 16px;
      cursor: pointer;
      border-radius: 4px;
    }
    .tab-btn.active {
      background-color: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border-color: transparent;
    }
    .tab-btn.disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .summary-card {
      background-color: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      padding: 12px 16px;
      margin-bottom: 16px;
    }
    .summary-row {
      display: flex;
      gap: 12px;
      margin-bottom: 4px;
      font-size: 13px;
    }
    .summary-row:last-child {
      margin-bottom: 0;
    }
    .summary-label {
      color: var(--vscode-descriptionForeground);
      min-width: 70px;
    }
    .summary-value {
      font-family: var(--kode-mono);
    }
    .summary-warning {
      margin-top: 8px;
      background-color: var(--vscode-inputValidation-warningBackground, #5a3d00);
      border: 1px solid var(--vscode-inputValidation-warningBorder, #bd8b00);
      color: var(--vscode-inputValidation-warningForeground, var(--vscode-editor-foreground));
      border-radius: 4px;
      padding: 8px 12px;
      font-size: 13px;
    }

    .error-bar {
      background-color: var(--vscode-inputValidation-errorBackground, #5a1d1d);
      border: 1px solid var(--vscode-inputValidation-errorBorder, #be1100);
      color: var(--vscode-inputValidation-errorForeground, var(--vscode-editor-foreground));
      border-radius: 4px;
      padding: 8px 12px;
      margin-bottom: 16px;
      font-size: 13px;
    }
    .error-bar.hidden {
      display: none;
    }

    .panel-toolbar {
      display: flex;
      gap: 10px;
      margin-bottom: 12px;
    }
    button.action-btn {
      background-color: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      padding: 6px 14px;
      cursor: pointer;
      border-radius: 2px;
    }
    button.action-btn:hover {
      background-color: var(--vscode-button-hoverBackground);
    }

    .list-card {
      background-color: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      max-height: 260px;
      overflow-y: auto;
      margin-bottom: 16px;
    }
    .table-row, .key-row {
      display: flex;
      align-items: center;
      padding: 6px 12px;
      cursor: pointer;
      border-bottom: 1px solid var(--kode-border);
      font-family: var(--kode-mono);
      font-size: 13px;
    }
    .table-row:hover, .key-row:hover {
      background-color: var(--vscode-list-hoverBackground);
    }
    .table-row:last-child, .key-row:last-child {
      border-bottom: none;
    }
    .empty-note {
      padding: 12px;
      color: var(--vscode-descriptionForeground);
      font-size: 13px;
    }
    .truncated-note {
      padding: 8px 12px;
      color: var(--vscode-inputValidation-warningForeground, var(--vscode-editor-foreground));
      background-color: var(--vscode-inputValidation-warningBackground, #5a3d00);
      font-size: 12px;
      border-top: 1px solid var(--vscode-inputValidation-warningBorder, #bd8b00);
    }

    .preview-area {
      background-color: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      padding: 12px;
    }
    .preview-title {
      font-family: var(--kode-mono);
      font-size: 13px;
      margin-bottom: 8px;
      color: var(--vscode-descriptionForeground);
    }
    .preview-note {
      margin-top: 8px;
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
    }
    .kode-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
    }
    .kode-table th, .kode-table td {
      border: 1px solid var(--kode-border);
      padding: 4px 8px;
      text-align: left;
      white-space: pre-wrap;
      word-break: break-all;
      max-width: 360px;
    }
    .kode-table th {
      background-color: var(--kode-surface-2);
      color: var(--vscode-descriptionForeground);
      position: sticky;
      top: 0;
    }
    .kode-table td {
      font-family: var(--kode-mono);
    }

    .tab-panel.hidden {
      display: none;
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="title">${escapeHtml(t.title)}</div>
    <div class="tabs">
      ${tabBtn('mysql', t.tabMysql, isMysql)}
      ${tabBtn('redis', t.tabRedis, isRedis)}
    </div>
  </div>

  <div class="summary-card">
${summaryHtml}
  </div>

  <div id="error-bar" class="error-bar hidden"></div>

  <section id="tab-mysql" data-tab="mysql" class="tab-panel${isMysql ? '' : ' hidden'}">
    <div class="panel-toolbar">
      <button id="load-tables-btn" class="action-btn"${noProfile ? ' disabled' : ''}>${escapeHtml(t.loadTables)}</button>
    </div>
    <div id="mysql-table-list" class="list-card">
      <div class="empty-note">${escapeHtml(t.loading)}</div>
    </div>
    <div id="mysql-preview" class="preview-area"></div>
  </section>

  <section id="tab-redis" data-tab="redis" class="tab-panel${isRedis ? '' : ' hidden'}">
    <div class="panel-toolbar">
      <button id="scan-keys-btn" class="action-btn"${noProfile ? ' disabled' : ''}>${escapeHtml(t.scanKeys)}</button>
    </div>
    <div id="redis-key-list" class="list-card">
      <div class="empty-note">${escapeHtml(t.loading)}</div>
    </div>
    <div id="redis-preview" class="preview-area"></div>
  </section>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const t = ${toJsonForScript(t)};
    const dbType = ${toJsonForScript(dbType)};

    function showError(text) {
      const bar = document.getElementById('error-bar');
      if (!bar) {
        return;
      }
      bar.textContent = String(text);
      bar.classList.remove('hidden');
    }

    function clearError() {
      const bar = document.getElementById('error-bar');
      if (bar) {
        bar.textContent = '';
        bar.classList.add('hidden');
      }
    }

    function setTab(tab) {
      document.querySelectorAll('.tab-panel').forEach(el => {
        el.classList.toggle('hidden', el.dataset.tab !== tab);
      });
      document.querySelectorAll('.tab-btn').forEach(el => {
        el.classList.toggle('active', el.dataset.tab === tab);
      });
    }

    // 后端标签:本地切换 + 通知扩展侧重绘(仅非禁能 tab)
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        if (btn.disabled) {
          return;
        }
        const tab = btn.dataset.tab;
        setTab(tab);
        vscode.postMessage({ command: 'setTab', tab: tab });
      });
    });

    function renderTables(list) {
      const container = document.getElementById('mysql-table-list');
      container.textContent = '';
      if (!list || list.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty-note';
        empty.textContent = t.emptyTables;
        container.appendChild(empty);
        return;
      }
      for (const table of list) {
        const row = document.createElement('div');
        row.className = 'table-row';
        row.dataset.table = table;
        const name = document.createElement('span');
        name.className = 'row-label';
        name.textContent = table;
        row.appendChild(name);
        row.addEventListener('click', () => {
          vscode.postMessage({ command: 'previewTable', table: table });
        });
        container.appendChild(row);
      }
    }

    function renderTablePreview(result) {
      const area = document.getElementById('mysql-preview');
      area.textContent = '';
      if (result.kind === 'error') {
        showError(result.message);
        return;
      }
      clearError();
      const tableEl = document.createElement('table');
      tableEl.className = 'kode-table';
      const thead = document.createElement('thead');
      const headRow = document.createElement('tr');
      for (const col of result.columns) {
        const th = document.createElement('th');
        th.textContent = String(col.name);
        headRow.appendChild(th);
      }
      thead.appendChild(headRow);
      tableEl.appendChild(thead);
      const tbody = document.createElement('tbody');
      for (const row of result.rows) {
        const tr = document.createElement('tr');
        for (const col of result.columns) {
          const td = document.createElement('td');
          const value = row[col.name];
          td.textContent = value === null || value === undefined ? '' : String(value);
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      }
      tableEl.appendChild(tbody);
      area.appendChild(tableEl);
      if (result.truncated) {
        const note = document.createElement('div');
        note.className = 'preview-note';
        note.textContent = t.previewTruncated.replace('{limit}', String(result.limit));
        area.appendChild(note);
      }
    }

    function renderKeys(list, truncated) {
      const container = document.getElementById('redis-key-list');
      container.textContent = '';
      if (!list || list.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty-note';
        empty.textContent = t.emptyKeys;
        container.appendChild(empty);
        return;
      }
      for (const key of list) {
        const row = document.createElement('div');
        row.className = 'key-row';
        row.dataset.key = key;
        const name = document.createElement('span');
        name.className = 'row-label';
        name.textContent = key;
        row.appendChild(name);
        row.addEventListener('click', () => {
          vscode.postMessage({ command: 'previewKey', key: key });
        });
        container.appendChild(row);
      }
      if (truncated) {
        const note = document.createElement('div');
        note.className = 'truncated-note';
        note.textContent = t.keysTruncated;
        container.appendChild(note);
      }
    }

    function renderKeyPreview(result) {
      const area = document.getElementById('redis-preview');
      area.textContent = '';
      if (!result.ok) {
        showError(result.error);
        return;
      }
      clearError();
      const title = document.createElement('div');
      title.className = 'preview-title';
      title.textContent = result.key;
      area.appendChild(title);
      const fields = result.fields || {};
      const names = Object.keys(fields);
      if (names.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty-note';
        empty.textContent = t.keyPreviewEmpty;
        area.appendChild(empty);
        return;
      }
      const tableEl = document.createElement('table');
      tableEl.className = 'kode-table';
      const thead = document.createElement('thead');
      const headRow = document.createElement('tr');
      const thF = document.createElement('th');
      thF.textContent = t.colField;
      headRow.appendChild(thF);
      const thV = document.createElement('th');
      thV.textContent = t.colValue;
      headRow.appendChild(thV);
      thead.appendChild(headRow);
      tableEl.appendChild(thead);
      const tbody = document.createElement('tbody');
      for (const name of names) {
        const tr = document.createElement('tr');
        const tdF = document.createElement('td');
        tdF.textContent = name;
        tr.appendChild(tdF);
        const tdV = document.createElement('td');
        tdV.textContent = String(fields[name]);
        tr.appendChild(tdV);
        tbody.appendChild(tr);
      }
      tableEl.appendChild(tbody);
      area.appendChild(tableEl);
    }

    document.getElementById('load-tables-btn')?.addEventListener('click', () => {
      if (document.getElementById('load-tables-btn').disabled) {
        return;
      }
      clearError();
      vscode.postMessage({ command: 'loadTables' });
    });

    document.getElementById('scan-keys-btn')?.addEventListener('click', () => {
      if (document.getElementById('scan-keys-btn').disabled) {
        return;
      }
      clearError();
      vscode.postMessage({ command: 'scanKeys' });
    });

    // 扩展侧重绘结果:一律 textContent 渲染(表名/键名/单元格值/哈希字段
    // 都不过 innerHTML 裸串,KR-AUD-50/53 双保险)
    window.addEventListener('message', event => {
      const message = event.data;
      switch (message.command) {
        case 'tablesLoaded':
          if (message.result.ok) {
            clearError();
            renderTables(message.result.tables);
          } else {
            showError(message.result.error);
          }
          break;
        case 'tablePreview':
          renderTablePreview(message.result);
          break;
        case 'keysLoaded':
          if (message.result.ok) {
            clearError();
            renderKeys(message.result.keys, message.result.truncated);
          } else {
            showError(message.result.error);
          }
          break;
        case 'keyPreview':
          renderKeyPreview(message.result);
          break;
      }
    });

    // DOM 就绪自动首载(按配置后端);无档案(none)不出首载
    window.addEventListener('DOMContentLoaded', () => {
      if (dbType === 'mysql') {
        vscode.postMessage({ command: 'loadTables' });
      } else if (dbType === 'redis') {
        vscode.postMessage({ command: 'scanKeys' });
      }
    });
  </script>
</body>
</html>`;
}
