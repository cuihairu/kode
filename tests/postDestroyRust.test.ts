/**
 * postDestroy Rust-first 装配面兜底单测(AUDIT-005 B2 车道批 4,沿
 * receiverNoneRust.test.ts 先例):无门/动态分派/非实体/歧义面/ok:false/畸形 →
 * 返回 null 或合法空面(调用方回 TS 兜底);门可用 → Rust 结构面经渲染成诊断
 * 面(消息=TS 模板)。RPC 契约锁定(method/params 形态)。禁止部分采用。
 */
import { describe, expect, it } from 'vitest';
import { setKodeCoreShadowGate } from '../src/backend/kodeCoreShadowFaces';
import type { KodeCoreGate } from '../src/backend/kodeCoreGate';
import { buildPostDestroyItemsWithRust } from '../src/backend/postDestroyRust';
import {
  POST_DESTROY_DIAGNOSTIC_CODE,
  renderPostDestroyMessage,
  renderRustPostDestroyItems
} from '../src/backend/postDestroyDiagnostics';
import type { EntityComponentFace } from '../src/backend/entityBuiltinProperties';
import { pythonStatements } from '../src/backend/pythonParser';

const TEXT = 'def f(self):\n    self.destroy()\n    self.hp\n';
const STATEMENTS = pythonStatements(TEXT);

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

const noFaces = (): Promise<readonly EntityComponentFace[] | null> => Promise.resolve(null);
const facesOf = (faces: EntityComponentFace[]): Promise<readonly EntityComponentFace[] | null> =>
  Promise.resolve(faces);
const notDeclared = (): boolean => false;

