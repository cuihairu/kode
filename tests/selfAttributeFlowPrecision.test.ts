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
import { existsSync, readFileSync } from 'fs';
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

  it('批 B:lone-CR 行赋值证据如实(字面量推导 AST 化;孤立 CR=行终止符语义)', async () => {
    await withRustGate(async () => {
      // ruff(与 CPython 同)把行中孤立 \r 当行终止符:注释里的 \r 使「回车」
      // 成为模块级语句,类体断裂,容错解析丢弃再缩进的 def(该文件对 CPython
      // 本身即 SyntaxError)。赋值行证据仍如实给出;断裂后方法体诚实空,不硬造流。
      // TS 文本引擎则相反:JS 正则 `.` 不吃 \r,同位连赋值证据都解不出(types=[])。
      const text = 'class Foo:\n    def __init__(self):\n        self.x = None  # 孤立\r回车\n    def m(self):\n        self.x.get(0)\n';
      const lines = text.split('\n');
      const key = 'precision:lone-cr';
      // 赋值行(使用位停查)→ None 证据如实
      const atAssign = await inferSelfAttributeFlowFromRust(lines, 2, 'x', key);
      expect(atAssign?.types).toEqual(['None']);
      expect(atAssign?.hasNone).toBe(true);
      expect(atAssign?.annotation).toBe('None');
      // 类体断裂后的 m 体(容错解析已丢 def)→ 诚实空
      expect((await inferSelfAttributeFlowFromRust(lines, 4, 'x', key))?.types).toEqual([]);
    });
  });

  it('批 C:self 属性读 RHS → 类属性基线(None 证据不再丢)', async () => {
    await withRustGate(async () => {
      // TS 文本引擎对 self.j 形态 RHS 无回调即空集(生产);AST 后
      // self.k = self.j → j 的类基线 {None}(None 证据如实传播)
      const text = [
        'class Foo:',
        '    def __init__(self):',
        '        self.j = None',
        '        self.k = self.j',
        '        return self.k',
      ].join('\n');
      const lines = text.split('\n');
      const key = 'precision:self-attr-read';
      const atWrite = await inferSelfAttributeFlowFromRust(lines, 3, 'k', key);
      expect(atWrite?.types).toEqual(['None']);
      expect(atWrite?.hasNone).toBe(true);
    });
  });

  it('批 C:同文件 def -> T 注解与类限定调用(补可推导真值)', async () => {
    await withRustGate(async () => {
      const text = [
        'class Repo:',
        '    def load(self) -> Row:',
        '        return None',
        '',
        'def make_repo() -> Repo:',
        '    return None',
        '',
        'class A:',
        '    def __init__(self):',
        '        self.r = make_repo().load()',
        '        return self.r',
      ].join('\n');
      const lines = text.split('\n');
      const key = 'precision:in-file-call';
      expect((await inferSelfAttributeFlowFromRust(lines, 9, 'r', key))?.types).toEqual(['Row']);
    });
  });

  it('批 D:类实例化写点升流原子(接收者定型证据,借名误绑的反面)', async () => {
    await withRustGate(async () => {
      const text = [
        'class Repo:',
        '    def load(self) -> Row:',
        '        return None',
        '',
        'class Avatar:',
        '    def __init__(self):',
        '        self.r = Repo()',
        '',
        '    def tick(self):',
        '        self.r.load()',
      ].join('\n');
      const lines = text.split('\n');
      const key = 'precision:instantiation-atom';
      // self.r = Repo() → r 的流型 = {Repo}(类名原子;旧引擎 call 无回调=空集)
      expect((await inferSelfAttributeFlowFromRust(lines, 6, 'r', key))?.types).toEqual(['Repo']);
      // 读点走基线:原子仍在(接收者定型证据可被下游消费)
      expect((await inferSelfAttributeFlowFromRust(lines, 9, 'r', key))?.types).toEqual(['Repo']);
    });
  });
});

// 2026-11-12:demo 资产 KodeHotReload.py 的批 C 精度位移使用位(对拍深等面
// 豁免见 selfAttributeFlowRustParity.test.ts PRECISION_MOVED_FIXTURE_USAGES)。
// 真实语料逐位钉死:行号随已提交夹具锁步,夹具位移即红(重探后改行)。
describe('demo-asset:KodeHotReload.py in-file 调用注解与裸名写链(真实夹具)', () => {
  it('self.http → 嵌套类调用注解 HTTPServer;self.last 裸名写链 → list', async () => {
    const text = readFileSync(
      join(repoRoot, 'tests', 'fixtures', 'kbengine-demo-assets', 'scripts', 'common', 'KodeHotReload.py'),
      'utf8'
    );
    const lines = text.split('\n');
    await withRustGate(async () => {
      // self.http = HTTPServer(...)(嵌套类,行 32)→ in-file 类调用注解,
      // 读点/写点后基线恒 {HTTPServer};TS 冻结引擎该面为空集
      for (const line of [95, 99, 103, 106, 109, 110]) {
        const face = await inferSelfAttributeFlowFromRust(lines, line, 'http', 'precision:demo-http');
        expect(face, `http@${line}`).not.toBeNull();
        expect(face?.types).toEqual(['HTTPServer']);
        expect(face?.annotation).toBe('HTTPServer');
      }
      // self.last = receipts(receipts = [] 裸名写链)→ list;写点前一行
      // (with self.lock)仍是初始基线 []
      expect((await inferSelfAttributeFlowFromRust(lines, 199, 'last', 'precision:demo-last'))?.types).toEqual(['list']);
    });
  });
});
