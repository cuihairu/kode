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
 *
 * C-20:同一面板双模式「dependency(实体依赖)| callgraph(Python 方法级
 * 调用图)」。callgraph 模式走 `$/kode/python/callgraph`(Rust ruff AST),
 * 收集 workspace 全部根 *.py 原文直传;归一为 CallGraphGraph 再渲染
 * (8 类边分箭头/样式,未解析被调方补 stub 节点,绝不丢调用点)。Rust
 * 不可用 = 面板徽标「Rust 不可用」+ 空图注记(无 TS 兜底,不虚构)。
 */

import * as vscode from 'vscode';
import { EntityDependencyAnalyzer, DependencyGraph } from './entityDependency';
import { buildDependencyGraphInRust } from './dependencyGraphRust';
import type { DependencyGraphRust } from './dependencyGraphRust';
import { buildPythonCallGraphInRust } from './pythonCallGraphRust';
import type {
  PythonCallGraphRustResult,
  PythonCallGraphNode
} from './pythonCallGraphRust';
import { readWorkspaceTextFile } from './definitionWorkspace';

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
function clickLine(node: { id: string; filePath: string }): string {
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

// ---------------------------------------------------------------------------
// C-20 callgraph 模式:类型/常量/归一/渲染
// ---------------------------------------------------------------------------

/** callgraph 渲染层节点 kind(四员;Rust 节点 + 未解析 stub)。 */
export type CallGraphNodeKind = 'method' | 'function' | 'module' | 'external';

export interface CallGraphNode {
  readonly id: string;
  readonly label: string;
  readonly name: string;
  readonly filePath: string;
  readonly kind: CallGraphNodeKind;
  readonly className?: string;
  readonly line?: number;
}

export interface CallGraphEdge {
  readonly from: string;
  readonly to: string;
  readonly kind: string;
  readonly callerLine?: number;
}

/** callgraph 归一渲染图(仅 Rust 源;无 TS 兜底)。 */
export interface CallGraphGraph {
  readonly nodes: CallGraphNode[];
  readonly edges: CallGraphEdge[];
  readonly stats: {
    nodeCount: number;
    edgeCount: number;
    fileCount: number;
    errorCount: number;
  };
  readonly processRoles: string[];
  readonly source: 'rust';
}

/** 调用图节点 kind emoji。 */
const CALL_KIND_EMOJI: Record<CallGraphNodeKind, string> = {
  method: '🔧',
  function: 'ƒ',
  module: '📦',
  external: '❓'
};

/** 边 kind → mermaid 箭头(kbe 广播/API 用实线或双线;未登记回落 -->)。 */
const CALL_KIND_ARROW: Record<string, string> = {
  local: '-->',
  'self-method': '-.->',
  method: '-->',
  'kbe-broadcast': '==>',
  'kbe-base-clients': '==>',
  'kbe-cross-process': '-.->',
  'kbe-api': '---',
  unknown: '---'
};

/** 边 kind → classDef 填充色(kind 独立配色,图例可辨)。 */
const CALL_KIND_STYLE: Record<CallGraphNodeKind, string> = {
  method: 'fill:#e3f2fd,stroke:#1565c0,stroke-width:2px',
  function: 'fill:#f3e5f5,stroke:#6a1b9a,stroke-width:2px',
  module: 'fill:#fff3e0,stroke:#e65100,stroke-width:2px',
  external: 'fill:#eceff1,stroke:#455a64,stroke-width:1px,stroke-dasharray:3 3'
};

/** 边 kind → 中文图例(未登记回落「未知」)。 */
const CALL_KIND_LABEL: Record<string, string> = {
  local: '本地调用',
  'self-method': '自身方法',
  method: '对象方法',
  'kbe-broadcast': '客户端广播',
  'kbe-base-clients': 'base 广播',
  'kbe-cross-process': '跨进程',
  'kbe-api': '引擎 API',
  unknown: '未知'
};

/** basename 去 `.py`(与 Rust file_stem 同口径)。 */
function callGraphFileStem(filePath: string): string {
  const base = filePath.split('/').pop() ?? filePath;
  return base.endsWith('.py') ? base.slice(0, -3) : base;
}

/**
 * Rust 调用图 → CallGraphGraph:以 RPC 节点为种子,边逐条解析被调方,
 * 未解析补 stub(ext:/kbe: 外部节点),绝不丢调用点。from/to 都用统一
 * 逻辑 id(经 sanitizeRustId 洗成 mermaid id 时两侧一致)。
 */
export function normalizeCallGraph(graph: PythonCallGraphRustResult): CallGraphGraph {
  const nodes = new Map<string, CallGraphNode>();
  const edges: CallGraphEdge[] = [];

  const toKind = (kind: string): CallGraphNodeKind =>
    kind === 'method' ? 'method' : kind === 'function' ? 'function' : 'module';

  const seed = (node: PythonCallGraphNode): void => {
    const kind = toKind(node.kind);
    nodes.set(node.id, {
      id: node.id,
      label: `${CALL_KIND_EMOJI[kind]} ${node.name}`,
      name: node.name,
      filePath: node.filePath,
      kind,
      ...(node.className !== undefined ? { className: node.className } : {}),
      ...(node.line !== undefined ? { line: node.line } : {})
    });
  };
  for (const node of graph.nodes) {
    seed(node);
  }

  const ensure = (
    id: string,
    name: string,
    filePath: string,
    kind: CallGraphNodeKind
  ): void => {
    if (!nodes.has(id)) {
      nodes.set(id, {
        id,
        label: `${CALL_KIND_EMOJI[kind]} ${name}`,
        name,
        filePath,
        kind
      });
    }
  };

  const moduleCaller = '<module>';
  for (const edge of graph.edges) {
    const stem = callGraphFileStem(edge.filePath);
    // 调用方节点 id:类方法 `Class.method` / 顶层 `<stem>` / 模块函数 `<stem>::func`。
    const fromId = edge.callerClass
      ? `${edge.callerClass}.${edge.caller}`
      : edge.caller === moduleCaller
        ? stem
        : `${stem}::${edge.caller}`;
    ensure(
      fromId,
      edge.caller === moduleCaller ? stem : edge.caller,
      edge.filePath,
      edge.callerClass ? 'method' : edge.caller === moduleCaller ? 'module' : 'function'
    );

    // 被调方节点 id(未解析补 stub,外部用 ext:/kbe: 前缀)。
    let toId: string;
    let toKind: CallGraphNodeKind;
    switch (edge.kind) {
      case 'self-method':
        toId = `${edge.callerClass ?? ''}${edge.callerClass ? '.' : ''}${edge.callee}`;
        toKind = 'method';
        break;
      case 'local':
        toId = `${stem}::${edge.callee}`;
        toKind = 'function';
        break;
      case 'method':
        toId = `ext:${edge.receiver ?? '?'}.${edge.callee}`;
        toKind = 'external';
        break;
      case 'kbe-broadcast':
      case 'kbe-base-clients':
      case 'kbe-cross-process':
      case 'kbe-api':
        toId = `kbe:${edge.callee}`;
        toKind = 'external';
        break;
      default:
        toId = `ext:${edge.callee}`;
        toKind = 'external';
        break;
    }
    ensure(toId, edge.callee, edge.filePath, toKind);

    edges.push({
      from: fromId,
      to: toId,
      kind: edge.kind,
      ...(edge.callerLine !== undefined ? { callerLine: edge.callerLine } : {})
    });
  }

  return {
    nodes: [...nodes.values()],
    edges,
    stats: {
      nodeCount: nodes.size,
      edgeCount: edges.length,
      fileCount: graph.stats.fileCount,
      errorCount: graph.stats.errorCount
    },
    processRoles: graph.processRoles,
    source: 'rust'
  };
}

/**
 * callgraph 渲染:mermaid graph TD + 节点/边/click/classDef。边箭头按 kind,
 * 节点 classDef 按 kind 出现顺序规范序;空图输出仅表头(与 dependency 同)。
 */
export function renderCallGraphMermaid(graph: CallGraphGraph): string {
  let mermaid = 'graph TD\n';
  for (const node of graph.nodes) {
    mermaid += `  ${sanitizeRustId(node.id)}["${node.label}"]\n`;
  }
  for (const edge of graph.edges) {
    const arrow = CALL_KIND_ARROW[edge.kind] ?? '-->';
    mermaid += `  ${sanitizeRustId(edge.from)} ${arrow} ${sanitizeRustId(edge.to)}\n`;
  }
  for (const node of graph.nodes) {
    if (node.filePath) {
      mermaid += clickLine({ id: sanitizeRustId(node.id), filePath: node.filePath });
    }
  }
  mermaid += '\n';
  const kindOrder: CallGraphNodeKind[] = ['method', 'function', 'module', 'external'];
  for (const kind of kindOrder) {
    if (graph.nodes.some((node) => node.kind === kind)) {
      mermaid += `  classDef ${kind}Call ${CALL_KIND_STYLE[kind]};\n`;
    }
  }
  for (const node of graph.nodes) {
    mermaid += `  class ${sanitizeRustId(node.id)} ${node.kind}Call;\n`;
  }
  return mermaid;
}

/** callgraph 图例 HTML(按出现 kind 出;边 kind 图例固定 8 类)。 */
function callGraphLegendHtml(): string {
  const nodeLegend = (['method', 'function', 'module', 'external'] as CallGraphNodeKind[])
    .map(
      (kind) => `<div class="legend-item">
      <div class="legend-dot" style="background-color: ${CALL_KIND_STYLE[kind].split(',')[0].split(':')[1]};"></div>
      <span>${kind === 'method' ? '方法' : kind === 'function' ? '函数' : kind === 'module' ? '模块' : '外部/未解析'}</span>
    </div>`
    )
    .join('\n');
  const edgeLegend = Object.entries(CALL_KIND_LABEL)
    .map(
      ([kind, label]) => `<div class="legend-item">
      <span>${CALL_KIND_ARROW[kind] ?? '-->'} ${label}</span>
    </div>`
    )
    .join('\n');
  return nodeLegend + '\n' + edgeLegend;
}

/** 面板双模式。 */
export type DependencyPanelMode = 'dependency' | 'callgraph';

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
  private currentCallGraph: CallGraphGraph | null = null;
  private pendingExport: { format: 'png' | 'svg'; uri: vscode.Uri } | null = null;
  private mode: DependencyPanelMode = 'dependency';

  constructor(
    private context: vscode.ExtensionContext,
    private outputChannel: vscode.OutputChannel
  ) {
    this.analyzer = new EntityDependencyAnalyzer(context);
  }

  /** 面板标题(双模式)。 */
  private panelTitle(): string {
    return this.mode === 'callgraph' ? 'KBEngine Python 调用图' : 'KBEngine 实体依赖关系';
  }

  /**
   * 显示依赖图(mode:'dependency'|'callgraph';已开面板时仅切换模式并刷新)。
   */
  async show(mode: DependencyPanelMode = 'dependency'): Promise<void> {
    const modeChanged = this.mode !== mode;
    this.mode = mode;
    if (this.panel) {
      this.panel.title = this.panelTitle();
      this.panel.reveal();
      if (modeChanged) {
        await this.refreshGraph();
      }
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      'kbengine.entityDependency',
      this.panelTitle(),
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
          case 'setMode':
            if (
              (message.mode === 'dependency' || message.mode === 'callgraph') &&
              this.panel
            ) {
              this.mode = message.mode;
              this.panel.title = this.panelTitle();
              await this.refreshGraph();
            }
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
   * 刷新依赖图:按模式分流。
   * - dependency:Rust 核心优先(实体→def→接口/组件/types.xml/python 全图),
   *   不可用(无 gate/调用失败/形状不符)回落 TS 分析器(降级实体图)。
   * - callgraph:收集 workspace 全部根 *.py 原文直传 Rust `$/kode/python/callgraph`;
   *   Rust 不可用 → 面板徽标「Rust 不可用」+ 空图注记(无 TS 兜底,不虚构)。
   */
  private async refreshGraph(): Promise<void> {
    if (!this.panel) {
      return;
    }

    try {
      if (this.mode === 'callgraph') {
        await this.refreshCallGraph();
        return;
      }
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
      this.panel.webview.html = this.getWebviewContent(mermaidGraph, render, null, false);
    } catch (error) {
      this.outputChannel.appendLine(`刷新依赖图失败: ${error}`);
      vscode.window.showErrorMessage(`刷新依赖图失败: ${error}`);
    }
  }

  /** workspace 全部根 *.py(含 scripts/assets,不深入 node_modules/out)。 */
  private async collectPythonFiles(
    root: string
  ): Promise<Array<{ path: string; text: string }>> {
    const uris = await vscode.workspace.findFiles(
      new vscode.RelativePattern(root, '**/*.py'),
      '{**/node_modules/**,**/out/**,**/.vscode-test/**,**/.git/**}',
      10_000
    );
    return uris.map((uri) => ({
      path: uri.fsPath,
      text: readWorkspaceTextFile(uri.fsPath)
    }));
  }

  /** callgraph 模式刷新:收集全部 *.py → Rust RPC → 归一 → 渲染。 */
  private async refreshCallGraph(): Promise<void> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root || !this.panel) {
      return;
    }
    let callGraph: CallGraphGraph | null = null;
    let rustUnavailable = false;
    try {
      const files = await this.collectPythonFiles(root);
      const manifestText = await this.readProcessTopologyText(root);
      const rust = await buildPythonCallGraphInRust({
        files,
        ...(manifestText !== null ? { manifestXmlText: manifestText } : {})
      });
      if (rust) {
        callGraph = normalizeCallGraph(rust);
      } else {
        rustUnavailable = true;
      }
    } catch (rustError) {
      rustUnavailable = true;
      this.outputChannel.appendLine(`Rust 调用图失败: ${rustError}`);
    }

    this.currentCallGraph = callGraph;
    const mermaidGraph = callGraph ? renderCallGraphMermaid(callGraph) : '';
    this.panel.webview.html = this.getWebviewContent(
      mermaidGraph,
      null,
      callGraph,
      rustUnavailable
    );
  }

  /** `<root>/process_topology.xml` 原文(缺省 null → RPC 侧空清单)。 */
  private async readProcessTopologyText(root: string): Promise<string | null> {
    const uri = vscode.Uri.joinPath(vscode.Uri.file(root), 'process_topology.xml');
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      return Buffer.from(bytes).toString('utf8');
    } catch {
      return null;
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
   * 获取 Webview 内容(双模式:dependency 渲染 RenderGraph;callgraph 渲染
   * CallGraphGraph,Rust 不可用时出空图注记)
   */
  private getWebviewContent(
    mermaidGraph: string,
    graph: RenderGraph | null,
    callGraph: CallGraphGraph | null,
    rustUnavailable: boolean
  ): string {
    const title = this.panelTitle();
    const isCallGraph = this.mode === 'callgraph';
    const sourceBadge = isCallGraph
      ? rustUnavailable
        ? 'Rust 不可用'
        : 'Rust 核心'
      : graph && graph.source === 'rust'
        ? 'Rust 核心'
        : 'TS 兜底';

    const statsHtml = isCallGraph
      ? [
        this.statCard('文件', callGraph?.stats.fileCount ?? 0),
        this.statCard('节点', callGraph?.stats.nodeCount ?? 0),
        this.statCard('调用边', callGraph?.stats.edgeCount ?? 0),
        this.statCard('语法错误', callGraph?.stats.errorCount ?? 0),
        this.statCard(
          '进程角色',
          callGraph && callGraph.processRoles.length > 0
            ? callGraph.processRoles.join(', ')
            : '-'
        )
      ].join('\n')
      : graph && graph.source === 'rust'
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
          this.statCard('总实体数', graph?.legacyStats?.totalEntities ?? 0),
          this.statCard('Base 实体', graph?.legacyStats?.baseEntities ?? 0),
          this.statCard('Cell 实体', graph?.legacyStats?.cellEntities ?? 0),
          this.statCard('Client 实体', graph?.legacyStats?.clientEntities ?? 0),
          this.statCard('最大继承深度', graph?.legacyStats?.maxDepth ?? 0),
          this.statCard('最常引用', graph?.legacyStats?.mostReferenced || '-')
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
    </div>`;

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
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
    <div class="title">${title}</div>
    <div style="display: flex; align-items: center; gap: 10px;">
      <span class="source-badge">${sourceBadge}</span>
      <div class="toolbar">
        <select id="mode-select" onchange="setMode(this.value)" style="padding: 8px; background-color: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border);">
          <option value="dependency" ${isCallGraph ? '' : 'selected'}>实体依赖</option>
          <option value="callgraph" ${isCallGraph ? 'selected' : ''}>调用图</option>
        </select>
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
${graphHtml}
  </div>

  <div class="legend">
${legendHtml}
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
    const hasGraph = this.mode === 'callgraph' ? !!this.currentCallGraph : !!this.currentRender;
    if (!hasGraph || !this.panel) {
      vscode.window.showWarningMessage('没有可导出的图表');
      return;
    }

    const filename =
      this.mode === 'callgraph' ? `python-call-graph.${format}` : `entity-dependency.${format}`;
    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(filename),
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
