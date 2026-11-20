import { describe, expect, it } from 'vitest';
import { resolveFlowCallSites } from '../src/backend/flowCallResolver';
import {
  expandFlowCallTree,
  type FlowExpansionInput
} from '../src/backend/flowCallExpansion';
import {
  flowGraphEdge,
  flowGraphNode,
  type FlowGraphEdge,
  type FlowGraphNode,
  type FlowSourceLocation
} from '../src/backend/flowGraphModel';

// FLOW-005(旧 KFLOW-CORE-05)本地调用树展开钉。
// 验收:入口向下/调用者向上、分支条件、递归环和深度截断;同一函数多次
// 调用保留调用点,不压成一个帧。夹具 = FLOW-001 真实形态(cell 脚本移动链
// + 跨文件 helper + 模块入口函数)。
//
// 诚实边界(逐行不可达论证):
//   - 161 `if (!node) continue;`(下游帧取图失败)= 防御臂,不可达。
//     唯一入栈的两种帧都先入图再入栈:根帧 126 addNode(rootNode)、
//     目标帧 191 addNode(target) 后 204 才 push;graphNodes 是模块内
//     局部 Map 只增不删(无 delete/clear),frame.nodeId 出栈时必在。
//     公共入口无路径触发,不硬凑(空账测试)。

const AVATAR_PY = '/ws/scripts/cell/avatar.py';
const HELPERS_PY = '/ws/scripts/cell/nav_helpers.py';

const FILES: Record<string, string> = {
  [AVATAR_PY]: [
    'from nav_helpers import clamp_pos',
    '',
    'class Avatar:',
    '    def doMove(self, d):',
    '        self.step(d)',
    '        if d > 0:',
    '            self.step(d)',
    '        self.finish()',
    '',
    '    def step(self, d):',
    '        clamp_pos(d)',
    '',
    '    def finish(self):',
    '        pass',
    '',
    'def entry(d):',
    '    a = Avatar()',
    '    a.doMove(d)',
    '    a.doMove(d + 1)'
  ].join('\n'),
  [HELPERS_PY]: [
    'def clamp_pos(d):',
    '    trim(d)',
    '',
    'def trim(d):',
    '    pass'
  ].join('\n')
};

function makeResolver(files: Record<string, string>) {
  return (filePath: string) => {
    const text = files[filePath];
    if (text === undefined) {
      return null;
    }
    return resolveFlowCallSites({
      text,
      filePath,
      resolveImportedFunction: (module, name) =>
        module === 'nav_helpers' && name === 'clamp_pos'
          ? { filePath: HELPERS_PY, line: 0 }
          : null
    });
  };
}

function expand(
  overrides: Partial<FlowExpansionInput>
): ReturnType<typeof expandFlowCallTree> {
  const root = overrides.root ?? {
    filePath: AVATAR_PY,
    className: 'Avatar',
    functionName: 'doMove'
  };
  const fileSet = overrides.files ?? FILES;
  return expandFlowCallTree({
    root,
    direction: overrides.direction ?? 'downstream',
    maxDepth: overrides.maxDepth ?? 16,
    files: Object.keys(fileSet),
    resolveFile: overrides.resolveFile ?? makeResolver(fileSet)
  });
}

const nodeOf = (result: ReturnType<typeof expandFlowCallTree>, id: string) =>
  result.graph.nodes.find(node => node.id === id);

