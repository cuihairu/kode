/**
 * attributeNone Rust-first 装配面兜底单测(AUDIT-005 B2 车道批 6,沿
 * readOnlyWriteRust.test.ts 先例):无门/零线索/ok:false/畸形/内建 receiver
 * 漂移 → 返回 null 或合法空面(调用方回 TS 兜底);门可用 → Rust 词法结构面
 * 经渲染(流敏感 None 证据 TS 裁定)成 findings。RPC 契约锁定
 * (method/params 形态,params.text = 预掩码文本)。禁止部分采用。
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

/** 同属性被守卫窄化(if is None: = expr)→ 流去 None,合法空面 */
const NARROWED_TEXT = [
  'class Foo:',
  '    def __init__(self):',
  '        self.TalentTree = None',
  '    def method(self):',
  '        if self.TalentTree is None:',
  '            self.TalentTree = make_tree()',
  '        self.TalentTree.get(0)',
  ''
].join('\n');

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

  it('门可用:Rust 结构面经流证据裁定成 findings(消息=TS 模板)', async () => {
    const rustItems = [
      { code: ATTRIBUTE_NONE_DIAGNOSTIC_CODE, line: 4, character: 24, length: 3, attr: 'TalentTree', member: 'get' }
    ];
    await withGate(() => okItems(rustItems), async () => {
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

  it('流证据窄化:同结构面被裁定不报(合法空面,非畸形)', async () => {
    const rustItems = [
      { code: ATTRIBUTE_NONE_DIAGNOSTIC_CODE, line: 6, character: 16, length: 3, attr: 'TalentTree', member: 'get' }
    ];
    await withGate(() => okItems(rustItems), async () => {
      const items = await buildAttributeNoneItemsWithRust(NARROWED_TEXT, 'ut-attr-narrow');
      expect(items).toEqual([]);
    });
  });

  it('内建 receiver 漂移(Rust 回 cell/base/client):整面作废', async () => {
    for (const attr of ['cell', 'base', 'client']) {
      const rustItems = [
        { code: ATTRIBUTE_NONE_DIAGNOSTIC_CODE, line: 0, character: 10, length: 4, attr, member: 'tick' }
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
      [{ code: 'kbengine.other', line: 0, character: 0, length: 3, attr: 'x', member: 'y' }],
      // 坏 attr 形 / 缺 attr / 坏 member 形 / 缺 member
      [{ code: ATTRIBUTE_NONE_DIAGNOSTIC_CODE, line: 0, character: 0, length: 1, attr: '1x', member: 'y' }],
      [{ code: ATTRIBUTE_NONE_DIAGNOSTIC_CODE, line: 0, character: 0, length: 1, member: 'y' }],
      [{ code: ATTRIBUTE_NONE_DIAGNOSTIC_CODE, line: 0, character: 0, length: 1, attr: 'x', member: '9z' }],
      [{ code: ATTRIBUTE_NONE_DIAGNOSTIC_CODE, line: 0, character: 0, length: 1, attr: 'x' }],
      // length 与 member 不符
      [{ code: ATTRIBUTE_NONE_DIAGNOSTIC_CODE, line: 0, character: 0, length: 5, attr: 'x', member: 'get' }],
      // 负值
      [{ code: ATTRIBUTE_NONE_DIAGNOSTIC_CODE, line: -1, character: 0, length: 3, attr: 'x', member: 'get' }],
      [{ code: ATTRIBUTE_NONE_DIAGNOSTIC_CODE, line: 0, character: -1, length: 3, attr: 'x', member: 'get' }],
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

  it('门可用空数组:合法空面(信任 Rust,不属畸形)', async () => {
    await withGate(() => okItems([]), async () => {
      expect(await buildAttributeNoneItemsWithRust(TEXT, 'ut-attr-empty')).toEqual([]);
    });
  });

  it('RPC 契约:method=analyzeAttributeNone,params.text=预掩码文本(字符串面已换空白)', async () => {
    // TEXT 无字符串字面量,用含字面量的文本验证掩码语义
    const raw = 's = "self.a.b"  # self.c.d\nclass Foo:\n    def m(self):\n        self.x.y\n';
    const calls = await withGate(() => okItems([]), async () => {
      await buildAttributeNoneItemsWithRust(raw, 'ut-attr-contract');
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('$/kode/lint/analyzeAttributeNone');
    expect(calls[0].params).toEqual({ text: maskPythonNonCode(raw) });
    // 掩码确实生效:字面量/注释里的提及被换空白,不进 RPC 入参
    expect((calls[0].params as { text: string }).text).not.toContain('self.a.b');
    expect((calls[0].params as { text: string }).text).toContain('self.x.y');
  });

  it('渲染面直验:空数组过,非条目/空对象整面 null(对拍共用)', () => {
    expect(renderAttributeNoneRustItems([], TEXT, 'ut-attr-direct')).toEqual([]);
    expect(renderAttributeNoneRustItems([{}], TEXT, 'ut-attr-direct')).toBeNull();
    expect(renderAttributeNoneRustItems(['nope'], TEXT, 'ut-attr-direct')).toBeNull();
  });
});
