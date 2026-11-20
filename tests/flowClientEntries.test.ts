import { describe, expect, it } from 'vitest';
import { resolveFlowCallSites } from '../src/backend/flowCallResolver';
import {
  buildClientEntries,
  type FlowExposedMethod
} from '../src/backend/flowClientEntries';

// FLOW-006(旧 KFLOW-CORE-06)Client 真实调用入口钉。
// 验收:有客户端源代码时绑定实际调用点到 Exposed RPC;无客户端源码只显示
// 外部入口和证据,不能伪造 Client 函数栈(FLOW-001 S6 修复面)。

const CLIENT_AVATAR = '/ws/scripts/client/Avatar.py';
const BOTS_MAIN = '/ws/scripts/bots/main.py';

const CLIENT_FILES: Record<string, string> = {
  [CLIENT_AVATAR]: [
    'class Avatar:',
    '    def chooseRole(self):',
    '        self.base.requestMove(3)',
    '        self.cell.pickUp()',
    '        self.base.teleport()',
    '',
    '    def second(self):',
    '        self.base.requestMove(4)'
  ].join('\n'),
  [BOTS_MAIN]: [
    'import KBEngine',
    'def tick():',
    '    e = KBEngine.entities.get(7)',
    '    e.base.fire()'
  ].join('\n')
};

const EXPOSED: FlowExposedMethod[] = [
  { entity: 'Avatar', section: 'BaseMethods', methodName: 'requestMove', defFile: '/ws/entity_defs/Avatar.def', line: 6 },
  { entity: 'Avatar', section: 'CellMethods', methodName: 'pickUp', defFile: '/ws/entity_defs/Avatar.def', line: 9 },
  { entity: 'Avatar', section: 'BaseMethods', methodName: 'adminNuke', defFile: '/ws/entity_defs/Avatar.def', line: 12 },
  { entity: 'Monster', section: 'ClientMethods', methodName: 'shout', defFile: '/ws/entity_defs/Monster.def', line: 3 },
  { entity: 'Monster', section: 'BaseMethods', methodName: 'roar', defFile: '/ws/entity_defs/Monster.def', line: 5 },
  { entity: 'Avatar', section: 'BaseMethods', methodName: 'fire', defFile: '/ws/entity_defs/Avatar.def', line: 20 },
  { entity: 'Monster', section: 'BaseMethods', methodName: 'fire', defFile: '/ws/entity_defs/Monster.def', line: 8 }
];

function build() {
  return buildClientEntries({
    rootKey: '/ws',
    exposedMethods: EXPOSED,
    clientFiles: Object.keys(CLIENT_FILES),
    resolveFile: filePath => {
      const text = CLIENT_FILES[filePath];
      if (text === undefined) {
        return null;
      }
      return resolveFlowCallSites({ text, filePath });
    }
  });
}

const bindingOf = (
  result: ReturnType<typeof build>,
  methodName: string,
  entity: string
) => result.bindings.find(b => b.exposed.methodName === methodName && b.exposed.entity === entity);

