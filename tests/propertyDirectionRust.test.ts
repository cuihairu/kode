/**
 * propertyDirection Rust-first 装配面兜底单测(AUDIT-005 B2 车道批 7,沿
 * attributeNoneRust.test.ts 先例):无门/零线索/ok:false/畸形 → null(调用方回
 * 本地扫描束)或合法空束;门可用 → Rust 扫描束转本地同形(names Set/sites Map/
 * cellDataCopyKeys Map,rootSymbol 由 fullPath 派生)。RPC 契约锁定
 * (method/params 形态,params.text = **原文**——本批三扫描全在原文,无掩码,
 * 与此前批次不同点)。禁止部分采用。
 */
import { describe, expect, it } from 'vitest';
import { setKodeCoreShadowGate } from '../src/backend/kodeCoreShadowFaces';
import type { KodeCoreGate } from '../src/backend/kodeCoreGate';
import {
  buildPropertyDirectionScanBundleWithRust,
  emptyPropertyDirectionScanBundleForTest
} from '../src/backend/propertyDirectionRust';
import { scanBundleOf, type PropertyDirectionScanBundle } from '../src/backend/propertyDirectionDiagnostics';

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

const okScan = (scan: unknown) => ({ ok: true as const, result: { scan } });

const SAMPLE_SCAN = {
  accesses: [
    { line: 2, character: 13, fullPath: 'hp.max' },
    { line: 3, character: 8, fullPath: 'cellData' }
  ],
  initNames: ['spaceUType'],
  initSites: [{ name: 'spaceUType', line: 2, character: 23 }],
  initCellDataKeys: [{ name: 'spaceUType', key: 'spaceUType' }],
  cellDataAccesses: [{ line: 3, character: 19, length: 10, accessEnd: 31, key: 'spaceUType' }]
};

describe('buildPropertyDirectionScanBundleWithRust(Rust-first,本地扫描兜底)', () => {
  it('无门:返回 null,调用方回本地扫描束', async () => {
    expect(await buildPropertyDirectionScanBundleWithRust('self.hp\n')).toBeNull();
  });

  it('零线索(原文无 self.):合法空束(不发 RPC,与 scanBundleOf("") 同输出)', async () => {
    const calls = await withGate(() => okScan({}), async () => {
      const bundle = await buildPropertyDirectionScanBundleWithRust('print(1)\nx = obj.attr\n');
      expect(bundle).not.toBeNull();
      expect(bundle).toEqual(emptyPropertyDirectionScanBundleForTest());
      expect(bundle).toEqual(scanBundleOf(''));
    });
    expect(calls).toHaveLength(0);
  });

  it('门可用:扫描束转本地同形(Set/Map,rootSymbol 派生)', async () => {
    await withGate(() => okScan(SAMPLE_SCAN), async () => {
      const bundle = await buildPropertyDirectionScanBundleWithRust('self.hp.max\n');
      expect(bundle).not.toBeNull();
      expect(bundle!.accesses).toEqual([
        { line: 2, character: 13, rootSymbol: 'hp', fullPath: 'hp.max' },
        { line: 3, character: 8, rootSymbol: 'cellData', fullPath: 'cellData' }
      ]);
      expect([...bundle!.initAssigned.names]).toEqual(['spaceUType']);
      expect(bundle!.initAssigned.sites.get('spaceUType')).toEqual({ line: 2, character: 23 });
      expect(bundle!.initAssigned.cellDataCopyKeys.get('spaceUType')).toBe('spaceUType');
      expect(bundle!.cellDataAccesses).toEqual([
        { line: 3, character: 19, length: 10, accessEnd: 31, key: 'spaceUType' }
      ]);
    });
  });

  it('RPC 契约:method=analyzePropertyDirection,params.text=原文(无掩码,本批口径)', async () => {
    const raw = 's = "self.a.b"\nself.hp.max\n';
    const calls = await withGate(() => okScan(SAMPLE_SCAN), async () => {
      await buildPropertyDirectionScanBundleWithRust(raw);
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('$/kode/lint/analyzePropertyDirection');
    // 与此前批次不同:三扫描全在原文(无掩码),字符串面提及照扫(TS 同口径)
    expect(calls[0].params).toEqual({ text: raw });
  });

  it('门调用失败(ok:false):返回 null(回本地扫描束)', async () => {
    await withGate(
      () => ({ ok: false as const, reason: 'no serverPath' }),
      async () => {
        expect(await buildPropertyDirectionScanBundleWithRust('self.hp\n')).toBeNull();
      }
    );
  });

  it('畸形扫描束(坏路径/坏名/空键/负值/缺面):整面作废,不部分采用', async () => {
    const malformed: unknown[] = [
      // 非 scan 对象 / 缺 scan
      null,
      {},
      // 缺 fullPath(fullPath 形=\w 段路径,'self.hp' 亦属合法产物——文本
      // self.self.hp 时 TS 同产,不列畸形)
      { ...SAMPLE_SCAN, accesses: [{ line: 0, character: 5 }] },
      // 坏 init 名(空)/缺 name
      { ...SAMPLE_SCAN, initNames: [''] },
      { ...SAMPLE_SCAN, initSites: [{ line: 0, character: 5 }] },
      // 空 cellData 键 / 键含引号
      { ...SAMPLE_SCAN, initCellDataKeys: [{ name: 'x', key: '' }] },
      { ...SAMPLE_SCAN, initCellDataKeys: [{ name: 'x', key: 'a"b' }] },
      // 负值
      { ...SAMPLE_SCAN, accesses: [{ line: -1, character: 0, fullPath: 'hp' }] },
      { ...SAMPLE_SCAN, cellDataAccesses: [{ line: 0, character: 0, length: 1, accessEnd: -1, key: 'k' }] },
      // 面缺损(非数组)
      { ...SAMPLE_SCAN, accesses: 'nope' },
      { ...SAMPLE_SCAN, initSites: 'nope' },
      { ...SAMPLE_SCAN, initNames: 'nope' },
      { ...SAMPLE_SCAN, initCellDataKeys: 'nope' },
      { ...SAMPLE_SCAN, cellDataAccesses: 'nope' }
    ];
    for (const scan of malformed) {
      await withGate(
        () => okScan(scan),
        async () => {
          expect(
            await buildPropertyDirectionScanBundleWithRust('self.hp\n'),
            JSON.stringify(scan)
          ).toBeNull();
        }
      );
    }
  });

  it('门可用空束(全空数组):合法空束(信任 Rust,不属畸形)', async () => {
    await withGate(
      () =>
        okScan({
          accesses: [],
          initNames: [],
          initSites: [],
          initCellDataKeys: [],
          cellDataAccesses: []
        }),
      async () => {
        const bundle = await buildPropertyDirectionScanBundleWithRust('self.hp\n');
        expect(bundle).toEqual(emptyPropertyDirectionScanBundleForTest());
      }
    );
  });

  it('本地扫描束直查:同一文本本地/Rust 驱动判定核同形(对拍共用)', async () => {
    const text = 'class A:\n    def __init__(self):\n        self.k = self.cellData["hp"]\n';
    const local: PropertyDirectionScanBundle = scanBundleOf(text);
    expect(local.accesses.length).toBeGreaterThan(0);
    expect(local.initAssigned.names.has('k')).toBe(true);
    expect(local.initAssigned.cellDataCopyKeys.get('k')).toBe('hp');
    expect(local.cellDataAccesses).toHaveLength(1);
  });
});
