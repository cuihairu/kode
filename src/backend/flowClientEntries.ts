/**
 * KFLOW Client 真实调用入口解析(FLOW-006,G2 入口层;FLOW-001 S6 的修复面)。
 *
 * 验收:有客户端源代码时绑定实际调用点到 Exposed RPC;无客户端源码只显示
 * 外部入口和证据,不能伪造 Client 函数栈。
 *
 * 口径:
 *   - 证据绑定:客户端脚本(client/bots 面)里的角色化发送边(self.base.X /
 *     self.cell.X,FLOW-004 解析产出)是**真实调用点证据**——按
 *     (调用者实体, 段→角色, 方法名) 绑到 Exposed 注册表;调用者帧是真实
 *     client 函数帧(带 fn/声明),绝不合成;
 *   - 无证据 Exposed:只立 external-entry 节点(协议拒绝 fn——不伪造 Client
 *     函数栈)+ declaration-contract 证据边(<Exposed> def 位置),至多证明
 *     「可调用入口」;
 *   - ClientMethods 段的 Exposed 是服务端→客户端方向,不是 client 入口,
 *     如实跳过并登记(不冒充入口);
 *   - 模块级调用者(无实体):唯一 (角色,方法名) 匹配才绑,多实体同名=
 *     ambiguous-name 如实记录,不猜;
 *   - 客户端发出的、注册表里没有的 RPC 调用:unmatched 如实列出(边本身
 *     在逐文件解析图里,不静默消失);
 *   - 绑定到的 rpc-declaration 节点回填 declaration(def 位置)——节点身份
 *     不含 declaration,与 FLOW-004 的 pending-def 节点同 id 合并。
 */

import {
  flowGraphEdge,
  flowGraphNode,
  type FlowGraphEdge,
  type FlowGraphNode,
  type FlowProcessRole,
  type FlowUnresolvedReasonCode
} from './flowGraphModel';
import type { FlowCallResolverResult } from './flowCallResolver';

/** Exposed 方法注册表项(def 语义层提供;本核不解析 def)。 */
export interface FlowExposedMethod {
  /** 实体类型名(def 名) */
  entity: string;
  section: 'BaseMethods' | 'CellMethods' | 'ClientMethods';
  methodName: string;
  defFile: string;
  line: number;
}

export interface FlowClientEntryInput {
  rootKey: string;
  exposedMethods: FlowExposedMethod[];
  /** 客户端面脚本文件(逐个解析找发送边证据) */
  clientFiles: string[];
  resolveFile: (filePath: string) => FlowCallResolverResult | null;
}

export interface FlowClientBinding {
  exposed: FlowExposedMethod;
  /** 绑定目标声明节点(declaration 已回填 def 位置;与解析层同 id) */
  rpcNode: FlowGraphNode;
  /** 真实 client 调用者帧(每调用点一帧引用,同帧可多次出现) */
  callerNodes: FlowGraphNode[];
  /** 语法锚调用边(client 帧 → rpc 声明;解析层原边,不去重) */
  callEdges: FlowGraphEdge[];
}

export interface FlowExternalEntry {
  exposed: FlowExposedMethod;
  /** external-entry 节点(无 fn——不伪造 Client 函数栈) */
  entryNode: FlowGraphNode;
  /** 证据边:external-entry → 声明节点(declaration-contract,<Exposed>) */
  entryEdge: FlowGraphEdge;
  rpcNode: FlowGraphNode;
}

export interface FlowClientEntryResult {
  bindings: FlowClientBinding[];
  externalEntries: FlowExternalEntry[];
  /** ClientMethods 段 Exposed:非 client 入口方向,如实跳过 */
  skipped: Array<{ exposed: FlowExposedMethod; reason: string }>;
  /** 模块级调用者多实体同名:ambiguous-name,不猜唯一落点 */
  ambiguous: Array<{
    methodName: string;
    role: FlowProcessRole;
    candidates: string[];
    code: FlowUnresolvedReasonCode;
  }>;
  /** 客户端发出但注册表无对应 Exposed 的调用(边在逐文件图里,此处只登记) */
  unmatchedClientCalls: Array<{
    methodName: string;
    role: FlowProcessRole;
    callerLabel: string;
  }>;
}

