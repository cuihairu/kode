import { describe, expect, it } from 'vitest';
import { resolveFlowCallSites, type FlowComponentSlot } from '../src/backend/flowCallResolver';
import { classifyAudiences, type FlowAudienceInput } from '../src/backend/flowAudiences';

// FLOW-008(旧 KFLOW-CORE-08)广播/组件调用分类钉。
// 验收:展示单目标/多目标/AOI 受众及组件槽;广播不虚构一个固定接收实例。

const CELL_AVATAR = '/ws/scripts/cell/Avatar.py';
const BASE_AVATAR = '/ws/scripts/base/Avatar.py';

const CELL_TEXT = [
  'class Avatar:',
  '    def rally(self):',
  '        self.allClients.showBanner()',
  '',
  '    def poke(self, eid):',
  '        self.otherClients.poke(eid)',
  '',
  '    def heal(self):',
  '        self.client.onHealed()',
  '        self.companion.follow(self.id)',
  '        self.boost.speedUp()'
].join('\n');

const BASE_TEXT = [
  'class Avatar:',
  '    def greet(self):',
  '        self.allClients.wave()'
].join('\n');

/** 组件槽注册表(def <Components> 段;与解析层同一份) */
const SLOTS = new Map<string, FlowComponentSlot>([
  [
    'companion',
    { entity: 'Companion', role: 'cell', defFile: '/ws/entity_defs/Avatar.def', line: 40 }
  ]
]);

const input = (
  overrides: Partial<FlowAudienceInput> & { resolverSlots?: ReadonlyMap<string, FlowComponentSlot> } = {},
  fileMap: Record<string, string> = {
    [CELL_AVATAR]: CELL_TEXT,
    [BASE_AVATAR]: BASE_TEXT
  }
): FlowAudienceInput => ({
  files: Object.keys(fileMap),
  resolveFile: filePath => {
    const text = fileMap[filePath];
    if (text === undefined) {
      return null;
    }
    return resolveFlowCallSites({
      text,
      filePath,
      rootKey: '/ws',
      componentSlots: overrides.resolverSlots ?? SLOTS
    });
  },
  componentSlots: SLOTS,
  ...overrides
});

describe('FLOW-008 广播受众(AOI)', () => {
  it('cell 面 allClients:aoi-all-clients,广播目标候选集恒空、entity=null(不虚构接收实例)', () => {
    const result = classifyAudiences(input());
    const record = result.audiences.find(r => r.methodName === 'showBanner');
    expect(record).toBeDefined();
    expect(record!.audience).toBe('aoi-all-clients');
    // 契约红线:广播不虚构固定接收实例
    expect(record!.noFabricatedReceiver).toBe(true);
    const targetEdge = record!.callEdge;
    expect(targetEdge.messageKind).toBe('broadcast');
    expect(targetEdge.syncAsync).toBe('async-send');
    expect(targetEdge.evidence.type).toBe('syntax-anchor');
    expect(targetEdge.callSite?.file).toBe(CELL_AVATAR);
    expect(targetEdge.callSite?.line).toBe(2);
    expect(record!.declarationNodeId).toBe(targetEdge.toNodeId);
    expect(result.summary.aoiAllClients).toBe(1);
    // 腰带:解析层广播目标节点本身 entity=null、候选集空(分类层 noFabricatedReceiver 的源头契约)
    const resolved = resolveFlowCallSites({
      text: CELL_TEXT,
      filePath: CELL_AVATAR,
      rootKey: '/ws'
    });
    const broadcastTarget = resolved.nodes.find(node => node.id === targetEdge.toNodeId);
    expect(broadcastTarget?.entity).toBeNull();
    expect(broadcastTarget?.instanceCandidates).toEqual([]);
  });

  it('otherClients:aoi-other-clients(AOI 内除指定实体)', () => {
    const result = classifyAudiences(input());
    const record = result.audiences.find(r => r.methodName === 'poke');
    expect(record).toBeDefined();
    expect(record!.audience).toBe('aoi-other-clients');
    expect(record!.noFabricatedReceiver).toBe(true);
    expect(result.summary.aoiOtherClients).toBe(1);
  });

  it('base 面 allClients:face-invalid,不冒充广播也不冒充实知槽位', () => {
    const result = classifyAudiences(input());
    // base 面无广播记录
    expect(result.audiences.find(r => r.audience.startsWith('aoi-') && r.callEdge.callSite?.file === BASE_AVATAR)).toBeUndefined();
    // face-invalid 不是 unknown-receiver,不进 unknownSlotCalls
    expect(result.unknownSlotCalls.find(c => c.slot === 'allClients')).toBeUndefined();
    expect(result.summary.aoiAllClients).toBe(1); // 仅 cell 面那条
    expect(result.summary.unknownSlots).toBe(1); // 仅 boost
  });
});

