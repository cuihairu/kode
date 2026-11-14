/**
 * KFLOW RPC 跨进程连接(FLOW-007,G2 的发送→远端执行两段装配核)。
 *
 * 验收:用角色化 EntityCall 与有效 def 找接收实现;消息发送与远端执行是
 * 独立边,不画成同步 Python 子栈。
 *
 * 口径:
 *   - 两段建模:段一=发送边(caller 帧 → rpc 声明节点,async-send,语法锚,
 *     FLOW-004 已产出,本核不改写);段二=远端执行边(rpc 声明节点 → 实现
 *     函数帧,declaration-contract 证据)。两段经 rpc 声明节点显式分开——
 *     拓扑上不存在「同步子栈」形态;执行段在远端进程内是本地执行(sync),
 *     messageKind 仍是 rpc;
 *   - 接收实体=发送者实体(self.<role>.X 邮箱语义:对同一实体的另一面调
 *     用);引擎引用发送(found = KBEngine.entities.get(...); found.cell.X)
 *     落点实体运行期才定 → 如实 unresolved(unknown-receiver),不猜实体;
 *   - 「有效 def」是可达性前提:跨进程方法按 def 方法索引派发,def 未声明
 *     该方法 → missing-declaration(即使 python 侧有同名实现也不连线——
 *     引擎不会派发它);def 已声明但实现文件找不到方法 → missing-declaration;
 *   - 继承实现:实现解析回调返回 inheritedFrom 时证据如实标注(S5 教训:
 *     继承链实现必须可达,身份比较不受 sourceKind 拖累——回调由宿主按全
 *     owner 链解析);
 *   - face-invalid 发送(base 面调 self.base.X)不是合法发送,不入链接
 *     (逐文件图里已是 face-invalid-receiver 未解析形态);
 *   - 实现节点按协议身份合并:同一实现被多个发送边连 → 单节点多条边。
 */

import {
  flowGraphEdge,
  flowGraphNode,
  type FlowGraphEdge,
  type FlowGraphNode,
  type FlowUnresolvedReasonCode
} from './flowGraphModel';
import type { FlowCallResolverResult } from './flowCallResolver';

export interface FlowRpcLinkInput {
  rootKey: string;
  /** 参与扫描的脚本文件(全部面;逐文件解析找发送边) */
  files: string[];
  resolveFile: (filePath: string) => FlowCallResolverResult | null;
  /** def 侧声明解析:实体+段+方法名 → def 位置;null=def 未声明 */
  resolveDefMethod: (
    entity: string,
    section: 'BaseMethods' | 'CellMethods' | 'ClientMethods',
    methodName: string
  ) => {
    defFile: string;
    line: number;
    /** def 声明的 <Arg> 类型序列;缺省/空=未声明(如实,不猜) */
    declaredArgs?: readonly string[];
    /** def 声明的 <ReturnType> 直文本;null/缺=未声明 */
    declaredReturnType?: string | null;
  } | null;
  /** 实现解析:实体+段+方法名 → python 实现位置(宿主按全 owner 链解析);
   *  null=实现缺失 */
  resolveImplementation: (
    entity: string,
    section: 'BaseMethods' | 'CellMethods' | 'ClientMethods',
    methodName: string
  ) => {
    filePath: string;
    line: number;
    signature: string;
    className: string;
    inheritedFrom?: string | null;
  } | null;
}

export interface FlowRpcLink {
  /** 段一:发送边(解析层原边,async-send,语法锚) */
  sendEdge: FlowGraphEdge;
  /** rpc 声明节点(def 声明位置回填;与解析层同 id) */
  rpcNode: FlowGraphNode;
  /** 段二:远端执行边(rpc 声明 → 实现帧,declaration-contract) */
  execEdge: FlowGraphEdge;
  /** 实现函数帧节点 */
  implNode: FlowGraphNode;
  callerEntity: string;
  /** def 声明的 <Arg> 类型序列(空数组=def 未声明,如实不猜,FLOW-017) */
  declaredArgs: readonly string[];
  /** def 声明的 <ReturnType>;null=未声明 */
  declaredReturnType: string | null;
}

