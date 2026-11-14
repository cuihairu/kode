/**
 * KFLOW 业务场景路径(FLOW-012,G2 的端到端场景走查核)。
 *
 * 验收:选定入口查询 Client→Base→Cell→Client 的本地帧和跨进程边;分支为
 * 候选而非固定执行顺序。
 *
 * 口径:
 *   - 场景=从一个入口帧出发的有界走查:本地帧(解析图 local-call)→跨进程
 *     发送边(async-send)→经 FLOW-007 两段连接跳到远端执行帧→递归其本地
 *     子树;广播边只记发送步(受众是 AOI 动态集合,无单一执行帧可连——
 *     FLOW-008 红线);未解析发送不续(原因在 FLOW-007/011 面);
 *   - 步序是「走查轨迹」不是执行顺序:边上的分支条件一律落 branchCandidates
 *     (候选,非固定执行顺序;else 分支语义未展开如实标注);
 *   - 有界深度+visited 防环;超界 truncated 如实;
 *   - 复用既有面:FLOW-004 解析图 / FLOW-007 rpc 两段链接 / FLOW-003 协议
 *     condition 字段——本核只做装配,不新造证据。
 */

import type { FlowCallResolverResult } from './flowCallResolver';
import { buildRpcLinks, type FlowRpcLinkInput } from './flowRpcLinks';
import type { FlowGraphEdge, FlowGraphNode, FlowProcessRole } from './flowGraphModel';

export interface FlowScenarioEntryPoint {
  filePath: string;
  functionName: string;
}

export interface FlowScenarioInput {
  rootKey: string;
  entry: FlowScenarioEntryPoint;
  files: string[];
  resolveFile: (filePath: string) => FlowCallResolverResult | null;
  resolveDefMethod: FlowRpcLinkInput['resolveDefMethod'];
  resolveImplementation: FlowRpcLinkInput['resolveImplementation'];
  /** 走查深度界(默认 8;超界 truncated 如实) */
  maxDepth?: number;
}

export type FlowScenarioStepKind =
  | 'local-frame'
  | 'cross-process-send'
  | 'remote-exec';

export interface FlowScenarioStep {
  index: number;
  kind: FlowScenarioStepKind;
  role: FlowProcessRole;
  nodeId: string;
  label: string;
  /** 走查深度(入口帧 0;深度界判定=本步 depth >= maxDepth 停) */
  depth: number;
  /** 引到本步的边(入口帧无) */
  edge: FlowGraphEdge | null;
  /** 远端执行步对应的发送边 id(remote-exec 有) */
  viaSendEdgeId: string | null;
}

export interface FlowScenarioBranchCandidate {
  /** 分支条件原文(if/elif 头;else 分支=否分支语义未展开) */
  text: string;
  kind: 'if-branch' | 'type-discriminant' | 'caller-asserted' | 'other';
  /** 条件所在步的边 id */
  edgeId: string;
  /** 候选语义标注(不是固定执行顺序) */
  note: string;
}

export interface FlowScenarioResult {
  entryNodeId: string;
  entryRole: FlowProcessRole;
  steps: FlowScenarioStep[];
  branchCandidates: FlowScenarioBranchCandidate[];
  truncated: boolean;
  /** 本次走查的深度界(截断边界判据:step.depth >= maxDepth) */
  maxDepth: number;
}

export function buildScenarioPath(input: FlowScenarioInput): FlowScenarioResult {
  const maxDepth = input.maxDepth ?? 8;
  const fileGraphs = new Map<string, FlowCallResolverResult | null>();
  const graphFor = (filePath: string): FlowCallResolverResult | null => {
    if (!fileGraphs.has(filePath)) {
      fileGraphs.set(filePath, input.resolveFile(filePath));
    }
    return fileGraphs.get(filePath) ?? null;
  };

  const rpc = buildRpcLinks({
    rootKey: input.rootKey,
    files: input.files,
    resolveFile: input.resolveFile,
    resolveDefMethod: input.resolveDefMethod,
    resolveImplementation: input.resolveImplementation
  });
  const linkBySendEdge = new Map(rpc.links.map(link => [link.sendEdge.id, link]));

  const entryGraph = graphFor(input.entry.filePath);
  if (!entryGraph) {
    throw new Error(`scenario entry file not resolvable: ${input.entry.filePath}`);
  }
  const entryNode = entryGraph.nodes.find(
    node =>
      node.kind === 'function' &&
      node.fn?.name === input.entry.functionName &&
      node.fn?.filePath === input.entry.filePath
  );
  if (!entryNode) {
    throw new Error(`scenario entry function not found: ${input.entry.functionName}`);
  }

  const steps: FlowScenarioStep[] = [];
  const branchCandidates: FlowScenarioBranchCandidate[] = [];
  const visited = new Set<string>();
  let truncated = false;

  const recordCandidate = (edge: FlowGraphEdge): void => {
    if (!edge.condition) {
      return;
    }
    branchCandidates.push({
      text: edge.condition.text,
      kind: edge.condition.kind,
      edgeId: edge.id,
      note: '分支为候选路径,不是固定执行顺序'
    });
  };

  const visit = (
    node: FlowGraphNode,
    depth: number,
    via?: { edge: FlowGraphEdge; sendEdgeId: string }
  ): void => {
    if (visited.has(node.id)) {
      return;
    }
    visited.add(node.id);
    steps.push({
      index: steps.length,
      kind: via ? 'remote-exec' : 'local-frame',
      role: node.role,
      nodeId: node.id,
      label: node.label,
      depth,
      edge: via?.edge ?? null,
      viaSendEdgeId: via?.sendEdgeId ?? null
    });
    if (depth >= maxDepth) {
      truncated = true;
      return;
    }
    const graph = graphFor(node.fn?.filePath ?? input.entry.filePath);
    if (!graph) {
      return;
    }
    const nodesById = new Map(graph.nodes.map(candidate => [candidate.id, candidate]));
    for (const edge of graph.edges) {
      if (edge.fromNodeId !== node.id || edge.unresolvedReason !== null) {
        continue;
      }
      recordCandidate(edge);
      const target = nodesById.get(edge.toNodeId);
      if (!target) {
        continue;
      }
      // 本地调用帧(同进程,同步)
      if (edge.messageKind === 'local-call' && target.kind === 'function') {
        visit(target, depth + 1);
        continue;
      }
      // 跨进程发送(async-send)→ FLOW-007 两段跳远端执行帧
      if (
        edge.syncAsync === 'async-send' &&
        (edge.messageKind === 'rpc' || edge.messageKind === 'broadcast')
      ) {
        steps.push({
          index: steps.length,
          kind: 'cross-process-send',
          role: edge.direction.toRole,
          nodeId: target.id,
          label: target.label,
          depth,
          edge,
          viaSendEdgeId: edge.id
        });
        const link = linkBySendEdge.get(edge.id);
        if (link) {
          visit(link.implNode, depth + 1, { edge: link.execEdge, sendEdgeId: edge.id });
        }
        // 广播/未连接发送:只记发送步(受众动态集合或 def/实现缺口,不虚构执行帧)
      }
    }
  };

  visit(entryNode, 0);
  return {
    entryNodeId: entryNode.id,
    entryRole: entryNode.role,
    steps,
    branchCandidates,
    truncated,
    maxDepth
  };
}