describe('FLOW-008 组件槽', () => {
  it('注册槽:组件调用边带 component-slot 候选,def 位置与注册表对账一致', () => {
    const result = classifyAudiences(input());
    const call = result.componentCalls.find(c => c.slot === 'companion');
    expect(call).toBeDefined();
    expect(call!.componentEntity).toBe('Companion');
    expect(call!.methodName).toBe('follow');
    expect(call!.callEdge.messageKind).toBe('rpc');
    expect(call!.callEdge.syncAsync).toBe('async-send');
    expect(call!.callEdge.callSite?.line).toBe(9);
    expect(call!.declarationNodeId).toBe(call!.callEdge.toNodeId);
    expect(call!.defLocationMatchesRegistry).toBe(true);
    expect(result.summary.singleComponentSlot).toBe(1);
  });

  it('对账不一致(注册表与解析输入错位):defLocationMatchesRegistry=false 如实', () => {
    const drifted = new Map<string, FlowComponentSlot>([
      ['companion', { entity: 'Companion', role: 'cell', defFile: '/ws/entity_defs/Avatar.def', line: 99 }]
    ]);
    const result = classifyAudiences(input({ componentSlots: drifted }));
    const call = result.componentCalls.find(c => c.slot === 'companion');
    expect(call).toBeDefined();
    expect(call!.defLocationMatchesRegistry).toBe(false);
  });

  it('未注册槽 self.boost.speedUp():unknownSlotCalls 如实列出,不猜组件语义', () => {
    const result = classifyAudiences(input());
    expect(result.unknownSlotCalls).toEqual([
      { slot: 'boost', methodName: 'speedUp', callerLabel: '候选帧 Avatar.heal' }
    ]);
    expect(result.summary.unknownSlots).toBe(1);
    // 未注册槽没有组件调用记录
    expect(result.componentCalls.find(c => c.slot === 'boost')).toBeUndefined();
  });
});

describe('FLOW-008 单目标与汇总', () => {
  it('单目标 self.client.X:single-mailbox,与广播/组件分类互斥', () => {
    const result = classifyAudiences(input());
    const record = result.audiences.find(r => r.methodName === 'onHealed');
    expect(record).toBeDefined();
    expect(record!.audience).toBe('single-mailbox');
    expect(record!.callEdge.messageKind).toBe('rpc');
    expect(record!.callEdge.callSite?.line).toBe(8);
    expect(result.summary.singleMailbox).toBe(1);
  });

  it('汇总计数:四类互斥、逐边计数齐全', () => {
    const result = classifyAudiences(input());
    expect(result.summary).toEqual({
      singleMailbox: 1,
      singleComponentSlot: 1,
      aoiAllClients: 1,
      aoiOtherClients: 1,
      unknownSlots: 1
    });
    // audiences = 广播 2 + 单目标 1;componentCalls 单列
    expect(result.audiences).toHaveLength(3);
    expect(result.componentCalls).toHaveLength(1);
  });

  it('resolveFile 缺文件:如实跳过,零声称', () => {
    const result = classifyAudiences(input({
      resolveFile: () => null
    }));
    expect(result.audiences).toHaveLength(0);
    expect(result.componentCalls).toHaveLength(0);
    expect(result.unknownSlotCalls).toHaveLength(0);
    expect(result.summary).toEqual({
      singleMailbox: 0,
      singleComponentSlot: 0,
      aoiAllClients: 0,
      aoiOtherClients: 0,
      unknownSlots: 0
    });
  });
});
