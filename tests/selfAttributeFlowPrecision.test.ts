/**
 * 流引擎 AST 真域精度断言(精确性主车道批 A):Rust 类跨度换 ruff AST 后,
 * 旧引擎(含 TS 兜底)的已知误导输出在策展样本上逐一断言**新正确值**——
 * - 嵌套类方法体:旧引擎跨类误绑(先含类者胜+下一方法起点−1,内层类行被
 *   外层类吞),真域后归内层类方法(leaf 有流、x 不跨类硬套);
 * - 类尾行/方法尾注释行:旧引擎吞进最后方法域(流残留),真域后落类基线
 *   (类级知识真实可推导;与类体内其他非代码位语义一致,见
 *   docs/review/2026-11-11-precision-campaign.md 审计);
 * - 平铺写点/窄化面回归:真域不改变方法体内查询(与 TS 引擎同值,深等网在
 *   selfAttributeFlowRustParity.test.ts)。
 * 断言只对 Rust 主路径(生产装配 inferSelfAttributeFlowFromRust);TS 引擎
 * 冻结为杀开关兜底,其旧值不再作为基准。二进制缺失整套 skip(纯 TS 门禁
 * 不破坏);首例直连断言防旧二进制静默假绿。
 */
import { existsSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { KodeCoreClient } from '../src/backend/kodeCoreClient';
import type { KodeCoreGate } from '../src/backend/kodeCoreGate';
import { setKodeCoreShadowGate } from '../src/backend/kodeCoreShadowFaces';
import { inferSelfAttributeFlowFromRust } from '../src/backend/selfAttributeFlowRust';

const repoRoot = join(__dirname, '..');
const binaryPath = join(repoRoot, 'target', 'debug', 'kode-server');
const binaryReady = existsSync(binaryPath);
const suite = binaryReady ? describe : describe.skip;

const CLASS_LEVEL_AND_NESTED = [
  'class Outer:',
  '    counter = None',
  '    label: str = "d"',
  '    tags: list',
  '',
  '    class Inner:',
  '        def deep(self):',
  '            self.leaf = None',
  '            self.leaf = 1',
  '',
  '    def __init__(self):',
  '        self.counter = 0',
  '',
  '    def m(self):',
  '        self.counter.to_bytes(2)'
].join('\n');

async function withRustGate(run: () => Promise<void>): Promise<void> {
  const client = new KodeCoreClient({
    binaryPath,
    initializeParams: { processId: process.pid, rootUri: 'file:///workspace/demo', capabilities: {} },
    onStderr: () => undefined
  });
  await client.start();
  setKodeCoreShadowGate({
    runInRust: async (method: string, params: unknown) => {
      const result = await client.request('$/kode/rpc', { method, params });
      return { ok: true as const, result };
    }
  } as unknown as KodeCoreGate);
  try {
    await run();
  } finally {
    setKodeCoreShadowGate(null);
    await client.dispose().catch(() => undefined);
  }
}

suite('selfAttributeFlow AST 真域精度(精确性主车道批 A)', () => {
  it('直连断言:Rust 在场且嵌套样本内层类流可见(旧二进制/旧行为显式红)', async () => {
    await withRustGate(async () => {
      const lines = CLASS_LEVEL_AND_NESTED.split('\n');
      const face = await inferSelfAttributeFlowFromRust(lines, 8, 'leaf', 'precision:probe');
      expect(face, '内层类写点应给出真实流(旧引擎跨类误绑会空)').not.toBeNull();
      expect(face?.types).toEqual(['int']);
    });
  });

  it('嵌套类方法体:流归内层类,不跨类误绑(旧引擎 leaf 全空/x 被外层流污染)', async () => {
    await withRustGate(async () => {
      const lines = CLASS_LEVEL_AND_NESTED.split('\n');
      const key = 'precision:nested';
      // Inner.deep 体内逐写点/读点:leaf 流 = None → int(旧引擎跨类误绑=全空)
      expect((await inferSelfAttributeFlowFromRust(lines, 7, 'leaf', key))?.types).toEqual(['None']);
      expect((await inferSelfAttributeFlowFromRust(lines, 8, 'leaf', key))?.types).toEqual(['int']);
      expect((await inferSelfAttributeFlowFromRust(lines, 8, 'leaf', key))?.annotation).toBe('int');
      // Inner 域内查 Outer 的属性:不跨类硬套(诚实空)
      expect((await inferSelfAttributeFlowFromRust(lines, 8, 'counter', key))?.types).toEqual([]);
      // Outer 自己的方法面不变:__init__ 写点 = int,读点走基线 = int
      expect((await inferSelfAttributeFlowFromRust(lines, 11, 'counter', key))?.types).toEqual(['int']);
      expect((await inferSelfAttributeFlowFromRust(lines, 14, 'counter', key))?.types).toEqual(['int']);
    });
  });

  it('类体内非语句位落类基线;类跨度外(类末语句之后)诚实空', async () => {
    await withRustGate(async () => {
      const text = [
        'class A:',
        '    def __init__(self):',
        '        self.s = None',
        '        self.x = 1',
        '',
        '    def m(self):',
        '        self.x = 2',
        '',
        '    # self.x mid comment / self.s mid comment',
        '    y = 2',
        '',
        '    def n(self):',
        '        pass',
        '# self.x outside class'
      ].join('\n');
      const lines = text.split('\n');
      const key = 'precision:tail';
      // 方法体内写点照常
      expect((await inferSelfAttributeFlowFromRust(lines, 6, 'x', key))?.types).toEqual(['int']);
      // 类体尾注释行(类跨度内,后有成员)→ 类基线:x = {int}(真实可推导)
      expect((await inferSelfAttributeFlowFromRust(lines, 8, 'x', key))?.types).toEqual(['int']);
      // 同位 s = {None}(只 __init__ 有流)
      expect((await inferSelfAttributeFlowFromRust(lines, 8, 's', key))?.types).toEqual(['None']);
      // 类级赋值行 → 类基线
      expect((await inferSelfAttributeFlowFromRust(lines, 9, 'x', key))?.types).toEqual(['int']);
      // 类跨度外(类末语句之后的模块层注释)→ 诚实空(旧引擎会把注释当语句
      // 吞进类域再落方法流,新口径类跨度=末语句,范围外不硬套)
      expect((await inferSelfAttributeFlowFromRust(lines, 13, 'x', key))?.types).toEqual([]);
    });
  });
});
