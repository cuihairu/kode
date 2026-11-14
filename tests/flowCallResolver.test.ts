import { describe, expect, it } from 'vitest';
import {
  callerFaceFromFilePath,
  resolveFlowCallSites,
  type FlowCallResolverInput,
  type FlowCallResolverResult
} from '../src/backend/flowCallResolver';
import type { FlowGraphEdge, FlowGraphNode } from '../src/backend/flowGraphModel';

// FLOW-004(旧 KFLOW-CORE-04)本地函数调用解析钉。
// 验收:解析直接函数、self 方法、导入和可证明接收者;输出真实调用点及声明,
// 不以方法名全局匹配。样本形态承 FLOW-001 失败账本(S1 裸名/导入、S2 动态
// 实体引用、S3 九面闸、S5 封闭类方法表)。

const ROOT = '/ws';

function resolve(input: Omit<FlowCallResolverInput, 'rootKey'>): FlowCallResolverResult {
  return resolveFlowCallSites({ ...input, rootKey: ROOT });
}

function nodeOf(result: FlowCallResolverResult, id: string): FlowGraphNode | undefined {
  return result.nodes.find(node => node.id === id);
}

function edgesAt(result: FlowCallResolverResult, line: number): FlowGraphEdge[] {
  return result.edges.filter(edge => edge.callSite?.line === line);
}

describe('FLOW-004 直接函数解析', () => {
  it('文件内顶层函数:裸名调用解析到声明,调用点与 caller 帧齐备', () => {
    const text = [
      'def clamp_pos(d):',
      '    return d',
      '',
      'def do_move(d):',
      '    clamp_pos(d)'
    ].join('\n');
    const result = resolve({ text, filePath: '/ws/scripts/cell/avatar.py', callerFace: 'cell' });
    const edges = edgesAt(result, 4);
    expect(edges).toHaveLength(1);
    const edge = edges[0];
    // 调用点:开括号行 + 裸名列(0 基)
    expect(edge.callSite).toEqual({
      file: '/ws/scripts/cell/avatar.py',
      line: 4,
      character: 4
    });
    expect(edge.messageKind).toBe('local-call');
    expect(edge.syncAsync).toBe('sync');
    // 声明:目标节点带真实声明位置
    const target = nodeOf(result, edge.toNodeId);
    expect(target?.fn?.name).toBe('clamp_pos');
    expect(target?.declaration).toEqual({
      file: '/ws/scripts/cell/avatar.py',
      line: 0,
      character: 4
    });
    // caller 是真实调用帧(do_move),不是占位 id
    const caller = nodeOf(result, edge.fromNodeId);
    expect(caller?.fn?.name).toBe('do_move');
    expect(caller?.entity).toBeNull();
  });

  it('同一函数两个调用点 = 两条边(不压成一个帧)', () => {
    const text = [
      'def helper():',
      '    pass',
      '',
      'def main():',
      '    helper()',
      '    helper()'
    ].join('\n');
    const result = resolve({ text, filePath: '/ws/scripts/base/world.py', callerFace: 'base' });
    const edges = [...edgesAt(result, 4), ...edgesAt(result, 5)];
    expect(edges).toHaveLength(2);
    expect(new Set(edges.map(edge => edge.id)).size).toBe(2);
    expect(edges[0].toNodeId).toBe(edges[1].toNodeId);
  });
});