describe('FLOW-006 有客户端源码:绑定实际调用点', () => {
  it('requestMove 双调用点:调用者帧真实、语法锚边、def 声明回填', () => {
    const result = build();
    const binding = bindingOf(result, 'requestMove', 'Avatar');
    expect(binding).toBeDefined();
    expect(binding!.callEdges).toHaveLength(2);
    expect(binding!.callEdges.map(edge => edge.callSite?.line).sort()).toEqual([2, 7]);
    expect(new Set(binding!.callEdges.map(edge => edge.id)).size).toBe(2);
    // 调用者是真实 client 帧(chooseRole / second),不是合成 client 源节点
    expect(binding!.callerNodes.map(node => node.fn?.name).sort()).toEqual(['chooseRole', 'second']);
    expect(binding!.callerNodes.every(node => node.kind === 'function')).toBe(true);
    expect(binding!.callerNodes.every(node => node.entity?.name === 'Avatar')).toBe(true);
    // rpc 声明节点 declaration 回填 def 位置
    expect(binding!.rpcNode.declaration).toEqual({
      file: '/ws/entity_defs/Avatar.def',
      line: 6,
      character: 0
    });
    // 证据:语法锚边
    for (const edge of binding!.callEdges) {
      expect(edge.evidence.type).toBe('syntax-anchor');
      expect(edge.direction.toRole).toBe('base');
    }
  });

  it('跨层身份一致:绑定节点 id 与解析层 rpc 节点同 id(可合并)', () => {
    const result = build();
    const binding = bindingOf(result, 'requestMove', 'Avatar');
    const clientResult = resolveFlowCallSites({
      text: CLIENT_FILES[CLIENT_AVATAR],
      filePath: CLIENT_AVATAR,
      rootKey: '/ws'
    });
    const resolverRpcId = clientResult.edges.find(
      edge => clientResult.nodes.find(n => n.id === edge.toNodeId)?.fn?.name === 'requestMove'
    )?.toNodeId;
    expect(binding!.rpcNode.id).toBe(resolverRpcId);
  });

  it('cell 段 Exposed 同样绑定(pickUp,role=cell)', () => {
    const result = build();
    const binding = bindingOf(result, 'pickUp', 'Avatar');
    expect(binding).toBeDefined();
    expect(binding!.callEdges[0].direction.toRole).toBe('cell');
    expect(binding!.rpcNode.declaration?.line).toBe(9);
  });
});

describe('FLOW-006 无客户端源码:外部入口+证据,不伪造 Client 栈', () => {
  it('adminNuke/roar 无调用证据:external-entry(无 fn)+ <Exposed> 证据边', () => {
    const result = build();
    // adminNuke/roar 无证据;fire×2 是歧义分支的外部入口(def 旗标是事实)
    expect(result.externalEntries.map(entry => entry.exposed.methodName).sort())
      .toEqual(['adminNuke', 'fire', 'fire', 'roar']);
    const entry = result.externalEntries.find(e => e.exposed.methodName === 'adminNuke')!;
    // 协议红线:external-entry 不携带伪造函数帧
    expect(entry.entryNode.kind).toBe('external-entry');
    expect(entry.entryNode.fn).toBeNull();
    expect(entry.entryNode.role).toBe('client');
    // 证据边:declaration-contract,<Exposed> 旗标出处,无调用点
    expect(entry.entryEdge.callSite).toBeNull();
    expect(entry.entryEdge.evidence.type).toBe('declaration-contract');
    expect(entry.entryEdge.evidence.detail).toContain('<Exposed>');
    expect(entry.entryEdge.evidence.detail).toContain('Avatar.def:12');
    // 声明节点带 def 位置
    expect(entry.rpcNode.declaration?.file).toBe('/ws/entity_defs/Avatar.def');
    expect(entry.rpcNode.declaration?.line).toBe(12);
  });
});

describe('FLOW-006 诚实边界', () => {
  it('ClientMethods 段 Exposed 不是 client 入口:如实跳过', () => {
    const result = build();
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].exposed.methodName).toBe('shout');
    expect(result.skipped[0].reason).toContain('服务端→客户端');
    // 不出现在绑定/外部入口
    expect(result.bindings.find(b => b.exposed.methodName === 'shout')).toBeUndefined();
    expect(result.externalEntries.find(e => e.exposed.methodName === 'shout')).toBeUndefined();
  });

  it('模块级调用者多实体同名:ambiguous-name,不猜唯一落点', () => {
    const result = build();
    const record = result.ambiguous.find(a => a.methodName === 'fire');
    expect(record).toBeDefined();
    expect(record!.code).toBe('ambiguous-name');
    expect(record!.candidates.sort()).toEqual(['Avatar', 'Monster']);
    expect(record!.role).toBe('base');
    // fire 不绑(归属未知),但每个候选仍立 external-entry(def 旗标是事实)
    expect(bindingOf(result, 'fire', 'Avatar')).toBeUndefined();
    const fireEntries = result.externalEntries.filter(e => e.exposed.methodName === 'fire');
    expect(fireEntries).toHaveLength(2);
    expect(fireEntries[0].entryEdge.evidence.detail).toContain('歧义');
  });

  it('注册表外的客户端调用:unmatched 如实列出,不静默消失', () => {
    const result = build();
    const record = result.unmatchedClientCalls.find(c => c.methodName === 'teleport');
    expect(record).toBeDefined();
    expect(record!.role).toBe('base');
    expect(record!.callerLabel).toContain('chooseRole');
  });
});

