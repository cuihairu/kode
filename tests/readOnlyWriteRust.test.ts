/**
 * readOnlyWrite Rust-first 装配面兜底单测(AUDIT-005 B2 车道批 5,沿
 * postDestroyRust.test.ts 先例):无门/非实体/ok:false/畸形/属性表矛盾 →
 * 返回 null 或合法空面(调用方回 TS 兜底);门可用 → Rust 结构面经渲染成诊断
 * 面(消息=TS 模板,属性表重解析校验)。RPC 契约锁定(method/params 形态,
 * readonlyNames=face 表 readonly 名集)。禁止部分采用。
 */
import { describe, expect, it } from 'vitest';
import { setKodeCoreShadowGate } from '../src/backend/kodeCoreShadowFaces';
import type { KodeCoreGate } from '../src/backend/kodeCoreGate';
import { buildReadOnlyWriteItemsWithRust } from '../src/backend/readOnlyWriteRust';
import {
  READONLY_WRITE_DIAGNOSTIC_CODE,
  renderReadOnlyWriteMessage,
  renderRustReadOnlyWriteItems
} from '../src/backend/readOnlyWriteDiagnostics';
import {
  getEntityBuiltinPropertiesForFace,
  resolveEntityBuiltinPropertyHit,
  type EntityComponentFace
} from '../src/backend/entityBuiltinProperties';

const TEXT = 'class A:\n    def f(self):\n        self.id = 1\n';

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
const readonlyNamesOf = (face: EntityComponentFace | null): string[] =>
  getEntityBuiltinPropertiesForFace(face)
    .filter(property => property.readonly)
    .map(property => property.name);

