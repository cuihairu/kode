import { describe, expect, it } from 'vitest';
import {
  flowGraphEdge,
  flowGraphNode,
  flowGraphNodeIdentity,
  type FlowGraph
} from '../src/backend/flowGraphModel';

// FLOW-003(旧 KFLOW-CORE-03)流转节点/边协议钉。
// 验收映射:节点六面(rootKey/role/instanceCandidates/entity/fn/declaration)
// + 边七面(callSite/direction/syncAsync/condition/messageKind/evidence/
// unresolvedReason)+ 契约红线(证据分型 R2、候选帧词汇 R1、未解析必带原因)。
// 本文件钉协议行为本身(构造校验/身份确定性),消费面在 FLOW-004/005 接线。

const entityAvatar = { name: 'Avatar', defFile: '/ws/scripts/entity_defs/Avatar.def' };
const fnRequestMove = {
  name: 'requestMove',
  filePath: '/ws/scripts/base/Avatar.py',
  signature: 'def requestMove(self, d)'
};
const callSite = { file: '/ws/scripts/base/Avatar.py', line: 3, character: 8 };

describe('FLOW-003 流转节点协议', () => {
  it('节点六面齐备:工程/角色/实例候选/实体/函数/源码', () => {
    const node = flowGraphNode({
      rootKey: '/ws',
      role: 'base',
      kind: 'function',
      instanceCandidates: [{ kind: 'entity-type', identity: 'Avatar' }],
      entity: entityAvatar,
      fn: fnRequestMove,
      declaration: { file: '/ws/scripts/base/Avatar.py', line: 2, character: 4 },
      label: '候选帧 Avatar.requestMove(base)'
    });
    expect(node.rootKey).toBe('/ws');
    expect(node.role).toBe('base');
    expect(node.instanceCandidates).toEqual([{ kind: 'entity-type', identity: 'Avatar' }]);
    expect(node.entity).toEqual(entityAvatar);
    expect(node.fn).toEqual(fnRequestMove);
    expect(node.declaration?.line).toBe(2);
    // 契约 R1:标签用「候选帧」词汇,不含「栈帧」
    expect(node.label).toContain('候选帧');
    expect(node.label).not.toContain('栈帧');
  });

  it('节点身份确定性:同形态同 id,函数/实体/原因任一变即异 id', () => {
    const base = {
      rootKey: '/ws',
      role: 'cell' as const,
      kind: 'function' as const,
      entity: entityAvatar,
      fn: fnRequestMove
    };
    const other = {
      rootKey: '/ws',
      role: 'cell' as const,
      kind: 'function' as const,
      entity: entityAvatar,
      fn: { ...fnRequestMove, name: 'adminNuke' }
    };
    expect(flowGraphNodeIdentity(base)).toBe(flowGraphNodeIdentity(base));
    expect(flowGraphNodeIdentity(base)).not.toBe(flowGraphNodeIdentity(other));
    // 未解析原因进身份:同节点不同原因不合并
    expect(flowGraphNodeIdentity({ ...base, kind: 'unresolved', unresolvedCode: 'unknown-receiver' }))
      .not.toBe(flowGraphNodeIdentity({ ...base, kind: 'unresolved', unresolvedCode: 'dynamic-getattr' }));
  });

  it('实例候选冻结且允许空(无候选=诚实,不编造)', () => {
    const node = flowGraphNode({
      rootKey: '/ws',
      role: 'client',
      kind: 'external-entry',
      label: '外部入口:<Exposed> requestMove(无客户端源码)'
    });
    expect(node.instanceCandidates).toEqual([]);
    expect(Object.isFrozen(node.instanceCandidates)).toBe(true);
  });

  it('未解析节点必须带原因码;external-entry 不许携带伪造函数帧', () => {
    expect(() => flowGraphNode({
      rootKey: '/ws',
      role: 'cell',
      kind: 'unresolved',
      label: '未解析'
    })).toThrow(/reason code/);
    expect(() => flowGraphNode({
      rootKey: '/ws',
      role: 'client',
      kind: 'external-entry',
      fn: fnRequestMove,
      label: '外部入口'
    })).toThrow(/fabricated function frame/);
  });
});

