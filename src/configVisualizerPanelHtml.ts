/**
 * 配置合并可视化 WebView 的 HTML 模板半边(SRC-012,docs/design/
 * config-visualization.md §10):纯字符串生产,不触 vscode API。
 *
 * 安全纪律(§11):
 * - 壳内零键名/零键值——配置数据只经 postMessage 达前端;
 * - 整页 nonce CSP(webviewScriptCsp,零外联资源,无 CDN/无本地媒体);
 * - 文案经 webviewStrings 一次注入(toJsonForScript,内联 JSON 唯一合法
 *   通道;函数形文案先反推成 `{n}` 占位模板,JSON 不带函数);
 * - 前端对 resolve 数据一律 createElement/textContent,绝不拼 HTML。
 */

import { WEBVIEW_THEME_CSS } from './webviewTheme';
import { htmlLang, resolvePanelLocale, strings } from './webviewStrings';
import { toJsonForScript, webviewScriptCsp } from './webviewSecurity';

export interface ConfigVisualizerWebviewOptions {
  /** 面板标题(webviewStrings configVisualizer.title) */
  title: string;
  /** 本次渲染 nonce(整页 CSP 脚本许可) */
  nonce: string;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 函数形文案 → 客户端 `{n}` 占位模板(sentinel 探针反推占位位置;JSON 通道
 * 不带函数,webviewStrings 仍是唯一文案源)。
 */
function toTemplate(fn: (...args: never[]) => string, arity: number): string {
  const sentinels = Array.from({ length: arity }, (_, i) => `\u0000${i}\u0000`);
  let out = (fn as (...args: string[]) => string)(...sentinels);
  sentinels.forEach((sentinel, i) => {
    out = out.split(sentinel).join(`{${i}}`);
  });
  return out;
}

export function renderConfigVisualizerWebview(options: ConfigVisualizerWebviewOptions): string {
  const t = strings(resolvePanelLocale()).configVisualizer;
  const nonce = options.nonce;
  const title = escapeHtml(options.title);
  // JSON 通道:函数形键换模板字符串(客户端 fmt 还原),纯文本键原样
  const clientStrings = {
    ...t,
    sectionMeta: toTemplate(t.sectionMeta, 3),
    statusSummary: toTemplate(t.statusSummary, 4),
    copyFailed: toTemplate(t.copyFailed, 1),
    valueTruncated: ''
  };

  return `<!DOCTYPE html>
<html lang="${htmlLang(resolvePanelLocale())}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <!-- 最小 CSP(§11):default-src 'none' 断掉一切外联/外帧/连接;本面板零
       媒体资源,脚本只认本次渲染 nonce,无任何外联脚本 -->
  <meta http-equiv="Content-Security-Policy" content="${webviewScriptCsp(nonce)}">
  <title>${title}</title>
  <style>
    ${WEBVIEW_THEME_CSS}
    body { padding: 0; }

    .viz-header {
      padding: 10px 16px;
      border-bottom: 1px solid var(--kode-border);
      background: var(--kode-surface);
    }
    .viz-title-row {
      display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
    }
    .viz-title { font-size: var(--kode-t-h1); font-weight: 600; color: #fff; }
    .source-badge {
      display: inline-flex; align-items: center;
      font-size: var(--kode-t-tag); padding: 2px 10px; border-radius: 10px;
      background: var(--kode-info-dim); color: var(--kode-info);
    }
    .viz-toolbar {
      display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
      margin-left: auto;
    }
    .viz-toolbar label { font-size: var(--kode-t-meta); color: var(--kode-fg-3); }
    .viz-toolbar .kode-inp { width: 180px; }
    .filter-group { display: flex; gap: 4px; }
    .filter-group .kode-btn[aria-pressed="true"] {
      background: var(--kode-accent); color: #fff; border-color: transparent;
    }
    .paths-line {
      display: flex; gap: 16px; flex-wrap: wrap;
      margin-top: 6px; font-size: var(--kode-t-tag); color: var(--kode-fg-3);
    }
    .paths-line .path-item { word-break: break-all; }
    .notice-row { margin-top: 8px; display: grid; gap: 6px; }
    #cfg-loading { color: var(--kode-fg-3); font-size: var(--kode-t-meta); }

    .viz-layout {
      display: flex; gap: 12px; align-items: stretch;
      padding: 12px 16px;
    }
    .viz-tree-col {
      width: 230px; flex: none; overflow: auto;
      border: 1px solid var(--kode-border); border-radius: var(--kode-r);
      background: var(--kode-surface);
      max-height: calc(100vh - 220px);
    }
    .viz-key-col {
      flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column;
      border: 1px solid var(--kode-border); border-radius: var(--kode-r);
      background: var(--kode-surface);
      max-height: calc(100vh - 220px);
    }
    .viz-detail-col {
      width: 330px; flex: none; overflow: auto;
      border: 1px solid var(--kode-border); border-radius: var(--kode-r);
      background: var(--kode-surface);
      max-height: calc(100vh - 220px);
      padding: 10px 12px;
    }
    #cfg-tree, #cfg-list { outline: none; }
    .tree-group-label {
      padding: 8px 12px 4px; font-size: var(--kode-t-meta); font-weight: 600;
      color: var(--kode-fg-3); text-transform: uppercase; letter-spacing: .05em;
    }
    .tree-item {
      display: flex; align-items: center; gap: 6px;
      padding: 4px 12px 4px 20px; cursor: pointer;
      font-size: var(--kode-t-body); color: var(--kode-fg-2);
    }
    .tree-item:focus, .key-row:focus { outline: 2px solid var(--kode-accent); outline-offset: -2px; }
    .tree-item[aria-selected="true"] {
      background: var(--kode-surface-2); color: #fff; font-weight: 600;
    }
    .tree-name { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .tree-count {
      font-family: var(--kode-mono); font-size: var(--kode-t-tag);
      border-radius: 8px; padding: 0 6px;
    }
    .tree-count.override { background: var(--kode-info-dim); color: var(--kode-info); }
    .tree-count.custom { background: var(--kode-ok-dim); color: var(--kode-ok); }

    #cfg-list-head {
      padding: 8px 12px; border-bottom: 1px solid var(--kode-border);
      flex: none;
    }
    #cfg-list { overflow: auto; flex: 1 1 auto; }
    .key-row {
      display: flex; align-items: center; gap: 10px;
      padding: 5px 12px; cursor: pointer; border-bottom: 1px solid var(--kode-border-soft);
    }
    .key-row[aria-selected="true"] { background: var(--kode-surface-2); }
    .key-name { flex: 0 0 auto; font-family: var(--kode-mono); font-size: var(--kode-t-meta); }
    .key-section {
      flex: none; font-size: var(--kode-t-tag); color: var(--kode-fg-3);
      border: 1px solid var(--kode-border); border-radius: 8px; padding: 0 6px;
    }
    .key-value {
      flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis;
      white-space: nowrap; font-size: var(--kode-t-tag); color: var(--kode-fg-3);
    }
    .state-badge {
      flex: none; display: inline-flex; align-items: center; gap: 5px;
      font-size: var(--kode-t-tag); padding: 1px 8px; border-radius: 10px;
    }
    .state-badge i { width: 7px; height: 7px; display: inline-block; }
    /* 三态不靠颜色单通道(§4.1):文字徽标 + 形状差异(◦ 圆点/■ 方角/● 实心圆) */
    .state-badge.defaults-only { background: rgba(128,128,128,.15); color: var(--kode-fg-2); }
    .state-badge.defaults-only i { border: 1px solid var(--kode-neutral); border-radius: 50%; }
    .state-badge.overridden { background: var(--kode-info-dim); color: var(--kode-info); }
    .state-badge.overridden i { background: var(--kode-info); border-radius: 1px; }
    .state-badge.custom-only { background: var(--kode-ok-dim); color: var(--kode-ok); }
    .state-badge.custom-only i { background: var(--kode-ok); border-radius: 50%; }

    .detail-path {
      font-family: var(--kode-mono); font-size: var(--kode-t-meta);
      word-break: break-all; margin-bottom: 8px;
    }
    .detail-doc { font-size: var(--kode-t-meta); color: var(--kode-fg-2); margin: 8px 0; }
    .detail-doc .doc-label { color: var(--kode-fg-3); margin-right: 6px; }
    .detail-values { border: 1px solid var(--kode-border); border-radius: var(--kode-r); margin: 10px 0; }
    .detail-values .value-row { padding: 8px 10px; border-bottom: 1px solid var(--kode-border-soft); }
    .detail-values .value-row:last-child { border-bottom: none; }
    .value-row .value-label {
      display: inline-block; min-width: 64px; font-size: var(--kode-t-meta);
      color: var(--kode-fg-3);
    }
    .value-row .value-text {
      font-family: var(--kode-mono); font-size: var(--kode-t-meta);
      word-break: break-all; white-space: pre-wrap;
    }
    .value-row .value-from {
      display: block; margin-top: 2px; font-size: var(--kode-t-tag); color: var(--kode-fg-4);
    }
    .detail-comments { margin: 10px 0; }
    .detail-comments .comment-line {
      font-family: var(--kode-mono); font-size: var(--kode-t-tag);
      color: var(--kode-fg-3); word-break: break-all;
      padding: 4px 8px; background: var(--kode-surface-2);
      border-radius: var(--kode-r); margin-top: 4px; white-space: pre-wrap;
    }
    .detail-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
    .viz-footer {
      padding: 8px 16px; border-top: 1px solid var(--kode-border);
      display: flex; align-items: center; gap: 12px;
      font-size: var(--kode-t-meta); color: var(--kode-fg-3);
    }
    .visually-hidden {
      position: absolute; width: 1px; height: 1px; overflow: hidden;
      clip: rect(0 0 0 0); white-space: nowrap;
    }
  </style>
</head>
<body>
  <div class="viz-header">
    <div class="viz-title-row">
      <span class="viz-title">${title}</span>
      <span id="cfg-badge" class="source-badge" hidden></span>
      <div class="viz-toolbar">
        <label for="cfg-search">${escapeHtml(t.searchLabel)}</label>
        <input id="cfg-search" class="kode-inp" type="text" placeholder="${escapeHtml(t.searchPlaceholder)}" autocomplete="off" spellcheck="false">
        <div class="filter-group" role="radiogroup" aria-label="${escapeHtml(t.filterLabel)}">
          <button id="cfg-filter-all" class="kode-btn" type="button" aria-pressed="true">${escapeHtml(t.filterAll)}</button>
          <button id="cfg-filter-overridden" class="kode-btn" type="button" aria-pressed="false">${escapeHtml(t.filterOverridden)}</button>
          <button id="cfg-filter-custom" class="kode-btn" type="button" aria-pressed="false">${escapeHtml(t.filterCustomOnly)}</button>
          <button id="cfg-filter-defaults" class="kode-btn" type="button" aria-pressed="false">${escapeHtml(t.filterDefaultsOnly)}</button>
        </div>
        <button id="cfg-refresh" class="kode-btn primary" type="button">${escapeHtml(t.refresh)}</button>
        <button id="cfg-open-text" class="kode-btn" type="button">${escapeHtml(t.openTextButton)}</button>
      </div>
    </div>
    <div id="cfg-paths" class="paths-line"></div>
    <div class="notice-row">
      <div id="cfg-warning" class="kode-notice warn" role="status" hidden></div>
      <div id="cfg-error" class="kode-notice err" role="status" hidden></div>
      <div id="cfg-loading" role="status">${escapeHtml(t.loading)}</div>
    </div>
  </div>

  <div class="viz-layout">
    <div class="viz-tree-col">
      <div id="cfg-tree" role="tree" aria-label="${escapeHtml(t.sectionTreeLabel)}" tabindex="0"></div>
    </div>
    <div class="viz-key-col">
      <div id="cfg-list-head"></div>
      <div id="cfg-list" role="listbox" aria-label="${escapeHtml(t.keyListLabel)}" tabindex="0"></div>
    </div>
    <div class="viz-detail-col">
      <div id="cfg-detail-title" class="kode-sect-t">${escapeHtml(t.detailRegionLabel)}</div>
      <div id="cfg-detail-body" role="complementary" aria-labelledby="cfg-detail-title"></div>
    </div>
  </div>

  <div class="viz-footer">
    <span id="cfg-status"></span>
    <span id="cfg-live" role="status" aria-live="polite" class="visually-hidden"></span>
  </div>

  <script nonce="${nonce}">
    var vscode = acquireVsCodeApi();
    var T = ${toJsonForScript(clientStrings)};

    function fmt(tpl, args) {
      var out = tpl;
      for (var i = 0; i < args.length; i++) {
        out = out.split('{' + i + '}').join(args[i] === undefined ? '' : String(args[i]));
      }
      return out;
    }
    function el(id) { return document.getElementById(id); }
    function clear(node) { while (node.firstChild) { node.removeChild(node.firstChild); } }
    function textEl(tag, className, text) {
      var node = document.createElement(tag);
      if (className) { node.className = className; }
      node.textContent = text;
      return node;
    }

    var state = {
      generation: -1,
      summary: null,
      sectionId: null,
      selected: null,
      filter: 'all',
      search: '',
      searchTimer: null,
      detail: null
    };

    var FILTER_BUTTONS = [
      ['cfg-filter-all', 'all'],
      ['cfg-filter-overridden', 'overridden'],
      ['cfg-filter-custom', 'custom-only'],
      ['cfg-filter-defaults', 'defaults-only']
    ];

    function stateText(stateName) {
      if (stateName === 'defaults-only') { return T.stateDefaultsOnly; }
      if (stateName === 'overridden') { return T.stateOverridden; }
      return T.stateCustomOnly;
    }

    function stateBadge(stateName) {
      var badge = document.createElement('span');
      badge.className = 'state-badge ' + stateName;
      badge.appendChild(document.createElement('i'));
      badge.appendChild(document.createTextNode(stateText(stateName)));
      return badge;
    }

    function announce(text) { el('cfg-live').textContent = text; }

    function findSection(sectionId) {
      if (!state.summary) { return null; }
      for (var g = 0; g < state.summary.groups.length; g++) {
        var sections = state.summary.groups[g].sections;
        for (var s = 0; s < sections.length; s++) {
          if (sections[s].id === sectionId) { return sections[s]; }
        }
      }
      return null;
    }

    // ---- 段树 ----
    function renderTree() {
      var tree = el('cfg-tree');
      clear(tree);
      if (!state.summary) { return; }
      var groups = state.summary.groups || [];
      for (var g = 0; g < groups.length; g++) {
        var group = groups[g];
        if (!group.sections || group.sections.length === 0) { continue; }
        var label = textEl('div', 'tree-group-label',
          group.id === 'process' ? T.groupProcess : T.groupGlobal);
        label.setAttribute('role', 'treeitem');
        label.setAttribute('aria-expanded', 'true');
        tree.appendChild(label);
        var inner = document.createElement('div');
        inner.setAttribute('role', 'group');
        for (var s = 0; s < group.sections.length; s++) {
          var section = group.sections[s];
          var item = document.createElement('div');
          item.className = 'tree-item';
          item.setAttribute('role', 'treeitem');
          item.setAttribute('tabindex', '-1');
          item.setAttribute('data-section', section.id);
          item.appendChild(textEl('span', 'tree-name', section.id));
          if (section.overrideCount > 0) {
            item.appendChild(textEl('span', 'tree-count override', String(section.overrideCount)));
          }
          if (section.customOnlyCount > 0) {
            item.appendChild(textEl('span', 'tree-count custom', String(section.customOnlyCount)));
          }
          item.addEventListener('click', makeSectionHandler(section.id));
          inner.appendChild(item);
        }
        tree.appendChild(inner);
      }
      updateTreeSelection();
      focusFirstTreeItem();
    }

    function treeItems() {
      return Array.prototype.slice.call(
        el('cfg-tree').querySelectorAll('.tree-item')
      );
    }

    function focusFirstTreeItem() {
      var items = treeItems();
      for (var i = 0; i < items.length; i++) {
        items[i].setAttribute('tabindex', i === 0 ? '0' : '-1');
      }
    }

    function updateTreeSelection() {
      var items = treeItems();
      for (var i = 0; i < items.length; i++) {
        var selected = items[i].getAttribute('data-section') === state.sectionId;
        items[i].setAttribute('aria-selected', selected ? 'true' : 'false');
      }
    }

    function makeSectionHandler(sectionId) {
      return function () { selectSection(sectionId); };
    }

    function selectSection(sectionId) {
      state.sectionId = sectionId;
      state.selected = null;
      updateTreeSelection();
      renderKeyList();
      state.detail = null;
      renderDetail();
    }

    // ---- 键列表 ----
    function applyFilter(rows) {
      if (state.filter === 'all') { return rows; }
      var filtered = [];
      for (var i = 0; i < rows.length; i++) {
        if (rows[i].entry.state === state.filter) { filtered.push(rows[i]); }
      }
      return filtered;
    }

    function currentEntries() {
      if (!state.summary) { return []; }
      var rows = [];
      if (state.search) {
        var q = state.search.toLowerCase();
        for (var g = 0; g < state.summary.groups.length; g++) {
          var sections = state.summary.groups[g].sections;
          for (var s = 0; s < sections.length; s++) {
            var keys = sections[s].keys;
            for (var k = 0; k < keys.length; k++) {
              // 内容搜索:键名或最终值任一命中即入列(值转小写匹配)
              if (keys[k].name.toLowerCase().indexOf(q) !== -1 ||
                  String(keys[k].finalValue).toLowerCase().indexOf(q) !== -1) {
                rows.push({ sectionId: sections[s].id, entry: keys[k] });
              }
            }
          }
        }
      } else {
        var section = findSection(state.sectionId);
        if (section) {
          for (var k2 = 0; k2 < section.keys.length; k2++) {
            rows.push({ sectionId: section.id, entry: section.keys[k2] });
          }
        }
      }
      return applyFilter(rows);
    }

    function renderKeyList() {
      var head = el('cfg-list-head');
      var list = el('cfg-list');
      clear(head);
      clear(list);
      if (!state.summary) { return; }
      var rows = currentEntries();
      if (state.search) {
        head.appendChild(textEl('span', 'kode-sect-t',
          T.searchResultHeading + ' (' + rows.length + ')'));
      } else {
        var section = findSection(state.sectionId);
        head.appendChild(textEl('span', 'kode-sect-t', section
          ? fmt(T.sectionMeta, [section.keyCount, section.overrideCount, section.customOnlyCount])
          : T.sectionTreeLabel));
      }
      if (rows.length === 0) {
        list.appendChild(textEl('div', 'kode-empty', state.search ? T.noSearchHits : ''));
        return;
      }
      for (var i = 0; i < rows.length; i++) {
        var row = document.createElement('div');
        row.className = 'key-row';
        row.setAttribute('role', 'option');
        row.setAttribute('tabindex', '-1');
        row.setAttribute('data-section-id', rows[i].sectionId);
        row.setAttribute('data-path', rows[i].entry.path);
        row.appendChild(textEl('span', 'key-name', rows[i].entry.name));
        if (state.search) {
          row.appendChild(textEl('span', 'key-section', rows[i].sectionId));
        }
        var value = textEl('span', 'key-value kode-mono', rows[i].entry.finalValue);
        value.title = rows[i].entry.finalValue;
        row.appendChild(value);
        row.appendChild(stateBadge(rows[i].entry.state));
        row.addEventListener('click', makeKeyHandler(rows[i].sectionId, rows[i].entry.path));
        list.appendChild(row);
      }
      updateKeySelection();
    }

    function keyRows() {
      return Array.prototype.slice.call(
        el('cfg-list').querySelectorAll('.key-row')
      );
    }

    function updateKeySelection() {
      var rows = keyRows();
      for (var i = 0; i < rows.length; i++) {
        var selected = !!state.selected &&
          rows[i].getAttribute('data-section-id') === state.selected.sectionId &&
          rows[i].getAttribute('data-path') === state.selected.path;
        rows[i].setAttribute('aria-selected', selected ? 'true' : 'false');
        rows[i].setAttribute('tabindex', selected ? '0' : '-1');
      }
    }

    function makeKeyHandler(sectionId, path) {
      return function () { selectKey(sectionId, path); };
    }

    function selectKey(sectionId, path) {
      state.selected = { sectionId: sectionId, path: path };
      updateKeySelection();
      vscode.postMessage({ command: 'selectKey', sectionId: sectionId, path: path });
    }

    // ---- 键详情 ----
    function renderDetail() {
      var body = el('cfg-detail-body');
      clear(body);
      if (!state.detail) {
        body.appendChild(textEl('div', 'kode-empty', T.detailPlaceholder));
        return;
      }
      var detail = state.detail;
      var headRow = document.createElement('div');
      headRow.className = 'detail-path';
      headRow.appendChild(document.createTextNode(detail.sectionId + ' › ' + detail.path));
      headRow.appendChild(stateBadge(detail.state));
      body.appendChild(headRow);

      if (detail.restated) {
        body.appendChild(textEl('div', 'kode-notice info', T.restatedNote));
      }
      if (detail.mergedByTableReplace) {
        body.appendChild(textEl('div', 'kode-notice info', T.tableReplaceNote));
      }

      var doc = document.createElement('div');
      doc.className = 'detail-doc';
      doc.appendChild(textEl('span', 'doc-label', T.detailDoc));
      doc.appendChild(document.createTextNode(detail.catalogDoc || T.detailDocMissing));
      body.appendChild(doc);
      if (detail.catalogSource) {
        var source = document.createElement('div');
        source.className = 'detail-doc';
        source.appendChild(textEl('span', 'doc-label', T.detailDocSource));
        source.appendChild(document.createTextNode(detail.catalogSource));
        body.appendChild(source);
      }

      var values = document.createElement('div');
      values.className = 'detail-values';
      appendValueRow(values, T.detailDefaultValue,
        detail.defaultValue === null ? '-' : detail.defaultValue,
        detail.defaultValue === null ? null : T.detailFromDefaults);
      appendValueRow(values, T.detailOverrideValue,
        detail.overrideValue === null ? '-' : detail.overrideValue,
        detail.overrideValue === null && detail.state === 'custom-only'
          ? T.detailCustomOnlyNote
          : (detail.overrideValue === null ? null : T.detailFromCustom));
      appendValueRow(values, T.detailFinalValue, detail.finalValue, T.detailFinalNote);
      body.appendChild(values);

      if (detail.sourceComments && detail.sourceComments.length > 0) {
        var comments = document.createElement('div');
        comments.className = 'detail-comments';
        comments.appendChild(textEl('div', 'kode-sect-t', T.detailSourceComments));
        for (var i = 0; i < detail.sourceComments.length; i++) {
          comments.appendChild(textEl('div', 'comment-line', detail.sourceComments[i]));
        }
        body.appendChild(comments);
      }

      var actions = document.createElement('div');
      actions.className = 'detail-actions';
      var copyBtn = document.createElement('button');
      copyBtn.className = 'kode-btn primary';
      copyBtn.type = 'button';
      copyBtn.textContent = T.copyFragment;
      copyBtn.addEventListener('click', function () {
        vscode.postMessage({
          command: 'copyFragment',
          sectionId: detail.sectionId,
          path: detail.path
        });
      });
      actions.appendChild(copyBtn);
      if (state.summary && state.summary.defaultsPath) {
        actions.appendChild(openSourceButton(T.openDefaultsFile, 'defaults'));
      }
      if (state.summary && state.summary.customPath) {
        actions.appendChild(openSourceButton(T.openCustomFile, 'custom'));
      }
      body.appendChild(actions);
    }

    function appendValueRow(parent, label, value, fromNote) {
      var row = document.createElement('div');
      row.className = 'value-row';
      row.appendChild(textEl('span', 'value-label', label));
      row.appendChild(textEl('span', 'value-text', value));
      if (fromNote) {
        row.appendChild(textEl('span', 'value-from', fromNote));
      }
      parent.appendChild(row);
    }

    function openSourceButton(label, file) {
      var button = document.createElement('button');
      button.className = 'kode-btn';
      button.type = 'button';
      button.textContent = label;
      button.addEventListener('click', function () {
        vscode.postMessage({ command: 'openSource', file: file });
      });
      return button;
    }

    // ---- 状态区 ----
    function renderStatus() {
      var summary = state.summary;
      var status = el('cfg-status');
      if (!summary) { status.textContent = ''; return; }
      var sections = 0;
      var keys = 0;
      var overridden = 0;
      var customOnly = 0;
      for (var g = 0; g < summary.groups.length; g++) {
        var list = summary.groups[g].sections;
        for (var i = 0; i < list.length; i++) {
          sections += 1;
          keys += list[i].keyCount;
          overridden += list[i].overrideCount;
          customOnly += list[i].customOnlyCount;
        }
      }
      status.textContent = fmt(T.statusSummary, [sections, keys, overridden, customOnly]);
    }

    function renderPaths() {
      var summary = state.summary;
      var line = el('cfg-paths');
      clear(line);
      if (!summary) { return; }
      line.appendChild(textEl('span', 'path-item',
        'defaults: ' + (summary.defaultsPath || '-')));
      line.appendChild(textEl('span', 'path-item',
        'kbengine.xml: ' + (summary.customPath || T.pathCustomMissing)));
    }

    function updateFilterButtons() {
      var defaultsOnly = !state.summary || state.summary.defaultsOnly;
      for (var i = 0; i < FILTER_BUTTONS.length; i++) {
        var id = FILTER_BUTTONS[i][0];
        var value = FILTER_BUTTONS[i][1];
        var button = el(id);
        button.setAttribute('aria-pressed', state.filter === value ? 'true' : 'false');
        if ((value === 'overridden' || value === 'custom-only') && defaultsOnly) {
          button.disabled = true;
        } else {
          button.disabled = false;
        }
      }
      if ((state.filter === 'overridden' || state.filter === 'custom-only') && defaultsOnly) {
        state.filter = 'all';
        el('cfg-filter-all').setAttribute('aria-pressed', 'true');
      }
    }

    function renderAll() {
      var badge = el('cfg-badge');
      badge.textContent = T.sourceBadgeRust;
      badge.hidden = false;
      var warning = el('cfg-warning');
      warning.textContent = T.defaultsOnlyWarning;
      warning.hidden = !state.summary.defaultsOnly;
      el('cfg-error').hidden = true;
      el('cfg-loading').hidden = true;
      if (!state.sectionId) {
        var firstProcess = state.summary.groups[0] && state.summary.groups[0].sections[0];
        state.sectionId = firstProcess ? firstProcess.id : null;
        if (!state.sectionId && state.summary.groups[1]) {
          state.sectionId = state.summary.groups[1].sections.length > 0
            ? state.summary.groups[1].sections[0].id
            : null;
        }
      }
      updateFilterButtons();
      renderTree();
      renderKeyList();
      renderDetail();
      renderPaths();
      renderStatus();
    }

    function showEmptyState(text) {
      el('cfg-badge').hidden = true;
      el('cfg-warning').hidden = true;
      el('cfg-error').hidden = true;
      el('cfg-loading').hidden = true;
      clear(el('cfg-tree'));
      clear(el('cfg-list-head'));
      var list = el('cfg-list');
      clear(list);
      list.appendChild(textEl('div', 'kode-empty', text));
      state.summary = null;
      state.detail = null;
      clear(el('cfg-detail-body'));
      clear(el('cfg-paths'));
      el('cfg-status').textContent = '';
      updateFilterButtons();
    }

    function showErrorState(error) {
      var banner = el('cfg-error');
      clear(banner);
      banner.appendChild(document.createTextNode(T.errorState + ': ' + error));
      var retry = document.createElement('button');
      retry.className = 'kode-btn';
      retry.type = 'button';
      retry.textContent = T.retry;
      retry.addEventListener('click', function () { requestRefresh(); });
      banner.appendChild(retry);
      banner.hidden = false;
      el('cfg-loading').hidden = true;
    }

    function requestRefresh() {
      el('cfg-error').hidden = true;
      var loading = el('cfg-loading');
      loading.textContent = T.loading;
      loading.hidden = false;
      vscode.postMessage({ command: 'refresh' });
    }

    // ---- resolveState 六态分流(§8;2026-11-11 修正后无 ts-fallback 态) ----
    function applyResolve(message) {
      if (typeof message.generation !== 'number' || message.generation < state.generation) {
        return;
      }
      state.generation = message.generation;
      var result = message.result;
      if (result.ok) {
        state.summary = result.data;
        state.detail = null;
        state.sectionId = null;
        state.selected = null;
        renderAll();
      } else if (result.errorKind === 'no-workspace') {
        showEmptyState(T.emptyNoWorkspace);
      } else if (result.errorKind === 'no-config') {
        showEmptyState(T.emptyNoConfig);
      } else {
        showErrorState(result.error);
      }
    }

    function applyKeyDetail(message) {
      // 前端只认最新代(与控制器 canWriteRefresh 双保险,§6.1-2)
      if (message.generation !== state.generation) { return; }
      if (message.result.ok) {
        state.detail = message.result.data;
        renderDetail();
      } else if (message.result.error) {
        announce(message.result.error);
      }
    }

    // ---- 交互接线(nonce CSP 下内联事件处理器不执行,一律脚本绑定) ----
    el('cfg-refresh').addEventListener('click', function () { requestRefresh(); });
    el('cfg-open-text').addEventListener('click', function () {
      vscode.postMessage({ command: 'openTextView' });
    });
    for (var f = 0; f < FILTER_BUTTONS.length; f++) {
      (function (pair) {
        el(pair[0]).addEventListener('click', function () {
          state.filter = pair[1];
          updateFilterButtons();
          renderKeyList();
        });
      })(FILTER_BUTTONS[f]);
    }
    el('cfg-search').addEventListener('input', function (event) {
      var value = event.target.value;
      if (state.searchTimer) { clearTimeout(state.searchTimer); }
      state.searchTimer = setTimeout(function () {
        state.searchTimer = null;
        state.search = value.trim();
        renderKeyList();
      }, 150);
    });
    el('cfg-search').addEventListener('keydown', function (event) {
      if (event.key === 'Escape') {
        event.target.value = '';
        state.search = '';
        renderKeyList();
      }
    });

    // roving tabindex:↑/↓ 在段树/键列表内移动焦点,Enter/Space 激活(§5.2)
    el('cfg-tree').addEventListener('keydown', function (event) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        moveRovingFocus(el('cfg-tree'), '.tree-item', event.key === 'ArrowDown' ? 1 : -1);
      } else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        var active = document.activeElement;
        if (active && active.getAttribute && active.getAttribute('data-section')) {
          selectSection(active.getAttribute('data-section'));
        }
      }
    });
    el('cfg-list').addEventListener('keydown', function (event) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        moveRovingFocus(el('cfg-list'), '.key-row', event.key === 'ArrowDown' ? 1 : -1);
      } else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        var active = document.activeElement;
        if (active && active.getAttribute && active.getAttribute('data-path')) {
          selectKey(active.getAttribute('data-section-id'), active.getAttribute('data-path'));
        }
      }
    });
    function moveRovingFocus(container, selector, delta) {
      var items = Array.prototype.slice.call(container.querySelectorAll(selector));
      if (items.length === 0) { return; }
      var index = items.indexOf(document.activeElement);
      index = index === -1 ? 0 : Math.min(Math.max(index + delta, 0), items.length - 1);
      for (var i = 0; i < items.length; i++) {
        items[i].setAttribute('tabindex', i === index ? '0' : '-1');
      }
      items[index].focus();
    }

    window.addEventListener('message', function (event) {
      var message = event.data || {};
      if (message.command === 'resolveState') {
        applyResolve(message);
      } else if (message.command === 'keyDetail') {
        applyKeyDetail(message);
      } else if (message.command === 'copyDone') {
        var result = message.result;
        announce(result && result.ok
          ? T.copyDone
          : fmt(T.copyFailed, [result && result.error ? result.error : '']));
      }
    });

    vscode.postMessage({ command: 'ready' });
  </script>
</body>
</html>`;
}
