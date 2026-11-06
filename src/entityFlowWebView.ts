/**
 * 实体架构流程图 WebView(批124)。
 *
 * 图数据模型、mermaid 文本与 Markdown 导出全在 entityFlowGraph 纯函数层,
 * 本类只做装配:定位活动实体 → 建图 → 内嵌 mermaid 图 + 逐边引擎出处 → 导出。
 * 边成员带声明行,点击回跳 def 声明处;旗标位语义与引擎出处全部来自建图层,
 * 不在面板侧另立口径。
 */

import * as path from 'path';
import * as vscode from 'vscode';
import { randomNonce, webviewAssetUri, webviewScriptCsp } from './webviewSecurity';
import { createDefinitionSemanticsLoader } from './definitionSemantics';
import { resolveEntityHasCell } from './databaseSchemaCore';
import { buildSchemaSourcePorts } from './databaseSchemaSource';
import { getDefinitionWorkspaceLayout } from './definitionWorkspace';
import {
  buildEntityFlowGraph,
  renderEntityFlowMarkdown,
  renderEntityFlowMermaid,
} from './entityFlowGraph';
import type { EntityFlowGraph, FlowEdge, FlowActor } from './entityFlowGraph';
import { WEBVIEW_THEME_CSS } from './webviewTheme';
import { htmlLang, resolvePanelLocale, strings } from './webviewStrings';

/** UI-06:actor 标签走字符串表(zh/en),键与 FlowActor 一一对应 */
function actorLabel(actor: FlowActor, t: ReturnType<typeof strings>['entityFlow']): string {
  const map: Record<FlowActor, string> = {
    client: t.actorClient,
    base: t.actorBase,
    cell: t.actorCell,
    aoi: t.actorAoi,
    db: t.actorDb
  };
  return map[actor];
}

type FlowExportFormat = 'markdown' | 'svg' | 'png';

