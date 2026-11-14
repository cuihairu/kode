/**
 * KFLOW 评审样图(FLOW-014,G2 泳道视图的评审样本生成核)。
 *
 * 验收:以真实调用夹具画泳道、消息和本地函数帧,标出分支/异步/未知;
 * 样图中每条边可追溯证据。
 *
 * 口径(docs/design/kflow-three-graph-contract.md §2):
 *   - R1 词汇:本图全篇「候选帧/调用帧」,不出现「栈帧/调用栈/堆栈」;
 *   - R3 展示:来源标签恒挂「静态可能路径(G2)」;步序是走查轨迹,不是
 *     执行顺序、不是时间轴;分支一律标候选;
 *   - 每条边带证据(EV 编号可追溯到证据表:证据类型/明细/调用点,
 *     调用点行号按人读 1 基展示,解析器内部 0 基);
 *   - 跨进程消息两段呈现(发送→远端执行帧,FLOW-007);广播只记发送
 *     步(受众是 AOI 动态集合,不虚构执行帧,FLOW-008);未连接发送
 *     (def/实现缺口)只记发送步;未知边标原因码(FLOW-011);
 *   - 泳道按角色分列(client/base/cell/桥接进程),角色来自解析图,
 *     静态角色不冒充运行实例(FLOW-015 落交互;本核只产出评审样本);
 *   - 本核是纯生成器(零 vscode 依赖),面板(FLOW-015+)消费同一模型。
 */

import type { FlowCallResolverResult } from './flowCallResolver';
import { resolveFlowCallSites } from './flowCallResolver';
import { buildScenarioPath } from './flowScenarioPath';
import { buildRpcLinks, type FlowRpcLinkInput } from './flowRpcLinks';
import type { FlowGraphEdge, FlowGraphNode, FlowProcessRole } from './flowGraphModel';

export interface FlowReviewSampleInput {
  rootKey: string;
  entry: { filePath: string; functionName: string };
  files: ReadonlyMap<string, string>;
  resolveDefMethod: FlowRpcLinkInput['resolveDefMethod'];
  resolveImplementation: FlowRpcLinkInput['resolveImplementation'];
  maxDepth?: number;
}

export interface FlowReviewFrame {
  nodeId: string;
  /** 候选帧/调用帧标签(R1 词汇;解析图原样) */
  label: string;
  role: FlowProcessRole;
  kind: 'local-frame' | 'remote-exec';
  file: string | null;
}

export type FlowReviewLinkKind =
  | 'local-call'
  | 'send'
  | 'broadcast-send'
  | 'remote-exec'
  | 'unresolved';

export interface FlowReviewLink {
  /** 样图内稳定编号 L-01..(走查序优先,帧内补充随后) */
  id: string;
  edgeId: string;
  kind: FlowReviewLinkKind;
  syncAsync: string;
  fromLabel: string;
  toLabel: string;
  evidenceId: string;
  evidenceType: string;
  evidenceDetail: string;
  /** 人读 1 基(file:line);null=无调用点锚 */
  callSite: string | null;
  /** 分支候选(不是固定执行顺序) */
  branchCandidate: { text: string; note: string } | null;
  unresolvedCode: string | null;
  unresolvedDetail: string | null;
  /** remote-exec 对应的发送边 id(两段呈现) */
  pairedSendEdgeId: string | null;
  /** 发送步是否有远端执行帧(false=def/实现缺口或广播,如实) */
  connectedToExec: boolean;
}

export interface FlowReviewSwimlane {
  role: FlowProcessRole;
  frames: FlowReviewFrame[];
}

export interface FlowReviewFrameLocals {
  frameId: string;
  frameLabel: string;
  role: FlowProcessRole;
  links: FlowReviewLink[];
}

export interface FlowReviewEvidence {
  id: string;
  edgeId: string;
  evidenceType: string;
  evidenceDetail: string;
  callSite: string | null;
}

