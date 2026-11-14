/**
 * KFLOW 节点反查(FLOW-018,G2 选中节点的上游/下游工作区级反查纯核)。
 *
 * 验收:选择节点反查上游/下游,保留导航历史(面板职责);未知和歧义
 * 结果可查看。
 *
 * 口径:
 *   - 上游=全工作区扫描:逐文件解析调用边,两类匹配——①本地/导入调用:
 *     toNodeId 的 fn 段恰等于 `目标文件#函数名`(节点身份精确匹配,不猜);
 *     ②跨进程发送:toNodeId 是 rpc-declaration(解析层 fn 带 pending-def
 *     标记,无实体段)且其角色段=目标文件面推导角色、fn 名恰等——同名
 *     方法可能属他实体,如实标注「实体待证」候选(歧义可查看,不裁定);
 *   - 下游=目标函数自身文件的解析边:已解析边入下游面;带未解析原因码的
 *     边单列未解析面(code+detail+调用点,未知可查看);
 *   - 「打开图」链接只给可渲染目标:目标函数在其所属文件解析面有函数
 *     节点(场景入口可找到);pending-def 声明节点无真实文件,不给链接
 *     (实现落点归 def 契约接线,不在此反查);
 *   - 行号:callSite.line 0 基(解析层口径),展示 +1,跳转 0 基原样;
 *   - 零 vscode 依赖;词汇红线 R1(候选帧/上游/下游,无栈词汇)。
 */

import { resolveFlowCallSites } from './flowCallResolver';
import type { FlowGraphEdge, FlowGraphNode } from './flowGraphModel';

export interface FlowNodeInspectInput {
  rootKey: string;
  target: { filePath: string; functionName: string };
  /** 工作区脚本文本(宿主有界收集;目标文件必须在内) */
  files: ReadonlyMap<string, string>;
  /** 文件静态归属实体;null=无实体 */
  entityForFile: (filePath: string) => string | null;
  /** 面板有上一视图(导航历史非空)时显示返回链接 */
  canGoBack: boolean;
}

/** 反查条目(上游调用者/下游被调者共形) */
export interface FlowInspectItem {
  /** 调用者/被调者文件(pending-def 声明节点为 null) */
  file: string | null;
  functionName: string | null;
  label: string;
  /** 调用点(0 基;声明契约段/未解析无调用点=null) */
  callSiteLine0: number | null;
  /** local=本地/导入调用;cross-process=跨进程发送候选(实体待证) */
  match: 'local' | 'cross-process';
  /** 打开图链接(目标函数可渲染为场景入口) */
  openable: boolean;
  note: string | null;
}

