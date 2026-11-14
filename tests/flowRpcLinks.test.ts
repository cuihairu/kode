import { describe, expect, it } from 'vitest';
import { resolveFlowCallSites } from '../src/backend/flowCallResolver';
import {
  buildRpcLinks,
  type FlowRpcLinkInput
} from '../src/backend/flowRpcLinks';

// FLOW-007(旧 KFLOW-CORE-07)RPC 跨进程连接钉。
// 验收:用角色化 EntityCall 与有效 def 找接收实现;消息发送与远端执行是
// 独立边,不画成同步 Python 子栈(FLOW-001 S2/S3 落点面)。

const BASE_AVATAR = '/ws/scripts/base/Avatar.py';
const CELL_AVATAR = '/ws/scripts/cell/Avatar.py';
const CLIENT_AVATAR = '/ws/scripts/client/Avatar.py';
const CELL_NPC = '/ws/scripts/cell/NPC.py';

const FILES: Record<string, string> = {
  [BASE_AVATAR]: [
    'class Avatar:',
    '    def requestMove(self, d):',
    '        self.cell.doMove(d)',
    '        self.client.onMoveDone()',
    '        self.base.onBaseDone()'
  ].join('\n'),
  [CELL_AVATAR]: [
    'class Avatar:',
    '    def doMove(self, d):',
    '        pass',
    '',
    '    def attack(self):',
    '        found = KBEngine.entities.get(101)',
    '        found.cell.halt()'
  ].join('\n'),
  [CLIENT_AVATAR]: [
    'class Avatar:',
    '    def chooseRole(self):',
    '        self.base.requestMove(3)'
  ].join('\n'),
  [CELL_NPC]: [
    'class NPC:',
    '    def stalk(self):',
    '        self.doMove(1)',
    '        self.base.reportIn()'
  ].join('\n')
};

/** def 注册表:doMove/onMoveDone 已声明;ghostCall/halt 未声明;onBaseDone
 *  未声明(base.base 本就非法,连不到这里——face-invalid 在解析层已拦) */
const DEF_REGISTRY: Record<string, { defFile: string; line: number }> = {
  'Avatar\u001fCellMethods\u001fdoMove': { defFile: '/ws/entity_defs/Avatar.def', line: 21 },
  'Avatar\u001fClientMethods\u001fonMoveDone': { defFile: '/ws/entity_defs/Avatar.def', line: 34 },
  'NPC\u001fCellMethods\u001fdoMove': { defFile: '/ws/entity_defs/NPC.def', line: 8 },
  'NPC\u001fBaseMethods\u001freportIn': { defFile: '/ws/entity_defs/NPC.def', line: 9 }
};

/** 实现注册表:Avatar.doMove 在 cell 面;onMoveDone 在 client 面;NPC.doMove
 *  继承自 Avatar(S5 教训:继承链实现可达) */
const IMPL_REGISTRY: Record<string, { filePath: string; line: number; signature: string; className: string; inheritedFrom?: string }> = {
  'Avatar\u001fCellMethods\u001fdoMove': { filePath: CELL_AVATAR, line: 1, signature: 'def doMove(self, d)', className: 'Avatar' },
  'Avatar\u001fClientMethods\u001fonMoveDone': { filePath: CLIENT_AVATAR, line: 1, signature: 'def onMoveDone(self)', className: 'Avatar' },
  'NPC\u001fCellMethods\u001fdoMove': { filePath: CELL_AVATAR, line: 1, signature: 'def doMove(self, d)', className: 'Avatar', inheritedFrom: 'Avatar' },
  'NPC\u001fBaseMethods\u001freportIn': { filePath: BASE_AVATAR, line: 8, signature: 'def reportIn(self)', className: 'Avatar', inheritedFrom: 'Avatar' }
};