/** 走查序列条目:泳道表行按此序交错(帧行/链接行) */
export type FlowReviewRow =
  | { type: 'frame'; frame: FlowReviewFrame }
  | { type: 'link'; link: FlowReviewLink };

export interface FlowReviewSample {
  /** 来源标签(R3:恒挂静态可能路径) */
  sourceLabel: string;
  walkNote: string;
  branchNote: string;
  unresolvedNote: string;
  /** 泳道按角色分列;角色按首次出现序 */
  swimlanes: FlowReviewSwimlane[];
  /** 跨进程走查链接(发送/远端执行/广播发送/未连接发送) */
  walkLinks: FlowReviewLink[];
  /** 帧内补充:本地调用与未解析链接(每帧分组) */
  frameLocals: FlowReviewFrameLocals[];
  /** 走查序列(泳道表行序) */
  rows: FlowReviewRow[];
  /** 证据索引:EV 编号 → 类型/明细/调用点(每边可追溯) */
  evidenceIndex: FlowReviewEvidence[];
  truncated: boolean;
  html: string;
}

const WALK_NOTE =
  '本图步序是走查轨迹:按入口展开的可能路径遍历,不是执行顺序、不是时间轴。实际执行记录见 G3(TRACE),不得由本图推导。';
const BRANCH_NOTE = '分支一律为候选路径,不是固定执行顺序;else 分支语义未展开如实标注。';
const UNRESOLVED_NOTE =
  '未知边(动态分发/未知 receiver/第三方/native)标原因码保留,不静默消失、不猜唯一落点。';

const esc = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** 解析器内部 0 基 → 人读 1 基展示 */
const callSiteLabel = (edge: FlowGraphEdge): string | null => {
  if (!edge.callSite) {
    return null;
  }
  return `${edge.callSite.file}:${edge.callSite.line + 1}`;
};

const LINK_KIND_BADGE: Record<FlowReviewLinkKind, string> = {
  'local-call': '本地调用(sync)',
  send: '跨进程发送(async-send)',
  'broadcast-send': '广播发送(async-send;受众=AOI 动态集合,无单一执行帧)',
  'remote-exec': '远端执行帧(声明契约段)',
  unresolved: '未解析(原因码见明细)'
};

