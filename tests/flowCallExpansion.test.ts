import { describe, expect, it } from 'vitest';
import { resolveFlowCallSites } from '../src/backend/flowCallResolver';
import {
  expandFlowCallTree,
  type FlowExpansionInput
} from '../src/backend/flowCallExpansion';

// FLOW-005(旧 KFLOW-CORE-05)本地调用树展开钉。
// 验收:入口向下/调用者向上、分支条件、递归环和深度截断;同一函数多次
// 调用保留调用点,不压成一个帧。夹具 = FLOW-001 真实形态(cell 脚本移动链
// + 跨文件 helper + 模块入口函数)。

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
