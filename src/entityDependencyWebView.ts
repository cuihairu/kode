/**
 * KBEngine 实体依赖关系 WebView
 * 使用 Mermaid.js 可视化实体依赖图
 */

import * as vscode from 'vscode';
import { EntityDependencyAnalyzer, DependencyGraph, EntityNode, DependencyEdge, DependencyType, EntityType } from './entityDependency';

/**
 * 实体依赖关系 WebView 面板
 */
export class EntityDependencyWebView {
  private panel: vscode.WebviewPanel | null = null;
  private analyzer: EntityDependencyAnalyzer;
  private currentGraph: DependencyGraph | null = null;

  constructor(
    private context: vscode.ExtensionContext,
    private outputChannel: vscode.OutputChannel
  ) {
    this.analyzer = new EntityDependencyAnalyzer(context);
  }

  /**
   * 显示依赖关系图
   */
  async show(): Promise<void> {
    if (this.panel) {
      this.panel.reveal();
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      'kbengine.entityDependency',
      'KBEngine 实体依赖关系',
      vscode.ViewColumn.Two,
      {
        enableScripts: true,
        retainContextWhenHidden: true
      }
    );

    // 处理面板关闭
    this.panel.onDidDispose(() => {
      this.panel = null;
    });

    // 处理来自 WebView 的消息
    this.panel.webview.onDidReceiveMessage(
      async (message) => {
        switch (message.command) {
          case 'refresh':
            await this.refreshGraph();
            break;
          case 'openEntity':
            await this.openEntityFile(message.entityName);
            break;
          case 'export':
            await this.exportGraph(message.format);
            break;
        }
      },
      null,
      this.context.subscriptions
    );

    // 初始加载图数据
    await this.refreshGraph();
  }

  /**
   * 刷新依赖图
   */
  private async refreshGraph(): Promise<void> {
    if (!this.panel) {
      return;
    }

    try {
      // 先加载 entities.xml
      await this.analyzer.loadFromEntitiesXml();

      // 分析依赖关系
      this.currentGraph = await this.analyzer.analyze();

      // 生成 Mermaid 图
      const mermaidGraph = this.generateMermaidGraph(this.currentGraph);

      // 获取 Webview 内容
      this.panel.webview.html = this.getWebviewContent(mermaidGraph, this.currentGraph);
    } catch (error) {
      this.outputChannel.appendLine(`刷新依赖图失败: ${error}`);
      vscode.window.showErrorMessage(`刷新依赖图失败: ${error}`);
    }
  }

  /**
   * 生成 Mermaid 图
   */
  private generateMermaidGraph(graph: DependencyGraph): string {
    let mermaid = 'graph TD\n';

    // 添加节点
    for (const node of graph.nodes) {
      const nodeId = node.name.replace(/-/g, '_');
      const typeLabels = node.types.map(t => {
        switch (t) {
          case 'Base': return '🔵';
          case 'Cell': return '🟢';
          case 'Client': return '🟡';
          default: return '';
        }
      }).join('');

      const label = `${typeLabels} ${node.name}`;
      mermaid += `  ${nodeId}["${label}"]\n`;
    }

    // 添加边
    for (const edge of graph.edges) {
      const fromId = edge.from.replace(/-/g, '_');
      const toId = edge.to.replace(/-/g, '_');
      const label = edge.label || '';

      switch (edge.type) {
        case DependencyType.Inheritance:
          // 继承关系使用实线箭头
          mermaid += `  ${fromId} -->|${label}| ${toId}\n`;
          break;
        case DependencyType.Mailbox:
          // MAILBOX 引用使用虚线
          mermaid += `  ${fromId} -.->|${label}| ${toId}\n`;
          break;
        default:
          mermaid += `  ${fromId} -->|${label}| ${toId}\n`;
      }
    }

    // 添加样式
    mermaid += '\n  classDef baseNode fill:#e1f5fe,stroke:#01579b,stroke-width:2px;\n';
    mermaid += '  classDef cellNode fill:#e8f5e9,stroke:#1b5e20,stroke-width:2px;\n';
    mermaid += '  classDef clientNode fill:#fffde7,stroke:#f57f17,stroke-width:2px;\n';

    for (const node of graph.nodes) {
      const nodeId = node.name.replace(/-/g, '_');
      if (node.types.includes(EntityType.Base)) {
        mermaid += `  class ${nodeId} baseNode;\n`;
      }
      if (node.types.includes(EntityType.Cell)) {
        mermaid += `  class ${nodeId} cellNode;\n`;
      }
      if (node.types.includes(EntityType.Client)) {
        mermaid += `  class ${nodeId} clientNode;\n`;
      }
    }

    return mermaid;
  }