export interface FlowNodeInspectResult {
  target: { filePath: string; functionName: string; entity: string | null };
  upstream: FlowInspectItem[];
  downstream: FlowInspectItem[];
  /** 未解析面:原因码+细节+调用点(未知可查看) */
  unresolved: Array<{ code: string; detail: string; callSiteLine0: number | null }>;
  html: string;
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** 文件面推导角色(解析层同源:scripts/<face>/ 目录;无匹配=null) */
const faceRoleOf = (filePath: string): string | null => {
  const match = filePath.match(/[/\\]scripts[/\\](base|cell|client)[/\\]/);
  return match ? match[1] : null;
};

const callSiteOf = (edge: { callSite: { line: number } | null }): number | null =>
  edge.callSite ? edge.callSite.line : null;

export function buildFlowNodeInspect(input: FlowNodeInspectInput): FlowNodeInspectResult {
  const { rootKey, target, files, entityForFile } = input;
  const text = files.get(target.filePath);
  if (text === undefined) {
    throw new Error(`target file not readable: ${target.filePath}`);
  }
  const own = resolveFlowCallSites({ text, filePath: target.filePath, rootKey });
  const fnNode = own.nodes.find(
    node => node.kind === 'function' && node.fn?.filePath === target.filePath && node.fn.name === target.functionName
  );
  if (!fnNode) {
    throw new Error(`target function not found in file parse: ${target.functionName}`);
  }
  const entity = entityForFile(target.filePath);
  const targetRole = faceRoleOf(target.filePath);

  // 目标文件解析面的函数节点名集合(打开图链接的可渲染判据)
  const renderableByFile = new Map<string, Set<string>>();
  const noteRenderable = (filePath: string, nodes: FlowGraphNode[]): void => {
    const names = renderableByFile.get(filePath) ?? new Set<string>();
    for (const node of nodes) {
      if (node.kind === 'function' && node.fn) {
        names.add(node.fn.name);
      }
    }
    renderableByFile.set(filePath, names);
  };
  noteRenderable(target.filePath, own.nodes);

  const upstream: FlowInspectItem[] = [];
  const downstream: FlowInspectItem[] = [];
  const unresolved: Array<{ code: string; detail: string; callSiteLine0: number | null }> = [];
  const seenUpstream = new Set<string>();

  /** 上游匹配(两类):本地/导入调用=节点身份精确匹配;跨进程发送=角色+方法名(实体待证) */
  const matchUpstreamEdge = (
    edge: FlowGraphEdge,
    nodesById: ReadonlyMap<string, FlowGraphNode>
  ): FlowInspectItem | null => {
    const parts = edge.toNodeId.split('\u001f');
    const kindPart = parts[2];
    const rolePart = parts[1];
    const fnPart = parts[4] ?? '';
    const caller = nodesById.get(edge.fromNodeId);
    if (!caller?.fn) {
      return null;
    }
    if (kindPart === 'function' && fnPart === `${target.filePath}#${target.functionName}`) {
      return {
        file: caller.fn.filePath,
        functionName: caller.fn.name,
        label: caller.label,
        callSiteLine0: callSiteOf(edge),
        match: 'local',
        openable: renderableByFile.get(caller.fn.filePath)?.has(caller.fn.name) ?? false,
        note: null
      };
    }
    if (
      kindPart === 'rpc-declaration' &&
      targetRole !== null &&
      rolePart === targetRole &&
      fnPart.endsWith(`#${target.functionName}`)
    ) {
      return {
        file: caller.fn.filePath,
        functionName: caller.fn.name,
        label: caller.label,
        callSiteLine0: callSiteOf(edge),
        match: 'cross-process',
        openable: renderableByFile.get(caller.fn.filePath)?.has(caller.fn.name) ?? false,
        note: '跨进程发送候选(声明节点无实体归属,同名方法不判别实体)'
      };
    }
    return null;
  };
  const pushUpstream = (item: FlowInspectItem): void => {
    const dedupeKey = `${item.file}\u001f${item.functionName}\u001f${item.callSiteLine0}\u001f${item.match}`;
    if (!seenUpstream.has(dedupeKey)) {
      seenUpstream.add(dedupeKey);
      upstream.push(item);
    }
  };

  for (const [filePath, fileText] of files) {
    let result;
    try {
      result = resolveFlowCallSites({ text: fileText, filePath, rootKey });
    } catch {
      continue; // 单文件解析失败不拖垮反查(该文件面缺失如实)
    }
    noteRenderable(filePath, result.nodes);
    const nodesById = new Map(result.nodes.map(node => [node.id, node]));

    // 自身文件:上游面(入边,同文件调用者)+下游面(出边)
    if (filePath === target.filePath) {
      for (const edge of result.edges) {
        if (edge.fromNodeId === fnNode.id) {
          continue; // 下游面单独处理(见下)
        }
        const item = matchUpstreamEdge(edge, nodesById);
        if (item) {
          pushUpstream(item);
        }
      }
      for (const edge of result.edges) {
        if (edge.fromNodeId !== fnNode.id) {
          continue;
        }
        if (edge.unresolvedReason) {
          unresolved.push({
            code: edge.unresolvedReason.code,
            detail: edge.unresolvedReason.detail,
            callSiteLine0: callSiteOf(edge)
          });
          continue;
        }
        const toNode = nodesById.get(edge.toNodeId);
        const isDeclaration = toNode?.kind === 'rpc-declaration';
        const targetFn = toNode?.fn ?? null;
        const isRenderable =
          targetFn !== null && !targetFn.filePath.startsWith('pending-def:')
            ? renderableByFile.get(targetFn.filePath)?.has(targetFn.name) ?? false
            : false;
        downstream.push({
          file: targetFn && !targetFn.filePath.startsWith('pending-def:') ? targetFn.filePath : null,
          functionName: targetFn?.name ?? null,
          label: toNode?.label ?? edge.toNodeId,
          callSiteLine0: callSiteOf(edge),
          match: isDeclaration ? 'cross-process' : 'local',
          openable: isRenderable,
          note: isDeclaration ? '实现落点经 def 契约接线(不在此反查)' : null
        });
      }
      continue;
    }

    // 上游面:其他文件的调用边反查
    for (const edge of result.edges) {
      const item = matchUpstreamEdge(edge, nodesById);
      if (item) {
        pushUpstream(item);
      }
    }
  }

  return {
    target: { filePath: target.filePath, functionName: target.functionName, entity },
    upstream,
    downstream,
    unresolved,
    html: renderInspectHtml({
      target: { filePath: target.filePath, functionName: target.functionName, entity },
      upstream,
      downstream,
      unresolved,
      canGoBack: input.canGoBack
    })
  };
}

/** 反查视图 HTML(自包含零脚本;jump/open/back 面板内经 nonce 桥激活) */
const renderInspectHtml = (face: {
  target: { filePath: string; functionName: string; entity: string | null };
  upstream: FlowInspectItem[];
  downstream: FlowInspectItem[];
  unresolved: Array<{ code: string; detail: string; callSiteLine0: number | null }>;
  canGoBack: boolean;
}): string => {
  const itemRow = (item: FlowInspectItem): string => {
    const callsite =
      item.callSiteLine0 !== null && item.file
        ? `<span class="callsite" data-flow-jump="${esc(item.file)}:${item.callSiteLine0}">调用点 ${esc(item.file)}:${item.callSiteLine0 + 1}</span>`
        : '';
    const open =
      item.openable && item.file && item.functionName
        ? `<span class="open-graph" data-flow-open-file="${esc(item.file)}" data-flow-open-fn="${esc(item.functionName)}">打开图</span>`
        : '';
    const note = item.note ? `<span class="note">${esc(item.note)}</span>` : '';
    return `<li><span class="who">${esc(item.label)}</span>${callsite}${open}${note}</li>`;
  };
  const back = face.canGoBack
    ? '<div class="nav"><span class="flow-back" data-flow-back="1">← 返回上一视图</span></div>'
    : '';
  return [
    '<!DOCTYPE html><html><head><meta charset="utf-8"><style>',
    'body { font-family: sans-serif; margin: 12px; color: #1e1e1e; }',
    'h1 { font-size: 15px; } h2 { font-size: 13px; margin: 14px 0 6px; }',
    'ul { list-style: none; padding-left: 0; } li { margin: 4px 0; }',
    '.callsite, .open-graph { color: #14538a; font-family: monospace; font-size: 12px; margin-left: 10px; }',
    '.note { color: #8a4d00; font-size: 12px; margin-left: 10px; }',
    '.flow-back { color: #14538a; cursor: pointer; }',
    '.empty { color: #666; font-size: 12px; }',
    '.un-code { font-family: monospace; color: #8a1f1f; margin-right: 6px; }',
    '.un-detail { color: #444; font-size: 12px; margin-left: 6px; }',
    '.target { color: #555; font-size: 12px; }',
    '</style></head><body>',
    `<h1>反查:${esc(face.target.functionName)}</h1>`,
    `<div class="target">${esc(face.target.filePath)}${face.target.entity ? `(实体 ${esc(face.target.entity)})` : ''} · 反查=静态可能路径,不是执行顺序</div>`,
    back,
    `<h2>上游 ${face.upstream.length} 条(谁调用它)</h2>`,
    face.upstream.length
      ? `<ul>${face.upstream.map(itemRow).join('')}</ul>`
      : '<div class="empty">无静态可证调用者(如实)</div>',
    `<h2>下游 ${face.downstream.length} 条(它调用谁)</h2>`,
    face.downstream.length
      ? `<ul>${face.downstream.map(itemRow).join('')}</ul>`
      : '<div class="empty">无静态可证被调者(如实)</div>',
    `<h2>未解析 ${face.unresolved.length} 条(未知可查看)</h2>`,
    face.unresolved.length
      ? `<ul>${face.unresolved
          .map(
            entry =>
              `<li><span class="un-code">${esc(entry.code)}</span><span class="un-detail">${esc(entry.detail)}</span>${
                entry.callSiteLine0 !== null && face.target.filePath
                  ? `<span class="callsite" data-flow-jump="${esc(face.target.filePath)}:${entry.callSiteLine0}">调用点 ${esc(face.target.filePath)}:${entry.callSiteLine0 + 1}</span>`
                  : ''
              }</li>`
          )
          .join('')}</ul>`
      : '<div class="empty">无未解析边</div>',
    '</body></html>'
  ].join('\n');
};