const input = (
  overrides: Partial<FlowRpcLinkInput> = {},
  fileMap: Record<string, string> = FILES
): FlowRpcLinkInput => ({
  rootKey: '/ws',
  files: Object.keys(fileMap),
  resolveFile: filePath => {
    const text = fileMap[filePath];
    if (text === undefined) {
      return null;
    }
    return resolveFlowCallSites({ text, filePath, rootKey: '/ws' });
  },
  resolveDefMethod: (entity, section, methodName) =>
    DEF_REGISTRY[`${entity}\u001f${section}\u001f${methodName}`] ?? null,
  resolveImplementation: (entity, section, methodName) =>
    IMPL_REGISTRY[`${entity}\u001f${section}\u001f${methodName}`] ?? null,
  ...overrides
});

describe('FLOW-007 两段建模', () => {
  it('base→cell 发送:发送边与远端执行边独立,经 rpc 声明节点分开', () => {
    const result = buildRpcLinks(input());
    const link = result.links.find(l => l.sendEdge.callSite?.line === 2);
    expect(link).toBeDefined();
    // 段一:发送边(async-send,语法锚,解析层原边)
    expect(link!.sendEdge.syncAsync).toBe('async-send');
    expect(link!.sendEdge.evidence.type).toBe('syntax-anchor');
    expect(link!.sendEdge.callSite?.file).toBe(BASE_AVATAR);
    // 段二:远端执行边(实现帧,declaration-contract,进程内本地执行)
    expect(link!.execEdge.fromNodeId).toBe(link!.rpcNode.id);
    expect(link!.execEdge.toNodeId).toBe(link!.implNode.id);
    expect(link!.execEdge.syncAsync).toBe('sync');
    expect(link!.execEdge.messageKind).toBe('rpc');
    expect(link!.execEdge.callSite).toBeNull();
    expect(link!.execEdge.evidence.type).toBe('declaration-contract');
    expect(link!.execEdge.evidence.detail).toContain('Avatar.def:21');
    expect(link!.execEdge.evidence.detail).toContain(CELL_AVATAR);
    // rpc 声明节点:def 声明位置回填
    expect(link!.rpcNode.declaration).toEqual({
      file: '/ws/entity_defs/Avatar.def',
      line: 21,
      character: 0
    });
    // 实现帧:cell 面 Avatar.doMove
    expect(link!.implNode.fn?.filePath).toBe(CELL_AVATAR);
    expect(link!.implNode.entity?.name).toBe('Avatar');
    expect(link!.callerEntity).toBe('Avatar');
  });

  it('base→client 回调同样两段连线(实现=client 脚本)', () => {
    const result = buildRpcLinks(input());
    const link = result.links.find(l => l.sendEdge.callSite?.line === 3);
    expect(link).toBeDefined();
    expect(link!.execEdge.evidence.detail).toContain('ClientMethods');
    expect(link!.implNode.fn?.filePath).toBe(CLIENT_AVATAR);
    expect(link!.execEdge.direction.fromRole).toBe('client');
  });

  it('同一实现多发送边:实现节点单节点多边(协议身份合并)', () => {
    const fileMap = {
      ...FILES,
      [BASE_AVATAR]: [
        'class Avatar:',
        '    def requestMove(self, d):',
        '        self.cell.doMove(d)',
        '',
        '    def again(self):',
        '        self.cell.doMove(2)'
      ].join('\n')
    };
    const result = buildRpcLinks(input({}, fileMap));
    const doMoveLinks = result.links.filter(l => l.sendEdge.callSite?.file === BASE_AVATAR);
    expect(doMoveLinks).toHaveLength(2);
    expect(doMoveLinks[0].implNode.id).toBe(doMoveLinks[1].implNode.id);
    expect(doMoveLinks[0].sendEdge.id).not.toBe(doMoveLinks[1].sendEdge.id);
  });

  it('继承实现:实现节点可达,证据标注继承来源(S5 反题)', () => {
    const result = buildRpcLinks(input());
    const link = result.links.find(l => l.callerEntity === 'NPC');
    expect(link).toBeDefined();
    expect(link!.sendEdge.callSite?.line).toBe(3);
    expect(link!.implNode.fn?.filePath).toBe(BASE_AVATAR);
    expect(link!.implNode.label).toContain('继承自 Avatar');
    expect(link!.execEdge.evidence.detail).toContain('(继承自 Avatar)');
    expect(link!.rpcNode.declaration?.file).toBe('/ws/entity_defs/NPC.def');
    expect(link!.rpcNode.declaration?.line).toBe(9);
  });
});