export function buildFlowReviewSample(input: FlowReviewSampleInput): FlowReviewSample {
  const graphs = new Map<string, FlowCallResolverResult | null>();
  const graphFor = (filePath: string): FlowCallResolverResult | null => {
    if (!graphs.has(filePath)) {
      const text = input.files.get(filePath);
      graphs.set(
        filePath,
        text === undefined ? null : resolveFlowCallSites({ text, filePath, rootKey: input.rootKey })
      );
    }
    return graphs.get(filePath) ?? null;
  };
  const nodesById = new Map<string, FlowGraphNode>();
  for (const filePath of input.files.keys()) {
    const graph = graphFor(filePath);
    if (!graph) {
      continue;
    }
    for (const node of graph.nodes) {
      nodesById.set(node.id, node);
    }
  }

  // rpc 链接合成的实现节点(不在解析图)也入索引:remote-exec 帧才能带出文件路径
  const rpc = buildRpcLinks({
    rootKey: input.rootKey,
    files: [...input.files.keys()],
    resolveFile: graphFor,
    resolveDefMethod: input.resolveDefMethod,
    resolveImplementation: input.resolveImplementation
  });
  for (const link of rpc.links) {
    if (!nodesById.has(link.implNode.id)) {
      nodesById.set(link.implNode.id, link.implNode);
    }
  }

  const scenario = buildScenarioPath({
    rootKey: input.rootKey,
    entry: input.entry,
    files: [...input.files.keys()],
    resolveFile: graphFor,
    resolveDefMethod: input.resolveDefMethod,
    resolveImplementation: input.resolveImplementation,
    maxDepth: input.maxDepth
  });

  // 帧来自走查步(local-frame/remote-exec);跨进程发送步不是帧
  const frames: FlowReviewFrame[] = [];
  for (const step of scenario.steps) {
    if (step.kind === 'cross-process-send') {
      continue;
    }
    const node = nodesById.get(step.nodeId);
    frames.push({
      nodeId: step.nodeId,
      label: step.label,
      role: step.role,
      kind: step.kind,
      file: node?.fn?.filePath ?? null
    });
  }

  // 泳道按角色分列,角色按首次出现序
  const swimlaneOrder: FlowProcessRole[] = [];
  for (const frame of frames) {
    if (!swimlaneOrder.includes(frame.role)) {
      swimlaneOrder.push(frame.role);
    }
  }
  const swimlanes: FlowReviewSwimlane[] = swimlaneOrder.map(role => ({
    role,
    frames: frames.filter(frame => frame.role === role)
  }));

  // 证据索引:按边首次出现分配 EV 编号(每边可追溯)
  const evidenceById = new Map<string, FlowReviewEvidence>();
  const evidenceFor = (edge: FlowGraphEdge): FlowReviewEvidence => {
    const existing = evidenceById.get(edge.id);
    if (existing) {
      return existing;
    }
    const entry: FlowReviewEvidence = {
      id: `EV-${String(evidenceById.size + 1).padStart(2, '0')}`,
      edgeId: edge.id,
      evidenceType: edge.evidence.type,
      evidenceDetail: edge.evidence.detail,
      callSite: callSiteLabel(edge)
    };
    evidenceById.set(edge.id, entry);
    return entry;
  };

  const makeLink = (
    kind: FlowReviewLinkKind,
    edge: FlowGraphEdge,
    fromLabel: string,
    toLabel: string,
    extras: Partial<FlowReviewLink> = {}
  ): FlowReviewLink => {
    const evidence = evidenceFor(edge);
    return {
      id: '',
      edgeId: edge.id,
      kind,
      syncAsync: edge.syncAsync,
      fromLabel,
      toLabel,
      evidenceId: evidence.id,
      evidenceType: evidence.evidenceType,
      evidenceDetail: evidence.evidenceDetail,
      callSite: evidence.callSite,
      branchCandidate: edge.condition
        ? { text: edge.condition.text, note: '分支为候选路径,不是固定执行顺序' }
        : null,
      unresolvedCode: edge.unresolvedReason?.code ?? null,
      unresolvedDetail: edge.unresolvedReason?.detail ?? null,
      pairedSendEdgeId: null,
      connectedToExec: true,
      ...extras
    };
  };

  // 走查链接与走查序列:同一次步序重放产生(帧行/链接行交错,两段锁步)
  const rows: FlowReviewRow[] = [];
  const frameByNode = new Map(frames.map(frame => [frame.nodeId, frame]));
  let lastFrameLabel = scenario.steps[0]?.label ?? '';
  let linkSeq = 0;
  const nextLinkId = (): string => `L-${String(++linkSeq).padStart(2, '0')}`;
  const sendLinkByEdge = new Map<string, FlowReviewLink>();

  for (const step of scenario.steps) {
    if (step.kind === 'cross-process-send') {
      const edge = step.edge;
      if (!edge) {
        continue;
      }
      // 发起帧取边 fromNodeId 的真实标签(DFS 回溯后 lastFrameLabel 会指错帧)
      const fromLabel = nodesById.get(edge.fromNodeId)?.label ?? lastFrameLabel;
      const link = makeLink(
        edge.messageKind === 'broadcast' ? 'broadcast-send' : 'send',
        edge,
        fromLabel,
        step.label
      );
      link.id = nextLinkId();
      sendLinkByEdge.set(link.edgeId, link);
      rows.push({ type: 'link', link });
      continue;
    }
    const frame = frameByNode.get(step.nodeId);
    if (frame) {
      lastFrameLabel = frame.label;
      rows.push({ type: 'frame', frame });
    }
    if (step.kind === 'remote-exec' && step.viaSendEdgeId && step.edge) {
      const link = makeLink('remote-exec', step.edge, step.label, step.label, {
        pairedSendEdgeId: step.viaSendEdgeId
      });
      link.id = nextLinkId();
      rows.push({ type: 'link', link });
    }
  }

  // 发送步与远端执行段配对核:发送无执行段=未连接(def/实现缺口或广播),如实
  const pairedSends = new Set(
    rows
      .filter((row): row is { type: 'link'; link: FlowReviewLink } =>
        row.type === 'link' && row.link.kind === 'remote-exec')
      .map(row => row.link.pairedSendEdgeId)
  );
  for (const link of sendLinkByEdge.values()) {
    link.connectedToExec = pairedSends.has(link.edgeId);
  }

  // 帧内补充:本地调用与未解析链接(每帧分组;跨进程发送已入走查序,不重复)
  const frameLocals: FlowReviewFrameLocals[] = [];
  for (const frame of frames) {
    const node = nodesById.get(frame.nodeId);
    const graph = node?.fn?.filePath ? graphFor(node.fn.filePath) : null;
    if (!graph) {
      continue;
    }
    const links: FlowReviewLink[] = [];
    for (const edge of graph.edges) {
      if (edge.fromNodeId !== frame.nodeId) {
        continue;
      }
      if (edge.unresolvedReason) {
        const link = makeLink('unresolved', edge, frame.label, edge.evidence.detail);
        link.id = nextLinkId();
        links.push(link);
        continue;
      }
      if (edge.messageKind === 'local-call') {
        const target = nodesById.get(edge.toNodeId);
        const link = makeLink('local-call', edge, frame.label, target?.label ?? edge.toNodeId);
        link.id = nextLinkId();
        links.push(link);
      }
    }
    if (links.length > 0) {
      frameLocals.push({ frameId: frame.nodeId, frameLabel: frame.label, role: frame.role, links });
    }
  }

  const walkLinks = rows
    .filter((row): row is { type: 'link'; link: FlowReviewLink } => row.type === 'link')
    .map(row => row.link);
  const evidenceIndex = [...evidenceById.values()];
  const sourceLabel = '静态可能路径(G2)';
  const truncated = scenario.truncated;

  const html = renderHtml({
    sourceLabel,
    walkNote: WALK_NOTE,
    branchNote: BRANCH_NOTE,
    unresolvedNote: UNRESOLVED_NOTE,
    swimlanes,
    rows,
    frameLocals,
    evidenceIndex,
    truncated,
    entryLabel: scenario.steps[0]?.label ?? ''
  });

  return {
    sourceLabel,
    walkNote: WALK_NOTE,
    branchNote: BRANCH_NOTE,
    unresolvedNote: UNRESOLVED_NOTE,
    swimlanes,
    walkLinks,
    frameLocals,
    rows,
    evidenceIndex,
    truncated,
    html
  };
}

