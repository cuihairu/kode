// SRC-012:entityDependencyWebView.ts 调用图渲染半边迁出(纯移动):收集上界常量
// (CALLGRAPH_*)、调用图类型(CollectedPythonFiles/CallGraphNode/Edge/Graph)、
// KIND 表、文件词干、Rust 符号归一(normalizeCallGraph)与 mermaid 渲染+图例。
// 区域原文零改动(仅 callGraphLegendHtml 补 export 供面板类调用);类型-only 导入。
import { clickLine, sanitizeRustId } from './entityDependencyGraphView';
import type { PythonCallGraphNode, PythonCallGraphRustResult } from './backend/pythonCallGraphRust';
// ---------------------------------------------------------------------------
// C-20 callgraph 模式:类型/常量/归一/渲染
// ---------------------------------------------------------------------------

// KODE-PERF-004:callgraph 收集面常量(导出供测试锁值)。
/** 收集 *.py 文件数上限:超限截断并出警告条(明确策略,不静默装完整)。 */
export const CALLGRAPH_MAX_FILES = 10_000;
/** 有界并发异步读上限(宿主不阻塞)。 */
export const CALLGRAPH_READ_CONCURRENCY = 8;
/** callgraph 收集排除 glob(不深入 node_modules/out/vscode-test/git)。 */
export const CALLGRAPH_EXCLUDE_GLOB =
  '{**/node_modules/**,**/out/**,**/.vscode-test/**,**/.git/**}';

/** KODE-PERF-004:收集结果(文件集 + 截断信息)。 */
export interface CollectedPythonFiles {
  files: Array<{ path: string; text: string }>;
  /** 超上限截断标记(明确策略=面板出警告条,不静默装完整)。 */
  truncated: boolean;
  /** 全部根实际发现 *.py 总数(截断时 > files.length)。 */
  totalDiscovered: number;
}

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
    /** KODE-PERF-004:超上限截断(明确策略,面板出警告条)。 */
    truncated?: boolean;
    /** 全部根实际发现总数(截断时 > fileCount)。 */
    totalDiscovered?: number;
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
  method: 'fill:#173a5e,stroke:#3794ff,stroke-width:2px',
  function: 'fill:#243a44,stroke:#75beff,stroke-width:2px',
  module: 'fill:#2d1d3a,stroke:#c586c0,stroke-width:2px',
  external: 'fill:#333333,stroke:#808080,stroke-width:1px,stroke-dasharray:3 3'
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
    const fromId = edge.callerId ?? (edge.callerClass
      ? `${edge.callerClass}.${edge.caller}`
      : edge.caller === moduleCaller
        ? stem
        : `${stem}::${edge.caller}`);
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
    toId = edge.calleeId ?? toId;
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
export function callGraphLegendHtml(): string {
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