describe('FLOW-007 诚实落点', () => {
  it('引擎引用发送(entities.get 落点):unresolved unknown-receiver,不猜实体', () => {
    const result = buildRpcLinks(input());
    const record = result.unresolvedLinks.find(l => l.detail.includes('落点实体未知'));
    expect(record).toBeDefined();
    expect(record!.code).toBe('unknown-receiver');
    expect(record!.sendEdge.callSite?.file).toBe(CELL_AVATAR);
    expect(record!.sendEdge.callSite?.line).toBe(6);
    // 发送边保留;执行侧是未解析边(带原因)
    expect(record!.execUnresolvedEdge.messageKind).toBe('unresolved');
    expect(record!.execUnresolvedEdge.unresolvedReason?.code).toBe('unknown-receiver');
    // 不产生实现连线
    expect(result.links.find(l => l.sendEdge.toNodeId === record!.sendEdge.toNodeId)).toBeUndefined();
  });

  it('def 未声明:missing-declaration,python 同名实现也不连线', () => {
    const fileMap = {
      ...FILES,
      // def 无但 impl 有的形态:
      [CELL_NPC]: [
        'class NPC:',
        '    def stalk(self):',
        '        self.base.shadowStep()'
      ].join('\n')
    };
    const implRegistry = {
      ...IMPL_REGISTRY,
      'NPC\u001fCellMethods\u001fshadowStep': { filePath: CELL_NPC, line: 4, signature: 'def shadowStep(self)', className: 'NPC' }
    };
    const result = buildRpcLinks(input({
      resolveImplementation: (entity, section, methodName) =>
        implRegistry[`${entity}\u001f${section}\u001f${methodName}`] ?? null
    }, fileMap));
    const record = result.unresolvedLinks.find(l => l.detail.includes('shadowStep'));
    expect(record).toBeDefined();
    expect(record!.code).toBe('missing-declaration');
    expect(record!.detail).toContain('按 def 方法索引派发');
  });

  it('def 已声明但实现缺失:missing-declaration', () => {
    const fileMap = {
      ...FILES,
      [CELL_NPC]: [
        'class NPC:',
        '    def stalk(self):',
        '        self.base.vanish()'
      ].join('\n')
    };
    const defRegistry = {
      ...DEF_REGISTRY,
      'NPC\u001fBaseMethods\u001fvanish': { defFile: '/ws/entity_defs/NPC.def', line: 12 }
    };
    const result = buildRpcLinks(input({
      resolveDefMethod: (entity, section, methodName) =>
        defRegistry[`${entity}\u001f${section}\u001f${methodName}`] ?? null
    }, fileMap));
    const record = result.unresolvedLinks.find(l => l.detail.includes('vanish'));
    expect(record).toBeDefined();
    expect(record!.code).toBe('missing-declaration');
    expect(record!.detail).toContain('全 owner 链未找到');
    expect(record!.execUnresolvedEdge.evidence.detail).toContain('NPC.def:12');
  });

  it('face-invalid 发送不进链接面(解析层已拦)', () => {
    const result = buildRpcLinks(input());
    // base 面 self.base.onBaseDone() 是非法组合(base.base)
    const allEdges = [...result.links.map(l => l.sendEdge), ...result.unresolvedLinks.map(l => l.sendEdge)];
    expect(allEdges.find(edge => edge.callSite?.line === 4)).toBeUndefined();
  });
});
