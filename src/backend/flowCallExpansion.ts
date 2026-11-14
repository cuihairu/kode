/**
 * KFLOW 本地调用树展开(FLOW-005,G2 静态调用路径的聚合核)。
 *
 * 验收:支持入口向下/调用者向上、分支条件、递归环和深度截断;同一函数
 * 多次调用保留调用点,不直接压成一个帧。输入 = FLOW-004 解析核逐文件结果
 * (宿主提供 resolveFile;跨文件节点按协议身份 id 合并),输出 = FlowGraph
 * (FLOW-003 协议)。
 *
 * 口径:
 *   - 入口向下(downstream):从根函数帧 DFS;函数帧的出边取自其**声明文件**
 *     的解析结果(fn.filePath;模块伪帧按含其出边的文件回捞);rpc-declaration
 *     /unresolved/external-entry 是死端(跨进程落点与客户端证据归 FLOW-006/
 *     007,不在本核展开);
 *   - 调用者向上(upstream):先对全部登记文件建反向索引(toNodeId→调用边),
 *     再 DFS caller 链;上游视图的边以 direction.kind='upstream-caller' 重建
 *     (调用方向 from=caller 不变,只是查询语境标记);
 *   - 分支条件:边携带 FLOW-004 的 condition 候选(展开原样保留,不裁定
 *     执行顺序);
 *   - 递归环:目标已在当前 DFS 路径(祖先含自身)→ 该边标 unresolvedReason
 *     {code:'recursion'},不沿环续展(节点本体仍是已解析函数,首次入图);
 *   - 深度截断:达 maxDepth 的节点**出边与目标节点照常入图**(事实),但不再
 *     展开,query.truncatedAtDepth=maxDepth 如实记录,不静默;
 *   - 调用点保留:边身份含调用点,解析层已按调用点多条出边,展开层不去重
 *     合并(同节点对多次调用=多条边,协议保证)。
 */

import {
  flowGraphEdge,
  type FlowGraph,
  type FlowGraphEdge,
  type FlowGraphNode,
  type FlowUnresolvedReason
} from './flowGraphModel';
import type { FlowCallResolverResult } from './flowCallResolver';

export interface FlowExpansionInput {
  /** 根函数:声明文件 + 封闭类(模块函数=null)+ 函数名 */
  root: { filePath: string; className: string | null; functionName: string };
  direction: 'downstream' | 'upstream';
  /** 最大展开深度(根=0;达界的帧不再下钻,出边与目标节点仍入图) */
  maxDepth: number;
  /** 反向索引扫描域(upstream 需要;downstream 可传空数组) */
  files: string[];
  /** 逐文件解析(宿主缓存;null=读不到,如实死端) */
  resolveFile: (filePath: string) => FlowCallResolverResult | null;
}

export interface FlowExpansionResult {
  graph: FlowGraph;
  /** 实际下钻过的函数帧数(含达界帧,不含死端) */
  expandedNodeCount: number;
  /** 被标递归环的边数 */
  recursionEdgeCount: number;
}

interface FileBundle {
  result: FlowCallResolverResult;
  nodesById: Map<string, FlowGraphNode>;
}

