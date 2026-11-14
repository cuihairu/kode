import { describe, expect, it } from 'vitest';
import { resolveFlowCallSites } from '../src/backend/flowCallResolver';

// FLOW-011(旧 KFLOW-CORE-11)保留外部及动态边钉。
// 验收:动态 getattr、未知 receiver、第三方/native 函数显示未解析边及原因;
// 不静默消失或猜唯一落点。

const BASE_AVATAR = '/ws/scripts/base/Avatar.py';

const TEXT = [
  'import json',
  '',
  'class Avatar:',
  '    def direct(self, name):',
  "        getattr(self, name)()",
  '',
  '    def alias(self, name):',
  '        method = getattr(self, name)',
  '        method()',
  '',
  '    def mystery(self):',
  '        source = unknown_source()',
  '        source.fire()',
  '',
  '    def third(self):',
  "        json.loads('{}')",
  '',
  '    def engine(self):',
  '        KBEngine.entities.get(1)'
].join('\n');

const resolve = (): ReturnType<typeof resolveFlowCallSites> =>
  resolveFlowCallSites({ text: TEXT, filePath: BASE_AVATAR, rootKey: '/ws' });

describe('FLOW-011 动态分发不静默', () => {
  it('getattr(...)() 直接动态分发:dynamic-getattr 未解析边带原因', () => {
    const result = resolve();
    const edge = result.edges.find(
      e => e.unresolvedReason?.code === 'dynamic-getattr'
    );
    expect(edge).toBeDefined();
    expect(edge!.evidence.type).toBe('syntax-anchor');
    expect(edge!.evidence.detail).toContain('getattr');
    expect(edge!.callSite?.line).toBe(4);
    expect(edge!.unresolvedReason!.code).toBe('dynamic-getattr');
    expect(edge!.unresolvedReason!.detail).toContain('不可静态证明');
  });

  it('getattr 赋值后调用:裸名无绑定如实 third-party-function,不猜目标', () => {
    const result = resolve();
    const edge = result.edges.find(e => e.callSite?.line === 8);
    expect(edge).toBeDefined();
    expect(edge!.unresolvedReason?.code).toBe('third-party-function');
    expect(edge!.unresolvedReason!.detail).toContain('method');
  });
});

describe('FLOW-011 外部与未知的保留', () => {
  it('未知 receiver 链:赋值侧 third-party、使用侧带原因未解析', () => {
    const result = resolve();
    const assign = result.edges.find(e => e.callSite?.line === 11);
    expect(assign!.unresolvedReason?.code).toBe('third-party-function');
    const use = result.edges.find(e => e.callSite?.line === 12);
    expect(use).toBeDefined();
    expect(use!.unresolvedReason).not.toBeNull();
  });

  it('第三方模块调用:unknown-receiver 如实(不猜模块面)', () => {
    const result = resolve();
    const edge = result.edges.find(e => e.callSite?.line === 15);
    expect(edge).toBeDefined();
    expect(edge!.unresolvedReason?.code).toBe('unknown-receiver');
    expect(edge!.evidence.detail).toBe('json.loads');
  });

  it('引擎 API:native-function 面(静态树不建模但边保留)', () => {
    const result = resolve();
    const edge = result.edges.find(e => e.callSite?.line === 18);
    expect(edge).toBeDefined();
    expect(edge!.unresolvedReason?.code).toBe('native-function');
  });
});

describe('FLOW-011 保留不变式', () => {
  it('每个调用行都有边(不静默消失)', () => {
    const result = resolve();
    const callLines = [4, 7, 8, 11, 12, 15, 18];
    for (const line of callLines) {
      const hits = result.edges.filter(e => e.callSite?.line === line);
      expect(hits.length).toBeGreaterThan(0);
    }
  });

  it('未解析目标不猜唯一落点:目标节点无实体、候选集恒空', () => {
    const result = resolve();
    const nodesById = new Map(result.nodes.map(node => [node.id, node]));
    for (const edge of result.edges) {
      if (edge.messageKind !== 'unresolved') {
        continue;
      }
      const target = nodesById.get(edge.toNodeId);
      expect(target).toBeDefined();
      expect(target!.kind).toBe('unresolved');
      expect(target!.entity).toBeNull();
      expect(target!.instanceCandidates).toEqual([]);
      expect(edge.unresolvedReason?.code).toBeTruthy();
      expect(edge.unresolvedReason!.detail.length).toBeGreaterThan(0);
    }
  });
});
