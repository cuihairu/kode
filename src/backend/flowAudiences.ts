/**
 * KFLOW 受众分类与组件槽装配(FLOW-008,G2 的广播/组件调用分类核)。
 *
 * 验收:展示单目标/多目标/AOI 受众及组件槽;广播不虚构一个固定接收实例。
 *
 * 口径:
 *   - 单目标=self.<role>.X / self.<slot>.X(rpc 发送边,接收实例经邮箱/组件
 *     槽可证);多目标=self.allClients.X(AOI 范围全部持有客户端);AOI 受众
 *     同源(allClients 就是 AOI 受众);otherClients=AOI 内除指定实体外;
 *   - 广播目标节点 instanceCandidates 恒空(FLOW-004 解析面已立;此处校验
 *     不变式——受众是运行期动态集合,静态图不得虚构固定接收实例);
 *   - 组件槽:解析层按注册表产组件调用边(带 component-slot 候选);本核把
 *     槽身份与 def 注册位置对账(槽/实体/def 位置一致才算已装配);
 *   - 未注册槽的 self.<name>.X:如实归 unknownSlotCalls(可能是普通属性链,
 *     不猜组件语义);
 *   - 分类结果面向 UI 泳道(FLOW-014+):audience 字段描述受众形态,边本身
 *     仍是解析层语法锚边(证据不变)。
 */

import type {
  FlowCallResolverResult,
  FlowComponentSlot
} from './flowCallResolver';
import type { FlowGraphEdge } from './flowGraphModel';

export interface FlowAudienceInput {
  files: string[];
  resolveFile: (filePath: string) => FlowCallResolverResult | null;
  /** 组件槽注册表(与解析层同一份;对账用) */
  componentSlots?: ReadonlyMap<string, FlowComponentSlot>;
}

export type FlowAudienceKind =
  | 'single-mailbox'
  | 'single-component-slot'
  | 'aoi-all-clients'
  | 'aoi-other-clients';

export interface FlowAudienceRecord {
  audience: FlowAudienceKind;
  methodName: string;
  /** 调用点语法锚边(解析层原边) */
  callEdge: FlowGraphEdge;
  callerLabel: string;
  /** 声明节点 id(rpc 声明;广播目标候选集恒空) */
  declarationNodeId: string;
  /** 广播目标候选集为空的不变式校验结果(true=未虚构接收实例) */
  noFabricatedReceiver: boolean;
}

export interface FlowComponentCallRecord {
  slot: string;
  componentEntity: string;
  methodName: string;
  callEdge: FlowGraphEdge;
  callerLabel: string;
  declarationNodeId: string;
  /** 槽对账:def 注册位置与注册表一致 */
  defLocationMatchesRegistry: boolean;
}

export interface FlowAudienceResult {
  /** 按(调用者,方法)粒度的受众记录(边级,同方法多调用点多记录) */
  audiences: FlowAudienceRecord[];
  componentCalls: FlowComponentCallRecord[];
  /** 未注册槽的 self.<name>.X(不猜组件语义,如实列出) */
  unknownSlotCalls: Array<{
    slot: string;
    methodName: string;
    callerLabel: string;
  }>;
  /** 汇总:单目标/多目标/AOI/组件槽 计数(UI 泳道直接消费) */
  summary: {
    singleMailbox: number;
    singleComponentSlot: number;
    aoiAllClients: number;
    aoiOtherClients: number;
    unknownSlots: number;
  };
}