describe('FLOW-005 入口向下展开', () => {
  it('跨文件链全展开:doMove→step→clamp_pos(nav_helpers)→trim', () => {
    const result = expand({});
    const names = new Set(
      result.graph.nodes.map(node => node.fn?.name ?? node.label)
    );
    expect(names).toContain('doMove');
    expect(names).toContain('step');
    expect(names).toContain('finish');
    expect(names).toContain('clamp_pos');
    expect(names).toContain('trim');
    expect(result.graph.query.kind).toBe('downstream');
    expect(result.graph.query.truncatedAtDepth).toBeNull();
  });

  it('同一函数多次调用保留调用点:doMove→step 两条边两个调用点', () => {
    const result = expand({});
    const stepEdges = result.graph.edges.filter(edge => {
      const target = nodeOf(result, edge.toNodeId);
      return target?.fn?.name === 'step';
    });
    expect(stepEdges).toHaveLength(2);
    expect(new Set(stepEdges.map(edge => edge.id)).size).toBe(2);
    expect(stepEdges[0].callSite?.line).not.toBe(stepEdges[1].callSite?.line);
  });

  it('分支条件候选:if 块内调用边带 condition(if-branch),块外为 null', () => {
    const result = expand({});
    const stepEdges = result.graph.edges.filter(edge => {
      const target = nodeOf(result, edge.toNodeId);
      return target?.fn?.name === 'step';
    });
    const conditioned = stepEdges.filter(edge => edge.condition !== null);
    expect(conditioned).toHaveLength(1);
    expect(conditioned[0].condition?.text).toBe('d > 0');
    expect(conditioned[0].condition?.kind).toBe('if-branch');
    expect(conditioned[0].callSite?.line).toBe(6);
  });

  it('菱形汇合不重复展开,但每条调用边都保留', () => {
    const result = expand({});
    const expandedNames = result.graph.nodes
      .filter(node => node.kind === 'function')
      .map(node => node.fn?.name);
    // step 只展开一次(节点唯一),但两条入边都在
    expect(expandedNames.filter(name => name === 'step')).toHaveLength(1);
  });
});

describe('FLOW-005 递归环', () => {
  it('自递归:回边标 recursion,不无限展开', () => {
    const files = {
      [AVATAR_PY]: [
        'class A:',
        '    def loop(self, n):',
        '        self.loop(n - 1)',
        '        self.stop()',
        '    def stop(self):',
        '        pass'
      ].join('\n')
    };
    const result = expand({ files, root: { filePath: AVATAR_PY, className: 'A', functionName: 'loop' } });
    expect(result.recursionEdgeCount).toBe(1);
    const loopEdges = result.graph.edges;
    expect(loopEdges).toHaveLength(2);
    const recursionEdge = loopEdges.find(edge => edge.unresolvedReason?.code === 'recursion');
    expect(recursionEdge).toBeDefined();
    expect(recursionEdge?.messageKind).toBe('local-call');
    expect(nodeOf(result, recursionEdge!.toNodeId)?.fn?.name).toBe('loop');
    // 非环边照常
    const stopEdge = loopEdges.find(edge => {
      const target = nodeOf(result, edge.toNodeId);
      return target?.fn?.name === 'stop';
    });
    expect(stopEdge?.unresolvedReason).toBeNull();
  });

  it('间接递归:a→b→a 环在 b 的展开处截标', () => {
    const files = {
      [AVATAR_PY]: [
        'class A:',
        '    def ping(self, n):',
        '        self.pong(n)',
        '    def pong(self, n):',
        '        self.ping(n)'
      ].join('\n')
    };
    const result = expand({ files, root: { filePath: AVATAR_PY, className: 'A', functionName: 'ping' } });
    expect(result.recursionEdgeCount).toBe(1);
    const names = result.graph.nodes.map(node => node.fn?.name);
    expect(names).toContain('pong');
  });
});

describe('FLOW-005 深度截断', () => {
  it('达 maxDepth 不再下钻,出边与目标节点照常入图,truncatedAtDepth 如实', () => {
    const files = {
      [AVATAR_PY]: [
        'def f0():',
        '    f1()',
        '',
        'def f1():',
        '    f2()',
        '',
        'def f2():',
        '    f3()',
        '',
        'def f3():',
        '    pass'
      ].join('\n')
    };
    const result = expand({ files, root: { filePath: AVATAR_PY, className: null, functionName: 'f0' }, maxDepth: 2 });
    expect(result.graph.query.truncatedAtDepth).toBe(2);
    const names = new Set(result.graph.nodes.map(node => node.fn?.name));
    // 边界帧 f2 的出边与 f3 节点在图(事实),但 f3 未下钻(无 f3 的出边)
    expect(names).toContain('f3');
    const f3Outgoing = result.graph.edges.filter(edge => {
      const source = nodeOf(result, edge.fromNodeId);
      return source?.fn?.name === 'f3';
    });
    expect(f3Outgoing).toHaveLength(0);
  });
});

