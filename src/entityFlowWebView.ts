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
import { createDefinitionSemanticsLoader } from './definitionSemantics';
import { resolveEntityHasCell } from './databaseSchema';
import { getDefinitionWorkspaceLayout } from './definitionWorkspace';
import {
  buildEntityFlowGraph,
  renderEntityFlowMarkdown,
  renderEntityFlowMermaid,
  FLOW_ACTOR_LABELS
} from './entityFlowGraph';
import type { EntityFlowGraph, FlowEdge } from './entityFlowGraph';

type FlowExportFormat = 'markdown' | 'svg' | 'png';

export class EntityFlowWebView {
  private panel: vscode.WebviewPanel | null = null;
  private currentEntityName: string | null = null;
  private currentGraph: EntityFlowGraph | null = null;
  private pendingExport: { format: FlowExportFormat; uri: vscode.Uri } | null = null;

  constructor(private readonly context: vscode.ExtensionContext) {}

  /** 显示流程图:显式实体名优先,否则取活动 .def 编辑器的文件名。 */
  async show(entityName?: string): Promise<void> {
    const resolved = entityName ?? this.activeDefEntityName();
    if (!resolved) {
      vscode.window.showInformationMessage('请先打开一个实体 .def 文件');
      return;
    }

    // 先建图再开面板:实体未注册时不留空壳面板
    const graph = this.buildGraph(resolved);
    if (!graph) {
      vscode.window.showWarningMessage(`打开架构流程图失败: ${resolved} (未找到实体定义)`);
      return;
    }

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

    this.currentEntityName = resolved;
    this.currentGraph = graph;
    this.panel.title = `KBEngine 实体架构流程 · ${resolved}`;
    this.panel.webview.html = this.getWebviewContent(graph);
    this.panel.reveal();
  }

  private activeDefEntityName(): string | undefined {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'kbengine-def') {
      return undefined;
    }
    return path.basename(editor.document.uri.fsPath, '.def');
  }

  /** 建图:无工作区或实体未注册时返回 null,由调用方如实提示。 */
  private buildGraph(entityName: string): EntityFlowGraph | null {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const loader = workspaceRoot ? createDefinitionSemanticsLoader(workspaceRoot) : null;
    const semantics = loader?.loadResolved(entityName, 'entity', true);
    if (!workspaceRoot || !semantics) {
      return null;
    }

    const layout = getDefinitionWorkspaceLayout(workspaceRoot);
    return buildEntityFlowGraph({
      semantics,
      hasCell: resolveEntityHasCell(entityName, workspaceRoot, layout)
    });
  }

  /** 逐边详情:语义 + 旗标 + 引擎出处 + 成员(带声明行,可点击回跳)。 */
  private renderEdgeDetails(edges: FlowEdge[]): string {
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
                : '非 Exposed'
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
          <h3>${this.escapeHtml(FLOW_ACTOR_LABELS[edge.from])} → ${this.escapeHtml(FLOW_ACTOR_LABELS[edge.to])}</h3>
          <p class="semantic">${this.escapeHtml(edge.semantic)}</p>
          ${flags}
          <p class="citation-title">引擎出处</p>
          <ul>${citations}</ul>
          <table>
            <thead><tr><th>成员</th><th>说明</th><th>来源</th><th>声明位置</th></tr></thead>
            <tbody>${members}</tbody>
          </table>
        </section>`;
      })
      .join('\n');
  }

  private renderBlocked(graph: EntityFlowGraph): string {
    if (graph.blocked.length === 0) {
      return '';
    }
    const items = graph.blocked
      .map(
        entry =>
          `<li><code>${this.escapeHtml(entry.method)}</code>（${entry.section}）— ${this.escapeHtml(entry.reason)}（<code>${this.escapeHtml(entry.citation.file)}:${entry.citation.line}</code>）</li>`
      )
      .join('');
    return `<section class="edge"><h3>客户端调不到的方法</h3><ul>${items}</ul></section>`;
  }

  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  private getWebviewContent(graph: EntityFlowGraph): string {
    const stats = graph.stats;
    const statCards = [
      ['属性', stats.properties],
      ['方法', stats.methods],
      ['客户端可调', stats.exposedCalls],
      ['客户端回调', stats.clientCallbacks],
      ['持久属性', stats.persistentProperties],
      ['客户端调不到', stats.blockedCalls]
    ]
      .map(
        ([label, value]) =>
          `<div class="stat-card"><div class="stat-label">${label}</div><div class="stat-value">${value}</div></div>`
      )
      .join('');

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>KBEngine 实体架构流程</title>
  <style>
    body {
      font-family: var(--vscode-font-family);
      background-color: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
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
  <script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"></script>
</head>
<body>
  <div class="header">
    <div class="title">KBEngine 实体架构流程 · ${this.escapeHtml(graph.entityName)}</div>
    <div class="toolbar">
      <button onclick="refreshFlow()">刷新</button>
      <button onclick="exportFlow('markdown')">导出 Markdown</button>
      <button onclick="exportFlow('svg')">导出 SVG</button>
      <button onclick="exportFlow('png')">导出 PNG</button>
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

  <script>
    const vscode = acquireVsCodeApi();
    mermaid.initialize({
      startOnLoad: true,
      theme: 'default',
      securityLevel: 'loose',
      flowchart: { useMaxWidth: true, htmlLabels: true, curve: 'basis' }
    });

    function refreshFlow() {
      vscode.postMessage({ command: 'refresh' });
    }
    function exportFlow(format) {
      vscode.postMessage({ command: 'export', format: format });
    }

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
