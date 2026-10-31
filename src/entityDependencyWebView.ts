/**
 * KBEngine 实体依赖关系 WebView
 * 使用 Mermaid.js 可视化实体依赖图
 *
 * IDE-RUST-007:图拓扑推导走 Rust 核心(`$/kode/dependency/graph`,从
 * entities.xml 登记实体出发 → 实体 def → 继承/接口/组件/属性类型 →
 * types.xml 对象类 → python 实现,全部边反向可索引)。Rust 不可用回落
 * TS EntityDependencyAnalyzer(降级 entity→entity 图,徽章「TS 兜底」)。
 * 两源图先归一为 RenderGraph 再渲染:TS 兜底源输出与迁移前逐字节一致,
 * Rust 源按节点 kind 分 emoji/classDef、按边 kind 分箭头,带三关键路径
 * 与节点点击跳转。
 */

import * as vscode from 'vscode';
import { EntityDependencyAnalyzer, DependencyGraph } from './entityDependency';
import { buildDependencyGraphInRust } from './dependencyGraphRust';
import type { DependencyGraphRust } from './dependencyGraphRust';

/**
 * 渲染层节点 kind(六员;TS 兜底源归一后全部是 entity)。
 */
export type RenderNodeKind = 'entity' | 'def' | 'interface' | 'component' | 'type' | 'python';

/**
 * 归一渲染节点:id 为最终 mermaid id(rawId 清洗 + 撞名消解),label 为展示名。
 */
export interface RenderNode {
  readonly id: string;
  readonly rawId: string;
  readonly label: string;
  readonly name: string;
  readonly filePath: string;
  readonly kind: RenderNodeKind;
  readonly types?: string[];
}

export interface RenderEdge {
  readonly from: string;
  readonly to: string;
  readonly kind: string;
  readonly label?: string;
}

/**
 * 两源统一渲染图:Rust 源带三关键路径与八计数;TS 兜底源 paths 为 null、
 * 另带 legacyStats(六张 legacy 统计卡的数据面)。
 */
export interface RenderGraph {
  readonly nodes: RenderNode[];
  readonly edges: RenderEdge[];
  readonly paths: { entitiesXml: string; defsRoot: string; typesXml: string } | null;
  readonly stats: {
    nodeCount: number;
    edgeCount: number;
    entityCount: number;
    defCount: number;
    interfaceCount: number;
    componentCount: number;
    typeCount: number;
    pythonCount: number;
  };
  readonly legacyStats?: {
    totalEntities: number;
    baseEntities: number;
    cellEntities: number;
    clientEntities: number;
    maxDepth: number;
    mostReferenced: string;
  };
  readonly source: 'rust' | 'ts';
}

/**
 * 类型域 emoji(Base🔵 Cell🟢 Client🟡;两源的实体节点共用)。
 */
function typeEmoji(t: string): string {
  switch (t) {
    case 'Base': return '🔵';
    case 'Cell': return '🟢';
    case 'Client': return '🟡';
    // 不可达:两源的 entity types 都只可能是 Base/Cell/Client
    // (TS 端 EntityType 三员;Rust 端从 hasBase/hasCell/hasClient 派生)。
    /* istanbul ignore start */
    default: return '';
    /* istanbul ignore stop */
  }
}

/** Rust 源非实体节点的 kind emoji。 */
const KIND_EMOJI: Record<RenderNodeKind, string> = {
  entity: '🔵',
  def: '📄',
  interface: '🧩',
  component: '⚙️',
  type: '🧬',
  python: '🐍'
};

/** Rust 源按 kind 的 classDef 样式(entity 沿用 legacy baseNode 配色)。 */
const KIND_STYLE: Record<RenderNodeKind, string> = {
  entity: 'fill:#e1f5fe,stroke:#01579b,stroke-width:2px',
  def: 'fill:#f3e5f5,stroke:#6a1b9a,stroke-width:2px',
  interface: 'fill:#e0f7fa,stroke:#006064,stroke-width:2px',
  component: 'fill:#fff3e0,stroke:#e65100,stroke-width:2px',
  type: 'fill:#e8eaf6,stroke:#283593,stroke-width:2px',
  python: 'fill:#e0f2f1,stroke:#004d40,stroke-width:2px'
};

/** Rust 源边 kind → mermaid 箭头;未登记 kind 回落 -->。 */
const RUST_ARROW: Record<string, string> = {
  inheritance: '-->',
  registration: '--',
  'is-a': '-.->',
  'has-a': '--o',
  implements: '==>',
  'property-type': '-->',
  'method-impl': '-.->'
};