interface HtmlInput {
  sourceLabel: string;
  walkNote: string;
  branchNote: string;
  unresolvedNote: string;
  swimlanes: FlowReviewSwimlane[];
  rows: FlowReviewRow[];
  frameLocals: FlowReviewFrameLocals[];
  evidenceIndex: FlowReviewEvidence[];
  truncated: boolean;
  entryLabel: string;
}

const emitFrameRow = (frame: FlowReviewFrame, roleColumns: FlowProcessRole[]): string => {
  const tds = roleColumns.map(role => {
    if (role !== frame.role) {
      return '<td class="empty"></td>';
    }
    return `<td><div class="frame ${frame.kind === 'remote-exec' ? 'remote' : ''}" data-node="${esc(frame.nodeId)}"><span class="frame-kind">${frame.kind === 'remote-exec' ? '远端执行帧' : '候选帧'}</span> ${esc(frame.label.replace(/^候选帧 /, ''))}<span class="file">${esc(frame.file ?? '文件未解析')}</span></div></td>`;
  });
  return `<tr class="frame-row">${tds.join('')}</tr>`;
};

const emitLinkRow = (link: FlowReviewLink, roleColumns: FlowProcessRole[]): string => {
  const branch = link.branchCandidate
    ? `<span class="branch">分支候选:${esc(link.branchCandidate.text)}(${esc(link.branchCandidate.note)})</span>`
    : '';
  const unresolved = link.unresolvedCode
    ? `<span class="unresolved">原因码 ${esc(link.unresolvedCode)}:${esc(link.unresolvedDetail ?? '')}</span>`
    : '';
  const pairing =
    link.kind === 'remote-exec' && link.pairedSendEdgeId
      ? `<span class="pairing">两段:与发送边 ${esc(link.pairedSendEdgeId)} 配对</span>`
      : '';
  const disconnected =
    link.kind === 'send' && !link.connectedToExec
      ? '<span class="pairing">未连接:无远端执行帧(def/实现缺口),只记发送步</span>'
      : '';
  return `<tr class="link-row"><td colspan="${roleColumns.length}"><span class="badge ${link.kind}">${esc(LINK_KIND_BADGE[link.kind])}</span> <span class="arrow">${esc(link.fromLabel)} → ${esc(link.toLabel)}</span> <span class="ev">[${esc(link.evidenceId)}]</span>${branch}${unresolved}${pairing}${disconnected}<span class="callsite">${esc(link.callSite ?? '无调用点锚')}</span></td></tr>`;
};

