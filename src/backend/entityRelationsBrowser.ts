import type { RenderEdge, RenderGraph, RenderNode, RenderNodeKind } from '../entityDependencyGraphView';

/**
 * 实体关系浏览器(RUST-178/KBE-008)纯核,零 vscode:
 * 在既有依赖全图(RenderGraph,Rust 核心或 TS 兜底源归一后的同一形状)之上
 * 提供「聚焦实体 → 双向邻接 → 按需展开」的懒加载视图模型。双向 = 展开一个
 * 节点时同时收集以它为起点的边(组件/属性类型/实现)与指向它的边(继承/
 * 注册/被引用);懒加载 = 初始只显示焦点与其直接邻接,深层节点点击后逐层
 * 展开,全图数据驻留宿主内存,面板只渲染已可见子图。
 *
 * 渲染复用面:relationsToRenderGraph 把视图模型投影回 RenderGraph 形状
 * (source/paths 原样保留,stats 按子图重算,legacyStats 不带出——子图统计
 * 决不冒充全图口径),供面板 generateMermaidGraph 走各自 source 的既有渲染
 * 分支。relations mermaid 的点击语义由 renderRelationsMermaid 的指令行
 * 区分:已展开节点发 openFilePath(点击开文件),未展开节点发
 * relationsExpand(点击展开)——HTML 委托按两种指令各自解析,面板无需
 * 额外状态注入。
 *
 * 诚实边界:焦点 id 不在图内 → ok:false + 候选清单(决不猜测相近名);
 * 幂等展开(重复点击/未知节点)如实返回 expanded:false 零增量;边按
 * (from,to,kind) 去重防全图重复边在子图里翻倍。
 */

/** 视图节点:全图邻接数是懒加载徽标(「还可展开 N」),与展开态独立。 */
export interface RelationsViewNode {
  readonly id: string;
  readonly name: string;
  readonly kind: RenderNodeKind;
  readonly filePath: string;
  /** 全图直接邻接数(出+入去重),含已可见邻接 */
  readonly neighborCount: number;
  readonly expanded: boolean;
  /** 距焦点的展开层数(焦点=0,每跳 +1;先见者保留先见深度) */
  readonly depth: number;
}

export interface RelationsViewModel {
  readonly focusId: string;
  readonly nodes: readonly RelationsViewNode[];
  /** 可见边(两端点均已可见),按 (from,to,kind) 去重 */
  readonly edges: readonly RenderEdge[];
  /** 已展开节点 id(含焦点;决定渲染指令行与点击语义) */
  readonly expandedIds: readonly string[];
}

export type EntityRelationsViewResult =
  | { readonly ok: true; readonly model: RelationsViewModel }
  | { readonly ok: false; readonly reason: 'focus-not-found'; readonly candidates: readonly string[] };

export interface EntityRelationsExpansion {
  readonly model: RelationsViewModel;
  /** 本次是否真的展开了新节点(幂等重放/未知节点 = false 零增量) */
  readonly expanded: boolean;
  readonly addedNodes: number;
  readonly addedEdges: number;
}

/** 节点直接邻接表(出+入统一;id → 邻接 id 集) */
function buildAdjacency(edges: readonly RenderEdge[]): Map<string, Set<string>> {
  const adjacency = new Map<string, Set<string>>();
  const touch = (id: string): Set<string> => {
    let set = adjacency.get(id);
    if (!set) {
      set = new Set<string>();
      adjacency.set(id, set);
    }
    return set;
  };
  for (const edge of edges) {
    touch(edge.from).add(edge.to);
    touch(edge.to).add(edge.from);
  }
  return adjacency;
}

