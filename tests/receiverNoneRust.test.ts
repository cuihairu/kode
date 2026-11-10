/**
 * receiverNone Rust-first 装配面兜底单测(AUDIT-005 B2 车道批 3,沿
 * spaceNavRust.test.ts 先例):无门/零线索/ok:false/畸形 → 返回 null 或合法
 * 空面(调用方回 TS 异步兜底);门可用 → Rust 结构面经渲染成诊断面(消息=
 * TS 模板,kind 判别;段错配由 TS 同一 mapping 重算,不构成错配 = 语义矛盾
 * 整面作废)。RPC 契约锁定(method/params 形态)。禁止部分采用。
 */
import { describe, expect, it } from 'vitest';
import { setKodeCoreShadowGate } from '../src/backend/kodeCoreShadowFaces';
import type { KodeCoreGate } from '../src/backend/kodeCoreGate';
import { buildReceiverNoneItemsWithRust } from '../src/backend/receiverNoneRust';
import {
  RECEIVER_NONE_DIAGNOSTIC_CODE,
  RECEIVER_SECTION_MISMATCH_DIAGNOSTIC_CODE,
  renderReceiverNoneMessage
} from '../src/backend/receiverNoneDiagnostics';
import type { EntityMapping } from '../src/entityMapping';
import { parsePythonFile } from '../src/backend/pythonParser';

const TEXT = 'class A:\n    def f(self):\n        self.cell.foo()\n';
const PARSED = parsePythonFile(TEXT, 'demo.py');
const METHODS = PARSED.classes.map(cls => ({
  startLine: cls.startLine,
  endLine: cls.endLine,
  defLines: [...cls.methods.values()].map(location => location.line)
}));

/** 最小 EntityMapping 替身(渲染只用 methods 面) */
const mappingWith = (methods: EntityMapping['methods']): EntityMapping => ({
  name: 'Demo',
  defFile: 'demo.def',
  pythonFile: 'demo.py',
  pythonFiles: ['demo.py'],
  properties: {},
  methods
});

const section = (name: string, sections: string[]): EntityMapping['methods'][string] =>
  sections.map(section => ({
    defFile: 'demo.def',
    line: 1,
    section: section as 'BaseMethods' | 'CellMethods' | 'ClientMethods',
    exposed: true,
    identity: {
      ownerKind: 'entity' as const,
      ownerName: 'Demo',
      sourceKind: 'local' as const,
      sourceChain: [],
      symbolName: name
    }
  }));

/** 注入门替身;runInRust 按给定应答回,记录 method/params */
const withGate = async (
  respond: (method: string, params: unknown) => unknown,
  run: () => Promise<void>
): Promise<Array<{ method: string; params: unknown }>> => {
  const calls: Array<{ method: string; params: unknown }> = [];
  const gate = {
    runInRust: async (method: string, params: unknown) => {
      calls.push({ method, params });
      return respond(method, params);
    }
  } as unknown as KodeCoreGate;
  setKodeCoreShadowGate(gate);
  try {
    await run();
  } finally {
    setKodeCoreShadowGate(null);
  }
  return calls;
};