const SECTION_TO_ROLE: Record<'BaseMethods' | 'CellMethods', 'base' | 'cell'> = {
  BaseMethods: 'base',
  CellMethods: 'cell'
};

export function buildClientEntries(
  input: FlowClientEntryInput
): FlowClientEntryResult {
  const bindings = new Map<string, FlowClientBinding>();
  const externalEntries: FlowExternalEntry[] = [];
  const skipped: FlowClientEntryResult['skipped'] = [];
  const ambiguous: FlowClientEntryResult['ambiguous'] = [];
  const unmatchedClientCalls: FlowClientEntryResult['unmatchedClientCalls'] = [];

  /** 注册表声明节点(与 FLOW-004 rpc 节点同 id;declaration 回填) */
  const registryNodeFor = (exposed: FlowExposedMethod): FlowGraphNode => {
    const role = SECTION_TO_ROLE[exposed.section as 'BaseMethods' | 'CellMethods'];
    return flowGraphNode({
      rootKey: input.rootKey,
      role,
      kind: 'rpc-declaration',
      fn: { name: exposed.methodName, filePath: `pending-def:${role}`, signature: '' },
      declaration: { file: exposed.defFile, line: exposed.line, character: 0 },
      label: `RPC 声明:${exposed.methodName}(${role};<Exposed> ${exposed.entity}.def)`
    });
  };

  // ── 客户端证据扫描:client 文件里的角色化发送边 ─────────────────────
  // evidence: (entity | null, role, methodName) → 调用点集合
  const evidence = new Map<
    string,
    { role: 'base' | 'cell'; methodName: string; callerNode: FlowGraphNode; edge: FlowGraphEdge }[]
  >();
  const unmatchedSeen = new Set<string>();
  for (const filePath of input.clientFiles) {
    const result = input.resolveFile(filePath);
    if (!result) {
      continue;
    }
    const nodesById = new Map(result.nodes.map(node => [node.id, node]));
    for (const edge of result.edges) {
      const target = nodesById.get(edge.toNodeId);
      if (!target || target.kind !== 'rpc-declaration') {
        continue;
      }
      const role = target.role;
      if (role !== 'base' && role !== 'cell') {
        continue;
      }
      const methodName = target.fn?.name ?? '';
      const caller = nodesById.get(edge.fromNodeId);
      if (!caller) {
        continue;
      }
      const entityKey = caller.entity?.name ?? null;
      const key = `${entityKey ?? '*'}\u001f${role}\u001f${methodName}`;
      const bucket = evidence.get(key) ?? [];
      bucket.push({ role, methodName, callerNode: caller, edge });
      evidence.set(key, bucket);
      // 注册表匹配预检(同 key 语义)
      const candidates = input.exposedMethods.filter(m =>
        SECTION_TO_ROLE[m.section as 'BaseMethods' | 'CellMethods'] === role &&
        m.methodName === methodName &&
        (entityKey === null || m.entity === entityKey)
      );
      if (candidates.length === 0 && !unmatchedSeen.has(key)) {
        unmatchedSeen.add(key);
        unmatchedClientCalls.push({
          methodName,
          role,
          callerLabel: caller.label
        });
      }
    }
  }

  // ── 逐 Exposed 方法装配入口 ────────────────────────────────────────
  for (const exposed of input.exposedMethods) {
    if (exposed.section === 'ClientMethods') {
      skipped.push({
        exposed,
        reason: 'ClientMethods 段是服务端→客户端方向,不是 client 入口'
      });
      continue;
    }
    const role = SECTION_TO_ROLE[exposed.section];
    const entityKey = exposed.entity;
    // 绑定证据:同实体精确匹配,或模块级调用者(entityKey='*')
    const exact = evidence.get(`${entityKey}\u001f${role}\u001f${exposed.methodName}`) ?? [];
    const moduleLevel = evidence.get(`*\u001f${role}\u001f${exposed.methodName}`) ?? [];
    const hasExact = exact.length > 0;
    const multiEntityNamed = input.exposedMethods.filter(m =>
      SECTION_TO_ROLE[m.section as 'BaseMethods' | 'CellMethods'] === role &&
      m.methodName === exposed.methodName
    ).length > 1;
    if (hasExact) {
      const rpcNode = registryNodeFor(exposed);
      bindings.set(exposed.methodName + '\u001f' + entityKey + '\u001f' + role, {
        exposed,
        rpcNode,
        callerNodes: exact.map(item => item.callerNode),
        callEdges: exact.map(item => item.edge)
      });
    } else if (moduleLevel.length > 0 && !multiEntityNamed) {
      // 模块级调用者 + 全注册表唯一 (role,name):绑(实体未知但唯一)
      const rpcNode = registryNodeFor(exposed);
      bindings.set(exposed.methodName + '\u001f' + entityKey + '\u001f' + role, {
        exposed,
        rpcNode,
        callerNodes: moduleLevel.map(item => item.callerNode),
        callEdges: moduleLevel.map(item => item.edge)
      });
    } else if (moduleLevel.length > 0 && multiEntityNamed) {
      // 模块级调用者多实体同名:归属不猜;每个候选仍立 external-entry
      //(def 旗标是事实),歧义如实登记
      ambiguous.push({
        methodName: exposed.methodName,
        role,
        candidates: input.exposedMethods
          .filter(m => SECTION_TO_ROLE[m.section as 'BaseMethods' | 'CellMethods'] === role && m.methodName === exposed.methodName)
          .map(m => m.entity),
        code: 'ambiguous-name'
      });
      const entryNode = flowGraphNode({
        rootKey: input.rootKey,
        role: 'client',
        kind: 'external-entry',
        label: `外部入口:<Exposed> ${exposed.entity}.${exposed.methodName}(${role};模块级调用者多实体同名,归属未定)`
      });
      const rpcNode = registryNodeFor(exposed);
      const entryEdge = flowGraphEdge({
        fromNodeId: entryNode.id,
        toNodeId: rpcNode.id,
        callSite: null,
        direction: { fromRole: 'client', toRole: role, kind: 'cross-process' },
        syncAsync: 'async-send',
        messageKind: 'rpc',
        evidence: {
          type: 'declaration-contract',
          detail: `<Exposed> 旗标 ${exposed.defFile}:${exposed.line}(存在模块级调用者但实体归属歧义,不猜)`
        }
      });
      externalEntries.push({ exposed, entryNode, entryEdge, rpcNode });
    } else {
      // 无客户端证据:external-entry + <Exposed> 证据边,不伪造 Client 帧
      const entryNode = flowGraphNode({
        rootKey: input.rootKey,
        role: 'client',
        kind: 'external-entry',
        label: `外部入口:<Exposed> ${exposed.entity}.${exposed.methodName}(${role};无客户端源码证据)`
      });
      const rpcNode = registryNodeFor(exposed);
      const entryEdge = flowGraphEdge({
        fromNodeId: entryNode.id,
        toNodeId: rpcNode.id,
        callSite: null,
        direction: { fromRole: 'client', toRole: role, kind: 'cross-process' },
        syncAsync: 'async-send',
        messageKind: 'rpc',
        evidence: {
          type: 'declaration-contract',
          detail: `<Exposed> 旗标 ${exposed.defFile}:${exposed.line}(无客户端调用点,至多证明可调用入口)`
        }
      });
      externalEntries.push({ exposed, entryNode, entryEdge, rpcNode });
    }
  }

  return { bindings: [...bindings.values()], externalEntries, skipped, ambiguous, unmatchedClientCalls };
}