const renderHtml = (input: HtmlInput): string => {
  const roleColumns = input.swimlanes.map(lane => lane.role);
  const tableRows = input.rows.map(row =>
    row.type === 'frame'
      ? emitFrameRow(row.frame, roleColumns)
      : emitLinkRow(row.link, roleColumns)
  );

  const localsHtml = input.frameLocals
    .map(
      group =>
        `<div class="locals-group"><h3>帧内 · ${esc(group.frameLabel)} <span class="role-tag">${esc(group.role)}</span></h3><ul>${group.links
          .map(link => {
            const branch = link.branchCandidate
              ? `<span class="branch">分支候选:${esc(link.branchCandidate.text)}</span>`
              : '';
            const unresolved = link.unresolvedCode
              ? `<span class="unresolved">原因码 ${esc(link.unresolvedCode)}:${esc(link.unresolvedDetail ?? '')}</span>`
              : '';
            return `<li><span class="badge ${link.kind}">${esc(LINK_KIND_BADGE[link.kind])}</span> ${esc(link.fromLabel)} → ${esc(link.toLabel)} <span class="ev">[${esc(link.evidenceId)}]</span>${branch}${unresolved}<span class="callsite">${esc(link.callSite ?? '无调用点锚')}</span></li>`;
          })
          .join('')}</ul></div>`
    )
    .join('');

  const evidenceHtml = input.evidenceIndex
    .map(
      evidence =>
        `<tr><td>${esc(evidence.id)}</td><td>${esc(evidence.edgeId)}</td><td>${esc(evidence.evidenceType)}</td><td>${esc(evidence.evidenceDetail)}</td><td>${esc(evidence.callSite ?? '无调用点锚')}</td></tr>`
    )
    .join('');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>KFLOW 评审样图 · 静态调用路径(G2)</title>
<style>
body { font-family: 'Segoe UI', 'Microsoft YaHei', sans-serif; margin: 24px; color: #1e1e1e; background: #fafafa; }
.source-label { display: inline-block; background: #2d5ba9; color: #fff; padding: 4px 12px; border-radius: 4px; font-weight: 600; }
.walk-note { margin: 12px 0; padding: 10px 14px; background: #fff6e5; border-left: 4px solid #d99a1b; }
.note { margin: 8px 0; color: #555; }
h1 { font-size: 20px; } h2 { font-size: 16px; margin-top: 28px; } h3 { font-size: 14px; }
table.swimlanes { border-collapse: collapse; width: 100%; table-layout: fixed; background: #fff; }
table.swimlanes th { background: #eef2f8; border: 1px solid #ccd6e4; padding: 8px; }
table.swimlanes td { border: 1px solid #dde4ee; padding: 6px 10px; vertical-align: top; }
td.empty { background: #f6f7f9; }
.frame { background: #eef4ff; border: 2px solid #2d5ba9; border-radius: 6px; padding: 8px; }
.frame.remote { background: #f3eefe; border-color: #6a3ab2; }
.frame-kind { font-size: 11px; color: #2d5ba9; font-weight: 700; display: block; }
.frame .file { display: block; font-size: 11px; color: #667; margin-top: 4px; }
tr.link-row td { background: #fffdf5; font-size: 13px; }
.badge { display: inline-block; font-size: 11px; padding: 2px 8px; border-radius: 10px; font-weight: 600; }
.badge.send { background: #d9ecff; color: #14538a; }
.badge.broadcast-send { background: #e2e8ff; color: #3346c4; }
.badge.remote-exec { background: #ecdfff; color: #4d2b8f; }
.badge.local-call { background: #e2f6e6; color: #1c6b33; }
.badge.unresolved { background: #ffe4e4; color: #992222; }
.arrow { font-weight: 600; }
.ev { color: #7a5b00; font-family: monospace; font-size: 12px; }
.callsite { color: #556; font-family: monospace; font-size: 12px; margin-left: 8px; }
.branch { color: #8a6d00; margin-left: 8px; font-size: 12px; }
.unresolved { color: #992222; margin-left: 8px; font-size: 12px; }
.pairing { color: #3346c4; margin-left: 8px; font-size: 12px; }
.role-tag { color: #889; font-size: 11px; }
.locals-group ul { margin: 4px 0 12px 20px; padding: 0; }
.locals-group li { margin: 4px 0; font-size: 13px; }
table.evidence { border-collapse: collapse; width: 100%; background: #fff; font-size: 12px; }
table.evidence th, table.evidence td { border: 1px solid #ccd6e4; padding: 6px 8px; text-align: left; }
table.evidence th { background: #eef2f8; }
.truncated { color: #992222; font-weight: 600; }
footer { margin-top: 28px; color: #667; font-size: 12px; }
</style>
</head>
<body>
<h1>KFLOW 评审样图 · 静态调用路径(G2)</h1>
<p><span class="source-label">来源:${esc(input.sourceLabel)}</span>${input.truncated ? ' <span class="truncated">走查深度截断:truncated 如实,不假装完整</span>' : ''}</p>
<div class="walk-note">${esc(input.walkNote)}</div>
<div class="note">${esc(input.branchNote)}</div>
<div class="note">${esc(input.unresolvedNote)}</div>
<h2>泳道(按角色分列)· 走查轨迹</h2>
<table class="swimlanes">
<thead><tr>${roleColumns.map(role => `<th>泳道:${esc(role)}(静态角色,非运行实例)</th>`).join('')}</tr></thead>
<tbody>
${tableRows.join('\n')}
</tbody>
</table>
<h2>帧内 · 本地调用与未解析</h2>
${localsHtml || '<p class="note">(无帧内本地调用/未解析链接)</p>'}
<h2>证据索引(每边可追溯)</h2>
<table class="evidence">
<thead><tr><th>EV</th><th>边 id</th><th>证据类型</th><th>明细</th><th>调用点(人读 1 基)</th></tr></thead>
<tbody>
${evidenceHtml}
</tbody>
</table>
<footer>生成自 src/backend/flowReviewSample.ts(FLOW-014);数据面:FLOW-004 解析图 / FLOW-007 两段链接 / FLOW-008 广播 / FLOW-011 未解析保留 / FLOW-012 场景走查。入口:${esc(input.entryLabel)}。未知边与候选分支如实标注;静态角色不冒充运行实例。</footer>
</body>
</html>
`;
};