/** 可见边收集:两端点可见才收,按 (from,to,kind) 去重防重复边翻倍 */
function visibleEdges(edges: readonly RenderEdge[], visible: ReadonlySet<string>): RenderEdge[] {
  const result: RenderEdge[] = [];
  const seen = new Set<string>();
  for (const edge of edges) {
    if (!visible.has(edge.from) || !visible.has(edge.to)) {
      continue;
    }
    const key = `${edge.from}\u0000${edge.to}\u0000${edge.kind}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(edge);
  }
  return result;
}

/** 视图节点生产(全图邻接数独立于可见性,供懒加载徽标;深度按 depthById) */
function buildViewNodes(
  graph: RenderGraph,
  visible: ReadonlySet<string>,
  adjacency: ReadonlyMap<string, Set<string>>,
  expanded: ReadonlySet<string>,
  depthBy: ReadonlyMap<string, number>
): RelationsViewNode[] {
  const nodes: RelationsViewNode[] = [];
  for (const node of graph.nodes) {
    if (!visible.has(node.id)) {
      continue;
    }
    nodes.push({
      id: node.id,
      name: node.name,
      kind: node.kind,
      filePath: node.filePath,
      neighborCount: adjacency.get(node.id)?.size ?? 0,
      expanded: expanded.has(node.id),
      depth: depthBy.get(node.id) ?? 0
    });
  }
  return nodes;
}

/**
 * 创建视图:焦点 + 双向直接邻接立即可见(第一层免费),焦点记为已展开,
 * 邻接节点待点击展开(懒加载从第二层起)。
 */
export function createEntityRelationsViewModel(
  graph: RenderGraph,
  focusId: string
): EntityRelationsViewResult {
  const focus = graph.nodes.find(node => node.id === focusId);
  if (!focus) {
    return { ok: false, reason: 'focus-not-found', candidates: relationFocusCandidates(graph) };
  }
  const adjacency = buildAdjacency(graph.edges);
  const direct = adjacency.get(focusId) ?? new Set<string>();
  const visible = new Set<string>([focusId, ...direct]);
  const expanded = new Set<string>([focusId]);
  const depthBy = new Map<string, number>([[focusId, 0]]);
  for (const neighbor of direct) {
    depthBy.set(neighbor, 1);
  }
  return {
    ok: true,
    model: {
      focusId,
      nodes: buildViewNodes(graph, visible, adjacency, expanded, depthBy),
      edges: visibleEdges(graph.edges, visible),
      expandedIds: [focusId]
    }
  };
}

/**
 * 懒展开:把 nodeId 的全图邻接并入可见集(双向),重算可见边。
 * 幂等:节点不可见/已展开/全图无此节点 → expanded:false 原模型返回。
 */
export function expandEntityRelations(
  model: RelationsViewModel,
  graph: RenderGraph,
  nodeId: string
): EntityRelationsExpansion {
  const visible = new Set<string>(model.nodes.map(node => node.id));
  const expanded = new Set<string>(model.expandedIds);
  if (!visible.has(nodeId) || expanded.has(nodeId) || !graph.nodes.some(node => node.id === nodeId)) {
    return { model, expanded: false, addedNodes: 0, addedEdges: 0 };
  }
  const adjacency = buildAdjacency(graph.edges);
  const beforeCount = visible.size;
  const depthBy = new Map<string, number>(model.nodes.map(node => [node.id, node.depth]));
  const nodeDepth = depthBy.get(nodeId) ?? 0;
  for (const neighbor of adjacency.get(nodeId) ?? new Set<string>()) {
    visible.add(neighbor);
    if (!depthBy.has(neighbor)) {
      depthBy.set(neighbor, nodeDepth + 1);
    }
  }
  expanded.add(nodeId);
  const nextEdges = visibleEdges(graph.edges, visible);
  const nextModel: RelationsViewModel = {
    focusId: model.focusId,
    nodes: buildViewNodes(graph, visible, adjacency, expanded, depthBy),
    edges: nextEdges,
    expandedIds: [...expanded]
  };
  return {
    model: nextModel,
    expanded: true,
    addedNodes: nextModel.nodes.length - beforeCount,
    addedEdges: nextEdges.length - model.edges.length
  };
}

/**
 * 视图模型 → RenderGraph 子图投影(source/paths 原样保留;stats 按子图
 * 重算;legacyStats 不带出——那是全图口径,子图统计不冒充)。
 */
export function relationsToRenderGraph(model: RelationsViewModel, source: RenderGraph): RenderGraph {
  const byId = new Map(source.nodes.map(node => [node.id, node]));
  const nodes = model.nodes
    .map(node => byId.get(node.id))
    .filter((node): node is RenderNode => node !== undefined);
  const countBy = (kind: RenderNodeKind): number => nodes.filter(node => node.kind === kind).length;
  // ts 兜底源的统计卡走 legacyStats 分支(模板按 source 分叉):这里按
  // **当前子图**口径如实重算(实体数/types 三面/可见深度/可见边最热节点),
  // 决不带出全图 legacyStats 冒充
  const incident = new Map<string, number>();
  for (const edge of model.edges) {
    incident.set(edge.from, (incident.get(edge.from) ?? 0) + 1);
    incident.set(edge.to, (incident.get(edge.to) ?? 0) + 1);
  }
  let mostReferenced = '-';
  let maxIncident = 0;
  for (const node of model.nodes) {
    const count = incident.get(node.id) ?? 0;
    if (count > maxIncident) {
      maxIncident = count;
      mostReferenced = node.name;
    }
  }
  const typesInclude = (face: string): number =>
    nodes.filter(node => (node.types ?? []).includes(face)).length;
  return {
    nodes,
    edges: [...model.edges],
    paths: source.paths,
    stats: {
      nodeCount: nodes.length,
      edgeCount: model.edges.length,
      entityCount: countBy('entity'),
      defCount: countBy('def'),
      interfaceCount: countBy('interface'),
      componentCount: countBy('component'),
      typeCount: countBy('type'),
      pythonCount: countBy('python')
    },
    legacyStats: {
      totalEntities: countBy('entity'),
      baseEntities: typesInclude('Base'),
      cellEntities: typesInclude('Cell'),
      clientEntities: typesInclude('Client'),
      maxDepth: model.nodes.reduce((max, node) => Math.max(max, node.depth), 0),
      mostReferenced
    },
    source: source.source
  };
}

/**
 * 焦点解析:id 精确命中优先;否则按名字命中(实体 kind 优先,再取首个
 * 声明序命中)。活跃编辑器 .def/.py 文件基名可直接作 focus 传入。
 */
export function resolveRelationsFocusId(graph: RenderGraph, focus: string): string | null {
  if (focus.length === 0) {
    return null;
  }
  if (graph.nodes.some(node => node.id === focus)) {
    return focus;
  }
  const byName = graph.nodes.filter(node => node.name === focus);
  if (byName.length === 0) {
    return null;
  }
  const entity = byName.find(node => node.kind === 'entity');
  return (entity ?? byName[0]).id;
}

/** 候选清单:实体优先(名字序),其余 kind 随后(名字序);id 去重。 */
export function relationFocusCandidates(graph: RenderGraph): string[] {
  const entities = graph.nodes
    .filter(node => node.kind === 'entity')
    .map(node => node.name)
    .sort((a, b) => a.localeCompare(b));
  const others = graph.nodes
    .filter(node => node.kind !== 'entity')
    .map(node => node.name)
    .sort((a, b) => a.localeCompare(b));
  return [...new Set([...entities, ...others])];
}

const RELATIONS_ARROW: Record<string, string> = {
  inheritance: '-->',
  registration: '---',
  'is-a': '-.->',
  'has-a': '--o',
  implements: '==>',
  'property-type': '-->',
  'method-impl': '-.->'
};

const RELATIONS_KIND_ORDER: RenderNodeKind[] = ['entity', 'def', 'interface', 'component', 'type', 'python'];

const RELATIONS_KIND_STYLE: Record<RenderNodeKind, string> = {
  entity: 'fill:#173a5e,stroke:#3794ff,stroke-width:2px;',
  def: 'fill:#1d3a2a,stroke:#89d185,stroke-width:2px;',
  interface: 'fill:#3a2d10,stroke:#cca700,stroke-width:2px;',
  component: 'fill:#2d1d3a,stroke:#c586c0,stroke-width:2px;',
  type: 'fill:#3a3a3a,stroke:#aaaaaa,stroke-width:1px;',
  python: 'fill:#0f2a1f,stroke:#4ec9b0,stroke-width:2px;'
};

const RELATIONS_FOCUS_STYLE = 'fill:#4b2e83,stroke:#d7a4ff,stroke-width:3px;';

/** mermaid 指令行的字符串引号转义(与既有 clickLine 同口径) */
function escapeDirectiveValue(value: string): string {
  return value.replace(/"/g, '\\"');
}

/**
 * 关系子图 mermaid 渲染。与全图渲染的关键差异在指令行:
 * - 已展开节点(含焦点)带文件路径 → `click <id> openFilePath "<path>"`,
 *   点击行为 = 打开文件(与全图一致);
 * - 未展开节点 → `click <id> relationsExpand "<id>"`,HTML 委托解析后发
 *   expand 消息;节点标签尾缀 `＋N`(全图邻接数)露出懒加载可供性。
 * 箭头与 classDef 按图 source 分支:rust 源按边 kind 分箭头/按 kind 出
 * classDef;ts 兜底源一律实线箭头 + Base/Cell/Client 类型 class(与全图
 * 两分支口径一一对应)。焦点节点追加 focusNode class 高亮。
 */
export function renderRelationsMermaid(model: RelationsViewModel, source: RenderGraph): string {
  const byId = new Map(source.nodes.map(node => [node.id, node]));
  const expanded = new Set(model.expandedIds);
  let mermaid = 'graph TD\n';
  for (const viewNode of model.nodes) {
    const badge = viewNode.expanded ? '' : `＋${viewNode.neighborCount}`;
    mermaid += `  ${viewNode.id}["${viewNode.name}${badge}"]\n`;
  }
  for (const edge of model.edges) {
    if (source.source === 'rust') {
      const arrow = RELATIONS_ARROW[edge.kind] ?? '-->';
      mermaid += edge.label !== undefined
        ? `  ${edge.from} ${arrow}|${edge.label}| ${edge.to}\n`
        : `  ${edge.from} ${arrow} ${edge.to}\n`;
    } else {
      const label = edge.label ?? '';
      mermaid += label
        ? `  ${edge.from} -->|${label}| ${edge.to}\n`
        : `  ${edge.from} --> ${edge.to}\n`;
    }
  }
  for (const viewNode of model.nodes) {
    if (expanded.has(viewNode.id) && viewNode.filePath) {
      mermaid += `  click ${viewNode.id} openFilePath "${escapeDirectiveValue(viewNode.filePath)}"\n`;
    } else if (!expanded.has(viewNode.id)) {
      mermaid += `  click ${viewNode.id} relationsExpand "${escapeDirectiveValue(viewNode.id)}"\n`;
    }
  }
  if (source.source === 'rust') {
    for (const kind of RELATIONS_KIND_ORDER) {
      if (model.nodes.some(node => node.kind === kind)) {
        mermaid += `  classDef ${kind}Node ${RELATIONS_KIND_STYLE[kind]};\n`;
      }
    }
    for (const viewNode of model.nodes) {
      const origin = byId.get(viewNode.id);
      if (origin && viewNode.id !== model.focusId) {
        mermaid += `  class ${viewNode.id} ${origin.kind}Node;\n`;
      }
    }
  } else {
    mermaid += '\n  classDef baseNode fill:#173a5e,stroke:#3794ff,stroke-width:2px;\n';
    mermaid += '  classDef cellNode fill:#1d3a2a,stroke:#89d185,stroke-width:2px;\n';
    mermaid += '  classDef clientNode fill:#3a2d10,stroke:#cca700,stroke-width:2px;\n';
    for (const viewNode of model.nodes) {
      const origin = byId.get(viewNode.id);
      const types = origin?.types ?? [];
      if (types.includes('Base')) {
        mermaid += `  class ${viewNode.id} baseNode;\n`;
      }
      if (types.includes('Cell')) {
        mermaid += `  class ${viewNode.id} cellNode;\n`;
      }
      if (types.includes('Client')) {
        mermaid += `  class ${viewNode.id} clientNode;\n`;
      }
    }
  }
  if (model.nodes.some(node => node.id === model.focusId)) {
    mermaid += `  classDef focusNode ${RELATIONS_FOCUS_STYLE}\n`;
    mermaid += `  class ${model.focusId} focusNode;\n`;
  }
  return mermaid;
}