describe('buildReceiverNoneItemsWithRust(Rust-first,TS 兜底)', () => {
  it('无门:返回 null,调用方回 TS 兜底', async () => {
    const items = await buildReceiverNoneItemsWithRust(TEXT, 'demo.py', undefined);
    expect(items).toBeNull();
  });

  it('零 receiver 线索:合法空面 [](不发 RPC,不取解析)', async () => {
    const plain = 'x = 1\ny = 2\n';
    const calls = await withGate(
      () => ({ ok: true as const, result: { items: [] } }),
      async () => {
        const items = await buildReceiverNoneItemsWithRust(plain, 'plain.py', undefined);
        expect(items).toEqual([]);
      }
    );
    expect(calls).toHaveLength(0);
  });

  it('门可用:Rust 结构面经渲染成诊断面(receiverNone 消息=TS 模板)', async () => {
    const rustItems = [
      {
        code: RECEIVER_NONE_DIAGNOSTIC_CODE,
        line: 2,
        character: 18,
        length: 3,
        kind: 'receiverNone',
        receiver: 'cell',
        methodName: 'foo'
      }
    ];
    await withGate(
      () => ({ ok: true as const, result: { items: rustItems } }),
      async () => {
        const items = await buildReceiverNoneItemsWithRust(TEXT, 'demo.py', undefined);
        expect(items).not.toBeNull();
        expect(items).toEqual([
          {
            range: { start: { line: 2, character: 18 }, end: { line: 2, character: 21 } },
            message: renderReceiverNoneMessage('cell'),
            severity: 'Warning',
            source: 'kbengine',
            code: RECEIVER_NONE_DIAGNOSTIC_CODE
          }
        ]);
      }
    );
  });

  it('段错配条由 TS 同一 mapping 重算 declared(重算不构成错配 = 语义矛盾整面作废)', async () => {
    const mismatchItem = {
      code: RECEIVER_SECTION_MISMATCH_DIAGNOSTIC_CODE,
      line: 2,
      character: 18,
      length: 4,
      kind: 'sectionMismatch',
      receiver: 'base',
      methodName: 'jump'
    };
    // mapping 声明在 BaseMethods(base 段本身)→ 不构成错配 → 整面作废
    const consistent = mappingWith({ jump: section('jump', ['BaseMethods']) });
    await withGate(
      () => ({ ok: true as const, result: { items: [mismatchItem] } }),
      async () => {
        expect(await buildReceiverNoneItemsWithRust(TEXT, 'demo.py', consistent)).toBeNull();
      }
    );
    // mapping 声明在 CellMethods → 错配成立,渲染出诊断面
    const mismatched = mappingWith({ jump: section('jump', ['CellMethods']) });
    await withGate(
      () => ({ ok: true as const, result: { items: [mismatchItem] } }),
      async () => {
        const items = await buildReceiverNoneItemsWithRust(TEXT, 'demo.py', mismatched);
        expect(items).not.toBeNull();
        expect(items![0].code).toBe(RECEIVER_SECTION_MISMATCH_DIAGNOSTIC_CODE);
        expect(items![0].message).toContain('CellMethods');
      }
    );
    // 无 mapping 却出段错配条 = 契约漂移 → 整面作废
    await withGate(
      () => ({ ok: true as const, result: { items: [mismatchItem] } }),
      async () => {
        expect(await buildReceiverNoneItemsWithRust(TEXT, 'demo.py', undefined)).toBeNull();
      }
    );
  });

  it('门调用失败(ok:false):整面回 TS 兜底(返回 null)', async () => {
    await withGate(
      () => ({ ok: false as const, reason: 'no serverPath' }),
      async () => {
        expect(await buildReceiverNoneItemsWithRust(TEXT, 'demo.py', undefined)).toBeNull();
      }
    );
  });

  it('畸形应答(未知 code/kind/缺字段/坏 receiver/长度不符):整面作废,不部分采用', async () => {
    const malformed: unknown[][] = [
      // 未知 code
      [{ code: 'kbengine.unknown', line: 0, character: 0, length: 3, kind: 'receiverNone', receiver: 'cell', methodName: 'foo' }],
      // 未知 kind
      [{ code: RECEIVER_NONE_DIAGNOSTIC_CODE, line: 0, character: 0, length: 3, kind: 'bogus', receiver: 'cell', methodName: 'foo' }],
      // kind 与 code 错配
      [{ code: RECEIVER_SECTION_MISMATCH_DIAGNOSTIC_CODE, line: 0, character: 0, length: 3, kind: 'receiverNone', receiver: 'cell', methodName: 'foo' }],
      // 未知 receiver
      [{ code: RECEIVER_NONE_DIAGNOSTIC_CODE, line: 0, character: 0, length: 3, kind: 'receiverNone', receiver: 'space', methodName: 'foo' }],
      // 缺 methodName / 空 methodName
      [{ code: RECEIVER_NONE_DIAGNOSTIC_CODE, line: 0, character: 0, length: 3, kind: 'receiverNone', receiver: 'cell' }],
      [{ code: RECEIVER_NONE_DIAGNOSTIC_CODE, line: 0, character: 0, length: 3, kind: 'receiverNone', receiver: 'cell', methodName: '' }],
      // length 与 methodName 长度不符
      [{ code: RECEIVER_NONE_DIAGNOSTIC_CODE, line: 0, character: 0, length: 9, kind: 'receiverNone', receiver: 'cell', methodName: 'foo' }],
      // 负数列
      [{ code: RECEIVER_NONE_DIAGNOSTIC_CODE, line: 0, character: -1, length: 3, kind: 'receiverNone', receiver: 'cell', methodName: 'foo' }],
      // 非条目
      ['not-an-item']
    ];
    for (const items of malformed) {
      await withGate(
        () => ({ ok: true as const, result: { items } }),
        async () => {
          expect(
            await buildReceiverNoneItemsWithRust(TEXT, 'demo.py', undefined),
            JSON.stringify(items)
          ).toBeNull();
        }
      );
    }
  });

  it('门可用空数组:合法空面(信任 Rust,不属畸形)', async () => {
    await withGate(
      () => ({ ok: true as const, result: { items: [] } }),
      async () => {
        expect(await buildReceiverNoneItemsWithRust(TEXT, 'demo.py', undefined)).toEqual([]);
      }
    );
  });

  it('RPC 契约:method=analyzeReceiverNone,params={text,methods,declarations}', async () => {
    const mapping = mappingWith({ jump: section('jump', ['BaseMethods']) });
    const calls = await withGate(
      () => ({ ok: true as const, result: { items: [] } }),
      async () => {
        await buildReceiverNoneItemsWithRust(TEXT, 'demo.py', mapping);
      }
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('$/kode/lint/analyzeReceiverNone');
    expect(calls[0].params).toEqual({
      text: TEXT,
      methods: METHODS,
      declarations: { jump: ['BaseMethods'] }
    });
  });
});