describe('FLOW-004 self 方法:封闭类方法表,不全局同名匹配', () => {
  const text = [
    'class A:',
    '    def patrol(self):',
    '        pass',
    '',
    '    def go(self):',
    '        self.patrol()',
    '',
    'class B:',
    '    def patrol(self):',
    '        pass',
    '',
    '    def go(self):',
    '        self.patrol()'
  ].join('\n');

  it('同类同名:每类的 self.patrol() 只绑本类方法', () => {
    const result = resolve({ text, filePath: '/ws/scripts/cell/guards.py', callerFace: 'cell' });
    const edgeA = edgesAt(result, 5)[0];
    const edgeB = edgesAt(result, 12)[0];
    expect(edgeA).toBeDefined();
    expect(edgeB).toBeDefined();
    const targetA = nodeOf(result, edgeA.toNodeId);
    const targetB = nodeOf(result, edgeB.toNodeId);
    expect(targetA?.entity?.name).toBe('A');
    expect(targetB?.entity?.name).toBe('B');
    expect(edgeA.toNodeId).not.toBe(edgeB.toNodeId);
    // 声明行:各自类内的 def 行(0 基)
    expect(targetA?.declaration?.line).toBe(1);
    expect(targetB?.declaration?.line).toBe(8);
  });

  it('类表缺名 = missing-declaration,不猜其他类的同名方法', () => {
    const text2 = [
      'class A:',
      '    def patrol(self):',
      '        pass',
      '',
      'class C:',
      '    def run(self):',
      '        self.patrol()'
    ].join('\n');
    const result = resolve({ text: text2, filePath: '/ws/scripts/cell/guards.py', callerFace: 'cell' });
    const edge = edgesAt(result, 6)[0];
    expect(edge.messageKind).toBe('unresolved');
    expect(edge.unresolvedReason?.code).toBe('missing-declaration');
    const target = nodeOf(result, edge.toNodeId);
    expect(target?.kind).toBe('unresolved');
  });

  it('模块顶层函数里的 self 调用:无类域,如实 unknown-receiver', () => {
    const text2 = [
      'def weird(self):',
      '    self.ghost()'
    ].join('\n');
    const result = resolve({ text: text2, filePath: '/ws/scripts/cell/guards.py', callerFace: 'cell' });
    const edge = edgesAt(result, 1)[0];
    expect(edge.unresolvedReason?.code).toBe('unknown-receiver');
  });
});

describe('FLOW-004 导入解析', () => {
  const text = [
    'from nav_helpers import clamp_pos',
    '',
    'def run(d):',
    '    clamp_pos(d)'
  ].join('\n');

  it('带解析回调:导入函数解析到外部声明位置', () => {
    const result = resolve({
      text,
      filePath: '/ws/scripts/cell/avatar.py',
      callerFace: 'cell',
      resolveImportedFunction: (module, name) =>
        module === 'nav_helpers' && name === 'clamp_pos'
          ? { filePath: '/ws/scripts/cell/nav_helpers.py', line: 4 }
          : null
    });
    const edge = edgesAt(result, 3)[0];
    expect(edge.messageKind).toBe('local-call');
    const target = nodeOf(result, edge.toNodeId);
    expect(target?.fn?.name).toBe('clamp_pos');
    expect(target?.fn?.filePath).toBe('/ws/scripts/cell/nav_helpers.py');
    expect(target?.declaration?.line).toBe(4);
  });

  it('无解析回调:如实 third-party-function,不猜实现位置', () => {
    const result = resolve({ text, filePath: '/ws/scripts/cell/avatar.py', callerFace: 'cell' });
    const edge = edgesAt(result, 3)[0];
    expect(edge.messageKind).toBe('unresolved');
    expect(edge.unresolvedReason?.code).toBe('third-party-function');
    expect(edge.unresolvedReason?.detail).toContain('nav_helpers');
  });
});