/** mermaid id 清洗:非 [A-Za-z0-9_] 一律 '_'(entity:Hero→entity_Hero)。 */
function sanitizeRustId(rawId: string): string {
  return rawId.replace(/[^a-zA-Z0-9_]/g, '_');
}

/**
 * TS 兜底分析图 → RenderGraph(id 去连字符与 label 拼装与迁移前渲染一致)。
 */
export function normalizeDependencyGraph(graph: DependencyGraph): RenderGraph {
  const nodes: RenderNode[] = graph.nodes.map((node) => ({
    id: node.name.replace(/-/g, '_'),
    rawId: node.name,
    label: `${node.types.map(typeEmoji).join('')} ${node.name}`,
    name: node.name,
    filePath: node.defFile,
    kind: 'entity',
    types: [...node.types]
  }));
  const edges: RenderEdge[] = graph.edges.map((edge) => ({
    from: edge.from.replace(/-/g, '_'),
    to: edge.to.replace(/-/g, '_'),
    kind: edge.type,
    label: edge.label
  }));
  return {
    nodes,
    edges,
    paths: null,
    stats: {
      nodeCount: graph.nodes.length,
      edgeCount: graph.edges.length,
      entityCount: graph.stats.totalEntities,
      defCount: 0,
      interfaceCount: 0,
      componentCount: 0,
      typeCount: 0,
      pythonCount: 0
    },
    legacyStats: { ...graph.stats },
    source: 'ts'
  };
}

/**
 * Rust 核心图 → RenderGraph:id 清洗 + 撞名消解(_2/_3…);label 实体=类型域
 * emoji,其余=kind emoji。
 */
export function normalizeRustGraph(graph: DependencyGraphRust): RenderGraph {
  const idMap = new Map<string, string>();
  const used = new Set<string>();
  const nodes: RenderNode[] = graph.nodes.map((node) => {
    const base = sanitizeRustId(node.id);
    let id = base;
    let suffix = 2;
    while (used.has(id)) {
      id = `${base}_${suffix}`;
      suffix += 1;
    }
    used.add(id);
    idMap.set(node.id, id);

    let label: string;
    if (node.kind === 'entity') {
      const domains = (node.types ?? []).map(typeEmoji).join('');
      label = domains ? `${domains} ${node.name}` : node.name;
    } else {
      label = `${KIND_EMOJI[node.kind]} ${node.name}`;
    }
    return {
      id,
      rawId: node.id,
      label,
      name: node.name,
      filePath: node.filePath,
      kind: node.kind,
      ...(node.types ? { types: [...node.types] } : {})
    };
  });
  const edges: RenderEdge[] = graph.edges.map((edge) => ({
    from: idMap.get(edge.from) ?? sanitizeRustId(edge.from),
    to: idMap.get(edge.to) ?? sanitizeRustId(edge.to),
    kind: edge.kind,
    ...(edge.label !== undefined ? { label: edge.label } : {})
  }));
  return {
    nodes,
    edges,
    paths: graph.paths,
    stats: {
      nodeCount: graph.stats.nodeCount,
      edgeCount: graph.stats.edgeCount,
      entityCount: graph.stats.entityCount,
      defCount: graph.stats.defCount,
      interfaceCount: graph.stats.interfaceCount,
      componentCount: graph.stats.componentCount,
      typeCount: graph.stats.typeCount,
      pythonCount: graph.stats.pythonCount
    },
    source: 'rust'
  };
}

/** click 指令:webview 脚本注册 openFilePath 回调,回抛 openNode 打开文件。 */
function clickLine(node: RenderNode): string {
  return `  click ${node.id} openFilePath "${node.filePath.replace(/"/g, '\\"')}"\n`;
}

/**
 * TS 兜底渲染:节点/边/三 classDef 输出与迁移前逐字节一致,仅追加 click
 * 指令(空图无节点,输出不变)。
 */
function renderLegacyMermaid(graph: RenderGraph): string {
  let mermaid = 'graph TD\n';

  // 添加节点
  for (const node of graph.nodes) {
    mermaid += `  ${node.id}["${node.label}"]\n`;
  }

  // 添加边(继承/组合等一律实线箭头,与迁移前口径一致)
  for (const edge of graph.edges) {
    mermaid += `  ${edge.from} -->|${edge.label ?? ''}| ${edge.to}\n`;
  }

  // 添加点击跳转
  for (const node of graph.nodes) {
    if (node.filePath) {
      mermaid += clickLine(node);
    }
  }

  // 添加样式
  mermaid += '\n  classDef baseNode fill:#e1f5fe,stroke:#01579b,stroke-width:2px;\n';
  mermaid += '  classDef cellNode fill:#e8f5e9,stroke:#1b5e20,stroke-width:2px;\n';
  mermaid += '  classDef clientNode fill:#fffde7,stroke:#f57f17,stroke-width:2px;\n';

  for (const node of graph.nodes) {
    const types = node.types ?? [];
    if (types.includes('Base')) {
      mermaid += `  class ${node.id} baseNode;\n`;
    }
    if (types.includes('Cell')) {
      mermaid += `  class ${node.id} cellNode;\n`;
    }
    if (types.includes('Client')) {
      mermaid += `  class ${node.id} clientNode;\n`;
    }
  }

  return mermaid;
}

