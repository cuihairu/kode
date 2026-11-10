/**
 * spaceNav Rust-first 装配面兜底单测(AUDIT-005 B2 车道批 3,沿
 * trapDiagnosticsWiring.test.ts 先例):无门/ok:false/畸形 → 返回 null(调用方
 * 回 TS 同步兜底 computeSpaceNavFindings);门可用 → Rust 结构面经渲染成诊断
 * 面(消息=TS 模板);RPC 契约锁定。禁止部分采用(畸形整面作废)。
 */
import { describe, expect, it } from 'vitest';
import { setKodeCoreShadowGate } from '../src/backend/kodeCoreShadowFaces';
import type { KodeCoreGate } from '../src/backend/kodeCoreGate';
import { buildSpaceNavItemsWithRust } from '../src/backend/spaceNavRust';
import {
  computeSpaceNavFindings,
  renderMappingKeyMessage,
  renderNavigateNoGuardMessage,
  renderParamsStringKeyMessage,
  SPACE_NAV_DIAGNOSTIC_CODE,
  type SpaceNavRustItem
} from '../src/backend/spaceNavDiagnostics';

const TEXT = 'self.setSpaceData("a", "_mapping")\nself.navigate(1)\n';

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

describe('buildSpaceNavItemsWithRust(Rust-first,TS 兜底)', () => {
  it('无门:返回 null,调用方回 TS 兜底', async () => {
    const items = await buildSpaceNavItemsWithRust(TEXT);
    expect(items).toBeNull();
  });

  it('门可用:Rust 结构面经渲染成诊断面(消息=TS 模板,kind 判别)', async () => {
    const rustItems: SpaceNavRustItem[] = [
      { code: SPACE_NAV_DIAGNOSTIC_CODE, line: 0, character: 25, length: 10, kind: 'mappingKey' },
      { code: SPACE_NAV_DIAGNOSTIC_CODE, line: 1, character: 4, length: 8, kind: 'navigateNoGuard' }
    ];
    await withGate(
      () => ({ ok: true as const, result: { items: rustItems } }),
      async () => {
        const findings = await buildSpaceNavItemsWithRust(TEXT);
        expect(findings).not.toBeNull();
        expect(findings).toEqual([
          {
            line: 0, start: 25, end: 35,
            message: renderMappingKeyMessage(),
            code: SPACE_NAV_DIAGNOSTIC_CODE
          },
          {
            line: 1, start: 4, end: 12,
            message: renderNavigateNoGuardMessage(),
            code: SPACE_NAV_DIAGNOSTIC_CODE
          }
        ]);
      }
    );
  });

  it('门调用失败(ok:false):整面回 TS 兜底(返回 null)', async () => {
    await withGate(
      () => ({ ok: false as const, reason: 'no serverPath' }),
      async () => {
        expect(await buildSpaceNavItemsWithRust(TEXT)).toBeNull();
      }
    );
  });

  it('畸形应答(未知 code/未知 kind/缺 kind/paramsStringKey 缺 key):整面作废,不部分采用', async () => {
    const malformed: unknown[][] = [
      // 未知 code
      [{ code: 'kbengine.unknown', line: 0, character: 0, length: 1, kind: 'mappingKey' }],
      // 未知 kind
      [{ code: SPACE_NAV_DIAGNOSTIC_CODE, line: 0, character: 0, length: 1, kind: 'bogus' }],
      // 缺 kind
      [{ code: SPACE_NAV_DIAGNOSTIC_CODE, line: 0, character: 0, length: 1 }],
      // paramsStringKey 缺 key
      [{ code: SPACE_NAV_DIAGNOSTIC_CODE, line: 0, character: 0, length: 3, kind: 'paramsStringKey' }],
      // 非条目
      ['not-an-item']
    ];
    for (const items of malformed) {
      await withGate(
        () => ({ ok: true as const, result: { items } }),
        async () => {
          expect(await buildSpaceNavItemsWithRust(TEXT), JSON.stringify(items)).toBeNull();
        }
      );
    }
  });

  it('门可用空数组:合法空面(信任 Rust,不属畸形)', async () => {
    await withGate(
      () => ({ ok: true as const, result: { items: [] } }),
      async () => {
        expect(await buildSpaceNavItemsWithRust(TEXT)).toEqual([]);
      }
    );
  });

  it('RPC 契约:method=analyzeSpaceNav,params={text}', async () => {
    const calls = await withGate(
      () => ({ ok: true as const, result: { items: [] } }),
      async () => {
        await buildSpaceNavItemsWithRust(TEXT);
      }
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('$/kode/lint/analyzeSpaceNav');
    expect(calls[0].params).toEqual({ text: TEXT });
  });

  it('paramsStringKey 渲染带 key 参数', () => {
    expect(renderParamsStringKeyMessage('"0"')).toContain('"0"');
    // 兜底对照:同步路径与 Rust 渲染对同一文本同消息
    const ts = computeSpaceNavFindings('self.addSpaceGeometryMapping(0, 1, 2, 3, {"0": "x"})\n');
    expect(ts[0].message).toContain('"0"');
  });
});
