import { describe, expect, it } from 'vitest';
import { resolveFlowCallSites } from '../src/backend/flowCallResolver';
import { buildScenarioPath, type FlowScenarioInput } from '../src/backend/flowScenarioPath';

// FLOW-012(旧 KFLOW-CORE-12)业务场景路径钉。
// 验收:选定入口查询 Client→Base→Cell→Client 的本地帧和跨进程边;分支为
// 候选而非固定执行顺序。

const CLIENT_AVATAR = '/ws/scripts/client/Avatar.py';
const BASE_AVATAR = '/ws/scripts/base/Avatar.py';
const CELL_AVATAR = '/ws/scripts/cell/Avatar.py';

const CLIENT_TEXT = [
  'class Avatar:',
  '    def chooseRole(self):',
  '        self.base.requestMove(3)',
  '',
  '    def onMoveDone(self):',
  '        pass'
].join('\n');

const BASE_TEXT = [
  'class Avatar:',
  '    def requestMove(self, d):',
  '        if self.ready:',
  '            self.cell.doMove(d)'
].join('\n');

const CELL_TEXT = [
  'class Avatar:',
  '    def doMove(self, d):',
  '        self.client.onMoveDone()'
].join('\n');

const TEXTS: Record<string, string> = {
  [CLIENT_AVATAR]: CLIENT_TEXT,
  [BASE_AVATAR]: BASE_TEXT,
  [CELL_AVATAR]: CELL_TEXT
};

const DEF_REGISTRY: Record<string, { defFile: string; line: number }> = {
  'Avatar\u001fBaseMethods\u001frequestMove': { defFile: '/ws/entity_defs/Avatar.def', line: 10 },
  'Avatar\u001fCellMethods\u001fdoMove': { defFile: '/ws/entity_defs/Avatar.def', line: 21 },
  'Avatar\u001fClientMethods\u001fonMoveDone': { defFile: '/ws/entity_defs/Avatar.def', line: 34 }
};

const IMPL_REGISTRY: Record<string, { filePath: string; line: number; signature: string; className: string }> = {
  'Avatar\u001fBaseMethods\u001frequestMove': { filePath: BASE_AVATAR, line: 1, signature: 'def requestMove(self, d)', className: 'Avatar' },
  'Avatar\u001fCellMethods\u001fdoMove': { filePath: CELL_AVATAR, line: 1, signature: 'def doMove(self, d)', className: 'Avatar' },
  'Avatar\u001fClientMethods\u001fonMoveDone': { filePath: CLIENT_AVATAR, line: 4, signature: 'def onMoveDone(self)', className: 'Avatar' }
};

const input = (overrides: Partial<FlowScenarioInput> = {}): FlowScenarioInput => ({
  rootKey: '/ws',
  entry: { filePath: CLIENT_AVATAR, functionName: 'chooseRole' },
  files: Object.keys(TEXTS),
  resolveFile: filePath => {
    const text = TEXTS[filePath];
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

describe('FLOW-012 场景走查 Client→Base→Cell→Client', () => {
  it('完整回路:入口帧→三次跨进程发送→三次远端执行,角色序列 client→base→cell→client', () => {
    const result = buildScenarioPath(input());
    expect(result.entryRole).toBe('client');
    const kinds = result.steps.map(step => step.kind);
    expect(kinds).toEqual([
      'local-frame',
      'cross-process-send',
      'remote-exec',
      'cross-process-send',
      'remote-exec',
      'cross-process-send',
      'remote-exec'
    ]);
    // 步序角色:client 入口 → base 执行 → cell 执行 → client 回调执行
    const frameRoles = result.steps.filter(s => s.kind !== 'cross-process-send').map(s => s.role);
    expect(frameRoles).toEqual(['client', 'base', 'cell', 'client']);
    // 每步发送边与执行步对应(viaSendEdgeId 锁步)
    const sendSteps = result.steps.filter(s => s.kind === 'cross-process-send');
    const execSteps = result.steps.filter(s => s.kind === 'remote-exec');
    expect(execSteps.map(s => s.viaSendEdgeId)).toEqual(sendSteps.map(s => s.viaSendEdgeId));
    // 远端执行步的边是 FLOW-007 执行段(declaration-contract,进程内 sync)
    for (const exec of execSteps) {
      expect(exec.edge!.syncAsync).toBe('sync');
      expect(exec.edge!.evidence.type).toBe('declaration-contract');
    }
    expect(result.truncated).toBe(false);
  });

  it('分支为候选:base 侧 if 条件落 branchCandidates,不产生固定执行顺序步', () => {
    const result = buildScenarioPath(input());
    expect(result.branchCandidates).toHaveLength(1);
    const candidate = result.branchCandidates[0];
    expect(candidate.text).toContain('self.ready');
    expect(candidate.kind).toBe('if-branch');
    expect(candidate.note).toContain('候选');
    expect(candidate.note).toContain('不是固定执行顺序');
  });

  it('本地帧与跨进程边都保留:入口帧标签与发送步声明节点', () => {
    const result = buildScenarioPath(input());
    const entryStep = result.steps[0];
    expect(entryStep.label).toContain('chooseRole');
    const firstSend = result.steps.find(s => s.kind === 'cross-process-send');
    expect(firstSend!.label).toContain('RPC 声明');
    expect(firstSend!.edge!.syncAsync).toBe('async-send');
    expect(firstSend!.edge!.messageKind).toBe('rpc');
  });

  it('深度界:超界 truncated 如实(不无限走查)', () => {
    const result = buildScenarioPath(input({ maxDepth: 1 }));
    expect(result.truncated).toBe(true);
    expect(result.steps.length).toBeGreaterThan(0);
  });

  it('入口缺失:抛错不虚构路径', () => {
    expect(() =>
      buildScenarioPath(input({ entry: { filePath: CLIENT_AVATAR, functionName: 'ghostFn' } }))
    ).toThrow(/not found/);
    expect(() =>
      buildScenarioPath(input({ entry: { filePath: '/ws/scripts/client/Ghost.py', functionName: 'x' } }))
    ).toThrow(/not resolvable/);
  });
});
