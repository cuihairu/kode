/**
 * rpcArgCount Rust-first 装配面兜底单测(AUDIT-005 B2 车道批 8,沿
 * propertyDirectionRust.test.ts 先例):无门/calls 空/ok:false/畸形 → null
 * (调用方回本地计数)或合法空数组;门可用 → counts 槽位直转(null=未知合法
 * 槽位,非负整数校验)。RPC 契约锁定(method/params 形态:params.text =
 * **原文**——计数面自带字符串/注释词法态,发现面掩码坐标在原文同位;calls
 * 结构子集 line/character/methodName,receiver/section 不上界)。
 * computeRpcArgCountFindingsAsync:Rust 可用 → Rust 槽位驱动(错值槽位改变
 * 产出,证明真走 RPC);不可用/失败/畸形 → 整面回本地计数,产出与同步面深等。
 * 禁止部分采用。
 */
import { describe, expect, it } from 'vitest';
import { setKodeCoreShadowGate } from '../src/backend/kodeCoreShadowFaces';
import type { KodeCoreGate } from '../src/backend/kodeCoreGate';
import { buildRpcArgCountsFromRust } from '../src/backend/rpcArgCountRust';
import {
  computeRpcArgCountFindings,
  computeRpcArgCountFindingsAsync
} from '../src/backend/rpcArgCountDiagnostics';
import type { PythonReceiverCall } from '../src/backend/pythonLanguageUtils';
import type { EntityMapping } from '../src/entityMapping';

/** 门替身;runInRust 按给定应答回,记录 method/params */
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

const okCounts = (counts: unknown) => ({ ok: true as const, result: { counts } });

const call = (line: number, character: number, methodName: string): PythonReceiverCall => ({
  line,
  character,
  receiver: 'cell',
  section: 'CellMethods',
  methodName
});

const CALLS = [call(0, 10, 'login'), call(1, 10, 'logout')];

/** 最小 EntityMapping 桩:只喂本诊断用到的 methods 表(section + declaredArgs) */
const mappingWithMethods = (
  methods: Record<string, Array<{ section: string; declaredArgs?: string[] }>>
): EntityMapping => ({
  methods: Object.fromEntries(
    Object.entries(methods).map(([name, defs]) => [
      name,
      defs.map(def => ({
        defFile: 'avatar.def',
        line: 10,
        section: def.section,
        exposed: false,
        declaredArgs: def.declaredArgs,
        identity: {
          ownerKind: 'method' as never,
          ownerName: 'Avatar',
          sourceKind: 'def' as never,
          sourceChain: [],
          symbolName: name
        }
      }))
    ])
  )
}) as unknown as EntityMapping;

const MAPPING = mappingWithMethods({ login: [{ section: 'CellMethods', declaredArgs: ['a'] }] });

describe('buildRpcArgCountsFromRust(Rust-first,本地计数兜底)', () => {
  it('无门:返回 null,调用方回本地计数', async () => {
    expect(await buildRpcArgCountsFromRust('self.cell.login(1)\n', CALLS)).toBeNull();
  });

  it('calls 空:合法空数组,不发 RPC', async () => {
    const calls = await withGate(() => okCounts([]), async () => {
      expect(await buildRpcArgCountsFromRust('self.cell.login(1)\n', [])).toEqual([]);
    });
    expect(calls).toHaveLength(0);
  });

  it('门可用:counts 槽位直转(null 槽位=未知合法)', async () => {
    await withGate(() => okCounts([2, null]), async () => {
      expect(await buildRpcArgCountsFromRust('x\ny\n', CALLS)).toEqual([2, null]);
    });
    await withGate(() => okCounts([null, null]), async () => {
      expect(await buildRpcArgCountsFromRust('x\ny\n', CALLS)).toEqual([null, null]);
    });
  });

  it('RPC 契约:method=analyzeRpcArgCount,params.text=原文,calls 结构子集', async () => {
    const raw = 's = "self.cell.login(1, 2)"\nself.cell.login(1, 2)\n';
    const gateCalls = await withGate(() => okCounts([1]), async () => {
      await buildRpcArgCountsFromRust(raw, [call(1, 10, 'login')]);
    });
    expect(gateCalls).toHaveLength(1);
    expect(gateCalls[0].method).toBe('$/kode/lint/analyzeRpcArgCount');
    // params.text = 原文(无掩码:计数面自带词法态);calls 只上界
    // line/character/methodName(receiver/section 不上界)
    expect(gateCalls[0].params).toEqual({
      text: raw,
      calls: [{ line: 1, character: 10, methodName: 'login' }]
    });
  });

  it('门调用失败(ok:false):返回 null(回本地计数)', async () => {
    await withGate(
      () => ({ ok: false as const, reason: 'no serverPath' }),
      async () => {
        expect(await buildRpcArgCountsFromRust('x\n', CALLS)).toBeNull();
      }
    );
  });

  it('畸形响应整面作废,不部分采用(缺 counts/非数组/长度不齐/坏槽位)', async () => {
    const malformed: unknown[] = [
      // result 缺 counts / 非 counts 形
      {},
      { counts: 'nope' },
      // 长度与 calls 不齐(多/少)
      { counts: [1] },
      { counts: [1, 2, 3] },
      // 坏槽位:字符串 / 负数 / 浮点 / 对象 / true
      { counts: ['1', 2] },
      { counts: [1, -1] },
      { counts: [1.5, 2] },
      { counts: [{}, 2] },
      { counts: [true, 2] }
    ];
    for (const result of malformed) {
      await withGate(
        () => ({ ok: true as const, result }),
        async () => {
          expect(
            await buildRpcArgCountsFromRust('x\ny\n', CALLS),
            JSON.stringify(result)
          ).toBeNull();
        }
      );
    }
  });
});