describe('FLOW-004 九面闸(S3 回归)', () => {
  const text = [
    'class Avatar:',
    '    def requestMove(self, d):',
    '        self.base.onMoveDone()',
    '        self.cell.doMove(d)'
  ].join('\n');

  it('base 面 self.base.X():非法组合 → face-invalid-receiver,不画合法边', () => {
    const result = resolve({ text, filePath: '/ws/scripts/base/avatar.py', callerFace: 'base' });
    const edge = edgesAt(result, 2)[0];
    expect(edge.messageKind).toBe('unresolved');
    expect(edge.unresolvedReason?.code).toBe('face-invalid-receiver');
    expect(edge.direction.kind).toBe('cross-process');
    const target = nodeOf(result, edge.toNodeId);
    expect(target?.kind).toBe('unresolved');
    // 原因码在节点身份与标签(协议不设 node.unresolvedCode 字段,边带 reason)
    expect(target?.label).toContain('face-invalid-receiver');
  });

  it('base 面 self.cell.X():合法 → rpc 异步发送边到声明节点(实现归 FLOW-007)', () => {
    const result = resolve({ text, filePath: '/ws/scripts/base/avatar.py', callerFace: 'base' });
    const edge = edgesAt(result, 3)[0];
    expect(edge.messageKind).toBe('rpc');
    expect(edge.syncAsync).toBe('async-send');
    expect(edge.direction).toEqual({ fromRole: 'base', toRole: 'cell', kind: 'cross-process' });
    expect(edge.unresolvedReason).toBeNull();
    const target = nodeOf(result, edge.toNodeId);
    expect(target?.kind).toBe('rpc-declaration');
    expect(target?.role).toBe('cell');
    expect(target?.fn?.name).toBe('doMove');
    // 跨进程不画成同步 Python 子栈:非 sync local-call
    expect(edge.syncAsync).not.toBe('sync');
  });

  it('cell 面:self.base 合法(rpc),self.cell 自身面属性非法', () => {
    const result = resolve({ text, filePath: '/ws/scripts/cell/avatar.py', callerFace: 'cell' });
    const toBase = edgesAt(result, 2)[0];
    const toSelf = edgesAt(result, 3)[0];
    // cell 面有 .base:合法发送边
    expect(toBase.messageKind).toBe('rpc');
    expect(nodeOf(result, toBase.toNodeId)?.role).toBe('base');
    // cell.cell 非法(AttributeError 组合)
    expect(toSelf.messageKind).toBe('unresolved');
    expect(toSelf.unresolvedReason?.code).toBe('face-invalid-receiver');
  });
});

describe('FLOW-004 可证明接收者(赋值链)', () => {
  const text = [
    'class Guard:',
    '    def patrol(self):',
    '        pass',
    '',
    'class World:',
    '    def spawn(self):',
    '        g = Guard()',
    '        g.patrol()',
    '        g.missing()'
  ].join('\n');

  it('构造调用赋值:接收者定型到该类方法表(非全局同名)', () => {
    const result = resolve({ text, filePath: '/ws/scripts/cell/world.py', callerFace: 'cell' });
    const edge = edgesAt(result, 7)[0];
    expect(edge.messageKind).toBe('local-call');
    const target = nodeOf(result, edge.toNodeId);
    expect(target?.entity?.name).toBe('Guard');
    expect(target?.fn?.name).toBe('patrol');
    expect(target?.declaration?.line).toBe(1);
  });

  it('类表缺名 = missing-declaration', () => {
    const result = resolve({ text, filePath: '/ws/scripts/cell/world.py', callerFace: 'cell' });
    const edge = edgesAt(result, 8)[0];
    expect(edge.messageKind).toBe('unresolved');
    expect(edge.unresolvedReason?.code).toBe('missing-declaration');
  });

  it('别名链有界跟随:g2 = g → Guard.patrol', () => {
    const text2 = [
      'class Guard:',
      '    def patrol(self):',
      '        pass',
      '',
      'class World:',
      '    def spawn(self):',
      '        g = Guard()',
      '        g2 = g',
      '        g2.patrol()'
    ].join('\n');
    const result = resolve({ text: text2, filePath: '/ws/scripts/cell/world.py', callerFace: 'cell' });
    const edge = edgesAt(result, 8)[0];
    expect(edge.messageKind).toBe('local-call');
    expect(nodeOf(result, edge.toNodeId)?.entity?.name).toBe('Guard');
  });

  it('参数/无绑定接收者:unknown-receiver,不猜', () => {
    const text2 = [
      'class A:',
      '    def run(self, obj):',
      '        obj.doThing()'
    ].join('\n');
    const result = resolve({ text: text2, filePath: '/ws/scripts/cell/a.py', callerFace: 'cell' });
    const edge = edgesAt(result, 2)[0];
    expect(edge.messageKind).toBe('unresolved');
    expect(edge.unresolvedReason?.code).toBe('unknown-receiver');
  });
});