  /**
   * 获取 Webview 内容
   */
  private getWebviewContent(mermaidGraph: string, graph: DependencyGraph): string {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>KBEngine 实体依赖关系</title>
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

    .title {
      font-size: 24px;
      font-weight: bold;
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
  </style>
  <script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"></script>
</head>
<body>
  <div class="header">
    <div class="title">KBEngine 实体依赖关系</div>
    <div class="toolbar">
      <button onclick="refreshGraph()">刷新</button>
      <button onclick="exportGraph('png')">导出 PNG</button>
      <button onclick="exportGraph('svg')">导出 SVG</button>
    </div>
  </div>

  <div class="stats">
    <div class="stat-card">
      <div class="stat-label">总实体数</div>
      <div class="stat-value">${graph.stats.totalEntities}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Base 实体</div>
      <div class="stat-value">${graph.stats.baseEntities}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Cell 实体</div>
      <div class="stat-value">${graph.stats.cellEntities}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Client 实体</div>
      <div class="stat-value">${graph.stats.clientEntities}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">最大继承深度</div>
      <div class="stat-value">${graph.stats.maxDepth}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">最常引用</div>
      <div class="stat-value">${graph.stats.mostReferenced || '-'}</div>
    </div>
  </div>

  <div id="graph-container">
    <div class="mermaid">
${mermaidGraph}
    </div>
  </div>

  <div class="legend">
    <div class="legend-item">
      <div class="legend-dot" style="background-color: #e1f5fe; border: 2px solid #01579b;"></div>
      <span>Base 实体</span>
    </div>
    <div class="legend-item">
      <div class="legend-dot" style="background-color: #e8f5e9; border: 2px solid #1b5e20;"></div>
      <span>Cell 实体</span>
    </div>
    <div class="legend-item">
      <div class="legend-dot" style="background-color: #fffde7; border: 2px solid #f57f17;"></div>
      <span>Client 实体</span>
    </div>
    <div class="legend-item">
      <span>→ 继承关系</span>
    </div>
  </div>

  <script>
    // 初始化 Mermaid
    mermaid.initialize({
      startOnLoad: true,
      theme: 'default',
      securityLevel: 'loose',
      flowchart: {
        useMaxWidth: true,
        htmlLabels: true,
        curve: 'basis'
      }
    });

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

    // 处理 VSCode 消息
    window.addEventListener('message', event => {
      const message = event.data;
      // 可以在这里处理来自扩展的消息
    });
  </script>
</body>
</html>`;
  }

  /**
   * 打开实体文件
   */
  private async openEntityFile(entityName: string): Promise<void> {
    const node = this.analyzer.getEntityNode(entityName);
    if (node) {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(node.defFile));
      await vscode.window.showTextDocument(document);
    }
  }

  /**
   * 导出图表
   */
  private async exportGraph(format: 'png' | 'svg'): Promise<void> {
    if (!this.currentGraph) {
      vscode.window.showWarningMessage('没有可导出的图表');
      return;
    }

    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(`entity-dependency.${format}`),
      filters: {
        'PNG Image': ['png'],
        'SVG Image': ['svg']
      }
    });

    if (uri) {
      vscode.window.showInformationMessage(`导出功能即将推出：${uri.toString()}`);
      // TODO: 实现 SVG/PNG 导出
      // 需要在 WebView 中渲染完成后，将 SVG 转换为文件
    }
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