export interface FlowRpcUnresolvedLink {
  sendEdge: FlowGraphEdge;
  rpcNode: FlowGraphNode;
  /** 未解析执行边(rpc 声明 → 未解析节点,带原因码) */
  execUnresolvedEdge: FlowGraphEdge;
  code: FlowUnresolvedReasonCode;
  detail: string;
  callerEntity: string | null;
}

export interface FlowRpcLinkResult {
  links: FlowRpcLink[];
  unresolvedLinks: FlowRpcUnresolvedLink[];
}

const ROLE_TO_SECTION: Record<'base' | 'cell' | 'client', 'BaseMethods' | 'CellMethods' | 'ClientMethods'> = {
  base: 'BaseMethods',
  cell: 'CellMethods',
  client: 'ClientMethods'
};

export function buildRpcLinks(input: FlowRpcLinkInput): FlowRpcLinkResult {
  const links: FlowRpcLink[] = [];
  const unresolvedLinks: FlowRpcUnresolvedLink[] = [];
  const implNodeCache = new Map<string, FlowGraphNode>();

  for (const filePath of input.files) {
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
      // FLOW-008 机械保证:广播不产生远端执行帧(受众=AOI 动态集合,不虚构
      // 固定接收)——广播发送行走查序独立呈现,def 契约面不进本链接器
      if (edge.messageKind === 'broadcast') {
        continue;
      }
      // 只收合法发送边(语法锚、无未解析原因);face-invalid/engine-ref
      // 未解析发送按各自口径处理
      const caller = nodesById.get(edge.fromNodeId);
      if (!caller) {
        continue;
      }
      const methodName = target.fn?.name ?? '';
      const role = target.role;
      const callerEntity = caller.entity?.name ?? null;

      if (edge.unresolvedReason?.code === 'unknown-receiver') {
        // 引擎引用发送:落点实体运行期才定,如实不连线
        const code: FlowUnresolvedReasonCode = 'unknown-receiver';
        const detail = `落点实体未知(引擎引用 ${callerEntity ?? '?'}.${methodName}):远端执行边不成立,发送边已证`;
        unresolvedLinks.push({
          sendEdge: edge,
          rpcNode: target,
          execUnresolvedEdge: flowGraphEdge({
            fromNodeId: target.id,
            toNodeId: flowGraphNode({
              rootKey: input.rootKey,
              role,
              kind: 'unresolved',
              unresolvedCode: code,
              unresolvedDetail: detail,
              label: `未解析落点:${methodName}(${role};实体未知)`
            }).id,
            callSite: null,
            direction: {
              fromRole: role,
              toRole: role,
              kind: 'downstream-call'
            },
            syncAsync: 'unknown',
            messageKind: 'unresolved',
            evidence: {
              type: 'declaration-contract',
              detail: '发送边已证(语法锚),落点实体未知——远端执行待运行时证据'
            },
            unresolvedReason: { code, detail }
          }),
          code,
          detail,
          callerEntity
        });
        continue;
      }
      if (edge.unresolvedReason !== null) {
        continue; // face-invalid 等非法发送:不进链接面
      }
      if (!callerEntity) {
        continue; // 无实体的合法发送边(罕见):归逐文件图,不猜实体
      }

      const section = ROLE_TO_SECTION[role as 'base' | 'cell' | 'client'];
      const defDecl = input.resolveDefMethod(callerEntity, section, methodName);
      if (!defDecl) {
        const code: FlowUnresolvedReasonCode = 'missing-declaration';
        const detail = `def ${callerEntity}.${section} 未声明 ${methodName}(跨进程按 def 方法索引派发,无声明不可达,python 同名实现也不连线)`;
        unresolvedLinks.push({
          sendEdge: edge,
          rpcNode: target,
          execUnresolvedEdge: flowGraphEdge({
            fromNodeId: target.id,
            toNodeId: flowGraphNode({
              rootKey: input.rootKey,
              role,
              kind: 'unresolved',
              unresolvedCode: code,
              unresolvedDetail: detail,
              label: `未解析落点:${methodName}(def 未声明)`
            }).id,
            callSite: null,
            direction: { fromRole: role, toRole: role, kind: 'downstream-call' },
            syncAsync: 'unknown',
            messageKind: 'unresolved',
            evidence: {
              type: 'declaration-contract',
              detail: '发送边已证(语法锚),def 侧无声明——引擎不会派发该方法'
            },
            unresolvedReason: { code, detail }
          }),
          code,
          detail,
          callerEntity
        });
        continue;
      }
      const impl = input.resolveImplementation(callerEntity, section, methodName);
      if (!impl) {
        const code: FlowUnresolvedReasonCode = 'missing-declaration';
        const detail = `def ${callerEntity}.${section}.${methodName} 已声明(def ${defDecl.defFile}:${defDecl.line})但实现文件无该方法(全 owner 链未找到)`;
        unresolvedLinks.push({
          sendEdge: edge,
          rpcNode: target,
          execUnresolvedEdge: flowGraphEdge({
            fromNodeId: target.id,
            toNodeId: flowGraphNode({
              rootKey: input.rootKey,
              role,
              kind: 'unresolved',
              unresolvedCode: code,
              unresolvedDetail: detail,
              label: `未解析落点:${methodName}(实现缺失)`
            }).id,
            callSite: null,
            direction: { fromRole: role, toRole: role, kind: 'downstream-call' },
            syncAsync: 'unknown',
            messageKind: 'unresolved',
            evidence: {
              type: 'declaration-contract',
              detail: `def 声明在 ${defDecl.defFile}:${defDecl.line},实现缺失`
            },
            unresolvedReason: { code, detail }
          }),
          code,
          detail,
          callerEntity
        });
        continue;
      }

      // 有效 def + 实现:装配两段
      const rpcNode: FlowGraphNode = flowGraphNode({
        rootKey: input.rootKey,
        role,
        kind: 'rpc-declaration',
        fn: { name: methodName, filePath: `pending-def:${role}`, signature: '' },
        declaration: { file: defDecl.defFile, line: defDecl.line, character: 0 },
        label: `RPC 声明:${methodName}(${role};def ${defDecl.defFile}:${defDecl.line})`
      });
      const implCacheKey = `${callerEntity}\u001f${role}\u001f${methodName}`;
      let implNode = implNodeCache.get(implCacheKey);
      if (!implNode) {
        implNode = flowGraphNode({
          rootKey: input.rootKey,
          role,
          kind: 'function',
          entity: { name: callerEntity, defFile: defDecl.defFile },
          fn: {
            name: methodName,
            filePath: impl.filePath,
            signature: impl.signature
          },
          declaration: { file: impl.filePath, line: impl.line, character: 0 },
          label: `候选帧 ${callerEntity}.${methodName}(${role}${impl.inheritedFrom ? `;继承自 ${impl.inheritedFrom}` : ''})`
        });
        implNodeCache.set(implCacheKey, implNode);
      }
      const execEdge = flowGraphEdge({
        fromNodeId: rpcNode.id,
        toNodeId: implNode.id,
        callSite: null,
        direction: { fromRole: role, toRole: role, kind: 'downstream-call' },
        syncAsync: 'sync',
        messageKind: 'rpc',
        evidence: {
          type: 'declaration-contract',
          detail: `def ${callerEntity}.${section}.${methodName}(${defDecl.defFile}:${defDecl.line}) → ${impl.filePath}:${impl.line}${impl.inheritedFrom ? `(继承自 ${impl.inheritedFrom})` : ''}`
        }
      });
      links.push({
        sendEdge: edge,
        rpcNode,
        execEdge,
        implNode,
        callerEntity,
        declaredArgs: defDecl.declaredArgs ?? [],
        declaredReturnType: defDecl.declaredReturnType ?? null
      });
    }
  }
  return { links, unresolvedLinks };
}