describe('FLOW-004 动态实体引用(S2 回归)', () => {
  const text = [
    'class Avatar:',
    '    def doMove(self, d):',
    '        found = KBEngine.entities.get(101)',
    '        found.cell.halt()'
  ].join('\n');

  it('entities.get 结果的角色化调用:rpc 发送边 + 落点实体未知如实记录', () => {
    const result = resolve({ text, filePath: '/ws/scripts/cell/avatar.py', callerFace: 'cell' });
    const edge = edgesAt(result, 3)[0];
    expect(edge.messageKind).toBe('rpc');
    expect(edge.syncAsync).toBe('async-send');
    expect(edge.direction.kind).toBe('cross-process');
    expect(edge.unresolvedReason?.code).toBe('unknown-receiver');
    expect(edge.unresolvedReason?.detail).toContain('entities.get');
    const target = nodeOf(result, edge.toNodeId);
    expect(target?.kind).toBe('rpc-declaration');
    expect(target?.fn?.name).toBe('halt');
  });

  it('引擎 API 自身(entities.get 调用):native 面,不进静态树', () => {
    const result = resolve({ text, filePath: '/ws/scripts/cell/avatar.py', callerFace: 'cell' });
    const edge = edgesAt(result, 2)[0];
    expect(edge.messageKind).toBe('unresolved');
    expect(edge.unresolvedReason?.code).toBe('native-function');
  });
});

describe('FLOW-004 内建与词法掩码', () => {
  it('内建函数:native-function 如实未解析,不造帧', () => {
    const text = [
      'def main():',
      '    n = len([1, 2])'
    ].join('\n');
    const result = resolve({ text, filePath: '/ws/scripts/base/m.py', callerFace: 'base' });
    const edge = edgesAt(result, 1)[0];
    expect(edge.unresolvedReason?.code).toBe('native-function');
    // 内建不做类构造绑定
    expect(result.edges.filter(e => e.messageKind === 'local-call')).toHaveLength(0);
  });

  it('注释/字符串伪调用被掩码剔除,只剩真实调用点', () => {
    const text = [
      'class A:',
      '    def run(self):',
      '        s = "ghost()"',
      '        # ghost()',
      '        ghost()'
    ].join('\n');
    const result = resolve({ text, filePath: '/ws/scripts/cell/a.py', callerFace: 'cell' });
    // 字符串行(2)/注释行(3)零调用边;真实调用行(4)恰好一条
    expect(edgesAt(result, 2)).toHaveLength(0);
    expect(edgesAt(result, 3)).toHaveLength(0);
    const real = edgesAt(result, 4);
    expect(real).toHaveLength(1);
    expect(real[0].unresolvedReason?.code).toBe('third-party-function');
    // def 头行不产幻影自环(def run 的 'run(' 不是调用)
    expect(edgesAt(result, 1)).toHaveLength(0);
  });
});

describe('FLOW-004 调用面推导', () => {
  it('scripts/<base|cell|client|bots>/ 布局 → 面;其余 null', () => {
    expect(callerFaceFromFilePath('/ws/scripts/base/Avatar.py')).toBe('base');
    expect(callerFaceFromFilePath('/ws/scripts/cell/Avatar.py')).toBe('cell');
    expect(callerFaceFromFilePath('/ws/scripts/client/Avatar.py')).toBe('client');
    expect(callerFaceFromFilePath('/ws/scripts/bots/main.py')).toBe('client');
    expect(callerFaceFromFilePath('/ws/entity_defs/Avatar.def')).toBeNull();
    expect(callerFaceFromFilePath('/other/Avatar.py')).toBeNull();
  });
});