// ---------------------------------------------------------------------------
// 批 35:证据收集与绑定容错臂——文件不可解析跳过、非 rpc 边跳过、client 角色
// 边跳过、模块级调用者+注册表唯一名绑(实体未知但唯一)。
// ---------------------------------------------------------------------------
describe('批 35:证据收集与绑定容错', () => {
  const EXTRA = '/ws/tools/panel.py';
  const FILES: Record<string, string> = {
    ...CLIENT_FILES,
    [EXTRA]: [
      'import KBEngine',
      '',
      'def helper():',
      '    pass',
      '',
      'def call_all():',
      '    e = KBEngine.entities.get(1)',
      '    e.base.ping()',
      '    helper()',
      '',
      'class SpaceView:',
      '    def onUpdate(self):',
      '        self.client.shout()'
    ].join('\n'),
    '/ws/scripts/client/gone.py': 'unresolvable marker'
  };
  const EXPOSED_EXT: FlowExposedMethod[] = [
    ...EXPOSED,
    { entity: 'Avatar', section: 'BaseMethods', methodName: 'ping', defFile: '/ws/entity_defs/Avatar.def', line: 30 }
  ];

  const buildExt = () =>
    buildClientEntries({
      rootKey: '/ws',
      exposedMethods: EXPOSED_EXT,
      clientFiles: Object.keys(FILES),
      resolveFile: filePath => {
        const text = FILES[filePath];
        if (filePath === '/ws/scripts/client/gone.py') {
          return null; // 文件不可解析:如实跳过
        }
        return text === undefined ? null : resolveFlowCallSites({ text, filePath });
      }
    });

  it('不可解析文件跳过;client 角色与非 rpc 调用不进证据', () => {
    const result = buildExt();
    // gone.py 被跳过不抛;本地函数调用(非 rpc 边)与 client 角色边零绑定
    expect(result.bindings.find(b => b.exposed.methodName === 'helper')).toBeUndefined();
    expect(result.bindings.find(b => b.exposed.methodName === 'shout' && b.callerNodes.some(n => n.fn?.name === 'onUpdate'))).toBeUndefined();
  });

  it('模块级调用者 + 注册表唯一 (role,name) → 绑(实体键为空)', () => {
    const result = buildExt();
    const binding = result.bindings.find(b => b.exposed.methodName === 'ping');
    expect(binding).toBeDefined();
    expect(binding!.callerNodes.length).toBeGreaterThan(0);
    // 模块级调用者帧:函数名来自模块 def
    expect(binding!.callerNodes.map(n => n.fn?.name)).toContain('call_all');
  });
});

// 覆盖口径残余(批 35 定性)::144 边的 caller 节点缺位——resolveFlowCallSites
// 产出的边 fromNodeId 恒指向本文件节点集内(自产自销不变量),跨文件悬空边
// 经公共入口不可构造,防御位。
// 判例:**client 接收边的剪枝按路径**——文件在 scripts/client/ 下时
// `self.client.X` 调用边被剪(客户端脚本自身 ClientMethods 面),夹具要触发
// client 角色收集臂须放非 client 路径(如 tools/)。