export function classifyAudiences(input: FlowAudienceInput): FlowAudienceResult {
  const audiences: FlowAudienceRecord[] = [];
  const componentCalls: FlowComponentCallRecord[] = [];
  const unknownSlotCalls: FlowAudienceResult['unknownSlotCalls'] = [];
  const unknownSlotSeen = new Set<string>();
  let singleMailbox = 0;
  let singleComponentSlot = 0;
  let aoiAllClients = 0;
  let aoiOtherClients = 0;

  for (const filePath of input.files) {
    const result = input.resolveFile(filePath);
    if (!result) {
      continue;
    }
    const nodesById = new Map(result.nodes.map(node => [node.id, node]));
    for (const edge of result.edges) {
      const target = nodesById.get(edge.toNodeId);
      if (!target) {
        continue;
      }
      const caller = nodesById.get(edge.fromNodeId);
      const callerLabel = caller?.label ?? edge.fromNodeId;

      // 广播边(allClients/otherClients,解析层已立)
      if (edge.messageKind === 'broadcast') {
        const isAll = edge.evidence.type === 'syntax-anchor' &&
          edge.evidence.detail.includes('allClients:');
        const kind: FlowAudienceKind = isAll ? 'aoi-all-clients' : 'aoi-other-clients';
        if (isAll) {
          aoiAllClients += 1;
        } else {
          aoiOtherClients += 1;
        }
        audiences.push({
          audience: kind,
          methodName: target.fn?.name ?? '',
          callEdge: edge,
          callerLabel,
          declarationNodeId: target.id,
          noFabricatedReceiver:
            target.instanceCandidates.length === 0 && target.entity === null
        });
        continue;
      }

      // 组件槽边(解析层按注册表产出;target 带 component-slot 候选)
      const slotCandidate = target.instanceCandidates.find(
        candidate => candidate.kind === 'component-slot'
      );
      if (slotCandidate && slotCandidate.kind === 'component-slot') {
        const slot = slotCandidate.identity;
        const registry = input.componentSlots?.get(slot);
        const defLocationMatchesRegistry = Boolean(
          registry &&
          target.entity?.name === registry.entity &&
          target.declaration?.file === registry.defFile &&
          target.declaration?.line === registry.line
        );
        if (slotCandidate) {
          singleComponentSlot += 1;
        }
        componentCalls.push({
          slot,
          componentEntity: target.entity?.name ?? '',
          methodName: target.fn?.name ?? '',
          callEdge: edge,
          callerLabel,
          declarationNodeId: target.id,
          defLocationMatchesRegistry
        });
        continue;
      }

      // 单目标邮箱发送(self.<role>.X,rpc 语法锚边)
      if (
        edge.messageKind === 'rpc' &&
        edge.syncAsync === 'async-send' &&
        edge.callSite !== null &&
        target.kind === 'rpc-declaration' &&
        target.instanceCandidates.length === 0
      ) {
        singleMailbox += 1;
        audiences.push({
          audience: 'single-mailbox',
          methodName: target.fn?.name ?? '',
          callEdge: edge,
          callerLabel,
          declarationNodeId: target.id,
          noFabricatedReceiver: false
        });
        continue;
      }

      // 未注册槽:仅 unknown-receiver 两段链(evidence 形如 self.<slot>.<callee>;
      // face-invalid 等其他未解析码不是槽面——base 面 allClients 是非法广播
      // 尝试,不冒充实知槽位);三段及以上中段属性链不归槽,如实留未知
      if (
        edge.messageKind === 'unresolved' &&
        edge.unresolvedReason?.code === 'unknown-receiver' &&
        edge.evidence.type === 'syntax-anchor'
      ) {
        const m = /^self\.([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(
          edge.evidence.detail
        );
        if (m && !unknownSlotSeen.has(`${m[1]}\u001f${m[2]}\u001f${callerLabel}`)) {
          unknownSlotSeen.add(`${m[1]}\u001f${m[2]}\u001f${callerLabel}`);
          unknownSlotCalls.push({
            slot: m[1],
            methodName: m[2],
            callerLabel
          });
        }
      }
    }
  }

  return {
    audiences,
    componentCalls,
    unknownSlotCalls,
    summary: {
      singleMailbox,
      singleComponentSlot,
      aoiAllClients,
      aoiOtherClients,
      unknownSlots: unknownSlotCalls.length
    }
  };
}
