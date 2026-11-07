// SRC-012:entityDependencyWebView.ts 依赖图渲染半边迁出(纯移动):渲染层类型
// (RenderNodeKind/RenderNode/RenderEdge/RenderGraph)、样式/emoji 表、rust id 清洗、
// 三源归一(normalizeDependencyGraph/normalizeGraphSource/normalizeRustGraph)与
// legacy/rust 两 mermaid 渲染。区域原文零改动(仅 renderLegacy/renderRustMermaid
// 补 export 供面板类调用);类型-only 导入,运行时无环。
import type { DependencyGraph } from './entityDependency';
import type { DependencyGraphRust } from './dependencyGraphRust';
import type { DependencyGraphSource } from './warmupStages';
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
  entity: 'fill:#173a5e,stroke:#3794ff,stroke-width:2px',
  def: 'fill:#243a44,stroke:#75beff,stroke-width:2px',
  interface: 'fill:#103a35,stroke:#4ec9b0,stroke-width:2px',
  component: 'fill:#2d1d3a,stroke:#c586c0,stroke-width:2px',
  type: 'fill:#3a2d10,stroke:#cca700,stroke-width:2px',
  python: 'fill:#1d3a2a,stroke:#89d185,stroke-width:2px'
};

/** Rust 源边 kind → mermaid 箭头;未登记 kind 回落 -->。 */
const RUST_ARROW: Record<string, string> = {
  inheritance: '-->',
  // `--` 在 mermaid 12 语法里是断链(必须 `---`/`-->`),整图报语法错
  registration: '---',
  'is-a': '-.->',
  'has-a': '--o',
  implements: '==>',
  'property-type': '-->',
  'method-impl': '-.->'
};

/** mermaid id 清洗:非 [A-Za-z0-9_] 一律 '_'(entity:Hero→entity_Hero)。 */
export function sanitizeRustId(rawId: string): string {
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
 * BG-WARM:预热产物 → 渲染图。Rust 源走 rust 归一,TS 兜底源走 legacy 归一,
 * 与现算路径同源同口径(产物只是把同一计算挪到后台提前做)。
 */
export function normalizeGraphSource(source: DependencyGraphSource): RenderGraph {
  return source.kind === 'rust'
    ? normalizeRustGraph(source.graph as DependencyGraphRust)
    : normalizeDependencyGraph(source.graph as DependencyGraph);
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
export function clickLine(node: { id: string; filePath: string }): string {
  return `  click ${node.id} openFilePath "${node.filePath.replace(/"/g, '\\"')}"\n`;
}

/**
 * TS 兜底渲染:节点/边/三 classDef 输出与迁移前逐字节一致,仅追加 click
 * 指令(空图无节点,输出不变)。
 */
export function renderLegacyMermaid(graph: RenderGraph): string {
  let mermaid = 'graph TD\n';

  // 添加节点
  for (const node of graph.nodes) {
    mermaid += `  ${node.id}["${node.label}"]\n`;
  }

  // 添加边(继承/组合等一律实线箭头)。空标签不输出管道段:离线打包的
  // mermaid(@mermaid-js/tiny 12)对 `-->||` 直接报语法错,整图渲染失败。
  for (const edge of graph.edges) {
    const label = edge.label ?? '';
    mermaid += label
      ? `  ${edge.from} -->|${label}| ${edge.to}\n`
      : `  ${edge.from} --> ${edge.to}\n`;
  }

  // 添加点击跳转
  for (const node of graph.nodes) {
    if (node.filePath) {
      mermaid += clickLine(node);
    }
  }

  // 添加样式
  mermaid += '\n  classDef baseNode fill:#173a5e,stroke:#3794ff,stroke-width:2px;\n';
  mermaid += '  classDef cellNode fill:#1d3a2a,stroke:#89d185,stroke-width:2px;\n';
  mermaid += '  classDef clientNode fill:#3a2d10,stroke:#cca700,stroke-width:2px;\n';

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
export function renderRustMermaid(graph: RenderGraph): string {
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