export function expandFlowCallTree(
  input: FlowExpansionInput
): FlowExpansionResult {
  const fileBundles = new Map<string, FileBundle | null>();
  const bundleOf = (filePath: string): FileBundle | null => {
    const cached = fileBundles.get(filePath);
    if (cached !== undefined) {
      return cached;
    }
    const result = input.resolveFile(filePath);
    const bundle: FileBundle | null = result
      ? {
          result,
          nodesById: new Map(result.nodes.map(node => [node.id, node]))
        }
      : null;
    fileBundles.set(filePath, bundle);
    return bundle;
  };

  const graphNodes = new Map<string, FlowGraphNode>();
  const graphEdges = new Map<string, FlowGraphEdge>();
  const addNode = (node: FlowGraphNode): void => {
    if (!graphNodes.has(node.id)) {
      graphNodes.set(node.id, node);
    }
  };
  const addEdge = (edge: FlowGraphEdge): void => {
    graphEdges.set(edge.id, edge);
  };
  /** 环标记:重建同身份边(原因不在边身份里,id 不变)加 recursion 原因 */
  const markRecursion = (edge: FlowGraphEdge, detail: string): FlowGraphEdge =>
    flowGraphEdge({
      fromNodeId: edge.fromNodeId,
      toNodeId: edge.toNodeId,
      callSite: edge.callSite,
      direction: edge.direction,
      syncAsync: edge.syncAsync,
      condition: edge.condition,
      messageKind: edge.messageKind,
      evidence: edge.evidence,
      unresolvedReason: {
        code: 'recursion',
        detail
      } satisfies FlowUnresolvedReason
    });

  // ── 根定位 ──────────────────────────────────────────────────────────
  const rootBundle = bundleOf(input.root.filePath);
  if (!rootBundle) {
    throw new Error(`root file not resolvable: ${input.root.filePath}`);
  }
  const rootNode = rootBundle.result.nodes.find(node =>
    node.kind === 'function' &&
    node.fn?.name === input.root.functionName &&
    node.fn?.filePath === input.root.filePath &&
    (input.root.className
      ? node.entity?.name === input.root.className
      : node.entity === null)
  );
  if (!rootNode) {
    throw new Error(
      `root function not found: ${input.root.className ?? '(module)'}.${input.root.functionName} in ${input.root.filePath}`
    );
  }
  addNode(rootNode);

  const truncated = { hit: false };
  let expandedNodeCount = 0;
  let recursionEdgeCount = 0;

  /** 函数帧的出边所在文件:fn.filePath;模块伪帧按含其出边的文件回捞。 */
  const homeBundleOf = (node: FlowGraphNode): FileBundle | null => {
    if (node.fn?.filePath) {
      return bundleOf(node.fn.filePath);
    }
    for (const bundle of fileBundles.values()) {
      if (bundle && bundle.result.edges.some(edge => edge.fromNodeId === node.id)) {
        return bundle;
      }
    }
    return null;
  };

  // ── 入口向下:声明文件 DFS ─────────────────────────────────────────
  const expandDownstream = (): void => {
    type Frame = { nodeId: string; depth: number; path: string[] };
    const expanded = new Set<string>();
    const stack: Frame[] = [
      { nodeId: rootNode.id, depth: 0, path: [rootNode.id] }
    ];
    while (stack.length > 0) {
      const frame = stack.pop() as Frame;
      if (expanded.has(frame.nodeId)) {
        continue;
      }
      expanded.add(frame.nodeId);
      expandedNodeCount += 1;
      const node = graphNodes.get(frame.nodeId);
      if (!node) {
        continue;
      }
      const home = homeBundleOf(node);
      if (!home) {
        continue;
      }
      if (frame.depth >= input.maxDepth) {
        // 达界:出边与目标节点照常入图(事实),不再下钻,截断如实记录
        truncated.hit = true;
        for (const edge of home.result.edges) {
          if (edge.fromNodeId !== frame.nodeId) {
            continue;
          }
          addEdge(edge);
          const target = home.nodesById.get(edge.toNodeId);
          if (target) {
            addNode(target);
          }
        }
        continue;
      }
      for (const edge of home.result.edges) {
        if (edge.fromNodeId !== frame.nodeId) {
          continue;
        }
        addEdge(edge);
        const target = home.nodesById.get(edge.toNodeId);
        if (!target) {
          continue;
        }
        addNode(target);
        if (target.kind !== 'function') {
          continue; // rpc-declaration/unresolved/external-entry 死端
        }
        if (frame.path.includes(target.id)) {
          // 递归环:标边不续展(节点本体已入图,首次访问即展开)
          addEdge(markRecursion(edge, `递归环:展开路径回到 ${target.label}`));
          recursionEdgeCount += 1;
          continue;
        }
        if (expanded.has(target.id)) {
          continue; // 菱形汇合:边保留,不重复展开
        }
        stack.push({
          nodeId: target.id,
          depth: frame.depth + 1,
          path: [...frame.path, target.id]
        });
      }
    }
  };

  // ── 调用者向上:全登记文件反向索引 DFS ─────────────────────────────
  const expandUpstream = (): void => {
    const reverseIndex = new Map<string, Array<{ edge: FlowGraphEdge; bundle: FileBundle }>>();
    for (const filePath of input.files) {
      const bundle = bundleOf(filePath);
      if (!bundle) {
        continue;
      }
      for (const edge of bundle.result.edges) {
        const bucket = reverseIndex.get(edge.toNodeId);
        if (bucket) {
          bucket.push({ edge, bundle });
        } else {
          reverseIndex.set(edge.toNodeId, [{ edge, bundle }]);
        }
      }
    }
    type Frame = { nodeId: string; depth: number; path: string[] };
    const expanded = new Set<string>();
    const stack: Frame[] = [
      { nodeId: rootNode.id, depth: 0, path: [rootNode.id] }
    ];
    while (stack.length > 0) {
      const frame = stack.pop() as Frame;
      if (expanded.has(frame.nodeId)) {
        continue;
      }
      expanded.add(frame.nodeId);
      expandedNodeCount += 1;
      if (frame.depth >= input.maxDepth) {
        truncated.hit = true;
      }
      const callers = reverseIndex.get(frame.nodeId) ?? [];
      for (const { edge, bundle } of callers) {
        // 上游视图:direction.kind 重标为 upstream-caller(调用方向不变)
        const viewEdge = flowGraphEdge({
          fromNodeId: edge.fromNodeId,
          toNodeId: edge.toNodeId,
          callSite: edge.callSite,
          direction: {
            fromRole: edge.direction.fromRole,
            toRole: edge.direction.toRole,
            kind: 'upstream-caller'
          },
          syncAsync: edge.syncAsync,
          condition: edge.condition,
          messageKind: edge.messageKind,
          evidence: edge.evidence,
          unresolvedReason: edge.unresolvedReason
        });
        const caller = bundle.nodesById.get(edge.fromNodeId);
        if (!caller) {
          continue;
        }
        addNode(caller);
        if (caller.kind === 'function' && frame.path.includes(caller.id)) {
          addEdge(markRecursion(viewEdge, `递归环:调用者链回到 ${caller.label}`));
          recursionEdgeCount += 1;
          continue;
        }
        addEdge(viewEdge);
        if (caller.kind !== 'function') {
          continue; // external-entry/unresolved caller 死端
        }
        if (expanded.has(caller.id) || frame.depth >= input.maxDepth) {
          continue;
        }
        stack.push({
          nodeId: caller.id,
          depth: frame.depth + 1,
          path: [...frame.path, caller.id]
        });
      }
    }
  };

  if (input.direction === 'downstream') {
    expandDownstream();
  } else {
    expandUpstream();
  }

  const graph: FlowGraph = {
    query: {
      kind: input.direction,
      rootNodeId: rootNode.id,
      truncatedAtDepth: truncated.hit ? input.maxDepth : null
    },
    nodes: [...graphNodes.values()],
    edges: [...graphEdges.values()]
  };
  return { graph, expandedNodeCount, recursionEdgeCount };
}