export class EntityFlowWebView {
  private panel: vscode.WebviewPanel | null = null;
  private currentEntityName: string | null = null;
  private currentGraph: EntityFlowGraph | null = null;
  private pendingExport: { format: FlowExportFormat; uri: vscode.Uri } | null = null;
  // BG-WARM 请求代际:每次 show(含面板关闭)递增,await 之后代际已换即弃——
  // 等待期间切换实体/关面板,旧请求不再覆盖新视图、不再重开面板。
  private showGeneration = 0;
  // 已出过图的实体键:这些键不再吃预热缓存(切走再切回、改完再开都要现算),
  // 激活期快照只服务每个实体的第一次打开。
  private readonly servedEntities = new Set<string>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    // BG-WARM:后台预热产物源(面板只读缓存)。未注入时行为与迁移前一致。
    private readonly warmup?: import('./backgroundWarmup').PanelWarmupSource
  ) {}

  /** 显示流程图:显式实体名优先,否则取活动 .def 编辑器的文件名。 */
  async show(entityName?: string): Promise<void> {
    const resolved = entityName ?? this.activeDefEntityName();
    if (!resolved) {
      vscode.window.showInformationMessage('请先打开一个实体 .def 文件');
      return;
    }

    // BG-WARM 只读缓存:预热产物 done → 直接渲染,不进 buildGraph(秒出);
    // running → 先开面板出进度页,复用在跑任务(同一 Promise 不重算);
    // missing/failed → 回落既有现算路径。
    // 失效口径:该实体在本会话已经出过图(重复 show / 切走切回 / 改完再开)
    // 就不再吃缓存,现算取最新——激活期快照只服务每个实体的第一次打开。
    const generation = ++this.showGeneration;
    const artifactKey = `flowGraph:${resolved}`;
    const cached = this.servedEntities.has(resolved)
      ? undefined
      : this.warmup?.peekArtifact<EntityFlowGraph>(artifactKey);
    if (cached && cached.state === 'done' && cached.value) {
      this.applyGraph(resolved, cached.value);
      return;
    }
    if (cached && cached.state === 'running' && this.warmup) {
      this.ensurePanel();
      this.panel!.title = `KBEngine 实体架构流程 · ${resolved}`;
      this.panel!.webview.html = this.getWarmupProgressHtml(resolved);
      this.panel!.reveal();
      const reused = await this.warmup.artifact<EntityFlowGraph>(artifactKey);
      // 等待期间被后续 show 取代或面板已关:旧请求整体作废,不覆盖新视图、
      // 不替已关面板重建空壳。
      if (generation !== this.showGeneration || !this.panel) {
        return;
      }
      const graph = reused ?? this.buildGraph(resolved);
      if (!graph) {
        vscode.window.showWarningMessage(`打开架构流程图失败: ${resolved} (未找到实体定义)`);
        return;
      }
      this.applyGraph(resolved, graph);
      return;
    }

    // 先建图再开面板:实体未注册时不留空壳面板
    const graph = this.buildGraph(resolved);
    if (!graph) {
      vscode.window.showWarningMessage(`打开架构流程图失败: ${resolved} (未找到实体定义)`);
      return;
    }

    this.ensurePanel();
    this.applyGraph(resolved, graph);
  }

  /** BG-WARM:预热中进度页(部分结果位);真图完成后由 applyGraph 替换。 */
  private getWarmupProgressHtml(entityName: string): string {
    const snapshot = this.warmup?.snapshot();
    const detail = snapshot
      ? `${snapshot.completedStages}/${snapshot.totalStages}${snapshot.currentLabel ? ` · ${snapshot.currentLabel}` : ''}`
      : '';
    return `<!DOCTYPE html>
<html>
<body class="kbengine-warmup">
  <h1>KBEngine 索引预热中</h1>
  <p>实体 ${entityName} 的架构流程图正在后台分析(${detail})。</p>
  <p>完成后本面板自动展示流程图。</p>
</body>
</html>`;
  }

  /** 面板懒建(幂等);消息接线与既有口径一致。 */
  private ensurePanel(): vscode.WebviewPanel {
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel(
        'kbengine.entityFlow',
        'KBEngine 实体架构流程',
        vscode.ViewColumn.Two,
        {
          enableScripts: true,
          retainContextWhenHidden: true
        }
      );

      this.panel.onDidDispose(() => {
        this.panel = null;
        this.showGeneration += 1; // 关面板作废一切在途 show 请求
      });

      this.panel.webview.onDidReceiveMessage(
        async message => {
          switch (message.command) {
            case 'refresh':
              if (this.currentEntityName) {
                await this.show(this.currentEntityName);
              }
              break;
            case 'openMember':
              await this.openMember(message.filePath, message.line);
              break;
            case 'export':
              await this.exportGraph(message.format);
              break;
            case 'exportData':
              await this.saveExportedGraph(message.format, message.data);
              break;
          }
        },
        null,
        this.context.subscriptions
      );
    }
    return this.panel;
  }

  /** 渲染当前实体图:记账 + 标题 + HTML + reveal(缓存命中与现算同出口)。 */
  private applyGraph(entityName: string, graph: EntityFlowGraph): void {
    this.currentEntityName = entityName;
    this.currentGraph = graph;
    this.servedEntities.add(entityName); // 已出过图:该键此后不再吃预热缓存
    if (!this.panel) {
      this.ensurePanel();
    }
    this.panel!.title = `KBEngine 实体架构流程 · ${entityName}`;
    this.panel!.webview.html = this.getWebviewContent(graph);
    this.panel!.reveal();
  }

  private activeDefEntityName(): string | undefined {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'kbengine-def') {
      return undefined;
    }
    return path.basename(editor.document.uri.fsPath, '.def');
  }

  /**
   * 建图:无工作区或实体未注册时返回 null,由调用方如实提示。
   * BG-WARM:对预热管线公开(阶段体与面板现算共用同一建图出口,口径不分叉)。
   */
  buildGraph(entityName: string): EntityFlowGraph | null {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const loader = workspaceRoot ? createDefinitionSemanticsLoader(workspaceRoot) : null;
    const semantics = loader?.loadResolved(entityName, 'entity', true);
    if (!workspaceRoot || !semantics) {
      return null;
    }

    const layout = getDefinitionWorkspaceLayout(workspaceRoot);
    return buildEntityFlowGraph({
      semantics,
      hasCell: resolveEntityHasCell(entityName, workspaceRoot, layout, buildSchemaSourcePorts())
    });
  }

  /** 逐边详情:语义 + 旗标 + 引擎出处 + 成员(带声明行,可点击回跳)。 */
  private renderEdgeDetails(edges: FlowEdge[]): string {
    const t = strings(resolvePanelLocale()).entityFlow;
    return edges
      .map(edge => {
        const flags = edge.flags.length > 0
          ? `<div class="flags">${edge.flags
            .map(flag => `<span class="flag-chip">${this.escapeHtml(flag)}</span>`)
            .join('')}</div>`
          : '';
        const citations = edge.citations
          .map(
            citation =>
              `<li><code>${this.escapeHtml(citation.file)}:${citation.line}</code> — ${this.escapeHtml(citation.note)}</li>`
          )
          .join('');
        const members = edge.members
          .map(member => {
            const detail = member.kind === 'method'
              ? member.exposed
                ? 'Exposed'
                : t.notExposed
              : `${member.flags}${member.persistent ? ' · Persistent' : ''}`;
            return `<tr class="member" data-file="${this.escapeHtml(member.filePath)}" data-line="${member.line}">
              <td><code>${this.escapeHtml(member.name)}</code></td>
              <td>${this.escapeHtml(detail)}</td>
              <td>${this.escapeHtml(member.source)}</td>
              <td><code>${this.escapeHtml(member.filePath)}:${member.line}</code></td>
            </tr>`;
          })
          .join('');

        return `<section class="edge">
          <h3>${this.escapeHtml(actorLabel(edge.from, t))} → ${this.escapeHtml(actorLabel(edge.to, t))}</h3>
          <p class="semantic">${this.escapeHtml(edge.semantic)}</p>
          ${flags}
          <p class="citation-title">${t.engineCitation}</p>
          <ul>${citations}</ul>
          <table>
            <thead><tr><th>${t.colMember}</th><th>${t.colDescription}</th><th>${t.colSource}</th><th>${t.colLocation}</th></tr></thead>
            <tbody>${members}</tbody>
          </table>
        </section>`;
      })
      .join('\n');
  }

  private renderBlocked(graph: EntityFlowGraph): string {
    const t = strings(resolvePanelLocale()).entityFlow;
    if (graph.blocked.length === 0) {
      return '';
    }
    const items = graph.blocked
      .map(
        entry =>
          `<li><code>${this.escapeHtml(entry.method)}</code>（${this.escapeHtml(entry.section)}）— ${this.escapeHtml(entry.reason)}（<code>${this.escapeHtml(entry.citation.file)}:${entry.citation.line}</code>）</li>`
      )
      .join('');
    return `<section class="edge edge--blocked"><h3>${t.blockedHeading}</h3><ul>${items}</ul></section>`;
  }

  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  private getWebviewContent(graph: EntityFlowGraph): string {
    const t = strings(resolvePanelLocale()).entityFlow;
    const stats = graph.stats;
    // KR-AUD-53:标签面一并转义(标签注入)
    const statCards = [
      [t.statProperties, stats.properties],
      [t.statMethods, stats.methods],
      [t.statExposed, stats.exposedCalls],
      [t.statCallbacks, stats.clientCallbacks],
      [t.statPersistent, stats.persistentProperties],
      [t.statBlocked, stats.blockedCalls]
    ]
      .map(
        ([label, value]) =>
          `<div class="stat-card"><div class="stat-label">${this.escapeHtml(String(label))}</div><div class="stat-value">${this.escapeHtml(String(value))}</div></div>`
      )
      .join('');

    // KR-AUD-50/53:整页 nonce CSP + mermaid 离线打包(与 cspSource 同源);
    // 图片源只给导出用的 data:/blob: 开洞。
    const nonce = randomNonce();
    const cspSource = this.panel?.webview.cspSource ?? 'vscode-webview:';
    const mermaidUri = webviewAssetUri(
      this.panel?.webview,
      this.context.extensionUri,
      'media',
      'mermaid.tiny.js'
    );

    return `<!DOCTYPE html>
<html lang="${htmlLang(resolvePanelLocale())}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <!-- 最小 CSP(KR-AUD-50/53):default-src 'none' 断掉一切外联/外帧/连接,
       脚本只认本次渲染 nonce + 扩展自带 media/mermaid.tiny.js(离线打包)。 -->
  <meta http-equiv="Content-Security-Policy" content="${webviewScriptCsp(nonce, [cspSource], ['data:', 'blob:', cspSource])}">
  <title>${t.title}</title>
  <style>
    ${WEBVIEW_THEME_CSS}
    body {
      margin: 0;
      padding: 20px;
    }
    /* UI-06:blocked 方法红边警示卡,独立于普通边卡视觉权重 */
    .edge.edge--blocked {
      border-color: rgba(241, 76, 76, 0.3);
      background: rgba(241, 76, 76, 0.05);
    }
    .edge.edge--blocked h3 {
      color: var(--kode-err);
    }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 20px;
      padding-bottom: 10px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .title { font-size: 22px; font-weight: bold; }
    .toolbar { display: flex; gap: 10px; }
    button {
      background-color: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      padding: 6px 14px;
      cursor: pointer;
      border-radius: 2px;
    }
    button:hover { background-color: var(--vscode-button-hoverBackground); }
    .stats {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
      gap: 12px;
      margin-bottom: 20px;
    }
    .stat-card {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      padding: 12px;
    }
    .stat-label { font-size: 12px; color: var(--vscode-descriptionForeground); }
    .stat-value { font-size: 22px; font-weight: bold; }
    #graph-container {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      padding: 16px;
      margin-bottom: 20px;
    }
    .edge {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      padding: 12px 16px;
      margin-bottom: 14px;
    }
    .edge h3 { margin: 0 0 8px; font-size: 15px; }
    .semantic { margin: 0 0 8px; color: var(--vscode-descriptionForeground); }
    .flags { margin-bottom: 8px; display: flex; gap: 6px; flex-wrap: wrap; }
    .flag-chip {
      background-color: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      border-radius: 3px;
      padding: 1px 8px;
      font-size: 12px;
    }
    .citation-title { font-size: 12px; color: var(--vscode-descriptionForeground); margin: 8px 0 4px; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border: 1px solid var(--vscode-panel-border); padding: 4px 10px; text-align: left; font-size: 13px; }
    tr.member { cursor: pointer; }
    tr.member:hover { background-color: var(--vscode-list-hoverBackground); }
  </style>
  <script src="${mermaidUri}"></script>
</head>
<body>
  <div class="header">
    <div class="title">KBEngine 实体架构流程 · ${this.escapeHtml(graph.entityName)}</div>
    <div class="toolbar">
      <button id="refresh-flow-btn">${t.refresh}</button>
      <button id="export-markdown-btn">${t.exportMarkdown}</button>
      <button id="export-svg-btn">${t.exportSvg}</button>
      <button id="export-png-btn">${t.exportPng}</button>
    </div>
  </div>

  <div class="stats">${statCards}</div>

  <div id="graph-container">
    <div class="mermaid">
${renderEntityFlowMermaid(graph)}
    </div>
  </div>

  ${this.renderEdgeDetails(graph.edges)}
  ${this.renderBlocked(graph)}

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    // KR-AUD-53:securityLevel=strict(标签经 DOMPurify 清洗)
    mermaid.initialize({
      startOnLoad: true,
      theme: 'dark',
      securityLevel: 'strict',
      flowchart: { useMaxWidth: true, htmlLabels: true, curve: 'basis' }
    });

    function refreshFlow() {
      vscode.postMessage({ command: 'refresh' });
    }
    function exportFlow(format) {
      vscode.postMessage({ command: 'export', format: format });
    }

    // 工具栏:nonce CSP 下内联事件处理器不执行,一律脚本绑定
    document.getElementById('refresh-flow-btn')?.addEventListener('click', refreshFlow);
    document.getElementById('export-markdown-btn')?.addEventListener('click', () => exportFlow('markdown'));
    document.getElementById('export-svg-btn')?.addEventListener('click', () => exportFlow('svg'));
    document.getElementById('export-png-btn')?.addEventListener('click', () => exportFlow('png'));

    Array.from(document.querySelectorAll('tr.member')).forEach(row => {
      row.addEventListener('click', () => {
        vscode.postMessage({
          command: 'openMember',
          filePath: row.getAttribute('data-file'),
          line: Number(row.getAttribute('data-line'))
        });
      });
    });

    async function buildExportData(format) {
      const svg = document.querySelector('#graph-container svg');
      if (!svg) {
        vscode.postMessage({ command: 'exportData', format: format, data: null });
        return;
      }

      if (format === 'svg') {
        const serialized = new XMLSerializer().serializeToString(svg);
        vscode.postMessage({ command: 'exportData', format: format, data: serialized });
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
          vscode.postMessage({ command: 'exportData', format: format, data: null });
          URL.revokeObjectURL(blobUrl);
          return;
        }

        context.fillStyle = getComputedStyle(document.body).backgroundColor || '#1e1e1e';
        context.fillRect(0, 0, width, height);
        context.drawImage(image, 0, 0, width, height);

        const dataUrl = canvas.toDataURL('image/png');
        const base64 = dataUrl.replace(/^data:image\\/png;base64,/, '');
        vscode.postMessage({ command: 'exportData', format: format, data: base64 });
        URL.revokeObjectURL(blobUrl);
      };

      image.onerror = () => {
        vscode.postMessage({ command: 'exportData', format: format, data: null });
        URL.revokeObjectURL(blobUrl);
      };

      image.src = blobUrl;
    }

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

  private async openMember(filePath: string, line: number): Promise<void> {
    try {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
      const position = new vscode.Position(Math.max(line - 1, 0), 0);
      await vscode.window.showTextDocument(document, { selection: new vscode.Range(position, position) });
    } catch (error) {
      vscode.window.showWarningMessage(`打开声明失败: ${filePath}:${line} (${error})`);
    }
  }

  private async exportGraph(format: FlowExportFormat): Promise<void> {
    if (!this.currentGraph) {
      vscode.window.showWarningMessage('没有可导出的流程图');
      return;
    }

    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(`${this.currentGraph.entityName}-flow.${format}`),
      filters:
        format === 'markdown'
          ? { Markdown: ['md'] }
          : format === 'svg'
            ? { 'SVG Image': ['svg'] }
            : { 'PNG Image': ['png'] }
    });
    if (!uri) {
      return;
    }

    if (format === 'markdown') {
      // Markdown 全部内容来自建图层数据,不经 webview DOM,直接落盘
      await this.writeExport(uri, format, Buffer.from(renderEntityFlowMarkdown(this.currentGraph), 'utf8'));
      return;
    }

    this.pendingExport = { format, uri };
    await this.panel?.webview.postMessage({ command: 'beginExport', format });
  }

  private async saveExportedGraph(format: FlowExportFormat, data: string | null): Promise<void> {
    if (!this.pendingExport) {
      return;
    }

    const pending = this.pendingExport;
    this.pendingExport = null;

    if (!data || pending.format !== format) {
      vscode.window.showErrorMessage(`导出 ${format.toUpperCase()} 失败`);
      return;
    }

    const content = format === 'svg'
      ? Buffer.from(data, 'utf8')
      : Buffer.from(data, 'base64');
    await this.writeExport(pending.uri, format, content);
  }

  private async writeExport(uri: vscode.Uri, format: FlowExportFormat, content: Buffer): Promise<void> {
    try {
      await vscode.workspace.fs.writeFile(uri, content);
      vscode.window.showInformationMessage(`架构流程图已导出到 ${uri.fsPath}`);
    } catch (error) {
      vscode.window.showErrorMessage(`写入导出文件失败: ${error}`);
    }
  }

  dispose(): void {
    if (this.panel) {
      this.panel.dispose();
      this.panel = null;
    }
  }
}
