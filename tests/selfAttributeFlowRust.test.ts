import { describe, expect, it } from 'vitest';
import type { KodeCoreGate } from '../src/backend/kodeCoreGate';
import { setKodeCoreShadowGate } from '../src/backend/kodeCoreShadowFaces';
import { inferSelfAttributeFlowFromRust } from '../src/backend/selfAttributeFlowRust';

// 流敏感 self.<attr> 类型收编 Rust(RUST-MIGRATION-AUDIT-006 B1 车道批 1):
// inferSelfAttributeFlowFromRust 主路径经 `$/kode/python/selfAttributeFlow`
// 调 Rust 引擎(TS selfAttributeFlowTypes.ts 逐字移植)。测试用假 gate
// (setKodeCoreShadowGate),断言重点=精确方法名 + params 闭包
// {lines, queryLine, attr, versionKey}(versionKey 缺省不入参)+ 整面弃用
// 纪律:无门/RPC 失败/flow null/形状畸形(types 非字符串数组、annotation 非
// null 或串、两布尔缺失)一律 null → 调用方回 TS 引擎兜底,禁止部分采用。

const GUARD_LINES = [
  'class Foo:',
  '    def __init__(self):',
  '        self.TalentTree = None',
  '    def method(self):',
  '        if self.TalentTree is None:',
  '            self.TalentTree = make_tree()',
  '        x = self.TalentTree'
];

const validFlow = () => ({
  types: ['None'],
  annotation: 'None',
  hasNone: true,
  narrowed: false
});

describe('inferSelfAttributeFlowFromRust(流类型 Rust 主路径契约)', () => {
  it('Rust 在场:精确方法名 + params 闭包,合法流事实直传', async () => {
    let calledMethod = '';
    let calledParams: unknown = null;
    const fakeGate = {
      runInRust: async (method: string, params: unknown) => {
        calledMethod = method;
        calledParams = params;
        return { ok: true, result: { flow: validFlow() } };
      }
    } as unknown as KodeCoreGate;
    setKodeCoreShadowGate(fakeGate);
    try {
      const face = await inferSelfAttributeFlowFromRust(GUARD_LINES, 6, 'TalentTree', 'file:///a.py|9');
      expect(face).toEqual(validFlow());
      expect(calledMethod).toBe('$/kode/python/selfAttributeFlow');
      const params = calledParams as {
        lines: string[];
        queryLine: number;
        attr: string;
        versionKey?: string;
      };
      expect(params.lines).toEqual(GUARD_LINES);
      expect(params.queryLine).toBe(6);
      expect(params.attr).toBe('TalentTree');
      expect(params.versionKey).toBe('file:///a.py|9');
    } finally {
      setKodeCoreShadowGate(null);
    }
  });

  it('versionKey 缺省不入 params', async () => {
    let calledParams: unknown = null;
    const fakeGate = {
      runInRust: async (_method: string, params: unknown) => {
        calledParams = params;
        return { ok: true, result: { flow: validFlow() } };
      }
    } as unknown as KodeCoreGate;
    setKodeCoreShadowGate(fakeGate);
    try {
      await inferSelfAttributeFlowFromRust(GUARD_LINES, 6, 'TalentTree');
      expect((calledParams as Record<string, unknown>).versionKey).toBeUndefined();
    } finally {
      setKodeCoreShadowGate(null);
    }
  });

  it('无 gate → null(不发 RPC)', async () => {
    setKodeCoreShadowGate(null);
    const face = await inferSelfAttributeFlowFromRust(GUARD_LINES, 6, 'TalentTree', 'k');
    expect(face).toBeNull();
  });

  it('非法入参(attr 空/查询行越界)短路 null,不发 RPC', async () => {
    let rpcCalls = 0;
    const fakeGate = {
      runInRust: async () => {
        rpcCalls += 1;
        return { ok: true, result: { flow: validFlow() } };
      }
    } as unknown as KodeCoreGate;
    setKodeCoreShadowGate(fakeGate);
    try {
      expect(await inferSelfAttributeFlowFromRust(GUARD_LINES, 6, '', 'k')).toBeNull();
      expect(await inferSelfAttributeFlowFromRust(GUARD_LINES, -1, 'x', 'k')).toBeNull();
      expect(await inferSelfAttributeFlowFromRust(GUARD_LINES, GUARD_LINES.length, 'x', 'k')).toBeNull();
      expect(rpcCalls).toBe(0);
    } finally {
      setKodeCoreShadowGate(null);
    }
  });

  it('RPC 失败(ok:false)→ null', async () => {
    const fakeGate = {
      runInRust: async () => ({ ok: false as const, reason: 'boom' })
    } as unknown as KodeCoreGate;
    setKodeCoreShadowGate(fakeGate);
    try {
      const face = await inferSelfAttributeFlowFromRust(GUARD_LINES, 6, 'TalentTree', 'k');
      expect(face).toBeNull();
    } finally {
      setKodeCoreShadowGate(null);
    }
  });

  it('Rust flow:null(与 TS 引擎同判据的无流)→ null', async () => {
    const fakeGate = {
      runInRust: async () => ({ ok: true, result: { flow: null } })
    } as unknown as KodeCoreGate;
    setKodeCoreShadowGate(fakeGate);
    try {
      const face = await inferSelfAttributeFlowFromRust(GUARD_LINES, 6, 'TalentTree', 'k');
      expect(face).toBeNull();
    } finally {
      setKodeCoreShadowGate(null);
    }
  });

  it('形状畸形整面弃用:types 混非串 / annotation 数字 / 布尔缺失', async () => {
    const malformed = [
      { flow: { ...validFlow(), types: ['list', 42] } },
      { flow: { ...validFlow(), annotation: 7 } },
      { flow: { types: ['list'], annotation: null, hasNone: true } },
      { flow: { types: 'list', annotation: null, hasNone: true, narrowed: false } },
      { result: {} },
      {}
    ];
    for (const result of malformed) {
      const fakeGate = {
        runInRust: async () => ({ ok: true, result })
      } as unknown as KodeCoreGate;
      setKodeCoreShadowGate(fakeGate);
      try {
        const face = await inferSelfAttributeFlowFromRust(GUARD_LINES, 6, 'TalentTree', 'k');
        expect(face, `畸形应弃用: ${JSON.stringify(result)}`).toBeNull();
      } finally {
        setKodeCoreShadowGate(null);
      }
    }
  });
});