describe('FLOW-005 调用者向上展开', () => {
  it('上游链:doMove 的调用者 = entry(两个调用点两条边,upstream-caller)', () => {
    const result = expand({
      direction: 'upstream',
      root: { filePath: AVATAR_PY, className: 'Avatar', functionName: 'doMove' }
    });
    expect(result.graph.query.kind).toBe('upstream');
    const callerEdges = result.graph.edges.filter(edge => edge.fromNodeId !== result.graph.query.rootNodeId);
    expect(callerEdges).toHaveLength(2);
    for (const edge of callerEdges) {
      expect(edge.direction.kind).toBe('upstream-caller');
      const caller = nodeOf(result, edge.fromNodeId);
      expect(caller?.fn?.name).toBe('entry');
      expect(edge.callSite?.file).toBe(AVATAR_PY);
    }
    // 调用方向语义不变:from=caller
    expect(callerEdges[0].callSite?.line).not.toBe(callerEdges[1].callSite?.line);
    // entry 无更上游,链到此为止
    expect(result.graph.nodes.map(node => node.fn?.name)).toEqual(
      expect.arrayContaining(['entry', 'doMove'])
    );
  });

  it('跨文件上游:clamp_pos 的调用者在 avatar.py(step)', () => {
    const result = expand({
      direction: 'upstream',
      root: { filePath: HELPERS_PY, className: null, functionName: 'clamp_pos' }
    });
    // 上游展开走完整调用者闭包:step→doMove→entry 全链入图
    const callerEdges = result.graph.edges.filter(
      edge => edge.direction.kind === 'upstream-caller'
    );
    expect(callerEdges).toHaveLength(5);
    // clamp_pos 的直接调用者(step)经 toNodeId=根 过滤
    const direct = callerEdges.filter(edge => edge.toNodeId === result.graph.query.rootNodeId);
    expect(direct).toHaveLength(1);
    const caller = nodeOf(result, direct[0].fromNodeId);
    expect(caller?.fn?.name).toBe('step');
    expect(caller?.entity?.name).toBe('Avatar');
    expect(direct[0].callSite?.line).toBe(10);
    const names = result.graph.nodes.map(node => node.fn?.name);
    expect(names).toEqual(expect.arrayContaining(['entry', 'doMove', 'step']));
  });

  it('上游递归:ping↔pong 调用者链回标 recursion', () => {
    const files = {
      [AVATAR_PY]: [
        'class A:',
        '    def ping(self, n):',
        '        self.pong(n)',
        '    def pong(self, n):',
        '        self.ping(n)'
      ].join('\n')
    };
    const result = expand({
      files,
      direction: 'upstream',
      root: { filePath: AVATAR_PY, className: 'A', functionName: 'ping' }
    });
    expect(result.recursionEdgeCount).toBe(1);
  });
});

describe('FLOW-005 边界', () => {
  it('根函数不存在:明确报错,不静默空图', () => {
    expect(() =>
      expand({ root: { filePath: AVATAR_PY, className: 'Avatar', functionName: 'nope' } })
    ).toThrow(/root function not found/);
  });

  it('rpc-declaration/unresolved 目标是死端:入图但不展开', () => {
    const files = {
      [AVATAR_PY]: [
        'class Avatar:',
        '    def send(self):',
        '        self.base.remoteCall()',
        '        self.missingThing()'
      ].join('\n')
    };
    const result = expand({
      files,
      root: { filePath: AVATAR_PY, className: 'Avatar', functionName: 'send' }
    });
    const kinds = new Set(result.graph.nodes.map(node => node.kind));
    expect(kinds).toContain('rpc-declaration');
    expect(kinds).toContain('unresolved');
    // 死端:无以它们为源的展开边
    const expandedFromDeadEnds = result.graph.edges.filter(edge => {
      const source = nodeOf(result, edge.fromNodeId);
      return source?.kind === 'rpc-declaration' || source?.kind === 'unresolved';
    });
    expect(expandedFromDeadEnds).toHaveLength(0);
  });
});