describe('computeRpcArgCountFindingsAsync(Rust-first 判定面)', () => {
  const TEXT = 'self.cell.login(1, 2)\nself.cell.logout()\n';

  it('无映射/calls 空:[] 零 RPC', async () => {
    const gateCalls = await withGate(() => okCounts([1, 0]), async () => {
      expect(await computeRpcArgCountFindingsAsync(TEXT, undefined)).toEqual([]);
      expect(await computeRpcArgCountFindingsAsync('print(1)\n', MAPPING)).toEqual([]);
    });
    expect(gateCalls).toHaveLength(0);
  });

  it('Rust 可用:Rust 槽位驱动,产出与同步面深等', async () => {
    const gateCalls = await withGate(() => okCounts([2, 0]), async () => {
      const asyncFindings = await computeRpcArgCountFindingsAsync(TEXT, MAPPING);
      const syncFindings = computeRpcArgCountFindings(TEXT, MAPPING);
      expect(asyncFindings).toEqual(syncFindings);
      expect(asyncFindings).toHaveLength(1);
      expect(asyncFindings[0].actualCount).toBe(2);
    });
    expect(gateCalls).toHaveLength(1);
  });

  it('错值槽位改变产出:证明真走 Rust(槽位 9 → actualCount 9)', async () => {
    await withGate(() => okCounts([9, 0]), async () => {
      const findings = await computeRpcArgCountFindingsAsync(TEXT, MAPPING);
      expect(findings).toHaveLength(1);
      expect(findings[0].actualCount).toBe(9);
      expect(findings[0].message).toContain('call passes 9');
    });
  });

  it('ok:false:整面回本地计数,产出与同步面深等', async () => {
    await withGate(
      () => ({ ok: false as const, reason: 'no serverPath' }),
      async () => {
        const asyncFindings = await computeRpcArgCountFindingsAsync(TEXT, MAPPING);
        expect(asyncFindings).toEqual(computeRpcArgCountFindings(TEXT, MAPPING));
        expect(asyncFindings).toHaveLength(1);
      }
    );
  });

  it('畸形 counts:整面回本地计数,产出与同步面深等(禁部分采用)', async () => {
    await withGate(() => okCounts([2]), async () => {
      const asyncFindings = await computeRpcArgCountFindingsAsync(TEXT, MAPPING);
      expect(asyncFindings).toEqual(computeRpcArgCountFindings(TEXT, MAPPING));
    });
    await withGate(() => okCounts(['2', 0]), async () => {
      expect(await computeRpcArgCountFindingsAsync(TEXT, MAPPING)).toEqual(
        computeRpcArgCountFindings(TEXT, MAPPING)
      );
    });
  });

  it('Rust 槽位 null=未知:该调用点不报,与同步面 null 槽位同语义', async () => {
    await withGate(() => okCounts([null, 0]), async () => {
      const findings = await computeRpcArgCountFindingsAsync(TEXT, MAPPING);
      expect(findings).toEqual([]);
    });
  });
});