describe('buildReadOnlyWriteItemsWithRust(Rust-first,TS 兜底)', () => {
  it('无门:返回 null,调用方回 TS 兜底', async () => {
    const items = await buildReadOnlyWriteItemsWithRust(TEXT, '/proj/scripts/base/demo.py', noFaces);
    expect(items).toBeNull();
  });

  it('非实体脚本(路径面无 def 归属):合法空面 [](不发 RPC)', async () => {
    const calls = await withGate(
      () => ({ ok: true as const, result: { items: [] } }),
      async () => {
        const items = await buildReadOnlyWriteItemsWithRust(TEXT, '/proj/scripts/demo.py', noFaces);
        expect(items).toEqual([]);
      }
    );
    expect(calls).toHaveLength(0);
  });

  it('门可用:Rust 结构面经渲染成诊断面(消息=TS 模板,属性表重解析)', async () => {
    const hit = resolveEntityBuiltinPropertyHit('id', 'baseapp', null);
    expect(hit).not.toBeNull();
    const rustItems = [
      { code: READONLY_WRITE_DIAGNOSTIC_CODE, line: 2, character: 8, length: 7, propertyName: 'id', kind: 'assign' }
    ];
    await withGate(
      () => ({ ok: true as const, result: { items: rustItems } }),
      async () => {
        const items = await buildReadOnlyWriteItemsWithRust(TEXT, '/proj/scripts/base/demo.py', noFaces);
        expect(items).toEqual([
          {
            range: { start: { line: 2, character: 8 }, end: { line: 2, character: 15 } },
            message: renderReadOnlyWriteMessage('id', hit!, 'assign'),
            severity: 'Warning',
            source: 'kbengine',
            code: READONLY_WRITE_DIAGNOSTIC_CODE
          }
        ]);
      }
    );
  });

  it('属性表重解析矛盾(Rust 放行名字非只读/未命中):整面作废', async () => {
    // shouldAutoBackup 是 baseapp 可写属性:Rust 只读闸若误放行 → 整面 null
    const writableItem = [
      { code: READONLY_WRITE_DIAGNOSTIC_CODE, line: 0, character: 0, length: 21, propertyName: 'shouldAutoBackup', kind: 'assign' }
    ];
    await withGate(
      () => ({ ok: true as const, result: { items: writableItem } }),
      async () => {
        expect(await buildReadOnlyWriteItemsWithRust(TEXT, '/proj/scripts/base/demo.py', noFaces)).toBeNull();
      }
    );
    // 未命中属性名(表里没有)→ 整面 null
    const unknownItem = [
      { code: READONLY_WRITE_DIAGNOSTIC_CODE, line: 0, character: 0, length: 9, propertyName: 'ghostProp', kind: 'assign' }
    ];
    await withGate(
      () => ({ ok: true as const, result: { items: unknownItem } }),
      async () => {
        expect(await buildReadOnlyWriteItemsWithRust(TEXT, '/proj/scripts/base/demo.py', noFaces)).toBeNull();
      }
    );
  });

  it('面歧义(def 归属多面):face=null 只查宏公共 3,照常发 RPC', async () => {
    const calls = await withGate(
      () => ({ ok: true as const, result: { items: [] } }),
      async () => {
        const items = await buildReadOnlyWriteItemsWithRust(
          TEXT,
          '/proj/scripts/demo.py',
          () => facesOf(['baseapp', 'cellapp'])
        );
        expect(items).toEqual([]);
      }
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].params).toEqual({
      text: TEXT,
      readonlyNames: readonlyNamesOf(null)
    });
  });

  it('门调用失败(ok:false):整面回 TS 兜底(返回 null)', async () => {
    await withGate(
      () => ({ ok: false as const, reason: 'no serverPath' }),
      async () => {
        expect(await buildReadOnlyWriteItemsWithRust(TEXT, '/proj/scripts/base/demo.py', noFaces)).toBeNull();
      }
    );
  });

  it('畸形应答(坏 code/坏 kind/坏属性名/长度不符/负值/非条目):整面作废,不部分采用', async () => {
    const malformed: unknown[][] = [
      // 坏 code
      [{ code: 'kbengine.other', line: 0, character: 0, length: 7, propertyName: 'id', kind: 'assign' }],
      // 坏 kind
      [{ code: READONLY_WRITE_DIAGNOSTIC_CODE, line: 0, character: 0, length: 7, propertyName: 'id', kind: 'bogus' }],
      // 坏属性名 / 空属性名 / 缺属性名
      [{ code: READONLY_WRITE_DIAGNOSTIC_CODE, line: 0, character: 0, length: 7, propertyName: '1x', kind: 'assign' }],
      [{ code: READONLY_WRITE_DIAGNOSTIC_CODE, line: 0, character: 0, length: 7, propertyName: '', kind: 'assign' }],
      [{ code: READONLY_WRITE_DIAGNOSTIC_CODE, line: 0, character: 0, length: 7, kind: 'assign' }],
      // length 与 'self.' + propertyName 不符
      [{ code: READONLY_WRITE_DIAGNOSTIC_CODE, line: 0, character: 0, length: 9, propertyName: 'id', kind: 'assign' }],
      // 负值
      [{ code: READONLY_WRITE_DIAGNOSTIC_CODE, line: -1, character: 0, length: 7, propertyName: 'id', kind: 'assign' }],
      [{ code: READONLY_WRITE_DIAGNOSTIC_CODE, line: 0, character: -1, length: 7, propertyName: 'id', kind: 'assign' }],
      // 非条目
      ['not-an-item']
    ];
    for (const items of malformed) {
      await withGate(
        () => ({ ok: true as const, result: { items } }),
        async () => {
          expect(
            await buildReadOnlyWriteItemsWithRust(TEXT, '/proj/scripts/base/demo.py', noFaces),
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
        expect(await buildReadOnlyWriteItemsWithRust(TEXT, '/proj/scripts/base/demo.py', noFaces)).toEqual([]);
      }
    );
  });

  it('RPC 契约:method=analyzeReadOnlyWrite,params={text,readonlyNames}(face 表 readonly 集)', async () => {
    const calls = await withGate(
      () => ({ ok: true as const, result: { items: [] } }),
      async () => {
        await buildReadOnlyWriteItemsWithRust(TEXT, '/proj/scripts/base/demo.py', noFaces);
      }
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('$/kode/lint/analyzeReadOnlyWrite');
    expect(calls[0].params).toEqual({
      text: TEXT,
      readonlyNames: readonlyNamesOf('baseapp')
    });
  });

  it('渲染面直验:合法条目过,畸形条目整面 null(对拍共用)', () => {
    const hit = resolveEntityBuiltinPropertyHit('cell', 'baseapp', null);
    expect(hit).not.toBeNull();
    expect(renderRustReadOnlyWriteItems([
      { code: READONLY_WRITE_DIAGNOSTIC_CODE, line: 0, character: 0, length: 9, propertyName: 'cell', kind: 'augmented' }
    ], 'baseapp', null)).not.toBeNull();
    expect(renderRustReadOnlyWriteItems([{}], 'baseapp', null)).toBeNull();
    expect(renderRustReadOnlyWriteItems([], 'baseapp', null)).toEqual([]);
  });
});