/**
 * Rust 核心渲染:kind emoji 标签、按边 kind 分箭头、按 kind classDef
 * (仅出现过的 kind,规范序)与 class 分配、click 跳转。
 */
function renderRustMermaid(graph: RenderGraph): string {
  let mermaid = 'graph TD\n';

  // 添加节点
  for (const node of graph.nodes) {
    mermaid += `  ${node.id}["${node.label}"]\n`;
  }

  // 添加边(带 label 的边渲染 |label| 段)
  for (const edge of graph.edges) {
    const arrow = RUST_ARROW[edge.kind] ?? '-->';
    if (edge.label !== undefined) {
      mermaid += `  ${edge.from} ${arrow}|${edge.label}| ${edge.to}\n`;
    } else {
      mermaid += `  ${edge.from} ${arrow} ${edge.to}\n`;
    }
  }

  // 添加点击跳转
  for (const node of graph.nodes) {
    if (node.filePath) {
      mermaid += clickLine(node);
    }
  }

  // 添加样式:按 kind 出现顺序的规范序出 classDef
  mermaid += '\n';
  const kindOrder: RenderNodeKind[] = ['entity', 'def', 'interface', 'component', 'type', 'python'];
  for (const kind of kindOrder) {
    if (graph.nodes.some((node) => node.kind === kind)) {
      mermaid += `  classDef ${kind}Node ${KIND_STYLE[kind]};\n`;
    }
  }

  for (const node of graph.nodes) {
    mermaid += `  class ${node.id} ${node.kind}Node;\n`;
  }

  return mermaid;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 实体依赖关系 WebView 面板
 */
export class EntityDependencyWebView {
  private panel: vscode.WebviewPanel | null = null;
  private analyzer: EntityDependencyAnalyzer;
  private currentRender: RenderGraph | null = null;
  private pendingExport: { format: 'png' | 'svg'; uri: vscode.Uri } | null = null;

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
          case 'openNode':
            await this.openNode(message.filePath);
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

    // 初始加载图数据
    await this.refreshGraph();
  }

  /**
   * 刷新依赖图:Rust 核心优先(实体→def→接口/组件/types.xml/python 全图);
   * 不可用(无 gate/调用失败/形状不符)回落 TS 分析器(降级实体图)。
   */
  private async refreshGraph(): Promise<void> {
    if (!this.panel) {
      return;
    }

    try {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      let render: RenderGraph | null = null;
      if (root) {
        try {
          const rust = await buildDependencyGraphInRust(root);
          if (rust) {
            render = normalizeRustGraph(rust);
          }
        } catch (rustError) {
          // Rust 面异常按不可用处理(与返回 null 同),回落 TS 兜底
          this.outputChannel.appendLine(`Rust 依赖图推导失败,回落 TS: ${rustError}`);
        }
      }
      if (!render) {
        render = normalizeDependencyGraph(await this.analyzer.analyze());
      }

      this.currentRender = render;

      // 生成 Mermaid 图
      const mermaidGraph = this.generateMermaidGraph(render);

      // 获取 Webview 内容
      this.panel.webview.html = this.getWebviewContent(mermaidGraph, render);
    } catch (error) {
      this.outputChannel.appendLine(`刷新依赖图失败: ${error}`);
      vscode.window.showErrorMessage(`刷新依赖图失败: ${error}`);
    }
  }

  /**
   * 生成 Mermaid 图(按图来源分流:Rust 核心/TS 兜底)
   */
  private generateMermaidGraph(graph: RenderGraph): string {
    return graph.source === 'rust' ? renderRustMermaid(graph) : renderLegacyMermaid(graph);
  }

  private statCard(label: string, value: string | number): string {
    return `      <div class="stat-card">
        <div class="stat-label">${label}</div>
        <div class="stat-value">${value}</div>
      </div>`;
  }

  /**
   * 获取 Webview 内容
   */
  private getWebviewContent(mermaidGraph: string, graph: RenderGraph): string {
    const sourceBadge = graph.source === 'rust' ? 'Rust 核心' : 'TS 兜底';

    const statsHtml = graph.source === 'rust'
      ? [
        this.statCard('节点', graph.stats.nodeCount),
        this.statCard('边', graph.stats.edgeCount),
        this.statCard('实体', graph.stats.entityCount),
        this.statCard('def', graph.stats.defCount),
        this.statCard('接口', graph.stats.interfaceCount),
        this.statCard('组件', graph.stats.componentCount),
        this.statCard('类型', graph.stats.typeCount),
        this.statCard('Python', graph.stats.pythonCount)
      ].join('\n')
      : [
        this.statCard('总实体数', graph.legacyStats?.totalEntities ?? 0),
        this.statCard('Base 实体', graph.legacyStats?.baseEntities ?? 0),
        this.statCard('Cell 实体', graph.legacyStats?.cellEntities ?? 0),
        this.statCard('Client 实体', graph.legacyStats?.clientEntities ?? 0),
        this.statCard('最大继承深度', graph.legacyStats?.maxDepth ?? 0),
        this.statCard('最常引用', graph.legacyStats?.mostReferenced || '-')
      ].join('\n');

    const pathsHtml = graph.paths
      ? `
  <div class="paths">
    <div class="path-item"><span class="path-label">entities.xml</span><code>${escapeHtml(graph.paths.entitiesXml)}</code></div>
    <div class="path-item"><span class="path-label">defsRoot</span><code>${escapeHtml(graph.paths.defsRoot)}</code></div>
    <div class="path-item"><span class="path-label">types.xml</span><code>${escapeHtml(graph.paths.typesXml)}</code></div>
  </div>`
      : '';

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
  </style>
  <script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"></script>
</head>
<body>
  <div class="header">
    <div class="title">KBEngine 实体依赖关系</div>
    <div style="display: flex; align-items: center; gap: 10px;">
      <span class="source-badge">${sourceBadge}</span>
      <div class="toolbar">
        <button onclick="refreshGraph()">刷新</button>
        <button onclick="exportGraph('png')">导出 PNG</button>
        <button onclick="exportGraph('svg')">导出 SVG</button>
      </div>
    </div>
  </div>

  <div class="stats">
${statsHtml}
  </div>
${pathsHtml}

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
    const vscode = acquireVsCodeApi();

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

    // 节点点击 → 打开对应文件(entities.xml / .def / types.xml / python)
    window.openFilePath = function(filePath) {
      vscode.postMessage({
        command: 'openNode',
        filePath: filePath
      });
    };

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

  /**
   * 打开图中节点对应的文件
   */
  private async openNode(filePath: string): Promise<void> {
    if (!filePath) {
      return;
    }

    try {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
      await vscode.window.showTextDocument(document);
    } catch (error) {
      vscode.window.showErrorMessage(`打开文件失败: ${error}`);
    }
  }

  /**
   * 打开实体文件
   */
  private async openEntityFile(entityName: string): Promise<void> {
    const node = this.analyzer.getEntityNode(entityName);
    if (!node) {
      vscode.window.showWarningMessage(`未找到实体节点: ${entityName}`);
      return;
    }

    try {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(node.defFile));
      await vscode.window.showTextDocument(document);
    } catch (error) {
      vscode.window.showErrorMessage(`打开实体定义失败: ${error}`);
    }
  }

  /**
   * 导出图表
   */
  private async exportGraph(format: 'png' | 'svg'): Promise<void> {
    if (!this.currentRender || !this.panel) {
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

    if (!uri) {
      return;
    }

    this.pendingExport = { format, uri };
    await this.panel.webview.postMessage({
      command: 'beginExport',
      format
    });
  }

  private async saveExportedGraph(format: 'png' | 'svg', data: string | null): Promise<void> {
    if (!this.pendingExport) {
      return;
    }

    const pendingExport = this.pendingExport;
    this.pendingExport = null;

    if (!data || pendingExport.format !== format) {
      vscode.window.showErrorMessage(`导出 ${format.toUpperCase()} 失败`);
      return;
    }

    const content = format === 'svg'
      ? Buffer.from(data, 'utf8')
      : Buffer.from(data, 'base64');

    try {
      await vscode.workspace.fs.writeFile(pendingExport.uri, content);
      vscode.window.showInformationMessage(`依赖图已导出到 ${pendingExport.uri.fsPath}`);
    } catch (error) {
      vscode.window.showErrorMessage(`写入导出文件失败: ${error}`);
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
