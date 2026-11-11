import { describe, expect, it } from 'vitest';
import type { KodeCoreGate } from '../src/backend/kodeCoreGate';
import { setKodeCoreShadowGate } from '../src/backend/kodeCoreShadowFaces';
import { extractFileReturnAnnotationFactsFromRust } from '../src/backend/pythonReturnAnnotationsRust';
import { extractFileReturnAnnotationsAsync } from '../src/backend/pythonReturnTypeInference';

// 返回注解逐文件提取收编 Rust(RUST-MIGRATION-AUDIT-006 B1 车道批 3):
// extractFileReturnAnnotationFactsFromRust 主路径经 `$/kode/python/returnAnnotations`
// 调 Rust 提取核。测试用假 gate(setKodeCoreShadowGate),断言重点=精确方法名
// + params 闭包 {text: 原文} + 原文零 `def` 线索零 RPC + 整面弃用纪律:无门/
// RPC 失败/facts 非数组/条目畸形(名字空/非串/注解非 null 或串)一律 null →
// 调用方回 TS 让出式提取兜底,禁止部分采用。装配切换例:extractFileReturn-
// AnnotationsAsync 门在时信 Rust 事实建表(插入序=事实序),门缺走 TS 提取。

const SOURCE = 'def a() -> int:\n    return 1\ndef b():\n    return 2\n';

const validFacts = () => [
  { name: 'a', annotation: 'int' },
  { name: 'b', annotation: null }
];

describe('extractFileReturnAnnotationFactsFromRust(注解事实 Rust 主路径契约)', () => {
  it('Rust 在场:精确方法名 + params {text: 原文},事实直传', async () => {
    let calledMethod = '';
    let calledParams: unknown = null;
    const fakeGate = {
      runInRust: async (method: string, params: unknown) => {
        calledMethod = method;
        calledParams = params;
        return { ok: true, result: { facts: validFacts() } };
      }
    } as unknown as KodeCoreGate;
    setKodeCoreShadowGate(fakeGate);
    try {
      const facts = await extractFileReturnAnnotationFactsFromRust(SOURCE);
      expect(facts).toEqual(validFacts());
      expect(calledMethod).toBe('$/kode/python/returnAnnotations');
      expect(calledParams).toEqual({ text: SOURCE });
    } finally {
      setKodeCoreShadowGate(null);
    }
  });

  it('无 gate → null(不发 RPC)', async () => {
    setKodeCoreShadowGate(null);
    expect(await extractFileReturnAnnotationFactsFromRust(SOURCE)).toBeNull();
  });

  it('零 def 线索:合法空面 [](不发 RPC)', async () => {
    let rpcCalls = 0;
    const fakeGate = {
      runInRust: async () => {
        rpcCalls += 1;
        return { ok: true, result: { facts: [] } };
      }
    } as unknown as KodeCoreGate;
    setKodeCoreShadowGate(fakeGate);
    try {
      expect(await extractFileReturnAnnotationFactsFromRust('x = 1\nprint(x)\n')).toEqual([]);
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
      expect(await extractFileReturnAnnotationFactsFromRust(SOURCE)).toBeNull();
    } finally {
      setKodeCoreShadowGate(null);
    }
  });

  it('形状畸形整面弃用:非数组/条目非对象/名字空/注解非 null 或串', async () => {
    const malformed = [
      { result: {} },
      { result: { facts: 'nope' } },
      { result: { facts: ['not-an-object'] } },
      { result: { facts: [{ name: '', annotation: 'int' }] } },
      { result: { facts: [{ annotation: 'int' }] } },
      { result: { facts: [{ name: 'a', annotation: 7 }] } },
      { result: { facts: [{ name: 'a', annotation: null }, { name: 'b' }] } }
    ];
    for (const result of malformed) {
      const fakeGate = {
        runInRust: async () => ({ ok: true, result })
      } as unknown as KodeCoreGate;
      setKodeCoreShadowGate(fakeGate);
      try {
        const facts = await extractFileReturnAnnotationFactsFromRust(SOURCE);
        expect(facts, `畸形应弃用: ${JSON.stringify(result)}`).toBeNull();
      } finally {
        setKodeCoreShadowGate(null);
      }
    }
  });

  it('装配切换:门在时信 Rust 事实建表(插入序=事实序,无注解不入表)', async () => {
    const fakeGate = {
      runInRust: async () => ({
        ok: true,
        result: {
          facts: [
            { name: 'zeta', annotation: 'list' },
            { name: 'alpha', annotation: null },
            { name: 'mid', annotation: 'dict' }
          ]
        }
      })
    } as unknown as KodeCoreGate;
    setKodeCoreShadowGate(fakeGate);
    try {
      const index = await extractFileReturnAnnotationsAsync(SOURCE);
      // 事实驱动:TS 同文本提取不了 zeta/mid,此处有值即证明走 Rust 面
      expect([...index.entries()]).toEqual([
        ['zeta', 'list'],
        ['mid', 'dict']
      ]);
    } finally {
      setKodeCoreShadowGate(null);
    }
  });

  it('装配兜底:门缺走 TS 提取(同文本同结果)', async () => {
    setKodeCoreShadowGate(null);
    const index = await extractFileReturnAnnotationsAsync(SOURCE);
    expect(index.get('a')).toBe('int');
    expect(index.has('b')).toBe(false);
  });
});