describe('FLOW-005 展开边界:根定位与汇合', () => {
  it('根文件读不到:明确报错,不静默空图', () => {
    expect(() =>
      expand({
        root: { filePath: '/ws/scripts/cell/ghost.py', className: null, functionName: 'doMove' }
      })
    ).toThrow(/root file not resolvable/);
  });

  it('导入指向读不到的实现文件:调用帧照常入图但不展开(不猜内容)', () => {
    // files 域不含 nav_helpers.py:clamp_pos 帧经导入解析入图,但其声明
    // 文件读不到 → 帧的出边无从取得,如实停在该帧(trim 不入图)
    const files = { [AVATAR_PY]: FILES[AVATAR_PY] };
    const result = expand({
      files,
      root: { filePath: AVATAR_PY, className: 'Avatar', functionName: 'step' }
    });
    const names = result.graph.nodes.map(node => node.fn?.name);
    expect(names).toContain('clamp_pos');
    expect(names).not.toContain('trim');
    // step→clamp_pos 边照常入图(事实),截断不虚报
    expect(result.graph.query.truncatedAtDepth).toBeNull();
    expect(result.expandedNodeCount).toBe(2);
  });

  it('菱形汇合:已展开目标不重复入栈,但每条调用边都保留', () => {
    const files = {
      [AVATAR_PY]: [
        'def f0():',
        '    f1()',
        '    f2()',
        '',
        'def f1():',
        '    f3()',
        '',
        'def f2():',
        '    f3()',
        '',
        'def f3():',
        '    pass'
      ].join('\n')
    };
    const result = expand({ files, root: { filePath: AVATAR_PY, className: null, functionName: 'f0' } });
    expect(result.recursionEdgeCount).toBe(0);
    expect(result.graph.query.truncatedAtDepth).toBeNull();
    const f3 = result.graph.nodes.find(node => node.fn?.name === 'f3');
    const f3In = result.graph.edges.filter(edge => edge.toNodeId === f3?.id);
    expect(f3In).toHaveLength(2); // f1→f3 与 f2→f3 都在
    expect(result.expandedNodeCount).toBe(4); // f0/f2/f3/f1 各展开一次
  });
});

describe('FLOW-005 调用者向上:扫描域与截断', () => {
  const GHOST_PY = '/ws/scripts/cell/ghost.py';

  it('扫描域含读不到的文件:如实跳过,不炸不猜', () => {
    const files = {
      [AVATAR_PY]: [
        'def r():',
        '    pass',
        '',
        'def c1():',
        '    r()',
        '',
        'def d():',
        '    c1()'
      ].join('\n')
    };
    // 登记域带一个读不到的文件:反向索引构建时跳过,已登记文件的链不受影响
    const filesWithGhost = {
      ...files,
      [GHOST_PY]: undefined as unknown as string
    };
    const result = expand({
      direction: 'upstream',
      files: filesWithGhost,
      root: { filePath: AVATAR_PY, className: null, functionName: 'r' }
    });
    const callerEdges = result.graph.edges.filter(
      edge => edge.direction.kind === 'upstream-caller'
    );
    expect(callerEdges).toHaveLength(2); // c1→r 与 d→c1
    const names = result.graph.nodes.map(node => node.fn?.name);
    expect(names).toEqual(expect.arrayContaining(['r', 'c1', 'd']));
    expect(result.expandedNodeCount).toBe(3);
  });

  it('达 maxDepth:truncatedAtDepth 如实记录,调用者边仍入图但不再上钻', () => {
    const result = expand({
      direction: 'upstream',
      maxDepth: 0,
      root: { filePath: AVATAR_PY, className: 'Avatar', functionName: 'doMove' }
    });
    expect(result.graph.query.truncatedAtDepth).toBe(0);
    expect(result.expandedNodeCount).toBe(1); // 只根帧
    const callerEdges = result.graph.edges.filter(
      edge => edge.direction.kind === 'upstream-caller'
    );
    expect(callerEdges).toHaveLength(2); // entry 的两个调用点边仍入图
    const names = result.graph.nodes.map(node => node.fn?.name);
    expect(names).toEqual(expect.arrayContaining(['doMove', 'entry']));
  });

  it('上游菱形汇合:已展开调用者不重复入栈,但每条调用边都保留', () => {
    const files = {
      [AVATAR_PY]: [
        'def r():',
        '    pass',
        '',
        'def c1():',
        '    r()',
        '',
        'def c2():',
        '    r()',
        '',
        'def d():',
        '    c1()',
        '    c2()'
      ].join('\n')
    };
    const result = expand({
      direction: 'upstream',
      files,
      root: { filePath: AVATAR_PY, className: null, functionName: 'r' }
    });
    expect(result.recursionEdgeCount).toBe(0);
    expect(result.graph.query.truncatedAtDepth).toBeNull();
    // d 只展开一次,但 d→c1 与 d→c2 两条边都在
    const dEdges = result.graph.edges.filter(edge => {
      const from = nodeOf(result, edge.fromNodeId);
      return from?.fn?.name === 'd';
    });
    expect(dEdges).toHaveLength(2);
    expect(result.expandedNodeCount).toBe(4); // r/c2/d/c1 各展开一次
  });
});

