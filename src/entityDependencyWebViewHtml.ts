/**
 * KBEngine 实体依赖/调用图 WebView 的 HTML 模板半边(SRC-012 自
 * entityDependencyWebView.ts 纯移动迁出)。
 *
 * 内容:双模式 WebView 的整页 HTML/CSS/内联脚本生产(renderEntityDependencyWebview)
 * 及私有渲染辅助(escapeHtml/statGroup/statCard)。区域原文零改动,仅
 * `this` 面板状态(标题/模式/mermaidUri/cspSource/nonce)改为入参 options;
 * 控制器(entityDependencyWebView.ts)负责面板生命周期/数据获取/消息处理,
 * 本模块只做字符串生产,不触 vscode API(与 messageTableRender.ts 同口径)。
 */

import type { RenderGraph } from './entityDependencyGraphView';
import {
  CALLGRAPH_MAX_FILES,
  callGraphLegendHtml,
  type CallGraphGraph
} from './entityCallGraphView';
import { WEBVIEW_THEME_CSS } from './webviewTheme';
import { htmlLang, resolvePanelLocale, strings } from './webviewStrings';
import { webviewScriptCsp } from './webviewSecurity';

/** 面板双模式。 */
export type DependencyPanelMode = 'dependency' | 'callgraph';

export interface EntityDependencyWebviewOptions {
  mode: DependencyPanelMode;
  /** 面板标题(双模式)。 */
  title: string;
  /** 已生成的 mermaid 图文本(空串时出占位/空图注记)。 */
  mermaidGraph: string;
  /** dependency 模式归一渲染图;callgraph 模式为 null。 */
  graph: RenderGraph | null;
  /** callgraph 模式归一调用图;dependency 模式为 null。 */
  callGraph: CallGraphGraph | null;
  /** callgraph 模式 Rust 不可用(出「Rust 不可用」徽标 + 空图注记)。 */
  rustUnavailable: boolean;
  /** mermaid.tiny.js 的 webview 资源 URI(扩展自带,离线打包)。 */
  mermaidUri: string;
  /** panel.webview.cspSource(与资源同源);无面板时回退 'vscode-webview:'。 */
  cspSource: string;
  /** 本次渲染 nonce(整页 CSP 脚本许可)。 */
  nonce: string;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** UI-05:统计卡按业务域分组,组头 <details> 可折叠并带条目计数 */
function statGroup(domain: string, label: string, cards: string[]): string {
  return `      <details class="stat-group" data-domain="${domain}" open>
        <summary><span>${label}</span><span class="gcount" data-count="${cards.length}">${cards.length}</span></summary>
        <div class="stat-cards">
${cards.join('\n')}
        </div>
      </details>`;
}

/** 统计卡 HTML 生产(KR-AUD-53:label/value 双面转义;导出供测试直调)。 */
export function statCard(label: string, value: string | number): string {
  // KR-AUD-53:value 面会落到进程角色串/最常引用实体名等来自扫描结果的
  // 字符串面,与 label 一并转义(标签注入)
  return `      <div class="stat-card">
        <div class="stat-label">${escapeHtml(String(label))}</div>
        <div class="stat-value">${escapeHtml(String(value))}</div>
      </div>`;
}

/**
 * 获取 Webview 内容(双模式:dependency 渲染 RenderGraph;callgraph 渲染
 * CallGraphGraph,Rust 不可用时出空图注记)
 */
export function renderEntityDependencyWebview(
  options: EntityDependencyWebviewOptions
): string {
  const { graph, callGraph, rustUnavailable, mermaidGraph } = options;
  const t = strings(resolvePanelLocale()).entityDependency;
  const title = options.title;
  // KR-AUD-50/53:整页 nonce CSP + mermaid 离线打包(media/mermaid.tiny.js,
  // 经 asWebviewUri 取与 cspSource 同源的 URI),脚本不再依赖 CDN;
  // 图片源只给导出用的 data:/blob: 开洞。
  const nonce = options.nonce;
  const cspSource = options.cspSource;
  const mermaidUri = options.mermaidUri;
  const isCallGraph = options.mode === 'callgraph';
  const sourceBadge = isCallGraph
    ? rustUnavailable
      ? 'Rust 不可用'
      : 'Rust 核心'
    : graph && graph.source === 'rust'
      ? 'Rust 核心'
      : 'TS 兜底';

  const statsHtml = isCallGraph
    ? [
      // KODE-PERF-004:截断时如实显示「已收集 / 实际发现(截断)」,不装完整。
      statCard('文件', callGraph?.stats.truncated
        ? `${callGraph.stats.fileCount} / ${callGraph.stats.totalDiscovered ?? callGraph.stats.fileCount}（截断）`
        : (callGraph?.stats.fileCount ?? 0)),
      statCard('节点', callGraph?.stats.nodeCount ?? 0),
      statCard('调用边', callGraph?.stats.edgeCount ?? 0),
      statCard('语法错误', callGraph?.stats.errorCount ?? 0),
      statCard(
        '进程角色',
        callGraph && callGraph.processRoles.length > 0
          ? callGraph.processRoles.join(', ')
          : '-'
      )
    ].join('\n')
    : graph && graph.source === 'rust'
      ? [
        statGroup('graph', t.groupGraph, [
          statCard(t.nodes, graph.stats.nodeCount),
          statCard(t.edges, graph.stats.edgeCount)
        ]),
        statGroup('defs', t.groupDefs, [
          statCard(t.entities, graph.stats.entityCount),
          statCard(t.defs, graph.stats.defCount),
          statCard(t.interfaces, graph.stats.interfaceCount),
          statCard(t.components, graph.stats.componentCount),
          statCard(t.types, graph.stats.typeCount),
          statCard(t.python, graph.stats.pythonCount)
        ])
      ].join('\n')
      : [
        statGroup('inheritance', t.groupInheritance, [
          statCard(t.totalEntities, graph?.legacyStats?.totalEntities ?? 0),
          statCard(t.baseEntities, graph?.legacyStats?.baseEntities ?? 0),
          statCard(t.cellEntities, graph?.legacyStats?.cellEntities ?? 0),
          statCard(t.clientEntities, graph?.legacyStats?.clientEntities ?? 0),
          statCard(t.maxDepth, graph?.legacyStats?.maxDepth ?? 0)
        ]),
        statGroup('hotspot', t.groupHotspot, [
          statCard(t.mostReferenced, graph?.legacyStats?.mostReferenced || '-')
        ])
      ].join('\n');

  const pathsHtml =
    !isCallGraph && graph && graph.paths
      ? `
  <div class="paths">
    <div class="path-item"><span class="path-label">entities.xml</span><code>${escapeHtml(graph.paths.entitiesXml)}</code></div>
    <div class="path-item"><span class="path-label">defsRoot</span><code>${escapeHtml(graph.paths.defsRoot)}</code></div>
    <div class="path-item"><span class="path-label">types.xml</span><code>${escapeHtml(graph.paths.typesXml)}</code></div>
  </div>`
      : '';

  // KODE-PERF-004:超 10,000 文件截断的明确策略——出可见警告条,绝不静默
  // 装完整(发现数/已收集数/上限都如实显示)。
  const callgraphWarningHtml =
    isCallGraph && callGraph?.stats.truncated
      ? `
  <div class="callgraph-warning">⚠ 超出 ${CALLGRAPH_MAX_FILES} 个 Python 文件上限,仅收集前 ${callGraph.stats.fileCount} 个(实际发现 ${callGraph.stats.totalDiscovered ?? callGraph.stats.fileCount} 个),调用图可能不完整。</div>`
      : '';

  const graphHtml = isCallGraph
    ? rustUnavailable
      ? `    <div class="loading">Rust 核心不可用(未配置 serverPath 或调用失败),调用图无法生成。</div>`
      : `
    <div class="mermaid">
${mermaidGraph}
    </div>`
    : `
    <div class="mermaid">
${mermaidGraph}
    </div>`;

  const legendHtml = isCallGraph
    ? callGraphLegendHtml()
    : `
    <div class="legend-item">
      <div class="legend-dot" style="background-color: #173a5e; border: 2px solid #3794ff;"></div>
      <span>Base 实体</span>
    </div>
    <div class="legend-item">
      <div class="legend-dot" style="background-color: #1d3a2a; border: 2px solid #89d185;"></div>
      <span>Cell 实体</span>
    </div>
    <div class="legend-item">
      <div class="legend-dot" style="background-color: #3a2d10; border: 2px solid #cca700;"></div>
      <span>Client 实体</span>
    </div>
    <div class="legend-item">
      <span>→ 继承关系</span>
    </div>`;

  return `<!DOCTYPE html>
<html lang="${htmlLang(resolvePanelLocale())}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <!-- 最小 CSP(KR-AUD-50/53):default-src 'none' 断掉一切外联/外帧/连接,
       脚本只认本次渲染 nonce + 扩展自带 media/mermaid.tiny.js(离线打包,
       与 cspSource 同源);mermaid securityLevel=strict 下其自带 click 回调被
       丢弃,打开文件改由面板脚本按 click 指令自绑(见下方事件委托)。 -->
  <meta http-equiv="Content-Security-Policy" content="${webviewScriptCsp(nonce, [cspSource], ['data:', 'blob:', cspSource])}">
  <title>${title}</title>
  <style>
    ${WEBVIEW_THEME_CSS}
    body {
      margin: 0;
      padding: 20px;
    }

    /* UI-05:统计卡按业务域分组(与 monitoring 同一分类管理范式) */
    .stat-group {
      border: 1px solid var(--kode-border);
      border-radius: var(--kode-r);
      background: var(--kode-surface);
      margin-bottom: 8px;
    }
    .stat-group > summary {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 14px;
      cursor: pointer;
      list-style: none;
      color: var(--kode-fg-3);
      font-size: var(--kode-t-meta);
      font-weight: 600;
    }
    .stat-group > summary::-webkit-details-marker { display: none; }
    .stat-group > summary::before { content: '▸'; color: var(--kode-fg-4); font-size: 10px; }
    .stat-group[open] > summary::before { content: '▾'; }
    .stat-group .gcount {
      background: var(--kode-surface-2);
      border: 1px solid var(--kode-border);
      border-radius: 8px;
      color: var(--kode-fg-3);
      font-family: var(--kode-mono);
      font-size: var(--kode-t-tag);
      font-weight: 400;
      padding: 0 7px;
    }
    .stat-group .stat-cards {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: 8px;
      padding: 0 14px 12px;
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

    .source-badge {
      font-size: 12px;
      padding: 4px 10px;
      border-radius: 10px;
      background-color: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
    }

    .toolbar {
      display: flex;
      gap: 10px;
    }

    button {
      background-color: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      padding: 8px 16px;
      cursor: pointer;
      border-radius: 2px;
    }

    button:hover {
      background-color: var(--vscode-button-hoverBackground);
    }

    .stats {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 15px;
      margin-bottom: 20px;
    }

    .stat-card {
      background-color: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      padding: 15px;
    }

    .stat-label {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 5px;
    }

    .stat-value {
      font-size: 24px;
      font-weight: bold;
    }

    .paths {
      background-color: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      padding: 15px;
      margin-bottom: 20px;
      font-size: 12px;
    }

    .path-item {
      display: flex;
      gap: 10px;
      margin-bottom: 6px;
    }

    .path-item:last-child {
      margin-bottom: 0;
    }

    .path-label {
      color: var(--vscode-descriptionForeground);
      min-width: 90px;
    }

    .path-item code {
      word-break: break-all;
    }

    #graph-container {
      background-color: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      padding: 20px;
      min-height: 400px;
    }

    .legend {
      display: flex;
      gap: 20px;
      margin-top: 20px;
      font-size: 12px;
    }

    .legend-item {
      display: flex;
      align-items: center;
      gap: 5px;
    }

    .legend-dot {
      width: 12px;
      height: 12px;
      border-radius: 50%;
    }

    .loading {
      text-align: center;
      padding: 50px;
      color: var(--vscode-descriptionForeground);
    }

    .callgraph-warning {
      background-color: var(--vscode-inputValidation-warningBackground, #5a3d00);
      border: 1px solid var(--vscode-inputValidation-warningBorder, #bd8b00);
      color: var(--vscode-inputValidation-warningForeground, var(--vscode-editor-foreground));
      border-radius: 4px;
      padding: 10px 15px;
      margin-bottom: 20px;
      font-size: 13px;
    }
  </style>
  <script src="${mermaidUri}"></script>
</head>
<body>
  <div class="header">
    <div class="title">${title}</div>
    <div style="display: flex; align-items: center; gap: 10px;">
      <span class="source-badge">${sourceBadge}</span>
      <div class="toolbar">
        <select id="mode-select" style="padding: 8px; background-color: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border);">
          <option value="dependency" ${isCallGraph ? '' : 'selected'}>实体依赖</option>
          <option value="callgraph" ${isCallGraph ? 'selected' : ''}>调用图</option>
        </select>
        <button id="refresh-graph-btn">刷新</button>
        <button id="export-png-btn">导出 PNG</button>
        <button id="export-svg-btn">导出 SVG</button>
      </div>
    </div>
  </div>

  <div class="stats">
${statsHtml}
  </div>
${pathsHtml}
${callgraphWarningHtml}

  <div id="graph-container">
${graphHtml}
  </div>

  <div class="legend">
${legendHtml}
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    // 初始化 Mermaid(KR-AUD-53:securityLevel=strict——标签经 DOMPurify 清洗,
    // 自带 click 回调在此级别被 mermaid 丢弃,故下方改为面板自绑)
    mermaid.initialize({
      startOnLoad: true,
      theme: 'default',
      securityLevel: 'strict',
      flowchart: {
        useMaxWidth: true,
        htmlLabels: true,
        curve: 'basis'
      }
    });

    // click 指令回调名保留(strict 下 mermaid 不再调用,图文本口径不变);
    // 真正的点击打开走下方事件委托,映射同样来自这些 click 指令。
    window.openFilePath = function(filePath) {
      vscode.postMessage({
        command: 'openNode',
        filePath: filePath
      });
    };

    // 节点 → 文件路径映射:渲染前从 .mermaid 源文本读 click 指令
    // (mermaid 渲染会替换该元素内容,必须在 DOMContentLoaded 前抓取)
    const openPaths = new Map();
    const openLabels = new Map();
    const mermaidSource = document.querySelector('#graph-container .mermaid');
    if (mermaidSource) {
      const text = mermaidSource.textContent || '';
      const nodeLabelRe = /^\\s*([A-Za-z0-9_]+)\\["((?:[^"\\\\]|\\\\.)*)"\\]/gm;
      const clickRe = /^\\s*click\\s+([A-Za-z0-9_]+)\\s+openFilePath\\s+"((?:[^"\\\\]|\\\\.)*)"/gm;
      const labels = new Map();
      let nodeMatch;
      while ((nodeMatch = nodeLabelRe.exec(text)) !== null) {
        labels.set(nodeMatch[1], nodeMatch[2]);
      }
      let clickMatch;
      while ((clickMatch = clickRe.exec(text)) !== null) {
        const filePath = clickMatch[2].replace(/\\\\"/g, '"');
        openPaths.set(clickMatch[1], filePath);
        const label = labels.get(clickMatch[1]);
        if (label !== undefined && !openLabels.has(label)) {
          openLabels.set(label, filePath);
        }
      }
    }

    // 事件委托:mermaid 渲染出的 g.node id 形如 <前缀><节点 id>-<序号>
    // (可带 diagramId 前缀),解析不出时回落节点标签文本
    function resolveOpenPath(node) {
      const domId = node.id || '';
      const idMatch = /(?:^|[^A-Za-z0-9_])([A-Za-z0-9_]+)-\\d+$/.exec(domId);
      if (idMatch && openPaths.has(idMatch[1])) {
        return openPaths.get(idMatch[1]);
      }
      if (openPaths.has(domId)) {
        return openPaths.get(domId);
      }
      const labelEl = node.querySelector('.label');
      const label = labelEl ? (labelEl.textContent || '').trim() : '';
      return openLabels.get(label) || null;
    }

    const graphContainer = document.getElementById('graph-container');
    if (graphContainer) {
      graphContainer.addEventListener('click', event => {
        const target = event.target;
        const node = target && typeof target.closest === 'function'
          ? target.closest('g.node')
          : null;
        if (!node) {
          return;
        }
        const filePath = resolveOpenPath(node);
        if (filePath) {
          vscode.postMessage({ command: 'openNode', filePath: filePath });
        }
      });
    }

    // 工具栏:nonce CSP 下内联事件处理器不执行,一律脚本绑定
    document.getElementById('mode-select')?.addEventListener('change', event => {
      setMode(event.target.value);
    });
    document.getElementById('refresh-graph-btn')?.addEventListener('click', refreshGraph);
    document.getElementById('export-png-btn')?.addEventListener('click', () => exportGraph('png'));
    document.getElementById('export-svg-btn')?.addEventListener('click', () => exportGraph('svg'));

    // 模式切换 → 扩展侧重绘
    function setMode(mode) {
      vscode.postMessage({
        command: 'setMode',
        mode: mode
      });
    }

    // 刷新图表
    function refreshGraph() {
      vscode.postMessage({
        command: 'refresh'
      });
    }

    // 导出图表
    function exportGraph(format) {
      vscode.postMessage({
        command: 'export',
        format: format
      });
    }

    async function buildExportData(format) {
      const svg = document.querySelector('#graph-container svg');
      if (!svg) {
        vscode.postMessage({
          command: 'exportData',
          format: format,
          data: null
        });
        return;
      }

      if (format === 'svg') {
        const serialized = new XMLSerializer().serializeToString(svg);
        vscode.postMessage({
          command: 'exportData',
          format: format,
          data: serialized
        });
        return;
      }

      const svgRect = svg.getBoundingClientRect();
      const width = Math.ceil(svgRect.width || Number(svg.getAttribute('width')) || 1200);
      const height = Math.ceil(svgRect.height || Number(svg.getAttribute('height')) || 800);
      const serialized = new XMLSerializer().serializeToString(svg);
      const svgBlob = new Blob([serialized], { type: 'image/svg+xml;charset=utf-8' });
      const blobUrl = URL.createObjectURL(svgBlob);
      const image = new Image();

      image.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;

        const context = canvas.getContext('2d');
        if (!context) {
          vscode.postMessage({
            command: 'exportData',
            format: format,
            data: null
          });
          URL.revokeObjectURL(blobUrl);
          return;
        }

        context.fillStyle = getComputedStyle(document.body).backgroundColor || '#1e1e1e';
        context.fillRect(0, 0, width, height);
        context.drawImage(image, 0, 0, width, height);

        const dataUrl = canvas.toDataURL('image/png');
        const base64 = dataUrl.replace(/^data:image\\/png;base64,/, '');
        vscode.postMessage({
          command: 'exportData',
          format: format,
          data: base64
        });
        URL.revokeObjectURL(blobUrl);
      };

      image.onerror = () => {
        vscode.postMessage({
          command: 'exportData',
          format: format,
          data: null
        });
        URL.revokeObjectURL(blobUrl);
      };

      image.src = blobUrl;
    }

    // 处理 VSCode 消息
    window.addEventListener('message', event => {
      const message = event.data;
      if (message.command === 'beginExport') {
        buildExportData(message.format);
      }
    });
  </script>
</body>
</html>`;
}