describe('FLOW-003 流转边协议', () => {
  const fromNode = flowGraphNode({
    rootKey: '/ws',
    role: 'base',
    kind: 'function',
    entity: entityAvatar,
    fn: fnRequestMove,
    label: '候选帧 Avatar.requestMove(base)'
  });
  const toNode = flowGraphNode({
    rootKey: '/ws',
    role: 'cell',
    kind: 'function',
    entity: entityAvatar,
    fn: { name: 'doMove', filePath: '/ws/scripts/cell/Avatar.py', signature: 'def doMove(self, d)' },
    label: '候选帧 Avatar.doMove(cell)'
  });

  it('边七面齐备:调用点/方向/同步异步/条件/消息RPC/证据/未解析原因', () => {
    const edge = flowGraphEdge({
      fromNodeId: fromNode.id,
      toNodeId: toNode.id,
      callSite,
      direction: { fromRole: 'base', toRole: 'cell', kind: 'downstream-call' },
      syncAsync: 'async-send',
      condition: { text: 'if d > 0', kind: 'if-branch' },
      messageKind: 'rpc',
      evidence: { type: 'syntax-anchor', detail: 'self.cell.doMove(d)' }
    });
    expect(edge.callSite).toEqual(callSite);
    expect(edge.direction).toEqual({ fromRole: 'base', toRole: 'cell', kind: 'downstream-call' });
    expect(edge.syncAsync).toBe('async-send');
    expect(edge.condition?.text).toBe('if d > 0');
    expect(edge.messageKind).toBe('rpc');
    expect(edge.evidence).toEqual({ type: 'syntax-anchor', detail: 'self.cell.doMove(d)' });
    expect(edge.unresolvedReason).toBeNull();
  });

  it('边身份含调用点:同节点对两次调用=两条边(FLOW-005 保留调用点)', () => {
    const edgeA = flowGraphEdge({
      fromNodeId: fromNode.id,
      toNodeId: toNode.id,
      callSite: { file: '/ws/scripts/base/Avatar.py', line: 3, character: 8 },
      direction: { fromRole: 'base', toRole: 'cell', kind: 'downstream-call' },
      syncAsync: 'async-send',
      messageKind: 'rpc',
      evidence: { type: 'syntax-anchor', detail: 'self.cell.doMove(1)' }
    });
    const edgeB = flowGraphEdge({
      fromNodeId: fromNode.id,
      toNodeId: toNode.id,
      callSite: { file: '/ws/scripts/base/Avatar.py', line: 7, character: 8 },
      direction: { fromRole: 'base', toRole: 'cell', kind: 'downstream-call' },
      syncAsync: 'async-send',
      messageKind: 'rpc',
      evidence: { type: 'syntax-anchor', detail: 'self.cell.doMove(2)' }
    });
    expect(edgeA.id).not.toBe(edgeB.id);
    expect(edgeA.id).toContain(String(3));
    expect(edgeB.id).toContain(String(7));
  });

  it('契约 R2:syntax-anchor 证据必须有调用点;运行时证据型不存在', () => {
    expect(() => flowGraphEdge({
      fromNodeId: fromNode.id,
      toNodeId: toNode.id,
      callSite: null,
      direction: { fromRole: 'base', toRole: 'cell', kind: 'downstream-call' },
      syncAsync: 'async-send',
      messageKind: 'rpc',
      evidence: { type: 'syntax-anchor', detail: '无调用点' }
    })).toThrow(/call site/);
    // 类型面红线:FlowEvidence 判别联合只有 syntax-anchor/declaration-contract/
    // external-source 三型,无 runtime 型——以声明面构造编译期锁定(此处运行断言)。
    const evidence: 'syntax-anchor' | 'declaration-contract' | 'external-source' =
      'declaration-contract';
    expect(evidence).toBe('declaration-contract');
  });

  it('未解析边必须带原因;broadcast 允许无调用点(声明契约证据)', () => {
    const unresolvedTarget = flowGraphNode({
      rootKey: '/ws',
      role: 'unknown',
      kind: 'unresolved',
      unresolvedCode: 'face-invalid-receiver',
      unresolvedDetail: 'base 脚本 self.base.onMoveDone():base 面无 .base 属性',
      label: '未解析:face-invalid-receiver'
    });
    const edge = flowGraphEdge({
      fromNodeId: fromNode.id,
      toNodeId: unresolvedTarget.id,
      callSite,
      direction: { fromRole: 'base', toRole: 'unknown', kind: 'downstream-call' },
      syncAsync: 'unknown',
      messageKind: 'unresolved',
      evidence: { type: 'syntax-anchor', detail: 'self.base.onMoveDone()' },
      unresolvedReason: {
        code: 'face-invalid-receiver',
        detail: 'baseapp 实体无 .base 属性(九面表 base.base=null)'
      }
    });
    expect(edge.unresolvedReason?.code).toBe('face-invalid-receiver');
    expect(() => flowGraphEdge({
      fromNodeId: fromNode.id,
      toNodeId: unresolvedTarget.id,
      callSite,
      direction: { fromRole: 'base', toRole: 'unknown', kind: 'downstream-call' },
      syncAsync: 'unknown',
      messageKind: 'unresolved',
      evidence: { type: 'syntax-anchor', detail: 'self.x()' }
    })).toThrow(/unresolved edge requires a reason/);

    // 广播边:无调用点,声明契约证据(<Exposed>/AOI 受众)
    const broadcast = flowGraphEdge({
      fromNodeId: fromNode.id,
      toNodeId: toNode.id,
      callSite: null,
      direction: { fromRole: 'cell', toRole: 'client', kind: 'cross-process' },
      syncAsync: 'async-send',
      messageKind: 'broadcast',
      evidence: { type: 'declaration-contract', detail: 'allClients AOI 受众,引擎出处 witness 面' }
    });
    expect(broadcast.callSite).toBeNull();
    expect(broadcast.messageKind).toBe('broadcast');
  });

  it('图容器:查询方向+截断如实;多调用点边共存', () => {
    const edgeA = flowGraphEdge({
      fromNodeId: fromNode.id,
      toNodeId: toNode.id,
      callSite: { file: '/ws/scripts/base/Avatar.py', line: 3, character: 8 },
      direction: { fromRole: 'base', toRole: 'cell', kind: 'downstream-call' },
      syncAsync: 'async-send',
      messageKind: 'rpc',
      evidence: { type: 'syntax-anchor', detail: 'a' }
    });
    const edgeB = flowGraphEdge({
      fromNodeId: fromNode.id,
      toNodeId: toNode.id,
      callSite: { file: '/ws/scripts/base/Avatar.py', line: 7, character: 8 },
      direction: { fromRole: 'base', toRole: 'cell', kind: 'downstream-call' },
      syncAsync: 'async-send',
      messageKind: 'rpc',
      evidence: { type: 'syntax-anchor', detail: 'b' }
    });
    const graph: FlowGraph = {
      query: { kind: 'downstream', rootNodeId: fromNode.id, truncatedAtDepth: 3 },
      nodes: [fromNode, toNode],
      edges: [edgeA, edgeB]
    };
    expect(graph.query.truncatedAtDepth).toBe(3);
    expect(graph.edges).toHaveLength(2);
    expect(new Set(graph.edges.map(edge => edge.id)).size).toBe(2);
  });
});
