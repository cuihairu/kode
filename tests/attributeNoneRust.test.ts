/**
 * attributeNone Rust-first 装配面兜底单测(AUDIT-005 B2 车道批 6;批 2 流证据
 * 内联,沿 readOnlyWriteRust.test.ts 先例):无门/零线索/ok:false/畸形/内建
 * receiver 漂移/流事实缺失或畸形/同 (行,属性) 流事实矛盾 → 返回 null 或合法
 * 空面(调用方回 TS 兜底);门可用 → Rust 词法结构面+内联流事实经渲染成
 * findings(hasNone 事实裁定,TS 不再二次流查询)。RPC 契约锁定
 * (method/params 形态,params.text = 预掩码文本,params.versionKey 缺省不入)。
 * 禁止部分采用。
 */
import { describe, expect, it } from 'vitest';
import { setKodeCoreShadowGate } from '../src/backend/kodeCoreShadowFaces';
import type { KodeCoreGate } from '../src/backend/kodeCoreGate';
import { buildAttributeNoneItemsWithRust } from '../src/backend/attributeNoneRust';
import { maskPythonNonCode } from '../src/backend/pythonLexicalMask';
import {
  ATTRIBUTE_NONE_DIAGNOSTIC_CODE,
  renderAttributeNoneMessage,
  renderAttributeNoneRustItems
} from '../src/backend/selfAttributeNoneDiagnostics';

/** __init__ 仅 = None,无守卫 → 流含 None,成员访问报 */
const TEXT = [
  'class Foo:',
  '    def __init__(self):',
  '        self.TalentTree = None',
  '    def method(self):',
  '        self.TalentTree.get(0)',
  ''
].join('\n');

/** 内联流事实面(与 Rust AttributeNoneFlowFace 同形) */
const flowFace = (hasNone: boolean, narrowed: boolean) => ({
  types: hasNone ? ['None'] : [],
  annotation: hasNone ? 'None' : null,
  hasNone,
  narrowed
});

/** 合法词法条目(flow 可覆写,覆盖面测试用) */
const lexItem = (overrides: Record<string, unknown> = {}) => ({
  code: ATTRIBUTE_NONE_DIAGNOSTIC_CODE,
  line: 4,
  character: 24,
  length: 3,
  attr: 'TalentTree',
  member: 'get',
  flow: flowFace(true, false),
  ...overrides
});

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

const okItems = (items: unknown[]) => ({ ok: true as const, result: { items } });