describe('buildPostDestroyItemsWithRust(Rust-first,TS 兜底)', () => {
  it('无门:返回 null,调用方回 TS 兜底', async () => {
    const items = await buildPostDestroyItemsWithRust(TEXT, '/proj/base/demo.py', noFaces, notDeclared);
    expect(items).toBeNull();
  });

  it('动态分派(def 声明 destroy):合法空面 [](不发 RPC)', async () => {
    const calls = await withGate(
      () => ({ ok: true as const, result: { items: [] } }),
      async () => {
        const items = await buildPostDestroyItemsWithRust(TEXT, '/proj/base/demo.py', noFaces, () => true);
        expect(items).toEqual([]);
      }
    );
    expect(calls).toHaveLength(0);
  });

  it('非实体脚本(路径面无 def 归属):合法空面 [](不发 RPC)', async () => {
    const calls = await withGate(
      () => ({ ok: true as const, result: { items: [] } }),
      async () => {
        const items = await buildPostDestroyItemsWithRust(TEXT, '/proj/scripts/demo.py', noFaces, notDeclared);
        expect(items).toEqual([]);
      }
    );
    expect(calls).toHaveLength(0);
  });

  it('面歧义(def 归属多面):合法空面 [](不发 RPC,不猜)', async () => {
    const calls = await withGate(
      () => ({ ok: true as const, result: { items: [] } }),
      async () => {
        const items = await buildPostDestroyItemsWithRust(
          TEXT,
          '/proj/scripts/demo.py',
          () => Promise.resolve(['baseapp', 'cellapp']),
          notDeclared
        );
        expect(items).toEqual([]);
      }
    );
    expect(calls).toHaveLength(0);
  });

  it('门可用:Rust 结构面经渲染成诊断面(消息=TS 模板)', async () => {
    const rustItems = [
      { code: POST_DESTROY_DIAGNOSTIC_CODE, line: 2, character: 4, length: 7, member: 'hp', destroyLine: 1, destroyColumn: 4 }
    ];
    await withGate(
      () => ({ ok: true as const, result: { items: rustItems } }),
      async () => {
        const items = await buildPostDestroyItemsWithRust(TEXT, '/proj/cell/demo.py', noFaces, notDeclared);
        expect(items).toEqual([
          {
            range: { start: { line: 2, character: 4 }, end: { line: 2, character: 11 } },
            message: renderPostDestroyMessage('hp', 1),
            severity: 'Warning',
            source: 'kbengine',
            code: POST_DESTROY_DIAGNOSTIC_CODE
          }
        ]);
      }
    );
  });

  it('门调用失败(ok:false):整面回 TS 兜底(返回 null)', async () => {
    await withGate(
      () => ({ ok: false as const, reason: 'no serverPath' }),
      async () => {
        const items = await buildPostDestroyItemsWithRust(TEXT, '/proj/cell/demo.py', noFaces, notDeclared);
        expect(items).toBeNull();
      }
    );
  });

  it('畸形应答(坏 code/缺字段/负值/安全成员/长度不符/非法成员名):整面作废,不部分采用', async () => {
    const malformed: unknown[][] = [
      // 坏 code
      [{ code: 'kbengine.other', line: 2, character: 4, length: 7, member: 'hp', destroyLine: 1, destroyColumn: 4 }],
      // 缺 member / 空 member / 安全成员 / 非法成员名
      [{ code: POST_DESTROY_DIAGNOSTIC_CODE, line: 2, character: 4, length: 7, destroyLine: 1, destroyColumn: 4 }],
      [{ code: POST_DESTROY_DIAGNOSTIC_CODE, line: 2, character: 4, length: 7, member: '', destroyLine: 1, destroyColumn: 4 }],
      [{ code: POST_DESTROY_DIAGNOSTIC_CODE, line: 2, character: 4, length: 11, member: 'isDestroyed', destroyLine: 1, destroyColumn: 4 }],
      [{ code: POST_DESTROY_DIAGNOSTIC_CODE, line: 2, character: 4, length: 8, member: '1hp', destroyLine: 1, destroyColumn: 4 }],
      // length 与 'self.' + member 不符
      [{ code: POST_DESTROY_DIAGNOSTIC_CODE, line: 2, character: 4, length: 9, member: 'hp', destroyLine: 1, destroyColumn: 4 }],
      // 负值
      [{ code: POST_DESTROY_DIAGNOSTIC_CODE, line: 2, character: -1, length: 7, member: 'hp', destroyLine: 1, destroyColumn: 4 }],
      [{ code: POST_DESTROY_DIAGNOSTIC_CODE, line: 2, character: 4, length: 7, member: 'hp', destroyLine: 1, destroyColumn: -4 }],
      // 非条目
      ['not-an-item']
    ];
    for (const items of malformed) {
      await withGate(
        () => ({ ok: true as const, result: { items } }),
        async () => {
          expect(
            await buildPostDestroyItemsWithRust(TEXT, '/proj/cell/demo.py', noFaces, notDeclared),
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
        expect(await buildPostDestroyItemsWithRust(TEXT, '/proj/cell/demo.py', noFaces, notDeclared)).toEqual([]);
      }
    );
  });

  it('RPC 契约:method=analyzePostDestroy,params={text,destroyDeclared,statements}', async () => {
    const calls = await withGate(
      () => ({ ok: true as const, result: { items: [] } }),
      async () => {
        await buildPostDestroyItemsWithRust(TEXT, '/proj/cell/demo.py', noFaces, notDeclared);
      }
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('$/kode/lint/analyzePostDestroy');
    expect(calls[0].params).toEqual({
      text: TEXT,
      destroyDeclared: false,
      statements: STATEMENTS
    });
  });

  it('渲染面直验:合法条目过,畸形条目整面 null(对拍共用)', () => {
    expect(renderRustPostDestroyItems([
      { code: POST_DESTROY_DIAGNOSTIC_CODE, line: 1, character: 0, length: 8, member: 'id2', destroyLine: 0, destroyColumn: 0 }
    ])).not.toBeNull();
    expect(renderRustPostDestroyItems([{}])).toBeNull();
    expect(renderRustPostDestroyItems([])).toEqual([]);
  });
});