describe('FLOW-005 协议形态臂(合成解析结果)', () => {
  /**
   * 解析核(FLOW-004)现行输出不产以下形态:「模块伪帧(无 fn 的 function
   * 节点)作被调帧」「边引用同结果节点表外的端点」「非函数节点作调用者」;
   * 但展开核按 FLOW-003 协议身份消费宿主解析结果(resolveFile 可来自任意
   * 宿主缓存,跨文件/跨进程接线在 FLOW-007/008),协议上这些形态合法。
   * 本块用协议构造器(flowGraphNode/flowGraphEdge)合成解析结果,钉住
   * 展开核对这些形态的既有语义:回捞/边入图节点不造/死端不展开。
   */

  const site = (file: string, line: number): FlowSourceLocation => ({ file, line, character: 0 });
  const dir = { fromRole: 'cell' as const, toRole: 'cell' as const, kind: 'downstream-call' as const };
  const evidence = { type: 'syntax-anchor' as const, detail: 'synthetic' };

  const pseudoNode = (): FlowGraphNode =>
    flowGraphNode({ rootKey: 't', role: 'cell', kind: 'function', label: '模块顶层' });
  const fnNode = (name: string, file: string): FlowGraphNode =>
    flowGraphNode({
      rootKey: 't',
      role: 'cell',
      kind: 'function',
      fn: { name, filePath: file, signature: `def ${name}()` },
      label: `候选帧 ${name}`
    });
  const edge = (from: string, to: string, file: string, line: number): FlowGraphEdge =>
    flowGraphEdge({
      fromNodeId: from,
      toNodeId: to,
      callSite: site(file, line),
      direction: dir,
      syncAsync: 'sync',
      messageKind: 'local-call',
      evidence
    });

  const A = '/ws/scripts/cell/syn_a.py';
  const B = '/ws/scripts/cell/syn_b.py';

  it('模块伪帧的出边按含其出边的文件回捞:跨合成文件展开', () => {
    const rootFn = fnNode('rootFn', A);
    const pseudo = pseudoNode();
    const fnB = fnNode('fnB', B);
    const leaf = fnNode('leaf', B);
    // A:rootFn 先调伪帧再调 fnB(fnB 后入栈先弹出 → B 先解析进 bundle 缓存,
    // 伪帧弹出时才能在已解析文件里回捞到自己的出边)
    const resolveFile: FlowExpansionInput['resolveFile'] = (filePath) => {
      if (filePath === A) {
        return {
          nodes: [rootFn, pseudo, fnB],
          edges: [edge(rootFn.id, pseudo.id, A, 1), edge(rootFn.id, fnB.id, A, 2)]
        };
      }
      if (filePath === B) {
        return { nodes: [fnB, leaf], edges: [edge(pseudo.id, leaf.id, B, 1)] };
      }
      return null;
    };
    const result = expandFlowCallTree({
      root: { filePath: A, className: null, functionName: 'rootFn' },
      direction: 'downstream',
      maxDepth: 8,
      files: [A, B],
      resolveFile
    });
    const labels = result.graph.nodes.map(node => node.label);
    expect(labels).toContain('模块顶层');
    expect(labels).toContain('候选帧 leaf');
    expect(result.graph.edges).toHaveLength(3); // rootFn→伪帧、rootFn→fnB、伪帧→leaf
    expect(result.expandedNodeCount).toBe(4);
    expect(result.graph.query.truncatedAtDepth).toBeNull();
  });

  it('模块伪帧的出边不在任何已解析文件:如实死端,边仍保留', () => {
    const rootFn = fnNode('rootFn', A);
    const pseudo = pseudoNode();
    const resolveFile: FlowExpansionInput['resolveFile'] = (filePath) => {
      if (filePath === A) {
        return { nodes: [rootFn, pseudo], edges: [edge(rootFn.id, pseudo.id, A, 1)] };
      }
      return null;
    };
    const result = expandFlowCallTree({
      root: { filePath: A, className: null, functionName: 'rootFn' },
      direction: 'downstream',
      maxDepth: 8,
      files: [A],
      resolveFile
    });
    // 伪帧入图入账(rootFn→伪帧边在),但无从取得出边 → 不下钻不虚报截断
    expect(result.graph.nodes.map(node => node.label)).toContain('模块顶层');
    expect(result.graph.edges).toHaveLength(1);
    expect(result.expandedNodeCount).toBe(2);
    expect(result.graph.query.truncatedAtDepth).toBeNull();
  });

  it('边引用同结果节点表外的目标:边如实入图,节点不造', () => {
    const rootFn = fnNode('rootFn', A);
    const ghostTarget = 'ghost-target-id';
    const resolveFile: FlowExpansionInput['resolveFile'] = (filePath) => {
      if (filePath === A) {
        return { nodes: [rootFn], edges: [edge(rootFn.id, ghostTarget, A, 1)] };
      }
      return null;
    };
    const result = expandFlowCallTree({
      root: { filePath: A, className: null, functionName: 'rootFn' },
      direction: 'downstream',
      maxDepth: 8,
      files: [A],
      resolveFile
    });
    expect(result.graph.edges).toHaveLength(1);
    expect(result.graph.edges[0].toNodeId).toBe(ghostTarget);
    expect(result.graph.nodes).toHaveLength(1); // 不为缺位目标造节点
  });

  it('上游:边引用同结果节点表外的调用者:边不渲染(调用者节点缺位)', () => {
    const rootFn = fnNode('rootFn', A);
    const ghostCaller = 'ghost-caller-id';
    const resolveFile: FlowExpansionInput['resolveFile'] = (filePath) => {
      if (filePath === A) {
        return { nodes: [rootFn], edges: [edge(ghostCaller, rootFn.id, A, 1)] };
      }
      return null;
    };
    const result = expandFlowCallTree({
      root: { filePath: A, className: null, functionName: 'rootFn' },
      direction: 'upstream',
      maxDepth: 8,
      files: [A],
      resolveFile
    });
    // 调用者节点缺位:上游视图不渲染这条边(区别于下游的边入图节点不造)
    expect(result.graph.edges).toHaveLength(0);
    expect(result.graph.nodes).toHaveLength(1);
    expect(result.expandedNodeCount).toBe(1);
  });

  it('上游:rpc-declaration 调用者是死端:节点与边入图,不再上钻', () => {
    const rootFn = fnNode('rootFn', A);
    const rpcDecl = flowGraphNode({
      rootKey: 't',
      role: 'client',
      kind: 'rpc-declaration',
      fn: { name: 'onX', filePath: 'pending-def:client', signature: '' },
      label: 'RPC 声明:onX(client)'
    });
    const crossEdge = flowGraphEdge({
      fromNodeId: rpcDecl.id,
      toNodeId: rootFn.id,
      callSite: site(A, 1),
      direction: { fromRole: 'client', toRole: 'cell', kind: 'cross-process' },
      syncAsync: 'async-send',
      messageKind: 'rpc',
      evidence
    });
    const resolveFile: FlowExpansionInput['resolveFile'] = (filePath) => {
      if (filePath === A) {
        return { nodes: [rootFn, rpcDecl], edges: [crossEdge] };
      }
      return null;
    };
    const result = expandFlowCallTree({
      root: { filePath: A, className: null, functionName: 'rootFn' },
      direction: 'upstream',
      maxDepth: 8,
      files: [A],
      resolveFile
    });
    expect(result.graph.nodes.map(node => node.label)).toContain(rpcDecl.label);
    expect(result.graph.edges).toHaveLength(1);
    // 调用方向语义不变,只是查询语境重标
    expect(result.graph.edges[0].direction).toEqual({
      fromRole: 'client',
      toRole: 'cell',
      kind: 'upstream-caller'
    });
    expect(result.expandedNodeCount).toBe(1); // 声明面死端:不再上钻
  });
});