describe('buildAttributeNoneItemsWithRust(Rust-first,TS 兜底)', () => {
  it('无门:返回 null,调用方回 TS 兜底', async () => {
    const items = await buildAttributeNoneItemsWithRust(TEXT);
    expect(items).toBeNull();
  });

  it('零线索(原文无 self.):合法空面 [](不发 RPC)', async () => {
    const calls = await withGate(okItems([]), async () => {
      const items = await buildAttributeNoneItemsWithRust('print(1)\nx = 2\n');
      expect(items).toEqual([]);
    });
    expect(calls).toHaveLength(0);
  });

  it('门可用:Rust 结构面+内联流事实(hasNone true)→ findings(消息=TS 模板)', async () => {
    await withGate(() => okItems([lexItem()]), async () => {
      const items = await buildAttributeNoneItemsWithRust(TEXT, 'ut-attr-render');
      expect(items).toEqual([
        {
          line: 4,
          character: 24,
          attr: 'TalentTree',
          member: 'get',
          message: renderAttributeNoneMessage('TalentTree', 'get')
        }
      ]);
    });
  });

  it('流事实裁定:hasNone false/narrowed true → 合法空面(批 2 起事实驱动)', async () => {
    // 刻意传 TEXT(TS 引擎视角此文本 hasNone=true)而流事实报 hasNone=false:
    // 结果为空面即证明裁定只信内联事实、不再二次 TS 流查询。
    const rustItems = [
      { code: ATTRIBUTE_NONE_DIAGNOSTIC_CODE, line: 6, character: 16, length: 3, attr: 'TalentTree', member: 'get', flow: flowFace(false, true) }
    ];
    await withGate(() => okItems(rustItems), async () => {
      const items = await buildAttributeNoneItemsWithRust(TEXT, 'ut-attr-narrow');
      expect(items).toEqual([]);
    });
  });

  it('内建 receiver 漂移(Rust 回 cell/base/client):整面作废', async () => {
    for (const attr of ['cell', 'base', 'client']) {
      const rustItems = [
        { code: ATTRIBUTE_NONE_DIAGNOSTIC_CODE, line: 0, character: 10, length: 4, attr, member: 'tick', flow: flowFace(true, false) }
      ];
      await withGate(() => okItems(rustItems), async () => {
        expect(
          await buildAttributeNoneItemsWithRust(TEXT, 'ut-attr-builtin'),
          `attr=${attr}`
        ).toBeNull();
      });
    }
  });

  it('门调用失败(ok:false):整面回 TS 兜底(返回 null)', async () => {
    await withGate(
      () => ({ ok: false as const, reason: 'no serverPath' }),
      async () => {
        expect(await buildAttributeNoneItemsWithRust(TEXT, 'ut-attr-fail')).toBeNull();
      }
    );
  });

  it('畸形应答(坏 code/坏 attr/坏 member/长度不符/负值/非条目):整面作废,不部分采用', async () => {
    const malformed: unknown[][] = [
      // 坏 code
      [{ code: 'kbengine.other', line: 0, character: 0, length: 3, attr: 'x', member: 'y', flow: flowFace(true, false) }],
      // 坏 attr 形 / 缺 attr / 坏 member 形 / 缺 member
      [{ code: ATTRIBUTE_NONE_DIAGNOSTIC_CODE, line: 0, character: 0, length: 1, attr: '1x', member: 'y', flow: flowFace(true, false) }],
      [{ code: ATTRIBUTE_NONE_DIAGNOSTIC_CODE, line: 0, character: 0, length: 1, member: 'y', flow: flowFace(true, false) }],
      [{ code: ATTRIBUTE_NONE_DIAGNOSTIC_CODE, line: 0, character: 0, length: 1, attr: 'x', member: '9z', flow: flowFace(true, false) }],
      [{ code: ATTRIBUTE_NONE_DIAGNOSTIC_CODE, line: 0, character: 0, length: 1, attr: 'x', flow: flowFace(true, false) }],
      // length 与 member 不符
      [{ code: ATTRIBUTE_NONE_DIAGNOSTIC_CODE, line: 0, character: 0, length: 5, attr: 'x', member: 'get', flow: flowFace(true, false) }],
      // 负值
      [{ code: ATTRIBUTE_NONE_DIAGNOSTIC_CODE, line: -1, character: 0, length: 3, attr: 'x', member: 'get', flow: flowFace(true, false) }],
      [{ code: ATTRIBUTE_NONE_DIAGNOSTIC_CODE, line: 0, character: -1, length: 3, attr: 'x', member: 'get', flow: flowFace(true, false) }],
      // 非条目
      ['not-an-item']
    ];
    for (const items of malformed) {
      await withGate(
        () => okItems(items),
        async () => {
          expect(
            await buildAttributeNoneItemsWithRust(TEXT, 'ut-attr-malformed'),
            JSON.stringify(items)
          ).toBeNull();
        }
      );
    }
  });

  it('流事实缺失/畸形:整面作废(批 2 内联契约,Rust 不回 flow 即漂移)', async () => {
    const malformedFlow: unknown[] = [
      // flow 缺失
      { code: ATTRIBUTE_NONE_DIAGNOSTIC_CODE, line: 4, character: 24, length: 3, attr: 'TalentTree', member: 'get' },
      // flow null(引擎查询恒可解,None = 契约漂移)
      lexItem({ flow: null }),
      // flow 非对象
      lexItem({ flow: 'None' }),
      // types 非数组 / 混非串
      lexItem({ flow: { types: 'None', annotation: 'None', hasNone: true, narrowed: false } }),
      lexItem({ flow: { types: ['None', 42], annotation: 'None', hasNone: true, narrowed: false } }),
      // annotation 非 null 或串
      lexItem({ flow: { types: ['None'], annotation: 7, hasNone: true, narrowed: false } }),
      // 布尔缺失
      lexItem({ flow: { types: ['None'], annotation: 'None', hasNone: true } }),
      lexItem({ flow: { types: ['None'], annotation: 'None', narrowed: false } })
    ];
    for (const item of malformedFlow) {
      await withGate(
        () => okItems([item]),
        async () => {
          expect(
            await buildAttributeNoneItemsWithRust(TEXT, 'ut-attr-flow-malformed'),
            JSON.stringify(item)
          ).toBeNull();
        }
      );
    }
  });

  it('同 (行,属性) 流事实矛盾:整面作废;事实一致则两条齐报', async () => {
    // 矛盾:同 (4, TalentTree) 一真一假
    const contradictory = [
      lexItem({ member: 'get', flow: flowFace(true, false) }),
      lexItem({ member: 'size', character: 40, length: 4, flow: flowFace(false, true) })
    ];
    await withGate(
      () => okItems(contradictory),
      async () => {
        expect(
          await buildAttributeNoneItemsWithRust(TEXT, 'ut-attr-conflict')
        ).toBeNull();
      }
    );
    // 一致:同键同值(hasNone true)→ 两条齐报
    const consistent = [
      lexItem({ member: 'get', flow: flowFace(true, false) }),
      lexItem({ member: 'size', character: 40, length: 4, flow: flowFace(true, false) })
    ];
    await withGate(
      () => okItems(consistent),
      async () => {
        const items = await buildAttributeNoneItemsWithRust(TEXT, 'ut-attr-agree');
        expect(items?.map(entry => entry.member)).toEqual(['get', 'size']);
      }
    );
  });

  it('门可用空数组:合法空面(信任 Rust,不属畸形)', async () => {
    await withGate(() => okItems([]), async () => {
      expect(await buildAttributeNoneItemsWithRust(TEXT, 'ut-attr-empty')).toEqual([]);
    });
  });

  it('RPC 契约:method=analyzeAttributeNone,params.text=预掩码文本+versionKey', async () => {
    // TEXT 无字符串字面量,用含字面量的文本验证掩码语义
    const raw = 's = "self.a.b"  # self.c.d\nclass Foo:\n    def m(self):\n        self.x.y\n';
    const calls = await withGate(() => okItems([]), async () => {
      await buildAttributeNoneItemsWithRust(raw, 'ut-attr-contract');
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('$/kode/lint/analyzeAttributeNone');
    expect(calls[0].params).toEqual({ text: maskPythonNonCode(raw), versionKey: 'ut-attr-contract' });
    // 掩码确实生效:字面量/注释里的提及被换空白,不进 RPC 入参
    expect((calls[0].params as { text: string }).text).not.toContain('self.a.b');
    expect((calls[0].params as { text: string }).text).toContain('self.x.y');
  });

  it('RPC 契约:versionKey 缺省不入 params', async () => {
    const raw = 'self.x.y\n';
    const calls = await withGate(() => okItems([]), async () => {
      await buildAttributeNoneItemsWithRust(raw);
    });
    expect(calls).toHaveLength(1);
    expect((calls[0].params as Record<string, unknown>).versionKey).toBeUndefined();
    expect(calls[0].params).toEqual({ text: maskPythonNonCode(raw) });
  });

  it('渲染面直验:空数组过,非条目/空对象整面 null(对拍共用)', () => {
    expect(renderAttributeNoneRustItems([])).toEqual([]);
    expect(renderAttributeNoneRustItems([{}])).toBeNull();
    expect(renderAttributeNoneRustItems(['nope'])).toBeNull();
  });
});
